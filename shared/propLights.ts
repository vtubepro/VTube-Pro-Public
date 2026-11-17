// Lights inside placed props (docs/ROOM_EDITOR.md §7 "Light props"). Pure TypeScript (pages + tests).
//
// A prop pack's .glb marks a lamp the same way a room does (docs/ARTIST_ENVIRONMENTS.md §2.3, §4.8): an empty named
// `LIGHT_<anything>` whose glTF extras are `kind` (point | spot | emissive), `color` (#rrggbb), `group`, optional
// `range` (m), `intensity` (×1), `angle` (full cone °) and `penumbra`, plus the prop-only animation keys:
//   effect  flicker (fire) | pulse (magic, breathing) | strobe (club, ≤ 3 flashes/s) | steady   default: steady
//   speed   ×1 = the effect's natural rate (0.1-5)
//   amount  how deep the effect dips (0-1)                                          default: flicker 0.3, pulse 0.4, strobe 1
// The keys may also sit in a nested `vtpLight` object, and a LIGHT_ node that is a glTF KHR_lights_punctual light gives
// its own kind / colour / range / cone as defaults (`lightExtras`), so packs exported either way work; the room
// convention (an empty, no Blender lights exported) is the documented one. A spot aims along the node's -Z, or at
// `target` [x, y, z] in the prop's own space.
// The glowing mesh uses a Principled material named `EMIT_<group>`: it glows on every PC and follows the same effect
// (in step for every copy of a model), so a prop still looks lit where the real light is over the budget.
// Photosensitivity: every animated lamp is ONE output on the page's flash governor (shared/flashGovernor.ts). Its real
// lights and its glow all show that one governed level (propGlowLevel), so a bulb and the light it casts never flash
// out of step, and with Safe flashes on nothing a pack can set flashes more than 3 times a second.
import type { GfxLevel } from './graphics.ts';
import { isSatRed } from './flashGovernor.ts';

export const PROP_LIGHT_EFFECTS = ['steady', 'flicker', 'pulse', 'strobe'] as const;
export type PropLightEffect = typeof PROP_LIGHT_EFFECTS[number];
export type PropLightKind = 'point' | 'spot' | 'emissive';

/** Real THREE lights from placed props per room (on top of the room's own LIGHT_BUDGET). Every real light costs every
 *  lit pixel and the face tracker shares the GPU while streaming, so this stays small; the rest glow only. */
export const PROP_LIGHT_BUDGET: Record<GfxLevel, number> = { performance: 0, balanced: 1, high: 2, ultra: 4 };

export interface PropLightSpec {
  name: string;
  /** The light group (its glow is the EMIT_<group> material); '' when not given. */
  group: string;
  kind: PropLightKind;
  color: string;
  range: number;
  intensity: number;
  angle: number;      // full cone, degrees (spot)
  penumbra: number;
  effect: PropLightEffect;
  speed: number;
  amount: number;
  /** Where a spot points, in the prop's own (glTF) space. */
  target?: [number, number, number];
}

/** What a THREE light object made from a KHR_lights_punctual node carries (all optional). */
export interface LightLike { isLight?: boolean; isSpotLight?: boolean; color?: { getHexString(): string }; distance?: number; angle?: number; penumbra?: number }

/** A LIGHT_ node's effective extras: the KHR light's own values (if it is one), then its extras, then a nested
 *  `vtpLight` object — later wins. */
export function lightExtras(userData: unknown, light?: LightLike | null): Record<string, unknown> {
  const ud = (userData && typeof userData === 'object' ? userData : {}) as Record<string, unknown>;
  const nested = ud.vtpLight && typeof ud.vtpLight === 'object' ? ud.vtpLight as Record<string, unknown> : {};
  const fromLight: Record<string, unknown> = {};
  if (light?.isLight) {
    fromLight.kind = light.isSpotLight ? 'spot' : 'point';
    if (light.color) fromLight.color = `#${light.color.getHexString()}`;
    if (light.distance && light.distance > 0) fromLight.range = light.distance;
    if (light.isSpotLight && light.angle) fromLight.angle = (light.angle * 2 * 180) / Math.PI;
    if (light.isSpotLight && light.penumbra !== undefined) fromLight.penumbra = light.penumbra;
  }
  return { ...fromLight, ...ud, ...nested };
}

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** A LIGHT_ node's extras as a light (bad / missing values fall back to safe defaults; never throws). */
export function propLightSpec(name: string, extras: unknown): PropLightSpec {
  const x = (extras && typeof extras === 'object' ? extras : {}) as Record<string, unknown>;
  const kind: PropLightKind = x.kind === 'point' || x.kind === 'spot' ? x.kind : 'emissive';
  const effect: PropLightEffect = (PROP_LIGHT_EFFECTS as readonly string[]).includes(x.effect as string) ? x.effect as PropLightEffect : 'steady';
  const color = typeof x.color === 'string' && /^#?[0-9a-f]{6}$/i.test(x.color) ? (x.color.startsWith('#') ? x.color : `#${x.color}`) : '#ffd9a0';
  const dAmount = effect === 'flicker' ? 0.3 : effect === 'pulse' ? 0.4 : effect === 'strobe' ? 1 : 0;
  const tg = Array.isArray(x.target) && x.target.length >= 3 && x.target.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
    ? x.target.slice(0, 3) as [number, number, number] : undefined;
  return {
    name, kind, color, effect, group: typeof x.group === 'string' ? x.group.slice(0, 32) : '', ...(tg && kind === 'spot' ? { target: tg } : {}),
    range: num(x.range, kind === 'spot' ? 9 : 6, 0.5, 30),
    intensity: num(x.intensity, 1, 0, 5),
    angle: num(x.angle, 40, 5, 170),
    penumbra: num(x.penumbra, 0.5, 0, 1),
    speed: num(x.speed, 1, 0.1, 5),
    amount: num(x.amount, dAmount, 0, 1),
  };
}

/** Strobe ceiling (flashes / s). */
export const STROBE_MAX_HZ = 3;

/** The glow group of an EMIT_ material name (`EMIT_neon.001` / `EMIT_neon_01` → `neon`), as the room loader reads it. */
export function emitGroup(materialName: string): string | null {
  const m = /^EMIT_(.+)$/.exec(materialName);
  return m ? m[1].replace(/[._]\d+$/, '') : null;
}

/** Which of a model's lamps drives an EMIT_ material: the lamp of the same group, else the first lamp. */
export function glowLamp<T extends { spec: Pick<PropLightSpec, 'group'> }>(materialName: string, lamps: T[]): T | null {
  const g = emitGroup(materialName);
  if (g === null || !lamps.length) return null;
  return lamps.find((l) => l.spec.group && l.spec.group === g) ?? lamps[0];
}

/** Smooth pseudo-random 0..1 (sum of incommensurate sines: no allocation, no state, the same on every page). `calm` =
 *  its two slow swells only, over the same range (Safe flashes: the fast ripples of a deep flicker count as flashes). */
function wobble(t: number, calm = false): number {
  if (calm) return 0.5 + 0.29 * Math.sin(t * 1.0) + 0.21 * Math.sin(t * 2.71 + 1.3);
  return 0.5 + 0.22 * Math.sin(t * 1.0) + 0.16 * Math.sin(t * 2.71 + 1.3) + 0.08 * Math.sin(t * 7.13 + 4.1) + 0.04 * Math.sin(t * 13.7 + 2.2);
}

/** Safe flashes on (the default): the fastest `speed` each effect plays at. With these a lamp asks for no more than 3
 *  flashes a second on its own, so the page's flash governor (the guarantee: it still steps every frame) only delays
 *  its turns into its windows and never has to drop one: the look stays natural instead of clipped. A flicker keeps its
 *  full depth on its two slow swells (x0.6 at most); a pulse breathes and a strobe flashes at most 1.5 times a second. */
export const SAFE_SPEED: Readonly<Record<PropLightEffect, number>> = { steady: Infinity, flicker: 0.6, pulse: 3, strobe: 0.5 };

/** The light's brightness factor (0..1, 1 = as authored) at time `t` seconds, before the flash governor; `phase` keeps
 *  lamps out of step; `safe` = as Safe flashes plays it (SAFE_SPEED, a calm flicker). */
export function propLightLevel(s: Pick<PropLightSpec, 'effect' | 'speed' | 'amount'>, t: number, phase = 0, safe = false): number {
  const a = s.amount, w = safe ? Math.min(s.speed, SAFE_SPEED[s.effect] ?? Infinity) : s.speed;
  switch (s.effect) {
    case 'flicker': {
      const n = wobble((t + phase * 37) * 9 * w, safe);
      return Math.max(0, Math.min(1, 1 - a * Math.min(1, Math.max(0, n * 1.25 - 0.05))));
    }
    case 'pulse': {
      const p = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((t * 0.5 * w + phase) % 1));
      return 1 - a * (1 - p);
    }
    case 'strobe': {
      // photosensitivity: one lamp never asks for more than 3 flashes a second, whatever the speed (WCAG 2.3.1); the
      // page's flash governor holds the room to it (lamps + glows + several props together: src/scene/roomEdits.ts)
      const on = ((t * Math.min(STROBE_MAX_HZ, 3 * w) + phase) % 1) < 0.18;
      return on ? 1 : 1 - a;
    }
    default:
      return 1;
  }
}

/** Which prop lights get a real light: spots first, then the strongest / widest, then placing order. Returns the keys
 *  of the first `budget` (the rest glow only). */
export function propLightsInBudget<T extends { key: string; spec: Pick<PropLightSpec, 'kind' | 'intensity' | 'range'> }>(lights: T[], budget: number): Set<string> {
  const real = lights.map((l, i) => ({ l, i })).filter(({ l }) => l.spec.kind !== 'emissive');
  const weight = (s: T['spec']) => (s.kind === 'spot' ? 1000 : 0) + s.intensity * s.range;
  real.sort((a, b) => weight(b.l.spec) - weight(a.l.spec) || a.i - b.i);
  return new Set(real.slice(0, Math.max(0, budget)).map(({ l }) => l.key));
}

/** An EMIT_ glow's brightness factor for its lamp's (governed) level: it never goes fully dark, the bulb still reads as
 *  a bulb. (An affine map with a floor: it never swings more, relatively, than the lamp itself.) */
export const propGlowLevel = (level: number) => 0.35 + 0.65 * level;

/** Is a lamp colour (#rrggbb, sRGB as authored) a saturated red in linear light (WCAG's red flash: the governor's red
 *  rule)? */
export function propLightRed(color: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return false;
  const lin = (h: string) => { const c = parseInt(h, 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return isSatRed(lin(m[1]), lin(m[2]), lin(m[3]));
}

/** A steady phase (0..1) from a string. The runtime keys it by the prop's MODEL (+ 0.37 per lamp): a model's glow is one
 *  material shared by every copy, so every copy's real light keeps the phase of the glow it sits in. */
export function propLightPhase(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

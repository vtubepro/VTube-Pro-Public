// Per-room look for the High / Ultra tiers: colour grade (LUT), bloom, haze, rim tint, reflections, shafts. Built-in
// defaults per room id (the rooms' moods), overridable by the room itself: scene.json `gfx` (docs/SCENES.md →
// "Graphics quality"). Cel / anime look first — nothing here pushes towards photoreal.
import type { GradeSpec } from './lut.ts';
import { baseRoomId } from '../../../shared/roomId.ts';

export interface RoomLook {
  grade: GradeSpec;
  /** How much of the LUT (0..1). */
  lutMix: number;
  bloom: number;
  threshold: number;
  /** Air colour (hex), density per metre, how much the bloom glow lights it. */
  haze: { color: string; density: number; glow: number };
  /** Rim light tint on performers / NPCs (hex) and strength. */
  rim: { color: string; strength: number };
  vignette: number;
  ao: number;
  /** Glossy floor SSR strength (0 = none) and the floor height (null = from the spots). */
  reflect: { strength: number; y: number | null; maxDist: number };
  /** God-ray strength (0 = none). */
  shafts: number;
  /** Background DOF amount in talk shots (0..1). */
  dof: number;
  /** Additive effects (tracers, beams, lasers, muzzle flashes, engines) → bloom gain (0 = no glow layer). */
  glow: number;
  /** Per emissive group (EMIT_<group>) brightness gain while post is on (bloom tuning per group; 1 = authored). */
  groups: Record<string, number>;
}

const BASE: RoomLook = {
  grade: { curve: 0.15, sat: 1.04, satShadows: 0.06 }, lutMix: 1,
  bloom: 0.75, threshold: 1.05,
  haze: { color: '#10141a', density: 0.01, glow: 0.45 },
  rim: { color: '#cfe2ff', strength: 0.32 },
  vignette: 0.16, ao: 0.62,
  reflect: { strength: 0, y: null, maxDist: 6 },
  shafts: 0.3, dof: 0.7, glow: 1.3, groups: {},
};

const ROOMS: Record<string, Partial<RoomLook>> = {
  eft_factory: {
    grade: { temp: 0.16, shadows: '#1e2c3c', shadowAmt: 0.4, highlights: '#ffae5c', highlightAmt: 0.3, curve: 0.3, sat: 0.93, satShadows: 0.05 },
    bloom: 0.8, haze: { color: '#2a1f10', density: 0.028, glow: 0.75 }, rim: { color: '#ffd2a0', strength: 0.3 }, vignette: 0.26, shafts: 0.55,
    glow: 1.5, groups: { sodium: 1.15, chem_glow: 1.3, alarm: 1.2, beacon: 1.2, tubes: 0.9 },
  },
  eft_labs: {
    grade: { temp: -0.2, shadows: '#16283a', shadowAmt: 0.28, highlights: '#eaf5ff', highlightAmt: 0.2, curve: 0.2, sat: 0.96 },
    bloom: 0.7, haze: { color: '#0a1218', density: 0.01, glow: 0.4 }, rim: { color: '#cfe8ff', strength: 0.3 },
    reflect: { strength: 0.42, y: null, maxDist: 7 }, shafts: 0.2,
  },
  eft_labs_rnd: {
    grade: { temp: -0.18, shadows: '#132a33', shadowAmt: 0.3, highlights: '#e6fff4', highlightAmt: 0.18, curve: 0.22, sat: 0.97 },
    bloom: 0.75, haze: { color: '#08140f', density: 0.012, glow: 0.45 }, rim: { color: '#c8ffe8', strength: 0.3 },
    reflect: { strength: 0.36, y: null, maxDist: 7 }, shafts: 0.22,
  },
  eft_customs_dorms: {
    grade: { temp: 0.06, shadows: '#27303a', shadowAmt: 0.3, highlights: '#ffd6a2', highlightAmt: 0.24, curve: 0.24, sat: 0.92 },
    haze: { color: '#3a3833', density: 0.012, glow: 0.5 }, rim: { color: '#ffe2bc', strength: 0.28 }, shafts: 0.45,
  },
  helldivers_bridge: {
    grade: { temp: -0.14, shadows: '#0e1a36', shadowAmt: 0.42, highlights: '#ffd67a', highlightAmt: 0.24, curve: 0.3, sat: 1.06, satShadows: 0.1 },
    bloom: 0.9, haze: { color: '#0a1428', density: 0.014, glow: 0.65 }, rim: { color: '#92c6ff', strength: 0.38 }, vignette: 0.22,
    reflect: { strength: 0.22, y: null, maxDist: 6 }, shafts: 0.35,
    // space vista: keep the stars + planet sharp (less DOF), holograms glow without blowing out, engines / lasers pop
    dof: 0.35, glow: 1.1, groups: { holo: 0.75, console: 0.9, engines: 1.35, planetshine: 1.2, alert: 1.2 },
  },
  poe2_kingsmarch: {
    grade: { temp: 0.12, shadows: '#2c2446', shadowAmt: 0.36, highlights: '#ffd894', highlightAmt: 0.3, curve: 0.24, sat: 1.1, satShadows: 0.12 },
    bloom: 0.8, haze: { color: '#6f7f96', density: 0.0035, glow: 0.5 }, rim: { color: '#ffe0b0', strength: 0.34 }, shafts: 0.42,
    glow: 1.4, groups: { lanterns: 1.3, braziers: 1.35, candles: 1.2, lighthouse: 1.3, windows: 1.1, orbs: 1.15 },
  },
};

type Json = Record<string, unknown>;
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** The look for a room: built-in defaults ← its own scene.json `gfx` (validated). `fog` = the room's ambience fog colour. */
export function roomLook(id: string, json?: unknown, fog?: string): RoomLook {
  if (!ROOMS[id] && ROOMS[baseRoomId(id)]) id = baseRoomId(id);   // (an area `<room>~<area>`: its room's look)
  const d = ROOMS[id] ?? {};
  const L: RoomLook = {
    ...BASE, ...d,
    grade: { ...BASE.grade, ...(d.grade ?? {}) },
    haze: { ...BASE.haze, ...(ROOMS[id] ? {} : isHex(fog) ? { color: fog } : {}), ...(d.haze ?? {}) },
    rim: { ...BASE.rim, ...(d.rim ?? {}) },
    reflect: { ...BASE.reflect, ...(d.reflect ?? {}) },
  };
  const j = (json && typeof json === 'object' ? json : {}) as Json;
  if (j.grade && typeof j.grade === 'object') {
    const g = j.grade as Json, out: Record<string, unknown> = {};
    for (const k of ['temp', 'tint', 'shadowAmt', 'highlightAmt', 'curve', 'sat', 'satShadows']) if (typeof g[k] === 'number') out[k] = num(g[k], -2, 3, 0);
    for (const k of ['shadows', 'highlights']) if (isHex(g[k])) out[k] = g[k];
    for (const k of ['lift', 'gamma', 'gain']) if (Array.isArray(g[k]) && (g[k] as unknown[]).length === 3 && (g[k] as unknown[]).every((x) => typeof x === 'number')) out[k] = g[k];
    L.grade = { ...L.grade, ...out };
  }
  L.lutMix = num(j.lutMix, 0, 1, L.lutMix);
  L.bloom = num(j.bloom, 0, 3, L.bloom);
  L.threshold = num(j.threshold, 0.4, 4, L.threshold);
  L.vignette = num(j.vignette, 0, 0.8, L.vignette);
  L.ao = num(j.ao, 0, 1, L.ao);
  L.shafts = num(j.shafts, 0, 2, L.shafts);
  L.dof = num(j.dof, 0, 1, L.dof);
  if (j.haze && typeof j.haze === 'object') { const h = j.haze as Json; L.haze = { color: isHex(h.color) ? h.color : L.haze.color, density: num(h.density, 0, 0.2, L.haze.density), glow: num(h.glow, 0, 3, L.haze.glow) }; }
  if (j.rim && typeof j.rim === 'object') { const r = j.rim as Json; L.rim = { color: isHex(r.color) ? r.color : L.rim.color, strength: num(r.strength, 0, 1, L.rim.strength) }; }
  L.glow = num(j.glow, 0, 4, L.glow);
  if (j.groups && typeof j.groups === 'object') { const g: Record<string, number> = { ...L.groups }; for (const [k, v] of Object.entries(j.groups as Json)) if (/^[a-z0-9_]{1,32}$/i.test(k)) g[k] = num(v, 0, 4, 1); L.groups = g; }
  if (j.reflect && typeof j.reflect === 'object') { const r = j.reflect as Json; L.reflect = { strength: num(r.strength, 0, 1, L.reflect.strength), y: typeof r.y === 'number' && Number.isFinite(r.y) ? r.y : L.reflect.y, maxDist: num(r.maxDist, 1, 30, L.reflect.maxDist) }; }
  return L;
}

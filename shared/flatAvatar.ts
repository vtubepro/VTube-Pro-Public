// 2D avatars: the profile contract (AvatarProfile.flat), defaults + sanitising, and the pure logic every page runs
// the same way (voice gate, blink timer). Implementation-neutral: 'png' (PNG / APNG / GIF / WebP image sets,
// "PNGTuber") is built in; other kinds ('live2d', 'inochi2d' …) plug in through the 2D-avatar interface
// (src/avatar/flat/types.ts) and keep their own settings in `opts`. Runtime + display modes: src/avatar/flat/*.
// Docs: docs/FLAT_AVATARS.md.
//
// A 2D avatar is an ordinary AvatarProfile with `flat` set: its folder holds the pictures / model files and `modelFile`
// names the main file (= flat.main). Everything that places, frames, seats and streams avatars works on it unchanged:
// AvatarRuntime builds a card (or a TV, a screen picture, an overlay) instead of a mesh.
import type { TrackingFrame } from './types.ts';
import { sanitizeTalk, talkDefaults, type FlatTalkConfig } from './flatTalk.ts';
import { sanitizeParamCue, type ParamCue } from './rig2d/userParams.ts';

/** 'png' is built in; others are registered by their implementation (src/avatar/flat/registry.ts). */
export type FlatKind = 'png' | 'live2d' | 'inochi2d' | (string & {});
export const FLAT_KIND_RE = /^[a-z][a-z0-9_-]{1,23}$/;
/** How the picture is shown:
 *  'card'    = a standee at the performer's spot in the room (or on the classic stage) — rooms, spot cameras, parties;
 *  'overlay' = a flat layer composited over the OBS output (position / scale / anchor), the room behind it;
 *  'tv'      = on the screen of a walking TV body (the TV performer set) that walks, sits and talks like one;
 *  'screen'  = on the room's big screen (the React SCREEN), nobody standing at a spot. */
export type FlatDisplayMode = 'card' | 'overlay' | 'tv' | 'screen';
export const FLAT_DISPLAY_MODES: readonly FlatDisplayMode[] = ['card', 'overlay', 'tv', 'screen'];
/** 'camera' = the card turns (about its upright axis) to face each camera that draws it; 'fixed' = faces the spot's front. */
export type FlatFacing = 'camera' | 'fixed';
/** 'full' = the picture is the whole body (it stands on the floor); 'bust' = head + shoulders (it sits on a seat, or on a
 *  pedestal at a standing spot); 'auto' = read from the picture (shared/flatFraming.ts: alpha bounds + aspect). */
export type FlatFraming = 'auto' | 'full' | 'bust';
/** How a bust is grounded: 'auto' = on the seat at a seated spot, on a pedestal at a standing spot; 'pedestal' = always
 *  on a pedestal; 'fade' = its bottom edge fades out (for pictures with their own desk / frame); 'none' = as is. */
export type FlatGrounding = 'auto' | 'pedestal' | 'fade' | 'none';
export type FlatAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
export const FLAT_ANCHORS: readonly FlatAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

/** One expression state of an image set (happy, angry, sleepy …): its own idle / talk / blink pictures, a hotkey. */
export interface FlatPngState {
  id: string;
  name: string;
  idle: string;
  talk?: string;
  blink?: string;
  talkBlink?: string;
  /** KeyboardEvent.code (KeyQ, Digit1, F5 …) toggling this state in the studio; optional. */
  key?: string;
}

export interface FlatPngConfig {
  /** File names inside the avatar folder (PNG / APNG / GIF / WebP / JPEG). idle is required. */
  idle: string;
  talk?: string;
  blink?: string;
  talkBlink?: string;
  states: FlatPngState[];
  /** Voice activity: level 0..1 over `threshold` = talking; `hold` s keeps the talk picture through short gaps,
   *  `attack` s of voice before it switches (filters clicks). */
  gate: { threshold: number; hold: number; attack: number };
  /** Blink pictures: every `every` s ± `jitter` s, closed for `length` s (only when a blink picture exists). With the
   *  camera on, the performer's own blinks are used. */
  blinkTimer: { every: number; jitter: number; length: number };
  /** Head tilt (roll) and sway (yaw → lean) from the face tracking when the camera is on; 0 = off, 1 = natural. */
  follow: { tilt: number; sway: number };
  /** Pixel art: nearest-neighbour scaling (no blur). */
  pixelated: boolean;
}

export interface FlatCardDisplay {
  facing: FlatFacing;
  framing: FlatFraming;
  grounding: FlatGrounding;
  /** Pedestal colour (busts at standing spots). */
  pedestalColor: string;
  /** Card height in metres before the room's size normalisation (only the proportions matter in rooms). */
  height: number;
  /** Outline width (0 = none … 1 = thick) and colour, around the picture's silhouette. */
  outline: number;
  outlineColor: string;
  /** 0..1 drop shadow behind the picture (offset down-right, soft). */
  shadow: number;
  /** 0..1 how much the room's light colours the picture (0 = always exactly the picture's colours). */
  tint: number;
  /** Soft contact shadow on the floor under the card. */
  ground: boolean;
}
export interface FlatOverlayDisplay {
  anchor: FlatAnchor;
  /** Offset from the anchor, fractions of the output width / height (+x right, +y down). */
  x: number;
  y: number;
  /** Picture height as a fraction of the output height. */
  scale: number;
  /** Mirror horizontally. */
  flip: boolean;
  /** A 2.5D overlay around the avatar (scenery behind, a desk in front: shared/overlayStage.ts), by overlay id; missing = none. */
  stage?: string;
}
export interface FlatTvDisplay {
  /** TV body skin id (shared/tv.ts TV_SKINS; '' = the default set). */
  skin: string;
  /** Screen backdrop behind the picture (transparent pictures): a colour, or 'none' = the set's own dark screen. */
  backdrop: string;
}
export interface FlatDisplay { mode: FlatDisplayMode; card: FlatCardDisplay; overlay: FlatOverlayDisplay; tv: FlatTvDisplay }

export interface FlatAvatarConfig {
  kind: FlatKind;
  /** The main file (= the profile's modelFile): the idle picture, the .model3.json, the .inp/.inx … */
  main: string;
  /** kind 'png' settings. */
  png?: FlatPngConfig;
  /** Other kinds' own settings (plain JSON, ≤ 32 KB; the implementation validates them at load). */
  opts?: Record<string, unknown>;
  display: FlatDisplay;
  /** "When I talk": the talk-picture swap + motions (shared/flatTalk.ts). */
  talk: FlatTalkConfig;
  /** Where the face is on the picture (fractions: x from the left, y from the BOTTOM, size of the picture height):
   *  talk cameras frame it. Missing = what the implementation reports, else the upper middle. */
  face?: { x: number; y: number; size: number };
  /** Render height of the picture in pixels (canvas size): 256 … 2048. */
  res: number;
}

// ---------------------------------------------------------------- defaults
export const FLAT_CARD_DEFAULTS: FlatCardDisplay = { facing: 'camera', framing: 'auto', grounding: 'auto', pedestalColor: '#7c776f', height: 1.6, outline: 0, outlineColor: '#ffffff', shadow: 0.35, tint: 0.35, ground: true };
export const FLAT_OVERLAY_DEFAULTS: FlatOverlayDisplay = { anchor: 'bottom-right', x: -0.03, y: 0, scale: 0.62, flip: false };
export const FLAT_TV_DEFAULTS: FlatTvDisplay = { skin: '', backdrop: '#1d2230' };
export const FLAT_PNG_DEFAULTS: Omit<FlatPngConfig, 'idle'> = {
  states: [], gate: { threshold: 0.16, hold: 0.18, attack: 0.03 },
  blinkTimer: { every: 4, jitter: 2, length: 0.13 }, follow: { tilt: 1, sway: 1 }, pixelated: false,
};
/** The face box when nobody says where it is: upper middle of the picture. */
export const FLAT_FACE_DEFAULT = { x: 0.5, y: 0.78, size: 0.24 };

export function defaultFlatConfig(kind: FlatKind, main: string): FlatAvatarConfig {
  return {
    kind, main,
    ...(kind === 'png' ? { png: { idle: main, ...structuredClone(FLAT_PNG_DEFAULTS) } } : { opts: {} }),
    display: { mode: 'card', card: { ...FLAT_CARD_DEFAULTS }, overlay: { ...FLAT_OVERLAY_DEFAULTS }, tv: { ...FLAT_TV_DEFAULTS } },
    talk: talkDefaults(kind === 'png'),
    res: 1024,
  };
}

// ---------------------------------------------------------------- sanitising (profiles from disk, party guests, the UI)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const KEY = /^[A-Za-z0-9]{1,24}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** A file name inside the avatar folder: relative, forward slashes, no '..' / dot parts / drive letters. */
export function safeRel(v: unknown, max = 200): string | null {
  if (typeof v !== 'string' || !v || v.length > max) return null;
  const s = v.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || /[\x00-\x1f<>:"|?*]/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
  return s;
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Plain JSON only (no functions / prototypes), bounded depth, size and string lengths; null when it isn't. */
export function plainJson(v: unknown, maxBytes = 32 << 10): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const walk = (x: unknown, depth: number): unknown => {
    if (x === null || typeof x === 'boolean') return x;
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'string') return x.slice(0, 2000);
    if (depth > 8) return null;
    if (Array.isArray(x)) return x.slice(0, 512).map((y) => walk(y, depth + 1));
    if (typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x as Record<string, unknown>).slice(0, 256)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') o[k.slice(0, 64)] = walk(y, depth + 1);
      return o;
    }
    return null;
  };
  const out = walk(v, 0) as Record<string, unknown>;
  try { if (JSON.stringify(out).length > maxBytes) return null; } catch { return null; }
  return out;
}

function sanitizePng(v: unknown): FlatPngConfig | null {
  const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const idle = safeRel(b.idle);
  if (!idle) return null;
  const D = FLAT_PNG_DEFAULTS;
  const g = (b.gate ?? {}) as Record<string, unknown>, bl = (b.blinkTimer ?? {}) as Record<string, unknown>, fo = (b.follow ?? {}) as Record<string, unknown>;
  const states: FlatPngState[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(b.states) ? b.states.slice(0, 24) : []) {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && ID.test(o.id) ? o.id : null;
    const si = safeRel(o.idle);
    if (!id || !si || seen.has(id)) continue;
    seen.add(id);
    const st: FlatPngState = { id, name: str(o.name, 40) || id, idle: si };
    for (const k of ['talk', 'blink', 'talkBlink'] as const) { const f = safeRel(o[k]); if (f) st[k] = f; }
    if (typeof o.key === 'string' && KEY.test(o.key)) st.key = o.key;
    states.push(st);
  }
  const out: FlatPngConfig = {
    idle, states,
    gate: { threshold: num(g.threshold, 0.01, 0.95, D.gate.threshold), hold: num(g.hold, 0, 2, D.gate.hold), attack: num(g.attack, 0, 0.5, D.gate.attack) },
    blinkTimer: { every: num(bl.every, 0.5, 30, D.blinkTimer.every), jitter: num(bl.jitter, 0, 15, D.blinkTimer.jitter), length: num(bl.length, 0.04, 1, D.blinkTimer.length) },
    follow: { tilt: num(fo.tilt, 0, 2, D.follow.tilt), sway: num(fo.sway, 0, 2, D.follow.sway) },
    pixelated: b.pixelated === true,
  };
  for (const k of ['talk', 'blink', 'talkBlink'] as const) { const f = safeRel(b[k]); if (f) out[k] = f; }
  return out;
}

/** A clean FlatAvatarConfig, or null when `v` isn't a usable one. */
export function sanitizeFlatConfig(v: unknown): FlatAvatarConfig | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (typeof b.kind !== 'string' || !FLAT_KIND_RE.test(b.kind)) return null;
  const png = b.kind === 'png' ? sanitizePng(b.png) : null;
  if (b.kind === 'png' && !png) return null;
  const main = safeRel(b.main) ?? (png ? png.idle : null);
  if (!main) return null;
  const d = (b.display ?? {}) as Record<string, unknown>, c = (d.card ?? {}) as Record<string, unknown>, o = (d.overlay ?? {}) as Record<string, unknown>, t = (d.tv ?? {}) as Record<string, unknown>;
  const C = FLAT_CARD_DEFAULTS, O = FLAT_OVERLAY_DEFAULTS;
  const out: FlatAvatarConfig = {
    kind: b.kind, main,
    ...(png ? { png } : {}),
    display: {
      mode: FLAT_DISPLAY_MODES.includes(d.mode as FlatDisplayMode) ? d.mode as FlatDisplayMode : 'card',
      card: {
        facing: c.facing === 'fixed' ? 'fixed' : 'camera',
        framing: c.framing === 'bust' || c.framing === 'full' ? c.framing : 'auto',
        grounding: c.grounding === 'pedestal' || c.grounding === 'fade' || c.grounding === 'none' ? c.grounding : 'auto',
        pedestalColor: typeof c.pedestalColor === 'string' && COLOR.test(c.pedestalColor) ? c.pedestalColor : C.pedestalColor,
        height: num(c.height, 0.2, 20, C.height),
        outline: num(c.outline, 0, 1, C.outline),
        outlineColor: typeof c.outlineColor === 'string' && COLOR.test(c.outlineColor) ? c.outlineColor : C.outlineColor,
        shadow: num(c.shadow, 0, 1, C.shadow), tint: num(c.tint, 0, 1, C.tint), ground: c.ground !== false,
      },
      overlay: {
        anchor: FLAT_ANCHORS.includes(o.anchor as FlatAnchor) ? o.anchor as FlatAnchor : O.anchor,
        x: num(o.x, -1, 1, O.x), y: num(o.y, -1, 1, O.y), scale: num(o.scale, 0.05, 2, O.scale), flip: o.flip === true,
        ...(typeof o.stage === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(o.stage) ? { stage: o.stage } : {}),
      },
      tv: {
        skin: typeof t.skin === 'string' && /^[a-z0-9_-]{0,32}$/.test(t.skin) ? t.skin : FLAT_TV_DEFAULTS.skin,
        backdrop: t.backdrop === 'none' ? 'none' : typeof t.backdrop === 'string' && COLOR.test(t.backdrop) ? t.backdrop : FLAT_TV_DEFAULTS.backdrop,
      },
    },
    talk: sanitizeTalk(b.talk, b.kind === 'png'),
    // (up to 4096: 4K output / close-ups; a 2D rig draws at most 2048 unless the desktop GPU takes 4096: rig2d/source.ts)
    res: Math.round(num(b.res, 256, 4096, 1024)),
  };
  if (!png) { const op = plainJson(b.opts); out.opts = op ?? {}; }
  const f = b.face as Record<string, unknown> | undefined;
  if (f && typeof f === 'object' && [f.x, f.y, f.size].every((x) => typeof x === 'number' && Number.isFinite(x))) out.face = { x: num(f.x, 0, 1, 0.5), y: num(f.y, 0, 1, 0.75), size: num(f.size, 0.02, 1, 0.2) };
  return out;
}

/** Every file a 'png' 2D avatar needs (party bundles, checks). Other kinds list theirs through their implementation. */
export function flatPngFiles(c: FlatAvatarConfig): string[] {
  const out = new Set<string>([c.main]);
  if (c.png) {
    for (const k of ['idle', 'talk', 'blink', 'talkBlink'] as const) if (c.png[k]) out.add(c.png[k]!);
    for (const s of c.png.states) for (const k of ['idle', 'talk', 'blink', 'talkBlink'] as const) if (s[k]) out.add(s[k]!);
  }
  return [...out];
}

// ---------------------------------------------------------------- the cue a studio sends with each frame
/** What the studio's hotkeys picked (rides in TrackingFrame.flat so OBS pages and party guests show the same):
 *  `s` = the expression / state id held on (absent = default), `m` = the last motion trigger (a new id plays it), `p` =
 *  the model sliders held now (2D rigs: parameter id or "layer:<id>" → [target, fade s], shared/rig2d/userParams.ts),
 *  `x` = expressions toggled on by hotkeys, oldest first (2D rigs: they stack, like VTube Studio's). */
export interface FlatCue { s?: string; m?: { id: number; group: string; index: number }; p?: ParamCue; x?: string[] }
export function sanitizeFlatCue(v: unknown): FlatCue | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>, out: FlatCue = {};
  if (typeof b.s === 'string' && b.s.length && b.s.length <= 64) out.s = b.s;
  const m = b.m as Record<string, unknown> | undefined;
  if (m && typeof m === 'object' && typeof m.id === 'number' && Number.isFinite(m.id) && typeof m.group === 'string' && m.group.length && m.group.length <= 64)
    out.m = { id: m.id, group: m.group, index: typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 256 ? m.index : 0 };
  const p = sanitizeParamCue(b.p);
  if (p) out.p = p;
  if (Array.isArray(b.x)) { const x = b.x.filter((y): y is string => typeof y === 'string' && y.length > 0 && y.length <= 64).slice(0, 32); if (x.length) out.x = x; }
  return out.s || out.m || out.p || out.x ? out : undefined;
}

// ---------------------------------------------------------------- voice level → talking
/** How loud / how much the performer talks now, 0..1, from a frame: the voice (mouth.speak) or, camera only, the
 *  mouth opening. */
export function voiceLevel(f: Pick<TrackingFrame, 'mouth'>): number {
  const m = f.mouth;
  return Math.max(0, Math.min(1, Math.max(m.speak ?? 0, (m.open ?? 0) * 1.15, (m.laugh ?? 0) * 0.8)));
}

/** Idle ↔ talking with a threshold, hysteresis (it lets go below 70 % of the threshold), an attack (that long above
 *  before it switches on: clicks don't flash the talk picture) and a hold (that long below before it switches off:
 *  the picture doesn't flicker between syllables). */
export class VoiceGate {
  talking = false;
  /** Seconds since the last switch. */
  since = 0;
  private above = 0;
  private below = 0;
  constructor(public cfg: { threshold: number; hold: number; attack: number }) {}
  step(level: number, dt: number): boolean {
    const on = this.cfg.threshold, off = on * 0.7;
    this.since += dt;
    if (level >= on) {
      this.below = 0; this.above += dt;
      if (!this.talking && this.above >= this.cfg.attack - 1e-9) { this.talking = true; this.since = 0; }
    } else if (level < off) {
      this.above = 0; this.below += dt;
      if (this.talking && this.below >= this.cfg.hold - 1e-9) { this.talking = false; this.since = 0; }
    } else { this.above = 0; if (!this.talking) this.below = 0; }
    return this.talking;
  }
}

/** Blink timer for image sets: closed for `length` s every `every` ± `jitter` s (seeded: tests are repeatable). */
export class BlinkTimer {
  private t = 0;
  private next: number;
  private seed: number;
  closed = false;
  constructor(public cfg: { every: number; jitter: number; length: number }, seed = 12345) { this.seed = seed >>> 0 || 1; this.next = this.gap(); }
  private rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  private gap() { return Math.max(0.3, this.cfg.every + (this.rnd() * 2 - 1) * this.cfg.jitter); }
  step(dt: number): boolean {
    this.t += dt;
    if (this.closed) { if (this.t >= this.cfg.length) { this.closed = false; this.t = 0; this.next = this.gap(); } }
    else if (this.t >= this.next) { this.closed = true; this.t = 0; }
    return this.closed;
  }
}

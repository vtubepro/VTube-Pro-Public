// In-room live timer displays (beta.14): a room mesh whose UVs the subathon countdown is drawn onto, so the clock lives IN
// the world (a giant's throat, a scoreboard, a wall clock) instead of only on the docked card. Pure part: the declarations
// (node names + scene.json `timerDisplays`), the state machine that turns the helper's goals view into what to show (big
// H:MM:SS digits, the "+10:00" pop, Hop / happy hour / hype / sleep / paused badges, test mode, idle) and the cheap change
// signatures the page uses to redraw at most once a second. No DOM, no three.js: tools/timer_display_unit.ts tests it all.
// The page side is src/goals/timerDisplays.ts (finds the surface, owns the CanvasTexture) + src/goals/timerDraw.ts (paints).
//
// Everything is computed from the SAME goals view every page already gets (src/goals/goalsStore.ts: the ABSOLUTE end time +
// the helper's clock offset), so the studio preview, every OBS page and every party guest's page show the same second: no
// page-local timer ever runs.
//
// Declaring a display:
//   node        TIMER_DISPLAY / TIMER_DISPLAY_xx: a mesh with UVs; glTF extras `style`, `color`, `show`, `label`, `fit`, `glass` optional
//   scene.json  "timerDisplays": [{ "node": "<existing mesh name>", "style"?, "color"?, "show"?, "label"?, "material"?, "fit"?, "glass"? }]
//               (point an existing room at an existing mesh without re-exporting it)
// `fit` (0.3..1, default 1) shrinks the glass panel + digits about the surface's centre: a halo quad that is wider than the glowing
// thing it sits behind (a dome, a medallion) would otherwise carry the clock past that thing's rim. `glass` (0.5..1, default 0.95)
// is the panel's opacity: lower lets the surface's own picture show through the glass.
// Idle (no subathon, the goals "In the room" switch off, or the card set to goals only): nothing is drawn and the room's
// own material shows exactly as the artist made it.
import { fmtClock, fmtSpan } from './goals.ts';
import { viewRemaining, type GoalsView, type SubLive } from './goalsView.ts';

export type TimerStyle = 'digits' | 'neon' | 'lcd';
export type TimerShow = 'remaining' | 'uptime' | 'both';
export const TIMER_STYLES: readonly TimerStyle[] = ['digits', 'neon', 'lcd'];
export const TIMER_SHOWS: readonly TimerShow[] = ['remaining', 'uptime', 'both'];
export const MAX_TIMER_DISPLAYS = 8;
/** `fit`: how much of the surface the glass panel (and with it the digits) may cover. 1 = the layout's own size (default). */
export const TIMER_FIT_MIN = 0.3, TIMER_FIT_MAX = 1;
/** `glass`: the panel's opacity. */
export const TIMER_GLASS_MIN = 0.5, TIMER_GLASS_MAX = 1, TIMER_GLASS_DEFAULT = 0.95;
/** TIMER_DISPLAY and TIMER_DISPLAY_01 … (the number only tells displays apart: every one shows the same clock). */
export const TIMER_NODE = /^TIMER_DISPLAY(?:_(\d{1,2}))?$/;

export interface TimerDisplaySpec {
  /** the room node (mesh, or a group of meshes: the best surface inside it is used) */
  node: string;
  style: TimerStyle;
  /** '#rrggbb'; '' = the surface's own glow colour, else the stage palette's accent */
  color: string;
  /** '' = follow the subathon's own display setting (Goals & subathon → timer shows) */
  show: TimerShow | '';
  /** a short caption in the corner ('' = none) */
  label: string;
  /** optional: pick the sub-mesh whose material name contains this (when a node holds several meshes) */
  material: string;
  /** TIMER_FIT_MIN..1: the panel + digits are scaled by this about the surface's centre (1 = the layout's own size) */
  fit: number;
  /** TIMER_GLASS_MIN..1: the panel's opacity (the default lets a little of the surface through) */
  glass: number;
}

const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A number from a scene.json value or a glTF extra (Blender custom properties also arrive as numeric strings), clamped to [lo, hi]; `dflt` when it is not a number. */
function cleanNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x)) * 100) / 100 : dflt;
}
export const cleanFit = (v: unknown) => cleanNum(v, TIMER_FIT_MIN, TIMER_FIT_MAX, 1);
export const cleanGlass = (v: unknown) => cleanNum(v, TIMER_GLASS_MIN, TIMER_GLASS_MAX, TIMER_GLASS_DEFAULT);

/** glTF / three.js node names compare by this key (three turns spaces into _ and drops [ ] . : / from node names). */
export const nameKey = (n: string) => n.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

export function cleanColor(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return '';
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
}

/** One declaration (scene.json entry or glTF extras) → a spec; null = no usable node name. */
export function sanitizeTimerSpec(raw: unknown, node?: string): TimerDisplaySpec | null {
  const x = obj(raw);
  const name = clean(node ?? x.node, 96);
  if (!name) return null;
  return {
    node: name,
    style: TIMER_STYLES.includes(x.style as TimerStyle) ? x.style as TimerStyle : 'digits',
    color: cleanColor(x.color),
    show: TIMER_SHOWS.includes(x.show as TimerShow) ? x.show as TimerShow : '',
    label: clean(x.label, 24),
    material: clean(x.material, 48),
    fit: cleanFit(x.fit),
    glass: cleanGlass(x.glass),
  };
}

/** scene.json `timerDisplays` (anything else = none); one entry per node, at most MAX_TIMER_DISPLAYS. */
export function sanitizeTimerDisplays(raw: unknown): TimerDisplaySpec[] {
  const out: TimerDisplaySpec[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(raw) ? raw : []) {
    const s = sanitizeTimerSpec(e);
    if (!s || seen.has(nameKey(s.node))) continue;
    seen.add(nameKey(s.node));
    out.push(s);
    if (out.length >= MAX_TIMER_DISPLAYS) break;
  }
  return out;
}

export interface RoomNodeRef { name: string; parent: string; extras?: unknown }
export interface TimerTarget { spec: TimerDisplaySpec; /** the room node's real name */ node: string; from: 'scene.json' | 'node' }
export interface TimerPlan { targets: TimerTarget[]; /** scene.json entries that match no node in the room */ missing: string[] }

/**
 * Which room nodes become displays: the scene.json entries first (they win), then every TIMER_DISPLAY[_xx] node. A node
 * whose parent also has such a name is skipped (three.js names the primitives of a multi-material mesh `<name>_1`, `<name>_2`
 * under the group that carries `<name>`).
 */
export function planTimerDisplays(json: unknown, nodes: readonly RoomNodeRef[]): TimerPlan {
  const targets: TimerTarget[] = [];
  const missing: string[] = [];
  const taken = new Set<string>();
  const byKey = new Map<string, RoomNodeRef>();
  for (const n of nodes) if (n.name && !byKey.has(nameKey(n.name))) byKey.set(nameKey(n.name), n);
  for (const spec of sanitizeTimerDisplays(json)) {
    const n = byKey.get(nameKey(spec.node));
    if (!n) { missing.push(spec.node); continue; }
    if (taken.has(nameKey(n.name))) continue;
    taken.add(nameKey(n.name));
    targets.push({ spec, node: n.name, from: 'scene.json' });
  }
  for (const n of nodes) {
    if (targets.length >= MAX_TIMER_DISPLAYS) break;
    if (!TIMER_NODE.test(n.name) || TIMER_NODE.test(n.parent) || taken.has(nameKey(n.name))) continue;
    taken.add(nameKey(n.name));
    const spec = sanitizeTimerSpec(n.extras, n.name);
    if (spec) targets.push({ spec, node: n.name, from: 'node' });
  }
  return { targets, missing };
}

// ---------------------------------------------------------------- the clock
/** 172_752_000 → "47:59:12", 10_800_000 → "3:00:00", 59_000 → "0:00:59" (hours never roll into days: the digits stay readable). */
export function fmtDigits(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

/** Why nothing is drawn ('' = a display is wanted). The room's own material shows in every other case. */
export type TimerHide = '' | 'no-view' | 'no-subathon' | 'world-off' | 'goals-only';
export function timerHidden(v: GoalsView | null): TimerHide {
  if (!v) return 'no-view';
  if (!v.sub) return 'no-subathon';
  if (!v.show.world) return 'world-off';
  if (v.show.what === 'goals') return 'goals-only';
  return '';
}

/** The big number's milliseconds (what the digits show) and the other one's (the small line), by display mode. */
export function timerMainMs(sub: SubLive, now: number, mode: TimerShow): number {
  if (sub.ended) return mode === 'uptime' ? Math.max(0, sub.endedAt - sub.startedAt) : 0;
  return mode === 'uptime' ? Math.max(0, now - sub.startedAt) : viewRemaining(sub, now);
}
export function timerOtherMs(sub: SubLive, now: number, mode: TimerShow): number {
  if (sub.ended || mode === 'remaining') return 0;
  return mode === 'uptime' ? viewRemaining(sub, now) : Math.max(0, now - sub.startedAt);
}

// ---------------------------------------------------------------- the "+10:00" pop
export const POP_MS = 4200;
const POP_IN = 450, POP_OUT = 700;
/** quarter-second-ish steps: a pop eases through at most this many redraws each way (never a per-frame redraw) */
export const POP_STEPS = 8;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** Pop visibility 0..1 at `age` ms: eases in over 450 ms, holds, eases out over 700 ms (no strobe: every change is smooth). */
export function popEnvelope(age: number): number {
  if (!(age >= 0) || age >= POP_MS) return 0;
  return Math.min(smooth(age / POP_IN), smooth((POP_MS - age) / POP_OUT));
}
export interface PopIn { seq?: number; ms: number; who: string; at: number }
/** The newest pop still on screen at `wall` (the page's Date.now()), with its age; null = none. */
export function activePop(pops: readonly PopIn[], wall: number): { pop: PopIn; age: number } | null {
  for (let i = pops.length - 1; i >= 0; i--) { const age = wall - pops[i].at; if (age >= 0 && age < POP_MS) return { pop: pops[i], age }; }
  return null;
}
/** Cheap change signature of the pop (no allocation): -1 = none, else newest pop's seq × 16 + the eased step. */
export function popSig(pops: readonly PopIn[], wall: number): number {
  for (let i = pops.length - 1; i >= 0; i--) {
    const age = wall - pops[i].at;
    if (age >= 0 && age < POP_MS) return (pops[i].seq ?? i) * 16 + Math.round(popEnvelope(age) * POP_STEPS);
  }
  return -1;
}

// ---------------------------------------------------------------- what to draw
export type TimerBadgeKind = 'paused' | 'ended' | 'test' | 'happy' | 'hype' | 'sleep';
export interface TimerBadge { kind: TimerBadgeKind; text: string }
export interface TimerFace {
  state: 'running' | 'paused' | 'ended';
  /** under 5 minutes left: the digits turn warm (a steady colour, never a pulse) */
  urgent: boolean;
  /** the big digits, "H:MM:SS" */
  main: string;
  /** the small line under them: the other clock ("LIVE 5:03:12" / "7:25:13 LEFT"), or the end summary */
  sub: string;
  label: string;
  /** most important first: the drawer drops what does not fit from the end */
  badges: TimerBadge[];
  /** the "+10:00" pop (k eased 0..1, in steps of 1/POP_STEPS) */
  pop: { text: string; who: string; k: number; add: boolean } | null;
  test: boolean;
  /** everything above joined: equal keys draw identical pictures */
  key: string;
}

const trim = (v: number) => String(Math.round(v * 100) / 100);
const upper = (s: string) => s.toUpperCase();

/** The display for the view at `now` (helper clock) / `wall` (page clock, for the pop); null = idle (see timerHidden). */
export function timerFace(v: GoalsView | null, now: number, wall: number, pops: readonly PopIn[], opts: { show?: TimerShow | ''; label?: string } = {}): TimerFace | null {
  if (timerHidden(v)) return null;
  const sub = v!.sub!;
  const mode: TimerShow = opts.show || sub.display;
  const state: TimerFace['state'] = sub.ended ? 'ended' : sub.paused ? 'paused' : 'running';
  const left = viewRemaining(sub, now);
  const urgent = state === 'running' && left < 5 * 60_000;
  const main = fmtDigits(timerMainMs(sub, now, mode));
  let line = '';
  if (state === 'ended') line = sub.summary ? `RAN ${upper(fmtSpan(sub.summary.lengthMs))}` : '';
  else if (mode === 'both') line = `LIVE ${fmtDigits(timerOtherMs(sub, now, mode))}`;
  else if (mode === 'uptime') line = `${fmtDigits(timerOtherMs(sub, now, mode))} LEFT`;
  const badges: TimerBadge[] = [];
  if (state === 'paused') badges.push({ kind: 'paused', text: 'PAUSED' });
  if (state === 'ended') badges.push({ kind: 'ended', text: 'TIME!' });
  if (v!.test) badges.push({ kind: 'test', text: 'TEST' });
  if (state !== 'ended') {
    if (sub.happy && sub.happy.until > now) badges.push({ kind: 'happy', text: `HAPPY HOUR ×${trim(sub.happy.mult)}` });
    if (sub.hype && sub.hype.until > now) badges.push({ kind: 'hype', text: `HYPE ×${trim(sub.hype.mult)}` });
    if (sub.sleep) badges.push({ kind: 'sleep', text: 'SLEEP' });
  }
  let pop: TimerFace['pop'] = null;
  const ap = state === 'ended' ? null : activePop(pops, wall);
  if (ap) {
    const k = Math.round(popEnvelope(ap.age) * POP_STEPS) / POP_STEPS;
    if (k > 0) pop = { text: `${ap.pop.ms >= 0 ? '+' : '−'}${fmtClock(Math.abs(ap.pop.ms), false)}`, who: ap.pop.who, k, add: ap.pop.ms >= 0 };
  }
  const label = opts.label ?? '';
  const key = [state, urgent ? 'u' : '', main, line, label, v!.test ? 't' : '', badges.map((b) => b.text).join('|'), pop ? `${pop.text}~${pop.who}~${pop.k}` : ''].join('\u0001');
  return { state, urgent, main, sub: line, label, badges, pop, test: v!.test, key };
}

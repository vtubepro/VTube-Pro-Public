// Ambient cameras for the "not live yet / away / goodbye" moments (lighting states PRESHOW, BRB, OUTRO): slow pans,
// orbits, dollies, crane moves, a slow zoom, a subtle handheld drift, a static "security cam" and a slow tour between
// the room's authored cameras. Host-owned like the rest of SceneState (state.ambcam); every OBS page (host + guests)
// computes the same shot from the same numbers + the wall clock, so all pages agree without streaming a camera.
// Runtime: src/scene/ambientCam.ts (path generation per room, validated against the room's walls / props).

export type AmbMoveId = 'pan' | 'orbit' | 'dolly' | 'crane' | 'zoom' | 'drift' | 'security' | 'tour';
export const AMB_MOVES: AmbMoveId[] = ['pan', 'orbit', 'dolly', 'crane', 'zoom', 'drift', 'security', 'tour'];
export const AMB_MOVE_LABEL: Record<AmbMoveId, string> = {
  pan: 'Slow pan', orbit: 'Slow orbit', dolly: 'Dolly in / out', crane: 'Crane (pedestal)', zoom: 'Slow zoom (focus pull)',
  drift: 'Handheld drift', security: 'Security cam', tour: 'Tour the room cameras',
};

export type AmbStateId = 'preshow' | 'brb' | 'outro';
export const AMB_STATES: AmbStateId[] = ['preshow', 'brb', 'outro'];
export const AMB_STATE_LABEL: Record<AmbStateId, string> = { preshow: 'Preshow', brb: 'BRB', outro: 'Outro' };

export interface AmbSlot {
  /** This moment uses ambient cameras (off = the room camera as usual). */
  on: boolean;
  /** One move, or a rotation (cycled every `cycle` s). */
  moves: AmbMoveId[];
  /** Seconds per shot (8 … 120). A single move still re-plans its path (a new angle) every shot. */
  cycle: number;
  /** Between shots: false = a smooth camera glide, true = a cut. */
  cut: boolean;
  /** Motion amount / pace (0.25 … 2.5, 1 = default gentle). */
  speed: number;
}

export interface SceneAmbientCam {
  /** Master switch (Scene tab → Ambient cameras; Stream Deck "Ambient cams"). */
  on: boolean;
  slots: Partial<Record<AmbStateId, AmbSlot>>;
  /** Epoch ms the shot clock counts from (a "next" / "pick move" press restarts it so the new shot starts at its beginning). */
  at: number;
  /** Shots skipped by "next" (per moment), added to the clock's shot index. */
  skip?: Partial<Record<AmbStateId, number>>;
  /** A move picked by hand ("Preshow cam: orbit"), held until the next lighting-state change or "next". */
  pick?: Partial<Record<AmbStateId, AmbMoveId>>;
}

export const DEFAULT_AMB_SLOTS: Record<AmbStateId, AmbSlot> = {
  preshow: { on: true, moves: ['orbit', 'pan', 'crane', 'tour'], cycle: 24, cut: false, speed: 1 },
  brb: { on: true, moves: ['drift', 'dolly', 'pan', 'security'], cycle: 20, cut: false, speed: 1 },
  outro: { on: true, moves: ['crane', 'orbit', 'zoom'], cycle: 26, cut: false, speed: 1 },
};
export const DEFAULT_AMBCAM: SceneAmbientCam = { on: false, slots: {}, at: 0 };

const MOVE = new Set<string>(AMB_MOVES);
const STATE = new Set<string>(AMB_STATES);
export const isAmbMove = (v: unknown): v is AmbMoveId => typeof v === 'string' && MOVE.has(v);
export const isAmbState = (v: unknown): v is AmbStateId => typeof v === 'string' && STATE.has(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeAmbSlot(o: unknown, d: AmbSlot): AmbSlot {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const moves = Array.isArray(x.moves) ? [...new Set(x.moves.filter(isAmbMove))].slice(0, 8) : d.moves;
  return { on: typeof x.on === 'boolean' ? x.on : d.on, moves: moves.length ? moves : d.moves, cycle: num(x.cycle, 8, 120, d.cycle),
    cut: typeof x.cut === 'boolean' ? x.cut : d.cut, speed: num(x.speed, 0.25, 2.5, d.speed) };
}

export function sanitizeAmbientCam(o: unknown): SceneAmbientCam {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const sl = (x.slots && typeof x.slots === 'object' ? x.slots : {}) as Record<string, unknown>;
  const slots: SceneAmbientCam['slots'] = {};
  for (const id of AMB_STATES) if (sl[id] && typeof sl[id] === 'object') slots[id] = sanitizeAmbSlot(sl[id], DEFAULT_AMB_SLOTS[id]);
  const skip: NonNullable<SceneAmbientCam['skip']> = {}, pick: NonNullable<SceneAmbientCam['pick']> = {};
  const sk = (x.skip && typeof x.skip === 'object' ? x.skip : {}) as Record<string, unknown>;
  const pk = (x.pick && typeof x.pick === 'object' ? x.pick : {}) as Record<string, unknown>;
  for (const id of AMB_STATES) {
    if (typeof sk[id] === 'number') skip[id] = Math.round(num(sk[id], 0, 1e6, 0));
    if (isAmbMove(pk[id])) pick[id] = pk[id] as AmbMoveId;
  }
  return { on: x.on === true, slots, at: num(x.at, 0, 1e14, 0),
    ...(Object.keys(skip).length ? { skip } : {}), ...(Object.keys(pick).length ? { pick } : {}) };
}

/** The settings of a moment (defaults filled in). */
export const ambSlot = (a: SceneAmbientCam | undefined, id: AmbStateId): AmbSlot => ({ ...DEFAULT_AMB_SLOTS[id], ...(a?.slots[id] ?? {}) });

/** Which shot plays at `now` (epoch ms): deterministic from the state + the clock, so every page picks the same one. */
export interface AmbShot {
  state: AmbStateId;
  move: AmbMoveId;
  /** Shot number (changes every `cycle` s): seeds the path variant. */
  k: number;
  /** 0 … 1 through the shot. */
  u: number;
  secs: number;
  cut: boolean;
  speed: number;
}

export function ambientShot(a: SceneAmbientCam | undefined, lighting: string | undefined, now: number): AmbShot | null {
  if (!a?.on || !isAmbState(lighting)) return null;
  const s = ambSlot(a, lighting);
  if (!s.on || !s.moves.length) return null;
  const len = s.cycle * 1000;
  const t = Math.max(0, now - a.at);
  const n = Math.floor(t / len);
  const k = n + (a.skip?.[lighting] ?? 0);
  const pick = a.pick?.[lighting];
  const move = pick ?? s.moves[((k % s.moves.length) + s.moves.length) % s.moves.length];
  return { state: lighting, move, k, u: (t - n * len) / len, secs: s.cycle, cut: s.cut, speed: s.speed };
}

/** Apply a remote-control command (bus `scene` {ambcam: {...}}; Stream Deck / Live actions) — pure, host side. */
export function ambientCommand(a: SceneAmbientCam, c: Record<string, unknown>, lighting: string | undefined, now: number): SceneAmbientCam {
  const x: SceneAmbientCam = structuredClone(a);
  if (c.on === 'toggle') x.on = !x.on; else if (typeof c.on === 'boolean') x.on = c.on;
  const st: AmbStateId | null = isAmbState(c.state) ? c.state : isAmbState(lighting) ? lighting : null;
  if (st && isAmbMove(c.move)) { x.on = true; x.pick = { ...(x.pick ?? {}), [st]: c.move }; x.slots[st] = { ...ambSlot(x, st), on: true }; x.at = now; x.skip = {}; }
  if (st && c.action === 'next') {
    // restart the clock at shot 0 + (the shot that was playing + 1): the next shot starts at its beginning, on every page
    const cur = ambientShot(x, st, now);
    if (x.pick?.[st]) { const p = { ...x.pick }; delete p[st]; x.pick = p; }
    x.skip = { ...(x.skip ?? {}), [st]: (cur?.k ?? 0) + 1 };
    x.at = now;
  }
  if (st && c.action === 'auto' && x.pick?.[st]) { const p = { ...x.pick }; delete p[st]; x.pick = p; }
  if (st && typeof c.cut === 'boolean') x.slots[st] = { ...ambSlot(x, st), cut: c.cut };
  if (st && typeof c.speed === 'number' && Number.isFinite(c.speed)) x.slots[st] = { ...ambSlot(x, st), speed: Math.min(2.5, Math.max(0.25, c.speed)) };
  if (st && typeof c.cycle === 'number' && Number.isFinite(c.cycle)) x.slots[st] = { ...ambSlot(x, st), cycle: Math.min(120, Math.max(8, c.cycle)) };
  return sanitizeAmbientCam(x);
}

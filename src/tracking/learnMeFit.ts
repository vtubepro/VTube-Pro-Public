// "Keep learning me" — the learning step. Pure functions (runs in a Web Worker in the studio, and in Node for tools /
// tests), never on the tracking thread.
//
// Three areas, each in the model-agnostic spaces the engine already uses, so the result works on every avatar:
//   lip     the voice → mouth style (speakingProfile.ts): open / wide / round / pucker coefficients per vowel.
//           Truth = the camera's own mouth at the same instant on clear, well-tracked speech.
//   habits  blink rate while quiet / while talking → the camera-lost + voice-only face (voiceLife.ts).
//   motion  idle head sway, talking nods, tilts and turns → the same fallback (voiceLife.ts multipliers).
//           Habits and motion are fitted by SIMULATION: the fallback itself is run on the performer's own recorded
//           voice, and its settings are scaled until its statistics match what the camera saw them do.
// Every update is gated on held-out data: frames are cut into time blocks and every 4th block (with a guard gap) is
// never used for fitting. A new setting is adopted only if it beats BOTH the current one and the generic default on
// those blocks; otherwise the old one stays and the reason is logged.
import { DEFAULT_STYLE, VOWEL_ORDER, sharpen, styleShapes, type VowelStyle } from './speakingProfile.ts';
import { VoiceLife } from '../avatar/voiceLife.ts';
import { F, LM_F, ARKIT_INDEX, type LmFrames } from './learnMeData.ts';
import type { TrackingFrame } from '../../shared/types.ts';

export const LIP_CH = ['open', 'wide', 'round', 'pucker'] as const;
export type LipCh = (typeof LIP_CH)[number];
export interface LipModel { style: VowelStyle; use: Record<LipCh, boolean> }
export interface HabitModel { blinkIdleS: number; blinkTalkS: number }
export interface MotionModel { sway: number; nod: number; tilt: number; turn: number }
export interface LearnedModel { lip: LipModel | null; habits: HabitModel | null; motion: MotionModel | null }
export const GENERIC_HABITS: HabitModel = { blinkIdleS: 3.5, blinkTalkS: 3.2 };
export const GENERIC_MOTION: MotionModel = { sway: 1, nod: 1, tilt: 1, turn: 1 };

export interface AreaReport { area: 'lip' | 'habits' | 'motion'; adopted: boolean; line: string; why?: string;
  /** held-out error: generic default / the version in use / the new candidate (lower is better) */
  err?: { generic: number; current: number; candidate: number }; heldOut?: number }
export interface LearnResult { model: LearnedModel; changed: boolean; reports: AreaReport[]; seconds: { train: number; heldOut: number }; at: string }
export interface LearnOpts { enunciation?: number; blockS?: number; holdEvery?: number; holdPhase?: number; seed?: number; maxSimS?: number;
  /** minimum clear-speech frames to learn / to check the lip area (defaults 300 / 100; tools only) */ minLip?: [number, number];
  /** the style the lip area builds on (the speaking profile's, or the default) */ baseStyle?: VowelStyle }

const X = (fr: LmFrames, i: number, f: number) => fr.x[i * LM_F + f];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// ---------------- split ----------------

/** Time-block split: blocks of `blockS` seconds; every `holdEvery`-th block is held out; 1 s guard either side dropped. */
export function splitBlocks(fr: LmFrames, blockS = 60, holdEvery = 4, phase = holdEvery - 1) {
  const train: number[] = [], held: number[] = [];
  if (!fr.n) return { train, held };
  const t0 = fr.t[0];
  for (let i = 0; i < fr.n; i++) {
    const u = (fr.t[i] - t0) / blockS, b = Math.floor(u), frac = (u - b) * blockS;
    const isHeld = b % holdEvery === phase;
    const nearEdge = frac < 1 || frac > blockS - 1;
    if (nearEdge && (isHeld || (b + 1) % holdEvery === phase || (b - 1 + holdEvery) % holdEvery === phase)) continue;
    (isHeld ? held : train).push(i);
  }
  return { train, held };
}
/** Continuous runs (frame steps < 0.25 s) among the given indices. */
function runs(fr: LmFrames, idx: number[]): number[][] {
  const out: number[][] = []; let cur: number[] = [];
  for (const i of idx) {
    if (cur.length && (fr.t[i] - fr.t[cur[cur.length - 1]] > 0.25 || i !== cur[cur.length - 1] + 1)) { out.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------- lip: voice → mouth style ----------------

interface LipSample { level: number; w: number[]; cam: Record<LipCh, number> }
function lipSamples(fr: LmFrames, idx: number[], en: number): LipSample[] {
  const out: LipSample[] = [];
  for (const i of idx) {
    if (X(fr, i, F.hasVoice) < 0.5 || X(fr, i, F.quality) > 1.5) continue;
    const level = X(fr, i, F.level);
    if (level <= 0.12 || X(fr, i, F.voiced) < 0.5) continue;               // clear speech only
    const v = Object.fromEntries(VOWEL_ORDER.map((k, j) => [k, X(fr, i, F.vowels + j)])) as Record<(typeof VOWEL_ORDER)[number], number>;
    out.push({ level, w: sharpen(v, en), cam: { open: X(fr, i, F.camOpen), wide: X(fr, i, F.camWide), round: X(fr, i, F.camRound), pucker: X(fr, i, F.camPucker) } });
  }
  return out;
}
function solveRidge(rows: { x: number[]; y: number }[], k0: number[], lam: number) {
  const n = k0.length, A = new Float64Array(n * n), b = new Float64Array(n);
  for (const r of rows) for (let i = 0; i < n; i++) { b[i] += r.x[i] * r.y; for (let j = 0; j < n; j++) A[i * n + j] += r.x[i] * r.x[j]; }
  const sc = rows.reduce((a, r) => a + r.x.reduce((q, v) => q + v * v, 0), 0) / Math.max(1, rows.length * n);
  for (let i = 0; i < n; i++) { A[i * n + i] += lam * sc; b[i] += lam * sc * k0[i]; }
  const M = Array.from(A), v = Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-12) return k0.slice();
    for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
    [v[c], v[p]] = [v[p], v[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r * n + c] / M[c * n + c]; for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k]; v[r] -= f * v[c]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = v[r]; for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k]; x[r] = s / M[r * n + r]; }
  return x.map((q) => clamp(q, 0, 2.5));
}
/** All four channels (the setup test's fit keeps open / pucker generic: here every channel is fitted and then gated). */
export function fitLipStyle(S: LipSample[], prior: VowelStyle, en: number, lambda = 40): VowelStyle {
  const openK = solveRidge(S.map((s) => ({ x: [s.level, ...s.w.map((q) => q * s.level)], y: s.cam.open })), [prior.base, ...prior.open], lambda);
  const ch = (key: 'wide' | 'round' | 'pucker') => solveRidge(S.map((s) => ({ x: s.w.map((q) => q * s.level * en), y: s.cam[key] })), prior[key], key === 'pucker' ? lambda * 2 : lambda);
  return { base: openK[0], open: openK.slice(1), wide: ch('wide'), round: ch('round'), pucker: ch('pucker') };
}
export function lipMae(st: VowelStyle, S: LipSample[], en: number): Record<LipCh, number> {
  const e = { open: 0, wide: 0, round: 0, pucker: 0 };
  for (const s of S) { const p = styleShapes(st, s.level, s.w, en); for (const k of LIP_CH) e[k] += Math.abs(p[k] - s.cam[k]); }
  for (const k of LIP_CH) e[k] /= Math.max(1, S.length);
  return e;
}
/** The style in effect: `base` with the learned channels blended in at `strength`. */
export function effectiveStyle(base: VowelStyle, lip: LipModel | null, strength = 1): VowelStyle {
  if (!lip || strength <= 0) return base;
  const k = clamp(strength, 0, 1), mix = (a: number[], b: number[]) => a.map((x, i) => x + (b[i] - x) * k);
  return {
    base: lip.use.open ? base.base + (lip.style.base - base.base) * k : base.base,
    open: lip.use.open ? mix(base.open, lip.style.open) : base.open.slice(),
    wide: lip.use.wide ? mix(base.wide, lip.style.wide) : base.wide.slice(),
    round: lip.use.round ? mix(base.round, lip.style.round) : base.round.slice(),
    pucker: lip.use.pucker ? mix(base.pucker, lip.style.pucker) : base.pucker.slice(),
  };
}

function learnLip(fr: LmFrames, split: { train: number[]; held: number[] }, cur: LipModel | null, o: Required<Pick<LearnOpts, 'enunciation'>> & LearnOpts): { lip: LipModel | null; rep: AreaReport } {
  const en = o.enunciation, base = o.baseStyle ?? DEFAULT_STYLE;
  const tr = lipSamples(fr, split.train, en), te = lipSamples(fr, split.held, en);
  const [minTr, minTe] = o.minLip ?? [300, 100];
  if (tr.length < minTr || te.length < minTe)
    return { lip: cur, rep: { area: 'lip', adopted: false, line: 'Lip sync: not enough clear speech yet', why: `needs ≥ 10 s of clear talking to learn and ≥ 3 s it has not seen to check (have ${(tr.length / 30).toFixed(0)} s + ${(te.length / 30).toFixed(0)} s)` } };
  const curStyle = effectiveStyle(base, cur, 1);
  const cand = fitLipStyle(tr, curStyle, en);
  const eG = lipMae(DEFAULT_STYLE, te, en), eC = lipMae(curStyle, te, en), eN = lipMae(cand, te, en);
  // per channel: adopt the candidate where it beats both by ≥ 2 %; keep the current where IT still beats generic
  const use = { open: false, wide: false, round: false, pucker: false } as Record<LipCh, boolean>;
  const style: VowelStyle = { base: base.base, open: base.open.slice(), wide: base.wide.slice(), round: base.round.slice(), pucker: base.pucker.slice() };
  const kept: string[] = [], dropped: string[] = [];
  for (const k of LIP_CH) {
    const pick = (src: VowelStyle) => { if (k === 'open') { style.base = src.base; style.open = src.open.slice(); } else style[k] = src[k].slice(); use[k] = true; };
    if (eN[k] < Math.min(eG[k], eC[k]) * 0.98) pick(cand);
    else if (cur?.use[k] && eC[k] <= eG[k]) { pick(curStyle); kept.push(k); }
    else if (cur?.use[k]) dropped.push(k);
  }
  const sum = (e: Record<LipCh, number>) => LIP_CH.reduce((s, k) => s + e[k], 0);
  const final = effectiveStyle(base, { style, use }, 1);
  const eF = lipMae(final, te, en);
  const gain = (sum(eG) - sum(eF)) / sum(eG), vsCur = (sum(eC) - sum(eF)) / sum(eC);
  const any = LIP_CH.some((k) => use[k]);
  const changedFromCur = LIP_CH.some((k) => use[k] !== !!cur?.use[k]) || LIP_CH.some((k) => use[k] && eN[k] < Math.min(eG[k], eC[k]) * 0.98);
  const chans = LIP_CH.filter((k) => use[k]).join(', ');
  const err = { generic: +sum(eG).toFixed(4), current: +sum(eC).toFixed(4), candidate: +sum(eF).toFixed(4) };
  if (!any) return { lip: null, rep: { area: 'lip', adopted: false, line: 'Lip sync: the standard mouth style still fits you best', why: 'no learned channel beat the standard style on speech it had not seen' + (dropped.length ? ` (dropped ${dropped.join(', ')}: no longer better than standard)` : ''), err, heldOut: te.length } };
  if (!changedFromCur) return { lip: cur, rep: { area: 'lip', adopted: false, line: `Lip sync: kept your current style (${Math.round(gain * 100)}% closer to your real mouth than standard)`, why: 'the new fit did not beat the one in use on held-out speech', err, heldOut: te.length } };
  return { lip: { style: final, use }, rep: { area: 'lip', adopted: true, err, heldOut: te.length,
    line: `Lip sync matched your real mouth ${Math.round(gain * 100)}% better than standard on speech it hadn't seen` + (cur ? ` (${vsCur >= 0 ? '+' : ''}${Math.round(vsCur * 100)}% vs your previous version)` : '') + ` · ${chans}` } };
}

// ---------------- habits + motion: statistics, simulated fallback ----------------

export interface MotionStats { blinkIdle: number; blinkTalk: number; swayY: number; swayP: number; swayR: number; nod: number; tilt: number; turn: number; idleS: number; talkS: number; nBlinkIdle: number; nBlinkTalk: number }

const std = (a: number[]) => { if (a.length < 3) return NaN; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const median = (a: number[]) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

/** A single time series with talk flags → stats. head = rad [yaw,pitch,roll]; blink = blink onsets (s). */
export function seriesStats(t: ArrayLike<number>, head: [number, number, number][], talk: boolean[], blinks: number[]): MotionStats {
  const n = t.length;
  // idle / talking time and windows
  let idleS = 0, talkS = 0;
  for (let i = 1; i < n; i++) { const d = t[i] - t[i - 1]; if (d > 0 && d < 0.25) { if (talk[i]) talkS += d; else idleS += d; } }
  let bI = 0, bT = 0;
  for (const b of blinks) { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= b) lo = m; else hi = m; } if (talk[lo]) bT++; else bI++; }
  // windowed spreads: idle windows 8 s (sway), talking windows 4 s (tilt / turn), talking pitch high-passed (nods)
  const win = (want: boolean, W: number, ax: number, hp: boolean) => {
    const out: number[] = [];
    let s = 0;
    while (s < n) {
      if (talk[s] !== want) { s++; continue; }
      let e = s; while (e + 1 < n && talk[e + 1] === want && t[e + 1] - t[e] < 0.25 && t[e + 1] - t[s] < W) e++;
      if (t[e] - t[s] >= W * 0.6) {
        let v = head.slice(s, e + 1).map((h) => h[ax]);
        if (hp) { const k = 15; v = v.map((x, i) => x - v.slice(Math.max(0, i - k), i + k + 1).reduce((a, b) => a + b, 0) / (Math.min(v.length, i + k + 1) - Math.max(0, i - k))); }
        out.push(std(v));
      }
      s = e + 1;
    }
    return median(out);
  };
  return { blinkIdle: idleS > 30 ? bI / idleS * 60 : NaN, blinkTalk: talkS > 30 ? bT / talkS * 60 : NaN, nBlinkIdle: bI, nBlinkTalk: bT,
    swayY: win(false, 8, 0, false), swayP: win(false, 8, 1, false), swayR: win(false, 8, 2, false),
    nod: win(true, 4, 1, true), tilt: win(true, 4, 2, false), turn: win(true, 4, 0, false), idleS, talkS };
}

/** Talking flag from the voice level: on above 0.12, held 0.3 s after it drops below 0.08. */
function talkFlags(fr: LmFrames, idx: number[]) {
  const out: boolean[] = []; let on = false, below = 0, last = -1;
  for (const i of idx) {
    const d = last >= 0 ? clamp(fr.t[i] - fr.t[last], 0, 0.25) : 0; last = i;
    const L = X(fr, i, F.hasVoice) > 0.5 ? X(fr, i, F.level) : 0;
    if (L > 0.12) { on = true; below = 0; } else if (L < 0.08) { below += d; if (below > 0.3) on = false; }
    out.push(on);
  }
  return out;
}
/** Blink onsets from the raw camera blink channels, adaptive to this person's resting lid (MediaPipe reads some lids
 *  half-closed at rest). A blink = both lids above threshold for 40–450 ms. */
export function detectBlinks(t: ArrayLike<number>, lid: number[]): number[] {
  const base = median(lid.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(lid.length * 0.4))).slice(-1));
  const top = lid.slice().sort((a, b) => a - b)[Math.floor(lid.length * 0.99)] ?? 1;
  const th = base + Math.max(0.18, 0.5 * (top - base));
  const out: number[] = []; let s = -1;
  for (let i = 0; i < lid.length; i++) {
    if (lid[i] > th) { if (s < 0) s = i; }
    else if (s >= 0) { const dur = t[i] - t[s]; if (dur >= 0.04 && dur <= 0.45 && (!out.length || t[s] - out[out.length - 1] > 0.2)) out.push(t[s]); s = -1; }
  }
  return out;
}
function realStats(fr: LmFrames, idx: number[]): MotionStats {
  const agg: MotionStats[] = [];
  for (const r of runs(fr, idx)) {
    if (r.length < 60) continue;
    const t = r.map((i) => fr.t[i]);
    const head = r.map((i) => [X(fr, i, F.head), X(fr, i, F.head + 1), X(fr, i, F.head + 2)] as [number, number, number]);
    const bl = ARKIT_INDEX.get('eyeBlinkLeft')!, br = ARKIT_INDEX.get('eyeBlinkRight')!;
    const lid = r.map((i) => Math.min(X(fr, i, bl), X(fr, i, br)));
    agg.push(seriesStats(t, head, talkFlags(fr, r), detectBlinks(t, lid)));
  }
  return mergeStats(agg);
}
function mergeStats(a: MotionStats[]): MotionStats {
  const idleS = a.reduce((s, x) => s + x.idleS, 0), talkS = a.reduce((s, x) => s + x.talkS, 0);
  const wmean = (k: keyof MotionStats, w: 'idleS' | 'talkS') => { let s = 0, ws = 0; for (const x of a) if (Number.isFinite(x[k]) && x[w] > 0) { s += x[k] * x[w]; ws += x[w]; } return ws ? s / ws : NaN; };
  // blink rates from the pooled counts (single runs are often shorter than the 30 s a rate needs)
  const nI = a.reduce((s, x) => s + x.nBlinkIdle, 0), nT = a.reduce((s, x) => s + x.nBlinkTalk, 0);
  return { blinkIdle: idleS > 30 ? nI / idleS * 60 : NaN, blinkTalk: talkS > 30 ? nT / talkS * 60 : NaN, nBlinkIdle: nI, nBlinkTalk: nT,
    swayY: wmean('swayY', 'idleS'), swayP: wmean('swayP', 'idleS'), swayR: wmean('swayR', 'idleS'),
    nod: wmean('nod', 'talkS'), tilt: wmean('tilt', 'talkS'), turn: wmean('turn', 'talkS'), idleS, talkS };
}

/** Deterministic PRNG for the simulation. */
export function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Run the camera-lost fallback (voiceLife.ts) on this person's recorded voice and measure it the same way. */
export function simStats(fr: LmFrames, idx: number[], habits: HabitModel, motion: MotionModel, seeds = [1, 2], maxS = 900): MotionStats {
  const agg: MotionStats[] = [];
  for (const seed of seeds) {
    let used = 0;
    for (const r of runs(fr, idx)) {
      if (r.length < 60) continue;
      if (used > maxS) break;
      const life = new VoiceLife({ sway: motion.sway, nod: motion.nod, tilt: motion.tilt, turn: motion.turn }, mulberry(seed * 7919 + r[0]));
      life.personal = { blinkIdleS: habits.blinkIdleS, blinkTalkS: habits.blinkTalkS };
      life.log = [];
      const t: number[] = [], head: [number, number, number][] = [];
      let prev = fr.t[r[0]];
      const tStart = fr.t[r[0]];
      for (const i of r) {
        const dt = clamp(fr.t[i] - prev, 1e-3, 0.1); prev = fr.t[i];
        const L = X(fr, i, F.hasVoice) > 0.5 ? X(fr, i, F.level) : 0;
        const f = simFrame(L, X(fr, i, F.voiced) > 0.5 ? clamp(L * 3, 0, 1) : 0, X(fr, i, F.voiced) > 0.5 ? X(fr, i, F.pitch) : undefined);
        const o = life.apply(f, dt);
        t.push(fr.t[i]); head.push([o.head[0], o.head[1], o.head[2]]);
      }
      used += fr.t[r[r.length - 1]] - tStart;
      // the fallback's own blink events, on the same clock (its t starts at 0 for this run)
      const blinks = life.log.filter((e) => e.kind === 'blink').map((e) => tStart + e.t);
      agg.push(seriesStats(t, head, talkFlags(fr, r), blinks));
    }
  }
  return mergeStats(agg);
}
function simFrame(level: number, speak: number, pitch: number | undefined): TrackingFrame {
  return { t: 0, tracked: false, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], face: {},
    mouth: { open: level, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0, speak, pitch } } as unknown as TrackingFrame;
}

const HABIT_KEYS = ['blinkIdle', 'blinkTalk'] as const;
const MOTION_KEYS = ['swayY', 'swayP', 'swayR', 'nod', 'tilt', 'turn'] as const;
/** Mean |log(sim / real)| over the stats both sides have (0 = identical statistics). */
export function statErr(sim: MotionStats, real: MotionStats, keys: readonly (keyof MotionStats)[]) {
  let s = 0, n = 0;
  for (const k of keys) { const a = sim[k], b = real[k]; if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) { s += Math.abs(Math.log(a / b)); n++; } }
  return n ? s / n : NaN;
}

function learnLife(fr: LmFrames, split: { train: number[]; held: number[] }, cur: { habits: HabitModel | null; motion: MotionModel | null }, o: LearnOpts) {
  const maxS = o.maxSimS ?? 900;
  const realTr = realStats(fr, split.train), realTe = realStats(fr, split.held);
  let h: HabitModel = { ...(cur.habits ?? GENERIC_HABITS) }, m: MotionModel = { ...(cur.motion ?? GENERIC_MOTION) };
  // coordinate search on a log grid: each setting in turn, the others held, minimising the log-error of the statistics
  // it drives (sway ↔ idle yaw/pitch/roll spread, nod ↔ talking pitch bobs, tilt ↔ roll, turn ↔ yaw, blink pace ↔
  // blink rate). The statistics are NOT proportional to the settings (gaze-driven head moves don't scale with sway),
  // so a ratio update overshoots; a grid can't.
  const grid = (lo: number, hi: number, n: number) => Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));
  const fitS = Math.min(maxS, 600);
  const steps: { keys: (keyof MotionStats)[]; get: () => number; set: (v: number) => void; g: number[] }[] = [
    { keys: ['swayY', 'swayP', 'swayR'], get: () => m.sway, set: (v) => { m.sway = v; }, g: grid(0.2, 5, 15) },
    { keys: ['nod'], get: () => m.nod, set: (v) => { m.nod = v; }, g: grid(0.2, 5, 15) },
    { keys: ['tilt'], get: () => m.tilt, set: (v) => { m.tilt = v; }, g: grid(0.2, 5, 15) },
    { keys: ['turn'], get: () => m.turn, set: (v) => { m.turn = v; }, g: grid(0.2, 5, 15) },
    { keys: ['blinkIdle'], get: () => h.blinkIdleS, set: (v) => { h.blinkIdleS = v; }, g: grid(1.2, 12, 13) },
    { keys: ['blinkTalk'], get: () => h.blinkTalkS, set: (v) => { h.blinkTalkS = v; }, g: grid(1.2, 12, 13) },
  ];
  for (const st of steps) {
    if (!st.keys.some((k) => Number.isFinite(realTr[k]))) continue;
    let best = st.get(), bestE = statErr(simStats(fr, split.train, h, m, [1, 2], fitS), realTr, st.keys);
    for (const v of st.g) { st.set(v); const e = statErr(simStats(fr, split.train, h, m, [1, 2], fitS), realTr, st.keys); if (e < bestE) { bestE = e; best = v; } }
    st.set(best);
  }
  // held-out check: the fallback with each version, on voice it never saw, vs what the camera saw there
  const seeds = [11, 12];
  const sG = simStats(fr, split.held, GENERIC_HABITS, GENERIC_MOTION, seeds, maxS);
  const sC = cur.habits || cur.motion ? simStats(fr, split.held, cur.habits ?? GENERIC_HABITS, cur.motion ?? GENERIC_MOTION, seeds, maxS) : sG;
  const sN = simStats(fr, split.held, h, m, seeds, maxS);
  const out: { habits: HabitModel | null; motion: MotionModel | null; reps: AreaReport[] } = { habits: cur.habits, motion: cur.motion, reps: [] };
  const gate = (area: 'habits' | 'motion', keys: readonly (keyof MotionStats)[], name: string, needS: number, haveS: number, heldS: number) => {
    const eG = statErr(sG, realTe, keys), eC = statErr(sC, realTe, keys), eN = statErr(sN, realTe, keys);
    const err = { generic: +eG.toFixed(4), current: +eC.toFixed(4), candidate: +eN.toFixed(4) };
    if (haveS < needS || !Number.isFinite(eN)) return { ok: false, keep: true, rep: { area, adopted: false, line: `${name}: not enough data yet`, why: `needs ≥ ${Math.round(needS / 60)} min of well-tracked ${area === 'habits' ? 'quiet + talking' : 'movement'} time and some held out (have ${(haveS / 60).toFixed(1)} min, ${(heldS / 60).toFixed(1)} min held out)` } as AreaReport };
    const better = eN < Math.min(eG, eC) * 0.97;
    const gain = eG > 0 ? (eG - eN) / eG : 0;
    if (better) return { ok: true, keep: false, rep: { area, adopted: true, err, heldOut: Math.round(heldS), line: `${name}: matched how you really move ${Math.round(gain * 100)}% closer than standard, on time it hadn't seen` } as AreaReport };
    // the version in use: keep only if it is still no worse than generic
    const keepCur = eC <= eG;
    return { ok: false, keep: keepCur, rep: { area, adopted: false, err, heldOut: Math.round(heldS), line: `${name}: ${keepCur && (area === 'habits' ? cur.habits : cur.motion) ? 'kept your current version' : 'standard still fits best'}`, why: `the new fit (error ${eN.toFixed(3)}) did not beat ${keepCur ? 'the version in use' : 'standard'} (${Math.min(eG, eC).toFixed(3)}) on held-out time` } as AreaReport };
  };
  const hb = gate('habits', HABIT_KEYS, 'Blinks', 240, realTr.idleS + realTr.talkS, realTe.idleS + realTe.talkS);
  if (hb.ok) out.habits = h; else if (!hb.keep) out.habits = null;
  if (hb.ok) hb.rep.line += ` · you blink ${fmtRate(realTr.blinkIdle)} quiet, ${fmtRate(realTr.blinkTalk)} talking`;
  const mo = gate('motion', MOTION_KEYS, 'Head movement when the camera loses you', 180, realTr.idleS + realTr.talkS, realTe.idleS + realTe.talkS);
  if (mo.ok) out.motion = m; else if (!mo.keep) out.motion = null;
  out.reps.push(hb.rep, mo.rep);
  return { ...out, stats: { realTr, realTe, sG, sC, sN, h, m } };
}
const fmtRate = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)}/min` : '—');

/** One learning pass. `current` = the model in use (null = generic). */
export function learn(fr: LmFrames, current: LearnedModel | null, opts: LearnOpts = {}): LearnResult & { debug: unknown } {
  const o = { enunciation: 1.3, ...opts };
  const split = splitBlocks(fr, o.blockS ?? 60, o.holdEvery ?? 4, o.holdPhase ?? (o.holdEvery ?? 4) - 1);
  const secs = (idx: number[]) => { let s = 0; for (let k = 1; k < idx.length; k++) { const d = fr.t[idx[k]] - fr.t[idx[k - 1]]; if (d > 0 && d < 0.25) s += d; } return s; };
  const L = learnLip(fr, split, current?.lip ?? null, o);
  const life = learnLife(fr, split, { habits: current?.habits ?? null, motion: current?.motion ?? null }, o);
  const model: LearnedModel = { lip: L.lip, habits: life.habits, motion: life.motion };
  const changed = JSON.stringify(model) !== JSON.stringify(current ?? { lip: null, habits: null, motion: null });
  return { model, changed, reports: [L.rep, ...life.reps], seconds: { train: Math.round(secs(split.train)), heldOut: Math.round(secs(split.held)) }, at: new Date().toISOString(), debug: life.stats };
}

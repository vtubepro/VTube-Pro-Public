// "My face model" stage 2, the teach session (docs/FACE_MODEL.md). Pure: no DOM, no clocks of its own, runs in Node.
//
//   the routine   ROUND 1 (18 held expressions, 3 s each) -> read a sentence (8 s) -> ROUND 2 (the same 18 again, 3.4 s each) ->
//                 30 s of "just talk to chat". About 2.5 minutes. Round 1 and most of the talk train the net; in round 2 every
//                 hold is cut into a SELECT half (picks the best epoch) and a JUDGE half (decides adoption), and the end of the talk is
//                 select + judge too. So the frames that judge the model are a second, separate hold of each expression, minutes
//                 away from the first, not neighbours of the training frames (a held pose looks the same for seconds).
//   the capture   the face worker hands the main thread each tracked frame's Stage-1 crops + features (stamped with the frame's
//                 capture time) and the studio adds MediaPipe's own 52 scores: a `Capture`. Captures live in a capped RAM ring.
//   the teacher   chosen at the END, best first: 'arkit' (phone ARKit packets) -> 'maxine' (Maxine's mapped scores) -> 'prompted'
//                 (the prompt's pins + MediaPipe elsewhere), whichever pairs with >= 60 % of the usable captures. Pairing is by
//                 time: the teacher sample nearest the capture, <= 40 ms apart, else the frame is dropped. A phone's packets are
//                 stamped on arrival, so their delay is estimated from the data (estimateLagMs) before pairing.
//   the end       the paired frames are packed (transferable), trained in a worker (trainFaceNet + judgeFaceNet), the crops are zeroed.
import { ARKIT } from '../../core/arkit.ts';
import { EYE_H, EYE_W, MOUTH_H, MOUTH_W, NF_EYE, NF_MOUTH } from './crops.ts';
import { judgeFaceNet, type AdoptOpts, type Comparison } from './evaluate.ts';
import { FACENET_CHANNELS, serializeFaceNet, type FaceNet } from './net.ts';
import { trainFaceNet, type TrainOpts, type TrainReport } from './train.ts';
import type { FaceFrame, TeacherKind } from './types.ts';

const IX = new Map<string, number>(ARKIT.map((n, i) => [n, i]));
export const arkitIndex = (name: string) => IX.get(name) ?? -1;

// ---------------------------------------------------------------- the routine

export type Bucket = 'train' | 'select' | 'judge' | 'drop';
export interface Prompt { id: string; say: string; sub: string; /** ARKit channel -> target the 'prompted' teacher pins while the expression is held (performer's own sides) */ pins: Record<string, number> }
const both = (n: string, v: number): Record<string, number> => ({ [n + 'Left']: v, [n + 'Right']: v });
const PROMPT_LIST: Prompt[] = [
  { id: 'neutral', say: 'Relax your face', sub: 'Look at the camera, mouth closed.', pins: { jawOpen: 0, mouthPucker: 0, mouthFunnel: 0, cheekPuff: 0, browInnerUp: 0, ...both('mouthSmile', 0), ...both('mouthFrown', 0), ...both('browDown', 0), ...both('browOuterUp', 0), ...both('eyeSquint', 0), ...both('eyeWide', 0) } },
  { id: 'blink', say: 'Close your eyes', sub: 'Keep both shut.', pins: { ...both('eyeBlink', 1), ...both('eyeWide', 0) } },
  { id: 'winkL', say: 'Wink your LEFT eye', sub: 'The other stays open.', pins: { eyeBlinkLeft: 1, eyeBlinkRight: 0 } },
  { id: 'winkR', say: 'Wink your RIGHT eye', sub: 'The other stays open.', pins: { eyeBlinkRight: 1, eyeBlinkLeft: 0 } },
  { id: 'squint', say: 'Squint', sub: 'Like looking into bright sun.', pins: { ...both('eyeSquint', 1), ...both('eyeWide', 0) } },
  { id: 'wide', say: 'Open your eyes wide', sub: 'Surprised.', pins: { ...both('eyeWide', 1), ...both('eyeBlink', 0) } },
  { id: 'browsUp', say: 'Raise both eyebrows', sub: 'As high as you can.', pins: { browInnerUp: 1, ...both('browOuterUp', 1), ...both('browDown', 0) } },
  { id: 'browsDown', say: 'Pull your eyebrows down', sub: 'A stern, angry look.', pins: { ...both('browDown', 1), browInnerUp: 0, ...both('browOuterUp', 0) } },
  { id: 'worried', say: 'Worried eyebrows', sub: 'Raise only the inner ends.', pins: { browInnerUp: 1, ...both('browOuterUp', 0), ...both('browDown', 0) } },
  { id: 'smile', say: 'Smile gently', sub: 'Lips together.', pins: { ...both('mouthSmile', 0.5), jawOpen: 0 } },
  { id: 'bigSmile', say: 'Smile big', sub: 'With teeth.', pins: { ...both('mouthSmile', 1), ...both('cheekSquint', 0.6) } },
  { id: 'frown', say: 'Frown', sub: 'Pull the corners of your mouth down.', pins: { ...both('mouthFrown', 1), ...both('mouthSmile', 0) } },
  { id: 'pucker', say: 'Pucker', sub: 'Like a kiss.', pins: { mouthPucker: 1, mouthFunnel: 0, ...both('mouthSmile', 0) } },
  { id: 'funnel', say: 'Say a long "oooh"', sub: 'Lips in a round funnel.', pins: { mouthFunnel: 1 } },
  { id: 'open', say: 'Open your mouth wide', sub: 'Like a big yawn.', pins: { jawOpen: 1, mouthClose: 0 } },
  { id: 'jawL', say: 'Slide your jaw to your LEFT', sub: 'Mouth closed.', pins: { jawLeft: 1, jawRight: 0, jawOpen: 0 } },
  { id: 'jawR', say: 'Slide your jaw to your RIGHT', sub: 'Mouth closed.', pins: { jawRight: 1, jawLeft: 0, jawOpen: 0 } },
  { id: 'puff', say: 'Puff out your cheeks', sub: 'Hold the air in.', pins: { cheekPuff: 1, jawOpen: 0 } },
];
export const PROMPTS: readonly Prompt[] = PROMPT_LIST;
const READ: Prompt = { id: 'read', say: 'Read this aloud', sub: '"The quick brown fox jumps over the lazy dog, and then wakes up the whole street."', pins: {} };
const TALK: Prompt = { id: 'talk', say: 'Just talk to chat', sub: 'Like you would on stream. Move and react normally.', pins: {} };

export interface Cut { t0: number; t1: number; bucket: Bucket; /** the first moments of a hold: the expression is still being formed (the 'prompted' teacher skips them) */ settle?: boolean }
export interface Step { index: number; prompt: Prompt; round: 1 | 2 | 3; t0: number; t1: number; settleEnd: number; cuts: Cut[] }
export interface Routine { steps: Step[]; total: number }
export const ROUTINE_TIMES = { r1Hold: 3, r1Settle: 1, read: 8, r2Settle: 1, r2Select: 0.9, r2Guard: 0.2, r2Judge: 1.3, talkTrain: [1, 17] as [number, number], talkSelect: [18, 24] as [number, number], talkJudge: [25, 30] as [number, number], talk: 30 };

/** The whole routine as steps with absolute offsets (seconds from the start) and the bucket of every moment. */
export function buildRoutine(): Routine {
  const T = ROUTINE_TIMES, steps: Step[] = [];
  let t = 0;
  const add = (prompt: Prompt, round: 1 | 2 | 3, dur: number, settle: number, cuts: (t0: number) => Cut[]) => {
    steps.push({ index: steps.length, prompt, round, t0: t, t1: t + dur, settleEnd: t + settle, cuts: cuts(t) });
    t += dur;
  };
  for (const p of PROMPT_LIST) add(p, 1, T.r1Hold, T.r1Settle, (a) => [{ t0: a, t1: a + T.r1Settle, bucket: 'train', settle: true }, { t0: a + T.r1Settle, t1: a + T.r1Hold, bucket: 'train' }]);
  add(READ, 1, T.read, 0, (a) => [{ t0: a, t1: a + T.read, bucket: 'train' }]);
  for (const p of PROMPT_LIST) {
    const dur = T.r2Settle + T.r2Select + T.r2Guard + T.r2Judge;
    add(p, 2, dur, T.r2Settle, (a) => [{ t0: a, t1: a + T.r2Settle, bucket: 'drop', settle: true }, { t0: a + T.r2Settle, t1: a + T.r2Settle + T.r2Select, bucket: 'select' },
      { t0: a + T.r2Settle + T.r2Select, t1: a + T.r2Settle + T.r2Select + T.r2Guard, bucket: 'drop' }, { t0: a + T.r2Settle + T.r2Select + T.r2Guard, t1: a + dur, bucket: 'judge' }]);
  }
  add(TALK, 3, T.talk, 0, (a) => [{ t0: a, t1: a + T.talkTrain[0], bucket: 'drop' }, { t0: a + T.talkTrain[0], t1: a + T.talkTrain[1], bucket: 'train' }, { t0: a + T.talkTrain[1], t1: a + T.talkSelect[0], bucket: 'drop' }, { t0: a + T.talkSelect[0], t1: a + T.talkSelect[1], bucket: 'select' },
    { t0: a + T.talkSelect[1], t1: a + T.talkJudge[0], bucket: 'drop' }, { t0: a + T.talkJudge[0], t1: a + T.talkJudge[1], bucket: 'judge' }]);
  return { steps, total: t };
}
export const ROUTINE = buildRoutine();

/** Step + cut at `tRel` seconds into the routine (null after the end). */
export function stepAt(r: Routine, tRel: number): { step: Step; cut: Cut } | null {
  if (!(tRel >= 0) || tRel >= r.total) return null;
  for (const s of r.steps) if (tRel < s.t1) { for (const c of s.cuts) if (tRel < c.t1) return { step: s, cut: c }; return { step: s, cut: s.cuts[s.cuts.length - 1] }; }
  return null;
}

/** trainFaceNet's `split` for a routine started at `t0` seconds: frame times -> train / select / judge lists (drop frames are in none). */
export function routineSplit(r: Routine, t0: number) {
  return (t: ArrayLike<number>) => {
    const train: number[] = [], select: number[] = [], judge: number[] = [];
    for (let i = 0; i < t.length; i++) {
      const hit = stepAt(r, t[i] - t0);
      if (!hit) continue;
      const b = hit.cut.bucket;
      if (b === 'train') train.push(i); else if (b === 'select') select.push(i); else if (b === 'judge') judge.push(i);
    }
    return { train, select, judge };
  };
}

// ---------------------------------------------------------------- the teacher

export interface TeacherAvail { arkit: boolean; maxine: boolean }
export const TEACHER_ORDER: TeacherKind[] = ['arkit', 'maxine', 'prompted'];
/** Best teacher that is available, in plain words (also what the panel says before the routine starts). */
export function pickTeacher(a: TeacherAvail): TeacherKind { return a.arkit ? 'arkit' : a.maxine ? 'maxine' : 'prompted'; }
export function teacherSentence(k: TeacherKind): string {
  return k === 'arkit' ? 'Your phone\'s face tracking is the teacher: the best case, a real depth sensor reading your face.'
    : k === 'maxine' ? 'NVIDIA Maxine is the teacher: very good. A phone with face tracking is better still.'
    : 'No phone or GPU face tracking found, so the prompts themselves are the teacher (plus the webcam\'s own tracking). That only teaches the big moves, so expect fewer channels to be taken over; a phone makes it much better.';
}

/** Teacher samples on the performance clock, ms, ascending; nearest-in-time lookup within a gap. Capped. */
export class TeacherTrack {
  private t: number[] = []; private v: Float32Array[] = [];
  constructor(readonly cap = 24000) {}
  get length() { return this.t.length; }
  get lastT() { return this.t.length ? this.t[this.t.length - 1] : -Infinity; }
  clear() { this.t = []; this.v = []; }
  /** `vals` = 52 ARKit-ordered scores. A sample not later than the last one is ignored (duplicates, a clock hiccup). */
  push(tMs: number, vals: ArrayLike<number>) {
    if (!(tMs > this.lastT) || vals.length < ARKIT.length) return;
    const f = new Float32Array(ARKIT.length);
    for (let i = 0; i < ARKIT.length; i++) { const x = vals[i]; f[i] = x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0; }
    this.t.push(tMs); this.v.push(f);
    if (this.t.length > this.cap) { this.t.shift(); this.v.shift(); }
  }
  /** The sample nearest `tMs`, if it is within `maxGapMs`. */
  nearest(tMs: number, maxGapMs = 40): Float32Array | null {
    const t = this.t;
    if (!t.length) return null;
    let lo = 0, hi = t.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < tMs) lo = mid + 1; else hi = mid; }
    let best = lo;
    if (lo > 0 && Math.abs(t[lo - 1] - tMs) <= Math.abs(t[lo] - tMs)) best = lo - 1;
    return Math.abs(t[best] - tMs) <= maxGapMs ? this.v[best] : null;
  }
}

/** The 'prompted' teacher: MediaPipe's scores with the prompt's pins on top. `null` pins = the settle part of a hold. */
export function promptedTeacher(mp: ArrayLike<number>, pins: Record<string, number> | null, out = new Float32Array(ARKIT.length)): Float32Array | null {
  if (!pins) return null;
  for (let i = 0; i < ARKIT.length; i++) out[i] = mp[i];
  for (const k in pins) { const i = IX.get(k); if (i !== undefined) out[i] = pins[k]; }
  return out;
}

/** One tracked frame as the face worker captured it, plus MediaPipe's own scores for it. All Float32Arrays are owned by the capture. */
export interface Capture {
  /** capture time, ms on the performance clock (the frame's RawTracking.capture) */
  tMs: number;
  eyeL: Float32Array; eyeR: Float32Array; mouth: Float32Array; fEyeL: Float32Array; fEyeR: Float32Array; fMouth: Float32Array;
  mp: Float32Array;
}
/** A capped RAM ring of captures (oldest dropped first). Nothing here is ever written anywhere. */
export class CaptureRing {
  private a: Capture[] = [];
  lost = 0;
  constructor(readonly cap = 8000) {}
  get length() { return this.a.length; }
  push(c: Capture) { this.a.push(c); if (this.a.length > this.cap) { scrubCapture(this.a.shift()!); this.lost++; } }
  items(): readonly Capture[] { return this.a; }
  /** Zero every crop and drop them (the performer's face leaves RAM). */
  clear() { for (const c of this.a) scrubCapture(c); this.a = []; }
}
export function scrubCapture(c: Capture) { c.eyeL.fill(0); c.eyeR.fill(0); c.mouth.fill(0); c.fEyeL.fill(0); c.fEyeR.fill(0); c.fMouth.fill(0); }
export function scrubFrames(f: readonly FaceFrame[]) { for (const x of f) { x.eyeL.fill(0); x.eyeR.fill(0); x.mouth.fill(0); x.fEyeL.fill(0); x.fEyeR.fill(0); x.fMouth.fill(0); } }

/** Delays tried for a teacher stamped on ARRIVAL: -200..+800 ms, 5 ms steps within +-100 (a 40 ms delay must not read as 0), 10 ms out to -200 / +300, then 20 ms. */
export const LAG_GRID: number[] = (() => { const g: number[] = []; const seg = (a: number, b: number, st: number) => { for (let L = a; L < b; L += st) g.push(L); }; seg(-200, -100, 10); seg(-100, 100, 5); seg(100, 300, 10); seg(300, 800, 20); g.push(800); return g; })();
/** A teacher is used only if, at its best delay, it correlates with MediaPipe at least this much (mean Pearson r over blink / jaw / brow / smile; MediaPipe is noisy, so this is low on purpose: uncorrelated data sits near 0). */
export const LAG_MIN_R = 0.25;
export interface LagEstimate { lagMs: number; r: number; r0: number; /** the best delay is the edge of the search range: the data is shifted by more than can be trusted */ edge: boolean; ok: boolean }
/** Best delay (ms) of a teacher whose packets are stamped on ARRIVAL: the L in LAG_GRID maximising the correlation of the teacher at t + L with MediaPipe at t over the blink / jaw / brow channels.
 *  `ok` = a clear correlation (>= LAG_MIN_R) that is not at the edge of the search; otherwise the teacher does not line up with the camera. */
export function estimateLagMs(caps: readonly Capture[], track: TeacherTrack, grid: readonly number[] = LAG_GRID): LagEstimate {
  const chans = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'browInnerUp', 'mouthSmileLeft'].map(arkitIndex);
  const score = (L: number) => {
    let s = 0, n = 0;
    for (const c of chans) {
      const a: number[] = [], b: number[] = [];
      for (let i = 0; i < caps.length; i += 4) { const q = track.nearest(caps[i].tMs + L, 20); if (q) { a.push(caps[i].mp[c]); b.push(q[c]); } }
      if (a.length < 30) continue;
      s += corr(a, b); n++;
    }
    return n ? s / n : -2;
  };
  const r0 = score(0);
  let best = 0, bestR = r0;
  for (const L of grid) { if (L === 0) continue; const r = score(L); if (r > bestR) { bestR = r; best = L; } }
  if (bestR <= r0 + 0.01) { best = 0; bestR = r0; } // (no clear gain over "no delay": keep 0)
  const edge = best === grid[0] || best === grid[grid.length - 1];
  return { lagMs: best, r: bestR, r0, edge, ok: bestR >= LAG_MIN_R && !edge };
}
function corr(a: number[], b: number[]) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa < 1e-12 || sbb < 1e-12 ? 0 : sab / Math.sqrt(saa * sbb);
}

export interface PairOpts { maxGapMs?: number; lagMs?: number; /** correlation floor / lag estimate already made for the phone (chooseTeacher computes it once) */ lag?: LagEstimate; /** minimum share of usable captures that must pair for a teacher to be chosen */ minCoverage?: number }
export interface Paired { /** a plain-words note for the panel (a teacher that was refused and why) */ note?: string; kind: TeacherKind; frames: FaceFrame[]; /** captures that were in a dropped part of the routine (settle, guards) */ unused: number; /** usable captures with no teacher reading within the gap */ unpaired: number; coverage: number; lagMs: number }
/** Pair the captures with ONE kind of teacher. `t0Ms` = when the routine started. Frames time `t` = seconds. */
export function pairWith(kind: TeacherKind, caps: readonly Capture[], tracks: { arkit?: TeacherTrack; maxine?: TeacherTrack }, t0Ms: number, r: Routine = ROUTINE, o: PairOpts = {}): Paired {
  const gap = o.maxGapMs ?? 40;
  const track = kind === 'arkit' ? tracks.arkit : kind === 'maxine' ? tracks.maxine : undefined;
  const lagMs = kind === 'arkit' && track ? (o.lagMs ?? o.lag?.lagMs ?? estimateLagMs(caps, track).lagMs) : 0;
  const frames: FaceFrame[] = [];
  let unused = 0, unpaired = 0, usable = 0;
  for (const c of caps) {
    const hit = stepAt(r, (c.tMs - t0Ms) / 1000);
    if (!hit || hit.cut.bucket === 'drop' || (kind === 'prompted' && hit.cut.settle)) { unused++; continue; }
    usable++;
    let T: Float32Array | null;
    if (kind === 'prompted') T = promptedTeacher(c.mp, hit.step.prompt.pins);
    else { const q = track?.nearest(c.tMs + lagMs, gap); T = q ? Float32Array.from(q) : null; }
    if (!T) { unpaired++; continue; }
    frames.push({ t: c.tMs / 1000, eyeL: c.eyeL, eyeR: c.eyeR, mouth: c.mouth, fEyeL: c.fEyeL, fEyeR: c.fEyeR, fMouth: c.fMouth, mp: c.mp, teacher: T, teacherKind: kind });
  }
  return { kind, frames, unused, unpaired, coverage: usable ? frames.length / usable : 0, lagMs };
}
/** Teacher selection at the end of the routine: the best kind (arkit, maxine, prompted) that pairs with >= minCoverage of the usable captures. */
export function chooseTeacher(caps: readonly Capture[], tracks: { arkit?: TeacherTrack; maxine?: TeacherTrack }, t0Ms: number, r: Routine = ROUTINE, o: PairOpts = {}): Paired {
  const need = o.minCoverage ?? 0.6;
  let note = '';
  for (const k of TEACHER_ORDER) {
    if (k === 'arkit' && !tracks.arkit?.length) continue;
    if (k === 'maxine' && !tracks.maxine?.length) continue;
    let lag = o.lag;
    if (k === 'arkit' && o.lagMs === undefined) {
      // the phone's data must line up with the camera: refused BEFORE any training when it does not
      lag = estimateLagMs(caps, tracks.arkit!);
      if (!lag.ok) { note = `Your phone's face data didn't line up with the camera (the best match was ${lag.edge ? 'a shift of more than a second' : 'weak'}), so it was not used.`; continue; }
    }
    const p = pairWith(k, caps, tracks, t0Ms, r, { ...o, lag });
    if (p.coverage >= need || k === 'prompted') return note ? { ...p, note } : p;
  }
  const p = pairWith('prompted', caps, tracks, t0Ms, r, o);
  return note ? { ...p, note } : p;
}

// ---------------------------------------------------------------- the session

export type SessionPhase = 'idle' | 'running' | 'finished' | 'cancelled';
export interface Progress { /** seconds in the whole routine */ total: number; phase: SessionPhase; step: Step | null; index: number; steps: number; /** seconds left in this step */ left: number; /** 0..1 over the whole routine */ progress: number; /** 0..1 inside this step */ stepProgress: number; frames: number }
/** The routine's clock + capture ring + teacher tracks. The caller feeds it; it never touches the camera or the clock. */
export class TeachSession {
  phase: SessionPhase = 'idle';
  t0 = 0;
  readonly ring: CaptureRing;
  readonly tracks = { arkit: new TeacherTrack(), maxine: new TeacherTrack() };
  private lastCapT = -Infinity;
  constructor(readonly routine: Routine = ROUTINE, o: { maxFrames?: number; maxHz?: number } = {}) {
    this.ring = new CaptureRing(o.maxFrames ?? 8000); this.minGap = 1000 / (o.maxHz ?? 32);
  }
  private minGap: number;
  /** Teacher kind the panel announces before the routine (what is available right now). */
  start(nowMs: number) { this.phase = 'running'; this.t0 = nowMs; this.lastCapT = -Infinity; }
  cancel() { this.phase = 'cancelled'; this.ring.clear(); this.tracks.arkit.clear(); this.tracks.maxine.clear(); }
  progress(nowMs: number): Progress {
    const t = (nowMs - this.t0) / 1000, R = this.routine;
    const hit = this.phase === 'running' ? stepAt(R, t) : null;
    return { total: R.total, phase: this.phase, step: hit?.step ?? null, index: hit?.step.index ?? -1, steps: R.steps.length, left: hit ? Math.max(0, hit.step.t1 - t) : 0,
      progress: this.phase === 'finished' ? 1 : Math.max(0, Math.min(1, t / R.total)), stepProgress: hit ? (t - hit.step.t0) / (hit.step.t1 - hit.step.t0) : 0, frames: this.ring.length };
  }
  /** True when the routine's time is up (the caller then calls finish). */
  due(nowMs: number) { return this.phase === 'running' && nowMs - this.t0 >= this.routine.total * 1000; }
  /** One tracked frame (<= ~32 a second; extra ones are ignored). Only inside the routine. */
  capture(c: Capture): boolean {
    if (this.phase !== 'running' || !(c.tMs >= this.t0) || c.tMs - this.lastCapT < this.minGap) return false;
    if (c.tMs - this.t0 >= this.routine.total * 1000) return false;
    this.lastCapT = c.tMs;
    this.ring.push(c);
    return true;
  }
  pushArkit(tMs: number, vals: ArrayLike<number>) { if (this.phase === 'running') this.tracks.arkit.push(tMs, vals); }
  pushMaxine(tMs: number, vals: ArrayLike<number>) { if (this.phase === 'running') this.tracks.maxine.push(tMs, vals); }
  /** End the routine: pair the captures with the best teacher. The ring is cleared afterwards by `release()` once the frames are packed. */
  finish(o: PairOpts = {}): Paired {
    this.phase = 'finished';
    return chooseTeacher(this.ring.items(), this.tracks, this.t0, this.routine, o);
  }
  /** Drop every crop (call once the frames are packed / trained). */
  release() { this.ring.clear(); this.tracks.arkit.clear(); this.tracks.maxine.clear(); }
}

// ---------------------------------------------------------------- packing (to / from the training worker) and the training job

export interface PackedFrames {
  n: number; t: Float64Array; kind: Uint8Array;
  eyeL: Float32Array; eyeR: Float32Array; mouth: Float32Array; fEyeL: Float32Array; fEyeR: Float32Array; fMouth: Float32Array; mp: Float32Array; teacher: Float32Array;
}
const KIND_CODE: Record<TeacherKind, number> = { arkit: 0, maxine: 1, prompted: 2 };
const KINDS: TeacherKind[] = ['arkit', 'maxine', 'prompted'];
/** Frames (all with a teacher) -> a few big typed arrays whose buffers can be TRANSFERRED to the training worker (no copy). */
export function packFrames(frames: readonly FaceFrame[]): PackedFrames {
  const n = frames.length, A = ARKIT.length;
  const p: PackedFrames = { n, t: new Float64Array(n), kind: new Uint8Array(n), eyeL: new Float32Array(n * EYE_W * EYE_H), eyeR: new Float32Array(n * EYE_W * EYE_H), mouth: new Float32Array(n * MOUTH_W * MOUTH_H),
    fEyeL: new Float32Array(n * NF_EYE), fEyeR: new Float32Array(n * NF_EYE), fMouth: new Float32Array(n * NF_MOUTH), mp: new Float32Array(n * A), teacher: new Float32Array(n * A) };
  frames.forEach((f, i) => {
    if (!f.teacher) throw new Error('faceNet: packFrames needs teacher-labelled frames');
    p.t[i] = f.t; p.kind[i] = KIND_CODE[f.teacherKind ?? 'prompted'];
    p.eyeL.set(f.eyeL, i * EYE_W * EYE_H); p.eyeR.set(f.eyeR, i * EYE_W * EYE_H); p.mouth.set(f.mouth, i * MOUTH_W * MOUTH_H);
    p.fEyeL.set(f.fEyeL, i * NF_EYE); p.fEyeR.set(f.fEyeR, i * NF_EYE); p.fMouth.set(f.fMouth, i * NF_MOUTH);
    p.mp.set(f.mp, i * A); p.teacher.set(f.teacher, i * A);
  });
  return p;
}
/** Zero a packed set's crops (a cancelled job that never reached the worker; after a transfer the arrays are detached and this is a no-op). */
export function scrubPacked(p: PackedFrames) { for (const a of [p.eyeL, p.eyeR, p.mouth, p.fEyeL, p.fEyeR, p.fMouth, p.mp, p.teacher]) a.fill(0); }
export function packedBuffers(p: PackedFrames): ArrayBuffer[] { return [p.t, p.kind, p.eyeL, p.eyeR, p.mouth, p.fEyeL, p.fEyeR, p.fMouth, p.mp, p.teacher].map((a) => a.buffer as ArrayBuffer); }
/** The inverse: frames whose arrays are views into the packed buffers (no copy). */
export function unpackFrames(p: PackedFrames): FaceFrame[] {
  const A = ARKIT.length, out: FaceFrame[] = [];
  const sub = (a: Float32Array, i: number, len: number) => a.subarray(i * len, (i + 1) * len);
  for (let i = 0; i < p.n; i++) {
    out.push({ t: p.t[i], eyeL: sub(p.eyeL, i, EYE_W * EYE_H), eyeR: sub(p.eyeR, i, EYE_W * EYE_H), mouth: sub(p.mouth, i, MOUTH_W * MOUTH_H), fEyeL: sub(p.fEyeL, i, NF_EYE), fEyeR: sub(p.fEyeR, i, NF_EYE), fMouth: sub(p.fMouth, i, NF_MOUTH),
      mp: sub(p.mp, i, A), teacher: sub(p.teacher, i, A), teacherKind: KINDS[p.kind[i]] ?? 'prompted' });
  }
  return out;
}

/** What is stored with a model (alongside the weights JSON): when, which teacher, how it did on the judge frames. No faces. */
export interface ModelStats {
  teacher: TeacherKind; frames: { train: number; select: number; judge: number }; epochs: number; ms: number;
  adopted: boolean; reason: string; moving: number; nAdopted: number; meanNetAdopted: number; meanMpAdopted: number;
  /** judge-frame r of every channel the teacher moved on: the net's, MediaPipe's, and whether the net's value is used */
  channels: { name: string; rNet: number; rMp: number; maeNet: number; maeMp: number; used: boolean }[];
}
export interface TeachOutcome { net: FaceNet; json: string; stats: ModelStats; cmp: Comparison; report: TrainReport }
/** The whole training job (runs in the worker; also in Node): train on the routine split, judge, mask. The judge frames are only ever read by judgeFaceNet. */
export function trainTeach(frames: FaceFrame[], t0Sec: number, o: TrainOpts & { adopt?: AdoptOpts; routine?: Routine } = {}): TeachOutcome {
  const tr = trainFaceNet(frames, { ...o, split: routineSplit(o.routine ?? ROUTINE, t0Sec) });
  const cmp = judgeFaceNet(tr.net, tr.judge, o.adopt);
  const channels = cmp.moving.map((k) => ({ name: cmp.net[k].name, rNet: round3(cmp.net[k].r), rMp: round3(cmp.mp[k].r), maeNet: round3(cmp.net[k].mae), maeMp: round3(cmp.mp[k].mae), used: cmp.verdict[k].ok && cmp.adopt }));
  const kinds = frames.map((f) => f.teacherKind).filter((k): k is TeacherKind => !!k);
  const teacher = TEACHER_ORDER.find((k) => kinds.filter((x) => x === k).length > kinds.length / 2) ?? 'prompted';
  const stats: ModelStats = { teacher, frames: { train: tr.report.nTrain, select: tr.report.nSelect, judge: tr.report.nJudge }, epochs: tr.report.epochs, ms: Math.round(tr.report.ms),
    adopted: cmp.adopt, reason: cmp.reason, moving: cmp.moving.length, nAdopted: cmp.nAdopted, meanNetAdopted: round3(cmp.meanNetAdopted), meanMpAdopted: round3(cmp.meanMpAdopted), channels };
  return { net: tr.net, json: serializeFaceNet(tr.net), stats, cmp, report: tr.report };
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const FACENET_CHANNEL_COUNT = FACENET_CHANNELS.length;

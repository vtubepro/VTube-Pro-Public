// "My face model" stage 2: the studio-side controller (docs/FACE_MODEL.md). OPT-IN and OFF by default: until the performer presses
// "Teach my face" and then adopts a model, nothing here asks the tracker for anything (the frame messages carry no `fnet` bit, the
// workers do no extra work, no pixel is read). Pure TS over small interfaces (the tracker host, a trainer worker, the stores), so the
// whole loop runs in Node (tools/facenet_stage2_unit.ts): capture -> pair -> train -> judge -> adopt -> fold in.
// Startup-light: the teach routine, the pairing and the packing (teach.ts, which pulls in the network and the trainer) are loaded with a
// dynamic import the first time Teach is pressed; the training itself runs in a worker. Only the fold-in, the stores and the channel
// list are in the main bundle.
import { ARKIT } from '../../core/arkit.ts';
import type { ExternalTracking } from '../../../shared/types.ts';
import { FaceNetFold, scores52, type Cat } from './fold.ts';
import { FaceModelManager, idbModelStore, localPrefStore, type ModelRecord, type ModelStore, type PrefStore } from './model.ts';
import { FACENET_CHANNELS } from './channels.ts';
import type { FaceNetOut } from './runtime.ts';
import type { Capture, ModelStats, Paired, Progress, TeachSession } from './teach.ts';
import type { TrainJob, TrainMsg } from './trainWorker.ts';
import type { TeacherKind } from './types.ts';

/** The tracker side: where the studio asks the face worker for crops / net values. */
export interface FaceNetHost {
  setFaceNet(c: { model?: string | null; run?: boolean; capture?: boolean }): void;
  /** can the face path that is running supply pixels? (the toggle and the Teach button are disabled with `why` when not) */
  faceNetSupport(): { ok: boolean; engine: 'cpuface' | 'mediapipe' | ''; why: string };
  /** is the net really on the face frames right now (false while the NetGate is paused: probe frames still carry values, which must not be folded)? Absent = assume yes. */
  readonly faceNetRunning?: boolean;
}
/** One training job in a worker (or a stand-in in tests). */
export interface Trainer { start(job: TrainJob, transfer: ArrayBuffer[]): void; onmessage: ((m: TrainMsg) => void) | null; terminate(): void }
export function workerTrainer(): Trainer {
  const w = new Worker(new URL('./trainWorker.ts', import.meta.url), { type: 'module', name: 'vtp-facenet-train' });
  const t: Trainer = { start: (job, tr) => w.postMessage(job, tr), onmessage: null, terminate: () => w.terminate() };
  w.onmessage = (e: MessageEvent<TrainMsg>) => t.onmessage?.(e.data);
  w.onerror = (e) => t.onmessage?.({ type: 'error', message: e.message || 'training worker failed' });
  return t;
}

export interface FaceModelEnv {
  host: FaceNetHost;
  /** observer studios (?observer=1): never teach, never run the net, never write settings */
  observer: boolean;
  trackingOn: () => boolean;
  /** why a heavy job must wait right now ('' = free): Keep-learning-me is learning, the setup test runs, ... */
  busy: () => string;
  /** is Maxine feeding the face right now (the panel says the face model wins its channels when it is) */
  maxineOn: () => boolean;
  now?: () => number;
  store?: ModelStore; prefs?: PrefStore;
  trainer?: () => Trainer;
  /** the Maxine mapped-score recorder (GpuVision.trackMapped) */
  trackMaxine?: (on: boolean) => void;
}
export type Phase = 'idle' | 'teaching' | 'waiting' | 'training' | 'result';
export interface FmState {
  phase: Phase; progress: Progress | null;
  /** best teacher available when the routine started, in plain words */
  teacher: TeacherKind | null; sentence: string;
  train: { epoch: number; epochs: number } | null;
  /** what happened last, one sentence */
  message: string;
  paired: Pick<Paired, 'kind' | 'unpaired' | 'unused' | 'coverage' | 'lagMs' | 'note'> & { frames: number } | null;
}
export const MIN_FRAMES = 300;
/** Sources whose packets are real ARKit blendshapes on the performer's own sides. NOT a phone's browser running MediaPipe (the same kind of
 *  numbers we are trying to beat), 'vmc' or 'vts-api' (relayed, unknown origin). */
const PHONES = new Set(['vts-phone', 'ifacialmocap', 'livelinkface']);
type TeachMod = typeof import('./teach.ts');

export class FaceModel {
  readonly mgr: FaceModelManager;
  readonly fold = new FaceNetFold();
  state: FmState = { phase: 'idle', progress: null, teacher: null, sentence: '', train: null, message: '', paired: null };
  private session: TeachSession | null = null;
  /** the teach module, once loaded (first Teach press) */
  private T: TeachMod | null = null;
  private starting = false;
  private trainer: Trainer | null = null;
  private job: { job: TrainJob; transfer: ArrayBuffer[]; paired: Paired } | null = null;
  /** the scores the net would replace, this frame (after Maxine's mix when Maxine is on) */
  private mp = new Float32Array(ARKIT.length);
  private mask: Uint8Array = new Uint8Array(ARKIT.length);
  private maskFor = '';
  private arkitSeen = -Infinity;
  /** the last net values / share folded in, kept so a revert, a share change to 0 or a gate pause fades out instead of popping */
  private lastVals: Float32Array | null = null;
  private lastShare = 1;
  private lastEmit = 0;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  constructor(private env: FaceModelEnv) {
    this.mgr = new FaceModelManager(env.store ?? idbModelStore(), env.prefs ?? localPrefStore(env.observer));
    this.now = env.now ?? (() => performance.now());
    this.mgr.onChange(() => { this.sync(); this.emit(); });
  }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const f of this.listeners) try { f(); } catch { /* ui */ } }
  private set(p: Partial<FmState>) { this.state = { ...this.state, ...p }; this.emit(); }

  private inited: Promise<void> | null = null;
  /** Open the model store and load the versions (once). The panel calls it when it is built. */
  init(): Promise<void> {
    if (this.env.observer) return Promise.resolve();
    return (this.inited ??= this.mgr.init().then(() => this.sync()));
  }
  /** At studio start: only touches storage when a model was adopted before (settings say so), so a performer who never used the feature has nothing opened. */
  startupInit(): Promise<void> { return this.mgr.prefs.current ? this.init() : Promise.resolve(); }

  /** Can the running face path supply pixels (the panel disables Teach / Use with the reason when not)? */
  support() { return this.env.host.faceNetSupport(); }
  /** Is the camera on? */
  get cameraOn() { return this.env.trackingOn(); }
  get observer() { return this.env.observer; }
  get maxineOn() { return this.env.maxineOn(); }
  /** Is the net being run on the face worker's frames right now (switch on, a version chosen, not an observer)? */
  get running() { return !this.env.observer && this.mgr.prefs.use && !!this.mgr.current && this.mgr.prefs.share > 0; }
  /** Push the current wishes to the tracker (cheap; idempotent). */
  sync() {
    if (this.env.observer) return;
    const rec = this.running ? this.mgr.current : null;
    this.env.host.setFaceNet({ model: rec ? rec.json : null, run: !!rec, capture: this.state.phase === 'teaching' });
    // (a different model keeps the smoothed weight and only relearns the range map; a revert keeps mask + last values so the fold fades out)
    if (rec && this.maskFor !== rec.id) { this.maskFor = rec.id; this.mask = maskOf(rec.json); this.fold.resetRange(); this.lastVals = null; }
    if (!rec && this.maskFor) { this.maskFor = ''; if (!this.fold.fading) this.fold.reset(); }
  }

  // ---------------------------------------------------------------- teachers

  /** A phone's ARKit packet (the studio's bus 'ext' messages, any time): remembered for freshness, recorded during the routine. */
  pushExt(d: ExternalTracking, nowMs = this.now()) {
    if (this.env.observer || !d || !PHONES.has(d.source) || !d.found || !d.blendshapes) return;
    this.arkitSeen = nowMs;
    if (this.session?.phase !== 'running') return;
    const v = new Float32Array(ARKIT.length);
    for (let i = 0; i < ARKIT.length; i++) v[i] = d.blendshapes[ARKIT[i]] ?? 0;
    this.session.pushArkit(nowMs, v);
  }
  availability(nowMs = this.now()) { return { arkit: nowMs - this.arkitSeen < 1000, maxine: this.env.maxineOn() }; }

  // ---------------------------------------------------------------- the per-frame hooks (app tick)

  /**
   * Per tracked frame, AFTER the GPU sidecars' fold-in. The scores at this point are exactly what the net would replace (MediaPipe's own, or
   * Maxine's mix of them when Maxine is on), so they are the judge's baseline: taken for the teach routine's captures together with the
   * frame's crops, and as the pairing for the range map. Maxine's mapped scores are recorded as a teacher; then the net, which wins its
   * channels over Maxine's. `maxine` = GpuVision's mapped array + its frame time. Does nothing (one comparison) unless a routine runs or a model is in use.
   */
  post(raw: { t: number; capture?: number; face: { faceBlendshapes?: { categories: Cat[] }[] } | null; faceNet?: FaceNetOut | null }, maxine?: { t: number; vals: Float32Array } | null): boolean {
    if (this.env.observer) return false;
    const s = this.session, teaching = s?.phase === 'running';
    if (!teaching && !this.running && !this.fold.fading) return false;
    const cats = raw.face?.faceBlendshapes?.[0]?.categories;
    if (!cats?.length) return false;
    scores52(cats, this.mp);
    const cap = raw.faceNet?.cap;
    if (teaching && cap) s!.capture({ tMs: raw.capture ?? raw.t * 1000, eyeL: cap.eyeL, eyeR: cap.eyeR, mouth: cap.mouth, fEyeL: cap.fEyeL, fEyeR: cap.fEyeR, fMouth: cap.fMouth, mp: this.mp.slice() });
    if (teaching && maxine) {
      const v = Float32Array.from(maxine.vals);
      for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) v[i] = this.mp[i];
      s!.pushMaxine(maxine.t, v);
    }
    const vals = raw.faceNet?.vals, nowMs = this.now();
    const live = this.running && this.env.host.faceNetRunning !== false;
    if (live && vals) {
      (this.lastVals ??= new Float32Array(ARKIT.length)).set(vals.length > ARKIT.length ? vals.subarray(0, ARKIT.length) : vals);
      this.lastShare = this.mgr.prefs.share;
      return this.fold.apply(cats, vals, this.mask, this.lastShare, this.mp, { nowMs });
    }
    if (live) return false; // (running, no net values on this frame: as before)
    // not running (reverted, switched off, share 0) or the NetGate is paused (probe frames still carry values: never folded): ease the contribution out
    if (!this.fold.fading || !this.lastVals) { if (!this.running && !this.fold.fading) this.lastVals = null; return false; }
    return this.fold.apply(cats, this.lastVals, this.mask, this.lastShare > 0 ? this.lastShare : 1, this.mp, { nowMs, gain: 0, feed: false });
  }
  /** Every studio tick: the routine's clock (finishes it when due, stops it if the camera went off) and a ~10 Hz progress update. */
  tick(nowMs = this.now()) {
    const s = this.session;
    if (s?.phase === 'running') {
      if (!this.env.trackingOn()) { this.cancel('The camera went off, so the routine stopped. Nothing was kept.'); return; }
      if (s.due(nowMs)) { void this.finishTeach(); return; }
      if (nowMs - this.lastEmit > 100) { this.lastEmit = nowMs; this.set({ progress: s.progress(nowMs) }); }
    } else if (this.state.phase === 'waiting' && this.job && !this.env.busy()) this.startTraining();
  }

  // ---------------------------------------------------------------- teach

  /** Start the guided routine. Refuses (with the reason) in an observer studio, without the camera, while another heavy job runs, or when this face path cannot supply pixels. */
  async startTeach(): Promise<{ ok: boolean; why: string }> {
    if (this.env.observer) return { ok: false, why: 'This is an observer sandbox: it never teaches or runs a face model.' };
    if (this.starting || this.state.phase === 'teaching' || this.state.phase === 'training' || this.state.phase === 'waiting') return { ok: false, why: 'Already running.' };
    if (!this.env.trackingOn()) return { ok: false, why: 'Turn the camera on first (Tracking).' };
    const b = this.env.busy();
    if (b) return { ok: false, why: `Wait until ${b}.` };
    const sup = this.env.host.faceNetSupport();
    if (!sup.ok) return { ok: false, why: sup.why };
    this.starting = true;
    try { this.T ??= await import('./teach.ts'); } catch (e) { return { ok: false, why: `The teaching code could not be loaded (${String((e as Error)?.message ?? e).slice(0, 80)}).` }; } finally { this.starting = false; }
    if (!this.env.trackingOn()) return { ok: false, why: 'Turn the camera on first (Tracking).' };
    const T = this.T, now = this.now(), kind = T.pickTeacher(this.availability(now));
    this.session = new T.TeachSession();
    this.session.start(now);
    this.env.trackMaxine?.(true);
    this.set({ phase: 'teaching', progress: this.session.progress(now), teacher: kind, sentence: T.teacherSentence(kind), train: null, message: '', paired: null });
    this.sync();
    return { ok: true, why: '' };
  }
  /** Stop the routine or the training; nothing is kept and every crop is zeroed. */
  cancel(message = 'Cancelled. Nothing was kept.') {
    this.session?.cancel(); this.session = null;
    this.trainer?.terminate(); this.trainer = null;
    if (this.job) this.T?.scrubPacked(this.job.job.frames); // (a job that never reached the worker still holds the paired crops)
    this.job = null;
    this.env.trackMaxine?.(false);
    this.set({ phase: 'idle', progress: null, train: null, message });
    this.sync();
  }
  private async finishTeach() {
    const s = this.session;
    if (!s) return;
    this.env.trackMaxine?.(false);
    const paired = s.finish();
    this.session = null;
    this.set({ phase: 'idle', progress: null });
    this.sync(); // capture off
    const usable = paired.frames.length;
    if (usable < MIN_FRAMES) {
      s.release();
      this.set({ phase: 'result', message: `${paired.note ? paired.note + ' ' : ''}Only ${usable} frames could be used (the ${paired.kind === 'prompted' ? 'webcam' : paired.kind === 'arkit' ? 'phone' : 'Maxine'} teacher paired with ${Math.round(paired.coverage * 100)} % of them). Make sure the camera sees your whole face and try again; your earlier model is unchanged.`, paired: summary(paired) });
      return;
    }
    const T = this.T!, pk = T.packFrames(paired.frames);
    s.release(); // the ring's crops are zeroed; the packed copy is all that is left (and goes to the worker)
    this.job = { job: { type: 'train', frames: pk, t0Sec: s.t0 / 1000 }, transfer: T.packedBuffers(pk), paired };
    this.set({ phase: 'waiting', paired: summary(paired), message: `${paired.note ? paired.note + ' ' : ''}Got ${usable} frames. Teacher: ${paired.kind === 'arkit' ? 'your phone' : paired.kind === 'maxine' ? 'NVIDIA Maxine' : 'the prompts'}.` });
    if (!this.env.busy()) this.startTraining();
    else this.set({ message: `Got ${usable} frames. Training starts when ${this.env.busy()} is done.` });
  }
  private startTraining() {
    const j = this.job;
    if (!j) return;
    this.job = null;
    const t = (this.env.trainer ?? workerTrainer)();
    this.trainer = t;
    this.set({ phase: 'training', train: { epoch: 0, epochs: 24 }, message: 'Training on this PC (about a minute). Nothing is uploaded.' });
    t.onmessage = (m) => {
      if (this.trainer !== t) return;
      if (m.type === 'progress') this.set({ train: { epoch: m.epoch, epochs: m.epochs } });
      else { this.trainer = null; t.terminate(); void this.trained(m, j.paired); }
    };
    t.start(j.job, j.transfer);
  }
  private async trained(m: TrainMsg, paired: Paired) {
    if (m.type !== 'done') { this.mgr.last = { at: new Date().toISOString(), adopted: false, why: m.type === 'error' ? m.message : 'training failed', stats: null }; this.set({ phase: 'result', train: null, message: `Training failed (${m.type === 'error' ? m.message : 'unknown'}). Your earlier model is unchanged.` }); return; }
    const at = new Date().toISOString(), rec: ModelRecord = { id: at, at, json: m.json, stats: m.stats };
    const adopted = await this.mgr.finishTeach(rec, m.stats, m.stats.reason);
    const phone = paired.kind === 'prompted' ? ' A phone with face tracking would make it much better.' : '';
    const note = paired.note ? paired.note + ' ' : '';
    this.set({ phase: 'result', train: null, message: note + (adopted
      ? `Adopted: the model beat the webcam's own tracking on ${m.stats.nAdopted} of ${m.stats.moving} channels it was checked on (frames it never saw). It is on now; the other channels stay as they were.`
      : `Not adopted: ${m.stats.reason}. Your earlier settings are unchanged.${phone}`) });
  }
  /** Delete everything: every version, the pointer, the switch. */
  async deleteAll() {
    this.cancel('');
    await this.mgr.deleteAll();
    this.fold.reset(); this.lastVals = null;
    this.set({ phase: 'idle', message: 'Deleted.' });
  }
}

const summary = (p: Paired) => ({ kind: p.kind, frames: p.frames.length, unpaired: p.unpaired, unused: p.unused, coverage: p.coverage, lagMs: p.lagMs, note: p.note });
/** The 52-entry channel mask stored in a model's JSON (absent = every covered channel). */
export function maskOf(json: string): Uint8Array {
  const m = new Uint8Array(ARKIT.length);
  try {
    const o = JSON.parse(json) as { mask?: number[] };
    if (Array.isArray(o.mask) && o.mask.length === ARKIT.length) o.mask.forEach((v, i) => { m[i] = v ? 1 : 0; });
    else for (const c of FACENET_CHANNELS) m[c] = 1;
  } catch { /* unusable model: nothing adopted */ }
  return m;
}
export type { ModelStats };

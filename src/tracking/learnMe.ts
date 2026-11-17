// "Keep learning me" (opt-in, OFF by default): VTube Pro slowly learns how THIS performer talks and moves, from their
// own tracked sessions, and applies it to every avatar. Stays on this PC.
//
//   collect  learnMeData.ts: compact feature frames (no video, no audio) while tracking well, into IndexedDB with a
//            size cap (default 200 MB, oldest rotate out). Pause / resume, "Delete everything".
//   learn    learnMeFit.ts in a Web Worker, after the session (when tracking stops) or on demand — never while the
//            camera is tracking (a demand then waits for the camera to stop). Every area is gated on held-out time.
//   apply    lip → the voice → mouth style (speechFusion); habits + motion → the camera-lost / voice-only face
//            (voiceLife.ts personalLife). A strength slider per area; the last 3 versions are kept for one-click revert.
// Settings + versions live in localStorage 'vtp.learnMe' (small; travels with the speaking-profile file).
import { F, LM_F, LM_VERSION, VISEME_ORDER, ARKIT_INDEX, lmStore, quantize, spanSeconds, type LmChunk } from './learnMeData.ts';
import { effectiveStyle, type LearnResult, type LearnedModel } from './learnMeFit.ts';
import { personalLife } from '../avatar/voiceLife.ts';
import { DEFAULT_STYLE, type VowelStyle } from './speakingProfile.ts';
import type { AudioMouth } from './audioFeatures.ts';

export const LEARNME_KEY = 'vtp.learnMe';
export interface LearnVersion { id: string; at: string; model: LearnedModel; reports: LearnResult['reports']; seconds: LearnResult['seconds'] }
export interface LearnMeState {
  v: 1;
  on: boolean; paused: boolean; capMB: number;
  strength: { lip: number; habits: number; motion: number };
  /** newest last; at most 3 */
  versions: LearnVersion[];
  /** id of the version in use; null = standard (nothing learned / reverted) */
  current: string | null;
  /** the latest learning pass, adopted or not (the "what improved" card) */
  last: { at: string; changed: boolean; reports: LearnResult['reports']; seconds: LearnResult['seconds']; error?: string } | null;
  log: { at: string; msg: string }[];
}
const DEFAULT_STATE: LearnMeState = { v: 1, on: false, paused: false, capMB: 200, strength: { lip: 1, habits: 1, motion: 1 }, versions: [], current: null, last: null, log: [] };

export interface CollectInput {
  t: number; tracked: boolean; quality: number; eyesBoth: boolean;
  mouth: { open: number; wide: number; funnel: number; pucker: number };
  /** mouth visibility (face._mouthVis, mouthVisibility.ts): a mic / hand in front of the lips → the camera mouth is
   *  MediaPipe's guess of a closed mouth */
  mouthSeen?: number;
  raw: Record<string, number>; head: ArrayLike<number>; headPos: ArrayLike<number>; gaze: ArrayLike<number>;
  torso?: ArrayLike<number> | null; arms?: { left: { upper: { x: number; y: number; z: number }; lower: { x: number; y: number; z: number } } | null; right: { upper: { x: number; y: number; z: number }; lower: { x: number; y: number; z: number } } | null } | null;
}

export class LearnMe {
  state: LearnMeState = load();
  /** seconds stored (updated after flushes / deletes) */
  stored = { bytes: 0, seconds: 0, chunks: 0 };
  learning = false;
  /** a learning pass was asked for while the camera was tracking: run it when tracking stops */
  pending = false;
  private session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  private voiceRing: { t: number; v: AudioMouth }[] = [];
  private run: { t: number[]; x: Float32Array[] } = { t: [], x: [] };
  private chunk: { t: number[]; q: Uint16Array[] } = { t: [], q: [] };
  private lastT = -1;
  private listeners = new Set<() => void>();
  constructor(public observer = false) { this.applyCurrent(); void this.refreshStats(); }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const f of this.listeners) try { f(); } catch { /* ui */ } }
  save() { if (!this.observer) try { localStorage.setItem(LEARNME_KEY, JSON.stringify(this.state)); } catch { /* storage off */ } this.emit(); }
  private logMsg(msg: string) { this.state.log = [...this.state.log, { at: new Date().toISOString(), msg }].slice(-30); }

  get collecting() { return this.state.on && !this.state.paused && !this.observer; }
  setOn(on: boolean) { this.state.on = on; if (!on) void this.flush(true); this.save(); }
  setPaused(p: boolean) { this.state.paused = p; if (p) void this.flush(true); this.save(); }
  setStrength(area: 'lip' | 'habits' | 'motion', v: number) { this.state.strength[area] = Math.max(0, Math.min(1, v)); this.applyCurrent(); this.save(); }

  // ---------------- collect ----------------

  /** Every tick with the mic on: remember the voice frame by the instant it describes (the camera is ~50 ms late). */
  pushVoice(t: number, v: AudioMouth) {
    if (!this.collecting) return;
    this.voiceRing.push({ t, v });
    if (this.voiceRing.length > 40) this.voiceRing.shift();
  }
  /** Every new camera result (the performer's OWN tracking only — never called for party guests or observers). The
   *  voice for that instant may not exist yet (lip-sync lookahead): samples wait up to 0.3 s for it. */
  collect(c: CollectInput) {
    if (!this.collecting) return;
    this.pendingCam.push(c);
    const vt = this.voiceRing.length ? this.voiceRing[this.voiceRing.length - 1].t : -Infinity;
    while (this.pendingCam.length && (this.pendingCam[0].t <= vt || c.t - this.pendingCam[0].t > 0.3)) this.collectNow(this.pendingCam.shift()!);
  }
  private pendingCam: CollectInput[] = [];
  private collectNow(c: CollectInput) {
    if (c.t - this.lastT < 1 / 32 && c.t >= this.lastT) return; // ≤ 30 Hz
    this.lastT = c.t;
    // trust gate: face well tracked (adaptive quality at full / near-full), both eyes; otherwise end the run
    if (!c.tracked || c.quality > 1 || !c.eyesBoth) { this.endRun(); return; }
    const x = new Float32Array(LM_F);
    const v = this.nearestVoice(c.t);
    if (v) {
      x[F.level] = v.level; x[F.voiced] = v.voiced ? 1 : 0; x[F.closure] = v.closure; x[F.pitch] = v.pitch ?? 0; x[F.hasVoice] = 1;
      (['A', 'E', 'I', 'O', 'U'] as const).forEach((k, j) => { x[F.vowels + j] = v.vowels[k] ?? 0; });
      if (v.visemes) VISEME_ORDER.forEach((k, j) => { x[F.visemes + j] = v.visemes![k] ?? 0; });
    }
    x[F.camOpen] = c.mouth.open; x[F.camWide] = c.mouth.wide; x[F.camRound] = c.mouth.funnel; x[F.camPucker] = c.mouth.pucker;
    for (const [k, i] of ARKIT_INDEX) x[i] = c.raw[k] ?? 0;
    for (let i = 0; i < 3; i++) { x[F.head + i] = c.head[i] ?? 0; x[F.headPos + i] = c.headPos[i] ?? 0; }
    x[F.gaze] = c.gaze[0] ?? 0; x[F.gaze + 1] = c.gaze[1] ?? 0;
    if (c.torso) for (let i = 0; i < 3; i++) x[F.torso + i] = c.torso[i] ?? 0;
    const arms = c.arms;
    if (arms) [arms.left?.upper, arms.left?.lower, arms.right?.upper, arms.right?.lower].forEach((d, j) => { if (d) { x[F.arms + j * 3] = d.x; x[F.arms + j * 3 + 1] = d.y; x[F.arms + j * 3 + 2] = d.z; } });
    x[F.hasBody] = c.torso || arms?.left || arms?.right ? 1 : 0;
    // (a hidden mouth's frame is stored with quality + 2: the lip fit never learns "talks without opening" from a mouth
    // behind a mic, the habits / motion fits still use the frame)
    x[F.quality] = c.quality + ((c.mouthSeen ?? 1) < 0.5 ? 2 : 0); x[F.eyesBoth] = c.eyesBoth ? 1 : 0;
    // a gap (dropped frames, a hitch) ends the run
    const rt = this.run.t;
    if (rt.length && (c.t - rt[rt.length - 1] > 0.25 || c.t < rt[rt.length - 1])) this.endRun();
    this.run.t.push(c.t); this.run.x.push(x);
    if (this.run.t.length >= 30 * 20) this.endRun(); // keep runs bounded (20 s)
  }
  private nearestVoice(t: number): AudioMouth | null {
    let best: { t: number; v: AudioMouth } | null = null;
    for (const r of this.voiceRing) if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
    return best && Math.abs(best.t - t) < 0.05 ? best.v : null;
  }
  /** A run of good frames is kept only if it lasted ≥ 2 s (short flickers of tracking are noise). */
  private endRun() {
    const r = this.run;
    this.run = { t: [], x: [] };
    if (r.t.length < 2 || r.t[r.t.length - 1] - r.t[0] < 2) return;
    for (let i = 0; i < r.t.length; i++) { const q = new Uint16Array(LM_F); quantize(r.x[i], q, 0); this.chunk.t.push(r.t[i]); this.chunk.q.push(q); }
    if (this.chunk.t.length >= 30 * 60) void this.flush(false);
  }
  /** Write the pending chunk (and rotate the store under its cap). */
  async flush(endRun: boolean) {
    if (endRun) { for (const c of this.pendingCam.splice(0)) this.collectNow(c); this.endRun(); }
    const c = this.chunk;
    if (!c.t.length) return;
    this.chunk = { t: [], q: [] };
    const q = new Uint16Array(c.q.length * LM_F);
    c.q.forEach((row, i) => q.set(row, i * LM_F));
    const rec: LmChunk = { v: LM_VERSION, session: this.session, at: Date.now(), n: c.t.length, t: Float32Array.from(c.t), q };
    await lmStore.add(rec);
    await lmStore.rotate(this.state.capMB * 1024 * 1024);
    await this.refreshStats();
  }
  async refreshStats() { this.stored = await lmStore.stats(); this.emit(); }
  /** Minutes learned including what is still in memory. */
  get minutes() { return (this.stored.seconds + spanSeconds({ t: Float32Array.from(this.chunk.t), n: this.chunk.t.length })) / 60; }
  async deleteEverything() {
    this.run = { t: [], x: [] }; this.chunk = { t: [], q: [] }; this.voiceRing = [];
    await lmStore.clear();
    this.state = { ...DEFAULT_STATE, on: this.state.on, paused: this.state.paused, capMB: this.state.capMB, log: [{ at: new Date().toISOString(), msg: 'deleted everything' }] };
    this.applyCurrent(); this.save();
    await this.refreshStats();
  }

  // ---------------- learn ----------------

  /** Ask for a learning pass. While the camera tracks it waits (returns 'queued') so the live fps is never touched. */
  requestLearn(trackingOn: boolean, baseStyle: VowelStyle, enunciation: number): 'queued' | 'started' | 'busy' {
    if (this.learning) return 'busy';
    if (trackingOn) { this.pending = true; this.emit(); return 'queued'; }
    void this.learnNow(baseStyle, enunciation);
    return 'started';
  }
  /** Tracking stopped: flush, and learn if asked for (or automatically after a session with new data). */
  onTrackingStopped(baseStyle: VowelStyle, enunciation: number) {
    const auto = this.state.on; // every collecting session gets a pass afterwards
    void this.flush(true).then(() => { if ((this.pending || auto) && this.stored.seconds > 60 && !this.learning) void this.learnNow(baseStyle, enunciation); });
  }
  private async learnNow(baseStyle: VowelStyle, enunciation: number) {
    if (this.observer) return;
    this.learning = true; this.pending = false; this.emit();
    try {
      await this.flush(true);
      const res = await runWorker({ current: this.currentModel(), baseStyle, enunciation });
      const at = res.at;
      this.state.last = { at, changed: res.changed, reports: res.reports, seconds: res.seconds };
      if (res.changed) {
        const v: LearnVersion = { id: at, at, model: res.model, reports: res.reports, seconds: res.seconds };
        this.state.versions = [...this.state.versions, v].slice(-3);
        this.state.current = v.id;
        this.logMsg(`new version: ${res.reports.filter((r) => r.adopted).map((r) => r.area).join(', ') || 'dropped areas that stopped helping'}`);
      } else this.logMsg('kept the current version: ' + res.reports.map((r) => r.why ?? r.line).join(' | '));
      this.applyCurrent();
    } catch (e) {
      this.state.last = { at: new Date().toISOString(), changed: false, reports: [], seconds: { train: 0, heldOut: 0 }, error: (e as Error).message };
      this.logMsg('learning failed: ' + (e as Error).message);
    } finally { this.learning = false; this.save(); }
  }

  // ---------------- apply / versions ----------------

  currentModel(): LearnedModel | null { return this.state.versions.find((v) => v.id === this.state.current)?.model ?? null; }
  revertTo(id: string | null) { this.state.current = id && this.state.versions.some((v) => v.id === id) ? id : null; this.logMsg(`reverted to ${id ?? 'standard'}`); this.applyCurrent(); this.save(); }
  /** The voice → mouth style to use, on top of the speaking profile's (or the default). */
  styleFor(base: VowelStyle | null | undefined): VowelStyle {
    return effectiveStyle(base ?? DEFAULT_STYLE, this.currentModel()?.lip ?? null, this.state.strength.lip);
  }
  /** Push habits + motion into the camera-lost / voice-only face (every avatar's VoiceLife). */
  applyCurrent() {
    const m = this.currentModel(), s = this.state.strength;
    const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));
    const hab = m?.habits && s.habits > 0 ? { blinkIdleS: lerp(3.5, m.habits.blinkIdleS, s.habits), blinkTalkS: lerp(3.2, m.habits.blinkTalkS, s.habits) } : {};
    const mot = m?.motion && s.motion > 0 ? { mul: { sway: lerp(1, m.motion.sway, s.motion), nod: lerp(1, m.motion.nod, s.motion), tilt: lerp(1, m.motion.tilt, s.motion), turn: lerp(1, m.motion.turn, s.motion) } } : {};
    personalLife.current = Object.keys(hab).length || Object.keys(mot).length ? { ...hab, ...mot } : null;
    this.onApply?.();
  }
  /** set by the app: re-apply the lip style after a change */
  onApply: (() => void) | null = null;
}

function load(): LearnMeState {
  try { const s = globalThis.localStorage?.getItem(LEARNME_KEY); const p = s ? JSON.parse(s) as LearnMeState : null; if (p && p.v === 1) return { ...DEFAULT_STATE, ...p, strength: { ...DEFAULT_STATE.strength, ...p.strength } }; } catch { /* storage off */ }
  return { ...DEFAULT_STATE, strength: { ...DEFAULT_STATE.strength } };
}

/** Learning runs in a module Worker (its own thread; it reads the chunks from IndexedDB itself). */
function runWorker(msg: { current: LearnedModel | null; baseStyle: VowelStyle; enunciation: number }): Promise<LearnResult> {
  return new Promise((res, rej) => {
    const w = new Worker(new URL('./learnMeWorker.ts', import.meta.url), { type: 'module' });
    const to = setTimeout(() => { w.terminate(); rej(new Error('learning took too long (5 min)')); }, 5 * 60 * 1000);
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: LearnResult; error?: string }>) => { clearTimeout(to); w.terminate(); if (e.data.ok && e.data.result) res(e.data.result); else rej(new Error(e.data.error ?? 'learning failed')); };
    w.onerror = (e) => { clearTimeout(to); w.terminate(); rej(new Error(e.message || 'worker error')); };
    w.postMessage(msg);
  });
}

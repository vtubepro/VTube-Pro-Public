// OBS output frame sync: turns the studio's frame stream (≈61 Hz, jittery arrival) into what the avatar runtime
// should see at each OBS render (30 / 60 fps, any phase), so the OBS mouth / blinks / head match the studio
// preview frame for frame.
//
// Per channel:
//   mouth / visemes / lips / face (incl. blinks) — NOT smoothed here. Every frame the studio sent is integrated
//     by the runtime (viseme rig attack/release, jaw spring, physics) at the studio's own timing: frames that
//     arrived since the last render are replayed as sub-steps before the displayed one. At 30 fps OBS the
//     runtime therefore still sees all 61 frames/s, like the studio's own runtime does.
//   blinks — peak-held across the frames a render coalesces (a 1-2 frame lid closure can't fall between two
//     30 fps renders).
//   head / headPos — extrapolated along the studio's headVel / posVel by the frame's age (the studio does the
//     same for its own preview between tracker results).
//   bones (the studio's final retargeted pose) — extrapolated by the bone's angular velocity between the last
//     two frames (sender-timestamped only, clamped), so motion is continuous at any render phase.
//
// Timing: the studio stamps each frame with its send time (`ts`, epoch ms) and a sequence number; both pages
// are on the same PC, so `ts - performance.timeOrigin` is the send time on this page's clock. The frame is
// taken to be valid from send + the best (minimum) transport latency seen recently — arrival jitter no longer
// shifts it. Frames without `ts` (older studios, relayed party guests) fall back to their arrival time.
import * as THREE from 'three';
import type { TrackingFrame } from '../shared/types.ts';

type Bones = NonNullable<TrackingFrame['bones']>;
type Quat4 = [number, number, number, number];

export interface SyncStep { frame: TrackingFrame; dt: number; bones?: Bones }

interface Pending { f: TrackingFrame; at: number; sent: number | null }

/** Longest extrapolation (s): about one studio frame + jitter; past that the stream has stalled — hold. */
const MAX_LEAD = 0.03;
/** Most sub-steps replayed per render (older extras are merged into the next one). */
const MAX_SUBSTEPS = 4;
/** Shortest sub-step worth a runtime update (s); shorter ones merge into the next step. */
const MIN_SUBSTEP = 0.002;
/** Angular speed cap for bone extrapolation (rad/s): faster is noise / a pose snap, don't fling it. */
const MAX_ANG = 8;

/** Frame fields `display` computes itself (not copied). */
const OWN = new Set(['face', 'head', 'headPos', 'bones']);
/** Copy every other top-level field of `f` onto the reused display frame `s` (and drop ones `f` no longer has). */
export function copyShallow(s: TrackingFrame, f: TrackingFrame) {
  const S = s as unknown as Record<string, unknown>, F = f as unknown as Record<string, unknown>;
  for (const k in S) if (!OWN.has(k) && !(k in F)) delete S[k];
  for (const k in F) if (!OWN.has(k)) S[k] = F[k];
}

/** Tunables (the parity harness sweeps these). */
export const syncTuning = { boneGain: 1, boneSpanMin: 0.006, boneSpanMax: 0.08, blinkHold: 2, headLead: 1, boneAuto: 1, lead: 1, studioHold: 0.0082 };

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _ax = new THREE.Vector3();

export class FrameSync {
  /** Frame the runtime is currently holding (integrated up to simT). */
  private cur: Pending | null = null;
  /** Recently displayed frames (newest last, excluding cur): bone velocity reference. */
  private hist: Pending[] = [];
  private lastBlink = 0;
  /** Smoothed render period (s): OBS source fps. */
  private period = 1 / 60;
  private queue: Pending[] = [];
  private simT = -1;
  private shown: TrackingFrame | null = null;
  private shownBones: Bones = {};
  /** min(arrival - send) over the recent window (ms): the clean transport latency. */
  private minLat = Infinity;
  private minLatAt = 0;
  private lastSeq = -1;
  readonly stats = { received: 0, dropped: 0, coalesced: 0, substeps: 0, renders: 0, latSum: 0, latN: 0, latMax: 0, lastLat: NaN };

  /** A frame from the bus. `ts` = studio send time (epoch ms), `seq` = its sequence number. */
  push(f: TrackingFrame, now: number, ts?: number, seq?: number) {
    this.stats.received++;
    if (typeof seq === 'number') {
      if (this.lastSeq >= 0 && seq > this.lastSeq + 1 && seq - this.lastSeq < 1000) this.stats.dropped += seq - this.lastSeq - 1;
      this.lastSeq = seq;
    }
    let sent: number | null = null;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      const s = ts - performance.timeOrigin;
      const lat = now - s;
      if (lat > -50 && lat < 1000) { // same PC clock: anything else is a different machine / clock step → ignore
        sent = s;
        this.stats.lastLat = lat;
        this.stats.latSum += lat; this.stats.latN++; this.stats.latMax = Math.max(this.stats.latMax, lat);
        // min-filter with slow forgetting (clock slews, a changed transport path)
        if (lat < this.minLat || now - this.minLatAt > 3000) { this.minLat = lat; this.minLatAt = now; }
      }
    }
    const at = sent !== null ? Math.min(now, sent + Math.max(0, this.minLat)) : now;
    this.queue.push({ f, at, sent });
    if (this.queue.length > 32) this.queue.splice(0, this.queue.length - 32);
  }

  get latest(): TrackingFrame | null { return this.queue.at(-1)?.f ?? this.cur?.f ?? null; }

  /**
   * The runtime updates to run for a render at `now` (ms), oldest first; `step` = the render's dt (s). The last
   * step is the displayed state. Returns [] until the first frame arrives.
   */
  steps(now: number, step: number): SyncStep[] {
    this.stats.renders++;
    const out: SyncStep[] = [];
    if (step > 0.004 && step < 0.1) this.period += (step - this.period) * 0.05;
    // integrate to `target`: `lead` ahead of now shifts a slow render's hold interval to centre on the studio's
    const lead = syncTuning.lead * Math.max(0, this.period / 2 - syncTuning.studioHold) * 1000;
    const target = now + lead;
    if (this.simT < 0) this.simT = target - step * 1000;
    const fresh = this.queue;
    this.queue = [];
    if (!this.cur && !fresh.length) return out;
    // peak-held blinks over every frame this render covers (only matters when it covers several)
    let blink: [number, number] | null = null;
    if (fresh.length > 1) {
      this.stats.coalesced += fresh.length - 1;
      blink = [0, 0];
      for (const p of fresh) { blink[0] = Math.max(blink[0], p.f.face.eyeBlinkLeft ?? 0); blink[1] = Math.max(blink[1], p.f.face.eyeBlinkRight ?? 0); }
    }
    // replay: the held frame runs until the next one took over (sub-step), then the next …
    let carry = 0;
    for (const p of fresh) {
      if (!this.cur) { this.cur = p; this.simT = Math.max(this.simT, Math.min(now, p.at)); continue; }
      const until = Math.max(this.simT, Math.min(p.at, target));
      const seg = (until - this.simT) / 1000 + carry;
      if (seg >= MIN_SUBSTEP && out.length < MAX_SUBSTEPS) { out.push({ frame: this.cur.f, dt: seg, bones: this.cur.f.bones }); carry = 0; }
      else carry = seg;
      this.simT = until;
      this.hist.push(this.cur);
      if (this.hist.length > 6) this.hist.shift();
      this.cur = p;
    }
    const cur = this.cur!;
    const dtFinal = Math.max(0, (target - this.simT) / 1000) + carry;
    this.simT = Math.max(this.simT, target);
    this.stats.substeps += out.length;
    const shown = this.display(cur, now, blink);
    out.push({ frame: shown, dt: dtFinal, bones: shown.bones });
    // runtime smoothers need a positive total dt matching the render step
    if (out.length > 1) {
      let sum = 0;
      for (const s of out) sum += s.dt;
      if (sum < 1e-4) out.splice(0, out.length - 1);
    }
    if (out[out.length - 1].dt <= 0) out[out.length - 1].dt = 1e-4;
    return out;
  }

  /** Displayed frame: `cur` with head / bones carried forward by its age, blinks peak-held. Reuses one object. */
  private display(cur: Pending, now: number, blink: [number, number] | null): TrackingFrame {
    const f = cur.f;
    const age = Math.min(MAX_LEAD, Math.max(0, (now - cur.at) / 1000));
    const s = (this.shown ??= { ...f, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], face: {} });
    // shallow channels: exactly the studio's values
    // shallow channels: exactly the studio's values — EVERY field, not a fixed list (a fixed list once froze
    // `emote` / `life` at whatever the first frame had: OBS then never played emotes and ran its own face life)
    copyShallow(s, f);
    const bl = f.face.eyeBlinkLeft ?? 0, br = f.face.eyeBlinkRight ?? 0;
    const T = syncTuning.blinkHold;
    // blinkHold 1: always peak-hold coalesced frames; 2: only when the closure would otherwise never be on screen
    const miss = (m: number, c: number) => m > 0.6 && c < 0.5 * m && this.lastBlink < 0.5 * m;
    if (blink && T && (T === 1 ? blink[0] > bl + 1e-3 || blink[1] > br + 1e-3 : miss(blink[0], bl) || miss(blink[1], br))) {
      s.face = { ...f.face, eyeBlinkLeft: Math.max(bl, blink[0]), eyeBlinkRight: Math.max(br, blink[1]) };
    } else s.face = f.face;
    this.lastBlink = Math.max(s.face.eyeBlinkLeft ?? 0, s.face.eyeBlinkRight ?? 0);
    // (a starved face — sparse, late results: src/tracking/stallLife.ts — has no velocity worth carrying forward)
    const live = f.tracked && !((f.starve ?? 0) > 0.3);
    const hv = live ? f.headVel : undefined, pv = live ? f.posVel : undefined;
    for (let i = 0; i < 3; i++) {
      s.head[i] = f.head[i] + (hv ? hv[i] * age * syncTuning.headLead : 0);
      s.headPos[i] = f.headPos[i] + (pv ? pv[i] * age * syncTuning.headLead : 0);
    }
    // bones: angular velocity from a recent SENDER-timestamped frame at least boneSpanMin older
    const b = f.bones;
    if (!b) { s.bones = undefined; return s; }
    let span = 0, pb: Bones | undefined;
    // at ~60 fps the newest pose is already on screen within a frame and extrapolating only adds noise; below
    // ~40 fps a pose is held twice as long as the studio's and carrying it forward wins (parity harness)
    const gain = syncTuning.boneGain * (syncTuning.boneAuto ? Math.min(1, Math.max(0, (this.period - 0.02) / 0.01)) : 1);
    if (gain > 0 && f.tracked && cur.sent !== null) {
      for (let i = this.hist.length - 1; i >= 0; i--) {
        const h = this.hist[i];
        if (h.sent === null) break;
        const sp = (cur.sent - h.sent) / 1000;
        if (sp > syncTuning.boneSpanMax) break;
        if (sp >= syncTuning.boneSpanMin) { span = sp; pb = h.f.bones; break; }
      }
    }
    const outB = this.shownBones;
    for (const k in outB) if (!(k in b)) delete outB[k];
    for (const k in b) {
      const q = b[k];
      const o = (outB[k] ??= [0, 0, 0, 1] as Quat4);
      const q0 = pb?.[k];
      if (!q0 || age < 1e-4) { o[0] = q[0]; o[1] = q[1]; o[2] = q[2]; o[3] = q[3]; continue; }
      // delta = q · q0⁻¹ (world-free: local rotation per second), scaled by age / span, applied before q
      _qa.fromArray(q); _qb.fromArray(q0).invert();
      _qd.multiplyQuaternions(_qa, _qb);
      if (_qd.w < 0) { _qd.x = -_qd.x; _qd.y = -_qd.y; _qd.z = -_qd.z; _qd.w = -_qd.w; }
      const ang = 2 * Math.acos(Math.min(1, _qd.w));
      if (ang < 1e-5 || ang / span > MAX_ANG) { o[0] = q[0]; o[1] = q[1]; o[2] = q[2]; o[3] = q[3]; continue; }
      _ax.set(_qd.x, _qd.y, _qd.z).normalize();
      _qd.setFromAxisAngle(_ax, ang * (age / span) * gain);
      _qa.premultiply(_qd).normalize();
      o[0] = _qa.x; o[1] = _qa.y; o[2] = _qa.z; o[3] = _qa.w;
    }
    s.bones = outB;
    return s;
  }

  /** Mean / max bus latency (ms) since the last call, and resets the window. */
  takeLatency(): { mean: number; max: number; min: number } {
    const r = { mean: this.stats.latN ? this.stats.latSum / this.stats.latN : NaN, max: this.stats.latN ? this.stats.latMax : NaN, min: this.minLat };
    this.stats.latSum = 0; this.stats.latN = 0; this.stats.latMax = 0;
    return r;
  }
}

/**
 * OBS page fps cap. The remainder is carried (like the studio's send gate) — a strict reset-to-0 gate dropped every
 * rAF that came a fraction of a ms early at 60 Hz (a 33 ms hitch every few frames under OBS's own frame jitter).
 */
export class FpsGate {
  private acc = 0;
  private since = 0;
  constructor(public maxFps: number) {}
  reset() { this.acc = 0; this.since = 0; }
  /** `dt` (s) since the previous rAF → this render's step (s), or 0 = skip this rAF. */
  tick(dt: number): number {
    this.acc += dt; this.since += dt;
    const gate = 1 / (this.maxFps + 1);
    if (this.acc < gate) return 0;
    this.acc = Math.min(this.acc - gate, gate);
    const step = Math.min(0.1, this.since); this.since = 0;
    return step;
  }
}

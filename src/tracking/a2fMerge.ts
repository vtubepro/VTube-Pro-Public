// GPU lip sync: NVIDIA Audio2Face-3D (tools/gpu/a2f_sidecar.py) as a voice -> mouth source. docs/GPU_TRACKING.md
//
// The sidecar hears the studio's 16 kHz mic stream and returns 52 ARKit blendshapes per frame (its network sees a
// 0.52 s window centred on the frame; the part it can't have heard yet is mirrored, so each frame is ready `futureMs`
// + ~6 ms after its instant). This module keeps those frames by content time (the same clock as the lookahead-delayed
// voice frame), picks / interpolates the one for the instant being shown, scales Claire's realistic motion to read on
// stylised avatars, and hands the mouth channels to the viseme rig as `frame.a2f` — the rig blends them into what it
// drives on every kind of face (perfect-sync ARKit shapes directly; procedural / VRM-preset / jaw-bone faces through its
// articulators: F/V lip tuck, M/B/P seal, rounding, spreading, jaw).
//
// Never the only source: the camera keeps the expressions, the rule engine + neural visemes keep the categorical
// seals / tucks (the rig takes the max), and the voice gate decides what is speech — A2F only acts while the engine
// hears the performer (it also moves on keyboard clicks, which the gate rejects).
import type { TrackingFrame } from '../../shared/types.ts';

export const A2F_KEY = 'vtp.a2f';
export interface A2fSettings {
  on: boolean;
  /** 0..1: how much of the mouth shape comes from Audio2Face (the rest: rule engine + neural visemes). Default 0.75 */
  mix: number;
  /** sidecar websocket (default ws://127.0.0.1:5197/a2f) */
  url?: string;
  /** size of the A2F motion on the avatar (1 = the calibrated anime scale; Claire's own realistic scale ≈ 0.35) */
  gain?: number;
  /** the user turned GPU lip sync off themselves: the studio never switches it on again by itself (src/tracking/lipEngine.ts) */
  optOut?: boolean;
  /** it is on because the studio chose it (an RTX 50-series card with the files installed), not the user */
  autoPicked?: boolean;
}
export const DEFAULT_A2F: A2fSettings = { on: false, mix: 0.75, gain: 1 };
export function loadA2f(): A2fSettings {
  try {
    const s = globalThis.localStorage?.getItem(A2F_KEY);
    if (s) {
      const v = { ...DEFAULT_A2F, ...JSON.parse(s) } as A2fSettings;
      // saved before the studio could pick by itself (no optOut / autoPicked fields): an "off" in there was the user's choice
      if (!v.on && v.optOut === undefined && v.autoPicked === undefined) v.optOut = true;
      return v;
    }
  } catch { /* storage off */ }
  return { ...DEFAULT_A2F };
}
export function saveA2f(s: A2fSettings) { try { globalThis.localStorage?.setItem(A2F_KEY, JSON.stringify(s)); } catch { /* storage off */ } }

/**
 * How much future audio each frame waits for, for a lip-sync lookahead of D ms: the frame must be on screen D ms
 * after its sound, i.e. arrive within D − (worklet 19 ms + socket/net ~8 ms + a margin). Measured on the test clip
 * (tools/gpu/a2f_offline.py, mirrored future vs the full 260 ms): 150 ms → corr 0.97-0.98, 100 → 0.87-0.95,
 * 60 → 0.63-0.91, 30 → 0.46-0.83 (pucker is the most future-hungry channel, jaw the least).
 */
export const a2fFutureFor = (lookaheadMs: number) => Math.max(20, Math.min(150, lookaheadMs - 30));

/** ARKit mouth channels A2F drives, with the gain that maps Claire's realistic range onto the anime range the rig
 *  uses (calibrated on the test clip: held "aa" jaw 0.22 → 0.7, "oo" pucker 0.3 → 0.8, F/V roll 0.25 → 0.75,
 *  M/B/P press 0.2-0.4 → 0.4-0.8). Smile / frown / dimple stay small: the corners belong to the emotion. */
export const A2F_GAIN: Record<string, number> = {
  jawOpen: 3.2, mouthClose: 2.0, mouthFunnel: 2.6, mouthPucker: 2.7, mouthRollLower: 3.0, mouthRollUpper: 2.4,
  mouthShrugLower: 2.2, mouthShrugUpper: 1.4, mouthPressLeft: 2.0, mouthPressRight: 2.0,
  mouthLowerDownLeft: 2.6, mouthLowerDownRight: 2.6, mouthUpperUpLeft: 2.6, mouthUpperUpRight: 2.6,
  mouthStretchLeft: 2.2, mouthStretchRight: 2.2, mouthSmileLeft: 0.6, mouthSmileRight: 0.6,
  mouthDimpleLeft: 1.2, mouthDimpleRight: 1.2, mouthLeft: 1.5, mouthRight: 1.5, cheekPuff: 1.5,
};
export const A2F_MOUTH = Object.keys(A2F_GAIN);

/** The channels beyond the mouth: A2F's tongue, eye look and upper face (shared/lipBus.ts says how each consumer may use
 *  them: the camera keeps the eyes and brows, the upper face may only raise, the tongue is A2F's alone). Gains map
 *  Claire's range onto an avatar's. Measured on the recorded clip (tools/gpu/a2f_extras_eval.py, docs/GPU_TRACKING.md): speech
 *  moves the tongue poses to 0.02-0.2 (tongueOut itself ≤ 0.03: nobody sticks the tongue out while talking), the eye look to
 *  ±0.1-0.2 (≈ 3-6° of micro-motion that follows the jaw), and with A2F's default (neutral) emotion the brows / cheeks /
 *  eye-wide stay near 0 (≤ 0.07; they move with an explicit emotion input, which the studio does not send). */
export const A2F_EXTRA_GAIN: Record<string, number> = {
  tongueOut: 3, tongueTipUp: 4, tongueTipDown: 4, tongueUp: 6, tongueDown: 3, tongueStretch: 4, tongueWide: 3, tongueNarrow: 3, tongueIn: 3,
  eyeLookUpLeft: 0.6, eyeLookDownLeft: 0.6, eyeLookInLeft: 0.6, eyeLookOutLeft: 0.6, eyeLookUpRight: 0.6, eyeLookDownRight: 0.6, eyeLookInRight: 0.6, eyeLookOutRight: 0.6,
  browInnerUp: 1.5, browOuterUpLeft: 1.5, browOuterUpRight: 1.5, browDownLeft: 1.5, browDownRight: 1.5, eyeWideLeft: 1.5, eyeWideRight: 1.5,
  eyeSquintLeft: 1.5, eyeSquintRight: 1.5, cheekSquintLeft: 1.5, cheekSquintRight: 1.5, noseSneerLeft: 1.5, noseSneerRight: 1.5,
};
/** Dead zone (on the gained value, rescaled above it so the channel still reaches 1) for channels that speech must not show: tongueOut
 *  sits at ≤ 0.03 raw while talking (×3 = 0.09), so normal speech shows no tongue on a rig that has the shape; a deliberate stick-out still does. */
export const A2F_EXTRA_DEAD: Record<string, number> = { tongueOut: 0.08 };
export const A2F_EXTRA = Object.keys(A2F_EXTRA_GAIN);

export interface A2fTimed { t: number; w: Float32Array }

export class A2fMerge {
  /** channel order of the frames (the sidecar's `names`) */
  names: string[] = [];
  private idx: number[] = [];
  private xidx: number[] = [];
  private q: A2fTimed[] = [];
  /** max distance (s) from the shown instant to an interpolation neighbour */
  tol = 0.04;
  /** frames that haven't arrived for the shown instant yet: use the newest if at most this much older (s) */
  lagTol = 0.06;
  private lastSpeech = -1e9;
  private k = 0;
  dbg = { used: false, lagMs: 0, k: 0 };

  setNames(n: string[]) {
    if (n.length && n.join() !== this.names.join()) { this.names = n; this.idx = A2F_MOUTH.map((c) => n.indexOf(c)); this.xidx = A2F_EXTRA.map((c) => n.indexOf(c)); }
  }
  /** content time on the SAME clock as sample()'s `t` */
  push(f: A2fTimed) {
    if (this.q.length && f.t <= this.q[this.q.length - 1].t - 0.001) this.q.length = 0; // stream restart
    this.q.push(f);
    while (this.q.length > 90) this.q.shift();
  }
  clear() { this.q.length = 0; this.k = 0; }
  get newest() { return this.q.length ? this.q[this.q.length - 1].t : -Infinity; }

  /** Weights for instant t (linear between the two neighbours), or null. */
  sample(t: number): Float32Array | null {
    const q = this.q;
    if (!q.length) return null;
    const last = q[q.length - 1];
    if (last.t < t) return t - last.t <= this.lagTol ? last.w : null;
    let k = q.length - 1;
    while (k > 0 && q[k - 1].t > t) k--;
    const b = q[k], a = k > 0 ? q[k - 1] : null;
    if (!a) return b.t - t <= this.tol ? b.w : null;
    if (t - a.t > this.tol && b.t - t > this.tol) return null;
    const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-4, b.t - a.t)));
    const out = new Float32Array(a.w.length);
    for (let i = 0; i < out.length; i++) out[i] = a.w[i] + (b.w[i] - a.w[i]) * u;
    return out;
  }

  /**
   * Put the A2F mouth for instant `t` on the fused frame (frame.a2f = gained channels + k = blend weight).
   * `speech` 0..1: the engine's speaking engagement for that instant (frame.mouth.speak); A2F fades in over
   * ~40 ms with speech and out over ~200 ms after it (so the tail of a word keeps its shape).
   */
  apply(frame: TrackingFrame, t: number, dt: number, mix: number, gain = 1): TrackingFrame {
    this.dbg.used = false;
    const w = this.sample(t);
    const speak = frame.mouth.speak ?? 0;
    if (speak > 0.05) this.lastSpeech = t;
    const target = w && mix > 0 && t - this.lastSpeech < 0.2 ? mix : 0;
    const tau = target > this.k ? 0.04 : 0.2;
    this.k += (target - this.k) * (1 - Math.exp(-Math.max(1e-3, dt) / tau));
    this.dbg.k = this.k;
    if (!w || this.k < 0.01 || !this.idx.length) return frame;
    const ch: Record<string, number> = { k: +this.k.toFixed(3) };
    A2F_MOUTH.forEach((c, i) => {
      const j = this.idx[i];
      if (j >= 0) ch[c] = +Math.min(1, Math.max(0, w[j] * A2F_GAIN[c] * gain)).toFixed(3);
    });
    // tongue / eyes / upper face (an older sidecar without the extra names just has none of them)
    A2F_EXTRA.forEach((c, i) => {
      const j = this.xidx[i];
      if (j >= 0 && j < w.length) {
        const dz = A2F_EXTRA_DEAD[c] ?? 0, g = Math.max(0, w[j] * A2F_EXTRA_GAIN[c]);
        const v = +Math.min(1, dz > 0 ? Math.max(0, g - dz) / (1 - dz) : g).toFixed(3);
        if (v > 0) ch[c] = v;
      }
    });
    this.dbg = { used: true, lagMs: Math.round((this.newest - t) * 1000), k: this.k };
    return { ...frame, a2f: ch };
  }
}

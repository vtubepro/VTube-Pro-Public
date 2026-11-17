// External face source: bus 'ext' messages (iPhone/Android ARKit apps, iFacialMocap, Live Link Face, VMC, VTS-API plugins)
// → a TrackingFrame with EXACTLY the units and signs FaceSolver produces, so the rest of the pipeline
// (retarget, expressions, OBS output) can't tell the difference.
//
// FaceSolver conventions (see faceSolver.ts; checked by tools/testExternalConventions.ts):
//   head    [yaw, pitch, roll] radians, relative to the calibrated rest pose, × headRotationScale:
//           yaw > 0 = performer turns to THEIR LEFT, pitch > 0 = nod down, roll > 0 = tilt to THEIR RIGHT
//           (MediaPipe facial-transformation matrix, euler 'YXZ', un-mirrored camera image)
//   headPos metres relative to rest: x > 0 performer's left, y up, z toward the camera
//   gaze    ≈ −1..1 (not radians): x > 0 performer's left, y > 0 down
//   face    ARKit 0..1 × gain × expressiveness, performer's own sides; eyeLook* regenerated from gaze
//   mirror  → face names L↔R swapped, yaw/roll/x/gazeX negated
// ExternalTracking conventions (shared/types.ts): degrees, head [pitch(+down), yaw(+left), roll(+left)],
// so the only sign change is roll.
import { ARKIT, mirrorName } from '../core/arkit.ts';
import { AsymEma, OneEuroBank, clamp, clamp01, smoothingToOneEuro } from './filters.ts';
import { eyesTrackedSetting, oneEyeExternal } from './oneEye.ts';
import type { ExternalSourceKind, ExternalTracking, TrackingFrame, TrackingTuning, Vec3 } from '../../shared/types.ts';

const D2R = Math.PI / 180;
/** Stale after this long without a packet → frame() returns null (caller falls back to the webcam). */
const STALE_S = 0.5;
/** Degrees of eye rotation that read as full gaze (±1) — iris travel limits of ARKit eyes. */
const GAZE_YAW_DEG = 25, GAZE_PITCH_DEG = 20;

/** Seconds the head takes to blend from the pose that was shown before a source switch to the new source's pose. */
const HOLD_BLEND_S = 0.5;
/** Sources whose packets are absolute (relative to where the phone / tracker points): their rest pose is learned from the first packets. */
const AUTO_REST = new Set<string>(['vts-phone', 'ifacialmocap', 'livelinkface', 'openseeface']);

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

export class ExternalFaceSource {
  private want: ExternalSourceKind | null;
  private last: ExternalTracking | null = null;
  private lastAt = -Infinity;
  private filt = new OneEuroBank();
  private mouthFilt = new OneEuroBank();
  private headFilt = new OneEuroBank(1.2, 0.05);
  private blinkL = new AsymEma(38, 20);
  private blinkR = new AsymEma(38, 20);
  private lastT = 0;
  /** the head flips (ExternalTracking.inv) the rest pose was learned under */
  private lastInv = 0;
  /** Rest pose in FRAME order: head [yaw, pitch, roll] radians, pos metres. */
  private rest: { head: Vec3; pos: Vec3; gaze?: [number, number] } | null = null;
  private calib: { until: number; dur: number; n: number; head: Vec3; pos: Vec3; gaze: [number, number]; withHead: boolean } | null = null;
  lastFrame: TrackingFrame = empty();
  /** After a source switch the rest pose is relearned (~0.8 s) and the first raw head would jump by the off-centre amount: the head stays at the
   *  pose shown before the switch until the rest is learned, then blends to the live pose (frame()'s `prev` supplies that pose). */
  private needHold = false;
  private hold: { head: Vec3; pos: Vec3; blending: boolean; t0: number } | null = null;

  /** `source` = only accept that kind (null = whatever arrives). */
  constructor(source: ExternalSourceKind | null = null) { this.want = source; }

  /** Kind currently selected (or, when accepting anything, of the latest packet). */
  get source(): ExternalSourceKind | null { return this.want ?? this.last?.source ?? null; }
  set source(k: ExternalSourceKind | null) {
    if (k === this.want) return;
    this.want = k;
    this.reset();
  }

  /** Seconds since the last accepted packet (Infinity if none). */
  age(nowSec: number) { return nowSec - this.lastAt; }

  /** Feed one bus 'ext' payload. `nowSec` must be on the same clock as frame() (performance.now()/1000). */
  push(d: ExternalTracking, nowSec = performance.now() / 1000) {
    if (!d || typeof d !== 'object') return;
    if (this.want && d.source !== this.want) return;
    const inv = d.inv ?? 0;
    // another source, or a flip switched on / off ("Head turns the wrong way? Flip it"): the rest pose learned under the old signs
    // is wrong now (a phone 10° off-axis would sit at -20°), so it is learned again from the next packets
    if (this.last && (d.source !== this.last.source || inv !== this.lastInv)) this.reset();
    this.lastInv = inv;
    this.last = d;
    this.lastAt = nowSec;
    // phones report absolute pose relative to where the phone points → learn the rest pose automatically
    if (!this.rest && !this.calib && d.found) this.recenter(0.8, AUTO_REST.has(d.source));
    if (this.calib && d.found) {
      const c = this.calib;
      const h = rawHead(d), p = rawPos(d);
      for (let i = 0; i < 3; i++) { c.head[i] += h[i]; c.pos[i] += p[i]; }
      const gz = rawGaze(d); c.gaze[0] += gz[0]; c.gaze[1] += gz[1];
      c.n++;
      if (nowSec >= c.until || c.until === Infinity) {
        if (c.until === Infinity) c.until = nowSec + c.dur;
        else {
          const n = Math.max(1, c.n);
          this.rest = {
            head: c.withHead ? [c.head[0] / n, c.head[1] / n, c.head[2] / n] : [0, 0, 0],
            pos: [c.pos[0] / n, c.pos[1] / n, c.pos[2] / n],
            // the eyes too: a phone below / beside the monitor sees "looking at my screen" as 15-25° off-axis, which
            // read as a permanent downward gaze — the rest gaze (looking at the screen = at the viewer) becomes 0
            ...(c.withHead ? { gaze: [c.gaze[0] / n, c.gaze[1] / n] as [number, number] } : {}),
          };
          this.calib = null;
        }
      }
    }
  }

  /**
   * Treat the current pose as neutral (averaged over `seconds`). `withHead` = also zero head rotation
   * (default true for an explicit recenter; phone sources do it automatically once).
   */
  recenter(seconds = 0.8, withHead = true) {
    // the averaging window starts at the next face-found packet (see push)
    this.calib = { until: Infinity, dur: Math.max(0, seconds), n: 0, head: [0, 0, 0], pos: [0, 0, 0], gaze: [0, 0], withHead };
  }

  reset() {
    this.last = null;
    this.lastAt = -Infinity;
    this.rest = null;
    this.calib = null;
    this.needHold = true; this.hold = null;
    this.filt.reset(); this.mouthFilt.reset(); this.headFilt.reset();
    this.blinkL = new AsymEma(38, 20); this.blinkR = new AsymEma(38, 20);
    this.lastFrame = empty();
  }

  /** TrackingFrame for this render tick, or null when the source is stale (> 0.5 s) / never seen. */
  frame(nowSec: number, tune: TrackingTuning, prev?: Pick<TrackingFrame, 'head' | 'headPos'> | null): TrackingFrame | null {
    // one eye tracked (eye patch): the visible eye drives both (oneEye.ts)
    const d = this.last && eyesTrackedSetting.value !== 'both' ? oneEyeExternal(this.last, eyesTrackedSetting.value) : this.last;
    if (!d || nowSec - this.lastAt > STALE_S) return null;
    const dt = clamp(nowSec - this.lastT, 1 / 240, 0.25);
    this.lastT = nowSec;
    if (!d.found) return this.decay(dt, nowSec);

    const { minCutoff, beta } = smoothingToOneEuro(tune.smoothing);
    this.filt.minCutoff = minCutoff * 1.6; this.filt.beta = beta * 2;
    this.mouthFilt.minCutoff = minCutoff * 3.5; this.mouthFilt.beta = 1.2 * (1.1 - tune.smoothing);
    this.headFilt.minCutoff = minCutoff; this.headFilt.beta = beta;
    const t = nowSec;
    const fl = (n: string) => (n.startsWith('mouth') || n.startsWith('jaw') ? this.mouthFilt : this.filt);

    // ---- face ----
    const bs = d.blendshapes ?? {};
    const out: Record<string, number> = {};
    for (const name of ARKIT) {
      if (name.startsWith('eyeLook') || name.startsWith('eyeBlink')) continue;
      const raw = clamp01(fin(bs[name]));
      const gain = (tune.gains[name] ?? 1) * tune.expressiveness;
      out[name] = clamp01(fl(name).filter(name, raw * gain, t));
    }
    // ARKit blinks rest ~0.05–0.15 and close at ~0.8: remap like FaceSolver's blink shaping
    const blink = (v: number) => clamp01((clamp01(v) - 0.12) / 0.62);
    const bg = tune.gains.eyeBlinkLeft ?? 1, bgR = tune.gains.eyeBlinkRight ?? 1;
    let bL = blink(fin(bs.eyeBlinkLeft)) * bg, bR = blink(fin(bs.eyeBlinkRight)) * bgR;
    if (Math.abs(bL - bR) < 0.3) { const m = Math.max(bL, bR) * 0.7 + Math.min(bL, bR) * 0.3; bL = bR = m; }
    out.eyeBlinkLeft = this.blinkL.step(clamp01(bL), dt);
    out.eyeBlinkRight = this.blinkR.step(clamp01(bR), dt);
    const sm = Math.max(out.mouthSmileLeft ?? 0, out.mouthSmileRight ?? 0);
    out.mouthFrownLeft = (out.mouthFrownLeft ?? 0) * (1 - sm);
    out.mouthFrownRight = (out.mouthFrownRight ?? 0) * (1 - sm);

    // ---- gaze (+x performer's left, +y down) ----
    let [gx, gy] = rawGaze(d);
    const rg = this.rest?.gaze;
    if (rg) { gx -= rg[0]; gy -= rg[1]; }
    const dz = 0.04;
    gx = Math.sign(gx) * Math.max(0, Math.abs(gx) - dz) / (1 - dz);
    gy = Math.sign(gy) * Math.max(0, Math.abs(gy) - dz) / (1 - dz);
    gx = this.filt.filter('_gx', clamp(gx, -1, 1), t);
    gy = this.filt.filter('_gy', clamp(gy, -1, 1), t);
    out.eyeLookOutLeft = clamp01(gx); out.eyeLookInRight = clamp01(gx);
    out.eyeLookInLeft = clamp01(-gx); out.eyeLookOutRight = clamp01(-gx);
    out.eyeLookDownLeft = out.eyeLookDownRight = clamp01(gy);
    out.eyeLookUpLeft = out.eyeLookUpRight = clamp01(-gy);

    // ---- head, relative to rest ----
    const h = rawHead(d), p = rawPos(d);
    const rh = this.rest?.head ?? [0, 0, 0];
    const rp = this.rest?.pos ?? (d.headPos ? p : [0, 0, 0]);
    const s = tune.headRotationScale;
    let yaw = this.headFilt.filter('y', (h[0] - rh[0]) * s, t);
    const pitch = this.headFilt.filter('p', (h[1] - rh[1]) * s, t);
    let roll = this.headFilt.filter('r', (h[2] - rh[2]) * s, t);
    let px = this.headFilt.filter('x', p[0] - rp[0], t);
    const py = this.headFilt.filter('yy', p[1] - rp[1], t);
    const pz = this.headFilt.filter('z', p[2] - rp[2], t);

    let face = out;
    let gazeYaw = gx;
    if (tune.mirror) {
      face = {};
      for (const k in out) face[mirrorName(k)] = out[k];
      yaw = -yaw; roll = -roll; px = -px; gazeYaw = -gazeYaw;
    }
    const avg = (a: string, b: string) => ((face[a] ?? 0) + (face[b] ?? 0)) / 2;
    const open = clamp01((face.jawOpen ?? 0) - (face.mouthClose ?? 0) * 0.6 +
      avg('mouthLowerDownLeft', 'mouthLowerDownRight') * 0.25 + avg('mouthUpperUpLeft', 'mouthUpperUpRight') * 0.1);

    let head: Vec3 = [clamp(yaw, -1.3, 1.3), clamp(pitch, -1, 1), clamp(roll, -0.9, 0.9)];
    let headPos: Vec3 = [clamp(px, -0.8, 0.8), clamp(py, -0.5, 0.5), clamp(pz, -1, 1)];
    if (this.needHold) {
      this.needHold = false;
      if (prev && prev.head && prev.headPos) this.hold = { head: [...prev.head] as Vec3, pos: [...prev.headPos] as Vec3, blending: false, t0: 0 };
    }
    const hd = this.hold;
    if (hd) {
      if (!hd.blending && !(AUTO_REST.has(d.source) && !this.rest)) { hd.blending = true; hd.t0 = nowSec; }
      let w = 0;
      if (hd.blending) { const u = clamp((nowSec - hd.t0) / HOLD_BLEND_S, 0, 1); w = u * u * (3 - 2 * u); if (u >= 1) this.hold = null; }
      if (w < 1) {
        head = [hd.head[0] + (head[0] - hd.head[0]) * w, hd.head[1] + (head[1] - hd.head[1]) * w, hd.head[2] + (head[2] - hd.head[2]) * w];
        headPos = [hd.pos[0] + (headPos[0] - hd.pos[0]) * w, hd.pos[1] + (headPos[1] - hd.pos[1]) * w, hd.pos[2] + (headPos[2] - hd.pos[2]) * w];
      }
    }
    const frame: TrackingFrame = {
      t,
      face,
      head,
      headPos,
      gaze: [gazeYaw, gy],
      mouth: {
        open,
        wide: avg('mouthStretchLeft', 'mouthStretchRight'),
        smile: avg('mouthSmileLeft', 'mouthSmileRight'),
        frown: avg('mouthFrownLeft', 'mouthFrownRight'),
        pucker: face.mouthPucker ?? 0,
        funnel: face.mouthFunnel ?? 0,
        tongue: face.tongueOut ?? 0,
      },
      tracked: true,
    };
    this.lastFrame = frame;
    return frame;
  }

  /** Face lost at the sender: ease to rest (same as FaceSolver.decay). */
  private decay(dt: number, t: number): TrackingFrame {
    const f = this.lastFrame;
    const k = Math.exp(-4 * dt);
    const face: Record<string, number> = {};
    for (const n in f.face) face[n] = f.face[n] * k;
    const m = f.mouth;
    this.lastFrame = {
      ...f, t, face,
      head: [f.head[0] * k, f.head[1] * k, f.head[2] * k],
      headPos: [f.headPos[0] * k, f.headPos[1] * k, f.headPos[2] * k],
      gaze: [f.gaze[0] * k, f.gaze[1] * k],
      mouth: { open: m.open * k, wide: m.wide * k, smile: m.smile * k, frown: m.frown * k, pucker: m.pucker * k, funnel: m.funnel * k, tongue: m.tongue * k },
      tracked: false,
    };
    return this.lastFrame;
  }
}

/** ExternalTracking head (deg: pitch +down, yaw +left, roll +left) → frame order [yaw, pitch, roll] radians (roll +right). */
function rawHead(d: ExternalTracking): Vec3 {
  const h = d.head;
  if (!h) return [0, 0, 0];
  return [fin(h[1]) * D2R, fin(h[0]) * D2R, -fin(h[2]) * D2R];
}

function rawPos(d: ExternalTracking): Vec3 {
  const p = d.headPos;
  return p ? [fin(p[0]), fin(p[1]), fin(p[2])] : [0, 0, 0];
}

function empty(): TrackingFrame {
  return {
    t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0],
    mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 },
    tracked: false,
  };
}

/** Allowed values for the app's tracking-source selector. */
export type TrackingSourceChoice = 'webcam' | ExternalSourceKind;
export const TRACKING_SOURCES: [TrackingSourceChoice, string][] = [
  ['webcam', 'Webcam (built-in)'],
  ['vts-phone', 'VTube Studio phone app'],
  ['ifacialmocap', 'iFacialMocap / FaceMotion3D'],
  ['livelinkface', 'Live Link Face (iPhone, Epic)'],
  ['vmc', 'VMC protocol (VSeeFace, XR Animator, Warudo…)'],
  ['vts-api', 'VTube Studio API plugins'],
  ['openseeface', 'Light face tracker (OpenSeeFace)'],
];

/** Gaze straight from the packet (+x performer's left, +y down, ≈ −1..1), before rest / dead zone / filtering. */
function rawGaze(d: ExternalTracking): [number, number] {
  if (d.eyeLeft || d.eyeRight) {
    const e = [d.eyeLeft, d.eyeRight].filter(Boolean) as [number, number][];
    return [e.reduce((a, v) => a + fin(v[1]), 0) / e.length / GAZE_YAW_DEG, e.reduce((a, v) => a + fin(v[0]), 0) / e.length / GAZE_PITCH_DEG];
  }
  const bs = d.blendshapes ?? {};
  const g = (k: string) => clamp01(fin(bs[k]));
  return [(g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2 * 1.4,
    (g('eyeLookDownLeft') + g('eyeLookDownRight') - g('eyeLookUpLeft') - g('eyeLookUpRight')) / 2 * 1.4];
}

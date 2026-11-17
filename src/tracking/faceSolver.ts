// Face solver: MediaPipe FaceLandmarker result → clean, expressive, calibrated face signal.
//
// Raw MediaPipe coefficients are conservative and person-dependent (jawOpen ≈ 0.3–0.5 when talking,
// eyeBlink rests at 0.1–0.4 behind glasses). What makes an avatar feel alive is:
//   1. per-user neutral + personal peak calibration, remapped through an ease curve (amplifier)
//   2. blink fusion (blendshape + eye-aspect-ratio geometry) with a rolling per-eye floor
//   3. iris-landmark gaze (much stronger signal than the eyeLook* blendshapes alone)
//   4. head pose relative to the calibrated rest pose (a tilted webcam isn't a tilted head)

import * as THREE from 'three';
import type { FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { ARKIT, DEFAULT_PEAK, mirrorName } from '../core/arkit.ts';
import { AsymEma, KalmanBank, LeadEuroBank, OneEuroBank, clamp, clamp01, lerp, smoothingToOneEuro, smoothstep } from './filters.ts';
import type { TrackingFrame, TrackingTuning, Vec3 } from '../../shared/types.ts';
import { PoseNeutral } from './poseNeutral.ts';
import { FEATURE_KEYS, FacialHairDetector, GEO_TO_ARKIT, LIP_T, geoChannels, lipContour, lipShapeChannels, measureMouth, type MouthFeatures } from './mouthGeometry.ts';
import { HeadMetric, measureHead, type HeadMeasure } from './headMetric.ts';
import { StabGroup } from './stabilizer.ts';
import { MouthImageModel, type MouthPatchStats } from './mouthImage.ts';
import { LIP_OUTER, MouthVisibility, handCover } from './mouthVisibility.ts';
import { NaturalCapture } from './naturalCapture.ts';
import { OneEyeDetector, eyeAspect, eyesTrackedSetting, mirrorEyeChannels, visibleKey, type EyesTracked } from './oneEye.ts';
import { BlinkMouthGuard } from './blinkMouthGuard.ts';
import { SLACK_MAX, SlackMouth } from './slackMouth.ts';
import { AutoBlink, EyeTrust, GlassesState } from './glasses.ts';

/** FaceLandmarker result + the face worker's mouth-interior patch statistics (when enabled). */
export type FaceResultPlus = FaceLandmarkerResult & { mouthImage?: MouthPatchStats | null };

export interface FaceCalibration {
  neutral: Record<string, number>;
  peaks: Record<string, number>;
  head: Vec3; // euler yaw, pitch, roll at rest (as seen by the face crop — "apparent")
  /** posV 3: rest measurement [u, v, s] (rigid centroid in normalized image coords + rigid spread, see
   *  headMetric.ts) — scale-free, so learning the face size / changing the FOV never shifts the rest pose.
   *  posV 2 (old): cm from the eye-corner span. */
  headPos: Vec3;
  gaze: [number, number];
  earOpen: [number, number]; // [left, right]
  /** One-eye tracking (oneEye.ts): the visible eye's own gaze rest, per eye (its iris sits off the two-eye average). */
  gaze1?: Partial<Record<'left' | 'right', [number, number]>>;
  /** Neutral lip geometry (facial-hair-robust mouth solver). */
  geo?: MouthFeatures;
  /** Bumped whenever measureMouth() changes definition; a stale neutral is re-learned. */
  geoV?: number;
  /** Head-position convention version (2 = landmark-based metres·100, 3 = scale-free measurement). */
  posV?: number;
  at: string;
}

const CALIB_KEY = 'vtp.faceCalibration';

const GEO_VERSION = 2;
export function loadCalibration(): FaceCalibration | null {
  try {
    const s = localStorage.getItem(CALIB_KEY);
    const c = s ? (JSON.parse(s) as FaceCalibration) : null;
    if (c && c.geoV !== GEO_VERSION) { delete c.geo; c.geoV = GEO_VERSION; }
    return c;
  } catch { return null; }
}
function saveCalibration(c: FaceCalibration) {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

// Landmark indices (MediaPipe face mesh, person's anatomical sides).
const EYE = {
  // p1..p6 for eye aspect ratio: corners (p1,p4), upper (p2,p3), lower (p6,p5)
  left: { outer: 263, inner: 362, up1: 385, up2: 387, lo1: 380, lo2: 373, iris: 473 },
  right: { outer: 33, inner: 133, up1: 160, up2: 158, lo1: 144, lo2: 153, iris: 468 },
};

const dist = (a: NormalizedLandmark, b: NormalizedLandmark, ar: number) =>
  Math.hypot((a.x - b.x) * ar, a.y - b.y);

/** Channels that carry resting muscle tension (people "rest" with lowered brows, squints, pressed lips). */
const TENSION = new Set(['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthDimpleLeft', 'mouthDimpleRight', 'eyeWideLeft', 'eyeWideRight',
  '_browL', '_browR', '_browInL', '_browInR', '_furrow']);

/** Opening channels: their neutral is the CLOSED mouth — learned as a low percentile of the live data and
 *  never allowed above it (a calibration taken while talking made the mouth read ~0 on most syllables). */
const OPEN_REST = new Set(['jawOpen', 'mouthLowerDownLeft', 'mouthLowerDownRight', '_lipGap', '_geoGap']);

type ExpressionCapture = { channels: string[]; max: Record<string, number> } | null;

export class FaceSolver {
  calib: FaceCalibration | null = loadCalibration();
  private filt = new OneEuroBank();
  /** Mouth/jaw need to follow syllables (4–6 Hz): lighter smoothing than brows/eyes. */
  private mouthFilt = new OneEuroBank();
  private headFilt = new OneEuroBank(1.2, 0.05);
  /** Latency-compensated head filter (see LeadEuro): low lag + prediction to display time. */
  private headLead = new LeadEuroBank();
  private headKal = new KalmanBank();
  private exprKal = new KalmanBank();
  /** Seconds from camera capture to the avatar being displayed — the head is predicted this far ahead. */
  lead = 0.03;
  /** Reproduce the pre-2026-09 filter chain (benchmarks / A-B). */
  legacyFilters = false;
  /** Non-mouth expression Kalman tuning (0..1 channels). */
  exprTuning = { sigmaA: [45, 12], sigmaM: 0.22 };
  /** Head filter tuning (smoothing 0 → 1 interpolates each pair). Tuned on the recorded clip with tools/eval_latency.ts. */
  headTuning = {
    mode: 'kalman' as 'kalman' | 'euro',
    // kalman: acceleration noise (rad/s², smoothing 0 → 1) and per-channel measurement noise
    sigmaA: [40, 5], sigmaM: { y: 0.012, p: 0.02, r: 0.016, x: 0.008, yy: 0.008, z: 0.024 } as Record<string, number>,
    // euro (fallback)
    minCutoff: [2.4, 0.45], beta: [1.6, 0.35], gate: [0.08, 0.35], dCutoff: 6, deadband: 0, pitchDeadband: 0,
  };
  private blinkL = new AsymEma(38, 20);
  private blinkR = new AsymEma(38, 20);
  /** Blinks never open the mouth: landmark mouth readings are held through a blink (blinkMouthGuard.ts). */
  readonly blinkGuard = new BlinkMouthGuard();
  /** Lips resting a little apart while NOT talking read as closed (slackMouth.ts). Off: localStorage vtp.slackGate = '0'. */
  readonly slack = Object.assign(new SlackMouth(), { max: (() => { try { const v = Number(localStorage.getItem('vtp.slackMax')); return v >= 0.08 && v <= 0.3 ? v : SLACK_MAX; } catch { return SLACK_MAX; } })() });
  /** the closed-lips rest of the raw lip gap this frame (lip gap / eye-corner span; the self-test reads gap − this) */
  lipRestN = 0;
  slackGate = (() => { try { return localStorage.getItem('vtp.slackGate') !== '0'; } catch { return true; } })();
  /** Glasses (glasses.ts): detected from the camera (the facial-hair readback feeds `glassesState`), or forced by the user
   *  (true / false; null = auto, localStorage vtp.glasses = 'on' / 'off'). With glasses the eyes lean on the blink cue that
   *  agrees, a one-eyed "blink" must hold like a real wink, gaze eases toward the head, and untrustworthy eyes blink on
   *  their own. */
  readonly glassesState = new GlassesState();
  glassesOverride: boolean | null = (() => { try { const v = localStorage.getItem('vtp.glasses'); return v === 'on' ? true : v === 'off' ? false : null; } catch { return null; } })();
  get glasses(): boolean { return this.glassesOverride ?? this.glassesState.on; }
  readonly eyeTrust = new EyeTrust();
  private autoBlink = new AutoBlink();
  private eyesLost = 0;
  private oneSided: [number, number] = [0, 0];
  /** recent brief one-eyed closures under glasses (decays over ~20 s) and whether the glasses blink care is on */
  private glare = 0;
  glLow = false;
  private glassesSeen = 0;
  private glassesT = 0;
  private slackHead: Vec3 | null = null;
  private slackHeadSpeed = 0;
  private blinkFloor: [number, number] = [0.15, 0.15];
  private blinkPeak: [number, number] = [0.7, 0.7];
  private earOpen: [number, number] = [0.3, 0.3];
  private livePeak: Record<string, number> = {};
  private stableSince = -1;
  private calibrating: { until: number; samples: { bs: Record<string, number>; head: Vec3; pos: Vec3; gaze: [number, number]; ear: [number, number]; feats: MouthFeatures }[]; resolve: () => void } | null = null;
  private capture: ExpressionCapture = null;
  private lastT = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  /** Metric depth / neck-pivot position / line-of-sight rotation (headMetric.ts). */
  readonly metric = new HeadMetric();
  /** Use the metric head model (false = the pre-2026-09-24 eye-span position + crop-relative rotation). */
  metricHead = true;
  /** Last head measurement (diagnostics). */
  measure: HeadMeasure | null = null;
  /** Unfiltered head channels relative to rest [yaw, pitch, roll, x, y, z] (rad / m) — diagnostics. */
  relRaw: number[] | null = null;
  /** Rest stabiliser on the head (stillness lock + motion-gated prediction; stabilizer.ts). */
  stabilize = (() => { try { return localStorage.getItem('vtp.stabilize') !== '0'; } catch { return true; } })();
  readonly headRotStab = new StabGroup([
    { sigma: [0.003, 0.001, 0.01], kalman: [24, 0.012], dzMax: 0.009 },
    { sigma: [0.003, 0.001, 0.01], kalman: [24, 0.02], dzMax: 0.009 },
    { sigma: [0.003, 0.001, 0.01], kalman: [24, 0.016], dzMax: 0.009 },
  ]);
  readonly headPosStab = new StabGroup([
    { sigma: [0.0015, 0.0005, 0.006], kalman: [6, 0.008], dzMax: 0.005 },
    { sigma: [0.0015, 0.0005, 0.006], kalman: [5, 0.008], dzMax: 0.005 },
    { sigma: [0.003, 0.001, 0.012], kalman: [7, 0.024], dzMax: 0.01, leadScale: 0.5 },
  ]);
  /** Stabiliser state for diagnostics (state.json `stab`). */
  stabInfo() {
    const g = (s: StabGroup, k: number) => ({ moving: s.moving, m: +s.m.toFixed(2), score: +s.score.toFixed(2), stillFor: +s.stillFor.toFixed(1), sigma: s.sigmas().map((x) => +(x * k).toFixed(3)) });
    return { on: this.stabilize, rotDeg: g(this.headRotStab, 57.2958), posMm: g(this.headPosStab, 1000) };
  }
  private qTrue = new THREE.Quaternion();
  private qRest = new THREE.Quaternion();
  private eRest = new THREE.Euler();
  private pNow = new THREE.Vector3();
  private pRest = new THREE.Vector3();
  /** posV 2 → 3 upgrade: averaged conversion factors from the first frames after the upgrade. */
  private posUpgrade: { n: number; k: number; du: number; dv: number; old: Vec3 } | null = null;
  /** Mouth-interior image model (tongue / teeth / cavity), fed by the face worker's patch stats. */
  readonly mouthModel = new MouthImageModel();
  mouthImg: { t: number; _tongueOut: number; _tongueUp: number; _teethShow: number; _cavity: number } | null = null;
  /** Mouth-interior channels (_tongueOut / _tongueUp / _teethShow / _cavity) from the patch: only with the full
   *  mouth-image feature ('Teeth and tongue', localStorage vtp.mouthImage = '1'; the app keeps this in step with the
   *  tracker). The patch may also arrive for mouth visibility alone — that must not switch these on. */
  imageChannels = (() => { try { return localStorage.getItem('vtp.mouthImage') === '1'; } catch { return false; } })();
  /** Is something in front of the lips (mic, mug, hand)? mouthVisibility.ts → face._mouthVis (1 = seen). Off switch:
   *  localStorage vtp.mouthVis = '0'. */
  readonly mouthVis = new MouthVisibility();
  /** Hand landmarks of this frame (normalised image coords, the app sets them; null = no hand tracking) — a hand over
   *  the mouth hides it (mouthVisibility.handCover). */
  hands: { x: number; y: number }[][] | null = null;
  /** Let the image tongue detector drive the avatar's tongueOut (else it's only the raw _tongueOut channel). */
  tongueFromCamera = (() => { try { return localStorage.getItem('vtp.tongueCam') === '1'; } catch { return false; } })();
  /** Natural capture (naturalCapture.ts): learns this performer's relaxed face + typical expression size so normal,
   *  subtle faces read fully (no over-acting). `natural.enabled = false` → the classic amplifier only. */
  readonly natural = new NaturalCapture();
  /** Eyes tracked (oneEye.ts): 'left' / 'right' = only the performer's own visible eye drives both avatar eyes (eye
   *  patch / one eye). Default: the saved setting (localStorage 'vtp.eyesTracked'). */
  eyesTracked: EyesTracked = eyesTrackedSetting.value;
  /** Suggests one-eye tracking when one eye looks covered (only while eyesTracked is 'both'). */
  readonly oneEye = new OneEyeDetector();
  /** one-eye gaze rest learned on the fly (no calibration for this eye yet) */
  private g1: { side: EyesTracked; x: number[]; y: number[] } = { side: 'both', x: [], y: [] };
  /** 0..1 how much the performer is speaking (set by the app from the voice each frame; < 0 = unknown → camera guess) */
  speaking = -1;
  private camTalk = 0;
  /** Raw (pre-amplification) blendshapes of the last frame — for the debug readout / wizard. */
  raw: Record<string, number> = {};
  lipGap = 0;
  lipOpen = 0;
  /** camera-seen bilabial seal (relative lip-gap dip) closes the camera jaw — see solve() */
  camSeal = true;
  private sealHist: { t: number; v: number }[] = [];
  /** smoothed camera frame interval (s): a slower camera rarely samples the bottom of a brief lip closure */
  private frameIv = 0.021;
  /** Facial-hair detector (fed camera frames by the app) and the effective compensation weight. */
  readonly hair = new FacialHairDetector();
  hairWeight = 0;
  feats: MouthFeatures | null = null;
  /** Neutral inner-lip half-width + resting contour (learned while relaxed). */
  private lipHalfW0 = 0;
  private lipRestU = LIP_T.map(() => 0);
  private lipRestL = LIP_T.map(() => 0);
  private lipSeen = 0;
  lips: { u: number[]; l: number[] } | null = null;
  /** Lip contour in the performer's own orientation (not mirrored) — for expression recognition. */
  lipsRaw: { u: number[]; l: number[] } | null = null;
  /** Resting baseline per channel: calibrated neutral, raised by the rolling rest-tension estimate. */
  restFor(): Record<string, number> {
    const out: Record<string, number> = {};
    const n = this.calib?.neutral ?? {};
    for (const k in n) out[k] = n[k];
    for (const k in this.restBase) out[k] = Math.max(out[k] ?? 0, this.restBase[k]);
    return out;
  }
  /** Rolling resting baseline (25th percentile of the last ~30 s) for tension channels. */
  private restHist = new Map<string, number[]>();
  private restTick = 0;
  /** Rolling closed-mouth baseline for opening channels (OPEN_REST). */
  private openHist = new Map<string, number[]>();
  openBase: Record<string, number> = {};
  private openRest(name: string): number | null { return this.openBase[name] ?? null; }
  restBase: Record<string, number> = {};
  geo: Record<string, number> = {};
  lastFrame: TrackingFrame = emptyFrame();

  /** Capture 2 s of neutral face. */
  calibrate(seconds = 2): Promise<void> {
    return new Promise((resolve) => {
      // on the tracking clock (frame t), not wall time — identical live, deterministic in replays
      this.calibrating = { until: (this.lastT > 0 ? this.lastT : performance.now() / 1000) + seconds, samples: [], resolve };
    });
  }

  /** Start recording the personal max of some channels (guided expression wizard). */
  beginCapture(channels: string[]) { this.capture = { channels, max: {} }; }
  endCapture() {
    const c = this.capture;
    this.capture = null;
    if (!c || !this.calib) return;
    for (const ch of c.channels) {
      const n = this.calib.neutral[ch] ?? 0;
      const v = c.max[ch];
      // Only accept a peak that is clearly above neutral, else the channel would amplify noise.
      if (v !== undefined && v - n > 0.08) this.calib.peaks[ch] = v;
    }
    this.calib.at = new Date().toISOString();
    saveCalibration(this.calib);
  }

  resetCalibration() {
    this.calib = null;
    this.mouthVis.reset(); // maybe another person: their own lip contrast
    this.blinkGuard.reset();
    this.livePeak = {};
    try { localStorage.removeItem(CALIB_KEY); } catch { /* ignore */ }
  }

  solve(res: FaceLandmarkerResult | null, t: number, aspect: number, tune: TrackingTuning): TrackingFrame {
    const dt = clamp(t - this.lastT, 1 / 240, 0.25);
    this.lastT = t;
    if (!res || !res.faceLandmarks[0]) {
      this.stableSince = -1;
      return this.decay(dt);
    }
    const lm = res.faceLandmarks[0];
    const bs: Record<string, number> = {};
    for (const c of res.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
    this.raw = bs;
    // one eye tracked: the covered eye's channels become copies of the visible eye's (before anything reads them)
    const eyeRaw = { b: [bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0] as [number, number], e: [0, 0] as [number, number] };
    if (lm.length > 400) eyeRaw.e = [eyeAspect(lm, aspect, 'left'), eyeAspect(lm, aspect, 'right')];
    if (this.eyesTracked !== 'both') mirrorEyeChannels(bs, this.eyesTracked);

    // ---- head pose ----
    let head: Vec3 = [0, 0, 0];
    let headPos: Vec3 = [0, 0, 0];
    const mat = res.facialTransformationMatrixes?.[0];
    if (mat) {
      this.m.fromArray(mat.data);
      this.m.decompose(this.pos, this.q, this.scl);
      this.e.setFromQuaternion(this.q, 'YXZ');
      head = [this.e.y, this.e.x, this.e.z];
    }
    // Head position from landmarks (full-frame coords, so it's independent of the zoomed tracking ROI).
    // metricHead: scale-free measurement [u, v, s] of the rigid face (headMetric.ts) — converted to metres
    // below, relative to the rest measurement. Legacy: cm from the eye-corner span at an assumed 62° FOV.
    const hm = measureHead(lm, aspect);
    this.measure = hm;
    let legacyPos: Vec3;
    {
      const a = lm[33], b = lm[263];
      const sw = Math.hypot(b.x - a.x, (b.y - a.y) / aspect, b.z - a.z) || 1e-3;
      const Z = 0.075 / sw; // metres
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      legacyPos = [(mx - 0.5) * 1.2 * Z * 100, (0.5 - my) * (1.2 / aspect) * Z * 100, -Z * 100];
      // old calibrations stored that cm position: convert the rest to the new scale-free measurement,
      // averaging the conversion over the first frontal frames (so the rest anchor doesn't jump)
      const c = this.calib;
      if (this.metricHead && c && c.posV !== 3) {
        const old = (this.posUpgrade?.old ?? [...c.headPos]) as Vec3;
        const u0 = this.posUpgrade ?? { n: 0, k: 0, du: 0, dv: 0, old };
        const frontal = Math.abs(head[0] - c.head[0]) < 0.12 && Math.abs(head[1] - c.head[1]) < 0.12;
        if (frontal || u0.n === 0) {
          const w = 1 / (u0.n + 1);
          u0.k += (hm.s / sw - u0.k) * w; u0.du += (hm.u - mx - u0.du) * w; u0.dv += (hm.v - my - u0.dv) * w; u0.n++;
        }
        this.posUpgrade = u0;
        const Zr = Math.max(0.05, -old[2] / 100);
        const mxr = old[0] / (120 * Zr) + 0.5, myr = 0.5 - (old[1] * aspect) / (120 * Zr);
        c.headPos = [mxr + u0.du, myr + u0.dv, (0.075 / Zr) * u0.k];
        if (u0.n >= 30) { c.posV = 3; this.posUpgrade = null; saveCalibration(c); }
      }
    }
    if (this.metricHead) {
      headPos = [hm.u, hm.v, hm.s];
      // learn the performer's face size from the iris on frontal, open-eyed, gaze-centred frames
      const c = this.calib;
      const frontal = !!mat && Math.abs(head[0] - (c?.head[0] ?? 0)) < 0.15 && Math.abs(head[1] - (c?.head[1] ?? 0)) < 0.15 &&
        (bs.eyeBlinkLeft ?? 0) < 0.35 && (bs.eyeBlinkRight ?? 0) < 0.35 &&
        Math.max(bs.eyeLookOutLeft ?? 0, bs.eyeLookInLeft ?? 0, bs.eyeLookOutRight ?? 0, bs.eyeLookInRight ?? 0) < 0.3;
      this.metric.learn(hm, frontal);
    } else headPos = legacyPos;

    // ---- eyes: aspect ratio + iris ----
    const ear = (E: typeof EYE.left) =>
      (dist(lm[E.up1], lm[E.lo1], aspect) + dist(lm[E.up2], lm[E.lo2], aspect)) /
      (2 * dist(lm[E.outer], lm[E.inner], aspect) + 1e-6);
    let earL = ear(EYE.left), earR = ear(EYE.right);
    if (this.eyesTracked === 'left') earR = earL; else if (this.eyesTracked === 'right') earL = earR;
    if (this.eyesTracked === 'both') this.oneEye.observe(eyeRaw.b, eyeRaw.e, Math.abs(head[0] - (this.calib?.head[0] ?? 0)) < 0.3 && Math.abs(head[1] - (this.calib?.head[1] ?? 0)) < 0.3, t);
    const gazeRaw = this.irisGaze(lm, aspect, bs);
    // Lip gap (inner lips 13/14) over eye-corner span: measures the lips directly, so beards,
    // stubble and dark chins that fool jawOpen can't hide an open mouth.
    // blinks never open the mouth (blinkMouthGuard.ts): how shut the eyes are (EAR against the open eye, the more shut
    // eye) and whether MediaPipe's own jawOpen confirms an opening
    {
      const shutOf = (e: number, o: number) => clamp01(1 - (e - o * 0.35) / (o * 0.6));
      const shut = Math.max(shutOf(earL, this.calib?.earOpen[0] ?? this.earOpen[0]), shutOf(earR, this.calib?.earOpen[1] ?? this.earOpen[1]));
      this.blinkGuard.step(t, shut, (bs.jawOpen ?? 0) - (this.openBase.jawOpen ?? this.calib?.neutral.jawOpen ?? 0));
    }
    const lipGap = this.blinkGuard.value('_lipGap', dist(lm[13], lm[14], aspect) / (dist(lm[33], lm[263], aspect) + 1e-6));
    this.lipGap = lipGap;
    bs._lipGap = lipGap;
    // Geometric brows (landmarks, interocular units): MediaPipe's brow blendshapes barely move for
    // some faces, but the brow landmarks do. Height of mid/inner brow above the eye + inner-brow gap.
    {
      const s3 = (i: number, j: number) => Math.hypot((lm[i].x - lm[j].x), (lm[i].y - lm[j].y) / aspect, lm[i].z - lm[j].z);
      const sEye = s3(33, 263) || 1e-3;
      const up = (brow: number, eye: number) => ((lm[eye].y - lm[brow].y) / aspect) / sEye; // image y down → + = brow above eye
      bs._browL = up(334, 386); bs._browR = up(105, 159);
      bs._browInL = up(285, 362); bs._browInR = up(55, 133);
      bs._furrow = s3(285, 55) / sEye;
    }
    const feats = measureMouth(lm, aspect);
    this.feats = feats;
    const mStats = (res as FaceResultPlus).mouthImage;
    // ---- mouth visibility: lip colour vs its surroundings (patch) + hands over the lips → 0 (hidden) … 1 (seen)
    let mouthVis = 1;
    try {
      const lips = LIP_OUTER.map((i) => ({ x: lm[i].x * aspect, y: lm[i].y }));
      const hc = this.hands ? handCover(lips, this.hands.map((h) => h.map((p) => ({ x: p.x * aspect, y: p.y })))) : -1;
      // the per-performer raw lip gap (as below, from the rest learned so far): lips seen apart = a visible mouth
      const lr = this.openRest('_lipGap'), ln = Math.min(this.calib?.neutral._lipGap ?? 0.02, lr !== null ? lr + 0.004 : Infinity);
      mouthVis = this.mouthVis.step(t, dt, mStats?.raw ?? null, hc, clamp01((lipGap - ln) / 0.26));
    } catch { mouthVis = 1; }
    // a hidden mouth's landmarks are MediaPipe's guess (a calm closed mouth): never learn rest / neutral from them
    const mouthHidden = mouthVis < 0.5;
    if (mStats) {
      const calmClosed = feats.gap < 0.03 && (bs.jawOpen ?? 0) < 0.2;
      const mi = this.mouthModel.step(mStats, calmClosed, dt);
      if (mi) this.mouthImg = { t, _tongueOut: mi._tongueOut, _tongueUp: mi._tongueUp, _teethShow: mi._teethShow, _cavity: mi._cavity };
    }
    const poseX = [1, head[1] - (this.calib?.head[1] ?? 0), head[0] - (this.calib?.head[0] ?? 0), wrapPi(head[2] - (this.calib?.head[2] ?? 0))];
    if (!mouthHidden) this.adaptGeoNeutral(feats, bs, dt, poseX);
    // inner-lip contour (shape capture)
    const lc = lipContour(lm, aspect, this.lipHalfW0);
    const calmLips = feats.gap < 0.03 && (bs.jawOpen ?? 0) < 0.25 && (bs.mouthPucker ?? 0) < 0.35;
    if ((calmLips && !mouthHidden) || this.lipSeen < 30) {
      const k = this.lipSeen < 30 ? 1 / (this.lipSeen + 1) : 1 - Math.exp(-dt / 8);
      this.lipHalfW0 = this.lipHalfW0 ? this.lipHalfW0 + (lc.halfW - this.lipHalfW0) * k : lc.halfW;
      if (calmLips) for (let i = 0; i < LIP_T.length; i++) { this.lipRestU[i] += (lc.u[i] - this.lipRestU[i]) * k; this.lipRestL[i] += (lc.l[i] - this.lipRestL[i]) * k; }
      this.lipSeen++;
    }
    const lu = lc.u.map((v, i) => this.mouthFilt.filter(`_lu${i}`, Math.max(0, v - this.lipRestU[i]), t));
    const ll = lc.l.map((v, i) => this.mouthFilt.filter(`_ll${i}`, Math.min(0, v - this.lipRestL[i]), t));
    this.lipsRaw = { u: lu, l: ll };

    // resting (closed-mouth) opening, learned from the data: a calibration taken mid-sentence must not
    // push the zero point up and swallow every syllable (see OPEN_REST)
    bs._geoGap = feats.gap;
    const geoN = this.poseGeo(poseX);
    const restGeoGap = this.openRest('_geoGap');
    const geoNeutral = geoN && restGeoGap !== null && restGeoGap < geoN.gap ? { ...geoN, gap: restGeoGap } : geoN;
    const geoRaw = geoChannels(feats, geoNeutral);
    for (const k in geoRaw) bs[k] = geoRaw[k];
    for (const k of ['_geoGap', '_gOpen', '_gUpperUp', '_gLowerDown', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight']) bs[k] = this.blinkGuard.value(k, bs[k] ?? 0);
    const lipShapes = lipShapeChannels(feats, geoNeutral, bs, this.restFor());

    // (legacy mode) old calibrations stored matrix-based head position — re-anchor to the current pose once
    if (!this.metricHead && this.calib && this.calib.posV !== 2) { this.calib.headPos = [...headPos] as Vec3; this.calib.posV = 2; saveCalibration(this.calib); }

    // ---- calibration capture ----
    if (this.calibrating) {
      this.calibrating.samples.push({ bs: { ...bs }, head, pos: headPos, gaze: gazeRaw, ear: [earL, earR], feats });
      if (t >= this.calibrating.until) this.finishCalibration();
    } else if (!this.calib) {
      // Auto-calibrate after ~1.5 s of stable tracking so first-time users get sane defaults.
      if (this.stableSince < 0) this.stableSince = t;
      else if (t - this.stableSince > 1.5) void this.calibrate(1.2);
    }
    if (this.capture) for (const ch of this.capture.channels) this.capture.max[ch] = Math.max(this.capture.max[ch] ?? 0, bs[ch] ?? 0);

    // resting-tension baseline, sampled 5×/s
    this.restTick += dt;
    if (this.restTick > 0.2) {
      this.restTick = 0;
      for (const name of TENSION) {
        if (mouthHidden && name.startsWith('mouth')) continue;
        const h = this.restHist.get(name) ?? [];
        h.push(bs[name] ?? 0);
        if (h.length > 150) h.shift();
        this.restHist.set(name, h);
        // tension channels rest at their low quartile; brow GEOMETRY (height/gap) rests at its median,
        // otherwise a frown would read as the resting brow
        const q = name.startsWith('_') ? 0.5 : 0.25;
        if (h.length >= 10) { const srt = [...h].sort((a, b) => a - b); this.restBase[name] = srt[Math.floor(srt.length * q)]; }
      }
      // opening channels rest at their LOW end (10th percentile of ~30 s): talking people close their lips
      // between words, so this finds the closed mouth even when the calibration caught it open
      for (const name of OPEN_REST) {
        if (mouthHidden) continue;
        const h = this.openHist.get(name) ?? [];
        h.push(bs[name] ?? 0);
        if (h.length > 150) h.shift();
        this.openHist.set(name, h);
        if (h.length >= 10) { const srt = [...h].sort((a, b) => a - b); this.openBase[name] = srt[Math.floor(srt.length * 0.1)]; }
      }
    }
    const cal = this.calib;
    const { minCutoff, beta } = smoothingToOneEuro(tune.smoothing);
    this.filt.minCutoff = minCutoff * 1.6; // expressions tolerate less lag than head pose
    this.filt.beta = beta * 2;
    // mouth: jitter-free at rest, near-zero lag when moving (One Euro beta scales cutoff with speed)
    this.mouthFilt.minCutoff = minCutoff * 3.5;
    this.mouthFilt.beta = 1.2 * (1.1 - tune.smoothing);
    const fl = (name: string) => (name.startsWith('mouth') || name.startsWith('jaw') || name.startsWith('_g') || name === '_lip' ? this.mouthFilt : this.filt);
    this.headFilt.minCutoff = minCutoff;
    this.headFilt.beta = beta;

    // ---- amplify every channel ----
    const amplify = (name: string, raw: number, n: number, def: number) => {
      // Live personal peak: rises instantly, decays very slowly; hard floor so a quiet channel
      // can't blow noise up to full intensity.
      const calPeak = cal?.peaks[visibleKey(name, this.eyesTracked)];
      const floorPeak = Math.max(n + 0.12, (calPeak ?? def) * 0.85);
      let lp = this.livePeak[name] ?? (calPeak ?? def);
      lp = Math.max(raw, lp - 0.01 * dt, floorPeak);
      this.livePeak[name] = lp;
      const dz = 0.015;
      let v = clamp01((raw - n - dz) / Math.max(0.05, lp - n - dz));
      return 1 - Math.pow(1 - v, 1.6); // ease-out: small real motions read clearly
    };
    const classicN = (name: string) => {
      const n0 = cal?.neutral[visibleKey(name, this.eyesTracked)] ?? 0;
      return TENSION.has(name) ? Math.max(n0, this.restBase[name] ?? 0)
        : OPEN_REST.has(name) && this.openBase[name] !== undefined ? Math.min(n0, this.openBase[name] + 0.01) : n0;
    };
    // ---- natural capture: relaxed face per pose, noise floor, typical expression size (naturalCapture.ts) ----
    const nat = this.natural.enabled ? this.natural : null;
    if (nat) {
      // without a voice hint, a moving jaw (above its closed rest) means talking
      const jawEx = (bs.jawOpen ?? 0) - (this.openBase.jawOpen ?? cal?.neutral.jawOpen ?? 0);
      this.camTalk = Math.max(smoothstep(0.04, 0.12, jawEx), this.camTalk - dt / 0.4);
      nat.observe(bs, classicN, { pitch: poseX[1], yaw: poseX[2], roll: poseX[3], jaw: bs.jawOpen ?? 0, gazeY: gazeRaw[1] - (cal?.gaze[1] ?? 0), blink: ((bs.eyeBlinkLeft ?? 0) + (bs.eyeBlinkRight ?? 0)) / 2,
        speaking: this.speaking >= 0 ? this.speaking : this.camTalk, t, dt, frozen: !!this.calibrating || !cal });
    }
    const out: Record<string, number> = {};
    for (const name of ARKIT) {
      if (name.startsWith('eyeBlink') || name.startsWith('eyeLook')) continue;
      const n = classicN(name);
      let v = amplify(name, bs[name] ?? 0, n, DEFAULT_PEAK[name] ?? 0.5);
      if (nat) v = nat.map(visibleKey(name, this.eyesTracked), bs[name] ?? 0, v) ?? v;
      const gain = (tune.gains[name] ?? 1) * tune.expressiveness;
      const isMouth = name.startsWith('mouth') || name.startsWith('jaw');
      out[name] = clamp01(this.legacyFilters || isMouth
        ? fl(name).filter(name, v * gain, t)
        // brows / eyes / cheeks / nose: Kalman + prediction (the mouth keeps its audio-fused path)
        : this.exprKal.filter(name, v * gain, t, lerp(this.exprTuning.sigmaA[0], this.exprTuning.sigmaA[1], clamp01(tune.smoothing)), this.exprTuning.sigmaM, this.lead));
    }

    // ---- facial-hair-robust lip geometry fusion ----
    // Weight 0.45 on clean-shaven faces (geometry still helps), up to 1 with a full beard.
    const hair = tune.facialHair >= 0 ? tune.facialHair : Math.max(this.hair.score, this.hair.moustache * 0.8);
    // lip geometry is measured in a frontal frame; trust it less as the head turns away
    const yawOff = Math.abs(head[0] - (cal?.head[0] ?? 0));
    const poseTrust = 1 - smoothstep(0.25, 0.6, yawOff);
    this.hairWeight = (0.45 + 0.55 * clamp01(hair)) * poseTrust;
    for (const [g, targets] of Object.entries(GEO_TO_ARKIT)) {
      const ga = amplify(g, bs[g] ?? 0, 0, 0.8);
      const gv = clamp01(fl(g).filter(g, nat ? nat.map(g, bs[g] ?? 0, ga) ?? ga : ga, t));
      this.geo[g] = gv;
      for (const a of targets) {
        const gain = (tune.gains[a] ?? 1) * tune.expressiveness;
        const fused = Math.max(out[a] ?? 0, gv * gain * this.hairWeight);
        // with heavy facial hair the geometric reading also pulls a too-high blendshape down
        out[a] = clamp01(THREE.MathUtils.lerp(fused, gv * gain, clamp01(hair) * 0.35 * poseTrust));
      }
    }
    // Rounding only when the lips are GENUINELY rounded: MediaPipe's pucker/funnel (amplified off a bearded
    // resting pucker) saturate on ordinary syllables ("quick brown" → 0.98), which procedural mouths draw as
    // a tiny 'o'. Cap them by the geometric rounding (corners narrowing + lips everting, _lipRound).
    {
      const cap = clamp01((lipShapes._lipRound - 0.2) / 0.6);
      const pk = this.mouthFilt.filter('_roundCap', cap, t);
      out.mouthPucker = Math.min(out.mouthPucker ?? 0, pk);
      out.mouthFunnel = Math.min(out.mouthFunnel ?? 0, pk * 0.85);
    }
    // smiling corners can't simultaneously be frowning
    const sm = Math.max(out.mouthSmileLeft ?? 0, out.mouthSmileRight ?? 0);
    out.mouthFrownLeft = (out.mouthFrownLeft ?? 0) * (1 - sm);
    out.mouthFrownRight = (out.mouthFrownRight ?? 0) * (1 - sm);

    // ---- lip-gap fusion ----
    const lipRest = this.openRest('_lipGap');
    const lipN = Math.min(cal?.neutral._lipGap ?? 0.02, lipRest !== null ? lipRest + 0.004 : Infinity);
    let lipOpen = clamp01((lipGap - lipN - 0.012) / 0.26);
    lipOpen = 1 - Math.pow(1 - lipOpen, 1.4);
    lipOpen = clamp01(this.mouthFilt.filter('_lip', lipOpen * tune.expressiveness * (tune.gains.jawOpen ?? 1), t));
    this.lipOpen = lipOpen;
    // per-user normalised RAW lip gap (unfiltered: brief bilabial closures survive) for speechFusion's synced dip detector
    out._lipOpen = clamp01((lipGap - lipN) / 0.26);
    // brief bilabial seals (M / B / P): MediaPipe's jawOpen barely moves for a 50 ms "p" and the lip gap only dips to
    // ~5-10 % of the open range, so the camera mouth never shut on them (rig harness: 0/11 camera-only). A RELATIVE dip
    // of the raw gap against its last 150 ms peak is the camera's own closure cue (tracking_rnd3/cam/dip.py: 9/11 M/B/P
    // events, 0 % of neutral frames) → close the jaw channels for its duration. No added latency: the frame that shows
    // the dip closes. Off: FaceSolver.camSeal = false.
    {
      const gN = out._lipOpen, h = this.sealHist;
      h.push({ t, v: gN });
      while (h.length > 2 && h[0].t < t - 0.15) h.shift();
      let pk = 0;
      for (const x of h) pk = Math.max(pk, x.v);
      // (the "near closed" bar rises for a slower camera, as in speechFusion's synced detector: 30 fps rarely catches
      // the single ~0.08 frame a 47 Hz camera sees at the bottom of a "p")
      if (dt < 0.2) this.frameIv += (dt - this.frameIv) * 0.1;
      const slow = clamp01((this.frameIv - 0.027) / 0.013);
      const seal = clamp01((1 - gN / Math.max(pk, 1e-3)) * smoothstep(0.1, 0.25, pk) * smoothstep(0.2 + 0.06 * slow, 0.06 + 0.04 * slow, gN));
      out._lipSealDip = seal;
      if (this.camSeal && seal > 0.3 && mouthVis > 0.6) {
        // the filtered jaw lags the dip: follow the raw gap down for the seal's duration
        const w = smoothstep(0.3, 0.7, seal), k = 1 - 0.85 * w;
        const j = out.jawOpen ?? 0;
        out.jawOpen = j + (Math.min(j, gN * 0.4) - j) * w;
        for (const ch of ['mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight']) out[ch] = (out[ch] ?? 0) * k;
      }
    }
    out.jawOpen = Math.max(out.jawOpen ?? 0, lipOpen * 0.95);
    // a static, slightly open resting mouth (relaxed jaw, beard, looking up at the screen) is not talking: every
    // lip-opening channel is measured from the slack floor instead (slackMouth.ts); the raw _lipOpen stays for the
    // closure detectors. _lipAct = how much the lips move like speech (speechFusion: a voice the lips don't follow is
    // someone else's)
    let lipK = 1;
    {
      this.lipRestN = lipN;
      // (head rotation speed from the raw pose: a fast turn distorts the lip landmarks — not talking)
      const hp = this.slackHead;
      const hs = hp ? Math.hypot(wrapPi(head[0] - hp[0]), head[1] - hp[1], wrapPi(head[2] - hp[2])) / dt : 0;
      this.slackHead = [head[0], head[1], head[2]];
      this.slackHeadSpeed += (Math.min(hs, 10) - this.slackHeadSpeed) * (1 - Math.exp(-dt / 0.1));
      const sk = this.slack.step(lipGap, lipN, dt, mouthVis > 0.6, smoothstep(0.25, 0.55, lipShapes._lipRound ?? 0), this.slackHeadSpeed);
      const k = this.slackGate ? clamp01(this.mouthFilt.filter('_slackK', sk, t)) : 1;
      out._lipAct = this.slack.talk;
      out._slackK = k;
      if (k < 0.999) {
        for (const ch of ['jawOpen', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight']) out[ch] = (out[ch] ?? 0) * k;
        lipOpen *= k;
        this.lipOpen = lipOpen;
        lipK = k;
      }
    }
    out._mouthVis = mouthVis;
    // lips visibly apart → they aren't "closed", whatever mouthClose says
    if (lipOpen > 0.15) out.mouthClose = (out.mouthClose ?? 0) * (1 - lipOpen);

    // ---- raw speech lip shapes + mouth-interior image channels for the viseme engine ----
    // (underscore channels: never drive blendshapes directly; see mouthGeometry.lipShapeChannels / mouthImage.ts)
    {
      const ls = lipShapes;
      for (const k in ls) out[k] = clamp01(this.mouthFilt.filter(k, ls[k], t));
      const mi = this.mouthImg;
      if (mi && t - mi.t < 0.25 && this.imageChannels) {
        // (an occluder's pixels are neither teeth nor tongue: scaled by the visibility)
        for (const k of ['_tongueOut', '_tongueUp', '_teethShow', '_cavity'] as const) out[k] = clamp01(this.mouthFilt.filter(k, mi[k] * mouthVis, t));
        // tongue drives the avatar only when enabled (tongueFromCamera) — false positives mid-speech look bad
        if (this.tongueFromCamera) out.tongueOut = Math.max(out.tongueOut ?? 0, smoothstep(0.35, 0.75, out._tongueOut));
      } else out._teethShow = out._teethGeo;
    }

    // ---- blinks ----
    // a new glasses reading from the facial-hair readback (~1×/s)
    if (this.hair.glassesN !== this.glassesSeen) {
      this.glassesSeen = this.hair.glassesN;
      if (this.hair.glassesRaw !== null) this.glassesState.update(this.hair.glassesRaw, Math.min(5, Math.max(0.2, t - this.glassesT)));
      this.glassesT = t;
    }
    const gl = this.glasses;
    const irisOf = (E: typeof EYE.left): [number, number] | null => {
      if (lm.length < 478) return null;
      const o = lm[E.outer], i = lm[E.inner], c = lm[E.iris], span = Math.hypot((o.x - i.x) * aspect, o.y - i.y) || 1e-3;
      return [((c.x - (o.x + i.x) / 2) * aspect) / span, (c.y - (o.y + i.y) / 2) / span];
    };
    const blink = (side: 0 | 1, bsv: number, earv: number) => {
      // rolling floor: follow drops instantly, rise slowly (glasses / oblique cams read high at rest)
      this.blinkFloor[side] = Math.min(bsv, this.blinkFloor[side] + 0.02 * dt);
      this.blinkPeak[side] = Math.max(bsv, this.blinkPeak[side] - 0.01 * dt, this.blinkFloor[side] + 0.35);
      const bsN = clamp01((bsv - this.blinkFloor[side]) / (this.blinkPeak[side] - this.blinkFloor[side]));
      const eo = this.eyesTracked === 'left' ? 0 : this.eyesTracked === 'right' ? 1 : side; // one eye: its own open EAR
      const open = cal?.earOpen[eo] ?? this.earOpen[side];
      if (!cal) this.earOpen[side] = Math.max(earv, this.earOpen[side] - 0.01 * dt);
      const earN = clamp01(1 - (earv - open * 0.35) / (open * 0.6));
      const tr = this.eyeTrust.step(side, bsN, earN, irisOf(side === 0 ? EYE.left : EYE.right), dt, gl);
      // glasses / an untrustworthy eye: a real blink moves BOTH cues — lean on the one that says "more open"
      // (glasses add a little more lean, but only for an eye whose cues already disagree)
      const lean = 0.6 * (1 - tr) + (gl ? 0.2 * (1 - smoothstep(0.5, 0.8, tr)) : 0);
      return clamp01((bsN * 0.5 + earN * 0.5) * (1 - lean) + Math.min(bsN, earN) * lean);
    };
    // Far eye is foreshortened when the head turns — trust the nearer eye more.
    const yawAbs = Math.abs(head[0] - (cal?.head[0] ?? 0));
    let bL = blink(0, bs.eyeBlinkLeft ?? 0, earL);
    let bR = blink(1, bs.eyeBlinkRight ?? 0, earR);
    if (yawAbs > 0.35) { const avg = (bL + bR) / 2; bL = bR = avg; }
    // glasses: a one-eyed closure is a reflection / rim until it holds like a deliberate wink (≥ 0.15 s) or the cheek
    // on that side lifts with it (a squint / wink raises the cheek, a reflection doesn't)
    // glasses AND eyes that can't be trusted: the cues disagree right now, or brief one-eyed "blinks" (≤ 0.15 s, no cheek
    // lift: glare on a lens, a rim over the lid) keep happening (≥ 2 in the last ~20 s). A false glasses reading on a face
    // whose eyes read cleanly changes nothing.
    if (gl) {
      this.glare *= Math.exp(-dt / 20);
      const track = (me: number, other: number, k: 0 | 1, cheek: number) => {
        if (me - other >= 0.3) this.oneSided[k] += dt;
        else { if (this.oneSided[k] > 0 && this.oneSided[k] < 0.15 && cheek <= 0.35) this.glare += 1; this.oneSided[k] = 0; }
        return this.oneSided[k] >= 0.15 || cheek > 0.35;
      };
      const wl = track(bL, bR, 0, bs.cheekSquintLeft ?? 0), wr = track(bR, bL, 1, bs.cheekSquintRight ?? 0);
      const glLow = Math.min(this.eyeTrust.trust[0], this.eyeTrust.trust[1]) < 0.6 || this.glare >= 1.5;
      this.glLow = glLow;
      if (glLow) {
        if (!wl && bL - bR >= 0.3) bL = bR + 0.1;
        if (!wr && bR - bL >= 0.3) bR = bL + 0.1;
      }
    } else { this.glLow = false; this.glare = 0; this.oneSided = [0, 0]; }
    const glLow = this.glLow;
    // Link near-symmetric blinks (removes lazy-eye jitter) but keep real winks.
    if (Math.abs(bL - bR) < 0.3) { const m = Math.max(bL, bR) * 0.7 + Math.min(bL, bR) * 0.3; bL = bR = m; }
    // neither eye readable for a while (glare, both lenses): natural blinks of our own instead of a stuck / twitching lid
    const trustMax = Math.max(this.eyeTrust.trust[0], this.eyeTrust.trust[1]);
    this.eyesLost = trustMax < 0.3 ? this.eyesLost + dt : Math.max(0, this.eyesLost - dt * 2);
    const lostK = smoothstep(0.7, 1.5, this.eyesLost);
    if (lostK > 0) { const ab = this.autoBlink.step(dt); bL = bL * (1 - lostK) + ab * lostK; bR = bR * (1 - lostK) + ab * lostK; }
    const shape = (x: number) => (glLow ? smoothstep(0.24, 0.75, x) : smoothstep(0.18, 0.72, x));
    out.eyeBlinkLeft = this.blinkL.step(shape(bL), dt);
    out.eyeBlinkRight = this.blinkR.step(shape(bR), dt);

    // ---- gaze ----
    const gc = this.eyesTracked === 'both' ? cal?.gaze ?? [0, 0] : this.oneEyeGazeRest(gazeRaw);
    let gx = gazeRaw[0] - gc[0];
    let gy = gazeRaw[1] - gc[1];
    // gentle dead zone around "looking at the screen" so eyes don't shimmer
    const dzG = 0.06;
    gx = Math.sign(gx) * Math.max(0, Math.abs(gx) - dzG) / (1 - dzG);
    gy = Math.sign(gy) * Math.max(0, Math.abs(gy) - dzG) / (1 - dzG);
    // eyes the camera can't read well (glasses glare): the gaze eases toward the head's own direction (straight ahead)
    {
      const tr = this.eyesTracked === 'left' ? this.eyeTrust.trust[0] : this.eyesTracked === 'right' ? this.eyeTrust.trust[1] : Math.max(this.eyeTrust.trust[0], this.eyeTrust.trust[1]);
      const gk = 0.35 + 0.65 * smoothstep(0.2, 0.7, tr);
      gx *= gk; gy *= gk;
    }
    gx = this.filt.filter('_gx', clamp(gx, -1, 1), t);
    gy = this.filt.filter('_gy', clamp(gy, -1, 1), t);
    // eyeLook* channels for rigs that have them
    out.eyeLookOutLeft = clamp01(gx); out.eyeLookInRight = clamp01(gx);
    out.eyeLookInLeft = clamp01(-gx); out.eyeLookOutRight = clamp01(-gx);
    out.eyeLookDownLeft = out.eyeLookDownRight = clamp01(gy);
    out.eyeLookUpLeft = out.eyeLookUpRight = clamp01(-gy);

    // ---- head relative to rest ----
    const hc = cal?.head ?? [0, 0, 0];
    const pc = cal?.headPos ?? headPos;
    const s = tune.headRotationScale;
    // rotation + position relative to rest
    let rel: [number, number, number, number, number, number];
    if (this.metricHead) {
      // true rotation (crop-relative rotation ∘ line of sight) for now and for the rest pose
      let hNow = head;
      if (mat) { this.metric.trueRotation(this.q, hm, aspect, this.qTrue); this.e.setFromQuaternion(this.qTrue, 'YXZ'); hNow = [this.e.y, this.e.x, this.e.z]; }
      const restM: HeadMeasure = cal && (cal.posV === 3 || this.posUpgrade) ? { u: pc[0], v: pc[1], s: pc[2], iris: 0 } : hm;
      this.eRest.set(hc[1], hc[0], hc[2], 'YXZ');
      this.qRest.setFromEuler(this.eRest);
      this.metric.trueRotation(this.qRest, restM, aspect, this.qRest);
      this.eRest.setFromQuaternion(this.qRest, 'YXZ');
      this.metric.pivot(restM, aspect, cal ? this.qRest : mat ? this.qTrue : null, this.pRest);
      this.metric.pivot(hm, aspect, mat ? this.qTrue : null, this.pNow); // last: records this frame's Z
      rel = [hNow[0] - this.eRest.y, hNow[1] - this.eRest.x, wrapPi(hNow[2] - this.eRest.z),
        this.pNow.x - this.pRest.x, this.pNow.y - this.pRest.y, this.pNow.z - this.pRest.z];
    } else {
      rel = [head[0] - hc[0], head[1] - hc[1], wrapPi(head[2] - hc[2]), (headPos[0] - pc[0]) / 100, (headPos[1] - pc[1]) / 100, (headPos[2] - pc[2]) / 100];
    }
    this.relRaw = rel;
    let yaw: number, pitch: number, roll: number, px: number, py: number, pz: number;
    let vel: Vec3 = [0, 0, 0], pvel: Vec3 = [0, 0, 0];
    if (this.legacyFilters) {
      yaw = this.headFilt.filter('y', rel[0] * s, t);
      pitch = this.headFilt.filter('p', rel[1] * s, t);
      roll = this.headFilt.filter('r', rel[2] * s, t);
      px = this.headFilt.filter('x', rel[3], t);
      py = this.headFilt.filter('yy', rel[4], t);
      pz = this.headFilt.filter('z', rel[5], t);
    } else if (this.headTuning.mode === 'kalman') {
      // constant-velocity Kalman per channel + confidence-gated prediction to display time
      const ht = this.headTuning, K = this.headKal, L = this.lead;
      const sa = lerp(ht.sigmaA[0], ht.sigmaA[1], clamp01(tune.smoothing));
      const M = ht.sigmaM;
      if (this.stabilize) {
        // same Kalman + prediction in motion, but locked by the stabiliser at rest (stabilizer.ts)
        const R = this.headRotStab, P = this.headPosStab;
        R.tune(0, sa, M.y); R.tune(1, sa, M.p); R.tune(2, sa, M.r);
        P.tune(0, sa * 0.25, M.x); P.tune(1, sa * 0.2, M.yy); P.tune(2, sa * 0.3, M.z);
        [yaw, pitch, roll] = R.step([rel[0] * s, rel[1] * s, rel[2] * s], t, L);
        [px, py, pz] = P.step([rel[3], rel[4], rel[5]], t, L);
        vel = [R.vel[0], R.vel[1], R.vel[2]];
        pvel = [P.vel[0], P.vel[1], P.vel[2]];
      } else {
        yaw = K.filter('y', rel[0] * s, t, sa, M.y, L);
        pitch = K.filter('p', rel[1] * s, t, sa, M.p, L);
        roll = K.filter('r', rel[2] * s, t, sa, M.r, L);
        px = K.filter('x', rel[3], t, sa * 0.25, M.x, L);
        py = K.filter('yy', rel[4], t, sa * 0.2, M.yy, L);
        pz = K.filter('z', rel[5], t, sa * 0.3, M.z, L * 0.5);
        vel = [K.vel('y'), K.vel('p'), K.vel('r')];
        pvel = [K.vel('x'), K.vel('yy'), K.vel('z')];
      }
    } else {
      // speed-normalised One Euro + prediction (rotation in rad, position in m; depth is noisier)
      const sm = clamp01(tune.smoothing);
      const H = this.headLead, L = this.lead;
      const ht = this.headTuning;
      H.minCutoff = lerp(ht.minCutoff[0], ht.minCutoff[1], sm); H.beta = lerp(ht.beta[0], ht.beta[1], sm);
      H.gateLo = ht.gate[0]; H.gateHi = ht.gate[1]; H.dCutoff = ht.dCutoff; H.deadband = ht.deadband;
      yaw = H.filter('y', rel[0] * s, t, 1.0, L);
      H.deadband = ht.pitchDeadband;
      pitch = H.filter('p', rel[1] * s, t, 0.8, L);
      H.deadband = ht.deadband;
      roll = H.filter('r', rel[2] * s, t, 0.8, L);
      px = H.filter('x', rel[3], t, 0.25, L);
      py = H.filter('yy', rel[4], t, 0.2, L);
      pz = H.filter('z', rel[5], t, 0.5, L * 0.5);
    }

    let face = out;
    // gaze in avatar space: +yaw = toward avatar's left (+X), +pitch = down
    let gazeYaw = gx, gazePitch = gy;
    if (tune.mirror) {
      face = {};
      for (const k in out) face[mirrorName(k)] = out[k];
      yaw = -yaw; roll = -roll; px = -px; gazeYaw = -gazeYaw;
      vel = [-vel[0], vel[1], -vel[2]]; pvel = [-pvel[0], pvel[1], pvel[2]];
    }

    const avg = (a: string, b: string) => ((face[a] ?? 0) + (face[b] ?? 0)) / 2;
    const open = clamp01((face.jawOpen ?? 0) - (face.mouthClose ?? 0) * 0.6 +
      avg('mouthLowerDownLeft', 'mouthLowerDownRight') * 0.25 + avg('mouthUpperUpLeft', 'mouthUpperUpRight') * 0.1);

    const frame: TrackingFrame = {
      t,
      face,
      head: [clamp(yaw, -1.3, 1.3), clamp(pitch, -1, 1), clamp(roll, -0.9, 0.9)],
      headPos: [clamp(px, -0.8, 0.8), clamp(py, -0.5, 0.5), clamp(pz, -1, 1)],
      headVel: vel,
      posVel: pvel,
      gaze: [gazeYaw, gazePitch],
      // (the slack gain is applied on the copy the frame gets anyway; lipsRaw keeps the unscaled contour)
      lips: tune.mirror ? { u: scaledRev(lu, lipK), l: scaledRev(ll, lipK) } : lipK < 0.999 ? { u: scaledRev(lu, lipK, false), l: scaledRev(ll, lipK, false) } : { u: lu, l: ll },
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

  /**
   * Keep the lip-geometry neutral right without asking: capture it from calm closed-mouth frames if
   * missing (old calibrations), then drift slowly toward the current rest shape so posture and
   * lighting changes don't leave a permanent fake pucker/press.
   */
  private geoCalm: MouthFeatures[] = [];
  /** Resting lip geometry predicted for the current head pose (null before any neutral exists). */
  private poseNeutral = new PoseNeutral(0.9995);
  private poseTick = 0;
  private poseGeo(x: number[]): MouthFeatures | null {
    const g = this.calib?.geo;
    if (!g) return null;
    if (!this.poseNeutral.seeded) this.poseNeutral.seed(g as unknown as Record<string, number>);
    const out = {} as MouthFeatures;
    for (const k of FEATURE_KEYS) out[k] = this.poseNeutral.predict(x, k);
    return out;
  }

  private adaptGeoNeutral(f: MouthFeatures, bs: Record<string, number>, dt: number, x: number[]) {
    void dt;
    const calm = f.gap < 0.03 && (bs.mouthSmileLeft ?? 0) < 0.25 && (bs.mouthSmileRight ?? 0) < 0.25 &&
      (bs.mouthPucker ?? 0) < 0.3 && (bs.jawOpen ?? 0) < 0.25 && (bs.mouthFunnel ?? 0) < 0.2;
    if (!calm || this.calibrating) return;
    const cal = this.calib;
    if (!cal) return;
    if (!cal.geo) {
      this.geoCalm.push({ ...f });
      if (this.geoCalm.length >= 45) {
        const g = {} as MouthFeatures;
        for (const k of FEATURE_KEYS) {
          const v = this.geoCalm.map((q) => q[k]).sort((a, b) => a - b);
          g[k] = v[Math.floor(v.length / 2)]; // median — robust to a stray expression
        }
        cal.geo = g;
        this.geoCalm = [];
        this.poseNeutral.seed(g as unknown as Record<string, number>);
        saveCalibration(cal);
      }
      return;
    }
    // held expressions aren't rest: lips must already be close to the pose-predicted neutral
    const n = this.poseGeo(x)!;
    if (Math.abs(f.liftL - n.liftL) > 0.045 || Math.abs(f.liftR - n.liftR) > 0.045 || Math.abs(f.width - n.width) > 0.06) return;
    // every 3rd calm frame: ~1–2 min memory, so a held expression can't be absorbed as "neutral"
    if (++this.poseTick % 3) return;
    this.poseNeutral.update(x, f as unknown as Record<string, number>);
  }

  /** Iris position within the eye opening, averaged over both eyes, in image-space units ≈ [-1,1]. */
  private irisGaze(lm: NormalizedLandmark[], aspect: number, bs: Record<string, number>): [number, number] {
    if (lm.length < 478) return [0, 0];
    const one = (E: typeof EYE.left): [number, number] => {
      const o = lm[E.outer], i = lm[E.inner], c = lm[E.iris];
      // eye axis in aspect-corrected image space (handles head roll)
      const ax = (o.x - i.x) * aspect, ay = o.y - i.y;
      const len = Math.hypot(ax, ay) + 1e-6;
      // eye axis oriented to point toward image right for both eyes
      const flip = ax < 0 ? -1 : 1;
      const ux = (ax / len) * flip, uy = (ay / len) * flip;
      const mx = ((o.x + i.x) / 2) * aspect, my = (o.y + i.y) / 2;
      const dx = c.x * aspect - mx, dy = c.y - my;
      const along = dx * ux + dy * uy; // + = toward image right
      const perp = -dx * uy + dy * ux; // + = down in image
      return [along / (len * 0.5), perp / (len * 0.5)];
    };
    const [lx, ly] = one(EYE.left);
    const [rx, ry] = one(EYE.right);
    // iris travels ~±0.35 of the half-width at extremes (one eye tracked: that iris only)
    const wl = this.eyesTracked === 'left' ? 1 : this.eyesTracked === 'right' ? 0 : 0.5;
    const ix = (lx * wl + rx * (1 - wl)) / 0.35;
    const iy = (ly * wl + ry * (1 - wl)) / 0.28;
    const bx = ((bs.eyeLookOutLeft ?? 0) + (bs.eyeLookInRight ?? 0) - (bs.eyeLookInLeft ?? 0) - (bs.eyeLookOutRight ?? 0)) / 2;
    const by = ((bs.eyeLookDownLeft ?? 0) + (bs.eyeLookDownRight ?? 0) - (bs.eyeLookUpLeft ?? 0) - (bs.eyeLookUpRight ?? 0)) / 2;
    return [ix * 0.7 + bx * 1.4 * 0.3, iy * 0.7 + by * 1.4 * 0.3];
  }

  private finishCalibration() {
    const c = this.calibrating!;
    this.calibrating = null;
    const S = c.samples;
    if (S.length < 5) { c.resolve(); return; }
    const mean = (f: (s: (typeof S)[number]) => number) => S.reduce((a, s) => a + f(s), 0) / S.length;
    const neutral: Record<string, number> = {};
    const low = (f: (s: (typeof S)[number]) => number) => { const v = S.map(f).sort((a, b) => a - b); return v[Math.floor(v.length * 0.2)]; };
    // opening channels: the low end of the window, so a word spoken during calibration doesn't become "rest"
    for (const name of [...ARKIT, '_lipGap']) neutral[name] = OPEN_REST.has(name) ? low((s) => s.bs[name] ?? 0) : mean((s) => s.bs[name] ?? 0);
    this.calib = {
      neutral,
      peaks: this.calib?.peaks ?? {},
      head: [mean((s) => s.head[0]), mean((s) => s.head[1]), mean((s) => s.head[2])],
      headPos: [mean((s) => s.pos[0]), mean((s) => s.pos[1]), mean((s) => s.pos[2])],
      gaze: this.eyesTracked !== 'both' && this.calib?.gaze ? this.calib.gaze : [mean((s) => s.gaze[0]), mean((s) => s.gaze[1])],
      gaze1: this.eyesTracked !== 'both' ? { ...this.calib?.gaze1, [this.eyesTracked]: [mean((s) => s.gaze[0]), mean((s) => s.gaze[1])] } : this.calib?.gaze1,
      earOpen: [mean((s) => s.ear[0]), mean((s) => s.ear[1])],
      geo: Object.fromEntries(FEATURE_KEYS.map((k) => [k, mean((s) => s.feats[k])])) as unknown as MouthFeatures,
      geoV: GEO_VERSION,
      posV: this.metricHead ? 3 : 2,
      at: new Date().toISOString(),
    };
    this.blinkFloor = [neutral.eyeBlinkLeft ?? 0.1, neutral.eyeBlinkRight ?? 0.1];
    this.livePeak = {};
    saveCalibration(this.calib);
    c.resolve();
  }

  /** One-eye gaze rest: calibrated for this eye, else learned from the first ~10 s of looking (median of the raw gaze
   *  — people mostly look at the screen), then kept in the calibration. */
  private oneEyeGazeRest(g: [number, number]): [number, number] {
    const side = this.eyesTracked as 'left' | 'right', cal = this.calib;
    const known = cal?.gaze1?.[side];
    if (known) return known;
    const G = this.g1;
    if (G.side !== side) { G.side = side; G.x = []; G.y = []; }
    if (G.x.length < 600) { G.x.push(g[0]); G.y.push(g[1]); }
    if (G.x.length < 30) return cal?.gaze ?? [0, 0];
    const md = (a: number[]) => { const v = [...a].sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
    const r: [number, number] = [md(G.x), md(G.y)];
    if (G.x.length >= 600 && cal) { cal.gaze1 = { ...cal.gaze1, [side]: r }; saveCalibration(cal); }
    return r;
  }

  /** Face lost: ease everything back to rest instead of freezing mid-expression. */
  private decay(dt: number): TrackingFrame {
    const f = this.lastFrame;
    const k = Math.exp(-4 * dt);
    const face: Record<string, number> = {};
    for (const n in f.face) face[n] = f.face[n] * k;
    const m = f.mouth;
    this.lastFrame = {
      ...f,
      face,
      head: [f.head[0] * k, f.head[1] * k, f.head[2] * k],
      headPos: [f.headPos[0] * k, f.headPos[1] * k, f.headPos[2] * k],
      gaze: [f.gaze[0] * k, f.gaze[1] * k],
      mouth: { open: m.open * k, wide: m.wide * k, smile: m.smile * k, frown: m.frown * k, pucker: m.pucker * k, funnel: m.funnel * k, tongue: m.tongue * k },
      tracked: false,
    };
    return this.lastFrame;
  }
}

/** A copy of `a` (reversed unless `rev` is false) scaled by `k`, in one allocation. */
function scaledRev(a: number[], k: number, rev = true): number[] {
  const n = a.length, out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[rev ? n - 1 - i : i] * k;
  return out;
}

function wrapPi(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function emptyFrame(): TrackingFrame {
  return {
    t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0],
    mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 },
    tracked: false,
  };
}

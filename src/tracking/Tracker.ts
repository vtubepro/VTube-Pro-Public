// Runs MediaPipe Face / Pose / Hand landmarkers on video frames (GPU delegate, CPU fallback).
// Scales down on weaker machines by lowering pose model size and running body/hands every Nth frame.

import './noTelemetry.ts'; // MediaPipe's usage logger never phones home
import { cameraPixelsOk } from '../core/readbackProbe.ts';
import {
  FaceLandmarker, FilesetResolver, GestureRecognizer, PoseLandmarker,
  type FaceLandmarkerResult, type GestureRecognizerResult, type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import { AUTO, AutoDelegate, STALL_TRY, median, readDelegatePolicy, startDelegate, type AutoTry, type DelegatePolicy, type RoleView, type TrackRole } from './delegatePolicy.ts';
import { STALL, StallGuard, type StallState } from './stallGuard.ts';
import { gpuSync } from './gpuSyncProbe.ts';
import { gpuBusy as gpuBusyOf, type GpuStat } from '../../shared/gpuStat.ts';
/** A worker that has not answered for this long is replaced (one frame in flight per worker; beta.13.5). */
const STUCK_MS = 10000;
/** A candidate / replacement worker that has not reported ready this long after its try began is given up (its start is
 *  cancelled, not left to run into spawnWorker's 45 s limit: perf lane trk, T1/T2). */
const TRIAL_SPAWN_MS = 15000;
/** A stall try IS the replacement of a stuck / starved worker: a slow start (model load + warm-ups next to a game) gets spawnWorker's
 *  full 45 s, or a replacement that needs 15-45 s is cancelled and respawned for ever while the avatar stays frozen. */
const STALL_SPAWN_MS = 45000;
/** The studio's crop of the camera picture for the face worker, still not made after this long: the frame is dropped (the
 *  next camera frame asks again) instead of holding the face 'in flight' until STUCK_MS (T3). */
const CROP_GUARD_MS = 2000;
/** At most this many dropped-but-unsettled crops may be open at once (so a saturated graphics queue is not piled onto). */
const CROP_OPEN_MAX = 3;
import { FaceFirst, faceGoalHz } from './faceFirst.ts';
// cpuFace hook: the processor-only face tracker (no WebGL; src/tracking/cpuFace/index.ts)
import { bodyCapFor, cpuFaceFor, cpuFaceInit, grabCpuFrame, isCpuFace, markCpuFaceBroken, spawnCpuFaceWorker, type CpuFaceStats } from './cpuFace/index.ts';
// "My face model" (faceNet/, docs/FACE_MODEL.md): opt-in; the type only here, the worker code lives in faceNet/runtime.ts
import type { FaceNetOut } from './faceNet/runtime.ts';
import { NetGate } from './faceNet/gate.ts';

/** Worker mode: which camera frame a pose / hands result came from (frame id) and that frame's time (s, the clock of
 *  RawTracking.t: when the page got the frame, rVFC / hidden-tab poll; a frame sent later, when a worker came free,
 *  keeps its own time). Every new pose and hands result object carries it: they update at their own rates, so the
 *  consumer must step each stream on its own stamps (bodySolver.ts per-stream clocks, perf/hands-solve-display). */
export interface TrackStamp { id?: number; t?: number }
/** Hands come from the Gesture Recognizer: same 21-point hand landmarks + a gesture label per hand. */
export type HandsResult = GestureRecognizerResult & TrackStamp;

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface TrackerOptions {
  tier: QualityTier;
  body: boolean;
  hands: boolean;
  /** Run the face model (default true). A body-only second camera sets false. */
  face?: boolean;
}

export interface RawTracking {
  t: number; // seconds
  face: FaceLandmarkerResult | null;
  pose: PoseLandmarkerResult | null;
  hands: HandsResult | null;
  /** Video frame size (for aspect-correct landmark math). */
  width: number;
  height: number;
  /** Milliseconds spent inside MediaPipe this frame. */
  inferMs: number;
  /** Worker mode: which body sample this is, and its frame time (s, see TrackStamp). With Body on they follow the POSE
   *  stream, as with one body worker: bodyId +1 per new pose result, bodyT = that pose frame's time. So the arms' latency
   *  lead (app: now - bodyT), the body jitter meters and the motion recorder step once per pose sample at its own time,
   *  and a solver that only watches bodyId filters each pose once. `pose` and `hands` are that sample's: while a hand or a
   *  wrist is in view the pose and hand models get the SAME camera frames (their own workers, in parallel) and a sample
   *  is handed out once both results of its frame are in, so a solver that pairs hands with the pose wrists by bodyId
   *  sees one frame (pose and hands from frames 1-2 apart swapped left / right hands while arms crossed). With Body off
   *  (or no pose result for 0.5 s) the hands stream drives them. bodyT never goes backwards. */
  bodyId?: number;
  bodyT?: number;
  /** performance.now() ms when the camera captured the face frame (requestVideoFrameCallback captureTime). */
  capture?: number;
  /** Latest food & drink detector result (worker mode, feature on): id increases per new result. */
  objects?: ObjectResult | null;
  /** "My face model": this frame's net values / crops, only while the feature asked the face worker for them (faceNet/faceModel.ts). */
  faceNet?: FaceNetOut;
}

/** Food & drink detector boxes, full-frame normalized (0..1). */
export interface ObjectBox { cls: string; score: number; x: number; y: number; w: number; h: number; /** mean colour inside the box (food & drink classes only) */ rgb?: [number, number, number] }
/** Which part of the frame a detector look saw: around the hands, the lower face (where a cup is while
 *  drinking), or the whole frame. */
export type ObjectRegion = 'hand' | 'mouth' | 'full';
export interface ObjectResult {
  id: number; t: number;
  /** Food / drink classes (score ≥ 0.12). */
  dets: ObjectBox[];
  /** Every class the detector reported (≥ 0.1), for diagnostics. */
  raw?: ObjectBox[];
  region?: ObjectRegion;
  /** The crop that was looked at (full-frame normalized). */
  roi?: { x: number; y: number; w: number; h: number };
  /** Downscaled JPEG of the crop (only while the diagnostic capture is on). */
  jpg?: Blob | null;
  ms?: number;
}

// public/ files follow the vite base ('/' locally, '/studio/' in the web build)
const BASE = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}mediapipe`;

const TIER: Record<QualityTier, { pose: 'lite' | 'full' | 'heavy'; bodyEvery: number; handsEvery: number }> = {
  low: { pose: 'lite', bodyEvery: 3, handsEvery: 3 },
  medium: { pose: 'lite', bodyEvery: 2, handsEvery: 2 },
  // face runs every frame (speech needs it); body & hands alternate frames — they don't need 60 Hz
  high: { pose: 'full', bodyEvery: 2, handsEvery: 2 },
  ultra: { pose: 'full', bodyEvery: 2, handsEvery: 2 },
};

/** Original single-thread implementation — the fallback when worker tracking is unavailable (or `?mainTracker`). */
export class MainThreadTracker {
  face: FaceLandmarker | null = null;
  pose: PoseLandmarker | null = null;
  hands: GestureRecognizer | null = null;
  delegate: 'GPU' | 'CPU' = 'GPU';
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private closeGeneration = 0;
  private configureOperation = 0;
  private frame = 0;
  private lastPose: PoseLandmarkerResult | null = null;
  private lastHands: HandsResult | null = null;
  private lastVideoTime = -1;
  private poseModel = '';
  private warmTs = 0;
  private lastTs = 0;
  opts: TrackerOptions = { tier: 'high', body: true, hands: true };

  async init(opts: TrackerOptions, onStatus?: (s: string) => void, signal?: AbortSignal) {
    const generation = this.closeGeneration;
    const active = () => generation === this.closeGeneration && !signal?.aborted;
    const current = () => { if (!active()) throw new DOMException('Tracker start cancelled', 'AbortError'); };
    try {
      current();
      this.opts = opts;
      onStatus?.('Getting face tracking ready.'); // autopilot: plain words in the status line (no MediaPipe / GPU / workers)
      if (!this.fileset) {
        const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
        current();
        this.fileset ??= fileset;
      }
      onStatus?.('Loading face model.');
      if (!this.face) {
        const face = await this.create((d) =>
          FaceLandmarker.createFromOptions(this.fileset!, {
            baseOptions: { modelAssetPath: `${BASE}/face_landmarker.task`, delegate: d },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            minFaceDetectionConfidence: 0.4,
            minFacePresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
          }), active,
        );
        if (!active()) { face.close(); current(); }
        if (!this.face) this.face = face; else face.close();
      }
      await this.configure(this.opts, onStatus, signal);
      current();
      // First GPU inference compiles shaders (seconds). Do it now, not on the first live frame.
      onStatus?.('Almost ready.');
      current();
      const warm = document.createElement('canvas');
      warm.width = 320; warm.height = 240;
      warm.getContext('2d')!.fillRect(0, 0, 320, 240);
      const t = performance.now();
      this.face!.detectForVideo(warm, t);
      this.pose?.detectForVideo(warm, t);
      this.hands?.recognizeForVideo(warm, t);
      this.warmTs = t;
      onStatus?.('Tracking ready');
    } catch (e) { current(); throw e; }
  }

  /** Apply new options, lazily loading/unloading body and hand models. The switches can flip while a model loads:
   *  a model that is no longer wanted when it arrives is closed straight away (never left running). */
  async configure(opts: TrackerOptions, onStatus?: (s: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) return;
    const generation = this.closeGeneration;
    const operation = ++this.configureOperation;
    const active = () => generation === this.closeGeneration && operation === this.configureOperation && !signal?.aborted;
    this.opts = opts;
    if (!opts.body) this.lastPose = null;
    if (!opts.hands) this.lastHands = null;
    if (!this.fileset || !this.face) return;
    try {
      const poseName = TIER[opts.tier].pose;
      if (opts.body && (this.poseModel !== poseName || !this.pose)) {
        onStatus?.(`Loading body model (${poseName}).`);
        this.pose?.close(); this.pose = null; this.poseModel = '';
        const pose = await this.create((d) =>
          PoseLandmarker.createFromOptions(this.fileset!, {
            baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_${poseName}.task`, delegate: d },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }), active,
        );
        if (active() && this.opts.body && TIER[this.opts.tier].pose === poseName && !this.pose) { this.pose = pose; this.poseModel = poseName; } else pose.close();
        if (!active()) return;
      } else if (!opts.body && this.pose) {
        this.pose.close(); this.pose = null; this.poseModel = ''; this.lastPose = null;
      }
      if (opts.hands && !this.hands) {
        onStatus?.('Loading hand + gesture model.');
        const hands = await this.create((d) =>
          GestureRecognizer.createFromOptions(this.fileset!, {
            baseOptions: { modelAssetPath: `${BASE}/gesture_recognizer.task`, delegate: d },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
          }), active,
        );
        if (active() && this.opts.hands && !this.hands) this.hands = hands; else hands.close();
      } else if (!opts.hands && this.hands) {
        this.hands.close(); this.hands = null; this.lastHands = null;
      }
    } catch (e) { if (active()) throw e; }
  }

  /** Try GPU first; fall back to CPU (e.g. no WebGL2 / blocklisted driver). */
  private async create<T>(make: (d: 'GPU' | 'CPU') => Promise<T>, active: () => boolean): Promise<T> {
    if (!active()) throw new DOMException('Tracker start cancelled', 'AbortError');
    if (this.delegate === 'GPU') {
      try { return await make('GPU'); } catch (e) {
        if (!active()) throw new DOMException('Tracker start cancelled', 'AbortError');
        console.warn('GPU delegate failed, using CPU', e); this.delegate = 'CPU';
      }
    }
    return make('CPU');
  }

  /** Process the current video frame. Returns null if there's no new frame. */
  process(video: HTMLVideoElement, nowMs: number): RawTracking | null {
    if (!this.face || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const t0 = performance.now();
    const ts = Math.max(Math.round(nowMs), Math.round(this.warmTs) + 1, this.lastTs + 1);
    this.lastTs = ts;
    // (face: false = another face source drives the avatar, e.g. the light face tracker: no face model run at all)
    const face = this.opts.face === false ? ({ faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] } as unknown as FaceLandmarkerResult) : this.detectFace(video, ts);
    const tier = TIER[this.opts.tier];
    this.frame++;
    if (this.pose && this.opts.body && this.frame % tier.bodyEvery === 0) {
      this.lastPose = this.pose.detectForVideo(video, ts);
    }
    if (this.hands && this.opts.hands && (this.frame + 1) % tier.handsEvery === 0) {
      this.lastHands = this.hands.recognizeForVideo(video, ts);
    }
    return {
      t: nowMs / 1000,
      face: face.faceLandmarks.length ? face : null,
      pose: this.lastPose?.worldLandmarks?.length ? this.lastPose : null,
      hands: this.lastHands?.landmarks?.length ? this.lastHands : null,
      width: video.videoWidth,
      height: video.videoHeight,
      inferMs: performance.now() - t0,
    };
  }

  // ---- zoomed face ROI ----
  // MediaPipe crops faces to ~256 px internally, but from a 720p frame a person sitting back is only
  // ~150 px tall, so it works on a blurry face. We crop a square around the last face at FULL camera
  // resolution into a 512 px canvas and track on that (4–9× the pixels on the face), then map the
  // landmarks back to full-frame coordinates so everything downstream is unchanged.
  roiEnabled = true;
  private roi: { x: number; y: number; s: number } | null = null; // in video pixels
  private roiCanvas: HTMLCanvasElement | null = null;
  private roiCtx: CanvasRenderingContext2D | null = null;
  private roiMiss = 0;
  /** Last ROI as fractions of the frame (for overlays / diagnostics). */
  roiInfo: { x: number; y: number; s: number; zoom: number } | null = null;

  private detectFace(video: HTMLVideoElement, ts: number): FaceLandmarkerResult {
    const W = video.videoWidth, H = video.videoHeight;
    if (!this.roiEnabled || !this.roi || !W) {
      const r = this.face!.detectForVideo(video, ts);
      this.updateRoi(r, W, H, null);
      return r;
    }
    const S = 512;
    if (!this.roiCanvas) {
      this.roiCanvas = document.createElement('canvas');
      this.roiCanvas.width = this.roiCanvas.height = S;
      this.roiCtx = this.roiCanvas.getContext('2d', { alpha: false, desynchronized: true })!;
    }
    const { x, y, s } = this.roi;
    const ctx = this.roiCtx!;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(video, x, y, s, s, 0, 0, S, S);
    const r = this.face!.detectForVideo(this.roiCanvas, ts);
    // crop-normalized → frame-normalized (x/z in frame-width units, y in frame-height units)
    for (const lm of r.faceLandmarks) for (const p of lm) {
      p.x = (x + p.x * s) / W;
      p.y = (y + p.y * s) / H;
      p.z = (p.z * s) / W;
    }
    this.updateRoi(r, W, H, this.roi);
    return r;
  }

  private updateRoi(r: FaceLandmarkerResult, W: number, H: number, used: { x: number; y: number; s: number } | null) {
    const lm = r.faceLandmarks[0];
    if (!lm) {
      // lost the face: fall back to full-frame detection after a couple of misses
      if (++this.roiMiss > 2) { this.roi = null; this.roiInfo = null; }
      return;
    }
    this.roiMiss = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of lm) { const px = p.x * W, py = p.y * H; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const size = Math.max(x1 - x0, y1 - y0) * 1.7; // margin for motion + MediaPipe's own padding
    let s = Math.min(Math.max(size, 96), Math.min(W, H));
    // stabilise: only move/resize the window when the face drifts noticeably (keeps landmarks steady)
    if (used) {
      const ucx = used.x + used.s / 2, ucy = used.y + used.s / 2;
      if (Math.abs(ucx - cx) < used.s * 0.06 && Math.abs(ucy - cy) < used.s * 0.06 && Math.abs(used.s - s) < used.s * 0.12) s = used.s;
    }
    const nx = Math.min(Math.max(cx - s / 2, 0), W - s), ny = Math.min(Math.max(cy - s / 2, 0), H - s);
    this.roi = used && s === used.s && Math.abs(nx - used.x) < s * 0.06 && Math.abs(ny - used.y) < s * 0.06 ? used : { x: nx, y: ny, s };
    this.roiInfo = { x: this.roi.x / W, y: this.roi.y / H, s: this.roi.s / H, zoom: 512 / this.roi.s };
  }

  close() {
    this.closeGeneration++;
    this.face?.close(); this.pose?.close(); this.hands?.close();
    this.face = this.pose = this.hands = null;
    this.poseModel = ''; this.lastPose = null; this.lastHands = null;
  }
}


// ============================================================================================
// Tracker facade: face and body/hands run in two Web Workers — in parallel and off the main
// thread — fed the instant each camera frame arrives (requestVideoFrameCallback). Busy workers
// skip frames ("latest frame wins"), so results are never from a stale queued frame.
// Falls back to MainThreadTracker when workers / OffscreenCanvas GPU aren't available.
// ============================================================================================

type RoiInfo = { x: number; y: number; s: number; zoom: number } | null;
/** Where a face run's time went (ms, beta.13.5): getting its picture (the studio's createImageBitmap crop), the hop to
 *  the worker, MediaPipe's WebGL upload and readback (where a graphics card a game holds makes it wait: trackWorker.ts
 *  glMs), and the rest (the model itself). */
export interface FaceSplit { acq: number; recv: number; up: number; rb: number; inf: number }

interface WorkerMsg {
  type: 'result' | 'ready' | 'configured' | 'error' | 'objects'; role: 'face' | 'body' | 'hands' | 'objects'; id?: number; ms?: number; width?: number; height?: number;
  /** face 'result': where the run's time went. */
  split?: FaceSplit;
  face?: FaceLandmarkerResult | null; pose?: PoseLandmarkerResult | null; hands?: HandsResult | null; roi?: RoiInfo;
  delegate?: 'GPU' | 'CPU'; message?: string; mouthMs?: number;
  dets?: ObjectBox[]; raw?: ObjectBox[]; jpg?: Blob | null;
  /** body role ('ready' / 'configured'): which models the worker has loaded now. */
  models?: { body: boolean; hands: boolean };
  /** body role 'result': ms of the pose / hand model on this frame (null = that model did not run). */
  poseMs?: number | null; handsMs?: number | null;
  /** 'ready' / 'configured': why the worker runs on the CPU although the GPU was asked for. */
  fallback?: string;
  /** cpuFace hook: the processor-only face worker's per-frame figures ('result') and its engine ('ready'). */
  cpu?: CpuFaceStats; engine?: string;
  /** "My face model": the face worker's net values / crops for this frame (only when the frame message had `fnet` bits). */
  net?: FaceNetOut;
}

/** One tracking model at run time: where it runs, how long a run takes and how often it delivers. */
export interface TrackRoleStats {
  delegate: 'GPU' | 'CPU';
  /** ms per run (moving average; the face figure leaves the mouth-patch read out). */
  ms: number;
  /** results per second. */
  hz: number;
  /** why it runs where it runs ('' = the default choice). */
  reason: string;
  /** face (cpuFace hook): which engine runs it: 'cpuface' (src/tracking/cpuFace: the processor, never the graphics card)
   *  or 'mediapipe' (tasks-vision, on either delegate). */
  engine?: 'cpuface' | 'mediapipe';
  /** model variant where it matters (pose: lite / full / heavy). */
  model?: string;
  /** pose / hands: results per second at most right now (the preset, the adaptive level and face first). */
  cap?: number;
  /** face: where a run's time goes (moving averages, ms). */
  split?: FaceSplit;
}

/** Which tracking models run right now (Hands / Body switches: the Tracking card's "Starting…", diagnostics, tests).
 *  `roles` (worker mode, once results arrive): per model delegate, ms, results / s and fallback reason (state.json). */
export interface TrackerModels {
  face: boolean; body: boolean; hands: boolean; mode: 'worker' | 'main';
  roles?: { face: TrackRoleStats | null; pose: TrackRoleStats | null; hands: TrackRoleStats | null };
}

const NO_MODELS = Object.freeze({ body: false, hands: false });

/** Moving-average ms + results per second of one tracking model. */
class RoleMeter {
  ms = 0;
  private n = 0;
  private t0 = 0;
  private rate = 0;
  seen = false;
  /** results since the last reset */
  count = 0;
  add(ms: number, now: number) {
    this.ms = this.seen ? this.ms + (ms - this.ms) * 0.1 : ms;
    this.seen = true;
    this.count++;
    if (!this.t0) this.t0 = now;
    this.n++;
    if (now - this.t0 >= 1000) { this.rate = (this.n * 1000) / (now - this.t0); this.n = 0; this.t0 = now; }
  }
  /** results per second (decays to 0 once results stop for 2 s). */
  hz(now: number) { return this.t0 && now - this.t0 > 2000 ? (this.n * 1000) / (now - this.t0) : this.rate; }
  reset() { this.ms = 0; this.n = 0; this.t0 = 0; this.rate = 0; this.seen = false; this.count = 0; }
  /** Restart the average from a measured value (a worker on another delegate took over). */
  seed(ms: number) { this.ms = ms; }
}

/** One body sample (see RawTracking.bodyId): its id, frame time (s) / capture (ms), and the pose + hands handed out with it. */
type BodySample = { id: number; t: number; capture: number; pose: (PoseLandmarkerResult & TrackStamp) | null; hands: HandsResult | null };

/** A replacement worker on the other delegate, being warmed and timed next to the live one (delegatePolicy.ts). */
interface DelegateTrial {
  t: AutoTry;
  role: 'face' | 'body' | 'hands';
  w: Worker | null;
  busy: boolean;
  /** probe results so far (the first one is not timed) */
  got: number;
  ms: number[];
  startT: number;
  readyT: number;
  /** a pose / hands try: the face's ms before it, and the face results while the candidate was being timed (a move
   *  that helps that model but slows the face, e.g. hands onto a busy GPU, is not taken) */
  faceBefore: number;
  faceDuring: number[];
  /** A worker that stopped answering, replaced on the same side (replaceStuck): not a stall move — a lost one neither
   *  arms the stall back-off nor counts with Auto (review round 1, G5). */
  replace?: boolean;
  /** Cancels the candidate's start while it has no worker yet (endTrial; T2). */
  abort?: AbortController;
}

/** One face frame sent to the face worker: when its crop was asked for, when it was handed over (0 = still being cropped),
 *  and whether the crop guard disowned it (a late crop is then closed, never posted). */
interface FaceSend { fw: Worker; t0: number; acqT: number; dropped: boolean }

export class Tracker {
  /** Where tracking runs, short: 'GPU' / 'CPU' when every model runs there, else per model ('face GPU · pose GPU · hands CPU'). */
  get delegate(): string {
    if (this.mode === 'main') return this.main.delegate;
    const r = this.roleStats(performance.now());
    const parts = (['face', 'pose', 'hands'] as const).flatMap((k) => (r[k] ? [[k, r[k]!.delegate] as const] : []));
    if (!parts.length) return (this.fw && this.winfo.get(this.fw)?.delegate) || 'GPU';
    return parts.every(([, d]) => d === parts[0][1]) ? parts[0][1] : parts.map(([k, d]) => `${k} ${d}`).join(' · ');
  }
  opts: TrackerOptions = { tier: 'high', body: true, hands: true };
  roiInfo: RoiInfo = null;
  /** Hand crop in use (fractions of the frame), null = hands see the whole frame. */
  handRoiInfo: { x: number; y: number; w: number; h: number; zoom: number } | null = null;
  /** 'worker' (parallel, preferred) or 'main' (fallback). */
  mode: 'worker' | 'main' = 'worker';
  /** Truthy once initialised (callers check `tracker.face`). */
  face: unknown = null;
  /** Overlapping starts share one model load; close() cancels only that load. */
  private initialization: { controller: AbortController; promise: Promise<void>; face: boolean; status?: (s: string) => void } | null = null;
  private closeGeneration = 0;
  /** Rolling stats (ms / Hz): face + body inference, camera-capture → result latency, face result rate. */
  timing = { /** face model ms per frame (without the mouth-patch read) */ face: 0, body: 0, latency: 0, fps: 0, mouth: 0, objects: 0, /** ms per mouth-patch read (when one ran) */ mouthPatch: 0,
    /** ms per hand-model run */ hands: 0 };

  // ---- food & drink object detector (opt-in): its own low-priority worker (role 'objects') fed a crop
  // around the hands a few times a second. Spawned only while wanted, terminated when turned off, and it
  // pauses whenever the face model is struggling (adaptive quality level > 0 or face inference > 20 ms).
  get objects() { return this.objectsWanted; }
  set objects(v: boolean) {
    if (v === this.objectsWanted) return;
    this.objectsWanted = v;
    this.objectsError = '';
    if (!v) { this.ow?.terminate(); this.ow = null; this.objectsBusy = false; this.latestObjects = null; }
  }
  /** Looks per second (1..8) while a hand is in view / the snack logic is busy. */
  objectsHz = 4;
  /** Looks per second while nothing is going on (no hand in view, snack logic idle) — saves CPU. */
  objectsIdleHz = 1.5;
  /** Set by the app while the snack logic tracks something (full rate even without a visible hand). */
  objectsBoost = false;
  /** Whether the object detector may run right now (wanted AND tracking has headroom). */
  get objectsActive() { return this.objectsWanted && this.mode === 'worker' && !!this.fw && this.adaptLevel === 0 && this.timing.face < 20; }
  /** Last detector error (model failed to load …), for the UI. */
  objectsError = '';
  private objectsWanted = false;
  private ow: Worker | null = null;
  private objectsSpawning = false;
  private objectsBusy = false;
  private objectsSentT = 0;
  private objectsId = 0;
  private latestObjects: ObjectResult | null = null;
  /** Diagnostics: ask the object worker for a small JPEG of what it looked at, about once a second. */
  objectsSnap = false;
  private objectsSnapT = 0;
  private objectsCycle = 0;
  private objectsSent: { region: ObjectRegion; roi: { x: number; y: number; w: number; h: number } } | null = null;
  /** Detector looks per region since start (diagnostics). */
  objectsLooks: Record<ObjectRegion, number> = { hand: 0, mouth: 0, full: 0 };

  private spawnObjects() {
    if (this.ow || this.objectsSpawning || this.objectsError) return;
    this.objectsSpawning = true;
    const w = new Worker(new URL('./trackWorker.ts', import.meta.url), { type: 'module', name: 'vtp-objects' });
    const fail = (msg: string) => {
      w.terminate();
      if (this.ow === w) this.ow = null;
      this.objectsSpawning = false; this.objectsBusy = false;
      this.objectsError = msg || 'object detector failed';
      console.warn('[tracker] object detector:', this.objectsError);
    };
    w.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.objectsSpawning = false;
        if (!this.objectsWanted) { w.terminate(); return; }
        this.ow = w;
        w.onmessage = (ev: MessageEvent<WorkerMsg>) => this.onObjects(ev.data);
      } else if (m.type === 'error') fail(m.message ?? '');
    };
    w.onerror = (ev) => fail(ev.message || 'object worker crashed');
    w.postMessage({ type: 'init', role: 'objects', base: `${location.origin}${BASE}`, tier: this.opts.tier, body: false, hands: false });
  }

  private onObjects(m: WorkerMsg) {
    this.objectsBusy = false;
    if (m.type === 'error') { this.objectsError = m.message ?? 'object detector error'; return; }
    if (m.type !== 'objects' || !m.dets || !this.objectsWanted) return;
    this.timing.objects += ((m.ms ?? 0) - this.timing.objects) * 0.2;
    const s = this.objectsSent;
    if (s) this.objectsLooks[s.region]++;
    this.latestObjects = { id: ++this.objectsId, t: this.objectsSentT / 1000, dets: m.dets, raw: m.raw, region: s?.region, roi: s?.roi, jpg: m.jpg ?? null, ms: m.ms };
  }

  /**
   * Where the next detector look goes. A cup at the lips sits over the lower face — often outside (or a
   * tiny part of) the hand crop, and in a whole-frame look a mug is ~30 px at the model's 320 px input.
   * So looks rotate: hands → lower face → hands → whole frame, and while a hand is up near the face every
   * other look is the lower-face crop.
   */
  private objectsRegion(W: number, H: number): { region: ObjectRegion; r: { x: number; y: number; w: number; h: number } } {
    const full = { x: 0, y: 0, w: W, h: H };
    // without hand landmarks (a held mug often hides the fingers, and the hand model drops the hand): the box around the
    // pose wrists (the hand model itself no longer gets a hand crop by default), else the small performer's reach box
    const hr = this.opts.hands ? this.wristBox(W, H) ?? this.handRoi : null;
    const f = this.roi;
    let mouth: typeof full | null = null;
    let handUp = false;
    if (f) {
      const cx = f.x + f.s / 2, cy = f.y + f.s / 2;
      const x0 = Math.max(0, cx - f.s * 0.62), x1 = Math.min(W, cx + f.s * 0.62);
      const y0 = Math.max(0, cy - f.s * 0.28), y1 = Math.min(H, cy + f.s * 0.78);
      if (x1 - x0 > 32 && y1 - y0 > 32) mouth = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      // any hand / wrist within ~1 face crop of the face centre?
      const near = (px: number, py: number) => Math.abs(px - cx) < f.s * 0.9 && py < cy + f.s * 0.9 && py > cy - f.s * 0.7;
      for (const lm of this.latestHands?.landmarks ?? []) if (lm[9] && near(lm[9].x * W, lm[9].y * H)) handUp = true;
      const pl = this.latestPose?.landmarks?.[0];
      if (pl && pl.length > 20) for (const i of [15, 16, 19, 20]) if ((pl[i].visibility ?? 0) > 0.4 && near(pl[i].x * W, pl[i].y * H)) handUp = true;
    }
    // a tight square around one visible hand (alternating): a held mug is ~100 px there instead of ~30 px
    // in a whole-frame look at the model's 320 px input
    const hl = this.opts.hands ? this.latestHands?.landmarks ?? [] : [];
    let tight: typeof full | null = null;
    if (hl.length) {
      const lm = hl[this.objectsCycle % hl.length];
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of lm) { a = Math.min(a, p.x * W); c = Math.max(c, p.x * W); b = Math.min(b, p.y * H); d = Math.max(d, p.y * H); }
      const side = Math.min(H * 0.55, Math.max(H * 0.25, Math.max(c - a, d - b) * 3.4));
      const cx = (a + c) / 2, cy = (b + d) / 2 - side * 0.12; // held things stick out above the fist
      const x0 = Math.max(0, Math.min(W - side, cx - side / 2)), y0 = Math.max(0, Math.min(H - side, cy - side / 2));
      if (side > 32) tight = { x: Math.round(x0), y: Math.round(y0), w: Math.round(Math.min(side, W)), h: Math.round(Math.min(side, H)) };
    }
    const n = this.objectsCycle++;
    const want: ObjectRegion = handUp ? (n % 2 === 0 ? 'mouth' : n % 4 === 1 ? 'hand' : 'full') : (['hand', 'mouth', 'hand', 'full'] as const)[n % 4];
    if (want === 'mouth' && mouth) return { region: 'mouth', r: mouth };
    if (want === 'hand' && (tight || hr)) return { region: 'hand', r: (tight ?? hr)! };
    if (want === 'hand' && !hr && mouth && n % 2 === 0) return { region: 'mouth', r: mouth };
    return { region: 'full', r: full };
  }

  /**
   * The food & drink 'hand' look when the hand model has no landmarks: a box around the pose wrists, as b3d88c1's
   * hand-following crop gave it (that crop is off by default now: it broke the hand model's own tracking). Wrist +
   * knuckle points of each arm whose wrist the pose model sees (clamped to the frame), half a shoulder width of margin,
   * at least 40 % of the frame height; null when nothing is seen or it would cover most of the frame (> 60 %).
   */
  private wristBox(W: number, H: number): { x: number; y: number; w: number; h: number } | null {
    const pl = this.opts.body ? this.latestPose?.landmarks?.[0] : undefined;
    if (!pl || pl.length < 21 || !W || !H) return null;
    const sw = Math.hypot((pl[11].x - pl[12].x) * W, (pl[11].y - pl[12].y) * H);
    if (sw < 1) return null;
    const m = Math.max(sw * 0.55, H * 0.06);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const arm of [[15, 17, 19], [16, 18, 20]]) {
      if ((pl[arm[0]].visibility ?? 0) < 0.5) continue;
      for (const i of arm) {
        const px = Math.min(Math.max(pl[i].x * W, 0), W), py = Math.min(Math.max(pl[i].y * H, 0), H);
        x0 = Math.min(x0, px - m); y0 = Math.min(y0, py - m); x1 = Math.max(x1, px + m); y1 = Math.max(y1, py + m);
      }
    }
    if (!isFinite(x0)) return null;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    const minS = H * 0.4;
    if (x1 - x0 < minS) { const c = (x0 + x1) / 2; x0 = Math.max(0, Math.min(W - minS, c - minS / 2)); x1 = x0 + minS; }
    if (y1 - y0 < minS) { const c = (y0 + y1) / 2; y0 = Math.max(0, Math.min(H - minS, c - minS / 2)); y1 = y0 + minS; }
    if ((x1 - x0) * (y1 - y0) > W * H * 0.6) return null;
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  }

  /** A crop around the hands (or the whole frame), ≤ 640 px, to the object worker — at most `objectsHz`. */
  private submitObjects(video: HTMLVideoElement) {
    const now = performance.now();
    if (this.objectsBusy && now - this.objectsSentT > 3000) this.objectsBusy = false; // lost reply: don't stall forever
    const handInView = (this.latestHands?.landmarks?.length ?? 0) > 0;
    const hz = this.objectsBoost || handInView ? this.objectsHz : Math.min(this.objectsHz, this.objectsIdleHz);
    if (!this.objectsActive || this.objectsBusy || now - this.objectsSentT < 1000 / Math.max(0.5, Math.min(8, hz))) return;
    if (!this.ow) { this.spawnObjects(); return; }
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return;
    const { region, r } = this.objectsRegion(W, H);
    // the model looks at 320 px: 480 px is plenty (and cheaper to crop / transfer than 640)
    const k = Math.min(1, 480 / Math.max(r.w, r.h));
    this.objectsBusy = true;
    this.objectsSentT = now;
    this.objectsSent = { region, roi: { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H } };
    // every 5th look (co-prime with the 4-look region cycle, so the snapshots rotate through the regions)
    const snap = this.objectsSnap && this.objectsCycle % 5 === 0 && now - this.objectsSnapT > 700;
    if (snap) this.objectsSnapT = now;
    const ow = this.ow;
    createImageBitmap(video, r.x, r.y, r.w, r.h, { resizeWidth: Math.max(1, Math.round(r.w * k)), resizeHeight: Math.max(1, Math.round(r.h * k)), resizeQuality: 'medium' })
      .then((b) => { if (this.ow === ow) ow.postMessage({ type: 'frame', bitmap: b, ts: now, id: this.objectsId + 1, handRoi: r, fullW: W, fullH: H, snap: snap ? 320 : 0 }, [b]); else { b.close(); this.objectsBusy = false; } })
      .catch(() => { this.objectsBusy = false; });
  }
  /**
   * Mouth-interior image analysis in the face worker (tongue / teeth / cavity → face._tongueOut …).
   * OFF by default (setting vtp.mouthImage = '1'). Even when on it only runs while the face model is
   * comfortably inside its budget (full quality level, < 20 ms per frame) and backs off automatically.
   */
  mouthImage = (() => { try { return localStorage.getItem('vtp.mouthImage') === '1'; } catch { return false; } })();
  /** Whether the mouth analysis is running right now (setting on AND the guard allows it). */
  get mouthActive() { return this.mouthImage && this.mode === 'worker' && this.adaptLevel === 0 && this.timing.face < 20 && cameraPixelsOk(); }
  /**
   * Mouth visibility (mouthVisibility.ts): even with the full analysis off, the face worker reads the same small mouth
   * patch a few times a second so the solver can tell when a mic, a mug or a hand hides the lips (one 64 x 64 read of
   * the crop it already has, ~0.1 ms of analysis): mouthVisHz at full quality, half that on a machine the adaptive
   * quality has already turned down, none at the lightest level or while face inference is over budget. Off:
   * localStorage vtp.mouthVis = '0'.
   */
  mouthVisPatch = (() => { try { return localStorage.getItem('vtp.mouthVis') !== '0'; } catch { return true; } })();
  /** Patch reads per second for visibility alone (an occluder arrives over ~0.2 s; the solver holds a read for 0.3 s). */
  mouthVisHz = 15;
  private mouthVisT = 0;
  /**
   * Why the mouth-visibility patch is NOT read right now ('' = it is): 'off' (setting), 'mode' (no face worker: the
   * main-thread fallback), 'busy' (adaptive quality at its lightest level, or face inference over 22 ms). Same rules as
   * wantMouthPatch; the Voice lip-sync status line uses it to say "paused" instead of "the camera sees your mouth".
   */
  get mouthVisPause(): '' | 'off' | 'mode' | 'busy' | 'noise' {
    if (this.mouthActive) return '';
    if (!this.mouthVisPatch) return 'off';
    // the browser changes canvas reads (anti-fingerprinting, src/core/readbackProbe.ts): the patch would be guesswork
    if (!cameraPixelsOk()) return 'noise';
    if (this.mode !== 'worker') return 'mode';
    return this.adaptLevel >= 3 || this.timing.face > 22 ? 'busy' : '';
  }
  /** Read the mouth patch with this face frame? (full analysis: every frame; visibility alone: at mouthVisHz) */
  private wantMouthPatch(now: number) {
    if (this.mouthActive) return true;
    if (this.mouthVisPause) return false;
    if (now - this.mouthVisT < 1000 / (this.adaptLevel ? this.mouthVisHz / 2 : this.mouthVisHz) - 2) return false;
    this.mouthVisT = now;
    return true;
  }
  // ---- "My face model" (faceNet/, docs/FACE_MODEL.md). OPT-IN: while no model is set and no teach session runs, none of this
  // adds a field to a frame message, and the workers do nothing extra.
  private fnet = { model: null as string | null, run: false, capture: false };
  /** The studio's wishes: the model JSON the live face worker holds (null = none), whether to run it, whether to hand back crops. */
  setFaceNet(c: { model?: string | null; run?: boolean; capture?: boolean }) {
    const changed = c.model !== undefined && c.model !== this.fnet.model;
    if (c.model !== undefined) this.fnet.model = c.model;
    if (c.run !== undefined) { if (c.run && !this.fnet.run) this.netGate.reset(); this.fnet.run = c.run; }
    if (c.capture !== undefined) this.fnet.capture = c.capture;
    if (changed && this.fw) { try { this.fw.postMessage({ type: 'facenet', model: this.fnet.model }); } catch { /* the worker is gone */ } }
  }
  /** Can the running face path supply pixels for crops? (the main-thread fallback tracker cannot; tasks-vision reads the crop through a 2D canvas, so a browser that adds canvas noise cannot; the processor-only face has its own planes) */
  faceNetSupport(): { ok: boolean; engine: 'cpuface' | 'mediapipe' | ''; why: string } {
    if (this.mode !== 'worker' || !this.fw) return { ok: false, engine: '', why: 'The face is not tracked in its own worker right now (the camera is off, or this browser fell back to the main-thread tracker).' };
    const cpu = isCpuFace(this.fw);
    if (!cpu && !cameraPixelsOk()) return { ok: false, engine: 'mediapipe', why: 'This browser changes camera pixels when a page reads them (anti-fingerprinting), so a face model would learn noise.' };
    return { ok: true, engine: cpu ? 'cpuface' : 'mediapipe', why: '' };
  }
  /** The net's own added cost against the frame period, with hysteresis (faceNet/gate.ts). */
  private netGate = new NetGate();
  /** Frame period (ms) at the current tracking rate: the measured face results per second, else the camera's. */
  private framePeriod(now = performance.now()) { return 1000 / (this.timing.fps > 5 ? this.timing.fps : this.camFps(now)); }
  /**
   * Bits for the next live face frame: capture while a teach session runs (a deliberate act: no budget check); run unless the
   * adaptive quality is at its lightest level (3: the face cannot keep up even then), game mode is on, or the net's OWN cost has
   * been over its share of the frame period (NetGate: pause after 12 slow frames, probe 1 frame in 15, resume after 6 good ones).
   * `take` = the frame is being sent now (counts the probe spacing); without it the call has no side effects.
   */
  private faceNetBits(take = false): number {
    if (!this.fnet.capture && !(this.fnet.run && this.fnet.model)) return 0;
    if (!this.faceNetSupport().ok) return 0;
    let bits = this.fnet.capture ? 2 : 0;
    if (this.fnet.run && this.fnet.model && this.adaptLevel < 3 && !this.stallG.gameMode && (take ? this.netGate.take() : this.netGate.peek())) bits |= 1;
    return bits;
  }
  /** Whether the face model's net is on the face frames right now (the panel's "paused while tracking is busy"). */
  get faceNetRunning() { return !!this.fnet.run && !!this.fnet.model && !this.netGate.paused && (this.faceNetBits() & 1) === 1; }
  private main = new MainThreadTracker();
  /** Fall back to the main-thread tracker when workers fail (the main camera: yes; a second camera: no — it just stops). */
  allowMain = true;
  /** Set when a worker-only tracker (allowMain = false) lost its workers. */
  failed = '';
  /** Max face results per second (0 = every camera frame). */
  faceHz = 0;
  /** Extra condition for sending a frame to the face worker (checked per camera frame). */
  gate: (() => boolean) | null = null;
  private faceSentT = 0;
  /** The face frame in flight (crop pending / in the worker): see FaceSend, replaceStuck, the crop guard in submit. */
  private faceSend: FaceSend | null = null;
  /** Face crops asked for and not yet settled (dropped ones included). */
  private cropsOpen = 0;
  /** True while the face worker has no frame in flight (another tracker can schedule around it). */
  get faceIdle() { return !this.faceBusy; }
  /** Workers: face, body (pose; also the hand model while Body is off, on the 'low' preset, and after the hands worker
   *  failed) and hands (the hand model alone, while Body is on: on the pose's frames but in parallel, so a body sample
   *  takes the slower of the two models instead of both one after the other). */
  private fw: Worker | null = null;
  private bw: Worker | null = null;
  private hw: Worker | null = null;
  /** A body / hands worker being started (configure() calls that overlap share it). */
  private bwSpawn: Promise<Worker> | null = null;
  private hwSpawn: Promise<Worker> | null = null;
  /** Per worker, from its 'ready' / 'configured' answers: where it runs, why, and which models it has loaded now. */
  private winfo = new WeakMap<Worker, { delegate: 'GPU' | 'CPU'; reason: string; models: { body: boolean; hands: boolean } }>();
  /** The face's time split (moving averages of the worker's FaceSplit). */
  private faceSplit: FaceSplit = { acq: 0, recv: 0, up: 0, rb: 0, inf: 0 };
  /** cpuFace hook: the processor-only face worker's figures for its last frame (null = the face runs on tasks-vision). */
  cpuFaceStats: CpuFaceStats | null = null;
  /** cpuFace hook: frame errors in a row from the processor-only face (CPU_FACE_ERRS: it gives way to tasks-vision). */
  private cpuFaceErrs = 0;
  static readonly CPU_FACE_ERRS = 5;
  /** The processor-only face cannot track here (its frames keep failing): never offered again this session, and the face
   *  moves to tasks-vision's processor face now, untimed, without a gap (a 'setting'-kind swap). */
  private cpuFaceFailed(w: Worker, why: string) {
    markCpuFaceBroken(`frames keep failing: ${why}`);
    this.cpuFaceErrs = 0;
    if (this.fw !== w || this.mode !== 'worker') return;
    // the swap already under way is left alone until endTrial installs it (the failing worker keeps erroring meanwhile:
    // cancelling and restarting it every 5 errors never let one finish loading); one that failed is tried again 10 s on
    if (this.trial && this.trial.t === this.cpuFaceFallback) return;
    const now = performance.now();
    if (now < this.cpuFaceRetryAt) return;
    this.cpuFaceRetryAt = now + 10000;
    this.endTrial(false, 'processor-only face failed');
    const t: AutoTry = { role: 'face', to: 'CPU', why: `processor-only face failed (${why.slice(0, 80)}): standard processor face`, probe: 0, factor: Infinity, kind: 'setting' };
    this.cpuFaceFallback = t;
    this.startTrial(t);
  }
  /** The swap cpuFaceFailed started (left alone while it loads), and when a failed one may start again. */
  private cpuFaceFallback: AutoTry | null = null;
  private cpuFaceRetryAt = 0;
  /** Which engine runs the face: 'cpuface' (processor, no graphics card), else 'mediapipe' (tasks-vision). */
  get faceEngine(): 'cpuface' | 'mediapipe' { return isCpuFace(this.fw) ? 'cpuface' : 'mediapipe'; }
  private get bwModels() { return (this.bw && this.winfo.get(this.bw)?.models) || NO_MODELS; }
  private get hwModels() { return (this.hw && this.winfo.get(this.hw)?.models) || NO_MODELS; }
  /** Per model: ms + results per second (diagnostics, the Auto processor choice, the adaptive quality). */
  private meter = { face: new RoleMeter(), pose: new RoleMeter(), hands: new RoleMeter() };
  /** Why the body / hand models could not start ('' = fine). */
  bodyError = '';
  /** Where models run: 'auto' (default) | 'gpu' | 'cpu' (localStorage vtp.trackDelegate, read at init and configure). */
  delegatePolicy: DelegatePolicy = readDelegatePolicy();
  private auto = new AutoDelegate();
  /** Game mode (stallGuard.ts): a game holding the graphics card starves the face; judged on every studio tick. */
  private stallG = new StallGuard();
  /** The helper's GPU telemetry (shared/gpuStat.ts, set by the studio: src/ui/gameMode.ts). */
  gpuStat: GpuStat | null = null;
  /** The card is busy per that reading (null = unknown). Judged on every use: a reading older than GPU_STAT_FRESH_MS says
   *  nothing (stored once, a last 'busy' outlived the helper's readings and kept stall mode on: review round 1). */
  get gpuBusy(): boolean | null { return gpuBusyOf(this.gpuStat); }
  /** No stall mode at all (software 3D: there is no graphics card a game could hold; App sets it). */
  stallOff = false;
  /** Game mode entered / left (the studio's notice, src/ui/gameGpuNotice.ts). */
  onGameMode: ((on: boolean, info: StallState & { faceDelegate: string; policy: DelegatePolicy }) => void) | null = null;
  /** Stall mode is on (a game holds the graphics card): the face moved to the processor (Auto), pose / hands at most
   *  STALL.bodyHz and then off the card too, no looks back at the card. */
  get gameMode() { return this.stallG.gameMode; }
  /** The studio window has the focus (sampled every tick: Auto's looks at the card wait while it does not, after a stall). */
  private focused = true;
  /** When stall mode was last on (ms): no look at the card within 10 minutes of it. */
  private lastStallAt = -1e12;
  /** A lost stall try: the next one not before this (ms); the wait doubles per lost try (20 s .. 5 min) until stall mode
   *  ends (each try loads a model next to the game). */
  private stallRetryAt = 0;
  private stallRetryGap = 20000;
  /** The last Auto decisions (diagnostics: autoState). */
  private decisions: string[] = [];
  private note(line: string) { this.decisions.push(`${new Date().toISOString().slice(11, 19)} ${line}`); if (this.decisions.length > 5) this.decisions.shift(); }
  /** What Auto is doing (P0 observability, state.json / the beacon): the try in flight, per-model waits / back-offs /
   *  next looks, the last decisions. */
  autoState() {
    const now = performance.now(), tr = this.trial;
    return {
      trial: tr ? { role: tr.t.role, to: tr.t.to, kind: tr.t.kind, got: tr.got, ms: tr.ms.map((x) => +x.toFixed(1)), forMs: Math.round(now - tr.startT) } : null,
      roles: this.auto.state(now), stall: this.stallG.info(), focused: this.focused, decisions: [...this.decisions],
    };
  }
  /** How long the face worker itself has had its frame: from the moment the crop was handed over (the whole time since the
   *  frame was asked for when that is not known, as before). */
  private faceWorkerMs(now: number) {
    const s = this.faceSend;
    return s && s.fw === this.fw && s.acqT ? now - s.acqT : now - this.faceSentT;
  }
  /** Where a face frame's time is going, for the logs: the crop of the picture or the worker. */
  private faceAgeText(now: number) {
    const s = this.faceSend;
    if (!this.faceBusy || !s) return 'no face run in flight';
    return s.acqT ? `in the worker for ${Math.round(now - s.acqT)} ms, after a ${Math.round(s.acqT - s.t0)} ms crop` : `the crop of the picture pending for ${Math.round(now - s.t0)} ms`;
  }
  /** The crop of a face frame that is still not made after CROP_GUARD_MS (a wait on the graphics queue, or a hung
   *  createImageBitmap): the frame is dropped and the next camera frame asks again. The worker is not blamed; never more
   *  than CROP_OPEN_MAX crops open at once, and past that the old STUCK_MS applies. */
  private cropGuard(now: number) {
    const s = this.faceSend;
    if (!this.faceBusy || !s || s.acqT || s.dropped || s.fw !== this.fw || now - s.t0 <= CROP_GUARD_MS || this.cropsOpen >= CROP_OPEN_MAX) return;
    s.dropped = true; this.faceBusy = false;
    console.info(`[tracker] face: the crop of the picture took over ${CROP_GUARD_MS / 1000} s (the graphics queue?): frame dropped, asking again`);
  }
  /** The face's frame in flight for this long (ms; 0 = none). */
  get inFlightMs() { return this.faceBusy ? Math.round(performance.now() - this.faceSentT) : 0; }
  /** Game mode diagnostics (state.json, the notice). */
  stallInfo() { return { ...this.stallG.info(), faceDelegate: (this.fw && this.winfo.get(this.fw)?.delegate) || '' }; }
  /** Face first (faceFirst.ts): face-first order + the body-side rate factor, from the measured cost of the body side to
   *  the face. */
  private ff = new FaceFirst();
  /** Body-side runs of the last moments (send -> result, performance.now ms, flat [start, end, ...]): how much of each
   *  face run had pose / hand work next to it. */
  private sideRuns: number[] = [];
  /** The hands worker failed to start or crashed: the body worker runs the hand model (as on 'low'), no third worker. */
  private handsSplitOff = false;
  private autoT = 0;
  /** Set by the adaptive quality ladder (its "move to the processor" step): Auto tries a slow GPU model now. */
  private autoKick = false;
  /** The GPU failed to start a model (no WebGL2 / blocklisted driver): never offered again this session. */
  private gpuBroken = false;
  private trial: DelegateTrial | null = null;
  /** Workers just replaced: they finish the frame they have (its result still counts when it is the newest), then end. */
  private retiring = new Set<Worker>();
  /**
   * Rate caps of the body-side models, on top of the quality preset's camera-frame stride (everyFor: low every 3rd
   * camera frame, medium every 2nd, high / ultra every frame, as the shared body worker ran before).
   * poseHz: pose results per second at most (half that from adaptive level 1). Uncapped, pose alone ran on every frame
   * of a 60 fps camera, more pose work than before on the GPU the studio and OBS render with.
   * handsHz: hand-model runs per second at most (half that at adaptive level 3, where the face cannot keep up).
   * localStorage vtp.handsHz (10..60) raises it: on an idle GPU with a 60 fps camera the shared worker used to give ~48.
   * With Body on, pose and hands go on the same frames (paired, see submit): the pair rate is min(pose, hands).
   * Both are multiplied by face first's body-side factor (faceFirst.ts) while the body side measurably slows the face.
   */
  poseHz = 30;
  handsHz = Tracker.readHandsHz();
  private static readHandsHz() { try { const v = Number(localStorage.getItem('vtp.handsHz')); return v >= 10 && v <= 60 ? v : 30; } catch { return 30; } }
  /**
   * Idle back-off: while no hand has been seen for 1 s and no pose wrist is inside the frame, the hand model only looks
   * 4 times a second (8 with Body off: no wrists to watch). Most of a stream the hands are below the desk, and with
   * fewer than 2 hands tracked the model runs its palm detector on every frame. A wrist coming into view, or any hand
   * found, brings it straight back to full rate. Off (always full rate, for tests): localStorage vtp.handsIdle = '0'.
   */
  handsIdle = Tracker.readHandsIdle();
  private static readHandsIdle() { try { return localStorage.getItem('vtp.handsIdle') !== '0'; } catch { return true; } }
  /** When the last hands result with at least one hand arrived (performance.now ms). */
  private handSeenT = -1e9;
  /** Width of the frame the hand model sees (no crop): 960, as b3d88c1's body worker gave it. The landmark model works on
   *  a crop of this frame, so a smaller frame blurs the fingers of a hand that is small in the picture: at 640 px the
   *  finger flexion error on hands both sizes found rose from 14.3-15.4 to 17.6-19.5 deg (p50, far GT clip); 960 is back
   *  at 14.8-15.1. Cost: ~1.5 ms on the CPU (38 vs 36.5 ms), none measurable on the GPU. */
  static readonly HANDS_W = 960;
  private faceBusy = false;
  private bodyBusy = false;
  private handsBusy = false;
  private handsSentT = 0;
  private bodySentT = 0;
  private nextId = 1;
  private sent = new Map<number, { t: number; capture: number }>();
  private latestFace: { id: number; r: FaceLandmarkerResult | null; w: number; h: number; ms: number; t: number; capture: number; net?: FaceNetOut } | null = null;
  private latestPose: (PoseLandmarkerResult & TrackStamp) | null = null;
  private latestHands: HandsResult | null = null;
  /** The frame the newest pose / hands result came from (id, submit time s, capture ms). */
  private poseFrame = { id: 0, t: 0, capture: 0 };
  private handsFrame = { id: 0, t: 0, capture: 0 };
  /** bodyId sequence: +1 per new result of the stream that drives it (pose while Body is on, see RawTracking.bodyId). */
  private bodySeq = 0;
  /** The newest body sample: its id / frame and the pose + hands handed out with it (one camera frame when paired). */
  private latestBody: BodySample | null = null;
  /** Body samples not handed out yet, oldest first, and the last one handed out. A result takes the oldest (at most one
   *  more waits): a pair finishes around its own frame's face result, and handing out only the newest skipped the older
   *  of two samples that landed between two face results (modelled: 23 of 30 samples a second reached the solver). */
  private bodyQ: BodySample[] = [];
  private givenBody: BodySample | null = null;
  /** Paired body frames (pose + hands workers, one camera frame): the frame id both got (0 = the last pose frame went
   *  alone), and since when its pose result waits for its hands result (-1 = it does not). */
  private pairId = 0;
  private posePendT = -1;
  /** Face first with pose and hands both on the GPU: the pair runs one after the other (as the shared body worker ran
   *  them), not both next to the face: the hands' frame (grabbed with the pose's, same camera frame) waits here until the
   *  pose result lands. */
  private heldHands: { w: Worker; bmp: Promise<ImageBitmap>; msg: object; at: number } | null = null;
  /** When the last pose result arrived (performance.now ms). */
  private poseArrT = -1e9;
  private consumed = 0;
  private rvfcVideo: HTMLVideoElement | null = null;
  private lastRvfc = 0;
  private lastVideoTime = -1;
  private resultCount = 0;
  private fpsT = performance.now();
  private bodyEvery = 1;
  /** Camera frames delivered so far (rVFC presentedFrames, so frames the page skipped count too; +1 per new frame on the
   *  hidden-tab poll), the newest one's capture time, and the camera frame each worker last got. */
  private camFrame = 0;
  private lastPresented = -1;
  private lastCapture = 0;
  /** The newest camera frame's time (performance.now() ms when the page got it: the rVFC callback / the hidden-tab poll):
   *  the stamp of every frame sent, also one sent later when a worker came free. (Stamping the send time instead put
   *  0-17 ms of noise on pose / hand sample times at 60 fps.) And when it was handed to the compositor (rVFC
   *  presentationTime; else the same): a later send only grabs this frame while the next one cannot be there yet. */
  private frameT = 0;
  private framePres = 0;
  private poseCam = -1e9;
  private handsCam = -1e9;
  /** The video being fed (result-triggered resubmits grab its newest frame). */
  private feedVideo: HTMLVideoElement | null = null;

  async init(opts: TrackerOptions, onStatus?: (s: string) => void) {
    this.opts = opts;
    this.handsIdle = Tracker.readHandsIdle();
    this.handsHz = Tracker.readHandsHz();
    this.readPolicy();
    // Face and body-only trackers need different worker sets; a changed role replaces a pending start.
    if (this.initialization && this.initialization.face !== (opts.face !== false)) this.close();
    if (this.face && !this.initialization) return this.configure(opts, onStatus);
    let pending = this.initialization;
    if (!pending) {
      pending = { controller: new AbortController(), promise: Promise.resolve(), face: opts.face !== false, status: onStatus };
      this.initialization = pending;
      const current = pending;
      pending.promise = this.initialize(opts, pending.controller.signal, (s) => {
        if (this.initialization === current && !current.controller.signal.aborted) current.status?.(s);
      });
    } else pending.status = onStatus;
    try {
      await pending.promise;
      if (pending.controller.signal.aborted) throw new DOMException('Tracker start cancelled', 'AbortError');
      // Options may have changed while the shared load was pending. The latest caller wins.
      await this.configure(this.opts, (s) => { if (!pending.controller.signal.aborted) onStatus?.(s); }, pending.controller.signal);
      if (pending.controller.signal.aborted) throw new DOMException('Tracker start cancelled', 'AbortError');
    } finally {
      if (this.initialization === pending) this.initialization = null;
    }
  }

  private async initialize(opts: TrackerOptions, signal: AbortSignal, onStatus: (s: string) => void) {
    const forceMain = new URLSearchParams(location.search).has('mainTracker');
    try {
      if (forceMain || typeof OffscreenCanvas === 'undefined') throw new Error('workers disabled');
      onStatus('Starting face tracking.');
      await this.initWorkers(opts, signal);
      if (signal.aborted) throw new DOMException('Tracker start cancelled', 'AbortError');
      this.mode = 'worker';
    } catch (e) {
      if (signal.aborted || !this.allowMain) throw e;
      console.warn('[tracker] worker tracking unavailable, using main thread:', e);
      // A cancelled fallback can finish after a new start. It owns a separate main tracker.
      const main = new MainThreadTracker();
      try {
        await main.init(opts, onStatus, signal);
        if (signal.aborted) throw new DOMException('Tracker start cancelled', 'AbortError');
        this.main.close();
        this.main = main;
        this.mode = 'main';
      } catch (error) { main.close(); throw error; }
    }
    this.face = true;
    if (this.mode === 'worker') onStatus('Tracking ready');
  }

  /** The worker currently serving a role (results from any other worker of that role are ignored). */
  private current(role: 'face' | 'body' | 'hands') { return role === 'face' ? this.fw : role === 'body' ? this.bw : this.hw; }

  private spawn(role: 'face' | 'body' | 'hands', opts: TrackerOptions, delegate?: 'GPU' | 'CPU', reason = '', signal?: AbortSignal): Promise<Worker> {
    // cpuFace hook: a face on the processor runs on the processor-only engine (no WebGL) when cpuFaceFor() says so; one
    // that fails to start marks the engine broken for the session and this start falls back to tasks-vision's CPU face
    const cpu = role === 'face' && delegate === 'CPU' && cpuFaceFor(this.delegatePolicy);
    if (cpu) {
      return this.spawnWorker(role, opts, delegate, reason, signal, true).catch((e) => {
        if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e;
        const msg = String((e as Error)?.message ?? e);
        markCpuFaceBroken(msg);
        // (the reason says what happened: tasks-vision's processor face, which still uses the graphics card a little)
        return this.spawnWorker(role, opts, delegate, `${reason ? `${reason}; ` : ''}processor-only face unavailable (${msg.slice(0, 80)}): standard processor face`, signal, false);
      });
    }
    return this.spawnWorker(role, opts, delegate, reason, signal, false);
  }

  private spawnWorker(role: 'face' | 'body' | 'hands', opts: TrackerOptions, delegate: 'GPU' | 'CPU' | undefined, reason: string, signal: AbortSignal | undefined, cpu: boolean): Promise<Worker> {
    return new Promise((resolve, reject) => {
      const w = cpu ? spawnCpuFaceWorker(`vtp-${role}`) : new Worker(new URL('./trackWorker.ts', import.meta.url), { type: 'module', name: `vtp-${role}` });
      let settled = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const fail = (err: Error) => { if (settled) return; settled = true; cleanup(); w.terminate(); reject(err); };
      const abort = () => fail(new DOMException('Tracker start cancelled', 'AbortError'));
      const timer = setTimeout(() => fail(new Error(`${role} worker init timeout`)), 45000);
      w.onmessage = (e: MessageEvent<WorkerMsg>) => {
        if (settled) return;
        const m = e.data;
        if (m.type === 'ready') {
          settled = true;
          cleanup();
          const d = m.delegate === 'CPU' ? 'CPU' : 'GPU';
          this.winfo.set(w, { delegate: d, reason: m.fallback ?? (d === 'CPU' ? reason : ''),
            models: { body: role === 'body' && !!(m.models?.body ?? opts.body), hands: role !== 'face' && !!(m.models?.hands ?? opts.hands) } });
          if (m.fallback) this.gpuBroken = true;
          w.onmessage = (ev: MessageEvent<WorkerMsg>) => this.route(role, w, ev.data);
          w.onerror = (ev) => this.crashed(role, w, ev.message);
          if (role === 'face' && this.fnet.model) { try { w.postMessage({ type: 'facenet', model: this.fnet.model }); } catch { /* the worker is gone: the next one gets it */ } }
          resolve(w);
        } else if (m.type === 'error') fail(new Error(m.message));
      };
      w.onerror = (ev) => fail(new Error(ev.message || `${role} worker failed`));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        w.postMessage({ type: 'init', role, base: `${location.origin}${BASE}`, tier: opts.tier, body: opts.body, hands: opts.hands,
          ...(delegate ? { delegate } : {}), warm: Tracker.WARM[role], ...(cpu ? cpuFaceInit() : {}) });
      } catch (e) { fail(e as Error); }
    });
  }

  /** Warm-up sizes per role: what each worker will be fed (face: the 512 crop + a 960 frame; body 960; hands 960). */
  private static readonly WARM: Record<'face' | 'body' | 'hands', [number, number][]> = { face: [[512, 512], [960, 540]], body: [[960, 540]], hands: [[960, 540]] };

  /** Where a model starts (delegatePolicy.ts: the setting; Auto = every model on the GPU, a busy one is measured and moved). */
  private initialDelegate(role: TrackRole): { d: 'GPU' | 'CPU'; why: string } {
    const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 0 : 0;
    return startDelegate(role, this.delegatePolicy, n, this.gpuBroken);
  }

  /** Messages of any tracking worker: the live one, a candidate being timed, or one being replaced. */
  private route(role: 'face' | 'body' | 'hands', w: Worker, m: WorkerMsg) {
    if (w === this.current(role)) this.onResult(m, w);
    else if (this.trial?.w === w) this.onTrialMsg(m);
    else if (this.retiring.has(w) && (m.type === 'result' || m.type === 'error')) {
      if (m.type === 'result') this.onResult(m, w, true);
      this.retire(w);
    }
  }

  private crashed(role: 'face' | 'body' | 'hands', w: Worker, msg: string) {
    if (w === this.current(role) && role === 'hands' && this.bw && this.mode === 'worker') {
      // the optional hands worker: the body worker takes the hand model back (as on 'low'); face and pose keep running
      console.warn('[tracker] hands worker crashed; the body worker runs the hand model', msg);
      this.hw = null; this.handsBusy = false; this.handsSplitOff = true;
      w.terminate();
      this.dropHeldHands();
      this.settlePair(performance.now(), true);
      this.syncConfig();
    } else if (w === this.current(role)) { console.warn(`[tracker] ${role} worker crashed`, msg); this.fallback(); }
    else if (this.trial?.w === w) this.endTrial(false, `crashed: ${msg}`);
    else this.retire(w);
  }

  private retire(w: Worker) { if (this.retiring.delete(w)) w.terminate(); }

  private spawnRole(role: 'body' | 'hands', o: TrackerOptions, signal?: AbortSignal) {
    // the body worker runs the hand model only while there is no hands worker (Body off, or the 'low' preset)
    if (role === 'body') { const d = this.initialDelegate('pose'); return this.spawn('body', { ...o, tier: this.stallG.gameMode && (o.tier === 'high' || o.tier === 'ultra') ? 'medium' : o.tier, hands: o.hands && !this.split(o) }, d.d, d.why, signal); }
    const d = this.initialDelegate('hands');
    return this.spawn('hands', { ...o, body: false, hands: true }, d.d, d.why, signal);
  }

  /** Hands in their own worker: with Body and Hands on, except on the 'low' preset, where one body worker runs both
   *  models on the same frames as before (no third worker / GPU context on the weakest machines), and after the hands
   *  worker failed to start or crashed (the body worker takes the hand model back instead of all tracking falling back
   *  to the main thread). */
  private split(o: TrackerOptions = this.opts) { return o.body && o.hands && o.tier !== 'low' && !this.handsSplitOff; }

  /** Camera frames between two pose / hand-model frames per quality preset (the rate caps come on top). */
  private everyFor(tier: QualityTier) { return tier === 'low' ? 3 : tier === 'medium' ? 2 : 1; }
  /** The preset's stride as a rate (camera frames per second / stride), so face first can scale every preset (no cap at
   *  stride 1: the camera's own rate is the limit there, and an unmeasured camera must not read as 30 fps). */
  private strideHz(now: number) { return this.bodyEvery > 1 ? this.camFps(now) / this.bodyEvery : Infinity; }
  /** Pose results per second at most: poseHz (half that from adaptive level 1), the preset's stride, times face first's
   *  body-side factor (faceFirst.ts: 1, down to 0.5 while the body side measurably slows the face). */
  private poseRate(now = performance.now(), base = this.poseHz) { return Math.min(this.adaptLevel ? base / 2 : base, this.strideHz(now), bodyCapFor(this.delegatePolicy)) * this.ff.scale; }
  /** Hand-model runs per second at most: handsHz (half that at adaptive level 3, where the face cannot keep up even
   *  then), the preset's stride, times face first's body-side factor. */
  private handsRate(now = performance.now()) { return Math.min(this.adaptLevel >= 3 ? this.handsHz / 2 : this.handsHz, this.strideHz(now), bodyCapFor(this.delegatePolicy)) * this.ff.scale; }
  /**
   * The rate caps run on a grid of slots (performance.now ms), one per period (1000 / rate): a frame may go once its slot
   * is less than half a camera interval away, and the next slot is one period after the SLOT, not after the moment the
   * frame went. Camera frames reach the page on display ticks (rVFC runs in the rendering step: 60 / 120 / 144 / 165 Hz
   * monitors) and unevenly, so spacing the sends themselves by a period (minus 2 ms) skipped a frame whenever two frames
   * landed less than a period apart, and the send waited for a third: 30 a second became 22-24 on a 60 fps camera
   * (144 / 165 Hz display, or the ~47 frames a second headless Chrome presents), 15-19 on a jittery 30 fps webcam.
   * On the grid an early or late frame does not move the next slot, so the average stays at the cap and never above it
   * (one frame per slot). A send more than half a period late (a busy worker, a pause, the idle back-off) restarts the
   * grid from that send.
   */
  private poseSlot = 0;
  private handsSlot = 0;
  private slotDue(slot: number, now: number, hz: number) {
    return now >= slot - Math.min(1000 / this.camFps(now), 1000 / Math.max(1, hz)) / 2;
  }
  private nextSlot(slot: number, now: number, hz: number) {
    const p = 1000 / Math.max(1, hz);
    return Math.max(slot + p, now + p / 2);
  }

  private async initWorkers(opts: TrackerOptions, signal: AbortSignal) {
    const fd = this.initialDelegate('face');
    const all = await Promise.allSettled([
      opts.face === false ? Promise.resolve(null) : this.spawn('face', opts, fd.d, fd.why, signal),
      opts.body || opts.hands ? this.spawnRole('body', opts, signal) : Promise.resolve(null),
      this.split(opts) ? this.spawnRole('hands', opts, signal) : Promise.resolve(null),
    ]);
    if (signal.aborted) { for (const r of all) if (r.status === 'fulfilled') r.value?.terminate(); throw new DOMException('Tracker start cancelled', 'AbortError'); }
    // (the optional hands worker failing to start, e.g. its 45 s timeout while three workers load at once on a first web
    // run, must not send ALL tracking to the main thread: the body worker takes the hand model, as on 'low')
    const handsBad = all[2].status === 'rejected' && all[0].status === 'fulfilled' && all[1].status === 'fulfilled' && !!all[1].value;
    if (handsBad) console.warn('[tracker] hands worker failed to start; the body worker runs the hand model', (all[2] as PromiseRejectedResult).reason);
    const bad = all.find((r, k) => r.status === 'rejected' && !(handsBad && k === 2)) as PromiseRejectedResult | undefined;
    if (bad) { for (const r of all) if (r.status === 'fulfilled') r.value?.terminate(); throw bad.reason; }
    const [fw, bw, hw] = all.map((r) => (r.status === 'fulfilled' ? r.value : null));
    this.fw = fw; this.bw = bw; this.hw = hw;
    this.bodyEvery = this.everyFor(opts.tier);
    if (handsBad) { this.handsSplitOff = true; this.syncConfig(); }
  }

  /** End every tracking worker (not the food & drink one). */
  private endWorkers() {
    this.endTrial(false, 'stopped');
    this.dropHeldHands();
    for (const w of this.retiring) w.terminate();
    this.retiring.clear();
    this.fw?.terminate(); this.bw?.terminate(); this.hw?.terminate(); this.fw = this.bw = this.hw = null;
    this.faceBusy = this.bodyBusy = this.handsBusy = false;
  }

  /** The "Tracking processor" setting changed (localStorage vtp.trackDelegate): apply it now, not at the next camera
   *  start (the Auto loop moves one model at a time, each swapped without a gap). */
  refreshPolicy() { this.readPolicy(); }

  /** The processor setting (a change is applied by the Auto loop: one model at a time, each swapped without a gap). */
  private readPolicy() {
    const p = readDelegatePolicy();
    if (p !== this.delegatePolicy) { this.delegatePolicy = p; this.auto.reset(); }
  }

  /** A worker died mid-session — switch to the main-thread tracker instead of freezing. */
  private fallback() {
    if (this.mode === 'main') return;
    if (!this.allowMain) { this.endWorkers(); this.failed = 'tracking worker crashed'; return; }
    this.endWorkers();
    this.ow?.terminate(); this.ow = null;
    this.mode = 'main';
    void this.main.init(this.opts);
  }

  /**
   * Apply new options. Hands / Body switches (shared/trackParts.ts): a model that is switched off is closed in the body
   * worker right away, and with both off the body worker itself ends (its models, GPU context and memory are freed);
   * switching one back on starts it again. Overlapping calls are safe: the last options always win.
   */
  async configure(opts: TrackerOptions, onStatus?: (s: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Tracker start cancelled', 'AbortError');
    this.opts = opts;
    if (this.mode === 'main') return this.main.configure(opts, onStatus, signal);
    this.handsIdle = Tracker.readHandsIdle();
    this.handsHz = Tracker.readHandsHz();
    this.readPolicy();
    this.endTrial(false, 'settings changed');
    // the face model on / off at run time (opts.face): off ends the face worker (nothing runs, no frames go to it, the stall /
    // Auto logic that watches it goes quiet); back on starts one again. Pose and hands carry on either way.
    if (opts.face === false) this.dropFace();
    else if (this.faceDropped) await this.startFace(signal);
    this.bodyEvery = this.everyFor(opts.tier);
    if (!opts.body) { this.latestPose = null; if (this.handRoiMode !== 'follow') { this.handRoi = null; this.handRoiInfo = null; } }
    if (!opts.hands) { this.latestHands = null; this.handRoi = null; this.handRoiInfo = null; this.stopHands(); }
    // (a part switched off is gone from the body samples handed out right away, not at the next sample)
    const strip = (s: BodySample): BodySample => ({ ...s, pose: opts.body ? s.pose : null, hands: opts.hands ? s.hands : null });
    if (this.latestBody) this.latestBody = strip(this.latestBody);
    if (this.givenBody) this.givenBody = strip(this.givenBody);
    this.bodyQ = this.bodyQ.map(strip);
    if (!opts.body && !opts.hands) { this.stopBody(); return; }
    // (this.face: initialised and not closed; a body-only tracker — camera 2 in the Body role — has no face worker)
    if (!this.face) return;
    const split = this.split(opts);
    if (!this.bw || (split && !this.hw)) onStatus?.('Loading body + hand models…');
    // the body worker gets its config as soon as it is there: Body switched on while Hands is on does not wait for a
    // hands worker to start (seconds, up to its 45 s timeout) before the pose model starts loading; the body worker keeps
    // the hand model until the hands worker is ready (syncConfig), then hands it over
    const hands = split ? this.ensureWorker('hands', signal).then(() => { if (this.face && this.mode === 'worker') this.syncConfig(); }) : null;
    const body = this.ensureWorker('body', signal).then(() => this.syncConfig());
    await Promise.all([body, hands]);
  }

  /** The face worker was ended on purpose by configure({face:false}) (so configure({face:true}) knows to start it again; a
   *  body-only tracker that never had one is left alone). */
  private faceDropped = false;
  private faceStart: Promise<void> | null = null;
  /** End the face worker now: no frame in flight, no result kept, no trial, no Auto / stall decision about it. */
  private dropFace() {
    const w = this.fw;
    if (!w || this.mode !== 'worker') return;
    this.endTrial(false, 'face off');
    this.fw = null;
    this.faceBusy = false; this.faceDropped = true;
    this.latestFace = null; this.consumed = 0;
    this.meter.face.reset();
    this.faceSplit = { acq: 0, recv: 0, up: 0, rb: 0, inf: 0 };
    this.cpuFaceStats = null; this.cpuFaceErrs = 0;
    this.retiring.delete(w);
    w.terminate();
    console.info('[tracker] face model off (another face source drives the avatar)');
  }
  /** Start the face worker again after dropFace (overlapping calls share one start). A failure throws: the caller says it. */
  private startFace(signal?: AbortSignal): Promise<void> {
    if (this.fw || !this.faceDropped || !this.face || this.mode !== 'worker') return Promise.resolve();
    this.faceStart ??= (async () => {
      const generation = this.closeGeneration;
      const fd = this.initialDelegate('face');
      const w = await this.spawn('face', this.opts, fd.d, fd.why, signal);
      // (closed, switched off again, or started by someone else while it loaded)
      if (generation !== this.closeGeneration || this.opts.face === false || this.fw || this.mode !== 'worker') { w.terminate(); return; }
      this.fw = w; this.faceBusy = false; this.faceDropped = false;
      this.latestFace = null; this.consumed = 0;
      console.info('[tracker] face model back on');
    })().finally(() => { this.faceStart = null; });
    return this.faceStart;
  }

  /** Start the body / hands worker when it is wanted and missing (overlapping configure() calls share one start). */
  private async ensureWorker(role: 'body' | 'hands', signal?: AbortSignal) {
    const generation = this.closeGeneration;
    if (this.current(role) || !this.face) return;
    let p = role === 'body' ? this.bwSpawn : this.hwSpawn;
    if (!p) {
      p = this.spawnRole(role, this.opts, signal).finally(() => {
        if (role === 'body') { if (this.bwSpawn === p) this.bwSpawn = null; }
        else if (this.hwSpawn === p) this.hwSpawn = null;
      });
      if (role === 'body') this.bwSpawn = p; else this.hwSpawn = p;
    }
    let w: Worker;
    try { w = await p; } catch (e) {
      if (signal?.aborted) throw e;
      if (generation !== this.closeGeneration) return;
      // (a hands worker that cannot start: the body worker runs the hand model instead, no error for the user)
      if (role === 'hands') { this.handsSplitOff = true; console.warn('[tracker] hands worker failed to start; the body worker runs the hand model', e); return; }
      this.bodyError = String((e as Error)?.message ?? e); console.warn('[tracker] body model failed to start', e); return;
    }
    if (signal?.aborted) { w.terminate(); throw new DOMException('Tracker start cancelled', 'AbortError'); }
    if (generation !== this.closeGeneration) { w.terminate(); return; }
    if (this.current(role) === w) return;
    const o = this.opts;
    const wanted = !!this.face && this.mode === 'worker' && (role === 'body' ? o.body || o.hands : this.split(o));
    if (this.current(role) || !wanted) { w.terminate(); return; } // switched off (or closed) while it loaded
    if (role === 'body') { this.bw = w; this.bodyBusy = false; } else { this.hw = w; this.handsBusy = false; }
    this.bodyError = '';
  }

  /**
   * Tell the body worker what to run and hand the hands over between the two workers. With Body on, the hand model runs
   * in the hands worker (the body worker keeps it only until a starting hands worker is ready, when it had it before);
   * with Body off (or the 'low' preset) the body worker runs it, and a hands worker still running ends once the body
   * worker has it loaded.
   */
  private syncConfig() {
    const o = this.opts;
    const split = this.split(o);
    const hwReady = !!this.hw && this.hwModels.hands;
    const bwHands = o.hands && (!split || (!hwReady && this.bwModels.hands));
    this.bw?.postMessage({ type: 'config', tier: this.workerTier(), body: o.body, hands: bwHands });
    this.dropSpareHands();
  }

  /** The hands worker ends when Hands is off, or the hands go to the body worker (Body off / 'low') and it has them loaded. */
  private dropSpareHands() {
    const o = this.opts;
    if (this.hw && (!o.hands || (!this.split(o) && this.bwModels.hands))) this.stopHands();
  }

  private stopHands() {
    if (this.trial?.role === 'hands') this.endTrial(false, 'hands off');
    this.hw?.terminate(); this.hw = null; this.handsBusy = false;
    this.dropHeldHands();
    this.settlePair(performance.now(), true);
  }

  /** Post the hands' frame that waited for the pose result (serial pair, see heldHands); its run starts now. */
  private releaseHands() {
    const h = this.heldHands;
    if (!h) return;
    this.heldHands = null;
    if (h.w !== this.hw) { void h.bmp.then((b) => b.close(), () => {}); this.handsBusy = false; return; }
    this.handsSentT = performance.now();
    void h.bmp.then((b) => h.w.postMessage({ ...h.msg, bitmap: b }, [b])).catch(() => { if (this.hw === h.w) this.handsBusy = false; });
  }

  private dropHeldHands() {
    const h = this.heldHands;
    if (!h) return;
    this.heldHands = null;
    void h.bmp.then((b) => b.close(), () => {});
  }

  /** End the body + hands workers (both Hands and Body are off): nothing of the pose / hand models keeps running. */
  private stopBody() {
    if (this.trial && this.trial.role !== 'face') this.endTrial(false, 'body off');
    this.bw?.terminate(); this.bw = null; this.bodyBusy = false;
    this.stopHands();
    this.latestPose = null; this.latestHands = null; this.latestBody = null; this.givenBody = null; this.bodyQ.length = 0;
    this.poseFrame = { id: 0, t: 0, capture: 0 }; this.handsFrame = { id: 0, t: 0, capture: 0 }; this.poseArrT = -1e9;
    this.pairId = 0; this.posePendT = -1; this.sideRuns.length = 0; this.ff.reset();
    this.handRoi = null; this.handRoiInfo = null;
    this.meter.pose.reset(); this.meter.hands.reset();
  }

  /** A pose wrist inside the frame (each judged on its own): a hand may be about to show up. */
  private wristInView() {
    if (!this.opts.body) return false;
    const pl = this.latestPose?.landmarks?.[0];
    if (pl && pl.length > 16) for (const i of [15, 16]) { const p = pl[i]; if ((p.visibility ?? 0) > 0.5 && p.x > 0.01 && p.x < 0.99 && p.y < 0.97) return true; }
    return false;
  }

  /** The hand model runs at its full rate (the idle back-off is not holding it): Auto only judges its speed then. */
  private handsAtFullRate(now: number) { return !this.handsIdle || now - this.handSeenT < 1000 || this.wristInView(); }

  /** Should the hand model look at this frame? (idle back-off: see handsIdle) */
  private handsWanted(now: number) {
    return this.handsAtFullRate(now) || now - this.handsSentT >= (this.opts.body ? 250 : 125);
  }

  /** Who runs the hand model now: the hands worker once it is ready, else the body worker when it has the model. */
  private handsHost(): Worker | null {
    if (!this.opts.hands) return null;
    if (this.hw && this.hwModels.hands) return this.hw;
    if (this.bw && this.bwModels.hands) return this.bw;
    return null;
  }

  /** Which models run right now (the face model, and the pose / hand models as the body worker reports them). */
  models(): TrackerModels {
    if (this.mode === 'main') return { face: !!this.main.face, body: !!this.main.pose, hands: !!this.main.hands, mode: 'main' };
    const m: TrackerModels = { face: !!this.fw, body: !!this.bw && this.bwModels.body, hands: !!this.handsHost(), mode: 'worker' };
    // per model delegate / ms / results per second / fallback reason: once there is something to report
    if (this.meter.face.seen || this.meter.pose.seen || this.meter.hands.seen) m.roles = this.roleStats(performance.now());
    return m;
  }

  /** Per model: where it runs, ms per run, results per second and why (null = that model is not running). */
  private roleStats(now: number): NonNullable<TrackerModels['roles']> {
    const r = (w: Worker, mt: RoleMeter, model?: string): TrackRoleStats => {
      const i = this.winfo.get(w);
      return { delegate: i?.delegate ?? 'GPU', ms: +mt.ms.toFixed(1), hz: +mt.hz(now).toFixed(1), reason: i?.reason ?? '', ...(model ? { model } : {}) };
    };
    const hh = this.handsHost();
    // (pose / hands: the rate cap now, and why when face first holds the body side back)
    const capped = (s: TrackRoleStats, hz: number): TrackRoleStats => ({ ...s, cap: +hz.toFixed(1),
      ...(this.ff.scale < 0.999 ? { reason: `${s.reason ? `${s.reason}; ` : ''}face first: ${Math.round(this.ff.scale * 100)} % rate (the face needs the time)` } : {}) });
    return {
      face: this.fw ? { ...r(this.fw, this.meter.face), engine: this.faceEngine, split: Object.fromEntries(Object.entries(this.faceSplit).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v])) as unknown as FaceSplit } : null,
      pose: this.bw && this.bwModels.body ? capped(r(this.bw, this.meter.pose, TIER[this.opts.tier].pose), this.poseRate(now)) : null,
      hands: hh ? capped(r(hh, this.meter.hands), this.handsRate(now)) : null,
    };
  }

  /** `stale`: the result of a worker that was just replaced (no busy flag, no timing, no resubmit; kept when newest). */
  private onResult(m: WorkerMsg, w?: Worker, stale = false) {
    if (stale) {
      if (m.type !== 'result') return;
      const now = performance.now(), info = m.id ? this.sent.get(m.id) : undefined;
      if (m.role === 'face') { if (!this.latestFace || (m.id ?? 0) > this.latestFace.id) this.takeFace(m, info, now); }
      else if (m.role === 'hands') this.takeHands(m.hands ?? null, m.id ?? 0, info, now);
      else {
        // (hands first: a pose result of the same frame then hands out both as one body sample)
        if (m.handsMs !== null && m.handsMs !== undefined) this.takeHands(m.hands ?? null, m.id ?? 0, info, now);
        if (m.poseMs !== null && m.poseMs !== undefined) this.takePose(m.pose ?? null, m.id ?? 0, info, now);
        this.releaseHands(); // (a serial pair's hands frame waited for this pose result)
      }
      return;
    }
    if (m.type === 'error') {
      console.warn('[tracker]', m.role, m.message);
      if (m.role === 'face') this.faceBusy = false; else if (m.role === 'hands') this.handsBusy = false; else { this.bodyBusy = false; this.releaseHands(); }
      // cpuFace hook: a processor-only face that fails frame after frame (it cannot read this camera's frames) gives way
      if (m.role === 'face' && w && isCpuFace(w) && ++this.cpuFaceErrs >= Tracker.CPU_FACE_ERRS) this.cpuFaceFailed(w, m.message ?? '');
      return;
    }
    if (m.type === 'configured') {
      const i = w && this.winfo.get(w);
      if (i) {
        if (m.models) i.models = { body: !!m.models.body, hands: !!m.models.hands };
        if (m.delegate) { i.delegate = m.delegate; if (m.fallback) i.reason = m.fallback; }
      }
      this.dropSpareHands();
      return;
    }
    if (m.type !== 'result') return;
    const now = performance.now();
    const info = m.id ? this.sent.get(m.id) : undefined;
    if (m.role === 'face') {
      // (a worker that took over can deliver a frame older than one its predecessor delivered last: keep the newest)
      if (this.latestFace && (m.id ?? 0) <= this.latestFace.id) { this.faceBusy = false; return; }
      const faceMs = (m.ms ?? 0) - (m.mouthMs ?? 0) - (m.net?.ms ?? 0); // (the face model's crops + net are not the face model's time either: faceNet/runtime.ts)
      // face first (faceFirst.ts): how much of this face run had pose / hand work next to it (while the busy flags still
      // say what is in flight), not while a candidate worker doubles a model's load
      const quiet = this.ff.quiet(now);
      if (!this.trial?.w) this.ff.sample(now, faceMs, this.sideOverlap(this.faceSentT, now));
      this.faceBusy = false;
      this.takeFace(m, info, now);
      // (the face figure every gate uses leaves the mouth-patch read out: it is not the face model's time; the patch is
      // read in the same pass and arrives with its own frame's landmarks, see trackWorker.ts detectFace)
      this.timing.face += (faceMs - this.timing.face) * 0.1;
      this.timing.mouth += ((m.mouthMs ?? 0) - this.timing.mouth) * 0.1;
      if (m.mouthMs) this.timing.mouthPatch += (m.mouthMs - this.timing.mouthPatch) * 0.2;
      this.meter.face.add(faceMs, now);
      this.stallG.result(now, faceMs);
      if (m.split) {
        const S = this.faceSplit, k = 0.1;
        S.acq += (m.split.acq - S.acq) * k; S.recv += (m.split.recv - S.recv) * k; S.up += (m.split.up - S.up) * k;
        S.rb += (m.split.rb - S.rb) * k; S.inf += (m.split.inf - S.inf) * k;
      }
      this.cpuFaceStats = m.cpu ?? null; this.cpuFaceErrs = 0; // cpuFace hook (diagnostics, the error run)
      if (m.net?.vals) this.netGate.observe(m.net.ms, this.framePeriod(now)); // ("My face model": the net ran on this frame: its own cost)
      if (this.trial?.w && this.trial.role !== 'face' && this.trial.got > 0) this.trial.faceDuring.push(faceMs);
      this.adapt(this.timing.face, now);
      if (info) this.timing.latency += (now - info.capture - this.timing.latency) * 0.1;
      this.resultCount++;
      if (now - this.fpsT > 1000) { this.timing.fps = (this.resultCount * 1000) / (now - this.fpsT); this.resultCount = 0; this.fpsT = now; }
      // (frozen while a candidate is timed: its samples are left out, so the window would read as "no cost")
      if (!this.trial?.w) this.ff.tick(now, { faceHz: this.timing.fps, camFps: this.camFps(now), side: !!(this.bw || this.hw) });
      this.autoTick(now);
      // face first: the body-side frame that waited for this face result (the order, or a probe that just ended) goes now
      if (this.ff.active || (quiet && !this.ff.quiet(now))) this.resubmit();
    } else if (m.role === 'hands') {
      this.noteSideRun(this.handsSentT, now);
      this.handsBusy = false;
      const ms = m.handsMs ?? m.ms ?? 0;
      this.timing.hands += (ms - this.timing.hands) * 0.1;
      this.meter.hands.add(ms, now);
      this.takeHands(m.hands ?? null, m.id ?? 0, info, now);
      this.resubmit();
    } else {
      this.noteSideRun(this.bodySentT, now);
      this.bodyBusy = false;
      this.timing.body += ((m.ms ?? 0) - this.timing.body) * 0.1;
      const ranPose = m.poseMs !== undefined ? m.poseMs !== null : this.bwModels.body;
      const ranHands = m.handsMs !== undefined ? m.handsMs !== null : this.bwModels.hands;
      if (typeof m.poseMs === 'number') this.meter.pose.add(m.poseMs, now);
      if (typeof m.handsMs === 'number') { this.meter.hands.add(m.handsMs, now); this.timing.hands += (m.handsMs - this.timing.hands) * 0.1; }
      // (hands first: the pose result of the same frame then hands out both as one body sample)
      if (ranHands) this.takeHands(m.hands ?? null, m.id ?? 0, info, now);
      if (ranPose) this.takePose(m.pose ?? null, m.id ?? 0, info, now);
      // a serial pair (face first, both on the GPU): the hands now run on the same frame
      this.releaseHands();
      this.resubmit();
    }
  }

  /** A body-side run ended (send -> result): kept for the face's overlap measure (the last ~2 s; 24 runs at most). */
  private noteSideRun(start: number, end: number) {
    if (!(start > 0) || end <= start) return;
    const r = this.sideRuns;
    r.push(start, end);
    while (r.length > 48 || (r.length && end - r[1] > 2000)) r.splice(0, 2);
  }

  /** Share (0..1) of [s, e] during which a pose or hand-model run was in flight (ended runs + the ones still running). */
  private sideOverlap(s: number, e: number): number {
    if (!(e > s)) return 0;
    const iv: [number, number][] = [];
    const add = (a: number, b: number) => { const x = Math.max(s, a), y = Math.min(e, b); if (y > x) iv.push([x, y]); };
    for (let k = 0; k < this.sideRuns.length; k += 2) add(this.sideRuns[k], this.sideRuns[k + 1]);
    if (this.bodyBusy && this.bw) add(this.bodySentT, e);
    if (this.handsBusy && this.hw && !this.heldHands) add(this.handsSentT, e); // (a held serial-pair frame is not running yet)
    if (!iv.length) return 0;
    iv.sort((p, q) => p[0] - q[0]);
    let tot = 0, cs = iv[0][0], ce = iv[0][1];
    for (const [a, b] of iv) { if (a > ce) { tot += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); }
    tot += ce - cs;
    return Math.min(1, tot / (e - s));
  }

  private takeFace(m: WorkerMsg, info: { t: number; capture: number } | undefined, now: number) {
    const r = m.face ?? null;
    this.latestFace = { id: m.id!, r, w: m.width ?? 0, h: m.height ?? 0, ms: m.ms ?? 0, t: info?.t ?? now, capture: info?.capture ?? info?.t ?? now, ...(m.net ? { net: m.net } : {}) };
    this.updateRoi(r?.faceLandmarks?.[0], m.width ?? 0, m.height ?? 0);
  }

  // ---- Auto processor choice (delegatePolicy.ts): one try at a time; the candidate is timed next to the live worker
  /** Camera frames per second: measured from rVFC, else the camera's setting, else 30 (10..60). */
  private camRate = { n: 0, t0: 0, fps: 0 };
  camFps(now = performance.now()) {
    const meas = now - this.camRate.t0 < 2500 ? this.camRate.fps : 0;
    let set = 0;
    try { set = ((this.feedVideo?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]?.getSettings?.().frameRate) ?? 0; } catch { /* no track */ }
    return Math.min(60, Math.max(10, meas > 5 ? meas : set > 0 ? set : 30));
  }

  private roleView(w: Worker | null, key: TrackRole): RoleView | null {
    const i = w && this.winfo.get(w), mt = this.meter[key];
    return i && mt.count >= 10 ? { delegate: i.delegate, ms: mt.ms } : null;
  }

  private stallMoveT = 0;
  /** Camera frames per second as measured (0 = not measured lately). */
  private measuredCamFps(now: number) { return now - this.camRate.t0 < 2500 ? this.camRate.fps : 0; }

  /** Stall mode (stallGuard.ts), on every studio tick: results or not (Auto ticks only on face results). The main
   *  camera's face tracker only (a secondary camera runs gated / capped on purpose). */
  private stallTick(now: number) {
    this.expireSpawn(now);
    if (this.mode !== 'worker' || !this.fw || !this.allowMain || this.gate || this.stallOff) return;
    const fd = (this.fw && this.winfo.get(this.fw)?.delegate) || '';
    const st = this.stallG.step({ now, camFps: this.measuredCamFps(now), inFlightMs: this.faceBusy ? now - this.faceSentT : 0, gpuBusy: this.gpuBusy,
      rbMs: this.faceSplit.rb, faceCpu: fd === 'CPU', syncMs: gpuSync.ms, capHz: this.faceHz });
    if (st.entered) {
      console.info(`[tracker] stall mode: ${st.gpu ? 'the graphics card is too busy for tracking' : 'face tracking fell behind (no wait on the graphics card measured)'} (${st.reason}); face ${fd === 'CPU' ? 'already on the processor' : this.delegatePolicy === 'auto' ? 'moves to the processor' : `stays on the ${fd} (setting)`}; pose ${this.delegatePolicy === 'auto' ? 'and hands move there too, ' : ''}at most ${STALL.bodyHz} a second (lite model), hands at most ${STALL.handsHz}; face frame: ${this.faceAgeText(now)}`);
      this.note(`stall mode on (${st.reason})`);
      // (a serial pair's held hands frame was never posted: no result will clear its busy flag — review round 1)
      if (this.heldHands) { this.dropHeldHands(); this.handsBusy = false; }
      // an Auto try of another kind in flight (a pose 'slow' try, a GPU look) would hold the stall moves back: it ends
      if (this.trial && !(this.trial.t.kind === 'stall' && this.trial.role === 'face')) this.endTrial(false, 'stall mode');
      this.syncConfig();   // (the body worker's 'lite' pose model: workerTier)
      this.whyT = now;
    } else if (st.left) {
      console.info(`[tracker] stall mode over (${st.why.replace(/^off: /, '')})`); this.note('stall mode over');
      this.stallRetryGap = 20000; this.stallRetryAt = 0;
      this.syncConfig();   // (the preset's pose model back)
    } else if (now - this.whyT > 30000 && /not a game|stall readings/.test(st.why)) {
      // why stall mode did NOT come on while tracking reads slow (the coordinator's round-1 ask): in the log, twice a minute
      this.whyT = now; console.info(`[tracker] stall mode: ${st.why}`);
    }
    if (st.gameMode) this.lastStallAt = now;
    // (a try's timeout: autoTick only runs on live face results, which a stalled worker does not deliver)
    const tr = this.trial;
    if (tr?.w && now - tr.readyT > AUTO.probeTimeoutMs) this.endTrial(true, 'probe timeout');
    // stall mode, Auto: every model off the card AT ONCE — the face through a timed try (ignoring back-off, its candidate
    // fed every camera frame and its results used), pose and the hand model straight onto the processor next to it
    // (round 1, the owner's Bodycam run: one at a time left pose and hands on the card 40 s, and their queued runs are
    // what the face's readback waits behind)
    if (st.gameMode && this.delegatePolicy === 'auto') {
      const on = (w: Worker | null) => !!w && this.winfo.get(w)?.delegate === 'GPU';
      const why = `auto: ${st.gpu ? 'the graphics card is too busy' : 'tracking fell behind'} (${st.reason})`;
      if (on(this.fw) && !this.trial && now >= this.stallRetryAt) this.startTrial(STALL_TRY(why));
      if (on(this.bw)) this.stallSwap('body', why);
      if (on(this.hw)) this.stallSwap('hands', why);
    }
    if (st.entered || st.left) try { this.onGameMode?.(st.entered, { ...st, faceDelegate: fd, policy: this.delegatePolicy }); } catch { /* the notice is optional */ }
  }
  private whyT = 0;

  /** Stall mode: pose / the hand model straight onto the processor (no timing: next to a game the card is where they
   *  delay the face most). A failed start waits 30 s before the next one. */
  private swaps: Partial<Record<'body' | 'hands', Promise<void>>> = {};
  /** Cancels a swap's worker start when tracking is closed meanwhile (the start would only load a model for nothing). */
  private swapAbort: Partial<Record<'body' | 'hands', AbortController>> = {};
  private swapRetryAt = { body: 0, hands: 0 };
  private stallSwap(role: 'body' | 'hands', why: string) {
    const now = performance.now();
    if (this.swaps[role] || now < this.swapRetryAt[role] || !this.current(role)) return;
    if (this.trial?.role === role) this.endTrial(false, 'stall mode');
    const o = this.opts;
    const opts = role === 'body' ? { ...o, tier: this.workerTier(), hands: this.bwModels.hands } : { ...o, body: false, hands: true };
    const name = role === 'body' ? 'pose' : 'hands';
    console.info(`[tracker] ${name}: onto the processor now (${why})`);
    this.note(`${name}: to CPU (stall mode)`);
    const gen = this.closeGeneration;
    const ac = this.swapAbort[role] = new AbortController();
    this.swaps[role] = this.spawn(role, opts, 'CPU', why, ac.signal).then((w) => {
      const old = this.current(role);
      // (tracking stopped / restarted, the model switched off, or already on the processor meanwhile: not needed)
      if (gen !== this.closeGeneration || !old || this.mode !== 'worker' || this.winfo.get(old)?.delegate === 'CPU' || this.winfo.get(w)?.delegate !== 'CPU') { w.terminate(); return; }
      if (this.trial?.role === role) this.endTrial(false, 'stall mode');
      const heldOld = role === 'hands' && this.heldHands?.w === old;
      const oldBusy = role === 'body' ? this.bodyBusy : this.handsBusy && !heldOld;
      if (role === 'body') { this.bw = w; this.bodyBusy = false; }
      else { this.hw = w; this.handsBusy = heldOld; if (heldOld) this.heldHands!.w = w; }
      if (oldBusy) { this.retiring.add(old); setTimeout(() => this.retire(old), 1500); } else old.terminate();
      this.ff.reset();
      this.auto.done(STALL_TRY(why, 0, name), true, performance.now());
      if (role === 'body') this.syncConfig();
      console.info(`[tracker] ${name}: now on the processor (stall mode)`);
    }, (e) => {
      if (ac.signal.aborted) return;   // (cancelled by close(): not a failed start)
      this.swapRetryAt[role] = performance.now() + 30000;
      console.warn(`[tracker] ${name}: the processor worker did not start`, e);
    }).finally(() => { delete this.swaps[role]; if (this.swapAbort[role] === ac) delete this.swapAbort[role]; });
  }

  /** The tier the body worker runs: in stall mode the 'lite' pose model (high / ultra run 'full'; the worker picks the pose
   *  model by tier alone). Back to the preset's model when stall mode ends. */
  private workerTier(): QualityTier {
    const t = this.opts.tier;
    return this.stallG.gameMode && (t === 'high' || t === 'ultra') ? 'medium' : t;
  }

  /** The main camera stopped (App.stopMainTracking): no face to starve, so stall mode ends now — the room preview, the
   *  room analysis and the studio's full drawing come back — and the next start warms up afresh (review round 1). */
  endStall() {
    const was = this.stallG.gameMode;
    this.stallG.reset(performance.now());
    if (!was) return;
    console.info('[tracker] stall mode over (camera off)'); this.note('stall mode over (camera off)');
    this.stallRetryGap = 20000; this.stallRetryAt = 0;
    this.syncConfig();
    const fd = (this.fw && this.winfo.get(this.fw)?.delegate) || '';
    try { this.onGameMode?.(false, { ...this.stallG.info(), left: true, faceDelegate: fd, policy: this.delegatePolicy }); } catch { /* optional */ }
  }

  /** A worker that has not answered for STUCK_MS: a fresh one on the same side replaces it (no second frame is ever posted
   *  to a worker that has not answered: that only stacked frames behind a stalled run, research RCA A4). */
  private replaceStuck(role: 'face' | 'body' | 'hands') {
    const w = this.current(role);
    if (!w) return;
    const tr0 = this.trial;
    if (tr0) {
      // a stall try is the replacement already (bounded by expireSpawn / the probe timeout); a try of this role that has
      // its worker is being timed. Any other try (another role's Auto look, a GPU look, a relief, one still starting) is
      // ended first: it held the stuck worker's replacement back until its own start gave up (T1). `replace`: this end is
      // neither a stall failure (no back-off) nor an Auto verdict.
      if (tr0.t.kind === 'stall' || (tr0.role === role && tr0.w)) return;
      tr0.replace = true;
      this.endTrial(false, `${role} worker stuck`);
    }
    const was = this.winfo.get(w)?.delegate ?? 'GPU';
    // (stall mode, Auto: the replacement goes to the processor — that IS the stall move; otherwise the same side, and a
    //  lost same-side replacement must not arm the stall back-off that holds the real move back: review round 1, G5.
    //  Also Auto before stall mode could latch (not armed yet, a gated camera, after an exit): when the readings already say
    //  the card is what the run waits on, a new graphics-card worker would join the same stalled queue: T2)
    const cardWaits = gpuSync.max5 >= STALL.syncMs || this.gpuBusy === true || this.faceSplit.rb >= STALL.rbAnyMs;
    const d = this.delegatePolicy === 'auto' && (this.stallG.gameMode || (was === 'GPU' && cardWaits)) ? 'CPU' : was;
    console.warn(`[tracker] ${role} worker did not answer for ${STUCK_MS / 1000} s (${role === 'face' ? this.faceAgeText(performance.now()) : 'in flight'}): replacing it (${d})`);
    this.note(`${role}: no answer for ${STUCK_MS / 1000} s, replaced (${d})`);
    this.startTrial(STALL_TRY(`no answer for ${STUCK_MS / 1000} s`, 0, role === 'body' ? 'pose' : role, d));
    const tr = this.trial as DelegateTrial | null;   // (startTrial set it)
    if (tr && d === was) tr.replace = true;
  }
  /** Tests / tools/gamefps_e2e.mjs: stall mode on / off now (as if a game had grabbed / released the card), and the face
   *  held back for `ms` (no frames sent: tracking results stall, as next to a game). */
  testGameMode(on: boolean) { this.stallG.force(on, performance.now()); }
  testHoldFace(ms: number) { this.holdFaceUntil = performance.now() + Math.max(0, ms); }
  /** Tests: the CURRENT face worker's runs take `ms` longer (a starved worker; a replacement worker is unaffected); `rb`:
   *  counted as readback, as a run waiting on the graphics queue next to a game (stall mode's absolute reading). */
  testSlowFace(ms: number, rb = false) { this.fw?.postMessage({ type: 'testDelay', ms, rb }); }
  private holdFaceUntil = 0;

  private autoTick(now: number) {
    if (now - this.autoT < 500 || this.mode !== 'worker' || !this.allowMain) return;
    this.autoT = now;
    const tr = this.trial;
    if (tr) { if (tr.w && now - tr.readyT > AUTO.probeTimeoutMs) this.endTrial(true, 'probe timeout'); else this.expireSpawn(now); return; }
    // (stall mode: stallTick makes the moves; Auto's own tries wait — a body-side 'slow' try now would only add GPU work)
    if (this.stallG.gameMode && this.delegatePolicy === 'auto') return;
    const camFps = this.camFps(now);
    const setting = this.delegatePolicy !== 'auto';
    // (a setting moves every worker, timing or not: also a body worker that runs the hand model, on 'low' / Body off)
    const placed = (w: Worker | null): RoleView | null => { const i = w && this.winfo.get(w); return i ? { delegate: i.delegate, ms: 0 } : null; };
    const d = this.auto.decide({
      now, policy: this.delegatePolicy, camFps, faceHz: this.timing.fps, gpuBroken: this.gpuBroken, kick: this.autoKick,
      pressed: this.ff.pressed, faceOk: this.timing.fps >= faceGoalHz(camFps),
      // (no look at the card while the helper says it is busy, within 10 minutes of a stall, or — after one — while the
      //  studio is not focused: a game may be in front. A look that won during an alt-tab froze the next game period.)
      noGpuLook: this.gpuBusy === true || now - this.lastStallAt < 600000 || (this.stallG.entries > 0 && !this.focused),
      face: setting ? placed(this.fw) : this.roleView(this.fw, 'face'),
      // (pose only while the body worker runs pose alone: with Body off it is the hands' worker)
      pose: setting ? placed(this.bw) : this.bw && this.bwModels.body && !this.bwModels.hands ? this.roleView(this.bw, 'pose') : null,
      // (hands only while the hand model runs at its full rate: at the idle back-off's 4 looks a second neither its ms nor
      // the face's reading next to it says what it costs once a hand comes up)
      hands: setting ? placed(this.hw) : this.hw && this.hwModels.hands && this.handsAtFullRate(now) ? this.roleView(this.hw, 'hands') : null,
    });
    this.autoKick = false;
    if (d) this.startTrial(d);
  }

  /** A try whose worker has not come up within TRIAL_SPAWN_MS ends (its start cancelled). The probe timeouts above only
   *  look at a try that HAS a worker; without this a hung start was bounded by spawnWorker's 45 s alone. */
  private expireSpawn(now: number) {
    const tr = this.trial;
    const lim = tr?.t.kind === 'stall' ? STALL_SPAWN_MS : TRIAL_SPAWN_MS;
    if (tr && !tr.w && now - tr.startT > lim) this.endTrial(false, `the ${tr.t.to} worker did not start in ${lim / 1000} s`);
  }

  private startTrial(t: AutoTry) {
    const role = t.role === 'pose' ? 'body' : t.role;
    const o = this.opts;
    // (a body candidate loads what the live body worker runs: pose, and the hand model too where it hosts it)
    const opts = role === 'body' ? { ...o, tier: this.workerTier(), hands: this.bwModels.hands } : role === 'hands' ? { ...o, body: false, hands: true } : o;
    const tr: DelegateTrial = { t, role, w: null, busy: false, got: 0, ms: [], startT: performance.now(), readyT: 0, faceBefore: this.meter.face.ms, faceDuring: [], abort: new AbortController() };
    this.trial = tr;
    console.info(`[tracker] ${t.role}: starting a ${t.to} worker (${t.kind}${t.why ? `: ${t.why}` : ''})`);
    this.note(`${t.role}: try ${t.to} (${t.kind})`);
    this.spawn(role, opts, t.to, t.why, tr.abort!.signal).then((w) => {
      if (this.trial !== tr || !this.current(role)) { w.terminate(); return; }
      if (t.to === 'GPU' && this.winfo.get(w)?.delegate !== 'GPU') { w.terminate(); this.endTrial(false, 'GPU did not start'); return; }
      tr.w = w; tr.readyT = performance.now();
      if (t.probe <= 0) this.endTrial(true, 'setting');
    }, (e) => {
      if (this.trial !== tr) return;
      if (t.to === 'GPU') this.gpuBroken = true;
      this.endTrial(false, String((e as Error)?.message ?? e));
    });
  }

  private onTrialMsg(m: WorkerMsg) {
    const tr = this.trial;
    if (!tr || (m.type !== 'result' && m.type !== 'error')) return;
    tr.busy = false;
    if (m.type === 'error') return;
    const ms = tr.role === 'face' ? (m.ms ?? 0) - (m.mouthMs ?? 0) : tr.role === 'body' ? (m.poseMs ?? m.ms ?? 0) : (m.handsMs ?? m.ms ?? 0);
    // a stall try's face results reach the avatar whenever they are newer than the stalled worker's (its frames are the
    // same camera frames: Tracker.submit feeds it every one)
    if (tr.role === 'face' && tr.t.kind === 'stall' && (!this.latestFace || (m.id ?? 0) > this.latestFace.id)) {
      const now = performance.now();
      this.takeFace(m, m.id ? this.sent.get(m.id) : undefined, now);
      this.stallG.result(now, ms);
    }
    if (++tr.got > 1) tr.ms.push(ms);
    if (tr.got >= tr.t.probe) this.endTrial(true, 'timed');
  }

  /** Give the candidate a copy of what the live worker of its role just got (up to its probe count). */
  private feedTrial(role: 'face' | 'body' | 'hands', make: (w: Worker) => { bmp: Promise<ImageBitmap | VideoFrame>; extra: object }, base: object) {
    const tr = this.trial;
    if (!tr || !tr.w || tr.role !== role || tr.busy || tr.got >= tr.t.probe) return;
    tr.busy = true;
    const w = tr.w, f = make(w);
    f.bmp.then((b) => { try { w.postMessage({ type: 'frame', bitmap: b, ...base, ...f.extra }, [b]); } catch (e) { b.close(); throw e; } }).catch(() => { tr.busy = false; });
  }

  /**
   * End the current try. `judge`: compare the candidate's timing with the live worker's and switch when it measured
   * faster by the try's margin (a setting switches regardless). The old worker finishes the frame it has, then ends;
   * VIDEO-mode timestamps stay increasing per worker (each worker keeps its own).
   */
  private endTrial(judge: boolean, why: string) {
    const tr = this.trial;
    if (!tr) return;
    this.trial = null;
    // (a candidate still starting is cancelled now, its worker ended, not left to finish loading + warming up behind the
    //  live work; once it is ready its abort listener is gone, so this is a no-op for a worker that is handed over)
    if (!tr.w) tr.abort?.abort();
    const now = performance.now();
    const key = tr.t.role;
    // (a stall try: the stalled worker's time is at least the age of the frame it still has in flight)
    const live = tr.t.kind === 'stall' && key === 'face' ? Math.max(this.meter.face.ms, this.faceBusy ? now - this.faceSentT : 0) : this.meter[key].ms, cand = median(tr.ms);
    const old = this.current(tr.role);
    // a pose / hands move that made the face over 15 % slower, and busy (over faceBusyMs), while it was being timed is not
    // taken (the face matters most; a face that stays fast, e.g. 8 -> 11 ms on an idle GPU, is not held against the move).
    // A relief (hand model off the GPU the busy face shares) is judged on the hands' own time only: while it is timed BOTH
    // copies run (the live one still on the GPU, the new one starting on the CPU), so the face cannot get faster yet, and
    // on a loaded GPU it read 16-56 % slower during tries, while a relief that was taken gave the face 15-19 ms / 30-34 a
    // second, from 27-30 ms / 21-25.
    const faceNow = median(tr.faceDuring);
    const faceHit = tr.role !== 'face' && tr.t.kind !== 'relieve' && tr.t.probe > 0 && tr.faceDuring.length >= 3 && tr.faceBefore > 0
      && faceNow > tr.faceBefore * 1.15 && faceNow > AUTO.faceBusyMs;
    // (the bar: live ms x the try's factor, or its absolute limit when that is higher: a relief may cost the hands some ms)
    const bar = Math.max(live > 0 ? live * tr.t.factor : 0, tr.t.limit ?? 0);
    const win = judge && !!tr.w && !!old && this.mode === 'worker' && !faceHit
      && (tr.t.probe <= 0 || (tr.ms.length >= 2 && cand > 0 && cand < bar));
    if (judge && tr.w) console.info(`[tracker] ${key}: ${tr.t.to} candidate ${cand.toFixed(1)} ms vs ${live.toFixed(1)} ms live (${why})${faceHit ? `, but the face went ${tr.faceBefore.toFixed(1)} -> ${faceNow.toFixed(1)} ms` : ''} -> ${win ? 'switch' : 'stay'}`);
    if (judge && tr.w) this.note(`${key}: ${tr.t.to} ${cand.toFixed(0)} vs ${live.toFixed(0)} ms -> ${win ? 'switch' : 'stay'}`);
    if (tr.t.kind === 'stall' && !win && !tr.replace) { this.stallRetryAt = now + this.stallRetryGap; this.stallRetryGap = Math.min(300000, this.stallRetryGap * 2); }
    else if (!judge && why !== 'stopped' && why !== 'settings changed') console.info(`[tracker] ${key}: ${tr.t.to} try ended (${why})`);
    if (win && tr.w && old) {
      // (a serial pair's hands frame still held for the old hands worker was never posted: the new one runs it)
      const heldOld = tr.role === 'hands' && this.heldHands?.w === old;
      const oldBusy = tr.role === 'face' ? this.faceBusy : tr.role === 'body' ? this.bodyBusy : this.handsBusy && !heldOld;
      const i = this.winfo.get(tr.w);
      if (i) i.reason = tr.t.to === 'CPU' ? tr.t.why || i.reason : '';
      // (the face's split averages were the old worker's: a GPU face's 20 ms readback judged as the new processor face's
      //  read as a wait on the graphics queue for half a second — review round 1 of beta.14.1)
      if (tr.role === 'face') {
        this.fw = tr.w; this.faceBusy = tr.busy; this.faceSplit = { acq: 0, recv: 0, up: 0, rb: 0, inf: 0 };
        if (this.fnet.model) { try { tr.w.postMessage({ type: 'facenet', model: this.fnet.model }); } catch { /* gone */ } } // ("My face model": the new live worker holds the model too)
      }
      else if (tr.role === 'body') { this.bw = tr.w; this.bodyBusy = tr.busy; }
      else { this.hw = tr.w; this.handsBusy = tr.busy || heldOld; if (heldOld) this.heldHands!.w = tr.w; }
      if (cand > 0) this.meter[key].seed(cand);
      if (oldBusy) { this.retiring.add(old); setTimeout(() => this.retire(old), 1500); } else old.terminate();
      // face first judged the old placement (e.g. a GPU face pressed by pose + hands that is now on the processor): its
      // order and rate go, and the new placement is measured afresh (probes: ~2 s)
      this.ff.reset();
    } else tr.w?.terminate();
    if (why !== 'stopped' && why !== 'settings changed' && !tr.replace) this.auto.done(tr.t, win, now, live);
  }

  /** A new pose result: stamp it with its frame, bump the body sequence (once its frame's hands result is in too, when the
   *  hands got that frame), steer the hand crop. Older frames are dropped. */
  private takePose(p: PoseLandmarkerResult | null, id: number, info: { t: number; capture: number } | undefined, now: number) {
    if (id && id <= this.poseFrame.id) return;
    const t = (info?.t ?? now) / 1000;
    this.poseFrame = { id, t, capture: info?.capture ?? info?.t ?? now };
    this.latestPose = p ? Object.assign(p, { id, t }) : null;
    this.poseArrT = now;
    // a paired frame whose hands result is not in yet: the sample waits for it (settlePair: at most 150 ms)
    if (id && id === this.pairId && this.handsFrame.id < id) this.posePendT = now;
    else { this.posePendT = -1; this.bumpBody(this.poseFrame); }
    this.updateHandRoi(this.latestPose, this.latestHands, now);
  }

  /** A new hands result (from the hands worker, or the body worker while Body is off). */
  private takeHands(h: HandsResult | null, id: number, info: { t: number; capture: number } | undefined, now: number) {
    if (id && id <= this.handsFrame.id) return;
    const t = (info?.t ?? now) / 1000;
    this.handsFrame = { id, t, capture: info?.capture ?? info?.t ?? now };
    this.latestHands = h ? Object.assign(h, { id, t }) : null;
    if (h?.landmarks?.length) this.handSeenT = now;
    // the pose result of this paired frame was waiting for it: one body sample with both
    if (this.posePendT >= 0 && id >= this.pairId && this.poseFrame.id === this.pairId) { this.posePendT = -1; this.bumpBody(this.poseFrame); }
    // (a paired frame whose pose result is still coming: that one hands both out)
    else if (id && id === this.pairId && this.poseFrame.id < id) { /* wait for the pose */ }
    // (with Body on the pose stream drives bodyId / bodyT; the hands only while no pose result came for 0.5 s)
    else if (!this.opts.body || now - this.poseArrT > 500) this.bumpBody(this.handsFrame);
    if (this.handRoiMode === 'follow') this.updateHandRoi(this.latestPose, this.latestHands, now);
  }

  /** A pose result waiting for its frame's hands result: hand it out after 150 ms without it (a hands worker that was
   *  swapped / crashed / switched off), or at once (`now`). */
  private settlePair(now: number, force = false) {
    if (this.posePendT < 0 || (!force && now - this.posePendT < 150)) return;
    this.posePendT = -1;
    this.bumpBody(this.poseFrame);
  }

  /** bodyId +1 for a new sample of the driving stream; bodyT / capture = its frame (bodyT never goes backwards); the pose
   *  and hands handed out with it are the newest of each (one frame when paired). */
  private bumpBody(f: { t: number; capture: number }) {
    const prev = this.latestBody;
    this.latestBody = { id: ++this.bodySeq, t: prev && prev.t > f.t ? prev.t : f.t, capture: f.capture, pose: this.latestPose, hands: this.latestHands };
    this.bodyQ.push(this.latestBody);
    if (this.bodyQ.length > 3) this.bodyQ.shift();
  }

  /** The body sample to hand out with this result: the oldest one not handed out yet, at most one more waiting (a face
   *  slower than the pairs drops the backlog to one, so the lag stays under one sample); none new = the last one again
   *  (same bodyId: a solver that watches bodyId does nothing). */
  private nextBody(): BodySample | null {
    const q = this.bodyQ;
    if (q.length) { if (q.length > 2) q.splice(0, q.length - 2); this.givenBody = q.shift()!; }
    return this.givenBody;
  }

  /** Hand the current video frame to every idle worker; busy workers skip it (no stale queue). */
  // ---- face ROI (main side): where to crop the next frame, predicted from the face's motion
  private roi: { x: number; y: number; s: number } | null = null;
  private roiMiss = 0;
  private roiVel = { x: 0, y: 0 };
  /** Face crop size fed to the face model: 512 at every quality level. (Shrinking it bought nothing, the model resamples
   *  to its own input either way: 10.0 vs 10.1 ms on the GPU, 15.2 vs 15.4 on the CPU; but it upsampled the face from
   *  ~150 px at 256, so the old ladder quietly cost face detail.) */
  private readonly roiSize = 512;
  // ---- adaptive quality: keep the face model up with the camera on any machine ----
  //   level 1: pose at most half its rate (poseHz / 2: 15 a second; paired hands with it)
  //   level 2: + Auto tries a slow GPU model on the processor now (delegatePolicy.ts: the hand model first when the body
  //            side measurably presses the face; same models there)
  //   level 3: + no mouth-visibility patch reads, hands at most half their rate (handsHz / 2)
  // (Measured and dropped: pose every 3rd camera frame at level 3 cost pose rate (9-15 Hz under load) without a visible
  // face gain.) The ladder answers a face that is slow by itself; a face slowed by the body side is face first's
  // (faceFirst.ts: order + a lower body-side rate, from the measured cost). Gesture labels stay at the hand rate: the
  // gesture recognizer computes them in the same pass as the hand landmarks, so a lower label rate would save nothing.
  private adaptLevel = 0;              // 0 = full quality … 3 = lightest
  private adaptT = 0;
  private adaptSlow = 0;
  private adaptFast = 0;
  /** Current adaptive level (0 = full) — for diagnostics / UI. */
  get quality() { return this.adaptLevel; }
  private adapt(faceMs: number, now: number) {
    if (now - this.adaptT < 500) return;
    this.adaptT = now;
    // budget: from the CAMERA rate (a capped secondary camera: its cap), not the achieved rate, which made the old budget
    // self-referential (at 26 Hz a 30 ms face read as fine), but only up to the face rate that matters: ~36 a second
    // (lip sync needs ~30). A 60 fps camera does not need a face under one 16.7 ms frame: a face that makes every 2nd
    // frame (30 a second, e.g. the owner's 20.6 ms GPU face) must not climb the levels and lose the mouth-visibility
    // reads, Teeth & tongue and food & drink. Budget 30.6 ms at 60 fps, 36.7 ms at 30 fps.
    const cam = Math.min(this.camFps(now), this.faceHz || 60);
    const want = Math.min(cam, 36);
    const budget = (1000 / want) * 1.1;
    const hz = this.timing.fps;
    // slow: the face model takes longer than that (or results nearly stop); fast: clearly inside it and ~30 results a
    // second keep coming (the camera's rate when it is slower). (Not "fewer results than the camera": results land on
    // camera-frame boundaries, so a 14 ms face on a busy PC can read 45 of 60 Hz while it is well inside its budget.)
    const slow = faceMs > budget || (hz > 0 && hz < Math.min(24, cam * 0.75));
    const fast = faceMs < budget * 0.8 && hz >= Math.min(cam, 30) * 0.85;
    if (slow) { this.adaptSlow++; this.adaptFast = 0; } else if (fast) { this.adaptFast++; this.adaptSlow = 0; } else { this.adaptSlow = 0; this.adaptFast = 0; }
    const setLevel = (l: number) => {
      const up = l > this.adaptLevel;
      this.adaptLevel = Math.max(0, Math.min(3, l)); // (pose / hand rates follow it: poseRate, handsRate)
      if (up && this.adaptLevel >= 2) this.autoKick = true;
      console.info(`[tracker] adaptive quality level ${this.adaptLevel} (face ${faceMs.toFixed(1)} ms, ${hz.toFixed(0)} Hz; camera ${cam.toFixed(0)} fps, budget ${budget.toFixed(1)} ms)`);
    };
    if (this.adaptSlow >= 3 && this.adaptLevel < 3) { setLevel(this.adaptLevel + 1); this.adaptSlow = 0; }
    if (this.adaptFast >= 8 && this.adaptLevel > 0) { setLevel(this.adaptLevel - 1); this.adaptFast = 0; }
  }

  private updateRoi(lm: { x: number; y: number }[] | undefined, W: number, H: number) {
    if (!lm) { if (++this.roiMiss > 2) { this.roi = null; this.roiInfo = null; } return; }
    this.roiMiss = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of lm) { const px = p.x * W, py = p.y * H; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const used = this.roi;
    let s = Math.min(Math.max(Math.max(x1 - x0, y1 - y0) * 1.7, 96), Math.min(W, H));
    if (used) {
      // lead the crop along the head's motion so fast moves don't slide the face out of it
      const ucx = used.x + used.s / 2, ucy = used.y + used.s / 2;
      this.roiVel.x = this.roiVel.x * 0.5 + (cx - ucx) * 0.5;
      this.roiVel.y = this.roiVel.y * 0.5 + (cy - ucy) * 0.5;
      cx += this.roiVel.x * 0.8; cy += this.roiVel.y * 0.8;
      // hysteresis: a steady crop = steadier landmarks
      if (Math.abs(ucx - cx) < used.s * 0.06 && Math.abs(ucy - cy) < used.s * 0.06 && Math.abs(used.s - s) < used.s * 0.12) { this.roiInfo = this.roiInfoFor(used, W, H); return; }
      if (Math.abs(used.s - s) < used.s * 0.12) s = used.s;
    } else this.roiVel = { x: 0, y: 0 };
    const nx = Math.min(Math.max(cx - s / 2, 0), W - s), ny = Math.min(Math.max(cy - s / 2, 0), H - s);
    this.roi = { x: nx, y: ny, s };
    this.roiInfo = this.roiInfoFor(this.roi, W, H);
  }

  private roiInfoFor(r: { x: number; y: number; s: number }, W: number, H: number) {
    return { x: r.x / W, y: r.y / H, s: r.s / H, zoom: this.roiSize / r.s };
  }

  // ---- hand ROI. By default the hand model sees the whole frame: MediaPipe tracks hands frame-to-frame in
  // input-image coordinates, so a crop that moves with the hands breaks that tracking on every move (offline:
  // the hand was missed on the first result after a crop move 39-43 % of the time, vs 11-13 % overall).
  // The one exception is a performer who looks small (shoulders under ~15 % of the frame width): palm
  // detection runs at 192 px on whatever it is given, so they get a zoomed reach box anchored to the TORSO
  // (both arms' reach, from above the shoulders to the bottom of the frame). It follows the torso with
  // hysteresis and is never recomputed from hand landmarks, so moving hands never move it.
  // The old crop that follows the hands stays available for A/B: localStorage vtp.handRoi = 'follow'.
  private handRoi: { x: number; y: number; w: number; h: number } | null = null;
  /** 'auto' (no crop; torso reach box for a small performer) or 'follow' (the old hand-following crop). */
  handRoiMode: 'auto' | 'follow' = (() => { try { return localStorage.getItem('vtp.handRoi') === 'follow' ? 'follow' : 'auto'; } catch { return 'auto'; } })();
  private handSeen = 0;
  private torsoSeenT = 0;
  /** Shoulder widths (px) of the last 2 s of pose results: the small-performer decision and the box size use the widest
   *  (arms crossing in front, a turn or a blur only ever make the shoulders look narrower for a moment). */
  private swHist: { t: number; sw: number }[] = [];
  private vidW = 0;
  private vidH = 0;
  private static readonly HAND_MAX = 960;
  /** Torso reach box: engage below this shoulder width (fraction of the frame width), release above SMALL_OFF. */
  static readonly SMALL_ON = 0.15;
  static readonly SMALL_OFF = 0.165;

  private updateHandRoi(pose: PoseLandmarkerResult | null, hands: HandsResult | null, now: number) {
    if (this.handRoiMode === 'follow') this.updateFollowRoi(pose, hands, now);
    else this.updateTorsoRoi(pose, now);
  }

  /** Default crop logic: none, unless the performer looks small; then a torso-anchored reach box (hands never move it). */
  private updateTorsoRoi(pose: PoseLandmarkerResult | null, now: number) {
    const W = this.vidW, H = this.vidH;
    if (!W || !H || !this.opts.hands) return;
    const pl = pose?.landmarks?.[0];
    const a = pl?.[11], b = pl?.[12];
    if (!a || !b || Math.min(a.visibility ?? 0, b.visibility ?? 0) < 0.5) {
      // shoulders not seen: keep the box a moment (a turn, a blur), drop it after 1 s (they left / moved away)
      if (now - this.torsoSeenT > 1000) { this.swHist.length = 0; if (this.handRoi) this.setHandRoi(null, W, H); }
      return;
    }
    this.torsoSeenT = now;
    const h = this.swHist;
    h.push({ t: now, sw: Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) });
    while (h.length && now - h[0].t > 2000) h.shift();
    let sw = 0;
    for (const e of h) sw = Math.max(sw, e.sw);
    // small = the widest shoulders of the last 2 s under 15 % of the frame width (and at least 1 s of them seen first:
    // a moment's reading never switches the crop on); big again above 16.5 %
    const small = this.handRoi ? sw / W < Tracker.SMALL_OFF : sw / W < Tracker.SMALL_ON && now - h[0].t >= 1000;
    if (sw < 4 || !small) { if (this.handRoi) this.setHandRoi(null, W, H); return; }
    // both arms' reach: shoulders ± 1.6 shoulder widths, from 1.3 shoulder widths above them to the frame bottom
    const cx = ((a.x + b.x) / 2) * W, sy = Math.min(a.y, b.y) * H;
    const x0 = Math.max(0, cx - 2.1 * sw), x1 = Math.min(W, cx + 2.1 * sw), y0 = Math.max(0, sy - 1.3 * sw);
    const need = { x: x0, y: y0, w: x1 - x0, h: H - y0 };
    if (need.w * need.h > W * H * 0.6) { if (this.handRoi) this.setHandRoi(null, W, H); return; }
    const cur = this.handRoi;
    // hysteresis: the box only moves when the torso really moved (10 % position, 15 % size)
    if (cur && Math.abs(cur.x - need.x) < need.w * 0.1 && Math.abs(cur.y - need.y) < need.h * 0.1
      && Math.abs(cur.w - need.w) < need.w * 0.15 && Math.abs(cur.h - need.h) < need.h * 0.15) return;
    this.setHandRoi(need, W, H);
  }

  /** The old crop (vtp.handRoi = 'follow'): covers every tracked hand plus both pose wrists, moves when they leave it. */
  private updateFollowRoi(pose: PoseLandmarkerResult | null, hands: HandsResult | null, now: number) {
    const W = this.vidW, H = this.vidH;
    if (!W || !H || !this.opts.hands) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (px: number, py: number, r: number) => {
      px = Math.min(Math.max(px, 0), W); py = Math.min(Math.max(py, 0), H);
      x0 = Math.min(x0, px - r); y0 = Math.min(y0, py - r); x1 = Math.max(x1, px + r); y1 = Math.max(y1, py + r);
    };
    const nHands = hands?.landmarks?.length ?? 0;
    if (nHands) this.handSeen = now;
    for (const lm of hands?.landmarks ?? []) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of lm) { a = Math.min(a, p.x * W); c = Math.max(c, p.x * W); b = Math.min(b, p.y * H); d = Math.max(d, p.y * H); }
      const r = Math.max(Math.max(c - a, d - b) * 0.9, H * 0.06); // motion margin: hands move fast
      add(a, b, r); add(c, d, r);
    }
    const pl = pose?.landmarks?.[0];
    let poseOk = false;
    if (pl && pl.length > 20) {
      const sw = Math.hypot((pl[11].x - pl[12].x) * W, (pl[11].y - pl[12].y) * H);
      const wristsIn = Math.min(pl[15].visibility ?? 0, pl[16].visibility ?? 0) > 0.5;
      // pose alone only steers the crop while it can actually see the wrists (else: full frame)
      if (sw > 1 && (nHands || wristsIn)) {
        poseOk = true;
        // wrists + knuckle points of both arms; off-frame predictions are clamped to the edge, so a hand
        // below the frame keeps the crop open toward where it will come in
        for (const i of [15, 16, 17, 18, 19, 20]) add(pl[i].x * W, pl[i].y * H, Math.max(sw * 0.55, H * 0.06));
      }
    }
    // no pose: a crop around one tracked hand would blind us to the other, so only crop around two
    if (!poseOk && nHands < 2) { this.setHandRoi(nHands && this.handRoi ? this.handRoi : null, W, H); return; }
    if (!isFinite(x0)) { this.setHandRoi(null, W, H); return; }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    // keep a sensible minimum so the detector always has context around the hand
    const minS = H * 0.4;
    if (x1 - x0 < minS) { const c = (x0 + x1) / 2; x0 = Math.max(0, Math.min(W - minS, c - minS / 2)); x1 = x0 + minS; }
    if (y1 - y0 < minS) { const c = (y0 + y1) / 2; y0 = Math.max(0, Math.min(H - minS, c - minS / 2)); y1 = y0 + minS; }
    const need = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // not worth it when the hands already span most of the frame
    if (need.w * need.h > W * H * 0.6) { this.setHandRoi(null, W, H); return; }
    const cur = this.handRoi;
    if (cur && need.x >= cur.x && need.y >= cur.y && need.x + need.w <= cur.x + cur.w && need.y + need.h <= cur.y + cur.h
      && cur.w * cur.h < need.w * need.h * 2.2) return; // still fits and isn't wastefully large: hold still
    // move: grow 12% so small drifts don't immediately move it again
    const gx = need.w * 0.12, gy = need.h * 0.12;
    const nx = Math.max(0, need.x - gx), ny = Math.max(0, need.y - gy);
    this.setHandRoi({ x: nx, y: ny, w: Math.min(W, need.x + need.w + gx) - nx, h: Math.min(H, need.y + need.h + gy) - ny }, W, H);
  }

  private setHandRoi(r: { x: number; y: number; w: number; h: number } | null, W: number, H: number) {
    if (r && r.w * r.h > W * H * 0.6) r = null;
    this.handRoi = r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : null;
    const full = Math.min(1, Tracker.HAND_MAX / W); // scale the hands saw without a crop
    this.handRoiInfo = this.handRoi
      ? { x: this.handRoi.x / W, y: this.handRoi.y / H, w: this.handRoi.w / W, h: this.handRoi.h / H,
          zoom: Math.min(1, Tracker.HAND_MAX / Math.max(this.handRoi.w, this.handRoi.h)) / full }
      : null;
  }

  /** A new camera frame arrived (rVFC: presentedFrames counts frames the page skipped too; the poll path: +1).
   *  `at`: when the page got it (its stamp); `pres`: rVFC presentationTime (when it was handed to the compositor). */
  private onCameraFrame(presented: number | undefined, capture: number, at = performance.now(), pres?: number) {
    const n = presented !== undefined && this.lastPresented >= 0 && presented > this.lastPresented ? Math.min(presented - this.lastPresented, 10) : 1;
    if (presented !== undefined) this.lastPresented = presented;
    this.camFrame += n;
    this.lastCapture = capture;
    this.frameT = at;
    this.framePres = pres !== undefined && pres > 0 && pres <= at ? pres : at;
    const now = performance.now(), cr = this.camRate;
    if (!cr.t0 || now - cr.t0 > 2500) { cr.t0 = now; cr.n = 0; }
    else { cr.n += n; if (now - cr.t0 >= 1000) { cr.fps = (cr.n * 1000) / (now - cr.t0); cr.n = 0; cr.t0 = now; } }
  }

  /**
   * A body / hands result (or, with face first on, a face result) landed: if the newest camera frame is already due for
   * the body side, send it now instead of waiting for the next camera frame (never re-sends anything to the face worker).
   * Only while the video can still be showing the frame the last rVFC reported (until 3/4 of a camera interval after its
   * presentation; on the hidden-tab poll path: while currentTime is unchanged): the frame sent must be the one its stamp
   * (frameT) belongs to. Later in the interval the next rVFC sends the next frame with its own time.
   */
  private resubmit() {
    const v = this.feedVideo;
    if (!v || this.mode !== 'worker' || v.readyState < 2) return;
    const now = performance.now();
    if (now - this.lastRvfc <= 100) { if (now - this.framePres > (0.75 * 1000) / this.camFps(now)) return; }
    else if (v.currentTime !== this.lastVideoTime) return;
    this.submit(v, this.lastCapture, 'side');
  }

  /**
   * Hand the current video frame to the workers that are idle and due; busy workers skip it (no stale queue).
   * `only` 'side': a result-triggered resubmit for the body side (no face, no food & drink look).
   */
  private submit(video: HTMLVideoElement, capture: number, only?: 'side') {
    // (stall mode: no food & drink look either — its detector goes through the same graphics queue)
    if (this.objectsWanted && !only && !this.stallG.gameMode) this.submitObjects(video);
    const tNow = performance.now();
    // one frame in flight per worker: a worker that has not answered for STUCK_MS is replaced (the old 2.5 s reset posted a
    // second frame into a worker still blocked in a stalled run: frames stacked up behind it, research RCA A4)
    // (the face's clock starts when its crop is handed to the worker: a crop still pending is the studio's own wait on the
    //  graphics queue, not a stuck worker, and has its own short guard)
    this.cropGuard(tNow);
    if (this.faceBusy && this.faceWorkerMs(tNow) > STUCK_MS) this.replaceStuck('face');
    if (this.bodyBusy && tNow - this.bodySentT > STUCK_MS) this.replaceStuck('body');
    if (this.handsBusy && tNow - this.handsSentT > STUCK_MS && !this.heldHands) this.replaceStuck('hands');
    // (a serial pair's hands frame whose pose result never came: it goes anyway)
    if (this.heldHands && tNow - this.heldHands.at > 250) this.releaseHands();
    this.settlePair(tNow);
    // secondary cameras: optional face-rate cap + a gate (e.g. "only while the main camera's face model is idle")
    const game = this.stallG.gameMode;
    const toFace = !only && !!this.fw && !this.faceBusy && tNow >= this.holdFaceUntil && (!this.faceHz || tNow - this.faceSentT >= 1000 / this.faceHz - 2) && (!this.gate || this.gate());
    // stall mode: the face's candidate on the processor gets EVERY camera frame, not only the ones the stalled live worker
    // can take (its results reach the avatar: onTrialMsg)
    const tr0 = this.trial;
    const feedCand = !only && !toFace && !!tr0?.w && tr0.role === 'face' && tr0.t.kind === 'stall' && !tr0.busy && tNow >= this.holdFaceUntil;
    if (toFace) this.faceSentT = tNow;
    // pose: once bodyEvery camera frames have arrived since its last frame (counted in camera frames, not in idle frames,
    // so a slow worker is not held back further) and at most poseRate() a second; hands: the same stride, at most
    // handsRate() a second, while the idle back-off lets them look. With the hand model in the body worker (Body off, or
    // the 'low' preset) the hands go with that worker's frames: with Body on, on the pose frames (both models on one
    // frame, as before), the hand model skipped on a frame where the hands are not due.
    const host = this.handsHost();
    const shared = !!host && host === this.bw && this.opts.body;
    // pose + hands in their own workers (Body on): ONE body frame for both, as the shared worker gave them, so every body
    // sample pairs a pose with hands of the same camera frame. While the hand model runs at its full rate (a hand or a
    // wrist in view) the pose waits for both workers to be free and the frame goes to both at min(pose, hands rate);
    // otherwise the pose goes at its own rate and the hands join a pose frame at the idle back-off's pace.
    const lock = !!host && host === this.hw && this.opts.body && !!this.bw && this.bwModels.body;
    const active = lock && this.handsAtFullRate(tNow);
    // face first (faceFirst.ts, only while the body side measurably slows the face): a body-side frame waits while the face
    // has one in flight (or gets one now) and goes when the face result lands; never more than half a period overdue. A
    // probe (quiet: ~2 face runs, at most 250 ms, at most once a second) holds every body-side frame: the face runs alone,
    // so its cost can be measured where pose / hand runs sit next to every face run
    const quiet = this.ff.quiet(tNow);
    const hold = (sentT: number, hz: number) => quiet || (this.ff.active && !!this.fw && (this.faceBusy || toFace) && tNow - sentT < 1500 / Math.max(1, hz));
    // (stall mode: pose and the hand model at most STALL.bodyHz, on either side — their runs on the card are queued work
    //  the face waits behind; stallTick then moves them off the card)
    const gpu = (w: Worker | null) => !!w && this.winfo.get(w)?.delegate === 'GPU';
    const handsHz = game ? Math.min(this.handsRate(tNow), STALL.handsHz) : this.handsRate(tNow);
    // (paired: the pair rate is the hands' rate within the pose's level; vtp.handsHz above poseHz raises both. Stall mode:
    //  the pose keeps its own STALL.bodyHz and the hands join every other pose frame at most STALL.handsHz)
    const poseHz0 = active && !game ? Math.min(this.poseRate(tNow, Math.max(this.poseHz, this.handsHz)), handsHz) : this.poseRate(tNow);
    const poseHz = game ? Math.min(poseHz0, STALL.bodyHz) : poseHz0;
    // (rate caps: the slot grid, see nextSlot)
    const poseDue = !!this.bw && this.opts.body && !this.bodyBusy && this.camFrame - this.poseCam >= this.bodyEvery && this.slotDue(this.poseSlot, tNow, poseHz)
      && !(active && this.handsBusy) && !hold(this.bodySentT, poseHz);
    const handsDue = !!host && (lock ? poseDue && !this.handsBusy && this.handsWanted(tNow) && (!game || this.slotDue(this.handsSlot, tNow, handsHz))
      : (shared ? poseDue : this.camFrame - this.handsCam >= this.bodyEvery && (host === this.hw ? !this.handsBusy : !this.bodyBusy) && !hold(this.handsSentT, handsHz))
        && this.slotDue(this.handsSlot, tNow, handsHz) && this.handsWanted(tNow));
    const toBody = poseDue || (handsDue && host === this.bw);
    const toHands = handsDue && !!this.hw && host === this.hw;
    if (!toFace && !toBody && !toHands && !feedCand) return;
    const bodyHands = toBody && host === this.bw && handsDue;
    if (toBody) { this.bodySentT = tNow; if (poseDue) { this.poseCam = this.camFrame; this.poseSlot = this.nextSlot(this.poseSlot, tNow, poseHz); } }
    if (toHands || bodyHands) { this.handsSentT = tNow; this.handsCam = this.camFrame; this.handsSlot = this.nextSlot(this.handsSlot, tNow, lock && !game ? poseHz : handsHz); }
    const id = this.nextId++;
    // (a pose frame of the paired workers: its body sample waits for the hands result of the same frame, see takePose)
    if (lock && poseDue) this.pairId = toHands ? id : 0;
    // face first with pose and hands both on the GPU: the pair runs one after the other (hands when the pose result
    // lands, on this same frame), so at most one body-side model shares the card with the face, as with one body worker
    const serial = toBody && toHands && lock && this.ff.active && gpu(this.bw) && gpu(this.hw);
    // the frame's own time (see frameT), also for a frame sent after a result landed: every stream's samples keep the
    // camera's spacing (and MediaPipe's VIDEO-mode timestamps with them)
    const t = this.frameT || tNow;
    this.sent.set(id, { t, capture });
    if (this.sent.size > 64) this.sent.delete(this.sent.keys().next().value!);
    const W = video.videoWidth, H = video.videoHeight;
    if (W !== this.vidW || H !== this.vidH) { this.vidW = W; this.vidH = H; this.handRoi = null; this.handRoiInfo = null; }
    // The GPU does the cropping / scaling (createImageBitmap source rect + resize), so each worker gets a
    // small bitmap instead of a full-resolution copy of the frame:
    //   face  the zoomed 512² face region (full-res pixels around the face), or a ≤960 px frame to find it
    //   body  a ≤960 px frame (pose / hand models run at 256 px internally)
    const small = (maxW: number) => {
      const k = Math.min(1, maxW / W);
      return { resizeWidth: Math.round(W * k), resizeHeight: Math.round(H * k), resizeQuality: 'medium' as ResizeQuality };
    };
    // (a frame whose postMessage throws was never transferred: closed here, a VideoFrame holds a camera buffer)
    const post = (w: Worker, p: Promise<ImageBitmap | VideoFrame>, extra: object, onFail: () => void) =>
      p.then((b) => { try { w.postMessage({ type: 'frame', bitmap: b, ts: t, id, fullW: W, fullH: H, ...extra }, [b]); } catch (e) { b.close(); throw e; } }).catch(onFail);
    const base = { type: 'frame', ts: t, id, fullW: W, fullH: H };
    // what each worker gets (a candidate on the other delegate gets the same, minus the mouth patch)
    const faceExtra = (mouth: boolean) => { const r = this.roi; return { roi: r ? { x: Math.round(r.x), y: Math.round(r.y), s: Math.round(r.s) } : null, mouth: !!r && mouth }; };
    // ("My face model": the live face worker alone gets `fnet` bits, and only while the feature is on: faceNetBits)
    const fnet = this.faceNetBits(true), fnetExtra = fnet ? { fnet } : {};
    const faceFrame = (mouth: boolean, w: Worker | null, net = false): { bmp: Promise<ImageBitmap | VideoFrame>; extra: object } => {
      // cpuFace hook: the processor-only face worker reads the camera frame itself (VideoFrame; no GPU crop here)
      if (isCpuFace(w)) return { bmp: grabCpuFrame(video, t), extra: { mouth, ...(net ? fnetExtra : {}) } };
      const r = this.roi, S = this.roiSize;
      return {
        bmp: r ? createImageBitmap(video, Math.round(r.x), Math.round(r.y), Math.round(r.s), Math.round(r.s), { resizeWidth: S, resizeHeight: S, resizeQuality: 'medium' })
          : createImageBitmap(video, small(960)),
        extra: { ...faceExtra(mouth), ...(net ? fnetExtra : {}) },
      };
    };
    // the hand crop (when there is one): full-resolution pixels, never bigger than HAND_MAX
    const handCrop = (hr: { x: number; y: number; w: number; h: number }) => {
      const k = Math.min(1, Tracker.HAND_MAX / Math.max(hr.w, hr.h));
      return createImageBitmap(video, hr.x, hr.y, hr.w, hr.h, { resizeWidth: Math.max(1, Math.round(hr.w * k)), resizeHeight: Math.max(1, Math.round(hr.h * k)), resizeQuality: 'medium' });
    };
    const handsFrame = () => { const hr = this.handRoi; return { bmp: hr ? handCrop(hr) : createImageBitmap(video, small(Tracker.HANDS_W)), extra: { handRoi: hr } }; };
    if (toFace) {
      this.faceBusy = true;
      const a0 = performance.now(), fw = this.fw!, f = faceFrame(this.wantMouthPatch(t), fw, true);
      const rec: FaceSend = { fw, t0: a0, acqT: 0, dropped: false };
      this.faceSend = rec; this.cropsOpen++;
      // (split: acqMs = how long the studio's crop of the picture took — on a busy graphics card it waits there too)
      // (a failed picture / post clears the busy flag only while that worker is still the live one: a replacement that took
      //  over meanwhile has its own frame in flight — review round 1, G4)
      // (a crop the guard disowned while it was pending is closed when it arrives, never posted: a newer frame owns the busy flag)
      f.bmp.then((b) => {
        this.cropsOpen--;
        if (rec.dropped) { b.close(); return; }
        rec.acqT = performance.now();
        try { fw.postMessage({ type: 'frame', bitmap: b, ts: t, id, fullW: W, fullH: H, ...f.extra, acqMs: rec.acqT - a0, postT: performance.timeOrigin + performance.now() }, [b]); } catch (e) { b.close(); throw e; } // (cpuFace hook: a frame never transferred is closed here)
      }, (e) => { this.cropsOpen--; throw e; })
        .catch(() => { if (this.fw === fw && !rec.dropped) this.faceBusy = false; });
      this.feedTrial('face', (w) => faceFrame(false, w), base);
    } else if (feedCand) this.feedTrial('face', (w) => faceFrame(false, w), base);
    if (toBody) {
      this.bodyBusy = true;
      const bw = this.bw!;
      const hr = bodyHands && this.opts.hands ? this.handRoi : null;
      // (runHands: whether the body worker runs its hand model on this frame; false also while a hands worker takes over)
      const runHands = bodyHands;
      // pose looks at a ≤ 960 px frame; a body worker running only the hand model (Body off) gets the hands' frame
      const bodyBmp = createImageBitmap(video, small(this.opts.body ? 960 : Tracker.HANDS_W));
      if (!hr) void post(bw, bodyBmp, { runHands }, () => { if (this.bw === bw) this.bodyBusy = false; });
      else {
        void Promise.all([bodyBmp, handCrop(hr)])
          .then(([b, hb]) => bw.postMessage({ type: 'frame', bitmap: b, handBitmap: hb, handRoi: hr, runHands, ts: t, id, fullW: W, fullH: H }, [b, hb]))
          .catch(() => { if (this.bw === bw) this.bodyBusy = false; });
      }
      if (host !== bw) this.feedTrial('body', () => ({ bmp: createImageBitmap(video, small(960)), extra: {} }), base);
    }
    if (toHands) {
      this.handsBusy = true;
      const f = handsFrame();
      const hw = this.hw!;
      if (serial) { this.dropHeldHands(); this.heldHands = { w: hw, bmp: f.bmp, msg: { ...base, ...f.extra }, at: tNow }; }
      else void post(hw, f.bmp, f.extra, () => { if (this.hw === hw) this.handsBusy = false; });
      this.feedTrial('hands', handsFrame, base);
    }
  }

  /** Frame-accurate feeding: submit the moment the camera delivers a new frame. */
  private attach(video: HTMLVideoElement) {
    if (this.rvfcVideo === video || !('requestVideoFrameCallback' in video)) return;
    this.rvfcVideo = video;
    const loop = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.rvfcVideo !== video) return;
      this.lastRvfc = performance.now();
      this.lastVideoTime = video.currentTime;
      this.onCameraFrame(meta.presentedFrames, meta.captureTime ?? this.lastRvfc, this.lastRvfc, meta.presentationTime);
      if (this.mode === 'worker' && video.readyState >= 2) this.submit(video, this.lastCapture);
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
  }

  process(video: HTMLVideoElement, nowMs: number): RawTracking | null {
    if (this.mode === 'main') {
      const r = this.main.process(video, nowMs);
      this.roiInfo = this.main.roiInfo;
      if (r) { this.timing.face += (r.inferMs - this.timing.face) * 0.1; this.timing.latency = this.timing.face; }
      return r;
    }
    if ((!this.fw && !this.bw && !this.hw) || video.readyState < 2) return null;
    this.attach(video);
    this.feedVideo = video;
    // background tabs pause requestVideoFrameCallback — poll so OBS keeps getting fresh frames
    if (performance.now() - this.lastRvfc > 100 && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      this.onCameraFrame(undefined, performance.now());
      this.submit(video, this.lastCapture);
    }
    this.settlePair(performance.now());
    try { this.focused = typeof document === 'undefined' || document.hasFocus(); } catch { this.focused = true; }
    this.stallTick(performance.now());
    if (!this.fw) {
      // body-only tracker (second camera in the Body role): one result per new body sample, in order (bodyId / bodyT follow
      // the pose stream as on the main camera; pose and hands of one camera frame while paired)
      if (!this.bodyQ.length) return null;
      const b = this.nextBody()!;
      return { t: b.t, face: null, pose: b.pose, hands: b.hands, width: this.vidW || video.videoWidth, height: this.vidH || video.videoHeight,
        inferMs: this.timing.body, bodyId: b.id, bodyT: b.t, capture: b.capture };
    }
    const f = this.latestFace;
    if (!f || f.id <= this.consumed) return null;
    this.consumed = f.id;
    // (the body sample's own pose + hands: one camera frame while paired, never a pose with the hands of another frame;
    // the oldest not handed out yet, so no sample is skipped when two land between two face results)
    const b = this.nextBody();
    return {
      t: f.t / 1000,
      face: f.r,
      pose: b ? b.pose : this.latestPose,
      hands: b ? b.hands : this.latestHands,
      width: f.w || video.videoWidth,
      height: f.h || video.videoHeight,
      inferMs: f.ms,
      bodyId: b?.id,
      bodyT: b?.t,
      capture: f.capture,
      objects: this.objectsWanted ? this.latestObjects : null,
      ...(f.net ? { faceNet: f.net } : {}),
    };
  }

  close() {
    this.initialization?.controller.abort();
    this.initialization = null;
    this.closeGeneration++;
    this.bwSpawn = this.hwSpawn = null;
    for (const ac of Object.values(this.swapAbort)) ac?.abort();
    this.endWorkers();
    this.ow?.terminate(); this.ow = null; this.objectsBusy = false;
    this.main.close();
    this.face = null;
    this.rvfcVideo = null; this.feedVideo = null;
    this.latestFace = null; this.consumed = 0; this.bodyQ.length = 0;
  }
}

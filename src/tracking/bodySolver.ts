// Body solver: MediaPipe Pose + Hand landmarks → avatar-space targets (directions & bases).
// Avatar space: +X = avatar's left, +Y = up, +Z = avatar's front (toward the camera).
// Retargeting onto a specific skeleton happens in avatar/retarget.ts, so this stays rig-agnostic.
//
// Upper body (2026-09-24 rewrite) — built for a seated streamer whose elbows / wrists are often at or
// below the frame edge:
//  • 2D FIRST — the image positions of shoulders / elbows / wrists are MediaPipe's reliable output; they
//    go through the rest stabiliser (stabilizer.ts: adaptive noise, stillness lock, prediction only in
//    real motion) with outlier rejection (impossible jumps are held, then re-acquired).
//  • OWN DEPTH LAYER — depth is NOT MediaPipe's world z (several cm of wobble). The camera model (FOV from
//    headMetric) + the metric head distance (iris) put the shoulders in metres; each arm segment is then
//    reconstructed on its camera ray with a FIXED bone length learned for this performer (classic
//    monocular IK: |E − S| = L has two solutions ±√(L² − l²) along the ray). MediaPipe's z only votes for
//    the sign / fills in where the geometry is ill-conditioned (bone in the image plane), fused by
//    variance. Depth is never predicted forward.
//  • CONFIDENCE, NOT SWITCHES — elbows / wrists get a smooth confidence from visibility AND from being
//    inside the frame (MediaPipe hallucinates off-frame joints). The retarget blends each segment toward
//    a relaxed pose by its own confidence, so a joint at the frame edge fades instead of popping on/off.
//  • ANATOMY — elbow flexion capped at 150°; a hidden shoulder is mirrored across the neck (from the face).

import * as THREE from 'three';
import type { Landmark, NormalizedLandmark, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { HandsResult } from './Tracker.ts';
import { KalmanBank, OneEuroBank, clamp01, lerp, smoothingToOneEuro, smoothstep } from './filters.ts';
import { StabGroup, type StabChannel } from './stabilizer.ts';

export type Side = 'left' | 'right';

export interface ArmTarget {
  upper: THREE.Vector3; // unit direction shoulder → elbow
  lower: THREE.Vector3; // unit direction elbow → wrist
  confidence: number; // 0..1 (upper segment)
  /** Forearm confidence (wrist seen), defaults to `confidence`. */
  lowerConfidence?: number;
  /** Carried over by the solver's own short hold (not measured this frame) — the tracking-loss layer treats it as missing. */
  held?: boolean;
  /** Capture time (s) of the pose sample this came from: a new value = a new measurement (retarget upsampling). */
  t?: number;
  /** Recent interval between new pose results (s, EMA; 0 = not known yet). */
  interval?: number;
}

export interface HandTarget {
  /** Orthonormal hand basis: forward = wrist→middle knuckle, side = pinky→index, normal = forward×side. */
  forward: THREE.Vector3;
  side: THREE.Vector3;
  /**
   * Signed flexion (radians, + = toward the palm, − = hyperextension) per finger
   * [thumb,index,middle,ring,little] × joint. Fingers: [MCP, PIP, DIP]. Thumb: [unused (see thumbDir), MCP, IP].
   */
  curls: number[][];
  /** MCP abduction per finger (radians, + = toward the thumb side). Thumb entry unused. */
  spread: number[];
  /** Thumb metacarpal direction (CMC→MCP) in hand coordinates (forward, side, forward×side). */
  thumbDir: THREE.Vector3;
  confidence: number;
  /** Carried over by the solver's own short hold (see ArmTarget.held). */
  held?: boolean;
  /** Capture time (s) of the hands sample this came from: a new value = a new measurement (retarget easing / upsampling). */
  t?: number;
  /** Recent interval between new hand results (s, EMA; 0 = not known yet): the retarget eases hands over half of it
   *  when results are slow (handEaseRate). */
  interval?: number;
}

export interface BodyTargets {
  /** Torso basis (left, up) — null when shoulders aren't visible. */
  torso: { left: THREE.Vector3; up: THREE.Vector3; hipsVisible: boolean; confidence: number } | null;
  /** yaw, pitch, roll (radians) — for diagnostics. */
  torsoEuler?: [number, number, number];
  arms: Record<Side, ArmTarget | null>;
  legs: Record<Side, ArmTarget | null>;
  hands: Record<Side, HandTarget | null>;
  /** Gesture label per avatar side (+ wrist image x for wave detection). */
  gestures: Record<Side, { name: string; score: number; wristX: number } | null>;
}

/**
 * Optional per-sample stamps on the pose / hands result objects (hands in their own worker: pose and hands then arrive
 * at their own rates). Either `{ id, t }` on the result itself or under `stamp` is read; `t` = capture time (s).
 * Declared here so the solver doesn't depend on the tracker's types.
 */
interface SampleStamp { id?: number; t?: number }
type MaybeStamped = SampleStamp & { stamp?: SampleStamp };
function stampOf(o: unknown): { id: number | undefined; t: number } | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as MaybeStamped;
  const src = s.stamp && typeof s.stamp === 'object' ? s.stamp : s;
  return typeof src.t === 'number' && Number.isFinite(src.t) ? { id: typeof src.id === 'number' ? src.id : undefined, t: src.t } : null;
}

/** One result stream (pose or hands): which sample was consumed last, and the EMA of the interval between samples. */
class SampleClock {
  private obj: unknown = null;
  private id: number | undefined = undefined;
  t = NaN;
  /** EMA of the interval between new samples (s); 0 = not known yet. */
  interval = 0;
  /** A new sample? By its capture time, plus object identity (a re-wrapped repeat keeps t and id). Never by id alone:
   *  the multicam Body role offsets ids, and two cameras can share them. */
  isNew(obj: unknown, s: { id: number | undefined; t: number }) {
    return s.t !== this.t || (obj !== this.obj && s.id !== this.id);
  }
  take(obj: unknown, id: number | undefined, t: number) {
    const dt = t - this.t;
    // pauses (tracking stopped, a stalled worker) don't count as the result rate
    if (dt > 0 && dt < 0.5) this.interval = this.interval > 0 ? this.interval + (dt - this.interval) * 0.2 : dt;
    this.obj = obj; this.id = id; this.t = t;
  }
}

/** Camera / head context from the face solver (for the metric depth layer). */
export interface BodyCam {
  /** Focal length in frame-WIDTH units. */
  focal: number;
  /** Metric distance camera → face (m), 0 = unknown. */
  headZ: number;
  /** Face centroid in normalized image coords (0..1), for the neck. */
  headU: number; headV: number;
  tracked: boolean;
}

// Pose landmark indices
const P = {
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
};
const MIRROR_SWAP = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31];

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
/** Palm segments (wrist → each knuckle, index → little knuckle): a hand's image size. */
const PALM = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17]];

/** Anatomical side of the performer. */
type Anat = 'l' | 'r';
const ANAT: Record<Anat, { s: number; e: number; w: number }> = { l: { s: P.lShoulder, e: P.lElbow, w: P.lWrist }, r: { s: P.rShoulder, e: P.rElbow, w: P.rWrist } };

// image-plane channel noise (frame-HEIGHT units) and MediaPipe relative depth noise (m)
const IMG: StabChannel = { sigma: [0.003, 0.0007, 0.02], kalman: [40, 0.008], dzMax: 0.012 };
const IMG_SH: StabChannel = { sigma: [0.002, 0.0005, 0.008], kalman: [6, 0.006], dzMax: 0.006 };
const MPZ: StabChannel = { sigma: [0.012, 0.003, 0.04], kalman: [15, 0.03], noLead: true, dzMax: 0.03 };
/** Wrist distance from the hand's apparent size (m): ~5 % scale noise. */
const HANDZ: StabChannel = { sigma: [0.02, 0.005, 0.06], kalman: [8, 0.03], noLead: true, dzMax: 0.04 };
/** Torso yaw source (shoulder depth difference): the torso turns slowly — heavily modelled. */
const MPZ_T: StabChannel = { sigma: [0.012, 0.003, 0.04], kalman: [3, 0.03], noLead: true, dzMax: 0.03 };
/** Arm segment direction components (unit vector ≈ radians). */
const DIR: StabChannel = { sigma: [0.02, 0.005, 0.1], kalman: null, dzMax: 0.06 };
const ANG: StabChannel = { sigma: [0.02, 0.004, 0.08], kalman: null, dzMax: 0.05 };

interface HandWrist { x: number; y: number; /** metres per frame-height unit of the palm (depth = focal_h · r), 0 = unknown */ r: number }

/**
 * Wrist image position + hand scale. The hand's world landmarks are metric AND camera-axis aligned, so
 * their x/y components are exactly what projects onto the image: depth = f · Σ|world_xy| / Σ|image_xy|
 * over the palm segments (tilt-proof — a foreshortened palm shrinks in both).
 */
function handScale(img: NormalizedLandmark[], w: Landmark[], aspect: number): HandWrist {
  let sw = 0, si = 0;
  for (const [a, b] of [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17], [5, 9], [9, 13], [13, 17]]) {
    sw += Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y);
    si += Math.hypot((img[a].x - img[b].x) * aspect, img[a].y - img[b].y);
  }
  return { x: img[0].x, y: img[0].y, r: si > 0.01 && sw > 0.02 ? sw / si : 0 };
}

/** Elbow for shoulder S → wrist W with fixed bone lengths, bent toward `pole` (direction from S). */
function twoBoneIK(S: THREE.Vector3, W: THREE.Vector3, Lu: number, Lf: number, pole: THREE.Vector3): THREE.Vector3 {
  const d = W.clone().sub(S);
  let D = d.length();
  if (D < 1e-4) return S.clone().add(pole.clone().normalize().multiplyScalar(Lu));
  const u = d.divideScalar(D);
  D = Math.min(D, (Lu + Lf) * 0.999);
  D = Math.max(D, Math.abs(Lu - Lf) + 1e-3);
  const a = (Lu * Lu - Lf * Lf + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, Lu * Lu - a * a));
  const p = pole.clone().addScaledVector(u, -pole.dot(u));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(u, u.y); // default: elbow down
  p.normalize();
  return S.clone().addScaledVector(u, a).addScaledVector(p, h);
}

export class BodySolver {
  private f = new OneEuroBank(1.0, 0.05);
  /** Legs / hips (rarely in frame for streamers): constant-velocity Kalman on world landmarks. */
  private k = new KalmanBank();
  private hf: Record<Side, OneEuroBank> = { left: new OneEuroBank(2, 1), right: new OneEuroBank(2, 1) };
  /** Use the stabilised 2D + metric-depth arm solver (false = the pre-2026-09-24 world-landmark path). */
  stabilize = (() => { try { return localStorage.getItem('vtp.stabilize') !== '0'; } catch { return true; } })();
  /** Shoulders [lx, ly, rx, ry] (height units) + MediaPipe shoulder depth difference (m). */
  private torsoStab = new StabGroup([IMG_SH, IMG_SH, IMG_SH, IMG_SH, MPZ_T]);
  /** Per anatomical arm: elbow x,y, wrist x,y (height units), elbow/wrist depth rel. to parent (m), wrist distance from the hand size (m). */
  private armStab: Record<Anat, StabGroup> = {
    l: new StabGroup([IMG, IMG, IMG, IMG, MPZ, MPZ, HANDZ]),
    r: new StabGroup([IMG, IMG, IMG, IMG, MPZ, MPZ, HANDZ]),
  };
  /** Per avatar side: 28 hand angle channels (curls 15, spread 4, thumb 3, forward 3, side 3). */
  private handStab: Record<Side, StabGroup> = {
    left: new StabGroup(Array.from({ length: 28 }, () => ANG)),
    right: new StabGroup(Array.from({ length: 28 }, () => ANG)),
  };
  /** Learned performer geometry (m): shoulder width, upper arm, forearm; shoulder depth (smoothed). */
  geom = { W: 0.34, Lu: 0.29, Lf: 0.255, nW: 0, nLu: 0, nLf: 0, Zs: 0 };
  /** Depth sign per anatomical segment (+1 = farther than its parent joint), with hysteresis. */
  private sgn: Record<string, number> = {};
  private flipN: Record<string, number> = {};
  /** Smoothed joint confidences per anatomical side. */
  private conf: Record<Anat, { e: number; w: number }> = { l: { e: 0, w: 0 }, r: { e: 0, w: 0 } };
  private upperT: Record<Anat, number> = { l: 0, r: 0 };
  private latch: Record<Anat, { e: number; w: number; te: number; tw: number; oe: number; ow: number }> = { l: { e: 0, w: 0, te: 0, tw: 0, oe: 0, ow: 0 }, r: { e: 0, w: 0, te: 0, tw: 0, oe: 0, ow: 0 } };
  /** Output-stage stabiliser on the arm segment directions (6 unit-vector components). */
  private dirStab: Record<Anat, StabGroup> = { l: new StabGroup(Array.from({ length: 6 }, () => DIR)), r: new StabGroup(Array.from({ length: 6 }, () => DIR)) };
  private lastHW: Record<Anat, { hw: HandWrist; t: number; rej: number } | null> = { l: null, r: null };
  private lastZHand: Record<Anat, { z: number; t: number; rej: number } | null> = { l: null, r: null };
  private lastLower: Record<Anat, { q: THREE.Quaternion } | null> = { l: null, r: null };
  /** Smoothed elbow swivel hint per side (direction from the shoulder). */
  private pole: Record<Anat, THREE.Vector3 | null> = { l: null, r: null };
  /** Outlier rejection: last accepted 2D per landmark + consecutive rejections. */
  private lastPt = new Map<number, { x: number; y: number; t: number; rej: number }>();
  /** Last solved metric joints (camera GL frame, m) per anatomical side — diagnostics / tools. */
  joints: Record<Anat, { S: THREE.Vector3; E: THREE.Vector3; W: THREE.Vector3 } | null> = { l: null, r: null };

  /**
   * opts.bodyId / bodyT: which body result this is and when its frame was captured (worker tracker).
   * Pose + hands arrive slower than the face, so the same result is handed in several times; it is
   * filtered once, at its own timestamp, and the cached targets are returned for repeats.
   * When the pose / hands result objects carry their own stamps (`{ id, t }`, see stampOf: hands in their own worker),
   * each stream is filtered on its own new samples instead: arms, torso and legs step only on a new pose sample, the
   * hands only on a new hands sample, and the other stream's last targets are kept. Without stamps: as before.
   * opts.handSmoothing: finger/wrist smoothing (0..1), defaults to `smoothing`.
   * opts.cam: camera focal + metric head distance (depth layer); without it a 78° FOV / 0.6 m is assumed.
   */
  solve(pose: PoseLandmarkerResult | null, hands: HandsResult | null, t: number, mirror: boolean, smoothing: number, aspect = 16 / 9,
    opts: { bodyId?: number; bodyT?: number; handSmoothing?: number; lead?: number; cam?: BodyCam } = {}): BodyTargets {
    // which stream has a new sample, and its capture time (tp: pose, th: hands)
    const ps = stampOf(pose), hs = stampOf(hands);
    let doPose: boolean, doHands: boolean, tp: number, th: number;
    if (ps || hs) {
      // a mirror switch re-solves both (as the bodyId path always did)
      const all = mirror !== this.lastMirror || !this.lastOut;
      const pn = ps ? all || this.poseClock.isNew(pose, ps) : null;
      const hn = hs ? all || this.handsClock.isNew(hands, hs) : null;
      // a missing / unstamped stream follows the other one's clock (its hold / fade still advances)
      tp = ps?.t ?? hs!.t; th = hs?.t ?? ps!.t;
      doPose = pn ?? hn!; doHands = hn ?? pn!;
      if (!doPose && !doHands) return this.lastOut!;
      // pose + hands from one worker carry the same stamp; from their own workers mostly different ones
      if (ps && hs) this.pairSplit += ((ps.t !== hs.t || ps.id !== hs.id ? 1 : 0) - this.pairSplit) * 0.25;
    } else {
      if (opts.bodyId !== undefined && opts.bodyId === this.lastBodyId && this.lastMirror === mirror && this.lastOut) return this.lastOut;
      doPose = doHands = true;
      tp = th = opts.bodyT ?? t;
    }
    this.lastBodyId = opts.bodyId;
    this.lastMirror = mirror;
    // the result intervals: a null stream (perf/hands-pipeline passes hands = null when none are found) steps on the
    // other stream's clock. From one worker that is its own result too (both clocks move, as on the bodyId path); from
    // its own worker it must not take the other stream's times as its own interval (pose 10 Hz would make 30 Hz hands
    // ease as if they came at 10-19 Hz)
    const own = !!(ps || hs) && this.pairSplit > 0.5;
    if (doPose && (ps || !own)) this.poseClock.take(pose, ps?.id, tp);
    if (doHands && (hs || !own)) this.handsClock.take(hands, hs?.id, th);
    const handSmoothing = opts.handSmoothing ?? smoothing;
    const { minCutoff, beta } = smoothingToOneEuro(smoothing);
    this.f.minCutoff = minCutoff * 0.8; this.f.beta = beta * 3;
    const sa = lerp(30, 4, clamp01(smoothing)), lead = opts.lead ?? 0;
    const out: BodyTargets = { torso: null, arms: { left: null, right: null }, legs: { left: null, right: null }, hands: { left: null, right: null }, gestures: { left: null, right: null } };
    // a stream without a new sample keeps its last targets: no filter ever sees the same sample twice
    const last = this.lastOut;
    if (!doPose && last) { out.torso = last.torso; if (last.torsoEuler) out.torsoEuler = last.torsoEuler; out.arms = { ...last.arms }; out.legs = { ...last.legs }; }
    if (!doHands && last) { out.hands = { ...last.hands }; out.gestures = { ...last.gestures }; }
    const world = pose?.worldLandmarks?.[0];
    const norm = pose?.landmarks?.[0];
    const handsSeen = !!(hands?.worldLandmarks?.length && hands.landmarks?.length);
    // the left/right gate compares the pose wrists with the hand wrists, so it is only meaningful when both come from one
    // camera frame (equal capture stamps). Without stamps the pose and the hands are one worker's result for one frame.
    const oneFrame = !(ps && hs) || Math.abs(ps.t - hs.t) <= this.gateTune.sameFrame;

    // hands first: their wrists are the best 2D wrist measurement for the arm solver
    let handWrist: Record<Anat, HandWrist | null> = { l: null, r: null };
    let sides: (Side | null)[] = [];
    if (doHands) {
      if (!handsSeen) this.closeRun.n = 0;
      else {
        sides = this.assignSides(hands!, norm, aspect, th, oneFrame);
        for (let h = 0; h < sides.length; h++) {
          const s = sides[h];
          if (s) handWrist[s === 'left' ? 'l' : 'r'] = handScale(hands!.landmarks[h], hands!.worldLandmarks[h], aspect);
        }
      }
      this.lastHandWrist = handWrist;
    } else if (handsSeen && Math.abs(tp - th) < 0.2) handWrist = this.lastHandWrist; // a pose sample between two hand samples: the latest hands (not stale ones)

    if (doPose && world && norm) {
      const gate = this.poseWristsUnreliable(hands, norm, aspect, oneFrame);
      if (this.stabilize) this.solveUpper(out, norm, world, tp, mirror, smoothing, aspect, lead, opts.cam, handWrist, gate);
      else this.solveUpperLegacy(out, norm, world, tp, mirror, sa, aspect, lead);
      const sx = mirror ? -1 : 1;
      const get = (i: number) => {
        const j = mirror ? MIRROR_SWAP[i] : i;
        const w = world[j];
        return new THREE.Vector3(this.k.filter(`${i}x`, sx * w.x, tp, sa, 0.015, 0), this.k.filter(`${i}y`, -w.y, tp, sa, 0.015, 0), this.k.filter(`${i}z`, -w.z, tp, sa * 0.6, 0.04, 0));
      };
      const vis = (i: number) => norm[mirror ? MIRROR_SWAP[i] : i]?.visibility ?? 0;
      const limb = (a: number, b: number, c: number): ArmTarget | null => {
        const conf = Math.min(vis(a), vis(b), vis(c));
        if (conf < 0.6) return null; // legs are only trustworthy when clearly in frame
        const pa = get(a), pb = get(b), pc = get(c);
        return { upper: pb.clone().sub(pa).normalize(), lower: pc.clone().sub(pb).normalize(), confidence: clamp01((conf - 0.35) / 0.4) };
      };
      out.legs.left = limb(P.lHip, P.lKnee, P.lAnkle);
      out.legs.right = limb(P.rHip, P.rKnee, P.rAnkle);
    }

    if (doHands && handsSeen) {
      for (let h = 0; h < hands!.worldLandmarks.length; h++) {
        const anat = sides[h];
        if (!anat) continue;
        const side: Side = mirror ? (anat === 'left' ? 'right' : 'left') : anat;
        const solved = this.solveHand(hands!.worldLandmarks[h], side, th, mirror, handSmoothing);
        if (!solved) continue;
        const score = hands!.handedness?.[h]?.[0]?.score ?? 0.8;
        // fresh (re)acquisition eases in over ~0.12 s instead of popping (and hides one-frame false hands)
        const lh = this.lastHand[side];
        if (!lh || th - lh.t > 0.3) this.acquired[side] = th;
        const ramp = clamp01(0.25 + (th - this.acquired[side]) / 0.12);
        out.hands[side] = { ...solved, confidence: (0.65 + 0.35 * clamp01((score - 0.5) / 0.4)) * ramp, t: th, interval: this.handsClock.interval };
        const g = hands!.gestures?.[h]?.[0];
        const wx = hands!.landmarks[h][0].x;
        out.gestures[side] = { name: g?.categoryName ?? 'None', score: g?.score ?? 0, wristX: mirror ? 1 - wx : wx };
      }
    }
    // arms/hands that drop out of frame hold briefly (a missed detection shouldn't twitch the avatar),
    // then fade back toward rest instead of snapping (each on its own stream's clock)
    for (const side of ['left', 'right'] as Side[]) {
      if (doPose) {
        const a = out.arms[side];
        if (a) { a.t = tp; a.interval = this.poseClock.interval; this.lastArm[side] = { ...a, t: tp, held: undefined }; }
        else {
          const l = this.lastArm[side];
          if (l && tp - l.t < 1) {
            const k = Math.exp(-(tp - l.t) / 0.35);
            out.arms[side] = { upper: l.upper, lower: l.lower, confidence: l.confidence * k, lowerConfidence: (l.lowerConfidence ?? l.confidence) * k, held: true, t: l.t, interval: l.interval };
          }
        }
      }
      if (doHands) {
        const hd = out.hands[side];
        if (hd) this.lastHand[side] = { ...hd, t: th, held: undefined };
        else {
          const l = this.lastHand[side];
          const age = l ? th - l.t : Infinity;
          if (l && age < 1.2) out.hands[side] = { ...l, confidence: l.confidence * (age < 0.15 ? 1 : Math.exp(-(age - 0.15) / 0.3)), held: true };
          if (age > 0.5) { this.hf[side].reset(); this.handStab[side].reset(); } // re-acquire from scratch
        }
      }
    }
    this.lastOut = out;
    return out;
  }

  /** Accept a 2D landmark or reject an impossible jump (held for up to 3 frames, then re-acquired). */
  private accept(i: number, x: number, y: number, t: number, vis: number): { x: number; y: number } {
    const l = this.lastPt.get(i);
    if (l && t - l.t < 0.2 && l.rej < 3) {
      const d = Math.hypot(x - l.x, y - l.y);
      // > ~4 frame-heights/s (or 8 % of the frame in one step) is faster than a flung arm at webcam distance;
      // confident points are trusted
      if (d > Math.max(0.08, 4 * (t - l.t)) && vis < 0.9) { l.rej++; return { x: l.x, y: l.y }; }
    }
    this.lastPt.set(i, { x, y, t, rej: 0 });
    return { x, y };
  }

  /**
   * Torso + arms from stabilised 2D landmarks and the metric depth layer (see header).
   * All geometry is in the camera GL frame (x right in the image, y up, z toward the camera; metres).
   */
  private solveUpper(out: BodyTargets, norm: NormalizedLandmark[], world: Landmark[], t: number, mirror: boolean, smoothing: number,
    aspect: number, lead: number, cam: BodyCam | undefined, handWrist: Record<Anat, HandWrist | null>, poseWristsUnreliable = false) {
    const G = this.geom;
    const fh = (cam?.focal ?? 0.5 / Math.tan((78 * Math.PI) / 360 * aspect / Math.hypot(aspect, 1))) * aspect; // focal, height units
    const saArm = lerp(30, 6, clamp01(smoothing)); // arm acceleration model (frame-heights/s²)
    const H = (x: number) => x * aspect; // width units → height units
    const inFrame = (x: number, y: number) => smoothstep(1.1, 1.0, y) * smoothstep(-0.08, 0.0, x) * smoothstep(1.08, 1.0, x) * smoothstep(-0.1, 0, y);
    const vis = (i: number) => norm[i]?.visibility ?? 0;

    // ---- shoulders (anatomical l / r), a hidden one mirrored across the neck ----
    const sh = (i: number) => this.accept(i, H(norm[i].x), norm[i].y, t, vis(i));
    let ls = sh(P.lShoulder), rs = sh(P.rShoulder);
    const lOk = vis(P.lShoulder) * inFrame(norm[P.lShoulder].x, norm[P.lShoulder].y), rOk = vis(P.rShoulder) * inFrame(norm[P.rShoulder].x, norm[P.rShoulder].y);
    const neckX = cam?.tracked ? H(cam.headU) : (ls.x + rs.x) / 2;
    if (lOk < 0.5 && rOk >= 0.5) ls = { x: 2 * neckX - rs.x, y: rs.y };
    else if (rOk < 0.5 && lOk >= 0.5) rs = { x: 2 * neckX - ls.x, y: ls.y };
    const shoulderConf = Math.max(lOk, rOk);
    if (shoulderConf < 0.5) return;
    const dzSh = -(world[P.lShoulder].z - world[P.rShoulder].z);
    // shoulders move slowly (≈3 m/s² ≈ 5 frame-heights/s² at webcam distance): a much tighter model than the arms
    for (let i = 0; i < 4; i++) this.torsoStab.tune(i, lerp(12, 3, clamp01(smoothing)), IMG_SH.kalman![1]);
    const [lsx, lsy, rsx, rsy, dzS] = this.torsoStab.step([ls.x, ls.y, rs.x, rs.y, dzSh], t, lead);

    // shoulder depth: face distance + neck offset; without a face, from the learned shoulder width
    const wImg = Math.hypot(lsx - rsx, lsy - rsy);
    if (cam?.tracked && cam.headZ > 0.2 && cam.headZ < 3) {
      const Zs = cam.headZ + 0.07;
      G.Zs = G.Zs ? G.Zs + (Zs - G.Zs) * 0.05 : Zs;
      // learn the shoulder width while facing the camera (both shoulders visible)
      if (lOk > 0.7 && rOk > 0.7 && Math.abs(dzS) < 0.08) { G.nW++; G.W += ((wImg * G.Zs) / fh - G.W) / Math.min(G.nW, 200); }
    } else if (wImg > 0.02) {
      const Zs = (fh * G.W) / wImg;
      G.Zs = G.Zs ? G.Zs + (Zs - G.Zs) * 0.05 : Zs;
    }
    if (!G.Zs) G.Zs = 0.65;
    G.W = Math.min(0.46, Math.max(0.26, G.W));
    const ray = (x: number, y: number) => new THREE.Vector3((x - aspect / 2) / fh, -(y - 0.5) / fh, -1).normalize();
    const atDepth = (x: number, y: number, Z: number) => { const r = ray(x, y); return r.multiplyScalar(Z / -r.z); };
    // shoulders straddle the torso yaw (MediaPipe depth difference, damped + capped)
    const half = Math.max(-0.08, Math.min(0.08, dzS * 0.5)) / 2;
    const S = { l: atDepth(lsx, lsy, G.Zs - half), r: atDepth(rsx, rsy, G.Zs + half) };

    // ---- torso: roll from the 2D shoulder line, yaw from the depth difference ----
    {
      const sx = mirror ? -1 : 1;
      const lx = (lsx - rsx) * sx, ly = -(lsy - rsy);
      const roll = THREE.MathUtils.clamp(Math.atan2(ly, Math.abs(lx) + 1e-6) * Math.sign(lx || 1), -0.35, 0.35);
      const yawRaw = Math.atan2(-dzS * sx, Math.max(0.1, G.W)); // same convention as the legacy path
      const yaw = THREE.MathUtils.clamp(yawRaw * 0.5, -0.35, 0.35);
      const hipsVisible = Math.min(vis(P.lHip), vis(P.rHip)) > 0.6;
      let pitch = 0;
      if (hipsVisible) {
        const hm = (i: number) => new THREE.Vector3(world[i].x, -world[i].y, -world[i].z);
        const upW = hm(P.lShoulder).add(hm(P.rShoulder)).multiplyScalar(0.5).sub(hm(P.lHip).add(hm(P.rHip)).multiplyScalar(0.5)).normalize();
        pitch = THREE.MathUtils.clamp(Math.atan2(upW.z, upW.y), -0.4, 0.4);
      }
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, roll, 'YXZ'));
      out.torso = { left: new THREE.Vector3(1, 0, 0).applyQuaternion(q), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), hipsVisible, confidence: clamp01((shoulderConf - 0.5) * 2) };
      out.torsoEuler = [yaw, pitch, roll];
    }

    // ---- arms ----
    const sigImg = (0.004 / fh) * G.Zs; // metres of 2D landmark noise at shoulder depth
    for (const a of ['l', 'r'] as Anat[]) {
      const J = ANAT[a];
      let hw = handWrist[a];
      // a hand only drives the arm if it agrees with the pose model's wrist (when that is clearly seen) and
      // is continuous with the last good one (a hand can't change its apparent size by 30 % or jump between
      // frames — that's a duplicate / swapped detection). A rejected hand is replaced by the last good one
      // for up to 0.3 s, so the solver never flips between the hand and no-hand solutions frame to frame.
      // When the pose wrists themselves are confused (crossed / clasped hands, see poseWristsUnreliable) the pose wrist
      // is a poor reference, but it is still the guard against a duplicate / false second hand. So then only a hand
      // that CONTINUES this arm's last accepted hand (same size and place: the test below) or sits within 0.15 of the
      // pose wrist gets past it; a hand that turns up somewhere new (a duplicate of the other hand, a false hand by the
      // face) while this pose wrist is clearly seen elsewhere is still rejected. Offline (2026-10-04, 6 runs, two-hand
      // results this check would reject): 723 of the 774 right hands the plain gate let through still pass, 4 of its 17
      // wrong ones; arm wrist error vs GT the same as with the plain gate (near clip p90 0.312 -> 0.291 frame heights).
      const lh = this.lastHW[a];
      let ok = !!hw;
      const cont = !!(hw && lh && t - lh.t < 0.3 && lh.rej < 4 && hw.r > 0 && lh.hw.r > 0 &&
        Math.abs(hw.r / lh.hw.r - 1) <= 0.3 && Math.hypot(H(hw.x - lh.hw.x), hw.y - lh.hw.y) <= Math.max(0.06, 3 * (t - lh.t)));
      if (hw && vis(J.w) > 0.7 && inFrame(norm[J.w].x, norm[J.w].y) > 0.9) {
        const dp = Math.hypot(H(hw.x - norm[J.w].x), hw.y - norm[J.w].y);
        if (dp > 0.09 && !(poseWristsUnreliable && (cont || dp < 0.15))) ok = false;
      }
      if (ok && hw && lh && t - lh.t < 0.3 && lh.rej < 4 && hw.r > 0 && lh.hw.r > 0 &&
        (Math.abs(hw.r / lh.hw.r - 1) > 0.3 || Math.hypot(H(hw.x - lh.hw.x), hw.y - lh.hw.y) > Math.max(0.06, 3 * (t - lh.t)))) ok = false;
      if (ok && hw) this.lastHW[a] = { hw, t, rej: 0 };
      else if (hw && lh && t - lh.t < 0.3 && lh.rej < 4) { lh.rej++; hw = lh.hw; }
      else if (hw) hw = null;
      if (hw && hw.r > 0) {
        const W3 = atDepth(H(hw.x), hw.y, fh * hw.r);
        if (W3.distanceTo(S[a]) > (G.Lu + G.Lf) * 1.2 || W3.z > S[a].z + 0.05 && W3.distanceTo(S[a]) > 0.1 + G.Lu) hw = null;
      }
      const ev = vis(J.e), wv = hw ? Math.max(vis(J.w), 0.95) : vis(J.w);
      const e2 = this.accept(J.e, H(norm[J.e].x), norm[J.e].y, t, ev);
      const wxy = hw ? { x: H(hw.x), y: hw.y } : { x: H(norm[J.w].x), y: norm[J.w].y };
      const w2 = this.accept(J.w, wxy.x, wxy.y, t, wv);
      const cwRaw = smoothstep(0.3, 0.65, wv) * (hw ? 1 : inFrame(norm[J.w].x, norm[J.w].y));
      // an elbow just below the frame is still usable when the wrist is seen: the chain (known bone
      // lengths from a known shoulder to a seen wrist) pins it down, and it's what a raised hand looks like
      // with a tracked hand the wrist is known in 3D (hand-size depth) and the elbow is solved by 2-bone IK,
      // so the arm is trusted whatever the elbow's own visibility
      // elbows at the bottom edge are MediaPipe's noisiest guesses: on their own they only count well inside
      const eFrame = inFrame(norm[J.e].x, norm[J.e].y) * smoothstep(1.0, 0.94, norm[J.e].y), eNear = smoothstep(1.3, 1.1, norm[J.e].y);
      const ce = hw ? Math.max(cwRaw, smoothstep(0.3, 0.65, ev) * eFrame) : smoothstep(0.3, 0.65, ev) * Math.max(eFrame, cwRaw * eNear * 0.9);
      const cw = Math.min(ce, cwRaw);
      // confidence is a latched state with hysteresis (on > 0.5, off < 0.2) that eases in 0.3 s / out
      // 0.5 s: a joint hovering at the frame edge can't make the arm flicker or wobble with its visibility
      const C = this.conf[a];
      const dtc = Math.min(0.25, Math.max(0.005, t - this.upperT[a]));
      this.upperT[a] = t;
      // (switching on needs 0.2 s of evidence: one-frame false hands / joints never move the arm)
      const L = this.latch[a];
      // (switching off needs 0.35 s of absence: a hand model dropping the hand for a few frames doesn't)
      L.te = ce > 0.5 ? L.te + dtc : 0; L.tw = cw > 0.5 ? L.tw + dtc : 0;
      L.oe = ce < 0.2 ? L.oe + dtc : 0; L.ow = cw < 0.2 ? L.ow + dtc : 0;
      L.e = L.te >= 0.2 ? 1 : L.oe >= 0.35 ? 0 : L.e;
      L.w = L.e && L.tw >= 0.2 ? 1 : !L.e || L.ow >= 0.35 ? 0 : L.w;
      C.e += (L.e - C.e) * (1 - Math.exp(-dtc / (L.e > C.e ? 0.3 : 0.5)));
      C.w += (L.w - C.w) * (1 - Math.exp(-dtc / (L.w > C.w ? 0.3 : 0.5)));
      if (C.e < 0.02) { this.joints[a] = null; continue; }
      const mpE = -(world[J.e].z - world[J.s].z), mpW = -(world[J.w].z - world[J.e].z);
      const g = this.armStab[a];
      for (let i = 0; i < 4; i++) g.tune(i, saArm, IMG.kalman![1]);
      // trust per channel: unseen joints are held, never extrapolated, and can't release the lock
      // (the elbow's own trust is its own evidence — with a tracked hand the arm is confident even when the
      // elbow is an off-frame guess, but that guess must not steer anything)
      const te = clamp01(smoothstep(0.3, 0.65, ev) * (hw ? eFrame : Math.max(eFrame, cwRaw * eNear * 0.9)) * 1.5), tw = clamp01(cw * 1.5);
      let zHand = hw && hw.r > 0 ? fh * hw.r : NaN; // wrist distance from the hand's apparent size (m)
      // hand-scale glitches (one frame of a mis-fitted palm) are impossible depth jumps: hold, then re-acquire;
      // and a wrist can't sit far behind its own shoulder
      if (Number.isFinite(zHand)) {
        const zs = -S[a].z;
        zHand = Math.min(zs + 0.15, Math.max(zs - (G.Lu + G.Lf) * 1.05, zHand));
        const zl = this.lastZHand[a];
        if (zl && t - zl.t < 0.2 && zl.rej < 3 && Math.abs(zHand - zl.z) > Math.max(0.05, 1.5 * (t - zl.t))) { zl.rej++; zHand = zl.z; }
        else this.lastZHand[a] = { z: zHand, t, rej: 0 };
      }
      const [ex, ey, wx, wy, dzE, dzW, zW] = g.step([e2.x, e2.y, w2.x, w2.y, mpE, mpW, zHand], t, lead, [te, te, tw, tw, te, tw, hw ? tw : 0]);
      const Sj = S[a];
      // learn bone lengths: 85th percentile of the in-plane length (foreshortening only shortens)
      const learn = (key: 'Lu' | 'Lf', from: THREE.Vector3, x: number, y: number, ok: boolean) => {
        if (!ok) return;
        const l = atDepth(x, y, -from.z).distanceTo(from);
        const n = key === 'Lu' ? ++G.nLu : ++G.nLf;
        const eta = Math.max(0.004, 0.05 / Math.sqrt(n));
        G[key] *= Math.exp(eta * ((l > G[key] ? 1 : 0) - 0.15));
        const [lo, hi] = key === 'Lu' ? [0.72, 1.05] : [0.6, 0.92];
        G[key] = Math.min(hi * G.W, Math.max(lo * G.W, G[key]));
      };
      learn('Lu', Sj, ex, ey, ce > 0.8 && eFrame > 0.9);
      // chain IK: elbow and wrist on their camera rays at fixed bone lengths (2D-pinned; depth from geometry,
      // front/back voted by the hand's depth when tracked, else MediaPipe's z)
      const Ec = this.onRay(Sj, ray(ex, ey), G.Lu, dzE, `${a}e`, sigImg);
      const handZ = !!hw && zW > 0.15 && zW < 2.5;
      learn('Lf', Ec, wx, wy, cw > 0.8 && te > 0.8);
      const Wc = this.onRay(Ec, ray(wx, wy), G.Lf, handZ ? -Ec.z - zW : dzW, `${a}w`, sigImg);
      let E = Ec, Wp = Wc;
      // elbow unseen (typically below the frame) but hand tracked: wrist in 3D from the hand's size, elbow by
      // 2-bone IK. Swivel hint: MediaPipe's elbow (only as far as it's seen) pulled toward the natural "elbow
      // down and out", smoothed ≈0.3 s — the swivel is a slow degree of freedom; noise there reads as wobble.
      // The two solutions are cross-faded by the elbow's trust, so there is no pop between them.
      const kHand = handZ ? 1 - smoothstep(0.35, 0.75, te) : 0;
      if (kHand > 0) {
        const Wh = atDepth(wx, wy, zW);
        const out0 = new THREE.Vector3(a === 'l' ? 0.35 : -0.35, -1, 0).normalize();
        const hint = Ec.clone().sub(Sj).normalize().multiplyScalar(te).add(out0).normalize();
        const pl = this.pole[a];
        this.pole[a] = pl ? pl.lerp(hint, 1 - Math.exp(-dtc / 0.3)).normalize() : hint;
        const Eh = twoBoneIK(Sj, Wh, G.Lu, G.Lf, this.pole[a]!.clone());
        const Wh2 = Eh.clone().add(Wh.sub(Eh).normalize().multiplyScalar(G.Lf));
        E = Ec.clone().lerp(Eh, kHand);
        Wp = Wc.clone().lerp(Wh2, kHand);
      } else this.pole[a] = null;
      this.joints[a] = { S: Sj.clone(), E: E.clone(), W: Wp.clone() };
      const upper = E.clone().sub(Sj).normalize();
      let lower = Wp.clone().sub(E).normalize();
      // an unseen wrist keeps the last trusted forearm (relative to the upper arm) while its confidence fades
      const la = this.lastLower[a];
      if (tw >= 0.5) this.lastLower[a] = { q: new THREE.Quaternion().setFromUnitVectors(upper, lower) };
      else if (la) lower = upper.clone().applyQuaternion(la.q);
      // anatomy: the elbow can't fold past ~150°
      const c = upper.dot(lower);
      if (c < -0.866) {
        const perp = lower.clone().addScaledVector(upper, -c);
        if (perp.lengthSq() > 1e-8) lower = upper.clone().multiplyScalar(-0.866).addScaledVector(perp.normalize(), 0.5).normalize();
      }
      // final lock on the arm directions themselves: whatever noise survives the joint stage (an elbow guessed
      // at the frame edge moves both segments coherently) is judged — and locked — where the viewer sees it
      {
        const o = this.dirStab[a].step([upper.x, upper.y, upper.z, lower.x, lower.y, lower.z], t, 0, [1, 1, 1, tw, tw, tw]);
        upper.set(o[0], o[1], o[2]).normalize();
        lower.set(o[3], o[4], o[5]).normalize();
      }
      // camera GL → avatar space (mirror flips x and swaps sides)
      const toAvatar = (v: THREE.Vector3) => (mirror ? v.set(-v.x, v.y, v.z) : v);
      const side: Side = (a === 'l') !== mirror ? 'left' : 'right';
      out.arms[side] = { upper: toAvatar(upper), lower: toAvatar(lower), confidence: C.e, lowerConfidence: C.w };
    }
  }

  /**
   * Point on camera ray `r` at distance L from `from` (the metric depth layer). Geometry gives the depth
   * magnitude ±√(L² − l²); MediaPipe's relative depth `mpDz` (m, + = toward the camera) picks the sign and
   * is fused by variance — it dominates only where the geometry is ill-conditioned (bone ⟂ ray).
   */
  private onRay(from: THREE.Vector3, r: THREE.Vector3, L: number, mpDz: number, key: string, sigImg: number) {
    const tc = r.dot(from);
    const l2 = Math.max(0, from.lengthSq() - tc * tc), l = Math.sqrt(l2);
    const disc = L * L - l2;
    // MediaPipe's vote as an offset along the ray (+ = farther from the camera)
    const tMp = (from.z + mpDz) / r.z;
    const uMp = tMp - tc;
    // front / back ambiguity: switching sign is only continuous near the crossover (bone ⟂ ray, d → 0).
    // There MediaPipe decides; elsewhere the previous branch is kept unless MediaPipe insists (≥ 4 frames
    // clearly on the other side) — flipping branches mid-way was the classic "elbow teleports" artefact.
    const s = this.sgn[key] ?? (uMp >= 0 ? 1 : -1);
    const d0 = disc > 0 ? Math.sqrt(disc) : 0;
    let ns = s;
    const want = uMp > 0 ? 1 : -1;
    if (d0 < 0.25 * L) { if (Math.abs(uMp) > 0.025) ns = want; this.flipN[key] = 0; }
    else if (want !== s && Math.abs(uMp) > Math.max(0.05, 0.5 * d0)) { this.flipN[key] = (this.flipN[key] ?? 0) + 1; if (this.flipN[key] >= 4) { ns = want; this.flipN[key] = 0; } }
    else this.flipN[key] = 0;
    this.sgn[key] = ns;
    let u: number;
    if (disc > 0) {
      const d = d0;
      const sIk = (sigImg * l + 0.05 * L * L) / Math.max(d, 0.01);
      const sMp = 0.06;
      const wI = 1 / (sIk * sIk), wM = 1 / (sMp * sMp);
      u = (ns * d * wI + uMp * wM) / (wI + wM);
    } else u = Math.max(-0.3 * L, Math.min(0.3 * L, uMp)) * 0.5;
    const P0 = r.clone().multiplyScalar(tc + u);
    // enforce the bone length (direction from `from` is what the avatar uses)
    const dv = P0.sub(from);
    const len = dv.length();
    return len > 1e-6 ? from.clone().addScaledVector(dv, L / len) : from.clone().add(new THREE.Vector3(0, -L, 0));
  }

  /** Pre-2026-09-24 torso + arms (world landmarks, Kalman + prediction). Kept for A/B (vtp.stabilize=0). */
  private solveUpperLegacy(out: BodyTargets, norm: NormalizedLandmark[], world: Landmark[], t: number, mirror: boolean, sa: number, aspect: number, lead: number) {
    const sx = mirror ? -1 : 1;
    const get = (i: number) => {
      const j = mirror ? MIRROR_SWAP[i] : i;
      const w = world[j];
      return new THREE.Vector3(this.k.filter(`${i}x`, sx * w.x, t, sa, 0.015, lead), this.k.filter(`${i}y`, -w.y, t, sa, 0.015, lead), this.k.filter(`${i}z`, -w.z, t, sa * 0.6, 0.04, lead));
    };
    const vis = (i: number) => norm[mirror ? MIRROR_SWAP[i] : i]?.visibility ?? 0;
    const ls = get(P.lShoulder), rs = get(P.rShoulder);
    const shoulderVis = Math.min(vis(P.lShoulder), vis(P.rShoulder));
    if (shoulderVis > 0.5) {
      const nl = norm[mirror ? MIRROR_SWAP[P.lShoulder] : P.lShoulder], nr = norm[mirror ? MIRROR_SWAP[P.rShoulder] : P.rShoulder];
      const lx = (nl.x - nr.x) * sx * aspect, ly = -(nl.y - nr.y);
      const roll = THREE.MathUtils.clamp(this.k.filter('roll', Math.atan2(ly, Math.abs(lx) + 1e-6) * Math.sign(lx || 1), t, sa * 2, 0.03, lead), -0.35, 0.35);
      const lw = ls.clone().sub(rs);
      const yaw = THREE.MathUtils.clamp(this.k.filter('yaw', Math.atan2(-lw.z, Math.abs(lw.x) + 1e-6) * 0.5, t, sa * 2, 0.05, lead), -0.35, 0.35);
      const hipsVisible = Math.min(vis(P.lHip), vis(P.rHip)) > 0.6;
      let pitch = 0;
      if (hipsVisible) {
        const upW = ls.clone().add(rs).multiplyScalar(0.5).sub(get(P.lHip).add(get(P.rHip)).multiplyScalar(0.5)).normalize();
        pitch = THREE.MathUtils.clamp(Math.atan2(upW.z, upW.y), -0.4, 0.4);
      }
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, roll, 'YXZ'));
      out.torso = { left: new THREE.Vector3(1, 0, 0).applyQuaternion(q), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q), hipsVisible, confidence: clamp01((shoulderVis - 0.5) * 2) };
      out.torsoEuler = [yaw, pitch, roll];
    }
    const limb = (a: number, b: number, c: number): ArmTarget | null => {
      const conf = Math.min(vis(a), vis(b), vis(c));
      if (conf < 0.35) return null;
      const pa = get(a), pb = get(b), pc = get(c);
      return { upper: pb.clone().sub(pa).normalize(), lower: pc.clone().sub(pb).normalize(), confidence: clamp01((conf - 0.35) / 0.4) };
    };
    out.arms.left = limb(P.lShoulder, P.lElbow, P.lWrist);
    out.arms.right = limb(P.rShoulder, P.rElbow, P.rWrist);
  }

  /** Stabiliser state for diagnostics (state.json `bodyStab`). */
  stabInfo() {
    const g = (s: StabGroup) => ({ moving: s.moving, m: +s.m.toFixed(2), score: +s.score.toFixed(2), stillFor: +s.stillFor.toFixed(1) });
    const G = this.geom, r3 = (x: number) => +x.toFixed(3);
    const J = (a: Anat) => { const j = this.joints[a]; return j ? { S: j.S.toArray().map(r3), E: j.E.toArray().map(r3), W: j.W.toArray().map(r3) } : null; };
    return {
      on: this.stabilize, torso: g(this.torsoStab), armL: g(this.armStab.l), armR: g(this.armStab.r), handL: g(this.handStab.left), handR: g(this.handStab.right),
      conf: { l: { e: r3(this.conf.l.e), w: r3(this.conf.l.w) }, r: { e: r3(this.conf.r.e), w: r3(this.conf.r.w) } },
      geom: { W: r3(G.W), Lu: r3(G.Lu), Lf: r3(G.Lf), Zs: r3(G.Zs) }, joints: { l: J('l'), r: J('r') },
    };
  }

  /** Finger/wrist One-Euro tuning (angle domain). Tuned offline against synthetic landmark noise. */
  handFilter = { cutoffScale: 0.5, beta: [1.6, 0.3] as [number, number], dCutoff: 0.6 };
  private lastOut: BodyTargets | null = null;
  private chirality: Record<Side, { flip: boolean; ev: number; n: number }> = { left: { flip: false, ev: 0, n: 0 }, right: { flip: false, ev: 0, n: 0 } };
  private lastMirror = false;
  private lastBodyId: number | undefined = undefined;
  /** Per-stream sample clocks (new-sample detection + result interval). Without stamps both follow bodyId / bodyT. */
  private poseClock = new SampleClock();
  private handsClock = new SampleClock();
  /** EMA of "the pose and hands stamps differ" over steps where both are stamped: > 0.5 = each stream from its own worker. */
  private pairSplit = 0;
  /** Hand wrists of the last hands sample (per anatomical side), for pose samples that arrive between hand samples. */
  private lastHandWrist: Record<Anat, HandWrist | null> = { l: null, r: null };
  /** Don't let confused pose wrists decide left / right when two hands are seen (poseWristsUnreliable).
   *  localStorage vtp.handGate = '0' switches it off (A/B). */
  assignGate = (() => { try { return localStorage.getItem('vtp.handGate') !== '0'; } catch { return true; } })();
  /** Interval EMAs of the two result streams (s; 0 = not known yet) — diagnostics. */
  get rates() { return { pose: this.poseClock.interval, hands: this.handsClock.interval }; }
  private lastArm: Record<Side, (ArmTarget & { t: number }) | null> = { left: null, right: null };
  private lastHand: Record<Side, (HandTarget & { t: number }) | null> = { left: null, right: null };
  private acquired: Record<Side, number> = { left: 0, right: 0 };
  /** Last image-space wrist per ANATOMICAL side (aspect-corrected), for frame-to-frame continuity. */
  private lastWrist: Record<Side, { x: number; y: number; t: number } | null> = { left: null, right: null };
  /** Consecutive two-hand samples the gate has fired on (the pose cue comes back after gateTune.maxGated of them). */
  private gatedRun = 0;
  /**
   * The left / right gate's limits (2026-10-04, tuned on offline replays; tools may vary them):
   *  - sameFrame: the most the pose and hands capture stamps may differ (s) for the gate to act. Pose and hands of one
   *    camera frame carry the same stamp, so this only absorbs rounding; one frame apart is 16.7 ms even at 60 fps.
   *  - dupPalms: two detections whose wrists are closer than this many palm sizes (the larger image palm) are one hand
   *    seen twice (or a false hand on a real one) and move no side's last wrist, unless they pass the tests for two hands
   *    held together (a clasp, see nearDuplicate): labels apart, both at least dupLabel; image palms within dupSize of
   *    each other; close on the dupRepeat hands results before too. Even then a side's last wrist only moves to a hand
   *    within dupStep of the smaller palm of it (one hand's step), to a hand nearer it than the other side's last wrist,
   *    or with the pair (see assignSides), so a copy taken for a second hand can't carry the absent hand's side over to
   *    the hand it copies. dupRepeat = 0 with dupStep = Infinity is the first b10 repair (d083783).
   *  - maxGated: after this many consecutive gated two-hand samples the pose cue is added back until the gate clears (the
   *    full pre-gate rule: pose + continuity + labels). 30 = 1 s at 30 Hz, 2 s at 15 Hz: longer than every gated run in
   *    the offline crossings (at most 25 samples), so a crossing that is held longer falls back to the old rule.
   */
  gateTune = { sameFrame: 0.005, dupPalms: 0.6, dupLabel: 0.6, dupSize: 1.4, dupRepeat: 1, dupStep: 1, maxGated: 30 };
  /** Hands results in a row whose two wrists were within gateTune.dupPalms (see nearDuplicate): how many, the last one's
   * time and the smaller image palm of its pair. */
  private closeRun = { n: 0, t: -Infinity, palm: 0 };

  /**
   * Which anatomical hand each detection is. Combines (1) distance to the pose model's wrists — the most
   * reliable cue when the body is tracked, (2) continuity with last frame's hands, (3) MediaPipe's
   * handedness label. With two hands the best joint assignment wins, so both can never claim one side.
   * While BOTH hands are being followed (each side assigned within the last 0.35 s, so (2) is live for both) and the
   * pose wrists are confused (poseWristsUnreliable: crossed arms, clasped hands), only (2) + (3) decide: continuity
   * carries the hands through. A fresh two-hand acquisition always keeps (1): there the labels would decide alone and
   * continuity would then hold any mistake (2026-10-04 review: on near footage, where MediaPipe's pose wrist sits ~0.1
   * frame-heights off the hand wrist, dropping (1) there took re-entries from 1288 to 3434 wrong-hand frames).
   * Three limits keep continuity from holding a mistake (2026-10-04 review 3): the gate acts only when the pose and the
   * hands come from one camera frame (oneFrame, see gateTune.sameFrame), a hand seen twice moves no last wrist
   * (nearDuplicate; clasped hands still do), and the pose cue counts again after gateTune.maxGated gated samples in a row.
   */
  private assignSides(hands: HandsResult, norm: NormalizedLandmark[] | undefined, aspect: number, t: number, oneFrame = true): (Side | null)[] {
    const n = Math.min(hands.landmarks.length, 2);
    const followed = (s: Side) => { const lw = this.lastWrist[s]; return !!lw && t - lw.t < 0.35; };
    let pn = norm;
    if (followed('left') && followed('right') && this.poseWristsUnreliable(hands, norm, aspect, oneFrame)) {
      // continuity alone must not carry a mistake on for ever: after maxGated gated samples in a row the pose cue counts
      // again (added to continuity + labels, so a confused pose can't take over on its own) until the gate clears
      if (this.gatedRun < this.gateTune.maxGated) pn = undefined;
      this.gatedRun++;
    } else this.gatedRun = 0;
    // one hand reported twice (or a small false hand on a real one) moves neither side's last wrist: continuity would
    // otherwise carry the copy's side on as the other hand (2026-10-04 review, s1_off frame 620). Two hands held together
    // (a clasp) are not one hand seen twice: see nearDuplicate (which counts close pairs in a row: a result without two
    // hands ends the run). Even they move a side's last wrist by one hand's step (gateTune.dupStep) at most, unless it
    // moves toward its own last wrist or with the pair: a copy that passes for a second hand then can't move the absent
    // hand's side onto the hand it copies (b10 repair 2)
    if (n !== 2) this.closeRun.n = 0;
    const dup = n === 2 && this.assignGate && this.nearDuplicate(hands, aspect, t);
    const step = n === 2 && this.assignGate && this.closeRun.n > 0 ? this.gateTune.dupStep * this.closeRun.palm : Infinity;
    const cost: Record<Side, number>[] = [];
    for (let h = 0; h < n; h++) {
      const w = hands.landmarks[h][0];
      const c: Record<Side, number> = { left: 0, right: 0 };
      for (const s of ['left', 'right'] as Side[]) {
        if (pn && pn.length > 16) {
          const pw = pn[s === 'left' ? P.lWrist : P.rWrist];
          const vis = Math.min(1, Math.max(0.3, pw.visibility ?? 1));
          c[s] += (Math.hypot((pw.x - w.x) * aspect, pw.y - w.y) / 0.12) * vis;
        }
        const lw = this.lastWrist[s];
        if (lw && t - lw.t < 0.35) c[s] += (Math.hypot(lw.x - w.x * aspect, lw.y - w.y) / 0.1) * 0.8;
        // MediaPipe's handedness label assumes a mirrored (selfie) image; our input is not mirrored
        const cat = hands.handedness?.[h]?.[0];
        if (cat) {
          const labelSide: Side = cat.categoryName === 'Left' ? 'right' : 'left';
          if (labelSide !== s) c[s] += 1.2 * clamp01((cat.score - 0.5) * 2);
        }
      }
      cost.push(c);
    }
    let res: (Side | null)[];
    if (n === 1) res = [cost[0].left <= cost[0].right ? 'left' : 'right'];
    else res = cost[0].left + cost[1].right <= cost[0].right + cost[1].left ? ['left', 'right'] : ['right', 'left'];
    const prev = { ...this.lastWrist };
    if (!dup) for (let h = 0; h < n; h++) {
      const s = res[h];
      if (!s) continue;
      const x = hands.landmarks[h][0].x * aspect, y = hands.landmarks[h][0].y, lw = prev[s], o = prev[s === 'left' ? 'right' : 'left'];
      if (lw && step < Infinity) {
        // a longer move only to a hand nearer this side's last wrist than the other side's (hands that came together
        // within one result) or with the pair (the wrist-to-wrist vector kept its direction and changed by less than a
        // step: clasped hands moving together, not swapped); never onto the other side's last wrist
        const d = Math.hypot(lw.x - x, lw.y - y), q = hands.landmarks[1 - h][0], rx = x - q.x * aspect, ry = y - q.y;
        const own = !!o && d < Math.hypot(o.x - x, o.y - y);
        const together = !!o && rx * (lw.x - o.x) + ry * (lw.y - o.y) > 0 && Math.hypot(rx - (lw.x - o.x), ry - (lw.y - o.y)) < step;
        if (d >= step && !own && !together) continue;
      }
      this.lastWrist[s] = { x, y, t };
    }
    return res;
  }

  /**
   * Two detections whose wrists are closer than gateTune.dupPalms of the larger image palm (mean wrist → knuckle /
   * knuckle-span length). Offline (9 result files, 4,530 two-hand results): two real hands never came closer than 1.15
   * palms; the hand seen twice came at 0.27-0.46 palms (one tiny false copy at 0.92). A fixed distance does not work:
   * the copies were 0.022-0.065 frame heights apart (near and far footage), and their sizes differed by 1.1-2.1x (s1_off
   * frame 620: 0.043 apart, 1.6x), so a "similar size" test alone would miss them.
   * Two real hands held together (a clasp, prayer hands, a held clap) come that close too, and must keep moving the last
   * wrists (b10: freezing them for a whole clasp let continuity lapse after 0.35 s and a confused pose swap the sides).
   * They are two hands when MediaPipe labels them apart, both at gateTune.dupLabel or more, their image palms are within
   * gateTune.dupSize of each other, and the pair was close on the gateTune.dupRepeat hands results before too: the first
   * result of a close pair is always one hand seen twice. Labels and sizes alone are not enough: at main_s1_off_640 /
   * main_hp_full frame 432 the right hand was seen twice 0.13 palms apart at 1.13x, labelled Right 0.959 and Left 0.978.
   * Offline (every timed recorded run: 19 of the 23 result files, 15,138 two-hand results, MediaPipe's own labels; many
   * replay the same footage, so 5 distinct moments) there were 17 close pairs, every one a hand seen twice and none
   * lasting past one result: the repeat test catches all 17, the label and size tests 14 (not frame 432). A copy that
   * lasts longer can pass all three; then assignSides still moves a side's last wrist by one hand's step at most
   * (gateTune.dupStep) unless toward its own last wrist or with the pair, and at 15 of the 17 the other side's last wrist
   * was 2.4-5.7 palms away (at the other 2, main_s1_off_det35 frame 433, both last wrists were already on that hand).
   * Without labels (handedness) a close pair stays one hand seen twice. Updates closeRun (gate on only).
   */
  private nearDuplicate(hands: HandsResult, aspect: number, t: number): boolean {
    const a = hands.landmarks[0], b = hands.landmarks[1];
    if (!a || !b || a.length < 21 || b.length < 21) { this.closeRun.n = 0; return false; }
    const palm = (L: NormalizedLandmark[]) => {
      let s = 0;
      for (const [i, j] of PALM) s += Math.hypot((L[i].x - L[j].x) * aspect, L[i].y - L[j].y);
      return s / PALM.length;
    };
    const pa = palm(a), pb = palm(b), big = Math.max(pa, pb), g = this.gateTune;
    const d = Math.hypot((a[0].x - b[0].x) * aspect, a[0].y - b[0].y);
    if (d >= g.dupPalms * big) { this.closeRun.n = 0; return false; }
    this.closeRun = { n: t - this.closeRun.t < 0.35 ? this.closeRun.n + 1 : 1, t, palm: Math.min(pa, pb) };
    const ca = hands.handedness?.[0]?.[0], cb = hands.handedness?.[1]?.[0];
    const apart = !!ca && !!cb && ca.categoryName !== cb.categoryName && Math.min(ca.score, cb.score) >= g.dupLabel;
    return !(apart && big <= g.dupSize * Math.min(pa, pb) && this.closeRun.n > g.dupRepeat);
  }

  /**
   * Two hands seen, but the pose model's wrists can't say which is which: a pose wrist is more than 0.1 frame-heights
   * from both hands (Pose swapped or lost it — crossed arms), or the two pose wrists are within 0.1 of each other
   * (claps, hands together). It also fires on near footage (the pose wrist sits ~0.1 off a big hand's wrist), so
   * assignSides acts on it only while both hands are followed, and solveUpper only relaxes its hand-vs-pose-wrist check.
   * Offline (2026-10-04, synthetic avatar footage only, no real-camera check yet; A/B: vtp.handGate = '0'): wrong sides
   * in the 15 Hz crossed-arms segment 78/103 → 0/103 on whole-clip replays (the hands were followed into the crossing),
   * with the footage's own MediaPipe labels; with labels made right both are 0/103. Two-hand re-entries (a fresh solver
   * every 3rd two-hand result, 6 runs, 1.5 s): 1288 → 1240 wrong-hand frames with the footage's labels, 418 → 430 with
   * right labels and a swapped first result, 314 → 314 with right labels.
   * oneFrame = false (pose and hands stamped from different camera frames: hands in their own worker): never fires. The
   * test compares two images; one frame of hand motion trips it, and on a one-frame-old pose it fired on 254 of 290
   * two-hand samples of s1_off and held a swap for 0.8 s (review 3, 9 runs: 139 wrong sides with the gate, 32 without).
   */
  private poseWristsUnreliable(hands: HandsResult | null, norm: NormalizedLandmark[] | undefined, aspect: number, oneFrame = true): boolean {
    if (!this.assignGate || !oneFrame || !norm || norm.length <= 16 || !hands?.landmarks || hands.landmarks.length < 2) return false;
    const h0 = hands.landmarks[0][0], h1 = hands.landmarks[1][0], lw = norm[P.lWrist], rw = norm[P.rWrist];
    if (!h0 || !h1 || !lw || !rw) return false;
    const d = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    return Math.min(d(lw, h0), d(lw, h1)) > 0.1 || Math.min(d(rw, h0), d(rw, h1)) > 0.1 || d(lw, rw) < 0.1;
  }

  /**
   * 21 hand world landmarks (metres, MediaPipe camera axes) → hand basis + joint angles, measured in the
   * hand's own frame so they're independent of how the wrist is turned:
   *  - fingers: signed flexion per joint (MCP/PIP/DIP, + = toward the palm, − = hyperextension) in the
   *    finger's bending plane, and MCP abduction (spread) in the palm plane;
   *  - thumb: metacarpal direction in hand coordinates (it's a 2-DOF joint) + MCP / IP flexion.
   * Angles are One-Euro filtered (adaptive: steady at rest, low lag when fingers move fast), then
   * rest-stabilised as one group (a still hand is locked; any finger moving releases it).
   */
  private solveHand(lm: Landmark[], side: Side, t: number, mirror: boolean, smoothing: number): Omit<HandTarget, 'confidence'> | null {
    if (lm.length < 21) return null;
    const sx = mirror ? -1 : 1;
    const sz = this.chirality[side].flip ? 1 : -1;
    // avatar space; after the mirror flip the geometry is always a `side` hand (the avatar's side)
    const p = lm.map((q) => new THREE.Vector3(sx * q.x, -q.y, sz * q.z));
    const F = p[9].clone().sub(p[0]);
    const len = F.length();
    if (len < 0.03 || len > 0.25) return null; // not a plausible hand (metres)
    F.divideScalar(len);
    const S = p[5].clone().sub(p[17]);
    S.addScaledVector(F, -S.dot(F));
    if (S.lengthSq() < 1e-8) return null;
    S.normalize();
    const N = F.clone().cross(S);
    // volar (palm-out) normal: F×S for a left hand, −F×S for a right hand
    const V = side === 'left' ? N.clone() : N.clone().negate();
    const dir = (a: number, b: number) => p[b].clone().sub(p[a]).normalize();
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    const curls: number[][] = [];
    const spread: number[] = [0];
    for (let fi = 1; fi < 5; fi++) {
      const m = fi * 4 + 1; // MCP landmark: 5, 9, 13, 17
      const md = dir(0, m), d1 = dir(m, m + 1), d2 = dir(m + 1, m + 2), d3 = dir(m + 2, m + 3);
      // metacarpal direction in the palm plane, and the in-plane lateral direction (toward the thumb side)
      const mdp = md.clone().addScaledVector(V, -md.dot(V)).normalize();
      const L = S.clone().addScaledVector(mdp, -S.dot(mdp)).normalize();
      const d1p = d1.clone().addScaledVector(V, -d1.dot(V));
      // spread is only observable while the finger is fairly straight; fades out as it curls
      const w = Math.min(1, d1p.lengthSq() * 1.2);
      const abd = THREE.MathUtils.clamp(Math.atan2(d1p.dot(L), d1p.dot(mdp)), -0.6, 0.6) * w;
      const b = mdp.clone().multiplyScalar(Math.cos(abd)).addScaledVector(L, Math.sin(abd));
      // angle of a segment in the finger's bending plane (b, V); joint flexion = difference of neighbours
      const phi = (v: THREE.Vector3) => Math.atan2(v.dot(V), v.dot(b));
      const f0 = phi(md), f1 = phi(d1), f2 = phi(d2), f3 = phi(d3);
      const pip = wrap(f2 - f1);
      // DIP sits on the two shortest (noisiest) segments; anatomically it tracks ~0.75× the PIP, so
      // lean on that coupling half-way
      curls.push([wrap(f1 - f0), pip, 0.5 * wrap(f3 - f2) + 0.5 * 0.75 * pip]);
      spread.push(abd);
    }
    // thumb: flexion toward the palm centre (its bending plane isn't the fingers')
    const C = p[0].clone().add(p[5]).add(p[9]).add(p[13]).add(p[17]).multiplyScalar(0.2);
    const t1 = dir(1, 2), t2 = dir(2, 3), t3 = dir(3, 4);
    const toward = (from: THREE.Vector3, seg: THREE.Vector3) => {
      const c = C.clone().sub(from);
      c.addScaledVector(seg, -c.dot(seg));
      return c.lengthSq() > 1e-10 ? c.normalize() : V.clone();
    };
    // chirality self-check: PIP joints can't bend backwards, so if they consistently read as strongly
    // hyperextended the landmark depth axis is flipped relative to what we assume — correct it
    const pipMean = (curls[0][1] + curls[1][1] + curls[2][1] + curls[3][1]) / 4;
    const ch = this.chirality[side];
    if (Math.abs(pipMean) > 0.15) {
      ch.ev += (pipMean - ch.ev) * 0.05; ch.n++;
      if (ch.n > 20 && ch.ev < -0.2) { ch.flip = !ch.flip; ch.ev = 0; ch.n = 0; console.warn('[hands] landmark chirality looked mirrored; flipped depth axis'); }
    }
    const c1 = toward(p[2], t1), c2 = toward(p[3], t2);
    curls.unshift([0, Math.atan2(t2.dot(c1), t2.dot(t1)), Math.atan2(t3.dot(c2), t3.dot(t2))]);
    const thumb = new THREE.Vector3(t1.dot(F), t1.dot(S), t1.dot(N));

    // ---- adaptive filtering (angle domain: rad, rad/s) ----
    const bank = this.hf[side];
    const { minCutoff } = smoothingToOneEuro(smoothing);
    const ft = this.handFilter;
    bank.minCutoff = minCutoff * ft.cutoffScale;
    bank.beta = THREE.MathUtils.lerp(ft.beta[0], ft.beta[1], clamp01(smoothing));
    bank.dCutoff = ft.dCutoff;
    const fl = (k: string, v: number) => bank.filter(k, v, t);
    let fc = curls.map((row, fi) => row.map((a, j) => fl(`c${fi}${j}`, a)));
    let fs = spread.map((a, fi) => fl(`s${fi}`, a));
    const fv = (k: string, v: THREE.Vector3) => new THREE.Vector3(fl(`${k}x`, v.x), fl(`${k}y`, v.y), fl(`${k}z`, v.z));
    let thumbDir = fv('t', thumb).normalize();
    // wrist orientation: filter the basis a little harder at rest (it's what the viewer notices most)
    let forward = fv('F', F).normalize();
    let sideV = fv('S', S);
    if (this.stabilize) {
      const z = [...fc.flat(), fs[1], fs[2], fs[3], fs[4], thumbDir.x, thumbDir.y, thumbDir.z, forward.x, forward.y, forward.z, sideV.x, sideV.y, sideV.z];
      const o = this.handStab[side].step(z, t, 0);
      fc = [0, 1, 2, 3, 4].map((fi) => [o[fi * 3], o[fi * 3 + 1], o[fi * 3 + 2]]);
      fs = [0, o[15], o[16], o[17], o[18]];
      thumbDir = new THREE.Vector3(o[19], o[20], o[21]).normalize();
      forward = new THREE.Vector3(o[22], o[23], o[24]).normalize();
      sideV = new THREE.Vector3(o[25], o[26], o[27]);
    }
    sideV.addScaledVector(forward, -sideV.dot(forward)).normalize();
    return { forward, side: sideV, curls: fc, spread: fs, thumbDir };
  }
}

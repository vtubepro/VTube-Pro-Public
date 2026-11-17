// "In front" arm pose (profile.tracking.armPose = 'front', shared/armPose.ts): the forearms forward, the hands together or
// resting in front of the body, as at a desk. Pure math, no scene: src/avatar/retarget.ts applies it; tools/arm_pose_unit.ts
// tests it on thin, average and wide skeletons.
//
// Everything is measured from the avatar's own skeleton (the rest bone positions, avatar space: +Y up, +Z front, +X left):
// the arm lengths, the hand length, the shoulder span and the hip width. The body is the same elliptical prism the "Keep
// hands out of the body" guard uses (src/avatar/bodyGuard.ts: torsoFromBones / bodyRadius / pushOut / solveElbow), widened to
// the hips and scaled by the avatar's Body depth setting. A pose is solved once per (style, depth) and cached:
//   1. forward kinematics from the avatar's own bone lengths: the upper arm swings forward (alpha) and a little out (beta),
//      the forearm points forward (pitched by gamma) and turns inward so each wrist lands a style-dependent gap from the
//      midline; the hand straightens toward forward a little (the wrist bends) so the two hands lie side by side;
//   2. samples along the upper arm, the forearm and the hand are checked against the body (with a clearance); a sample
//      inside swings the arm further forward / out, and the check runs again until nothing is inside;
//   3. the two hands are kept apart by their own thickness (the closest approach of the wrist-to-fingertip segments), so
//      hands meet but never pass through each other.
// Per frame only the cheap part runs: tiny breathing sway and drift on the wrist targets, a little follow of the torso's
// lean, and one two-bone IK per arm (elbow on the side the cached pose put it).
import * as THREE from 'three';
import type { Side } from '../tracking/bodySolver.ts';
import { bodyRadius, heightWeight, pushOut, solveElbow, torsoFromBones, type TorsoShape } from './bodyGuard.ts';
import type { ArmFrontStyle } from '../../shared/armPose.ts';
import { surfaceAt, type TorsoSurface } from './torsoSurface.ts';

type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const SIDES: Side[] = ['left', 'right'];
const sgnOf = (s: Side) => (s === 'left' ? 1 : -1);

/** The solved body is this much bigger than the measured one: the hands stay this far off it (5 %). */
export const FRONT_CLEARANCE = 1.05;
/** The hands carry this share of the torso's lean (the rest of it they hold their place, like hands resting on a desk). */
export const FRONT_FOLLOW = 0.6;

interface StyleSpec {
  /** wrist distance from the midline, in hand lengths (desk: in half shoulder spans) */
  half: number; deskSpan?: boolean;
  /** closest the wrist may come to the midline, in hand lengths */
  minHalf: number;
  /** closest the two hands (wrist to fingertip) may come to each other, in hand lengths (their thickness / width) */
  sep: number;
  /** upper arm swing forward from hanging straight down, out from the body (degrees); forearm pitch above horizontal (degrees) */
  alpha: number; beta: number; gamma: number;
  /** how far the hand straightens toward "forward" from the forearm's line (0..1; the wrist bends inward-to-straight) */
  aim: number;
  /** the pitch (degrees above horizontal) the hand lies at when it straightens: negative = the wrist bends down, fingers point down-forward */
  hpitch: number;
  /** which way the palm faces, left hand, torso frame (x < 0 = toward the midline); the right hand mirrors it */
  palm: [number, number, number];
  /** relaxed finger curl per finger [MCP, PIP, DIP] (thumb: unused, MCP, IP), radians */
  curl: number[][];
}

const CURL_RELAXED = [[0, 0.15, 0.2], [0.2, 0.3, 0.2], [0.25, 0.38, 0.22], [0.3, 0.42, 0.25], [0.36, 0.45, 0.28]];
const CURL_CLASP = [[0, 0.4, 0.35], [0.55, 0.8, 0.45], [0.6, 0.85, 0.5], [0.65, 0.85, 0.5], [0.7, 0.85, 0.5]];
const CURL_DESK = [[0, 0.1, 0.15], [0.18, 0.2, 0.14], [0.2, 0.24, 0.15], [0.23, 0.27, 0.16], [0.26, 0.3, 0.18]];
const CURL_GRIP = [[0, 0.45, 0.5], [0.8, 0.95, 0.6], [0.85, 1.0, 0.62], [0.9, 1.0, 0.62], [0.95, 0.95, 0.6]];

export const FRONT_STYLES: Record<ArmFrontStyle, StyleSpec> = {
  // Measured pose targets (asserted in tools/arm_pose_unit.ts): the upper arm hangs close to the body (<= 25 degrees from
  // vertical, slightly out), the elbow bends 70-110 degrees, the forearm points forward and in, the wrists are 6-21 cm
  // (0.12-0.42 arm lengths) in front of the body, at belly / lower-chest height. Desk: lower, further out (0.4-0.56 arm
  // lengths), forearms near level. Controller: lower chest, tucked elbows, neutral wrists.
  together: { half: 0.34, minHalf: 0.24, sep: 0.4, alpha: 12, beta: 6, gamma: 14, aim: 0.7, hpitch: -12, palm: [-0.85, 0.5, 0], curl: CURL_RELAXED },
  clasped: { half: 0.14, minHalf: 0.1, sep: 0.2, alpha: 10, beta: 3, gamma: 16, aim: 0.75, hpitch: -10, palm: [-1, 0.12, 0], curl: CURL_CLASP },
  desk: { half: 0.8, deskSpan: true, minHalf: 0.3, sep: 0.5, alpha: 8, beta: 10, gamma: 0, aim: 0.7, hpitch: -2, palm: [0, -1, 0], curl: CURL_DESK },
  controller: { half: 0.45, minHalf: 0.3, sep: 0.4, alpha: 6, beta: 5, gamma: 20, aim: 0.6, hpitch: 0, palm: [-0.7, 0.6, 0], curl: CURL_GRIP },
};

export interface FrontRig {
  /** upper-arm roots, rest, avatar space */
  shoulder: Record<Side, V3>;
  upper: Record<Side, number>; fore: Record<Side, number>;
  /** wrist to fingertip, m */
  hand: number;
  hips: V3;
  /** half the hip width (distance between the upper-leg roots / 2), 0 = unknown */
  hipHalf: number;
  /** the torso's real surface measured from the mesh at load (src/avatar/torsoSurface.ts); unset = the skeleton's prism */
  surface?: TorsoSurface | null;
}

/** The solved wrists / elbows of one arm (torso frame). */
export interface FrontSide { du: V3; dl: V3; elbow: V3; wrist: V3; /** fingertip */ tip: V3; /** hand direction (wrist to fingertip) */ dh: V3; target: V3; pole: V3 }
export interface FrontSolution {
  left: FrontSide; right: FrontSide;
  /** the body the pose was solved against (measured, not inflated): the skeleton's prism */
  shape: TorsoShape;
  /** the body at a height (not inflated): the mesh's real surface when the avatar has one, else the prism */
  at: (y: number, x?: number) => TorsoShape;
  /** solved against the measured mesh surface */
  measured: boolean;
  /** the upper arm's final swing forward / out (radians), for diagnostics */
  alpha: number; beta: number;
  /** wrist distance from the midline, m */
  halfGap: number;
  /** checks passed (nothing inside the body, hands apart) within the iteration budget */
  clean: boolean;
  iterations: number;
}

/** Closest distance between segments p1-q1 and p2-q2. */
export function segmentDistance(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) return p1.distanceTo(p2);
  if (a <= EPS) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= EPS) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > EPS ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

/** Points along an arm worth checking against the body: upper arm (not the shoulder end), elbow, forearm, hand. `upper` are the first three. */
export function armSamples(S: V3, E: V3, W: V3, tip: V3, dense = false): { p: V3; upper: boolean }[] {
  const out: { p: V3; upper: boolean }[] = [];
  const along = (a: V3, b: V3, ts: number[], upper: boolean) => { for (const t of ts) out.push({ p: a.clone().lerp(b, t), upper }); };
  along(S, E, dense ? [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] : [0.5, 0.8, 1], true);
  along(E, W, dense ? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] : [0.1, 0.25, 0.5, 0.75, 1], false);
  along(W, tip, dense ? [0.2, 0.4, 0.6, 0.8, 1] : [0.5, 1], false);
  return out;
}

export class FrontPose {
  private cache = new Map<string, FrontSolution | null>();
  constructor(readonly rig: FrontRig) {}

  /** From rest positions (avatar space) by humanoid bone name. null without hips or two full arms. */
  static fromRest(pos: (bone: string) => V3 | undefined): FrontPose | null {
    const shoulder = {} as Record<Side, V3>, upper = {} as Record<Side, number>, fore = {} as Record<Side, number>;
    const hands: number[] = [];
    for (const s of SIDES) {
      const u = pos(`${s}UpperArm`), l = pos(`${s}LowerArm`), hd = pos(`${s}Hand`);
      if (!u || !l || !hd) return null;
      shoulder[s] = u.clone(); upper[s] = u.distanceTo(l); fore[s] = l.distanceTo(hd);
      if (!(upper[s] > 1e-3 && fore[s] > 1e-3)) return null;
      // hand length: wrist to the distal joint of the middle finger is ~82 % of wrist-to-tip; else a typical hand/forearm ratio
      const dist = pos(`${s}MiddleDistal`);
      const est = dist && dist.distanceToSquared(hd) > 1e-8 ? hd.distanceTo(dist) * 1.22 : fore[s] * 0.72;
      hands.push(THREE.MathUtils.clamp(est, fore[s] * 0.45, fore[s] * 0.95));
    }
    const hips = pos('hips');
    if (!hips) return null;
    const ll = pos('leftUpperLeg'), rl = pos('rightUpperLeg');
    const rig: FrontRig = { shoulder, upper, fore, hand: (hands[0] + hands[1]) / 2, hips: hips.clone(), hipHalf: ll && rl ? Math.abs(ll.x - rl.x) / 2 : 0 };
    return bodyShapeOf(rig, 1) ? new FrontPose(rig) : null;
  }

  /** The torso's real surface measured from the mesh (null = go back to the skeleton's prism). The cached poses are dropped. */
  setSurface(s: TorsoSurface | null) { this.rig.surface = s; this.cache.clear(); }

  /** The measured body for a Body depth (1..2); null when the skeleton has none. */
  shape(depth: number): TorsoShape | null { return bodyShapeOf(this.rig, depth); }

  /** The solved pose for a style (cached per style and Body depth). null: no usable body. */
  solution(style: ArmFrontStyle, depth: number): FrontSolution | null {
    const d = Math.round(THREE.MathUtils.clamp(Number.isFinite(depth) ? depth : 1, 1, 2) * 100) / 100;
    const key = `${style}:${d}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    if (this.cache.size > 24) this.cache.clear();
    const sol = solveFront(this.rig, style, d);
    this.cache.set(key, sol);
    return sol;
  }

  /**
   * The arm directions for one frame, torso frame (avatar axes): the cached pose with the life offsets on the wrist targets
   * and the lean residual `res` (a rotation about the shoulder midpoint: the hands keep this much of their place while the torso
   * leans, see FRONT_FOLLOW). `now` seconds; `life` 0..1 scales the sway.
   */
  pose(sol: FrontSolution, now: number, res: THREE.Quaternion | null, life = 1): Record<Side, { du: V3; dl: V3; wrist: V3; dh: V3 }> {
    const rig = this.rig, mid = shoulderMid(rig);
    const out = {} as Record<Side, { du: V3; dl: V3; wrist: V3; dh: V3 }>;
    const scale = (rig.upper.left + rig.fore.left + rig.upper.right + rig.fore.right) / 4 / 0.25;
    for (const s of SIDES) {
      const b = sol[s], S = rig.shoulder[s];
      const target = b.target.clone(), pole = b.pole.clone();
      if (res) { target.sub(mid).applyQuaternion(res).add(mid); pole.sub(mid).applyQuaternion(res).add(mid); }
      if (life > 0) target.add(lifeOffset(now, s, scale * life));
      const ik = solveElbow(S, target, rig.upper[s], rig.fore[s], pole);
      const dl = ik.wrist.clone().sub(ik.elbow).normalize();
      // the hand keeps the cached bend away from the forearm's line (rotated with the forearm's change)
      const dh = b.dh.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(b.dl, dl));
      out[s] = { du: ik.elbow.clone().sub(S).normalize(), dl, wrist: ik.wrist, dh };
    }
    return out;
  }
}

function shoulderMid(rig: FrontRig): V3 { return rig.shoulder.left.clone().add(rig.shoulder.right).multiplyScalar(0.5); }

/** The body the pose is solved against: the guard's prism, widened to the hips. */
export function bodyShapeOf(rig: FrontRig, depth: number): TorsoShape | null {
  const s = torsoFromBones({ hips: rig.hips, leftUpperArm: rig.shoulder.left, rightUpperArm: rig.shoulder.right }, depth);
  if (!s) return null;
  // wide hips (a pear, a belly): the belly is at least as wide as the hips, but never so wide that the shoulder joints are inside it
  if (rig.hipHalf > 0) s.halfW = Math.max(s.halfW, Math.min(rig.hipHalf * 1.05, Math.abs(rig.shoulder.left.x - rig.shoulder.right.x) * 0.45));
  return s;
}

/** Tiny breathing sway + slow drift of a wrist (m), in the torso frame. `scale` ~ 1 for a 0.5 m arm. */
export function lifeOffset(now: number, side: Side, scale: number, out: V3 = new THREE.Vector3()): V3 {
  const ph = side === 'left' ? 0 : 1.7;
  const breath = Math.sin(now * 1.6); // the same rate as the spine's breathing (retarget.ts)
  return out.set(
    Math.sin(now * 0.31 + ph) * 0.003 * scale,
    breath * 0.0035 * scale + Math.sin(now * 0.47 + ph * 2) * 0.002 * scale,
    Math.sin(now * 0.41 + ph * 3) * 0.003 * scale + breath * 0.0015 * scale,
  );
}

/** Tiny finger idle (rad) for finger `fi`, joint `j`: a slow, different drift per finger. `amp` ~ 0.05. */
export function fingerIdle(now: number, side: Side, fi: number, j: number, amp = 0.05): number {
  const ph = (side === 'left' ? 0 : 2.1) + fi * 1.3 + j * 0.6;
  return amp * (Math.sin(now * (0.7 + fi * 0.13) + ph) * 0.6 + Math.sin(now * 0.31 + ph * 1.7) * 0.4);
}

/** The desired palm direction (torso frame) of a side. */
export function palmDirection(style: ArmFrontStyle, side: Side): V3 {
  const p = FRONT_STYLES[style].palm;
  return V(p[0] * sgnOf(side), p[1], p[2]).normalize();
}

/** The resting finger curl of a style [finger][MCP, PIP, DIP]. */
export function frontCurl(style: ArmFrontStyle): number[][] { return FRONT_STYLES[style].curl; }

function solveFront(rig: FrontRig, style: ArmFrontStyle, depth: number): FrontSolution | null {
  const real = bodyShapeOf(rig, depth);
  if (!real) return null;
  const shape: TorsoShape = { ...real, halfW: real.halfW * FRONT_CLEARANCE, front: real.front * FRONT_CLEARANCE, back: real.back * FRONT_CLEARANCE };
  // The measured mesh surface (src/avatar/torsoSurface.ts), when the avatar has one: the body at a height, with the clearance
  // (5 % and 1.5 cm per half metre of arm). Body depth still scales how far it reaches out in front.
  const armL = (rig.upper.left + rig.fore.left + rig.upper.right + rig.fore.right) / 2;
  const surf = rig.surface ?? null;
  const dMul = THREE.MathUtils.clamp(Number.isFinite(depth) ? depth : 1, 1, 2);
  const mid = shoulderMid(rig);
  // The ellipse the pose code works with, made to pass through the measured surface at this height and sideways offset (a flat
  // chest or a boxy barrel belly is not an ellipse: the front and back are measured per lateral band).
  const meshShape = (y: number, x: number, clear: boolean, forearm = true): TorsoShape => {
    const m = surfaceAt(surf!, y - rig.hips.y, x - mid.x);
    const c = clear ? FRONT_CLEARANCE : 1, e = clear ? 0.015 * (armL / 0.5) + (forearm ? Math.max(0.22 * rig.hand, Math.min(surf!.armRadius, 0.18 * armL)) : 0) : 0;
    const zc = rig.hips.z + (m.front + m.back) / 2, half = Math.max(0.02, (m.front - m.back) / 2);
    const halfW = Math.max(0.02, m.halfW) * c + e * 0.7;
    const q = Math.min(0.97, Math.abs(x - mid.x) / halfW), k = 1 / Math.sqrt(1 - q * q);
    return { cx: mid.x, cz: zc, halfW, front: (half * dMul * c + e) * k, back: (half * c + e) * k, y0: real.y0, y1: real.y1, band: real.band };
  };
  const shapeAt = (y: number, x: number): TorsoShape => (surf ? meshShape(y, x, true) : shape);
  const spec = FRONT_STYLES[style];
  const hl = rig.hand, rad = Math.PI / 180;
  const halfSpan = Math.abs(rig.shoulder.left.x - rig.shoulder.right.x) / 2;
  let halfGap = Math.max(spec.deskSpan ? spec.half * halfSpan : spec.half * hl, spec.minHalf * hl);
  let alpha = spec.alpha * rad, beta = spec.beta * rad;
  const gamma = spec.gamma * rad, cg = Math.cos(gamma), sgm = Math.sin(gamma);
  const minSep = spec.sep * hl;
  let yawLimited = false;
  const hp = spec.hpitch * rad;
  const aimDir = V(0, Math.sin(hp), Math.cos(hp)).normalize(); // the hand lies straight forward at its own pitch
  const build = (side: Side): FrontSide => {
    const sg = sgnOf(side), S = rig.shoulder[side], u = rig.upper[side], f = rig.fore[side];
    // upper arm: down, swung forward by alpha and out by beta
    const dU = V(sg * Math.sin(beta), -Math.cos(alpha) * Math.cos(beta), Math.sin(alpha) * Math.cos(beta)).normalize();
    const E = S.clone().addScaledVector(dU, u);
    // forearm: forward (pitched by gamma), turned inward so the wrist lands halfGap from the midline
    const rawD = (sg * (E.x - mid.x) - halfGap) / (f * cg);
    const sinD = THREE.MathUtils.clamp(rawD, -0.9, 0.9);
    if (Math.abs(rawD) > 0.9) yawLimited = true; // the forearm can't turn in far enough from where the elbow is
    const cosD = Math.sqrt(1 - sinD * sinD);
    const dF = V(-sg * sinD * cg, sgm, cosD * cg).normalize();
    const W = E.clone().addScaledVector(dF, f);
    const dH = dF.clone().lerp(aimDir, spec.aim).normalize();
    return { du: dU, dl: dF, elbow: E, wrist: W, tip: W.clone().addScaledVector(dH, hl), dh: dH, target: W.clone(), pole: E.clone() };
  };
  let L = build('left'), R = build('right'), clean = false, it = 0;
  for (; it < 160; it++) {
    yawLimited = false;
    L = build('left'); R = build('right');
    let upperHit = false, needZ = 0, needOut = 0, hit = false;
    for (const [side, b] of [['left', L], ['right', R]] as [Side, FrontSide][]) {
      const sg = sgnOf(side);
      for (const { p, upper } of armSamples(rig.shoulder[side], b.elbow, b.wrist, b.tip)) {
        // (the upper arm may rest against the real surface: only the forearm and hand keep the clearance off a measured mesh)
        const sh = surf ? meshShape(p.y, p.x, true, !upper) : shape;
        if (heightWeight(sh, p.y) <= 0 || bodyRadius(sh, p.x, p.z) >= 1) continue;
        hit = true;
        if (upper) { upperHit = true; continue; }
        const need = pushOut(sh, p, 1).sub(p);
        needZ = Math.max(needZ, need.z);
        needOut = Math.max(needOut, need.x * sg);
      }
    }
    const sep = segmentDistance(L.wrist, L.tip, R.wrist, R.tip);
    const apart = sep >= minSep;
    if (!hit && apart && !yawLimited) { clean = true; break; }
    // a wide body: the elbows are too far out for the forearms to reach the middle, so the upper arms swing in across the front
    if (yawLimited && beta > -0.1) beta = Math.max(beta - 0.03, -0.1);
    else if (yawLimited && !hit) halfGap += 0.004;
    if (upperHit) beta = Math.min(beta + 0.05, 0.9);
    if (hit && !upperHit) {
      // a forearm or hand inside: swing the arm forward, and out when that is the way the body needs it
      // (on a measured mesh the arms swing no further than ~35 degrees: a body that is deeper than the arms are long gets the
      // hands round its flanks instead of the arms straight out in front)
      const swing = Math.max(needZ / Math.max(rig.upper.left, 1e-3) * 0.7, 0.01);
      const flank = surf ? Math.max(surf.halfW[Math.floor(surf.n / 2)], 0.02) * 1.0 : Infinity;
      if (surf && alpha >= 0.35 && halfGap < flank) halfGap += Math.max(needZ * 0.5, 0.006);
      else alpha = Math.min(alpha + swing, 1.4);
      halfGap += Math.max(needOut * 0.5, 0);
      if (alpha >= 1.4) halfGap += 0.006;
    }
    if (!apart) halfGap += (minSep - sep) / 2 + 0.001;
  }
  return { left: L, right: R, shape: real, at: (y: number, x = mid.x) => (surf ? meshShape(y, x, false) : real), halfGap, clean, iterations: it, measured: !!surf, alpha, beta };
}

// ---------------------------------------------------------------------------------------------------------------------
// Big gestures: when the camera clearly sees an arm raised or thrown out far from the "In front" pose, that arm takes over
// from the pose; when the gesture ends it eases back. Deliberately conservative, so a hand resting on your own desk (which
// the camera also sees) never drags the avatar's hands around: it takes a clearly seen arm, a wrist well away from the pose
// AND either clearly above it or moving fast (a wave, a throw), held for a moment. A hand at desk height off to the side (a
// mouse arm) is neither, and neither is a hand that has come to rest: it lets go when the arm is lost, drops or settles, after a pause.
// ---------------------------------------------------------------------------------------------------------------------
export const GESTURE_GATE = {
  /** how clearly the arm is seen (min of the upper arm / forearm confidence) */
  seen: 0.6,
  /** the tracked wrist this far (in arm lengths) from the pose wrist AND (at least `raised` above it OR moving at least `fast`
   *  arm lengths a second) starts a gesture ... */
  on: 0.55, raised: 0.2, fast: 1.2,
  /** ... which carries on while it stays `hold` from it and (`stayRaised` above it OR moving at half `fast`) */
  hold: 0.3, stayRaised: 0.1,
  /** seconds the start must hold (a raised arm: onDelay; fast motion has to go on for fastDelay, so reaching for the mouse, a
   *  quarter-second move, is not a wave) / the end must hold */
  onDelay: 0.12, fastDelay: 0.35, offDelay: 0.4,
  /** blend rates (1/s): onto the gesture / back to the pose */
  up: 7, down: 3,
};

export class GestureGate {
  /** 0 = the pose, 1 = fully the tracked arm */
  w = 0;
  active = false;
  private tOn = 0;
  private tFast = 0;
  private tOff = 0;
  /** conf: how clearly the arm is seen; dev: tracked wrist distance from the pose wrist, in arm lengths; lift: how far above it,
   *  in arm lengths; speed: how fast the tracked wrist moves, arm lengths a second (smoothed over ~0.1 s). */
  update(dt: number, conf: number, dev: number, lift: number, speed = 0): number {
    const G = GESTURE_GATE, d = Math.max(0, dt);
    const seen = conf >= G.seen;
    if (!this.active) {
      this.tOn = seen && dev >= G.on && lift >= G.raised ? this.tOn + d : 0;
      this.tFast = seen && dev >= G.on * 0.6 && speed >= G.fast ? this.tFast + d : Math.max(0, this.tFast - d); // (a wave swings through the pose now and then: the timer runs back, it does not reset)
      if (this.tOn >= G.onDelay || this.tFast >= G.fastDelay) { this.active = true; this.tOff = 0; }
    } else {
      this.tOff = seen && dev >= G.hold && (lift >= G.stayRaised || speed >= G.fast * 0.5) ? 0 : this.tOff + d;
      if (this.tOff >= G.offDelay) { this.active = false; this.tOn = 0; this.tFast = 0; }
    }
    const want = this.active ? 1 : 0;
    this.w += (want - this.w) * (1 - Math.exp(-(want > this.w ? G.up : G.down) * d));
    if (!this.active && this.w < 5e-3) this.w = 0;
    return this.w;
  }
  reset() { this.w = 0; this.active = false; this.tOn = 0; this.tFast = 0; this.tOff = 0; }
}

/** Ease `cur` toward `want` at `rate` (1/s), frame-rate independent. */
export function approach(cur: number, want: number, rate: number, dt: number): number {
  return cur + (want - cur) * (1 - Math.exp(-rate * Math.max(0, dt)));
}

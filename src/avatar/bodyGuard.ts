// Keep the hands and forearms out of the body (2026-10-03 request from a tester with a bulky armoured knight: "my hands
// go right through the torso whenever I touch my chest or bring my hands together in front of me"). Per avatar, off
// unless turned on: profile.tracking.bodyGuard, and bodyDepth (1..2) = how far the body reaches out in front.
//
// The body is an elliptical prism in the avatar's own frame (+Y up, +Z front, +X left), measured from the rest skeleton:
// its width from the shoulder span, its depth from the same (times bodyDepth in front), from the hips to the shoulders.
// Each frame, in the TORSO's frame (leaning and turning carry it along), the wrist and the middle of the forearm are eased
// out of it with a soft margin (never inside, no hard edge), the arm is solved again with two-bone IK (the elbow stays on
// its side), and the correction is smoothed (fast in, slower out) so nothing pops. Pure math: src/avatar/retarget.ts
// calls it; emotes, VRMA animations and seat poses run after the retarget and are never constrained.
import * as THREE from 'three';
import type { Side } from '../tracking/bodySolver.ts';

type V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;

export interface TorsoShape {
  /** centre of the cross-section (avatar space, metres) */
  cx: number; cz: number;
  /** half width (x), reach in front (+z) and behind (-z) of the centre */
  halfW: number; front: number; back: number;
  /** height: from the hips (y0) to the shoulders (y1); the push fades out over `band` past either end */
  y0: number; y1: number; band: number;
}
export interface TorsoBones { hips?: V3; leftUpperArm?: V3; rightUpperArm?: V3 }

/** Soft margin, in ellipse radii: the push starts this far outside the body and grows smoothly. */
export const GUARD_MARGIN = 0.08;

/** The body from rest bone positions (avatar space). null without hips or two arms. depth 1..2 = bodyDepth. */
export function torsoFromBones(b: TorsoBones, depth = 1): TorsoShape | null {
  const L = b.leftUpperArm, R = b.rightUpperArm, H = b.hips;
  if (!L || !R || !H) return null;
  const span = Math.abs(L.x - R.x);
  if (!(span > 0.02)) return null;
  const d = clamp(Number.isFinite(depth) ? depth : 1, 1, 2);
  const top = Math.min(L.y, R.y);
  if (!(top > H.y)) return null;
  return {
    cx: (L.x + R.x) / 2, cz: (L.z + R.z) / 2,
    halfW: 0.36 * span * (1 + 0.25 * (d - 1)),
    front: 0.3 * span * d,
    back: 0.26 * span * (1 + 0.5 * (d - 1)),
    y0: H.y, y1: top, band: 0.1 * span,
  };
}

/** Normalised ellipse radius of (x, z): < 1 inside the body. */
export function bodyRadius(s: TorsoShape, x: number, z: number): number {
  return Math.hypot((x - s.cx) / s.halfW, (z - s.cz) / (z >= s.cz ? s.front : s.back));
}
/** 1 within the body's height, easing to 0 over `band` past the hips / the shoulders. */
export function heightWeight(s: TorsoShape, y: number): number {
  return clamp(Math.min((y - (s.y0 - s.band)) / s.band, ((s.y1 + s.band) - y) / s.band), 0, 1);
}

/** How far behind the body (in front of it, for a hand behind the back) the push-out lines start, in body radii. */
export const GUARD_ANCHOR = 2.5;

/**
 * `p` eased out of the body. side: +1 the hand was last outside in front, -1 behind: from inside it leaves on that side
 * (a hand pressed into the chest never pops out behind the back). It moves along the line from an anchor behind the
 * body (or in front of it) — nearly straight out to the front: a hand deep inside armour that jitters a little stays a
 * little jitter on the surface (a line from the centre would swing the exit point around). Soft: along that line,
 * ρ' = 1 + m·e^((ρ−(1+m))/m) below 1+m — equal to ρ there with the same slope, never inside.
 */
export function pushOut(s: TorsoShape, p: V3, side = 1): V3 {
  const wy = heightWeight(s, p.y);
  if (wy <= 0) return p.clone();
  // normalised: the body's cross-section is the unit circle (front / back scale on each side of the centre)
  const qx = (p.x - s.cx) / s.halfW;
  const qz = (p.z - s.cz) / (p.z >= s.cz ? s.front : s.back);
  const r = Math.hypot(qx, qz);
  const R1 = 1 + GUARD_MARGIN;
  // far outside: along any anchor line ρ ≥ 1 + (r − 1) / (1 + GUARD_ANCHOR) ≥ R1 here, so nothing would move anyway
  // (the margin itself is measured along the line below: one measure, no edge where the push stops short)
  if (r >= 1 + GUARD_MARGIN * (1 + GUARD_ANCHOR)) return p.clone();
  // outside (in the soft margin) a point keeps its own side; inside, the side the hand came from
  const sd = r >= 1 ? (qz >= 0 ? 1 : -1) : side >= 0 ? 1 : -1;
  const az = -sd * GUARD_ANCHOR; // the anchor (0, az)
  const vx = qx, vz = qz - az; // anchor → q (q at t = 1)
  const A = vx * vx + vz * vz, B = 2 * az * vz, C = az * az - 1;
  const disc = B * B - 4 * A * C;
  if (A < 1e-12 || disc <= 0) return p.clone(); // the line misses the body
  const tExit = (-B + Math.sqrt(disc)) / (2 * A); // where it leaves the body on the far side
  const rho = 1 / tExit; // < 1: inside
  if (rho >= R1) return p.clone();
  const t = (1 + GUARD_MARGIN * Math.exp((rho - R1) / GUARD_MARGIN)) * tExit;
  const nx = vx * t, nz = az + vz * t;
  const out = new THREE.Vector3(s.cx + nx * s.halfW, p.y, s.cz + nz * (nz >= 0 ? s.front : s.back));
  return p.clone().lerp(out, wy);
}

/** Two-bone IK: elbow + wrist for shoulder S, wrist target T, upper / fore lengths a / b, bending toward `pole`. */
export function solveElbow(S: V3, T: V3, a: number, b: number, pole: V3): { elbow: V3; wrist: V3 } {
  const st = T.clone().sub(S);
  let d = st.length();
  const dir = d > 1e-6 ? st.divideScalar(d) : new THREE.Vector3(0, -1, 0);
  d = clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const pv = pole.clone().sub(S);
  pv.addScaledVector(dir, -pv.dot(dir));
  if (pv.lengthSq() < 1e-10) pv.set(0, 0, 1).addScaledVector(dir, -dir.z); // no pole: bend toward the front
  if (pv.lengthSq() < 1e-10) pv.set(1, 0, 0);
  pv.normalize();
  const elbow = S.clone().addScaledVector(dir, x).addScaledVector(pv, h);
  return { elbow, wrist: S.clone().addScaledVector(dir, d) };
}

export interface GuardRest {
  bones: TorsoBones;
  /** upper-arm roots (avatar space, rest) */
  shoulder: Record<Side, V3>;
  /** segment lengths: upper arm, forearm */
  upper: Record<Side, number>; fore: Record<Side, number>;
}

/** One per avatar (src/avatar/retarget.ts). */
export class BodyGuard {
  private corr: Record<Side, V3> = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  private side: Record<Side, number> = { left: 1, right: 1 };
  private shape: TorsoShape | null = null;
  private shapeDepth = NaN;
  constructor(private rest: GuardRest) {}

  /** From rest positions (avatar space) by humanoid bone name; null when the skeleton has no hips or no two full arms. */
  static fromRest(pos: (bone: string) => V3 | undefined): BodyGuard | null {
    const shoulder = {} as Record<Side, V3>, upper = {} as Record<Side, number>, fore = {} as Record<Side, number>;
    for (const s of ['left', 'right'] as Side[]) {
      const u = pos(`${s}UpperArm`), l = pos(`${s}LowerArm`), hd = pos(`${s}Hand`);
      if (!u || !l || !hd) return null;
      shoulder[s] = u; upper[s] = u.distanceTo(l); fore[s] = l.distanceTo(hd);
      if (!(upper[s] > 1e-3 && fore[s] > 1e-3)) return null;
    }
    const bones = { hips: pos('hips'), leftUpperArm: shoulder.left, rightUpperArm: shoulder.right };
    return torsoFromBones(bones) ? new BodyGuard({ bones, shoulder, upper, fore }) : null;
  }

  shapeFor(depth: number): TorsoShape | null {
    if (depth !== this.shapeDepth) { this.shape = torsoFromBones(this.rest.bones, depth); this.shapeDepth = depth; }
    return this.shape;
  }

  /**
   * du / dl: unit directions of the upper arm and the forearm in the TORSO's frame (avatar space). on = the avatar's
   * setting. Returns the same objects when nothing is pushed (off: bones stay exactly as tracked), else new directions.
   */
  apply(side: Side, du: V3, dl: V3, depth: number, dt: number, on: boolean): { du: V3; dl: V3; pushed: number } {
    const s = this.shapeFor(depth);
    const c = this.corr[side];
    if (!s || (!on && c.lengthSq() < 1e-10)) { c.set(0, 0, 0); return { du, dl, pushed: 0 }; }
    const S = this.rest.shoulder[side], a = this.rest.upper[side], b = this.rest.fore[side];
    const E = S.clone().addScaledVector(du, a);
    const W = E.clone().addScaledVector(dl, b);
    if (bodyRadius(s, W.x, W.z) >= 1 || heightWeight(s, W.y) <= 0) this.side[side] = W.z >= s.cz ? 1 : -1;
    const want = new THREE.Vector3();
    if (on) {
      const M = E.clone().addScaledVector(dl, b * 0.5); // the middle of the forearm
      const dw = pushOut(s, W, this.side[side]).sub(W);
      const dm = pushOut(s, M, this.side[side]).sub(M).multiplyScalar(2); // the wrist moves ~2x the forearm's middle
      want.copy(dw.lengthSq() >= dm.lengthSq() ? dw : dm);
    }
    // smoothed: in within ~30 ms (a hand must not sink in), out over ~150 ms (no snap when it leaves)
    c.lerp(want, 1 - Math.exp(-(want.lengthSq() > c.lengthSq() ? 32 : 7) * Math.max(0, dt)));
    if (c.lengthSq() < 1e-10) { c.set(0, 0, 0); return { du, dl, pushed: 0 }; }
    const { elbow, wrist } = solveElbow(S, W.clone().add(c), a, b, E);
    return { du: elbow.clone().sub(S).normalize(), dl: wrist.clone().sub(elbow).normalize(), pushed: c.length() };
  }
}

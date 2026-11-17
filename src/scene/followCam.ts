// Walk-in follow camera that never looks at the unmodelled outside of a room (docs/SCENES.md "Follow camera").
//
// While someone walks in, a camera "operator" standing at a fixed point pans + zooms with them. Operators = CAM_WIDE's
// position (the classic one), CAM_DOOR, every other CAM_* preset, the destination's SPOT_xx_CAM / solved talk shot.
// The walk is planned in 0.25 s steps from its start (the mover's own timeline → identical on every page, also for a
// page that loads mid-walk): per step every operator is scored —
//   · the view: 4×3 rays across the frame must meet the FRONT of modelled surfaces (no void sideways / down, no
//     wall seen from behind = the camera looking out of the set)
//   · the operator itself inside the set (not behind a wall), not too close / too far
//   · the walker visible (head + chest not behind the room or someone seated)
// and the current operator is kept while it stays fine (hysteresis), else the plan CUTS to the best one. Before the
// walker is through the doorway the camera looks at the doorway (inside the room), never at them outside it. An
// authored CAM_DOOR is used for the door phase only when its own view passes the same test.
import * as THREE from 'three';
import { lookPose, type CamPose } from './cameraRig.ts';
import type { RoomInfo } from './contract.ts';
import type { RoomRays } from './twoShot.ts';
import type { RoomProbe, ShotSubject } from './shotSolver.ts';

const STEP = 0.25;

export interface FollowOperator { name: string; pos: THREE.Vector3; bias: number }
export interface FollowWalk {
  /** Walk identity (actor + target + timing): a new id restarts the plan. */
  id: string;
  /** Seconds into the walk, through the doorway, settled. */
  t: number; through: number; arrive: number;
  /** Walker height (m, scaled) and where they are now. */
  height: number;
  now: THREE.Vector3;
  /** Where the walk has them at time t (null = unknown: plan with `now`). */
  at: ((t: number) => THREE.Vector3 | null) | null;
  /** The walker's DRAWN face (src/scene/faceDepth.ts, measured at rest): its centre's height over their feet and its
   *  size (m, scaled). The visibility test looks at the face itself, never a point at 0.88 x height (a mascot's face sits
   *  lower; a monitor or a brazier can hide the face while the crown shows). Unset = 0.88 x height, 0.16 x height. */
  faceY?: number;
  faceSize?: number;
  /** How far in front of their feet the face is (m, scaled rest offset along their facing: a mascot's face sits well
   *  ahead of its pivot). Applied along the walk's direction at that moment. */
  faceFwd?: number;
}

/** Consecutive plan steps (0.25 s) with the walker's face (partly) hidden after which the plan cuts away even inside
 *  its hold: the face is never off the screen behind something for a second (desert_walker/SPEC.md L5: walk-ins sampled
 *  every 0.25 s, 0 severe). 3 = 0.5 s on screen, leaving room for the planned face being a little off the live one. */
export const LOST_CUT = 3;
/** The face test's points (x, y in face sizes, around the planned face centre - a little wider than the face: the plan
 *  predicts the face from the walk, a few cm off the live one): ANY one blocked = hidden for the cut rule. */
const FACE_PTS: readonly (readonly [number, number])[] = [[0, 0], [-0.45, 0], [0.45, 0], [0, 0.5], [0, -0.45]];
/** A cut for a lost face goes to an operator that sees the face now and this many steps ahead (it must not lose it
 *  again right away). */
const AHEAD = 2;
export interface FollowEnv {
  room: RoomInfo; rays: RoomRays; probe: RoomProbe; skyOk: boolean; aspect: number;
  /** Open void everywhere is the designed backdrop (epoch / space rooms). */
  voidOk?: boolean;
  operators: FollowOperator[];
  /** People already seated (they may block the view of the walker). */
  seated: ShotSubject[];
  /** The authored door cut, when the room has one. */
  door: CamPose | null;
}

function personHit(a: THREE.Vector3, b: THREE.Vector3, s: ShotSubject): boolean {
  const d = b.clone().sub(a), L = d.length();
  if (L < 1e-4) return false;
  const ray = new THREE.Ray(a, d.divideScalar(L)), p = new THREE.Vector3();
  if (ray.intersectSphere(new THREE.Sphere(s.face.center, s.face.size * 0.75), p) && p.distanceTo(a) < L - 0.05) return true;
  const w = s.face.size * 1.0, c = s.face.center;
  const box = new THREE.Box3(new THREE.Vector3(c.x - w, s.floor.y, c.z - w), new THREE.Vector3(c.x + w, c.y - s.face.size * 0.6, c.z + w));
  return !!ray.intersectBox(box, p) && p.distanceTo(a) < L - 0.05;
}

export class FollowPlanner {
  private id = '';
  private plan: { op: number; score: number; since: number; lost: number; why?: string }[] = [];
  private opOk = new Map<string, number>();
  private doorOk: boolean | null = null;
  /** Debug: the operators and the plan so far. */
  get debug() { return { id: this.id, steps: this.plan.length, ops: this.plan.map((p) => p.op), why: this.plan.map((p) => p.why ?? ''), face: this.dbgFace?.toArray().map((v) => +v.toFixed(3)) ?? null }; }
  /** Debug: the face centre the last planned step tested. */
  private dbgFace: THREE.Vector3 | null = null;

  /** The doorway (inside edge) — what the camera looks at until the walker is through. */
  private doorway(env: FollowEnv, h: number): THREE.Vector3 | null {
    const out = env.room.doorOutside?.position, p0 = env.room.path[0];
    if (!out) return null;
    const inner = p0 ? out.clone().lerp(p0, 0.45) : out.clone().addScaledVector(env.room.doorOutside!.forward, 0.8);
    return inner.setY(out.y + h * 0.55);
  }

  private target(env: FollowEnv, w: FollowWalk, t: number, pos: THREE.Vector3 | null): THREE.Vector3 | null {
    if (t < w.through - 0.1) return this.doorway(env, w.height) ?? pos?.clone().setY(pos.y + w.height * 0.58) ?? null;
    return pos ? pos.clone().setY(pos.y + w.height * 0.58) : null;
  }

  poseFor(op: FollowOperator, target: THREE.Vector3, h: number): CamPose {
    const dist = op.pos.distanceTo(target);
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((h * 0.8) / Math.max(0.5, dist))), 20, 52);
    return lookPose(op.pos, target, fov);
  }

  /** Number of 6×4 view rays (edges and corners included — void hides in corners) along which the renderer draws
   *  nothing (void; upward only counts indoors). */
  viewBad(env: FollowEnv, pose: CamPose): number {
    if (env.voidOk) return 0;
    const cam = new THREE.PerspectiveCamera(pose.fov, env.aspect, 0.03, 500);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    let bad = 0;
    for (const v of [0.04, 0.35, 0.65, 0.96]) for (const u of [0.03, 0.22, 0.41, 0.59, 0.78, 0.97]) {
      const d = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(pose.position).normalize();
      // (what the renderer shows: past culled back faces — glass, the fourth wall — to the first front face)
      // (outdoor rooms: the environment draws sky, sea and horizon — only a steep look down into nothing is a hole)
      const open = env.skyOk ? d.y < -0.35 : true;
      if (open && env.probe.drawn(pose.position, d, 90) === null) bad += v > 0.5 ? 2 : 1;   // (a hole under the floor line is the worst)
    }
    return bad;
  }

  /** Score of an operator at plan time t (lower = better) + whether it is BAD (must cut away): the view leaves the
   *  set, the operator is behind a wall, far too close, or the walker's head is hidden. */
  private opScore(env: FollowEnv, op: FollowOperator, w: FollowWalk, t: number): { s: number; bad: boolean; hidden: boolean } {
    // (the walk's own timeline when the mover has one - the same on every page, whatever frame a page planned this step
    // on; else where they are now)
    const pos = w.at?.(t) ?? w.now;
    const target = this.target(env, w, t, pos);
    if (!target) return { s: 99, bad: true, hidden: false };
    let s = op.bias, bad = false, hidden = false;
    let outside = this.opOk.get(op.name);
    if (outside === undefined) { outside = env.probe.outside(op.pos, 6); this.opOk.set(op.name, outside); }
    if (outside >= 3) { s += 3 + outside; bad = true; }
    const d = op.pos.distanceTo(target);
    // (too close scales with the walker: a 4 m walker passing 1.5 m from the operator is out of any lens — framing
    // guarantee; a person-sized walker keeps the old limits exactly)
    const near = Math.max(1.7, w.height * 0.8), tooNear = Math.max(1.1, w.height * 0.55);
    if (d < near) s += (near - d) * 3;
    if (d < tooNear) bad = true;
    if (d > 13) s += (d - 13) * 0.35;
    const vb = this.viewBad(env, this.poseFor(op, target, w.height));
    s += vb * 1.4;
    if (vb >= 2) bad = true;
    if (t >= w.through - 0.1 && pos) {
      const fy = w.faceY ?? w.height * 0.88, fs = w.faceSize ?? w.height * 0.16;
      const fc = pos.clone().setY(pos.y + fy);
      // (the face rides ahead of the feet along the walk: the path's own direction at t, the same on every page)
      if (w.faceFwd && w.at) {
        const p0 = w.at(Math.max(0, t - 0.15)), p1 = w.at(t + 0.15);
        const dir = p0 && p1 ? p1.clone().sub(p0).setY(0) : null;
        if (dir && dir.lengthSq() > 1e-4) fc.addScaledVector(dir.normalize(), w.faceFwd);
      }
      this.dbgFace = fc.clone();
      // (the face must be in the operator's frame at all: a high or close operator aimed at a giant's middle can leave
      // it out - the guard's refit cannot always bring it back from there)
      const pose = this.poseFor(op, target, w.height);
      const cam = new THREE.PerspectiveCamera(pose.fov, env.aspect, 0.03, 500);
      cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const pf = fc.clone().project(cam);
      if (pf.z > 1 || Math.abs(pf.x) > 0.85 || pf.y > 0.85 || pf.y < -0.85) { s += 3; bad = true; }
      const n = this.faceBlocked(env, op, fc, fs);
      if (n > 0) hidden = true;
      if (n >= 2) { s += 2.5; const body = pos.clone().setY(pos.y + Math.min(w.height * 0.7, fy - fs)); if (this.blocked(env, op.pos, body)) s += 1; }
      else if (n) s += 1.0;
    }
    return { s, bad, hidden };
  }

  private blocked(env: FollowEnv, from: THREE.Vector3, q: THREE.Vector3): boolean {
    return !env.rays.clearSee(from, q) || env.seated.some((o) => personHit(from, q, o));
  }
  /** How many of the face test's points are hidden from the operator (on the face's side towards it). */
  private faceBlocked(env: FollowEnv, op: FollowOperator, fc: THREE.Vector3, fs: number): number {
    const to = op.pos.clone().sub(fc).setY(0);
    const side = to.lengthSq() > 1e-8 ? new THREE.Vector3(-to.z, 0, to.x).normalize() : new THREE.Vector3(1, 0, 0);
    const front = to.lengthSq() > 1e-8 ? to.normalize().multiplyScalar(fs * 0.4) : new THREE.Vector3();
    let n = 0;
    for (const [x, y] of FACE_PTS) if (this.blocked(env, op.pos, fc.clone().addScaledVector(side, x * fs).add(new THREE.Vector3(0, y * fs, 0)).add(front))) n++;
    return n;
  }
  /** Operator i's score at plan step k (cached for the walk: the lookahead and the plan share them). */
  private scoreAt(env: FollowEnv, w: FollowWalk, i: number, k: number) {
    if (!w.at) return this.opScore(env, env.operators[i], w, k * STEP);   // (no walk timeline: nothing to plan ahead with)
    const key = i * 4096 + k;
    let r = this.scores.get(key);
    if (!r) { r = this.opScore(env, env.operators[i], w, k * STEP); this.scores.set(key, r); }
    return r;
  }
  private scores = new Map<number, { s: number; bad: boolean; hidden: boolean }>();

  /** Is the authored CAM_DOOR cut itself looking into the set? */
  private doorGood(env: FollowEnv): boolean {
    if (this.doorOk === null) this.doorOk = !!env.door && this.viewBad(env, env.door) === 0 && env.probe.outside(env.door.position, 6) < 3;
    return this.doorOk;
  }

  /** The follow shot at the walk's current time. */
  shot(env: FollowEnv, w: FollowWalk, key: string): { key: string; pose: CamPose } | null {
    if (w.id !== this.id) { this.id = w.id; this.plan = []; this.opOk.clear(); this.doorOk = null; this.scores.clear(); }
    if (!env.operators.length) return null;
    // the door phase: the authored door cut (when it passes), else the plan looks at the doorway
    if (env.door && w.t < w.through + 0.5 && this.doorGood(env)) return { key: `${key}:door`, pose: env.door };
    // plan every step up to now (sequential, identical on every page): stay on the current operator unless it goes
    // BAD (view out of the set / behind a wall / on top of the walker) or loses the walker's face for LOST_CUT steps
    // (0.5 s on screen - never a full second); after a cut, hold ≥ 2 s unless the view goes bad or loses the face —
    // a follow shot, not a cutting montage
    const upto = Math.floor(Math.max(0, w.t) / STEP);
    for (let k = this.plan.length; k <= upto && k < 400; k++) {
      const t = k * STEP;
      const sc = env.operators.map((_, i) => this.scoreAt(env, w, i, k));
      // no ping-pong: an operator cut away from in the last 3 s costs extra
      const recent = new Set<number>();
      for (let j = Math.max(1, k - 12); j < k; j++) if (this.plan[j].op !== this.plan[j - 1].op) recent.add(this.plan[j - 1].op);
      const eff = sc.map((x, i) => x.s + (recent.has(i) ? 2.5 : 0));
      let best = 0;
      for (let i = 1; i < sc.length; i++) if (eff[i] < eff[best]) best = i;
      const prev = this.plan[k - 1];
      let op = best, since = 0, lost = 0;
      if (prev) {
        const cur = sc[prev.op];
        lost = cur.hidden ? prev.lost + 1 : 0;
        const lostCut = lost >= LOST_CUT;
        const must = cur.bad || lostCut;
        const held = prev.since >= 8;
        // the face lost: to the best operator that SEES it (and is itself fine) — the hold never keeps a hidden face
        let seen = -1;
        if (lostCut && !cur.bad) {
          const fine = (i: number, ahead: number) => { for (let j = 0; j <= ahead; j++) { const x = j ? this.scoreAt(env, w, i, k + j) : sc[i]; if (x.bad || x.hidden) return false; } return true; };
          for (const ahead of [AHEAD, 0]) {
            for (let i = 0; i < sc.length; i++) if (i !== prev.op && fine(i, ahead) && (seen < 0 || eff[i] < eff[seen])) seen = i;
            if (seen >= 0) break;
          }
        }
        // (only to an operator that is itself fine — when every view is compromised, hold unless one is far better)
        const better = !sc[best].bad ? eff[best] < cur.s - 0.5 : held && eff[best] < cur.s - 3;
        op = seen >= 0 ? seen : must && (held || cur.bad) && best !== prev.op && better ? best : prev.op;
        since = op === prev.op ? prev.since + 1 : 0;
        if (op !== prev.op) lost = 0;
      }
      this.plan.push({ op, score: sc[op].s, since, lost, why: sc.map((x, i) => `${i}:${x.s.toFixed(1)}${x.bad ? 'B' : ''}${x.hidden ? 'H' : ''}`).join(' ') });
    }
    const step = this.plan[Math.min(upto, this.plan.length - 1)];
    const op = env.operators[step.op];
    const target = this.target(env, w, w.t, w.now);
    if (!target) return null;
    return { key: `${key}:${op.name}`, pose: this.poseFor(op, target, w.height) };
  }
}

/** Operators for a room: CAM_WIDE (bias 0), CAM_DOOR, the other presets near the lived-in area (not vistas far away
 *  or high overheads), the destination's talk camera. */
export function followOperators(room: RoomInfo, extra: { name: string; pos: THREE.Vector3 }[], wideFallback: THREE.Vector3, center: THREE.Vector3): FollowOperator[] {
  const out: FollowOperator[] = [];
  const wide = room.cameras.get('CAM_WIDE');
  out.push({ name: 'wide', pos: (wide?.position ?? wideFallback).clone(), bias: 0 });
  const floor = center.y - 1.2;
  for (const [n, c] of room.cameras) {
    if (n === 'CAM_WIDE' || n === 'CAM_REACT') continue;
    const p = c.position;
    if (p.y - floor > 4 || Math.hypot(p.x - center.x, p.z - center.z) > 16) continue;
    out.push({ name: n, pos: p.clone(), bias: n === 'CAM_DOOR' ? 0.8 : 1.2 });
  }
  for (const e of extra) out.push({ name: e.name, pos: e.pos.clone(), bias: 1.0 });
  // (operators on top of each other are one operator)
  return out.filter((o, i) => out.findIndex((p) => p.pos.distanceTo(o.pos) < 0.25) === i);
}

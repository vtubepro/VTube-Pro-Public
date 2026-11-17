// Voyage ship: the leg + turret rig that drives the ship's nodes (the room GLB's, or the procedural placeholder's), and the
// placeholder ship itself (used until a room delivers its ship GLB, and on test pages).
//
// NODE CONTRACT (room GLB, ship frame = the room's glTF frame: origin = show deck floor centre, +Y up, bow = -Z unless a
// VOYAGE_BOW empty says otherwise). Every pivot node's ORIGIN sits on its joint; rest rotations are whatever the GLB has.
//   LEG_<id>_COXA   yaw housing (rotates about ship +Y)            id = FL ML BL FR MR BR  (or L1 L2 L3 R1 R2 R3)
//   LEG_<id>_HIP    hinge (femur)   child of COXA (or of the hull when there is no COXA: then HIP also takes the yaw)
//   LEG_<id>_KNEE   hinge (tibia)   child of HIP
//   LEG_<id>_ANKLE  hinge (foot)    child of KNEE (optional)
//   LEG_<id>_FOOT   empty at the sole contact centre, child of ANKLE / KNEE
//     (v0 build / rig.json naming is accepted too: LEG_<id>_FOOT = the ankle hinge + LEG_<id>_SOLE = the contact, rams
//     LEG_<id>_RAM<k>_CYL / _ROD; rig.json limits clamp every joint, its damage sites + turret limits are used)
//   LEG_<id>_P<n>_CYL / LEG_<id>_P<n>_ROD   piston halves: each aims its +Y at the other's origin every frame
//   TURRET_<n> (yaw) > TURRET_<n>_GUN (pitch) > TURRET_<n>_MUZZLE (empty at the barrel tip)   n = 1 fore, 2 aft, ...
//     aliases: GUN_F_YAW / GUN_F_PITCH / GUN_F_MUZZLE, GUN_A_*  (crew lane names)
//   DAMAGE_<nn>     hull-exterior hit sites (>= 12 m from every SPOT)
//   GANGWAY         hinged ramp (rotates about its local X), lowered at treasure stops
//   LANTERN_* / PENDULUM_*   swing with the hull's motion (below decks)
//   VOYAGE_BOW      optional empty ahead of the origin: its direction is the bow
// The hinge axis of a leg = ship up x (the leg's horizontal direction): + rotation swings the distal end DOWN.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GaitLeg } from './voyageGait.ts';

const UP = new THREE.Vector3(0, 1, 0);
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), te = new THREE.Euler();
const tm = new THREE.Matrix4();

// ------------------------------------------------------------------------------------------------ measured pivots
/** Placeholder-ship leg pivots in the room frame (geometry lane pivots_draft.json, 20 m per Meshy unit). */
export const PLACEHOLDER_LEGS: Record<string, { C: number[]; H: number[]; K: number[]; A: number[]; F: number[]; p1: number[]; p2t: number[]; p2f: number[]; sole: [number, number] }> = {
  FL: { C: [-3.448, -7.5, -9.432], H: [-3.586, -8.33, -9.646], K: [-5.756, -7.036, -12.962], A: [-6.78, -11.398, -14.526], F: [-6.872, -12.72, -14.502], p1: [-5.584, -8.052, -12.7], p2t: [-5.584, -8.292, -12.7], p2f: [-6.456, -11.394, -13.984], sole: [2.73, 1.73] },
  ML: { C: [-3.47, -7.5, -3.078], H: [-3.866, -8.53, -3.08], K: [-7.162, -7.068, -3.1], A: [-8.938, -11.366, -3.112], F: [-8.962, -12.714, -3.09], p1: [-6.604, -8.264, -3.098], p2t: [-6.604, -8.504, -3.098], p2f: [-8.338, -11.398, -3.102], sole: [2.43, 1.5] },
  BL: { C: [-3.474, -7.5, 2.966], H: [-3.686, -8.444, 3.24], K: [-5.868, -7.058, 6.05], A: [-6.986, -11.404, 7.49], F: [-7.06, -12.714, 7.496], p1: [-5.77, -8.11, 5.926], p2t: [-5.77, -8.35, 5.926], p2f: [-6.606, -11.602, 7.002], sole: [2.81, 1.73] },
  FR: { C: [3.448, -7.5, -9.432], H: [3.586, -8.33, -9.646], K: [5.756, -7.036, -12.962], A: [6.78, -11.398, -14.526], F: [6.872, -12.72, -14.502], p1: [5.584, -8.052, -12.7], p2t: [5.584, -8.292, -12.7], p2f: [6.456, -11.394, -13.984], sole: [2.82, 1.63] },
  MR: { C: [3.47, -7.5, -3.078], H: [3.866, -8.53, -3.08], K: [7.162, -7.068, -3.1], A: [8.938, -11.366, -3.112], F: [8.962, -12.714, -3.09], p1: [6.604, -8.264, -3.098], p2t: [6.604, -8.504, -3.098], p2f: [8.338, -11.398, -3.102], sole: [2.4, 1.46] },
  BR: { C: [3.474, -7.5, 2.966], H: [3.686, -8.444, 3.24], K: [5.868, -7.058, 6.05], A: [6.986, -11.404, 7.49], F: [7.06, -12.714, 7.496], p1: [5.77, -8.11, 5.926], p2t: [5.77, -8.35, 5.926], p2f: [6.606, -11.602, 7.002], sole: [2.74, 1.84] },
};
export const PLACEHOLDER_GUNS = [
  { yaw: [0, -1.16, -16.54], pitch: [0, 0.534, -17.06], muzzle: [0.006, 0.66, -19.104], r: 0.16 },
  { yaw: [0, -1.1, 10.68], pitch: [0, -0.018, 10.04], muzzle: [0.002, 0.254, 15.812], r: 0.2 },
];
/** Hull-exterior hit sites, >= 12 m from every deck spot (art lane keep-outs). */
export const PLACEHOLDER_DAMAGE: [number, number, number][] = [[-4.3, -5.8, -14.0], [-4.2, -6.2, 13.6], [4.3, -5.8, -14.0], [4.2, -6.2, 13.6], [0, -4.6, -20.2], [0, -3.0, 15.9]];

// ------------------------------------------------------------------------------------------------ the rig
interface Hinge { node: THREE.Object3D; restQ: THREE.Quaternion; axis: THREE.Vector3 }
export interface JointLimits { coxa?: [number, number]; hip?: [number, number]; knee?: [number, number]; ankle?: [number, number] }
export interface LegRig {
  id: string;
  /** joint limits (rad, [neg, pos]) from rig.json; none = free */ limits: JointLimits;
  /** solves that hit a limit or the reach clamp (debug) */ clamps: number;
  coxa: Hinge | null;          // yaw (axis = ship up in its local frame)
  hip: Hinge; knee: Hinge; ankle: Hinge | null;
  /** rest pivots (ship frame) */
  C: THREE.Vector3; H: THREE.Vector3; K: THREE.Vector3; A: THREE.Vector3; F: THREE.Vector3;
  /** rest azimuth (rad, atan2(x, -z) of the horizontal C->A direction) and in-plane elevations */
  az0: number; ef0: number; et0: number; ea0: number;
  a: number; b: number;
  /** foot below the ankle at rest (ship frame offset A - F) */
  footOff: THREE.Vector3;
  gait: GaitLeg;
  pistons: { cyl: THREE.Object3D; rod: THREE.Object3D; cq: THREE.Quaternion; rq: THREE.Quaternion }[];
  /** last solve: reach used 0..1 */ reach: number;
}
export interface TurretRig {
  name: string;
  yaw: Hinge; gun: Hinge; muzzle: THREE.Object3D;
  /** yaw pivot (ship frame) */ pivot: THREE.Vector3;
  /** elevation limits (rad) */ elev: [number, number];
  gunRestPos: THREE.Vector3;
  /** rest barrel dir (ship frame) */ dir0: THREE.Vector3;
  az0: number; el0: number;
  /** firing arc half-width around its rest azimuth (rad) */ arc: number;
  /** rest yaw pivot -> muzzle distance (m, horizontal): lines of fire start at the muzzle (SPEC C13) */ reach?: number;
  /** current aim (rad, relative to rest) */ yawNow: number; pitchNow: number;
}

/** Rotation that takes node-local coordinates to ship-frame coordinates (ship = the room root's frame). */
function shipQuat(o: THREE.Object3D, ship: THREE.Object3D, out: THREE.Quaternion) {
  o.updateWorldMatrix(true, false);
  ship.updateWorldMatrix(true, false);
  const qo = o.getWorldQuaternion(new THREE.Quaternion());
  const qs = ship.getWorldQuaternion(new THREE.Quaternion());
  return out.copy(qs).invert().multiply(qo);
}
export type BowAxis = '-z' | '+z' | '-x' | '+x';
/** The bow's yaw (rad, from -Z towards +X: azOf) for an axis name. */
export const BOW_YAW: Record<BowAxis, number> = { '-z': 0, '+x': Math.PI / 2, '+z': Math.PI, '-x': -Math.PI / 2 };

/** The bow from the hull itself (the model, not an assumption): the hull's long horizontal axis, and on it the POINTED
 *  end - a prow narrows to a stem, a stern stays broad (a transom). Measured on the hull band (35..60 % of the model's
 *  height: the sides below the deck, above the legs), in 24 slices along the hull: the end whose width takes longer
 *  to reach 75 % of the widest is the bow. `conf` = the difference of the two runs / the longer (0 = alike: no call). Leg / turret / crew / engine
 *  nodes are left out. Pure in the geometry. */
export function detectBow(ship: THREE.Object3D): { axis: BowAxis; yaw: number; conf: number; ends: [number, number] } | null {
  ship.updateWorldMatrix(true, true);
  const inv = ship.matrixWorld.clone().invert(), m = new THREE.Matrix4(), p = new THREE.Vector3();
  const skip = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q && q !== ship; q = q.parent) if (!q.visible || /^(LEG_|TURRET|GUN_|CREW|vtp:)/i.test(q.name)) return true; return false; };
  const pts: number[] = [];
  ship.traverse((o) => {
    const me = o as THREE.Mesh;
    if (!me.isMesh || !me.geometry?.attributes?.position || skip(me)) return;
    const a = me.geometry.attributes.position as THREE.BufferAttribute;
    m.multiplyMatrices(inv, me.matrixWorld);
    const step = Math.max(1, Math.floor(a.count / 6000));
    for (let i = 0; i < a.count; i += step) { p.fromBufferAttribute(a, i).applyMatrix4(m); if (Math.abs(p.x) < 400 && Math.abs(p.z) < 400) pts.push(p.x, p.y, p.z); }
  });
  if (pts.length < 300) return null;
  // (robust extents: 0.5 / 99.5 percentiles, so a stray far mesh - a ground plane, a sky card - never sets the hull's ends)
  const pct = (o: number) => { const a: number[] = []; for (let i = o; i < pts.length; i += 3) a.push(pts[i]); a.sort((x, y) => x - y); return [a[Math.floor(a.length * 0.005)], a[Math.floor(a.length * 0.995)]]; };
  const [x0, x1] = pct(0), [y0, y1] = pct(1), [z0, z1] = pct(2);
  const ya = y0 + (y1 - y0) * 0.35, yb = y0 + (y1 - y0) * 0.6;
  const alongZ = z1 - z0 >= x1 - x0;
  const lo = alongZ ? z0 : x0, hi = alongZ ? z1 : x1, len = hi - lo;
  if (len < 1) return null;
  const N = 24, wmin = new Float64Array(N).fill(Infinity), wmax = new Float64Array(N).fill(-Infinity);
  for (let i = 0; i < pts.length; i += 3) {
    const y = pts[i + 1];
    if (y < ya || y > yb || pts[i] < x0 || pts[i] > x1 || pts[i + 2] < z0 || pts[i + 2] > z1) continue;
    const t = ((alongZ ? pts[i + 2] : pts[i]) - lo) / len, w = alongZ ? pts[i] : pts[i + 2];
    const k = Math.min(N - 1, Math.max(0, Math.floor(t * N)));
    wmin[k] = Math.min(wmin[k], w); wmax[k] = Math.max(wmax[k], w);
  }
  const width = (k: number) => (wmax[k] > wmin[k] ? wmax[k] - wmin[k] : 0);
  // the taper at each end: how far in (slices) before the hull reaches 75 % of its widest - a prow narrows over a long
  // run to its stem, a stern (a transom) is near full width at once. Ties: the narrower end slice.
  // (the hull's own beam: the median of the middle half - legs or sponsons splayed out at a few slices don't count)
  const mids: number[] = []; for (let k = N / 4; k < (3 * N) / 4; k++) mids.push(width(k));
  mids.sort((x, y) => x - y);
  const wm = mids[mids.length >> 1];
  if (wm <= 0) return null;
  const run = (from: number, dir: number) => { let k = 0; while (k < N / 2 && width(from + dir * k) < wm * 0.75) k++; return k + (1 - width(from) / wm) * 0.5; };
  const a = run(0, 1), b = run(N - 1, -1);
  const lowEndIsBow = a > b;               // the low end (-z / -x) tapers longer: the bow
  const axis: BowAxis = alongZ ? (lowEndIsBow ? '-z' : '+z') : (lowEndIsBow ? '-x' : '+x');
  return { axis, yaw: BOW_YAW[axis], conf: a + b > 0 ? Math.abs(a - b) / Math.max(a, b) : 0, ends: [+a.toFixed(2), +b.toFixed(2)] };
}

function shipPos(o: THREE.Object3D, ship: THREE.Object3D, out: THREE.Vector3) {
  o.updateWorldMatrix(true, false);
  return ship.worldToLocal(o.getWorldPosition(out));
}
function hinge(node: THREE.Object3D, ship: THREE.Object3D, axisShip: THREE.Vector3): Hinge {
  const q = shipQuat(node, ship, new THREE.Quaternion());
  return { node, restQ: node.quaternion.clone(), axis: axisShip.clone().applyQuaternion(q.invert()).normalize() };
}
const elev = (dr: number, dy: number) => Math.atan2(dy, dr);
const azOf = (v: THREE.Vector3) => Math.atan2(v.x, -v.z);
const horiz = (az: number, out: THREE.Vector3) => out.set(Math.sin(az), 0, -Math.cos(az));

export class ShipRig {
  legs: LegRig[] = [];
  turrets: TurretRig[] = [];
  damage: THREE.Vector3[] = [];
  gangway: { node: THREE.Object3D; restQ: THREE.Quaternion } | null = null;
  lanterns: { node: THREE.Object3D; restQ: THREE.Quaternion; k: number }[] = [];
  menorah: THREE.Material[] = [];
  /** extra yaw of the ship's bow from -Z (rad) */ bowYaw = 0;
  /** where the bow came from: scene.json voyage.forward, the VOYAGE_BOW node, the hull's own shape, or the default -Z */
  bowSource: 'config' | 'node' | 'geometry' | 'default' = 'default';
  /** the hull's own call (detectBow), for the record / a mismatch note */
  bowGeom: ReturnType<typeof detectBow> = null;
  /** procedural placeholder (null = the room's own ship) */
  placeholder: THREE.Group | null = null;

  /** Find the rig in a room (ship = the room root). Returns null when the room has no LEG_* nodes. */
  static fromRoom(ship: THREE.Object3D, gaitPhases: (ids: string[]) => number[], forward: BowAxis | null = null): ShipRig | null {
    const byName = new Map<string, THREE.Object3D>();
    ship.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
    const r = new ShipRig();
    r.ship = ship;
    const alias: Record<string, string> = { L1: 'FL', L2: 'ML', L3: 'BL', R1: 'FR', R2: 'MR', R3: 'BR', L4: 'HL', R4: 'HR' };
    const ids = new Set<string>();
    for (const n of byName.keys()) { const m = /^LEG_([A-Z]{1,2}\d?)_(?:COXA|HIP)$/.exec(n); if (m) ids.add(m[1]); }
    // ids: FL ML BL FR MR BR or L1 L2 L3 R1 R2 R3 (the spec's), sorted fore -> aft, port first
    const list = [...ids].sort((a, b) => (alias[a] ?? a).localeCompare(alias[b] ?? b));
    const phases = gaitPhases(list.map((i) => alias[i] ?? i));
    list.forEach((id, i) => {
      const g = (s: string) => byName.get(`LEG_${id}_${s}`) ?? null;
      // v0 naming: FOOT = the ankle hinge, SOLE = the contact
      const sole = g('SOLE');
      const leg = sole ? r.buildLeg(ship, id, g('COXA'), g('HIP'), g('KNEE'), g('FOOT'), sole, phases[i] ?? 0) : r.buildLeg(ship, id, g('COXA'), g('HIP'), g('KNEE'), g('ANKLE'), g('FOOT'), phases[i] ?? 0);
      if (!leg) return;
      for (let p = 1; p <= 4; p++) for (const [cn, rn] of [[`P${p}_CYL`, `P${p}_ROD`], [`RAM${p}_CYL`, `RAM${p}_ROD`]]) { const c = g(cn), d = g(rn); if (c && d) leg.pistons.push({ cyl: c, rod: d, cq: c.quaternion.clone(), rq: d.quaternion.clone() }); }
      r.legs.push(leg);
    });
    r.findTurrets(ship, byName);
    for (const [n, o] of byName) {
      if (/^DAMAGE_\d+/.test(n)) r.damage.push(shipPos(o, ship, new THREE.Vector3()));
      if (n === 'GANGWAY') r.gangway = { node: o, restQ: o.quaternion.clone() };
      if (/^(LANTERN|PENDULUM)_/.test(n)) r.lanterns.push({ node: o, restQ: o.quaternion.clone(), k: 1 });
      if (n === 'VOYAGE_BOW') { const p = shipPos(o, ship, new THREE.Vector3()); if (p.x * p.x + p.z * p.z > 1e-4) { r.bowYaw = azOf(p.setY(0)); r.bowSource = 'node'; } }
    }
    // the bow: the room's explicit setting, else its VOYAGE_BOW node, else the hull's pointed end (confident calls only)
    r.bowGeom = detectBow(ship);
    if (forward) { r.bowYaw = BOW_YAW[forward]; r.bowSource = 'config'; }
    else if (r.bowSource !== 'node' && r.bowGeom && r.bowGeom.conf >= 0.08) { r.bowYaw = r.bowGeom.yaw; r.bowSource = 'geometry'; }
    // the legs' gait offsets in the BOW frame (fwd along the bow, lat to starboard): a ship modelled facing +X walks
    // bow-first like one facing -Z
    if (r.bowYaw) {
      const q = new THREE.Vector3();
      for (const L of r.legs) { q.copy(L.F).applyAxisAngle(new THREE.Vector3(0, 1, 0), r.bowYaw); L.gait.fwd = -q.z; L.gait.lat = q.x; }
    }
    ship.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m && !Array.isArray(m) && /menorah/i.test(m.name) && !r.menorah.includes(m)) r.menorah.push(m); });
    return r.legs.length ? r : (r.turrets.length ? r : null);
  }

  private buildLeg(ship: THREE.Object3D, id: string, coxa: THREE.Object3D | null, hip: THREE.Object3D | null, knee: THREE.Object3D | null, ankle: THREE.Object3D | null, foot: THREE.Object3D | null, phi: number): LegRig | null {
    if (!hip || !knee) return null;
    const C = shipPos(coxa ?? hip, ship, new THREE.Vector3()), H = shipPos(hip, ship, new THREE.Vector3()), K = shipPos(knee, ship, new THREE.Vector3());
    const A = ankle ? shipPos(ankle, ship, new THREE.Vector3()) : (foot ? shipPos(foot, ship, new THREE.Vector3()) : K.clone().add(new THREE.Vector3(0, -4, 0)));
    const F = foot ? shipPos(foot, ship, new THREE.Vector3()) : A.clone().add(new THREE.Vector3(0, -0.5, 0));
    const hz = tv.copy(A).sub(C).setY(0);
    if (hz.lengthSq() < 1e-6) hz.copy(H).sub(C).setY(0);
    if (hz.lengthSq() < 1e-6) hz.set(Math.sign(C.x) || 1, 0, 0);
    const az0 = azOf(hz);
    const u = horiz(az0, new THREE.Vector3());
    const n = new THREE.Vector3().crossVectors(UP, u).normalize();
    const pr = (P: THREE.Vector3) => tv2.copy(P).sub(C).dot(u);
    const ef0 = elev(pr(K) - pr(H), K.y - H.y), et0 = elev(pr(A) - pr(K), A.y - K.y), ea0 = elev(pr(F) - pr(A), F.y - A.y);
    return {
      id, coxa: coxa ? hinge(coxa, ship, UP) : null, hip: hinge(hip, ship, n), knee: hinge(knee, ship, n), ankle: ankle ? hinge(ankle, ship, n) : null,
      C, H, K, A, F, az0, ef0, et0, ea0, a: H.distanceTo(K), b: K.distanceTo(A), footOff: A.clone().sub(F),
      gait: { id, fwd: -F.z, lat: F.x, phi }, pistons: [], reach: 0, limits: {}, clamps: 0,
    };
  }

  private findTurrets(ship: THREE.Object3D, byName: Map<string, THREE.Object3D>) {
    const sets: [string, string, string][] = [];
    for (let i = 1; i <= 6; i++) if (byName.has(`TURRET_${i}`)) sets.push([`TURRET_${i}`, `TURRET_${i}_GUN`, `TURRET_${i}_MUZZLE`]);
    for (const k of ['F', 'A', 'P', 'S']) if (byName.has(`GUN_${k}_YAW`)) sets.push([`GUN_${k}_YAW`, `GUN_${k}_PITCH`, `GUN_${k}_MUZZLE`]);
    for (const [y, g, m] of sets) {
      const yaw = byName.get(y)!, gun = byName.get(g) ?? yaw, muz = byName.get(m);
      if (!muz) continue;
      const P = shipPos(gun, ship, new THREE.Vector3()), M = shipPos(muz, ship, new THREE.Vector3());
      const dir0 = M.clone().sub(P).normalize();
      const az0 = azOf(tv.copy(dir0).setY(0));
      const el0 = Math.asin(Math.max(-1, Math.min(1, dir0.y)));
      const u = horiz(az0, new THREE.Vector3());
      const n = new THREE.Vector3().crossVectors(UP, u).normalize();
      const Y = shipPos(yaw, ship, new THREE.Vector3());
      this.turrets.push({ name: y, yaw: hinge(yaw, ship, UP), gun: hinge(gun, ship, n), muzzle: muz, pivot: Y.clone(), elev: [THREE.MathUtils.degToRad(-5), THREE.MathUtils.degToRad(35)],
        gunRestPos: gun.position.clone(), dir0, az0, el0, arc: THREE.MathUtils.degToRad(140), yawNow: 0, pitchNow: 0, reach: Math.hypot(M.x - Y.x, M.z - Y.z) });
    }
  }

  /** Solve one leg for a foot contact target (ship frame) and the ground's slope along the leg (rad, + = rising outward). */
  solveLeg(L: LegRig, target: THREE.Vector3, slope = 0) {
    const At = this.va.copy(target).add(L.footOff);               // ankle target: the vertical foot strut above the contact
    const dh = this.vb.copy(At).sub(L.C).setY(0);
    let psi = dh.lengthSq() > 1e-6 ? azOf(dh) - L.az0 : 0;          // yaw about the coxa axis towards the target (clamped)
    psi = Math.atan2(Math.sin(psi), Math.cos(psi));
    psi = Math.max(-0.7, Math.min(0.7, psi));
    const u = horiz(L.az0 + psi, this.vu), u0 = horiz(L.az0, this.vu0);
    // plane coordinates (r along u from the coxa axis, y up); the hip keeps its rest plane coordinates under the yaw
    const rH = this.vc.copy(L.H).sub(L.C).dot(u0), yH = L.H.y;
    const rA = this.vc.copy(At).sub(L.C).dot(u), yA = At.y;
    let dx = rA - rH, dy = yA - yH;
    let d = Math.hypot(dx, dy);
    const dMax = (L.a + L.b) * 0.995, dMin = Math.abs(L.a - L.b) + 0.05;
    L.reach = d / (L.a + L.b);
    if (d > dMax) { dx *= dMax / d; dy *= dMax / d; d = dMax; }
    if (d < dMin) { const k = dMin / Math.max(1e-4, d); dx *= k; dy *= k; d = dMin; }
    const eha = Math.atan2(dy, dx);
    const ca = (L.a * L.a + d * d - L.b * L.b) / (2 * L.a * d);
    const ef = eha + Math.acos(Math.max(-1, Math.min(1, ca)));      // knee above the hip-ankle line (hydraulic spider leg)
    const kr = rH + L.a * Math.cos(ef), ky = yH + L.a * Math.sin(ef);
    const et = Math.atan2(yH + dy - ky, rH + dx - kr);
    const lim = (v: number, l?: [number, number]) => { if (!l) return v; const c = Math.max(l[0], Math.min(l[1], v)); if (c !== v) L.clamps++; return c; };
    // (coxa limits are not applied: rig.json's coxa sign convention is not pinned down; the +-40 deg clamp above holds)
    const th = lim(L.ef0 - ef, L.limits.hip);
    const tk = lim((L.et0 - et) - th, L.limits.knee);
    const ta = lim(-(th + tk) - slope, L.limits.ankle);               // the foot pad stays level (on the slope)
    if (L.reach > 0.995) L.clamps++;
    // (a + rotation about +Y lowers azOf: yaw by -psi)
    if (L.coxa) L.coxa.node.quaternion.copy(L.coxa.restQ).multiply(tq.setFromAxisAngle(L.coxa.axis, -psi));
    const hipQ = L.hip.node.quaternion.copy(L.hip.restQ);
    if (!L.coxa) hipQ.multiply(tq.setFromAxisAngle(this.upLocal(L), -psi));
    hipQ.multiply(tq.setFromAxisAngle(L.hip.axis, th));
    L.knee.node.quaternion.copy(L.knee.restQ).multiply(tq.setFromAxisAngle(L.knee.axis, tk));
    if (L.ankle) L.ankle.node.quaternion.copy(L.ankle.restQ).multiply(tq.setFromAxisAngle(L.ankle.axis, ta));
  }
  private va = new THREE.Vector3(); private vb = new THREE.Vector3(); private vc = new THREE.Vector3();
  private vu = new THREE.Vector3(); private vu0 = new THREE.Vector3();
  private upCache = new WeakMap<LegRig, THREE.Vector3>();
  /** the ship frame (set by fromRoom / the voyage scene) */
  ship: THREE.Object3D | null = null;
  /** ship up in the hip's local frame (legs without a coxa node yaw at the hip) */
  private upLocal(L: LegRig) {
    let v = this.upCache.get(L);
    if (!v) {
      const parentQ = L.hip.node.parent && this.ship ? shipQuat(L.hip.node.parent, this.ship, new THREE.Quaternion()) : new THREE.Quaternion();
      v = UP.clone().applyQuaternion(parentQ.multiply(L.hip.restQ).invert()).normalize();
      this.upCache.set(L, v);
    }
    return v;
  }

  /** Rams: each half aims its +Y at the other half's origin, relative to its rest rotation (rig.json rams_doc):
   *  q = restQ * fromUnitVectors(+Y, localDir(other origin)). */
  pistons(ship: THREE.Object3D) {
    for (const L of this.legs) {
      if (!L.pistons.length) continue;
      // ONE world-matrix pass per leg (its ancestors once, then the leg's whole subtree); every ram half then reads its
      // parent's matrixWorld (no getWorldPosition / getWorldQuaternion walking the parent chain per part)
      (L.coxa?.node ?? L.hip.node).updateWorldMatrix(true, true);
      for (const p of L.pistons) {
        const pc = p.cyl.parent, pr = p.rod.parent;
        if (!pc || !pr) continue;
        RA.copy(p.cyl.position).applyMatrix4(pc.matrixWorld);
        RB.copy(p.rod.position).applyMatrix4(pr.matrixWorld);
        aimRest(p.cyl, p.cq, RB, RA);
        aimRest(p.rod, p.rq, RA, RB);
      }
    }
    void ship;
  }

  /** rig.json (geometry lane / v0 build): joint limits, hit sites, turret limits. */
  applyRigJson(rig: unknown) {
    const r = (rig && typeof rig === 'object' ? rig : {}) as { legs?: Record<string, { limitsDeg?: Record<string, { neg?: number; pos?: number }> }>; damage?: number[][]; turrets?: Record<string, { limits?: { yawDeg?: number[]; elevDeg?: number[] } }> };
    const D = THREE.MathUtils.degToRad;
    for (const L of this.legs) {
      const lj = r.legs?.[L.id]?.limitsDeg;
      if (!lj) continue;
      for (const k of ['coxa', 'hip', 'knee', 'ankle'] as const) { const l = lj[k]; if (l && typeof l.neg === 'number' && typeof l.pos === 'number') L.limits[k] = [D(l.neg), D(l.pos)]; }
    }
    if (Array.isArray(r.damage) && r.damage.length) this.damage = r.damage.filter((d) => Array.isArray(d) && d.length === 3).map((d) => new THREE.Vector3(d[0], d[1], d[2]));
    for (const T of this.turrets) {
      const tl = r.turrets?.[T.name]?.limits;
      if (tl?.elevDeg?.length === 2) T.elev = [D(tl.elevDeg[0]), D(tl.elevDeg[1])];
    }
  }
  /** Yaw / elevation limits per turret (scene.json voyage.turrets; SPEC D18: +-140 deg). */
  setTurretLimits(map: Record<string, { yawDeg?: [number, number]; elevDeg?: [number, number] }> | undefined) {
    if (!map) return;
    const D = THREE.MathUtils.degToRad;
    for (const T of this.turrets) {
      const m = map[T.name];
      if (m?.yawDeg) T.arc = D(Math.min(Math.abs(m.yawDeg[0]), Math.abs(m.yawDeg[1])));
      if (m?.elevDeg) T.elev = [D(m.elevDeg[0]), D(m.elevDeg[1])];
    }
  }

  /** Aim a turret at a ship-frame point with weight w (0 = rest); recoil 0..1 pushes the gun back. Returns true if in arc. */
  aim(T: TurretRig, target: THREE.Vector3 | null, w: number, recoil: number): boolean {
    let yaw = 0, pitch = 0, ok = false;
    if (target) {
      const P = shipPosNoUpdate(T.yaw.node, tv);
      const d = tv2.copy(target).sub(P);
      let dy = azOf(tv.copy(d).setY(0)) - T.az0;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      ok = Math.abs(dy) <= T.arc;
      const el = Math.atan2(d.y, Math.hypot(d.x, d.z)) - T.el0;
      yaw = Math.max(-T.arc, Math.min(T.arc, dy));
      pitch = Math.max(T.elev[0], Math.min(T.elev[1], el));
    }
    const k = Math.max(0, Math.min(1, w));
    T.yawNow = yaw * k; T.pitchNow = pitch * k;
    T.yaw.node.quaternion.copy(T.yaw.restQ).multiply(tq.setFromAxisAngle(T.yaw.axis, -T.yawNow));
    if (T.gun.node !== T.yaw.node) {
      T.gun.node.quaternion.copy(T.gun.restQ).multiply(tq.setFromAxisAngle(T.gun.axis, -T.pitchNow));
      // recoil along the barrel (in the gun's parent frame: the rest barrel direction rotated by the yaw)
      const back = tv.copy(T.dir0).applyQuaternion(tq2.setFromAxisAngle(UP, -T.yawNow));
      const pq = T.gun.node.parent ? shipQuatCached(T.gun.node.parent) : null;
      if (pq) back.applyQuaternion(pq);
      T.gun.node.position.copy(T.gunRestPos).addScaledVector(back, -0.6 * recoil);
    }
    return ok;
  }

  /** Can this turret point at a ship-frame point without hitting its yaw limit (pure: rest pivot + rest azimuth)? */
  inArc(T: TurretRig, x: number, z: number, slack = 0): boolean {
    let dy = Math.atan2(x - T.pivot.x, -(z - T.pivot.z)) - T.az0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    return Math.abs(dy) <= T.arc - slack;
  }

  /** Muzzle position + barrel direction (ship frame) right now. */
  muzzle(T: TurretRig, pos: THREE.Vector3, dir: THREE.Vector3) {
    T.muzzle.updateWorldMatrix(true, false);
    pos.copy(shipPosNoUpdate(T.muzzle, pos));
    const p0 = shipPosNoUpdate(T.gun.node, tv);
    dir.copy(pos).sub(p0).normalize();
  }

  /** Gangway: 0 = stowed, 1 = lowered. GLB contract: rotates about its local X by `gangwayDeg` (userData.lowerDeg, default
   *  -60 = the far end down); the placeholder's ramp first swings out (yaw) then tips down. */
  setGangway(k: number) {
    if (!this.gangway) return;
    const g = this.gangway.node, u = Math.max(0, Math.min(1, k));
    if (g.userData.voyagePlaceholder) {
      const a = Math.min(1, u / 0.5), b = Math.max(0, (u - 0.5) / 0.5);
      const e = (x: number) => x * x * (3 - 2 * x);
      g.quaternion.copy(this.gangway.restQ).multiply(tq.setFromAxisAngle(UP, (Math.PI / 2) * e(a))).multiply(tq2.setFromAxisAngle(tv.set(1, 0, 0), THREE.MathUtils.degToRad(60) * e(b)));
      return;
    }
    const deg = typeof g.userData.lowerDeg === 'number' ? g.userData.lowerDeg : -60;
    g.quaternion.copy(this.gangway.restQ).multiply(tq.setFromAxisAngle(tv.set(1, 0, 0), THREE.MathUtils.degToRad(deg) * u));
  }

  /** Lanterns swing against the hull's tilt (pitch / roll rad) + a lagged acceleration term. */
  setLanterns(pitch: number, roll: number) {
    for (const l of this.lanterns) l.node.quaternion.copy(l.restQ).multiply(tq.setFromEuler(te.set(-pitch * l.k, 0, -roll * l.k)));
  }

  /** scene.json `voyage.below.lanterns` (SPEC App. A: SWAY_TABLE_A/B, area-prefixed BELOW__ too) swing with weight k. */
  addLanterns(root: THREE.Object3D, names: string[] | undefined, k: number) {
    if (!names?.length) return;
    root.traverse((o) => {
      const n = o.name.replace(/^[A-Z]+__/, '');
      if (names.includes(n) && !this.lanterns.some((l) => l.node === o)) this.lanterns.push({ node: o, restQ: o.quaternion.clone(), k });
    });
  }

  reset() {
    for (const L of this.legs) {
      L.coxa?.node.quaternion.copy(L.coxa.restQ); L.hip.node.quaternion.copy(L.hip.restQ); L.knee.node.quaternion.copy(L.knee.restQ); L.ankle?.node.quaternion.copy(L.ankle.restQ);
    }
    for (const T of this.turrets) { T.yaw.node.quaternion.copy(T.yaw.restQ); T.gun.node.quaternion.copy(T.gun.restQ); T.gun.node.position.copy(T.gunRestPos); }
    if (this.gangway) this.gangway.node.quaternion.copy(this.gangway.restQ);
    for (const l of this.lanterns) l.node.quaternion.copy(l.restQ);
  }
}

// the ship frame is the room root's frame; the voyage keeps a reference for the cheap (no-update) helpers below
let SHIP: THREE.Object3D | null = null;
export const setShipFrame = (o: THREE.Object3D | null) => { SHIP = o; };
// per-frame scratch (no allocation in the rig's per-part loops)
const RA = new THREE.Vector3(), RB = new THREE.Vector3(), AD = new THREE.Vector3(), AS = new THREE.Vector3(), AP = new THREE.Vector3();
const AQ = new THREE.Quaternion(), AQ2 = new THREE.Quaternion(), AQ3 = new THREE.Quaternion(), SQ = new THREE.Quaternion(), SM = new THREE.Matrix4();
function shipPosNoUpdate(o: THREE.Object3D, out: THREE.Vector3) {
  o.updateWorldMatrix(true, false);                         // (one chain walk; the position is read off the matrix)
  out.setFromMatrixPosition(o.matrixWorld);
  return SHIP ? out.applyMatrix4(SM.copy(SHIP.matrixWorld).invert()) : out;
}
/** ship -> node-local rotation of `o` (inverse of node-local -> ship). The result is a shared scratch quaternion: use it
 *  at once. */
function shipQuatCached(o: THREE.Object3D) {
  o.updateWorldMatrix(true, false);                         // (after the yaw node turned: one walk, two turrets)
  o.matrixWorld.decompose(AP, SQ, AS);
  if (SHIP) { SHIP.matrixWorld.decompose(AP, AQ3, AS); SQ.premultiply(AQ3.invert()); }
  return SQ.invert();
}
/** Aim node o's +Y (relative to its rest rotation) at a world point; its world position and its parent's world matrix
 *  are current (one pass per leg in pistons()). */
function aimRest(o: THREE.Object3D, restQ: THREE.Quaternion, targetWorld: THREE.Vector3, selfWorld: THREE.Vector3) {
  const parent = o.parent;
  if (!parent) return;
  const dir = AD.copy(targetWorld).sub(selfWorld);
  if (dir.lengthSq() < 1e-8) return;
  // direction in the parent's frame, then in the node's REST frame
  parent.matrixWorld.decompose(AP, AQ, AS);
  dir.applyQuaternion(AQ.invert()).applyQuaternion(AQ2.copy(restQ).invert()).normalize();
  o.quaternion.copy(restQ).multiply(AQ.setFromUnitVectors(UP, dir));
}
export function aimY(o: THREE.Object3D, targetWorld: THREE.Vector3) {
  const parent = o.parent;
  if (!parent) return;
  parent.updateWorldMatrix(true, false);
  const p = o.getWorldPosition(new THREE.Vector3());
  const dir = targetWorld.clone().sub(p);
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();
  const pq = parent.getWorldQuaternion(new THREE.Quaternion());
  const qw = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  o.quaternion.copy(pq.invert().multiply(qw));
}

// ------------------------------------------------------------------------------------------------ placeholder ship
const COL = {
  iron: new THREE.Color('#3a3936'), ironDark: new THREE.Color('#232220'), rust: new THREE.Color('#5a3a24'),
  blue: new THREE.Color('#2747a8'), bone: new THREE.Color('#ede6d6'), brass: new THREE.Color('#c89b45'),
  deck: new THREE.Color('#6d5a42'), glass: new THREE.Color('#ffcf7a'), legs: new THREE.Color('#2b2c2e'), legHi: new THREE.Color('#55565a'),
};
function tint(g: THREE.BufferGeometry, c: THREE.Color | ((p: THREE.Vector3) => THREE.Color)): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const cc = typeof c === 'function' ? c(p) : c;
    col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  return geo;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color) {
  return tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
}
function cyl(rt: number, rb: number, h: number, seg: number, c: THREE.Color) { return tint(new THREE.CylinderGeometry(rt, rb, h, seg), c); }
/** A beam from a to b (box, w x w), in the frame where a / b are given. */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, c: THREE.Color, taper = 1) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(w * 0.5 * taper, w * 0.5, len, 6, 1);
  g.rotateY(Math.PI / 6);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().lerp(b, 0.5);
  g.translate(m.x, m.y, m.z);
  return tint(g, c);
}

/** Hull loft: sections along z with a rounded bilge; vertex colours: iron, blue + bone stripe, rusty bottom. */
function hullGeometry(): THREE.BufferGeometry {
  const zs: number[] = [];
  const Z0 = -20.8, Z1 = 15.9, NZ = 46, NC = 30;
  for (let i = 0; i <= NZ; i++) zs.push(Z0 + ((Z1 - Z0) * i) / NZ);
  const half = (z: number) => { const b = Math.min(1, (z - Z0) / 10); const s = Math.min(1, (Z1 - z) / 3.5); return 4.4 * Math.pow(Math.max(0.02, b), 0.55) * (0.82 + 0.18 * Math.max(0, s)); };
  const top = (z: number) => -3.0 + 2.4 * Math.pow(Math.max(0, (-6 - z) / 14.8), 2) + 1.1 * Math.pow(Math.max(0, (z - 6) / 9.9), 2);
  const bot = (z: number) => -8.2 + 4.6 * Math.pow(Math.max(0, (-12 - z) / 8.8), 1.6) + 1.4 * Math.pow(Math.max(0, (z - 9) / 6.9), 2);
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const cAt = (y: number, z: number) => (y < -6.4 + 0.02 * z - 0.1 ? COL.rust.clone().lerp(COL.ironDark, 0.5) : COL.iron);
  for (const z of zs) {
    const w = half(z), yt = top(z), yb = bot(z);
    for (let j = 0; j <= NC; j++) {
      // j: 0 = port gunwale, NC/2 = keel, NC = starboard gunwale
      const t = j / NC, a = (t - 0.5) * Math.PI;            // -pi/2 .. pi/2
      const sx = Math.sin(a), cy = Math.cos(a);
      const x = w * Math.sign(sx) * Math.pow(Math.abs(sx), 0.45);
      const y = yt - (yt - yb) * Math.pow(cy, 0.7);
      pos.push(x, y, z);
      const c = cAt(y, z);
      col.push(c.r, c.g, c.b);
    }
  }
  const row = NC + 1;
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NC; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // deck cap + bow / stern caps (fans)
  const base = pos.length / 3;
  for (let i = 0; i <= NZ; i++) { const z = zs[i]; const w = half(z), yt = top(z); pos.push(-w, yt, z, w, yt, z); col.push(COL.deck.r, COL.deck.g, COL.deck.b, COL.deck.r, COL.deck.g, COL.deck.b); }
  for (let i = 0; i < NZ; i++) { const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
  for (const i of [0, NZ]) {
    const c0 = pos.length / 3;
    const z = zs[i];
    pos.push(0, (top(z) + bot(z)) / 2, z); col.push(COL.iron.r, COL.iron.g, COL.iron.b);
    for (let j = 0; j < NC; j++) idx.push(...(i === 0 ? [c0, i * row + j, i * row + j + 1] : [c0, i * row + j + 1, i * row + j]));
  }
  // the blue + bone waterline belt (its own strips: crisp at any mesh density), 3 cm proud of the plating
  const xAt = (z: number, y: number) => {
    const w = half(z), yt = top(z), yb = bot(z);
    if (y >= yt) return w; if (y <= yb) return 0;
    const cy = Math.pow((yt - y) / (yt - yb), 1 / 0.7);           // invert y = yt - (yt - yb) * cy^0.7
    const sx = Math.sqrt(Math.max(0, 1 - cy * cy));
    return w * Math.pow(sx, 0.45);
  };
  for (const [y0, y1, c] of [[-6.5, -6.15, COL.blue], [-6.15, -5.95, COL.bone]] as [number, number, THREE.Color][]) for (const side of [-1, 1]) {
    const b0 = pos.length / 3;
    for (const z of zs) {
      const dy = 0.02 * z;
      pos.push(side * (xAt(z, y0 + dy) + 0.03), y0 + dy, z, side * (xAt(z, y1 + dy) + 0.03), y1 + dy, z);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let i = 0; i < NZ; i++) { const a = b0 + i * 2; if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

/** The placeholder walking ship (procedural, ~40 draws): hull, deckhouse, wheelhouse, menorah mast, rails, awning,
 *  two turrets and six legs with the node contract above. opts.deck = also draw a show-deck floor (demo rooms). */
export function buildPlaceholderShip(opts: { deck?: boolean; awning?: boolean } = {}): THREE.Group {
  const root = new THREE.Group(); root.name = 'VOYAGE_PLACEHOLDER';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.35, name: 'vtp:voyage:ship' });
  const glow = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: new THREE.Color('#ffb46a'), emissiveIntensity: 0.9, name: 'EMIT_lamp_voyage' });
  const menorah = new THREE.MeshStandardMaterial({ color: '#c89b45', roughness: 0.4, metalness: 0.7, emissive: new THREE.Color('#ffcf6a'), emissiveIntensity: 0.4, name: 'EMIT_menorah' });
  const parts: THREE.BufferGeometry[] = [hullGeometry()];
  // superstructure
  parts.push(box(5.2, 3.1, 14.3, 0, -1.85 - 0.0, -3.45, COL.iron));                 // deckhouse (top at -0.3)
  parts.push(box(7.2, 1.5, 8.3, 0, -2.65, 7.85, COL.iron));                         // aft cargo deck block
  parts.push(box(5.4, 3.4, 5.8, 0, 1.4, -7.2, COL.iron));                           // wheelhouse
  parts.push(box(5.8, 0.25, 6.3, 0, 3.2, -7.2, COL.ironDark));                      // wheelhouse roof
  parts.push(box(2.6, 1.6, 2.4, 0, -1.9, -16.5, COL.ironDark));                     // fore gun plinth
  // the wheelhouse's aft wall = the show backdrop: a door (centre), portholes, a brass sign band, rivet strips
  parts.push(box(1.0, 2.0, 0.08, 0, 1.0, -4.27, COL.deck), box(1.16, 0.08, 0.1, 0, 2.04, -4.26, COL.brass));
  for (const x of [-2.3, -1.6, 1.6, 2.3]) parts.push(box(0.05, 3.3, 0.12, x, 1.65, -4.26, COL.ironDark));
  parts.push(box(5.3, 0.32, 0.1, 0, 2.75, -4.26, COL.brass), box(5.3, 0.08, 0.1, 0, 0.06, -4.26, COL.brass));
  parts.push(box(2.4, 1.0, 2.6, 0, -1.6, 10.7, COL.ironDark));                      // aft gun deck plate
  if (opts.deck) parts.push(box(5.0, 0.3, 8.2, 0, -0.15, 0.1, COL.deck), box(1.5, 0.3, 6, -3.25, -0.15, 0, COL.deck), box(1.5, 0.3, 6, 3.25, -0.15, 0, COL.deck));
  // rails round the show deck (posts + brass top rail), open at the wheelhouse door
  const rail = (a: THREE.Vector3, b: THREE.Vector3) => { parts.push(beam(a, b, 0.07, COL.brass)); const n = Math.max(1, Math.round(a.distanceTo(b) / 1.2)); for (let i = 0; i <= n; i++) { const p = a.clone().lerp(b, i / n); parts.push(beam(new THREE.Vector3(p.x, 0, p.z), p, 0.05, COL.ironDark)); } };
  const R = 0.95;
  rail(new THREE.Vector3(-4.0, R, -3.0), new THREE.Vector3(-4.0, R, 3.0)); rail(new THREE.Vector3(4.0, R, -3.0), new THREE.Vector3(4.0, R, 3.0));
  rail(new THREE.Vector3(-4.0, R, 3.0), new THREE.Vector3(-2.5, R, 4.1)); rail(new THREE.Vector3(4.0, R, 3.0), new THREE.Vector3(2.5, R, 4.1));
  rail(new THREE.Vector3(-2.5, R, 4.1), new THREE.Vector3(2.5, R, 4.1));
  // awning: posts + striped roof (blue / bone), named awning_cloth (environment: cloth flutter)
  if (opts.awning !== false) {
    for (const [x, z] of [[-2.3, -3.9], [2.3, -3.9], [-2.3, 3.9], [2.3, 3.9]]) parts.push(beam(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 3.15, z), 0.12, COL.brass));
  }
  // wheelhouse windows (lamp-lit at night: EMIT_lamp_voyage) + the menorah mast
  const lit: THREE.BufferGeometry[] = [];
  for (const x of [-1.8, -0.6, 0.6, 1.8]) lit.push(box(0.95, 0.9, 0.05, x, 2.05, -10.12, COL.glass));
  for (const x of [-1.95, -1.15, 1.15, 1.95]) lit.push(tint(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 14).rotateX(Math.PI / 2).translate(x, 1.55, -4.24), COL.glass));
  for (const z of [-9.2, -7.9, -6.6, -5.3]) { lit.push(box(0.05, 0.9, 0.95, -2.72, 2.05, z, COL.glass)); lit.push(box(0.05, 0.9, 0.95, 2.72, 2.05, z, COL.glass)); }
  for (const z of [-2.5, 0.5, 3.0]) { lit.push(box(0.05, 0.6, 0.8, -2.62, -1.6, z, COL.glass)); lit.push(box(0.05, 0.6, 0.8, 2.62, -1.6, z, COL.glass)); }
  const mast: THREE.BufferGeometry[] = [];
  mast.push(tint(new THREE.CylinderGeometry(0.08, 0.1, 2.0, 8).translate(0, 4.3, -8.2), COL.brass));
  for (let i = -3; i <= 3; i++) {
    const x = i * 0.32, h = i === 0 ? 1.15 : 0.75 - Math.abs(i) * 0.04;
    if (i !== 0) mast.push(tint(new THREE.TorusGeometry(Math.abs(x) / 2, 0.035, 6, 12, Math.PI).rotateZ(Math.PI).translate(x / 2, 4.95, -8.2), COL.brass));
    mast.push(tint(new THREE.CylinderGeometry(0.05, 0.05, h, 6).translate(x, 4.95 + h / 2, -8.2), COL.brass));
    mast.push(tint(new THREE.SphereGeometry(0.09, 8, 6).translate(x, 4.95 + h + 0.05, -8.2), COL.glass));
  }
  const hull = new THREE.Mesh(mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!, mat); hull.name = 'VOYAGE_HULL';
  const lamps = new THREE.Mesh(mergeGeometries(lit, false)!, glow); lamps.name = 'VOYAGE_LAMPS';
  const men = new THREE.Mesh(mergeGeometries(mast.map((g) => (g.index ? g.toNonIndexed() : g)), false)!, menorah); men.name = 'MENORAH';
  root.add(hull, lamps, men);
  if (opts.awning !== false) {
    const aw = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, name: 'awning_cloth' });
    const g = new THREE.PlaneGeometry(4.9, 8.2, 14, 1).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setY(i, 3.2 + 0.18 * Math.cos((p.getX(i) / 4.9) * Math.PI));
    g.computeVertexNormals();
    const roof = new THREE.Mesh(tint(g.translate(0, 0, 0), (q) => (Math.floor((q.x + 2.45) / 0.7) % 2 ? COL.bone : COL.blue)), aw);
    roof.name = 'VOYAGE_AWNING';
    root.add(roof);
  }
  // turrets
  PLACEHOLDER_GUNS.forEach((G, i) => {
    const n = i + 1;
    const yaw = new THREE.Group(); yaw.name = `TURRET_${n}`; yaw.position.fromArray(G.yaw);
    const gun = new THREE.Group(); gun.name = `TURRET_${n}_GUN`; gun.position.fromArray(G.pitch).sub(yaw.position);
    const muz = new THREE.Object3D(); muz.name = `TURRET_${n}_MUZZLE`; muz.position.fromArray(G.muzzle).sub(new THREE.Vector3().fromArray(G.pitch));
    const fwd = Math.sign(G.muzzle[2] - G.pitch[2]);
    const tb = mergeGeometries([
      tint(new THREE.CylinderGeometry(1.15, 1.3, 0.7, 14).translate(0, 0.35, 0), COL.ironDark),
      box(2.1, 1.25, 2.0, 0, 1.25, -0.2 * fwd, COL.iron),
      box(2.2, 0.9, 0.25, 0, 1.25, 0.9 * fwd, COL.iron),
    ], false)!;
    yaw.add(new THREE.Mesh(tb, mat));
    const bl = G.pitch[2] - G.muzzle[2];
    const barrel = tint(new THREE.CylinderGeometry(G.r, G.r * 1.25, Math.abs(bl) + 0.6, 10).rotateX(Math.PI / 2).translate(0, 0, (G.muzzle[2] - G.pitch[2]) / 2 + 0.3 * -fwd), COL.ironDark);
    const mant = box(0.7, 0.7, 0.9, 0, 0, -0.1 * fwd, COL.iron);
    gun.add(new THREE.Mesh(mergeGeometries([barrel, mant], false)!, mat));
    gun.add(muz); yaw.add(gun); root.add(yaw);
  });
  // legs (contract hierarchy, pivots at the measured joints, rest rotations = identity)
  for (const [id, P] of Object.entries(PLACEHOLDER_LEGS)) {
    const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
    const C = V(P.C), H = V(P.H), K = V(P.K), A = V(P.A), F = V(P.F);
    const coxa = new THREE.Group(); coxa.name = `LEG_${id}_COXA`; coxa.position.copy(C);
    const hip = new THREE.Group(); hip.name = `LEG_${id}_HIP`; hip.position.copy(H).sub(C);
    const knee = new THREE.Group(); knee.name = `LEG_${id}_KNEE`; knee.position.copy(K).sub(H);
    const ankle = new THREE.Group(); ankle.name = `LEG_${id}_ANKLE`; ankle.position.copy(A).sub(K);
    const foot = new THREE.Object3D(); foot.name = `LEG_${id}_FOOT`; foot.position.copy(F).sub(A);
    const out = Math.sign(C.x);
    coxa.add(new THREE.Mesh(mergeGeometries([cyl(1.05, 1.2, 1.5, 16, COL.legs).translate(0, -0.2, 0), cyl(0.7, 0.7, 0.4, 12, COL.legHi).translate(0, -1.05, 0)], false)!, mat));
    const z0 = new THREE.Vector3();
    hip.add(new THREE.Mesh(mergeGeometries([
      beam(z0, K.clone().sub(H), 0.95, COL.legs, 0.8),
      tint(new THREE.SphereGeometry(0.62, 10, 8), COL.legHi),
    ], false)!, mat));
    knee.add(new THREE.Mesh(mergeGeometries([
      beam(z0, A.clone().sub(K), 0.8, COL.legs, 0.7),
      tint(new THREE.SphereGeometry(0.55, 10, 8), COL.legHi),
    ], false)!, mat));
    const sole = P.sole;
    const fo = F.clone().sub(A);
    ankle.add(new THREE.Mesh(mergeGeometries([
      tint(new THREE.SphereGeometry(0.42, 8, 6), COL.legHi),
      beam(z0, fo.clone().add(new THREE.Vector3(0, 0.35, 0)), 0.5, COL.legs),
      box(sole[1], 0.42, sole[0], fo.x, fo.y + 0.21, fo.z, COL.ironDark),
      box(sole[1] * 0.8, 0.2, sole[0] * 0.6, fo.x, fo.y + 0.52, fo.z, COL.legs),
    ], false)!, mat));
    ankle.add(foot);
    // pistons: P1 coxa knuckle -> tibia lever (drives the knee), P2 tibia lever -> foot heel (drives the ankle)
    const p1c = new THREE.Object3D(); p1c.name = `LEG_${id}_P1_CYL`; p1c.position.set(0.0, -1.1, 0).add(H.clone().sub(C).multiplyScalar(0.6));
    const p1r = new THREE.Object3D(); p1r.name = `LEG_${id}_P1_ROD`; p1r.position.copy(V(P.p1)).sub(K).add(new THREE.Vector3(0, -0.5, 0));
    const p2c = new THREE.Object3D(); p2c.name = `LEG_${id}_P2_CYL`; p2c.position.copy(V(P.p2t)).sub(K).add(new THREE.Vector3(0.25 * out, -0.4, 0));
    const p2r = new THREE.Object3D(); p2r.name = `LEG_${id}_P2_ROD`; p2r.position.copy(V(P.p2f)).sub(A).add(new THREE.Vector3(0.25 * out, 0.1, 0));
    p1c.add(new THREE.Mesh(cyl(0.26, 0.26, 2.4, 8, COL.legHi).translate(0, 1.2, 0), mat));
    p1r.add(new THREE.Mesh(cyl(0.14, 0.14, 2.4, 8, COL.brass).translate(0, 1.2, 0), mat));
    p2c.add(new THREE.Mesh(cyl(0.22, 0.22, 1.8, 8, COL.legHi).translate(0, 0.9, 0), mat));
    p2r.add(new THREE.Mesh(cyl(0.12, 0.12, 1.8, 8, COL.brass).translate(0, 0.9, 0), mat));
    coxa.add(p1c); knee.add(p1r); knee.add(p2c); ankle.add(p2r);
    knee.add(ankle); hip.add(knee); coxa.add(hip); root.add(coxa);
  }
  // hit sites + a gangway (starboard aft) + the bow marker
  PLACEHOLDER_DAMAGE.forEach((p, i) => { const o = new THREE.Object3D(); o.name = `DAMAGE_${String(i + 1).padStart(2, '0')}`; o.position.fromArray(p); root.add(o); });
  // gangway: hinge on the starboard hull side, plank along local +Z (outboard); stowed = standing up, lowered = 50 deg down
  const gw = new THREE.Group(); gw.name = 'GANGWAY'; gw.position.set(3.75, -3.05, 4.2); gw.userData.voyagePlaceholder = true;
  gw.add(new THREE.Mesh(mergeGeometries([box(1.2, 0.12, 8.0, 0, 0, 4.0, COL.deck), box(0.06, 0.6, 8.0, 0.6, 0.3, 4.0, COL.brass), box(0.06, 0.6, 8.0, -0.6, 0.3, 4.0, COL.brass)], false)!, mat));
  root.add(gw);
  const bow = new THREE.Object3D(); bow.name = 'VOYAGE_BOW'; bow.position.set(0, 0, -10); root.add(bow);
  root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return root;
}

/** Bounding radius / box of the placeholder (cameras keep out of it). */
export const PLACEHOLDER_BOUNDS = new THREE.Box3(new THREE.Vector3(-9.5, -12.8, -21.5), new THREE.Vector3(9.5, 6.0, 16.5));
void tm;

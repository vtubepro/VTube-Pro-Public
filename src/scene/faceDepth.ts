// The DRAWN face (framing guarantee, src/scene/frameGuard.ts + src/scene/camEval.ts + every solver that frames people).
//
// The face the runtime reports (AvatarRuntime.faceInfo) is a face ANCHOR: the procedural eye / mouth markers, the VRM eye
// bones, else the head bone. For most avatars that box is the face. For some it is not: a mascot whose eye bones sit
// close together deep inside a big head reports a box that spans the space between the eyes, centred inside the head
// (one model: about a third of the face width, 2.5 face sizes behind its surface). Framing that box keeps the wrong thing
// in the shot and cuts the real eyes at the frame edge.
//
// So the drawn face is measured ONCE per avatar, at rest (measureRest in src/scene/actor.ts, the anchor at identity,
// before any tracking: every page measures the same thing), from the head's own vertices and the profile's markers:
//   1. the face surface in front of the anchor (the vertices inside the reported face column);
//   2. the eye markers on the surface (profile eyes.left / right and the mouth, whatever the eye mode): when the eyes or
//      the mouth lie outside the reported box (a robot's mouth far below its eyes), or the anchor sits deep inside the
//      head, the box grows (and moves the least it must) to hold both eyes, the brows and the mouth with a chin;
//   3. no markers, the anchor far inside the head (deeper than any human's nose / bangs / hat brim) behind a face-wide
//      surface: centred on that surface and sized by the depth (a round head: its surface is as far in front of its
//      middle as its sides are).
// Otherwise it IS the reported face (bit for bit: nothing changes for those avatars). A corrected face is pinned to the
// head bone (or the model), so it follows the live head exactly like the anchor does. `depth` = how far the drawn
// surface still sits in front of the centre: line-of-sight tests aim at it (onFaceSurface), never through the head.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
/** The face box round a face centre in face sizes (shared/framing.ts FACE_BOX, kept local: no import cycle). */
const SIDE = 0.6, DOWN = 0.8, UPK = 1.15;

/** What the measure reads from a runtime (AvatarRuntime, a TV runtime: anything with a model and a face anchor). */
export interface FaceSource {
  model: THREE.Object3D;
  faceInfo(): { center: THREE.Vector3; size: number } | undefined;
  profile?: unknown;
  humanoid?: unknown;
}

/** At most this many face sizes in front of the centre for an UNcorrected face (a stray vertex — a held prop — never
 *  counts as the face). */
const MAX_K = 2.5;
/** The anchor counts as deep inside the head past this many face sizes behind the surface (with eye markers to move to);
 *  without markers only past DEEP_BARE (a VRoid's bangs / a hat brim can stand 0.8 face sizes in front of its eyes). */
const DEEP_K = 0.6, DEEP_BARE = 1.5;

/** A drawn face, measured at rest. `fix` null = the reported face is the drawn face. */
interface DrawnFix {
  /** depth / drawn size (the surface in front of the drawn centre). */
  depthK: number;
  fix: { node: THREE.Object3D; local: THREE.Vector3; k: number; why: string } | null;
}
const drawnMemo = new WeakMap<object, DrawnFix>();

/** The measure's result in world space (at rest), and why it differs from the reported face (null: it doesn't). */
export interface DrawnRest { center: THREE.Vector3; size: number; depth: number; why: string | null }

/** The head's vertices (skinned or bone-attached meshes; at most ~24k sampled), world space. */
function headVerts(model: THREE.Object3D): Float32Array {
  const meshes: THREE.Mesh[] = [];
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !m.geometry?.attributes?.position) return;
    let boned = !!(m as THREE.SkinnedMesh).isSkinnedMesh;
    for (let p = m.parent; p && !boned; p = p.parent) if ((p as THREE.Bone).isBone) boned = true;
    if (boned) meshes.push(m);
  });
  const total = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
  if (!total) return new Float32Array(0);
  const step = Math.max(1, Math.ceil(total / 24000));
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const sk = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh) : null;
    for (let i = 0; i < pos.count; i += step) {
      if (sk) sk.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  return new Float32Array(out);
}

/** The front-most vertex (along `fwd`) inside a column round `c` (|x| <= hx, -dn <= y <= up, z <= cap): its depth
 *  (-Infinity: none) and how many vertices the column holds; with `band`, the widest |x| of the head's vertices within
 *  `band` of that front (at the column's heights): a face-wide surface, not a prop held up in front of a face. */
function frontOf(vs: Float32Array, c: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3, hx: number, up: number, dn: number, cap: number, band = 0) {
  let front = -Infinity, n = 0;
  const d = new THREE.Vector3();
  for (let i = 0; i < vs.length; i += 3) {
    d.set(vs[i] - c.x, vs[i + 1] - c.y, vs[i + 2] - c.z);
    if (Math.abs(d.dot(right)) > hx || d.y > up || d.y < -dn) continue;
    const z = d.dot(fwd);
    if (z > cap) continue;
    n++;
    if (z > front) front = z;
  }
  let wide = 0;
  if (band > 0 && Number.isFinite(front)) {
    for (let i = 0; i < vs.length; i += 3) {
      d.set(vs[i] - c.x, vs[i + 1] - c.y, vs[i + 2] - c.z);
      if (d.y > up || d.y < -dn) continue;
      const z = d.dot(fwd);
      if (z < front - band || z > cap) continue;
      wide = Math.max(wide, Math.abs(d.dot(right)));
    }
  }
  return { front, n, wide };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
function markerPos(m: unknown): THREE.Vector3 | null {
  const p = m && typeof m === 'object' ? (m as { position?: unknown }).position : null;
  if (!Array.isArray(p) || p.length !== 3) return null;
  const v = new THREE.Vector3(num(p[0]), num(p[1]), num(p[2]));
  return Number.isFinite(v.x + v.y + v.z) ? v : null;
}

/** The profile's eye / mouth markers in world space (model space × the model's matrix, as AvatarRuntime.toWorld), when
 *  both eyes are there; `eyeR` = the profile's eye size (world m, NaN: none). */
function markersOf(rt: FaceSource): { l: THREE.Vector3; r: THREE.Vector3; mouth: THREE.Vector3 | null; eyeR: number } | null {
  const p = rt.profile && typeof rt.profile === 'object' ? (rt.profile as { eyes?: Record<string, unknown>; mouth?: Record<string, unknown> }) : null;
  const l = markerPos(p?.eyes?.left), r = markerPos(p?.eyes?.right);
  if (!l || !r) return null;
  const mw = rt.model.matrixWorld;
  const sc = Math.abs(new THREE.Vector3().setFromMatrixScale(mw).x);
  const m = markerPos(p?.mouth?.center);
  return { l: l.applyMatrix4(mw), r: r.applyMatrix4(mw), mouth: m ? m.applyMatrix4(mw) : null, eyeR: num(p?.eyes?.size) * sc };
}

/** Measure the drawn face of a runtime at rest (with the avatar unposed: measureRest). `fwd0` = the avatar's facing
 *  (world), `height` its measured height (m). Remembers the result for drawnFace / faceDepthOf. */
export function measureDrawn(rt: FaceSource, fwd0: THREE.Vector3, height: number): DrawnRest | null {
  let f: { center: THREE.Vector3; size: number } | undefined;
  try { f = rt.faceInfo(); } catch { f = undefined; }
  if (!f || !(f.size > 0) || !rt.model) return null;
  const c = f.center.clone(), s = f.size;
  const fwd = fwd0.clone().setY(0);
  if (fwd.lengthSq() < 1e-8) return null;
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const vs = headVerts(rt.model);
  const H = Math.max(1e-3, height);
  // 1. the surface in front of the reported centre (as before: within 2.5 face sizes)
  const col = frontOf(vs, c, fwd, right, s * SIDE, s * 0.6, s * DOWN, s * MAX_K);
  const k0 = col.n >= 4 && Number.isFinite(col.front) ? THREE.MathUtils.clamp(col.front / s, 0, MAX_K) : 0;
  const plain = (): DrawnRest => { drawnMemo.set(rt, { depthK: k0, fix: null }); return { center: c, size: s, depth: k0 * s, why: null }; };
  // (deep: the surface in front of the anchor up to half the avatar's height away — a big head's middle can sit more
  // than 2.5 of its tiny eye-bone face sizes behind the face)
  const reach = Math.max(s * MAX_K, H * 0.5);
  const far = frontOf(vs, c, fwd, right, s * SIDE, s * 0.6, s * DOWN, reach);
  const d0 = far.n >= 4 && Number.isFinite(far.front) ? far.front : 0;
  const deep = d0 > s * DEEP_K;
  // 2. the eye markers on the surface (plausible ones: level, beside each other, near the reported face): the box must
  // hold both eyes (and the brows over them) and the mouth with a chin under it
  const mk = markersOf(rt);
  let center: THREE.Vector3 | null = null, size = s, why = '';
  if (mk) {
    const ipd = mk.l.distanceTo(mk.r), mid = mk.l.clone().add(mk.r).multiplyScalar(0.5);
    const across = Math.abs(mk.l.clone().sub(mk.r).dot(right));
    const ok = ipd > 1e-4 && ipd < H * 0.6 && across > ipd * 0.8 && Math.abs(mk.l.y - mk.r.y) < ipd * 0.35 && mid.distanceTo(c) < Math.max(s * 4, H * 0.25);
    const eyeR = Number.isFinite(mk.eyeR) && mk.eyeR > 0 ? THREE.MathUtils.clamp(mk.eyeR, ipd * 0.12, ipd * 0.4) : ipd * 0.22;
    const halfW = ipd / 2 + eyeR, up = eyeR * 1.6;
    const down = mk.mouth && mk.mouth.y < mid.y && mid.y - mk.mouth.y < ipd * 3 ? (mid.y - mk.mouth.y) * 1.3 : 0;
    const eyesOut = halfW > SIDE * s * 0.95;
    const mouthOut = down > 0 && mid.y - down < c.y - DOWN * s;
    if (ok && (eyesOut || mouthOut || deep)) {
      size = Math.max(s, halfW / (SIDE * 0.92), (up + down) / ((UPK + DOWN) * 0.92));
      // (vertically: the reported eye line — the eye level for a deep anchor — moved as little as holds both)
      const lo = mid.y + up - UPK * size * 0.96, hi = mid.y - down + DOWN * size * 0.96;
      const cy = lo <= hi ? THREE.MathUtils.clamp(deep ? mid.y : c.y, lo, hi) : (lo + hi) / 2;
      // (across / in depth: on the markers (the surface) for a deep anchor, else where it was reported)
      center = deep ? new THREE.Vector3(mid.x, cy, mid.z) : new THREE.Vector3(c.x, cy, c.z);
      why = `eye markers: ${[eyesOut ? 'eyes outside the reported face' : '', mouthOut ? 'mouth below it' : '', deep ? 'a deep face anchor' : ''].filter(Boolean).join(', ')} (ipd ${ipd.toFixed(3)} m, reported size ${s.toFixed(3)} m → ${size.toFixed(3)} m)`;
    }
  }
  // 3. no markers: an anchor far inside the head (deeper than any nose / bangs / hat brim of a human face: DEEP_BARE)
  // behind a face-wide surface (never a prop held up in front of a face: too narrow)
  if (!center && !mk && d0 > s * DEEP_BARE) {
    const band = frontOf(vs, c, fwd, right, s * SIDE, s * 0.6, s * DOWN, reach, d0 * 0.25);
    if (band.wide > d0 * 0.45) {
      center = c.clone().addScaledVector(fwd, d0 * 0.85);
      size = Math.max(s, d0 * 1.45);
      why = `face anchor ${(d0 / s).toFixed(1)} face sizes behind the surface`;
    }
  }
  if (!center) return plain();
  // the surface still in front of the drawn centre (a snout, a nose): line of sight aims at it
  const fr = frontOf(vs, center, fwd, right, size * 0.35, size * 0.3, size * DOWN, size * 0.6);
  const depth = fr.n >= 4 && Number.isFinite(fr.front) ? THREE.MathUtils.clamp(fr.front, 0, size * 0.5) : 0;
  const hum = rt.humanoid as { getRawBoneNode?: (n: string) => THREE.Object3D | null } | null | undefined;
  let node: THREE.Object3D = rt.model;
  try { node = hum?.getRawBoneNode?.('head') ?? rt.model; } catch { node = rt.model; }
  node.updateWorldMatrix(true, false);
  drawnMemo.set(rt, { depthK: depth / size, fix: { node, local: node.worldToLocal(center.clone()), k: size / s, why } });
  return { center, size, depth, why };
}

/** The drawn face now (world, live: follows the head), or undefined when the runtime has no face. Avatars whose
 *  reported face is the drawn face get exactly faceInfo() (+ the measured surface depth). `head` = where the head's
 *  volume is centred for occlusion (the reported anchor; the face itself when uncorrected). */
export function drawnFace(rt: FaceSource | null | undefined): { center: THREE.Vector3; size: number; depth: number; head: THREE.Vector3 } | undefined {
  if (!rt) return undefined;
  let f: { center: THREE.Vector3; size: number } | undefined;
  try { f = rt.faceInfo(); } catch { f = undefined; }
  if (!f) return undefined;
  const d = drawnMemo.get(rt);
  if (!d) return { center: f.center, size: f.size, depth: lazyDepth(rt, f), head: f.center };
  if (!d.fix) return { center: f.center, size: f.size, depth: d.depthK * f.size, head: f.center };
  const n = d.fix.node;
  n.updateWorldMatrix(true, false);
  const size = f.size * d.fix.k;
  // (`head`: the middle of the head the body volumes go round — the reported anchor, inside the head — never the face
  // surface: a head sphere centred on the face would stand out in front of it)
  return { center: n.localToWorld(d.fix.local.clone()), size, depth: d.depthK * size, head: f.center };
}

/** Why a runtime's drawn face differs from the reported one (null: it doesn't, or it was never measured). */
export function drawnWhy(rt: object | null | undefined): string | null { return rt ? drawnMemo.get(rt)?.fix?.why ?? null : null; }

/** The face surface's depth in front of the DRAWN face centre (m, world), measured at rest (measureRest): the same on
 *  every page, whatever the avatar was doing when a solver first asked. 0 = unknown / a flat source (TV, standee). */
export function faceDepthOf(rt: FaceSource | null | undefined, forward?: THREE.Vector3): number {
  void forward;
  return drawnFace(rt)?.depth ?? 0;
}

/** Runtimes measureRest never saw (a test object): measured once, from the current pose. */
const lazy = new WeakMap<object, number>();
function lazyDepth(rt: FaceSource, f: { center: THREE.Vector3; size: number }): number {
  const k = lazy.get(rt);
  if (k !== undefined) return k * f.size;
  let kk = 0;
  if (rt.model) {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rt.model.getWorldQuaternion(new THREE.Quaternion())).setY(0);
    if (fwd.lengthSq() > 1e-8) {
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      const col = frontOf(headVerts(rt.model), f.center, fwd, right, f.size * SIDE, f.size * 0.6, f.size * DOWN, f.size * MAX_K);
      kk = col.n >= 4 && Number.isFinite(col.front) ? THREE.MathUtils.clamp(col.front / f.size, 0, MAX_K) : 0;
    }
  }
  lazy.set(rt, kk);
  return kk * f.size;
}

/** A face point moved towards the camera onto the face surface (by `depth`, weighed by how much the face looks at the
 *  camera: seen from the side, the surface is no nearer than the centre). Never past the camera. */
export function onFaceSurface(q: THREE.Vector3, cam: THREE.Vector3, depth: number, forward?: THREE.Vector3 | null): THREE.Vector3 {
  if (!(depth > 0)) return q;
  const to = cam.clone().sub(q);
  const L = to.length();
  if (L < 1e-6) return q;
  to.divideScalar(L);
  const w = forward ? Math.max(0, forward.clone().setY(0).normalize().dot(to.clone().setY(0).normalize())) : 1;
  const m = Math.min(depth * w, L * 0.5);
  return m > 0 ? q.clone().addScaledVector(to, m) : q;
}

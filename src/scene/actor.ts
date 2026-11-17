// SceneActor: one performer in a room — real-world height normalisation, spot placement, and the
// seated pose (thighs forward, knees bent, feet down) applied UNDER the upper-body tracking.
//
// Hierarchy:  room space → actor.mount (floor position + facing yaw; movers animate THIS)
//                        → actor.lift  (seat drop, normalising scale × appear)
//                        → the output slot's anchor (identity) → AvatarRuntime.wrapper → model
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import type { SpotInfo } from './contract.ts';
import { avatarSize, shownScaleFor, spotFit, type AvatarSize } from '../../shared/avatarSize.ts';
import { buildCushion, buildStep, planSeat, planStep, type SeatBoost, type SeatEnv } from './sizeSeat.ts';
import { analyzeDrape, SeatDrape } from '../avatar/seatDrape.ts';
import { mechParkDistance, type ParkRays } from './mechPark.ts';
import { measureDrawn } from './faceDepth.ts';
import { STRAY_GAP, implausible, skeletonHeight, verticalGap } from './restHeight.ts';

/** Measured once per loaded runtime while its anchor is still detached at identity (see measureRest). */
export interface RestMetrics {
  /** Standing height (m, anchor space) and the floor under the feet. */
  height: number;
  floorY: number;
  /** Set when the bounding box was implausible for the skeleton (stray geometry far above / below: a particle plane,
   *  a hidden floor) and the height was taken from the humanoid joints instead. */
  heightFix?: string;
  /** Hips joint (anchor space), when the rig has one. */
  hips: THREE.Vector3 | null;
  /** Face centre (anchor space) + size — for the talk cameras. */
  face: { center: THREE.Vector3; size: number };
  /** The DRAWN face at rest (anchor space): `face` itself for most avatars; a mascot whose face anchor (eye bones deep in
   *  a big head) isn't its face gets the face it shows (src/scene/faceDepth.ts). `depth` = the surface in front of the
   *  centre (m). Framing (shot solvers, the framing guarantee, cam_eval) frames THIS. */
  drawn?: { center: THREE.Vector3; size: number; depth: number; why: string | null };
  /** The whole model's box at rest (anchor space): a mech hull's body for framing — never the live bounds, which an
   *  idle wing beat or a gait changes from frame to frame (pages would solve different shots). */
  box?: THREE.Box3;
  /** The real head (every vertex above the chin: hair, ears, hats, a mascot's whole head / costume sign), anchor
   *  space: its top above the face centre and its horizontal half-extent. Framing keeps all of it in the shot (a face
   *  measure can be the eyes only; a skeleton-measured height can end at the face). Absent when unmeasurable. */
  head?: { top: number; half: number };
  /** `head` is the exact head (a 2D card: measured on the picture by its source), so the rest box — the whole card
   *  picture with its margins — says nothing about where the head ends (restTopAbove). */
  headExact?: true;
  /** A 2D card: the art it draws (anchor space, at rest, standing) and whether it is a bust — cams frame the whole art,
   *  bottom-anchored (src/scene/stage/tileCams.ts), never a guessed human bust. */
  card?: { box: THREE.Box3; bust: boolean };
  /** Humanoid legs → the seated pose can bend them. */
  legs: { toNorm: THREE.Quaternion; left: LegRest | null; right: LegRest | null } | null;
  /** Humanoid rigs: avatar (anchor) space → normalized-rig space rotation, and every humanoid joint's rest
   *  position in anchor space (the walk cycle's leg / arm geometry, src/scene/locomotion.ts). */
  toNorm: THREE.Quaternion | null;
  joints: Record<string, THREE.Vector3>;
}
interface LegRest { upper: THREE.Vector3; lower: THREE.Vector3; hasFoot: boolean }

const I = new THREE.Quaternion();
const rest = new WeakMap<AvatarRuntime, RestMetrics>();

/** Call right after AvatarRuntime.load(), before its anchor is placed anywhere (anchor at identity). */
export function measureRest(rt: AvatarRuntime): RestMetrics {
  rt.anchor.updateWorldMatrix(true, true);
  const box = rt.bounds();
  const size = box.getSize(new THREE.Vector3());
  let height = size.y > 1e-4 ? size.y : 1.6;
  let floorY = Number.isFinite(box.min.y) ? box.min.y : 0;
  const toAnchor = rt.anchor.matrixWorld.clone().invert();
  const hipsNode = rt.humanoid?.getRawBoneNode('hips') ?? null;
  const hips = hipsNode ? hipsNode.getWorldPosition(new THREE.Vector3()).applyMatrix4(toAnchor) : null;
  const fi = rt.faceInfo();
  const face = fi
    ? { center: fi.center.clone().applyMatrix4(toAnchor), size: fi.size }
    : { center: new THREE.Vector3(box.getCenter(new THREE.Vector3()).x, floorY + height * 0.88, box.getCenter(new THREE.Vector3()).z), size: height * 0.16 };
  let legs: RestMetrics['legs'] = null;
  let toNorm: THREE.Quaternion | null = null;
  const joints: Record<string, THREE.Vector3> = {};
  const h = rt.humanoid;
  if (h) {
    for (const name of Object.keys(h.humanBones)) {
      const nb = h.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (nb) joints[name] = nb.getWorldPosition(new THREE.Vector3()).applyMatrix4(toAnchor);
    }
    const normRoot0 = h.normalizedHumanBonesRoot;
    toNorm = (normRoot0.parent ?? normRoot0).getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rt.anchor.getWorldQuaternion(new THREE.Quaternion()));
    const n = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    const side = (s: 'left' | 'right'): LegRest | null => {
      const ul = n(`${s}UpperLeg`), ll = n(`${s}LowerLeg`), ft = n(`${s}Foot`);
      if (!ul || !ll || ll.position.lengthSq() < 1e-10) return null;
      // normalized bones rest at identity, so a child's local offset IS the rest direction in normalized space
      return { upper: ll.position.clone().normalize(), lower: ft && ft.position.lengthSq() > 1e-10 ? ft.position.clone().normalize() : new THREE.Vector3(0, -1, 0), hasFoot: !!ft };
    };
    const left = side('left'), right = side('right');
    if (left || right) {
      const normRoot = h.normalizedHumanBonesRoot;
      const aq = rt.anchor.getWorldQuaternion(new THREE.Quaternion());
      const nq = (normRoot.parent ?? normRoot).getWorldQuaternion(new THREE.Quaternion());
      legs = { toNorm: nq.invert().multiply(aq), left, right };
    }
  }
  // a box far taller / shorter than the skeleton says: either three.js applied a scaled export's node scale twice
  // (skinned meshes under a scaled node: centimetre / 10x exports → a 97 m bee measures 9 700 m), or stray geometry
  // (a particle plane, a hidden floor). Undo the double scale when that explains it, else trust the joints.
  let heightFix: string | undefined;
  const hd = joints.head, lf = joints.leftFoot ?? joints.leftLowerLeg, rf = joints.rightFoot ?? joints.rightLowerLeg;
  if (hd && (lf || rf)) {
    const fy = Math.min(lf?.y ?? Infinity, rf?.y ?? Infinity), span = hd.y - fy;
    if (span > 1e-4) {
      // (the span runs to the top of the head's bone subtree: a puppet's head joint sits at the base of a huge head —
      // restHeight.ts; a puppet avatar used to measure 0.66 m and show 2.2x too big)
      const est = skeletonHeight(hd.y, fy, headSubtreeTop(rt, toAnchor));
      if (implausible(height, est)) {
        let sw = 1;
        const ws = new THREE.Vector3();
        rt.model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) { o.getWorldScale(ws); if (Math.abs(Math.log(ws.y)) > Math.abs(Math.log(sw))) sw = ws.y; } });
        const undone = height / sw;
        if (Math.abs(Math.log(sw)) > 0.4 && undone > est * 0.55 && undone < est * 1.8) {
          heightFix = `skinned bounding box scaled twice (node scale ${+sw.toFixed(3)}): ${height.toFixed(3)} → ${undone.toFixed(3)}`;
          height = undone; floorY = Math.min(floorY / sw, fy);
        } else if (height > est * 1.8 && verticalGap(skinnedYs(rt, toAnchor), floorY, floorY + height) < STRAY_GAP) {
          // one continuous body from the feet to the top (no floating plane): the proportions are just unusual — trust it
        } else {
          heightFix = `bounding box ${height.toFixed(3)} vs skeleton ${est.toFixed(3)} (stray geometry?) — using the skeleton`;
          height = est; floorY = fy - span * 0.05;
        }
      }
    }
  }
  // the face measure has the same failure (a scaled export: centre in one space, size in another → a 580 m face and a
  // group camera framing the whole map): when it is nowhere near the head joint, estimate it from the head
  let faceM = face;
  if (hd && (face.center.distanceTo(hd) > height * 0.45 || face.size > height * 0.7 || face.size < height * 0.01)) {
    faceM = { center: hd.clone().add(new THREE.Vector3(0, height * 0.05, height * 0.03)), size: height * 0.16 };
    heightFix = `${heightFix ? heightFix + '; ' : ''}face measure off (size ${face.size.toFixed(2)}) — estimated from the head joint`;
  }
  // (2D cards: the head the picture shows, measured by the source — a 2D rig's head-turn meshes; never the card's box)
  const flatHead = (rt as { flat?: { headWorld?(): { top: number; half: number } | undefined } | null }).flat?.headWorld?.();
  const head = flatHead ?? (heightFix?.startsWith('skinned bounding box scaled twice') ? null : headExtent(rt, faceM, toAnchor, height));
  // the drawn face (measured at rest, here, the same on every page): only when the face measure itself is sound
  let drawn: RestMetrics['drawn'];
  if (faceM === face && fi) {
    let dr: ReturnType<typeof measureDrawn> = null;
    try { dr = measureDrawn(rt, new THREE.Vector3(0, 0, 1).applyQuaternion(rt.anchor.getWorldQuaternion(new THREE.Quaternion())), height); } catch (e) { console.warn('[scene] drawn face', e); }
    if (dr) drawn = { center: dr.center.clone().applyMatrix4(toAnchor), size: dr.size, depth: dr.depth, why: dr.why };
  }
  const rbox = !box.isEmpty() && !heightFix ? box.clone().applyMatrix4(toAnchor) : undefined;
  const cb = (rt as { cardBox?(): { box: THREE.Box3; bust: boolean } | null }).cardBox?.();
  const card = cb && !cb.box.isEmpty() ? { box: cb.box.clone().applyMatrix4(toAnchor), bust: cb.bust } : undefined;
  const m: RestMetrics = { height, floorY, hips, face: faceM, legs, toNorm, joints, ...(heightFix ? { heightFix } : {}), ...(head ? { head } : {}), ...(flatHead ? { headExact: true as const } : {}), ...(drawn ? { drawn } : {}), ...(rbox ? { box: rbox } : {}), ...(card ? { card } : {}) };
  rest.set(rt, m);
  return m;
}
export const restOf = (rt: AvatarRuntime) => rest.get(rt) ?? measureRest(rt);

/** How far the avatar reaches above its reported face centre at rest (anchor units): the top of its rest box — or, for
 *  an exactly measured head (2D cards: RestMetrics.headExact), that head's top. Framing keeps it in the shot. */
export function restTopAbove(r: RestMetrics): number {
  return r.headExact && r.head ? r.head.top : r.floorY + r.height - r.face.center.y;
}

/** The highest bone at or under the head (anchor space y), or null. */
function headSubtreeTop(rt: AvatarRuntime, toAnchor: THREE.Matrix4): number | null {
  const head = rt.humanoid?.getRawBoneNode('head') ?? null;
  if (!head) return null;
  let top = -Infinity;
  const v = new THREE.Vector3();
  head.traverse((o) => { if ((o as THREE.Bone).isBone || o === head) { o.getWorldPosition(v).applyMatrix4(toAnchor); if (v.y > top) top = v.y; } });
  return Number.isFinite(top) ? top : null;
}

/** Sampled skinned / bone-attached vertex heights (anchor space, <= ~12k): the stray-geometry gap test. */
function skinnedYs(rt: AvatarRuntime, toAnchor: THREE.Matrix4): Float32Array {
  const meshes: THREE.Mesh[] = [];
  rt.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && m.geometry?.attributes?.position) meshes.push(m); });
  const total = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
  const step = Math.max(1, Math.ceil(total / 12000));
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const sk = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh) : null;
    for (let i = 0; i < pos.count; i += step) {
      if (sk) sk.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      out.push(v.applyMatrix4(m.matrixWorld).applyMatrix4(toAnchor).y);
    }
  }
  return Float32Array.from(out);
}

/** Head extent at rest (see RestMetrics.head): sampled skinned / bone-attached vertices above the chin (at most ~24k
 *  per avatar, once per load). Implausible results (a stray plane far above the head) → null. */
function headExtent(rt: AvatarRuntime, face: { center: THREE.Vector3; size: number }, toAnchor: THREE.Matrix4, height: number): { top: number; half: number } | null {
  const chin = face.center.y - face.size * 0.8;
  const v = new THREE.Vector3();
  let top = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
  const meshes: THREE.Mesh[] = [];
  rt.model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !m.geometry?.attributes?.position) return;
    let boned = !!(m as THREE.SkinnedMesh).isSkinnedMesh;
    for (let p = m.parent; p && !boned; p = p.parent) if ((p as THREE.Bone).isBone) boned = true;
    if (boned) meshes.push(m);
  });
  const total = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
  const step = Math.max(1, Math.ceil(total / 24000));
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const sk = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh) : null;
    for (let i = 0; i < pos.count; i += step) {
      if (sk) sk.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(m.matrixWorld).applyMatrix4(toAnchor);
      if (v.y < chin) continue;
      n++;
      if (v.y > top) top = v.y;
      const dx = v.x - face.center.x, dz = v.z - face.center.z;
      if (dx < x0) x0 = dx; if (dx > x1) x1 = dx; if (dz < z0) z0 = dz; if (dz > z1) z1 = dz;
    }
  }
  if (n < 8 || !Number.isFinite(top)) return null;
  const t = top - face.center.y, half = Math.max(Math.abs(x0), Math.abs(x1), (z1 - z0) / 2);
  // (a head can be big — a mascot is mostly head — but not taller / wider than the whole avatar twice over)
  if (t < 0 || t > Math.max(height * 0.9, face.size * 4) || half > Math.max(height * 0.9, face.size * 4)) return null;
  return { top: t, half };
}

export interface Placement {
  position: THREE.Vector3;
  yaw: number;
  /** 1 = seated. */
  sit: number;
}

export class SceneActor {
  readonly mount = new THREE.Group();
  readonly lift = new THREE.Group();
  runtime: AvatarRuntime | null = null;
  anchor: THREE.Object3D | null = null;
  rest: RestMetrics | null = null;
  /** Assigned spot (null = no free spot → not shown). */
  spot: SpotInfo | null = null;
  /** In the room (host's presence toggle). */
  present = true;
  /** Actually on screen right now (movers flip it at the door / after an exit). */
  shown = false;
  /** Seated blend 0..1 — eased toward the spot's pose, or driven by a mover. */
  sit = 0;
  /** Placeholder-mover pop scale 0..1 (1 = normal). */
  appear = 1;
  /** Normalising scale (shown height / measured height). */
  scale = 1;
  /** Real size + size class (from the profile, shared/avatarSize.ts) and the standing height shown in the room (m). */
  size: AvatarSize = avatarSize(null);
  height = 1.5;
  /** The room's normal-performer height (avatarHeight × avatarScale) — hover perches scale with it. */
  base = 1.5;
  /** Current hover lift (m, eased by the runtime toward perchFor(spot); 0 while walking). */
  perch = 0;
  /** Seat drop (m, room units) for the current seat, applied × sit. */
  private seatY = 0;
  private seatZ = 0;
  private seatX = 0;
  /** Size-aware seating (src/scene/sizeSeat.ts): the runtime's room probe, the current seat's plan, its prop. */
  seatEnv: SeatEnv | null = null;
  /** Walking machines park on the room as it loaded (src/scene/mechNav.ts StaticRays: no swinging door, no history),
   *  so every page parks them in the same place. null = the seat env's rays. */
  parkRays: ParkRays | null = null;
  boost: SeatBoost | null = null;
  private boostCache = new Map<string, SeatBoost>();
  private boostEnv: SeatEnv | null = null;
  private prop: THREE.Object3D | null = null;
  private propFor: SeatBoost | null = null;
  /** Quadrupeds: body length behind the origin (anchor metres, unscaled); 0 = biped. */
  private quadBack = 0;
  /** Walking machines: the model's rest box in anchor space (unscaled), for parking clear of the furniture. */
  private mechBox: THREE.Box3 | null = null;
  private parkCache = new Map<string, { z: number; x: number }>();
  /** Extra pose layer for movers (walk cycles). Runs after the seated legs, under the tracking. */
  extraPose: ((rt: AvatarRuntime, dt: number) => void) | null = null;
  /** Mover-owned body offset (mount space, room metres: walk bob / sway / hop) and tilt (hop wobble). */
  readonly offset = new THREE.Vector3();
  readonly tilt = new THREE.Quaternion();
  /** 0..1 how much the performer is walking right now (damps tracked head translation, see SceneRuntime.tuningFor). */
  loco = 0;

  constructor(readonly key: string, public name: string) {
    this.mount.name = `actor:${key}`;
    this.mount.add(this.lift);
    this.mount.visible = false;
  }

  attach(anchor: THREE.Object3D, rt: AvatarRuntime) {
    if (this.runtime && this.runtime !== rt) this.runtime.poseHook = null;
    this.anchor = anchor;
    this.runtime = rt;
    this.rest = restOf(rt);
    if (anchor.parent !== this.lift) this.lift.add(anchor);
    anchor.position.set(0, 0, 0);
    anchor.quaternion.identity();
    anchor.scale.setScalar(1);
    // four-legged performers (profile.body 'quadruped'): how far the body reaches behind its origin, so at a seat it
    // stands in front of it instead of sitting (and its legs walk with the mover's gait)
    this.quadBack = 0;
    this.mechBox = null;
    this.parkCache.clear();
    if (rt.quadruped || rt.mech) {
      rt.model.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(rt.model);
      const inv = anchor.matrixWorld.clone().invert();
      const ab = box.clone().applyMatrix4(inv);
      this.quadBack = Math.max(0, -ab.min.z);
      if (rt.mech && !ab.isEmpty()) this.mechBox = ab;
    }
    rt.flat?.setActor(this);   // (2D avatars on a walking TV read the walk / sit state)
    rt.poseHook = (r, dt) => { this.applySeat(r); if (r.mech) r.mech.loco = this.loco; this.extraPose?.(r, dt); if (r.quadruped) r.quadruped.gait = this.loco; };
  }

  /** Give the anchor back (Classic mode). */
  detach(): THREE.Object3D | null {
    const a = this.anchor;
    if (this.runtime) { this.runtime.poseHook = null; this.runtime.flat?.setActor(null); }
    this.dropDrape();
    if (a && a.parent === this.lift) this.lift.remove(a);
    this.anchor = null; this.runtime = null; this.rest = null;
    return a;
  }

  /** Normalise to `height` metres standing (× user avatar scale). A walking machine (a MechRig with mech.pilotHeight):
   *  `height` is the human-normalised height every caller passes (the room's, a chat buddy's, a sidekick's ...); its
   *  PILOT gets that height and the machine shows at its true size around them (desert_walker SPEC §2.2 + C4): `height`
   *  (this.height) then reads the machine's real shown height, which seats and clearance use. */
  setHeight(height: number) {
    const H = this.rest?.height ?? 1.6;
    const shown = this.mechShownFor(height);
    // (wide limits: a model exported in centimetres measures ~170 units → 0.009; the old 0.02 floor made it a 3.4 m giant)
    this.scale = THREE.MathUtils.clamp((shown ?? height) / H, 1e-5, 1e5);
    this.height = shown ?? height;
    this.updateSeat();
  }

  /** A walking machine's shown height (room metres) when its pilot is normalised to the human height `h`
   *  (shared/avatarSize.ts shownScaleFor: base × heroScale / pilotHeight, the claimed pilot bounded by the model's own
   *  height and the 80 m cap); null = not a machine with a pilotHeight (the plain rule: shown = h). */
  mechShownFor(h: number): number | null {
    const rt = this.runtime, r = this.rest, p = rt?.profile;
    if (!rt?.mech || !p || !r || !(h > 0)) return null;
    const native = r.height / (p.transform?.scale || 1);
    const ms = native > 0 ? shownScaleFor(p, h, native) : null;
    return ms === null ? null : native * ms;
  }

  /** Hover lift at a spot: micro performers float at seated-face height on ordinary stand spots and on hover
   *  perches (sizeSpots.ts); everyone else stands / sits on the spot itself. */
  perchFor(s: SpotInfo | null): number {
    if (!s) return 0;
    if (this.size.cls === 'micro') {
      if (s.hover) return s.hover;
      if (s.pose === 'stand' && spotFit(s.sizes, 'micro') === 1) return this.base * 0.6;
    }
    return this.stepFor(s);
  }

  /** The step-up rule (sizeSeat.ts planStep): a step under a standing performer the cameras can't see over the
   *  lectern / counter in front of their stand spot. Cached per spot, scale and seat env. */
  private stepCache = new Map<string, number>();
  /** the last call's inputs (numbers, not the key string) + result: repeat calls in a frame skip building the key */
  private stepLast: { s: SpotInfo; idx: number; x: number; z: number; k: number; env: SeatEnv; ver: number; v: number } | null = null;
  stepFor(s: SpotInfo): number {
    const env = this.seatEnv, r = this.rest;
    if (!env || !r || s.pose === 'sit' || this.size.cls === 'macro') return 0;
    const k = this.scale;
    const L = this.stepLast;
    if (L && L.s === s && L.idx === s.index && L.x === s.position.x && L.z === s.position.z && L.k === k && L.env === env && L.ver === env.ver) return L.v;
    const key = `${s.index}|${s.position.x.toFixed(2)},${s.position.z.toFixed(2)}|${k.toFixed(5)}|${env.ver}`;
    let v = this.stepCache.get(key);
    if (v === undefined) {
      try { v = planStep(s, { standFace: (r.face.center.y - r.floorY) * k, standFaceZ: r.face.center.z * k, faceSize: r.face.size * k, standTop: this.height, base: this.base }, env.rays(), env.surfaces, env.cams?.()); } catch { v = 0; }
      if (this.stepCache.size > 64) this.stepCache.clear();
      this.stepCache.set(key, v);
    }
    this.stepLast = { s, idx: s.index, x: s.position.x, z: s.position.z, k, env, ver: env.ver, v };
    return v;
  }
  private stepProp: THREE.Object3D | null = null;
  private stepPropH = 0;

  /** Seat geometry for a spot (recomputed when the spot or scale changes; movers pass the seat being left). */
  updateSeat(s: SpotInfo | null = this.spot) {
    const r = this.rest;
    this.seatX = 0; this.boost = null;
    // a walking machine PARKS at every spot (seat or stand: actor.sit is its park weight, it never sits): its whole
    // footprint clear of the furniture, in front of a seat / near a stand spot, shifted sideways if it must
    if (s && r && this.runtime?.mech) {
      this.seatY = 0;
      // (a human's stand spot can be somewhere a machine doesn't fit, behind a desk: then it stands in front of it)
      const p = s.pose === 'sit' ? this.mechPark(s, Math.min(1.2, this.quadBack * this.scale * 0.85 + s.seatDepth * 0.35), 2, null) : this.mechPark(s, -0.8, 3, 0);
      this.seatZ = p.z; this.seatX = p.x;
      if (s.pose === 'sit') this.applyBoost(s);
      return;
    }
    if (!s || s.pose !== 'sit' || !r) { this.seatY = 0; this.seatZ = 0; return; }
    const k = this.scale;
    if (this.runtime?.quadruped) {
      // a quadruped never sits in a chair: it stands on the floor in front of the seat, rump clear of it
      this.seatY = 0;
      this.seatZ = Math.min(1.2, this.quadBack * k * 0.85 + s.seatDepth * 0.35);
      this.applyBoost(s);
      return;
    }
    // 2D avatars (src/avatar/flat): a full-body card stands on the floor in front of the seat; a bust sits ON the seat —
    // the card itself drops onto it from this spot's seat height (card.ts setPlace), here only a little back into it
    // (walking TVs: the leg-less rule below)
    const fs = this.runtime?.flat?.seat;
    if (fs === 'stand' || fs === 'lower') {
      this.seatY = 0;
      // (the spot is the sitter's hips: the seat's front edge is most of a seat depth ahead of it, more on a curved
      //  sofa; at 0.45 x depth a full-body card stood inside the cushion — release gate, Hangout lounge)
      this.seatZ = fs === 'stand' ? Math.min(0.9, s.seatDepth * 0.9 + 0.1) : -Math.min(0.12, s.seatDepth * 0.2);
      return;
    }
    this.seatBase(s);
    this.applyBoost(s);
  }

  /** Walking machines: where at spot `s` (room metres along its facing, z, and sideways, x) the machine parks so its
   *  rest footprint (anchor box x scale) is clear of the furniture: z in [min, min + span] (a seat: from the quadruped
   *  rule out; a stand spot: from a little behind it to well in front), rather at `pref` (null = min), sideways up to
   *  0.4 of its width (0.6 m at a seat, 0.9 m at a stand spot). Probed once per spot / scale / room version
   *  (src/scene/mechPark.ts), then cached. Nowhere clear: twice as far and wide, then the least blocked place. */
  private mechPark(s: SpotInfo, min: number, span: number, pref: number | null): { z: number; x: number } {
    const env = this.seatEnv, b = this.mechBox, k = this.scale;
    const none = { z: pref ?? min, x: 0 };
    if (!env || !b) return none;
    const key = `${s.index}|${s.pose}|${s.position.x.toFixed(3)},${s.position.y.toFixed(3)},${s.position.z.toFixed(3)},${s.yaw.toFixed(4)}|${k.toFixed(5)}|${env.ver}`;
    let p = this.parkCache.get(key);
    if (!p) {
      p = none;
      try {
        const box = { minX: b.min.x * k, maxX: b.max.x * k, back: Math.max(0, -b.min.z * k), front: Math.max(0, b.max.z * k), top: Math.max(0.05, (b.max.y - Math.min(0, b.min.y)) * k) };
        const side = Math.min(pref !== null ? 0.9 : 0.6, 0.4 * (box.maxX - box.minX));
        const rays = this.parkRays ?? env.rays();
        let res = mechParkDistance(s.position, s.yaw, box, rays, min, min + span, { side, ...(pref !== null ? { prefZ: pref } : {}) });
        // (nowhere clear near it, a cramped corner: look twice as far out and wider before settling for the least blocked)
        if (!res.clear) {
          const far = mechParkDistance(s.position, s.yaw, box, rays, min, min + 2 * span, { side: 2 * side, ...(pref !== null ? { prefZ: pref } : {}) });
          if (far.clear || far.blocked < res.blocked) res = far;
        }
        p = { z: res.z, x: res.x };
      } catch { p = none; }
      if (this.parkCache.size > 64) this.parkCache.clear();
      this.parkCache.set(key, p);
    }
    return p;
  }

  /** The ordinary seated drop for a human-sized sitter (hips on the seat). */
  private seatBase(s: SpotInfo) {
    const r = this.rest!, k = this.scale;
    if (r.legs && r.hips) {
      // hips joint sits a thigh-radius above the seat surface; the hips land on the spot origin
      const hipsH = (r.hips.y - r.floorY) * k;
      const thigh = r.height * k * 0.055;
      this.seatY = s.seatHeight + thigh - hipsH;
      this.seatZ = -r.hips.z * k;
    } else {
      // no legs to bend (blobs, soft rigs): the whole avatar rests on the seat, a little back
      this.seatY = s.seatHeight - r.floorY * k;
      this.seatZ = -Math.min(0.2, s.seatDepth * 0.25);
    }
  }

  /** Size-aware seating: boosters, standing on the seat / desk, scooting back, standing beside (sizeSeat.ts). */
  private applyBoost(s: SpotInfo) {
    const env = this.seatEnv, r = this.rest;
    if (!env || !r || this.size.cls === 'normal') return;
    if (this.boostEnv !== env) { this.boostCache.clear(); this.boostEnv = env; }
    const k = this.scale;
    const key = `${s.index}|${s.seatHeight.toFixed(3)}|${k.toFixed(5)}|${this.size.cls}|${env.ver}`;
    let b = this.boostCache.get(key);
    if (!b) {
      const sy = this.seatY, sz = this.seatZ;
      if (this.runtime?.quadruped || this.runtime?.mech) this.seatBase(s);
      const sitFace = this.seatY - s.seatHeight + r.face.center.y * k;
      const sitFaceZ = this.seatZ + r.face.center.z * k;
      this.seatY = sy; this.seatZ = sz;
      const standFace = (r.face.center.y - r.floorY) * k;
      try {
        b = planSeat(s, { cls: this.size.cls, sitFace, standFace, standTop: this.height, faceSize: r.face.size * k, height: this.height, base: this.base, quadruped: !!this.runtime?.quadruped || !!this.runtime?.mech, sitFaceZ, standFaceZ: r.face.center.z * k }, env.rays(), env.surfaces, env.cams?.());
      } catch { b = { mode: 'none', lift: 0, x: 0, z: 0, stand: false, cushion: 0, cushionW: 0, note: 'seat probe failed' }; }
      if (this.boostCache.size > 64) this.boostCache.clear();
      this.boostCache.set(key, b);
    }
    if (b.mode === 'none') return;
    this.boost = b;
    if (b.mode === 'cushion') this.seatY += b.lift;
    else if (b.mode === 'back') this.seatZ += b.z;
    else if (b.stand) { this.seatY = b.lift - r.floorY * k; this.seatZ = b.z; this.seatX = b.x; }
  }

  /** A walking machine's rest footprint in room metres (its anchor box x scale): `half` its widest reach to either side
   *  of its origin, `top` its height above its feet. null = not a machine (or not measured). */
  mechDims(): { half: number; top: number } | null {
    const b = this.mechBox, k = this.scale;
    if (!b || !this.runtime?.mech || !(k > 0)) return null;
    return { half: Math.max(-b.min.x, b.max.x, 0.05) * k, top: Math.max(0.3, (b.max.y - Math.min(0, b.min.y)) * k) };
  }

  /** A walking machine with a seated pilot (profile.body 'mech', src/avatar/mech.ts): room engines (forms, entrances,
   *  cameras) can treat it as a vehicle. Its legs / footprint: runtime.mech. */
  get isMech() { return !!this.runtime?.mech; }

  /** Standing on a seat / desk / beside the chair: legs stay straight. */
  get standingSeat() { return !!this.boost?.stand; }

  /** Where the actor settles at a spot. */
  placementAt(s: SpotInfo): Placement {
    // (a walking machine: sit = its park weight at any spot, see updateSeat)
    return { position: s.position.clone(), yaw: s.yaw, sit: s.pose === 'sit' || this.isMech ? 1 : 0 };
  }

  /** Put the mount at a placement immediately. */
  place(p: Placement) {
    this.mount.position.copy(p.position);
    this.mount.rotation.set(0, p.yaw, 0);
    this.sit = p.sit;
  }

  /** Per-frame: seat drop + scale on the lift group. */
  sync() {
    const k = this.scale * Math.max(0.0001, this.appear);
    this.lift.scale.setScalar(k);
    this.lift.position.set(this.offset.x + this.seatX * this.sit, this.seatY * this.sit + this.offset.y + this.perch, this.seatZ * this.sit + this.offset.z);
    this.lift.quaternion.copy(this.tilt);
    this.mount.visible = this.shown && !!this.runtime;
    this.syncProp();
    this.syncDrape();
    // a walking machine's planted feet: re-solved for where the mover put the body this frame (src/avatar/mech.ts late)
    if (this.mount.visible) this.runtime?.mech?.late();
  }

  /** Seated modesty drape (src/avatar/seatDrape.ts): a skirt / dress never opens to the cameras when the thighs swing
   *  forward. Measured once per avatar + outfit, the first time it sits; shown only while seated. */
  drape: SeatDrape | null = null;
  /** Why the drape is / isn't there (debug: vtpOut.scene.actors). */
  drapeNotes: string[] = [];
  private drapeFor: { model: THREE.Object3D; costume: unknown; acc: number } | null = null;
  private syncDrape() {
    const rt = this.runtime;
    const want = !!rt && this.shown && this.sit > 0.5 && !this.standingSeat && !!this.rest?.legs && !rt.quadruped && !rt.mech;
    if (!want || !rt) { this.drape?.sync(false); return; }
    const f = this.drapeFor;
    if (!f || f.model !== rt.model || f.costume !== rt.costume || f.acc !== rt.accessories.length) {
      this.dropDrape();
      this.drapeFor = { model: rt.model, costume: rt.costume, acc: rt.accessories.length };
      try {
        const front = new THREE.Vector3(0, 0, 1).transformDirection(rt.anchor.matrixWorld);
        this.drapeNotes = [];
        const info = rt.humanoid ? analyzeDrape(rt.model, rt.humanoid, front, this.drapeNotes) : null;
        if (info && rt.humanoid) { this.drape = new SeatDrape(info, rt.humanoid); this.mount.add(this.drape.mesh); }
      } catch (e) { console.warn('seat drape', e); this.drape = null; }
    }
    this.drape?.sync(true);
  }
  private dropDrape() {
    this.drape?.dispose();
    this.drape = null;
    this.drapeFor = null;
  }

  /** The booster cushion under a small sitter (a child of the mount, seat space), shown once seated. */
  private syncProp() {
    const b = this.boost && this.boost.cushion > 0.01 && this.spot ? this.boost : null;
    if (b !== this.propFor) {
      if (this.prop) { this.prop.removeFromParent(); this.prop.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } }); this.prop = null; }
      this.propFor = b;
      if (b && this.spot) {
        this.prop = buildCushion(b.cushion, b.cushionW);
        this.prop.position.set(b.stand ? b.x : 0, this.spot.seatHeight, b.stand ? b.z : Math.max(-0.12, this.seatZ));
        this.mount.add(this.prop);
      }
    }
    if (this.prop) { this.prop.visible = this.sit > 0.6; this.prop.scale.setScalar(Math.max(0.0001, this.appear)); }
    // the step under a standing performer (step-up rule), shown once they have stepped up
    const h = this.spot && this.spot.pose !== 'sit' && !(this.size.cls === 'micro' && this.perchFor(this.spot) !== this.stepFor(this.spot)) ? this.stepFor(this.spot) : 0;
    if (h !== this.stepPropH) {
      if (this.stepProp) { this.stepProp.removeFromParent(); this.stepProp.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } }); this.stepProp = null; }
      this.stepPropH = h;
      if (h > 0) { this.stepProp = buildStep(h, THREE.MathUtils.clamp(this.height * 0.4, 0.5, 1.2)); this.mount.add(this.stepProp); }
    }
    if (this.stepProp) { this.stepProp.visible = this.perch > h * 0.5; this.stepProp.scale.setScalar(Math.max(0.0001, this.appear)); }
  }

  /** Where a performer who never sits (a walking machine, a quadruped) actually stands at spot `s`: the spot plus the
   *  seat / park offset it gets there (room space, on the floor; a walking machine parks at every spot, seats and stand
   *  spots alike). null = not such a spot / not measured yet. The walk mover routes walking machines to / from this
   *  point (src/scene/walkMover.ts) so their legs walk what the body travels. */
  parkAt(s: SpotInfo): THREE.Vector3 | null {
    if ((s.pose !== 'sit' && !this.isMech) || !this.rest) return null;
    // (a pure query: the seat offsets in use stay exactly as they were. Re-deriving them from this.spot would swap in
    // the TARGET seat's offsets while a mover still holds the seat being left: a one-frame body pop)
    const save = { x: this.seatX, y: this.seatY, z: this.seatZ, b: this.boost };
    this.updateSeat(s);
    const off = new THREE.Vector3(this.seatX, 0, this.seatZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
    this.seatX = save.x; this.seatY = save.y; this.seatZ = save.z; this.boost = save.b;
    return s.position.clone().setY(0).add(off);
  }

  /** World-space face centre + size when settled at `s` (static: ignores live head motion). */
  faceAt(s: SpotInfo): { center: THREE.Vector3; size: number } | null {
    const r = this.rest;
    if (!r) return null;
    return { center: this.restPointAt(s, r.face.center), size: r.face.size * this.scale };
  }
  /** The DRAWN face (RestMetrics.drawn) settled at `s`: what framing frames (the same as faceAt for most avatars). */
  drawnFaceAt(s: SpotInfo): { center: THREE.Vector3; size: number; depth: number; head: THREE.Vector3 } | null {
    const r = this.rest;
    if (!r) return null;
    const d = r.drawn;
    const k = this.seatedScaleAt(s);
    if (!d) { const c = this.restPointAt(s, r.face.center); return { center: c, size: r.face.size * this.scale * k, depth: 0, head: c }; }
    // (`head`: the middle of the head the body volumes go round — the reported face anchor when the drawn face differs)
    const [c, h] = this.restPointsAt(s, [d.center, d.why ? r.face.center : d.center]);
    return { center: c, size: d.size * this.scale * k, depth: d.depth * this.scale * k, head: d.why ? h : c };
  }
  /** The rest box (RestMetrics.box) settled at `s` (world, axis-aligned round the turned box), or null. */
  restBoxAt(s: SpotInfo): THREE.Box3 | null {
    const b = this.rest?.box;
    if (!b || b.isEmpty()) return null;
    const pts: THREE.Vector3[] = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push(new THREE.Vector3(x, y, z));
    return new THREE.Box3().setFromPoints(this.restPointsAt(s, pts));
  }
  /** A rest (anchor space) point when settled at `s`: scaled, seated / perched, turned to the spot, at the spot. */
  restPointAt(s: SpotInfo, p: THREE.Vector3): THREE.Vector3 { return this.restPointsAt(s, [p])[0]; }
  restPointsAt(s: SpotInfo, ps: THREE.Vector3[]): THREE.Vector3[] {
    const sit = s.pose === 'sit' || this.isMech ? 1 : 0;
    // (a pure query: the seat offsets in use are put back exactly as they were, not re-derived from this.spot: a mover
    // leaving a seat holds THAT seat's offsets while this.spot already names the target)
    const save = { x: this.seatX, y: this.seatY, z: this.seatZ, b: this.boost };
    this.updateSeat(s);
    const off = new THREE.Vector3(this.seatX * sit, this.seatY * sit + this.perchFor(s), this.seatZ * sit);
    this.seatX = save.x; this.seatY = save.y; this.seatZ = save.z; this.boost = save.b;
    // (a 2D bust sits ON the seat: its card drops onto it and grows — the rest point moves with it)
    const fl = sit ? this.seatedFlat(s) : null;
    return ps.map((p) => (fl ? fl(p) : p.clone()).multiplyScalar(this.scale).add(off).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(s.position));
  }
  /** A 2D bust card at seat `s`: rest point → where it is seated (avatar space), or null (not a seated bust). */
  private seatedFlat(s: SpotInfo): ((p: THREE.Vector3) => THREE.Vector3) | null {
    const fl = this.runtime?.flat;
    if (!fl || fl.seat !== 'lower' || s.pose !== 'sit') return null;
    const h = s.seatHeight / Math.max(1e-4, this.scale);
    return (p) => fl.seatedRestPoint(p, h)?.p ?? p.clone();
  }
  /** A 2D card's art changed after load (FlatAvatar.remeasure: an outfit / model sliders): read its box again (anchor
   *  space, standing) so the cams and talk shots frame the new art (their caches key on it: SceneRuntime.rosterSig). */
  refreshCard() {
    const r = this.rest, rt = this.runtime;
    const cb = rt?.cardBox();
    if (!r || !rt || !cb || cb.box.isEmpty()) return;
    rt.anchor.updateWorldMatrix(true, false);
    r.card = { box: cb.box.clone().applyMatrix4(rt.anchor.matrixWorld.clone().invert()), bust: cb.bust };
  }

  /** A 2D card's drawn art settled at `s` (world): bottom / top, half width (it turns to the lens), bottom centre; null
   *  for anything but a card. Seated busts drop onto the seat and grow (restPointsAt). Framing frames THIS. */
  cardArtAt(s: SpotInfo): { bottom: number; top: number; half: number; base: THREE.Vector3; bust: boolean } | null {
    const c = this.rest?.card;
    if (!c) return null;
    const b = c.box, z = (b.min.z + b.max.z) / 2;
    const [l0, r0, l1] = this.restPointsAt(s, [new THREE.Vector3(b.min.x, b.min.y, z), new THREE.Vector3(b.max.x, b.min.y, z), new THREE.Vector3(b.min.x, b.max.y, z)]);
    return { bottom: Math.min(l0.y, l1.y), top: Math.max(l0.y, l1.y), half: Math.hypot(r0.x - l0.x, r0.z - l0.z) / 2, base: l0.clone().add(r0).multiplyScalar(0.5), bust: c.bust };
  }
  /** How much bigger a 2D bust card is seated at `s` than standing (1: anything else). */
  seatedScaleAt(s: SpotInfo): number {
    const fl = this.runtime?.flat;
    if (!fl || fl.seat !== 'lower' || s.pose !== 'sit') return 1;
    return fl.seatedRestPoint(new THREE.Vector3(), s.seatHeight / Math.max(1e-4, this.scale))?.k ?? 1;
  }

  /** Seated legs on the normalized humanoid (after tracking wrote its bones, before humanoid.update()). */
  private applySeat(rt: AvatarRuntime) {
    const a = this.sit, legs = this.rest?.legs, h = rt.humanoid;
    if (a <= 0.001 || !legs || !h || this.standingSeat) return;
    for (const side of ['left', 'right'] as const) {
      const lr = legs[side];
      if (!lr) continue;
      const sg = side === 'left' ? 1 : -1;   // avatar space: +X = avatar-left, +Z = front
      const ul = h.getNormalizedBoneNode(`${side}UpperLeg` as VRMHumanBoneName);
      const ll = h.getNormalizedBoneNode(`${side}LowerLeg` as VRMHumanBoneName);
      const ft = lr.hasFoot ? h.getNormalizedBoneNode(`${side}Foot` as VRMHumanBoneName) : null;
      if (!ul || !ll) continue;
      // thigh: forward, slightly out and a touch down; shin: straight down, feet a bit forward
      const thigh = new THREE.Vector3(0.1 * sg, -0.06, 1).normalize().applyQuaternion(legs.toNorm);
      const shin = new THREE.Vector3(0.03 * sg, -1, 0.1).normalize().applyQuaternion(legs.toNorm);
      const upW = new THREE.Quaternion().setFromUnitVectors(lr.upper, thigh);
      const cur = lr.lower.clone().applyQuaternion(upW);
      const loW = new THREE.Quaternion().setFromUnitVectors(cur, shin).multiply(upW);
      const loL = upW.clone().invert().multiply(loW);
      ul.quaternion.copy(I).slerp(upW, a);
      ll.quaternion.copy(I).slerp(loL, a);
      // feet stay level with the floor (undo the leg rotation)
      if (ft) ft.quaternion.copy(I).slerp(loW.clone().invert(), a);
    }
  }
}

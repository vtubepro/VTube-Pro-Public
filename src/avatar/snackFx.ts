// Food & drink on the avatar: drink props in the hands (tilting to the mouth on a sip) + the food-mess
// layer + a little crumb puff per bite. Driven by TrackingFrame.snack (decided once by the studio), so the
// studio preview, OBS output and party guests all show the same thing.
//
// Placement works on any rig:
//   • humanoid hands with finger bones → the prop sits in the curled fingers, its axis along the
//     thumb side (upright in a natural grip) and follows the tracked hand's rotation;
//   • hand bones without fingers → in front of the hand, upright;
//   • no hand bones → floats beside the mouth.
// Sizes come from the avatar's own hand / face size, so chibi frogs get chibi cups.

import * as THREE from 'three';
import type { MessStyle, SnackFrame, SnackHand, SnackProp, SurfaceMarker, Vec3 } from '../../shared/types.ts';
import type { VRMHumanBoneName, VRMHumanoid } from '@pixiv/three-vrm';
import { buildProp, type BuiltProp } from './snackProps.ts';
import { FoodMess, type MessSite } from './foodMess.ts';
import { collectMeshes } from './surfacePatch.ts';
import { fullIndex } from './lod/fullIndex.ts';

type Side = 'left' | 'right';

/** What the snack layer needs from the avatar runtime. */
export interface SnackHost {
  model: THREE.Object3D;
  anchor: THREE.Object3D;
  humanoid: VRMHumanoid | null;
  profile: { mouth: { mode: string; center: SurfaceMarker | null; width: number; openHeight: number } };
  faceInfo(): { center: THREE.Vector3; size: number } | undefined;
  bounds(): THREE.Box3;
}

/** Rest-pose measurements, taken once when the avatar is built (pure vector math — cheap). */
export interface SnackRest {
  H: number;
  /** Mouth in head-bone space (follows the head) and in model space (rest). */
  mouthHead: THREE.Vector3 | null;
  mouthModel: THREE.Vector3;
  /** Face forward / up in head-bone space. */
  fwdHead: THREE.Vector3 | null;
  upHead: THREE.Vector3 | null;
  /** Model-space forward / up (rest). */
  fwdModel: THREE.Vector3;
  upModel: THREE.Vector3;
  faceSize: number;
  mouthHalf: [number, number];
  /** Explicit mouth surface marker (procedural mouths), model space. */
  mouthMarker: SurfaceMarker | null;
  hands: Record<Side, { len: number; gripModel: THREE.Vector3 } | null>;
  propH: number;
  /** World → model scale (world units per model unit). */
  scaleW: number;
}

const bone = (h: VRMHumanoid | null, n: string) => h?.getRawBoneNode(n as VRMHumanBoneName) ?? null;
const wpos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

export function measureSnackRest(host: SnackHost): SnackRest {
  const { model, anchor, humanoid } = host;
  model.updateWorldMatrix(true, true);
  const box = host.bounds();
  const H = box.max.y - box.min.y || 1.6;
  const aq = anchor.getWorldQuaternion(new THREE.Quaternion());
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(aq), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(aq);
  const face = host.faceInfo();
  const faceSize = face?.size ?? H * 0.16;
  const head = bone(humanoid, 'head');
  const m = host.profile.mouth;
  let mouthW: THREE.Vector3;
  if (m.center) mouthW = new THREE.Vector3(...m.center.position).applyMatrix4(model.matrixWorld);
  else if (face) mouthW = face.center.clone().addScaledVector(up, -faceSize * 0.38).addScaledVector(fwd, faceSize * 0.12); // ~1.2 eye distances below the eye bones
  else if (head) mouthW = wpos(head).addScaledVector(up, H * 0.02).addScaledVector(fwd, H * 0.05);
  else mouthW = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y - H * 0.15, box.max.z);
  const scaleW = model.getWorldScale(new THREE.Vector3()).x || 1;
  const toHead = (v: THREE.Vector3) => (head ? head.worldToLocal(v.clone()) : null);
  const dirHead = (d: THREE.Vector3) => (head ? d.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert()) : null);
  const invModelQ = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  // the profile's mouth size when a mouth marker exists (procedural mouths, jaw / puppet rigs), else a guess
  const mouthHalf: [number, number] = m.center && m.width > 0
    ? [m.width * scaleW, Math.max(m.openHeight * scaleW * 0.5, m.width * scaleW * 0.15)] : [faceSize * 0.12, faceSize * 0.022];
  const hands: SnackRest['hands'] = { left: null, right: null };
  for (const s of ['left', 'right'] as Side[]) {
    const hb = bone(humanoid, `${s}Hand`);
    if (!hb) continue;
    const mid = bone(humanoid, `${s}MiddleProximal`), lo = bone(humanoid, `${s}LowerArm`);
    const hp = wpos(hb);
    let len = mid ? hp.distanceTo(wpos(mid)) * 2.2 : lo ? hp.distanceTo(wpos(lo)) * 0.42 : H * 0.07;
    len = THREE.MathUtils.clamp(len, H * 0.035, H * 0.14);
    const tip = mid ? wpos(mid) : lo ? hp.clone().add(hp.clone().sub(wpos(lo)).normalize().multiplyScalar(len * 0.45)) : hp.clone();
    const grip = hp.clone().lerp(tip, 0.7);
    hands[s] = { len, gripModel: model.worldToLocal(grip) };
  }
  const handLen = hands.right?.len ?? hands.left?.len ?? H * 0.07;
  // cartoon-sized (a real cup is ~1.1 hand lengths; props read better a bit bigger on stream), never tiny
  // next to a big chibi head, clamped for extreme rigs (tiny paws, giant mitts)
  const propH = THREE.MathUtils.clamp(Math.max(handLen * 1.5, faceSize * 0.3), H * 0.05, Math.min(faceSize * 0.8, H * 0.14));
  return {
    H, faceSize, mouthHalf, propH, scaleW,
    mouthHead: toHead(mouthW), mouthModel: model.worldToLocal(mouthW.clone()),
    fwdHead: dirHead(fwd), upHead: dirHead(up),
    fwdModel: fwd.clone().applyQuaternion(invModelQ), upModel: up.clone().applyQuaternion(invModelQ),
    mouthMarker: m.center ?? null, hands,
  };
}

// ---------------------------------------------------------------- crumb puffs
interface Crumb { m: THREE.Mesh; v: THREE.Vector3; age: number; life: number; spin: THREE.Vector3 }
const CRUMB_COL: Record<MessStyle, string[]> = {
  crumbs: ['#d9a55b', '#a8703a'], spaghetti: ['#f3d98b', '#d9471f'], cheeto: ['#ff8a1c', '#ffb347'],
  chocolate: ['#4a2612', '#7a4424'], sugar: ['#ffffff', '#f3e9ee'],
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();

export class SnackFx {
  readonly group = new THREE.Group();
  private props: Record<Side, { kind: SnackProp; p: BuiltProp } | null> = { left: null, right: null };
  private mess: FoodMess | null = null;
  private messTried = false;
  private crumbs: Crumb[] = [];
  private crumbGeo: THREE.BufferGeometry | null = null;
  private crumbMats = new Map<string, THREE.MeshToonMaterial>();
  private lastBite = -1;
  private shown: Record<Side, number> = { left: 0, right: 0 };

  constructor(private host: SnackHost, private rest: SnackRest) {
    this.group.name = 'vtp_snacks';
    host.anchor.add(this.group);
  }

  /** Mouth + face axes in WORLD space right now (follows the head bone). */
  private faceNow() {
    const head = bone(this.host.humanoid, 'head'), R = this.rest;
    if (head && R.mouthHead && R.fwdHead && R.upHead) {
      const q = head.getWorldQuaternion(_q);
      return { mouth: head.localToWorld(R.mouthHead.clone()), fwd: R.fwdHead.clone().applyQuaternion(q).normalize(), up: R.upHead.clone().applyQuaternion(q).normalize() };
    }
    const mq = this.host.model.getWorldQuaternion(new THREE.Quaternion());
    return { mouth: this.host.model.localToWorld(R.mouthModel.clone()), fwd: R.fwdModel.clone().applyQuaternion(mq), up: R.upModel.clone().applyQuaternion(mq) };
  }

  update(sn: SnackFrame | undefined, dt: number, aspect: number) {
    const face = sn?.l || sn?.r || this.props.left || this.props.right || this.crumbs.length || sn?.b !== undefined ? this.faceNow() : null;
    for (const side of ['left', 'right'] as Side[]) this.updateProp(side, side === 'left' ? sn?.l : sn?.r, face, dt, aspect);
    // mess (built lazily the first time there is any)
    const m = sn?.m;
    if (m && (m.f > 0 || m.hl > 0 || m.hr > 0) && !this.mess && !this.messTried) this.buildMess();
    if (this.mess) this.mess.set(m?.s ?? 'crumbs', m?.f ?? 0, m?.hl ?? 0, m?.hr ?? 0);
    // crumb puff on a new bite
    if (sn?.b !== undefined && sn.b !== this.lastBite) {
      if (this.lastBite >= 0 && sn.b > this.lastBite && face) this.puff(face, m?.s ?? 'crumbs');
      this.lastBite = sn.b;
    }
    this.stepCrumbs(dt);
  }

  private updateProp(side: Side, h: SnackHand | undefined, face: ReturnType<SnackFx['faceNow']> | null, dt: number, aspect: number) {
    // viewers ease their own visibility too (frames can stop arriving mid-fade)
    const target = h?.a ?? 0;
    this.shown[side] += (target - this.shown[side]) * (1 - Math.exp(-25 * dt));
    if (!h && this.shown[side] < 0.01) this.shown[side] = 0;
    let cur = this.props[side];
    if (cur && h && cur.kind !== h.k) { cur.p.dispose(); cur = this.props[side] = null; }
    if (this.shown[side] <= 0.001 || !face) { if (cur) cur.p.root.visible = false; return; }
    if (!cur && h) {
      const p = buildProp(h.k);
      this.group.add(p.root);
      p.root.matrixAutoUpdate = false;
      cur = this.props[side] = { kind: h.k, p };
    }
    if (!cur) return;
    const P = cur.p;
    P.root.visible = true;
    for (const o of P.outlines) (o.material as THREE.ShaderMaterial).uniforms.uAspect.value = aspect;
    const s = this.rest.propH;
    // ---- hand frame ----
    const hum = this.host.humanoid;
    const hb = bone(hum, `${side}Hand`);
    let C: THREE.Vector3, axis: THREE.Vector3;
    const up = face.up, fwd = face.fwd;
    const avatarLeft = new THREE.Vector3().crossVectors(up, fwd).normalize(); // up × fwd = +X (avatar left)
    if (hb) {
      const H = wpos(hb);
      const mid = bone(hum, `${side}MiddleProximal`), idx = bone(hum, `${side}IndexProximal`), lit = bone(hum, `${side}LittleProximal`);
      const lo = bone(hum, `${side}LowerArm`);
      const len = this.rest.hands[side]?.len ?? s;
      const f = mid ? wpos(mid).sub(H) : lo ? H.clone().sub(wpos(lo)) : fwd.clone();
      if (f.lengthSq() < 1e-10) f.copy(fwd);
      f.normalize();
      let thumb: THREE.Vector3;
      if (idx && lit) thumb = wpos(idx).sub(wpos(lit));
      else thumb = up.clone();
      thumb.addScaledVector(f, -thumb.dot(f));
      if (thumb.lengthSq() < 1e-10) thumb = up.clone().addScaledVector(f, -up.dot(f));
      if (thumb.lengthSq() < 1e-10) thumb = avatarLeft.clone();
      thumb.normalize();
      // palm normal (anatomy): right hand palm = thumb × fwd, left = fwd × thumb
      const palm = side === 'right' ? new THREE.Vector3().crossVectors(thumb, f) : new THREE.Vector3().crossVectors(f, thumb);
      const grip = H.clone().addScaledVector(f, mid ? len * 0.32 : len * 0.45);
      if (idx && lit) C = grip.addScaledVector(palm, P.gripR * s * 1.1);
      else C = grip.addScaledVector(fwd, P.gripR * s * 0.8);   // no fingers: just in front of the hand
      axis = idx && lit ? thumb : up.clone();
    } else {
      // no hands on this rig: float beside the mouth
      const sg = side === 'left' ? 1 : -1;
      C = face.mouth.clone().addScaledVector(avatarLeft, sg * this.rest.faceSize * 0.75).addScaledVector(up, -this.rest.faceSize * 0.5).addScaledVector(fwd, this.rest.faceSize * 0.35);
      axis = up.clone();
    }
    // ---- sip: rim to the lips, bottom tipped up and away ----
    const sip = THREE.MathUtils.clamp(h?.sip ?? 0, 0, 1);
    if (sip > 0.001) {
      // cartoon 3/4 sip: the prop tips diagonally across the face (top at the lips, bottom up and out
      // toward the drinking hand's side) so its silhouette still reads from the front camera
      const w = THREE.MathUtils.smoothstep(sip, 0, 0.6);
      const th = THREE.MathUtils.degToRad(30 + 45 * sip);
      const inward = avatarLeft.clone().multiplyScalar(side === 'right' ? 1 : -1);
      const tip = inward.multiplyScalar(0.8).addScaledVector(fwd, -0.6).normalize();
      const axSip = up.clone().multiplyScalar(Math.cos(th)).addScaledVector(tip, Math.sin(th)).normalize();
      const rim = face.mouth.clone().addScaledVector(fwd, P.rimR * s * 0.9).addScaledVector(up, -P.rimR * s * 0.1);
      const Cs = rim.addScaledVector(axSip, -P.halfH * s);
      C.lerp(Cs, w * 0.92);
      axis = axis.clone().lerp(axSip, w).normalize();
    }
    // ---- basis: +Y = axis, +Z (logos) toward the camera side, +X = Y × Z (mug handle: outward) ----
    const Y = axis.normalize();
    const Z = fwd.clone().addScaledVector(Y, -fwd.dot(Y));
    if (Z.lengthSq() < 1e-6) Z.copy(up).addScaledVector(Y, -up.dot(Y));
    Z.normalize();
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
    if (cur.kind === 'mug' && side === 'right') { X.negate(); Z.negate(); } // handle away from the body
    // pop in / out (ease-out-back)
    const a = this.shown[side];
    const pop = a >= 1 ? 1 : 1 + 2.2 * Math.pow(a - 1, 3) + 1.2 * Math.pow(a - 1, 2);
    _m.makeBasis(X, Y, Z).setPosition(C);
    _m.scale(_s.setScalar(Math.max(0.001, s * pop)));
    this.host.anchor.updateWorldMatrix(true, false);
    P.root.matrix.copy(this.host.anchor.matrixWorld).invert().multiply(_m);
    P.root.matrixWorldNeedsUpdate = true;
  }

  private buildMess() {
    this.messTried = true;
    try {
      const R = this.rest, host = this.host, model = host.model;
      model.updateWorldMatrix(true, true);
      const meshes = collectMeshes(model);
      const face = R.mouthMarker ?? restRaycast(meshes, model, R.mouthModel.clone().addScaledVector(R.fwdModel, R.faceSize / R.scaleW), R.fwdModel.clone().negate(), (R.faceSize * 2) / R.scaleW);
      const sites: { face: MessSite | null; left: MessSite | null; right: MessSite | null } = { face: null, left: null, right: null };
      if (face) sites.face = { marker: face, radius: Math.min(Math.max(R.faceSize * 0.55, R.mouthHalf[0] * 3), R.faceSize * 0.9), mouth: R.mouthHalf, hand: false, faceSize: R.faceSize };
      for (const s of ['left', 'right'] as Side[]) {
        const hd = R.hands[s];
        if (!hd) continue;
        const n = R.fwdModel.toArray() as Vec3;
        const hb = bone(host.humanoid, `${s}Hand`);
        const bones: THREE.Object3D[] = [];
        hb?.traverse((o) => { if ((o as THREE.Bone).isBone || o === hb) bones.push(o); });
        sites[s] = { marker: { position: hd.gripModel.toArray() as Vec3, normal: n }, radius: hd.len * 0.8, mouth: [0, 0], hand: true, bones: bones.length ? bones : undefined };
      }
      const fm = new FoodMess(meshes, model, host.anchor, sites);
      if (fm.empty) { fm.dispose(); return; }
      this.mess = fm;
    } catch (e) { console.warn('[snacks] mess layer failed', e); this.mess = null; }
  }

  private puff(face: { mouth: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3 }, style: MessStyle) {
    this.crumbGeo ??= new THREE.IcosahedronGeometry(1, 0);
    const cols = CRUMB_COL[style];
    const S = this.rest.faceSize;
    const inv = this.host.anchor.matrixWorld.clone().invert();
    for (let i = 0; i < 7; i++) {
      const c = cols[i % cols.length];
      let mat = this.crumbMats.get(c);
      if (!mat) { mat = new THREE.MeshToonMaterial({ color: c }); this.crumbMats.set(c, mat); }
      const m = new THREE.Mesh(this.crumbGeo, mat);
      const p = face.mouth.clone().addScaledVector(face.fwd, S * 0.08).addScaledVector(face.up, -S * 0.08);
      m.position.copy(p.applyMatrix4(inv));
      m.scale.setScalar(S * (0.018 + Math.random() * 0.02));
      const side = new THREE.Vector3().crossVectors(face.up, face.fwd);
      const v = face.fwd.clone().multiplyScalar(S * (0.5 + Math.random() * 0.6)).addScaledVector(side, S * (Math.random() - 0.5) * 1.4).addScaledVector(face.up, S * (0.2 + Math.random() * 0.5));
      const vl = v.length();
      v.transformDirection(inv).multiplyScalar(vl);
      this.group.add(m);
      this.crumbs.push({ m, v, age: 0, life: 0.7 + Math.random() * 0.4, spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9) });
    }
  }

  private stepCrumbs(dt: number) {
    const g = this.rest.faceSize * 5;
    for (let i = this.crumbs.length - 1; i >= 0; i--) {
      const c = this.crumbs[i];
      c.age += dt;
      if (c.age >= c.life) { c.m.removeFromParent(); this.crumbs.splice(i, 1); continue; }
      c.v.y -= g * dt;
      c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt;
      const k = c.age / c.life;
      if (k > 0.7) c.m.scale.multiplyScalar(Math.exp(-6 * dt));
    }
  }

  dispose() {
    for (const s of ['left', 'right'] as Side[]) this.props[s]?.p.dispose();
    this.mess?.dispose();
    for (const c of this.crumbs) c.m.removeFromParent();
    this.crumbGeo?.dispose();
    for (const m of this.crumbMats.values()) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Raycast the REST geometry (unskinned vertex positions — what the surface patches are built from), in
 * model space. Returns a surface marker or null. Linear in triangles; runs once per avatar, lazily.
 */
function restRaycast(meshes: THREE.Mesh[], model: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, far: number): SurfaceMarker | null {
  const inv = model.matrixWorld.clone().invert();
  const ray = new THREE.Ray(origin, dir.clone().normalize());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  let best: { d: number; p: THREE.Vector3; n: THREE.Vector3 } | null = null;
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const M = inv.clone().multiply(mesh.matrixWorld);
    const g = mesh.geometry, pos = g.attributes.position, idx = fullIndex(g);   // (full list, whatever Avatar detail draws)
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(M); b.fromBufferAttribute(pos, i1).applyMatrix4(M); c.fromBufferAttribute(pos, i2).applyMatrix4(M);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const d = hit.distanceTo(origin);
      if (d > far || (best && d >= best.d)) continue;
      const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      if (nn.dot(ray.direction) > 0) nn.negate();
      best = { d, p: hit.clone(), n: nn };
    }
  }
  return best ? { position: best.p.toArray() as Vec3, normal: best.n.toArray() as Vec3 } : null;
}

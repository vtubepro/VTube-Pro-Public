// Soft rig: instant procedural skeleton + skin weights for meshes that arrive with no rig.
// Torso weights are height-banded (so wide blob bodies bend like squishy creatures instead of
// melting), limbs take over by proximity. Everything uses VRM humanoid bone names, so the
// same retargeting/physics code drives it. Blender bone-heat (server autorig) is the upgrade.

import * as THREE from 'three';
import type { SoftRigConfig, Vec3 } from '../../shared/types.ts';
import { collectMeshes } from './surfacePatch.ts';

const ss = THREE.MathUtils.smoothstep;

export interface SoftRigResult {
  bones: Record<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
}

interface Cloud { pts: Float32Array; box: THREE.Box3 }

function cloud(meshes: THREE.Mesh[]): Cloud {
  let n = 0;
  for (const m of meshes) n += m.geometry.attributes.position.count;
  const pts = new Float32Array(n * 3);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let k = 0;
  for (const m of meshes) {
    m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      pts[k++] = v.x; pts[k++] = v.y; pts[k++] = v.z;
      box.expandByPoint(v);
    }
  }
  return { pts, box };
}

/** Mean x/z (and half-width) of vertices in a horizontal slice. */
function slice(c: Cloud, y: number, band: number, xMin = -Infinity, xMax = Infinity) {
  let sx = 0, sz = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < c.pts.length; i += 3) {
    const py = c.pts[i + 1];
    if (Math.abs(py - y) > band) continue;
    const px = c.pts[i];
    if (px < xMin || px > xMax) continue;
    sx += px; sz += c.pts[i + 2]; n++;
    lo = Math.min(lo, px); hi = Math.max(hi, px);
  }
  return n ? { x: sx / n, z: sz / n, halfWidth: (hi - lo) / 2, n } : null;
}

/** Guess a soft-rig config from the silhouette. */
export function guessSoftRig(root: THREE.Object3D): SoftRigConfig {
  const c = cloud(collectMeshes(root));
  const h = c.box.max.y - c.box.min.y;
  const at = (v: number) => c.box.min.y + v * h;
  // neck = narrowest slice between 60% and 90% height (humanoids); blobs fall back to 0.62
  let neck = 0.62, best = Infinity;
  const widths: number[] = [];
  for (let v = 0.5; v <= 0.92; v += 0.02) {
    const s = slice(c, at(v), h * 0.012);
    const w = s?.halfWidth ?? Infinity;
    widths.push(w);
    if (v >= 0.6 && w < best) { best = w; neck = v; }
  }
  const maxW = Math.max(...widths.filter(Number.isFinite));
  if (!(best < maxW * 0.7)) neck = 0.62; // no real neck narrowing → creature/blob proportions
  return { neck, chest: neck - 0.14, hips: Math.max(0.2, neck - 0.36), leftShoulder: null, rightShoulder: null, leftHand: null, rightHand: null, blend: 0.06 };
}

export function buildSoftRig(root: THREE.Object3D, cfg: SoftRigConfig): SoftRigResult {
  const meshes = collectMeshes(root).filter((m) => !(m as THREE.SkinnedMesh).isSkinnedMesh);
  const c = cloud(meshes);
  const box = c.box;
  const size = box.getSize(new THREE.Vector3());
  const H = size.y;
  const at = (v: number) => box.min.y + v * H;
  const norm = (p: Vec3) => new THREE.Vector3(box.min.x + p[0] * size.x, box.min.y + p[1] * H, box.min.z + p[2] * size.z);
  const axisAt = (v: number) => {
    const s = slice(c, at(v), H * 0.03);
    return new THREE.Vector3(s?.x ?? (box.min.x + box.max.x) / 2, at(v), s?.z ?? (box.min.z + box.max.z) / 2);
  };

  // --- joints (world space at rest) ---
  const J: Record<string, THREE.Vector3> = {
    hips: axisAt(cfg.hips),
    spine: axisAt((cfg.hips + cfg.chest) / 2),
    chest: axisAt(cfg.chest),
    neck: axisAt(cfg.neck),
    head: axisAt(cfg.neck + (1 - cfg.neck) * 0.2),
  };
  const headTop = axisAt(0.995);
  // legs: detected when the centre line is empty low down (a gap between legs)
  const low = slice(c, at(0.18), H * 0.02);
  const mid = slice(c, at(0.18), H * 0.02, J.hips.x - size.x * 0.03, J.hips.x + size.x * 0.03);
  const hasLegs = !!low && (!mid || mid.n < low.n * 0.02) && cfg.hips > 0.3;
  if (hasLegs) {
    for (const [side, sgn] of [['left', 1], ['right', -1]] as const) {
      const band = sgn > 0 ? [J.hips.x, Infinity] : [-Infinity, J.hips.x];
      const knee = slice(c, at(cfg.hips * 0.5), H * 0.02, band[0], band[1]);
      const foot = slice(c, at(0.04), H * 0.02, band[0], band[1]);
      if (!knee || !foot) continue;
      J[`${side}UpperLeg`] = new THREE.Vector3(knee.x, at(cfg.hips - 0.03), J.hips.z);
      J[`${side}LowerLeg`] = new THREE.Vector3(knee.x, at(cfg.hips * 0.5), knee.z);
      J[`${side}Foot`] = new THREE.Vector3(foot.x, at(0.04), foot.z);
    }
  }
  const tails: Record<string, THREE.Vector3> = { head: headTop };
  for (const side of ['left', 'right'] as const) {
    const s = cfg[`${side}Shoulder`], hnd = cfg[`${side}Hand`];
    if (!s || !hnd) continue;
    const S = norm(s), Hd = norm(hnd);
    J[`${side}UpperArm`] = S;
    J[`${side}LowerArm`] = S.clone().lerp(Hd, 0.5);
    J[`${side}Hand`] = Hd;
    tails[`${side}Hand`] = Hd.clone().add(Hd.clone().sub(S).multiplyScalar(0.18));
    if (J[`${side}Foot`]) tails[`${side}Foot`] = J[`${side}Foot`].clone().add(new THREE.Vector3(0, 0, size.z * 0.3));
  }

  // joints found on the model itself (the import runs body tracking on a render: src/avatar/poseJoints.ts) win over the
  // slice guesses above: elbows, knees and feet land where the model's own are
  if (cfg.joints) {
    for (const [k, p] of Object.entries(cfg.joints)) if (p && k !== 'headTop') J[k] = norm(p);
    if (cfg.joints.headTop) tails.head = norm(cfg.joints.headTop);
    for (const side of ['left', 'right'] as const) {
      const hand = J[`${side}Hand`], fore = J[`${side}LowerArm`];
      if (hand && fore) tails[`${side}Hand`] = hand.clone().add(hand.clone().sub(fore).multiplyScalar(0.35));
      if (J[`${side}Foot`]) tails[`${side}Foot`] = J[`${side}Foot`].clone().add(new THREE.Vector3(0, -H * 0.02, size.z * 0.3));
    }
  }

  // --- hierarchy ---
  const parent: Record<string, string | null> = {
    hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
    leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
    rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
    leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
    rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
  };
  const names = Object.keys(parent).filter((n) => J[n]);
  const bones: Record<string, THREE.Bone> = {};
  root.updateWorldMatrix(true, false);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  for (const n of names) {
    const b = new THREE.Bone();
    b.name = n;
    bones[n] = b;
  }
  for (const n of names) {
    const p = parent[n];
    const local = J[n].clone().applyMatrix4(rootInv);
    if (p && bones[p]) {
      const pl = J[p].clone().applyMatrix4(rootInv);
      bones[n].position.copy(local.sub(pl));
      bones[p].add(bones[n]);
    } else {
      bones[n].position.copy(local);
      root.add(bones[n]);
    }
  }
  root.updateWorldMatrix(true, true);
  const boneList = names.map((n) => bones[n]);
  const skeleton = new THREE.Skeleton(boneList);

  // --- weights ---
  const torso = ['hips', 'spine', 'chest', 'neck', 'head'].filter((n) => bones[n]);
  const torsoH = torso.map((n) => (J[n].y - box.min.y) / H);
  const segEnd = (n: string) => {
    const kids = names.filter((k) => parent[k] === n && !k.includes('Arm') && !k.includes('Leg'));
    return tails[n] ?? (kids[0] ? J[kids[0]] : J[n].clone().add(new THREE.Vector3(0, H * 0.05, 0)));
  };
  const limbChains = (['left', 'right'] as const).flatMap((s) => [
    [`${s}UpperArm`, `${s}LowerArm`, `${s}Hand`],
    [`${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`],
  ]).filter((ch) => ch.every((n) => bones[n]));
  const seg = new THREE.Line3();
  const tmp = new THREE.Vector3();
  const segDist = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => { seg.set(a, b); seg.closestPointToPoint(p, true, tmp); return tmp.distanceTo(p); };
  const segT = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => { seg.set(a, b); return seg.closestPointToPointParameter(p, false); };
  const idx = (n: string) => boneList.indexOf(bones[n]);

  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const skinIndex = new Uint16Array(pos.count * 4);
    const skinWeight = new Float32Array(pos.count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const w = new Map<number, number>();
      const add = (b: number, x: number) => { if (x > 1e-4) w.set(b, (w.get(b) ?? 0) + x); };
      const hv = (v.y - box.min.y) / H;
      // torso: smooth height bands
      const torsoW: number[] = torso.map(() => 0);
      for (let k = 0; k < torso.length; k++) {
        // band k spans the midpoints to its neighbouring joints
        const lo = k === 0 ? -Infinity : (torsoH[k - 1] + torsoH[k]) / 2;
        const hi = k === torso.length - 1 ? Infinity : (torsoH[k] + torsoH[k + 1]) / 2;
        const up = lo === -Infinity ? 1 : ss(hv, lo - cfg.blend, lo + cfg.blend);
        const down = hi === Infinity ? 1 : 1 - ss(hv, hi - cfg.blend, hi + cfg.blend);
        torsoW[k] = up * down;
      }
      // torso axis distance (for limb takeover)
      let dAxis = Infinity;
      for (let k = 0; k < torso.length; k++) dAxis = Math.min(dAxis, segDist(v, J[torso[k]], segEnd(torso[k])));
      let limbTotal = 0;
      for (const ch of limbChains) {
        const [a, b, c2] = ch;
        const end = tails[c2] ?? J[c2].clone().add(J[c2].clone().sub(J[b]).multiplyScalar(0.3));
        const d = Math.min(segDist(v, J[a], J[b]), segDist(v, J[b], J[c2]), segDist(v, J[c2], end));
        const ratio = dAxis / (d + dAxis + 1e-6);
        let l = ss(ratio, 0.5, 0.68);
        // legs never capture vertices above the hips
        if (a.includes('Leg')) l *= 1 - ss(hv, cfg.hips - 0.02, cfg.hips + 0.04);
        if (l < 1e-3) continue;
        // along-chain split
        const tU = segT(v, J[a], J[b]), tL = segT(v, J[b], J[c2]);
        const wUpper = 1 - ss(tU, 0.85, 1.1);
        const wHand = ss(tL, 0.9, 1.05);
        const wLower = Math.max(0, 1 - wUpper - wHand);
        add(idx(a), l * wUpper); add(idx(b), l * wLower); add(idx(c2), l * wHand);
        limbTotal += l;
      }
      const tScale = Math.max(0, 1 - Math.min(1, limbTotal));
      const tSum = torsoW.reduce((a, b) => a + b, 0) || 1;
      torso.forEach((n, k) => add(idx(n), (torsoW[k] / tSum) * tScale));
      // top-4, normalized
      const top = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((a, [, x]) => a + x, 0) || 1;
      top.forEach(([b, x], c) => { skinIndex[i * 4 + c] = b; skinWeight[i * 4 + c] = x / sum; });
      if (!top.length) { skinIndex[i * 4] = idx('hips'); skinWeight[i * 4] = 1; }
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

    // swap Mesh → SkinnedMesh in place
    const sm = new THREE.SkinnedMesh(g, mesh.material);
    sm.name = mesh.name;
    sm.position.copy(mesh.position); sm.quaternion.copy(mesh.quaternion); sm.scale.copy(mesh.scale);
    sm.castShadow = mesh.castShadow; sm.receiveShadow = mesh.receiveShadow;
    sm.morphTargetDictionary = mesh.morphTargetDictionary;
    sm.morphTargetInfluences = mesh.morphTargetInfluences;
    const parentObj = mesh.parent!;
    parentObj.add(sm);
    parentObj.remove(mesh);
    for (const child of [...mesh.children]) sm.add(child);
    sm.updateWorldMatrix(true, false);
    sm.bind(skeleton, sm.matrixWorld.clone());
    sm.frustumCulled = false;
  }
  return { bones, skeleton };
}

// Secondary motion: spring-bone chains (hair, tails, ears, ribbons, dangling accessories) and
// jiggle regions (belly, chest, cheeks, anything soft) — works on any skinned model, not just VRM.

import * as THREE from 'three';
import {
  VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapeSphere,
  VRMSpringBoneJoint, VRMSpringBoneManager, type VRMHumanoid, type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm';
import type { JiggleRegion, SpringChainConfig } from '../../shared/types.ts';
import { findAttachBone } from './eyes.ts';

/** Bone names that start an automatic spring chain (also read by the model wizard's report: src/onboarding). */
export const AUTO_CHAIN = /(hair|bang|fringe|ponytail|braid|twintail|pigtail|tail|ear(?!ring)|skirt|dress|cape|cloak|coat_?tail|ribbon|bow|tie|scarf|sleeve|tassel|chain|pendant|earring|antenna|ahoge|tentacle|feather|plume|pom_?pom|sash|fringe|strap|hat|hood|breast|bust|oppai|boob|chest_?soft)/i;
export const JIGGLE_NAME = /(breast|bust|oppai|boob|belly_?jiggle|jiggle|butt|glute|cheek_)/i;

interface JiggleBone {
  bone: THREE.Bone;
  parent: THREE.Object3D;
  rest: THREE.Vector3; // local rest position
  x: THREE.Vector3; v: THREE.Vector3;
  cfg: JiggleRegion;
  maxDisp: number;
}

export class PhysicsSystem {
  readonly springs = new VRMSpringBoneManager();
  private jiggles: JiggleBone[] = [];
  private acc = 0;
  wind = 0;
  private windT = 0;
  private gravityDirs = new Map<VRMSpringBoneJoint, THREE.Vector3>();

  /** Make colliders on the humanoid so hair doesn't clip through the head/body. */
  buildColliders(humanoid: VRMHumanoid | null, scale: number): VRMSpringBoneColliderGroup[] {
    if (!humanoid) return [];
    const colliders: VRMSpringBoneCollider[] = [];
    const add = (bone: string, shape: VRMSpringBoneColliderShapeSphere | VRMSpringBoneColliderShapeCapsule) => {
      const node = humanoid.getRawBoneNode(bone as never);
      if (!node) return;
      const c = new VRMSpringBoneCollider(shape);
      node.add(c);
      colliders.push(c);
    };
    const head = humanoid.getRawBoneNode('head');
    const neck = humanoid.getRawBoneNode('neck');
    const headR = scale * 0.09;
    if (head) add('head', new VRMSpringBoneColliderShapeSphere({ radius: headR, offset: new THREE.Vector3(0, headR * 0.8, 0) }));
    if (neck) add('neck', new VRMSpringBoneColliderShapeSphere({ radius: scale * 0.05 }));
    add('chest', new VRMSpringBoneColliderShapeCapsule({ radius: scale * 0.1, offset: new THREE.Vector3(0, 0, 0), tail: new THREE.Vector3(0, scale * 0.15, 0) }));
    return colliders.length ? [{ colliders, name: 'vtp-body' }] : [];
  }

  /** Spring chains: explicit ones + auto-detected by bone name (skipping humanoid bones). */
  buildChains(root: THREE.Object3D, humanoid: VRMHumanoid | null, chains: SpringChainConfig[], auto: boolean, colliders: VRMSpringBoneColliderGroup[], hitRadius: number) {
    const humanNodes = new Set<THREE.Object3D>();
    if (humanoid) for (const b of Object.values(humanoid.humanBones)) if (b?.node) humanNodes.add(b.node);
    const roots: { bone: THREE.Object3D; cfg: SpringChainConfig }[] = [];
    for (const c of chains) {
      const b = root.getObjectByName(c.rootBone);
      if (b) roots.push({ bone: b, cfg: c });
    }
    if (auto) {
      root.traverse((o) => {
        if (!(o as THREE.Bone).isBone || humanNodes.has(o) || !AUTO_CHAIN.test(o.name) || JIGGLE_NAME.test(o.name)) return;
        if (o.parent && (o.parent as THREE.Bone).isBone && AUTO_CHAIN.test(o.parent.name) && !humanNodes.has(o.parent)) return; // not a chain root
        if (roots.some((r) => r.bone === o)) return;
        const isHat = /hat|hood/i.test(o.name);
        roots.push({ bone: o, cfg: { rootBone: o.name, stiffness: isHat ? 3.2 : 1.1, drag: isHat ? 0.55 : 0.4, gravity: isHat ? 0.1 : 0.35, radius: hitRadius } });
      });
    }
    for (const { bone, cfg } of roots) this.addChain(bone, cfg, colliders);
    this.springs.setInitState();
  }

  private addChain(bone: THREE.Object3D, cfg: SpringChainConfig, colliders: VRMSpringBoneColliderGroup[]) {
    const walk = (b: THREE.Object3D, depth: number) => {
      const kids = b.children.filter((c) => (c as THREE.Bone).isBone);
      const child = kids[0] ?? null;
      const gravityDir = new THREE.Vector3(0, -1, 0);
      // stiffness falls off toward the tip for natural hair motion
      const falloff = Math.pow(0.85, depth);
      const j = new VRMSpringBoneJoint(b, child, {
        hitRadius: cfg.radius, stiffness: cfg.stiffness * falloff, gravityPower: cfg.gravity,
        gravityDir, dragForce: cfg.drag,
      }, colliders);
      this.springs.addJoint(j);
      this.gravityDirs.set(j, gravityDir);
      for (const k of kids) walk(k, depth + 1);
    };
    walk(bone, 0);
  }

  /** Jiggle regions: inject a bone per region and blend it into nearby skin weights. */
  buildJiggles(root: THREE.Object3D, regions: JiggleRegion[], meshes: THREE.Mesh[]) {
    root.updateWorldMatrix(true, true);
    const skinned = meshes.filter((m) => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh[];
    for (const r of regions) {
      const center = new THREE.Vector3(...r.center).applyMatrix4(root.matrixWorld);
      const scale = root.getWorldScale(new THREE.Vector3()).x;
      const R = r.radius * scale;
      const parent = (r.parentBone && root.getObjectByName(r.parentBone)) || findAttachBone(skinned, center) || root;
      const bone = new THREE.Bone();
      bone.name = `vtp_jiggle_${r.id}`;
      parent.add(bone);
      parent.updateWorldMatrix(true, false);
      bone.position.copy(parent.worldToLocal(center.clone()));
      bone.updateWorldMatrix(false, false);
      const inv = bone.matrixWorld.clone().invert();
      const swapped = new Map<THREE.Skeleton, THREE.Skeleton>();
      for (const m of skinned) {
        const pos = m.geometry.attributes.position;
        const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute;
        const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        const hits: [number, number][] = [];
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          const d = v.distanceTo(center);
          if (d >= R) continue;
          const f = Math.pow(1 - THREE.MathUtils.smoothstep(d, 0, R), 1.4) * 0.9;
          if (f > 0.01) hits.push([i, f]);
        }
        if (!hits.length) continue;
        let skel = swapped.get(m.skeleton);
        if (!skel) {
          skel = new THREE.Skeleton([...m.skeleton.bones, bone], [...m.skeleton.boneInverses.map((b) => b.clone()), inv.clone()]);
          swapped.set(m.skeleton, skel);
        }
        const bi = skel.bones.length - 1;
        // skinIndex may be Uint8 — upgrade if the new index doesn't fit
        let siArr = si.array as Uint8Array | Uint16Array;
        if (bi > 255 && siArr instanceof Uint8Array) {
          siArr = Uint16Array.from(siArr);
          m.geometry.setAttribute('skinIndex', new THREE.BufferAttribute(siArr, 4));
        }
        const swArr = sw.array as Float32Array;
        const norm = sw.normalized;
        for (const [i, f] of hits) {
          // replace the smallest influence with the jiggle bone, scale the rest
          let minC = 0, minW = Infinity;
          for (let c = 0; c < 4; c++) {
            const w = norm ? swArr[i * 4 + c] / 255 : swArr[i * 4 + c];
            if (w < minW) { minW = w; minC = c; }
          }
          let total = 0;
          for (let c = 0; c < 4; c++) if (c !== minC) total += norm ? swArr[i * 4 + c] / 255 : swArr[i * 4 + c];
          const k = total > 0 ? (1 - f) / total : 0;
          for (let c = 0; c < 4; c++) {
            if (c === minC) continue;
            swArr[i * 4 + c] = norm ? Math.round(swArr[i * 4 + c] * k) : swArr[i * 4 + c] * k;
          }
          siArr[i * 4 + minC] = bi;
          swArr[i * 4 + minC] = norm ? Math.round(f * 255) : f;
        }
        (m.geometry.attributes.skinIndex as THREE.BufferAttribute).needsUpdate = true;
        sw.needsUpdate = true;
        m.bind(skel, m.bindMatrix);
      }
      // other meshes sharing a swapped skeleton (e.g. same-rig clothing) must switch too
      for (const m of skinned) { const s = swapped.get(m.skeleton); if (s) m.bind(s, m.bindMatrix); }
      const x = center.clone();
      this.jiggles.push({ bone, parent, rest: bone.position.clone(), x, v: new THREE.Vector3(), cfg: r, maxDisp: R * 0.45 * Math.max(0.2, r.amount) });
    }
  }

  /** Jiggle an existing bone (e.g. a model's own breast/belly bones). */
  addBoneJiggle(bone: THREE.Bone, cfg: Partial<JiggleRegion> = {}) {
    if (!bone.parent) return;
    bone.updateWorldMatrix(true, false);
    const size = bone.children[0]?.position.length() || bone.position.length() * 0.5 || 0.05;
    const full: JiggleRegion = { id: bone.name, name: bone.name, center: [0, 0, 0], radius: size, stiffness: 0.45, damping: 0.35, amount: 1, ...cfg };
    this.jiggles.push({
      bone, parent: bone.parent, rest: bone.position.clone(),
      x: bone.getWorldPosition(new THREE.Vector3()), v: new THREE.Vector3(),
      cfg: full, maxDisp: size * 0.6,
    });
  }

  update(dt: number) {
    this.windT += dt;
    if (this.wind > 0) {
      const w = this.wind;
      const gust = Math.sin(this.windT * 1.3) * 0.5 + Math.sin(this.windT * 3.7) * 0.25 + 0.5;
      for (const g of this.gravityDirs.values()) g.set(Math.sin(this.windT * 0.7) * 0.4 * w * gust, -1, -0.8 * w * gust).normalize();
    }
    this.springs.update(dt);
    // jiggles at a fixed 120 Hz so they're stable at any frame rate
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 120;
    const target = new THREE.Vector3();
    while (this.acc >= h) {
      this.acc -= h;
      for (const j of this.jiggles) {
        target.copy(j.rest).applyMatrix4(j.parent.matrixWorld);
        const f = THREE.MathUtils.lerp(1.2, 7, j.cfg.stiffness);
        const w = 2 * Math.PI * f;
        const zeta = THREE.MathUtils.lerp(0.06, 0.9, j.cfg.damping);
        const a = target.clone().sub(j.x).multiplyScalar(w * w).addScaledVector(j.v, -2 * zeta * w);
        a.y -= 0.6 * (1 - j.cfg.stiffness); // a little sag
        j.v.addScaledVector(a, h);
        j.x.addScaledVector(j.v, h);
        const off = j.x.clone().sub(target);
        if (off.length() > j.maxDisp) { off.setLength(j.maxDisp); j.x.copy(target).add(off); j.v.multiplyScalar(0.5); }
      }
    }
    for (const j of this.jiggles) {
      target.copy(j.rest).applyMatrix4(j.parent.matrixWorld);
      const world = target.clone().lerp(j.x, Math.min(2, j.cfg.amount));
      j.bone.position.copy(j.parent.worldToLocal(world));
    }
  }

  /** Snap everything to rest (after teleporting / loading). */
  reset() {
    this.springs.reset();
    for (const j of this.jiggles) { j.bone.position.copy(j.rest); j.x.copy(j.rest).applyMatrix4(j.parent.matrixWorld); j.v.set(0, 0, 0); }
  }
}

/** Find bones that look like breast/jiggle bones and turn them into jiggle-style springs. */
export function autoJiggleBones(root: THREE.Object3D): THREE.Bone[] {
  const out: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone && JIGGLE_NAME.test(o.name)) out.push(o as THREE.Bone); });
  return out;
}

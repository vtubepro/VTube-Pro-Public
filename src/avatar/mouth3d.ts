// 3D carved mouth (opt-in, MouthStyle '3d').
//
// The surface model is never cut. Instead a stencil PORTAL is carved each frame:
//   1. mask pass  — the mouth patch, drawn with the same SDF as the 2D mouth, writes stencil=1 and
//                   pushes depth to the far plane wherever the mouth is open (colour off);
//   2. interior   — real geometry behind the face (throat bowl and a hinged lower jaw carrying the
//                   tongue) renders only where stencil==1, depth-tested normally among itself, so it
//                   has true parallax when the head turns;
//   3. overlay    — the regular patch then draws the lip line and the teeth on top. Teeth are ALWAYS the
//                   flat anime band drawn by the mouth shader — never 3D tooth geometry.
// Cost: one extra patch draw + ~5 small meshes and a stencil test.

import * as THREE from 'three';
import type { MouthConfig } from '../../shared/types.ts';
import { findAttachBone } from './eyes.ts';
import type { FaceFrame } from './surfacePatch.ts';

export interface Interior3DDrive { open: number; tongue: number; fv: number; sib: number; jaw: number; round: number; tongueUp?: number }

const stencilInside = (m: THREE.Material) => {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = THREE.EqualStencilFunc;
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.KeepStencilOp;
  return m;
};

export class MouthInterior3D {
  readonly masks: THREE.Mesh[] = [];
  readonly group = new THREE.Group();
  private jaw = new THREE.Group();
  private tongue: THREE.Mesh;
  private depth: number;
  private maxJaw: number;
  private w: number;

  constructor(frame: FaceFrame, cfg: MouthConfig, meshes: THREE.Mesh[], patches: THREE.Mesh[], maskMaterial: THREE.ShaderMaterial, depthClearMaterial: THREE.ShaderMaterial) {
    const w = cfg.width, h = cfg.openHeight;
    this.w = w;
    this.depth = w * 1.05;
    this.maxJaw = Math.atan2(h * 1.1, this.depth * 0.9);

    // 1) portal passes share geometry/skeleton/morph weights with the visible patches.
    //    a) mark: depth-tested against the face (so a hand in front still occludes), writes stencil=1
    maskMaterial.colorWrite = false;
    maskMaterial.depthWrite = false;
    maskMaterial.depthTest = true;
    maskMaterial.depthFunc = THREE.LessEqualDepth;
    maskMaterial.transparent = false;
    maskMaterial.stencilWrite = true;
    maskMaterial.stencilRef = 1;
    maskMaterial.stencilFunc = THREE.AlwaysStencilFunc;
    maskMaterial.stencilZPass = THREE.ReplaceStencilOp;
    //    b) punch: where stencil==1, force depth to the far plane (the GPU tests the WRITTEN depth,
    //       so this pass must use depthFunc Always — the stencil keeps it inside the mark)
    depthClearMaterial.colorWrite = false;
    depthClearMaterial.depthWrite = true;
    depthClearMaterial.depthTest = true;
    depthClearMaterial.depthFunc = THREE.AlwaysDepth;
    depthClearMaterial.transparent = false;
    stencilInside(depthClearMaterial);
    for (const [mat, order, tag] of [[maskMaterial, 1, 'portal'], [depthClearMaterial, 1.5, 'punch']] as const)
    for (const p of patches) {
      let m: THREE.Mesh;
      if ((p as THREE.SkinnedMesh).isSkinnedMesh) {
        const sp = p as THREE.SkinnedMesh;
        const sm = new THREE.SkinnedMesh(p.geometry, mat);
        sm.bind(sp.skeleton, sp.bindMatrix);
        m = sm;
      } else m = new THREE.Mesh(p.geometry, mat);
      m.position.copy(p.position); m.quaternion.copy(p.quaternion); m.scale.copy(p.scale);
      m.morphTargetDictionary = p.morphTargetDictionary;
      m.morphTargetInfluences = p.morphTargetInfluences; // shared: follows the jaw/smile morphs
      m.renderOrder = order;
      m.frustumCulled = false;
      m.userData.vtpGenerated = true; m.userData.vtpNoToon = true;
      m.name = `${p.name}_${tag}`;
      p.parent?.add(m);
      this.masks.push(m);
    }

    // 2) interior geometry in the mouth frame (x = avatar-left, y = up along the face, z = out)
    // the tongue is clipped to the hole (stencil) like the bowl — on a carved / sculpted face it would
    // otherwise poke through the skin — and only unclipped while it is actually stuck out past the lips
    const toon = (color: string) => new THREE.MeshToonMaterial({ color });
    const d = this.depth;
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), stencilInside(new THREE.MeshBasicMaterial({ color: cfg.interiorColor, side: THREE.BackSide })));
    bowl.scale.set(w * 1.2, h * 0.9 + w * 0.35, d);
    bowl.position.set(0, -h * 0.25, -d * 0.55);
    // darker throat core so the depth reads
    const throat = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), stencilInside(new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.interiorColor).multiplyScalar(0.45) })));
    throat.scale.set(w * 0.45, h * 0.4 + w * 0.15, w * 0.2);
    throat.position.set(0, -h * 0.25, -d * 1.3);
    // hinged jaw: pivot behind the mouth, the tongue rides it (teeth are drawn flat by the overlay)
    this.jaw.position.set(0, w * 0.04, -d * 0.85);
    this.tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 16), stencilInside(toon(cfg.tongueColor)));
    this.tongue.scale.set(w * 0.55, w * 0.16 + h * 0.08, d * 0.55);
    this.tongue.position.set(0, -w * 0.18, d * 0.28);
    this.jaw.add(this.tongue);
    this.group.add(bowl, throat, this.jaw);
    this.tongue.visible = cfg.showTongue;
    this.group.traverse((o) => { o.renderOrder = 2; o.frustumCulled = false; o.userData.vtpGenerated = true; o.userData.vtpNoToon = true; });
    this.group.name = 'vtp_mouth3d';

    // ride the head bone
    const bone = findAttachBone(meshes, frame.c) ?? meshes[0]?.parent ?? null;
    if (bone) {
      bone.updateWorldMatrix(true, false);
      bone.add(this.group);
      this.group.position.copy(bone.worldToLocal(frame.c.clone()));
      const basis = new THREE.Matrix4().makeBasis(frame.T, frame.B, frame.N);
      const qw = new THREE.Quaternion().setFromRotationMatrix(basis);
      this.group.quaternion.copy(bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qw));
      const ws = bone.getWorldScale(new THREE.Vector3());
      this.group.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
    }
  }

  update(d: Interior3DDrive) {
    const open = THREE.MathUtils.clamp(d.open, 0, 1);
    this.jaw.rotation.x = this.maxJaw * open * (1 - d.fv * 0.8) * (1 - d.sib * 0.7);
    this.jaw.rotation.y = d.jaw * 0.12 * open;
    // tongue: rests low, slides out past the lips with tongueOut — only as far as the mouth is open,
    // or it would push straight through the chin
    const room = Math.min(1, open * 2.2 + 0.15);
    this.tongue.position.z = this.depth * (0.28 + d.tongue * 0.9 * room);
    this.tongue.scale.z = this.depth * (0.55 + d.tongue * 0.2);
    // L / N / D: the tongue tip lifts toward the upper teeth (tilts up, rises, slides a touch forward)
    const up = Math.min(1, Math.max(0, d.tongueUp ?? 0)) * (1 - d.tongue);
    this.tongue.rotation.x = -0.55 * up;
    this.tongue.position.y = -this.w * 0.18 + this.w * 0.2 * up;
    this.tongue.position.z += this.depth * 0.12 * up;
    (this.tongue.material as THREE.Material).stencilWrite = d.tongue < 0.3;
  }

  dispose() {
    // the portal passes draw the mouth's patch geometry (the mouth disposes that); their two materials are ours
    for (const m of this.masks) m.removeFromParent();
    for (const mat of new Set(this.masks.map((m) => m.material as THREE.Material))) mat.dispose();
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  }
}

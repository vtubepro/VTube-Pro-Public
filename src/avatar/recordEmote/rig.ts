// "Record my own emote" (lane recemote): read the avatar's solved pose as a clip, and turn a clip into the animation that
// src/avatar/emotes.ts EmoteLayer plays. The two are exact opposites of each other, so a clip recorded on one avatar plays
// the same movement on any other humanoid (A-pose or T-pose, VRM 0.x or 1.0): bones are matched by their humanoid names.
//
// EmoteLayer turns a clip rotation `qa` of a bone into that bone's local rotation
//        local = sInv(parent)^-1 . qa . sInv(bone)        (sInv = the swing from this model's rest direction to the T-pose)
// so recording is
//        qa = sInv(parent) . local . sInv(bone)^-1
// with the same sInv. We rebuild sInv the same way EmoteLayer does (it keeps it private). tools/record_emote_unit.ts plays a
// recording back through the real EmoteLayer on rigs with different rest poses and checks the bones come back the same, so the
// two cannot drift apart unnoticed.
import * as THREE from 'three';
import { VRMHumanBoneParentMap, type VRMHumanBoneName, type VRMHumanoid } from '@pixiv/three-vrm';
import { VRMAnimation } from '@pixiv/three-vrm-animation';
import { FACE_BONES, type Take } from './clip.ts';

/** T-pose directions (same table as EmoteLayer, VRM normalized space: faces +Z, the avatar's left = +X). */
const TDIR: Partial<Record<VRMHumanBoneName, [VRMHumanBoneName, [number, number, number]]>> = {
  hips: ['spine', [0, 1, 0]], spine: ['chest', [0, 1, 0]], chest: ['neck', [0, 1, 0]], upperChest: ['neck', [0, 1, 0]], neck: ['head', [0, 1, 0]],
  leftShoulder: ['leftUpperArm', [1, 0, 0]], leftUpperArm: ['leftLowerArm', [1, 0, 0]], leftLowerArm: ['leftHand', [1, 0, 0]],
  rightShoulder: ['rightUpperArm', [-1, 0, 0]], rightUpperArm: ['rightLowerArm', [-1, 0, 0]], rightLowerArm: ['rightHand', [-1, 0, 0]],
  leftUpperLeg: ['leftLowerLeg', [0, -1, 0]], leftLowerLeg: ['leftFoot', [0, -1, 0]], rightUpperLeg: ['rightLowerLeg', [0, -1, 0]], rightLowerLeg: ['rightFoot', [0, -1, 0]],
};

export interface RigBone { bone: VRMHumanBoneName; parent: VRMHumanBoneName | null; node: THREE.Object3D; sInv: THREE.Quaternion }
export interface Rig { vrm0: boolean; chain: RigBone[]; byBone: Map<VRMHumanBoneName, RigBone> }

/** The avatar's humanoid bones, parent first, each with its rest correction (identity on T-posed VRMs). */
export function buildRig(humanoid: VRMHumanoid, vrm0: boolean): Rig {
  const rest = humanoid.normalizedRestPose;
  const depth = (b: VRMHumanBoneName): number => { let d = 0, p = VRMHumanBoneParentMap[b]; while (p) { d++; p = VRMHumanBoneParentMap[p]; } return d; };
  const names = (Object.keys(humanoid.humanBones) as VRMHumanBoneName[]).filter((b) => humanoid.getNormalizedBoneNode(b)).sort((a, b) => depth(a) - depth(b));
  const chain: RigBone[] = [];
  for (const b of names) {
    let p = VRMHumanBoneParentMap[b];
    while (p && !humanoid.getNormalizedBoneNode(p)) p = VRMHumanBoneParentMap[p];
    const sInv = new THREE.Quaternion();
    const td = TDIR[b];
    const cp = td ? rest[td[0]]?.position : undefined;
    if (td && cp) {
      const r = new THREE.Vector3(...cp);
      const T = new THREE.Vector3(...td[1]); if (vrm0) { T.x = -T.x; T.z = -T.z; }
      if (r.lengthSq() > 1e-8) sInv.setFromUnitVectors(r.normalize(), T).normalize();
    }
    chain.push({ bone: b, parent: p ?? null, node: humanoid.getNormalizedBoneNode(b)!, sInv });
  }
  return { vrm0, chain, byBone: new Map(chain.map((c) => [c.bone, c])) };
}

const qp = new THREE.Quaternion(), qb = new THREE.Quaternion(), qn = new THREE.Quaternion();

/** The bones a take records (all of them, except the face ones, which stay live). */
export function recordableBones(rig: Rig): VRMHumanBoneName[] {
  return rig.chain.filter((c) => !FACE_BONES.has(c.bone)).map((c) => c.bone);
}

/** Write the avatar's current pose as clip rotations into frame `f` of `out`. Allocation free (reuses three scratch quaternions). */
export function sampleRig(rig: Rig, out: Record<string, Float32Array>, f: number) {
  for (const c of rig.chain) {
    const dst = out[c.bone];
    if (!dst) continue;
    // qa = S(parent) . local . S(bone)^-1   (the root has no parent term)
    qn.copy(c.node.quaternion);
    if (c.parent) { const p = rig.byBone.get(c.parent)!; qp.copy(p.sInv); qn.premultiply(qp); }
    qb.copy(c.sInv).invert();
    qn.multiply(qb);
    if (rig.vrm0) { qn.x = -qn.x; qn.z = -qn.z; }   // EmoteLayer flips x and z after sampling a VRM 0.x clip: the flip is its own inverse
    if (qn.w < 0) { qn.x = -qn.x; qn.y = -qn.y; qn.z = -qn.z; qn.w = -qn.w; }
    qn.normalize();
    dst[f * 4] = qn.x; dst[f * 4 + 1] = qn.y; dst[f * 4 + 2] = qn.z; dst[f * 4 + 3] = qn.w;
  }
}

/** A take as the VRMAnimation EmoteLayer plays (only duration and the rotation tracks are read; the face stays live). */
export function takeToAnimation(t: Take): VRMAnimation {
  const a = new VRMAnimation();
  const times = new Float32Array(t.frames);
  for (let f = 0; f < t.frames; f++) times[f] = f / t.fps;
  a.duration = Math.max(1 / t.fps, (t.frames - 1) / t.fps);
  for (const [bone, q] of Object.entries(t.bones)) {
    a.humanoidTracks.rotation.set(bone as VRMHumanBoneName, { times, values: q } as unknown as THREE.QuaternionKeyframeTrack);
  }
  return a;
}

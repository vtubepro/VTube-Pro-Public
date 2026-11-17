// The DJ pose layer (src/scene/club): while the host stands at the DJ booth their arms play the decks — hands on the
// jog wheels / mixer, scratching and riding faders on the beat, a "headphone to the ear" moment every ~15 s (a
// headphone cup appears in the right hand), both fists up on drops. Face, head, expressions and mouth stay tracked;
// only the arm bones are replaced (like the walk cycle does), blended in / out over ~0.4 s. Pure function of the beat
// clock + wall time, so every OBS page shows the same moves. Rigs without humanoid arms are left alone.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { SceneActor } from '../actor.ts';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';

const X = new THREE.Vector3(1, 0, 0);
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion(), q4 = new THREE.Quaternion(), q5 = new THREE.Quaternion();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const lerp3 = (a: number[], b: number[], k: number) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };

export interface DjInput { t: number; beat: number; dropAge: number; weight: number }

export class DjPose {
  private base: ((rt: AvatarRuntime, dt: number) => void) | null = null;
  private wrap: (rt: AvatarRuntime, dt: number) => void;
  private w = 0;
  private input: DjInput = { t: 0, beat: 0, dropAge: 99, weight: 0 };
  private phones: THREE.Group | null = null;
  private phonesOn = 0;
  constructor(readonly actor: SceneActor) {
    this.wrap = (rt, dt) => { this.base?.(rt, dt); this.pose(rt, dt); };
  }

  /** call every frame; weight 0 = let go */
  update(i: DjInput) {
    this.input = i;
    if (this.actor.extraPose !== this.wrap) { this.base = this.actor.extraPose; this.actor.extraPose = this.wrap; }
  }
  release() {
    if (this.actor.extraPose === this.wrap) this.actor.extraPose = this.base;
    this.phones?.removeFromParent(); this.phones = null;
  }

  private pose(rt: AvatarRuntime, dt: number) {
    const i = this.input;
    // the DJ decks (src/scene/djdeck) own the arms while their groove pose holds them: stand aside
    const yieldArms = (this.actor as unknown as { djDeckOwns?: boolean }).djDeckOwns === true;
    this.w += ((yieldArms ? 0 : i.weight) - this.w) * Math.min(1, dt / 0.35);
    const h = rt.humanoid, rest = this.actor.rest;
    if (!h || !rest?.toNorm || this.w < 0.002) { if (this.phones) this.phones.visible = false; return; }
    const J = rest.joints, toNorm = rest.toNorm;
    const normParent = h.normalizedHumanBonesRoot.parent;
    // the moment: headphone to the ear (3.4 s every 15 s), fists up on drops, else the decks
    const hpCycle = 15, hpT = (i.t + 5) % hpCycle;
    const hp = smooth(hpT / 0.4) * (1 - smooth((hpT - 3.0) / 0.4)) * (hpT < 3.4 ? 1 : 0);
    const up = i.dropAge >= 0 && i.dropAge < 4 ? smooth(i.dropAge / 0.25) * (1 - smooth((i.dropAge - 3.4) / 0.6)) : 0;
    const bp = i.beat - Math.floor(i.beat);
    const pump = Math.exp(-bp * 5);
    for (const s of ['left', 'right'] as const) {
      const side = s === 'left' ? 1 : -1;
      const ua = h.getNormalizedBoneNode(`${s}UpperArm` as VRMHumanBoneName), la = h.getNormalizedBoneNode(`${s}LowerArm` as VRMHumanBoneName);
      const jU = J[`${s}UpperArm`], jL = J[`${s}LowerArm`], jH = J[`${s}Hand`];
      if (!ua || !la || !jU || !jL) continue;
      const restU = v1.copy(jL).sub(jU).normalize().applyQuaternion(toNorm);
      const restL = v2.copy(jH ?? jL.clone().add(jL.clone().sub(jU))).sub(jL).normalize().applyQuaternion(toNorm);
      // decks: forearms forward-down onto the jog wheels; the left hand scratches, the right rides the mixer
      const scratch = side > 0 ? 0.16 * Math.sin(i.beat * Math.PI * 2) : 0.07 * Math.sin(Math.floor(i.beat / 2) * 2.1);
      let du = [0.26 * side, -0.74, 0.62], dl = [(-0.14 + scratch) * side, -0.32, 0.93];
      if (side < 0 && hp > 0) { du = lerp3(du, [0.72 * side, 0.08, 0.3], hp); dl = lerp3(dl, [-0.5 * side, 0.84, 0.05], hp); }
      if (up > 0) { const k = up * (side > 0 ? 1 : 1 - hp); du = lerp3(du, [0.3 * side, 0.9, 0.15 + 0.1 * pump], k); dl = lerp3(dl, [0.06 * side, 0.99, 0.08], k); }
      const dU = v3.set(du[0], du[1], du[2]).normalize().applyQuaternion(toNorm);
      const parentW = worldQ(ua.parent, normParent, q1);
      const upW = q2.setFromUnitVectors(v1.copy(restU).applyQuaternion(parentW), dU).multiply(parentW);
      ua.quaternion.slerp(q3.copy(parentW).invert().multiply(upW), this.w);
      const upWb = q4.copy(parentW).multiply(ua.quaternion);
      const dL = v3.set(dl[0], dl[1], dl[2]).normalize().applyQuaternion(toNorm);
      const loW = q5.setFromUnitVectors(v1.copy(restL).applyQuaternion(upWb), dL).multiply(upWb);
      la.quaternion.slerp(q3.copy(upWb).invert().multiply(loW), this.w);
    }
    // the headphone cup in the right hand
    if (hp > 0.02 && this.w > 0.5) {
      const hand = (h as unknown as { getRawBoneNode?: (n: string) => THREE.Object3D | null }).getRawBoneNode?.('rightHand') ?? h.getNormalizedBoneNode('rightHand' as VRMHumanBoneName);
      if (hand) {
        if (!this.phones) this.phones = makePhones(rest.height);
        if (this.phones.parent !== hand) hand.add(this.phones);
        this.phones.visible = true;
        this.phones.scale.setScalar(Math.min(1, hp * 1.5) / Math.max(0.2, hand.getWorldScale(v1).x));
      }
    } else if (this.phones) this.phones.visible = false;
    void X;
  }
}

function makePhones(height: number) {
  const g = new THREE.Group(); g.name = 'club:dj-headphones';
  const s = height / 1.6;
  const mat = new THREE.MeshToonMaterial({ color: 0x151515 }), pink = new THREE.MeshToonMaterial({ color: 0xff3fd2, emissive: 0xff3fd2, emissiveIntensity: 0.6 });
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.055 * s, 0.055 * s, 0.04 * s, 16), mat); cup.rotation.z = Math.PI / 2; cup.position.set(0.02 * s, 0.07 * s, 0);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * s, 0.045 * s, 0.012 * s, 16), pink); pad.rotation.z = Math.PI / 2; pad.position.set(0.045 * s, 0.07 * s, 0);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.09 * s, 0.009 * s, 6, 16, Math.PI), mat); band.position.set(0.0, 0.07 * s, 0); band.rotation.y = Math.PI / 2;
  g.add(cup, pad, band);
  return g;
}

function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}

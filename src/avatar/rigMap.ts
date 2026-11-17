// Runs a 3D auto-rig's retarget map (shared/rigMap.ts, profile.rig.retarget) on the loaded model. The parts the studio's
// normal retarget already drives (VRM-named head / neck / back) are left alone; this layer adds
//   • bones the MAP drives (`by: 'map'`): a share of the head turn (`face`), and/or an idle motion (wings flutter)
//   • a gentle idle sway on top of humanoid-driven bones where the entry asks for it (a lamp's bend chain), stronger when
//     nobody is tracked, so a thing is never a statue
// Every angle is in the MODEL's frame (+Z forward, +Y up, +X its left), the same convention as src/avatar/quadruped.ts.
// Deterministic from the running clock only (no randomness): every page shows the same motion.
// Runs after the humanoid pose and the quadruped layer, before the neck rig and the spring bones.

import * as THREE from 'three';
import type { IdleKind, ModelAxis, RigMapEntry, RigRetargetMap } from '../../shared/rigMap.ts';

const _qa = new THREE.Quaternion(), _pw = new THREE.Quaternion(), _bw = new THREE.Quaternion(), _rr = new THREE.Quaternion();
const _ax = new THREE.Vector3();

interface Live { e: RigMapEntry; bone: THREE.Object3D; rest: THREE.Quaternion; additive: boolean }

export interface RigMapInput {
  resting: boolean;
  /** A face is being tracked (idle motion calms down while someone is driving). */
  tracked: boolean;
  /** Head turn in radians (yaw, pitch, roll), avatar space, mirror applied (TrackingFrame.head). */
  head: readonly [number, number, number];
}

/** Angle (radians) of an idle motion at time t (seconds). Pure; exported for the unit test. */
export function idleAngle(kind: IdleKind, amp: number, hz: number, phase: number, t: number): number {
  const w = Math.PI * 2 * hz * t + phase;
  switch (kind) {
    case 'flap': return amp * (0.65 * Math.sin(w) + 0.35 * Math.sin(w * 2.3 + 0.7));
    case 'sway': return amp * (0.7 * Math.sin(w) + 0.3 * Math.sin(w * 1.71 + 1.3));
    case 'breathe': return amp * 0.5 * (1 + Math.sin(w));
    case 'undulate': return amp * Math.sin(w);
  }
}

export class RigMapLife {
  private live: Live[] = [];
  private t = 0;
  private gain = 1;
  /** Scale of every idle motion (0 = none). */
  idle = 1;

  /** null when the map names no bone this layer would drive. */
  static create(model: THREE.Object3D, map: RigRetargetMap): RigMapLife | null {
    const r = new RigMapLife(model, map);
    return r.live.length ? r : null;
  }

  private constructor(private model: THREE.Object3D, map: RigRetargetMap) {
    const byName = new Map<string, THREE.Object3D>();
    model.traverse((o) => { if ((o as THREE.Bone).isBone && !byName.has(o.name)) byName.set(o.name, o); });
    for (const e of map.entries) {
      const drives = e.by === 'map' && (e.drive === 'face' || !!e.idle);
      const extra = e.by !== 'map' && !!e.idle;     // idle sway added on top of a humanoid / quadruped / spring bone
      if (!drives && !extra) continue;
      const bone = byName.get(e.bone);
      if (bone) this.live.push({ e, bone, rest: bone.quaternion.clone(), additive: extra });
    }
  }

  get count() { return this.live.length; }

  private axis(a: ModelAxis, out: THREE.Vector3) {
    out.set(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
    return out.transformDirection(this.model.matrixWorld).normalize();
  }

  /** Rotate `b` by a world-space rotation, keeping its parent (same maths as QuadrupedLife.rotWorld). */
  private rotWorld(b: THREE.Object3D, rot: THREE.Quaternion) {
    b.parent!.getWorldQuaternion(_pw);
    _bw.copy(_pw).multiply(b.quaternion);
    _rr.copy(rot).multiply(_bw);
    b.quaternion.copy(_pw.invert().multiply(_rr));
  }

  apply(dt: number, o: RigMapInput): void {
    this.t += dt;
    for (const L of this.live) if (!L.additive) L.bone.quaternion.copy(L.rest);
    if (o.resting) return;
    const target = o.tracked ? 0.4 : 1;
    this.gain += (target - this.gain) * (1 - Math.exp(-3 * dt));
    this.model.updateWorldMatrix(true, true);
    const [yaw, pitch, roll] = o.head;
    for (const L of this.live) {
      const { e } = L;
      if (!L.bone.parent) continue;
      if (e.by === 'map' && e.drive === 'face') {
        const k = e.weight ?? 0;
        if (k > 0) {
          const q = new THREE.Quaternion()
            .setFromAxisAngle(this.axis('y', _ax), yaw * k)
            .multiply(new THREE.Quaternion().setFromAxisAngle(this.axis('x', _ax), pitch * k))
            .multiply(new THREE.Quaternion().setFromAxisAngle(this.axis('z', _ax), roll * k));
          this.rotWorld(L.bone, q);
        }
      }
      if (e.idle && this.idle > 0) {
        const ang = idleAngle(e.idle.kind, e.idle.amp, e.idle.hz, e.idle.phase, this.t) * this.idle * this.gain;
        if (ang) this.rotWorld(L.bone, _qa.setFromAxisAngle(this.axis(e.idle.axis, _ax), ang));
      }
      L.bone.updateMatrixWorld(true);
    }
  }
}

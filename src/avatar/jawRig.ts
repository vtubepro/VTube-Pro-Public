// Bone-driven physical mouths: hinged jaws (mouth seams, robot jaws) and hand-puppet mouths (the upper
// head tips back while the jaw drops). The hinge axis is the avatar's left-right axis expressed in each
// bone's own space and the open direction is fixed by the avatar's forward axis (+X hinge, +Z forward:
// a positive turn moves the chin down), so a model only has to name its bones — no axis or sign setup.
import * as THREE from 'three';
import type { JawRig } from '../../shared/types.ts';

const JAW = /^(jaw|jaw_?lower|lower_?jaw|jawbone|mouth_?lower|lower_?mouth|chin)$/i;
const UPPER = /^(upper_?head|head_?upper|upper_?jaw|jaw_?upper|mouth_?upper|upper_?mouth|head_?top|skull_?top)$/i;
/** (tools/lod_glb.ts finds the same bones in a GLB.) */
export { JAW as JAW_BONE_RE, UPPER as UPPER_BONE_RE };

function findBone(root: THREE.Object3D, name: string | undefined, pattern?: RegExp): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (hit || !(o as THREE.Bone).isBone) return;
    if (name && o.name === name) hit = o;
  });
  if (hit || !pattern) return hit;
  root.traverse((o) => { if (!hit && (o as THREE.Bone).isBone && pattern.test(o.name.replace(/[.\s-]/g, '_'))) hit = o; });
  return hit;
}

/** Guess a rig for a model that has jaw bones but no profile entry (uploads: rigged and ready as-is). */
export function detectJawRig(root: THREE.Object3D): JawRig | null {
  const jaw = findBone(root, undefined, JAW);
  if (!jaw) return null;
  const upper = findBone(root, undefined, UPPER);
  return upper
    ? { kind: 'puppet', jawBone: jaw.name, openAngle: 10, upperBone: upper.name, upperAngle: 22, sideAngle: 4 }
    : { kind: 'jaw', jawBone: jaw.name, openAngle: 20, sideAngle: 5 };
}

/** Jaw follow-through (JawRig.bounce): one step of an under-damped spring toward `target` (semi-implicit Euler in ≤ 4 ms
 *  sub-steps). `w` = natural frequency (rad/s), `bounce` 0..1 → damping ratio 1 .. 0.3. Never below closed (0): a jaw that
 *  swung past shut would push the lower lip through the upper one. */
export function jawSpring(s: { x: number; v: number }, target: number, dt: number, w: number, bounce: number) {
  const z = 1 - 0.7 * Math.min(1, Math.max(0, bounce));
  const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * z * w * s.v) * h;
    s.x += s.v * h;
    if (s.x < 0) { s.x = 0; if (s.v < 0) s.v = 0; }
  }
  return s.x;
}

interface Hinge { bone: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3; up: THREE.Vector3 }

export class JawRigDriver {
  private jaw: Hinge | null;
  private upper: Hinge | null;
  private cur = { open: 0, side: 0 };
  private spring = { x: 0, v: 0 };

  constructor(root: THREE.Object3D, anchor: THREE.Object3D, readonly cfg: JawRig) {
    root.updateWorldMatrix(true, true);
    const aq = anchor.getWorldQuaternion(new THREE.Quaternion());
    const hingeW = new THREE.Vector3(1, 0, 0).applyQuaternion(aq);   // avatar left
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(aq);
    const hinge = (b: THREE.Object3D | null): Hinge | null => {
      if (!b) return null;
      const inv = b.getWorldQuaternion(new THREE.Quaternion()).invert();
      return { bone: b, rest: b.quaternion.clone(), axis: hingeW.clone().applyQuaternion(inv).normalize(), up: upW.clone().applyQuaternion(inv).normalize() };
    };
    this.jaw = hinge(findBone(root, cfg.jawBone, JAW));
    this.upper = cfg.kind === 'puppet' ? hinge(findBone(root, cfg.upperBone, UPPER)) : null;
  }

  get ok() { return !!this.jaw || !!this.upper; }

  /** The bones this rig turns (jaw, puppet upper head): what they weigh is part of the face (Avatar detail). */
  get bones(): THREE.Object3D[] { return [this.jaw?.bone, this.upper?.bone].filter((b): b is THREE.Object3D => !!b); }

  /** open 0..1 (fused speech + camera), side -1..1 (jawLeft - jawRight). Call AFTER the humanoid update. */
  update(open: number, side: number, dt: number, mechanical: boolean, presmoothed = false) {
    // flesh/felt: a touch of smoothing; metal: snappier (servo). Speech already shaped + filtered by the
    // viseme rig (presmoothed) gets only a light pass, or every closure lands ~30 ms late.
    const k = 1 - Math.exp(-(presmoothed ? (mechanical ? 110 : 80) : mechanical ? 55 : 35) * dt);
    const bounce = this.cfg.bounce ?? 0;
    const target = THREE.MathUtils.clamp(open, 0, 1.2);
    if (bounce > 0 && target >= this.spring.x - 1e-4) {
      // follow-through on OPENING: an under-damped spring with about the same rise time as the smoothing it replaces
      this.cur.open = jawSpring(this.spring, target, Math.min(dt, 0.1), presmoothed ? (mechanical ? 70 : 48) : mechanical ? 45 : 30, bounce);
    } else if (bounce > 0) {
      // closing stays as crisp as without the bounce (M / B / P must still snap shut)
      this.cur.open += (target - this.cur.open) * k;
      this.spring.x = this.cur.open; this.spring.v = 0;
    } else {
      this.cur.open += (THREE.MathUtils.clamp(open, 0, 1.2) - this.cur.open) * k;
      this.spring.x = this.cur.open; this.spring.v = 0;
    }
    this.cur.side += (THREE.MathUtils.clamp(side, -1, 1) - this.cur.side) * k;
    const d2r = THREE.MathUtils.degToRad;
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    if (this.jaw) {
      const j = this.jaw;
      q.setFromAxisAngle(j.axis, d2r(this.cfg.openAngle) * this.cur.open);
      q2.setFromAxisAngle(j.up, d2r(this.cfg.sideAngle ?? 6) * this.cur.side);
      j.bone.quaternion.copy(j.rest).multiply(q2).multiply(q);
    }
    if (this.upper) {
      const u = this.upper;
      // the upper head tips BACK (chin-down turn reversed); a puppet's head also dips a hair on the attack
      q.setFromAxisAngle(u.axis, -d2r(this.cfg.upperAngle ?? 20) * this.cur.open);
      u.bone.quaternion.copy(u.rest).multiply(q);
    }
  }

  reset() {
    this.spring.x = this.cur.open; this.spring.v = 0;
    for (const h of [this.jaw, this.upper]) if (h) h.bone.quaternion.copy(h.rest);
  }
}

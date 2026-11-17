// Neck rig: variable neck length + calm head motion for long necks (llamas, giraffes, swans…). Settings and the maths
// that is shared with the UI / server live in shared/neck.ts (AvatarProfile.neck).
//
// The retargeter solves the head as an ABSOLUTE orientation (your tracked yaw / pitch / roll) and gives the humanoid
// `neck` bone a fixed 40 % of it. On a human that is invisible; on a 0.5 m neck the 40 % sits at the neck BASE and swings
// the whole neck like a rod, so every nod or turn whips the head through space. This rig runs after the humanoid has
// written its bones (every page: studio, OBS, party views — it only reads the posed bones, so all pages agree) and
//   1. stretches the neck chain (neck → neck_2 … → head rest offsets × length),
//   2. takes the head's absolute rotation, scales its roll (tilt), soft-limits turn / nod (maxTurn) and smooths it,
//   3. counter-rotates the neck base against the body's lean / breathing / bounce by (1 − sway),
//   4. spreads what is left over every joint of the chain (neck, the extra neck bones, head) by neckWeights():
//      top-heavy = the head turns on a still neck, even = a smooth curve. The head always ends at the target.
// Ordinary human avatars with nothing set resolve to "inactive": the rig does nothing and they move exactly as before.

import * as THREE from 'three';
import type { VRMHumanoid } from '@pixiv/three-vrm';
import { neckWeights, resolveNeck, sanitizeNeck, type NeckConfig, type NeckResolved } from '../../shared/neck.ts';

const I = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** Soft limit: linear up to 60 % of `max`, then eases into `max` (never a hard wall). */
function soft(x: number, max: number) {
  const a = Math.abs(x), k = max * 0.6;
  if (a <= k) return x;
  return Math.sign(x) * (k + (max - k) * Math.tanh((a - k) / (max - k)));
}

/** q^t for a unit quaternion (shortest arc), written into `out`. */
function qpow(q: THREE.Quaternion, t: number, out: THREE.Quaternion) {
  return out.copy(I).slerp(q, t);
}

export interface NeckInfo {
  /** Neck joints (the humanoid neck + extra neck bones), not counting the head. */
  joints: number;
  /** Rest length neck base → head as modelled (metres, model scale). */
  restLength: number;
  height: number;
  settings: NeckResolved;
  active: boolean;
}

export class NeckRig {
  /** Neck joints bottom → top: [humanoid neck, neck_2, …]. */
  readonly chain: THREE.Object3D[];
  readonly head: THREE.Object3D;
  /** The neck's parent (upper chest / chest). */
  readonly base: THREE.Object3D;
  private readonly hips: THREE.Object3D | null;
  /** Rest local rotations: chain joints then the head. */
  private readonly restQ: THREE.Quaternion[];
  /** Rest local positions of chain[1..] and the head (the offsets the length multiplier stretches). */
  private readonly restPos: THREE.Vector3[];
  private readonly baseRelHips = new THREE.Quaternion();
  private readonly headRelFrame = new THREE.Quaternion();
  readonly restLength: number;
  readonly height: number;
  private applied = 1;
  private key = '';
  settings!: NeckResolved;
  private explicit = false;
  private smoothA: THREE.Quaternion | null = null;
  /** Debug / A-B testing: false = stock head motion (only the length is applied). */
  motion = true;

  /** Build from a humanoid (needs raw `neck` + `head`); null when the model has no neck bone. Call at rest (load). */
  static create(model: THREE.Object3D, humanoid: VRMHumanoid, frame: THREE.Object3D, cfg: NeckConfig | undefined): NeckRig | null {
    const neck = humanoid.getRawBoneNode('neck'), head = humanoid.getRawBoneNode('head');
    if (!neck || !head || !neck.parent) return null;
    const mids: THREE.Object3D[] = [];
    for (let o = head.parent; o && o !== neck; o = o.parent) mids.unshift(o);
    let o: THREE.Object3D | null = head.parent;
    while (o && o !== neck) o = o.parent;
    if (!o) return null;                                            // head isn't below the neck: odd rig, leave it alone
    return new NeckRig(model, [neck, ...mids], head, humanoid.getRawBoneNode('hips'), frame, cfg);
  }

  private constructor(model: THREE.Object3D, chain: THREE.Object3D[], head: THREE.Object3D, hips: THREE.Object3D | null, private frame: THREE.Object3D, cfg: NeckConfig | undefined) {
    this.chain = chain;
    this.head = head;
    this.base = chain[0].parent!;
    this.hips = hips;
    this.restQ = [...chain, head].map((b) => b.quaternion.clone());
    this.restPos = [...chain.slice(1), head].map((b) => b.position.clone());
    model.updateWorldMatrix(true, true);
    const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
    let L = 0;
    const pts = [...chain, head].map(wp);
    for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]);
    this.restLength = L;
    const box = new THREE.Box3().setFromObject(model);
    this.height = box.isEmpty() ? 1.7 : box.max.y - box.min.y;
    if (hips) this.baseRelHips.copy(hips.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.base.getWorldQuaternion(new THREE.Quaternion())));
    else this.baseRelHips.identity();
    this.headRelFrame.copy(frame.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(head.getWorldQuaternion(new THREE.Quaternion())));
    this.configure(cfg);
    this.setLength(this.settings.length);
  }

  /** Neck joints (not counting the head). */
  get joints() { return this.chain.length; }

  /** Re-resolve the settings when the profile's neck config changed (cheap; called every frame). */
  configure(cfg: NeckConfig | undefined) {
    const clean = sanitizeNeck(cfg);
    const key = clean ? JSON.stringify(clean) : '';
    if (key === this.key && this.settings) return;
    this.key = key;
    this.explicit = !!clean && Object.keys(clean).some((k) => k !== 'length');
    this.settings = resolveNeck(clean, this.restLength, this.height);
  }

  /** Does the motion layer run? Human necks with nothing set: no (stock behaviour, bit for bit). */
  get active() {
    return this.motion && (this.explicit || this.chain.length > 1 || this.settings.longness > 0.02);
  }

  /** Must apply() run this frame? (motion active, or a length to set / undo) */
  get needsStep() { return this.active || this.settings.length !== 1 || this.applied !== 1 || this.chain.length > 1; }

  info(): NeckInfo {
    return { joints: this.chain.length, restLength: this.restLength, height: this.height, settings: this.settings, active: this.active };
  }

  /** Stretch the chain: rest offsets of neck_2 … head × m (the skinned mesh follows). */
  setLength(m: number) {
    if (Math.abs(m - this.applied) < 1e-6) return;
    this.applied = m;
    const bones = [...this.chain.slice(1), this.head];
    bones.forEach((b, i) => b.position.copy(this.restPos[i]).multiplyScalar(m));
  }

  /** Put the extra neck bones back to rest (the humanoid only resets the bones it owns). */
  reset() {
    for (let j = 1; j < this.chain.length; j++) this.chain[j].quaternion.copy(this.restQ[j]);
    this.smoothA = null;
  }

  /**
   * Run after the humanoid has posed the raw bones, before spring bones. `cfg` = the profile's neck config (live edits).
   */
  apply(dt: number, cfg: NeckConfig | undefined, resting = false) {
    this.configure(cfg);
    this.setLength(this.settings.length);
    if (resting || !this.active) { if (this.chain.length > 1) this.reset(); return; }
    const S = this.settings, n = this.chain.length;
    const R = this.restQ;
    // the extra neck bones still hold last frame's pose: measure the head as the humanoid meant it (extras at rest)
    for (let j = 1; j < n; j++) this.chain[j].quaternion.copy(R[j]);
    this.base.updateWorldMatrix(true, false);
    const WP = this.base.getWorldQuaternion(new THREE.Quaternion());
    const WH = WP.clone().multiply(this.chain[0].quaternion);
    for (let j = 1; j < n; j++) WH.multiply(R[j]);
    WH.multiply(this.head.quaternion);

    // ---- absolute head rotation in the avatar's frame: tilt, soft turn limit, smoothing ----
    const F = this.frame.getWorldQuaternion(new THREE.Quaternion());
    const Fi = F.clone().invert();
    const Hrest = F.clone().multiply(this.headRelFrame);
    const A = WH.clone().multiply(Hrest.clone().invert());
    _q.copy(Fi).multiply(A).multiply(F);
    _e.setFromQuaternion(_q, 'YXZ');
    const mt = THREE.MathUtils.degToRad(S.maxTurn);
    _e.set(soft(_e.x, mt * 0.75), soft(_e.y, mt), soft(_e.z * S.tilt, mt * 0.6), 'YXZ');
    const Lq = new THREE.Quaternion().setFromEuler(_e);              // in the avatar's own frame (walks / turns don't lag)
    if (S.smoothing > 0.001) {
      // one-pole low-pass on the rotation: no overshoot, so nothing whips
      const rate = THREE.MathUtils.lerp(40, 3.5, Math.pow(S.smoothing, 0.8));
      if (!this.smoothA || dt <= 0 || dt > 0.5) this.smoothA = Lq.clone();
      else this.smoothA.slerp(Lq, 1 - Math.exp(-rate * dt));
      Lq.copy(this.smoothA);
    } else this.smoothA = null;
    const WHt = F.clone().multiply(Lq).multiply(Fi).multiply(Hrest);

    // ---- neck base: counter-rotate the body's lean / breathing / bounce by (1 - sway) ----
    const B = WP.clone();
    if (this.hips && S.sway < 0.999) {
      const lean = WP.clone().multiply(this.hips.getWorldQuaternion(_q2).multiply(this.baseRelHips).invert());
      if (lean.w < 0) lean.set(-lean.x, -lean.y, -lean.z, -lean.w);
      B.premultiply(qpow(lean.invert(), 1 - S.sway, _q));
    }

    // ---- spread the rest → target rotation over the chain ----
    const Crest = B.clone();
    for (let j = 0; j < n; j++) Crest.multiply(R[j]);
    Crest.multiply(R[n]);
    const D = WHt.clone().multiply(Crest.invert());
    if (D.w < 0) D.set(-D.x, -D.y, -D.z, -D.w);
    const w = neckWeights(n, S.stiffness);
    let c = 0;
    const acc = B.clone();
    const prev = WP.clone();
    const Wj = new THREE.Quaternion();
    for (let j = 0; j < n; j++) {
      c += w[j];
      acc.multiply(R[j]);
      Wj.copy(qpow(D, c, _q)).multiply(acc);
      this.chain[j].quaternion.copy(prev.clone().invert().multiply(Wj));
      prev.copy(Wj);
    }
    acc.multiply(R[n]);
    Wj.copy(D).multiply(acc);                                        // = WHt
    this.head.quaternion.copy(prev.invert().multiply(Wj));
  }
}

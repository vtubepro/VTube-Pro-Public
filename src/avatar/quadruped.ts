// Quadruped body (AvatarProfile.body = 'quadruped'): llamas, giraffes, dogs, horses… standing on four legs.
//
// Face tracking still drives the face, the head and the neck (the humanoid hips → spine → chest → neck… → head chain;
// the retargeter runs in its quadruped mode: no arm / hand / leg retargeting, a gentle chest-only lean, no whole-body
// sliding). The legs are NOT humanoid bones — this layer owns them, on every page (studio, OBS, party views):
//   • planted hooves: after the spine / chest moved, each leg's upper bone is re-aimed so its hoof stays on its rest spot
//   • idle life: a slow weight shift, tail swish (+ the odd flick), ear flicks, an occasional hoof shuffle
//   • gait (0..1, set by the room's walk mover): diagonal-pair walk cycle
// Bones are found by name (build rigs with these names — the llama's build script does):
//   legs  leg_FL_1..n / leg_FR_ / leg_HL_ / leg_HR_   (F = front, H = hind; _1 = top of the leg)
//   tail  tail_1, tail_2 …        ears  ear_L_1 / ear_R_1 (the ear root; spring chains should start one bone lower)
// Missing bones are simply skipped (a quadruped without a tail just doesn't swish).

import * as THREE from 'three';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

interface Leg {
  key: string;
  bones: THREE.Object3D[];
  /** Rest local rotations of the leg bones. */
  rest: THREE.Quaternion[];
  /** Planted hoof point (tip of the last leg bone) in the model's local space, at rest. */
  plant: THREE.Vector3;
  /** Local offset of the tip in the last bone (its child's rest position, or along the bone). */
  tip: THREE.Vector3;
  front: boolean;
  left: boolean;
}

/** Deterministic pseudo-random 0..1 from an integer (so every page shuffles the same way given the same clock). */
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export class QuadrupedLife {
  private legs: Leg[] = [];
  private tail: { b: THREE.Object3D; rest: THREE.Quaternion }[] = [];
  private ears: { b: THREE.Object3D; rest: THREE.Quaternion; left: boolean }[] = [];
  private time = 0;
  /** 0..1 how much the character is walking (scene movers set it every frame). */
  gait = 0;
  private gaitPhase = 0;
  /** Scale of the idle motion (0 = statue). */
  idle = 1;

  constructor(private model: THREE.Object3D, private hips: THREE.Object3D | null = null) {
    model.updateWorldMatrix(true, true);
    const inv = model.matrixWorld.clone().invert();
    const byName = new Map<string, THREE.Object3D>();
    model.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o); });
    for (const key of ['FL', 'FR', 'HL', 'HR']) {
      const bones: THREE.Object3D[] = [];
      for (let i = 1; i < 8; i++) { const b = byName.get(`leg_${key}_${i}`); if (!b) break; bones.push(b); }
      if (!bones.length) continue;
      const last = bones[bones.length - 1];
      const kid = last.children.find((c) => (c as THREE.Bone).isBone);
      const tip = kid ? kid.position.clone() : new THREE.Vector3(0, bones.length > 1 ? bones[bones.length - 1].position.length() * 0.5 : 0.05, 0);
      const plant = last.localToWorld(tip.clone()).applyMatrix4(inv);
      this.legs.push({ key, bones, rest: bones.map((b) => b.quaternion.clone()), plant, tip, front: key[0] === 'F', left: key[1] === 'L' });
    }
    for (let i = 1; i < 6; i++) { const b = byName.get(`tail_${i}`); if (!b) break; this.tail.push({ b, rest: b.quaternion.clone() }); }
    for (const [n, left] of [['ear_L_1', true], ['ear_R_1', false]] as const) { const b = byName.get(n); if (b) this.ears.push({ b, rest: b.quaternion.clone(), left }); }
  }

  get ok() { return this.legs.length > 0; }

  /** Rotate a bone by a WORLD-space rotation (keeps its parent). */
  private rotWorld(b: THREE.Object3D, rot: THREE.Quaternion) {
    const pw = b.parent!.getWorldQuaternion(_q2);
    const bw = pw.clone().multiply(b.quaternion);
    b.quaternion.copy(pw.invert().multiply(rot.clone().multiply(bw)));
    b.updateMatrixWorld(true);
  }

  private axis(v: THREE.Vector3) {
    return v.clone().transformDirection(this.model.matrixWorld).normalize();
  }

  /**
   * Run after the humanoid pose (spine / chest / neck written), BEFORE the neck rig and the spring bones.
   * `lean` = the body lean the tracking wants (already small in quadruped mode).
   */
  apply(dt: number, resting: boolean) {
    this.time += dt;
    const t = this.time;
    for (const L of this.legs) L.bones.forEach((b, i) => b.quaternion.copy(L.rest[i]));
    for (const T of this.tail) T.b.quaternion.copy(T.rest);
    for (const E of this.ears) E.b.quaternion.copy(E.rest);
    if (resting) return;
    this.model.updateWorldMatrix(true, true);
    const side = this.axis(new THREE.Vector3(1, 0, 0)), fwd = this.axis(new THREE.Vector3(0, 0, 1)), up = this.axis(new THREE.Vector3(0, 1, 0));
    const k = this.idle;
    this.gaitPhase += dt * Math.PI * 2 * 1.5 * Math.min(1, this.gait * 3);

    // ---- a slow weight shift from side to side (the legs below re-plant the hooves)
    if (this.hips?.parent) this.rotWorld(this.hips, _q.setFromAxisAngle(fwd, (Math.sin(t * 0.37) * 0.016 + Math.sin(t * 0.13 + 1) * 0.008) * k));

    // ---- legs: planted hooves (+ walk cycle, + an occasional idle shuffle)
    const slot = Math.floor(t / 7);                                   // one shuffle chance per 7 s window
    const shuffleLeg = hash(slot) < 0.55 ? Math.floor(hash(slot + 17) * this.legs.length) : -1;
    const sh = (t - slot * 7) - 2.5;                                  // 0..0.8 s into the window's shuffle
    const lift = shuffleLeg >= 0 && sh > 0 && sh < 0.8 ? Math.sin((sh / 0.8) * Math.PI) * k : 0;
    this.legs.forEach((L, li) => {
      const top = L.bones[0];
      // aim the whole leg at its planted spot (small torso motion must not slide the hooves)
      const head = top.getWorldPosition(_v);
      const tipNow = L.bones[L.bones.length - 1].localToWorld(L.tip.clone());
      const plantW = L.plant.clone().applyMatrix4(this.model.matrixWorld);
      const a = tipNow.sub(head).normalize(), b = plantW.sub(head).normalize();
      if (a.lengthSq() > 0 && b.lengthSq() > 0) this.rotWorld(top, _q.setFromUnitVectors(a, b));
      // walk: diagonal pairs (FL + HR, FR + HL) swing fore / aft; the swinging leg folds its knee
      const g = Math.min(1, this.gait);
      if (g > 0.01) {
        const ph = this.gaitPhase + ((L.front === L.left) ? 0 : Math.PI);
        const swing = Math.sin(ph) * 0.32 * g;
        this.rotWorld(top, _q.setFromAxisAngle(side, -swing));
        if (L.bones[1]) this.rotWorld(L.bones[1], _q.setFromAxisAngle(side, (L.front ? 1 : -1) * Math.max(0, Math.cos(ph)) * 0.55 * g));
      }
      if (li === shuffleLeg && lift > 0 && g < 0.05) {
        this.rotWorld(top, _q.setFromAxisAngle(side, (L.front ? -0.10 : 0.10) * lift));
        if (L.bones[1]) this.rotWorld(L.bones[1], _q.setFromAxisAngle(side, (L.front ? 0.55 : -0.45) * lift));
      }
    });

    // ---- tail: slow swish + an occasional quick flick
    if (this.tail.length) {
      const flickSlot = Math.floor(t / 5);
      const fs = t - flickSlot * 5 - 1.2;
      const flick = hash(flickSlot + 101) < 0.5 && fs > 0 && fs < 0.5 ? Math.sin((fs / 0.5) * Math.PI * 2) * 0.45 : 0;
      const swish = (Math.sin(t * 1.25) * 0.16 + Math.sin(t * 0.47) * 0.08 + flick) * k + Math.sin(this.gaitPhase) * 0.2 * this.gait;
      this.tail.forEach((T, i) => { this.rotWorld(T.b, _q.setFromAxisAngle(up, swish * (i === 0 ? 1 : 0.6))); });
    }

    // ---- ears: each ear flicks back now and then (the ear springs overshoot it)
    for (const E of this.ears) {
      const es = Math.floor(t / 3.3 + (E.left ? 0 : 0.5));
      const ph = t / 3.3 + (E.left ? 0 : 0.5) - es - 0.3;
      const f = hash(es * 7 + (E.left ? 3 : 5)) < 0.45 && ph > 0 && ph < 0.12 ? Math.sin((ph / 0.12) * Math.PI) : 0;
      const idleTwitch = Math.sin(t * 0.9 + (E.left ? 0 : 2)) * 0.05;
      if (f > 0 || idleTwitch) this.rotWorld(E.b, _q.setFromAxisAngle(side, (-0.45 * f + idleTwitch) * k));
    }
    void _v2;
  }
}

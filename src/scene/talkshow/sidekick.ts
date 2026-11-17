// The interview's sidekick / bandleader: Sprocket (or the avatar the host picked) at the side of the set behind a
// little band stand, following the conversation with his eyes and head, nodding along — and laughing / clapping on
// the director's reaction cues (punchlines). Loaded from this page's OWN library (never over the party link), no
// costume, never a party member. While the interview mode is on the chat buddy steps out (stage mode chat: 'docked'),
// so there is only ever one Sprocket on the set.
import * as THREE from 'three';
import { normalizeProfile } from '../../../shared/defaults.ts';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { api } from '../../api.ts';
import { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import { emptyFrame } from '../../tracking/faceSolver.ts';
import { SceneActor, measureRest } from '../actor.ts';

const DEFAULT_MODEL = 'robot';

export class Sidekick {
  readonly actor = new SceneActor('@sidekick', 'Sidekick');
  private anchor = new THREE.Group();
  private rt: AvatarRuntime | null = null;
  private loading: Promise<void> | null = null;
  private frame: TrackingFrame = emptyFrame();
  private laughT = 99;
  private nodT = 99;
  private look = new THREE.Vector3();
  private t = 0;
  disposed = false;
  modelId: string;
  failed = false;

  constructor(readonly parent: THREE.Object3D, readonly place: { position: THREE.Vector3; yaw: number }, readonly height: number, modelId: string) {
    this.modelId = modelId || DEFAULT_MODEL;
    parent.add(this.actor.mount);
    this.actor.mount.position.copy(place.position);
    this.actor.mount.rotation.set(0, place.yaw, 0);
  }

  get ready() { return !!this.rt; }

  load(): Promise<void> {
    this.loading ??= (async () => {
      let id = this.modelId, raw: AvatarProfile | null = null;
      try { raw = await api.avatar(id) as AvatarProfile; } catch { raw = null; }
      if (!raw && id !== DEFAULT_MODEL) { id = DEFAULT_MODEL; raw = await api.avatar(id) as AvatarProfile; }
      if (!raw) throw new Error('no sidekick avatar');
      const p = normalizeProfile(raw) as AvatarProfile;
      const clean: AvatarProfile = { ...p, costume: null, accessories: [] };
      const rt = await AvatarRuntime.load(clean, api.modelUrl(clean), this.anchor);
      if (this.disposed) { rt.dispose(); return; }
      measureRest(rt);
      this.rt = rt;
      this.actor.attach(this.anchor, rt);
      this.actor.setHeight(this.height);
      this.actor.shown = true;
      this.actor.sync();
    })().catch((e) => { console.warn('interview sidekick: load failed', e); this.failed = true; });
    return this.loading;
  }

  /** World face centre + size (for the sidekick cutaway). */
  head(): { face: THREE.Vector3; size: number; forward: THREE.Vector3; top: number } {
    const r = this.actor.rest;
    const fwd = new THREE.Vector3(Math.sin(this.place.yaw), 0, Math.cos(this.place.yaw));
    if (!r) return { face: this.place.position.clone().add(new THREE.Vector3(0, this.height * 0.78, 0)), size: this.height * 0.2, forward: fwd, top: this.height * 0.18 };
    const k = this.actor.scale;
    const local = r.face.center.clone().multiplyScalar(k).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.place.yaw);
    return { face: this.place.position.clone().add(local), size: r.face.size * k, forward: fwd, top: Math.max(0.05, (r.floorY + r.height - r.face.center.y) * k) };
  }

  laugh() { this.laughT = 0; }
  nod() { this.nodT = 0; }

  /** `lookAt` = the speaker's face (or null = the audience). */
  update(dt: number, lookAt: THREE.Vector3 | null, aspect: number, visible: boolean) {
    const rt = this.rt;
    this.actor.shown = visible && !!rt;
    this.actor.sync();
    if (!rt || !visible) return;
    this.t += dt; this.laughT += dt; this.nodT += dt;
    const head = this.head();
    const want = lookAt ?? head.face.clone().add(head.forward.clone().multiplyScalar(3));
    if (this.look.lengthSq() === 0) this.look.copy(want);
    this.look.lerp(want, 1 - Math.exp(-4 * dt));
    // head yaw / pitch towards the look point, in the sidekick's own frame
    const d = this.look.clone().sub(head.face).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.place.yaw);
    const yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -0.9, 0.9), pitch = THREE.MathUtils.clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.35, 0.35);
    const L = this.laughT < 2.2 ? Math.sin(Math.min(1, this.laughT / 0.2) * Math.PI / 2) * (this.laughT > 1.6 ? 1 - (this.laughT - 1.6) / 0.6 : 1) : 0;
    const N = this.nodT < 1.2 ? Math.sin((this.nodT / 1.2) * Math.PI) : 0;
    const bob = L * 0.12 * Math.sin(this.t * 17) + N * 0.12 * Math.sin(this.nodT * 9) + 0.03 * Math.sin(this.t * 1.7);
    const f = this.frame;
    f.tracked = true; f.t = Date.now() / 1000;
    const bph = (this.t % 3.9) / 3.9, blink = L > 0.2 ? 0.7 * L : bph > 0.955 ? Math.sin(((bph - 0.955) / 0.045) * Math.PI) : 0;
    const jaw = L * (0.35 + 0.3 * Math.abs(Math.sin(this.t * 14)));
    f.face = { eyeBlinkLeft: blink, eyeBlinkRight: blink, mouthSmileLeft: 0.35 + 0.6 * L, mouthSmileRight: 0.35 + 0.6 * L, eyeSquintLeft: 0.5 * L, eyeSquintRight: 0.5 * L, jawOpen: jaw, cheekSquintLeft: 0.4 * L, cheekSquintRight: 0.4 * L };
    f.mouth = { open: jaw, wide: 0.3 * L, smile: 0.4 + 0.55 * L, frown: 0, pucker: 0, funnel: 0, tongue: 0 };
    f.head = [yaw, pitch + bob - L * 0.15, 0.06 * L * Math.sin(this.t * 7)];
    f.headPos = [0, 0, 0];
    f.gaze = [0, 0];
    rt.update(f, null, rt.profile.tracking, dt, aspect);
  }

  dispose() {
    this.disposed = true;
    const an = this.actor.detach();
    this.actor.mount.removeFromParent();
    this.rt?.dispose();
    void an;
  }
}

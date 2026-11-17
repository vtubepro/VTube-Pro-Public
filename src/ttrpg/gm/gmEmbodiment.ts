// The GM at the head of the table: a built-in talking object (figures.ts), the room's own themed figure / prop
// (scene.json ttrpg.gmStyles: a GLB in the room folder with GM_JAW / mouth morphs / EMIT_gm glow, or a character
// model), or any avatar from THIS PC's library (loaded like the chat buddy: no costume, never saved; a page that
// doesn't have that avatar — a guest's OBS — falls back to the room default). The speech sample drives the mouth.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { SceneRuntime } from '../../scene/SceneRuntime.ts';
import { sceneFileUrl } from '../../scene/SceneRuntime.ts';
import { SceneActor, measureRest } from '../../scene/actor.ts';
import type { SpotInfo } from '../../scene/contract.ts';
import { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import { emptyFrame } from '../../tracking/faceSolver.ts';
import { api } from '../../api.ts';
import { normalizeProfile } from '../../../shared/defaults.ts';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { GM_BUILTINS, roomGmStyles, type GmBuiltin, type RoomGmStyle, type RoomTtrpgConfig } from '../../../shared/ttrpg/state.ts';
import { buildFigure, type GmFigure } from './figures.ts';
import type { MouthSample } from './speech.ts';
import type { TtrpgAnchors } from '../scene/anchors.ts';

export interface GmDrive { dt: number; t: number; mouth: MouthSample; level: number; excite: number; color: THREE.Color; camera: THREE.Camera; aspect: number }

export class GmEmbodiment {
  readonly group = new THREE.Group();
  style = '';
  /** What is actually shown (after fallbacks) and why. */
  shownAs = '';
  note = '';
  private fig: GmFigure | null = null;
  private figScale = 1;
  private glb: { root: THREE.Object3D; jaw: THREE.Object3D | null; jawRest: THREE.Quaternion; open: number; morphs: { mesh: THREE.Mesh; i: number }[]; glow: THREE.MeshStandardMaterial[]; bob: boolean } | null = null;
  private av: { actor: SceneActor; rt: AvatarRuntime; frame: TrackingFrame; tune: AvatarProfile['tracking'] } | null = null;
  private seq = 0;
  private faceLocal = new THREE.Vector3(0, 0.5, 0);
  hidden = false;
  /** A library avatar plays the GM (never hidden by the table shots' clear view: see scene/clearShot.ts). */
  get isAvatar() { return !!this.av; }

  constructor(private rt: SceneRuntime, private anchors: TtrpgAnchors, private cfg: RoomTtrpgConfig | undefined) {
    this.group.name = 'ttrpg:gm';
    rt.root.add(this.group);
  }

  /** The room default style id: the first of scene.json ttrpg.gmStyles, else the d20. */
  roomDefault(): string {
    const list = roomGmStyles(this.cfg);
    const d = this.cfg?.defaultGm ? list.find((g) => g.id === this.cfg!.defaultGm) : list[0];
    return d ? (d.builtin ? d.builtin : `room:${d.id}`) : 'd20';
  }

  /** World point of the GM's face (cameras + eyelines). */
  facePoint(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.av) { const f = this.av.actor.spot ? this.av.actor.faceAt(this.av.actor.spot) : null; if (f) return out.copy(f.center); }
    return this.group.localToWorld(out.copy(this.faceLocal));
  }
  get faceSize(): number { return this.av ? (this.av.actor.rest?.face.size ?? 0.2) * this.av.actor.scale : 0.35 * this.figScale; }
  /** How much height a close-up of the GM should show (m): the whole talking object, or a bust of a character. */
  get shotHeight(): number { return this.av ? 1.1 * (this.av.actor.height / 1.5) : this.figSize * 2.1; }
  /** Measured size (m) of the talking object: its bigger of height / 0.7 × width. */
  private figSize = 0.36;

  async setStyle(style: string, color: string) {
    const key = `${style}|${color}`;
    if (key === this.style) return;
    this.style = key;
    const seq = ++this.seq;
    this.clear();
    const s = style.startsWith('room:') || style.startsWith('avatar:') || (GM_BUILTINS as readonly string[]).includes(style) ? style : this.roomDefault();
    try {
      if (s.startsWith('avatar:')) await this.loadAvatar(s.slice(7), seq);
      else if (s.startsWith('room:')) {
        const g = roomGmStyles(this.cfg).find((x) => x.id === s.slice(5));
        if (!g) throw new Error(`room GM style ${s} not in scene.json`);
        if (g.builtin) this.useFigure(g.builtin, g.color ?? color, g.height);
        else if (g.avatar) await this.loadAvatar(g.avatar, seq);
        else if (g.model) await this.loadRoomModel(g, seq);
        else this.useFigure('d20', color);
      } else this.useFigure(s as GmBuiltin, color);
      this.shownAs = s;
    } catch (e) {
      if (seq !== this.seq) return;
      console.warn('[ttrpg] GM style failed, using the room default', e);
      this.note = `“${s}” unavailable here (${(e as Error).message}); showing the room default`;
      this.clear();
      const d = this.roomDefault();
      if (d.startsWith('room:') && d !== s) { this.style = ''; await this.setStyle(d, color); }
      else this.useFigure((GM_BUILTINS as readonly string[]).includes(d) ? d as GmBuiltin : 'd20', color);
    }
  }

  private objectSpot(height?: number): { pos: THREE.Vector3; q: THREE.Quaternion; h: number } {
    const a = this.anchors;
    if (a.gmProp.node) return { pos: a.gmProp.position.clone(), q: a.gmProp.quaternion.clone(), h: height ?? 0.36 };
    const seat = a.gmSeat;
    if (seat) {
      // float at seated head height over the GM's chair, facing the table
      const y = seat.position.y + (seat.extras.pose === 'stand' ? 1.25 : 0.95) * ((this.rt.info.avatarHeight ?? 1.5) / 1.5);
      return { pos: seat.position.clone().setY(y), q: seat.quaternion.clone(), h: height ?? 0.55 };
    }
    return { pos: a.gmProp.position.clone(), q: a.gmProp.quaternion.clone(), h: height ?? 0.36 };
  }

  private useFigure(kind: GmBuiltin, color: string, height?: number) {
    const f = buildFigure(kind, color);
    const sp = this.objectSpot(height);
    if (!height && kind === 'radio') sp.h *= 1.35;          // a boxy radio reads small at the default size
    this.figScale = sp.h;
    f.root.scale.setScalar(sp.h);
    this.group.position.copy(sp.pos);
    this.group.quaternion.copy(sp.q);
    this.group.add(f.root);
    this.fig = f;
    this.faceLocal.set(0, f.face * sp.h, 0);
    f.root.updateWorldMatrix(true, true);
    const bb = new THREE.Box3().setFromObject(f.root), sz = bb.getSize(new THREE.Vector3());
    this.figSize = Math.max(0.12, sz.y, Math.max(sz.x, sz.z) * 0.7);
  }

  private async loadRoomModel(g: RoomGmStyle, seq: number) {
    const gltf = await new GLTFLoader().loadAsync(sceneFileUrl(this.rt.info.id, g.model!));
    if (seq !== this.seq) return;
    const root = gltf.scene;
    let skinned = false;
    root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
    if (g.kind === 'character' && skinned) {
      // a rigged character: through the avatar runtime (visemes, blinks) with a stand-in profile
      await this.loadAvatarProfile(normalizeProfile({ id: `gm-${g.id}`, name: g.name, modelFile: g.model } as never) as AvatarProfile, sceneFileUrl(this.rt.info.id, g.model!), seq);
      return;
    }
    const box = new THREE.Box3().setFromObject(root);
    const h = Math.max(0.01, box.max.y - box.min.y);
    const sp = this.objectSpot(g.height);
    const k = g.height ? g.height / h : sp.h / h;
    root.scale.setScalar(k);
    root.position.y = -box.min.y * k;
    this.group.position.copy(sp.pos);
    this.group.quaternion.copy(sp.q);
    this.group.add(root);
    const jaw = root.getObjectByName(g.mouth?.node ?? 'GM_JAW') ?? null;
    const morphs: { mesh: THREE.Mesh; i: number }[] = [];
    const glow: THREE.MeshStandardMaterial[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary) for (const n of [g.mouth?.morph, 'mouthOpen', 'aa', 'jawOpen', 'MouthOpen'].filter(Boolean) as string[]) { const i = m.morphTargetDictionary[n]; if (i !== undefined) { morphs.push({ mesh: m, i }); break; } }
      if (m.isMesh) for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (/^EMIT_gm|GM_EYES/i.test(mt.name) || (g.mouth?.glow && mt.name === g.mouth.glow)) glow.push(mt as THREE.MeshStandardMaterial);
    });
    this.glb = { root, jaw, jawRest: jaw ? jaw.quaternion.clone() : new THREE.Quaternion(), open: THREE.MathUtils.degToRad(g.mouth?.open ?? 22), morphs, glow, bob: !(root.userData?.grounded === true) };
    this.faceLocal.set(0, (box.max.y - box.min.y) * k * 0.7, 0);
    this.figSize = Math.max(0.12, (box.max.y - box.min.y) * k);
    this.figScale = sp.h;
  }

  private async loadAvatar(id: string, seq: number) {
    const raw = await api.avatar(id);        // model custody: this PC's own library only
    const p = normalizeProfile(raw) as AvatarProfile;
    const clean: AvatarProfile = { ...p, costume: null, accessories: [] };
    await this.loadAvatarProfile(clean, api.modelUrl(clean), seq);
  }

  private async loadAvatarProfile(p: AvatarProfile, url: string, seq: number) {
    const anchor = new THREE.Group();
    const rt = await AvatarRuntime.load(p, url, anchor);
    if (seq !== this.seq) { rt.dispose(); return; }
    measureRest(rt);
    const actor = new SceneActor('npc:gm', p.name || 'GM');
    actor.attach(anchor, rt);
    actor.setHeight((this.rt.info.avatarHeight ?? 1.5) * (this.rt.state.avatarScale || 1));
    const spot = this.gmSpot();
    actor.spot = spot;
    actor.updateSeat(spot);
    actor.place(actor.placementAt(spot));
    actor.shown = true;
    this.group.position.set(0, 0, 0); this.group.quaternion.identity();
    this.group.add(actor.mount);
    this.av = { actor, rt, frame: emptyFrame(), tune: rt.profile.tracking };
  }

  /** The GM chair as a spot (spot 12 in the room engine, else built from GM_SEAT). */
  private gmSpot(): SpotInfo {
    const s = this.rt.room.spots[11];
    if (s) return s;
    const seat = this.anchors.gmSeat ?? { position: this.anchors.gmProp.position.clone().setY(0), forward: this.anchors.gmProp.forward.clone(), extras: {} as Record<string, unknown>, node: null };
    const pose = seat.extras.pose === 'stand' ? 'stand' : 'sit';
    return { index: 11, name: 'GM_SEAT', node: seat.node ?? new THREE.Object3D(), pose, seatHeight: typeof seat.extras.seatHeight === 'number' ? seat.extras.seatHeight : 0.45, seatDepth: 0.5, label: 'GM',
      position: seat.position.clone(), forward: seat.forward.clone(), yaw: Math.atan2(seat.forward.x, seat.forward.z), cam: null, leavePathAt: null, approach: [], extras: seat.extras };
  }

  update(d: GmDrive) {
    this.group.visible = !this.hidden;
    if (this.hidden) return;
    const open = Math.min(1, d.mouth.open * (0.55 + 0.45 * (d.level > 0 ? d.level * 1.4 : 1)));
    if (this.fig || this.glb) {
      // talking objects turn towards the lens (a talking head), at most 75° off the table
      const cam = this.group.worldToLocal(d.camera.getWorldPosition(new THREE.Vector3()));
      const want = THREE.MathUtils.clamp(Math.atan2(cam.x, cam.z), -1.3, 1.3);
      const node = this.fig?.root ?? this.glb!.root;
      node.rotation.y += (want - node.rotation.y) * Math.min(1, d.dt * 3);
    }
    if (this.fig) {
      const look = new THREE.Vector3().copy(d.camera.position);
      this.fig.root.worldToLocal(look);
      look.sub(new THREE.Vector3(0, this.fig.face, 0)).normalize();
      this.fig.update(d.dt, { open, speaking: d.mouth.speaking, t: d.t, excite: d.excite, look, color: d.color });
    }
    if (this.glb) {
      const g = this.glb;
      if (g.jaw) g.jaw.quaternion.copy(g.jawRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -open * g.open));
      for (const m of g.morphs) if (m.mesh.morphTargetInfluences) m.mesh.morphTargetInfluences[m.i] = open;
      for (const mt of g.glow) { mt.emissive?.copy(d.color); mt.emissiveIntensity = 0.4 + open * 2 + d.excite * 3; }
      if (g.bob) g.root.position.y = Math.abs(g.root.position.y) * 0 + Math.sin(d.t * 1.3) * 0.015 * this.figScale;
    }
    if (this.av) {
      const f = this.av.frame;
      const b = (d.t % 3.7) < 0.13 ? 1 : 0;
      f.t = d.t;
      f.face = { jawOpen: open * 0.75, eyeBlinkLeft: b, eyeBlinkRight: b, mouthSmileLeft: 0.25 + d.excite * 0.5, mouthSmileRight: 0.25 + d.excite * 0.5 };
      f.mouth = { open: open * 0.8, wide: d.mouth.vis === 'E' || d.mouth.vis === 'I' ? 0.4 : 0.1, smile: 0.25 + d.excite * 0.4, frown: 0, pucker: d.mouth.vis === 'U' || d.mouth.vis === 'W' ? 0.5 : 0, funnel: d.mouth.vis === 'O' ? 0.5 : 0, tongue: 0, speak: d.mouth.speaking ? 1 : 0 };
      f.visemes = { [d.mouth.vis]: 1 - d.mouth.mix, [d.mouth.next]: d.mouth.mix } as Record<string, number>;
      f.head = [Math.sin(d.t * 0.6) * 0.08, (d.mouth.speaking ? Math.sin(d.t * 2.1) * 0.05 : 0) + 0.04, Math.sin(d.t * 0.45) * 0.03];
      f.tracked = true;
      this.av.rt.update(f, null, this.av.tune!, d.dt, d.aspect);
      this.av.actor.sync();
    }
  }

  private clear() {
    this.fig?.dispose(); this.fig = null;
    if (this.glb) { this.glb.root.removeFromParent(); this.glb = null; }
    if (this.av) { this.av.actor.detach(); this.av.actor.mount.removeFromParent(); this.av.rt.dispose(); this.av = null; }
    this.group.clear();
    this.note = '';
  }

  dispose() { this.clear(); this.group.removeFromParent(); this.seq++; }
}

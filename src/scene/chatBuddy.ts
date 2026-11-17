// The chat buddy — a CHAT DISPLAY first, a gag second. Any avatar in the host's library (SceneState.chat.buddyModel:
// the builtins Sprocket — the default, shared/chat.ts DEFAULT_BUDDY — Mirelle, Kairo, or their own imports; NO
// costume / accessories), loaded from THIS page's own library (a page that doesn't have it falls back to the default
// buddy), as an NPC: not a party member, never in SceneState.spots, never on a SPOT_*, holding a big tablet with the
// live chat UP towards the camera.
//
// Where he stands comes from chatBuddyPlace.ts (per shot, tablet-first, always in the shot while he is on): a floor
// point / furniture top in the room ('world'), else the foreground peek ('fore': right in front of the lens in a
// bottom corner, glued to the camera), else — last resort — the tablet held into the frame from a bottom corner by his
// arm ('overlay', drawn on top). Moving: a short walk (WalkMover + locomotion, shared door) when it's close, on the
// same floor and the same size, else a quick "poof" (puff of smoke, shrink out, pop in at the new place).
// Holding: one hand at his side (classic tablet), both hands in front (big tablets), or — a model without usable arms
// — the tablet stands on a pole next to him. Any humanoid rig (buddyRig.ts: missing hand bones, mirrored left/right
// mapping, stubby arms, chunky bodies): the hands reach for the tablet's grips (arm IK on the normalized humanoid),
// held clear of the measured chest. He always turns to face the lens; the tablet faces it exactly.
// Idle: peeks at the camera over the tablet, glances down at it; a silent mouth flap on new messages; a hop + big
// smile on support events. Deterministic look / blink schedule (wall clock) so every page shows the same thing.
// ROAM mode (the default, chatBuddyRoam.ts): he walks around the room on a timeline every page shares, carries the
// tablet at his side and raises it (at a spot where it is readable) when chat arrives; the tablet plans above are then
// only used when no spot of the shot shows him at all (and for "Stay put").
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarProfile, TrackingFrame } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { api } from '../api.ts';
import { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import { emptyFrame } from '../tracking/faceSolver.ts';
import { ChatCanvas } from '../chat/chatCanvas.ts';
import type { ChatFeed } from '../chat/feed.ts';
import { chatVisible, type SceneChatState } from '../../shared/chat.ts';
import { SceneActor, measureRest } from './actor.ts';
import type { RoomInfo, SpotInfo } from './contract.ts';
import { WalkMover } from './walkMover.ts';
import { buddyGeoFor, forePose, CHEER_HOP, CHEER_LIFT, CLASSIC_BODY, portraitGeo, tunedBuddy, type BuddyBody, type TunedBuddy, type BuddyGeo, type TabletPlan } from './chatBuddyPlace.ts';
import { buddyArms, buddyHead, chestBand, measureBuddyBody, torsoFront, type BuddyArm } from './buddyRig.ts';
import { DEFAULT_BUDDY } from '../../shared/chat.ts';
import { BIT_DUR, edgeEntry, lineSeg, localRoute, REACT, sampleRoam, settleOf, simulate, type RoamSet, type RSample, type RSeg } from './chatBuddyRoam.ts';
import { Locomotion } from './locomotion.ts';

/** The fallback buddy when the picked avatar isn't on this page (Sprocket, a builtin every install has). */
export const BUDDY_AVATAR = DEFAULT_BUDDY;
const I = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const hash = (n: number) => { let x = Math.floor(n) * 374761393; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const easeOutBack = (k: number) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Readable chat on the tablet: text line ≥ this many px on a 1080p frame. */
const READ_PX = 14;

/** Tablet + raised-hold geometry for the classic tablet on the classic body (kept for callers of the old API). */
export function buddyGeo(height: number): BuddyGeo { return buddyGeoFor(height, CLASSIC_BODY, 1); }

/** Tablet canvas size for a tablet size multiplier: more pixels for a bigger tablet (same text size on it). */
export function tabletCanvasSize(size: number): [number, number] {
  const W = Math.round(THREE.MathUtils.clamp(640 * size, 512, 1600));
  return [W, Math.round(W * 0.75)];
}

export class ChatBuddy {
  readonly actor = new SceneActor('npc:buddy', 'Chat buddy');
  rt: AvatarRuntime | null = null;
  private anchor = new THREE.Group();
  private loading: Promise<void> | null = null;
  private mover: WalkMover | null = null;
  private door = { main: 0, buddy: 0 };
  private origDoor: ((t: number) => void) | null = null;
  target: SpotInfo | null = null;
  /** The newest plan (where he is going). */
  plan: TabletPlan | null = null;
  /** The plan he is embodying right now (switches when a poof swaps him over / a walk starts). */
  active: TabletPlan | null = null;
  /** Poof teleport in progress: out (shrink + puff) → move → in (pop). */
  private poof: { phase: 'out' | 'in'; t: number; plan: TabletPlan | null; hideAfter: boolean } | null = null;
  private tablet = new THREE.Group();
  /** No usable arms: the tablet stands on a pole next to him. */
  private stand = new THREE.Group();
  private owned: (THREE.Material | THREE.BufferGeometry)[] = [];
  readonly canvas = new ChatCanvas('tablet', 640, 480);
  /** Held-into-frame fallback (camera-relative, drawn on top). */
  readonly overlay = new THREE.Group();
  private overlayK = 0;
  private overlayWant = false;
  corner: -1 | 1 = 1;
  private frame: TrackingFrame = emptyFrame();
  private tune = normalizeProfile({ id: '_', modelFile: '' }).tracking;
  private base: ((rt: AvatarRuntime, dt: number) => void) | null = null;
  private wrapper = (rt: AvatarRuntime, dt: number) => { if (!this.base) { this.actor.offset.set(0, 0, 0); this.actor.tilt.identity(); } this.base?.(rt, dt); this.pose(rt, dt); };
  private restH = 1.6;
  private talkT = 99; private cheerT = 99; private lastTalk = 0;
  private look = new THREE.Vector3();
  cam = new THREE.Vector3();
  camera: THREE.PerspectiveCamera | null = null;
  hostHead: THREE.Vector3 | null = null;
  /** His normal world height (m): the room's avatar height × heightK (set by the chat scene). */
  baseHeight = 1.08;
  /** World height (m) he is normalised to right now (the active plan's: smaller in tight spots / the foreground). */
  height = 1.08;
  onPoof: ((at: THREE.Vector3) => void) | null = null;
  private side: 1 | -1 = 1;
  private rig: { toNorm: THREE.Quaternion; fromNorm: THREE.Quaternion; arms: (BuddyArm & { restU: THREE.Vector3; restL: THREE.Vector3 })[]; head: THREE.Vector3 } | null = null;
  /** How this model holds the tablet (proportions of his height). */
  body: BuddyBody = CLASSIC_BODY;
  /** Buddy height as a fraction of the room's avatar height (mascots / chibis smaller than human-proportioned models). */
  heightK = 0.72;
  /** The avatar actually shown + whether the wanted one was missing on this page (→ the default buddy). */
  loadedId = '';
  fallback = false;
  /** Tablet size / text size (SceneChatState.tablet / tabletText) and the tablet height (fraction of the frame) the
   *  chat needs to be readable at that size. */
  tabletSize = 1;
  hfMin = 0.125;
  private tabKey = '';
  private shadows = true;

  constructor(readonly room: RoomInfo, readonly parent: THREE.Object3D, readonly modelId = BUDDY_AVATAR) {
    parent.add(this.actor.mount);
    const bez = this.own(new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5, metalness: 0.5 }));
    const scr = this.own(new THREE.MeshBasicMaterial({ map: this.canvas.texture, toneMapped: false }));
    const body = new THREE.Mesh(this.own(new THREE.BoxGeometry(1.06, 0.81, 0.045)), bez);
    body.position.z = -0.024;
    const screen = new THREE.Mesh(this.own(new THREE.PlaneGeometry(1, 0.75)), scr);
    screen.name = 'vtp:chat:tabletScreen';
    screen.position.z = 0.001;
    this.tablet.add(body, screen);
    this.tablet.name = 'vtp:chat:tablet';
    // the stand (only for models without usable arms): a pole + foot, sized every frame
    const metal = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.35, metalness: 0.8 }));
    const pole = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.5, 0.5, 1, 10)), metal);
    pole.name = 'vtp:chat:standPole';
    const foot = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.5, 0.56, 1, 18)), metal);
    foot.name = 'vtp:chat:standFoot';
    this.stand.add(pole, foot);
    this.stand.name = 'vtp:chat:stand';
    this.stand.visible = false;
    parent.add(this.stand);
    this.buildOverlay(scr.map!);
    parent.add(this.overlay);
    const d = room.door;
    if (d) {
      this.origDoor = d.setOpen;
      d.setOpen = (t: number) => { this.door.main = t; this.origDoor!(Math.max(this.door.main, this.door.buddy)); };
    }
  }
  private own<T extends THREE.Material | THREE.BufferGeometry>(x: T): T { this.owned.push(x); return x; }

  /** Camera-relative fallback: a tablet (+ a tuned buddy's cartoon arm and 3-finger hand), drawn over everything. */
  private overlaySkin: THREE.MeshBasicMaterial | null = null;
  private overlayDark: THREE.MeshBasicMaterial | null = null;
  private buildOverlay(map: THREE.Texture) {
    const top = <M extends THREE.Material>(m: M) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };
    const green = this.overlaySkin = this.own(top(new THREE.MeshBasicMaterial({ color: 0x86c04a, toneMapped: false })));
    const dark = this.overlayDark = this.own(top(new THREE.MeshBasicMaterial({ color: 0x5f9a33, toneMapped: false })));
    const bez = this.own(top(new THREE.MeshBasicMaterial({ color: 0x14161b, toneMapped: false })));
    const scr = this.own(top(new THREE.MeshBasicMaterial({ map, toneMapped: false })));
    const tab = new THREE.Group();
    tab.name = 'vtp:chat:tabletOverlay';
    const body = new THREE.Mesh(this.own(new THREE.PlaneGeometry(1.07, 0.82)), bez);
    const screen = new THREE.Mesh(this.own(new THREE.PlaneGeometry(1, 0.75)), scr);
    screen.name = 'vtp:chat:tabletScreen';
    screen.position.z = 0.002;
    tab.add(body, screen);
    const arm = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.07, 0.085, 1, 12)), green);
    arm.name = 'vtp:chat:overlayArm';
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.1, 14, 10)), green);
    hand.add(palm);
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.045, 10, 8)), dark);
      f.position.set(-0.09 + i * 0.09, 0.1, 0.03);
      hand.add(f);
    }
    this.overlay.add(arm, tab, hand);
    this.overlay.userData = { tab, arm, hand };
    this.overlay.renderOrder = 1000;
    this.overlay.traverse((o) => { o.renderOrder = 1000; o.frustumCulled = false; });
    this.overlay.visible = false;
  }

  load(): Promise<void> {
    this.loading ??= (async () => {
      let id = this.modelId || BUDDY_AVATAR, raw: AvatarProfile | null = null;
      try { raw = await api.avatar(id); } catch { raw = null; }
      if (!raw && id !== BUDDY_AVATAR) { this.fallback = true; id = BUDDY_AVATAR; raw = await api.avatar(id); }
      if (!raw) throw new Error('no buddy avatar');
      const p = normalizeProfile(raw) as AvatarProfile;
      const clean: AvatarProfile = { ...p, costume: null, accessories: [] };
      let rt: AvatarRuntime;
      try { rt = await AvatarRuntime.load(clean, api.modelUrl(clean), this.anchor); }
      catch (e) {
        if (id === BUDDY_AVATAR) throw e;
        // the chosen model doesn't load on this page: the default buddy instead
        console.warn('chat buddy: model failed, using the default buddy', e);
        this.fallback = true; id = BUDDY_AVATAR;
        const f = normalizeProfile(await api.avatar(id)) as AvatarProfile;
        const fc: AvatarProfile = { ...f, costume: null, accessories: [] };
        rt = await AvatarRuntime.load(fc, api.modelUrl(fc), this.anchor);
      }
      this.loadedId = id;
      this.tuned = tunedBuddy(id, rt.profile.buddy);
      const rest = measureRest(rt);
      this.restH = rest.height;
      this.rt = rt;
      this.tune = rt.profile.tracking ?? this.tune;
      this.actor.attach(this.anchor, rt);
      this.anchor.add(this.tablet);
      this.buildRig();
      this.measureBody();
    })().catch((e) => { console.warn('chat buddy: load failed', e); this.loading = null; });
    return this.loading;
  }

  private buildRig() {
    const rt = this.rt!, rest = this.actor.rest!;
    const h = rt.humanoid;
    if (!h || !rest.toNorm) { this.rig = null; return; }
    const toNorm = rest.toNorm.clone(), fromNorm = toNorm.clone().invert();
    // any humanoid rig (buddyRig.ts): estimated hands, geometric sides, stubs dropped
    const arms = buddyArms(rest.joints, rest.height).map((a) => ({ ...a, restU: a.dirU.clone().applyQuaternion(toNorm), restL: a.dirL.clone().applyQuaternion(toNorm) }));
    this.rig = { toNorm, fromNorm, arms, head: buddyHead(rest.joints, rest.height, rest.face) };
  }

  /** The loaded model's hand tuning (chatBuddyPlace.ts tunedBuddy: the app preset, else the profile's own), or null. */
  private tuned: TunedBuddy | null = null;

  /** Hold proportions: a hand-tuned preset (TUNED_BUDDIES / the profile's buddy block), else measured from the rig + the mesh's chest. */
  private measureBody() {
    const rest = this.actor.rest!;
    const tuned = this.tuned;
    if (tuned) {
      this.body = tuned.body; this.heightK = tuned.heightK;
      if (tuned.arm) { this.overlaySkin?.color.setHex(tuned.arm.skin); this.overlayDark?.color.setHex(tuned.arm.dark); }
      return;
    }
    const J = rest.joints, H = rest.height;
    const sh = J.leftUpperArm && J.rightUpperArm ? Math.abs(J.leftUpperArm.x - J.rightUpperArm.x) / 2 : H * 0.12;
    const [lo, hi] = chestBand(J, rest.floorY, H);
    const front = this.sampleFront(lo, hi, sh * 0.85);
    const m = measureBuddyBody({ height: H, floorY: rest.floorY, joints: J, face: rest.face, front: front ?? undefined, headHalf: rest.head?.half, headTop: rest.head?.top }, this.rig?.arms ?? []);
    this.body = m.body; this.heightK = m.heightK;
  }

  /** The chest's front (anchor z) from sampled mesh vertices in the chest band (<= ~16k vertices, once per load). */
  private sampleFront(lo: number, hi: number, halfW: number): number | null {
    const rt = this.rt!;
    this.anchor.updateWorldMatrix(true, true);
    const toAnchor = this.anchor.matrixWorld.clone().invert();
    const meshes: THREE.Mesh[] = [];
    rt.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && m.geometry?.attributes?.position) meshes.push(m); });
    const total = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
    if (!total) return null;
    const step = Math.max(1, Math.ceil(total / 16000));
    const pts: number[] = [];
    const v = new THREE.Vector3();
    for (const m of meshes) {
      const pos = m.geometry.attributes.position as THREE.BufferAttribute;
      const sk = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh) : null;
      for (let i = 0; i < pos.count; i += step) {
        if (sk) sk.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
        v.applyMatrix4(m.matrixWorld).applyMatrix4(toAnchor);
        pts.push(v.x, v.y, v.z);
      }
    }
    return torsoFront(pts, lo, hi, halfW);
  }

  get ready() { return !!this.rt; }
  /** Walking or poofing (the planner waits). */
  get busy() { return !!this.poof || !!this.mover?.busy(this.actor); }
  get shown() { return this.actor.shown; }
  get overlayOn() { return this.overlayWant; }
  /** Geometry at a given height (the planner tries smaller sizes) for the current tablet size / body. */
  geoAt = (height: number): BuddyGeo => buddyGeoFor(height, this.body, this.tabletSize, this.hfMin);
  get geo() { const g = this.geoAt(this.height); return this.active?.portrait && this.active.mode !== 'overlay' ? portraitGeo(g) : g; }

  /** Tablet size + text size (SceneChatState): the canvas grows with the tablet, the text keeps its size on it. */
  setTablet(size: number, text: number, font: number) {
    const pl = this.overlayWant ? this.plan : this.active;
    const portrait = !!pl?.portrait;
    const key = `${size}|${text}|${font}|${portrait}`;
    if (key === this.tabKey) return;
    this.tabKey = key;
    this.tabletSize = size;
    const [W, H] = tabletCanvasSize(size);
    this.canvas.textScale = text / size;
    this.canvas.headScale = THREE.MathUtils.clamp(1 / size, 0.4, 1.2);
    // upright: the same text size (measured on the landscape width), a taller + narrower column
    this.canvas.textRefW = W;
    if (portrait) this.canvas.resize(H, W); else this.canvas.resize(W, H);
    this.hfMin = THREE.MathUtils.clamp((READ_PX * H) / (1080 * Math.max(1, this.canvas.textPx(font))), 0.1, 0.42);
  }

  // ---------------------------------------------------------------- moving
  private spotAt(pos: THREE.Vector3, yaw: number): SpotInfo {
    return {
      index: 90, name: 'CHAT_BUDDY', node: this.actor.mount, pose: 'stand', seatHeight: 0, seatDepth: 0, label: 'Chat buddy',
      position: pos.clone().setY(0), forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), yaw, cam: null, leavePathAt: null, approach: [], extras: {},
    };
  }
  private moverFor(spot: SpotInfo): WalkMover {
    const d = this.room.door;
    const door = d && this.origDoor ? { ...d, setOpen: (t: number) => { this.door.buddy = t; this.origDoor!(Math.max(this.door.main, this.door.buddy)); } } : null;
    const room: RoomInfo = { ...this.room, door, spots: [...this.room.spots, spot] };
    const m = new WalkMover(room);
    this.dropMover();
    this.mover = m;
    return m;
  }
  private dropMover() {
    if (!this.mover) return;
    this.mover.dispose();
    this.mover = null;
    this.base = null;
    this.actor.extraPose = this.wrapper;
  }

  /** Go where the plan says (walk if it's a short hop on the floor at the same size, else poof). `walkInAt`: fresh
   *  toggle → through the door. */
  apply(plan: TabletPlan, walkInAt = 0) {
    if (!this.rt) return;
    this.plan = plan;
    if (plan.mode === 'overlay') {
      this.overlayWant = true;
      this.corner = plan.corner;
      if (this.actor.shown && !(this.poof?.hideAfter)) this.poofTo(null, true);
      return;
    }
    this.overlayWant = false;
    if (plan.mode === 'world') {
      const spot = this.spotAt(plan.pos, plan.yaw);
      this.target = spot;
      this.actor.spot = spot;
    } else this.target = null;
    const here = this.actor.mount.position;
    const cur = this.active;
    const sameSize = !!cur && Math.abs(cur.height - plan.height) < 0.01;
    const walkable = plan.mode === 'world' && !plan.perch && sameSize && cur?.mode === 'world' && !cur.perch && Math.abs(here.y) < 0.05;
    if (!this.actor.shown || this.poof?.hideAfter) {
      if (walkInAt && Date.now() - walkInAt < 20000 && plan.mode === 'world' && !plan.perch && this.room.doorOutside && !this.poof) {
        this.setActive(plan);
        this.moverFor(this.target!).enter(this.actor, this.target!, { at: walkInAt, from: -1 });
        return;
      }
      if (!this.poof) { this.poofTo(plan, false); return; }
      this.retarget(plan);
      return;
    }
    if (plan.mode === 'world' && cur?.mode === 'world' && here.distanceTo(plan.pos) < 0.05 && sameSize) { this.setActive(plan); return; }
    if (walkable && here.distanceTo(plan.pos) < 2.2 && !this.poof) {
      this.setActive(plan);
      this.moverFor(this.target!).move(this.actor, this.target!, { at: Date.now() + 100 });
      return;
    }
    if (this.poof) { this.retarget(plan); return; }
    this.poofTo(plan, false);
  }
  /** A new plan while a poof runs: still shrinking → pop in there instead; already popping in → go next. */
  private pending: TabletPlan | null = null;
  private retarget(plan: TabletPlan) {
    if (this.poof?.phase === 'out') this.poof = { ...this.poof, plan, hideAfter: false };
    else this.pending = plan;
  }

  private setActive(plan: TabletPlan) {
    this.active = plan;
    this.side = plan.side;
    this.height = plan.height;
    this.actor.setHeight(this.height);
  }

  /** Poof: shrink out with a puff, then pop in embodying `plan` (null = stay gone). */
  private poofTo(plan: TabletPlan | null, hideAfter: boolean) {
    this.dropMover();
    if (!this.actor.shown) {
      if (hideAfter || !plan) return;
      this.setActive(plan);
      this.placeAt(plan);
      this.poof = { phase: 'in', t: 0, plan, hideAfter: false };
      this.actor.appear = 0.001;
      this.actor.shown = true;
      this.onPoof?.(this.centre());
      return;
    }
    this.poof = { phase: 'out', t: 0, plan, hideAfter };
    this.onPoof?.(this.centre());
  }
  private centre() { return this.actor.mount.position.clone().setY(this.actor.mount.position.y + this.height * 0.5); }

  /** Put him where a plan says (fore: from the live camera). */
  private placeAt(plan: TabletPlan) {
    if (plan.mode === 'fore') { this.glueFore(plan); return; }
    this.actor.place({ position: plan.pos.clone(), yaw: plan.yaw, sit: 0 });
  }

  /** Foreground peek: re-anchored to the live camera every frame (the frame corner stays put while it moves). */
  private glueFore(plan: TabletPlan) {
    const cam = this.camera;
    if (!cam || !plan.fore) { this.actor.place({ position: plan.pos.clone(), yaw: plan.yaw, sit: 0 }); return; }
    cam.updateMatrixWorld();
    const f = forePose(cam, plan.fore, plan.hf, this.baseHeight, (h) => ({ ...(plan.portrait ? portraitGeo(this.geoAt(h)) : this.geoAt(h)), tabUp: plan.lift * (h / Math.max(1e-4, plan.height)) }), plan.side);
    this.height = f.h;
    this.actor.setHeight(f.h);
    this.actor.mount.position.copy(f.pos);
    this.actor.mount.rotation.set(0, f.yaw, 0);
    // roam: he walked up to the lens — the peek rises from below the frame edge (and sinks back when done)
    const L = this.lens;
    if (L && L.phase !== 'show') {
      const k = L.phase === 'up' ? 1 - easeOutBack(clamp01(L.t / 0.45)) : Math.pow(clamp01(L.t / 0.35), 2);
      const frameH = 2 * plan.fore.d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / Math.max(1e-3, cam.zoom);
      this.actor.mount.position.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())), -Math.max(-0.1, k) * frameH * 0.8);
    }
  }

  leave(at = Date.now()) {
    if (!this.rt) return;
    if (this.roam) this.stopRoam();
    this.target = null;
    this.plan = null;
    this.overlayWant = false;
    this.pending = null;
    if (this.mover && this.actor.shown && this.active?.mode === 'world' && Math.abs(this.actor.mount.position.y) < 0.05 && this.room.doorOutside) { this.mover.exit(this.actor, { at }); return; }
    if (this.actor.shown) this.poofTo(null, true);
  }

  // ---------------------------------------------------------------- reactions
  talk(now: number) { if (now - this.lastTalk > 1400) { this.lastTalk = now; this.talkT = 0; } }
  cheer() { this.cheerT = 0; }

  // ---------------------------------------------------------------- per frame
  update(dt: number, aspect: number, feed: ChatFeed, st: SceneChatState) {
    const rt = this.rt;
    if (!rt) return;
    this.clockS = this.manualClock ? this.clockS + dt : Date.now() / 1000;
    this.setTablet(st.tablet ?? 1, st.tabletText ?? 1, st.font);
    this.mover?.update(dt);
    if (this.actor.extraPose !== this.wrapper) { this.base = this.actor.extraPose; this.actor.extraPose = this.wrapper; }
    this.stepPoof(dt);
    this.talkT += dt; this.cheerT += dt;
    if (this.roam) this.stepRoam(dt, feed, st);
    const roam = this.roaming && !!this.rs && !this.poof && this.actor.shown;
    const act = this.active;
    const fore = act?.mode === 'fore' && this.actor.shown;
    if (fore) this.glueFore(act!);
    else if (!roam && !this.mover?.busy(this.actor) && this.actor.shown && !this.poof) {
      // always face the lens when he isn't walking (the tablet then faces it too)
      const to = this.cam.clone().sub(this.actor.mount.position).setY(0);
      if (to.lengthSq() > 1e-4) {
        const want = Math.atan2(to.x, to.z), cur = this.actor.mount.rotation.y;
        const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
        this.actor.mount.rotation.y = cur + d * (1 - Math.exp(-8 * dt));
      }
    }
    // right in front of the lens: no shadow thrown on the room below him
    const shadows = !fore;
    if (shadows !== this.shadows) { this.shadows = shadows; this.anchor.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = shadows; }); }
    const now = Date.now() / 1000;
    // look: mostly peeking at the camera over the tablet, now and then down at it / at the host
    const r = hash(Math.floor(now / 2.4));
    const mode = this.cheerT < 1.8 ? 'cam' : this.talkT < 0.9 ? 'tablet' : r < 0.62 ? 'cam' : r < 0.9 ? 'tablet' : 'host';
    const tabW = this.tablet.getWorldPosition(new THREE.Vector3());
    const want = roam ? this.roamLook(now, tabW) : mode === 'cam' ? this.cam : mode === 'host' && this.hostHead && !fore ? this.hostHead : tabW;
    if (this.look.lengthSq() === 0) this.look.copy(want);
    this.look.lerp(want, 1 - Math.exp(-5 * dt));
    const f = this.frame;
    f.tracked = true;
    f.t = now;
    const bph = (now % 3.7) / 3.7, blink = bph > 0.955 ? Math.sin(((bph - 0.955) / 0.045) * Math.PI) : 0;
    const flap = this.talkT < 0.75 ? 0.22 * Math.abs(Math.sin(this.talkT * 15)) * (1 - this.talkT / 0.75) : 0;
    const cheer = this.cheerT < 2.2 ? Math.sin(Math.min(1, this.cheerT / 0.25) * Math.PI / 2) * (this.cheerT > 1.7 ? 1 - (this.cheerT - 1.7) / 0.5 : 1) : 0;
    const bx = this.bitFace();
    const bl = Math.max(blink, bx.blink);
    f.face = { eyeBlinkLeft: bl, eyeBlinkRight: bl, mouthSmileLeft: 0.3 + 0.6 * cheer + bx.smile, mouthSmileRight: 0.3 + 0.6 * cheer + bx.smile, eyeSquintLeft: 0.3 * cheer + bx.squint, eyeSquintRight: 0.3 * cheer + bx.squint, jawOpen: flap + 0.35 * cheer + bx.jaw };
    f.mouth = { open: flap + 0.3 * cheer + bx.jaw, wide: 0.2 * cheer, smile: 0.35 + 0.6 * cheer + bx.smile, frown: 0, pucker: 0, funnel: 0, tongue: 0 };
    f.gaze = [0, mode === 'tablet' ? 0.25 : 0];
    f.head = [0, 0, 0]; f.headPos = [0, 0, 0];
    this.actor.sync();
    if (roam) this.placeTabletRoam(); else this.placeTablet();
    if (this.actor.mount.visible || this.poof) rt.update(f, null, this.tune, dt, aspect);
    this.actor.sync();
    if (roam) this.placeTabletRoam(); else this.placeTablet();
    this.placeStand();
    this.updateOverlay(dt);
    if (this.actor.mount.visible || this.overlay.visible) this.canvas.update(feed, st);
  }

  private stepPoof(dt: number) {
    const p = this.poof;
    if (!p) return;
    p.t += dt;
    if (p.phase === 'out') {
      this.actor.appear = Math.max(0.001, 1 - p.t / 0.22);
      if (p.t >= 0.22) {
        if (p.hideAfter || !p.plan) { this.actor.shown = false; this.actor.appear = 1; this.poof = null; return; }
        this.setActive(p.plan);
        this.placeAt(p.plan);
        this.poof = { ...p, phase: 'in', t: 0 };
        this.onPoof?.(this.centre());
      }
    } else {
      this.actor.shown = true;
      this.actor.appear = Math.max(0.001, easeOutBack(clamp01(p.t / 0.32)));
      if (p.t >= 0.32) {
        this.actor.appear = 1; this.poof = null;
        const next = this.pending;
        this.pending = null;
        if (next && next === this.plan && next !== this.active) this.apply(next);
      }
    }
  }

  private cheerLift() { return this.cheerT < 1.8 ? Math.sin(Math.min(1, this.cheerT / 0.3) * Math.PI / 2) * (this.cheerT > 1.4 ? 1 - (this.cheerT - 1.4) / 0.4 : 1) : 0; }
  /** How much of the cheer bounce (tablet lift + hop) the current plan allows — the planner shrinks / drops it where
   *  the top of the bounce would put the tablet over a face (TabletPlan.cheer). The free arms still wave. */
  private cheerOf(k: 'cheer' | 'hop') {
    const p = this.roaming ? this.rs?.seg?.tab ?? null : this.active;
    if (!p) return this.roaming ? 0 : 1;
    return p.mode === 'overlay' ? 1 : THREE.MathUtils.clamp(p[k] ?? 1, 0, 1);
  }
  private get cheerK() { return this.cheerOf('cheer'); }
  private get hopK() { return this.cheerOf('hop'); }

  /** The raised tablet (same geometry as the planner's): in front of him / at his side / on its stand, facing the lens. */
  private placeTablet() {
    const g = this.geo, m = this.actor.mount;
    const yaw = m.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const act = this.active;
    const up0 = act && act.mode !== 'overlay' ? act.lift * (this.height / Math.max(1e-4, act.height)) : g.tabUp;
    const lift = g.hold === 'stand' ? 0 : this.cheerLift() * this.cheerK * this.height * CHEER_LIFT + this.actor.offset.y;
    const c = m.position.clone().addScaledVector(UP, up0 + lift).addScaledVector(fwd, g.tabFwd).addScaledVector(left, this.side * g.tabSide);
    this.anchor.updateWorldMatrix(true, false);
    const s = this.anchor.getWorldScale(new THREE.Vector3()).x || 1;
    this.tablet.position.copy(this.anchor.worldToLocal(c.clone()));
    this.tablet.scale.set(g.tabW / s, g.tabH / 0.75 / s, g.tabW / s);
    // parallel to the image plane (square on screen, no keystone at the frame edges); no camera yet: face the lens
    if (this.camera) {
      const pq = this.tablet.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.tablet.quaternion.copy(pq.multiply(this.camera.getWorldQuaternion(new THREE.Quaternion())));
    } else this.tablet.lookAt(this.cam);
  }

  /** The pole under a stand-held tablet (models without usable arms). */
  private placeStand() {
    const on = this.geo.hold === 'stand' && this.actor.mount.visible && (!this.roaming || (this.rs?.raise ?? 0) > 0.5);
    this.stand.visible = on;
    if (!on) return;
    const g = this.geo;
    const k = this.actor.appear;
    this.tablet.updateWorldMatrix(true, false);
    const c = this.tablet.getWorldPosition(new THREE.Vector3());
    const floor = this.actor.mount.position.y;
    const top = c.y - g.tabH * 0.45 * k;
    const r = Math.max(0.015, g.height * 0.028) * k;
    const [pole, foot] = this.stand.children as THREE.Mesh[];
    const inv = this.parent.matrixWorld.clone().invert();
    const toLocal = (p: THREE.Vector3) => p.clone().applyMatrix4(inv);
    const mid = toLocal(new THREE.Vector3(c.x, (floor + top) / 2, c.z));
    pole.position.copy(mid); pole.scale.set(r * 2, Math.max(0.01, top - floor), r * 2);
    const fr = g.tabW * 0.28 * k;
    foot.position.copy(toLocal(new THREE.Vector3(c.x, floor + 0.012 * k, c.z))); foot.scale.set(fr * 2, 0.024 * k + 1e-4, fr * 2);
  }

  /** His face box's world corners (the planner's box, chatBuddyPlace.bodyRects, where he is right now — hop included)
   *  for the live face check; null = not shown / overlay. */
  facePoints(cam: THREE.Camera): THREE.Vector3[] | null {
    if (!this.actor.mount.visible || !this.actor.shown || this.overlayWant) return null;
    const g = this.geo, m = this.actor.mount.position;
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).setY(0);
    if (r.lengthSq() < 1e-8) return null;
    r.normalize();
    const c = m.clone().setY(m.y + this.actor.offset.y + this.actor.perch + g.headUp);
    return [c.clone().addScaledVector(r, -g.faceHW).setY(c.y - g.faceDn), c.clone().addScaledVector(r, g.faceHW).setY(c.y + g.faceUpX)];
  }

  /** The world tablet's screen: corners + edge points + centre (the live visibility check). */
  tabletPoints(): THREE.Vector3[] | null {
    const scr = this.tablet.children[1] as THREE.Mesh | undefined;
    if (!scr) return null;
    scr.updateWorldMatrix(true, false);
    return [[0, 0], [-0.45, -0.34], [0.45, -0.34], [-0.45, 0.34], [0.45, 0.34]].map(([x, y]) => new THREE.Vector3(x, y, 0.01).applyMatrix4(scr.matrixWorld));
  }

  /** Held into the frame from the bottom corner: the arm slides up from below the edge. */
  private updateOverlay(dt: number) {
    // (hf 0 = the planner found no clear corner either: nothing drawn — never over the react screen / a face)
    const op = this.overlayWant ? this.plan : null;
    const want = this.overlayWant && !!this.camera && (op?.hf ?? 0.2) > 0;
    this.overlayK = want ? Math.min(1, this.overlayK + dt / 0.4) : Math.max(0, this.overlayK - dt / 0.25);
    this.overlay.visible = this.overlayK > 0.001;
    if (!this.overlay.visible || !this.camera) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    // frame size at the overlay's depth from the real projection (zoom / view offset / any fov)
    const dist = 0.5;
    const ndc = (x: number, y: number) => { const v = new THREE.Vector3(x, y, 0.5).applyMatrix4(cam.projectionMatrixInverse); return v.multiplyScalar(-dist / v.z); };
    const c0 = ndc(0, 0), fh = ndc(0, 1).y - ndc(0, -1).y, fw = ndc(1, 0).x - ndc(-1, 0).x;
    const ox = c0.x, oy = c0.y;
    const port = !!op?.portrait;
    const th = fh * (op?.fore ? op.hf : THREE.MathUtils.clamp(Math.max(0.22, this.hfMin * 1.1), 0.22, 0.4)), tw = port ? th * 0.75 : th / 0.75;
    const k = 1 - Math.pow(1 - this.overlayK, 3);
    const sx = this.corner;
    const wob = Math.sin(Date.now() / 700) * 0.004 + (this.cheerT < 1 ? Math.abs(Math.sin(this.cheerT * 9)) * fh * 0.03 : 0);
    // where the planner found a clear corner (frame fractions), else the classic bottom corner
    const cx = op?.fore ? ox + (op.fore.u - 0.5) * fw : ox + sx * (fw / 2 - tw / 2 - fw * 0.075);
    const cy = (op?.fore ? oy + (0.5 - op.fore.v) * fh : oy - fh / 2 + th / 2 + fh * 0.1) - (1 - k) * (th + fh * 0.12) + wob;
    const { tab, arm, hand } = this.overlay.userData as { tab: THREE.Object3D; arm: THREE.Mesh; hand: THREE.Object3D };
    // the cartoon arm belongs to a tuned buddy (its tuning's arm); any other model just slides the tablet in
    arm.visible = hand.visible = !!this.tuned?.arm;
    const local = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorld);
    const parentInv = this.overlay.parent ? this.overlay.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
    const place = (o: THREE.Object3D, p: THREE.Vector3, q: THREE.Quaternion, sc: number, sy = sc) => {
      const mw = new THREE.Matrix4().compose(p, q, new THREE.Vector3(sc, sy, sc));
      o.matrixAutoUpdate = false;
      o.matrix.multiplyMatrices(parentInv, mw);
      o.matrixWorldNeedsUpdate = true;
    };
    const camQ = cam.getWorldQuaternion(new THREE.Quaternion());
    // face the lens exactly (camera-space normal = back towards the eye), a small playful roll
    const nrm = new THREE.Vector3(-cx, -cy, dist).normalize();
    const face = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sx * 0.03));
    place(tab, local(cx, cy, -dist), camQ.clone().multiply(face), tw, th / 0.75);
    // hand at the tablet's lower outer corner, arm from below the frame edge to it
    const hp = new THREE.Vector3(cx + sx * tw * 0.42, cy - th * 0.45, -dist + 0.01);
    const ap = new THREE.Vector3(ox + sx * (fw / 2 + fw * 0.02), oy - fh / 2 - fh * 0.12, -dist + 0.03);
    place(hand, local(hp.x, hp.y, hp.z), camQ, fh * 0.35);
    const mid = hp.clone().add(ap).multiplyScalar(0.5), len = hp.distanceTo(ap);
    const dirL = hp.clone().sub(ap).normalize();
    const armQ = camQ.clone().multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirL));
    const mw = new THREE.Matrix4().compose(local(mid.x, mid.y, mid.z), armQ, new THREE.Vector3(fh * 0.35, len, fh * 0.35));
    arm.matrixAutoUpdate = false; arm.matrix.multiplyMatrices(parentInv, mw); arm.matrixWorldNeedsUpdate = true;
    this.overlay.updateMatrixWorld(true);
  }

  /** Pose layer: the hands reach for the tablet's grips (one at his side, both for a big tablet in front; none on a
   *  stand) — the free arm hangs, both go up on cheers; the head peeks at the lens / the tablet / the host. */
  private pose(rt: AvatarRuntime, _dt: number) {
    const R = this.rig, h = rt.humanoid;
    if (!R || !h) return;
    if (this.roaming && this.rs && !this.poof) { this.poseRoam(rt); return; }
    const H = this.restH;
    const lift = this.cheerLift();
    if (this.cheerT < 0.9) this.actor.offset.y += Math.abs(Math.sin((this.cheerT / 0.45) * Math.PI)) * H * CHEER_HOP * this.actor.scale * this.hopK;
    const g = this.geo;
    const holders = g.hold === 'two' ? R.arms : g.hold === 'one' ? (R.arms.filter((a) => a.side === this.side).length ? R.arms.filter((a) => a.side === this.side) : R.arms.slice(0, 1)) : [];
    this.tablet.updateWorldMatrix(true, false);
    for (const arm of R.arms) {
      const L = (arm.a + arm.b) * 0.97;
      const pole = new THREE.Vector3(arm.side * 0.8, -0.6, -0.1).normalize();
      if (holders.includes(arm)) {
        // grip: the tablet's near edge (one hand) or its lower corner on this arm's side (two hands)
        const gx = g.hold === 'two' ? arm.side * 0.44 : -this.side * 0.4, gy = g.hold === 'two' ? -0.28 : -0.12;
        const w = new THREE.Vector3(gx, gy, this.gripZ(arm)).applyMatrix4(this.tablet.matrixWorld);
        const T = this.anchor.worldToLocal(w);
        const D = T.clone().sub(arm.S);
        if (D.length() > L) T.copy(arm.S).addScaledVector(D.normalize(), L);            // out of reach: the arm points at it
        this.ik(h, arm, T, pole);
        continue;
      }
      // the free arm: a tuned mascot's bind pose already hangs it; any other rig (T- / A-pose bind) lets it hang
      // relaxed at its side instead of sticking straight out
      const tuned = !!this.tuned;
      if (lift < 0.02 && tuned) continue;
      const rest = tuned ? new THREE.Vector3(arm.side * 0.5, -0.8, 0.3) : new THREE.Vector3(arm.side * 0.18, -0.95, 0.12);
      const up = new THREE.Vector3(arm.side * 0.3, 0.85, 0.45);
      const dir = rest.normalize().lerp(up.normalize(), lift).normalize();
      this.ik(h, arm, arm.S.clone().addScaledVector(dir, L), pole);
    }
    // head + neck towards the look target, leaning a touch to the free side to peek over / past the tablet
    const loc = this.anchor.worldToLocal(this.look.clone());
    const dir = loc.sub(R.head);
    const yaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-dir.y, Math.hypot(dir.x, dir.z)), -0.5, 0.65);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, g.hold === 'one' ? -this.side * 0.12 : 0, 'YXZ'));
    const qn = R.toNorm.clone().multiply(q).multiply(R.fromNorm);
    const neck = h.getNormalizedBoneNode('neck'), head = h.getNormalizedBoneNode('head');
    if (neck && head) { neck.quaternion.premultiply(I.clone().slerp(qn, 0.4)); head.quaternion.premultiply(I.clone().slerp(qn, 0.6)); }
    else (head ?? neck)?.quaternion.premultiply(qn);
  }

  /** Grip depth behind the screen (tablet-local z, in tablet widths): a big hand (a robot's claw, a mascot's mitt)
   *  holds it from behind instead of covering the chat — about a third of the forearm, never less than before. */
  private gripZ(arm: { b: number }): number {
    const tw = this.geo.tabW;
    if (tw <= 1e-4) return -0.02;
    return -THREE.MathUtils.clamp((arm.b * 0.3 * this.actor.scale) / tw, 0.02, 0.2);
  }

  private ik(h: NonNullable<AvatarRuntime['humanoid']>, arm: NonNullable<ChatBuddy['rig']>['arms'][number], T: THREE.Vector3, pole: THREE.Vector3) {
    const R = this.rig!;
    const s = arm.bone;
    const ua = h.getNormalizedBoneNode(`${s}UpperArm` as VRMHumanBoneName), la = h.getNormalizedBoneNode(`${s}LowerArm` as VRMHumanBoneName);
    if (!ua || !la) return;
    const D = T.clone().sub(arm.S);
    let d = D.length();
    if (d < 1e-5) return;
    D.multiplyScalar(1 / d);
    d = THREE.MathUtils.clamp(d, Math.abs(arm.a - arm.b) + 1e-4, (arm.a + arm.b) * 0.999);
    const perp = pole.clone().addScaledVector(D, -pole.dot(D));
    if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0); else perp.normalize();
    const cosA = THREE.MathUtils.clamp((arm.a * arm.a + d * d - arm.b * arm.b) / (2 * arm.a * d), -1, 1);
    const up = D.clone().multiplyScalar(cosA).addScaledVector(perp, Math.sqrt(1 - cosA * cosA));
    const elbow = arm.S.clone().addScaledVector(up, arm.a);
    const lo = arm.S.clone().addScaledVector(D, d).sub(elbow).normalize();
    up.applyQuaternion(R.toNorm); lo.applyQuaternion(R.toNorm);
    const parentW = worldQ(ua.parent, h.normalizedHumanBonesRoot.parent, new THREE.Quaternion());
    const upW = new THREE.Quaternion().setFromUnitVectors(arm.restU.clone().applyQuaternion(parentW), up).multiply(parentW);
    ua.quaternion.copy(parentW.clone().invert().multiply(upW));
    const loW = new THREE.Quaternion().setFromUnitVectors(arm.restL.clone().applyQuaternion(upW), lo).multiply(upW);
    la.quaternion.copy(upW.clone().invert().multiply(loW));
    h.getNormalizedBoneNode(`${s}Hand` as VRMHumanBoneName)?.quaternion.copy(I);
  }

  // ---------------------------------------------------------------- roam mode (chatBuddyRoam.ts)
  /** The roam set of the current shot (null = stay mode, or no spot in view: the tablet plans above take over). */
  roam: RoamSet | null = null;
  /** The shared timeline (every page the same) and a local walk (catch-up / walk-in from the frame edge) that brings
   *  him onto it after a shot change. */
  private segs: RSeg[] = [];
  private local: RSeg[] | null = null;
  private simKey = '';
  private simTo = 0;
  private loco: Locomotion | null = null;
  /** Timeline seed + epoch (s) (SceneState.chat.buddyAt + the room) and the chat events' reaction times. */
  seed = 1;
  epoch = 0;
  private msgs: number[] = [];
  private msgKey = '';
  /** The timeline sampled this frame. */
  rs: RSample | null = null;
  /** Spot he stands on (−1 = walking / between spots). */
  atPt = -1;
  /** Showing chat through the fallback plan (no readable roam spot in this shot) until `fallEnd`. */
  private fallOn = false;
  private fallEnd = 0;
  /** Hidden at a camera cut: walk in again once the new shot's set is known (not before this time). */
  private entryAt = 0;
  private joinT = -9;
  /** A roam set is being computed (ChatScene): walk-ins wait for it. */
  planning = false;
  /** Performers' heads (he looks at them). */
  heads: THREE.Vector3[] = [];
  /** World grips for the holding hands this frame (carry ↔ raised blend). */
  private grips = new Map<number, THREE.Vector3>();
  private clockS = Date.now() / 1000;
  manualClock = false;
  private now() { return this.clockS; }

  /** Roaming right now (the timeline drives him). */
  get roaming() { return !!this.roam && !this.fallOn; }
  /** The tablet is up (a message is shown) — the live check / harness. */
  get roamShowing() { return this.roaming && !this.local && this.rs?.seg?.k === 'show' && this.rs.raise > 0.99; }

  /** New roam set for this shot (null = leave roam mode: the tablet plans take over). */
  setRoam(set: RoamSet | null) {
    if (!this.rt) return;
    const was = this.roam;
    this.roam = set;
    if (!set) { if (was) this.stopRoam(); return; }
    this.plan = null; this.target = null; this.pending = null;
    this.overlayWant = false;
    const inFall = this.fallOn;
    this.fallOn = false; this.lens = null; this.lensAfter = null; this.lensBack = null;
    this.simKey = '';
    this.local = null;
    if (inFall && this.actor.shown) { this.poofTo(null, true); this.entryAt = 0; return; }
    // coming from the foreground peek / a stay spot of another size / mid-poof: out first, then in from the edge
    const shownFore = this.actor.shown && !was && (this.active?.mode !== 'world' || this.actor.mount.position.y > 0.15);
    if (this.poof) { this.poof = { ...this.poof, plan: null, hideAfter: true }; this.entryAt = 0; return; }
    if (shownFore || (this.actor.shown && Math.abs(this.height - set.height) > 0.01 && !set.offscreen(this.actor.mount.position))) {
      this.poofTo(null, true); this.entryAt = 0; return;
    }
    this.entryAt = 0;
    this.join();
  }

  private stopRoam() {
    this.roam = null; this.local = null; this.segs = []; this.rs = null; this.fallOn = false; this.grips.clear();
    if (this.loco) { this.loco.gait = 0; this.loco.idle = 0; this.loco.armW = 0; this.loco.headW = 0; }
    this.base = null;
    this.actor.offset.set(0, 0, 0); this.actor.tilt.identity();
    // where he stands now (the tablet plans walk / poof on from here)
    this.active = this.roamPlan(this.actor.mount.position, this.side, this.height);
  }

  /** A world plan standing at p (poofs, the stay mode's "where he is"). */
  private roamPlan(p: THREE.Vector3, side: 1 | -1, height = this.roam?.height ?? this.height): TabletPlan {
    return { mode: 'world', pos: p.clone(), yaw: this.actor.mount.rotation.y, side, corner: 1, score: 0, hf: 0, lift: this.geoAt(height).tabUp, perch: p.y > 0.15, source: 'roam', height, cheer: 0, hop: 0 };   // (unchecked here: no bounce)
  }

  private ensureRoamLayer() {
    if (this.mover) this.dropMover();
    this.loco ??= new Locomotion(this.actor);
    const L = this.loco;
    this.base = (rt, dt) => L.apply(rt, dt);
    this.actor.extraPose = this.wrapper;
  }

  /** Walking speeds (m/s) at the roam height: an amble, and a hurry for chat / catching up. */
  private speeds(h: number) {
    const now = this.height > 0 ? h / this.height : 1;
    const ms = (this.loco?.maxSpeed() ?? 1.2) * now;
    const v = Math.max(0.35, Math.min(1.2 * THREE.MathUtils.clamp(h / 1.5, 0.5, 1.8), ms));
    // (a hurry may beat his comfortable stride cadence: a short-legged mascot scurries)
    return { v: Math.min(v * 0.8, ms), hurry: THREE.MathUtils.clamp(ms * 1.7, v, 1.3) };
  }

  private rebuild(force: boolean) {
    const set = this.roam;
    if (!set) return;
    const now = this.now();
    const key = `${set.key}|${this.seed}|${this.epoch}|${this.msgKey}`;
    if (!force && key === this.simKey && now < this.simTo - 8) return;
    this.simKey = key;
    const sp = this.speeds(set.height);
    this.segs = simulate({ set, seed: this.seed, epoch: this.epoch, msgs: this.msgs, now, v: sp.v, hurry: sp.hurry, h: set.height, maxHurry: Math.max(2, sp.hurry * 3) });
    this.simTo = now + 25;
  }

  private setRoamHeight(h: number) {
    if (Math.abs(this.height - h) < 1e-4 && this.active?.source === 'roam') return;
    this.setActive(this.roamPlan(this.actor.mount.position, this.side, h));
  }

  /** Get onto the timeline: walk there (catch up), walk in from the frame edge (he was hidden / off-screen), else pop in. */
  private join() {
    const set = this.roam;
    if (!set || !this.rt || !set.pts.length) return;
    const now = this.now();
    this.joinT = now;
    this.ensureRoamLayer();
    this.rebuild(false);
    const s = sampleRoam(this.segs, now);
    const goal = settleOf(s);
    const pt = goal.pt >= 0 ? goal.pt : nearestPt(set, goal.pos);
    const here = this.actor.mount.position.clone();
    const v = this.speeds(set.height).hurry;
    const hidden = !this.actor.shown || set.offscreen(here);
    // joins that keep failing (he never lands on the timeline): put him there (a poof) instead of walking forever
    this.joinN = now - this.joinLast < 2.5 ? this.joinN + 1 : 0;
    this.joinLast = now;
    if (this.joinN >= 4 && !hidden) { this.joinN = 0; this.popOn(s); return; }
    /** Then wait where the timeline settles (a point between two spots when a message stopped him there). */
    const wait = (r: RSeg[]) => {
      let tEnd = r.length ? r[r.length - 1].t1 : now;
      const last = r.length ? r[r.length - 1].b : here;
      if (goal.pt < 0 && last.distanceTo(goal.pos) > 0.05 && set.clear(last, goal.pos)) { const w = lineSeg(last, goal.pos, tEnd, v, s.dist, -1, s.side); r.push(w); tEnd = w.t1; }
      const at = goal.pt < 0 ? goal.pos : set.pts[pt].pos;
      const cg = s.seg && (s.seg.k === 'walk' || s.seg.k === 'hop') ? s.seg.t1 : 0;
      r.push({ k: 'hold', t0: tEnd, t1: Math.max(tEnd + 0.05, cg + 0.02), a: at.clone(), b: at.clone(), bit: 'idle', pt: goal.pt, dist0: s.dist, side: s.side });
      return r;
    };
    if (hidden) {
      this.setRoamHeight(set.height);
      if (this.popBack) { this.popBack = false; this.popOn(s); return; }
      // back from the lens: walks in from below the frame, where he went out
      const lb = this.lensBack;
      this.lensBack = null;
      const rb = lb ? localRoute(set, lb, -1, pt, now, v, set.height, s.dist) : null;
      if (lb && rb) {
        this.actor.place({ position: lb, yaw: Math.atan2(set.pts[pt].pos.x - lb.x, set.pts[pt].pos.z - lb.z), sit: 0 });
        this.actor.shown = true; this.actor.appear = 1;
        this.local = wait(rb); this.atPt = -1;
        return;
      }
      // off-screen but in the room (a cut away from him): he just walks in from where he is
      const rh = this.actor.shown ? localRoute(set, here, this.atPt, pt, now, v, set.height, s.dist) : null;
      if (rh) { this.local = wait(rh); this.joinStats.walkIn++; return; }
      const e = edgeEntry(set, pt);
      const r = e ? localRoute(set, e, -1, pt, now, v, set.height, s.dist) : null;
      if (e && r) {
        this.joinStats.edge++;
        this.actor.place({ position: e, yaw: Math.atan2(set.pts[pt].pos.x - e.x, set.pts[pt].pos.z - e.z), sit: 0 });
        this.actor.shown = true; this.actor.appear = 1;
        this.local = wait(r); this.atPt = -1;
        return;
      }
      // no way in from the frame edge: pop in where he should be
      this.joinStats.pop++;
      this.popOn(s);
      return;
    }
    this.joinStats.catchUp++;
    const r = goal.pt < 0 && set.clear(here, goal.pos) ? [lineSeg(here, goal.pos, now, v, s.dist, -1, s.side)] : localRoute(set, here, this.atPt, pt, now, v, set.height, s.dist);
    if (!r) { this.popOn(s); return; }
    this.local = wait(r);
  }
  /** The timeline's current segment if it is a fallback show (no readable spot for this message). */
  private segShowFall(now: number): RSeg | null { const g = sampleRoam(this.segs, now).seg; return g?.k === 'show' && g.fall ? g : null; }
  private popBack = false;
  /** Poof in right where the shared timeline has him now (and follow it while the poof runs). */
  private popFollow = false;
  private popOn(s: RSample) {
    this.poofTo(this.roamPlan(s.pos, s.side), false);
    this.popFollow = true;
    this.atPt = s.seg && (s.seg.k === 'hold' || s.seg.k === 'show') ? s.seg.pt : -1;
  }
  /** How he got onto the timeline (debug / harness): walked in from off-screen, from the frame edge, popped in, caught up. */
  joinStats = { walkIn: 0, edge: 0, pop: 0, catchUp: 0 };
  /** Walking up to the lens for the foreground peek (then the peek rises / sinks at the frame edge). */
  private lensAfter: { from: THREE.Vector3; end: number } | null = null;
  private lens: { phase: 'up' | 'show' | 'down'; t: number; from: THREE.Vector3 } | null = null;
  private lensBack: THREE.Vector3 | null = null;
  /** A floor point toward the lens where he is out of the frame (below its bottom edge), reachable straight. */
  private lensPoint(set: RoamSet): THREE.Vector3 | null {
    const here = this.actor.mount.position;
    const dir = set.camPos.clone().setY(here.y).sub(here);
    const L = dir.length();
    if (L < 0.3) return null;
    dir.divideScalar(L);
    for (let d = 0.3; d <= Math.min(1.3, L - 0.3); d += 0.2) {
      const p = here.clone().addScaledVector(dir, d);
      if (!set.offscreen(p)) continue;
      const a = p.addScaledVector(dir, 0.15);
      return set.clear(here, a) ? a : null;
    }
    return null;
  }
  private joinN = 0;
  private joinLast = -9;

  /** A camera cut showed him somewhere wrong: gone on the cut frame, back (walking in) once the new shot is planned. */
  hideForCut() {
    if (!this.roaming || !this.actor.shown || this.poof) return;
    this.popBack = false;
    this.actor.shown = false;
    this.local = null;
    this.entryAt = this.now() + 0.45;
  }

  /** Mark the readable spot he is showing from as bad for this shot (the live check found the tablet hidden). */
  roamBadTab() {
    const set = this.roam, s = this.rs;
    if (!set || !s?.seg || s.seg.pt < 0) return;
    const p = set.pts[s.seg.pt];
    if (!p?.tab) return;
    p.tab = null;
    this.simKey = '';
    this.rebuild(true);
  }

  /** Per frame (roam): the chat messages, the timeline / local walk, position + facing + the walk cycle inputs. */
  private stepRoam(dt: number, feed: ChatFeed, st: SceneChatState) {
    const set = this.roam!;
    const now = this.now();
    // chat messages → reaction times (the same on every page: event ts + REACT)
    const mk = `${feed.rev}|${st.hideBots}|${st.hideCommands}|${st.bots.join(',')}`;
    if (mk !== this.msgKey) {
      this.msgKey = mk;
      const out: number[] = [];
      for (const e of feed.events) if ((e.kind === 'chat' || e.kind === 'finance' || e.kind === 'system') && e.ts / 1000 > now - 180 && chatVisible(e, st)) out.push(e.ts / 1000 + REACT);          // (the event's own time — never the page's: every page the same)
      this.msgs = out;
    }
    // the fallback (no readable spot): shown through the tablet plans, then back into the room
    if (this.fallOn) {
      const L = this.lens;
      if (L) {
        L.t += dt;
        if (L.phase === 'up' && L.t >= 0.45) { L.phase = 'show'; L.t = 0; }
        if (L.phase !== 'down' && now >= this.fallEnd) { L.phase = 'down'; L.t = 0; }
        if (L.phase === 'down' && L.t >= 0.35) {
          // sunk below the frame edge: back into the room from there (walking away from the lens)
          this.actor.shown = false; this.fallOn = false; this.plan = null; this.lens = null;
          this.lensBack = L.from; this.entryAt = 0;
        }
        return;
      }
      if (now >= this.fallEnd) {
        this.fallOn = false; this.plan = null; this.overlayWant = false; this.entryAt = 0;
        if (this.actor.shown) this.poofTo(null, true);
        this.popBack = true;                                        // …and pops back into the room where he was
      }
      return;
    }
    // popping in onto the timeline: he keeps to it while he grows (lands exactly on it, no catch-up)
    if (this.poof) { if (this.popFollow && this.poof.phase === 'in') this.actor.mount.position.copy(sampleRoam(this.segs, now).pos); return; }
    this.popFollow = false;
    if (!set.pts.length) return;
    if (!this.actor.shown) {
      if (!this.planning && now >= this.entryAt && now - this.joinT > 0.25) this.join();
      if (!this.actor.shown || this.poof) return;
    }
    this.rebuild(false);
    if (this.local && now >= this.local[this.local.length - 1].t1) {
      this.local = null;
      const A = this.lensAfter;
      if (A) {
        // at the lens: the foreground peek for the display time (no poof — he walked here)
        this.lensAfter = null;
        if (set.msgPlan?.mode === 'fore') {
          this.fallOn = true; this.fallEnd = A.end;
          this.lens = { phase: 'up', t: 0, from: A.from };
          this.plan = set.msgPlan; this.overlayWant = false;
          this.base = null;
          this.setActive(set.msgPlan);
          return;
        }
      }
    }
    // a message while he walks onto the timeline: the fallback plan right away, or straight to the readable spot
    const cs = this.local ? sampleRoam(this.segs, now) : null;
    if (cs?.seg?.k === 'show' && !this.lensAfter) {
      if (cs.seg.fall && set.msgPlan) { this.local = null; }
      else if (!cs.seg.fall && this.local && this.local[this.local.length - 1].pt !== cs.seg.pt && now - this.joinT > 0.25) { this.local = null; this.join(); if (this.poof || !this.actor.shown) return; }
    }
    // no readable spot (near enough) for this message: the tablet plans show it (poof there and back)
    const fall = !this.local ? this.segShowFall(now) : null;
    if (fall && set.msgPlan) {
      // the foreground peek: he walks up to the lens (out of the frame at the bottom) and the peek rises from there
      if (set.msgPlan.mode === 'fore' && this.actor.shown) {
        const A = this.lensPoint(set);
        if (A) {
          const here = this.actor.mount.position.clone();
          this.local = [lineSeg(here, A, now, this.speeds(set.height).hurry, this.rs?.dist ?? 0, -1, this.side)];
          this.lensAfter = { from: A, end: fall.t1 };
          this.rs = sampleRoam(this.local, now, this.rs ?? undefined);
          return;
        }
      }
      this.fallOn = true; this.fallEnd = fall.t1;
      this.active = null;                                         // poof there (never walk the tablet plan's way)
      this.apply(set.msgPlan);
      return;
    }
    let s = this.rs = sampleRoam(this.local ?? this.segs, now, this.rs ?? undefined);
    if (!this.local && s.pos.distanceTo(this.actor.mount.position) > 0.05) {
      if (now - this.joinT > 0.25) { this.join(); if (this.poof || !this.actor.shown) return; }
      s = this.rs = sampleRoam(this.local ?? this.segs, now, this.rs);
      if (!this.local && s.pos.distanceTo(this.actor.mount.position) > 0.05) return;     // next try in a moment
    }
    // no readable spot in this shot: never raise the (unreadable) tablet in the room — the fallback plan shows it
    if (s.seg?.k === 'show' && s.seg.fall) s.raise = 0;
    this.actor.mount.position.copy(s.pos);
    this.side = s.side;
    this.atPt = s.seg && (s.seg.k === 'hold' || s.seg.k === 'show') ? s.seg.pt : -1;
    // facing: along the walk, else the lens (the host while peering at them)
    let want = s.heading;
    // a trip happens mid-walk: he falls the way he was going (never flat onto the lens)
    if (want === null && s.bit === 'trip') want = this.actor.mount.rotation.y;
    if (want === null) {
      const to = (s.bit === 'peer' && this.hostHead ? this.hostHead : this.cam).clone().sub(this.actor.mount.position).setY(0);
      want = to.lengthSq() > 1e-4 ? Math.atan2(to.x, to.z) : this.actor.mount.rotation.y;
    }
    const cur = this.actor.mount.rotation.y;
    const d = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
    this.actor.mount.rotation.set(0, cur + d * (1 - Math.exp(-(s.heading !== null ? 12 : 7) * dt)), 0);
    const L = this.loco!;
    L.dist = s.dist; L.gait = s.gait; L.back = false; L.stride = 1;
    L.armW = s.gait > 0.01 ? 0.7 * s.gait : 0;
    L.headW = 0;
    const idle = (s.seg?.k === 'hold' || s.seg?.k === 'show') && s.bit !== 'sit' && s.bit !== 'trip' ? 1 : 0;
    L.idle += (idle - L.idle) * (1 - Math.exp(-2.5 * dt));
    this.actor.loco = s.gait;
  }

  /** Tablet (roam): carried at his side (a tray for big tablets / floating beside stand models) ↔ raised to the lens
   *  (the spot's plan) — plus read-his-own-tablet and dropped-on-the-floor (the trip). */
  private placeTabletRoam() {
    const s = this.rs!, g = this.geo, m = this.actor.mount, h = this.height;
    const yaw = m.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const sd = this.side;
    const off = this.actor.offset;
    const body = m.position.clone().addScaledVector(left, off.x).addScaledVector(fwd, off.z);
    body.y += off.y;
    const basis = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    // raised: exactly the planner's tablet (square to the image plane)
    const tab = s.seg?.tab;
    const up0 = tab ? tab.lift * (h / Math.max(1e-4, tab.height)) : g.tabUp;
    const rc = m.position.clone().addScaledVector(UP, up0 + (g.hold === 'stand' ? 0 : this.cheerLift() * this.cheerK * h * CHEER_LIFT)).addScaledVector(fwd, g.tabFwd).addScaledVector(left, sd * g.tabSide);
    const rq = this.camera ? this.camera.getWorldQuaternion(new THREE.Quaternion()) : basis(new THREE.Vector3().crossVectors(UP, fwd), UP, fwd);
    // carried
    let cc: THREE.Vector3, cq: THREE.Quaternion;
    if (g.hold === 'two') {
      const z = UP.clone().multiplyScalar(0.94).addScaledVector(fwd, 0.34).normalize();
      const y = fwd.clone().addScaledVector(z, -fwd.dot(z)).normalize();
      cq = basis(new THREE.Vector3().crossVectors(y, z), y, z);
      cc = body.clone().addScaledVector(UP, Math.max(0.42 * h, g.tabW * 0.1 + 0.3 * h)).addScaledVector(fwd, g.tabFwd * 0.7 + g.tabH * 0.32);
    } else {
      const sx = this.rig?.arms.length ? Math.max(...this.rig.arms.map((a) => Math.abs(a.S.x))) * this.actor.scale : h * 0.2;
      const out = Math.max(sx + 0.035 * h, g.headW * 0.85);
      const z = left.clone().multiplyScalar(sd);
      cq = basis(new THREE.Vector3().crossVectors(UP, z), UP, z);
      cc = body.clone().addScaledVector(UP, Math.max(g.tabH / 2 + 0.05 * h, 0.42 * h)).addScaledVector(z, out).addScaledVector(fwd, 0.03 * h);
      cc.y = Math.max(cc.y, m.position.y + g.tabH / 2 + 0.01);
    }
    let pc = cc, pq = cq;
    // reading his own tablet (in front of his face, turned to him)
    const bt = s.bitT, bd = BIT_DUR[s.bit] || 1;
    const rk = s.bit === 'read' ? Math.min(clamp01(bt / 0.45), clamp01((bd - bt) / 0.45)) : 0;
    if (rk > 0) {
      const z = fwd.clone().multiplyScalar(-0.85).addScaledVector(UP, 0.5).normalize();
      const y = UP.clone().addScaledVector(z, -UP.dot(z)).normalize();
      const q = basis(new THREE.Vector3().crossVectors(y, z), y, z);
      const c = body.clone().addScaledVector(UP, Math.max(g.headUp - 0.2 * h, g.tabH / 2 + 0.05 * h)).addScaledVector(fwd, 0.3 * h + g.tabH * 0.1);
      pc = pc.clone().lerp(c, smoothK(rk)); pq = pq.clone().slerp(q, smoothK(rk));
    }
    // the trip: it flies out of his hand and lands flat in front of him; he picks it up again
    const dk = s.bit === 'trip' ? tripDrop(bt) : 0;
    if (dk > 0) {
      const q = basis(new THREE.Vector3().crossVectors(fwd, UP), fwd, UP);
      const c = m.position.clone().addScaledVector(fwd, 0.62 * h + g.tabH * 0.5).addScaledVector(UP, 0.012 + (bt < 1 ? Math.sin(Math.PI * dk) * 0.15 * h : 0));
      pc = pc.clone().lerp(c, dk); pq = pq.clone().slerp(q, dk);
    }
    const rz = s.raise;
    const wc = pc.clone().lerp(rc, rz), wq = pq.clone().slerp(rq, rz);
    this.anchor.updateWorldMatrix(true, false);
    const sc = this.anchor.getWorldScale(new THREE.Vector3()).x || 1;
    this.tablet.position.copy(this.anchor.worldToLocal(wc.clone()));
    this.tablet.scale.set(g.tabW / sc, g.tabH / 0.75 / sc, g.tabW / sc);
    const pqi = this.tablet.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.tablet.quaternion.copy(pqi.multiply(wq));
    this.tablet.updateWorldMatrix(true, false);
    // grips (tablet-local, blended between the carried and the raised hold) → world
    this.grips.clear();
    if (dk > 0.5 || g.hold === 'stand') return;
    const arms = this.rig?.arms ?? [];
    const mine = arms.filter((a) => a.side === sd);
    const holders = g.hold === 'two' ? arms : mine.length ? mine : arms.slice(0, 1);
    for (const a of holders) {
      const lg = g.hold === 'two' ? new THREE.Vector3(a.side * 0.44 * (2 * rz - 1), -0.3 + 0.02 * rz, this.gripZ(a)) : new THREE.Vector3(-sd * (0.46 - 0.06 * rz), 0.05 - 0.17 * rz, this.gripZ(a));
      this.grips.set(a.side, lg.applyMatrix4(this.tablet.matrixWorld));
    }
  }

  /** Pose layer (roam): grips, the bits (arms, spine, sitting, the trip), cheers, the head. */
  private poseRoam(rt: AvatarRuntime) {
    const R = this.rig, h = rt.humanoid, s = this.rs;
    if (!R || !h || !s) return;
    const H = this.restH;
    const toN = (q: THREE.Quaternion) => R.toNorm.clone().multiply(q).multiply(R.fromNorm);
    const pre = (bone: VRMHumanBoneName, q: THREE.Quaternion) => { const n = h.getNormalizedBoneNode(bone); if (n) n.quaternion.premultiply(toN(q)); };
    const lift = this.cheerLift();
    const hm = this.height;
    if (this.cheerT < 0.9) this.actor.offset.y += Math.abs(Math.sin((this.cheerT / 0.45) * Math.PI)) * hm * CHEER_HOP * this.hopK;
    const bit = s.bit, bt = s.bitT, D = BIT_DUR[bit] || 1;
    const env = (a: number, b: number) => Math.min(clamp01(bt / a), clamp01((D - bt) / b));
    const E = new THREE.Euler();
    const Q = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(E.set(x, y, z, 'YXZ'));
    type Arm = NonNullable<ChatBuddy['rig']>['arms'][number];
    const free = new Map<number, THREE.Vector3>();
    const rest = this.actor.rest;
    const face = rest?.face.center ?? R.head, fs = rest?.face.size ?? H * 0.2;
    /** Free-arm target: shoulder + a direction × arm length (avatar space, x toward that arm's side). */
    const dirT = (arm: Arm, x: number, y: number, z: number) => arm.S.clone().addScaledVector(new THREE.Vector3(x * arm.side, y, z).normalize(), (arm.a + arm.b) * 0.97);
    const restT = (arm: Arm) => dirT(arm, 0.12, -0.97, 0.06);
    // ---- the perch hop: a little lean, arms up
    if (s.hop >= 0) {
      this.actor.tilt.multiply(Q(0.18 * Math.sin(Math.PI * s.hop), 0, 0));
      for (const a of R.arms) free.set(a.side, dirT(a, 0.35, 0.75 * Math.sin(Math.PI * s.hop), 0.3));
    }
    switch (bit) {
      case 'wave': { const e = env(0.35, 0.35); for (const a of R.arms) free.set(a.side, restT(a).lerp(dirT(a, 0.35 + 0.28 * Math.sin(bt * 9), 0.8, 0.28), e)); this.actor.offset.y += Math.abs(Math.sin(bt * 4.5)) * 0.015 * hm * e; break; }
      case 'peer': {
        const e = env(0.5, 0.5);
        pre('spine', Q(0.2 * e, 0, 0)); pre('chest', Q(0.1 * e, 0, 0));
        for (const a of R.arms) free.set(a.side, restT(a).lerp(face.clone().add(new THREE.Vector3(a.side * fs * 0.15, fs * 0.45, fs * 0.6)), e));
        break;
      }
      case 'stretch': {
        const e = env(0.7, 0.7);
        pre('spine', Q(-0.16 * e, 0, 0.05 * Math.sin(bt * 1.5) * e)); pre('chest', Q(-0.12 * e, 0, 0));
        this.actor.offset.y += 0.02 * hm * e;
        for (const a of R.arms) free.set(a.side, restT(a).lerp(dirT(a, 0.12, 1, 0.08), e));
        break;
      }
      case 'look': { const e = env(0.4, 0.4); for (const a of R.arms) free.set(a.side, restT(a).lerp(face.clone().add(new THREE.Vector3(a.side * fs * 0.5, fs * 0.8 + Math.sin(bt * 11) * fs * 0.06, fs * 0.05)), e)); break; }
      case 'hop': { const ph = (bt % 0.8) / 0.8; if (bt < 1.6) this.actor.offset.y += Math.sin(Math.PI * ph) * 0.12 * hm; for (const a of R.arms) free.set(a.side, dirT(a, 0.4, 0.8, 0.25)); break; }
      case 'dance': {
        const e = env(0.4, 0.4), w = Math.sin(bt * Math.PI * 2.4);
        this.actor.offset.x += w * 0.035 * hm * e;
        pre('spine', Q(0, 0.12 * w * e, -0.1 * w * e));
        for (const a of R.arms) free.set(a.side, restT(a).lerp(dirT(a, 0.45, 0.25 + 0.55 * Math.sin(bt * 7 + (a.side > 0 ? 0 : Math.PI)), 0.3), e));
        break;
      }
      case 'sit': this.sitPose(rt, env(0.6, 0.6)); break;
      case 'trip': {
        // stumble → face-plant → get up → dust off → sheepish look at the lens
        const fall = bt < 0.45 ? Math.pow(bt / 0.45, 2) : bt < 1.4 ? 1 - 0.06 * Math.sin((bt - 0.45) * 9) * Math.exp(-(bt - 0.45) * 4) : 1 - smoothK((bt - 1.4) / 0.7);
        this.actor.tilt.multiply(Q(1.2 * fall, 0, 0.1 * fall));
        this.actor.offset.y += 0.04 * hm * fall;
        this.actor.offset.z += 0.05 * hm * fall;
        if (bt < 1.9) for (const a of R.arms) free.set(a.side, dirT(a, 0.3, 0.15, 0.95));
        else if (bt < 3.3) for (const a of R.arms) free.set(a.side, dirT(a, 0.2, -0.6 + 0.14 * Math.sin(bt * 16 + a.side), 0.45));
        break;
      }
    }
    // cheers: both free arms up
    if (lift > 0.02) for (const a of R.arms) free.set(a.side, (free.get(a.side) ?? restT(a)).clone().lerp(dirT(a, 0.3, 0.85, 0.45), lift));
    // arms: holders grip the tablet, the others do the bit (else keep the walk swing / hang)
    for (const arm of R.arms) {
      const pole = new THREE.Vector3(arm.side * 0.8, -0.6, -0.1).normalize();
      const gw = this.grips.get(arm.side);
      if (gw) {
        const T = this.anchor.worldToLocal(gw.clone());
        const L = (arm.a + arm.b) * 0.97;
        const Dv = T.clone().sub(arm.S);
        if (Dv.length() > L) T.copy(arm.S).addScaledVector(Dv.normalize(), L);
        this.ik(h, arm, T, pole);
        continue;
      }
      const f = free.get(arm.side);
      if (f) this.ik(h, arm, f, pole);
    }
    // head: toward the look target
    const loc = this.anchor.worldToLocal(this.look.clone());
    const dir = loc.sub(R.head);
    const yaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-dir.y, Math.hypot(dir.x, dir.z)), -0.5, 0.65);
    const qn = toN(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')));
    const neck = h.getNormalizedBoneNode('neck'), head = h.getNormalizedBoneNode('head');
    if (neck && head) { neck.quaternion.premultiply(I.clone().slerp(qn, 0.4)); head.quaternion.premultiply(I.clone().slerp(qn, 0.6)); }
    else (head ?? neck)?.quaternion.premultiply(qn);
  }

  /** Sitting down (floor: legs out in front; a perch edge: legs dangling over it). */
  private sitPose(rt: AvatarRuntime, e: number) {
    if (e <= 0.001) return;
    const r = this.actor.rest, h = rt.humanoid;
    const k = this.actor.scale || 1;
    const edge = this.roam && this.atPt >= 0 ? !!this.roam.pts[this.atPt]?.edge : false;
    if (!r?.legs || !r.hips || !h) { this.actor.offset.y -= 0.12 * this.height * e; return; }
    const hipsH = (r.hips.y - r.floorY) * k, thigh = r.height * k * 0.055;
    this.actor.offset.y -= Math.max(0, hipsH - thigh) * smoothK(e);
    for (const side of ['left', 'right'] as const) {
      const lr = r.legs[side];
      if (!lr) continue;
      const sg = side === 'left' ? 1 : -1;
      const ul = h.getNormalizedBoneNode(`${side}UpperLeg` as VRMHumanBoneName), ll = h.getNormalizedBoneNode(`${side}LowerLeg` as VRMHumanBoneName);
      const ft = lr.hasFoot ? h.getNormalizedBoneNode(`${side}Foot` as VRMHumanBoneName) : null;
      if (!ul || !ll) continue;
      const thighD = new THREE.Vector3(0.12 * sg, edge ? -0.06 : 0.02, 1).normalize().applyQuaternion(r.legs.toNorm);
      const shinD = (edge ? new THREE.Vector3(0.03 * sg, -1, 0.12) : new THREE.Vector3(0.05 * sg, -0.1, 1)).normalize().applyQuaternion(r.legs.toNorm);
      const upW = new THREE.Quaternion().setFromUnitVectors(lr.upper, thighD);
      const cur = lr.lower.clone().applyQuaternion(upW);
      const loW = new THREE.Quaternion().setFromUnitVectors(cur, shinD).multiply(upW);
      ul.quaternion.slerp(upW, e);
      ll.quaternion.slerp(upW.clone().invert().multiply(loW), e);
      if (ft) ft.quaternion.slerp(loW.clone().invert(), e);
    }
  }

  /** Where he looks (roam): ahead while walking, the lens / the host / the others / around while standing, the bit's
   *  own target during a bit — deterministic (wall clock + the timeline). */
  private roamLook(now: number, tabW: THREE.Vector3): THREE.Vector3 {
    const s = this.rs!, m = this.actor.mount.position, g = this.geo;
    const eye = m.clone().setY(m.y + g.headUp);
    const yaw = this.actor.mount.rotation.y;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const around = (a: number) => eye.clone().add(fwd.clone().applyAxisAngle(UP, a).multiplyScalar(3));
    if (this.cheerT < 1.8) return this.cam;
    if (s.seg?.k === 'show') { const r = hash(Math.floor(now / 2.4)); return r < 0.62 ? this.cam : r < 0.9 ? tabW : this.hostHead ?? this.cam; }
    if (s.heading !== null) {
      if (hash(Math.floor(now / 1.7) + 11) < 0.22) return this.cam;
      return eye.clone().add(new THREE.Vector3(Math.sin(s.heading), -0.25, Math.cos(s.heading)).multiplyScalar(3));
    }
    switch (s.bit) {
      case 'wave': case 'hop': case 'dance': return this.cam;
      case 'trip': return s.bitT < 2.9 ? m.clone().addScaledVector(fwd, 1.2) : this.cam;
      case 'peer': return this.hostHead ?? this.cam;
      case 'read': return tabW;
      case 'look': return around(Math.sin(s.bitT * 1.9) * 1.2);
      case 'stretch': return eye.clone().addScaledVector(UP, 3).addScaledVector(fwd, 1);
    }
    const r = hash(Math.floor(now / 2.8) + 7);
    if (r < 0.45) return this.cam;
    if (r < 0.78 && this.heads.length) return this.heads[Math.floor(r * 997) % this.heads.length];
    return around((r - 0.89) * 6);
  }

  /** Face (roam bits): yawn, surprise, grin, squint. */
  private bitFace(): { smile: number; jaw: number; blink: number; squint: number } {
    const s = this.rs;
    const o = { smile: 0, jaw: 0, blink: 0, squint: 0 };
    if (!s || !this.roaming) return o;
    const bt = s.bitT, D = BIT_DUR[s.bit] || 1;
    const env = (a: number, b: number) => Math.min(clamp01(bt / a), clamp01((D - bt) / b));
    switch (s.bit) {
      case 'stretch': { const y = env(0.9, 0.9) * clamp01(Math.sin((bt / D) * Math.PI) * 1.6); o.jaw = 0.55 * y; o.blink = 0.8 * y; break; }
      case 'trip': if (bt < 1.5) { o.jaw = 0.45; o.squint = 0.4; } else if (bt > 3) { o.smile = 0.4; o.squint = 0.3; } break;
      case 'wave': case 'hop': case 'dance': o.smile = 0.5 * env(0.3, 0.3); break;
      case 'peer': o.squint = 0.55 * env(0.4, 0.4); break;
      case 'read': o.smile = 0.25; o.jaw = bt > 2.2 && bt < 3.2 ? 0.18 * Math.abs(Math.sin(bt * 14)) : 0; break;
      case 'sit': o.smile = 0.2; break;
    }
    return o;
  }

  setManual(on: boolean) { if (this.mover) this.mover.manual = on; this.manualClock = on; }

  dispose() {
    this.mover?.dispose();
    this.actor.detach();
    this.actor.mount.removeFromParent();
    this.overlay.removeFromParent();
    this.stand.removeFromParent();
    this.rt?.dispose();
    this.rt = null;
    this.canvas.dispose();
    for (const o of this.owned) o.dispose();
    if (this.room.door && this.origDoor) { this.room.door.setOpen = this.origDoor; this.origDoor(this.door.main); }
  }
}

const smoothK = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
/** Trip: how far the tablet is out of his hand (0 held … 1 lying on the floor). */
function tripDrop(bt: number) { return bt < 0.2 ? 0 : bt < 0.45 ? smoothK((bt - 0.2) / 0.25) : bt < 1.9 ? 1 : 1 - smoothK((bt - 1.9) / 0.5); }
/** The roam spot closest to a point. */
function nearestPt(set: RoamSet, p: THREE.Vector3) {
  let best = 0, bd = Infinity;
  for (const q of set.pts) { const d = q.pos.distanceTo(p); if (d < bd) { bd = d; best = q.id; } }
  return best;
}

function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}

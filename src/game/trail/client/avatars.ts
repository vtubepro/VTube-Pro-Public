// The Trail — performers in the game world: each player's own VTube Pro avatar (face + voice still tracked), placed on
// the sim's capsule, walking with the room engine's procedural walk cycle (SceneActor + Locomotion), sitting on the
// wagon / camp logs, carrying (arms out), flopping when ragdolled, big heads, ghosts, first-person head hiding.
// Custody: party members' avatars come ONLY from the sealed RAM vault (partyView.open: decrypted in memory, parsed from
// the buffer, plaintext wiped) — exactly like an OBS page. Nothing is written anywhere.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { TrackingFrame } from '../../../../shared/types.ts';
import { normalizeProfile } from '../../../../shared/defaults.ts';
import { api } from '../../../api.ts';
import { AvatarRuntime } from '../../../avatar/AvatarRuntime.ts';
import { partyView } from '../../../net/partyView.ts';
import { FrameSync } from '../../../outputSync.ts';
import { SceneActor, measureRest } from '../../../scene/actor.ts';
import { Locomotion } from '../../../scene/locomotion.ts';
import type { SpotInfo } from '../../../scene/contract.ts';
import { emptyFrame } from '../../../tracking/faceSolver.ts';
import { ANIM, F } from '../../../../shared/trail/wire.ts';
import type { TvInfo } from '../../../../shared/tv.ts';
import { TvRuntime } from '../../../scene/tv/tvRuntime.ts';
import type { TvReaction } from '../../../scene/tv/tvAnim.ts';
import { trailFeeds } from './tvfeeds.ts';
import { labelSprite, toon, unitCapsule } from './kit.ts';
import { BodyAnim } from './anim.ts';
import { StandIn, standInAvatarId, withTimeout, LOAD_TIMEOUT_MS, RETRY_S } from './standin.ts';

/** Where a performer's body comes from. `tv` = a walking-TV performer (webcam / Live2D guests, workstream `tvguests`,
 *  S\tv\PERFORMER_API.md): their TvRuntime (tvart skin or grey-box) driven with `external` from the sim; `feedId` = the
 *  feed id of the live picture (party member id; this PC's own = the studio's tvSelf.id). `tvHooks.tvBody` overrides the
 *  body (tests); without TvInfo a stand-in TV is drawn. */
export type AvatarSource = { kind: 'self'; avatarId: string } | { kind: 'party'; memberId: string } | { kind: 'lib'; avatarId: string } | { kind: 'tv'; memberId: string; feedId?: string; tv?: TvInfo; aspect?: number } | { kind: 'none' };
export const tvHooks: { tvBody: ((memberId: string, height: number) => THREE.Object3D | null) | null } = { tvBody: null };
const tune = normalizeProfile({ id: '_', modelFile: '' }).tracking;
const SEAT: SpotInfo = { index: 0, name: 'seat', node: new THREE.Object3D(), pose: 'sit', seatHeight: 0, seatDepth: 0.4, label: '', position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1), yaw: 0, cam: null, leavePathAt: null, approach: [] } as unknown as SpotInfo;

/** One performer's body in the world. */
export class PlayerAvatar {
  /** Capsule centre + body orientation (the sim's); the actor hangs under it. */
  readonly pivot = new THREE.Group();
  /** Yaw-facing frame at the feet (π-turned: avatars face +Z, the sim's forward is −Z). */
  readonly feet = new THREE.Group();
  readonly actor: SceneActor;
  readonly loco: Locomotion;
  runtime: AvatarRuntime | null = null;
  private anchor = new THREE.Group();
  private placeholder: THREE.Mesh;
  private tag: THREE.Sprite | null = null;
  private tagText = '';
  frame: TrackingFrame = emptyFrame();
  lastFrameAt = 0;
  readonly sync = new FrameSync();
  private loading = '';
  source: AvatarSource = { kind: 'none' };
  height = 1.7;
  firstPerson = false;
  /** This view's own performer (no name tag over your own head). */
  isSelf = false;
  ghost = false;
  /** Set by the view each frame: this body stands between the camera and the player → drawn see-through. */
  occluding = false;
  private matMode: 'n' | 'g' | 'f' = 'n';
  bigHead = 1;
  private headScale = 1;
  private ghostMats: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null = null;
  private flop = { t: 0, amp: 0 };
  private lastQ = new THREE.Quaternion();
  carry = 0;
  seated = 0;
  /** Clip animation layer (src/game/trail/client/anim.ts); the procedural walk above is its fallback. */
  readonly anim = new BodyAnim();
  /** 0..∞ mass / lift of what this player holds (set by the weight meters, weight.ts) → strain animation. */
  strain = 0;
  /** Name-tag status line: 'loading avatar…', 'avatar not shared', … ('' = none). */
  status = '';
  private color: string;
  private standIn: StandIn;
  private gen = 0;
  private disposed = false;
  private retryKey = ''; private tries = 0; private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private createdAt = performance.now();
  /** The body shown is a stand-in (library avatar or mannequin), not this performer's own model. */
  isStandIn = false;

  constructor(readonly id: string, public name: string, color: string) {
    this.actor = new SceneActor(id, name);
    this.loco = new Locomotion(this.actor);
    this.actor.extraPose = (rt, dt) => { if (!this.anim.apply(rt, dt, this.actor)) this.loco.apply(rt, dt); this.extraPose(rt, dt); };
    this.actor.shown = true;
    this.pivot.add(this.feet);
    this.feet.add(this.actor.mount);
    this.feet.rotation.y = Math.PI;
    // (kept for the old contract; never shown — the labelled mannequin below stands in until the avatar arrives)
    this.placeholder = new THREE.Mesh(unitCapsule(), toon(color));
    this.placeholder.visible = false;
    this.color = color;
    this.standIn = new StandIn(color);
    this.feet.add(this.standIn.root);
    this.setName(name, color);
  }

  /** Play a trail emote on the body (wave, dance, point, facepalm, cheer, laugh, sit, soundbite). */
  playEmote(id: string) {
    // walking TVs play their own reaction clips (tvguests' TvRuntime)
    if (this.tvRt) { const r = TV_EMOTE[id]; if (r) this.tvRt.react(r); return; }
    if (!this.anim.playEmote(id)) this.standIn.emote(id);
  }

  setStatus(s: string) {
    if (s === this.status) return;
    this.status = s;
    this.tagText = '';
    this.setName(this.name, this.color);
  }

  setName(name: string, color = this.color ?? '#ffffff') {
    this.color = color;
    const text = this.status ? `${name} · ${this.status}` : name;
    if (text === this.tagText) return;
    this.tagText = text;
    if (this.tag) { this.pivot.remove(this.tag); this.tag.material.map?.dispose(); this.tag.material.dispose(); }
    this.tag = labelSprite(text, { fg: color, height: 0.2 });
    this.tag.position.set(0, this.height * 0.5 + 0.28, 0);
    this.pivot.add(this.tag);
    this.name = name;
  }

  /** Load / switch the model (self: the studio's avatar; party: the sealed vault copy; lib: a library stand-in). */
  //
  // Serving the models (the failure modes this handles): every load has a generation — a newer request (a new sealed
  // rev, a forced refresh, a level change) always wins and late results are disposed, never attached; a load that hangs
  // (vault fetch, parse) times out; failures retry with back-off (2 / 5 / 10 / 20 s, then every 30 s) instead of leaving a
  // capsule forever; while loading, a labelled mannequin stands in ("loading avatar…"); a performer whose model can't be
  // had (sharing off, no avatar picked, bots) gets a library stand-in avatar with a label — never a bare capsule. The
  // previous body stays up while a new one loads (no flash). Custody unchanged: sealed bytes are opened in RAM, parsed
  // from the buffer and wiped; nothing is written anywhere.
  async load(src: AvatarSource, force = false) {
    if (this.disposed) return;
    if (src.kind === 'tv') { this.gen++; this.loading = ''; this.isStandIn = false; clearTimeout(this.retryTimer); this.setStatus(''); this.standIn.show(false); void this.loadTv(src); return; }
    if (src.kind === 'none') { this.loadStandIn(); return; }
    const key = src.kind === 'party' ? `party:${src.memberId}` : `${src.kind}:${src.avatarId}`;
    if (!force && (this.loading === key || (this.sourceKey() === key && !this.isStandIn))) return;
    if (this.retryKey !== key) { this.retryKey = key; this.tries = 0; }
    clearTimeout(this.retryTimer);
    const gen = ++this.gen;
    this.loading = key;
    if (!this.runtime || this.isStandIn || this.tv) { this.setStatus(this.tries ? `loading avatar… (retry ${this.tries})` : 'loading avatar…'); if (!this.runtime && !this.tv) this.standIn.show(true); }
    const work = this.fetchRuntime(src);
    // a result that arrives after a timeout / a newer request is disposed, never attached
    work.then((rt) => { if (gen !== this.gen || this.disposed) rt.dispose(); }, () => {});
    try {
      const rt = await withTimeout(work, LOAD_TIMEOUT_MS, 'avatar load timed out');
      if (gen !== this.gen || this.disposed) return;
      this.attachRuntime(rt, src);
      this.isStandIn = false;
      this.tries = 0;
      this.setStatus('');
    } catch (e) {
      console.warn('trail: avatar load failed', key, e);
      if (gen !== this.gen || this.disposed) return;
      this.gen++;            // orphan the attempt: if it still finishes (after a timeout), it is disposed, not attached
      this.loading = '';
      this.tries++;
      const wait = RETRY_S[Math.min(this.tries - 1, RETRY_S.length - 1)];
      this.retryTimer = setTimeout(() => { if (!this.disposed && this.retryKey === key) void this.load(src, true); }, wait * 1000);
      if (this.tries >= 3 && (!this.runtime || this.isStandIn)) this.loadStandIn('avatar unavailable', true);
      else this.setStatus(`loading avatar… (retry in ${wait} s)`);
    } finally { if (gen === this.gen && this.loading === key) this.loading = ''; }
  }
  /** Open + parse a model (party: the sealed RAM vault, decrypted in memory, wiped right after parsing). */
  private async fetchRuntime(src: Extract<AvatarSource, { kind: 'self' | 'party' | 'lib' }>): Promise<AvatarRuntime> {
    let sealed: Awaited<ReturnType<typeof partyView.open>> | null = null;
    try {
      sealed = src.kind === 'party' ? await partyView.open(src.memberId) : null;
      const p = normalizeProfile(sealed ? sealed.profile : await api.avatar(src.kind === 'party' ? '' : src.avatarId));
      const fresh = new THREE.Group();
      const rt = await AvatarRuntime.load(p, sealed ? sealed.model : api.modelUrl(p), fresh);
      sealed?.wipe(); sealed = null;
      measureRest(rt);
      return rt;
    } finally { sealed?.wipe(); }
  }
  private attachRuntime(rt: AvatarRuntime, src: AvatarSource) {
    this.runtime?.dispose();
    this.actor.detach();
    this.anchor = rt.anchor as THREE.Group;
    this.clearTv();
    this.runtime = rt;
    this.actor.attach(rt.anchor, rt);
    rt.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
    this.source = src;
    this.applyHeight();
    this.placeholder.visible = false;
    this.standIn.show(false);
    this.headScale = 1;
    this.ghostMats = null; this.matMode = 'n';
    this.applyLook();
  }
  /** No model of this performer to show: bots get a library stand-in; others wait a moment (their sealed avatar may be
   *  on its way), then a library stand-in labelled "avatar not shared". The mannequin covers every gap. */
  private loadStandIn(label?: string, keepTimer = false) {
    // a performer's own model already on screen stays (e.g. they stopped sharing mid-game: nothing new is fetched)
    if (!label && this.runtime && !this.isStandIn) { this.setStatus(''); return; }
    const bot = this.id.startsWith('bot');
    const why = label ?? (bot ? '' : performance.now() - this.createdAt < 12000 ? 'waiting for avatar…' : 'avatar not shared');
    if (!keepTimer) { clearTimeout(this.retryTimer); this.retryKey = ''; }
    if (!this.runtime && !this.tv) this.standIn.show(true);
    this.setStatus(why);
    if (why === 'waiting for avatar…') {
      // re-check shortly: still nothing → the labelled library stand-in
      const g = this.gen;
      setTimeout(() => { if (!this.disposed && this.gen === g && this.status === 'waiting for avatar…') this.loadStandIn(); }, 12500 - (performance.now() - this.createdAt));
      return;
    }
    if ((this.isStandIn && this.runtime) || this.loading === 'standin') return;
    const gen = ++this.gen;
    this.loading = 'standin';
    void standInAvatarId(this.id).then(async (lib) => {
      if (!lib || gen !== this.gen || this.disposed) return;
      const work = this.fetchRuntime({ kind: 'lib', avatarId: lib });
      work.then((rt) => { if (gen !== this.gen || this.disposed) rt.dispose(); }, () => {});
      const rt = await withTimeout(work, LOAD_TIMEOUT_MS, 'stand-in timed out');
      if (gen !== this.gen || this.disposed) return;
      this.attachRuntime(rt, { kind: 'none' });
      this.isStandIn = true;
    }).catch((e) => console.warn('trail: stand-in avatar failed (the mannequin stays)', e))
      .finally(() => { if (gen === this.gen && this.loading === 'standin') this.loading = ''; });
  }
  private sourceKey() { const s = this.source; return s.kind === 'party' || s.kind === 'tv' ? `${s.kind}:${s.memberId}` : s.kind === 'none' ? '' : `${s.kind}:${s.avatarId}`; }
  private tv: THREE.Object3D | null = null;
  private tvRt: TvRuntime | null = null;
  private tvKey = '';
  private wasRag = false;
  /** A walking-TV performer: tvguests' TvRuntime (their skin + live picture), else a stand-in TV on legs. */
  private async loadTv(src: Extract<AvatarSource, { kind: 'tv' }>) {
    const key = `${src.memberId}|${src.feedId ?? ''}|${src.tv?.skin ?? ''}|${src.tv?.height ?? ''}`;
    if (this.tvKey === key && this.tv) { if (src.tv) this.tvRt?.setInfo(src.tv); return; }
    this.clearTv();
    this.tvKey = key;
    // leaving an avatar: drop its model (a TV has no humanoid)
    if (this.runtime) { this.actor.detach(); this.runtime.dispose(); this.runtime = null; this.ghostMats = null; this.matMode = 'n'; }
    this.source = { kind: 'tv', memberId: src.memberId };
    this.placeholder.visible = false;
    const holder = new THREE.Group();
    this.tv = holder;
    this.feet.add(holder);
    const hooked = tvHooks.tvBody?.(src.memberId, this.height) ?? null;
    if (hooked || !src.tv) { holder.add(hooked ?? standInTv(this.height)); return; }
    try {
      const rt = await TvRuntime.load({ feedId: src.feedId ?? src.memberId, name: this.name, tv: src.tv, anchor: holder, feeds: trailFeeds });
      if (this.tvKey !== key || this.tv !== holder) { rt.dispose(); return; }
      this.tvRt = rt;
      this.fitTv();
    } catch (e) {
      console.warn('trail: TV body failed, using a stand-in', e);
      if (this.tv === holder) holder.add(standInTv(this.height));
    }
  }
  private clearTv() {
    this.tvRt?.dispose(); this.tvRt = null;
    this.tv?.removeFromParent(); this.tv = null;
    this.tvKey = '';
  }
  /** Scale the TV set so its body (without antennas) is the player's height (the sim's capsule). */
  private fitTv() {
    const rt = this.tvRt;
    if (!rt) return;
    rt.wrapper.scale.setScalar(1);
    const hb = rt.bounds().getSize(v1).y;
    if (hb > 0.05) rt.wrapper.scale.setScalar(this.height / hb);
  }

  setHeight(h: number) { if (Math.abs(h - this.height) < 1e-3 && this.runtime) return; this.height = h; this.applyHeight(); }
  private applyHeight() {
    this.actor.setHeight(this.height);
    this.fitTv();
    this.placeholder.scale.set(this.height * 0.2, this.height * 0.3, this.height * 0.2);
    this.standIn.setHeight(this.height);
    if (this.tag) this.tag.position.set(0, this.height * 0.5 + 0.28, 0);
    this.feet.position.y = -this.height / 2;
  }

  setGhost(on: boolean) {
    if (on === this.ghost) return;
    this.ghost = on;
    this.applyLook();
  }

  /** Material look: normal, ghost (see-through + blue glow) or faded (see-through: blocking the camera). */
  private applyLook() {
    // (blocking the camera: hidden below — swapping in cloned see-through materials compiled new shaders mid-game:
    //  the hitch every time players bumped into each other in front of someone's camera)
    this.feet.visible = !this.occluding;
    const want = this.ghost ? 'g' : 'n';
    if (want === this.matMode) return;
    const root = this.runtime?.model;
    if (this.ghostMats) {
      for (const [m, mat] of this.ghostMats) {
        const cur = m.material;
        for (const c of Array.isArray(cur) ? cur : [cur]) c.dispose();
        m.material = mat;
      }
      this.ghostMats = null;
    }
    this.matMode = want;
    if (want === 'n' || !root) return;
    const opacity = want === 'g' ? 0.32 : 0.22;
    this.ghostMats = new Map();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.ghostMats!.set(m, m.material);
      const conv = (mat: THREE.Material) => {
        const c = mat.clone(); c.transparent = true; c.opacity = m.userData.isOutline ? 0 : opacity; c.depthWrite = false;
        if (want === 'g') (c as THREE.MeshToonMaterial).emissive?.set?.('#9fd8ff');
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    });
  }

  /** Frame from this PC's studio (self) or the party (network-smoothed). */
  pushFrame(f: TrackingFrame, now: number, ts?: number, seq?: number) { this.frame = f; this.lastFrameAt = now; this.sync.push(f, now, ts, seq); }

  /**
   * Per render. `s` = the interpolated sim sample for this player (centre, rotation, yaw, flags, anim, speed).
   */
  update(dt: number, now: number, s: { p: THREE.Vector3; q: THREE.Quaternion; yaw: number; flags: number; anim: number; speed: number; hold: number }, aspect: number) {
    const rag = (s.flags & F.ragdoll) !== 0 || (s.flags & F.downed) !== 0;
    this.pivot.position.copy(s.p);
    // upright: yaw only; ragdoll: the full tumbling body orientation
    if (rag) this.pivot.quaternion.copy(s.q);
    else this.pivot.quaternion.setFromAxisAngle(Y, s.yaw);
    this.setGhost((s.flags & F.ghost) !== 0);
    this.applyLook();
    if (this.ghost) this.pivot.position.y += Math.sin(now / 400 + this.id.length) * 0.08;
    // flop amount from how fast the body is tumbling
    const dq = 2 * Math.acos(Math.min(1, Math.abs(this.lastQ.dot(s.q))));
    this.lastQ.copy(s.q);
    this.flop.amp = rag ? Math.min(1.4, this.flop.amp * 0.9 + dq / Math.max(1e-3, dt) * 0.08 + 0.2) : Math.max(0, this.flop.amp - dt * 3);
    this.flop.t += dt * (6 + this.flop.amp * 6);
    // gait
    const seated = (s.flags & F.seated) !== 0 || s.anim === ANIM.sit;
    this.seated += ((seated ? 1 : 0) - this.seated) * Math.min(1, dt * 8);
    this.actor.sit = this.seated;
    if (seated) this.actor.updateSeat(SEAT); else this.actor.updateSeat(null);
    const moving = !rag && !seated && s.speed > 0.15;
    const walk = Math.max(0.5, this.height * 1.6);
    const gait = moving ? Math.min(1, s.speed / walk) : 0;
    this.loco.gait += (gait - this.loco.gait) * Math.min(1, dt * 6);
    this.loco.dist += s.speed * dt;
    this.loco.armW = this.carry > 0.5 ? 0 : this.loco.gait;
    this.loco.headW = 0.5 * this.loco.gait;
    this.loco.idle = moving || seated ? 0 : 0.6;
    this.actor.loco = this.loco.gait;
    this.carry += ((s.hold ? 1 : 0) - this.carry) * Math.min(1, dt * 8);
    // clip layer inputs (applied in the pose hook during rt.update below)
    const ai = animIn;
    ai.anim = s.anim; ai.flags = s.flags; ai.speed = s.speed; ai.hold = s.hold; ai.yaw = s.yaw;
    ai.x = s.p.x; ai.y = s.p.y; ai.z = s.p.z; ai.strain = s.hold ? this.strain : 0; ai.talk = this.frame.mouth?.speak ?? 0;
    this.anim.input(ai);
    this.actor.sync();
    this.standIn.update(dt, moving ? s.speed / Math.max(0.3, this.height) : 0, seated, rag, s.hold !== 0);
    // tag: hide in first person and over your own head (the status is for the others: they see it over you)
    if (this.tag) this.tag.visible = !this.firstPerson && !this.isSelf;
    if (this.tv) {
      this.tv.visible = !this.firstPerson;
      const tv = this.tvRt;
      if (tv) {
        // physics drives the clips (PERFORMER_API §2): walk speed in model space, the seat blend, tumbling when ragdolled
        tv.external = { speed: moving ? s.speed / Math.max(0.05, tv.wrapper.scale.x) : 0, sit: this.seated, airborne: rag };
        if (rag && !this.wasRag) tv.react('tumble');
        tv.update(this.frame, null, null, dt);
      }
      this.wasRag = rag;
    }
    const rt = this.runtime;
    if (!rt) return;
    // head: first person hides it (the camera sits inside), big-head mode inflates it
    const want = this.firstPerson ? 0.001 : this.bigHead;
    if (Math.abs(want - this.headScale) > 1e-3) {
      this.headScale += (want - this.headScale) * (this.firstPerson ? 1 : Math.min(1, dt * 4));
      rt.humanoid?.getRawBoneNode('head')?.scale.setScalar(this.headScale);
    }
    const live = now - this.lastFrameAt < 3000;
    const tuning = { ...(rt.profile.tracking ?? tune), translate: [0.2 * (1 - this.loco.gait), 0.15, 0.15] as [number, number, number] };
    const net = this.source.kind === 'party' ? partyView.sample(this.source.memberId, now) : null;
    const steps = net ? [{ frame: net.frame, dt }] : this.sync.steps(now, dt);
    if (!steps.length) steps.push({ frame: this.frame, dt });
    for (const st of steps) {
      const f = st.frame;
      if (live && f.bones && Object.keys(f.bones).length && !rag) rt.update(f, null, tuning, st.dt, aspect, f.bones);
      else rt.update(live ? f : { ...f, tracked: false, life: undefined }, null, tuning, st.dt, aspect);
    }
  }

  /** Carrying: arms reach forward; ragdoll: limbs flail. Runs after the walk cycle, before the rig update. */
  private extraPose(rt: AvatarRuntime, _dt: number) {
    const h = rt.humanoid;
    if (!h) return;
    const N = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    const rest = this.actor.rest;
    if (this.carry > 0.02 && rest?.toNorm && !this.anim.active) {
      // both arms reach forward (avatar space: +X = the avatar's left, +Z = front), measured from the rig's rest pose
      for (const [side, sg] of [['left', 1], ['right', -1]] as const) {
        const ua = N(`${side}UpperArm`), u = rest.joints[`${side}UpperArm`], l = rest.joints[`${side}LowerArm`];
        if (!ua || !u || !l) continue;
        const restN = v1.copy(l).sub(u).normalize().applyQuaternion(rest.toNorm);
        const want = v2.set(sg * 0.22, -0.3, 0.93).normalize().applyQuaternion(rest.toNorm);
        ua.quaternion.slerp(q1.setFromUnitVectors(restN, want), this.carry * 0.9);
        const la = N(`${side}LowerArm`);
        if (la) la.quaternion.slerp(I, this.carry * 0.8);
      }
    }
    if (this.flop.amp > 0.02) {
      const a = this.flop.amp, t = this.flop.t;
      const wob = (b: string, x: number, y: number, z: number, ph: number) => { const n = N(b); if (n) n.quaternion.multiply(q1.setFromEuler(e1.set(Math.sin(t + ph) * x * a, Math.sin(t * 1.3 + ph) * y * a, Math.cos(t * 0.9 + ph) * z * a))); };
      wob('leftUpperArm', 0.9, 0.8, 1.0, 0); wob('rightUpperArm', 0.9, 0.8, 1.0, 2);
      wob('leftLowerArm', 0.6, 0, 0.4, 1); wob('rightLowerArm', 0.6, 0, 0.4, 3);
      wob('leftUpperLeg', 0.8, 0.2, 0.4, 0.5); wob('rightUpperLeg', 0.8, 0.2, 0.4, 2.5);
      wob('leftLowerLeg', 0.9, 0, 0, 1.5); wob('rightLowerLeg', 0.9, 0, 0, 3.5);
      wob('head', 0.4, 0.3, 0.3, 0.7); wob('spine', 0.25, 0.2, 0.2, 1.1);
    }
  }

  /** World position of the eyes (first-person camera). */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    const rt = this.runtime;
    const head = rt?.humanoid?.getRawBoneNode('head');
    if (head && this.headScale >= 0) {
      head.getWorldPosition(out);
      out.y += this.height * 0.03;
      return out;
    }
    return out.copy(this.pivot.position).add(new THREE.Vector3(0, this.height * 0.42, 0));
  }

  dispose() { this.disposed = true; this.gen++; clearTimeout(this.retryTimer); this.clearTv(); this.runtime?.dispose(); this.standIn.dispose(); this.pivot.removeFromParent(); }
}
const Y = new THREE.Vector3(0, 1, 0);
const animIn = { anim: 0, flags: 0, speed: 0, hold: 0, yaw: 0, x: 0, y: 0, z: 0, strain: 0, talk: 0 };
const TV_EMOTE: Record<string, TvReaction> = { wave: 'wave', point: 'point', laugh: 'laugh', cheer: 'clap', dance: 'clap', facepalm: 'shrug', soundbite: 'react_shock', sit: 'shrug' };
const q1 = new THREE.Quaternion(), e1 = new THREE.Euler(), I = new THREE.Quaternion();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

/** Stand-in walking TV (until the tvguests engine provides the real one): a CRT on stubby legs, origin at the feet. */
function standInTv(h: number): THREE.Object3D {
  const g = new THREE.Group();
  const k = h / 1.2;
  const bodyM = new THREE.MeshToonMaterial({ color: '#8a6a4a' });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.7 * k, 0.55 * k, 0.5 * k), bodyM);
  box.position.y = 0.78 * k;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.52 * k, 0.4 * k), new THREE.MeshBasicMaterial({ color: '#3fd0ff' }));
  screen.position.set(0, 0.8 * k, 0.251 * k);
  g.add(box, screen);
  for (const x of [-0.18, 0.18]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * k, 0.04 * k, 0.5 * k), bodyM); leg.position.set(x * k, 0.25 * k, 0); g.add(leg); }
  return g;
}

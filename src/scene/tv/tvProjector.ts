// ProjectorRuntime: a webcam / VTube Studio guest shown on a PULL-DOWN PROJECTOR SCREEN (look 'projector', shared/tv.ts)
// instead of a walking TV — "Space Ghost Coast to Coast" style. Like TvRuntime it stands in for an AvatarRuntime (the
// scene treats it as a performer: its "face" is the picture, so talk / group / tile cameras frame it), but it never
// walks: projectorPlace.ts gives it a synthetic spot under its screen, beside the host.
//
// The rig is the room's own screen skin (src/scene/screenSkins.ts — the studio's motorised projector that unrolls from
// the ceiling, Kingsmarch's scrying mirror, the Helldivers hologram, the Factory's chain hoist …), built around the live
// picture (tvScreen.ts, fx 'projector': chroma key for VTube Studio, fabric grey while off) + a name plate. It drops /
// unrolls when they arrive and powers on once it has landed. Video frames stay in memory (see tvFeeds.ts).
import * as THREE from 'three';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { normalizeProfile } from '../../../shared/defaults.ts';
import { tvSkin, type TvFeedState, type TvInfo, type TvMotion } from '../../../shared/tv.ts';
import type { SceneActor } from '../actor.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { buildSkin, SkinDriver, SURF_Z, type BuiltSkin } from '../screenSkins.ts';
import type { ResolvedSkinSpec } from '../../../shared/screenSkin.ts';
import { TvScreenMaterial } from './tvScreen.ts';
import { plateTexture } from './tvGreybox.ts';
import { PROJ_CY, projSize, slotFor } from './projectorPlace.ts';
import type { TvReaction } from './tvAnim.ts';
import type { PageFeeds } from './tvFeeds.ts';

const STUDIO: ResolvedSkinSpec = { theme: 'studio', motion: 'unroll', powerOn: 'crt', node: null, source: 'default', warnings: [] };
const scaleLocked = new WeakSet<SceneActor>();

export class ProjectorRuntime {
  readonly isTv = true;
  readonly look = 'projector' as const;
  readonly wrapper = new THREE.Group();
  readonly model = new THREE.Group();
  readonly humanoid = null;
  readonly vrm = null;
  readonly fx = null;
  poseHook: ((rt: never, dt: number) => void) | null = null;
  profile: AvatarProfile;
  readonly screen: THREE.Mesh;
  readonly screenMat: TvScreenMaterial;
  readonly body: { w: number; h: number; d: number; cy: number };
  feedState: TvFeedState = 'none';
  level = 0;
  speaking = false;
  external: { speed?: number; sit?: number; airborne?: boolean } | null = null;
  motion: TvMotion = 'calm';
  actorOf: () => SceneActor | null = () => null;
  sceneOf: () => SceneRuntime | null = () => null;
  readonly info = { rig: 'none' as const, meshes: 1, triangles: 2, bones: 0, expressions: [] as never[], proceduralEyes: false, proceduralMouth: false, springJoints: 0, warnings: [] as string[] };
  readonly W: number; readonly H: number;

  private holder = new THREE.Group();
  private skin: BuiltSkin | null = null;
  private drive: SkinDriver | null = null;
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private rigSig = '';
  private plate: THREE.Mesh;
  private time = 0;
  private speakFor = 0;
  private sway = { t: 99, k: 0 };
  private lastState: TvFeedState = 'none';

  constructor(readonly feedId: string, public tv: TvInfo, readonly anchor: THREE.Object3D, private feeds: PageFeeds, name: string) {
    const { W, H } = projSize(tv.aspect);
    this.W = W; this.H = H;
    this.profile = normalizeProfile({ id: `tv-${feedId}`, name, modelFile: 'projector' } as never);
    this.screenMat = new TvScreenMaterial(tv, W / H, 'projector');
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.screenMat.material);
    this.screen.name = 'TV_SCREEN';
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(0.5, W * 0.4), Math.min(0.5, W * 0.4) * 0.1875), new THREE.MeshBasicMaterial({ map: plateTexture(name, tvSkin(tv.skin).accent), toneMapped: false, transparent: true }));
    this.plate.name = 'TV_NAME_PLATE';
    this.body = { w: W, h: PROJ_CY + H / 2, d: 0.1, cy: PROJ_CY };
    this.holder.position.set(0, PROJ_CY, 0);
    this.model.add(this.holder);
    this.model.name = 'vtp:projectorGuest';
    this.wrapper.name = `projector:${feedId}`;
    this.wrapper.add(this.model);
    anchor.add(this.wrapper);
    this.build(STUDIO, null, 1.3, -PROJ_CY);
  }

  /** (Re)build the rig in the room's skin (the projector keeps its picture + plate). */
  private build(spec: ResolvedSkinSpec, template: THREE.Object3D | null, ceilLocal: number, floorLocal: number | null) {
    const was = this.drive ? { a: this.drive.a, arrived: this.drive.arrived } : null;
    if (this.skin) { this.skin.root.removeFromParent(); for (const o of this.owned) o.dispose(); this.owned = []; }
    this.screen.removeFromParent(); this.plate.removeFromParent();
    this.screen.position.set(0, 0, SURF_Z); this.screen.rotation.set(0, 0, 0); this.screen.scale.set(1, 1, 1);
    this.skin = buildSkin(spec, { prop: 'solo', W: this.W, H: this.H, ceilLocal, floorLocal, surface: this.screen, own: (x) => { this.owned.push(x); return x; }, template });
    this.holder.add(this.skin.root);
    this.drive = new SkinDriver(this.skin, spec.motion, ceilLocal, floorLocal);
    if (was?.arrived) this.drive.finish(true);
    // the name plate hangs on the moving part, under the picture
    const par = this.screen.parent ?? this.skin.moving;
    this.plate.position.copy(this.screen.position).add(new THREE.Vector3(0, -this.H / 2 - 0.075, 0.02));
    par.add(this.plate);
    this.skin.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = m !== this.screen; } });
    this.drive.apply(0, 0);
  }

  setName(name: string) {
    this.profile.name = name;
    const m = this.plate.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.map = plateTexture(name, tvSkin(this.tv.skin).accent);
    m.needsUpdate = true;
  }
  setInfo(tv: TvInfo) { this.tv = tv; this.screenMat.setInfo(tv, 'projector'); }

  /** Reactions: the screen sways a little on its cables (no body to animate). */
  react(name: TvReaction): boolean {
    if (name === 'static_glitch') return true;
    this.sway = { t: 0, k: name === 'react_shock' || name === 'tumble' ? 1 : 0.6 };
    return true;
  }

  update(_frame: TrackingFrame, _body: unknown, _tune: unknown, dt: number) {
    this.time += dt;
    const a = this.actorOf();
    const rt = this.sceneOf();
    // ---- scale 1 always (the picture has a real size; the room's performer normalisation doesn't apply) and the
    //      runtime's pop-in scale is replaced by the rig's own drop / unroll
    if (a && !scaleLocked.has(a)) {
      scaleLocked.add(a);
      const orig = a.setHeight.bind(a);
      a.setHeight = () => orig(a.rest?.height ?? this.body.h);
      a.setHeight(0);
    }
    const k = a ? (a.scale || 1) * Math.max(1e-3, a.appear) : 1;
    this.wrapper.scale.setScalar(1 / k);
    // ---- the rig in this room's skin, hanging from this room's ceiling above the planned spot
    const slot = rt && a ? slotFor(rt, a.key) : null;
    const sig = rt && slot ? `${rt.info.id}|${slot.ceilingY?.toFixed(2)}|${slot.floorY.toFixed(2)}` : 'classic';
    if (sig !== this.rigSig) {
      this.rigSig = sig;
      if (rt && slot) {
        const choice = rt.skins.solo;
        const ceil = slot.ceilingY !== null ? slot.ceilingY - slot.center.y : 1.3;
        this.build(choice?.spec ?? STUDIO, choice?.template ?? null, Math.max(this.H / 2 + 0.35, ceil), slot.floorY - slot.center.y);
      } else this.build(STUDIO, null, 1.3, -PROJ_CY);
    }
    // ---- the feed + voice
    const f = this.feeds.get(this.feedId);
    f?.poll();
    const state: TvFeedState = f ? f.state : 'none';
    this.screenMat.setMap(f?.ready ? f.texture : null, f?.aspect ?? null, f?.size);
    if (this.lastState === 'live' && (state === 'stalled' || state === 'lost')) this.react('static_glitch');
    this.lastState = state;
    this.feedState = state;
    this.level = this.feeds.level(this.feedId);
    const lively = this.motion === 'lively';
    const loud = this.level > (lively ? 0.18 : 0.26);
    this.speakFor = loud ? this.speakFor + dt : 0;
    this.speaking = loud && (lively || this.speakFor > 0.25);
    // ---- drop / unroll when they are in the room, power on once landed
    const want = a ? a.shown : true;
    const d = this.drive!;
    d.step(dt, want, true);
    const on = d.landed;
    this.screenMat.step(dt, this.time, state, on);
    d.apply(this.time, on ? 1 : 0);
    (this.plate.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp((d.tau - 0.2) / 0.4, 0, 1) * (d.arrived ? 1 : 0);
    // ---- a gentle sway on reactions / while speaking (lively only)
    this.sway.t += dt;
    const sw = this.sway.t < 2 ? this.sway.k * 0.03 * Math.sin(this.sway.t * 6) * Math.exp(-2.2 * this.sway.t) : 0;
    this.holder.rotation.z = sw + (lively && this.speaking ? 0.004 * Math.sin(this.time * 3) : 0);
    this.poseHook?.(this as never, dt);
    this.wrapper.updateMatrixWorld(true);
  }

  /** The screen as a performer: floor → top of the picture (+ a little), the picture's width. */
  bounds() {
    this.model.updateWorldMatrix(true, false);
    return new THREE.Box3(new THREE.Vector3(-this.W / 2, 0, -0.1), new THREE.Vector3(this.W / 2, PROJ_CY + this.H / 2 + 0.08, 0.1)).applyMatrix4(this.model.matrixWorld);
  }
  /** The picture is the face (cameras frame it) — on the guest's real face when the sender tracks it (TvInfo.face). */
  faceInfo(): { center: THREE.Vector3; size: number } {
    this.model.updateWorldMatrix(true, false);
    const f = this.screenMat.faceOnScreen();
    if (f) {
      // (the face as drawn, kept on the picture; its size never below the old fixed share, so the shot stays as wide)
      const u = Math.min(0.85, Math.max(0.15, f.u)), v = Math.min(0.85, Math.max(0.15, f.v));
      return { center: new THREE.Vector3((u - 0.5) * this.W, PROJ_CY + (v - 0.5) * this.H, 0).applyMatrix4(this.model.matrixWorld), size: Math.max(this.H * 0.36, Math.min(this.H, f.h * this.H * 1.4)) };
    }
    return { center: new THREE.Vector3(0, PROJ_CY, 0).applyMatrix4(this.model.matrixWorld), size: this.H * 0.36 };
  }
  setResting(_on: boolean) { /* no body */ }
  pick() { return null; }
  toWorld(p: [number, number, number]) { return new THREE.Vector3(...p).applyMatrix4(this.model.matrixWorld); }

  dispose() {
    this.wrapper.removeFromParent();
    for (const o of this.owned) o.dispose();
    this.screen.geometry.dispose();
    this.screenMat.dispose();
    const pm = this.plate.material as THREE.MeshBasicMaterial;
    pm.map?.dispose(); pm.dispose(); this.plate.geometry.dispose();
  }
}

export const isProjectorRuntime = (rt: unknown): rt is ProjectorRuntime => !!rt && (rt as { look?: string }).look === 'projector';

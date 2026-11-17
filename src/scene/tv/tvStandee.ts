// StandeeRuntime: a Spout2 performer (VSeeFace, VTube Studio, Warudo … with a transparent background, shared/spout.ts)
// whose MODEL stands in the room — look 'standee' (shared/tv.ts). No TV body, no backdrop: the picture's alpha is the
// silhouette, drawn as a cut-out that always turns to face the camera being rendered (a cylindrical billboard: upright,
// feet on the floor), with a soft contact shadow under it. Like TvRuntime / ProjectorRuntime it stands in for an
// AvatarRuntime (anchor, model, wrapper, profile.size, bounds, faceInfo, update, dispose), so walks, spots, seats, the
// shot solver and the tile cameras treat it as a leg-less performer; the scene scales it so its picture height is the
// performer's height (TvInfo.height). The alpha comes from a packed frame (real alpha) or the chroma key (a webcam
// bridge) — tvScreen.ts fx 'standee'. Video frames stay in memory (tvFeeds.ts).
import * as THREE from 'three';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { normalizeProfile } from '../../../shared/defaults.ts';
import type { TvFeedState, TvInfo, TvMotion } from '../../../shared/tv.ts';
import type { SceneActor } from '../actor.ts';
import { TvScreenMaterial } from './tvScreen.ts';
import type { TvReaction } from './tvAnim.ts';
import type { PageFeeds } from './tvFeeds.ts';

let blobTex: THREE.CanvasTexture | null = null;
/** Soft round contact shadow (shared by every standee). */
function blob(): THREE.CanvasTexture {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,0.55)'); r.addColorStop(0.55, 'rgba(0,0,0,0.25)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

const Y = new THREE.Vector3(0, 1, 0);

export class StandeeRuntime {
  readonly isTv = true;
  readonly look = 'standee' as const;
  readonly wrapper = new THREE.Group();
  readonly model = new THREE.Group();
  readonly humanoid = null;
  readonly vrm = null;
  readonly fx = null;
  poseHook: ((rt: never, dt: number) => void) | null = null;
  profile: AvatarProfile;
  /** The cut-out (unit height; the scene's scale makes it the performer's height). */
  readonly screen: THREE.Mesh;
  readonly screenMat: TvScreenMaterial;
  readonly body: { w: number; h: number; d: number; cy: number };
  feedState: TvFeedState = 'none';
  level = 0;
  speaking = false;
  external: { speed?: number; sit?: number; airborne?: boolean } | null = null;
  motion: TvMotion = 'calm';
  actorOf: () => SceneActor | null = () => null;
  readonly info = { rig: 'none' as const, meshes: 2, triangles: 4, bones: 0, expressions: [] as never[], proceduralEyes: false, proceduralMouth: false, springJoints: 0, warnings: [] as string[] };

  private shadow: THREE.Mesh;
  private time = 0;
  private speakFor = 0;
  private lastState: TvFeedState = 'none';
  private aspect: number;
  // billboard scratch
  private pos = new THREE.Vector3(); private quat = new THREE.Quaternion(); private scl = new THREE.Vector3();
  private cam = new THREE.Vector3(); private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private s = new THREE.Vector3();

  constructor(readonly feedId: string, public tv: TvInfo, readonly anchor: THREE.Object3D, private feeds: PageFeeds, name: string) {
    this.aspect = Math.min(3, Math.max(0.2, tv.aspect || 0.6));
    this.profile = normalizeProfile({ id: `tv-${feedId}`, name, modelFile: 'standee', size: { height: tv.height } } as never);
    this.screenMat = new TvScreenMaterial(tv, this.aspect, 'standee');
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);                        // feet at the origin
    this.screen = new THREE.Mesh(geo, this.screenMat.material);
    this.screen.name = 'TV_SCREEN';
    this.screen.frustumCulled = false;               // (the billboard moves it after culling)
    this.screen.renderOrder = 2;
    this.screen.onBeforeRender = (_r, _s, camera) => this.face(camera);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blob(), transparent: true, depthWrite: false, toneMapped: false }));
    this.shadow.name = 'standee_shadow';
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.004;
    this.shadow.renderOrder = 1;
    this.model.add(this.shadow, this.screen);
    this.model.name = 'vtp:standee';
    this.body = { w: this.aspect, h: 1, d: 0.15, cy: 0.5 };
    this.wrapper.name = `standee:${feedId}`;
    this.wrapper.add(this.model);
    anchor.add(this.wrapper);
    this.fit();
  }

  /** Width follows the picture's aspect (the sender's auto-framing changes it rarely); the shadow follows the width. */
  private fit() {
    this.screen.scale.set(this.aspect, 1, 1);
    this.shadow.scale.set(Math.min(1.2, this.aspect * 0.7), Math.min(0.5, this.aspect * 0.3), 1);
  }

  /** Cylindrical billboard: stay upright on the model's spot, turn to face THIS camera (every camera: OBS, tiles, the
   *  preview). Called by three.js right before the draw, after the world matrices are up to date. */
  private face(camera: THREE.Camera) {
    this.model.matrixWorld.decompose(this.pos, this.quat, this.scl);
    camera.getWorldPosition(this.cam);
    const yaw = Math.atan2(this.cam.x - this.pos.x, this.cam.z - this.pos.z);
    this.q.setFromAxisAngle(Y, yaw);
    const k = this.scl.y;
    this.m.compose(this.pos, this.q, this.s.set(k * this.aspect, k, k));
    this.screen.matrixWorld.copy(this.m);
  }

  setName(name: string) { this.profile.name = name; }
  setInfo(tv: TvInfo) { this.tv = tv; this.screenMat.setInfo(tv, 'standee'); }

  /** The model animates itself in its own app: reactions are nothing to play here (true = handled). */
  react(_name: TvReaction): boolean { return true; }

  update(_frame: TrackingFrame, _body: unknown, _tune: unknown, dt: number) {
    this.time += dt;
    const a = this.actorOf();
    const f = this.feeds.get(this.feedId);
    f?.poll();
    const state: TvFeedState = f ? f.state : 'none';
    this.screenMat.setMap(f?.ready ? f.texture : null, f?.aspect ?? null, f?.size);
    const asp = this.screenMat.feedAspect;
    if (f?.ready && Number.isFinite(asp) && Math.abs(asp - this.aspect) > 0.004) { this.aspect = Math.min(3, Math.max(0.2, asp)); this.fit(); }
    this.lastState = state;
    this.feedState = state;
    this.screenMat.step(dt, this.time, state, a ? a.shown : true);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.min(1, this.screenMat.material.uniforms.uPower.value as number) * (1 - (this.screenMat.material.uniforms.uLost.value as number));
    this.level = this.feeds.level(this.feedId);
    const loud = this.level > (this.motion === 'lively' ? 0.18 : 0.26);
    this.speakFor = loud ? this.speakFor + dt : 0;
    this.speaking = loud && (this.motion === 'lively' || this.speakFor > 0.25);
    this.poseHook?.(this as never, dt);
    // a cut-out never hops on the walk mover (the model in the picture does its own walking / idling)
    if (a && a.loco > 0.01) { a.offset.y = 0; a.tilt.identity(); }
    this.wrapper.updateMatrixWorld(true);
  }

  /** Floor → top of the picture, the picture's width (unit height: the scene scales it to the performer's height). */
  bounds() {
    this.model.updateWorldMatrix(true, false);
    return new THREE.Box3(new THREE.Vector3(-this.aspect / 2, 0, -0.08), new THREE.Vector3(this.aspect / 2, 1, 0.08)).applyMatrix4(this.model.matrixWorld);
  }
  /** Face ≈ the top of the model (auto-framed: the head is near the picture's top edge). */
  faceInfo(): { center: THREE.Vector3; size: number } {
    this.model.updateWorldMatrix(true, false);
    const k = this.model.matrixWorld.getMaxScaleOnAxis();
    return { center: new THREE.Vector3(0, 0.87, 0).applyMatrix4(this.model.matrixWorld), size: 0.17 * k };
  }
  setResting(_on: boolean) { /* no body */ }
  pick() { return null; }
  toWorld(p: [number, number, number]) { return new THREE.Vector3(...p).applyMatrix4(this.model.matrixWorld); }

  dispose() {
    this.wrapper.removeFromParent();
    this.screen.geometry.dispose();
    this.screenMat.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}

export const isStandeeRuntime = (rt: unknown): rt is StandeeRuntime => !!rt && (rt as { look?: string }).look === 'standee';

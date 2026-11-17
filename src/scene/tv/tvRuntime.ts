// TvRuntime: a TV performer on an OBS page / the Scene preview. It stands in for an AvatarRuntime — it implements the
// part the scene uses (anchor, model, wrapper, profile.size, humanoid === null, poseHook, update, bounds, faceInfo,
// dispose) — so SceneActor, the walk mover, seats, size spots, the shot solver and tile cameras treat it like any
// leg-less performer. What it adds (S\tv\PERFORMER_API.md): the live video on the TV_SCREEN (tvScreen.ts), walk / sit /
// talk / reaction animation driven from the actor's state and the feed's voice level (tvAnim.ts), feed health (LED,
// bad-signal look, NO SIGNAL), `external` driving for physics games, and the screen as the "face" for every camera.
//
// Body: the tvart GLB when installed (assets/builtin/tv_performer/tv_profile.json → skins/<id>.glb, named clips), else the
// engine's grey-box (tvGreybox.ts). Video frames stay in memory (the page's <video> + GPU texture), never stored.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { normalizeProfile } from '../../../shared/defaults.ts';
import { tvSkin, type TvFeedState, type TvInfo, type TvMotion } from '../../../shared/tv.ts';
import type { SceneActor } from '../actor.ts';
import { TvScreenMaterial } from './tvScreen.ts';
import { ProceduralTvAnimator, buildGreybox, plateTexture } from './tvGreybox.ts';
import { ClipTvAnimator, SHOT_LEN, TV_REACTIONS, type TvAnimator, type TvPoseState, type TvReaction } from './tvAnim.ts';
import type { PageFeeds } from './tvFeeds.ts';

/** tvart asset manifest (S	v\CONTRACT.md, assets/builtin/tv_performer/tv_profile.json). Deliberately NOT profile.json:
 *  that would list the folder as an avatar in everyone's library. */
interface TvManifestSkin { id: string; name?: string; file: string; screenAspect?: number; size?: { height?: number }; walkSpeed?: number; runSpeed?: number; seatHeight?: number; sitApproach?: number }
interface TvManifest { skins: TvManifestSkin[] }
const ASSET = '/library/tv_performer/';
let manifest: Promise<TvManifest | null> | null = null;
const gltfs = new Map<string, Promise<GLTF | null>>();
function loadManifest(): Promise<TvManifest | null> {
  return (manifest ??= fetch(`${ASSET}tv_profile.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() as Promise<TvManifest> : null)).then((m) => (m && Array.isArray(m.skins) ? m : null)).catch(() => null));
}
/** Does the screen mesh's v run DOWN the picture (glTF convention) / u run leftwards? (the shader flips to match) */
function screenFlip(mesh: THREE.Mesh): { u: boolean; v: boolean } {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv;
  if (!pos || !uv) return { u: false, v: false };
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld, p = new THREE.Vector3();
  let cu = 0, cv = 0, mx = 0, my = 0, mu = 0, mv = 0;
  const n = pos.count, P: [number, number][] = [];
  for (let i = 0; i < n; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m); P.push([p.x, p.y]); mx += p.x; my += p.y; mu += uv.getX(i); mv += uv.getY(i); }
  mx /= n; my /= n; mu /= n; mv /= n;
  for (let i = 0; i < n; i++) { cu += (uv.getX(i) - mu) * (P[i][0] - mx); cv += (uv.getY(i) - mv) * (P[i][1] - my); }
  // (rest pose, the set faces +Z: +X is the viewer's right, +Y up)
  return { u: cu < 0, v: cv < 0 };
}
function loadSkin(file: string): Promise<GLTF | null> {
  let p = gltfs.get(file);
  if (!p) { p = new GLTFLoader().loadAsync(ASSET + file.split('/').map(encodeURIComponent).join('/')).catch((e) => { console.warn('tv: skin failed, using the grey-box', file, e); return null; }); gltfs.set(file, p); }
  return p;
}

export interface TvExternal { speed?: number; sit?: number; airborne?: boolean }

export class TvRuntime {
  readonly isTv = true;
  readonly wrapper = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly humanoid = null;
  readonly vrm = null;
  readonly fx = null;
  poseHook: ((rt: never, dt: number) => void) | null = null;
  profile: AvatarProfile;
  readonly screen: THREE.Mesh;
  readonly screenMat: TvScreenMaterial;
  /** Collider box of the set (avatar space, before the actor's scale): width, height, depth, centre height. */
  readonly body: { w: number; h: number; d: number; cy: number };
  feedState: TvFeedState = 'none';
  level = 0;
  speaking = false;
  /** Physics games drive the clips themselves (PERFORMER_API.md §2). */
  external: TvExternal | null = null;
  /** 'calm' (default: subtle idle, gestures only on real speech) or 'lively' — the member's choice or the host's override. */
  motion: TvMotion = 'calm';
  readonly look: 'tv' | 'projector' = 'tv';
  private speakFor = 0;
  /** Set by the page: the scene actor holding this runtime (walk speed, seat blend, presence). */
  actorOf: () => SceneActor | null = () => null;
  readonly info = { rig: 'none' as const, meshes: 0, triangles: 0, bones: 0, expressions: [] as never[], proceduralEyes: false, proceduralMouth: false, springJoints: 0, warnings: [] as string[] };

  private anim: TvAnimator;
  private led: THREE.Mesh | null;
  private time = 0;
  private talk = 0;
  private shot: { name: TvReaction; t: number; len: number } | null = null;
  private lastPos = new THREE.Vector3(NaN, 0, 0);
  private speed = 0; private stride = 0;
  private lastSit = 0;
  private wasShown = false; private arrived = false; private walked = 0;
  private silentFor = 0;
  private lastState: TvFeedState = 'none';
  private disposables: { dispose(): void }[] = [];

  private constructor(readonly feedId: string, public tv: TvInfo, readonly anchor: THREE.Object3D, private feeds: PageFeeds, build: { model: THREE.Object3D; screen: THREE.Mesh; anim: TvAnimator; led: THREE.Mesh | null; screenAspect: number; body: TvRuntime['body'] }, name: string) {
    this.model = build.model;
    this.screen = build.screen;
    this.anim = build.anim;
    this.led = build.led;
    this.body = build.body;
    this.profile = normalizeProfile({ id: `tv-${feedId}`, name, modelFile: 'tv', size: { height: tv.height } } as never);
    this.screenMat = new TvScreenMaterial(tv, build.screenAspect, 'tv');
    this.screen.material = this.screenMat.material;
    this.wrapper.name = `tv:${feedId}`;
    this.wrapper.add(this.model);
    anchor.add(this.wrapper);
    let tris = 0, meshes = 0;
    this.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { meshes++; const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    this.info.meshes = meshes; this.info.triangles = Math.round(tris);
  }

  /** Build a TV performer (tvart GLB skin when installed, else the grey-box) under `anchor`. */
  static async load(o: { feedId: string; name: string; tv: TvInfo; anchor: THREE.Object3D; feeds: PageFeeds }): Promise<TvRuntime> {
    const skin = tvSkin(o.tv.skin);
    const man = await loadManifest();
    const entry = man?.skins.find((s) => s.id === skin.id) ?? man?.skins[0];
    const gltf = entry ? await loadSkin(entry.file) : null;
    if (gltf && entry) {
      const model = cloneSkinned(gltf.scene);
      let screen: THREE.Mesh | null = null, led: THREE.Mesh | null = null, tag: THREE.Object3D | null = null;
      // (Blender may append .001 to names when several skins are built in one session; three.js drops the dot)
      const is = (x: THREE.Object3D, n: string) => x.name === n || new RegExp(`^${n}\\.?\\d{3}$`).test(x.name);
      model.traverse((x) => {
        if (is(x, 'TV_SCREEN') && (x as THREE.Mesh).isMesh) screen = x as THREE.Mesh;
        if (is(x, 'TV_LED') && (x as THREE.Mesh).isMesh) led = x as THREE.Mesh;
        if (is(x, 'TV_NAME')) tag = x;
        if ((x as THREE.Mesh).isMesh) { x.castShadow = true; x.receiveShadow = true; (x as THREE.Mesh).frustumCulled = false; }
      });
      if (screen) {
        const scr = screen as THREE.Mesh;
        const aspect = Number(scr.userData?.aspect) || entry.screenAspect || skin.screenAspect;
        const anim = new ClipTvAnimator(model, gltf.animations, entry.walkSpeed ?? 0.85, entry.runSpeed ?? 2.0);
        if (led) (led as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: 0x33ff66, toneMapped: false });
        const rt = new TvRuntime(o.feedId, o.tv, o.anchor, o.feeds, { model, screen: scr, anim, led, screenAspect: aspect, body: { w: 0, h: 0, d: 0, cy: 0 } }, o.name);
        rt.shared = true;          // geometry / materials belong to the cached GLB (shared by every TV of this skin)
        rt.clipSit = { seat: entry.seatHeight ?? 0.45, approach: entry.sitApproach ?? 0.34 };
        const fl = screenFlip(scr);
        rt.screenMat.setFlip(fl.u, fl.v);
        // name plate on the TV_NAME anchor (the asset's name tag spot)
        if (tag) {
          const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.0375), new THREE.MeshBasicMaterial({ map: plateTexture(o.name, skin.accent), toneMapped: false }));
          plate.name = 'TV_NAME_PLATE';
          (tag as THREE.Object3D).add(plate);
          rt.plate = plate;
        }
        const b = rt.bounds(), sz = b.getSize(new THREE.Vector3());
        Object.assign(rt.body, { w: sz.x, h: sz.y, d: sz.z, cy: (b.min.y + b.max.y) / 2 });
        return rt;
      }
      console.warn('tv: skin has no TV_SCREEN mesh — using the grey-box');
    }
    const rig = buildGreybox(skin, o.name);
    const rt = new TvRuntime(o.feedId, o.tv, o.anchor, o.feeds, {
      model: rig.root, screen: rig.screen, anim: new ProceduralTvAnimator(rig), led: rig.led, screenAspect: rig.screenAspect,
      body: { w: rig.dims.w, h: rig.dims.h, d: rig.dims.d, cy: rig.dims.hipY + rig.dims.h / 2 },
    }, o.name);
    rt.plate = rig.plate;
    return rt;
  }

  private plate: THREE.Mesh | null = null;
  private shared = false;
  /** GLB clips carry the seat: root = the spot origin on the floor (the engine's own seat lift is undone). */
  private clipSit: { seat: number; approach: number } | null = null;
  /** Name on the set's plate (grey-box) — the display name the party knows them by. */
  setName(name: string) {
    this.profile.name = name;
    if (!this.plate) return;
    const m = this.plate.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.map = plateTexture(name, tvSkin(this.tv.skin).accent);
    m.needsUpdate = true;
  }
  /** New TvInfo (mirror / chroma / backdrop changed live). A new skin or height needs a reload (the page does that). */
  setInfo(tv: TvInfo) { this.tv = tv; this.screenMat.setInfo(tv); }

  /** Play a reaction clip (one-shot, blended over the base pose). */
  react(name: TvReaction): boolean {
    if (!TV_REACTIONS.includes(name)) return false;
    const len = Math.max(SHOT_LEN[name], (this.anim as ClipTvAnimator).clipLength?.(name) ?? 0);
    this.shot = { name, t: 0, len };
    return true;
  }

  // ---------------------------------------------------------------- per frame (the page calls update like any avatar)
  update(_frame: TrackingFrame, _body: unknown, _tune: unknown, dt: number, _aspect?: number, _bones?: unknown) {
    this.time += dt;
    const a = this.actorOf();
    // --- the feed (poll covers hidden pages whose requestVideoFrameCallback is paused)
    const f = this.feeds.get(this.feedId);
    f?.poll();
    const state: TvFeedState = f ? f.state : 'none';
    if (f?.ready) this.screenMat.setMap(f.texture, f.aspect, f.size);
    else this.screenMat.setMap(null, null);
    if ((this.lastState === 'live') && (state === 'stalled' || state === 'lost') && !this.shot) this.react('static_glitch');
    this.lastState = state;
    this.feedState = state;
    this.screenMat.step(dt, this.time, state);
    if (this.led) (this.led.material as THREE.MeshBasicMaterial).color.setHex(state === 'live' ? 0x33ff66 : state === 'stalled' ? 0xffb020 : state === 'connecting' ? 0x3388ff : 0xff3030);
    // --- voice → talk (gated, fast in, slow out)
    this.level = this.feeds.level(this.feedId);
    const lively = this.motion === 'lively';
    // calm: gestures only on REAL speech (loud enough, for a quarter second) — not on breaths, clicks or keyboard noise
    const loud = this.level > (lively ? 0.18 : 0.26);
    this.speakFor = loud ? this.speakFor + dt : 0;
    this.speaking = loud && (lively || this.speakFor > 0.25);
    const want = this.speaking ? Math.min(1, (this.level - 0.12) / 0.45) : 0;
    this.talk += (want - this.talk) * Math.min(1, dt * (want > this.talk ? 10 : 3));
    this.silentFor = this.speaking ? 0 : this.silentFor + dt;
    // --- movement: the actor's mount (the mover walks it) or the game's `external`
    const ext = this.external;
    const pos = (a?.mount ?? this.wrapper).getWorldPosition(new THREE.Vector3());
    let sp = 0;
    if (Number.isFinite(this.lastPos.x) && dt > 0) { const step = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z); sp = step > 0.8 ? 0 : step / dt; }
    this.lastPos.copy(pos);
    if (ext?.speed !== undefined) sp = ext.speed;
    const k = a?.scale || 1;
    sp = Math.min(6, sp / k);                                           // model-space metres / s
    this.speed += (sp - this.speed) * Math.min(1, dt * 8);
    // walking amount: the mover's own gait (reliable: snaps / teleports never look like a sprint), else the game's speed
    const gait = ext?.speed !== undefined || !a ? Math.min(1, this.speed / 0.35) : a.loco;
    this.stride += (this.speed * dt) / 0.42;
    const sit = ext?.sit ?? a?.sit ?? 0;
    const sitDir: -1 | 0 | 1 = sit > this.lastSit + 1e-4 ? 1 : sit < this.lastSit - 1e-4 ? -1 : 0;
    this.lastSit = sit;
    // --- automatic reactions: hop in through the door, wave when arrived
    const shown = a ? a.shown : true;
    if (shown && !this.wasShown) { this.arrived = false; this.walked = 0; if (a && lively) this.react('enter_hop'); }
    this.wasShown = shown;
    if (gait > 0.3) this.walked += dt;
    if (!this.arrived && this.walked > 1 && gait < 0.05 && (sit < 0.02 || sit > 0.98)) { this.arrived = true; if (!this.shot) this.react('wave'); }
    // --- one-shot timeline
    let shot: TvPoseState['shot'] = null;
    if (this.shot) {
      this.shot.t += dt;
      const s = this.shot;
      if (s.t >= s.len) this.shot = null;
      else shot = { name: s.name, t: s.t, w: Math.min(1, s.t / 0.2, (s.len - s.t) / 0.3) };
    }
    const st: TvPoseState = { gait, stride: this.stride, run: this.speed > 1.6, speed: this.speed, sit, sitDir, talk: this.talk, bored: lively && this.silentFor > 25 && Math.sin(this.time * 0.2) > 0.3, airborne: !!ext?.airborne, shot, lively };
    // --- the scene's pose layers (seat = no-op without legs; the walk mover's hop) — then undo the hop: we walk on legs
    this.poseHook?.(this as never, dt);
    if (a && a.loco > 0.01) { a.offset.y = 0; a.tilt.identity(); }
    // GLB clips carry the seat themselves (root = spot origin on the floor, the clip lifts the set onto a 0.45 m seat):
    // undo the engine's leg-less seat lift / push-back, fit the clip to this seat's height, and hide the clip's own
    // hop-back (sitApproach) while the mover walks the last bit backwards.
    this.model.position.set(0, 0, 0);
    if (this.clipSit && a && sit > 0) {
      const k = a.scale || 1, seat = a.spot?.seatHeight ?? this.clipSit.seat;
      const A = a as unknown as { seatY: number; seatZ: number };
      const y = ((seat - this.clipSit.seat * k) - (A.seatY ?? 0)) * sit / k;
      let z = -(A.seatZ ?? 0) * sit / k;
      if (sit < 0.98) z -= this.clipSit.approach * (1 - sit);
      this.model.position.set(0, y, z);
    }
    this.anim.update(dt, st);
    this.wrapper.updateMatrixWorld(true);
  }

  /** The set + legs, WITHOUT the antennas (the scene normalises performers by this height: antennas must not shrink
   *  the TV, and cameras frame the body). */
  bounds() {
    const box = new THREE.Box3(), tmp = new THREE.Box3();
    this.model.updateWorldMatrix(true, true);
    const walk = (o: THREE.Object3D) => {
      if (/^TV_ANTENNA/.test(o.name)) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        box.union(tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld));
      }
      for (const c of o.children) walk(c);
    };
    walk(this.model);
    return box.isEmpty() ? new THREE.Box3().setFromObject(this.model) : box;
  }
  /** The SCREEN is the face (cameras frame it; size ≈ the picture height). */
  faceInfo(): { center: THREE.Vector3; size: number } {
    this.screen.updateWorldMatrix(true, false);
    const g = this.screen.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!.clone().applyMatrix4(this.screen.matrixWorld);
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    return { center: c, size: Math.max(s.y, 0.02) * 0.95 };
  }
  setResting(_on: boolean) { /* no tracked body */ }
  pick() { return null; }
  toWorld(p: [number, number, number]) { return new THREE.Vector3(...p).applyMatrix4(this.model.matrixWorld); }

  own<T extends { dispose(): void }>(d: T): T { this.disposables.push(d); return d; }
  dispose() {
    this.anim.dispose();
    this.screenMat.dispose();
    this.wrapper.removeFromParent();
    if (!this.shared) this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (mat === this.screenMat.material) continue;
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    for (const d of this.disposables) d.dispose();
  }
}

export const isTvRuntime = (rt: unknown): rt is TvRuntime => !!rt && (rt as { isTv?: boolean }).isTv === true;

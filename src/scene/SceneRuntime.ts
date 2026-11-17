// SceneRuntime: renders a 3D room (docs/SCENES.md) with every performer placed at their spot, the
// talk / react modes, camera presets + automatic framing with smooth moves, the react screen (a
// transparent hole in OBS), and the hooks for entrances (AvatarMover) and lights (SceneLights).
//
// Used by the OBS output page (src/output.ts) and the studio's Scene-tab preview (output.html?preview=1).
// It never loads avatars itself: the page hands it each performer's anchor + AvatarRuntime (syncActors).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { disposeRoomTree, disposeSkeletons } from '../avatar/gpuDispose.ts';
import { readBodyBytes } from './bodyBytes.ts';
import type { SceneInfo, SceneState, TrackingTuning } from '../../shared/types.ts';
import { HOST_KEY, MAX_SPOTS, sanitizeScreen } from '../../shared/scene.ts';
import { avatarSize, shownHeight } from '../../shared/avatarSize.ts';
import { applySpotSizes, deriveSizeSpots, jsonSizeSpots, measureClearance, type SizeSpotResult } from './sizeSpots.ts';
import type { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import type { Stage } from '../stage/Stage.ts';
import type { QualityTier } from '../tracking/Tracker.ts';
import { SceneActor, restTopAbove } from './actor.ts';
import { staticRaysOf } from './mechNav.ts';
import type { SeatEnv, SeatSurface } from './sizeSeat.ts';
import { CameraRig, lookPose, type CamPose } from './cameraRig.ts';
import { livePresets, parseRoom, refreshLivePreset, spotByIndex, type CameraPreset, type RoomInfo, type SpotInfo } from './contract.ts';
import { createLights, type SceneLights } from './lights.ts';
import { createMover, roomChangedAll, type AvatarMover, type MoveEvent, type MoverTrack } from './mover.ts';
import { ReactScreen, noSignalTexture, standbyTexture, type ReactSurface, type ScreenLook, type ScreenRect } from './screen.ts';
import { judgeSurface, type PassVerdict, type ShotWhy } from '../../shared/quad.ts';
import { SoloScreen, type SkinChoice, type SoloPlacement } from './soloScreen.ts';
import { describeSkin, resolveSkinSpec, type ScreenSkinProp } from '../../shared/screenSkin.ts';
import { RoomRays, deriveSoloSteps, noteMovers, resettleRest, snapshotRest, solveTwoShot, type SoloResult, type TwoShot } from './twoShot.ts';
import { applyArea, applyAreaBounds } from './areas.ts';
import { RoomClips, roomClock } from './roomClips.ts';
import { ShotSolver, applySceneCams, frameFrom, groupPoints, type ShotResult, type ShotSubject } from './shotSolver.ts';
import { FollowPlanner, followOperators, type FollowOperator } from './followCam.ts';
import { GM_SPOT, gmSeatRule } from '../../shared/ttrpg/state.ts';
import { videoShowing } from '../../shared/screenVideo.ts';
import { screenVideo } from './screenVideo.ts';
import { ambientFor } from './ambientCam.ts';
import { handPicked } from '../../shared/camPick.ts';
import { applyHideNodes, applyLightGroupsOff, applySpotOverrides, hideFromRoom } from './spotOverrides.ts';
import { formsLightGroups } from '../../shared/forms.ts';
import { pickSpotOcc, spotFitOcc } from '../../shared/occupant.ts';
import { actorOccupant, applySpotKinds, seatRoutingOf } from './forms/spotKinds.ts';
import { FrameGuard, LiveGuard, targetOf, type GuardTarget, type LiveFace } from './frameGuard.ts';
import { drawnFace } from './faceDepth.ts';
import { FACE_BOX, framingClassOf, quantizeMotion, rigFor, roomFraming, safeFor, type FramingClass, type MotionEnvelope, type RoomFraming, type ShotFamily } from '../../shared/framing.ts';
import { EDIT_KINDS, mergeRoomEdits, spotKey, type CamTweak, type PlacedProp, type RoomEdits } from '../../shared/roomEdits.ts';
import type { GfxLevel } from '../../shared/graphics.ts';
import { PlacedProps, applyRoomExtras, restoreRoom, snapshotRoom, tweakPose, type RoomPristine } from './roomEdits.ts';
import { movedNodes } from './roomObjects.ts';
import { beginRoomLoad, endRoomLoad, noteRoomBytes } from './transition/assetWatch.ts';
import { RoomToggles } from './roomToggles.ts';
import { nativePassFor } from './screenFeed.ts';

/** What React mode shows right now: the big centre SCREEN, or the solo side screen beside one performer. */
export type ActiveLayout = 'big' | 'solo';
/** Solo camera move (s) — the drop / power-on timeline is built around it. */
const SOLO_MOVE = 1.6;
/** Auto's standby card is left once the React shot has been still this long (s, room time) — see standbyHold. */
export const HOLD_STILL_S = 0.25;
/** …or at the latest this long after the fast feed's verdict (a camera that never settles: a director, an orbit). */
export const HOLD_MAX_S = 3;

export interface ActorSpec {
  /** Member key: '@host' or a party member id (see SceneState). */
  key: string;
  name: string;
  anchor: THREE.Object3D;
  runtime: AvatarRuntime | null;
}

export interface SceneRuntimeOptions {
  /** 'hole' = OBS (transparent passthrough), 'preview' = studio preview (placeholder / capture). */
  screen: ScreenLook;
  tier: QualityTier;
}

/** Built-in camera choices (plus every CAM_* node in the room). */
export const CAMERA_CHOICES = ['talk', 'group', 'wide', 'react', 'screen'] as const;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder); // EXT_meshopt_compression (web starter pack, CONTRACT.md §7); no effect on uncompressed files
const materialsOf = (o: THREE.Object3D): THREE.Material[] => { const m = (o as THREE.Mesh).material; return !(o as THREE.Mesh).isMesh || !m ? [] : Array.isArray(m) ? m : [m]; };
const UP = new THREE.Vector3(0, 1, 0);
/** A short tag per loaded avatar runtime (the shot caches key on it: a swapped model is another face). */
const rtTags = new WeakMap<object, number>();
let rtNext = 1;
function rtTag(rt: object | null | undefined): number {
  if (!rt) return 0;
  let t = rtTags.get(rt);
  if (t === undefined) { t = rtNext++; rtTags.set(rt, t); }
  return t;
}

/** The room model, fetched here (not by the loader) so the room-change cover gets its real progress PER REQUEST and can
 *  abort a load that stalled (src/scene/transition/assetWatch.ts); then parsed (relative files resolve next to it). */
async function fetchRoomModel(url: string) {
  const req = beginRoomLoad();
  try {
    const res = await fetch(url, { signal: req.signal });
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length')) || 0;
    noteRoomBytes(req.id, 0, total);
    let buf: ArrayBuffer;
    if (!res.body) buf = await res.arrayBuffer();
    else buf = await readBodyBytes(res.body.getReader(), total, (n) => noteRoomBytes(req.id, n, total));   // (one buffer, no second copy)
    return await loader.parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
  } finally { endRoomLoad(req.id); }
}

export const sceneFileUrl = (id: string, file: string) => `/api/scenes/${encodeURIComponent(id)}/file/${file.split('/').map(encodeURIComponent).join('/')}`;

export class SceneRuntime {
  readonly root = new THREE.Group();
  readonly actors = new Map<string, SceneActor>();
  readonly rig = new CameraRig();
  readonly screen: ReactScreen | null;
  readonly lights: SceneLights;
  readonly mover: AvatarMover;
  state: SceneState;
  private intent = new Map<SceneActor, SpotInfo | null>();
  private camKey = '';
  private time = 0;
  private first = true;
  private saved: { fov: number; near: number; far: number; background: string | null; fog: THREE.Fog | THREE.FogExp2 | null };
  private ray = new THREE.Raycaster();
  /** Solo react: the side screen rig for the solo performer's spot, its composition, line-of-sight tests. */
  solo: SoloScreen | null = null;
  private soloKey = '';
  private soloShot: TwoShot | null = null;
  private soloShotKey = '';
  private soloActor: SceneActor | null = null;
  private rays: RoomRays | null = null;
  /** Generated set pieces changed (an engine added / removed room occluders: the interview desk, monitor, chairs): every
   *  cached shot is solved again round them (framing guarantee). */
  noteSetChanged() { this.setVer++; }
  /** The room's set changed shape and SETTLED (the forms engine on settle, desert_walker/SPEC.md §2.5; `settled` = the
   *  nodes it moved, when the caller knows them): the framing rays' rest poses are re-taken where those parts now stand
   *  (twoShot.ts resettleRest), then fresh rays, probe, seat planning and shot caches - a desk that slid into a sight
   *  line is met by every solver, the guard and sizeSeat. (One method for both lanes: the room forms' set-pieces-moved
   *  rebuild - rays, solver + cached shots, screen camera, block cache, every performer's seat plan - plus the framing
   *  rest-pose re-take and noteSetChanged.) */
  refreshRays(settled?: Iterable<THREE.Object3D>) {
    resettleRest(this.room, settled);
    this.rays = null;
    this.solver = null;
    this.shotCache.clear();
    this.screenCam = null;
    this.blockCache = null;
    this.seatEnv.ver++;
    this.noteSetChanged();
    for (const a of this.actors.values()) a.updateSeat();
  }
  private setVer = 0;
  private moversAt = -1;
  /** Size-aware seating (src/scene/sizeSeat.ts): room rays + generated table tops (the interview desk …). */
  readonly seatEnv: SeatEnv = { rays: () => (this.rays ??= new RoomRays(this.room)), surfaces: [], ver: 0, cams: () => this.room.cameras.values() };
  /** Set pieces that small performers may stand on / sit behind (world space); every actor re-plans its seat. */
  setSeatSurfaces(list: SeatSurface[]) {
    this.seatEnv.surfaces = list;
    this.seatEnv.ver++;
    for (const a of this.actors.values()) a.updateSeat();
  }
  /** Automatic solo placement being searched (spread over frames, ~3 ms each). */
  private soloJob: { key: string; gen: Generator<void, SoloResult, void>; actor: SceneActor } | null = null;
  private turn = new Map<SceneActor, number>();
  private dip = { t: 0, base: new Map<THREE.Light, number>() };
  private hole = { open: false, layout: 'big' as ActiveLayout };
  /** Optional camera director (e.g. the raid's preshow cuts, src/scene/raid): a shot here wins over state.camera
   *  (entrance follow-cams still come first). Return null to use the normal camera. */
  cameraOverride: ((aspect: number) => { key: string; pose: CamPose; secs: number; subjects?: string[]; from?: CamPose; t0?: number } | null) | null = null;
  /** The part of a room director that is an ENTRANCE (the club's host walk to the balcony): it still plays while the host's
   *  hand-picked camera (SceneState.camPick) has silenced every other director, then the picked camera is back. */
  entranceCamera: ((aspect: number) => { key: string; pose: CamPose; secs: number } | null) | null = null;
  /** A director shot that follows something the page's engines move AFTER the camera was placed this frame (a traffic
   *  ship, a clip-animated craft — src/scene/afk): re-aim at `pose` now, while the shot on air is still that director's
   *  `key`. false = another shot is on air (nothing changed). */
  lateCamera(key: string, pose: CamPose): boolean {
    if (this.camKey !== `ovr:${key}`) return false;
    this.rig.nudge(pose);
    this.rig.update(0, this.stage.camera);
    return true;
  }
  /** Spots decided outside the room's spot list (projector-screen guests, src/scene/tv/projectorPlace.ts): key → spot
   *  (null = not in the room now). Keys it doesn't return are seated as usual. Spots must be stable objects. */
  static spotHook: ((rt: SceneRuntime) => Map<string, SpotInfo | null> | null) | null = null;
  /** Room forms (src/scene/forms/formsScene.ts): a member's spot -> the variant of it the room shows now (a docking cradle
   *  instead of the desk chair). Same index, a different stable SpotInfo; null = unchanged. Applied after seating. */
  static spotMaps: ((rt: SceneRuntime, key: string, spot: SpotInfo) => SpotInfo | null)[] = [];
  /** Room forms: a change between two variants of the same spot is a re-place where they are (no walk). */
  static hopHook: ((rt: SceneRuntime, a: SceneActor, want: SpotInfo, had: SpotInfo) => boolean) | null = null;
  /** Who the Talk camera frames right now when it isn't the host's pick (a projector guest who is speaking). */
  static focusHook: ((rt: SceneRuntime) => SceneActor | null) | null = null;
  /** Moving rooms (src/scene/frameGuard.ts, shared/framing.ts MotionEnvelope): the worst-case motion between the camera
   *  and the performers for a shot family right now (a walking ship's deck kick in a battle, an exterior camera that sees
   *  the deck sway). The framing guarantee keeps faces that much further inside the safe area. null = scene.json
   *  framing.motion (or none). Room engines (the voyage engine) set it; it must be a pure function of host stamps. */
  static motionHook: ((rt: SceneRuntime, family: 'talk' | 'group' | 'wide' | 'solo' | 'tile' | 'interview' | 'ttrpg') => MotionEnvelope | null) | null = null;
  /** This page's own camera choice (output.html?cam=CAM_X on a live OBS page): used instead of state.camera while the
   *  room has that camera (or it's a built-in: talk / group / wide / react). The entrance follow-cam and the
   *  cameraOverride directors still come first. null = follow the host's state.camera (the default). */
  cameraPin: string | null = null;
  /** The OBS hole finished opening (true) / closing (false) — the OBS automation lines the Window Capture up then. */
  onHole: ((open: boolean, rect: ScreenRect | null, layout: ActiveLayout, quad: [number, number][] | null) => void) | null = null;

  static async load(stage: Stage, info: SceneInfo, state: SceneState, opts: SceneRuntimeOptions): Promise<SceneRuntime> {
    const gltf = await fetchRoomModel(sceneFileUrl(info.id, info.model));
    // rooms with areas (shared/roomId.ts): narrow the GLB to this area before anything reads node names
    const area = applyArea(gltf.scene, gltf.animations, info);
    if (area) console.info(`[scene] ${info.id}: area ${area.area} (${area.renamed} anchors, ${area.removed} other-area groups removed)`);
    // the user's own Room editor layer (docs/ROOM_EDITOR.md): merged over scene.json; the room as listed stays the base
    const base = { ...info };
    delete base.userEdits;
    const rt = new SceneRuntime(stage, mergeRoomEdits(base, info.userEdits), gltf.scene, state, opts, base);
    rt.clips = RoomClips.create(gltf.scene, gltf.animations);
    rt.clips?.freeze(movedNodes(rt.room, rt.info.userEdits));   // (room objects the user moved: no clip puts them back)
    if (rt.toggles.hidden.size) rt.clips?.setHidden(rt.toggles.hidden);   // room prop toggles already off at load
    return rt;
  }

  /** The room as listed, without the user's layer (applyEdits merges a new layer over it). */
  baseInfo: SceneInfo;
  /** The room as authored (before scene.json and the user's layer): a hot re-apply starts from it. */
  private pristine!: RoomPristine;
  /** The user's placed props (src/scene/roomEdits.ts). */
  props: PlacedProps | null = null;
  /** The page's graphics level (placed-prop budgets): output.ts hands in its Graphics level. */
  static levelHook: (() => GfxLevel) | null = null;
  /** Lights an engine wants IN the room before the room's first shader compile (the festival's talk-set spots): the number
   *  of lights is part of every lit program's key, so lights added after that compile (an engine's attach comes after it)
   *  made every lit material compile again. The hook adds them under `root` (same place, same order as later). */
  static earlyLights: ((root: THREE.Object3D, info: SceneInfo) => void) | null = null;

  /** The user saved new edits for this room (bus {type:'roomEdits'}, or the editor while dragging): applied in place —
   *  the room is NOT reloaded. Cameras, spots, the screen, solo / chat displays and props go where the layer says;
   *  performers at a moved spot are re-placed there; the camera moves to the new shot with the director's transition
   *  (a live camera tweak alone only does that last step). */
  applyEdits(edits: RoomEdits | null) {
    const prev = this.info.userEdits ?? null;
    const next = mergeRoomEdits(this.baseInfo, edits);
    this.info = next;
    const same = (k: typeof EDIT_KINDS[number]) => JSON.stringify(prev?.[k] ?? null) === JSON.stringify(edits?.[k] ?? null);
    if (!EDIT_KINDS.filter((k) => k !== 'camTweaks').every(same)) {
      const room = this.room;
      const back = restoreRoom(room, this.pristine);
      const jc = next as unknown as { cams?: unknown; cameraOverrides?: unknown; spotOverrides?: unknown };
      applySceneCams(room, jc.cams);
      applySceneCams(room, jc.cameraOverrides);
      applySpotOverrides(room, jc.spotOverrides);
      this.clips?.freeze(movedNodes(room, edits));   // (before placing: a stopped clip track restores what it found)
      applyRoomExtras(room, this.pristine, next);
      this.toggles.reassert();                       // (restoreRoom showed the toggled-off groups again)
      roomChangedAll(this.mover);                    // (walk feet look the ground up again: objects hidden / moved)
      const list = (next as { placedProps?: PlacedProp[] }).placedProps ?? [];
      if (!same('props') && this.props && !this.props.update(list)) void this.props.sync(list);
      // performers at a moved spot: re-placed where it is now (no walk)
      for (const a of this.actors.values()) {
        const s = this.intent.get(a);
        if (!s || a.spot !== s || this.mover.busy(a)) continue;
        this.mover.release?.(a);
        a.updateSeat(); a.place(a.placementAt(s)); a.perch = a.perchFor(s);
      }
      this.soloKey = '';                     // (the solo screen re-places: retracts, then drops at its new place)
      // (fresh rays / shot caches; rest poses re-taken only for the room's own objects the layer moved / put back, so a
      // page that applies it hot tests them where a page that loads with it does: every page stays alike)
      this.refreshRays([...back, ...this.pristine.objects.snaps.keys()]);
    }
    this.lives = null;                       // (restoreRoom put back fresh camera presets: the live list is taken again)
    this.camKey = '';                        // the camera goes to the new shot with the normal transition
  }

  /** The live camera quick-adjust (shared/roomEdits.ts CamTweak) remembered for an angle of this room. */
  tweakFor(angle: string | null): CamTweak | null {
    if (!angle) return null;
    return (this.info as { camTweaks?: Record<string, CamTweak> }).camTweaks?.[angle] ?? null;
  }
  /** The angle the camera choice is on now ('talk:SPOT_03', 'group', 'wide', 'react', 'solo:SPOT_01', a preset name), or
   *  null (a director / follow / screen-video shot: those are never tweaked). The studio asks the same question with
   *  the same state (src/ui/cameraTweaks.ts angleOf). */
  angleNow(key: string): string | null {
    const c = this.pinnedCamera();   // (a page's ?cam= pin: its own angle's tweak, not the host's)
    if (key.startsWith('solo:')) { const i = +key.slice(5); return Number.isInteger(i) && i < MAX_SPOTS ? `solo:${spotKey(i)}` : null; }
    if (c === 'talk') { const a = this.focusActor(); const s = a ? this.intent.get(a) : null; return s && s.index < MAX_SPOTS ? `talk:${spotKey(s.index)}` : null; }
    if (c === 'group' || c === 'wide' || c === 'react') return c;
    return /^CAM_[A-Z0-9_]+$/.test(c) && this.room.cameras.has(c) ? c : null;
  }
  /** How far in front of the lens the tweak's orbit pivot is: the framed face (talk / solo), else the middle of the spots
   *  along the view (1.2-12 m). */
  private pivotDist(angle: string, pose: CamPose): number {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    if (angle.startsWith('talk:') || angle.startsWith('solo:')) {
      const a = this.focusActor(), s = a ? this.intent.get(a) : null;
      const f = a && s ? a.drawnFaceAt(s) : null;
      if (f) return THREE.MathUtils.clamp(f.center.clone().sub(pose.position).dot(fwd), 0.6, 12);
    }
    const ahead = this.roomCenter().sub(pose.position).dot(fwd);
    return THREE.MathUtils.clamp(Number.isFinite(ahead) && ahead > 0 ? ahead : 3, 1.2, 12);
  }

  /** The parsed room glTF (this runtime's alone: every load parses its own copy, so its bitmaps can be released on dispose). */
  private readonly roomModel: THREE.Object3D;
  /** The room's own glTF animation clips (roomClips.ts): looped at the deterministic room clock. */
  clips: RoomClips | null = null;
  /** Time base of the room clips (s). Default: wall clock since UTC midnight; the town engine hands in its own clock
   *  (identical, but it also follows its test-page manual clock). */
  clipClock: (() => number) | null = null;

  private constructor(readonly stage: Stage, public info: SceneInfo, model: THREE.Object3D, state: SceneState, readonly opts: SceneRuntimeOptions, base?: SceneInfo) {
    this.roomModel = model;
    this.baseInfo = base ?? info;
    this.state = state;
    this.root.name = `scene:${info.id}`;
    this.root.add(model);
    stage.scene.add(this.root);
    this.room = parseRoom(model);
    const fullBounds = this.room.bounds.clone();         // the camera's far plane still covers the whole model (sky, planet)
    applyAreaBounds(this.room, info);                    // scene.json / area `bounds`: what framing treats as the room
    this.pristine = snapshotRoom(this.room);             // (the room as authored: the Room editor's hot re-apply starts here)
    // scene.json `cams` (some room builders mirror their GLB cameras there) then `cameraOverrides` (hand / QA fixes —
    // builders keep unknown keys, so these survive a rebuild): presets / talk cameras without re-exporting the GLB
    const jc = info as unknown as { cams?: unknown; cameraOverrides?: unknown };
    applySceneCams(this.room, jc.cams);
    applySceneCams(this.room, jc.cameraOverrides);
    // scene.json `spotOverrides` (QA fixes: a spot moved / turned without a GLB re-export) — before the mover uses them
    applySpotOverrides(this.room, (info as unknown as { spotOverrides?: unknown }).spotOverrides);
    applyHideNodes(this.room, (info as unknown as { hideNodes?: unknown }).hideNodes);
    // the user's own layer (docs/ROOM_EDITOR.md): the react screen moved, solo screens / chat anchors replaced
    applyRoomExtras(this.room, this.pristine, info);
    // (the room as authored, for the framing solvers' rays: doors / turrets / pods an engine animates later are tested at
    // rest — every page, whenever it solves, sees the same room; src/scene/twoShot.ts snapshotRest)
    snapshotRest(this.room);
    applyLightGroupsOff(this.room, (info as unknown as { lightGroupsOff?: unknown }).lightGroupsOff);   // (Creator Console light-group toggles)
    // (room forms drive their own EMIT_ groups - rotating beacons, runway chase: src/scene/forms/formsScene.ts)
    const formGroups = formsLightGroups(info);
    if (formGroups.length) applyLightGroupsOff(this.room, formGroups);
    this.skins = this.resolveSkins();
    // room prop toggles (src/scene/roomToggles.ts): applied before the walk graph / lights / size spots read the room, so a
    // group that is off when the room loads is out of every ray test and collider list from the start
    this.toggles = new RoomToggles(this.room, info);
    this.toggles.apply(state.toggles);
    // cameras in the GLB are presets, not renderable objects; keep the room cheap: no shadows
    model.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    this.screen = this.room.screen ? new ReactScreen(this.room.screen, opts.screen, this.viewerPoint()) : null;
    if (this.screen) this.screen.onLand = () => { if (!this.videoLay) this.landAccent(); };   // (no light accent for the screen video)
    this.room.door?.setOpen(0);
    const cam = stage.camera;
    this.saved = { fov: cam.fov, near: cam.near, far: cam.far, background: stage.background, fog: stage.scene.fog };
    const amb = info.ambience ?? {};
    stage.background = amb.background ?? null;
    // ambience.exposure: the room's own brightness under the avatar lights (the stage lights are tuned for
    // toon avatars; rooms scale their materials instead so the avatars keep their look)
    const ex = typeof amb.exposure === 'number' && Number.isFinite(amb.exposure) ? THREE.MathUtils.clamp(amb.exposure, 0.1, 3) : 1;
    if (ex !== 1) model.traverse((o) => {
      for (const m of materialsOf(o)) {
        const sm = m as THREE.MeshStandardMaterial;
        if (sm.color && !/^EMIT_/.test(sm.name) && !sm.userData.vtpExposed) { sm.color.multiplyScalar(ex); sm.userData.vtpExposed = true; }
      }
    });
    try { stage.scene.fog = amb.fog ? new THREE.Fog(amb.fog, amb.fogNear ?? 8, amb.fogFar ?? 30) : null; } catch { stage.scene.fog = null; }
    const span = fullBounds.isEmpty() ? 20 : fullBounds.getSize(new THREE.Vector3()).length();
    cam.near = 0.03; cam.far = Math.max(60, span * 4); cam.zoom = 1;
    cam.clearViewOffset();
    cam.updateProjectionMatrix();
    SceneRuntime.earlyLights?.(this.root, info);
    this.lights = createLights();
    this.lights.attach({ room: this.room, scene: stage.scene, tier: opts.tier, info, camera: stage.camera,
      faces: () => [...this.actors.values()].filter((a) => a.shown && a.spot).map((a) => a.faceAt(a.spot!)?.center).filter((c): c is THREE.Vector3 => !!c),
      actors: () => [...this.actors.values()].filter((a) => a.shown && a.spot && a.runtime).map((a) => ({ obj: a.mount as THREE.Object3D, face: a.faceAt(a.spot!)?.center ?? null })),
      warm: () => { try { stage.renderer.compile(stage.scene, stage.camera); } catch { /* optional */ } } });
    this.lights.setState(state.lights);
    // the React screen's housing is built on the first React (and again when the performer's spot or size changes): a
    // hidden probe of it compiled with the room and let go — its programs and shader sources stay (programKeep.ts)
    try {
      const probe = new SoloScreen({ center: new THREE.Vector3(), yaw: 0, width: 1.6, ceilingY: 3, floorY: -1, source: 'probe' }, opts.screen, this.skins.solo);
      this.root.add(probe.rig);
      stage.renderer.compile(probe.rig, stage.camera, stage.scene);
      probe.rig.removeFromParent();
      probe.dispose();
    } catch (e) { console.warn('[scene] react screen warm-up', e); }
    this.mover = createMover(this.room, info);
    this.mover.setScene?.(state, () => this.actors.values());
    // (the room as it loaded, for walking machines: snapshotted now, before any door swings: src/scene/mechNav.ts)
    staticRaysOf(this.room);
    // size classes: scene.json spotSizes / sizeSpots (automatic micro / macro spots: sizeJob, derived on demand)
    applySpotSizes(this.room, info);
    // body kinds: GLB extras `kinds` / scene.json spotKinds (a mech never gets a couch seat: src/scene/forms/spotKinds.ts)
    applySpotKinds(this.room, info);
    this.room.sizeSpots.push(...jsonSizeSpots(this.room, info));
    // the user's placed props (instanced; ray proxies join room.occluders once they are in)
    this.props = new PlacedProps({ room: this.room, root: model, exposure: ex, level: () => SceneRuntime.levelHook?.() ?? 'balanced', changed: () => this.refreshRays([]) });   // ([]: no room part's rest pose is re-taken — props were never snapshotted)
    const placed = (info as { placedProps?: PlacedProp[] }).placedProps;
    if (placed?.length) void this.props.sync(placed);
  }

  readonly room: RoomInfo;
  /** Room prop toggles (scene.json `toggles`, glb extras `toggleGroup`): SceneState.toggles shows / hides them. */
  readonly toggles: RoomToggles;
  /** scene.json `framing` (shared/framing.ts): guard on / off, live drift guard, per-class rig tweaks, a fixed motion. */
  get framing(): RoomFraming { return (this.framingCfg ??= roomFraming((this.info as unknown as { framing?: unknown }).framing)); }
  private framingCfg: RoomFraming | null = null;
  /** The motion envelope for a shot family now (motionHook, else scene.json framing.motion), rounded UP to the next
   *  MOTION_LEVELS step (a smoothly varying envelope never re-solves the guarded shots every frame). React's solo two-shot
   *  and the Gaming / React tile cams take only the room's own fixed envelope: the deck never shakes in React or Gaming
   *  and their camera never moves (the walking-ship SPEC §5.1 R2, desert_walker/SPEC.md M8) — an event never re-solves
   *  them under an open OBS hole. */
  motionFor(family: Parameters<NonNullable<typeof SceneRuntime.motionHook>>[1]): MotionEnvelope | null {
    if (family === 'solo' || family === 'tile') return quantizeMotion(this.framing.motion);
    try { const m = SceneRuntime.motionHook?.(this, family); if (m !== undefined && m !== null) return quantizeMotion(m); } catch (e) { console.warn('[scene] motionHook', e); }
    return quantizeMotion(this.framing.motion);
  }
  /** Framing class of a performer (shared/framing.ts): FrameGuard.classHook (the forms engine), else the profile. */
  classOf(a: SceneActor): FramingClass {
    return FrameGuard.classHook?.(a.key) ?? framingClassOf(a.runtime?.profile as unknown as { size?: unknown; body?: unknown; mech?: unknown } | undefined, a.size.cls);
  }
  /** The live drift guard (src/scene/frameGuard.ts) and its debug (vtpOut.scene.liveGuard). */
  private live = new LiveGuard();
  private liveFacesAt = -1;
  private liveFacesKey = '';
  private liveFacesCache: LiveFace[] = [];
  get liveGuard() { return this.live.info; }
  /** Room skins of the generated screen rigs (solo screen, chat monitor, support board): scene.json screenSkin /
   *  SOLO_SKIN-style GLB nodes / the room's built-in default (shared/screenSkin.ts). */
  readonly skins: Record<ScreenSkinProp, SkinChoice>;
  private resolveSkins(): Record<ScreenSkinProp, SkinChoice> {
    const find = (n: string) => this.room.root.getObjectByName(n) ?? null;
    const out = {} as Record<ScreenSkinProp, SkinChoice>;
    for (const prop of ['solo', 'monitor', 'board'] as const) {
      const spec = resolveSkinSpec(this.info.id, this.info.screenSkin, prop, (n) => !!find(n));
      const template = spec.node ? find(spec.node) : null;
      if (template) {
        // a template: never drawn or ray-tested in the room itself
        hideFromRoom(this.room, template);
      }
      if (spec.warnings.length) console.warn(`[scene] ${this.info.id} screenSkin.${prop}: ${spec.warnings.join('; ')}`);
      out[prop] = { spec, template };
    }
    return out;
  }

  // ---------------------------------------------------------------- state
  setState(s: SceneState) {
    const lightsChanged = JSON.stringify(s.lights) !== JSON.stringify(this.state.lights);
    const scaleChanged = s.avatarScale !== this.state.avatarScale;
    if (s.mode !== 'react' && this.refused) { this.refused = null; this.lookKey = ''; }   // (back in React: OBS is asked again)
    this.state = s;
    if (this.toggles.apply(s.toggles)) {
      // what is in the room changed: clips under hidden roots stop; fresh rays (colliders, occluders), solver and cached
      // shots / the solo two-shot re-solve round the new set
      this.clips?.setHidden(this.toggles.hidden);
      this.refreshRays([]);                       // ([]: no room part's rest pose is re-taken: toggling moves nothing)
      this.soloShotKey = '';
    }
    if (lightsChanged) this.lights.setState(s.lights);
    if (scaleChanged) for (const a of this.actors.values()) this.fit(a);
    this.mover.setMode?.(s.mode);
    this.mover.setScene?.(s, () => this.actors.values());
    this.reconcile();
  }

  /** Hand over the performers (every time an avatar loads / the party changes). */
  syncActors(specs: ActorSpec[]) {
    const want = new Map(specs.map((s) => [s.key, s]));
    for (const [key, a] of this.actors) {
      const sp = want.get(key);
      if (sp && sp.anchor === a.anchor && sp.runtime === a.runtime) continue;
      if (!sp || (a.anchor && sp.anchor !== a.anchor) || (a.runtime && sp.runtime !== a.runtime)) a.detach();
      if (!sp) { a.mount.removeFromParent(); this.actors.delete(key); this.intent.delete(a); }
    }
    for (const sp of specs) {
      let a = this.actors.get(sp.key);
      if (!a) { a = new SceneActor(sp.key, sp.name); a.seatEnv = this.seatEnv; a.parkRays = staticRaysOf(this.room); this.actors.set(sp.key, a); this.root.add(a.mount); }
      a.name = sp.name;
      if (sp.runtime && (a.runtime !== sp.runtime || a.anchor !== sp.anchor)) { a.attach(sp.anchor, sp.runtime); this.fit(a); }
    }
    this.reconcile();
  }

  /** Give every anchor back (before dispose → Classic). */
  releaseActors(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const a of this.actors.values()) { const an = a.detach(); if (an) out.push(an); a.mount.removeFromParent(); }
    this.actors.clear();
    this.intent.clear();
    return out;
  }

  private fit(a: SceneActor) {
    // real size (shared/avatarSize.ts): normal performers = the room's height (as always); micro / small / large / macro
    // scale from it, and large / macro never poke through the ceiling of their spot
    const base = (this.info.avatarHeight ?? 1.5) * (this.state.avatarScale || 1);
    a.size = avatarSize(a.runtime?.profile);
    a.base = base;
    // walking machines (desert_walker SPEC §2.2 + C4): the PILOT is normalised like everyone else (h = base) and
    // actor.setHeight shows the machine at its true size around them (bounded by the model's own height, 80 m cap)
    // (a machine without a pilotHeight: the size-class rule like anyone else, times its walker scale)
    const mechRule = a.isMech && a.mechShownFor(base) !== null;
    let h = mechRule ? base : shownHeight(a.size, base) * (a.isMech ? a.runtime?.mech?.cfg.heroScale ?? 1 : 1);
    const shown = a.mechShownFor(h);
    const s = this.intent.get(a) ?? a.spot;
    if (s && (a.size.cls === 'large' || a.size.cls === 'macro' || a.isMech)) {
      const c = measureClearance(s, this.rays ??= new RoomRays(this.room));
      // (a macro performer stands beside a chair instead of sitting in it: sizeSeat.ts; a walking machine parks in front)
      let cap = s.pose === 'sit' && a.size.cls !== 'macro' && !a.isMech ? (c.height - s.seatHeight - 0.08) / 0.53 : c.height - 0.08;
      if (s.sizeSpot === 'auto') cap = Math.min(cap, c.radius / 0.2);         // measured footprint of a back-row spot
      const lim = Math.max(base, cap);
      // (a machine: the clamp is on what it really shows; its pilot shrinks with it)
      if (shown !== null) { if (shown > lim) h *= lim / shown; }
      else h = Math.min(h, lim);
    }
    a.setHeight(h);
  }

  // ---------------------------------------------------------------- size spots (src/scene/sizeSpots.ts)
  /** Automatic micro / macro spots: searched a few ms per frame once someone needs them (or a preview reports). */
  private sizeJob: Generator<void, SizeSpotResult, void> | null = null;
  /** true once the automatic size spots are known (or none are needed: the room authors both classes). */
  sizeReady = false;
  sizeNotes: string[] = [];
  private needSizeSpots() {
    if (this.sizeReady || this.sizeJob) return;
    const all = [...this.room.spots, ...this.room.sizeSpots];
    const have = { micro: all.some((s) => !!s?.sizes?.includes('micro')), macro: all.some((s) => !!s?.sizes?.includes('macro')) };
    if (this.info.autoSizeSpots === false || (have.micro && have.macro)) { this.sizeReady = true; return; }
    // (the room's own height, not × avatarScale: the spots must not move when the host changes the avatar size)
    this.sizeJob = deriveSizeSpots(this.room, this.rays ??= new RoomRays(this.room), this.info.avatarHeight ?? 1.5, have, MAX_SPOTS + this.room.sizeSpots.length);
  }
  private pumpSizeSpots() {
    const job = this.sizeJob;
    if (!job) return;
    const t0 = performance.now();
    for (;;) {
      let r: IteratorResult<void, SizeSpotResult>;
      try { r = job.next(); } catch (e) { console.warn('[scene] size spots', e); r = { done: true, value: { spots: [], notes: [String(e)] } }; }
      if (r.done) {
        this.sizeJob = null; this.sizeReady = true;
        this.room.sizeSpots.push(...r.value.spots);
        this.sizeNotes = r.value.notes;
        this.reconcile();
        return;
      }
      if (performance.now() - t0 > 3) return;
    }
  }
  /** Size-spot pop-ins (no walk to a table top / the back row): seconds since it started. */
  private pops = new Map<SceneActor, number>();

  /** Spot for every member key: the host's assignment, else (a guest the host hasn't placed yet) the first free spot. */
  private spotsByKey(): Map<string, SpotInfo | null> {
    const out = new Map<string, SpotInfo | null>();
    const taken = new Set<number>();
    const pre = SceneRuntime.spotHook?.(this) ?? null;
    for (const key of this.actors.keys()) {
      if (pre?.has(key)) { const s = pre.get(key) ?? null; out.set(key, s); if (s) taken.add(s.index); continue; }
      const i = this.state.spots[key];
      const s = typeof i === 'number' ? spotByIndex(this.room, i) : null;
      if (s && !taken.has(s.index)) { out.set(key, s); taken.add(s.index); }
      // a size spot (13…) this page hasn't derived yet: wait for it (a few frames) instead of seating them elsewhere
      else if (typeof i === 'number' && i >= MAX_SPOTS && !s && !this.sizeReady) { this.needSizeSpots(); out.set(key, null); }
    }
    const order = [...this.actors.keys()].sort((a, b) => (a === HOST_KEY ? -1 : b === HOST_KEY ? 1 : a.localeCompare(b)));
    const reserved = new Set(Object.values(this.state.spots));
    // unassigned: keep the seat they already have if it's still free (no reshuffling), else the first free one that
    // suits their size class (a fairy's table perch is never given to a person; micro / macro prefer their own spots)
    const all = [...this.room.spots, ...this.room.sizeSpots].filter((s): s is SpotInfo => !!s);
    // (a TTRPG table's human GM goes to the GM's chair rather than keeping another seat)
    const gmKey = this.info.ttrpg && this.state.ttrpg?.on && this.state.ttrpg.gm.kind === 'human' ? this.state.ttrpg.gm.who ?? null : null;
    // (size class + body kind: shared/occupant.ts spotFitOcc - a mech never takes a couch seat marked for bipeds; for an
    //  ordinary performer in a room without spot kinds / forms this is exactly spotFit(sizes, size class))
    const route = seatRoutingOf(this.info);
    const occOf = new Map([...this.actors].map(([k, a]) => [k, actorOccupant(a, route.rules)]));
    for (const key of order) {
      if (out.has(key) || (key === gmKey && this.actors.get(key)!.spot?.index !== GM_SPOT)) continue;
      const a = this.actors.get(key)!, cur = a.spot, occ = occOf.get(key)!;
      const fit = cur ? spotFitOcc(cur, occ, route.converts) : 0;
      // (a fallback seat is kept only while no spot made for their size is free — e.g. the size spots just arrived)
      const better = fit === 1 && all.some((s) => !taken.has(s.index) && !reserved.has(s.index) && spotFitOcc(s, occ, route.converts) === 2);
      if (cur && !taken.has(cur.index) && !reserved.has(cur.index) && fit > 0 && !better) { out.set(key, cur); taken.add(cur.index); }
    }
    for (const key of order) {
      if (out.has(key)) continue;
      const occ = occOf.get(key)!;
      // (TTRPG rooms keep the GM's chair for the GM: shared/ttrpg/state.ts gmSeatRule)
      const gmRule = gmSeatRule(this.info, this.state.ttrpg, key);
      const seatable = gmRule === 'free' ? all : all.filter((s) => s.index !== GM_SPOT);
      let i = pickSpotOcc(seatable.filter((s) => !reserved.has(s.index)), occ, taken, key === gmKey ? GM_SPOT : -1, route.converts);
      if (i < 0) i = pickSpotOcc(seatable, occ, taken, -1, route.converts);
      if (i < 0 && gmRule === 'last') i = pickSpotOcc(all, occ, taken, -1, route.converts);
      const free = i >= 0 ? spotByIndex(this.room, i) : null;
      if (free) taken.add(free.index);
      out.set(key, free);
    }
    // room forms: the variant of each spot the room shows now (same index: nothing else about seating changes)
    const formMap = (key: string, s: SpotInfo | null) => {
      if (!s || !SceneRuntime.spotMaps.length) return s;
      let m = s;
      for (const f of SceneRuntime.spotMaps) m = f(this, key, m) ?? m;
      return m;
    };
    for (const [key, s] of out) { const m = formMap(key, s); if (m !== s) out.set(key, m); }
    // (seats an engine placed through the spot hook - a room form's - are that engine's; never moved here)
    // big bodies measured at the seats the room shows (their form variants); a guest moved off a big body gets the
    // variant of the seat they land in
    const before = new Map([...out].map(([k, v]) => [k, v?.index ?? -1]));
    this.clearOfBigBodies(out, order.filter((k) => !pre?.has(k)), all);
    for (const [key, s] of out) if ((s?.index ?? -1) !== before.get(key)) { const m = formMap(key, s); if (m !== s) out.set(key, m); }
    return out;
  }

  /** Big performers keep their body to themselves (framing guarantee, desert_walker/SPEC.md §2.7): a guest whose seat
   *  puts their face INSIDE a macro / giant / mech performer's body (its rest box at its seat) can't be seen from any
   *  camera - they move to the nearest free seat that suits their size and is clear of every big body. A pure function
   *  of the line-up and the avatars' rest measures (the same on every page); nothing changes without a big performer. */
  private clearOfBigBodies(out: Map<string, SpotInfo | null>, order: string[], all: SpotInfo[]) {
    const big: { key: string; box: THREE.Box3 }[] = [];
    for (const key of out.keys()) {
      const a = this.actors.get(key), s = out.get(key);
      if (!a || !s || !a.rest) continue;
      const cls = this.classOf(a);
      if (cls !== 'macro' && cls !== 'mech') continue;
      const b = a.restBoxAt(s);
      if (b && !b.isEmpty()) big.push({ key, box: b });
    }
    if (!big.length) return;
    const used = new Set<number>();
    for (const s of out.values()) if (s) used.add(s.index);
    const gmFree = gmSeatRule(this.info, this.state.ttrpg, '') === 'free';
    const route = seatRoutingOf(this.info);
    const inBody = (a: SceneActor, s: SpotInfo) => { const f = a.drawnFaceAt(s); return !!f && big.some((b) => b.key !== a.key && b.box.containsPoint(f.center)); };
    for (const key of order) {
      const a = this.actors.get(key), s = out.get(key);
      if (!a || !s || !a.rest || big.some((b) => b.key === key) || !inBody(a, s)) continue;
      let best: SpotInfo | null = null, bd = Infinity;
      for (const c of all) {
        if (used.has(c.index) || c.index >= MAX_SPOTS || (!gmFree && c.index === GM_SPOT) || spotFitOcc(c, actorOccupant(a, route.rules), route.converts) === 0 || inBody(a, c)) continue;
        const d = c.position.distanceTo(s.position);
        if (d < bd - 1e-6) { bd = d; best = c; }
      }
      if (!best) continue;
      used.delete(s.index); used.add(best.index);
      out.set(key, best);
    }
  }

  /** Presence / spot changes → the mover (entrances, exits, moves). */
  private reconcile() {
    // someone needs a micro / macro spot: derive the room's automatic ones (spread over frames)
    if (!this.sizeReady && [...this.actors.values()].some((a) => a.runtime && (a.size.cls === 'micro' || a.size.cls === 'macro'))) this.needSizeSpots();
    const spots = this.spotsByKey();
    for (const [key, a] of this.actors) {
      const spot = spots.get(key) ?? null;
      const want = a.runtime && spot && this.state.present[key] !== false ? spot : null;
      const had = this.intent.get(a) ?? null;
      a.present = this.state.present[key] !== false;
      if (want === had) continue;
      this.intent.set(a, want);
      if (want && (a.size.cls !== 'normal' || a.isMech)) this.fit(a);   // large / macro / machines: the new spot's head room
      // the host's timed event for this change (every page simulates the same walk from it)
      const mv = this.state.moves?.[key];
      const ev: MoveEvent | undefined = mv && mv.to === (want ? want.index : -1) ? { at: mv.at, from: mv.from } : undefined;
      // a mover that owns this performer's entrances (big entrance: src/scene/forms/bigEntrance.ts) plays them even there
      const claimed = !!want && !!this.mover.claims?.(a, want);
      // room forms: the same spot in another form (the desk became a booster riser): re-placed where they are
      if (!claimed && want && had && want.index === had.index && SceneRuntime.hopHook?.(this, a, want, had)) {
        a.spot = want; a.updateSeat();
        if (this.mover.busy(a)) this.mover.move(a, want, ev);
        else { this.mover.release?.(a); a.place(a.placementAt(want)); a.perch = a.perchFor(want); }
        continue;
      }
      // size spots (table perches, the giants' back row) are not on the walk graph: pop in / out there
      if (!claimed && ((want && want.index >= MAX_SPOTS) || (!want && had && had.index >= MAX_SPOTS))) {
        this.mover.release?.(a);
        if (want) { a.spot = want; a.updateSeat(); a.place(a.placementAt(want)); a.perch = a.perchFor(want); if (!this.first) { a.appear = 0; this.pops.set(a, 0); } }
        else { a.shown = false; this.pops.delete(a); }
        continue;
      }
      if (want && !had) { a.spot = want; a.updateSeat(); this.mover.enter(a, want, ev); }
      else if (!want && had) this.mover.exit(a, ev);
      else if (want && had) { a.spot = want; a.updateSeat(); this.mover.move(a, want, ev); }
    }
    if (this.first) { this.mover.finishAll(); }
  }

  /** Re-run seating now (room forms: a zone's form changed which variant of a spot its people use). */
  refreshSeats() { this.reconcile(); }

  // ---------------------------------------------------------------- per frame
  /** A raid interrupt (big-donation Tagilla) is on: React's screens winch up (and the OBS hole closes) until it ends. */
  interrupt = false;
  /** A screen-space stage layout owns the frame (src/scene/stage/compositor.ts: React Full / Medium, Gaming …): the
   *  room's React screens stay up and open no hole — the layout draws the capture itself. */
  composite = false;

  update(dt: number) {
    this.time += dt;
    // (room parts an engine animates leave the framing rays once seen moving; the shots solved round them re-solve)
    if (this.time - this.moversAt >= 0.25) { this.moversAt = this.time; if (noteMovers(this.room)) this.noteSetChanged(); }
    this.pumpSizeSpots();
    this.mover.update(dt);
    const react = this.state.mode === 'react' && !this.interrupt && !this.composite;
    // screen video (shared/screenVideo.ts): in Talk (React / Interview / Gaming / TTRPG … own the screen), with no stage
    // layout owning the frame and no raid interrupt, the room's big SCREEN — else the solo side screen — plays the host's video
    this.videoLay = !react && this.state.mode === 'talk' && !this.composite && !this.interrupt && videoShowing(this.state.video) ? (this.screen ? 'big' : 'solo') : null;
    const lay = this.layout();
    if (lay === 'solo' || (react && this.solo)) this.ensureSolo(react && lay === 'solo');
    const soloT = this.soloTarget();
    const soloOn = react && lay === 'solo' && !!this.solo && !!soloT && !this.mover.busy(soloT.actor);
    const vidSolo = this.videoLay === 'solo' && !!this.solo && !!soloT && !this.mover.busy(soloT.actor);
    screenVideo.sync(this.state.video, this.videoLay === 'big' || vidSolo, Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy()));
    for (const a of this.actors.values()) {
      const spot = this.intent.get(a) ?? null;
      if (!this.mover.busy(a)) {
        if (spot) {
          a.shown = true;
          const pop = this.pops.get(a);
          if (pop === undefined) a.appear = 1;
          else {
            // a quick scale-in with a little overshoot (size spots: no walk)
            const t = Math.min(1, (pop + dt) / 0.45);
            a.appear = t >= 1 ? 1 : 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
            if (t >= 1) this.pops.delete(a); else this.pops.set(a, pop + dt);
          }
          const pt = a.perchFor(spot);
          a.perch = this.first ? pt : a.perch + (pt - a.perch) * (1 - Math.exp(-4 * dt));
          a.mount.position.copy(spot.position);
          // solo react: the performer turns a touch towards their screen (eyeline), eased
          let want = 0;
          if (soloOn && a === this.soloActor && this.solo) {
            const to = this.solo.place.center.clone().sub(spot.position).setY(0).normalize();
            const ang = Math.atan2(new THREE.Vector3().crossVectors(spot.forward, to).y, spot.forward.dot(to));
            want = THREE.MathUtils.clamp(ang * 0.3, -0.35, 0.35);
          }
          const cur = this.turn.get(a) ?? 0;
          const nt = this.first ? want : cur + (want - cur) * (1 - Math.exp(-3 * dt));
          this.turn.set(a, nt);
          a.mount.rotation.set(0, spot.yaw + nt, 0);
          const sitT = spot.pose === 'sit' || a.isMech ? 1 : 0;         // (a walking machine: its park weight)
          const k = this.first ? 1 : 1 - Math.exp(-6 * dt);
          a.sit += (sitT - a.sit) * k;
          if (Math.abs(a.sit - sitT) < 1e-3) a.sit = sitT;
        } else a.shown = false;
      } else if (a.perch) a.perch *= Math.exp(-6 * dt);                   // walking: feet on the floor
      a.sync();
    }
    this.updateCamera(dt);
    // the React screen as the camera's shot will see it: in the shot? could OBS line a Window Capture up with it?
    this.shotStill += dt;
    this.judgeShot(lay, (react && lay === 'big') || soloOn);
    this.holdStep(dt, react, lay);
    // screens: big centre vs solo side. Passthrough: the hole opens only once the camera has settled on that layout's
    // shot (so a fixed Window Capture lines up). In-scene capture: the window is ON the surface — no waiting.
    this.applyScreenLook();
    this.pumpVideo();
    // (any settled camera: the hole event carries that shot's rect + corners, so OBS automation re-places the capture)
    const settled = this.inScene || (!this.rig.moving && this.rig.settledFor > 0.05 && !this.camWaiting && !this.liveShot);   // (a live camera never holds still for a fixed Window Capture)
    if (this.screen) {
      this.screen.target = (react && lay === 'big') || this.videoLay === 'big' ? 1 : 0;
      if (this.first) this.screen.finish(); else this.screen.update(dt, settled, this.time);
    }
    if (this.solo) {
      this.solo.target = soloOn || vidSolo ? 1 : 0;
      if (this.first) this.solo.finish(); else this.solo.update(dt, settled, this.time);
    }
    this.lights.update(dt, this.time);
    this.props?.tick(this.time);
    this.applyDip(dt);
    this.trackHole(lay);
    this.clips?.update((this.clipClock ?? roomClock)());
    this.syncLiveCamera();                 // (a live camera is on its clip-moved node this frame; the OBS page calls it again after the other engines)
    this.first = false;
  }

  /** React layout in effect: Auto = solo when exactly one performer is in the room. */
  layout(): ActiveLayout {
    const pref = this.state.reactLayout ?? 'auto';
    let inRoom = 0;
    for (const a of this.actors.values()) if (this.intent.get(a)) inRoom++;
    if (!inRoom) return this.screen ? 'big' : 'solo';                 // nobody to stand beside: the room's big screen
    if (pref === 'big') return this.screen ? 'big' : 'solo';
    if (pref === 'solo') return 'solo';
    // (auto: a solo two-shot that can't be clean here — the screen or the host hidden — uses the room's big screen)
    if (inRoom === 1 && this.screen && this.soloPoor && this.soloPoor === this.soloKey) return 'big';
    return inRoom === 1 || !this.screen ? 'solo' : 'big';
  }
  /** soloKey whose two-shot came out poor (not clear and costly): Auto React then uses the big screen. */
  private soloPoor = '';
  private judgeSolo(shot: TwoShot) { this.soloPoor = !shot.clear && shot.score > 2.5 ? this.soloKey : ''; }

  /** Solo layout chosen but its performer is still walking in: the screen waits until they're seated. */
  get soloPending(): boolean {
    if (this.layout() !== 'solo') return false;
    const t = this.soloTarget();
    return !!t && (this.mover.busy(t.actor) || !!this.soloJob || !this.solo);
  }

  private soloTarget(): { actor: SceneActor; spot: SpotInfo } | null {
    const f = this.focusActor();
    const spot = f ? this.intent.get(f) : null;
    return f && spot ? { actor: f, spot } : null;
  }

  /** Build (or re-place) the solo side screen for the solo performer's spot + solve its two-shot.
   *  An automatic placement is searched a few ms per frame; `now` finishes it immediately (React was asked for). */
  private ensureSolo(now = false) {
    const t = this.soloTarget();
    if (!t) return;
    const key = `${t.actor.key}:${t.spot.index}:${t.actor.scale.toFixed(3)}:${(this.state.avatarScale || 1).toFixed(2)}`;
    if (key !== this.soloKey) {
      // a different spot / size: retract the old rig first (when it's down), then rebuild
      if (this.solo && !this.solo.away) { this.solo.target = 0; return; }
      this.solo?.dispose();
      this.solo = null; this.soloShot = null; this.soloShotKey = '';
      this.soloKey = key;
      this.rays ??= new RoomRays(this.room);
      const place = this.authoredSolo(t.spot);
      if (place) this.buildSolo(place, null);
      else {
        const face = t.actor.drawnFaceAt(t.spot) ?? { center: t.spot.position.clone().setY(1.3), size: 0.24 };
        const bodyH = this.bodyOf(t.actor);
        this.soloJob = { key, actor: t.actor, gen: deriveSoloSteps({ spot: t.spot, face, bodyH, aspect: this.stage.camera.aspect || 16 / 9, rays: this.rays, openOk: this.skyOk }) };
      }
    }
    const job = this.soloJob;
    if (job && job.key === this.soloKey) {
      const t0 = performance.now();
      for (;;) {
        const r = job.gen.next();
        if (r.done) { this.soloJob = null; this.buildSolo(r.value.place, r.value.shot); break; }
        if (!now && performance.now() - t0 > 3) break;
      }
    }
    this.soloActor = t.actor;
  }

  private buildSolo(place: SoloPlacement, shot: TwoShot | null) {
    const floorY = place.floorY !== undefined ? place.floorY : (this.rays ??= new RoomRays(this.room)).floorBelow(place.center);
    this.solo = new SoloScreen({ ...place, floorY }, this.opts.screen, this.skins.solo);
    this.solo.onLand = () => { if (!this.videoLay) this.landAccent(); };
    this.root.add(this.solo.rig);
    this.lookKey = '';                                                  // re-apply the screen look to the new rig
    if (shot) { this.soloShot = shot; this.soloShotKey = `${(this.stage.camera.aspect || 16 / 9).toFixed(3)}|`; this.judgeSolo(shot); }
  }

  /** SCREEN_SOLO_xx / SCREEN_SOLO node, or scene.json soloScreens[SPOT_xx]. */
  private authoredSolo(spot: SpotInfo): SoloPlacement | null {
    const rays = this.rays ??= new RoomRays(this.room);
    const node = this.room.soloScreens.get(spot.index) ?? (() => {
      const g = this.room.soloScreens.get(-1);
      return g && g.center.distanceTo(spot.position) < 4.5 ? g : undefined;
    })();
    const j = this.info.soloScreens?.[spot.name];
    let p: { center: THREE.Vector3; yaw: number; width: number; source: string } | null = null;
    if (node) p = { ...node, source: 'node' };
    else if (j && Array.isArray(j.position) && j.position.length === 3 && j.position.every((v) => Number.isFinite(v))) {
      p = { center: this.room.root.localToWorld(new THREE.Vector3(...j.position)), yaw: THREE.MathUtils.degToRad(Number(j.yaw) || 0), width: THREE.MathUtils.clamp(Number(j.width) || 2.4, 0.8, 5), source: 'scene.json' };
    }
    if (!p) return null;
    const ceil = rays.ceilingAbove(p.center) ?? p.center.y + (p.width * 9 / 16) / 2 + 1.2;
    return { ...p, ceilingY: ceil };
  }

  /** The two-shot for the current solo rig (re-solved when the output aspect changes). */
  private soloPose(aspect: number): CamPose | null {
    const t = this.soloTarget();
    if (!this.solo || !t) return null;
    // everyone else in the room is a blocker too (a forced solo layout with guests present)
    const others = [...this.actors.values()].filter((a) => a !== t.actor && this.intent.get(a));
    const k = `${aspect.toFixed(3)}|${others.map((a) => this.intent.get(a)!.index).sort().join(',')}|${this.motionSig('solo')}`;
    if (!this.soloShot || this.soloShotKey !== k) {
      const face = t.actor.drawnFaceAt(t.spot) ?? { center: t.spot.position.clone().setY(1.3), size: 0.24 };
      const f = this.solo.frame();
      const bodyH = this.bodyOf(t.actor);
      const blockers = others.map((a) => {
        const s = this.intent.get(a)!;
        const top = (a.drawnFaceAt(s)?.center.y ?? s.position.y + bodyH * 0.85) + 0.18;
        return new THREE.Box3(new THREE.Vector3(s.position.x - 0.32, s.position.y, s.position.z - 0.32), new THREE.Vector3(s.position.x + 0.32, top, s.position.z + 0.32));
      });
      this.soloShot = solveTwoShot({ face, hostForward: t.spot.forward, bodyH, screen: f, aspect, rays: this.rays ??= new RoomRays(this.room), blockers, openOk: this.skyOk });
      this.soloShot = this.guardSolo(this.soloShot, t.actor, t.spot, f, aspect);
      if (!others.length) this.judgeSolo(this.soloShot);
      this.soloShotKey = k;
    }
    return this.soloShot.pose;
  }

  /** The solo React two-shot through the framing guarantee: the host's face box + head inside the solo safe area and the
   *  whole screen in the frame; a fix keeps the camera where it is (refit) or dollies it back. */
  private guardSolo(shot: TwoShot, a: SceneActor, spot: SpotInfo, f: { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number }, aspect: number): TwoShot {
    if (!this.framing.guard) return shot;
    const s = this.subjectOf(a, spot);
    if (!s) return shot;
    const across = new THREE.Vector3().crossVectors(UP, f.normal).normalize();
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => f.center.clone().addScaledVector(across, sx * f.width / 2).add(new THREE.Vector3(0, sy * f.height / 2, 0))));
    const fg = new FrameGuard(this.rays ??= new RoomRays(this.room), this.solverOf().probe);
    const people = this.presentSubjects().map((o) => o.s);
    const g = fg.guard(shot.pose, { family: 'solo', targets: [targetOf(s)], aspect, hard: corners, hardSafe: { x: 0.97, top: 0.97, bottom: 0.97, head: 1 }, motion: this.motionFor('solo'), rig: rigFor(s.rig ?? 'normal', this.framing.rigs ?? undefined), maxFov: 60,
      safe: safeFor('solo', this.framing.safe).fix, see: 0.75, people, blockers: people.filter((p) => p.key !== a.key), openOk: this.openOk });
    if (g.step === 'ok' && g.clean) return shot;
    // (the host hidden from the two-shot: a poor two-shot — React Auto uses the big screen; the performer cam rail shows them)
    if (!g.clean) return { ...shot, ...(g.step !== 'best-effort' ? { pose: g.pose } : {}), clear: false, score: Math.max(shot.score, 99) };
    // (no frame from there keeps the host's face in: a poor two-shot — React Auto then uses the room's big screen)
    if (g.step === 'best-effort') return { ...shot, clear: false, score: Math.max(shot.score, 99) };
    return { ...shot, pose: g.pose };
  }

  /** A performer's real standing height in the room (m): measured height × their scale — size classes (micro / macro)
   *  frame right; falls back to the room's avatarHeight × avatarScale. */
  private bodyOf(a: SceneActor): number {
    const h = (a.rest?.height ?? 0) * a.scale;
    return h > 0.05 ? h : (this.info.avatarHeight ?? 1.5) * (this.state.avatarScale || 1);
  }

  /** Landing accent: a short dip of every light (+ the light engine's own cue, if it has one). */
  private landAccent() {
    this.dip.t = 0.5;
    this.dip.base.clear();
    for (const o of this.stage.scene.children) {
      const l = o as THREE.Light;
      if (l.isLight && !l.name.startsWith('vtp:')) this.dip.base.set(l, l.intensity);
    }
    try { (this.lights as unknown as { cue?: (what: string) => void }).cue?.('screenLand'); } catch { /* optional hook */ }
  }
  private applyDip(dt: number) {
    if (this.dip.t <= 0) return;
    this.dip.t = Math.max(0, this.dip.t - dt);
    const k = this.dip.t / 0.5;                                        // 1 → 0
    const f = 1 - 0.5 * Math.sin(Math.PI * Math.min(1, (1 - k) * 1.6)) * (k > 0.2 ? 1 : k / 0.2);
    // stage lights: from their base (restored at the end); room lights: the engine rewrites them every frame
    for (const [l, b] of this.dip.base) l.intensity = this.dip.t > 0 ? b * f : b;
    if (this.dip.t > 0) for (const o of this.stage.scene.children) { const l = o as THREE.Light; if (l.isLight && l.name.startsWith('vtp:')) l.intensity *= f; }
    if (this.dip.t <= 0) this.dip.base.clear();
  }

  private trackHole(lay: ActiveLayout) {
    const s: ReactSurface | null = lay === 'solo' ? this.solo : this.screen;
    const holeLook = this.opts.screen === 'hole' && !this.inScene;
    const open = holeLook && !!s && s.holeOpen >= 1;
    const closed = !holeLook || ((!this.screen || this.screen.holeOpen <= 0) && (!this.solo || this.solo.holeOpen <= 0));
    const now = performance.now();
    if (open && ((!this.hole.open && now - this.holeBeat > 250) || now - this.holeBeat > 5000)) {
      // (first report, then a heartbeat every 5 s: the server ignores repeats, but a restarted server / a failed OBS call
      // catches up this way). Measured with the live camera at report time: a screen that isn't in the shot is NEVER
      // reported open, so OBS never places (or shows) a capture for a screen viewers can't see.
      this.holeBeat = now;
      const v = judgeSurface(s!.corners(this.stage.camera), this.stage.camera.aspect || 16 / 9);
      if (v.inShot) {
        if (this.hole.open && this.hole.layout !== lay) this.onHole?.(false, null, this.hole.layout, null);
        this.hole = { open: true, layout: lay };
        this.onHole?.(true, { ...v.rect, visible: true }, lay, v.quad);
      } else if (this.hole.open) {
        this.hole.open = false;
        this.onHole?.(false, null, this.hole.layout, null);
      }
    } else if (this.hole.open && closed) {
      this.hole.open = false;
      this.onHole?.(false, null, this.hole.layout, null);
    }
  }
  private holeBeat = 0;
  /** Is the OBS hole open right now (and for which layout)? */
  get holeState() { return { ...this.hole }; }

  // ---------------------------------------------------------------- react screen content (in-scene capture)
  private capture: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private videoTex: THREE.VideoTexture | null = null;
  private noSignal: THREE.CanvasTexture | null = null;
  private lookKey = '';
  /** A camera move is waiting for the passthrough hole to close. */
  private camWaiting = false;
  private srcAspect = 0;
  /** In-scene capture in effect: the window (or standby / NO SIGNAL) is drawn on the screen mesh — no OBS hole.
   *  Owner rule: the React window always looks like a real screen IN the room, never a misfit OBS box. So on OBS pages
   *  the passthrough hole is used only when OBS can line its Window Capture up exactly (passOk: the screen is in the
   *  shot, and it is straight-on or OBS has the corner-pin). Auto (2026-10): with OBS automation placing the capture and
   *  OBS answering, an exact hole is used FIRST (nativePass: OBS's own capture stays smooth next to a GPU-heavy game;
   *  the in-room feed did not). Otherwise, while the helper's fast window feed is connecting / starting / running the
   *  screen stays in the room (standby → the picture); only a definite failure lets Auto use an exact passthrough. */
  get inScene() {
    if (this.videoLay) return true;                                     // the screen video is drawn on the surface: never a hole
    const m = this.state.screen?.mode ?? 'auto';
    // native passthrough first (2026-10, owner: "passthrough needs to be flawless"): when OBS automation places the
    // capture and the hole lines up EXACTLY (passOk), Auto uses OBS's own capture. The in-room feed (screen → CPU →
    // encode → this page → texture) starves next to a GPU-heavy game; OBS's capture does not. Still never a misfit box:
    // an angled / out-of-shot screen stays in the room, and so do the glass sheen / scanlines (a hole can't show them).
    if (this.nativePass && !this.capture) return false;
    if (m === 'inscene' || (m === 'auto' && (!!this.capture || !!this.feedTex))) return true;
    if (this.opts.screen !== 'hole') return false;                      // studio preview: the placeholder stands in for OBS
    if (m === 'auto' && (this.feedWait || this.standbyHold)) return true;
    return !this.passOk;
  }
  /** OBS passthrough could line up exactly with the React screen now: a composite layout's flat capture rect, or the
   *  3D screen in the shot and straight-on (or OBS warps the capture with the corner-pin) — and OBS automation hasn't
   *  refused to show a capture for this very shot (refusePass). */
  get passOk() { return this.composite ? !this.refusedNow : this.verdict.inShot && (this.passPin || this.verdict.exact) && !this.refusedNow; }
  /** OBS automation said it will NOT show a capture for the React screen's open hole (its own check on the OBS side: a
   *  box that can't match the corners there, no part of it on the OBS picture, no capture source set, a placement OBS
   *  failed …: POST / GET /api/obs/hole `refused`). This shot then draws the screen in the room (feed / shared window /
   *  NO SIGNAL) instead of an empty see-through hole — and so does a React Full / Medium capture rect (composite).
   *  Kept for this shot only (the camera's target pose, layout, screen, aspect: the verdict key; a composite rect: the
   *  stage layout + aspect): a new shot asks OBS again, and so does leaving React and coming back. */
  refusePass(why: string) {
    const k = this.refuseKey;
    if (!k || (this.refused?.key === k && this.refused.why === why)) return;
    this.refused = { key: k, why: why.slice(0, 200) };
    this.lookKey = '';
  }
  private get refuseKey() { return this.composite ? `stage|${this.state.stage?.react ?? ''}|${(this.stage.camera.aspect || 16 / 9).toFixed(3)}` : this.verdict.key; }
  private refused: { key: string; why: string } | null = null;
  private get refusedNow() { return !!this.refused && this.refused.key === this.refuseKey; }

  // ---- passthrough guard (see inScene)
  /** The helper's fast window feed as this page sees it (src/scene/screenFeed.ts feedVerdict): true = connecting,
   *  starting or running — Auto keeps the screen in the room. Set by the OBS page (src/output.ts). */
  private feedWait = false;
  /** OBS automation can warp the capture onto any screen (Perspective corner-pin + obs-shaderfilter; GET /api/obs/hole). */
  private passPin = false;
  setFeedWait(on: boolean) { if (on !== this.feedWait) { this.feedWait = on; this.lookKey = ''; if (on) { this.standbyHold = true; this.holdFor = 0; } } }
  setPassPin(on: boolean) { if (on !== this.passPin) { this.passPin = on; this.lookKey = ''; } }
  /** OBS automation is on with a capture source (GET /api/obs/hole `enabled`): it places the capture under the hole. */
  setObsAuto(on: boolean) { if (on !== this.obsAuto) { this.obsAuto = on; this.lookKey = ''; } }
  private obsAuto = false;
  /** Auto on an OBS page uses the exact native passthrough instead of the in-room feed (see inScene, nativePassFor). */
  get nativePass() {
    const sc = this.state.screen;
    return this.opts.screen === 'hole' && nativePassFor({ screenMode: sc?.mode ?? 'auto', fx: !!(sc?.scanlines || sc?.glass), obsAuto: this.obsAuto }) && this.passOk;
  }
  /** Auto, React entry: the feed's verdict (a definite no → the exact passthrough, else NO SIGNAL) often comes in while
   *  the camera is still moving to the React shot and the stage layout's inset is still growing — the shot passOk judges
   *  isn't final yet. Leaving the standby card then went "connecting…" → NO SIGNAL → the OBS hole (or hole → standby →
   *  hole). So the standby card is left only once the shot has settled (HOLD_STILL_S without a change; at most
   *  HOLD_MAX_S after the verdict): the screen changes ONCE, to what it will stay. */
  private standbyHold = false;
  private holdFor = 0;
  /** Seconds since the React screen's shot (judgeShot's key: camera target, layout, aspect, view) last changed. */
  private shotStill = 0;
  private holdStep(dt: number, react: boolean, lay: ActiveLayout) {
    if (this.feedWait || !this.standbyHold) { this.holdFor = 0; return; }
    this.holdFor += dt;
    const settled = !this.rig.moving && this.shotStill >= HOLD_STILL_S && this.verdict.layout === lay;
    if (!react || settled || this.holdFor >= HOLD_MAX_S || !!this.capture || !!this.feedTex) { this.standbyHold = false; this.lookKey = ''; }
  }
  /** The active React screen as the camera's (target) shot sees it — decides hole vs in-room picture before the hole
   *  could open. Kept while the screens are away, so leaving React never flips the look mid-retract. */
  private verdict: PassVerdict & { layout: ActiveLayout | null; key: string } = { layout: null, key: '', inShot: false, why: 'bad', rect: { x: 0, y: 0, w: 0, h: 0 }, err: Infinity, exact: false, quad: [] };
  private judgeCam = new THREE.PerspectiveCamera();
  private judgeShot(lay: ActiveLayout, want: boolean) {
    if (this.opts.screen !== 'hole' || !want) return;
    const s: ReactSurface | null = lay === 'solo' ? this.solo : this.screen;
    const t = this.rig.target ?? this.rig.current;
    if (!s || !t) return;
    const sc = this.stage.camera, vw = sc.view;
    const r = (v: number) => v.toFixed(4);
    const key = `${lay}|${s === this.solo ? this.soloKey : 'big'}|${t.position.toArray().map(r)}|${t.quaternion.toArray().map(r)}|${r(t.fov)}|${r(sc.aspect)}|${r(sc.zoom)}|${vw?.enabled ? [vw.fullWidth, vw.fullHeight, vw.offsetX, vw.offsetY, vw.width, vw.height].map(r).join(',') : ''}`;
    if (key === this.verdict.key) return;
    this.shotStill = 0;
    const cam = this.judgeCam;
    cam.copy(sc, false);
    cam.position.copy(t.position); cam.quaternion.copy(t.quaternion); cam.fov = t.fov;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    const was = this.passOk;
    this.verdict = { ...judgeSurface(s.corners(cam), sc.aspect || 16 / 9), layout: lay, key };
    if (this.passOk !== was) this.lookKey = '';
  }
  /** React mode: is the React screen in the shot the camera is (going) on? null = no React screen showing. The studio's
   *  Live panel says so plainly when it isn't ("press Auto or Screen"). */
  reactShot(): { layout: ActiveLayout | 'stage'; inShot: boolean; why: ShotWhy } | null {
    if (this.state.mode !== 'react' || this.interrupt || this.videoLay) return null;
    // React Full / Medium (a composite stage layout) draw the window in the frame whatever the room camera does
    if (this.composite) return { layout: 'stage', inShot: true, why: 'ok' };
    const lay = this.layout();
    const s: ReactSurface | null = lay === 'solo' ? this.solo : this.screen;
    const t = this.rig.target ?? this.rig.current;
    if (!s || !t || s.target < 0.5) return null;
    const cam = this.judgeCam, sc = this.stage.camera;
    cam.copy(sc, false);
    cam.position.copy(t.position); cam.quaternion.copy(t.quaternion); cam.fov = t.fov;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    const v = judgeSurface(s.corners(cam), sc.aspect || 16 / 9);
    return { layout: lay, inShot: v.inShot, why: v.why };
  }
  /** Why the React screen draws in the room / opens a hole right now (tests; the OBS page tells the helper, whose OBS
   *  panel says it in plain words — GET /api/obs/hole). */
  get passInfo() { return { inScene: this.inScene, passOk: this.passOk, feedWait: this.feedWait, hold: this.standbyHold, pin: this.passPin, inShot: this.verdict.inShot, exact: this.verdict.exact, why: this.verdict.why, err: Number.isFinite(this.verdict.err) ? Math.round(this.verdict.err * 10) / 10 : null, layout: this.verdict.layout, stage: this.composite, shows: this.screenShows, refused: this.refusedNow ? this.refused!.why : null }; }
  /** What the React screen shows: the OBS hole, the screen video, the window shared from the studio, the fast feed, the
   *  feed's standby card, or NO SIGNAL. */
  get screenShows(): 'hole' | 'video' | 'window' | 'feed' | 'standby' | 'nosignal' {
    if (this.videoLay) return 'video';
    if (!this.inScene) return 'hole';
    return this.videoTex ? 'window' : this.feedTex ? 'feed' : this.standby ? 'standby' : 'nosignal';
  }
  /** Seconds this room has run (tests: wait for room time, not wall time, on a slow headless renderer). */
  get clock() { return this.time; }
  /** Has a react surface (big SCREEN or the solo side screen) — the fast window feed is only fetched for these. */
  get hasReactSurface() { return !!this.screen || !!this.solo; }

  // the server's fast window feed (src/scene/screenFeed.ts): used when no window is shared from the studio
  private feedTex: THREE.Texture | null = null;
  private feedAspect = 0;
  setFeed(tex: THREE.Texture | null, aspect: number | null) {
    if (tex === this.feedTex && (aspect ?? 0) === this.feedAspect) return;
    this.feedTex = tex; this.feedAspect = aspect ?? 0;
    this.lookKey = '';
  }
  /** The shared window's <video> (debug / latency probes). */
  get captureVideo() { return this.video; }

  /** Can anything on this page draw the shared window right now? Asked by the OBS page (src/output.ts) so the studio can
   *  pause this page's encode while it cannot (screenShare.ts 'want'). Only a plain Talk room with both React screens away
   *  says no: every other mode may draw it (React, a stage layout's capture rect, Gaming, Interview's window guest ...).
   *  A screen still rolling up, or the screen video (its own texture, not this window) never counts. */
  get captureWanted(): boolean {
    if (this.state.mode !== 'talk' || this.composite || this.interrupt) return true;
    if (this.videoLay) return false;
    return !(this.screen?.away ?? true) || !(this.solo?.away ?? true);
  }

  /** The host's shared window (src/scene/screenShare.ts), or null. One VideoTexture for every screen: it's only uploaded
   *  when a visible screen draws it. */
  setCapture(stream: MediaStream | null) {
    if (stream === this.capture) return;
    this.capture = stream;
    this.videoTex?.dispose(); this.videoTex = null;
    if (this.video) { this.video.srcObject = null; this.video = null; }
    if (stream) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = stream;
      void v.play().catch(() => {});
      this.video = v;
      this.videoTex = new THREE.VideoTexture(v);
      this.videoTex.colorSpace = THREE.SRGBColorSpace;
      this.videoTex.generateMipmaps = false;
      this.videoTex.minFilter = THREE.LinearFilter;
      this.videoTex.anisotropy = Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy());   // readable at an angle
    }
    this.lookKey = '';
  }

  /** New decoded frame → re-upload. three.js only learns about frames via requestVideoFrameCallback, which doesn't
   *  fire in hidden / off-screen browsers (an OBS source that isn't shown, a minimised studio) — count frames instead. */
  private pumpVideo() {
    const v = this.video, t = this.videoTex;
    if (!v || !t || v.readyState < 2) return;
    const n = v.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
    const k = n >= 0 ? n : v.currentTime;
    if (k !== this.videoFrame) { this.videoFrame = k; t.needsUpdate = true; }
  }
  private videoFrame = -1;

  /** Hole (OBS passthrough) or content (in-scene window / NO SIGNAL / the studio preview placeholder). */
  private applyScreenLook() {
    const sc = sanitizeScreen(this.state.screen);
    const inScene = this.inScene;
    // the shared window's real aspect (letterboxed onto the 16:9 screen — never stretched)
    const vid = !!this.videoLay;
    const va = vid ? screenVideo.aspect : !inScene ? 0 : this.video && this.video.videoWidth > 0 ? +(this.video.videoWidth / this.video.videoHeight).toFixed(4) : !this.videoTex && this.feedTex ? this.feedAspect : 0;
    const standby = this.standby;
    const key = `${inScene}|${!!this.videoTex}|${this.feedTex?.uuid ?? ''}|${standby}|${sc.scanlines}|${sc.glass}|${!!this.solo}|${this.opts.screen}|${va}|${vid ? screenVideo.texture.uuid : ''}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    let src: THREE.Texture | null = null;
    if (vid) src = screenVideo.texture;
    else if (inScene) src = this.inScenePicture();
    const look: ScreenLook = this.opts.screen === 'hole' && !inScene ? 'hole' : 'preview';
    for (const s of [this.screen, this.solo] as (ReactSurface | null)[]) {
      if (!s) continue;
      s.setSource(src);                                                  // null + preview = the passthrough placeholder
      s.setLook(look);
      s.setExtras(sc.scanlines, sc.glass);
      s.setSourceAspect(va || null);
    }
    this.srcAspect = va;
  }

  private updateCamera(dt: number) {
    // live presets (extras.live / CAM_LIVE_*): their pose is re-read from the node every frame (rooms without any: no-op)
    const lives = this.liveList();
    for (const p of lives) refreshLivePreset(p);
    // walk-in follow camera (src/scene/walkMover.ts timeline) wins while someone is coming in
    const fc = this.followCamera();
    // (ambient cameras for Preshow / BRB / Outro: src/scene/ambientCam.ts — room directors come first)
    // The host's own pick (Live panel, shared/camPick.ts) beats every automatic source below the entrances: the room
    // directors, the ambient cameras and the screen-video cue wait until Auto / a mode or room change gives the camera back.
    const picked = handPicked(this.state);
    const aspect = this.stage.camera.aspect || 16 / 9;
    const ovr = fc ? null : picked ? this.entranceCamera?.(aspect) ?? null : this.cameraOverride?.(aspect) ?? ambientFor(this) ?? null;
    const follow = fc ?? (ovr ? { ...ovr, key: `ovr:${ovr.key}` } : null);
    const vid = follow || picked ? null : this.videoCamera();
    let { key, pose } = follow ?? vid ?? this.resolveCamera(this.pinnedCamera());
    const rawPose = pose;   // (before the quick-adjust: a live preset is matched on this)
    // the live camera quick-adjust for this angle (src/ui/cameraTweaks.ts; never on a director / follow / video shot)
    const angle = follow || vid ? null : this.angleNow(key);
    const tw = this.tweakFor(angle);
    this.liveTweak = tw && angle ? { tw, angle } : null;
    if (tw && angle) { pose = tweakPose(pose, tw, this.pivotDist(angle, pose)); key = `${key}~${tweakSig(tw)}`; }
    // a new shot while the passthrough hole is open: close the hole first (screens see "not settled"), then move — the
    // fixed Window Capture never slides; it reopens (with new corners for OBS automation) once the camera settles
    const holeUp = !this.inScene && ((this.solo?.holeOpen ?? 0) > 0 || (this.screen?.holeOpen ?? 0) > 0);
    this.camWaiting = key !== this.camKey && !this.first && holeUp;
    if (this.camWaiting) { this.rig.update(dt, this.stage.camera); return; }
    if (key !== this.camKey || this.first) {
      const soloMove = key.startsWith('solo:') || this.camKey.startsWith('solo:');
      let dur = this.first ? 0 : follow ? follow.secs : this.camKey.startsWith('ovr:') ? 0 : this.state.transition;   // (leaving a director shot = a cut)
      let arc: THREE.Vector3 | null = null;
      if (soloMove && !follow && !this.first && dur > 0) {
        // dolly out/in on a gentle arc: sideways (away from the host) + up, scaled to the move
        dur = SOLO_MOVE;
        const from = this.rig.current?.position ?? pose.position;
        const mv = pose.position.clone().sub(from).setY(0);
        const len = mv.length();
        if (len > 0.05) {
          const side = new THREE.Vector3().crossVectors(UP, mv).normalize();
          const host = this.soloActor?.mount.position;
          if (host && side.dot(host.clone().sub(from)) > 0) side.negate();
          arc = side.multiplyScalar(Math.min(0.55, len * 0.22)).add(new THREE.Vector3(0, Math.min(0.2, len * 0.06), 0));
        }
      }
      // a move whose straight path (or its mid-move lift) goes through the room's walls / furniture cuts instead
      if (dur > 0 && !this.first && this.rig.current && !follow) {
        const rays = this.rays ??= new RoomRays(this.room);
        const a = this.rig.current.position, b = pose.position;
        const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, Math.min(0.35, a.distanceTo(b) * 0.08), 0)).addScaledVector(arc ?? new THREE.Vector3(), 1);
        if (a.distanceTo(b) > 0.3 && (!rays.clear(a, mid) || !rays.clear(mid, b))) { dur = 0; arc = null; }
      }
      this.camKey = key;
      // (the next shot, before the cut / move: 2D models load sharper textures for a close-up: src/avatar/flat/rig2d/detailWatch.ts)
      try { dispatchEvent(new CustomEvent('vtp:camshot', { detail: { pose, dur } })); } catch { /* no page */ }
      // a shot that IS a live preset (state.camera / ?cam= hand the preset itself; a director like the raid's or the
      // kitchen's hands a copy): the rig follows that preset for as long as the shot (key) lasts
      this.liveShot = lives.length ? this.liveMatch(lives, rawPose) : null;
      // (a director's timed move may name where it starts from and how far in it is: a crane's high start, a push-in a late page joined)
      const fromT = follow && !fc ? ovr as { from?: CamPose; t0?: number } | null : null;
      this.rig.go(this.liveRigPose(pose), dur, arc, fromT?.from, fromT?.t0);
    } else this.rig.nudge(this.liveRigPose(pose));
    this.rig.update(dt, this.stage.camera);
    // the live drift guard (src/scene/frameGuard.ts): SceneRuntime's own people shots — or a director's shot that names
    // its subjects (cameraOverride `subjects`) — settled, no hole, not React
    const ovrSubs = !fc ? (ovr as { subjects?: string[] } | null)?.subjects ?? null : null;
    const liveOn = this.framing.live && this.framing.guard && !this.first && !fc && !this.rig.moving && this.rig.settledFor > 0.3 && !holeUp
      && this.state.mode !== 'react' && !this.composite && !this.interrupt && !this.liveShot && (ovrSubs ? true : !follow && /^(talk|group|wide)/.test(key));
    const fam: ShotFamily = key.startsWith('talk') ? 'talk' : 'group';
    this.live.update(dt, this.stage.camera, liveOn ? this.liveFaces(key, ovrSubs) : [], this.stage.camera.aspect || 16 / 9, liveOn, key, liveOn ? this.motionFor(fam === 'talk' ? 'talk' : 'group') : null,
      { family: ovrSubs && ovrSubs.length === 1 ? 'single' : fam, safe: this.framing.safe, set: this.framing.liveSet });
  }
  /** Live faces of the current shot's subjects (talk: the focus; group / wide: everyone in the room; a director shot:
   *  the keys it names), 10 Hz. */
  private liveFaces(key: string, subjects: string[] | null = null): LiveFace[] {
    if (this.time - this.liveFacesAt < 0.1 && this.liveFacesAt >= 0 && this.liveFacesKey === key) return this.liveFacesCache;
    this.liveFacesAt = this.time; this.liveFacesKey = key;
    const f = !subjects && key.startsWith('talk') ? this.focusActor() : null;
    const out: LiveFace[] = [];
    const pick = subjects ? subjects.map((k) => this.actors.get(k)).filter((a): a is SceneActor => !!a) : f ? [f] : [...this.actors.values()];
    for (const a of pick) {
      const spot = this.intent.get(a);
      if (!spot || !a.shown || !a.runtime || this.mover.busy(a)) continue;
      // (the drawn face, live: it follows the head — src/scene/faceDepth.ts)
      const lf = drawnFace(a.runtime);
      const s = lf ? this.subjectOf(a, spot) : null;
      if (!lf || !s) continue;
      const t: GuardTarget = targetOf(s);
      out.push({ key: a.key, center: lf.center.clone(), size: lf.size, top: t.top, ...(t.half ? { half: t.half } : {}) });
    }
    this.liveFacesCache = out;
    return out;
  }

  // ---------------------------------------------------------------- screen video
  /** Which screen plays the screen video now (null = none). */
  videoLay: ActiveLayout | null = null;
  /** The playing playlist asks to frame the screen ("Camera: show the screen"): the React shot of that screen. */
  private videoCamera(): { key: string; pose: CamPose } | null {
    const v = this.state.video;
    if (!this.videoLay || !v?.now || v.slots[v.now.slot]?.cam !== 'screen') return null;
    const aspect = this.stage.camera.aspect || 16 / 9;
    if (this.videoLay === 'solo') { const r = this.resolveCamera('react', aspect); return r.key.startsWith('solo:') ? r : null; }
    return { key: 'video:big', pose: this.room.cameras.get('CAM_REACT') ?? this.autoReact(aspect) };
  }
  /** Debug (vtpOut.scene.videoInfo): the screen video on this page. */
  get videoInfo() { return { lay: this.videoLay, screenDown: this.videoLay === 'big' ? this.screen?.landed : this.solo?.landed, ...screenVideo.info() }; }

  // ---------------------------------------------------------------- live (moving) camera presets
  private lives: CameraPreset[] | null = null;
  /** The live preset the current shot rides (null = an ordinary shot). */
  private liveShot: CameraPreset | null = null;
  private liveList(): CameraPreset[] { return (this.lives ??= livePresets(this.room)); }
  private liveMatch(lives: CameraPreset[], pose: CamPose): CameraPreset | null {
    for (const p of lives) if (p === pose) return p;
    for (const p of lives) if (p.position.distanceToSquared(pose.position) < 1e-8 && Math.abs(p.quaternion.dot(pose.quaternion)) > 0.9999999 && Math.abs(p.fov - pose.fov) < 1e-3) return p;
    return null;
  }
  /** The Room editor's live quick-adjust on the live shot (null = none): re-applied each frame on top of the moving pose. */
  private liveTweak: { tw: CamTweak; angle: string } | null = null;
  /** What the rig should follow this frame: the live preset itself while the shot is one (so a director's stale copy never
   *  freezes it), with the quick-adjust on top when the user set one; else the shot's own pose. */
  private liveRigPose(pose: CamPose): CamPose {
    const L = this.liveShot;
    if (!L) return pose;
    const t = this.liveTweak;
    return t ? tweakPose(L, t.tw, this.pivotDist(t.angle, L)) : L;
  }
  /** Is the camera riding a live preset right now (debug / tests)? Its name, else null. */
  get liveCamera(): string | null { return this.liveShot?.name ?? null; }
  /** Call once per frame AFTER every engine has moved the room (room clips run at the end of update(); the town / epoch
   *  engines bob ships after it): re-reads the live presets and puts a settled live shot exactly on its node, so a
   *  cockpit camera doesn't trail its ship by a frame. Rooms without live presets: no-op. */
  syncLiveCamera() {
    const lives = this.liveList();
    if (!lives.length) return;
    for (const p of lives) refreshLivePreset(p);
    if (this.liveShot && !this.rig.moving) { this.rig.nudge(this.liveRigPose(this.liveShot)); this.rig.update(0, this.stage.camera); }
  }
  /** The camera choice in effect: this page's pin (?cam=) when the room has it, else the host's state.camera. The pin is
   *  for a plain Talk shot only: React's cameras belong to the screen and the single OBS Window Capture (a pinned page
   *  must not move them), and a stage layout (`composite`) or a raid interrupt owns the frame. Then the host's choice. */
  private pinnedCamera(): string {
    const pin = this.cameraPin;
    if (pin && this.state.mode === 'talk' && !this.composite && !this.interrupt && ((CAMERA_CHOICES as readonly string[]).includes(pin) || this.room.cameras.has(pin))) return pin;
    return this.state.camera;
  }

  private follow = new FollowPlanner();
  private followOps: { id: string; ops: FollowOperator[] } = { id: '', ops: [] };
  /** Debug: the follow camera's plan (vtpOut.scene.followInfo). */
  get followInfo() { return this.follow.debug; }
  /** "Follow entrance" (state.follow: host / guests): the authored CAM_DOOR while they come through the door (only
   *  when its view stays inside the set), then operators that pan + zoom with the walk and never look at the
   *  unmodelled outside (src/scene/followCam.ts); the normal camera returns once they're seated. Driven by the
   *  mover's timeline, so every page cuts at the same moment. */
  private followCamera(): { key: string; pose: CamPose; secs: number } | null {
    const fo = this.state.follow;
    if (fo && (fo.host || fo.guests) && this.mover.followCamera) {
      const own = this.mover.followCamera(fo, this.stage.camera.aspect || 16 / 9, (a) => !!this.intent.get(a));
      if (own !== undefined) {
        // (a room mover's own entrance cinematic — a cryo pod, a drop pod: once the performer is in the room, the framing
        // guarantee keeps their face in the shot — the cinematic's position, re-aimed / widened just enough)
        if (!own || !this.mover.tracks) return own;
        const tr = this.mover.tracks().find((x) => x.kind === 'enter' && x.t >= x.through && !!this.intent.get(x.actor));
        return tr ? { ...own, pose: this.guardFollow(own.pose, tr.actor, this.stage.camera.aspect || 16 / 9) } : own;
      }
    }
    if (!fo || (!fo.host && !fo.guests) || !this.mover.tracks) return null;
    let best: MoverTrack | null = null;
    for (const tr of this.mover.tracks()) {
      if (tr.kind !== 'enter' || tr.t < 0 || tr.t > tr.arrive + 0.4 || !this.intent.get(tr.actor)) continue;
      if (!(tr.actor.key === HOST_KEY ? fo.host : fo.guests)) continue;
      if (!best || tr.t > best.t) best = tr;
    }
    if (!best) return null;
    const a = best.actor;
    const spot = this.intent.get(a)!;
    const aspect = this.stage.camera.aspect || 16 / 9;
    // operators (fixed points that pan + zoom with the walker) and a plan that keeps the view inside the set
    // (src/scene/followCam.ts): CAM_WIDE's spot, CAM_DOOR, the other presets, the destination's talk camera
    const h = (a.rest?.height ?? 1.6) * a.scale;
    const id = `${a.key}:${spot.index}:${best.through.toFixed(2)}:${best.arrive.toFixed(2)}:${aspect.toFixed(2)}`;
    if (this.followOps.id !== id) {
      const extra: { name: string; pos: THREE.Vector3 }[] = [];
      if (spot.cam) extra.push({ name: 'spotcam', pos: spot.cam.position });
      extra.push({ name: 'talk', pos: this.talkShot(a, spot, aspect).pose.position });
      this.followOps = { id, ops: followOperators(this.room, extra, this.autoWide(aspect).position, this.roomCenter()) };
    }
    const seated = this.presentSubjects().filter((o) => o.a !== a && !this.mover.busy(o.a)).map((o) => o.s);
    const env = { room: this.room, rays: this.rays ??= new RoomRays(this.room), probe: this.solverOf().probe, skyOk: this.skyOk, voidOk: this.voidOk, aspect,
      operators: this.followOps.ops, seated, door: this.room.cameras.get('CAM_DOOR') ?? null };
    const mv = this.mover;
    // (the drawn face at rest, scaled: what the plan checks the operators can see - src/scene/followCam.ts)
    const rr = a.rest, rf = rr ? rr.drawn ?? rr.face : null;
    const faceY = rr && rf ? (rf.center.y - rr.floorY) * a.scale : undefined, faceSize = rf ? rf.size * a.scale : undefined, faceFwd = rf ? rf.center.z * a.scale : 0;
    const r = this.follow.shot(env, { id, t: best.t, through: best.through, arrive: best.arrive, height: h, now: a.mount.position.clone(), at: mv.samplePath ? (t) => mv.samplePath!(a, t) : null,
      ...(faceY !== undefined && faceY > 0 ? { faceY, faceSize, faceFwd } : {}) }, `follow:${a.key}`);
    return r ? { ...r, pose: this.guardFollow(r.pose, a, aspect), secs: 0 } : null;
  }
  /** The framing guarantee on each follow-camera step: the walker's live face inside the group safe area — the operator
   *  pans / zooms just enough from where it stands (a refit, never a new position: the plan keeps the view in the set). */
  private guardFollow(pose: CamPose, a: SceneActor, aspect: number): CamPose {
    if (!this.framing.guard || FrameGuard.off || !a.runtime) return pose;
    const df = drawnFace(a.runtime);
    if (!df) return pose;
    // (a room's own entrance cinematic whose camera passes through a wall / a prop for a moment — a chase camera behind
    // a giant in a corridor: pulled in along its line to the walker's face, in front of the surface it is in; failing
    // that the room's wide. A pure function of where the cinematic puts it: every page does the same)
    const probe = this.solverOf().probe;
    let moved = false;
    if (probe.inside(pose.position)) {
      const rays = this.rays ??= new RoomRays(this.room);
      const to = pose.position.clone().sub(df.center), L = to.length();
      const hit = L > 0.3 ? rays.hit(df.center, pose.position, 0.1) : Infinity;
      const p2 = hit !== Infinity && hit > 0.45 ? df.center.clone().addScaledVector(to.normalize(), hit - 0.15) : null;
      pose = p2 && !probe.inside(p2) ? lookPose(p2, df.center, pose.fov) : this.room.cameras.get('CAM_WIDE') ?? this.autoWide(aspect);
      moved = true;
    }
    const f = { center: df.center, size: df.size };
    const r = a.rest, dy = r?.drawn ? r.face.center.y - r.drawn.center.y : 0;
    const top = r?.head ? Math.max(f.size * 1.15, Math.min((r.head.top + dy) * a.scale, f.size * 4)) : f.size * 1.15;
    const req = { family: 'group' as const, targets: [{ key: a.key, face: f, top }], aspect, safe: safeFor('group', this.framing.safe).fix, maxFov: Math.max(pose.fov, 62), motion: this.motionFor('group') };
    const fg = new FrameGuard(null, null);
    if (fg.check(pose, req).ok) return pose;
    const rf = fg.refit(pose, req);
    // (pulled in out of a wall and too close to frame them: the room's wide, framed on them)
    if (moved && (!rf || rf.clamped)) { const w = this.room.cameras.get('CAM_WIDE') ?? this.autoWide(aspect); return fg.refit(w, req)?.pose ?? w; }
    return rf?.pose ?? pose;
  }

  // ---------------------------------------------------------------- cameras
  /** Every camera choice this room offers: built-ins + CAM_* presets. */
  cameraNames(): string[] {
    return [...CAMERA_CHOICES.filter((c) => (c !== 'react' && c !== 'screen') || this.screen || this.room.cameras.has('CAM_REACT') || (c === 'screen' && this.solo)), ...[...this.room.cameras.keys()].filter((n) => n !== 'CAM_WIDE' && n !== 'CAM_REACT')];
  }

  /** Target pose for a camera choice + a key that changes when the shot is a different one. */
  resolveCamera(choice: string, aspect = this.stage.camera.aspect || 16 / 9): { key: string; pose: CamPose } {
    const presets = this.room.cameras;
    const wide = () => ({ key: 'wide', pose: presets.get('CAM_WIDE') ?? this.autoWide(aspect) });
    if (choice === 'talk') {
      const a = this.focusActor();
      const spot = a ? this.intent.get(a) : null;
      if (!a || !spot) return this.resolveCamera('group', aspect);
      return this.talkShot(a, spot, aspect);
    }
    if (choice === 'group') {
      const shown = [...this.actors.values()].filter((a) => this.intent.get(a));
      if (!shown.length) return wide();
      return this.groupShot(shown, aspect);
    }
    if (choice === 'react') {
      if (this.layout() === 'solo') {
        const t = this.soloTarget();
        if (t && this.mover.busy(t.actor)) return wide();           // walking in: the pull-out starts once seated
        this.ensureSolo(this.state.mode === 'react');
        const sp = this.soloPose(aspect);
        if (sp && t && this.layout() === 'solo') return { key: `solo:${t.spot.index}`, pose: sp };
      }
      const p = presets.get('CAM_REACT') ?? (this.screen ? this.autoReact(aspect) : null);
      return p ? { key: 'react', pose: p } : wide();
    }
    if (choice === 'wide') return this.wideShot(aspect);
    if (choice === 'screen') {
      // "Screen": the screen that shows something (the screen video's, else the React window's), square-on and centred
      // (nothing on a screen — they're rolled up: the wide shot)
      const lay = this.videoLay ?? (this.state.mode === 'react' ? this.layout() : null);
      if (lay === 'solo' && this.solo) return { key: `screen:solo:${this.soloKey}`, pose: this.screenPose(this.solo.frame(), aspect) };
      if (lay === 'big' && this.screen) return { key: 'screen:big', pose: this.screenPose(this.screen.frame(this.viewerPoint()), aspect) };
      return wide();
    }
    const p = presets.get(choice);
    return p ? { key: choice, pose: p } : wide();
  }

  private focusActor(): SceneActor | null {
    const o = SceneRuntime.focusHook?.(this);
    if (o && this.intent.get(o)) return o;
    const f = this.actors.get(this.state.focus) ?? this.actors.get(HOST_KEY);
    if (f && this.intent.get(f)) return f;
    return [...this.actors.values()].find((a) => this.intent.get(a)) ?? null;
  }

  /** Middle of where the people are (spots), else the bounds centre - rooms may ship big exterior geometry. */
  private roomCenter() {
    const sp = this.room.spots.filter((s): s is SpotInfo => !!s);
    if (sp.length) return sp.reduce((a, s) => a.add(s.position), new THREE.Vector3()).multiplyScalar(1 / sp.length).setY(1.2);
    return this.room.bounds.isEmpty() ? new THREE.Vector3(0, 1.2, 0) : this.room.bounds.getCenter(new THREE.Vector3());
  }

  /** A point on the audience side of the room (which way the screen faces): CAM_REACT / CAM_WIDE, else where the
   *  spots are, else the bounds centre (unreliable when a room ships exterior geometry). */
  private viewerPoint(): THREE.Vector3 {
    const c = this.room.cameras.get('CAM_REACT') ?? this.room.cameras.get('CAM_WIDE');
    return c ? c.position.clone() : this.roomCenter();
  }

  // ---------------------------------------------------------------- automatic framing (src/scene/shotSolver.ts)
  private solver: ShotSolver | null = null;
  private shotCache = new Map<string, ShotResult & { key: string }>();
  /** Last solved talk / group shots (debug: vtpOut.scene.shotInfo). */
  get shotInfo() { return [...this.shotCache.values()].slice(-6).map((r) => ({ key: r.key, source: r.source, score: +r.score.toFixed(2), notes: r.notes })); }
  private solverOf() { return (this.solver ??= new ShotSolver(this.room, this.rays ??= new RoomRays(this.room))); }
  /** A performer settled at a spot, for the framing solver (real face + height: micro / macro performers frame right). */
  private subjectOf(a: SceneActor, spot: SpotInfo): ShotSubject | null {
    // (the DRAWN face: a mascot whose eye bones sit deep in a big head is framed on the face it shows — faceDepth.ts)
    const df = a.drawnFaceAt(spot);
    if (!df) return null;
    const face = { center: df.center, size: df.size };
    const r = a.rest;
    const cls = this.classOf(a);
    // (head top / half are measured from the reported face centre: re-based on the drawn one)
    const dy = r?.drawn ? r.face.center.y - r.drawn.center.y : 0;
    let top = r ? Math.max(0, (restTopAbove(r) + dy) * a.scale, ((r.head?.top ?? 0) + dy) * a.scale) : undefined;
    let half = r?.head ? r.head.half * a.scale : undefined;
    // a mech / vehicle: the framed head is the PILOT's (their face markers), never the hull above it; the hull is framed
    // whole in group shots (the rig's `group: 'hull'`)
    let hull: { top: number; half: number } | undefined;
    if (cls === 'mech') {
      top = Math.min(r?.head ? r.head.top * a.scale : face.size * 1.8, face.size * 1.8); half = Math.min(half ?? face.size, face.size * 1.2);
      if (r && rigFor('mech', this.framing.rigs ?? undefined).group === 'hull') {
        let w = r.height * 0.3 * a.scale;
        const b = a.restBoxAt(spot);
        if (b && !b.isEmpty()) w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
        hull = { top: r.height * a.scale, half: Math.min(w, r.height * a.scale) };
      }
    }
    // (a mech's hull as a body box at the spot: it hides what is behind it, a camera never goes inside it — from the rest
    // box, never the live bounds: an idle wing beat / a gait must not change the shot, every page solves the same)
    let body: THREE.Box3 | undefined;
    if (cls === 'mech') { const b = a.restBoxAt(spot); if (b && !b.isEmpty() && b.containsPoint(face.center.clone().setY((b.min.y + b.max.y) / 2))) body = b; }
    // (the drawn surface in front of the drawn centre — a snout, a nose: line of sight aims at it)
    const depth = df.depth;
    // (a 2D card: the art it draws; its head ends where the art does — a face box / head top guessed from the face size
    // reached past it and pushed the framing out)
    const art = a.cardArtAt(spot);
    if (art) { const above = Math.max(0.02, art.top - face.center.y); face.size = Math.min(face.size, above / FACE_BOX.up); top = Math.min(top ?? above, above); }
    return { key: a.key, face, floor: spot.position.clone(), height: (r?.height ?? 1.6) * a.scale, forward: spot.forward.clone(), sit: spot.pose === 'sit', top,
      ...(half !== undefined ? { headHalf: half } : {}), ...(cls !== 'normal' ? { rig: cls } : {}), ...(hull ? { hull } : {}), ...(body ? { body } : {}), ...(depth > 0.005 ? { depth } : {}),
      ...(df.head !== df.center ? { head: df.head } : {}), ...(art ? { art: { bottom: art.bottom, top: art.top, bust: art.bust, half: art.half, base: art.base } } : {}) };
  }
  /** A performer at their seat as the framing solver sees them (real face, head, size class, a mech's hull), or null —
   *  for engines that frame people themselves (the TTRPG director, a voyage cutaway). */
  subjectFor(key: string): ShotSubject | null {
    const a = this.actors.get(key), spot = a ? this.intent.get(a) : null;
    return a && spot ? this.subjectOf(a, spot) ?? this.seatSubject(a, spot) : null;
  }
  /** Which view rays may meet nothing in this room (framing guarantee): a void / space room, an outdoor room, indoors. */
  get openOk(): 'all' | 'sky' | 'none' { return this.voidOk ? 'all' : this.skyOk ? 'sky' : 'none'; }
  /** The framing guarantee's settings for a solver request (src/scene/frameGuard.ts). */
  private guardOpts(family: 'talk' | 'group' | 'wide', rig?: FramingClass) {
    const f = this.framing;
    return { off: !f.guard, motion: this.motionFor(family), rigs: f.rigs, safe: f.safe, wide: this.room.cameras.get('CAM_WIDE') ?? null, rig: rig ? rigFor(rig, f.rigs ?? undefined) : null };
  }
  /** Shot-cache key part for the motion envelope (a battle's deck kick re-solves with more margin): every cache of a
   *  guarded shot keys on it (tile cams, the TTRPG table, the solo React two-shot). */
  motionSig(family: Parameters<NonNullable<typeof SceneRuntime.motionHook>>[1]): string {
    // (the envelope is already on a MOTION_LEVELS step: this changes only when it crosses one)
    const m = this.motionFor(family);
    return m ? `m${Math.round(m.heave * 1000)}.${Math.round(m.roll * 100)}.${Math.round(m.pitch * 100)}.${Math.round(m.yaw * 100)}.${Math.round(m.kick * 100)}` : '';
  }
  /** Estimated subject from the seat and the shown height (no face metrics). */
  private seatSubject(a: SceneActor, spot: SpotInfo): ShotSubject {
    const h = (a.rest?.height ?? 1.6) * a.scale, sit = spot.pose === 'sit';
    const size = Math.max(0.06, h * 0.14);
    return { key: a.key, face: { center: spot.position.clone().add(new THREE.Vector3(0, h * (sit ? 0.62 : 0.9), 0)), size }, floor: spot.position.clone(), height: h, forward: spot.forward.clone(), sit, top: size * 1.2 };
  }
  private presentSubjects(): { a: SceneActor; s: ShotSubject }[] {
    const out: { a: SceneActor; s: ShotSubject }[] = [];
    for (const a of this.actors.values()) {
      const sp = this.intent.get(a);
      const s = sp ? this.subjectOf(a, sp) : null;
      if (s) out.push({ a, s });
    }
    return out;
  }
  /** Upward rays that meet no room surface are fine only where an engine draws a sky (environment / epoch void / town /
   *  space): indoors that is a missing ceiling, and the backdrop colour shows through. */
  private get skyOk() { const j = this.info as unknown as Record<string, unknown>; return !!(j.environment || j.epoch || j.town || j.space); }
  /** Rooms whose designed backdrop IS the open void in every direction (a floating plaza at the end of time, a bridge in
   *  orbit): rays that leave the set are scenery there, not holes. */
  private get voidOk() { const j = this.info as unknown as Record<string, unknown>; return !!(j.epoch || j.space); }
  private cached(ck0: string, key: string, solve: () => ShotResult): { key: string; pose: CamPose } {
    // (generated set pieces — the interview desk / monitor, re-planned when the host changes size — are room occluders
    // too: a shot solved round the old set must never be re-used with the new one)
    const ck = `${ck0}|set${this.seatEnv.ver}.${this.setVer}`;
    let r = this.shotCache.get(ck);
    if (!r) {
      if (this.shotCache.size > 48) this.shotCache.clear();
      const res = solve();
      // the key changes with the pose, so a re-solved shot (someone sat down in the way) moves like any other change
      const p = res.pose.position, q = res.pose.quaternion;
      r = { ...res, key: `${key}#${[p.x, p.y, p.z].map((v) => Math.round(v * 50)).join(',')},${[q.x, q.y, q.z].map((v) => Math.round(v * 500)).join(',')},${Math.round(res.pose.fov * 2)}` };
      this.shotCache.set(ck, r);
    }
    return { key: r.key, pose: r.pose };
  }
  private rosterSig(): string {
    // (who sits where, at what size, as which framing class (a large performer's rig is not a normal one's), on which
    // model (a swapped avatar of the same size has another face): a cached shot is never another roster's)
    // (+ a 2D card's art box: it is measured again when an outfit / slider set changes what it draws)
    const art = (a: SceneActor) => { const b = a.rest?.card?.box; return b ? `:${b.min.x.toFixed(3)},${b.max.x.toFixed(3)},${b.max.y.toFixed(3)}` : ''; };
    // (one pass, one array: this runs several times per frame from the shot caches' keys - no spread / filter / map copies)
    const parts: string[] = [];
    for (const a of this.actors.values()) { const sp = this.intent.get(a); if (sp) parts.push(`${sp.index}:${a.scale.toFixed(3)}:${this.classOf(a)}:${rtTag(a.runtime)}${art(a)}`); }
    return parts.sort().join(',');
  }

  /** Talk: the authored SPOT_xx_CAM when it sees the face (re-aimed to the real face), else the solver's best
   *  medium shot around "16° off axis towards the room centre" — never through a wall, from behind one, or past
   *  someone sitting in the way. */
  private talkShot(a: SceneActor, spot: SpotInfo, aspect: number): { key: string; pose: CamPose } {
    // a LIVE talk camera (SPOT_xx_CAM with extras.live: a seat that moves, e.g. a pilot's seat in a flying ship) is used
    // as authored — never re-aimed or cached, it's re-read every frame
    if (spot.cam?.live) return { key: `talk:${spot.index}:live`, pose: spot.cam };
    const ck = `talk|${a.key}|${spot.index}|${aspect.toFixed(3)}|${this.rosterSig()}|${this.motionSig('talk')}`;
    return this.cached(ck, `talk:${spot.index}`, () => {
      const me = this.subjectOf(a, spot);
      if (!me) return { pose: spot.cam ?? this.autoTalk(a, spot, aspect), score: 0, source: spot.cam ? 'authored' : 'auto', notes: ['no face metrics'] };
      const toCenter = this.roomCenter().sub(spot.position).setY(0);
      const side = Math.sign(new THREE.Vector3().crossVectors(spot.forward, toCenter).y) || 1;
      const prefer = spot.forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(16) * side);
      const others = this.presentSubjects().filter((o) => o.a !== a).map((o) => o.s);
      return this.solverOf().solve({ kind: 'talk', subjects: [me], others, prefer, aspect, skyOk: this.skyOk, voidOk: this.voidOk, seed: spot.cam, guard: this.guardOpts('talk', me.rig) });
    });
  }

  /** Group: everyone present, from CAM_WIDE's side of the room (±36°, 3–26° down), nobody hidden, inside the set. */
  private groupShot(list: SceneActor[], aspect: number): { key: string; pose: CamPose } {
    const idx = list.map((a) => this.intent.get(a)!.index).sort((x, y) => x - y).join(',');
    const ck = `group|${aspect.toFixed(3)}|${this.rosterSig()}|${this.motionSig('group')}`;
    return this.cached(ck, `group:${idx}`, () => {
      // (a performer without face metrics yet — still loading, a model without markers: estimated from their seat and
      // height, so they are framed too instead of the whole group falling back to the blind autoGroup)
      const subs = list.map((a) => this.subjectOf(a, this.intent.get(a)!) ?? this.seatSubject(a, this.intent.get(a)!));
      if (!subs.length) return { pose: this.autoGroup(list, aspect), score: 0, source: 'auto', notes: ['no face metrics'] };
      const wideP = this.room.cameras.get('CAM_WIDE');
      const prefer = wideP ? new THREE.Vector3(0, 0, 1).applyQuaternion(wideP.quaternion).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
      const req = { kind: 'group' as const, subjects: subs, others: [], prefer, aspect, skyOk: this.skyOk, voidOk: this.voidOk, guard: this.guardOpts('group') };
      const res = this.solverOf().solve(req);
      // nothing sees them together (seats behind walls from each other): the room's authored wide shot, if it does better
      if (res.score > 10 && wideP) {
        const ws = this.solverOf().score(wideP, req, 0, 0);
        if (ws.score < res.score) return { pose: wideP, score: ws.score, source: 'authored', notes: [...ws.notes, 'CAM_WIDE (the solver found nothing better)'] };
      }
      return res;
    });
  }

  /** Wide: the room's authored CAM_WIDE (else the automatic one), kept exactly while every present performer's head is
   *  in it. Someone it doesn't reach (a seat outside the authored view): the same position, re-aimed and widened just
   *  enough to add them with the authored view still inside; when that needs a lens wider than 75° (seats behind the
   *  camera, another area), the group shot — the wide choice never leaves someone out or half cut at the edge. */
  private wideShot(aspect: number): { key: string; pose: CamPose } {
    const base = this.room.cameras.get('CAM_WIDE') ?? this.autoWide(aspect);
    const list = [...this.actors.values()].filter((a) => this.intent.get(a));
    if (!list.length) return { key: 'wide', pose: base };
    const ck = `wide|${aspect.toFixed(3)}|${this.rosterSig()}|${this.motionSig('wide')}`;
    return this.cached(ck, 'wide', () => this.guardWide(this.wideSolve(base, list, aspect), list, aspect));
  }
  /** The wide shot through the framing guarantee: every face inside the wide family's safe area (a face on the
   *  fringe of the authored wide → the same position, re-aimed / widened; else the guard's ladder). */
  private guardWide(r: ShotResult, list: SceneActor[], aspect: number): ShotResult {
    if (!this.framing.guard) return r;
    const subs = list.map((a) => this.subjectOf(a, this.intent.get(a)!) ?? this.seatSubject(a, this.intent.get(a)!));
    const fg = new FrameGuard(this.rays ??= new RoomRays(this.room), this.solverOf().probe);
    const g = fg.guard(r.pose, { family: 'wide', targets: subs.map(targetOf), aspect, blockers: subs, motion: this.motionFor('wide'), safe: safeFor('wide', this.framing.safe).fix, see: 0.75, people: subs,
      openOk: this.voidOk ? 'all' : this.skyOk ? 'sky' : 'none', rig: rigFor(subs.some((s) => s.rig === 'macro' || s.rig === 'mech') ? 'macro' : 'normal', this.framing.rigs ?? undefined),
      wide: null, facing: subs.map((s) => s.forward), maxFov: 75 });
    if (g.step === 'ok' && g.clean) return r;
    // (nothing clean from the wide — someone cut, or hidden behind a giant / a prop: the group shot, which frames everyone
    // by construction and searches every side of the room for a view that shows them all)
    if (g.step === 'best-effort' || !g.clean) { const gr = this.groupShot(list, aspect); return { ...r, pose: gr.pose, notes: [...r.notes, 'guard: the wide cuts / hides someone → the group shot', ...g.notes] }; }
    return { ...r, pose: g.pose, notes: [...r.notes, `guard: ${g.step}`, ...g.notes] };
  }
  private wideSolve(base: CamPose, list: SceneActor[], aspect: number): ShotResult {
    {
      const t0 = performance.now();
      const subs = list.map((a) => this.subjectOf(a, this.intent.get(a)!) ?? this.seatSubject(a, this.intent.get(a)!));
      const cam = new THREE.PerspectiveCamera(base.fov, aspect, 0.03, 500);
      cam.position.copy(base.position); cam.quaternion.copy(base.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      // heads (top, face, both sides) of everyone: all of them inside the frame, off its very edge
      const heads: THREE.Vector3[] = [];
      for (const s of subs) {
        const side = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize().multiplyScalar(Math.max(s.face.size * 0.62, s.headHalf ?? 0));
        heads.push(s.face.center.clone().add(new THREE.Vector3(0, Math.max(s.top ?? 0, s.face.size * 1.15), 0)), s.face.center.clone().add(side), s.face.center.clone().sub(side));
      }
      const inView = (c: THREE.Camera, k: number) => heads.every((p) => { const q = p.clone().project(c); return q.z < 1 && Math.abs(q.x) < k && Math.abs(q.y) < k; });
      // (and nobody's face mostly hidden — behind a big guest in the front row, a pillar)
      const req = { kind: 'group' as const, subjects: subs, others: [], prefer: new THREE.Vector3(0, 0, 1), aspect, skyOk: this.skyOk, voidOk: this.voidOk };
      const seen = (pose: CamPose) => !this.solverOf().score(pose, req, 0, 0).notes.some((n) => { const m = / hidden (\d)\/5$/.exec(n); return !!m && +m[1] >= 3; });
      if (inView(cam, 0.97) && seen(base)) return { pose: base, score: 0, source: 'authored', notes: ['the authored wide shows everyone', `${(performance.now() - t0).toFixed(1)} ms`] };
      // widen from the same spot: everyone's head + shoulders, and the authored frame's corners at the group's depth
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const depth = Math.max(1.5, subs.reduce((a, s) => a + Math.max(0.5, s.face.center.clone().sub(base.position).dot(fwd)), 0) / subs.length);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
        const d = new THREE.Vector3(x, y, 0.5).unproject(cam).sub(base.position).normalize();
        return base.position.clone().addScaledVector(d, depth / Math.max(0.2, d.dot(fwd)));
      });
      const fp = frameFrom(base.position, [...groupPoints(subs), ...corners], aspect, { safeX: 0.86, safeTop: 0.9, safeBot: 0.97, minFov: base.fov, maxFov: 75 });
      if (fp) {
        const c2 = new THREE.PerspectiveCamera(fp.fov, aspect, 0.03, 500);
        c2.position.copy(fp.position); c2.quaternion.copy(fp.quaternion); c2.updateMatrixWorld(); c2.updateProjectionMatrix();
        if (inView(c2, 0.92) && seen(fp)) return { pose: fp, score: 0, source: 'auto', notes: [`the authored wide widened ${base.fov.toFixed(0)}° → ${fp.fov.toFixed(0)}° to show everyone`, `${(performance.now() - t0).toFixed(1)} ms`] };
      }
      // (can't from there): everyone, from the group framing
      const g = this.groupShot(list, aspect);
      return { pose: g.pose, score: 0, source: 'auto', notes: ['the authored wide misses / hides someone: the group shot', `${(performance.now() - t0).toFixed(1)} ms`] };
    }
  }

  /** "Sitting there and talking": a medium shot (head + upper body, face in the upper third) of one performer
   *  at their spot, a little off-axis towards the room centre. */
  private autoTalk(a: SceneActor, spot: SpotInfo, aspect: number): CamPose {
    const face = a.drawnFaceAt(spot) ?? { center: spot.position.clone().setY(spot.position.y + 1.4), size: 0.24 };
    const fov = 30;
    const toCenter = this.roomCenter().sub(spot.position).setY(0);
    const side = Math.sign(new THREE.Vector3().crossVectors(spot.forward, toCenter).y) || 1;
    const dir = spot.forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(16) * side);
    const body = a.size.cls === 'normal' ? (this.info.avatarHeight ?? 1.5) * (this.state.avatarScale || 1) : a.height;   // real shown height (a fairy gets a close-up)
    const height = Math.max(face.size * 3.6, body * (spot.pose === 'sit' ? 0.5 : 0.56));   // visible frame height at the subject
    const target = face.center.clone().add(new THREE.Vector3(0, -height * 0.2, 0));
    let dist = (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    if (aspect < 1) dist /= aspect;                                   // portrait canvas: keep the shoulders in
    const eye = face.center.clone().add(new THREE.Vector3(0, face.size * 0.15, 0));
    const pos = eye.clone().addScaledVector(dir, dist);
    return this.unblocked(eye, pos, target, fov, dist);
  }

  /** Everyone present, from the front of the room (CAM_WIDE's direction when authored). */
  private autoGroup(list: SceneActor[], aspect: number): CamPose {
    const pts: THREE.Vector3[] = [];
    let size = 0.24;
    for (const a of list) {
      const s = this.intent.get(a)!;
      const f = a.drawnFaceAt(s);
      if (f) { pts.push(f.center, f.center.clone().setY(f.center.y - f.size * 1.6)); size = Math.max(size, f.size); }
    }
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    const wideP = this.room.cameras.get('CAM_WIDE');
    const back = wideP ? new THREE.Vector3(0, 0, 1).applyQuaternion(wideP.quaternion).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const fov = 34;
    const vt = Math.tan(THREE.MathUtils.degToRad(fov) / 2), ht = vt * aspect;
    const right = new THREE.Vector3().crossVectors(UP, back).normalize();
    let need = 1.2;
    for (const p of pts) {
      const d = p.clone().sub(c);
      const depth = d.dot(back);
      need = Math.max(need, (Math.abs(d.dot(right)) + size * 1.4) / ht - depth, (Math.abs(d.y) + size * 1.2) / vt - depth);
    }
    const target = c.clone();
    const eye = c.clone().add(new THREE.Vector3(0, size * 0.8, 0));
    const pos = eye.clone().addScaledVector(back, need);
    return this.unblocked(eye, pos, target, fov, need);
  }

  private autoWide(aspect: number): CamPose {
    // the lived-in part of the room: spots + 1.5 m (exterior sets / backdrops don't count)
    const sp = this.room.spots.filter((s): s is SpotInfo => !!s);
    const b = sp.length ? new THREE.Box3().setFromPoints(sp.map((s) => s.position)).expandByScalar(1.5) : this.room.bounds;
    const size = b.isEmpty() ? new THREE.Vector3(6, 3, 6) : b.getSize(new THREE.Vector3());
    const c = this.roomCenter();
    const fov = 38;
    const ht = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * aspect;
    const dist = (size.x * 0.5) / ht;
    const target = new THREE.Vector3(c.x, Math.min(1.2, c.y), c.z);
    const pos = new THREE.Vector3(c.x, 1.7, (b.isEmpty() ? 0 : b.max.z) + Math.max(0.5, dist - size.z * 0.5));
    return lookPose(pos, target, fov);
  }

  /** Straight at the react screen, so it fills ~80% of the frame. */
  private autoReact(aspect: number): CamPose {
    const f = this.screen!.frame(this.viewerPoint());
    const fov = 35;
    const vt = Math.tan(THREE.MathUtils.degToRad(fov) / 2), ht = vt * aspect;
    const dist = Math.max(f.width / 0.8 / 2 / ht, f.height / 0.8 / 2 / vt);
    return lookPose(f.center.clone().addScaledVector(f.normal, dist), f.center, fov);
  }

  /** A screen filling ~88 % of the frame, seen from its front (pulled in front of walls). Square-on when nothing is
   *  in the way; props in front of it (a table, a lamp) → the camera rises / steps in a little until the whole
   *  picture is in plain view. Cached per screen + aspect (ray tests). */
  private screenPose(f: { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number }, aspect: number): CamPose {
    const ck = `${f.center.toArray().map((v) => v.toFixed(2))}|${f.width.toFixed(2)}|${aspect.toFixed(3)}`;
    if (this.screenCam?.k === ck) return this.screenCam.pose;
    const fov = 32;
    const vt = Math.tan(THREE.MathUtils.degToRad(fov) / 2), ht = vt * aspect;
    const dist = Math.max(f.width / 0.88 / 2 / ht, f.height / 0.88 / 2 / vt);
    const rays = this.rays ??= new RoomRays(this.room);
    const right = new THREE.Vector3().crossVectors(UP, f.normal).normalize();
    const pts: THREE.Vector3[] = [];
    for (const u of [-0.46, -0.3, -0.15, 0, 0.15, 0.3, 0.46]) for (const v of [-0.44, -0.25, 0, 0.25, 0.44]) pts.push(f.center.clone().addScaledVector(right, u * f.width).addScaledVector(UP, v * f.height).addScaledVector(f.normal, 0.02));
    // candidates cheapest first: square-on, then higher, a little to the side, closer (the lens widens to keep ~88 %)
    const cands: { k: number; up: number; side: number; cost: number }[] = [];
    for (const k of [1, 0.85, 0.7, 0.55]) for (const up of [0, 0.2, 0.4, 0.65, 0.9]) for (const side of [0, -0.22, 0.22]) cands.push({ k, up, side, cost: (1 - k) * 3 + up * 1.6 + Math.abs(side) * 3 });
    cands.sort((a, b) => a.cost - b.cost);
    let best: { pose: CamPose; seen: number } | null = null;
    for (const c of cands) {
      const d = dist * c.k;
      const pos = f.center.clone().addScaledVector(f.normal, d).addScaledVector(UP, c.up * f.height).addScaledVector(right, c.side * f.width);
      const pose = this.unblocked(f.center, pos, f.center, Math.min(62, 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) / c.k))), d);
      const seen = pts.filter((q) => rays.clear(pose.position, q)).length;
      if (!best || seen > best.seen) best = { pose, seen };
      if (seen >= pts.length - 1) break;                                  // (one grazed corner sample is fine)
    }
    this.screenCam = { k: ck, pose: best!.pose };
    return best!.pose;
  }
  private screenCam: { k: string; pose: CamPose } | null = null;

  /** Pull the camera in front of any wall between it and the subject (and widen to keep the framing). */
  private unblocked(from: THREE.Vector3, pos: THREE.Vector3, target: THREE.Vector3, fov: number, dist: number): CamPose {
    const dir = pos.clone().sub(from);
    const len = dir.length();
    if (len > 1e-4 && this.room.occluders.length) {
      this.ray.set(from, dir.normalize());
      this.ray.far = len;
      const hit = this.ray.intersectObjects(this.room.occluders, false).find((h) => h.distance > 0.35);
      if (hit) {
        const d = Math.max(0.4, hit.distance - 0.12);
        pos = from.clone().addScaledVector(dir, d);
        const wider = 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * (dist / d)));
        fov = Math.min(75, wider);
      }
    }
    return lookPose(pos, target, fov);
  }

  // ---------------------------------------------------------------- framing guarantee for engines' own cameras
  /** The framing guarantee (src/scene/frameGuard.ts) for a camera a room engine / director computed itself (a cutaway,
   *  an exterior drone over the deck, an entrance cinematic's hero pose): the faces of `keys` ('all' = everyone in the
   *  room) inside the family's safe area — refit from the same position, dolly back, a front-on fallback. Returns the
   *  pose to use (the given one when it is fine, or when nothing clean exists: `step` says which). Cheap when fine (a
   *  projection); a re-solve costs a few ms — cache per shot. */
  guardPose(pose: CamPose, keys: string[] | 'all', family: ShotFamily = 'group', aspect = this.stage.camera.aspect || 16 / 9): { pose: CamPose; step: string; notes: string[] } {
    if (!this.framing.guard || FrameGuard.off) return { pose, step: 'ok', notes: [] };
    const list = keys === 'all' ? [...this.actors.values()].filter((a) => this.intent.get(a)) : keys.map((k) => this.actors.get(k)).filter((a): a is SceneActor => !!a && !!this.intent.get(a));
    if (!list.length) return { pose, step: 'ok', notes: [] };
    const subs = list.map((a) => this.subjectOf(a, this.intent.get(a)!) ?? this.seatSubject(a, this.intent.get(a)!));
    const others = this.presentSubjects().filter((o) => !list.includes(o.a)).map((o) => o.s);
    const big = subs.some((s) => s.rig === 'macro' || s.rig === 'mech') ? 'macro' : subs.length === 1 ? subs[0].rig ?? 'normal' : 'normal';
    const fg = new FrameGuard(this.rays ??= new RoomRays(this.room), this.solverOf().probe);
    const single = family === 'talk' || family === 'single' || family === 'tile' || family === 'ttrpg' || family === 'solo';
    const g = fg.guard(pose, { family, targets: subs.map(targetOf), aspect, blockers: others, motion: this.motionFor(single ? 'talk' : 'group'), rig: rigFor(big, this.framing.rigs ?? undefined),
      facing: subs.map((s) => s.forward), maxFov: 75, safe: safeFor(family, this.framing.safe).fix, see: 0.75, people: [...subs, ...others] });
    return { pose: g.step === 'best-effort' ? pose : g.pose, step: g.step, notes: g.notes };
  }

  // ---------------------------------------------------------------- stage layouts (src/scene/stage)
  /** The seat a member is at / walking to (null = not in the room). */
  seatOf(key: string): SpotInfo | null { const a = this.actors.get(key); return a ? this.intent.get(a) ?? null : null; }
  /** Changes when who sits where / their size changes (cache key for per-seat work). */
  rosterKey(): string { return this.rosterSig(); }
  /** Middle of the room's seats (1.2 m up). */
  seatsCentre(): THREE.Vector3 { return this.roomCenter(); }
  /** The talk solver's shot of one performer at their seat (cached per roster / aspect; 2–20 ms when new). */
  talkPoseFor(key: string, aspect = 16 / 9): CamPose | null {
    const a = this.actors.get(key), spot = a ? this.intent.get(a) : null;
    return a && spot ? this.talkShot(a, spot, aspect).pose : null;
  }
  /** In-scene capture in effect: the texture to draw (a shared window or the fast feed) and its aspect. */
  get captureSource(): { tex: THREE.Texture; aspect: number } | null {
    if (!this.inScene) return null;
    if (this.videoTex && this.video) return { tex: this.videoTex, aspect: this.video.videoWidth > 0 ? this.video.videoWidth / this.video.videoHeight : 16 / 9 };
    return this.feedTex ? { tex: this.feedTex, aspect: this.feedAspect || 16 / 9 } : null;
  }
  /** A composite stage layout (src/scene/stage/compositor.ts) draws its capture rect IN the page instead of cutting an
   *  OBS passthrough hole. React (Full / Medium) follows the React screen setting: In-scene, or Auto while the fast feed
   *  comes up, draws the window / standby / NO SIGNAL — never a hole just because no frame has arrived yet. Every other
   *  mode with a capture area (Gaming: the game is an OBS capture seen through its hole; the React screen setting is
   *  not about it) only when a window is really there (a window shared from the studio / the fast feed). */
  get compositeInScene(): boolean { return this.state.mode === 'react' ? this.inScene : !!this.captureSource; }
  /** What a composite layout draws in its capture rect (compositeInScene): the window, else (React only) the standby /
   *  NO SIGNAL card. */
  get capturePicture(): { tex: THREE.Texture; aspect: number } | null {
    if (!this.compositeInScene) return null;
    return this.captureSource ?? (this.state.mode === 'react' ? { tex: this.inScenePicture(), aspect: 16 / 9 } : null);
  }
  /** Nothing to show yet while the fast feed is coming up (Auto / In-scene, or an OBS passthrough that can't line up
   *  and so is drawn in the room too): the standby card (else NO SIGNAL). Only used while the screen is in-scene. */
  private get standby() { return this.opts.screen === 'hole' && (this.feedWait || this.standbyHold) && !this.capture && !this.feedTex; }
  private inScenePicture(): THREE.Texture {
    return this.videoTex ?? this.feedTex ?? (this.standby ? (this.standbyTex ??= standbyTexture()) : (this.noSignal ??= noSignalTexture()));
  }
  private standbyTex: THREE.CanvasTexture | null = null;
  /** The 3D React screen in the current shot (fractions) while it is down, and whether its hole is open. */
  reactRect(): { rect: ScreenRect; open: boolean; layout: ActiveLayout } | null {
    const lay = this.layout();
    const s: ReactSurface | null = lay === 'solo' ? this.solo : this.screen;
    if (!s || this.state.mode !== 'react' || this.composite || (s.holeOpen <= 0 && !this.inScene && (lay === 'solo' ? this.solo?.target !== 1 : this.screen?.target !== 1))) return null;
    return { rect: s.rect(this.stage.camera), open: s.holeOpen >= 1, layout: lay };
  }

  // ---------------------------------------------------------------- OBS helpers
  /** Where the react screen lands in the output frame with the REACT camera (fractions; null = no screen). */
  screenRect(camera = 'react', aspect = this.stage.camera.aspect || 16 / 9): ScreenRect | null {
    if (camera === 'react') return this.layout() === 'solo' ? this.screenRects(aspect).solo : this.screenRects(aspect).big;
    if (!this.screen) return null;
    const pose = this.resolveCamera(camera, aspect).pose;
    return this.screen.rect(this.camFor(pose, aspect));
  }

  /** Both React layouts' projected screen quads (TL, TR, BR, BL fractions) — the passthrough hole's exact shape. */
  /** Spots whose (normal-sized, seated / standing) occupant would cover > 12 % of the big React screen in the Big shot —
   *  the host's controller moves people off them while React shows the big screen (src/scene/stage). Cached per room /
   *  avatar scale. */
  reactBlockSpots(aspect = 16 / 9): number[] {
    if (!this.screen) return [];
    const k = `${(this.state.avatarScale || 1).toFixed(2)}|${aspect.toFixed(3)}`;
    if (this.blockCache && this.blockCache.k === k) return this.blockCache.v;
    const cam = this.camFor(this.room.cameras.get('CAM_REACT') ?? this.autoReact(aspect), aspect);
    const r = this.screen.rect(cam);
    const h = (this.info.avatarHeight ?? 1.5) * (this.state.avatarScale || 1), hw = 0.26 * h / 1.5;
    const out: number[] = [];
    for (const s of this.room.spots) {
      if (!s) continue;
      const top = s.position.y + (s.pose === 'sit' ? s.seatHeight + h * 0.5 : h);
      const side = new THREE.Vector3(-s.forward.z, 0, s.forward.x);
      const pts = [0, 1, 2, 3].map((i) => s.position.clone().addScaledVector(side, (i & 1 ? 1 : -1) * hw).setY(i & 2 ? top : s.position.y + (s.pose === 'sit' ? s.seatHeight : 0)).project(cam));
      if (pts.some((q) => q.z > 1)) continue;
      const xs = pts.map((q) => (q.x + 1) / 2), ys = pts.map((q) => (1 - q.y) / 2);
      const w = Math.min(Math.max(...xs), r.x + r.w) - Math.max(Math.min(...xs), r.x), hh = Math.min(Math.max(...ys), r.y + r.h) - Math.max(Math.min(...ys), r.y);
      if (w > 0 && hh > 0 && (w * hh) / Math.max(1e-6, r.w * r.h) > 0.12) out.push(s.index);
    }
    this.blockCache = { k, v: out };
    return out;
  }
  private blockCache: { k: string; v: number[] } | null = null;

  screenQuads(aspect = this.stage.camera.aspect || 16 / 9): { big: [number, number][] | null; solo: [number, number][] | null } {
    const big = this.screen ? this.screen.quad(this.camFor(this.room.cameras.get('CAM_REACT') ?? this.autoReact(aspect), aspect)) : null;
    let solo: [number, number][] | null = null;
    if (this.soloTarget() && this.solo) { const p = this.soloPose(aspect); if (p) solo = this.solo.quad(this.camFor(p, aspect)); }
    return { big, solo };
  }

  /** Both React layouts' screen rects (fractions) — the Window Capture numbers for each. */
  screenRects(aspect = this.stage.camera.aspect || 16 / 9): { big: ScreenRect | null; solo: ScreenRect | null; layout: ActiveLayout } {
    const big = this.screen ? this.screen.rect(this.camFor(this.room.cameras.get('CAM_REACT') ?? this.autoReact(aspect), aspect)) : null;
    let solo: ScreenRect | null = null;
    if (this.soloTarget()) {
      this.ensureSolo();
      const p = this.soloPose(aspect);
      if (p && this.solo) solo = this.solo.rect(this.camFor(p, aspect));
    }
    return { big, solo, layout: this.layout() };
  }

  private camFor(pose: CamPose, aspect: number) {
    const cam = new THREE.PerspectiveCamera(pose.fov, aspect, 0.03, 500);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion);
    cam.updateProjectionMatrix();
    return cam;
  }

  /** Performer's tracking tuned for the room: seated people barely slide around, standing ones a bit less. */
  tuningFor(key: string, t: TrackingTuning): TrackingTuning {
    const a = this.actors.get(key);
    if (!a) return t;
    const tr = t.translate ?? [1, 0.7, 1.2];
    const s = a.sit;
    // walking: the body is carried by the walk, so the webcam's head translation mostly stops moving it
    const w = 1 - 0.85 * a.loco;
    const k: [number, number, number] = [THREE.MathUtils.lerp(0.6, 0.3, s) * w, THREE.MathUtils.lerp(0.7, 0.35, s) * w, THREE.MathUtils.lerp(0.5, 0.25, s) * w];
    return { ...t, translate: [tr[0] * k[0], tr[1] * k[1], tr[2] * k[2]] };
  }

  /** Hidden actors can skip their avatar update. */
  isShown(key: string) { return !!this.actors.get(key)?.mount.visible; }

  /** Every spot for the studio (index = SceneState spot index: SPOT_01…12, then the size spots) + its size classes. */
  private summarySpots() {
    this.needSizeSpots();                                               // the studio's seat rules need the size spots
    const n = MAX_SPOTS + this.room.sizeSpots.length;
    return Array.from({ length: n }, (_, i) => {
      const s = spotByIndex(this.room, i);
      return s && { index: s.index, label: s.label, pose: s.pose, x: s.position.x, z: s.position.z, yaw: s.yaw, sizes: s.sizes ?? null, ...(s.kinds ? { kinds: s.kinds } : {}), ...(s.sizeSpot ? { sizeSpot: s.sizeSpot } : {}), ...(s.clearance ? { clearance: Math.round(s.clearance.height * 100) / 100 } : {}) };
    });
  }
  private sizeSummary() {
    return {
      ready: this.sizeReady, notes: this.sizeNotes,
      actors: [...this.actors.values()].filter((a) => a.runtime).map((a) => ({ key: a.key, cls: a.size.cls, real: a.size.height, auto: a.size.auto, shown: Math.round(a.height * 1000) / 1000, spot: this.intent.get(a)?.index ?? null, fix: a.rest?.heightFix ?? null })),
    };
  }

  /** Room summary for the studio UI. */
  summary() {
    return {
      id: this.info.id,
      spots: this.summarySpots(),
      sizes: this.sizeSummary(),
      path: this.room.path.map((p) => [p.x, p.z]),
      cameras: this.cameraNames(),
      screen: !!this.screen,
      reactBlock: this.reactBlockSpots(),
      screenMode: this.state.screen?.mode ?? 'auto',
      skins: { solo: describeSkin(this.skins.solo.spec, 'solo'), monitor: describeSkin(this.skins.monitor.spec, 'monitor'), board: describeSkin(this.skins.board.spec, 'board'), source: this.skins.solo.spec.source, warnings: [...new Set(Object.values(this.skins).flatMap((s) => s.spec.warnings))] },
      inScene: this.inScene,
      signal: !!this.capture,
      layout: this.layout(),
      soloPending: this.soloPending,
      solo: this.solo ? { source: this.solo.place.source, width: this.solo.place.width, center: this.solo.place.center.toArray(), yaw: THREE.MathUtils.radToDeg(this.solo.place.yaw), wfrac: this.soloShot?.wfrac ?? null, clear: this.soloShot?.clear ?? null } : null,
      bounds: this.room.bounds.isEmpty() ? null : { min: this.room.bounds.min.toArray(), max: this.room.bounds.max.toArray() },
      lights: [...new Set([...this.room.fixtures.map((f) => f.group), ...this.room.emissive.map((e) => e.group)])].map((g) => ({ group: g, count: this.room.fixtures.filter((f) => f.group === g).length, kinds: [...new Set(this.room.fixtures.filter((f) => f.group === g).map((f) => f.kind))] })),
      ...(this.toggles.any ? { toggles: this.toggles.summary(this.state.toggles), clipsSkipped: this.clips?.skipped ?? [] } : {}),
    };
  }

  dispose() {
    // the room goes (a room change, the page closing): its OBS hole goes with it — say so, or OBS automation keeps the
    // capture placed (and shown) at this room's screen until React is left. The next room reports its own hole.
    if (this.hole.open) { this.hole.open = false; this.onHole?.(false, null, this.hole.layout, null); }
    this.onHole = null;
    this.props?.dispose(); this.props = null;   // (before the traverse below: its models are shared by the page)
    this.clips?.dispose(); this.clips = null;
    this.releaseActors();
    this.mover.dispose();
    this.lights.dispose();
    this.screen?.dispose();
    this.solo?.dispose();
    this.setCapture(null);
    this.noSignal?.dispose();
    this.standbyTex?.dispose();
    for (const [l, b] of this.dip.base) l.intensity = b;
    this.root.removeFromParent();
    // The room's own parsed tree: meshes, points, lines, sprites, shader-uniform textures, bone textures, and the decoded
    // bitmaps behind its textures (three.js never closes them). The props group is already gone from it (props.dispose above).
    disposeRoomTree(this.roomModel);
    // Whatever else hangs under root (engine groups): GPU resources only, no bitmaps (an engine may share a cached asset).
    this.root.traverse((o) => {
      const m = o as THREE.Mesh & THREE.Points & THREE.Line & THREE.Sprite;
      if (!(m.isMesh || m.isPoints || m.isLine || m.isSprite)) return;
      if (!m.isSprite) m.geometry?.dispose();
      for (const mt of ([] as (THREE.Material | null | undefined)[]).concat(m.material)) {
        if (!mt) continue;
        for (const v of Object.values(mt as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture && !v.userData?.vtpShared) v.dispose();
        mt.dispose();
      }
    });
    disposeSkeletons(this.root);
    const cam = this.stage.camera;
    cam.fov = this.saved.fov; cam.near = this.saved.near; cam.far = this.saved.far;
    cam.updateProjectionMatrix();
    this.stage.background = this.saved.background;
    this.stage.scene.fog = this.saved.fog;
  }
}

/** A short signature of a camera tweak (part of the shot key: a changed tweak is a new shot, eased like any other). */
const tweakSig = (t: CamTweak) => [t.orbit, t.tilt, t.dolly * 100, t.height * 100, t.fov].map((v) => Math.round(v * 10)).join(',');

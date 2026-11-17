// Voyage engine (docs/SCENES.md -> "Voyage"; the walking-ship SPEC section 2) - rooms whose scene.json has a
// `voyage` key are walking ships. Rendered in the SHIP's frame: the room, its performers
// and every CAM_* never move; one world group (terrain, scatter, cities, enemies, backdrop) carries the INVERSE of the
// ship's body pose and streams past. Faces stay where cam_eval measured them; the horizon rocks instead of the deck.
//
// Orchestrates, from pure functions of (the host's bag SceneState.modes.voyage, the room config, the wall clock):
//   * shared/voyage.ts       chapters, beats, closed-form distance, holds, forks, stamps, battle plans, journey hour
//   * voyageGait.ts          the legs (distance-phased tripod, planted feet never slide) - adapter for shared/gait.ts
//   * voyageShip.ts          the leg / ram / turret rig on the room GLB's nodes (+ rig.json limits), or the placeholder ship
//   * voyageWorld.ts         the world provider (placeholder desert; the desert lane's DesertWorld plugs in here)
//   * voyageCombat.ts        battles, stamps (support, host buttons), the treasure sortie, foot dust, the crew plan
//   * voyageCams.ts          exterior program (Preshow / BRB / Outro) + Talk-only cutaways via cameraOverride
//   * the environment        EnvScene.drive: journey hour (pinned for Preshow / BRB / Outro), sandstorm weather, north
// Deck motion (SPEC R2): gait bob / sway / impulses x mode gain (Talk 1, Interview 0.6, TTRPG 0.8, React 0, Gaming 0),
// battle x2, still while kneeling, BRB deck shots still; exterior shots see the full motion. Rooms without `voyage`: one
// check per frame. Support never plays from the page's own chat feed: the host controller stamps it (voyageHost.ts).
// Test pages: vtpOut.voyage (.seek(), .test(), .manual / .clock / .frozen, .info(), .hash(), .crewPlan()).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import type { CamPose } from '../cameraRig.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import { SpaceFx } from '../space/fx.ts';
import { EU, patchEnvMaterial } from '../environment/materials.ts';
import type { EnvScene } from '../environment/index.ts';
import { VoiceTap } from '../talkshow/voice.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import { raidDonationValue } from '../../../shared/raid.ts';
import { ambSlot } from '../../../shared/ambientCam.ts';
import { isEnvWeather, type EnvWeather, type SceneEnvState } from '../../../shared/environment.ts';
import {
  DEFAULT_GAIT, DEFAULT_GROUND_Y, DEFAULT_KNEEL, ENC, STAMP_KINDS, STORM_APPROACH, STORM_CLEAR, TIER_OFFSET, VOYAGE_BAG,
  battlePlan, chapterPlanOf, chapterRef, eventIntensity, forkState, isEventKind, isStampKind, legMotion, modeGain, sanitizeVoyage, smooth01, stampPlays,
  stopDuration, voyageBagFrom, voyageDistance, voyageTalkCuts, voyageGroundBinding, voyageHash, voyageKickOk, voyageNow, voyageRand, voyageRewardKind, voyageStopHeld,
  voyageTierLines, voyageTiers, voyageWallOf,
  type RoomVoyageConfig, type StampKind, type VoyageBag, type VoyageNow, type VoyageStamp,
} from '../../../shared/voyage.ts';
import { builtinGait, footAt, gaitBob, voyageGait, type GaitFoot, type GaitParams } from './voyageGait.ts';
import { BOW_YAW, ShipRig, PLACEHOLDER_BOUNDS, buildPlaceholderShip, setShipFrame, type BowAxis } from './voyageShip.ts';
import { PlaceholderWorld, type CitySpec, type VoyageWorldProvider } from './voyageWorld.ts';
import { DesertProvider } from './voyageDesert.ts';
import type { CrewFeed } from '../crew/crewScene.ts';
import type { CrewEpisodeIn } from '../../../shared/shipCrew.ts';
import { EnemyPool } from './voyageEnemy.ts';
import { VoyageAction, type ActionOut, type Banner, type CrewPlan, type CutRequest } from './voyageCombat.ts';
import { BROLL_MOVES, DIRECTOR_MOVES, PERFORMER_MOVES, VoyageCams, directorNext, directorPick, type DirectorPick, type ExtMove, type ExtShot, type MusicSection } from './voyageCams.ts';
import { DeckCams } from './voyageDeckCam.ts';
import { musicFrame } from '../showSky/music.ts';
import type { ShotSubject } from '../shotSolver.ts';
import { demoConfig, voyageRoomOf, type VoyageRoom } from './voyageRoom.ts';
import { BANNER_SLOTS, bannerSlot, type BannerKeep, type BannerSlot } from './voyageBanner.ts';

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tq = new THREE.Quaternion(), te = new THREE.Euler();
const D2R = Math.PI / 180;
/** Cutaway lengths (SPEC 5.3) and the spacing rule: at most one per 90 s, only after the focus has been quiet 1.2 s. */
const CUT_LEN: Record<CutRequest['kind'], number> = { battle: 5, defeat: 4, sortie: 6, city: 5, storm: 5 };
const CUT_SPACING = 90, QUIET_SECS = 1.2, QUIET_LEVEL = 0.17;
/** The Preshow show's hour when the room sets none: after dusk (stars out, a last glow on the horizon). */
const PRESHOW_NIGHT = 21.3;

/** The ship's pose relative to the world-local frame (x = d, y = h, z = -(s - S)). */
export interface BodyPose { Y: number; pitch: number; roll: number; heave: number; groundRef: number; tPitch: number; tRoll: number }

/** Replaceable world (the desert lane): set before the room loads. */
let worldFactory: ((cfg: RoomVoyageConfig) => VoyageWorldProvider) | null = null;
export function setWorldProvider(f: ((cfg: RoomVoyageConfig) => VoyageWorldProvider) | null) { worldFactory = f; }

/** groundY from the room's VOYAGE_GROUND anchor (scene.json `voyage.nodes.ground`), in the room root's frame. */
function anchorY(root: THREE.Object3D, cfg: RoomVoyageConfig): number | null {
  const g = cfg.nodes?.ground;
  const name = typeof g === 'string' ? g : 'VOYAGE_GROUND';
  let y: number | null = null;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => { if (y === null && (o.name === name || o.name.endsWith('__' + name))) y = root.worldToLocal(o.getWorldPosition(new THREE.Vector3())).y; });
  return y;
}

/** The voyage banner's material (one place, so warm() compiles exactly the program the banners use). */
function bannerMaterial(map: THREE.Texture) {
  return new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, depthTest: false, fog: false, toneMapped: false });
}

export class VoyageScene {
  private rt: SceneRuntime | null = null;
  private lastRt: SceneRuntime | null = null;
  private cfg: RoomVoyageConfig | null = null;
  private room: VoyageRoom | null = null;
  private rig: ShipRig | null = null;
  private placeholder: THREE.Group | null = null;
  /** ship-frame group (matrix = the room root's): placeholder ship, effects, sortie props, dust */
  private shipGroup = new THREE.Group();
  /** the world (inverse body pose) */
  private worldGroup = new THREE.Group();
  private world: VoyageWorldProvider | null = null;
  private enemies: EnemyPool | null = null;
  private action = new VoyageAction();
  private cams = new VoyageCams();
  private fx: SpaceFx | null = null;
  private voice = new VoiceTap();
  private bagSrc: unknown = undefined;
  private bag: VoyageBag = sanitizeVoyage({});
  /** page-local test stamps (test pages only; the host's real stamps live in the bag) */
  private testStamps: VoyageStamp[] = [];
  private bagDirty = false;
  private chatTs: number[] = [];
  private body: BodyPose = { Y: DEFAULT_GROUND_Y, pitch: 0, roll: 0, heave: 0, groundRef: 0, tPitch: 0, tRoll: 0 };
  private Body = new THREE.Matrix4();
  private BodyInv = new THREE.Matrix4();
  private st: VoyageNow | null = null;
  private out: ActionOut | null = null;
  private multK = -1;
  private mult = 1;
  private kick = { pitch: 0, roll: 0 };
  private extActive = false;
  private savedFar = 0;
  /** room nodes hidden while the voyage world is attached (FALLBACK_DESERT, extras voyageHide) */
  private hiddenNodes: { o: THREE.Object3D; vis: boolean }[] = [];
  private myFar = 0;
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private env: EnvScene | null;
  private gait: GaitParams = { cycle: DEFAULT_GAIT.stride, duty: DEFAULT_GAIT.duty, height: DEFAULT_GAIT.lift };
  private foot: GaitFoot = { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 };
  private banner: { mesh: THREE.Mesh; key: string; tex: THREE.CanvasTexture } | null = null;
  private bannerK = 1;
  private faceRects: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private lampMats: THREE.MeshStandardMaterial[] = [];
  private menorahMats: THREE.MeshStandardMaterial[] = [];
  private beacons: THREE.Mesh[] = [];
  private perf = { avg: 0, peak: 0 };
  /** per-frame scratch (step / legs / camCtx: no allocation per frame) */
  private fr = { camShip: new THREE.Vector3(), camLocal: new THREE.Vector3(), sun: new THREE.Vector3(), sunLocal: new THREE.Vector3(), sunCol: new THREE.Color(), amb: new THREE.Color(), amb2: new THREE.Color(), fog: new THREE.Color(), wind: new THREE.Vector2(), foot: new THREE.Vector3(),
    smooth: new THREE.Matrix4(), smoothToShip: new THREE.Matrix4(), shipToThree: new THREE.Matrix4(), sq: new THREE.Quaternion(), se: new THREE.Euler(), sv: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1), hull: new THREE.Box3() };
  private frame = 0;
  private notes: string[] = [];
  private lastShot: (ExtShot & { subjects?: string[] }) | null = null;
  /** performer shots (DECK / PUSHIN): ranked cameras round each performer's seat, checked against the room */
  readonly deckCams = new DeckCams();
  /** the director's last pick (info / tests) and the Show b-roll on air (page-local: the speech gate) */
  private lastPick: DirectorPick | null = null;
  private broll: { pick: DirectorPick; until: number } | null = null;
  private lastBrollAt = -1e15;
  /** the cutaway on air (page-local: the spacing + speech gate) */
  private cut: { key: string; req: CutRequest; from: number; to: number } | null = null;
  private lastCutAt = -1e15;
  /** the host's camera + focus choice last frame (a change = an explicit pick: Talk cut-aways yield to it) */
  private camPick: string | null = null;
  private quiet = 0;
  private debugCfg: RoomVoyageConfig | null = null;
  private demoOn = false;
  private rigJson: unknown = null;
  private fireKeep: number[][] = [];
  private canopy: number[] | null = null;
  /** the room's show sky (src/scene/showSky): the Preshow exterior show frames its hero planet */
  showSky: { heroDir(): THREE.Vector3 | null; readonly level: number; tint?(out: THREE.Color): THREE.Color } | null = null;
  /** a crew engine claimed the sortie (crew lane): the placeholder shore party hides */
  crewClaimed = false;
  /** test pages (&voyageSeed): the seed of a room whose host never stamped one */
  seedOverride: number | null = null;
  /** Test pages: time advances only through update(); clock = epoch ms. */
  manual = false;
  clock = Date.now();
  /** test pages: a manual clock that does not advance (two pages compare hashes at the same instant) */
  frozen = false;
  /** test pages: hold one exterior move on air (any lighting state), its u running over `dur` s: {move, dur, at} */
  extPreview: { move: string; dur?: number; at?: number } | null = null;
  /** test pages: Talk cutaways ignore the speech gate (no voice in a test page) */
  ignoreSpeech = false;
  /** test pages (showreels): the music director runs in any lighting state (Talk mode) */
  directorAny = false;
  now() { return this.manual ? this.clock : Date.now(); }

  constructor(env: EnvScene | null = null) { this.env = env; }

  // ---------------------------------------------------------------------------------------------- lifecycle
  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.lastRt = rt;
    const own = (rt.info as unknown as { voyage?: RoomVoyageConfig }).voyage;
    const cfg = this.debugCfg ?? (own && typeof own === 'object' ? own : null) ?? (this.demoOn ? demoConfig(rt) : null);
    if (!cfg) return;
    this.rt = rt; this.cfg = typeof cfg.groundY === 'number' ? cfg : { ...cfg, groundY: anchorY(rt.room.root, cfg) ?? undefined };
    try { this.build(rt, this.cfg); } catch (e) { console.warn('[voyage] build failed', e); this.notes.push(`build failed: ${e}`); }
  }

  private build(rt: SceneRuntime, cfg: RoomVoyageConfig) {
    this.notes = [];
    this.room = voyageRoomOf(rt, cfg);
    setShipFrame(rt.room.root);
    const g = cfg.gait ?? {};
    this.gait = { cycle: clampN(g.stride, 2, 30, DEFAULT_GAIT.stride), duty: clampN(g.duty, 0.3, 0.9, DEFAULT_GAIT.duty), height: clampN(g.lift, 0.2, 5, DEFAULT_GAIT.lift) };
    // the ship: the room's own LEG_* rig, else the procedural placeholder
    const wantRoom = cfg.ship === 'room' || (cfg.ship !== 'procedural' && this.room.hasLegs);
    const phases = (ids: string[]) => voyageGait().phases(ids, g.family === 'wave' ? 'wave' : 'tripod');
    this.shipGroup = new THREE.Group(); this.shipGroup.name = 'vtp:voyage:ship';
    this.shipGroup.matrixAutoUpdate = false;
    rt.root.add(this.shipGroup);
    const fwd = typeof cfg.forward === 'string' && cfg.forward in BOW_YAW ? (cfg.forward as BowAxis) : null;
    if (wantRoom) this.rig = ShipRig.fromRoom(rt.room.root, phases, fwd);
    if (!this.rig) {
      if (wantRoom) this.notes.push('room has no LEG_* rig: using the placeholder ship');
      this.placeholder = buildPlaceholderShip({ deck: !this.room.spots.length });
      this.shipGroup.add(this.placeholder);
      this.shipGroup.matrix.copy(rt.room.root.matrixWorld);
      this.shipGroup.updateMatrixWorld(true);
      this.rig = ShipRig.fromRoom(this.placeholder, phases, fwd);
      if (this.rig) this.rig.ship = rt.room.root;
      this.notes.push('placeholder ship (procedural) - the room ship GLB replaces it');
    }
    if (!this.rig) { this.rig = new ShipRig(); this.notes.push('no ship rig'); }
    {
      // the bow (it walks bow-first): where it came from, and the hull's own call when it disagrees
      const R = this.rig, g = R.bowGeom, deg = Math.round((R.bowYaw * 180) / Math.PI);
      this.notes.push(`bow ${deg} deg (${R.bowSource})${g ? `, hull says ${g.axis} (${(g.conf * 100).toFixed(0)} %)` : ''}`);
      if (g && g.conf >= 0.08 && R.bowSource !== 'geometry' && Math.abs(Math.atan2(Math.sin(R.bowYaw - g.yaw), Math.cos(R.bowYaw - g.yaw))) > 0.5)
        this.notes.push(`WARNING bow: the ${R.bowSource === 'config' ? 'voyage.forward setting' : R.bowSource === 'node' ? 'VOYAGE_BOW node' : 'default (-z)'} disagrees with the hull's pointed end (${g.axis}): set voyage.forward`);
    }
    if (!this.rig.damage.length) this.rig.damage = (cfg.damage ?? []).map((p) => new THREE.Vector3(...p));
    this.rig.addLanterns(rt.room.root, cfg.below?.lanterns, clampN(cfg.below?.sway, 0, 2, 0.5) * 2);
    this.rig.setTurretLimits(cfg.turrets as never);
    // rig.json (limits, hit sites, turret elevation) arrives async; until then the GLB numbers hold
    if (cfg.rig && !this.placeholder) {
      const gen = this.rig;
      void fetch(sceneFileUrl(rt.info.id.split('~')[0], cfg.rig)).then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!j || this.rig !== gen) return;
        this.rigJson = j; gen.applyRigJson(j); gen.setTurretLimits(cfg.turrets as never);
        this.notes.push('rig.json applied');
      }).catch(() => this.notes.push('rig.json missing'));
    }
    // world group (under the scene root; matrix = inverse body pose x the room root)
    this.worldGroup = new THREE.Group(); this.worldGroup.name = 'vtp:voyage:worldroot'; this.worldGroup.matrixAutoUpdate = false;
    rt.root.add(this.worldGroup);
    this.world = worldFactory ? worldFactory(cfg) : this.makeWorld(rt, cfg);
    this.worldGroup.add(this.world.group);
    if (this.world instanceof DesertProvider) this.world.setShip({ legs: this.rig.legs.map((l) => l.gait), cycle: this.gait.cycle, duty: this.gait.duty, height: this.gait.height });
    this.world.setDryBoxes?.(this.room.dry);
    // the room's static stand-in ground (FALLBACK_DESERT / extras voyageHide) goes while the streaming world is here
    const fb = cfg.nodes?.fallbackGround;
    const fbName = typeof fb === 'string' ? fb : 'FALLBACK_DESERT';
    rt.room.root.traverse((o) => {
      if (o.userData?.voyageHide === true || o.name === fbName || o.name.endsWith('__' + fbName)) { this.hiddenNodes.push({ o, vis: o.visible }); o.visible = false; }
    });
    this.hull = this.shipHull(rt, cfg);
    this.enemies = new EnemyPool();
    // (enemies draw in route-local coords: the placeholder world's frame is the world group's; a provider that places
    //  its own world (the desert) carries that frame on its routeGroup)
    ((this.world as { routeGroup?: THREE.Group }).routeGroup ?? this.worldGroup).add(this.enemies.group);
    // effects + props in the ship frame
    this.fx = new SpaceFx({ sprites: 1600, smoke: 700, streaks: 300 }, false);
    (this.fx.uniforms as unknown as { uFaceDim: { value: number } }).uFaceDim.value = 0.3;
    this.fx.uniforms.uK.value = 1;
    this.shipGroup.add(this.fx.group, this.action.group);
    const pw = this.world as PlaceholderWorld;
    if (pw.dust) { this.shipGroup.add(pw.dust.mesh); pw.dust.dry = this.room.dry; }
    // fire arcs (SPEC D18 / C13), in the level ship frame: every spot + the alongside slots (keepOut.fireArcSlots nodes)
    // and the canopy + wings + hatch-stage box (keepOut.fireArcBox; else the canopy = the first dry box)
    this.fireKeep = this.room.spots.map((p) => [p.x, 0, p.z]);
    const ko = cfg.keepOut;
    const slots = Array.isArray(ko?.fireArcSlots) ? ko!.fireArcSlots.filter((n): n is string => typeof n === 'string' && !!n) : [];
    if (slots.length) {
      const ship = this.room.ship;
      ship.updateWorldMatrix(true, true);
      ship.traverse((o) => { if (slots.some((n) => o.name === n || o.name.endsWith('__' + n))) { const p = ship.worldToLocal(o.getWorldPosition(new THREE.Vector3())); this.fireKeep.push([p.x, 0, p.z]); } });
    }
    const fab = ko?.fireArcBox;
    const cb = this.room.dry[0];
    this.canopy = Array.isArray(fab) && fab.length === 6 && fab.every((x) => typeof x === 'number' && Number.isFinite(x)) && fab[0] <= fab[3] && fab[2] <= fab[5]
      ? [fab[0], Math.min(fab[1], 0), fab[2], fab[3], Math.max(fab[4], 0), fab[5]]
      : cb ? [cb.min.x, -1, cb.min.z, cb.max.x, 1, cb.max.z] : null;
    // environment-follow for our own lit materials (time of day / weather), lamps + menorah driven here
    const envOn = !!(rt.info as unknown as { environment?: unknown }).environment;
    const patch = (root: THREE.Object3D) => root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || Array.isArray(m) || !(o as THREE.Mesh).isMesh) return;
      if (/EMIT_lamp_voyage/.test(m.name)) { if (!this.lampMats.includes(m)) this.lampMats.push(m); return; }
      if (/EMIT_menorah/.test(m.name)) { if (!this.menorahMats.includes(m)) this.menorahMats.push(m); return; }
      if (envOn && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) patchEnvMaterial(m, { lit: true });
    });
    if (this.placeholder) patch(this.placeholder);
    patch(this.world.group); patch(this.enemies.group); patch(this.action.group);
    for (const m of this.rig.menorah) if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !this.menorahMats.includes(m as THREE.MeshStandardMaterial)) this.menorahMats.push(m as THREE.MeshStandardMaterial);
    // alarm beacons (red-orange = danger only): two on the wheelhouse roof when the placeholder is used
    if (this.placeholder) for (const x of [-2.6, 2.6]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: '#ff4b1f', transparent: true, opacity: 0.25, toneMapped: false }));
      b.position.set(x, 3.5, -9.8); b.name = 'vtp:voyage:beacon'; this.placeholder.add(b); this.beacons.push(b);
    }
    // camera far plane: the world reaches ~2.5 km
    const cam = rt.stage.camera;
    this.savedFar = cam.far;
    this.applyFar();
    // camera director (wrapping whatever was there, like the yacht)
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    const prev = hook.cameraOverride;
    this.prevOverride = prev;
    const mine: SceneRuntime['cameraOverride'] = (aspect: number) => (this.myOverride === mine ? this.shot(aspect) : null) ?? prev?.(aspect) ?? null;
    this.myOverride = mine;
    hook.cameraOverride = mine;
    this.deckCams.reset(rt.room);
    // the environment follows the voyage (hour + weather + north)
    if (this.env) (this.env as unknown as { drive: ((now: number) => Partial<SceneEnvState> | null) | null }).drive = (now) => this.envDrive(now);
    this.warm(rt);
  }

  /** The ship's own box in the ship frame: every visible mesh of the room (the hidden stand-in ground and anything the
   *  voyage hides left out) - the room's `bounds` can be a show-area box or include a ground plane. Sanity-capped by
   *  voyage.shipLength / beam / groundY. Exterior cameras keep outside it. */
  private hull: THREE.Box3 | null = null;
  private shipHull(rt: SceneRuntime, cfg: RoomVoyageConfig): THREE.Box3 {
    const ship = rt.room.root, box = new THREE.Box3(), tb = new THREE.Box3();
    ship.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(ship.matrixWorld).invert(), m = new THREE.Matrix4();
    const shown = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p && p !== ship; p = p.parent) if (!p.visible) return false; return true; };
    ship.traverse((o) => {
      const me = o as THREE.Mesh;
      if (!me.isMesh || !me.geometry || !shown(me)) return;
      if (!me.geometry.boundingBox) me.geometry.computeBoundingBox();
      tb.copy(me.geometry.boundingBox!).applyMatrix4(m.multiplyMatrices(inv, me.matrixWorld));
      if (tb.max.x - tb.min.x > 400 || tb.max.z - tb.min.z > 400) return;          // a ground / sky plane
      box.union(tb);
    });
    const L = clampN((cfg as { shipLength?: number }).shipLength, 4, 400, 38), Bm = clampN((cfg as { beam?: number }).beam, 2, 200, 9);
    const gy = -this.deckH;
    const cap = new THREE.Box3(new THREE.Vector3(-Bm / 2 - 8, gy, -L / 2 - 6), new THREE.Vector3(Bm / 2 + 8, 30, L / 2 + 6));
    if (box.isEmpty()) return new THREE.Box3(new THREE.Vector3(-Bm / 2 - 4, gy, -L / 2), new THREE.Vector3(Bm / 2 + 4, 10, L / 2));
    return box.intersect(cap);
  }

  private applyFar() {
    const rt = this.rt;
    if (!rt) return;
    const desertFar = this.world instanceof DesertProvider ? this.world.desert.cameraRange('deck').far : 0;
    const far = Math.max(desertFar, clampN(this.cfg?.far, 300, 20000, 2600));
    const cam = rt.stage.camera;
    if (cam.far < far) { cam.far = far; cam.updateProjectionMatrix(); }
    this.myFar = cam.far;
  }

  /** compile every program once, off the critical path */
  private warm(rt: SceneRuntime) {
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    try {
      for (const grp of [this.worldGroup, this.shipGroup]) {
        const p = r.compileAsync ? r.compileAsync(grp, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(grp, rt.stage.camera, rt.stage.scene));
        void p.catch(() => {});
      }
      // the banner's program too: the first support / raid banner of a show compiled it on the stream (perf lane, b12)
      const t = new THREE.CanvasTexture(document.createElement('canvas')); t.colorSpace = THREE.SRGBColorSpace;
      const m = bannerMaterial(t), probe = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25), m);
      r.compile(probe, rt.stage.camera, rt.stage.scene);
      probe.geometry.dispose(); m.dispose(); t.dispose();
    } catch { /* optional */ }
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
      const cam = rt.stage.camera;
      if (this.savedFar && cam.far === this.myFar && cam.far !== this.savedFar) { cam.far = this.savedFar; cam.updateProjectionMatrix(); }
    }
    if (this.env) { const e = this.env as unknown as { drive: unknown }; if (e.drive) e.drive = null; }
    this.deckCams.reset(null); this.broll = null; this.lastPick = null; this.legZc = undefined;
    this.voice.dispose();
    this.rig?.reset();
    for (const h of this.hiddenNodes) h.o.visible = h.vis;
    this.hiddenNodes = [];
    this.world?.dispose(); this.world = null;
    this.enemies?.dispose(); this.enemies = null;
    this.fx?.dispose(); this.fx = null;
    this.action.dispose(); this.action = new VoyageAction();
    if (this.banner) { this.banner.tex.dispose(); this.banner.mesh.geometry.dispose(); (this.banner.mesh.material as THREE.Material).dispose(); this.banner.mesh.removeFromParent(); this.banner = null; }
    this.placeholder?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.shipGroup.removeFromParent(); this.worldGroup.removeFromParent();
    setShipFrame(null);
    this.rt = null; this.cfg = null; this.room = null; this.rig = null; this.placeholder = null; this.st = null; this.out = null; this.rigJson = null;
    this.prevOverride = null; this.myOverride = null; this.lampMats = []; this.menorahMats = []; this.beacons = []; this.multK = -1; this.cut = null; this.camPick = null;
  }

  // ---------------------------------------------------------------------------------------------- inputs
  /** Chat feed -> chat activity only (cosmetic exhaust steam). Support is stamped by the host controller (SPEC D10). */
  onSupport(evs: { kind?: string; ts?: number; cue?: boolean }[], snap: boolean) {
    const now = Date.now();
    for (const e of evs) if (e.kind === 'chat' && !e.cue) this.chatTs.push(typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : now);
    if (this.chatTs.length > 400) this.chatTs.splice(0, this.chatTs.length - 400);
    void snap;
  }

  /** Tests (this page only): a stamp in `inSec` s - a stamp kind, 'support:<usd>' (the tiers it reaches), 'raid',
   *  'reward:<title>', 'chat:<n>' (chat activity). The host's real stamps come from voyageHost.ts. */
  test(kind: string = 'fireworks', inSec = 1, user = 'TestViewer') {
    const at = this.now() + inSec * 1000;
    if (kind.startsWith('chat:')) { const k = parseInt(kind.slice(5), 10) || 20; for (let i = 0; i < k; i++) this.chatTs.push(this.now() - 60000 + (60000 * i) / k); return; }
    let kinds: StampKind[] = [];
    if (kind.startsWith('support:')) kinds = voyageTiers(parseFloat(kind.slice(8)) || 5, voyageTierLines(this.bag, this.cfg));
    else if (kind.startsWith('reward:')) kinds = [voyageRewardKind(kind.slice(7), this.cfg?.rewards)];
    else if (kind === 'raid') kinds = ['convoy'];
    else if (isStampKind(kind)) kinds = [kind];
    for (const k of kinds) {
      const id = (voyageHash('test', k, at, this.testStamps.length) % 2000000000) + 1;
      this.testStamps.push({ id, at: at + (TIER_OFFSET[k] ?? 0), k, who: user });
    }
    this.testStamps = this.testStamps.slice(-16);
    this.bagDirty = true;                                  // re-merge
  }

  /** Tests: this page's local test stamps (copy them to a second page to compare digests; [] clears). */
  get tests(): VoyageStamp[] { return this.testStamps.map((s) => ({ ...s })); }
  set tests(v: VoyageStamp[]) { this.testStamps = Array.isArray(v) ? v.slice(-16).map((s) => ({ ...s })) : []; this.bagDirty = true; }

  get demo() { return this.demoOn; }
  set demo(v: boolean) { this.demoOn = v; const r = this.rt ?? this.lastRt; if (r) { this.detach(); this.attach(r); } }
  /** Test pages: replace the room's `voyage` config and re-attach (null = the room's own; 'demo' = generated). */
  debugConfig(cfg: RoomVoyageConfig | 'demo' | null) {
    const r0 = this.rt ?? this.lastRt;
    if (!r0) return 'no room loaded';
    this.debugCfg = cfg === 'demo' ? demoConfig(r0) : cfg;
    this.detach(); this.attach(r0);
    return this.rt ? 'attached' : 'no config';
  }

  private readBag(rt: SceneRuntime) {
    const src = (rt.state.modes ?? {})[VOYAGE_BAG];
    if (src !== this.bagSrc || this.bagDirty) {
      this.bagSrc = src; this.bagDirty = false;
      // the room's seed / pacing where the host never wrote one - the SAME defaults the host studio uses (voyageBagOf)
      const b = voyageBagFrom(src, this.cfg, rt.info.id, this.seedOverride);
      const evs = [...b.stamps, ...this.testStamps.filter((s) => isEventKind(s.k))].sort((x, y) => x.at - y.at);
      const fx = [...b.fx, ...this.testStamps.filter((s) => !isEventKind(s.k))].sort((x, y) => x.at - y.at);
      // a page-local test treasure stamp also needs its hold (the host adds it to the bag for real stamps)
      for (const s of this.testStamps) if (s.k === 'treasure' && !voyageStopHeld(b, s) && !b.holds.some((h) => h.until === null)) {
        b.holds = [...b.holds, { at: s.at, until: s.at + (8 + stopDuration(voyageHash(b.seed, 'stamp', s.id))) * 1000 }];
      }
      this.bag = sanitizeVoyage(b);
      this.bag.stamps = evs.slice(-24);
      this.bag.fx = fx.slice(-24);
    }
    return this.bag;
  }

  // ---------------------------------------------------------------------------------------------- body pose
  private get deckH() { return -clampN(this.cfg?.groundY, -60, -2, DEFAULT_GROUND_Y); }
  private get kneelMax() { return clampN(this.cfg?.gait?.kneel, 0, 6, DEFAULT_KNEEL); }

  /** The ship's pose at S (pure): terrain-following height + slope over the rest feet, gait heave / sway, kneel, brake.
   *  With a provider that places its own world (poseMode 'provider': the desert), only the gait parts + kneel remain. */
  bodyAt(st: VoyageNow, mult: number, exterior: boolean, out: BodyPose = { Y: 0, pitch: 0, roll: 0, heave: 0, groundRef: 0, tPitch: 0, tRoll: 0 }): BodyPose {
    const world = this.world!, ground = world.ground, rig = this.rig!, cfg = this.cfg ?? {};
    const S = st.S;
    let groundRef = 0, tPitch = 0, tRoll = 0;
    if (world.poseMode !== 'provider') {
      let n = 0, sh = 0, sf = 0, sl = 0, sff = 0, sll = 0, sfh = 0, slh = 0, sfl = 0;
      const legs = rig.legs.length ? rig.legs.map((l) => l.gait) : [{ fwd: 15, lat: -7 }, { fwd: 15, lat: 7 }, { fwd: -8, lat: -7 }, { fwd: -8, lat: 7 }].map((x, i) => ({ id: `${i}`, phi: 0, ...x }));
      for (const L of legs) {
        for (const k of [-1, 0, 1]) {
          const f = L.fwd + k * 8, h = ground.heightAt(S + f, L.lat);
          n++; sh += h; sf += f; sl += L.lat; sff += f * f; sll += L.lat * L.lat; sfh += f * h; slh += L.lat * h; sfl += f * L.lat;
        }
      }
      const mh = sh / n, mf = sf / n, ml = sl / n;
      const cff = sff / n - mf * mf, cll = sll / n - ml * ml, cfl = sfl / n - mf * ml, cfh = sfh / n - mf * mh, clh = slh / n - ml * mh;
      const det = cff * cll - cfl * cfl;
      const bF = Math.abs(det) > 1e-6 ? (cfh * cll - clh * cfl) / det : 0, bL = Math.abs(det) > 1e-6 ? (clh * cff - cfh * cfl) / det : 0;
      groundRef = mh - bF * mf - bL * ml;                    // the plane's height under the ship's origin
      const cap = clampN(cfg.body?.terrainPitchMax, 0, 10, 4) * D2R;
      tPitch = Math.max(-cap, Math.min(cap, Math.atan(bF))); tRoll = Math.max(-cap, Math.min(cap, Math.atan(bL)));
    }
    const bo = cfg.body ?? {};
    const heaveA = exterior ? clampN(bo.heaveExt, 0, 1, 0.12) : clampN(bo.heave, 0, 0.5, 0.04) * mult;
    const rollA = (exterior ? 1.2 : clampN(bo.rollDeg, 0, 5, 0.6) * mult) * D2R;
    const pitchA = (exterior ? 4 : clampN(bo.pitchDeg, 0, 5, 0.4) * mult) * D2R;
    const speedK = smooth01(st.v / 1.2);
    const gb = gaitBob(S, this.gait.cycle, speedK);
    const kneel = (st.stop?.kneel ?? 0) * this.kneelMax;
    // pitch: terrain (gain 1 exterior; the deck sees a quarter of it within its budget) + the brake / start
    const brake = Math.max(-0.006, Math.min(0.006, st.a * 0.004));
    let pitch = tPitch * (exterior ? 1 : 0.25) + brake * (exterior ? 1 : mult);
    let roll = tRoll * (exterior ? 1 : 0.25) + gb.roll * rollA * 0.5;
    pitch = Math.max(-Math.max(pitchA, exterior ? 4 * D2R : 0), Math.min(Math.max(pitchA, exterior ? 4 * D2R : 0), pitch));
    roll = Math.max(-Math.max(rollA, exterior ? 4 * D2R : 0), Math.min(Math.max(rollA, exterior ? 4 * D2R : 0), roll));
    out.heave = gb.heave * heaveA;
    out.Y = (world.poseMode === 'provider' ? 0 : groundRef + this.deckH) - kneel + out.heave;
    out.pitch = pitch; out.roll = roll; out.groundRef = groundRef; out.tPitch = tPitch; out.tRoll = tRoll;
    return out;
  }

  private setBodyMatrix(b: BodyPose, kickPitch: number, kickRoll: number) {
    const bow = this.rig?.bowYaw ?? 0;
    // Body = T(0, Y, 0) * Rx(pitch) * Rz(-roll) * Ry(bowYaw)    (ship frame -> world-local)
    te.set(b.pitch + kickPitch, 0, -(b.roll + kickRoll), 'XZY');
    tq.setFromEuler(te).multiply(new THREE.Quaternion().setFromAxisAngle(tv.set(0, 1, 0), bow));
    this.Body.compose(tv.set(0, b.Y, 0), tq, tv2.set(1, 1, 1));
    this.BodyInv.copy(this.Body).invert();
  }

  /** world route coords -> ship frame */
  toShip = (s: number, d: number, h: number, out: THREE.Vector3) => {
    const w = this.world, S = this.st?.S ?? 0;
    if (w?.toLocal) w.toLocal(s, d, h, S, out); else out.set(d, h, -(s - S));
    return out.applyMatrix4(this.BodyInv);
  };
  /** ship frame -> world route coords */
  toWorld = (p: THREE.Vector3) => {
    const q = tv2.copy(p).applyMatrix4(this.Body), w = this.world, S = this.st?.S ?? 0;
    return w?.fromLocal ? w.fromLocal(q, S) : { s: S - q.z, d: q.x, h: q.y };
  };

  // ---------------------------------------------------------------------------------------------- per frame
  update(dt: number) {
    const rt = this.rt;
    if (!rt || !this.world || !this.rig || !this.fx || !this.enemies) return;
    const t0 = performance.now();
    if (this.manual) {
      if (!this.frozen) this.clock += dt * 1000;
      if (this.env) { this.env.manual = true; this.env.clock = this.clock; }
    }
    this.frame++;
    try { this.step(rt, dt); } catch (e) { if (this.frame % 300 === 1) console.warn('[voyage] frame failed', e); }
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(rt: SceneRuntime, dt: number) {
    const now = this.now(), t = now / 1000;
    const bag = this.readBag(rt), cfg = this.cfg!;
    const world = this.world!, rig = this.rig!, fx = this.fx!;
    this.applyFar();
    // the timeline (off = the ship stands at the start of its seed's first chapter)
    const st = bag.on ? voyageNow(bag, cfg, now) : voyageNow({ ...bag, epoch: 1, heldMs: 0, holds: [{ at: 2, until: null }], stamps: [], fx: [], pace: [] }, cfg, now);
    this.st = st;
    this.world?.prepare?.(st.S);
    // ground biome follows the chapters' flavours (the fork votes cross-fade in; biomes change only past a boundary)
    const gb = voyageGroundBinding(bag.on ? bag : { ...bag, pace: [] }, cfg, st.V);
    world.ground.legDist = st.chap.D;
    world.ground.chapterAt = gb.chapterAt;
    world.ground.biomeOf = gb.biomeOf;
    world.ground.flavourAt = gb.flavourAt;
    const plays = bag.on ? stampPlays(bag, now) : [];
    // ground flats first (cities + the dig site): every height below sees the same ground on every page
    const cities = this.cityList(st, bag);
    world.setCities(bag.events.cities ? cities : []);
    // (the dig sites first: the crew stands there; then the cities nearest the ship - a city sinking under a fork vote and its
    // replacement share one footprint)
    const cityFlats = cities.filter((c, i) => cities.findIndex((q) => Math.abs(q.s - c.s) < 1 && Math.abs(q.d - c.d) < 1) === i)
      .sort((a, b) => Math.abs(a.s - st.S) - Math.abs(b.s - st.S)).map((c) => ({ s: c.s, d: c.d, r: c.r * 1.35, h: world.ground.raw(c.s, c.d) }));
    world.ground.flats = [...this.digFlat(st, bag), ...cityFlats].slice(0, 4);
    // deck motion: the mode gain glides on this page (a mode change is a cut anyway; into React ~0.5 s), the situation
    // part is pure in time
    const mode = rt.state.mode, ls = rt.state.lights?.state ?? 'show';
    const want = modeGain(mode, ls, cfg);
    this.multK = this.multK < 0 ? want : this.multK + (want - this.multK) * (1 - Math.exp(-dt / (want < this.multK ? 0.18 : 1.0)));
    const mult = Math.min(2, this.multK * situationMult(st) * Math.max(0, Math.min(1.5, bag.sway)));
    this.mult = mult;
    const ext = this.extActive;
    this.bodyAt(st, mult, ext, this.body);
    // kicks (never in React / Gaming): last frame's (one frame of lag keeps the effects and the world on one matrix)
    const kickOk = voyageKickOk(mode, bag.sway) && !ext;
    const kk = kickOk ? Math.min(1, mult) : ext ? 1 : 0;
    this.setBodyMatrix(this.body, this.kick.pitch * kk, this.kick.roll * kk);
    this.shipGroup.matrix.copy(rt.room.root.matrixWorld);
    this.shipGroup.matrixWorldNeedsUpdate = true;
    this.shipGroup.updateMatrixWorld(true);
    // the action (battles, stamps, sortie, dust)
    const level = fxLevel(this.perf.avg);
    fx.level = level;
    fx.begin(t);
    const camF = rt.stage.camera;
    fx.uniforms.uPx.value = (2 * Math.tan((camF.fov * D2R) / 2)) / Math.max(1, rt.stage.renderer.domElement.height || 1080);
    const chat = this.chatActivity(now);
    const out = this.action.update({
      now, t, st, bag, cfg, S: st.S, v: st.v, fx, enemies: this.enemies!, ground: world.ground, rig, toShip: this.toShip, toWorld: this.toWorld, spots: this.room!.spots,
      deckH: this.deckH, groundRef: this.body.groundRef, dangerSide: (cfg.dangerSide ?? 'aft-port').includes('starboard') ? 1 : -1, level,
      plays, intensity: (e) => eventIntensity(bag, mode, e), fireKeep: this.fireKeep, fireArc: clampN(cfg.keepOut?.fireArcFromSpots, 0, 30, 6), canopy: this.canopy,
      gait: this.gait, chat, crewClaimed: this.crewClaimed,
    });
    this.out = out;
    this.kick.pitch = out.kickPitch; this.kick.roll = out.kickRoll;
    this.sceneCuts(st, bag, cities, out);
    // the world group: inverse body pose, in the room root's frame
    this.worldGroup.matrix.multiplyMatrices(rt.room.root.matrixWorld, this.BodyInv);
    this.worldGroup.matrixWorldNeedsUpdate = true;
    // the world provider
    const cam = rt.stage.camera;
    const F = this.fr;
    const camShip = rt.room.root.worldToLocal(cam.getWorldPosition(F.camShip));
    const camLocal = F.camLocal.copy(camShip).applyMatrix4(this.Body);
    const sunShip = EU.uEnvSunCol.value.lengthSq() > 1e-6 ? F.sun.copy(EU.uEnvSunDir.value) : F.sun.copy(defaultSun(st.hour));
    const sunLocal = F.sunLocal.copy(sunShip).transformDirection(this.Body);
    const lit = EU.uEnvLit.value;
    const envOn = EU.uEnvSunCol.value.lengthSq() > 1e-6 || lit.x !== 1 || lit.y !== 1 || lit.z !== 1;
    const sunCol = envOn ? F.sunCol.setRGB(EU.uEnvSunCol.value.x * 1.4 + 0.02, EU.uEnvSunCol.value.y * 1.4 + 0.02, EU.uEnvSunCol.value.z * 1.4 + 0.03) : F.sunCol.copy(defaultSunCol(st.hour));
    const amb = envOn ? F.amb.setRGB(0.42 * lit.x, 0.4 * lit.y, 0.42 * lit.z) : F.amb.copy(defaultAmb(st.hour));
    const fog = rt.stage.scene.fog as THREE.Fog | null;
    const fogCol = fog && (fog as THREE.Fog).isFog ? F.fog.copy(fog.color) : F.fog.copy(FOG_DAY).multiplyScalar(0.25 + 0.75 * (1 - st.night));
    const pw = world as PlaceholderWorld;
    const sy = Math.max(0.2, sunLocal.y);
    if (pw.shadow) pw.shadow.set((-sunLocal.x / sy) * 10, -2 - (sunLocal.z / sy) * 10, 7.5, 20);
    if (pw.dust) pw.dust.camShip.copy(camShip);
    // (the Preshow light show keeps its night sky: a storm blowing then is a dusty haze, never a white-out)
    const storm = bag.events.storms ? Math.min(st.storm, this.preshowStormCap(ls)) : 0;
    if (world instanceof DesertProvider) {
      const sk = this.showSky;
      world.desert.setNightTint(sk && sk.level > 0.05 && sk.tint ? sk.tint(this.fr.amb2) : null);
    }
    world.update({ S: st.S, sunDir: sunLocal, sunCol, amb, fogCol, night: st.night, storm, stormFront: bag.events.storms ? st.stormFront : null, heading: heading(st.S), cam: camLocal, v: st.v, wind: F.wind.set(storm * 4, 0), t, level: worldLevel(),
      hour: this.shownHour(st), now, camera: cam, renderer: rt.stage.renderer, tilt: ext ? 1 : Math.min(1, 0.25 + 0.75 * Math.min(1, mult)), groundY: -this.deckH });
    // the legs + turrets + gangway + lanterns + rams
    this.legs(st);
    rig.turrets.forEach((T, i) => rig.aim(T, out.aims[i]?.target ?? null, out.aims[i]?.w ?? 0, out.aims[i]?.recoil ?? 0));
    rig.setGangway(out.gangway);
    rig.setLanterns(this.body.pitch * 3 + st.a * 0.01, this.body.roll * 3);
    rig.pistons(rt.room.root);
    // lamps at night, the menorah flashes on the whistle, alarm beacons in battle (0.75 Hz: far under the flash limits;
    // React: beacons at 30 %)
    for (const m of this.lampMats) m.emissiveIntensity = 0.15 + 1.2 * st.night;
    for (const m of this.menorahMats) m.emissiveIntensity = 0.25 + 0.9 * st.night + 2.4 * out.hornFlash;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.75);
    const beaconK = mode === 'react' ? 0.3 : 1;
    for (const b of this.beacons) (b.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.8 * out.alarm * pulse * beaconK;
    // the speech gate for cutaways (Talk only: the interview engine owns the voices in Interview)
    if (mode === 'talk' && bag.talkCuts) {
      this.voice.sync([...rt.actors.values()].filter((a) => a.shown).map((a) => ({ key: a.key, rt: a.runtime })));
      const focus = rt.actors.get(HOST_KEY) ? HOST_KEY : ([...rt.actors.values()].find((a) => a.shown)?.key ?? '');
      this.quiet = this.voice.get(focus) < QUIET_LEVEL ? this.quiet + dt : 0;
    } else { this.voice.sync([]); this.quiet = 0; }
    // banners (who summoned / saluted), face protection, effects
    this.protectFaces(cam);
    this.drawBanner(out.banners, cam);
    fx.end();
  }

  /** the six (or n) feet: closed-form from S, onto the ground, through the body pose into the ship frame, IK */
  private legs(st: VoyageNow) {
    const rig = this.rig!, ground = this.world!.ground;
    const w = smooth01(st.v / 0.8);
    const target = this.fr.foot;
    for (const L of rig.legs) {
      footAt(st.S, L.gait, this.gait, w, this.foot);
      const f = this.foot;
      const g = ground.heightAt(f.s, f.d);
      this.toShip(f.s, f.d, g + f.lift, target);
      const out = Math.sign(L.gait.lat) || 1;
      const slope = Math.atan(ground.heightAt(f.s, f.d + out) - g) * 0.8;
      rig.solveLeg(L, target, slope);
    }
  }

  /** chapter cities (250-600 m off the route) + stamped "City ahead" (abeam ~75 s after the stamp). A city of the next
   *  chapter whose content a fork vote just changed sinks while its replacement rises (forkState w, every page alike). */
  private cityList(st: VoyageNow, bag: VoyageBag): CitySpec[] {
    const out: CitySpec[] = [];
    for (const leg of [st.leg - 1, st.leg, st.leg + 1]) {
      if (leg < 0) continue;
      const ref = chapterRef(bag, this.cfg, leg);
      const f = forkState(bag, this.cfg, leg, st.V);
      const versions: [0 | 1, number][] = f.choice === f.def || f.w >= 1 ? [[f.choice, 1]] : [[f.def, 1 - f.w], [f.choice, f.w]];
      for (const [choice, rise] of versions) {
        const p = chapterPlanOf(bag, this.cfg, leg, choice);
        for (const b of p.beats) if (b.kind === 'city') {
          const s = ref.s0 + legMotion(p, b.a ?? b.t0).s;
          if (s < st.S - 2500 || s > st.S + 3500) continue;
          // position + footprint from the chapter's layout (the same for either vote); kind + buildings from its content
          out.push({ id: `c:${leg}:${b.t0}:${b.seed}`, s, d: (b.side ?? 1) * (b.off ?? 300), kind: b.city ?? 'windtower', seed: b.seed, r: 60 + 30 * voyageRand(bag.seed, leg, b.t0), rise });
        }
      }
    }
    for (const p of stampPlays(bag, st.now, 600)) if (p.stamp.k === 'city') {
      // the host stamped where the city stands (arg = S abeam): a later Anchor does not move it
      const s = typeof p.stamp.arg === 'number' && p.stamp.arg > 0 ? p.stamp.arg : voyageDistance(bag, this.cfg, p.stamp.at + 75000);
      if (s < st.S - 2500 || s > st.S + 3500) continue;
      const kinds = ['windtower', 'hulk', 'cistern', 'souk'] as const;
      out.push({ id: `cs:${p.stamp.id}`, s, d: (voyageRand(p.seed, 1) < 0.7 ? 1 : -1) * (260 + 200 * voyageRand(p.seed, 2)), kind: kinds[p.seed % 4], seed: p.seed, r: 65 });
    }
    return out;
  }

  /** the treasure stop's dig site as a ground flat (pure from the timeline: chapter beat or stamped stop) */
  private digFlat(st: VoyageNow, bag: VoyageBag): { s: number; d: number; r: number; h: number }[] {
    const stop = st.stop;
    if (!stop) {
      // flatten ahead of time too (the site is visible long before the ship arrives - this chapter's or the next one's;
      // its place comes from the chapter layout, never from a vote)
      // every site within 2.5 km (behind too: it stays flat as it falls astern), nearest first
      const sites: { s: number; d: number }[] = [];
      for (const leg of [st.leg - 1, st.leg, st.leg + 1]) {
        if (leg < 0) continue;
        const ref = chapterRef(bag, this.cfg, leg);
        const plan = leg === st.leg ? st.plan : chapterPlanOf(bag, this.cfg, leg);
        const tr = plan.beats.find((x) => x.kind === 'treasure');
        if (!tr) continue;
        const s = ref.s0 + legMotion(plan, tr.t0 + (tr.a ?? 8) + 1).s - 4, d = (tr.side ?? 1) * (tr.off ?? 24);
        if (Math.abs(s - st.S) < 2500) sites.push({ s, d });
      }
      sites.sort((a, b) => Math.abs(a.s - st.S) - Math.abs(b.s - st.S));
      return sites.slice(0, 2).map((x) => ({ s: x.s, d: x.d, r: 9, h: this.world!.ground.raw(x.s, x.d) }));
    }
    const stopS = voyageDistance(bag, this.cfg, stop.at + 9000);
    const s = stopS - 4, d = stop.side * stop.off;
    return [{ s, d, r: 9, h: this.world!.ground.raw(s, d) }];
  }

  /** city reveal + storm wall cutaway requests (the battle / defeat / sortie ones come from the action) */
  private sceneCuts(st: VoyageNow, bag: VoyageBag, cities: CitySpec[], out: ActionOut) {
    const now = st.now, g = this.world!.ground;
    for (const b of st.plan.beats) {
      const start = now - (st.tLeg - b.t0) * 1000;
      if (b.kind === 'city' && bag.events.cities && Math.abs(st.tLeg - (b.t0 + 12)) < 30) {
        const c = cities.find((x) => x.id === `c:${st.leg}:${b.t0}:${b.seed}`);
        if (c) out.cuts.push({ key: `city:${c.id}`, kind: 'city', from: start + 12000, to: start + 17000, focusShip: this.toShip(c.s, c.d, g.raw(c.s, c.d) + 25, new THREE.Vector3()) });
      }
      if (b.kind === 'storm' && bag.events.storms && Math.abs(st.tLeg - (b.t0 - 30)) < 30) {
        out.cuts.push({ key: `storm:${st.leg}:${b.t0}`, kind: 'storm', from: start - 30000, to: start - 25000, focusShip: this.toShip(st.S + 120, -600, g.raw(st.S + 120, -600) + 80, new THREE.Vector3()) });
      }
    }
    for (const c of cities) if (c.id.startsWith('cs:')) {
      const p = bag.stamps.find((s) => `cs:${s.id}` === c.id);
      if (p && Math.abs(now - (p.at + 15000)) < 30000) out.cuts.push({ key: `city:${c.id}`, kind: 'city', from: p.at + 15000, to: p.at + 20000, focusShip: this.toShip(c.s, c.d, g.raw(c.s, c.d) + 25, new THREE.Vector3()) });
    }
  }

  private chatActivity(now: number) {
    const lag = now - 4000;
    let n = 0;
    for (const ts of this.chatTs) if (ts <= lag && ts > lag - 60000) n++;
    return Math.min(1, n / 40);
  }

  /** The hour the deck is lit at: the room environment's own (it carries the Preshow / BRB / Outro pins and its glide),
   *  else the journey hour - so the sand and the sky never show another time of day than the ship. */
  private shownHour(st: VoyageNow): number {
    const e = this.env as unknown as { cur?: { hour?: number }; onK?: number } | null;
    const h = e && (e.onK ?? 0) > 0.5 ? e.cur?.hour : undefined;
    return typeof h === 'number' && Number.isFinite(h) ? h : st.hour;
  }

  // ---------------------------------------------------------------------------------------------- environment driver
  private envDriveCache: { key: string; at: number } | null = null;
  /** The environment follows the voyage (SPEC D14 / D15): journey hour (Preshow / BRB / Outro pinned to the room's
   *  state hours), sandstorm weather while a storm beat / stamp blows, north = the route heading. Pure. */
  envDrive(now: number): (Partial<SceneEnvState> & { north?: number }) | null {
    const rt = this.rt, cfg = this.cfg;
    if (!rt || !cfg) return null;
    const bag = this.readBag(rt);
    if (!bag.on) return null;
    const st = voyageNow(bag, cfg, now);
    const stormW: EnvWeather = isEnvWeather('sandstorm') ? ('sandstorm' as EnvWeather) : 'overcast';
    // the crossfade stamp: the start of the storm's build-up (base beat or stamp), or its end while it clears
    let weather: EnvWeather = 'clear', from: EnvWeather = 'clear', at = 0;
    if (bag.events.storms && st.storm > 0.001 && this.preshowStormCap(rt.state.lights?.state ?? 'show') > 0.5) {
      const sb = st.plan.beats.find((b) => b.kind === 'storm' && st.tLeg >= b.t0 - 25 && st.tLeg < b.t1 + STORM_CLEAR);
      const sp = stampPlays(bag, now, 0).find((p) => p.stamp.k === 'storm');
      const building = sb ? st.tLeg < sb.t1 : sp ? sp.tau < sp.dur - STORM_CLEAR : false;
      const key = sb ? `b:${st.leg}:${sb.t0}:${building}:${bag.epoch}:${bag.heldMs}:${bag.seed}:${bag.holds.map((h) => `${h.at}-${h.until}`).join(',')}:${bag.pace.length}` : `s:${sp?.stamp.id}:${building}`;
      if (this.envDriveCache?.key !== key) {
        let w = now;
        if (sb) { const v = st.chap.v0 + (building ? sb.t0 - 25 : sb.t1); const x = voyageWallOf(bag, v, now - 3600_000); w = Number.isFinite(x) ? Math.round(x) : now; }
        else if (sp) w = Math.round(sp.stamp.at + (building ? (STORM_APPROACH - 25) * 1000 : (sp.dur - STORM_CLEAR) * 1000));
        this.envDriveCache = { key, at: w };
      }
      at = this.envDriveCache.at;
      weather = building ? stormW : 'clear';
      from = building ? 'clear' : stormW;
    }
    const d: Partial<SceneEnvState> & { north?: number } = { on: true, weatherMode: 'manual', weather, weatherFrom: from, weatherAt: at, fade: 25, wind: 1 + st.storm };
    const envCfg = (rt.info as unknown as { environment?: { hourByState?: Record<string, number>; north?: number } }).environment;
    const ls = rt.state.lights?.state ?? 'show';
    const pins: Record<string, number> = { preshow: 19.6, brb: 22.5, outro: 18.4, ...(envCfg?.hourByState ?? {}) };
    const preH = ls === 'preshow' ? this.preshowCfg()?.hour ?? null : null;
    if (preH !== null) pins.preshow = preH;
    if (bag.env === 'journey') { d.clock = 'fixed'; d.hour = ls === 'preshow' || ls === 'brb' || ls === 'outro' ? pins[ls] : st.hour; }
    else if (bag.env === 'fixed') { d.clock = 'fixed'; d.hour = bag.hour; }
    d.north = (envCfg?.north ?? 0) + heading(st.S) / D2R;
    return d;
  }

  // ---------------------------------------------------------------------------------------------- cameras
  private shot(aspect: number): { key: string; pose: CamPose; secs: number } | null {
    this.cams.stale = false;
    const sh = this.shotNow(aspect);
    // (an exterior shot still being planned with no recent exterior pose to hold - the first frame or two after the deck
    // cameras: keep the camera the room had)
    if (sh && this.extActive && this.cams.stale) { this.extActive = false; return null; }
    return sh;
  }

  private shotNow(aspect: number): { key: string; pose: CamPose; secs: number } | null {
    const rt = this.rt, out = this.out;
    this.extActive = false;
    if (!rt || !this.st || !this.world) return null;
    const bag = this.bag;
    if (!bag.on) return null;
    const s = rt.state, now = this.now();
    const ls = s.lights?.state ?? 'show';
    if (this.extPreview) {
      const p = this.extPreview, dur = Math.max(2, p.dur ?? 14), at = p.at ?? 0;
      const el = (now - at) / 1000, k = Math.floor(el / dur);
      const mv = p.move as ExtMove, u = (el - k * dur) / dur, seed = voyageHash('preview', p.move, k);
      const sh = PERFORMER_MOVES.includes(mv) ? this.performerShot(mv, u, seed, aspect, `voyage:preview:${p.move}:${k}`)
        : { key: `voyage:preview:${p.move}:${k}`, pose: this.cams.pose(mv, u, seed, this.camCtx(), null, now - (el - k * dur) * 1000, dur), secs: 0, move: mv };
      if (sh) { this.extActive = !PERFORMER_MOVES.includes(mv); this.lastShot = sh; return sh; }
    }
    if (this.directorAny && s.mode === 'talk') {
      const p = this.preshowCfg();
      const sh = this.directorShot(now, aspect, { moves: p?.moves ?? [], performer: p?.performer ?? 0.3, bars: p?.bars ?? {}, salt: 'dir' });
      if (sh) return sh;
    }
    // Talk-only cutaways (SPEC 5.3): only when the host turned them on (bag.talkCuts, off by default: in Talk the camera
    // stays on the host's choice), <= 1 per 90 s, only once the focus has been quiet for 1.2 s; React / Gaming /
    // Interview never lose the screen or the cams. The host picking a camera (or a focus) ends a cut on air at once and
    // holds the next one off for a full spacing: their choice wins.
    const talk = voyageTalkCuts(bag, s.mode, ls, !!s.stage?.hole);
    const pick = `${s.camera}|${s.focus ?? ''}`;
    if (pick !== this.camPick) {
      if (this.camPick !== null) { this.cut = null; this.broll = null; this.lastCutAt = now; this.lastBrollAt = now; }
      this.camPick = pick;
    }
    if (!talk) this.cut = null;
    if (this.cut && now >= this.cut.to) this.cut = null;
    if (talk && !this.cut && out) {
      for (const c of out.cuts) {
        if (now < c.from || now >= c.from + 2500) continue;                     // a cut is only taken near its start
        if (now - this.lastCutAt < CUT_SPACING * 1000) break;
        if (!this.ignoreSpeech && this.quiet < QUIET_SECS) break;
        this.cut = { key: c.key, req: c, from: now, to: now + CUT_LEN[c.kind] * 1000 };
        this.lastCutAt = now;
        break;
      }
    }
    if (this.cut) {
      const c = this.cut;
      const ctx = this.camCtx();
      // the focus comes from this frame's request (the wreck / enemy moves aft in the ship frame as the ship walks; a cut
      // taken right after a seek must not keep the stale pre-seek focus)
      const live = out?.cuts.find((x) => x.key === c.key);
      const sh = this.cams.cut(c.req.kind, c.key, now, c.from, c.to, (live ?? c.req).focusShip, ctx);
      this.extActive = true; this.lastShot = sh;
      return sh;
    }
    // the Preshow exterior show (voyage.preshow): the cameras leave the deck and watch the ship walk under the show sky -
    // by default a DIRECTOR cutting on the music's bar lines (2 bars on a drop / build, 4 in the groove, 8 in a breakdown),
    // mixing exterior moves with performer shots on the deck; `cuts: 'clock'` = the fixed shot clock of beta.12's first cut
    const pre = this.preshowCfg();
    if (pre && ls === 'preshow' && s.mode === 'talk' && !s.stage?.hole && !rt.composite && (pre.always || (bag.extCams && s.ambcam?.on))) {
      if (pre.cuts === 'music') {
        const sh = this.directorShot(now, aspect, { moves: pre.moves, performer: pre.performer, bars: pre.bars, salt: 'dir' });
        if (sh) return sh;
      }
      const slot = s.ambcam?.on ? ambSlot(s.ambcam, 'preshow') : null;
      const cycle = slot?.on ? Math.max(8, slot.cycle) : pre.shot;
      const sh = this.cams.show(now, slot?.on ? s.ambcam!.at : 0, cycle, pre.moves.filter((m) => !PERFORMER_MOVES.includes(m)), this.camCtx());
      this.extActive = true; this.lastShot = sh;
      return sh;
    }
    // Show b-roll (voyage.broll, Talk only): a short exterior cut on a bar line while the performer has been quiet a while,
    // at most one per `every` s; back to the deck cameras the moment the cut ends
    const br = this.brollCfg();
    if (!br || !talk) this.broll = null;
    if (br && talk) {
      if (this.broll && now >= this.broll.until) this.broll = null;
      if (!this.broll && now - this.lastBrollAt > br.every * 1000 && (this.ignoreSpeech || this.quiet >= br.quiet) && now - this.lastCutAt > 20000) {
        const m = musicFrame(now);
        // (on a downbeat only: a cut lands with the music)
        if (m.barPos < 0.35) {
          const pk = directorPick({ bar: Math.floor(m.beat / 4), beat: Math.floor(m.beat / 4) * 4, bpm: m.bpm, section: 'groove' },
            { moves: br.moves, performer: 0, hasPerformer: false, hasWreck: !!this.wreckShip(), bars: { groove: br.bars }, salt: 'broll' });
          this.broll = { pick: pk, until: now + pk.secs * 1000 };
          this.lastBrollAt = now;
        }
      }
      if (this.broll) {
        const b = this.broll, u = 1 - (b.until - now) / (b.pick.secs * 1000);
        const sh: ExtShot = { key: b.pick.key, pose: this.cams.pose(b.pick.move, Math.max(0, Math.min(1, u)), b.pick.seed, this.camCtx(), null, b.until - b.pick.secs * 1000, b.pick.secs), secs: 0, move: b.pick.move };
        this.extActive = true; this.lastShot = sh;
        return sh;
      }
    }
    // the exterior program (Preshow / BRB / Outro with the host's ambient cameras on)
    if (bag.extCams && s.ambcam?.on && s.mode === 'talk' && !s.stage?.hole && (ls === 'preshow' || ls === 'brb' || ls === 'outro')) {
      const slot = ambSlot(s.ambcam, ls);
      if (slot.on) {
        const sh = this.cams.program(ls, now, s.ambcam.at, Math.max(10, slot.cycle), this.camCtx());
        this.extActive = true; this.lastShot = sh;
        return sh;
      }
    }
    void aspect;
    return null;
  }

  /** The director's shot now (music-timed, pure in the music clock: the auto groove from the wall clock, or the studio's
   *  beat packets). A performer move with no clean performer camera falls back to the next exterior move. */
  private directorShot(now: number, aspect: number, o: { moves: ExtMove[]; performer: number; bars: Partial<Record<MusicSection, number>>; salt: string }): (ExtShot & { subjects?: string[] }) | null {
    const m = musicFrame(now);
    const subs = this.performers();
    const opts = { moves: o.moves, performer: o.performer, bars: o.bars, salt: o.salt, hasPerformer: subs.length > 0, hasWreck: !!this.wreckShip(), hasSky: !!this.showSky && this.showSky.level > 0.2 };
    const pk = directorPick({ bar: m.bar, beat: m.beat, bpm: m.bpm, section: m.section }, opts);
    this.lastPick = pk;
    // (the next shot is known up to the music's next section: plan it ahead, a few ms a frame - what airs is the same
    // on every page either way, this only moves the work off the cut's frame)
    const nx = directorNext(pk, { bar: m.bar, beat: m.beat, bpm: m.bpm, section: m.section }, opts,
      (bar) => musicFrame(now + ((bar * 4 - m.beat) * 60000) / Math.max(30, m.bpm)).section);
    for (const n of nx) this.cams.prefetch(PERFORMER_MOVES.includes(n.pick.move) ? 'TRACK' : n.pick.move, n.pick.seed, this.camCtx(), now + n.inMs, n.pick.secs);
    if (PERFORMER_MOVES.includes(pk.move)) {
      const sh = this.performerShot(pk.move, pk.u, pk.seed, aspect, pk.key, now - pk.u * pk.secs * 1000);
      if (sh) { this.extActive = false; this.lastShot = sh; return sh; }
    }
    const move = PERFORMER_MOVES.includes(pk.move) ? 'TRACK' : pk.move;
    const startMs = now - pk.u * pk.secs * 1000;
    const sh: ExtShot = { key: pk.key, pose: this.cams.pose(move, pk.u, pk.seed, this.camCtx(), null, startMs, pk.secs), secs: 0, move };
    sh.move = this.cams.last?.move ?? move;                 // (the shot plan may have swapped a move the land blocked)
    this.extActive = true; this.lastShot = sh;
    return sh;
  }

  /** The performers a deck shot can frame (stable order), with their framing subjects. */
  private performers(): ShotSubject[] {
    const rt = this.rt;
    if (!rt) return [];
    const out: ShotSubject[] = [];
    for (const k of [...rt.actors.keys()].sort()) { const s = rt.subjectFor(k); if (s) out.push(s); }
    return out;
  }

  /** A performer shot (DECK = a slow arc, PUSHIN = a push-in) on one of the performers (the seed picks), or null. */
  private performerShot(move: ExtMove, u: number, seed: number, aspect: number, key: string, startMs: number = this.now()): (ExtShot & { subjects: string[] }) | null {
    const subs = this.performers();
    if (!subs.length) return null;
    const world = this.worldOpenness(startMs);
    for (let i = 0; i < subs.length; i++) {
      const s = subs[(seed + i) % subs.length];
      const d = this.deckCams.shot(s, u, seed, move === 'PUSHIN' ? 'push' : 'arc', aspect, world ?? undefined);
      if (d) return { key: `${key}:${s.key}:${d.key}`, pose: d.pose, secs: 0, move, subjects: [s.key] };
    }
    return null;
  }

  /** How open the moving world is behind a performer for a view direction (three world, unit): 1 = the horizon or the
   *  sky (land under 4 deg), falling to 0 for land rising 34+ deg (a canyon wall close by) - continuous, so in a canyon the
   *  lowest wall wins - sampled 120..900 m out on the ground at the shot's start (pure in the clock). null = no world. */
  private worldOpenness(startMs: number): ((dir: THREE.Vector3) => number) | null {
    const rt = this.rt, w = this.world, st = this.st, cfg = this.cfg;
    if (!rt || !w || !st || !cfg) return null;
    const dS = voyageDistance(this.bag, cfg, startMs) - st.S;
    const inv = new THREE.Matrix4().copy(rt.room.root.matrixWorld).invert();
    const g = w.ground;
    return (dir: THREE.Vector3) => {
      const d = dir.clone().transformDirection(inv).setY(0);
      if (d.lengthSq() < 1e-6) return 1;
      d.normalize();
      const eye = this.toWorld(new THREE.Vector3(0, 1.5, 0));
      let el = -1;
      for (const t of [120, 250, 450, 900]) {
        const q = this.toWorld(d.clone().multiplyScalar(t).setY(1.5));
        el = Math.max(el, Math.atan2(g.heightAt(q.s + dS, q.d) - eye.h, t));
      }
      const deg = (el * 180) / Math.PI;
      return 1 - Math.min(1, Math.max(0, (deg - 4) / 30));
    };
  }

  /** The burning wreck the ship passes next (ship frame), or null (no desert / no wreck near). */
  private wreckShip(): THREE.Vector3 | null {
    const w = this.world;
    if (!(w instanceof DesertProvider)) return null;
    const f = w.wreckAt();
    return f ? this.toShip(f.s, f.d, f.h, new THREE.Vector3()) : null;
  }

  /** The most storm the world shows in this lighting state: Preshow (with the exterior show) caps it at
   *  voyage.preshow.storm (default 0.3: dust in the air, the light show still reads); 1 elsewhere. */
  private preshowStormCap(ls: string): number {
    if (ls !== 'preshow' || !this.preshowCfg()) return 1;
    const p = this.cfg?.preshow;
    return clampN(p && typeof p === 'object' ? (p as { storm?: number }).storm : undefined, 0, 1, 0.3);
  }

  /** Test pages / e2e: is the ship walking bow-first RIGHT NOW? (call after a frame)
   *  - travel: the route ahead of the ship in the ship frame (what the world streams past), against the bow (dot, 1 =
   *    straight ahead); measured twice: through toShip and through the desert's rendered world matrix
   *  - gait: per leg, a standing foot stays put on the ground (so it moves aft along the hull: it pushes), a swinging one
   *    never goes backwards over the ground, and the next footfall lands ahead of the last (no moonwalking). */
  directionProbe(): { S: number; v: number; dot: number; dotRendered: number | null; legs: { id: string; stance: boolean; held: boolean; ground: number; rel: number; nextPlantAhead: boolean }[] } | null {
    const st = this.st, rig = this.rig, w = this.world;
    if (!st || !rig || !w || !this.rt) return null;
    const g = w.ground;
    const bow = new THREE.Vector3(Math.sin(rig.bowYaw), 0, -Math.cos(rig.bowYaw));
    const a = this.toShip(st.S, 0, g.heightAt(st.S, 0), new THREE.Vector3()), b = this.toShip(st.S + 25, 0, g.heightAt(st.S + 25, 0), new THREE.Vector3());
    const dir = b.sub(a).setY(0).normalize();
    let dotRendered: number | null = null;
    if (w instanceof DesertProvider) {
      // independently, through what is drawn: a point 25 m ahead on the route in the desert's world -> the room
      const d = w.desert, base = (w as unknown as { base: number }).base, O = d.origin();
      const pt = (s: number) => { const r = d.route.at(s - base); return new THREE.Vector3(r.x - O.x, d.heightAtRoute(s - base, 0), r.z - O.z).applyMatrix4(d.world.matrixWorld).applyMatrix4(this.rt!.room.root.matrixWorld.clone().invert()); };
      const p0 = pt(st.S), p1 = pt(st.S + 25);
      dotRendered = +p1.sub(p0).setY(0).normalize().dot(bow).toFixed(4);
    }
    const wgt = smooth01(st.v / 0.8), dS = 0.4;
    const legs = rig.legs.map((L) => {
      const f0 = { ...footAt(st.S, L.gait, this.gait, wgt, { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 }) };
      const f1 = { ...footAt(st.S + dS, L.gait, this.gait, wgt, { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 }) };
      // the foot's travel over the ground (>= 0: never backwards) and along the hull (minus the ship's: < 0 = aft)
      const ground = f1.s - f0.s, rel = ground - dS;
      // the next plant: where this foot lands after its next swing (one gait cycle on) is ahead of where it stands now
      const later = footAt(st.S + this.gait.cycle, L.gait, this.gait, 1, { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 });
      return { id: L.id, stance: f0.stance, held: f0.stance && f1.stance, ground: +ground.toFixed(4), rel: +rel.toFixed(3), nextPlantAhead: later.s > f0.s + 0.5 };
    });
    return { S: +st.S.toFixed(2), v: +st.v.toFixed(3), dot: +dir.dot(bow).toFixed(4), dotRendered, legs };
  }

  /** Test pages / e2e: what the current camera sees of the ship. shipFrac = share of a 32 x 18 ray grid that meets the
   *  room's geometry within 80 m (the hull filling the frame); height / cx / cy = the hull box projected (NDC, 0..1 of
   *  the frame height; centre -1..1). */
  shotMetrics(light = false): { shipFrac: number; height: number; cx: number; cy: number; inFrame: boolean; bow: [number, number, number]; stern: [number, number, number]; grid: number[] } | null {
    const rt = this.rt, R = this.deckCams.roomRays;
    if (!rt) return null;
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    // (a ray grid against what is DRAWN of the ship: the room's visible meshes, the placeholder; hits at sand level are the
    // room's hidden stand-in ground, never the ship)
    let hit = 0, n = 0;
    const grid: number[] = [];
    if (!light) {
      const o = cam.getWorldPosition(new THREE.Vector3()), d = new THREE.Vector3();
      const rc = new THREE.Raycaster(); rc.far = 80;
      const inv = rt.room.root.matrixWorld.clone().invert(), gY = (this.placeholder ? PLACEHOLDER_BOUNDS : (this.hull ?? this.room!.bounds)).min.y;
      const shown = (ob: THREE.Object3D) => { for (let q: THREE.Object3D | null = ob; q; q = q.parent) if (!q.visible) return false; return true; };
      const targets: THREE.Object3D[] = [rt.room.root, ...(this.placeholder ? [this.placeholder] : [])];
      for (let j = 0; j < 14; j++) for (let i = 0; i < 24; i++) {
        d.set(((i + 0.5) / 24) * 2 - 1, ((j + 0.5) / 14) * 2 - 1, 0.5).unproject(cam).sub(o).normalize();
        n++;
        rc.set(o, d);
        const h = rc.intersectObjects(targets, true).find((x) => shown(x.object) && !/^vtp:/.test(x.object.name) && x.point.clone().applyMatrix4(inv).y > gY + 0.3);
        if (h) { hit++; grid.push(j * 24 + i); }
      }
    }
    void R;
    const box = this.placeholder ? PLACEHOLDER_BOUNDS : (this.hull ?? this.room!.bounds);
    const M = rt.room.root.matrixWorld;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(M).project(cam);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    // the bow and stern ends on screen (NDC x, y, and z < 1 = in front of the lens): the contact sheets draw the travel arrow
    const bw = this.rig?.bowYaw ?? 0, dir = new THREE.Vector3(Math.sin(bw), 0, -Math.cos(bw)), mid = box.getCenter(new THREE.Vector3());
    const half = Math.abs(dir.x) * (box.max.x - box.min.x) / 2 + Math.abs(dir.z) * (box.max.z - box.min.z) / 2;
    const end = (k: number): [number, number, number] => { const q = mid.clone().addScaledVector(dir, k * half * 0.92).applyMatrix4(M).project(cam); return [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(4)]; };
    return { shipFrac: n ? +(hit / n).toFixed(3) : 0, height: +((y1 - y0) / 2).toFixed(3), cx: +((x0 + x1) / 2).toFixed(3), cy: +((y0 + y1) / 2).toFixed(3), inFrame: x0 > -1.02 && x1 < 1.02 && y0 > -1.02 && y1 < 1.02, bow: end(1), stern: end(-1), grid };
  }

  private legZc: [number, number] | null | undefined;
  /** the feet's fore-most / aft-most z at rest in the bow frame (UNDER rides between them), once per rig */
  private legZ(): [number, number] | undefined {
    if (this.legZc === undefined) {
      const rig = this.rig;
      if (!rig || rig.legs.length < 2) this.legZc = null;
      else { const z = rig.legs.map((L) => -L.gait.fwd); this.legZc = [Math.min(...z), Math.max(...z)]; }
    }
    return this.legZc ?? undefined;
  }

  /** scene.json voyage.broll: Show b-roll cutaways (off unless the room turns them on). */
  private brollCfg(): { every: number; bars: number; quiet: number; moves: ExtMove[] } | null {
    const b = this.cfg?.broll;
    if (!b || (typeof b === 'object' && b.on === false)) return null;
    const o = typeof b === 'object' ? b : {};
    const moves = Array.isArray(o.moves) ? o.moves.filter((m): m is ExtMove => typeof m === 'string' && BROLL_MOVES.includes(m as ExtMove)) : [];
    return { every: clampN(o.every, 20, 600, 45), bars: Math.round(clampN(o.bars, 2, 8, 4)), quiet: clampN(o.quiet, 0.5, 10, 2.5), moves };
  }

  /** The smoothed ship frame -> the world provider's local frame at show time ms (the kneel of a treasure stop; the
   *  desert places its own ground, so nothing else): pure in the bag and the time, memoised per 100 ms. */
  private smoothAt(ms: number, out: THREE.Matrix4): THREE.Matrix4 {
    const k = Math.round(ms / 100);
    if (this.smoothBag !== this.bag) { this.smoothBag = this.bag; this.smoothMemo.clear(); }
    let y = this.smoothMemo.get(k);
    if (y === undefined) {
      const st = voyageNow(this.bag, this.cfg, k * 100);
      y = -(st.stop?.kneel ?? 0) * this.kneelMax;
      if (this.smoothMemo.size > 512) this.smoothMemo.clear();
      this.smoothMemo.set(k, y);
    }
    return out.makeTranslation(0, y, 0);
  }
  private smoothBag: VoyageBag | null = null;
  private smoothMemo = new Map<number, number>();

  private camCtx() {
    const rt = this.rt!, st = this.st!, cfg = this.cfg!, bag = this.bag;
    // the smoothed frame: terrain height + slope without the gait's heave / sway -> ship frame = Body^-1 * Smooth
    const b = this.body;
    const provider = this.world!.poseMode === 'provider';
    const F = this.fr;
    const smooth = F.smooth.compose(F.sv.set(0, (provider ? 0 : b.groundRef + this.deckH) - (st.stop?.kneel ?? 0) * this.kneelMax, 0),
      F.sq.setFromEuler(F.se.set(b.tPitch, 0, -b.tRoll, 'XZY')), F.one);
    const ground = this.world!.ground;
    // the shot planner's world (the desert): exact heights at any distance S, the solid things on the sand
    const dw = this.world instanceof DesertProvider ? this.world : null;
    return {
      smoothToShip: F.smoothToShip.multiplyMatrices(this.BodyInv, smooth),
      ...(dw ? {
        smoothAt: (ms: number, out: THREE.Matrix4) => this.smoothAt(ms, out),
        planBase: dw.baseNow, baseOf: (S: number) => dw.baseOf(S),
        worldAt: (q: THREE.Vector3, S: number, out: THREE.Vector3, base: number) => dw.worldAt(q, S, out, base),
        rootAt: (w: THREE.Vector3, S: number, out: THREE.Vector3, base: number) => dw.rootAt(w, S, out, base),
        groundW: (x: number, z: number) => dw.groundW(x, z),
        routeWorld: (s: number, d: number, h: number, base: number, out: THREE.Vector3) => dw.routeWorld(s, d, h, base, out),
        wreckWorldAt: (S: number, base: number) => dw.wreckWorldAt(S, base),
        solidsIn: (x0: number, z0: number, x1: number, z1: number) => dw.solidsIn(x0, z0, x1, z1),
        solidsReady: (S0: number, S1: number) => dw.solidsReadyFor(S0, S1),
      } : {}),
      toShip: this.toShip, toWorld: this.toWorld, heightAt: (s: number, d: number) => ground.heightAt(s, d),
      shipToThree: F.shipToThree.copy(rt.room.root.matrixWorld),
      hull: F.hull.copy(this.placeholder ? PLACEHOLDER_BOUNDS : (this.hull ?? this.room!.bounds)),
      side: (cfg.dangerSide ?? 'aft-port').includes('starboard') ? 1 : -1, S: st.S,
      distanceAt: (ms: number) => voyageDistance(bag, cfg, ms),
      tune: (cfg.extCams ?? {}) as Record<string, Record<string, unknown>>,
      hero: this.showSky?.heroDir() ?? null,
      wreck: this.wreckShip(),
      bowYaw: this.rig?.bowYaw ?? 0,
      legZ: this.legZ(),
      roomClear: (a: THREE.Vector3, b: THREE.Vector3) => {
        const R = this.deckCams.roomRays, M = rt.room.root.matrixWorld;
        const A = a.clone().applyMatrix4(M), B = b.clone().applyMatrix4(M);
        if (R && !R.clear(A, B)) return false;
        // (the procedural placeholder ship is not part of the room's own geometry)
        if (this.placeholder) {
          const d = B.clone().sub(A), len = d.length();
          if (len > 1e-4) { const rc = new THREE.Raycaster(A, d.divideScalar(len), 0, len); if (rc.intersectObject(this.placeholder, true).length) return false; }
        }
        return true;
      },
    };
  }

  /** The room's Preshow exterior show (scene.json voyage.preshow), sanitised; null = none. */
  private preshowCfg(): { always: boolean; hour: number | null; shot: number; moves: ExtMove[]; cuts: 'music' | 'clock'; performer: number; bars: Partial<Record<MusicSection, number>> } | null {
    // zero-effort: every walking ship gets the show in Preshow unless the room turns it off (preshow: false / exterior:
    // false); a room only tunes it (hour, shot length, moves)
    const p0 = this.cfg?.preshow;
    if (!this.cfg || p0 === false || (p0 && typeof p0 === 'object' && p0.exterior === false)) return null;
    const p = p0 && typeof p0 === 'object' ? p0 : {};
    const moves = Array.isArray(p.moves) ? p.moves.filter((m): m is ExtMove => typeof m === 'string' && (DIRECTOR_MOVES as string[]).includes(m)) : [];
    const bars: Partial<Record<MusicSection, number>> = {};
    if (p.bars && typeof p.bars === 'object') for (const k of ['drop', 'build', 'groove', 'breakdown'] as MusicSection[]) { const v = (p.bars as Record<string, unknown>)[k]; if (typeof v === 'number' && Number.isFinite(v)) bars[k] = Math.round(Math.max(1, Math.min(16, v))); }
    return { always: p.always !== false, hour: typeof p.hour === 'number' && Number.isFinite(p.hour) ? ((p.hour % 24) + 24) % 24 : PRESHOW_NIGHT, shot: clampN(p.shot, 6, 60, 13), moves,
      cuts: p.cuts === 'clock' ? 'clock' : 'music', performer: clampN(p.performer, 0, 1, 0.3), bars };
  }

  /** A show sky for a walking ship whose room has no `showSky` block (zero-effort): the default planets and a beam rig
   *  found on the ship itself - searchlights on the corners of the covered show deck (the first dry box) and on the fore /
   *  aft decks, laser fans over the show deck and the stern. null = no voyage here, or the Preshow show is turned off. */
  showSkyDefaults(): Record<string, unknown> | null {
    if (!this.rt || !this.room || !this.preshowCfg()) return null;
    const hull = this.hull ?? this.room.bounds, dry = this.room.dry[0] ?? null;
    const top = dry ? dry.max.y : 3;
    const beams: number[][] = [];
    if (dry) for (const x of [dry.min.x, dry.max.x]) for (const z of [dry.min.z, dry.max.z]) beams.push([x, top + 0.2, z]);
    const bx = Math.max(1.5, (hull.max.x - hull.min.x) * 0.18);
    for (const z of [hull.min.z * 0.72, hull.max.z * 0.6]) for (const x of [-bx, bx]) beams.push([x, 0, z]);
    const lasers = [[0, top + 1.2, dry ? dry.min.z : 0], [0, top, hull.max.z * 0.45]];
    return { states: ['preshow'], beams: beams.map((at) => ({ at })), lasers };
  }

  // ---------------------------------------------------------------------------------------------- banner
  /** Where a support banner may sit this frame: the first free slot in the top band (centre, then the corners) that touches
   *  no face, no React screen (or its passthrough hole) and no interview monitor / keep-out (SPEC 5.6: React "never over
   *  the screen rect", Interview "never over the monitor"); null = nowhere free (the banner fades out). Never over Gaming
   *  tiles / composite layouts, never below decks. Fractions, y up. */
  bannerPlace(aspect: number): BannerSlot | null {
    const rt = this.rt;
    if (!rt) return null;
    const mode = rt.state.mode;
    if (rt.composite || mode === 'gaming' || mode === 'ttrpg') return null;
    const i = bannerSlot(this.keepRects, aspect, this.bannerIdx);
    if (i < 0) return null;
    this.bannerIdx = i;
    return BANNER_SLOTS[i];
  }
  private bannerIdx = 0;
  /** faces + the React screen / interview monitor this frame (fractions, y up) */
  private keepRects: BannerKeep[] = [];

  private drawBanner(list: Banner[], cam: THREE.PerspectiveCamera) {
    const l = list[0];
    if (!l || l.alpha <= 0.01) { if (this.banner) this.banner.mesh.visible = false; this.bannerK = 0; return; }
    if (!this.banner || this.banner.key !== l.key) {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgba(27,33,64,0.78)'; g.fillRect(0, 40, 1024, 176);
      g.fillStyle = '#c89b45'; g.fillRect(0, 40, 1024, 10); g.fillRect(0, 206, 1024, 10);
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#2747a8' : '#ede6d6'; g.fillRect(i * 64, 216, 64, 12); }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffd88a'; let fs = 64; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`;
      while (g.measureText(l.text).width > 960 && fs > 26) { fs -= 2; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`; }
      g.fillText(l.text, 512, 104);
      g.fillStyle = '#ede6d6'; g.font = "700 48px 'Arial Black', sans-serif"; g.fillText(l.sub.slice(0, 40), 512, 172);
      if (this.banner) { this.banner.tex.dispose(); this.banner.mesh.geometry.dispose(); (this.banner.mesh.material as THREE.Material).dispose(); this.banner.mesh.removeFromParent(); }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      // drawn over the room (an awning or a wheelhouse must not hide it) in the top band of the frame, faded where a
      // performer's face is (protectFaces' rects): never over a face
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25), bannerMaterial(tex));
      mesh.name = 'vtp:voyage:banner'; mesh.renderOrder = 8; mesh.frustumCulled = false;
      this.rt!.root.add(mesh);
      this.banner = { mesh, key: l.key, tex };
    }
    const m = this.banner.mesh;
    const place = this.bannerPlace(cam.aspect || 16 / 9);
    // its spot stopped being free (a cut, a face moved in): gone at once, then it fades in where it is free (never slides
    // across the frame, never sits over a face / the screen even for a frame)
    if (!place) this.bannerK = 0;
    else {
      if (this.bannerAt !== place) { this.bannerAt = place; this.bannerK = 0; }
      this.bannerK += (1 - this.bannerK) * 0.2;
    }
    const at = this.bannerAt ?? BANNER_SLOTS[0];
    const D = 140;
    const fwd = tv.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = tv2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const halfH = Math.tan((cam.fov * D2R) / 2) * D;
    m.position.copy(cam.position).addScaledVector(fwd, D).addScaledVector(up, halfH * (at.y - 0.5) * 2).addScaledVector(right, halfH * cam.aspect * (at.x - 0.5) * 2);
    m.quaternion.copy(cam.quaternion);
    m.scale.setScalar(2 * halfH * cam.aspect * at.w);
    (m.material as THREE.MeshBasicMaterial).opacity = l.alpha * this.bannerK;
    m.visible = this.bannerK > 0.01;
  }
  private bannerAt: BannerSlot | null = null;

  // ---------------------------------------------------------------------------------------------- faces
  private protectFaces(cam: THREE.PerspectiveCamera) {
    const rt = this.rt!, fx = this.fx!;
    const U = fx.uniforms as unknown as { uFaces: { value: THREE.Vector4[] }; uFaceN: { value: number }; uFaceDim: { value: number } };
    const W = rt.stage.renderer.domElement.width || 1920, H = rt.stage.renderer.domElement.height || 1080;
    const tanH = Math.tan((cam.fov * D2R) / 2);
    cam.updateMatrixWorld();
    this.faceRects.length = 0;
    this.keepRects.length = 0;
    let n = 0;
    // the React screen (or its passthrough hole) and the interview monitor / projector screens: effects dim to almost
    // nothing there and banners keep off them (SPEC 5.6). Rects in fractions, y down -> y up.
    const shows: { x: number; y: number; w: number; h: number }[] = [];
    try { const r3 = rt.state.mode === 'react' ? rt.reactRect() : null; if (r3) shows.push(r3.rect); } catch { /* no screen */ }
    try {
      const iv = (window as unknown as { vtpInterview?: { rt?: unknown; keepOut?(aspect: number): { x: number; y: number; w: number; h: number }[] } }).vtpInterview;
      if (rt.state.mode === 'interview' && iv && iv.rt === rt && iv.keepOut) shows.push(...iv.keepOut(cam.aspect || 16 / 9));
    } catch { /* no interview */ }
    for (const r of shows) {
      const k = { x0: r.x - 0.03, x1: r.x + r.w + 0.03, y0: 1 - (r.y + r.h) - 0.04, y1: 1 - r.y + 0.04 };
      this.keepRects.push(k);
      if (n < U.uFaces.value.length) U.uFaces.value[n++].set(k.x0 * W, k.y0 * H, k.x1 * W, k.y1 * H);
    }
    U.uFaceDim.value = shows.length ? 0.06 : 0.3;
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot || n >= U.uFaces.value.length) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const d = cam.position.distanceTo(f.center);
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const r = Math.max(0.022, (f.size * 1.8) / (d * tanH) / 2);
      const px = ((tv.x + 1) / 2) * W, py = ((tv.y + 1) / 2) * H, rp = r * H;
      U.uFaces.value[n++].set(px - rp * 1.5, py - rp * 1.7, px + rp * 1.5, py + rp * 1.9);
      this.faceRects.push({ x0: (px - rp * 1.6) / W, x1: (px + rp * 1.6) / W, y0: (py - rp * 1.8) / H, y1: (py + rp * 2.2) / H });
    }
    // faces beyond the effect slots still keep the banner off
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot || this.faceRects.length >= 12) continue;
      if (n < U.uFaces.value.length) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const r = Math.max(0.022, (f.size * 1.8) / (cam.position.distanceTo(f.center) * tanH) / 2);
      const px = (tv.x + 1) / 2, py = (tv.y + 1) / 2;
      this.faceRects.push({ x0: px - (r * 1.6 * H) / W, x1: px + (r * 1.6 * H) / W, y0: py - r * 1.8, y1: py + r * 2.2 });
    }
    this.keepRects.push(...this.faceRects);
    U.uFaceN.value = n;
  }

  // ---------------------------------------------------------------------------------------------- tests / status
  /** Test pages: jump the (manual) clock to the next moment of a kind (`frac` 0..1 = how far into the beat, when given;
   *  `after` = extra seconds). Returns the epoch ms, or null. */
  seek(what: 'battle' | 'approach' | 'salvo' | 'hit' | 'defeat' | 'boom' | 'storm' | 'treasure' | 'stop' | 'kneel' | 'city' | 'night' | 'day' | 'fork' | 'cruise' = 'battle', after = 0, frac = NaN): number | null {
    const rt = this.rt ?? this.lastRt;
    if (!rt) return null;
    const bag = this.readBag(rt), cfg = this.cfg;
    const now = this.now();
    const st = voyageNow(bag, cfg, now);
    const f = Number.isFinite(frac) ? Math.max(0, Math.min(0.999, frac)) : NaN;
    const jump = (w: number) => {
      this.manual = true; this.clock = w;
      if (this.env) { this.env.manual = true; this.env.clock = w; }
      this.lastCutAt = -1e15;
      return w;
    };
    if (what === 'night' || what === 'day') {
      // the journey hour (counted in chapters): scan ahead on the wall clock for the first moment near the hour
      const want = what === 'night' ? 23.0 : 11.0;
      for (let w = now + 5000; w < now + 4 * st.chap.C * 1000 * Math.max(1, bag.dayLen); w += 5000) {
        const h = voyageNow(bag, cfg, w).hour;
        if (Math.abs(((h - want + 36) % 24) - 12) < 0.15) return jump(w + Math.max(0, after) * 1000);
      }
      return null;
    }
    for (let leg = st.leg; leg < st.leg + 6; leg++) {
      const ref = chapterRef(bag, cfg, leg), LS = ref.C;
      const p = chapterPlanOf(bag, cfg, leg);
      const cands: number[] = [];
      for (const b of p.beats) {
        if (Number.isFinite(f) && ((what === 'battle' && b.kind === 'encounter') || (what === b.kind) || ((what === 'kneel' || what === 'stop') && b.kind === 'treasure'))) { cands.push(b.t0 + f * (b.t1 - b.t0)); continue; }
        if (b.kind === 'encounter' && ['battle', 'approach', 'salvo', 'hit', 'defeat', 'boom'].includes(what)) {
          const A = b.a ?? ENC.approach;
          const bp = battlePlan(b.seed, b.b ?? ENC.battle, Math.max(1, this.rig?.turrets.length ?? 2), Math.max(1, this.rig?.damage.length ?? 6), 3);
          const tD = A + bp.killTau + 0.35;
          if (what === 'approach') cands.push(b.t0 + 8);
          if (what === 'battle') cands.push(b.t0 + A + 14);
          if (what === 'salvo') for (const sv of bp.salvos) if (sv.tau > 8) { cands.push(b.t0 + A + sv.tau + 0.05); break; }
          if (what === 'hit') for (const x of bp.incoming) if (x.kind === 'hit') { cands.push(b.t0 + A + x.tau + 0.8); break; }
          if (what === 'defeat') cands.push(b.t0 + tD + 1.0);
          if (what === 'boom') cands.push(b.t0 + tD + 3.3);
        }
        if (what === 'storm' && b.kind === 'storm') cands.push(b.t0 + 45);
        if (what === 'treasure' && b.kind === 'treasure') cands.push(b.t0 + (b.a ?? 8) + (b.b ?? 70) * 0.55 - 1);
        if ((what === 'stop' || what === 'kneel') && b.kind === 'treasure') cands.push(b.t0 + (b.a ?? 8) + 12);
        if (what === 'city' && b.kind === 'city') cands.push(b.a ?? b.t0);
      }
      if (what === 'fork') cands.push(LS - 60);
      if (what === 'cruise') { let tt = 30; for (const b of p.beats) { if (tt < b.t0 - 40) break; tt = b.t1 + 25; } cands.push(Math.min(tt, LS - 200)); }
      for (const c of cands.sort((a, b) => a - b)) {
        const v = ref.v0 + c + after;
        if (v <= st.V + 0.5) continue;
        const w = voyageWallOf(bag, v, now);
        if (!Number.isFinite(w)) return null;
        return jump(w);
      }
    }
    return null;
  }

  /** Test pages: jump the (manual) clock to the next moment the ship walks through a world-rules biome (desert world:
   *  dunes, canyon, ruins, saltflat, seabed, industrial, oasis), `into` m past its start. Returns the epoch ms, or null. */
  seekBiome(biome: string, into = 250): number | null {
    const rt = this.rt ?? this.lastRt;
    const w = this.world as { biomeAtS?: (S: number) => string } | null;
    if (!rt || !w?.biomeAtS) return null;
    const bag = this.readBag(rt), cfg = this.cfg, now = this.now();
    let prev = w.biomeAtS(voyageDistance(bag, cfg, now));
    for (let t = now + 20000; t < now + 48 * 3600e3; t += 20000) {
      const S = voyageDistance(bag, cfg, t), b = w.biomeAtS(S);
      if (b === biome && prev !== biome) {
        // walk on `into` m (cruise pace) so the ship is inside the biome, not on its edge
        let t2 = t;
        while (voyageDistance(bag, cfg, t2) < S + into && t2 < t + 900e3) t2 += 2000;
        this.manual = true; this.clock = t2;
        if (this.env) { this.env.manual = true; this.env.clock = t2; }
        return t2;
      }
      prev = b;
    }
    return null;
  }

  /** The crew lane's input (SPEC 2.6: contacts, shots, hits, end, the stop; deck space, wall ms). */
  crewPlan(): CrewPlan | null { return this.out?.crew ?? null; }

  /** The world provider for a room: the procedural desert (src/scene/desert) unless the room (voyage.world.provider
   *  'placeholder') or a test page (VoyageScene.placeholderWorld) asks for the light placeholder; the placeholder also
   *  takes over if the desert cannot be built. The desert's seed: the room's (voyage.seed, else a hash of the room id). */
  static placeholderWorld = false;
  private makeWorld(rt: SceneRuntime, cfg: RoomVoyageConfig): VoyageWorldProvider {
    if (VoyageScene.placeholderWorld || cfg.world?.provider === 'placeholder') return new PlaceholderWorld(cfg.world ?? {});
    try {
      const seed = typeof cfg.seed === 'number' && Number.isFinite(cfg.seed) ? cfg.seed : voyageHash(rt.info.id.split('~')[0], 'desert');
      const w = new DesertProvider(cfg, seed);
      // one sun: the desert runs on the room environment's sun path (a room with a low noon sun - long golden shadows
      // all day - gets it on the sand too)
      const env = (rt.info as unknown as { environment?: { sunrise?: number; sunset?: number; noonElevation?: number } }).environment;
      if (env) w.desert.setSunPath(env);
      this.notes.push('world: procedural desert');
      return w;
    } catch (e) {
      console.warn('[voyage] desert world failed, using the placeholder', e);
      this.notes.push(`desert failed: ${e}`);
      return new PlaceholderWorld(cfg.world ?? {});
    }
  }

  /** The crew lane's feed (src/scene/crew/crewScene.ts CrewFeed), while this voyage runs: its battles + treasure stops
   *  (pure: every page feeds the same episodes), the deck acceleration and the sand under the halted ship. The crew
   *  keeps a stable object (setFeed resets its plan): output.ts hands it over when the voyage attaches / detaches. */
  private feedEps = new Map<string, CrewEpisodeIn>();
  readonly crewFeed: CrewFeed = {
    episodes: (from: number, to: number) => {
      for (const e of this.out?.crew.episodes ?? []) this.feedEps.set(e.id, e);
      const out: CrewEpisodeIn[] = [];
      for (const [id, e] of this.feedEps) {
        const a = e.k === 'battle' ? e.alert : e.at, b = e.k === 'battle' ? e.end + 60e3 : (e.until ?? e.at + 200e3) + 30e3;
        if (b < from - 60e3) { this.feedEps.delete(id); continue; }
        if (b >= from && a <= to) out.push(e);
      }
      return out;
    },
    accel: () => Math.abs(this.st?.a ?? 0),
    groundAt: (x: number, z: number) => {
      const w = this.world;
      if (!w || !this.st) return NaN;
      const r = this.toWorld(new THREE.Vector3(x, 0, z));
      return this.toShip(r.s, r.d, w.ground.heightAt(r.s, r.d), new THREE.Vector3()).y;
    },
  };
  /** The crew feed while a voyage is on in this room, else null. */
  crewFeedNow(): CrewFeed | null { return this.rt && this.world && this.rig ? this.crewFeed : null; }

  /** Two pages at the same clock must print the same hash: the timeline, the pure body pose (target deck motion of the
   *  page's mode, no page-local glide / kicks), every foot's world position, the enemies, hull health, stamps, banners. */
  hash(): string {
    const st = this.st, rig = this.rig, out = this.out, rt = this.rt;
    if (!st || !rig || !rt || !this.world) return 'off';
    const r = (x: number, k = 3) => (Number.isFinite(x) ? x.toFixed(k) : 'NaN');
    const want = modeGain(rt.state.mode, rt.state.lights?.state ?? 'show', this.cfg) * situationMult(st) * this.bag.sway;
    const b = this.bodyAt(st, Math.min(2, want), false);
    const g = this.world.ground, f = this.foot;
    const w = smooth01(st.v / 0.8);
    const feet = rig.legs.map((L) => { footAt(st.S, L.gait, this.gait, w, f); return `${L.id}:${r(f.s - st.S)},${r(f.d)},${r(g.heightAt(f.s, f.d) + f.lift)}`; }).join(';');
    const en = this.enemies?.drawn.map((e) => `${e.kind}@${r(e.body.x, 2)},${r(e.body.y, 2)},${r(e.body.z, 2)}`).join(';') ?? '';
    return [st.leg, r(st.tLeg), r(st.S), r(st.v), st.beat?.kind ?? '-', st.encounter?.sub ?? '-', st.stop?.phase ?? '-', r(st.storm), r(st.hour), r(b.Y), r(b.pitch, 5), r(b.roll, 5), feet, en,
      r(out?.health ?? 1), out?.banners.map((x) => x.key).join(',') ?? '', out?.crew.phase ?? '', [...this.bag.stamps, ...this.bag.fx].map((s) => s.id).join(',')].join('|');
  }
  digest() { return this.hash(); }

  info() {
    const st = this.st, out = this.out;
    const w = this.world?.counts() ?? null;
    return {
      on: !!this.rt, room: this.rt?.info.id ?? null, bag: this.rt ? this.bag : null, notes: this.notes,
      ship: this.rig ? { bow: { deg: +((this.rig.bowYaw * 180) / Math.PI).toFixed(1), source: this.rig.bowSource, hull: this.rig.bowGeom }, placeholder: !!this.placeholder, legs: this.rig.legs.map((l) => l.id), turrets: this.rig.turrets.length, damage: this.rig.damage.length, gangway: !!this.rig.gangway, rams: this.rig.legs.reduce((a, l) => a + l.pistons.length, 0), rigJson: !!this.rigJson, reachMax: +Math.max(0, ...this.rig.legs.map((l) => l.reach)).toFixed(3), clamps: this.rig.legs.reduce((a, l) => a + l.clamps, 0), gait: voyageGait().name === builtinGait.name ? 'builtin' : voyageGait().name } : null,
      state: st ? { leg: st.leg, tLeg: +st.tLeg.toFixed(1), u: +st.u.toFixed(3), S: +st.S.toFixed(2), v: +st.v.toFixed(2), beat: st.beat?.kind ?? 'cruise', tb: +st.tb.toFixed(1), encounter: st.encounter, stop: st.stop, storm: +st.storm.toFixed(2), stormFront: st.stormFront, hour: +st.hour.toFixed(2), night: +st.night.toFixed(2), flavour: st.plan.flavour, fork: st.fork, k: +st.plan.k.toFixed(3), beats: st.plan.beats.map((b) => `${b.kind}@${b.t0}-${b.t1}${b.enemy ? `:${b.enemy}` : ''}${b.city ? `:${b.city}` : ''}`) } : null,
      body: { Y: +this.body.Y.toFixed(3), pitchDeg: +(this.body.pitch / D2R).toFixed(3), rollDeg: +(this.body.roll / D2R).toFixed(3), heave: +this.body.heave.toFixed(3), mult: +this.mult.toFixed(2), modeK: +this.multK.toFixed(2), exterior: this.extActive },
      action: out ? { alarm: +out.alarm.toFixed(2), health: +out.health.toFixed(2), crew: out.crew.phase, banners: out.banners.map((b) => b.text), cuts: out.cuts.length, special: +out.special.toFixed(2), ...out.counts } : null,
      shot: this.lastShot && (this.extActive || this.lastShot.subjects) ? { key: this.lastShot.key, move: this.lastShot.move, fixed: this.extActive ? this.cams.last?.fixed ?? [] : [], ...(this.extActive && this.cams.last?.plan ? { plan: this.cams.last.plan } : {}), ...(this.lastShot.subjects ? { subjects: this.lastShot.subjects } : {}) } : null,
      director: this.lastPick ? { move: this.lastPick.move, bar: this.lastPick.cutBar, bars: this.lastPick.bars, u: +this.lastPick.u.toFixed(3), secs: +this.lastPick.secs.toFixed(2) } : null,
      broll: this.broll ? { move: this.broll.pick.move, in: +((this.broll.until - this.now()) / 1000).toFixed(1) } : null,
      plans: { ...this.cams.planStats },
      deckCams: this.deckCams.stats,
      cut: this.cut ? { kind: this.cut.req.kind, in: +((this.cut.to - this.now()) / 1000).toFixed(1) } : null, quiet: +this.quiet.toFixed(1),
      stamps: [...this.bag.stamps, ...this.bag.fx].map((s) => ({ k: s.k, in: +((s.at - this.now()) / 1000).toFixed(1), who: s.who, ...(s.arg !== undefined ? { arg: s.arg } : {}) })), heldMs: this.bag.heldMs, holds: this.bag.holds.length, pace: this.bag.pace,
      fx: this.fx?.counts() ?? null, world: w, enemies: this.enemies?.counts() ?? null,
      ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
  debug() { return this.info(); }
  static kinds() { return [...STAMP_KINDS]; }
}

// ------------------------------------------------------------------------------------------------ helpers
/** situation part of the deck motion (pure in time): battle x2 ramped in / out over 2 s, still while kneeling */
function situationMult(st: VoyageNow): number {
  let k = 1;
  const e = st.encounter;
  if (e && st.beat) {
    const A = st.beat.a ?? ENC.approach, B = st.beat.b ?? ENC.battle;
    k = 1 + smooth01((st.tb - A) / 2) * (1 - smooth01((st.tb - A - B) / 2));
  }
  return k * (1 - (st.stop?.kneel ?? 0));
}
function clampN(v: unknown, lo: number, hi: number, d: number) { return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
/** the placeholder route bends gently: heading (rad) as a closed-form sum of sines of S (turns the backdrop + north) */
function heading(S: number) { return 0.35 * Math.sin((2 * Math.PI * S) / 9100 + 0.7) + 0.18 * Math.sin((2 * Math.PI * S) / 3700 + 2.1); }
const FOG_DAY = new THREE.Color('#d8c3a0');
function defaultSun(hour: number) {
  const el = Math.sin(((hour - 6) / 12) * Math.PI) * 62 * D2R, az = ((hour - 12) / 12) * Math.PI;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.max(0.05, Math.sin(el)), -Math.cos(az) * Math.cos(el) * 0.6).normalize();
}
function defaultSunCol(hour: number) {
  const day = smooth01((Math.sin(((hour - 6) / 12) * Math.PI) + 0.1) / 0.5);
  return new THREE.Color(1.05, 0.88, 0.7).multiplyScalar(0.15 + 0.95 * day);
}
function defaultAmb(hour: number) {
  const day = smooth01((Math.sin(((hour - 6) / 12) * Math.PI) + 0.2) / 0.6);
  return new THREE.Color(0.18, 0.2, 0.32).lerp(new THREE.Color(0.48, 0.44, 0.42), day);
}
function worldLevel() { const l = gfxBudget().level; return l === 'performance' ? 0 : l === 'balanced' ? 1 : l === 'high' ? 2 : 3; }
/** effects detail: the graphics level, lowered further when the voyage itself gets expensive (auto-lower path) */
function fxLevel(ms: number) { const l = gfxBudget().level; const base = l === 'performance' ? 2 : l === 'balanced' ? 1 : 0; return Math.min(2, base + (ms > 3.5 ? 2 : ms > 2.5 ? 1 : 0)); }
void raidDonationValue;

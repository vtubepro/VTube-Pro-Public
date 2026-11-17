// Procedural desert for moving rooms (the walking-ship voyage): terrain, sky, distant layers, features, storms,
// footprints + dust. The SHIP NEVER MOVES in room space: the desert world is placed under the room each frame from
// the journey distance (the voyage lane owns time -> distance; this module owns distance -> world).
//
//   const desert = new DesertWorld({ seed, quality: desertQualityFor(gfxBudget().level) });   // groundY -12.844 (rig.json)
//   rt.root.add(desert.root);                 // or under the voyage's swayed world group (body bob / roll / kicks)
//   desert.compile(renderer, camera);         // once: warms the canvas AND render-target variants (Stage/Pipeline draws
//                                             // into an HDR target: pass [pipelineTarget] if you have it)
//   each frame AFTER the camera is final:     desert.update({ d, speed, hour, storm, stormFront, now, camera, renderer, faces })
//   every other camera that draws the room (compositor tiles, remote passes): nothing to do - each desert mesh's
//     onBeforeRender calls desert.prepareView(camera) (camera-local uniforms + its own terrain patch selection)
//   feet / crew / props on the sand:          desert.groundAtRoom(x, z); footTarget(desert.route, gait, leg, d)
//   the voyage's (s, lateral) ground frame:   desert.heightAtRoute(s, lateral)
//   another walker's footstep (mech guest):   desert.plantRoom(x, z, yaw, r)
//   ship shadow on the sand:                  desert.setCasters([{ a, b, r }])   (room-frame capsules: legs, hull chain)
//   no sand streaks under the canopy:         desert.setDryBoxes([box3, ...])    (room frame)
//   the deck's sun = the desert's sun:        new DesertWorld({ ..., sunrise, sunset, noonElevation }) with the ROOM
//                                             environment's values (or desert.setSunPath(roomEnvConfig)), and each frame
//                                             roomEnvConfig.north = desert.envNorthDeg() (heading turns); envConfig() has all four
//   settlements / the dig site / cities:      desert.setFlats([desert.routeFlat(s, lateral, r), ...]) and
//                                             desert.setCities([{ d: s, lateral, radius, archetype, seed }]) BEFORE update()
//                                             (cheap when unchanged: fine every frame); keep-outs: desert.setKeepOut(discs)
//   camera range while the desert is shown:   desert.cameraRange('deck' | 'exterior') -> { near: .1 | .75, far: >= 2700 }
//   the voyage owns W(t) (SPEC D7):           desert.update({ ..., world: W })  with W built on O = desert.originAt(d)
//
// Determinism: everything visible is a pure function of (seed, d, hour, storm, stormFront, cloud, wall clock) plus
// quality (detail only, never positions). The floating origin O(d) is itself pure (snap1024 of the route segment's
// start, SPEC 2.4), and every shading pattern is WORLD-anchored (lattices wrap every 4096 m, the origin's offset mod
// 4096 m comes in as uAnc), so a rebase never moves a ripple, crack, stratum or lit window, and two pages agree no matter
// how they reached d (tools/desert_e2e.mjs det / rebase / desync).
// Frames: "terrain-local" (T) = world - origin O; the world group's matrix maps T -> room:
// T(0, groundY) * tilt * rotY(heading) * T(-(P - O)) * T(0, -h0). heading: forward = (sin h, -cos h) in world (x, z);
// room bow = -Z, starboard = +X.
//
// Integration notes (voyage lane / integrator):
//   - Do NOT add desert meshes to room.occluders / RoomRays (passing dunes would make the shot solver jitter).
//   - The env engine: keep `environment` on for the deck (performer light, night lights), with `sky: 'none'` or leave its
//     dome (the desert sky draws over it, renderOrder -999); add 'sandstorm' to ENV_WEATHERS with SANDSTORM_WEATHER
//     (shared/desert/sky.ts) and drive env hour / weather from the same voyage timeline; set env north each frame.
//   - Post: the desert does its own aerial perspective; keep the room's gfx.haze low.
//   - Ship pitch / roll from the ground: applied here (tilt, capped 4 deg, gain 1 in every mode per SPEC 2.5), or read
//     desert.pose and apply it yourself. Gait bob / sway / hit kicks belong on a PARENT group (voyage lane).
//   - Route / origin: shared/desert/route.ts is the SPEC D9 route (psi(S), P(S)) and O(S) (originAt); shared/voyage.ts
//     should re-export it rather than keep a second route (SPEC 2.2 / D7).
//   - Gait: SHIP_GAIT = SPEC D3 / D4 (L1 L2 L3 R1 R2 R3, tripod, stride 6.0, duty .55, lift 1.4, rig.json soles);
//     shared/gait.ts specs plug in through gaitLikeFrom(spec, cycleDist(spec), footRest).
//   - Treasure stops / settlements: setFlats() at runtime (or `flats` at construction); every page must pass the same
//     discs at the same d (they come from the voyage plan / host stamps). routeFlat(s, lateral, r) levels a disc to the
//     raw dune height at its centre: use it rather than another ground model's height. Cities: setCities() replaces the
//     seeded skyline cities with the voyage's (keepSeeded keeps both). Alongside walkers / crew ashore: setKeepOut().
//   - Sand wake: from speed (battle pace, wakeK) or the voyage's own level (DesertFrame.wake 0..1, e.g. the encounter beat).
//   - Quality: desertQualityFor(gfxBudget().level); call setQuality() on tier changes (uniform-only, no recompile).
//   - No EXT_color_buffer_float: the clipmap packs height into RGBA8 (1/256 m over +-128 m, SPEC 3.2 fallback); decided
//     in compile() / the first update (uniform-only: the same programs serve both).
import * as THREE from 'three';
import { CORRIDOR_N, CORRIDOR_STEP, DesertWorldSpec, cleanFlats, heightAt, localCtx, reliefMax, reliefMin, type Flat, type LocalCtx } from '../../../shared/desert/height.ts';
import { CITY_ARCHETYPES, CITY_NAMES, type City, type CityArchetype } from '../../../shared/desert/features.ts';
import { hash32 } from '../../../shared/desert/noise.ts';
import { DesertRoute, safeD, type RoutePoint } from '../../../shared/desert/route.ts';
import { SHIP_GAIT, SHIP_GROUND_Y, footfalls, shipPrints, type GaitLike, type Plant } from '../../../shared/desert/footfalls.ts';
import { haboobDistance } from '../../../shared/desert/sky.ts';
import { HeightClipmap } from './clipmap.ts';
import { shaftSources, type ShaftSource } from '../../stage/gfx/shaftSources.ts';
import { DesertTerrain, MAX_CASTERS, MAX_PRINTS } from './terrain.ts';
import { ANCHOR_P } from './glsl.ts';
import { DesertSky } from './sky.ts';
import { DESERT_SUN, desertLight, envNorthDeg, newDesertLight } from './light.ts';
import { makeDesertUniforms, makeHeightUniforms, writeFlatUniforms, writeHeightUniforms } from './uniforms.ts';
import { DesertFar } from './far.ts';
import { DesertProps, type Part } from './props.ts';
import { DesertDust, WAKE_FULL, WAKE_SPEED, wakeK } from './dust.ts';
import { DesertMarks } from './marks.ts';
import { DesertLife } from './life.ts';
import { DesertRuins } from './ruins.ts';
import { partsSolids, solidHit, type KitLayer, type KitSolids } from './kit.ts';

/** A camera plan's solid things (DesertWorld.solidSet): the pure set (world coordinates) + the placed kit layers
 *  (terrain-local: ox / oz = the floating origin they were placed on). */
export interface DesertSolidSet {
  parts: Part[];
  pure: KitSolids; kits: KitSolids[]; ox: number; oz: number;
  hit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad?: number): boolean;
}
export function newSolidSet(): DesertSolidSet {
  const S: DesertSolidSet = {
    parts: [], pure: { n: 0, inv: new Float32Array(0), box: new Float32Array(0), sphere: new Float32Array(0) }, kits: [], ox: 0, oz: 0,
    hit(ax, ay, az, bx, by, bz, pad = 0) {
      if (S.pure.n && solidHit(S.pure, ax, ay, az, bx, by, bz, pad)) return true;
      for (const k of S.kits) if (solidHit(k, ax - S.ox, ay, az - S.oz, bx - S.ox, by, bz - S.oz, pad)) return true;
      return false;
    },
  };
  return S;
}
import { cleanDensity } from '../../../shared/desert/ruins.ts';
import { defaultBiomeAt, type Biome, type BiomeAt } from '../../../shared/desert/regions.ts';

export type DesertQuality = 'low' | 'medium' | 'high' | 'ultra';
const QN: Record<DesertQuality, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
/** The studio's graphics level (stage/gfx/lod.ts gfxBudget().level) -> desert quality. */
export function desertQualityFor(level: string): DesertQuality {
  return level === 'performance' ? 'low' : level === 'balanced' ? 'medium' : level === 'ultra' ? 'ultra' : 'high';
}

export interface DesertOptions {
  seed: number;
  quality?: DesertQuality;
  /** Room y of the sand under the ship (default -12.844: SPEC D2 / rig.json groundY, show floor 12.84 m above the soles). */
  groundY?: number;
  /** Desert compass (deg, the environment's `north` convention). */
  north?: number;
  /** The ROOM environment's sun path (RoomEnvConfig sunrise / sunset / noonElevation): pass the room's own values so
   *  the deck and the sand share one sun. Default DESERT_SUN (the walking-ship SPEC 3.5: 6.2 / 19.0 / 68). */
  sunrise?: number;
  sunset?: number;
  noonElevation?: number;
  /** The ship's legs (footprints + the terrain tilt fit). null = no ship prints. */
  gait?: GaitLike | null;
  /** Flatten discs (stop sites), world coordinates. */
  flats?: Flat[];
  /** Layers on / off (all on by default). */
  layers?: { sky?: boolean; far?: boolean; props?: boolean; dust?: boolean; marks?: boolean; life?: boolean; ruins?: boolean };
  /** The biome at a journey distance (world rules, shared/desert/regions.ts); default: the desert's own regions. */
  biomeAt?: BiomeAt | null;
  /** The side enemies come from (+1 starboard, -1 port): tall roadside things keep out of their band. */
  dangerSide?: 1 | -1;
  /** Register the desert sun as an Ultra light-shaft source (god rays through the haze / dust). Leave off when the
   *  room environment's own sun shaft is active with a matching sun (it would double). */
  shafts?: boolean;
  /** Force the RGBA8 clipmap fallback (tests); default: only when the renderer lacks EXT_color_buffer_float. */
  packed?: boolean;
  /** Relief under the sand (shared/desert/height.ts RELIEF): mesas, cliffs and ridged ranges away from the route, taller
   *  towards the horizon. 0 = the classic dune sea, default 1, max 1.5. Part of the world's shape (every page must agree). */
  relief?: number;
  /** Aerial perspective (haze) multiplier, 0.4..2.5 (default 1); above 1 the air also turns dusty ochre. */
  haze?: number;
  /** Burning wrecks near the route (fire + smoke columns), density 0..2 (default 1; 0 = none). */
  wrecks?: number;
  /** Ruined towns / industrial skylines on the horizon band (lit at night), density 0..2 (default 1; 0 = none). */
  skyline?: number;
  /** Drifting sand over the dunes (the blowing sheets), 0..2 (default 1; 0 = none; above 1 also at night). */
  drift?: number;
  /** Moonlight floor, 0..2 (default 1): the night always has a cool key (the moon, or a skylight when it is down) so the
   *  relief reads; 0 = the plain sky model. */
  moonlight?: number;
}

export interface DesertFrame {
  /** Journey distance (m). */
  d: number;
  /** Ship speed (m/s, for dust timing; 0 = stopped). */
  speed?: number;
  /** Sand wake + heavy footfall dust 0..1 (omit = from speed: wakeK, battle pace). */
  wake?: number;
  hour: number;
  /** Sandstorm level 0..1 (visibility, sky, streaks). */
  storm?: number;
  /** Haboob wall approach 0 (far) .. 1 (arrived); omit = no wall. */
  stormFront?: number;
  cloud?: number;
  /** Wall-clock ms (animation only: ripples, dust, stars). */
  now?: number;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  /** Terrain tilt applied to the world (0 = level horizon, 1 = full fit, capped at maxTilt). Default 1. */
  tilt?: number;
  /** Screen-space face boxes (px, x0 y0 x1 y1): dust thins over performers' faces. */
  faces?: THREE.Vector4[];
  /** Lightning flash 0..1 (optional dry lightning). */
  flash?: number;
  /** The voyage's own world transform W (terrain-local -> desert.root space), built on O = desert.originAt(d). When
   *  given it replaces the desert's pose transform (heading, O - P, ground tilt, ride height); see SPEC D7. */
  world?: THREE.Matrix4;
}

export interface DesertPose { d: number; x: number; z: number; heading: number; h0: number; pitch: number; roll: number }

const MAX_TILT = (4 * Math.PI) / 180;
/** Footprint uniforms used per quality (SPEC 6.3: 16 / 32 / 48 / 48); a few always stay free for other walkers. */
export const PRINTS_Q: Record<DesertQuality, number> = { low: 16, medium: 32, high: 48, ultra: 48 };
const EVENT_PRINTS_MIN = 4;
export { WAKE_SPEED, WAKE_FULL, wakeK };

/** A voyage-placed city (SPEC 2.7 cityPlan): closest approach at journey distance d, `lateral` m to starboard
 *  (negative = port), radius (m, default 300); archetype / name / seed default from a hash of the placement. */
export interface CityPlacement { d: number; lateral: number; radius?: number; archetype?: CityArchetype; name?: string; seed?: number }
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const eq16 = (a: ArrayLike<number>, b: ArrayLike<number>) => { for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; };
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tm = new THREE.Matrix4(), tm2 = new THREE.Matrix4(), tm3 = new THREE.Matrix4(), tm4 = new THREE.Matrix4(), tq = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const wmQ = new THREE.Quaternion(), wmV = new THREE.Vector3(), wmM = new THREE.Matrix4();
/** The terrain-local -> desert root matrix for a pose: T(0, groundY) * tilt * rotY(heading) * T(-(P - O)) * T(0, -h0)
 *  (O = the floating origin; 0, 0 = world coordinates). One function for the drawn world and the cameras' plans. */
function worldMatrix(P: DesertPose, tilt: number, groundY: number, ox: number, oz: number, M: THREE.Matrix4): THREE.Matrix4 {
  const nx = -Math.tan(P.roll) * tilt, nz = -Math.tan(P.pitch) * tilt;
  wmQ.setFromUnitVectors(wmV.set(nx, 1, nz).normalize(), UP);
  M.makeTranslation(0, groundY, 0);
  M.multiply(wmM.makeRotationFromQuaternion(wmQ));
  M.multiply(wmM.makeRotationY(P.heading));
  return M.multiply(wmM.makeTranslation(-(P.x - ox), -P.h0, -(P.z - oz)));
}

export class DesertWorld {
  readonly root = new THREE.Group();
  /** Terrain-local content (terrain, features, far layers, dust). */
  readonly world = new THREE.Group();
  readonly spec: DesertWorldSpec;
  readonly route: DesertRoute;
  readonly du = makeDesertUniforms();
  readonly hu: ReturnType<typeof makeHeightUniforms>;
  readonly clip: HeightClipmap;
  readonly terrain: DesertTerrain;
  readonly sky: DesertSky | null;
  readonly far: DesertFar | null;
  readonly props: DesertProps | null;
  readonly dust: DesertDust | null;
  /** world rules: roadside things, lines, canyon walls, landmarks, gates, horizon megastructures */
  readonly marks: DesertMarks | null;
  /** birds, dust devils, blowing sand, smoke plumes, distant walkers */
  readonly life: DesertLife | null;
  /** burning wrecks near the route + ruined towns on the horizon band (fire, smoke columns, beacons) */
  readonly ruins: DesertRuins | null;
  readonly light = newDesertLight();
  quality: DesertQuality;
  /** aerial perspective multiplier (DesertOptions.haze) */
  haze = 1;
  /** the night key's floor (DesertOptions.moonlight) */
  moonlight = 1;
  /** the night haze picks this colour up a little (a show sky's aurora / nebula palette); null = none */
  private nightTint: THREE.Color | null = null;
  /** A colour the night haze and horizon lean towards (the light show's sky), or null. Cheap, every frame. */
  setNightTint(c: THREE.Color | null) { if (!c) this.nightTint = null; else (this.nightTint ??= new THREE.Color()).copy(c); }
  groundY: number;
  north: number;
  gait: GaitLike | null;
  private ctx: LocalCtx | null = null;
  private O = { x: 0, z: 0, set: false };
  private Onext = { x: 0, z: 0 };
  private lastD = 0;
  private lastHour = 12;
  /** The camera the current terrain selection / camera uniforms belong to (prepareView cache). */
  private vCam: THREE.Camera | null = null;
  private vCW = new Float64Array(16);
  private vPM = new Float64Array(16);
  private vWW = new Float64Array(16);
  private vDirty = true;
  /** Terrain-local position of the camera last prepared (any view). camT stays the PRIMARY camera's. */
  readonly viewCamT = new THREE.Vector3();
  private polyK0 = NaN;
  readonly pose: DesertPose = { d: 0, x: 0, z: 0, heading: 0, h0: 0, pitch: 0, roll: 0 };
  private poseCache = new Map<number, { h0: number; a: number; b: number }>();
  /** Event footprints from other walkers (room frame -> world at the moment they land). */
  private events: { x: number; z: number; yaw: number; r: number; at: number }[] = [];
  private casters: { a: [number, number, number]; b: [number, number, number]; r: number }[] = [];
  private plants: Plant[] = [];
  private prints: { plant: Plant; strength: number }[] = [];
  private hAt = (x: number, z: number) => heightAt(this.spec, x, z);
  private lightIn = { hour: 12, storm: 0, cloud: 0, north: 0, sunrise: DESERT_SUN.sunrise as number, sunset: DESERT_SUN.sunset as number, noonElevation: DESERT_SUN.noonElevation as number };
  private cityIn: CityPlacement[] | null = null;
  private cityKeep = false;
  private keepOutIn: { x: number; z: number; r: number }[] = [];
  readonly camT = new THREE.Vector3();
  private rp: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };
  private lastNow = 0;
  perf = { ms: 0, peak: 0, clipLevels: 0, views: 0, badInput: 0, rebases: 0, flatChanges: 0 };
  private packDecided = false;

  constructor(opts: DesertOptions) {
    this.spec = new DesertWorldSpec(opts.seed, { flats: opts.flats, relief: opts.relief ?? 1 });
    this.haze = fin(opts.haze) ? Math.max(0.4, Math.min(2.5, opts.haze)) : 1;
    this.moonlight = fin(opts.moonlight) ? Math.max(0, Math.min(2, opts.moonlight)) : 1;
    this.route = this.spec.route;
    this.quality = opts.quality ?? 'high';
    this.groundY = opts.groundY ?? SHIP_GROUND_Y;
    this.north = opts.north ?? 0;
    this.setSunPath(opts);
    this.gait = opts.gait === undefined ? SHIP_GAIT : opts.gait;
    this.hu = makeHeightUniforms(this.spec);
    this.clip = new HeightClipmap(this.hu, !!opts.packed);
    if (opts.packed !== undefined) this.packDecided = true;
    this.terrain = new DesertTerrain(this.clip, this.du, this.hu.uWindCS);
    this.terrain.setRelief(this.spec.relief, reliefMax(this.spec.relief), reliefMin(this.spec.relief));
    const L = opts.layers ?? {};
    this.sky = L.sky === false ? null : new DesertSky(this.du, this.spec.seed);
    this.far = L.far === false ? null : new DesertFar(this.spec, this.du, this.clip);
    this.props = L.props === false ? null : new DesertProps(this.spec, this.du, this.clip);
    this.dust = L.dust === false ? null : new DesertDust(this.du);
    this.marks = L.marks === false ? null : new DesertMarks(this.spec, this.du, this.clip);
    this.life = L.life === false ? null : new DesertLife(this.spec, this.du, this.clip);
    this.ruins = L.ruins === false ? null : new DesertRuins(this.spec, this.du, this.clip);
    this.ruins?.setDensity(opts.wrecks, opts.skyline);
    if (this.life) this.life.drift = cleanDensity(opts.drift);
    if (opts.biomeAt) this.setBiomeAt(opts.biomeAt);
    else if (this.life) this.life.biomeAt = defaultBiomeAt(this.spec.seed);
    if (opts.dangerSide && this.marks) this.marks.dangerSide = opts.dangerSide;
    this.root.name = 'vtp:desert';
    this.world.name = 'vtp:desert:world';
    this.world.matrixAutoUpdate = false;
    this.root.add(this.world);
    this.world.add(this.terrain.mesh);
    if (this.sky) this.root.add(this.sky.mesh);
    if (this.far) this.world.add(this.far.group);
    if (this.props) this.world.add(this.props.group);
    if (this.dust) this.world.add(this.dust.group);
    if (this.marks) this.world.add(this.marks.group);
    if (this.life) this.world.add(this.life.group);
    if (this.ruins) this.world.add(this.ruins.group);
    this.setQuality(this.quality);
    if (opts.shafts) { this.shaft = (cam) => this.sunShaft(cam); shaftSources.add(this.shaft); }
    // every desert mesh prepares its camera's view (uCamT, terrain patches) right before it draws: compositor tiles,
    // remote passes and probes get a correct desert without any extra call
    const hook = (_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => this.prepareView(cam);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.onBeforeRender = hook; });
  }

  private shaft: ShaftSource | null = null;
  /** The sun on screen (uv) with a weight: stronger low and through light dust, gone in a thick storm or at night. */
  private sunShaft(cam: THREE.PerspectiveCamera) {
    const L = this.light;
    const vis = L.sunVis * (1 - Math.min(1, this.du.uStorm.value * 1.2)) + 0.6 * L.sunVis * Math.sin(Math.PI * Math.min(1, this.du.uStorm.value * 2));
    if (vis < 0.06 || L.sunEl < -1) return [];
    const p = tv.copy(L.sunW).transformDirection(this.world.matrixWorld).multiplyScalar(500).add(cam.position).project(cam);
    if (p.z > 1 || Math.abs(p.x) > 1.25 || Math.abs(p.y) > 1.25) return [];
    return [{ x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, w: Math.min(1, vis) * (0.7 + 0.5 * (1 - smoothstep(8, 35, L.sunEl))) }];
  }

  setQuality(q: DesertQuality) {
    this.quality = q;
    this.vDirty = true;
    this.terrain.setQuality(q);
    this.du.uQ.value = QN[q];
    this.far?.setQuality(q);
    this.props?.setQuality(q);
    this.dust?.setQuality(q);
    this.marks?.setQuality(q);
    this.life?.setQuality(q);
    this.ruins?.setQuality(q);
  }

  /** The world rules' biome provider (null = the desert's own regions). The voyage maps its chapters onto biomes. */
  setBiomeAt(f: BiomeAt | null) {
    const b = f ?? defaultBiomeAt(this.spec.seed);
    this.marks?.setBiomeAt(b);
    if (this.life) this.life.biomeAt = b;
  }
  /** The biome at journey distance d (world rules). */
  biomeAt(d: number): Biome { return this.marks ? this.marks.biomeAt(d) : defaultBiomeAt(this.spec.seed)(d); }

  /** The keep-out discs (world) nothing may stand in. */
  keepOuts(): readonly { x: number; z: number; r: number }[] { return this.keepOutIn; }

  /** Camera near / far the desert needs (set them while the desert is shown; restore afterwards). SPEC P9: 0.10 for deck
   *  and tile cameras, 0.75 for exterior cameras (depth precision for kit half-buried in sand 2 km out). */
  cameraRange(view: 'deck' | 'exterior' = 'deck') { return { near: view === 'exterior' ? 0.75 : 0.1, far: Math.max(2700, this.terrain.end + 120) }; }

  /** The room environment's `north` for the current heading (deck sun = desert sun). */
  envNorthDeg() { return envNorthDeg(this.north, this.pose.heading); }

  /** Use the room environment's sun path (sunrise / sunset / noonElevation; missing or bad values keep DESERT_SUN). */
  setSunPath(cfg: { sunrise?: number; sunset?: number; noonElevation?: number }) {
    const li = this.lightIn;
    li.sunrise = fin(cfg.sunrise) ? cfg.sunrise : DESERT_SUN.sunrise;
    li.sunset = fin(cfg.sunset) ? cfg.sunset : DESERT_SUN.sunset;
    li.noonElevation = fin(cfg.noonElevation) ? cfg.noonElevation : DESERT_SUN.noonElevation;
  }

  /** The room environment config that puts the deck's sun exactly on the desert's (north follows the heading). */
  envConfig() { const li = this.lightIn; return { north: this.envNorthDeg(), sunrise: li.sunrise, sunset: li.sunset, noonElevation: li.noonElevation }; }

  // ------------------------------------------------------------------ runtime ground edits (voyage plan / host stamps)
  /** Flatten discs (settlements, the dig site; world coordinates, up to MAX_FLATS) - replaces the set. Call it BEFORE
   *  update() in the frame: the clipmap levels the changed discs touch re-render in that update, and the CPU ground
   *  (heightAt / groundAtRoom / poseAt / heightAtRoute) changes at once, so feet and the drawn sand never disagree.
   *  The same list again does nothing (fine every frame). Returns true when the ground changed. */
  setFlats(list: readonly Flat[] | null): boolean {
    const next = cleanFlats(list), prev = this.spec.flats;
    const same = (a: Flat, b: Flat) => a.x === b.x && a.z === b.z && a.r === b.r && a.h === b.h;
    if (next.length === prev.length && next.every((f, i) => same(f, prev[i]))) return false;
    // the ground differs only inside discs that left, moved or arrived (a pure re-order changes overlaps: all of them)
    let changed = [...prev.filter((f) => !next.some((g) => same(f, g))), ...next.filter((f) => !prev.some((g) => same(f, g)))];
    if (!changed.length) changed = [...prev, ...next];
    this.spec.flats = next;
    this.poseCache.clear();
    const O = this.O;
    if (this.ctx) { this.ctx.flats = next.map((f) => ({ x: f.x - O.x, z: f.z - O.z, r: f.r, h: f.h })); writeFlatUniforms(this.hu, this.ctx); }
    if (O.set) this.clip.invalidateDiscs(changed.map((f) => ({ x: f.x - O.x, z: f.z - O.z, r: f.r })));
    this.props?.invalidate(changed);
    this.marks?.invalidate();
    this.far?.invalidate(changed);
    this.perf.flatChanges++;
    return true;
  }

  /** A disc in the voyage's route frame: centred `lateral` m to starboard of journey distance s (negative = port),
   *  radius r, levelled to h (default: the raw dune height at its centre, other discs ignored). */
  routeFlat(s: number, lateral: number, r: number, h?: number): Flat {
    const p = this.route.at(fin(s) ? safeD(s) : 0, this.rpR);
    const [wx, wz] = DesertRoute.toWorld(p.heading, fin(lateral) ? lateral : 0, 0);
    const x = p.x + wx, z = p.z + wz;
    return { x, z, r, h: fin(h) ? h : heightAt(this.spec, x, z, undefined, []) };
  }

  /** Voyage-placed cities (SPEC 2.7 city pass, 250-600 m off the route) replace the seeded skyline cities (2.5-6 km
   *  out, one per ~11 km); keepSeeded shows both; null = seeded only. The same list again does nothing. Flatten the
   *  ground under them with setFlats(routeFlat(c.d, c.lateral, radius * 1.35)). */
  setCities(list: readonly CityPlacement[] | null, opts: { keepSeeded?: boolean } = {}): boolean {
    const keep = !!opts.keepSeeded;
    const prev = this.cityIn;
    const eq = (a: CityPlacement, b: CityPlacement) => a.d === b.d && a.lateral === b.lateral && a.radius === b.radius && a.archetype === b.archetype && a.name === b.name && a.seed === b.seed;
    if (keep === this.cityKeep && (list === null ? prev === null : prev !== null && prev.length === list.length && list.every((c, i) => eq(c, prev[i])))) return false;
    this.cityIn = list === null ? null : list.map((c) => ({ ...c }));
    this.cityKeep = keep;
    this.far?.setPlaced(this.cityIn === null ? null : this.cityIn.filter((c) => fin(c.d) && fin(c.lateral)).map((c) => this.placedCity(c)), keep);
    this.marks?.invalidate();
    return true;
  }

  /** The far layer's City for a placement (exported for tests through placedCities()). */
  private placedCity(c: CityPlacement): City {
    const d = safeD(c.d), lat = c.lateral;
    const p = this.route.at(d, { x: 0, z: 0, heading: 0, curv: 0 });
    const [wx, wz] = DesertRoute.toWorld(p.heading, lat, 0);
    const seed = fin(c.seed) ? c.seed >>> 0 : hash32(this.spec.seed, Math.round(d), Math.round(lat * 16), 311);
    const archetype = c.archetype && CITY_ARCHETYPES.includes(c.archetype) ? c.archetype : CITY_ARCHETYPES[hash32(seed, 304) % CITY_ARCHETYPES.length];
    return {
      id: hash32(seed, Math.round(d), 305), index: -1, placed: true, d, x: p.x + wx, z: p.z + wz, side: lat < 0 ? -1 : 1, lateral: Math.abs(lat),
      radius: fin(c.radius) ? Math.min(1200, Math.max(60, c.radius)) : 300, archetype, name: c.name ?? CITY_NAMES[hash32(seed, 307) % CITY_NAMES.length], seed,
    };
  }

  /** The cities the far layer shows now (seeded and / or placed). */
  cities(): readonly City[] { return this.far?.cities ?? []; }

  /** World discs no rock, wreck or scrub may stand in (alongside walkers, crew ashore, the dig site). Same list -> no work. */
  setKeepOut(list: readonly { x: number; z: number; r: number }[]) {
    const next = list.filter((c) => fin(c.x) && fin(c.z) && fin(c.r) && c.r > 0).map((c) => ({ x: c.x, z: c.z, r: c.r }));
    const prev = this.keepOutIn;
    if (next.length === prev.length && next.every((c, i) => c.x === prev[i].x && c.z === prev[i].z && c.r === prev[i].r)) return;
    this.keepOutIn = next;
    this.props?.setKeepOut(next);
    this.marks?.invalidate();
  }

  /** The floating origin at journey distance d (pure: SPEC 2.4 O(S)). Build an external W(t) on this. */
  originAt(d: number) { return this.route.originAt(d); }

  /** Ground height (world y) in the voyage's route frame: s = journey distance along the route, lateral = metres to
   *  starboard of it (the voyage lane's heightAt(s, d) contract). */
  heightAtRoute(s: number, lateral: number): number {
    const p = this.route.at(s, this.rpR);
    const [wx, wz] = DesertRoute.toWorld(p.heading, lateral, 0);
    return heightAt(this.spec, p.x + wx, p.z + wz);
  }
  private rpR: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

  // ------------------------------------------------------------------ pose (closed form in d)
  /** Ground fit under the ship at journey distance d: height h0 (world) + slopes a (per m starboard), b (per m aft). */
  private fitAt(dq: number) {
    const c = this.poseCache.get(dq);
    if (c) return c;
    const legs = this.gait?.legs ?? [];
    const hips = legs.length >= 3 ? legs.map((l) => l.hip) : [[-7.3, -15.3], [7.3, -15.3], [-7.4, 7.8], [7.4, 7.8]] as [number, number][];
    const p: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };
    const hs = hips.map(() => 0);
    const OFF = [-20, -10, 0, 10, 20];
    for (const o of OFF) {
      this.route.at(dq + o, p);
      hips.forEach((hp, i) => { const [wx, wz] = DesertRoute.toWorld(p.heading, hp[0], hp[1]); hs[i] += heightAt(this.spec, p.x + wx, p.z + wz) / OFF.length; });
    }
    // least squares h = h0 + a x + b z over the feet (room frame)
    let sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
    const n = hips.length;
    hips.forEach((hp, i) => { const x = hp[0], z = hp[1], h = hs[i]; sx += x; sz += z; sh += h; sxx += x * x; szz += z * z; sxz += x * z; sxh += x * h; szh += z * h; });
    const mx = sx / n, mz = sz / n, mh = sh / n;
    const cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz, cxh = sxh / n - mx * mh, czh = szh / n - mz * mh;
    const det = cxx * czz - cxz * cxz;
    const a = Math.abs(det) > 1e-9 ? (cxh * czz - czh * cxz) / det : 0;
    const b = Math.abs(det) > 1e-9 ? (czh * cxx - cxh * cxz) / det : 0;
    const h0 = mh - a * mx - b * mz;
    const r = { h0, a, b };
    if (this.poseCache.size > 64) this.poseCache.clear();
    this.poseCache.set(dq, r);
    return r;
  }

  /** Pose at journey distance d (pure: interpolated between whole-metre fits). */
  poseAt(d: number, out: DesertPose = { d: 0, x: 0, z: 0, heading: 0, h0: 0, pitch: 0, roll: 0 }): DesertPose {
    const i = Math.floor(d), f = d - i;
    const A = this.fitAt(i), B = this.fitAt(i + 1);
    this.route.at(d, this.rp);
    out.d = d; out.x = this.rp.x; out.z = this.rp.z; out.heading = this.rp.heading;
    out.h0 = A.h0 + (B.h0 - A.h0) * f;
    const a = A.a + (B.a - A.a) * f, b = A.b + (B.b - A.b) * f;
    out.pitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan(b)));
    out.roll = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan(a)));
    return out;
  }

  /** The desert root -> WORLD (x, height, z) transform with the ship at journey distance d (the inverse of update()'s
   *  world matrix times the floating origin, which cancels out): pure in d, so a camera can plan a whole move ahead. */
  rootToWorldAt(d: number, tilt = 1, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
    const P = this.poseAt(d, this.poseTmp);
    worldMatrix(P, tilt, this.groundY, 0, 0, out);
    return out.invert();
  }
  private poseTmp: DesertPose = { d: 0, x: 0, z: 0, heading: 0, h0: 0, pitch: 0, roll: 0 };

  /** The solid things on the sand a camera must keep out of, for a WORLD box (x0..x1, z0..z1): rocks, arches, bones,
   *  ruins and wrecks of the near features and the scatter rocks (from the seed, whatever the camera: every page gets the
   *  same set), plus the landmarks, gates, lines and burning wrecks the marks and ruins layers place round the ship's
   *  distance (pure in it; things past 1300 m from the ship are drawn distance-compressed and are scenery, not solid).
   *  One set per camera plan: `hit` tests a WORLD segment (or a point, a = b) for a crossing or a piece within `pad` m.
   *  The returned set reuses `out`'s buffers. */
  solidSet(x0: number, z0: number, x1: number, z1: number, out: DesertSolidSet = newSolidSet()): DesertSolidSet {
    const parts = out.parts;
    parts.length = 0;
    if (this.props) { this.props.featureParts(x0, z0, x1, z1, parts); this.props.scatterRocks(x0 - 4, z0 - 4, x1 + 4, z1 + 4, parts); }
    partsSolids(parts, out.pure);
    out.ox = this.O.x; out.oz = this.O.z;
    out.kits = [this.marks?.kit.solids, (this.ruins as unknown as { kit?: KitLayer } | null)?.kit?.solids].filter((s): s is KitSolids => !!s && s.n > 0);
    return out;
  }

  // ------------------------------------------------------------------ queries
  /** World (x, z) of a room-frame point at the current pose (ignores tilt: < 0.3 % at 4 degrees). */
  roomToWorld(rx: number, rz: number): [number, number] {
    const [wx, wz] = DesertRoute.toWorld(this.pose.heading, rx, rz);
    return [this.pose.x + wx, this.pose.z + wz];
  }

  /** Room-frame y of the sand at room (x, z) (feet, props, crew on the ground). */
  groundAtRoom(rx: number, rz: number): number {
    const [wx, wz] = this.roomToWorld(rx, rz);
    const h = heightAt(this.spec, wx, wz);
    tv.set(wx - this.O.x, h, wz - this.O.z).applyMatrix4(this.world.matrix);
    return tv.y;
  }

  /** Ground height (world) at world (x, z). */
  heightAt(x: number, z: number) { return heightAt(this.spec, x, z); }

  /** The ship's footfalls up to journey distance d (closed form: the same plants on every page, foot IK targets). */
  footfalls(d: number, perLeg = 8, gait = this.gait): Plant[] {
    if (!gait) return [];
    return footfalls(this.route, d, gait, perLeg, []);
  }

  /** A footprint from another walker (mech guest, crew) at room (x, z), yaw (rad, room), radius r (m). */
  plantRoom(rx: number, rz: number, yaw: number, r = 0.6, now = Date.now()) {
    if (!fin(rx) || !fin(rz) || !fin(yaw) || !fin(r) || !fin(now)) { this.perf.badInput++; return; }
    const [wx, wz] = this.roomToWorld(rx, rz);
    this.events.push({ x: wx, z: wz, yaw: yaw + this.pose.heading, r, at: now });
    if (this.events.length > 24) this.events.shift();
    this.dust?.puff(wx - this.O.x, this.heightAt(wx, wz) - 0, wz - this.O.z, r, now);
  }

  /** Rain-free style "dry" boxes in ROOM space (canopy, wheelhouse, below decks): no storm streaks inside them. Up to 4. */
  setDryBoxes(boxes: THREE.Box3[]) { if (this.dust) this.dust.dry = boxes.slice(0, 4); }

  /** Ship shadow casters: capsules in ROOM frame (legs, hull chain). Up to MAX_CASTERS. */
  setCasters(list: { a: [number, number, number]; b: [number, number, number]; r: number }[]) { this.casters = list.slice(0, MAX_CASTERS); }

  // ------------------------------------------------------------------ frame
  update(f: DesertFrame) {
    const t0 = performance.now();
    // ---- input guard: a bad number never poisons state (NaN keeps the last good value; huge distances clamp)
    let bad = 0;
    if (fin(f.d)) this.lastD = safeD(f.d); else bad++;
    if (fin(f.hour)) this.lastHour = f.hour; else bad++;
    const d = this.lastD;
    const now = fin(f.now) ? f.now : Date.now();
    const dt = this.lastNow ? Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000)) : 0;
    this.lastNow = now;
    const storm = fin(f.storm) ? Math.min(1, Math.max(0, f.storm)) : 0;
    const speed = fin(f.speed) ? Math.max(0, f.speed) : 3;
    const front = fin(f.stormFront) ? Math.min(1, Math.max(0, f.stormFront)) : undefined;
    const cloud = fin(f.cloud) ? f.cloud : 0;
    const flash = fin(f.flash) ? f.flash : 0;
    if (bad || (f.speed !== undefined && !fin(f.speed)) || (f.storm !== undefined && !fin(f.storm))) this.perf.badInput++;
    if (!this.packDecided) this.decidePacking(f.renderer);
    // ---- pose + origin (O is a pure function of d: every page holds the same origin at the same d)
    const P = this.poseAt(d, this.pose);
    const On = this.route.originAt(d, this.Onext);
    if (!this.O.set || On.x !== this.O.x || On.z !== this.O.z) {
      const dx = On.x - this.O.x, dz = On.z - this.O.z;
      const was = this.O.set;
      this.O.x = On.x; this.O.z = On.z; this.O.set = true;
      this.ctx = localCtx(this.spec, this.O.x, this.O.z, d, this.ctx ?? undefined);
      writeHeightUniforms(this.hu, this.spec, this.ctx);
      this.polyK0 = this.ctx.polyK0;
      this.clip.invalidate();
      if (was) { this.dust?.rebase(dx, dz); this.perf.rebases++; }
      this.writeAnchor();
    } else {
      const k0 = Math.floor(d / CORRIDOR_STEP) - (CORRIDOR_N >> 1) + 1;
      if (k0 !== this.polyK0) {
        this.ctx = localCtx(this.spec, this.O.x, this.O.z, d, this.ctx ?? undefined);
        writeHeightUniforms(this.hu, this.spec, this.ctx);
        this.polyK0 = this.ctx.polyK0;
        // (the relief reads the route distance from this polyline everywhere: every level re-renders from the new one, so
        // the heights are a pure function of d - a page that walked here and one that opened here agree; staggered over a
        // few frames, finest first, so the step doesn't hitch)
        if (this.spec.relief > 0) this.clip.invalidateSoft();
      }
    }
    // ---- world matrix: the voyage's W, or T(0, groundY) * tilt * rotY(heading) * T(-(P - O)) * T(0, -h0)
    const M = this.world.matrix;
    if (f.world) M.copy(f.world);
    else worldMatrix(P, fin(f.tilt) ? Math.max(0, Math.min(1, f.tilt)) : 1, this.groundY, this.O.x, this.O.z, M);
    this.world.updateMatrixWorld(true);
    // ---- primary camera in terrain-local space (clipmap centre, far / props cells)
    const cam = f.camera;
    cam.updateMatrixWorld();
    tm2.copy(this.world.matrixWorld).invert();
    this.camT.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(tm2);
    // ---- clipmap + this camera's view (terrain selection, camera uniforms)
    this.perf.clipLevels = this.clip.update(f.renderer, this.camT.x, this.camT.z);
    this.vDirty = true;
    this.prepareView(cam);
    // ---- light
    const li = this.lightIn;
    li.hour = this.lastHour; li.storm = storm; li.cloud = cloud; li.north = this.north;   // + the room's sun path (setSunPath)
    const L = desertLight(li, this.light);
    // dusty air (haze > 1, the SAND look): an ochre horizon and haze, a dust-tinted zenith; the thicker air itself is
    // uFog x haze below. Recomputed from scratch every frame by desertLight, so this never accumulates.
    if (this.haze > 1) {
      const k = Math.min(0.85, (this.haze - 1) * 1.2), dl = Math.max(0.15, L.day);
      L.horizon.lerp(tv3Col.copy(L.dust).multiplyScalar(1.05), k * 0.85 * dl);
      L.hazeCol.lerp(tv3Col.copy(L.dust).multiplyScalar(0.95), k * dl);
      L.hazeSun.lerp(tv3Col.copy(L.dust).multiplyScalar(1.2), k * 0.6 * dl);
      // (the zenith only a touch: blue + ochre mixes to lavender after tone mapping; SAND's sky stays a washed blue)
      L.zenith.lerp(tv3Col.copy(L.horizon).lerp(L.dust, 0.3), k * 0.3 * dl);
    }
    // the night tint (a show sky's colours, subtly) in the haze + horizon
    if (this.nightTint && L.day < 0.6) {
      const t = this.nightTint, lt = Math.max(0.02, t.r * 0.3 + t.g * 0.59 + t.b * 0.11), lh = L.hazeCol.r * 0.3 + L.hazeCol.g * 0.59 + L.hazeCol.b * 0.11;
      const k = 0.32 * (1 - L.day / 0.6);
      tv3Col.copy(t).multiplyScalar((lh * 1.25) / lt);
      L.hazeCol.lerp(tv3Col, k); L.horizon.lerp(tv3Col, k * 0.6);
    }
    // moonlight floor: a cool key from the moon (or, with the moon down, a skylight from a fixed high bearing), never
    // weaker than the floor - at night the dunes, cliffs and mesas keep their shape
    if (this.moonlight > 0 && L.day < 0.5) {
      const floor = 0.085 * this.moonlight * (1 - L.day * 2) * (1 - storm * 0.8);
      const lk = L.key.r * 0.3 + L.key.g * 0.59 + L.key.b * 0.11;
      if (lk < floor) {
        if (L.moonEl < 12) L.keyW.set(0.52, 0.46, -0.72).normalize();
        L.key.setRGB(0.62, 0.74, 1.0).multiplyScalar(floor / 0.72);
      }
    }
    const du = this.du;
    du.uSunT.value.copy(L.keyW);
    du.uSunCol.value.copy(L.key);
    du.uSkyAmb.value.copy(L.skyAmb);
    du.uGndAmb.value.copy(L.gndAmb);
    du.uHazeCol.value.copy(L.hazeCol);
    du.uHazeSun.value.copy(L.hazeSun);
    du.uFog.value.set(L.fogD, L.fogH, P.h0, storm > 0.5 ? 1 : 0.985);
    // aerial perspective in steps (haze): crisp mid-distance layers, the far ones sink into the dusty air; a storm is
    // one blanket again
    {
      const h = this.haze, near = h > 1 ? 0.6 : h, far = h > 1 ? h * 1.35 : h;
      du.uAerial.value.set(near + (1 - near) * storm, far + (1 - far) * storm, 900, 2600);
    }
    {
      const tt = now / 1000, fl = 0.86 + 0.14 * Math.sin(tt * 9.1) * Math.sin(tt * 3.7 + 1.3);
      du.uFireCol.value.setRGB(1.0, 0.42, 0.13).multiplyScalar((0.25 + 2.2 * L.dark) * fl);
    }
    du.uStorm.value = storm;
    du.uDayK.value = L.day;
    du.uDark.value = L.dark;
    du.uTime.value = (now / 1000) % 3600;
    const wsp = 6 + 16 * storm;
    du.uWindT.value.set(this.spec.c * wsp, this.spec.s * wsp);
    du.uFlash.value.setRGB(0.8, 0.82, 1).multiplyScalar(flash * 0.8);
    // far ground (flat sand, lit like the terrain shader's dLight with N = up)
    const ky = L.keyW.y, band = smoothstep(-0.02, 0.1, ky) * (0.78 + 0.22 * smoothstep(0.2, 0.75, ky));
    const fg = this.terrain.u.uFarGround.value as THREE.Color;
    const sand = (this.terrain.u.uSand.value as THREE.Color), trough = (this.terrain.u.uTrough.value as THREE.Color);
    fg.copy(sand).lerp(trough, 0.35);
    const lum = fg.r * 0.3 + fg.g * 0.59 + fg.b * 0.11;
    fg.lerp(tv3Col.setRGB(0.78, 0.88, 1.12).multiplyScalar(lum), (1 - L.day) * 0.6);          // the terrain's moonlight desaturation
    fg.multiply(tv2Col.copy(L.key).multiplyScalar(band * 0.92).add(L.skyAmb).add(tv3Col.copy(L.gndAmb).multiplyScalar(0.5))).multiplyScalar(0.86);
    (this.terrain.u.uMirage.value as THREE.Color).copy(L.horizon).lerp(L.zenith, 0.25);
    this.terrain.u.uMirageK.value = L.mirage * (QN[this.quality] >= 1 ? 0.55 : 0.4);
    // ---- sky
    if (this.sky) {
      const u = this.sky.u;
      (u.uRoomToW.value as THREE.Matrix3).setFromMatrix4(this.world.matrixWorld).invert();
      (u.uZenith.value as THREE.Color).copy(L.zenith); (u.uHorizon.value as THREE.Color).copy(L.horizon);
      (u.uSunW.value as THREE.Vector3).copy(L.sunW); (u.uSunDisc.value as THREE.Color).copy(L.sunCol); u.uSunVis.value = L.sunVis;
      (u.uMoonW.value as THREE.Vector3).copy(L.moonW); u.uMoonVis.value = L.moonVis; u.uStars.value = L.stars;
      (u.uDust.value as THREE.Color).copy(L.dust);
      (u.uFarGround.value as THREE.Color).copy(fg);
      u.uGroundY.value = P.h0;
      (u.uMtnFar.value as THREE.Color).copy(L.horizon).multiplyScalar(0.86).lerp(tv2Col.setRGB(0.48, 0.45, 0.6).multiplyScalar(0.25 + 0.75 * L.day), 0.3);
      (u.uMtnNear.value as THREE.Color).copy(L.horizon).multiplyScalar(0.7).lerp(tv2Col.setRGB(0.42, 0.3, 0.27).multiplyScalar(0.15 + 0.85 * L.day), 0.45);
      u.uCirrus.value = 0.45 + 0.45 * cloud;          // (high cirrus streaks most of the time: the desert sky is never an empty gradient)
    }
    // ---- prints (ship footfalls + events), casters
    const wake = fin(f.wake) ? Math.min(1, Math.max(0, f.wake)) : wakeK(speed);
    this.updatePrints(d, now, storm, speed, wake);
    this.updateCasters();
    this.updateWake(d, wake, storm);
    // ---- layers (they read the sanitised frame)
    const fs = this.fsafe;
    fs.d = d; fs.speed = speed; fs.hour = this.lastHour; fs.storm = storm; fs.stormFront = front; fs.cloud = cloud; fs.now = now;
    fs.camera = f.camera; fs.renderer = f.renderer; fs.faces = f.faces; fs.flash = flash; fs.tilt = f.tilt; fs.world = f.world;
    this.far?.update(this, fs, L);
    this.props?.update(this, fs, L);
    if (this.marks) {
      this.marks.update(this, fs, L);
      const Z = this.terrain.u.uSaltZ.value as THREE.Vector4[];
      for (let i = 0; i < 2; i++) { const z = this.marks.saltZ[i]; if (z) Z[i].set(z[0], z[1], z[2], z[3]); else Z[i].set(0, 0, 1, 0); }
    }
    if (this.life) { this.life.emitters = this.marks?.smoke ?? []; this.life.update(this, fs, L); }
    this.ruins?.update(this, fs, L);
    this.dust?.update(this, fs, L, dt, storm, front === undefined ? null : haboobDistance(front));
    const ms = performance.now() - t0;
    this.perf.ms += (ms - this.perf.ms) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private fsafe = { d: 0, hour: 12 } as DesertFrame;

  /** Make the desert ready to draw from `camera` (terrain-local camera uniform + this camera's terrain patch selection).
   *  Called by update() for the primary camera and by every desert mesh's onBeforeRender for any other camera (tiles,
   *  remote passes): cheap when nothing changed. Views far from the primary camera draw coarser terrain near them (the
   *  clipmap windows follow the primary camera; patches never read outside a window). */
  prepareView(camera: THREE.Camera) {
    const cw = camera.matrixWorld.elements, pm = camera.projectionMatrix.elements, ww = this.world.matrixWorld.elements;
    if (!this.vDirty && camera === this.vCam && eq16(cw, this.vCW) && eq16(pm, this.vPM) && eq16(ww, this.vWW)) return;
    this.vDirty = false;
    this.vCam = camera; this.vCW.set(cw); this.vPM.set(pm); this.vWW.set(ww);
    tm2.copy(this.world.matrixWorld).invert();
    this.viewCamT.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(tm2);
    this.du.uCamT.value.copy(this.viewCamT);
    tm3.copy(camera.matrixWorld).invert();
    const vp = tm4.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, tm3).multiply(this.world.matrixWorld);
    this.terrain.select(this.viewCamT, vp, this.clip);
    this.perf.views++;
  }

  /** World anchors for the shading noise (SPEC 2.4 "uOct = (O f) mod 4096"): O mod 4096 in world and wind frames, and
   *  the ripple phase fract(O.w / 0.55), computed in float64. */
  private writeAnchor() {
    const ox = this.O.x, oz = this.O.z, c = this.spec.c, sn = this.spec.s;
    const md = (a: number) => a - ANCHOR_P * Math.floor(a / ANCHOR_P);
    const ou = ox * c + oz * sn, ov = -ox * sn + oz * c;
    (this.du.uAnc.value as THREE.Vector4).set(md(ox), md(oz), md(ou), md(ov));
    this.du.uAncPh.value = ou / 0.55 - Math.floor(ou / 0.55);
  }

  /** Float render targets available? If not, the clipmap packs into RGBA8 (uniform-only switch). */
  private decidePacking(renderer: THREE.WebGLRenderer) {
    this.packDecided = true;
    let ok = true;
    try { ok = renderer.extensions.has('EXT_color_buffer_float'); } catch { ok = true; }
    if (!ok && !this.clip.packed) { this.clip.setPacked(true); this.vDirty = true; }
  }

  /** Sand wake: churned, streaked sand within ~60 m astern at battle pace (SPEC 3.6, wakeK) or the voyage's level. */
  private updateWake(d: number, wake: number, storm: number) {
    const k = wake * (1 - 0.5 * storm);
    const U = this.terrain.u;
    (U.uWake.value as THREE.Vector4).set(this.pose.x - this.O.x, this.pose.z - this.O.z, k, d - ANCHOR_P * Math.floor(d / ANCHOR_P));
    (U.uWakeDir.value as THREE.Vector2).set(Math.sin(this.pose.heading), -Math.cos(this.pose.heading));
  }

  private updatePrints(d: number, now: number, storm: number, speed: number, wake: number) {
    const U = this.terrain.u;
    const pr = U.uPrint.value as THREE.Vector4[], pb = U.uPrintB.value as THREE.Vector4[];
    let n = 0;
    const cap = PRINTS_Q[this.quality] ?? MAX_PRINTS;
    let evCap = cap;
    if (this.gait && this.gait.legs.length) {
      // a leg's oldest print leaves the set when its age reaches perLeg * stride: shipPrints fades it out by then
      const r = shipPrints(this.route, this.gait, d, cap, storm, this.plants, this.prints, EVENT_PRINTS_MIN);
      for (let i = 0; i < r.n && n < MAX_PRINTS; i++) {
        const p = this.prints[i].plant;
        pr[n].set(p.x - this.O.x, p.z - this.O.z, Math.cos(p.yaw), Math.sin(p.yaw));
        pb[n].set(p.r, this.prints[i].strength, p.len, 0);
        n++;
      }
      evCap = cap - r.perLeg * this.gait.legs.length;
      this.dust?.plants(this.plants, d, now, this.O, this.hAt, speed, wake);
    }
    const nEv0 = n;
    for (const e of this.events) {
      if (n >= MAX_PRINTS || n - nEv0 >= evCap) break;
      const k = 1 - smoothstep(60_000, 180_000, now - e.at);
      if (k <= 0.01) continue;
      pr[n].set(e.x - this.O.x, e.z - this.O.z, Math.cos(e.yaw), Math.sin(e.yaw));
      pb[n].set(e.r, k, 1, 0);
      n++;
    }
    U.uPrintN.value = n;
    (U.uPrintBound.value as THREE.Vector4).set(this.pose.x - this.O.x, this.pose.z - this.O.z, 160, 0);
  }

  private updateCasters() {
    const U = this.terrain.u;
    const A = U.uCapA.value as THREE.Vector4[], B = U.uCapB.value as THREE.Vector4[];
    tm2.copy(this.world.matrixWorld).invert();
    const n = this.casters.length;
    for (let i = 0; i < n; i++) {
      const c = this.casters[i];
      tv.set(c.a[0], c.a[1], c.a[2]).applyMatrix4(this.root.matrixWorld).applyMatrix4(tm2);
      tv2.set(c.b[0], c.b[1], c.b[2]).applyMatrix4(this.root.matrixWorld).applyMatrix4(tm2);
      A[i].set(tv.x, tv.y, tv.z, c.r); B[i].set(tv2.x, tv2.y, tv2.z, 0);
    }
    U.uCapN.value = n;
    (U.uCapBound.value as THREE.Vector4).set(this.pose.x - this.O.x, this.pose.z - this.O.z, 140, 0);
  }

  /** Warm every program, hidden ones included (storm streaks, haboob, city glow, empty kit shapes), so storms, night
   *  and quality changes never compile mid-show. three keys programs on the bound target (canvas = sRGB output + the
   *  renderer's tone mapping; any render target = linear, no tone mapping), and Stage/Pipeline draws the room into an
   *  HDR target, so BOTH variants are warmed by default; pass `targets` to warm exactly the ones you draw into. */
  compile(renderer: THREE.WebGLRenderer, camera: THREE.Camera, targets?: (THREE.WebGLRenderTarget | null)[]) {
    if (!this.packDecided) this.decidePacking(renderer);
    this.clip.compile(renderer);
    const hidden: THREE.Object3D[] = [];
    this.root.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    // compile against the scene the desert renders in (its lights are part of every program's key)
    let top: THREE.Object3D = this.root;
    while (top.parent) top = top.parent;
    const scene = (top as THREE.Scene).isScene ? (top as THREE.Scene) : null;
    const prev = renderer.getRenderTarget();
    let scratch: THREE.WebGLRenderTarget | null = null;
    const list = targets ?? [null, (scratch = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true }))];
    for (const t of list) {
      try { renderer.setRenderTarget(t); renderer.compile(this.root, camera, scene); } catch { /* optional */ }
    }
    renderer.setRenderTarget(prev);
    scratch?.dispose();
    for (const o of hidden) o.visible = false;
  }

  /** Lit flat sand colour at the moment (dust, far ground). */
  farGround(): THREE.Color { return this.terrain.u.uFarGround.value as THREE.Color; }

  /** Terrain origin (world) currently in use. */
  origin() { return { x: this.O.x, z: this.O.z }; }

  info() {
    return {
      seed: this.spec.seed, quality: this.quality, d: +this.pose.d.toFixed(2), heading: +((this.pose.heading * 180) / Math.PI).toFixed(2),
      pos: [+this.pose.x.toFixed(2), +this.pose.z.toFixed(2)], h0: +this.pose.h0.toFixed(3), pitch: +((this.pose.pitch * 180) / Math.PI).toFixed(2), roll: +((this.pose.roll * 180) / Math.PI).toFixed(2),
      origin: [this.O.x, this.O.z], camT: [+this.camT.x.toFixed(1), +this.camT.y.toFixed(1), +this.camT.z.toFixed(1)], packed: this.clip.packed,
      views: this.perf.views, badInput: this.perf.badInput, rebases: this.perf.rebases,
      terrain: this.terrain.stats, clip: { renders: this.clip.stats.renders, lastFrame: this.clip.stats.lastFrame },
      far: this.far?.stats ?? null, props: this.props?.stats ?? null, dust: this.dust?.stats ?? null, marks: this.marks?.stats ?? null, life: this.life?.stats ?? null, ruins: this.ruins?.stats ?? null,
      prints: this.terrain.u.uPrintN.value, casters: this.terrain.u.uCapN.value,
      sun: { el: +this.light.sunEl.toFixed(2), vis: +this.light.sunVis.toFixed(2) }, fog: +this.light.fogD.toExponential(2),
      ms: +this.perf.ms.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }

  dispose() {
    if (this.shaft) { shaftSources.delete(this.shaft); this.shaft = null; }
    this.root.removeFromParent();
    this.terrain.dispose(); this.clip.dispose(); this.sky?.dispose(); this.far?.dispose(); this.props?.dispose(); this.dust?.dispose(); this.marks?.dispose(); this.life?.dispose();
  }
}

const tv2Col = new THREE.Color(), tv3Col = new THREE.Color();
function smoothstep(e0: number, e1: number, x: number) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

export { DesertWorldSpec, heightAt, SHIP_GAIT, SHIP_GROUND_Y, footfalls };
export type { GaitLike, Plant, Flat, City, CityArchetype };

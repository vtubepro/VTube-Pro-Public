// Town engine — a living harbour for rooms whose scene.json has a `town` key (the Kingsmarch room): the animated sea
// (water.ts), boats riding the same swell (BOB_xx), a merchant ship sailing in and out along SHIPLANE_xx
// (SHIP_SAIL), banners / signs / cargo swaying (SWAY_xx), gulls (gulls.ts), embers / chimney smoke / wave spray /
// sky lanterns / rain (particles.ts), the lighthouse beam sweeping, fog banks + god rays drawn additive (M_Add), and the
// ambient crowd (crowd.ts). Weather follows the host's lighting state (scene.json town.weatherByState:
// preshow → storm, brb → fog, …).
//
// Sync: everything is a pure function of the TOWN CLOCK = wall-clock ms since UTC midnight (mod 1 day, so the float32
// shader time stays precise). Same PC (studio preview + OBS pages) = identical; party guests' OBS = identical up to
// their clock skew (NTP, typically well under a second; nothing here is event-driven, so nothing can drift apart).
// Test pages: `vtpOut.town.manual = true; vtpOut.town.clock = <s>`.
//
// Cost: rooms without `town` → zero (one check per frame). With it: ≈ 0.2–0.6 ms CPU per frame (crowd posing
// dominates: ~26 NPCs, off-screen ones skipped, far ones at 1/2 or 1/3 rate), draw calls: sea 1, gulls 1, particles
// ≤ 5, lighthouse 2, NPCs ~26 (+ props).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { sceneFileUrl } from '../SceneRuntime.ts';
import { seaAt, type SeaSample } from './waves.ts';
import { Water, DEFAULT_WATER, MAX_FOAM } from './water.ts';
import { Gulls } from './gulls.ts';
import { Particles, type SystemKind } from './particles.ts';
import { Crowd, type CrowdRoom, type NavNode, type Poi } from './crowd.ts';
import { TownAssets } from './townUnits.ts';
import { activeEnv } from '../environment/index.ts';
import { Halos, Sparks, CloudDome, beamMaterial, sheenMaterial, type HaloSpec } from './fx.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';

export type Weather = 'dusk' | 'storm' | 'fog' | 'festival' | 'sunset' | 'night';

/** effects richness per graphics level (src/stage/gfx): particle share, halo gain, sea sparkle */
const FXQ: Record<string, { parts: number; halo: number; sea: number; beam: number }> = {
  performance: { parts: 0.45, halo: 0.8, sea: 0.0, beam: 0.8 }, balanced: { parts: 0.7, halo: 1.0, sea: 0.6, beam: 1.0 },
  high: { parts: 0.88, halo: 0.85, sea: 1.0, beam: 1.1 }, ultra: { parts: 1.0, halo: 0.85, sea: 1.3, beam: 1.2 },
};

interface TownCfg {
  waterLevel?: number; quayEdge?: { z?: number; x?: [number, number] };
  crowd?: { iconic?: string[]; townsfolk?: number; npcHeight?: number; off?: boolean };
  gulls?: number; shipEvery?: number; units?: string; anims?: string;
  weatherByState?: Record<string, Weather>; water?: Partial<typeof DEFAULT_WATER>;
}

interface Bob { node: THREE.Object3D; rest: THREE.Vector3; restQ: THREE.Quaternion; heave: number; pitch: number; roll: number; len: number; beam: number }
interface Sway { node: THREE.Object3D; restQ: THREE.Quaternion; axis: string; amp: number; period: number; kind: string; ph: number }

const DAY = 86400;
const tv = new THREE.Vector3(), tq = new THREE.Quaternion(), te = new THREE.Euler();
const ss: SeaSample = { y: 0, dx: 0, dz: 0, nx: 0, nz: 0 };

export class TownScene {
  private rt: SceneRuntime | null = null;
  private cfg: TownCfg | null = null;
  private group = new THREE.Group();
  private water: Water | null = null;
  private sea: THREE.Mesh | null = null;
  private seaMat: THREE.Material | THREE.Material[] | null = null;
  private glass: { mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
  private waterY = -3;
  private bobs: Bob[] = [];
  private ship: { node: THREE.Object3D; lane: THREE.Vector3[]; cum: number[]; len: number; restQ: THREE.Quaternion; every: number } | null = null;
  private sways: Sway[] = [];
  private gulls: Gulls | null = null;
  private fx: Particles[] = [];
  private fxByKind = new Map<string, Particles>();
  private beam: THREE.Mesh | null = null;
  private beamGlow: THREE.Sprite | null = null;
  private beam2: THREE.Mesh | null = null;
  private halos: Halos | null = null;
  private sparks: Sparks | null = null;
  private clouds: CloudDome | null = null;
  private wLights: { p: THREE.Vector3; c: THREE.Color; k: number }[] = [];
  private wLightT = 0;
  private cranes: { jib: THREE.Object3D; restQ: THREE.Quaternion; hook: THREE.Object3D | null; hookRest: THREE.Vector3; rope: THREE.Object3D | null; ropeLen: number; yaw: number; lift: number; period: number; ph: number }[] = [];
  /** support events waiting for the crowd (town-clock seconds) */
  private pendingCheers: number[] = [];
  private sheen: THREE.Mesh | null = null;
  private spin: THREE.Object3D[] = [];
  private fog2: THREE.Object3D | null = null;
  /** the current graphics level ('balanced' unless the gfx system says otherwise) */
  level = 'balanced';
  private addMats: { m: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial; base: number; kind: string }[] = [];
  private fogNode: THREE.Object3D | null = null;
  private fogRest = new THREE.Vector3();
  private crowd: Crowd | null = null;
  private assetsErr = '';
  private skyMats: THREE.Material[] = [];
  private weather: Weather = 'dusk';
  private w = { storm: 0, fog: 0, festival: 0, night: 0 };
  private flash = 0;
  private savedFog: { near: number; far: number; color: THREE.Color } | null = null;
  private perf = { avg: 0, peak: 0 };
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = 0;
  /** Tests: force a weather (null = follow the lighting state). */
  forceWeather: Weather | null = null;

  now() { return this.manual ? this.clock : (Date.now() % (DAY * 1000)) / 1000; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { town?: TownCfg }).town;
    if (!cfg) return;               // not a town room: nothing at all
    this.rt = rt;
    this.cfg = cfg;
    // the room's glTF clips (boats rocking, sails billowing: roomClips.ts) run on the town clock (manual on test pages)
    rt.clipClock = () => this.now();
    this.group.name = 'vtp:town';
    rt.root.add(this.group);
    try { this.build(rt, cfg); } catch (e) { console.warn('town: build failed', e); }
  }

  detach() {
    const rt = this.rt;
    if (rt) rt.clipClock = null;
    if (rt && this.sea && this.seaMat) this.sea.material = this.seaMat;
    this.water?.dispose(); this.water = null; this.sea = null; this.seaMat = null;
    for (const g of this.glass) { const cur = g.mesh.material as THREE.Material; g.mesh.material = g.mat; cur.dispose(); }
    this.glass = [];
    for (const b of this.bobs) { b.node.position.copy(b.rest); b.node.quaternion.copy(b.restQ); }
    this.bobs = [];
    if (this.ship) { this.ship.node.quaternion.copy(this.ship.restQ); }
    this.ship = null;
    for (const s of this.sways) s.node.quaternion.copy(s.restQ);
    this.sways = [];
    for (const m of this.skyMats) { const bm = m as THREE.MeshBasicMaterial; if (bm.userData.vtpSkyBase) bm.color.copy(bm.userData.vtpSkyBase as THREE.Color); }
    this.gulls?.dispose(); this.gulls = null;
    for (const f of this.fx) f.dispose();
    this.fx = []; this.fxByKind.clear();
    this.beam?.removeFromParent(); this.beam = null; this.beamGlow?.removeFromParent(); this.beamGlow = null;
    this.beam2?.removeFromParent(); this.beam2 = null; this.halos?.dispose(); this.halos = null;
    this.sparks?.dispose(); this.sparks = null;
    this.clouds?.dispose(); this.clouds = null;
    for (const c of this.cranes) { c.jib.quaternion.copy(c.restQ); c.hook?.position.copy(c.hookRest); }
    this.cranes = [];
    this.sheen?.removeFromParent(); this.sheen = null; this.fog2?.removeFromParent(); this.fog2 = null;
    for (const o of this.spin) o.rotation.y = 0;
    this.spin = [];
    this.crowd?.dispose(); this.crowd = null;
    this.addMats = []; this.skyMats = [];
    if (rt && this.savedFog && rt.stage.scene.fog instanceof THREE.Fog) {
      const f = rt.stage.scene.fog; f.near = this.savedFog.near; f.far = this.savedFog.far; f.color.copy(this.savedFog.color);
    }
    this.savedFog = null;
    this.group.removeFromParent();
    this.group = new THREE.Group();
    this.rt = null; this.cfg = null;
  }

  // ------------------------------------------------------------------ build
  private build(rt: SceneRuntime, cfg: TownCfg) {
    const root = rt.room.root;
    root.updateMatrixWorld(true);
    this.waterY = cfg.waterLevel ?? -3;
    const nodes = new Map<string, THREE.Object3D>();
    root.traverse((o) => { if (o.name) nodes.set(o.name, o); });
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const facing = (o: THREE.Object3D) => { const d = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())); return Math.atan2(d.x, d.z); };
    const extras = (o: THREE.Object3D) => (o.userData ?? {}) as Record<string, unknown>;
    // --- water
    const sea = nodes.get('SEA');
    const seaMesh = sea ? (((sea as THREE.Mesh).isMesh ? sea : sea.children.find((c) => (c as THREE.Mesh).isMesh)) as THREE.Mesh | undefined) : undefined;
    if (seaMesh) {
      const q = cfg.quayEdge ?? {};
      this.water = new Water({ ...DEFAULT_WATER, ...(cfg.water ?? {}) }, q.z ?? -12, q.x ?? [-40, 40], this.waterY);
      this.seaMat = seaMesh.material;
      seaMesh.material = this.water.material;
      seaMesh.frustumCulled = false;
      this.sea = seaMesh;
    }
    // --- sky + additive cards
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        if (/^M_Sky|^M_Far/.test(mm.name)) { (mm as THREE.MeshBasicMaterial).fog = false; mm.needsUpdate = true; this.skyMats.push(mm); }
        // puddles: the stage IBL turned them into white mirrors on High / Ultra; keep them dark + wet
        if (mm.name === 'M_Wet' && 'envMapIntensity' in mm) { const pm = mm as THREE.MeshStandardMaterial; pm.envMapIntensity = 0.15; pm.roughness = Math.max(pm.roughness, 0.5); pm.color.multiplyScalar(0.7); }
        // display-case glass: stacked panes + High/Ultra env reflections would milk out the items behind it
        if (mm.name === 'M_Glass' && !Array.isArray(m) && (o as THREE.Mesh).isMesh) {
          const gm = new THREE.MeshBasicMaterial({ name: 'vtp:town:glass', color: 0xd8eef4, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide });
          this.glass.push({ mesh: o as THREE.Mesh, mat: m });
          (o as THREE.Mesh).material = gm;
        }
        if (mm.name === 'M_Add') {
          const isRayNode = /RAYS/.test(o.name) || /RAYS/.test(o.parent?.name ?? '');
          const bm = (isRayNode ? mm.clone() : mm) as THREE.MeshBasicMaterial;
          if (isRayNode) (o as THREE.Mesh).material = bm;
          bm.blending = THREE.AdditiveBlending; bm.depthWrite = false; bm.transparent = true; bm.fog = false; bm.needsUpdate = true;
          (o as THREE.Mesh).renderOrder = 4;
          const isRay = /RAYS/.test(o.name) || /RAYS/.test(o.parent?.name ?? '');
          this.addMats.push({ m: bm, base: bm.opacity * (isRay ? 0.4 : 0.12), kind: isRay ? 'rays' : 'fog' });
        }
      }
    });
    this.fogNode = nodes.get('FX_FOG') ?? null;
    if (this.fogNode) this.fogRest.copy(this.fogNode.position);
    // --- bobbing boats + the sailing ship + swaying things
    for (const [name, o] of nodes) {
      if (/^BOB_/.test(name) && o.parent && !/^BOB_/.test(o.parent.name)) {
        const e = extras(o);
        const bb = new THREE.Box3().setFromObject(o);
        const sz = bb.getSize(new THREE.Vector3());
        this.bobs.push({ node: o, rest: o.position.clone(), restQ: o.quaternion.clone(), heave: Number(e.heave ?? 0.1), pitch: Number(e.pitch ?? 1), roll: Number(e.roll ?? 1.5),
          len: Math.max(2, Math.max(sz.x, sz.z) * 0.8), beam: Math.max(1, Math.min(sz.x, sz.z) * 0.8) });
      }
      if (/^SWAY_/.test(name) && o.parent && !/^SWAY_/.test(o.parent.name)) {
        const e = extras(o);
        this.sways.push({ node: o, restQ: o.quaternion.clone(), axis: String(e.axis ?? 'x'), amp: Number(e.amp ?? 4), period: Number(e.period ?? 3), kind: String(e.kind ?? 'banner'), ph: (name.length * 1.7) % 6.28 });
      }
    }
    const shipNode = nodes.get('SHIP_SAIL');
    if (shipNode) {
      const lane = [...nodes.entries()].filter(([n]) => /^SHIPLANE_\d+$/.test(n)).sort((a, b) => a[0].localeCompare(b[0])).map(([, o]) => wp(o));
      lane.push(shipNode.position.clone());
      const cum = [0];
      for (let i = 1; i < lane.length; i++) cum.push(cum[i - 1] + lane[i].distanceTo(lane[i - 1]));
      this.ship = { node: shipNode, lane, cum, len: cum[cum.length - 1], restQ: shipNode.quaternion.clone(), every: cfg.shipEvery ?? 190 };
      const e = extras(shipNode);
      this.bobs.push({ node: shipNode, rest: shipNode.position.clone(), restQ: shipNode.quaternion.clone(), heave: Number(e.heave ?? 0.25), pitch: Number(e.pitch ?? 1.2), roll: Number(e.roll ?? 2), len: 20, beam: 6 });
    }
    // --- foam around piles / rocks / hulls
    const foam: { x: number; z: number; r: number; w: number }[] = [];
    for (const [n, o] of nodes) if (/^WAVE_BREAK_/.test(n)) { const p = wp(o); foam.push({ x: p.x, z: p.z, r: 2.4, w: 1 }); }
    for (const b of this.bobs) if (b.node !== shipNode) foam.push({ x: b.rest.x, z: b.rest.z, r: b.len * 0.35, w: 0.55 });
    this.water?.setFoam(foam.slice(0, MAX_FOAM));
    // --- gulls
    const perches = [...nodes.entries()].filter(([n]) => /^PERCH_/.test(n)).map(([, o]) => wp(o));
    const centre = new THREE.Vector3(0, this.waterY, -20);
    this.gulls = new Gulls(cfg.gulls ?? 14, perches, centre);
    this.group.add(this.gulls.mesh);
    // --- particles
    const pts = (re: RegExp) => [...nodes.entries()].filter(([n]) => re.test(n)).map(([, o]) => wp(o));
    const addFx = (kind: SystemKind, em: THREE.Vector3[], n?: number) => {
      if (!em.length) return;
      const p = new Particles(kind, em, n);
      this.fx.push(p); this.fxByKind.set(kind, p); this.group.add(p.points);
    };
    addFx('embers', pts(/^FX_EMBERS_/), 36);
    addFx('flame', pts(/^FX_EMBERS_/), 22);
    addFx('motes', pts(/^FX_MOTES_/), 40);
    addFx('smoke', pts(/^FX_SMOKE_/));
    addFx('spray', pts(/^WAVE_BREAK_/).map((p) => p.setY(this.waterY + 0.2)));
    addFx('lanterns', [new THREE.Vector3(0, this.waterY + 1, -30)], 70);
    addFx('rain', [new THREE.Vector3()], 1800);
    // --- glow halos round the practical lights (flicker per light)
    const hs: HaloSpec[] = [];
    const HALO: Record<string, [number, string, number]> = { lanterns: [0.95, '#ffb04a', 1], candles: [0.28, '#ffc870', 1], braziers: [1.7, '#ff7a22', 0.8],
      orbs: [0.28, '#fff0c8', 0.25], waypoint: [1.3, '#5cc8ff', 0.2], mirror: [0.3, '#a8e8ff', 0.2], gems: [0.35, '#9affb8', 0.3], uniques: [0.6, '#b070ff', 0.25],
      lighthouse: [7.0, '#fff0c0', 0.08], atlas: [0.5, '#7ab8ff', 0.25] };
    let hk = 0;
    for (const [n, o] of nodes) {
      const m = /^LIGHT_([a-z]+)_/.exec(n);
      if (!m || !HALO[m[1]] || !o.parent || /^LIGHT_/.test(o.parent.name)) continue;
      const [sz, col, fl] = HALO[m[1]];
      hs.push({ p: wp(o), size: sz, color: new THREE.Color(col), flicker: fl, seed: (hk++ * 7.13) % 97 });
    }
    if (hs.length) { this.halos = new Halos(hs); this.group.add(this.halos.points); }
    // --- lights mirrored on the water (nearest ones to the camera, refreshed 2×/s)
    const WL: Record<string, [string, number]> = { lanterns: ['#ffb04a', 1.0], braziers: ['#ff7a22', 1.4], windows: ['#ff9a3c', 0.55], lighthouse: ['#fff0c0', 3.0], sign: ['#ffc050', 0.8], waypoint: ['#5cc8ff', 0.8], candles: ['#ffcf7a', 0.35] };
    for (const [n, o] of nodes) {
      const m = /^LIGHT_([a-z]+)_/.exec(n);
      if (!m || !WL[m[1]] || !o.parent || /^LIGHT_/.test(o.parent.name)) continue;
      const p = wp(o);
      if (p.z > 8 || p.y > this.waterY + 16) continue;
      this.wLights.push({ p, c: new THREE.Color(String(extras(o).color ?? WL[m[1]][0])), k: WL[m[1]][1] });
    }
    // --- the Mirror of Kalandra's sheen
    const fm = nodes.get('FX_MIRROR');
    if (fm) {
      const r = Number(extras(fm).radius ?? 0.36);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.98, 32), sheenMaterial());
      fm.updateWorldMatrix(true, false);
      disc.position.copy(wp(fm));
      disc.quaternion.copy(fm.getWorldQuaternion(new THREE.Quaternion()));
      disc.translateZ(0.012);
      disc.renderOrder = 7;
      this.sheen = disc; this.group.add(disc);
    }
    // --- the waypoint's swirl turns
    const wpd = nodes.get('LIGHT_waypoint_disc');
    if (wpd) this.spin.push(wpd);
    // --- dock cranes loading the ships: CRANE_JIB_xx (pivot, extras yaw ° swing, period s) + its CRANE_HOOK_xx child (lift m)
    for (const [n, o] of nodes) {
      const m = /^CRANE_JIB_(\w+)$/.exec(n);
      if (!m) continue;
      const e = extras(o);
      const hook = nodes.get('CRANE_HOOK_' + m[1]) ?? null;
      const rope = nodes.get('CRANE_ROPE_' + m[1]) ?? null;
      // the hook + rope turn with the boom
      if (hook) o.attach(hook);
      if (rope) o.attach(rope);
      const ropeLen = rope && hook ? Math.max(0.5, wp(rope).y - wp(hook).y) : 1;
      this.cranes.push({ jib: o, restQ: o.quaternion.clone(), hook, hookRest: hook ? hook.position.clone() : new THREE.Vector3(), rope, ropeLen, yaw: THREE.MathUtils.degToRad(Number(e.yaw ?? 70)),
        lift: Number(e.lift ?? 2.5), period: Number(e.period ?? 48), ph: Number(e.phase ?? 0) });
    }
    // --- anvil sparks (the smith's hammer blows, reported by the crowd)
    this.sparks = new Sparks(48); this.group.add(this.sparks.points);
    // --- drifting cel cloud banks over the painted sky (only rooms with their own sky mesh)
    if (this.skyMats.length) { this.clouds = new CloudDome(); this.group.add(this.clouds.mesh); }
    // --- a second, counter-drifting fog layer (thicker haze over the water)
    if (this.fogNode) {
      const f2 = this.fogNode.clone(true);
      f2.scale.set(1.15, 1.25, 1.1);
      f2.position.y += 1.2;
      this.fogNode.parent?.add(f2);
      this.fog2 = f2;
    }
    // --- lighthouse beam
    const lamp = nodes.get('LIGHT_lighthouse_lamp');
    if (lamp) {
      const p = wp(lamp);
      const g = new THREE.ConeGeometry(9, 140, 16, 1, true);
      g.translate(0, -70, 0); g.rotateZ(Math.PI / 2);      // apex at the lamp, pointing +X
      const m = beamMaterial();
      this.beam = new THREE.Mesh(g, m);
      const g2 = new THREE.ConeGeometry(3.2, 150, 16, 1, true);
      g2.translate(0, -75, 0); g2.rotateZ(Math.PI / 2);
      const m2 = beamMaterial(); (m2.uniforms.uLen as THREE.IUniform).value = 150;
      this.beam2 = new THREE.Mesh(g2, m2);
      this.beam2.renderOrder = 6;
      this.beam.position.copy(p);
      this.beam.renderOrder = 6;
      this.group.add(this.beam);
      this.beam2.position.copy(p); this.group.add(this.beam2);
      const sm = new THREE.SpriteMaterial({ color: 0xfff2d0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, map: glowTexture() });
      this.beamGlow = new THREE.Sprite(sm);
      this.beamGlow.position.copy(p); this.beamGlow.scale.setScalar(9);
      this.group.add(this.beamGlow);
    }
    // --- fog save (weather changes near/far)
    if (rt.stage.scene.fog instanceof THREE.Fog) { const f = rt.stage.scene.fog; this.savedFog = { near: f.near, far: f.far, color: f.color.clone() }; }
    // --- crowd
    const cc = cfg.crowd ?? {};
    if (!cc.off) {
      const nav = new Map<string, NavNode>();
      const pois: Poi[] = [];
      const homes = new Map<string, { p: THREE.Vector3; yaw: number }>();
      for (const [n, o] of nodes) {
        if (/^TOWN_NAV_/.test(n)) nav.set(n, { name: n, p: wp(o), links: String(extras(o).links ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
        else if (/^TOWN_POI_/.test(n)) pois.push({ name: n.slice(9), p: wp(o), yaw: facing(o), kind: String(extras(o).kind ?? 'look'), dwell: Number(extras(o).dwell ?? 6), extras: extras(o) });
        else if (/^TOWN_HOME_/.test(n)) homes.set(String(extras(o).cast ?? n.slice(10)), { p: wp(o), yaw: facing(o) });
      }
      for (const n of nav.values()) for (const l of n.links) { const o = nav.get(l); if (o && !o.links.includes(n.name)) o.links.push(n.name); }
      const room: CrowdRoom = { nav, pois, homes };
      const h = cc.npcHeight ?? (rt.info.avatarHeight ?? 1.5) * 1.08;
      this.crowd = new Crowd(room, this.group, { iconic: cc.iconic ?? [...homes.keys()], townsfolk: cc.townsfolk ?? 14, npcHeight: h, seed: 20250904 });
      const tier = String((rt.opts as unknown as { tier?: string }).tier ?? 'medium');
      this.crowd.lodBias = tier === 'low' ? -1 : tier === 'ultra' ? 1 : 0;
      // the dense detail pass (DETAIL_*_LOD0) is hidden on the low tier
      if (tier === 'low') for (const [n, o] of nodes) if (/^DETAIL_.*LOD0$/.test(n)) o.visible = false;
      const base = rt.info.id;
      TownAssets.load(sceneFileUrl(base, cfg.units ?? 'town/town_units.glb'), sceneFileUrl(base, cfg.anims ?? 'town/town_anims.json'))
        .then((a) => { if (this.crowd && this.rt === rt) this.crowd.setAssets(a); })
        .catch((e) => { this.assetsErr = String((e as Error)?.message ?? e); console.warn('town units', e); });
    }
  }

  // ------------------------------------------------------------------ weather
  private weatherTarget(): Weather {
    if (this.forceWeather) return this.forceWeather;
    const st = this.rt?.state.lights?.state ?? 'show';
    const map: Record<string, Weather> = { preshow: 'storm', show: 'dusk', react: 'dusk', brb: 'fog', outro: 'sunset', ...(this.cfg?.weatherByState ?? {}) };
    return map[st] ?? 'dusk';
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    if (!this.rt) return;
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('town: frame failed', e); }
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt!;
    if (this.manual) this.clock += dt;
    const t = this.now();
    // weather crossfade (≈ 4 s)
    this.weather = this.weatherTarget();
    const k = 1 - Math.exp(-dt / 1.3);
    // a room with scene.json `environment` (src/scene/environment): storm / fog / night come from its time + weather,
    // and it owns the sky tint, the fog and the rain (the lighting state still picks the festival)
    const env = activeEnv()?.townWeather() ?? null;
    const fest = this.weather === 'festival' ? 1 : 0;
    const tgt = env ? { storm: env.storm, fog: env.fog, festival: fest, night: Math.max(env.night, fest) } : { storm: this.weather === 'storm' ? 1 : 0, fog: this.weather === 'fog' ? 1 : this.weather === 'storm' ? 0.45 : 0,
      festival: this.weather === 'festival' ? 1 : 0, night: this.weather === 'festival' || this.weather === 'night' ? 1 : this.weather === 'storm' ? 0.55 : this.weather === 'fog' ? 0.35 : 0 };
    for (const key of ['storm', 'fog', 'festival', 'night'] as const) this.w[key] += (tgt[key] - this.w[key]) * k;
    const storm = this.w.storm;
    // lightning in a storm (deterministic flashes)
    const cyc = Math.floor(t / 7.3);
    const r = fract(Math.sin(cyc * 91.7) * 4375.5);
    const inCyc = t - cyc * 7.3;
    this.flash = env ? env.flash : storm > 0.5 && r < 0.45 ? Math.max(0, 1 - Math.abs(inCyc - 2 - r * 3) * 9) * (inCyc % 0.23 < 0.11 ? 1 : 0.4) * storm : 0;
    try { this.level = gfxBudget().level; } catch { this.level = 'balanced'; }
    const Q = FXQ[this.level] ?? FXQ.balanced;
    this.water?.update(t, storm, this.w.night, this.flash, Q.sea);
    this.wLightT -= dt;
    if (this.water && this.wLightT <= 0 && this.wLights.length) {
      this.wLightT = 0.5;
      const cp = rt.stage.camera.getWorldPosition(tv2);
      const best = [...this.wLights].sort((a, b) => a.p.distanceToSquared(cp) - b.p.distanceToSquared(cp)).slice(0, this.level === 'performance' ? 6 : 14);
      this.water.setLights(best);
    }
    if (this.water && this.ship) {
      const a = this.shipPose(t).p, b = this.shipPose(t - 0.6).p;
      const vx = a.x - b.x, vz = a.z - b.z, sp = Math.hypot(vx, vz) / 0.6;
      this.water.setWake(0, a.x - (vx / (sp * 0.6 || 1)) * 9, a.z - (vz / (sp * 0.6 || 1)) * 9, Math.atan2(vx, vz), Math.min(1, sp / 2.5));
    }
    if (this.crowd) this.crowd.lodBias = this.level === 'performance' ? -1 : this.level === 'ultra' ? 1 : this.level === 'high' ? 0.5 : 0;
    // the unlit sky dome follows the weather (storm grey-blue, night indigo, fog pale), lightning flashes it
    for (const m of this.skyMats) {
      const bm = m as THREE.MeshBasicMaterial;
      if (!bm.color) continue;
      if (env) { if (bm.userData.vtpSkyBase) bm.color.copy(bm.userData.vtpSkyBase as THREE.Color); continue; }   // (the environment tints it)
      if (!bm.userData.vtpSkyBase) bm.userData.vtpSkyBase = bm.color.clone();
      bm.color.copy(bm.userData.vtpSkyBase as THREE.Color)
        .lerp(tmpC.setRGB(0.38, 0.42, 0.52), storm * 0.75)
        .lerp(tmpC.setRGB(0.2, 0.22, 0.4), this.w.night * 0.7)
        .lerp(tmpC.setRGB(0.8, 0.82, 0.86), this.w.fog * 0.45);
      if (this.flash > 0) bm.color.lerp(tmpC.setRGB(1.2, 1.25, 1.4), this.flash * 0.6);
    }
    // fog distance by weather
    const fog = rt.stage.scene.fog;
    if (fog instanceof THREE.Fog && this.savedFog && !env) {
      const f = this.w.fog;
      fog.near = this.savedFog.near * (1 - 0.8 * f);
      fog.far = this.savedFog.far * (1 - 0.72 * f);
      fog.color.copy(this.savedFog.color).lerp(tmpC.set(0x2a3240), this.w.night * 0.6).lerp(tmpC.set(0xd8dde4), this.flash * 0.5);
    }
    // boats ride the swell
    for (const b of this.bobs) {
      const base = b.rest;
      let pos = base;
      let yawQ = b.restQ;
      if (this.ship && b.node === this.ship.node) {
        const s = this.shipPose(t);
        pos = s.p; yawQ = s.q;
      }
      seaAt(pos.x, pos.z, t, storm, ss);
      const h0 = ss.y;
      seaAt(pos.x, pos.z + b.len * 0.5, t, storm, ss); const hf = ss.y;
      seaAt(pos.x, pos.z - b.len * 0.5, t, storm, ss); const hb = ss.y;
      seaAt(pos.x + b.beam * 0.5, pos.z, t, storm, ss); const hr = ss.y;
      seaAt(pos.x - b.beam * 0.5, pos.z, t, storm, ss); const hl = ss.y;
      const k2 = 1 + storm * 1.5;
      b.node.position.set(pos.x, base.y + h0 * (0.85 + b.heave) , pos.z);
      const pitch = Math.atan2(hf - hb, b.len) * (0.6 + b.pitch * 0.25) * k2;
      const roll = Math.atan2(hr - hl, b.beam) * (0.6 + b.roll * 0.25) * k2 + Math.sin(t * 0.7 + base.x) * THREE.MathUtils.degToRad(b.roll * 0.4);
      te.set(-pitch, 0, roll, 'YXZ');
      tq.setFromEuler(te);
      b.node.quaternion.copy(yawQ).multiply(tq);
    }
    // sway (banners, the tavern sign, the crane's load)
    const gust = 0.7 + 0.3 * Math.sin(t * 0.23) + storm * 1.6;
    for (const s of this.sways) {
      const a = THREE.MathUtils.degToRad(s.amp) * gust;
      const w = (2 * Math.PI) / s.period;
      const ax = a * Math.sin(t * w + s.ph) + a * 0.3 * Math.sin(t * w * 2.3 + s.ph * 2);
      const az = s.axis === 'xy' || s.kind === 'pendulum' ? a * 0.7 * Math.sin(t * w * 0.77 + s.ph * 3) : 0;
      if (s.kind === 'flag') te.set(ax * 0.25, a * 2.2 * Math.sin(t * w * 1.3 + s.ph) + a * 0.8, az * 0.3, 'YXZ');
      else te.set(ax, 0, az, 'XYZ');
      tq.setFromEuler(te);
      s.node.quaternion.copy(s.restQ).multiply(tq);
    }
    // gulls, particles, lighthouse, additive cards
    this.gulls?.update(t, storm);
    const cam = rt.stage.camera;
    const px = (rt.stage.renderer.domElement.height || 1080) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const camPos = cam.getWorldPosition(tv);
    for (const f of this.fx) {
      const amt = f.kind === 'rain' ? (env ? 0 : Math.max(0, storm * 1.2 - 0.2)) : f.kind === 'lanterns' ? this.w.festival : f.kind === 'spray' ? 0.5 + 0.5 * storm : f.kind === 'smoke' ? 1 - storm * 0.5 : f.kind === 'flame' ? 1 - storm * 0.3 : 1;
      f.update(t, px, amt * Q.parts, camPos);
    }
    if (this.beam) {
      this.beam.rotation.y = t * 0.45;
      const k = (0.07 + 0.16 * Math.max(this.w.night, this.w.fog, storm * 0.8)) * Q.beam;
      ((this.beam.material as THREE.ShaderMaterial).uniforms.uAmount as THREE.IUniform).value = k;
      if (this.beam2) { this.beam2.rotation.y = t * 0.45; ((this.beam2.material as THREE.ShaderMaterial).uniforms.uAmount as THREE.IUniform).value = k * 1.6; }
      if (this.beamGlow) {
        const ry = t * 0.45, dx = camPos.x - this.beam.position.x, dz = camPos.z - this.beam.position.z, dl = Math.hypot(dx, dz) || 1;
        const facing = Math.max(0, (Math.cos(ry) * dx - Math.sin(ry) * dz) / dl);
        (this.beamGlow.material as THREE.SpriteMaterial).opacity = 0.5 + 0.5 * facing ** 6;
        this.beamGlow.scale.setScalar(9 + 10 * facing ** 6);
      }
    }
    this.halos?.update(t, px, Q.halo * (1 + this.w.night * 0.5 + this.w.festival * 0.3));
    if (this.sheen) ((this.sheen.material as THREE.ShaderMaterial).uniforms.uTime as THREE.IUniform).value = t % 3600;
    for (const o of this.spin) o.rotation.y = (t * 0.35) % (Math.PI * 2);
    for (const c of this.cranes) {
      // a load cycle: hook down at the quay (0-15 %), lift (-30 %), swing out (-50 %), lower into the hold (-65 %), lift empty (-75 %), swing back
      const u = (((t + c.ph) % c.period) + c.period) % c.period / c.period;
      const sw = u < 0.3 ? 0 : u < 0.5 ? smooth((u - 0.3) / 0.2) : u < 0.75 ? 1 : u < 0.95 ? 1 - smooth((u - 0.75) / 0.2) : 0;
      const dn = u < 0.15 ? 1 - smooth(u / 0.08) * 0 : u < 0.3 ? 1 - smooth((u - 0.15) / 0.15) : u < 0.5 ? 0 : u < 0.65 ? smooth((u - 0.5) / 0.15) : u < 0.75 ? 1 - smooth((u - 0.65) / 0.1) : u < 0.95 ? 0 : smooth((u - 0.95) / 0.05);
      tq.setFromAxisAngle(Y, c.yaw * sw);
      c.jib.quaternion.copy(c.restQ).premultiply(tq);
      if (c.hook) c.hook.position.set(c.hookRest.x, c.hookRest.y - c.lift * dn, c.hookRest.z);
      if (c.rope) c.rope.scale.set(1, (c.ropeLen + c.lift * dn) / c.ropeLen, 1);
    }
    if (this.clouds) this.clouds.update(t, 0.45 + storm * 0.5 + this.w.fog * 0.2, this.w.night, storm, this.level === 'performance' ? 3 : this.level === 'balanced' ? 4 : this.level === 'high' ? 5 : 6, this.flash, camPos);
    if (this.sparks && this.crowd) {
      const im = this.crowd.impact;
      this.sparks.update(t - im.t, im.p, px, Q.parts);
    }
    if (this.crowd && this.pendingCheers.length) { this.crowd.cheers.push(...this.pendingCheers); this.pendingCheers = []; }
    if (this.fog2 && this.fogNode) this.fog2.position.set(this.fogRest.x - Math.sin(t * 0.017) * 22, this.fogRest.y + 1.2, this.fogRest.z + Math.sin(t * 0.013) * 8);
    for (const a of this.addMats) {
      if (a.kind === 'rays') a.m.opacity = a.base * (1 - 0.8 * Math.max(storm, this.w.night)) * (0.85 + 0.15 * Math.sin(t * 0.6));
      // fog banks: thicker in fog; in a storm / at night they darken instead of glowing (no white-out)
      else a.m.opacity = a.base * (1 + this.w.fog * 1.4 + storm * 0.15) * (1 - 0.55 * this.w.night) * (1 - 0.45 * storm * (1 - this.w.fog));
    }
    if (this.fogNode) this.fogNode.position.set(this.fogRest.x + Math.sin(t * 0.021) * 18, this.fogRest.y, this.fogRest.z + Math.sin(t * 0.017) * 6);
    // the crowd
    if (this.crowd) {
      const faces: { c: THREE.Vector3; r: number }[] = [];
      for (const a of rt.actors.values()) {
        if (!a.shown || !a.spot) continue;
        const f = a.faceAt(a.spot);
        if (f) faces.push({ c: f.center, r: f.size });
      }
      this.crowd.update(t, cam, faces, dt);
    }
  }

  /** The ship's lane timeline: sail in (0 → 34 %), at anchor (→ 74 %), sail out (→ 100 %, reverse). */
  private shipPose(t: number) {
    const s = this.ship!;
    const u = (t % s.every) / s.every;
    let d: number, dir = 1;
    if (u < 0.34) d = s.len * smooth(u / 0.34);
    else if (u < 0.74) d = s.len;
    else { d = s.len * (1 - smooth((u - 0.74) / 0.26)); dir = -1; }
    const p = laneAt(s.lane, s.cum, d, new THREE.Vector3());
    const p2 = laneAt(s.lane, s.cum, Math.min(s.len, Math.max(0, d + 3 * dir)), new THREE.Vector3());
    let q: THREE.Quaternion;
    if (u >= 0.34 && u < 0.74) q = s.restQ;
    else {
      const yaw = Math.atan2(p2.x - p.x, p2.z - p.z);
      // the hull's bow is its local +Z (Blender -Y)?? — the carrack is built bow = Blender +Y = glTF -Z: yaw + PI
      q = new THREE.Quaternion().setFromAxisAngle(Y, yaw + Math.PI);
      // blend into the anchored heading near the end of the lane
      const near = Math.max(0, 1 - (s.len - d) / 25);
      q.slerp(s.restQ, near * (dir > 0 ? 1 : 1));
    }
    return { p, q };
  }

  /** Support events (donations, subs …) from the page's chat feed: the townsfolk near the camera cheer. The start is the
   *  event's own timestamp + 1.2 s on the town clock, so every page that receives it cheers together. */
  onSupport(evs: { kind?: string; ts?: number }[], snap: boolean) {
    if (snap || !this.rt) return;
    for (const e of evs) {
      if (e.kind !== 'finance' && e.kind !== 'sub' && e.kind !== 'giftSub' && e.kind !== 'membership' && e.kind !== 'raid') continue;
      const ts = typeof e.ts === 'number' && Math.abs(Date.now() - e.ts) < 20000 ? e.ts : Date.now();
      const at = this.manual ? this.clock + 0.5 : ((ts % (DAY * 1000)) / 1000) + 1.2;
      if (!this.pendingCheers.some((c) => Math.abs(c - at) < 3)) this.pendingCheers.push(at);
    }
  }

  info() {
    return { on: !!this.rt, weather: this.weather, w: { ...this.w }, bobs: this.bobs.length, sways: this.sways.length, fx: this.fx.map((f) => f.kind),
      npcs: this.crowd?.agents.length ?? 0, crowd: this.crowd?.stats, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3), err: this.assetsErr };
  }
  debug() { return this.info(); }
}

const Y = new THREE.Vector3(0, 1, 0);
const tmpC = new THREE.Color();
const tv2 = new THREE.Vector3();
function fract(x: number) { return x - Math.floor(x); }
function smooth(x: number) { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); }
function laneAt(lane: THREE.Vector3[], cum: number[], d: number, out: THREE.Vector3) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const k = (d - cum[i - 1]) / Math.max(1e-4, cum[i] - cum[i - 1]);
  return out.lerpVectors(lane[i - 1], lane[i], Math.min(1, Math.max(0, k)));
}
let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const s = 64, d = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const r = Math.hypot(x - s / 2 + 0.5, y - s / 2 + 0.5) / (s / 2);
    const a = Math.max(0, 1 - r) ** 2.2;
    const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(d, s, s, THREE.RGBAFormat); t.needsUpdate = true; glowTex = t;
  return t;
}

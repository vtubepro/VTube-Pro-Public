// Environment engine: time of day + weather + darkness-reactive lights for rooms whose scene.json has an
// `environment` key (docs/SCENES.md → "Environment"). Attached by output.ts next to the town / raid / space layers;
// rooms without the key cost one check per frame.
//
// Layers (what owns what):
//   - The LIGHT SHOW stays authoritative for its fixtures, house level and effects; this provides the base light
//     underneath: the room's own materials are patched once (materials.ts) and driven by uniforms (room light × the
//     time of day, a banded sun with cloud shadows, light pools from lit lanterns, wetness, flashes); the show's
//     house colour / emissive writes are untouched and compose on top.
//   - Performers: the studio's key / fill (hemisphere) / rim lights take the sun / moon colour and dim at night, but
//     never below `performers.minKey / minFill` (faces stay readable) — intensities before the scene update (so the
//     screen-landing dip still works), colours after the show wrote its palette wash (we multiply what it wrote).
//   - Sky: a procedural dome (sky.ts) or the room's own sky meshes (tinted + stars); fog colour follows the horizon.
//   - Rain + splashes (precip.ts), lightning (flashes the sky, the room, the performers; a power dip on lamps after a
//     close strike; `lights.cue('lightning')` for engines that want it), wind (a global uniform + `envWind`).
//
// Sync: a pure function of SceneState.env (host-owned; guests' clocks converted on arrival) + the room config + the
// wall clock. The only page-local state is visual smoothing (hour / 'state'-mode weather glides, lamp ignition fades).
// Test pages: vtpOut.env.scene.manual = true; .clock = <epoch ms>; .force = {hour: 21, weather: 'storm'}.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { DEFAULT_ENV_STATE, WEATHER_PARAMS, envDarkness, envDefaults, envFlashAt, envGust, envHour, envStrikes, envWeatherAt, envWetAt, hash01, isEnvWeather, sanitizeEnvState, sunPath,
  type EnvWeather, type RoomEnvConfig, type SceneEnvState, type WeatherParams } from '../../../shared/environment.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';
import { hazeHook, shaftSources, type ShaftSource } from '../../stage/gfx/shaftSources.ts';
import { skyAt, newSkyLight, luma } from './curves.ts';
import { EU, MAX_DRY, MAX_POOLS, neutralUniforms, patchEnvMaterial } from './materials.ts';
import { NightLights } from './nightLights.ts';
import { Rain, Splashes } from './precip.ts';
import { SkyDome } from './sky.ts';

/** Global wind any system may read (foliage, cloth, town banners, particles): direction × strength (m/s-ish) + gust. */
export const envWind = { x: 0, z: 0, strength: 0, gust: 1, active: false };

type Level = 'performance' | 'balanced' | 'high' | 'ultra';
const BUDGET: Record<Level, { oct: number; rain: number; splash: number; wetQ: number; pools: number }> = {
  performance: { oct: 3, rain: 900, splash: 0, wetQ: 0, pools: 0 },
  balanced: { oct: 4, rain: 2200, splash: 260, wetQ: 0, pools: 4 },
  high: { oct: 5, rain: 4000, splash: 520, wetQ: 2, pools: 8 },
  ultra: { oct: 6, rain: 6500, splash: 800, wetQ: 2, pools: 12 },
};
const SKY_RX = /^(M_)?sky\b|^M_Sky|^GFX_SKY|^SKY_/i;
const FOLIAGE_RX = /foliage|leaf|leaves|grass|fern|palm|frond|bush|shrub|vine|reed|canopy|ivy|moss_?hang/i;
const CLOTH_RX = /cloth|flag|banner|tarp|canvas|curtain|awning|pennant|sail(?!or)/i;

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const wrap24 = (d: number) => ((d % 24) + 36) % 24 - 12;
const tv = new THREE.Vector3(), tc = new THREE.Color(), tc2 = new THREE.Color();

interface StageLightRec { l: THREE.Light; baseI: number; base: THREE.Color; lastC: THREE.Color | null; ground?: { base: THREE.Color; last: THREE.Color | null } }

export class EnvScene {
  private rt: SceneRuntime | null = null;
  private cfg: RoomEnvConfig | null = null;
  private group = new THREE.Group();
  private sky: SkyDome | null = null;
  private rain: Rain | null = null;
  private splash: Splashes | null = null;
  private night = new NightLights();
  private skyMats: THREE.Material[] = [];
  private litMats = 0;
  private swayMats = 0;
  private npcSeen = new WeakSet<THREE.Material>();
  private npcAt = 0;
  private dry: THREE.Box3[] = [];
  private stage: { hemi: StageLightRec | null; key: StageLightRec | null; rim: StageLightRec | null } = { hemi: null, key: null, rim: null };
  private fog: { made: boolean; near: number; far: number; color: THREE.Color; savedNear: number; savedFar: number; savedColor: THREE.Color } | null = null;
  private savedBg: string | null = null;
  private opaqueBg = false;
  private light = newSkyLight();
  private hourS = -1;
  private stateW: WeatherParams | null = null;
  private stateHour: number | null = null;
  private onK = -1;
  private showK = 0;
  private lastNow = 0;
  private lastStrike = 0;
  private dip = 0;
  private shaft: ShaftSource | null = null;
  private perf = { avg: 0, peak: 0 };
  private preMs = 0;
  private skyMix = 0;
  /** the room ships a night light bake (COLOR_1) */
  private hasNightBake = false;
  private cur = { hour: 12, sunEl: 0, dark: 0, wet: 0, rain: 0, flash: 0, weather: null as ReturnType<typeof envWeatherAt> | null, st: DEFAULT_ENV_STATE, level: 'balanced' as Level, fill: 1, key: 1 };
  private sunDir = new THREE.Vector3(0, 1, 0);
  private moonDir = new THREE.Vector3(0, 1, 0);
  /** Test pages: time only advances through pre(); `clock` = epoch ms. */
  manual = false;
  clock = Date.now();
  /** Tests: override parts of the state (e.g. {hour: 21, clock: 'fixed', weather: 'storm', weatherFrom: 'storm'}). */
  force: Partial<SceneEnvState> | null = null;
  /** A room engine's driver (the voyage: hour + weather from its timeline, src/scene/voyage) - pure in `now`, applied
   *  over the host's state and under `force`. null = none. */
  drive: ((now: number) => (Partial<SceneEnvState> & { north?: number }) | null) | null = null;
  /** the drive's compass (deg, the route heading of a walking ship): turns the sun with the world; null = the room's */
  private driveNorth: number | null = null;

  now() { return this.manual ? this.clock : Date.now(); }
  get active() { return !!this.rt; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const cfg = (rt.info as unknown as { environment?: RoomEnvConfig }).environment;
    if (!cfg || typeof cfg !== 'object') return;
    this.rt = rt;
    this.cfg = cfg;
    try { this.build(rt, cfg); } catch (e) { console.warn('environment: build failed', e); }
    active = this;
  }

  detach() {
    const rt = this.rt;
    if (active === this) active = null;
    if (!rt) return;
    neutralUniforms();
    this.night.restoreRealLights();
    for (const s of [this.stage.hemi, this.stage.key, this.stage.rim]) {
      if (!s) continue;
      s.l.intensity = s.baseI;
      if (s.lastC && s.l.color.equals(s.lastC)) s.l.color.copy(s.base);
      if (s.ground && s.ground.last && (s.l as THREE.HemisphereLight).groundColor.equals(s.ground.last)) (s.l as THREE.HemisphereLight).groundColor.copy(s.ground.base);
    }
    this.stage = { hemi: null, key: null, rim: null };
    const f = rt.stage.scene.fog;
    if (this.fog && f instanceof THREE.Fog) {
      if (this.fog.made) rt.stage.scene.fog = null;
      else { f.near = this.fog.savedNear; f.far = this.fog.savedFar; f.color.copy(this.fog.savedColor); }
    }
    this.fog = null;
    if (this.opaqueBg) rt.stage.background = this.savedBg;
    this.sky?.dispose(); this.sky = null;
    this.rain?.dispose(); this.rain = null;
    this.splash?.dispose(); this.splash = null;
    if (this.shaft) { shaftSources.delete(this.shaft); this.shaft = null; }
    hazeHook.fn = null;
    this.group.removeFromParent();
    this.group = new THREE.Group();
    this.night = new NightLights();
    this.skyMats = []; this.dry = []; this.litMats = 0; this.swayMats = 0;
    this.hourS = -1; this.stateW = null; this.stateHour = null; this.onK = -1;
    envWind.active = false;
    this.rt = null; this.cfg = null;
  }

  // ------------------------------------------------------------------ build
  private build(rt: SceneRuntime, cfg: RoomEnvConfig) {
    const room = rt.room;
    const root = room.root;
    root.updateMatrixWorld(true);
    this.group.name = 'vtp:env';
    rt.root.add(this.group);
    // what never gets the room patch: the react screen (OBS hole / capture), skin templates
    const skip = new Set<THREE.Object3D>();
    if (room.screen) skip.add(room.screen.node);
    root.traverse((o) => { if (/_SKIN$/.test(o.name)) skip.add(o); });
    // dry boxes (tents, roofs): ENV_DRY_* meshes (bounds) / empties (scale = half extents, or extras size) + scene.json
    root.traverse((o) => {
      if (!/^ENV_DRY/.test(o.name)) return;
      const m = o as THREE.Mesh;
      let b: THREE.Box3;
      if (m.isMesh) { b = new THREE.Box3().setFromObject(m); m.visible = false; }
      else {
        const c = o.getWorldPosition(new THREE.Vector3());
        const sz = Array.isArray(o.userData.size) && o.userData.size.length === 3 ? new THREE.Vector3(...(o.userData.size as number[]).map(Number)).multiplyScalar(0.5) : o.getWorldScale(new THREE.Vector3());
        b = new THREE.Box3(c.clone().sub(sz), c.clone().add(sz));
      }
      skip.add(o);
      this.dry.push(b);
    });
    for (const a of cfg.dry ?? []) {
      if (!Array.isArray(a) || a.length < 6 || !a.every((v) => Number.isFinite(Number(v)))) continue;
      const p = a.map(Number);
      const b = new THREE.Box3().setFromPoints([root.localToWorld(new THREE.Vector3(p[0], p[1], p[2])), root.localToWorld(new THREE.Vector3(p[3], p[4], p[5]))]);
      this.dry.push(b);
    }
    this.dry = this.dry.slice(0, MAX_DRY);
    EU.uEnvDryN.value = this.dry.length;
    this.dry.forEach((b, i) => { EU.uEnvDryMin.value[i].copy(b.min); EU.uEnvDryMax.value[i].copy(b.max); });
    // night lights + window grids (EMIT_ materials; patched first with their own glow uniforms)
    this.night.build(room, cfg, rt.stage.scene, skip, (rt.state.env?.seed ?? envDefaults(cfg).seed) | 0);
    // every other room material: lit (+ wet on standard, + sway on foliage / cloth), sky meshes: sky
    const fol = [FOLIAGE_RX, ...(cfg.foliage ?? []).map((s) => safeRx(s))].filter((r): r is RegExp => !!r);
    const clo = [CLOTH_RX, ...(cfg.cloth ?? []).map((s) => safeRx(s))].filter((r): r is RegExp => !!r);
    const swayK = Math.max(0, Math.min(3, cfg.sway ?? 1));
    let hasSky = false;
    const seen = new Set<THREE.Material>();
    // night bake (glTF COLOR_1 on every mesh that uses the material): only then may the shader read `color_1`
    const nightGeo = new Set<THREE.Material>(), noNight = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const has = !!mesh.geometry?.getAttribute('color_1') && !!mesh.geometry?.getAttribute('color');
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (has ? nightGeo : noNight).add(m);
    });
    for (const m of noNight) nightGeo.delete(m);
    this.hasNightBake = nightGeo.size > 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (skip.has(p)) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(m) || m.userData.vtpEnv) continue;
        seen.add(m);
        if (SKY_RX.test(m.name) || m.userData.envSky === true) {
          if (patchEnvMaterial(m, { sky: true })) { this.skyMats.push(m); hasSky = true; (m as THREE.MeshBasicMaterial).fog = false; }
          continue;
        }
        const ud = m.userData as Record<string, unknown>;
        const ground = /ground|floor|terrain|path|road|lawn|turf/i.test(m.name);
        const isFol = ud.wind === 'foliage' || (ud.wind !== false && ud.wind !== 'cloth' && !ground && fol.some((r) => r.test(m.name)));
        const isClo = !isFol && (ud.wind === 'cloth' || (ud.wind !== false && !ground && clo.some((r) => r.test(m.name))));
        let sway: { value: THREE.Vector4 } | undefined;
        if ((isFol || isClo) && swayK > 0) {
          const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
          sway = { value: new THREE.Vector4(num(ud.windAmp, isClo ? 0.14 : 0.07) * swayK, num(ud.windHeight, isClo ? 1.4 : 2.6), num(ud.windFreq, isClo ? 2.8 : 1.3), num(ud.windBase, 0)) };
          this.swayMats++;
        }
        if (patchEnvMaterial(m, { lit: true, wet: cfg.wet !== false && !/water|sea|ocean|lake|river|pond|glass/i.test(m.name), sway, night: ud.nightBake === true && nightGeo.has(m) })) this.litMats++;
      }
    });
    // sky: procedural unless the room brings its own
    const skyMode = cfg.sky ?? (hasSky ? 'room' : 'procedural');
    if (skyMode === 'procedural') { this.sky = new SkyDome(); this.group.add(this.sky.mesh); }
    // fog (the colour follows the horizon)
    if (cfg.fog !== false) {
      const amb = rt.info.ambience ?? {};
      const f = rt.stage.scene.fog;
      const near = (cfg.fog && cfg.fog.near) ?? amb.fogNear ?? 40, far = (cfg.fog && cfg.fog.far) ?? amb.fogFar ?? 260;
      if (f instanceof THREE.Fog) this.fog = { made: false, near: f.near, far: f.far, color: f.color.clone(), savedNear: f.near, savedFar: f.far, savedColor: f.color.clone() };
      else if (!f) {
        // the room had no fog: ours (off = pushed out of sight, so the shader programs never change)
        const col = new THREE.Color(amb.fog ?? '#8a96a6');
        rt.stage.scene.fog = new THREE.Fog(col, 1e5, 2e5);
        this.fog = { made: true, near, far, color: col, savedNear: 1e5, savedFar: 2e5, savedColor: col.clone() };
      }
    }
    this.opaqueBg = !!rt.stage.background;
    this.savedBg = rt.stage.background;
    // rain + splashes
    this.rain = new Rain(BUDGET.ultra.rain, 7);
    this.rain.u.uBox.value = Math.max(10, Math.min(60, cfg.rainArea ?? 24));
    this.rain.u.uDryN.value = this.dry.length;
    this.dry.forEach((b, i) => { this.rain!.u.uDryMin.value[i].copy(b.min); this.rain!.u.uDryMax.value[i].copy(b.max); });
    this.group.add(this.rain.mesh);
    this.splash = new Splashes(BUDGET.ultra.splash);
    this.group.add(this.splash.mesh);
    const sp = room.spots.filter((s): s is NonNullable<typeof s> => !!s).map((s) => s.position);
    const area = sp.length ? new THREE.Box3().setFromPoints(sp).expandByVector(new THREE.Vector3(12, 0, 12)) : room.bounds.clone();
    if (!room.bounds.isEmpty()) area.intersect(room.bounds);
    if (!area.isEmpty()) this.splash.scan(room.occluders.filter((m) => !skip.has(m)), area, room.bounds.max.y + 1, this.dry);
    // performers' studio lights
    const find = (pred: (l: THREE.Light) => boolean) => rt.stage.scene.children.find((o) => (o as THREE.Light).isLight && !o.name.startsWith('vtp:') && pred(o as THREE.Light)) as THREE.Light | undefined;
    const rec = (l: THREE.Light | undefined): StageLightRec | null => l ? { l, baseI: l.intensity, base: l.color.clone(), lastC: null, ...((l as THREE.HemisphereLight).isHemisphereLight ? { ground: { base: (l as THREE.HemisphereLight).groundColor.clone(), last: null } } : {}) } : null;
    this.stage = { hemi: rec(find((l) => !!(l as THREE.HemisphereLight).isHemisphereLight)), key: rec(rt.stage.keyLight), rim: rec(rt.stage.rimLight) };
    // god rays (Ultra's light shafts): the sun as a shaft source
    this.shaft = (cam) => this.sunShaft(cam);
    shaftSources.add(this.shaft);
    // High / Ultra haze: the fog's colour, thinner at night, thicker in fog / rain
    hazeHook.fn = (hz) => {
      const on = Math.max(0, this.onK);
      if (on <= 0.01) return;
      const f = this.rt?.stage.scene.fog;
      const w = this.cur.weather?.params;
      const day = this.light.day;
      if (f instanceof THREE.Fog) hz.color.lerp(f.color, on);
      const k = (0.35 + 0.65 * day) * (1 + 1.5 * (w?.fog ?? 0) + 0.6 * (w?.rain ?? 0));
      hz.density *= 1 + (k - 1) * on;
      hz.glow *= 1 + ((0.25 + 0.75 * day) - 1) * on;
    };
    // pre-warm every program (hidden rain / splash / sky would otherwise compile the first time it rains)
    const vis = [this.rain.mesh.visible, this.splash.mesh.visible];
    this.rain.mesh.visible = this.splash.mesh.visible = true;
    try { rt.stage.renderer.compile(rt.stage.scene, rt.stage.camera); } catch { /* optional */ }
    [this.rain.mesh.visible, this.splash.mesh.visible] = vis;
  }

  /** NPC materials (town crowd, raid) join the room light when they appear (1 Hz scan; one compile per new program). */
  private scanNpcs() {
    const rt = this.rt!;
    for (const c of rt.root.children) {
      if (!/^vtp:(town|raid:)/.test(c.name)) continue;
      c.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material || (mesh as unknown as THREE.Points).isPoints) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (this.npcSeen.has(m)) continue;
          this.npcSeen.add(m);
          if ((m as THREE.MeshBasicMaterial).isMeshBasicMaterial || m.blending === THREE.AdditiveBlending || m.transparent) continue;
          patchEnvMaterial(m, { lit: true });
        }
      });
    }
  }

  // ------------------------------------------------------------------ state
  /** The state in effect (host's SceneState.env, else the room's defaults) + test overrides. */
  state(): SceneEnvState {
    const base = envDefaults(this.cfg);
    let s = this.rt?.state.env ? sanitizeEnvState(this.rt.state.env, base) : base;
    const d = this.drive ? this.drive(this.now()) : null;
    this.driveNorth = d && typeof d.north === 'number' && Number.isFinite(d.north) ? d.north : null;
    if (d) s = sanitizeEnvState({ ...s, ...d }, s);
    return this.force ? sanitizeEnvState({ ...s, ...this.force }, s) : s;
  }

  // ------------------------------------------------------------------ frame
  /** Before the scene update: time, weather, every uniform, the performers' light intensities. */
  pre(dt: number) {
    if (!this.rt) return;
    const t0 = performance.now();
    try { this.step(dt); } catch (e) { console.warn('environment: frame failed', e); }
    this.preMs = performance.now() - t0;
  }

  /** After the scene update (camera placed, the light show wrote its lights): camera-bound parts + colours. */
  post(dt: number) {
    if (!this.rt) return;
    const t0 = performance.now();
    try { this.after(dt); } catch (e) { console.warn('environment: post failed', e); }
    const ms = performance.now() - t0 + this.preMs;
    this.perf.avg += (ms - this.perf.avg) * 0.05;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt!, cfg = this.cfg!;
    if (this.manual) this.clock += dt * 1000;
    const now = this.now();
    const st = this.state();
    const lightState = rt.state.lights?.state ?? 'show';
    const safe = rt.state.lights?.safe !== false;
    // on / off crossfade (1.5 s)
    const onT = st.on ? 1 : 0;
    this.onK = this.onK < 0 ? onT : this.onK + (onT - this.onK) * (1 - Math.exp(-dt / 0.5));
    const on = this.onK;
    // time (smoothed only across jumps — the slider, a clock change)
    let hour = envHour(st, now);
    const hs = st.weatherMode === 'state' && st.clock === 'fixed' ? cfg.hourByState?.[lightState] : undefined;
    if (typeof hs === 'number' && Number.isFinite(hs)) hour = hs;
    this.hourS = this.hourS < 0 ? hour : (this.hourS + wrap24(hour - this.hourS) * (1 - Math.exp(-dt / 0.6)) + 24) % 24;
    const H = this.hourS;
    const sp = sunPath(H, this.driveNorth === null ? cfg : { ...cfg, north: this.driveNorth });
    const dirOf = (el: number, az: number, out: THREE.Vector3) => out.set(Math.sin(az) * Math.cos(el * Math.PI / 180), Math.sin(el * Math.PI / 180), Math.cos(az) * Math.cos(el * Math.PI / 180)).normalize();
    dirOf(sp.el, sp.az, this.sunDir);
    dirOf(sp.moonEl, sp.moonAz, this.moonDir);
    // weather
    const stateW: EnvWeather | null = st.weatherMode === 'state' ? (cfg.weatherByState?.[lightState] ?? (isEnvWeather(cfg.weatherByState?.show) ? cfg.weatherByState!.show : st.weather)) : null;
    const wn = envWeatherAt(st, cfg, now, stateW);
    let w = wn.params;
    if (st.weatherMode === 'state') {
      // lighting-state changes carry no timestamp: glide locally (~4 s)
      if (!this.stateW) this.stateW = { ...w };
      else { const k = 1 - Math.exp(-dt / 1.6); for (const key of Object.keys(w) as (keyof WeatherParams)[]) this.stateW[key] += (w[key] - this.stateW[key]) * k; }
      w = this.stateW;
    } else this.stateW = null;
    w = { ...w, wind: w.wind * st.wind, bolt: st.lightning ? w.bolt : 0 };
    const wet = st.weatherMode === 'state' ? w.wet : envWetAt(wn, now);
    // lightning
    const strikes = envStrikes(st.seed, now, w.bolt, safe);
    const fl = envFlashAt(strikes, now, safe);
    for (const s of strikes) if (s.near && s.at > this.lastNow && s.at <= now && s.at !== this.lastStrike) {
      this.lastStrike = s.at;
      this.dip = 1;
      try { (rt.lights as unknown as { cue?: (w: string) => void }).cue?.('lightning'); } catch { /* optional hook */ }
    }
    this.lastNow = now;
    this.dip = Math.max(0, this.dip - dt / 0.55);
    // sky light for this moment, and for the room's reference moment (its authored look: bakedAt, clear)
    const nightLv = Math.min(0.6, Math.max(0.05, cfg.night ?? 0.2));
    const L = skyAt(sp.el, sp.moonEl, w, nightLv, this.light);
    const R = this.reference(cfg, nightLv);
    const dark = envDarkness(sp.el, w.dark);
    const flash = fl.f * on;
    const lvl = this.level();
    const B = BUDGET[lvl];
    const tSec = (now / 1000) % 86400;
    // ---- performers (studio lights): dim + tint relative to the reference, clamped so faces never go dark
    const pl = cfg.performers ?? {};
    const minKey = Math.min(1, Math.max(0.3, pl.minKey ?? 0.62)), minFill = Math.min(1, Math.max(0.3, pl.minFill ?? 0.55));
    const pf = perfLevels(L.ambient);
    const fillN = Math.min(1.15, Math.max(minFill, pf.fill / R.fill)), keyN = Math.min(1.15, Math.max(minKey, pf.key / R.keyL));
    const fill = 1 + (fillN - 1) * on, key = 1 + (keyN - 1) * on;
    this.cur.fill = fill; this.cur.key = key;
    const S = this.stage;
    if (S.hemi) S.hemi.l.intensity = S.hemi.baseI * (fill + flash * 0.9);
    if (S.key) S.key.l.intensity = S.key.baseI * (key + flash * 0.6);
    if (S.rim) S.rim.l.intensity = S.rim.baseI * (1 + (0.95 + 0.25 * (1 - L.day) - 1) * on + flash * 0.5);
    // ---- the room: its reflected light x (light now / light at the reference) x (reference stage / stage now)
    const ex = Math.max(0.2, Math.min(3, cfg.exposure ?? 1)) * (cfg.bakedAt === undefined ? 0.92 : 1);
    const stageK = 0.62 * fillN + 0.38 * keyN;
    const lit = EU.uEnvLit.value;
    lit.set(L.ambient.r / R.amb.r, L.ambient.g / R.amb.g, L.ambient.b / R.amb.b).multiplyScalar(ex / stageK);
    lit.set(Math.min(1.6, lit.x), Math.min(1.6, lit.y), Math.min(1.6, lit.z));
    lit.set(1 + (lit.x - 1) * on, 1 + (lit.y - 1) * on, 1 + (lit.z - 1) * on);
    // sun (or the moon) as a banded directional term + drifting cloud shadows
    const sunK = Math.max(0, Math.min(2, cfg.sun ?? 1));
    const sunA = L.sunI * 0.62 * sunK, moonA = L.moonI * 0.16 * sunK;
    if (sunA >= moonA) { EU.uEnvSunDir.value.copy(this.sunDir); tc.copy(L.sun).multiplyScalar(sunA * ex * on); }
    else { EU.uEnvSunDir.value.copy(this.moonDir); tc.copy(L.moon).multiplyScalar(moonA * ex * on); }
    EU.uEnvSunCol.value.set(tc.r, tc.g, tc.b);
    // wind (deterministic direction drift + gusts)
    const wAng = hash01(st.seed, 3, 1) * Math.PI * 2 + 0.5 * Math.sin(tSec / 420);
    const gust = envGust(st.seed, now);
    const ws = w.wind * gust * on;
    envWind.x = Math.sin(wAng) * ws * 3; envWind.z = Math.cos(wAng) * ws * 3; envWind.strength = ws; envWind.gust = gust; envWind.active = on > 0.01;
    EU.uEnvWind.value.set(envWind.x * 0.33, gust, envWind.z * 0.33);
    const drift = (tSec % 3600) * (1.5 + 3 * w.wind);
    EU.uEnvCloudSh.value.set(Math.sin(wAng) * drift, Math.cos(wAng) * drift, 0.55 * smooth(0.12, 0.5, w.cloud) * (1 - smooth(0.8, 1, w.cloud) * 0.5) * on, 1 / 26);
    EU.uEnvT.value = tSec % 3600;
    EU.uEnvFlash.value.set(0.75, 0.8, 1.0).multiplyScalar(flash * 0.9);
    EU.uEnvWet.value = wet * on * (cfg.wet === false ? 0 : 1);
    EU.uEnvWetQ.value = B.wetQ;
    EU.uEnvPuddle.value = Math.min(0.9, Math.max(0, cfg.puddles ?? 0.35));
    EU.uEnvRain.value = w.rain * on;
    EU.uEnvDark.value = on > 0.5 ? dark : 0;
    EU.uEnvLate.value = smooth(22.5, 26, H < 12 ? H + 24 : H) * (1 - smooth(4, 5.5, H < 12 ? H : 0));
    EU.uEnvGridOn.value = on > 0.5 ? 1 : 0;
    EU.uEnvNight.value = this.hasNightBake ? smooth(0.1, 0.8, dark) * on : 0;
    // room skies: the sky's colour now / at the reference (night falls on a painted sky too), stars, flashes
    tc.copy(L.horizon).lerp(L.zenith, 0.5);
    // a painted sky keeps its own colours near the reference moment (brightness × the luminance ratio) and blends towards
    // the real sky colours the further the moment is from it (noon blue on a dusk painting, a slate storm, night)
    const lr = Math.min(1.3, Math.max(0.03, luma(tc) / Math.max(0.004, luma(R.sky))));
    const diff = Math.abs(tc.r - R.sky.r) + Math.abs(tc.g - R.sky.g) + Math.abs(tc.b - R.sky.b);
    const skyMix = Math.min(0.92, Math.max(diff * 9, (w.cloud - 0.3) * 1.3, w.fog * 0.9)) * on;
    this.skyMix = skyMix;
    EU.uEnvSkyTint.value.setScalar(1 + (lr - 1) * on);
    EU.uEnvSkyHor.value.set(L.horizon.r, L.horizon.g, L.horizon.b);
    EU.uEnvSkyZen.value.set(L.zenith.r, L.zenith.g, L.zenith.b);
    EU.uEnvSkyMix.value = skyMix;
    EU.uEnvStars.value = L.stars * on;
    EU.uEnvSkyFlash.value.set(0.55, 0.6, 0.75).multiplyScalar(flash * 0.8);
    // procedural sky dome
    if (this.sky) {
      const u = this.sky.u;
      this.sky.mesh.visible = on > 0.01;
      u.uZenith.value.copy(L.zenith); u.uHorizon.value.copy(L.horizon); u.uGround.value.copy(L.horizon).multiplyScalar(0.35);
      u.uSunDir.value.copy(this.sunDir); u.uSunCol.value.copy(L.sun); u.uSunVis.value = smooth(-3, 1, sp.el) * (1 - w.cloud * 0.85) * (1 - w.fog * 0.7);
      u.uMoonDir.value.copy(this.moonDir); u.uMoonVis.value = smooth(-2, 3, sp.moonEl) * (1 - L.day * 0.7) * (1 - w.cloud * 0.85) * (1 - w.fog * 0.8);
      u.uMoonCol.value.setRGB(0.82, 0.87, 1).multiplyScalar(0.6 + 0.4 * (1 - L.day));
      u.uStars.value = L.stars; u.uT.value = tSec % 3600;
      u.uCloud.value = w.cloud; u.uCloudDark.value = w.cloudDark; u.uCloudLit.value.copy(L.cloudLit); u.uCloudShade.value.copy(L.cloudShade);
      u.uDrift.value.set(Math.sin(wAng), Math.cos(wAng)).multiplyScalar((tSec % 7200) * (0.0022 + 0.004 * w.wind));
      u.uOct.value = B.oct;
      u.uFlash.value = flash; u.uFlashDir.value.set(Math.sin(fl.az), 0.25, Math.cos(fl.az)).normalize();
      u.uHaze.value = Math.min(1, w.fog * 0.9 + w.rain * 0.25); u.uHazeCol.value.copy(L.horizon);
      u.uAlpha.value = Math.min(1, on * 1.5);
    }
    // fog: colour ← the horizon, distance ← the weather
    const f = rt.stage.scene.fog;
    if (this.fog && f instanceof THREE.Fog) {
      const tint = cfg.fog && typeof cfg.fog.tint === 'number' ? Math.min(1, Math.max(0, cfg.fog.tint)) : this.sky ? 0.85 : 0.25;
      const fogAmt = Math.min(1, w.fog + w.rain * 0.35);
      // the authored fog colour x (horizon now / at the reference), pulled towards the real horizon (seamless with the dome)
      tc.copy(this.fog.color).multiplyScalar(Math.min(1.4, luma(L.horizon) / Math.max(0.004, luma(R.hor))))
        .lerp(L.horizon, Math.max(tint, this.skyMix * 0.8)).lerp(tc2.setRGB(0.55, 0.6, 0.68).multiplyScalar(0.2 + 0.8 * L.day), w.fog * 0.5);
      tc.lerp(tc2.setRGB(0.7, 0.75, 0.9), flash * 0.3);
      f.color.copy(this.fog.savedColor).lerp(tc, on);
      const nearW = this.fog.near * (1 - 0.94 * fogAmt), farW = Math.max(nearW + 6, this.fog.far * (1 - 0.82 * fogAmt));
      f.near = this.fog.savedNear + (nearW - this.fog.savedNear) * on;
      f.far = this.fog.savedFar + (farW - this.fog.savedFar) * on;
    }
    if (this.opaqueBg) rt.stage.background = on > 0.5 ? `#${L.horizon.getHexString()}` : this.savedBg;
    // night lights (the show owns them in effects looks)
    const owns = cfg.showOwnsNightLights ?? ['preshow', 'outro'];
    this.showK += ((owns.includes(lightState) ? 1 : 0) - this.showK) * (1 - Math.exp(-dt / 0.8));
    this.night.update(dt, on > 0.5 ? dark : 0, tSec, on > 0.5, this.showK, this.dip * smooth(0.3, 0.6, dark));
    // NPC materials
    if (now - this.npcAt > 1000 || now < this.npcAt) { this.npcAt = now; this.scanNpcs(); }
    this.splash?.step();
    this.cur = { hour: H, sunEl: sp.el, dark, wet, rain: w.rain * on, flash, weather: wn, st, level: lvl, fill, key };
  }

  private after(dt: number) {
    const rt = this.rt!;
    const on = Math.max(0, this.onK);
    const L = this.light;
    const cam = rt.stage.camera;
    const camPos = cam.getWorldPosition(tv);
    const B = BUDGET[this.cur.level];
    // performers' light colours: multiply what the light show wrote this frame (its palette wash) — or, if nothing
    // rewrote them since our last frame, our remembered base
    const T = perfTints(L, this.cur.sunEl, this.tints);
    const R = this.ref!;
    const rel = (c: THREE.Color, r: THREE.Color, out: THREE.Color) => out.setRGB(1 + (Math.min(1.3, c.r / r.r) - 1) * on, 1 + (Math.min(1.3, c.g / r.g) - 1) * on, 1 + (Math.min(1.3, c.b / r.b) - 1) * on);
    const S = this.stage;
    const tintLight = (s: StageLightRec | null, t: THREE.Color, gt?: THREE.Color) => {
      if (!s) return;
      if (!s.lastC || !s.l.color.equals(s.lastC)) s.base.copy(s.l.color);
      s.l.color.copy(s.base).multiply(t);
      (s.lastC ??= new THREE.Color()).copy(s.l.color);
      const hl = s.l as THREE.HemisphereLight;
      if (s.ground && gt) {
        if (!s.ground.last || !hl.groundColor.equals(s.ground.last)) s.ground.base.copy(hl.groundColor);
        hl.groundColor.copy(s.ground.base).multiply(gt);
        (s.ground.last ??= new THREE.Color()).copy(hl.groundColor);
      }
    };
    tintLight(S.hemi, rel(T.hemi, R.tints.hemi, this.tmpA), rel(T.ground, R.tints.ground, this.tmpB));
    tintLight(S.key, rel(T.key, R.tints.key, this.tmpA));
    tintLight(S.rim, rel(T.rim, R.tints.rim, this.tmpA));
    // night bake: undo what the stage lights did to the room light (dimmer, moon-tinted) - the bake IS the lamps' light
    if (this.hasNightBake) {
      const h = rel(T.hemi, R.tints.hemi, this.tmpA), k = rel(T.key, R.tints.key, this.tmpB);
      const f = this.cur.fill, kk = this.cur.key;
      const g = (a: number, b: number) => Math.min(3, Math.max(0.5, 1 / Math.max(0.05, 0.62 * a * f + 0.38 * b * kk)));
      const gr = g(h.r, k.r), gg = g(h.g, k.g), gb = g(h.b, k.b), lum = 0.3 * gr + 0.59 * gg + 0.11 * gb;
      const sc = Math.min(1, 0.85 / lum);     // undo the moonlight tint fully, the dimming only partly (night stays night)
      EU.uEnvNightGain.value.set(gr * sc, gg * sc, gb * sc);
    }
    // the show's real lights of night fixtures
    this.night.scaleRealLights();
    // light pools around the camera
    this.night.pools(camPos, on > 0.5 ? B.pools : 0, dt, this.now(), 1.3);
    // rain / splashes follow the camera
    if (this.rain) {
      const r = this.cur.rain;
      this.rain.count = r > 0.01 ? B.rain * Math.min(1, r * 1.1) : 0;
      const u = this.rain.u;
      u.uCam.value.copy(camPos); u.uT.value = EU.uEnvT.value;
      u.uFall.value = 8 + 3.5 * r; u.uLen.value = 0.32 + 0.55 * r; u.uWidth.value = 0.011 + 0.006 * r;
      u.uWindV.value.set(envWind.x * 0.9, 0, envWind.z * 0.9);
      const la = Math.min(1, luma(L.ambient));
      u.uCol.value.setRGB(0.62, 0.67, 0.75).multiplyScalar(0.3 + 0.7 * la).lerp(tc.setRGB(0.9, 0.93, 1), this.cur.flash * 0.6);
      u.uAlpha.value = (0.24 + 0.26 * r) * (0.6 + 0.4 * la);
    }
    if (this.splash) {
      const r = this.cur.rain;
      this.splash.count = r > 0.05 ? B.splash * Math.min(1, r * 1.2) : 0;
      this.splash.u.uT.value = EU.uEnvT.value; this.splash.u.uRate.value = 1.2 + 1.4 * r;
      this.splash.u.uAlpha.value = 0.35 + 0.3 * r;
      this.splash.u.uCol.value.copy(this.rain?.u.uCol.value ?? tc.setRGB(0.8, 0.84, 0.9));
    }
  }

  private ref: { key: string; amb: THREE.Color; sky: THREE.Color; hor: THREE.Color; fill: number; keyL: number; tints: Tints } | null = null;
  private tints: Tints = newTints();
  private tmpA = new THREE.Color(); private tmpB = new THREE.Color();
  /** The room's reference moment (scene.json bakedAt, clear sky; default noon): what "as authored" means. */
  private reference(cfg: RoomEnvConfig, nightLv: number) {
    const h = typeof cfg.bakedAt === 'number' && Number.isFinite(cfg.bakedAt) ? cfg.bakedAt : 13;
    const k = `${h}|${nightLv}|${cfg.sunrise}|${cfg.sunset}|${cfg.noonElevation}`;
    if (this.ref?.key === k) return this.ref;
    const sp = sunPath(h, cfg);
    const L = skyAt(sp.el, sp.moonEl, WEATHER_PARAMS.clear, nightLv, newSkyLight());
    const pf = perfLevels(L.ambient);
    const lift = (c: THREE.Color) => c.setRGB(Math.max(0.02, c.r), Math.max(0.02, c.g), Math.max(0.02, c.b));
    this.ref = { key: k, amb: lift(L.ambient.clone()), sky: lift(L.horizon.clone().lerp(L.zenith, 0.5)), hor: lift(L.horizon.clone()), fill: pf.fill, keyL: pf.key, tints: perfTints(L, sp.el, newTints()) };
    return this.ref;
  }

  private level(): Level {
    const tier = String((this.rt?.opts as unknown as { tier?: string } | undefined)?.tier ?? 'high');
    const l = gfxBudget().level as Level;
    return tier === 'low' ? 'performance' : (l in BUDGET ? l : 'balanced');
  }

  /** Ultra's light shafts: the sun, when it's on screen and not behind thick cloud. */
  private sunShaft(cam: THREE.PerspectiveCamera) {
    if (!this.rt || this.onK < 0.5 || this.cur.sunEl < -1) return [];
    const vis = (this.sky?.u.uSunVis.value ?? 0) * (1 - (this.cur.weather?.params.cloud ?? 0) * 0.8);
    if (vis < 0.08) return [];
    const p = tv.copy(cam.position).addScaledVector(this.sunDir, 500).project(cam);
    if (p.z > 1 || Math.abs(p.x) > 1.25 || Math.abs(p.y) > 1.25) return [];
    return [{ x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, w: vis * (0.7 + 0.5 * (1 - smooth(8, 35, this.cur.sunEl))) }];
  }

  // ------------------------------------------------------------------ hooks for other layers
  /** The town engine (Kingsmarch) takes its storm / fog / night from here and leaves the sky, fog + rain to us. */
  townWeather() {
    if (!this.rt || this.onK < 0.5) return null;
    const w = this.cur.weather?.params;
    const p = w ?? WEATHER_PARAMS.clear;
    return { storm: Math.min(1, p.bolt * 0.6 + p.rain * 0.5 + p.cloudDark * 0.2), fog: p.fog, night: Math.min(1, this.cur.dark * 1.05), flash: this.cur.flash, rain: this.cur.rain, wind: envWind.strength };
  }

  info() {
    const c = this.cur, w = c.weather;
    return {
      on: !!this.rt, enabled: this.onK > 0.5, hour: +c.hour.toFixed(3), clock: c.st.clock, speed: c.st.speed, sunEl: +c.sunEl.toFixed(1),
      weather: w ? { from: w.from, to: w.to, k: +w.k.toFixed(2), next: w.next ? Math.max(0, Math.round((w.next - this.now()) / 1000)) : null, mode: c.st.weatherMode } : null,
      darkness: +c.dark.toFixed(3), wet: +c.wet.toFixed(2), rain: this.rain?.count ?? 0, splashes: { found: this.splash?.found ?? 0, shown: this.splash ? (this.splash.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0, scanning: this.splash?.scanning ?? false },
      flash: +c.flash.toFixed(2), level: c.level, performers: { key: +c.key.toFixed(2), fill: +c.fill.toFixed(2) },
      night: { lit: this.night.lit, total: this.night.entries.filter((e) => !e.follow).length, pools: EU.uEnvPoolN.value, windows: this.night.grids.map((g) => `${g.group}×${g.mats.length}`) },
      materials: { lit: this.litMats, sky: this.skyMats.length, sway: this.swayMats }, sky: this.sky ? 'procedural' : this.skyMats.length ? 'room' : 'none', dry: this.dry.length,
      ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
  debug() { return this.info(); }
}

interface Tints { hemi: THREE.Color; ground: THREE.Color; key: THREE.Color; rim: THREE.Color }
const newTints = (): Tints => ({ hemi: new THREE.Color(), ground: new THREE.Color(), key: new THREE.Color(), rim: new THREE.Color() });
const MOON_KEY = new THREE.Color(0.7, 0.8, 1), GOLD_RIM = new THREE.Color(1, 0.72, 0.45), MOON_RIM = new THREE.Color(0.62, 0.75, 1.1);
/** Raw performer light levels for a room light (before the reference + clamps). */
function perfLevels(amb: THREE.Color) { const la = Math.min(1, luma(amb)); return { fill: 0.36 + 0.64 * la, key: 0.42 + 0.58 * la }; }
/** Raw performer light colours: fill takes the room light's hue, key the sun (golden hours) / the moon, rim gold / blue. */
function perfTints(L: ReturnType<typeof newSkyLight>, sunEl: number, out: Tints): Tints {
  const an = tc.copy(L.ambient).multiplyScalar(1 / Math.max(0.05, luma(L.ambient)));
  out.hemi.setRGB(1, 1, 1).lerp(an, 0.42);
  out.ground.setRGB(1, 1, 1).lerp(tc2.copy(an).multiplyScalar(0.85), 0.4);
  out.key.setRGB(1, 1, 1);
  if (L.sunI > 0.02) out.key.lerp(tc2.copy(L.sun).multiplyScalar(1 / Math.max(0.1, Math.max(L.sun.r, L.sun.g, L.sun.b))), 0.32 * L.sunI * (1 - smooth(25, 55, sunEl) * 0.6));
  out.key.lerp(MOON_KEY, 0.4 * (1 - L.day));
  out.rim.setRGB(1, 1, 1);
  if (L.sunI > 0.02) out.rim.lerp(GOLD_RIM, 0.5 * L.sunI * (1 - smooth(8, 30, sunEl)));
  out.rim.lerp(MOON_RIM, 0.5 * (1 - L.day));
  return out;
}

export type EnvInfo = ReturnType<EnvScene['info']>;

let active: EnvScene | null = null;
/** The environment of the room on this page (null = the room doesn't use one). */
export function activeEnv(): EnvScene | null { return active; }

function safeRx(s: string): RegExp | null { try { return new RegExp(s, 'i'); } catch { return null; } }
export { MAX_POOLS };

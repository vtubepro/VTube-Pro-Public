// Desert light for a moment: (hour, storm, cloud, heading) -> sun / moon / sky / haze / fog values. Built on the
// environment engine's own sun path + sky curves (shared/environment.ts sunPath, environment/curves.ts skyAt), so a
// room whose environment runs at the same hour shows the same sun on the deck and on the sand. Pure: same inputs,
// same numbers on every page.
//   Frames: "world" = the desert (terrain-local axes are world axes); the sun is fixed in the world and the route
//   heading turns it in the room. envNorthDeg() is the value to give the room's environment config (north) so the
//   deck's sun matches.
import * as THREE from 'three';
import { WEATHER_PARAMS, envDarkness, sunPath, type RoomEnvConfig, type WeatherParams } from '../../../shared/environment.ts';
import { stormVisibility } from '../../../shared/desert/sky.ts';
import { luma, newSkyLight, skyAt, type SkyLight } from '../environment/curves.ts';

export interface DesertLightIn {
  hour: number;
  /** 0 clear .. 1 inside a sandstorm */
  storm: number;
  /** extra cloud cover 0..1 (cloudy weather) */
  cloud?: number;
  /** compass of the desert (deg): yaw of north about +Y from world -Z (the environment's `north`) */
  north?: number;
  sunrise?: number;
  sunset?: number;
  noonElevation?: number;
}

export interface DesertLight {
  sunEl: number; moonEl: number;
  /** directions in the world (terrain-local) frame */
  sunW: THREE.Vector3; moonW: THREE.Vector3; keyW: THREE.Vector3;
  /** key light colour x intensity (sun by day, moon by night), linear */
  key: THREE.Color;
  zenith: THREE.Color; horizon: THREE.Color;
  skyAmb: THREE.Color; gndAmb: THREE.Color;
  hazeCol: THREE.Color; hazeSun: THREE.Color;
  dust: THREE.Color;
  /** aerial perspective: density at the ground (1/m), height falloff (m) */
  fogD: number; fogH: number;
  day: number; dark: number; stars: number; sunVis: number; moonVis: number;
  sunCol: THREE.Color;
  /** mirage strength (high sun, clear) */
  mirage: number;
  sky: SkyLight;
}

export function newDesertLight(): DesertLight {
  return {
    sunEl: 0, moonEl: 0, sunW: new THREE.Vector3(0, 1, 0), moonW: new THREE.Vector3(0, 1, 0), keyW: new THREE.Vector3(0, 1, 0), key: new THREE.Color(),
    zenith: new THREE.Color(), horizon: new THREE.Color(), skyAmb: new THREE.Color(), gndAmb: new THREE.Color(), hazeCol: new THREE.Color(), hazeSun: new THREE.Color(),
    dust: new THREE.Color(), fogD: 2e-4, fogH: 200, day: 1, dark: 0, stars: 0, sunVis: 1, moonVis: 0, sunCol: new THREE.Color(), mirage: 0, sky: newSkyLight(),
  };
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const tc = new THREE.Color(), tc2 = new THREE.Color();
const DUST = new THREE.Color('#c08a52');
const DESERT_HOR = new THREE.Color('#ead2ae');
const HAZE = new THREE.Color('#dcb98e');
const NIGHT_SAND = new THREE.Color('#5d6a9a');

const dirOf = (el: number, az: number, out: THREE.Vector3) => out.set(Math.sin(az) * Math.cos((el * Math.PI) / 180), Math.sin((el * Math.PI) / 180), Math.cos(az) * Math.cos((el * Math.PI) / 180)).normalize();

/** The voyage room environment's sun path (the walking-ship SPEC 3.5 / Appendix A: sunrise 6.2, sunset 19.0, noon 68 deg).
 *  The desert's sun MUST run on the same numbers as the room environment's, or the deck and the sand are lit by two
 *  different suns: DesertWorld takes the room's values (DesertOptions / setSunPath) and these are only the default. */
export const DESERT_SUN = { sunrise: 6.2, sunset: 19.0, noonElevation: 68 } as const;

/** The desert's sun path config (the room environment's sunrise / sunset / noon elevation; DESERT_SUN by default). */
export function desertEnvCfg(i: DesertLightIn): RoomEnvConfig {
  const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  return { north: i.north ?? 0, sunrise: ok(i.sunrise) ? i.sunrise : DESERT_SUN.sunrise, sunset: ok(i.sunset) ? i.sunset : DESERT_SUN.sunset, noonElevation: ok(i.noonElevation) ? i.noonElevation : DESERT_SUN.noonElevation };
}

export function desertLight(i: DesertLightIn, out: DesertLight = newDesertLight()): DesertLight {
  const s = Math.min(1, Math.max(0, i.storm));
  const cfg = desertEnvCfg(i);
  const sp = sunPath(((i.hour % 24) + 24) % 24, cfg);
  out.sunEl = sp.el; out.moonEl = sp.moonEl;
  dirOf(sp.el, sp.az, out.sunW);
  dirOf(sp.moonEl, sp.moonAz, out.moonW);
  const cloud = Math.min(1, Math.max(0, i.cloud ?? 0));
  const w: WeatherParams = { ...WEATHER_PARAMS.clear, cloud: Math.max(WEATHER_PARAMS.clear.cloud * 0.5, cloud, s * 0.45), cloudDark: 0.15 * s, dark: 0.12 * cloud + 0.4 * s };
  const L = skyAt(sp.el, sp.moonEl, w, 0.22, out.sky);
  const day = L.day;
  out.day = day;
  out.dark = envDarkness(sp.el, w.dark);
  // ---- sky colours: desert horizons are pale and dusty by day
  out.zenith.copy(L.zenith);
  out.horizon.copy(L.horizon).lerp(tc.copy(DESERT_HOR).multiplyScalar(Math.max(0.05, luma(L.horizon) / luma(DESERT_HOR))), 0.45 * day * smooth(4, 20, sp.el));
  // ---- key light
  out.sunCol.copy(L.sun);
  const sunI = L.sunI * (1 - 0.85 * s);
  const moonI = L.moonI * (1 - 0.9 * s);
  if (sunI * 1.0 >= moonI * 0.2) { out.keyW.copy(out.sunW); out.key.copy(L.sun).multiplyScalar((1.05 - 0.12 * smooth(30, 60, sp.el)) * sunI); }
  else { out.keyW.copy(out.moonW); out.key.copy(L.moon).multiplyScalar(0.15 * moonI); }
  if (s > 0) out.key.lerp(tc.setRGB(1, 0.62, 0.32).multiplyScalar(Math.max(out.key.r, out.key.g, out.key.b)), 0.5 * s);
  out.sunVis = smooth(-3, 1, sp.el) * (1 - 0.92 * s) * (1 - cloud * 0.7);
  out.moonVis = smooth(-2, 3, sp.moonEl) * (1 - day * 0.7) * (1 - s * 0.95) * (1 - cloud * 0.7);
  out.stars = L.stars * (1 - s);
  // ---- ambient: sky dome light from above, sand bounce from below (warm by day, blue moonlight by night)
  const la = Math.min(1, luma(L.ambient));
  out.skyAmb.copy(out.zenith).lerp(out.horizon, 0.55).multiplyScalar(0.55).lerp(tc.copy(NIGHT_SAND).multiplyScalar(0.24), 1 - day);
  out.skyAmb.multiplyScalar(0.55 + 0.45 * la);
  out.gndAmb.setRGB(0.42, 0.27, 0.15).multiplyScalar(0.32 * (sunI + 0.05) + 0.02).lerp(tc.copy(NIGHT_SAND).multiplyScalar(0.05), 1 - day);
  // ---- haze: dusty, bright towards the sun
  out.hazeCol.copy(out.horizon).lerp(tc.copy(HAZE).multiplyScalar(luma(out.horizon) / luma(HAZE)), 0.35 * day).multiplyScalar(0.92);
  out.hazeSun.copy(out.hazeCol).lerp(tc2.copy(L.sun).multiplyScalar(Math.max(0.2, luma(out.hazeCol) * 1.35)), 0.6 * smooth(-4, 4, sp.el) * (1 - s));
  // ---- sandstorm: ochre sky, ochre ambient, the sun a pale disc, visibility ~100 m at the core
  const dl = 0.06 + 0.94 * smooth(-8, 12, sp.el);
  out.dust.copy(DUST).multiplyScalar(dl * 0.85);
  if (s > 0) {
    const k = smooth(0, 1, s);
    out.zenith.lerp(tc.copy(out.dust).multiplyScalar(0.62), k);
    out.horizon.lerp(tc.copy(out.dust).multiplyScalar(0.95), k);
    out.hazeCol.lerp(tc.copy(out.dust).multiplyScalar(0.9), Math.min(1, k * 1.2));
    out.hazeSun.lerp(tc.copy(out.dust).multiplyScalar(1.15), Math.min(1, k * 1.2));
    out.skyAmb.lerp(tc.copy(out.dust).multiplyScalar(0.55), k * 0.8);
    out.gndAmb.lerp(tc.copy(out.dust).multiplyScalar(0.3), k * 0.8);
  }
  // fog: clear desert ~40 % at 2.5 km on the ground (heat + dust haze), storm -> visibility stormVisibility(s)
  const clearD = 2.0e-4 * (1 + cloud * 0.5), stormD = 3 / stormVisibility(1);
  out.fogD = s <= 0 ? clearD : clearD * Math.pow(stormD / clearD, Math.pow(s, 1.3));
  out.fogH = 220 + 380 * s;
  out.mirage = smooth(25, 55, sp.el) * (1 - s) * (1 - cloud * 0.8);
  return out;
}

/** The room environment's `north` (deg) that puts its sun where the desert's is, for a route heading (rad). */
export function envNorthDeg(desertNorthDeg: number, heading: number): number {
  return desertNorthDeg + (heading * 180) / Math.PI;
}

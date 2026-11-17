// Time-of-day colour curves (keyed by sun elevation, degrees) + the weather's effect on them. Tuned for cel / anime
// rooms: saturated golden hours, a violet blue hour, a readable moonlit night (never pitch black).
import * as THREE from 'three';
import type { WeatherParams } from '../../../shared/environment.ts';

type Key = [number, number, number, number];   // elevation, r, g, b (linear-ish display values)
const hex = (el: number, h: string): Key => { const c = new THREE.Color(h); return [el, c.r, c.g, c.b]; };

const ZENITH: Key[] = [hex(-18, '#02040b'), hex(-10, '#050a1e'), hex(-5, '#121c48'), hex(-2, '#26306c'), hex(0, '#34468a'), hex(3, '#4262a8'), hex(8, '#3f73c6'), hex(16, '#3c80d6'), hex(30, '#377fdc'), hex(60, '#3279dc')];
const HORIZON: Key[] = [hex(-18, '#060912'), hex(-10, '#0d1228'), hex(-5, '#2e2a4e'), hex(-2, '#8a4d5a'), hex(0, '#e0703e'), hex(3, '#f09652'), hex(8, '#f4c486'), hex(16, '#d6e2ec'), hex(30, '#bcd6ef'), hex(60, '#b2d0ee')];
const SUN: Key[] = [hex(-3, '#ff4a1a'), hex(0, '#ff6424'), hex(3, '#ff8a3c'), hex(8, '#ffb66a'), hex(16, '#ffdcae'), hex(30, '#fff1dc'), hex(60, '#fff6ea')];
/** Room light (multiplier on the room's own shading). The moonlit end is scaled by the room's `night`. */
const AMBIENT: Key[] = [hex(-18, '#2a3354'), hex(-10, '#303a60'), hex(-5, '#4a4c7a'), hex(-2, '#8a7288'), hex(0, '#c09080'), hex(3, '#e6b08e'), hex(8, '#f6d6b8'), hex(16, '#fdf2e6'), hex(30, '#ffffff'), hex(60, '#ffffff')];

function sample(keys: Key[], el: number, out: THREE.Color) {
  if (el <= keys[0][0]) return out.setRGB(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < keys.length; i++) {
    if (el <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i], k = (el - a[0]) / (b[0] - a[0]);
      return out.setRGB(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    }
  }
  const l = keys[keys.length - 1];
  return out.setRGB(l[1], l[2], l[3]);
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const luma = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
const tmp = new THREE.Color();

export interface SkyLight {
  zenith: THREE.Color; horizon: THREE.Color;
  /** Sun colour × strength on the room (0 below the horizon / behind thick cloud). */
  sun: THREE.Color; sunI: number;
  moon: THREE.Color; moonI: number;
  /** Room light multiplier (colour × level). */
  ambient: THREE.Color;
  /** 0 night … 1 day (time only). */
  day: number;
  stars: number;
  /** Cloud colours on the dome: lit side, shadow side. */
  cloudLit: THREE.Color; cloudShade: THREE.Color;
}

export function newSkyLight(): SkyLight {
  return { zenith: new THREE.Color(), horizon: new THREE.Color(), sun: new THREE.Color(), sunI: 0, moon: new THREE.Color(0.62, 0.72, 1), moonI: 0, ambient: new THREE.Color(), day: 1, stars: 0, cloudLit: new THREE.Color(), cloudShade: new THREE.Color() };
}

/** Everything the sky, the room and the performers need for one moment. `night` = room light at deep night (0.05..0.6). */
export function skyAt(sunEl: number, moonEl: number, w: WeatherParams, night: number, out: SkyLight): SkyLight {
  sample(ZENITH, sunEl, out.zenith);
  sample(HORIZON, sunEl, out.horizon);
  sample(AMBIENT, sunEl, out.ambient);
  const day = smooth(-7, 6, sunEl);
  out.day = day;
  // the deep-night end follows the room's `night` level (keys are authored for 0.2)
  const nk = night / 0.2;
  const nightMix = 1 - smooth(-10, 3, sunEl);
  out.ambient.multiplyScalar(1 + (nk - 1) * nightMix);
  sample(SUN, sunEl, out.sun);
  const cloudBlock = 1 - Math.pow(w.cloud, 1.6) * 0.92;
  out.sunI = smooth(-2.5, 3, sunEl) * cloudBlock * (1 - w.fog * 0.6);
  const moonUp = smooth(-2, 8, moonEl) * (1 - day);
  out.moonI = moonUp * (1 - w.cloud * 0.8) * (1 - w.fog * 0.5);
  out.stars = (1 - smooth(-12, -3, sunEl)) * (1 - w.cloud * 0.95) * (1 - w.fog * 0.9);
  // weather: overcast greys + darkens the sky and the room (a flat, blue-grey light)
  const grey = w.cloud * 0.75 + w.fog * 0.2;
  const lz = luma(out.zenith), lh = luma(out.horizon), la = luma(out.ambient);
  out.zenith.lerp(tmp.setRGB(0.52, 0.56, 0.62).multiplyScalar(Math.max(0.03, lz * 1.1 + 0.02 * day)), Math.min(1, grey)).multiplyScalar(1 - w.cloudDark * 0.55);
  out.horizon.lerp(tmp.setRGB(0.66, 0.69, 0.73).multiplyScalar(Math.max(0.04, lh * 0.95)), Math.min(1, grey * 0.9)).multiplyScalar(1 - w.cloudDark * 0.62);
  out.ambient.lerp(tmp.setRGB(0.9, 0.94, 1.0).multiplyScalar(la), Math.min(1, grey * 0.8)).multiplyScalar(1 - w.dark * 0.78);
  // fog lifts the horizon towards its own grey
  if (w.fog > 0) out.horizon.lerp(tmp.setRGB(0.62, 0.66, 0.7).multiplyScalar(0.25 + 0.75 * day), w.fog * 0.7);
  // clouds on the dome: lit by the sun (warm at golden hour), shaded blue-grey; storms are slate
  out.cloudLit.copy(out.horizon).lerp(tmp.copy(out.sun).multiplyScalar(0.9 + 0.3 * day), 0.45 * smooth(-3, 4, sunEl)).lerp(tmp.setRGB(1, 1, 1).multiplyScalar(0.25 + 0.75 * day), 0.35 * day);
  if (day < 0.5) out.cloudLit.lerp(tmp.setRGB(0.18, 0.2, 0.3), (0.5 - day) * 1.6 * (1 - out.moonI * 0.4));
  out.cloudShade.copy(out.zenith).lerp(out.horizon, 0.5).multiplyScalar(0.72);
  out.cloudLit.lerp(tmp.setRGB(0.3, 0.32, 0.36).multiplyScalar(0.3 + 0.7 * day), w.cloudDark * 0.8);
  out.cloudShade.lerp(tmp.setRGB(0.14, 0.15, 0.18).multiplyScalar(0.25 + 0.75 * day), w.cloudDark * 0.85);
  // night storms: the deck is barely lit (a dark slate, lightning does the rest)
  const nk2 = 0.28 + 0.72 * day;
  out.cloudLit.multiplyScalar(1 - (1 - nk2) * w.cloudDark);
  out.cloudShade.multiplyScalar(1 - (1 - nk2) * w.cloudDark);
  return out;
}

export { luma };

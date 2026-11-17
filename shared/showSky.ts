// Show sky (scene.json `showSky`): a music-reactive night sky + a light-show beam rig for any open-air room, shown in the
// lighting states the room lists (default: Preshow). Pure data + the sanitiser (shared by the OBS page and the tests).
//   {
//     "states": ["preshow"],                 lighting states it shows in (show, preshow, brb, outro)
//     "fade": 2.5,                           seconds in / out
//     "stars": 1, "nebula": 1, "aurora": 0.8, "meteors": 1, "pulses": 1,   0..2 each (0 = off)
//     "light": [100, 22],                    the far sun lighting the planets: azimuth, elevation (deg); default: behind
//                                            the viewer relative to the first body (it shows mostly lit)
//     "bodies": [ { "kind": "giant", "az": -25, "el": 26, "size": 22, "color": "#d9a066", "color2": "#7a4a3a",
//                   "ring": { "tilt": 18, "inner": 1.35, "outer": 2.3, "color": "#e8d2a8" }, "glow": 0.8 },
//                 { "kind": "moon", "az": 40, "el": 38, "size": 4, "color": "#cfd6e6" } ],
//     "beams": [ { "at": [2.4, 3.2, -3.9] }, ... ],   searchlights (room frame), lean outward from the room centre
//     "lasers": [ [0, 6.5, -6.3] ],                   laser fan origins (room frame)
//     "beamLength": 900, "beamWidth": 1.0
//   }
// Azimuth: 0 = the room's -Z (a ship's bow), 90 = +X (starboard); elevation above the horizon. Sizes are angular
// diameters in degrees. Everything reacts to the light show's music analysis (or an auto groove with no music).
export type ShowSkyBodyKind = 'giant' | 'moon' | 'planet';
export interface ShowSkyRing { tilt: number; inner: number; outer: number; color: string }
export interface ShowSkyBody { kind: ShowSkyBodyKind; az: number; el: number; size: number; color: string; color2: string; ring: ShowSkyRing | null; glow: number }
export interface ShowSkyBeam { at: [number, number, number]; color: string | null }
export interface ShowSkyConfig {
  states: string[]; fade: number;
  stars: number; nebula: number; aurora: number; meteors: number; pulses: number;
  light: [number, number];
  bodies: ShowSkyBody[]; beams: ShowSkyBeam[]; lasers: [number, number, number][];
  beamLength: number; beamWidth: number;
}

export const SHOW_SKY_STATES = ['show', 'preshow', 'brb', 'outro'] as const;
export const MAX_SKY_BODIES = 6;
export const MAX_SKY_BEAMS = 12;
export const MAX_SKY_LASERS = 3;

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const col = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
const v3 = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e4) ? [v[0], v[1], v[2]] : null);

/** The default sky for a room that only says `"showSky": true`: a ringed giant ahead-left, two moons. */
export const DEFAULT_SKY_BODIES: ShowSkyBody[] = [
  { kind: 'giant', az: -28, el: 24, size: 22, color: '#d9a46c', color2: '#7b4a3c', ring: { tilt: 20, inner: 1.35, outer: 2.35, color: '#e9d4ad' }, glow: 0.8 },
  { kind: 'moon', az: 38, el: 41, size: 4.2, color: '#cdd5e4', color2: '#8a90a0', ring: null, glow: 0.4 },
  { kind: 'planet', az: 72, el: 17, size: 2.4, color: '#7fb7c9', color2: '#2f5f7a', ring: null, glow: 0.5 },
];

export function sanitizeShowSky(raw: unknown): ShowSkyConfig | null {
  if (raw === true) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.on === false) return null;
  const states = Array.isArray(o.states) ? o.states.filter((s): s is string => typeof s === 'string' && (SHOW_SKY_STATES as readonly string[]).includes(s)) : ['preshow'];
  const bodiesIn = Array.isArray(o.bodies) ? o.bodies : null;
  const bodies: ShowSkyBody[] = (bodiesIn ?? DEFAULT_SKY_BODIES).slice(0, MAX_SKY_BODIES).flatMap((b): ShowSkyBody[] => {
    if (!b || typeof b !== 'object') return [];
    const x = b as Record<string, unknown>;
    const kind: ShowSkyBodyKind = x.kind === 'moon' || x.kind === 'planet' ? x.kind : 'giant';
    const r = x.ring;
    let ring: ShowSkyRing | null = null;
    if (r === true || (r && typeof r === 'object')) {
      const q = (r === true ? {} : r) as Record<string, unknown>;
      const inner = num(q.inner, 1.05, 4, 1.35);
      ring = { tilt: num(q.tilt, -89, 89, 20), inner, outer: Math.max(inner + 0.05, num(q.outer, 1.1, 6, 2.3)), color: col(q.color, '#e9d4ad') };
    }
    return [{ kind, az: num(x.az, -360, 360, 0), el: num(x.el, 2, 89, 25), size: num(x.size, 0.3, 60, kind === 'giant' ? 20 : 4), color: col(x.color, kind === 'moon' ? '#cdd5e4' : '#d9a46c'), color2: col(x.color2, '#6b4a3c'), ring, glow: num(x.glow, 0, 2, 0.6) }];
  });
  const beams: ShowSkyBeam[] = (Array.isArray(o.beams) ? o.beams : []).slice(0, MAX_SKY_BEAMS).flatMap((b): ShowSkyBeam[] => {
    const at = v3(Array.isArray(b) ? b : b && typeof b === 'object' ? (b as Record<string, unknown>).at : null);
    return at ? [{ at, color: b && typeof b === 'object' && !Array.isArray(b) ? (typeof (b as Record<string, unknown>).color === 'string' ? col((b as Record<string, unknown>).color, '#ffffff') : null) : null }] : [];
  });
  const lasers = (Array.isArray(o.lasers) ? o.lasers : []).map(v3).filter((x): x is [number, number, number] => !!x).slice(0, MAX_SKY_LASERS);
  // the far sun lights the hero body from well behind the viewer's shoulder (a fat gibbous, never a black disc) unless set
  const hero = bodies[0];
  const autoL: [number, number] = [hero ? hero.az + 135 : 120, 22];
  const L = Array.isArray(o.light) && o.light.length === 2 ? [num(o.light[0], -360, 360, autoL[0]), num(o.light[1], -30, 89, 22)] as [number, number] : autoL;
  return {
    states: states.length ? states : ['preshow'], fade: num(o.fade, 0.2, 10, 2.5),
    stars: num(o.stars, 0, 2, 1), nebula: num(o.nebula, 0, 2, 1), aurora: num(o.aurora, 0, 2, 0.5), meteors: num(o.meteors, 0, 2, 1), pulses: num(o.pulses, 0, 2, 1),
    light: L, bodies, beams, lasers, beamLength: num(o.beamLength, 50, 3000, 900), beamWidth: num(o.beamWidth, 0.2, 5, 1),
  };
}

/** Direction (room frame: 0 az = -Z, 90 = +X) of an azimuth / elevation in degrees. */
export function skyDir(azDeg: number, elDeg: number): [number, number, number] {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** The beam pattern of a phrase (pure in the music's bar number): every page picks the same. */
export type BeamPattern = 'fan' | 'cross' | 'circle' | 'sweep' | 'pillars' | 'converge';
export function beamPattern(bar: number, section: 'groove' | 'breakdown' | 'build' | 'drop'): BeamPattern {
  if (section === 'breakdown') return 'pillars';
  if (section === 'build') return 'converge';
  const P: BeamPattern[] = section === 'drop' ? ['circle', 'cross', 'fan'] : ['fan', 'sweep', 'cross', 'circle'];
  const ph = Math.floor(bar / 4);
  const h = (Math.imul(ph ^ 0x5bd1e995, 0x27d4eb2d) >>> 0) % P.length;
  return P[h];
}

/** Tilt from vertical (rad) and azimuth (rad, room frame) of searchlight i of n at a musical moment. `lean` = the
 *  azimuth from the room centre to the beam's foot (beams lean outward). Pure. */
export function beamAim(p: BeamPattern, i: number, n: number, beat: number, build: number, lean: number): { tilt: number; az: number } {
  const B = beat * Math.PI;
  switch (p) {
    case 'pillars': return { tilt: 0.04 + 0.02 * Math.sin(B / 8 + i), az: lean };
    case 'converge': return { tilt: (0.5 - 0.42 * build) * (1 + 0.1 * Math.sin(B / 2 + i)), az: lean + Math.PI };
    case 'circle': return { tilt: 0.32 + 0.08 * Math.sin(B / 2), az: B / 8 + (2 * Math.PI * i) / Math.max(1, n) };
    case 'cross': return { tilt: 0.36, az: lean + (i % 2 ? 1 : -1) * 0.7 * Math.sin(B / 4) };
    case 'sweep': return { tilt: 0.42, az: Math.PI * 0.5 + 0.9 * Math.sin(B / 8) };
    default: return { tilt: 0.24 + 0.14 * Math.sin(B / 2 + i * 0.9), az: lean + 0.3 * Math.sin(B / 4) };
  }
}

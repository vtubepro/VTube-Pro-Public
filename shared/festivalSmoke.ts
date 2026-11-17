// The lit smoke ceiling of a festival stage and the haze halos round firing flames - the pure part (no three.js):
// how much smoke hangs over the stage (it builds up with the pyro and drifts away slowly) and what light it carries.
// The picture is a warm smoke CEILING above and behind the rig, not a veil in front of the stage: the smoke itself is dark
// (it hides the sky, its creases stay dark) and it is lit warm only where there is fire under it or shells bursting in it
// - nothing else lights it (no cold or grey wash from the part's colour). src/scene/festival/smokeCeiling.ts draws it (one
// draw for the layers - alpha-blended colour, the canvas alpha untouched for OBS - one additive draw for the halos);
// tools/festival_smoke_unit.ts checks it. Photosensitivity: the light the smoke shows is low-passed (>= 1 s) before the
// stage governor, so a burst only ever brightens the smoke slowly - never a flash on the large area it covers.
import { clamp01 } from './festival.ts';

export interface SmokeCfg {
  /** how long the smoke hangs (s, the time constant of its decay; 10-60) */
  decay: number;
  /** density each event adds (a shell burst, a flame volley, a comet fan); the total is capped at 1 */
  shell: number; volley: number; fan: number;
  /** a little haze is always there (the beams' haze; 0..0.3) */
  base: number;
  /** the layer's height band (times the stage height above the deck) and width (times the stage width) */
  low: number; high: number; width: number;
  /** brightness of the lit smoke (0..2) and of the halos round firing flames (0..2) */
  gain: number; halo: number;
}
export const DEFAULT_SMOKE: SmokeCfg = { decay: 30, shell: 0.06, volley: 0.02, fan: 0.01, base: 0.05, low: 0.7, high: 2.6, width: 1.5, gain: 1, halo: 1 };
export function sanitizeSmoke(raw: unknown): SmokeCfg | null {
  if (raw === true) return { ...DEFAULT_SMOKE };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const d = DEFAULT_SMOKE;
  const low = n(o.low, 0.2, 3, d.low);
  return { decay: n(o.decay, 10, 60, d.decay), shell: n(o.shell, 0, 0.3, d.shell), volley: n(o.volley, 0, 0.2, d.volley), fan: n(o.fan, 0, 0.2, d.fan), base: n(o.base, 0, 0.3, d.base),
    low, high: Math.max(low + 0.3, n(o.high, 0.5, 5, d.high)), width: n(o.width, 0.5, 4, d.width), gain: n(o.gain, 0, 2, d.gain), halo: n(o.halo, 0, 2, d.halo) };
}

/** The smoke over the stage: density 0..1 that the pyro builds up and time thins out. Deterministic for a given event
 *  sequence (each page accumulates what it saw). */
export class SmokeDensity {
  d = 0;
  constructor(public cfg: SmokeCfg = DEFAULT_SMOKE) { this.d = cfg.base; }
  /** events this frame: shell bursts, flame volleys, comet fans */
  add(shells: number, volleys: number, fans: number) { this.d = Math.min(1, this.d + shells * this.cfg.shell + volleys * this.cfg.volley + fans * this.cfg.fan); }
  /** time passes (s): the smoke thins toward the base haze */
  step(dt: number) { const b = this.cfg.base; this.d = b + (this.d - b) * Math.exp(-Math.max(0, dt) / Math.max(1, this.cfg.decay)); }
}

/** the fire's key colour, the finale's smoke tones (the lit underside from orange to gold) - sRGB */
const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const FIRE_KEY = rgb('#ff6a1a'), FINALE_LOW = rgb('#ce5d0c'), FINALE_HIGH = rgb('#e79223'), HALO = rgb('#e96f46');

/** The two lights the smoke carries (sRGB 0..1): the fire's from below - orange, turning to the finale's orange-gold as the
 *  smoke thickens - and the shells', their colour pulled toward warm gold (two thirds of the way; nearly all of it in a
 *  thick finale ceiling): the smoke is a warm ceiling, never a cold or grey wash. */
export function smokeTones(skyCol: readonly number[], density: number, fire: number[], shell: number[]): void {
  const fin = clamp01((density - 0.35) / 0.5);
  for (let k = 0; k < 3; k++) {
    fire[k] = FIRE_KEY[k] + (FINALE_LOW[k] - FIRE_KEY[k]) * 0.6 * fin;
    shell[k] = skyCol[k] + (FINALE_HIGH[k] - skyCol[k]) * (0.65 + 0.3 * fin);
  }
}
const TF = [0, 0, 0], TS = [0, 0, 0];
/** What lights the smoke at its brightest now (sRGB-ish, 0..~1.7 per channel): the fire under it (`fire` 0..1) and the
 *  shells bursting in it (`shells` 0..1, their colour) in the warm tones above - nothing without fire or shells. */
export function smokeLight(fire: number, shells: number, skyCol: readonly number[], density: number, out: number[]): number[] {
  smokeTones(skyCol, density, TF, TS);
  const h = clamp01(fire), s = clamp01(shells);
  for (let k = 0; k < 3; k++) out[k] = TF[k] * h * 0.9 + TS[k] * s * 0.8;
  return out;
}
/** How much of the sky the smoke covers (0..1) at a density: the always-there haze barely shows, a finale's ceiling
 *  closes in */
export const smokeCover = (density: number, base: number): number => Math.pow(clamp01((density - 0.6 * base) / (1 - 0.6 * base)), 0.7);
/** Where the light falls along the smoke (FIRE_BINS weights 0..1 across the sheets' width, x0..x0 + w): a soft pool round
 *  each source x (gaussian, sigma = `sigma` metres), summed and capped at 1 - into `out`. No sources = everywhere 1. */
export const SMOKE_BINS = 16;
export function lightBins(xs: readonly number[], x0: number, w: number, sigma: number, out: Float32Array, gain = 1): Float32Array {
  for (let i = 0; i < SMOKE_BINS; i++) {
    if (!xs.length) { out[i] = 1; continue; }
    const x = x0 + (i / (SMOKE_BINS - 1)) * w;
    let v = 0;
    for (const s of xs) v += Math.exp(-((x - s) * (x - s)) / (2 * sigma * sigma));
    out[i] = Math.min(1, v * gain);
  }
  return out;
}

/** A first-order low-pass toward `want` with time constant `tau` (s) - the smoke's light never jumps (>= 1 s ramps). */
export function smoothToward(cur: number, want: number, dt: number, tau: number): number {
  return want + (cur - want) * Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau));
}
/** the smoke light's ramp (s): rises over >= 1 s, falls a little slower */
export const SMOKE_RISE = 1.2, SMOKE_FALL = 2.5;

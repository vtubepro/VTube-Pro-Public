// Festival stage engine: the shared, pure part (no three.js). Used by the OBS pages (src/scene/festival/*), the studio
// (Scene tab → Festival), the Look Lab page and the unit tests (tools/festival_unit.ts). See docs/SCENES.md "Festival".
//
//  - fixture anchors   FX_<TYPE>_<GROUP>_<NN> empties / meshes in a room's scene.glb (parseFxAnchor)
//  - quality budgets    how many of each fixture class / particle a graphics tier draws (FESTIVAL_BUDGET, pickSubset)
//  - the flash gate     one room-wide photosensitivity budget (≤ 3 big flashes per second unless the streamer opts out)
//  - room config        scene.json `festival` (sanitizeFestivalConfig)
//  - host state         SceneState.festival: the show, pyro, intensity, the curated look list, manual cues
// The looks / shows live in shared/festivalLooks.ts, the show director in shared/festivalDirector.ts.
import type { LightingStateId } from './types.ts';
import { sanitizeRoles, sanitizeStructure, type ColorRoles, type StructureCfg } from './festivalRoles.ts';
import { sanitizeSmoke, type SmokeCfg } from './festivalSmoke.ts';
import { sanitizeCompose, type ComposeState } from './festivalComposeState.ts';

export type Tier = 'low' | 'medium' | 'high' | 'ultra';

// ---------------------------------------------------------------------------------------------------- anchors
/** Fixture classes. Lights: beam / spot / wash moving heads, PAR cans, strobes, blinders, lasers, pixel bars, LED
 *  walls. Special effects (emulated only, never DMX): CO2 jets, flame columns, confetti cannons, gerbs (sparkulars),
 *  comets, firework launch points. */
export const FX_KINDS = ['beam', 'spot', 'wash', 'par', 'strobe', 'blinder', 'laser', 'pixel', 'ledwall', 'co2', 'flame', 'confetti', 'gerb', 'comet', 'firework'] as const;
export type FxKind = (typeof FX_KINDS)[number];
export const SFX_KINDS: readonly FxKind[] = ['co2', 'flame', 'confetti', 'gerb', 'comet', 'firework'];
export const LIGHT_KINDS: readonly FxKind[] = ['beam', 'spot', 'wash', 'par', 'strobe', 'blinder', 'laser', 'pixel', 'ledwall'];

/** FX_<TYPE>_<GROUP>_<NN>: TYPE one of FX_KINDS (upper case), GROUP letters / digits (TRUSS1, TOWERL, DECK, EYES …),
 *  NN a 2–3 digit index. GLTFLoader's "_1" split children of a multi-material mesh are not anchors. */
const ANCHOR_RX = /^FX_(BEAM|SPOT|WASH|PAR|STROBE|BLINDER|LASER|PIXEL|LEDWALL|CO2|FLAME|CONFETTI|GERB|COMET|FIREWORK)_([A-Z][A-Z0-9]{0,15})_(\d{2,3})$/;
export interface FxAnchorName { kind: FxKind; group: string; index: number }
export function parseFxAnchor(name: string): FxAnchorName | null {
  const m = ANCHOR_RX.exec(name);
  return m ? { kind: m[1].toLowerCase() as FxKind, group: m[2], index: +m[3] } : null;
}

// ---------------------------------------------------------------------------------------------------- budgets
/** What one graphics tier draws. Counts are per class; a room with more anchors than the budget gets an even,
 *  deterministic subset (pickSubset), so every page of the same tier shows the same fixtures. Particle pools are the
 *  most particles alive at once (bursty). Measured costs: docs/PERFORMANCE.md "Festival stages". */
export interface FestivalBudget {
  beam: number; spot: number; wash: number; par: number; strobe: number; blinder: number;
  /** laser origins and rays per origin */
  laser: number; rays: number;
  pixel: number; ledwall: number;
  flame: number; co2: number; confetti: number; sparks: number; firework: number;
  crowd: number;
  /** prism (beam fixtures split into 3), lens flares (fake bloom), beam floor hits, dust noise in the cones */
  prism: boolean; flares: boolean; floorHits: boolean; dust: boolean;
  /** cone length multiplier (shorter cones = less overdraw) */
  reach: number;
}
export const FESTIVAL_BUDGET: Record<Tier, FestivalBudget> = {
  low: { beam: 24, spot: 6, wash: 10, par: 24, strobe: 8, blinder: 6, laser: 2, rays: 8, pixel: 160, ledwall: 6, flame: 16, co2: 300, confetti: 500, sparks: 500, firework: 600, crowd: 300, prism: false, flares: false, floorHits: false, dust: false, reach: 0.7 },
  medium: { beam: 72, spot: 16, wash: 24, par: 48, strobe: 12, blinder: 10, laser: 4, rays: 12, pixel: 420, ledwall: 8, flame: 32, co2: 1200, confetti: 1600, sparks: 1500, firework: 1800, crowd: 800, prism: false, flares: true, floorHits: true, dust: true, reach: 0.85 },
  high: { beam: 150, spot: 24, wash: 36, par: 72, strobe: 16, blinder: 16, laser: 6, rays: 16, pixel: 800, ledwall: 10, flame: 48, co2: 3000, confetti: 4000, sparks: 3000, firework: 4000, crowd: 1500, prism: true, flares: true, floorHits: true, dust: true, reach: 1 },
  ultra: { beam: 200, spot: 32, wash: 48, par: 96, strobe: 24, blinder: 24, laser: 8, rays: 20, pixel: 1200, ledwall: 12, flame: 64, co2: 4000, confetti: 6000, sparks: 4500, firework: 6000, crowd: 2400, prism: true, flares: true, floorHits: true, dust: true, reach: 1 },
};
/** The budget one step down (auto-downgrade ladder when frames get slow). */
export const TIER_BELOW: Record<Tier, Tier> = { ultra: 'high', high: 'medium', medium: 'low', low: 'low' };
export function budgetFor(tier: Tier, kind: FxKind): number {
  const b = FESTIVAL_BUDGET[tier];
  switch (kind) {
    case 'firework': return Math.max(2, Math.round(b.firework / 300));
    case 'comet': return Math.max(2, Math.round(b.sparks / 120));
    case 'co2': return Math.max(2, Math.round(b.co2 / 150));
    case 'confetti': return Math.max(2, Math.round(b.confetti / 400));
    case 'gerb': return Math.max(2, Math.round(b.sparks / 60));
    default: return (b as unknown as Record<string, number>)[kind] ?? 0;
  }
}
/** `max` indexes out of 0..n-1, spread evenly (both ends kept), deterministic. */
export function pickSubset(n: number, max: number): number[] {
  if (max <= 0 || n <= 0) return [];
  if (n <= max) return [...Array(n).keys()];
  if (max === 1) return [Math.floor((n - 1) / 2)];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (n - 1)) / (max - 1)));
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------- photosensitivity
/** Flashes per second allowed with `safe` on (WCAG 2.3.1: no more than three flashes in any one second). */
export const MAX_FLASH_HZ = 3;
const MIN_FLASH_MS = 1000 / MAX_FLASH_HZ;
/** depth of a flash the gate holds back */
export const HELD_FLASH = 0.1;
/** where a held chase on a colour fixture (mover, PAR, pixel) sits: it stops flickering and holds steady at 70 % of the
 *  look's level with 10 % of its flash depth left, so a 16th-note chase reads as steady beams that still move (white
 *  strobes and blinders just drop to 10 %) */
export const HELD_STEADY = 0.7;
/** a colour fixture's level after the gate: depth 1 = the hit as is; held = steady, 10 % of the swing */
export function heldLevel(v: number, depth: number, ceiling = 1): number {
  if (depth >= 1) return v;
  const mid = HELD_STEADY * ceiling;
  return mid + (v - mid) * depth;
}
/** One flash budget for the whole stage: a flash is let through at full depth when ≥ 333 ms after the last full one
 *  (hits < 60 ms apart count as the same flash); a gated (held) hit still shows at 10 % depth - the same rule as the room light
 *  show (shared/lightDirector.ts). Decisions are cached per key
 *  so a flash keeps its depth while it decays. With safe off (the streamer's explicit opt-out, shown on stream as a
 *  warning on the LED walls) everything passes. */
export class FlashGate {
  safe = true;
  private last = -Infinity;
  private seen = new Map<string, number>();
  /** full flashes let through (tests / debug) */
  passed: number[] = [];
  depth(key: string, at: number): number {
    const k = this.seen.get(key);
    if (k !== undefined) return k;
    let d = 1;
    if (this.safe && Number.isFinite(at)) {
      const gap = at - this.last;
      if (gap >= MIN_FLASH_MS) { this.last = at; this.passed.push(at); if (this.passed.length > 64) this.passed.shift(); }
      else if (gap >= 60 || gap < 0) d = HELD_FLASH;
    }
    this.seen.set(key, d);
    if (this.seen.size > 96) this.seen.delete(this.seen.keys().next().value as string);
    return d;
  }
  /** strobe rate the gate allows (Hz) */
  cap(hz: number): number { return this.safe ? Math.min(hz, MAX_FLASH_HZ) : hz; }
  reset() { this.last = -Infinity; this.seen.clear(); this.passed = []; }
}

// ---------------------------------------------------------------------------------------------------- room config
export interface FestivalCueStep {
  /** effect kind (a special effect, or 'blinder' / 'strobe' / 'blackout') */
  kind: FxKind | 'blinder' | 'blackout';
  /** anchor group (FX_<TYPE>_<GROUP>_xx), '' = every group of that kind */
  group: string;
  /** start, in beats after the cue */
  at: number;
  /** how long (beats) */
  dur: number;
  /** 0..1.5 power (flame height, CO2 length) */
  power: number;
  /** a named shape (scene.json festival.shapes) for fireworks / the flame skyline */
  shape?: string;
  /** firing order across the group's units (a chase over `span` beats): left → right, right → left, centre → out,
   *  outside → in, a rolling sine wave, alternate halves */
  order?: FxOrder;
  /** beats the chase takes from the first unit to the last (with `order`) */
  span?: number;
  /** a variant: flames 'green' (coloured fluid) / 'hero' (a 20 m pump column); gerbs 'waterfall' (a falling spark
   *  curtain); comets 'mine' (a spray of stars); fireworks 'willow' (long gold trails) / 'salute' (a soft white flash) /
   *  'crossette' / 'glitter'; lasers 'tongue' (one fat beam whipping across the sky) / 'sky' / 'fan' / 'sheet' */
  style?: FxStyle;
  /** −1 / 0 / 1 = the left half / all / the right half of the group */
  side?: -1 | 0 | 1;
  /** comet fans / rows (styles fan, vfan, sunburst, semicircle, lattice, curtain): comets in the fan, its angle (deg)
   *  or a row's width (m), and its lean (deg, + = toward stage left / +x) - unset = the style's defaults */
  count?: number; spread?: number; tilt?: number;
  /** colours for this step (comets: head + tail, shells: the two star colours; hex) - unset = the show's palette */
  color?: string; color2?: string;
}
export const FX_ORDERS = ['lr', 'rl', 'out', 'in', 'wave', 'alt'] as const;
export type FxOrder = (typeof FX_ORDERS)[number];
export const FX_STYLES = ['green', 'hero', 'waterfall', 'mine', 'willow', 'salute', 'crossette', 'glitter', 'tongue', 'sky', 'fan', 'sheet', 'sunburst', 'semicircle', 'vfan', 'lattice', 'curtain'] as const;
export type FxStyle = (typeof FX_STYLES)[number];

// ---------------------------------------------------------------------------------------------------- scripted shows
export type ScriptSection = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro';
/** One part of a scripted show (an "endshow"): from `bar` (0-based, 4 beats a bar) until the next part. */
export interface FestivalScriptPart {
  bar: number; section: ScriptSection;
  /** LED lore text: one line every `every` bars (text on the walls only - nothing is ever played) */
  text?: string[]; every?: number;
  /** the wall visual / palette / beam motion (a motion id of shared/festivalLooks.ts) for this part */
  wall?: string; palette?: string; motion?: string;
  /** the room's swell node (scene.json festival.swell) over the part: from → to (0 = rest, 1 = full) */
  swell?: [number, number];
  /** the eye screens: 0 = closed / dark … 1 = open */
  eyes?: number;
  /** show level 0..1.2 for the part (0 = everything dark but the eyes) */
  master?: number;
  /** cameras to cut through (every `camBars` bars) while the endshow cameras are on */
  cams?: string[]; camBars?: number;
  /** the moving heads' level for the part (0..1.2, default 1): a pyro-heavy part leaves the sky to the pyro */
  beams?: number;
}
/** A scripted cue: a cue step at `bar` (its `at` = beats into that bar). */
export interface FestivalScriptCue extends FestivalCueStep { bar: number }
export interface FestivalScript { id: string; name: string; bars: number; parts: FestivalScriptPart[]; cues: FestivalScriptCue[];
  /** the show it plays (a show id: its colour roles, drops) - unset = the host's show */
  show?: string;
  /** the house look while it plays (colour roles, the structure layer, the lit smoke) even in a room without `house` */
  house?: boolean;
  /** parts without `cams` cut the cameras by the music-locked grammar (camera roles from their names) */
  camGrammar?: boolean }
/** script caps (a composed 20-40 minute show fits) */
export const SCRIPT_MAX_PARTS = 128, SCRIPT_MAX_CUES = 2000, SCRIPT_MAX_BARS = 4000;

/** Talk / Interview: the stage behind the conversation runs a calm, seeded show of its own with pyro in four tiers:
 *  ambience always, ripples every 40-90 s, swells every 3-5 min, big moments every 8-12 min - big ones only in a pause
 *  of the conversation (or on the host's "Big moment" button). Seconds; cue names from `cues`. */
export interface FestivalAmbient {
  on: boolean;
  /** the show the background plays ('' = the calmest built-in show) */
  show: string;
  /** show level while people talk / in a pause (the background stays 1-1.5 stops under the faces) */
  talking: number; master: number;
  ripple: [number, number]; swell: [number, number]; big: [number, number];
  /** the room's own cues for each tier (else built from the room's effect groups) */
  ripples: string[]; swells: string[]; bigs: string[];
  /** a neutral key light on whoever speaks + two rims tinted to the show (the talk set) */
  key: boolean;
}
export const DEFAULT_AMBIENT: FestivalAmbient = { on: true, show: '', talking: 0.3, master: 0.45, ripple: [40, 90], swell: [180, 300], big: [480, 720], ripples: [], swells: [], bigs: [], key: false };

export interface FestivalConfig {
  on: boolean;
  /** the DJ booth spot: the host there plays the decks (src/scene/club/djPose.ts) */
  djSpot: string | null;
  /** height of the audience floor and the stage deck (m, glTF) - beam floor hits land on them */
  floorY: number; deckY: number;
  /** z (glTF) of the stage front edge: beam pools land on the deck behind it, on the audience floor in front */
  deckFront: number;
  /** haze 0..1 (how visible the beams are) */
  haze: number;
  /** a night set (0..1, default 0.12; 1 = off): the room's own materials keep this much of their environment
   *  reflection and dielectric specular (metalness leans to 1) - measured: a dark set's grey is all specular from the
   *  studio environment and the avatar key lights */
  night: number;
  /** the night set also leans metalness to 1 (the specular takes the dark albedo; default on). Rooms whose materials are
   *  meant to be lit (fire light, baked colour) turn it off and only lose the environment reflection */
  nightMetal: boolean;
  /** the stage wash on the set: these room materials glow through their own texture, tinted by the show (strength
   *  0..2 at full show, `white` 0..1 = how much of the texture's own colour stays: 1 = untinted) */
  wash: { materials: string[]; strength: number; white: number; tint?: string } | null;
  /** show level per lighting state (default preshow / show / outro 1, react 0.35, brb 0.25) */
  states: Record<LightingStateId, number>;
  /** the show this room opens with ('auto' = by tempo) */
  defaultShow: string;
  /** extra palettes (hex lists) and shows for THIS room (personal themes live in room data, not in code) */
  palettes: { id: string; name: string; colors: string[]; tags?: string[] }[];
  shows: { id: string; name: string; genre: string; palettes: string[]; dropCue?: string; phraseCue?: string; roles?: ColorRoles }[];
  /** LED walls: a logo image in the room folder + a title for the text visuals; per wall group: visual / mirror */
  logo: string | null; title: string;
  walls: Record<string, { visual?: string; mirror?: boolean; role?: 'main' | 'side' | 'eye'; pupil?: 'round' | 'slit'; iris?: string }>;
  /** named point shapes (flat [x, y, …] in −1..1): shaped firework bursts, the flame skyline */
  shapes: Record<string, number[]>;
  /** named effect patterns ('cues'), fired by shows (dropCue / phraseCue) or by the host */
  cues: Record<string, FestivalCueStep[]>;
  /** the instanced crowd: a room crowd unit GLB (mesh CROWD_BODY + ARM_L / ARM_R), colour, density; `boost` multiplies
   *  the tier's people budget (a sea of people for a mega stage), `flags` = waving flags on poles in the crowd */
  crowd: { unit: string | null; color: string; density: number; boost: number; flags: number; flagColors: string[]; lit: number; rim: string | null; flagsFar: number; top: number };
  /** drone sweep camera (CAM_DRONE becomes a slow orbit): centre + radius + height (glTF) */
  drone: { center: [number, number, number]; radius: number; height: number; secs: number } | null;
  /** the show's own camera director (Talk, nobody to frame or the Wide / room camera picked): these room cameras in
   *  turn, a cut every `bars` bars on the phrase grid; a camera with a `<NAME>_END` empty moves to it over its shot */
  showCams: { cams: string[]; bars: number; grammar?: boolean } | null;
  /** Talk at the DJ spot: the room's authored SPOT_xx_CAM (a designed DJ shot with the stage behind) instead of the
   *  generic face close-up */
  djCam: boolean;
  /** flame cannons: `flameScale` (0.5-4) = the shots' height + fireball size (a mega stage's cannons read from the back
   *  of the field); `flamePatterns` = a hit without its own chase fires a pattern (centre-out pairs, L->R / R->L, every
   *  4th) instead of the whole row at once - all of them only on a big hit (power >= 1.3) */
  flameScale: number; flamePatterns: boolean;
  /** a node that swells through builds and snaps back on the drop (a throat sac, a balloon): its node name and the
   *  scale at full swell */
  swell: { node: string; max: number } | null;
  /** the room's scripted show (an endshow), started from the Scene tab */
  script: FestivalScript | null;
  /** Talk / Interview background show */
  ambient: FestivalAmbient;
  /** effect scale for a mega stage: flame columns (1 = 4.5-8 m MagicFX-style, 1.6 ≈ 8-13 m), CO2 plumes */
  fxScale: number;
  /** flame column width (1 = as tuned; a mega stage wants fat columns) and a smoke puff at a column's base each time it
   *  fires (`flameSmoke`) */
  flameWidth: number; flameSmoke: boolean;
  /** firework burst size (default fxScale^0.9) and shells fired per hit (1 = as the director asks) */
  shellScale: number | null; shellsPerHit: number;
  /** a room built for a faster GPU: every tier draws this many times its budget of fixtures / particles (1..3) */
  boost: number;
  /** how bright the moving-head beams (cones in the haze) are in this room (1 = as tuned; a dark set with a lot of
   *  structure to show wants less, so the beams don't hide it) */
  beamGain: number;
  /** how bright the lasers are in this room (1 = as tuned) */
  laserGain: number;
  /** show-pack reach of THIS room's own shows: 'show' = each show's own pool (~47 programs a show), 'full' = every
   *  program that fits the section (genre fits first): over a set the phrases walk the whole pack */
  packPool: 'show' | 'full';
  /** share of phrases that play the show-pack pool in this room's own shows (0.3..0.95; default 0.6) */
  packShare: number;
  /** real lights cast by the fire: point lights over the flame anchors of these groups (≤ 6), warm, governed */
  fireLights: { groups: string[]; count: number; intensity: number; range: number } | null;
  /** the house look (shared/festivalRoles.ts): 'mainstage' = a red / amber / gold set, white beams, green lasers, warm
   *  blinders, a violet crowd ('mainstage_magenta': a magenta crowd). 'auto' at hard-dance tempos plays the house show,
   *  and the structure layer + the lit smoke come on (unless the room sets them false). null = off (as before) */
  house: 'mainstage' | 'mainstage_magenta' | null;
  /** the structure (keylight) layer: the set's outline keeps a floor in every blackout, a slow level per section, a
   *  shallow pulse, colour on 8-bar lines (null = the pixel bars follow the look as before) */
  structure: StructureCfg | null;
  /** the lit smoke ceiling over the stage + haze halos round firing flames (null = off) */
  smoke: SmokeCfg | null;
}
export const DEFAULT_FESTIVAL_STATES: Record<LightingStateId, number> = { preshow: 1, show: 1, react: 0.35, brb: 0.25, outro: 0.85 };
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9_]{1,40}$/;
const GROUP = /^[A-Z][A-Z0-9]{0,15}$/;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** one cue step from room data (null = not a valid step) */
function cueStep(s: unknown): FestivalCueStep | null {
  const o = asObj(s);
  const kind = typeof o.kind === 'string' && ([...FX_KINDS, 'blinder', 'blackout'] as string[]).includes(o.kind) ? o.kind as FestivalCueStep['kind'] : null;
  if (!kind) return null;
  return { kind, group: typeof o.group === 'string' && GROUP.test(o.group) ? o.group : '', at: num(o.at, 0, 64, 0), dur: num(o.dur, 0.05, 64, 0.5), power: num(o.power, 0, 1.5, 1),
    ...(typeof o.shape === 'string' && ID.test(o.shape) ? { shape: o.shape } : {}),
    ...(typeof o.order === 'string' && (FX_ORDERS as readonly string[]).includes(o.order) ? { order: o.order as FxOrder } : {}),
    ...(typeof o.span === 'number' && Number.isFinite(o.span) ? { span: num(o.span, 0, 32, 1) } : {}),
    ...(typeof o.style === 'string' && (FX_STYLES as readonly string[]).includes(o.style) ? { style: o.style as FxStyle } : {}),
    ...(o.side === -1 || o.side === 1 ? { side: o.side as -1 | 1 } : {}),
    ...(typeof o.count === 'number' && Number.isFinite(o.count) ? { count: Math.round(num(o.count, 1, 60, 8)) } : {}),
    ...(typeof o.spread === 'number' && Number.isFinite(o.spread) ? { spread: num(o.spread, 0, 400, 45) } : {}),
    ...(typeof o.tilt === 'number' && Number.isFinite(o.tilt) ? { tilt: num(o.tilt, -80, 80, 0) } : {}),
    ...(typeof o.color === 'string' && HEX.test(o.color) ? { color: o.color.toLowerCase() } : {}),
    ...(typeof o.color2 === 'string' && HEX.test(o.color2) ? { color2: o.color2.toLowerCase() } : {}) };
}
const SECTIONS_OK: readonly string[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'];
function scriptOf(raw: unknown): FestivalScript | null {
  const x = asObj(raw);
  if (!Array.isArray(x.parts) || !x.parts.length) return null;
  const parts: FestivalScriptPart[] = [];
  for (const p of x.parts.slice(0, SCRIPT_MAX_PARTS)) {
    const o = asObj(p);
    if (typeof o.section !== 'string' || !SECTIONS_OK.includes(o.section)) continue;
    const sw = Array.isArray(o.swell) && o.swell.length >= 2 ? [num(o.swell[0], 0, 1, 0), num(o.swell[1], 0, 1, 0)] as [number, number] : undefined;
    parts.push({ bar: Math.round(num(o.bar, 0, SCRIPT_MAX_BARS, 0)), section: o.section as ScriptSection,
      ...(Array.isArray(o.text) ? { text: o.text.filter((t): t is string => typeof t === 'string').slice(0, 8).map((t) => t.slice(0, 60)) } : {}),
      ...(typeof o.every === 'number' ? { every: Math.round(num(o.every, 1, 64, 4)) } : {}),
      ...(typeof o.wall === 'string' && o.wall !== 'strobe' ? { wall: o.wall.slice(0, 16) } : {}), ...(typeof o.palette === 'string' && ID.test(o.palette) ? { palette: o.palette } : {}),
      ...(typeof o.motion === 'string' && ID.test(o.motion) ? { motion: o.motion } : {}), ...(sw ? { swell: sw } : {}),
      ...(typeof o.eyes === 'number' ? { eyes: num(o.eyes, 0, 1, 1) } : {}), ...(typeof o.master === 'number' ? { master: num(o.master, 0, 1.2, 1) } : {}),
      ...(Array.isArray(o.cams) ? { cams: o.cams.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c)).slice(0, 12) } : {}),
      ...(typeof o.camBars === 'number' ? { camBars: num(o.camBars, 0.5, 64, 2) } : {}), ...(typeof o.beams === 'number' ? { beams: num(o.beams, 0, 1.2, 1) } : {}) });
  }
  parts.sort((a, b) => a.bar - b.bar);
  if (!parts.length) return null;
  const cues: FestivalScriptCue[] = [];
  for (const c of Array.isArray(x.cues) ? x.cues.slice(0, SCRIPT_MAX_CUES) : []) { const st = cueStep(c); if (st) cues.push({ ...st, bar: Math.round(num(asObj(c).bar, 0, SCRIPT_MAX_BARS, 0)) }); }
  cues.sort((a, b) => a.bar * 4 + a.at - (b.bar * 4 + b.at));
  const last = parts[parts.length - 1].bar;
  return { id: typeof x.id === 'string' && ID.test(x.id) ? x.id : 'endshow', name: str(x.name, 40, 'Endshow'), bars: Math.round(num(x.bars, last + 1, SCRIPT_MAX_BARS, last + 16)), parts, cues,
    ...(typeof x.show === 'string' && ID.test(x.show) ? { show: x.show } : {}), ...(x.house === true ? { house: true } : {}), ...(x.camGrammar === true ? { camGrammar: true } : {}) };
}
/** A scripted show from any source (room data, the composer) → the sanitised script (null = not a show). */
export const sanitizeScript = (raw: unknown): FestivalScript | null => scriptOf(raw);
function ambientOf(raw: unknown): FestivalAmbient {
  const x = asObj(raw), d = DEFAULT_AMBIENT;
  const pair = (v: unknown, dv: [number, number]): [number, number] => (Array.isArray(v) && v.length >= 2 ? [num(v[0], 5, 3600, dv[0]), Math.max(num(v[0], 5, 3600, dv[0]), num(v[1], 5, 3600, dv[1]))] : dv);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && ID.test(n)).slice(0, 12) : []);
  return { on: x.on !== false, show: typeof x.show === 'string' && ID.test(x.show) ? x.show : '', talking: num(x.talking, 0, 1, d.talking), master: num(x.master, 0, 1, d.master),
    ripple: pair(x.ripple, d.ripple), swell: pair(x.swell, d.swell), big: pair(x.big, d.big), ripples: names(x.ripples), swells: names(x.swells), bigs: names(x.bigs), key: x.key !== false };
}
const isFile = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/.test(v) && !v.includes('..');

export function sanitizeFestivalConfig(raw: unknown): FestivalConfig | null {
  if (raw === true) raw = {};
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  const st = asObj(x.states);
  const states = { ...DEFAULT_FESTIVAL_STATES };
  for (const k of Object.keys(states) as LightingStateId[]) states[k] = num(st[k], 0, 1.5, states[k]);
  const palettes: FestivalConfig['palettes'] = [];
  for (const p of Array.isArray(x.palettes) ? x.palettes.slice(0, 24) : []) {
    const o = asObj(p);
    const colors = Array.isArray(o.colors) ? o.colors.filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 6).map((c) => c.toLowerCase()) : [];
    if (typeof o.id === 'string' && ID.test(o.id) && colors.length >= 2) palettes.push({ id: o.id, name: str(o.name, 32, o.id), colors, tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 8).map((t) => t.slice(0, 16)) : [] });
  }
  const shows: FestivalConfig['shows'] = [];
  for (const s of Array.isArray(x.shows) ? x.shows.slice(0, 24) : []) {
    const o = asObj(s);
    if (typeof o.id !== 'string' || !ID.test(o.id)) continue;
    const roles = o.roles !== undefined ? sanitizeRoles(o.roles) : null;
    shows.push({ id: o.id, name: str(o.name, 40, o.id), genre: str(o.genre, 16, 'hardstyle'), palettes: Array.isArray(o.palettes) ? o.palettes.filter((p): p is string => typeof p === 'string' && ID.test(p)).slice(0, 8) : [],
      ...(typeof o.dropCue === 'string' && ID.test(o.dropCue) ? { dropCue: o.dropCue } : {}), ...(typeof o.phraseCue === 'string' && ID.test(o.phraseCue) ? { phraseCue: o.phraseCue } : {}), ...(roles ? { roles } : {}) });
  }
  const walls: FestivalConfig['walls'] = {};
  for (const [k, v] of Object.entries(asObj(x.walls)).slice(0, 16)) {
    if (!GROUP.test(k)) continue;
    const o = asObj(v);
    // (a room can't lock a wall to the full-field 'strobe' card: that one only plays through the flash rule)
    walls[k] = { ...(typeof o.visual === 'string' && o.visual !== 'strobe' ? { visual: o.visual.slice(0, 16) } : {}), ...(typeof o.mirror === 'boolean' ? { mirror: o.mirror } : {}), ...(o.role === 'main' || o.role === 'side' || o.role === 'eye' ? { role: o.role } : {}), ...(o.pupil === 'slit' || o.pupil === 'round' ? { pupil: o.pupil } : {}), ...(typeof o.iris === 'string' && HEX.test(o.iris) ? { iris: o.iris.toLowerCase() } : {}) };
  }
  const shapes: FestivalConfig['shapes'] = {};
  for (const [k, v] of Object.entries(asObj(x.shapes)).slice(0, 12)) {
    if (!ID.test(k) || !Array.isArray(v)) continue;
    const pts = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 256).map((n) => Math.max(-1, Math.min(1, n)));
    if (pts.length >= 4) shapes[k] = pts.length % 2 ? pts.slice(0, -1) : pts;
  }
  const cues: FestivalConfig['cues'] = {};
  for (const [k, v] of Object.entries(asObj(x.cues)).slice(0, 32)) {
    if (!ID.test(k) || !Array.isArray(v)) continue;
    const steps: FestivalCueStep[] = [];
    for (const s of v.slice(0, 48)) { const st = cueStep(s); if (st) steps.push(st); }
    if (steps.length) cues[k] = steps;
  }
  const cr = asObj(x.crowd);
  const dr = asObj(x.drone);
  const v3 = (v: unknown, d: [number, number, number]): [number, number, number] => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] as [number, number, number] : d);
  return {
    on: x.on !== false,
    djSpot: typeof x.djSpot === 'string' && /^SPOT_\d{2}$/.test(x.djSpot) ? x.djSpot : null,
    floorY: num(x.floorY, -50, 50, 0), deckY: num(x.deckY, -50, 50, 2), deckFront: num(x.deckFront, -200, 200, 0),
    haze: num(x.haze, 0, 1, 0.7),
    night: num(x.night, 0, 1, 0.12),
    nightMetal: x.nightMetal !== false,
    wash: Array.isArray(asObj(x.wash).materials) ? { materials: (asObj(x.wash).materials as unknown[]).filter((m): m is string => typeof m === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(m)).slice(0, 16), strength: num(asObj(x.wash).strength, 0, 2, 0.3), white: num(asObj(x.wash).white, 0, 1, 0.6), ...(typeof asObj(x.wash).tint === 'string' && HEX.test(asObj(x.wash).tint as string) ? { tint: (asObj(x.wash).tint as string).toLowerCase() } : {}) } : null,
    states,
    defaultShow: typeof x.defaultShow === 'string' && (x.defaultShow === 'auto' || ID.test(x.defaultShow)) ? x.defaultShow : 'auto',
    palettes, shows,
    logo: isFile(x.logo) ? x.logo : null,
    title: str(x.title, 40, ''),
    walls, shapes, cues,
    crowd: { unit: isFile(cr.unit) ? cr.unit : null, color: typeof cr.color === 'string' && HEX.test(cr.color) ? cr.color.toLowerCase() : '#1a1d26', density: num(cr.density, 0, 3, 1),
      boost: num(cr.boost, 1, 12, 1), lit: num(cr.lit, 0, 2, 1), rim: typeof cr.rim === 'string' && HEX.test(cr.rim) ? cr.rim.toLowerCase() : null, flagsFar: num(cr.flagsFar, 0, 1, 0), top: num(cr.top, 0, 1, 1), flags: Math.round(num(cr.flags, 0, 400, 0)), flagColors: Array.isArray(cr.flagColors) ? cr.flagColors.filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 12).map((c) => c.toLowerCase()) : [] },
    djCam: x.djCam === true, flameScale: num(x.flameScale, 0.5, 4, 1), flamePatterns: x.flamePatterns === true,
    showCams: (() => {   // (no valid camera left = no director at all, never an armed director with an empty list)
      const sc = asObj(x.showCams), cams = Array.isArray(sc.cams) ? (sc.cams as unknown[]).filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(c)).slice(0, 24) : [];
      // (grammar: true = cut by the music-locked camera grammar, shared/festivalCamGrammar.ts, instead of every `bars` bars)
      return cams.length ? { cams, bars: Math.round(num(sc.bars, 2, 32, 8)), ...(sc.grammar === true ? { grammar: true } : {}) } : null;
    })(),
    drone: x.drone ? { center: v3(dr.center, [0, 6, 0]), radius: num(dr.radius, 4, 300, 30), height: num(dr.height, 2, 200, 18), secs: num(dr.secs, 8, 240, 40) } : null,
    swell: typeof asObj(x.swell).node === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(asObj(x.swell).node as string) ? { node: asObj(x.swell).node as string, max: num(asObj(x.swell).max, 1, 2, 1.3) } : null,
    script: x.script ? scriptOf(x.script) : null,
    ambient: ambientOf(x.ambient),
    fxScale: num(x.fxScale, 0.5, 3, 1),
    flameWidth: num(x.flameWidth, 0.5, 3, 1), flameSmoke: x.flameSmoke === true,
    shellScale: typeof x.shellScale === 'number' ? num(x.shellScale, 0.2, 3, 1) : null, shellsPerHit: num(x.shellsPerHit, 1, 4, 1),
    boost: num(x.boost, 1, 3, 1),
    beamGain: num(x.beamGain, 0.05, 2, 1),
    laserGain: num(x.laserGain, 0.05, 2, 1),
    packPool: x.packPool === 'full' ? 'full' : 'show',
    packShare: num(x.packShare, 0.3, 0.95, 0.6),
    fireLights: Array.isArray(asObj(x.fireLights).groups) ? { groups: (asObj(x.fireLights).groups as unknown[]).filter((g): g is string => typeof g === 'string' && GROUP.test(g)).slice(0, 8), count: Math.round(num(asObj(x.fireLights).count, 1, 6, 4)), intensity: num(asObj(x.fireLights).intensity, 0, 2000, 300), range: num(asObj(x.fireLights).range, 5, 300, 60) } : null,
    // the house look: 'mainstage' turns on the structure layer and the lit smoke too, unless the room says false
    house: x.house === 'mainstage' || x.house === 'mainstage_magenta' ? x.house : null,
    structure: x.structure === false ? null : x.structure !== undefined ? sanitizeStructure(x.structure) : x.house === 'mainstage' || x.house === 'mainstage_magenta' ? sanitizeStructure(true) : null,
    smoke: x.smoke === false ? null : x.smoke !== undefined ? sanitizeSmoke(x.smoke) : x.house === 'mainstage' || x.house === 'mainstage_magenta' ? sanitizeSmoke(true) : null,
  };
}

// ---------------------------------------------------------------------------------------------------- host state
/** Manual effect cues (Scene tab buttons, Stream Deck, MCP): stamped with the host's epoch ms so every page fires the
 *  same burst at the same moment. */
export const FESTIVAL_CUE_KINDS = ['drop', 'flames', 'co2', 'confetti', 'fireworks', 'gerbs', 'blinders', 'blackout', 'big'] as const;
export type FestivalCueKind = (typeof FESTIVAL_CUE_KINDS)[number];
export interface FestivalCue { k: FestivalCueKind | `cue:${string}`; at: number; seed: number }
/** The Look Lab result: looks the curator killed / starred, as bitmasks over the generated look list of `v`
 *  (LOOKS_VERSION in shared/festivalLooks.ts; another version = the list changed and the curation is ignored). */
export interface FestivalCuration { v: number; kill: string; fav: string }
export interface SceneFestivalState {
  /** 'auto' (by the music's tempo) or a show id */
  show: string;
  /** special effects (flames, CO2, confetti, gerbs, comets, fireworks) */
  pyro: boolean;
  /** master level 0..1.5 */
  intensity: number;
  /** pin one look (Look Lab "use this look"), '' = the show decides */
  look: string;
  curation?: FestivalCuration;
  cues: FestivalCue[];
  /** the room's scripted show (festival.script) started at this epoch ms (missing = not playing) */
  endshow?: number;
  /** false = the endshow leaves the camera alone (its cuts are on by default) */
  showCams?: boolean;
  /** a composed endshow (shared/festivalCompose.ts): the template + its settings; with `endshow` set it plays instead of
   *  the room's own script (every page composes the same show from these numbers and the room's anchors) */
  compose?: ComposeState;
}
export const DEFAULT_FESTIVAL_STATE: SceneFestivalState = { show: 'auto', pyro: true, intensity: 1, look: '', cues: [] };
const CUE_RX = /^(drop|flames|co2|confetti|fireworks|gerbs|blinders|blackout|big|cue:[a-z0-9_]{1,40})$/;
const B64 = /^[A-Za-z0-9+/=_-]{0,400}$/;
export function sanitizeFestivalState(raw: unknown): SceneFestivalState {
  const x = asObj(raw);
  const cues: FestivalCue[] = [];
  for (const c of Array.isArray(x.cues) ? x.cues.slice(-8) : []) {
    const o = asObj(c);
    if (typeof o.k === 'string' && CUE_RX.test(o.k) && typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 && o.at < 1e14) cues.push({ k: o.k as FestivalCue['k'], at: o.at, seed: Math.round(num(o.seed, 0, 2 ** 31, 0)) });
  }
  const cu = asObj(x.curation);
  return {
    show: typeof x.show === 'string' && (x.show === 'auto' || ID.test(x.show)) ? x.show : 'auto',
    pyro: x.pyro !== false,
    intensity: num(x.intensity, 0, 1.5, 1),
    look: typeof x.look === 'string' && /^[a-z0-9]{0,12}$/.test(x.look) ? x.look : '',
    ...(typeof cu.v === 'number' && typeof cu.kill === 'string' && B64.test(cu.kill) && typeof cu.fav === 'string' && B64.test(cu.fav) ? { curation: { v: Math.round(cu.v), kill: cu.kill, fav: cu.fav } } : {}),
    cues,
    ...(typeof x.endshow === 'number' && Number.isFinite(x.endshow) && x.endshow > 0 && x.endshow < 1e14 ? { endshow: x.endshow } : {}),
    ...(x.showCams === false ? { showCams: false } : {}),
    ...(x.compose !== undefined && sanitizeCompose(x.compose) ? { compose: sanitizeCompose(x.compose)! } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------- bitsets (curation)
export function bitsToB64(bits: boolean[]): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64')).replace(/=+$/, '');
}
export function b64ToBits(b64: string, n: number): boolean[] {
  let s = '';
  try { s = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'); } catch { s = ''; }
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(((s.charCodeAt(i >> 3) || 0) >> (i & 7) & 1) === 1);
  return out;
}

// ---------------------------------------------------------------------------------------------------- small maths
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const fract = (v: number) => v - Math.floor(v);
/** Deterministic hash → 0..1 of up to three integers. */
export function hash3(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** sRGB hex → [r, g, b] 0..1 (sRGB). */
export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Apply a host edit (Scene tab, Stream Deck, MCP) to the festival state: plain fields are sanitised, `cue` stamps a
 *  manual effect at `at` (epoch ms, a little ahead so every page fires it together). */
/** The festival state when the host moves to another room: a composed endshow (and a playing one) is this stage's - it
 *  never follows the host into another room's endshow; everything else (show, pyro, intensity, curation) stays. */
export function festivalLeavingRoom(f: SceneFestivalState): SceneFestivalState {
  if (!f.compose && !f.endshow) return f;
  const { compose: _c, endshow: _e, ...rest } = f;
  void _c; void _e;
  return rest;
}

export function festivalPatch(cur: SceneFestivalState, p: Partial<SceneFestivalState> & { cue?: string }, at: number): SceneFestivalState {
  const { cue, ...rest } = p;
  const next = sanitizeFestivalState({ ...cur, ...rest, cues: cur.cues });
  // an endshow started or stopped WITHOUT a compose choice: the composed show is over - a bare start plays the stage's own
  // endshow (Stream Deck {"endshow":1}), a stop leaves no composed show behind to take over the next start
  if ('endshow' in rest && !('compose' in rest)) delete next.compose;
  if (typeof cue === 'string' && CUE_RX.test(cue)) {
    next.cues = [...next.cues.filter((c) => c.at > at - 5 * 60_000).slice(-7), { k: cue as FestivalCue['k'], at, seed: (Math.random() * 2 ** 31) >>> 0 }];
  }
  return next;
}

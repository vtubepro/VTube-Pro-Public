// Beat-reactive room lights: the per-group programs, presets ("shows") and the compact beat packet the
// studio's beat analysis (src/audio/beat/) sends to every OBS page. Pure data — shared by the studio (Scene tab),
// the OBS output (src/scene/lightShow.ts) and the sanitiser (shared/scene.ts). See docs/SCENES.md "Lights".
import type { LightGroupSetting, LightProgram, LightingLook, LightingStateId, SceneLightsState } from './types.ts';
import { PRESET_ID_ALIASES, SHOW_PRESETS, canonPresetId, canonPresetKey, presetById, presetGroup, type ShowPreset } from './lightPresets.ts';
import { sanitizeLightStyleId } from './lightStyles.ts';

export const LIGHT_PROGRAMS: { id: LightProgram; label: string; hint: string }[] = [
  { id: 'steady', label: 'Steady', hint: 'On at the authored colour' },
  { id: 'pulse', label: 'Pulse on kick', hint: 'Flashes up on every kick drum (on the beat grid if the track has no kick)' },
  { id: 'chase', label: 'Chase', hint: 'The fixtures of the group light one after another, left to right, one sweep per bar' },
  { id: 'strobe', label: 'Strobe on snare/hat', hint: 'Short flashes on snares (and hats at speed ≥ 2) — capped by the photosensitivity limit' },
  { id: 'breathe', label: 'Breathe', hint: 'Slow swell locked to the tempo (one breath per bar at speed 1)' },
  { id: 'cycle', label: 'Colour cycle on bar', hint: 'Steps through colours on every bar, glows with the beat' },
  { id: 'flicker', label: 'Flicker (neon buzz)', hint: 'Buzzing neon with the odd drop-out — ambient, runs without music too' },
  { id: 'drift', label: 'Drift', hint: 'Slow random glow (fireflies) — ambient, a little brighter with the music' },
  { id: 'drop', label: 'Drop mode', hint: 'Steady, then peaks when the track drops (dims in breakdowns, rises in builds)' },
  { id: 'off', label: 'Off', hint: 'Dark' },
];
const PROGRAM_IDS = new Set<string>(LIGHT_PROGRAMS.map((p) => p.id));
/** Programs that don't need music (they keep running when idle / not reactive). */
export const AMBIENT_PROGRAMS = new Set<LightProgram>(['steady', 'flicker', 'drift', 'off']);

const G = (program: LightProgram, intensity = 1, speed = 1): LightGroupSetting => ({ program, intensity, speed, color: null });

/** The room's default show, by group name (tuned on the VTube Pro studio; any room's groups map by name). */
function showFor(group: string): LightGroupSetting {
  const g = group.toLowerCase();
  if (/sign/.test(g)) return G('pulse');
  if (/neon/.test(g)) return G('breathe');
  if (/spot/.test(g)) return G('chase');
  if (/firefl|star|spark|glow/.test(g)) return G('drift');
  if (/on_?air|onair|rec/.test(g)) return G('steady');
  if (/accent|rgb|strip/.test(g)) return G('cycle', 0.9);
  if (/board|led|panel|monitor/.test(g)) return G('strobe', 0.8);
  if (/lava/.test(g)) return G('breathe', 1, 0.25);
  if (/aqua|tank|water/.test(g)) return G('breathe', 1, 0.5);
  if (/lamp|practical|string|fairy/.test(g)) return G('drop');
  return G('pulse');
}

/** Presets (SceneLightsState.program). Unknown names (e.g. a room's own scene.json list) fall back to 'show'. */
export const LIGHT_PRESETS: Record<string, { label: string; group: (g: string) => LightGroupSetting }> = {
  show: { label: 'Room show (default)', group: showFor },
  steady: { label: 'All steady', group: () => G('steady') },
  swampGlow: {
    label: 'Mellow glow',
    group: (g) => (/firefl/.test(g) ? G('drift') : /neon/.test(g) ? G('flicker') : /on_?air/.test(g) ? G('steady') : /spot/.test(g) ? G('breathe', 0.8, 0.5) : G('breathe', 0.9, 0.5)),
  },
  onAir: { label: 'On air (steady, ON AIR bright)', group: (g) => (/on_?air/.test(g) ? G('steady', 1.4) : /firefl/.test(g) ? G('drift') : G('steady', 0.8)) },
  beatPulse: { label: 'Beat pulse', group: (g) => (/spot/.test(g) ? G('chase') : /firefl/.test(g) ? G('drift') : /on_?air/.test(g) ? G('steady') : G('pulse')) },
  strobe: {
    label: 'Strobe',
    group: (g) => (/spot|board|neon/.test(g) ? G('strobe') : /firefl/.test(g) ? G('drift') : /on_?air/.test(g) ? G('steady') : G('pulse')),
  },
  party: {
    label: 'Party',
    group: (g) => {
      if (/sign/.test(g)) return G('pulse', 1.2);
      if (/neon|accent/.test(g)) return G('cycle');
      if (/spot/.test(g)) return G('chase', 1, 2);
      if (/board/.test(g)) return G('strobe');
      if (/firefl/.test(g)) return G('drift', 1.2, 2);
      if (/on_?air/.test(g)) return G('steady');
      return G('drop');
    },
  },
};

// club / state presets (lighting states, see LIGHTING_STATES)
const banger = (g: string): LightGroupSetting => {
  if (/sign/.test(g)) return G('pulse', 1.6);
  if (/neon/.test(g)) return G('cycle', 1.5);
  if (/accent|rgb|strip/.test(g)) return G('cycle', 1.4, 2);
  if (/on_?air|onair/.test(g)) return G('off');
  if (/spot/.test(g)) return G('chase', 1.4, 2);
  if (/firefl|star|spark/.test(g)) return G('drift', 1.8, 3);
  if (/board|led|panel/.test(g)) return G('strobe', 1.2, 2);
  if (/lamp|practical/.test(g)) return G('steady', 0.12);
  if (/string|fairy/.test(g)) return G('chase', 1.2);
  if (/lava/.test(g)) return G('breathe', 1.2, 0.5);
  if (/aqua|tank/.test(g)) return G('pulse', 1.2);
  return G('pulse', 1.3);
};
LIGHT_PRESETS.banger = { label: 'Banger (club)', group: banger };
LIGHT_PRESETS.brb = {
  label: 'BRB (slow breathe)',
  group: (g) => (/on_?air/.test(g) ? G('steady', 0.4) : /firefl/.test(g) ? G('drift', 0.9, 0.5) : /lamp/.test(g) ? G('steady', 0.45) : /spot/.test(g) ? G('breathe', 0.35, 0.25) : G('breathe', 0.7, 0.25)),
};
LIGHT_PRESETS.afterparty = {
  label: 'Afterparty (warm, slower)',
  group: (g) => { const x = banger(g); return /board/.test(g) ? G('pulse', 0.9) : /lamp/.test(g) ? G('steady', 0.25) : { ...x, speed: Math.max(0.25, x.speed * 0.5), intensity: Math.min(2, x.intensity * 0.9) }; },
};

export const LIGHTING_STATES: { id: LightingStateId; label: string; key: string; hint: string }[] = [
  { id: 'preshow', label: 'Preshow', key: '1', hint: 'House lights off, full club show (beams, lasers, mirror ball) on the music input, or a built-in auto show' },
  { id: 'show', label: 'Show', key: '2', hint: 'Normal studio lighting (Beat reactive only if you turned it on)' },
  { id: 'react', label: 'React', key: '3', hint: 'House a little dimmed, towards the screen' },
  { id: 'brb', label: 'BRB', key: '4', hint: 'Dim, slow breathing lights' },
  { id: 'outro', label: 'Outro', key: '5', hint: 'Afterparty: like preshow, warmer and slower' },
];
const STATE_IDS = new Set<string>(LIGHTING_STATES.map((s) => s.id));
export const isLightingState = (v: unknown): v is LightingStateId => typeof v === 'string' && STATE_IDS.has(v);

/** A state look built from a show preset. */
export function lookFromPreset(p: ShowPreset, music: 'auto' | 'user' = 'auto'): LightingLook {
  return { house: p.house, tint: p.tint, program: `p_${p.id}`, fx: p.fx, palette: `p_${p.id}`, music, energy: p.energy, preset: p.id };
}

/**
 * House slider → the room's actual light level. 0 is NOT black: it is a moody low-light floor (16 %, plus the
 * practicals kept on — see PRACTICAL_FLOOR), rising perceptually to 1 = the authored lighting; above 1 brightens.
 */
export const HOUSE_FLOOR = 0.16;
export const houseLevel = (v: number) => (v >= 1 ? v : HOUSE_FLOOR + (1 - HOUSE_FLOOR) * Math.pow(Math.max(0, v), 1.25));
/** Practical fixtures (lamps, lava lamp, sign, string lights, ON AIR, tanks) stay lit at least this much when the house is down. */
export const PRACTICAL_FLOOR: Record<string, number> = { lamps: 0.6, lava: 0.7, sign: 0.55, string: 0.55, onair: 0.3, aqua: 0.45, fireflies: 0.5 };

export const DEFAULT_LOOKS: Record<LightingStateId, LightingLook> = {
  preshow: lookFromPreset(presetById('house_party')!),
  show: { house: 1, tint: null, program: '', fx: 0, palette: 'authored', music: 'user', energy: 1 },
  react: { house: 0.6, tint: null, program: '', fx: 0, palette: 'authored', music: 'user', energy: 1 },
  brb: { ...lookFromPreset(presetById('lofi_rain')!), house: 0.3 },
  outro: lookFromPreset(presetById('sunset_sway')!),
};

/** The look a state has now: the host's edit, else the default. SHOW's groups are always the top-level settings. */
export function lookOf(l: SceneLightsState, id: LightingStateId): LightingLook {
  return (id !== 'show' && l.states?.[id]) || DEFAULT_LOOKS[id];
}
/** Group setting inside a look ('' program = follow SHOW). */
export function resolveLookGroup(l: SceneLightsState, look: LightingLook, group: string): LightGroupSetting {
  if (!look.program) return resolveGroup(l, group);
  return look.groups?.[group] ?? (LIGHT_PRESETS[look.program] ?? LIGHT_PRESETS.show).group(group);
}

/** Effects palettes: [A, B] colour pairs; the show moves to the next pair every phrase (8 bars) and on drops. */
export const PALETTES: Record<string, { label: string; pairs: [string, string][] }> = {
  authored: { label: 'Authored colours', pairs: [['#fff1d6', '#fff1d6']] },
  club: { label: 'Club (neon pairs)', pairs: [['#ff2bd6', '#00e5ff'], ['#7c3cff', '#00ff9c'], ['#ff5a00', '#ffd000'], ['#00a2ff', '#ff006a'], ['#b026ff', '#ff2b2b'], ['#00ffd5', '#ff4fd8']] },
  sunset: { label: 'Sunset (warm)', pairs: [['#ff7a2b', '#ffb347'], ['#ff3d6e', '#ffa53b'], ['#c83dff', '#ff8a3b'], ['#ff5050', '#ffd27a']] },
  uv: { label: 'UV (violet / blue)', pairs: [['#7a2bff', '#2b6bff'], ['#b04bff', '#4b2bff'], ['#5a00ff', '#ff00d4']] },
  ice: { label: 'Ice (cyan / white)', pairs: [['#00d0ff', '#e8f6ff'], ['#4b9bff', '#b0fff4'], ['#00ffe0', '#9fb8ff']] },
};

// every show preset: its palette + group programs, under 'p_<id>'
for (const sp of SHOW_PRESETS) {
  PALETTES[`p_${sp.id}`] = { label: sp.name, pairs: sp.palette };
  LIGHT_PRESETS[`p_${sp.id}`] = { label: sp.name, group: (g) => presetGroup(sp, g) };
}
// retired preset ids still resolve ('p_frog_disco' → 'p_disco_fever'), but hidden from every list / dropdown
for (const [old, cur] of Object.entries(PRESET_ID_ALIASES)) {
  if (PALETTES[`p_${cur}`]) Object.defineProperty(PALETTES, `p_${old}`, { value: PALETTES[`p_${cur}`], enumerable: false });
  if (LIGHT_PRESETS[`p_${cur}`]) Object.defineProperty(LIGHT_PRESETS, `p_${old}`, { value: LIGHT_PRESETS[`p_${cur}`], enumerable: false });
}

function sanitizeLook(o: unknown): LightingLook | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  return {
    house: num(x.house, 0, 1.2, 1),
    tint: typeof x.tint === 'string' && HEX.test(x.tint) ? x.tint.toLowerCase() : null,
    program: typeof x.program === 'string' && (x.program === '' || /^[A-Za-z0-9_]{1,48}$/.test(x.program)) ? canonPresetKey(x.program) : '',
    ...(typeof x.preset === 'string' && presetById(x.preset) ? { preset: canonPresetId(x.preset) } : {}),
    ...(x.cycle && typeof x.cycle === 'object' && typeof (x.cycle as Record<string, unknown>).cat === 'string'
      ? { cycle: { cat: String((x.cycle as Record<string, unknown>).cat).slice(0, 16), every: Math.round(num((x.cycle as Record<string, unknown>).every, 1, 16, 2)) } } : {}),
    groups: sanitizeLightGroups(x.groups),
    fx: num(x.fx, 0, 1, 0),
    palette: typeof x.palette === 'string' && PALETTES[canonPresetKey(x.palette)] ? canonPresetKey(x.palette) : 'authored',
    music: x.music === 'auto' ? 'auto' : 'user',
    energy: num(x.energy, 0.25, 2, 1),
    ...(typeof x.style === 'string' && (x.style === 'none' || sanitizeLightStyleId(x.style)) ? { style: x.style === 'none' ? 'none' : sanitizeLightStyleId(x.style) } : {}),
  };
}
export function sanitizeLooks(o: unknown): Partial<Record<LightingStateId, LightingLook>> | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const out: Partial<Record<LightingStateId, LightingLook>> = {};
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (!isLightingState(k) || k === 'show') continue;
    const look = sanitizeLook(v);
    if (look) { out[k] = look; n++; }
  }
  return n ? out : undefined;
}

/** What a group does: the host's explicit setting, else the preset's. */
export function resolveGroup(l: SceneLightsState, group: string): LightGroupSetting {
  return l.groups?.[group] ?? (LIGHT_PRESETS[l.program] ?? LIGHT_PRESETS.show).group(group);
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const GROUP = /^[A-Za-z0-9_-]{1,32}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function sanitizeLightGroups(o: unknown): Record<string, LightGroupSetting> | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const out: Record<string, LightGroupSetting> = {};
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (n >= 32 || !GROUP.test(k) || !v || typeof v !== 'object') continue;
    const x = v as Record<string, unknown>;
    out[k] = {
      program: typeof x.program === 'string' && PROGRAM_IDS.has(x.program) ? (x.program as LightProgram) : 'steady',
      intensity: num(x.intensity, 0, 2, 1),
      speed: num(x.speed, 0.25, 4, 1),
      color: typeof x.color === 'string' && HEX.test(x.color) ? x.color.toLowerCase() : null,
    };
    n++;
  }
  return n ? out : undefined;
}

// ---------------------------------------------------------------- beat packets (studio → OBS pages / guests)
/**
 * One sample of the studio's beat analysis (~30 Hz, plus one immediately on every kick / snare / drop).
 * Times are EPOCH ms (performance.timeOrigin + performance.now()) of the sender; receivers estimate the clock
 * offset from the fastest packets (same PC ≈ 1 ms, party guests ≈ the one-way network delay), phase-lock their own
 * grid to `bi + ph` and free-run on the BPM when packets are late.
 */
export interface BeatPacket {
  /** Stream id (a new capture / engine = new id → receivers reset their clock). */
  sid: string;
  /** Sender epoch ms this sample describes. */
  t: number;
  /** Audio is flowing and above the silence gate. */
  on: boolean;
  bpm: number;
  /** Beat index and phase (0..1) at t; bar = beat within the bar (0 = downbeat). */
  bi: number;
  ph: number;
  bar: number;
  /** Grid confidence 0..1, locked. */
  cf: number;
  lk: boolean;
  /** Events since the previous packet: EV_* bits. */
  ev: number;
  /** Age (ms before t) of the newest kick / snare / drop in `ev`. */
  ka?: number;
  sa?: number;
  /** Envelopes 0..1: show energy, low / mid / high band, kick, snare, hat, drop. */
  e: number;
  lo: number;
  mi: number;
  hi: number;
  k: number;
  s: number;
  h: number;
  d: number;
  /** Arrangement: SECTIONS index (stable: changes on bar lines with hysteresis, drops on the downbeat). */
  sec: number;
  // ---- optional (lights overhaul; older senders omit them, older receivers ignore them)
  /** Audio mode: AUDIO_MODES index 0 silence · 1 music · 2 talk (voice, no music → on:false) · 3 mixed (talking over music). */
  md?: number;
  /** Music confidence 0..1. */
  mc?: number;
  /** Kick presence 0..1: share of recent beats with a kick (receivers pulse on the grid, latency-free, when high). */
  kp?: number;
  /** Beat within the current 8-bar phrase (0..31) and the phrase counter (bumps on every section change + every 8
   *  bars): receivers rotate looks on it, so every page changes at the same moment. */
  pb?: number;
  pid?: number;
  /** Drop counter (a new value = a new drop). */
  dc?: number;
  /** Clock source (djsync's MusicClock extends this packet): 'audio' (default) or a DJ protocol. Receivers prefer a
   *  live non-audio source for tempo / phase / phrase; envelopes + kicks keep coming from audio. */
  src?: string;
  srcQ?: number;
  /** The groove on THIS packet's grid (shared/groove.ts; rhythm lane): feel (FEELS index), confidence 0..1, the hits as
   *  flat [slot 0..15 from the downbeat, ±weight·100 (+ kick, − snare), offset from the slot in 1/1000 beat] triples,
   *  off-8th swing. Sent when it changes and once a second; receivers keep the last one. */
  gf?: number;
  gc?: number;
  gh?: number[];
  gw?: number;
  /** The sender's LATCHED show feel (shared/groove.ts FeelLatch): FEELS index, −1 = none yet. Sent with gf; pages copy
   *  it, so a page opened mid-build plays the same 'auto' show family as one open for hours. Absent = an older sender. */
  sf?: number;
  /** True-time drum onsets since the previous packet (src/audio/beat/drumOnsets.ts): flat [age ms before t, ±strength·100
   *  (+ kick, − snare)] pairs. The helper's music clock learns the groove on a DJ clock's grid from them. */
  go?: number[];
}
export const AUDIO_MODES = ['silence', 'music', 'talk', 'mixed'] as const;
export const EV_KICK = 1, EV_SNARE = 2, EV_BEAT = 4, EV_DOWN = 8, EV_DROP = 16, EV_HARD = 32, EV_HAT = 64;
export const SECTIONS = ['listening', 'intro', 'groove', 'buildup', 'breakdown', 'drop', 'chorus'] as const;

export function sanitizeBeatPacket(o: unknown): BeatPacket | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (typeof x.sid !== 'string' || !/^[a-z0-9]{1,24}$/.test(x.sid) || typeof x.t !== 'number' || !Number.isFinite(x.t)) return null;
  const u = (v: unknown) => num(v, 0, 1, 0);
  return {
    sid: x.sid, t: x.t, on: x.on === true,
    bpm: num(x.bpm, 0, 300, 0), bi: Math.round(num(x.bi, -1e9, 1e9, 0)), ph: num(x.ph, 0, 1, 0), bar: Math.round(num(x.bar, 0, 3, 0)),
    cf: u(x.cf), lk: x.lk === true, ev: Math.round(num(x.ev, 0, 127, 0)),
    ka: typeof x.ka === 'number' ? num(x.ka, 0, 1000, 0) : undefined, sa: typeof x.sa === 'number' ? num(x.sa, 0, 1000, 0) : undefined,
    e: u(x.e), lo: u(x.lo), mi: u(x.mi), hi: u(x.hi), k: u(x.k), s: u(x.s), h: u(x.h), d: u(x.d),
    sec: Math.round(num(x.sec, 0, SECTIONS.length - 1, 0)),
    ...(typeof x.md === 'number' ? { md: Math.round(num(x.md, 0, AUDIO_MODES.length - 1, 1)) } : {}),
    ...(typeof x.mc === 'number' ? { mc: u(x.mc) } : {}),
    ...(typeof x.kp === 'number' ? { kp: u(x.kp) } : {}),
    ...(typeof x.pb === 'number' ? { pb: Math.round(num(x.pb, 0, 127, 0)) } : {}),
    ...(typeof x.pid === 'number' ? { pid: Math.round(num(x.pid, 0, 1e9, 0)) } : {}),
    ...(typeof x.dc === 'number' ? { dc: Math.round(num(x.dc, 0, 1e9, 0)) } : {}),
    ...(typeof x.src === 'string' && /^[a-z0-9-]{1,16}$/.test(x.src) ? { src: x.src } : {}),
    ...(typeof x.srcQ === 'number' ? { srcQ: u(x.srcQ) } : {}),
    ...(typeof x.gf === 'number' && Number.isInteger(x.gf) && x.gf >= 0 && x.gf <= 5 && typeof x.gc === 'number' ? { gf: x.gf, gc: u(x.gc) } : {}),
    ...(Array.isArray(x.gh) && x.gh.length <= 48 && x.gh.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1000) ? { gh: (x.gh as number[]).map((v) => Math.round(v)) } : {}),
    ...(typeof x.gw === 'number' ? { gw: num(x.gw, 0.4, 0.8, 0.5) } : {}),
    ...(typeof x.sf === 'number' && Number.isInteger(x.sf) && x.sf >= -1 && x.sf <= 5 ? { sf: x.sf } : {}),
    ...(Array.isArray(x.go) && x.go.length <= 32 && x.go.length % 2 === 0 && x.go.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1000) ? { go: (x.go as number[]).map((v) => Math.round(v)) } : {}),
  };
}

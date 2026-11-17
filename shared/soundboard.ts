// Soundboard stings + screen FX presets (beta.16 "soundfx" lane, docs/b16/SOUNDFX.md). Everything pure lives here, with no
// DOM, no audio and no file system, so the studio, the OBS page, the helper and tools/soundboard_unit.ts share one set of
// rules and the tests can run without making a sound. Four parts:
//
//   1. SOUNDS   which sounds exist (12 CC0 starter stings, 7 built-in synth sounds, the streamer's own uploads) + the ids.
//   2. CONFIG   config/soundboard.json: master switch (OFF), volume, per-sound volume, "when X happens play Y" cues, and the
//               scream detector. Sanitised on every read and write (content from disk / the network is never trusted).
//   3. GATES    SoundGate (at most N voices, no machine-gun repeats, a per-minute cap), LoudDetector (loudness above a level
//               for N ms: the "scream" trigger), cue matching.
//   4. FX       the six screen presets: argument sanitising, FxTimeline (what is running and how strongly, per preset),
//               FxGovern (the flash limit: shared/flashGovernor.ts decides how fast the picture may brighten), noise seeds that
//               change at most 3 times a second while the limit is on.
//
// Sounds only ever play in the STUDIO window (the one window that plays the show: src/audio/mixer/showSounds.ts); the OBS page
// is silent by design (src/audio/silentPage.ts) and your stream hears the studio the way it hears your guests. They are OFF
// until the streamer switches them on.
import { FlashGovernor, govChannel, governK, type GovChannel } from './flashGovernor.ts';
import type { RuleEvent } from './streamRules.ts';

// ---------------------------------------------------------------- 1. sounds

export const SOUNDBOARD_VERSION = 1;
/** The streamer's own sounds. */
export const MAX_USER_SOUNDS = 60;
export const MAX_SOUND_BYTES = 3 << 20;
/** A sting is short; the panel refuses longer clips (the studio decodes them whole). */
export const MAX_SOUND_SECS = 20;
export const MAX_CUES = 40;
/** Any id the deck / rules / bus may carry (shared/deck.ts EXTRA_ID). */
export const SOUND_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const USER_ID_RE = /^u[a-f0-9]{16}$/;

export interface StarterSting { id: string; name: string; file: string }
/** CC0 (Kenney) files in assets/library/stings/ (LICENSE.txt there). */
export const STARTER_STINGS: readonly StarterSting[] = [
  { id: 'st_bell', name: 'Bell', file: 'bell.ogg' },
  { id: 'st_bonk', name: 'Bonk', file: 'bonk.ogg' },
  { id: 'st_punch', name: 'Punch', file: 'punch.ogg' },
  { id: 'st_glass', name: 'Glass break', file: 'glass.ogg' },
  { id: 'st_clang', name: 'Clang', file: 'clang.ogg' },
  { id: 'st_crash', name: 'Crash', file: 'crash.ogg' },
  { id: 'st_thud', name: 'Thud', file: 'thud.ogg' },
  { id: 'st_pickaxe', name: 'Pickaxe', file: 'pickaxe.ogg' },
  { id: 'st_pop', name: 'Pop', file: 'pop.ogg' },
  { id: 'st_tin', name: 'Tin can', file: 'tin.ogg' },
  { id: 'st_click', name: 'Click', file: 'click.ogg' },
  { id: 'st_blip', name: 'Blip', file: 'blip.ogg' },
];
export interface SynthSting { id: string; name: string; /** the studio's built-in synth (shared/emoteSounds.ts BUILTIN_EMOTE_SOUNDS) */ synth: string }
/** Synthesised by the studio itself (src/audio/mixer/emoteSynth.ts): no file. */
export const SYNTH_STINGS: readonly SynthSting[] = [
  { id: 'sy_tada', name: 'Ta-da', synth: 'tada' },
  { id: 'sy_horn', name: 'Air horn', synth: 'horn' },
  { id: 'sy_siren', name: 'Siren', synth: 'siren' },
  { id: 'sy_ding', name: 'Ding', synth: 'ding' },
  { id: 'sy_coin', name: 'Coin', synth: 'coin' },
  { id: 'sy_boing', name: 'Boing', synth: 'boing' },
  { id: 'sy_laser', name: 'Laser', synth: 'laser' },
];
const STARTER_BY_ID = new Map(STARTER_STINGS.map((s) => [s.id, s]));
const SYNTH_BY_ID = new Map(SYNTH_STINGS.map((s) => [s.id, s]));

export type SoundKind = 'sting' | 'synth' | 'mine';
/** What a sound is, or null for an id that is not a sound id at all (a user sound is "mine" even if the file is gone). */
export function soundKind(id: unknown): SoundKind | null {
  if (typeof id !== 'string') return null;
  if (STARTER_BY_ID.has(id)) return 'sting';
  if (SYNTH_BY_ID.has(id)) return 'synth';
  return USER_ID_RE.test(id) ? 'mine' : null;
}
export const starterSting = (id: string): StarterSting | undefined => STARTER_BY_ID.get(id);
export const synthSting = (id: string): SynthSting | undefined => SYNTH_BY_ID.get(id);
export const isSoundId = (id: unknown): id is string => soundKind(id) !== null;

/** One entry of the panel's list. */
export interface SoundInfo { id: string; name: string; kind: SoundKind; bytes?: number }
/** The streamer's upload, as the helper's index keeps it (library/sounds/board/index.json). */
export interface UserSoundRec { id: string; name: string; type: string; bytes: number }
export const AUDIO_EXT: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm' };

/** What the bytes are (never what the name or the browser says). Same checks as server/chat/emoteSounds.ts sniffAudio. */
export function sniffAudioBytes(b: Uint8Array): { type: string; ext: string } | null {
  if (b.length < 12) return null;
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (s(0, 4) === 'OggS') return { type: 'audio/ogg', ext: 'ogg' };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return { type: 'audio/wav', ext: 'wav' };
  if (s(0, 4) === 'fLaC') return { type: 'audio/flac', ext: 'flac' };
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { type: 'audio/mpeg', ext: 'mp3' };
  if (s(4, 4) === 'ftyp') return { type: 'audio/mp4', ext: 'm4a' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'audio/webm', ext: 'webm' };
  return null;
}
/** A name for the panel: letters, digits, spaces and . _ ( ) - only. */
export const cleanSoundName = (v: unknown, fallback = 'My sound'): string =>
  (typeof v === 'string' ? v.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N} _().-]/gu, '').trim().slice(0, 40) : '') || fallback;

// ---------------------------------------------------------------- 2. config

export const FX_PRESET_IDS = ['glitch', 'vhs', 'pixelate', 'shake', 'bloom', 'bw'] as const;
export type FxPresetId = (typeof FX_PRESET_IDS)[number];
export const FX_PRESETS: readonly { id: FxPresetId; label: string; hint: string; icon: string }[] = [
  { id: 'glitch', label: 'Glitch', hint: 'Slices of the picture slip sideways and split into colours', icon: '📺' },
  { id: 'vhs', label: 'Old tape (VHS)', hint: 'Wobbly lines, soft colours and a little noise, like a worn tape', icon: '📼' },
  { id: 'pixelate', label: 'Pixelate', hint: 'The picture turns into big blocks and back', icon: '🟦' },
  { id: 'shake', label: 'Shake', hint: 'The whole picture rattles', icon: '💥' },
  { id: 'bloom', label: 'Glow pop', hint: 'One soft bright pulse (always inside the flash-safety limit)', icon: '✨' },
  { id: 'bw', label: 'Black & white', hint: 'The colour drains away and comes back', icon: '🎞️' },
];
export const isFxPreset = (v: unknown): v is FxPresetId => typeof v === 'string' && (FX_PRESET_IDS as readonly string[]).includes(v);
export const FX_MIN_SECS = 0.2;
export const FX_MAX_SECS = 60;
export const FX_DEFAULT_SECS = 3;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

export interface FxPick { preset: FxPresetId; secs: number }
export function sanitizeFxPick(o: unknown): FxPick | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  return isFxPreset(x.preset) ? { preset: x.preset, secs: num(Number(x.secs), FX_MIN_SECS, FX_MAX_SECS, FX_DEFAULT_SECS) } : null;
}

/** What starts a cue. `name` / `id` / `title` empty = any (never for a redeem). */
export type CueWhen =
  | { kind: 'emote'; name: string }
  | { kind: 'outfit'; id: string }
  | { kind: 'redeem'; title: string };
export interface SoundCue {
  id: string;
  on: boolean;
  when: CueWhen;
  /** A sound id, or '' for "no sound". */
  sound: string;
  /** 0..1, on top of the sound's own volume. */
  vol: number;
  /** A screen effect to fire with it (or null). */
  fx: FxPick | null;
}
export interface ScreamCfg {
  on: boolean;
  /** Loudness 0..1 (the mic level the lip sync measures). */
  level: number;
  /** How long it must stay above that, in ms. */
  forMs: number;
  /** Seconds before it may go off again. */
  cooldownSecs: number;
  sound: string;
  fx: FxPick | null;
}
export interface SoundboardCfg {
  v: typeof SOUNDBOARD_VERSION;
  /** Master switch. OFF until the streamer turns it on. */
  on: boolean;
  /** 0..1 master volume. */
  volume: number;
  /** Per-sound volume 0..1 (missing = 1). */
  vols: Record<string, number>;
  cues: SoundCue[];
  scream: ScreamCfg;
}
export const DEFAULT_SCREAM: ScreamCfg = { on: false, level: 0.7, forMs: 500, cooldownSecs: 15, sound: 'sy_horn', fx: { preset: 'glitch', secs: 2 } };
export const DEFAULT_SOUNDBOARD: SoundboardCfg = { v: SOUNDBOARD_VERSION, on: false, volume: 0.7, vols: {}, cues: [], scream: DEFAULT_SCREAM };

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, n) : '');
const CUE_ID_RE = /^[a-z0-9]{1,16}$/;
export function sanitizeCueWhen(o: unknown): CueWhen | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.kind === 'emote') { const name = str(x.name, 64); return { kind: 'emote', name }; }
  if (x.kind === 'outfit') { const id = str(x.id, 64); return id === '' || SOUND_ID_RE.test(id) ? { kind: 'outfit', id } : null; }
  if (x.kind === 'redeem') { const title = str(x.title, 80); return title ? { kind: 'redeem', title } : null; }
  return null;
}
export function sanitizeCue(o: unknown): SoundCue | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const when = sanitizeCueWhen(x.when);
  const sound = typeof x.sound === 'string' && isSoundId(x.sound) ? x.sound : '';
  const fx = sanitizeFxPick(x.fx);
  if (!when || (!sound && !fx)) return null;
  const id = typeof x.id === 'string' && CUE_ID_RE.test(x.id) ? x.id : newCueId();
  return { id, on: x.on !== false, when, sound, vol: num(x.vol, 0, 1, 1), fx };
}
export function sanitizeScream(o: unknown): ScreamCfg {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_SCREAM;
  const fx = 'fx' in x ? sanitizeFxPick(x.fx) : d.fx;
  return {
    on: x.on === true,
    level: num(x.level, 0.15, 0.98, d.level),
    forMs: Math.round(num(x.forMs, 150, 5000, d.forMs)),
    cooldownSecs: Math.round(num(x.cooldownSecs, 2, 300, d.cooldownSecs)),
    sound: typeof x.sound === 'string' && (x.sound === '' || isSoundId(x.sound)) ? x.sound : d.sound,
    fx,
  };
}
/** Any JSON (a file on disk, a PUT body, a patch) into a config that is safe to use. */
export function sanitizeSoundboardCfg(o: unknown): SoundboardCfg {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const vols: Record<string, number> = {};
  if (x.vols && typeof x.vols === 'object') {
    for (const [k, v] of Object.entries(x.vols as Record<string, unknown>)) {
      if (Object.keys(vols).length >= MAX_USER_SOUNDS + 40) break;
      if (isSoundId(k) && typeof v === 'number' && Number.isFinite(v)) vols[k] = clamp(v, 0, 1);
    }
  }
  const cues: SoundCue[] = [];
  const seen = new Set<string>();
  if (Array.isArray(x.cues)) {
    for (const c of x.cues) {
      if (cues.length >= MAX_CUES) break;
      const cue = sanitizeCue(c);
      if (!cue) continue;
      if (seen.has(cue.id)) cue.id = newCueId();
      seen.add(cue.id);
      cues.push(cue);
    }
  }
  return { v: SOUNDBOARD_VERSION, on: x.on === true, volume: num(x.volume, 0, 1, DEFAULT_SOUNDBOARD.volume), vols, cues, scream: sanitizeScream(x.scream) };
}
let cueSeq = 0;
export function newCueId(): string { cueSeq = (cueSeq + 1) % 1e6; return `c${Date.now().toString(36).slice(-6)}${cueSeq.toString(36)}`.slice(0, 16); }
/** Turn off every cue / the scream that uses a sound that is gone (the helper does this when a file is deleted). */
export function dropSound(cfg: SoundboardCfg, id: string): SoundboardCfg {
  const vols = { ...cfg.vols }; delete vols[id];
  return {
    ...cfg, vols,
    cues: cfg.cues.flatMap((c) => (c.sound !== id ? [c] : c.fx ? [{ ...c, sound: '' }] : [])),
    scream: cfg.scream.sound === id ? { ...cfg.scream, sound: '', ...(cfg.scream.fx ? {} : { on: false }) } : cfg.scream,
  };
}
/** The final gain (0..1) of a sound: master x its own x the cue's / the step's. */
export const soundGain = (cfg: SoundboardCfg, id: string, extra = 1): number => clamp(cfg.volume * (cfg.vols[id] ?? 1) * clamp(extra, 0, 1), 0, 1);

// ---------------------------------------------------------------- the sfx / screen-fx command (bus + deck + rules)

export interface SfxArgs { id: string; /** 0..100 */ volume: number }
/** Args of the bus command `sfx` (shared/deck.ts plans { id, volume 0..100 }). null = nothing to play. */
export function sanitizeSfxArgs(a: unknown): SfxArgs | null {
  if (!a || typeof a !== 'object') return null;
  const x = a as Record<string, unknown>;
  if (!isSoundId(x.id)) return null;
  return { id: x.id, volume: num(Number(x.volume), 0, 100, 70) };
}
export interface ScreenFxArgs { preset: FxPresetId; secs: number }
export function sanitizeScreenFxArgs(a: unknown): ScreenFxArgs | null {
  if (!a || typeof a !== 'object') return null;
  const x = a as Record<string, unknown>;
  if (!isFxPreset(x.preset)) return null;
  return { preset: x.preset, secs: num(Number(x.secs), FX_MIN_SECS, FX_MAX_SECS, FX_DEFAULT_SECS) };
}

// ---------------------------------------------------------------- 3. gates

/** What happened that a cue may be waiting for. */
export type CueTrigger =
  | { kind: 'emote'; name: string }
  | { kind: 'outfit'; id: string }
  | { kind: 'redeem'; title: string };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export function cueMatches(c: SoundCue, t: CueTrigger): boolean {
  if (!c.on || c.when.kind !== t.kind) return false;
  if (c.when.kind === 'emote' && t.kind === 'emote') return !c.when.name || norm(c.when.name) === norm(t.name);
  if (c.when.kind === 'outfit' && t.kind === 'outfit') return !c.when.id || c.when.id === t.id;
  if (c.when.kind === 'redeem' && t.kind === 'redeem') return norm(c.when.title) === norm(t.title);
  return false;
}
export const matchCues = (cues: readonly SoundCue[], t: CueTrigger): SoundCue[] => cues.filter((c) => cueMatches(c, t));

/** The redeem / outfit / emote a rule trigger or a deck command means (null = not a cue trigger). */
export function cueTriggerOf(e: RuleEvent): CueTrigger | null {
  return e.kind === 'redeem' && e.title ? { kind: 'redeem', title: e.title } : null;
}

export interface SoundGateOpts { maxVoices: number; minGapMs: number; perMinute: number }
export const DEFAULT_GATE: SoundGateOpts = { maxVoices: 4, minGapMs: 150, perMinute: 40 };
export type GateVerdict = 'ok' | 'busy' | 'again' | 'rate';
/**
 * Keeps a chat full of redeems from turning the stream into noise: at most `maxVoices` sounds at once, the same sound not
 * again within `minGapMs`, and at most `perMinute` sounds in any 60 s. Pure: the caller passes the clock.
 */
export class SoundGate {
  private ends: number[] = [];
  private last = new Map<string, number>();
  private stamps: number[] = [];
  constructor(public opts: SoundGateOpts = DEFAULT_GATE) {}
  /** Ask to start `id` that lasts `durMs`. On 'ok' it is counted. */
  admit(id: string, durMs: number, now: number): GateVerdict {
    this.ends = this.ends.filter((t) => t > now);
    const l = this.last.get(id);
    if (l !== undefined && now - l < this.opts.minGapMs && now >= l) return 'again';
    while (this.stamps.length && now - this.stamps[0] >= 60_000) this.stamps.shift();
    if (this.stamps.length >= this.opts.perMinute) return 'rate';
    if (this.ends.length >= this.opts.maxVoices) return 'busy';
    this.last.set(id, now);
    if (this.last.size > 128) this.last.delete(this.last.keys().next().value as string);
    this.ends.push(now + Math.max(50, durMs));
    this.stamps.push(now);
    return 'ok';
  }
  get voices(): number { return this.ends.length; }
  reset() { this.ends = []; this.last.clear(); this.stamps = []; }
}

/**
 * "Scream": the mic level stays above `level` for `forMs`. feed() once per sample (about every 60 ms while the detector is
 * on); returns the happening once, when it has been loud long enough, then waits for the level to fall (below 85 % of the
 * level, so a wobble around the line cannot fire twice) and for the cooldown.
 */
export class LoudDetector {
  private since = -1;
  private fired = false;
  private lastFire = -Infinity;
  constructor(public level = DEFAULT_SCREAM.level, public forMs = DEFAULT_SCREAM.forMs, public cooldownMs = DEFAULT_SCREAM.cooldownSecs * 1000) {}
  configure(c: Pick<ScreamCfg, 'level' | 'forMs' | 'cooldownSecs'>) { this.level = c.level; this.forMs = c.forMs; this.cooldownMs = c.cooldownSecs * 1000; }
  feed(level: number, now: number): { level: number; ms: number } | null {
    if (!(level >= this.level)) {
      if (level < this.level * 0.85) { this.since = -1; this.fired = false; }
      return null;
    }
    if (this.since < 0) this.since = now;
    if (this.fired) return null;
    const held = now - this.since;
    if (held < this.forMs || now - this.lastFire < this.cooldownMs) return null;
    this.fired = true; this.lastFire = now;
    return { level: Math.round(level * 1000) / 1000, ms: Math.round(held) };
  }
  reset() { this.since = -1; this.fired = false; }
}
/** The rule trigger the scream makes (shared/streamRules.ts kind 'loud'). */
export const loudRuleEvent = (level: number, ms: number, now: number): RuleEvent => ({ id: `loud-${Math.floor(now)}`, ts: now, kind: 'loud', level, ms });

/** After `peak` was measured while the streamer shouted: a level that a normal shout reaches and talking does not. */
export const levelFromPeak = (peak: number): number => clamp(Math.round(peak * 85) / 100, 0.15, 0.98);

// ---------------------------------------------------------------- 4. screen effects

/** The limit on: noise / glitch seeds change at most this often (a whole-frame flicker never beats 3 a second). */
export const FX_SAFE_STEP_MS = 340;
/** With the limit on, two luminance-changing starts (a glow pop) are at least this far apart. */
export const FX_SAFE_GAP_MS = 340;
export const FX_COUNT = FX_PRESET_IDS.length;
export const fxIndex = (p: FxPresetId): number => FX_PRESET_IDS.indexOf(p);

/** How strongly a preset shows `t` seconds after it started, for a run of `dur` seconds: 0..1, a short fade in and a fade out. */
export function fxEnvelope(p: FxPresetId, t: number, dur: number): number {
  if (!(t >= 0) || !(t < dur)) return 0;
  if (p === 'bloom') {
    // one pop: up in 0.1 s, then a smooth decay over the rest of the run
    const up = Math.min(0.1, dur * 0.25);
    return t < up ? t / up : Math.pow(1 - (t - up) / Math.max(1e-3, dur - up), 2);
  }
  const fin = Math.min(0.15, dur * 0.25), fout = Math.min(0.3, dur * 0.35);
  const a = t < fin ? t / fin : 1, b = dur - t < fout ? (dur - t) / fout : 1;
  const k = Math.min(a, b);
  return k * k * (3 - 2 * k);
}
/** The time the noise is drawn at: the real time, or (limit on) held in FX_SAFE_STEP_MS steps. */
export const fxNoiseTime = (t: number, safe: boolean): number => (safe ? Math.floor((t * 1000) / FX_SAFE_STEP_MS) * (FX_SAFE_STEP_MS / 1000) : t);

interface FxRun { start: number; end: number }
/** What is running. One slot per preset (a second start of the same preset restarts it); all six may run at once. Pure: pass the clock in ms. */
export class FxTimeline {
  private runs: (FxRun | null)[] = new Array(FX_COUNT).fill(null);
  private lastLumStart = -Infinity;
  constructor(public safe = true) {}
  /** Start a preset. Returns false when the limit refused it (a second glow pop inside FX_SAFE_GAP_MS). */
  start(p: FxPresetId, secs: number, now: number): boolean {
    const d = clamp(Number.isFinite(secs) ? secs : FX_DEFAULT_SECS, FX_MIN_SECS, FX_MAX_SECS) * 1000;
    if (p === 'bloom' && this.safe) {
      if (now - this.lastLumStart < FX_SAFE_GAP_MS && now >= this.lastLumStart) return false;
      this.lastLumStart = now;
    }
    this.runs[fxIndex(p)] = { start: now, end: now + d };
    return true;
  }
  stop(p?: FxPresetId) { if (p) this.runs[fxIndex(p)] = null; else this.runs.fill(null); }
  get active(): boolean { return this.runs.some(Boolean); }
  /** Seconds left of a running preset (0 = not running). */
  remainingSecs(p: FxPresetId, now: number): number { const r = this.runs[fxIndex(p)]; return r && now < r.end ? (r.end - now) / 1000 : 0; }
  /** Seconds until the last running preset ends (0 = none). */
  lastEndSecs(now: number): number { let m = 0; for (const r of this.runs) if (r && r.end > now) m = Math.max(m, (r.end - now) / 1000); return m; }
  isRunning(p: FxPresetId, now: number): boolean { const r = this.runs[fxIndex(p)]; return !!r && now < r.end; }
  /** Fill `out` (length FX_COUNT) with the strengths at `now`; finished runs are forgotten. Returns whether anything still runs. */
  sample(now: number, out: ArrayLike<number> & { [i: number]: number }): boolean {
    let any = false;
    for (let i = 0; i < FX_COUNT; i++) {
      const r = this.runs[i];
      if (!r) { out[i] = 0; continue; }
      if (now >= r.end) { this.runs[i] = null; out[i] = 0; continue; }
      any = true;
      out[i] = fxEnvelope(FX_PRESET_IDS[i], (now - r.start) / 1000, (r.end - r.start) / 1000);
    }
    return any;
  }
}

/** How much brighter the glow pop makes the picture at full strength (a multiplier on top of 1). */
export const BLOOM_LIFT = 0.35;
/**
 * The flash limit for the one preset that changes the picture's brightness (the glow pop): its strength goes through the
 * page's FlashGovernor (shared/flashGovernor.ts), the same arbiter every light on the stage uses, so spamming it can never
 * flash faster than three times a second. With the limit off the strength passes straight through (the OBS notice may show).
 */
export class FxGovern {
  private ch: GovChannel = govChannel('screenfx-bloom');
  /** The caller frames the governor (pageGovernor(now) does) before this. */
  apply(amt: { [i: number]: number }, gov: FlashGovernor): void {
    const i = fxIndex('bloom');
    amt[i] = governK(gov, this.ch, amt[i], 1, BLOOM_LIFT);
  }
}

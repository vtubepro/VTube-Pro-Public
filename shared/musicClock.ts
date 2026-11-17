// The music clock: ONE musical timeline for the whole show, fed by DJ gear / DJ software when there is some and by the
// studio's own audio analysis (BeatEngine, src/audio/beat/) underneath, always.
//
//   DJ adapters in the helper (server/music/*: Ableton Link via Carabiner, OS2L, OSC, Pro DJ Link, StageLinQ, MIDI clock,
//   controllers, Traktor deck data)  ─► SourceSample per adapter
//   studio audio analysis ─► bus {type:'beat'} BeatPacket (tapped by the helper)
//                                    │
//                     MusicArbiter (this file, runs in the helper) picks the tempo / phase owner by rank × freshness ×
//                     agreement with the audio, keeps ONE continuous beat counter across hand-overs, adds what the other
//                     sources know (track, phrase / drop countdown, decks, crossfader, controller moves) and the audio's
//                     envelopes, kicks and sections, and applies the measured latency (LatencyCalibrator).
//                                    │
//   bus {type:'musicclock', c: MusicClock, b: BeatPacket, cev?: ControllerEvent[]}  ~30 Hz, helper → every page
//     c   = the full clock (phrase countdown, track, decks, controller state) for new consumers (djstage, overlays)
//     b   = a plain BeatPacket (shared/lightShow.ts) built from the clock: today's light show / BeatClock read it unchanged
//     cev = controller events since the last message (pads, FX on, play, jog scratches) for one-shot visuals
//
// Deterministic on every OBS page: the helper decides, the bus broadcasts, pages only render (src/scene/musicClockRx.ts).
// Pure module (no DOM, no Node): unit-tested by tools/musicclock_unit.ts. docs/DJ_SYNC.md is the user guide.
import { EV_BEAT, EV_DOWN, EV_DROP, EV_HARD, EV_HAT, EV_KICK, EV_SNARE, SECTIONS, sanitizeBeatPacket, type BeatPacket } from './lightShow.ts';
import { FeelLatch, GrooveTracker, feelToWire, grooveToWire, type GrooveState } from './groove.ts';

// ---------------------------------------------------------------- sources
export const CLOCK_SOURCES = ['prolink', 'stagelinq', 'link', 'os2l', 'osc', 'midiclock', 'traktor', 'controller', 'tap', 'audio'] as const;
export type ClockSource = (typeof CLOCK_SOURCES)[number];

/** Per source: plain label, base rank (tempo / phase quality), how long a silent source stays fresh, downbeat trust. */
export const SOURCE_INFO: Record<ClockSource, { label: string; rank: number; staleMs: number; db: number }> = {
  prolink: { label: 'Pioneer CDJ / XDJ (Pro DJ Link)', rank: 1, staleMs: 2500, db: 0.95 },
  stagelinq: { label: 'Denon / Engine DJ player (StageLinQ)', rank: 0.95, staleMs: 2000, db: 0.65 },   // (beat count from the grid: bar start unverified)
  link: { label: 'Ableton Link', rank: 0.9, staleMs: 2000, db: 0.6 },
  os2l: { label: 'VirtualDJ (OS2L)', rank: 0.8, staleMs: 2500, db: 0.7 },
  osc: { label: 'OSC', rank: 0.75, staleMs: 2500, db: 0.6 },
  midiclock: { label: 'MIDI clock', rank: 0.65, staleMs: 800, db: 0.3 },
  traktor: { label: 'Traktor deck data', rank: 0.3, staleMs: 2500, db: 0.2 },
  controller: { label: 'DJ controller', rank: 0, staleMs: 600000, db: 0 },
  tap: { label: 'Tap tempo', rank: 0.55, staleMs: 600000, db: 0.8 },
  audio: { label: 'Music input (audio analysis)', rank: 0.5, staleMs: 1500, db: 0.4 },
};

/** Arrangement labels a source may use (rekordbox phrases: intro / up / down / chorus / outro, verse / bridge). */
export const PHRASE_KINDS = ['intro', 'verse', 'up', 'down', 'chorus', 'bridge', 'outro', 'build', 'drop', 'breakdown', 'groove'] as const;
export type PhraseKind = (typeof PHRASE_KINDS)[number];
/** The show's own sections (what a light / stage director switches looks on). */
export const SHOW_SECTIONS = ['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'] as const;
export type ShowSection = (typeof SHOW_SECTIONS)[number];

/** A source's phrase label → our section (rekordbox HIGH mood: Up = build, Chorus = drop, Down = breakdown). */
export function sectionOf(kind: PhraseKind): ShowSection {
  switch (kind) {
    case 'intro': return 'intro';
    case 'up': case 'build': return 'build';
    case 'chorus': case 'drop': return 'drop';
    case 'down': case 'breakdown': case 'bridge': return 'breakdown';
    case 'outro': return 'outro';
    default: return 'groove';
  }
}
/** Our section → the light show's SECTIONS index (shared/lightShow.ts: listening, intro, groove, buildup, breakdown, drop, chorus). */
export function lightSectionIndex(s: ShowSection | null, playing: boolean): number {
  if (!s || !playing) return 0;
  const name = s === 'build' ? 'buildup' : s === 'outro' ? 'groove' : s;
  const i = (SECTIONS as readonly string[]).indexOf(name);
  return i < 0 ? 2 : i;
}
/** The light show's section name → ours (audio-only mode). */
export function sectionFromLight(name: string): ShowSection | null {
  switch (name) {
    case 'intro': return 'intro';
    case 'groove': return 'groove';
    case 'buildup': return 'build';
    case 'breakdown': return 'breakdown';
    case 'drop': case 'chorus': return 'drop';
    default: return null;
  }
}

export interface PhraseInfo {
  kind: PhraseKind;
  sec: ShowSection;
  mood?: 'high' | 'mid' | 'low';
  /** Beats since this phrase started, and its length in beats (0 = unknown), at the sample's time. */
  pos: number;
  len: number;
  next?: PhraseKind;
  nextSec?: ShowSection;
  /** Beats until the next drop starts (from an analysed track; absent = unknown / none coming). */
  dropIn?: number;
  /** true = from an analysed track (we KNOW when it ends: the show can count down); false = guessed from the audio. */
  known: boolean;
}
export interface TrackInfo { deck: number; title?: string; artist?: string; key?: string; posMs?: number; lenMs?: number }
export interface DeckState {
  n: number; playing: boolean; onAir: boolean; master: boolean;
  /** Channel fader 0..1 (when known). */
  fader?: number;
  bpm?: number;
  title?: string; artist?: string;
}
/** What the DJ's hands are doing (controller MIDI; listen-only). All 0..1 unless noted. */
export interface ControllerState {
  device?: string;
  /** −1 = full left (deck A / 1) … +1 = full right. */
  xfade?: number;
  fader?: number[];
  /** Per deck [hi, mid, lo] (0.5 = centre). */
  eq?: [number, number, number][];
  /** Per deck filter / colour FX, 0.5 = off, 0 = low-pass closed, 1 = high-pass closed. */
  filter?: number[];
  /** Beat FX on (per FX unit). */
  fx?: boolean[];
  /** Jog activity 0..1 (decays): someone is scratching / nudging. */
  scratch?: number;
  playing?: boolean[];
}
export const CONTROLLER_EVENT_KINDS = ['pad', 'play', 'cue', 'fx', 'jog', 'xfade', 'fader', 'eq', 'filter', 'sync', 'load', 'button'] as const;
export type ControllerEventKind = (typeof CONTROLLER_EVENT_KINDS)[number];
/** One controller move (pages fire one-shot visuals on these: a pad = a CO2 burst, FX on = strobes, jog = a glitch). */
export interface ControllerEvent {
  /** Epoch ms (helper clock) it happened. */
  t: number;
  kind: ControllerEventKind;
  /** Deck 1..4 (0 = the mixer / global). */
  deck: number;
  /** Pad / FX / EQ band index (0-based). */
  i?: number;
  /** New value: 1 / 0 for buttons, 0..1 for knobs, −1..1 for the crossfader, ± ticks for a jog turn. */
  v: number;
}

/** One adapter's view, at one moment. The arbiter extrapolates it: beat(t) = beat + (t − at) · bpm / 60000. */
export interface SourceSample {
  src: ClockSource;
  /** Adapter instance ('link', 'prolink', 'os2l', 'osc', 'midiclock:<port>'…). */
  key: string;
  /** Plain label for the panel: "rekordbox (Ableton Link · 2 apps)", "CDJ-3000 #2". */
  name: string;
  /** Epoch ms (helper clock) the grid below describes. */
  at: number;
  /** 0 = this source carries no tempo (metadata / faders only). */
  bpm: number;
  /** Continuous beat position at `at` (any origin; the arbiter keeps its own counter). */
  beat: number;
  /** Beat within the bar (0 = downbeat) of floor(beat), when the source knows where the bar starts. */
  bar?: number;
  playing: boolean;
  /** false = this source can't tell stopped from playing (Ableton Link without start/stop, MIDI clock without Start):
   *  the arbiter then trusts the audio's "music is playing" when there is one. */
  playKnown?: boolean;
  /** The adapter's own confidence 0..1 (default 1). */
  q?: number;
  phrase?: PhraseInfo;
  track?: TrackInfo;
  decks?: DeckState[];
  xfade?: number;
  onAir?: number;
  ctl?: ControllerState;
}

// ---------------------------------------------------------------- the clock on the bus
export interface ClockPhrase {
  kind: PhraseKind; sec: ShowSection; mood?: 'high' | 'mid' | 'low';
  /** Beats into the phrase / its length (0 = unknown). */
  pos: number; len: number;
  next?: PhraseKind; nextSec?: ShowSection;
  /** Beats until the next phrase starts (known phrases only). */
  nextIn?: number;
  /** Beats until the next drop (known phrases only). */
  dropIn?: number;
  known: boolean;
}
export interface MusicClock {
  v: 1;
  /** Clock session (a new helper = a new id). */
  sid: string;
  /** Helper epoch ms this sample describes. */
  t: number;
  /** Who owns tempo / phase right now, its label and score 0..1. */
  src: ClockSource;
  srcName: string;
  srcQ: number;
  /** Music is playing (a deck plays, or the audio hears music). */
  on: boolean;
  bpm: number;
  /** Continuous beat position at t (floor = beat index, fraction = phase). Continuous across source hand-overs. */
  beat: number;
  /** Beat within the bar (0 = downbeat) of floor(beat); barLen beats per bar. */
  bar: number;
  barLen: 4;
  /** How sure we are where the bar starts, 0..1. */
  dbConf: number;
  phrase: ClockPhrase | null;
  sec: ShowSection | null;
  /** 0..1 (the audio's show energy when it hears music, else from the phrase). */
  energy: number;
  track?: TrackInfo;
  decks?: DeckState[];
  /** −1 (deck A / 1) … +1 (deck B / 2). */
  xfade?: number;
  /** The deck on air (1-based) when known. */
  onAir?: number;
  ctl?: ControllerState;
  /** Latency compensation applied (ms; + = the DJ's beats are shown later, matching the audio the stream hears). */
  latMs: number;
  /** The analysed track the show follows (Track library: server/music/trackSync.ts), when its position is known. */
  trk?: ClockTrack;
}
/** The track the pre-built show follows: library id, deck, its beat at `t` (advances with the clock's tempo), how sure
 *  0..1, where the position comes from, the compiled show's id (pages fetch / cache it), another deck audible. */
export interface ClockTrack { id: string; deck: number; beat: number; conf: number; src: string; show?: string; blend?: boolean }
/** What the track follower adds to a tick (MusicArbiter.trackProvider). */
export interface TrackOverlay { phrase: PhraseInfo | null; trk: ClockTrack; track?: TrackInfo; bar?: number; dropNow?: boolean }
export interface TrackQuery { now: number; beat: number; bpm: number; latMs: number; on: boolean; src: ClockSource; decks?: DeckState[]; xfade?: number; onAir?: number; ctl?: ControllerState;
  /** What the tempo owner (or the one source the user named) says is playing: a title alone finds a library track. */
  track?: TrackInfo }
export interface MusicClockMsg { type: 'musicclock'; c: MusicClock; b: BeatPacket & { md?: number; mc?: number; kp?: number; pid?: number; pb?: number; src?: string; srcQ?: number }; cev?: ControllerEvent[] }

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, n = 160) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : undefined);

function sanitizePhrase(o: unknown): ClockPhrase | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const kind = oneOf(x.kind, PHRASE_KINDS), sec = oneOf(x.sec, SHOW_SECTIONS);
  if (!kind || !sec) return null;
  const p: ClockPhrase = { kind, sec, pos: num(x.pos, 0, 1e5, 0), len: num(x.len, 0, 1e5, 0), known: x.known === true };
  const mood = oneOf(x.mood, ['high', 'mid', 'low'] as const); if (mood) p.mood = mood;
  const next = oneOf(x.next, PHRASE_KINDS); if (next) p.next = next;
  const nextSec = oneOf(x.nextSec, SHOW_SECTIONS); if (nextSec) p.nextSec = nextSec;
  if (typeof x.nextIn === 'number') p.nextIn = num(x.nextIn, 0, 1e5, 0);
  if (typeof x.dropIn === 'number') p.dropIn = num(x.dropIn, 0, 1e5, 0);
  return p;
}
function sanitizeTrack(o: unknown): TrackInfo | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Record<string, unknown>;
  const t: TrackInfo = { deck: Math.round(num(x.deck, 0, 8, 0)) };
  const title = str(x.title), artist = str(x.artist), key = str(x.key, 8);
  if (title) t.title = title; if (artist) t.artist = artist; if (key) t.key = key;
  if (typeof x.posMs === 'number') t.posMs = num(x.posMs, 0, 864e5, 0);
  if (typeof x.lenMs === 'number') t.lenMs = num(x.lenMs, 0, 864e5, 0);
  return t;
}
function sanitizeCtl(o: unknown): ControllerState | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Record<string, unknown>;
  const u = (v: unknown) => num(v, 0, 1, 0);
  const arr = <T>(v: unknown, f: (e: unknown) => T, n = 4): T[] | undefined => (Array.isArray(v) ? v.slice(0, n).map(f) : undefined);
  const c: ControllerState = {};
  const device = str(x.device, 60); if (device) c.device = device;
  if (typeof x.xfade === 'number') c.xfade = num(x.xfade, -1, 1, 0);
  const fader = arr(x.fader, u); if (fader) c.fader = fader;
  const eq = arr(x.eq, (e) => (Array.isArray(e) ? [u(e[0]), u(e[1]), u(e[2])] as [number, number, number] : [0.5, 0.5, 0.5] as [number, number, number])); if (eq) c.eq = eq;
  const filter = arr(x.filter, u); if (filter) c.filter = filter;
  const fx = arr(x.fx, (e) => e === true); if (fx) c.fx = fx;
  if (typeof x.scratch === 'number') c.scratch = u(x.scratch);
  const playing = arr(x.playing, (e) => e === true); if (playing) c.playing = playing;
  return c;
}
/** Pages: a clock from the bus, made safe (unknown → null). */
export function sanitizeMusicClock(o: unknown): MusicClock | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.v !== 1 || typeof x.sid !== 'string' || !/^[a-z0-9]{1,24}$/.test(x.sid) || typeof x.t !== 'number' || !Number.isFinite(x.t)) return null;
  const src = oneOf(x.src, CLOCK_SOURCES);
  if (!src) return null;
  const c: MusicClock = {
    v: 1, sid: x.sid, t: x.t, src, srcName: str(x.srcName, 80) ?? SOURCE_INFO[src].label, srcQ: num(x.srcQ, 0, 1, 0),
    on: x.on === true, bpm: num(x.bpm, 0, 400, 0), beat: num(x.beat, -1e9, 1e9, 0), bar: Math.round(num(x.bar, 0, 3, 0)), barLen: 4,
    dbConf: num(x.dbConf, 0, 1, 0), phrase: sanitizePhrase(x.phrase), sec: oneOf(x.sec, SHOW_SECTIONS) ?? null,
    energy: num(x.energy, 0, 1, 0), latMs: num(x.latMs, -1000, 1000, 0),
  };
  const track = sanitizeTrack(x.track); if (track) c.track = track;
  if (Array.isArray(x.decks)) c.decks = x.decks.slice(0, 6).filter((d) => d && typeof d === 'object').map((d) => {
    const y = d as Record<string, unknown>;
    const out: DeckState = { n: Math.round(num(y.n, 0, 8, 0)), playing: y.playing === true, onAir: y.onAir === true, master: y.master === true };
    if (typeof y.fader === 'number') out.fader = num(y.fader, 0, 1, 0);
    if (typeof y.bpm === 'number') out.bpm = num(y.bpm, 0, 400, 0);
    const title = str(y.title), artist = str(y.artist); if (title) out.title = title; if (artist) out.artist = artist;
    return out;
  });
  if (typeof x.xfade === 'number') c.xfade = num(x.xfade, -1, 1, 0);
  if (typeof x.onAir === 'number') c.onAir = Math.round(num(x.onAir, 0, 8, 0));
  const ctl = sanitizeCtl(x.ctl); if (ctl) c.ctl = ctl;
  const k = x.trk as Record<string, unknown> | undefined;
  if (k && typeof k === 'object' && typeof k.id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(k.id) && typeof k.beat === 'number' && Number.isFinite(k.beat)) {
    const t: ClockTrack = { id: k.id, deck: Math.round(num(k.deck, 0, 8, 0)), beat: num(k.beat, -1e6, 1e6, 0), conf: num(k.conf, 0, 1, 0), src: str(k.src, 24) ?? '' };
    if (typeof k.show === 'string' && k.show.length <= 160) t.show = k.show;
    if (k.blend === true) t.blend = true;
    c.trk = t;
  }
  return c;
}
export function sanitizeControllerEvents(o: unknown): ControllerEvent[] {
  if (!Array.isArray(o)) return [];
  const out: ControllerEvent[] = [];
  for (const e of o.slice(0, 64)) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const kind = oneOf(x.kind, CONTROLLER_EVENT_KINDS);
    if (!kind || typeof x.t !== 'number' || !Number.isFinite(x.t)) continue;
    const ev: ControllerEvent = { t: x.t, kind, deck: Math.round(num(x.deck, 0, 8, 0)), v: num(x.v, -128, 128, 0) };
    if (typeof x.i === 'number') ev.i = Math.round(num(x.i, 0, 63, 0));
    out.push(ev);
  }
  return out;
}

// ---------------------------------------------------------------- a smooth grid from noisy beat observations
/**
 * Turns observations "beat position P was at time T" (a beat packet, an OS2L beat, 24 MIDI-clock ticks, a Link status)
 * into a smooth line beat(t) = beat + (t − at) · bpm / 60000. With a tempo hint (the source says its BPM) only the phase
 * is averaged; without one (MIDI clock, taps) the tempo is a least-squares fit over the last few seconds. A jump
 * (> 0.3 beat off the line: a cue jump, a new track, a restart) re-anchors at once.
 */
export class GridTracker {
  bpm = 0;
  at = 0;
  beat = 0;
  jumps = 0;
  private pts: { t: number; p: number }[] = [];
  constructor(private windowMs = 4000, private maxPts = 96) {}
  get ready() { return this.bpm > 0 && this.pts.length > 0; }
  posAt(t: number) { return this.beat + (t - this.at) * this.bpm / 60000; }
  reset() { this.pts = []; this.bpm = 0; this.at = 0; this.beat = 0; }
  /** Returns true when the observation was a jump (re-anchored). */
  observe(t: number, p: number, bpmHint?: number): boolean {
    const hint = bpmHint && bpmHint >= 20 && bpmHint <= 400 ? bpmHint : 0;
    if (hint) this.bpm = hint;
    const jump = this.pts.length > 0 && this.bpm > 0 && Math.abs(p - this.posAt(t)) > 0.3;
    if (jump) { this.pts = []; this.jumps++; }
    this.pts.push({ t, p });
    while (this.pts.length > this.maxPts || (this.pts.length > 2 && t - this.pts[0].t > this.windowMs)) this.pts.shift();
    if (!hint) {
      const n = this.pts.length;
      if (n >= 3 && t - this.pts[0].t >= 250) {
        // least squares p = a + b·(t − tm)
        let tm = 0, pm = 0;
        for (const q of this.pts) { tm += q.t; pm += q.p; }
        tm /= n; pm /= n;
        let sxx = 0, sxy = 0;
        for (const q of this.pts) { sxx += (q.t - tm) ** 2; sxy += (q.t - tm) * (q.p - pm); }
        const slope = sxx > 0 ? sxy / sxx : 0;               // beats per ms
        const bpm = slope * 60000;
        if (bpm >= 20 && bpm <= 400) { this.bpm = bpm; this.at = t; this.beat = pm + slope * (t - tm); return jump; }
      }
      this.at = t; this.beat = p;
      return jump;
    }
    // tempo known: the phase is the mean of the recent observations projected to t (jitter averages out)
    const k = this.pts.slice(-8);
    let s = 0;
    for (const q of k) s += q.p + (t - q.t) * hint / 60000;
    this.at = t; this.beat = s / k.length;
    return jump;
  }
}

// ---------------------------------------------------------------- latency calibration (no sound: the audio we already hear)
export interface CalibState { state: 'waiting' | 'measuring' | 'locked'; ms: number; n: number; conf: number }
/**
 * Where do the DJ's beats land in the audio the studio hears? Every kick the audio analysis finds is placed on the source's
 * raw grid (no latency applied): frac = how far after the nearest beat it fell. On four-to-the-floor music every kick says
 * the same thing; kicks near the bar start count triple (DnB / breaks put kicks off the beat, but always one on "1").
 * The densest cluster of fracs × the beat period = the offset (circular, so it can't exceed half a beat). It locks after
 * enough consistent kicks and then follows slowly; a different answer must repeat 3 times before it is taken.
 */
export class LatencyCalibrator {
  ms = 0;
  locked = false;
  private obs: { t: number; f: number; w: number }[] = [];
  private lastSolve = 0;
  private pending: number[] = [];
  conf = 0;
  constructor(private windowMs = 30000, private maxMs = 250) {}
  /** A kick at time tk; posRaw = the source's beat position at tk (no latency); barPos = beat within the bar 0..4 (NaN = unknown). */
  kick(tk: number, posRaw: number, barPos: number) {
    if (!Number.isFinite(posRaw)) return;
    let f = posRaw - Math.round(posRaw);                         // −0.5 … 0.5 beats after the nearest beat
    if (f >= 0.5) f -= 1;
    const nearDown = Number.isFinite(barPos) && (barPos < 0.5 || barPos > 3.5);
    this.obs.push({ t: tk, f, w: nearDown ? 3 : 1 });
    while (this.obs.length && tk - this.obs[0].t > this.windowMs) this.obs.shift();
    if (this.obs.length > 600) this.obs.shift();
  }
  /** Re-estimate (call every ~2 s with the current BPM). Returns true when the applied offset changed. */
  solve(now: number, bpm: number): boolean {
    if (now - this.lastSolve < 1900 || !(bpm > 20)) return false;
    this.lastSolve = now;
    while (this.obs.length && now - this.obs[0].t > this.windowMs) this.obs.shift();
    const total = this.obs.reduce((s, o) => s + o.w, 0);
    if (this.obs.length < 12 || total < 16) { this.conf = 0; return false; }
    // kernel density on the circle (σ = 0.03 beat), 100 bins
    const B = 100, dens = new Float64Array(B);
    for (const o of this.obs) {
      for (let b = 0; b < B; b++) {
        const c = b / B - 0.5;
        let d = Math.abs(o.f - c); if (d > 0.5) d = 1 - d;
        dens[b] += o.w * Math.exp(-(d * d) / (2 * 0.03 * 0.03));
      }
    }
    // the peak: the densest place, weighed toward a small offset (a syncopated groove has drums off the beat too: its
    // off-beat cluster must not read as a half-beat latency — rhythm lane, measured on rap / breaks / dnb)
    const period0 = 60000 / bpm;
    let best = 0, bestS = -1;
    for (let b = 0; b < B; b++) {
      if (dens[b] < dens[(b + B - 1) % B] || dens[b] < dens[(b + 1) % B]) continue;
      const lat = (b / B - 0.5) * period0, sc = dens[b] * Math.exp(-0.5 * (lat / 120) ** 2);
      if (sc > bestS) { bestS = sc; best = b; }
    }
    const mode = best / B - 0.5;
    // circular mean of the kicks within ±0.08 beat of the mode
    let sx = 0, sy = 0, wIn = 0;
    for (const o of this.obs) {
      let d = o.f - mode; if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      if (Math.abs(d) > 0.08) continue;
      sx += o.w * Math.cos(2 * Math.PI * o.f); sy += o.w * Math.sin(2 * Math.PI * o.f); wIn += o.w;
    }
    this.conf = wIn / total;
    if (wIn < 10 || this.conf < 0.45) return false;
    const frac = Math.atan2(sy, sx) / (2 * Math.PI);
    const period = 60000 / bpm;
    const lim = Math.min(this.maxMs, period / 2);
    const est = Math.max(-lim, Math.min(lim, frac * period));
    if (!this.locked) { this.ms = est; this.locked = true; this.pending = []; return true; }
    if (Math.abs(est - this.ms) < 40) { const old = this.ms; this.ms += (est - this.ms) * 0.3; this.pending = []; return Math.abs(this.ms - old) > 0.5; }
    // a big change must repeat (a track change can fool one window)
    this.pending.push(est);
    if (this.pending.length >= 3 && Math.max(...this.pending) - Math.min(...this.pending) < 40) {
      this.ms = this.pending.reduce((s, v) => s + v, 0) / this.pending.length; this.pending = []; return true;
    }
    return false;
  }
  reset() { this.obs = []; this.locked = false; this.ms = 0; this.pending = []; this.conf = 0; }
  state(): CalibState {
    return { state: this.locked ? 'locked' : this.obs.length ? 'measuring' : 'waiting', ms: Math.round(this.ms), n: this.obs.length, conf: +this.conf.toFixed(2) };
  }
}

// ---------------------------------------------------------------- the arbiter
export interface SourceStatusRow {
  key: string; src: ClockSource; name: string;
  /** Live score 0..1 (0 = stale / silent). */
  score: number;
  bpm: number; playing: boolean; ageMs: number;
  owner: boolean;
  /** Why the score is low, in plain words (empty = fine). */
  note: string;
  calib?: CalibState;
}
/** How late the studio's beat analysis (BeatEngine v8) reports a kick after its true onset: measured on synthetic PCM
 *  through the real worklet + engine by tools/djsync_pcm_calib.ts (27 ms ± 1.5 at 128–174 BPM). Re-measure when the
 *  detection changes. The calibration subtracts it, so latMs is the real audio offset. */
export const AUDIO_KICK_BIAS_MS = 27;
export interface ArbiterOptions {
  /** Kick detection delay of the audio analysis (default AUDIO_KICK_BIAS_MS; tests of the pure maths pass 0). */
  kickBiasMs?: number;
  /** Clock session id (lowercase a-z0-9). */
  sid?: string;
  /** Manual offset added to the measured latency (ms). */
  manualMs?: number;
  /** Measure latency from the audio's kicks automatically (default on). */
  autoLatency?: boolean;
  /** Phrase / drop countdown (and network pads / FX) only from the tempo owner, or ALSO from this one source the user
   *  named (e.g. 'osc' for an OSC tool that knows the phrases). '' = the owner only. */
  phraseFrom?: ClockSource | '';
}
/** The lights lane's optional BeatPacket fields (lane/b13-lights): copied from the audio packet, src / srcQ = the owner. */
export interface DjBeatPacket extends BeatPacket { md?: number; mc?: number; kp?: number; pid?: number; pb?: number; src?: string; srcQ?: number }   // (+ gf / gc / gh / gw: the groove on the clock's grid)
type AudioExtras = Pick<DjBeatPacket, 'md' | 'mc' | 'kp' | 'pid' | 'pb'>;
/** A source counts as live music: playing, with a tempo the pages take as it is (BeatClock locks from 40 BPM; the beat
 *  packet sanitizer clamps at 300). Everything the helper publishes is inside this range, so every packet is locked. */
export const LIVE_BPM: [number, number] = [40, 300];

interface Held { s: SourceSample; seen: number; disagreeSince: number; agreeSince: number; penalty: number }
interface AudioHeld { p: BeatPacket; local: number; seen: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const SECTION_ENERGY: Record<ShowSection, number> = { intro: 0.45, groove: 0.62, build: 0.75, drop: 0.95, breakdown: 0.35, outro: 0.4 };

/**
 * The helper's arbiter: feed it adapter samples (`sample`), the studio's audio packets (`audio`) and controller events
 * (`controller`); call `tick(now)` ~30 times a second and broadcast what it returns (null = nothing to say: no DJ
 * source is live, pages keep using the studio's own beat packets).
 */
export class MusicArbiter {
  readonly sid: string;
  manualMs: number;
  autoLatency: boolean;
  kickBiasMs: number;
  phraseFrom: ClockSource | '';
  /** Track library hook (server/music/trackSync.ts): known phrases, the drop on its exact beat, the track's position.
   *  null / a null answer = nothing known: the clock runs on the sources alone (the realtime show). */
  trackProvider: ((q: TrackQuery) => TrackOverlay | null) | null = null;
  private audioX: AudioExtras = {};
  private held = new Map<string, Held>();
  private audioP: AudioHeld | null = null;
  private audioOffset = NaN;
  private audioOffs: number[] = [];
  private audioEvents: { ev: number; at: number }[] = [];
  private cev: ControllerEvent[] = [];
  private ownerKey = '';
  private ownerSince = 0;
  private candKey = '';
  private candSince = 0;
  /** Output counter = owner position + k (+ a gliding correction after a hand-over). */
  private k = 0;
  private corr = 0;
  private corrAt = 0;
  private lastOut = NaN;
  private lastOutAt = 0;
  private lastBeatIdx = NaN;
  private lastSec: ShowSection | null = null;
  private dropAt = -Infinity;
  private calib = new Map<string, LatencyCalibrator>();
  private lastLiveAt = -Infinity;
  private lastTickAt = 0;
  /** The groove on the CLOCK's grid (shared/groove.ts): the audio's kicks / snares placed on the DJ clock's beats — the
   *  DJ app gives the tempo and the beat, the music gives the rhythm (and, for a backbeat / half-time track, where the
   *  bar starts when the source can't say: Ableton Link's bar is the session's, not the track's). */
  readonly groove = new GrooveTracker();
  private gSentAt = -1e9; private gKey = ''; private gOwner = ''; private gK = 0;
  /** the show feel, latched HERE on the clock's bars and sent as `sf` (shared/groove.ts FeelLatch): every page copies it */
  readonly feel = new FeelLatch();
  private feelDropAt = -Infinity;
  private goEvents: { at: number; kind: 'kick' | 'snare'; w: number }[] = [];
  /** the studio sends true-time onsets (`go`): set by a packet with them, cleared by a new audio stream or 4 s with a
   *  sounding packet but none (an older studio: back to its kick / snare events) */
  private goSeen = false; private goAt = -Infinity;
  /** "This is beat 1" (manual): bars shifted by this many beats unless the source knows the bar for sure (Pro DJ Link). */
  private barShift = 0;
  private lastRaw = { beat: NaN, bar: 0, bpm: 0, at: 0 };
  constructor(o: ArbiterOptions = {}) {
    this.sid = o.sid ?? `mc${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
    this.manualMs = o.manualMs ?? 0;
    this.autoLatency = o.autoLatency !== false;
    this.kickBiasMs = o.kickBiasMs ?? AUDIO_KICK_BIAS_MS;
    this.phraseFrom = o.phraseFrom ?? '';
  }

  /** An adapter's newest view (replaces its previous one). */
  sample(s: SourceSample, now: number) {
    const h = this.held.get(s.key);
    if (h) { h.s = s; h.seen = now; } else this.held.set(s.key, { s, seen: now, disagreeSince: 0, agreeSince: 0, penalty: 1 });
  }
  /** An adapter went away (turned off / disconnected). */
  drop(key: string) { this.held.delete(key); this.calib.delete(key); }
  /** Controller moves (events) since the last tick. `src` = who sent them: the DJ's own controller (MIDI) always counts;
   *  a network source (OSC / OS2L buttons) only while it owns the tempo or is the source the user named. */
  controller(evs: ControllerEvent[], src: ClockSource = 'controller') {
    if (src !== 'controller' && src !== this.held.get(this.ownerKey)?.s.src && src !== this.phraseFrom) return;
    for (const e of evs) { this.cev.push(e); if (this.cev.length > 64) this.cev.shift(); }
  }

  /** The studio's beat analysis packet (bus 'beat'), received at helper time `now`. */
  audio(raw: unknown, now: number) {
    const p = sanitizeBeatPacket(raw);
    if (!p) return;
    // the lights lane's extra fields (talk / music mode, kick presence, phrase counter) ride along in our packet
    const x = raw as Record<string, unknown>, ix: AudioExtras = {};
    const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
    const md = n(x.md, 0, 3), mc = n(x.mc, 0, 1), kp = n(x.kp, 0, 1), pid = n(x.pid, 0, 1e9), pb = n(x.pb, 0, 127);
    if (md !== undefined) ix.md = Math.round(md); if (mc !== undefined) ix.mc = mc; if (kp !== undefined) ix.kp = kp;
    if (pid !== undefined) ix.pid = Math.round(pid); if (pb !== undefined) ix.pb = Math.round(pb);
    this.audioX = ix;
    // studio epoch → helper epoch: the fastest packets define the offset (same PC ≈ 1 ms)
    const d = now - p.t;
    if (this.audioP && p.sid !== this.audioP.p.sid) { this.audioOffs = []; this.audioOffset = NaN; this.goSeen = false; }
    this.audioOffs.push(d); if (this.audioOffs.length > 90) this.audioOffs.shift();
    const min = Math.min(...this.audioOffs);
    this.audioOffset = Number.isFinite(this.audioOffset) ? Math.min(min, this.audioOffset + 0.05) : min;
    const local = p.t + this.audioOffset;
    this.audioP = { p, local, seen: now };
    // the true-time drum onsets (groove learning on the clock's grid)
    if (p.go) { this.goSeen = true; this.goAt = now; } else if (this.goSeen && p.on && now - this.goAt > 4000) this.goSeen = false;
    // latency from the true-time drum onsets (kicks AND snares, already back-dated to their attack): every drum on the
    // beat counts, so a syncopated kick pattern can't pull the clock off the beat
    if (p.go && p.on && this.autoLatency) for (let i = 0; i + 1 < p.go.length; i += 2) {
      const tk = local - p.go[i];
      for (const [key, h] of this.held) {
        const s = h.s;
        if (!(s.bpm > 0) || !s.playing || s.src === 'tap' || now - h.seen > SOURCE_INFO[s.src].staleMs || this.disagrees(s.bpm)) continue;
        let c = this.calib.get(key); if (!c) { c = new LatencyCalibrator(); this.calib.set(key, c); }
        c.kick(tk, s.beat + (tk - s.at) * s.bpm / 60000, NaN);
      }
    }
    if (p.go && p.on) for (let i = 0; i + 1 < p.go.length; i += 2) { this.goEvents.push({ at: local - p.go[i], kind: p.go[i + 1] >= 0 ? 'kick' : 'snare', w: Math.abs(p.go[i + 1]) / 100 }); if (this.goEvents.length > 48) this.goEvents.shift(); }
    const keep = p.ev & (EV_KICK | EV_SNARE | EV_HAT | EV_HARD | EV_DROP);
    if (keep) {
      const at = local - ((p.ev & EV_KICK) ? (p.ka ?? 0) : (p.ev & EV_SNARE) ? (p.sa ?? 0) : 0);
      this.audioEvents.push({ ev: keep, at });
      if (this.audioEvents.length > 32) this.audioEvents.shift();
      // latency: place the kick on every protocol source's raw grid (studios that send true-time drum onsets: below)
      if ((p.ev & EV_KICK) && p.on && this.autoLatency && !p.go) {
        const tk = local - (p.ka ?? 0) - this.kickBiasMs;   // (the analysis reports a kick a little after its onset)
        for (const [key, h] of this.held) {
          const s = h.s;
          if (!(s.bpm > 0) || !s.playing || s.src === 'tap' || now - h.seen > SOURCE_INFO[s.src].staleMs) continue;
          if (this.disagrees(s.bpm)) continue;
          const pos = s.beat + (tk - s.at) * s.bpm / 60000;
          const barPos = s.bar === undefined ? NaN : ((((Math.floor(pos) - Math.floor(s.beat)) + s.bar) % 4) + 4) % 4 + (pos - Math.floor(pos));
          let c = this.calib.get(key); if (!c) { c = new LatencyCalibrator(); this.calib.set(key, c); }
          c.kick(tk, pos, barPos);
        }
      }
    }
  }

  private audioLive(now: number) { return !!this.audioP && now - this.audioP.seen < SOURCE_INFO.audio.staleMs; }
  /** The audio hears a clear tempo that is not this one (any octave), e.g. the DJ pre-listens a track in the headphones. */
  private disagrees(bpm: number): boolean {
    const a = this.audioP?.p;
    if (!a || !a.on || !a.lk || a.cf < 0.5 || !(a.bpm > 0)) return false;
    let err = Infinity;
    for (const m of [0.5, 1, 2]) err = Math.min(err, Math.abs(bpm - a.bpm * m) / (a.bpm * m));
    return err > 0.04;
  }
  latencyOf(key: string): number {
    const c = this.calib.get(key);
    return (this.autoLatency && c?.locked ? c.ms : 0) + this.manualMs;
  }

  private score(h: Held, now: number): { q: number; note: string } {
    const s = h.s, info = SOURCE_INFO[s.src];
    if (!(s.bpm > 0) || info.rank <= 0) return { q: 0, note: s.bpm > 0 ? '' : 'track info only' };
    const age = now - h.seen;
    const live = age < info.staleMs ? 1 : Math.max(0, 1 - (age - info.staleMs) / 1000);
    if (live <= 0) return { q: 0, note: 'no data' };
    // pre-listen guard: the audio disagrees for 8 s → penalty; agrees for 2 s → forgiven
    if (this.disagrees(s.bpm)) { h.agreeSince = 0; if (!h.disagreeSince) h.disagreeSince = now; if (now - h.disagreeSince > 8000) h.penalty = 0.35; }
    else { h.disagreeSince = 0; if (!h.agreeSince) h.agreeSince = now; if (now - h.agreeSince > 2000) h.penalty = 1; }
    const q = info.rank * clamp01(s.q ?? 1) * live * h.penalty * (s.playing ? 1 : 0.15);
    const note = h.penalty < 1 ? 'tempo doesn’t match what the music input hears (pre-listening?)' : !s.playing ? 'stopped' : '';
    return { q, note };
  }
  private audioScore(now: number) {
    const a = this.audioP;
    if (!a || !this.audioLive(now)) return 0;
    const p = a.p;
    if (!(p.bpm > 0) || !p.lk) return 0.02;
    return SOURCE_INFO.audio.rank * clamp01(p.cf) * (p.on ? 1 : 0.15);
  }

  /** Status rows for the panel (best first). */
  status(now: number): SourceStatusRow[] {
    const rows: SourceStatusRow[] = [];
    for (const [key, h] of this.held) {
      const { q, note } = this.score(h, now);
      const c = this.calib.get(key);
      rows.push({ key, src: h.s.src, name: h.s.name, score: +q.toFixed(3), bpm: +h.s.bpm.toFixed(2), playing: h.s.playing, ageMs: Math.round(now - h.seen), owner: key === this.ownerKey, note, ...(c ? { calib: c.state() } : {}) });
    }
    if (this.audioP) {
      const p = this.audioP.p;
      rows.push({ key: 'audio', src: 'audio', name: SOURCE_INFO.audio.label, score: +this.audioScore(now).toFixed(3), bpm: +p.bpm.toFixed(2), playing: p.on, ageMs: Math.round(now - this.audioP.seen), owner: this.ownerKey === 'audio', note: !this.audioLive(now) ? 'no data' : !p.on ? 'silence' : !p.lk ? 'finding the beat' : '' });
    }
    return rows.sort((a, b) => b.score - a.score);
  }

  /** Raw position of a held source at t (no latency). */
  private rawPos(s: SourceSample, t: number) { return s.beat + (t - s.at) * s.bpm / 60000; }

  /** Owner position at local time t (latency applied: the beat the DJ played at T is heard at T + lat). */
  private ownerPos(key: string, t: number): { pos: number; bpm: number; bar: number | null; db: number } | null {
    if (key === 'audio') {
      const a = this.audioP; if (!a || !(a.p.bpm > 0)) return null;
      const pos = a.p.bi + a.p.ph + (t - a.local) * a.p.bpm / 60000;
      const barPos = ((Math.floor(pos) - a.p.bi + a.p.bar) % 4 + 4) % 4;
      return { pos, bpm: a.p.bpm, bar: barPos, db: SOURCE_INFO.audio.db * clamp01(a.p.cf) };
    }
    const h = this.held.get(key); if (!h) return null;
    const s = h.s, lat = this.latencyOf(key);
    const pos = this.rawPos(s, t - lat);
    const bar = s.bar === undefined ? null : ((Math.floor(pos) - Math.floor(s.beat) + s.bar) % 4 + 4) % 4;
    return { pos, bpm: s.bpm, bar, db: SOURCE_INFO[s.src].db * clamp01(s.q ?? 1) };
  }

  private pickOwner(now: number): { key: string; q: number } {
    let best = '', bq = 0;
    for (const [key, h] of this.held) { const { q } = this.score(h, now); if (q > bq) { bq = q; best = key; } }
    const aq = this.audioScore(now);
    if (aq > bq) { bq = aq; best = 'audio'; }
    if (bq < 0.03) return { key: '', q: 0 };
    const cur = this.ownerKey;
    const curQ = cur === 'audio' ? this.audioScore(now) : cur ? (this.held.has(cur) ? this.score(this.held.get(cur)!, now).q : 0) : 0;
    if (!cur || curQ < 0.05 || best === cur) { this.candKey = ''; return { key: best, q: best === cur ? curQ : bq }; }
    // hysteresis: a better source must stay better (by 0.05: one rank step) for 1.5 s
    if (bq >= curQ + 0.05 - 1e-9) {
      if (this.candKey !== best) { this.candKey = best; this.candSince = now; }
      if (now - this.candSince >= 1500) { this.candKey = ''; return { key: best, q: bq }; }
    } else this.candKey = '';
    return { key: cur, q: curQ };
  }

  /** The clock now (null = no DJ source is playing music with a tempo: pages use the studio's own packets). */
  tick(now: number): MusicClockMsg | null {
    const dtTick = this.lastTickAt ? now - this.lastTickAt : 0;
    this.lastTickAt = now;
    // housekeeping: forget sources silent for a minute; recalibrate
    for (const [key, h] of this.held) if (now - h.seen > 60000 && h.s.src !== 'tap' && h.s.src !== 'controller') this.drop(key);
    for (const [key, c] of this.calib) { const h = this.held.get(key); if (h) c.solve(now, h.s.bpm); }
    // publish only while a DJ source is live MUSIC: fresh, playing (a Link session without a play state counts only if the
    // music input isn't hearing silence) and a tempo of 20-400 BPM. Metadata, controller moves, a Carabiner with no
    // Link apps or a stopped CDJ alone never take the pages away from the studio's own beat packets.
    const audioLive = this.audioLive(now), audioOnNow = audioLive && !!this.audioP!.p.on;
    const djLive = [...this.held.values()].some((h) => {
      const s = h.s;
      if (s.src === 'controller' || !(s.bpm >= LIVE_BPM[0] && s.bpm <= LIVE_BPM[1]) || !s.playing) return false;
      if (now - h.seen >= Math.max(3000, SOURCE_INFO[s.src].staleMs)) return false;
      return s.playKnown !== false || !audioLive || audioOnNow;
    });
    const quiet = () => { this.ownerKey = ''; this.lastOut = NaN; this.cev = []; this.audioEvents = []; this.goEvents = []; return null; };
    if (djLive) this.lastLiveAt = now;
    if (now - this.lastLiveAt > 1500) return quiet();

    const pick = this.pickOwner(now);
    const prevOwner = this.ownerKey;
    let o = pick.key ? this.ownerPos(pick.key, now) : null;
    if (!o && prevOwner) o = this.ownerPos(prevOwner, now);
    const ownerKey = o ? (pick.key || prevOwner) : '';
    if (ownerKey !== prevOwner) { this.ownerKey = ownerKey; this.ownerSince = now; this.barShift = 0; }

    let beat: number, bpm: number;
    if (o) {
      bpm = o.bpm;
      const predicted = Number.isFinite(this.lastOut) && this.lastOutAt && bpm > 0 ? this.lastOut + (now - this.lastOutAt) * (bpm / 60000) : NaN;
      if (!Number.isFinite(predicted)) { this.k = -Math.floor(o.pos); this.corr = 0; this.lastBeatIdx = NaN; }   // a fresh start: count from 0
      else if (ownerKey !== prevOwner) {
        // hand-over: keep the counter, glide the phase difference out over ~1 beat
        const diff = predicted - o.pos;
        this.k = Math.round(diff);
        this.corr = diff - this.k; this.corrAt = now;
      } else {
        const glide = this.corr * Math.exp(-(now - this.corrAt) / (60000 / Math.max(40, bpm)));
        const err = predicted - (o.pos + this.k + glide);
        if (Math.abs(err) > 0.25) {                   // the music jumped (cue / loop / new track): follow, keep the counter
          this.k = Math.round(predicted - o.pos); this.corr = 0;
        }
      }
      const glide = this.corr * Math.exp(-(now - this.corrAt) / (60000 / Math.max(40, bpm)));
      if (Math.abs(glide) < 1e-4) this.corr = 0;
      beat = o.pos + this.k + glide;
    } else {
      bpm = 0;
      beat = Number.isFinite(this.lastOut) ? this.lastOut : 0;
    }
    if (!(bpm >= LIVE_BPM[0] && bpm <= LIVE_BPM[1])) return quiet();   // (never a clock without a tempo)
    this.lastOut = beat; this.lastOutAt = now;

    // --------------------------------------------------- the groove: the audio's drums on this clock's beats
    // (a new owner: a fresh groove. The same owner after a pause / a jump re-counts its beats (k): the groove moves with the
    //  count - the owner's own timeline is continuous, so position_new = position_old + (k_new - k_old))
    if (ownerKey !== this.gOwner) { this.groove.reset(); this.gOwner = ownerKey; this.gK = this.k; }
    else if (this.k !== this.gK) { this.groove.rebase(this.k - this.gK); this.gK = this.k; }
    if (ownerKey && ownerKey !== 'audio' && bpm > 0) {
      // (studios that send true-time onsets: those; older ones: their kick / snare events)
      if (this.goSeen) for (const e of this.goEvents) this.groove.hit(e.kind, beat - (now - e.at) * bpm / 60000, Math.max(0.5, e.w));
      else for (const e of this.audioEvents) {
        const pos = beat - (now - e.at) * bpm / 60000;
        if (e.ev & EV_KICK) this.groove.hit('kick', pos);
        if (e.ev & EV_SNARE) this.groove.hit('snare', pos);
      }
      this.groove.tick(beat);
    }
    this.goEvents = [];
    // --------------------------------------------------- what the other sources add
    const fresh = [...this.held.values()].filter((h) => now - h.seen < Math.max(3000, SOURCE_INFO[h.s.src].staleMs)).sort((a, b) => SOURCE_INFO[b.s.src].rank - SOURCE_INFO[a.s.src].rank);
    const ownerHeld = this.held.get(ownerKey);
    // track / decks / crossfader / on-air: like the phrase, only from the tempo owner or the one source the user named
    const withF = <K extends keyof SourceSample>(k: K) => (ownerHeld && ownerHeld.s[k] !== undefined && now - ownerHeld.seen < 3000 ? ownerHeld
      : this.phraseFrom ? fresh.find((h) => h.s.src === this.phraseFrom && h.s[k] !== undefined) : undefined);
    // phrase / drop countdown: the tempo owner's own, else only the one source the user named
    const ph = ownerHeld?.s.phrase && now - ownerHeld.seen < 3000 ? ownerHeld
      : this.phraseFrom ? fresh.find((h) => h.s.src === this.phraseFrom && h.s.phrase) : undefined;
    const audio = this.audioLive(now) ? this.audioP!.p : null;
    const audioOn = !!audio?.on;
    const playing = ownerKey === 'audio' ? audioOn : ownerHeld ? ownerHeld.s.playing && (ownerHeld.s.playKnown !== false || !audio || audioOn) : audioOn;
    let phrase: ClockPhrase | null = null;
    // the analysed track (Track library): its phrases are KNOWN, its drop lands on the grid's exact beat
    let ov: TrackOverlay | null = null;
    if (this.trackProvider && ownerKey) {
      const decksH0 = withF('decks'), xfH0 = withF('xfade'), airH0 = withF('onAir'), trkH0 = withF('track');
      const ctl0 = [...this.held.values()].filter((h) => h.s.ctl && now - h.seen < 600000).sort((a, b) => b.seen - a.seen)[0]?.s.ctl;
      try {
        ov = this.trackProvider({ now, beat, bpm, latMs: ownerKey === 'audio' ? 0 : this.latencyOf(ownerKey), on: playing, src: ownerHeld ? ownerHeld.s.src : 'audio',
          decks: decksH0?.s.decks, xfade: xfH0?.s.xfade ?? ctl0?.xfade, onAir: airH0?.s.onAir, ctl: ctl0, ...(trkH0?.s.track ? { track: trkH0.s.track } : {}) });
      } catch { ov = null; }
    }
    if (ov?.phrase) {
      const p = ov.phrase;
      phrase = { kind: p.kind, sec: p.sec, pos: +p.pos.toFixed(3), len: p.len, known: true, ...(p.mood ? { mood: p.mood } : {}), ...(p.next ? { next: p.next } : {}), ...(p.nextSec ? { nextSec: p.nextSec } : {}) };
      if (p.len > 0) phrase.nextIn = +Math.max(0, p.len - p.pos).toFixed(3);
      if (p.dropIn !== undefined) phrase.dropIn = +Math.max(0, p.dropIn).toFixed(3);
    } else if (ph?.s.phrase) {
      const p = ph.s.phrase, s = ph.s;
      // (a phrase from a source without its own tempo — an OSC tool's "drop in 32" — runs on the clock's tempo)
      const rate = s.bpm > 0 ? s.bpm : bpm, going = s.bpm > 0 ? s.playing : playing;
      const el = rate > 0 && going ? (now - this.latencyOf(ph.s.key) - s.at) * rate / 60000 : 0;
      const pos = p.pos + Math.max(0, el);
      phrase = { kind: p.kind, sec: p.sec, pos: +pos.toFixed(3), len: p.len, known: p.known, ...(p.mood ? { mood: p.mood } : {}), ...(p.next ? { next: p.next } : {}), ...(p.nextSec ? { nextSec: p.nextSec } : {}) };
      if (p.known && p.len > 0) phrase.nextIn = +Math.max(0, p.len - pos).toFixed(3);
      if (p.known && p.dropIn !== undefined) phrase.dropIn = +Math.max(0, p.dropIn - Math.max(0, el)).toFixed(3);
    } else if (audio) {
      const sec = sectionFromLight(SECTIONS[audio.sec] ?? 'listening');
      if (sec) phrase = { kind: sec === 'build' ? 'build' : sec === 'drop' ? 'drop' : sec === 'breakdown' ? 'breakdown' : sec === 'intro' ? 'intro' : 'groove', sec, pos: 0, len: 0, known: false };
    }
    const sec: ShowSection | null = playing ? (phrase?.sec ?? (bpm > 0 ? 'groove' : null)) : null;
    // a drop starts: from a known phrase change (exact), else the audio says so
    let dropEv = false;
    if (ov) { if (ov.dropNow) { dropEv = true; this.dropAt = now; } }   // (the track follower fires each drop once, on its beat)
    else if (sec === 'drop' && this.lastSec !== 'drop' && this.lastSec !== null && phrase?.known) { dropEv = true; this.dropAt = now; }
    this.lastSec = sec;
    const trackH = withF('track'), decksH = withF('decks'), xfH = withF('xfade'), airH = withF('onAir');
    const ctlH = [...this.held.values()].filter((h) => h.s.ctl && now - h.seen < 600000).sort((a, b) => b.seen - a.seen)[0];
    const energy = audioOn ? clamp01(audio!.e) : sec ? (sec === 'build' && phrase?.known && phrase.len > 0 ? 0.6 + 0.35 * clamp01(phrase.pos / phrase.len) : SECTION_ENERGY[sec]) : 0;
    const op = o && ownerKey ? o : null;
    // the bar position of floor(beat) in OUR counter: from the owner (its numbering is ours minus k, plus the glide), else
    // from the audio's downbeat, matched by time (the audio counts its own beats)
    let barRaw = ((Math.floor(beat) % 4) + 4) % 4;
    if (op && op.bar !== null) barRaw = (((op.bar + Math.floor(beat) - this.k - Math.floor(op.pos)) % 4) + 4) % 4;
    else if (audio && audio.lk && audio.bpm > 0 && bpm > 0) {
      const outAtAudio = beat - (now - this.audioP!.local) * bpm / 60000;          // our position when the audio packet was taken
      const audioBeatInOurs = Math.round(outAtAudio - audio.ph);                    // our index of the audio's beat audio.bi
      barRaw = (((audio.bar + Math.floor(beat) - audioBeatInOurs) % 4) + 4) % 4;
    }
    let dbConf = op && op.bar !== null ? op.db : audio && audio.lk ? SOURCE_INFO.audio.db * clamp01(audio.cf) : 0;
    // the groove knows where a backbeat / half-time / breakbeat bar starts (kick on 1, snare on 2 & 4 or on 3): better
    // than a source whose bar is only a session phase (Ableton Link, MIDI clock); four-on-the-floor can't tell
    // (only the PARITY, and only for half-time — the big snare on 3 — where it is reliable: measured on 36 real tracks
    // against rekordbox's bars, a backbeat / breakbeat's parity guess was right about half the time (no better than
    // the source's), half-time's 95 %+; 1-vs-3 the music can't tell, so a source whose bar has the right parity keeps it)
    const gs: GrooveState = this.groove.state;
    if (ownerKey && ownerKey !== 'audio' && dbConf < 0.8 && gs.barConf >= 0.6 && gs.feel === 'half') {
      const srcShift = (((Math.floor(beat) - barRaw) % 4) + 4) % 4;
      if ((((gs.barShift - srcShift) % 2) + 2) % 2 === 1) { barRaw = (((Math.floor(beat) - gs.barShift) % 4) + 4) % 4; dbConf = Math.max(dbConf, 0.7); }
    }
    // the track's own grid knows where its bars start (better than Link / the audio; Pro DJ Link already knows)
    if (ov?.bar !== undefined && dbConf < 0.9 && ov.trk.conf >= 0.6) { barRaw = ov.bar; dbConf = 0.9; }
    this.lastRaw = { beat, bar: barRaw, bpm, at: now };
    const shifted = this.barShift !== 0 && dbConf < 0.9;   // (only Pro DJ Link's beat-in-bar outranks the user's "this is beat 1")
    const bar = shifted ? (barRaw + this.barShift) % 4 : barRaw;
    if (shifted) dbConf = 0.8;
    const srcKey = ownerKey || 'audio';
    const src: ClockSource = ownerKey === 'audio' || !ownerHeld ? 'audio' : ownerHeld.s.src;
    const clock: MusicClock = {
      v: 1, sid: this.sid, t: now, src, srcName: ownerHeld ? ownerHeld.s.name : SOURCE_INFO.audio.label, srcQ: +pick.q.toFixed(3),
      on: playing, bpm: +bpm.toFixed(3), beat: +beat.toFixed(4), bar, barLen: 4, dbConf: +dbConf.toFixed(2),
      phrase, sec, energy: +energy.toFixed(3), latMs: srcKey === 'audio' ? 0 : Math.round(this.latencyOf(srcKey)),
    };
    if (trackH?.s.track) clock.track = trackH.s.track;
    if (ov) { clock.trk = ov.trk; if (ov.track) clock.track = { ...(clock.track ?? {}), ...ov.track }; }
    if (decksH?.s.decks) clock.decks = decksH.s.decks;
    const ctl = ctlH?.s.ctl;
    if (xfH?.s.xfade !== undefined) clock.xfade = xfH.s.xfade; else if (ctl?.xfade !== undefined) clock.xfade = ctl.xfade;
    if (airH?.s.onAir !== undefined) clock.onAir = airH.s.onAir;
    if (ctl) clock.ctl = ctl;

    // --------------------------------------------------- the BeatPacket today's light show reads
    const b = this.beatPacket(clock, now, audio, dropEv, dtTick);
    const cev = this.cev.length ? this.cev.splice(0) : undefined;
    return cev ? { type: 'musicclock', c: clock, b, cev } : { type: 'musicclock', c: clock, b };
  }

  /** Clock → BeatPacket (shared/lightShow.ts). Grid + sections from the clock; kicks, envelopes from the audio when it
   *  hears music, else made up from the grid (a kick per beat except in breakdowns), so the show runs on DJ data alone.
   *  It also carries the audio's md / mc / kp / pid / pb: while a DJ clock is live, pages get ONE beat stream (this one) —
   *  forwarding the studio's raw packets too would play every kick twice (this packet already carries the audio's kicks). */
  private beatPacket(c: MusicClock, now: number, audio: BeatPacket | null, dropEv: boolean, _dt: number): DjBeatPacket {
    const bi = Math.floor(c.beat), ph = c.beat - bi;
    let ev = 0, ka: number | undefined, sa: number | undefined;
    const period = c.bpm > 0 ? 60000 / c.bpm : 500;
    const crossed = Number.isFinite(this.lastBeatIdx) && bi > this.lastBeatIdx && bi - this.lastBeatIdx < 8;
    if (c.bpm > 0 && crossed) {
      ev |= EV_BEAT;
      if (c.bar === 0) ev |= EV_DOWN;
    }
    if (c.bpm > 0) this.lastBeatIdx = bi;
    const audioOn = !!audio?.on;
    if (audioOn) {
      for (const e of this.audioEvents) {
        ev |= e.ev & (EV_KICK | EV_SNARE | EV_HAT | EV_HARD | (c.phrase?.known ? 0 : EV_DROP));
        if (e.ev & EV_KICK) ka = Math.max(0, Math.min(1000, now - e.at));
        if (e.ev & EV_SNARE) sa = Math.max(0, Math.min(1000, now - e.at));
      }
    } else if (c.on && c.bpm > 0 && crossed && c.sec !== 'breakdown') {
      ev |= EV_KICK; ka = Math.max(0, Math.min(1000, ph * period));
      if (c.bar === 1 || c.bar === 3) { ev |= EV_SNARE; sa = ka; }
    }
    this.audioEvents = [];
    if (dropEv) ev |= EV_DROP;
    if (ev & EV_DROP) this.feelDropAt = now;
    let e: number, lo: number, mi: number, hi: number, k: number, s: number, h: number, d: number;
    if (audioOn && audio) ({ e, lo, mi, hi, k, s, h, d } = audio);
    else if (c.on && c.bpm > 0) {
      const kickOn = c.sec !== 'breakdown';
      k = kickOn ? Math.exp(-ph * 5) : 0;
      e = c.energy; lo = kickOn ? 0.85 * k + 0.1 : 0.15; mi = 0.5 * e; hi = 0.35 * e + 0.25 * Math.exp(-(((c.beat * 2) % 1)) * 6);
      s = c.bar % 2 === 1 ? 0.6 * Math.exp(-ph * 6) : 0; h = 0.3 * e;
      d = Math.max(0, 1 - (now - this.dropAt) / (period * 16));
    } else { e = lo = mi = hi = k = s = h = d = 0; }
    const cf = c.src === 'audio' ? clamp01(audio?.cf ?? 0) : Math.max(0.6, clamp01(c.srcQ + 0.1));
    return {
      sid: this.sid, t: now, on: c.on, bpm: c.bpm, bi, ph: +ph.toFixed(4), bar: c.bar, cf: +cf.toFixed(2), lk: c.bpm >= LIVE_BPM[0] && c.bpm <= LIVE_BPM[1], ev,
      ...(ka !== undefined ? { ka: Math.round(ka) } : {}), ...(sa !== undefined ? { sa: Math.round(sa) } : {}),
      e: +clamp01(e).toFixed(3), lo: +clamp01(lo).toFixed(3), mi: +clamp01(mi).toFixed(3), hi: +clamp01(hi).toFixed(3),
      k: +clamp01(k).toFixed(3), s: +clamp01(s).toFixed(3), h: +clamp01(h).toFixed(3), d: +clamp01(d).toFixed(3),
      sec: lightSectionIndex(c.sec, c.on),
      ...(audio ? this.audioX : {}),
      src: c.src, srcQ: +clamp01(c.srcQ).toFixed(3),
      ...(c.src !== 'audio' && audioOn ? this.grooveFields(c, now) : {}),
    };
  }

  /** The groove packet fields on the published bar (the learner's own downbeat may differ: hits are rotated onto it),
   *  when they change and once a second. */
  private grooveFields(c: MusicClock, now: number): Pick<DjBeatPacket, 'gf' | 'gc' | 'gh' | 'gw' | 'sf'> | Record<string, never> {
    const gs = this.groove.state;
    const pubShift = (((Math.floor(c.beat) - c.bar) % 4) + 4) % 4;          // raw beat index of the published downbeat
    const d = (((gs.barShift - pubShift) % 4) + 4) % 4 * 4;
    const w = grooveToWire(d ? { ...gs, hits: gs.hits.map((h) => { const slot = (h.slot + d) % 16; return { ...h, slot, pos: slot / 4 + (h.pos - h.slot / 4) }; }) } : gs);
    w.sf = feelToWire(this.feel.step(Math.floor((Math.floor(c.beat) - c.bar) / 4), gs, c.sec === 'build' || (c.bpm > 0 && now - this.feelDropAt < 64 * 60000 / c.bpm)));
    const key = `${w.gf}|${w.gc}|${w.gh.join(',')}|${w.sf}`;
    if (key === this.gKey && now - this.gSentAt < 1000) return {};
    this.gKey = key; this.gSentAt = now;
    return w;
  }

  /** "This is beat 1": the user pressed on a downbeat at time t (sources that know the bar ignore it). */
  downbeat(t: number) {
    const r = this.lastRaw;
    if (!(r.bpm > 0) || !Number.isFinite(r.beat)) return;
    const idx = Math.round(r.beat + (t - r.at) * r.bpm / 60000);
    const barAt = (((r.bar + idx - Math.floor(r.beat)) % 4) + 4) % 4;
    this.barShift = (4 - barAt) % 4;
  }
  /** Calibration of one source (panel / tests). */
  calibration(key: string): CalibState | null { return this.calib.get(key)?.state() ?? null; }
  /** Forget measured latencies (e.g. the user changed their audio routing). */
  resetCalibration() { for (const c of this.calib.values()) c.reset(); }
  get owner() { return this.ownerKey; }
}

// ---------------------------------------------------------------- tap tempo (the manual fallback)
/** "Tap" on the beat: tempo from the median of the last taps, phase from the newest, bar 1 = the first tap of a run. */
export class TapTempo {
  private taps: number[] = [];
  private runStart = 0;
  beatsInRun = 0;
  /** Add a tap (epoch ms). Returns the sample to feed the arbiter (null until 4 taps). */
  tap(t: number): { bpm: number; at: number; beat: number; bar: number } | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (t - last > 2000 || t <= last)) { this.taps = []; }
    if (!this.taps.length) { this.runStart = t; this.beatsInRun = 0; }
    this.taps.push(t);
    if (this.taps.length > 9) this.taps.shift();
    this.beatsInRun++;
    if (this.taps.length < 4) return null;
    const iv = this.taps.slice(1).map((v, i) => v - this.taps[i]).sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (!(med > 150 && med < 1500)) return null;
    const bpm = 60000 / med;
    const beatIdx = this.beatsInRun - 1;
    return { bpm: Math.round(bpm * 10) / 10, at: t, beat: beatIdx, bar: ((beatIdx % 4) + 4) % 4 };
  }
}

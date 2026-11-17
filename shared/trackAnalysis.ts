// One analysed track: the beat grid, phrases (sections), cues, waveform, energy and the events a light show is built
// from — whoever supplied them (the DJ app's own analysis, read read-only, or VTube Pro's own offline analysis).
//
//   importers (server/music/library/*: rekordbox XML + ANLZ, Engine DJ, Traktor, Serato, VirtualDJ, Mixxx)
//   own analysis (shared/trackDsp.ts, optional Beat This! model)          ─►  TrackAnalysis (this file, merged)
//                                                                          ─►  the show compiler (shared/trackShow.ts)
//                                                                          ─►  the live follower (shared/trackFollow.ts)
//
// Everything is in TRACK time: milliseconds from the start of the file (as the DJ app counts them) and beat indices on
// the track's grid (beat 0 = the grid's first anchor; negative before it). Light cues are keyed by BEAT, so pitch /
// tempo changes on the deck cost nothing. Pure module (no DOM, no Node): tools/djtrack_unit.ts.
import { sectionOf, type PhraseKind, type ShowSection, PHRASE_KINDS, SHOW_SECTIONS } from './musicClock.ts';

/** Who supplied a piece of analysis (the DJ app's own wins over ours: it is what the DJ corrected by hand). */
export const TRACK_SRCS = ['rekordbox', 'engine', 'serato', 'traktor', 'vdj', 'mixxx', 'cdj', 'vtp'] as const;
export type TrackSrc = (typeof TRACK_SRCS)[number];
export const SRC_LABEL: Record<TrackSrc, string> = {
  rekordbox: 'rekordbox', engine: 'Engine DJ', serato: 'Serato', traktor: 'Traktor', vdj: 'VirtualDJ', mixxx: 'Mixxx', cdj: 'CDJ (rekordbox USB)', vtp: 'VTube Pro',
};
/** Grid preference (lower = better). The CDJ's grid IS rekordbox's export of it. */
const GRID_RANK: Record<TrackSrc, number> = { rekordbox: 0, cdj: 0, engine: 1, serato: 2, traktor: 3, vdj: 4, mixxx: 5, vtp: 9 };

/** A tempo segment: from beat `beat` (at `ms`) on, `bpm` beats a minute. Constant-tempo tracks have one anchor. */
export interface GridAnchor { ms: number; beat: number; bpm: number }
export interface TrackGrid {
  anchors: GridAnchor[];
  /** Beat index (0..3) of the first bar start: beat b starts a bar when (b − downbeat) mod 4 = 0. */
  downbeat: number;
  src: TrackSrc;
}
export interface TrackPhrase {
  /** Start beat (inclusive) / end beat (exclusive). */
  beat: number; end: number;
  kind: PhraseKind; sec: ShowSection;
  mood?: 'high' | 'mid' | 'low';
  src: TrackSrc;
}
export const TRACK_EVENT_KINDS = ['riser', 'impact', 'gap', 'roll'] as const;
export type TrackEventKind = (typeof TRACK_EVENT_KINDS)[number];
/** Something the show can hit: a riser (beam tilt-up from `beat` for `len` beats), an impact (a blinder on `beat`),
 *  a pre-drop gap (near-silence before a drop), a snare roll getting faster. */
export interface TrackEvent { beat: number; kind: TrackEventKind; len?: number; v?: number }
export const CUE_KINDS = ['cue', 'hot', 'memory', 'loop', 'fadein', 'fadeout', 'load'] as const;
export type CueKind = (typeof CUE_KINDS)[number];
export interface TrackCue { ms: number; kind: CueKind; end?: number; n?: number; color?: string; name?: string }
/** The aligner's compact fingerprint: onset + low-band envelopes at `hz` frames a second, one byte each (base64). */
export interface TrackPrint { hz: number; onset: string; low: string; mid?: string; high?: string }

export interface TrackAnalysis {
  v: 1;
  /** Library key (content hash of the file, or a key from name + length when the file isn't reachable). */
  id: string;
  title?: string; artist?: string;
  durMs: number;
  /** Main tempo (the grid's most common BPM). */
  bpm: number;
  grid: TrackGrid | null;
  phrases: TrackPhrase[];
  /** Per bar (from the first downbeat): loudness 0..255, normalised per track. */
  energy?: number[];
  /** Overview waveform: `cols` columns × [low, mid, high] bytes (base64), for the UI. */
  bands?: { cols: number; b64: string; src: TrackSrc };
  events: TrackEvent[];
  cues: TrackCue[];
  fp?: TrackPrint;
  /** The DJ app's detail waveform as band onsets (shared/waveLock.ts): places a known streaming track before it is learned. */
  wave?: { hz: number; onset: string; low: string; src: TrackSrc };
  /** Spectral landmarks (shared/landmarks.ts encodeLandmarks, base64): finds the track by listening, library-wide. */
  lm?: { v: 1; n: number; b64: string };
  /** Everyone who contributed (in merge order). */
  srcs: TrackSrc[];
  /** The groove per span of beats [b, e) (rhythm lane, shared/groove.ts wire form: f = FEELS index, c = confidence,
   *  h = [slot, ±weight·100, offset 1/1000 beat] triples, slots from the bar's downbeat): the pre-built show's per-hit
   *  accents and its feel (half-time, breakbeat …). Ours (needs the audio). */
  groove?: { b: number; e: number; f: number; c: number; h: number[] }[];
  /** Per bar from beat `from`: where its downbeat really hits, 1/1000 beat from the grid line (−9999 = no hit there). */
  downHits?: { from: number; off: number[] };
  /** Our own analysis: which beat tracker ran ('beatthis' = the optional model; 'dsp' = ours; 'grid' = the app's grid). */
  ours?: { at: number; beats: 'beatthis' | 'dsp' | 'grid'; v: number };
}

/** 2: + spectral landmarks (tracks analysed by version 1 are analysed again, in the background). 3: + the groove per
 *  span and the downbeat hits (rhythm lane: the pre-built show hits the real kicks / snares). */
export const ANALYSIS_VERSION = 3;

// ---------------------------------------------------------------------------------------------------- grid maths
/** A grid from one tempo + where beat 0 is (ms) + which beat starts a bar. */
export function constantGrid(firstBeatMs: number, bpm: number, src: TrackSrc, downbeat = 0): TrackGrid {
  return { anchors: [{ ms: firstBeatMs, beat: 0, bpm }], downbeat: ((downbeat % 4) + 4) % 4, src };
}
function anchorAtBeat(g: TrackGrid, beat: number): GridAnchor {
  const a = g.anchors;
  let i = 0;
  for (let k = 1; k < a.length; k++) if (a[k].beat <= beat) i = k; else break;
  return a[i];
}
function anchorAtMs(g: TrackGrid, ms: number): GridAnchor {
  const a = g.anchors;
  let i = 0;
  for (let k = 1; k < a.length; k++) if (a[k].ms <= ms) i = k; else break;
  return a[i];
}
/** Track ms → continuous beat position on the grid. */
export function msToBeat(g: TrackGrid, ms: number): number {
  const a = anchorAtMs(g, ms);
  return a.beat + (ms - a.ms) * a.bpm / 60000;
}
/** Beat position → track ms. */
export function beatToMs(g: TrackGrid, beat: number): number {
  const a = anchorAtBeat(g, beat);
  return a.ms + (beat - a.beat) * 60000 / a.bpm;
}
export function bpmAtBeat(g: TrackGrid, beat: number): number { return anchorAtBeat(g, beat).bpm; }
/** Beat within its bar (0 = the downbeat). */
export function barPos(g: TrackGrid, beat: number): number { return ((((Math.floor(beat) - g.downbeat) % 4) + 4) % 4); }
/** The bar start at or before a beat. */
export function barStart(g: TrackGrid, beat: number): number { return Math.floor(beat) - barPos(g, beat); }

/** Every beat as {ms, bar position 1..4, bpm} (PQTZ-style lists: rekordbox, a CDJ's grid) → anchors.
 *  A new anchor starts where the tempo changes or the beats drift > 2 ms off the running segment. */
export function gridFromBeats(beats: { ms: number; bib?: number; bpm?: number }[], src: TrackSrc): TrackGrid | null {
  const b = beats.filter((x) => Number.isFinite(x.ms)).sort((x, y) => x.ms - y.ms);
  if (b.length < 2) {
    if (b.length === 1 && b[0].bpm && b[0].bpm > 0) return constantGrid(b[0].ms, b[0].bpm, src, b[0].bib ? (1 - b[0].bib + 4) % 4 : 0);
    return null;
  }
  // beat k's stated tempo covers the interval k → k+1: a new segment starts at the beat whose tempo changes, or at the
  // beat whose interval no longer matches the running segment (> 2 ms off: rounding to whole ms stays inside that)
  const anchors: GridAnchor[] = [];
  const close = (from: number, to: number) => {
    const fit = to > from ? 60000 * (to - from) / (b[to].ms - b[from].ms) : (b[from].bpm || 120);
    const st = b[from].bpm;
    anchors.push({ ms: b[from].ms, beat: from, bpm: +(st && Math.abs(st - fit) < 0.05 ? st : fit).toFixed(4) });
  };
  let seg = 0;
  for (let k = 1; k < b.length; k++) {
    const stated = b[k].bpm && b[seg].bpm && Math.abs(b[k].bpm! - b[seg].bpm!) > 0.005;
    const iv = b[k].ms - b[k - 1].ms;
    const mean = k - 1 > seg ? (b[k - 1].ms - b[seg].ms) / (k - 1 - seg) : iv;
    if (stated) { close(seg, k); seg = k; }
    else if (k - 1 > seg && Math.abs(iv - mean) > 2) { close(seg, k - 1); seg = k - 1; }
  }
  close(seg, b.length - 1);
  // merge consecutive anchors with the same tempo that line up (rounding splits)
  const out: GridAnchor[] = [];
  for (const a of anchors) {
    const p = out[out.length - 1];
    if (p && Math.abs(p.bpm - a.bpm) < 0.01 && Math.abs(p.ms + (a.beat - p.beat) * 60000 / p.bpm - a.ms) < 3) continue;
    out.push(a);
  }
  const first1 = b.findIndex((x) => x.bib === 1);
  const downbeat = first1 >= 0 ? first1 % 4 : 0;
  return { anchors: out, downbeat, src };
}

// ---------------------------------------------------------------------------------------------------- phrases
/** Phrase starts (beat + kind) → phrases with ends (the next start, the last one ends at `endBeat`). */
export function phrasesFrom(starts: { beat: number; kind: PhraseKind; mood?: 'high' | 'mid' | 'low' }[], endBeat: number, src: TrackSrc): TrackPhrase[] {
  const s = starts.filter((x) => Number.isFinite(x.beat)).sort((a, b) => a.beat - b.beat);
  return s.map((p, i) => ({ beat: p.beat, end: i + 1 < s.length ? s[i + 1].beat : Math.max(p.beat + 1, endBeat), kind: p.kind, sec: sectionOf(p.kind), ...(p.mood ? { mood: p.mood } : {}), src }));
}
/** The phrase holding a beat (−1 = none). */
export function phraseIndexAt(ph: TrackPhrase[], beat: number): number {
  for (let k = ph.length - 1; k >= 0; k--) if (ph[k].beat <= beat) return beat < ph[k].end ? k : -1;
  return -1;
}
/** The beats where a drop STARTS (a drop phrase after something that isn't a drop). */
export function dropStarts(ph: TrackPhrase[]): number[] {
  const out: number[] = [];
  ph.forEach((p, i) => { if (p.sec === 'drop' && (i === 0 ? false : ph[i - 1].sec !== 'drop')) out.push(p.beat); });
  return out;
}

// ---------------------------------------------------------------------------------------------------- merging
/** Merge what another source knows into an analysis: the DJ app's grid and phrases win over ours; cues are united;
 *  our energy / events / fingerprint fill gaps; a waveform from the app is kept unless ours is the only one. */
export function mergeAnalysis(base: TrackAnalysis, add: Partial<TrackAnalysis> & { srcs?: TrackSrc[] }): TrackAnalysis {
  const out: TrackAnalysis = { ...base, phrases: [...base.phrases], events: [...base.events], cues: [...base.cues], srcs: [...base.srcs] };
  if (add.title && !out.title) out.title = add.title;
  if (add.artist && !out.artist) out.artist = add.artist;
  if (add.durMs && (!out.durMs || Math.abs(add.durMs - out.durMs) > 1500 && !out.grid)) out.durMs = add.durMs;
  if (add.grid && (!out.grid || GRID_RANK[add.grid.src] < GRID_RANK[out.grid.src])) {
    // (the groove's slots and the downbeat hits are measured ON a grid: they leave with the grid they were measured on)
    if (!sameGrid(base.grid, add.grid)) { delete out.groove; delete out.downHits; }
    out.grid = add.grid; out.bpm = mainBpm(add.grid) || out.bpm;
  }
  if (!out.bpm && add.bpm) out.bpm = add.bpm;
  if (add.phrases?.length) {
    const theirs = add.phrases[0].src, mine = out.phrases[0]?.src;
    if (!out.phrases.length || (mine === 'vtp' && theirs !== 'vtp')) out.phrases = add.phrases.map((p) => ({ ...p }));
  }
  if (add.cues?.length) for (const c of add.cues) if (!out.cues.some((d) => Math.abs(d.ms - c.ms) < 30 && d.kind === c.kind && d.n === c.n)) out.cues.push({ ...c });
  out.cues.sort((a, b) => a.ms - b.ms);
  if (add.events?.length && !out.events.length) out.events = add.events.map((e) => ({ ...e }));
  if (add.energy?.length && !out.energy?.length) out.energy = [...add.energy];
  if (add.bands && (!out.bands || (out.bands.src === 'vtp' && add.bands.src !== 'vtp'))) out.bands = { ...add.bands };
  if (add.fp && !out.fp) out.fp = add.fp;
  if (add.wave && !out.wave) out.wave = add.wave;
  if (add.lm) out.lm = add.lm;
  // our groove / downbeat hits only when they were measured on the grid that is kept (a page job without the app's grid
  // measures on our own beat tracking: its slots would play on the wrong beats of the app's grid)
  if (add.groove?.length && sameGrid(add.grid, out.grid)) out.groove = add.groove.map((x) => ({ ...x, h: [...x.h] }));
  if (add.downHits && sameGrid(add.grid, out.grid)) out.downHits = { from: add.downHits.from, off: [...add.downHits.off] };
  if (add.ours) out.ours = add.ours;
  for (const s of add.srcs ?? []) if (!out.srcs.includes(s)) out.srcs.push(s);
  return out;
}
/** The same beat grid (source, downbeat, every anchor within 1 ms / 0.001 BPM)? */
export function sameGrid(x?: TrackGrid | null, y?: TrackGrid | null): boolean {
  if (!x || !y) return false;
  if (x === y) return true;
  return x.src === y.src && x.downbeat === y.downbeat && x.anchors.length === y.anchors.length
    && x.anchors.every((a, i) => a.beat === y.anchors[i].beat && Math.abs(a.ms - y.anchors[i].ms) < 1 && Math.abs(a.bpm - y.anchors[i].bpm) < 1e-3);
}
export function emptyAnalysis(id: string, durMs = 0): TrackAnalysis {
  return { v: 1, id, durMs, bpm: 0, grid: null, phrases: [], events: [], cues: [], srcs: [] };
}
/** The tempo the grid spends most beats at. */
export function mainBpm(g: TrackGrid | null, endBeat = Infinity): number {
  if (!g || !g.anchors.length) return 0;
  let best = g.anchors[0].bpm, most = -1;
  g.anchors.forEach((a, i) => { const n = Math.min(endBeat, g.anchors[i + 1]?.beat ?? a.beat + 1e6) - a.beat; if (n > most) { most = n; best = a.bpm; } });
  return +best.toFixed(3);
}
/** What the panel shows per track. */
export function analysisStatus(a: TrackAnalysis): { grid: boolean; phrases: boolean; analysed: boolean; drops: number; phraseSrc: TrackSrc | null; gridSrc: TrackSrc | null } {
  return { grid: !!a.grid, phrases: a.phrases.length > 0, analysed: !!a.ours, drops: dropStarts(a.phrases).length, phraseSrc: a.phrases[0]?.src ?? null, gridSrc: a.grid?.src ?? null };
}

// ---------------------------------------------------------------------------------------------------- safety
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : undefined);
const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : undefined);
const b64 = (v: unknown, n: number) => (typeof v === 'string' && v.length <= n && /^[A-Za-z0-9+/=]*$/.test(v) ? v : undefined);
/** An analysis from disk / the network, made safe (null = unusable). */
export function sanitizeAnalysis(o: unknown): TrackAnalysis | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.v !== 1 || typeof x.id !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(x.id)) return null;
  const a = emptyAnalysis(x.id, num(x.durMs, 0, 864e5, 0));
  const t = str(x.title), ar = str(x.artist); if (t) a.title = t; if (ar) a.artist = ar;
  a.bpm = num(x.bpm, 0, 400, 0);
  const g = x.grid as Record<string, unknown> | null;
  if (g && typeof g === 'object' && Array.isArray(g.anchors)) {
    const anchors = g.anchors.slice(0, 4096).filter((q) => q && typeof q === 'object').map((q) => { const y = q as Record<string, unknown>; return { ms: num(y.ms, -864e5, 864e5, 0), beat: Math.round(num(y.beat, -1e6, 1e6, 0)), bpm: num(y.bpm, 20, 400, 120) }; })
      .sort((p, q) => p.beat - q.beat);
    const src = oneOf(g.src, TRACK_SRCS);
    if (anchors.length && src) a.grid = { anchors, downbeat: Math.round(num(g.downbeat, 0, 3, 0)), src };
  }
  if (Array.isArray(x.phrases)) a.phrases = x.phrases.slice(0, 1024).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>;
    const kind = oneOf(y.kind, PHRASE_KINDS), sec = oneOf(y.sec, SHOW_SECTIONS), src = oneOf(y.src, TRACK_SRCS);
    if (!kind || !sec || !src) return [];
    const p: TrackPhrase = { beat: num(y.beat, -1e6, 1e6, 0), end: num(y.end, -1e6, 1e6, 0), kind, sec, src };
    const mood = oneOf(y.mood, ['high', 'mid', 'low'] as const); if (mood) p.mood = mood;
    return p.end > p.beat ? [p] : [];
  });
  if (Array.isArray(x.energy)) a.energy = x.energy.slice(0, 4096).map((v) => Math.round(num(v, 0, 255, 0)));
  const bd = x.bands as Record<string, unknown> | undefined;
  if (bd && typeof bd === 'object') { const s = b64(bd.b64, 64 * 1024), src = oneOf(bd.src, TRACK_SRCS); if (s && src) a.bands = { cols: Math.round(num(bd.cols, 1, 20000, 1)), b64: s, src }; }
  if (Array.isArray(x.events)) a.events = x.events.slice(0, 2048).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>; const kind = oneOf(y.kind, TRACK_EVENT_KINDS);
    if (!kind) return [];
    const e: TrackEvent = { beat: num(y.beat, -1e6, 1e6, 0), kind };
    if (typeof y.len === 'number') e.len = num(y.len, 0, 1e4, 0); if (typeof y.v === 'number') e.v = num(y.v, 0, 1, 0);
    return [e];
  });
  if (Array.isArray(x.cues)) a.cues = x.cues.slice(0, 512).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>; const kind = oneOf(y.kind, CUE_KINDS);
    if (!kind) return [];
    const c: TrackCue = { ms: num(y.ms, 0, 864e5, 0), kind };
    if (typeof y.end === 'number') c.end = num(y.end, 0, 864e5, 0); if (typeof y.n === 'number') c.n = Math.round(num(y.n, -1, 64, 0));
    const col = typeof y.color === 'string' && /^#[0-9a-f]{6}$/i.test(y.color) ? y.color : undefined; if (col) c.color = col;
    const nm = str(y.name, 80); if (nm) c.name = nm;
    return [c];
  });
  const lmx = x.lm as Record<string, unknown> | undefined;
  // (the count must fit the data: 4–8 bytes a landmark; the index decodes and recounts it anyway — landmarksForIndex)
  if (lmx && typeof lmx === 'object' && lmx.v === 1) {
    const lb = b64(lmx.b64, 3 << 20), n = Math.round(num(lmx.n, 0, 200_000, 0)), bytes = lb ? Math.floor(lb.length * 3 / 4) - (lb.endsWith('==') ? 2 : lb.endsWith('=') ? 1 : 0) : 0;
    if (lb && n > 0 && bytes >= n * 4 && bytes <= n * 8) a.lm = { v: 1, n, b64: lb };
  }
  const fp = x.fp as Record<string, unknown> | undefined;
  if (fp && typeof fp === 'object') { const on = b64(fp.onset, 1 << 20), lo = b64(fp.low, 1 << 20); if (on && lo) { a.fp = { hz: num(fp.hz, 5, 200, 50), onset: on, low: lo }; const mi = b64(fp.mid, 1 << 20), hi = b64(fp.high, 1 << 20); if (mi && hi) { a.fp.mid = mi; a.fp.high = hi; } } }
  const wv = x.wave as Record<string, unknown> | undefined;
  if (wv && typeof wv === 'object') { const on = b64(wv.onset, 1 << 20), lo = b64(wv.low, 1 << 20), src = oneOf(wv.src, TRACK_SRCS); if (on && lo && src) a.wave = { hz: num(wv.hz, 5, 200, 50), onset: on, low: lo, src }; }
  if (Array.isArray(x.srcs)) a.srcs = x.srcs.filter((s): s is TrackSrc => !!oneOf(s, TRACK_SRCS)).slice(0, 8);
  if (Array.isArray(x.groove)) a.groove = x.groove.slice(0, 512).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>;
    const h = Array.isArray(y.h) && y.h.length <= 48 && y.h.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1000) ? (y.h as number[]).map((v) => Math.round(v)) : null;
    if (!h || typeof y.f !== 'number' || !Number.isInteger(y.f) || y.f < 0 || y.f > 5) return [];
    const b = num(y.b, -1e6, 1e6, 0), e = num(y.e, -1e6, 1e6, 0);
    return e > b ? [{ b, e, f: y.f, c: num(y.c, 0, 1, 0), h }] : [];
  });
  const dh = x.downHits as Record<string, unknown> | undefined;
  if (dh && typeof dh === 'object' && Array.isArray(dh.off) && dh.off.length <= 8192) a.downHits = { from: num(dh.from, -1e6, 1e6, 0), off: dh.off.map((v) => Math.round(num(v, -9999, 500, -9999))) };
  const ours = x.ours as Record<string, unknown> | undefined;
  if (ours && typeof ours === 'object') { const beats = oneOf(ours.beats, ['beatthis', 'dsp', 'grid'] as const); if (beats) a.ours = { at: num(ours.at, 0, 1e15, 0), beats, v: num(ours.v, 0, 1e3, 0) }; }
  return a;
}

// ---------------------------------------------------------------------------------------------------- bytes
/** base64 helpers that work in Node and browsers. */
export function bytesToB64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function b64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const t = atob(s); const out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------------- names
/** A file path / URI → the lower-case base name used to match tracks across apps ("?/x.mp3", "file://localhost/C:/x.mp3",
 *  "net://uuid/Music/x.mp3", "C:\\Music\\x.mp3" → "x.mp3"). */
export function baseName(p: string): string {
  let s = p.trim();
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep */ }
  const parts = s.split(/[\\/]/);
  return (parts[parts.length - 1] || '').toLowerCase().normalize('NFC');
}
/** Normalised title / artist for matching ("Song (Original Mix)" ≈ "song original mix"). */
export function normName(s: string | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

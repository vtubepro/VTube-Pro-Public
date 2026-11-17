// The pre-built light show of one track: a timeline of cues keyed by TRACK BEAT, compiled from its analysis
// (shared/trackAnalysis.ts) the moment the track is first seen, so the show KNOWS what is coming — the drop countdown,
// a blackout on the last beat, pyro / CO2 / confetti on the drop's exact downbeat, build-ups that start bars early —
// instead of reacting late. The realtime show (the studio's audio analysis) stays underneath for everyone without a
// DJ library and takes over whenever the position isn't certain.
//
//   compileShow(analysis, style, seed)  →  TrackShow (deterministic: same track + style + seed = the same show)
//   ShowPlayer                          →  plays shows on decks: edge-triggered on the playhead crossing a beat forward,
//                                          one-shots never re-fire after a loop-back (cooldown), the outgoing deck's
//                                          outro / blackouts are muted while another deck is audible, the incoming
//                                          drop always wins
//   ShowAdapter                         →  how a light engine consumes it (the room lights / reactive director, the
//                                          festival stage's `fest:` looks, the club / Frog Rave crowd and effects)
//
// Photosensitivity: the compiler itself keeps full-frame flashes (drop hits, blinders) to ≤ 3 a second even at +10 %
// pitch; crescendos are SPATIAL chases and intensity ramps (`full: false`), never full-frame strobes. The page's flash
// governor (lights lane: shared/flashGovernor.ts) still checks everything that is drawn. Pure: tools/djtrack_unit.ts.
import { beatToMs, dropStarts, mainBpm, msToBeat, type TrackAnalysis, type TrackPhrase } from './trackAnalysis.ts';
import type { ShowSection } from './musicClock.ts';
import { FEELS, grooveFromWire, type Feel, type GrooveHit } from './groove.ts';

export const SHOW_LAYERS = ['look', 'build', 'chase', 'blackout', 'hit', 'blinder', 'accent', 'sfx', 'crowd', 'cam', 'wall', 'beam', 'ball', 'lasers'] as const;
export type ShowLayer = (typeof SHOW_LAYERS)[number];
export const SHOW_STYLES = ['auto', 'club', 'festival', 'rave', 'calm'] as const;
export type ShowStyle = (typeof SHOW_STYLES)[number];

export interface ShowCue {
  /** Track beat it starts on, and how long it lasts (beats; 0 = an instant). */
  b: number; d: number;
  layer: ShowLayer;
  /** What, per layer — look: the section ('intro' … 'outro'); build: 'ramp'; chase: 'quarter' | 'eighth' | 'sixteenth';
   *  blackout: 'pre-drop' | 'end'; hit / blinder / accent: 'white'; sfx: 'pyro' | 'co2' | 'confetti' | 'flames' | 'lift';
   *  crowd: 'hands' | 'crouch' | 'jump' | 'sway'; cam: 'wide' | 'dj' | 'crowd'; wall: 'countdown' | 'drop' | 'phrase';
   *  beam: 'tiltup' | 'converge'; ball: 'on'; lasers: 'off' | 'on'. */
  act: string;
  /** Intensity 0..1 at the end (ramps start at v0). */
  v?: number; v0?: number;
  /** Look variant (consecutive phrases of one kind alternate), palette index (changes only at phrase starts). */
  var?: number; pal?: number;
  /** One-shot: fired once; a loop-back over it doesn't fire it again within the cooldown. */
  once?: boolean;
  /** First drop of the set only (the stage lift). */
  first?: boolean;
  /** Muted while another deck is audible (the outgoing track's outro / end blackout). */
  out?: boolean;
  /** Full-frame flash: counts against the ≤ 3 flashes a second budget. */
  full?: boolean;
  /** Priority (higher wins a clash; the drop = 10). */
  prio?: number;
  /** The festival engine's look hint ('fest:<genre>:<section>:<variant>'). */
  fest?: string;
}
export interface ShowSectionSpan { b: number; e: number; sec: ShowSection; var: number; pal: number; energy: number;
  /** the section's groove (shared/groove.ts wire form: f = FEELS index, c = confidence, h = hits): the lights hit the
   *  track's real kicks / snares here, pre-cued on its grid (rhythm lane) */
  g?: { f: number; c: number; h: number[] } }
export interface TrackShow {
  v: 1;
  /** `<track id>:<style>:<seed>` (+ the compiler version): pages cache by it. */
  id: string;
  track: string;
  style: ShowStyle;
  /** Genre family for the tempo (picks the festival's drop style). */
  genre: string;
  bpm: number;
  /** First / last beat the show covers. */
  from: number; to: number;
  drops: number[];
  sections: ShowSectionSpan[];
  cues: ShowCue[];
  /** The most full-frame flashes in any one second, at +10 % pitch (must be ≤ 3). */
  maxFlashHz: number;
}
export const SHOW_COMPILER_VERSION = 2;   // 2: cues on the real downbeat hits, the groove per section, the genre by feel
export const MAX_FLASH_HZ = 3;
/** The fastest a deck plays a track (pitch +10 %): the flash budget is checked at this tempo. */
export const MAX_PITCH = 1.1;

// ---------------------------------------------------------------------------------------------------- helpers
function hash(a: number, b = 0, c = 0): number {
  let h = 2166136261 ^ a; h = Math.imul(h ^ b, 16777619); h = Math.imul(h ^ c, 16777619);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
export function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
/** The genre family for a tempo and the music's feel (shared/groove.ts): a half-time 140 is dubstep, not trance; a
 *  backbeat / breakbeat at 172 is drum & bass (or rap), not hardcore; a backbeat under 100 is hip-hop / chill. */
export function genreFor(bpm: number, feel: Feel | null): string {
  if (feel === 'half' && bpm >= 120) return 'dubstep';
  if ((feel === 'back' || feel === 'break') && bpm >= 160) return 'dnb';
  if ((feel === 'back' || feel === 'sparse') && bpm < 100) return 'chill';
  return genreForBpm(bpm);
}
/** The genre family for a tempo (mirrors the festival engine's genreForBpm, lane djstage: shared/festivalLooks.ts). */
export function genreForBpm(bpm: number): string {
  if (!(bpm > 0)) return 'house';
  if (bpm < 100) return 'chill';
  if (bpm < 124) return 'house';
  if (bpm < 132) return 'bigroom';
  if (bpm < 143) return 'trance';
  if (bpm < 166) return 'hardstyle';
  return 'hardcore';
}

// ---------------------------------------------------------------------------------------------------- the compiler
export interface CompileOptions { style?: ShowStyle; seed?: number }
/**
 * TrackAnalysis → TrackShow. Rules (docs/DJ_SYNC.md "Track library"):
 *  1. a look per phrase (intro → groove → build → drop → breakdown → outro); consecutive phrases of one kind alternate
 *     variants; palettes change at phrase starts only;
 *  2. every drop D: the build ramps from its start (at most 16 bars before D); the last 4 bars carry a spatial chase
 *     that doubles its rate each bar (¼ → ⅛ → 1/16); the LED wall counts down; the crowd raises its hands, crouches on
 *     the last beat; a blackout on the last beat (or the detected pre-drop gap); on D itself: a full-rig white hit,
 *     pyro + CO2 + confetti, a camera cut, the crowd jumps (one-shots); the stage lift on the set's first drop; 8 bars of
 *     peak look, then sustain;
 *  3. breakdowns: slow look, mirror ball, lasers off, the crowd sways;
 *  4. risers tilt the beams up, impacts fire a blinder, the DJ's hot cues an accent (never a full flash);
 *  5. the flash budget: full-frame flashes ≥ 1/3 s apart at +10 % pitch (lower priority ones dropped).
 */
export function compileShow(a: TrackAnalysis, o: CompileOptions = {}): TrackShow | null {
  const g = a.grid;
  if (!g || !a.phrases.length) return null;
  const style = o.style ?? 'auto', seed = o.seed ?? hashStr(a.id);
  const bpm = mainBpm(g) || a.bpm || 120;
  const ph = a.phrases;
  // the groove at a beat (our analysis: the track's kick / snare pattern per span) and the drops' feel → the genre
  const grooveAt = (b: number) => a.groove?.find((x) => x.b <= b && b < x.e) ?? null;
  const dropFeel = (() => { const n = new Map<number, number>(); for (const p of ph) if (p.sec === 'drop' || p.sec === 'groove') for (const x of a.groove ?? []) if (x.b < p.end && x.e > p.beat && x.c >= 0.3) n.set(x.f, (n.get(x.f) ?? 0) + Math.min(x.e, p.end) - Math.max(x.b, p.beat)); let best = -1, bv = 0; for (const [f, v] of n) if (v > bv) { bv = v; best = f; } return best >= 0 ? FEELS[best] : null; })();
  const genre = genreFor(bpm, dropFeel);
  // where a bar's downbeat REALLY hits (the analysis found the kick / snare there): a phrase / drop cue lands on it
  // (the grid's own offset first: the median of every bar's downbeat hit — a DJ app's grid a little early / late on a
  // track moves every cue by it, consistently; then a cue moves to its own bar's hit only when that hit agrees with
  // the offset within 15 ms — measured: snapping each bar to its strongest nearby hit on its own picked pick-ups and
  // flams and cost more than it gained)
  const gridOff = (() => {
    const v = (a.downHits?.off ?? []).filter((o) => o > -9999).sort((x, y) => x - y);
    if (v.length < 8) return 0;
    const med = v[v.length >> 1], mad = v.map((o) => Math.abs(o - med)).sort((x, y) => x - y)[v.length >> 1];
    const msPerMilliBeat = 60 / bpm;   // 1/1000 beat in ms
    return Math.abs(med) * msPerMilliBeat > 12 && mad * msPerMilliBeat < 25 ? med : 0;
  })();
  // (`own` = the drop: its own bar's hit may refine it; phrase / look cues move by the grid's offset only — a constant,
  // so every look keeps its length and meets the next one exactly — measured, a look nudged to its bar's own hit split
  // one cue in two and landed it off the beat)
  const exact = (b: number, own = false) => {
    const dh = a.downHits; if (!dh) return b;
    const k = Math.round((b - dh.from) / 4), o = dh.off[k];
    const off = own && Math.abs(dh.from + k * 4 - b) < 1e-6 && o !== undefined && o > -9999 && Math.abs(o - gridOff) * 60 / bpm <= 15 ? o : gridOff;
    return off ? +(b + off / 1000).toFixed(3) : b;
  };
  const from = Math.floor(ph[0].beat), to = Math.ceil(Math.max(ph[ph.length - 1].end, a.durMs ? msToBeat(g, a.durMs) : 0));
  const cues: ShowCue[] = [];
  const sections: ShowSectionSpan[] = [];
  // 1. looks
  let pal = Math.floor(hash(seed, 1) * 8), lastSec: ShowSection | null = null, run = 0;
  const energyAt = (b: number) => { const e = a.energy; if (!e?.length) return NaN; const bar = Math.floor((b - g.downbeat) / 4); return (e[Math.max(0, Math.min(e.length - 1, bar))] ?? 0) / 255; };
  ph.forEach((p, i) => {
    run = p.sec === lastSec ? run + 1 : 0;
    lastSec = p.sec;
    pal = (pal + 1 + Math.floor(hash(seed, 2, i) * 3)) % 8;
    const variant = (run + Math.floor(hash(seed, 3, i) * 2)) % 2;
    let en = 0, n = 0; for (let b = p.beat; b < p.end; b += 4) { const v = energyAt(b); if (Number.isFinite(v)) { en += v; n++; } }
    const energy = n ? +(en / n).toFixed(2) : SECTION_ENERGY[p.sec];
    const gr = grooveAt(p.beat + Math.min(8, (p.end - p.beat) / 2));
    sections.push({ b: p.beat, e: p.end, sec: p.sec, var: variant, pal, energy, ...(gr ? { g: { f: gr.f, c: gr.c, h: gr.h } } : {}) });
    cues.push({ b: exact(p.beat), d: p.end - p.beat, layer: 'look', act: p.sec, var: variant, pal, v: energy, fest: `fest:${genre}:${p.sec}:${variant}`, ...(p.sec === 'outro' ? { out: true } : {}) });
    if (p.sec === 'breakdown') {
      // (with the look: the same grid offset, the same length)
      const lb = exact(p.beat);
      cues.push({ b: lb, d: p.end - p.beat, layer: 'ball', act: 'on' });
      cues.push({ b: lb, d: p.end - p.beat, layer: 'lasers', act: 'off' });
      cues.push({ b: lb, d: p.end - p.beat, layer: 'crowd', act: 'sway' });
    }
  });
  // 2. drops
  const drops = dropStarts(ph);
  // a track that opens on a drop has no countdown, but its first phrase still gets the drop treatment below
  drops.forEach((D, k) => {
    const pi = ph.findIndex((p) => p.beat === D);
    const Dx = exact(D, true);
    const prev: TrackPhrase | undefined = ph[pi - 1];
    const buildStart = Math.max(D - 64, prev && (prev.sec === 'build') ? prev.beat : D - 32, from);
    if (D - buildStart >= 8) {
      cues.push({ b: buildStart, d: D - buildStart, layer: 'build', act: 'ramp', v0: 0.35, v: 1 });
      cues.push({ b: buildStart, d: D - buildStart, layer: 'crowd', act: 'hands', v0: 0.2, v: 1 });
      cues.push({ b: Math.max(buildStart, D - 32), d: D - Math.max(buildStart, D - 32), layer: 'beam', act: 'converge', v0: 0, v: 1 });
    }
    // the last 4 bars: a chase that doubles its rate each bar (spatial: it travels across fixtures, never full-frame)
    const c0 = Math.max(D - 16, from);
    const rates: [number, string][] = [[D - 16, 'quarter'], [D - 12, 'eighth'], [D - 8, 'sixteenth'], [D - 4, 'sixteenth']];
    for (const [b, act] of rates) if (b >= c0) cues.push({ b, d: 4, layer: 'chase', act, v: 0.6 + 0.1 * ((b - (D - 16)) / 4), full: false });
    if (D - 16 >= from) cues.push({ b: D - 16, d: 16, layer: 'wall', act: 'countdown' });
    // blackout on the last beat (or exactly where the music leaves its gap)
    const gap = a.events.find((e) => e.kind === 'gap' && e.beat < D && e.beat >= D - 2);
    const bo = gap ? gap.beat : D - 1;
    if (bo >= from) {
      cues.push({ b: bo, d: Dx - bo, layer: 'blackout', act: 'pre-drop', prio: 9 });
      cues.push({ b: bo, d: Dx - bo, layer: 'crowd', act: 'crouch', prio: 9 });
    }
    // the drop downbeat (on its real hit: the kick that opens the drop, not the grid line)
    cues.push({ b: Dx, d: 0, layer: 'hit', act: 'white', v: 1, full: true, once: true, prio: 10 });
    cues.push({ b: Dx, d: 2, layer: 'sfx', act: 'pyro', once: true, prio: 10 });
    cues.push({ b: Dx, d: 2, layer: 'sfx', act: 'co2', once: true, prio: 10 });
    cues.push({ b: Dx, d: 8, layer: 'sfx', act: 'confetti', once: true, prio: 10 });
    if (genre === 'hardstyle' || genre === 'hardcore') cues.push({ b: Dx, d: 32, layer: 'sfx', act: 'flames', once: true, prio: 10 });
    cues.push({ b: Dx, d: 0, layer: 'sfx', act: 'lift', once: true, first: true, prio: 10 });
    cues.push({ b: Dx, d: 1, layer: 'crowd', act: 'jump', once: true, prio: 10 });
    cues.push({ b: Dx, d: 0, layer: 'cam', act: hash(seed, 4, k) < 0.5 ? 'crowd' : 'wide', once: true, prio: 10 });
    cues.push({ b: Dx, d: 8, layer: 'wall', act: 'drop', prio: 10 });
    const dropEnd = ph[pi]?.end ?? D + 32;
    cues.push({ b: Dx, d: Math.min(32, dropEnd - D), layer: 'look', act: 'drop', var: 2, v: 1, fest: `fest:${genre}:drop:peak`, prio: 10 });
  });
  // 3. the end of the track: a soft end (muted while the next track is already audible)
  cues.push({ b: to - 4, d: 4, layer: 'blackout', act: 'end', out: true, prio: 1 });
  // 4. events + the DJ's hot cues
  for (const e of a.events) {
    if (e.kind === 'riser' && e.len) cues.push({ b: e.beat, d: e.len, layer: 'beam', act: 'tiltup', v0: 0, v: 1 });
    if (e.kind === 'impact') cues.push({ b: e.beat, d: 0, layer: 'blinder', act: 'white', v: e.v ?? 0.8, full: true, prio: 5 });
  }
  for (const c of a.cues) if (c.kind === 'hot' || c.kind === 'memory') {
    const b = Math.round(msToBeat(g, c.ms));
    if (b > from && b < to && !drops.includes(b)) cues.push({ b, d: 0, layer: 'accent', act: 'white', v: 0.5, prio: 2 });
  }
  cues.sort((x, y) => x.b - y.b || (y.prio ?? 0) - (x.prio ?? 0));
  // 5. the flash budget
  const kept = enforceFlashBudget(cues, g ? (b: number) => beatToMs(g, b) : (b: number) => b * 60000 / bpm);
  const show: TrackShow = {
    v: 1, id: `${a.id}:${style}:${seed}:${SHOW_COMPILER_VERSION}`, track: a.id, style, genre, bpm: +bpm.toFixed(3), from, to, drops, sections, cues: kept,
    maxFlashHz: 0,
  };
  show.maxFlashHz = maxFlashRate(show, (b) => beatToMs(g, b));
  return show;
}
const SECTION_ENERGY: Record<ShowSection, number> = { intro: 0.45, groove: 0.62, build: 0.75, drop: 0.95, breakdown: 0.35, outro: 0.4 };

/** Drop full-frame flashes that would come closer than 1/3 s at +10 % pitch (higher priority wins, then earlier). */
export function enforceFlashBudget(cues: ShowCue[], toMs: (beat: number) => number): ShowCue[] {
  const flashes = cues.map((c, i) => ({ c, i })).filter((x) => x.c.full);
  const minGap = 1000 / MAX_FLASH_HZ * MAX_PITCH;   // ms of TRACK time (a deck at +10 % plays them 10 % closer)
  const keep = new Set<number>();
  for (const x of [...flashes].sort((p, q) => (q.c.prio ?? 0) - (p.c.prio ?? 0) || p.c.b - q.c.b)) {
    const t = toMs(x.c.b);
    if ([...keep].some((k) => Math.abs(toMs(cues[k].b) - t) < minGap)) continue;
    keep.add(x.i);
  }
  return cues.filter((c, i) => !c.full || keep.has(i));
}
/** The most full-frame flashes inside any 1 s window, at +10 % pitch. */
export function maxFlashRate(show: Pick<TrackShow, 'cues'>, toMs: (beat: number) => number): number {
  const t = show.cues.filter((c) => c.full).map((c) => toMs(c.b) / MAX_PITCH).sort((x, y) => x - y);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= 1000) j++; best = Math.max(best, i - j + 1); }
  return best;
}

// ---------------------------------------------------------------------------------------------------- the adapter
/** What a light engine gets from the player each frame (all optional to use). */
export interface ShowFrame {
  deck: number; track: string; beat: number; bpm: number;
  /** The look now (section + variant + palette) and the festival hint. */
  look: ShowCue | null;
  /** Build ramp 0..1 (held when the DJ loops inside a build), the chase rate ('' = none), beams converge 0..1. */
  build: number; chase: string; converge: number; tiltUp: number;
  /** Blackout now (pre-drop / end), mirror ball, lasers off. */
  blackout: boolean; ball: boolean; lasersOff: boolean;
  /** Beats to the next drop (Infinity = none coming) and the LED wall's mode. */
  dropIn: number; wall: '' | 'countdown' | 'drop' | 'phrase';
  /** Another deck is audible (blend): outgoing outro / end cues are muted. */
  blend: boolean;
  /** The section's groove on the track's grid (bars from the track's downbeat): the light director / festival hit the
   *  track's real kicks / snares from it (null = unknown: the realtime groove). */
  groove?: { feel: Feel; conf: number; hits: GrooveHit[]; half: boolean } | null;
}
/** A fired one-shot or instant cue, at the exact local time its beat was crossed. */
export interface ShowFire { cue: ShowCue; deck: number; track: string; at: number; late: number }
/** A light engine plugging into the pre-built show (src/scene/trackShowRx.ts keeps the registry). */
export interface ShowAdapter {
  id: string;
  /** One-shots / instants (hits, pyro, the crowd jump, camera cuts) at their exact time. */
  fire?(f: ShowFire): void;
  /** Every frame while a show plays (null = no show: back to the realtime show). */
  frame?(f: ShowFrame | null): void;
}

// ---------------------------------------------------------------------------------------------------- the player
export interface DeckView {
  n: number;
  /** Track id on the deck ('' = unknown) and its beat position now (NaN = unknown). */
  track: string; beat: number;
  /** Effective tempo (BPM heard), how sure the position is 0..1, how loud the deck is in the mix 0..1. */
  bpm: number; conf: number; gain: number; playing: boolean;
}
export interface PlayerOptions {
  /** One-shots don't re-fire within this long after a loop-back (ms). */
  cooldownMs?: number;
  /** Below this position confidence nothing fires (the realtime show runs). */
  minConf?: number;
  /** Hysteresis for the show owner (ms). */
  ownerHoldMs?: number;
}
/**
 * Plays compiled shows on the decks. Feed it the decks each frame (`step`): it picks the show owner (the most audible
 * deck, 750 ms hysteresis; an audible deck reaching its drop takes over at once), fires the cues whose beat the owner's
 * playhead crossed going FORWARD (at their exact time), and answers `frame()` for engines. Backward jumps (loops, hot
 * cues) re-evaluate the look without firing; one-shots stay quiet for the cooldown; a loop inside a build holds the
 * ramp's level. Low confidence = nothing fires.
 */
export class ShowPlayer {
  private shows = new Map<string, TrackShow>();
  private last = new Map<number, { track: string; beat: number; at: number }>();
  private fired = new Map<string, number>();
  private buildHold = new Map<string, number>();
  owner = 0;
  private ownerSince = 0;
  private cand = 0; private candSince = 0;
  private firstDropDone = false;
  blend = false;
  readonly o: Required<PlayerOptions>;
  constructor(o: PlayerOptions = {}) { this.o = { cooldownMs: o.cooldownMs ?? 30000, minConf: o.minConf ?? 0.6, ownerHoldMs: o.ownerHoldMs ?? 750 }; }
  load(show: TrackShow) { this.shows.set(show.track, show); if (this.shows.size > 8) this.shows.delete(this.shows.keys().next().value!); }
  has(track: string) { return this.shows.has(track); }
  show(track: string) { return this.shows.get(track) ?? null; }
  /** A new set (the first drop gets the stage lift again). */
  resetSet() { this.firstDropDone = false; this.fired.clear(); }

  private pickOwner(decks: DeckView[], now: number): number {
    const live = decks.filter((d) => d.playing && d.gain > 0.05);
    if (!live.length) return this.owner;
    const best = live.reduce((a, b) => (b.gain > a.gain + 1e-9 ? b : a));
    if (!this.owner || !decks.some((d) => d.n === this.owner && d.playing && d.gain > 0.05)) { this.owner = best.n; this.ownerSince = now; this.cand = 0; return this.owner; }
    if (best.n === this.owner) { this.cand = 0; return this.owner; }
    if (this.cand !== best.n) { this.cand = best.n; this.candSince = now; }
    if (now - this.candSince >= this.o.ownerHoldMs) { this.owner = best.n; this.ownerSince = now; this.cand = 0; }
    return this.owner;
  }

  /** One frame: returns the cues fired since the last step (exact times), owner first. */
  step(now: number, decks: DeckView[]): ShowFire[] {
    const out: ShowFire[] = [];
    let owner = this.pickOwner(decks, now);
    const audible = decks.filter((d) => d.playing && d.gain > 0.3);
    this.blend = audible.length > 1;
    // the incoming deck's drop wins: an audible non-owner crossing its drop takes the show over now
    for (const d of decks) {
      if (d.n === owner || !d.playing || d.gain <= 0.3 || d.conf < this.o.minConf) continue;
      const s = this.shows.get(d.track), l = this.last.get(d.n);
      if (!s || !l || l.track !== d.track || !Number.isFinite(d.beat)) continue;
      if (s.drops.some((D) => D > l.beat && D <= d.beat)) { this.owner = owner = d.n; this.ownerSince = now; this.cand = 0; }
    }
    for (const d of decks) {
      const prev = this.last.get(d.n);
      const okPos = Number.isFinite(d.beat) && d.conf >= this.o.minConf;
      if (!okPos) { if (!Number.isFinite(d.beat)) this.last.delete(d.n); continue; }
      this.last.set(d.n, { track: d.track, beat: d.beat, at: now });
      if (!prev || prev.track !== d.track) continue;                       // a new track / first sight: nothing crossed yet
      const s = this.shows.get(d.track);
      if (!s || d.n !== owner || !d.playing) continue;
      const db = d.beat - prev.beat;
      if (db <= 0) continue;                                               // paused or jumped back: re-evaluate only
      const jumped = db > 8;                                               // a beat jump forward: skip what was jumped over
      const per = 60000 / Math.max(20, d.bpm);
      for (let i = 0; i < s.cues.length; i++) {
        const c = s.cues[i];
        if (!(c.b > prev.beat && c.b <= d.beat)) continue;
        if (jumped && d.beat - c.b > 1) continue;
        if (c.out && this.blend) continue;
        if (c.first && this.firstDropDone) continue;
        const key = `${s.track}#${i}`;
        if (c.once) { const t = this.fired.get(key); if (t !== undefined && now - t < this.o.cooldownMs) continue; this.fired.set(key, now); }
        if (c.first) this.firstDropDone = true;
        const late = (d.beat - c.b) * per;
        out.push({ cue: c, deck: d.n, track: s.track, at: now - late, late });
      }
    }
    if (this.fired.size > 512) for (const [k, t] of this.fired) if (now - t > this.o.cooldownMs) this.fired.delete(k);
    return out;
  }

  /** What the owner's show says right now (null = no show / unsure: engines run their realtime show). */
  frame(decks: DeckView[]): ShowFrame | null {
    const d = decks.find((x) => x.n === this.owner);
    if (!d || !Number.isFinite(d.beat) || d.conf < this.o.minConf) return null;
    const s = this.shows.get(d.track);
    if (!s) return null;
    const b = d.beat;
    const on = (c: ShowCue) => c.b <= b && b < c.b + Math.max(c.d, 1e-6);
    let look: ShowCue | null = null, build = 0, chase = '', converge = 0, tiltUp = 0, blackout = false, ball = false, lasersOff = false, wall: ShowFrame['wall'] = '';
    for (const c of s.cues) {
      if (c.b > b) break;
      if (!on(c)) continue;
      const k = c.d > 0 ? (b - c.b) / c.d : 1;
      const ramp = (c.v0 ?? 0) + ((c.v ?? 1) - (c.v0 ?? 0)) * Math.max(0, Math.min(1, k));
      switch (c.layer) {
        case 'look': if ((!c.out || !this.blend) && (!look || (c.prio ?? 0) >= (look.prio ?? 0))) look = c; break;
        case 'build': {
          // a loop inside the build holds its level (never replays the ramp from the bottom)
          const key = `${s.track}@${c.b}`;
          const held = Math.max(this.buildHold.get(key) ?? 0, ramp);
          this.buildHold.set(key, held);
          build = Math.max(build, held);
          break;
        }
        case 'chase': chase = c.act; break;
        case 'beam': if (c.act === 'converge') converge = Math.max(converge, ramp); else tiltUp = Math.max(tiltUp, ramp); break;
        case 'blackout': if (!c.out || !this.blend) blackout = true; break;
        case 'ball': ball = true; break;
        case 'lasers': lasersOff = c.act === 'off'; break;
        case 'wall': wall = c.act as ShowFrame['wall']; break;
      }
    }
    if (this.buildHold.size > 64) this.buildHold.clear();
    const next = s.drops.find((D) => D > b);
    const sec = s.sections.find((x) => x.b <= b && b < x.e);
    const gw = sec?.g ? grooveFromWire(sec.g.f, sec.g.c, sec.g.h) : null;
    return { deck: d.n, track: s.track, beat: b, bpm: d.bpm, look, build, chase, converge, tiltUp, blackout, ball, lasersOff, dropIn: next === undefined ? Infinity : next - b, wall, blend: this.blend,
      groove: gw ? { feel: gw.feel, conf: gw.conf, hits: gw.hits, half: gw.half } : null };
  }
}

// ---------------------------------------------------------------------------------------------------- safety (bus)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : undefined);
const SECS = ['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'] as const;
/** A show from the bus, made safe (null = unusable). Recomputes the flash rate and refuses a show over the budget. */
export function sanitizeShow(o: unknown): TrackShow | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (x.v !== 1 || typeof x.id !== 'string' || x.id.length > 160 || typeof x.track !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(x.track)) return null;
  const style = oneOf(x.style, SHOW_STYLES) ?? 'auto';
  const cues: ShowCue[] = Array.isArray(x.cues) ? x.cues.slice(0, 4000).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>;
    const layer = oneOf(y.layer, SHOW_LAYERS);
    if (!layer || typeof y.act !== 'string' || !/^[a-z0-9-]{1,16}$/.test(y.act)) return [];
    const c: ShowCue = { b: num(y.b, -1e6, 1e6, 0), d: num(y.d, 0, 1e4, 0), layer, act: y.act };
    if (typeof y.v === 'number') c.v = num(y.v, 0, 1, 1); if (typeof y.v0 === 'number') c.v0 = num(y.v0, 0, 1, 0);
    if (typeof y.var === 'number') c.var = Math.round(num(y.var, 0, 8, 0)); if (typeof y.pal === 'number') c.pal = Math.round(num(y.pal, 0, 64, 0));
    if (y.once === true) c.once = true; if (y.first === true) c.first = true; if (y.out === true) c.out = true; if (y.full === true) c.full = true;
    if (typeof y.prio === 'number') c.prio = Math.round(num(y.prio, 0, 10, 0));
    if (typeof y.fest === 'string' && /^fest:[a-z0-9:_-]{1,60}$/.test(y.fest)) c.fest = y.fest;
    return [c];
  }) : [];
  const sections: ShowSectionSpan[] = Array.isArray(x.sections) ? x.sections.slice(0, 512).flatMap((q) => {
    const y = (q ?? {}) as Record<string, unknown>; const sec = oneOf(y.sec, SECS);
    const gx = y.g as Record<string, unknown> | undefined;
    const g = gx && typeof gx === 'object' && grooveFromWire(gx.f, gx.c, gx.h) ? { f: gx.f as number, c: num(gx.c, 0, 1, 0), h: (gx.h as number[]).slice(0, 48).map((v) => Math.round(num(v, -1000, 1000, 0))) } : undefined;
    return sec ? [{ b: num(y.b, -1e6, 1e6, 0), e: num(y.e, -1e6, 1e6, 0), sec, var: Math.round(num(y.var, 0, 8, 0)), pal: Math.round(num(y.pal, 0, 64, 0)), energy: num(y.energy, 0, 1, 0.5), ...(g ? { g } : {}) }] : [];
  }) : [];
  const bpm = num(x.bpm, 20, 400, 120);
  const show: TrackShow = {
    v: 1, id: x.id, track: x.track, style, genre: typeof x.genre === 'string' && /^[a-z]{1,16}$/.test(x.genre) ? x.genre : 'house', bpm,
    from: num(x.from, -1e6, 1e6, 0), to: num(x.to, -1e6, 1e6, 0), drops: Array.isArray(x.drops) ? x.drops.slice(0, 64).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [],
    sections, cues: cues.sort((p, q) => p.b - q.b), maxFlashHz: 0,
  };
  // (a page never trusts the sender's own claim: flashes measured at the show's tempo, +10 %)
  show.maxFlashHz = maxFlashRate(show, (b) => b * 60000 / bpm);
  if (show.maxFlashHz > MAX_FLASH_HZ) show.cues = enforceFlashBudget(show.cues, (b) => b * 60000 / bpm);
  return show;
}

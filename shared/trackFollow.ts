// Following the decks through the track: which analysed track is on each deck and where its playhead is, in BEATS of
// that track, locked to the live music clock. The model (research DJ_TRACK_ANALYSIS.md §5.1): a COARSE position from
// whichever source has one (a CDJ-3000's playhead every 30 ms, an Engine player's beat, VirtualDJ's song position,
// Traktor's elapsed time, or our own audio matcher) + the FINE phase of the music clock (beat packets, Link, BeatInfo,
// OS2L, the audio's beat). Each deck keeps one number k = track beat − clock beat; between reports the track simply
// advances with the clock. A report that disagrees by more than a quarter beat is a SEEK candidate (a loop, a hot cue,
// a beat jump): confirmed by the next report, the deck re-syncs; until then its confidence drops so nothing one-shot
// fires on a glitch. Stale or scratched = unsure = the realtime show takes over.
// Pure: tools/djtrack_unit.ts.
import { dropStarts, msToBeat, beatToMs, phraseIndexAt, type TrackAnalysis } from './trackAnalysis.ts';
import type { DeckState, PhraseInfo } from './musicClock.ts';

export const POS_SRCS = ['prolink', 'stagelinq', 'vdj', 'traktor', 'serato', 'osc', 'ctl', 'aligner', 'test'] as const;
export type PosSrc = (typeof POS_SRCS)[number];
export const POS_LABEL: Record<PosSrc, string> = {
  prolink: 'CDJ playhead (Pro DJ Link)', stagelinq: 'Engine DJ player (StageLinQ)', vdj: 'VirtualDJ (OSC)', traktor: 'Traktor deck data', serato: 'Serato', osc: 'track time (OSC: rkbx_link / your tool)', ctl: 'your controller + listening',
  aligner: 'audio matching', test: 'test',
};
/** How a source identifies the track on a deck (whatever it knows). */
export interface TrackIdent { path?: string; title?: string; artist?: string; durMs?: number; key?: string; trackId?: string;
  /** A streaming track's service id ("beatport:7207735", "spotify:<id>"): there is no file. */
  stream?: string;
  /** The version, when the source keeps it apart from the title ("Extended Mix"). */
  mix?: string }
export interface PosReport {
  src: PosSrc; deck: number;
  /** Helper epoch ms the position was true. Deck sources: when the DJ played it (latency is added); the aligner: in the
   *  audio the studio hears (`heard: true`). */
  at: number;
  /** Track position: ms from the file start, or a beat on the track's grid. */
  ms?: number; beat?: number;
  /** Playback rate (1 = normal; pitch +6 % = 1.06) when known. */
  rate?: number;
  playing: boolean;
  /** A deck reporting its own playhead (true) vs an estimate. */
  exact: boolean;
  heard?: boolean;
  ident: TrackIdent;
  /** The source's own confidence 0..1. */
  conf?: number;
}
export interface FollowDeck {
  n: number;
  track: string; title?: string; artist?: string;
  /** Track beat now (heard), effective BPM, confidence 0..1, playing. */
  beat: number; bpm: number; conf: number; playing: boolean;
  src: PosSrc; seeks: number;
  posMs: number; lenMs: number;
}

interface Deck {
  n: number; ident: string; a: TrackAnalysis | null;
  k: number; hasK: boolean;
  seek: { k: number; at: number } | null;
  agree: number; seeks: number;
  lastAt: number; src: PosSrc; exact: boolean; srcConf: number;
  playing: boolean; rate: number;
  /** last report's track beat + heard time (for clock-less extrapolation / pauses) */
  rb: number; rAt: number;
  pausedBeat: number;
  scratchAt: number;
  /** when the current run of agreeing reports began */
  agreeT0: number;
}
/** A position is only trusted (confidence can reach the show player's 0.6) once a SECOND report agrees with the first and
 *  the agreeing reports span this long — the first sample of a deck, the first listening lock, the first report after a
 *  jump: never enough on its own to fire a cue (two wrong samples 33 ms apart can't trigger a drop). */
export const SETTLE_MS = 250;
/** Confidence before that: under every threshold that fires anything. */
export const UNSETTLED_CONF = 0.45;
const identKey = (i: TrackIdent) => i.trackId ? `id:${i.trackId}` : i.stream ? `s:${i.stream}` : i.path ? `p:${i.path}` : `t:${(i.title ?? '').toLowerCase()}|${(i.artist ?? '').toLowerCase()}|${Math.round((i.durMs ?? 0) / 1000)}`;

export interface FollowerOptions {
  /** Library lookup: identity → analysis (null = not in the library). */
  resolve(ident: TrackIdent): TrackAnalysis | null;
  /** How long a deck source's position stays trusted without a new report (ms). */
  freshMs?: number;
  /** The aligner re-checks every few seconds: its positions stay trusted this long (ms). */
  alignerFreshMs?: number;
}

export class TrackFollower {
  private decks = new Map<number, Deck>();
  private clk = { t: 0, beat: 0, bpm: 0, lat: 0, ok: false };
  private o: Required<FollowerOptions>;
  constructor(o: FollowerOptions) { this.o = { freshMs: 1500, alignerFreshMs: 12000, ...o }; }

  /** The music clock now (every arbiter tick): its continuous beat at t (latency already applied), its BPM, and the
   *  latency (ms) between what a DJ deck plays and what the studio hears. bpm 0 = no clock. */
  clock(t: number, beat: number, bpm: number, latMs = 0) { this.clk = { t, beat, bpm, lat: latMs, ok: bpm > 0 && Number.isFinite(beat) }; }
  private clockAt(T: number) { return this.clk.beat + (T - this.clk.t) * this.clk.bpm / 60000; }
  private clockLive(now: number) { return this.clk.ok && now - this.clk.t < 1500; }
  /** The controller says a deck (0 = unknown → all) is being scratched / nudged hard. */
  scratch(deck: number, now: number) { for (const d of this.decks.values()) if (!deck || d.n === deck) d.scratchAt = now; }
  forget(deck: number) { this.decks.delete(deck); }

  report(r: PosReport, now = r.at) {
    if (!(r.deck >= 0 && r.deck <= 8)) return;
    const key = identKey(r.ident);
    let d = this.decks.get(r.deck);
    if (!d || d.ident !== key) {
      d = { n: r.deck, ident: key, a: this.o.resolve(r.ident), k: 0, hasK: false, seek: null, agree: 0, seeks: 0, lastAt: 0, src: r.src, exact: r.exact, srcConf: 1, playing: r.playing, rate: 1, rb: NaN, rAt: 0, pausedBeat: NaN, scratchAt: -Infinity, agreeT0: 0 };
      this.decks.set(r.deck, d);
    }
    if (!d.a) d.a = this.o.resolve(r.ident);   // (the library may have learned it meanwhile)
    d.src = r.src; d.exact = r.exact; d.srcConf = r.conf ?? 1; d.playing = r.playing; d.lastAt = now;
    if (r.rate && r.rate > 0.2 && r.rate < 3) d.rate = r.rate;
    const g = d.a?.grid;
    if (!g) return;
    const tb = r.beat !== undefined ? r.beat : r.ms !== undefined ? msToBeat(g, r.ms) : NaN;
    if (!Number.isFinite(tb)) return;
    const heardAt = r.at + (r.heard ? 0 : this.clk.lat);
    const prevRb = d.rb, prevRAt = d.rAt;
    d.rb = tb; d.rAt = heardAt;
    if (!r.playing) { d.pausedBeat = tb; d.hasK = false; d.seek = null; d.agree = 0; return; }
    const wasPaused = Number.isFinite(d.pausedBeat);
    d.pausedBeat = NaN;
    if (!this.clockLive(now)) {
      // no clock: a report agrees when it is where the last one said the deck would be by now
      d.hasK = false;
      const pred = Number.isFinite(prevRb) && !wasPaused ? prevRb + (heardAt - prevRAt) * (d.a!.bpm || g.anchors[0].bpm) * d.rate / 60000 : NaN;
      if (d.agree > 0 && Math.abs(tb - pred) <= 0.25) d.agree = Math.min(d.agree + 1, 8); else { d.agree = 1; d.agreeT0 = now; }
      return;
    }
    const kNew = tb - this.clockAt(heardAt);
    if (!d.hasK) { d.k = kNew; d.hasK = true; d.agree = 1; d.agreeT0 = now; d.seek = null; return; }
    if (Math.abs(kNew - d.k) <= 0.25) { d.k += (kNew - d.k) * (r.exact ? 0.25 : 0.5); d.agree = Math.min(d.agree + 1, 8); d.seek = null; return; }
    // a jump: confirmed by a second report saying the same, else ignored as a glitch (and trusted only once settled)
    if (d.seek && Math.abs(kNew - d.seek.k) <= 0.25) { d.k = kNew; d.agreeT0 = d.seek.at; d.seek = null; d.seeks++; d.agree = 2; return; }
    d.seek = { k: kNew, at: now };
  }

  /** Every deck's position now. */
  state(now: number): FollowDeck[] {
    const out: FollowDeck[] = [];
    const live = this.clockLive(now);
    for (const d of this.decks.values()) {
      const a = d.a;
      if (!a?.grid) { out.push({ n: d.n, track: a?.id ?? '', ...(a?.title ? { title: a.title } : {}), ...(a?.artist ? { artist: a.artist } : {}), beat: NaN, bpm: 0, conf: 0, playing: d.playing, src: d.src, seeks: d.seeks, posMs: NaN, lenMs: a?.durMs ?? 0 }); continue; }
      const g = a.grid;
      const trackBpm = a.bpm || g.anchors[0].bpm;
      let beat: number, bpm: number;
      if (!d.playing && Number.isFinite(d.pausedBeat)) { beat = d.pausedBeat; bpm = 0; }
      else if (live && d.hasK) { beat = this.clockAt(now) + d.k; bpm = this.clk.bpm; }
      else if (Number.isFinite(d.rb)) { bpm = trackBpm * d.rate; beat = d.rb + (now - d.rAt) * bpm / 60000; }
      else { beat = NaN; bpm = 0; }
      // confidence: fresh agreeing reports from a deck = sure; the aligner's own score; stale → fades; a pending seek or
      // a scratch → unsure (nothing fires)
      const age = now - d.lastAt;
      const fresh = d.src === 'aligner' ? this.o.alignerFreshMs : this.o.freshMs;
      let conf = d.srcConf * (d.exact ? Math.min(1, 0.5 + 0.25 * d.agree) : Math.min(1, 0.4 + 0.3 * d.agree));
      if (age > fresh) conf *= Math.max(0, 1 - (age - fresh) / 2500);
      if (d.seek) conf = Math.min(conf, 0.4);
      if (!(d.agree >= 2 && d.lastAt - d.agreeT0 >= SETTLE_MS)) conf = Math.min(conf, UNSETTLED_CONF);
      if (now - d.scratchAt < 600) conf = Math.min(conf, 0.3);
      if (!live && d.exact && age > 400) conf *= 0.8;
      out.push({ n: d.n, track: a.id, ...(a.title ? { title: a.title } : {}), ...(a.artist ? { artist: a.artist } : {}), beat, bpm, conf: +Math.max(0, Math.min(1, conf)).toFixed(3), playing: d.playing, src: d.src, seeks: d.seeks,
        posMs: Number.isFinite(beat) ? beatToMs(g, beat) : NaN, lenMs: a.durMs });
    }
    return out.sort((x, y) => x.n - y.n);
  }
  analysis(deck: number) { return this.decks.get(deck)?.a ?? null; }
}

/** How loud each deck is in the mix 0..1: on-air flag × channel fader × the crossfader curve (decks 1 / 3 on the left,
 *  2 / 4 on the right, the common default). Unknown pieces count as open. */
export function deckGains(decks: DeckState[] | undefined, xfade: number | undefined, onAir: number | undefined, follow: FollowDeck[]): Map<number, number> {
  const g = new Map<number, number>();
  const ns = new Set<number>([...follow.map((d) => d.n), ...(decks ?? []).map((d) => d.n)]);
  for (const n of ns) {
    const st = decks?.find((d) => d.n === n);
    const fd = follow.find((d) => d.n === n);
    const playing = (st?.playing ?? false) || (fd?.playing ?? false);
    let v = playing ? 1 : 0;
    if (st && decks?.some((d) => d.onAir)) v *= st.onAir ? 1 : 0.15;
    else if (onAir && decks?.length) v *= n === onAir ? 1 : 0.5;
    if (st?.fader !== undefined) v *= st.fader;
    if (xfade !== undefined) { const left = n % 2 === 1; const x = (xfade + 1) / 2; v *= left ? Math.min(1, 2 * (1 - x)) : Math.min(1, 2 * x); }
    g.set(n, +Math.max(0, Math.min(1, v)).toFixed(3));
  }
  return g;
}

/** The phrase at a track beat, as the music clock wants it (known: we know when it ends and when the drop comes). */
export function phraseAt(a: TrackAnalysis, beat: number): PhraseInfo | null {
  const i = phraseIndexAt(a.phrases, beat);
  if (i < 0) return null;
  const p = a.phrases[i], nx = a.phrases[i + 1];
  const info: PhraseInfo = { kind: p.kind, sec: p.sec, pos: +(beat - p.beat).toFixed(3), len: p.end - p.beat, known: true, ...(p.mood ? { mood: p.mood } : {}) };
  if (nx) { info.next = nx.kind; info.nextSec = nx.sec; }
  const D = dropStarts(a.phrases).find((x) => x > beat);
  if (D !== undefined) info.dropIn = +(D - beat).toFixed(3);
  return info;
}

// Following each deck's PLAYHEAD from the DJ controller (rekordbox performance mode + a Pioneer DDJ, Ableton Link via
// Carabiner, no deck data at all): the controller's own MIDI — which we only ever READ — says when the DJ presses play,
// pause, cue, a hot cue, a beat jump, a loop, moves the tempo fader or touches the jog. Together with WHICH track is on
// the deck (the "Now playing" picker, listening, a title from a source) and the track's rekordbox grid and cues, that
// is enough to estimate where each deck's playhead is: it starts on play, runs at (1 + pitch) × time (or at Link's
// tempo while the deck is synced), stops on pause / cue, jumps with hot cues / beat jumps, wraps inside loops. Link's
// beat phase pulls it onto rekordbox's grid (sub-beat drift), and a listening match (landmarks / rekordbox's waveform)
// re-anchors it.
//
// The estimate only reaches "sure" (the show player's 0.6) once something ANCHORED it — a listening match or a source's
// position — and only known operations keep it sure (play / pause / pitch / a hot cue rekordbox told us / a loop we saw
// set / a beat jump on the grid). A guess (the auto-cue start after a load, a cue press back to a cue point we never saw
// set, a scratch, an unknown pad) stays under that: the realtime show runs and no one-shot fires on a guess.
//
// Maps: ONE table for every lane — shared/djDeck/profiles.ts (the DJ decks' controller profiles: which MIDI message is
// which physical control, each entry marked where it comes from: 'doc' = the manufacturer's published MIDI message
// list, e.g. the DDJ-GRV6's; 'community' = public community mappings, e.g. Mixxx's DDJ-400 / FLX4; 'inferred' = the
// family's scheme, unconfirmed). This file only interprets the transport part of it (play, cue, Shift + cue = track
// start, sync, Shift + Master Tempo / Shift + Sync = tempo range, loop in / 4-beat / out / reloop, cue / loop call,
// jog top / side / Shift search, jog touch, the 14-bit tempo fader with or without Shift, hot cue / beat jump / beat
// loop pads, LOAD). Pioneer 4-deck controllers (GRV6, FLX6, SB3) send each control on the ACTIVE deck's channel (deck
// 3 on channel 3), so deck 1 / 3 and 2 / 4 switching needs no extra state. Only the Pioneer DDJ family (rekordbox
// performance mode) drives a playhead; other controllers keep driving the show's looks only.
// Pure: tools/djtrack_unit.ts (section "deckctl").
import { beatToMs, msToBeat, type TrackAnalysis } from './trackAnalysis.ts';
import { DECK_PROFILES, type DeckMapEntry, type DeckProfile, type EntrySrc } from './djDeck/profiles.ts';

const TRANSPORT_CTLS = new Set<string>(['play', 'cue', 'sync', 'mt', 'loopIn', 'loopOut', 'reloop', 'callPrev', 'callNext', 'jog', 'jogTouch', 'tempo', 'pad', 'load', 'fader', 'xf']);
/** The controller's profile when it can drive a playhead (the Pioneer DDJ family), else null (ignored here). */
export function transportMapFor(port: string): DeckProfile | null {
  const p = DECK_PROFILES.find((x) => x.match.test(port));
  return p && /^ddj-/.test(p.id) ? p : null;
}
/** Where each transport control of a profile comes from ('doc' = the manufacturer's MIDI list). */
export function transportSources(p: DeckProfile): Partial<Record<string, EntrySrc>> {
  const out: Partial<Record<string, EntrySrc>> = {};
  for (const e of p.entries) if (TRANSPORT_CTLS.has(e.ctl) && !e.shift && !out[e.ctl]) out[e.ctl] = e.src;
  return out;
}

/** rekordbox's tempo ranges (Shift + Master Tempo / Shift + Sync cycles them); ±10 % is its default. */
export const TEMPO_RANGES = [0.06, 0.10, 0.16, 1.0];
/** Beat jump pads (rekordbox's defaults: pairs back / forward). */
export const BEAT_JUMPS = [-1, 1, -2, 2, -4, 4, -8, 8];
/** Beat loop pads. */
export const BEAT_LOOPS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
/** Pad modes (note = mode × 16 + pad) that move the playhead. */
const PAD_HOTCUE = 0, PAD_JUMP = 2, PAD_LOOP = 6;
/** Jog: ticks per platter turn (default; the profile's own when it has one) and the track time one turn moves (33⅓ rpm). */
export const JOG_TICKS = 720, JOG_TURN_MS = 1800;
/** Confidence levels (the show player fires at 0.6). */
export const CTL_CONF = { anchored: 0.9, guess: 0.5, lost: 0.3, min: 0.6 };
/** An unsynced deck's estimate is trusted this long after the last anchor (listening re-anchors every few seconds). */
export const CTL_STALE_MS = 120000;

export interface DeckOp { t: number; deck: number; op: 'play' | 'cue' | 'cueUp' | 'start' | 'hotcue' | 'hotcueUp' | 'jump' | 'loop' | 'loopIn' | 'loopOut' | 'reloop' | 'call' | 'load' | 'sync' | 'range' | 'tempo' | 'scratch' | 'bend' | 'search' | 'touch' | 'untouch' | 'pad' | 'chfader' | 'xfade'; v?: number }

/** MIDI → deck operations for one controller (null profile = nothing). */
export class TransportReader {
  private index = new Map<number, DeckMapEntry>();
  private lsbOf = new Map<number, DeckMapEntry>();
  private msb = new Map<DeckMapEntry, number>();
  readonly jogTicks: number;
  constructor(readonly map: DeckProfile | null) {
    this.jogTicks = map?.jogTicks ?? JOG_TICKS;
    for (const e of map?.entries ?? []) {
      if (!TRANSPORT_CTLS.has(e.ctl)) continue;
      const k = (e.st << 8) | e.d1;
      if (!this.index.has(k)) this.index.set(k, e);
      if (e.v === 'hi') this.lsbOf.set((e.st << 8) | (e.lsb ?? e.d1 + 0x20), e);
    }
  }
  feed(st: number, d1: number, d2: number, t: number): DeckOp[] {
    if (!this.map) return [];
    const type = st & 0xf0, ch = st & 15;
    if (type !== 0x80 && type !== 0x90 && type !== 0xb0) return [];
    const isNote = type !== 0xb0, on = type === 0x90 && d2 > 0, off = isNote && !on;
    const key = ((isNote ? 0x90 | ch : st) << 8) | d1;
    const e = this.index.get(key);
    if (!e) {
      // the LSB of a 14-bit tempo fader: MSB + LSB → −1 … +1 (0 = the "−" end, 0x3FFF = the "+" end)
      const h = !isNote ? this.lsbOf.get(key) : undefined;
      if (h && h.ctl === 'tempo') { const m = this.msb.get(h); return m === undefined ? [] : [{ t, deck: h.deck, op: 'tempo', v: ((m << 7) | d2) / 8192 - 1 }]; }
      // (channel faders / crossfader: which deck is on air)
      if (h && (h.ctl === 'fader' || h.ctl === 'xf')) { const m = this.msb.get(h); if (m === undefined) return []; const v = ((m << 7) | d2) / 16383; return [h.ctl === 'xf' ? { t, deck: 0, op: 'xfade', v: v * 2 - 1 } : { t, deck: h.deck, op: 'chfader', v }]; }
      // (the 2-deck DDJs' Shift + Sync, 0x60, cycles the tempo range: not in the shared table)
      if (on && d1 === 0x60 && ch < this.map.decks && !this.map.entries.some((x) => x.ctl === 'mt')) return [{ t, deck: ch + 1, op: 'range' }];
      return [];
    }
    const deck = e.deck;
    if (e.ctl === 'fader' || e.ctl === 'xf') { if (e.v === 'hi') { this.msb.set(e, d2); return []; } const v = d2 / 127; return [e.ctl === 'xf' ? { t, deck: 0, op: 'xfade', v: v * 2 - 1 } : { t, deck, op: 'chfader', v }]; }
    if (!(deck >= 1 && deck <= 4)) return [];
    switch (e.ctl) {
      case 'play': return on && !e.shift ? [{ t, deck, op: 'play' }] : [];
      case 'cue': return e.shift ? (on ? [{ t, deck, op: 'start' }] : []) : on ? [{ t, deck, op: 'cue' }] : off ? [{ t, deck, op: 'cueUp' }] : [];
      case 'sync': return on && !e.shift ? [{ t, deck, op: 'sync' }] : [];
      case 'mt': return on && e.shift ? [{ t, deck, op: 'range' }] : [];   // (Shift + Master Tempo: the tempo range)
      case 'loopIn': return on && !e.shift ? (d1 === 0x14 ? [{ t, deck, op: 'loop', v: 4 }] : [{ t, deck, op: 'loopIn' }]) : [];   // (GRV6: a long press = a 4-beat loop)
      case 'loopOut': return on && !e.shift ? [{ t, deck, op: 'loopOut' }] : [];
      case 'reloop': return on && !e.shift ? [{ t, deck, op: 'reloop' }] : [];
      case 'callPrev': case 'callNext': return on && !e.shift ? [{ t, deck, op: 'call', v: e.ctl === 'callPrev' ? -1 : 1 }] : [];
      case 'jogTouch': return on ? [{ t, deck, op: 'touch' }] : off ? [{ t, deck, op: 'untouch' }] : [];
      case 'jog': {
        const v = e.v === 'tc' ? (d2 < 64 ? d2 : d2 - 128) : d2 - 64;
        if (e.shift) return [{ t, deck, op: 'search', v }];
        return [{ t, deck, op: e.jog === 'top' && d1 === 0x22 ? 'scratch' : 'bend', v }];
      }
      case 'tempo': if (e.v === 'hi') { this.msb.set(e, d2); return []; } return [{ t, deck, op: 'tempo', v: d2 / 64 - 1 }];
      case 'pad': {
        if (e.shift || e.mode === undefined || e.i === undefined || e.i > 7) return on ? [{ t, deck, op: 'pad' }] : [];
        if (e.mode === PAD_HOTCUE) return on ? [{ t, deck, op: 'hotcue', v: e.i }] : off ? [{ t, deck, op: 'hotcueUp', v: e.i }] : [];
        if (e.mode === PAD_JUMP && on) return [{ t, deck, op: 'jump', v: BEAT_JUMPS[e.i] }];
        if (e.mode === PAD_LOOP && on) return [{ t, deck, op: 'loop', v: BEAT_LOOPS[e.i] }];
        return on ? [{ t, deck, op: 'pad' }] : [];
      }
      case 'load': return on && !e.shift ? [{ t, deck, op: 'load' }] : [];
    }
    return [];
  }
}

interface Deck {
  n: number;
  a: TrackAnalysis | null;
  playing: boolean;
  /** Position (ms, track time) at t0. */
  pos0: number; t0: number;
  /** Tempo fader −1..1 (× range) and the range. */
  fader: number; range: number; rangeKnown: boolean;
  synced: boolean;
  /** The rate a listening match measured (until the tempo fader / sync / range moves: the fader's absolute position
   *  isn't known before it first moves). */
  measured: number | null;
  conf: number;
  /** The deck's cue point (ms) and whether we saw it set (else it's rekordbox's auto cue: a guess). */
  cue: number; cueKnown: boolean;
  /** Playing only while CUE / a hot cue is held (rekordbox's preview): back on release. */
  held: { kind: 'cue' | 'hotcue'; ms: number; known: boolean } | null;
  loop: { in: number; out: number; on: boolean } | null;
  loopIn: number | null;
  touched: boolean;
  lastOp: number;
  /** When something last anchored it (listening / a source). */
  anchoredAt: number;
}

/** Every deck's estimated playhead. Feed it ops (TransportReader), the clock and identities; read `reports()`. */
export class DeckEstimator {
  private decks = new Map<number, Deck>();
  private clk = { t: 0, beat: NaN, bpm: 0 };
  /** The deck the DJ touched last (a picked track goes there). */
  focus = 1;
  /** Channel faders (0..1, by channel = deck) and the crossfader (−1 … +1), as the controller last sent them. */
  faders = new Map<number, number>();
  xfade: number | undefined;
  constructor(readonly deckCount = 2, readonly jogTicks = JOG_TICKS) {}
  private deck(n: number): Deck {
    let d = this.decks.get(n);
    if (!d) { d = { n, a: null, playing: false, pos0: 0, t0: 0, fader: 0, range: 0.10, rangeKnown: false, synced: false, measured: null, conf: 0, cue: 0, cueKnown: false, held: null, loop: null, loopIn: null, touched: false, lastOp: 0, anchoredAt: -Infinity }; this.decks.set(n, d); }
    return d;
  }
  /** The music clock (Link / the audio): beat at t and its tempo (0 = none). */
  clock(t: number, beat: number, bpm: number) { this.clk = { t, beat, bpm }; }
  private trackBpm(d: Deck) { return d.a?.bpm || d.a?.grid?.anchors[0].bpm || 0; }
  /** The deck's playback rate: Link's tempo ÷ the track's while synced (and close), else 1 + fader × range. */
  rate(n: number): number {
    const d = this.deck(n), tb = this.trackBpm(d), byFader = 1 + d.fader * d.range;
    if (d.synced && this.clk.bpm > 0 && tb > 0) { for (const m of [1, 2, 0.5]) { const r = this.clk.bpm * m / tb; if (Math.abs(r - 1) <= Math.max(0.1, d.range)) return r; } }
    return d.measured ?? byFader;
  }
  /** Position (ms) at t, loops applied. */
  posAt(n: number, t: number): number {
    const d = this.deck(n);
    let p = d.pos0 + (d.playing ? (t - d.t0) * this.rate(n) : 0);
    if (d.loop?.on && d.loop.out > d.loop.in && p >= d.loop.out) p = d.loop.in + ((p - d.loop.in) % (d.loop.out - d.loop.in));
    const dur = d.a?.durMs ?? 0;
    return dur > 0 ? Math.max(0, Math.min(dur, p)) : Math.max(0, p);
  }
  private setPos(d: Deck, t: number, ms: number) { d.pos0 = ms; d.t0 = t; }
  private beatOf(d: Deck, ms: number) { return d.a?.grid ? msToBeat(d.a.grid, ms) : NaN; }
  private msOf(d: Deck, beat: number) { return d.a?.grid ? beatToMs(d.a.grid, beat) : NaN; }
  private lower(d: Deck, to: number) { d.conf = Math.min(d.conf, to); }

  /** A track is on the deck (picked, identified, named). New track = rekordbox's auto cue: the first memory cue, else
   *  the first beat (a guess until something anchors it). Same track = nothing changes. */
  setTrack(n: number, a: TrackAnalysis | null, t: number) {
    const d = this.deck(n);
    if (a && d.a?.id === a.id) return;
    d.a = a; d.loop = null; d.loopIn = null; d.held = null;
    const mem = a?.cues.filter((c) => c.kind === 'memory' || c.kind === 'cue').sort((x, y) => x.ms - y.ms)[0];
    d.cue = mem?.ms ?? a?.grid?.anchors[0].ms ?? 0; d.cueKnown = false;
    if (!d.playing) this.setPos(d, t, d.cue);
    d.conf = a ? CTL_CONF.guess : 0;
  }
  /** Something knows exactly where the deck is (a listening match, a source's playhead). */
  anchor(n: number, ms: number, at: number, t: number, rate?: number, conf: number = CTL_CONF.anchored) {
    const d = this.deck(n);
    // (an anchor comes from hearing the deck: it plays)
    if (rate && rate > 0.5 && rate < 2) d.measured = rate;
    this.setPos(d, t, ms + (t - at) * this.rate(n));
    d.playing = true;
    d.conf = conf;   // (a placement that isn't trusted yet stays under the show's 0.6)
    d.anchoredAt = t;
  }
  /** The deck the decks' track identity / an anchor should go to (the last one touched that plays, else any playing). */
  playingDecks(): number[] { return [...this.decks.values()].filter((d) => d.playing).map((d) => d.n); }
  op(o: DeckOp) {
    if (o.op === 'xfade') { this.xfade = o.v; return; }
    if (o.op === 'chfader') { if (o.v !== undefined) this.faders.set(o.deck, o.v); return; }
    if (o.deck < 1 || o.deck > Math.max(this.deckCount, 4)) return;
    const d = this.deck(o.deck), t = o.t, now = this.posAt(o.deck, t);
    d.lastOp = t;
    if (o.op !== 'tempo' && o.op !== 'bend' && o.op !== 'scratch') this.focus = o.deck;
    switch (o.op) {
      case 'play':
        if (d.held) { d.held = null; d.playing = true; this.setPos(d, t, now); break; }   // (play while CUE held: keeps playing)
        this.setPos(d, t, now); d.playing = !d.playing;
        break;
      case 'cue':
        if (d.playing) { this.setPos(d, t, d.cue); d.playing = false; if (!d.cueKnown) this.lower(d, CTL_CONF.guess); }
        else { d.cue = now; d.cueKnown = d.conf >= CTL_CONF.min; d.held = { kind: 'cue', ms: now, known: d.cueKnown }; this.setPos(d, t, now); d.playing = true; }
        break;
      case 'cueUp':
        if (d.held?.kind === 'cue') { this.setPos(d, t, d.held.ms); d.playing = false; d.held = null; }
        break;
      case 'hotcue': {
        const hc = d.a?.cues.find((c) => c.kind === 'hot' && c.n === o.v);
        if (!hc) { if (!d.a) this.lower(d, CTL_CONF.guess); break; }   // (an empty pad SETS a hot cue here: no jump)
        if (d.playing) { this.setPos(d, t, hc.ms); if (d.loop) d.loop.on = false; }
        else { d.held = { kind: 'hotcue', ms: hc.ms, known: true }; this.setPos(d, t, hc.ms); d.playing = true; }
        break;
      }
      case 'hotcueUp':
        if (d.held?.kind === 'hotcue') { this.setPos(d, t, d.held.ms); d.playing = false; d.held = null; }
        break;
      case 'jump': {
        const b = this.beatOf(d, now);
        if (!Number.isFinite(b)) { this.lower(d, CTL_CONF.guess); break; }
        this.setPos(d, t, this.msOf(d, b + (o.v ?? 0)));
        break;
      }
      case 'loop': {
        const len = o.v ?? 4;
        if (d.loop?.on && Math.abs((this.beatOf(d, d.loop.out) - this.beatOf(d, d.loop.in)) - len) < 0.01) { d.loop.on = false; this.setPos(d, t, now); break; }   // (the same pad again: exit)
        const b = this.beatOf(d, now);
        if (!Number.isFinite(b)) { this.lower(d, CTL_CONF.guess); break; }
        const b0 = len >= 1 ? Math.floor(b) : Math.floor(b / len) * len;   // (quantised: rekordbox starts it on the beat)
        this.setPos(d, t, now);
        d.loop = { in: this.msOf(d, b0), out: this.msOf(d, b0 + len), on: true };
        break;
      }
      case 'loopIn': d.loopIn = this.snapBeat(d, now); break;
      case 'loopOut': {
        const out = this.snapBeat(d, now);
        if (d.loopIn !== null && out > d.loopIn) { this.setPos(d, t, now); d.loop = { in: d.loopIn, out, on: true }; }
        break;
      }
      case 'reloop':
        if (d.loop?.on) { d.loop.on = false; this.setPos(d, t, now); }
        else if (d.loop) { d.loop.on = true; this.setPos(d, t, d.loop.in); }
        break;
      case 'load': d.a = null; d.playing = false; d.loop = null; d.held = null; d.conf = 0; this.setPos(d, t, 0); break;
      case 'sync': this.setPos(d, t, now); d.measured = null; d.synced = !d.synced; break;
      case 'range': this.setPos(d, t, now); d.range = TEMPO_RANGES[(TEMPO_RANGES.indexOf(d.range) + 1) % TEMPO_RANGES.length] ?? 0.10; d.rangeKnown = true; break;
      case 'tempo':
        this.setPos(d, t, now); d.measured = null; d.fader = Math.max(-1, Math.min(1, o.v ?? 0));
        // (the fader moved and its range was never seen set: rekordbox's ±10 % is a guess until listening measures it)
        if (!d.synced && !d.rangeKnown && Math.abs(d.fader) > 0.002) this.lower(d, CTL_CONF.guess);
        break;
      case 'touch': d.touched = true; break;
      case 'untouch': d.touched = false; break;
      case 'scratch':
        // turning the platter's top: the record moves under the needle (a guess: never sure)
        this.setPos(d, t, Math.max(0, now + (o.v ?? 0) / this.jogTicks * JOG_TURN_MS));
        // (always: a controller that sends the vinyl-on jog without a touch note must not keep an anchored deck sure)
        this.lower(d, CTL_CONF.lost);
        break;
      case 'bend':
        // nudging a playing deck: a small push (Link / listening pull it back exactly)
        if (d.playing) this.setPos(d, t, now + (o.v ?? 0) / this.jogTicks * JOG_TURN_MS * 0.1);
        break;
      case 'search':
        // Shift + jog: a fast search through the track (how far isn't known exactly): lost until heard again
        this.setPos(d, t, Math.max(0, now + (o.v ?? 0) / this.jogTicks * JOG_TURN_MS * 8));
        this.lower(d, CTL_CONF.lost);
        break;
      case 'start':
        // Shift + CUE: back to the start of the track (a known place: the confidence stays)
        this.setPos(d, t, 0); if (d.loop) d.loop.on = false;
        break;
      case 'call': {
        // CUE / LOOP CALL: the previous / next memory cue rekordbox keeps for the track becomes the cue point; the deck goes there
        const mem = (d.a?.cues ?? []).filter((c) => c.kind === 'memory' || c.kind === 'loop').map((c) => c.ms).sort((x, y) => x - y);
        const to = (o.v ?? 1) < 0 ? [...mem].reverse().find((ms) => ms < now - 50) : mem.find((ms) => ms > now + 50);
        if (to === undefined) { if (!mem.length) this.lower(d, CTL_CONF.guess); break; }
        d.cue = to; d.cueKnown = true; this.setPos(d, t, to);
        break;
      }
      case 'pad': break;
    }
  }
  private snapBeat(d: Deck, ms: number) { const b = this.beatOf(d, ms); return Number.isFinite(b) ? this.msOf(d, Math.round(b)) : ms; }
  /** Pull synced, playing decks onto the clock's beat phase (only small corrections: < 0.35 beat). */
  snap(t: number) {
    if (!(this.clk.bpm > 0) || !Number.isFinite(this.clk.beat)) return;
    const cb = this.clk.beat + (t - this.clk.t) * this.clk.bpm / 60000, frac = cb - Math.floor(cb);
    for (const d of this.decks.values()) {
      if (!d.playing || !d.synced || !d.a?.grid || d.touched) continue;
      const b = this.beatOf(d, this.posAt(d.n, t));
      const target = Math.round(b - frac) + frac;
      if (Math.abs(target - b) < 0.35 && Math.abs(target - b) > 0.005) this.setPos(d, t, this.msOf(d, target));
    }
  }
  /** Each deck with a track: where it is now and how sure. */
  reports(t: number): { deck: number; trackId: string; ms: number; rate: number; playing: boolean; conf: number }[] {
    const out: { deck: number; trackId: string; ms: number; rate: number; playing: boolean; conf: number }[] = [];
    for (const d of this.decks.values()) {
      if (!d.a) continue;
      // (a held CUE / hot cue preview is a moment, not the show: unsure while held)
      let conf = d.held ? Math.min(d.conf, CTL_CONF.guess) : d.touched ? Math.min(d.conf, CTL_CONF.lost) : d.conf;
      // (dead reckoning drifts: an unsynced deck nothing re-anchored for 2 minutes is a guess again)
      if (!d.synced && d.playing && t - d.anchoredAt > CTL_STALE_MS) conf = Math.min(conf, CTL_CONF.guess);
      out.push({ deck: d.n, trackId: d.a.id, ms: this.posAt(d.n, t), rate: this.rate(d.n), playing: d.playing, conf });
    }
    return out;
  }
  trackOf(n: number): string | null { return this.decks.get(n)?.a?.id ?? null; }
  isPlaying(n: number): boolean { return !!this.decks.get(n)?.playing; }
}

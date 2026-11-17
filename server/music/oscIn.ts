// OSC in (UDP, default port 4460 = where rkbx_link sends by default): DJ data from tools the user already runs.
// We only RECEIVE OSC — we never read rekordbox's memory or its database ourselves.
// Understood out of the box:
//  - our own map (docs/DJ_SYNC.md): /vtp/bpm f · /vtp/beat i|f [bar 1-4] · /vtp/bar i · /vtp/playing i · /vtp/phrase s [beats left]
//    · /vtp/drop_in f · /vtp/title s · /vtp/artist s · /vtp/time f (s into the track) · /vtp/xfade f (−1..1) · /vtp/fader i f · /vtp/pad i [deck] · /vtp/fx i i
//  - rkbx_link: /master/bpm/current f, /master/beat/subdiv/<x> f (0..1 over x beats), /master/beat/trigger/<x>,
//    /master/track/title|artist s, /master/phrase/current|next, /master/phrase/countin f, /master/time f (or /time/master: the track position — with
//    a title, the Track library follows the track on rekordbox's own grid and phrases, streaming tracks too)
//  - Deep Symmetry's open-beat-control: /master/beat (dev, beat 1-4, tempo, track tempo, pitch), /master/tempo f,
//    /master/playing i (we ask it for the /master stream on 127.0.0.1:17002 — a local app, never the DJ's gear)
//  - VirtualDJ OSC replies: /vdj/(deck/N|masterdeck)/get_bpm f, /vdj/.../get_beatpos f
import type dgram from 'node:dgram';
import { GridTracker, sectionOf, type ControllerEvent, type PhraseInfo, type PhraseKind, type SourceSample, PHRASE_KINDS } from '../../shared/musicClock.ts';
import { encodeMessage, I, parseOsc, S, type OscArg, type OscMessage } from '../tracking/osc.ts';
import { plainNetError, Rate, udpBind, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

export interface OscConfig { port: number; bind?: string; askOpenBeatControl?: boolean; obcPort?: number; /** VirtualDJ's own OSC port (its `oscPort` setting): we subscribe to each deck's file + position there (this PC only). 0 = off. */ vdjPort?: number }

const numArg = (a: OscArg | undefined): number | null => (typeof a === 'number' && Number.isFinite(a) ? a : typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a)) ? Number(a) : null);
const strArg = (a: OscArg | undefined): string | null => (typeof a === 'string' ? a.slice(0, 160) : null);

/** A phrase word from any tool ("Intro 1", "UP", "chorus", 5) → our kind. */
export function phraseWord(v: OscArg | undefined): PhraseKind | null {
  if (typeof v === 'string') {
    const w = v.toLowerCase().replace(/[^a-z]/g, '');
    if ((PHRASE_KINDS as readonly string[]).includes(w)) return w as PhraseKind;
    if (w.startsWith('intro')) return 'intro';
    if (w.startsWith('up') || w.startsWith('build') || w.startsWith('rise')) return 'up';
    if (w.startsWith('down') || w.startsWith('break')) return 'down';
    if (w.startsWith('chorus') || w.startsWith('drop') || w.startsWith('hook')) return 'chorus';
    if (w.startsWith('outro')) return 'outro';
    if (w.startsWith('verse')) return 'verse';
    if (w.startsWith('bridge')) return 'bridge';
    return null;
  }
  if (typeof v === 'number') {   // rekordbox HIGH-mood numbers: 1 intro, 2 up, 3 down, 5 chorus, 6 outro
    return ({ 1: 'intro', 2: 'up', 3: 'down', 5: 'chorus', 6: 'outro' } as Record<number, PhraseKind>)[Math.round(v)] ?? null;
  }
  return null;
}

type Kind = 'vtp' | 'rkbx' | 'obc' | 'vdj';
const LABEL: Record<Kind, string> = { vtp: 'OSC', rkbx: 'rkbx_link (OSC)', obc: 'open-beat-control (OSC)', vdj: 'VirtualDJ (OSC)' };

export class OscAdapter implements Adapter {
  readonly id = 'osc' as const;
  private sock: dgram.Socket | null = null;
  private grid = new GridTracker(4000);
  private bpm = 0;
  private lastBeatAt = -Infinity;
  private beatCount = 0;
  private barOfLast = -1;
  private sub4: { k: number; last: number } = { k: 0, last: -1 };
  private playingFlag: boolean | null = null;
  private title = ''; private artist = '';
  private phrase: { kind: PhraseKind; next?: PhraseKind; left?: number; at: number } | null = null;
  private dropIn: { beats: number; at: number } | null = null;
  private xfade: number | undefined;
  private faders: number[] = [];
  private kind: Kind = 'vtp';
  private seenKinds = new Set<Kind>();
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** VirtualDJ decks (OSC replies): file, position (0..1), length (s), playing, audible. */
  private vdj = new Map<number, { path?: string; pos?: number; len?: number; playing?: boolean; audible?: boolean; at: number }>();
  constructor(private ctx: AdapterCtx, private cfg: OscConfig) {}

  async start() {
    this.state = 'starting';
    try { this.sock = await udpBind(this.cfg.port, this.cfg.bind ?? '127.0.0.1'); }   // (this PC only unless the user picks a network)
    catch (e) { this.state = 'error'; this.says = plainNetError(e, 'the OSC port', this.cfg.port); return; }
    this.sock.on('message', (m) => { let msgs: OscMessage[]; try { msgs = parseOsc(m); } catch { return; } for (const x of msgs) this.message(x); });
    this.state = 'listening';
    this.says = `Listening for OSC on port ${this.cfg.port}.`;
    const ask = () => {
      if (this.cfg.askOpenBeatControl === false || !this.sock) return;
      try { this.sock.send(encodeMessage('/master', [S('stream'), I(this.cfg.port)]), this.cfg.obcPort ?? 17002, '127.0.0.1'); } catch { /* not running */ }
    };
    ask();
    // VirtualDJ (opt-in: its OSC port): ask it to keep sending each deck's file and position to us
    const vdjSub = () => {
      if (!this.cfg.vdjPort || !this.sock) return;
      for (let d = 1; d <= 4; d++) for (const verb of ['get_filepath', 'song_pos', 'get_songlength', 'play', 'is_audible']) {
        try { this.sock.send(encodeMessage(`/vdj/subscribe/deck/${d}/${verb}`, []), this.cfg.vdjPort, '127.0.0.1'); } catch { /* not running */ }
      }
    };
    vdjSub();
    let n = 0;
    this.timer = setInterval(() => { if (++n % 30 === 0) { ask(); vdjSub(); } this.stale(); }, 500);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock?.close(); } catch { /* closed */ }
    this.sock = null;
    this.ctx.drop('osc');
    this.state = 'off';
  }

  /** One OSC message (exported for tests via the adapter instance). */
  message(m: OscMessage) {
    const now = this.ctx.now();
    const a = m.address.toLowerCase(), args = m.args;
    this.rate.hit();
    let beatObs: number | null = null, barIn: number | null = null;
    const evs: ControllerEvent[] = [];
    const seen = (k: Kind) => { this.seenKinds.add(k); this.kind = k; };
    if (a.startsWith('/vtp/')) {
      seen('vtp');
      const n0 = numArg(args[0]);
      switch (a) {
        case '/vtp/bpm': if (n0 && n0 > 20 && n0 < 400) this.bpm = n0; break;
        case '/vtp/beat': if (n0 !== null) { beatObs = n0; const b = numArg(args[1]); if (b !== null && b >= 1 && b <= 4) barIn = b; } break;
        case '/vtp/bar': if (n0 !== null && n0 >= 1 && n0 <= 4) this.barOfLast = n0 - 1; break;
        case '/vtp/playing': this.playingFlag = !!n0; break;
        case '/vtp/phrase': { const k = phraseWord(args[0]); if (k) this.phrase = { kind: k, left: numArg(args[1]) ?? undefined, at: now }; break; }
        case '/vtp/drop_in': if (n0 !== null) this.dropIn = { beats: n0, at: now }; break;
        case '/vtp/title': this.title = strArg(args[0]) ?? ''; break;
        case '/vtp/artist': this.artist = strArg(args[0]) ?? ''; break;
        case '/vtp/time': if (n0 !== null) this.trackTime(n0, now); break;
        case '/vtp/xfade': if (n0 !== null) { this.xfade = Math.max(-1, Math.min(1, n0)); evs.push({ t: now, kind: 'xfade', deck: 0, v: this.xfade }); } break;
        case '/vtp/fader': { const d = numArg(args[0]), v = numArg(args[1]); if (d && v !== null && d >= 1 && d <= 4) { this.faders[d - 1] = Math.max(0, Math.min(1, v)); evs.push({ t: now, kind: 'fader', deck: d, v: this.faders[d - 1] }); } break; }
        case '/vtp/pad': if (n0 !== null) evs.push({ t: now, kind: 'pad', deck: numArg(args[1]) ?? 1, i: Math.max(0, Math.min(63, n0 - 1)), v: 1 }); break;
        case '/vtp/fx': if (n0 !== null) evs.push({ t: now, kind: 'fx', deck: 0, i: Math.max(0, n0 - 1), v: numArg(args[1]) ? 1 : 0 }); break;
      }
    } else if (/^\/master\/(bpm|beat\/|track\/|phrase\/|time)/.test(a) || a === '/time/master') {
      seen('rkbx');
      const n0 = numArg(args[0]);
      if (a === '/master/bpm/current' && n0 && n0 > 20 && n0 < 400) this.bpm = n0;
      else if (a === '/master/beat/subdiv/4' && n0 !== null) {
        // 0..1 over a bar: unwrap into a continuous position
        if (this.sub4.last >= 0 && n0 < this.sub4.last - 0.5) this.sub4.k++;
        this.sub4.last = n0;
        if (this.bpm > 0) this.grid.observe(now, this.sub4.k * 4 + n0 * 4, this.bpm);
        this.lastBeatAt = Math.max(this.lastBeatAt, now - 1);
      } else if (a === '/master/beat/trigger/1' && (n0 ?? 1) > 0.5 && this.sub4.last < 0) beatObs = Number.NaN;
      else if (a === '/master/track/title') this.title = strArg(args[0]) ?? '';
      else if (a === '/master/track/artist') this.artist = strArg(args[0]) ?? '';
      else if ((a === '/master/time' || a === '/time/master') && n0 !== null) this.trackTime(n0, now);
      else if (a === '/master/phrase/current') { const k = phraseWord(args[0]); if (k) this.phrase = { ...(this.phrase ?? {}), kind: k, at: now }; }
      else if (a === '/master/phrase/next') { const k = phraseWord(args[0]); if (k && this.phrase) this.phrase.next = k; }
      else if (a === '/master/phrase/countin' && n0 !== null && this.phrase) { this.phrase.left = n0; this.phrase.at = now; }
    } else if (a === '/master/beat' || a === '/master/tempo' || a === '/master/playing' || a === '/master/none') {
      seen('obc');
      if (a === '/master/beat') { const t = numArg(args[2]), b = numArg(args[1]); if (t && t > 20) this.bpm = t; beatObs = Number.NaN; if (b !== null && b >= 1 && b <= 4) barIn = b; }
      else if (a === '/master/tempo') { const t = numArg(args[0]); if (t && t > 20) this.bpm = t; }
      else if (a === '/master/playing') this.playingFlag = !!numArg(args[0]);
      else this.playingFlag = false;
    } else if (a.startsWith('/vdj/')) {
      seen('vdj');
      const n0 = numArg(args[0]);
      // a deck's file / position (track library): /vdj/deck/N/get_filepath s · song_pos f (0..1) · get_songlength f (s) · play i · is_audible i
      const dm = /^\/vdj\/deck\/([1-4])\/(get_filepath|song_pos|get_songlength|play|is_audible)$/.exec(a);
      if (dm) {
        const d = Number(dm[1]), st = this.vdj.get(d) ?? { at: now };
        if (dm[2] === 'get_filepath') st.path = strArg(args[0]) ?? undefined;
        else if (dm[2] === 'song_pos' && n0 !== null) st.pos = Math.max(0, Math.min(1, n0));
        else if (dm[2] === 'get_songlength' && n0 !== null && n0 > 0) st.len = n0;
        else if (dm[2] === 'play') st.playing = !!n0;
        else if (dm[2] === 'is_audible') st.audible = !!n0;
        st.at = now; this.vdj.set(d, st);
        if (st.path && st.pos !== undefined && st.len && (dm[2] === 'song_pos' || dm[2] === 'get_filepath')) this.ctx.position?.({ src: 'vdj', deck: d, at: now, ms: st.pos * st.len * 1000, playing: st.playing ?? true, exact: true, ident: { path: st.path, durMs: st.len * 1000 } });
      }
      if (/\/get_bpm$/.test(a) && n0 && n0 > 20 && n0 < 400) this.bpm = n0;
      else if (/\/get_beatpos$/.test(a) && n0 !== null && this.bpm > 0) { this.grid.observe(now, n0, this.bpm); this.lastBeatAt = now; }
    } else return;
    if (beatObs !== null && this.bpm > 0) {
      // a beat tick (integer = the sender's own count; NaN = "a beat just happened": we count)
      const was = now - this.lastBeatAt < (60000 / this.bpm) * 2 + 300;
      let p: number;
      if (Number.isFinite(beatObs) && Number.isInteger(beatObs)) p = beatObs;
      else if (Number.isFinite(beatObs)) p = beatObs;
      else p = this.grid.ready && was ? Math.max(this.beatCount + 1, Math.round(this.grid.posAt(now))) : this.beatCount + 1;
      this.grid.observe(now, p, this.bpm);
      this.beatCount = Math.floor(p);
      if (barIn !== null) this.barOfLast = barIn - 1;
      this.lastBeatAt = now;
    }
    if (evs.length) this.ctx.controller(evs, 'osc');
    this.emit(now);
  }

  /** The master deck's track position (s): rkbx_link's /master/time, /vtp/time. With a title the Track library follows
   *  the track (streaming ones too) from rekordbox's own grid and phrases. */
  private trackTime(sec: number, now: number) {
    if (!(sec >= 0 && sec < 86400) || !this.title) return;
    this.ctx.position?.({ src: 'osc', deck: 1, at: now, ms: sec * 1000, playing: this.playing(now), exact: true, ident: { title: this.title, ...(this.artist ? { artist: this.artist } : {}) } });
  }
  private playing(now: number) {
    if (this.playingFlag !== null) return this.playingFlag && now - this.lastBeatAt < 5000;
    return this.bpm > 0 && now - this.lastBeatAt < (60000 / this.bpm) * 2 + 400;
  }
  private emit(now: number) {
    const hasMeta = !!(this.title || this.artist || this.xfade !== undefined || this.faders.length || this.phrase || this.dropIn);
    if (!this.grid.ready && !hasMeta) return;
    const g = this.grid;
    // no beat grid of our own: the phrase / metadata are stated as of when they arrived (the arbiter runs them on the clock)
    const at = g.ready ? g.at : Math.max(this.phrase?.at ?? 0, this.dropIn?.at ?? 0) || now;
    /** Beats between `then` and the sample's time (our grid, else the tool's own /vtp/bpm, else none known). */
    const beatsSince = (then: number) => (g.ready ? (now - then) * g.bpm / 60000 : this.bpm > 0 ? (at - then) * this.bpm / 60000 : 0);
    const s: SourceSample = { src: 'osc', key: 'osc', name: LABEL[this.kind], at, bpm: g.ready ? g.bpm : 0, beat: g.ready ? g.beat : 0, playing: this.playing(now), q: 1 };
    if (g.ready) {
      if (this.sub4.last >= 0 && this.kind === 'rkbx') s.bar = ((Math.floor(g.beat) % 4) + 4) % 4;
      else if (this.barOfLast >= 0) s.bar = (((this.barOfLast + Math.floor(g.beat) - this.beatCount) % 4) + 4) % 4;
      else s.q = 0.9;
    }
    if (this.phrase) {
      const el = beatsSince(this.phrase.at);
      const known = this.phrase.left !== undefined;
      const left = known ? Math.max(0, this.phrase.left! - el) : 0;
      const ph: PhraseInfo = { kind: this.phrase.kind, sec: sectionOf(this.phrase.kind), pos: 0, len: known ? left : 0, known };
      if (this.phrase.next) { ph.next = this.phrase.next; ph.nextSec = sectionOf(this.phrase.next); }
      if (known && ph.nextSec === 'drop') ph.dropIn = left;
      if (this.dropIn) ph.dropIn = Math.max(0, this.dropIn.beats - beatsSince(this.dropIn.at));
      s.phrase = ph;
    }
    if (this.title || this.artist) s.track = { deck: 0, ...(this.title ? { title: this.title } : {}), ...(this.artist ? { artist: this.artist } : {}) };
    if (this.xfade !== undefined) s.xfade = this.xfade;
    this.ctx.sample(s);
  }
  /** Twice a second: keep the arbiter's copy fresh while the tool's info is recent (phrase / title / beats). */
  private stale() { const now = this.ctx.now(); if (now - this.rate.last() < 120000 && this.rate.last() > 0) this.emit(now); }

  status(): AdapterStatus {
    const now = this.ctx.now();
    const live = now - this.rate.last() < 5000;
    if (this.state === 'listening' || this.state === 'connected') this.state = live ? 'connected' : 'listening';
    const says = this.state === 'connected' ? `${LABEL[this.kind]} is sending${this.bpm ? ` · ${this.bpm.toFixed(1)} BPM` : ''}.` : this.state === 'listening' ? `Listening for OSC on port ${this.cfg.port} (rkbx_link, open-beat-control, TouchDesigner…).` : this.says;
    return { id: 'osc', label: 'OSC', state: this.state, says, found: [...this.seenKinds].map((k) => LABEL[k]), rate: this.rate.get(), extra: { port: this.cfg.port } };
  }
}

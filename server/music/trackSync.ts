// Track library → pre-built light shows, live (the helper side). Owns the library, the background analyser, the deck
// follower, the show player and the audio matcher, and plugs into the music clock:
//
//   adapters' playheads (CDJ-3000 position / older CDJs' beat numbers, Engine players' beats, VirtualDJ OSC, Traktor
//   deck data) + the studio's music-input onsets (audio matching) ─► TrackFollower ─► ShowPlayer (which deck is on air,
//   the incoming drop wins, one-shots never re-fire after a loop) ─► MusicArbiter.trackProvider:
//      phrase = KNOWN (pos / len / next / dropIn from the track's own phrases), the drop event on its exact beat, the bar
//      from the track's grid, clock.trk = { track, deck, beat, conf, source, show id }
//   compiled shows ─► bus {type:'trackshow', show} once per track (and every 10 s for late pages)
//
// When nothing is known for sure (no library, an unknown track, a stale or scratched position) it returns nothing and
// the show runs on the realtime analysis as before. Settings: <data>/musicLibrary/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { barPos, beatToMs, type TrackAnalysis } from '../../shared/trackAnalysis.ts';
import { compileShow, ShowPlayer, type DeckView, type ShowStyle, type TrackShow, SHOW_STYLES } from '../../shared/trackShow.ts';
import { deckGains, phraseAt, TrackFollower, POS_LABEL, type FollowDeck, type PosReport, type TrackIdent } from '../../shared/trackFollow.ts';
import { alignOne, LiveAligner, refFromAnalysis, type RefPrint } from '../../shared/audioAlign.ts';
import { b64ToBytes } from '../../shared/trackAnalysis.ts';
import { landmarksForIndex, LM_INDEX_MAX, LandmarkIndex, LandmarkMatcher, LM_HOP_MS, lmTrackMs, runSliced } from '../../shared/landmarks.ts';
import type { MusicArbiter, TrackOverlay, TrackQuery } from '../../shared/musicClock.ts';
import { TrackLibrary } from './library/store.ts';
import { TrackAnalyzer } from './library/analyzer.ts';
import { importAny } from './library/importers.ts';
import type { ImportKind, ImportedTrack } from './library/types.ts';
import { IMPORT_KINDS } from './library/types.ts';
import { anlzToTrack } from './library/rekordbox.ts';
import type { Anlz } from './library/anlz.ts';
import { WaveLocker, waveRef } from '../../shared/waveLock.ts';
import { LEARN, PlayLearner } from '../../shared/learnPlay.ts';
import { STREAM_LABEL } from './library/streaming.ts';
import { DeckEstimator, TransportReader, transportMapFor } from '../../shared/deckPlayhead.ts';
import { SeratoHistoryWatcher } from './library/seratoHistory.ts';
import { TraktorCast, type CastStatus } from './traktorCast.ts';

export interface TrackSettings {
  /** Read rekordbox's phrase analysis (the masked PSSI tag) from analysis files and CDJs. Default ON. */
  phrases: boolean;
  /** Learn tracks in the background (never while live). */
  autoAnalyse: boolean;
  /** Analyse every track, not only those without phrases. */
  analyseAll: boolean;
  /** Find the track + position by listening (rekordbox performance mode, Traktor, Serato, Mixxx, djay). */
  matchAudio: boolean;
  /** Show style the compiler targets. */
  style: ShowStyle;
  /** Traktor MP3 grid shift (ms) some setups need. */
  traktorMp3OffsetMs: number;
  /** The user's ffmpeg (blank = find it). */
  ffmpegPath: string;
  /** Track names from Traktor's Broadcasting (a local Icecast endpoint on 127.0.0.1; metadata only). Off by default. */
  traktorCast: boolean;
  traktorCastPort: number;
}
export const TRACK_DEFAULTS: TrackSettings = { phrases: true, autoAnalyse: true, analyseAll: false, matchAudio: true, style: 'auto', traktorMp3OffsetMs: 0, ffmpegPath: '', traktorCast: false, traktorCastPort: 18000 };
export function sanitizeTrackSettings(p: unknown, base: TrackSettings = TRACK_DEFAULTS): TrackSettings {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    phrases: b(x.phrases, base.phrases), autoAnalyse: b(x.autoAnalyse, base.autoAnalyse), analyseAll: b(x.analyseAll, base.analyseAll), matchAudio: b(x.matchAudio, base.matchAudio),
    style: (SHOW_STYLES as readonly unknown[]).includes(x.style) ? x.style as ShowStyle : base.style,
    traktorMp3OffsetMs: typeof x.traktorMp3OffsetMs === 'number' && Number.isFinite(x.traktorMp3OffsetMs) ? Math.max(-100, Math.min(100, Math.round(x.traktorMp3OffsetMs))) : base.traktorMp3OffsetMs,
    ffmpegPath: typeof x.ffmpegPath === 'string' ? x.ffmpegPath.slice(0, 500) : base.ffmpegPath,
    traktorCast: b(x.traktorCast, base.traktorCast),
    traktorCastPort: typeof x.traktorCastPort === 'number' && Number.isInteger(x.traktorCastPort) && x.traktorCastPort >= 1024 && x.traktorCastPort <= 65535 ? x.traktorCastPort : base.traktorCastPort,
  };
}

export interface NowPlaying {
  deck: number; id: string; title?: string; artist?: string;
  beat: number; conf: number; src: string; srcLabel: string;
  sec: string | null; dropIn: number | null; blend: boolean; showId: string | null;
  decks: { n: number; id: string; title?: string; conf: number; src: string; gain: number }[];
  listening?: { id: string; title?: string; state: 'identified' | 'locked'; since: number };
}
/** The track the DJ picked in the panel's "Now playing" (or a deck / tool named without a playhead), for the panel. */
export interface HintView {
  id: string; title: string; artist?: string; by: 'pick' | 'name';
  /** Who named it ("Serato", "Traktor", "your DJ app"; none = you picked it). */
  from?: string;
  /** Its place in the track is known (the show runs from its grid / phrases). */
  placed: boolean;
  /** "Beatport" … for a streaming track. */
  stream: string | null;
  /** Learned: found by listening next time. */
  learned: boolean;
  /** Seconds heard so far while learning it / seconds needed. */
  heard: number; need: number;
  /** It can be placed from rekordbox's waveform (else only learned once a deck says where it is). */
  wave: boolean;
}
export interface TrackSyncOptions { dataDir: string; dir?: string; broadcast(m: unknown): void; log?(s: string): void; liveCheck?: () => Promise<{ live: boolean; why: string | null }>; now(): number }

export class TrackSync {
  readonly lib: TrackLibrary;
  readonly analyzer: TrackAnalyzer;
  readonly follower: TrackFollower;
  readonly player = new ShowPlayer();
  readonly aligner = new LiveAligner(50, 12);
  /** Spectral landmarks of every analysed track (shared/landmarks.ts): finds WHICH track plays library-wide. */
  /** (swapped whole, never rebuilt in place: a listening check keeps reading the index it started with) */
  lmIndex = new LandmarkIndex();
  /** A freshly built index waiting for the running check to finish. */
  private lmNext: LandmarkIndex | null = null;
  /** Index swaps that had to wait for a running check (tests / diagnostics). */
  lmDeferred = 0;
  readonly matcher = new LandmarkMatcher();
  private lmBuilt = -1; private lmBuilding = false; private lmBuiltAt = 0;
  private pkSid = ''; private pkMap: number[] = [];
  /** What listening found: the track (maybe not its place yet) — for the panel's "Now playing". */
  listening: { id: string; title?: string; state: 'identified' | 'locked'; since: number } | null = null;
  settings: TrackSettings;
  private shows = new Map<string, TrackShow>();
  private sentShow = new Map<string, number>();
  private now: NowPlaying | null = null;
  private refs = new Map<string, RefPrint>();
  private alignTimer: ReturnType<typeof setInterval> | null = null;
  private featOffset = NaN; private featOffs: number[] = [];
  private lmChecks = 0;
  /** A listening check is running (sliced: one at a time). */
  private aligning = false;
  /** Listening checks wait until then (ms, helper clock): at most ~10 % of the helper's CPU, however big the library. */
  private alignNextAt = 0;
  /** What the listening checks cost on this thread (ms): the last check's CPU, its longest single block, the worst. */
  alignCost = { cpuMs: 0, blockMs: 0, worstCpuMs: 0, worstBlockMs: 0, checks: 0 };
  private lastClock: TrackQuery | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private watched = new Map<string, number>();
  private settingsFile: string;
  /** Last overlay (tests / the panel). */
  last: TrackOverlay | null = null;
  /** The track the DJ picked (or a deck / tool named without a playhead): listening finds its place. */
  hint: { id: string; by: 'pick' | 'name'; at: number; from?: string } | null = null;
  /** Serato's live history (watched only when the user imported their Serato library). */
  private serato: SeratoHistoryWatcher | null = null;
  private seratoTimer: ReturnType<typeof setInterval> | null = null;
  /** Traktor's Broadcasting metadata (the user's setting). */
  readonly cast = new TraktorCast((m) => this.named(m, 'Traktor'), () => this.o.now());
  private nameSeen = '';
  /** A long window of the music input's band onsets: places a known streaming track on rekordbox's waveform. */
  readonly waveAligner = new LiveAligner(50, 75);
  private waveLock: WaveLocker | null = null;
  /** What the waveform placement costs on this thread (ms): the last run's CPU, its longest block, the worst block. */
  waveCost = { cpuMs: 0, blockMs: 0, worstBlockMs: 0 };
  /** Learning a streaming track while it plays (its landmarks: next time it's found by listening). */
  readonly learner = new PlayLearner();
  private learnBusy = false;
  /** Tracks learned while they played (tests / diagnostics). */
  learnedLive = 0;
  /** A DJ controller we can read the transport of (rekordbox performance mode + a DDJ): each deck's playhead. */
  ctl: { port: string; reader: TransportReader; est: DeckEstimator; at: number; lastReport: number } | null = null;

  constructor(private o: TrackSyncOptions) {
    const dir = o.dir ?? path.join(o.dataDir, 'musicLibrary');
    this.lib = new TrackLibrary(dir);
    this.lib.load();
    this.settingsFile = path.join(dir, 'settings.json');
    let saved: unknown = null; try { saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { /* defaults */ }
    this.settings = sanitizeTrackSettings(saved);
    this.analyzer = new TrackAnalyzer(this.lib, { dataDir: o.dataDir, ffmpegPath: this.settings.ffmpegPath, all: this.settings.analyseAll, liveCheck: o.liveCheck, log: o.log });
    this.follower = new TrackFollower({ resolve: (i) => this.resolve(i) });
  }
  /** Start the background parts (the analyser, the audio matcher, watching imported files). */
  start(arbiter: MusicArbiter) {
    arbiter.trackProvider = (q) => this.overlay(q);
    if (this.settings.autoAnalyse) this.analyzer.start();
    this.alignTimer ??= setInterval(() => void this.alignStep(), 1000);
    this.alignTimer.unref?.();
    this.watch ??= setInterval(() => void this.watchSources(), 60000);
    this.watch.unref?.();
    this.seratoTimer ??= setInterval(() => this.seratoStep(), 2000);
    this.seratoTimer.unref?.();
    if (this.settings.traktorCast) void this.cast.start(this.settings.traktorCastPort);
  }
  stop(arbiter?: MusicArbiter) {
    if (arbiter) arbiter.trackProvider = null;
    this.analyzer.stop();
    if (this.alignTimer) clearInterval(this.alignTimer); this.alignTimer = null;
    if (this.watch) clearInterval(this.watch); this.watch = null;
    if (this.seratoTimer) clearInterval(this.seratoTimer); this.seratoTimer = null;
    this.cast.stop();
    this.lib.save();
  }
  updateSettings(p: unknown) {
    const was = this.settings;
    this.settings = sanitizeTrackSettings(p, this.settings);
    if (was.traktorCast !== this.settings.traktorCast || (this.settings.traktorCast && was.traktorCastPort !== this.settings.traktorCastPort)) {
      if (this.settings.traktorCast) void this.cast.start(this.settings.traktorCastPort); else this.cast.stop();
    }
    this.analyzer.all = this.settings.analyseAll;
    if (this.settings.autoAnalyse) this.analyzer.start(); else this.analyzer.stop();
    this.shows.clear();
    try { fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true }); fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2)); } catch { /* disk */ }
  }

  // ---------------------------------------------------------------------------------------------------- library
  /** The analysis the live follower uses for a deck's track (rekordbox / CDJ phrases left out when the user turned
   *  phrase reading off). */
  resolve(i: TrackIdent): TrackAnalysis | null { const a = this.lib.resolve(i); if (a && !this.settings.phrases) return this.withoutRekordboxPhrases(a); return a; }
  private withoutRekordboxPhrases(a: TrackAnalysis): TrackAnalysis { return a.phrases[0]?.src === 'rekordbox' || a.phrases[0]?.src === 'cdj' ? { ...a, phrases: [] } : a; }
  async import(kind: ImportKind, where: string) {
    const r = await importAny(kind, where, { phrases: this.settings.phrases, traktorMp3OffsetMs: this.settings.traktorMp3OffsetMs }, this.lib);
    const n = this.lib.addImport(kind, where, r);
    // a music folder the user picked for Serato (its files carry the analysis) is a folder they chose: allowed
    if (kind === 'serato') { try { if (fs.statSync(where).isDirectory() && !['database V2', path.join('_Serato_', 'database V2')].some((f) => fs.existsSync(path.join(where, f)))) this.lib.setRoots([where]); } catch { /* gone */ } }
    try { this.watched.set(`${kind}|${where}`, fs.statSync(where).mtimeMs); } catch { /* gone */ }
    this.shows.clear(); this.refs.clear();
    this.analyzer.kick();
    return { ...r, ...n, tracks: undefined, count: r.tracks.length, ask: this.lib.ask };
  }
  /** Re-import a library the user imported before when its file changed (e.g. rekordbox's XML exported again). */
  private async watchSources() {
    for (const s of this.lib.sources) {
      if (!(IMPORT_KINDS as readonly string[]).includes(s.kind) || s.kind === 'serato' || s.kind === 'rekordbox-anlz') continue;
      const key = `${s.kind}|${s.path}`;
      let m = 0; try { m = fs.statSync(s.path).mtimeMs; } catch { continue; }
      const seen = this.watched.get(key);
      if (seen === undefined) { this.watched.set(key, m); continue; }
      if (m > seen + 1000) { this.watched.set(key, m); try { await this.import(s.kind, s.path); this.o.log?.(`[music] re-read ${s.kind} (it changed)`); } catch { /* next time */ } }
    }
  }
  /** A CDJ told us a track's grid + phrases over the DJ network (track-info mode): it becomes a library entry. */
  cdjTrack(meta: { title?: string; artist?: string; durationSec?: number }, tags: Anlz[]) {
    if (!meta.title) return;
    const ident: TrackIdent = { title: meta.title, ...(meta.artist ? { artist: meta.artist } : {}), ...(meta.durationSec ? { durMs: meta.durationSec * 1000 } : {}) };
    const have = this.lib.find(ident);
    const t: ImportedTrack = anlzToTrack(tags, '');
    t.src = 'cdj'; t.part.srcs = ['cdj'];
    if (t.part.grid) t.part.grid = { ...t.part.grid, src: 'cdj' };
    if (t.part.phrases) t.part.phrases = this.settings.phrases ? t.part.phrases.map((p) => ({ ...p, src: 'cdj' })) : undefined;
    if (t.part.bands) t.part.bands = { ...t.part.bands, src: 'cdj' };
    t.base = have?.base ?? `cdj ${meta.title}${meta.artist ? ` - ${meta.artist}` : ''}`.toLowerCase();
    t.title = meta.title; if (meta.artist) t.artist = meta.artist; if (meta.durationSec) t.durMs = meta.durationSec * 1000;
    this.lib.addImport('rekordbox-anlz', 'Pioneer players (DJ network)', { tracks: [t], says: 'From the players on your DJ network.', warnings: [] }, false);
    this.shows.clear();
  }

  // ---------------------------------------------------------------------------------------------------- live
  /** A deck's playhead from an adapter. */
  position(r: PosReport) { this.follower.report(r, this.o.now()); }
  /** A DJ controller's MIDI (listen-only): a known controller's transport moves each deck's estimated playhead. An
   *  unknown controller is simply ignored here (its knobs still drive the show through the music clock). */
  deckMidi(port: string, msgs: [number, number, number, number][]) {
    if (!this.ctl || this.ctl.port !== port) {
      const map = transportMapFor(port);
      if (!map) return;
      const reader = new TransportReader(map);
      this.ctl = { port, reader, est: new DeckEstimator(map.decks, reader.jogTicks), at: 0, lastReport: 0 };
    }
    const c = this.ctl;
    for (const [t, st, d1, d2] of msgs) {
      if (!Number.isFinite(t) || st < 0x80 || st >= 0xf0) continue;
      for (const op of c.reader.feed(st, d1 & 0x7f, d2 & 0x7f, t)) { c.est.op(op); c.at = t; }
    }
  }
  /** The controller is in use (a transport move in the last 30 minutes). */
  private ctlActive(now: number) { return !!this.ctl && this.ctl.at > 0 && now - this.ctl.at < 30 * 60000; }
  /** The deck a track that was heard / picked / named goes to: the deck already holding it, else the deck the DJ touched
   *  last when it plays, else a playing deck, else that last-touched deck. */
  private ctlDeckFor(id: string): number {
    const e = this.ctl!.est;
    for (let n = 1; n <= 4; n++) if (e.trackOf(n) === id) return n;
    if (e.isPlaying(e.focus)) return e.focus;
    return e.playingDecks()[0] ?? e.focus;
  }
  /** A listening match / a placement: re-anchor the controller's deck (true) — or false: no controller in use. */
  private ctlAnchor(id: string, ms: number, at: number, rate: number, now: number, conf?: number): boolean {
    if (!this.ctlActive(now)) return false;
    const n = this.ctlDeckFor(id), a = this.lib.analysis(id);
    if (!a) return false;
    this.ctl!.est.setTrack(n, a, now);
    this.ctl!.est.anchor(n, ms, at, now, rate, conf);
    return true;
  }
  /** Each controller deck's estimate → the follower (10 a second). */
  private ctlReport(q: TrackQuery) {
    const c = this.ctl;
    if (!c || !this.ctlActive(q.now) || q.now - c.lastReport < 100) return;
    c.lastReport = q.now;
    if (q.src !== 'audio' && q.bpm > 0) c.est.clock(q.now, q.beat, q.bpm);
    c.est.snap(q.now);
    for (const r of c.est.reports(q.now)) this.follower.report({ src: 'ctl', deck: r.deck, at: q.now, ms: r.ms, rate: r.rate, playing: r.playing, exact: false, heard: true, ident: { trackId: r.trackId }, conf: r.conf }, q.now);
  }
  private showFor(a: TrackAnalysis): TrackShow | null {
    const key = `${a.id}:${this.settings.style}`;
    let s = this.shows.get(key);
    if (!s) { const c = compileShow(a, { style: this.settings.style }); if (!c) return null; s = c; this.shows.set(key, s); if (this.shows.size > 32) this.shows.delete(this.shows.keys().next().value!); }
    if (!this.player.has(a.id) || this.player.show(a.id)?.id !== s.id) this.player.load(s);
    return s;
  }
  /** The music clock's tick asks: what does the analysed track add right now? */
  overlay(q: TrackQuery): TrackOverlay | null {
    this.lastClock = q;
    // a deck / tool that names the track (rkbx_link's /master/track/title, /vtp/title, ...): find it in the library
    if (q.track?.title) {
      const k = `${q.track.title}|${q.track.artist ?? ''}`;
      if (k !== this.nameSeen) { this.nameSeen = k; const e = this.lib.find({ title: q.track.title, ...(q.track.artist ? { artist: q.track.artist } : {}) }); if (e) this.setHint(e.id, 'name', q.now, 'Your DJ app'); }
    }
    this.follower.clock(q.now, q.beat, q.bpm, q.latMs);
    this.ctlReport(q);
    // (a controller says which decks play and their channel faders: who is on air)
    if (!q.decks && this.ctl && this.ctlActive(q.now)) {
      const est = this.ctl.est;
      const fader = (n: number) => q.ctl?.fader?.[n - 1] ?? est.faders.get(n);
      q = { ...q, decks: [1, 2, 3, 4].filter((n) => est.trackOf(n)).map((n) => { const f = fader(n); return { n, playing: est.isPlaying(n), onAir: false, master: false, ...(f !== undefined ? { fader: f } : {}) }; }) };
      if (!q.decks!.length) q = { ...q, decks: undefined };
      if (q.xfade === undefined && est.xfade !== undefined) q = { ...q, xfade: est.xfade };
    }
    if ((q.ctl?.scratch ?? 0) > 0.5) this.follower.scratch(0, q.now);
    const fd = this.follower.state(q.now);
    if (!fd.length) { this.now = null; this.last = null; return null; }
    const gains = deckGains(q.decks, q.xfade, q.onAir, fd);
    const views: DeckView[] = fd.map((d) => ({ n: d.n, track: d.track, beat: d.beat, bpm: d.bpm || q.bpm, conf: d.conf, gain: gains.get(d.n) ?? (fd.length === 1 ? 1 : 0), playing: d.playing }));
    for (const d of fd) { const a = this.follower.analysis(d.n); if (a) this.showFor(a); }
    const fires = this.player.step(q.now, views);
    const owner = views.find((v) => v.n === this.player.owner);
    const od = fd.find((d) => d.n === this.player.owner);
    const a = owner ? this.follower.analysis(owner.n) : null;
    this.now = owner && od ? this.nowPlaying(owner, od, fd, gains) : null;
    if (!owner || !a?.grid || !Number.isFinite(owner.beat) || owner.conf < this.player.o.minConf || !owner.playing) { this.last = null; return null; }
    const show = this.showFor(a);
    const phrase = phraseAt(a, owner.beat);
    const dropNow = fires.some((f) => f.deck === owner.n && f.cue.layer === 'hit' && (f.cue.prio ?? 0) >= 10);
    const kInt = Math.round(owner.beat - q.beat);
    const ov: TrackOverlay = {
      phrase,
      trk: { id: a.id, deck: owner.n, beat: +owner.beat.toFixed(4), conf: owner.conf, src: od?.src ?? 'test', ...(show ? { show: show.id } : {}), ...(this.player.blend ? { blend: true } : {}) },
      track: { deck: owner.n, ...(a.title ? { title: a.title } : {}), ...(a.artist ? { artist: a.artist } : {}), ...(od && Number.isFinite(od.posMs) ? { posMs: Math.round(od.posMs) } : {}), ...(a.durMs ? { lenMs: a.durMs } : {}) },
      bar: barPos(a.grid, Math.floor(q.beat) + kInt),
      dropNow,
    };
    // the show itself: once per track, again every 10 s (pages that joined late)
    if (show) {
      const t = this.sentShow.get(show.id) ?? -Infinity;
      if (q.now - t > 10000) { this.sentShow.set(show.id, q.now); this.o.broadcast({ type: 'trackshow', show }); if (this.sentShow.size > 32) this.sentShow.delete(this.sentShow.keys().next().value!); }
    }
    this.last = ov;
    return ov;
  }
  private nowPlaying(owner: DeckView, od: FollowDeck, fd: FollowDeck[], gains: Map<number, number>): NowPlaying {
    const a = this.follower.analysis(owner.n);
    const ph = a ? phraseAt(a, owner.beat) : null;
    return {
      deck: owner.n, id: owner.track, ...(od.title ? { title: od.title } : {}), ...(od.artist ? { artist: od.artist } : {}), beat: +owner.beat.toFixed(2), conf: owner.conf, src: od.src, srcLabel: POS_LABEL[od.src],
      sec: ph?.sec ?? null, dropIn: ph?.dropIn ?? null, blend: this.player.blend, showId: a ? this.shows.get(`${a.id}:${this.settings.style}`)?.id ?? null : null,
      decks: fd.map((d) => ({ n: d.n, id: d.track, ...(d.title ? { title: d.title } : {}), conf: d.conf, src: d.src, gain: gains.get(d.n) ?? 0 })),
      ...(this.listening ? { listening: this.listening } : {}),
    };
  }
  nowPlayingView(): NowPlaying | null { return this.now; }
  /** Audio matching state for the panel (also when no track plays yet). */
  matchingView() { return { hint: this.hintView(), learning: this.learningView(), names: this.sourcesView(), controller: this.ctl && this.ctlActive(this.o.now()) ? this.ctl.port : null, tracks: this.lmIndex.size, indexMB: +(this.lmIndex.bytes / 1e6).toFixed(1), seconds: +this.matcher.seconds.toFixed(1), listening: this.listening, checkMs: +this.alignCost.cpuMs.toFixed(1), blockMs: +this.alignCost.blockMs.toFixed(1) }; }
  /** The compiled show of a track (the panel's preview). */
  showOf(id: string): TrackShow | null { const a = this.lib.analysis(id); return a ? this.showFor(a) : null; }

  // ---------------------------------------------------------------------------------------------------- audio matching
  /** Onset frames (50 Hz, 0..255) from the studio's music input; `at` = the page time of the LAST frame's start, `sent`
   *  = when the page sent them (to map page time → helper time on this PC). */
  features(frames: number[], at: number, sent: number, bands: { low?: number[]; mid?: number[]; high?: number[] } = {}) {
    if (!this.settings.matchAudio || !frames.length) return;
    const now = this.o.now();
    this.featOffs.push(now - sent); if (this.featOffs.length > 60) this.featOffs.shift();
    const min = Math.min(...this.featOffs);
    this.featOffset = Number.isFinite(this.featOffset) ? Math.min(min, this.featOffset + 0.05) : min;
    const q = (a?: number[]) => (a && a.length === frames.length ? a.map((v) => v / 255) : undefined);
    this.aligner.push(frames.map((v) => v / 255), at + this.featOffset, { low: q(bands.low), mid: q(bands.mid), high: q(bands.high) });
    this.waveAligner.push(frames.map((v) => v / 255), at + this.featOffset, { low: q(bands.low) });
  }
  /** Landmark peaks from the studio's music input: stream frame numbers (exact) + where the newest frame was on the page
   *  clock (pf / pat). A new stream id = a new input: start over. */
  peaks(sid: string, pk: { f: number; m: number; v: number }[], pf: number, pat: number, sent: number) {
    if (!this.settings.matchAudio) return;
    if (sid !== this.pkSid) { this.pkSid = sid; this.matcher.reset(); this.pkMap = []; }
    // helper time of stream frame 0 = (page time of frame pf) + (page → helper offset) − pf · hop; the smallest recent
    // value is the least delayed
    const off = Number.isFinite(this.featOffset) ? this.featOffset : this.o.now() - sent;
    this.pkMap.push(pat + off - pf * LM_HOP_MS); if (this.pkMap.length > 30) this.pkMap.shift();
    const ok = pk.filter((p) => p.f <= pf + 50);
    this.matcher.push(ok);
    this.learnFeed(ok);
  }
  private frameTime(f: number) { return this.pkMap.length ? Math.min(...this.pkMap) + f * LM_HOP_MS : NaN; }
  /** (Re)build the landmark index when the library changed (at most once a minute; a few hundred ms for 500 tracks). */
  private async buildLandmarks(force = false) {
    const ver = this.lib.entries.size * 100000 + [...this.lib.entries.values()].filter((e) => e.lm).length;
    if (this.lmBuilding || (!force && (ver === this.lmBuilt || (this.lmIndex.size > 0 && this.o.now() - this.lmBuiltAt < 60000)))) return;
    this.lmBuilding = true;
    try {
      const es = [...this.lib.entries.values()].filter((e) => e.lm).sort((a, b) => b.used - a.used).slice(0, 4095);
      const tracks: { id: string; bpm: number; lm: { h: Uint32Array; t: Uint32Array } }[] = [];
      let total = 0;
      for (let i = 0; i < es.length; i++) {
        const a = this.lib.analysis(es[i].id);
        if (!a?.lm) continue;
        // memory budget: LM_INDEX_MAX landmarks (4 bytes each in RAM), counted on what is DECODED (a stored count that
        // isn't what the data holds is skipped); the most recently played tracks first
        const room = LM_INDEX_MAX - total;
        if (room <= 0) break;
        const lm = landmarksForIndex(a.lm, b64ToBytes(a.lm.b64), room);
        if (!lm) continue;
        total += lm.h.length;
        tracks.push({ id: a.id, bpm: a.bpm, lm });
        if (i % 25 === 24) await new Promise((r) => setImmediate(r));   // (never a long block of VTube Pro's event loop)
      }
      // a NEW index, built in slices, swapped in whole once no check is reading the current one
      const next = new LandmarkIndex();
      await runSliced(next.buildSteps(tracks));
      this.lmNext = next;
      if (this.aligning) this.lmDeferred++;
      this.swapIndex();
      this.lmBuilt = ver; this.lmBuiltAt = this.o.now();
    } finally { this.lmBuilding = false; }
  }
  private swapIndex() { if (this.lmNext && !this.aligning) { this.lmIndex = this.lmNext; this.lmNext = null; } }
  private cost(cpuMs: number, blockMs: number) {
    const c = this.alignCost;
    c.cpuMs = cpuMs; c.blockMs = blockMs; c.worstCpuMs = Math.max(c.worstCpuMs, cpuMs); c.worstBlockMs = Math.max(c.worstBlockMs, blockMs); c.checks++;
    // (a check that cost C ms waits ~10·C before the next: the listening never takes more than ~10 % of this thread)
    this.alignNextAt = this.o.now() + Math.max(0, cpuMs * 10 - 1000);
  }
  /** Once a second: when no deck reports a playhead, find the track + position by listening. The landmark lookup runs
   *  in slices of ~4 ms (the music clock ticks in between) and backs off when it costs more than ~10 % of the thread. */
  async alignStep() {
    if (!this.settings.matchAudio || this.aligning) return;
    if (this.o.now() < this.alignNextAt) return;
    this.swapIndex();
    this.aligning = true;
    try { await this.alignOnce(); } finally { this.aligning = false; this.swapIndex(); }
  }
  // ---------------------------------------------------------------------------------------------------- streaming tracks
  /** The DJ says (panel "Now playing") which track plays: null = stop following it. */
  pick(id: string | null): { ok: boolean; says: string } {
    if (!id) { this.hint = null; this.waveLock = null; return { ok: true, says: 'OK: VTube Pro finds the track by itself again.' }; }
    const e = this.lib.find({ trackId: id });
    if (!e) return { ok: false, says: 'That track isn’t in the library any more.' };
    this.setHint(e.id, 'pick', this.o.now());
    const a = this.lib.analysis(e.id);
    const name = e.title ?? (e.stream ? `${STREAM_LABEL[e.stream.svc]} track` : e.base);
    return {
      ok: true,
      says: e.lm ? `Listening for “${name}”: the show follows it as soon as it hears where you are.`
        : a?.wave ? `Following “${name}”: VTube Pro finds your place in it from rekordbox’s waveform (about a minute the first time) and learns it while it plays.`
          : a?.grid ? `Following “${name}”. Its place in the track comes from your decks; VTube Pro learns it while it plays.`
            : `“${name}” has no beat grid yet: analyse it in your DJ app.`,
    };
  }
  private setHint(id: string, by: 'pick' | 'name', at: number, from?: string, deck?: number) {
    if (this.ctlActive(at)) { const a = this.lib.analysis(id); if (a) this.ctl!.est.setTrack(deck ?? this.ctlDeckFor(id), a, at); }
    if (this.hint?.id === id) { this.hint.at = at; if (by === 'pick') { this.hint.by = by; delete this.hint.from; } else if (from) this.hint.from = from; return; }
    this.hint = { id, by, at, ...(by === 'name' && from ? { from } : {}) }; this.waveLock = null;
  }
  /** A source named the track on air (Traktor's broadcast, Serato's history, a deck / tool): find it in the library. */
  named(m: { title?: string; artist?: string; path?: string }, from: string, deck?: number): string | null {
    if (!m.title && !m.path) return null;
    const e = this.lib.find({ ...(m.path ? { path: m.path } : {}), ...(m.title ? { title: m.title } : {}), ...(m.artist ? { artist: m.artist } : {}) });
    if (!e) return null;
    this.setHint(e.id, 'name', this.o.now(), from, deck);
    return e.id;
  }
  /** Serato's live history: which track each deck holds (newest first: that one is the hint). */
  private seratoStep() {
    const src = this.lib.sources.find((s) => s.kind === 'serato');
    if (!src) { this.serato = null; return; }
    const dir = /(^|[\\/])_Serato_$/i.test(src.path) ? src.path : fs.existsSync(path.join(src.path, '_Serato_')) ? path.join(src.path, '_Serato_') : /database V2$/i.test(src.path) ? path.dirname(src.path) : '';
    if (!dir) return;
    if (this.serato?.seratoDir !== dir) this.serato = new SeratoHistoryWatcher(dir);
    if (!this.serato.poll()) return;
    for (const d of [...this.serato.decks].reverse()) this.named({ ...(d.row.path ? { path: d.row.path } : {}), ...(d.row.title ? { title: d.row.title } : {}), ...(d.row.artist ? { artist: d.row.artist } : {}) }, 'Serato', d.deck);
  }
  /** Name sources for the panel. */
  sourcesView(): { serato: { deck: number; title: string }[] | null; traktor: CastStatus } {
    return { serato: this.serato ? this.serato.decks.map((d) => ({ deck: d.deck, title: `${d.row.title ?? ''}${d.row.artist ? ` — ${d.row.artist}` : ''}` || 'a track' })) : null, traktor: this.cast.st };
  }
  /** Place the hinted track on its rekordbox waveform (WaveLocker: a long window, three agreeing checks). */
  private async placeHint(now: number, q: TrackQuery | null, bpm: number): Promise<boolean> {
    const h = this.hint;
    if (!h) return false;
    const e = this.lib.entries.get(h.id);
    const fd = this.follower.state(now);
    const following = fd.some((d) => d.track === h.id && d.conf >= 0.6 && d.playing);
    // stale: another track plays for sure, or it was picked long ago and nothing found it
    if (!e || fd.some((d) => d.track && d.track !== h.id && d.conf >= 0.6 && d.playing && d.src !== 'aligner' && d.src !== 'ctl')
      || (!following && now - h.at > Math.max(8 * 60000, (e.durMs || 0) * 1.5))) { this.hint = null; this.waveLock = null; return false; }
    if (e.lm) return false;   // (learned: the landmark matcher finds it)
    const a = this.lib.analysis(h.id), ref = a ? waveRef(a) : null;
    if (!ref) return false;
    if (this.waveLock?.id !== h.id && a?.grid) { const g = a.grid; this.waveLock = new WaveLocker(ref, a.phrases.slice(1).map((p) => beatToMs(g, p.beat))); }
    if (!this.waveLock) return false;
    // the deck's speed: the clock's tempo / the track's (half / double time allowed); unknown tempo = as recorded
    const rate = bpm > 0 && ref.bpm > 0 ? [0.5, 1, 2].map((m) => bpm * m / ref.bpm).find((x) => Math.abs(x - 1) <= 0.085) : 1;
    if (rate === undefined) return false;
    // (sliced: ~4 ms blocks of 0.5 ms steps; the music clock ticks in between)
    const run = await runSliced(this.waveLock.checkSteps(now, (sec) => this.waveAligner.window(sec), [rate]));
    if (run.cpuMs > 1) this.cost(run.cpuMs, run.maxBlockMs);
    this.waveCost = { cpuMs: run.cpuMs, blockMs: run.maxBlockMs, worstBlockMs: Math.max(this.waveCost.worstBlockMs, run.maxBlockMs) };
    const r = run.value;
    if (!r || this.hint?.id !== h.id) return false;
    now = this.o.now();
    if (this.ctlAnchor(h.id, r.posMs, r.endAt, r.rate, now, r.conf)) return true;
    this.follower.report({ src: 'aligner', deck: q?.onAir ?? 1, at: r.endAt, ms: r.posMs, rate: r.rate, playing: true, exact: false, heard: true, ident: { trackId: h.id }, conf: r.conf }, now);
    return true;
  }
  /** Learn-while-playing: the music input's peaks go onto the track's timeline while a streaming track plays cleanly. */
  private learnFeed(pk: { f: number; m: number; v: number }[]) {
    const L = this.learner;
    if (!this.settings.autoAnalyse || !this.settings.matchAudio || !pk.length) return;
    const now = this.o.now();
    const all = this.follower.state(now);
    const sure = all.filter((d) => d.playing && d.conf >= 0.6 && Number.isFinite(d.posMs));
    const d = sure.length === 1 ? sure[0] : null;
    const e = d ? this.lib.entries.get(d.track) : undefined;
    const q = this.lastClock;
    // one deck audible (when the mixer / controller says), not blending two tracks
    const g = deckGains(q?.decks, q?.xfade, q?.onAir, all);
    const audible = [...g.values()].filter((v) => v > 0.1).length;
    if (!d || !e?.stream || e.lm || this.player.blend || audible > 1) { if (L.id && now - L.lastAt > 20000) void this.learnFinish(); return; }
    if (L.id !== e.id) { if (L.id) void this.learnFinish(); if (this.learnBusy) return; L.start(e.id, d.lenMs || e.durMs, now); }
    const a = this.follower.analysis(d.n), trackBpm = a?.bpm || a?.grid?.anchors[0].bpm || 0;
    const rate = trackBpm > 0 && d.bpm > 0 ? d.bpm / trackBpm : 1;
    if (Math.abs(rate - 1) > LEARN.maxRateDev) return;
    const f0 = pk[0].f, T0 = this.frameTime(f0);
    if (!Number.isFinite(T0)) return;
    L.add(pk, f0, d.posMs + (T0 - now) * rate, rate, now);
    if (L.done) void this.learnFinish();
  }
  /** Store what was learned (landmarks built in slices; never audio). */
  async learnFinish() {
    const L = this.learner, id = L.id;
    if (this.learnBusy || !id) return;
    if (!L.enough) { L.stop(); return; }
    this.learnBusy = true;
    try {
      const run = await runSliced(L.buildSteps());
      L.stop();
      if (run.value && this.lib.putLearned(id, run.value)) {
        this.learnedLive++;
        this.o.log?.(`[music] learned a streaming track while it played (${run.value.n} landmarks)`);
        void this.buildLandmarks(true);
      }
    } finally { this.learnBusy = false; }
  }
  /** The picked / named track for the panel. */
  hintView(): HintView | null {
    const h = this.hint;
    if (!h) return null;
    const e = this.lib.entries.get(h.id);
    if (!e) return null;
    const a = this.lib.analysis(h.id);
    return {
      id: h.id, title: e.title ?? (e.stream ? `${STREAM_LABEL[e.stream.svc]} track` : e.base), ...(e.artist ? { artist: e.artist } : {}), by: h.by, ...(h.from ? { from: h.from } : {}),
      placed: this.follower.state(this.o.now()).some((d) => d.track === h.id && d.conf >= 0.6 && d.playing),
      stream: e.stream ? STREAM_LABEL[e.stream.svc] : null, learned: !!e.lm,
      heard: this.learner.id === h.id ? this.learner.seconds : 0, need: LEARN.minS, wave: !!a?.wave,
    };
  }
  /** The track being learned while it plays (the panel). */
  learningView() {
    const L = this.learner;
    if (!L.id) return null;
    const e = this.lib.entries.get(L.id);
    return { id: L.id, title: e?.title ?? (e?.stream ? `${STREAM_LABEL[e.stream.svc]} track` : ''), heard: L.seconds, need: Math.round(Math.min(LEARN.minS, L.span * 0.9)) };
  }

  private async alignOnce() {
    void this.buildLandmarks();
    let now = this.o.now();
    const fd = this.follower.state(now);
    // (a deck that reports its own playhead: listening isn't needed; the controller's estimate is corrected BY listening)
    const exact = fd.some((d) => d.src !== 'aligner' && d.src !== 'ctl' && d.conf >= 0.6 && d.playing);
    if (exact) { this.aligner.reset(); this.matcher.reset(); this.listening = null; return; }
    const q = this.lastClock;
    const bpm = q && now - q.now < 2000 ? q.bpm : 0;
    // 0. a track we KNOW plays (picked / named) but not where, never heard before: rekordbox's waveform places it
    // (no await without a hint: a check starts in the same tick as before)
    if (this.hint && await this.placeHint(now, q, bpm)) return;
    if (this.hint) now = this.o.now();
    // 1. spectral landmarks over the whole library (seconds); the envelope only sharpens the place
    // (no check while a new index is being built: it starts on the new one)
    if (this.lmBuilding) return;
    if (this.lmIndex.size && this.matcher.seconds >= 6) {
      const djTempo = q && q.src !== 'audio' && bpm > 0;
      // (the DJ software's tempo narrows the candidates; every third check also listens without it, in case it's off)
      this.lmChecks = (this.lmChecks + 1) % 3;
      const run = await runSliced(this.matcher.checkSteps(this.lmIndex, djTempo && this.lmChecks ? { clockBpm: bpm } : {}));
      this.cost(run.cpuMs, run.maxBlockMs);
      const hit = run.value;
      // (things may have changed while it ran: listening turned off, a deck now reports its playhead)
      now = this.o.now();
      if (!this.settings.matchAudio || this.follower.state(now).some((d) => d.src !== 'aligner' && d.src !== 'ctl' && d.conf >= 0.6 && d.playing)) return;
      const ident = this.matcher.identity;
      if (ident) { const a = this.lib.analysis(ident.id); this.listening = { id: ident.id, ...(a?.title ? { title: a.title } : {}), state: hit ? 'locked' : 'identified', since: ident.since }; }
      if (!hit) return;
      const F = hit.to;
      let at = this.frameTime(F), ms = lmTrackMs(hit, F);
      // sharpen with the onset envelope (ms accuracy) when it agrees within 60 ms
      const a = this.lib.analysis(hit.id), ref = a ? refFromAnalysis(a) : null, w = this.aligner.window(12);
      if (ref && w && Number.isFinite(at)) {
        const expect = ms + (w.endAt - at) * hit.r;
        const fine = alignOne(w.live, ref, { rates: [hit.r], hintMs: expect, rangeMs: 120 });
        if (fine && Math.abs(fine.posMs - expect) < 60 && fine.beatRatio >= 1.15) { at = w.endAt; ms = fine.posMs; }
      }
      if (!Number.isFinite(at)) return;
      if (this.ctlAnchor(hit.id, ms, at, hit.r, now)) return;
      this.follower.report({ src: 'aligner', deck: q?.onAir ?? 1, at, ms, rate: hit.r, playing: true, exact: false, heard: true, ident: { trackId: hit.id }, conf: Math.min(1, 0.6 + hit.votes / 400) }, now);
      return;
    }
    if (this.lmIndex.size || this.aligner.filled < 12) return;
    // 2. (no landmarks yet: tracks analysed before them) the envelope matcher on its own
    // candidates: analysed tracks whose tempo the clock could be playing (± 8 %), the deck's last known track first
    const entries = [...this.lib.entries.values()].filter((e) => e.st.analysed && (!bpm || !e.bpm || [0.5, 1, 2].some((m) => Math.abs(bpm * m / e.bpm - 1) <= 0.085)));
    const refs: RefPrint[] = [];
    for (const e of entries.slice(0, 120)) {
      let r = this.refs.get(e.id);
      if (!r) { const a = this.lib.analysis(e.id); const x = a ? refFromAnalysis(a) : null; if (!x) continue; r = x; this.refs.set(e.id, r); if (this.refs.size > 200) this.refs.delete(this.refs.keys().next().value!); }
      refs.push(r);
    }
    if (!refs.length) return;
    // (the clock's tempo ÷ the track's: the deck's exact rate; without a clock, ± 8 % is searched)
    const t0 = performance.now();
    const res = this.aligner.check(refs, { rateFor: (r) => (bpm > 0 && r.bpm > 0 ? [[0.5, 1, 2].map((m) => bpm * m / r.bpm).find((x) => Math.abs(x - 1) <= 0.085) ?? 1] : undefined) });
    const dt = performance.now() - t0; this.cost(dt, dt);
    if (!res) return;
    const deck = q?.onAir ?? 1;
    if (this.ctlAnchor(res.hit.id, res.hit.posMs, res.endAt, res.hit.rate, now)) return;
    this.follower.report({ src: 'aligner', deck, at: res.endAt, ms: res.hit.posMs, rate: res.hit.rate, playing: true, exact: false, heard: true, ident: { trackId: res.hit.id }, conf: res.conf }, now);
  }
}

// Show sounds in the STUDIO (owner, beta.12: "Studio only, everything"): every sound of the show plays here, never on an
// OBS / output page (src/audio/silentPage.ts keeps those structurally silent). Rows of the audio mixer, each
// voice → its gain → an analyser (the card's meter) → this PC's speakers:
//   tts    read-aloud: the Chat Hub's spoken support messages ({type:'chathub', m:{k:'tts'}} on the bus), both "on stream"
//          and "only for me" lines (the Chat Hub window no longer plays them: never twice); volume = the Chat Hub's
//   video  the room screen video's sound: an <audio> following the host's video clock (scene state video.now), or for a
//          live stream the OBS page's own distance from the live edge ({type:'liveclock'}); volume = the room's
//   room   room effects the OBS pages send ({type:'showsound'}: the club's horns, slap punches, the poll sting), once each
//   games  the Trail's player-view sounds (its iframe in the studio plays through here: window.__vtpGames)
//   gm     the tabletop narrator's lines "on stream" (src/ttrpg/studio/voice.ts playOnStream), at their wall-clock start
//   me     "Only me": the narrator's private lines, on an output device the host picks (their headphones) — a separate
//          audio context, so a capture of the studio's main output doesn't hear it (unless it is "Same as studio")
// Exactly one studio window plays (src/audio/mixer/audioLeader.ts): events that arrive while the election settles are
// queued and played once elected; losing the lead stops what is playing at once. Observer tabs play nothing.
// Your stream hears these the way it hears your guests: from this window (desktop / application audio capture).
import type { ChatHubBus } from '../../../shared/chathub.ts';
import { isLiveSrc, videoShowing, videoUrl, type SceneVideoState } from '../../../shared/screenVideo.ts';
import { slapRand } from '../../../shared/slap.ts';
import { openLive, type LiveHandle } from '../../scene/liveSource.ts';
import { clampSeek, liveSteer, sanitizeShowSound, showSoundId, type ShowSound, type SlapKind } from '../../../shared/showSound.ts';
import type { LeaderState } from './audioLeader.ts';
import { emoteSoundSource } from './emoteSynth.ts';

export type ShowRow = 'tts' | 'video' | 'room' | 'games' | 'gm' | 'me';
let current: ShowSounds | null = null;
/** The studio's show-sound player (null outside the studio: OBS pages, observer tabs before it exists). */
export const studioShow = (): ShowSounds | null => current;
export function setStudioShow(s: ShowSounds | null) {
  current = s;
  // the Trail's player view (an iframe in the studio) plays its sounds through the Games row
  try { (window as unknown as { __vtpGames?: () => { ctx: AudioContext; out: AudioNode } | null }).__vtpGames = () => s?.games() ?? null; } catch { /* no window */ }
}
export const SHOW_ROWS: ShowRow[] = ['tts', 'video', 'room', 'games', 'gm'];
interface Row { gain: GainNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; at: number }
export interface ShowRowStats { peak: number; rms: number; active: boolean }

const VOL_KEY = 'vtp.audioMix.show';
const TTS_URL = /^\/api\/chathub\/tts\/audio\/[a-f0-9]{8,40}$/;
const SEEN_MAX = 500;
const SLAP: Record<SlapKind, string[]> = {
  slap: ['impactPunch_heavy_000', 'impactPunch_heavy_001', 'impactPunch_heavy_002', 'impactPunch_heavy_003', 'impactPunch_heavy_004'],
  thud: ['impactSoft_heavy_000', 'impactSoft_heavy_001', 'impactSoft_heavy_002'],
  poof: ['impactSoft_medium_000', 'impactSoft_medium_001'],
};
const db = (x: number) => (x > 1e-5 ? 20 * Math.log10(x) : -100);
const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };
type VolRow = 'room' | 'games' | 'gm' | 'me';

export interface ShowSoundsHost {
  readonly observer: boolean;
  /** The host's scene: its mode and screen video state (null = no scene yet). */
  scene(): { mode: string; video?: SceneVideoState } | null;
  /** Exactly one studio plays the show's sounds (src/audio/mixer/audioLeader.ts); missing = this one always. */
  leader?: { state(): LeaderState; listeners: Set<(s: LeaderState) => void> } | null;
}

export class ShowSounds {
  private ctx: AudioContext | null = null;
  private rows = new Map<ShowRow, Row>();
  /** Mixer-only volumes (read-aloud and video keep their own settings: the Chat Hub's / the room's) + the Only-me output. */
  vols: Record<VolRow, number>;
  meSink: string;
  private seen = new Map<string, number>();
  private tts: { src: AudioBufferSourceNode; id: string } | null = null;
  private ttsSeq = 0;
  private bufs = new Map<string, Promise<AudioBuffer | null>>();
  private video: { el: HTMLAudioElement; node: MediaElementAudioSourceNode | null; url: string; live: LiveHandle | null } | null = null;
  private videoT = 0;
  /** What is sounding now (stopped at once when this window stops leading). */
  private active = new Set<{ stop(): void }>();
  /** Events that arrived while the election settled (played once this window leads, dropped if another does). */
  private queue: { mono: number; key: string; run: () => void; ttl: number }[] = [];
  /** The OBS page's live player: how far behind its live edge it plays, per source. */
  private liveLag = new Map<string, { lag: number; at: number }>();
  private me: { ctx: AudioContext; row: Row; sink: string; fellBack: boolean } | null = null;
  /** Rows that have been used in this studio (the card shows Games / the narrator once they are). */
  private used = new Set<ShowRow>();
  private wake = () => { for (const c of [this.ctx, this.me?.ctx]) if (c?.state === 'suspended') void c.resume().catch(() => {}); };
  /** Tests / diagnostics: what was played. */
  readonly log: { row: ShowRow; what: string; at: number }[] = [];

  constructor(private host: ShowSoundsHost) {
    const o = (() => { try { return JSON.parse(ls.get(VOL_KEY) || '{}') as Record<string, unknown>; } catch { return {}; } })();
    const n = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : 1);
    this.vols = { room: n(o.room), games: n(o.games), gm: n(o.gm), me: n(o.me) };
    this.meSink = typeof o.meSink === 'string' ? o.meSink.slice(0, 200) : '';
    if (!host.observer && typeof window !== 'undefined') this.videoT = window.setInterval(() => this.syncVideo(), 250);
    host.leader?.listeners.add((s) => this.onLeader(s));
  }

  // ---------------------------------------------------------------- leading
  /** This window plays the show's sounds (the elected studio, never an observer). */
  private lead(): boolean { return !this.host.observer && (this.host.leader ? this.host.leader.state() === 'leader' : true); }
  private pending(): boolean { return !this.host.observer && !!this.host.leader && this.host.leader.state() === 'pending'; }
  private onLeader(s: LeaderState) {
    this.gamesGain();
    if (s !== 'leader') { this.stopAll(); if (s === 'follower') this.queue.length = 0; return; }
    const now = performance.now(), q = this.queue.splice(0);
    for (const e of q) if (now - e.mono <= e.ttl) try { e.run(); } catch { /* one bad event */ }
  }
  private hold(key: string, ttl: number, run: () => void) {
    if (this.queue.some((e) => e.key === key)) return;
    this.queue.push({ mono: performance.now(), key, run, ttl });
    if (this.queue.length > 50) this.queue.shift();
  }
  /** Stop everything that is sounding (lost the lead). */
  stopAll() {
    this.ttsSeq++; this.stopTts();
    for (const a of [...this.active]) try { a.stop(); } catch { /* */ }
    this.active.clear();
    this.dropVideo();
  }
  private track(a: { stop(): void }, ms: number) { this.active.add(a); setTimeout(() => this.active.delete(a), ms); }

  // ---------------------------------------------------------------- graph
  private context(): AudioContext | null {
    if (this.host.observer) return null;
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      this.ctx = ctx;
      for (const r of SHOW_ROWS) this.rows.set(r, this.makeRow(ctx, this.rowVol(r)));
      this.gamesGain();
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, this.wake, { capture: true, passive: true });
      this.wake();
      return ctx;
    } catch { this.ctx = null; return null; }
  }
  private makeRow(ctx: AudioContext, vol: number): Row {
    const gain = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 1024;
    gain.gain.value = vol;
    gain.connect(an).connect(ctx.destination);
    return { gain, an, buf: new Float32Array(an.fftSize), at: 0 };
  }
  /** Can this browser send audio to a chosen device (the Only-me output)? */
  get sinkOk(): boolean { return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype; }
  /** The Only-me output: its own audio context on the device the host picked ('' = the same output as the studio). */
  private meOut(): { ctx: AudioContext; row: Row } | null {
    if (this.host.observer) return null;
    if (this.me && this.me.ctx.state !== 'closed' && this.me.sink === this.meSink) return this.me;
    if (this.me) { void this.me.ctx.close().catch(() => {}); this.me = null; }
    try {
      const o: AudioContextOptions = { latencyHint: 'playback' };
      if (this.meSink && this.sinkOk) (o as AudioContextOptions & { sinkId?: string }).sinkId = this.meSink;
      let ctx: AudioContext;
      // the chosen output is gone (unplugged headphones) or this browser can't pick one: the studio's own output, and the
      // card says so (it never claims "only on your headphones" then)
      let fellBack = !!this.meSink && !this.sinkOk;
      try { ctx = new AudioContext(o); } catch { ctx = new AudioContext({ latencyHint: 'playback' }); fellBack = !!this.meSink; }
      const sid = (ctx as AudioContext & { sinkId?: unknown }).sinkId;
      if (this.meSink && this.sinkOk && typeof sid === 'string' && sid !== this.meSink) fellBack = true;
      const me = this.me = { ctx, row: this.makeRow(ctx, this.vols.me), sink: this.meSink, fellBack };
      ctx.addEventListener?.('error', () => { me.fellBack = !!me.sink; });   // (the device failed later)
      this.wake();
      return this.me;
    } catch { return null; }
  }
  /** The chosen Only-me output couldn't be used: those lines play on the studio's output (null = not known yet). */
  get meFellBack(): boolean | null { return this.me && this.me.sink === this.meSink ? this.me.fellBack : null; }
  /** Pick the Only-me output device ('' = same as the studio). */
  setMeSink(id: string) {
    this.meSink = id.slice(0, 200);
    this.save();
    if (this.me) { void this.me.ctx.close().catch(() => {}); this.me = null; }
  }
  private save() { ls.set(VOL_KEY, JSON.stringify({ ...this.vols, meSink: this.meSink })); }
  private rowVol(r: ShowRow): number { return r === 'room' || r === 'games' || r === 'gm' || r === 'me' ? this.vols[r] : 1; }
  private rowOf(r: ShowRow): Row | undefined { return r === 'me' ? this.me?.row : this.rows.get(r); }
  private note(row: ShowRow, what: string) { this.used.add(row); this.log.push({ row, what, at: Date.now() }); if (this.log.length > 50) this.log.shift(); const x = this.rowOf(row); if (x) x.at = performance.now(); }
  /** Has this row been used here (the card shows the Games / narrator rows from then on)? */
  usedRow(r: ShowRow): boolean { return this.used.has(r); }
  /** The mixer card's volume for the rows that have no other setting. */
  setVol(r: VolRow, v: number) {
    this.vols[r] = Math.min(1, Math.max(0, v));
    this.save();
    if (r === 'games') { this.gamesGain(); return; }
    const x = this.rowOf(r), c = r === 'me' ? this.me?.ctx : this.ctx;
    if (x && c) x.gain.gain.setTargetAtTime(this.vols[r], c.currentTime, 0.02);
  }
  /** The Games row is open only while this window leads: the Trail keeps its nodes, so losing the lead must silence them. */
  private gamesGain() {
    const x = this.rows.get('games'), c = this.ctx;
    if (!x || !c) return;
    const v = this.lead() ? this.vols.games : 0;
    x.gain.gain.cancelScheduledValues(c.currentTime);
    x.gain.gain.setValueAtTime(v, c.currentTime);
  }
  /** The card's meter for one row (null = nothing has played yet). */
  stats(r: ShowRow): ShowRowStats | null {
    const x = this.rowOf(r);
    if (!x) return null;
    x.an.getFloatTimeDomainData(x.buf);
    let pk = 0, s = 0;
    for (let i = 0; i < x.buf.length; i++) { const v = x.buf[i]; s += v * v; if (v > pk) pk = v; else if (-v > pk) pk = -v; }
    return { peak: db(pk), rms: db(Math.sqrt(s / x.buf.length)), active: performance.now() - x.at < 15_000 };
  }
  get state(): AudioContextState | 'none' { return this.ctx?.state ?? 'none'; }
  /** The Trail's player view plays through the Games row — only in the leading window (else silent). */
  games(): { ctx: AudioContext; out: AudioNode } | null {
    if (this.host.observer) return null;
    const first = !this.used.has('games');
    this.used.add('games');                                         // a Trail game is open: the card shows its row
    if (!this.lead()) return null;
    const ctx = this.context(), row = this.rows.get('games');
    if (!ctx || !row) return null;
    if (first) this.note('games', 'trail'); else row.at = performance.now();
    return { ctx, out: row.gain };
  }

  private async buffer(url: string, ctx: AudioContext | null = this.context()): Promise<AudioBuffer | null> {
    if (!ctx) return null;
    const k = ctx === this.ctx ? url : `me:${url}`;
    let p = this.bufs.get(k);
    if (!p) {
      p = fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((b) => ctx.decodeAudioData(b)).catch(() => null);
      if (!url.includes('/tts/') && !url.includes('/ttrpg/')) this.bufs.set(k, p);   // (impact sounds are reused; lines aren't)
    }
    return p;
  }
  private playBuffer(row: ShowRow, buf: AudioBuffer, o: { gain?: number; rate?: number; when?: number; offset?: number } = {}): AudioBufferSourceNode | null {
    const x = this.rowOf(row), ctx = row === 'me' ? this.me?.ctx : this.ctx;
    if (!ctx || !x) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (o.rate) src.playbackRate.value = o.rate;
    const g = ctx.createGain(); g.gain.value = o.gain ?? 1;
    src.connect(g).connect(x.gain);
    src.start(o.when ?? 0, o.offset ?? 0);
    x.at = performance.now();
    const h = { stop: () => { try { src.stop(); } catch { /* not started */ } } };
    this.active.add(h);
    src.onended = () => this.active.delete(h);
    return src;
  }

  // ---------------------------------------------------------------- read-aloud
  /** A Chat Hub bus message: 'tts' lines play here (whatever "where" says), 'hush' stops the current one. */
  onChatHub(m: ChatHubBus) {
    if (this.host.observer) return;
    if (m.k === 'hush') { this.ttsSeq++; this.stopTts(); this.queue = this.queue.filter((e) => !e.key.startsWith('tts:')); return; }
    if (m.k !== 'tts' || !TTS_URL.test(m.url)) return;
    if (this.pending()) { this.hold(`tts:${m.id}`, 15_000, () => this.onChatHub(m)); return; }
    if (!this.lead()) return;
    const seq = ++this.ttsSeq;
    void this.buffer(m.url).then((buf) => {
      if (!buf || seq !== this.ttsSeq || !this.lead()) return;
      this.stopTts();
      const src = this.playBuffer('tts', buf, { gain: Math.max(0, Math.min(1, m.vol)) });
      if (src) { this.tts = { src, id: m.id }; src.addEventListener('ended', () => { if (this.tts?.src === src) this.tts = null; }); this.note('tts', m.id); }
    });
  }
  private stopTts() { if (this.tts) { try { this.tts.src.stop(); } catch { /* not started */ } this.tts = null; } }

  // ---------------------------------------------------------------- room sounds from the OBS pages
  /** {type:'showsound'} from an OBS page: played once per event id (every OBS page sends it). */
  onShowSound(rawId: unknown, raw: unknown) {
    if (this.host.observer) return;
    const id = showSoundId(rawId), s = sanitizeShowSound(raw);
    if (!id || !s) return;
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 120_000) this.seen.delete(k);
    if (this.seen.has(id)) return;
    if (this.pending()) { this.hold(`room:${id}`, 2000, () => this.onShowSound(id, s)); return; }
    if (!this.lead()) return;          // (another studio window plays it)
    // (marked as heard only once it really started here — no audio context = not marked, the next copy may still
    // play; the list stays small)
    if (!this.play(s)) return;
    this.seen.set(id, now);
    while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
    this.note(s.k === 'emote' && s.only ? 'me' : 'room', `${s.k}:${id}`);
  }
  /** Start a room sound; false = it could not start here (no audio context). */
  private play(s: ShowSound): boolean {
    if (s.k === 'emote') return this.playEmote(s);
    const ctx = this.context(), out = this.rows.get('room')?.gain;
    if (!ctx || !out || ctx.state === 'closed') return false;
    if (s.k === 'horn') this.track(hornSynth(ctx, out, s.v), 2500);
    else if (s.k === 'sting') this.track(stingSynth(ctx, out), 1200);
    else {
      const list = SLAP[s.kind];
      const name = list[Math.floor(slapRand(s.seed, 90) * list.length) % list.length];   // (the same pick the OBS page used to make)
      // (served by the Trail's CC0 sound route: assets/library/sounds)
      void this.buffer(`/api/trail/sfx/kenney_impact/${name}.ogg`).then((b) => { if (b && this.lead()) this.playBuffer('room', b, { gain: 0.7 * s.gain, rate: s.rate }); });
    }
    return true;
  }

  /** An emote sound (shared/emoteSounds.ts): the Room sounds row; the panel's Test button = the Only-me output. */
  private playEmote(s: Extract<ShowSound, { k: 'emote' }>): boolean {
    // (a Test is for the streamer's ears only: with no separate Only-me device — or it fell back to the studio's — it
    // would reach a window / desktop capture, so it doesn't play at all; the panel says why)
    if (s.only && (!this.meSink || !this.sinkOk)) return false;
    const me = s.only ? this.meOut() : null;
    if (s.only && (!me || this.me?.fellBack)) return false;
    const ctx = s.only ? me?.ctx ?? null : this.context();
    const out = s.only ? me?.row.gain : this.rows.get('room')?.gain;
    if (!ctx || !out || ctx.state === 'closed') return false;
    const src = emoteSoundSource(s.snd);
    if (src.synth) this.track(src.synth(ctx, out, s.gain), 3000);
    else if (src.url) void this.buffer(src.url, ctx).then((b) => { if (b && this.lead()) this.playBuffer(s.only ? 'me' : 'room', b, { gain: s.gain }); });
    else return false;
    return true;
  }

  // ---------------------------------------------------------------- the tabletop narrator
  /** Play a rendered narrator line starting at wall-clock `at` (ms): "On stream" (the studio's output) or `only` = the
   *  Only-me output. */
  playLine(url: string, at: number, only = false): { stop(): void } {
    let h: { stop(): void } | null = null, stopped = false;
    const go = () => {
      if (stopped || !this.lead()) return;
      const out = only ? this.meOut() : null;
      const ctx = only ? out?.ctx ?? null : this.context();
      void this.buffer(url, ctx).then((b) => {
        if (!b || !ctx || stopped || !this.lead()) return;
        const wait = (at - Date.now()) / 1000;
        if (wait < -(b.duration - 0.05)) return;                      // (its time is over)
        const src = this.playBuffer(only ? 'me' : 'gm', b, { when: ctx.currentTime + Math.max(0, wait), offset: wait < -0.35 ? Math.min(b.duration - 0.05, -wait) : 0 });
        if (src) h = { stop: () => { try { src.stop(); } catch { /* */ } } };
        this.note(only ? 'me' : 'gm', url);
      });
    };
    if (this.pending()) this.hold(`line:${url}`, 30_000, go); else go();
    return { stop: () => { stopped = true; h?.stop(); } };
  }

  // ---------------------------------------------------------------- the room screen video's sound
  /** Why the room screen's current source has no sound here (null = it plays here, or nothing is on). */
  videoNote(): string | null {
    const st = this.host.scene()?.video, src = st?.now?.src;
    if (!src || !isLiveSrc(src) || src.startsWith('live:')) return null;
    return src.startsWith('cam:')
      ? 'A camera on the screen is picture only. To hear it, add its microphone with “Add a sound input” below.'
      : 'The window feed is picture only, and VTube Pro can’t hear another app’s sound.';
  }
  /** {type:'liveclock'} from an OBS page: how far behind the live edge its player is (the studio follows it). */
  onLiveClock(src: unknown, lag: unknown) {
    if (typeof src !== 'string' || typeof lag !== 'number' || !Number.isFinite(lag) || lag < 0 || lag > 120) return;
    this.liveLag.set(src, { lag, at: performance.now() });
  }
  private dropVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    try { v.live?.stop(); } catch { /* */ }
    v.el.pause(); v.el.removeAttribute('src'); try { v.el.load(); } catch { /* */ }
    try { v.node?.disconnect(); } catch { /* */ }
  }
  private syncVideo() {
    const sc = this.host.scene(), st = sc?.video;
    const now = st?.now;
    // live:<url> streams play here too; cameras / the window feed are picture only (videoNote says how to get sound)
    const live = !!now && isLiveSrc(now.src);
    const want = this.lead() && !!sc && sc.mode === 'talk' && videoShowing(st) && !!st?.audio && !!now && (!live || now.src.startsWith('live:'));
    if (!want || !st || !now) { if (this.video) { if (this.video.live || !this.lead()) this.dropVideo(); else if (!this.video.el.paused) this.video.el.pause(); } return; }
    const key = live ? now.src : videoUrl(now.src);
    const ctx = this.context();
    if (!ctx) return;
    let v = this.video;
    if (!v || v.url !== key) {
      this.dropVideo();
      const el = new Audio();
      el.preload = 'auto';
      // (like the OBS page's player: CORS-clean, so the mixer can meter it; a stream without CORS goes through the local proxy)
      el.crossOrigin = 'anonymous';
      let node: MediaElementAudioSourceNode | null = null;
      try { node = ctx.createMediaElementSource(el); node.connect(this.rows.get('video')!.gain); } catch { node = null; }
      v = this.video = { el, node, url: key, live: null };
      if (live) v.live = openLive(el as unknown as HTMLVideoElement, now.src);
      else el.src = key;
    }
    const el = v.el;
    const vol = Math.min(1, Math.max(0, st.volume));
    if (v.node) { const g = this.rows.get('video')!.gain; if (Math.abs(g.gain.value - vol) > 0.005) g.gain.setTargetAtTime(vol, ctx.currentTime, 0.05); el.volume = 1; }
    else el.volume = vol;
    if (v.live) {
      // a live stream: follow the OBS page's distance from the live edge (within ~150 ms: seek when far off, else a
      // gentle rate nudge). The stream is downloaded twice (the OBS page's picture + this sound).
      // No fresh clock (the OBS page closed / stopped reporting for 3 s): normal speed, no seeking — it just plays on.
      // Seeks stay inside what the player can seek to.
      const lc = this.liveLag.get(now.src);
      let rate = 1;
      if (lc && performance.now() - lc.at < 3000 && el.readyState >= 2) {
        const r = el.seekable.length ? el.seekable : el.buffered;
        const ranges: [number, number][] = [];
        for (let i = 0; i < r.length; i++) ranges.push([r.start(i), r.end(i)]);
        const s = liveSteer({ cur: el.currentTime, edge: ranges.length ? ranges[ranges.length - 1][1] : NaN, lag: lc.lag });
        const to = s.seek === null ? null : clampSeek(s.seek, ranges);
        if (to !== null && !el.seeking && Math.abs(to - el.currentTime) > 0.25) el.currentTime = to;
        rate = s.rate;
      }
      if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate;
      if (el.paused && (el.src || el.srcObject)) void el.play().catch(() => {});
      if (!el.paused) this.rows.get('video')!.at = performance.now();
      return;
    }
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : now.dur ?? 0;
    const single = (st.slots[now.slot]?.list.length ?? 1) <= 1 && (st.slots[now.slot]?.loop ?? true);
    el.loop = single;
    let pos = (Date.now() - now.at) / 1000;
    if (pos < 0) { if (!el.paused) el.pause(); return; }
    if (dur > 0) pos = single ? pos % dur : Math.min(pos, Math.max(0, dur - 0.05));
    if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - pos) > 0.3) el.currentTime = pos;
    if (el.paused && !(dur > 0 && !single && pos >= dur - 0.06)) void el.play().catch(() => {});
    if (!el.paused) this.rows.get('video')!.at = performance.now();
  }

  close() {
    clearInterval(this.videoT);
    this.stopAll();
    if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, this.wake, { capture: true });
    void this.ctx?.close().catch(() => {});
    void this.me?.ctx.close().catch(() => {});
    this.ctx = null; this.me = null; this.rows.clear();
  }
}

// ---------------------------------------------------------------- the synthesised sounds (moved from the OBS page)
/** The club's air horn (bits / tips: three blasts) and raid siren (one falling blast). */
function hornSynth(ac: AudioContext, dest: AudioNode, k: 'bits' | 'raid'): { stop(): void } {
  const t0 = ac.currentTime + 0.02;
  const out = ac.createGain(); out.gain.value = 0.18; out.connect(dest);
  const blasts = k === 'raid' ? [0] : [0, 0.28, 0.56];
  for (const off of blasts) {
    for (const f of [440, 443, 554, 660]) {       // a detuned sawtooth chord
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = k === 'raid' ? f / 4 : f;
      const g = ac.createGain(); const dur = k === 'raid' ? 1.6 : 0.24;
      g.gain.setValueAtTime(0, t0 + off); g.gain.linearRampToValueAtTime(0.25, t0 + off + 0.02); g.gain.setValueAtTime(0.25, t0 + off + dur - 0.05); g.gain.linearRampToValueAtTime(0, t0 + off + dur);
      if (k === 'raid') o.frequency.exponentialRampToValueAtTime(f / 16, t0 + off + dur);
      o.connect(g); g.connect(out); o.start(t0 + off); o.stop(t0 + off + dur + 0.05);
    }
  }
  return { stop: () => { try { out.disconnect(); } catch { /* */ } } };
}
/** The poll winner sting: a short rising arpeggio. */
function stingSynth(ac: AudioContext, dest: AudioNode, vol = 0.25): { stop(): void } {
  const t0 = ac.currentTime + 0.02;
  const out = ac.createGain(); out.connect(dest);
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const o = ac.createOscillator(), gn = ac.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    const t = t0 + i * 0.09;
    gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(vol, t + 0.02); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(gn).connect(out); o.start(t); o.stop(t + 0.55);
  });
  return { stop: () => { try { out.disconnect(); } catch { /* */ } } };
}

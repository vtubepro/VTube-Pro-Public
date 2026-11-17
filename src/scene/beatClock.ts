// OBS-side beat clock: turns the studio's beat packets (shared/lightShow.ts) into a smooth, phase-locked musical
// clock for the light show. Packets arrive ~30 Hz with jitter (same PC ≈ 1 ms, party guests 30–150 ms):
//  - clock offset: the FASTEST packets define sender→local time (min-delay estimator, slowly relaxing upward),
//  - the grid runs locally (beat position = bi + ph advanced at the BPM) and is nudged toward each packet, so beats
//    land on time even though packets are late; a re-anchor (> ¼ beat off) snaps,
//  - packets stop → free-run on the last BPM for FREE_RUN_MS, then `active` falls (the show eases to steady),
//  - kick / snare / drop events are placed at their true time (packet t − age) on the local clock.
import { EV_DOWN, EV_DROP, EV_HAT, EV_KICK, EV_SNARE, SECTIONS, sanitizeBeatPacket, type BeatPacket } from '../../shared/lightShow.ts';
import { feelFromWire, grooveFromWire, type Feel, type GrooveHit } from '../../shared/groove.ts';

const FREE_RUN_MS = 6000;
export const epochNow = () => performance.timeOrigin + performance.now();

export class BeatClock {
  /** Local epoch ms of the newest events (-inf = never). */
  kickAt = -Infinity;
  snareAt = -Infinity;
  hatAt = -Infinity;
  dropAt = -Infinity;
  downAt = -Infinity;
  /** Counters (the show gates flashes per event). */
  kickSeq = 0; snareSeq = 0; hatSeq = 0; dropSeq = 0;
  bpm = 0;
  locked = false;
  /** Smoothed envelopes 0..1. */
  env = { e: 0, lo: 0, mi: 0, hi: 0, k: 0, s: 0, h: 0, d: 0 };
  section: (typeof SECTIONS)[number] = 'listening';
  /** Last packet said audio is flowing. */
  audible = false;
  /** Lights overhaul fields (newer studios; older ones leave the defaults): the analyser's audio mode
   *  ('talk' = voice without music → calm), kick presence 0..1, the 8-bar phrase counter / beat in phrase, drops. */
  mode: 'silence' | 'music' | 'talk' | 'mixed' | 'unknown' = 'unknown';
  kickPresence = NaN;
  phraseId = NaN;
  phraseBeat = NaN;
  /** The groove on this clock's grid (shared/groove.ts): the kick / snare slots of the bar, the feel, how sure; from the
   *  packet that owns the grid (the studio's analysis, or the helper's music clock under a DJ clock). */
  groove: { feel: Feel; conf: number; hits: GrooveHit[]; half: boolean; swing: number; at: number; key: string } | null = null;
  /** The groove now (null = none for 3 s, or never: an older studio). */
  grooveNow(now = epochNow()) { return this.groove && now - this.groove.at < 3000 && now - this.lastPacketAt < FREE_RUN_MS ? this.groove : null; }
  /** The owner's LATCHED show feel (packet `sf`, shared/groove.ts FeelLatch), kept like the groove: only the owning
   *  stream's, dropped when another stream owns the grid. undefined = the owner sends none (an older sender: the page
   *  latches its own), null = none latched yet. */
  private wireFeel: { feel: Feel | null; key: string } | null = null;
  showFeelNow(): Feel | null | undefined { return this.wireFeel && this.lastPacketAt - this.wireFeelAt < FREE_RUN_MS ? this.wireFeel.feel : undefined; }
  private wireFeelAt = -Infinity;
  /** where the tempo / phase come from now ('audio', or a DJ protocol's clock when one is live) */
  source = 'audio';
  private srcAt = -Infinity;
  private srcQ = 0;
  private secCand = ''; private secCandAt = 0;
  lastPacketAt = -Infinity;
  packets = 0;

  private sid = '';
  private streams = new Map<string, { offset: number; offsets: number[] }>();
  /** Grid: beat position = pos0 + (t − t0) / period (t local epoch ms); barSlot = beat index of a downbeat mod 4. */
  private t0 = 0;
  private pos0 = 0;
  private barSlot = 0;
  private target = { e: 0, lo: 0, mi: 0, hi: 0, k: 0, s: 0, h: 0, d: 0 };
  private envAt = 0;

  push(raw: unknown, now = epochNow()) {
    const p = sanitizeBeatPacket(raw);
    if (!p) return;
    // clock offset per stream (sender epoch → local epoch); the audio analysis and a DJ clock are separate streams
    const d = now - p.t;
    let c = this.streams.get(p.sid);
    if (!c) { c = { offset: d, offsets: [] }; this.streams.set(p.sid, c); if (this.streams.size > 4) this.streams.delete(this.streams.keys().next().value as string); }
    c.offsets.push(d);
    if (c.offsets.length > 90) c.offsets.shift();
    c.offset = Math.min(Math.min(...c.offsets), c.offset + 0.05);   // follow the fastest packets, relax 1.5 ms/s if they get slower
    const lt = p.t + c.offset;                       // local time this sample describes
    this.packets++;
    this.lastPacketAt = now;
    // A DJ-protocol clock (djsync's MusicClock packets: src != 'audio') owns tempo / phase / phrase while it is live
    // (< 1.5 s old) and at least as good as the current owner; audio packets still bring envelopes, kicks, mode.
    const src = p.src ?? 'audio';
    const ext = src !== 'audio';
    // An external clock counts only while LOCKED (a bridge that sends on:true, lk:false, bpm NaN must never take the
    // grid, nor keep it alive). It takes over from audio when the current owner is audio or has gone quiet
    // (> 1.5 s), and from another external clock only with a strictly higher quality.
    const extLocked = ext && p.lk && p.bpm >= 40;
    if (extLocked) {
      if (this.source === src) { this.srcAt = now; this.srcQ = p.srcQ ?? 0.5; }
      else if (this.source === 'audio' || now - this.srcAt > 1500 || (p.srcQ ?? 0.5) > this.srcQ) { this.source = src; this.srcAt = now; this.srcQ = p.srcQ ?? 0.5; }
    }
    if (this.source !== 'audio' && now - this.srcAt > 1500) { this.source = 'audio'; this.srcQ = 0; }
    const owns = ext ? extLocked && this.source === src : this.source === 'audio';
    if (!ext) {
      this.audioAt = now;
      this.audible = p.on;
    } else if (!this.audible && p.on) this.audible = true;
    // the audio mode (talk = calm) and kick presence come from whichever packet carries them: a DJ clock copies them
    // from the audio analysis, and while it owns the clock a page may only see its packets
    if (p.md != null && (!ext || extLocked || this.lastPacketAt - this.audioAt > 1000)) this.mode = (['silence', 'music', 'talk', 'mixed'] as const)[p.md] ?? 'unknown';
    if (p.kp != null && (!ext || extLocked || this.lastPacketAt - this.audioAt > 1000)) this.kickPresence = p.kp;
    if (owns && p.pid != null) { this.phraseId = p.pid; this.phraseBeat = p.pb ?? NaN; }
    // the groove belongs to the grid it was learned on: only the owner's (the studio's under its own grid, the music
    // clock's under a DJ clock), keyed by the stream that sent it. That same stream's packets without one keep it (it is
    // sent when it changes + once a second); any other owner's packet drops it - a page that has been open for hours
    // and one opened a minute ago play the same show (a groove never outlives its grid)
    const gk = `${p.sid}|${src}`;
    if (owns && p.gf != null) { const g = grooveFromWire(p.gf, p.gc, p.gh ?? [], p.gw); if (g) this.groove = { ...g, at: now, key: gk }; }
    else if (owns && this.groove) { if (this.groove.key === gk) this.groove.at = Math.max(this.groove.at, now - 2000); else this.groove = null; }
    if (owns) { const sf = feelFromWire(p.sf); if (sf !== undefined) { this.wireFeel = { feel: sf, key: gk }; this.wireFeelAt = now; } else if (this.wireFeel && this.wireFeel.key !== gk) this.wireFeel = null; else if (this.wireFeel) this.wireFeelAt = now; }
    if (!owns) { if (!ext) this.applyEvents(p, lt); return; }
    // a new owning stream starts a fresh grid only once it is locked itself (an unlocked one never zeroes a grid)
    if (p.sid !== this.sid && p.lk && p.bpm >= 40) { this.sid = p.sid; this.t0 = 0; this.bpm = 0; if (this.groove && this.groove.key !== gk) this.groove = null; }
    this.locked = p.lk && p.bpm >= 40;
    if (this.locked) {
      const period = 60000 / p.bpm;
      const target = p.bi + p.ph;
      if (!this.bpm || !this.t0) { this.bpm = p.bpm; this.t0 = lt; this.pos0 = target; }
      else {
        const predicted = this.posAt(lt);
        const err = target - predicted;
        this.pos0 = predicted; this.t0 = lt; this.bpm = p.bpm;
        if (Math.abs(err) > 0.25) this.pos0 = target;          // re-anchored / new tempo: snap
        else this.pos0 += err * 0.25;                          // gentle PLL (jitter ≈ ±0.02 beat)
      }
      void period;
      this.barSlot = (((p.bi - p.bar) % 4) + 4) % 4;
    } else {
      // unlocked (silence, a bridge that lost lock, another stream): never wipe a grid we have — keep free-running it.
      // Ownership of an external clock lapses on its own (no locked packet for 1.5 s → audio takes over again).
    }
    this.applyEvents(p, lt);
  }

  private audioAt = -Infinity;
  private applyEvents(p: BeatPacket, lt: number) {
    // a DJ clock brings the bar / drop / section; kicks, snares, hats and the envelopes come from the audio analysis
    // (while it is running — a DJ clock alone still drives everything)
    const ext = !!p.src && p.src !== 'audio', audio = this.lastPacketAt - this.audioAt < 1000;
    if (ext && audio) {
      if (p.ev & EV_DROP) { this.dropAt = lt; this.dropSeq++; }
      if (p.ev & EV_DOWN) this.downAt = lt;
      this.section = SECTIONS[p.sec] ?? this.section;
      return;
    }
    if (p.ev & EV_KICK) { this.kickAt = lt - (p.ka ?? 0); this.kickSeq++; }
    if (p.ev & EV_SNARE) { this.snareAt = lt - (p.sa ?? 0); this.snareSeq++; }
    if (p.ev & EV_HAT) { this.hatAt = lt; this.hatSeq++; }
    if (p.ev & EV_DROP) { this.dropAt = lt; this.dropSeq++; }
    if (p.ev & EV_DOWN) this.downAt = lt;
    this.target = { e: p.e, lo: p.lo, mi: p.mi, hi: p.hi, k: p.k, s: p.s, h: p.h, d: p.d };
    // section: newer studios send a stable one (phrase id present); an older studio's raw label must hold 1.5 s
    const sec = SECTIONS[p.sec] ?? 'listening';
    if (p.pid != null || sec === 'drop' || sec === this.section) { this.section = sec; this.secCand = ''; }
    else if (sec !== this.secCand) { this.secCand = sec; this.secCandAt = lt; }
    else if (lt - this.secCandAt > 1500) this.section = sec;
  }
  /** The sender's time (epoch ms) for a local time: the same instant on every page that hears the same studio
   *  (signals, flame flicker, the no-grid fallback beat run on it, so all OBS pages and guests agree). */
  showTime(local: number): number {
    const c = this.streams.get(this.sid) ?? (this.streams.size ? this.streams.values().next().value : undefined);
    return c ? local - c.offset : local;
  }
  /** The input is someone talking (no music): newer studios say so (older ones send on:false). */
  talking(now = epochNow()): boolean { return this.mode === 'talk' && now - this.lastPacketAt < FREE_RUN_MS; }

  /** Continuous beat position at local time t (NaN = no grid). */
  posAt(t: number): number {
    if (!this.bpm || !this.t0) return NaN;
    const p = this.pos0 + (t - this.t0) * this.bpm / 60000;
    return Number.isFinite(p) ? p : NaN;
  }
  /** Beat within the bar, continuous 0..4 (0 = downbeat). */
  barPosAt(t: number): number {
    const p = this.posAt(t);
    return Number.isFinite(p) ? (((p - this.barSlot) % 4) + 4) % 4 : NaN;
  }
  /** Bar number (for colour cycles). */
  barAt(t: number): number {
    const p = this.posAt(t);
    return Number.isFinite(p) ? Math.floor((p - this.barSlot) / 4) : 0;
  }

  /** Music is (probably) playing: packets recent (free-running up to FREE_RUN_MS) and the last one heard audio. */
  active(now = epochNow()): boolean {
    return this.audible && now - this.lastPacketAt < FREE_RUN_MS;
  }

  /** Ease the envelopes toward the newest packet (call once per rendered frame); they decay when packets stop. */
  update(now = epochNow()) {
    const dt = Math.min(0.1, Math.max(0, (now - (this.envAt || now)) / 1000));
    this.envAt = now;
    const stale = now - this.lastPacketAt > 300;
    const k = 1 - Math.exp(-dt / 0.05);
    for (const key of Object.keys(this.env) as (keyof BeatClock['env'])[]) {
      const tg = stale ? 0 : this.target[key];
      this.env[key] += (tg - this.env[key]) * (stale ? 1 - Math.exp(-dt / 0.6) : k);
    }
  }

  // ---------------------------------------------------------------- test pages: a synthetic stream
  private demoTimer = 0;
  /** ?beatDemo=<bpm> / vtpOut.beat.demo(128): kick every beat, snare on 2 & 4, hats on the 8ths, a drop every 16 bars. */
  demo(bpm = 128, on = true) {
    clearInterval(this.demoTimer);
    if (!on) return;
    const sid = `demo${Math.floor(Math.random() * 1e6).toString(36)}`;
    const start = epochNow();
    let lastBeat = -1, lastHalf = -1;
    const period = 60000 / bpm;
    const tick = () => {
      const t = epochNow();
      const pos = (t - start) / period;
      const bi = Math.floor(pos), half = Math.floor(pos * 2);
      let ev = 0;
      if (bi !== lastBeat) { lastBeat = bi; ev |= EV_KICK | 4; if (bi % 2 === 1) ev |= EV_SNARE; if (bi % 4 === 0) ev |= EV_DOWN; if (bi % 64 === 32) ev |= EV_DROP; }
      if (half !== lastHalf) { lastHalf = half; if (half % 2) ev |= EV_HAT; }
      const ph = pos - bi;
      this.push({ sid, t, on: true, bpm, bi, ph, bar: bi % 4, cf: 0.9, lk: true, ev, ka: 0, sa: 0,
        e: 0.8, lo: 0.9 * Math.exp(-ph * 4), mi: 0.6, hi: 0.5, k: Math.exp(-ph * 5), s: bi % 2 ? Math.exp(-ph * 6) : 0, h: 0.4, d: 0, sec: 2 }, t);
    };
    tick();
    this.demoTimer = window.setInterval(tick, 16);
  }

  /** Test pages: freeze the clock at a chosen musical moment (screenshots). `sinceKick` etc. in ms. */
  pose(o: { bpm?: number; beat: number; sinceKick?: number; sinceSnare?: number; sinceDrop?: number; energy?: number }, now = epochNow()) {
    clearInterval(this.demoTimer);
    this.sid = 'pose'; this.bpm = o.bpm ?? 128; this.locked = true; this.audible = true;
    this.t0 = now; this.pos0 = o.beat; this.barSlot = 0; this.lastPacketAt = now;
    this.kickAt = o.sinceKick != null ? now - o.sinceKick : -Infinity; this.kickSeq++;
    this.snareAt = o.sinceSnare != null ? now - o.sinceSnare : -Infinity; this.snareSeq++;
    this.dropAt = o.sinceDrop != null ? now - o.sinceDrop : -Infinity;
    const e = o.energy ?? 0.8;
    this.target = { e, lo: e, mi: e * 0.7, hi: e * 0.6, k: 0, s: 0, h: 0.3, d: 0 };
    this.env = { ...this.target };
  }
}

/** One per page: output.ts feeds it, the light show reads it. */
export const beatClock = new BeatClock();

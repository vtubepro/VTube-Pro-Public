// Page side of the music clock (shared/musicClock.ts): every OBS / output page receives the helper's
// {type:'musicclock'} messages and
//  - feeds the embedded BeatPacket to the page's BeatClock, so today's light show, show sky and club FX lock to the DJ's
//    gear with no change of their own (while the helper publishes, the studio's raw 'beat' packets are ignored),
//  - keeps the full clock for new consumers: phrase + "drop in N beats", track, decks, crossfader, controller state,
//  - re-emits controller events (pads, FX on, play, jog) at their true local time,
//  - keeps the DJ's DMX universes ({type:'musicdmx'}) for the 3D rig (shared/dmxIn.ts readFixtures).
// Everything is derived from the bus, so every page shows the same frame (the helper decides, pages render).
//
// Consumers (djstage / lights lanes):
//   import { musicClock } from './musicClockRx.ts';
//   const now = epochNow();
//   if (musicClock.active(now)) {
//     const c = musicClock.clock!;                 // the newest MusicClock (src, bpm, bar, sec, track, decks, ctl…)
//     const beat = musicClock.beatAt(now);         // continuous beat position (same counter as beatClock.posAt)
//     const ph = musicClock.phraseAt(now);         // { kind, sec, pos, len, nextIn?, dropIn?, known } extrapolated to now
//     if (ph?.known && ph.dropIn !== undefined && ph.dropIn < 16) { /* build toward the drop */ }
//   }
//   musicClock.onEvent((e) => { if (e.kind === 'pad') fireCo2(e.deck, e.i); });   // controller events
//   const fx = readFixtures(patch, (u) => musicClock.universe(u));                // DMX in → fixtures
import { sanitizeBeatPacket } from '../../shared/lightShow.ts';
import { sanitizeControllerEvents, sanitizeMusicClock, type ClockPhrase, type ControllerEvent, type MusicClock } from '../../shared/musicClock.ts';
import { dmxFromB64 } from '../../shared/dmxIn.ts';
import { beatClock, epochNow } from './beatClock.ts';
import { TrackShowRx } from './trackShowRx.ts';

/** The helper stops publishing when no DJ source is live: after this, pages go back to the studio's own packets. */
const FRESH_MS = 1500;

export class MusicClockRx {
  clock: MusicClock | null = null;
  /** Local epoch ms the newest clock describes. */
  at = 0;
  lastAt = -Infinity;
  packets = 0;
  private sid = '';
  private offs: number[] = [];
  private offset = 0;
  private listeners = new Set<(e: ControllerEvent) => void>();
  private dmx = new Map<number, { d: Uint8Array; at: number; src: string }>();
  /** Recent controller events (local times), newest last (pages that poll instead of subscribing). */
  events: ControllerEvent[] = [];
  /** The Track library's pre-built show for the on-air track (src/scene/trackShowRx.ts): `show.frame`, `show.register()`. */
  readonly show = new TrackShowRx();

  /** A bus message (musicclock / musicdmx). */
  onBus(m: unknown, now = epochNow()) {
    if (!m || typeof m !== 'object') return;
    const x = m as { type?: string; c?: unknown; b?: unknown; cev?: unknown; u?: unknown; d?: unknown; src?: unknown; show?: unknown };
    if (x.type === 'trackshow') { this.show.onShow(x.show); return; }
    if (x.type === 'musicdmx') {
      if (typeof x.u === 'number' && Number.isInteger(x.u) && x.u >= 1 && x.u <= 63999 && typeof x.d === 'string' && x.d.length <= 1024)
        this.dmx.set(x.u, { d: dmxFromB64(x.d), at: now, src: typeof x.src === 'string' ? x.src.slice(0, 80) : '' });
      return;
    }
    if (x.type !== 'musicclock') return;
    const c = sanitizeMusicClock(x.c);
    if (!c) return;
    if (c.sid !== this.sid) { this.sid = c.sid; this.offs = []; }
    const d = now - c.t;
    this.offs.push(d); if (this.offs.length > 90) this.offs.shift();
    const min = Math.min(...this.offs);
    this.offset = this.offs.length === 1 ? d : Math.min(min, this.offset + 0.05);
    this.clock = c; this.at = c.t + this.offset; this.lastAt = now; this.packets++;
    const b = sanitizeBeatPacket(x.b);
    if (b) beatClock.push(this.show.filterPacket(b, now), now);
    this.show.onClock(c, this.at, now);
    const evs = sanitizeControllerEvents(x.cev);
    for (const e of evs) {
      const le = { ...e, t: e.t + this.offset };
      this.events.push(le); if (this.events.length > 64) this.events.shift();
      for (const f of this.listeners) try { f(le); } catch { /* a consumer's bug */ }
    }
  }

  /** The helper is publishing a DJ clock right now (the page's light show follows it). */
  active(now = epochNow()) { return !!this.clock && now - this.lastAt < FRESH_MS; }
  /** Continuous beat position at local time t (NaN = no tempo). */
  beatAt(t = epochNow()): number {
    const c = this.clock;
    if (!c || !(c.bpm > 0)) return NaN;
    return c.beat + (c.on ? (t - this.at) * c.bpm / 60000 : 0);
  }
  /** The phrase extrapolated to t: pos / nextIn / dropIn advance with the beat. */
  phraseAt(t = epochNow()): ClockPhrase | null {
    const c = this.clock;
    if (!c?.phrase) return null;
    const el = c.on && c.bpm > 0 ? Math.max(0, (t - this.at) * c.bpm / 60000) : 0;
    const p = { ...c.phrase, pos: c.phrase.pos + el };
    if (p.nextIn !== undefined) p.nextIn = Math.max(0, p.nextIn - el);
    if (p.dropIn !== undefined) p.dropIn = Math.max(0, p.dropIn - el);
    return p;
  }
  onEvent(fn: (e: ControllerEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** A DMX universe's 512 values (null = nothing received for 10 s). */
  universe(u: number, now = epochNow()): Uint8Array | null { const x = this.dmx.get(u); return x && now - x.at < 10000 ? x.d : null; }
  universes(now = epochNow()) { return [...this.dmx.entries()].filter(([, v]) => now - v.at < 10000).map(([u, v]) => ({ u, src: v.src })); }
}

/** One per page: output.ts feeds it from the bus. */
export const musicClock = new MusicClockRx();
// read-only debugging / test handle (tools/djsync_e2e.mjs)
if (typeof window !== 'undefined') (window as unknown as { vtpMusic?: MusicClockRx }).vtpMusic = musicClock;

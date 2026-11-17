// Page side of the Track library's pre-built light shows (shared/trackShow.ts). The helper sends each track's compiled
// show once ({type:'trackshow'}) and, with every music-clock message, where the on-air track is (clock.trk: track, deck,
// beat, confidence). This plays the show HERE, on every OBS page alike:
//  - cues fire when the playhead crosses their beat going forward — at their exact time: a timer is set for the next cue
//    from the clock's tempo, so the drop's pyro / CO2 / the crowd jump land ON the downbeat (pre-cued), not one bus
//    message after it; the page's light engine gets the drop through beatClock.dropAt (set to the exact downbeat), and
//    the helper's own late drop event for the same drop is dropped (no double hit);
//  - engines that want more read `frame` (look, build ramp, chase rate, blackout, wall countdown) or register a
//    ShowAdapter (the lights / festival lanes, the club engine);
//  - nothing is known for sure (no trk, low confidence, a scratch) → `frame` is null and engines run their realtime show.
// Listen-only: it never sends anything.
import { EV_DROP, type BeatPacket } from '../../shared/lightShow.ts';
import { sanitizeShow, ShowPlayer, type DeckView, type ShowAdapter, type ShowFire, type ShowFrame, type TrackShow } from '../../shared/trackShow.ts';
import type { MusicClock } from '../../shared/musicClock.ts';
import { beatClock, epochNow } from './beatClock.ts';

/** How far ahead of the wall clock pre-built cues fire (one frame at 60 fps: the frame that shows them). */
export const SHOW_LEAD_MS = 17;

export class TrackShowRx {
  readonly player = new ShowPlayer();
  private shows = new Map<string, TrackShow>();
  private adapters = new Map<string, ShowAdapter>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: MusicClock | null = null;
  private at = 0;
  /** What the show says now (null = no pre-built show: realtime). */
  frame: ShowFrame | null = null;
  /** The last drop this page fired itself (epoch ms of the exact downbeat). */
  lastDrop: { at: number; track: string; beat: number } | null = null;
  /** Recent fires (debug / tests): exact time, how late the page was. */
  fired: { layer: string; act: string; b: number; at: number; late: number; track: string }[] = [];

  /** A show from the bus. */
  onShow(raw: unknown) { const s = sanitizeShow(raw); if (!s) return; this.shows.set(s.track, s); this.player.load(s); if (this.shows.size > 12) this.shows.delete(this.shows.keys().next().value!); }
  has(track: string) { return this.shows.has(track); }
  /** Engines plug in here (returns an unregister function). */
  register(a: ShowAdapter) { this.adapters.set(a.id, a); return () => this.adapters.delete(a.id); }

  /** The helper's drop event for a drop this page already fired at its exact time: drop it (no double hit). */
  filterPacket(b: BeatPacket, now = epochNow()): BeatPacket {
    if ((b.ev & EV_DROP) && this.lastDrop && now - this.lastDrop.at < 1500 && now >= this.lastDrop.at - 50) return { ...b, ev: b.ev & ~EV_DROP };
    return b;
  }
  /** A music-clock message arrived (local time `localAt` = when the clock's `t` happened here). */
  onClock(c: MusicClock, localAt: number, now = epochNow()) {
    this.clock = c; this.at = localAt;
    this.step(now + SHOW_LEAD_MS);
    this.arm(now);
  }
  /** The beat the show's deck is at, at local time t (NaN = unknown). */
  beatAt(t = epochNow()): number {
    const c = this.clock, k = c?.trk;
    if (!c || !k) return NaN;
    return k.beat + (c.on && c.bpm > 0 ? (t - this.at) * c.bpm / 60000 : 0);
  }
  private views(now: number): DeckView[] {
    const c = this.clock, k = c?.trk;
    if (!c || !k || !this.shows.has(k.id) || now - this.at > 1500) return [];
    return [{ n: k.deck, track: k.id, beat: this.beatAt(now), bpm: c.bpm, conf: k.conf, gain: 1, playing: c.on }];
  }
  /** Fire what was crossed, refresh the frame. The show runs SHOW_LEAD_MS ahead of the wall clock: a cue's light is
   *  computed into the frame that reaches the screen on its beat (rhythm lane; src/scene/lightShow.ts frameLead). */
  step(now = epochNow() + SHOW_LEAD_MS) {
    const v = this.views(now);
    if (!v.length) { this.frame = null; for (const a of this.adapters.values()) try { a.frame?.(null); } catch { /* a consumer's bug */ } return; }
    const fires = this.player.step(now, v);
    for (const f of fires) this.fire(f);
    this.frame = this.player.frame(v);
    for (const a of this.adapters.values()) try { a.frame?.(this.frame); } catch { /* a consumer's bug */ }
  }
  private fire(f: ShowFire) {
    if (f.cue.layer === 'hit' && (f.cue.prio ?? 0) >= 10) {
      // the drop: the page's light show, crowd and DJ follow beatClock.dropAt — set it to the EXACT downbeat
      // (the helper's event for this drop already arrived: only correct its time, don't count a second drop)
      const already = beatClock.dropAt >= f.at - 200 && beatClock.dropAt <= f.at + 1000;
      beatClock.dropAt = f.at; if (!already) beatClock.dropSeq++;
      this.lastDrop = { at: f.at, track: f.track, beat: f.cue.b };
    }
    this.fired.push({ layer: f.cue.layer, act: f.cue.act, b: f.cue.b, at: f.at, late: +f.late.toFixed(1), track: f.track });
    if (this.fired.length > 64) this.fired.shift();
    for (const a of this.adapters.values()) try { a.fire?.(f); } catch { /* a consumer's bug */ }
  }
  /** A timer for the next cue inside the coming ~120 ms, so it fires on its beat (not at the next bus message). */
  private arm(now: number) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.clock, k = c?.trk, s = k ? this.shows.get(k.id) : null;
    if (!c || !k || !s || !c.on || !(c.bpm > 0) || k.deck !== this.player.owner) return;
    const b = this.beatAt(now), per = 60000 / c.bpm;
    let next = Infinity;
    for (const q of s.cues) { if (q.b > b) { next = q.b; break; } }
    const ms = (next - b) * per;
    if (!(ms >= 0 && ms < 120)) return;
    this.timer = setTimeout(() => { this.timer = null; this.step(); this.arm(epochNow()); }, Math.max(0, ms - SHOW_LEAD_MS - 0.5));
  }
}

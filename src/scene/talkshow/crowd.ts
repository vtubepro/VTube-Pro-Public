// The crowd collector: turns what the studio hears (chat laughs, support events, "Answer now", applause, the show open) into the
// events the interview director reacts to (director.event). Pure and clocked by the caller (`t` in seconds), so the same stream
// gives the same events on the CPU (tools/talkshow/director_score.ts) and in the studio (src/ui/stage/interviewCrowd.ts feeds it
// from the bus). Bursts are merged here: a 20-gift train is ONE event, a wave of laughing chatters is ONE event.
//
//   laughWave  ≥ WAVE_N different chatters laughing (LUL / KEKW / 😂) inside WAVE_SECS; then quiet for WAVE_COOL
//   alert      a cheer of $20+ (shared/audience.ts cheerSize 2), a raid of RAID_MIN+, the gift train's GIFT_MIN-th gift, applause
//   ask        "Answer now" on a chat question (key = a short hash of the asker's chat key: cue field `ak`; cut:false = the owner's
//              "Close-up of the asker" is off: the director still tracks who was asked, it only cuts no close-up)
//   show       the show-open card starts
import { cheerSize } from '../../../shared/audience.ts';
import { askKey } from './cueShots.ts';
import type { DirectorEvent } from './director.ts';

export const WAVE_N = 3, WAVE_SECS = 2.5, WAVE_COOL = 4, GIFT_MIN = 5, MONTAGE_MIN = 10, GIFT_GAP = 3, RAID_MIN = 10;

/** What the studio feeds in (t = the caller's clock, seconds). */
export type RawEvent =
  | { t: number; kind: 'bumper' }
  | { t: number; kind: 'chatLaugh'; who: string }
  | { t: number; kind: 'cheer'; usd: number; intensity?: number }
  | { t: number; kind: 'gift'; n?: number }
  | { t: number; kind: 'raid'; n: number }
  | { t: number; kind: 'ask'; key: string; text: string; cut?: false }
  | { t: number; kind: 'applause' };

export class CrowdEvents {
  private laughs: { t: number; who: string }[] = [];
  private waveAt = -99;
  private train = { n: 0, last: -99, fired: false, montage: false };
  private out: DirectorEvent[] = [];

  /** An event happened. */
  push(e: RawEvent | Record<string, unknown>): void {
    const r = e as RawEvent;
    if (typeof r.t !== 'number' || !Number.isFinite(r.t)) return;
    switch (r.kind) {
      case 'bumper': this.out.push({ kind: 'show' }); break;
      case 'applause': this.out.push({ kind: 'alert', what: 'applause', size: 1 }); break;
      case 'ask': if (typeof r.key === 'string' && typeof r.text === 'string') this.out.push({ kind: 'ask', key: askKey(r.key), text: r.text.slice(0, 280), ...(r.cut === false ? { cut: false as const } : {}) }); break;
      case 'chatLaugh': {
        this.laughs.push({ t: r.t, who: String(r.who ?? '').slice(0, 64) });
        this.laughs = this.laughs.filter((q) => r.t - q.t <= WAVE_SECS).slice(-40);
        const who = new Set(this.laughs.map((q) => q.who));
        if (who.size >= WAVE_N && r.t - this.waveAt >= WAVE_COOL) { this.waveAt = r.t; this.out.push({ kind: 'laughWave', n: who.size }); this.laughs = []; }
        break;
      }
      case 'cheer': {
        const size = cheerSize(Number(r.usd) || 0, r.intensity ?? 1);
        if (size >= 2) this.out.push({ kind: 'alert', what: 'cheer', size });
        break;
      }
      case 'raid': if ((Number(r.n) || 0) >= RAID_MIN) this.out.push({ kind: 'alert', what: 'raid', size: r.n >= 50 ? 3 : 2 }); break;
      case 'gift': {
        // a gift train: gifts less than GIFT_GAP s apart are one event, raised once when it reaches GIFT_MIN (size 3 at 10+ is the montage's)
        const T = this.train;
        if (r.t - T.last > GIFT_GAP) { T.n = 0; T.fired = false; T.montage = false; }
        T.n += Math.max(1, Math.round(Number(r.n) || 1)); T.last = r.t;
        if (T.n >= GIFT_MIN && !T.fired) { T.fired = true; this.out.push({ kind: 'alert', what: 'gifts', size: 2 }); }
        // (ten gifts: the crowd montage on top of the applause)
        if (T.n >= MONTAGE_MIN && !T.montage) { T.montage = true; this.out.push({ kind: 'alert', what: 'montage', size: 3 }); }
        break;
      }
    }
  }

  /** The events since the last call (the caller hands them to director.event). */
  take(_t = 0): DirectorEvent[] {
    const o = this.out; this.out = [];
    return o;
  }
}

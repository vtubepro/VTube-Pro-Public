// "Use as my idle" (lane recemote): one recorded emote that plays on a loop while the camera is not tracking you (camera off,
// you stepped away), and stops by itself the moment tracking is back. The chosen emote is kept on the helper (the list says which
// one) and remembered in this browser, so it works again after a reload without asking the helper first.
//
// Cost: nothing at all until an idle emote is chosen; then one check a second (no work per frame).
import { playRecorded, stopRecordedEmote, type EmoteHost } from './player.ts';

const KEY = 'vtp.recemote.idle';
/** How long tracking must be gone before the idle emote starts, and how long it must be back before it stops. */
export const IDLE_AFTER_MS = 4000;
export const BACK_AFTER_MS = 1000;

export interface IdleHost extends EmoteHost {
  trackingOn: boolean;
  frame: { tracked: boolean };
  /** a read-only "observer" studio tab never plays anything */
  observer?: boolean;
}

export function rememberedIdle(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): string | null {
  try { const v = storage?.getItem(KEY); return v && /^[a-z0-9][a-z0-9-]{0,47}$/.test(v) ? v : null; } catch { return null; }
}
function safeStorage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }

/** Pure decision, one tick: what to do given how long tracking has been gone / back, whether any emote is playing, and
 *  whether the playing one is the idle emote we started. */
export function idleStep(s: { id: string | null; lostMs: number; backMs: number; playing: boolean; ours: boolean }): 'start' | 'stop' | 'none' {
  if (!s.id) return s.ours ? 'stop' : 'none';
  if (s.ours) return s.backMs >= BACK_AFTER_MS ? 'stop' : 'none';
  return s.lostMs >= IDLE_AFTER_MS && !s.playing ? 'start' : 'none';
}

export class IdleEmote {
  private id: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private since = 0;          // when the tracked / not tracked state last changed
  private wasTracked = true;
  private ours: number | null = null;   // the stamp id of the emote we started
  private starting = false;
  private retryAt = 0;
  constructor(private host: IdleHost, private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = safeStorage(), private now: () => number = Date.now, private play = playRecorded) {
    this.id = rememberedIdle(storage);
    if (this.id) this.run();
  }
  get current() { return this.id; }

  /** Choose the idle emote (null = none). The panel calls this with what the helper says. */
  set(id: string | null) {
    if (id === this.id) return;
    this.id = id;
    try { if (id) this.storage?.setItem(KEY, id); else this.storage?.removeItem(KEY); } catch { /* storage blocked */ }
    if (id) this.run(); else { this.halt(); this.release(); }
  }
  destroy() { this.halt(); this.release(); }

  private run() {
    if (this.timer || this.host.observer) return;
    this.since = this.now(); this.wasTracked = this.tracked();
    this.timer = setInterval(() => this.tick(), 1000);
  }
  private halt() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private release() { if (this.ours !== null) { if (this.host.emote?.id === this.ours) stopRecordedEmote(this.host); this.ours = null; } }
  private tracked() { return this.host.trackingOn && this.host.frame.tracked; }

  tick() {
    const t = this.now(), tr = this.tracked();
    if (tr !== this.wasTracked) { this.wasTracked = tr; this.since = t; }
    if (this.ours !== null && this.host.emote?.id !== this.ours) this.ours = null;      // something else took over (or it was stopped)
    const act = idleStep({ id: this.id, lostMs: tr ? 0 : t - this.since, backMs: tr ? t - this.since : 0, playing: !!this.host.emote, ours: this.ours !== null });
    if (act === 'stop') this.release();
    else if (act === 'start' && this.id && !this.starting && t >= this.retryAt) {
      this.starting = true;
      void this.play(this.host, this.id, { loop: true }).then((r) => {
        this.starting = false;
        if (r.ok) this.ours = this.host.emote?.id ?? null; else this.retryAt = this.now() + 30_000;   // (deleted, or VTube Pro is away: try again in 30 s)
      });
    }
  }
}

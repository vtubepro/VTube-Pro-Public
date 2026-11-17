// Keys & pads: hand signs (docs/b16/BINDINGS.md). Reads the hand results the tracker already computed (the gesture name and
// the finger bend of each hand, src/tracking/bodySolver.ts) a few times a second; it never opens a camera or runs a model of
// its own. No timer until a binding (or a rule) wants a hand sign. Waves come from the gesture detector's own events.
import type { App } from '../app.ts';
import { SignTracker, handEvent, signFrom, type SignEvent } from './bindings.ts';
import type { RuleEvent } from '../../shared/streamRules.ts';

const TICK_MS = 66;
/** `first` = this is the first hold time of the sign (the one the rules hear). */
export interface HandSink { down(ev: RuleEvent, first: boolean): void; up(ev: RuleEvent): void }

export class HandSource {
  /** performance.now() of the last frame that saw a hand (the panel says "your camera doesn't see your hands" when stale). */
  lastSeen = 0;
  private tracker = new SignTracker();
  private timer = 0;
  private lastWave = 0;
  constructor(private app: App, private sink: HandSink, private thresholds: () => number[], private onChange: () => void) {}

  get running() { return !!this.timer; }
  start() {
    if (this.timer) return;
    this.lastWave = this.latestWave();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.onChange();
  }
  stop() {
    if (!this.timer) return;
    window.clearInterval(this.timer); this.timer = 0;
    this.emit(this.tracker.reset());
    this.onChange();
  }
  private latestWave(): number { let m = 0; for (const e of this.app.gestures.events) m = Math.max(m, e.id); return m; }
  private emit(list: SignEvent[]) {
    if (!list.length) return;
    const first = Math.min(...this.thresholds(), Infinity);
    for (const e of list) {
      const ev = handEvent(e.sign, e.side, e.heldMs);
      if (e.type === 'down') this.sink.down(ev, e.heldMs <= first); else this.sink.up(ev);
    }
  }
  private tick() {
    const bt = this.app.bodyTargets, now = performance.now(), th = this.thresholds();
    for (const side of ['left', 'right'] as const) {
      const g = bt?.gestures[side] ?? null, curls = bt?.hands[side]?.curls ?? null;
      const raw = g || curls ? signFrom(g?.name, g?.score ?? 0, curls) : null;
      if (raw) this.lastSeen = now;
      this.emit(this.tracker.update(side, raw, now, th));
    }
    // a wave is a moment, not a held sign: down and up together
    for (const e of this.app.gestures.events) {
      if (e.id <= this.lastWave) continue;
      this.lastWave = Math.max(this.lastWave, e.id);
      if (e.kind !== 'wave') continue;
      const ev = handEvent('wave', e.side, 0);
      this.sink.down(ev, true); this.sink.up(ev);
    }
  }
}

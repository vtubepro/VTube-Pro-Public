// Keys & pads: controller buttons (docs/b16/BINDINGS.md). Reads the browser's Gamepad API. No timer at all until a controller
// is plugged in, and the timer is cleared again when the last one is unplugged. The browser only gives a page its controller
// while the page is visible, so a hidden or minimised VTube Pro tab stops hearing it: the runtime says so in the panel.
import { diffButtons } from './bindings.ts';

const POLL_MS = 16;
const DOWN = 0.6;

export interface PadSink { press(button: number, pad: number): void; release(button: number, pad: number): void; lost(): void }
export class GamepadSource {
  /** Names of the connected controllers. */
  names: string[] = [];
  /** performance.now() of the last button press or stick move (the thumb pose reads this). */
  lastUsed = 0;
  /** Latest stick positions per controller index: [leftX, leftY, rightX, rightY]. */
  sticks = new Map<number, [number, number, number, number]>();
  private prev = new Map<number, boolean[]>();
  private timer = 0;
  private running = false;
  constructor(private sink: PadSink, private onChange: () => void) {}

  start() {
    if (this.running || typeof window === 'undefined' || !('getGamepads' in navigator)) return;
    this.running = true;
    window.addEventListener('gamepadconnected', this.onConnect);
    window.addEventListener('gamepaddisconnected', this.onConnect);
    document.addEventListener('visibilitychange', this.onVisible);
    this.sync();
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener('gamepadconnected', this.onConnect);
    window.removeEventListener('gamepaddisconnected', this.onConnect);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.halt();
  }
  private halt() { if (this.timer) { window.clearInterval(this.timer); this.timer = 0; } this.prev.clear(); this.sticks.clear(); }
  private onConnect = () => this.sync();
  private onVisible = () => { if (document.hidden) { this.prev.clear(); this.sink.lost(); } };
  private pads(): Gamepad[] { try { return [...navigator.getGamepads()].filter((g): g is Gamepad => !!g && g.connected); } catch { return []; } }
  private sync() {
    const pads = this.pads();
    const names = pads.map((g) => g.id.replace(/\s*\(.*?(vendor|STANDARD).*?\)\s*/i, '').slice(0, 48));
    const changed = names.join('|') !== this.names.join('|');
    this.names = names;
    if (pads.length && !this.timer) this.timer = window.setInterval(() => this.poll(), POLL_MS);
    if (!pads.length) { this.halt(); if (changed) this.sink.lost(); }
    if (changed) this.onChange();
  }
  private poll() {
    const pads = this.pads();
    if (pads.length !== this.names.length) { this.sync(); return; }
    const now = performance.now();
    for (const g of pads) {
      const cur = g.buttons.map((b) => b.pressed || b.value > DOWN);
      const { pressed, released } = diffButtons(this.prev.get(g.index), cur);
      this.prev.set(g.index, cur);
      for (const b of pressed) { this.lastUsed = now; this.sink.press(b, g.index); }
      for (const b of released) this.sink.release(b, g.index);
      const a = g.axes, s: [number, number, number, number] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
      const old = this.sticks.get(g.index);
      if (!old || Math.abs(old[0] - s[0]) + Math.abs(old[1] - s[1]) + Math.abs(old[2] - s[2]) + Math.abs(old[3] - s[3]) > 0.08) { if (old) this.lastUsed = now; this.sticks.set(g.index, s); }
    }
  }
}

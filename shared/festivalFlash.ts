// The festival's own photosensitivity governor: used when the room light show's governor (shared/flashGovernor.ts, the
// reactive-lights lane) is not in the build, so a festival stage is never "as authored" on its own. Same rules as that
// governor (WCAG 2.3.1 / ITU-R BT.1702: a flash = a pair of opposing changes of ≥ 10 % of the brighter state, at most
// 3 in any second):
//   - every output is a channel; moving on in the same direction is free (rises keep rising, decays keep decaying);
//   - turning back by more than TOL (5 % of the brighter state) is a transition, allowed only inside a room-wide window;
//     windows open at most every GAP ms (180) and last WIN ms (40): 6 × 180 − 40 ≥ 1000, so no second holds more than 6
//     transitions = 3 flashes, however many channels (they all turn inside the same windows);
//   - a channel turns at most once per window; outside a window it is HELD within TOL of its last extreme (a peak stays
//     up, a dark stays dark - no chop);
//   - entering / leaving saturated red (R / (R+G+B) ≥ 0.8) is a transition too (the colour is held).
// With the limit off nothing is held; a light turning more than 6 times in a second sets `overAt` (the warning).
// countFlashes() is the WCAG counter the tests run on drawn luminance series.
export const FLASH_GOV = { GAP: 180, WIN: 40, TOL: 0.05, EPS: 0.01 };

export interface FlashChannel { y: number; ext: number; dir: number; win: number; red: boolean; init: boolean; tt?: number[] }
export const flashChannel = (): FlashChannel => ({ y: 0, ext: 0, dir: 0, win: -1, red: false, init: false });

export class FestivalFlashGovernor {
  safe = true;
  overAt = -Infinity;
  shown = 0; held = 0;
  holdRed = false;
  private now = 0;
  private winId = -1; private winCount = 0;          // (window ids only grow: a slot that steps back is no old window)
  private lastSlot = NaN; private lastWinAt = -Infinity;
  /** `gap`: the least time between two windows (ms; default FLASH_GOV.GAP). A stage gate passes 334: <= 3 a second.
   *  `oneFrame`: a window lasts ONE frame - every output that turns, turns on the same frame (outputs turning on
   *  successive frames of a 40 ms window could dip the summed stage and bring it back: two turns in one window) */
  constructor(private readonly gap = FLASH_GOV.GAP, private readonly oneFrame = false) {}

  /** once per frame before stepping channels: windows on a shared grid (`slot` bumps at each boundary, `since` = ms since
   *  it); without a grid, GAP-ms slots of `now` */
  frame(now: number, slot = Math.floor(now / FLASH_GOV.GAP), since = now - Math.floor(now / FLASH_GOV.GAP) * FLASH_GOV.GAP, allow = true) {
    // time jumped back (a seek, a clock re-sync): the next window waits a full gap from here - never an immediate one,
    // which could land right after the last window in real time
    if (now < this.now - 1000 || now < this.lastWinAt - 1000) { this.lastWinAt = now; this.lastSlot = slot; }
    this.now = now;
    // a window opens on the first frame of a new slot - also a late one (a slow page or a test stepping 100 ms frames
    // must not freeze every light); never two windows closer than `gap` by THIS clock, whatever the slots do (a beat
    // grid that jitters or steps back on a phase correction, frames bunched after a stall), so the bound holds
    // (`allow` false: no window may open on this frame - another gate is closed; the slot stays pending, so the window
    // opens on the first frame both allow)
    if (slot !== this.lastSlot && allow) {
      this.lastSlot = slot;
      const start = Math.max(since <= FLASH_GOV.WIN && this.oneFrame === false ? now - since : now, this.lastWinAt);
      if (start - this.lastWinAt >= this.gap - 1) { this.lastWinAt = start; this.winId = ++this.winCount; } else this.winId = -1;
    } else if (this.oneFrame || now - this.lastWinAt > FLASH_GOV.WIN) this.winId = -1;
  }

  private window(ch: FlashChannel): boolean {
    if (this.winId < 0 || ch.win === this.winId) return false;
    ch.win = this.winId;
    return true;
  }

  /** the id of the window open on this frame (-1 = none) */
  get openWindow() { return this.winId; }

  /** the luminance the channel may show now for a wanted luminance L (any unit: ratios only) */
  step(ch0: object, L: number, red = false): number {
    const ch = ch0 as FlashChannel;
    this.holdRed = false;
    if (!(L >= 0)) L = 0;
    if (!ch.init) { ch.init = true; ch.y = L; ch.ext = L; ch.dir = 0; ch.red = red; ch.win = -1; return L; }
    if (red !== ch.red && Math.max(L, ch.y) > FLASH_GOV.EPS) {
      const ok = this.safe ? this.window(ch) : (this.unsafe(ch), true);
      if (ok) ch.red = red; else { this.holdRed = true; this.held++; }
    }
    let y = L;
    const tiny = Math.max(L, ch.ext) <= FLASH_GOV.EPS;
    const tol = this.safe ? FLASH_GOV.TOL : 0.1;
    if (ch.dir >= 0) {
      if (L >= ch.ext || tiny) { if (L > ch.ext && !tiny) ch.dir = 1; ch.ext = L; }
      else if (L >= ch.ext * (1 - tol)) { /* a small dip: free */ }
      else if (!this.safe) { this.unsafe(ch); ch.dir = -1; ch.ext = L; }
      else if (this.window(ch)) { ch.dir = -1; ch.ext = L; this.shown++; }
      else { y = ch.ext * (1 - FLASH_GOV.TOL); this.held++; this.overAt = this.now; }
    } else {
      if (L <= ch.ext || tiny) ch.ext = L;
      else if (L * (1 - tol) <= ch.ext) { /* a small rise: free */ }
      else if (!this.safe) { this.unsafe(ch); ch.dir = 1; ch.ext = L; }
      else if (this.window(ch)) { ch.dir = 1; ch.ext = L; this.shown++; }
      else { y = ch.ext / (1 - FLASH_GOV.TOL); this.held++; this.overAt = this.now; }
    }
    ch.y = y;
    return y;
  }

  private unsafe(ch: FlashChannel) {
    const t = this.now;
    const tt = (ch.tt ??= []);
    tt.push(t); if (tt.length > 7) tt.shift();
    if (tt.length === 7 && t - tt[0] < 1000) this.overAt = t;
    this.shown++;
  }
}

export const relLum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const isSatRed = (r: number, g: number, b: number) => { const s = r + g + b; return s > 1e-4 && r / s >= 0.8; };

/** WCAG-style flash count of a luminance series (`fps` samples a second): transitions = turning points with a change
 *  ≥ 10 % of the brighter state (levels under `eps` ignored) and, when `minAbs` is given, also ≥ minAbs in absolute
 *  terms (WCAG's own floor is 10 % of the MAXIMUM relative luminance: a 0.05 -> 0.06 twinkle of a dark patch is not a
 *  flash), a flash = a pair. Returns the worst count in any second. */
export function countFlashes(sig: ArrayLike<number>, fps: number, eps = FLASH_GOV.EPS, minAbs = 0): { worst: number; perSec: number } {
  const turns: number[] = [];
  let ext = sig[0] ?? 0, dir = 0;
  for (let i = 1; i < sig.length; i++) {
    const v = sig[i];
    const hi = Math.max(v, ext);
    if (dir > 0 && v >= ext) { ext = v; continue; }
    if (dir < 0 && v <= ext) { ext = v; continue; }
    if (hi <= eps) { if (dir === 0) ext = v; continue; }
    if (Math.abs(v - ext) >= Math.max(0.1 * hi, minAbs)) { turns.push(i); dir = v > ext ? 1 : -1; ext = v; }
  }
  let worst = 0;
  for (let a = 0, b = 0; a < turns.length; a++) { while (b < turns.length && turns[b] - turns[a] < fps) b++; worst = Math.max(worst, Math.floor((b - a) / 2)); }
  return { worst, perSec: turns.length / 2 / Math.max(1e-6, sig.length / fps) };
}

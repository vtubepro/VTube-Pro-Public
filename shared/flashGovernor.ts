// Photosensitivity governor: the ONE place every light output passes before it is drawn (fixtures, their real
// lights, shared EMIT_ materials, house lights, the stage rim / wash, the performers' show light, beams, lasers, the
// mirror ball, support cues, music styles, looks other rigs register). It does not trust any author flag: it looks at
// what each output would actually do to its relative luminance.
//
// WCAG 2.3.1 / ITU-R BT.1702: a flash is a pair of opposing changes of >= 10 % of the brighter state; more than 3
// flashes in any second fails. The governor tracks every channel's turning points:
//   - moving on in the same direction is always free (rises keep rising, decays keep decaying);
//   - turning back by more than TOL (5 % of the brighter state: strictly under the 10 % that counts) is a
//     TRANSITION, allowed only inside a room-wide window. Windows open at most every GAP ms (180) and stay open WIN
//     ms (40); 6 x 180 - 40 >= 1000, so no 1-second span can hold more than 6 transitions = 3 flashes, whatever
//     the number of channels (they all turn inside the same windows: the room never flashes faster than 3 a second
//     even when many small lights do it together). The windows sit on the beat grid (half beats up to 166 BPM,
//     beats above, every 2 beats above 333) so held hits still land on the music, and on every page alike;
//   - a channel turns at most once per window;
//   - outside a window a turning channel is HELD within TOL of its last extreme (a peak stays up, a dark stays dark).
// Saturated red (R/(R+G+B) >= 0.8, WCAG's red flash) entering or leaving is a transition too (the colour is held).
// With the limit off (the streamer's opt-out) nothing is held, but every transition that comes faster than the limit
// sets `overAt`: the OBS page's "Flashing lights" notice (src/scene/flashWarning.ts).
export const GOV = { GAP: 180, WIN: 40, TOL: 0.05, EPS: 0.01 };

export interface GovChannel { y: number; ext: number; dir: number; win: number; red: boolean; init: boolean; tt?: number[]; id?: string }
export const govChannel = (id?: string): GovChannel => ({ y: 0, ext: 0, dir: 0, win: -1, red: false, init: false, id });

export class FlashGovernor {
  safe = true;
  /** last time something turned faster than the limit (safe on: was held; safe off: was shown) */
  overAt = -Infinity;
  /** transitions shown / held (debug) */
  shown = 0; held = 0;
  private now = 0;
  private winId = -1;            // the open window (-1 = none open now)
  private lastSlot = NaN; private lastWinAt = -Infinity;

  /**
   * Call once per rendered frame before stepping channels. Windows sit on a SHARED time grid so every page holds
   * and releases the same hits: `slot` = an integer that bumps at each window boundary (beat subdivisions of at least
   * GAP ms when the beat grid is locked, else GAP-ms slots of the sender's clock), `since` = ms since that boundary.
   * Without a grid, call frame(now) alone: GAP-ms slots of `now`.
   */
  frame(now: number, slot = Math.floor(now / GOV.GAP), since = now - Math.floor(now / GOV.GAP) * GOV.GAP) {
    // time went backwards (a test page's virtual clock, a re-attach): forget the window history, never freeze
    if (now < this.now - 1000 || now < this.lastWinAt - 1000) { this.lastWinAt = -Infinity; this.lastSlot = NaN; }
    this.now = now;
    this.framedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (since <= GOV.WIN && slot !== this.lastSlot) {
      this.lastSlot = slot;
      const start = now - since;
      // a grid jump (re-anchor, tempo change) must never bring two windows closer than GAP
      if (start - this.lastWinAt >= GOV.GAP - 1) { this.lastWinAt = start; this.winId = slot; } else this.winId = -1;
    } else if (since > GOV.WIN) this.winId = -1;
  }

  /** Engines outside the light show: frame the governor if nobody did this frame (plain 180 ms windows). */
  ensureFrame(now: number) { const w = typeof performance !== 'undefined' ? performance.now() : Date.now(); if (!(w - this.framedAt < 40)) this.frame(now); }
  private framedAt = -Infinity;

  /** May a channel turn now? (once per window) */
  private window(ch: GovChannel): boolean {
    if (this.winId < 0 || ch.win === this.winId) return false;
    ch.win = this.winId;
    return true;
  }

  /**
   * The luminance the channel may show now for a wanted luminance `L` (>= 0, any unit: only ratios matter).
   * `red` = the wanted colour is a saturated red. Returns the allowed luminance; `holdRed` is set when the colour
   * must stay as it was (a red flash was held).
   */
  step(ch: GovChannel, L: number, red = false): number {
    this.holdRed = false;
    if (!(L >= 0)) L = 0;
    if (!ch.init) { ch.init = true; ch.y = L; ch.ext = L; ch.dir = 0; ch.red = red; return L; }
    // red-flash rule: entering / leaving saturated red (on a visible light) is a transition
    if (red !== ch.red && Math.max(L, ch.y) > GOV.EPS) {
      const ok = this.safe ? this.window(ch) : (this.unsafe(ch), true);
      if (ok) ch.red = red; else { this.holdRed = true; this.held++; }
    }
    let y = L;
    const tiny = Math.max(L, ch.ext) <= GOV.EPS;
    // holding (limit on) starts at TOL, strictly under the 10 % that counts; counting (limit off) uses the 10 % itself
    const tol = this.safe ? GOV.TOL : 0.1;
    if (ch.dir >= 0) {                                    // rising (or not moving yet): ext = the peak
      if (L >= ch.ext || tiny) { if (L > ch.ext && !tiny) ch.dir = 1; ch.ext = L; }
      else if (L >= ch.ext * (1 - tol)) { /* a small dip: free */ }
      else if (!this.safe) { this.unsafe(ch); ch.dir = -1; ch.ext = L; }
      else if (this.window(ch)) { ch.dir = -1; ch.ext = L; this.shown++; }
      else { y = ch.ext * (1 - GOV.TOL); this.held++; this.overAt = this.now; }
    } else {                                              // falling: ext = the trough
      if (L <= ch.ext || tiny) ch.ext = L;
      else if (L * (1 - tol) <= ch.ext) { /* a small rise: free */ }
      else if (!this.safe) { this.unsafe(ch); ch.dir = 1; ch.ext = L; }
      else if (this.window(ch)) { ch.dir = 1; ch.ext = L; this.shown++; }
      else { y = ch.ext / (1 - GOV.TOL); this.held++; this.overAt = this.now; }
    }
    ch.y = y;
    return y;
  }
  /** set by step(): the colour change to / from saturated red was held this frame (keep the previous colour) */
  holdRed = false;

  /** limit off: nothing is held, only counted. Over the limit = a light turning more than 6 times (3 flashes) in a
   *  second. (Many small lights twinkling out of step are not counted as one big flash.) */
  private unsafe(ch: GovChannel) {
    const t = this.now;
    const tt = (ch.tt ??= []);
    tt.push(t); if (tt.length > 7) tt.shift();
    if (tt.length === 7 && t - tt[0] < 1000) this.overAt = t;
    this.shown++;
  }
}

/** Relative luminance of a linear RGB colour (Rec. 709 weights) and the saturated-red test (WCAG 2.2). */
export const relLum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const isSatRed = (r: number, g: number, b: number) => { const s = r + g + b; return s > 1e-4 && r / s >= 0.8; };

/**
 * Count WCAG-style flashes on a luminance series (fps samples / s): transitions = turning points with a change of
 * >= 10 % of the brighter state (levels under `eps` ignored); a flash = a pair of opposing transitions. Returns the
 * worst number of flashes in any 1-second window.
 */
export function countFlashes(sig: ArrayLike<number>, fps: number, eps = GOV.EPS): { worst: number; perSec: number } {
  const turns: number[] = [];
  let ext = sig[0] ?? 0, dir = 0;
  for (let i = 1; i < sig.length; i++) {
    const v = sig[i];
    const hi = Math.max(v, ext);
    if (dir > 0 && v >= ext) { ext = v; continue; }
    if (dir < 0 && v <= ext) { ext = v; continue; }
    if (hi <= eps) { if (dir === 0) ext = v; continue; }
    if (Math.abs(v - ext) >= 0.1 * hi) { turns.push(i); dir = v > ext ? 1 : -1; ext = v; }   // a confirmed transition
  }
  let worst = 0;
  for (let a = 0, b = 0; a < turns.length; a++) { while (b < turns.length && turns[b] - turns[a] < fps) b++; worst = Math.max(worst, Math.floor((b - a) / 2)); }
  return { worst, perSec: turns.length / 2 / Math.max(1e-6, sig.length / fps) };
}

// ---------------------------------------------------------------- one governor per page, for every engine
// The room's light show (src/scene/lightShow.ts) owns the page's governor and frames it on the beat grid each render;
// every other engine that animates light (the club LED wall, the show sky, night lights, chat / screen LEDs, ad
// glitches, police bars, room-form programs, the performers' sparkle, muzzle flashes) steps its outputs through the
// same one, so they share the same windows: the whole page never flashes more than 3 times a second.
let page: FlashGovernor | null = null;
/** The light show registers its governor (the latest attached room wins). */
export function setPageGovernor(g: FlashGovernor) { page = g; }
/** The page's governor (a self-framing stand-in when no room light show runs: limit on, plain 180 ms windows). */
export function pageGovernor(now?: number): FlashGovernor {
  page ??= new FlashGovernor();
  if (now !== undefined) page.ensureFrame(now);
  return page;
}
/**
 * Govern an output of brightness `a + b·k + extra` driven by an envelope k (a kick, a pulse …): returns the k the output
 * may show now (the brightness it implies stays inside the governor's rules). b > 0.
 */
export function governK(g: FlashGovernor, ch: GovChannel, k: number, a: number, b: number, extra = 0): number {
  const L = Math.max(0, a + b * k + extra);
  const y = g.step(ch, L);
  if (y === L) return k;
  return Math.max(0, (y - a - extra) / b);
}
/**
 * Spawned flashes (muzzle flashes, sparks) with the limit on: at most one per ~2 m spot every 360 ms (a gun firing 10
 * rounds a second shows 3 flashes). `allow` returns false for one that must be skipped; with the limit off, always true.
 */
export class SpotFlashGate {
  private last = new Map<string, number>();
  allow(x: number, y: number, z: number, now: number, safe = pageGovernor().safe): boolean {
    if (!safe) return true;
    const key = `${Math.round(x / 2)},${Math.round(y / 2)},${Math.round(z / 2)}`;
    const l = this.last.get(key);
    if (l !== undefined && now - l < 360 && now >= l) return false;
    this.last.set(key, now);
    if (this.last.size > 256) this.last.delete(this.last.keys().next().value as string);
    return true;
  }
}

/** A cosmetic flicker's amplitude (engine flames, fire sprites, glows): with the flash limit on at most 0.04 — an 8 %
 *  swing, under the 10 % that counts as a flash — whatever its rate. */
export const safeAmp = (amp: number) => (pageGovernor().safe ? Math.min(amp, 0.04) : amp);
const named = new Map<string, GovChannel>();
/** A governor channel by name (engines that build frames in pure functions: one channel per ship / light / sign). */
export function namedChannel(key: string): GovChannel {
  let c = named.get(key);
  if (!c) { c = govChannel(key); named.set(key, c); if (named.size > 512) named.delete(named.keys().next().value as string); }
  return c;
}
/** Step a named output through the page governor now (epoch ms): returns the brightness it may show. */
export const govern = (key: string, L: number, red = false) => pageGovernor(performance.timeOrigin + performance.now()).step(namedChannel(key), L, red);

// The festival's thin adapter to the lights lane's photosensitivity governor (shared/flashGovernor.ts, lane b13-lights):
// every light output of a festival stage (moving heads, PARs, strobes, blinders, pixels, lasers, LED walls, the stage
// flash, flames) passes the SAME governor as the room's light show (SceneRuntime.lights.gov), so the room as a whole
// never turns more than 6 times (3 flashes) in any second with the limit on. The festival's own FlashGate
// (shared/festival.ts) still shapes the content first (keyed hits ≤ 3 Hz, held colour chases steady); the governor is
// the guarantee on what is actually drawn.
// The module is looked up with import.meta.glob; a build without the lights lane uses the festival's own governor with
// the same rules (shared/festivalFlash.ts) - never "as authored".
import type { SceneRuntime } from '../SceneRuntime.ts';
import { FestivalFlashGovernor, flashChannel, isSatRed as localSatRed, relLum as localLum } from '../../../shared/festivalFlash.ts';
import { lin } from './common.ts';
import { epochNow } from '../beatClock.ts';

type Chan = object;
interface GovLike {
  safe: boolean; overAt: number; shown: number; held: number; holdRed: boolean;
  step(ch: Chan, L: number, red?: boolean): number;
  frame(now: number, slot?: number, since?: number): void;
}
export interface GovApi {
  FlashGovernor: new () => GovLike;
  govChannel: (id?: string) => Chan;
  relLum: (r: number, g: number, b: number) => number;
  isSatRed: (r: number, g: number, b: number) => boolean;
}

/** the festival's own governor (shared/festivalFlash.ts): the same rules as the lights lane's */
export const LOCAL_GOVERNOR: GovApi = { FlashGovernor: FestivalFlashGovernor as unknown as GovApi['FlashGovernor'], govChannel: () => flashChannel(), relLum: localLum, isSatRed: localSatRed };
let api: GovApi | undefined;
/** the lights lane's governor module when it is in the build, else the festival's own */
export function governorApi(): GovApi {
  if (api !== undefined) return api;
  api = LOCAL_GOVERNOR;
  try {
    const mods = import.meta.glob('../../../shared/flashGovernor.ts', { eager: true }) as Record<string, Partial<GovApi>>;
    const m = Object.values(mods)[0];
    if (m && typeof m.FlashGovernor === 'function' && typeof m.govChannel === 'function' && typeof m.relLum === 'function' && typeof m.isSatRed === 'function') api = m as GovApi;
  } catch { /* the festival's own */ }
  return api;
}
/** tests: use this module (null = the festival's own) */
export function setGovernorApi(a: GovApi | null) { api = a ?? LOCAL_GOVERNOR; }

/** the part of a governor channel (both governors' channels) the red-flip detection reads */
interface FlipCh { red: boolean; init: boolean; win?: number }
/** what an output keeps between frames: its governor channels + the colour last shown (a held red change keeps it) */
export interface GovOwner { gch?: Chan; sch?: Chan; gr?: number; gg?: number; gb?: number; sm?: number; sa?: number; sb?: number; sw?: number; sd?: number; pk?: number }

/** a light's ramp from one stage window to the value allowed there (ms): windows sit on the beat grid, so on-beat changes
 *  start on their beat */
const SEG_RAMP = 150;

export class FestivalGov {
  private gov: GovLike | null = null;
  private own = false;
  /** the STAGE gate: every festival output first passes a governor of its own whose windows are ≥ 333 ms apart (≤ 3 a
   *  second, on the festival's beat grid). The room governor bounds each light; but a sum of lights can still turn
   *  between windows (one column stops rising while another keeps decaying: a pulse per window), so with windows up
   *  to 5.5 a second a stage of alternating lights could pulse 3.8 times a second at 230 BPM. Turning only in these
   *  windows, the summed stage pulses at most once per window = ≤ 3 flashes a second. */
  private stage = new FestivalFlashGovernor(334, true);
  private dtMs = 16; private lastMs = NaN; private safeNow = true;
  // the stage's segments: with Safe flashes ON every output changes only at a stage window: a 150 ms ramp to what the
  // governors allow at that window, then flat until the next. Every light is monotone between windows and they all
  // ramp together, so the drawn picture - any region of it, however many lights add up there - only turns at window
  // frames: <= 3 a second. (Each output alone
  // was already bounded; their sums were not: one decaying while another rose could wiggle a region between windows.)
  private seg = { id: -1, t0: 0, len: 334 };
  private readonly a: GovApi;
  /** the sRGB colour an out() call settled on (the wanted one unless a red change was held) */
  r = 0; g = 0; b = 0;
  constructor(a: GovApi | null = governorApi()) { this.a = a ?? LOCAL_GOVERNOR; }
  /** the lights lane's governor (false = the festival's own, same rules) */
  get lights() { return this.a !== LOCAL_GOVERNOR; }

  get active() { return !!this.gov; }
  get shared() { return !!this.gov && !this.own; }
  get stats() { return this.gov ? { shared: !this.own, safe: this.gov.safe, shown: this.gov.shown, held: this.gov.held, overAt: this.gov.overAt } : null; }

  /** use the room light show's governor when it has one, else a governor of our own (the same rules) */
  bind(rt: Pick<SceneRuntime, 'lights'> | null) {
    const g = (rt?.lights as unknown as { gov?: Partial<GovLike> } | undefined)?.gov;
    if (g && typeof g.step === 'function' && typeof g.frame === 'function') { this.gov = g as GovLike; this.own = false; }
    else { this.gov = new this.a.FlashGovernor(); this.own = true; }
  }
  unbind() { this.gov = null; }

  /** once a frame, before any out(). Our own governor: its windows on the festival's beat grid at the festival's
   *  time (`nowMs`: a test page's virtual clock too). The room's governor is driven by the light show at the wall
   *  clock; if the light show isn't driving it (no room lights, not attached) we drive it, on the wall clock.
   *  Grid as in the room: half beats up to 166 BPM, beats above, every 2 beats above 333; no grid: 180 ms slots. */
  frame(nowMs: number, beat: number, bpm: number, locked: boolean, safe: boolean) {
    const g = this.gov;
    if (!g) return;
    this.dtMs = Number.isFinite(this.lastMs) ? Math.min(250, Math.max(0, nowMs - this.lastMs)) : 16; this.lastMs = nowMs; this.safeNow = safe; this.segNow = nowMs;
    let t = nowMs, drive = true;
    if (!this.own) {
      const wall = epochNow(), seen = (g as unknown as { now?: number }).now;
      if (typeof seen === 'number' && Math.abs(wall - seen) < 300) drive = false;  // the light show drove it this frame
      t = wall;
    } else g.safe = safe;
    if (drive) {
      if (locked && bpm >= 40 && Number.isFinite(beat)) {
        const P = 60000 / bpm, n = P >= 360 ? 2 : P >= 180 ? 1 : 0.5, x = beat * n, slot = Math.floor(x);
        g.frame(t, slot, (x - slot) * P / n);
      } else g.frame(t);
    }
    // the stage gate: windows on the beat grid, never closer than 334 ms, and only on a frame where the ROOM's governor
    // has a window open too - so every turn the stage draws falls on a room window, and the room (its own lights + this
    // stage) never turns more than the room governor allows, whichever clock each runs on
    const rw = (g as unknown as { winId?: number }).winId;
    // (only when both run on the same clock: a test page stepping virtual time far from the wall clock has no shared
    // windows to wait for - its stage windows would never open)
    const roomOpen = typeof rw !== 'number' || rw >= 0 || Math.abs(nowMs - epochNow()) > 1000;
    this.stage.safe = safe;
    if (locked && bpm >= 40 && Number.isFinite(beat)) {
      const P = 60000 / bpm, n = P >= 666 ? 2 : P >= 333 ? 1 : P >= 166 ? 0.5 : 0.25, x = beat * n, slot = Math.floor(x);
      this.stage.frame(nowMs, slot, (x - slot) * P / n, roomOpen);
    } else this.stage.frame(nowMs, Math.floor(nowMs / 340), nowMs - Math.floor(nowMs / 340) * 340, roomOpen);
    const w = this.stage.openWindow;
    if (w >= 0 && w !== this.seg.id) { const gap = nowMs - this.seg.t0; this.seg = { id: w, t0: nowMs, len: Math.max(334, Math.min(1200, Number.isFinite(gap) && gap > 0 ? gap : 334)) }; }
  }

  /** The level an output may show: wanted level `lv` of sRGB colour (r, g, b) (0..1, as the looks give it). Sets
   *  this.r/g/b to the sRGB colour to draw (the previous one when a change to / from saturated red was held). Luminance
   *  and the red test use the linear colour. No governor: everything as wanted. */
  out(o: GovOwner, lv: number, r: number, g: number, b: number): number {
    const gov = this.gov, a = this.a;
    this.r = r; this.g = g; this.b = b;
    if (!gov) return lv;
    const lr = lin(r), lg = lin(g), lb = lin(b);
    const lum = a.relLum(lr, lg, lb);
    o.gch ??= a.govChannel(); o.sch ??= flashChannel();
    const red = lum > 1e-6 && lv > 1e-4 && a.isSatRed(lr, lg, lb);
    // WCAG's red flash rule is far stricter than its luminance rule (a change of (R - G - B) x 320 > 20: ~6 % of a
    // full red): a saturated-red output with Safe flashes ON is low-passed (150 ms), so the small swings the governors
    // leave free (a held chase's 10 %, the 5 % tolerance) never add up to a red flash on a region of beams
    if (red && this.safeNow) { o.sm = o.sm === undefined ? lv : o.sm + (lv - o.sm) * (1 - Math.exp(-this.dtMs / 150)); lv = o.sm; } else o.sm = lv;
    // the room's governor first, the stage gate LAST: what is drawn only turns on a stage window (two gates in a row
    // with their own windows let an output turn at either one's windows - a turn the first held, let go by the second)
    const L = Math.max(0, lv) * lum;
    // A colour change into / out of saturated red and the luminance that comes with it are ONE change: when a window lets
    // the colour through, the luminance goes through at the same window. (Each governor turns a channel once per window:
    // the colour took the token, so the luminance stayed where the OLD colour had it - a red after a gold drawn at 4-5x
    // its level (the peak hold kept it there), exactly the content WCAG's red rule counts; found by the drawn red-flash
    // count on a house-look drop.) Only a red flip THIS step admitted - the channel's own red flag changed, so its window
    // is the open one - starts the channel over at the new state, keeping that window (no second turn in it). A flip a
    // black frame already took (on its window), or none at all, changes nothing: the luminance stays governed.
    const gch = o.gch as FlipCh, r0 = gch.red, i0 = gch.init;
    let pre = gov.step(o.gch, L, red);
    if (this.safeNow && i0 && gch.red !== r0) pre = this.restart(o, 'gch', () => gov.step(o.gch!, L, red));
    const roomRed = gov.holdRed ? !red : red;
    const sch = o.sch as FlipCh, s0 = sch.red, si0 = sch.init;
    let y = this.stage.step(o.sch, pre, roomRed);
    if (this.safeNow && si0 && sch.red !== s0) {
      y = this.restart(o, 'sch', () => this.stage.step(o.sch!, pre, roomRed));
      // (and the light RAMPS there with every other light - the stage's sums stay straight lines between windows: from
      //  what was drawn to the new value; the peak starts over, so the old colour's peak can't come back)
      o.sa = o.sd ?? y; o.sb = y; o.pk = y; o.sw = this.seg.id;
    }
    if (this.safeNow) {
      // (peak hold: a segment goes to the highest value the governors allowed since the last window - a hit shorter than
      // a window interval (a chase step, a flame) still shows, on the next window, instead of being lost)
      if (o.sw === undefined || o.sd === undefined) { o.sa = y; o.sb = y; o.sw = this.seg.id; o.pk = y; }
      else if (o.sw !== this.seg.id) { o.sa = o.sd; o.sb = Math.max(y, o.pk ?? y); o.sw = this.seg.id; o.pk = y; }   // (a new segment starts where the drawn light is)
      else o.pk = Math.max(o.pk ?? y, y);
      // (inside a segment the light holds its course: a ramp to what the governors allowed at the window, then flat)
      y = this.segAt(o);
    }
    o.sd = y;
    const holdRed = gov.holdRed || this.stage.holdRed;
    if ((holdRed || lum <= 1e-6) && o.gr !== undefined) { this.r = o.gr; this.g = o.gg!; this.b = o.gb!; }
    else { o.gr = r; o.gg = g; o.gb = b; }
    const l2 = this.r === r && this.g === g && this.b === b ? lum : a.relLum(lin(this.r), lin(this.g), lin(this.b));
    return l2 > 1e-6 ? y / l2 : 0;
  }
  /** a channel started over at its new state (init: it takes the level as it is), keeping the window it just used */
  private restart(o: GovOwner, k: 'gch' | 'sch', step: () => number): number {
    const w = (o[k] as { win?: number }).win ?? -1;
    o[k] = k === 'gch' ? this.a.govChannel() : flashChannel();
    const y = step();
    (o[k] as { win: number }).win = w;
    return y;
  }
  private segNow = 0;
  // (the ramp moves on the window frame itself: a fixed one-frame lead, so the ramp stays monotone in time)
  private segAt(o: GovOwner) { const u = Math.min(1, Math.max(0, (this.segNow - this.seg.t0 + 16) / SEG_RAMP)); return o.sa! + (o.sb! - o.sa!) * u; }
  /** relative luminance of the colour the last out() settled on (tests / meters) */
  lum() { return this.a.relLum(lin(this.r), lin(this.g), lin(this.b)); }
  /** a white / single-channel output (strobes, flashes, flame heights): its own level is the luminance */
  level(o: GovOwner, lv: number): number { return this.out(o, lv, 1, 1, 1); }
}

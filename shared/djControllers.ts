// DJ controllers + MIDI clock, LISTEN-ONLY: what the DJ's hands do (crossfader, channel faders, EQ, filter, play / cue,
// pads, FX on, jog) becomes ControllerState + ControllerEvents for the show (shared/musicClock.ts). We read the
// controller → computer messages only; we never send anything to the controller (no LEDs, no init / dump SysEx).
//
// Maps are written from the manufacturers' published MIDI lists (Hercules) and the numbers in public community mappings
// (Mixxx, the DDJ-FLX6 and Prime 4 community maps) — facts only, no code copied. Unverified numbers are marked.
// A controller we don't know still works generically (any pad / button press and knob move becomes an event).
// Pure module: used by the helper (native MIDI) and the studio (Web MIDI forwarding); tests: tools/djsync_unit.ts.
import { GridTracker, type ControllerEvent, type ControllerState } from './musicClock.ts';

type Ctl = 'xfade' | 'fader' | 'eq' | 'filter' | 'play' | 'cue' | 'pad' | 'fx' | 'jogTouch' | 'jog' | 'jogAbs' | 'sync' | 'load';
export interface MapEntry {
  /** Status byte: message type | channel (0-based), e.g. 0xB6 = CC on channel 7, 0x97 = note on channel 8. */
  st: number;
  /** Note / CC number. */
  d1: number;
  ctl: Ctl;
  deck: number;
  /** EQ band (0 hi, 1 mid, 2 lo), pad number (0-7), FX unit. */
  i?: number;
  /** 14-bit: MSB on d1, LSB on d1 + 0x20 (or on `lsb`). */
  hi?: boolean;
  lsb?: number;
  /** Relative encoder: 'c64' = 64 is centre, 'tc' = two's complement (1..63 = +, 65..127 = −). */
  rel?: 'c64' | 'tc';
}
export interface ControllerMap { id: string; name: string; match: RegExp; decks: number; entries: MapEntry[]; note?: string }

const CC = 0xb0, NOTE = 0x90;
const range = (a: number, n: number) => Array.from({ length: n }, (_, i) => a + i);

/** Pioneer DDJ layout shared by the FLX4 / 400 / FLX6 / SB3 (deck n on channel n − 1, mixer on channel 7). */
function pioneer(decks: number, padCh: number[], filterLsb: boolean, fxUnits: number[], jogCcs: number[], touch: number[]): MapEntry[] {
  const e: MapEntry[] = [{ st: CC | 6, d1: 0x1f, ctl: 'xfade', deck: 0, hi: true }];
  for (let d = 1; d <= decks; d++) {
    const ch = d - 1;
    e.push({ st: CC | ch, d1: 0x13, ctl: 'fader', deck: d, hi: true },
      { st: CC | ch, d1: 0x07, ctl: 'eq', deck: d, i: 0, hi: true }, { st: CC | ch, d1: 0x0b, ctl: 'eq', deck: d, i: 1, hi: true }, { st: CC | ch, d1: 0x0f, ctl: 'eq', deck: d, i: 2, hi: true },
      { st: CC | 6, d1: 0x16 + d, ctl: 'filter', deck: d, hi: filterLsb || d <= 2 },
      { st: NOTE | ch, d1: 0x0b, ctl: 'play', deck: d }, { st: NOTE | ch, d1: 0x0c, ctl: 'cue', deck: d });
    for (const t of touch) e.push({ st: NOTE | ch, d1: t, ctl: 'jogTouch', deck: d });
    for (const j of jogCcs) e.push({ st: CC | ch, d1: j, ctl: 'jog', deck: d, rel: 'c64' });
    const pc = padCh[d - 1];
    if (pc !== undefined) for (const base of [0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70]) for (const p of range(0, 8)) e.push({ st: NOTE | pc, d1: base + p, ctl: 'pad', deck: d, i: p });
  }
  fxUnits.forEach((ch, u) => { for (const n of [0x47, 0x48, 0x49]) e.push({ st: NOTE | ch, d1: n, ctl: 'fx', deck: 0, i: u }); });
  return e;
}

function numark(decks: number): MapEntry[] {
  const e: MapEntry[] = [{ st: CC | 15, d1: 0x08, ctl: 'xfade', deck: 0 }, { st: CC | 8, d1: 0x03, ctl: 'fx', deck: 0, i: 0 }, { st: CC | 9, d1: 0x03, ctl: 'fx', deck: 0, i: 1 }];
  for (let d = 1; d <= decks; d++) {
    const ch = d - 1;
    e.push({ st: CC | ch, d1: 0x1c, ctl: 'fader', deck: d }, { st: CC | ch, d1: 0x17, ctl: 'eq', deck: d, i: 0 }, { st: CC | ch, d1: 0x18, ctl: 'eq', deck: d, i: 1 }, { st: CC | ch, d1: 0x19, ctl: 'eq', deck: d, i: 2 },
      { st: CC | ch, d1: 0x1a, ctl: 'filter', deck: d }, { st: NOTE | ch, d1: 0x00, ctl: 'play', deck: d }, { st: NOTE | ch, d1: 0x01, ctl: 'cue', deck: d },
      { st: NOTE | ch, d1: 0x06, ctl: 'jogTouch', deck: d }, { st: CC | ch, d1: 0x06, ctl: 'jog', deck: d, rel: 'tc' });
    for (const p of range(0, 8)) e.push({ st: NOTE | (4 + ch), d1: 0x14 + p, ctl: 'pad', deck: d, i: p }, { st: NOTE | (4 + ch), d1: 0x1c + p, ctl: 'pad', deck: d, i: p });
  }
  return e;
}

function hercules(pads: number, mid: boolean, fx: MapEntry[]): MapEntry[] {
  const e: MapEntry[] = [{ st: CC | 0, d1: 0x00, ctl: 'xfade', deck: 0, hi: true }, ...fx];
  for (const [d, ch, sh, padCh] of [[1, 1, 4, 6], [2, 2, 5, 7]] as const) {
    for (const c of [ch, sh]) {   // (analog controls move to the shift channel while Shift is held)
      e.push({ st: CC | c, d1: 0x00, ctl: 'fader', deck: d, hi: true }, { st: CC | c, d1: 0x01, ctl: 'filter', deck: d, hi: true },
        { st: CC | c, d1: 0x04, ctl: 'eq', deck: d, i: 0, hi: true }, { st: CC | c, d1: 0x02, ctl: 'eq', deck: d, i: 2, hi: true });
      if (mid) e.push({ st: CC | c, d1: 0x03, ctl: 'eq', deck: d, i: 1, hi: true });
      e.push({ st: CC | c, d1: 0x09, ctl: 'jog', deck: d, rel: 'tc' }, { st: CC | c, d1: 0x0a, ctl: 'jog', deck: d, rel: 'tc' });
    }
    e.push({ st: NOTE | ch, d1: 0x07, ctl: 'play', deck: d }, { st: NOTE | ch, d1: 0x06, ctl: 'cue', deck: d }, { st: NOTE | ch, d1: 0x08, ctl: 'jogTouch', deck: d });
    for (let mode = 0; mode < 8; mode++) for (let p = 0; p < pads; p++) for (const shift of [0, 8]) e.push({ st: NOTE | padCh, d1: mode * 16 + shift + p, ctl: 'pad', deck: d, i: p });
  }
  return e;
}

/** Known controllers, matched on the MIDI port name. */
export const CONTROLLER_MAPS: ControllerMap[] = [
  { id: 'ddj-flx4', name: 'Pioneer DDJ-FLX4', match: /DDJ-?FLX4/i, decks: 2, entries: pioneer(2, [7, 9], true, [4, 5], [0x21, 0x22, 0x23, 0x29], [0x36, 0x67]) },
  { id: 'ddj-400', name: 'Pioneer DDJ-400', match: /DDJ-?400/i, decks: 2, entries: pioneer(2, [7, 9], true, [4], [0x21, 0x22, 0x23, 0x29], [0x36, 0x67]) },
  { id: 'ddj-flx6', name: 'Pioneer DDJ-FLX6', match: /DDJ-?FLX6/i, decks: 4, entries: pioneer(4, [7, 9, 11, 13], false, [4, 5], [0x21, 0x22, 0x23], [0x36]), note: 'From a community mapping.' },
  { id: 'ddj-sb3', name: 'Pioneer DDJ-SB3', match: /DDJ-?SB3/i, decks: 4, entries: pioneer(4, [7, 8, 9, 10], true, [4, 5], [0x21, 0x22, 0x23], [0x36, 0x35]) },
  { id: 'prime-4', name: 'Denon DJ Prime 4', match: /PRIME\s*4/i, decks: 2, note: 'Computer (MIDI) mode, from a community mapping; left deck = 1, right deck = 2.', entries: [
    { st: CC | 15, d1: 0x0e, ctl: 'xfade', deck: 0 },
    ...[1, 2, 3, 4].flatMap((d): MapEntry[] => [{ st: CC | (d - 1), d1: 0x0e, ctl: 'fader', deck: d }, { st: CC | (d - 1), d1: 0x04, ctl: 'eq', deck: d, i: 0 }, { st: CC | (d - 1), d1: 0x06, ctl: 'eq', deck: d, i: 1 }, { st: CC | (d - 1), d1: 0x08, ctl: 'eq', deck: d, i: 2 }, { st: CC | (d - 1), d1: 0x0b, ctl: 'filter', deck: d }]),
    ...[[1, 4], [2, 5]].flatMap(([d, ch]): MapEntry[] => [{ st: NOTE | ch, d1: 0x0a, ctl: 'play', deck: d }, { st: NOTE | ch, d1: 0x09, ctl: 'cue', deck: d }, { st: NOTE | ch, d1: 0x21, ctl: 'jogTouch', deck: d },
      { st: CC | ch, d1: 0x37, ctl: 'jogAbs', deck: d, hi: true, lsb: 0x4d }, ...range(0, 8).map((p): MapEntry => ({ st: NOTE | ch, d1: 0x0f + p, ctl: 'pad', deck: d, i: p }))]),
    ...[0x06, 0x07, 0x08].flatMap((n): MapEntry[] => [{ st: NOTE | 6, d1: n, ctl: 'fx', deck: 0, i: 0 }, { st: NOTE | 7, d1: n, ctl: 'fx', deck: 0, i: 1 }]),
  ] },
  { id: 'mixtrack-platinum-fx', name: 'Numark Mixtrack Platinum FX', match: /Mixtrack\s*Platinum\s*FX/i, decks: 4, entries: numark(4) },
  { id: 'mixtrack-pro-fx', name: 'Numark Mixtrack Pro FX', match: /Mixtrack\s*Pro\s*FX/i, decks: 2, entries: numark(2) },
  { id: 'inpulse-500', name: 'Hercules DJControl Inpulse 500', match: /Inpulse\s*500/i, decks: 2, entries: hercules(8, true, range(0x14, 4).map((n, i): MapEntry => ({ st: NOTE | 0, d1: n, ctl: 'fx', deck: 0, i }))) },
  { id: 'inpulse-300', name: 'Hercules DJControl Inpulse 300', match: /Inpulse\s*300/i, decks: 2, entries: hercules(8, true, [{ st: NOTE | 1, d1: 0x00, ctl: 'fx', deck: 1, i: 0 }, { st: NOTE | 2, d1: 0x00, ctl: 'fx', deck: 2, i: 1 }]) },
  { id: 'inpulse-200', name: 'Hercules DJControl Inpulse 200', match: /Inpulse\s*200/i, decks: 2, entries: hercules(4, false, []) },
];
/** Controllers we know of but can't read over MIDI (plain words for the panel). */
export const UNSUPPORTED_CONTROLLERS: { match: RegExp; says: string }[] = [
  { match: /Kontrol\s*S4/i, says: 'Traktor Kontrol S4 MK3 talks to Traktor over HID, not MIDI, so VTube Pro can’t read its knobs. Ableton Link or the music input still keep the show in time.' },
  { match: /Kontrol\s*S2/i, says: 'Traktor Kontrol S2 MK3 uses HID unless you switch it to MIDI mode (hold the left FLX button while plugging it in). Its MIDI numbers aren’t published, so it reads as a generic controller.' },
  { match: /SC\s*Live|PRIME\s*2|PRIME\s*GO/i, says: 'Denon doesn’t publish this unit’s MIDI map; it reads as a generic controller. StageLinQ (network cable) gives the full deck data.' },
];
export function mapFor(portName: string): ControllerMap | null { return CONTROLLER_MAPS.find((m) => m.match.test(portName)) ?? null; }
/** Port names that are not controllers (synths' clock outs, loopback ports, our own): no "controller" row for them. */
export const isVirtualPort = (n: string) => /loopMIDI|virtual|IAC|Microsoft GS|Midi Through|rtpMIDI|Network Session/i.test(n);

const JOG_TAU = 300;
interface Throttle { at: number; v: number }

/** Reads one controller's MIDI: keeps its state, returns events. Feed raw messages (status, data1, data2). */
export class DjControllerReader {
  readonly map: ControllerMap | null;
  readonly state: ControllerState;
  private index = new Map<number, MapEntry>();
  private msb = new Map<number, number>();
  private jogAbs = new Map<number, number>();
  private scratch = 0;
  private scratchAt = 0;
  private throttle = new Map<string, Throttle>();
  private jogAcc = new Map<number, { v: number; at: number }>();
  lastAt = 0;
  messages = 0;
  constructor(readonly port: string, map: ControllerMap | null = mapFor(port)) {
    this.map = map;
    this.state = { device: map?.name ?? port.slice(0, 60) };
    for (const e of map?.entries ?? []) {
      this.index.set((e.st << 8) | e.d1, e);
      if (e.hi) this.index.set(((e.st << 8) | (e.lsb ?? e.d1 + 0x20)) | 0x10000, e);
    }
  }
  get known() { return !!this.map; }

  /** Current state (the jog activity decays). */
  snapshot(now: number): ControllerState {
    const sc = this.scratch * Math.exp(-(now - this.scratchAt) / JOG_TAU);
    return { ...this.state, scratch: +Math.min(1, sc).toFixed(3) };
  }

  feed(st: number, d1: number, d2: number, t: number): ControllerEvent[] {
    this.messages++; this.lastAt = t;
    const type = st & 0xf0;
    if (type !== 0x80 && type !== 0x90 && type !== 0xb0) return [];
    const isNote = type === 0x80 || type === 0x90;
    const noteOn = type === 0x90 && d2 > 0;
    const key = ((isNote ? NOTE | (st & 15) : st) << 8) | d1;
    let e = this.index.get(key);
    let lsb = false;
    if (!e && type === 0xb0) { e = this.index.get(key | 0x10000); lsb = !!e; }
    if (!e) return this.generic(st, d1, d2, t, isNote, noteOn);
    const out: ControllerEvent[] = [];
    const abs = (): number | null => {
      if (!e!.hi) return d2 / 127;
      const id = (e!.st << 8) | e!.d1;
      if (lsb) { const m = this.msb.get(id); return m === undefined ? null : ((m << 7) | d2) / 16383; }
      this.msb.set(id, d2); return d2 / 127;
    };
    const di = e.deck - 1;
    const arr = <T>(a: T[] | undefined, fill: T, n = Math.max(this.map?.decks ?? 2, e!.deck)) => { const x = a ?? []; while (x.length < n) x.push(fill); return x; };
    const move = (kind: ControllerEvent['kind'], v: number, i?: number) => {
      // knob / fader events: at most one per 40 ms per control (the state is always exact)
      const k = `${kind}:${e!.deck}:${i ?? ''}`, th = this.throttle.get(k);
      if (th && t - th.at < 40 && Math.abs(th.v - v) < 0.2) return;
      this.throttle.set(k, { at: t, v });
      out.push({ t, kind, deck: e!.deck, ...(i !== undefined ? { i } : {}), v: +v.toFixed(4) });
    };
    switch (e.ctl) {
      case 'xfade': { const v = abs(); if (v === null) break; this.state.xfade = v * 2 - 1; move('xfade', this.state.xfade); break; }
      case 'fader': { const v = abs(); if (v === null) break; this.state.fader = arr(this.state.fader, 1); this.state.fader[di] = v; move('fader', v); break; }
      case 'filter': { const v = abs(); if (v === null) break; this.state.filter = arr(this.state.filter, 0.5); this.state.filter[di] = v; move('filter', v); break; }
      case 'eq': { const v = abs(); if (v === null) break; this.state.eq = arr(this.state.eq, [0.5, 0.5, 0.5] as [number, number, number]); this.state.eq[di] = [...this.state.eq[di]] as [number, number, number]; this.state.eq[di][e.i ?? 0] = v; move('eq', v, e.i); break; }
      case 'play': if (noteOn) { this.state.playing = arr(this.state.playing, false); this.state.playing[di] = !this.state.playing[di]; out.push({ t, kind: 'play', deck: e.deck, v: this.state.playing[di] ? 1 : 0 }); } break;
      case 'cue': if (noteOn) out.push({ t, kind: 'cue', deck: e.deck, v: 1 }); break;
      case 'sync': if (noteOn) out.push({ t, kind: 'sync', deck: e.deck, v: 1 }); break;
      case 'load': if (noteOn) out.push({ t, kind: 'load', deck: e.deck, v: 1 }); break;
      case 'pad': if (noteOn) out.push({ t, kind: 'pad', deck: e.deck, i: e.i ?? 0, v: d2 / 127 }); break;
      case 'fx': {
        const press = isNote ? noteOn : d2 > 63;
        if (isNote && !press) break;
        const u = e.i ?? 0;
        this.state.fx = arr(this.state.fx, false, Math.max(2, u + 1));
        this.state.fx[u] = isNote ? !this.state.fx[u] : press;   // (a note toggles; Numark's paddle is a held CC)
        out.push({ t, kind: 'fx', deck: e.deck, i: u, v: this.state.fx[u] ? 1 : 0 });
        break;
      }
      case 'jogTouch': if (noteOn) this.bumpScratch(0.5, t); break;
      case 'jog': { const dlt = e.rel === 'c64' ? d2 - 64 : d2 < 64 ? d2 : d2 - 128; this.jog(e.deck, dlt, t, out); break; }
      case 'jogAbs': {
        const v = abs(); if (v === null || !lsb) break;
        const raw = Math.round(v * 16383), id = e.deck, prev = this.jogAbs.get(id);
        this.jogAbs.set(id, raw);
        if (prev === undefined) break;
        let dlt = raw - prev; if (dlt > 8192) dlt -= 16384; if (dlt < -8192) dlt += 16384;
        this.jog(e.deck, dlt / 16, t, out);
        break;
      }
    }
    return out;
  }

  private bumpScratch(v: number, t: number) {
    const cur = this.scratch * Math.exp(-(t - this.scratchAt) / JOG_TAU);
    this.scratch = Math.min(1.5, cur + v); this.scratchAt = t;
  }
  private jog(deck: number, dlt: number, t: number, out: ControllerEvent[]) {
    if (!dlt) return;
    this.bumpScratch(Math.min(0.4, Math.abs(dlt) / 24), t);
    const a = this.jogAcc.get(deck) ?? { v: 0, at: -Infinity };   // (the first turn goes out at once, then ≤ 1 event / 50 ms)
    a.v += dlt;
    if (t - a.at >= 50) { out.push({ t, kind: 'jog', deck, v: Math.max(-128, Math.min(128, a.v)) }); a.v = 0; a.at = t; }
    this.jogAcc.set(deck, a);
  }
  /** An unknown control: buttons → 'button' events (i = note), knobs → 'button' with the value (throttled). */
  private generic(st: number, d1: number, d2: number, t: number, isNote: boolean, noteOn: boolean): ControllerEvent[] {
    if (isNote) return noteOn ? [{ t, kind: 'button', deck: 0, i: d1 & 63, v: 1 }] : [];
    const k = `g:${st}:${d1}`, th = this.throttle.get(k);
    if (th && t - th.at < 80) return [];
    this.throttle.set(k, { at: t, v: d2 });
    return [{ t, kind: 'button', deck: 0, i: d1 & 63, v: +(d2 / 127).toFixed(3) }];
  }
}

// ---------------------------------------------------------------- MIDI clock (24 ticks per beat)
/** MIDI clock in: tempo from the tick times (least squares), beats from the tick count; Start / Song Position give the
 *  bar (beat 0 = a downbeat), Stop stops. Traktor, Mixxx (script), many DJM mixers and SoundSwitch send it. */
export class MidiClockTracker {
  private grid = new GridTracker(3000, 64);
  private ticks = 0;
  private lastTickAt = -Infinity;
  private stopped = false;
  private anchored = false;
  private sawTransport = false;
  ticksSeen = 0;
  /** Feed one realtime byte (0xF8 tick, 0xFA start, 0xFB continue, 0xFC stop) or a song position (0xF2 + 14-bit). */
  feed(st: number, t: number, spp?: number) {
    if (st === 0xfa) { this.ticks = 0; this.stopped = false; this.anchored = true; this.sawTransport = true; this.grid.reset(); return; }
    if (st === 0xfb) { this.stopped = false; this.sawTransport = true; return; }
    if (st === 0xfc) { this.stopped = true; this.sawTransport = true; return; }
    if (st === 0xf2 && spp !== undefined) { this.ticks = spp * 6; this.anchored = true; this.grid.reset(); return; }
    if (st !== 0xf8) return;
    this.ticksSeen++;
    // (a tick is "this many 24ths of a beat"; sample every 3rd tick into the grid)
    if (this.ticks % 3 === 0) this.grid.observe(t, this.ticks / 24);
    this.ticks++;
    this.lastTickAt = t;
  }
  get ready() { return this.grid.ready && this.grid.bpm > 20; }
  playing(now: number) { return now - this.lastTickAt < 400 && !this.stopped; }
  /** Grid for the arbiter: { at, beat, bpm, bar (undefined = we never saw Start / Song Position) }. */
  sample(now: number) {
    const g = this.grid;
    return { at: g.at, beat: g.beat, bpm: +g.bpm.toFixed(3), bar: this.anchored ? ((Math.floor(g.beat) % 4) + 4) % 4 : undefined, playing: this.playing(now), playKnown: this.sawTransport };
  }
}

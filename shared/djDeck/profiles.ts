// DJ decks: controller profiles — which MIDI message is which PHYSICAL control, so the virtual decks and the
// performer's hands copy the DJ's controller (docs/DJ_SYNC.md "DJ decks"). LISTEN-ONLY: these tables describe what the
// controller sends to the computer; nothing is ever sent to a controller (no LEDs, no SysEx, no init messages).
//
// Sources (facts only, no code copied):
//  - DDJ-GRV6: the manufacturer's published "List of MIDI messages" (DDJ-GRV6_MIDI_Message_List_E1.pdf, © 2024,
//    sha256 211c4221…ddb3e). Every entry is marked src 'doc'. What the document doesn't give is marked 'inferred'
//    (jog resolution, which way the release lever's plain message goes, the mixer's channel order on the panel).
//  - The DDJ-FLX4 / 400 / FLX6 / SB3 / 200 / REV1 entries follow the same Pioneer DDJ "rekordbox mode" scheme the
//    GRV6 document confirms (deck n on channel n, mixer on channel 7, 14-bit MSB + LSB = MSB + 0x20, pads on their own
//    channels, mode × 16 + pad). FLX4 / 400 / FLX6 / SB3 numbers agree with the public community mappings already used
//    by shared/djControllers.ts ('community'); DDJ-200 / REV1 are 'inferred' from the family until a capture confirms.
//  - Every other controller in shared/djControllers.ts is converted from there (crossfader, faders, EQ, filter,
//    play / cue, pads, FX, jog); anything else falls back to "Teach my controller".
// Pure module (helper + studio + tests: tools/djdeck_unit.ts).
import { CONTROLLER_MAPS, type ControllerMap } from '../djControllers.ts';
import type { LayoutId } from './layout.ts';

export type DeckCtl =
  // deck controls (deck = logical deck 1-4)
  | 'play' | 'cue' | 'shift' | 'sync' | 'ksync' | 'mt' | 'slip' | 'quant' | 'loopIn' | 'loopOut' | 'reloop' | 'callPrev' | 'callNext' | 'memory'
  | 'jog' | 'jogTouch' | 'tempo' | 'pad' | 'pm' | 'gain' | 'swap' | 'roll' | 'capture' | 'release' | 'layerBtn' | 'layer'
  // mixer channel controls (deck = channel 1-4)
  | 'fader' | 'trim' | 'eq' | 'color' | 'chCue' | 'load'
  // the rest of the mixer (deck 0)
  | 'xf' | 'master' | 'booth' | 'mcue' | 'browse' | 'browsePress' | 'hpLevel' | 'hpMix' | 'mic' | 'fxLevel' | 'fxOn' | 'fxSel' | 'fxBeat' | 'fxCh' | 'colorOn';
export const DECK_CTLS = new Set<DeckCtl>(['play', 'cue', 'shift', 'sync', 'ksync', 'mt', 'slip', 'quant', 'loopIn', 'loopOut', 'reloop', 'callPrev', 'callNext', 'memory', 'jog', 'jogTouch', 'tempo', 'pad', 'pm', 'gain', 'swap', 'roll', 'capture', 'release', 'layerBtn', 'layer']);
export const CHANNEL_CTLS = new Set<DeckCtl>(['fader', 'trim', 'eq', 'color', 'chCue', 'load']);
/** How the value is read: a button (note on / off or CC > 63), an absolute 7-bit value, the MSB of a 14-bit value
 *  (LSB on `lsb`, default d1 + 0x20), a relative encoder (c64: 65+ = clockwise; tc: two's complement), a selector
 *  position (the message itself means "position i"), or a deck-layer switch (velocity 0x7F = this deck now active). */
export type ValKind = 'btn' | 'abs' | 'hi' | 'c64' | 'tc' | 'sel' | 'layer';
export type EntrySrc = 'doc' | 'community' | 'inferred' | 'learned';
export interface DeckMapEntry {
  /** Status byte with its channel: 0x90 | ch for notes (note-off 0x80 | ch is read as the same key), 0xB0 | ch for CC. */
  st: number;
  d1: number;
  ctl: DeckCtl;
  /** Deck 1-4 (deck controls), channel 1-4 (channel controls), 0 = the rest of the mixer. */
  deck: number;
  /** Pad / EQ band (0 high, 1 mid, 2 low) / drum button / FX beat (0 left, 1 right) / selector position. */
  i?: number;
  v: ValKind;
  lsb?: number;
  /** The SHIFT layer's message of the same physical control. */
  shift?: true;
  /** Jog: which surface turned (top = scratch / vinyl, side = nudge / pitch bend). */
  jog?: 'top' | 'side';
  /** Pad mode (0-7) a pad message belongs to. */
  mode?: number;
  src: EntrySrc;
}
export interface DeckProfile {
  id: string;
  /** Shown to the user ("Reading your DDJ-GRV6"). */
  name: string;
  match: RegExp;
  decks: number;
  /** The virtual rig that matches this controller's layout best. */
  layout: LayoutId;
  /** Relative jog ticks per platter turn. */
  jogTicks: number;
  jogTicksSrc: EntrySrc;
  entries: DeckMapEntry[];
  note?: string;
}

const N = 0x90, CC = 0xb0;
const range = (a: number, n: number) => Array.from({ length: n }, (_, i) => a + i);

// ---------------------------------------------------------------- DDJ-GRV6 (from the manufacturer's MIDI message list)
/** Pad modes in the order the document lists them (note = mode × 16 + pad). */
export const GRV6_PAD_MODES = ['Hot Cue', 'Stems', 'Beat Jump', 'Sampler', 'Keyboard', 'Pad FX', 'Beat Loop', 'Key Shift'] as const;
function grv6(): DeckMapEntry[] {
  const e: DeckMapEntry[] = [];
  const d = (st: number, d1: number, ctl: DeckCtl, deck: number, o: Partial<DeckMapEntry> = {}) => e.push({ st, d1, ctl, deck, v: 'btn', src: 'doc', ...o });
  for (let deck = 1; deck <= 4; deck++) {
    const n = deck - 1;
    // [D1] PLAY/PAUSE 0B (+SHIFT 47) · [D2] CUE 0C (48) · [D3] SHIFT 3F
    d(N | n, 0x0b, 'play', deck); d(N | n, 0x47, 'play', deck, { shift: true });
    d(N | n, 0x0c, 'cue', deck); d(N | n, 0x48, 'cue', deck, { shift: true });
    d(N | n, 0x3f, 'shift', deck);
    // [D4] JOG: platter turned with vinyl on 22 / vinyl off 23 / +SHIFT 29; wheel side 21 / +SHIFT 26 (65+ = clockwise,
    // 63- = counter-clockwise: centre 64); touch 36 (+SHIFT 67)
    d(CC | n, 0x22, 'jog', deck, { v: 'c64', jog: 'top' }); d(CC | n, 0x23, 'jog', deck, { v: 'c64', jog: 'top' });
    d(CC | n, 0x29, 'jog', deck, { v: 'c64', jog: 'top', shift: true });
    d(CC | n, 0x21, 'jog', deck, { v: 'c64', jog: 'side' }); d(CC | n, 0x26, 'jog', deck, { v: 'c64', jog: 'side', shift: true });
    d(N | n, 0x36, 'jogTouch', deck); d(N | n, 0x67, 'jogTouch', deck, { shift: true });
    // [D5] SLIP 40 (17) · [D6] QUANTIZE 35 (68) · [D7] IN / 4 BEAT 10 (+SHIFT 4C, long press 14) · [D8] OUT 11 (77)
    // [D9] RELOOP / EXIT 4D (50) · [D10] CUE/LOOP CALL ◀ 51 (61) · [D11] ▶ 53 (62) · [D12] MEMORY 3D (3E)
    d(N | n, 0x40, 'slip', deck); d(N | n, 0x17, 'slip', deck, { shift: true });
    d(N | n, 0x35, 'quant', deck); d(N | n, 0x68, 'quant', deck, { shift: true });
    d(N | n, 0x10, 'loopIn', deck); d(N | n, 0x4c, 'loopIn', deck, { shift: true }); d(N | n, 0x14, 'loopIn', deck);
    d(N | n, 0x11, 'loopOut', deck); d(N | n, 0x77, 'loopOut', deck, { shift: true });
    d(N | n, 0x4d, 'reloop', deck); d(N | n, 0x50, 'reloop', deck, { shift: true });
    d(N | n, 0x51, 'callPrev', deck); d(N | n, 0x61, 'callPrev', deck, { shift: true });
    d(N | n, 0x53, 'callNext', deck); d(N | n, 0x62, 'callNext', deck, { shift: true });
    d(N | n, 0x3d, 'memory', deck); d(N | n, 0x3e, 'memory', deck, { shift: true });
    // [D13-D16] DECK buttons: the button 72 (+SHIFT 73) on its own deck's channel, plus 3C = 7F "this deck's control on"
    // (and 3C = 00 on the other deck of that side)
    d(N | n, 0x72, 'layerBtn', deck); d(N | n, 0x73, 'layerBtn', deck, { shift: true });
    d(N | n, 0x3c, 'layer', deck, { v: 'layer' });
    // [D17] MASTER TEMPO 1A (60) · [D18] TEMPO 00 MSB / 20 LSB (+SHIFT 05 / 25): "−" side = min, "+" side = max
    // [D19] BEAT SYNC 58 (5C) · [D20] KEY SYNC 65 (64)
    d(N | n, 0x1a, 'mt', deck); d(N | n, 0x60, 'mt', deck, { shift: true });
    d(CC | n, 0x00, 'tempo', deck, { v: 'hi', lsb: 0x20 }); d(CC | n, 0x05, 'tempo', deck, { v: 'hi', lsb: 0x25, shift: true });
    d(N | n, 0x58, 'sync', deck); d(N | n, 0x5c, 'sync', deck, { shift: true });
    d(N | n, 0x65, 'ksync', deck); d(N | n, 0x64, 'ksync', deck, { shift: true });
    // GROOVE CIRCUIT: [G1] GAIN 12 / 32 · [G2-G5] DRUM SWAP 00-03 (2C-2F) · [G6] CAPTURE 08 (2B)
    // [G7-G10] DRUM ROLL 04-07 (30-33) · [G11] DRUM RELEASE lever: tilt forward / backward 24 (+SHIFT 26 / 27)
    d(CC | n, 0x12, 'gain', deck, { v: 'hi', lsb: 0x32 });
    for (let i = 0; i < 4; i++) {
      d(N | n, 0x00 + i, 'swap', deck, { i }); d(N | n, 0x2c + i, 'swap', deck, { i, shift: true });
      d(N | n, 0x04 + i, 'roll', deck, { i }); d(N | n, 0x30 + i, 'roll', deck, { i, shift: true });
    }
    d(N | n, 0x08, 'capture', deck); d(N | n, 0x2b, 'capture', deck, { shift: true });
    d(N | n, 0x24, 'release', deck);   // (the document gives 24 for both tilts without SHIFT)
    d(N | n, 0x26, 'release', deck, { i: 0, shift: true }); d(N | n, 0x27, 'release', deck, { i: 1, shift: true });
    // PAD MODE buttons [P9] HOT CUE 1B (69) · [P10] STEMS 1E (6B) · [P11] BEAT JUMP 20 (6D) · [P12] SAMPLER 22 (6F, long 79)
    [[0x1b, 0x69], [0x1e, 0x6b], [0x20, 0x6d], [0x22, 0x6f]].forEach(([a, b], i) => { d(N | n, a, 'pm', deck, { i }); d(N | n, b, 'pm', deck, { i, shift: true }); });
    d(N | n, 0x79, 'pm', deck, { i: 3 });
    // [P1-P8] PADS: channel 8/10/12/14 (+SHIFT 9/11/13/15), note = mode × 16 + pad
    const pc = 7 + n * 2;
    for (let mode = 0; mode < 8; mode++) for (let i = 0; i < 8; i++) {
      d(N | pc, mode * 16 + i, 'pad', deck, { i, mode }); d(N | (pc + 1), mode * 16 + i, 'pad', deck, { i, mode, shift: true });
    }
    // MIXER channel n: [M2] CH FADER 13 / 33 (bottom = min) · [M3] TRIM 04 / 24 · [M4-M6] EQ HI 07 / 27, MID 0B / 2B,
    // LOW 0F / 2F · [M7] CH CUE 54 (+SHIFT 39)  (fader-start notes 66 / 5D / 52 are not physical moves: ignored)
    d(CC | n, 0x13, 'fader', deck, { v: 'hi', lsb: 0x33 });
    d(CC | n, 0x04, 'trim', deck, { v: 'hi', lsb: 0x24 });
    d(CC | n, 0x07, 'eq', deck, { v: 'hi', lsb: 0x27, i: 0 }); d(CC | n, 0x0b, 'eq', deck, { v: 'hi', lsb: 0x2b, i: 1 }); d(CC | n, 0x0f, 'eq', deck, { v: 'hi', lsb: 0x2f, i: 2 });
    d(N | n, 0x54, 'chCue', deck); d(N | n, 0x39, 'chCue', deck, { shift: true });
    // [F1] SOUND COLOR FX knob per channel: channel 7, 17-1A / 37-3A · [B6] LOAD 1-4: 46-49 (+SHIFT 58 59 60 61)
    d(CC | 6, 0x17 + n, 'color', deck, { v: 'hi', lsb: 0x37 + n });
    d(N | 6, 0x46 + n, 'load', deck); d(N | 6, [0x58, 0x59, 0x60, 0x61][n], 'load', deck, { shift: true });
  }
  // the rest of the mixer (channel 7): [M1] CROSSFADER 1F / 3F (left = min) · [M8] MASTER 08 / 28 · [M10] BOOTH 09 / 29
  // [M9] MASTER CUE 63 (62) · [M12] PHONES LEVEL 0D / 2D · [M13] PHONES MIX 0C / 2C · [M14] MIC 05 / 25
  // [F2] SOUND COLOR FX ON 00 (08) · [B1] browse turn 40 (+SHIFT 64; 1-30 = clockwise, 127-98 = counter-clockwise),
  // press 41 (42), tilts 38 / 39 / 3A / 3B / 3C / 3D / 2E / 3F
  const g = (st: number, d1: number, ctl: DeckCtl, o: Partial<DeckMapEntry> = {}) => e.push({ st, d1, ctl, deck: 0, v: 'btn', src: 'doc', ...o });
  g(CC | 6, 0x1f, 'xf', { v: 'hi', lsb: 0x3f });
  g(CC | 6, 0x08, 'master', { v: 'hi', lsb: 0x28 }); g(CC | 6, 0x09, 'booth', { v: 'hi', lsb: 0x29 });
  g(N | 6, 0x63, 'mcue'); g(N | 6, 0x62, 'mcue', { shift: true });
  g(CC | 6, 0x0d, 'hpLevel', { v: 'hi', lsb: 0x2d }); g(CC | 6, 0x0c, 'hpMix', { v: 'hi', lsb: 0x2c }); g(CC | 6, 0x05, 'mic', { v: 'hi', lsb: 0x25 });
  g(N | 6, 0x00, 'colorOn'); g(N | 6, 0x08, 'colorOn', { shift: true });
  g(CC | 6, 0x40, 'browse', { v: 'tc' }); g(CC | 6, 0x64, 'browse', { v: 'tc', shift: true });
  g(N | 6, 0x41, 'browsePress'); g(N | 6, 0x42, 'browsePress', { shift: true });
  for (const t of [0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x2e, 0x3f, 0x35, 0x68, 0x65, 0x66, 0x7a, 0x67, 0x36, 0x37]) g(N | 6, t, 'browsePress');
  // BEAT FX (channel 5): [F3] BEAT ◀ 4A (66) · [F4] BEAT ▶ 4B (6B) · [F5] FX SELECT positions 20-2D · [F6] CH SELECT
  // 10 11 12 13 (CH 1-4), 16 (SP), 14 (MST) (+SHIFT 18 19 1A 1B 1E 1C) · [F7] LEVEL/DEPTH 02 / 22 · [F8] ON/OFF 47 (43)
  g(N | 4, 0x4a, 'fxBeat', { i: 0 }); g(N | 4, 0x66, 'fxBeat', { i: 0, shift: true });
  g(N | 4, 0x4b, 'fxBeat', { i: 1 }); g(N | 4, 0x6b, 'fxBeat', { i: 1, shift: true });
  for (let i = 0; i < 14; i++) g(N | 4, 0x20 + i, 'fxSel', { v: 'sel', i });
  [0x10, 0x11, 0x12, 0x13, 0x16, 0x14].forEach((n, i) => { g(N | 4, n, 'fxCh', { v: 'sel', i }); g(N | 4, n + 8, 'fxCh', { v: 'sel', i, shift: true }); });
  g(CC | 4, 0x02, 'fxLevel', { v: 'hi', lsb: 0x22 });
  g(N | 4, 0x47, 'fxOn'); g(N | 4, 0x43, 'fxOn', { shift: true });
  return e;
}

// ---------------------------------------------------------------- the Pioneer DDJ family (rekordbox mode)
interface FamilyOpts { decks: number; padCh: number[]; fxCh: number[]; jogCcs: number[]; touch: number[]; src: EntrySrc; trim: boolean }
function pioneerFamily(o: FamilyOpts): DeckMapEntry[] {
  const e: DeckMapEntry[] = [];
  const d = (st: number, d1: number, ctl: DeckCtl, deck: number, x: Partial<DeckMapEntry> = {}) => e.push({ st, d1, ctl, deck, v: 'btn', src: o.src, ...x });
  for (let deck = 1; deck <= o.decks; deck++) {
    const n = deck - 1;
    d(N | n, 0x0b, 'play', deck); d(N | n, 0x47, 'play', deck, { shift: true });
    d(N | n, 0x0c, 'cue', deck); d(N | n, 0x48, 'cue', deck, { shift: true });
    d(N | n, 0x3f, 'shift', deck);
    d(N | n, 0x58, 'sync', deck); d(N | n, 0x5c, 'sync', deck, { shift: true });
    for (const j of o.jogCcs) d(CC | n, j, 'jog', deck, { v: 'c64', jog: j === 0x21 || j === 0x26 ? 'side' : 'top', ...(j === 0x29 || j === 0x26 ? { shift: true as const } : {}) });
    o.touch.forEach((t, k) => d(N | n, t, 'jogTouch', deck, k ? { shift: true } : {}));
    d(CC | n, 0x00, 'tempo', deck, { v: 'hi', lsb: 0x20 });
    d(N | n, 0x10, 'loopIn', deck); d(N | n, 0x11, 'loopOut', deck); d(N | n, 0x4d, 'reloop', deck);
    const pc = o.padCh[n];
    if (pc !== undefined) for (let mode = 0; mode < 8; mode++) for (let i = 0; i < 8; i++) { d(N | pc, mode * 16 + i, 'pad', deck, { i, mode }); d(N | (pc + 1), mode * 16 + i, 'pad', deck, { i, mode, shift: true }); }
    d(CC | n, 0x13, 'fader', deck, { v: 'hi', lsb: 0x33 });
    if (o.trim) d(CC | n, 0x04, 'trim', deck, { v: 'hi', lsb: 0x24 });
    d(CC | n, 0x07, 'eq', deck, { v: 'hi', lsb: 0x27, i: 0 }); d(CC | n, 0x0b, 'eq', deck, { v: 'hi', lsb: 0x2b, i: 1 }); d(CC | n, 0x0f, 'eq', deck, { v: 'hi', lsb: 0x2f, i: 2 });
    d(N | n, 0x54, 'chCue', deck);
    d(CC | 6, 0x16 + deck, 'color', deck, { v: 'hi', lsb: 0x36 + deck });
    d(N | 6, 0x45 + deck, 'load', deck);
  }
  e.push({ st: CC | 6, d1: 0x1f, ctl: 'xf', deck: 0, v: 'hi', lsb: 0x3f, src: o.src });
  e.push({ st: CC | 6, d1: 0x40, ctl: 'browse', deck: 0, v: 'tc', src: o.src }, { st: N | 6, d1: 0x41, ctl: 'browsePress', deck: 0, v: 'btn', src: o.src });
  e.push({ st: CC | 6, d1: 0x08, ctl: 'master', deck: 0, v: 'hi', lsb: 0x28, src: 'inferred' });
  for (const ch of o.fxCh) e.push({ st: N | ch, d1: 0x47, ctl: 'fxOn', deck: 0, v: 'btn', src: o.src }, { st: CC | ch, d1: 0x02, ctl: 'fxLevel', deck: 0, v: 'hi', lsb: 0x22, src: 'inferred' },
    { st: N | ch, d1: 0x4a, ctl: 'fxBeat', deck: 0, i: 0, v: 'btn', src: 'inferred' }, { st: N | ch, d1: 0x4b, ctl: 'fxBeat', deck: 0, i: 1, v: 'btn', src: 'inferred' });
  return e;
}

/** Any other controller VTube Pro already reads (shared/djControllers.ts) — the parts the virtual decks can show. */
function fromControllerMap(m: ControllerMap): DeckMapEntry[] {
  const out: DeckMapEntry[] = [];
  for (const x of m.entries) {
    const base = { st: x.st, d1: x.d1, deck: x.deck, src: 'community' as const, ...(x.i !== undefined ? { i: x.i } : {}) };
    const hi = x.hi ? { v: 'hi' as const, ...(x.lsb !== undefined ? { lsb: x.lsb } : {}) } : { v: 'abs' as const };
    switch (x.ctl) {
      case 'xfade': out.push({ ...base, ctl: 'xf', deck: 0, ...hi }); break;
      case 'fader': out.push({ ...base, ctl: 'fader', ...hi }); break;
      case 'eq': out.push({ ...base, ctl: 'eq', ...hi }); break;
      case 'filter': out.push({ ...base, ctl: 'color', ...hi }); break;
      case 'play': case 'cue': case 'sync': case 'load': case 'pad': case 'jogTouch': out.push({ ...base, ctl: x.ctl === 'load' ? 'load' : x.ctl, v: 'btn' }); break;
      case 'fx': out.push({ ...base, ctl: 'fxOn', deck: 0, v: x.st >= 0xb0 && x.st < 0xc0 ? 'abs' : 'btn' }); break;
      case 'jog': out.push({ ...base, ctl: 'jog', v: x.rel === 'tc' ? 'tc' : 'c64', jog: 'top' }); break;
      default: break;   // (absolute jogs: shown as touches only)
    }
  }
  return out;
}

export const DECK_PROFILES: DeckProfile[] = [
  { id: 'ddj-grv6', name: 'DDJ-GRV6', match: /DDJ-?GRV6/i, decks: 4, layout: 'ctrl4', jogTicks: 720, jogTicksSrc: 'inferred', entries: grv6(),
    note: 'Every control from the manufacturer’s MIDI message list. Jog resolution and the mixer’s channel order on the panel are assumed until a capture confirms them.' },
  { id: 'ddj-flx4', name: 'DDJ-FLX4', match: /DDJ-?FLX4/i, decks: 2, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'community', entries: pioneerFamily({ decks: 2, padCh: [7, 9], fxCh: [4, 5], jogCcs: [0x21, 0x22, 0x23, 0x29], touch: [0x36, 0x67], src: 'community', trim: true }) },
  { id: 'ddj-400', name: 'DDJ-400', match: /DDJ-?400/i, decks: 2, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'community', entries: pioneerFamily({ decks: 2, padCh: [7, 9], fxCh: [4], jogCcs: [0x21, 0x22, 0x23, 0x29], touch: [0x36, 0x67], src: 'community', trim: true }) },
  { id: 'ddj-flx6', name: 'DDJ-FLX6', match: /DDJ-?FLX6/i, decks: 4, layout: 'ctrl4', jogTicks: 720, jogTicksSrc: 'inferred', entries: pioneerFamily({ decks: 4, padCh: [7, 9, 11, 13], fxCh: [4, 5], jogCcs: [0x21, 0x22, 0x23], touch: [0x36], src: 'community', trim: true }) },
  { id: 'ddj-sb3', name: 'DDJ-SB3', match: /DDJ-?SB3/i, decks: 4, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'inferred', entries: pioneerFamily({ decks: 4, padCh: [7, 8, 9, 10], fxCh: [4, 5], jogCcs: [0x21, 0x22, 0x23], touch: [0x36, 0x35], src: 'community', trim: true }) },
  { id: 'ddj-200', name: 'DDJ-200', match: /DDJ-?200/i, decks: 2, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'inferred', entries: pioneerFamily({ decks: 2, padCh: [7, 9], fxCh: [4], jogCcs: [0x21, 0x22, 0x23, 0x29], touch: [0x36, 0x67], src: 'inferred', trim: false }) },
  { id: 'ddj-rev1', name: 'DDJ-REV1', match: /DDJ-?REV1/i, decks: 2, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'inferred', entries: pioneerFamily({ decks: 2, padCh: [7, 9], fxCh: [4, 5], jogCcs: [0x21, 0x22, 0x23, 0x29], touch: [0x36, 0x67], src: 'inferred', trim: false }) },
  ...CONTROLLER_MAPS.filter((m) => !/^ddj-/.test(m.id)).map((m): DeckProfile => ({ id: m.id, name: m.name.replace(/^(Pioneer|Numark|Hercules|Denon DJ)\s+/i, ''), match: m.match, decks: m.decks, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'inferred', entries: fromControllerMap(m), ...(m.note ? { note: m.note } : {}) })),
];

/** A controller nobody mapped: the user teaches it (shared/djDeck/learn.ts). */
export const GENERIC_PROFILE: DeckProfile = { id: 'generic', name: 'your controller', match: /$^/, decks: 2, layout: 'cdj', jogTicks: 720, jogTicksSrc: 'inferred', entries: [] };

/** What the user taught (per controller port name), stored by the helper. */
export interface LearnedProfile { entries: DeckMapEntry[]; jogTicks?: number; layout?: LayoutId; at: number }

export function profileFor(port: string): DeckProfile { return DECK_PROFILES.find((p) => p.match.test(port)) ?? GENERIC_PROFILE; }

/** The built-in profile with the user's taught entries on top (a taught message replaces the built-in one). */
export function mergeLearned(base: DeckProfile, learned: LearnedProfile | null | undefined): DeckProfile {
  if (!learned || !learned.entries.length && !learned.jogTicks && !learned.layout) return base;
  const key = (e: DeckMapEntry) => `${(e.st & 0xf0) === 0x80 ? 0x90 | (e.st & 15) : e.st}:${e.d1}`;
  const taught = new Set(learned.entries.map(key));
  return { ...base, entries: [...learned.entries, ...base.entries.filter((e) => !taught.has(key(e)))], jogTicks: learned.jogTicks ?? base.jogTicks,
    jogTicksSrc: learned.jogTicks ? 'learned' : base.jogTicksSrc, layout: learned.layout ?? base.layout };
}

const CTL_SET = new Set<string>([...DECK_CTLS, ...CHANNEL_CTLS, 'xf', 'master', 'booth', 'mcue', 'browse', 'browsePress', 'hpLevel', 'hpMix', 'mic', 'fxLevel', 'fxOn', 'fxSel', 'fxBeat', 'fxCh', 'colorOn']);
const VALS = new Set<ValKind>(['btn', 'abs', 'hi', 'c64', 'tc', 'sel', 'layer']);
/** A taught profile from disk / the network, made safe. */
export function sanitizeLearned(o: unknown): LearnedProfile | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const entries: DeckMapEntry[] = [];
  for (const r of Array.isArray(x.entries) ? x.entries.slice(0, 512) : []) {
    if (!r || typeof r !== 'object') continue;
    const y = r as Record<string, unknown>;
    const st = int(y.st, 0x80, 0xbf), d1 = int(y.d1, 0, 127), deck = int(y.deck, 0, 4);
    if (st === null || d1 === null || deck === null || typeof y.ctl !== 'string' || !CTL_SET.has(y.ctl) || !VALS.has(y.v as ValKind)) continue;
    const en: DeckMapEntry = { st, d1, ctl: y.ctl as DeckCtl, deck, v: y.v as ValKind, src: 'learned' };
    const i = int(y.i, 0, 15); if (i !== null) en.i = i;
    const lsb = int(y.lsb, 0, 127); if (lsb !== null) en.lsb = lsb;
    if (y.jog === 'top' || y.jog === 'side') en.jog = y.jog;
    if (y.shift === true) en.shift = true;
    entries.push(en);
  }
  const jt = int(x.jogTicks, 64, 8192);
  const layout = x.layout === 'cdj' || x.layout === 'ctrl4' ? x.layout : undefined;
  return { entries, ...(jt !== null ? { jogTicks: jt } : {}), ...(layout ? { layout } : {}), at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0 };
}

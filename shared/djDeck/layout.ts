// DJ decks (docs/DJ_SYNC.md "DJ decks"): the virtual DJ setup's layouts. Pure data, shared by the prop builder
// (src/scene/djdeck/deckProp.ts), the hands (src/scene/djdeck/deckPerformer.ts), the studio's "Teach my controller"
// diagram (src/ui/djDeckPanel.ts) and the helper's controller reader (shared/djDeck/reader.ts).
//
// Coordinates: metres at a 1.75 m performer's scale, on the gear's TOP surface, seen by the DJ:
//   u = to the DJ's right (+), v = away from the DJ (+, the "top" of the gear), y = up from the main top surface.
// The prop converts to its own frame (the DJ faces +Z, so x = −u, z = v).
// Part ids are PHYSICAL controls: `L.*` / `R.*` = the left / right deck (decks 1/3 and 2/4 share one side on a
// 4-deck controller), `chN.*` = mixer channel N (1-4), `m.*` = the rest of the mixer.
// No brand names or logos anywhere: 'cdj' = a generic two-player + 4-channel-mixer booth, 'ctrl4' = a generic one-piece
// 4-channel controller laid out like the popular groove / performance controllers (pads above the jogs, a raised
// drum row above the pads, 4 channels + a beat-FX column in the middle).

export type PartKind = 'jog' | 'tempo' | 'fader' | 'xfader' | 'knob' | 'button' | 'pad' | 'lever' | 'meter' | 'screen' | 'encoder';
export type Side = 'L' | 'R' | 'M';
export interface Part {
  id: string;
  kind: PartKind;
  side: Side;
  u: number; v: number;
  /** Height of the part's base above the main top surface (raised rows). */
  y: number;
  /** Footprint: width (u) × depth (v), or radius for round parts; sliders: travel length along their axis. */
  w: number; d: number; r: number; len: number;
  /** LED colour (0xRRGGBB) for buttons / pads / rings. */
  led: number;
  /** Plain-language name for "Teach my controller" ("left jog wheel"). */
  label: string;
}
export interface Housing { u: number; v: number; w: number; d: number; h: number; y: number; raised?: boolean }
export interface RigLayout {
  id: LayoutId;
  /** Overall footprint (u × v) and body height. */
  w: number; d: number; h: number;
  housings: Housing[];
  parts: Part[];
  /** Part by id. */
  byId: Map<string, Part>;
  /** Screens: on the players ('cdj') or a laptop beside the controller ('ctrl4'). */
  screens: { id: string; u: number; v: number; y: number; w: number; h: number; tilt: number; side: Side }[];
}
export type LayoutId = 'cdj' | 'ctrl4';
export const LAYOUT_IDS: readonly LayoutId[] = ['cdj', 'ctrl4'];

const C = { play: 0x39ff6a, cue: 0xffa31a, white: 0xf4f4ff, blue: 0x2f8cff, red: 0xff3344, pink: 0xff3fd2, cyan: 0x35e3ff, amber: 0xffc23a, dim: 0x9aa3b5 };
const PAD_LED = [0xff3344, 0xff8a1a, 0xffd21a, 0x39ff6a, 0x35e3ff, 0x2f6bff, 0xb026ff, 0xff3fd2];
const SIDE_NAME: Record<Side, string> = { L: 'left', R: 'right', M: 'mixer' };

function part(id: string, kind: PartKind, side: Side, u: number, v: number, o: Partial<Part> = {}): Part {
  const base: Part = { id, kind, side, u, v, y: 0, w: 0.016, d: 0.012, r: 0.01, len: 0, led: C.white, label: id };
  return { ...base, ...o };
}

/** Deck controls shared by both layouts' sides (du relative to the deck centre). */
function deck(side: 'L' | 'R', cu: number, kind: LayoutId): Part[] {
  const s = SIDE_NAME[side];
  const P = (id: string, k: PartKind, du: number, v: number, o: Partial<Part> = {}) => part(`${side}.${id}`, k, side, cu + du, v, { ...o, label: `${s} ${o.label ?? id}` });
  const out: Part[] = [];
  if (kind === 'ctrl4') {
    out.push(
      P('jog', 'jog', -0.015, -0.068, { r: 0.1, led: side === 'L' ? C.cyan : C.pink, label: 'jog wheel' }),
      P('play', 'button', -0.108, -0.18, { r: 0.0135, led: C.play, label: 'PLAY' }),
      P('cue', 'button', -0.108, -0.148, { r: 0.0135, led: C.cue, label: 'CUE' }),
      P('shift', 'button', -0.113, -0.12, { r: 0.0085, led: C.dim, label: 'SHIFT' }),
      P('tempo', 'tempo', 0.104, -0.085, { len: 0.1, w: 0.02, d: 0.012, label: 'tempo fader' }),
      P('mt', 'button', 0.104, -0.014, { w: 0.016, d: 0.009, led: C.cue, label: 'master tempo' }),
      P('sync', 'button', 0.104, -0.162, { w: 0.02, d: 0.011, led: C.blue, label: 'BEAT SYNC' }),
      P('ksync', 'button', 0.104, -0.186, { w: 0.016, d: 0.009, led: C.dim, label: 'key sync' }),
      P('slip', 'button', -0.105, 0.05, { w: 0.016, d: 0.009, led: C.dim, label: 'slip' }),
      P('quant', 'button', -0.083, 0.05, { w: 0.016, d: 0.009, led: C.cue, label: 'quantize' }),
      ...[0, 1, 2, 3].map((i) => P(`pm${i}`, 'button', -0.045 + i * 0.023, 0.05, { w: 0.018, d: 0.009, led: PAD_LED[i * 2], label: `pad mode ${i + 1}` })),
      P('layerA', 'button', 0.07, 0.05, { w: 0.022, d: 0.01, led: C.blue, label: side === 'L' ? 'DECK 1' : 'DECK 2' }),
      P('layerB', 'button', 0.098, 0.05, { w: 0.022, d: 0.01, led: C.blue, label: side === 'L' ? 'DECK 3' : 'DECK 4' }),
      P('loopIn', 'button', -0.105, 0.069, { w: 0.016, d: 0.009, led: C.cue, label: 'loop in' }),
      P('loopOut', 'button', -0.083, 0.069, { w: 0.016, d: 0.009, led: C.cue, label: 'loop out' }),
      P('reloop', 'button', -0.061, 0.069, { w: 0.016, d: 0.009, led: C.cue, label: 'reloop' }),
      P('callPrev', 'button', 0.04, 0.069, { w: 0.016, d: 0.009, led: C.red, label: 'call back' }),
      P('callNext', 'button', 0.062, 0.069, { w: 0.016, d: 0.009, led: C.red, label: 'call next' }),
      P('memory', 'button', 0.084, 0.069, { w: 0.016, d: 0.009, led: C.red, label: 'memory' }),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => P(`pad${i}`, 'pad', -0.084 + (i % 4) * 0.056, i < 4 ? 0.13 : 0.098, { w: 0.05, d: 0.027, led: PAD_LED[i], label: `pad ${i + 1}` })),
      // the raised drum row (a step up between it and the pads)
      P('gain', 'knob', -0.1, 0.174, { y: 0.012, r: 0.011, led: C.amber, label: 'drum gain' }),
      ...[0, 1, 2, 3].map((i) => P(`swap${i}`, 'button', -0.074 + i * 0.02, 0.174, { y: 0.012, w: 0.016, d: 0.013, led: C.amber, label: `drum swap ${i + 1}` })),
      P('capture', 'button', 0.006, 0.174, { y: 0.012, w: 0.016, d: 0.013, led: C.red, label: 'capture' }),
      ...[0, 1, 2, 3].map((i) => P(`roll${i}`, 'button', 0.026 + i * 0.02, 0.174, { y: 0.012, w: 0.016, d: 0.013, led: C.cyan, label: `drum roll ${i + 1}` })),
      P('release', 'lever', 0.108, 0.174, { y: 0.012, w: 0.012, d: 0.03, led: C.amber, label: 'drum release lever' }),
    );
  } else {
    out.push(
      P('screen', 'screen', 0, 0.13, { w: 0.2, d: 0.11, label: 'screen' }),
      P('jog', 'jog', -0.01, -0.075, { r: 0.103, led: side === 'L' ? C.cyan : C.pink, label: 'jog wheel' }),
      P('play', 'button', -0.135, -0.185, { r: 0.017, led: C.play, label: 'PLAY' }),
      P('cue', 'button', -0.135, -0.146, { r: 0.017, led: C.cue, label: 'CUE' }),
      P('tempo', 'tempo', 0.135, -0.1, { len: 0.11, w: 0.022, d: 0.013, label: 'tempo fader' }),
      P('mt', 'button', 0.135, -0.022, { w: 0.018, d: 0.01, led: C.cue, label: 'master tempo' }),
      P('sync', 'button', 0.135, -0.188, { w: 0.022, d: 0.012, led: C.blue, label: 'BEAT SYNC' }),
      P('ksync', 'button', 0.105, -0.192, { w: 0.018, d: 0.01, led: C.dim, label: 'key sync' }),
      P('shift', 'button', 0.135, 0.0, { w: 0.018, d: 0.01, led: C.dim, label: 'SHIFT' }),
      P('loopIn', 'button', -0.135, -0.105, { w: 0.018, d: 0.011, led: C.cue, label: 'loop in' }),
      P('loopOut', 'button', -0.135, -0.082, { w: 0.018, d: 0.011, led: C.cue, label: 'loop out' }),
      P('reloop', 'button', -0.135, -0.059, { w: 0.018, d: 0.011, led: C.cue, label: 'reloop' }),
      P('callPrev', 'button', -0.135, -0.03, { w: 0.018, d: 0.01, led: C.red, label: 'call back' }),
      P('callNext', 'button', -0.135, -0.01, { w: 0.018, d: 0.01, led: C.red, label: 'call next' }),
      P('memory', 'button', -0.135, 0.01, { w: 0.018, d: 0.01, led: C.red, label: 'memory' }),
      P('slip', 'button', -0.135, 0.032, { w: 0.018, d: 0.01, led: C.dim, label: 'slip' }),
      P('quant', 'button', 0.135, 0.022, { w: 0.018, d: 0.01, led: C.cue, label: 'quantize' }),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => P(`pad${i}`, 'pad', -0.1225 + i * 0.035, 0.058, { w: 0.03, d: 0.02, led: PAD_LED[i], label: `hot cue ${i + 1}` })),
      P('browse', 'encoder', 0.125, 0.175, { r: 0.012, label: 'browse knob' }),
    );
  }
  return out;
}

function mixer(kind: LayoutId): Part[] {
  const out: Part[] = [];
  const four = kind === 'ctrl4';
  const chU = four ? [-0.072, -0.024, 0.024, 0.072] : [-0.105, -0.035, 0.035, 0.105];
  const V = four
    ? { load: 0.192, trim: 0.15, eq: [0.118, 0.088, 0.058], color: 0.022, cue: -0.01, fader: -0.08, flen: 0.09, meter: [0.035, 0.135], xf: -0.175, xlen: 0.09 }
    : { load: 0.198, trim: 0.165, eq: [0.125, 0.09, 0.055], color: 0.015, cue: -0.025, fader: -0.105, flen: 0.09, meter: [0.03, 0.17], xf: -0.19, xlen: 0.1 };
  const meterDu = four ? -0.024 : 0.028;
  chU.forEach((u, k) => {
    const n = k + 1, M = (id: string, kd: PartKind, v: number, o: Partial<Part> = {}) => out.push(part(`ch${n}.${id}`, kd, 'M', u, v, { ...o, label: `channel ${n} ${o.label ?? id}` }));
    M('load', 'button', V.load, { w: 0.014, d: 0.008, led: C.white, label: 'load' });
    M('trim', 'knob', V.trim, { r: 0.0095, label: 'trim' });
    M('eq0', 'knob', V.eq[0], { r: 0.0105, label: 'EQ high' });
    M('eq1', 'knob', V.eq[1], { r: 0.0105, label: 'EQ mid' });
    M('eq2', 'knob', V.eq[2], { r: 0.0105, label: 'EQ low' });
    M('color', 'knob', V.color, { r: 0.0125, led: C.cyan, label: 'filter' });
    M('cue', 'button', V.cue, { w: 0.018, d: 0.01, led: C.cue, label: 'headphone cue' });
    M('fader', 'fader', V.fader, { len: V.flen, w: 0.014, d: 0.02, label: 'fader' });
    out.push(part(`ch${n}.meter`, 'meter', 'M', u + meterDu, (V.meter[0] + V.meter[1]) / 2, { len: V.meter[1] - V.meter[0], w: 0.0045, label: `channel ${n} level meter` }));
  });
  const G = (id: string, kd: PartKind, u: number, v: number, o: Partial<Part> = {}) => out.push(part(`m.${id}`, kd, 'M', u, v, { label: o.label ?? id, ...o }));
  G('xf', 'xfader', 0, V.xf, { len: V.xlen, w: 0.02, d: 0.013, label: 'crossfader' });
  if (four) {
    G('browse', 'encoder', 0, 0.167, { r: 0.014, label: 'browse knob' });
    G('master', 'knob', -0.112, 0.15, { r: 0.01, label: 'master level' });
    G('booth', 'knob', -0.112, 0.12, { r: 0.009, label: 'booth level' });
    G('mcue', 'button', -0.112, 0.09, { w: 0.016, d: 0.009, led: C.cue, label: 'master cue' });
    G('colorOn', 'button', -0.112, 0.022, { w: 0.018, d: 0.01, led: C.cyan, label: 'filter on' });
    G('mic', 'knob', -0.112, -0.115, { r: 0.008, label: 'mic level' });
    G('hpLevel', 'knob', -0.112, -0.145, { r: 0.008, label: 'headphones level' });
    G('hpMix', 'knob', -0.112, -0.175, { r: 0.008, label: 'headphones mix' });
    G('fxBeatL', 'button', 0.103, 0.075, { w: 0.014, d: 0.009, led: C.white, label: 'FX beat left' });
    G('fxBeatR', 'button', 0.121, 0.075, { w: 0.014, d: 0.009, led: C.white, label: 'FX beat right' });
    G('fxSel', 'knob', 0.112, 0.04, { r: 0.011, label: 'FX select' });
    G('fxCh', 'knob', 0.112, 0.0, { r: 0.01, label: 'FX channel select' });
    G('fxLevel', 'knob', 0.112, -0.055, { r: 0.0125, label: 'FX level / depth' });
    G('fxOn', 'button', 0.112, -0.1, { w: 0.022, d: 0.014, led: C.red, label: 'FX on' });
  } else {
    G('master', 'knob', 0.147, 0.17, { r: 0.011, label: 'master level' });
    G('booth', 'knob', 0.147, 0.138, { r: 0.01, label: 'booth level' });
    G('fxSel', 'knob', 0.147, 0.09, { r: 0.011, label: 'FX select' });
    G('fxCh', 'knob', 0.147, 0.05, { r: 0.01, label: 'FX channel select' });
    G('fxBeatL', 'button', 0.14, 0.018, { w: 0.012, d: 0.009, led: C.white, label: 'FX beat left' });
    G('fxBeatR', 'button', 0.155, 0.018, { w: 0.012, d: 0.009, led: C.white, label: 'FX beat right' });
    G('fxLevel', 'knob', 0.147, -0.02, { r: 0.0125, label: 'FX level / depth' });
    G('fxOn', 'button', 0.147, -0.07, { w: 0.022, d: 0.015, led: C.red, label: 'FX on' });
    G('mcue', 'button', -0.143, 0.17, { w: 0.016, d: 0.009, led: C.cue, label: 'master cue' });
    G('mic', 'knob', -0.143, 0.13, { r: 0.009, label: 'mic level' });
    G('colorOn', 'button', -0.143, 0.015, { w: 0.018, d: 0.01, led: C.cyan, label: 'filter on' });
    G('hpLevel', 'knob', -0.143, -0.14, { r: 0.009, label: 'headphones level' });
    G('hpMix', 'knob', -0.143, -0.17, { r: 0.009, label: 'headphones mix' });
  }
  return out;
}

const cache = new Map<LayoutId, RigLayout>();
/** A layout (built once). */
export function rigLayout(id: LayoutId): RigLayout {
  const hit = cache.get(id); if (hit) return hit;
  let L: Omit<RigLayout, 'byId'>;
  if (id === 'ctrl4') {
    const parts = [...deck('L', -0.255, id), ...deck('R', 0.255, id), ...mixer(id)];
    L = {
      id, w: 0.76, d: 0.4, h: 0.06, parts,
      housings: [{ u: 0, v: 0, w: 0.76, d: 0.4, h: 0.06, y: 0 }, { u: -0.255, v: 0.177, w: 0.25, d: 0.046, h: 0.012, y: 0, raised: true }, { u: 0.255, v: 0.177, w: 0.25, d: 0.046, h: 0.012, y: 0, raised: true }],
      // performance mode: the DJ app runs on a laptop beside the controller (on the DJ's right, turned toward them), so
      // the room's cameras see the hands on the controller
      screens: [{ id: 'laptop', u: 0.56, v: -0.03, y: 0, w: 0.31, h: 0.2, tilt: 0.32, side: 'M' }],
    };
  } else {
    const parts = [...deck('L', -0.332, id), ...deck('R', 0.332, id), ...mixer(id)];
    L = {
      id, w: 0.984, d: 0.42, h: 0.1, parts,
      housings: [{ u: -0.332, v: 0, w: 0.32, d: 0.42, h: 0.1, y: 0 }, { u: 0.332, v: 0, w: 0.32, d: 0.42, h: 0.1, y: 0 }, { u: 0, v: 0, w: 0.32, d: 0.4, h: 0.1, y: 0 }],
      screens: parts.filter((p) => p.kind === 'screen').map((p) => ({ id: p.id, u: p.u, v: p.v, y: 0.012, w: p.w, h: p.d, tilt: 0.62, side: p.side })),
    };
  }
  const out: RigLayout = { ...L, byId: new Map(L.parts.map((p) => [p.id, p])) };
  cache.set(id, out);
  return out;
}

/** The part a control lands on in this layout: itself, or the nearest stand-in (a drum-row button on a two-player
 *  booth lands on the matching pad, a deck switch on the jog's corner, a channel's load button on the browse knob). */
export function partFor(layout: RigLayout, id: string): Part | null {
  const hit = layout.byId.get(id); if (hit) return hit;
  const m = /^([LR])\.(\w+?)(\d?)$/.exec(id);
  if (m) {
    const [, s, name, n] = m, i = n ? +n : 0;
    const alt: Record<string, string> = { swap: `pad${i}`, roll: `pad${i + 4}`, capture: 'pad7', gain: 'pad0', release: 'pad3', pm: `pad${i}`, layerA: 'mt', layerB: 'mt', browse: 'pad0', load: 'pad0' };
    const a = alt[name]; if (a) return layout.byId.get(`${s}.${a}`) ?? null;
    return null;
  }
  const c = /^ch(\d)\.(\w+)$/.exec(id);
  if (c) { if (c[2] === 'load') return layout.byId.get('m.browse') ?? null; return layout.byId.get(`ch${Math.min(4, +c[1])}.fader`) ?? null; }
  return layout.byId.get('m.xf') ?? null;
}

/** Which hand naturally works a part: the deck sides are fixed, mixer parts prefer the nearer hand. */
export function handFor(p: Part): { own: 'left' | 'right' | null; prefer: 'left' | 'right' } {
  if (p.side === 'L') return { own: 'left', prefer: 'left' };
  if (p.side === 'R') return { own: 'right', prefer: 'right' };
  return { own: null, prefer: p.u < 0 ? 'left' : 'right' };
}

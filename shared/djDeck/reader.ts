// DJ decks: reads one controller's raw MIDI (listen-only) into the state of its PHYSICAL controls — fader / knob /
// tempo positions, jog angles, what is held down, what lights, when each control was last touched — and the compact
// snapshot the helper puts on the bus ({type:'djdeck', s}) for every page (studio preview, OBS, party guests' OBS).
// Pure module: the helper (server/music/deckRig.ts) runs it; tests: tools/djdeck_unit.ts.
import type { DeckCtl, DeckMapEntry, DeckProfile } from './profiles.ts';
import type { LayoutId } from './layout.ts';

/** The bus snapshot (~20 Hz while the controller moves, every 2 s otherwise). */
export interface DeckSnapshot {
  v: 1;
  /** Helper epoch ms. */
  t: number;
  /** Controller name ("DDJ-GRV6") and profile id ('generic' = not known: teach it). */
  dev: string;
  pid: string;
  /** The layout that matches the controller (pages use it when the room's setting says "match my controller"). */
  lay: LayoutId;
  /** Continuous parts, 0..1 as the controller reports them (faders: 0 = bottom, tempo: 0 = the "−" end, knobs: 0 =
   *  fully counter-clockwise, crossfader: 0 = left); encoders: turns (wrapping 0..1). */
  x: Record<string, number>;
  /** Jog platter angle per side in turns (relative ticks / ticks per turn, accumulated) + which surface turned last. */
  j: { L: number; R: number };
  jm: { L: 'top' | 'side'; R: 'top' | 'side' };
  /** Parts held right now (buttons, pads, a touched jog, the lever). */
  on: string[];
  /** Latched lights: PLAY of the active deck on each side, the active deck's button, FX on, filter on. */
  lit: string[];
  /** ms since each part was last touched (only the last 5 s). */
  k: Record<string, number>;
  /** Active deck per side (1 / 3 left, 2 / 4 right) and pad mode (0-7) per side. */
  ly: { L: number; R: number };
  pm: { L: number; R: number };
  /** Playing per logical deck 1-4, as toggled by its PLAY button (the DJ app is the truth; DJ sync's clock wins). */
  pl: [boolean, boolean, boolean, boolean];
  /** SHIFT held. */
  sh: boolean;
}

export const sideOfDeck = (deck: number): 'L' | 'R' => (deck % 2 === 1 ? 'L' : 'R');
const SEL_N: Partial<Record<DeckCtl, number>> = { fxSel: 14, fxCh: 6 };
const DECK_PART: Partial<Record<DeckCtl, string>> = { jogTouch: 'jog', chCue: 'cue', browsePress: 'browse' };

/** The physical part a map entry moves (see shared/djDeck/layout.ts for the ids). null = state only (deck layers). */
export function partOf(e: Pick<DeckMapEntry, 'ctl' | 'deck' | 'i'>): string | null {
  const c = e.ctl;
  if (c === 'layer') return null;
  if (['fader', 'trim', 'eq', 'color', 'chCue', 'load'].includes(c)) {
    const ch = Math.max(1, Math.min(4, e.deck || 1));
    return `ch${ch}.${c === 'eq' ? `eq${e.i ?? 0}` : DECK_PART[c] ?? c}`;
  }
  if (e.deck >= 1 && e.deck <= 4 && !['xf', 'master', 'booth', 'mcue', 'browse', 'browsePress', 'hpLevel', 'hpMix', 'mic', 'fxLevel', 'fxOn', 'fxSel', 'fxBeat', 'fxCh', 'colorOn'].includes(c)) {
    const s = sideOfDeck(e.deck);
    if (c === 'layerBtn') return `${s}.${e.deck <= 2 ? 'layerA' : 'layerB'}`;
    if (c === 'pad' || c === 'pm' || c === 'swap' || c === 'roll') return `${s}.${c}${e.i ?? 0}`;
    return `${s}.${DECK_PART[c] ?? c}`;
  }
  if (c === 'fxBeat') return e.i ? 'm.fxBeatR' : 'm.fxBeatL';
  return `m.${DECK_PART[c] ?? c}`;
}

const keyOf = (st: number, d1: number) => ((((st & 0xf0) === 0x80 ? 0x90 | (st & 15) : st) << 8) | d1);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export class DeckRigReader {
  readonly profile: DeckProfile;
  private index = new Map<number, DeckMapEntry>();
  private lsbIndex = new Map<number, DeckMapEntry>();
  private msb = new Map<number, number>();
  readonly x = new Map<string, number>();
  readonly on = new Set<string>();
  readonly touchAt = new Map<string, number>();
  jog = { L: 0, R: 0 };
  jm: DeckSnapshot['jm'] = { L: 'top', R: 'top' };
  layer = { L: 1, R: 2 };
  padMode = { L: 0, R: 0 };
  playing: DeckSnapshot['pl'] = [false, false, false, false];
  private fxOn = false;
  private colorOn = false;
  shift = false;
  messages = 0;
  mapped = 0;
  lastAt = 0;
  /** Messages no entry knows (MIDI learn / "Record my controller" look at these). */
  onUnmapped: ((st: number, d1: number, d2: number, t: number) => void) | null = null;

  constructor(profile: DeckProfile) {
    this.profile = profile;
    for (const e of profile.entries) {
      const k = keyOf(e.st, e.d1);
      if (!this.index.has(k)) this.index.set(k, e);
      if (e.v === 'hi') { const lk = keyOf(e.st, e.lsb ?? e.d1 + 0x20); if (!this.lsbIndex.has(lk) && !this.index.has(lk)) this.lsbIndex.set(lk, e); }
    }
  }

  /** One raw message (status, data1, data2) at helper epoch ms t. Returns the part it moved (null = not a control). */
  feed(st: number, d1: number, d2: number, t: number): string | null {
    this.messages++; this.lastAt = t;
    const type = st & 0xf0;
    if (type !== 0x80 && type !== 0x90 && type !== 0xb0) return null;
    const k = keyOf(st, d1);
    let e = this.index.get(k), lsb = false;
    if (!e && type === 0xb0) { e = this.lsbIndex.get(k); lsb = !!e; }
    if (!e) { this.onUnmapped?.(st, d1, d2, t); return null; }
    this.mapped++;
    const press = type === 0xb0 ? d2 > 63 : type === 0x90 && d2 > 0;
    const p = partOf(e);
    const touch = () => { if (p) this.touchAt.set(p, t); };
    switch (e.v) {
      case 'layer': {
        if (d2 >= 0x40 && e.deck >= 1) this.layer[sideOfDeck(e.deck)] = e.deck;
        return null;
      }
      case 'btn': {
        if (!p) return null;
        if (press) { this.on.add(p); touch(); } else this.on.delete(p);
        if (!press) return p;
        if (e.ctl === 'shift') this.shift = true;
        if (e.ctl === 'play' && !e.shift && e.deck >= 1) this.playing[e.deck - 1] = !this.playing[e.deck - 1];
        if (e.ctl === 'pad' && e.mode !== undefined) this.padMode[sideOfDeck(e.deck)] = e.mode;
        if (e.ctl === 'pm') this.padMode[sideOfDeck(e.deck)] = (e.i ?? 0) + (e.shift ? 4 : 0);
        if (e.ctl === 'release') this.x.set(p, e.i === 1 ? 0 : 1);
        if (e.ctl === 'fxOn' && !e.shift) this.fxOn = !this.fxOn;
        if (e.ctl === 'colorOn' && !e.shift) this.colorOn = !this.colorOn;
        return p;
      }
      case 'sel': {
        if (!p || !press) return p;
        const n = SEL_N[e.ctl] ?? 8;
        this.x.set(p, (e.i ?? 0) / Math.max(1, n - 1)); touch();
        return p;
      }
      case 'abs': { if (!p) return null; this.x.set(p, d2 / 127); touch(); return p; }
      case 'hi': {
        if (!p) return null;
        const id = keyOf(e.st, e.d1);
        if (lsb) { const m = this.msb.get(id); if (m === undefined) return p; this.x.set(p, ((m << 7) | d2) / 16383); }
        else { this.msb.set(id, d2); this.x.set(p, d2 / 127); }
        touch();
        return p;
      }
      case 'c64': case 'tc': {
        const dlt = e.v === 'c64' ? d2 - 64 : d2 < 64 ? d2 : d2 - 128;
        if (!p || !dlt) return p;
        if (e.ctl === 'jog' && e.deck >= 1) {
          const s = sideOfDeck(e.deck);
          this.jog[s] += dlt / Math.max(16, this.profile.jogTicks);
          if (Math.abs(this.jog[s]) > 1e6) this.jog[s] %= 1;
          this.jm[s] = e.jog ?? 'top';
        } else this.x.set(p, (((this.x.get(p) ?? 0) + dlt / 24) % 1 + 1) % 1);
        touch();
        return p;
      }
    }
    return p;
  }

  /** SHIFT released etc. are buttons too; this keeps `shift` honest when its note-off came. */
  private shiftHeld() { for (const id of this.on) if (/\.shift$/.test(id)) return true; return false; }

  snapshot(now: number): DeckSnapshot {
    const k: Record<string, number> = {};
    for (const [id, at] of this.touchAt) { const a = now - at; if (a <= 5000) k[id] = Math.max(0, Math.round(a)); else this.touchAt.delete(id); }
    const x: Record<string, number> = {};
    for (const [id, v] of this.x) x[id] = r4(v);
    const lit: string[] = [];
    for (const s of ['L', 'R'] as const) {
      const d = this.layer[s];
      if (this.playing[d - 1]) lit.push(`${s}.play`);
      lit.push(`${s}.${d <= 2 ? 'layerA' : 'layerB'}`);
    }
    if (this.fxOn) lit.push('m.fxOn');
    if (this.colorOn) lit.push('m.colorOn');
    this.shift = this.shiftHeld();
    return {
      v: 1, t: Math.round(now), dev: this.profile.name.slice(0, 60), pid: this.profile.id, lay: this.profile.layout, x,
      j: { L: r4(this.jog.L), R: r4(this.jog.R) }, jm: { ...this.jm }, on: [...this.on].slice(0, 32), lit, k,
      ly: { ...this.layer }, pm: { ...this.padMode }, pl: [...this.playing] as DeckSnapshot['pl'], sh: this.shift,
    };
  }
}

// ---------------------------------------------------------------- the wire (pages sanitise everything they get)
const ID = /^(?:[LR]|ch[1-4]|m)\.[A-Za-z]{1,10}\d?$/;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export function sanitizeDeckSnapshot(o: unknown): DeckSnapshot | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as Record<string, unknown>;
  if (s.v !== 1 || typeof s.t !== 'number' || !Number.isFinite(s.t)) return null;
  const rec = (v: unknown, lo: number, hi: number, max = 160): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) { if (n >= max) break; if (ID.test(key) && typeof val === 'number' && Number.isFinite(val)) { out[key] = Math.min(hi, Math.max(lo, val)); n++; } }
    return out;
  };
  const ids = (v: unknown, max = 32) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, max) : []);
  const jj = (s.j && typeof s.j === 'object' ? s.j : {}) as Record<string, unknown>;
  const jm = (s.jm && typeof s.jm === 'object' ? s.jm : {}) as Record<string, unknown>;
  const ly = (s.ly && typeof s.ly === 'object' ? s.ly : {}) as Record<string, unknown>;
  const pm = (s.pm && typeof s.pm === 'object' ? s.pm : {}) as Record<string, unknown>;
  const pl = Array.isArray(s.pl) ? s.pl : [];
  return {
    v: 1, t: s.t, dev: typeof s.dev === 'string' ? s.dev.replace(/[\u0000-\u001f]/g, ' ').slice(0, 60) : '', pid: typeof s.pid === 'string' && /^[a-z0-9-]{1,40}$/.test(s.pid) ? s.pid : 'generic',
    lay: s.lay === 'ctrl4' ? 'ctrl4' : 'cdj', x: rec(s.x, 0, 1), j: { L: num(jj.L, -1e6, 1e6, 0), R: num(jj.R, -1e6, 1e6, 0) },
    jm: { L: jm.L === 'side' ? 'side' : 'top', R: jm.R === 'side' ? 'side' : 'top' }, on: ids(s.on), lit: ids(s.lit, 16), k: rec(s.k, 0, 5000),
    ly: { L: ly.L === 3 ? 3 : 1, R: ly.R === 4 ? 4 : 2 }, pm: { L: Math.round(num(pm.L, 0, 7, 0)), R: Math.round(num(pm.R, 0, 7, 0)) },
    pl: [0, 1, 2, 3].map((i) => pl[i] === true) as DeckSnapshot['pl'], sh: s.sh === true,
  };
}

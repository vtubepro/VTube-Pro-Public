// DJ decks: "Teach my controller" (zero effort for a controller nobody mapped, or a control a profile got wrong).
// Two ways, both listen-only:
//  - guided: VTube Pro asks for one control at a time ("Turn the LEFT jog wheel one full turn"), recognises what moved
//    and goes on by itself once the control stops; the rest is filled in from the pattern (pads 2-8 after pad 1, the
//    right deck from the left one, channel 2 from channel 1);
//  - "move a control, click the part": move anything, then click that part on the drawing of the decks.
// Pure module (the helper runs the session: server/music/deckRig.ts; tests: tools/djdeck_unit.ts).
import type { DeckCtl, DeckMapEntry, LearnedProfile, ValKind } from './profiles.ts';
import { partOf } from './reader.ts';
import type { PartKind } from './layout.ts';

export interface RawMsg { t: number; st: number; d1: number; d2: number }
export interface LearnTarget { part: string; ctl: DeckCtl; deck: number; i?: number; kind: PartKind; say: string }

/** The guided steps (left deck first, then what's needed to work out the pattern). */
export const LEARN_STEPS: LearnTarget[] = [
  { part: 'L.jog', ctl: 'jog', deck: 1, kind: 'jog', say: 'Turn the LEFT jog wheel one full turn clockwise, hand on top' },
  { part: 'L.tempo', ctl: 'tempo', deck: 1, kind: 'tempo', say: 'Slide the LEFT tempo fader from one end to the other' },
  { part: 'L.play', ctl: 'play', deck: 1, kind: 'button', say: 'Press the LEFT PLAY button' },
  { part: 'L.cue', ctl: 'cue', deck: 1, kind: 'button', say: 'Press the LEFT CUE button' },
  { part: 'L.pad0', ctl: 'pad', deck: 1, i: 0, kind: 'pad', say: 'Tap the LEFT deck’s first pad (top left)' },
  { part: 'R.jog', ctl: 'jog', deck: 2, kind: 'jog', say: 'Turn the RIGHT jog wheel a little, hand on top' },
  { part: 'R.play', ctl: 'play', deck: 2, kind: 'button', say: 'Press the RIGHT PLAY button' },
  { part: 'ch1.fader', ctl: 'fader', deck: 1, kind: 'fader', say: 'Move the LEFT channel fader up and down' },
  { part: 'ch1.eq0', ctl: 'eq', deck: 1, i: 0, kind: 'knob', say: 'Turn the LEFT channel’s HIGH (top EQ) knob' },
  { part: 'ch1.eq1', ctl: 'eq', deck: 1, i: 1, kind: 'knob', say: 'Turn the LEFT channel’s MID knob' },
  { part: 'ch1.eq2', ctl: 'eq', deck: 1, i: 2, kind: 'knob', say: 'Turn the LEFT channel’s LOW knob' },
  { part: 'ch1.color', ctl: 'color', deck: 1, kind: 'knob', say: 'Turn the LEFT channel’s FILTER knob' },
  { part: 'ch2.fader', ctl: 'fader', deck: 2, kind: 'fader', say: 'Move the RIGHT channel fader up and down' },
  { part: 'm.xf', ctl: 'xf', deck: 0, kind: 'xfader', say: 'Slide the CROSSFADER from side to side' },
];

/** Which DeckCtl a physical part is (for "click the part"). */
export function targetForPart(part: string, kind: PartKind): LearnTarget | null {
  let m = /^([LR])\.([a-zA-Z]+?)(\d?)$/.exec(part);
  if (m) {
    const deck = m[1] === 'L' ? 1 : 2, name = m[2], i = m[3] ? +m[3] : undefined;
    const ctl = ({ layerA: 'layerBtn', layerB: 'layerBtn' } as Record<string, DeckCtl>)[name] ?? name as DeckCtl;
    return { part, ctl, deck: name === 'layerB' ? deck + 2 : deck, ...(i !== undefined ? { i } : {}), kind, say: '' };
  }
  m = /^ch([1-4])\.([a-z]+)(\d?)$/.exec(part);
  if (m) { const ctl = (m[2] === 'cue' ? 'chCue' : m[2]) as DeckCtl; return { part, ctl, deck: +m[1], ...(m[3] ? { i: +m[3] } : {}), kind, say: '' }; }
  m = /^m\.([a-zA-Z]+)$/.exec(part);
  if (m) {
    const n = m[1];
    if (n === 'fxBeatL' || n === 'fxBeatR') return { part, ctl: 'fxBeat', deck: 0, i: n === 'fxBeatR' ? 1 : 0, kind, say: '' };
    return { part, ctl: n as DeckCtl, deck: 0, kind, say: '' };
  }
  return null;
}

const key = (st: number, d1: number) => `${(st & 0xf0) === 0x80 ? 0x90 | (st & 15) : st}:${d1}`;

/** What moved in a capture, as map entries for the target (null = nothing convincing yet). Also the jog's ticks for
 *  one turn when the target is a jog (the sum of its relative steps). */
export function classify(msgs: RawMsg[], target: LearnTarget): { entries: DeckMapEntry[]; jogTicks?: number; why: string } | null {
  const notes = msgs.filter((m) => (m.st & 0xf0) === 0x90 && m.d2 > 0);
  const ccs = msgs.filter((m) => (m.st & 0xf0) === 0xb0);
  const byKey = new Map<string, RawMsg[]>();
  for (const m of ccs) { const k = key(m.st, m.d1); let a = byKey.get(k); if (!a) byKey.set(k, a = []); a.push(m); }
  const base = (st: number, d1: number, v: ValKind, extra: Partial<DeckMapEntry> = {}): DeckMapEntry =>
    ({ st, d1, ctl: target.ctl, deck: target.deck, v, src: 'learned', ...(target.i !== undefined ? { i: target.i } : {}), ...extra });
  const k = target.kind;
  if (k === 'button' || k === 'pad' || k === 'lever') {
    const n = notes[0];
    if (n) return { entries: [base(0x90 | (n.st & 15), n.d1, 'btn')], why: 'a button' };
    for (const [, a] of byKey) if (a.some((m) => m.d2 > 63) && a.some((m) => m.d2 === 0)) return { entries: [base(a[0].st, a[0].d1, 'btn')], why: 'a button (CC)' };
    return null;
  }
  if (k === 'jog' || k === 'encoder') {
    const rel: { st: number; d1: number; v: 'c64' | 'tc'; sum: number; n: number }[] = [];
    for (const [, a] of byKey) {
      if (a.length < (k === 'jog' ? 6 : 3)) continue;
      const near64 = a.filter((m) => m.d2 >= 40 && m.d2 <= 88 && m.d2 !== 64).length;
      const tc = a.filter((m) => (m.d2 >= 1 && m.d2 <= 24) || (m.d2 >= 104 && m.d2 <= 127)).length;
      if (near64 >= a.length * 0.8) rel.push({ st: a[0].st, d1: a[0].d1, v: 'c64', sum: a.reduce((s, m) => s + m.d2 - 64, 0), n: a.length });
      else if (tc >= a.length * 0.8) rel.push({ st: a[0].st, d1: a[0].d1, v: 'tc', sum: a.reduce((s, m) => s + (m.d2 < 64 ? m.d2 : m.d2 - 128), 0), n: a.length });
    }
    if (!rel.length) return null;
    rel.sort((a, b) => b.n - a.n);
    const entries = rel.map((r) => base(r.st, r.d1, r.v, k === 'jog' ? { jog: 'top' } : {}));
    if (k === 'jog') { const t = notes[0]; if (t) entries.push({ ...base(0x90 | (t.st & 15), t.d1, 'btn'), ctl: 'jogTouch' }); }
    const ticks = Math.abs(rel[0].sum);
    return { entries, ...(k === 'jog' && ticks >= 100 && ticks <= 8192 ? { jogTicks: ticks } : {}), why: `a ${rel[0].v === 'c64' ? 'centre-64' : 'two’s complement'} encoder` };
  }
  // faders / knobs / tempo / crossfader: the CC with the widest spread of values (14-bit when its LSB moves too)
  let best: { k: string; a: RawMsg[]; span: number } | null = null;
  for (const [kk, a] of byKey) {
    const vals = new Set(a.map((m) => m.d2));
    const span = Math.max(...a.map((m) => m.d2)) - Math.min(...a.map((m) => m.d2));
    if (vals.size < 5 || span < 24) continue;
    const d1 = a[0].d1;
    if (d1 >= 0x20 && d1 < 0x40 && byKey.has(key(a[0].st, d1 - 0x20))) continue;   // (the LSB half of a 14-bit pair)
    if (!best || span > best.span || (span === best.span && a.length > best.a.length)) best = { k: kk, a, span };
  }
  if (!best) return null;
  const { st, d1 } = best.a[0];
  const lsb = d1 < 0x20 && byKey.has(key(st, d1 + 0x20)) ? d1 + 0x20 : undefined;
  return { entries: [base(st, d1, lsb !== undefined ? 'hi' : 'abs', lsb !== undefined ? { lsb } : {})], why: lsb !== undefined ? 'a 14-bit control' : 'a 7-bit control' };
}

/** Fill in what the guided steps imply: pads 2-8 after pad 1, the right deck's controls from the left deck's channel
 *  offset, channel 2's knobs from channel 1's. Never overrides a taught entry. */
export function inferRest(taught: DeckMapEntry[]): DeckMapEntry[] {
  const out = [...taught];
  const has = (st: number, d1: number) => out.some((e) => e.st === st && e.d1 === d1);
  const add = (e: DeckMapEntry) => { if (!has(e.st, e.d1) && !out.some((x) => partOf(x) === partOf(e) && x.ctl === e.ctl && (x.i ?? 0) === (e.i ?? 0) && x.deck === e.deck)) out.push({ ...e, src: 'inferred' }); };
  // pads 2-8 (same status, consecutive notes)
  for (const p of taught.filter((e) => e.ctl === 'pad' && (e.i ?? 0) === 0)) for (let i = 1; i < 8; i++) add({ ...p, d1: p.d1 + i, i });
  // the right deck: the channel offset between a left and a right control of the same kind
  const pair = (['jog', 'play', 'tempo', 'cue'] as DeckCtl[]).map((c) => [taught.find((e) => e.ctl === c && e.deck === 1), taught.find((e) => e.ctl === c && e.deck === 2)]).find(([a, b]) => a && b && a.d1 === b.d1);
  if (pair) {
    const dch = (pair[1]!.st & 15) - (pair[0]!.st & 15);
    for (const e of out.filter((x) => x.deck === 1 && !['fader', 'trim', 'eq', 'color', 'chCue', 'load'].includes(x.ctl))) {
      const ch = (e.st & 15) + dch;
      if (ch >= 0 && ch <= 15) add({ ...e, st: (e.st & 0xf0) | ch, deck: 2 });
    }
  }
  // channel 2 from channel 1 (same offset as the faders')
  const f1 = taught.find((e) => e.ctl === 'fader' && e.deck === 1), f2 = taught.find((e) => e.ctl === 'fader' && e.deck === 2);
  if (f1 && f2) {
    const dch = (f2.st & 15) - (f1.st & 15), dd1 = f2.d1 - f1.d1;
    for (const e of out.filter((x) => x.deck === 1 && ['trim', 'eq', 'color', 'chCue'].includes(x.ctl))) {
      const ch = (e.st & 15) + dch, d1 = e.d1 + (dch === 0 ? dd1 : 0);
      if (ch >= 0 && ch <= 15 && d1 >= 0 && d1 <= 127) add({ ...e, st: (e.st & 0xf0) | ch, d1, deck: 2 });
    }
  }
  return out;
}

/** The guided session (one step at a time; a step finishes once its control stopped moving for `settleMs`). */
export class LearnSession {
  idx = 0;
  buf: RawMsg[] = [];
  lastAt = 0;
  readonly taught: DeckMapEntry[] = [];
  jogTicks: number | undefined;
  /** Per step: what was recognised ('' = skipped). */
  readonly got: string[] = [];
  constructor(readonly steps: LearnTarget[] = LEARN_STEPS, readonly settleMs = 900) {}
  get done() { return this.idx >= this.steps.length; }
  get step(): LearnTarget | null { return this.steps[this.idx] ?? null; }
  feed(m: RawMsg) { if (this.done || m.st >= 0xf0) return; this.buf.push(m); this.lastAt = m.t; if (this.buf.length > 4000) this.buf.shift(); }
  /** Call regularly: finishes the step once the control has rested. */
  tick(now: number): boolean {
    const s = this.step; if (!s || !this.buf.length || now - this.lastAt < this.settleMs) return false;
    const r = classify(this.buf, s);
    if (!r) { this.buf = []; return false; }
    this.taught.push(...r.entries);
    if (r.jogTicks && s.part === 'L.jog') this.jogTicks = r.jogTicks;
    this.got[this.idx] = r.why; this.idx++; this.buf = [];
    return true;
  }
  skip() { if (this.done) return; this.got[this.idx] = ''; this.idx++; this.buf = []; }
  result(at: number): LearnedProfile { return { entries: inferRest(this.taught), ...(this.jogTicks ? { jogTicks: this.jogTicks } : {}), at }; }
}

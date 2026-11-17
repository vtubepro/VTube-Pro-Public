// DJ decks, the helper side (docs/DJ_SYNC.md "DJ decks"): the DJ controller's raw MIDI (what DJ sync already reads,
// LISTEN-ONLY — nothing is ever sent to a controller) → the state of its physical controls (shared/djDeck/reader.ts)
// → bus {type:'djdeck', s} for every page: the virtual decks in the room copy the controller and the performer's
// hands play it (src/scene/djdeck/*). Also "Teach my controller" (shared/djDeck/learn.ts; taught maps are kept per
// controller name in <data>/config/djdeck.json) and "Record my controller" (20 s of raw MIDI into cache/diag, so a
// map can be checked against the real unit later).
import fs from 'node:fs';
import path from 'node:path';
import { DeckRigReader, partOf, type DeckSnapshot } from '../../shared/djDeck/reader.ts';
import { mergeLearned, profileFor, sanitizeLearned, type DeckMapEntry, type LearnedProfile } from '../../shared/djDeck/profiles.ts';
import { LEARN_STEPS, LearnSession, classify, targetForPart, type RawMsg } from '../../shared/djDeck/learn.ts';
import { rigLayout, type PartKind } from '../../shared/djDeck/layout.ts';
import { isVirtualPort } from '../../shared/djControllers.ts';

/** One forwarded message: [epoch ms, status, data1, data2] (as server/music/midi.ts). */
type Msg = [number, number, number, number];
export interface DeckRigOptions { broadcast(m: unknown): void; configFile: string; diagDir: string; now(): number; log?(s: string): void }
export interface DeckRigView {
  port: string | null;
  device: string | null;
  profile: { id: string; name: string; known: boolean; layout: string; note?: string; doc: number; inferred: number; learned: number } | null;
  lastAt: number;
  learn: { step: number; steps: number; say: string; part: string; got: string[]; done: boolean } | null;
  grab: { part: string | null; kind: string; at: number } | null;
  record: { on: boolean; until: number; events: number; file: string | null };
  taught: string[];
}

const RATE_MS = 50;          // ≤ 20 snapshots a second while something moves
const HEARTBEAT_MS = 2000;   // (late OBS pages / guests get the state)
const QUIET_MS = 120_000;    // no heartbeat after 2 minutes without a controller message
const REC_MAX = 30_000;
const MAX_PORTS = 16;
/** A controller name as a key of the taught maps (and the file): ≤ 80 characters, never an object's own key names. */
export function safePortKey(port: unknown): string | null {
  if (typeof port !== 'string') return null;
  const k = port.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') return null;
  return k;
}

export class DeckRigHub {
  private readers = new Map<string, DeckRigReader>();
  private learned: Record<string, LearnedProfile> = Object.create(null) as Record<string, LearnedProfile>;
  private active: string | null = null;
  private dirty = false;
  private sentAt = 0;
  private learnS: { port: string; s: LearnSession } | null = null;
  private grabBuf: RawMsg[] = [];
  private grabAt = 0;
  private rec: { port: string; from: number; until: number; ev: [number, number, number, number][]; file: string | null } | null = null;
  private lastFile: string | null = null;

  constructor(private o: DeckRigOptions) {
    try {
      const raw = JSON.parse(fs.readFileSync(o.configFile, 'utf8')) as { byPort?: Record<string, unknown> };
      for (const [k, v] of Object.entries(raw.byPort ?? {}).slice(0, MAX_PORTS)) { const key = safePortKey(k), l = sanitizeLearned(v); if (key && l) this.learned[key] = l; }
    } catch { /* first run */ }
  }

  private reader(port: string): DeckRigReader {
    let r = this.readers.get(port);
    if (!r) {
      r = new DeckRigReader(mergeLearned(profileFor(port), this.learned[port]));
      this.readers.set(port, r);
      if (this.readers.size > 8) { const first = this.readers.keys().next().value; if (first !== undefined && first !== port) this.readers.delete(first); }
    }
    return r;
  }

  /** Raw MIDI from a controller port (the studio's Web MIDI or the native backend). */
  feed(rawPort: string, msgs: Msg[]) {
    const port = safePortKey(rawPort);   // (one key everywhere: readers, taught maps, the file)
    if (!port || isVirtualPort(port)) return;
    const now = this.o.now();
    let moved = false;
    const r = this.reader(port);
    for (const [t, st, d1, d2] of msgs) {
      if (!Number.isFinite(t) || st < 0x80 || st >= 0xf0) continue;   // (clock / system messages: not controls)
      const m: RawMsg = { t: now, st, d1: d1 & 0x7f, d2: d2 & 0x7f };
      if (this.rec && this.rec.port === port && this.rec.ev.length < REC_MAX) this.rec.ev.push([Math.round(t - this.rec.from), st, m.d1, m.d2]);
      if (this.learnS?.port === port) this.learnS.s.feed(m);
      // "move a control, click the part": keep the last control's messages (a new key after a pause starts over)
      if (now - this.grabAt > 1500) this.grabBuf = [];
      this.grabBuf.push(m); this.grabAt = now; if (this.grabBuf.length > 600) this.grabBuf.shift();
      if (r.feed(st, m.d1, m.d2, now) !== null) moved = true;
    }
    if (moved || r.messages) { this.active = port; this.dirty = this.dirty || moved; }
  }

  /** ~30 Hz from the music hub. */
  tick(now = this.o.now()) {
    if (this.learnS && this.learnS.s.tick(now) && this.learnS.s.done) this.saveLearn();
    if (this.rec && now >= this.rec.until) this.finishRecording();
    const r = this.active ? this.readers.get(this.active) : null;
    if (!r) return;
    const quiet = now - r.lastAt > QUIET_MS;
    if ((this.dirty && now - this.sentAt >= RATE_MS) || (!quiet && now - this.sentAt >= HEARTBEAT_MS) || (r.touchAt.size && now - this.sentAt >= 250)) {
      this.dirty = false; this.sentAt = now;
      this.o.broadcast({ type: 'djdeck', s: r.snapshot(now) });
    }
  }

  /** The newest snapshot (tests / the panel). */
  snapshot(now = this.o.now()): DeckSnapshot | null { const r = this.active ? this.readers.get(this.active) : null; return r ? r.snapshot(now) : null; }

  // ---------------------------------------------------------------- teach
  startLearn(): DeckRigView {
    if (!this.active) throw new Error('Move something on your controller first, so VTube Pro knows which one to learn.');
    this.learnS = { port: this.active, s: new LearnSession(LEARN_STEPS) };
    return this.view();
  }
  skipLearn() { if (this.learnS) { this.learnS.s.skip(); if (this.learnS.s.done) this.saveLearn(); } return this.view(); }
  cancelLearn() { this.learnS = null; return this.view(); }
  private saveLearn() {
    const L = this.learnS; if (!L) return;
    const res = L.s.result(Date.now());
    this.learnS = null;
    this.mergeTaught(L.port, res.entries, res.jogTicks);
  }
  /** "Click the part": what moved last becomes that part. */
  bind(part: string, kind: PartKind): { ok: boolean; says: string } {
    const port = this.active;
    if (!port || !this.grabBuf.length || this.o.now() - this.grabAt > 15000) return { ok: false, says: 'Move the control on your controller first, then click its part.' };
    const t = targetForPart(part, kind);
    if (!t) return { ok: false, says: 'That part can’t be taught.' };
    const r = classify(this.grabBuf, t);
    if (!r) return { ok: false, says: kind === 'button' || kind === 'pad' ? 'Press the button once, then click its part.' : 'Move it a bit more (end to end), then click its part.' };
    this.mergeTaught(port, r.entries, t.part.endsWith('.jog') ? r.jogTicks : undefined);
    this.grabBuf = [];
    return { ok: true, says: `Got it: that’s the ${rigLayout('ctrl4').byId.get(part)?.label ?? rigLayout('cdj').byId.get(part)?.label ?? part} now.` };
  }
  private mergeTaught(rawPort: string, entries: DeckMapEntry[], jogTicks?: number) {
    const port = safePortKey(rawPort); if (!port) return;
    const cur = this.learned[port] ?? { entries: [], at: 0 };
    const key = (e: DeckMapEntry) => `${e.st}:${e.d1}`;
    const fresh = new Set(entries.map(key));
    // a taught part replaces what was taught for that part before
    const parts = new Set(entries.map((e) => `${partOf(e)}:${e.ctl}`));
    const keep = cur.entries.filter((e) => !fresh.has(key(e)) && !parts.has(`${partOf(e)}:${e.ctl}`));
    this.learned[port] = { entries: [...entries, ...keep].slice(0, 512), ...(jogTicks ?? cur.jogTicks ? { jogTicks: jogTicks ?? cur.jogTicks } : {}), at: Date.now() };
    // at most 16 controllers: the one taught longest ago goes
    const keys = Object.keys(this.learned);
    if (keys.length > MAX_PORTS) { keys.sort((a, b) => this.learned[a].at - this.learned[b].at); for (const k of keys.slice(0, keys.length - MAX_PORTS)) delete this.learned[k]; }
    this.readers.delete(port);
    this.save();
    this.o.log?.(`[djdeck] taught ${entries.length} message(s) for ${port}`);
  }
  forget() { if (this.active) { delete this.learned[this.active]; this.readers.delete(this.active); this.save(); } return this.view(); }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.o.configFile), { recursive: true });
      fs.writeFileSync(this.o.configFile, JSON.stringify({ v: 1, byPort: this.learned }, null, 1));
    } catch (e) { this.o.log?.(`[djdeck] couldn’t save: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------- record (debug: cache/diag)
  record(sec = 20): DeckRigView {
    if (!this.active) throw new Error('Move something on your controller first, so VTube Pro knows which one to record.');
    const now = this.o.now();
    this.rec = { port: this.active, from: now, until: now + Math.max(3, Math.min(60, sec)) * 1000, ev: [], file: null };
    return this.view();
  }
  private finishRecording() {
    const R = this.rec; if (!R) return;
    this.rec = null;
    const r = this.reader(R.port);
    const prof = r.profile;
    const idx = new Map<string, { n: number; part: string | null; src: string }>();
    const probe = new DeckRigReader(prof);
    for (const [, st, d1, d2] of R.ev) {
      const k = `${((st & 0xf0) === 0x80 ? 0x90 | (st & 15) : st).toString(16)}:${d1.toString(16)}`;
      const part = probe.feed(st, d1, d2, 0);
      const e = prof.entries.find((x) => x.st === ((st & 0xf0) === 0x80 ? 0x90 | (st & 15) : st) && (x.d1 === d1 || (x.v === 'hi' && (x.lsb ?? x.d1 + 0x20) === d1)));
      const cur = idx.get(k) ?? { n: 0, part: part ?? (e ? partOf(e) : null), src: e?.src ?? 'unmapped' };
      cur.n++; idx.set(k, cur);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const file = path.join(this.o.diagDir, `djdeck_midi_${stamp}.json`);
    const body = {
      kind: 'vtp-djdeck-capture', v: 1, port: R.port, profile: prof.id, profileName: prof.name, jogTicks: prof.jogTicks, seconds: Math.round((R.until - R.from) / 1000),
      note: 'Raw MIDI the controller sent (listen-only capture): [ms from start, status, data1, data2]. `keys` = each message key (hex status:data1) with its count, the part the profile reads it as, and where that entry came from.',
      keys: Object.fromEntries([...idx.entries()].sort((a, b) => b[1].n - a[1].n)), events: R.ev,
    };
    try {
      fs.mkdirSync(this.o.diagDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
      this.lastFile = file;
      this.o.log?.(`[djdeck] recorded ${R.ev.length} MIDI messages → ${file}`);
    } catch (e) { this.o.log?.(`[djdeck] couldn’t write the recording: ${(e as Error).message}`); }
  }

  view(): DeckRigView {
    const port = this.active, r = port ? this.readers.get(port) ?? null : null;
    const p = r?.profile ?? (port ? mergeLearned(profileFor(port), this.learned[port]) : null);
    const L = this.learnS?.s;
    const last = this.grabBuf.length && this.o.now() - this.grabAt < 15000 ? this.grabBuf[this.grabBuf.length - 1] : null;
    let grab: DeckRigView['grab'] = null;
    if (last && r) {
      const probe = new DeckRigReader(r.profile);
      const part = probe.feed(last.st, last.d1, last.d2, 0);
      grab = { part, kind: (last.st & 0xf0) === 0xb0 ? 'a knob or fader' : 'a button', at: this.grabAt };
    }
    return {
      port, device: p?.name ?? null,
      profile: p ? { id: p.id, name: p.name, known: p.id !== 'generic' || !!(port && this.learned[port]?.entries.length), layout: p.layout, ...(p.note ? { note: p.note } : {}),
        doc: p.entries.filter((e) => e.src === 'doc').length, inferred: p.entries.filter((e) => e.src === 'inferred').length, learned: p.entries.filter((e) => e.src === 'learned').length } : null,
      lastAt: r?.lastAt ?? 0,
      learn: L ? { step: L.idx, steps: L.steps.length, say: L.step?.say ?? 'Done', part: L.step?.part ?? '', got: [...L.got], done: L.done } : null,
      grab,
      record: { on: !!this.rec, until: this.rec?.until ?? 0, events: this.rec?.ev.length ?? 0, file: this.lastFile ? path.basename(this.lastFile) : null },
      taught: port ? [...new Set((this.learned[port]?.entries ?? []).map((e) => partOf(e)).filter((x): x is string => !!x))] : [],
    };
  }
}

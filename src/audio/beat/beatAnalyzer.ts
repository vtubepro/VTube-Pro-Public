// The studio's music analysis, as one pure class (no DOM, no worker globals): worklet hop features in → beat packets
// out. Used by the beat worker (beatWorker.ts) and, unchanged, by the Node bench / unit tests (tools/beat/*), so the
// numbers we measure are the code that runs.
//
//   BeatEngine v8 (beatEngine.ts)   tempo, phase, downbeat, kick / snare / hat onsets, raw arrangement cues
//   VoiceGate (voiceGate.ts)        music vs talking (+ the lip-sync mic hint): talking never fires the lights
//   GrooveTracker (shared/groove.ts) the kick / snare pattern on the grid (feel, hits, swing, where the bar starts)
//   Arranger (below)                STABLE sections on bar lines with hysteresis (intro / groove / build / drop /
//                                   breakdown), 8-bar phrases, a drop that lands ON the downbeat the kick returns,
//                                   and a 0..1 intensity relative to the track's own loud parts
//
// Packets stay compatible with older OBS pages (shared/lightShow.ts BeatPacket: talking = `on: false`); the new
// fields (md, mc, kp, pb, pid, ...) are optional.
import { BeatEngine } from './beatEngine.ts';
import { VoiceGate, AUDIO_MODES, type AudioMode } from './voiceGate.ts';
import { EV_BEAT, EV_DOWN, EV_DROP, EV_HARD, EV_HAT, EV_KICK, EV_SNARE, SECTIONS, type BeatPacket } from '../../../shared/lightShow.ts';
import { FeelLatch, GrooveTracker, feelToWire, grooveToWire, type GrooveState } from '../../../shared/groove.ts';
import { DrumOnsets, type DrumHit } from './drumOnsets.ts';

export type Section = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown';
const KICK_LAG = 30, SNARE_LAG = 35;
const SEC_INDEX: Record<Section, number> = { intro: 1, groove: 2, build: 3, breakdown: 4, drop: 5 };

/** What one hop produced (the bench scores these; the worker packetises them). */
export interface HopResult {
  t: number; on: boolean; locked: boolean; bpm: number; conf: number; section: string; energy: number;
  kick: boolean; snare: boolean; beat: boolean; down: boolean; drop: boolean; talk: boolean; music: number;
  mode: AudioMode;
  /** when a kick was detected: its back-dated time (engine ms) */
  kickT?: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Stable arrangement on the beat grid. */
export class Arranger {
  section: Section = 'intro';
  /** bumps on every section change and every 8 bars inside a section (deterministic look rotation on receivers) */
  phraseId = 0;
  /** beat within the current 8-bar phrase (0..31) */
  phraseBeat = 0;
  intensity = 0;
  /** share of recent beats with a kick / low-band hit on them */
  kickPresence = 0;
  dropId = 0;
  private hadGroove = false;
  private sectionBar = 0;      // bar index where the current section started
  private lastBar = NaN;
  private cand: Section | null = null; private candBars = 0;
  private beatLow: number[] = [];   // per-beat low-band peak (normalised)
  private lastBeatK = NaN; private beatPeak = 0;
  private lowPeak = 0.05;
  private lst = -60; private lmid = -60; private ref = -120;
  /** the loud reference (dB of the band power): under ~-48 the input is very quiet (the meter says turn it up) */
  get refDb() { return this.ref; }
  private dropI = 0;
  private lastT = NaN;
  private armedDrop = false;

  reset() { Object.assign(this, new Arranger()); }

  /** Per hop. `bar`/`barBeat`/`beatK` from the grid (NaN when unlocked). Returns true when a drop lands on this hop. */
  push(t: number, row: ArrayLike<number>, g: { locked: boolean; beatK: number; bar: number; barBeat: number; nearBeat: boolean; nearDown: boolean; kickHit: boolean; engineSection: string; tension: number; engineDrop: boolean; silent: boolean }): boolean {
    const dt = Number.isFinite(this.lastT) ? Math.min(0.2, Math.max(0, (t - this.lastT) / 1000)) : 0.0107;
    this.lastT = t;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    // ---- loudness relative to this track's loud parts (dB), and the intensity curve
    let p = 0; const w = [0.6, 1, 1, 1, 1, 0.8]; for (let b = 0; b < 6; b++) p += w[b] * row[b] * row[b];
    const db = 10 * Math.log10(p + 1e-12);
    this.lst += (db - this.lst) * k(0.25);
    this.lmid += (this.lst - this.lmid) * k(1.2);
    if (!g.silent) this.ref = Math.max(this.lmid, this.ref - dt * 0.12);     // ~1 dB per 8 s
    const rel = clamp01((this.lmid - (this.ref - 16)) / 16);
    // ---- kick presence on the grid: the low band's peak around each beat
    // the isolated 48-90 Hz kick transient (channel 11): a snare body / riser / bass line can't fake it
    const low = row.length > 11 ? row[11] : row[0];
    this.lowPeak = Math.max(low, this.lowPeak * Math.exp(-dt / 20), 1e-5);
    if (g.locked && Number.isFinite(g.beatK)) {
      if (g.beatK !== this.lastBeatK) {
        if (Number.isFinite(this.lastBeatK)) { this.beatLow.push(this.beatPeak); if (this.beatLow.length > 8) this.beatLow.shift(); }
        this.lastBeatK = g.beatK; this.beatPeak = 0;
      }
      this.beatPeak = Math.max(this.beatPeak, low / this.lowPeak);   // anywhere in the beat (boom-bap / 2-step kicks sit on the 'and')
    } else if (g.kickHit) { this.beatLow.push(1); if (this.beatLow.length > 8) this.beatLow.shift(); }
    // last 2 bars: any pattern with >= 2 kicks a bar reads 1, kick gone for a bar reads <= 0.5
    const kp = Math.min(1, this.beatLow.filter((v) => v > 0.35).length / 4);
    this.kickPresence += (kp - this.kickPresence) * k(0.4);
    const target = g.silent ? 0 : clamp01(0.78 * Math.pow(rel, 1.3) + 0.22 * this.kickPresence);
    this.intensity += (target - this.intensity) * k(target > this.intensity ? 0.3 : 1.0);

    // ---- drops land immediately: the kick returns on a downbeat after a build / breakdown
    let drop = false;
    const kickIn = g.kickHit || (g.nearDown && low / this.lowPeak > 0.5);
    if ((this.section === 'build' || this.section === 'breakdown') && this.hadGroove) this.armedDrop = true;
    if (this.armedDrop && (g.engineDrop || (g.nearDown && kickIn && this.lmid > this.ref - 9))) {
      drop = true; this.armedDrop = false; this.dropId++; this.dropI = rel;
      this.change('drop', Number.isFinite(g.bar) ? g.bar : this.lastBar);
    } else if (this.section === 'intro' && g.nearDown && kickIn && this.kickPresence > 0.15) {
      // the first kicks after an intro: the groove starts on that downbeat (a lift, not a drop)
      this.hadGroove = true; this.change('groove', Number.isFinite(g.bar) ? g.bar : this.lastBar);
    }
    // ---- everything else decides on bar lines, with hysteresis
    const bar = Number.isFinite(g.bar) ? g.bar : Math.floor(t / 2000);
    if (bar !== this.lastBar) {
      const prevBar = this.lastBar;
      this.lastBar = bar;
      if (Number.isFinite(prevBar)) this.onBar(bar, g, rel);
    }
    const inSec = Number.isFinite(g.bar) ? Math.max(0, g.bar - this.sectionBar) : 0;
    this.phraseBeat = Number.isFinite(g.barBeat) ? ((inSec % 8) * 4 + g.barBeat) : 0;
    return drop;
  }

  private onBar(bar: number, g: { engineSection: string; tension: number; engineDrop: boolean; silent: boolean }, rel: number) {
    if (g.silent) return;
    const kick = this.kickPresence > 0.3;
    const rising = g.engineSection === 'buildup' || g.tension > 0.45;
    let want: Section;
    if (!kick) want = rising && this.hadGroove ? 'build' : this.hadGroove ? 'breakdown' : 'intro';
    else if (this.section === 'drop' && bar - this.sectionBar < 32 && rel > this.dropI - 0.25) want = 'drop';
    else want = 'groove';
    if (kick) this.hadGroove = true;
    const dwell = bar - this.sectionBar;
    // the candidate must hold for 2 bar checks (builds: 1 — they are short); every section stays >= 4 bars
    if (want === this.section) { this.cand = null; this.candBars = 0; }
    else {
      if (want === this.cand) this.candBars++; else { this.cand = want; this.candBars = 1; }
      const need = want === 'build' ? 1 : 2;
      if (this.candBars >= need && dwell >= 4) this.change(want, bar);
    }
    // a new phrase every 8 bars inside a section
    if (bar !== this.sectionBar && (bar - this.sectionBar) % 8 === 0) this.phraseId++;
  }

  private change(s: Section, bar: number) {
    if (s === this.section && s !== 'drop') return;
    this.section = s; this.sectionBar = Number.isFinite(bar) ? bar : 0; this.cand = null; this.candBars = 0; this.phraseId++;
  }
}

export class BeatAnalyzer {
  engine = new BeatEngine();
  gate = new VoiceGate();
  arr = new Arranger();
  sid = Math.random().toString(36).slice(2, 10);
  /** events accumulated since the last packet */
  ev = 0;
  kickAt = -1e9; snareAt = -1e9;
  last: Record<string, any> | null = null;
  lastT = 0;
  private hatHigh = false;
  private mode: AudioMode = 'silence';
  /** the groove on the analyser's own grid (sent as gf / gc / gh / gw) */
  readonly groove = new GrooveTracker();
  /** true-time kick / snare onsets for the groove (and, in the packets as `go`, for the helper's music clock) */
  readonly drums = new DrumOnsets();
  private goHits: DrumHit[] = [];
  private gEpoch = -1; private gAnchor = NaN; private gPeriod = 0; private gSentAt = -1e9; private gKey = ''; private gLastT = -1e9;
  /** the show feel, latched HERE and sent as `sf` (shared/groove.ts FeelLatch): every page copies it */
  readonly feel = new FeelLatch();
  private feelDropT = -1e9;

  /** The lip-sync mic's voice activity (0..1) — the host is talking. */
  micVoice(v: number, t: number) { this.gate.mic(v, t); }

  resetInput(t: number) { this.engine.resetInput(t); this.arr.reset(); this.groove.reset(); this.gEpoch = -1; this.gLastT = -1e9; this.sid = Math.random().toString(36).slice(2, 10); }

  /** The groove learner rides the engine's published grid: beat position = (t − anchor) / period. A re-anchor renumbers
   *  the beats, so the learned pattern is rotated with it (same tempo), or forgotten (a new tempo). */
  private feedGroove(t: number, locked: boolean, P: number, hits: DrumHit[]) {
    const e = this.engine, g = this.groove;
    if (!locked || !e.anchorSet || !(P > 0)) return;
    if (e.anchorEpoch !== this.gEpoch) {
      // the learned pattern is kept only across a renumbering of the SAME music: a continuous re-anchor (no unlocked gap:
      // a re-lock after silence / a pause is the next song) at the same tempo (a confirmed change > 3 % = a new track);
      // the same instant on both grids gives the shift
      const cont = this.gEpoch >= 0 && t - this.gLastT < 500 && this.gPeriod > 0 && Math.abs(P / this.gPeriod - 1) < 0.03 && Number.isFinite(this.gAnchor);
      if (cont) g.rebase((t - e.anchorMs) / P - (t - this.gAnchor) / this.gPeriod);
      else g.reset();
      this.gEpoch = e.anchorEpoch;
    }
    this.gLastT = t;
    this.gAnchor = e.anchorMs; this.gPeriod = P;
    const pos = (x: number) => (x - e.anchorMs) / P;
    for (const h of hits) g.hit(h.kind, pos(h.t), Math.max(0.5, h.w));
    g.tick(pos(t));
    const gs = g.state;
    // (only a wrong PARITY under a half-time feel — the one case the groove reads reliably on real music; the engine's
    // own bar model, which reads the low band + backbeat + chord changes, stays in charge otherwise)
    if (!e._manualBar && !e.externalClock && gs.barConf >= 0.7 && gs.feel === 'half' && (((gs.barShift - e._downbeatSlot) % 2) + 2) % 2 === 1) e._downbeatSlot = gs.barShift;
  }
  /** The groove packet fields: when they change, and once a second. */
  private grooveFields(t: number): Partial<BeatPacket> {
    const gs: GrooveState = this.groove.state;
    const w = grooveToWire(this.engine._downbeatSlot === gs.barShift ? gs : { ...gs, hits: gs.hits.map((h) => { const d = (gs.barShift - this.engine._downbeatSlot) * 4; const slot = (((h.slot + d) % 16) + 16) % 16; return { ...h, slot, pos: slot / 4 + (h.pos - h.slot / 4) }; }) });
    w.sf = feelToWire(this.feel.feel);
    const key = `${w.gf}|${w.gc}|${w.gh.join(',')}|${w.sf}`;
    if (key === this.gKey && t - this.gSentAt < 1000) return {};
    this.gKey = key; this.gSentAt = t;
    return w;
  }

  pushHop(t: number, row: ArrayLike<number>): HopResult {
    const e = this.engine;
    e.pushBandHop(t, row);
    const s = e.sample(t);
    this.last = s; this.lastT = t;
    const silent = e._silentMs > 600;
    const comb = e._stableGrid.lastComb;
    const pulse = e.locked && comb ? clamp01((comb.s - 0.3) / 0.4) : 0;
    const mode = this.gate.push(t, row, pulse, silent);
    this.mode = mode;
    // (no tracker reset after long talking: measured, the grid re-locks faster and the downbeat stays right without)
    const music = mode === 'music' || mode === 'mixed';
    // ---- grid geometry for the arranger
    const locked = !!s.locked && s.bpm >= 40 && music;
    const P = e._period();
    let beatK = NaN, bar = NaN, barBeat = NaN, nearBeat = false, nearDown = false;
    if (locked && e.anchorSet && P) {
      const x = (t - e.detectLatencyMs - e.leadMs - e.anchorMs) / P;
      beatK = Math.round(x);
      const fromDown = beatK - e._downbeatSlot;
      bar = Math.floor(fromDown / 4); barBeat = ((fromDown % 4) + 4) % 4;
      nearBeat = Math.abs(x - beatK) * P < 60;
      nearDown = nearBeat && barBeat === 0;
    }
    const engineDrop = !!s.dropHit && music;
    const dropNow = music ? this.arr.push(t, row, { locked, beatK, bar, barBeat, nearBeat, nearDown, kickHit: !!s.kickHit, engineSection: s.section, tension: s.tension || 0, engineDrop, silent }) : false;
    if (!music) this.arr.push(t, row, { locked: false, beatK: NaN, bar: NaN, barBeat: NaN, nearBeat: false, nearDown: false, kickHit: false, engineSection: 'listening', tension: 0, engineDrop: false, silent: true });
    // ---- events (none while talking / silent; unlocked beats while voice is present are the voice → dropped)
    const allow = music;
    const kick = allow && !!s.kickHit, snare = allow && !!s.snareHit;
    const beat = allow && !!s.beat && (locked || mode === 'music'), down = allow && !!s.downbeat && locked;
    // the engine reports a kick / snare when its envelopes have risen (measured 17-60 ms after the onset, median ~50):
    // the packet's age back-dates it by the safe minimum, so receivers place it nearer the real hit (never early)
    if (kick) { this.ev |= EV_KICK; this.kickAt = t - KICK_LAG; }
    if (snare) { this.ev |= EV_SNARE; this.snareAt = t - SNARE_LAG; }
    const dh = music ? this.drums.push(t, row) : (this.drums.push(t, row), []);
    for (const h of dh) { this.goHits.push(h); if (this.goHits.length > 16) this.goHits.shift(); }
    this.feedGroove(t, locked, P, dh);
    if (dropNow) this.feelDropT = t;
    if (locked && Number.isFinite(bar)) this.feel.step(bar, this.groove.state, this.arr.section === 'build' || t - this.feelDropT < 64 * P);
    if (beat) this.ev |= EV_BEAT;
    if (down) this.ev |= EV_DOWN;
    if (allow && s.hard) this.ev |= EV_HARD;
    if (dropNow) this.ev |= EV_DROP;
    const hh = allow && s.hat > 0.6;
    if (hh && !this.hatHigh) this.ev |= EV_HAT;
    this.hatHigh = hh;
    return { t, on: music && !silent, locked, bpm: locked ? s.bpm : 0, conf: s.confidence || 0, section: music ? SECTIONS[SEC_INDEX[this.arr.section]] : mode === 'talk' ? 'talk' : 'listening',
      energy: music ? this.arr.intensity : 0, kick, snare, beat, down, drop: dropNow, talk: mode === 'talk', music: this.gate.music, mode, kickT: kick ? t - KICK_LAG : undefined };
  }

  /** Packet for "now" (call after pushHop; clears the accumulated events). */
  packet(base = 0, st: Record<string, any> | null = this.last, t = this.lastT): BeatPacket {
    const s = st ?? {};
    const sp = s.spectrum ?? {};
    const music = this.mode === 'music' || this.mode === 'mixed';
    const on = music && this.engine._silentMs < 600;
    const bpm = on && s.locked && s.bpm >= 40 ? s.bpm : 0;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const p: BeatPacket = {
      sid: this.sid, t: Math.round((t + base) * 10) / 10, on,
      bpm: r3(bpm), bi: bpm ? s.beatIndex | 0 : 0, ph: bpm ? r3(s.phase || 0) : 0, bar: bpm ? (s.barBeat | 0) : 0,
      cf: r3(s.confidence || 0), lk: !!bpm, ev: this.ev,
      e: r3(on ? this.arr.intensity : 0), lo: r3(on ? Math.max(sp.sub || 0, sp.bass || 0) : 0), mi: r3(on ? Math.max(sp.lowMid || 0, sp.mid || 0) : 0), hi: r3(on ? Math.max(sp.highMid || 0, sp.high || 0) : 0),
      k: r3(on ? s.kick || 0 : 0), s: r3(on ? s.snare || 0 : 0), h: r3(on ? s.hat || 0 : 0), d: r3(on ? s.drop || 0 : 0),
      sec: on ? SEC_INDEX[this.arr.section] : 0,
      md: AUDIO_MODES.indexOf(this.mode), mc: r3(this.gate.music), kp: r3(on ? this.arr.kickPresence : 0),
      pb: on ? this.arr.phraseBeat : 0, pid: this.arr.phraseId, dc: this.arr.dropId,
      ...(on && bpm ? this.grooveFields(t) : {}),
    };
    if (on && this.goHits.length) p.go = this.goHits.flatMap((h) => [Math.max(0, Math.round(t - h.t)), Math.round(Math.max(0.05, Math.min(1, h.w)) * 100) * (h.kind === 'kick' ? 1 : -1)]);
    this.goHits = [];
    if (this.ev & EV_KICK) p.ka = Math.max(0, Math.round(t - this.kickAt));
    if (this.ev & EV_SNARE) p.sa = Math.max(0, Math.round(t - this.snareAt));
    this.ev = 0;
    return p;
  }

  /** Scene-tab meter (also the "is it working" panel). */
  meter() {
    const s = this.last ?? {};
    const sp = s.spectrum ?? {};
    const on = (this.mode === 'music' || this.mode === 'mixed') && this.engine._silentMs < 600;
    return { on, bpm: s.bpm || 0, locked: !!s.locked && on, conf: s.confidence || 0, grid: s.gridStatus || '', section: on ? this.arr.section : this.mode === 'talk' ? 'talk' : 'listening',
      bands: [sp.sub, sp.bass, sp.lowMid, sp.mid, sp.highMid, sp.high].map((v) => v || 0), kick: s.kick || 0, snare: s.snare || 0, hat: s.hat || 0, energy: on ? this.arr.intensity : 0, beat: s.barBeat || 0,
      mode: this.mode, music: this.gate.music, talk: this.gate.talk, kp: this.arr.kickPresence, phraseBeat: this.arr.phraseBeat, quiet: on && this.arr.refDb < -48 };
  }
}

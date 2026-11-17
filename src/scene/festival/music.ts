// The music the festival show follows (shared/festivalDirector.ts MusicState), from - in order of preference:
//   1. a DJ-software music clock (the djsync lane: Pro DJ Link phrases, Ableton Link, OS2L …): the same 'beat' packets
//      with optional extra fields (`phrase: {kind, next, nextInBeats, known}`, `src`) - read here when present, so a
//      known drop is counted down exactly. Thin adapter: the packets are tapped on their way into the page's BeatClock
//      (wrapping beatClock.push), nothing in beatClock.ts / lightShow.ts changes. `ingestClock()` is the hook for a
//      separate clock message once it exists.
//   2. the studio's audio beat engine (today's BeatPacket: tempo, phase, kicks, energy, sections) - always underneath;
//      a build's drop is PREDICTED on the next 8-bar phrase boundary (known = false),
//   3. no music: a built-in 150 BPM hardstyle arrangement that is a pure function of the wall clock (every page, OBS
//      included, plays the same moment): groove → breakdown → build (counted down) → drop, 48 bars per cycle.
// Never plays or captures sound: it only reads the beat clock's numbers.
import { BeatClock, beatClock, epochNow } from '../beatClock.ts';
import { musicClock as rxClock } from '../musicClockRx.ts';
import { SECTION_OF_PACKET, type MusicState } from '../../../shared/festivalDirector.ts';
import type { Section } from '../../../shared/festivalLooks.ts';
import { FeelLatch, planFor, rhythmMode } from '../../../shared/groove.ts';

export const AUTO_BPM = 150;
/** The auto arrangement (bars): groove 8 · breakdown 8 (no kick) · build 8 (snare roll, no kick) · drop 16 · groove 8. */
const AUTO_PLAN: { sec: Section; bars: number; kick: boolean }[] = [
  { sec: 'groove', bars: 8, kick: true }, { sec: 'breakdown', bars: 8, kick: false }, { sec: 'build', bars: 8, kick: false },
  { sec: 'drop', bars: 16, kick: true }, { sec: 'groove', bars: 8, kick: true },
];
const AUTO_BARS = AUTO_PLAN.reduce((a, p) => a + p.bars, 0);

/** the auto show's beat counter wraps every 64 cycles (beats; a long scripted show crossing the wrap stays in step) */
export const AUTO_WRAP = AUTO_BARS * 4 * 64;
/** The auto show at wall-clock epoch ms (pure). */
export function autoMusic(ms: number, bpm = AUTO_BPM): MusicState {
  const per = 60000 / bpm;
  const cycBeats = AUTO_BARS * 4;
  // (beats wrap every 64 cycles ≈ 82 min: the shaders get small numbers - 32-bit floats - and every page still agrees)
  const beat = (ms / per) % (cycBeats * 64);
  const bi = Math.floor(beat);
  const cyc = Math.floor(bi / cycBeats), c = bi - cyc * cycBeats;
  let at = 0, k = 0;
  for (; k < AUTO_PLAN.length; k++) { if (c < at + AUTO_PLAN[k].bars * 4) break; at += AUTO_PLAN[k].bars * 4; }
  const p = AUTO_PLAN[k];
  const start = cyc * cycBeats + at;
  const dropBeat = cyc * cycBeats + 24 * 4;                         // groove 8 + breakdown 8 + build 8
  const lastDrop = c >= 24 * 4 ? dropBeat : dropBeat - cycBeats;
  const ph = beat - bi;
  const prev = AUTO_PLAN[(k + AUTO_PLAN.length - 1) % AUTO_PLAN.length].sec;
  const buildK = p.sec === 'build' ? (c - at + ph) / (p.bars * 4) : 0;
  return {
    live: false, bpm, beat, barPos: ((beat % 4) + 4) % 4, bar: Math.floor(bi / 4),
    section: p.sec, sectionStart: start, prevSection: prev,
    energy: p.sec === 'breakdown' ? 0.3 : p.sec === 'build' ? 0.5 + 0.45 * buildK : p.sec === 'drop' ? 1 : 0.75,
    kick: p.kick ? Math.exp(-ph * 5) : 0, snare: p.sec === 'build' ? Math.exp(-((ph * (buildK > 0.75 ? 4 : buildK > 0.5 ? 2 : 1)) % 1) * 6) : bi % 2 ? Math.exp(-ph * 6) : 0, hat: Math.exp(-((ph * 2) % 1) * 8),
    kickOn: p.kick,
    lastDrop, dropCount: cyc + (c >= 24 * 4 ? 1 : 0),
    nextDrop: p.sec === 'build' || p.sec === 'breakdown' ? dropBeat : null, known: true,
  };
}

interface ClockExt { kind?: string; next?: string; nextInBeats?: number; known?: boolean; startBeat?: number }

export class FestivalMusic {
  /** the beat clock it reads (the page's, or a private one for replays) */
  clock: BeatClock = beatClock;
  /** manual time for test pages / replays (epoch ms), null = the real clock */
  manualAt: number | null = null;
  /** the drop beat the music clock announced last ("drop in N beats") */
  private clockDrop: number | null = null;
  /** the tempo of the built-in show when no music plays (test pages run 200 / 230 BPM flash checks with it) */
  autoBpm = AUTO_BPM;
  private secName: Section = 'intro';
  private secStart = 0;
  private prevSec: Section = 'intro';
  private lastDropBeat = -Infinity;
  private dropSeq = -1;
  private drops = 0;
  private kickWas = false;
  private kickStop = -Infinity;
  private snareSeq = -1;
  private snares: number[] = [];
  private rollPeak = 0;
  private engineBuild = false;
  private swell: [number, number][] = [];
  /** the latest DJ-software phrase info (from packet extensions or ingestClock) and when it arrived */
  private ext: { phrase: ClockExt; beatAt: number; at: number } | null = null;
  /** where the music came from in the last frame (debug) */
  source: 'auto' | 'audio' | 'clock' = 'auto';
  /** the snare-roll density (hits / s) and how the drop was found (debug) */
  roll = 0; dropBy = '';

  /** a raw packet on its way into the clock (the tap installed by tapBeatClock) */
  sniff(raw: unknown) {
    const p = raw as { phrase?: ClockExt; bi?: number; ph?: number } | null;
    if (p && p.phrase && typeof p.phrase === 'object') this.ext = { phrase: p.phrase, beatAt: (p.bi ?? 0) + (p.ph ?? 0), at: this.now() };
  }
  /** a separate music-clock message (shared/musicClock.ts once it lands): only the phrase fields are read here */
  ingestClock(c: { phrase?: ClockExt; beat?: number }) {
    if (c?.phrase) this.ext = { phrase: c.phrase, beatAt: typeof c.beat === 'number' ? c.beat : NaN, at: this.now() };
  }
  /** read the music this far ahead (ms): the frame being computed reaches the screen about one frame later */
  lead = 1000 / 60;
  /** 'free' (no clear pattern) follows the onsets SMOOTHLY (~150 ms rise, ~400 ms fall): detected onsets come late, and a
   *  sharp rise a moment after the drum reads as a missed hit - with no pattern the lights don't pretend a hit */
  private onS = 0; private onT = NaN;
  private feelLatch = new FeelLatch();
  private onsetAt(t: number, raw: number): number {
    const dt = Number.isFinite(this.onT) ? Math.max(0, Math.min(0.2, (t - this.onT) / 1000)) : 1;
    this.onT = t;
    this.onS += (raw - this.onS) * (1 - Math.exp(-dt / (raw > this.onS ? 0.15 : 0.4)));
    return this.onS;
  }
  now() { return this.manualAt ?? epochNow() + this.lead; }

  frame(): MusicState {
    const t = this.now();
    const C = this.clock;
    if (!C.active(t)) { this.source = 'auto'; return autoMusic(this.manualAt ?? Date.now(), this.autoBpm); }
    if (!(C.bpm > 0)) {
      // music is playing but the grid has not locked yet (an intro without drums): a calm intro, no drops
      this.source = 'audio'; C.update(t);
      const beat = t / 500;
      return { live: true, bpm: 120, beat, barPos: ((beat % 4) + 4) % 4, bar: Math.floor(beat / 4), section: 'intro', sectionStart: Math.floor(beat / 4) * 4, prevSection: 'intro', energy: C.env.e,
        kick: 0, snare: 0, hat: 0, kickOn: false, lastDrop: -Infinity, dropCount: this.drops, nextDrop: null, known: false };
    }
    // the music clock (DJ software through the helper, shared/musicClock.ts): its phrase + "drop in N beats" win
    // (the phrase for the camera grid: ONLY the DJ clock's own phrase while that clock owns the beat grid - never the
    // BeatClock's pid / pb, which a Link clock carries copied from the audio analyser, on the analyser's own grid)
    let djPhrase: number | null = null;
    if (rxClock.active(t)) {
      const ph = rxClock.phraseAt(t), b = rxClock.beatAt(t);
      if (ph && ph.known && Number.isFinite(ph.pos) && (C as unknown as { source?: string }).source !== 'audio') djPhrase = ph.pos;
      if (ph && ph.known && Number.isFinite(b)) {
        const next = ph.dropIn !== undefined ? 'drop' : ph.next;
        this.ext = { phrase: { kind: ph.sec ?? ph.kind, next, nextInBeats: ph.dropIn ?? ph.nextIn, known: true }, beatAt: b, at: t };
      }
    }
    this.source = this.ext && t - this.ext.at < 3000 ? 'clock' : 'audio';
    C.update(t);
    const beat = C.posAt(t);
    const bar = C.barAt(t);
    const barPos = C.barPosAt(t);
    const per = 60000 / C.bpm;
    const barStart = Math.round(beat - barPos);
    // the kick: on / off, and where it stopped (snapped to the bar after the last kick: phrases end on bar lines)
    // (the kick: recent kick events, or the engine's performance energy + low band riding high - a distorted
    // hardstyle kick pegs the low band, so its kick events come sparsely)
    const kickAge = t - C.kickAt;
    // newer clocks (the reactive-lights analyser) report kick presence, the 8-bar phrase, talking and a DJ clock source
    const X = C as unknown as { kickPresence?: number; phraseId?: number; phraseBeat?: number; source?: string; talking?: (n?: number) => boolean };
    const kp = X.kickPresence;
    const kickOn = Number.isFinite(kp) ? (kp as number) > 0.4 : kickAge < per * 2.5 || (C.env.e > 0.55 && C.env.lo > 0.5);
    if (X.talking?.(t)) {
      // someone talking over no music: a calm intro, nothing fires
      return { live: true, bpm: C.bpm || 120, beat, barPos: Number.isFinite(barPos) ? barPos : 0, bar, section: 'intro', sectionStart: barStart, prevSection: this.secName, energy: Math.min(0.3, C.env.e),
        kick: 0, snare: 0, hat: 0, kickOn: false, lastDrop: this.lastDropBeat, dropCount: this.drops, nextDrop: null, known: false };
    }
    if (X.source && X.source !== 'audio') this.source = 'clock';
    // (snapped to the bar line the kick stopped on - the engine's bar grid, not beat-index multiples of 4)
    if (this.kickWas && !kickOn) this.kickStop = barStart + (barPos > 2 ? 4 : 0);
    // a riser: the low + mid bands climbing over the last 2 s (builds swell, breakdowns float)
    this.swell.push([t, C.env.lo + C.env.mi]);
    while (this.swell.length > 2 && t - this.swell[0][0] > 2000) this.swell.shift();
    const rising = this.swell.length > 4 && t - this.swell[0][0] > 1500 && this.swell[this.swell.length - 1][1] - this.swell[0][1] > 0.06;
    this.kickWas = kickOn;
    // snare roll density (hits per second over the last 2 s): a build is a kick-less roll that speeds up
    if (C.snareSeq !== this.snareSeq) { if (this.snareSeq >= 0 && Number.isFinite(C.snareAt)) this.snares.push(C.snareAt); this.snareSeq = C.snareSeq; }
    while (this.snares.length && t - this.snares[0] > 2000) this.snares.shift();
    this.roll = this.snares.length / 2;
    // sections: the DJ software's phrase when it has one, else the audio engine's tracker, corrected by the kick
    // (a DJ clock with no phrase - Ableton Link, MIDI clock - marks the source 'clock' while ext is still null)
    const ext = this.source === 'clock' ? this.ext?.phrase ?? null : null;
    let sec: Section;
    if (ext?.kind) sec = SECTION_OF_PACKET[ext.kind] ?? (/up|build/.test(ext.kind) ? 'build' : /down|bridge/.test(ext.kind) ? 'breakdown' : /chorus/.test(ext.kind) ? 'drop' : /outro/.test(ext.kind) ? 'outro' : 'groove');
    else {
      const raw = SECTION_OF_PACKET[C.section] ?? 'groove';
      const offBars = Number.isFinite(this.kickStop) ? (beat - this.kickStop) / 4 : 0;
      // the phrase the kick will most likely come back on (8 bars after it stopped)
      let due = Number.isFinite(this.kickStop) ? this.kickStop + 32 : Infinity;
      while (due < beat - 0.25) due += 32;
      const near = due - beat <= 17;
      if (!kickOn && (offBars >= 1 || raw === 'breakdown' || raw === 'build')) sec = this.roll >= 2 || raw === 'build' || (near && rising) || this.secName === 'build' ? 'build' : 'breakdown';
      else if (kickOn && (raw === 'breakdown' || raw === 'build' || raw === 'intro')) sec = 'groove';
      else sec = raw;
    }
    if (sec !== this.secName) { this.prevSec = this.secName; this.secName = sec; this.secStart = barStart; if (sec === 'build') { this.rollPeak = 0; this.engineBuild = false; } }
    if (sec === 'build') { this.rollPeak = Math.max(this.rollPeak, this.roll); if (SECTION_OF_PACKET[C.section] === 'build' || rising) this.engineBuild = true; }
    // next drop: known from the DJ software, else predicted on the 8-bar phrase after the kick stopped
    let next: number | null = null, known = false;
    if (ext && (ext.next === 'chorus' || ext.next === 'drop') && typeof ext.nextInBeats === 'number' && Number.isFinite(this.ext!.beatAt)) {
      next = Math.round(this.ext!.beatAt + ext.nextInBeats); known = ext.known !== false;
      this.clockDrop = next;
    } else if ((sec === 'build' || sec === 'breakdown') && Number.isFinite(X.phraseBeat) && Number.isFinite(X.phraseId)) {
      // the arranger's 8-bar phrase grid: the drop lands on the next phrase line
      next = Math.round(beat - (X.phraseBeat as number)) + 32;
      while (next < beat - 0.25) next += 32;
      known = X.source != null && X.source !== 'audio';
    } else if ((sec === 'build' || sec === 'breakdown') && Number.isFinite(this.kickStop)) {
      next = this.kickStop + 32;
      while (next < beat - 0.25) next += 32;
    }
    // drops: a predicted drop fires ON its beat once a dense roll confirmed the build (a tight show, no detection lag);
    // else the engine's drop event / a build turning into the kick (snapped to the predicted beat or the bar)
    if (next != null && sec === 'build' && beat >= next - 0.02 && beat < next + 1 && (known || this.rollPeak >= 4 || this.engineBuild) && Math.abs(this.lastDropBeat - next) > 4) {
      this.lastDropBeat = next; this.drops++; this.dropBy = known ? 'clock' : 'predicted';
    }
    // the DJ software's phrase flipped to the drop: the drop is the beat it announced (not when the flip arrived)
    const cd = this.clockDrop;
    if (ext && sec === 'drop' && cd !== null && beat >= cd - 0.02 && beat < cd + 8 && Math.abs(this.lastDropBeat - cd) > 4) {
      this.lastDropBeat = cd; this.drops++; this.dropBy = 'clock';
    }
    if (C.dropSeq !== this.dropSeq) {
      if (this.dropSeq >= 0 || t - C.dropAt < 4 * per) {
        const db = C.posAt(C.dropAt);
        if (Number.isFinite(db) && Math.abs(db - this.lastDropBeat) > 4) { const near = Math.round(db / 4) * 4; this.lastDropBeat = Math.abs(near - db) <= 1.6 ? near : Math.round(db); this.drops++; this.dropBy = 'engine'; }
      }
      this.dropSeq = C.dropSeq;
    }
    if (kickOn && this.prevSec === 'build' && sec !== 'build' && beat - this.secStart < 3 && Math.abs(beat - this.lastDropBeat) > 4) { this.lastDropBeat = this.secStart; this.drops++; this.dropBy = 'kick'; }
    if (beat - this.lastDropBeat >= 0 && beat - this.lastDropBeat < 2 && sec !== 'drop' && kickOn) sec = 'drop';
    // the rhythm (shared/groove.ts): the grid, the learned groove's hits, or free (no clear pattern)
    const pg = rxClock.show.frame?.groove, lg = C.grooveNow(t);
    const g = lg && lg.conf >= 0.4 && lg.feel !== 'free' ? lg : pg && pg.conf >= 0.6 ? pg : lg ?? pg, rhythm = g ? rhythmMode(g, C.locked) : 'grid';   // (the live groove first: see shared/lightDirector.ts frameFromClock)
    // the feel the 'auto' show family follows is LATCHED (shared/groove.ts FeelLatch) on the sender and copied from the
    // packets (`sf`), so every page plays the same family; only an older sender (no `sf`) leaves the page its own latch
    const local = this.feelLatch.step(bar, g, sec === 'build' || (beat - this.lastDropBeat >= 0 && beat - this.lastDropBeat < 64));
    const wf = C.showFeelNow(), showFeel = wf !== undefined ? wf : local ?? null;
    return {
      rhythm, feel: g?.feel, showFeel, half: !!g?.half && rhythm === 'groove', plan: rhythm === 'groove' && g ? planFor(g.hits, C.bpm, true) : undefined,
      onset: this.onsetAt(t, Math.max(0, Math.min(1, Math.max(Math.exp(-Math.max(0, kickAge) / 140), Math.exp(-Math.max(0, t - C.snareAt) / 170) * 0.85)))),
      live: true, bpm: C.bpm, beat, barPos, bar, phraseBeat: djPhrase,
      section: sec, sectionStart: this.secStart, prevSection: this.prevSec,
      energy: C.env.e,
      kick: Math.exp(-Math.max(0, kickAge) / 140), snare: Math.exp(-Math.max(0, t - C.snareAt) / 170), hat: Math.exp(-Math.max(0, t - C.hatAt) / 90),
      kickOn,
      lastDrop: this.lastDropBeat, dropCount: this.drops,
      nextDrop: sec === 'build' || sec === 'breakdown' ? next : null, known,
    };
  }

  /** beat position of an epoch time (manual cues) */
  beatAt(epochMs: number, m: MusicState): number {
    const dt = epochMs - this.now();
    return m.beat + dt * m.bpm / 60000;
  }

  reset() { this.secName = 'intro'; this.secStart = 0; this.prevSec = 'intro'; this.lastDropBeat = -Infinity; this.dropSeq = -1; this.drops = 0; this.kickWas = false; this.kickStop = -Infinity; this.snareSeq = -1; this.snares = []; this.rollPeak = 0; this.engineBuild = false; this.swell = []; this.ext = null; this.clockDrop = null; }
}

/** One per page. */
export const festivalMusic = new FestivalMusic();

/** Tap the page's beat clock: every packet is offered to the festival adapter before the clock sanitises it (the
 *  clock itself is unchanged). Idempotent. */
let tapped = false;
export function tapBeatClock(clock: BeatClock = beatClock) {
  if (tapped) return;
  tapped = true;
  const push = clock.push.bind(clock);
  clock.push = (raw: unknown, now?: number) => { festivalMusic.sniff(raw); return now === undefined ? push(raw) : push(raw, now); };
}

// Scripted festival shows ("endshows") and the Talk / Interview background show - the pure part (no three.js), shared by
// the OBS pages (src/scene/festival/festivalScene.ts) and the unit tests (tools/festival_script_unit.ts).
//
//  - scriptFrame(script, b): where a scripted show is `b` beats after it started (part, section, the drops around it,
//    the LED lore line, the swell node, the eyes, the level, the camera cut) - a pure function of the beat, so every
//    page plays the same show
//  - scriptCues(script, b, …): the cues near beat b, as plain cue steps with their absolute (show) beat
//  - ambientEvents(amb, seed, t): the background show's seeded moments (ripple / swell / big) around time t (ms) - the
//    same on every page; big ones are offered when due and taken only in a pause of the conversation (the caller knows)
import type { FestivalAmbient, FestivalCueStep, FestivalScript, FestivalScriptPart, ScriptSection } from './festival.ts';
import { hash3, hashStr } from './festival.ts';

export interface ScriptFrame {
  idx: number; part: FestivalScriptPart; bar: number;
  section: ScriptSection;
  /** beats (show time, 0 = the show's first downbeat) where the part started / the next and last drop / drops so far */
  partStart: number; partEnd: number; nextDrop: number | null; lastDrop: number; dropCount: number;
  /** 0..1 through the part */
  k: number;
  /** the LED lore line now ('' = none) and how long it has been up (beats) */
  text: string; textAge: number;
  swell: number; eyes: number; master: number;
  /** the camera the show cuts to now ('' = leave it) */
  cam: string;
  /** which cut of the part this is, and how far through it (0..1: a camera with a <NAME>_END empty moves over it) */
  camIdx: number; camU: number;
  /** before the first beat / after the last bar */
  before: boolean; done: boolean;
}

const EMPTY_PART: FestivalScriptPart = { bar: 0, section: 'intro' };

export function scriptFrame(sc: FestivalScript, b: number): ScriptFrame {
  const parts = sc.parts.length ? sc.parts : [EMPTY_PART];
  const bar = Math.floor(b / 4);
  let idx = 0;
  for (let i = 0; i < parts.length; i++) if (parts[i].bar * 4 <= b) idx = i;
  const part = parts[idx];
  const partStart = part.bar * 4;
  const partEnd = (idx + 1 < parts.length ? parts[idx + 1].bar : sc.bars) * 4;
  const k = Math.max(0, Math.min(1, (b - partStart) / Math.max(1, partEnd - partStart)));
  let nextDrop: number | null = null, lastDrop = -Infinity, dropCount = 0;
  for (const p of parts) {
    if (p.section !== 'drop') continue;
    const at = p.bar * 4;
    // a drop part right after another drop part is the same drop going on, not a new one
    const prev = parts[parts.indexOf(p) - 1];
    if (prev && prev.section === 'drop') continue;
    if (at <= b) { lastDrop = at; dropCount++; } else if (nextDrop === null) nextDrop = at;
  }
  let text = '', textAge = 0;
  if (part.text && part.text.length) {
    const every = Math.max(1, part.every ?? 4);
    const line = Math.min(part.text.length - 1, Math.floor((b / 4 - part.bar) / every));
    if (line >= 0) { text = part.text[line]; textAge = b - (part.bar + line * every) * 4; }
  }
  const sw = part.swell ? part.swell[0] + (part.swell[1] - part.swell[0]) * k : 0;
  let cam = '', camIdx = 0, camU = 0;
  if (part.cams && part.cams.length) {
    const per = Math.max(0.5, part.camBars ?? 2), at = Math.max(0, (b / 4 - part.bar) / per);
    camIdx = Math.floor(at); camU = at - camIdx;
    cam = part.cams[camIdx % part.cams.length];
  }
  return { idx, part, bar, section: part.section, partStart, partEnd, nextDrop, lastDrop, dropCount, k, text, textAge, swell: sw,
    eyes: part.eyes ?? 1, master: part.master ?? 1, cam, camIdx, camU, before: b < 0, done: b >= sc.bars * 4 };
}

/** The script's cues whose start beat lies in [b − back, b + ahead] (back = how long effects stay alive, ahead = launch
 *  lead for fireworks), with their show beat. */
export function scriptCues(sc: FestivalScript, b: number, back: number, ahead: number): { step: FestivalCueStep; beat: number; i: number }[] {
  const out: { step: FestivalCueStep; beat: number; i: number }[] = [];
  // (cues are sorted by their beat - the sanitiser sorts them: a binary search to the window, not a scan of every cue)
  const cs = sc.cues, lo0 = b - back - 64;
  let lo = 0, hi = cs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].bar * 4 + cs[m].at < lo0) lo = m + 1; else hi = m; }
  for (let i = lo; i < cs.length; i++) {
    const c = cs[i], at = c.bar * 4 + c.at;
    if (at > b + ahead) break;
    if (at >= b - back - c.dur) out.push({ step: c, beat: at, i });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the ambient show
export type AmbientTier = 'ripple' | 'swell' | 'big';
export interface AmbientEvent { tier: AmbientTier; at: number; n: number }
const HOUR = 3_600_000;
/** The background show's moments (epoch ms) of one tier around t: [t − back, t + ahead]. Seeded: an hour's sequence
 *  starts at the top of the hour, gaps drawn from the tier's range. */
export function ambientEvents(amb: FestivalAmbient, seed: number, t: number, back = 30_000, ahead = 4_000): AmbientEvent[] {
  const out: AmbientEvent[] = [];
  for (const tier of ['ripple', 'swell', 'big'] as AmbientTier[]) {
    const [lo, hi] = amb[tier];
    for (const h0 of [Math.floor((t - back) / HOUR) * HOUR, Math.floor(t / HOUR) * HOUR]) {
      let at = h0, n = 0;
      const ts = hashStr(tier);
      // the first moment of the hour comes after one gap (so an hour boundary never fires two at once)
      for (;;) {
        at += (lo + (hi - lo) * hash3(seed, Math.floor(h0 / HOUR) % 100_000, ts + n)) * 1000;
        if (at >= h0 + HOUR || at > t + ahead) break;
        if (at >= t - back && !out.some((e) => e.tier === tier && e.at === at)) out.push({ tier, at, n: Math.floor(h0 / HOUR) * 1000 + n });
        n++;
      }
      if (Math.floor((t - back) / HOUR) === Math.floor(t / HOUR)) break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

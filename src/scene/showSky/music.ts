// The music a show sky / beam rig reacts to: the same beat analysis the light show uses (src/scene/beatClock.ts: the
// studio's analysis -> bus 'beat' packets -> every page), or - when no music is coming in - a built-in AUTO groove that
// is a pure function of the wall clock (every page, OBS included, pulses on the same beat without any packets).
// No audio is ever played or captured here: this only reads the beat clock's numbers.
import { beatClock, epochNow, type BeatClock } from '../beatClock.ts';

export interface MusicFrame {
  /** real music input (the beat clock is live) - false = the auto groove */
  live: boolean;
  bpm: number;
  /** continuous beat position, bar number, beat within the bar 0..4 */
  beat: number; bar: number; barPos: number;
  /** event envelopes 0..1 (1 at the hit, decaying) */
  kick: number; snare: number; hat: number;
  /** smoothed levels 0..1 */
  energy: number; lo: number; mi: number; hi: number;
  /** 1 at a drop, decaying over ~8 beats; build 0..1 while a build-up runs */
  drop: number; build: number;
  /** integer beat index of the last kick / snare / drop (stable ids: the same on every page for the same music) */
  kickBeat: number; snareBeat: number; dropBeat: number;
  section: 'groove' | 'breakdown' | 'build' | 'drop';
}

/** Auto groove: 120 BPM from the Unix epoch, 64-beat cycles - 8 bars groove, 2 bars breakdown (no kick), 2 bars groove,
 *  3 bars build (snares every beat, energy rising), 1 bar snare roll, then the DROP on beat 0 of the next cycle. */
export const AUTO_BPM = 120;
export function autoMusic(ms: number): MusicFrame {
  const per = 60000 / AUTO_BPM;
  const beat = ms / per;
  const bi = Math.floor(beat), ph = beat - bi;
  const c = ((bi % 64) + 64) % 64;
  const section: MusicFrame['section'] = c < 4 ? 'drop' : c < 32 ? 'groove' : c < 40 ? 'breakdown' : c < 48 ? 'groove' : 'build';
  const kickOn = section !== 'breakdown' && c < 60;
  const snareOn = c >= 48 || bi % 2 === 1;
  const kick = kickOn ? Math.exp(-ph * 5) : 0;
  const snare = snareOn ? Math.exp(-(c >= 60 ? (ph * 4) % 1 : ph) * 6) : 0;
  const hat = Math.exp(-((ph * 2) % 1) * 8);
  const build = c >= 48 ? (c - 48 + ph) / 16 : 0;
  const energy = section === 'breakdown' ? 0.3 : section === 'build' ? 0.5 + 0.45 * build : section === 'drop' ? 1 : 0.8;
  const dropBeat = bi - c;                              // beat index of this cycle's drop
  const drop = Math.exp(-(beat - dropBeat) / 8);
  return {
    live: false, bpm: AUTO_BPM, beat, bar: Math.floor(bi / 4), barPos: ((beat % 4) + 4) % 4, kick, snare, hat, energy,
    lo: section === 'breakdown' ? 0.2 : 0.85 * (0.5 + 0.5 * kick), mi: 0.6, hi: 0.4 + 0.3 * hat, drop, build,
    kickBeat: kickOn ? bi : bi - 1, snareBeat: snareOn ? bi : bi - 1, dropBeat, section,
  };
}

/** The music now: the live beat clock when music is coming in, else the auto groove at wall-clock `ms`. */
export function musicFrame(ms: number = Date.now(), clock: BeatClock = beatClock): MusicFrame {
  const t = epochNow();
  if (!clock.active(t)) return autoMusic(ms);
  const pos = clock.posAt(t);
  const beat = Number.isFinite(pos) ? pos : t / 500;
  const bpm = clock.bpm || 120, per = 60000 / bpm;
  const env = clock.env;
  const dropAge = t - clock.dropAt;
  const sec = clock.section;
  const section: MusicFrame['section'] = sec === 'drop' || sec === 'chorus' || dropAge < per * 16 ? 'drop' : sec === 'buildup' ? 'build' : sec === 'breakdown' ? 'breakdown' : 'groove';
  const beatAt = (at: number) => (Number.isFinite(at) ? Math.floor(clock.posAt(at)) : -1);
  return {
    live: true, bpm, beat, bar: clock.barAt(t), barPos: Number.isFinite(clock.barPosAt(t)) ? clock.barPosAt(t) : ((beat % 4) + 4) % 4,
    kick: Math.exp(-Math.max(0, t - clock.kickAt) / 140), snare: Math.exp(-Math.max(0, t - clock.snareAt) / 170), hat: Math.exp(-Math.max(0, t - clock.hatAt) / 90),
    energy: env.e, lo: env.lo, mi: env.mi, hi: env.hi, drop: Number.isFinite(dropAge) ? Math.exp(-dropAge / (per * 8)) : 0,
    build: section === 'build' ? Math.min(1, env.e) : 0,
    kickBeat: beatAt(clock.kickAt), snareBeat: beatAt(clock.snareAt), dropBeat: beatAt(clock.dropAt), section,
  };
}

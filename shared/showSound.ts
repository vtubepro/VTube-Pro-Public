// Show sounds (owner, beta.12: "Studio only, everything"): nothing makes a sound on an OBS / output page. The room
// engines that used to play their own sounds there (the club's air horns, the slap gag's punches, the poll reveal
// sting) now SEND them to the studio over the local bus ({type:'showsound'}), and the studio plays them through the
// audio mixer's "Room sounds" row (src/audio/mixer/showSounds.ts). Read-aloud, the room screen video's sound and the
// tabletop narrator are played by the studio directly. Pure: the wire format + its sanitiser.
import { isSoundRef } from './emoteSounds.ts';

export type SlapKind = 'slap' | 'thud' | 'poof';
export type ShowSound =
  | { k: 'horn'; v: 'bits' | 'raid' }                                   // the club's air horn (bits / tips) and raid siren
  | { k: 'slap'; kind: SlapKind; seed: number; gain: number; rate: number } // the slap gag's punch / landing / poof
  | { k: 'sting' }                                                      // the poll winner reveal
  // an emote sound (shared/emoteSounds.ts): the helper sends it when chat uses an emote the streamer gave a sound;
  // `only` = the panel's Test button (plays on the mixer's "Only me" output, not the stream's)
  | { k: 'emote'; snd: string; gain: number; only?: boolean };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** Clean a show sound from the bus (anything else = null). */
export function sanitizeShowSound(x: unknown): ShowSound | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.k === 'horn') return o.v === 'raid' || o.v === 'bits' ? { k: 'horn', v: o.v } : null;
  if (o.k === 'slap') return o.kind === 'slap' || o.kind === 'thud' || o.kind === 'poof' ? { k: 'slap', kind: o.kind, seed: Math.floor(num(o.seed, 0, 2 ** 31, 0)), gain: num(o.gain, 0, 1.5, 1), rate: num(o.rate, 0.5, 2, 1) } : null;
  if (o.k === 'sting') return { k: 'sting' };
  if (o.k === 'emote') return isSoundRef(o.snd) ? { k: 'emote', snd: o.snd, gain: num(o.gain, 0, 1.5, 1), ...(o.only === true ? { only: true } : {}) } : null;
  return null;
}
/** Event ids: several OBS pages send the same event; the studio plays it once. */
export const showSoundId = (id: unknown): string | null => (typeof id === 'string' && /^[\w:.-]{1,80}$/.test(id) ? id : null);

// ---------------------------------------------------------------- a live stream: the studio's sound follows the OBS picture
/** The OBS page's live player sends {type:'liveclock', src, lag}: how many seconds behind its live edge it plays (2 a
 *  second). The studio's audio element aims for the same distance from ITS live edge: seek when more than 1 s off, a gentle
 *  playback-rate nudge (±8 %) while more than 50 ms off, else normal speed — so the sound stays within ~150 ms of the
 *  picture. (Both open the stream: the OBS page for the picture, the studio for the sound — it is downloaded twice.) */
export function liveSteer(o: { cur: number; edge: number; lag: number }): { seek: number | null; rate: number } {
  const target = o.edge - o.lag;
  if (!Number.isFinite(target) || !Number.isFinite(o.cur) || target < 0) return { seek: null, rate: 1 };
  const diff = o.cur - target;
  if (Math.abs(diff) > 1) return { seek: target, rate: 1 };
  if (Math.abs(diff) <= 0.05) return { seek: null, rate: 1 };
  return { seek: null, rate: Math.min(1.08, Math.max(0.92, 1 - diff * 0.5)) };
}
/** A seek target kept inside what the player can actually seek to (`ranges`: its seekable ranges, else its buffered
 *  ones); null = nothing seekable yet (don't seek). */
export function clampSeek(t: number, ranges: [number, number][]): number | null {
  if (!Number.isFinite(t) || !ranges.length) return null;
  let best: number | null = null, dist = Infinity;
  for (const [a, z] of ranges) {
    if (!(z >= a)) continue;
    const c = Math.min(z, Math.max(a, t)), d = Math.abs(c - t);
    if (d < dist) { dist = d; best = c; }
  }
  return best;
}
/** The OBS page's side: how far behind the live edge its player is (null = unknown). */
export function liveLag(v: { currentTime: number; seekable: TimeRanges; buffered: TimeRanges }): number | null {
  const r = v.seekable.length ? v.seekable : v.buffered;
  if (!r.length) return null;
  const lag = r.end(r.length - 1) - v.currentTime;
  return Number.isFinite(lag) && lag >= 0 && lag <= 120 ? Math.round(lag * 1000) / 1000 : null;
}

// Music vs talking, in real time, from the beat worklet's band features (no extra DSP on the audio thread).
// Why: the music input is often a loopback that also carries the streamer's voice (mic monitoring, Discord, a
// video with talking). Talking is rhythmic enough at the syllable rate (~4-5 Hz) that the beat tracker happily
// "finds" a tempo in it (measured: locked 75-90 % of the time on plain speech, ~150-270 light events a minute).
//
// Features (Scheirer & Slaney 1997 style, adapted to the 6 band RMS channels, one value per ~10.7 ms hop):
//   mod   syllabic modulation: the 190-1700 Hz band's dB envelope band-passed to ~2.5-8 Hz (RMS over ~1.5 s).
//         Speech swings 10-25 dB per syllable; music beds (pads, bass, hats, a groove) sit far steadier.
//   gap   share of hops in pauses (> 18 dB under the recent peak): speech stops between words, music doesn't.
//   sub   48-90 Hz share of the energy: kicks / bass. Voices have almost none.
//   pulse the beat tracker's own periodicity evidence (comb score over the last seconds), handed in by the caller.
//   mic   optional hint from the studio's lip-sync mic: the host is talking right now (0..1, -1 = unknown).
// Output: talk / music confidences 0..1 and a state with hysteresis:
//   'silence' | 'music' | 'talk' (speech, no music) | 'mixed' (talking over music).
// Entering 'talk' takes ~1 s of agreement, leaving it ~1.5 s of music evidence (no thrash).

export type AudioMode = 'silence' | 'music' | 'talk' | 'mixed';
export const AUDIO_MODES: AudioMode[] = ['silence', 'music', 'talk', 'mixed'];

const sstep = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export class VoiceGate {
  mode: AudioMode = 'silence';
  /** 0..1 */
  talk = 0;
  music = 0;
  /** features (debug / tests) */
  f = { mod: 0, gap: 0, sub: 0, pulse: 0, mic: -1 };
  private fast = NaN; private slow = NaN; private modSq = 0;
  private peakDb = -120; private gapE = 0; private subE = 0;
  private talkFor = 0; private musicFor = 0; private quietFor = 0; private pendFor = 0; private gridFor = 0; private inTalk = 0;
  private micAt = -1e9; private micV = -1;
  private last = NaN;

  /** The lip-sync mic says the host is speaking (0..1). Expires after 500 ms. */
  mic(v: number, tMs: number) { this.micV = v; this.micAt = tMs; }

  /** One worklet hop (`row` = the 15 channels). `pulse` = periodic beat evidence 0..1. `silent` = below the silence gate. */
  push(tMs: number, row: ArrayLike<number>, pulse: number, silent: boolean): AudioMode {
    const dt = Number.isFinite(this.last) ? Math.min(0.2, Math.max(0, (tMs - this.last) / 1000)) : 0.0107;
    this.last = tMs;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    const p2 = row[2] * row[2] + row[3] * row[3];
    const midDb = 10 * Math.log10(p2 + 1e-11);
    if (!Number.isFinite(this.fast)) { this.fast = this.slow = midDb; }
    this.fast += (midDb - this.fast) * k(1 / (2 * Math.PI * 8));      // low-pass ~8 Hz
    this.slow += (midDb - this.slow) * k(1 / (2 * Math.PI * 2.5));    // low-pass ~2.5 Hz
    const y = this.fast - this.slow;
    this.modSq += (y * y - this.modSq) * k(1.5);
    let tot = 0; for (let b = 0; b < 6; b++) tot += row[b] * row[b];
    const totDb = 10 * Math.log10(tot + 1e-12);
    this.peakDb = Math.max(totDb, this.peakDb - dt * 12);              // the recent loud level, falls 12 dB/s
    this.gapE += ((totDb < this.peakDb - 18 ? 1 : 0) - this.gapE) * k(2);
    this.subE += (row[0] * row[0] / Math.max(1e-12, tot) - this.subE) * k(2);
    const mic = tMs - this.micAt < 500 ? this.micV : -1;
    this.f = { mod: Math.sqrt(this.modSq), gap: this.gapE, sub: this.subE, pulse, mic };

    // ---- confidences
    const speechy = sstep(3.2, 5.5, this.f.mod) * (0.55 + 0.45 * sstep(0.04, 0.18, this.gapE));
    const bassy = sstep(0.04, 0.14, this.subE);
    const steady = sstep(4.5, 2.5, this.f.mod) * sstep(0.12, 0.03, this.gapE);
    let music = Math.max(bassy * (0.35 + 0.65 * pulse), steady * (0.4 + 0.6 * pulse), pulse > 0.8 && this.f.mod < 5 ? pulse : 0);
    let talk = speechy * (1 - 0.7 * bassy * pulse);
    if (mic >= 0) talk = mic > 0.5 ? Math.max(talk, Math.min(1, speechy * 1.6)) : talk * 0.6;   // the mic confirms / denies it is the host
    music = Math.min(1, music); talk = Math.min(1, talk);
    this.music += (music - this.music) * k(0.6);
    this.talk += (talk - this.talk) * k(0.5);

    // ---- state with hysteresis
    this.quietFor = silent ? this.quietFor + dt : 0;
    this.gridFor = pulse > 0.45 ? this.gridFor + dt : Math.max(0, this.gridFor - dt * 2);
    this.inTalk = this.mode === 'talk' ? this.inTalk + dt : 0;
    if (this.mode !== 'silence' || silent) this.pendFor = 0;
    this.talkFor = this.talk > 0.5 ? this.talkFor + dt : Math.max(0, this.talkFor - dt * 2);
    this.musicFor = this.music > 0.5 ? this.musicFor + dt : Math.max(0, this.musicFor - dt * 2);
    if (this.quietFor > 0.6) this.mode = 'silence';
    else if (this.mode === 'silence') {
      // sound starts: wait (up to 1.5 s) until it is clearly talking or clearly music — the first syllables of a
      // sentence must not count as a song (measured: ~15 light events in the first 2 s of every sentence)
      this.pendFor += dt;
      if (this.talk > 0.5 && this.music < 0.5) this.mode = 'talk';
      else if (this.music > 0.5 || this.pendFor > 1.5) this.mode = 'music';
    }
    else if (this.mode === 'music') { if (this.talkFor > 1.0) this.mode = this.music > 0.6 || this.gridFor > 2 ? 'mixed' : 'talk'; }
    else if (this.mode === 'talk') {
      // talking over a quiet backing track: a beat grid that keeps locking through it means there IS music under the
      // voice (speech alone never holds a grid: measured pulse <= 0.3) — after 3 s of that, or 8 s of talk with any
      // grid, it is 'mixed' (the lights follow the music again) instead of parking the room for the whole set
      if (this.musicFor > 1.5) this.mode = this.talk > 0.5 ? 'mixed' : 'music';
      else if (this.gridFor > 3 || (this.inTalk > 8 && pulse > 0.3)) this.mode = 'mixed';
    }
    else if (this.mode === 'mixed') { if (this.music < 0.35 && this.talkFor > 1 && this.gridFor < 1 && pulse < 0.3) this.mode = 'talk'; else if (this.talk < 0.3) this.mode = 'music'; }
    return this.mode;
  }
}

// Pure per-frame speech analysis (no Web Audio): shared by the live mic path (audioLipSync.ts) and
// offline tuning tools (tools/eval_audio.ts), so what we tune on recordings is exactly what runs live.

import { AsymEma, clamp01, smoothstep } from './filters.ts';
import { MFCC_COUNT, VOWELS, classifyVowel, mfccPow, type VisemeProfile, type Vowel } from './mfcc.ts';
import { SpeechFeatureExtractor, powerSpectrum, type SpeechFeatures } from './speechFeatures.ts';
import { VisemeClassifier, zeroVisemes, type VisemeWeights } from './visemes.ts';

export interface AudioMouth {
  level: number; // 0..1 speech energy envelope
  voiced: boolean;
  vowels: Record<Vowel, number>;
  /** Lower lip tucked under the upper teeth (F, V). */
  fv: number;
  /** Teeth-together hiss (S, Z, SH, CH). */
  sib: number;
  /** Suggested mouth shape from audio alone. */
  open: number; wide: number; pucker: number; funnel: number;
  /** Lips closing for M/B/P-type articulation (0..1). */
  closure: number;
  /** Sudden short drop of the voice inside speech (stop-consonant hold: P / B / T / K), unsmoothed (0..1). */
  gap?: number;
  /** Full viseme weights from the voice (sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, L, W, aa, E, I, O, U; sum 1). */
  visemes?: VisemeWeights;
  /** Voice pitch (Hz, 3-frame median; 0 = unvoiced / not measured) — prosody for the talking-face layer. */
  f0?: number;
  /** Pitch relative to the speaker's own running median, semitones (±12; 0 when f0 is 0). */
  pitch?: number;
  /** Frame loudness in dBFS (unclamped; shouting detection, vocalGestures.ts). With the noise filter on the voice is
   *  normalised so the performer's usual loud syllables sit near −20 dBFS. */
  dbfs?: number;
}

export function silentMouth(): AudioMouth {
  return { level: 0, voiced: false, vowels: { A: 0, I: 0, U: 0, E: 0, O: 0 }, fv: 0, sib: 0, open: 0, wide: 0, pucker: 0, funnel: 0, closure: 0, gap: 0, visemes: zeroVisemes() };
}

export interface AnalyzerTuning {
  /** dB above the noise floor where the envelope starts / saturates. */
  snrLo: number; snrHi: number;
  voicedLevel: number;
  fricLo: number; fricHi: number;
  /** Articulation dip (dB below the recent formant peak) where the lips start / fully close. */
  dipLo: number; dipHi: number;
  /** Hiss must be this many dB above the high-band noise floor, within `speechWindow` s of voicing. */
  hiSnrMin: number; speechWindow: number;
  sibLo: number; sibHi: number;
  sharpness: number;
}

export const DEFAULT_TUNING: AnalyzerTuning = {
  snrLo: 9, snrHi: 33, voicedLevel: 0.08, fricLo: -8, fricHi: 14, dipLo: 7, dipHi: 15, hiSnrMin: 8, speechWindow: 0.4, sibLo: 2, sibHi: 10, sharpness: 5,
};

export class SpeechAnalyzer {
  noiseFloor = 0.004;
  private hiFloor = -60;
  private sinceVoice = 99;
  /** sustained frication keeps its own speech context (a held "fffff" / "vvvvv" outlasts speechWindow) */
  private fricHold = 0;
  private hissRun = 0;
  private vowelPeak = -99;
  /** recent (≈400 ms) peak of formant-band energy and of the low band — for articulation dips */
  private midHist: number[] = [];
  private lowHist: number[] = [];
  private closureS = new AsymEma(60, 30);
  private env = new AsymEma(70, 28); // syllable-fast: ~14 ms attack, ~35 ms release
  private vowelS = Object.fromEntries(VOWELS.map((v) => [v, new AsymEma(30, 20)])) as Record<Vowel, AsymEma>;
  private fvS = new AsymEma(45, 18);
  private sibS = new AsymEma(45, 18);
  readonly cep = new Float32Array(MFCC_COUNT);
  gain = 1;
  tuning: AnalyzerTuning = { ...DEFAULT_TUNING };
  dbg = { fric: 0, sibil: 0, snr: 0, cepValid: false, hiSnr: 0, nasal: 0, dip: 0, closure: 0 };
  /** Articulatory features + viseme classifier (the viseme engine's audio side). */
  readonly features = new SpeechFeatureExtractor();
  readonly visemes = new VisemeClassifier();
  /** MFCCs of the last frame, computed even when the vowel matcher skips it (consonant profiles). */
  private cepAll = new Float32Array(MFCC_COUNT);
  /** speaker pitch: running log-f0 median + a 3-frame median against octave slips */
  private f0Log = 0;
  private f0N = 0;
  private f0Hist: number[] = [];
  /** this frame's spectrum as power, 10^(dB/10): computed once, shared by every band, the features and the MFCCs */
  private P = new Float64Array(0);

  constructor(public profile: VisemeProfile) {}

  /** time: waveform (−1..1), freqDb: dB spectrum (fft/2 bins, AnalyserNode convention). */
  step(time: Float32Array, freqDb: Float32Array, sampleRate: number, dt: number): AudioMouth {
    const T = this.tuning;
    let rms = 0;
    for (let i = 0; i < time.length; i++) rms += time[i] * time[i];
    rms = Math.sqrt(rms / time.length);
    // adaptive noise floor: follows quiet rooms down quickly, creeps up slowly
    this.noiseFloor = rms < this.noiseFloor ? Math.max(rms, 1e-5) : this.noiseFloor + (rms - this.noiseFloor) * 0.0015 * dt * 60;
    const snrDb = 20 * Math.log10(rms / (this.noiseFloor + 1e-7) + 1e-7);
    const levelRaw = clamp01(((snrDb - T.snrLo) / (T.snrHi - T.snrLo)) * this.gain);
    const levelPrev = this.env.v;
    const level = this.env.step(levelRaw, dt);
    // stop-consonant hold: the raw level falls away while the (smoothed) speech envelope is still up, right after
    // voicing — the ~40-100 ms silent closure of a P / B / T / K that the smoothed envelope never sees
    const gap = smoothstep(0.14, 0.04, levelRaw) * smoothstep(0.12, 0.3, levelPrev) * (this.sinceVoice < 0.3 ? 1 : 0);
    const voiced = levelRaw > T.voicedLevel;

    const hz = sampleRate / (freqDb.length * 2);
    if (this.P.length !== freqDb.length) this.P = new Float64Array(freqDb.length);
    const P = powerSpectrum(freqDb, this.P);
    const band = (lo: number, hi: number) => {
      let s = 0;
      for (let k = Math.floor(lo / hz); k < Math.min(freqDb.length, Math.ceil(hi / hz)); k++) s += P[k];
      return 10 * Math.log10(s + 1e-12);
    };
    const low = band(80, 400), f1 = band(400, 1000), mid = band(1000, 2500), hi = band(2500, 4500), vhi = band(4500, 8000);
    // nasal murmur (M/N/NG): voicing continues with the lips/tongue closed — strong hum under 400 Hz,
    // weak formant energy above it
    const nasalMetric = low - (f1 + mid) / 2;
    // Articulation closure (M/B/P and friends): formant energy collapses relative to the vowel just
    // said while voicing/hum may continue. Compare against its own recent peak → speaker-independent.
    const form = 10 * Math.log10(10 ** (f1 / 10) + 10 ** (mid / 10));
    this.midHist.push(form);
    this.lowHist.push(low);
    const keep = Math.max(4, Math.round(0.4 / Math.max(dt, 1e-3)));
    while (this.midHist.length > keep) this.midHist.shift();
    while (this.lowHist.length > keep) this.lowHist.shift();
    // formants must fall MORE than the hum: a quieter vowel drops both together (no closure),
    // an M/B keeps humming while the formants collapse
    const dip = (Math.max(...this.midHist) - form) - (Math.max(...this.lowHist) - low);
    const speaking = this.sinceVoice < 0.35;
    const closureRaw = speaking ? smoothstep(T.dipLo, T.dipHi, dip) : 0;
    const closure = this.closureS.step(closureRaw, dt);
    const fricMetric = hi + vhi - low - f1;
    // Unvoiced F/S are quiet overall — gate them on their OWN band's noise floor, and only near speech
    // (breath and keyboard noise between sentences shouldn't flash teeth).
    const hiE = 10 * Math.log10(10 ** (hi / 10) + 10 ** (vhi / 10));
    this.hiFloor = hiE < this.hiFloor ? hiE : this.hiFloor + (hiE - this.hiFloor) * 0.002 * dt * 60;
    this.sinceVoice = voiced ? 0 : this.sinceVoice + dt;
    const hiSnr = hiE - this.hiFloor;
    // a strong hiss lasting > 100 ms may start from silence ("fffff" said on its own); a held one keeps itself alive
    this.hissRun = hiSnr > T.hiSnrMin + 8 && fricMetric > T.fricLo ? this.hissRun + dt : 0;
    const inSpeech = this.sinceVoice < T.speechWindow || this.fricHold > 0 || this.hissRun > 0.1;
    const fricGate = smoothstep(T.hiSnrMin - 3, T.hiSnrMin + 3, hiSnr) * (inSpeech ? 1 : 0);
    const fric = smoothstep(T.fricLo, T.fricHi, fricMetric) * fricGate;
    // voiced frication (V / Z / DH): voicing continues while the formants sink below the vowel peak (constriction)
    // and a FLAT hiss (4.5-8 kHz as strong as 2.5-4.5 kHz - a bright vowel like EE has its F3 there, not above)
    // stays close to them; the unvoiced metric misses it because the voicing bar fills the low bands
    const vfric = voiced ? smoothstep(-12, -4, hiE - form) * smoothstep(8, 14, this.vowelPeak - form) * smoothstep(-9, -4, vhi - hi) * smoothstep(T.hiSnrMin - 3, T.hiSnrMin + 3, hiSnr) : 0;
    this.fricHold = Math.max(fric, vfric) > 0.35 ? 0.15 : Math.max(0, this.fricHold - dt);
    this.vowelPeak = voiced && form > this.vowelPeak ? form : this.vowelPeak - (vfric > 0.3 ? 0.3 : 2) * dt;
    const sibilant = smoothstep(T.sibLo, T.sibHi, vhi - hi);
    const fv = this.fvS.step(Math.max(fric, vfric) * (1 - sibilant), dt);
    const sib = this.sibS.step(Math.max(fric, vfric) * sibilant, dt);

    const useCep = voiced && fric < 0.5;
    const vowelsRaw: Partial<Record<Vowel, number>> = useCep ? classifyVowel(mfccPow(P, sampleRate, this.cep), this.profile, T.sharpness) : {};
    this.dbg = { fric: fricMetric, sibil: vhi - hi, snr: snrDb, cepValid: useCep, hiSnr, nasal: nasalMetric, dip, closure };
    const vowels = {} as Record<Vowel, number>;
    for (const v of VOWELS) vowels[v] = this.vowelS[v].step(voiced ? (vowelsRaw[v] ?? 0) : 0, dt);

    const openByVowel = vowels.A + vowels.E * 0.6 + vowels.O * 0.7 + vowels.I * 0.35 + vowels.U * 0.3;
    const out: AudioMouth = {
      level, voiced, vowels, fv, sib,
      open: clamp01(level * (0.35 + 0.9 * openByVowel) * (1 - fv * 0.8) * (1 - sib * 0.7) * (1 - closure * 0.9)),
      closure, gap, dbfs: 20 * Math.log10(rms + 1e-9),
      wide: clamp01(vowels.I * 0.9 + vowels.E * 0.5 + sib * 0.4) * level,
      pucker: clamp01(vowels.U) * level,
      funnel: clamp01(vowels.O) * level,
    };
    // viseme engine: purely additive — a failure here must never take the mic mouth down
    try {
      const sf: SpeechFeatures = this.features.step(time, freqDb, sampleRate, dt, level, voiced, P);
      const cep = useCep ? this.cep : mfccPow(P, sampleRate, this.cepAll);
      out.visemes = { ...this.visemes.step(out, sf, nasalMetric, cep, this.features.med.F3, dt) };
      this.pitchStep(out, sf.f0, sf.period, level, voiced);
    } catch {
      out.visemes = zeroVisemes();
    }
    return out;
  }

  /** f0 → out.f0 / out.pitch (semitones vs the speaker's running median). Purely additive. */
  private pitchStep(out: AudioMouth, f0raw: number, period: number, level: number, voiced: boolean) {
    const ok = voiced && period > 0.6 && level > 0.08 && f0raw >= 70 && f0raw <= 500;
    if (!ok) { this.f0Hist.length = 0; out.f0 = 0; out.pitch = 0; return; }
    this.f0Hist.push(f0raw);
    while (this.f0Hist.length > 3) this.f0Hist.shift();
    const h = [...this.f0Hist].sort((a, b) => a - b);
    const f0 = h[h.length >> 1];
    const lg = Math.log(f0);
    if (this.f0N === 0) this.f0Log = lg;
    // slow median tracker in the log domain (≈ 0.5 semitone steps while learning, then ≈ 0.07)
    const k = this.f0N < 60 ? 0.03 : 0.004;
    this.f0N++;
    this.f0Log += Math.sign(lg - this.f0Log) * k;
    out.f0 = f0;
    out.pitch = Math.max(-12, Math.min(12, (12 * (lg - this.f0Log)) / Math.LN2));
  }
}

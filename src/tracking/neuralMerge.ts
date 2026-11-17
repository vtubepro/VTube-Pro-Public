// Merge the neural viseme stream (neuralVisemes.ts, running in the voice worker) into the rule engine's AudioMouth.
//
// The neural model describes each 10 ms frame ~70–100 ms after it was spoken (window + lookahead + 10 ms chunks),
// so it only helps when the lip-sync lookahead delays the mouth by at least that much (Track tab → Voice lip-sync →
// Lip-sync lookahead 80–100 ms). `apply(a, t)` then takes the neural posteriors for the instant `t` the (delayed)
// voice frame describes and blends them into its visemes; frames that haven't arrived yet leave `a` untouched, so
// with the lookahead off the merge is a no-op. Per family:
//   vowels / approximants / fricatives   blended (mix)          — the engine's hand-tuned rules are speaker-specific;
//                                                                  the model was trained on ~90 h / 250 speakers
//   M / B / P and F / V                  max(engine, mixed)     — never weakens a seal / tuck the engine or camera found
// Envelope (level / open / closure timing) stays the engine's: the model only decides WHICH shape.
import type { AudioMouth } from './audioFeatures.ts';
import { VISEMES, normalizeVisemes, type Viseme, type VisemeWeights } from './visemes.ts';

export const NEURAL_KEY = 'vtp.neuralVisemes';
/** mix: 0..1 blend of the model into the engine's visemes; −1 = auto (0.35 with the shipped model, 0.6 once the guided
 *  setup has fitted your personal output layer — measured best on the test clip / LibriSpeech, docs/VOICE.md). */
export interface NeuralSettings { on: boolean; mix: number; /** 2 = settings since the fast model (on by default) */ v?: number }
/** On by default since the fast model (2026-09-26): with no / a short lookahead it runs nv_visemes_fast.json. */
export const DEFAULT_NEURAL: NeuralSettings = { on: true, mix: -1, v: 2 };
export const autoMix = (personal: boolean) => (personal ? 0.6 : 0.35);
export function loadNeural(): NeuralSettings {
  try {
    const s = globalThis.localStorage?.getItem(NEURAL_KEY);
    if (s) {
      const o = JSON.parse(s); const m = Number(o.mix ?? -1);
      // before v2, "off" meant "no lookahead" (the old model needed >= 80 ms): the fast model now covers that case
      return { on: o.v === 2 ? !!o.on : true, mix: m < 0 || !Number.isFinite(m) ? -1 : Math.min(1, m), v: 2 };
    }
  } catch { /* storage off */ }
  return { ...DEFAULT_NEURAL };
}
export function saveNeural(s: NeuralSettings) { try { globalThis.localStorage?.setItem(NEURAL_KEY, JSON.stringify({ ...s, v: 2 })); } catch { /* storage off */ } }
/** Which model a lookahead wants: the full one (60 ms of its own lookahead) only when the display delay covers it. */
export const modelForLookahead = (ms: number): 'full' | 'fast' => (ms >= 80 ? 'full' : 'fast');

export interface NvTimed { t: number; v: VisemeWeights }

export class NeuralMerge {
  mix = 0.5;
  /** max age mismatch (s) between the voice frame and the nearest neural frame */
  tol = 0.03;
  /** No / short lookahead (fast model): the frame for the shown instant hasn't arrived yet, so use the newest one if it
   *  is at most this much older (s). The shape then trails the voice by the model's ~35-45 ms while the jaw keeps the
   *  engine's timing. 0 = off (only the exact instant: the full model with the lookahead). */
  lagTol = 0;
  private q: NvTimed[] = [];
  private lastAct = -1e9;
  dbg = { used: false, lagMs: 0, pp: 0 };

  /** Frames with their content time on the SAME clock as apply()'s `t`. */
  push(f: NvTimed) {
    if (this.q.length && f.t <= this.q[this.q.length - 1].t) this.q.length = 0; // clock reset / stream restart
    this.q.push(f);
    while (this.q.length > 64) this.q.shift();
  }
  clear() { this.q.length = 0; }
  get newest() { return this.q.length ? this.q[this.q.length - 1].t : -Infinity; }

  apply(a: AudioMouth, t: number): AudioMouth {
    this.dbg.used = false;
    const q = this.q;
    if (!q.length || this.mix <= 0 || !a.visemes || q[q.length - 1].t < t - Math.max(this.tol, this.lagTol)) return a;
    let k = q.length - 1;
    while (k > 0 && q[k].t > t) k--;
    if (Math.abs(q[k].t - t) > this.tol && !(q[k].t <= t && t - q[k].t <= this.lagTol)) return a;
    const e = a.visemes;
    // the model hears the raw (pre-gate) signal: it never turns the gate's silence into speech — keyboard / breath /
    // background voices stay the voice gate's call; it only re-shapes what the engine already calls speech (incl. the
    // ≤ 150 ms silent holds inside it — a P's closure is silence to the envelope)
    if (Math.max(1 - (e.sil ?? 1), a.level) >= 0.04) this.lastAct = t;
    if (t - this.lastAct > 0.15) return a;
    const nv = q[k].v, m = this.mix;
    const w = {} as Record<Viseme, number>;
    for (const v of VISEMES) w[v] = (1 - m) * (e[v] ?? 0) + m * (nv[v] ?? 0);
    // the engine's dedicated closure / lip-teeth detectors (+ the worklet's raw-hiss detector) are never weakened
    w.PP = Math.max(w.PP, e.PP ?? 0);
    w.FF = Math.max(w.FF, e.FF ?? 0);
    const out = normalizeVisemes(w);
    this.dbg = { used: true, lagMs: Math.round((this.newest - t) * 1000), pp: nv.PP ?? 0 };
    return { ...a, visemes: out };
  }

  /** Offline tools: merge from a list of already-arrived frames. */
  applyFrames(a: AudioMouth, frames: NvTimed[], t: number): AudioMouth {
    this.q = frames.slice(-64);
    return this.apply(a, t);
  }
}

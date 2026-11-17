// Personal neural visemes: adapt the shipped phone model (neuralVisemes.ts) to ONE performer's voice from the
// guided setup's own recordings — in the browser, in well under a second, no GPU, nothing uploaded.
//
//   1. record   the model's GRU state (h) for every 10 ms frame of each setup step
//   2. label    held sounds ("fffff", "AAAH", "mmmmm" …): the step's phone on every voiced / hissing frame;
//               read sentences (the setup's "The quick brown fox …"): forced alignment — Viterbi over the base
//               model's own phone posteriors, constrained to the sentence's phone sequence (built-in lexicon),
//               optional silence between words
//   3. adapt    re-fit only the output layer (softmax regression on h) with an L2 pull back to the shipped
//               weights (MAP adaptation: a few hundred frames can't wreck it), + a per-phone prior correction
// The personal output layer is ~31 KB (192×40 floats) and replaces the shipped one; everything else is shared.
import { NV_PHONES, type NvModelJson } from './neuralVisemes.ts';

const PIX: Record<string, number> = Object.fromEntries(NV_PHONES.map((p, i) => [p, i]));

/** Pronunciations (ARPAbet, no stress) for the setup / test-clip scripts. Unknown words are skipped (sil-tolerant). */
export const LEXICON: Record<string, string> = {
  the: 'DH AH', quick: 'K W IH K', brown: 'B R AW N', fox: 'F AA K S', jumps: 'JH AH M P S', over: 'OW V ER', lazy: 'L EY Z IY', dog: 'D AO G',
  peter: 'P IY T ER', piper: 'P AY P ER', picked: 'P IH K T', a: 'AH', peck: 'P EH K', of: 'AH V', pickled: 'P IH K AH L D', peppers: 'P EH P ER Z',
  mama: 'M AA M AA', baba: 'B AA B AA', papa: 'P AA P AA', five: 'F AY V', fluffy: 'F L AH F IY', voices: 'V OY S IH Z',
  hello: 'HH AH L OW', my: 'M AY', name: 'N EY M', is: 'IH Z', welcome: 'W EH L K AH M', to: 'T UW', stream: 'S T R IY M', thank: 'TH AE NG K', you: 'Y UW',
  she: 'SH IY', sells: 'S EH L Z', sea: 'S IY', shells: 'SH EH L Z', by: 'B AY', shore: 'SH AO R',
};

export function scriptPhones(text: string): { phones: number[]; wordEnd: boolean[] } {
  const phones: number[] = [], wordEnd: boolean[] = [];
  for (const w of text.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean)) {
    const pr = LEXICON[w.replace(/'/g, '')];
    if (!pr) continue;
    const ps = pr.split(' ');
    ps.forEach((p, i) => { phones.push(PIX[p]); wordEnd.push(i === ps.length - 1); });
  }
  return { phones, wordEnd };
}

/**
 * Viterbi forced alignment. logp: per frame, log posteriors over NV_PHONES. Returns a phone index per frame
 * (0 = sil). States: [sil] p1 p1' p2 p2' … pn pn' [sil], a phone lasts ≥ 2 frames, silence optional between words.
 */
export function forceAlign(logp: Float32Array[], seq: { phones: number[]; wordEnd: boolean[] }): Int16Array {
  const T = logp.length, S: number[] = [], canSkip: boolean[] = [];
  // state list: sil0, then for each phone two states, and after each word an optional sil
  S.push(0); canSkip.push(true);
  seq.phones.forEach((p, i) => { S.push(p); canSkip.push(false); S.push(p); canSkip.push(false); if (seq.wordEnd[i]) { S.push(0); canSkip.push(true); } });
  const N = S.length, NEG = -1e30;
  const score = new Float64Array(N).fill(NEG), back = new Int32Array(T * N);
  score[0] = logp[0][0]; score[1] = logp[0][S[1]] ?? NEG;
  const stay = Math.log(0.7), move = Math.log(0.3);
  for (let t = 1; t < T; t++) {
    const nx = new Float64Array(N).fill(NEG);
    for (let j = 0; j < N; j++) {
      let best = score[j] + stay, arg = j;
      if (j >= 1 && score[j - 1] + move > best) { best = score[j - 1] + move; arg = j - 1; }
      // skip an optional silence state
      if (j >= 2 && canSkip[j - 1] && score[j - 2] + move > best) { best = score[j - 2] + move; arg = j - 2; }
      nx[j] = best + logp[t][S[j]];
      back[t * N + j] = arg;
    }
    score.set(nx);
  }
  // end in the last phone state or the trailing silence
  let j = score[N - 1] >= score[N - 2] ? N - 1 : N - 2;
  const lab = new Int16Array(T);
  for (let t = T - 1; t >= 0; t--) { lab[t] = S[j]; if (t > 0) j = back[t * N + j]; }
  return lab;
}

export interface AdaptSample { h: Float32Array; y: number }

/** Personal output layer: softmax regression on the GRU state, L2-anchored to the shipped weights. */
export function adaptOutput(model: NvModelJson, data: AdaptSample[], opt: { lambda?: number; epochs?: number; lr?: number } = {}) {
  const b64 = (s: string) => { const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
  const W0 = b64(model.t.ow), b0 = b64(model.t.ob);
  const K = model.phones.length, H = model.H;
  const W = Float64Array.from(W0), b = Float64Array.from(b0);
  const lambda = opt.lambda ?? 3e-3, epochs = opt.epochs ?? 60, lr = opt.lr ?? 0.05;
  const mW = new Float64Array(W.length), vW = new Float64Array(W.length), mb = new Float64Array(K), vb = new Float64Array(K);
  const gW = new Float64Array(W.length), gb = new Float64Array(K), z = new Float64Array(K);
  const n = data.length;
  if (!n) return null;
  let loss = 0;
  for (let ep = 1; ep <= epochs; ep++) {
    gW.fill(0); gb.fill(0); loss = 0;
    for (const { h, y } of data) {
      let mx = -1e30;
      for (let k = 0; k < K; k++) { let s = b[k]; const o = k * H; for (let j = 0; j < H; j++) s += W[o + j] * h[j]; z[k] = s; if (s > mx) mx = s; }
      let se = 0;
      for (let k = 0; k < K; k++) { z[k] = Math.exp(z[k] - mx); se += z[k]; }
      loss -= Math.log(z[y] / se + 1e-12);
      for (let k = 0; k < K; k++) {
        const g = z[k] / se - (k === y ? 1 : 0);
        if (Math.abs(g) < 1e-7) continue;
        gb[k] += g; const o = k * H;
        for (let j = 0; j < H; j++) gW[o + j] += g * h[j];
      }
    }
    // Adam step on mean CE + lambda * ||W - W0||²
    const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** ep, c2 = 1 - b2 ** ep;
    for (let i = 0; i < W.length; i++) {
      const g = gW[i] / n + 2 * lambda * (W[i] - W0[i]);
      mW[i] = b1 * mW[i] + (1 - b1) * g; vW[i] = b2 * vW[i] + (1 - b2) * g * g;
      W[i] -= (lr * (mW[i] / c1)) / (Math.sqrt(vW[i] / c2) + 1e-8);
    }
    for (let k = 0; k < K; k++) {
      const g = gb[k] / n + 2 * lambda * (b[k] - b0[k]);
      mb[k] = b1 * mb[k] + (1 - b1) * g; vb[k] = b2 * vb[k] + (1 - b2) * g * g;
      b[k] -= (lr * (mb[k] / c1)) / (Math.sqrt(vb[k] / c2) + 1e-8);
    }
  }
  const enc = (a: Float64Array) => { const f = Float32Array.from(a); const u = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); };
  return { ow: enc(W), ob: enc(b), loss: loss / n, n };
}

/** The shipped model with a personal output layer swapped in. */
export function withPersonal(model: NvModelJson, p: { ow: string; ob: string } | null): NvModelJson {
  return p ? { ...model, t: { ...model.t, ow: p.ow, ob: p.ob }, info: { ...(model.info ?? {}), personal: true } } : model;
}

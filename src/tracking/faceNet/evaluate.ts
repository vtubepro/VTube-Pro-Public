// "My face model": the held-out judge. On the 'judge' frames (train.ts: held-out blocks that neither training nor epoch selection
// ever read) it computes per-channel Pearson r, MAE, bias and spread against the teacher for (a) the net and (b) the MediaPipe
// scores the net would replace, and decides PER CHANNEL. A channel is taken from the net only if, on its own, all of these hold:
//
//   - the teacher moved on it (std > 0.05): a flat teacher makes r meaningless, and such a channel stays MediaPipe's;
//   - r(net) >= 0.5 (informative on its own: a net that only shrinks toward the mean can win on MAE against a noisy MediaPipe) and
//     r(net) >= r(MediaPipe) + 0.02;
//   - MAE(net) <= 0.95 x MAE(MediaPipe), and the per-frame error saving is significant (z >= 2.33, with the effective sample size
//     cut by the lag-1 autocorrelation of video frames): r alone cannot see an offset or a scale error, MAE does, and with 41
//     channels judged at once an equal net would otherwise win a few by luck;
//   - |mean(net - teacher)| <= 0.08 and std(net) / std(teacher) within 0.6..1.6 (no big offset or squashed / stretched range).
//
// Every other channel keeps the MediaPipe value (FaceNet.mask, stored in the model JSON). `adopt` = enough judge frames and at least
// three channels passed (with 41 judged at once a lone win can be luck; a useful net wins many). A channel that is worse never vetoes the rest: it is simply not used.
import { ARKIT } from '../../core/arkit.ts';
import { FACENET_CHANNELS, type FaceNet } from './net.ts';
import type { FaceFrame } from './types.ts';

export interface AdoptOpts { movingStd?: number; minGain?: number; minR?: number; maeRatio?: number; maeZ?: number; maxBias?: number; spreadLo?: number; spreadHi?: number; minChannels?: number; minFrames?: number }
export interface ChanStat { idx: number; name: string; teacherStd: number; r: number; mae: number; /** mean(pred - teacher) */ bias: number; /** std(pred) / std(teacher) */ spread: number }
export interface ChanVerdict { idx: number; name: string; ok: boolean; why: string; /** z of the per-frame |error| saving over MediaPipe (autocorrelation-corrected) */ z: number }
export interface Comparison {
  n: number; channels: number[];
  net: ChanStat[]; mp: ChanStat[];
  /** indices into `channels` whose teacher std exceeds `movingStd` */
  moving: number[];
  /** mean r over the moving channels */
  meanNet: number; meanMp: number;
  /** one verdict per entry of `channels` */
  verdict: ChanVerdict[];
  /** 52 entries, ARKIT order: 1 = take the channel from the net (what FaceNet.setMask / the model JSON store) */
  mask: Uint8Array;
  nAdopted: number;
  /** mean r over the adopted channels, net vs MediaPipe (0 when none) */
  meanNetAdopted: number; meanMpAdopted: number;
  adopt: boolean; reason: string;
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa < 1e-12 || sbb < 1e-12 ? 0 : sab / Math.sqrt(saa * sbb);
}
const stdOf = (a: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length || 1; let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2; return Math.sqrt(v / (a.length || 1)); };

/** Compare per-frame 52-vectors: teacher[i], net[i], mp[i] (ARKIT order) over `channels`. Pure; the hand-made-case entry point. */
export function compareChannels(teacher: ArrayLike<number>[], net: ArrayLike<number>[], mp: ArrayLike<number>[], channels: number[] = FACENET_CHANNELS, o: AdoptOpts = {}): Comparison {
  const movingStd = o.movingStd ?? 0.05, minR = o.minR ?? 0.5, minGain = o.minGain ?? 0.02, maeRatio = o.maeRatio ?? 0.95, maeZ = o.maeZ ?? 2.33, maxBias = o.maxBias ?? 0.08;
  const spreadLo = o.spreadLo ?? 0.6, spreadHi = o.spreadHi ?? 1.6, minChannels = o.minChannels ?? 3, minFrames = o.minFrames ?? 100;
  const n = teacher.length;
  const col = (rows: ArrayLike<number>[], c: number) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rows[i][c]; return a; };
  const T = channels.map((c) => col(teacher, c));
  const stats = (rows: ArrayLike<number>[]) => channels.map((c, k): ChanStat => {
    const p = col(rows, c), sd = stdOf(T[k]);
    let e = 0, b = 0;
    for (let i = 0; i < n; i++) { e += Math.abs(p[i] - T[k][i]); b += p[i] - T[k][i]; }
    return { idx: c, name: ARKIT[c], teacherStd: sd, r: pearson(p, T[k]), mae: e / Math.max(1, n), bias: b / Math.max(1, n), spread: sd > 1e-9 ? stdOf(p) / sd : 0 };
  });
  const sn = n ? stats(net) : channels.map((c) => ({ idx: c, name: ARKIT[c], teacherStd: 0, r: 0, mae: 0, bias: 0, spread: 0 })), sm = n ? stats(mp) : sn;
  /** z of mean(|mp err| - |net err|) over its standard error, n shrunk to n (1 - rho) / (1 + rho) for the lag-1 autocorrelation rho of the saving */
  const saveZ = (k: number) => {
    if (n < 3) return 0;
    const p = col(net, channels[k]), q = col(mp, channels[k]), d = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) { d[i] = Math.abs(q[i] - T[k][i]) - Math.abs(p[i] - T[k][i]); m += d[i]; }
    m /= n;
    let v = 0, c1 = 0;
    for (let i = 0; i < n; i++) { v += (d[i] - m) ** 2; if (i) c1 += (d[i] - m) * (d[i - 1] - m); }
    if (v < 1e-12) return m > 1e-9 ? 99 : 0;
    const rho = Math.min(0.99, Math.max(0, c1 / v)), nEff = Math.max(2, n * (1 - rho) / (1 + rho));
    return Math.max(-99, Math.min(99, m / Math.sqrt(v / n / nEff)));
  };
  const moving = sn.map((s, k) => (s.teacherStd > movingStd ? k : -1)).filter((k) => k >= 0);
  const mask = new Uint8Array(ARKIT.length);
  const verdict = sn.map((a, k): ChanVerdict => {
    const m = sm[k];
    const z = a.teacherStd > movingStd ? saveZ(k) : 0, v = (ok: boolean, why: string): ChanVerdict => ({ idx: a.idx, name: a.name, ok, why, z });
    if (a.teacherStd <= movingStd) return v(false, 'teacher never moved here: kept MediaPipe');
    if (a.r < minR) return v(false, `r ${a.r.toFixed(3)} below ${minR}: not informative enough to replace MediaPipe's value`);
    if (a.r < m.r + minGain) return v(false, `r ${a.r.toFixed(3)} not ${minGain} above MediaPipe's ${m.r.toFixed(3)}`);
    if (a.mae > m.mae * maeRatio) return v(false, `MAE ${a.mae.toFixed(3)} not clearly better than MediaPipe's ${m.mae.toFixed(3)}`);
    if (z < maeZ) return v(false, `MAE saving over MediaPipe not significant (z ${z.toFixed(1)}, need ${maeZ})`);
    if (Math.abs(a.bias) > maxBias) return v(false, `offset ${a.bias.toFixed(3)} (limit ${maxBias})`);
    if (a.spread < spreadLo || a.spread > spreadHi) return v(false, `range ratio ${a.spread.toFixed(2)} outside ${spreadLo}..${spreadHi}`);
    return v(true, `r ${a.r.toFixed(3)} vs ${m.r.toFixed(3)}, MAE ${a.mae.toFixed(3)} vs ${m.mae.toFixed(3)}`);
  });
  let meanNet = 0, meanMp = 0, nA = 0, aNet = 0, aMp = 0;
  for (const k of moving) { meanNet += sn[k].r; meanMp += sm[k].r; }
  if (moving.length) { meanNet /= moving.length; meanMp /= moving.length; }
  verdict.forEach((vd, k) => { if (vd.ok) { nA++; mask[vd.idx] = 1; aNet += sn[k].r; aMp += sm[k].r; } });
  const res: Comparison = { n, channels, net: sn, mp: sm, moving, meanNet, meanMp, verdict, mask, nAdopted: nA, meanNetAdopted: nA ? aNet / nA : 0, meanMpAdopted: nA ? aMp / nA : 0, adopt: false, reason: '' };
  if (n < minFrames) { res.reason = `only ${n} held-out frames (need ${minFrames}): not enough to judge`; mask.fill(0); res.nAdopted = 0; }
  else if (!moving.length) res.reason = 'no channel moved enough in the held-out frames to judge';
  else if (nA < minChannels) res.reason = nA ? `only ${nA} of ${moving.length} moving channels beat MediaPipe on their own (need ${minChannels}: with this many judged at once a lone win can be luck)` : `none of the ${moving.length} moving channels beat MediaPipe on its own`;
  else { res.adopt = true; res.reason = `${nA} of ${moving.length} moving channels beat MediaPipe (mean r ${res.meanNetAdopted.toFixed(3)} vs ${res.meanMpAdopted.toFixed(3)}); the rest stay MediaPipe`; }
  if (!res.adopt) { mask.fill(0); res.nAdopted = 0; }
  return res;
}

/** Run the RAW net (every covered channel, mask ignored) over the judge frames (those with a teacher) and compare with the
 *  MediaPipe scores stored on them. Pure: does not change the net. */
export function evaluateFaceNet(fn: FaceNet, judge: FaceFrame[], o: AdoptOpts = {}): Comparison {
  const fr = judge.filter((f) => f.teacher);
  const out = new Float32Array(52), preds: Float32Array[] = [];
  for (const f of fr) {
    out.fill(0);
    fn.predictAll(f, out);
    preds.push(out.slice());
  }
  return compareChannels(fr.map((f) => f.teacher!), preds, fr.map((f) => f.mp), FACENET_CHANNELS, o);
}

/** evaluateFaceNet, then store the verdict on the net: its mask keeps only the channels that passed (all zero when not adopted). */
export function judgeFaceNet(fn: FaceNet, judge: FaceFrame[], o: AdoptOpts = {}): Comparison {
  const c = evaluateFaceNet(fn, judge, o);
  fn.setMask(c.mask);
  return c;
}

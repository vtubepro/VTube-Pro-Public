// Unit tests + dropout replay benchmark for src/tracking/trackLoss.ts.   npx tsx src/tracking/trackLoss.test.ts [--bench]
// (No test runner in this repo: plain asserts, exit code 1 on failure. Pure logic: no DOM, no camera, no audio.)
import { PartMix, TrackLoss, ease, headAngle, headConsistent, headMix, type HeadPose } from './trackLoss.ts';
import { sanitizeTrackLoss, TRACK_LOSS_DEFAULTS, type TrackLossMode } from '../../shared/trackLoss.ts';
import type { TrackingFrame, Vec3 } from '../../shared/types.ts';
import * as THREE from 'three';
import type { BodyTargets } from './bodySolver.ts';

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const D2R = Math.PI / 180;
const S = sanitizeTrackLoss(undefined);

// ---- settings
ok(JSON.stringify(S) === JSON.stringify(TRACK_LOSS_DEFAULTS), 'defaults: hold / 0.5 s / 0.3 s / 150 ms');
const J = sanitizeTrackLoss({ modes: { face: 'life', body: 'bogus' }, lossS: 9, recoverS: -1, graceMs: 'x' });
ok(J.modes.face === 'life' && J.modes.body === 'hold' && J.lossS === 3 && J.recoverS === 0 && J.graceMs === 150, 'sanitize clamps + fills junk');

// ---- ease
ok(ease(0) === 0 && ease(1) === 1 && Math.abs(ease(0.5) - 0.5) < 1e-9, 'smootherstep ends');
ok(Math.abs((ease(0.001) - ease(0)) / 0.001) < 1e-4 && Math.abs((ease(1) - ease(0.999)) / 0.001) < 1e-4, 'zero velocity at both ends');

// ---- quaternion mix: the short way round, no linear euler snap
const m = headMix({ head: [170 * D2R, 0, 0], pos: [0, 0, 0] }, { head: [-170 * D2R, 0, 0], pos: [0, 0, 0] }, 0.5);
ok(Math.abs(Math.abs(m.head[0]) - Math.PI) < 1e-6, 'head slerp goes through 180°, not 0° (quaternion space)');

const mk = () => new PartMix<HeadPose>(headConsistent, headMix, () => ({ head: [0, 0, 0], pos: [0, 0, 0] }));
const P = (yawDeg: number): HeadPose => ({ head: [yawDeg * D2R, 0, 0], pos: [0, 0, 0] });
const yawOf = (h: HeadPose | null) => (h ? h.head[0] / D2R : NaN);

// ---- grace: a dropped frame never moves anything
{
  const p = mk(); let t = 0;
  for (let i = 0; i < 30; i++, t += 1 / 60) p.step(P(20), true, t, S, 'rest');
  const out = [] as number[];
  for (let i = 0; i < 8; i++, t += 1 / 60) out.push(yawOf(p.step(null, true, t, S, 'rest'))); // 133 ms < 150 ms grace
  ok(out.every((y) => Math.abs(y - 20) < 1e-6), 'grace: 133 ms missing, rest mode, nothing moved');
  const back = yawOf(p.step(P(20), true, t, S, 'rest'));
  ok(Math.abs(back - 20) < 1e-6, 'grace: return shows no jump');
}
// ---- hold holds, rest eases to rest in lossS with smooth steps
for (const mode of ['hold', 'rest'] as TrackLossMode[]) {
  const p = mk(); let t = 0;
  for (let i = 0; i < 30; i++, t += 1 / 60) p.step(P(20), true, t, S, mode);
  let prev = 20, maxStep = 0, last = 0;
  for (let i = 0; i < 120; i++, t += 1 / 60) { last = yawOf(p.step(null, true, t, S, mode)); maxStep = Math.max(maxStep, Math.abs(last - prev)); prev = last; }
  if (mode === 'hold') ok(Math.abs(last - 20) < 1e-6 && maxStep < 1e-6, 'hold: stays exactly where it was');
  else ok(Math.abs(last) < 1e-6 && maxStep < 20 * 1.9 / 30 + 0.01, `rest: reaches 0 with per-frame step ${maxStep.toFixed(2)}° (≤ 1.9× mean)`);
}
// ---- outlier rejection on re-acquire: 1-2 junk frames never reach the output
{
  const p = mk(); let t = 0;
  for (let i = 0; i < 30; i++, t += 1 / 60) p.step(P(10), true, t, S, 'hold');
  for (let i = 0; i < 60; i++, t += 1 / 60) p.step(null, true, t, S, 'hold');
  const seen: number[] = [];
  seen.push(yawOf(p.step(P(70), true, t, S, 'hold'))); t += 1 / 30;   // junk frame
  seen.push(yawOf(p.step(P(-50), true, t, S, 'hold'))); t += 1 / 30;  // junk frame
  for (let i = 0; i < 40; i++, t += 1 / 60) seen.push(yawOf(p.step(P(12), true, t, S, 'hold')));
  ok(seen.every((y) => y > 9.99 && y < 12.01), `re-acquire junk (70°, −50°) rejected: output stayed in [${Math.min(...seen).toFixed(2)}, ${Math.max(...seen).toFixed(2)}]°`);
  ok(Math.abs(seen[seen.length - 1] - 12) < 1e-6, 'recovers onto live');
}
// ---- recovery blends from the displayed pose (continuity) and ends exactly live
{
  const p = mk(); let t = 0;
  for (let i = 0; i < 30; i++, t += 1 / 60) p.step(P(0), true, t, S, 'rest');
  for (let i = 0; i < 30; i++, t += 1 / 60) p.step(null, true, t, S, 'rest');
  let prev = yawOf(p.out), maxStep = 0;
  for (let i = 0; i < 60; i++, t += 1 / 60) { const y = yawOf(p.step(P(30), true, t, S, 'rest')); maxStep = Math.max(maxStep, Math.abs(y - prev)); prev = y; }
  ok(Math.abs(prev - 30) < 1e-6 && maxStep < 3.2, `recovery: 30° reached in 0.3 s, max step ${maxStep.toFixed(2)}°/frame`);
}
// ---- the frame layer: voice life gain + mouth relaxes in hold (voice drives it) + eyes never frozen shut
{
  const L = new TrackLoss(); L.settings = sanitizeTrackLoss({ modes: { face: 'life', eyes: 'hold' } });
  const f = (tracked: boolean): TrackingFrame => ({ t: 0, tracked, head: [0.3, 0, 0], headPos: [0, 0, 0], gaze: [0.2, 0], face: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, jawOpen: 0.8, browInnerUp: 0.5 },
    mouth: { open: 0.8, wide: 0, smile: 0.3, frown: 0, pucker: 0, funnel: 0, tongue: 0 } });
  let t = 0, at = 0, o!: TrackingFrame;
  for (let i = 0; i < 20; i++, t += 1 / 60) o = L.applyFace(f(true), true, at++, t);
  ok(o.lifeGain === undefined, 'live frames pass through untouched');
  for (let i = 0; i < 90; i++, t += 1 / 60) o = L.applyFace({ ...f(false), head: [0, 0, 0], face: {} }, false, at++, t);
  ok((o.lifeGain ?? 0) > 0.99 && Math.abs(o.head[0]) < 1e-6, 'voice-life mode: life fades in, head at rest');
  ok((o.face.eyeBlinkLeft ?? 1) <= 0.3 + 1e-9 && Math.abs(o.gaze[0] - 0.2) < 1e-9, 'eyes hold: gaze held, lids never frozen shut');
  const H = new TrackLoss(); t = 0;
  for (let i = 0; i < 20; i++, t += 1 / 60) H.applyFace(f(true), true, at++, t);
  for (let i = 0; i < 90; i++, t += 1 / 60) o = H.applyFace({ ...f(false), head: [0, 0, 0], face: {} }, false, at++, t);
  ok(Math.abs(o.head[0] - 0.3) < 1e-6 && o.lifeGain === 0 && o.mouth.open < 1e-6 && (o.face.jawOpen ?? 0) < 1e-6 && Math.abs((o.face.browInnerUp ?? 0) - 0.5) < 1e-9,
    'hold: head + brows held, no voice life, mouth opening relaxed for lip sync');
}

// ---- body: an arm the solver only carries over (held) counts as lost; rest fades its confidence; hold keeps it
for (const mode of ['hold', 'rest'] as TrackLossMode[]) {
  const L = new TrackLoss(); L.settings = sanitizeTrackLoss({ modes: { body: mode } });
  const arm = (held?: boolean) => ({ upper: new THREE.Vector3(1, 0, 0), lower: new THREE.Vector3(0, 1, 0), confidence: 0.9, lowerConfidence: 0.9, held });
  const B = (a: ReturnType<typeof arm> | null): BodyTargets => ({ torso: null, arms: { left: a, right: null }, legs: { left: null, right: null }, hands: { left: null, right: null }, gestures: { left: null, right: null } });
  let t = 0, o: BodyTargets | null = null;
  for (let i = 0; i < 20; i++, t += 1 / 60) o = L.applyBody(B(arm()), t);
  for (let i = 0; i < 60; i++, t += 1 / 60) o = L.applyBody(B(i < 30 ? arm(true) : null), t);
  const c = o?.arms.left?.confidence ?? -1;
  ok(mode === 'hold' ? Math.abs(c - 0.9) < 1e-6 : Math.abs(c) < 1e-6, `body ${mode}: arm confidence ${c.toFixed(2)} after 1 s lost`);
}

// ---------------------------------------------------------------- dropout replay benchmark
// A recorded-like head trace (yaw / pitch / roll wander, 30 Hz tracker, 60 Hz display) with dropouts; the tracker
// returns junk for 2 frames on re-acquire (as MediaPipe does). LEGACY = today's pipeline (faceSolver decay e^-4t to
// rest from the first missing frame, the first re-acquired frames passed straight through, voice life's 120 ms head
// hand-over + the retargeter's 80/s de-step). NEW = this layer, per mode, defaults.
export function bench(print = true) {
  const rows: string[] = [];
  const traj = (t: number): Vec3 => [(14 * Math.sin(t * 0.9) + 5 * Math.sin(t * 2.3)) * D2R, (6 * Math.sin(t * 1.3 + 1)) * D2R, (4 * Math.sin(t * 0.7 + 2)) * D2R];
  const junk = (t: number, k: number): Vec3 => { const a = traj(t); return [a[0] + (k ? -28 : 35) * D2R, a[1] + (k ? 15 : -20) * D2R, a[2]]; };
  const dispDt = 1 / 60;
  const run = (drop: number, kind: 'legacy' | TrackLossMode) => {
    const L = new TrackLoss(); if (kind !== 'legacy') L.settings = sanitizeTrackLoss({ modes: { face: kind, eyes: kind, body: kind, hands: kind } });
    const d0 = 2, d1 = 2 + drop, T = d1 + 2;
    let solverHead: Vec3 = [0, 0, 0], sampleAt = 0, lastSample = -1, reN = 0;
    let deStep: Vec3 | null = null, jump: Vec3 = [0, 0, 0], lastShown: Vec3 | null = null, wasTracked = true;
    const out: Vec3[] = [];
    for (let t = 0; t < T; t += dispDt) {
      // tracker sample at 30 Hz
      const si = Math.floor(t * 30);
      if (si !== lastSample) {
        lastSample = si; sampleAt = si;
        const lost = t >= d0 && t < d1;
        if (lost) { reN = 0; solverHead = [solverHead[0] * Math.exp(-4 / 30), solverHead[1] * Math.exp(-4 / 30), solverHead[2] * Math.exp(-4 / 30)]; }
        else solverHead = t >= d1 && reN < 2 ? junk(t, reN++) : traj(t);
      }
      const tracked = !(t >= d0 && t < d1);
      let head: Vec3;
      if (kind === 'legacy') {
        head = solverHead;
        if (lastShown && wasTracked !== tracked) jump = [lastShown[0] - head[0], lastShown[1] - head[1], lastShown[2] - head[2]];
        wasTracked = tracked;
        const jk = Math.exp(-dispDt / 0.12); jump = [jump[0] * jk, jump[1] * jk, jump[2] * jk];
        head = [head[0] + jump[0], head[1] + jump[1], head[2] + jump[2]];
      } else {
        const fr: TrackingFrame = { t, tracked, head: solverHead, headPos: [0, 0, 0], gaze: [0, 0], face: {}, mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 } };
        head = L.applyFace(fr, tracked, sampleAt, t).head;
      }
      lastShown = head;
      // retarget de-step (80/s) in quaternion space
      deStep = deStep ? headMix({ head: deStep, pos: [0, 0, 0] }, { head, pos: [0, 0, 0] }, 1 - Math.exp(-80 * dispDt)).head : head;
      out.push(deStep);
    }
    // metrics: largest per-display-frame rotation (°) around the loss and around the re-acquire, + peak jerk (°/s³)
    const step = (i: number) => headAngle(out[i - 1], out[i]);
    const iL = Math.round(d0 / dispDt), iR = Math.round(d1 / dispDt), win = Math.round(0.6 / dispDt);
    let atLoss = 0, atRe = 0;
    for (let i = Math.max(1, iL - 2); i < Math.min(out.length, iL + win); i++) atLoss = Math.max(atLoss, step(i));
    for (let i = Math.max(1, iR - 2); i < Math.min(out.length, iR + win); i++) atRe = Math.max(atRe, step(i));
    let jerk = 0;
    const yaw = out.map((h) => h[0] / D2R);
    for (let i = Math.max(3, iL - 2); i < Math.min(out.length, iR + win); i++) jerk = Math.max(jerk, Math.abs(yaw[i] - 3 * yaw[i - 1] + 3 * yaw[i - 2] - yaw[i - 3]) / dispDt ** 3);
    // the live motion's own per-frame step, for reference
    return { atLoss, atRe, jerk };
  };
  const ref = (() => { let m = 0; for (let t = 1 / 60; t < 10; t += 1 / 60) m = Math.max(m, headAngle(traj(t - 1 / 60), traj(t))); return m; })();
  rows.push(`Head: max rotation per 60 Hz display frame (°) at loss / at re-acquire, and peak yaw jerk (k°/s³). Live motion itself peaks at ${ref.toFixed(2)}°/frame.`);
  rows.push('| dropout | legacy (today) | hold | rest | voice life |');
  rows.push('|---|---|---|---|---|');
  const res: Record<string, Record<string, ReturnType<typeof run>>> = {};
  for (const drop of [0.05, 0.2, 1, 5]) {
    const r = { legacy: run(drop, 'legacy'), hold: run(drop, 'hold'), rest: run(drop, 'rest'), life: run(drop, 'life') };
    res[drop] = r;
    const c = (x: ReturnType<typeof run>) => `${x.atLoss.toFixed(2)} / ${x.atRe.toFixed(2)} · ${(x.jerk / 1000).toFixed(0)}k`;
    rows.push(`| ${drop * 1000} ms | ${c(r.legacy)} | ${c(r.hold)} | ${c(r.rest)} | ${c(r.life)} |`);
  }
  if (print) console.log('\n' + rows.join('\n'));
  return { rows, res, ref };
}

// ---- a starved tracker (results 0.3 / 0.45 / 0.9 s apart, src/tracking/stallLife.ts): a face lost during it comes
// back (the old 0.25 s gap reset the re-acquire probe on every sparse sample: it never re-acquired)
for (const sp of [0.3, 0.45, 0.9]) {
  for (const iv of [0, sp]) {
    const p = mk(); let t = 0;
    for (let i = 0; i < 30; i++, t += 1 / 60) p.step(P(10), true, t, S, 'hold', iv);
    for (let i = 0; i < 60; i++, t += 1 / 60) p.step(null, true, t, S, 'hold', iv);   // lost for 1 s
    let back = -1;
    // sparse fresh samples, the display ticks at 60 Hz in between (repeats are not fresh)
    for (let k = 0, next = t; t < 12; t += 1 / 60) {
      const fresh = t >= next;
      if (fresh) { next += sp; k++; }
      const o = p.step(P(12), fresh, t, S, 'hold', iv);
      if (back < 0 && p.phase !== 'lost' && Math.abs(yawOf(o) - 12) < 1e-6) back = t;
    }
    if (iv === 0 && sp > 0.25) ok(back < 0, `(the latent defect: results ${sp} s apart without the starve meter never re-acquire)`);
    if (iv > 0) ok(back > 0, `results ${sp} s apart with the starve meter's spacing: the face comes back (${back > 0 ? back.toFixed(2) : 'never'} s)`);
  }
}

if (process.argv.includes('--bench')) {
  const b = bench();
  const worst = Math.max(...Object.values(b.res).flatMap((r) => [r.hold, r.rest, r.life].map((x) => Math.max(x.atLoss, x.atRe))));
  ok(worst < 3.5, `new layer: worst per-frame step ${worst.toFixed(2)}° across every dropout / mode (live motion peaks ${b.ref.toFixed(2)}°)`);
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

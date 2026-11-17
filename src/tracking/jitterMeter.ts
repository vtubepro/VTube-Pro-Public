// Live jitter meters (diagnostics only — nothing here feeds back into tracking).
//
// Each channel is a small vector in display units (degrees for rotations / directions, millimetres for
// positions). Samples are collected in 1 s windows; per window:
//   amp   RMS residual after removing the window's linear trend (= the jiggle amplitude, independent of
//         frame rate and of slow real movement)
//   spd   RMS frame-to-frame speed (units/s)
//   move  size of the linear trend over the window (real movement)
//   still whether the window looked like "holding still" (move + amp under per-channel thresholds)
// Reported: the last window, the median amp of the last 30 windows (typical, still or not), and `rest` —
// the running mean amp of still windows (the rest-jiggle number to drive to zero).
import * as THREE from 'three';

interface Win { t: number[]; v: number[][] }
interface Chan {
  win: Win; t0: number;
  last: { amp: number; spd: number; move: number; still: boolean; hz: number } | null;
  hist: number[]; rest: number; restN: number; stillAmp: number; stillMove: number;
}

export class JitterMeter {
  private ch = new Map<string, Chan>();

  /** Add a sample. `stillAmp` / `stillMove` define "holding still" for this channel (display units). */
  add(name: string, t: number, v: number[], stillAmp = 1.5, stillMove = 2) {
    let c = this.ch.get(name);
    if (!c) { c = { win: { t: [], v: [] }, t0: t, last: null, hist: [], rest: 0, restN: 0, stillAmp, stillMove }; this.ch.set(name, c); }
    if (t - c.t0 >= 1) { this.close(c); c.t0 = t; }
    const w = c.win;
    if (w.t.length && t <= w.t[w.t.length - 1]) return; // repeats / out of order
    if (w.t.length > 600) return;
    w.t.push(t); w.v.push(v.slice());
  }

  private ref = new Map<string, THREE.Quaternion>();
  private dref = new Map<string, THREE.Vector3>();
  private static _q = new THREE.Quaternion();
  private static _v = new THREE.Vector3();

  /** Rotation sample: rotation vector (deg) relative to a slowly re-anchored reference. */
  addQuat(name: string, t: number, q: THREE.Quaternion, stillAmp = 1.5, stillMove = 2) {
    let r = this.ref.get(name);
    if (!r || r.angleTo(q) > 0.5) { r = q.clone(); this.ref.set(name, r); this.resetWin(name); }
    const d = JitterMeter._q.copy(r).invert().multiply(q);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const s = Math.sqrt(Math.max(0, 1 - d.w * d.w)), ang = 2 * Math.atan2(s, d.w);
    const k = s > 1e-9 ? (ang / s) * THREE.MathUtils.RAD2DEG : 2 * THREE.MathUtils.RAD2DEG;
    this.add(name, t, [d.x * k, d.y * k, d.z * k], stillAmp, stillMove);
  }

  /** Unit-direction sample: rotation vector (deg) from a slowly re-anchored reference direction. */
  addDir(name: string, t: number, d: THREE.Vector3, stillAmp = 3, stillMove = 5) {
    let r = this.dref.get(name);
    if (!r || r.angleTo(d) > 0.5) { r = d.clone().normalize(); this.dref.set(name, r); this.resetWin(name); }
    const ax = JitterMeter._v.copy(r).cross(d);
    const s = ax.length(), ang = Math.atan2(s, r.dot(d));
    const k = s > 1e-9 ? (ang / s) * THREE.MathUtils.RAD2DEG : 0;
    this.add(name, t, [ax.x * k, ax.y * k, ax.z * k], stillAmp, stillMove);
  }

  private resetWin(name: string) { const c = this.ch.get(name); if (c) { c.win = { t: [], v: [] }; } }

  private close(c: Chan) {
    const { t, v } = c.win;
    c.win = { t: [], v: [] };
    const n = t.length;
    if (n < 5) { c.last = null; return; }
    const dims = v[0].length;
    const tm = t.reduce((a, b) => a + b, 0) / n;
    let stt = 0;
    for (const x of t) stt += (x - tm) ** 2;
    let res = 0, move2 = 0, spd = 0;
    for (let d = 0; d < dims; d++) {
      let m = 0, sty = 0;
      for (let i = 0; i < n; i++) m += v[i][d];
      m /= n;
      for (let i = 0; i < n; i++) sty += (t[i] - tm) * (v[i][d] - m);
      const b = stt > 0 ? sty / stt : 0;
      for (let i = 0; i < n; i++) res += (v[i][d] - (m + b * (t[i] - tm))) ** 2;
      move2 += (b * (t[n - 1] - t[0])) ** 2;
      for (let i = 1; i < n; i++) { const dt = Math.max(1e-3, t[i] - t[i - 1]); spd += ((v[i][d] - v[i - 1][d]) / dt) ** 2; }
    }
    const amp = Math.sqrt(res / n), move = Math.sqrt(move2);
    const still = amp < c.stillAmp && move < c.stillMove;
    c.last = { amp, spd: Math.sqrt(spd / (n - 1)), move, still, hz: n / Math.max(1e-3, t[n - 1] - t[0]) };
    c.hist.push(amp); if (c.hist.length > 30) c.hist.shift();
    if (still) { c.restN++; c.rest += (amp - c.rest) / Math.min(c.restN, 30); }
  }

  /** Compact report for state.json. */
  report(): Record<string, { amp: number; med30: number; rest: number | null; spd: number; move: number; still: boolean; hz: number } | null> {
    const out: Record<string, { amp: number; med30: number; rest: number | null; spd: number; move: number; still: boolean; hz: number } | null> = {};
    const r = (x: number) => +x.toFixed(3);
    for (const [k, c] of this.ch) {
      if (!c.last) { out[k] = null; continue; }
      const s = [...c.hist].sort((a, b) => a - b);
      out[k] = { amp: r(c.last.amp), med30: r(s[s.length >> 1] ?? 0), rest: c.restN ? r(c.rest) : null, spd: r(c.last.spd), move: r(c.last.move), still: c.last.still, hz: +c.last.hz.toFixed(0) };
    }
    return out;
  }
}

/**
 * Rolling raw-landmark recorder (binary, no JSON cost on the live thread): the last ~12 s of pose + hand
 * landmarks and the head solver's raw/filtered channels, uploaded as cache/diag/motion.bin so body /
 * head filters can be evaluated offline on real performer data (tools/eval_body.ts).
 */
export class MotionRecorder {
  static readonly POSE_N = 25;
  static readonly BODY_F = 4 + 25 * 4 + 25 * 3 + 1 + 2 * (3 + 63 + 63); // 438 floats
  static readonly FACE_F = 1 + 6 + 6 + 3;                              // t, raw rel[6], out head+pos[6], hm u,v,s
  private body: Float32Array;
  private face: Float32Array;
  private bi = 0; private bn = 0; private fi = 0; private fn = 0;
  private lastBodyId = -1;
  constructor(public bodyFrames = 400, public faceFrames = 800) {
    this.body = new Float32Array(bodyFrames * MotionRecorder.BODY_F);
    this.face = new Float32Array(faceFrames * MotionRecorder.FACE_F);
  }
  onBody(t: number, bodyId: number | undefined, aspect: number, mirror: boolean,
    pose: { landmarks?: { x: number; y: number; z: number; visibility?: number }[][]; worldLandmarks?: { x: number; y: number; z: number }[][] } | null,
    hands: { landmarks?: { x: number; y: number; z: number }[][]; worldLandmarks?: { x: number; y: number; z: number }[][]; handedness?: { categoryName: string; score: number }[][] } | null) {
    if (bodyId !== undefined && bodyId === this.lastBodyId) return;
    this.lastBodyId = bodyId ?? -1;
    const F = MotionRecorder.BODY_F, a = this.body, o = this.bi * F;
    a.fill(0, o, o + F);
    a[o] = t; a[o + 1] = bodyId ?? -1; a[o + 2] = aspect; a[o + 3] = mirror ? 1 : 0;
    const nl = pose?.landmarks?.[0], wl = pose?.worldLandmarks?.[0];
    if (nl && wl) for (let i = 0; i < MotionRecorder.POSE_N; i++) {
      const p = nl[i], w = wl[i];
      if (!p || !w) continue;
      a[o + 4 + i * 4] = p.x; a[o + 5 + i * 4] = p.y; a[o + 6 + i * 4] = p.z; a[o + 7 + i * 4] = p.visibility ?? 0;
      a[o + 104 + i * 3] = w.x; a[o + 105 + i * 3] = w.y; a[o + 106 + i * 3] = w.z;
    }
    const nh = Math.min(2, hands?.landmarks?.length ?? 0);
    a[o + 179] = nh;
    for (let h = 0; h < nh; h++) {
      const b = o + 180 + h * 129;
      const cat = hands!.handedness?.[h]?.[0];
      a[b] = 1; a[b + 1] = cat?.categoryName === 'Left' ? 1 : 0; a[b + 2] = cat?.score ?? 0;
      const L = hands!.landmarks![h], W = hands!.worldLandmarks?.[h];
      for (let i = 0; i < 21; i++) {
        a[b + 3 + i * 3] = L[i]?.x ?? 0; a[b + 4 + i * 3] = L[i]?.y ?? 0; a[b + 5 + i * 3] = L[i]?.z ?? 0;
        if (W) { a[b + 66 + i * 3] = W[i]?.x ?? 0; a[b + 67 + i * 3] = W[i]?.y ?? 0; a[b + 68 + i * 3] = W[i]?.z ?? 0; }
      }
    }
    this.bi = (this.bi + 1) % this.bodyFrames; this.bn = Math.min(this.bn + 1, this.bodyFrames);
  }
  onFace(t: number, raw: number[] | null, head: number[], pos: number[], hm: { u: number; v: number; s: number } | null) {
    const F = MotionRecorder.FACE_F, a = this.face, o = this.fi * F;
    a.fill(0, o, o + F);
    a[o] = t;
    if (raw) for (let i = 0; i < 6; i++) a[o + 1 + i] = raw[i] ?? 0;
    for (let i = 0; i < 3; i++) { a[o + 7 + i] = head[i] ?? 0; a[o + 10 + i] = pos[i] ?? 0; }
    if (hm) { a[o + 13] = hm.u; a[o + 14] = hm.v; a[o + 15] = hm.s; }
    this.fi = (this.fi + 1) % this.faceFrames; this.fn = Math.min(this.fn + 1, this.faceFrames);
  }
  /** Chronological binary snapshot: header [magic, version, BODY_F, nBody, FACE_F, nFace, fov, 0] + body + face. */
  snapshot(fovDiag: number): ArrayBuffer {
    const BF = MotionRecorder.BODY_F, FF = MotionRecorder.FACE_F;
    const out = new Float32Array(8 + this.bn * BF + this.fn * FF);
    out.set([7777, 1, BF, this.bn, FF, this.fn, fovDiag, 0]);
    let p = 8;
    for (let k = 0; k < this.bn; k++) { const i = (this.bi - this.bn + k + this.bodyFrames) % this.bodyFrames; out.set(this.body.subarray(i * BF, i * BF + BF), p); p += BF; }
    for (let k = 0; k < this.fn; k++) { const i = (this.fi - this.fn + k + this.faceFrames) % this.faceFrames; out.set(this.face.subarray(i * FF, i * FF + FF), p); p += FF; }
    return out.buffer;
  }
}

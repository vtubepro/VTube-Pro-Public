// .vtp2 behaviour per frame: everything that sets parameter values / part opacities before RigEval.update().
// Order (docs/RIG2D_FORMAT.md §6): defaults → idle motion → tracking bindings → automatic blink (untracked) → lip sync →
// one-shot motion (hotkey / cue / state) → model sliders (userParams.ts) → expressions (state machine + held expression) → physics → part switches →
// costume layers. Pure + allocation-light; unit-tested in tools/rig2d_unit.ts.
import type { TrackingFrame } from '../types.ts';
import { applyBindings, live2dAutoBindings, rig2dDrive, type Rig2DBinding, type Rig2DParamInfo, type Rig2DTune } from './drive.ts';
import { rig2dDynamics, type Rig2DCurve, type Rig2DDoc, type Rig2DExpression, type Rig2DMotion, type Rig2DPhysics } from './format.ts';
import { f32 } from './container.ts';
import type { RigEval } from './evaluate.ts';
import { Dynamics } from './dynamics.ts';
import { FollowThrough } from './follow.ts';
import { faceEmotion, type Rig2DEvent } from './world.ts';
import { SOURCE_RANGE, type Rig2DStdSource } from './drive.ts';
import { createInochiPhysicsAdapter, type InochiPhysicsAdapter } from './inochi/physicsAdapter.ts';
import { UserParamDriver, classifyParams, type ParamCue } from './userParams.ts';

const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Smooth 0..1 ease (sine). */
export const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

// ================================================================ curves
interface CurveRt { target: Rig2DCurve['target']; id: string; idx: number; fadeIn?: number; fadeOut?: number; t: Float64Array; v: Float64Array; seg: Uint8Array; ctl: Float64Array; ctlAt: Int32Array }
const arrOf = (a: number[] | { buffer: number; offset: number; count: number; type: string } | undefined, buffers: readonly Uint8Array[]): number[] => {
  if (!a) return [];
  if (Array.isArray(a)) return a;
  return Array.from(f32(buffers, a as never));
};

function prepCurve(c: Rig2DCurve, buffers: readonly Uint8Array[], idx: number): CurveRt {
  const t = Float64Array.from(arrOf(c.times, buffers)), v = Float64Array.from(arrOf(c.values, buffers)), seg = Uint8Array.from(arrOf(c.segments, buffers)), ctl = Float64Array.from(arrOf(c.controls, buffers));
  const ctlAt = new Int32Array(seg.length);
  let k = 0;
  for (let i = 0; i < seg.length; i++) { ctlAt[i] = k; if (seg[i] === 1) k += 4; }
  return { target: c.target, id: c.id, idx, ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}), t, v, seg, ctl, ctlAt };
}

/** A curve's value at time `time` (seconds). */
export function curveAt(c: { t: Float64Array; v: Float64Array; seg: Uint8Array; ctl: Float64Array; ctlAt: Int32Array }, time: number, byFraction = false): number {
  const n = c.t.length;
  if (!n) return 0;
  if (time <= c.t[0] || n === 1) return c.v[0];
  if (time >= c.t[n - 1]) return c.v[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.t[m] <= time) lo = m; else hi = m; }
  const t0 = c.t[lo], t1 = c.t[lo + 1], v0 = c.v[lo], v1 = c.v[lo + 1];
  switch (c.seg[lo]) {
    case 0: return t1 === t0 ? v1 : v0 + (v1 - v0) * (time - t0) / (t1 - t0);
    case 2: return v0;
    case 3: return v1;
    default: {
      const o = c.ctlAt[lo];
      const ct1 = c.ctl[o], cv1 = c.ctl[o + 1], ct2 = c.ctl[o + 2], cv2 = c.ctl[o + 3];
      let s: number;
      if (byFraction || t1 === t0) s = t1 === t0 ? 1 : (time - t0) / (t1 - t0);
      else {
        let a = 0, b = 1;
        for (let i = 0; i < 30; i++) {
          const m = (a + b) / 2, u = 1 - m;
          const x = u * u * u * t0 + 3 * u * u * m * ct1 + 3 * u * m * m * ct2 + m * m * m * t1;
          if (x < time) a = m; else b = m;
        }
        s = (a + b) / 2;
      }
      const u = 1 - s;
      return u * u * u * v0 + 3 * u * u * s * cv1 + 3 * u * s * s * cv2 + s * s * s * v1;
    }
  }
}

// ================================================================ motions
export interface MotionRt { m: Rig2DMotion; curves: CurveRt[] }
export function prepMotion(m: Rig2DMotion, doc: Rig2DDoc, buffers: readonly Uint8Array[]): MotionRt {
  const pIdx = new Map(doc.params.map((p, i) => [p.id, i])), partIdx = new Map(doc.parts.map((p, i) => [p.id, i]));
  return { m, curves: m.curves.map((c) => prepCurve(c, buffers, c.target === 'param' ? pIdx.get(c.id) ?? -1 : c.target === 'part' ? partIdx.get(c.id) ?? -1 : 0)) };
}

/** One motion at a time, eased in / out, blended over the current values. */
export class MotionTrack {
  cur: MotionRt | null = null;
  private t = 0;
  private stopAt = -1;
  /** whole-puppet opacity from 'opacity' curves */
  opacity = 1;
  get playing() { return !!this.cur; }
  get id() { return this.cur?.m.id ?? null; }
  play(m: MotionRt) { this.cur = m; this.t = 0; this.stopAt = -1; }
  stop() { if (this.cur && this.stopAt < 0) this.stopAt = this.t; }
  update(dt: number, values: Float64Array, partOpacity: Float32Array, doc: Rig2DDoc, blinkIdx: readonly number[], lipIdx: readonly number[]) {
    const r = this.cur;
    this.opacity = 1;
    if (!r) return;
    const m = r.m;
    this.t += dt;
    let time = this.t;
    if (m.duration > 0 && time > m.duration) {
      if (m.loop) time %= m.duration;
      else if (this.stopAt < 0) this.stopAt = m.duration;
    }
    let wOut = 1;
    if (this.stopAt >= 0) {
      const left = m.fadeOut - (this.t - this.stopAt);
      if (left <= 0 || m.fadeOut <= 0) { this.cur = null; return; }
      wOut = ease(left / m.fadeOut);
      if (!m.loop) time = Math.min(time, m.duration || time);
    }
    const wIn = m.fadeIn > 0 ? ease(this.t / m.fadeIn) : 1;
    for (const c of r.curves) {
      const v = curveAt(c, time, m.bezierByFraction);
      const w = (c.fadeIn !== undefined ? (c.fadeIn > 0 ? ease(this.t / c.fadeIn) : 1) : wIn) * wOut;
      if (c.target === 'param') {
        if (c.idx < 0) continue;
        const p = doc.params[c.idx];
        values[c.idx] = cl(values[c.idx] + (v - values[c.idx]) * w, p.min, p.max);
      } else if (c.target === 'part') { if (c.idx >= 0) partOpacity[c.idx] = cl(v, 0, 1); }
      else if (c.target === 'blink') { for (const i of blinkIdx) values[i] *= 1 + (v - 1) * w; }
      else if (c.target === 'lipSync') { for (const i of lipIdx) values[i] *= 1 + (v - 1) * w; }
      else this.opacity = cl(1 + (v - 1) * w, 0, 1);
    }
  }
}

// ================================================================ expressions
interface ExpRt { e: Rig2DExpression; idx: Int32Array; w: number; target: number; fade: number | null; /** switched on by a toggle (hotkey) */ tog: boolean }
/** Expressions with fades, from three sources at once:
 *   held    : set(id) — one expression held on (the studio's "Show" / bus `flat {expression}`; replaces the state
 *             machine while it is held);
 *   toggled : setToggled(ids) — any number switched on independently (hotkeys), like VTube Studio: they STACK;
 *   weights : setWeights() — the state machine / blend trees (`fade` = a transition's cross-fade time).
 *  Each expression fades in / out by its own times. The layers are kept in activation order (an expression moves to
 *  the end when it is switched on, whoever switches it: a toggle, Show or a state-machine transition), so on a shared
 *  parameter the one switched on LAST wins — a state that comes after a toggle wins, a toggle pressed during a state
 *  wins (like VTube Studio's last-activated rule).
 *  While any toggled expression is in the mix, parameters combine like VTube Studio: Overwrites lerp in activation
 *  order, then every Multiply factor (1 + (v − 1) × w, compounding), then every Add (v × w): value = ov × Πmul + Σadd.
 *  Without toggles (held / state-machine expressions only, what authored Pro2D models had before toggles stacked) the
 *  original rule is kept unchanged: each layer in activation order applies its blend in turn, clamped after each. */
export class ExpressionMixer {
  private layers: ExpRt[] = [];
  /** the expression showing (held, else the state machine's strongest, else the last toggled): fx / tests */
  current: string | null = null;
  private held: string | null = null;
  private toggled: string[] = [];
  private weights: Record<string, number> = {};
  private ov = new Float64Array(0);
  private add = new Float64Array(0);
  private mul = new Float64Array(0);
  private touched = new Int32Array(0);
  private mark = new Uint8Array(0);
  constructor(private doc: Rig2DDoc) {}
  private layer(e: Rig2DExpression) {
    let l = this.layers.find((x) => x.e === e);
    if (!l) { l = { e, idx: Int32Array.from(e.params.map((p) => this.doc.params.findIndex((q) => q.id === p.param))), w: 0, target: 0, fade: null, tog: false }; this.layers.push(l); }
    return l;
  }
  private find(id: string) { return this.doc.expressions?.find((x) => x.id === id) ?? null; }
  /** Recompute every layer's target from the three sources; a layer switched on anew goes last (it wins Overwrites). */
  private retarget(fade: number | null) {
    const want = new Map<string, number>();
    const put = (id: string, v: number) => { if (this.find(id)) want.set(id, Math.max(want.get(id) ?? 0, Math.min(1, Math.max(0, v)))); };
    for (const [id, v] of Object.entries(this.weights)) put(id, v);
    for (const id of this.toggled) put(id, 1);
    if (this.held) put(this.held, 1);
    for (const l of this.layers) if (!want.has(l.e.id) && l.target !== 0) { l.target = 0; l.fade = fade; }
    // activation order: the toggled list's order, then the held one, then the state machine's
    const order = [...this.toggled, ...(this.held ? [this.held] : []), ...Object.keys(this.weights)];
    for (const id of order) {
      const v = want.get(id);
      if (v === undefined) continue;
      const e = this.find(id)!;
      const known = this.layers.find((x) => x.e === e);
      const l = known ?? this.layer(e);
      if (l.target === 0 && v > 0 && known) { this.layers.splice(this.layers.indexOf(l), 1); this.layers.push(l); }
      if (l.target !== v) { l.target = v; l.fade = fade; }
      l.tog = this.toggled.includes(id);
    }
    let best: string | null = null, bw = 0;
    for (const [id, v] of Object.entries(this.weights)) if (v > bw && this.find(id)) { bw = v; best = id; }
    this.current = this.held ?? best ?? (this.toggled.length ? this.toggled[this.toggled.length - 1] : null);
  }
  /** Hold one expression on (null = none); `fade` overrides the expressions' own fade times. Clears the state machine's. */
  set(id: string | null, fade: number | null = null) {
    const e = id ? this.find(id) : null;
    const nid = e ? e.id : null;
    if (nid === this.held && !Object.keys(this.weights).length) return;
    this.held = nid; this.weights = {};
    this.retarget(fade);
  }
  /** Several expressions at once (weights 0..1), e.g. a blend tree / the state machine. */
  setWeights(w: Record<string, number>, fade: number | null = null) {
    const same = !this.held && Object.keys(w).length === Object.keys(this.weights).length && Object.entries(w).every(([k, v]) => this.weights[k] === v);
    if (same) return;
    this.held = null; this.weights = { ...w };
    this.retarget(fade);
  }
  /** The expressions switched on by toggles (hotkeys), oldest first; they stack. */
  setToggled(ids: readonly string[] | undefined | null) {
    const list = ids ?? [];
    if (list.length === this.toggled.length && list.every((x, i) => x === this.toggled[i])) return;
    this.toggled = list.filter((x) => typeof x === 'string').slice(0, 64);
    this.retarget(null);
  }
  /** Is an expression on now (held, toggled or the state machine's)? */
  isOn(id: string) { return this.held === id || this.toggled.includes(id) || (this.weights[id] ?? 0) > 0; }
  update(dt: number, values: Float64Array, partOpacity: Float32Array, partIndex: (id: string) => number) {
    for (const l of this.layers) {
      if (l.w === l.target) continue;
      const up = l.target > l.w, t = l.fade ?? (up ? l.e.fadeIn : l.e.fadeOut);
      const step = t > 0 ? dt / t : 1;
      l.w = up ? Math.min(l.target, l.w + step) : Math.max(l.target, l.w - step);
    }
    this.layers = this.layers.filter((l) => l.target > 0 || l.w > 0);
    if (!this.layers.length) return;
    if (!this.layers.some((l) => l.tog)) {
      for (const l of this.layers) {
        const w = ease(l.w);
        l.e.params.forEach((p, k) => {
          const i = l.idx[k];
          if (i < 0) return;
          const cur = values[i], q = this.doc.params[i];
          const v = p.blend === 'add' ? cur + p.value * w : p.blend === 'multiply' ? cur * (1 + (p.value - 1) * w) : cur + (p.value - cur) * w;
          values[i] = cl(v, q.min, q.max);
        });
        for (const po of l.e.parts ?? []) { const pi = partIndex(po.part); if (pi >= 0) partOpacity[pi] = partOpacity[pi] + (po.opacity - partOpacity[pi]) * w; }
      }
      return;
    }
    const n = values.length;
    if (this.ov.length !== n) { this.ov = new Float64Array(n); this.add = new Float64Array(n); this.mul = new Float64Array(n); this.mark = new Uint8Array(n); this.touched = new Int32Array(n); }
    let nt = 0;
    for (const l of this.layers) {
      const w = ease(l.w);
      l.e.params.forEach((p, k) => {
        const i = l.idx[k];
        if (i < 0) return;
        if (!this.mark[i]) { this.mark[i] = 1; this.touched[nt++] = i; this.ov[i] = values[i]; this.add[i] = 0; this.mul[i] = 1; }
        if (p.blend === 'add') this.add[i] += p.value * w;
        else if (p.blend === 'multiply') this.mul[i] *= 1 + (p.value - 1) * w;
        else this.ov[i] += (p.value - this.ov[i]) * w;
      });
      for (const po of l.e.parts ?? []) { const pi = partIndex(po.part); if (pi >= 0) partOpacity[pi] = partOpacity[pi] + (po.opacity - partOpacity[pi]) * w; }
    }
    for (let k = 0; k < nt; k++) {
      const i = this.touched[k], q = this.doc.params[i];
      values[i] = cl(this.ov[i] * this.mul[i] + this.add[i], q.min, q.max);
      this.mark[i] = 0;
    }
  }
}

// ================================================================ physics (pendulum strands)
function normalize(v: number, pMin: number, pDef: number, pMax: number, nMin: number, nDef: number, nMax: number): number {
  if (v >= pDef) return pMax > pDef ? nDef + (v - pDef) / (pMax - pDef) * (nMax - nDef) : nDef;
  return pMin < pDef ? nDef - (pDef - v) / (pDef - pMin) * (nDef - nMin) : nDef;
}
/** Strands of particles hanging from a moving anchor; inputs move / turn the anchor, outputs read particle offsets /
 *  angles. Fixed step (physicsWorld.fps), ≤ 6 steps a frame, NaN-guarded (resets the strand). */
export class PhysicsRig {
  private st: { s: Rig2DPhysics; px: Float64Array; py: Float64Array; vx: Float64Array; vy: Float64Array; ins: Int32Array; outs: Int32Array }[];
  private acc = 0;
  private fps: number;
  private g: [number, number];
  private wind: [number, number];
  constructor(private doc: Rig2DDoc) {
    const pIdx = new Map(doc.params.map((p, i) => [p.id, i]));
    this.fps = doc.physicsWorld?.fps ?? 60;
    this.g = doc.physicsWorld?.gravity ?? [0, -1];
    this.wind = doc.physicsWorld?.wind ?? [0, 0];
    this.st = (doc.physics ?? []).map((s) => {
      const n = s.particles.length;
      const t = { s, px: new Float64Array(n), py: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
        ins: Int32Array.from(s.inputs.map((i) => pIdx.get(i.param) ?? -1)), outs: Int32Array.from(s.outputs.map((o) => pIdx.get(o.param) ?? -1)) };
      return t;
    });
    this.reset();
  }
  /** Take over the strands' state from another PhysicsRig (same rig rebuilt): strands with the same id and length. */
  carryFrom(old: PhysicsRig) {
    const byId = new Map(old.st.map((t) => [t.s.id, t]));
    // (the same strand: same id, the same parameters in and out)
    const shape = (s: Rig2DPhysics) => `${s.particles.length}|${s.inputs.map((i) => i.param).join(',')}|${s.outputs.map((o) => o.param).join(',')}`;
    for (const t of this.st) { const o = byId.get(t.s.id); if (o && o.px.length === t.px.length && shape(o.s) === shape(t.s)) { t.px.set(o.px); t.py.set(o.py); t.vx.set(o.vx); t.vy.set(o.vy); } }
    this.acc = old.acc;
  }
  reset() {
    for (const t of this.st) for (let i = 0; i < t.s.particles.length; i++) { t.px[i] = t.s.particles[i].x; t.py[i] = t.s.particles[i].y; t.vx[i] = 0; t.vy[i] = 0; }
    this.acc = 0;
  }
  /** Start at rest under the given inputs: silent steps from the rest strand with extra damping (lively, barely damped
   *  strands would otherwise still swing at load: up to 5 % of a hair parameter's range on real models), until every
   *  particle has stopped (≤ 4 s), velocities then zeroed; outputs not written. */
  settle(values: Float64Array) {
    const h = 1 / this.fps, save = Float64Array.from(values);
    for (let i = 0; i < this.fps * 4; i++) {
      this.step(h, values);
      let moving = 0;
      for (const t of this.st) for (let k = 1; k < t.vx.length; k++) { t.vx[k] *= 0.5; t.vy[k] *= 0.5; moving = Math.max(moving, Math.abs(t.vx[k]) + Math.abs(t.vy[k])); }
      if (i > this.fps * 0.5 && moving < 1e-7) break;
    }
    for (const t of this.st) { t.vx.fill(0); t.vy.fill(0); }
    values.set(save);
    this.acc = 0;
  }
  update(dt: number, values: Float64Array) {
    const h = 1 / this.fps;
    this.acc = Math.min(this.acc + Math.max(0, dt), h * 6);
    while (this.acc >= h) { this.step(h, values); this.acc -= h; }
    this.write(values);
  }
  private step(h: number, values: Float64Array) {
    const P = this.doc.params;
    const gl = Math.hypot(this.g[0], this.g[1]) || 1;
    for (const t of this.st) {
      const s = t.s;
      let tx = 0, ty = 0, ang = 0;
      s.inputs.forEach((inp, n) => {
        const i = t.ins[n];
        if (i < 0) return;
        const r = inp.type === 'angle' ? s.normalize.angle : s.normalize.position;
        let v = normalize(values[i], P[i].min, P[i].default, P[i].max, r[0], r[1], r[2]);
        if (inp.reflect) v = -v;
        v *= inp.weight / 100;
        if (inp.type === 'x') tx += v; else if (inp.type === 'y') ty += v; else ang += v;
      });
      // strand space: particles hang along +y; the input angle turns the gravity the strand feels
      const a = -ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const gx0 = -this.g[0] / gl, gy0 = -this.g[1] / gl;
      const gx = gx0 * ca - gy0 * sa, gy = gx0 * sa + gy0 * ca;
      t.px[0] = s.particles[0].x + tx; t.py[0] = s.particles[0].y - ty;
      const f = h * 30;
      for (let i = 1; i < s.particles.length; i++) {
        const q = s.particles[i];
        const d = Math.max(0.05, q.delay) * f;
        const ox = t.px[i], oy = t.py[i];
        let nx = ox + t.vx[i] * d + (gx * q.acceleration + this.wind[0]) * d * d;
        let ny = oy + t.vy[i] * d + (gy * q.acceleration - this.wind[1]) * d * d;
        const dx = nx - t.px[i - 1], dy = ny - t.py[i - 1];
        const len = Math.hypot(dx, dy) || 1e-6;
        const rad = Math.max(q.radius, 1e-3);
        nx = t.px[i - 1] + dx / len * rad; ny = t.py[i - 1] + dy / len * rad;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) { this.reset(); return; }
        t.vx[i] = (nx - ox) / d * q.mobility; t.vy[i] = (ny - oy) / d * q.mobility;
        t.px[i] = nx; t.py[i] = ny;
      }
    }
  }
  private write(values: Float64Array) {
    const P = this.doc.params;
    for (const t of this.st) {
      t.s.outputs.forEach((o, n) => {
        const i = t.outs[n], vi = o.particle;
        if (i < 0 || vi < 1) return;
        let v: number;
        if (o.type === 'x') v = t.px[vi] - t.px[vi - 1];
        else if (o.type === 'y') v = -(t.py[vi] - t.py[vi - 1]);
        else {
          const ax = vi >= 2 ? t.px[vi - 1] - t.px[vi - 2] : 0, ay = vi >= 2 ? t.py[vi - 1] - t.py[vi - 2] : 1;
          const bx = t.px[vi] - t.px[vi - 1], by = t.py[vi] - t.py[vi - 1];
          v = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
        }
        if (o.reflect) v = -v;
        v *= o.scale;
        if (!Number.isFinite(v)) return;
        const lo = P[i].min, hi = P[i].max;
        values[i] = cl(values[i] + (cl(v, lo, hi) - values[i]) * cl(o.weight / 100, 0, 1), lo, hi);
      });
    }
  }
}

// ================================================================ part switches (poses)
/** In each switch group one member shows: the first member a motion / expression asked to show (its part opacity
 *  > 0.001 before this runs; all parts start at 1, so by default the first member), faded in over `fade` s while the
 *  others fade out; linked parts follow their member. Overwrites those parts' opacity. */
export class SwitchFader {
  private op: Float32Array[];
  private first = true;
  private members: { parts: number[] }[][];
  constructor(private doc: Rig2DDoc) {
    const partIdx = new Map(doc.parts.map((p, i) => [p.id, i]));
    this.members = (doc.switches ?? []).map((s) => s.members.map((m) => ({ parts: [m.part, ...m.links].map((x) => partIdx.get(x) ?? -1).filter((x) => x >= 0) })));
    this.op = this.members.map((g) => new Float32Array(g.length));
  }
  update(dt: number, _values: Float64Array, partOpacity: Float32Array) {
    this.members.forEach((g, gi) => {
      const op = this.op[gi], fade = this.doc.switches![gi].fade;
      let vis = g.findIndex((m) => m.parts.length && partOpacity[m.parts[0]] > 0.001);
      if (vis < 0) vis = 0;
      const step = this.first || fade <= 0 ? 1 : dt / fade;
      op[vis] = Math.min(1, op[vis] + step);
      for (let k = 0; k < g.length; k++) if (k !== vis) op[k] = Math.max(0, Math.min(op[k] - step, 1 - op[vis]));
      for (let k = 0; k < g.length; k++) for (const p of g[k].parts) partOpacity[p] = op[k];
    });
    this.first = false;
  }
}

// ================================================================ automatic blinks
export class AutoBlink {
  private t = 0;
  private next = 3;
  private seed: number;
  constructor(seed = 7) { this.seed = seed >>> 0 || 1; }
  private rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  /** 1 = open, 0 = closed. */
  step(dt: number, len = 0.16): number {
    this.t += dt;
    if (this.t >= this.next + len) { this.t = 0; this.next = 2.5 + this.rnd() * 3.5; }
    if (this.t < this.next) return 1;
    return Math.abs(2 * (this.t - this.next) / len - 1);
  }
}

// ================================================================ the animator
export interface AnimatorOpts {
  /** user bindings from the mapping panel (replace the automatic ones) */
  bindings?: Rig2DBinding[];
  idleMotion?: boolean;
  physics?: boolean;
  lipGain?: number;
  headGain?: number;
  /** how far each tracked part may move, per direction (shared/rig2d/drive.ts Rig2DTune; missing = as tracked) */
  tune?: Rig2DTune;
  /** procedural dynamics (springs, jiggle, wind, bone chains); default on */
  dynamics?: boolean;
  /** costume layers switched on (ids); missing = each layer's own `on` */
  layers?: string[];
  /** the performer's saved model-slider positions (shared/rig2d/userParams.ts) */
  params?: [string, number][];
}
export interface AnimateInput {
  frame: TrackingFrame; voice: number; dt: number; time: number; expression?: string | null; motion?: { group: string; index: number; id: number } | null;
  /** the studio's held state / expression cue (hotkey triggers) */
  hotkey?: string | null;
  /** the room: wind 0..2 + direction, and the chat / stream events since the last frame */
  env?: { wind: number; windDir: number; events: readonly Rig2DEvent[] };
  /** the studio's model sliders now (FlatCue.p: id → [target, fade s]; "layer:<id>" = costume layers) */
  user?: ParamCue;
  /** expressions toggled on (FlatCue.x, hotkeys), oldest first: they stack like VTube Studio's */
  toggles?: readonly string[];
}

export class Animator {
  bindings: Rig2DBinding[];
  /** physics turned back on live (applyOpts): restart the strands at rest under the current pose */
  private physRestart = false;
  readonly info: Map<string, Rig2DParamInfo>;
  private pIdx: Map<string, number>;
  private partIdx: Map<string, number>;
  private idle: MotionTrack = new MotionTrack();
  private shot: MotionTrack = new MotionTrack();
  readonly exp: ExpressionMixer;
  private phys: PhysicsRig | null;
  private inochiPhys: InochiPhysicsAdapter | null;
  private sw: SwitchFader;
  private blink = new AutoBlink();
  private std: Record<string, number> = {};
  /** this frame's standard sources as tracked, before "how much each part moves" (the studio's live markers) */
  readonly rawSources: Record<string, number> = {};
  /** this frame's standard sources as applied (after the tune) */
  get sources(): Readonly<Record<string, number>> { return this.std; }
  private motions: MotionRt[];
  private blinkIdx: number[];
  private lipIdx: number[];
  private lastCue = -1;
  private layerParts: { parts: number[]; atts: number[]; group: string | null; on: boolean }[];
  /** state machine: current state per layer */
  private sm: { state: string; since: number; voiceFor: number; quietFor: number; fade: number | null }[];
  private dyn: Dynamics | null;
  /** per-vertex soft bodies (kind 'follow'): run after the rig is evaluated, see afterEvaluate() */
  private follow: FollowThrough | null;
  private lastDt = 0;
  private views: { by: number; role: Rig2DStdSource | null; sets: { at: number; parts: number[] }[]; band: number; hyst: number; cur: number } | null;
  /** this frame's weight per view set (tests / probes) */
  viewWeights = new Float32Array(0);
  /** the performer's emotion this frame (face) */
  emotion = { name: 'neutral', level: 1 };
  /** last frame's held hotkey cue and events (particles read them too) */
  hotkey: string | null = null;
  /** last frame's toggled expressions (hotkey triggers match these too) */
  toggled: readonly string[] = [];
  events: readonly Rig2DEvent[] = [];
  /** attachments shown (index = doc.attachments) */
  readonly attachmentOn: Uint8Array;
  /** whole-puppet opacity (motion opacity curves) */
  opacity = 1;
  /** the first update ran (solvers seeded from the first frame's pose) */
  private started = false;
  /** model sliders: the performer's held parameter values, eased (shared/rig2d/userParams.ts) */
  readonly user: UserParamDriver;
  constructor(readonly doc: Rig2DDoc, buffers: readonly Uint8Array[], readonly ev: RigEval, private o: AnimatorOpts = {}) {
    this.pIdx = new Map(doc.params.map((p, i) => [p.id, i]));
    this.partIdx = new Map(doc.parts.map((p, i) => [p.id, i]));
    this.info = new Map(doc.params.map((p) => [p.id, { id: p.id, name: p.name, dims: 1 as const, min: [p.min, p.min] as [number, number], max: [p.max, p.max] as [number, number], def: [p.default, p.default] as [number, number] }]));
    this.bindings = o.bindings ?? Animator.autoBindings(doc);
    this.exp = new ExpressionMixer(doc);
    this.phys = doc.physics?.length ? new PhysicsRig(doc) : null;
    this.inochiPhys = createInochiPhysicsAdapter(doc, ev);
    this.sw = new SwitchFader(doc);
    this.motions = (doc.motions ?? []).map((m) => prepMotion(m, doc, buffers));
    this.blinkIdx = doc.roles.eyeBlink.map((id) => this.pIdx.get(id) ?? -1).filter((i) => i >= 0);
    this.lipIdx = doc.roles.lipSync.map((id) => this.pIdx.get(id) ?? -1).filter((i) => i >= 0);
    const idle = this.motions.find((m) => /^idle$/i.test(m.m.group)) ?? null;
    if (idle && o.idleMotion !== false) this.idle.play(idle);
    const attIdx = new Map((doc.attachments ?? []).map((x, i) => [x.id, i]));
    this.layerParts = (doc.layers ?? []).map((l) => ({ parts: l.parts.map((p) => this.partIdx.get(p) ?? -1).filter((x) => x >= 0), atts: (l.attachments ?? []).map((x) => attIdx.get(x) ?? -1).filter((x) => x >= 0),
      group: l.group ?? null, on: o.layers ? o.layers.includes(l.id) : l.on }));
    this.attachmentOn = new Uint8Array((doc.attachments ?? []).length);
    this.user = new UserParamDriver(doc, new Map(o.params ?? []), (id, on) => this.setLayer(id, on), classifyParams(doc, this.bindings).user.map((u) => u.id),
      (id) => this.layerOn(id));
    this.sm = (doc.states?.layers ?? []).map((l) => ({ state: l.initial, since: 0, voiceFor: 0, quietFor: 0, fade: null }));
    this.dyn = doc.dynamics?.length && o.dynamics !== false ? new Dynamics(doc) : null;
    this.follow = rig2dDynamics(doc).some((d) => d.kind === 'follow') && o.dynamics !== false ? new FollowThrough(doc, buffers) : null;
    const v = doc.views;
    this.views = v ? { by: v.by.startsWith('role:') ? -1 : this.pIdx.get(v.by) ?? -1, role: v.by.startsWith('role:') ? v.by.slice(5) as Rig2DStdSource : null,
      sets: [...v.sets].sort((x, y) => x.at - y.at).map((st) => ({ at: st.at, parts: st.parts.map((q) => this.partIdx.get(q) ?? -1).filter((q) => q >= 0) })),
      band: Math.max(0, v.blendBand ?? 2), hyst: Math.max(0, v.hysteresis ?? 2), cur: -1 } : null;
    if (v) this.viewWeights = new Float32Array(v.sets.length);
  }
  /** Retune one dynamics solver live (the 2D avatar maker's swing sliders; shared/rig2d/dynamics.ts Dynamics.tune). */
  tuneDynamic(id: string, t: Parameters<Dynamics['tune']>[1] & Parameters<FollowThrough['tune']>[1]) { this.dyn?.tune(id, t); this.follow?.tune(id, t); }
  /** Call right after the per-frame `ev.update()` that follows update(): the follow (kind 'follow') moves its meshes' final vertex positions. */
  afterEvaluate() { this.follow?.apply(this.ev, this.lastDt, this.ev.values); }
  /** A follow's per-vertex offsets now (tests / the editor's probe); null = no such follow or mesh. */
  followOffsets(id: string, mesh: string) { return this.follow?.offsets(id, mesh) ?? null; }
  /** Continue the secondary motion of another animator on the same rig rebuilt (2D avatar maker edits): dynamics and
   *  physics strands with the same ids carry on instead of starting at rest (no snap back when a slider is let go). */
  carryMotionFrom(old: Animator) {
    // the rig evaluated once at the old one's pose, so the chains read their roots where they were (no lost frame) —
    // only when the parameters and bones are the same ones in the same order (an edit that changes them starts fresh)
    const ids = (d: Rig2DDoc) => JSON.stringify([d.params.map((p) => p.id), (d.bones ?? []).map((b) => b.id)]);
    if (old.ev.evalCount && ids(old.doc) === ids(this.doc) && old.ev.values.length === this.ev.values.length && old.ev.boneAngleAdd.length === this.ev.boneAngleAdd.length) {
      this.ev.values.set(old.ev.values); this.ev.boneAngleAdd.set(old.ev.boneAngleAdd); this.ev.update();
    }
    if (this.dyn && old.dyn) this.dyn.carryFrom(old.dyn);
    if (this.follow && old.follow) this.follow.carryFrom(old.follow);
    // physics strands: only between two animators that both run them (physics off in either: the next one that runs
    // them settles from rest, as at load)
    if (this.phys && old.phys && old.started && this.o.physics !== false && old.o.physics !== false) { this.phys.carryFrom(old.phys); this.started = true; }
  }
  /** New options on the running rig, no reload (the studio's 2D panel / a profile save reaching the OBS page:
   *  src/avatar/flat/rig2d/liveOpts.ts): gains, bindings, physics on / off (back on = the strands restart at rest),
   *  idle motion, costume layers, saved slider positions. `dynamics` needs a new Animator (kept as it was). */
  applyOpts(o: AnimatorOpts) {
    const old = this.o;
    this.o = { ...o, ...(old.dynamics !== undefined ? { dynamics: old.dynamics } : {}) };
    const before = JSON.stringify(this.bindings);
    this.bindings = o.bindings ?? Animator.autoBindings(this.doc);
    // (a parameter the new mapping tracks is no slider any more: let it go, tracking drives it)
    if (JSON.stringify(this.bindings) !== before) this.user.setAllowed(classifyParams(this.doc, this.bindings).user.map((u) => u.id));
    if (old.physics === false && o.physics !== false) this.physRestart = true;
    const idle = this.motions.find((m) => /^idle$/i.test(m.m.group)) ?? null;
    if (o.idleMotion === false) this.idle.stop(); else if (idle && !this.idle.playing) this.idle.play(idle);
    // outfit layers: the studio's live cue owns them once it has reached this page (a key / the deck / chat may have
    // switched one on for the session: a save of anything else must not switch it off); else the saved list
    if (!this.user.cueSeen) (this.doc.layers ?? []).forEach((l, i) => { this.layerParts[i].on = o.layers ? o.layers.includes(l.id) : l.on; });
    this.user.forgetLayers();
    this.user.setSaved(new Map(o.params ?? []));
  }
  /** The automatic tracking bindings: roles.bind when the rig has it, else the Cubism standard ids it has. */
  static autoBindings(doc: Rig2DDoc): Rig2DBinding[] {
    return [...Animator.baseBindings(doc), ...Animator.vowelBindings(doc)];
  }
  /** The mouth shapes' bindings from `extra.vowelBind` (written by the auto-rig; older builds ignore the field). Only known roles and parameters the rig has. */
  static vowelBindings(doc: Rig2DDoc): Rig2DBinding[] {
    const vb = (doc.extra as { vowelBind?: unknown } | undefined)?.vowelBind;
    if (!vb || typeof vb !== 'object' || Array.isArray(vb)) return [];
    const ids = new Set(doc.params.map((p) => p.id)), out: Rig2DBinding[] = [];
    for (const src of ['mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO'] as const) {
      const p = (vb as Record<string, unknown>)[src];
      if (typeof p === 'string' && ids.has(p)) out.push({ src, param: p });
    }
    return out;
  }
  private static baseBindings(doc: Rig2DDoc): Rig2DBinding[] {
    if (doc.roles.bind && Object.keys(doc.roles.bind).length) {
      return Object.entries(doc.roles.bind).map(([src, v]) => (typeof v === 'string' ? { src: src as Rig2DBinding['src'], param: v } : { src: src as Rig2DBinding['src'], param: v.param, ...(v.gain !== undefined ? { gain: v.gain } : {}), ...(v.invert ? { invert: true } : {}), ...(v.range && v.range[0] !== v.range[1] ? { range: v.range } : {}) }));
    }
    return live2dAutoBindings(doc.params.map((p) => ({ id: p.id, name: p.name, dims: 1, min: [p.min, p.min], max: [p.max, p.max], def: [p.default, p.default] })), doc.roles.lipSync,
      { eyeBlink: doc.roles.eyeBlink, vts: (doc.extra as { vtsBindings?: unknown } | undefined)?.vtsBindings });
  }
  motionList() { return this.motions.map((m) => m.m); }
  playMotion(group: string, index: number) {
    const list = this.motions.filter((m) => m.m.group === group);
    const m = list[index] ?? list[0];
    if (m) this.shot.play(m);
  }
  /** Switch a costume layer (one per group: switching one on switches the rest of its group off). */
  setLayer(id: string, on: boolean) {
    const i = (this.doc.layers ?? []).findIndex((l) => l.id === id);
    if (i < 0) return;
    const L = this.layerParts[i];
    if (on && L.group) for (const x of this.layerParts) if (x !== L && x.group === L.group) x.on = false;
    L.on = on;
  }
  layerOn(id: string) { const i = (this.doc.layers ?? []).findIndex((l) => l.id === id); return i >= 0 && this.layerParts[i].on; }
  /** A role / parameter value by reference ("role:voice" or a parameter id). */
  private ref(r: string): number { if (r.startsWith('role:')) return this.std[r.slice(5)] ?? 0; const i = this.pIdx.get(r); return i === undefined ? 0 : this.ev.values[i]; }

  update(a: AnimateInput) {
    const doc = this.doc, P = this.ev.values, po = this.ev.partOpacity;
    this.lastDt = a.dt;
    for (let i = 0; i < P.length; i++) P[i] = doc.params[i].default;
    po.fill(1);
    // idle motion under everything
    this.idle.update(a.dt, P, po, doc, this.blinkIdx, this.lipIdx);
    // tracking
    const std = rig2dDrive(a.frame, a.time, a.voice, { lipGain: this.o.lipGain, headGain: this.o.headGain, tune: this.o.tune, raw: this.rawSources, roundSources: this.bindings.some((b) => !b.off && (b.src === 'mouthFunnel' || b.src === 'mouthPuckerWiden')) }, this.std);
    applyBindings(this.bindings, std, a.frame, (id) => this.info.get(id) ?? null, (id, _axis, v) => { const i = this.pIdx.get(id); if (i !== undefined) P[i] = v; });
    // automatic blinks while the camera doesn't see the performer
    if (a.frame.tracked === false) { const b = this.blink.step(a.dt); for (const i of this.blinkIdx) P[i] *= b; }
    // lip sync role parameters that no binding covers follow the mouth
    for (const i of this.lipIdx) if (!this.bindings.some((b) => !b.off && b.param === doc.params[i].id)) P[i] = Math.max(P[i], std.mouthOpen * doc.params[i].max);
    // one-shot motion (cue from the studio's hotkeys, the same on every page)
    if (a.motion && a.motion.id !== this.lastCue) { this.lastCue = a.motion.id; this.playMotion(a.motion.group, a.motion.index); }
    this.shot.update(a.dt, P, po, doc, this.blinkIdx, this.lipIdx);
    // model sliders (held by the performer) over motions; expressions still apply on top, physics reads them
    this.user.setCue(a.user); this.user.apply(a.dt, P);
    // world: emotion from the face, hotkey cue, events since the last frame
    if (this.sm.length || this.doc.particles?.length) this.emotion = a.frame.tracked === false ? { name: 'neutral', level: 1 } : faceEmotion(a.frame.face ?? {});
    this.hotkey = a.hotkey ?? null;
    this.toggled = Array.isArray(a.toggles) ? a.toggles : [];
    this.exp.setToggled(this.toggled);
    this.events = a.env?.events ?? [];
    // expressions: the held one, else the state machine's
    const want = a.expression ?? null;
    if (want || !this.sm.length) this.exp.set(want);
    else this.stepStates(a.dt, a.voice);
    this.exp.update(a.dt, P, po, (id) => this.partIdx.get(id) ?? -1);
    if (this.phys && this.o.physics !== false) { if (!this.started || this.physRestart) { this.phys.reset(); this.phys.settle(P); } this.phys.update(a.dt, P); }
    if (this.inochiPhys && this.o.physics !== false) { if (!this.started || this.physRestart) { this.ev.values.set(P); this.inochiPhys.reset(); } this.inochiPhys.update(a.dt); }
    this.physRestart = false;
    if (this.dyn) {
      this.ev.boneAngleAdd.fill(0);
      this.dyn.update(a.dt, P, { roles: std, wind: a.env?.wind ?? 0.3, windDir: a.env?.windDir ?? 1, time: a.time }, this.ev);
    }
    this.sw.update(a.dt, P, po);
    this.layerParts.forEach((l) => { if (!l.on) for (const p of l.parts) po[p] = 0; });
    if (this.attachmentOn.length) {
      const atts = this.doc.attachments!;
      for (let i = 0; i < atts.length; i++) this.attachmentOn[i] = atts[i].on ? 1 : 0;
      const listed = new Uint8Array(atts.length), shown = new Uint8Array(atts.length);
      for (const l of this.layerParts) for (const x of l.atts) { listed[x] = 1; if (l.on) shown[x] = 1; }
      for (let i = 0; i < atts.length; i++) if (listed[i]) this.attachmentOn[i] = shown[i];
    }
    if (this.views) this.applyViews(po);
    this.opacity = this.shot.opacity * this.idle.opacity;
    this.started = true;
  }

  /** Multi-angle views (§8.9): ONE set shows (fully opaque) until the value is past the midpoint to its neighbour; the
   *  hand-over happens in a short band there (`blendBand`, shifted by `hysteresis` so a jittery value near the midpoint
   *  stays on the current set), and it never cross-fades two half-transparent heads: the incoming set comes to full
   *  opacity in the band's first half while the outgoing one stays opaque, the outgoing one goes in the second half
   *  (so whichever is drawn on top covers the other, and nothing behind shows through). Parts in no set untouched. */
  private applyViews(po: Float32Array) {
    const V = this.views!, raw = V.role ? this.std[V.role] ?? 0 : V.by >= 0 ? this.ev.values[V.by] : 0, v = Number.isFinite(raw) ? raw : 0;
    const sets = V.sets, n = sets.length, w = this.viewWeights;
    w.fill(0);
    const mid = (k: number) => (sets[k].at + sets[k + 1].at) / 2;
    // band + hysteresis per pair, never wider than a quarter of the gap (sets close together still hand over cleanly)
    const bh = (k: number) => { const q = Math.abs(sets[k + 1].at - sets[k].at) / 4; return [Math.min(V.band, q), Math.min(V.hyst, q)]; };
    if (V.cur < 0 || V.cur >= n) { let best = 0; for (let k = 1; k < n; k++) if (Math.abs(sets[k].at - v) < Math.abs(sets[best].at - v)) best = k; V.cur = best; }
    // commit to a neighbour once the value is through the whole (shifted) band
    for (let g = 0; g < n; g++) {
      if (V.cur < n - 1) { const [b, h] = bh(V.cur); if (v >= mid(V.cur) + b + h) { V.cur++; continue; } }
      if (V.cur > 0) { const [b, h] = bh(V.cur - 1); if (v <= mid(V.cur - 1) - b - h) { V.cur--; continue; } }
      break;
    }
    const c = V.cur;
    // progress t (0 = lower set, 1 = upper set) through the band the current set's side of hysteresis puts us in
    let lo = -1, t = 0;
    if (c < n - 1) { const [b, h] = bh(c), s = mid(c) - b + h; if (v > s) { lo = c; t = b > 0 ? (v - s) / (2 * b) : 1; } }
    if (lo < 0 && c > 0) { const [b, h] = bh(c - 1), e = mid(c - 1) + b - h; if (v < e) { lo = c - 1; t = b > 0 ? 1 - (e - v) / (2 * b) : 0; } }
    if (lo < 0) w[c] = 1;
    else { t = Math.min(1, Math.max(0, t)); w[lo] = Math.min(1, 2 * (1 - t)); w[lo + 1] = Math.min(1, 2 * t); }
    const m = new Map<number, number>();
    sets.forEach((st, k) => { for (const p of st.parts) m.set(p, Math.max(m.get(p) ?? 0, w[k])); });
    for (const [p, x] of m) po[p] *= x;
  }

  /** The expression state machine (§8.5): transitions on voice / silence / emotion / chat / event / hotkey / param /
   *  timer; a state's expression, motion (on entry) or blend tree drives the expression mixer. */
  private stepStates(dt: number, voice: number) {
    const weights: Record<string, number> = {};
    let fade: number | null = null;
    (this.doc.states?.layers ?? []).forEach((L, li) => {
      const s = this.sm[li];
      s.since += dt;
      if (voice > 0.15) { s.voiceFor += dt; s.quietFor = 0; } else { s.quietFor += dt; s.voiceFor = 0; }
      for (const t of L.transitions) {
        if (t.from !== '*' && t.from !== s.state) continue;
        if (t.to === s.state) continue;
        const on = t.on, after = on.after ?? 0, v = on.value ?? '';
        let fire = false;
        switch (on.kind) {
          case 'voice': fire = voice >= (on.above ?? 0.15) && s.voiceFor >= after; break;
          case 'silence': fire = s.quietFor >= after && s.since >= after; break;
          case 'timer': fire = s.since >= after; break;
          case 'param': if (v) { const x = this.ref(v); fire = (on.above === undefined || x > on.above) && (on.below === undefined || x < on.below); } break;
          case 'emotion': fire = this.emotion.name === v && this.emotion.level >= (on.above ?? 0.5); break;
          case 'hotkey': fire = (!!this.hotkey && this.hotkey === v) || (!!v && this.toggled.includes(v)); break;
          case 'chat': case 'event':
            for (const e of this.events) if (e.kind === on.kind && (on.kind === 'chat' ? !v || e.value.toLowerCase().includes(v.toLowerCase()) : e.value.toLowerCase() === v.toLowerCase())) fire = true;
            break;
        }
        if (fire) {
          s.state = t.to; s.since = 0; s.voiceFor = 0; s.quietFor = 0; s.fade = t.fade ?? null;
          const st = L.states.find((x) => x.id === t.to);
          if (st?.motion) { const m = this.motions.find((x) => x.m.id === st.motion); if (m) this.shot.play(m); }
          break;
        }
      }
      const st = L.states.find((x) => x.id === s.state);
      if (s.fade !== null) fade = s.fade;
      if (st?.blend) {
        const x = this.ref(st.blend.by), pts = [...st.blend.points].sort((a, b) => a.at - b.at);
        if (x <= pts[0].at) weights[pts[0].expression] = Math.max(weights[pts[0].expression] ?? 0, 1);
        else if (x >= pts[pts.length - 1].at) weights[pts[pts.length - 1].expression] = 1;
        else for (let k = 0; k + 1 < pts.length; k++) if (x >= pts[k].at && x <= pts[k + 1].at) {
          const t = (x - pts[k].at) / ((pts[k + 1].at - pts[k].at) || 1);
          weights[pts[k].expression] = Math.max(weights[pts[k].expression] ?? 0, 1 - t);
          weights[pts[k + 1].expression] = Math.max(weights[pts[k + 1].expression] ?? 0, t);
          break;
        }
      } else if (st?.expression) weights[st.expression] = 1;
    });
    this.exp.setWeights(weights, fade);
  }
}

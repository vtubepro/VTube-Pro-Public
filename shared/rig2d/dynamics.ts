// Procedural secondary motion (docs/RIG2D_FORMAT.md §8.4): springs, jiggle and wind on parameters, damped bone chains.
// Fixed 120 Hz steps (an accumulator; at most 12 steps a frame), no randomness: the same inputs give the same output on
// every page. Pure; tools/rig2d_fx_unit.ts tests it.
import type { Rig2DDoc } from './format.ts';
import type { RigEval } from './evaluate.ts';
import { SOURCE_RANGE, type Rig2DStdSource } from './drive.ts';

const H = 1 / 120;
const DEFAULTS = { spring: { k: 60, c: 8 }, jiggle: { k: 180, c: 6 }, chain: { k: 40, c: 6 } };
const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A dynamics `amount` now: its parameter's value held to 0..4 (no parameter, or a value that is not a number: 1). */
const amountOf = (values: Float64Array, i: number) => { if (i < 0) return 1; const v = values[i]; return Number.isFinite(v) ? cl(v, 0, 4) : 1; };

/** A stable phase 0..2π from an id (no randomness). */
export function idPhase(id: string): number { let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return ((h >>> 0) / 4294967296) * Math.PI * 2; }
/** Gust shape −1..1 at time t for a period and phase. */
export function gust(t: number, period: number, ph: number): number {
  const w = (2 * Math.PI) / Math.max(0.2, period);
  return 0.55 * Math.sin(w * t + ph) + 0.3 * Math.sin(w * 2.3 * t + 2 * ph) + 0.15 * Math.sin(w * 5.1 * t + 3 * ph);
}

interface ParamDyn { id: string; kind: 'spring' | 'jiggle' | 'wind'; amt: number; scale: number; inParam: number; inRole: Rig2DStdSource | null; out: number; k: number; c: number; gain: number; strength: number; period: number; ph: number; y: number; v: number; x: number; init: boolean }
interface ChainDyn { id: string; /** its bone ids in order (a rebuilt rig carries motion only onto the same bones) */ key: string; amt: number; scale: number; bones: number[]; k: number; c: number; gravity: number; gain: number; ph: number; period: number; th: Float64Array; om: Float64Array; px: number; py: number; vx: number; vy: number; ax: number; ay: number;
  /** valid motion samples of the root so far (0 = not seeded; 1 = position known; 2+ = velocity known) */ samples: number; limit: number; boneLimit: number }

export interface DynamicsInput {
  /** standard role values (shared/rig2d/drive.ts rig2dDrive) */
  roles: Record<string, number>;
  /** room wind 0..2 and its direction (±1) */
  wind: number;
  windDir: number;
  /** seconds since load (wind gusts) */
  time: number;
}

export class Dynamics {
  private params: ParamDyn[] = [];
  private chains: ChainDyn[] = [];
  private acc = 0;
  private t = 0;
  private windScale: number;
  /** teleport distance and acceleration cap for chain roots (model units) */
  private jump: number;
  private maxAcc: number;
  constructor(private doc: Rig2DDoc) {
    this.windScale = 0.4 * doc.canvas.height / (doc.canvas.unit ?? 1);
    this.jump = 0.25 * doc.canvas.height / (doc.canvas.unit ?? 1);
    this.maxAcc = 100 * doc.canvas.height / (doc.canvas.unit ?? 1);
    const pIdx = new Map(doc.params.map((p, i) => [p.id, i])), bIdx = new Map((doc.bones ?? []).map((b, i) => [b.id, i]));
    for (const d of doc.dynamics ?? []) {
      if (d.kind === 'pendulum') continue; // anchored pendulums: shared/rig2d/inochi/physicsAdapter.ts
      if (d.kind === 'follow') continue; // per-vertex soft bodies: shared/rig2d/follow.ts
      if (d.kind === 'chain') {
        const bones = (d.bones ?? []).map((b) => bIdx.get(b) ?? -1).filter((b) => b >= 0);
        if (!bones.length) continue;
        const D = DEFAULTS.chain;
        this.chains.push({ id: d.id, key: JSON.stringify(d.bones ?? []), amt: d.amount ? pIdx.get(d.amount) ?? -1 : -1, scale: 1, bones, k: d.stiffness ?? D.k, c: d.damping ?? D.c, gravity: d.gravity ?? 0, gain: d.gain ?? 1, ph: idPhase(d.id), period: d.period ?? 3,
          th: new Float64Array(bones.length), om: new Float64Array(bones.length), px: 0, py: 0, vx: 0, vy: 0, ax: 0, ay: 0, samples: 0,
          limit: Math.min(Math.PI, Math.max(0, (d.limit ?? 90) * Math.PI / 180)), boneLimit: Math.min(1.4, Math.max(0, (d.boneLimit ?? 50) * Math.PI / 180)) });
        continue;
      }
      const out = d.output ? pIdx.get(d.output) ?? -1 : -1;
      if (out < 0) continue;
      const role = d.input?.startsWith('role:') ? d.input.slice(5) as Rig2DStdSource : null;
      const D = d.kind === 'wind' ? { k: 0, c: 0 } : DEFAULTS[d.kind as 'spring' | 'jiggle'];
      this.params.push({ id: d.id, kind: d.kind, amt: d.amount ? pIdx.get(d.amount) ?? -1 : -1, scale: 1, inParam: d.input && !role ? pIdx.get(d.input) ?? -1 : -1, inRole: role && role in SOURCE_RANGE ? role : null, out,
        k: d.stiffness ?? D.k, c: d.damping ?? D.c, gain: d.gain ?? 1, strength: d.strength ?? 1, period: d.period ?? 3, ph: idPhase(d.id), y: 0, v: 0, x: 0, init: false });
    }
  }
  get empty() { return !this.params.length && !this.chains.length; }

  /** Take over the motion of another solver set (the same rig rebuilt after an edit in the 2D avatar maker): every
   *  solver with the same id and shape continues where it was instead of starting again at rest. */
  carryFrom(old: Dynamics) {
    const P = new Map(old.params.map((d) => [d.id, d])), C = new Map(old.chains.map((c) => [c.id, c]));
    for (const d of this.params) { const o = P.get(d.id); if (o && o.kind === d.kind) { d.y = o.y; d.v = o.v; d.x = o.x; d.init = o.init; } }
    for (const c of this.chains) {
      const o = C.get(c.id);
      if (!o || o.key !== c.key || o.bones.length !== c.bones.length) continue;
      c.th.set(o.th); c.om.set(o.om); c.px = o.px; c.py = o.py; c.vx = o.vx; c.vy = o.vy; c.ax = o.ax; c.ay = o.ay; c.samples = o.samples;
    }
    this.acc = old.acc; this.t = old.t;
  }
  /** A chain's bend now, per bone (radians; tests); null = no such chain. */
  chainAngles(id: string): number[] | null { const c = this.chains.find((x) => x.id === id); return c ? Array.from(c.th) : null; }
  /** A solver's settings now (tests): stiffness, damping, gain; null = no such solver. */
  setting(id: string): { stiffness: number; damping: number; gain: number } | null {
    const d = this.params.find((x) => x.id === id) ?? this.chains.find((x) => x.id === id);
    return d ? { stiffness: d.k, damping: d.c, gain: d.gain } : null;
  }

  /** Change a solver's settings live (the 2D avatar maker's sliders, no rebuild): stiffness, damping, gain, gravity,
   *  limits (degrees). Unknown ids are ignored. */
  tune(id: string, t: { stiffness?: number; damping?: number; gain?: number; gravity?: number; limit?: number; boneLimit?: number }) {
    const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
    for (const d of this.params) if (d.id === id) { if (ok(t.stiffness)) d.k = t.stiffness; if (ok(t.damping)) d.c = t.damping; if (ok(t.gain)) d.gain = t.gain; }
    for (const c of this.chains) if (c.id === id) {
      if (ok(t.stiffness)) c.k = t.stiffness; if (ok(t.damping)) c.c = t.damping; if (ok(t.gain)) c.gain = t.gain; if (ok(t.gravity)) c.gravity = t.gravity;
      if (ok(t.limit)) c.limit = Math.min(Math.PI, Math.max(0, t.limit * Math.PI / 180));
      if (ok(t.boneLimit)) c.boneLimit = Math.min(1.4, Math.max(0, t.boneLimit * Math.PI / 180));
    }
  }

  /** Normalised −1..1 value of a parameter around its default. */
  private norm(i: number, v: number) { const p = this.doc.params[i]; return v >= p.default ? (p.max > p.default ? (v - p.default) / (p.max - p.default) : 0) : (p.min < p.default ? (v - p.default) / (p.default - p.min) : 0); }
  private denorm(i: number, n: number) { const p = this.doc.params[i]; return n >= 0 ? n * (p.max - p.default) : n * (p.default - p.min); }

  /** Advance by dt and ADD the outputs to the parameter values (call after physics); chains write ev.boneAngleAdd. */
  update(dt: number, values: Float64Array, inp: DynamicsInput, ev: RigEval | null) {
    // inputs sampled once per frame (held over the sub-steps); `amount` = the swing scale its parameter holds now
    for (const d of this.params) d.scale = amountOf(values, d.amt);
    for (const ch of this.chains) ch.scale = amountOf(values, ch.amt);
    for (const d of this.params) {
      if (d.kind === 'wind') continue;
      if (d.inRole) { const [lo, hi] = SOURCE_RANGE[d.inRole]; const mid = (lo + hi) / 2, half = (hi - lo) / 2 || 1; d.x = cl((inp.roles[d.inRole] - mid) / half, -1, 1); }
      else if (d.inParam >= 0) d.x = cl(this.norm(d.inParam, values[d.inParam]), -1, 1);
      if (!d.init) { d.y = d.x; d.v = 0; d.init = true; }
    }
    if (ev) for (const ch of this.chains) {
      // the root bone's base motion (model units) from the last EVALUATED transforms; nothing until the rig has been
      // evaluated once (before that the bone transforms are zero: reading them made a huge first-frame kick)
      ch.ax = ch.ay = 0;
      if (!ev.evalCount || dt <= 0) continue;
      const o = ch.bones[0] * 6, x = ev.boneWorld[o + 4], y = ev.boneWorld[o + 5];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // frame time clamped (a stalled tab / a zero step never makes a huge velocity)
      const h = cl(dt, 1 / 240, 1 / 20);
      // a jump of more than a quarter canvas in one frame is a teleport (rig rebuilt, avatar moved): start again at rest
      if (ch.samples && Math.hypot(x - ch.px, y - ch.py) > this.jump) ch.samples = 0;
      if (ch.samples === 0) { ch.px = x; ch.py = y; ch.vx = ch.vy = 0; ch.samples = 1; continue; }
      const vx = (x - ch.px) / h, vy = (y - ch.py) / h;
      if (ch.samples >= 2) {
        // acceleration, low-passed (one-frame spikes from tracking noise don't snap the hair) and capped
        const ax = cl((vx - ch.vx) / h, -this.maxAcc, this.maxAcc), ay = cl((vy - ch.vy) / h, -this.maxAcc, this.maxAcc);
        ch.ax = ax * 0.5; ch.ay = ay * 0.5;
      }
      ch.px = x; ch.py = y; ch.vx = vx; ch.vy = vy; ch.samples = Math.min(ch.samples + 1, 2);
    }
    this.acc = Math.min(this.acc + Math.max(0, dt), H * 12);
    while (this.acc >= H) { this.step(inp, ev); this.acc -= H; this.t += H; }
    for (const d of this.params) {
      let n: number;
      if (d.kind === 'spring') n = d.gain * d.y;
      else if (d.kind === 'jiggle') n = d.gain * (d.y - d.x);
      else n = d.gain * d.strength * inp.wind * gust(inp.time, d.period, d.ph) * Math.min(1, this.t);
      // (an `amount` scales the solver's own swing, at most its full range: half the amount = half the bend, even on a
      // turn hard enough to max it out; files without one are untouched)
      if (d.amt >= 0) n = cl(n, -1, 1) * d.scale;
      const p = this.doc.params[d.out];
      values[d.out] = cl(values[d.out] + this.denorm(d.out, n), p.min, p.max);
    }
    if (ev) for (const ch of this.chains) ch.bones.forEach((b, i) => { ev.boneAngleAdd[b] += ch.th[i] * 180 / Math.PI * ch.gain; });
  }

  private step(inp: DynamicsInput, ev: RigEval | null) {
    for (const d of this.params) {
      if (d.kind === 'wind') continue;
      const a = d.k * (d.x - d.y) - d.c * d.v;
      d.v += a * H; d.y += d.v * H;
      if (!Number.isFinite(d.y) || Math.abs(d.y) > 50) { d.y = d.x; d.v = 0; }
    }
    if (!ev || !ev.evalCount) return; // bone transforms are not known before the first evaluation
    const bones = this.doc.bones!;
    for (const ch of this.chains) {
      // wind pushes sideways: 40 % of the canvas height / s² at wind 1 (model units, so any rig scale behaves alike)
      const windF = inp.windDir * inp.wind * gust(this.t, ch.period, ch.ph) * this.windScale;
      for (let i = 0; i < ch.bones.length; i++) {
        const b = ch.bones[i], o = b * 6, W = ev.boneWorld;
        const phi = Math.atan2(W[o + 1], W[o]);                 // the bone's +x direction now (clockwise on screen)
        const nx = -Math.sin(phi), ny = Math.cos(phi);           // its clockwise normal
        const L = Math.max(1e-3, Math.abs(bones[b].length) || 1);
        // the base's acceleration pushes the bone the other way; gravity and wind pull along their direction
        const f = (-(ch.ax * nx + ch.ay * ny) + ch.gravity * ny + windF * nx) / L * ch.scale;
        const a = f - ch.k * ch.th[i] - ch.c * ch.om[i];
        ch.om[i] += a * H;
        const next = ch.th[i] + ch.om[i] * H, lim = ch.boneLimit;
        if (next > lim || next < -lim) { ch.th[i] = cl(next, -lim, lim); ch.om[i] = 0; } else ch.th[i] = next;
        if (!Number.isFinite(ch.th[i])) { ch.th[i] = 0; ch.om[i] = 0; }
      }
      // the whole chain's bend (the tip's turn = the sum) stays inside `limit`: no hair folding over the head
      let cum = 0;
      for (let i = 0; i < ch.bones.length; i++) {
        const c2 = cum + ch.th[i];
        if (c2 > ch.limit) { ch.th[i] = ch.limit - cum; ch.om[i] = Math.min(0, ch.om[i]); }
        else if (c2 < -ch.limit) { ch.th[i] = -ch.limit - cum; ch.om[i] = Math.max(0, ch.om[i]); }
        cum += ch.th[i];
      }
    }
  }
}

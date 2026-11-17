// Follow-through (docs/RIG2D_FORMAT.md §8.4): classic animation follow-through on a mesh's vertices. The listed meshes keep their
// `anchor` side still and the rest lags behind whatever moves them (parents, bones, sliders), settles fast (near-critical
// damping: one soft overshoot), stretches along the whip and thins across it (squash and stretch that keeps the area to within a few per cent), and the
// overlap travels outward from the held side (neighbour coupling).
// Runs AFTER RigEval.update() on the final model-space vertex positions, so it works on any rig. Fixed 120 Hz steps (an
// accumulator; at most 12 a frame), no randomness: the same inputs give the same output on every page. Allocation-free per
// frame after construction. Pure; tools/rig2d_follow_unit.ts tests it.
import { rig2dDynamics, type Rig2DDoc } from './format.ts';
import type { RigEval } from './evaluate.ts';
import { viewArray } from './container.ts';

const H = 1 / 120, EPS = 1e-9;
const DEF = { k: 90, zeta: 0.85, spread: 0.6, reach: 0.25, stretch: 0.2, squash: 0.5 };
/** The damping that settles a spring of stiffness k with damping ratio ζ (near-critical: one soft overshoot). */
const dampFor = (k: number) => 2 * DEF.zeta * Math.sqrt(Math.max(0, k));
const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
/** A follow's `amount` now: its parameter's value held to 0..4 (no parameter, or not a number: 1). */
const followAmount = (values: Float64Array, i: number) => { if (i < 0) return 1; const v = values[i]; return Number.isFinite(v) ? cl(v, 0, 4) : 1; };

type Anchor = 'top' | 'bottom' | 'left' | 'right' | 'center';
interface FollowMesh {
  id: string; mi: number; n: number;
  /** neighbours (CSR): vertex i's are adj[start[i] .. start[i + 1]) */ start: Int32Array; adj: Int32Array;
  /** state (x, y per vertex, model space): position, velocity, last frame's target, offset now (from the target), the rest pose, scratch (target / offset this step) */
  p: Float64Array; v: Float64Array; pt: Float64Array; off: Float64Array; rest: Float32Array; tt: Float64Array; dd: Float64Array;
  /** 1 = held still .. 0 = free; the rest pose's diagonal */ pin: Float32Array; size: number; ready: boolean;
}
interface FollowEntry { id: string; amt: number; scale: number; k: number; c: number; /** damping follows the stiffness (none authored) */ autoC: boolean; squash: number; spread: number; gravity: number; gain: number; stretch: number; anchor: Anchor; reach: number; meshes: FollowMesh[] }

/** Unique undirected edges of a triangle list as neighbour arrays (indices outside 0..n are ignored). */
function neighbours(idx: ArrayLike<number>, n: number): { start: Int32Array; adj: Int32Array } {
  const seen = new Set<number>(), ea: number[] = [], eb: number[] = [], start = new Int32Array(n + 1);
  for (let t = 0; t + 2 < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = idx[t + e], b = idx[t + (e + 1) % 3];
    if (a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 65536 + hi;
    if (seen.has(key)) continue;
    seen.add(key); ea.push(lo); eb.push(hi); start[lo + 1]++; start[hi + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n), adj = new Int32Array(start[n]);
  for (let e = 0; e < ea.length; e++) { adj[fill[ea[e]]++] = eb[e]; adj[fill[eb[e]]++] = ea[e]; }
  return { start, adj };
}

/** Pin 0..1 per vertex from the rest pose: fully held within `reach` of the anchor side (a fraction of the extent along that
 *  axis; 'center' = distance from the bbox centre over half the diagonal), then a smoothstep fall-off over `reach` again. */
function pinsOf(rest: Float32Array, anchor: Anchor, reach: number, pin: Float32Array): number {
  const n = pin.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const x = rest[2 * i], y = rest[2 * i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h), r = Math.max(reach, 1e-6), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < n; i++) {
    const x = rest[2 * i], y = rest[2 * i + 1];
    const f = anchor === 'top' ? (h > EPS ? (y - y0) / h : 0) : anchor === 'bottom' ? (h > EPS ? (y1 - y) / h : 0) : anchor === 'left' ? (w > EPS ? (x - x0) / w : 0)
      : anchor === 'right' ? (w > EPS ? (x1 - x) / w : 0) : (diag > EPS ? Math.hypot(x - cx, y - cy) / (diag / 2) : 0);
    const s = cl((f - reach) / r, 0, 1);
    pin[i] = f <= reach ? 1 : 1 - s * s * (3 - 2 * s);
  }
  return Number.isFinite(diag) ? diag : 0;
}

export class FollowThrough {
  private entries: FollowEntry[] = [];
  /** substeps run so far, the time left over (seconds), and this frame's target blend per substep */
  private ns = 0;
  private acc = 0;
  private w = new Float64Array(12);
  /** teleport distance (model units): the targets' mean move in one frame beyond it starts the mesh again at rest */
  private jump: number;
  constructor(doc: Rig2DDoc, buffers: readonly Uint8Array[]) {
    this.jump = 0.25 * doc.canvas.height / (doc.canvas.unit ?? 1);
    const pIdx = new Map(doc.params.map((p, i) => [p.id, i])), mIdx = new Map(doc.meshes.map((m, i) => [m.id, i])), claimed = new Set<number>();
    for (const d of rig2dDynamics(doc)) {
      if (d.kind !== 'follow') continue;
      const meshes: FollowMesh[] = [];
      for (const id of d.meshes ?? []) {
        const mi = mIdx.get(id);
        if (mi === undefined || claimed.has(mi)) continue; // (a mesh belongs to the first follow that lists it)
        const m = doc.meshes[mi], n = m.vertexCount, nb = neighbours(viewArray(buffers, m.indices), n);
        claimed.add(mi);
        meshes.push({ id, mi, n, ...nb, p: new Float64Array(n * 2), v: new Float64Array(n * 2), pt: new Float64Array(n * 2), off: new Float64Array(n * 2), rest: new Float32Array(n * 2),
          tt: new Float64Array(n * 2), dd: new Float64Array(n * 2), pin: new Float32Array(n), size: 0, ready: false });
      }
      if (!meshes.length) continue;
      this.entries.push({ id: d.id, amt: d.amount ? pIdx.get(d.amount) ?? -1 : -1, scale: 1, k: Math.max(0, d.stiffness ?? DEF.k), c: d.damping !== undefined ? Math.max(0, d.damping) : dampFor(d.stiffness ?? DEF.k), autoC: d.damping === undefined, squash: cl(d.squash ?? DEF.squash, 0, 1),
        spread: cl(d.spread ?? DEF.spread, 0, 1), gravity: d.gravity ?? 0, gain: d.gain ?? 1, stretch: Math.max(0, d.stretch ?? DEF.stretch), anchor: d.anchor ?? 'top', reach: Math.max(0, d.reach ?? DEF.reach), meshes });
    }
  }
  get empty() { return !this.entries.length; }

  /** Take over the motion of another FollowThrough on the same rig rebuilt after an edit: every follow with the same id and the same
   *  mesh (same vertex count) continues where it was; its pins are made again from the new anchor / reach. */
  carryFrom(old: FollowThrough) {
    const O = new Map(old.entries.map((e) => [e.id, e]));
    for (const e of this.entries) {
      const o = O.get(e.id);
      if (!o) continue;
      for (const m of e.meshes) {
        const om = o.meshes.find((x) => x.id === m.id);
        if (!om || om.n !== m.n || !om.ready) continue;
        m.p.set(om.p); m.v.set(om.v); m.pt.set(om.pt); m.off.set(om.off); m.rest.set(om.rest);
        m.size = pinsOf(m.rest, e.anchor, e.reach, m.pin); m.ready = true;
      }
    }
    this.acc = old.acc; this.ns = old.ns;
  }
  /** Change a follow's settings live (the 2D avatar maker's sliders, no rebuild). Unknown ids are ignored. */
  tune(id: string, t: { stiffness?: number; damping?: number; spread?: number; gravity?: number; gain?: number; stretch?: number; squash?: number }) {
    for (const e of this.entries) if (e.id === id) {
      if (ok(t.stiffness)) { e.k = Math.max(0, t.stiffness); if (e.autoC) e.c = dampFor(e.k); } if (ok(t.damping)) { e.c = Math.max(0, t.damping); e.autoC = false; } if (ok(t.squash)) e.squash = cl(t.squash, 0, 1); if (ok(t.spread)) e.spread = cl(t.spread, 0, 1);
      if (ok(t.gravity)) e.gravity = t.gravity; if (ok(t.gain)) e.gain = t.gain; if (ok(t.stretch)) e.stretch = Math.max(0, t.stretch);
    }
  }
  /** A follow's offsets now (x, y per vertex, from where the rig puts them; tests); null = no such follow / mesh. */
  offsets(id: string, mesh: string): Float64Array | null { return this.entries.find((e) => e.id === id)?.meshes.find((m) => m.id === mesh)?.off ?? null; }
  /** A follow's vertex velocities now (x, y per vertex; tests); null = no such follow / mesh. */
  velocities(id: string, mesh: string): Float64Array | null { return this.entries.find((e) => e.id === id)?.meshes.find((m) => m.id === mesh)?.v ?? null; }
  /** A follow's settings now (tests); null = no such follow. */
  setting(id: string): { stiffness: number; damping: number; squash: number; spread: number; gravity: number; gain: number; stretch: number; size: number } | null {
    const e = this.entries.find((x) => x.id === id);
    return e ? { stiffness: e.k, damping: e.c, squash: e.squash, spread: e.spread, gravity: e.gravity, gain: e.gain, stretch: e.stretch, size: e.meshes[0]?.size ?? 0 } : null;
  }

  /** Call right AFTER ev.update(): advance by dt and move the listed meshes' vertices in ev.out.positions. */
  apply(ev: RigEval, dt: number, values: Float64Array) {
    if (!this.entries.length || !ev.evalCount) return; // (before the first evaluation the positions are not a pose yet)
    // the substeps due this frame (the accumulator is capped, like shared/rig2d/dynamics.ts) and where each falls between
    // the last frame's pose and this one's in time: any frame pattern sees the same motion
    const c0 = this.ns * H + this.acc;
    this.acc = Math.min(this.acc + (dt > 0 && Number.isFinite(dt) ? dt : 0), H * 12);
    const c1 = this.ns * H + this.acc;
    let n = 0;
    for (let a = this.acc; a >= H - EPS && n < 12; a -= H) n++;
    for (let j = 0; j < n; j++) this.w[j] = c1 > c0 ? cl(((this.ns + j + 1) * H - c0) / (c1 - c0), 0, 1) : 1;
    this.ns += n; this.acc -= n * H;
    for (const e of this.entries) {
      e.scale = followAmount(values, e.amt);
      const g = e.gain * e.scale;
      for (const m of e.meshes) {
        const T = ev.out.positions[m.mi], N2 = m.n * 2;
        if (!T || T.length !== N2) continue;
        let move = 0;
        for (let i = 0; i < N2; i += 2) move += Math.hypot(T[i] - m.pt[i], T[i + 1] - m.pt[i + 1]);
        if (!m.ready) { m.rest.set(T); m.size = pinsOf(m.rest, e.anchor, e.reach, m.pin); } // the first evaluated pose is the rest pose
        if (!m.ready || !(move / m.n <= this.jump)) { m.p.set(T); m.v.fill(0); m.off.fill(0); m.ready = true; } // first frame / teleport / not a number: start again AT REST
        else if (n) this.step(e, m, T, n);
        m.pt.set(T);
        this.draw(e, m, T, g);
      }
    }
  }

  /** Write the mesh's drawn positions: target + offset, plus the squash and stretch of the free region (the offsets' pin-weighted mean
   *  D says which way and how hard it is whipped: σ = 1 + squash · min(½, |D| / size) along D, 1 / σ across it, about the held
   *  side's centre, so the area stays), inside the stretch cap, times gain × amount. */
  private draw(e: FollowEntry, m: FollowMesh, T: Float32Array, g: number) {
    const N = m.n, off = m.off, pin = m.pin;
    let dx = 0, dy = 0, wsum = 0, ax = 0, ay = 0, pw = 0, mx = 0, my = 0;
    if (e.squash > 0 && m.size > 0) for (let i = 0; i < N; i++) {
      const a = i * 2, q = pin[i], f = 1 - q;
      dx += f * off[a]; dy += f * off[a + 1]; wsum += f; ax += q * T[a]; ay += q * T[a + 1]; pw += q; mx += T[a]; my += T[a + 1];
    }
    const dl = wsum > 1e-9 ? Math.hypot(dx, dy) / wsum : 0, s = Math.min(0.5, dl / (m.size || 1));
    if (!(e.squash > 0 && s > 0)) { for (let i = 0; i < N * 2; i++) T[i] += off[i] * g; return; }
    const ux = dx / wsum / dl, uy = dy / wsum / dl, sig = 1 + e.squash * s, ps = sig - 1, pp = 1 / sig - 1, cx = pw > 1e-9 ? ax / pw : mx / N, cy = pw > 1e-9 ? ay / pw : my / N;
    const lim = e.stretch * m.size, lim2 = lim * lim;
    for (let i = 0; i < N; i++) {
      const a = i * 2, f = 1 - pin[i], rx = T[a] - cx, ry = T[a + 1] - cy, along = rx * ux + ry * uy;
      let ox = off[a] + f * (ps * along * ux + pp * (rx - along * ux)), oy = off[a + 1] + f * (ps * along * uy + pp * (ry - along * uy));
      const l2 = ox * ox + oy * oy;
      if (l2 > lim2) { const k = lim / Math.sqrt(l2); ox *= k; oy *= k; }
      T[a] += ox * g; T[a + 1] += oy * g;
    }
  }

  /** n fixed substeps of one mesh; the target moves linearly from last frame's pose to T across them. */
  private step(e: FollowEntry, m: FollowMesh, T: Float32Array, n: number) {
    const N = m.n, p = m.p, v = m.v, pt = m.pt, tt = m.tt, dd = m.dd, off = m.off, pin = m.pin, st = m.start, adj = m.adj;
    const k = e.k, c = e.c, sk = e.spread * k, grav = e.gravity, lim = e.stretch * m.size, lim2 = lim * lim;
    for (let j = 0; j < n; j++) {
      const w = this.w[j];
      for (let a = 0; a < N * 2; a++) { const t = pt[a] + (T[a] - pt[a]) * w; tt[a] = t; dd[a] = p[a] - t; }
      for (let i = 0; i < N; i++) {
        const a = i * 2, dx = dd[a], dy = dd[a + 1], s0 = st[i], s1 = st[i + 1];
        let ax = -k * dx - c * v[a], ay = -k * dy - c * v[a + 1] + grav;
        if (s1 > s0) {
          let sx = 0, sy = 0;
          for (let q = s0; q < s1; q++) { const b = adj[q] * 2; sx += dd[b]; sy += dd[b + 1]; }
          const inv = 1 / (s1 - s0);
          ax += sk * (sx * inv - dx); ay += sk * (sy * inv - dy);
        }
        // (semi-implicit Euler, then the pin: a held vertex goes back to its target and loses its speed)
        const hold = 1 - pin[i];
        let vx = (v[a] + ax * H) * hold, vy = (v[a + 1] + ay * H) * hold;
        let ox = (p[a] + (v[a] + ax * H) * H - tt[a]) * hold, oy = (p[a + 1] + (v[a + 1] + ay * H) * H - tt[a + 1]) * hold;
        const l2 = ox * ox + oy * oy;
        if (l2 > lim2) {
          // too far: back onto the cap, and no more speed outward
          if (lim > 0) { const l = Math.sqrt(l2), ux = ox / l, uy = oy / l, out = vx * ux + vy * uy; ox = ux * lim; oy = uy * lim; if (out > 0) { vx -= out * ux; vy -= out * uy; } }
          else { ox = oy = vx = vy = 0; }
        }
        if (!Number.isFinite(ox + oy + vx + vy)) ox = oy = vx = vy = 0;
        p[a] = tt[a] + ox; p[a + 1] = tt[a + 1] + oy; v[a] = vx; v[a + 1] = vy; off[a] = ox; off[a + 1] = oy;
      }
    }
  }
}

// The 2D avatar maker's preview of the beyond-Live2D features (docs/RIG2D_FORMAT.md §8), following the format's
// definitions so what the maker shows is what the runtime will draw:
//   bones + skinning (§8.2: p' = Σ wᵢ·Bᵢ·Rᵢ⁻¹·p after the deformers; root bones follow their deformer through an "up"
//   probe), chain physics (§8.4), angle views (§8.9 cross-fade), costume layers (§8.8), particles (§8.7) and
//   attachments (§8.6) placed at their slots.
// It runs on top of the runtime evaluator's output (mesh positions after deformers) and uses the editor's PoseEval
// (unit-tested equal to the runtime) to map bone origins through the deformers. Pure (no DOM); the editor draws.
import type { EdBone, EdDoc, EdDynamic, EdParticles, EdSlot } from './doc.ts';
import type { PoseEval } from './pose.ts';
import { boneTurn, type Affine } from './skin.ts';

const RAD = Math.PI / 180;
const mul = (m: Affine, n: Affine): Affine => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const inv = (m: Affine): Affine => { const det = m[0] * m[3] - m[1] * m[2] || 1e-12; const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det; return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]; };
const trs = (x: number, y: number, deg: number, sx = 1, sy = 1): Affine => { const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD); return [c * sx, s * sx, -s * sy, c * sy, x, y]; };

/** A dynamics `amount` value held to 0..4 (not a number: 1), as the runtime reads it. */
const amountValue = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(4, v)) : 1);

export interface Sprite { tex: number; x: number; y: number; w: number; h: number; angle: number; alpha: number; pivot: [number, number]; blend: 'normal' | 'add' | 'multiply' | 'screen' }

interface Chain { dyn: EdDynamic; ids: string[]; px: number[]; py: number[]; vx: number[]; vy: number[]; init: boolean }
interface Particle { x: number; y: number; vx: number; vy: number; age: number; life: number; rot: number }

export class PreviewExtras {
  /** bone id → its model-space transform now (B) and the reference chain (R), for drawing bone handles. */
  boneWorld = new Map<string, Affine>();
  private boneRef = new Map<string, Affine>();
  private chains: Chain[] = [];
  private physAngle = new Map<string, number>();
  private parts = new Map<string, number>(); // part opacity (views × costumes)
  private viewCur = -1;
  private emit = new Map<string, { acc: number; list: Particle[]; burst: number; seed: number }>();
  private fired = new Map<string, number>(); // "kind:value" → seconds left
  private t = 0;
  /** Costume on / off as the user switches them in the maker (id → on). */
  costumeOn = new Map<string, boolean>();
  constructor(public doc: EdDoc) {}

  private springs = new Map<string, { y: number; v: number; acc: number }>();
  /** Spring / jiggle / wind dynamics (§8.4) → their output parameters. Call BEFORE evaluating the rig, with the values
   *  the animator / sliders set. `role` = tracked inputs for "role:<name>" inputs (degrees / 0..1 like the runtime). */
  driveParams(get: (id: string) => number, set: (id: string, v: number) => void, dt: number, o: { role?: (name: string) => number; wind?: number } = {}) {
    const P = new Map(this.doc.params.map((p) => [p.id, p]));
    const norm = (id: string, x: number) => { const p = P.get(id); if (!p) return 0; return x >= p.def ? (p.max > p.def ? (x - p.def) / (p.max - p.def) : 0) : (p.def > p.min ? (x - p.def) / (p.def - p.min) : 0); };
    // (as the runtime: the normalised output maps onto the range around the default, then holds to the parameter's range)
    const denorm = (id: string, v: number) => { const p = P.get(id)!; const x = v >= 0 ? p.def + v * (p.max - p.def) : p.def + v * (p.def - p.min); return Math.max(Math.min(p.min, p.max), Math.min(Math.max(p.min, p.max), x)); };
    const h = 1 / 120;
    // the part's swing amount (format §8.4 `amount`): its parameter's value now scales the motion, as the runtime does
    const amt = (y: EdDynamic, n: number) => (y.amount && P.has(y.amount) ? Math.max(-1, Math.min(1, n)) * amountValue(get(y.amount)) : n);
    for (const y of this.doc.extras?.dynamics ?? []) {
      if (y.kind === 'chain' || !y.output || !P.has(y.output)) continue;
      let st = this.springs.get(y.id);
      if (!st) { st = { y: 0, v: 0, acc: 0 }; this.springs.set(y.id, st); }
      if (y.kind === 'wind') {
        const ph = (hash(y.id) % 1000) / 1000 * Math.PI * 2, T = Math.max(0.3, y.period ?? 3);
        const gust = (Math.sin((this.t * 2 * Math.PI) / T + ph) + 0.5 * Math.sin((this.t * 2 * Math.PI) / (T * 0.37) + ph * 2)) / 1.5;
        set(y.output, denorm(y.output, amt(y, (y.gain ?? 1) * (y.strength ?? 1) * (o.wind ?? 0.3) * gust)));
        continue;
      }
      const inp = y.input ?? '';
      const x = inp.startsWith('role:') ? (o.role ? o.role(inp.slice(5)) : 0) / (inp.slice(5).startsWith('head') ? 30 : inp.slice(5).startsWith('body') ? 10 : 1) : norm(inp, get(inp));
      const k = y.stiffness ?? (y.kind === 'spring' ? 60 : 180), c = y.damping ?? (y.kind === 'spring' ? 8 : 6);
      st.acc = Math.min(st.acc + dt, 0.1);
      while (st.acc >= h) { const a = k * (x - st.y) - c * st.v; st.v += a * h; st.y += st.v * h; st.acc -= h; }
      set(y.output, denorm(y.output, amt(y, (y.gain ?? 1) * (y.kind === 'spring' ? st.y : st.y - x))));
    }
  }

  reset() { this.springs.clear(); this.chains = []; this.physAngle.clear(); this.emit.clear(); this.fired.clear(); this.t = 0; }
  /** Fire an event-like trigger (emotion / chat / hotkey / event) for the effects. */
  fire(kind: string, value: string) { this.fired.set(`${kind}:${value.toLowerCase()}`, 0); }

  // ------------------------------------------------------------------ bones
  private computeBones(pose: PoseEval) {
    const bones = this.doc.extras?.bones ?? [];
    this.boneWorld.clear(); this.boneRef.clear();
    const byId = new Map(bones.map((b) => [b.id, b]));
    const probe = new Float64Array(4);
    const get = (b: EdBone, depth: number): void => {
      if (this.boneWorld.has(b.id) || depth > 64) return;
      const turn = boneTurn(b, pose.get) + (this.physAngle.get(b.id) ?? 0);
      const parent = b.parent ? byId.get(b.parent) : undefined;
      if (parent) {
        get(parent, depth + 1);
        // local frame relative to the parent's rest frame (editor coordinates are absolute rest space)
        const pr = trs(parent.x, parent.y, parent.angle), local = mul(inv(pr), trs(b.x, b.y, b.angle));
        const lx = local[4], ly = local[5], la = b.angle - parent.angle;
        this.boneWorld.set(b.id, mul(this.boneWorld.get(parent.id)!, trs(lx, ly, la + turn)));
        this.boneRef.set(b.id, mul(this.boneRef.get(parent.id)!, trs(lx, ly, la)));
        return;
      }
      // a root bone follows its deformer: origin mapped, angle turned by the chain's local turn (an "up" probe)
      probe[0] = b.x; probe[1] = b.y; probe[2] = b.x; probe[3] = b.y - 10;
      pose.through(b.deformer, probe, 2);
      const up = Math.atan2(probe[2] - probe[0], -(probe[3] - probe[1])) / RAD;
      this.boneWorld.set(b.id, trs(probe[0], probe[1], b.angle + up + turn));
      this.boneRef.set(b.id, trs(probe[0], probe[1], b.angle + up));
    };
    for (const b of bones) get(b, 0);
  }

  /** Skin mesh positions (after deformers) in place: normalised top-4 weights, as exported. */
  private skin(positions: Float32Array[]) {
    const S = new Map<string, Affine>();
    for (const [id, B] of this.boneWorld) S.set(id, mul(B, inv(this.boneRef.get(id)!)));
    this.doc.meshes.forEach((m, mi) => {
      if (!m.skin) return;
      const P = positions[mi];
      if (!P) return;
      const ids = Object.keys(m.skin).filter((id) => S.has(id));
      const n = P.length / 2;
      for (let i = 0; i < n; i++) {
        const ws = ids.map((id) => [S.get(id)!, m.skin![id][i] ?? 0] as const).filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
        let sw = 0, sx = 0, sy = 0;
        const x = P[i * 2], y = P[i * 2 + 1];
        for (const [M, w] of ws) { sx += (M[0] * x + M[2] * y + M[4]) * w; sy += (M[1] * x + M[3] * y + M[5]) * w; sw += w; }
        if (sw > 0) { P[i * 2] = sx / sw; P[i * 2 + 1] = sy / sw; }
      }
    });
  }

  // ------------------------------------------------------------------ chain physics (§8.4)
  private stepChains(dt: number, wind: number) {
    const dyn = (this.doc.extras?.dynamics ?? []).filter((y) => y.kind === 'chain' && y.bones?.length);
    if (this.chains.length !== dyn.length || this.chains.some((c, i) => c.dyn !== dyn[i])) this.chains = dyn.map((d) => ({ dyn: d, ids: d.bones!, px: [], py: [], vx: [], vy: [], init: false }));
    const bones = new Map((this.doc.extras?.bones ?? []).map((b) => [b.id, b]));
    const h = 1 / 120;
    for (const c of this.chains) {
      const k = c.dyn.stiffness ?? 40, damp = c.dyn.damping ?? 6, g = c.dyn.gravity ?? 0;
      const list = c.ids.map((id) => bones.get(id)).filter(Boolean) as EdBone[];
      if (!list.length) continue;
      // the chain's rest shape now (reference transforms, without physics)
      const ref = list.map((b) => this.boneRef.get(b.id));
      if (ref.some((r) => !r)) continue;
      const restPts: [number, number][] = [[ref[0]![4], ref[0]![5]]];
      list.forEach((b, i) => { const r = ref[i]!; restPts.push([r[4] + r[0] * b.length, r[5] + r[1] * b.length]); });
      if (!c.init || c.px.length !== restPts.length) { c.px = restPts.map((p) => p[0]); c.py = restPts.map((p) => p[1]); c.vx = restPts.map(() => 0); c.vy = restPts.map(() => 0); c.init = true; }
      let steps = Math.min(12, Math.max(1, Math.round(dt / h)));
      while (steps-- > 0) {
        c.px[0] = restPts[0][0]; c.py[0] = restPts[0][1];
        for (let i = 1; i < restPts.length; i++) {
          // spring toward the rest shape (relative to the moving parent point) + gravity + wind, damped
          const tx = c.px[i - 1] + (restPts[i][0] - restPts[i - 1][0]), ty = c.py[i - 1] + (restPts[i][1] - restPts[i - 1][1]);
          const ax = (tx - c.px[i]) * k - c.vx[i] * damp + wind * 60 * Math.sin(this.t * 1.7 + i);
          const ay = (ty - c.py[i]) * k - c.vy[i] * damp + g;
          c.vx[i] += ax * h; c.vy[i] += ay * h;
          c.px[i] += c.vx[i] * h; c.py[i] += c.vy[i] * h;
          // keep the segment length
          const L = Math.hypot(restPts[i][0] - restPts[i - 1][0], restPts[i][1] - restPts[i - 1][1]) || 1;
          const dx = c.px[i] - c.px[i - 1], dy = c.py[i] - c.py[i - 1], d = Math.hypot(dx, dy) || 1;
          c.px[i] = c.px[i - 1] + (dx / d) * L; c.py[i] = c.py[i - 1] + (dy / d) * L;
        }
      }
      // angles: each simulated segment vs its rest direction, relative to the parent's. As the runtime (dynamics.ts):
      // the part's swing amount scales what drives it (here its bend: the same in this spring sim), then each bone holds
      // to the chain's boneLimit and the whole chain's bend to its limit
      const am = c.dyn.amount ? amountValue(this.doc.params.find((p) => p.id === c.dyn.amount)?.def ?? 1) : 1;
      const boneLim = Math.min(80, Math.max(0, c.dyn.boneLimit ?? 50)), allLim = Math.min(180, Math.max(0, c.dyn.limit ?? 90));
      let prevAbs = 0, cum = 0;
      list.forEach((b, i) => {
        const sim = Math.atan2(c.py[i + 1] - c.py[i], c.px[i + 1] - c.px[i]) / RAD;
        const rest = Math.atan2(restPts[i + 1][1] - restPts[i][1], restPts[i + 1][0] - restPts[i][0]) / RAD;
        let a = sim - rest; while (a > 180) a -= 360; while (a < -180) a += 360;
        let rel = Math.max(-boneLim, Math.min(boneLim, (a - prevAbs) * am));
        rel = Math.max(-allLim - cum, Math.min(allLim - cum, rel));
        prevAbs = a; cum += rel;
        this.physAngle.set(b.id, rel);
      });
    }
  }

  // ------------------------------------------------------------------ views + costumes → part opacity
  partOpacity(): Map<string, number> { return this.parts; }
  /** Folder opacity from views + costumes at the pose's values (own factor only; the runtime multiplies down the tree). */
  partsAt(pose: PoseEval): (partId: string) => number { this.computeParts(pose); return (id) => this.parts.get(id) ?? 1; }
  private computeParts(pose: PoseEval) {
    this.parts.clear();
    const X = this.doc.extras;
    if (X?.views && X.views.sets.length >= 2) {
      // the runtime's hand-over (§8.9): one set opaque, the neighbour fades in over a band around the midpoint, with
      // hysteresis (shared/rig2d/animate.ts applyViews)
      const by = X.views.by.startsWith('role:') ? 'ParamAngleX' : X.views.by;
      const v = pose.get(by), sets = X.views.sets.slice().sort((a, b) => a.at - b.at), n = sets.length;
      const band = X.views.blendBand ?? 2, hyst = X.views.hysteresis ?? 2;
      const mid = (k: number) => (sets[k].at + sets[k + 1].at) / 2;
      const bh = (k: number) => { const q = Math.abs(sets[k + 1].at - sets[k].at) / 4; return [Math.min(band, q), Math.min(hyst, q)]; };
      let c = this.viewCur;
      if (c < 0 || c >= n) { c = 0; for (let k = 1; k < n; k++) if (Math.abs(sets[k].at - v) < Math.abs(sets[c].at - v)) c = k; }
      for (let g = 0; g < n; g++) {
        if (c < n - 1) { const [b, h] = bh(c); if (v >= mid(c) + b + h) { c++; continue; } }
        if (c > 0) { const [b, h] = bh(c - 1); if (v <= mid(c - 1) - b - h) { c--; continue; } }
        break;
      }
      this.viewCur = c;
      const w = new Array(n).fill(0);
      let lo = -1, t = 0;
      if (c < n - 1) { const [b, h] = bh(c), st = mid(c) - b + h; if (v > st) { lo = c; t = b > 0 ? (v - st) / (2 * b) : 1; } }
      if (lo < 0 && c > 0) { const [b, h] = bh(c - 1), e = mid(c - 1) + b - h; if (v < e) { lo = c - 1; t = b > 0 ? 1 - (e - v) / (2 * b) : 0; } }
      if (lo < 0) w[c] = 1;
      else { t = Math.min(1, Math.max(0, t)); w[lo] = Math.min(1, 2 * (1 - t)); w[lo + 1] = Math.min(1, 2 * t); }
      sets.forEach((st, k) => { for (const p of st.parts) this.parts.set(p, Math.max(this.parts.get(p) ?? 0, w[k])); });
    }
    for (const c of X?.costumes ?? []) {
      const on = this.costumeOn.get(c.id) ?? c.on;
      if (!on) for (const p of c.parts) this.parts.set(p, 0);
    }
  }
  /** Mesh opacity factor from its folder chain. */
  meshFactor(mi: number): number {
    const parts = this.doc.extras?.parts ?? [];
    let f = 1;
    for (let p = this.doc.meshes[mi]?.part ?? null, d = 0; p && d < 64; d++) { const o = this.parts.get(p); if (o !== undefined) f *= o; p = parts.find((x) => x.id === p)?.parent ?? null; }
    return f;
  }

  // ------------------------------------------------------------------ slots, attachments, particles
  /** A slot's position and turn (degrees) now. */
  slotAt(sl: EdSlot, positions: Float32Array[], pose: PoseEval): { x: number; y: number; angle: number } | null {
    if (sl.mesh) {
      const mi = this.doc.meshes.findIndex((m) => m.id === sl.mesh);
      const P = positions[mi];
      if (!P) return null;
      const i = Math.min(P.length / 2 - 1, sl.vertex ?? 0);
      let angle = 0;
      if (sl.vertex2 !== undefined && sl.vertex2 < P.length / 2) angle = Math.atan2(P[sl.vertex2 * 2 + 1] - P[i * 2 + 1], P[sl.vertex2 * 2] - P[i * 2]) / RAD;
      return { x: P[i * 2], y: P[i * 2 + 1], angle };
    }
    if (sl.bone) {
      const B = this.boneWorld.get(sl.bone);
      if (!B) return null;
      const x = sl.x ?? 0, y = sl.y ?? 0;
      return { x: B[0] * x + B[2] * y + B[4], y: B[1] * x + B[3] * y + B[5], angle: Math.atan2(B[1], B[0]) / RAD };
    }
    const pts = new Float64Array([sl.x ?? 0, sl.y ?? 0, sl.x ?? 0, (sl.y ?? 0) - 10]);
    pose.through(sl.deformer ?? null, pts, 2);
    return { x: pts[0], y: pts[1], angle: Math.atan2(pts[2] - pts[0], -(pts[3] - pts[1])) / RAD };
  }

  private active(p: EdParticles, voice: number, expression: string | null, pose: PoseEval): boolean {
    const t = p.trigger;
    switch (t.kind) {
      case 'always': return true;
      case 'voice': return voice >= (t.above ?? 0.15);
      case 'param': return !!t.value && pose.get(t.value) >= (t.above ?? 0.5);
      case 'expression': return !!t.value && expression === t.value;
      default: { const left = this.emit.get(p.id)?.burst ?? 0; return left > 0; }
    }
  }

  /** Advance everything; positions (after deformers) are skinned in place. Returns the sprites to draw. */
  update(pose: PoseEval, positions: Float32Array[], dt: number, o: { voice?: number; expression?: string | null; wind?: number; skin?: boolean } = {}): Sprite[] {
    this.t += dt;
    this.computeBones(pose);
    // positions from the runtime evaluator are skinned already (and its animator runs the chains): skin: false
    if (o.skin !== false && this.doc.extras?.dynamics?.some((y) => y.kind === 'chain')) { this.stepChains(dt, o.wind ?? 0); this.computeBones(pose); }
    if (o.skin !== false && this.boneWorld.size) this.skin(positions);
    this.computeParts(pose);
    const out: Sprite[] = [];
    const X = this.doc.extras ?? {};
    for (const a of X.attachments ?? []) {
      const on = this.costumeOn.get(`att:${a.id}`) ?? a.on;
      if (!on) continue;
      const s = this.slotAt(a.slot, positions, pose);
      if (!s) continue;
      out.push({ tex: a.tex, x: s.x, y: s.y, w: a.size[0], h: a.size[1], angle: (a.rotate === false ? 0 : s.angle) + (a.angle ?? 0), alpha: 1, pivot: a.pivot, blend: a.blend ?? 'normal' });
    }
    // particles: event-like triggers burst for `burst` s after fire()
    for (const p of X.particles ?? []) {
      if (p.on === false) continue;
      let st = this.emit.get(p.id);
      if (!st) { st = { acc: 0, list: [], burst: 0, seed: hash(p.id) }; this.emit.set(p.id, st); }
      const key = `${p.trigger.kind}:${(p.trigger.value ?? '').toLowerCase()}`;
      if (this.fired.has(key)) st.burst = p.trigger.burst ?? 1;
      const s = this.slotAt(p.slot, positions, pose);
      if (s && this.active(p, o.voice ?? 0, o.expression ?? null, pose)) {
        st.acc += p.rate * dt;
        while (st.acc >= 1 && st.list.length < (p.max ?? 64)) {
          st.acc -= 1;
          const r1 = rnd(st), r2 = rnd(st);
          const dir = ((p.angle ?? 0) + (r1 * 2 - 1) * p.spread) * RAD, sp = p.speed[0] + (p.speed[1] - p.speed[0]) * r2;
          st.list.push({ x: s.x, y: s.y, vx: Math.sin(dir) * sp, vy: -Math.cos(dir) * sp, age: 0, life: p.life, rot: rnd(st) * 360 });
        }
        if (st.acc > 1) st.acc = 1;
      }
      st.burst = Math.max(0, st.burst - dt);
      st.list = st.list.filter((q) => (q.age += dt) < q.life);
      const fade = p.fade ?? 0.3;
      for (const q of st.list) {
        q.vx += p.gravity[0] * dt; q.vy += p.gravity[1] * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += (p.spin ?? 0) * dt;
        const k = q.age / q.life, size = p.size[0] + (p.size[1] - p.size[0]) * k;
        const alpha = k > 1 - fade ? (1 - k) / Math.max(1e-3, fade) : 1;
        out.push({ tex: p.tex, x: q.x, y: q.y, w: size, h: size, angle: q.rot, alpha, pivot: [0.5, 0.5], blend: p.blend ?? 'normal' });
      }
    }
    this.fired.clear();
    return out;
  }
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
function rnd(st: { seed: number }) { st.seed = (Math.imul(st.seed, 1664525) + 1013904223) >>> 0; return st.seed / 4294967296; }

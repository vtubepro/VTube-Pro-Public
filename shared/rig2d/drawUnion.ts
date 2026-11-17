// What a 2D rig can draw at all (VTube Pro's .vtp2): the union of its meshes over head / body extremes, expressions,
// physics swing (follow meshes padded by their wobble reach) and the costume layers / model sliders in use, for framing the card it is shown on (src/avatar/flat/FlatAvatar.ts: framing must
// never cut off a head tilt, a hair swing or an outfit). Pure (no DOM): unit-tested in tools/flat_unit.ts.
import { L2D_STANDARD } from './drive.ts';
import type { RigEval } from './evaluate.ts';
import { rig2dDynamics, type Rig2DDoc } from './format.ts';

/** Everything the puppet can draw, as steps (one rig evaluation each: a caller can spread them over idle time): the
 *  head / body extremes and the expressions frameBounds uses; each head / body extreme again with every secondary
 *  motion at its far ends — Cubism physics outputs, `dynamics` outputs (springs, jiggle, wind, Inochi2D pendulums: their
 *  output parameters at min / max) and bone chains bent to their limits (each bone up to its own limit, the whole
 *  chain's bend inside the chain limit: root-first and spread along it, both ways). Costume layers count as they are
 *  now (the part opacities the animator left: a jacket that is off is not framed; switching it on bumps the source's
 *  boundsVersion and the card is measured again — SilhouetteWatch); expressions also with their part opacities. Returns the box in model units (y down), or null when nothing is drawn. `base`: the values to start from
 *  (default the rig's defaults; the display side passes the live ones so model sliders count). `held`: the model
 *  sliders' parameter ids (kept at `base`). The rig's values, bone offsets and part opacities are restored after every
 *  step. */
export function* drawUnionSteps(doc: Rig2DDoc, ev: RigEval, base?: Float64Array, held: ReadonlySet<string> = new Set()): Generator<void, [number, number, number, number] | null, void> {
  // (`held`: the performer's model sliders — outfits, a jacket, hair length: they stay as they are now (`base`), an
  // expression never sets them here; a change of them is a new measure: SilhouetteWatch)
  const keep = new Set([...held].map((id) => ev.paramIndex(id)).filter((i) => i >= 0));
  const poses: Record<string, number>[] = [{}, { ParamAngleX: 30 }, { ParamAngleX: -30 }, { ParamAngleY: 30 }, { ParamAngleY: -30 }, { ParamAngleZ: 30 }, { ParamAngleZ: -30 }, { ParamBodyAngleX: 10 }, { ParamBodyAngleX: -10 }];
  const idx = (k: string) => { let i = ev.paramIndex(k); if (i < 0) for (const a of Object.values(L2D_STANDARD).find((l) => l!.includes(k)) ?? []) { i = ev.paramIndex(a); if (i >= 0) break; } return i; };
  const dyn = rig2dDynamics(doc); // includes the follow-throughs stored in extra.follow (a written file keeps them there)
  const phys = [...new Set([
    ...(doc.physics ?? []).flatMap((p) => p.outputs.map((o) => o.param)),
    ...dyn.filter((d) => d.kind !== 'chain').flatMap((d) => [d.output, d.output2]).filter((x): x is string => !!x),
  ].map((id) => ev.paramIndex(id)).filter((i) => i >= 0))];
  // bone chains: per chain its bones (indices), each bone's limit and the chain's (degrees, x gain as the solver applies)
  const bIdx = new Map((doc.bones ?? []).map((b, i) => [b.id, i]));
  const chains = dyn.filter((d) => d.kind === 'chain').map((d) => {
    const g = Math.abs(d.gain ?? 1);
    return { bones: (d.bones ?? []).map((b) => bIdx.get(b) ?? -1).filter((b) => b >= 0), bone: Math.min(80, Math.max(0, d.boneLimit ?? 50)) * g, all: Math.min(180, Math.max(0, d.limit ?? 90)) * g };
  }).filter((c) => c.bones.length);
  /** Bend every chain: `even` spreads the chain's limit over its bones, else root-first (each bone to its own limit
   *  until the chain's is used up); `s` = which way. */
  const bend = (s: number, even: boolean) => {
    for (const c of chains) {
      let left = c.all;
      c.bones.forEach((b) => { const a = Math.min(c.bone, even ? c.all / c.bones.length : left, left); ev.boneAngleAdd[b] += s * a; left -= a; });
    }
  };
  // variants of the secondary motion: none; then each way, chains root-first and spread
  const variants: { s: number; even: boolean }[] = [{ s: 0, even: false }];
  if (phys.length || chains.length) for (const s of [-1, 1]) for (const even of chains.length ? [false, true] : [false]) variants.push({ s, even });
  const start = base ?? Float64Array.from(doc.params.map((q) => q.default));
  const partIdx = new Map(doc.parts.map((q, i) => [q.id, i]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // follow meshes wobble past where the rig puts them (shared/rig2d/follow.ts: at most stretch × the mesh's diagonal × gain × its amount parameter's DEFAULT: a slider turned up is not framed for, a 4× pad would shrink every card): their boxes are widened by that
  const followPad = new Map<number, number>(), mIdx = new Map(doc.meshes.map((q, i) => [q.id, i]));
  for (const d of dyn) if (d.kind === 'follow') {
    const ai = d.amount ? doc.params.findIndex((q) => q.id === d.amount) : -1, top = ai >= 0 ? Math.min(4, Math.max(0, doc.params[ai].default)) : 1;
    for (const id of d.meshes ?? []) { const mi = mIdx.get(id); if (mi !== undefined && !followPad.has(mi)) followPad.set(mi, Math.max(0, d.stretch ?? 0.2) * Math.abs(d.gain ?? 1) * top); }
  }
  const take = () => {
    const o = ev.out;
    for (let m = 0; m < o.positions.length; m++) {
      if (!(o.enabled[m] && o.opacity[m] > 0)) continue;
      const p = o.positions[m], k = followPad.get(m);
      if (k === undefined) { for (let j = 0; j < p.length; j += 2) { const x = p[j], y = p[j + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } continue; }
      let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
      for (let j = 0; j < p.length; j += 2) { const x = p[j], y = p[j + 1]; if (x < a0) a0 = x; if (x > a1) a1 = x; if (y < b0) b0 = y; if (y > b1) b1 = y; }
      if (!(a0 <= a1)) continue;
      const pad = k * Math.hypot(a1 - a0, b1 - b0);
      if (a0 - pad < x0) x0 = a0 - pad; if (a1 + pad > x1) x1 = a1 + pad; if (b0 - pad < y0) y0 = b0 - pad; if (b1 + pad > y1) y1 = b1 + pad;
    }
  };
  const run = (set: () => void) => {
    const save = Float64Array.from(ev.values), bsave = Float64Array.from(ev.boneAngleAdd), psave = Float32Array.from(ev.partOpacity);
    try { ev.values.set(start); ev.boneAngleAdd.fill(0); set(); ev.update(); take(); } finally { ev.values.set(save); ev.boneAngleAdd.set(bsave); ev.partOpacity.set(psave); }
  };
  for (const p of poses) for (const v of variants) {
    run(() => {
      for (const [k, val] of Object.entries(p)) { const i = idx(k); if (i >= 0) ev.values[i] = val; }
      if (v.s) { for (const i of phys) ev.values[i] = v.s < 0 ? doc.params[i].min : doc.params[i].max; bend(v.s, v.even); }
    });
    yield;
  }
  for (const e of (doc.expressions ?? []).slice(0, 48)) {
    run(() => {
      for (const p of e.params) { const i = ev.paramIndex(p.param); if (i < 0 || keep.has(i)) continue; const q = doc.params[i], v = p.blend === 'overwrite' ? p.value : p.blend === 'multiply' ? ev.values[i] * p.value : ev.values[i] + p.value; ev.values[i] = Math.min(q.max, Math.max(q.min, v)); }
      for (const po of e.parts ?? []) { const pi = partIdx.get(po.part); if (pi !== undefined) ev.partOpacity[pi] = po.opacity; }
    });
    yield;
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** A model-unit box (y down) → picture fractions of the frame `view` (x from the left, y from the BOTTOM), clipped to it. */
export function viewFractions(b: [number, number, number, number], view: [number, number, number, number]): { x0: number; x1: number; y0: number; y1: number } {
  const w = view[2] - view[0], h = view[3] - view[1], c = (v: number) => Math.min(1, Math.max(0, v));
  return { x0: c((b[0] - view[0]) / w), x1: c((b[2] - view[0]) / w), y0: c(1 - (b[3] - view[1]) / h), y1: c(1 - (b[1] - view[1]) / h) };
}

/** When what a rig can draw changes while it runs: its costume layers switched, or a model slider moved that changes
 *  the silhouette (moves vertices, or shows / hides a mesh — a jacket dissolve). Sliders that only tint / animate in
 *  place are left out (found once: each slider at both ends against the rest pose). update() says when to measure
 *  again: the state changed and then held still for `settle` seconds (a key / toggle: 0.12 s after it; a slider being
 *  dragged: once, after it stops). */
export class SilhouetteWatch {
  readonly moving: { id: string; lo: number; span: number }[] = [];
  private since = 0;
  constructor(doc: Rig2DDoc, ev: RigEval, userIds: readonly string[], private settle = 0.12) {
    const save = Float64Array.from(ev.values), def = doc.params.map((q) => q.default);
    const snap = () => ({ pos: ev.out.positions.map((p) => Float32Array.from(p)), vis: Array.from(ev.out.opacity, (o, m) => (o > 0.001 && ev.out.enabled[m] ? 1 : 0)) });
    try {
      ev.values.set(def); ev.update();
      const rest = snap();
      for (const id of userIds.slice(0, 128)) {
        const i = ev.paramIndex(id);
        if (i < 0) continue;
        const q = doc.params[i];
        let moves = false;
        for (const to of [q.min, q.max]) {
          if (moves || Math.abs(to - q.default) < 1e-9) continue;
          ev.values.set(def); ev.values[i] = to; ev.update();
          const now = snap();
          moves = now.vis.some((v, m) => v !== rest.vis[m]) || now.pos.some((p, m) => { const r = rest.pos[m]; for (let k = 0; k < p.length; k++) if (Math.abs(p[k] - r[k]) > 1e-4) return true; return false; });
        }
        if (moves) this.moving.push({ id, lo: Math.min(q.min, q.max), span: Math.max(1e-9, Math.abs(q.max - q.min)) });
      }
    } finally { ev.values.set(save); ev.update(); }
  }
  /** The silhouette's state, written into a reused buffer (no allocation per frame): the layers on / off, the moving
   *  sliders' values (in 20ths of their range) and one extra number (the caller's: a hash of the toggled outfits). */
  private cur = new Float64Array(0);
  private pending = new Float64Array(0);
  private committedKey = new Float64Array(0);
  private seeded = false;
  key(layersOn: readonly boolean[], value: (id: string) => number, extra = 0): Float64Array {
    const n = layersOn.length + this.moving.length + 1;
    if (this.cur.length !== n) this.cur = new Float64Array(n);
    let k = 0;
    for (const on of layersOn) this.cur[k++] = on ? 1 : 0;
    for (const m of this.moving) this.cur[k++] = Math.round(((value(m.id) - m.lo) / m.span) * 20);
    this.cur[k] = extra;
    return this.cur;
  }
  /** Feed the state each frame (`time` in s): true once when it changed and has then held for `settle` s (measure again
   *  now: a key / toggle 0.12 s after it, a slider drag once it stops). */
  update(key: Float64Array, time: number): boolean {
    const same = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!this.seeded) { this.seeded = true; this.committedKey = Float64Array.from(key); this.pending = Float64Array.from(key); return false; }
    if (!same(key, this.pending)) { if (this.pending.length !== key.length) this.pending = new Float64Array(key.length); this.pending.set(key); this.since = time; }
    if (!same(this.pending, this.committedKey) && time - this.since >= this.settle) { if (this.committedKey.length !== key.length) this.committedKey = new Float64Array(key.length); this.committedKey.set(this.pending); return true; }
    return false;
  }
}

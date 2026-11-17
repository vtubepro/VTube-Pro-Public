// Bones + skinning for the editor. Bones live in the rest space of the deformer their meshes hang under (so a hair bone
// turns with the head), each turned by its forms (value.a, degrees clockwise on screen) about its origin, children
// carried by their parents. A vertex moves by the weighted blend of its bones' moves (linear blend skinning), applied
// in rest space before the deformers, like any keyform.
// Export (vtp2.ts) bakes the bones into additive blend shapes per driving parameter, so every runtime draws them and
// they follow the deformers; the bones themselves are written too (docs/RIG2D_FORMAT.md §8.2). Pure (no DOM).
import { corners, type EdBone, type EdDoc, type EdForm, type EdMesh } from './doc.ts';

export type Affine = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f
const I: Affine = [1, 0, 0, 1, 0, 0];
const mul = (m: Affine, n: Affine): Affine => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const rotAbout = (x: number, y: number, deg: number): Affine => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
};
export const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A bone's own turn (degrees) at parameter values. */
export function boneTurn(b: EdBone, vals: (id: string) => number): number {
  let a = 0;
  const idx: number[] = [], w: number[] = [];
  for (const f of b.forms) {
    const n = corners(f, vals, idx, w);
    for (let c = 0; c < n; c++) { const v = f.values[idx[c]]; if (v?.a && w[c]) a += v.a * w[c]; }
  }
  return a;
}

/** Every bone's skinning transform (rest space → posed rest space) at parameter values. */
export function boneMatrices(bones: readonly EdBone[], vals: (id: string) => number): Map<string, Affine> {
  const out = new Map<string, Affine>();
  const byId = new Map(bones.map((b) => [b.id, b]));
  const get = (b: EdBone, depth: number): Affine => {
    const have = out.get(b.id);
    if (have) return have;
    const parent = b.parent && depth < 64 ? byId.get(b.parent) : undefined;
    const pm = parent ? get(parent, depth + 1) : I;
    const m = mul(pm, rotAbout(b.x, b.y, boneTurn(b, vals)));
    out.set(b.id, m);
    return m;
  };
  for (const b of bones) get(b, 0);
  return out;
}

/** Skin points (x, y pairs, in place) of a mesh with weights `skin`. */
export function skinPoints(pts: Float64Array | number[], n: number, skin: Record<string, number[]>, mats: Map<string, Affine>) {
  const entries = Object.entries(skin).map(([id, w]) => [mats.get(id), w] as const).filter(([m]) => !!m) as [Affine, number[]][];
  if (!entries.length) return;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    let sx = 0, sy = 0, sw = 0;
    for (const [m, w] of entries) {
      const wi = w[i] ?? 0;
      if (!wi) continue;
      sx += (m[0] * x + m[2] * y + m[4]) * wi; sy += (m[1] * x + m[3] * y + m[5]) * wi; sw += wi;
    }
    if (sw <= 0) continue; // unweighted: stays where the deformers put it (the format's rule)
    pts[i * 2] = sx / sw; pts[i * 2 + 1] = sy / sw; // weights are normalised, as on export
  }
}

/** The parameters (and their keys) that turn any bone a mesh is weighted to. */
export function skinParams(doc: EdDoc, m: EdMesh): Map<string, number[]> {
  const out = new Map<string, Set<number>>();
  const bones = doc.extras?.bones ?? [];
  const byId = new Map(bones.map((b) => [b.id, b]));
  const visit = (b: EdBone | undefined, d = 0) => {
    if (!b || d > 64) return;
    for (const f of b.forms) for (const a of f.axes) { let s = out.get(a.param); if (!s) out.set(a.param, s = new Set()); for (const k of a.keys) s.add(k); }
    visit(b.parent ? byId.get(b.parent) : undefined, d + 1);
  };
  for (const id of Object.keys(m.skin ?? {})) visit(byId.get(id));
  const res = new Map<string, number[]>();
  for (const [p, ks] of out) {
    // densify: rotations are curved, blend shapes are straight between keys
    const k = [...ks].sort((a, b) => a - b);
    const dense = new Set(k);
    for (let i = 0; i + 1 < k.length; i++) dense.add((k[i] + k[i + 1]) / 2);
    res.set(p, [...dense].sort((a, b) => a - b));
  }
  return res;
}

/** Bake a mesh's skinning into one additive form per driving parameter (rest-space offsets at each key, every other
 *  parameter at its default). */
export function bakeSkin(doc: EdDoc, m: EdMesh): EdForm[] {
  if (!m.skin || !Object.keys(m.skin).length) return [];
  const bones = doc.extras?.bones ?? [];
  const def = (id: string) => doc.params.find((p) => p.id === id)?.def ?? 0;
  const n = m.mesh.pos.length / 2, out: EdForm[] = [];
  for (const [param, keys] of skinParams(doc, m)) {
    const values = keys.map((k) => {
      const mats = boneMatrices(bones, (id) => (id === param ? k : def(id)));
      const p = m.mesh.pos.slice();
      skinPoints(p, n, m.skin!, mats);
      const d = p.map((v, i) => v - m.mesh.pos[i]);
      return d.some((x) => Math.abs(x) > 1e-4) ? { d } : null;
    });
    if (values.some(Boolean)) out.push({ axes: [{ param, keys }], values, auto: true });
  }
  return out;
}

// ---------------------------------------------------------------- weights
/** Automatic weights for a chain of bones over a mesh: each vertex follows the chain by its distance along it, blended
 *  smoothly across joints; vertices before the first bone stay put (the root). */
export function chainWeights(m: EdMesh, chain: EdBone[], blend = 0.35, anchor?: EdBone): Record<string, number[]> {
  const n = m.mesh.pos.length / 2;
  const out: Record<string, number[]> = {};
  for (const b of chain) out[b.id] = new Array(n).fill(0);
  if (anchor) out[anchor.id] = new Array(n).fill(0);
  if (!chain.length) return out;
  for (let i = 0; i < n; i++) {
    const x = m.mesh.pos[i * 2], y = m.mesh.pos[i * 2 + 1];
    // nearest point on the chain: which bone + how far along it
    let best = 0, bt = 0, bd = Infinity;
    chain.forEach((b, k) => {
      const a = (b.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
      const t = Math.max(-0.5, Math.min(1, ((x - b.x) * dx + (y - b.y) * dy) / Math.max(1, b.length)));
      const px = b.x + dx * t * b.length, py = b.y + dy * t * b.length, d = Math.hypot(x - px, y - py);
      if (d < bd) { bd = d; best = k; bt = t; }
    });
    if (best === 0 && bt < 0.15) {
      // at the root: held by the anchor (still), fading into the first bone
      const w = Math.max(0, Math.min(1, (bt + 0.25) / 0.4));
      out[chain[0].id][i] = anchor ? w : 1; if (anchor) out[anchor.id][i] = 1 - w;
      continue;
    }
    // blend with the previous / next bone near the joints
    const near0 = bt < blend && best > 0, near1 = bt > 1 - blend && best < chain.length - 1;
    if (near0) { const w = 0.5 + (bt / blend) * 0.5; out[chain[best].id][i] = w; out[chain[best - 1].id][i] = 1 - w; }
    else if (near1) { const w = 0.5 + ((1 - bt) / blend) * 0.5; out[chain[best].id][i] = w; out[chain[best + 1].id][i] = 1 - w; }
    else out[chain[best].id][i] = 1;
  }
  return out;
}

/** Paint weights: add `amount` (−1..1) for `bone` to vertices within `radius` of (x, y) (rest space), falloff smooth;
 *  the other bones on those vertices give way so weights keep summing to at most 1. */
export function paintWeights(m: EdMesh, bone: string, x: number, y: number, radius: number, amount: number) {
  const n = m.mesh.pos.length / 2;
  if (!m.skin) m.skin = {};
  if (!m.skin[bone]) m.skin[bone] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(m.mesh.pos[i * 2] - x, m.mesh.pos[i * 2 + 1] - y);
    if (d >= radius) continue;
    const f = amount * (1 - (d / radius) ** 2);
    const w = m.skin[bone];
    w[i] = Math.max(0, Math.min(1, w[i] + f));
    let others = 0;
    for (const [id, ow] of Object.entries(m.skin)) if (id !== bone) others += ow[i] ?? 0;
    if (w[i] + others > 1 && others > 0) { const k = (1 - w[i]) / others; for (const [id, ow] of Object.entries(m.skin)) if (id !== bone) ow[i] *= k; }
  }
}

/** Drop bones (and weights) that no longer exist; keep weight arrays the mesh's length. */
export function tidySkin(doc: EdDoc) {
  const ids = new Set((doc.extras?.bones ?? []).map((b) => b.id));
  for (const m of doc.meshes) {
    if (!m.skin) continue;
    const n = m.mesh.pos.length / 2;
    for (const id of Object.keys(m.skin)) {
      if (!ids.has(id)) { delete m.skin[id]; continue; }
      const w = m.skin[id];
      if (w.length !== n) m.skin[id] = Array.from({ length: n }, (_, i) => w[i] ?? 0);
    }
    if (!Object.keys(m.skin).length) delete m.skin;
  }
}

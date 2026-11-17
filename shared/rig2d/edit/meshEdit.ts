// Hand mesh editing that keeps every recorded keyform: moving a vertex slides it over the picture (its uv follows),
// adding / removing vertices re-triangulates, a new mesh (auto-mesh at another density) takes over the old keyforms by
// interpolating them at each new vertex (barycentric in the old rest mesh, nearest vertex outside it). Pure (no DOM).
import { autoMesh, delaunay, spacingFor, type Mesh } from './mesh.ts';
import type { EdDoc, EdMesh, EdTexture, EdValue } from './doc.ts';

/** Where a canvas point sits in `m` (rest): containing triangle + weights, or the nearest vertex. */
function locate(m: Mesh, x: number, y: number): { i: number[]; w: number[] } {
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = m.tri[t], b = m.tri[t + 1], c = m.tri[t + 2];
    const ax = m.pos[a * 2], ay = m.pos[a * 2 + 1], bx = m.pos[b * 2], by = m.pos[b * 2 + 1], cx = m.pos[c * 2], cy = m.pos[c * 2 + 1];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w2 = 1 - w0 - w1;
    if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) return { i: [a, b, c], w: [w0, w1, w2] };
  }
  let best = 0, bd = Infinity;
  for (let k = 0; k < m.pos.length / 2; k++) { const d = (m.pos[k * 2] - x) ** 2 + (m.pos[k * 2 + 1] - y) ** 2; if (d < bd) { bd = d; best = k; } }
  return { i: [best], w: [1] };
}

/** Barycentric weights of (x, y) in the triangle of `tri` (over points `pts`) that holds it — or, outside every
 *  triangle, in the nearest one, unclamped (an affine extension past the edge, so a point just outside still maps
 *  smoothly). null when there are no usable triangles. */
function locateAffine(pts: ArrayLike<number>, tri: ArrayLike<number>, x: number, y: number): { i: number[]; w: number[] } | null {
  let best: { i: number[]; w: number[] } | null = null, bestMin = -Infinity;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1], cx = pts[c * 2], cy = pts[c * 2 + 1];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w2 = 1 - w0 - w1;
    const mn = Math.min(w0, w1, w2);
    if (mn > bestMin) { bestMin = mn; best = { i: [a, b, c], w: [w0, w1, w2] }; if (mn >= -1e-6) break; }
  }
  return best;
}
/** Map (x, y) given in one per-vertex coordinate set (`from`: rest positions or uvs) to the other (`to`), through the mesh's triangles. */
function mapThrough(m: Mesh, from: 'pos' | 'uv', x: number, y: number): [number, number] {
  const to = from === 'pos' ? m.uv : m.pos;
  const l = locateAffine(m[from], m.tri, x, y);
  if (!l) return from === 'pos' ? [0.5, 0.5] : [x, y];
  let u = 0, v = 0;
  l.i.forEach((vi, j) => { u += to[vi * 2] * l.w[j]; v += to[vi * 2 + 1] * l.w[j]; });
  return [u, v];
}

/** Give mesh `em` a new rest mesh, carrying every form's offsets over. */
export function replaceMesh(em: EdMesh, next: Mesh) {
  const old = em.mesh;
  const loc = Array.from({ length: next.pos.length / 2 }, (_, k) => locate(old, next.pos[k * 2], next.pos[k * 2 + 1]));
  const remap = (v: EdValue | null): EdValue | null => {
    if (!v || !v.d) return v;
    const d: number[] = [];
    for (const l of loc) { let x = 0, y = 0; l.i.forEach((vi, j) => { x += (v.d![vi * 2] ?? 0) * l.w[j]; y += (v.d![vi * 2 + 1] ?? 0) * l.w[j]; }); d.push(x, y); }
    return { ...v, d };
  };
  for (const f of em.forms) f.values = f.values.map(remap);
  if (em.skin) for (const id of Object.keys(em.skin)) { const w = em.skin[id]; em.skin[id] = loc.map((l) => l.i.reduce((acc, vi, j) => acc + (w[vi] ?? 0) * l.w[j], 0)); }
  em.mesh = next;
}

/** Re-mesh a layer at a density (0..1), keeping its keyforms. A `uvFree` part (an imported model's: its picture is not
 *  laid flat on the canvas) is meshed over its picture, and each new point placed where the old mesh shows that spot. */
export function remeshAuto(doc: EdDoc, textures: EdTexture[], em: EdMesh, density: number) {
  const t = doc.textures[em.tex], tx = textures[em.tex];
  if (!em.uvFree) { replaceMesh(em, autoMesh(tx.rgba, t.w, t.h, t.x, t.y, { spacing: spacingFor(t.w, t.h, density) })); return; }
  // (spacing as if the picture were the size it is shown at, so the density slider means the same as for a drawn part)
  const am = autoMesh(tx.rgba, tx.w, tx.h, 0, 0, { spacing: spacingFor(t.w, t.h, density) });
  if (am.pos.length < 6 || !am.tri.length) return;
  const pos: number[] = [];
  for (let k = 0; k < am.uv.length / 2; k++) pos.push(...mapThrough(em.mesh, 'uv', am.uv[k * 2], am.uv[k * 2 + 1]));
  replaceMesh(em, { pos, uv: am.uv.slice(), tri: am.tri.slice() });
}

/** uv of a canvas point on this mesh's picture. */
const uvAt = (doc: EdDoc, em: EdMesh, x: number, y: number): [number, number] => {
  if (em.uvFree) return mapThrough(em.mesh, 'pos', x, y);
  const t = doc.textures[em.tex]; return [(x - t.x) / t.w, (y - t.y) / t.h];
};

/** Add a vertex at a canvas point (rest space); returns its index. */
export function addVertex(doc: EdDoc, em: EdMesh, x: number, y: number): number {
  const m = em.mesh;
  const [u, v] = uvAt(doc, em, x, y);
  const next: Mesh = { pos: [...m.pos, x, y], uv: [...m.uv, u, v], tri: [] };
  next.tri = triangulateKeep(next, m);
  replaceMesh(em, next);
  return next.pos.length / 2 - 1;
}

/** Remove a vertex (meshes keep at least 3). */
export function removeVertex(em: EdMesh, i: number) {
  const m = em.mesh, n = m.pos.length / 2;
  if (n <= 3 || i < 0 || i >= n) return;
  const pos = m.pos.filter((_, k) => (k >> 1) !== i), uv = m.uv.filter((_, k) => (k >> 1) !== i);
  const next: Mesh = { pos, uv, tri: [] };
  next.tri = triangulateKeep(next, m);
  for (const f of em.forms) f.values = f.values.map((v) => (v?.d ? { ...v, d: v.d.filter((_, k) => (k >> 1) !== i) } : v));
  if (em.skin) for (const id of Object.keys(em.skin)) em.skin[id] = em.skin[id].filter((_, k) => k !== i);
  em.mesh = next;
}

/** Move a rest vertex: it slides over the picture (uv follows), so the art stays put and only the mesh changes. */
export function moveVertex(doc: EdDoc, em: EdMesh, i: number, x: number, y: number) {
  const [u, v] = uvAt(doc, em, x, y);
  em.mesh.pos[i * 2] = x; em.mesh.pos[i * 2 + 1] = y;
  em.mesh.uv[i * 2] = Math.max(0, Math.min(1, u)); em.mesh.uv[i * 2 + 1] = Math.max(0, Math.min(1, v));
}

/** Delaunay, dropping triangles whose centre lies outside the old mesh's covered area (keeps concave outlines). */
function triangulateKeep(next: Mesh, old: Mesh): number[] {
  const tri = delaunay(next.pos);
  const out: number[] = [];
  const cov = (x: number, y: number) => {
    for (let t = 0; t < old.tri.length; t += 3) {
      const a = old.tri[t], b = old.tri[t + 1], c = old.tri[t + 2];
      const ax = old.pos[a * 2], ay = old.pos[a * 2 + 1], bx = old.pos[b * 2], by = old.pos[b * 2 + 1], cx = old.pos[c * 2], cy = old.pos[c * 2 + 1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-9) continue;
      const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      if (w0 >= -0.05 && w1 >= -0.05 && 1 - w0 - w1 >= -0.05) return true;
    }
    return false;
  };
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const x = (next.pos[a * 2] + next.pos[b * 2] + next.pos[c * 2]) / 3, y = (next.pos[a * 2 + 1] + next.pos[b * 2 + 1] + next.pos[c * 2 + 1]) / 3;
    if (!old.tri.length || cov(x, y)) out.push(a, b, c);
  }
  return out.length ? out : tri;
}

/** The nearest vertex of a placed mesh within `r` px of (x, y), or -1. */
export function pickVertex(placed: ArrayLike<number>, x: number, y: number, r: number): number {
  let best = -1, bd = r * r;
  for (let k = 0; k < placed.length / 2; k++) { const d = (placed[k * 2] - x) ** 2 + (placed[k * 2 + 1] - y) ** 2; if (d <= bd) { bd = d; best = k; } }
  return best;
}

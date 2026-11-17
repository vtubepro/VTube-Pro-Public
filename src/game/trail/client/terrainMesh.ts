// The Trail v2 — journey chunk meshes (pure: no three.js; runs in the terrain worker). One 64 m chunk → a terrain grid
// (positions relative to the chunk corner, normals, splat weights for the painted layers), the road ribbons + verges
// that start in this chunk, creek water ribbons, and the scatter list. Deterministic from the plan like everything
// else, so the host's physics terrain and every view's mesh are the same ground.
import { CHUNK, N, ROAD_HALF, genChunk, heightAt, polyDist, vnoise, type Chunk, type WorldPlan } from '../../../../shared/trail/procgen.ts';

export const ROLES = ['tree', 'tree_small', 'bush', 'rock', 'reed', 'flower', 'ruin', 'junk', 'fence', 'crystal', 'cloud'] as const;
export interface Strip { pos: Float32Array; uv: Float32Array; idx: Uint32Array }
export interface ChunkMesh {
  cx: number; cz: number; step: number; biome: number; minH: number; maxH: number;
  /** grid: (CHUNK/step + 1)² vertices, x/z relative to the chunk corner */
  pos: Float32Array; nrm: Float32Array;
  /** per vertex RGBA 0..255: grass, mud, rock, shore (ground = the rest) */
  spl: Uint8Array;
  idx: Uint32Array;
  /** road ribbon (u across 0..1, v along in metres) + the two verges (u 0 at the road edge → 1 outside) */
  road: Strip | null; verge: Strip | null;
  /** creek water (u across, v along) at the creek's level */
  water: Strip | null;
  /** scatter, 9 floats each: role index, x, y, z (world), rot, scale, variant 0..1, solid 0/1, radius */
  scatter: Float32Array;
}

const VERGE = 1.2;
export function chunkMesh(plan: WorldPlan, cx: number, cz: number, step: number, c: Chunk = genChunk(plan, cx, cz)): ChunkMesh {
  const n = CHUNK / step + 1;
  const pos = new Float32Array(n * n * 3), nrm = new Float32Array(n * n * 3), spl = new Uint8Array(n * n * 4);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const H = (ix: number, iz: number) => c.heights[Math.min(N - 1, Math.max(0, iz)) * N + Math.min(N - 1, Math.max(0, ix))];
  const creeks = plan.creeks.filter((k) => { for (let i = 0; i < k.xs.length; i += 2) if (k.xs[i] > x0 - 20 && k.xs[i] < x0 + CHUNK + 20 && k.zs[i] > z0 - 20 && k.zs[i] < z0 + CHUNK + 20) return true; return false; });
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ix = i * step, iz = j * step, v = j * n + i;
    const h = H(ix, iz);
    pos[v * 3] = ix; pos[v * 3 + 1] = h; pos[v * 3 + 2] = iz;
    // normal from central differences on the full-res grid
    const dx = H(ix + 1, iz) - H(ix - 1, iz), dz = H(ix, iz + 1) - H(ix, iz - 1);
    const l = Math.hypot(dx, 2, dz);
    nrm[v * 3] = -dx / l; nrm[v * 3 + 1] = 2 / l; nrm[v * 3 + 2] = -dz / l;
    const k = iz * N + ix;
    const wx = x0 + ix, wz = z0 + iz;
    // painted layers: grass patches (noise), mud (mask), rock (slope), shore (near creek water)
    const g = vnoise(plan.seedN + 77, wx / 9, wz / 9) * 0.6 + vnoise(plan.seedN + 78, wx / 3, wz / 3) * 0.4;
    let shore = 0;
    for (const cr of creeks) { const d = polyDist(cr.xs, cr.zs, wx, wz); if (d < cr.half + 4) shore = Math.max(shore, 1 - Math.max(0, d - cr.half) / 4); }
    const rock = c.rock[k], mud = Math.max(0, (c.mud[k] - 0.55) / 0.45);
    spl[v * 4] = Math.round(255 * Math.max(0, Math.min(1, (g - 0.35) * 2.5)) * (1 - rock));
    spl[v * 4 + 1] = Math.round(255 * Math.min(1, mud) * (1 - rock));
    spl[v * 4 + 2] = Math.round(255 * rock);
    spl[v * 4 + 3] = Math.round(255 * shore * (1 - rock));
  }
  // + skirts: every border vertex again 2.5 m lower, so LOD neighbours (step 1 vs 2) never show a crack
  const border: number[] = [];
  for (let i = 0; i < n; i++) border.push(i);                      // z = 0 edge
  for (let j = 1; j < n; j++) border.push(j * n + n - 1);          // x = max edge
  for (let i = n - 2; i >= 0; i--) border.push((n - 1) * n + i);   // z = max edge
  for (let j = n - 2; j >= 0; j--) border.push(j * n);             // x = 0 edge (back to the start)
  const nv = n * n, nb = border.length;
  const pos2 = new Float32Array((nv + nb) * 3), nrm2 = new Float32Array((nv + nb) * 3), spl2 = new Uint8Array((nv + nb) * 4);
  pos2.set(pos); nrm2.set(nrm); spl2.set(spl);
  border.forEach((v, k) => { const q = nv + k; pos2[q * 3] = pos[v * 3]; pos2[q * 3 + 1] = pos[v * 3 + 1] - 2.5; pos2[q * 3 + 2] = pos[v * 3 + 2]; nrm2.set(nrm.subarray(v * 3, v * 3 + 3), q * 3); spl2.set(spl.subarray(v * 4, v * 4 + 4), q * 4); });
  const idx = new Uint32Array((n - 1) * (n - 1) * 6 + nb * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
    // split along the shorter diagonal-ish (alternate) so ridges don't all lean the same way
    if ((i + j) & 1) { idx[o++] = a; idx[o++] = d; idx[o++] = b; idx[o++] = b; idx[o++] = d; idx[o++] = e; }
    else { idx[o++] = a; idx[o++] = d; idx[o++] = e; idx[o++] = a; idx[o++] = e; idx[o++] = b; }
  }
  for (let k = 0; k < nb; k++) { const a = border[k], b2 = border[(k + 1) % nb], a2 = nv + k, bb = nv + (k + 1) % nb; idx[o++] = a; idx[o++] = b2; idx[o++] = a2; idx[o++] = b2; idx[o++] = bb; idx[o++] = a2; }
  return { cx, cz, step, biome: c.biome, minH: c.minH, maxH: c.maxH, pos: pos2, nrm: nrm2, spl: spl2, idx, road: roads(plan, cx, cz, false), verge: roads(plan, cx, cz, true), water: water(plan, cx, cz), scatter: packScatter(c) };
}

/** A quick low-detail chunk (every `step` m, heights only: no masks, no scatter) — first coverage while the full
 *  chunk is generated, and the far ring. ~16× cheaper than chunkMesh at step 4. */
export function coarseMesh(plan: WorldPlan, cx: number, cz: number, step: number): ChunkMesh {
  const n = CHUNK / step + 1;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const hs = new Float32Array((n + 2) * (n + 2));
  let minH = Infinity, maxH = -Infinity;
  for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) { const h = heightAt(plan, x0 + i * step, z0 + j * step); hs[(j + 1) * (n + 2) + i + 1] = h; if (i >= 0 && j >= 0 && i < n && j < n) { if (h < minH) minH = h; if (h > maxH) maxH = h; } }
  const H = (i: number, j: number) => hs[(j + 1) * (n + 2) + i + 1];
  const c: Chunk = { cx, cz, heights: new Float32Array(N * N), road: new Float32Array(0), mud: new Float32Array(0), rock: new Float32Array(0), scatter: [], biome: 0, minH, maxH };
  // re-use the full builder's layout by filling a full-res grid from the coarse samples (bilinear)
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const fi = ix / step, fj = iz / step, i0 = Math.min(n - 2, Math.floor(fi)), j0 = Math.min(n - 2, Math.floor(fj)), u = fi - i0, v = fj - j0;
    c.heights[iz * N + ix] = (H(i0, j0) * (1 - u) + H(i0 + 1, j0) * u) * (1 - v) + (H(i0, j0 + 1) * (1 - u) + H(i0 + 1, j0 + 1) * u) * v;
  }
  c.rock = new Float32Array(N * N); c.mud = new Float32Array(N * N);
  const m = chunkMesh(plan, cx, cz, step, c);
  m.scatter = new Float32Array(0);
  return m;
}
/** Road ribbons (or verge strips) for every path segment that STARTS in this chunk (no double drawing at borders). */
function roads(plan: WorldPlan, cx: number, cz: number, verge: boolean): Strip | null {
  const P: number[] = [], U: number[] = [], I: number[] = [];
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  for (const p of plan.paths) {
    const m = p.xs.length;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const sides = verge ? [[-(ROAD_HALF + VERGE), -ROAD_HALF, -1], [ROAD_HALF, ROAD_HALF + VERGE, 1]] : [[-ROAD_HALF, ROAD_HALF, 0]];
        for (const [a, b, sgn] of sides) {
          const base = P.length / 3;
          for (const i of run) {
            const j0 = Math.max(0, i - 1), j1 = Math.min(m - 1, i + 1);
            let tx = p.xs[j1] - p.xs[j0], tz = p.zs[j1] - p.zs[j0]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
            const nx = -tz, nz = tx;   // left of travel
            const y = p.hs[i] + (verge ? 0.035 : 0.05);
            P.push(p.xs[i] + nx * a - x0, y, p.zs[i] + nz * a - z0, p.xs[i] + nx * b - x0, y, p.zs[i] + nz * b - z0);
            // verges: u = 0 at the road edge → 1 at the outer edge (the texture fades out)
            const ua = verge ? (sgn < 0 ? 1 : 0) : 0, ub = verge ? (sgn < 0 ? 0 : 1) : 1;
            U.push(ua, p.cum[i], ub, p.cum[i]);
          }
          for (let k = 0; k < run.length - 1; k++) { const q = base + k * 2; I.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }   // (facing up)
        }
      }
      run = [];
    };
    for (let i = 0; i < m; i++) {
      const own = Math.floor(p.xs[i] / CHUNK) === cx && Math.floor(p.zs[i] / CHUNK) === cz;
      if (own) { if (!run.length && i > 0) run.push(i - 1); run.push(i); }
      else if (run.length) { run.push(i); flush(); }
    }
    flush();
  }
  return P.length ? { pos: Float32Array.from(P), uv: Float32Array.from(U), idx: Uint32Array.from(I) } : null;
}
/** Creek water ribbons (points owned by this chunk + one past), at the creek level. */
function water(plan: WorldPlan, cx: number, cz: number): Strip | null {
  const P: number[] = [], U: number[] = [], I: number[] = [];
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  for (const c of plan.creeks) {
    const m = c.xs.length;
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const base = P.length / 3, w = c.half + 2.2;
        let along = 0;
        run.forEach((i, k) => {
          const j0 = Math.max(0, i - 1), j1 = Math.min(m - 1, i + 1);
          let tx = c.xs[j1] - c.xs[j0], tz = c.zs[j1] - c.zs[j0]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
          if (k) along += Math.hypot(c.xs[i] - c.xs[run[k - 1]], c.zs[i] - c.zs[run[k - 1]]);
          P.push(c.xs[i] - tz * w - x0, c.level, c.zs[i] + tx * w - z0, c.xs[i] + tz * w - x0, c.level, c.zs[i] - tx * w - z0);
          U.push(0, along, 1, along);
        });
        for (let k = 0; k < run.length - 1; k++) { const q = base + k * 2; I.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
      }
      run = [];
    };
    for (let i = 0; i < m; i++) {
      const own = Math.floor(c.xs[i] / CHUNK) === cx && Math.floor(c.zs[i] / CHUNK) === cz;
      if (own) { if (!run.length && i > 0) run.push(i - 1); run.push(i); }
      else if (run.length) { run.push(i); flush(); }
    }
    flush();
  }
  return P.length ? { pos: Float32Array.from(P), uv: Float32Array.from(U), idx: Uint32Array.from(I) } : null;
}
function packScatter(c: Chunk): Float32Array {
  const out = new Float32Array(c.scatter.length * 9);
  c.scatter.forEach((s, i) => { out.set([ROLES.indexOf(s.role as (typeof ROLES)[number]), s.x, s.y, s.z, s.rot, s.scale, s.v, s.solid ? 1 : 0, s.r], i * 9); });
  return out;
}
/** Buffers to transfer from the worker. */
export function transfers(m: ChunkMesh): ArrayBuffer[] {
  const out: ArrayBuffer[] = [m.pos.buffer, m.nrm.buffer, m.spl.buffer, m.idx.buffer, m.scatter.buffer] as ArrayBuffer[];
  for (const s of [m.road, m.verge, m.water]) if (s) out.push(s.pos.buffer as ArrayBuffer, s.uv.buffer as ArrayBuffer, s.idx.buffer as ArrayBuffer);
  return out;
}

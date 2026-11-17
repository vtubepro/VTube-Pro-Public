// "Place seats for me": find where performers can sit or stand in a room that has no SPOT_xx nodes, and make a talk
// camera for each place. Pure TypeScript over a triangle soup (shared/roomGlb.ts triangleSoup, or the browser's
// three.js meshes), so the browser, the server and the tests share it. Room contract: docs/ARTIST_ENVIRONMENTS.md.
//
// How it works (all glTF space: metres, +Y up, front = +Z):
//   1. Voxelise the triangles in a box around the room's "middle" (≤ 30 × 30 m, 0.1 m cells): `occ` = any surface,
//      `up` = an upward-facing surface (a floor, a seat cushion, a table top).
//   2. The FLOOR is the most common low upward surface. Every column gets its floor cell and its free height.
//   3. SEATS: upward surfaces 0.3-0.65 m above the floor, at least 0.4 × 0.4 m, free above for a seated head, with a
//      BACKREST (something 0.25-0.8 m above the cushion within 0.75 m on one side) — a backrest is what tells a sofa
//      from a coffee table. The seat faces away from its backrest. Long sofas get one seat every 0.7 m.
//   4. STANDING places: open floor (free 0.45 m around, 1.9 m up), near the middle of the room, facing the front.
//   5. CAMERAS: SPOT_xx_CAM 1.4-2.6 m in front of each place at face height, looking at the face, inside free space,
//      with a clear line of sight; CAM_WIDE (if the room has none) far enough back to see every place.
//
// Pure heuristics: they can be wrong (a bench without a back is not a seat; a bed is). The wizard shows every place in
// the 3D preview and lets the performer drag / delete them ("Let me place them"), so a bad guess is one drag away.
import type { TriangleSoup } from './roomGlb.ts';

export type V3 = [number, number, number];
export interface SeatPlace {
  position: V3;          // root on the floor (stand) or on the floor below the seat (sit), like a SPOT_xx origin
  yawDeg: number;        // 0 = faces +Z
  pose: 'sit' | 'stand';
  seatHeight?: number;   // sit: cushion height above `position`
  seatDepth?: number;
  label: string;
  score: number;         // higher = better (sort order)
  source: 'sofa' | 'chair' | 'floor' | 'manual' | 'authored';
}
export interface CamPlace { name: string; position: V3; target: V3; yfovDeg: number }

const CELL = 0.1;
const MAX_SPAN = 40;           // metres around the middle that we analyse
const MAX_H = 4.5;

export interface RoomGrid {
  ox: number; oy: number; oz: number;       // world position of cell (0,0,0)'s corner
  nx: number; ny: number; nz: number;
  occ: Uint8Array;                          // 1 = some surface in the cell
  up: Uint8Array;                           // 0 = none; 1..251 = an upward-facing surface, its height inside the cell (upY)
  floorY: number;                           // world height of the floor
  floorJ: number;                           // its cell row
}

const idx = (g: RoomGrid, i: number, j: number, k: number) => (k * g.ny + j) * g.nx + i;
/** The height of the upward surface in a cell (NaN = none). */
export const upY = (g: RoomGrid, i: number, j: number, k: number) => { const v = g.up[idx(g, i, j, k)]; return v ? g.oy + (j + (v - 1) / 250) * CELL : NaN; };
export const occAt = (g: RoomGrid, x: number, y: number, z: number) => {
  const i = Math.floor((x - g.ox) / CELL), j = Math.floor((y - g.oy) / CELL), k = Math.floor((z - g.oz) / CELL);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return 0;
  return g.occ[idx(g, i, j, k)];
};

/** The analysis box centre: the given hint, else the area-weighted median of upward surfaces (the floor's middle). */
function middle(soup: TriangleSoup, hint?: V3 | null): V3 {
  if (hint) return hint;
  const xs: number[] = [], zs: number[] = [], ys: number[] = [];
  const t = soup.tris;
  const stride = Math.max(1, Math.floor(soup.count / 40000));
  for (let n = 0; n < soup.count; n += stride) {
    const o = n * 9;
    const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
    const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const a = Math.hypot(cx, cy, cz) / 2;
    if (a < 1e-6 || cy / (2 * a) < 0.85 || a > 400) continue;       // up-facing, not a kilometre ground plane
    const w = Math.min(20, Math.ceil(a * 4));
    for (let r = 0; r < w; r++) { xs.push((t[o] + t[o + 3] + t[o + 6]) / 3); zs.push((t[o + 2] + t[o + 5] + t[o + 8]) / 3); ys.push((t[o + 1] + t[o + 4] + t[o + 7]) / 3); }
  }
  const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  return [med(xs), med(ys), med(zs)];
}

/** Voxelise the soup around the room's middle. */
export function buildGrid(soup: TriangleSoup, opts: { center?: V3 | null; span?: number } = {}): RoomGrid | null {
  if (!soup.count) return null;
  const c = middle(soup, opts.center);
  const span = Math.min(MAX_SPAN, opts.span ?? MAX_SPAN);
  // vertical range: from a bit under the lowest up-facing surface near the middle, MAX_H up
  const t = soup.tris;
  const lows: number[] = [];
  for (let n = 0; n < soup.count; n++) {
    const o = n * 9;
    const cx = (t[o] + t[o + 3] + t[o + 6]) / 3, cz = (t[o + 2] + t[o + 5] + t[o + 8]) / 3;
    if (Math.abs(cx - c[0]) > span / 2 || Math.abs(cz - c[2]) > span / 2) continue;
    const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
    const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
    const cx2 = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz2 = ux * vy - uy * vx;
    const l = Math.hypot(cx2, cy, cz2);
    if (l > 1e-9 && cy / l > 0.9) lows.push((t[o + 1] + t[o + 4] + t[o + 7]) / 3);
  }
  if (!lows.length) return null;
  lows.sort((a, b) => a - b);
  const low = lows[Math.floor(lows.length * 0.02)];
  const g: RoomGrid = {
    ox: c[0] - span / 2, oy: low - 0.35, oz: c[2] - span / 2,
    nx: Math.ceil(span / CELL), ny: Math.ceil((MAX_H + 0.35) / CELL), nz: Math.ceil(span / CELL),
    occ: new Uint8Array(0), up: new Uint8Array(0), floorY: low, floorJ: 0,
  };
  g.occ = new Uint8Array(g.nx * g.ny * g.nz); g.up = new Uint8Array(g.nx * g.ny * g.nz);
  const maxX = g.ox + g.nx * CELL, maxY = g.oy + g.ny * CELL, maxZ = g.oz + g.nz * CELL;
  for (let n = 0; n < soup.count; n++) {
    const o = n * 9;
    const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], qx = t[o + 6], qy = t[o + 7], qz = t[o + 8];
    if (Math.max(ax, bx, qx) < g.ox || Math.min(ax, bx, qx) > maxX || Math.max(ay, by, qy) < g.oy || Math.min(ay, by, qy) > maxY || Math.max(az, bz, qz) < g.oz || Math.min(az, bz, qz) > maxZ) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
    const nx_ = uy * vz - uz * vy, ny_ = uz * vx - ux * vz, nz_ = ux * vy - uy * vx;
    const l = Math.hypot(nx_, ny_, nz_);
    if (l < 1e-12) continue;
    const isUp = ny_ / l > 0.85;
    const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(bx - qx, by - qy, bz - qz));
    const steps = Math.min(600, Math.max(1, Math.ceil(e / (CELL * 0.6))));
    for (let a = 0; a <= steps; a++) for (let b = 0; a + b <= steps; b++) {
      const s = a / steps, r = b / steps;
      const x = ax + ux * s + vx * r, y = ay + uy * s + vy * r, z = az + uz * s + vz * r;
      const i = Math.floor((x - g.ox) / CELL), j = Math.floor((y - g.oy) / CELL), k = Math.floor((z - g.oz) / CELL);
      if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) continue;
      const id = idx(g, i, j, k);
      g.occ[id] = 1;
      if (isUp) { const f = 1 + Math.max(0, Math.min(250, Math.round(((y - g.oy) / CELL - j) * 250))); if (f > g.up[id]) g.up[id] = f; }
    }
  }
  // the floor: the most common lowest up-cell row
  const hist = new Map<number, number>();
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) for (let j = 0; j < g.ny; j++) if (g.up[idx(g, i, j, k)]) { hist.set(j, (hist.get(j) ?? 0) + 1); break; }
  let best = -1, bestN = 0;
  for (const [j, nn] of hist) if (nn > bestN) { best = j; bestN = nn; }
  if (best < 0) return null;
  g.floorJ = best;
  let sum = 0, n = 0;
  for (let k = 0; k < g.nz; k += 2) for (let i = 0; i < g.nx; i += 2) { const v = g.up[idx(g, i, best, k)]; if (v) { sum += g.oy + (best + (v - 1) / 250) * CELL; n++; } }
  g.floorY = n ? sum / n : g.oy + (best + 0.5) * CELL;
  return g;
}

/** A floor-plan box (x0, z0, x1, z1) + its bottom height (y0): e.g. the React screen, which places keep away from. */
export type Box2 = [number, number, number, number, number];
/** Horizontal distance from a point to a box (0 inside). */
export const boxDist = (b: Box2, p: V3) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[2], 0, p[2] - b[3]));

/** The floor under a point someone clicked: what you would put your feet on. Looks in a ring 0.2-0.4 m around the
 *  point (beside the chair, not under it) for the top walkable surface at least 0.2 m below the point with free space
 *  above it, and takes the most common one (a riser around a desk chair, a stage under a stool); else the floor. */
export function floorBelow(g: RoomGrid, x: number, y: number, z: number): number {
  const i0 = Math.floor((x - g.ox) / CELL), k0 = Math.floor((z - g.oz) / CELL);
  const jTop = Math.min(g.ny - 2, Math.floor((y - 0.2 - g.oy) / CELL));
  const count = new Map<number, number>(), height = new Map<number, number>();
  for (let di = -4; di <= 4; di++) for (let dk = -4; dk <= 4; dk++) {
    if (Math.max(Math.abs(di), Math.abs(dk)) < 2) continue;
    const i = i0 + di, k = k0 + dk;
    if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) continue;
    for (let j = jTop; j >= Math.max(0, g.floorJ - 2); j--) {
      if (!g.up[idx(g, i, j, k)]) continue;
      if (!g.occ[idx(g, i, j + 1, k)] && !g.occ[idx(g, i, j + 2, k)]) { count.set(j, (count.get(j) ?? 0) + 1); height.set(j, (height.get(j) ?? 0) + upY(g, i, j, k)); break; }
    }
  }
  let best = -1, bestN = 0;
  for (const [j, n] of count) if (n > bestN || (n === bestN && j > best)) { best = j; bestN = n; }
  return best >= 0 ? height.get(best)! / bestN : g.floorY;
}

/** Which way a seat at (x, z) with its cushion top at `seatTop` faces: away from the nearest backrest (geometry 0.25-0.8 m
 *  above the cushion, 0.15-0.75 m away). Null = no backrest found (a stool / bench: the caller picks a default). */
export function seatFacing(g: RoomGrid, x: number, z: number, seatTop: number): number | null {
  const i0 = Math.floor((x - g.ox) / CELL), k0 = Math.floor((z - g.oz) / CELL), j = Math.floor((seatTop - 0.03 - g.oy) / CELL);
  // which of 16 directions has something tall within 0.75 m (weighted closer = stronger); the backrest is the arc
  // (5 neighbouring directions) with the most of it, so one mic stand or armrest doesn't win
  const w = new Array(16).fill(0);
  for (let d = 0; d < 16; d++) {
    const a = (d * Math.PI) / 8, dx = Math.cos(a), dz = Math.sin(a);
    for (let r = 1.5; r <= 7.5; r += 1) {
      const i = Math.round(i0 + dx * r), k = Math.round(k0 + dz * r);
      if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) break;
      let col = 0;
      for (let jj = j + 3; jj <= j + 8 && jj < g.ny; jj++) if (jj >= 0 && g.occ[idx(g, i, jj, k)]) col++;
      if (col >= 3) { w[d] = 1 / r; break; }
    }
  }
  let best = -1, bestS = 0;
  for (let d = 0; d < 16; d++) {
    const sum = [-2, -1, 0, 1, 2].reduce((acc, o) => acc + w[(d + o + 16) % 16] * (o === 0 ? 1.5 : Math.abs(o) === 1 ? 1 : 0.5), 0);
    if (sum > bestS) { bestS = sum; best = d; }
  }
  if (best < 0) return null;
  const a = (best * Math.PI) / 8;
  return Math.round((Math.atan2(-Math.cos(a), -Math.sin(a)) * 180) / Math.PI);
}

/** Free cells straight above (i, j, k), in metres (stops at the first occupied cell). */
function freeAbove(g: RoomGrid, i: number, j: number, k: number, limit: number): number {
  let n = 0;
  for (let jj = j + 1; jj < g.ny && n * CELL < limit; jj++, n++) if (g.occ[idx(g, i, jj, k)]) break;
  return n * CELL;
}

/** Any occupied cell in a vertical cylinder (radius r) between heights y0..y1 (world)? Returns the occupied fraction. */
export function cylinderHits(g: RoomGrid, x: number, z: number, r: number, y0: number, y1: number): number {
  const i0 = Math.floor((x - r - g.ox) / CELL), i1 = Math.floor((x + r - g.ox) / CELL);
  const k0 = Math.floor((z - r - g.oz) / CELL), k1 = Math.floor((z + r - g.oz) / CELL);
  const j0 = Math.max(0, Math.floor((y0 - g.oy) / CELL)), j1 = Math.min(g.ny - 1, Math.floor((y1 - g.oy) / CELL));
  let hit = 0, all = 0;
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
    const cx = g.ox + (i + 0.5) * CELL - x, cz = g.oz + (k + 0.5) * CELL - z;
    if (cx * cx + cz * cz > r * r) continue;
    for (let j = j0; j <= j1; j++) {
      all++;
      if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) continue;
      if (g.occ[idx(g, i, j, k)]) hit++;
    }
  }
  return all ? hit / all : 0;
}

/** Clear line of sight between two points (skips `pad` metres at both ends)? */
export function clearLine(g: RoomGrid, a: V3, b: V3, pad = 0.3): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.ceil(d / (CELL * 0.5));
  for (let s = 0; s <= n; s++) {
    const t = s / n, along = t * d;
    if (along < pad || along > d - pad) continue;
    if (occAt(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)) return false;
  }
  return true;
}

/** Height of a performer's face above the spot root (avatarHeight 1.5 m: standing ≈ 1.38 m, seated ≈ seat + 0.75 m). */
export const faceHeight = (p: { pose: 'sit' | 'stand'; seatHeight?: number }, avatarHeight = 1.5) =>
  p.pose === 'sit' ? (p.seatHeight ?? 0.45) + avatarHeight * 0.5 : avatarHeight * 0.92;

/** Is an authored / dragged spot usable? Not inside furniture or a wall, a floor (or seat) under it, room for a head. */
export function spotProblems(g: RoomGrid, p: { position: V3; pose: 'sit' | 'stand'; seatHeight?: number; yawDeg?: number }, avatarHeight = 1.5): string[] {
  const out: string[] = [];
  const [x, y, z] = p.position;
  // outside the analysed box (a far corner of a huge place): we can't judge it, so we don't complain
  if (x < g.ox + 0.5 || z < g.oz + 0.5 || x > g.ox + g.nx * CELL - 0.5 || z > g.oz + g.nz * CELL - 0.5 || y < g.oy || y > g.oy + g.ny * CELL - 2) return out;
  const body0 = y + (p.pose === 'sit' ? (p.seatHeight ?? 0.45) + 0.45 : 0.35), body1 = y + faceHeight(p, avatarHeight) + 0.1;
  // seated people lean back into the cushions: test the chest / head a little in front of the hips, and only call it
  // "inside" when most of that space is solid (an authored booth seat may touch its backrest)
  const a = ((p.yawDeg ?? 0) * Math.PI) / 180, fwd = p.pose === 'sit' ? 0.2 : 0;
  if (cylinderHits(g, x + Math.sin(a) * fwd, z + Math.cos(a) * fwd, p.pose === 'sit' ? 0.13 : 0.16, body0, body1) > (p.pose === 'sit' ? 0.3 : 0.15)) out.push('inside');
  // something to stand / sit on: an up-surface within 0.25 m under the feet (stand) or the cushion (sit)
  const surf = y + (p.pose === 'sit' ? (p.seatHeight ?? 0.45) : 0);
  const i = Math.floor((x - g.ox) / CELL), k = Math.floor((z - g.oz) / CELL);
  let support = false;
  for (let dj = -3; dj <= 2 && !support; dj++) {
    const j = Math.floor((surf - g.oy) / CELL) + dj;
    for (let di = -2; di <= 2 && !support; di++) for (let dk = -2; dk <= 2 && !support; dk++) {
      const ii = i + di, kk = k + dk;
      if (ii >= 0 && kk >= 0 && j >= 0 && ii < g.nx && kk < g.nz && j < g.ny && g.up[idx(g, ii, j, kk)]) support = true;
    }
  }
  if (!support) out.push('floating');
  return out;
}

interface Patch { cells: [number, number][]; j: number; cx: number; cz: number; minA: number; maxA: number; ax: [number, number]; back: [number, number] | null }

/** Seats (sofas, chairs) + standing places, best first. `existing` places are kept clear of (≥ 0.75 m). */
export function findPlaces(g: RoomGrid, opts: { want?: number; existing?: V3[]; front?: [number, number] | null; frontOut?: [number, number]; region?: [number, number, number, number] | null; avatarHeight?: number; avoid?: Box2[] } = {}): SeatPlace[] {
  const reg = opts.region ?? null;
  const inReg = (x: number, z: number) => !reg || (x >= reg[0] && x <= reg[2] && z >= reg[1] && z <= reg[3]);
  const want = Math.max(1, Math.min(12, opts.want ?? 4));
  let front: [number, number] = opts.front ?? [0, 1];
  const fj = g.floorJ;
  const seatJ0 = fj + Math.round(0.28 / CELL), seatJ1 = fj + Math.round(0.68 / CELL);
  // --- seat cells: the topmost up-cell in each column within the seat band, free ≥ 0.75 m above (a seated torso)
  const seatAt = new Int16Array(g.nx * g.nz).fill(-1);
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
    for (let j = seatJ1; j >= seatJ0; j--) {
      if (!g.up[idx(g, i, j, k)]) continue;
      if (g.occ[idx(g, i, j + 1, k)] && g.up[idx(g, i, j + 1, k)]) continue;
      if (freeAbove(g, i, j, k, 0.8) >= 0.75 && inReg(g.ox + (i + 0.5) * CELL, g.oz + (k + 0.5) * CELL)) seatAt[k * g.nx + i] = j;
      break;
    }
  }
  // --- per seat cell: where is its backrest? (geometry 0.25-0.8 m above the cushion, 0.15-0.75 m away, 8 directions)
  const DIRS: [number, number][] = Array.from({ length: 8 }, (_, d) => [Math.cos((d * Math.PI) / 4), Math.sin((d * Math.PI) / 4)]);
  const backDir = new Int8Array(g.nx * g.nz).fill(-1);
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
    const s = k * g.nx + i, j = seatAt[s];
    if (j < 0) continue;
    let best = -1, bestR = 99;
    for (let d = 0; d < 8; d++) {
      for (let r = 1.5; r <= 7.5 && r < bestR; r += 1) {
        const ii = Math.round(i + DIRS[d][0] * r), kk = Math.round(k + DIRS[d][1] * r);
        if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) break;
        let col = 0;
        for (let jj = j + 3; jj <= j + 8 && jj < g.ny; jj++) if (g.occ[idx(g, ii, jj, kk)]) col++;
        if (col >= 3) { best = d; bestR = r; break; }
      }
    }
    // a backrest on the opposite side too = a narrow gap between two tall things (a shelf niche), not a seat
    if (best >= 0) {
      const o = (best + 4) % 8;
      let opp = false;
      for (let r = 1.5; r <= 3.5 && !opp; r += 1) {
        const ii = Math.round(i + DIRS[o][0] * r), kk = Math.round(k + DIRS[o][1] * r);
        if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) break;
        let col = 0;
        for (let jj = j + 3; jj <= j + 8 && jj < g.ny; jj++) if (g.occ[idx(g, ii, jj, kk)]) col++;
        if (col >= 3) opp = true;
      }
      if (!opp) backDir[s] = best;
    }
  }
  // --- connected patches of cushion cells with a backrest the same way (4-neighbour, heights within 1 cell)
  const seen = new Uint8Array(g.nx * g.nz);
  const patches: Patch[] = [];
  const near = (a: number, b: number) => { const d = Math.abs(a - b) % 8; return d <= 1 || d === 7; };
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
    const s = k * g.nx + i;
    if (backDir[s] < 0 || seen[s]) continue;
    const cells: [number, number][] = [];
    const q: number[] = [s]; seen[s] = 1;
    let sumJ = 0, bx = 0, bz = 0;
    while (q.length) {
      const c = q.pop()!; const ci = c % g.nx, ck = (c - ci) / g.nx;
      cells.push([ci, ck]); sumJ += seatAt[c]; bx += DIRS[backDir[c]][0]; bz += DIRS[backDir[c]][1];
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nk = ck + dk;
        if (ni < 0 || nk < 0 || ni >= g.nx || nk >= g.nz) continue;
        const nn = nk * g.nx + ni;
        if (!seen[nn] && backDir[nn] >= 0 && Math.abs(seatAt[nn] - seatAt[c]) <= 1 && near(backDir[nn], backDir[s])) { seen[nn] = 1; q.push(nn); }
      }
    }
    if (cells.length < 12 || cells.length > 1500) continue;          // < ~0.12 m² or a whole raised platform
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-6) continue;
    const back: [number, number] = [bx / bl, bz / bl];
    const ax: [number, number] = [-back[1], back[0]];                  // along the backrest
    const j = Math.round(sumJ / cells.length);
    const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length, cz = cells.reduce((a, c) => a + c[1], 0) / cells.length;
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const [a, b] of cells) {
      const pa = (a - cx) * ax[0] + (b - cz) * ax[1], pb = (a - cx) * back[0] + (b - cz) * back[1];
      minA = Math.min(minA, pa); maxA = Math.max(maxA, pa); minB = Math.min(minB, pb); maxB = Math.max(maxB, pb);
    }
    const lenA = (maxA - minA + 1) * CELL, depth = (maxB - minB + 1) * CELL;
    if (lenA < 0.36 || depth < 0.3) continue;                          // a rail / a ledge
    patches.push({ cells, j, cx, cz, minA, maxA, ax, back });
  }
  // --- seats from patches: one every 0.7 m along a sofa
  const out: SeatPlace[] = [];
  const cellW = (i: number, k: number): [number, number] => [g.ox + (i + 0.5) * CELL, g.oz + (k + 0.5) * CELL];
  for (const p of patches) {
    const len = (p.maxA - p.minA + 1) * CELL;
    const n = Math.max(1, Math.min(4, Math.floor((len + 0.1) / 0.7)));
    const fwd: [number, number] = [-p.back![0], -p.back![1]];
    // the cushion's front half: shift the root a little towards the front so the hips sit on the cushion
    for (let s = 0; s < n; s++) {
      const a = p.minA + ((s + 0.5) / n) * (p.maxA - p.minA);
      const ci = p.cx + p.ax[0] * a, ck = p.cz + p.ax[1] * a;
      const [wx, wz] = cellW(ci, ck);
      const st = upY(g, Math.round(ci), p.j, Math.round(ck)), st2 = upY(g, Math.round(ci), p.j + 1, Math.round(ck));
      const seatTop = Number.isFinite(st2) ? st2 : Number.isFinite(st) ? st : g.oy + (p.j + 1) * CELL;
      // the floor under the feet (a riser / stage step), 0.35 m in front of the cushion
      let footY = g.floorY;
      {
        const fi = Math.round(ci + fwd[0] * 3.5), fk = Math.round(ck + fwd[1] * 3.5);
        if (fi >= 0 && fk >= 0 && fi < g.nx && fk < g.nz) for (let jj = p.j - 2; jj >= Math.max(0, g.floorJ - 2); jj--) if (g.up[idx(g, fi, jj, fk)]) { footY = upY(g, fi, jj, fk); break; }
      }
      const yaw = (Math.atan2(fwd[0], fwd[1]) * 180) / Math.PI;
      out.push({
        position: [wx + fwd[0] * 0.05, Math.round(footY * 100) / 100, wz + fwd[1] * 0.05], yawDeg: Math.round(yaw), pose: 'sit',
        seatHeight: Math.round((seatTop - footY) * 100) / 100, seatDepth: 0.5,
        label: len >= 1.2 ? `Sofa seat ${s + 1}` : 'Seat', score: 2, source: len >= 1.2 ? 'sofa' : 'chair',
      });
    }
  }
  // --- standing places on open floor
  const mid: [number, number] = [g.ox + g.nx * CELL / 2, g.oz + g.nz * CELL / 2];
  const floorCells: [number, number][] = [];
  for (let k = 3; k < g.nz - 3; k += 2) for (let i = 3; i < g.nx - 3; i += 2) {
    let floorHere = false;
    for (let j = fj - 1; j <= fj + 1; j++) if (j >= 0 && g.up[idx(g, i, j, k)]) floorHere = true;
    if (!floorHere) continue;
    const [wx, wz] = cellW(i, k);
    if (!inReg(wx, wz)) continue;
    if (cylinderHits(g, wx, wz, 0.45, g.floorY + 0.12, g.floorY + 1.9) > 0) continue;
    if (freeAbove(g, i, fj + 1, k, 2.0) < 1.8) continue;
    floorCells.push([wx, wz]);
  }
  // middle of the walkable floor (rooms are rarely centred on the analysis box)
  const fm: [number, number] = reg ? [(reg[0] + reg[2]) / 2, (reg[1] + reg[3]) / 2] : floorCells.length
    ? [floorCells.reduce((a, c) => a + c[0], 0) / floorCells.length, floorCells.reduce((a, c) => a + c[1], 0) / floorCells.length]
    : mid;
  // --- the room front: where the seats face (TV-set rooms face the audience), else the open side of the room
  if (!opts.front) {
    let fx = 0, fz = 0;
    for (const p of out) { const a = (p.yawDeg * Math.PI) / 180; fx += Math.sin(a); fz += Math.cos(a); }
    const l = Math.hypot(fx, fz);
    front = out.length >= 2 && l > out.length * 0.35 ? [fx / l, fz / l] : guessFront(g);
  }
  if (opts.frontOut) { opts.frontOut[0] = front[0]; opts.frontOut[1] = front[1]; }
  // seat score: facing the front + sitting with others (a conversation group beats a lone armchair in a corner)
  for (const p of out) {
    const a = (p.yawDeg * Math.PI) / 180;
    const mates = out.filter((q) => q !== p && Math.hypot(q.position[0] - p.position[0], q.position[2] - p.position[2]) < 3).length;
    // ... near the middle of the room, facing into it (a sofa against the far wall facing the room, not one in a corner)
    const dx = fm[0] - p.position[0], dz = fm[1] - p.position[2], dl = Math.hypot(dx, dz) || 1;
    const half = reg ? Math.max(2, Math.hypot(reg[2] - reg[0], reg[3] - reg[1]) / 2) : 8;
    p.score = 2 + 0.6 * (Math.sin(a) * front[0] + Math.cos(a) * front[1]) + 0.25 * Math.min(4, mates)
      + 0.9 * (1 - Math.min(1, dl / half)) + 0.3 * ((Math.sin(a) * dx + Math.cos(a) * dz) / dl);
  }
  // --- standing places on open floor
  for (const [wx, wz] of floorCells) {
    const dist = Math.hypot(wx - fm[0], wz - fm[1]);
    // a performer standing needs open space in FRONT (for the camera): 1.4 m clear towards the front
    let open = true;
    for (let d = 0.6; d <= 1.6 && open; d += 0.2) if (cylinderHits(g, wx + front[0] * d, wz + front[1] * d, 0.2, g.floorY + 0.9, g.floorY + 1.6) > 0) open = false;
    if (!open) continue;
    out.push({ position: [wx, g.floorY, wz], yawDeg: Math.round((Math.atan2(front[0], front[1]) * 180) / Math.PI), pose: 'stand', label: 'Standing spot', score: 1 - Math.min(0.9, dist / 12), source: 'floor' });
  }
  // never in front of the React screen (a performer there blocks it: docs/ARTIST_ENVIRONMENTS.md §0 rule 9)
  // Right under the screen (< 0.8 m) blocks its lower edge from the cameras; a bit further out only a head reaching up
  // into it does (a screen hung above seated heads, as in the shipped Hangout Lounge, is fine).
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i], face = p.position[1] + faceHeight(p, opts.avatarHeight);
    if ((opts.avoid ?? []).some((bx) => { const d = boxDist(bx, p.position); return d < 0.8 || (d < 1.4 && face > bx[4] + 0.1); })) out.splice(i, 1);
  }
  // never suggest a place our own check would complain about
  for (let i = out.length - 1; i >= 0; i--) if (spotProblems(g, out[i], opts.avatarHeight).length) out.splice(i, 1);
  // --- pick: best first, ≥ 0.75 m apart (seats) / 0.9 m (standing), clear of existing spots
  out.sort((a, b) => b.score - a.score);
  const picked: SeatPlace[] = [];
  const taken: V3[] = [...(opts.existing ?? [])];
  let standing = 0;
  for (const p of out) {
    if (picked.length >= want) break;
    const gap = p.pose === 'sit' ? 0.62 : 0.9;
    if (taken.some((t) => Math.hypot(t[0] - p.position[0], t[2] - p.position[2]) < gap)) continue;
    if (p.pose === 'stand' && picked.length >= 2 && standing >= Math.max(1, want - picked.filter((x) => x.pose === 'sit').length)) continue;
    if (p.pose === 'stand') standing++;
    picked.push(p); taken.push(p.position);
  }
  let n = 1;
  for (const p of picked) if (p.pose === 'stand') p.label = `Standing spot ${n++}`;
  return picked;
}

/** A talk camera for a place: in front of the face, inside free space, clear line of sight. Null when none fits. */
export function talkCamera(g: RoomGrid, p: Pick<SeatPlace, 'position' | 'yawDeg' | 'pose' | 'seatHeight'>, name: string, avatarHeight = 1.5): CamPlace | null {
  const face: V3 = [p.position[0], p.position[1] + faceHeight(p, avatarHeight), p.position[2]];
  const yaw = (p.yawDeg * Math.PI) / 180;
  for (const d of [1.7, 1.45, 2.0, 2.4, 1.25, 2.8]) for (const off of [0, 12, -12, 25, -25, 40, -40]) {
    const a = yaw + (off * Math.PI) / 180;
    const pos: V3 = [face[0] + Math.sin(a) * d, face[1] + 0.06, face[2] + Math.cos(a) * d];
    if (occAt(g, pos[0], pos[1], pos[2]) || cylinderHits(g, pos[0], pos[2], 0.22, pos[1] - 0.2, pos[1] + 0.2) > 0) continue;
    if (!clearLine(g, pos, face, 0.25)) continue;
    // and the shoulders (±0.22 m sideways) are visible too
    const sx = Math.cos(yaw) * 0.22, sz = -Math.sin(yaw) * 0.22;
    if (!clearLine(g, pos, [face[0] + sx, face[1] - 0.2, face[2] + sz], 0.25) || !clearLine(g, pos, [face[0] - sx, face[1] - 0.2, face[2] - sz], 0.25)) continue;
    // aim a little below the face: the face sits ~1/3 from the top of the frame (camera QA rule: 20-45 %)
    return { name, position: pos, target: [face[0], face[1] - 0.22, face[2]], yfovDeg: 35 };
  }
  return null;
}

/** CAM_WIDE: from the front side of the places, far enough back to fit them all (38° vertical FOV, 16:9). */
export function wideCamera(g: RoomGrid, places: Pick<SeatPlace, 'position' | 'pose' | 'seatHeight'>[], front: [number, number] = [0, 1], avatarHeight = 1.5): CamPlace | null {
  if (!places.length) return null;
  const cx = places.reduce((a, p) => a + p.position[0], 0) / places.length, cz = places.reduce((a, p) => a + p.position[2], 0) / places.length;
  const faceY = places.reduce((a, p) => a + p.position[1] + faceHeight(p as SeatPlace, avatarHeight), 0) / places.length;
  const spread = Math.max(1.2, ...places.map((p) => Math.hypot(p.position[0] - cx, p.position[2] - cz) * 2 + 0.8));
  const need = spread / 2 / Math.tan(((38 * 16) / 9 / 2) * (Math.PI / 180)) + 0.8;
  const base = Math.atan2(front[0], front[1]);
  // From the ideal distance inwards (a room is often too small to fit a 13 m wide line-up at 38°): the spot that sees
  // the most faces wins (ties: further back); the field of view opens up to 55° to fit them at that distance.
  let best: { pos: V3; seen: number; d: number } | null = null;
  const dists: number[] = [];
  for (let d = Math.max(2.4, need); d >= 2.4; d -= 0.6) dists.push(d);
  if (!dists.length) dists.push(2.4);
  for (const d of dists) for (const off of [0, 15, -15, 30, -30]) {
    const a = base + (off * Math.PI) / 180;
    const pos: V3 = [cx + Math.sin(a) * d, faceY + 0.45, cz + Math.cos(a) * d];
    if (occAt(g, pos[0], pos[1], pos[2]) || cylinderHits(g, pos[0], pos[2], 0.25, pos[1] - 0.25, pos[1] + 0.25) > 0) continue;
    const seen = places.filter((p) => clearLine(g, pos, [p.position[0], p.position[1] + faceHeight(p as SeatPlace, avatarHeight), p.position[2]], 0.3)).length;
    if (!best || seen > best.seen || (seen === best.seen && d > best.d)) best = { pos, seen, d };
    if (seen === places.length) break;
  }
  if (!best || best.seen < Math.max(1, Math.ceil(places.length * 0.6))) return null;
  const hfov = 2 * Math.atan(spread / 2 / Math.max(0.5, best.d - 0.8));
  const vfov = Math.min(55, Math.max(38, ((hfov * 180) / Math.PI) * (9 / 16)));
  return { name: 'CAM_WIDE', position: best.pos, target: [cx, faceY - 0.15, cz], yfovDeg: Math.round(vfov) };
}

/** Which way is the room's open front? The side (±X / ±Z) with the least wall near its edge (TV-set rooms are open at
 *  the front). Returns a unit XZ direction. `hint` (e.g. an authored camera's position) wins. */
export function guessFront(g: RoomGrid, hint?: V3 | null): [number, number] {
  const cx = g.ox + g.nx * CELL / 2, cz = g.oz + g.nz * CELL / 2;
  if (hint) { const dx = hint[0] - cx, dz = hint[2] - cz, l = Math.hypot(dx, dz); if (l > 0.5) return Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]; }
  // extent of the floor
  let i0 = g.nx, i1 = -1, k0 = g.nz, k1 = -1;
  for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) for (let j = g.floorJ - 1; j <= g.floorJ + 1; j++) if (j >= 0 && g.up[idx(g, i, j, k)]) { i0 = Math.min(i0, i); i1 = Math.max(i1, i); k0 = Math.min(k0, k); k1 = Math.max(k1, k); }
  if (i1 < 0) return [0, 1];
  const wall = (fixed: 'i' | 'k', at: number, from: number, to: number) => {
    let n = 0, all = 0;
    for (let s = from; s <= to; s += 2) for (let d = -3; d <= 3; d++) {
      const i = fixed === 'i' ? at + d : s, k = fixed === 'k' ? at + d : s;
      if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) continue;
      all++;
      for (let j = g.floorJ + 8; j <= g.floorJ + 18 && j < g.ny; j++) if (g.occ[idx(g, i, j, k)]) { n++; break; }
    }
    return all ? n / all : 0;
  };
  const sides: [[number, number], number][] = [
    [[0, 1], wall('k', k1, i0, i1)], [[0, -1], wall('k', k0, i0, i1)], [[1, 0], wall('i', i1, k0, k1)], [[-1, 0], wall('i', i0, k0, k1)],
  ];
  sides.sort((a, b) => a[1] - b[1] || (a[0][1] === 1 ? -1 : b[0][1] === 1 ? 1 : 0));   // ties: +Z (the contract's front)
  return sides[0][0];
}

/** Units / up-axis guess from the raw (un-fixed) soup: what the wizard says under "Size" and "Which way is up". */
export function guessScaleAndUp(soup: TriangleSoup): { size: V3; core: V3; scale: number; up: 'y' | 'z' | '-z' | 'x' | '-x' | '-y'; why: string } {
  const t = soup.tris;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < soup.count; n++) {
    const o = n * 9;
    for (let v = 0; v < 9; v += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], t[o + v + a]); hi[a] = Math.max(hi[a], t[o + v + a]); }
  }
  const size: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  // Up: gravity. The floor is a big surface facing UP that lies at the BOTTOM of the room. For each of the 6 directions,
  // add up the area facing that way within the lowest 20 % of the room along it (2nd-98th percentile extent, so a far
  // skyline doesn't stretch it). A Z-up export has its floor at the bottom along Z, facing +Z, and almost nothing facing
  // +Y at the bottom along Y. Flip only when another direction clearly wins (1.5×), so a tall back wall never does.
  const core2 = percentileBox(soup, 0.02);
  const dirs: ['y' | 'z' | '-z' | 'x' | '-x' | '-y', number, number][] = [['y', 1, 1], ['-y', 1, -1], ['z', 2, 1], ['-z', 2, -1], ['x', 0, 1], ['-x', 0, -1]];
  const score: Record<string, number> = {};
  for (const [name, ax, sg] of dirs) {
    const lo0 = sg > 0 ? core2[0][ax] : -core2[1][ax], ext = core2[1][ax] - core2[0][ax] || 1;
    let sum = 0;
    for (let n = 0; n < soup.count; n++) {
      const o = n * 9;
      const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2], vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
      const c = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(c[0], c[1], c[2]);
      if (l < 1e-12 || (c[ax] * sg) / l < 0.9) continue;
      const along = sg * (t[o + ax] + t[o + 3 + ax] + t[o + 6 + ax]) / 3;
      if ((along - lo0) / ext <= 0.2) sum += l / 2;
    }
    score[name] = sum;
  }
  let up = 'y' as 'y' | 'z' | '-z' | 'x' | '-x' | '-y';
  let why = 'floor faces up';
  const best = dirs.map((d) => d[0]).sort((p, q) => score[q] - score[p])[0];
  if (best !== 'y' && score[best] > 1.5 * score.y && score[best] > 0.5) { up = best; why = `the floor faces ${best.replace('-', 'minus ').toUpperCase()} (exported with the wrong up axis)`; }
  // Scale: a room is 3-60 m across. Centimetres look 100× too big, a model built in "units" may be 100× too small.
  // Measured on the 5th-95th percentile of triangle centres, so a far skyline (a few big triangles) doesn't count.
  const core = coreSize(soup);
  const horiz = up === 'y' || up === '-y' ? Math.max(core[0], core[2]) : up === 'z' || up === '-z' ? Math.max(core[0], core[1]) : Math.max(core[1], core[2]);
  // ... and confirmed by the median edge length (furniture detail is centimetres-to-decimetres in a metre room), so a
  // genuinely huge outdoor place (a far city around a lounge) is not mistaken for a centimetre export
  const edge = medianEdge(soup);
  let scale = 1;
  if (horiz > 250 && edge > 2) scale = 0.01;
  else if (horiz > 0 && horiz < 0.6 && edge < 0.006) scale = 100;
  else if (horiz >= 0.6 && horiz < 1.5 && edge < 0.03) scale = 10;
  return { size, core, scale, up, why };
}

/** Median triangle edge length (sampled). */
export function medianEdge(soup: TriangleSoup): number {
  const t = soup.tris, e: number[] = [];
  const step = Math.max(1, Math.floor(soup.count / 20000));
  for (let n = 0; n < soup.count; n += step) { const o = n * 9; e.push(Math.hypot(t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2])); }
  if (!e.length) return 0;
  e.sort((a, b) => a - b);
  return e[Math.floor(e.length / 2)];
}

/** The [p, 1-p] percentile box of triangle centres. */
export function percentileBox(soup: TriangleSoup, p: number): [V3, V3] {
  const t = soup.tris, step = Math.max(1, Math.floor(soup.count / 60000));
  const c: number[][] = [[], [], []];
  for (let n = 0; n < soup.count; n += step) { const o = n * 9; for (let a = 0; a < 3; a++) c[a].push((t[o + a] + t[o + 3 + a] + t[o + 6 + a]) / 3); }
  const lo: number[] = [], hi: number[] = [];
  for (const v of c) { v.sort((x, y) => x - y); lo.push(v.length ? v[Math.floor(v.length * p)] : 0); hi.push(v.length ? v[Math.min(v.length - 1, Math.floor(v.length * (1 - p)))] : 0); }
  return [lo as V3, hi as V3];
}

/** Size of the room's "core": the 5th-95th percentile box of triangle centres (each triangle counts once). */
export function coreSize(soup: TriangleSoup): V3 {
  const t = soup.tris;
  const step = Math.max(1, Math.floor(soup.count / 60000));
  const c: number[][] = [[], [], []];
  for (let n = 0; n < soup.count; n += step) { const o = n * 9; for (let a = 0; a < 3; a++) c[a].push((t[o + a] + t[o + 3 + a] + t[o + 6 + a]) / 3); }
  return c.map((v) => { if (!v.length) return 0; v.sort((p, q) => p - q); return v[Math.floor(v.length * 0.95)] - v[Math.floor(v.length * 0.05)]; }) as V3;
}

export interface AutoPlan { places: SeatPlace[]; cams: CamPlace[]; wide: CamPlace | null; front: [number, number] }
/** "Place seats for me": places (best first) + a talk camera per place (+ CAM_WIDE when `needWide`). Places whose
 *  camera can't be placed are dropped unless nothing else is left. */
export function autoPlace(g: RoomGrid, opts: { want?: number; existing?: V3[]; front?: [number, number] | null; firstIndex?: number; needWide?: boolean; avatarHeight?: number; region?: [number, number, number, number] | null; avoid?: Box2[] } = {}): AutoPlan {
  const frontOut: [number, number] = [0, 1];
  const raw = findPlaces(g, { want: Math.min(12, (opts.want ?? 4) + 4), existing: opts.existing, front: opts.front, frontOut, region: opts.region, avatarHeight: opts.avatarHeight, avoid: opts.avoid });
  const places: SeatPlace[] = [], cams: CamPlace[] = [];
  let n = opts.firstIndex ?? 1;
  const want = opts.want ?? 4;
  for (const p of raw) {
    if (places.length >= want || n > 12) break;
    const cam = talkCamera(g, p, `SPOT_${String(n).padStart(2, '0')}_CAM`, opts.avatarHeight);
    if (!cam) continue;
    places.push(p); cams.push(cam); n++;
  }
  if (!places.length && raw.length) places.push(raw[0]);
  const wide = opts.needWide ? wideCamera(g, places, frontOut, opts.avatarHeight) : null;
  return { places, cams, wide, front: frontOut };
}

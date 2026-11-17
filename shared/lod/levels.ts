// Avatar detail: index-only level ladders for one geometry (pure; meshoptimizer is passed in). Runs in the page's
// lod worker (src/avatar/lod/lodWorker.ts) and in Node (tools/lod_unit.ts). Keep this file ASCII-only.
//
// - Only the H / R / B triangle lists (shared/lod/classify.ts) go through the simplifier; F (the face) is copied as is,
//   first, in its original order, at every level.
// - Each class is simplified on its own with ErrorAbsolute + LockBorder: the error bound is in mesh-local units, the
//   class borders (face / head / hair / body seams) never move, so nothing cracks. Target count 0: only the error
//   bound limits it. Normals ride along as attributes (weight 0.5) so shading edges stay.
// - Levels are NESTED: L(k+1) is simplified from L(k). Each step gets the error still left under the level's absolute
//   bound (mm_k minus what the earlier steps already used), so a level's achieved error against the ORIGINAL surface
//   is at most mm_k (triangle inequality) and its vertices are a subset of the previous level's.
// - Never used: Permissive, Prune, sloppy simplification, simplifyWithUpdate.
// - Deterministic: the same input gives the same bytes.

import { DETAIL_HEAD_HAIR_K, DETAIL_MIN_FREE_TRIS, DETAIL_MM } from '../avatarDetail.ts';
import { classify, freeTris, type ClassLists, type NameFlags } from './classify.ts';

type Flag = 'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive';
/** The part of meshoptimizer's MeshoptSimplifier this needs. */
export interface Simplifier {
  simplify(indices: Uint32Array, pos: Float32Array, posStride: number, targetIndexCount: number, targetError: number, flags?: Flag[]): [Uint32Array, number];
  simplifyWithAttributes(indices: Uint32Array, pos: Float32Array, posStride: number, attrs: Float32Array, attrStride: number, weights: number[],
    lock: Uint8Array | null, targetIndexCount: number, targetError: number, flags?: Flag[]): [Uint32Array, number];
}

export interface LevelJob {
  vcount: number;
  /** vcount x 3 (mesh-local). */
  pos: Float32Array;
  /** vcount x 3, or null. */
  nrm: Float32Array | null;
  F: Uint32Array; H: Uint32Array; R: Uint32Array; B: Uint32Array;
  /** Mesh-local units per millimetre of a 1.7 m-normalised avatar: the error bound of level k (body) = mm_k x unit. */
  unit: number;
  /** Level errors in mm (default DETAIL_MM = 0.5 / 1.5 / 4). */
  mm?: readonly number[];
  /** 'absolute' (default): each nested step gets what is left under mm_k against the original surface.
   *  'step': each step gets mm_k against the previous level (experiments only: the error can add up). */
  budget?: 'absolute' | 'step';
}

export interface LevelResult {
  /** F first (original order), then H, R, B. */
  index: Uint32Array;
  tris: number;
  /** Vertices the level references. */
  verts: number;
  /** Achieved error against the original surface (upper bound, mm at 1.7 m; body-equivalent: H / R errors are scaled
   *  back by 1 / DETAIL_HEAD_HAIR_K so the number compares with the level's mm). */
  mm: number;
}

export interface LevelsOut { levels: LevelResult[]; faceTris: number; l0Tris: number; l0Verts: number; ms: number }

const FLAGS: Flag[] = ['ErrorAbsolute', 'LockBorder'];
const NW = [0.5, 0.5, 0.5];

/** Number of distinct vertices an index list references. */
export function referencedVerts(index: ArrayLike<number>, vcount: number, seen = new Uint8Array(vcount)): number {
  seen.fill(0);
  let n = 0;
  for (let i = 0; i < index.length; i++) { const v = index[i]; if (!seen[v]) { seen[v] = 1; n++; } }
  return n;
}

export function buildLevels(S: Simplifier, job: LevelJob, now: () => number = () => Date.now()): LevelsOut {
  const t0 = now();
  const mm = job.mm ?? DETAIL_MM;
  const classes: { cur: Uint32Array; k: number; used: number }[] = [
    { cur: job.H, k: DETAIL_HEAD_HAIR_K, used: 0 },
    { cur: job.R, k: DETAIL_HEAD_HAIR_K, used: 0 },
    { cur: job.B, k: 1, used: 0 },
  ];
  const seen = new Uint8Array(job.vcount);
  const l0 = new Uint32Array(job.F.length + job.H.length + job.R.length + job.B.length);
  { let o = 0; for (const a of [job.F, job.H, job.R, job.B]) { l0.set(a, o); o += a.length; } }
  const levels: LevelResult[] = [];
  for (let L = 0; L < mm.length; L++) {
    let worst = 0;
    for (const c of classes) {
      if (c.cur.length < 3) continue;
      // absolute bound for this class at this level, minus what the earlier (nested) steps already used
      const bound = mm[L] * c.k * job.unit;
      const left = job.budget === 'step' ? bound : bound - c.used;
      if (left > 0) {
        const [out, err] = job.nrm
          ? S.simplifyWithAttributes(c.cur, job.pos, 3, job.nrm, 3, NW, null, 0, left, FLAGS)
          : S.simplify(c.cur, job.pos, 3, 0, left, FLAGS);
        if (out.length < c.cur.length) { c.cur = out; c.used = job.budget === 'step' ? c.used + Math.max(0, err) : c.used + Math.max(0, err); }
      }
      worst = Math.max(worst, c.used / (c.k * job.unit));
    }
    const index = new Uint32Array(job.F.length + classes.reduce((a, c) => a + c.cur.length, 0));
    index.set(job.F, 0);
    let o = job.F.length;
    for (const c of classes) { index.set(c.cur, o); o += c.cur.length; }
    levels.push({ index, tris: index.length / 3, verts: referencedVerts(index, job.vcount, seen), mm: +worst.toFixed(4) });
  }
  return { levels, faceTris: job.F.length / 3, l0Tris: l0.length / 3, l0Verts: referencedVerts(l0, job.vcount, seen), ms: now() - t0 };
}

/** The whole-avatar keep rule: level k is kept only if its total triangles are at most DETAIL_KEEP x the previous
 *  (effective) level's; otherwise it aliases the previous level. `totals[0]` = L0. Returns the effective level per k. */
export function keepLevels(totals: readonly number[], keep: number): number[] {
  const eff = [0];
  let prev = totals[0];
  for (let k = 1; k < totals.length; k++) {
    if (totals[k] <= prev * keep) { eff.push(k); prev = totals[k]; }
    else eff.push(eff[k - 1]);
  }
  return eff;
}

/** One geometry as the page gathers it (src/avatar/lod/extract.ts RawJob): masks instead of class lists. */
export interface RawLevelJob {
  vcount: number;
  pos: Float32Array;
  nrm: Float32Array | null;
  index: Uint32Array;
  moved: Uint8Array | null;
  sphere: Uint8Array | null;
  region: Uint8Array | null;
  flags: NameFlags;
  unit: number;
  mm?: readonly number[];
  budget?: 'absolute' | 'step';
}

export type RawLevelsOut = { skip: string; classes: ClassLists } | (LevelsOut & { skip: null; classes: ClassLists });

/** Classes (shared/lod/classify.ts) + ladders for one geometry; skipped when fewer than DETAIL_MIN_FREE_TRIS triangles
 *  are left outside the face class. The same path in the worker and in tools/lod_unit.ts. */
export function levelsFromRaw(S: Simplifier, raw: RawLevelJob, now?: () => number): RawLevelsOut {
  const classes = classify({ index: raw.index, vcount: raw.vcount, moved: raw.moved, sphere: raw.sphere, region: raw.region, flags: raw.flags });
  const free = freeTris(classes);
  if (free < DETAIL_MIN_FREE_TRIS) return { skip: free ? 'few non-face triangles' : 'all face', classes };
  const out = buildLevels(S, { vcount: raw.vcount, pos: raw.pos, nrm: raw.nrm, ...classes, unit: raw.unit, mm: raw.mm, budget: raw.budget }, now);
  return { ...out, skip: null, classes };
}

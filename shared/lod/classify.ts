// Avatar detail: which triangles of a geometry may be simplified (pure; plain arrays in, plain arrays out). Used by
// src/avatar/lod/extract.ts in the page and by tools/lod_unit.ts in Node. Keep this file ASCII-only.
//
// Classes per triangle:
//   F  face: NEVER given to the simplifier, identical ids and order at every level. The union of
//        1. every triangle with a corner any morph target moves (ARKit, visemes, VRM expressions, the runtime vtp_ mouth),
//        2. whole primitives whose mesh / material name matches FACE_RE and not HAIR_RE (any size),
//        3. primitives under DETAIL_TINY_TRIS triangles (eyes, lids, teeth),
//        4. every triangle with a corner inside a protection sphere (face sphere, procedural mouth / eye spheres);
//   H  head: the corners' dominant bone is the head or a non-hair bone under it (half the error);
//   R  hair: hair-named primitives or hair bones (half the error);
//   B  everything else (body, clothes, props: full error).
// TODO(dedupe): FACE_RE / HAIR_RE / TINY are copied from server/partyLod.ts; move partyLod onto shared/lod (v2).

import { DETAIL_TINY_TRIS } from '../avatarDetail.ts';

export const FACE_RE = /face|head|eye|iris|pupil|lash|brow|mouth|teeth|tooth|tongue|cheek|blush|lip|nose|ear(?!th)/i;
export const HAIR_RE = /hair|bang|fringe|ahoge|pony|braid|twintail|pigtail|lock_|kami/i;
export const TINY = DETAIL_TINY_TRIS;

/** Per-vertex dominant-bone region. */
export const REGION_BODY = 0, REGION_HEAD = 1, REGION_HAIR = 2;
export const CLASS_F = 0, CLASS_H = 1, CLASS_R = 2, CLASS_B = 3;

export interface NameFlags { face: boolean; hair: boolean }

/** Name rules for a primitive: mesh name + material name(s). */
export function nameFlags(names: string): NameFlags {
  const hair = HAIR_RE.test(names);
  return { hair, face: !hair && FACE_RE.test(names) };
}

/** Morph deltas -> moved mask (|dx|+|dy|+|dz| > eps on any target). `base` = the positions when the targets are
 *  absolute (morphTargetsRelative false), else null. Accumulates into `moved`. Returns true if any vertex moved. */
export function markMoved(moved: Uint8Array, target: ArrayLike<number>, itemSize: number, base: ArrayLike<number> | null, from = 0, to = moved.length, eps = 1e-6): boolean {
  let any = false;
  for (let i = from; i < to; i++) {
    const o = i * itemSize;
    let d = 0;
    for (let c = 0; c < 3 && c < itemSize; c++) d += Math.abs(target[o + c] - (base ? base[i * 3 + c] : 0));
    if (d > eps) { moved[i] = 1; any = true; }
  }
  return any;
}

export interface ClassifyInput {
  /** Triangle list (length % 3 == 0). */
  index: ArrayLike<number>;
  vcount: number;
  /** Vertex moved by any morph target. */
  moved: Uint8Array | null;
  /** Vertex inside a protection sphere. */
  sphere: Uint8Array | null;
  /** Dominant-bone region per vertex (REGION_*); null = all body. */
  region: Uint8Array | null;
  flags: NameFlags;
}

export interface ClassLists { F: Uint32Array; H: Uint32Array; R: Uint32Array; B: Uint32Array }

/** Split a triangle list into the four classes (each list keeps the original triangle order). */
export function classify(inp: ClassifyInput): ClassLists {
  const idx = inp.index, nt = Math.floor(idx.length / 3);
  const cls = new Uint8Array(nt);
  const counts = [0, 0, 0, 0];
  const wholeFace = inp.flags.face || nt < TINY;
  const mv = inp.moved, sp = inp.sphere, rg = inp.region;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    let k: number;
    if (wholeFace || (mv && (mv[a] || mv[b] || mv[c])) || (sp && (sp[a] || sp[b] || sp[c]))) k = CLASS_F;
    else if (inp.flags.hair) k = CLASS_R;
    else if (rg) {
      const ra = rg[a], rb = rg[b], rc = rg[c];
      const r = ra === rb || ra === rc ? ra : rb === rc ? rb : REGION_BODY;
      k = r === REGION_HEAD ? CLASS_H : r === REGION_HAIR ? CLASS_R : CLASS_B;
    } else k = CLASS_B;
    cls[t] = k; counts[k]++;
  }
  const out = [new Uint32Array(counts[0] * 3), new Uint32Array(counts[1] * 3), new Uint32Array(counts[2] * 3), new Uint32Array(counts[3] * 3)];
  const o = [0, 0, 0, 0];
  for (let t = 0; t < nt; t++) {
    const k = cls[t], arr = out[k];
    arr[o[k]++] = idx[t * 3]; arr[o[k]++] = idx[t * 3 + 1]; arr[o[k]++] = idx[t * 3 + 2];
  }
  return { F: out[0], H: out[1], R: out[2], B: out[3] };
}

/** Triangles that may be simplified (H + R + B). */
export const freeTris = (c: ClassLists) => (c.H.length + c.R.length + c.B.length) / 3;

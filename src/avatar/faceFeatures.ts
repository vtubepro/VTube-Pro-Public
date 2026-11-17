// Does this model already have eyes / a mouth? Asked before the import adds a drawn face, so a model with modelled
// eye spheres or a painted-on face never gets a second pair of eyes or a second mouth on top.
// The head region (above the humanoid head bone, else the top 28 % — the same region guessFaceMarkers uses) is sampled
// with a grid of rays from the front. Each hit reads the surface's own colour (the material colour × its texture at the
// hit's UV: lighting, outlines and shading don't count). The skin colour is the face's typical colour; patches of a
// clearly different colour that sit inside the face (not touching hair at the edges) are features: a pair (or a wide
// one) in the eye band = eyes, one near the middle low down = a mouth. A feature mostly on its own material (not the
// skin's) is modelled geometry (its material can be made to blink); on the skin's material it is painted.
import * as THREE from 'three';
import type { SurfaceMarker } from '../../shared/types.ts';

export type FeatureKind = 'geometry' | 'painted' | 'none';
export interface FaceFeatures {
  eyes: FeatureKind;
  mouth: FeatureKind;
  /** Names of the materials the modelled eyes are made of (for the blink bake). */
  eyeMaterials: string[];
  /** Where the existing mouth is (model space) and how big, to animate it in place. */
  mouthAt: { center: SurfaceMarker; width: number; height: number } | null;
  /** No mouth but eyes found: where a drawn mouth belongs (under the eyes, halfway to the chin: clear of a nose). */
  mouthSpot: { center: SurfaceMarker; width: number } | null;
  /** Debug picture: the sampled albedo grid with the features outlined (data: URL). */
  picture?: string;
}

const N = 72;
const imageCache = new WeakMap<object, { data: Uint8ClampedArray; w: number; h: number } | null>();
function pixels(tex: THREE.Texture): { data: Uint8ClampedArray; w: number; h: number } | null {
  const img = tex.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!img) return null;
  if (imageCache.has(img as object)) return imageCache.get(img as object)!;
  let out: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  try {
    const w = Math.min(1024, Number(img.width) || 0), hgt = Math.min(1024, Number(img.height) || 0);
    if (w && hgt) {
      const c = document.createElement('canvas'); c.width = w; c.height = hgt;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, w, hgt);
      out = { data: g.getImageData(0, 0, w, hgt).data, w, h: hgt };
    }
  } catch { out = null; }
  imageCache.set(img as object, out);
  return out;
}
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** The surface colour (sRGB 0..1) at a ray hit, or null when the texel is see-through. */
function albedo(hit: THREE.Intersection): [number, number, number] | null {
  const mesh = hit.object as THREE.Mesh;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const mat = (mats[hit.face?.materialIndex ?? 0] ?? mats[0]) as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; alphaTest?: number };
  let r = 1, g = 1, b = 1, a = 1;
  if (mat?.color) { r = toSrgb(mat.color.r); g = toSrgb(mat.color.g); b = toSrgb(mat.color.b); }
  const map = mat?.map;
  if (map && hit.uv) {
    const px = pixels(map);
    if (px) {
      const uv = hit.uv.clone();
      map.transformUv?.(uv);
      const x = Math.min(px.w - 1, Math.max(0, Math.floor(uv.x * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor((map.flipY ? 1 - uv.y : uv.y) * px.h)));
      const o = (y * px.w + x) * 4;
      r *= px.data[o] / 255; g *= px.data[o + 1] / 255; b *= px.data[o + 2] / 255; a = px.data[o + 3] / 255;
    }
  }
  if (a < Math.max(0.3, mat?.alphaTest ?? 0)) return null;
  return [r, g, b];
}
const matKey = (hit: THREE.Intersection) => {
  const mesh = hit.object as THREE.Mesh;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const m = mats[hit.face?.materialIndex ?? 0] ?? mats[0];
  return m?.name || m?.uuid || '';
};

export function findFaceFeatures(model: THREE.Object3D, meshes: THREE.Mesh[], headBone: THREE.Object3D | null, yawDeg = 0, opts: { picture?: boolean } = {}): FaceFeatures {
  const none: FaceFeatures = { eyes: 'none', mouth: 'none', eyeMaterials: [], mouthAt: null, mouthSpot: null };
  model.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const stride = Math.max(1, Math.floor(pos.count / 30000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i);
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) (m as THREE.SkinnedMesh).applyBoneTransform(i, v);
      pts.push(v.clone().applyMatrix4(m.matrixWorld).applyMatrix4(inv));
    }
  }
  if (pts.length < 50) return none;
  const all = new THREE.Box3().setFromPoints(pts);
  const H = all.max.y - all.min.y;
  const headY = headBone ? headBone.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y : all.max.y - 0.28 * H;
  const head = pts.filter((p) => p.y >= headY);
  if (head.length < 20) return none;
  const hb = new THREE.Box3().setFromPoints(head);
  const hw = hb.max.x - hb.min.x, hh = hb.max.y - hb.min.y, cx = (hb.max.x + hb.min.x) / 2;
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const fwd = new THREE.Vector3(Math.sin(-yaw), 0, Math.cos(-yaw));
  const side = new THREE.Vector3(fwd.z, 0, -fwd.x); // model-space +x when facing +z
  const ray = new THREE.Raycaster();
  // ---- the grid: colour, material, hit point per cell (x across the head, y bottom → top)
  type Cell = { rgb: [number, number, number]; mat: string; p: THREE.Vector3; n: THREE.Vector3 } | null;
  const grid: Cell[] = new Array(N * N).fill(null);
  const nm = new THREE.Matrix3();
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    // i = 0 is the viewer's left (the model's right side)
    const off = ((i + 0.5) / N - 0.5) * hw * 1.1, y = hb.min.y + ((j + 0.5) / N) * hh;
    const from = new THREE.Vector3(cx, y, (hb.min.z + hb.max.z) / 2).addScaledVector(side, off).addScaledVector(fwd, 10 + (hb.max.z - hb.min.z)).applyMatrix4(model.matrixWorld);
    ray.set(from, fwd.clone().negate().transformDirection(model.matrixWorld));
    for (const h of ray.intersectObjects(meshes, false)) {
      const rgb = albedo(h);
      if (!rgb) continue; // see-through texel: look behind it
      nm.getNormalMatrix(h.object.matrixWorld);
      const n = h.face ? h.face.normal.clone().applyMatrix3(nm).normalize().transformDirection(inv) : fwd.clone();
      grid[j * N + i] = { rgb, mat: matKey(h), p: h.point.clone().applyMatrix4(inv), n };
      break;
    }
  }
  // ---- the skin: the typical colour in the middle of the face
  const mid: Cell[] = [];
  for (let j = Math.floor(N * 0.15); j < N * 0.75; j++) for (let i = Math.floor(N * 0.25); i < N * 0.75; i++) if (grid[j * N + i]) mid.push(grid[j * N + i]);
  if (mid.length < N) return none;
  const med = (k: 0 | 1 | 2) => mid.map((c) => c!.rgb[k]).sort((a, b) => a - b)[mid.length >> 1];
  const skin: [number, number, number] = [med(0), med(1), med(2)];
  const skinMats = new Map<string, number>();
  for (const c of mid) { const d = Math.hypot(c!.rgb[0] - skin[0], c!.rgb[1] - skin[1], c!.rgb[2] - skin[2]); if (d < 0.12) skinMats.set(c!.mat, (skinMats.get(c!.mat) ?? 0) + 1); }
  const skinMat = [...skinMats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const isFeature = (c: Cell) => !!c && Math.hypot(c.rgb[0] - skin[0], c.rgb[1] - skin[1], c.rgb[2] - skin[2]) > 0.26;
  // ---- connected feature patches that sit inside the face (touching an empty cell or the grid edge = hair / outline)
  const seen = new Uint8Array(N * N);
  const blobs: { cells: number[]; edge: boolean }[] = [];
  for (let s = 0; s < N * N; s++) {
    if (seen[s] || !isFeature(grid[s])) continue;
    const cells: number[] = []; let edge = false;
    const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!; cells.push(c);
      const i = c % N, j = (c / N) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) { edge = true; continue; }
        const k = b * N + a;
        if (!grid[k]) { edge = true; continue; }
        if (!seen[k] && isFeature(grid[k])) { seen[k] = 1; stack.push(k); }
      }
    }
    blobs.push({ cells, edge });
  }
  const faceCells = grid.filter(Boolean).length;
  const inner = blobs.filter((b) => !b.edge && b.cells.length >= 3 && b.cells.length < faceCells * 0.2);
  const info = (b: { cells: number[] }) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const mats = new Map<string, number>();
    for (const c of b.cells) { const i = c % N, j = (c / N) | 0; x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); const m = grid[c]!.mat; mats.set(m, (mats.get(m) ?? 0) + 1); }
    const mat = [...mats.entries()].sort((a, b2) => b2[1] - a[1])[0][0];
    return { u: (x0 + x1 + 1) / 2 / N, v: (y0 + y1 + 1) / 2 / N, w: (x1 - x0 + 1) / N, h: (y1 - y0 + 1) / N, mat, own: mat !== skinMat, cells: b.cells };
  };
  const feats = inner.map(info);
  // eyes: in the eye band, left + right of the middle (or one wide patch across it: glasses, a visor, a painted band)
  const eyeBand = feats.filter((f) => f.v > 0.3 && f.v < 0.85);
  const leftE = eyeBand.filter((f) => f.u > 0.55), rightE = eyeBand.filter((f) => f.u < 0.45), wide = eyeBand.filter((f) => f.w > 0.35 && Math.abs(f.u - 0.5) < 0.1);
  const eyeFeats = leftE.length && rightE.length ? [...leftE, ...rightE] : wide;
  // a mouth: low in the face, in the middle, wider than tall-ish
  const mouthF = feats.filter((f) => f.v > 0.05 && f.v < 0.45 && Math.abs(f.u - 0.5) < 0.12 && f.w < 0.6 && !eyeFeats.includes(f)).sort((a, b) => b.cells.length - a.cells.length)[0] ?? null;
  const eyes: FeatureKind = eyeFeats.length ? (eyeFeats.filter((f) => f.own).length * 2 >= eyeFeats.length ? 'geometry' : 'painted') : 'none';
  let mouthAt: FaceFeatures['mouthAt'] = null;
  if (mouthF) {
    const c = mouthF.cells.map((k) => grid[k]!).reduce((a, cell) => a.add(cell.p), new THREE.Vector3()).multiplyScalar(1 / mouthF.cells.length);
    const ci = Math.round(mouthF.u * N - 0.5), cj = Math.round(mouthF.v * N - 0.5);
    const nCell = grid[cj * N + ci] ?? grid[mouthF.cells[0]]!;
    const r = (a: THREE.Vector3) => [+a.x.toFixed(4), +a.y.toFixed(4), +a.z.toFixed(4)] as [number, number, number];
    const n = nCell.n.clone(); if (n.dot(fwd) < 0.2) n.lerp(fwd, 0.6).normalize();
    mouthAt = { center: { position: r(c), normal: r(n) }, width: +(mouthF.w * hw * 1.1).toFixed(4), height: +(mouthF.h * hh).toFixed(4) };
  }
  const r4 = (a: THREE.Vector3) => [+a.x.toFixed(4), +a.y.toFixed(4), +a.z.toFixed(4)] as [number, number, number];
  let mouthSpot: FaceFeatures['mouthSpot'] = null;
  if (!mouthF && eyeFeats.length) {
    // the chin: the lowest face cell straight down from between the eyes; the mouth halfway between the eyes and it
    const eyeBottom = Math.min(...eyeFeats.map((f) => f.v - f.h / 2));
    const i0 = Math.round(eyeFeats.reduce((a, f) => a + f.u, 0) / eyeFeats.length * N - 0.5);
    let j = Math.floor(eyeBottom * N) - 1, chin = j;
    while (j >= 0 && grid[j * N + i0]) { chin = j; j--; }
    const jm = Math.round(eyeBottom * N - 0.45 * (eyeBottom * N - chin));
    const cell = grid[jm * N + i0];
    if (cell && jm < eyeBottom * N - 1) {
      const us = eyeFeats.map((f) => f.u), du = (Math.max(...us) - Math.min(...us)) * hw * 1.1;
      const n = cell.n.clone(); if (n.dot(fwd) < 0.2) n.lerp(fwd, 0.6).normalize();
      mouthSpot = { center: { position: r4(cell.p), normal: r4(n) }, width: +Math.min(0.18 * hw, du > 0 ? 0.6 * du : 0.18 * hw).toFixed(4) };
    }
  }
  const out: FaceFeatures = {
    mouthSpot,
    eyes, mouth: mouthF ? (mouthF.own ? 'geometry' : 'painted') : 'none',
    eyeMaterials: eyes === 'geometry' ? [...new Set(eyeFeats.filter((f) => f.own).map((f) => f.mat))].filter((m) => m && !/^[0-9a-f-]{36}$/i.test(m)) : [],
    mouthAt,
  };
  if (opts.picture) {
    const c = document.createElement('canvas'); c.width = c.height = N * 4;
    const g = c.getContext('2d')!;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const cell = grid[j * N + i];
      g.fillStyle = cell ? `rgb(${cell.rgb.map((x) => Math.round(x * 255)).join(',')})` : '#202430';
      g.fillRect(i * 4, (N - 1 - j) * 4, 4, 4);
    }
    g.lineWidth = 2;
    for (const f of feats) {
      g.strokeStyle = eyeFeats.includes(f) ? '#18e08a' : f === mouthF ? '#ff3d7f' : '#ffd23d';
      g.strokeRect((f.u - f.w / 2) * N * 4, (1 - f.v - f.h / 2) * N * 4, f.w * N * 4, f.h * N * 4);
    }
    out.picture = c.toDataURL('image/png');
  }
  return out;
}

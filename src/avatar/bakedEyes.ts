// Replace the model's painted eyes (profile.eyes.replaceBaked, shared/bakedEyes.ts).
//
// For each generated eye:
//   1. the model's own eye parts near it are hidden: separate eye meshes (Eye_L, iris / sclera / highlight / eyeline
//      / eyelash parts, blink-lid meshes like EyeLidLeft) and the humanoid eye bones (collapsed, like
//      src/avatar/eyePatch.ts does for a hidden eye) — except eyeballs set into a HOLE in the face (one model): they
//      stay, as plain skin, and the generated eye is drawn on them. The runtime holds the model's eye shapes still
//   2. the painted eye is erased from a COPY of every texture it is painted into (albedo map, emissive map, MToon shade
//      texture): the face triangles around the eye are rasterised in UV space with their position in the eye frame,
//      texels inside the erase ellipse are filled from the skin just around it (src/avatar/inpaint.ts), with a short
//      feather; texels no face triangle near the eye maps to are never touched (atlases stay intact). The copies are
//      new textures in memory only — nothing is written anywhere (model custody, AGENTS rule 7)
//   3. the skin colour of a ring just outside the erased area is measured per eye: the eyelid's auto colour
//
// The texture bytes are read back exactly through a throw-away WebGL2 context (a 2D canvas would premultiply alpha
// and blacken transparent texels — hair cards in the same atlas would grow dark fringes). The fill result is cached
// per model + eye setup (RAM only), so the rebuilds while editing the Face tab only redo the readback + upload.

import * as THREE from 'three';
import { readTextureExactAsync } from './glReadback.ts';
import { eraseEllipse, type BakedEyesConfig } from '../../shared/bakedEyes.ts';
import type { SurfaceMarker } from '../../shared/types.ts';
import type { FaceFrame } from './surfacePatch.ts';
import { excludedFromPatch } from './surfacePatch.ts';
import { dilateMask, ellipseDist, fillHoleRegions, fitPaintedEye, flatRepaint, linearToHex, rasterizeCoords, ringSkinStats, type Crop, type EyeFit, type MaskTri, type SkinStats } from './inpaint.ts';

export interface BakedEyeSpot {
  frame: FaceFrame;
  /** eye size (world units) */
  size: number;
  /** +1: the outer corner is toward +T (character's left eye), −1: right eye, 0: centre eye */
  outward: number;
}

export interface BakedEyesContext {
  meshes: THREE.Mesh[];
  model: THREE.Object3D;
  spots: BakedEyeSpot[];
  cfg: BakedEyesConfig;
  /** cache key prefix: avatar id + model file */
  cacheKey: string;
  /** the eye parts already dealt with (prepareBakedEyeParts) */
  parts: BakedEyeParts;
  /** VRM exposure factor already multiplied into MToon colours (the auto lid colour divides it out) */
  exposure?: number;
}

export interface BakedEyesResult {
  /** Per spot: the skin colour around that eye (linear, albedo × material colour), or null (no texture found). */
  skin: (THREE.Color | null)[];
  /** Per spot: where the painted eye was found (world centre on the eye frame's plane, half-size of the drawn eye
   *  that would match it, world units), or null. The Face tab moves the markers there ("Fit to the painted eyes"). */
  fits: ({ center: THREE.Vector3; size: number; confidence: number; iris: string | null } | null)[];
  info: { textures: number; texels: number; hiddenMeshes: number; skinnedMeshes: number; hiddenBones: number; ms: number; cached: boolean; fitted: number; warnings: string[]; phases?: Record<string, number>; sizes?: string[] };
  dispose(): void;
}

/** Tuning (ellipse distances: 1 = the erase ellipse edge; eye-frame lengths in eye sizes). */
const FEATHER = 0.12;          // soft edge outside the ellipse
const SOURCE_OUT = 1.6;        // skin used to fill the hole: 1 + FEATHER … SOURCE_OUT
const RING: [number, number] = [1 + FEATHER + 0.04, 1.65];   // auto lid colour ring
const SEARCH = 3.2;            // painted-eye search radius around the marker
const GRAIN = 0.85;
/** Fitted erase area = the found eye's half extents + this (eye sizes: anti-aliased lash edges, faint shading). */
const FIT_MARGIN: [number, number] = [0.25, 0.14];
const FIT_MAX: [number, number] = [3.0, 2.2];

const HAIR_RE = /hair|bang|fringe|ponytail|twintail|ahoge|brow|beard|mustache|moustache/i;
/** Eye parts (mesh or material names). VRoid: EyeIris / EyeWhite / EyeHighlight / FaceEyeline / FaceEyelash. */
const EYE_PART_RE = /eye|iris|pupil|sclera|cornea|lash|(^|[^a-z])lid/i;
const NOT_PART_RE = /brow|glass|goggle|mask|patch|shadow|socket|wear|hair|visor/i;

function mats(m: THREE.Mesh): THREE.Material[] { return ([] as THREE.Material[]).concat(m.material).filter(Boolean); }

interface Ellipse { cx: number; cy: number; rx: number; ry: number; p?: number }
/** RAM-only cache of filled crops: key → per texture the crop rect + its bytes (+ the per-eye results). */
const cache = new Map<string, { crops: { key: string; crop: Crop; bytes: Uint8Array }[]; skin: ([number, number, number] | null)[]; fits: (EyeFit | null)[] }>();
const CACHE_MAX = 6;

export interface BakedEyeParts {
  /** hidden eye parts (iris / sclera / highlight / lash / lid meshes near the eyes) */
  hidden: THREE.Mesh[];
  /** eye meshes that fill a hole in the face (one model: eyeballs set into sockets): kept, turned into skin, and the
   *  generated eye is drawn on them. `near` = the spot index. */
  skinned: { mesh: THREE.Mesh; near: number }[];
  /** per spot: the eye-frame box (world units, relative to the spot centre) of an eyeball kept as skin, or null */
  sockets: ({ u0: number; u1: number; v0: number; v1: number } | null)[];
  hiddenBones: number;
  restore(): void;
}

/**
 * Step 1 (before the eye frames are snapped to the surface): the model's own eye parts near each marker. Eye meshes
 * (by mesh / material name, small, near a marker) are hidden — unless the face has a HOLE where they sit (rays
 * through the eye hit the eye part but no face surface right behind it): then they stay and become skin. Eye bones
 * are collapsed like src/avatar/eyePatch.ts does for a hidden eye.
 */
export function prepareBakedEyeParts(model: THREE.Object3D, meshes: THREE.Mesh[], spots: { frame: FaceFrame; size: number }[], eyeBones: THREE.Object3D[]): BakedEyeParts {
  const hidden: THREE.Mesh[] = [], skinned: { mesh: THREE.Mesh; near: number }[] = [];
  const sockets: BakedEyeParts['sockets'] = spots.map(() => null);
  const undo: (() => void)[] = [];
  model.updateWorldMatrix(true, true);
  const cands: { m: THREE.Mesh; near: number }[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || m.userData.vtpGenerated || m.userData.vtpCostume || m.userData.vtpOutline) return;
    const names = [m.name, ...mats(m).map((x) => x.name ?? '')];
    if (!names.some((n) => EYE_PART_RE.test(n) && !NOT_PART_RE.test(n))) return;
    const pos = m.geometry?.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos?.count) return;
    // parts around the eyes only: most of its vertices close to an eye (a whole-head mesh named "Head_eyes" stays)
    const step = Math.max(1, Math.floor(pos.count / 2000)), v = new THREE.Vector3(), hits = spots.map(() => 0);
    let n = 0;
    for (let i = 0; i < pos.count; i += step) {
      n++;
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      spots.forEach((s, k) => { if (v.distanceTo(s.frame.c) < s.size * 4) hits[k]++; });
    }
    const total = hits.reduce((a, b) => a + b, 0);
    if (total < n * 0.6) return;
    cands.push({ m, near: hits.indexOf(Math.max(...hits)) });
  });
  const partSet = new Set(cands.map((c) => c.m));
  const face = meshes.filter((m) => !partSet.has(m) && m.visible);
  const ray = new THREE.Raycaster();
  for (const { m, near } of cands) {
    // a hole? rays through the eye: the part is hit, and no face surface lies right behind it
    let holes = 0, hits = 0;
    for (const s of spots) {
      const f = s.frame;
      for (const [du, dv] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.25], [0, -0.25]]) {
        const from = f.c.clone().addScaledVector(f.T, du * s.size).addScaledVector(f.B, dv * s.size).addScaledVector(f.N, s.size * 4);
        ray.set(from, f.N.clone().negate());
        ray.far = s.size * 10;
        const hp = ray.intersectObject(m, false)[0];
        if (!hp) continue;
        hits++;
        const hf = ray.intersectObjects(face, false)[0];
        if (!hf || hf.distance > hp.distance + s.size * 0.35) holes++;
      }
    }
    if (hits >= 3 && holes >= hits * 0.6) {
      m.userData.vtpBakedSkinned = true;
      skinned.push({ mesh: m, near });
      // the socket each eye sits in = the HOLE in the face (the eye part itself may be much bigger, tucked under the
      // skin): in each eye's frame, where the part covers and no face surface does
      spots.forEach((sp, k) => { const bx = holeBox(face, m, sp); if (bx) sockets[k] = bx; });
    } else {
      m.visible = false;
      m.userData.vtpBakedHidden = true;
      hidden.push(m);
      undo.push(() => { m.visible = true; delete m.userData.vtpBakedHidden; });
    }
  }
  let bones = 0;
  for (const b of eyeBones) {
    // (an eyeball kept as skin must not be collapsed with its bone)
    if (skinned.some(({ mesh }) => (mesh as THREE.SkinnedMesh).isSkinnedMesh && (mesh as THREE.SkinnedMesh).skeleton.bones.includes(b as THREE.Bone))) continue;
    bones++;
    const s0 = b.scale.clone();
    b.scale.setScalar(1e-4);
    undo.push(() => b.scale.copy(s0));
  }
  return { hidden, skinned, sockets, hiddenBones: bones, restore: () => { for (const u of undo.reverse()) u(); } };
}

/** The box (eye frame, world units) of the hole in the face around an eye: 0.1-eye-size bins over ±3.5 sizes that
 *  the eye part covers but no face triangle does (front-facing surfaces in a depth band only). null = no hole. */
function holeBox(face: THREE.Mesh[], part: THREE.Mesh, sp: { frame: FaceFrame; size: number }): { u0: number; u1: number; v0: number; v1: number } | null {
  const R = 3.5, B = 0.1, N = Math.round((2 * R) / B), f = sp.frame;
  const cover = (meshes: THREE.Mesh[]) => {
    const g = new Uint8Array(N * N), v = new THREE.Vector3(), d = new THREE.Vector3();
    for (const m of meshes) {
      const pos = m.geometry.attributes.position as THREE.BufferAttribute, idx = m.geometry.index;
      if (!pos) continue;
      m.updateWorldMatrix(true, false);
      const n = pos.count, UV = new Float32Array(n * 2).fill(NaN);
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        d.subVectors(v, f.c);
        const u = d.dot(f.T) / sp.size, w = d.dot(f.B) / sp.size, z = d.dot(f.N) / sp.size, pl = Math.hypot(u, w);
        if (pl > R + 1 || z > 0.5 + 0.25 * pl || z < -(0.5 + 0.5 * pl)) continue;
        UV[i * 2] = u; UV[i * 2 + 1] = w;
      }
      const tc = idx ? idx.count : n;
      for (let t = 0; t < tc; t += 3) {
        const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
        const x0 = UV[a * 2], y0 = UV[a * 2 + 1], x1 = UV[b * 2], y1 = UV[b * 2 + 1], x2 = UV[c * 2], y2 = UV[c * 2 + 1];
        if (Number.isNaN(x0) || Number.isNaN(x1) || Number.isNaN(x2)) continue;
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (Math.abs(area) < 1e-9) continue;
        const bx0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) + R) / B)), bx1 = Math.min(N - 1, Math.floor((Math.max(x0, x1, x2) + R) / B));
        const by0 = Math.max(0, Math.floor((Math.min(y0, y1, y2) + R) / B)), by1 = Math.min(N - 1, Math.floor((Math.max(y0, y1, y2) + R) / B));
        for (let by = by0; by <= by1; by++) for (let bxx = bx0; bxx <= bx1; bxx++) {
          const px = (bxx + 0.5) * B - R, py = (by + 0.5) * B - R;
          const b0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area, b1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
          if (b0 >= -0.02 && b1 >= -0.02 && 1 - b0 - b1 >= -0.02) g[by * N + bxx] = 1;
        }
      }
    }
    return g;
  };
  const gf = cover(face), gp = cover([part]);
  const hole = (b: number) => gp[b] === 1 && gf[b] === 0;
  // this eye's hole only: the one connected to the hole bin nearest the marker (the other eye's is another island)
  let start = -1, bd = Infinity;
  for (let b = 0; b < N * N; b++) if (hole(b)) { const d = Math.hypot((b % N + 0.5) * B - R, (Math.floor(b / N) + 0.5) * B - R); if (d < bd) { bd = d; start = b; } }
  if (start < 0 || bd > 1.5) return null;
  const us: number[] = [], vs: number[] = [], seen = new Uint8Array(N * N), todo = [start];
  seen[start] = 1;
  while (todo.length) {
    const b = todo.pop()!, bx = b % N, by = Math.floor(b / N);
    us.push((bx + 0.5) * B - R); vs.push((by + 0.5) * B - R);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = bx + dx, ny = by + dy, nb = ny * N + nx;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && !seen[nb] && hole(nb)) { seen[nb] = 1; todo.push(nb); }
    }
  }
  if (us.length < 6) return null;
  us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
  const q = (a: number[], t: number) => a[Math.min(a.length - 1, Math.floor(a.length * t))];
  return { u0: q(us, 0.02) * sp.size, u1: q(us, 0.98) * sp.size, v0: q(vs, 0.02) * sp.size, v1: q(vs, 0.98) * sp.size };
}

/** Turn a mesh into plain skin of colour `c` (linear albedo): material copies without their textures. */
function skinMesh(m: THREE.Mesh, c: THREE.Color, exposure: number): () => void {
  const old = m.material;
  const conv = (x: THREE.Material) => {
    const n = x.clone() as THREE.Material & { map?: THREE.Texture | null; emissiveMap?: THREE.Texture | null; emissive?: THREE.Color; color?: THREE.Color; shadeMultiplyTexture?: THREE.Texture | null; shadeColorFactor?: THREE.Color; isMToonMaterial?: boolean };
    if ('map' in n) n.map = null;
    if ('emissiveMap' in n) n.emissiveMap = null;
    n.emissive?.setRGB(0, 0, 0);
    if (n.isMToonMaterial) { n.color?.copy(c).multiplyScalar(exposure); n.shadeMultiplyTexture = null; n.shadeColorFactor?.copy(c).multiplyScalar(exposure * 0.8); }
    else n.color?.copy(c);
    n.name = `${x.name} (skin)`;
    n.needsUpdate = true;
    return n;
  };
  m.material = Array.isArray(old) ? old.map(conv) : conv(old);
  return () => { const cur = m.material; m.material = old; ([] as THREE.Material[]).concat(cur).forEach((x) => x.dispose()); };
}

/** Run `fn` with `obj` hidden while `hide` is true, and put `visible` back to exactly what it was (also when `fn` throws).
 *  replaceBakedEyes waits on the GPU in timer slices, so a load WITHOUT a slicer (every page that is not a live studio / OBS
 *  slot load) would otherwise draw the half-built avatar (eye parts hidden, painted eyes not yet erased) for a few frames. */
export async function whileHidden<T>(obj: { visible: boolean }, hide: boolean, fn: () => Promise<T>): Promise<T> {
  const was = obj.visible;
  if (hide) obj.visible = false;
  try { return await fn(); }
  finally { if (hide) obj.visible = was; }
}

// (async: the texture readbacks wait on the GPU in timer slices instead of blocking the page, src/avatar/glReadback.ts)
export async function replaceBakedEyes(ctx: BakedEyesContext): Promise<BakedEyesResult> {
  const t0 = performance.now();
  const restore: (() => void)[] = [];
  const disposeTex: THREE.Texture[] = [];
  const info: BakedEyesResult['info'] = { textures: 0, texels: 0, hiddenMeshes: 0, skinnedMeshes: 0, hiddenBones: 0, ms: 0, cached: false, fitted: 0, warnings: [], phases: {}, sizes: [] };
  let tp = t0;
  const phase = (k: string) => { const t = performance.now(); info.phases![k] = Math.round((info.phases![k] ?? 0) + t - tp); tp = t; };
  const cover = ctx.cfg.cover;
  const base = ctx.spots.map((s) => eraseEllipse(1, ctx.cfg, s.outward || 1));   // (eye-size units)
  // how far around each marker the face is read: the search disc, or the manual ellipse if it is bigger
  const reach = ctx.spots.map((s, k) => Math.max(SEARCH, (Math.max(base[k].rx, base[k].ry) + Math.hypot(base[k].cx, base[k].cy)) * SOURCE_OUT, Math.min(5, FIT_MAX[0] * cover * 1.3)) + 0.2);

  ctx.model.updateWorldMatrix(true, true);
  const parts = ctx.parts;
  info.hiddenMeshes = parts.hidden.length; info.hiddenBones = parts.hiddenBones; info.skinnedMeshes = parts.skinned.length;

  // ---- 2. the face triangles around each eye (eye-frame coordinates in eye sizes), per texture
  interface Job { tex: THREE.Texture; uses: { mat: THREE.Material; prop: string }[]; tris: MaskTri[][]; albedo: boolean; color: THREE.Color; key: string; front: number[]; frontN: number[]; near: number[]; nearN: number[] }
  const jobs = new Map<object, Job>();
  const rasterised = new Set<string>();
  const pw = new THREE.Vector3(), nw = new THREE.Vector3(), d = new THREE.Vector3();
  for (const m of ctx.meshes) {
    if (m.userData.vtpBakedHidden || m.userData.vtpBakedSkinned || excludedFromPatch(m)) continue;
    const ms = mats(m);
    if ([m.name, ...ms.map((x) => x.name ?? '')].some((n) => HAIR_RE.test(n))) continue;
    const g = m.geometry, pos = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    m.updateWorldMatrix(true, false);
    const M = m.matrixWorld, NM = new THREE.Matrix3().getNormalMatrix(M);
    const n = pos.count;
    const E = ctx.spots.map(() => new Float32Array(n * 3).fill(NaN));
    let any = false;
    for (let i = 0; i < n; i++) {
      pw.fromBufferAttribute(pos, i).applyMatrix4(M);
      for (let k = 0; k < ctx.spots.length; k++) {
        const s = ctx.spots[k], f = s.frame;
        d.subVectors(pw, f.c);
        const u = d.dot(f.T) / s.size, v = d.dot(f.B) / s.size, w = d.dot(f.N) / s.size;
        const planar = Math.hypot(u, v);
        if (planar > reach[k]) continue;
        // depth band: the face curves back toward the corners; hair / accessories hover in front
        if (w > 0.5 + 0.25 * planar || w < -(0.5 + 0.5 * planar)) continue;
        if (nrm) { nw.fromBufferAttribute(nrm, i).applyMatrix3(NM).normalize(); if (nw.dot(f.N) < 0.05) continue; }
        E[k][i * 3] = u; E[k][i * 3 + 1] = v; E[k][i * 3 + 2] = w;
        any = true;
      }
    }
    if (!any) continue;
    const groups = Array.isArray(m.material) && g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : n, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = (Array.isArray(m.material) ? m.material[grp.materialIndex ?? 0] : m.material) as THREE.Material & Record<string, unknown>;
      if (!mat) continue;
      for (const prop of ['map', 'emissiveMap', 'shadeMultiplyTexture']) {
        const tex = mat[prop] as THREE.Texture | null | undefined;
        if (!tex?.isTexture) continue;
        const img = tex.image as { width?: number; height?: number } | undefined;
        if (!img?.width || !img?.height) continue;
        const uvAttr = g.attributes[tex.channel ? `uv${tex.channel}` : 'uv'] as THREE.BufferAttribute | undefined;
        if (!uvAttr) continue;
        const src = tex.source ?? tex;
        let job = jobs.get(src);
        if (!job) {
          job = { tex, uses: [], tris: ctx.spots.map(() => []), albedo: false, color: new THREE.Color(1, 1, 1), key: `${mat.name}|${prop}|${img.width}x${img.height}`, front: ctx.spots.map(() => 0), frontN: ctx.spots.map(() => 0), near: ctx.spots.map(() => 0), nearN: ctx.spots.map(() => 0) };
          jobs.set(src, job);
        }
        if (!job.uses.some((x) => x.mat === mat && x.prop === prop)) job.uses.push({ mat, prop });
        if (prop === 'map' && !job.albedo) { job.albedo = true; const c = (mat as unknown as { color?: THREE.Color }).color; if (c?.isColor) job.color.copy(c); }
        const rk = `${m.uuid}|${grp.start}|${uvAttr.name}|${src.uuid}`;
        if (rasterised.has(rk)) continue; // (map + emissive map sharing one image: rasterise once)
        rasterised.add(rk);
        tex.updateMatrix?.();
        const TM = tex.matrix, W = img.width, H = img.height;
        const v3 = new THREE.Vector3();
        const uvp = (i: number): [number, number] => { v3.set(uvAttr.getX(i), uvAttr.getY(i), 1).applyMatrix3(TM); return [v3.x, v3.y]; };
        const idx = g.index;
        for (let t = grp.start; t < grp.start + grp.count; t += 3) {
          const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
          if (i2 >= n) break;
          for (let k = 0; k < ctx.spots.length; k++) {
            const e = E[k];
            const ex: [number, number, number] = [e[i0 * 3], e[i1 * 3], e[i2 * 3]], ey: [number, number, number] = [e[i0 * 3 + 1], e[i1 * 3 + 1], e[i2 * 3 + 1]];
            if (ex.some(Number.isNaN)) continue;
            // how far in front this surface is near the eye (a face plate over a head shell: the plate is what shows)
            const r0 = Math.hypot(ex[0], ey[0]);
            if (r0 < 1.5) { job.front[k] += e[i0 * 3 + 2]; job.frontN[k]++; }
            if (r0 < 2.5) { job.near[k] += e[i0 * 3 + 2]; job.nearN[k]++; }
            const a = uvp(i0), b = uvp(i1), c = uvp(i2);
            // one tile: shift by the triangle's centroid tile (repeat-wrapped UVs)
            const fu = Math.floor((a[0] + b[0] + c[0]) / 3), fv = Math.floor((a[1] + b[1] + c[1]) / 3);
            const px: [number, number, number] = [(a[0] - fu) * W, (b[0] - fu) * W, (c[0] - fu) * W];
            const py = [a[1] - fv, b[1] - fv, c[1] - fv].map((v) => (tex.flipY ? 1 - v : v) * H) as [number, number, number];
            job.tris[k].push({ px, py, ex, ey });
          }
        }
      }
    }
  }

  phase('mesh');
  // ---- 3. read each texture, find the painted eyes, fill the copies
  const ckey = `${ctx.cacheKey}|${JSON.stringify(ctx.cfg)}|${ctx.spots.map((s) => [s.frame.c.toArray().map((x) => x.toFixed(5)), s.size.toFixed(5), s.outward]).join(';')}`;
  const hit = cache.get(ckey);
  const skinLin: ([number, number, number] | null)[] = hit ? hit.skin.slice() : ctx.spots.map(() => null);
  const fits: (EyeFit | null)[] = hit ? hit.fits.slice() : ctx.spots.map(() => null);
  if (hit) info.cached = true;
  // per texture: its bytes (read back exactly); per eye on it: the sub-rectangle its face triangles cover, with the
  // eye-frame coordinates of every texel (work stays proportional to the eye, not to the atlas)
  interface Sub { crop: Crop; bytes: Uint8Array; U: Float32Array; V: Float32Array }
  interface Read { job: Job; W: number; H: number; full: Uint8Array; subs: (Sub | null)[] }
  const reads: Read[] = [];
  // the surface that covers each eye's surroundings (the most triangles; between close contenders the front-most: a
  // face plate over a head shell); a few stray triangles of hair or a strap in front don't count
  const frontJob: (Job | null)[] = ctx.spots.map(() => null), frontW: number[] = ctx.spots.map(() => -Infinity);
  for (let k = 0; k < ctx.spots.length; k++) {
    const albedo = [...jobs.values()].filter((j) => j.albedo && j.frontN[k] > 0 && j.tris[k].length);
    const maxN = Math.max(0, ...albedo.map((j) => j.frontN[k]));
    for (const j of albedo) {
      if (j.frontN[k] < maxN * 0.6) continue;
      const w = j.front[k] / j.frontN[k];
      if (w > frontW[k]) { frontW[k] = w; frontJob[k] = j; }
    }
  }
  // other textures painting the same spot get a flat repaint (sparse: only their triangles' texels); those only
  // BEHIND the face there (fur / a body under the head, the inside of the mouth) are left alone
  const behind = (j: Job, k: number) => {
    const f = frontJob[k];
    if (!f || j === f) return false;
    return j.nearN[k] === 0 || j.near[k] / j.nearN[k] < f.near[k] / Math.max(1, f.nearN[k]) - 0.6;
  };
  let gl: WebGL2RenderingContext | null = null;
  try {
    for (const job of jobs.values()) {
      if (job.tris.every((t, k) => !t.length || behind(job, k))) continue;
      const img = job.tex.image as TexImageSource & { width: number; height: number };
      const W = img.width, H = img.height;
      gl ??= readbackContext();
      if (!gl) { info.warnings.push('Painted eyes: this browser can’t read textures back (no WebGL2).'); break; }
      const full = await readTextureExactAsync(gl, img, W, H);
      if (!full) { info.warnings.push(`Painted eyes: couldn’t read the texture '${job.tex.name || job.key}'.`); continue; }
      const subs = job.tris.map((list, k): Sub | null => {
        if (!list.length || frontJob[k] !== job) return null;
        let x0 = W, y0 = H, x1 = 0, y1 = 0;
        for (const t of list) { x0 = Math.min(x0, ...t.px); x1 = Math.max(x1, ...t.px); y0 = Math.min(y0, ...t.py); y1 = Math.max(y1, ...t.py); }
        const crop: Crop = { x: Math.max(0, Math.floor(x0) - 4), y: Math.max(0, Math.floor(y0) - 4), w: 0, h: 0 };
        crop.w = Math.min(W, Math.ceil(x1) + 4) - crop.x; crop.h = Math.min(H, Math.ceil(y1) + 4) - crop.y;
        if (crop.w <= 0 || crop.h <= 0) return null;
        const bytes = new Uint8Array(crop.w * crop.h * 4);
        for (let y = 0; y < crop.h; y++) bytes.set(full.subarray(((crop.y + y) * W + crop.x) * 4, ((crop.y + y) * W + crop.x + crop.w) * 4), y * crop.w * 4);
        info.sizes!.push(`${W}x${H} eye crop ${crop.w}x${crop.h}`);
        return { crop, bytes, U: new Float32Array(0), V: new Float32Array(0) };
      });
      reads.push({ job, W, H, full, subs });
    }
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  phase('read');
  const frontRead: (Read | null)[] = ctx.spots.map(() => null);
  // two eyes: how far toward the face's midline an eye may be looked for (eye sizes, along its outward direction)
  const sidedSpots = ctx.spots.filter((s) => s.outward !== 0);
  const sideOf = (k: number) => {
    const s = ctx.spots[k];
    if (sidedSpots.length !== 2 || s.outward === 0) return undefined;
    const half = sidedSpots[0].frame.c.distanceTo(sidedSpots[1].frame.c) / 2 / s.size;
    return { outward: s.outward, minOut: -half * 0.6 };
  };
  const cachedSub = (r: Read, k: number) => { const s = r.subs[k]; return s && hit?.crops.find((c) => c.key === `${r.job.key}|${k}` && c.crop.x === s.crop.x && c.crop.y === s.crop.y && c.crop.w === s.crop.w && c.crop.h === s.crop.h); };
  for (let k = 0; k < ctx.spots.length; k++) frontRead[k] = reads.find((r) => r.job === frontJob[k]) ?? null;
  for (const r of reads) r.subs.forEach((s, k) => {
    if (!s || cachedSub(r, k)) return;
    s.U = new Float32Array(s.crop.w * s.crop.h).fill(NaN); s.V = new Float32Array(s.crop.w * s.crop.h).fill(NaN);
    rasterizeCoords(s.U, s.V, s.crop, r.job.tris[k]);
  });
  for (let k = 0; k < ctx.spots.length; k++) {
    // where the painted eye is (on that surface)
    const fr = frontRead[k], s = fr?.subs[k];
    if (!hit && s) {
      const so = parts.sockets[k], sz = ctx.spots[k].size;
      const f = fitPaintedEye(s.bytes, s.U, s.V, SEARCH, sideOf(k), so && { u0: so.u0 / sz, u1: so.u1 / sz, v0: so.v0 / sz, v1: so.v1 / sz });
      fits[k] = f && f.confidence >= 0.15 ? f : null;
    }
  }
  // two eyes: each found eye must stay on its own side of the face (white teeth + the mouth line on the midline, or
  // one eye's paint found from the other marker, are not this eye)
  const sided = ctx.spots.filter((s) => s.outward !== 0);
  if (sided.length === 2) {
    const mid = sided[0].frame.c.clone().add(sided[1].frame.c).multiplyScalar(0.5);
    const half = sided[0].frame.c.distanceTo(sided[1].frame.c) / 2;
    ctx.spots.forEach((s, k) => {
      const f = fits[k];
      if (!f || s.outward === 0) return;
      const w = s.frame.c.clone().addScaledVector(s.frame.T, f.cx * s.size).addScaledVector(s.frame.B, f.cy * s.size);
      if (w.sub(mid).dot(s.frame.T) * s.outward < half * 0.4) fits[k] = null;
    });
  }
  phase('fit');
  const ellipses: Ellipse[] = ctx.spots.map((s, k) => {
    const f = fits[k], b = base[k];
    if (!f) return b;
    info.fitted++;
    // a boxy superellipse around the found extents (+ a margin for anti-aliased edges): reaches the lash wing in the
    // corner without growing into the brow
    return {
      cx: f.cx + b.cx, cy: f.cy + b.cy, p: 3,
      rx: Math.min(FIT_MAX[0], Math.max(0.8, f.hx) + FIT_MARGIN[0]) * cover,
      ry: Math.min(FIT_MAX[1], Math.max(0.55, f.hy) + FIT_MARGIN[1]) * cover,
    };
  });
  const newCrops: { key: string; crop: Crop; bytes: Uint8Array }[] = [];
  // the face's own skin around each eye (from the surface that shows it): every other texture that paints the same
  // spot (a head shell under a face plate, an emissive map) is judged against it and falls back to it
  const frontStats: (SkinStats | null)[] = ctx.spots.map((_, k) => {
    const s = frontRead[k]?.subs[k];
    return s && s.U.length ? ringSkinStats(s.bytes, ellipseDist(s.U, s.V, ellipses[k]), RING[0], RING[1]) : null;
  });
  for (const r of reads) {
    const { job } = r;
    // textures that aren't the visible face around an eye: a flat repaint of their triangles (the face's own skin
    // colour for albedo maps, the texture's own surroundings otherwise)
    job.tris.forEach((list, k) => {
      if (!list.length || r.subs[k] || behind(job, k)) return;
      const fs = frontStats[k];
      info.texels += flatRepaint(r.full, r.W, r.H, list, ellipses[k], FEATHER, job.albedo && fs ? fs.mean : null);
    });
    phase('flat');
    r.subs.forEach((s, k) => {
      if (!s) return;
      const cached = cachedSub(r, k);
      if (cached) s.bytes = cached.bytes;
      else {
        const dist = ellipseDist(s.U, s.V, ellipses[k]);
        dilateMask(dist, s.crop.w, s.crop.h, 2);
        const own = r === frontRead[k] ? frontStats[k] : ringSkinStats(s.bytes, dist, RING[0], RING[1]);
        if (r === frontRead[k] && own) skinLin[k] = [own.mean[0] * job.color.r, own.mean[1] * job.color.g, own.mean[2] * job.color.b];
        // the face's skin, when this texture's own surroundings look like it (same map, same colour space); else its own
        const fs = frontStats[k];
        const sameSkin = !!fs && !!own && Math.hypot(own.mean[0] - fs.mean[0], own.mean[1] - fs.mean[1], own.mean[2] - fs.mean[2]) < 3 * fs.sigma + 0.02;
        const stats = r === frontRead[k] || !fs || !job.albedo ? own : fs;
        phase('mask');
        info.texels += fillHoleRegions(s.bytes, dist, s.crop.w, s.crop.h, { feather: FEATHER, dSource: SOURCE_OUT, skin: stats, smooth: 60, grain: r === frontRead[k] || sameSkin ? GRAIN : 0, fallback: job.albedo && fs ? fs.mean : null, flat: job.albedo && !!fs && r !== frontRead[k] && !sameSkin });
        phase('fill');
      }
      newCrops.push({ key: `${job.key}|${k}`, crop: s.crop, bytes: s.bytes });
      // (eyes are filled one after the other: the second eye's sub-rectangle reads the first eye's result if they overlap)
      for (let y = 0; y < s.crop.h; y++) r.full.set(s.bytes.subarray(y * s.crop.w * 4, (y + 1) * s.crop.w * 4), ((s.crop.y + y) * r.W + s.crop.x) * 4);
      const nx = r.subs[k + 1];
      if (nx) for (let y = 0; y < nx.crop.h; y++) nx.bytes.set(r.full.subarray(((nx.crop.y + y) * r.W + nx.crop.x) * 4, ((nx.crop.y + y) * r.W + nx.crop.x + nx.crop.w) * 4), y * nx.crop.w * 4);
    });
    const nt = new THREE.DataTexture(r.full, r.W, r.H, THREE.RGBAFormat, THREE.UnsignedByteType);
    copyTexSettings(job.tex, nt);
    nt.needsUpdate = true;
    disposeTex.push(nt);
    info.textures++;
    for (const u of job.uses) {
      const mm = u.mat as THREE.Material & Record<string, unknown>;
      const old = mm[u.prop] as THREE.Texture;
      mm[u.prop] = nt;
      mm.needsUpdate = true;
      restore.push(() => { mm[u.prop] = old; mm.needsUpdate = true; });
    }
  }
  phase('upload');
  if (!hit && newCrops.length) {
    cache.set(ckey, { crops: newCrops, skin: skinLin, fits });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  // eye meshes that fill a hole in the face: now plain skin (the generated eye is drawn on them)
  const exp0 = ctx.exposure && ctx.exposure > 0 ? ctx.exposure : 1;
  for (const { mesh, near } of parts.skinned) {
    const c = skinLin[near] ?? skinLin.find(Boolean) ?? null;
    if (c) restore.push(skinMesh(mesh, new THREE.Color(c[0], c[1], c[2]), exp0));
  }
  restore.push(parts.restore);
  if (!info.textures && !info.hiddenMeshes) info.warnings.push('Painted eyes: found no eye texture or eye parts near the eye markers (move the markers onto the painted eyes).');
  const exp = ctx.exposure && ctx.exposure > 0 ? ctx.exposure : 1;
  info.ms = Math.round(performance.now() - t0);
  return {
    skin: skinLin.map((c) => (c ? new THREE.Color(c[0] / exp, c[1] / exp, c[2] / exp) : null)),
    fits: ctx.spots.map((s, k) => {
      const f = fits[k];
      if (!f) return null;
      const center = s.frame.c.clone().addScaledVector(s.frame.T, f.cx * s.size).addScaledVector(s.frame.B, f.cy * s.size);
      // the generated anime eye spans ≈ 2.25 sizes across (wing included) and ≈ 1.45 up-down (lashes included):
      // the size that fits it inside the painted eye's box
      return { center, size: Math.min(f.hx / 1.13, f.hy / 0.72) * s.size, confidence: f.confidence, iris: f.iris ? linearToHex(f.iris) : null };
    }),
    info,
    dispose() { for (const r of restore.reverse()) r(); for (const t of disposeTex) t.dispose(); },
  };
}

function copyTexSettings(a: THREE.Texture, b: THREE.Texture) {
  b.name = `${a.name || 'texture'} (eyes replaced)`;
  b.flipY = a.flipY; b.colorSpace = a.colorSpace;
  b.wrapS = a.wrapS; b.wrapT = a.wrapT; b.magFilter = a.magFilter;
  b.minFilter = a.minFilter; b.generateMipmaps = true; b.anisotropy = a.anisotropy;
  b.offset.copy(a.offset); b.repeat.copy(a.repeat); b.rotation = a.rotation; b.center.copy(a.center);
  b.matrixAutoUpdate = a.matrixAutoUpdate; b.matrix.copy(a.matrix);
  b.channel = a.channel;
  b.premultiplyAlpha = false; b.unpackAlignment = 4;
  b.userData = { ...a.userData, vtpEyesReplaced: true };
}

function readbackContext(): WebGL2RenderingContext | null {
  try {
    const cv: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    return (cv.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false }) as WebGL2RenderingContext | null) ?? null;
  } catch { return null; }
}

/**
 * Eye markers from the model's own eye bones (VRM / humanoid leftEye / rightEye): the centre of the parts skinned
 * mostly to each eye bone (iris, highlight), at their front, facing forward. Far more reliable than a guess from
 * the head's proportions. Model space, rest pose; null when the rig has no usable eye bones.
 */
export function eyeBoneMarkers(model: THREE.Object3D, meshes: THREE.Mesh[], anchor: THREE.Object3D, bones: { left: THREE.Object3D | null; right: THREE.Object3D | null }): { left: SurfaceMarker; right: SurfaceMarker; size: number } | null {
  model.updateWorldMatrix(true, true);
  const aq = anchor.getWorldQuaternion(new THREE.Quaternion());
  const L = new THREE.Vector3(1, 0, 0).applyQuaternion(aq), Up = new THREE.Vector3(0, 1, 0).applyQuaternion(aq), F = new THREE.Vector3(0, 0, 1).applyQuaternion(aq);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const part = (bone: THREE.Object3D | null) => {
    if (!bone) return null;
    const pts: THREE.Vector3[] = [];
    const v = new THREE.Vector3();
    for (const m of meshes) {
      const sm = m as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) continue;
      const bi = sm.skeleton.bones.indexOf(bone as THREE.Bone);
      const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight, pos = sm.geometry.attributes.position;
      if (bi < 0 || !si || !sw) continue;
      sm.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        let best = 0, bw = -1;
        for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; best = si.getComponent(i, c); } }
        if (best === bi) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(sm.matrixWorld).clone());
      }
    }
    if (pts.length < 12) return null;
    const q = (a: number[], f: number) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)];
    const us = pts.map((p) => p.dot(L)), vs = pts.map((p) => p.dot(Up)), fs = pts.map((p) => p.dot(F));
    const u = (q(us, 0.03) + q(us, 0.97)) / 2, w = (q(vs, 0.03) + q(vs, 0.97)) / 2, front = q(fs, 0.95);
    const c = new THREE.Vector3().addScaledVector(L, u).addScaledVector(Up, w).addScaledVector(F, front);
    return { c, hu: (q(us, 0.97) - q(us, 0.03)) / 2, hv: (q(vs, 0.97) - q(vs, 0.03)) / 2 };
  };
  const a = part(bones.left), b = part(bones.right);
  if (!a || !b) return null;
  const ipd = Math.abs(a.c.dot(L) - b.c.dot(L));
  if (ipd < 1e-4 || Math.max(a.hu, b.hu) > ipd * 0.6) return null;
  const nrm = F.clone().transformDirection(inv);
  const mk = (p: THREE.Vector3): SurfaceMarker => {
    const m = p.clone().applyMatrix4(inv);
    return { position: [+m.x.toFixed(4), +m.y.toFixed(4), +m.z.toFixed(4)], normal: [+nrm.x.toFixed(4), +nrm.y.toFixed(4), +nrm.z.toFixed(4)] };
  };
  const scale = model.getWorldScale(new THREE.Vector3()).x || 1;
  // the drawn anime eye ≈ 1.45 sizes tall: match the eye opening (≈ the iris / eye-part height)
  const size = Math.max(a.hv, b.hv, ipd * 0.12) * 0.95 / scale;
  return { left: mk(a.c), right: mk(b.c), size: +size.toFixed(4) };
}

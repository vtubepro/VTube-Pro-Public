// One eye (profile.eyes.layout 'left' / 'right', shared/eyeLayout.ts) for the model's OWN eyes, and the optional
// generated eye patch that covers the hidden eye on any avatar.
//
// Hiding a model eye cleanly (VRM / VRoid, humanoid GLBs, ARKit rigs):
//   1. its lids are held shut: the frame's eyeBlink<Side> = 1 (eyeWide / eyeLook of that side zeroed) before the
//      expression driver runs — VRM blinkLeft / blinkRight presets and ARKit eyeBlink morphs both follow
//   2. its eye bone (VRM / humanoid leftEye / rightEye) is scaled to ~0: the iris + highlight vertices skinned to it
//      collapse into the eyeball centre, behind the closed lid (nothing pokes through the lashes)
//   3. separate per-side eye meshes (Eye_L, EyeballRight …) are hidden outright
// Generated eyes simply don't draw the hidden eye (src/avatar/eyes.ts). Eyes painted into the face texture: the patch
// covers them — or profile.eyes.replaceBaked erases them and draws tracked eyes instead (src/avatar/bakedEyes.ts).
//
// The patch: a leather patch that hugs the face (an orthographic height field of the face around the eye — hair
// excluded — smoothed, domed a little and lifted clear of lashes / lids), with a darker rim and a stitched border,
// plus an optional strap: a flat ribbon around the head in a tilted plane (low at the patch, high over the other
// side of the forehead so it never crosses the visible eye, higher at the back), following the head's outline
// (hair included, so it rides over it). Both are rigid children of the head bone, built once at rest pose.

import * as THREE from 'three';
import type { EyeConfig, SurfaceMarker } from '../../shared/types.ts';
import { PATCH_DEFAULTS, effectiveLayout, hiddenSide, patchWanted, sanitizeEyePatch } from '../../shared/eyeLayout.ts';
import { faceFrame } from './surfacePatch.ts';
import { findAttachBone } from './eyes.ts';
import { markShared } from './gpuDispose.ts';

const HAIR_RE = /hair|bang|fringe|ponytail|twintail|ahoge/i;
const EYE_MESH_RE = /(eye(ball)?|iris|pupil|cornea|sclera)/i;
const NOT_EYE_RE = /lid|lash|line|brow|shadow|socket|patch|wear|glass|goggle|mask/i;
const LEFT_RE = /(^|[^a-z])(l|left)([^a-z]|$)|left/i;
const RIGHT_RE = /(^|[^a-z])(r|right)([^a-z]|$)|right/i;

export interface EyeLayoutRig {
  /** Which side is hidden (character's own side), or null (both / centre). */
  hidden: 'left' | 'right' | null;
  /** Model eyes: hold the hidden eye shut in the frame's face channels (call before the expression driver). */
  closeHidden(face: Record<string, number>, happy: number, arkit: boolean): Record<string, number>;
  patch: THREE.Group | null;
  /** What the runtime did, for the Face tab note / diagnostics. */
  info: { hiddenBones: number; hiddenMeshes: number; patch: boolean; strap: boolean; warning?: string };
  dispose(): void;
}

export interface EyeLayoutContext {
  eyes: EyeConfig;
  model: THREE.Object3D;
  anchor: THREE.Object3D;
  /** face-safe meshes (no costumes) */
  meshes: THREE.Mesh[];
  eyeBone(side: 'left' | 'right'): THREE.Object3D | null;
  headBone: THREE.Object3D | null;
  /** model → world scale (profile units → world) */
  scaleW: number;
}

/** null when nothing to do (both eyes / centre eye without a patch). */
export function setupEyeLayout(ctx: EyeLayoutContext): EyeLayoutRig | null {
  const E = ctx.eyes;
  const layout = effectiveLayout(E.layout, E.mode === 'none' ? 'model' : E.mode);
  const hidden = hiddenSide(layout);
  if (!hidden) return null;
  const info: EyeLayoutRig['info'] = { hiddenBones: 0, hiddenMeshes: 0, patch: false, strap: false };
  const restore: (() => void)[] = [];
  if (E.mode === 'model') {
    // 2. the eye bone: scale away behind the closed lid (tiny, not 0: keeps the matrices invertible)
    const b = ctx.eyeBone(hidden);
    if (b) { const s0 = b.scale.clone(); b.scale.setScalar(1e-4); info.hiddenBones++; restore.push(() => b.scale.copy(s0)); }
    // 3. separate per-side eye meshes
    const sideRe = hidden === 'left' ? LEFT_RE : RIGHT_RE, otherRe = hidden === 'left' ? RIGHT_RE : LEFT_RE;
    ctx.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.vtpGenerated || m.userData.vtpCostume) return;
      const names = [m.name, ...([] as THREE.Material[]).concat(m.material).map((x) => x?.name ?? '')];
      const n = names.find((x) => EYE_MESH_RE.test(x) && !NOT_EYE_RE.test(x) && sideRe.test(x.replace(EYE_MESH_RE, ' ')) && !otherRe.test(x.replace(EYE_MESH_RE, ' ')));
      if (!n || !m.visible) return;
      m.visible = false; info.hiddenMeshes++; restore.push(() => { m.visible = true; });
    });
  }
  let patch: THREE.Group | null = null;
  if (patchWanted(E)) {
    try {
      patch = buildEyePatch(ctx, hidden, sanitizeEyePatch(E.patch) ?? PATCH_DEFAULTS);
      info.patch = !!patch; info.strap = !!patch?.getObjectByName('vtp_eye_patch_strap');
      if (!patch) info.warning = 'Eye patch: couldn’t find where the hidden eye is (place the eye markers in the Face tab).';
    } catch (e) { console.warn('eye patch', e); info.warning = `Eye patch failed: ${(e as Error).message}`; patch = null; }
  }
  const bk = hidden === 'left' ? 'Left' : 'Right';
  return {
    hidden, patch, info,
    closeHidden(face, happy, arkit) {
      if (E.mode !== 'model') return face;
      const out = { ...face };
      // VRM emotion presets (joy) already close the lids a lot: don't double-close them
      out[`eyeBlink${bk}`] = arkit ? 1 : Math.max(0.55, 1 - 0.4 * happy);
      out[`eyeWide${bk}`] = 0;
      for (const d of ['In', 'Out', 'Up', 'Down']) out[`eyeLook${d}${bk}`] = 0;
      return out;
    },
    dispose() {
      for (const r of restore) r();
      if (patch) { patch.removeFromParent(); patch.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); ([] as THREE.Material[]).concat(m.material).forEach((x) => x.dispose()); } }); }
    },
  };
}

// ------------------------------------------------------------------------------------------------- the patch

interface PatchSpot {
  c: THREE.Vector3; T: THREE.Vector3; B: THREE.Vector3; N: THREE.Vector3; a: number; midX: number;
  /** model eyes: half-size of the eyeball parts skinned to the eye bone (iris / highlight), along T and B */
  iris?: { hu: number; hv: number };
  model?: boolean;
}

/** The hidden eye's own parts (vertices skinned mostly to its eye bone): their centre + half-extent in the T / B
 *  plane. Anime eyes are far taller than the eye-bone spacing suggests, and VRoid eye bones sit off the iris centre. */
function eyeParts(ctx: EyeLayoutContext, bone: THREE.Object3D, T: THREE.Vector3, B: THREE.Vector3): { c: THREE.Vector3; hu: number; hv: number } | null {
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const m of ctx.meshes) {
    const sm = m as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) continue;
    const bi = sm.skeleton.bones.indexOf(bone as THREE.Bone);
    if (bi < 0) continue;
    const dom = dominantBones(m);
    if (!dom) continue;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    m.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) if (dom[i] === bi) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
  }
  if (pts.length < 12) return null;
  const us = pts.map((p) => p.dot(T)).sort((x, y) => x - y), vs = pts.map((p) => p.dot(B)).sort((x, y) => x - y);
  const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  const u0 = q(us, 0.03), u1 = q(us, 0.97), v0 = q(vs, 0.03), v1 = q(vs, 0.97);
  const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  c.addScaledVector(T, (u0 + u1) / 2 - c.dot(T)).addScaledVector(B, (v0 + v1) / 2 - c.dot(B));
  return { c, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 };
}

/** Where the hidden eye is: eye bones (model eyes) > eye markers > nothing. `a` = patch half-width (world). */
function patchSpot(ctx: EyeLayoutContext, hidden: 'left' | 'right'): PatchSpot | null {
  const E = ctx.eyes;
  const aq = ctx.anchor.getWorldQuaternion(new THREE.Quaternion());
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(aq), up = new THREE.Vector3(0, 1, 0).applyQuaternion(aq), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(aq);
  ctx.model.updateWorldMatrix(true, true);
  const bl = ctx.eyeBone('left'), br = ctx.eyeBone('right');
  if (E.mode === 'model' && bl && br) {
    // the eyes' own parts (iris / highlight skinned to each eye bone) are the truth: some rigs put the eye bones at
    // the inner corners (Skyisles), VRoid a little above the iris
    const PL = eyeParts(ctx, bl, left, up), PR = eyeParts(ctx, br, left, up);
    const span = PL && PR ? Math.abs(PL.c.dot(left) - PR.c.dot(left)) : 0;
    if (PL && PR && span > 1e-4 && Math.max(PL.hu, PR.hu) < span * 0.45 && Math.max(PL.hv, PR.hv) < span * 0.6) {
      const P0 = hidden === 'left' ? PL : PR;
      return { c: P0.c, T: left, B: up, N: fwd, a: span * 0.4, midX: (PL.c.dot(left) + PR.c.dot(left)) / 2, iris: { hu: P0.hu, hv: P0.hv }, model: true };
    }
    if (!E.left || !E.right) {
      const pl = bl.getWorldPosition(new THREE.Vector3()), pr = br.getWorldPosition(new THREE.Vector3());
      const ipd = pl.distanceTo(pr);
      if (ipd > 1e-5) return { c: hidden === 'left' ? pl : pr, T: left, B: up, N: fwd, a: ipd * 0.47, midX: pl.clone().add(pr).multiplyScalar(0.5).dot(left), model: true };
    }
  }
  const m: SurfaceMarker | null = hidden === 'left' ? E.left : E.right;
  const other: SurfaceMarker | null = hidden === 'left' ? E.right : E.left;
  if (!m) return null;
  const f = faceFrame(m, ctx.model, ctx.anchor);
  const ipd = other ? new THREE.Vector3(...other.position).distanceTo(new THREE.Vector3(...m.position)) * ctx.scaleW : 0;
  const size = E.size * ctx.scaleW;
  const painted = E.style === 'decal' || E.style === 'anime' || E.style === 'led';
  // generated bulb / inset eyes: cover the ball + lids; painted: the drawn eye (≈1.75 × size); model eyes: from the spacing
  // painted eyes: the drawn eye's own reach (LED ≈ 0.6 × size wide, cartoon ≈ 1 ×, anime ≈ 1.2 ×) plus a margin
  const paintedA = E.style === 'led' ? 0.95 : E.style === 'anime' ? 1.6 : 1.35;
  let a = E.mode === 'model' ? (ipd > 0 ? ipd * 0.47 : size * 1.9) : painted ? size * paintedA : size * 1.5;
  if (E.mode === 'model' && ipd > 0) a = Math.min(a, Math.max(size * 3, ipd * 0.3));
  const otherW = other ? new THREE.Vector3(...other.position).applyMatrix4(ctx.model.matrixWorld) : null;
  const midX = otherW ? (f.c.dot(left) + otherW.dot(left)) / 2 : f.c.dot(left) + (hidden === 'left' ? -1 : 1) * a;
  return { c: f.c, T: f.T, B: f.B, N: f.N, a, midX, model: E.mode === 'model' };
}

/** Per-vertex dominant bone of a skinned mesh (null for static meshes). */
function dominantBones(m: THREE.Mesh): Int32Array | null {
  const sm = m as THREE.SkinnedMesh;
  const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight;
  if (!sm.isSkinnedMesh || !si || !sw) return null;
  const out = new Int32Array(si.count);
  for (let i = 0; i < si.count; i++) {
    let bi = 0, bw = -1;
    for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; bi = si.getComponent(i, c); } }
    out[i] = bi;
  }
  return out;
}

function buildEyePatch(ctx: EyeLayoutContext, hidden: 'left' | 'right', cfg: { color: string; strap: boolean; size?: number }): THREE.Group | null {
  const spot = patchSpot(ctx, hidden);
  if (!spot) return null;
  const { T, B, N } = spot;
  // size: the eye spacing, grown to cover the eye's own parts (iris ≈ half the drawn anime eye's width, a third of
  // its lid-to-lid height incl. lashes)
  const k = cfg.size ?? 1;
  const a = Math.max(spot.a, (spot.iris?.hu ?? 0) * 1.7) * k;
  // outline: a rounded shape a bit taller at the top, nudged away from the nose (patches sit on the eye socket)
  const outward = (spot.c.dot(T) - spot.midX) >= 0 ? 1 : -1; // +T side away from the face midline
  const ofs = new THREE.Vector2(outward * 0.06 * a, 0.04 * a);
  const bTop = Math.max(0.84 * a, (spot.iris?.hv ?? 0) * 1.45 * k), bBot = Math.max(0.74 * a, (spot.iris?.hv ?? 0) * 1.3 * k);
  const c = spot.c.clone().addScaledVector(T, ofs.x).addScaledVector(B, ofs.y);

  // ---- height field of the face in front of the eye (orthographic along N, hair excluded) ----
  const G = 44, ext = 1.3 * Math.max(1, bTop / (0.84 * a)); // grid covers ±ext·a (u) and ±ext·a (v)
  const cell = (2 * ext * a) / G;
  const H = new Float32Array(G * G).fill(-Infinity);
  const meshes = ctx.meshes.filter((m) => !HAIR_RE.test(m.name) && !([] as THREE.Material[]).concat(m.material).some((x) => HAIR_RE.test(x?.name ?? '')) && m.visible !== false);
  const pw = new THREE.Vector3();
  const raster = (cap: number) => {
    H.fill(-Infinity);
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position as THREE.BufferAttribute, idx = g.index;
      m.updateWorldMatrix(true, false);
      const n = pos.count, U = new Float32Array(n), V = new Float32Array(n), W = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        pw.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).sub(c);
        U[i] = pw.dot(T); V[i] = pw.dot(B); W[i] = pw.dot(N);
      }
      const tri = idx ? idx.count / 3 : n / 3, lim = ext * a + cell;
      for (let t = 0; t < tri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        const u0 = U[i0], u1 = U[i1], u2 = U[i2], v0 = V[i0], v1 = V[i1], v2 = V[i2];
        if (Math.max(u0, u1, u2) < -lim || Math.min(u0, u1, u2) > lim || Math.max(v0, v1, v2) < -lim || Math.min(v0, v1, v2) > lim) continue;
        const w0 = W[i0], w1 = W[i1], w2 = W[i2];
        if (Math.min(w0, w1, w2) > cap || Math.max(w0, w1, w2) < -3 * a) continue;
        const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
        if (Math.abs(den) < 1e-14) continue;
        const gx0 = Math.max(0, Math.floor((Math.min(u0, u1, u2) + ext * a) / cell)), gx1 = Math.min(G - 1, Math.floor((Math.max(u0, u1, u2) + ext * a) / cell));
        const gy0 = Math.max(0, Math.floor((Math.min(v0, v1, v2) + ext * a) / cell)), gy1 = Math.min(G - 1, Math.floor((Math.max(v0, v1, v2) + ext * a) / cell));
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
          const pu = -ext * a + (gx + 0.5) * cell, pv = -ext * a + (gy + 0.5) * cell;
          const l0 = ((v1 - v2) * (pu - u2) + (u2 - u1) * (pv - v2)) / den;
          const l1 = ((v2 - v0) * (pu - u2) + (u0 - u2) * (pv - v2)) / den;
          const l2 = 1 - l0 - l1;
          if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
          const h = l0 * w0 + l1 * w1 + l2 * w2;
          if (h > cap || h < -3 * a) continue;
          const k = gy * G + gx;
          if (h > H[k]) H[k] = h;
        }
      }
    }
  };
  // (model eye bones sit deep: an anime face can be ~3 eye-radii in front of them) — so look far first
  raster(8 * a);
  // the eye region's own surface height (median of the central cells) → ignore anything far in front of it (the
  // nose tip, hat brims, props): those parts stay in front of the patch instead of tenting it out
  const mid: number[] = [];
  for (let gy = G / 2 - 5; gy < G / 2 + 5; gy++) for (let gx = G / 2 - 5; gx < G / 2 + 5; gx++) { const h = H[gy * G + gx]; if (Number.isFinite(h)) mid.push(h); }
  if (!mid.length) return null;
  mid.sort((x, y) => x - y);
  const h0 = mid[Math.floor(mid.length / 2)];
  // (a big cartoon nose inside the outline would otherwise drag the patch out over it: it goes behind the nose instead)
  raster(h0 + 0.6 * a);
  // fill holes (inpaint from neighbours), then smooth — keep ≥ the raw surface so lashes never poke through
  const raw = Float32Array.from(H);
  for (let it = 0; it < 200; it++) {
    let missing = 0;
    const nx = Float32Array.from(H);
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      const k = gy * G + gx;
      if (Number.isFinite(H[k])) continue;
      let s = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= G || y >= G) continue;
        const v = H[y * G + x];
        if (Number.isFinite(v)) { s += v; n++; }
      }
      if (n) nx[k] = s / n; else missing++;
    }
    H.set(nx);
    if (!missing) break;
  }
  for (let k = 0; k < H.length; k++) if (!Number.isFinite(H[k])) H[k] = h0;
  for (let it = 0; it < 6; it++) {
    const nx = Float32Array.from(H);
    for (let gy = 1; gy < G - 1; gy++) for (let gx = 1; gx < G - 1; gx++) {
      const k = gy * G + gx;
      nx[k] = (H[k] * 4 + H[k - 1] + H[k + 1] + H[k - G] + H[k + G]) / 8;
      if (Number.isFinite(raw[k])) nx[k] = Math.max(nx[k], raw[k]);
    }
    H.set(nx);
  }
  const hAt = (u: number, v: number) => {
    const fx = Math.min(G - 1.001, Math.max(0, (u + ext * a) / cell - 0.5)), fy = Math.min(G - 1.001, Math.max(0, (v + ext * a) / cell - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const k = y0 * G + x0;
    return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - ty) + (H[k + G] * (1 - tx) + H[k + G + 1] * tx) * ty;
  };
  // max over a small neighbourhood: the patch rests ON the highest bits (lashes, lid bulge), never through them
  const hEnv = (u: number, v: number) => { let m = -Infinity; const r = cell * 1.2; for (const [du, dv] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) m = Math.max(m, hAt(u + du, v + dv)); return m; };

  // ---- patch mesh: rings × segments over the outline ----
  const RINGS = [0, 0.18, 0.34, 0.5, 0.62, 0.72, 0.8, 0.86, 0.9, 0.94, 0.97, 1];
  const SEG = 72;
  const pos: number[] = [], nrm: number[] = [], aP: number[] = [], index: number[] = [];
  // the model's own closed lids / lashes sit in front of the open-eye rest surface: more clearance there
  const clear = (spot.model ? 0.1 : 0.05) * a, dome = (spot.model ? 0.14 : 0.1) * a, rimT = 0.045 * a;
  const P = (rho: number, th: number, extraLift = 0) => {
    const b = Math.sin(th) >= 0 ? bTop : bBot;
    const u = Math.cos(th) * a * rho * (1 + 0.08 * Math.sin(th) * outward * Math.cos(th)), v = Math.sin(th) * b * rho;
    const lift = clear + dome * (1 - rho * rho) + extraLift;
    const h = hEnv(u, v) + lift;
    return c.clone().addScaledVector(T, u).addScaledVector(B, v).addScaledVector(N, h);
  };
  // top surface
  pos.push(...P(0, 0).toArray()); aP.push(0, 0);
  for (let r = 1; r < RINGS.length; r++) for (let s = 0; s < SEG; s++) {
    const th = (s / SEG) * Math.PI * 2;
    pos.push(...P(RINGS[r], th).toArray()); aP.push(RINGS[r], s / SEG);
  }
  const vi = (r: number, s: number) => (r === 0 ? 0 : 1 + (r - 1) * SEG + (s % SEG));
  for (let s = 0; s < SEG; s++) index.push(0, vi(1, s), vi(1, s + 1));
  for (let r = 1; r < RINGS.length - 1; r++) for (let s = 0; s < SEG; s++) {
    const a0 = vi(r, s), a1 = vi(r, s + 1), b0 = vi(r + 1, s), b1 = vi(r + 1, s + 1);
    index.push(a0, b0, b1, a0, b1, a1);
  }
  // edge band: the rim folds back down to the skin (visible thickness)
  const edge0 = pos.length / 3;
  for (let s = 0; s < SEG; s++) {
    const th = (s / SEG) * Math.PI * 2;
    pos.push(...P(1.015, th, -clear - rimT * 0.8).toArray()); aP.push(1.02, s / SEG);
  }
  const last = RINGS.length - 1;
  for (let s = 0; s < SEG; s++) {
    const a0 = vi(last, s), a1 = vi(last, s + 1), b0 = edge0 + s, b1 = edge0 + ((s + 1) % SEG);
    index.push(a0, b0, b1, a0, b1, a1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPatch', new THREE.Float32BufferAttribute(aP, 2));
  geo.setIndex(index);
  // winding: normals must face out (+N)
  geo.computeVertexNormals();
  const nA = geo.attributes.normal as THREE.BufferAttribute;
  let dotSum = 0;
  for (let i = 0; i < nA.count; i++) dotSum += nA.getX(i) * N.x + nA.getY(i) * N.y + nA.getZ(i) * N.z;
  if (dotSum < 0) { const ix = geo.index!; for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, t); } geo.computeVertexNormals(); }
  void nrm;

  const head = ctx.headBone ?? findAttachBone(ctx.meshes, spot.c) ?? ctx.model;
  head.updateWorldMatrix(true, false);
  const inv = head.matrixWorld.clone().invert();
  geo.applyMatrix4(inv);
  const group = new THREE.Group();
  group.name = 'vtp_eye_patch';
  const mat = patchMaterial(cfg.color, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'vtp_eye_patch_cover';
  group.add(mesh);

  if (cfg.strap) {
    try {
      // the strap plane runs through the patch's SURFACE (not the eyeball centre deep behind it), a little above centre
      const strap = buildStrap(ctx, spot, c.clone().addScaledVector(N, h0).addScaledVector(B, 0.3 * a), a, hidden, head, [bTop, bBot], c);
      if (strap) {
        const sm = new THREE.Mesh(strap, patchMaterial(cfg.color, false));
        sm.name = 'vtp_eye_patch_strap';
        group.add(sm);
      }
    } catch (e) { console.warn('eye patch strap', e); }
  }
  group.traverse((o) => { o.userData.vtpGenerated = true; o.userData.vtpNoToon = true; o.frustumCulled = false; });
  head.add(group);
  return group;
}

/** Tilted ribbon loop around the head through the patch. */
function buildStrap(ctx: EyeLayoutContext, spot: PatchSpot, c: THREE.Vector3, a: number, hidden: 'left' | 'right', head: THREE.Object3D, bb: [number, number], pc: THREE.Vector3): THREE.BufferGeometry | null {
  const aq = ctx.anchor.getWorldQuaternion(new THREE.Quaternion());
  const X = new THREE.Vector3(1, 0, 0).applyQuaternion(aq), Y = new THREE.Vector3(0, 1, 0).applyQuaternion(aq), Z = new THREE.Vector3(0, 0, 1).applyQuaternion(aq);
  // head vertices: skinned to the head bone or below it (hair included: the strap rides over it), else near the eye
  const headSet = new Set<THREE.Object3D>();
  if (ctx.headBone) ctx.headBone.traverse((o) => { headSet.add(o); });
  const pts: THREE.Vector3[] = [];
  const pw = new THREE.Vector3();
  const near = 8 * a;
  ctx.model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.vtpGenerated || m.userData.vtpOutline || m.userData.vtpCostume || !m.geometry?.attributes.position || !m.visible) return;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const dom = headSet.size ? dominantBones(m) : null;
    const bones = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh).skeleton.bones : null;
    let underHead = false;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (headSet.has(p)) { underHead = true; break; }
    m.updateWorldMatrix(true, false);
    const step = Math.max(1, Math.floor(pos.count / 30000));
    for (let i = 0; i < pos.count; i += step) {
      if (headSet.size) {
        if (dom && bones) { if (!headSet.has(bones[dom[i]])) continue; }
        else if (!underHead) continue;
      }
      pw.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (pw.distanceTo(spot.c) > near) continue;
      pts.push(pw.clone());
    }
  });
  if (pts.length < 50) return null;
  const diag = new THREE.Box3().setFromPoints(pts).getSize(new THREE.Vector3()).length();
  // plane: through the patch, rising toward the other side (k) and toward the back (m)
  const sgn = hidden === 'right' ? 1 : -1; // hidden right eye sits at −X: the strap climbs toward +X
  const n = X.clone().multiplyScalar(-sgn * 1.0).add(Y).add(Z.clone().multiplyScalar(1.0)).normalize();
  const BINS = 96, slab = Math.max(0.22 * a, diag * 0.02);
  // centre of the head's cross-section in that plane (inside it, whatever the head shape: frogs, robots, anime)
  const sec = pts.filter((p) => Math.abs(p.clone().sub(c).dot(n)) < slab);
  if (sec.length < 40) return null;
  const O = sec.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / sec.length);
  O.sub(n.clone().multiplyScalar(n.dot(O.clone().sub(c))));
  const e1 = c.clone().sub(O); e1.sub(n.clone().multiplyScalar(e1.dot(n))).normalize(); // in-plane: toward the patch
  const e2 = n.clone().cross(e1).normalize();
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  for (const p of sec) {
    const d = p.clone().sub(O);
    const x = d.dot(e1), y = d.dot(e2);
    const k = Math.floor(((Math.atan2(y, x) / (Math.PI * 2)) + 1) % 1 * BINS) % BINS;
    bins[k].push(Math.hypot(x, y));
  }
  let R = bins.map((b) => { if (b.length < 2) return NaN; b.sort((x, y) => x - y); return b[Math.floor(b.length * 0.92)]; });
  if (R.filter(Number.isFinite).length < BINS * 0.5) return null;
  // fill gaps circularly, then smooth (a strap is taut: no dips into hair gaps)
  for (let it = 0; it < BINS; it++) {
    let any = false;
    R = R.map((r, k) => { if (Number.isFinite(r)) return r; const l = R[(k + BINS - 1) % BINS], rr = R[(k + 1) % BINS]; const v = [l, rr].filter(Number.isFinite); if (!v.length) { any = true; return NaN; } return v.reduce((s, x) => s + x, 0) / v.length; });
    if (!any) break;
  }
  for (let it = 0; it < 3; it++) {
    const hull = R.map((r, k) => Math.max(r, (R[(k + BINS - 1) % BINS] + R[(k + 1) % BINS]) / 2)); // taut: bridge concave dips
    R = hull.map((_, k) => (hull[(k + BINS - 1) % BINS] + 2 * hull[k] + hull[(k + 1) % BINS]) / 4);
  }
  // taut over the face, not round it: below the patch, nothing in front of its own surface (a big cartoon nose would
  // otherwise pull the strap into a loop around it) — the strap passes behind / through it. Above, it rides the bangs.
  const front = spot.N.dot(c) + 0.25 * a;
  for (let k = 0; k < BINS; k++) {
    const th = ((k + 0.5) / BINS) * Math.PI * 2;
    const dir = e1.clone().multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th));
    const nd = spot.N.dot(dir);
    const below = spot.B.dot(O.clone().addScaledVector(dir, R[k]).sub(c)) < 0.1 * a;
    if (nd > 1e-3 && below) R[k] = Math.min(R[k], Math.max(0, (front - spot.N.dot(O)) / nd));
  }
  const lift = 0.035 * a, half = 0.1 * a;
  const pos: number[] = [], aP: number[] = [], index: number[] = [];
  // skip the part under the patch (the strap tucks under its edge)
  const inPatch = (p: THREE.Vector3) => {
    // anywhere inside the patch outline: the strap tucks under it
    const d = p.clone().sub(pc);
    const v0 = d.dot(spot.B), u = d.dot(spot.T) / a, v = v0 / (v0 >= 0 ? bb[0] : bb[1]);
    return u * u + v * v < 0.92 && Math.abs(d.dot(spot.N)) < 3 * a;
  };
  const ring: THREE.Vector3[] = [];
  for (let k = 0; k < BINS; k++) {
    const th = ((k + 0.5) / BINS) * Math.PI * 2;
    ring.push(O.clone().addScaledVector(e1, Math.cos(th) * (R[k] + lift)).addScaledVector(e2, Math.sin(th) * (R[k] + lift)));
  }
  for (let k = 0; k < BINS; k++) {
    pos.push(...ring[k].clone().addScaledVector(n, half).toArray(), ...ring[k].clone().addScaledVector(n, -half).toArray());
    aP.push(2, k / BINS, 2, k / BINS);
  }
  for (let k = 0; k < BINS; k++) {
    const k1 = (k + 1) % BINS;
    if (inPatch(ring[k]) || inPatch(ring[k1])) continue;
    const a0 = k * 2, b0 = k * 2 + 1, a1 = k1 * 2, b1 = k1 * 2 + 1;
    index.push(a0, b0, b1, a0, b1, a1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPatch', new THREE.Float32BufferAttribute(aP, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  // normals of a ribbon: outward from the head centre
  const nA = geo.attributes.normal as THREE.BufferAttribute, pA = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < nA.count; i++) {
    const d = new THREE.Vector3(pA.getX(i), pA.getY(i), pA.getZ(i)).sub(O);
    d.sub(n.clone().multiplyScalar(d.dot(n))).normalize();
    nA.setXYZ(i, d.x, d.y, d.z);
  }
  head.updateWorldMatrix(true, false);
  geo.applyMatrix4(head.matrixWorld.clone().invert());
  return geo;
}

let gradient: THREE.DataTexture | null = null;
function toonRamp(): THREE.DataTexture {
  if (gradient) return gradient;
  // every eye patch's (it sits under the head bone): markShared so one avatar's dispose never frees it for the others
  gradient = markShared(new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat));
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

/** Toon leather: a darker rim line and (patch only) a stitched border, drawn in the shader from aPatch (ρ, θ). */
function patchMaterial(color: string, stitched: boolean): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: new THREE.Color(color), gradientMap: toonRamp(), side: THREE.DoubleSide });
  m.name = stitched ? 'vtp-eye-patch' : 'vtp-eye-patch-strap';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aPatch; varying vec2 vPatch;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPatch = aPatch;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vPatch;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `vec4 diffuseColor = vec4( diffuse, opacity );
        {
          float rho = vPatch.x;
          vec3 base = diffuseColor.rgb;
          // subtle leather sheen toward the middle + a darker rolled edge
          base *= mix(1.0, 1.12, smoothstep(0.7, 0.0, rho) * step(rho, 1.5));
          float edge = smoothstep(0.9, 0.97, rho) * step(rho, 1.5);
          base = mix(base, base * 0.45, edge);
          ${stitched ? `// stitched border: short dashes around the rim
          float dash = step(0.5, fract(vPatch.y * 56.0));
          float band = smoothstep(0.012, 0.0, abs(rho - 0.86));
          base = mix(base, max(base * 2.6, vec3(0.34, 0.31, 0.3)), band * dash * 0.85);` : ''}
          diffuseColor.rgb = base;
        }`);
  };
  m.customProgramCacheKey = () => (stitched ? 'vtp-eye-patch-s' : 'vtp-eye-patch');
  return m;
}

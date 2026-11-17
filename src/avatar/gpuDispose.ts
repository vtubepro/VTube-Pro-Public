// Freeing what an avatar put on the GPU (AvatarRuntime.dispose). material.dispose() never frees a material's
// textures and a SkinnedMesh never frees its skeleton's bone texture, so before this every avatar load / dispose left
// its glTF textures and bone textures registered with the renderer (tools/lod_bench.mjs D gate: +7 textures a cycle on
// frogsuit). The decoded ImageBitmaps behind glTF textures are closed too: three.js never closes them (GLTFLoader's
// docs ask for it), so their decoded pixels otherwise wait for a garbage collection.
import * as THREE from 'three';

/** Textures several avatars share (module-level ramps): never disposed with one avatar. */
export function markShared<T extends THREE.Texture>(t: T): T { t.userData.vtpShared = true; return t; }

/** Every texture a material holds: its own texture slots + ShaderMaterial (MToon, outline hull…) uniforms. */
export function texturesOf(m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  const add = (v: unknown) => { if ((v as THREE.Texture)?.isTexture) out.push(v as THREE.Texture); };
  for (const v of Object.values(m)) add(v);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k in u) { const v = u[k]?.value; if (Array.isArray(v)) v.forEach(add); else add(v); }
  return out;
}

/** Close a bitmap nothing else will draw, unless THREE.Cache holds it (an image loaded from its own URL, with the cache
 *  on — the studio): another load may still be handed it. GLB-embedded images load from per-parse blob: URLs, which
 *  THREE.Cache never stores, so theirs are always closed. */
export function releaseBitmap(img: unknown) {
  if (typeof ImageBitmap === 'undefined' || !(img instanceof ImageBitmap)) return;
  if (THREE.Cache.enabled && Object.values(THREE.Cache.files).includes(img)) return;
  try { img.close(); } catch { /* already closed */ }
}

/** Dispose every mesh under `root`: geometry, materials, the materials' textures (shared ones aside, their bitmaps
 *  released) and the skeletons' bone textures. Each shared object is disposed once. */
export function disposeMeshes(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(), skels = new Set<THREE.Skeleton>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry) geos.add(m.geometry);
    for (const mat of ([] as (THREE.Material | null | undefined)[]).concat(m.material)) if (mat) mats.add(mat);
    const sk = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
    if (sk) skels.add(sk);
  });
  const texs = new Set<THREE.Texture>();
  for (const mat of mats) for (const t of texturesOf(mat)) if (!t.userData?.vtpShared) texs.add(t);
  for (const g of geos) g.dispose();
  for (const mat of mats) mat.dispose();
  for (const s of skels) s.dispose();
  for (const t of texs) { t.dispose(); releaseBitmap(t.image); }
}

/** Dispose the bone textures of every skinned mesh under `root`. Each skClone() actor owns its skeleton, and only
 *  Skeleton.dispose() frees its bone texture (a crowd room left hundreds of them registered per room change). */
export function disposeSkeletons(root: THREE.Object3D) {
  const skels = new Set<THREE.Skeleton>();
  root.traverse((o) => { const s = o as THREE.SkinnedMesh; if (s.isSkinnedMesh && s.skeleton) skels.add(s.skeleton); });
  for (const s of skels) s.dispose();
}

/** Like disposeMeshes, but for a ROOM's own parsed subtree: also Points / Line / Sprite objects, and every texture
 *  (shared ones aside) has its decoded bitmap released. Only hand it objects this room alone owns (never a module-cached
 *  asset or a shared prop model: bitmap.close() cannot be undone). A Sprite's geometry is three's shared one: skipped. */
export function disposeRoomTree(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const d = o as THREE.Mesh & THREE.Points & THREE.Line & THREE.Sprite;
    if (!(d.isMesh || d.isPoints || d.isLine || d.isSprite)) return;
    if (d.geometry && !d.isSprite) geos.add(d.geometry);
    for (const mat of ([] as (THREE.Material | null | undefined)[]).concat(d.material)) if (mat) mats.add(mat);
  });
  const texs = new Set<THREE.Texture>();
  // (a render target's texture belongs to its target, not to this room: freeing it under the target would blank it)
  for (const mat of mats) for (const t of texturesOf(mat)) if (!t.userData?.vtpShared && !t.isRenderTargetTexture) texs.add(t);
  for (const g of geos) g.dispose();
  for (const mat of mats) mat.dispose();
  disposeSkeletons(root);
  for (const t of texs) { t.dispose(); releaseBitmap(t.image); }
}

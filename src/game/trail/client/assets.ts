// The Trail — theme pack assets (trailart's GLBs, ASSET_SPEC.md) from this PC's server: /api/trail/<theme>/file/<rel>.
// Missing files are normal (the placeholder art is used). Nothing here ever touches party members' models.
// Contract notes honoured (S\trail\ART_NOTES.md): ink hull primitives (materials `M_Ink*`) are kept as authored (no
// second outline), vertex colours stay on through the toon conversion, `_LOD1` meshes are hidden (LOD0 shown), helper
// nodes (COL_ / ZONE_ / SPAWN_ / …) are invisible.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { toToonMaterial } from '../../../avatar/toon.ts';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] } | null>>();
const missing = new Set<string>();
const HELPER = /^(COL_|ZONE_|KILL_|NAV_|PATH_|SPAWN_|CAM_|ITEM_|ANIMAL_SPAWN_|NPC_|SOCKET_|GRAB_|SEAT_|SLOT_|HITCH|ANIMAL_SLOT_|WAGON_PARK|FX_|WATER_)/;

export const themeFileUrl = (theme: string, rel: string) => `/api/trail/${encodeURIComponent(theme)}/file/${rel.split('/').map(encodeURIComponent).join('/')}`;

function prepare(root: THREE.Object3D) {
  const hide: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (HELPER.test(o.name) || /_LOD1$/.test(o.name)) hide.push(o);
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = m.receiveShadow = true;
    // ink hulls + unlit materials (KHR_materials_unlit: cards, skies, emitters) stay as authored; the rest → the toon ramp
    const conv = (mat: THREE.Material) => {
      if (/^M_Ink/i.test(mat.name) || (mat.userData as { ink?: boolean }).ink || /^M_Collider/.test(mat.name)) return mat;
      if (/^M_Sky/i.test(mat.name)) { (mat as THREE.MeshBasicMaterial).fog = false; return mat; }   // backdrops at 80–95 m: no fog
      if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) { if (/^M_Sky/i.test(mat.name)) (mat as THREE.MeshBasicMaterial).fog = false; return mat; }
      return toToonMaterial(mat);
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    if (Array.isArray(m.material) ? m.material.some((x) => /^M_Ink/i.test(x.name)) : /^M_Ink/i.test(m.material.name)) m.castShadow = false;
  });
  for (const o of hide) o.visible = false;
}

async function load(theme: string, rel: string) {
  const url = themeFileUrl(theme, rel);
  if (missing.has(url)) return null;
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => { prepare(g.scene); return { scene: g.scene as unknown as THREE.Group, clips: g.animations }; }).catch(() => { missing.add(url); return null; });
    cache.set(url, p);
  }
  return p;
}

/** A theme GLB (a fresh clone each call; skinned-safe), or null when the pack doesn't have it. */
export async function loadThemeGlb(theme: string, rel: string): Promise<THREE.Group | null> {
  const g = await load(theme, rel);
  if (!g) return null;
  const c = skClone(g.scene) as THREE.Group;
  c.userData.clips = g.clips;
  return c;
}
/** One named root of a kit GLB (props.glb → PROP_<id>), cloned. */
export async function loadThemePart(theme: string, rel: string, node: string): Promise<THREE.Object3D | null> {
  const g = await load(theme, rel);
  const src = g?.scene.getObjectByName(node);
  if (!src) return null;
  const c = skClone(src);
  c.position.set(0, 0, 0); c.quaternion.identity();
  return c;
}
/** Animation clips of a theme GLB. */
export async function themeClips(theme: string, rel: string): Promise<THREE.AnimationClip[]> { return (await load(theme, rel))?.clips ?? []; }

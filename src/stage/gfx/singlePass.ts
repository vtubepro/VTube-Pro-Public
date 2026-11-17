// CPU pass (perf workstream, measured): three.js draws every transparent + DoubleSide material TWICE per render (back
// faces, then front faces) and flips `material.side` + `needsUpdate` around each draw, so the renderer re-derives the
// shader parameters and program key (getParameters / getProgram) twice per object per pass, every frame. In the
// one model starship deck at High that was ~10 % of the page's main-thread time (glass panes, HUD cards, the avatar's
// iris / brow / lash decals; each drawn in the main, glow and AO passes).
//
// The two-pass trick only matters for CLOSED or folded transparent shapes (back faces must land behind front faces).
// For a SHEET — every normal within ~60° of the mesh's mean normal: panes, decals, cards, HUDs — the back-face pass
// and the front-face pass never overlap on screen, so drawing both sides in one pass (forceSinglePass) gives the same
// picture. Only such sheets are switched; anything curved around (canopies, bottles, bubbles) keeps the two passes.
import * as THREE from 'three';

const sheetCache = new WeakMap<THREE.BufferGeometry, boolean>();
const MIN_DOT = 0.5;

/** Every normal within 60° of the mean normal (a height-field-like sheet). Cached per geometry. */
export function isSheet(g: THREE.BufferGeometry): boolean {
  const hit = sheetCache.get(g);
  if (hit !== undefined) return hit;
  let ok = false;
  const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (n && n.count > 0 && n.itemSize === 3 && !(n as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n.count; i++) { mx += n.getX(i); my += n.getY(i); mz += n.getZ(i); }
    const len = Math.hypot(mx, my, mz);
    if (len > 1e-6) {
      mx /= len; my /= len; mz /= len;
      ok = true;
      for (let i = 0; i < n.count; i++) {
        const x = n.getX(i), y = n.getY(i), z = n.getZ(i);
        const l = Math.hypot(x, y, z) || 1;
        if ((x * mx + y * my + z * mz) / l < MIN_DOT) { ok = false; break; }
      }
    }
  }
  sheetCache.set(g, ok);
  return ok;
}

const checked = new WeakSet<THREE.Material>();
/** Materials this layer switched (for info / tests). */
export const singlePassStats = { switched: 0, kept: 0 };

/** Switch transparent DoubleSide materials used only on sheets to one pass. A material shared with a non-sheet mesh
 *  stays two-pass. Cheap to call repeatedly (materials are only judged once; morphs / skinning keep the rest shape's
 *  normals, so sheets stay sheets). */
export function singlePassSheets(root: THREE.Object3D) {
  const verdict = new Map<THREE.Material, boolean>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || !mesh.geometry) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (checked.has(m) || !m.transparent || m.side !== THREE.DoubleSide || m.forceSinglePass) continue;
      const v = isSheet(mesh.geometry);
      verdict.set(m, (verdict.get(m) ?? true) && v);
    }
  });
  for (const [m, sheet] of verdict) {
    checked.add(m);
    if (sheet) { m.forceSinglePass = true; singlePassStats.switched++; } else singlePassStats.kept++;
  }
}

// Load-time clean-up of morph targets that do nothing.
//
// ARKit-style exports often put all ~52 shapes on EVERY mesh (eyes, lashes, teeth, tongue, body...) although only the
// face mesh has real deltas. three.js builds one Float32 morph texture per geometry (CPU array + GPU copy, filled by a
// JS loop on the first draw), and the outline hull / fur shells / decal patches made from that mesh each repeat it.
// Dropping the all-zero targets once, before any of those are built, shrinks all of them and changes nothing drawn.
//
// What stays the same: a target is only removed from a mesh when it moves NO vertex there (position, normal and
// colour deltas all zero) AND another mesh in the model keeps a non-zero target of the same name, so the set of
// shape names the model offers (ExpressionDriver, viseme rig, mouth rules, face map) is untouched. A name that is
// zero everywhere is kept everywhere. Everything that looks a shape up does so by name through the mesh's
// morphTargetDictionary, which is rebuilt here together with the influence array (kept values, in place).
import type * as THREE from 'three';

type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

export interface MorphPruneInfo {
  /** Targets removed, summed over geometries. */
  removed: number;
  /** Geometries that lost at least one target. */
  geometries: number;
}

const KEYS = ['position', 'normal', 'color'] as const;

/** Is target `i` of this geometry a no-op (every delta exactly zero)? Null = can't tell (leave it alone). */
function targetIsZero(g: THREE.BufferGeometry, i: number): boolean | null {
  const rel = g.morphTargetsRelative === true;
  for (const key of KEYS) {
    const list = g.morphAttributes[key] as Attr[] | undefined;
    if (!list) continue;
    const m = list[i];
    if (!m) return null;
    const arr = (m as THREE.BufferAttribute).array as ArrayLike<number> | undefined;
    if (!arr || (m as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
    if (rel) {
      for (let k = 0; k < arr.length; k++) if (arr[k] !== 0) return false;
    } else {
      // absolute targets: zero means "equal to the base attribute"
      const base = g.attributes[key] as Attr | undefined;
      const b = (base as THREE.BufferAttribute | undefined)?.array as ArrayLike<number> | undefined;
      if (!base || !b || (base as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || base.itemSize !== m.itemSize || b.length !== arr.length) return null;
      for (let k = 0; k < arr.length; k++) if (arr[k] !== b[k]) return false;
    }
  }
  return true;
}

/**
 * Remove the no-op morph targets of these meshes (see the file header for the exact rule). `step` is awaited between
 * geometries so a live page can hand the thread back. Run once, right after the meshes are collected and before
 * outlines / surface styles / patches are built. Not for VRMs (their expressions bind morph targets by index).
 */
export async function pruneZeroMorphs(meshes: THREE.Mesh[], step?: () => Promise<void>): Promise<MorphPruneInfo> {
  const info: MorphPruneInfo = { removed: 0, geometries: 0 };
  // geometry -> the meshes drawing it (a cloned scene can share one)
  const byGeo = new Map<THREE.BufferGeometry, THREE.Mesh[]>();
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g?.morphAttributes?.position?.length || !m.morphTargetDictionary || !m.morphTargetInfluences) continue;
    (byGeo.get(g) ?? byGeo.set(g, []).get(g)!).push(m);
  }
  if (!byGeo.size) return info;

  // which targets are no-ops, per geometry (null entry = unknown)
  const zero = new Map<THREE.BufferGeometry, (boolean | null)[]>();
  const names = new Map<THREE.Mesh, string[]>();            // index -> name (first name wins; '' = unnamed)
  const live = new Set<string>();                           // shape names with real deltas somewhere
  for (const [g, ms] of byGeo) {
    const n = g.morphAttributes.position!.length;
    // every list must line up with the position list, or leave this geometry alone
    if (KEYS.some((k) => g.morphAttributes[k] && g.morphAttributes[k]!.length !== n) || ms.some((m) => m.morphTargetInfluences!.length !== n)) { byGeo.delete(g); continue; }
    const z: (boolean | null)[] = [];
    for (let i = 0; i < n; i++) z.push(targetIsZero(g, i));
    zero.set(g, z);
    for (const m of ms) {
      const nm: string[] = new Array(n).fill('');
      for (const [name, i] of Object.entries(m.morphTargetDictionary!)) if (i >= 0 && i < n && !nm[i]) nm[i] = name;
      names.set(m, nm);
      for (let i = 0; i < n; i++) if (nm[i] && z[i] !== true) live.add(nm[i]);
    }
    if (step) await step();
  }

  const done = new Set<object>();
  for (const [g, ms] of byGeo) {
    const z = zero.get(g)!;
    const n = z.length;
    // keep a target unless every mesh using this geometry can lose it (zero here, and its name lives on elsewhere)
    const keep: boolean[] = [];
    for (let i = 0; i < n; i++) {
      let drop = z[i] === true;
      if (drop) for (const m of ms) { const nm = names.get(m)![i]; if (!nm || !live.has(nm)) { drop = false; break; } }
      keep.push(!drop);
    }
    const kept = keep.filter(Boolean).length;
    if (kept === n) continue;
    const remap: number[] = new Array(n).fill(-1);
    let next = 0;
    for (let i = 0; i < n; i++) if (keep[i]) remap[i] = next++;
    for (const k of KEYS) {
      const list = g.morphAttributes[k];
      if (!list) continue;
      if (kept) g.morphAttributes[k] = list.filter((_, i) => keep[i]);
      else delete g.morphAttributes[k];
    }
    for (const m of ms) {
      // (meshes may share one influence array / dictionary: remap each object once)
      if (done.has(m.morphTargetInfluences!)) continue;
      done.add(m.morphTargetInfluences!);
      const old = Array.from(m.morphTargetInfluences!);
      const dict = m.morphTargetDictionary!;
      const nd: Record<string, number> = {};
      for (const [name, i] of Object.entries(dict)) if (i >= 0 && i < n && remap[i] >= 0) nd[name] = remap[i];
      if (kept) {
        const infl = m.morphTargetInfluences!;
        infl.length = 0;
        for (let i = 0; i < n; i++) if (keep[i]) infl.push(old[i]);
        for (const name of Object.keys(dict)) delete dict[name];
        Object.assign(dict, nd);
      } else {
        // nothing left: a plain mesh again (three then builds no morph texture at all)
        m.morphTargetInfluences = undefined;
        m.morphTargetDictionary = undefined;
      }
    }
    info.removed += n - kept;
    info.geometries++;
    if (step) await step();
  }
  return info;
}

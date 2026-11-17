// Is this rig any good? A quick pose sweep on a loaded avatar (no rendering, CPU skinning on a sample of the mesh):
// arms up, arms down, head turned, body leaning, a step. For each pose it measures the obvious failures:
//   - tear: triangle edges stretched past 2.2× or squashed under 0.35× (mesh tearing / collapsing),
//   - fly:  points that move more than 60 % of the body height (vertices flying away),
//   - leak: the wrong part moving (legs following a head turn, the belly following an arm, the feet following a lean),
//   - stretch: how much the surface distorts on average (mean |ln(edge length / rest length)|: 0 = moved rigidly).
// Lower is better. The import uses it to pick the instant soft rig or Blender's autorig, whichever moves more cleanly.
import * as THREE from 'three';
import type { AvatarRuntime } from './AvatarRuntime.ts';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';

export interface PoseResult { pose: string; tear: number; fly: number; leak: number; stretch: number;
  /** Share of the places where two body parts touch at rest (different bones) that came apart (> 4 % of the height). */
  gap: number }
export interface RigScore { contacts: number; /** Height of the skinned mesh with every humanoid bone at rest (model units). */ restHeight: number; score: number; poses: PoseResult[]; samples: number; edges: number; arms: boolean; legs: boolean }

const q = (axis: 'x' | 'y' | 'z', deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), (deg * Math.PI) / 180);
const POSES: { name: string; bones: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>; still: (rest: THREE.Vector3, f: Frame) => boolean }[] = [
  { name: 'arms up', bones: { leftUpperArm: q('z', 70), rightUpperArm: q('z', -70) }, still: (p, f) => Math.abs(p.x - f.cx) < f.w * 0.1 && p.y < f.chestY },
  { name: 'arms down', bones: { leftUpperArm: q('z', -60), rightUpperArm: q('z', 60), leftLowerArm: q('y', 30), rightLowerArm: q('y', -30) }, still: (p, f) => p.y < f.hipsY },
  { name: 'head turn', bones: { head: q('y', 40), neck: q('y', 10) }, still: (p, f) => p.y < f.chestY },
  { name: 'lean', bones: { spine: q('z', 15), chest: q('z', 10) }, still: (p, f) => p.y < f.hipsY - f.h * 0.15 },
  { name: 'step', bones: { leftUpperLeg: q('x', -35), leftLowerLeg: q('x', 40) }, still: (p, f) => p.y > f.chestY },
];
interface Frame { cx: number; w: number; h: number; chestY: number; hipsY: number }

export function poseSweep(rt: AvatarRuntime, opts: { maxSamples?: number } = {}): RigScore | null {
  const hum = rt.humanoid ?? rt.vrm?.humanoid ?? null;
  if (!hum) return null;
  const meshes: THREE.SkinnedMesh[] = [];
  rt.model.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && !m.userData.vtpGenerated && !m.userData.vtpOutline && m.geometry.attributes.position) meshes.push(m); });
  if (!meshes.length) return null;
  const MAX = opts.maxSamples ?? 2500;
  const total = meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
  const stride = Math.max(1, Math.floor(total / MAX));
  const samples: { m: THREE.SkinnedMesh; i: number }[] = [];
  for (const m of meshes) for (let i = 0; i < m.geometry.attributes.position.count; i += stride) samples.push({ m, i });
  // edges: from the index buffers, every k-th triangle
  const edges: [number, number][] = [];
  const sampleIndex = new Map<string, number>();
  samples.forEach((s, k) => sampleIndex.set(`${s.m.id}:${s.i}`, k));
  const edgeVerts: { m: THREE.SkinnedMesh; a: number; b: number }[] = [];
  for (const m of meshes) {
    const idx = m.geometry.index;
    const n = idx ? idx.count : m.geometry.attributes.position.count;
    const triStride = Math.max(1, Math.floor(n / 3 / 1500)) * 3;
    for (let t = 0; t + 2 < n; t += triStride) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1;
      edgeVerts.push({ m, a, b });
    }
  }
  const saved = new Map<VRMHumanBoneName, THREE.Quaternion>();
  const names = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'] as VRMHumanBoneName[];
  const node = (b: VRMHumanBoneName) => { try { return hum.getNormalizedBoneNode(b); } catch { return null; } };
  for (const b of names) { const n = node(b); if (n) saved.set(b, n.quaternion.clone()); }
  const v = new THREE.Vector3();
  const pose = (bones: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>) => {
    for (const b of names) { const n = node(b); if (n) n.quaternion.identity(); }
    for (const [b, qq] of Object.entries(bones)) { const n = node(b as VRMHumanBoneName); if (n) n.quaternion.copy(qq!); }
    hum.update();
    rt.model.updateMatrixWorld(true);
    for (const m of meshes) m.skeleton.update();
  };
  const where = (m: THREE.SkinnedMesh, i: number, out: THREE.Vector3) => { m.getVertexPosition(i, out); return out.applyMatrix4(m.matrixWorld); };
  try {
    pose({});
    const rest = samples.map((s) => where(s.m, s.i, new THREE.Vector3()));
    const restEdge = edgeVerts.map((e) => where(e.m, e.a, v.clone()).distanceTo(where(e.m, e.b, new THREE.Vector3())));
    const box = new THREE.Box3().setFromPoints(rest);
    // the exact rest height from every vertex (the samples can miss the top of the head / the soles)
    const full = new THREE.Box3(), tmpV = new THREE.Vector3();
    for (const m of meshes) for (let i = 0; i < m.geometry.attributes.position.count; i++) full.expandByPoint(where(m, i, tmpV));
    // where two body parts touch at rest: sample pairs closer than 1.5 % of the height, mostly on different bones
    const Hh = box.max.y - box.min.y || 1;
    const main = samples.map((s) => {
      const si = s.m.geometry.attributes.skinIndex, sw = s.m.geometry.attributes.skinWeight;
      if (!si || !sw) return -1;
      let b = -1, w = -1;
      for (let k = 0; k < 4; k++) { const x = sw.getComponent(s.i, k); if (x > w) { w = x; b = si.getComponent(s.i, k); } }
      return (s.m.skeleton.bones[b]?.id ?? -1);
    });
    const cellSize = 0.015 * Hh, cells = new Map<string, number[]>();
    rest.forEach((p, k) => { const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)},${Math.floor(p.z / cellSize)}`; (cells.get(key) ?? cells.set(key, []).get(key)!).push(k); });
    const pairs: [number, number][] = [];
    for (const list of cells.values()) for (let a = 0; a < list.length && pairs.length < 4000; a++) for (let b = a + 1; b < list.length; b++) if (main[list[a]] !== main[list[b]]) { pairs.push([list[a], list[b]]); break; }
    const size = box.getSize(new THREE.Vector3());
    const at = (b: VRMHumanBoneName) => { const n = hum.getRawBoneNode(b); return n ? n.getWorldPosition(new THREE.Vector3()) : null; };
    const f: Frame = { cx: (box.min.x + box.max.x) / 2, w: size.x || 1, h: size.y || 1, chestY: at('chest')?.y ?? at('spine')?.y ?? box.min.y + size.y * 0.6, hipsY: at('hips')?.y ?? box.min.y + size.y * 0.5 };
    const results: PoseResult[] = [];
    for (const P of POSES) {
      if (!Object.keys(P.bones).some((b) => hum.getRawBoneNode(b as VRMHumanBoneName))) continue;
      pose(P.bones);
      let fly = 0, leak = 0, still = 0, tear = 0, stretch = 0, nEdge = 0, gap = 0;
      const now = samples.map((s2) => where(s2.m, s2.i, new THREE.Vector3()));
      for (const [a, b] of pairs) if (now[a].distanceTo(now[b]) > 0.04 * Hh) gap++;
      samples.forEach((s, k) => {
        const p = where(s.m, s.i, v);
        const d = p.distanceTo(rest[k]);
        if (!Number.isFinite(d) || d > f.h * 0.6) fly++;
        if (P.still(rest[k], f)) { still++; if (d > f.h * 0.04) leak++; }
      });
      edgeVerts.forEach((e, k) => {
        if (restEdge[k] < 1e-7) return;
        const l = where(e.m, e.a, v.clone()).distanceTo(where(e.m, e.b, new THREE.Vector3()));
        const r = l / restEdge[k];
        if (!(r < 2.2 && r > 0.35)) tear++;
        if (r > 0) { stretch += Math.min(3, Math.abs(Math.log(r))); nEdge++; }
      });
      results.push({ pose: P.name, tear: tear / Math.max(1, edgeVerts.length), fly: fly / Math.max(1, samples.length), leak: still ? leak / still : 0, stretch: nEdge ? stretch / nEdge : 0, gap: pairs.length ? gap / pairs.length : 0 });
    }
    const score = results.length ? results.reduce((a, r) => a + r.tear * 4 + r.fly * 10 + r.leak * 2 + r.stretch * 3 + r.gap * 10, 0) / results.length : 1;
    return { contacts: pairs.length, restHeight: (full.max.y - full.min.y) / (rt.model.getWorldScale(new THREE.Vector3()).y || 1), score, poses: results, samples: samples.length, edges: edgeVerts.length, arms: !!hum.getRawBoneNode('leftUpperArm') && !!hum.getRawBoneNode('rightUpperArm'), legs: !!hum.getRawBoneNode('leftUpperLeg') && !!hum.getRawBoneNode('rightUpperLeg') };
  } finally {
    for (const [b, qq] of saved) node(b)?.quaternion.copy(qq);
    hum.update();
    rt.model.updateMatrixWorld(true);
  }
}

/** Soft rig vs Blender autorig: which to keep. Blender wins unless it moves clearly worse (or lost arms / legs). */
export function pickRig(soft: RigScore | null, blender: RigScore | null, opts: { person?: boolean } = {}): { use: 'soft' | 'blender'; why: string } {
  if (!blender) return { use: 'soft', why: 'Blender’s skeleton could not be checked' };
  if (!soft) return { use: 'blender', why: 'the simple skeleton could not be checked' };
  // not a person (a creature, an object): extra limbs Blender guessed from the shape are no reason to switch
  if (opts.person === false) return blender.score <= soft.score * 1.15 + 0.005 ? { use: 'blender', why: `it moves cleanly (${blender.score.toFixed(3)} vs ${soft.score.toFixed(3)})` } : { use: 'soft', why: `the simple skeleton moved more cleanly (${soft.score.toFixed(3)} vs ${blender.score.toFixed(3)})` };
  if ((soft.arms && !blender.arms) || (soft.legs && !blender.legs)) return { use: 'soft', why: 'Blender’s skeleton has fewer limbs' };
  if ((blender.arms && !soft.arms) || (blender.legs && !soft.legs)) return blender.score < 0.5 ? { use: 'blender', why: 'Blender’s skeleton moves more of the body' } : { use: 'soft', why: 'Blender’s skeleton tears the mesh' };
  return blender.score <= soft.score * 1.15 + 0.005 ? { use: 'blender', why: `it moves cleanly (${blender.score.toFixed(3)} vs ${soft.score.toFixed(3)})` } : { use: 'soft', why: `the simple skeleton moved more cleanly (${soft.score.toFixed(3)} vs ${blender.score.toFixed(3)})` };
}

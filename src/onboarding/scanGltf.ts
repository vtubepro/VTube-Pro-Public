// Read a model's facts straight from its glTF / VRM JSON, without loading it: face-shape names, VRM expressions and
// humanoid bones, spring bones, triangles, textures, height. Used by the unit tests on the built-in sample models
// (tools/onboarding_unit.ts) and by the wizard as an instant first look before the 3D load finishes.
// Bones of plain GLBs go through the studio's own name mapper (src/avatar/humanoid.ts mapHumanoid), so the test sees
// exactly what the runtime sees. three.js math only (no DOM, no WebGL).
import * as THREE from 'three';
import { gltfStats } from '../../shared/modelStats.ts';
import { mapHumanoid } from '../avatar/humanoid.ts';
import { AUTO_CHAIN, JIGGLE_NAME } from '../avatar/physics.ts';
import type { ModelFacts } from './modelCheck.ts';

type J = Record<string, unknown>;
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface GltfScan {
  vrm: 0 | 1 | null;
  morphs: string[];
  vrmExpressions: string[];
  /** VRM humanoid bone names, or the names mapHumanoid finds on a plain GLB's joints. */
  bones: string[];
  rig: ModelFacts['rig'];
  springs: number;
  lookAt: boolean;
  triangles: number;
  textured: boolean;
  /** World-space height of all mesh bounds (model units), 0 = unknown. */
  height: number;
  /** Material names (for the robot guess). */
  materials: string[];
}

export function scanGltf(json: J): GltfScan {
  const ext = (json.extensions ?? {}) as J;
  const nodes = arr(json.nodes), meshes = arr(json.meshes), accessors = arr(json.accessors);
  // morph names: mesh.extras.targetNames (the glTF convention every exporter uses)
  const morphs = new Set<string>();
  for (const m of meshes) {
    const names = ((m.extras as J | undefined)?.targetNames ?? []) as unknown[];
    for (const n of names) if (typeof n === 'string') morphs.add(n);
  }
  let vrm: 0 | 1 | null = null, vrmExpressions: string[] = [], bones: string[] = [], springs = 0, lookAt = false;
  const v1 = ext.VRMC_vrm as J | undefined, v0 = ext.VRM as J | undefined;
  if (v1) {
    vrm = 1;
    const ex = (v1.expressions ?? {}) as J;
    vrmExpressions = [...Object.keys((ex.preset ?? {}) as J), ...Object.keys((ex.custom ?? {}) as J)];
    bones = Object.keys((((v1.humanoid ?? {}) as J).humanBones ?? {}) as J);
    lookAt = !!v1.lookAt || bones.includes('leftEye');
    const sb = ext.VRMC_springBone as J | undefined;
    for (const s of arr(sb?.springs)) springs += arr(s.joints).length;
  } else if (v0) {
    vrm = 0;
    vrmExpressions = arr(((v0.blendShapeMaster ?? {}) as J).blendShapeGroups).map((g) => String(g.presetName && g.presetName !== 'unknown' ? g.presetName : g.name ?? '')).filter(Boolean);
    bones = arr(((v0.humanoid ?? {}) as J).humanBones).map((b) => String(b.bone ?? '')).filter(Boolean);
    lookAt = !!(v0.firstPerson as J | undefined)?.lookAtTypeName || bones.includes('leftEye');
    // spring joints: every bone under each group's roots
    const kids = (i: number): number => 1 + arr(nodes[i]?.children).reduce((s: number, c) => s + kids(num(c as unknown, -1)), 0);
    for (const g of arr(((v0.secondaryAnimation ?? {}) as J).boneGroups)) for (const r of (g.bones as unknown[] ?? [])) if (typeof r === 'number' && nodes[r]) springs += kids(r);
  }
  // node tree (three.js objects with names + transforms), for the humanoid mapper and the height
  const objs = nodes.map((n, i) => {
    const isJoint = arr(json.skins).some((s) => (s.joints as unknown[] | undefined)?.includes(i));
    const o: THREE.Object3D = isJoint ? new THREE.Bone() : new THREE.Object3D();
    o.name = String(n.name ?? `node${i}`);
    if (Array.isArray(n.matrix)) new THREE.Matrix4().fromArray(n.matrix as number[]).decompose(o.position, o.quaternion, o.scale);
    else {
      if (Array.isArray(n.translation)) o.position.fromArray(n.translation as number[]);
      if (Array.isArray(n.rotation)) o.quaternion.fromArray(n.rotation as number[]);
      if (Array.isArray(n.scale)) o.scale.fromArray(n.scale as number[]);
    }
    return o;
  });
  const root = new THREE.Object3D();
  const hasParent = new Set<number>();
  nodes.forEach((n, i) => { for (const c of arr(n.children) as unknown as number[]) if (objs[c]) { objs[i].add(objs[c]); hasParent.add(c); } });
  objs.forEach((o, i) => { if (!hasParent.has(i)) root.add(o); });
  root.updateMatrixWorld(true);
  let rig: ModelFacts['rig'] = vrm !== null ? 'vrm' : 'none';
  if (vrm === null) {
    const map = mapHumanoid(root);
    bones = Object.keys(map);
    const anyJoint = objs.some((o) => (o as THREE.Bone).isBone);
    rig = map.hips && map.spine && map.head ? 'humanoid' : anyJoint ? 'soft' : 'none';
    // automatic spring chains: chain roots by name (the same test as src/avatar/physics.ts)
    const human = new Set(Object.values(map));
    root.traverse((o) => {
      if (!(o as THREE.Bone).isBone || human.has(o) || !AUTO_CHAIN.test(o.name) || JIGGLE_NAME.test(o.name)) return;
      let n = 0; o.traverse(() => n++);
      if (n > 1) springs += n;                                 // a joint swings only with a child bone below it
    });
  }
  // height: mesh POSITION bounds through the node transforms
  const box = new THREE.Box3();
  nodes.forEach((n, i) => {
    const mesh = typeof n.mesh === 'number' ? meshes[n.mesh] : undefined;
    for (const p of arr(mesh?.primitives)) {
      const a = accessors[num(((p.attributes ?? {}) as J).POSITION, -1)];
      if (!a || !Array.isArray(a.min) || !Array.isArray(a.max)) continue;
      const b = new THREE.Box3(new THREE.Vector3().fromArray(a.min as number[]), new THREE.Vector3().fromArray(a.max as number[]));
      // skinned meshes are drawn in bind space: their own node transform is ignored by glTF rules
      if (typeof n.skin !== 'number') b.applyMatrix4(objs[i].matrixWorld);
      box.union(b);
    }
  });
  const textured = arr(json.materials).some((m) => !!((m.pbrMetallicRoughness ?? {}) as J).baseColorTexture);
  return { vrm, morphs: [...morphs], vrmExpressions, bones, rig, springs, lookAt, triangles: gltfStats(json).tris, textured, height: box.isEmpty() ? 0 : box.max.y - box.min.y, materials: arr(json.materials).map((m) => String(m.name ?? '')).filter(Boolean) };
}

/** ModelFacts from a scan (+ what the profile says: robot, four legs, the face picks). */
export function factsFromScan(file: string, s: GltfScan, extra: { mechanical?: boolean; quadruped?: boolean; faceMap?: Record<string, string>; jaw?: boolean; drawnFace?: boolean } = {}): ModelFacts {
  return {
    file, rig: s.rig, bones: s.bones, arkit: 0, named: [], vrm: s.vrm !== null, triangles: s.triangles, height: s.height,
    morphs: s.morphs, vrmExpressions: s.vrmExpressions, lookAt: s.lookAt, springs: s.springs, textured: s.textured,
    mechanical: !!extra.mechanical, quadruped: !!extra.quadruped, faceMapCurrent: extra.faceMap, jaw: extra.jaw ?? s.bones.includes('jaw'), drawnFace: extra.drawnFace,
  };
}

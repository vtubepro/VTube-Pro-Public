// Costumes: GLBs whose skinned meshes are rigged to an armature with the SAME bone names and rest
// pose as the base avatar (plus optional extra bones — feathers, cane, sash tails — parented to base
// bones). Wearing one = rebinding its meshes onto the base skeleton, so tracking, springs, jiggle,
// toon and outlines all just work on the clothes too.
//
// Skinning note (three.js, AttachedBindMode): a vertex renders at
//   boneWorld · boneInverse · bindMatrix · position
// (the mesh's own matrixWorld cancels out). GLTFLoader binds every skin with bindMatrix = identity and
// boneInverses = the glTF inverseBindMatrices (joint world at bind time, in glTF scene space). Both the
// base and the costume are glTF roots, so as long as bone rest poses match, the costume's
// inverseBindMatrices are valid against the base bones — including any offset the runtime applied to
// the base root (grounding), because that offset is in boneWorld too. We still re-parent the mesh
// nodes under the matching base node (same local transform) so CPU-side code that reads
// mesh.matrixWorld (jiggle vertex search, bounds, outlines) sees the clothes where they render.

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CostumeDef, CostumeLabel } from '../../shared/types.ts';
import { fitCostumeSteps, type CostumeFit, type FitOptions } from './costumeFit.ts';
import { runSync, type Steps } from './loadSlicer.ts';

export interface AttachedCostume {
  def: CostumeDef;
  /** Every mesh that came with the costume (tagged userData.vtpCostume). */
  meshes: THREE.Mesh[];
  /** Costume-only bones now living in the base skeleton hierarchy. */
  extraBones: THREE.Bone[];
  /** Base meshes hidden while this costume is worn. */
  hidden: THREE.Object3D[];
  /** Label materials by material name. */
  labels: Map<string, LabelSurface>;
  /** Load-time anti-clip pass (push-out + hidden covered body); null if it failed / was skipped. */
  fit: CostumeFit | null;
  /** Repaint a label (by material or material name) — live, no rebuild. Returns false if unknown. */
  setLabelText(material: THREE.Material | string, text: string): boolean;
  dispose(): void;
}

interface LabelSurface {
  label: CostumeLabel;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  materials: THREE.Material[];
}

const sanitize = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n ?? '');
const namesOf = (o: THREE.Object3D) => {
  const s = new Set<string>();
  for (const n of [o.name, o.userData?.name as string | undefined]) if (n) { s.add(n); s.add(sanitize(n)); }
  return s;
};

/** Base node lookup by name: bones take priority, skipping three-vrm's normalized proxy rig. */
function indexBase(model: THREE.Object3D) {
  const bones = new Map<string, THREE.Bone>();
  const nodes = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    if (o.name.startsWith('Normalized_') || o.userData.vtpCostume) return;
    if ((o as THREE.Bone).isBone && !bones.has(o.name)) bones.set(o.name, o as THREE.Bone);
    if (o.name && !nodes.has(o.name)) nodes.set(o.name, o);
  });
  return { bones, nodes, find: (name: string) => bones.get(name) ?? nodes.get(name) ?? null };
}

/** Move `o` under `parent`, keeping its LOCAL transform (both sides share names + rest pose). */
function reparentKeepLocal(o: THREE.Object3D, parent: THREE.Object3D) {
  const { position, quaternion, scale } = o;
  const p = position.clone(), q = quaternion.clone(), s = scale.clone();
  parent.add(o); // Object3D.add removes it from the old parent
  o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s);
}

/** Move `o` under `parent` so its transform RELATIVE TO THE ROOT is preserved (costume root ↔ base model). */
function reparentRelativeToRoot(o: THREE.Object3D, costumeRoot: THREE.Object3D, parent: THREE.Object3D, baseRoot: THREE.Object3D) {
  costumeRoot.updateWorldMatrix(true, true);
  baseRoot.updateWorldMatrix(true, true);
  // o's transform in costume-root space
  const rel = costumeRoot.matrixWorld.clone().invert().multiply(o.matrixWorld);
  // the same transform in base-root space, then into the new parent's space
  const world = baseRoot.matrixWorld.clone().multiply(rel);
  const local = parent.matrixWorld.clone().invert().multiply(world);
  parent.add(o);
  local.decompose(o.position, o.quaternion, o.scale);
}

/**
 * `fit`: runtime context for the anti-clip pass (face keep-out spheres, humanoid anchors). The pass
 * always runs (def.fit tunes it); pass `false` to skip it entirely.
 */
export function attachCostume(model: THREE.Object3D, gltf: GLTF, def: CostumeDef, fit: FitOptions | false = {}): AttachedCostume {
  return runSync(attachCostumeSteps(model, gltf, def, fit));
}

/** attachCostume as steps (src/avatar/loadSlicer.ts: a model load in frame-sized slices; the fit's BVHs in a worker). */
export function* attachCostumeSteps(model: THREE.Object3D, gltf: GLTF, def: CostumeDef, fit: FitOptions | false = {}): Steps<AttachedCostume> {
  const root = gltf.scene;
  root.updateWorldMatrix(true, true);
  model.updateWorldMatrix(true, true);
  const base = indexBase(model);
  const warnings: string[] = [];

  // ---- 1. hide base meshes named in def.hides (and everything under a hidden node) ----
  const hidden: THREE.Object3D[] = [];
  if (def.hides?.length) {
    const want = new Set(def.hides.flatMap((n) => [n, sanitize(n)]));
    const hideTree = (o: THREE.Object3D) => o.traverse((c) => {
      if (!(c as THREE.Mesh).isMesh) return;
      c.visible = false;
      c.userData.vtpHidden = true;   // collectMeshes() skips it (no face patches on it)
      c.userData.vtpNoToon = true;   // applyToon() skips it (no orphan outline hull)
      hidden.push(c);
    });
    model.traverse((o) => { if (!o.userData.vtpHidden && [...namesOf(o)].some((n) => want.has(n))) hideTree(o); });
  }

  // ---- 2. costume bones: map to base bones by name; graft costume-only bones onto the base ----
  const costumeBones: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) costumeBones.push(o as THREE.Bone); });
  const boneMap = new Map<THREE.Bone, THREE.Bone>();
  for (const b of costumeBones) {
    const hit = base.bones.get(b.name);
    if (hit) boneMap.set(b, hit);
  }
  const extraBones: THREE.Bone[] = [];
  const isExtra = (o: THREE.Object3D | null): o is THREE.Bone => !!o && (o as THREE.Bone).isBone && !boneMap.has(o as THREE.Bone);
  for (const b of costumeBones) {
    if (boneMap.has(b)) continue;
    extraBones.push(b);
    b.userData.vtpCostume = true;
    if (isExtra(b.parent)) continue; // rides along with its (also grafted) costume-only parent
    const target = b.parent && b.parent !== root ? base.find(b.parent.name) : null;
    if (target) reparentKeepLocal(b, target);
    else {
      reparentRelativeToRoot(b, root, model, model);
      warnings.push(`costume bone '${b.name}' has no matching base parent — attached to the model root`);
    }
  }

  // ---- 3. meshes: tag, move the top-most content node under the matching base node ----
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const moved = new Set<THREE.Object3D>();
  // never move a node that holds costume bones (e.g. an "Armature" root): its mapped duplicates of
  // base bones must stay behind in the discarded costume scene
  const boneHolders = new Set<THREE.Object3D>();
  for (const b of boneMap.keys()) for (let p = b.parent; p && p !== root; p = p.parent) boneHolders.add(p);
  for (const m of meshes) {
    m.userData.vtpCostume = true;
    m.frustumCulled = false;
    // walk up until the parent is a base-named node, a grafted costume bone, or the root
    let top: THREE.Object3D = m;
    while (top.parent && top.parent !== root && !isExtra(top.parent) && !base.find(top.parent.name) && !boneHolders.has(top.parent)) top = top.parent;
    const parent = top.parent;
    if (moved.has(top) || !parent || isExtra(parent)) { moved.add(top); continue; }
    moved.add(top);
    top.traverse((c) => { if (!(c as THREE.Bone).isBone) c.userData.vtpCostume = true; });
    const target = parent !== root && !(parent as THREE.Bone).isBone ? base.find(parent.name) : parent !== root ? base.bones.get(parent.name) ?? null : null;
    if (target) reparentKeepLocal(top, target);
    else reparentRelativeToRoot(top, root, model, model);
  }

  // ---- 4. rebind skins onto the base skeleton (one new Skeleton per source skeleton) ----
  const skeletons = new Map<THREE.Skeleton, THREE.Skeleton>();
  for (const m of meshes) {
    const sm = m as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton) continue;
    let skel = skeletons.get(sm.skeleton);
    if (!skel) {
      const src = sm.skeleton;
      const bones = src.bones.map((b) => boneMap.get(b) ?? b);
      skel = new THREE.Skeleton(bones, src.boneInverses.map((mtx) => mtx.clone()));
      skeletons.set(src, skel);
    }
    sm.bind(skel, sm.bindMatrix); // GLTFLoader's bindMatrix (identity) — see header note
  }
  model.updateWorldMatrix(true, true);
  yield;

  // ---- 4b. fit: push clothes out of the body, hide body the clothes fully cover (rest pose) ----
  let fitted: CostumeFit | null = null;
  if (fit !== false) {
    // (a cancelled load ends the fit through its generator's return(): no catch block runs for that)
    const steps = fitCostumeSteps(model, meshes.filter((m) => m.geometry?.attributes.position), {
      ...fit, label: def.id, margin: def.fit?.margin ?? fit.margin, hideBody: def.fit?.hideBody ?? fit.hideBody,
    });
    try {
      let r = steps.next();
      while (!r.done) r = steps.next(yield r.value);
      fitted = r.value;
    } catch (e) { warnings.push(`fit pass failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // ---- 5. labels: text painted onto a material at runtime ----
  const labels = new Map<string, LabelSurface>();
  for (const label of def.labels ?? []) {
    const mats: THREE.Material[] = [];
    for (const m of meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat?.name === label.material && !mats.includes(mat)) mats.push(mat);
    if (!mats.length) { warnings.push(`label material '${label.material}' not found on the costume`); continue; }
    const aspect = label.aspect && label.aspect > 0 ? label.aspect : 4;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(aspect >= 1 ? 1024 : 1024 * aspect);
    canvas.height = Math.round(aspect >= 1 ? 1024 / aspect : 1024);
    canvas.width = Math.max(32, canvas.width); canvas.height = Math.max(32, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // glTF UVs have v = 0 at the image TOP (the exporter flips Blender's v), so like every glTF
    // texture this one must NOT be flipped: canvas row 0 ↔ v = 0 ↔ top of the label in Blender.
    texture.flipY = false;
    texture.anisotropy = 8;
    const surf: LabelSurface = { label: { ...label }, canvas, texture, materials: mats };
    drawLabel(surf, label.text);
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      std.map = texture;
      std.color?.set('#ffffff');
      std.needsUpdate = true;
    }
    labels.set(label.material, surf);
  }
  for (const w of warnings) console.warn(`[costume ${def.id}] ${w}`);

  return {
    def, meshes, extraBones, hidden, labels, fit: fitted,
    setLabelText(material, text) {
      const name = typeof material === 'string' ? material : material.name;
      const s = labels.get(name);
      if (!s) return false;
      s.label.text = text;
      drawLabel(s, text);
      return true;
    },
    dispose() {
      fitted?.restore();
      for (const s of labels.values()) s.texture.dispose();
      labels.clear();
    },
  };
}

/** Paint text centred on the label canvas, auto-fitting the font to the area (multi-line via \n). */
function drawLabel(s: LabelSurface, text: string) {
  const { canvas, label } = s;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = label.background ?? '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const lines = String(text ?? '').replace(/\\n/g, '\n').split('\n');
  const pad = Math.min(W, H) * 0.12;
  const availW = W - pad * 2, availH = H - pad * 2;
  const font = label.font?.trim() || "800 system-ui, 'Segoe UI', Arial, sans-serif";
  // font may be "900 Impact" (weight + family) or just a family
  const fm = /^\s*(\d{3}|bold|normal)\s+(.+)$/i.exec(font);
  const [weight, family] = fm ? [fm[1], fm[2]] : ['800', font];
  const lineGap = 1.12;
  let size = availH / (lines.length * lineGap);
  const setFont = (px: number) => { ctx.font = `${weight} ${px}px ${family}`; };
  setFont(size);
  const widest = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  if (widest > availW) size *= availW / widest;
  size = Math.max(6, Math.floor(size));
  setFont(size);
  ctx.fillStyle = label.color ?? '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const total = size * lineGap * lines.length;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 - total / 2 + size * lineGap * (i + 0.5)));
  s.texture.needsUpdate = true;
}

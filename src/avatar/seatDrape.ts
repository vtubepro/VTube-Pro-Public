// Seated modesty drape: a performer in a skirt or dress who sits down must never show what is under it.
//
// Why it is needed: the seated pose (src/scene/actor.ts applySeat) swings the thighs horizontal. A skirt is skinned to
// the hips and thighs (VRoid: J_Sec_*_Skirt* bones hang off the upper legs), so its front lifts onto the lap and the
// gap between the thighs opens to every camera that looks down at a sitter (talk / group / wide / tile cams).
//
// What it does: when the avatar wears a skirt / dress (detected geometrically by src/avatar/skirtDetect.ts: one surface
// wrapping both legs below the crotch, skinned to the lower body), a thin cloth drape is shown while seated: it lies
// over both thighs from the hips to the skirt's own length, spans the gap between them (sagging a little, like real
// fabric across a lap) and falls over the front edge — down to the floor side of the knees for a long dress, a short
// valance between the knees for a short skirt. It uses the skirt's own material (same toon shading / colour, UVs taken
// from the skirt's front panel) and is rebuilt every frame from the current bones, so it follows the seated legs,
// knee splay, leaning and sit / stand transitions. Standing or walking it is hidden. Nothing about the avatar files
// changes: every avatar — built-in, imported, a guest's — gets it automatically.
import * as THREE from 'three';
import type { VRMHumanBoneName, VRMHumanoid } from '@pixiv/three-vrm';
import { fullIndex } from './lod/fullIndex.ts';
import { applyUvMap, coversLegs, detectSkirt, drapePlan, fitUvMap, legAxes, thighRadius, type LegFrame, type UvMap, type UvSample, type V3 } from './skirtDetect.ts';

/** What the drape needs to know about one avatar (+ its worn costume), measured once in bind space. */
export interface DrapeInfo {
  /** The skirt surface the drape copies (material / layers / shadows). */
  source: THREE.Mesh;
  /** Thigh radius as a fraction of the thigh length (scale-free). */
  thighR: number;
  /** Lap cover (fraction of the thigh length past the thigh roots) and fall past the knees (fraction of the thigh). */
  lap: number;
  fall: number;
  /** The skirt's front hem (thigh lengths below the thigh roots, standing). */
  hem: number;
  /** The skirt's texture mapping around its front panel (side / down in thigh lengths). */
  uv: UvMap;
  /** Distance between the thigh roots, in thigh lengths (the UV template's cross-section). */
  hipW: number;
  /** Per-surface verdicts (debug: vtpOut). */
  notes: string[];
}

const LEG_BONES = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const;

/** The surface material of a mesh (skips MToon / toon outline passes). */
export function surfaceMaterial(m: THREE.Mesh): THREE.Material | null {
  const list = Array.isArray(m.material) ? m.material : [m.material];
  for (const x of list) {
    if (!x) continue;
    if ((x as unknown as { isOutline?: boolean }).isOutline || x.name === 'vtp-outline') continue;
    return x;
  }
  return null;
}

function visibleInTree(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * Measure the avatar for the drape. `model` is the runtime's model root, `front` the avatar's facing in world space
 * (the anchor's +Z). Returns null when there is nothing to cover (no skirt, no humanoid legs).
 */
export function analyzeDrape(model: THREE.Object3D, humanoid: VRMHumanoid | null, front: THREE.Vector3, notesOut: string[] = []): DrapeInfo | null {
  if (!humanoid) { notesOut.push('no humanoid'); return null; }
  const raw: Partial<Record<(typeof LEG_BONES)[number], THREE.Object3D>> = {};
  for (const b of LEG_BONES) { const n = humanoid.getRawBoneNode(b as VRMHumanBoneName); if (!n) { notesOut.push(`no ${b} bone`); return null; } raw[b] = n; }
  const human = new Set<THREE.Object3D>();
  for (const name of Object.keys(humanoid.humanBones)) { const n = humanoid.getRawBoneNode(name as VRMHumanBoneName); if (n) human.add(n); }
  // lower-body class of a bone: 1 = left thigh subtree, 2 = right thigh subtree, 3 = hips (or extra bones hanging off
  // the hips: skirt / tail chains), 0 = anything else (spine, arms, head)
  const cls = new Map<THREE.Object3D, number>();
  const classOf = (b: THREE.Object3D): number => {
    let c = cls.get(b);
    if (c !== undefined) return c;
    c = 0;
    for (let p: THREE.Object3D | null = b; p; p = p.parent) {
      if (p === raw.leftUpperLeg) { c = 1; break; }
      if (p === raw.rightUpperLeg) { c = 2; break; }
      if (human.has(p)) { c = p === raw.hips ? 3 : 0; break; }
    }
    cls.set(b, c);
    return c;
  };

  model.updateWorldMatrix(true, true);
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton || o.userData.vtpHidden || o.userData.vtpDrape) return;
    if (!m.geometry?.attributes?.position || !m.geometry.attributes.skinIndex || !m.geometry.attributes.skinWeight) return;
    if (!visibleInTree(m, model)) return;
    meshes.push(m);
  });
  // the reference bind space: the first skeleton that holds the hips and both legs
  let refSk: THREE.Skeleton | null = null;
  for (const m of meshes) if (LEG_BONES.every((b) => m.skeleton.bones.includes(raw[b] as THREE.Bone))) { refSk = m.skeleton; break; }
  if (!refSk) { notesOut.push('no skeleton holds the hips + legs'); return null; }
  const refInv = (b: THREE.Object3D) => refSk!.boneInverses[refSk!.bones.indexOf(b as THREE.Bone)];
  const bindPos = (b: THREE.Object3D): V3 => { const p = new THREE.Vector3().setFromMatrixPosition(refInv(b).clone().invert()); return [p.x, p.y, p.z]; };
  // the avatar's front, in the reference bind space (via the hips: bind → world = hipsWorld · inverse bind)
  const hipsBindToWorld = raw.hips!.matrixWorld.clone().multiply(refInv(raw.hips!));
  const fB = front.clone().transformDirection(hipsBindToWorld.clone().invert());
  const frame: LegFrame = { hipL: bindPos(raw.leftUpperLeg!), hipR: bindPos(raw.rightUpperLeg!), kneeL: bindPos(raw.leftLowerLeg!), kneeR: bindPos(raw.rightLowerLeg!), front: [fB.x, fB.y, fB.z] };

  // every surface in the reference bind space (a costume has its own inverse binds: map through a shared bone)
  interface Surf { mesh: THREE.SkinnedMesh; pos: Float32Array; lower: Uint8Array; side: Uint8Array; name: string; index: ArrayLike<number> | null }
  const surfs: Surf[] = [];
  const MAX = 60000;
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const sk = m.skeleton;
    let shared = -1;
    for (const b of [raw.hips!, raw.leftUpperLeg!, raw.rightUpperLeg!, ...sk.bones]) { const i = sk.bones.indexOf(b as THREE.Bone); if (i >= 0 && refSk.bones.includes(b as THREE.Bone)) { shared = i; break; } }
    if (shared < 0) continue;
    // p_ref = inverse(refInv(X)) · inv_mesh(X) · bindMatrix · p
    const toRef = refInv(sk.bones[shared]).clone().invert().multiply(sk.boneInverses[shared]).multiply(m.bindMatrix);
    const g = m.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    const step = Math.max(1, Math.ceil(P.count / MAX));
    const n = Math.ceil(P.count / step);
    const pos = new Float32Array(n * 3), lower = new Uint8Array(n), side = new Uint8Array(n);
    for (let k = 0, i = 0; i < P.count; i += step, k++) {
      v.fromBufferAttribute(P, i).applyMatrix4(toRef);
      pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
      let best = -1, bw = 0;
      for (let j = 0; j < 4; j++) { const w = SW.getComponent(i, j); if (w > bw) { bw = w; best = SI.getComponent(i, j); } }
      const bone = best >= 0 ? sk.bones[best] : null;
      const c = bone ? classOf(bone) : 0;
      lower[k] = c ? 1 : 0;
      // thigh-radius samples: skinned to a thigh itself (not a skirt bone under it)
      side[k] = bone === raw.leftUpperLeg ? 1 : bone === raw.rightUpperLeg ? 2 : 0;
    }
    const mat = surfaceMaterial(m);
    // (decimated: the index is only usable when every vertex was kept)
    const full = fullIndex(g);   // (the full triangle list, whatever Avatar detail level is drawn)
    const index = step === 1 && full ? full.array : null;
    surfs.push({ mesh: m, pos, lower, side, name: `${m.name} ${mat?.name ?? ''}`, index });
  }
  // thigh radius: the innermost layer's (each surface measured on its own, the smallest wins — the body or tights, not
  // a hoodie / skirt skinned to the thighs over it); pass 1 over everything, then again without the skirts
  const radiusOf = (list: Surf[]) => {
    let best = 0;
    for (const s of list) { const r = thighRadius(frame, s.pos, s.side, 30); if (r > 0 && (!best || r < best)) best = r; }
    return best;
  };
  const L = (Math.hypot(frame.kneeL[0] - frame.hipL[0], frame.kneeL[1] - frame.hipL[1], frame.kneeL[2] - frame.hipL[2])
    + Math.hypot(frame.kneeR[0] - frame.hipR[0], frame.kneeR[1] - frame.hipR[1], frame.kneeR[2] - frame.hipR[2])) / 2;
  if (!(L > 0)) return null;
  const judge = (r: number) => surfs.map((s) => ({ s, v: detectSkirt({ ...frame, positions: s.pos, lower: s.lower, thighR: r, name: s.name, index: s.index }) }));
  let r = radiusOf(surfs);
  let verdicts = judge(r);
  const body = surfs.filter((_, i) => !verdicts[i].v.skirt);
  if (body.length && body.length < surfs.length) { const r2 = radiusOf(body); if (r2 > 0) { r = r2; verdicts = judge(r); } }
  const skirts = verdicts.filter((x) => x.v.skirt);
  const notes = verdicts.map((x) => `${x.s.name.trim()}: ${x.v.skirt ? 'SKIRT' : 'no'} (${x.v.why})`);
  notesOut.push(`thigh r ${(r / L).toFixed(3)} L, front ${frame.front.map((x) => x.toFixed(2))}, hipL ${frame.hipL.map((x) => x.toFixed(2))}`, ...notes);
  if (!skirts.length) return null;
  // trousers / leggings under it: the lap is covered whatever the skirt does
  for (const x of verdicts) {
    if (x.v.skirt) continue;
    const c = coversLegs({ ...frame, positions: x.s.pos, lower: x.s.lower, thighR: r, name: x.s.name });
    if (c.covers) { notesOut.push(`legs covered by ${x.s.name.trim()}: ${c.why} → no drape`); return null; }
    if (!/^(skin|mostly upper)/.test(c.why)) notesOut.push(`${x.s.name.trim()} under it: ${c.why}`);
  }
  // the longest skirt is what lies on the lap (a hoodie or a vest that ends at the hips does not)
  skirts.sort((a, b) => b.v.hem - a.v.hem);
  const top = skirts[0];
  const plan = drapePlan(top.v.hem);
  // UVs: the skirt's front panel below the crotch (a narrow percentile window: one UV island, its colour / pattern)
  // UVs: fitted on the skirt's front below the crotch, around its most typical front-panel texel
  let uv: UvMap = { u: [0.5, 0, 0], v: [0.5, 0, 0], box: [0.5, 0.5, 0.5, 0.5] };
  const UV = top.s.mesh.geometry.attributes.uv;
  const ax = legAxes(frame);
  if (UV && top.v.sample.length) {
    const step = Math.max(1, Math.ceil(top.s.mesh.geometry.attributes.position.count / MAX));
    const k0 = top.v.sample[0] * step;
    const center: [number, number] = [UV.getX(Math.min(UV.count - 1, k0)), UV.getY(Math.min(UV.count - 1, k0))];
    const pts: UvSample[] = [];
    const P = top.s.pos;
    for (let k = 0; k < P.length / 3; k++) {
      const i = k * step;
      if (i >= UV.count || !top.s.lower[k]) continue;
      const q = [P[k * 3] - ax.mid[0], P[k * 3 + 1] - ax.mid[1], P[k * 3 + 2] - ax.mid[2]];
      const dn = q[0] * ax.down[0] + q[1] * ax.down[1] + q[2] * ax.down[2];
      const sd = q[0] * ax.side[0] + q[1] * ax.side[1] + q[2] * ax.side[2];
      const fw = q[0] * ax.fwd[0] + q[1] * ax.fwd[1] + q[2] * ax.fwd[2];
      if (fw <= 0 || Math.abs(sd) > ax.w * 1.2 || dn < 0 || dn > Math.max(top.v.hem, 0.3) * L) continue;
      pts.push({ sd: sd / L, dn: dn / L, u: UV.getX(i), v: UV.getY(i) });
    }
    uv = fitUvMap(pts, center);
  }
  const thighR = THREE.MathUtils.clamp((r > 0 ? r : L * 0.17) / L, 0.09, 0.3);
  return { source: top.s.mesh, thighR, lap: plan.lap, fall: plan.fall, hem: top.v.hem, uv, hipW: ax.w / L, notes };
}

// ---- the drape mesh ----

/** Cross-section around the two thighs, avatar-right outer edge → avatar-left outer edge. Angles from the outward
 *  side toward the top (deg); the bridge spans the gap between the inner tops. */
const ARC = [-30, -5, 20, 45, 70, 92, 112];
const BRIDGE = 4;      // inner points across the gap
const LAP_ROWS = 9;    // rows over the lap
const FALL_ROWS = 4;   // rows of the front fall

export class SeatDrape {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly cols = ARC.length * 2 + BRIDGE;
  private readonly rows = LAP_ROWS + FALL_ROWS + 1;
  private readonly pos: Float32Array;
  private readonly bones: Record<(typeof LEG_BONES)[number] | 'spine', THREE.Object3D | null>;

  constructor(readonly info: DrapeInfo, humanoid: VRMHumanoid) {
    const n = this.cols * this.rows;
    // two layers (front + back faces) so the drape reads from below as well, whatever the material's side
    this.pos = new Float32Array(n * 2 * 3);
    // UVs from a template of the drape in thigh-length units: columns by their side offset across the lap (a section
    // at mid-lap), rows by how far down the skirt they are (along the lap, then down the fall)
    const uv = new Float32Array(n * 2 * 2);
    const sdCols = templateColumns(info.thighR, info.hipW);
    // (texture scale 1:1, aligned so the drape's bottom edge is the skirt's hem: trims / hem bands land on the edge,
    // the rest shows the skirt's body fabric — a short skirt's longer drape repeats its top texels, never the hem)
    const fallLen = info.fall > 0 ? info.fall + info.thighR : info.thighR * 1.5;
    const pathEnd = info.lap + fallLen;
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const i = r * this.cols + c;
      const path = r <= LAP_ROWS ? info.lap * (r / LAP_ROWS) : info.lap + fallLen * ((r - LAP_ROWS) / FALL_ROWS);
      const dn = info.hem - (pathEnd - path);
      const [u, vv] = applyUvMap(info.uv, sdCols[c], dn);
      uv[i * 2] = u; uv[i * 2 + 1] = vv; uv[(n + i) * 2] = u; uv[(n + i) * 2 + 1] = vv;
    }
    const idx: number[] = [];
    for (let r = 0; r < this.rows - 1; r++) for (let c = 0; c < this.cols - 1; c++) {
      const a = r * this.cols + c, b = a + 1, d = a + this.cols, e = d + 1;
      idx.push(a, d, b, b, d, e);                       // outer layer (normals away from the legs)
      idx.push(n + a, n + b, n + d, n + b, n + e, n + d); // inner layer (reversed)
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    const src = info.source;
    this.mesh = new THREE.Mesh(this.geo, surfaceMaterial(src) ?? new THREE.MeshBasicMaterial({ color: 0x333344 }));
    this.mesh.name = 'vtp-seat-drape';
    this.mesh.userData.vtpDrape = true;
    this.mesh.userData.vtpNoToon = true;
    this.mesh.frustumCulled = false;
    // (no shadow casting: the two coincident layers would shadow each other — acne / a dark drape)
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = src.receiveShadow;
    this.mesh.layers.mask = src.layers.mask;
    this.mesh.visible = false;
    const g = (b: string) => humanoid.getRawBoneNode(b as VRMHumanBoneName);
    this.bones = { hips: g('hips'), leftUpperLeg: g('leftUpperLeg'), rightUpperLeg: g('rightUpperLeg'), leftLowerLeg: g('leftLowerLeg'), rightLowerLeg: g('rightLowerLeg'), spine: g('spine') };
    // rebuilt right before it is drawn: the bones' world matrices are final by then (after tracking, seat, springs)
    this.mesh.onBeforeRender = () => this.build();
  }

  /** Per frame (before rendering): visibility + the skirt's current material (looks / costumes can swap it). */
  sync(show: boolean) {
    const src = this.info.source;
    const vis = show && visibleTo(src);
    this.mesh.visible = vis;
    if (vis) {
      const m = surfaceMaterial(src);
      if (m && this.mesh.material !== m) this.mesh.material = m;
      this.mesh.layers.mask = src.layers.mask;
      if (!this.built) { this.mesh.updateWorldMatrix(true, false); this.build(); }
    }
  }

  private readonly t = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), h: new THREE.Vector3(), s: new THREE.Vector3() };
  private lastBuild = -1;
  private built = false;
  /** The bone + mesh positions the cloth was last built from: unchanged (under 0.2 mm) = the same cloth, no rebuild. */
  private readonly sig = new Float64Array(18 + 16);

  /** Rebuild the cloth from the current bones (world space → the mesh's local space). */
  build() {
    const now = performance.now();
    if (Math.abs(now - this.lastBuild) < 2) return; // several cameras in one frame: once is enough
    this.lastBuild = now;
    const B = this.bones;
    if (!B.hips || !B.leftUpperLeg || !B.rightUpperLeg || !B.leftLowerLeg || !B.rightLowerLeg) return;
    const T = this.t;
    const hipL = B.leftUpperLeg.getWorldPosition(T.a), hipR = B.rightUpperLeg.getWorldPosition(T.b);
    const kneeL = B.leftLowerLeg.getWorldPosition(T.c), kneeR = B.rightLowerLeg.getWorldPosition(T.d);
    const hips = B.hips.getWorldPosition(T.h);
    // a still lap (the usual case: the legs are seated, only the upper body moves) keeps last frame's cloth — this
    // rebuild was ~100 allocations and a normal pass every frame
    {
      const S = this.sig, mw = this.mesh.matrixWorld.elements;
      const sp = B.spine ? B.spine.getWorldPosition(T.s) : null;
      let same = this.built, k = 0;
      const chk = (v: number) => { if (same && Math.abs(S[k] - v) > 2e-4) same = false; S[k++] = v; };
      for (const p of [hipL, hipR, kneeL, kneeR, hips]) { chk(p.x); chk(p.y); chk(p.z); }
      if (sp) { chk(sp.x); chk(sp.y); chk(sp.z); } else k += 3;
      for (let i = 0; i < 16; i++) chk(mw[i]);
      if (same) return;
    }
    const dL = kneeL.clone().sub(hipL), dR = kneeR.clone().sub(hipR);
    const L = (dL.length() + dR.length()) / 2;
    if (!(L > 1e-5)) return;
    const F = dL.clone().normalize().add(dR.clone().normalize()).normalize();
    // the sitter's up: hips → spine (leans with the body); never closer than ~25° to the thighs
    const upW = B.spine ? B.spine.getWorldPosition(T.s).sub(hips) : new THREE.Vector3(0, 1, 0);
    if (upW.lengthSq() < 1e-10) upW.set(0, 1, 0);
    upW.normalize();
    const R0 = this.info.thighR * L;
    const cloth = R0 * 0.14;
    const { lap, fall } = this.info;
    const toLocal = this.mesh.matrixWorld.clone().invert();
    // world gravity (the room's down) for the fall
    const gDown = new THREE.Vector3(0, -1, 0);
    const P = this.pos, n = this.cols * this.rows;
    const put = (r: number, c: number, p: THREE.Vector3) => {
      const q = p.clone().applyMatrix4(toLocal), i = (r * this.cols + c) * 3, j = (n + r * this.cols + c) * 3;
      P[i] = q.x; P[i + 1] = q.y; P[i + 2] = q.z; P[j] = q.x; P[j + 1] = q.y; P[j + 2] = q.z;
    };
    // one cross-section at fraction t of the thigh (negative = behind the thigh roots, inside the hips)
    const section = (t: number, grow: number) => {
      const cL = hipL.clone().addScaledVector(dL, t), cR = hipR.clone().addScaledVector(dR, t);
      const X = cL.clone().sub(cR); X.addScaledVector(F, -X.dot(F)).normalize();
      const U = upW.clone().addScaledVector(F, -upW.dot(F)).addScaledVector(X, -upW.dot(X));
      if (U.lengthSq() < 1e-8) U.crossVectors(F, X); // (thighs straight up the spine: degenerate, pick any normal)
      U.normalize();
      if (U.dot(upW) < 0) U.negate();
      const rr = R0 * (1.1 - 0.22 * THREE.MathUtils.clamp(t, 0, 1)) + cloth + grow;
      const out: THREE.Vector3[] = [];
      const arc = (c: THREE.Vector3, outward: THREE.Vector3, deg: number) =>
        c.clone().addScaledVector(outward, Math.cos(THREE.MathUtils.degToRad(deg)) * rr).addScaledVector(U, Math.sin(THREE.MathUtils.degToRad(deg)) * rr);
      const nX = X.clone().negate();
      for (const a of ARC) out.push(arc(cR, nX, a));                // avatar-right thigh, outer → inner top
      const pR = out[out.length - 1], pL = arc(cL, X, ARC[ARC.length - 1]);
      // across the gap: over the crotch the cloth bulges up a little (covers the lap's front), further out it sags
      const gap = pR.distanceTo(pL), k0 = THREE.MathUtils.smoothstep(t, 0.05, 0.35);
      const sag = THREE.MathUtils.lerp(-rr * 0.35, Math.min(gap * 0.28, rr * 0.45), k0);
      for (let k = 1; k <= BRIDGE; k++) {
        const s = k / (BRIDGE + 1);
        out.push(pR.clone().lerp(pL, s).addScaledVector(U, -sag * 4 * s * (1 - s)));
      }
      for (let k = ARC.length - 1; k >= 0; k--) out.push(arc(cL, X, ARC[k])); // avatar-left thigh, inner top → outer
      return { pts: out, U };
    };
    // the lap: from inside the hips (t = -0.2) to the skirt's length
    let last: { pts: THREE.Vector3[]; U: THREE.Vector3 } | null = null;
    for (let r = 0; r <= LAP_ROWS; r++) {
      const t = -0.2 + (lap + 0.2) * (r / LAP_ROWS);
      // the root rows swell a little so the drape tucks into the skirt's waist instead of under it
      const grow = R0 * 0.3 * Math.max(0, 1 - (t + 0.2) / 0.4);
      last = section(t, grow);
      for (let c = 0; c < this.cols; c++) put(r, c, last.pts[c]);
    }
    // the fall over the front edge: a long dress hangs toward the floor; a short skirt's front edge droops between
    // the knees (a valance deep enough to close the view under the lap) and only a little over the thighs
    const edge = last!;
    for (let r = 1; r <= FALL_ROWS; r++) {
      const s = r / FALL_ROWS;
      for (let c = 0; c < this.cols; c++) {
        const inGap = c >= ARC.length - 1 && c <= ARC.length + BRIDGE;
        const depth = fall > 0 ? (fall * L + R0) * (inGap ? 1.05 : 1) : inGap ? R0 * 2.1 : R0 * 0.45;
        const dir = gDown.clone().addScaledVector(F, 0.18 * (1 - s)).normalize();
        const p = edge.pts[c].clone().addScaledVector(dir, depth * s).addScaledVector(F, R0 * 0.12 * Math.sin(Math.PI * s));
        put(LAP_ROWS + r, c, p);
      }
    }
    const attr = this.geo.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.built = true;
    this.geo.computeVertexNormals();
    // a lap faces the ceiling, but performers are lit (and filmed) from the front: shade the drape like the skirt's
    // front panel above it (normals mostly toward the front) instead of dropping it into the toon shade colour
    const N = this.geo.attributes.normal as THREE.BufferAttribute, nv = new THREE.Vector3();
    const lF = F.clone().transformDirection(toLocal), lU = upW.clone().transformDirection(toLocal);
    for (let i = 0; i < N.count; i++) {
      nv.fromBufferAttribute(N, i);
      const s = nv.dot(lU) >= 0 ? 1 : -1;
      nv.multiplyScalar(0.4).addScaledVector(lF, s).normalize();
      N.setXYZ(i, nv.x, nv.y, nv.z);
    }
    N.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
  }
}

/** Side offsets (thigh lengths, avatar-left +) of the drape's columns on a mid-lap cross-section. */
function templateColumns(thighR: number, hipW: number): number[] {
  const rr = thighR * 1.1, cL = hipW / 2, cR = -hipW / 2, out: number[] = [];
  const x = (c: number, sign: number, deg: number) => c + sign * Math.cos(THREE.MathUtils.degToRad(deg)) * rr;
  for (const a of ARC) out.push(x(cR, -1, a));
  const pR = out[out.length - 1], pL = x(cL, 1, ARC[ARC.length - 1]);
  for (let k = 1; k <= BRIDGE; k++) out.push(pR + (pL - pR) * (k / (BRIDGE + 1)));
  for (let k = ARC.length - 1; k >= 0; k--) out.push(x(cL, 1, ARC[k]));
  return out;
}

function visibleTo(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

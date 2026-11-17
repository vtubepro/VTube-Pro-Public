// Ship crew: the assets (<room>/npc/crew_units.glb: UNIT_<name> + _LOD1 / _LOD2 on the 20-bone NPC
// skeleton + Jaw / HeadTop puppet-mouth bones, ONE toon atlas, a fur mask in COLOR_0.r, held props PROP_<id> rigid on
// their bone (extras.bone, .tip); crew_anims.json + crew_anims_ual.json: int16 quaternion clips, town_anims format)
// and one crew member on screen. The town NPC sampler (src/scene/town/townUnits.ts) extended for the crew: clips are
// mapped by bone NAME (two files with their own bone order), upper-body-only overlays (ear flinch, hit), a three-way
// blend for the gun-laying pose, a per-crew fur hue (shader, shared program), props on any bone (hand, Gun socket,
// HeadTop hats), a puppet jaw flap while a bubble is up, LOD0/1/2 with the ink outline at LOD0 only.
import * as THREE from 'three';
import { skipMatricesWhileHidden } from '../hiddenSkip.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface CrewClip { name: string; dur: number; loop: boolean; frames: number; fps: number; upper: boolean; q: (Float32Array | null)[]; p: (Float32Array | null)[] }
export interface CrewProp { id: string; geo: THREE.BufferGeometry; bone: string; offset: THREE.Matrix4; tip: THREE.Vector3 | null; hat: boolean; loose: boolean }

type AnimJson = { fps: number; bones: string[]; qscale: number; pscale: number; cycle?: Record<string, number>;
  clips: Record<string, { dur: number; loop: boolean; frames: number; q: Record<string, string>; p: Record<string, string>; prop?: string | null; upper?: boolean }> };

/** bones an upper-body overlay may move (the legs + hips keep the base clip: no foot sliding) */
const UPPER = new Set(['Spine', 'Chest', 'Neck', 'Head', 'Shoulder_L', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'Shoulder_R', 'UpperArm_R', 'LowerArm_R', 'Hand_R', 'Gun']);

function decode(b64: string, scale: number): Float32Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / scale;
  }
  return out;
}

let inkMat: THREE.MeshBasicMaterial | null = null;
function inkMaterial() {
  if (inkMat) return inkMat;
  inkMat = new THREE.MeshBasicMaterial({ color: 0x0d0b0a, side: THREE.BackSide });
  inkMat.name = 'vtp:crew:ink';
  inkMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += normalize(objectNormal) * 0.011;'); };
  return inkMat;
}
let ramp: THREE.DataTexture | null = null;
function toonRamp() {
  if (ramp) return ramp;
  const d = new Uint8Array([120, 120, 132, 255, 200, 200, 212, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export class CrewAssets {
  private static pending = new Map<string, Promise<CrewAssets>>();
  private static refs = new Map<string, number>();
  private static timers = new Map<string, ReturnType<typeof setTimeout>>();
  static keyOf(unitsUrl: string, animsUrls: string[]) { return unitsUrl + '|' + animsUrls.join('|'); }
  /** A room uses these assets (cancels a pending disposal). */
  static retain(key: string) {
    CrewAssets.refs.set(key, (CrewAssets.refs.get(key) ?? 0) + 1);
    const t = CrewAssets.timers.get(key);
    if (t) { clearTimeout(t); CrewAssets.timers.delete(key); }
  }
  /** A room let go: with no user left the assets are disposed after `ms` (back to the room in time -> no reload). */
  static release(key: string, ms = 5 * 60e3) {
    const n = Math.max(0, (CrewAssets.refs.get(key) ?? 0) - 1);
    CrewAssets.refs.set(key, n);
    if (n > 0 || CrewAssets.timers.has(key)) return;
    CrewAssets.timers.set(key, setTimeout(() => {
      CrewAssets.timers.delete(key);
      if ((CrewAssets.refs.get(key) ?? 0) > 0) return;
      const p = CrewAssets.pending.get(key);
      CrewAssets.pending.delete(key); CrewAssets.refs.delete(key);
      p?.then((a) => a.dispose()).catch(() => { /* never loaded */ });
    }, ms));
  }
  static load(unitsUrl: string, animsUrls: string[]): Promise<CrewAssets> {
    const key = CrewAssets.keyOf(unitsUrl, animsUrls);
    let p = CrewAssets.pending.get(key);
    if (!p) {
      p = (async () => {
        const [gltf, ...anims] = await Promise.all([new GLTFLoader().loadAsync(unitsUrl), ...animsUrls.map((u, i) => fetch(u).then((r) => {
          if (!r.ok) { if (i === 0) throw new Error(`crew anims ${r.status}`); return null; }
          return r.json() as Promise<AnimJson>;
        }).catch((e) => { if (i === 0) throw e; return null; }))]);
        const a = new CrewAssets(gltf.scene);
        for (const x of anims) if (x) a.addClips(x);
        return a;
      })();
      p.catch(() => CrewAssets.pending.delete(key));
      CrewAssets.pending.set(key, p);
    }
    return p;
  }

  readonly template: THREE.Object3D;
  readonly props = new Map<string, CrewProp>();
  readonly clips = new Map<string, CrewClip>();
  readonly boneNames: string[] = [];
  readonly atlas: THREE.Texture | null;
  /** fur top above the feet (m, model units) */
  readonly furTop: number;

  constructor(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    let atlas: THREE.Texture | null = null;
    const bones = new Map<string, THREE.Object3D>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !atlas) atlas = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null;
      if ((o as THREE.Bone).isBone) bones.set(o.name, o);
    });
    this.atlas = atlas;
    if (this.atlas) { (this.atlas as THREE.Texture).colorSpace = THREE.SRGBColorSpace; (this.atlas as THREE.Texture).anisotropy = 4; }
    const all: THREE.Object3D[] = [];
    scene.traverse((o) => all.push(o));
    const tmp = new THREE.Matrix4();
    for (const o of all) {
      const m = /^PROP_([a-z0-9_]+)$/.exec(o.name);
      if (!m || !(o as THREE.Mesh).isMesh) continue;
      const ud = o.userData as Record<string, unknown>;
      const bn = typeof ud.bone === 'string' ? ud.bone : 'Hand_R';
      const bone = bones.get(bn) ?? null;
      const offset = bone ? tmp.copy(bone.matrixWorld).invert().multiply(o.matrixWorld).clone() : o.matrixWorld.clone();
      const tip = Array.isArray(ud.tip) && ud.tip.length === 3 ? new THREE.Vector3(...(ud.tip as [number, number, number])) : null;
      this.props.set(m[1], { id: m[1], geo: (o as THREE.Mesh).geometry, bone: bn, offset, tip, hat: !!ud.hat, loose: !!ud.loose || !bone });
    }
    // the fur mask: COLOR_0.r -> a float attribute the hue shader reads (geometry is shared by every clone)
    let top = 0;
    scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      const g = sm.geometry;
      const c = g.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (c && !g.getAttribute('furMask')) {
        const f = new Float32Array(c.count);
        for (let i = 0; i < c.count; i++) f[i] = c.getX(i);
        g.setAttribute('furMask', new THREE.BufferAttribute(f, 1));
        g.deleteAttribute('color');
      }
      if (/_LOD\d$/.test(o.name)) return;
      // the fur top in the bind pose (the snorkel tube sticks out above it): the crew's `height` is measured to it
      const pos = g.getAttribute('position') as THREE.BufferAttribute, fm = g.getAttribute('furMask') as THREE.BufferAttribute | undefined;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) if (!fm || fm.getX(i) > 0.5) { v.fromBufferAttribute(pos, i).applyMatrix4(sm.bindMatrix).applyMatrix4(sm.matrixWorld); if (v.y > top) top = v.y; }
    });
    this.furTop = top > 0.3 && top < 5 ? top : 1.223;
    const drop: THREE.Object3D[] = [];
    scene.traverse((o) => { if (/^PROP_/.test(o.name)) drop.push(o); });
    for (const o of drop) o.removeFromParent();
    this.template = scene;
  }

  /** Free the GPU side (geometry, the atlas, the template's own materials). Clones must be gone first. */
  dispose() {
    const mats = new Set<THREE.Material>();
    this.template.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (mt) mats.add(mt);
    });
    for (const mt of mats) mt.dispose();
    for (const p of this.props.values()) p.geo.dispose();
    this.atlas?.dispose();
  }

  /** Clips from a town_anims-format file, mapped by bone name (the first file fixes the bone order). */
  addClips(anims: AnimJson) {
    const names = anims.bones.map((b) => b.replace(/[.\s]/g, ''));
    if (!this.boneNames.length) this.boneNames.push(...names);
    const idx = this.boneNames.map((b) => names.indexOf(b));
    for (const [name, c] of Object.entries(anims.clips)) {
      if (this.clips.has(name)) continue;
      this.clips.set(name, {
        name, dur: c.dur, loop: c.loop, frames: c.frames, fps: anims.fps, upper: !!c.upper,
        q: idx.map((j) => (j >= 0 && c.q[anims.bones[j]] ? decode(c.q[anims.bones[j]], anims.qscale) : null)),
        p: idx.map((j) => (j >= 0 && c.p[anims.bones[j]] ? decode(c.p[anims.bones[j]], anims.pscale) : null)),
      });
    }
  }
}

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion(), qt = new THREE.Quaternion();
const va = new THREE.Vector3(), vb = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);

function frameAt(c: CrewClip, t: number) {
  const n = c.frames;
  let f = t * c.fps;
  let i0: number, i1: number;
  if (c.loop) { f = ((f % n) + n) % n; i0 = Math.floor(f); i1 = (i0 + 1) % n; } else { f = Math.max(0, Math.min(n - 1, f)); i0 = Math.floor(f); i1 = Math.min(n - 1, i0 + 1); }
  return [i0, i1, f - i0] as const;
}
function sampleQ(c: CrewClip, bone: number, t: number, out: THREE.Quaternion) {
  const q = c.q[bone];
  if (!q) return out.set(0, 0, 0, 1);
  const [i0, i1, a] = frameAt(c, t);
  out.set(q[i0 * 4], q[i0 * 4 + 1], q[i0 * 4 + 2], q[i0 * 4 + 3]);
  if (a > 1e-4) {
    qt.set(q[i1 * 4], q[i1 * 4 + 1], q[i1 * 4 + 2], q[i1 * 4 + 3]);
    if (out.dot(qt) < 0) qt.set(-qt.x, -qt.y, -qt.z, -qt.w);
    out.set(out.x + (qt.x - out.x) * a, out.y + (qt.y - out.y) * a, out.z + (qt.z - out.z) * a, out.w + (qt.w - out.w) * a);
  }
  return out.normalize();
}
function sampleP(c: CrewClip, bone: number, t: number, out: THREE.Vector3) {
  const p = c.p[bone];
  if (!p) return out.set(0, 0, 0);
  const [i0, i1, a] = frameAt(c, t);
  return out.set(p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * a, p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * a, p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * a);
}

/** One layer of a pose: a clip at a time with a weight. */
export interface Layer { clip: CrewClip; t: number; w: number }

/** One crew member on screen. */
export class CrewNpc {
  readonly root = skipMatricesWhileHidden(new THREE.Group());   // (faded / culled = no matrix work: src/scene/hiddenSkip.ts)
  readonly meshes: (THREE.SkinnedMesh | null)[] = [null, null, null];
  readonly mat: THREE.MeshToonMaterial;
  readonly ink: THREE.SkinnedMesh;
  lod = 0;
  opacity = 1;
  private bones: (THREE.Bone | null)[];
  private restQ: THREE.Quaternion[];
  private restP: THREE.Vector3[];
  private byName = new Map<string, THREE.Bone>();
  private jaw: THREE.Bone | null; private top: THREE.Bone | null;
  private jawRest = new THREE.Quaternion(); private topRest = new THREE.Quaternion();
  private propMeshes = new Map<string, THREE.Mesh>();
  private inkOn = true;
  private hue = { value: 0 };
  private tint = { value: new THREE.Color(1, 1, 1) };
  private upperMask: boolean[];
  readonly headI: number;

  constructor(readonly assets: CrewAssets, parent: THREE.Object3D, hueDeg = 0, tint?: string) {
    const obj = skClone(assets.template);
    obj.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      const k = /_LOD2$/.test(o.name) ? 2 : /_LOD1$/.test(o.name) ? 1 : 0;
      this.meshes[k] = sm;
    });
    if (!this.meshes[0]) throw new Error('crew_units.glb: no UNIT_ mesh');
    this.mat = new THREE.MeshToonMaterial({ map: assets.atlas, gradientMap: toonRamp() });
    this.mat.name = 'vtp:crew:npc';
    this.mat.userData.vtpVariants = { fade: true, unskinned: true };   // (fades; held props use it: programKeep.ts)
    this.hue.value = (hueDeg * Math.PI) / 180;
    if (tint) { try { this.tint.value.set(tint); } catch { /* bad colour: white */ } }
    const hue = this.hue, tintU = this.tint;
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uHue = hue;
      sh.uniforms.uTint = tintU;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float furMask;\nvarying float vFur;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFur = furMask;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uHue;
uniform vec3 uTint;
varying float vFur;
vec3 crewHue(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}`).replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, max(crewHue(diffuseColor.rgb, uHue), 0.0), vFur * step(0.001, abs(uHue)));\n  diffuseColor.rgb *= mix(vec3(1.0), uTint, vFur);');
    };
    this.mat.customProgramCacheKey = () => 'vtp-crew-hue';
    for (const m of this.meshes) if (m) { m.material = this.mat; m.frustumCulled = false; m.castShadow = false; }
    this.meshes[1] && (this.meshes[1].visible = false);
    this.meshes[2] && (this.meshes[2].visible = false);
    const m0 = this.meshes[0]!;
    this.ink = new THREE.SkinnedMesh(m0.geometry, inkMaterial());
    this.ink.bind(m0.skeleton, m0.bindMatrix);
    this.ink.frustumCulled = false;
    this.ink.name = 'vtp:crew:ink';
    m0.parent?.add(this.ink);
    // (a skinned mesh's first sorted frame skins every vertex on the CPU for its bounding sphere - ~3 ms per clone; the
    // crew is never frustum-culled, the sphere only orders the draws: the bind pose's will do)
    for (const sm of [...this.meshes, this.ink]) if (sm) { const g = sm.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); sm.boundingSphere = g.boundingSphere!.clone(); }
    this.root.add(obj);
    this.root.name = 'vtp:crew:npc';
    obj.traverse((o) => { if ((o as THREE.Bone).isBone) this.byName.set(o.name, o as THREE.Bone); });
    this.bones = assets.boneNames.map((n) => this.byName.get(n) ?? null);
    this.restQ = this.bones.map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion()));
    this.restP = this.bones.map((b) => (b ? b.position.clone() : new THREE.Vector3()));
    this.upperMask = assets.boneNames.map((n) => UPPER.has(n));
    this.headI = assets.boneNames.indexOf('Head');
    this.jaw = this.byName.get('Jaw') ?? null;
    this.top = this.byName.get('HeadTop') ?? null;
    if (this.jaw) this.jawRest.copy(this.jaw.quaternion);
    if (this.top) this.topRest.copy(this.top.quaternion);
    parent.add(this.root);
  }

  setHue(deg: number) { this.hue.value = (deg * Math.PI) / 180; }

  /** 0 = full, 1 = ~4k, 2 = ~0.7k, 3 = hidden (same skeleton: switching is free) */
  setLod(l: number) {
    let want = l;
    if (want === 2 && !this.meshes[2]) want = this.meshes[1] ? 1 : 0;
    if (want === 1 && !this.meshes[1]) want = 0;
    if (want === this.lod) return;
    this.lod = want;
    for (let k = 0; k < 3; k++) if (this.meshes[k]) this.meshes[k]!.visible = k === want;
    this.ink.visible = want === 0 && this.inkOn && this.opacity > 0.98;
    for (const m of this.propMeshes.values()) if (want === 3) m.visible = false;
  }
  setInk(on: boolean) { this.inkOn = on; this.ink.visible = on && this.lod === 0 && this.opacity > 0.98; }

  /** Show exactly these props (held prop + hat). */
  setProps(ids: (string | null | undefined)[]) {
    const want = new Set(ids.filter((x): x is string => !!x));
    for (const [k, m] of this.propMeshes) m.visible = want.has(k) && this.lod < 3;
    for (const id of want) {
      if (this.propMeshes.has(id)) continue;
      const p = this.assets.props.get(id);
      if (!p || p.loose) continue;
      const bone = this.byName.get(p.bone);
      if (!bone) continue;
      const m = new THREE.Mesh(p.geo, this.mat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(p.offset);
      m.frustumCulled = false;
      m.name = `vtp:crew:prop:${id}`;
      bone.add(m);
      this.propMeshes.set(id, m);
    }
  }

  /** The world position of a held prop's business end (torch nozzle, hammer face), or null. */
  propTip(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const m = this.propMeshes.get(id), p = this.assets.props.get(id);
    if (!m || !p?.tip || !m.visible) return null;
    m.updateWorldMatrix(true, false);
    return out.copy(p.tip).applyMatrix4(m.matrixWorld);
  }

  /** Pose: a weighted base stack (weights sum to ~1, the first is the anchor) + an optional upper-body overlay. */
  pose(base: Layer[], over: Layer | null) {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      const bn = this.bones[i];
      if (!bn) continue;
      const L0 = base[0];
      sampleQ(L0.clip, i, L0.t, qa);
      let acc = L0.w;
      for (let k = 1; k < base.length; k++) {
        const L = base[k];
        if (L.w < 0.001) continue;
        sampleQ(L.clip, i, L.t, qb);
        if (qb.dot(qa) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w);
        acc += L.w;
        qa.slerp(qb, L.w / acc);
      }
      if (over && over.w > 0.001 && this.upperMask[i] && over.clip.q[i]) {
        sampleQ(over.clip, i, over.t, qc);
        if (qc.dot(qa) < 0) qc.set(-qc.x, -qc.y, -qc.z, -qc.w);
        qa.slerp(qc, over.w);
      }
      bn.quaternion.copy(this.restQ[i]).multiply(qa);
      if (L0.clip.p[i] || base.some((L) => L.clip.p[i])) {
        sampleP(L0.clip, i, L0.t, va);
        let accP = L0.w;
        for (let k = 1; k < base.length; k++) {
          const L = base[k];
          if (L.w < 0.001 || !L.clip.p[i]) continue;
          sampleP(L.clip, i, L.t, vb);
          accP += L.w;
          va.lerp(vb, L.w / accP);
        }
        if (over && over.w > 0.001 && this.upperMask[i] && over.clip.p[i]) { sampleP(over.clip, i, over.t, vb); va.lerp(vb, over.w); }
        bn.position.copy(this.restP[i]).add(va.applyQuaternion(this.restQ[i]));
      }
    }
  }

  /** Puppet mouth: 0 = shut, 1 = wide (the jaw drops, the top of the head tips back). */
  mouth(open: number) {
    // (checked in the app: about the bones' local X, a NEGATIVE angle drops the jaw and a positive one tips the top
    // of the head back - the builtin's puppet rig: jaw 12 deg, upper head 24 deg)
    const a = THREE.MathUtils.degToRad(13) * open;
    if (this.jaw) this.jaw.quaternion.copy(this.jawRest).multiply(qb.setFromAxisAngle(AX, -a));
    if (this.top) this.top.quaternion.copy(this.topRest).multiply(qb.setFromAxisAngle(AX, a * 1.5));
  }

  headWorld(out: THREE.Vector3) {
    const b = this.bones[this.headI];
    if (!b) return out.copy(this.root.position).setY(this.root.position.y + 1.0 * this.root.scale.y);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }
  /** The puppet head's hinge (HeadTop bone: the base of the upper head, the mouth line); the fur top is ~0.33 m (model
   *  units) above it. Falls back to the head joint. */
  headTopWorld(out: THREE.Vector3) {
    const b = this.top;
    if (!b) return this.headWorld(out);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  setOpacity(o: number) {
    this.opacity = o;
    const t = o < 0.999;
    if (this.mat.transparent !== t) { this.mat.transparent = t; this.mat.needsUpdate = true; }
    this.mat.opacity = o;
    this.mat.depthWrite = o > 0.5;
    this.ink.visible = this.lod === 0 && o > 0.98 && this.inkOn;
    this.root.visible = o > 0.01 && this.lod < 3;
  }

  dispose() {
    this.root.removeFromParent(); this.mat.dispose();
    for (const m of this.propMeshes.values()) m.removeFromParent();
    // (each clone owns its skeleton: its bone texture must go with it - the 2026-10-04 dispose-leak lesson)
    const sk = new Set<THREE.Skeleton>();
    for (const m of this.meshes) if (m?.skeleton) sk.add(m.skeleton);
    for (const k of sk) k.dispose();
  }
}

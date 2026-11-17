// Mass crowd (src/scene/crowd): a dense dancing crowd drawn as GPU instances with baked vertex animation.
//
// An ACTIVITY_xx with `activity: "dancefloor"` (extras rx / rz = the ellipse, frogs = count, outfits) becomes one
// CrowdMass: the room's crowd unit (the same rigged GLB the other activities use) is skinned ONCE per clip frame on the
// CPU when the room loads (time-sliced, ≤ ~4 ms a frame) into a vertex-animation texture per part (body LOD1, face,
// each outfit): rows = clip frames, columns = vertices, positions + normals as half floats. Every dancer is then one
// instance per part (a few draw calls for the whole crowd, no skeletons, no mixers); the vertex shader reads its frame
// by gl_VertexID and blends two frames. Clips run on the BEAT (the page's beat clock → the show's music, else a steady
// 120 BPM), so the whole floor bounces in time. Choices are pure functions of (seed, dancer, phrase, beat events), so
// every OBS page shows the same crowd. Other systems steer dancers with `override` (dance-off rings, crowd-surf hands,
// a drop's synchronised jump) and hide ones that would cover a performer's face (`shield`).
import * as THREE from 'three';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CrowdAsset } from './crowdUnits';
import { hash32, rng } from './crowdPlan';

/** Clips the mass crowd can play (in the unit): beats per cycle (0 = plays in seconds). */
export const MASS_CLIPS: Record<string, number> = { dance: 2, jump: 2, handsup: 2, headbang: 1, fistpump: 2, shuffle: 2, sway: 4, cheer: 2, clap: 1, idle: 0 };
const FRAMES = 12;

export interface MassOpts {
  center: THREE.Vector3; rx: number; rz: number; count: number; outfits: string[]; seed: number; height: number;
  /** where they face (the stage), root space */
  face: THREE.Vector3;
  /** keep-out circles (root space xz + radius) no dancer stands in */
  keepOut?: { x: number; z: number; r: number }[];
}
export interface MassOverride { clip?: string; yaw?: number; dx?: number; dz?: number; dy?: number; hide?: boolean; phase?: number; sec?: boolean }
export interface MassFrame {
  /** wall seconds, continuous beat position (NaN = no grid), 0..1 energy, seconds since the last drop, since the last support cheer */
  t: number; beat: number; energy: number; dropAge: number; cheerAge: number; party: boolean;
  override?: (i: number) => MassOverride | null;
}
export interface Dancer { i: number; home: THREE.Vector3; pos: THREE.Vector3; yaw: number; outfit: number; clip: string; hidden: boolean; shield: boolean }

interface Part { name: string; geo: THREE.BufferGeometry; src: THREE.SkinnedMesh | THREE.Mesh; mesh: THREE.InstancedMesh | null; tex: THREE.DataTexture | null; data: Uint16Array | null; verts: number; who: number[] }

const TV = new THREE.Vector3(), TN = new THREE.Vector3(), M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);

export class CrowdMass {
  readonly group = new THREE.Group();
  readonly dancers: Dancer[] = [];
  private parts: Part[] = [];
  private clips: string[] = [];
  private bake: { model: THREE.Object3D; mixer: THREE.AnimationMixer; ci: number; f: number; skinned: Map<string, THREE.SkinnedMesh | THREE.Mesh> } | null = null;
  private anim: THREE.InstancedBufferAttribute[] = [];
  private uni = { uBeat: { value: 0 }, uSec: { value: 0 } };
  ready = false;
  cost = 0;

  constructor(private asset: CrowdAsset, private o: MassOpts) {
    this.group.name = 'crowd:mass';
    this.clips = Object.keys(MASS_CLIPS).filter((c) => asset.clips.has(c));
    if (!this.clips.length) this.clips = ['idle'];
    // ---- dancers: a jittered hex grid inside the ellipse, outside the keep-outs, deterministic
    const r = rng(hash32(o.seed, 'mass'));
    const want = Math.max(1, Math.min(96, o.count));
    const area = Math.PI * o.rx * o.rz;
    let step = Math.sqrt(area / want) * 0.93;
    const pts: THREE.Vector3[] = [];
    for (let tries = 0; tries < 6 && pts.length < want; tries++, step *= 0.92) {
      pts.length = 0;
      for (let z = -o.rz; z <= o.rz; z += step * 0.87) {
        const row = Math.round(z / (step * 0.87));
        for (let x = -o.rx + (row & 1 ? step / 2 : 0); x <= o.rx; x += step) {
          const jx = x + (r() - 0.5) * step * 0.45, jz = z + (r() - 0.5) * step * 0.4;
          if ((jx * jx) / (o.rx * o.rx) + (jz * jz) / (o.rz * o.rz) > 1) continue;
          const wx = o.center.x + jx, wz = o.center.z + jz;
          if (o.keepOut?.some((k) => (wx - k.x) ** 2 + (wz - k.z) ** 2 < k.r * k.r)) continue;
          pts.push(new THREE.Vector3(wx, o.center.y, wz));
        }
      }
    }
    // keep a spread-out subset of exactly `want`
    const r2 = rng(hash32(o.seed, 'pick'));
    while (pts.length > want) pts.splice(Math.floor(r2() * pts.length), 1);
    const outfits = o.outfits.filter((k) => asset.outfits.includes(k));
    pts.forEach((p, i) => {
      const rr = rng(hash32(o.seed, 'd', i));
      const yaw = Math.atan2(o.face.x - p.x, o.face.z - p.z) + (rr() - 0.5) * 0.9;
      const outfit = rr() < 0.18 || !outfits.length ? -1 : Math.floor(rr() * outfits.length);
      this.dancers.push({ i, home: p.clone(), pos: p.clone(), yaw, outfit, clip: 'dance', hidden: false, shield: false });
    });
    // ---- parts: body LOD1 (else body), face, outfits in use
    const pick = (n: string) => asset.scene.getObjectByName(n) as THREE.Mesh | undefined;
    const body = pick('Frog_Body_LOD1') ?? pick('Frog_Body');
    const add = (name: string, m: THREE.Mesh | undefined, who: number[]) => {
      if (!m || !who.length) return;
      const src = firstMesh(m);
      if (!src) return;
      this.parts.push({ name, geo: src.geometry as THREE.BufferGeometry, src, mesh: null, tex: null, data: null, verts: (src.geometry as THREE.BufferGeometry).attributes.position.count, who });
    };
    const all = this.dancers.map((d) => d.i);
    add('body', body, all);
    add('face', pick('Frog_Face'), all);
    outfits.forEach((k, oi) => add('outfit:' + k, pick('OUTFIT_' + k), this.dancers.filter((d) => d.outfit === oi).map((d) => d.i)));
  }

  /** Bake a slice (≤ budget ms). Returns true when every part is baked and the instances exist. */
  bakeStep(budget = 4): boolean {
    if (this.ready) return true;
    const t0 = performance.now();
    if (!this.bake) {
      const model = skClone(this.asset.scene);
      model.updateMatrixWorld(true);
      const skinned = new Map<string, THREE.SkinnedMesh | THREE.Mesh>();
      for (const p of this.parts) {
        let hit: THREE.Mesh | null = null;
        model.traverse((o) => { if (!hit && (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry === p.geo) hit = o as THREE.Mesh; });
        if (hit) skinned.set(p.name, hit);
        const rows = this.clips.length * FRAMES;
        p.data = new Uint16Array(p.verts * rows * 2 * 4);
      }
      this.bake = { model, mixer: new THREE.AnimationMixer(model), ci: 0, f: 0, skinned };
    }
    const b = this.bake;
    const rows = this.clips.length * FRAMES;
    const inv = new THREE.Matrix4();
    const tmpM = new THREE.Matrix4(), bM = new THREE.Matrix4();
    const e = new Float32Array(16);
    while (b.ci < this.clips.length) {
      const name = this.clips[b.ci];
      const clip = this.asset.clips.get(name)!;
      b.mixer.stopAllAction();
      const act = b.mixer.clipAction(clip); act.play(); act.enabled = true; act.weight = 1;
      const loop = MASS_CLIPS[name] !== undefined;
      b.mixer.setTime(0);
      act.time = (b.f / (loop ? FRAMES : FRAMES - 1)) * clip.duration * (loop ? 1 : 0.999);
      b.mixer.update(0);
      b.model.updateMatrixWorld(true);
      inv.copy(b.model.matrixWorld).invert();
      const row = b.ci * FRAMES + b.f;
      for (const p of this.parts) {
        const m = b.skinned.get(p.name); if (!m || !p.data) continue;
        const pos = (m.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
        const nor = (m.geometry as THREE.BufferGeometry).attributes.normal as THREE.BufferAttribute | undefined;
        const sk = (m as THREE.SkinnedMesh).isSkinnedMesh ? (m as THREE.SkinnedMesh) : null;
        if (sk) sk.skeleton.update();
        const si = sk ? (sk.geometry.attributes.skinIndex as THREE.BufferAttribute) : null, sw = sk ? (sk.geometry.attributes.skinWeight as THREE.BufferAttribute) : null;
        const world = tmpM.multiplyMatrices(inv, m.matrixWorld);
        // per bone once per frame: world × bindInverse × bone × bind (then a vertex only blends ≤ 4 of them)
        const nb = sk ? sk.skeleton.bones.length : 0;
        const full = sk ? new Float32Array(nb * 16) : null;
        if (sk && full && sk.skeleton.boneMatrices) for (let b = 0; b < nb; b++) { bM.fromArray(sk.skeleton.boneMatrices as Float32Array, b * 16).premultiply(sk.bindMatrixInverse).multiply(sk.bindMatrix).premultiply(world); bM.toArray(full, b * 16); }
        const wE = world.elements;
        for (let v = 0; v < p.verts; v++) {
          TV.fromBufferAttribute(pos, v);
          if (nor) TN.fromBufferAttribute(nor, v); else TN.set(0, 1, 0);
          if (sk && si && sw && full) {
            e.fill(0);
            for (let k = 0; k < 4; k++) {
              const w = sw.getComponent(v, k); if (w <= 0) continue;
              const bi = si.getComponent(v, k) * 16;
              for (let q = 0; q < 16; q++) e[q] += full[bi + q] * w;
            }
          } else e.set(wE);
          const x = TV.x, y = TV.y, z = TV.z, nx = TN.x, ny = TN.y, nz = TN.z;
          TV.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
          TN.set(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz).normalize();
          const oP = ((row * p.verts) + v) * 4, oN = (((rows + row) * p.verts) + v) * 4;
          const d = p.data;
          d[oP] = THREE.DataUtils.toHalfFloat(TV.x); d[oP + 1] = THREE.DataUtils.toHalfFloat(TV.y); d[oP + 2] = THREE.DataUtils.toHalfFloat(TV.z); d[oP + 3] = 15360;
          d[oN] = THREE.DataUtils.toHalfFloat(TN.x); d[oN + 1] = THREE.DataUtils.toHalfFloat(TN.y); d[oN + 2] = THREE.DataUtils.toHalfFloat(TN.z); d[oN + 3] = 15360;
        }
      }
      b.f++;
      if (b.f >= FRAMES) { b.f = 0; b.ci++; }
      if (performance.now() - t0 > budget) return false;
    }
    this.build(rows);
    b.mixer.stopAllAction();
    this.bake = null;
    this.ready = true;
    return true;
  }

  private build(rows: number) {
    const tint = ['#ffffff', '#e4ffd6', '#fff3c9', '#d8f0ff', '#f0ffe8', '#e8ffd0', '#fffbe0', '#e0fff4'].map((h) => new THREE.Color(h));
    for (const p of this.parts) {
      const tex = new THREE.DataTexture(p.data!, p.verts, rows * 2, THREE.RGBAFormat, THREE.HalfFloatType);
      tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
      p.tex = tex; p.data = null;
      const g = new THREE.BufferGeometry();
      g.setIndex(p.geo.index);
      g.setAttribute('position', p.geo.attributes.position);
      if (p.geo.attributes.normal) g.setAttribute('normal', p.geo.attributes.normal);
      if (p.geo.attributes.color) g.setAttribute('color', p.geo.attributes.color);
      if (p.geo.attributes.uv) g.setAttribute('uv', p.geo.attributes.uv);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      const src = (Array.isArray(p.src.material) ? p.src.material[0] : p.src.material) as THREE.Material;
      const mat = src.clone() as THREE.MeshToonMaterial;
      const uni = { uVat: { value: tex }, uRows: { value: rows }, uFrames: { value: FRAMES }, uBeat: this.uni.uBeat, uSec: this.uni.uSec };
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uni);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
uniform sampler2D uVat; uniform float uRows; uniform float uFrames; uniform float uBeat; uniform float uSec;
attribute vec4 aAnim;
vec3 vatAt(int r) { return texelFetch(uVat, ivec2(gl_VertexID, r), 0).xyz; }`)
          .replace('#include <beginnormal_vertex>', `float vT = mix(uBeat, uSec, aAnim.w);
float vC = fract(vT * aAnim.z + aAnim.y) * uFrames;
int vF0 = int(floor(vC)); int vF1 = vF0 + 1; if (vF1 >= int(uFrames)) vF1 = 0;
float vK = fract(vC); int vB = int(aAnim.x + 0.5); int vR = int(uRows + 0.5);
vec3 vatP = mix(vatAt(vB + vF0), vatAt(vB + vF1), vK);
vec3 objectNormal = normalize(mix(vatAt(vR + vB + vF0), vatAt(vR + vB + vF1), vK));
#ifdef USE_TANGENT
vec3 objectTangent = vec3( tangent.xyz );
#endif`)
          .replace('#include <begin_vertex>', 'vec3 transformed = vatP;');
      };
      mat.customProgramCacheKey = () => 'crowdMassVAT';
      const n = p.who.length;
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.name = 'crowd:mass:' + p.name;
      mesh.frustumCulled = false;
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aAnim', a);
      this.anim.push(a);
      if (p.name === 'body') p.who.forEach((di, k) => mesh.setColorAt(k, tint[hash32('t', di) % tint.length]));
      p.mesh = mesh;
      this.group.add(mesh);
    }
    this.clipRow = new Map(this.clips.map((c, i) => [c, i * FRAMES]));
  }
  private clipRow = new Map<string, number>();

  private choose(d: Dancer, f: MassFrame): { clip: string; phase: number; sec: boolean } {
    const beat = Number.isFinite(f.beat) ? f.beat : f.t * 2;
    const phrase = Math.floor(beat / 16);
    const r = rng(hash32(this.o.seed, d.i, phrase));
    if (f.cheerAge >= 0 && f.cheerAge < 3.4) return { clip: (hash32(d.i, Math.floor(f.t - f.cheerAge)) % 3) ? 'cheer' : 'clap', phase: r() * 0.2, sec: false };
    if (f.dropAge >= 0 && f.dropAge < 7) return { clip: f.dropAge < 4.5 ? 'jump' : 'handsup', phase: 0, sec: false };
    const e = f.party ? Math.max(0.55, f.energy) : f.energy;
    const table: [string, number][] = e < 0.35
      ? [['sway', 30], ['dance', 25], ['clap', 8], ['idle', 15], ['handsup', 6], ['shuffle', 6]]
      : e < 0.7
        ? [['dance', 25], ['fistpump', 15], ['shuffle', 15], ['handsup', 14], ['headbang', 10], ['sway', 10], ['jump', 6], ['clap', 5]]
        : [['jump', 24], ['fistpump', 20], ['handsup', 20], ['headbang', 15], ['shuffle', 11], ['dance', 10]];
    let tot = 0; for (const [, w] of table) tot += w;
    let x = r() * tot, clip = table[0][0];
    for (const [c, w] of table) { if ((x -= w) <= 0) { clip = c; break; } }
    return { clip, phase: clip === 'sway' || clip === 'idle' ? r() : r() * 0.08, sec: false };
  }

  update(f: MassFrame) {
    if (!this.ready) return;
    const t0 = performance.now();
    const beat = Number.isFinite(f.beat) ? f.beat : f.t * 2;
    this.uni.uBeat.value = beat; this.uni.uSec.value = f.t;
    const scl = this.o.height / this.asset.height;
    for (const p of this.parts) {
      const mesh = p.mesh!; const a = mesh.geometry.getAttribute('aAnim') as THREE.InstancedBufferAttribute;
      const arr = a.array as Float32Array;
      for (let k = 0; k < p.who.length; k++) {
        const d = this.dancers[p.who[k]];
        if (p.name === 'body') {        // decide once per dancer (the body part lists everyone, first)
          const ov = f.override?.(d.i) ?? null;
          const ch = this.choose(d, f);
          const clip = ov?.clip && this.clipRow.has(ov.clip) ? ov.clip : this.clipRow.has(ch.clip) ? ch.clip : this.clips[0];
          d.clip = clip;
          (d as Dancer & { ph?: number; sec?: boolean }).ph = ov?.phase ?? ch.phase;
          (d as Dancer & { sec?: boolean }).sec = !!ov?.sec || MASS_CLIPS[clip] === 0;
          d.pos.copy(d.home); if (ov) { d.pos.x += ov.dx ?? 0; d.pos.z += ov.dz ?? 0; d.pos.y += ov.dy ?? 0; }
          (d as Dancer & { yawNow?: number }).yawNow = ov?.yaw ?? d.yaw;
          d.hidden = !!ov?.hide;
        }
        const dd = d as Dancer & { ph?: number; sec?: boolean; yawNow?: number };
        const bpc = MASS_CLIPS[d.clip] || 2;
        arr[k * 4] = this.clipRow.get(d.clip) ?? 0;
        arr[k * 4 + 1] = dd.ph ?? 0;
        arr[k * 4 + 2] = dd.sec ? 1 / 2.4 : 1 / bpc;
        arr[k * 4 + 3] = dd.sec ? 1 : 0;
        const show = !d.hidden && !d.shield;
        Q.setFromAxisAngle(Y, dd.yawNow ?? d.yaw);
        S.setScalar(show ? scl : 0);
        M4.compose(d.pos, Q, S);
        mesh.setMatrixAt(k, M4);
      }
      a.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  /** screen-space tests: a dancer's head top (root space) */
  headTop(d: Dancer, out: THREE.Vector3) { return out.copy(d.pos).setY(d.pos.y + this.o.height * 1.05); }

  dispose() {
    for (const p of this.parts) { p.mesh?.geometry.dispose(); (p.mesh?.material as THREE.Material | undefined)?.dispose(); p.tex?.dispose(); }
    this.group.removeFromParent();
    this.bake?.mixer.stopAllAction();
    this.parts = []; this.bake = null;
  }
  info() { return { dancers: this.dancers.length, parts: this.parts.map((p) => `${p.name}:${p.who.length}`), clips: this.clips, ready: this.ready, ms: +this.cost.toFixed(3) }; }
}

function firstMesh(o: THREE.Object3D): THREE.Mesh | null {
  if ((o as THREE.Mesh).isMesh) return o as THREE.Mesh;
  let hit: THREE.Mesh | null = null;
  o.traverse((c) => { if (!hit && (c as THREE.Mesh).isMesh) hit = c as THREE.Mesh; });
  return hit;
}

// Cryo pods v2 (docs/SCENES.md → "Cryo pods: frozen occupants, the cryo exit"): the render-time pieces the space mover
// (spaceMover.ts) drives from its deterministic timelines. Nothing here changes a material, a morph or a node for good:
// every effect is applied right before a mesh draws and put back right after, so the light engine, the avatar runtime
// and the other movers never see it.
//
//   FrostWindow   an animated frost shader on a pod's small view window (CRYO_POD_xx_window): frost grows in from the
//                 rim as `frost` goes 0 → 1 (0 = clear glass, ~0.5 = a frosted rim with the face readable in the middle,
//                 1 = frosted over), melts back with drips; a child of the door so it swings with it.
//   AvatarFrost   a frozen performer: tinted blue-white, an ice rim (MToon rim / toon outlines), the face held still
//                 (eyes closed, mouth shut, the tracked face frozen) — strength 0..1 per actor.
//   PodGlow       the pods' own light materials (name contains "cryoglow"): icy blue ↔ warm amber, brighter while a pod
//                 is occupied, a pulse while it seals.
import * as THREE from 'three';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { CryoConfig } from '../../../shared/arrivals.ts';
import type { CryoPod } from './spaceRoom.ts';
import { hash32 } from '../raid/rng.ts';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------------ frost window
const FROST_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FROST_FS = /* glsl */ `
uniform float uFrost, uMelt, uTime, uSeed, uLit;
uniform vec3 uTint;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float n = fbm(vUv * 5.0);
  // feathery crystals: ridged noise, stretched radially (frost ferns grow in from the frame; no atan seam)
  vec2 dir = p / max(r, 1e-3);
  float fern = 1.0 - abs(fbm(dir * 2.6 + vec2(r * 6.5, -r * 4.0) + n * 1.7) * 2.0 - 1.0);
  fern = pow(clamp(fern, 0.0, 1.0), 3.0);
  // coverage: from the rim inward as uFrost rises (a ragged front)
  float front = 1.0 - uFrost * 1.12 + (n - 0.5) * 0.42;
  float cov = smoothstep(front - 0.05, front + 0.14, r);
  float a = cov * (0.58 + 0.2 * fern + 0.12 * n);
  // melting: the frost thins in blotches and runs down in drips
  float drip = smoothstep(0.62, 0.95, fbm(vec2(vUv.x * 18.0, vUv.y * 2.2 + uTime * 0.35)));
  a *= 1.0 - uMelt * (0.55 + 0.45 * smoothstep(0.35, 0.75, n));
  a += uMelt * drip * 0.35 * (1.0 - vUv.y) * step(r, 0.97);
  // a faint sheen over the clear glass so it still reads as glass
  a = max(a, 0.05 + 0.05 * smoothstep(0.2, 0.9, r));
  vec3 col = mix(uTint * vec3(0.8, 0.92, 1.0), vec3(0.93, 0.97, 1.0), 0.28 + 0.2 * fern) * (1.0 + 0.3 * uLit);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.96));
}`;

export class FrostWindow {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  constructor(pod: CryoPod, win: THREE.Object3D, root: THREE.Object3D, tint: string) {
    win.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(win);
    const size = box.isEmpty() ? V(0.4, 0.26, 0.02) : box.getSize(V());
    const c = box.isEmpty() ? win.getWorldPosition(V()) : box.getCenter(V());
    const right = V(pod.fwd.z, 0, -pod.fwd.x);
    const w = Math.max(0.08, Math.abs(size.x * right.x) + Math.abs(size.z * right.z)), hgt = Math.max(0.08, size.y);
    const x = (win.userData ?? {}) as Record<string, unknown>;
    this.mat = new THREE.ShaderMaterial({
      name: 'vtp:cryo:frost', vertexShader: FROST_VS, fragmentShader: FROST_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uFrost: { value: 0.35 }, uMelt: { value: 0 }, uTime: { value: 0 }, uSeed: { value: (hash32(pod.name, 'frost') % 1000) / 37 }, uLit: { value: 0 }, uTint: { value: new THREE.Color(tint) } },
    });
    // a disc (round / oval windows) — extras shape: "rect" for a slit
    const geo = x.shape === 'rect' ? new THREE.PlaneGeometry(2, 2) : new THREE.CircleGeometry(1, 48);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = `vtp:space:frost:${pod.name}`;
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    this.mesh.scale.set(w * 0.5 * 0.98, hgt * 0.5 * 0.98, 1);
    this.mesh.position.copy(c).addScaledVector(pod.fwd, Math.max(0.004, size.z * 0 + 0.006));
    this.mesh.quaternion.setFromUnitVectors(V(0, 0, 1), pod.fwd);
    root.add(this.mesh);
    this.mesh.updateMatrixWorld();
    (pod.door ?? win).attach(this.mesh);
  }
  set(frost: number, melt: number, lit: number, t: number) {
    const u = this.mat.uniforms;
    u.uFrost.value = frost; u.uMelt.value = melt; u.uLit.value = lit; u.uTime.value = t;
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ------------------------------------------------------------------------------------------------ avatar frost
type AnyMat = THREE.Material & Record<string, unknown>;
interface Saved { m: AnyMat; color?: THREE.Color; emissive?: THREE.Color; ei?: number; shade?: THREE.Color; rim?: THREE.Color; rimP?: number; rimL?: number; rimMix?: number; oc?: THREE.Color; ot?: number }
const BLINK = /blink|eyeclose|eyesclosed|まばたき/i;
const QUIET = /^(aa|ih|ou|ee|oh|a|i|u|e|o)$|jaw|mouth|viseme|tongue|cheekpuff|smile|angry|sad|surprise|fun|joy|sorrow|eyewide|eyesquint|brow|look/i;

/** Tint + ice rim + a still face on frozen performers (render-time only). */
export class AvatarFrost {
  private k = new WeakMap<AvatarRuntime, number>();
  private scanned = new WeakMap<AvatarRuntime, number>();
  private hooked = new Map<THREE.Mesh, { before: THREE.Mesh['onBeforeRender']; after: THREE.Mesh['onAfterRender'] }>();
  private snaps = new WeakMap<THREE.Mesh, Float32Array>();
  private readonly tint: THREE.Color;
  private readonly pale: THREE.Color;
  private readonly deep: THREE.Color;
  private readonly rimC = new THREE.Color(0.85, 0.97, 1.15);
  constructor(readonly cfg: CryoConfig) {
    this.tint = new THREE.Color(cfg.tint);
    this.pale = this.tint.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
    this.deep = this.tint.clone().multiplyScalar(0.42);
  }
  /** Frozen amount (0..1) of one actor this frame; `now` (s) re-scans for new meshes (costumes) every ~1.5 s. */
  set(a: SceneActor, k: number, now: number) {
    const rt = a.runtime;
    if (!rt) return;
    const v = Math.max(0, Math.min(1, k)) * this.cfg.strength;
    this.k.set(rt, v);
    if (v < 1e-3) return;
    const last = this.scanned.get(rt) ?? -1e9;
    if (now - last > 1.5) { this.scanned.set(rt, now); this.hook(rt); }
  }
  private hook(rt: AvatarRuntime) {
    const root = (rt as unknown as { model?: THREE.Object3D; anchor?: THREE.Object3D }).model ?? (rt as unknown as { anchor?: THREE.Object3D }).anchor;
    if (!root) return;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || this.hooked.has(mesh)) return;
      const before = mesh.onBeforeRender, after = mesh.onAfterRender;
      const self = this;
      let saved: Saved[] = [];
      let infl: Float32Array | null = null;
      mesh.onBeforeRender = function (...args) {
        before.apply(this, args);
        const k = self.k.get(rt) ?? 0;
        if (k < 1e-3) { self.snaps.delete(mesh); return; }
        saved = self.apply(mesh, k);
        infl = self.face(mesh, k);
      };
      mesh.onAfterRender = function (...args) {
        for (const s of saved) self.restore(s);
        saved = [];
        if (infl && mesh.morphTargetInfluences) { for (let i = 0; i < infl.length; i++) mesh.morphTargetInfluences[i] = infl[i]; }
        infl = null;
        after.apply(this, args);
      };
      this.hooked.set(mesh, { before, after });
    });
  }
  private apply(mesh: THREE.Mesh, k: number): Saved[] {
    const out: Saved[] = [];
    for (const mm of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
      const m = mm as AnyMat;
      if (!m) continue;
      const s: Saved = { m };
      const col = m.color as THREE.Color | undefined, em = m.emissive as THREE.Color | undefined;
      if (col?.isColor) { s.color = col.clone(); col.lerp(this.pale, 0.34 * k); }
      if (em?.isColor) {
        s.emissive = em.clone(); s.ei = m.emissiveIntensity as number;
        const ei = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
        em.multiplyScalar(ei).lerp(this.tint, 0.16 * k);
        if (typeof m.emissiveIntensity === 'number') m.emissiveIntensity = 1;
      }
      // MToon (VRM): cold shade + an icy parametric rim
      const sh = m.shadeColorFactor as THREE.Color | undefined, rim = m.parametricRimColorFactor as THREE.Color | undefined;
      if (sh?.isColor) { s.shade = sh.clone(); sh.lerp(this.deep, 0.45 * k); }
      if (rim?.isColor) {
        s.rim = rim.clone(); s.rimP = m.parametricRimFresnelPowerFactor as number; s.rimL = m.parametricRimLiftFactor as number; s.rimMix = m.rimLightingMixFactor as number;
        rim.lerp(this.rimC, k);
        if (typeof s.rimP === 'number') m.parametricRimFresnelPowerFactor = s.rimP + (2.6 - s.rimP) * k;
        if (typeof s.rimL === 'number') m.parametricRimLiftFactor = s.rimL + (0.1 - s.rimL) * k;
        if (typeof s.rimMix === 'number') m.rimLightingMixFactor = s.rimMix + (1 - s.rimMix) * k;
      }
      // toon outlines (src/avatar/toon.ts outlineMaterial): the line turns to ice
      const u = (m as unknown as THREE.ShaderMaterial).uniforms;
      if (m.name === 'vtp-outline' && u?.uColor?.value?.isColor) {
        s.oc = (u.uColor.value as THREE.Color).clone(); s.ot = u.uTint?.value as number;
        (u.uColor.value as THREE.Color).lerp(this.rimC, 0.85 * k);
        if (typeof s.ot === 'number') u.uTint.value = s.ot * (1 - k);
      }
      out.push(s);
    }
    return out;
  }
  private restore(s: Saved) {
    const m = s.m;
    if (s.color) (m.color as THREE.Color).copy(s.color);
    if (s.emissive) { (m.emissive as THREE.Color).copy(s.emissive); if (typeof s.ei === 'number') m.emissiveIntensity = s.ei; }
    if (s.shade) (m.shadeColorFactor as THREE.Color).copy(s.shade);
    if (s.rim) {
      (m.parametricRimColorFactor as THREE.Color).copy(s.rim);
      if (typeof s.rimP === 'number') m.parametricRimFresnelPowerFactor = s.rimP;
      if (typeof s.rimL === 'number') m.parametricRimLiftFactor = s.rimL;
      if (typeof s.rimMix === 'number') m.rimLightingMixFactor = s.rimMix;
    }
    const u = (m as unknown as THREE.ShaderMaterial).uniforms;
    if (s.oc && u?.uColor) { (u.uColor.value as THREE.Color).copy(s.oc); if (typeof s.ot === 'number') u.uTint.value = s.ot; }
  }
  /** The face held still: the tracked face as it was when they froze, eyes closed, mouth shut. Returns the live values. */
  private face(mesh: THREE.Mesh, k: number): Float32Array | null {
    const inf = mesh.morphTargetInfluences, dict = mesh.morphTargetDictionary;
    if (!inf || !inf.length || !dict) return null;
    const live = Float32Array.from(inf);
    let snap = this.snaps.get(mesh);
    if (!snap && k > 0.35) { snap = Float32Array.from(inf); this.snaps.set(mesh, snap); }
    const names: string[] = [];
    for (const [nm, i] of Object.entries(dict)) names[i] = nm;
    for (let i = 0; i < inf.length; i++) {
      const nm = names[i] ?? '';
      const want = BLINK.test(nm) && !/left|right|_l$|_r$|wink/i.test(nm) ? 1 : QUIET.test(nm) ? 0 : snap ? snap[i] : inf[i];
      inf[i] = live[i] + (want - live[i]) * k;
    }
    return live;
  }
  dispose() {
    for (const [mesh, h] of this.hooked) { mesh.onBeforeRender = h.before; mesh.onAfterRender = h.after; }
    this.hooked.clear();
  }
}

// ------------------------------------------------------------------------------------------------ pod lights
export interface PodLightView { warm: number; level: number }
const COLD = new THREE.Color(0.45, 0.82, 1.35), WARM = new THREE.Color(1.35, 0.72, 0.28);

/** The pods' own light materials (name contains "cryoglow"), per pod (the nearest CRYO_POD anchor). */
export class PodGlow {
  private hooked: { mesh: THREE.Mesh; before: THREE.Mesh['onBeforeRender']; after: THREE.Mesh['onAfterRender'] }[] = [];
  count = 0;
  constructor(root: THREE.Object3D, pods: CryoPod[], view: (pod: number) => PodLightView) {
    if (!pods.length) return;
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter((m): m is THREE.MeshStandardMaterial => !!m && /cryoglow/i.test(m.name) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial);
      if (!mats.length) return;
      const c = new THREE.Box3().setFromObject(mesh).getCenter(V());
      let best = -1, bd = 2.2;
      pods.forEach((p, i) => { const d = Math.hypot(p.p.x - c.x, p.p.z - c.z); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      const before = mesh.onBeforeRender, after = mesh.onAfterRender;
      let undo: (() => void) | null = null;
      mesh.onBeforeRender = function (...args) {
        before.apply(this, args);
        const v = view(best);
        const saved = mats.map((m) => ({ m, e: m.emissive.clone(), i: m.emissiveIntensity }));
        for (const m of mats) {
          const lum = Math.max(0.05, (m.emissive.r + m.emissive.g + m.emissive.b) / 3);
          m.emissive.copy(COLD).lerp(WARM, v.warm).multiplyScalar(lum * 0.78);
          m.emissiveIntensity *= v.level;
        }
        undo = () => { for (const s of saved) { s.m.emissive.copy(s.e); s.m.emissiveIntensity = s.i; } };
      };
      mesh.onAfterRender = function (...args) { undo?.(); undo = null; after.apply(this, args); };
      this.hooked.push({ mesh, before, after });
      this.count++;
    });
  }
  dispose() { for (const h of this.hooked) { h.mesh.onBeforeRender = h.before; h.mesh.onAfterRender = h.after; } this.hooked = []; }
}

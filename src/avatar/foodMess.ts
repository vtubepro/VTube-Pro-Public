// Food mess: surface-conforming decal patches (same machinery as the drawn mouth / blush) around the mouth
// and on each hand. Two layers per patch:
//   stain — MULTIPLIED onto the skin (sauce, chocolate, orange dust), so it keeps the cel shading underneath
//   bits  — small opaque-ish pieces drawn over it (noodles, crumbs, sugar powder, chocolate chunks), lit
//           with a simple 2-band toon term so they sit in the scene
// A fixed procedural noise field is thresholded by the mess level, so the mess GROWS naturally: first the
// mouth corners / lower lip, then chin and cheeks, up to "face-planted in a plate of spaghetti". The
// mouth opening itself stays clean (the drawn / 3D mouth must read).

import * as THREE from 'three';
import type { MessStyle, SurfaceMarker } from '../../shared/types.ts';
import { SKINNED_VERTEX_MAIN, SKINNED_VERTEX_PARS } from './shaderChunks.ts';
import { buildPatches, faceFrame, syncPatchMorphs } from './surfacePatch.ts';
import { holdFull } from './lod/fullIndex.ts';

const STYLE_ID: Record<MessStyle, number> = { crumbs: 0, spaghetti: 1, cheeto: 2, chocolate: 3, sugar: 4 };

const VERT = /* glsl */ `
  ${SKINNED_VERTEX_PARS}
  attribute vec2 patchUv; varying vec2 vP; varying vec3 vN;
  void main() { vP = patchUv; ${SKINNED_VERTEX_MAIN} vN = normalize(transformedNormal); }`;

// shared noise + mess field (vP units: 1 = the patch radius; the mouth / grip at 0,0)
const COMMON = /* glsl */ `
  uniform float uLevel, uStyle, uSeed, uHand, uFace;   // uFace = face width (patch units)
  uniform vec2 uMouth;            // mouth half-width / half-height (patch units); 0 on hands
  varying vec2 vP; varying vec3 vN;
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21) + uSeed); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec2 h22(vec2 p) { float a = h21(p); return vec2(a, h21(p + a + 7.13)); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
  // 0 inside the mouth opening (kept clean), 1 outside
  float mouthClear(vec2 p) {
    if (uHand > 0.5) return 1.0;
    // the opening hangs mostly BELOW the lip line (the jaw drops): keep that clean, not the upper lip
    float hy = max(uMouth.y, uMouth.x * 0.2);
    float e = length((p - vec2(0.0, -hy * 0.45)) / vec2(uMouth.x * 1.04, hy * 1.05));
    return smoothstep(0.85, 1.12, e);
  }
  // how "messable" a point is: noisy, strongest at the mouth corners / lower lip / chin (or the fingers)
  float field(vec2 p) {
    float n = fbm(p * 5.0 + uSeed * 3.0);
    if (uHand > 0.5) return (n * 0.65 + 0.35 * (1.0 - smoothstep(0.1, 1.1, length(p)))) * (1.0 - smoothstep(0.8, 1.0, length(p)));
    vec2 m = max(uMouth, vec2(0.02));
    // food lands around and BELOW the mouth (lips, chin, cheeks), rarely up toward the eyes
    // (distances in face widths, so wide frog mouths don't smear the whole snout)
    float e = length(vec2(p.x / max(m.x * 1.3, uFace * 0.35), (p.y > 0.0 ? p.y * 3.0 : p.y) / (uFace * 0.4)));
    float cw = min(m.x, uFace * 0.3); cw *= cw;
    float corners = exp(-dot(p - vec2(m.x, -m.y * 0.3), p - vec2(m.x, -m.y * 0.3)) / (cw * 0.12))
                  + exp(-dot(p + vec2(m.x, m.y * 0.3), p + vec2(m.x, m.y * 0.3)) / (cw * 0.12));
    vec2 ch = p - vec2(0.0, -max(m.y * 1.5, uFace * 0.18));
    float chin = exp(-dot(ch, ch) / (uFace * uFace * 0.03));
    float radial = 1.0 - smoothstep(0.5, 3.4, e);
    // the mouth corners / lower lip first; noise breaks it into drips and smears as it grows; fades out
    // before the patch edge (no hard cut-off line at extreme levels)
    float edge = 1.0 - smoothstep(0.7, 0.98, length(p));
    return (radial * 0.6 + n * 0.32 + 0.22 * min(1.0, corners + chin * 0.8)) * edge;
  }
  // coverage for a level: tiny smudge (level ~0.05) → nearly everything (level 1)
  float cover(float f, float soft) { float th = 1.02 - uLevel * 0.95; return smoothstep(th, th + soft, f); }
`;

const STAIN_FRAG = /* glsl */ `
  uniform vec3 uStain;
  ${COMMON}
  void main() {
    vec2 p = vP;
    float f = field(p);
    float s = cover(f, 0.05) * mouthClear(p);
    int st = int(uStyle + 0.5);
    float k = 0.0;
    if (st == 1) {        // spaghetti sauce: bold smears, streaky + darker core
      float streak = fbm(vec2(p.x * 3.0, p.y * 9.0) + 4.0);
      k = s * (0.62 + 0.3 * streak) + cover(f - 0.08, 0.04) * mouthClear(p) * 0.2;
    } else if (st == 2) { // cheeto dust: fine grainy powder
      float grain = h21(floor(p * 90.0));
      k = s * (0.45 + 0.4 * grain);
    } else if (st == 3) { // chocolate: smooth dark smears
      k = s * (0.7 + 0.2 * fbm(p * 11.0));
    } else if (st == 4) { // powdered sugar: barely any stain (the powder is in the bits layer)
      k = s * 0.08;
    } else {              // crumbs / generic sauce: light greasy tint
      k = s * (0.35 + 0.2 * fbm(p * 7.0));
    }
    k = clamp(k, 0.0, 0.92);
    if (k < 0.004) discard;
    gl_FragColor = vec4(mix(vec3(1.0), uStain, k), 1.0);   // multiplied onto the skin (see blending)
    #include <colorspace_fragment>
  }`;

const BITS_FRAG = /* glsl */ `
  uniform vec3 uBits, uBits2, uPaint;
  uniform float uPaintK;
  ${COMMON}
  // capsule distance
  float seg(vec2 p, vec2 a, vec2 b, float r) { vec2 pa = p - a, ba = b - a; float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * t) - r; }
  void main() {
    vec2 p = vP;
    float f = field(p);
    float region = cover(f - 0.04, 0.03) * mouthClear(p);
    int st = int(uStyle + 0.5);
    float a = 0.0; vec3 col = uBits;
    if (st == 1) {
      // noodle bits: short curved strands scattered in cells
      vec2 g = p * 4.0; vec2 c = floor(g), q = fract(g) - 0.5;
      vec2 r = h22(c);
      float on = step(1.0 - uLevel * 0.8, r.x) * region;
      float ang = r.y * 6.283;
      vec2 d = vec2(cos(ang), sin(ang));
      vec2 bend = vec2(-d.y, d.x) * 0.16 * sin(dot(q, d) * 5.0 + r.x * 6.0);
      float dd = seg(q + bend, -d * 0.34, d * 0.34, 0.11);
      a = aa(-dd) * on;
      // sauce clinging to the noodle edges + a highlight line along it
      col = mix(uBits2, uBits, smoothstep(0.0, 0.04, -dd));
      col = mix(col, vec3(1.0, 0.97, 0.85), 0.55 * smoothstep(0.07, 0.09, -dd));
    } else if (st == 4 || st == 2) {
      // powder: fine dense specks
      vec2 g = p * (st == 4 ? 80.0 : 110.0); vec2 c = floor(g), q = fract(g) - 0.5;
      vec2 r = h22(c);
      float on = step(1.0 - (0.25 + 0.6 * uLevel) * region, r.x);
      a = aa(0.3 * (0.6 + 0.4 * r.y) - length(q)) * on * region * (st == 4 ? 0.9 : 0.55);
    } else {
      // crumbs / chocolate chunks: sparse little polygons
      vec2 g = p * (st == 3 ? 16.0 : 22.0); vec2 c = floor(g), q = fract(g) - 0.5 - (h22(c + 3.1) - 0.5) * 0.4;
      vec2 r = h22(c);
      float on = step(1.0 - uLevel * 0.55, r.x) * region;
      float ang = r.y * 6.283; float cs = cos(ang), sn = sin(ang);
      vec2 qr = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
      float box = max(abs(qr.x) * 1.2, abs(qr.y)) - (0.12 + 0.1 * r.y);
      a = aa(-box) * on;
      col = mix(uBits, uBits2, step(0.5, h21(c + 9.0)));
    }
    // "paint": the thick core of the sauce / dust / chocolate in its own colour (a multiply alone turns red
    // sauce brown on green skin); bits sit on top of it
    float paint = cover(f - 0.1, 0.06) * mouthClear(p) * uPaintK * (0.75 + 0.25 * fbm(p * 9.0));
    col = mix(uPaint, col, a);
    a = max(a, paint);
    if (a < 0.02) discard;
    // 2-band toon light so the bits sit in the scene
    float l = dot(normalize(vN), normalize(vec3(0.35, 0.65, 0.7)));
    col *= mix(0.72, 1.0, smoothstep(0.05, 0.15, l));
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

const PALETTE: Record<MessStyle, { stain: string; bits: string; bits2: string; paint: string; paintK: number }> = {
  crumbs: { stain: '#c79a63', bits: '#d9a55b', bits2: '#a8703a', paint: '#c98a45', paintK: 0.35 },
  spaghetti: { stain: '#d9471f', bits: '#f3d98b', bits2: '#c93a17', paint: '#d8401a', paintK: 0.8 },
  cheeto: { stain: '#ff8a1c', bits: '#ffa53a', bits2: '#ff7a00', paint: '#ff8c1a', paintK: 0.55 },
  chocolate: { stain: '#6b3a1e', bits: '#4a2612', bits2: '#7a4424', paint: '#5e321a', paintK: 0.75 },
  sugar: { stain: '#f4ecf0', bits: '#ffffff', bits2: '#f6eef4', paint: '#fbf6f8', paintK: 0.5 },
};

export interface MessSite {
  marker: SurfaceMarker;
  /** Patch radius (world units). */
  radius: number;
  /** Mouth half-width / half-height (world units); 0,0 on hands. */
  mouth: [number, number];
  hand: boolean;
  /** Face width (world units) — the mess spreads in face-relative distances. */
  faceSize?: number;
  /** Hands: only skin weighted to these bones (hand + fingers) — never the sleeve / forearm. */
  bones?: THREE.Object3D[];
}

/** Vertex filter: at least half of the vertex's skin weight on one of bones. */
function boneFilter(bones: THREE.Object3D[]) {
  const set = new Set(bones);
  return (src: THREE.Mesh) => {
    const sm = src as THREE.SkinnedMesh;
    const si = src.geometry.attributes.skinIndex, sw = src.geometry.attributes.skinWeight;
    if (!sm.isSkinnedMesh || !si || !sw || !sm.skeleton) return () => false;
    const mine = new Set<number>();
    sm.skeleton.bones.forEach((b, i) => { if (set.has(b)) mine.add(i); });
    if (!mine.size) return () => false;
    return (i: number) => {
      let w = 0;
      for (let k = 0; k < 4; k++) if (mine.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      return w >= 0.5;
    };
  };
}

/** One mess layer (stain + bits) on one site. */
class MessPatch {
  readonly meshes: THREE.Mesh[] = [];
  readonly stain: THREE.ShaderMaterial;
  readonly bits: THREE.ShaderMaterial;
  private style: MessStyle | null = null;

  constructor(skin: THREE.Mesh[], root: THREE.Object3D, anchor: THREE.Object3D, site: MessSite, seed: number) {
    const R = site.radius;
    const uni = () => ({
      uLevel: { value: 0 }, uStyle: { value: 0 }, uSeed: { value: seed }, uHand: { value: site.hand ? 1 : 0 }, uFace: { value: (site.faceSize ?? R) / R },
      uMouth: { value: new THREE.Vector2(site.mouth[0] / R, site.mouth[1] / R) },
    });
    const common = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide, vertexShader: VERT };
    this.stain = new THREE.ShaderMaterial({
      ...common, name: 'vtp-mess-stain',
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { ...uni(), uStain: { value: new THREE.Color() } },
      fragmentShader: STAIN_FRAG,
    });
    this.bits = new THREE.ShaderMaterial({
      ...common, name: 'vtp-mess-bits',
      uniforms: { ...uni(), uBits: { value: new THREE.Color() }, uBits2: { value: new THREE.Color() }, uPaint: { value: new THREE.Color() }, uPaintK: { value: 0 } },
      fragmentShader: BITS_FRAG,
    });
    const frame = faceFrame(site.marker, root, anchor);
    const ps = buildPatches(skin, frame, { radius: R, lift: R * 0.012, minFacing: site.hand ? -1.01 : 0.05, uvScale: R, includeHair: true, vertexFilter: site.bones ? boneFilter(site.bones) : undefined }, this.stain);
    for (const p of ps) {
      p.name = p.name.replace(/_patch$/, site.hand ? '_messHand' : '_mess');
      p.renderOrder = 1; // before the drawn mouth (2): the mouth paints over any stain it overlaps
      this.meshes.push(p);
      // the bits share the patch geometry (and skeleton / morphs)
      let b: THREE.Mesh;
      if ((p as THREE.SkinnedMesh).isSkinnedMesh) {
        const sp = p as THREE.SkinnedMesh;
        const sb = new THREE.SkinnedMesh(p.geometry, this.bits);
        sb.bind(sp.skeleton, sp.bindMatrix);
        b = sb;
      } else b = new THREE.Mesh(p.geometry, this.bits);
      b.name = p.name + 'Bits';
      b.userData.vtpGenerated = true; b.userData.vtpNoToon = true; b.userData.source = p.userData.source;
      b.position.copy(p.position); b.quaternion.copy(p.quaternion); b.scale.copy(p.scale);
      b.frustumCulled = false;
      b.renderOrder = 3;
      b.updateMorphTargets();
      p.parent?.add(b);
      this.meshes.push(b);
    }
  }

  set(level: number, style: MessStyle) {
    const on = level > 0.003;
    for (const m of this.meshes) m.visible = on;
    this.hold(on);
    if (!on) return;
    for (const mat of [this.stain, this.bits]) mat.uniforms.uLevel.value = Math.min(1, level);
    if (style !== this.style) {
      this.style = style;
      const P = PALETTE[style];
      for (const mat of [this.stain, this.bits]) mat.uniforms.uStyle.value = STYLE_ID[style];
      this.stain.uniforms.uStain.value.set(P.stain);
      this.bits.uniforms.uBits.value.set(P.bits);
      this.bits.uniforms.uBits2.value.set(P.bits2);
      this.bits.uniforms.uPaint.value.set(P.paint);
      this.bits.uniforms.uPaintK.value = P.paintK;
    }
    for (const m of this.meshes) syncPatchMorphs(m);
  }

  /** Avatar detail (src/avatar/lod/fullIndex.ts holdFull): while the mess shows, the surfaces it sits on are drawn at
   *  their full triangle list, so a lighter level can't bulge over the thin layer and hide parts of it. */
  private holds: (() => void)[] = [];
  private hold(on: boolean) {
    if (on && !this.holds.length) {
      const hosts = new Set(this.meshes.map((m) => (m.userData.source as THREE.Mesh | undefined)?.geometry).filter((g): g is THREE.BufferGeometry => !!g));
      for (const g of hosts) this.holds.push(holdFull(g));
    } else if (!on && this.holds.length) {
      for (const release of this.holds) release();
      this.holds = [];
    }
  }

  dispose() {
    this.hold(false);
    for (const m of this.meshes) m.removeFromParent();
    // stain + bits meshes share each geometry: dispose once
    for (const g of new Set(this.meshes.map((m) => m.geometry))) g.dispose();
    this.stain.dispose(); this.bits.dispose();
  }
}

const HAIR_RE = /hair|bang|fringe|ponytail|twintail|eye|brow|lash|teeth|tongue/i;

export class FoodMess {
  private face: MessPatch | null = null;
  private hands: { left: MessPatch | null; right: MessPatch | null } = { left: null, right: null };

  constructor(meshes: THREE.Mesh[], root: THREE.Object3D, anchor: THREE.Object3D, sites: { face: MessSite | null; left: MessSite | null; right: MessSite | null }) {
    const skin = meshes.filter((m) => !HAIR_RE.test(m.name) && ![m.material].flat().some((x) => HAIR_RE.test(x.name)));
    if (sites.face) this.face = new MessPatch(skin, root, anchor, sites.face, 0.37);
    if (sites.left) this.hands.left = new MessPatch(meshes, root, anchor, sites.left, 0.61);
    if (sites.right) this.hands.right = new MessPatch(meshes, root, anchor, sites.right, 0.83);
  }

  get empty() { return !this.face?.meshes.length && !this.hands.left?.meshes.length && !this.hands.right?.meshes.length; }

  set(style: MessStyle, face: number, left: number, right: number) {
    this.face?.set(face, style);
    // hands: cheeto fingers are the classic; other foods show on fingers more subtly
    this.hands.left?.set(left, style);
    this.hands.right?.set(right, style);
  }

  dispose() { this.face?.dispose(); this.hands.left?.dispose(); this.hands.right?.dispose(); }
}

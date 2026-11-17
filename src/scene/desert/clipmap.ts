// GPU height / normal clipmap: CLIP_LEVELS nested square windows of CLIP_RES^2 texels around the camera (terrain-local
// space), texel size 0.5 m * 2^level: level 0 = +-128 m at 0.5 m ... level 6 = +-8 km at 32 m.
//   height  RG32F  (h, flat)   - exact samples of duneH at texel corners (read with texelFetch: no filtering needed,
//                                 CDLOD vertices land exactly on texels)
//   normal  RGBA16F (nx, nz, curvature, flat) - bilinear-filtered per pixel in the terrain fragment shader
// Fallback without EXT_color_buffer_float (SPEC 3.2): both targets RGBA8, height packed in 16 bits (1/64 m over
// -128..+896 m: the relief's mesas and ridges), the normal set affinely; readers decode through CLIP_DECODE_GLSL with the shared uPack uniform, so the
// switch never compiles a program (setPacked()).
// A level re-renders (one full-screen pass + one normal pass) only when the camera leaves the middle of its window or
// the terrain origin rebases: ~0.03 ms GPU each at 512^2 on a 3060-class card, a few times a second while walking.
import * as THREE from 'three';
import { CLIP_DECODE_GLSL, HEIGHT_GLSL, HEIGHT_UNIFORMS, NOISE_GLSL } from './glsl.ts';
import type { HeightUniforms } from './uniforms.ts';

export const CLIP_RES = 512;
export const CLIP_LEVELS = 7;
export const TS0 = 0.5;
/** Level centres snap to a grid of this many texels (the camera is never more than RECENTRE / 2 texels off-centre). */
const RECENTRE = 16;
/** Levels re-rendered per frame after invalidateSoft (a new route polyline). */
const SOFT_PER_FRAME = 2;

const QUAD_VS = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEIGHT_FS = /* glsl */ `
precision highp float; precision highp int;
${HEIGHT_UNIFORMS}
uniform vec3 uLevel;   // origin x, origin z, texel size
uniform float uPack;
${NOISE_GLSL}
${HEIGHT_GLSL}
out vec4 outH;
void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  vec2 p = uLevel.xy + ij * uLevel.z;
  float fl;
  float h = duneH(p, fl);
  if (uPack > 0.5) {
    float e = floor(clamp((h + 128.0) * 64.0, 0.0, 65535.0) + 0.5);
    float hi = floor(e * 0.00390625);
    outH = vec4(hi / 255.0, (e - hi * 256.0) / 255.0, fl, 1.0);
  } else outH = vec4(h, fl, 0.0, 1.0);
}`;

const NORMAL_FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2DArray;
uniform highp sampler2DArray uH;
uniform int uLayer;
uniform float uTs;
uniform float uPack;
out vec4 outN;
${CLIP_DECODE_GLSL}
float hAt(ivec2 c) { c = clamp(c, ivec2(0), ivec2(${CLIP_RES - 1})); return clipHd(texelFetch(uH, ivec3(c, uLayer), 0)); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 t0 = texelFetch(uH, ivec3(c, uLayer), 0);
  vec2 hf = vec2(clipHd(t0), clipFd(t0));
  float l = hAt(c - ivec2(1, 0)), r = hAt(c + ivec2(1, 0)), d = hAt(c - ivec2(0, 1)), u = hAt(c + ivec2(0, 1));
  vec3 n = normalize(vec3(-(r - l) / (2.0 * uTs), 1.0, -(u - d) / (2.0 * uTs)));
  // curvature: wide Laplacian (+ = concave trough, - = convex crest), in metres of "cupping" over 3 texels
  float l3 = hAt(c - ivec2(3, 0)), r3 = hAt(c + ivec2(3, 0)), d3 = hAt(c - ivec2(0, 3)), u3 = hAt(c + ivec2(0, 3));
  float lap = (l3 + r3 + d3 + u3 - 4.0 * hf.x) * 0.25;
  outN = uPack > 0.5 ? vec4(n.x * 0.5 + 0.5, n.z * 0.5 + 0.5, clamp(lap * 0.125 + 0.5, 0.0, 1.0), hf.y) : vec4(n.x, n.z, lap, hf.y);
}`;

export interface ClipLevel { ox: number; oz: number; cx: number; cz: number; ts: number; valid: boolean; renders: number; soft: boolean }

export class HeightClipmap {
  heightRT: THREE.WebGLArrayRenderTarget;
  normalRT: THREE.WebGLArrayRenderTarget;
  /** Shared texture uniforms (every reader spreads these objects, so setPacked() reaches them all). */
  readonly hTexU: { value: THREE.Texture };
  readonly nTexU: { value: THREE.Texture };
  /** 1 = RGBA8 packed targets (decode with CLIP_DECODE_GLSL). */
  readonly packU = { value: 0 };
  readonly levels: ClipLevel[] = [];
  /** Terrain shaders read these: per level vec4(origin x, origin z, texel size, 1 / texel size). */
  readonly clipU = { value: Array.from({ length: CLIP_LEVELS }, () => new THREE.Vector4()) };
  /** Centres per level (for the fragment shader's level choice). */
  readonly centreU = { value: Array.from({ length: CLIP_LEVELS }, () => new THREE.Vector2()) };
  private hMat: THREE.RawShaderMaterial;
  private nMat: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;
  private qScene = new THREE.Scene();
  private qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  stats = { renders: 0, lastFrame: 0 };

  private static makeTargets(packed: boolean) {
    const mk = (type: THREE.TextureDataType, format: THREE.PixelFormat, filter: THREE.MagnificationTextureFilter) => {
      const rt = new THREE.WebGLArrayRenderTarget(CLIP_RES, CLIP_RES, CLIP_LEVELS, { type, format, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: filter, magFilter: filter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    const h = packed ? mk(THREE.UnsignedByteType, THREE.RGBAFormat, THREE.NearestFilter) : mk(THREE.FloatType, THREE.RGFormat, THREE.NearestFilter);
    const n = packed ? mk(THREE.UnsignedByteType, THREE.RGBAFormat, THREE.LinearFilter) : mk(THREE.HalfFloatType, THREE.RGBAFormat, THREE.LinearFilter);
    h.texture.name = 'vtp:desert:clipH';
    n.texture.name = 'vtp:desert:clipN';
    return { h, n };
  }

  get packed() { return this.packU.value > 0.5; }

  constructor(hu: HeightUniforms, packed = false) {
    const t = HeightClipmap.makeTargets(packed);
    this.heightRT = t.h; this.normalRT = t.n;
    this.packU.value = packed ? 1 : 0;
    this.hTexU = { value: this.heightRT.texture };
    this.nTexU = { value: this.normalRT.texture };
    this.hMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: `precision highp float;\nin vec3 position;\n${QUAD_VS}`, fragmentShader: HEIGHT_FS, uniforms: { ...hu, uLevel: { value: new THREE.Vector3() }, uPack: this.packU }, depthTest: false, depthWrite: false });
    this.nMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: `precision highp float;\nin vec3 position;\n${QUAD_VS}`, fragmentShader: NORMAL_FS, uniforms: { uH: this.hTexU, uLayer: { value: 0 }, uTs: { value: 1 }, uPack: this.packU }, depthTest: false, depthWrite: false });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.hMat);
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
    for (let l = 0; l < CLIP_LEVELS; l++) this.levels.push({ ox: 0, oz: 0, cx: 1e9, cz: 1e9, ts: TS0 * 2 ** l, valid: false, renders: 0, soft: false });
  }

  /** Mark every level stale (terrain origin rebased, world spec changed). */
  invalidate() { for (const L of this.levels) L.valid = false; }
  /** The heights moved a little everywhere (a new route polyline): the old windows stay drawable, so re-render them
   *  over a few frames (SOFT_PER_FRAME, finest first - a pure function of the stale set, so pages agree) instead of
   *  all seven at once, which hitched a frame. */
  invalidateSoft() { for (const L of this.levels) if (L.valid) L.soft = true; }

  /** Mark stale only the levels whose window touches one of these discs (terrain-local x, z, radius): a flatten disc
   *  appeared, moved or left. The normal pass reads 3 texels out, so the test is padded by 4 texels. Returns the count. */
  invalidateDiscs(discs: readonly { x: number; z: number; r: number }[]): number {
    let n = 0;
    for (const L of this.levels) {
      if (!L.valid) continue;
      const pad = 4 * L.ts, span = CLIP_RES * L.ts;
      for (const c of discs) {
        if (c.x + c.r < L.ox - pad || c.x - c.r > L.ox + span + pad || c.z + c.r < L.oz - pad || c.z - c.r > L.oz + span + pad) continue;
        L.valid = false; n++;
        break;
      }
    }
    return n;
  }

  /** Switch to (or from) the RGBA8 packed targets: new targets, the same programs (uPack is a uniform). */
  setPacked(packed: boolean) {
    if (packed === this.packed) return;
    this.heightRT.dispose(); this.normalRT.dispose();
    const t = HeightClipmap.makeTargets(packed);
    this.heightRT = t.h; this.normalRT = t.n;
    this.hTexU.value = this.heightRT.texture; this.nTexU.value = this.normalRT.texture;
    this.packU.value = packed ? 1 : 0;
    this.invalidate();
  }

  /** Recentre + re-render the levels the camera (terrain-local x, z) has drifted away from. Returns levels rendered. */
  update(renderer: THREE.WebGLRenderer, camX: number, camZ: number, maxPerFrame = CLIP_LEVELS): number {
    let n = 0;
    const prevRT = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    const prevAuto = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    try {
      let soft = SOFT_PER_FRAME;
      for (let l = 0; l < CLIP_LEVELS && n < maxPerFrame; l++) {
        const L = this.levels[l];
        // centre = the camera snapped to a grid of RECENTRE texels: a pure function of the camera (two pages with the
        // same camera hold the same windows, whatever they showed before); re-render when that snapped centre moves
        const q = RECENTRE * L.ts;
        const cx = Math.round(camX / q) * q, cz = Math.round(camZ / q) * q;
        if (L.valid && cx === L.cx && cz === L.cz) {
          if (!L.soft || soft <= 0) continue;
          soft--;
        }
        L.soft = false;
        L.cx = cx; L.cz = cz;
        L.ox = L.cx - (CLIP_RES / 2) * L.ts; L.oz = L.cz - (CLIP_RES / 2) * L.ts;
        this.renderLevel(renderer, l);
        L.valid = true; L.renders++; n++;
      }
    } finally {
      renderer.setRenderTarget(prevRT, prevFace, prevMip);
      renderer.autoClear = prevAuto;
      renderer.xr.enabled = prevXr;
    }
    for (let l = 0; l < CLIP_LEVELS; l++) {
      const L = this.levels[l];
      this.clipU.value[l].set(L.ox, L.oz, L.ts, 1 / L.ts);
      this.centreU.value[l].set(L.cx, L.cz);
    }
    this.stats.renders += n; this.stats.lastFrame = n;
    return n;
  }

  private renderLevel(renderer: THREE.WebGLRenderer, l: number) {
    const L = this.levels[l];
    (this.hMat.uniforms.uLevel.value as THREE.Vector3).set(L.ox, L.oz, L.ts);
    this.quad.material = this.hMat;
    renderer.setRenderTarget(this.heightRT, l);
    renderer.render(this.qScene, this.qCam);
    this.nMat.uniforms.uLayer.value = l;
    this.nMat.uniforms.uTs.value = L.ts;
    this.quad.material = this.nMat;
    renderer.setRenderTarget(this.normalRT, l);
    renderer.render(this.qScene, this.qCam);
  }

  /** Warm both programs (first frame stalls otherwise). */
  compile(renderer: THREE.WebGLRenderer) {
    try { this.quad.material = this.hMat; renderer.compile(this.qScene, this.qCam); this.quad.material = this.nMat; renderer.compile(this.qScene, this.qCam); } catch { /* optional */ }
  }

  dispose() {
    this.heightRT.dispose(); this.normalRT.dispose();
    this.hMat.dispose(); this.nMat.dispose();
    this.quad.geometry.dispose();
  }
}

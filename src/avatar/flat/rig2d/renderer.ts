// WebGL2 renderer for .vtp2 rigs (VTube Pro's own 2D format). ONE GL context per page draws every 2D rig (party
// guests, several overlays …): each source then copies the picture into its own 2D canvas (the 2D-avatar interface
// hands the display side a canvas). Per frame:
//   * all meshes' vertices (position + opacity + multiply / screen colour) go into one dynamic vertex buffer, the
//     render order's triangles into one dynamic index buffer → consecutive meshes with the same texture, blend mode
//     and culling are ONE draw call (particles: one mesh per emitter = one draw call);
//   * clipping masks as Live2D draws them: the union (max) of the mask meshes' texture alpha in an offscreen mask
//     texture, multiplied into the masked mesh (inverted = 1 − mask); mask textures are cached per mask set per frame;
//   * premultiplied alpha throughout (textures premultiplied on upload; blend: normal ONE / ONE_MINUS_SRC_ALPHA,
//     add ONE / ONE (alpha kept), multiply DST_COLOR / ONE_MINUS_SRC_ALPHA (alpha kept), screen ONE / ONE_MINUS_SRC_COLOR);
//   * opt-in per model (docs/RIG2D_FORMAT.md §8): room lighting with normal / rim / emission maps (the LIT program),
//     ink outlines (an outline pass before the mesh), sprite-sheet frames (a UV offset per texture), per-vertex alpha
//     (particles). A model without them draws through the original program, unchanged.
import type { Rig2DDoc } from '../../../../shared/rig2d/format.ts';
import type { TexturePage } from './textureTier.ts';
import { TAIL, type MeshMap } from '../../../../shared/rig2d/gpu/layout.ts';
import { f32, viewArray } from '../../../../shared/rig2d/container.ts';
import type { EvalOut } from '../../../../shared/rig2d/evaluate.ts';

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv; in float aOp; in vec3 aMul; in vec3 aScr; in vec4 aRect; in vec2 aUv0; in vec4 aRect0;
uniform vec4 uXf; // clip = pos * xf.xy + xf.zw
out highp vec2 vUv; out float vOp; out vec3 vMul; out vec3 vScr; out highp vec4 vRect; out highp vec2 vUv0; out highp vec4 vRect0;
// vRect = the mesh's own UV box (inset half a texel). With uClamp on (native rigs), texture reads are clamped to it, so
// bilinear filtering never pulls in a neighbouring atlas cell (art that touches its cell edge next to other art draws no
// foreign line). Converted Live2D / Inochi2D rigs keep their source renderer's unclamped sampling (pixel-identical).
void main() { vUv = aUv; vOp = aOp; vMul = aMul; vScr = aScr; vRect = aRect; vUv0 = aUv0; vRect0 = aRect0; gl_Position = vec4(aPos * uXf.xy + uXf.zw, 0.0, 1.0); }`;
/** A page cut from a bigger texture (the high-quality tiers, shared/rig2d/gpu/layout.ts) holds mip levels 0..TAIL only;
 *  where the art is minified past that (a squashed mesh: a closed mouth or eye), the same texture at tier k + TAIL (one
 *  whole page, uTail, read at the mesh's original UVs vUv0 / clamp box vRect0) gives exactly the levels the uncut
 *  picture has. The switch uses the GPU's own LOD formula; at the switch both sources hold the same level. */
const ART = `
uniform sampler2D uTail; uniform int uTailOn; uniform vec2 uTailSize;
in highp vec2 vUv0; in highp vec4 vRect0;
vec4 art(highp vec2 uv, float bias, int clampOn) {
  vec4 c = texture(uTex, uv, bias);
  if (uTailOn == 1) {
    highp vec2 t = clampOn == 1 ? clamp(vUv0, vRect0.xy, vRect0.zw) : vUv0;
    highp vec2 g = t * uTailSize; vec2 gx = dFdx(g), gy = dFdy(g);
    float lod = 0.5 * log2(max(max(dot(gx, gx), dot(gy, gy)), 1e-30)) + bias;
    vec4 d = texture(uTail, t, bias);
    if (lod > 0.0) c = d;
  }
  return c;
}`;
const FS = `#version 300 es
precision mediump float;
in highp vec2 vUv; in float vOp; in vec3 vMul; in vec3 vScr; in highp vec4 vRect;
uniform sampler2D uTex; uniform sampler2D uMask; uniform int uMaskMode; uniform vec2 uView; uniform float uBias; uniform highp vec2 uCell; uniform int uClamp;
out vec4 o;
${ART}
void main() {
  vec4 c = art((uClamp == 1 ? clamp(vUv, vRect.xy, vRect.zw) : vUv) + uCell, uBias, uClamp); // a negative LOD bias keeps thin ink lines dark when the art is drawn small
  if (vMul != vec3(1.0) || vScr != vec3(0.0)) {
    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    rgb *= vMul; rgb = rgb + vScr - rgb * vScr;
    c.rgb = rgb * c.a;
  }
  float a = vOp;
  if (uMaskMode != 0) { float m = texture(uMask, gl_FragCoord.xy / uView).r; a *= uMaskMode == 2 ? 1.0 - m : m; }
  o = c * a;
}`;
/** Room-lit variant (§8.3): relief shading from a normal map normalised to the flat-facing result, rim light,
 *  emission; `uTint` colours the whole puppet toward the key light. */
const FS_LIT = `#version 300 es
precision mediump float;
in highp vec2 vUv; in float vOp; in vec3 vMul; in vec3 vScr; in highp vec4 vRect;
uniform sampler2D uTex; uniform sampler2D uMask; uniform int uMaskMode; uniform vec2 uView; uniform float uBias; uniform highp vec2 uCell; uniform int uClamp;
uniform sampler2D uNrm; uniform sampler2D uEmi; uniform sampler2D uRimT; uniform int uHasN; uniform int uHasE; uniform int uHasR;
uniform vec3 uKeyL; uniform vec3 uKeyC; uniform vec3 uFillL; uniform vec3 uFillC; uniform vec3 uAmb;
uniform float uStr; uniform float uRimW; uniform float uRimS; uniform float uTint; uniform float uFlipX;
uniform highp vec2 uMapUv; // page UV → the lighting maps' UV (the texture's: 1 / the page's UV scale; maps are on whole pages)
out vec4 o;
${ART}
void main() {
  highp vec2 uv = (uClamp == 1 ? clamp(vUv, vRect.xy, vRect.zw) : vUv) + uCell;
  highp vec2 muv = uv * uMapUv;
  vec4 c = art(uv, uBias, uClamp);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  rgb *= vMul; rgb = rgb + vScr - rgb * vScr;
  vec3 flatL = uAmb + uKeyC * max(uKeyL.z, 0.0) + uFillC * max(uFillL.z, 0.0);
  if (uTint > 0.0) rgb *= mix(vec3(1.0), flatL / max(max(flatL.r, max(flatL.g, flatL.b)), 1e-3), uTint);
  if (uHasN == 1) {
    vec3 n = texture(uNrm, muv).xyz * 2.0 - 1.0;
    n.x *= uFlipX;
    n = normalize(n);
    vec3 lit = uAmb + uKeyC * max(dot(n, uKeyL), 0.0) + uFillC * max(dot(n, uFillL), 0.0);
    vec3 shade = clamp(lit / max(flatL, vec3(1e-3)), 0.0, 2.0);
    rgb *= mix(vec3(1.0), shade, uStr);
    if (uHasR == 1) rgb += uKeyC * texture(uRimT, muv).r * smoothstep(1.0 - uRimW, 1.0, 1.0 - n.z) * uRimS;
  } else if (uHasR == 1) rgb += uKeyC * texture(uRimT, muv).r * uRimW * uRimS;
  if (uHasE == 1) rgb += texture(uEmi, muv).rgb;
  float a = vOp;
  if (uMaskMode != 0) { float m = texture(uMask, gl_FragCoord.xy / uView).r; a *= uMaskMode == 2 ? 1.0 - m : m; }
  o = vec4(rgb * c.a, c.a) * a;
}`;
/** Ink outline (§8.10), in SCREEN space: the mesh's own drawn silhouette (its texture alpha inside its own triangles,
 *  rendered to uSil first) dilated by uW px (12 taps on a ring + 12 on a half ring) on a quad around the mesh; drawn
 *  before the mesh. Only the mesh's own pixels are ever read, so a neighbouring atlas cell can never leak in, and the
 *  ink may extend past the mesh's geometry (no authoring margin needed). Ink only where the art itself is (almost)
 *  transparent: a semi-transparent area (a blush) gets no ink under it. Light-responsive ink takes the key light's
 *  colour and goes lighter on the lit side. */
const VS_QUAD = `#version 300 es
in vec2 aPos; uniform vec4 uRect;
void main() { gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0); }`;
const FS_LINE = `#version 300 es
precision mediump float;
uniform sampler2D uSil; uniform sampler2D uMask; uniform int uMaskMode; uniform vec2 uView;
uniform float uW; uniform vec4 uInk; uniform int uLR; uniform vec3 uKeyC; uniform vec2 uKeyXY; uniform int uTaps; uniform float uOp;
out vec4 o;
void main() {
  vec2 fc = gl_FragCoord.xy;
  float c = texture(uSil, fc / uView).r;
  float m = 0.0; vec2 dir = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= uTaps) break;
    float t = float(i) * 6.2831853 / float(uTaps);
    vec2 d = vec2(cos(t), sin(t));
    float a = max(texture(uSil, (fc + d * uW) / uView).r, texture(uSil, (fc + d * uW * 0.5) / uView).r);
    dir += d * a;
    m = max(m, a);
  }
  float a = m * (1.0 - smoothstep(0.02, 0.15, c)) * uInk.a * uOp;
  vec3 ink = uInk.rgb;
  if (uLR == 1) {
    vec2 n = length(dir) > 1e-4 ? -normalize(dir) : vec2(0.0);
    float lit = clamp(dot(n, vec2(uKeyXY.x, uKeyXY.y)), 0.0, 1.0);
    ink = ink * uKeyC + uKeyC * 0.35 * lit;
  }
  if (uMaskMode != 0) { float mk = texture(uMask, fc / uView).r; a *= uMaskMode == 2 ? 1.0 - mk : mk; }
  o = vec4(ink * a, a);
}`;
/** The outline's silhouette pass: the mesh's texture alpha at mip level 0, its UVs clamped to the mesh's own UV box
 *  (inset half a texel), so bilinear filtering never reaches a neighbouring atlas cell. */
const FS_SIL = `#version 300 es
precision mediump float;
in highp vec2 vUv; in highp vec4 vRect;
uniform sampler2D uTex; uniform vec2 uCell;
out vec4 o;
void main() { float a = textureLod(uTex, clamp(vUv, vRect.xy, vRect.zw) + uCell, 0.0).a; o = vec4(a, a, a, a); }`;
const FS_MASK = `#version 300 es
precision mediump float;
in highp vec2 vUv; in float vOp; in vec3 vMul; in vec3 vScr; in highp vec4 vRect;
uniform sampler2D uTex; uniform highp vec2 uCell; uniform int uClamp;
out vec4 o;
${ART}
void main() { float a = art((uClamp == 1 ? clamp(vUv, vRect.xy, vRect.zw) : vUv) + uCell, 0.0, uClamp).a; o = vec4(a, a, a, a); }`;

/** Per-vertex attributes, in two buffers: positions (every frame) and the mesh's opacity / multiply / screen colour
 *  (uploaded only for meshes whose values changed: most frames none); the index buffer only when the render order
 *  changed. The old 9-float interleaved buffer + index buffer went up whole every frame (300-700 KB on heavy models). */
const ATTR = 7; // op mr mg mb sr sg sb

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  // (attribute locations are fixed for every program: 0 pos, 1 uv, 2 opacity, 3 multiply, 4 screen, 5 uv box,
  //  6 original uv (× the tail scale), 7 tail uv box)
  const p = gl.createProgram()!;
  for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(t)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`rig2d shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  for (const [i, n] of ['aPos', 'aUv', 'aOp', 'aMul', 'aScr', 'aRect', 'aUv0', 'aRect0'].entries()) gl.bindAttribLocation(p, i, n);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`rig2d link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
function prog(gl: WebGL2RenderingContext, fs: string, names: string[], samplers: Record<string, number>): Prog {
  const p = compile(gl, VS, fs);
  const u: Prog['u'] = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  gl.useProgram(p);
  for (const [n, unit] of Object.entries(samplers)) gl.uniform1i(gl.getUniformLocation(p, n), unit);
  return { p, u };
}

/** Lighting maps per texture (any may be missing). */
export interface RigMaps { normal?: ImageBitmap | HTMLCanvasElement | HTMLImageElement; emission?: ImageBitmap | HTMLCanvasElement | HTMLImageElement; rim?: ImageBitmap | HTMLCanvasElement | HTMLImageElement }

/** A texture page to upload: a decoded picture, or GPU-compressed blocks (src/avatar/flat/rig2d/textureTier.ts). */
export type RigImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement | Extract<TexturePage, { kind: 'compressed' }>;

/** How meshes map onto texture pages (the high-quality tiers: shared/rig2d/gpu/layout.ts). Absent = page i is doc
 *  texture i and every mesh draws as it is. */
export interface DrawLayout {
  /** per doc mesh; meshes past the list (attachments / particles added at load) draw whole on texPage[their texture] */
  meshes: (MeshMap | undefined)[];
  /** doc texture → the page a mesh drawing it whole uses */
  texPage: number[];
  /** page → the doc texture it comes from (sprite-sheet cells, lighting maps, filtering) */
  pageSource: number[];
  /** page → its tail page (a repacked page's coarse mip levels: the shader's art()), or −1 / absent */
  pageTail?: number[];
  /** page with a tail → the texture's UV → tail page UV scale */
  tailScale?: [number, number][];
  /** page → the texture's UV → page UV scale (a whole tier page padded to 4 × 4 blocks: < 1): sprite-sheet cells,
   *  lighting maps and meshes added at load meet the page by it; absent = [1, 1] */
  pageUv?: [number, number][];
}

/** One rig's GPU data (static uvs + triangles; dynamic vertices / indices). Each mesh is one draw item on one texture
 *  page (the high-quality tiers never cut a mesh: shared/rig2d/gpu/layout.ts); the item arrays are per mesh. */
export class RigGpu {
  readonly base: Int32Array;       // first vertex of each mesh in the combined buffers
  readonly vcount: Int32Array;     // vertices in that range
  readonly pieceStart: Int32Array; // first piece of each mesh
  readonly pieceCount: Int32Array;
  readonly pMesh: Int32Array;      // per piece: its mesh
  readonly pPage: Int32Array;      // per piece: its texture page
  readonly pVBase: Int32Array;     // per piece: first vertex
  readonly pVCount: Int32Array;
  readonly pTriStart: Int32Array;  // per piece: first index in tris
  readonly pTriCount: Int32Array;
  readonly tris: Uint32Array;      // every piece's triangles, already offset to its first vertex
  readonly pos: Float32Array;      // dynamic vertex positions (x, y)
  readonly attr: Float32Array;     // per vertex: its mesh's opacity, multiply rgb, screen rgb (ATTR floats)
  /** the per-mesh attribute values last uploaded (NaN = never / per-vertex alpha) */
  readonly meshAttr: Float32Array;
  idx: Uint32Array;                // render-order indices (+ mask meshes), rebuilt when the order changes
  /** the render order the index buffer holds now: [orderCount, ...order] */
  lastOrder: Int32Array = new Int32Array(1).fill(-1);
  /** the draw items (one per piece, in render order): piece, first index, index count */
  itemPiece: Int32Array = new Int32Array(0);
  start: Int32Array = new Int32Array(0);
  count: Int32Array = new Int32Array(0);
  items = 0;
  /** mask mesh → the first index of its pieces (in piece order) */
  maskAt = new Map<number, number>();
  idxCount = 0;
  vao: WebGLVertexArrayObject | null = null;
  vbo: WebGLBuffer | null = null;
  abo: WebGLBuffer | null = null;
  uvbo: WebGLBuffer | null = null;
  ibo: WebGLBuffer | null = null;
  iboBytes = 0;
  textures: (WebGLTexture | null)[] = [];
  mapTex: { normal: WebGLTexture | null; emission: WebGLTexture | null; rim: WebGLTexture | null }[] = [];
  gen = -1;
  /** a texture upload in progress (Rig2DRenderer.prepare): the context generation it belongs to, and the lighting maps
   *  already given to a page */
  partGen = -1;
  mapSeen = new Set<number>();
  /** the page being uploaded in parts: its texture, level and next row */
  partTex: { tex: WebGLTexture; level: number; row: number } | null = null;
  /** that page, uploaded, while its lighting maps go up (a page counts once its maps are there too) */
  partPage: WebGLTexture | null = null;
  /** its lighting maps still to upload, the one in progress (rows done), and what is done */
  partMaps: { kind: 'normal' | 'emission' | 'rim'; src: TexImageSource; premul: boolean }[] | null = null;
  partMap: { tex: WebGLTexture; row: number } | null = null;
  partMapOut: { normal: WebGLTexture | null; emission: WebGLTexture | null; rim: WebGLTexture | null } = { normal: null, emission: null, rim: null };
  readonly vertexCount: number;
  readonly uvs: Float32Array;
  /** per vertex: its piece's UV box (u0, v0, u1, v1), inset half a texel (outline silhouettes) */
  readonly rects: Float32Array;
  rectbo: WebGLBuffer | null = null;
  /** per vertex on a page with a tail: the mesh's own UV in the tail page, and the mesh's UV box there (else zeros) */
  readonly uv0s: Float32Array;
  readonly rect0s: Float32Array;
  uv0bo: WebGLBuffer | null = null;
  rect0bo: WebGLBuffer | null = null;
  /** clamp colour / mask texture reads to each mesh's UV box (native rigs; converted Live2D / Inochi2D rigs sample as
   *  their source renderer does). The outline silhouette always clamps. */
  readonly clampUv: boolean;
  /** the model asks for room lighting (lighting block or any lighting map) */
  readonly lit: boolean;
  readonly anyOutline: boolean;
  readonly layout: DrawLayout;
  constructor(readonly doc: Rig2DDoc, buffers: readonly Uint8Array[], readonly images: RigImage[], readonly maps: RigMaps[] = [], layout?: DrawLayout) {
    const n = doc.meshes.length;
    this.layout = layout ?? { meshes: [], texPage: doc.textures.map((_, i) => i), pageSource: doc.textures.map((_, i) => i) };
    const L = this.layout;
    type P = { mesh: number; page: number; uv: Float32Array; tri: ArrayLike<number>; vc: number };
    const ps: P[] = [];
    this.base = new Int32Array(n); this.vcount = new Int32Array(n); this.pieceStart = new Int32Array(n); this.pieceCount = new Int32Array(n);
    let v = 0, t = 0;
    doc.meshes.forEach((m, i) => {
      const mm = L.meshes[i], uv0 = f32(buffers, m.uvs);
      this.base[i] = v; this.pieceStart[i] = ps.length;
      // (a mesh added at load (attachment / particle) draws its texture whole: its page's UV scale)
      const page = mm ? mm.page : (L.texPage[m.texture] ?? m.texture), pu = L.pageUv?.[page] ?? [1, 1];
      const [su, sv, ou, ov] = mm ? mm.uv : [pu[0], pu[1], 0, 0];
      const uv = su === 1 && sv === 1 && ou === 0 && ov === 0 ? uv0 : uv0.map((x, k) => (k & 1 ? x * sv + ov : x * su + ou));
      ps.push({ mesh: i, page, uv, tri: viewArray(buffers, m.indices), vc: m.vertexCount });
      v += m.vertexCount; t += m.indices.count;
      this.pieceCount[i] = ps.length - this.pieceStart[i];
      this.vcount[i] = v - this.base[i];
    });
    const np = ps.length;
    this.pMesh = new Int32Array(np); this.pPage = new Int32Array(np); this.pVBase = new Int32Array(np); this.pVCount = new Int32Array(np);
    this.pTriStart = new Int32Array(np); this.pTriCount = new Int32Array(np);
    this.vertexCount = v;
    this.uvs = new Float32Array(v * 2);
    this.tris = new Uint32Array(t);
    this.rects = new Float32Array(v * 4);
    this.uv0s = new Float32Array(v * 2);
    this.rect0s = new Float32Array(v * 4);
    const pageSize = (p: number) => { const im = images[p] as { width?: number; height?: number } | undefined; const tx = doc.textures[L.pageSource[p] ?? p]; return [im?.width || tx?.width || 1, im?.height || tx?.height || 1]; };
    let vb = 0, tb = 0;
    ps.forEach((p, q) => {
      this.pMesh[q] = p.mesh; this.pPage[q] = p.page; this.pVBase[q] = vb; this.pVCount[q] = p.vc; this.pTriStart[q] = tb; this.pTriCount[q] = p.tri.length;
      this.uvs.set(p.uv.subarray(0, p.vc * 2), vb * 2);
      for (let k = 0; k < p.tri.length; k++) this.tris[tb + k] = p.tri[k] + vb;
      // the clamp box, inset half a texel of its page: the mesh's UV box
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let k = 0; k < p.vc; k++) { const u = p.uv[k * 2], w = p.uv[k * 2 + 1]; if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < v0) v0 = w; if (w > v1) v1 = w; }
      const [pw, ph] = pageSize(p.page), hu = 0.5 / pw, hv = 0.5 / ph;
      const r = [Math.min(u0 + hu, (u0 + u1) / 2), Math.min(v0 + hv, (v0 + v1) / 2), Math.max(u1 - hu, (u0 + u1) / 2), Math.max(v1 - hv, (v0 + v1) / 2)];
      for (let k = 0; k < p.vc; k++) this.rects.set(r, (vb + k) * 4);
      // the tail (repacked pages): each vertex's ORIGINAL texture UV in the tail page, and the mesh's box there inset
      // half a texel of the page (the box the original picture is clamped to)
      const tp = L.pageTail?.[p.page] ?? -1, ts = tp >= 0 ? L.tailScale?.[p.page] : undefined;
      if (tp >= 0 && ts) {
        const sc = ts, ou = f32(buffers, doc.meshes[p.mesh].uvs), [tw, th] = pageSize(tp);
        let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
        for (let k = 0; k < ou.length; k += 2) { const u = ou[k] * sc[0], w = ou[k + 1] * sc[1]; if (u < a0) a0 = u; if (u > a1) a1 = u; if (w < b0) b0 = w; if (w > b1) b1 = w; }
        const iu = 0.5 / (tw * 2 ** TAIL), iv = 0.5 / (th * 2 ** TAIL);
        const r0 = [Math.min(a0 + iu, (a0 + a1) / 2), Math.min(b0 + iv, (b0 + b1) / 2), Math.max(a1 - iu, (a0 + a1) / 2), Math.max(b1 - iv, (b0 + b1) / 2)];
        for (let k = 0; k < p.vc; k++) {
          this.uv0s[(vb + k) * 2] = ou[k * 2] * sc[0]; this.uv0s[(vb + k) * 2 + 1] = ou[k * 2 + 1] * sc[1];
          this.rect0s.set(r0, (vb + k) * 4);
        }
      }
      vb += p.vc; tb += p.tri.length;
    });
    this.pos = new Float32Array(v * 2);
    this.attr = new Float32Array(v * ATTR);
    this.meshAttr = new Float32Array(n * ATTR).fill(NaN);
    this.idx = new Uint32Array(t * 2);
    const kind = doc.meta.source?.kind ?? 'native';
    this.clampUv = kind === 'native';
    this.lit = !!doc.lighting || maps.some((m) => m && (m.normal || m.emission || m.rim));
    this.anyOutline = doc.meshes.some((m) => m.outline && m.outline.width > 0);
  }
  /** Page p's doc texture. */
  pageTex(p: number) { return this.layout.pageSource[p] ?? p; }
}

/** The room light as the renderer wants it (shared/rig2d/world.ts gives it; directions = where the light travels,
 *  view space x right, y up, z toward the viewer). */
export interface DrawLight { key: { dir: number[]; color: number[] }; fill: { dir: number[]; color: number[] }; ambient: number[]; show: number[] }

export interface DrawOpts {
  /** output size in px */
  width: number;
  height: number;
  /** the model-unit rectangle shown: [x0, y0, x1, y1] (x right, y down) */
  view: [number, number, number, number];
  /** whole-puppet opacity */
  opacity?: number;
  /** per-mesh x / y offsets in model units (2.5D parallax), or null */
  offsets?: Float32Array | null;
  /** mirror horizontally */
  flip?: boolean;
  /** sprite-sheet UV offsets per texture (u, v), or null */
  cells?: Float32Array | null;
  /** room light (lit models only) */
  light?: DrawLight | null;
  /** 'low' = no lighting maps, 6-tap outlines (degraded); default 'high' */
  quality?: 'low' | 'medium' | 'high';
}

const norm3 = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export class Rig2DRenderer {
  private static inst: Rig2DRenderer | null = null;
  /** The page's shared renderer (created on first use). */
  static shared(): Rig2DRenderer { return (Rig2DRenderer.inst ??= new Rig2DRenderer()); }

  readonly canvas: HTMLCanvasElement;
  gl!: WebGL2RenderingContext;
  private base!: Prog;
  private litP!: Prog;
  private lineP!: Prog;
  private maskP!: Prog;
  private silP!: Prog;
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadVbo: WebGLBuffer | null = null;
  /** the outlined mesh's silhouette (output size; reused mesh by mesh) */
  private sil: { fbo: WebGLFramebuffer; tex: WebGLTexture } | null = null;
  private silW = 0; private silH = 0;
  /** mask render targets (output size); `dirty` = the pixel rect drawn last time [x0, y0, x1, y1] (cleared before reuse) */
  private masks: { fbo: WebGLFramebuffer; tex: WebGLTexture; key: string; dirty: [number, number, number, number] | null }[] = [];
  private maskW = 0; private maskH = 0;
  /** bumped when the context is (re)created: rigs re-upload */
  gen = 0;
  lost = false;
  private users = 0;
  /** culling winding: triangles that are front-facing in model space (y down) */
  frontCW = true;
  /** GPU objects alive in this renderer (leak checks: tools/live2d_soak_e2e.mjs; the studio's 2D panel) */
  readonly live = { rigs: 0, textures: 0, buffers: 0, vaos: 0, framebuffers: 0 };

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2; this.canvas.height = 2;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); });
    this.init();
  }
  private init() {
    // (globalThis.__vtpRig2dAA = false: tests only, tools/hiq_e2e.mts --seam-noaa)
    const aa = (globalThis as { __vtpRig2dAA?: boolean }).__vtpRig2dAA !== false;
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: aa, preserveDrawingBuffer: true, stencil: false, depth: false });
    if (!gl) throw new Error('WebGL 2 is not available for 2D rigs.');
    this.gl = gl;
    // compressed texture pages (textureTier.ts): a WebGL extension only works on the context that asked for it
    for (const e of ['WEBGL_compressed_texture_astc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_etc', 'WEBGL_compressed_texture_s3tc']) gl.getExtension(e);
    const common = ['uXf', 'uMaskMode', 'uView', 'uBias', 'uCell', 'uClamp', 'uTailOn', 'uTailSize'];
    this.base = prog(gl, FS, common, { uTex: 0, uMask: 1, uTail: 6 });
    this.litP = prog(gl, FS_LIT, [...common, 'uHasN', 'uHasE', 'uHasR', 'uKeyL', 'uKeyC', 'uFillL', 'uFillC', 'uAmb', 'uStr', 'uRimW', 'uRimS', 'uTint', 'uFlipX', 'uMapUv'], { uTex: 0, uMask: 1, uNrm: 2, uEmi: 3, uRimT: 4, uTail: 6 });
    {
      const p = compile(gl, VS_QUAD, FS_LINE), u: Prog['u'] = {};
      for (const n of ['uMaskMode', 'uView', 'uW', 'uInk', 'uLR', 'uKeyC', 'uKeyXY', 'uTaps', 'uOp', 'uRect']) u[n] = gl.getUniformLocation(p, n);
      gl.useProgram(p); gl.uniform1i(gl.getUniformLocation(p, 'uSil'), 5); gl.uniform1i(gl.getUniformLocation(p, 'uMask'), 1);
      this.lineP = { p, u };
      this.quadVao = gl.createVertexArray(); gl.bindVertexArray(this.quadVao);
      this.quadVbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo); gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.sil = null; this.silW = this.silH = 0;
    }
    this.maskP = prog(gl, FS_MASK, ['uXf', 'uCell', 'uClamp', 'uTailOn', 'uTailSize'], { uTex: 0, uTail: 6 });
    this.silP = prog(gl, FS_SIL, ['uXf', 'uCell'], { uTex: 0 });
    this.masks = []; this.maskW = this.maskH = 0;
    Object.assign(this.live, { rigs: 0, textures: 0, buffers: 0, vaos: 0, framebuffers: 0 });
    this.mapShared = new Map();
    this.gen++;
  }
  retain() { this.users++; }
  /** The shared context stays for the page's lifetime (creating / losing WebGL contexts repeatedly is what browsers
   *  punish); its memory is the rigs' buffers + textures, which free() releases. */
  release() { this.users = Math.max(0, this.users - 1); }

  /** An empty RGBA8 texture for a lighting map uploaded in strips (storage for its full mip chain, made at the end). */
  private mapStorage(w: number, h: number): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    this.live.textures++;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return t;
  }
  /** Rows [y, y + rows) of a lighting map's picture into its texture (WebGL 2: a sub-rectangle of the picture, chosen
   *  with UNPACK_SKIP_ROWS; no copy of the picture is made). */
  private mapStrip(t: WebGLTexture, src: TexImageSource, premul: boolean, w: number, y: number, rows: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul && !(typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap));
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  /** lighting-map textures by their picture, shared by every rig that uses that picture (a tier switch: the new rig
   *  takes the old one's), deleted when the last one is freed */
  private mapShared = new Map<TexImageSource, { tex: WebGLTexture; refs: number }>();

  /** An empty texture for a tier page (immutable storage for every level it has), sampled as tex() sets it up. */
  private texStorage(img: Extract<RigImage, { kind: 'compressed' }>, nearest: boolean): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    this.live.textures++;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, img.levels.length, img.format, img.width, img.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : img.levels.length > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, img.levels.length - 1);
    return t;
  }

  private tex(img: RigImage, nearest: boolean, premul: boolean) {
    const gl = this.gl, t = gl.createTexture()!;
    this.live.textures++;
    gl.bindTexture(gl.TEXTURE_2D, t);
    if ('kind' in img) {
      // GPU-compressed page (the hiq lane's tiers): every mip level given, uploaded as is
      if (img.format === gl.RGBA8) {
        // uncompressed pages with their own (premultiplied, area-averaged) mip chain: no GPU mip generation
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        img.levels.forEach((lv, i) => gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA8, Math.max(1, img.width >> i), Math.max(1, img.height >> i), 0, gl.RGBA, gl.UNSIGNED_BYTE, lv));
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      } else img.levels.forEach((lv, i) => gl.compressedTexImage2D(gl.TEXTURE_2D, i, img.format, Math.max(1, img.width >> i), Math.max(1, img.height >> i), 0, lv));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : img.levels.length > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, img.levels.length - 1);
      return t;
    }
    // ImageBitmaps carry their own alpha mode (decoded by the loader; WebGL ignores UNPACK_* for them)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul && !(typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap));
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    if (nearest) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    else { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    return t;
  }

  /** A page's tail (repacked pages: shared/rig2d/gpu/layout.ts TAIL) on unit 6 + the program's tail uniforms. */
  private bindTail(r: RigGpu, P: Prog, pg: number) {
    const gl = this.gl, tp = r.layout.pageTail?.[pg] ?? -1;
    gl.uniform1i(P.u.uTailOn, tp >= 0 ? 1 : 0);
    if (tp < 0) return;
    const im = r.images[tp] as { width: number; height: number };
    gl.uniform2f(P.u.uTailSize, im.width, im.height);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, r.textures[tp]); gl.activeTexture(gl.TEXTURE0);
  }

  /** Upload a rig's static data + textures (again after a context loss). */
  upload(r: RigGpu) {
    if (r.gen === this.gen) return;
    while (!this.prepare(r, Infinity)) if (this.lost) return;
  }

  /** Upload a rig ahead of use, a part per call (a tier switch while live: the previous rig keeps drawing meanwhile):
   *  its buffers, then texture pages until `budget` bytes went up (at least one page). True when all of it is there. */
  prepare(r: RigGpu, budget: number): boolean {
    if (r.gen === this.gen) return true;
    if (this.lost) return false;
    if (r.partGen !== this.gen) {
      this.uploadBuffers(r); r.textures = []; r.mapTex = []; r.mapSeen.clear();
      r.partTex = null; r.partPage = null; r.partMaps = null; r.partMap = null; r.partGen = this.gen;
    }
    let used = 0;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);   // (draw() binds every unit it uses again)
    while (r.textures.length < r.images.length && (used === 0 || used < budget)) {
      const i = r.textures.length, img = r.images[i];
      const nearest = r.doc.textures[r.pageTex(i)]?.filter === 'nearest';
      if (!r.partPage) {
        if ('kind' in img && budget !== Infinity) {
          // a tier page (compressed or RGBA8 with its own mips): storage first, then its levels in strips of rows, so no
          // single step uploads more than about `budget` bytes
          let p = r.partTex;
          if (!p) { p = r.partTex = { tex: this.texStorage(img, nearest), level: 0, row: 0 }; }
          gl.bindTexture(gl.TEXTURE_2D, p.tex);
          const block = img.format === gl.RGBA8 ? 1 : 4, perRow = (lw: number) => (img.format === gl.RGBA8 ? lw * 4 : Math.ceil(lw / 4) * 16);
          if (img.format === gl.RGBA8) { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); }
          while (p.level < img.levels.length && (used === 0 || used < budget)) {
            const L = p.level, lw = Math.max(1, img.width >> L), lh = Math.max(1, img.height >> L), lv = img.levels[L], rb = perRow(lw);
            // rows (in blocks) that fit the rest of the budget, at least one block row
            const blocksLeft = Math.ceil((lh - p.row) / block), take = Math.max(1, Math.min(blocksLeft, Math.floor(Math.max(0, budget - used) / rb)));
            const y = p.row, hh = Math.min(lh - y, take * block), from = (y / block) * rb, to = from + Math.ceil(hh / block) * rb;
            if (img.format === gl.RGBA8) gl.texSubImage2D(gl.TEXTURE_2D, L, 0, y, lw, hh, gl.RGBA, gl.UNSIGNED_BYTE, lv.subarray(from, to));
            else gl.compressedTexSubImage2D(gl.TEXTURE_2D, L, 0, y, lw, hh, img.format, lv.subarray(from, to));
            used += to - from;
            p.row += hh;
            if (p.row >= lh) { p.level++; p.row = 0; }
          }
          if (img.format === gl.RGBA8) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
          if (p.level < img.levels.length) break;
          r.partTex = null;
          r.partPage = p.tex;
        } else {
          r.partPage = this.tex(img, nearest, true);
          used += 'kind' in img ? img.levels.reduce((a, l) => a + l.byteLength, 0) : (img.width * img.height * 16) / 3;
        }
        // its lighting maps (they belong to a texture that is always one whole page: layout.ts wholeTextures)
        const t = r.pageTex(i), m = r.mapSeen.has(t) ? {} : (r.maps[t] ?? {});
        r.mapSeen.add(t);
        r.partMaps = ([['normal', m.normal, false], ['emission', m.emission, true], ['rim', m.rim, false]] as const)
          .filter((x) => !!x[1]).map(([kind, src, premul]) => ({ kind, src: src as TexImageSource, premul }));
        r.partMapOut = { normal: null, emission: null, rim: null };
        if (used >= budget && r.partMaps.length) break;
      }
      // the lighting maps: the same pictures as the rig drawing now (a tier switch) are shared, never uploaded again;
      // a new one goes up in strips of rows like the pages, its mips made once it is complete
      while (r.partMaps!.length && (used === 0 || used < budget)) {
        const q = r.partMaps![0];
        const shared = this.mapShared.get(q.src);
        if (shared && !(globalThis as { __vtpRig2dNoMapShare?: boolean }).__vtpRig2dNoMapShare) { shared.refs++; r.partMapOut[q.kind] = shared.tex; r.partMaps!.shift(); continue; }
        const w = (q.src as { width: number }).width, h = (q.src as { height: number }).height;
        if (budget === Infinity) {
          const tex = this.tex(q.src as RigImage, false, q.premul);
          this.mapShared.set(q.src, { tex, refs: 1 });
          r.partMapOut[q.kind] = tex; r.partMaps!.shift(); used += w * h * 16 / 3;
          continue;
        }
        const pm = r.partMap ??= { tex: this.mapStorage(w, h), row: 0 };
        const rows = Math.max(1, Math.min(h - pm.row, Math.floor(Math.max(0, budget - used) / (w * 4))));
        this.mapStrip(pm.tex, q.src, q.premul, w, pm.row, rows);
        used += w * rows * 4; pm.row += rows;
        if (pm.row < h) break;
        gl.bindTexture(gl.TEXTURE_2D, pm.tex); gl.generateMipmap(gl.TEXTURE_2D);
        used += w * h * 4 / 3;   // (the mips, made on the GPU)
        this.mapShared.set(q.src, { tex: pm.tex, refs: 1 });
        r.partMapOut[q.kind] = pm.tex; r.partMap = null; r.partMaps!.shift();
      }
      if (r.partMaps!.length) break;
      r.textures.push(r.partPage); r.mapTex.push(r.partMapOut);
      r.partPage = null; r.partMaps = null; r.partMapOut = { normal: null, emission: null, rim: null };
    }
    if (r.textures.length < r.images.length) return false;
    r.gen = this.gen;
    return true;
  }

  private uploadBuffers(r: RigGpu) {
    const gl = this.gl;
    r.vao = gl.createVertexArray(); gl.bindVertexArray(r.vao);
    r.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.vbo); gl.bufferData(gl.ARRAY_BUFFER, r.pos.byteLength, gl.DYNAMIC_DRAW);
    const F = 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * F, 0);
    r.abo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.abo); gl.bufferData(gl.ARRAY_BUFFER, r.attr.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, ATTR * F, 0);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, ATTR * F, 1 * F);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, ATTR * F, 4 * F);
    // (a new context starts from nothing: every attribute and the index buffer go up on the first draw)
    r.meshAttr.fill(NaN); r.lastOrder = new Int32Array(1).fill(-1);
    r.uvbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.uvbo); gl.bufferData(gl.ARRAY_BUFFER, r.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    r.rectbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.rectbo); gl.bufferData(gl.ARRAY_BUFFER, r.rects, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 0, 0);
    r.uv0bo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.uv0bo); gl.bufferData(gl.ARRAY_BUFFER, r.uv0s, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 0, 0);
    r.rect0bo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, r.rect0bo); gl.bufferData(gl.ARRAY_BUFFER, r.rect0s, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 4, gl.FLOAT, false, 0, 0);
    r.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, r.idx.byteLength, gl.DYNAMIC_DRAW); r.iboBytes = r.idx.byteLength;
    gl.bindVertexArray(null);
    this.live.rigs++; this.live.buffers += 7; this.live.vaos++;
  }

  free(r: RigGpu) {
    if ((r.gen !== this.gen && r.partGen !== this.gen) || this.lost) { r.partGen = -1; return; }
    const gl = this.gl;
    for (const t of r.textures) if (t) { gl.deleteTexture(t); this.live.textures--; }
    if (r.partTex) { gl.deleteTexture(r.partTex.tex); this.live.textures--; r.partTex = null; }
    if (r.partPage) { gl.deleteTexture(r.partPage); this.live.textures--; r.partPage = null; }
    if (r.partMap) { gl.deleteTexture(r.partMap.tex); this.live.textures--; r.partMap = null; }
    // (lighting maps are shared by picture: deleted when no rig uses them any more)
    for (const m of [...r.mapTex, r.partMapOut]) for (const t of [m.normal, m.emission, m.rim]) {
      if (!t) continue;
      const e = [...this.mapShared].find(([, v]) => v.tex === t);
      if (e && --e[1].refs > 0) continue;
      if (e) this.mapShared.delete(e[0]);
      gl.deleteTexture(t); this.live.textures--;
    }
    r.partMaps = null; r.partMapOut = { normal: null, emission: null, rim: null };
    gl.deleteBuffer(r.vbo); gl.deleteBuffer(r.abo); gl.deleteBuffer(r.uvbo); gl.deleteBuffer(r.rectbo); gl.deleteBuffer(r.uv0bo); gl.deleteBuffer(r.rect0bo); gl.deleteBuffer(r.ibo); gl.deleteVertexArray(r.vao);
    this.live.rigs--; this.live.buffers -= 7; this.live.vaos--;
    r.gen = -1; r.partGen = -1; r.textures = []; r.mapTex = [];
  }

  private maskTex(w: number, h: number) {
    const gl = this.gl;
    if (w !== this.maskW || h !== this.maskH) {
      for (const m of this.masks) { gl.deleteFramebuffer(m.fbo); gl.deleteTexture(m.tex); this.live.framebuffers--; this.live.textures--; }
      this.masks = []; this.maskW = w; this.maskH = h;
    }
    while (this.masks.length < 4) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      this.masks.push({ fbo, tex, key: '', dirty: null });
      this.live.framebuffers++; this.live.textures++;
    }
  }

  private silTex(w: number, h: number) {
    const gl = this.gl;
    if (!this.sil || this.silW !== w || this.silH !== h) {
      if (this.sil) { gl.deleteFramebuffer(this.sil.fbo); gl.deleteTexture(this.sil.tex); this.live.framebuffers--; this.live.textures--; }
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.sil = { fbo, tex }; this.silW = w; this.silH = h;
      this.live.framebuffers++; this.live.textures++;
    }
    return this.sil;
  }

  /** Draw a rig's evaluated pose into the shared canvas (bottom-left w × h) and copy it into `target`. */
  draw(r: RigGpu, ev: EvalOut, o: DrawOpts, target: CanvasRenderingContext2D) {
    if (this.lost) return;
    this.upload(r);
    const gl = this.gl, doc = r.doc, w = Math.max(1, Math.round(o.width)), h = Math.max(1, Math.round(o.height));
    if (this.canvas.width < w || this.canvas.height < h) { this.canvas.width = Math.max(this.canvas.width, w); this.canvas.height = Math.max(this.canvas.height, h); }
    // vertex positions (every frame)
    const V = r.pos, A = r.attr, MA = r.meshAttr, op0 = o.opacity ?? 1, off = o.offsets;
    let aLo = Infinity, aHi = -1;
    for (let i = 0; i < doc.meshes.length; i++) {
      const p = ev.positions[i], b = r.base[i], n = r.vcount[i];
      const dx = off ? off[i * 2] : 0, dy = off ? off[i * 2 + 1] : 0;
      if (dx || dy) for (let k = 0; k < n * 2; k += 2) { V[b * 2 + k] = p[k] + dx; V[b * 2 + k + 1] = p[k + 1] + dy; }
      else V.set(p.subarray(0, n * 2), b * 2);
      // opacity / colours: rewritten (and uploaded) only when they changed
      const op = ev.opacity[i] * op0, va = ev.alpha?.[i] ?? null, j = i * ATTR;
      const mr = ev.multiply[i * 3], mg = ev.multiply[i * 3 + 1], mb = ev.multiply[i * 3 + 2], sr = ev.screen[i * 3], sg = ev.screen[i * 3 + 1], sb = ev.screen[i * 3 + 2];
      if (!va && MA[j] === Math.fround(op) && MA[j + 1] === Math.fround(mr) && MA[j + 2] === Math.fround(mg) && MA[j + 3] === Math.fround(mb) && MA[j + 4] === Math.fround(sr) && MA[j + 5] === Math.fround(sg) && MA[j + 6] === Math.fround(sb)) continue;
      MA[j] = va ? NaN : op; MA[j + 1] = mr; MA[j + 2] = mg; MA[j + 3] = mb; MA[j + 4] = sr; MA[j + 5] = sg; MA[j + 6] = sb;
      for (let k = 0, q = b * ATTR; k < n; k++, q += ATTR) { A[q] = va ? op * va[k] : op; A[q + 1] = mr; A[q + 2] = mg; A[q + 3] = mb; A[q + 4] = sr; A[q + 5] = sg; A[q + 6] = sb; }
      if (b < aLo) aLo = b; if (b + n > aHi) aHi = b + n;
    }
    // indices in render order, mask meshes appended after: rebuilt only when the order changed
    let same = r.lastOrder.length === ev.orderCount + 1 && r.lastOrder[0] === ev.orderCount;
    for (let k = 0; same && k < ev.orderCount; k++) if (r.lastOrder[k + 1] !== ev.order[k]) same = false;
    let ni = r.idxCount;
    if (!same) {
      ni = 0;
      // one draw item per piece, in render order (a mesh on one page = one item, as before pages existed)
      let items = 0;
      for (let k = 0; k < ev.orderCount; k++) items += r.pieceCount[ev.order[k]];
      if (r.start.length < items) { r.start = new Int32Array(items); r.count = new Int32Array(items); r.itemPiece = new Int32Array(items); }
      let it = 0;
      for (let k = 0; k < ev.orderCount; k++) {
        const m = ev.order[k];
        for (let q = r.pieceStart[m]; q < r.pieceStart[m] + r.pieceCount[m]; q++) {
          const s0 = r.pTriStart[q], c = r.pTriCount[q];
          r.itemPiece[it] = q; r.start[it] = ni; r.count[it] = c; it++;
          r.idx.set(r.tris.subarray(s0, s0 + c), ni); ni += c;
        }
      }
      r.items = items;
      r.maskAt.clear();
      for (let k = 0; k < ev.orderCount; k++) for (const mk of doc.meshes[ev.order[k]].masks) {
        if (r.maskAt.has(mk)) continue;
        const s0 = r.pTriStart[r.pieceStart[mk]], c = r.pieceCount[mk] ? r.pTriStart[r.pieceStart[mk] + r.pieceCount[mk] - 1] + r.pTriCount[r.pieceStart[mk] + r.pieceCount[mk] - 1] - s0 : 0;
        if (ni + c > r.idx.length) { const bigger = new Uint32Array((ni + c) * 2); bigger.set(r.idx.subarray(0, ni)); r.idx = bigger; }
        r.maskAt.set(mk, ni); r.idx.set(r.tris.subarray(s0, s0 + c), ni); ni += c;
      }
      r.idxCount = ni;
      r.lastOrder = new Int32Array(ev.orderCount + 1); r.lastOrder[0] = ev.orderCount; r.lastOrder.set(ev.order.subarray(0, ev.orderCount), 1);
    }
    const start = r.start, count = r.count, maskAt = r.maskAt;
    gl.bindVertexArray(r.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, V);
    if (aHi > aLo) { gl.bindBuffer(gl.ARRAY_BUFFER, r.abo); gl.bufferSubData(gl.ARRAY_BUFFER, aLo * ATTR * 4, A, aLo * ATTR, (aHi - aLo) * ATTR); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.ibo);
    if (!same) {
      // (the size is tracked here: gl.getBufferParameter is a synchronous GPU round trip that stalled ~9 ms a frame)
      if (r.idx.byteLength > r.iboBytes) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, r.idx.byteLength, gl.DYNAMIC_DRAW); r.iboBytes = r.idx.byteLength; }
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, r.idx.subarray(0, ni));
    }
    // model units → clip
    const [x0, y0, x1, y1] = o.view;
    const sx = 2 / (x1 - x0) * (o.flip ? -1 : 1), sy = -2 / (y1 - y0);
    const tx = o.flip ? 1 + 2 * x0 / (x1 - x0) : -1 - 2 * x0 / (x1 - x0), ty = 1 + 2 * y0 / (y1 - y0);
    const flipWinding = !!o.flip;
    const cells = o.cells ?? null, pageUv = r.layout.pageUv;
    // page pg's sprite-sheet cell offset: its texture's (texture UV), × the page's UV scale (a page padded to 4 × 4 blocks)
    const cellU = (pg: number) => (cells ? cells[r.pageTex(pg) * 2] * (pageUv?.[pg]?.[0] ?? 1) : 0);
    const cellV = (pg: number) => (cells ? cells[r.pageTex(pg) * 2 + 1] * (pageUv?.[pg]?.[1] ?? 1) : 0);
    // masks
    let anyMask = false;
    for (let k = 0; k < ev.orderCount; k++) if (doc.meshes[ev.order[k]].masks.length) { anyMask = true; break; }
    if (anyMask) this.maskTex(w, h);
    for (const m of this.masks) m.key = '';
    let rr = 0;
    let cur: Prog = this.base;
    let lastTex = -1;
    const maskFor = (meshIdx: number): WebGLTexture => {
      const ms = doc.meshes[meshIdx].masks;
      const key = ms.join(',');
      const hit = this.masks.find((x) => x.key === key);
      if (hit) return hit.tex;
      const slot = this.masks[rr++ % this.masks.length];
      slot.key = key;
      // only the mask meshes' screen box is cleared and drawn (and the box drawn last time cleared): masks are usually
      // small (eyes, a mouth), the targets are output-sized
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const mk of ms) {
        const b0 = r.base[mk] * 2, nv = r.vcount[mk];
        for (let q = 0, o2 = b0; q < nv; q++, o2 += 2) {
          const px = ((V[o2] * sx + tx) * 0.5 + 0.5) * w, py = ((V[o2 + 1] * sy + ty) * 0.5 + 0.5) * h;
          if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py;
        }
      }
      const nb: [number, number, number, number] = [Math.max(0, Math.floor(bx0) - 2), Math.max(0, Math.floor(by0) - 2), Math.min(w, Math.ceil(bx1) + 2), Math.min(h, Math.ceil(by1) + 2)];
      const d0 = slot.dirty;
      const cx0 = d0 ? Math.min(d0[0], nb[0]) : nb[0], cy0 = d0 ? Math.min(d0[1], nb[1]) : nb[1], cx1 = d0 ? Math.max(d0[2], nb[2]) : nb[2], cy1 = d0 ? Math.max(d0[3], nb[3]) : nb[3];
      slot.dirty = nb[2] > nb[0] && nb[3] > nb[1] ? nb : null;
      // never render into a texture that is still bound for sampling (the previous masked draw's unit 1)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fbo);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);
      if (cx1 > cx0 && cy1 > cy0) { gl.scissor(cx0, cy0, cx1 - cx0, cy1 - cy0); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.scissor(nb[0], nb[1], Math.max(0, nb[2] - nb[0]), Math.max(0, nb[3] - nb[1]));
      gl.useProgram(this.maskP.p);
      gl.uniform4f(this.maskP.u.uXf, sx, sy, tx, ty); gl.uniform1i(this.maskP.u.uClamp, r.clampUv ? 1 : 0);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      for (const mk of ms) {
        let at = maskAt.get(mk)!;
        for (let q = r.pieceStart[mk]; q < r.pieceStart[mk] + r.pieceCount[mk]; q++) {
          const pg = r.pPage[q];
          gl.uniform2f(this.maskP.u.uCell, cellU(pg), cellV(pg));
          gl.bindTexture(gl.TEXTURE_2D, r.textures[pg]);
          this.bindTail(r, this.maskP, pg);
          gl.drawElements(gl.TRIANGLES, r.pTriCount[q], gl.UNSIGNED_INT, at * 4);
          at += r.pTriCount[q];
        }
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.blendEquation(gl.FUNC_ADD);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(cur.p);
      lastTex = -1;
      return slot.tex;
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    // program: the original one, or the room-lit one (lit models, not on Low)
    const quality = o.quality ?? 'high';
    const lit = r.lit && quality !== 'low';
    const L = o.light ?? { key: { dir: [0.45, -0.55, -0.7], color: [1, 1, 1] }, fill: { dir: [-0.6, 0.1, -0.8], color: [0.35, 0.38, 0.45] }, ambient: [0.45, 0.45, 0.48], show: [0, 0, 0] };
    const keyL = norm3(L.key.dir).map((x) => -x), fillL = norm3(L.fill.dir).map((x) => -x);
    if (o.flip) { keyL[0] = -keyL[0]; fillL[0] = -fillL[0]; }
    const keyC = [L.key.color[0] + L.show[0] * 0.6, L.key.color[1] + L.show[1] * 0.6, L.key.color[2] + L.show[2] * 0.6];
    cur = lit ? this.litP : this.base;
    const setCommon = (P: Prog) => {
      gl.useProgram(P.p);
      gl.uniform4f(P.u.uXf, sx, sy, tx, ty);
      if (P.u.uView) gl.uniform2f(P.u.uView, w, h);
      if (P.u.uBias) gl.uniform1f(P.u.uBias, this.lodBias);
      gl.uniform1i(P.u.uClamp, r.clampUv ? 1 : 0);
    };
    setCommon(cur);
    if (lit) {
      const U = this.litP.u, lg = doc.lighting;
      gl.uniform3fv(U.uKeyL, keyL); gl.uniform3fv(U.uKeyC, keyC); gl.uniform3fv(U.uFillL, fillL); gl.uniform3fv(U.uFillC, L.fill.color); gl.uniform3fv(U.uAmb, L.ambient);
      gl.uniform1f(U.uStr, Math.min(1, Math.max(0, lg?.strength ?? 0.8))); gl.uniform1f(U.uRimW, Math.min(1, Math.max(0, lg?.rim?.width ?? 0.35)));
      gl.uniform1f(U.uRimS, Math.min(2, Math.max(0, lg?.rim?.strength ?? (lg?.rim ? 1 : 0.6)))); gl.uniform1f(U.uTint, Math.min(1, Math.max(0, lg?.tint ?? 0)));
      gl.uniform1f(U.uFlipX, o.flip ? -1 : 1);
    }
    const pxPerUnit = h / (y1 - y0), unit = doc.canvas.unit ?? 1;
    gl.enable(gl.BLEND);
    gl.frontFace(this.frontCW !== flipWinding ? gl.CW : gl.CCW);
    gl.cullFace(gl.BACK);
    let k = 0;
    const items = r.items, itemPiece = r.itemPiece;
    while (k < items) {
      // (items = pieces in render order; a masked / outlined mesh is drawn on its own, all its pieces together)
      const q0 = itemPiece[k], mi = r.pMesh[q0], m = doc.meshes[mi], page0 = r.pPage[q0];
      const masked = m.masks.length > 0 && !this.debugNoMask;
      const outlined = !!m.outline && m.outline.width > 0 && !this.debugNoOutline;
      let e = k + 1;
      if (masked || outlined) e = k + r.pieceCount[mi];
      else while (e < items) {
        const q2 = itemPiece[e], n = doc.meshes[r.pMesh[q2]];
        if (n.masks.length || r.pPage[q2] !== page0 || n.blend !== m.blend || n.doubleSided !== m.doubleSided || (n.outline && n.outline.width > 0)) break;
        e++;
      }
      let maskTex: WebGLTexture | null = null;
      if (masked) maskTex = maskFor(mi);
      if (m.doubleSided || this.debugNoCull) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      // outline pass (behind the mesh), in screen space from the mesh's own silhouette
      if (outlined) {
        const ol = m.outline!, wpx = Math.min(64, (ol.width / unit) * pxPerUnit);
        // the mesh's screen box (+ the ink width)
        const b0 = r.base[mi] * 2, nv = r.vcount[mi];
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let q = 0, o2 = b0; q < nv; q++, o2 += 2) {
          const px = ((V[o2] * sx + tx) * 0.5 + 0.5) * w, py = ((V[o2 + 1] * sy + ty) * 0.5 + 0.5) * h;
          if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py;
        }
        const pad = Math.ceil(wpx) + 2;
        const X0 = Math.max(0, Math.floor(bx0) - pad), Y0 = Math.max(0, Math.floor(by0) - pad), X1 = Math.min(w, Math.ceil(bx1) + pad), Y1 = Math.min(h, Math.ceil(by1) + pad);
        if (X1 > X0 && Y1 > Y0) {
          const sil = this.silTex(w, h);
          // 1) silhouette: the mesh's texture alpha in its own triangles only. The ink quad's taps reach `wpx` past the
          //    quad, so clear that far too (else they read the previous outlined mesh's silhouette: stray ink lines)
          gl.bindFramebuffer(gl.FRAMEBUFFER, sil.fbo);
          const C0 = Math.max(0, X0 - pad), D0 = Math.max(0, Y0 - pad), C1 = Math.min(w, X1 + pad), D1 = Math.min(h, Y1 + pad);
          gl.enable(gl.SCISSOR_TEST); gl.scissor(C0, D0, C1 - C0, D1 - D0);
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(this.silP.p);
          gl.uniform4f(this.silP.u.uXf, sx, sy, tx, ty);
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE0);
          for (let q = k; q < e; q++) {
            const pg = r.pPage[itemPiece[q]];
            gl.uniform2f(this.silP.u.uCell, cellU(pg), cellV(pg));
            gl.bindTexture(gl.TEXTURE_2D, r.textures[pg]);
            gl.drawElements(gl.TRIANGLES, count[q], gl.UNSIGNED_INT, start[q] * 4);
          }
          gl.enable(gl.BLEND);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.disable(gl.SCISSOR_TEST);
          // 2) ink on a quad around it
          const P = this.lineP;
          gl.useProgram(P.p);
          gl.uniform2f(P.u.uView, w, h); gl.uniform1f(P.u.uW, wpx);
          gl.uniform4f(P.u.uInk, ol.color[0], ol.color[1], ol.color[2], Math.min(1, Math.max(0, ol.opacity ?? 1)));
          gl.uniform1f(P.u.uOp, Math.min(1, Math.max(0, ev.opacity[mi] * op0)));
          gl.uniform1i(P.u.uLR, ol.lightResponsive ? 1 : 0); gl.uniform3fv(P.u.uKeyC, keyC); gl.uniform2f(P.u.uKeyXY, o.flip ? -keyL[0] : keyL[0], keyL[1]);
          gl.uniform1i(P.u.uTaps, quality === 'low' ? 6 : 12);
          gl.uniform1i(P.u.uMaskMode, masked ? (m.maskInvert ? 2 : 1) : 0);
          if (maskTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex); }
          gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, sil.tex); gl.activeTexture(gl.TEXTURE0);
          const cx0 = X0 / w * 2 - 1, cy0 = Y0 / h * 2 - 1, cx1 = X1 / w * 2 - 1, cy1 = Y1 / h * 2 - 1;
          gl.uniform4f(P.u.uRect, cx0, cy0, cx1, cy1);
          gl.bindVertexArray(this.quadVao);
          gl.disable(gl.CULL_FACE);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
          gl.bindVertexArray(r.vao);
          if (m.doubleSided || this.debugNoCull) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
          this.drawCalls += 2;
        }
        gl.useProgram(cur.p);
        lastTex = -1;
      }
      gl.uniform1i(cur.u.uMaskMode, masked ? (m.maskInvert ? 2 : 1) : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex); }
      switch (m.blend) {
        case 'add': gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); break;
        case 'multiply': gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); break;
        case 'screen': gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
        default: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      // runs of items on the same page: one texture bind + one draw call each (an unsplit batch is one run)
      for (let a = k; a < e;) {
      const pg = r.pPage[itemPiece[a]];
      let b2 = a + 1, n2 = count[a];
      while (b2 < e && r.pPage[itemPiece[b2]] === pg) n2 += count[b2++];
      if (pg !== lastTex) {
        lastTex = pg;
        gl.uniform2f(cur.u.uCell, cellU(pg), cellV(pg));
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, r.textures[pg]);
        this.bindTail(r, cur, pg);
        if (lit) {
          const mt = r.mapTex[pg], U = this.litP.u, s = pageUv?.[pg];
          gl.uniform2f(U.uMapUv, s ? 1 / s[0] : 1, s ? 1 / s[1] : 1);
          gl.uniform1i(U.uHasN, mt?.normal ? 1 : 0); gl.uniform1i(U.uHasE, mt?.emission ? 1 : 0); gl.uniform1i(U.uHasR, mt?.rim ? 1 : 0);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, mt?.normal ?? null);
          gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, mt?.emission ?? null);
          gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, mt?.rim ?? null);
          gl.activeTexture(gl.TEXTURE0);
        }
      }
      gl.drawElements(gl.TRIANGLES, n2, gl.UNSIGNED_INT, start[a] * 4);
      this.drawCalls++;
      a = b2;
      }
      k = e;
    }
    gl.bindVertexArray(null);
    if (this.debugNoCopy) return;
    const tc = performance.now();
    target.clearRect(0, 0, w, h);
    target.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
    this.copyMs = performance.now() - tc;
  }
  /** texture LOD bias (negative = sharper when the art is minified) */
  lodBias = -1;
  debugNoMask = false;
  debugNoCull = false;
  debugNoOutline = false;
  debugNoCopy = false;
  copyMs = 0;
  /** draw calls since the last reset (perf meter) */
  drawCalls = 0;
}

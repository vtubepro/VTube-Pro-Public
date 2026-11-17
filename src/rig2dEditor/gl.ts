// The rig editor's preview renderer: WebGL2, draws a built .vtp2 rig (shared/rig2d/edit/vtp2.ts buildRig) from
// per-mesh vertex positions (the runtime evaluator's, or the editor's own while dragging: the two agree, see
// tools/rig2d_editor_unit.ts). Premultiplied alpha, stencil masks (alpha > 0.5, inverted too), normal / add /
// multiply / screen blending; plus the beyond-Live2D preview (docs/RIG2D_FORMAT.md §8): lighting from the normal /
// rim / emission maps under a test light, ink outlines, attachments and particle sprites, and map views ("show the
// normal map / rim map") for checking the generated maps. One instance per editor; dispose() frees every GL object.
import type { BuiltRig } from '../../shared/rig2d/edit/vtp2.ts';
import type { LightMaps } from '../../shared/rig2d/edit/maps.ts';
import type { Sprite } from '../../shared/rig2d/edit/preview.ts';
import { f32, viewArray } from '../../shared/rig2d/container.ts';

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform vec4 uView; // scale x, scale y, offset x, offset y (canvas px -> clip)
out vec2 vUv;
void main() { vUv = aUv; gl_Position = vec4(aPos.x * uView.x + uView.z, aPos.y * uView.y + uView.w, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex; uniform sampler2D uNrm; uniform sampler2D uRim; uniform sampler2D uEmi;
uniform float uOpacity; uniform float uMaskPass;
uniform int uMode;          // 0 art, 1 lit, 2 normal map, 3 rim map
uniform int uMaps;          // 1 = normal / rim maps bound, 2 = + emission
uniform vec3 uL; uniform vec3 uKey; uniform vec3 uAmb; uniform float uStr; uniform float uRimStr; uniform float uRimW;
uniform vec4 uOutline;      // rgb (linear-ish display colour), a = opacity; uOutlineW = width in uv
uniform vec2 uOutlineW;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);
  if (uMaskPass > 0.5) { if (c.a <= 0.5) discard; o = vec4(0.0); return; }
  if (uOutlineW.x > 0.0 && c.a < 0.98) {
    float m = 0.0;
    for (int i = 0; i < 12; i++) { float a = float(i) * 0.5236; m = max(m, texture(uTex, vUv + vec2(cos(a), sin(a)) * uOutlineW).a); }
    float ink = smoothstep(0.35, 0.65, m) * uOutline.a;
    c = c + vec4(uOutline.rgb, 1.0) * ink * (1.0 - c.a);
  }
  if (uMaps > 0 && uMode == 2) { o = vec4(texture(uNrm, vUv).rgb * c.a, c.a) * uOpacity; return; }
  if (uMaps > 0 && uMode == 3) { o = vec4(vec3(texture(uRim, vUv).r) * c.a, c.a) * uOpacity; return; }
  if (uMaps > 0 && uMode == 1) {
    vec3 n = normalize(texture(uNrm, vUv).rgb * 2.0 - 1.0);
    float d = max(dot(n, uL), 0.0), d0 = max(uL.z, 0.05);
    // normalised: a surface facing the viewer keeps its painted colour
    vec3 shade = mix(vec3(1.0), (uAmb + uKey * d) / (uAmb + uKey * d0), uStr);
    float rim = texture(uRim, vUv).r * pow(clamp(1.0 - n.z, 0.0, 1.0), mix(3.0, 0.6, clamp(uRimW, 0.0, 1.0))) * uRimStr;
    vec3 rgb = c.rgb * shade + uKey * rim * c.a;
    if (uMaps > 1) rgb += texture(uEmi, vUv).rgb * texture(uEmi, vUv).a;
    c = vec4(rgb, c.a);
  }
  o = c * uOpacity;
}`;

interface MeshGL { vao: WebGLVertexArrayObject; pos: WebGLBuffer; uv: WebGLBuffer; idx: WebGLBuffer; count: number; type: number; tex: number }

export interface LightOpts { mode: 'art' | 'lit' | 'normal' | 'rim'; dir: [number, number, number]; key: [number, number, number]; amb: [number, number, number]; strength: number; rimStrength: number; rimWidth: number }
export interface DrawOpts { view: { s: number; ox: number; oy: number }; hidden?: ReadonlySet<number>; light?: LightOpts | null; factor?: (mesh: number) => number; sprites?: Sprite[]; spriteRect?: (tex: number) => { page: number; rect: [number, number, number, number] } | null }

export class RigGL {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private meshes: MeshGL[] = [];
  private textures: WebGLTexture[] = [];
  private mapTex: { n: WebGLTexture[]; r: WebGLTexture[]; e: WebGLTexture[] | null } | null = null;
  private mapKey: unknown = null;
  private built: BuiltRig | null = null;
  private texKey: unknown = null;
  private spriteVao: WebGLVertexArrayObject; private spriteBuf: WebGLBuffer;
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, stencil: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser cannot draw WebGL 2, which the 2D avatar editor needs.');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aUv');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const k of ['uView', 'uTex', 'uNrm', 'uRim', 'uEmi', 'uOpacity', 'uMaskPass', 'uMode', 'uMaps', 'uL', 'uKey', 'uAmb', 'uStr', 'uRimStr', 'uRimW', 'uOutline', 'uOutlineW']) this.u[k] = gl.getUniformLocation(p, k);
    gl.useProgram(p);
    gl.uniform1i(this.u.uTex, 0); gl.uniform1i(this.u.uNrm, 1); gl.uniform1i(this.u.uRim, 2); gl.uniform1i(this.u.uEmi, 3);
    this.spriteVao = gl.createVertexArray()!; gl.bindVertexArray(this.spriteVao);
    this.spriteBuf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf); gl.bufferData(gl.ARRAY_BUFFER, 4 * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  private upload(pg: { w: number; h: number; rgba: Uint8ClampedArray }, premultiply: boolean): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pg.w, pg.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pg.rgba.buffer, pg.rgba.byteOffset, pg.rgba.byteLength));
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Use a newly built rig. Textures are re-uploaded only when `texKey` changes (the atlas pages object). */
  setRig(b: BuiltRig) {
    const gl = this.gl;
    for (const m of this.meshes) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uv); gl.deleteBuffer(m.idx); }
    this.meshes = [];
    if (this.texKey !== b.pages) {
      for (const t of this.textures) gl.deleteTexture(t);
      this.textures = b.pages.map((pg) => this.upload(pg, true));
      this.texKey = b.pages;
    }
    for (const m of b.doc.meshes) {
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      const pos = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, m.vertexCount * 8, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const uv = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, uv); gl.bufferData(gl.ARRAY_BUFFER, f32(b.buffers, m.uvs), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      const ia = viewArray(b.buffers, m.indices);
      const idx = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ia, gl.STATIC_DRAW);
      this.meshes.push({ vao, pos, uv, idx, count: ia.length, type: m.indices.type === 'u32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, tex: m.texture });
    }
    gl.bindVertexArray(null);
    this.built = b;
  }

  /** The lighting maps for the current atlas (same pages). */
  setMaps(maps: LightMaps | null) {
    if (this.mapKey === maps) return;
    const gl = this.gl;
    if (this.mapTex) for (const t of [...this.mapTex.n, ...this.mapTex.r, ...(this.mapTex.e ?? [])]) gl.deleteTexture(t);
    this.mapTex = maps ? { n: maps.normal.map((p) => this.upload(p, false)), r: maps.rim.map((p) => this.upload(p, false)), e: maps.emission ? maps.emission.map((p) => this.upload(p, false)) : null } : null;
    this.mapKey = maps;
  }

  /** Draw. `order` = meshes back to front. */
  draw(positions: ArrayLike<number>[] & Float32Array[], opacity: ArrayLike<number>, order: ArrayLike<number>, count: number, o: DrawOpts | { s: number; ox: number; oy: number }, hiddenLegacy?: ReadonlySet<number>) {
    const opts: DrawOpts = 'view' in o ? o : { view: o, hidden: hiddenLegacy };
    const gl = this.gl, b = this.built, view = opts.view;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (!b || this.lost) return;
    gl.useProgram(this.prog);
    gl.uniform4f(this.u.uView, (2 * view.s) / W, (-2 * view.s) / H, (2 * view.ox) / W - 1, 1 - (2 * view.oy) / H);
    const L = opts.light, maps = this.mapTex && L && L.mode !== 'art' ? this.mapTex : null;
    gl.uniform1i(this.u.uMaps, maps ? (maps.e ? 2 : 1) : 0);
    gl.uniform1i(this.u.uMode, L ? ({ art: 0, lit: 1, normal: 2, rim: 3 } as const)[L.mode] : 0);
    if (L) {
      const l = Math.hypot(...L.dir) || 1;
      gl.uniform3f(this.u.uL, L.dir[0] / l, L.dir[1] / l, L.dir[2] / l); gl.uniform3f(this.u.uKey, ...L.key); gl.uniform3f(this.u.uAmb, ...L.amb);
      gl.uniform1f(this.u.uStr, L.strength); gl.uniform1f(this.u.uRimStr, L.rimStrength); gl.uniform1f(this.u.uRimW, L.rimWidth);
    }
    gl.enable(gl.BLEND);
    for (let i = 0; i < this.meshes.length; i++) { const m = this.meshes[i]; gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions[i]); }
    const bindPage = (page: number) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[page]);
      if (maps) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maps.n[page]);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maps.r[page]);
        if (maps.e) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, maps.e[page]); }
        gl.activeTexture(gl.TEXTURE0);
      }
    };
    const drawMesh = (i: number) => { const m = this.meshes[i]; gl.bindVertexArray(m.vao); bindPage(m.tex); gl.drawElements(gl.TRIANGLES, m.count, m.type, 0); };
    const blend = (mode: string) => {
      if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
      else if (mode === 'multiply') gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    for (let k = 0; k < count; k++) {
      const i = order[k], md = b.doc.meshes[i];
      if (opts.hidden?.has(i)) continue;
      const op = opacity[i] * (opts.factor ? opts.factor(i) : 1);
      if (op <= 0.001) continue;
      if (md.masks.length) {
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.uniform1f(this.u.uMaskPass, 1); gl.uniform2f(this.u.uOutlineW, 0, 0);
        for (const mk of md.masks) drawMesh(mk);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(md.maskInvert ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      } else gl.disable(gl.STENCIL_TEST);
      gl.uniform1f(this.u.uMaskPass, 0);
      gl.uniform1f(this.u.uOpacity, op);
      const ol = md.outline, pg = b.pages[md.texture];
      if (ol && ol.width > 0 && pg) {
        const toDisp = (c: number) => Math.pow(Math.max(0, c), 1 / 2.2);
        gl.uniform4f(this.u.uOutline, toDisp(ol.color[0]), toDisp(ol.color[1]), toDisp(ol.color[2]), ol.opacity ?? 1);
        gl.uniform2f(this.u.uOutlineW, ol.width / pg.w, ol.width / pg.h);
      } else gl.uniform2f(this.u.uOutlineW, 0, 0);
      blend(md.blend);
      drawMesh(i);
    }
    gl.disable(gl.STENCIL_TEST);
    // sprites (attachments, particles): textured quads from the atlas, unlit
    if (opts.sprites?.length && opts.spriteRect) {
      gl.uniform1i(this.u.uMaps, 0); gl.uniform1i(this.u.uMode, 0); gl.uniform2f(this.u.uOutlineW, 0, 0);
      gl.bindVertexArray(this.spriteVao); gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      const q = new Float32Array(16);
      for (const s of opts.sprites) {
        const r = opts.spriteRect(s.tex);
        if (!r || s.alpha <= 0) continue;
        const a = (s.angle * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        const corner = (u: number, v: number, k: number) => {
          const lx = (u - s.pivot[0]) * s.w, ly = (v - s.pivot[1]) * s.h;
          q[k * 4] = s.x + c * lx - sn * ly; q[k * 4 + 1] = s.y + sn * lx + c * ly;
          q[k * 4 + 2] = r.rect[0] + u * r.rect[2]; q[k * 4 + 3] = r.rect[1] + v * r.rect[3];
        };
        corner(0, 0, 0); corner(1, 0, 1); corner(0, 1, 2); corner(1, 1, 3);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[r.page]);
        gl.uniform1f(this.u.uOpacity, s.alpha);
        blend(s.blend);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const m of this.meshes) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uv); gl.deleteBuffer(m.idx); }
    for (const t of this.textures) gl.deleteTexture(t);
    if (this.mapTex) for (const t of [...this.mapTex.n, ...this.mapTex.r, ...(this.mapTex.e ?? [])]) gl.deleteTexture(t);
    gl.deleteVertexArray(this.spriteVao); gl.deleteBuffer(this.spriteBuf);
    gl.deleteProgram(this.prog);
    this.meshes = []; this.textures = []; this.built = null; this.mapTex = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

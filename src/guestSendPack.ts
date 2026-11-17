// Guest browser source, sender page: the WebGL pack pass. Video carries no transparency, so every frame leaves as
//   [ premultiplied colour | 16 px gutter | alpha as grey ]      (shared/spout.ts packLayout; 720p = 2576x720)
// The page's own canvas (src/output.ts, premultiplied colour on a transparent clear: MSAA edges and blended hair come out
// premultiplied) is sampled as it is, in encoded (gamma) space, and the colour is clamped to at most its alpha so codec noise
// can never light up the transparent area. The viewer unpacks it in its own shader (shared/guestFeed.ts unpackEncoded).
// The packed canvas feeds a captureStream() with no frame rate: a frame is emitted per draw and not otherwise, so a page that
// draws nothing sends nothing (zero draw calls while no viewer is looking).
// Test switch: `stamp` paints Date.now() % 2^24 as GS_STAMP_BLOCKS blocks of 16 px along the bottom-left of the alpha half.
// Pure parts (layout, stamp bits) run under Node: tools/guestfeed_send_unit.ts. GLSL cannot, so its layout numbers all come
// from the uniforms below, which the unit test checks against shared/guestFeed.ts gsPackSize.
import { GS_STAMP_BLOCKS, PACK_GUTTER, gsPackSize, type GsTier } from '../shared/guestFeed.ts';

/** The size of the packed frame for a tier (even sizes: shared/spout.ts packLayout) and where each half starts. */
export interface GsPackPlan { fw: number; fh: number; cw: number; alphaX: number }
export function packPlan(t: Pick<GsTier, 'w' | 'h'>): GsPackPlan {
  const p = gsPackSize(t);
  return { fw: p.w, fh: p.h, cw: p.cw, alphaX: p.alphaX };
}

/** Bit i of Date.now() % 2^24, least significant first = the first block (x = alphaX + 16 * i). */
export const STAMP_PX = 16;
export function stampBits(nowMs: number): boolean[] {
  const n = Math.floor(Math.abs(nowMs)) % (1 << GS_STAMP_BLOCKS);
  return Array.from({ length: GS_STAMP_BLOCKS }, (_, i) => ((n >> i) & 1) === 1);
}
export function stampValue(bits: readonly boolean[]): number { let n = 0; for (let i = 0; i < GS_STAMP_BLOCKS; i++) if (bits[i]) n |= 1 << i; return n; }

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// uL = (colour width, height, alpha half start x, mode). Pixel coordinates come from gl_FragCoord (y = 0 at the bottom, like
// the texture: UNPACK_FLIP_Y_WEBGL puts the canvas's bottom row at t = 0). mode 1 = the picture itself (snapshot, not packed).
export const GS_PACK_FRAG = `precision highp float;
uniform sampler2D uT; uniform vec4 uL;
void main(){
  float x = gl_FragCoord.x, y = gl_FragCoord.y;
  if (uL.w > .5) { vec4 c = texture2D(uT, vec2(x / uL.x, y / uL.y)); gl_FragColor = vec4(min(c.rgb, vec3(c.a)), c.a); return; }
  if (x < uL.x) { vec4 c = texture2D(uT, vec2(x / uL.x, y / uL.y)); gl_FragColor = vec4(min(c.rgb, vec3(c.a)), 1.); }
  else if (x >= uL.z) { float a = texture2D(uT, vec2((x - uL.z) / uL.x, y / uL.y)).a; gl_FragColor = vec4(a, a, a, 1.); }
  else gl_FragColor = vec4(0., 0., 0., 1.);
}`;

/** The sender's picture as the viewer's `snapshot()` reports its own: top row first, RGBA 8-bit, colour premultiplied (encoded values, never above alpha). */
export interface GsSnapshot { w: number; h: number; data: Uint8Array }

export class GsPacker {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  /** draw calls so far (the test hook `__gsSend.frames()`; it must not move while nobody watches) */
  draws = 0;
  /** smoothed ms of one pack pass */
  packMs = 0;
  plan: GsPackPlan;
  private gl: WebGLRenderingContext;
  private pr: WebGLProgram;
  private tex: WebGLTexture;
  private uL: WebGLUniformLocation;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboSize = '';
  private last: HTMLCanvasElement | null = null;

  /** Throws when the browser gives no WebGL (the page then reports `gl`). */
  constructor(tier: Pick<GsTier, 'w' | 'h'>) {
    this.plan = packPlan(tier);
    const c = document.createElement('canvas');
    c.width = this.plan.fw; c.height = this.plan.fh;
    // (no preserveDrawingBuffer: the frame is captured right after the draw, in the same task, like src/streamPcSend.ts)
    const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
    if (!gl) throw new Error('no WebGL for the guest picture');
    this.canvas = c; this.gl = gl;
    const sh = (t: number, s: string) => {
      const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(`pack shader: ${gl.getShaderInfoLog(o) ?? ''}`);
      return o;
    };
    const pr = gl.createProgram()!;
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, GS_PACK_FRAG));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('pack program');
    gl.useProgram(pr);
    this.pr = pr;
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.uL = gl.getUniformLocation(pr, 'uL')!;
    gl.uniform1i(gl.getUniformLocation(pr, 'uT'), 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // (the page's colour is already premultiplied: take the buffer as it is)
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.stream = c.captureStream();
    this.track = this.stream.getVideoTracks()[0];
    try { this.track.contentHint = 'detail'; } catch { /* old browser */ }   // (= degradationPreference 'maintain-resolution', see src/guestSend.ts ENCODER_DEGRADATION)
  }

  /** A new tier: the packed canvas changes size (the encoder follows the track's frame size). */
  setTier(tier: Pick<GsTier, 'w' | 'h'>): GsPackPlan {
    const p = packPlan(tier);
    if (p.fw !== this.plan.fw || p.fh !== this.plan.fh) { this.canvas.width = p.fw; this.canvas.height = p.fh; this.gl.viewport(0, 0, p.fw, p.fh); }
    this.plan = p;
    return p;
  }

  private uploadSource(src: HTMLCanvasElement) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /** Pack the page's canvas into the packed canvas (one frame leaves through the stream). */
  draw(src: HTMLCanvasElement, stamp = false) {
    if (!(src.width > 0 && src.height > 0)) return;
    const t0 = performance.now(), gl = this.gl, p = this.plan;
    this.last = src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.pr);
    gl.viewport(0, 0, p.fw, p.fh);
    this.uploadSource(src);
    gl.uniform4f(this.uL, p.cw, p.fh, p.alphaX, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (stamp) {
      const bits = stampBits(Date.now());
      gl.enable(gl.SCISSOR_TEST);
      for (let i = 0; i < GS_STAMP_BLOCKS; i++) {
        gl.scissor(p.alphaX + i * STAMP_PX, 0, STAMP_PX, STAMP_PX);
        const v = bits[i] ? 1 : 0;
        gl.clearColor(v, v, v, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    this.draws++;
    this.packMs = this.packMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  /** The picture as the sender means it (premultiplied encoded RGBA, top row first) from the page's canvas as it is now. */
  snapshot(src: HTMLCanvasElement | null = this.last): GsSnapshot | null {
    if (!src || !(src.width > 0 && src.height > 0)) return null;
    const gl = this.gl, p = this.plan, w = p.cw, h = p.fh;
    try {
      if (!this.fbo || this.fboSize !== `${w}x${h}`) {
        if (this.fboTex) gl.deleteTexture(this.fboTex);
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        this.fboTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        this.fboSize = `${w}x${h}`;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.useProgram(this.pr);
      gl.viewport(0, 0, w, h);
      this.uploadSource(src);
      gl.uniform4f(this.uL, w, h, p.alphaX, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const out = new Uint8Array(w * h * 4), row = w * 4;
      for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      return { w, h, data: out };
    } catch { return null; } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, p.fw, p.fh);
    }
  }

  dispose() {
    try { this.track.stop(); } catch { /* stopped */ }
    try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* gone */ }
  }
}

/** A packer, or null when the browser has no WebGL (the sender page then says `gl`). */
export function createPacker(tier: Pick<GsTier, 'w' | 'h'>): GsPacker | null {
  try { return new GsPacker(tier); } catch (e) { console.warn('[guest-send] pack pass unavailable', e); return null; }
}

export { PACK_GUTTER };

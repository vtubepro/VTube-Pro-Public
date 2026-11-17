// Spout2 → a video track that carries the alpha (studio side; shared/spout.ts has the format + the math).
//
//   the app (VSeeFace, VTube Studio, Warudo …) ──Spout2 (D3D11 shared texture)──► server/spout.ts + tools/spout/spout_rx.py
//   ──ws /ws/spout (raw RGBA / BGRA, localhost)──► THIS: a WebGL2 packer ──canvas.captureStream──► a MediaStreamTrack
//
// The packer draws one frame per Spout frame into a canvas laid out [premultiplied colour | gutter | alpha as grey]
// (packLayout). Premultiplying happens per texel BEFORE any filtering, in linear light (manual bilinear): a straight-alpha
// sender's garbage colour under alpha 0 (often pure green or black) never bleeds into the edges — no fringe. The track
// then goes wherever a TV feed goes (loopback WebRTC to this PC's OBS pages, the party's tvLink to other PCs) and every
// renderer unpacks it (tvScreen.ts). When the other side can't unpack (an older host), `pack` is off and the packer
// composites the model over pure green instead, announced with a chroma key: keyed like a VTube Studio picture.
// Auto-framing (ModelFramer) crops the frame to the model's alpha box, so only the model travels and a standee's feet
// are the picture's bottom edge. Nothing is recorded or stored: frames live in this page's memory only.
import { ModelFramer, alphaBox, detectAlphaMode, packLayout, parseSpoutFrame, texCapacity, uploadRect, type AlphaMode, type SpoutMsg, type TvPack } from '../../../shared/spout.ts';

export interface SpoutRxStats {
  state: 'off' | 'connecting' | 'waiting' | 'live' | 'lost' | 'error';
  sender: string;
  /** Source size (px). */
  w: number; h: number;
  /** Frames drawn per second here / the sender's own rate (0 = unknown). */
  fps: number; senderFps: number;
  alpha: AlphaMode | '';
  /** Share of the frame the model covers (0..1). */
  coverage: number;
  /** Output (sent) picture size, colour half. */
  outW: number; outH: number;
  error: string;
}

export interface SpoutRxOptions {
  sender: string;
  /** Frames per second asked from the server (15..60). */
  fps: number;
  /** Max height of the sent picture (px); the source is scaled down to it (never up). */
  maxH: number;
  /** Pack the alpha (true) or composite over green (false: for hosts that can't unpack). */
  pack: boolean;
  /** Crop to the model's alpha box (true) or use `crop` (px rect in the source, null = whole frame). */
  auto: boolean;
  crop?: (w: number, h: number) => { x: number; y: number; w: number; h: number } | null;
  /** ws URL override (tests); default: this page's server, /ws/spout. */
  url?: string;
}

const VERT = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
// frame x (px) → which half; source texel fetch with the sender's channel order; manual bilinear of PREMULTIPLIED linear
// colour (never filter straight alpha); output bytes are sRGB-encoded premultiplied colour / the alpha as grey
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;      // px
uniform vec4 uCrop;         // x, y, w, h (px, top-left origin)
uniform vec4 uUp;           // the part of the frame that is on the GPU: x, y, w, h (px). Only the crop is uploaded.
uniform vec2 uOut;          // colour half size (px)
uniform vec3 uLay;          // colour width px, alpha start px, 1 = packed (0 = composite over uKey)
uniform int uFmt;           // 0 RGBA, 1 BGRA, 2 BGRX (opaque)
uniform int uPremul;        // sender already premultiplied
uniform vec3 uKey;          // composite colour (linear)
out vec4 o;
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 enc(vec3 c) { c = max(c, vec3(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec4 texel(ivec2 q) {
  q = clamp(q, ivec2(uCrop.xy), ivec2(uCrop.xy + uCrop.zw) - 1);
  ivec2 r = q - ivec2(uUp.xy);       // (the texture holds only the uploaded rect; outside it reads as 0, like off the frame)
  bool inside = r.x >= 0 && r.y >= 0 && r.x < int(uUp.z) && r.y < int(uUp.w);
  vec4 t = inside ? texelFetch(uSrc, r, 0) : vec4(0.0);
  if (uFmt >= 1) t = t.bgra;
  if (uFmt == 2) t.a = 1.0;
  vec3 c = lin(t.rgb);
  // premultiply per texel, linear light (a premultiplied sender: its values are already ≤ alpha)
  c = uPremul == 1 ? min(c, vec3(t.a)) : c * t.a;
  return vec4(c, t.a);
}
vec4 sampleAt(vec2 f) {     // f: position in the colour half (px, top-left origin) → premultiplied linear + alpha
  vec2 s = uCrop.xy + f * (uCrop.zw / uOut) - 0.5;
  vec2 b = floor(s), w = s - b;
  ivec2 i = ivec2(b);
  vec4 a = mix(texel(i), texel(i + ivec2(1, 0)), w.x);
  vec4 c = mix(texel(i + ivec2(0, 1)), texel(i + ivec2(1, 1)), w.x);
  return mix(a, c, w.y);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);          // top-left origin
  if (uLay.z < 0.5) { vec4 m = sampleAt(px); o = vec4(enc(m.rgb + uKey * (1.0 - m.a)), 1.0); return; }
  if (px.x < uLay.x) { vec4 m = sampleAt(px); o = vec4(enc(m.rgb), 1.0); return; }
  if (px.x >= uLay.y) { vec4 m = sampleAt(vec2(px.x - uLay.y, px.y)); o = vec4(vec3(m.a), 1.0); return; }
  o = vec4(0.0, 0.0, 0.0, 1.0);                                      // gutter
}`;

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export class SpoutReceiver {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  stats: SpoutRxStats;
  /** Current layout (null = composite, no alpha in the frame). */
  pack: TvPack | null = null;
  /** Width / height of the sent picture (the colour half). */
  aspect = 16 / 9;
  onChange: () => void = () => {};
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private texSize = { w: 0, h: 0 };
  private U: Record<string, WebGLUniformLocation | null> = {};
  private ws: WebSocket | null = null;
  private track: MediaStreamTrack & { requestFrame?: () => void };
  // (shrinks only after 3 s smaller: a swinging arm doesn’t make the picture — and the announcement — breathe)
  private framer = new ModelFramer(0.04, 3000);
  private frames = 0; private fpsAt = 0; private fpsN = 0;
  private alphaMode: AlphaMode | '' = '';
  private retryT = 0; private tries = 0; private closed = false;
  private lastAt = 0; private lostT = 0;
  private sig = '';
  private pending: ArrayBuffer | null = null; private flushT = 0; private flushRaf = 0;

  constructor(private o: SpoutRxOptions) {
    this.stats = { state: 'connecting', sender: o.sender, w: 0, h: 0, fps: 0, senderFps: 0, alpha: '', coverage: 0, outW: 0, outH: 0, error: '' };
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2; this.canvas.height = 2;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`spout packer: ${gl.getShaderInfoLog(s)}`); return s; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`spout packer: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    for (const n of ['uSrc', 'uSrcSize', 'uCrop', 'uUp', 'uOut', 'uLay', 'uFmt', 'uPremul', 'uKey']) this.U[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const cap = this.canvas.captureStream(0);
    this.track = cap.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    try { this.track.contentHint = 'detail'; } catch { /* */ }
    this.stream = cap;
    this.connect();
    // the connection health: no frame for 1.5 s = waiting / lost (the sender paused, closed, or changed size)
    this.lostT = window.setInterval(() => {
      if (this.closed) return;
      const age = performance.now() - this.lastAt;
      if (this.stats.state === 'live' && age > 1500) { this.stats.state = 'lost'; this.stats.fps = 0; this.onChange(); }
    }, 500);
  }

  /** Change what is sent (pack on / off, fps, size, framing). Reconnects only when the sender / fps changed. */
  set(p: Partial<SpoutRxOptions>) {
    const reconnect = (p.sender !== undefined && p.sender !== this.o.sender) || (p.fps !== undefined && p.fps !== this.o.fps);
    this.o = { ...this.o, ...p };
    if (p.auto === false || p.crop) this.framer = new ModelFramer(0.04, 3000);
    if (reconnect) { this.stats = { ...this.stats, sender: this.o.sender, state: 'connecting', error: '' }; this.ws?.close(); this.tries = 0; this.connect(); }
  }

  get live(): boolean { return this.stats.state === 'live' && this.track.readyState === 'live'; }

  private url() {
    if (this.o.url) return `${this.o.url}${this.o.url.includes('?') ? '&' : '?'}name=${encodeURIComponent(this.o.sender)}&fps=${this.o.fps}`;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/spout?name=${encodeURIComponent(this.o.sender)}&fps=${this.o.fps}`;
  }

  private connect() {
    if (this.closed) return;
    clearTimeout(this.retryT);
    let ws: WebSocket;
    try { ws = new WebSocket(this.url()); } catch (e) { this.fail(`Couldn’t reach VTube Pro’s Spout2 receiver: ${(e as Error).message}`); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data) as SpoutMsg;
          if (m.type === 'status') {
            this.stats.error = m.error ?? '';
            if (m.state === 'error') this.stats.state = 'error';
            else if (m.state === 'waiting' && this.stats.state !== 'live') this.stats.state = 'waiting';
            else if (m.state === 'lost') this.stats.state = 'lost';
            this.onChange();
          }
        } catch { /* */ }
        return;
      }
      this.tries = 0;
      this.offer(e.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.ws = null;
      if (this.stats.state !== 'error') this.stats.state = this.stats.state === 'live' ? 'lost' : 'connecting';
      this.onChange();
      const wait = Math.min(5000, 500 * 2 ** Math.min(4, this.tries++));
      this.retryT = window.setTimeout(() => this.connect(), wait);
    };
  }
  /** A frame arrived. If the page is busy, messages queue up; drawing every one of them just delays the newest. So a
   *  visible page keeps only the newest and draws it once per animation frame (or within 100 ms if rAF stalls); a hidden
   *  page (timers and rAF are throttled there) draws each message at once, as before. */
  private offer(buf: ArrayBuffer) {
    if (document.hidden) { this.pending = null; this.frame(buf); return; }
    this.pending = buf;
    if (this.flushT) return;
    const go = () => {
      cancelAnimationFrame(this.flushRaf); clearTimeout(this.flushT);
      this.flushRaf = 0; this.flushT = 0;
      const b = this.pending; this.pending = null;
      if (b && !this.closed) this.frame(b);
    };
    this.flushRaf = requestAnimationFrame(go);
    this.flushT = window.setTimeout(go, 100);
  }
  private fail(msg: string) { this.stats.state = 'error'; this.stats.error = msg; this.onChange(); }

  /** One Spout frame: detect alpha (every 30th), frame the model (every 6th), upload, pack, push to the track. */
  private frame(buf: ArrayBuffer) {
    const f = parseSpoutFrame(buf);
    if (!f) return;
    const { head, px } = f;
    const gl = this.gl;
    this.frames++;
    const n = this.frames;
    if (n === 1 || n % 30 === 0 || head.w !== this.stats.w || head.h !== this.stats.h) {
      const d = head.fmt === 2 ? { mode: 'opaque' as AlphaMode, coverage: 1 } : detectAlphaMode(px, head.w, head.h, 4);
      this.alphaMode = d.mode;
      this.stats.coverage = d.coverage;
    }
    // crop: auto-framing to the model, or the manual crop, or the whole picture
    let crop = { x: 0, y: 0, w: even(head.w), h: even(head.h) };
    const opaque = this.alphaMode === 'opaque';
    if (this.o.auto && !opaque) {
      if (n === 1 || n % 6 === 0 || !this.framer.box) crop = this.framer.update(alphaBox(px, head.w, head.h, 8, 4), head.w, head.h, performance.now());
      else crop = this.framer.box;
    } else {
      const c = this.o.crop?.(head.w, head.h);
      if (c) crop = { x: Math.max(0, c.x), y: Math.max(0, c.y), w: Math.min(c.w, head.w), h: Math.min(c.h, head.h) };
    }
    // output size: the crop, scaled down to maxH (never up), even
    const k = Math.min(1, this.o.maxH / Math.max(1, crop.h));
    const ow = even(crop.w * k), oh = even(crop.h * k);
    const packing = this.o.pack && !opaque;
    const lay = packLayout(ow, oh);
    const fw = packing ? lay.fw : ow, fh = oh;
    if (this.canvas.width !== fw || this.canvas.height !== fh) { this.canvas.width = fw; this.canvas.height = fh; }
    this.pack = packing ? lay.pack : null;
    this.aspect = ow / oh;
    // upload: only the crop (the packer never reads outside it), straight out of the frame's rows
    const up = uploadRect(crop, head.w, head.h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (up.w > 0) {
      const cap = texCapacity(this.texSize, up, head);
      if (cap.w !== this.texSize.w || cap.h !== this.texSize.h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cap.w, cap.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.texSize = cap;
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, head.w); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, up.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, up.y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, up.w, up.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
    // pack
    gl.viewport(0, 0, fw, fh);
    gl.useProgram(this.prog);
    const U = this.U;
    gl.uniform1i(U.uSrc, 0);
    gl.uniform2f(U.uSrcSize, head.w, head.h);
    gl.uniform4f(U.uCrop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform4f(U.uUp, up.x, up.y, up.w, up.h);
    gl.uniform2f(U.uOut, ow, oh);
    gl.uniform3f(U.uLay, lay.cw, lay.ax, packing ? 1 : 0);
    gl.uniform1i(U.uFmt, head.fmt);
    gl.uniform1i(U.uPremul, this.alphaMode === 'premultiplied' ? 1 : 0);
    gl.uniform3f(U.uKey, 0, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.track.requestFrame?.();
    // stats
    const now = performance.now();
    this.lastAt = now;
    this.fpsN++;
    if (now - this.fpsAt >= 1000) { this.stats.fps = this.fpsAt ? Math.round((this.fpsN * 1000) / (now - this.fpsAt)) : 0; this.fpsN = 0; this.fpsAt = now; }
    const was = this.stats.state;
    Object.assign(this.stats, { state: 'live', w: head.w, h: head.h, senderFps: head.senderFps, alpha: this.alphaMode, outW: ow, outH: oh, error: '' });
    // tell the owner when something that changes the announcement changed (not every frame)
    const sig = `${was === 'live'}|${this.alphaMode}|${packing}|${Math.round(this.aspect * 50)}`;
    if (sig !== this.sig) { this.sig = sig; this.onChange(); }
  }

  /** The current frame's raw pixels as the page sees them (tests / diagnostics): the canvas read back. */
  readback(): { w: number; h: number; px: Uint8Array } {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.retryT); clearInterval(this.lostT); clearTimeout(this.flushT); cancelAnimationFrame(this.flushRaf); this.pending = null;
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    this.track.stop();
    const gl = this.gl;
    gl.deleteTexture(this.tex); gl.deleteProgram(this.prog);
    (gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
    this.stats.state = 'off';
  }
}

/** GET /api/spout (the server's receiver: available? who is sending?). */
export async function spoutStatus(base = ''): Promise<import('../../../shared/spout.ts').SpoutStatus> {
  try {
    const r = await fetch(`${base}/api/spout`, { cache: 'no-store' });
    if (r.status === 404) return { available: false, reason: 'This VTube Pro server has no Spout2 receiver yet (update / restart VTube Pro).', senders: [], active: [] };
    if (!r.ok) return { available: false, reason: `Spout2 receiver: HTTP ${r.status}`, senders: [], active: [] };
    return await r.json();
  } catch (e) { return { available: false, reason: `Couldn’t reach VTube Pro’s server: ${(e as Error).message}`, senders: [], active: [] }; }
}

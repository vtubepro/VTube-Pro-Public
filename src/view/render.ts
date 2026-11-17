// The guest viewer's picture: unpacks the side-by-side premultiplied frame ([colour | 16 px gutter | alpha grey], shared/spout.ts packLayout)
// in WebGL onto a transparent, premultipliedAlpha canvas. Everything stays in encoded (gamma) space, exactly like
// shared/guestFeed.ts unpackEncoded: alpha 6..249 remapped to 0..1, then the low-alpha cutoff (8..16 of 255, smoothstep: codec ringing next to
// the silhouette never leaves haze in the transparent area), colour rescaled by the same factor and clamped to at most alpha.
// Frames go into textures of the picture size; with a lip-sync delay they wait in GsFrameStore (GsDelayQueue) and the loop shows the
// newest one that is old enough. The <video> stays in the DOM (never display:none: some embedded browsers then stop decoding).
// Spec: docs/GUEST_BROWSER_SOURCE.md section 4.
import { ALPHA_HI, ALPHA_LO, GS_ALPHA_CUT_HI, GS_ALPHA_CUT_LO, GS_STAMP_BLOCKS, gsPackSize, gsTier, pictureOfFrame, queueFrames, type GsQuality } from '../../shared/guestFeed.ts';
import { GsFrameStore, GsHold, type PictureState } from './picture.ts';

const f6 = (n: number) => n.toFixed(6);
const VS = 'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
const PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
/** k.x = colour width / frame width, k.y = alpha half's left edge / frame width. Output row 0 is the picture's BOTTOM row (GL order). */
export const UNPACK_FS = `${PRECISION}uniform sampler2D t;uniform vec2 k;varying vec2 v;
void main(){
  float ty=1.-v.y;
  vec3 c=texture2D(t,vec2(v.x*k.x,ty)).rgb;
  vec3 g=texture2D(t,vec2(k.y+v.x*k.x,ty)).rgb;
  float r=(g.r+g.g+g.b)/3.;
  float a0=clamp((r-${f6(ALPHA_LO)})/${f6(ALPHA_HI - ALPHA_LO)},0.,1.);
  float a=a0*smoothstep(${f6(GS_ALPHA_CUT_LO)},${f6(GS_ALPHA_CUT_HI)},a0);
  float s=r>.0001?a/r:0.;
  gl_FragColor=vec4(min(max(c*s,0.),vec3(a)),a);
}`;
export const BLIT_FS = `${PRECISION}uniform sampler2D t;varying vec2 v;void main(){gl_FragColor=texture2D(t,v);}`;

/**
 * Where the colour and alpha halves sit in a decoded frame of vw x vh, as FRACTIONS of its width. The sender tells us the picture size it packs
 * (cfg w x h; before the first cfg: the link's quality), so a frame the encoder scaled down (slow start, a weak network) still unpacks right:
 * the 16 px gutter shrinks with it, which an absolute 2 * w + 16 rule would misread. A frame that is not that shape at all falls back to the
 * exact rule (pictureOfFrame); anything else is not ours (null).
 */
export function frameLayout(vw: number, vh: number, expect: { w: number; h: number }): { w: number; h: number; c: number; a: number } | null {
  if (!(vw >= 8 && vh >= 2)) return null;
  const e = gsPackSize(expect), sx = vw / e.w, sy = vh / e.h;
  if (Math.abs(sx - sy) <= 0.015 * sy) return { w: e.cw, h: e.h, c: e.cw / e.w, a: e.alphaX / e.w };
  const p = pictureOfFrame(vw, vh);
  return p ? { w: p.w, h: p.h, c: p.w / vw, a: p.alphaX / vw } : null;
}

interface Frame { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }
export interface GsSnapshot { w: number; h: number; /** premultiplied RGBA, top row first */ data: Uint8Array }
export interface GsRenderer {
  readonly ok: boolean;
  attach(track: MediaStreamTrack): void;
  detach(): void;
  /** delay (ms) + the picture sizing facts from the link and the sender's cfg message */
  configure(o: { delayMs?: number; q?: GsQuality; fps?: number; w?: number; h?: number }): void;
  setVisible(on: boolean): void;
  picture(now?: number): PictureState;
  readonly lost: boolean;
  /** drop the picture now (turned off / blocked) or after the hold time (cleared canvas, alpha 0 everywhere) */
  clear(): void;
  /** the 8 s hold ran out: clear the canvas to alpha 0 but remember that the picture was lost */
  blank(): void;
  readonly hasShown: boolean;
  frames(): number;
  snapshot(): GsSnapshot | null;
  stamp(): { n: number; lagMs: number | null } | null;
  info(): { video: [number, number]; picture: [number, number] | null; canvas: [number, number]; delayMs: number; queued: number; shown: boolean; foreign: number; draws: number; alphaMax: number };
  video: HTMLVideoElement;
  hold: GsHold;
}

export function createRenderer(canvas: HTMLCanvasElement, video: HTMLVideoElement, o: { q: GsQuality; delayMs: number; stamp?: boolean }): GsRenderer {
  const glOpts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
  let gl = (canvas.getContext('webgl2', glOpts) ?? canvas.getContext('webgl', glOpts)) as WebGLRenderingContext | null;
  const hold = new GsHold();
  const full = gsTier(o.q, 'full');
  let CW = full.w, CH = full.h;                 // the canvas keeps the chosen quality's size: tier changes never resize it (no flicker)
  canvas.width = CW; canvas.height = CH;
  let expect = { w: full.w, h: full.h };
  /** frames count only while their track is live: a track that ended (peer connection closed) can still paint one black frame */
  let track: MediaStreamTrack | null = null;
  let fps = 30, frames = 0, draws = 0, foreign = 0, picW = 0, picH = 0;
  let pool: Frame[] = [];
  /** smoothed time between frames (ms): half of it, plus half a screen refresh, is how much older than the delay the shown frame is on average */
  let gap = 33, lastArrive = 0;
  let unpack: WebGLProgram | null = null, blit: WebGLProgram | null = null, vtex: WebGLTexture | null = null;
  let uK: WebGLUniformLocation | null = null;
  const destroy = (f: Frame) => { if (!gl) return; gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); };
  const store = new GsFrameStore<Frame>((f) => { if (f.w === picW && f.h === picH && pool.length < 4) pool.push(f); else destroy(f); }, 2);

  const prog = (fs: string): WebGLProgram | null => {
    const g = gl!, mk = (t: number, s: string) => { const sh = g.createShader(t)!; g.shaderSource(sh, s); g.compileShader(sh); return sh; };
    const p = g.createProgram()!;
    g.attachShader(p, mk(g.VERTEX_SHADER, VS)); g.attachShader(p, mk(g.FRAGMENT_SHADER, fs)); g.bindAttribLocation(p, 0, 'p'); g.linkProgram(p);
    return g.getProgramParameter(p, g.LINK_STATUS) ? p : null;
  };
  const tex2d = (filter: number) => {
    const g = gl!, t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, t);
    for (const [k, v] of [[g.TEXTURE_MIN_FILTER, filter], [g.TEXTURE_MAG_FILTER, filter], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]]) g.texParameteri(g.TEXTURE_2D, k, v);
    return t;
  };
  function build(): boolean {
    if (!gl || gl.isContextLost()) return false;
    unpack = prog(UNPACK_FS); blit = prog(BLIT_FS);
    if (!unpack || !blit) return false;
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    vtex = tex2d(gl.LINEAR);
    uK = gl.getUniformLocation(unpack, 'k');
    gl.useProgram(blit); gl.uniform1i(gl.getUniformLocation(blit, 't'), 0);
    gl.useProgram(unpack); gl.uniform1i(gl.getUniformLocation(unpack, 't'), 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }
  let ok = build();

  const take = (w: number, h: number): Frame => {
    const g = gl!, f = pool.pop();
    if (f) return f;
    const tex = tex2d(g.LINEAR);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    const fbo = g.createFramebuffer()!;
    g.bindFramebuffer(g.FRAMEBUFFER, fbo); g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  };
  const present = () => {
    const g = gl!;
    g.bindFramebuffer(g.FRAMEBUFFER, null); g.viewport(0, 0, CW, CH);
    const f = store.shown;
    if (!f) { g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT); return; }
    g.useProgram(blit); g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, f.tex);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  };
  const plan = (delay = store.delay) => store.configure(delay, queueFrames(delay, fps, Math.max(1, picW * picH * 4)));
  const setPicture = (w: number, h: number) => {
    picW = w; picH = h;
    for (const f of pool) destroy(f); pool = [];
    store.emptyQueue();
    if (w > CW || h > CH) { CW = Math.max(CW, w); CH = Math.max(CH, h); canvas.width = CW; canvas.height = CH; if (store.shown) present(); }
    plan();
  };

  function onFrame() {
    if (!ok || !gl || !unpack || !vtex || !track || track.readyState !== 'live') return;
    const vw = video.videoWidth, vh = video.videoHeight, pic = frameLayout(vw, vh, expect);
    if (!pic) { if (vw) foreign++; return; }
    if (pic.w !== picW || pic.h !== picH) setPicture(pic.w, pic.h);
    const now = performance.now(), g = gl;
    if (lastArrive) { const d = now - lastArrive; if (d > 0 && d < 500) gap += (d - gap) * 0.1; }
    lastArrive = now;
    const f = take(pic.w, pic.h);
    g.bindFramebuffer(g.FRAMEBUFFER, f.fbo); g.viewport(0, 0, pic.w, pic.h);
    g.useProgram(unpack); g.uniform2f(uK, pic.c, pic.a);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, vtex);
    try { g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, video); } catch { pool.push(f); return; }
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    frames++; draws++;
    hold.frame(now);
    if (store.add(now, f)) present();
  }
  function loop() {
    requestAnimationFrame(loop);
    if (!ok) return;
    if (store.delay > 0 && store.tick(performance.now(), gap / 2 + 8)) present();
    if (!video.requestVideoFrameCallback) pollFrame();
  }
  let lastPoll = -1;
  function pollFrame() {
    const t = video.currentTime, q = (video as HTMLVideoElement & { getVideoPlaybackQuality?: () => { totalVideoFrames: number } }).getVideoPlaybackQuality?.().totalVideoFrames;
    const key = q ?? t;
    if (key !== lastPoll && video.readyState >= 2) { lastPoll = key; onFrame(); }
  }
  function armFrameCallback() {
    if (!video.requestVideoFrameCallback) return;
    video.requestVideoFrameCallback(() => { onFrame(); armFrameCallback(); });
  }
  if (ok) { requestAnimationFrame(loop); armFrameCallback(); }

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ok = false; pool = []; store.reset(); });
  canvas.addEventListener('webglcontextrestored', () => { pool = []; picW = picH = 0; ok = build(); });

  store.configure(o.delayMs, 2);

  const readFrame = (f: Frame, x: number, y: number, w: number, h: number): Uint8Array => {
    const g = gl!, buf = new Uint8Array(w * h * 4);
    g.bindFramebuffer(g.FRAMEBUFFER, f.fbo); g.readPixels(x, y, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
    return buf;
  };
  const r: GsRenderer = {
    get ok() { return ok; },
    video, hold,
    attach(t) {
      track = t;
      video.muted = true;
      video.srcObject = new MediaStream([t]);
      void video.play().catch(() => { /* autoplay is allowed for a muted video; a later frame retries */ });
    },
    detach() { track = null; video.srcObject = null; },   // the last picture stays (hold)
    configure(c) {
      if (c.q) { const t = gsTier(c.q, 'full'); if (t.w > CW || t.h > CH) { CW = Math.max(CW, t.w); CH = Math.max(CH, t.h); canvas.width = CW; canvas.height = CH; if (store.shown) present(); } }
      if (c.fps) fps = c.fps;
      if (c.w && c.h) expect = { w: c.w, h: c.h };
      if (ok && plan(c.delayMs ?? store.delay)) present();
    },
    setVisible(on) { hold.setVisible(on, performance.now()); },
    picture(now = performance.now()) { return hold.state(now); },
    get lost() { return hold.lost; },
    clear() { hold.forget(); r.blank(); },
    blank() { if (ok && gl) { store.reset(); present(); } },
    get hasShown() { return store.shown !== null; },
    frames: () => frames,
    snapshot() {
      const f = store.shown;
      if (!ok || !gl || !f) return null;
      const bottomUp = readFrame(f, 0, 0, f.w, f.h), data = new Uint8Array(bottomUp.length), row = f.w * 4;
      for (let y = 0; y < f.h; y++) data.set(bottomUp.subarray((f.h - 1 - y) * row, (f.h - y) * row), y * row);
      return { w: f.w, h: f.h, data };
    },
    stamp() {
      const f = store.shown, w = GS_STAMP_BLOCKS * 16;
      if (!o.stamp || !ok || !gl || !f || f.w < w || f.h < 16) return null;
      const px = readFrame(f, 0, 0, w, 16);
      let n = 0;
      for (let i = 0; i < GS_STAMP_BLOCKS; i++) n += px[((8 * w) + i * 16 + 8) * 4 + 3] > 127 ? 2 ** i : 0;
      let lag = (Date.now() % 2 ** GS_STAMP_BLOCKS) - n;
      if (lag < 0) lag += 2 ** GS_STAMP_BLOCKS;
      return { n, lagMs: lag < 5000 ? lag : null };
    },
    info() {
      let alphaMax = 0;
      const f = store.shown;
      if (ok && gl && f) { const px = readFrame(f, 0, 0, f.w, f.h); for (let i = 3; i < px.length; i += 4) if (px[i] > alphaMax) alphaMax = px[i]; }
      return { video: [video.videoWidth, video.videoHeight], picture: picW ? [picW, picH] : null, canvas: [CW, CH], delayMs: store.delay, queued: store.queued, shown: !!f, foreign, draws, alphaMax };
    },
  };
  return r;
}

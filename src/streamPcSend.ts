// Stream PC mode B, the sending side (docs/TWO_PC_STREAMING.md): this output page runs on the GAMING PC in a headless,
// muted system browser the helper starts (server/streamPc.ts Sender, output.html?spSend=1), and sends what it draws to
// the stream PC's receiver page (/streampc/view, server/streamPcPages.ts) as live video over WebRTC on the home network.
//   * Video carries no transparency, so every frame is packed: colour in the top half, transparency as grey in the
//     bottom half (one small WebGL pass); the receiver's shader puts the see-through background back.
//   * H.264 first (the browser's hardware encoder where it has one: NVIDIA / AMD / Intel via Media Foundation on
//     Windows), then VP8 / VP9. No STUN / TURN: host candidates only (the helper rewrites mDNS names to real addresses).
//   * Signalling: `spv` messages on the helper's bus (want / offer / answer / ice / bye / here / stats).
// The page itself never makes a sound (src/audio/silentPageAuto.ts) and adds no audio track.
/** Most video links this renderer keeps at once (each one is an encode on the gaming PC). */
const MAX_PEERS = 6;
/** An overlay layer that was invisible (hidden, tiny, off the frame, fully transparent) is looked at again after this long, or
 *  at once when the page's styles / classes / children change (see HiddenMemo). A layer that IS visible is checked every frame. */
export const LAYER_RECHECK_MS = 60;
/** Pure: remembers which overlay layers were found invisible, so the sender does not read their layout + computed styles on
 *  every frame (most frames have no overlay at all). Stale for at most `ms`; `invalidate()` makes all of them look again. */
export class HiddenMemo<K extends object> {
  private m = new WeakMap<K, { until: number; epoch: number }>();
  private epoch = 0;
  constructor(private ms = LAYER_RECHECK_MS) {}
  invalidate() { this.epoch++; }
  hidden(el: K, now: number): boolean { const e = this.m.get(el); return !!e && e.epoch === this.epoch && now < e.until; }
  mark(el: K, now: number) { this.m.set(el, { until: now + this.ms, epoch: this.epoch }); }
  clear(el: K) { this.m.delete(el); }
}
type Msg = Record<string, unknown> & { type?: string; k?: string; from?: string; to?: string };

export interface SenderStats { encoder: string; fps: number; width: number; height: number; kbps: number; codec: string; peers: number; packMs: number }

export function startStreamSender(src: HTMLCanvasElement, send: (m: Msg) => void, on: (h: (m: Msg) => void) => void, opts: { stamp?: boolean } = {}) {
  const id = `s${Math.random().toString(36).slice(2, 10)}`;
  const pack = document.createElement('canvas');
  const gl = pack.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
  if (!gl) { console.warn('[stream-pc] no WebGL for packing'); return null; }
  const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const pr = gl.createProgram()!;
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 u;void main(){u=vec2(p.x*.5+.5,p.y*.5+.5);gl_Position=vec4(p,0.,1.);}'));
  // (u.y: 0 = bottom of the packed frame. Top half = colour of the whole picture, bottom half = its transparency.)
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D t;varying vec2 u;void main(){if(u.y>=.5){gl_FragColor=vec4(texture2D(t,vec2(u.x,(u.y-.5)*2.)).rgb,1.);}else{float a=texture2D(t,vec2(u.x,u.y*2.)).a;gl_FragColor=vec4(a,a,a,1.);}}'));
  gl.linkProgram(pr); gl.useProgram(pr);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  // Picture overlays the output page keeps OUTSIDE its 3D canvas (room-change curtains, the poll card, 2D avatars in
  // overlay mode, the BRB picture): composited on top, in page order, with their opacity. (Text-only page overlays,
  // e.g. the tabletop captions, are not: docs/TWO_PC_STREAMING.md.)
  const comp = document.createElement('canvas');
  const cx = comp.getContext('2d', { alpha: true })!;
  type Layer = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
  let layers: Layer[] = [], layersAt = 0;
  // (layers found invisible are not measured again every frame; anything that changes styles / classes / children wakes them)
  const memo = new HiddenMemo<Layer>();
  try { new MutationObserver(() => memo.invalidate()).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'src'] }); } catch { /* the short recheck time still applies */ }
  const visibleAlpha = (el: Element): number => {
    let a = 1;
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      a *= Number(cs.opacity) || 0;
      if (a <= 0.01) return 0;
    }
    return a;
  };
  /** The layers to draw this frame: [element, left, top, width, height, opacity] (empty = nothing on top of the 3D canvas). */
  const vis: [Layer, number, number, number, number, number][] = [];
  const collectLayers = () => {
    vis.length = 0;
    const now = performance.now();
    if (now - layersAt > 500) { layersAt = now; layers = [...document.querySelectorAll<Layer>('canvas, img, video')].filter((e) => e !== src && e !== pack && e !== comp); }
    for (const el of layers) {
      if (!el.isConnected) continue;
      if (el instanceof HTMLImageElement && !el.complete) continue;
      if (el instanceof HTMLVideoElement && el.readyState < 2) continue;
      if (memo.hidden(el, now)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) { memo.mark(el, now); continue; }
      const a = visibleAlpha(el);
      if (a <= 0.01) { memo.mark(el, now); continue; }
      memo.clear(el);
      vis.push([el, r.left, r.top, r.width, r.height, a]);
    }
  };
  const drawLayers = (W: number, H: number) => {
    const sx = W / Math.max(1, innerWidth), sy = H / Math.max(1, innerHeight);
    for (const [el, l, t, w, h, a] of vis) {
      cx.globalAlpha = a;
      try { cx.drawImage(el, l * sx, t * sy, w * sx, h * sy); } catch { /* not ready */ }
    }
    cx.globalAlpha = 1;
  };
  // With nothing on top of the 3D canvas (almost every frame) it is uploaded as it is: no 2D copy. (Same pixels: the canvas
  // keeps its drawing buffer on this page, output.ts `preserve`, which the 2D copy needed too.) A failure falls back for good.
  let direct = true;
  let packMs = 0;
  const frame = () => {
    const W = src.width, H = src.height;
    if (W > 0 && H > 0) {
      if (pack.width !== W || pack.height !== H * 2) { pack.width = W; pack.height = H * 2; }
      const t0 = performance.now();
      collectLayers();
      gl.viewport(0, 0, W, H * 2);
      let uploaded = false;
      if (direct && vis.length === 0) {
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); uploaded = true; } catch { direct = false; }
      }
      if (!uploaded) {
        if (comp.width !== W || comp.height !== H) { comp.width = W; comp.height = H; }
        cx.clearRect(0, 0, W, H);
        cx.drawImage(src, 0, 0, W, H);
        drawLayers(W, H);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, comp);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (opts.stamp) {
        // test switch: Date.now() (24 bits) as 16 px blocks along the bottom edge, read back by the receiver = latency
        const n = Date.now() % (1 << 24);
        gl.enable(gl.SCISSOR_TEST);
        for (let i = 0; i < 24; i++) { gl.scissor(i * 16, 0, 16, 16); const v = (n >> i) & 1; gl.clearColor(v, v, v, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
        gl.disable(gl.SCISSOR_TEST);
      }
      packMs = packMs * 0.95 + (performance.now() - t0) * 0.05;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const stream = pack.captureStream(60);
  const track = stream.getVideoTracks()[0];
  try { track.contentHint = 'motion'; } catch { /* old browser */ }

  const peers = new Map<string, { pc: RTCPeerConnection; at: number }>();
  const last = new Map<string, { bytes: number; at: number }>(); // (bytes sent per receiver: the bit rate)
  const close = (rid: string) => { last.delete(rid); const p = peers.get(rid); if (p) { try { p.pc.close(); } catch { /* closed */ } peers.delete(rid); } };
  async function offer(rid: string) {
    close(rid);
    // extra safety (review r4): at most MAX_PEERS links (stream PCs x their receivers); the oldest goes first
    while (peers.size >= MAX_PEERS) { const oldest = [...peers.entries()].sort((x, y) => x[1].at - y[1].at)[0]; if (!oldest) break; close(oldest[0]); }
    const pc = new RTCPeerConnection({ iceServers: [] });
    peers.set(rid, { pc, at: Date.now() });
    const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    try {
      const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const rank = (c: { mimeType: string; sdpFmtpLine?: string }) => (/h264/i.test(c.mimeType) ? (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 1) : /vp9/i.test(c.mimeType) ? 2 : /vp8/i.test(c.mimeType) ? 3 : /av1/i.test(c.mimeType) ? 4 : 9);
      tx.setCodecPreferences([...caps].sort((a, b2) => rank(a) - rank(b2)));
    } catch { /* the browser picks */ }
    pc.onicecandidate = (e) => send({ type: 'spv', k: 'ice', from: id, to: rid, cand: e.candidate ? e.candidate.toJSON() as unknown as Record<string, unknown> : null });
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { if (peers.get(rid)?.pc === pc) peers.delete(rid); } };
    await pc.setLocalDescription(await pc.createOffer());
    try {
      const p = tx.sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = 25_000_000; p.encodings[0].maxFramerate = 60;
      (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
      await tx.sender.setParameters(p);
    } catch { /* defaults */ }
    send({ type: 'spv', k: 'offer', from: id, to: rid, sdp: pc.localDescription!.sdp });
  }
  on((m) => {
    if (m.type !== 'spv' || typeof m.from !== 'string') return;
    if (m.k === 'want') {
      const p = peers.get(m.from);
      // (a receiver asks every 3 s until it shows pictures: don't restart one that is connecting / connected)
      if (p && (p.pc.connectionState === 'connected' || (p.pc.connectionState !== 'failed' && Date.now() - p.at < 8000))) return;
      void offer(m.from).catch((e) => console.warn('[stream-pc] offer', e));
    } else if (m.to === id && m.k === 'answer' && typeof m.sdp === 'string') {
      void peers.get(m.from)?.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => console.warn('[stream-pc] answer', e));
    } else if (m.to === id && m.k === 'ice') {
      void peers.get(m.from)?.pc.addIceCandidate((m.cand as RTCIceCandidateInit | null) ?? null).catch(() => {});
    } else if (m.k === 'bye') close(m.from);
  });
  send({ type: 'spv', k: 'here', from: id });
  setInterval(() => send({ type: 'spv', k: 'here', from: id }), 10_000);

  const stats: SenderStats = { encoder: '', fps: 0, width: 0, height: 0, kbps: 0, codec: '', peers: 0, packMs: 0 };
  setInterval(async () => {
    stats.peers = [...peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
    stats.packMs = Math.round(packMs * 100) / 100;
    for (const [rid, p] of peers) {
      try {
        const r = await p.pc.getStats();
        r.forEach((x) => {
          if (x.type !== 'outbound-rtp' || x.kind !== 'video') return;
          stats.encoder = x.encoderImplementation ?? ''; stats.fps = Math.round(x.framesPerSecond ?? 0); stats.width = x.frameWidth ?? 0; stats.height = x.frameHeight ?? 0;
          const c = x.codecId ? r.get(x.codecId) : null; stats.codec = c?.mimeType ?? '';
          const now = performance.now(), l = last.get(rid); if (l && now > l.at) stats.kbps = Math.round(((x.bytesSent - l.bytes) * 8) / (now - l.at)); last.set(rid, { bytes: x.bytesSent, at: now });
        });
        send({ type: 'spv', k: 'stats', from: id, to: rid, enc: { ...stats } });
      } catch { /* closed */ }
    }
  }, 2000);
  window.addEventListener('pagehide', () => { for (const rid of [...peers.keys()]) { send({ type: 'spv', k: 'bye', from: id, to: rid }); close(rid); } });
  (window as unknown as { __spSend?: unknown }).__spSend = { id, stats: () => ({ ...stats }), peers: () => peers.size, stream, packMs: () => packMs };
  return { id, stats: () => ({ ...stats }) };
}

// Exact RGBA8 bytes of an image through a throw-away WebGL2 context (used by the painted-eye replacement,
// src/avatar/bakedEyes.ts). A 2D canvas would premultiply alpha and blacken transparent texels, so the bytes go
// through GL with no premultiplication and no colour conversion: row 0 = the image's top row.
//
// readTextureExactAsync() returns the SAME bytes as readTextureExact(); the difference is the wait. readPixels into
// the CPU blocks the page until the GPU process has drained everything queued before it (a 64 MB atlas on a busy
// GPU can take a long time, while the tracker is running). The async version reads into a pixel-pack buffer,
// fences it, and hands the thread back (setTimeout) until the fence is signalled.

/** Minimal slice of WebGL2RenderingContext this file touches (lets the unit test drive a fake). */
export type GlLike = WebGL2RenderingContext;

function uploadAndBind(gl: GlLike, img: TexImageSource, W: number, H: number): { tex: WebGLTexture | null; fb: WebGLFramebuffer | null } | null {
  const tex = gl.createTexture(), fb = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const data = (img as unknown as { data?: ArrayBufferView }).data;
  if (data && ArrayBuffer.isView(data)) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { release(gl, tex, fb); return null; }
  return { tex, fb };
}

function release(gl: GlLike, tex: WebGLTexture | null, fb: WebGLFramebuffer | null) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
}

/** Blocking read (the original path; also the fallback of the async one). Null = couldn't read. */
export function readTextureExact(gl: GlLike, img: TexImageSource, W: number, H: number): Uint8Array | null {
  let bound: { tex: WebGLTexture | null; fb: WebGLFramebuffer | null } | null = null;
  try {
    bound = uploadAndBind(gl, img, W, H);
    if (!bound) return null;
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  } catch { return null; }
  finally { if (bound) release(gl, bound.tex, bound.fb); }
}

/**
 * Same bytes as readTextureExact(), without blocking the page on the GPU: read into a pixel-pack buffer, wait on a
 * fence in short timer slices, then copy the buffer out. Any trouble (no fence support, a lost context, no answer
 * within `maxWaitMs`) falls back to the blocking read, so the result never differs.
 */
export async function readTextureExactAsync(gl: GlLike, img: TexImageSource, W: number, H: number, maxWaitMs = 10000, sleepMs = 2): Promise<Uint8Array | null> {
  let bound: { tex: WebGLTexture | null; fb: WebGLFramebuffer | null } | null = null;
  let pbo: WebGLBuffer | null = null;
  let sync: WebGLSync | null = null;
  try {
    bound = uploadAndBind(gl, img, W, H);
    if (!bound) return null;
    pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error('no fence');
    gl.flush();
    const t0 = Date.now();
    for (;;) {
      const r = gl.clientWaitSync(sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) break;
      if (r === gl.WAIT_FAILED || Date.now() - t0 > maxWaitMs) throw new Error('fence wait failed');
      await new Promise<void>((res) => setTimeout(res, sleepMs));
    }
    const out = new Uint8Array(W * H * 4);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    return out;
  } catch {
    // (cleaned up below, then read the blocking way)
    if (sync) { try { gl.deleteSync(sync); } catch { /* lost */ } sync = null; }
    if (pbo) { try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(pbo); } catch { /* lost */ } pbo = null; }
    if (bound) { try { release(gl, bound.tex, bound.fb); } catch { /* lost */ } bound = null; }
    return readTextureExact(gl, img, W, H);
  } finally {
    try {
      if (sync) gl.deleteSync(sync);
      if (pbo) { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(pbo); }
      if (bound) release(gl, bound.tex, bound.fb);
    } catch { /* lost context */ }
  }
}

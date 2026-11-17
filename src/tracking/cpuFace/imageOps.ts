// CPU pixels for the processor-only face tracker: a camera frame's planes as copied out of a VideoFrame (I420 / NV12 /
// RGBA-family) or an ImageData, sampled straight into the models' input tensors. This is MediaPipe's CPU image
// preprocessing (ImageToTensorCalculator, OpenCV converter: warpPerspective with bilinear filtering, 8-bit result,
// then a linear value range), done here without any canvas or WebGL. YUV frames are filtered in YUV and converted once
// per output pixel (the same as converting first, up to clamping at the extremes).

export type PixelFormat = 'I420' | 'I420A' | 'NV12' | 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX';

export interface Planes {
  format: PixelFormat;
  /** the whole frame's size (the coordinate space every rect and landmark uses) */
  frameW: number;
  frameH: number;
  /** the copied region of the frame (pixels outside it are never read) */
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Uint8Array;
  /** per plane: byte offset and row stride, as VideoFrame.copyTo reports them (Y, U, V / Y, UV / RGBA) */
  layout: { offset: number; stride: number }[];
  /** YUV only: full-range (JPEG) samples, and the colour matrix */
  fullRange?: boolean;
  matrix?: 'bt601' | 'bt709';
}

/** dst pixel (u, v) -> source pixel (x, y): x = a u + b v + c, y = d u + e v + f (OpenCV convention: pixel centres on
 *  integer coordinates, as warpPerspective samples). */
export type Affine = [number, number, number, number, number, number];

interface Yuv2Rgb { ky: number; oy: number; rv: number; gu: number; gv: number; bu: number }
function yuvCoeffs(full: boolean, m: 'bt601' | 'bt709'): Yuv2Rgb {
  if (m === 'bt709') return full ? { ky: 1, oy: 0, rv: 1.5748, gu: 0.1873, gv: 0.4681, bu: 1.8556 } : { ky: 1.1644, oy: 16, rv: 1.7927, gu: 0.2132, gv: 0.5329, bu: 2.1124 };
  return full ? { ky: 1, oy: 0, rv: 1.402, gu: 0.344136, gv: 0.714136, bu: 1.772 } : { ky: 1.1644, oy: 16, rv: 1.596, gu: 0.3918, gv: 0.813, bu: 2.0172 };
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** How 4:2:0 chroma is brought up to luma resolution: 'nearest' (each 2x2 block shares its sample, as libyuv's CPU
 *  conversions do) or 'linear' (bilinear between chroma samples, centred siting, as a GPU texture sampler does). */
export let chromaMode: 'nearest' | 'linear' = 'linear';
export function setChromaMode(m: 'nearest' | 'linear') { chromaMode = m; }

/**
 * Sample the frame into a float tensor through `M`: `out` gets `outW x outH` pixels, as planar RGB (NCHW, `planar`) or
 * interleaved RGB (NHWC), each value round(bilinear 8-bit) * scale + offset (MediaPipe: uint8 warp, then convertTo).
 * Border: 'zero' = taps outside the frame are black (detector letterbox), 'replicate' = the nearest edge pixel.
 */
export function warpToTensor(p: Planes, M: Affine, outW: number, outH: number, out: Float32Array, scale: number, offset: number,
  border: 'zero' | 'replicate', planar = true) {
  const [a, b, c, d, e, f] = M;
  const plane = outW * outH;
  const W = p.frameW, H = p.frameH;
  // readable area: the copied region (always inside the frame)
  const rx0 = p.x0, ry0 = p.y0, rx1 = p.x0 + p.w - 1, ry1 = p.y0 + p.h - 1;
  const yuv = p.format === 'I420' || p.format === 'I420A' || p.format === 'NV12';
  const nv12 = p.format === 'NV12';
  const D = p.data;
  const L0 = p.layout[0], L1 = p.layout[1], L2 = p.layout[2];
  const co = yuv ? yuvCoeffs(!!p.fullRange, p.matrix ?? 'bt601') : null;
  // RGBA family: byte index of R, G, B within a pixel
  const bgr = p.format === 'BGRA' || p.format === 'BGRX';
  const iR = bgr ? 2 : 0, iB = bgr ? 0 : 2;
  const cx0 = rx0 >> 1, cy0 = ry0 >> 1;
  const zero = border === 'zero';
  // the general case, one output pixel (borders, RGBA, nearest chroma, NHWC output)
  const px = (u: number, v: number, o: number) => {
      const sx = a * u + b * v + c, sy = d * u + e * v + f;
      let x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      let x1 = x0 + 1, y1 = y0 + 1;
      // tap weights (a zero-border tap outside the frame weighs 0: its value is black)
      let w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      if (zero) {
        if (x0 < 0 || x0 >= W) { w00 = 0; w01 = 0; }
        if (x1 < 0 || x1 >= W) { w10 = 0; w11 = 0; }
        if (y0 < 0 || y0 >= H) { w00 = 0; w10 = 0; }
        if (y1 < 0 || y1 >= H) { w01 = 0; w11 = 0; }
      }
      x0 = x0 < rx0 ? rx0 : x0 > rx1 ? rx1 : x0; x1 = x1 < rx0 ? rx0 : x1 > rx1 ? rx1 : x1;
      y0 = y0 < ry0 ? ry0 : y0 > ry1 ? ry1 : y0; y1 = y1 < ry0 ? ry0 : y1 > ry1 ? ry1 : y1;
      let R: number, G: number, B: number;
      if (co) {
        const ys0 = L0.offset + (y0 - ry0) * L0.stride - rx0, ys1 = L0.offset + (y1 - ry0) * L0.stride - rx0;
        const Y = D[ys0 + x0] * w00 + D[ys0 + x1] * w10 + D[ys1 + x0] * w01 + D[ys1 + x1] * w11;
        let U: number, V: number;
        let qx0: number, qx1: number, qy0: number, qy1: number, c00 = w00, c10 = w10, c01 = w01, c11 = w11;
        if (chromaMode === 'linear') {
          // bilinear on the chroma planes at the sample point (chroma sample (i, j) sits at luma (2i + 0.5, 2j + 0.5))
          const ux = (sx - 0.5) / 2, uy = (sy - 0.5) / 2;
          const ix = Math.floor(ux), iy = Math.floor(uy), gx = ux - ix, gy = uy - iy;
          const cmx = rx1 >> 1, cmy = ry1 >> 1;
          qx0 = (ix < cx0 ? cx0 : ix > cmx ? cmx : ix) - cx0; qx1 = (ix + 1 < cx0 ? cx0 : ix + 1 > cmx ? cmx : ix + 1) - cx0;
          qy0 = (iy < cy0 ? cy0 : iy > cmy ? cmy : iy) - cy0; qy1 = (iy + 1 < cy0 ? cy0 : iy + 1 > cmy ? cmy : iy + 1) - cy0;
          const wsum = w00 + w10 + w01 + w11; // (zero border: the black share of the luma taps)
          c00 = (1 - gx) * (1 - gy) * wsum; c10 = gx * (1 - gy) * wsum; c01 = (1 - gx) * gy * wsum; c11 = gx * gy * wsum;
        } else {
          // chroma of each tap's 2x2 block (as a nearest-chroma YUV -> RGB conversion gives it), blended with the same weights
          qx0 = (x0 >> 1) - cx0; qx1 = (x1 >> 1) - cx0; qy0 = (y0 >> 1) - cy0; qy1 = (y1 >> 1) - cy0;
        }
        if (nv12) {
          const r0 = L1.offset + qy0 * L1.stride, r1 = L1.offset + qy1 * L1.stride;
          U = D[r0 + qx0 * 2] * c00 + D[r0 + qx1 * 2] * c10 + D[r1 + qx0 * 2] * c01 + D[r1 + qx1 * 2] * c11;
          V = D[r0 + qx0 * 2 + 1] * c00 + D[r0 + qx1 * 2 + 1] * c10 + D[r1 + qx0 * 2 + 1] * c01 + D[r1 + qx1 * 2 + 1] * c11;
        } else {
          const u0 = L1.offset + qy0 * L1.stride, u1 = L1.offset + qy1 * L1.stride, v0 = L2.offset + qy0 * L2.stride, v1 = L2.offset + qy1 * L2.stride;
          U = D[u0 + qx0] * c00 + D[u0 + qx1] * c10 + D[u1 + qx0] * c01 + D[u1 + qx1] * c11;
          V = D[v0 + qx0] * c00 + D[v0 + qx1] * c10 + D[v1 + qx0] * c01 + D[v1 + qx1] * c11;
        }
        const ws = w00 + w10 + w01 + w11; // < 1 only where zero-border taps were dropped: those taps are black
        const yy = co.ky * (Y - co.oy * ws), uu = U - 128 * ws, vv = V - 128 * ws;
        R = yy + co.rv * vv; G = yy - co.gu * uu - co.gv * vv; B = yy + co.bu * uu;
      } else {
        const s = L0.stride;
        const p00 = L0.offset + (y0 - ry0) * s + (x0 - rx0) * 4, p10 = L0.offset + (y0 - ry0) * s + (x1 - rx0) * 4;
        const p01 = L0.offset + (y1 - ry0) * s + (x0 - rx0) * 4, p11 = L0.offset + (y1 - ry0) * s + (x1 - rx0) * 4;
        R = D[p00 + iR] * w00 + D[p10 + iR] * w10 + D[p01 + iR] * w01 + D[p11 + iR] * w11;
        G = D[p00 + 1] * w00 + D[p10 + 1] * w10 + D[p01 + 1] * w01 + D[p11 + 1] * w11;
        B = D[p00 + iB] * w00 + D[p10 + iB] * w10 + D[p01 + iB] * w01 + D[p11 + iB] * w11;
      }
      R = Math.round(clamp255(R)); G = Math.round(clamp255(G)); B = Math.round(clamp255(B));
      if (planar) { out[o] = R * scale + offset; out[o + plane] = G * scale + offset; out[o + 2 * plane] = B * scale + offset; }
      else { out[o * 3] = R * scale + offset; out[o * 3 + 1] = G * scale + offset; out[o * 3 + 2] = B * scale + offset; }
  };
  // the hot case (every landmark frame): I420 / NV12, linear chroma, planar output, all four luma and chroma taps inside
  // the copied region: the same arithmetic without clamps or border logic (~2x faster), the general one elsewhere
  const fast = !!co && planar && chromaMode === 'linear';
  const ky = co?.ky ?? 0, oy = co?.oy ?? 0, rv = co?.rv ?? 0, gu = co?.gu ?? 0, gv = co?.gv ?? 0, bu = co?.bu ?? 0;
  const cmx = rx1 >> 1, cmy = ry1 >> 1;
  const yo = L0.offset - ry0 * L0.stride - rx0, ys = L0.stride;
  const uo = L1 ? L1.offset - cy0 * L1.stride : 0, us = L1 ? L1.stride : 0, vo = L2 ? L2.offset - cy0 * L2.stride : 0, vs = L2 ? L2.stride : 0;
  const cstep = nv12 ? 2 : 1;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    let sx = b * v + c, sy = e * v + f;
    for (let u = 0; u < outW; u++, o++, sx += a, sy += d) {
      if (fast) {
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const ux = (sx - 0.5) * 0.5, uy = (sy - 0.5) * 0.5, ix = Math.floor(ux), iy = Math.floor(uy);
        if (x0 >= rx0 && x0 < rx1 && y0 >= ry0 && y0 < ry1 && ix >= cx0 && ix < cmx && iy >= cy0 && iy < cmy) {
          const fx = sx - x0, fy = sy - y0, gx = ux - ix, gy = uy - iy;
          const r0 = yo + y0 * ys + x0, r1 = r0 + ys;
          const top = D[r0] + (D[r0 + 1] - D[r0]) * fx, bot = D[r1] + (D[r1 + 1] - D[r1]) * fx;
          const Y = top + (bot - top) * fy;
          const qx = (ix - cx0) * cstep;
          let U: number, V: number;
          if (nv12) {
            const c0 = uo + iy * us + qx, c1 = c0 + us;
            const ut = D[c0] + (D[c0 + 2] - D[c0]) * gx, ub = D[c1] + (D[c1 + 2] - D[c1]) * gx;
            const vt = D[c0 + 1] + (D[c0 + 3] - D[c0 + 1]) * gx, vb = D[c1 + 1] + (D[c1 + 3] - D[c1 + 1]) * gx;
            U = ut + (ub - ut) * gy; V = vt + (vb - vt) * gy;
          } else {
            const c0 = uo + iy * us + qx, c1 = c0 + us, d0 = vo + iy * vs + qx, d1 = d0 + vs;
            const ut = D[c0] + (D[c0 + 1] - D[c0]) * gx, ub = D[c1] + (D[c1 + 1] - D[c1]) * gx;
            const vt = D[d0] + (D[d0 + 1] - D[d0]) * gx, vb = D[d1] + (D[d1 + 1] - D[d1]) * gx;
            U = ut + (ub - ut) * gy; V = vt + (vb - vt) * gy;
          }
          const yy = ky * (Y - oy), uu = U - 128, vv = V - 128;
          let R = yy + rv * vv, G = yy - gu * uu - gv * vv, B = yy + bu * uu;
          R = R < 0 ? 0 : R > 255 ? 255 : R; G = G < 0 ? 0 : G > 255 ? 255 : G; B = B < 0 ? 0 : B > 255 ? 255 : B;
          out[o] = ((R + 0.5) | 0) * scale + offset; out[o + plane] = ((G + 0.5) | 0) * scale + offset; out[o + 2 * plane] = ((B + 0.5) | 0) * scale + offset;
          continue;
        }
      }
      px(u, v, o);
    }
  }
}

/** The same sampling into 8-bit RGBA (the mouth-interior patch, mouthImage.ts). */
export function warpToRgba(p: Planes, M: Affine, outW: number, outH: number, out: Uint8ClampedArray) {
  const tmp = new Float32Array(outW * outH * 3);
  warpToTensor(p, M, outW, outH, tmp, 1, 0, 'replicate', false);
  for (let i = 0, n = outW * outH; i < n; i++) { out[i * 4] = tmp[i * 3]; out[i * 4 + 1] = tmp[i * 3 + 1]; out[i * 4 + 2] = tmp[i * 3 + 2]; out[i * 4 + 3] = 255; }
}

/**
 * The affine map of MediaPipe's ImageToTensor for a rotated rect (pixels: centre, size, rotation in radians): the
 * output's corners (0, h), (0, 0), (w, 0), (w, h) land on cv::boxPoints of the rect, i.e. dst (u, v) samples
 * centre + R(rot) [(u / outW - 0.5) rw, (v / outH - 0.5) rh].
 */
export function rectToAffine(cx: number, cy: number, rw: number, rh: number, rot: number, outW: number, outH: number): Affine {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const ax = rw / outW, ay = rh / outH;
  return [cs * ax, -sn * ay, cx - cs * rw * 0.5 + sn * rh * 0.5, sn * ax, cs * ay, cy - sn * rw * 0.5 - cs * rh * 0.5];
}

/** Planes of an RGBA ImageData-like buffer (the canvas fallback, tests). */
export function rgbaPlanes(data: Uint8Array | Uint8ClampedArray, w: number, h: number): Planes {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { format: 'RGBA', frameW: w, frameH: h, x0: 0, y0: 0, w, h, data: u8, layout: [{ offset: 0, stride: w * 4 }] };
}

// Portions ported from MediaPipe: Copyright 2023 The MediaPipe Authors, Apache License 2.0 (THIRD_PARTY_NOTICES.md).
// The facial transformation matrix, as MediaPipe's face geometry pipeline computes it (port of
// mediapipe/tasks/cc/vision/face_geometry/libs/geometry_pipeline.cc + procrustes_solver.cc, Apache-2.0): the canonical
// face mesh (geometry_pipeline_metadata_landmarks.binarypb in face_landmarker.task) is fitted to the 468 screen
// landmarks under a 63° perspective camera with a weighted orthogonal Procrustes solve (scale, rotation, translation).
// The optimal rotation uses Horn's quaternion method, which gives the same proper rotation as the SVD (Kabsch) solution
// MediaPipe uses, including its reflection fix.

export interface GeometryMeta {
  /** canonical landmarks, xyz per vertex (468) */
  canonical: Float32Array;
  /** Procrustes weight per vertex (0 for vertices outside the landmark basis) */
  weights: Float32Array;
  /** input_source: 1 face landmark pipeline (default), 2 face detection pipeline */
  inputSource: number;
}

// ---- protobuf (proto2) reader for GeometryPipelineMetadata ----
function readVarint(b: Uint8Array, o: { p: number }): number {
  let r = 0, s = 0, x: number;
  do { x = b[o.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
  return r;
}

/** GeometryPipelineMetadata { canonical_mesh = 1 (Mesh3d: vertex_type 1, primitive_type 2, vertex_buffer 3 (float),
 *  index_buffer 4); procrustes_landmark_basis = 2 (landmark_id 1, weight 2); input_source = 3 }. VERTEX_PT: 5 floats per
 *  vertex (xyz + uv). */
export function parseGeometryMeta(b: Uint8Array): GeometryMeta {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const o = { p: 0 };
  const vb: number[] = [];
  const basis: [number, number][] = [];
  let inputSource = 0;
  const skip = (wire: number) => {
    if (wire === 0) readVarint(b, o); else if (wire === 1) o.p += 8; else if (wire === 5) o.p += 4; else if (wire === 2) o.p += readVarint(b, o);
    else throw new Error('geometry metadata: bad wire type');
  };
  while (o.p < b.length) {
    const key = readVarint(b, o), f = Math.floor(key / 8), w = key & 7;
    if (f === 1 && w === 2) {
      const end = readVarint(b, o) + o.p;
      while (o.p < end) {
        const k2 = readVarint(b, o), f2 = Math.floor(k2 / 8), w2 = k2 & 7;
        if (f2 === 3 && w2 === 2) { const e2 = readVarint(b, o) + o.p; while (o.p < e2) { vb.push(dv.getFloat32(o.p, true)); o.p += 4; } }
        else if (f2 === 3 && w2 === 5) { vb.push(dv.getFloat32(o.p, true)); o.p += 4; }
        else skip(w2);
      }
    } else if (f === 2 && w === 2) {
      const end = readVarint(b, o) + o.p;
      let id = 0, wt = 0;
      while (o.p < end) {
        const k2 = readVarint(b, o), f2 = Math.floor(k2 / 8), w2 = k2 & 7;
        if (f2 === 1 && w2 === 0) id = readVarint(b, o);
        else if (f2 === 2 && w2 === 5) { wt = dv.getFloat32(o.p, true); o.p += 4; }
        else skip(w2);
      }
      basis.push([id, wt]);
    } else if (f === 3 && w === 0) inputSource = readVarint(b, o);
    else skip(w);
  }
  const n = Math.floor(vb.length / 5);
  const canonical = new Float32Array(n * 3), weights = new Float32Array(n);
  for (let i = 0; i < n; i++) { canonical[i * 3] = vb[i * 5]; canonical[i * 3 + 1] = vb[i * 5 + 1]; canonical[i * 3 + 2] = vb[i * 5 + 2]; }
  for (const [id, wt] of basis) if (id < n) weights[id] = wt;
  return { canonical, weights, inputSource: inputSource || 1 };
}

// ---- weighted orthogonal Procrustes: target ≈ s R source + t ----
/** 4x4 column-major [R*s | t]. */
export type Mat4 = Float64Array;

/** Largest-eigenvalue eigenvector of a symmetric 4x4 (cyclic Jacobi). */
function maxEigVec4(N: number[][]): number[] {
  const a = N.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (a[k][k] > a[best][best]) best = k;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/** Solve min Σ w_i |s R src_i + t − dst_i|² (MediaPipe's FloatPrecisionProcrustesSolver). src/dst: xyz per point. */
export function solveWeightedOrthogonal(src: ArrayLike<number>, dst: ArrayLike<number>, w: ArrayLike<number>): Mat4 {
  const n = w.length;
  let W = 0, sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) { const wi = w[i]; if (!wi) continue; W += wi; sx += wi * src[i * 3]; sy += wi * src[i * 3 + 1]; sz += wi * src[i * 3 + 2]; }
  if (!(W > 1e-9)) throw new Error('procrustes: weights too small');
  sx /= W; sy /= W; sz /= W;
  // design matrix M = Σ w (dst) (src - c)^T   (MediaPipe: weighted_targets * centered_weighted_sources^T)
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let den = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i]; if (!wi) continue;
    const cx = src[i * 3] - sx, cy = src[i * 3 + 1] - sy, cz = src[i * 3 + 2] - sz;
    const dx = dst[i * 3], dy = dst[i * 3 + 1], dz = dst[i * 3 + 2];
    M[0][0] += wi * dx * cx; M[0][1] += wi * dx * cy; M[0][2] += wi * dx * cz;
    M[1][0] += wi * dy * cx; M[1][1] += wi * dy * cy; M[1][2] += wi * dy * cz;
    M[2][0] += wi * dz * cx; M[2][1] += wi * dz * cy; M[2][2] += wi * dz * cz;
    den += wi * (cx * src[i * 3] + cy * src[i * 3 + 1] + cz * src[i * 3 + 2]);
  }
  // R maximises tr(R^T M): Horn's quaternion method on S = M^T (source -> target correlation)
  const Sxx = M[0][0], Sxy = M[1][0], Sxz = M[2][0], Syx = M[0][1], Syy = M[1][1], Syz = M[2][1], Szx = M[0][2], Szy = M[1][2], Szz = M[2][2];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const [q0, qx, qy, qz] = maxEigVec4(N);
  const R = [
    [q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy)],
    [2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx)],
    [2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz],
  ];
  // scale = Σ w (R c)·dst / Σ w c·src   (MediaPipe ComputeOptimalScale)
  let num = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i]; if (!wi) continue;
    const cx = src[i * 3] - sx, cy = src[i * 3 + 1] - sy, cz = src[i * 3 + 2] - sz;
    num += wi * ((R[0][0] * cx + R[0][1] * cy + R[0][2] * cz) * dst[i * 3] + (R[1][0] * cx + R[1][1] * cy + R[1][2] * cz) * dst[i * 3 + 1] + (R[2][0] * cx + R[2][1] * cy + R[2][2] * cz) * dst[i * 3 + 2]);
  }
  if (!(den > 1e-9) || !(num / den > 1e-9)) throw new Error('procrustes: scale too small');
  const s = num / den;
  // translation = Σ w (dst - sR src) / W
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i]; if (!wi) continue;
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    tx += wi * (dst[i * 3] - s * (R[0][0] * x + R[0][1] * y + R[0][2] * z));
    ty += wi * (dst[i * 3 + 1] - s * (R[1][0] * x + R[1][1] * y + R[1][2] * z));
    tz += wi * (dst[i * 3 + 2] - s * (R[2][0] * x + R[2][1] * y + R[2][2] * z));
  }
  const m = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = s * R[r][c];
  m[12] = tx / W; m[13] = ty / W; m[14] = tz / W; m[15] = 1;
  return m;
}

function applyRow2(m: Mat4, x: number, y: number, z: number) { return m[2] * x + m[6] * y + m[10] * z + m[14]; }
const colNorm0 = (m: Mat4) => Math.hypot(m[0], m[1], m[2]);

/**
 * The pose transform of one face: screen landmarks (normalized x, y in [0,1] of a frame of the given size, z in the
 * same scale as x) -> 4x4 column-major matrix (MediaPipe's facialTransformationMatrixes[0].data). Default environment:
 * origin top-left, vertical FOV 63°, near 1, far 10000. Returns null when the landmarks are degenerate.
 */
export function faceTransform(meta: GeometryMeta, lm: ArrayLike<number>, frameW: number, frameH: number): Float32Array | null {
  const n = meta.weights.length;
  if (lm.length < n * 3) return null;
  // too compact (all landmarks within 1e-3 of their mean): MediaPipe skips the face
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += (lm[i * 3] - mx) / (i + 1); my += (lm[i * 3 + 1] - my) / (i + 1); }
  let md = 0;
  for (let i = 0; i < n; i++) md = Math.max(md, (lm[i * 3] - mx) ** 2 + (lm[i * 3 + 1] - my) ** 2);
  if (Math.sqrt(md) <= 1e-3) return null;
  const near = 1, fov = 63;
  const hNear = 2 * near * Math.tan(0.5 * (Math.PI / 180) * fov), wNear = (frameW * hNear) / frameH;
  const left = -0.5 * wNear, bottom = -0.5 * hNear;
  // ProjectXY (origin top-left: y flipped), z scaled like x
  const scr = new Float64Array(n * 3);
  let depth = 0;
  for (let i = 0; i < n; i++) {
    scr[i * 3] = lm[i * 3] * wNear + left;
    scr[i * 3 + 1] = (1 - lm[i * 3 + 1]) * hNear + bottom;
    scr[i * 3 + 2] = lm[i * 3 + 2] * wNear;
    depth += scr[i * 3 + 2];
  }
  depth /= n;
  const can = meta.canonical, w = meta.weights;
  const tryFit = (pts: Float64Array) => solveWeightedOrthogonal(can, pts, w);
  try {
    // first scale estimate: on the handedness-flipped screen landmarks
    const inter = new Float64Array(scr);
    for (let i = 0; i < n; i++) inter[i * 3 + 2] *= -1;
    const s1 = colNorm0(tryFit(inter));
    const moveUnproject = (src: Float64Array, scale: number, out: Float64Array) => {
      for (let i = 0; i < n; i++) {
        const z = (src[i * 3 + 2] - depth + near) / scale;
        out[i * 3] = (src[i * 3] * z) / near;
        out[i * 3 + 1] = (src[i * 3 + 1] * z) / near;
        out[i * 3 + 2] = -z;
      }
    };
    moveUnproject(scr, s1, inter);
    if (meta.inputSource === 2) {
      const p = tryFit(inter);
      for (let i = 0; i < n; i++) inter[i * 3 + 2] = applyRow2(p, can[i * 3], can[i * 3 + 1], can[i * 3 + 2]);
    }
    const s2 = colNorm0(tryFit(inter));
    const metric = new Float64Array(n * 3);
    moveUnproject(scr, s1 * s2, metric);
    let pose = tryFit(metric);
    if (meta.inputSource === 2) {
      for (let i = 0; i < n; i++) metric[i * 3 + 2] = applyRow2(pose, can[i * 3], can[i * 3 + 1], can[i * 3 + 2]);
      pose = tryFit(metric);
    }
    return Float32Array.from(pose);
  } catch { return null; }
}

// A small reader for TensorFlow Lite flatbuffer models (.tflite): tensors, constant buffers, operators and their options.
// Enough for the processor-only face tracker (cpuFace/*), which runs MediaPipe's own face models (from the shipped
// face_landmarker.task, Apache-2.0) on its own CPU engine instead of tasks-vision's WebGL path. Field numbers follow
// tensorflow/compiler/mlir/lite/schema/schema.fbs. Works in workers, the page and Node (no Buffer, no DOM).

export const OP: Record<number, string> = {
  0: 'ADD', 1: 'AVERAGE_POOL_2D', 2: 'CONCATENATION', 3: 'CONV_2D', 4: 'DEPTHWISE_CONV_2D', 6: 'DEQUANTIZE', 9: 'FULLY_CONNECTED',
  14: 'LOGISTIC', 17: 'MAX_POOL_2D', 18: 'MUL', 19: 'RELU', 21: 'RELU6', 22: 'RESHAPE', 23: 'RESIZE_BILINEAR', 25: 'SOFTMAX',
  28: 'TANH', 32: 'CUSTOM', 34: 'PAD', 36: 'GATHER', 39: 'TRANSPOSE', 40: 'MEAN', 41: 'SUB', 42: 'DIV', 43: 'SQUEEZE',
  45: 'STRIDED_SLICE', 54: 'PRELU', 55: 'MAXIMUM', 57: 'MINIMUM', 59: 'NEG', 74: 'SUM', 75: 'SQRT', 76: 'RSQRT', 99: 'SQUARED_DIFFERENCE',
  117: 'HARD_SWISH', 124: 'DENSIFY',
};

/** TensorType: FLOAT32 0, FLOAT16 1, INT32 2, UINT8 3, INT64 4, INT8 9. */
export type TfType = 'f32' | 'f16' | 'i32' | 'u8' | 'i64' | 'i8' | 'other';
const TYPE: Record<number, TfType> = { 0: 'f32', 1: 'f16', 2: 'i32', 3: 'u8', 4: 'i64', 9: 'i8' };

export interface TfTensor { shape: number[]; type: TfType; buffer: number; name: string }
export interface TfOp {
  op: string;
  inputs: number[];
  outputs: number[];
  /** the builtin options table that matters for the engine (absent fields = schema defaults) */
  opt: Record<string, number | boolean | number[]>;
}
export interface TfModel {
  tensors: TfTensor[];
  inputs: number[];
  outputs: number[];
  ops: TfOp[];
  /** constant data per buffer index (empty = none) */
  buffers: Uint8Array[];
  /** model metadata entries by name (e.g. 'min_runtime_version', 'TFLITE_METADATA') */
  metadata: Record<string, Uint8Array>;
}

class FB {
  private dv: DataView;
  constructor(public b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8(o: number) { return this.dv.getUint8(o); }
  i8(o: number) { return this.dv.getInt8(o); }
  u16(o: number) { return this.dv.getUint16(o, true); }
  i32(o: number) { return this.dv.getInt32(o, true); }
  u32(o: number) { return this.dv.getUint32(o, true); }
  f32(o: number) { return this.dv.getFloat32(o, true); }
  /** absolute offset of field `i` of the table at `t` (0 = absent) */
  field(t: number, i: number): number {
    const vt = t - this.i32(t);
    const len = this.u16(vt);
    const at = 4 + i * 2;
    if (at >= len) return 0;
    const fo = this.u16(vt + at);
    return fo ? t + fo : 0;
  }
  deref(o: number) { return o + this.u32(o); }
  table(t: number, i: number) { const f = this.field(t, i); return f ? this.deref(f) : 0; }
  vecLen(t: number, i: number) { const f = this.field(t, i); return f ? this.u32(this.deref(f)) : 0; }
  /** absolute offset of a vector's first element */
  vecAt(t: number, i: number) { const f = this.field(t, i); return f ? this.deref(f) + 4 : 0; }
  i32s(t: number, i: number): number[] {
    const n = this.vecLen(t, i), a = this.vecAt(t, i), r: number[] = [];
    for (let k = 0; k < n; k++) r.push(this.i32(a + k * 4));
    return r;
  }
  tables(t: number, i: number): number[] {
    const n = this.vecLen(t, i), a = this.vecAt(t, i), r: number[] = [];
    for (let k = 0; k < n; k++) r.push(this.deref(a + k * 4));
    return r;
  }
  str(t: number, i: number): string {
    const f = this.field(t, i);
    if (!f) return '';
    const s = this.deref(f), n = this.u32(s);
    let out = '';
    for (let k = 0; k < n; k++) out += String.fromCharCode(this.u8(s + 4 + k));
    return out;
  }
  bytes(t: number, i: number): Uint8Array {
    const f = this.field(t, i);
    if (!f) return new Uint8Array(0);
    const s = this.deref(f), n = this.u32(s);
    return this.b.subarray(s + 4, s + 4 + n);
  }
  int(t: number, i: number, d = 0) { const f = this.field(t, i); return f ? this.i32(f) : d; }
  byte(t: number, i: number, d = 0) { const f = this.field(t, i); return f ? this.i8(f) : d; }
  bool(t: number, i: number) { const f = this.field(t, i); return f ? this.u8(f) !== 0 : false; }
  float(t: number, i: number, d = 0) { const f = this.field(t, i); return f ? this.f32(f) : d; }
}

/** The options the engine reads, per operator (schema.fbs BuiltinOptions tables). */
function readOptions(fb: FB, op: string, t: number): TfOp['opt'] {
  if (!t) return {};
  switch (op) {
    case 'CONV_2D':
      return { padding: fb.byte(t, 0), strideW: fb.int(t, 1, 1), strideH: fb.int(t, 2, 1), act: fb.byte(t, 3), dilW: fb.int(t, 4, 1), dilH: fb.int(t, 5, 1) };
    case 'DEPTHWISE_CONV_2D':
      return { padding: fb.byte(t, 0), strideW: fb.int(t, 1, 1), strideH: fb.int(t, 2, 1), mult: fb.int(t, 3, 1), act: fb.byte(t, 4), dilW: fb.int(t, 5, 1), dilH: fb.int(t, 6, 1) };
    case 'MAX_POOL_2D': case 'AVERAGE_POOL_2D':
      return { padding: fb.byte(t, 0), strideW: fb.int(t, 1, 1), strideH: fb.int(t, 2, 1), fw: fb.int(t, 3, 1), fh: fb.int(t, 4, 1), act: fb.byte(t, 5) };
    case 'ADD': case 'MUL': case 'SUB': case 'DIV':
      return { act: fb.byte(t, 0) };
    case 'CONCATENATION':
      return { axis: fb.int(t, 0), act: fb.byte(t, 1) };
    case 'RESHAPE':
      return { newShape: fb.i32s(t, 0) };
    case 'MEAN': case 'SUM':
      return { keepDims: fb.bool(t, 0) };
    case 'STRIDED_SLICE':
      return { beginMask: fb.int(t, 0), endMask: fb.int(t, 1), ellipsisMask: fb.int(t, 2), newAxisMask: fb.int(t, 3), shrinkAxisMask: fb.int(t, 4), offset: fb.bool(t, 5) };
    case 'RESIZE_BILINEAR':
      return { alignCorners: fb.bool(t, 2), halfPixel: fb.bool(t, 3) };
    case 'FULLY_CONNECTED':
      return { act: fb.byte(t, 0), keepNumDims: fb.bool(t, 2) };
    case 'SOFTMAX':
      return { beta: fb.float(t, 0, 1) };
    case 'SQUEEZE':
      return { dims: fb.i32s(t, 0) };
    default:
      return {};
  }
}

export function parseTflite(bytes: Uint8Array): TfModel {
  const fb = new FB(bytes);
  const root = fb.deref(0);
  const codes = fb.tables(root, 1).map((c) => {
    const dep = fb.byte(c, 0), bc = fb.int(c, 3);
    const code = Math.max(dep, bc);
    return OP[code] ?? `#${code}`;
  });
  const sg = fb.tables(root, 2)[0];
  if (!sg) throw new Error('tflite: no subgraph');
  const tensors: TfTensor[] = fb.tables(sg, 0).map((t) => ({
    shape: fb.i32s(t, 0), type: TYPE[fb.byte(t, 1)] ?? 'other', buffer: fb.int(t, 2), name: fb.str(t, 3),
  }));
  const ops: TfOp[] = fb.tables(sg, 3).map((o) => {
    const op = codes[fb.int(o, 0)] ?? '?';
    return { op, inputs: fb.i32s(o, 1), outputs: fb.i32s(o, 2), opt: readOptions(fb, op, fb.table(o, 4)) };
  });
  const buffers = fb.tables(root, 4).map((b) => fb.bytes(b, 0));
  const metadata: Record<string, Uint8Array> = {};
  for (const m of fb.tables(root, 6)) { const name = fb.str(m, 0); metadata[name] = buffers[fb.int(m, 1)] ?? new Uint8Array(0); }
  return { tensors, inputs: fb.i32s(sg, 1), outputs: fb.i32s(sg, 2), ops, buffers, metadata };
}

/** IEEE half -> float. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** A constant tensor's values as float32 (float32 / float16 data), or null when it has no data. */
export function constFloats(m: TfModel, ti: number): Float32Array | null {
  const t = m.tensors[ti];
  const b = m.buffers[t.buffer];
  if (!b || !b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (t.type === 'f32') { const n = b.byteLength >> 2, r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = dv.getFloat32(i * 4, true); return r; }
  if (t.type === 'f16') { const n = b.byteLength >> 1, r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = halfToFloat(dv.getUint16(i * 2, true)); return r; }
  if (t.type === 'i32') { const n = b.byteLength >> 2, r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = dv.getInt32(i * 4, true); return r; }
  return null;
}

/** A constant int32 tensor (shapes, paddings, axes), or null. */
export function constInts(m: TfModel, ti: number): number[] | null {
  const t = m.tensors[ti];
  const b = m.buffers[t.buffer];
  if (!b || !b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (t.type === 'i32') { const r: number[] = []; for (let i = 0; i < b.byteLength >> 2; i++) r.push(dv.getInt32(i * 4, true)); return r; }
  if (t.type === 'i64') { const r: number[] = []; for (let i = 0; i < b.byteLength >> 3; i++) r.push(Number(dv.getBigInt64(i * 8, true))); return r; }
  return null;
}

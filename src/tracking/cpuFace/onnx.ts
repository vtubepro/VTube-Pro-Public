// TFLite -> ONNX, in memory, for the processor-only face tracker. MediaPipe's face models (face_landmarker.task:
// detector, 478-point landmarks, blendshapes; Apache-2.0, shipped with the app) only use builtin TFLite ops, so they
// can run on onnxruntime-web's WebAssembly CPU backend (already shipped for the voice filter), which never touches
// WebGL. The conversion runs once per worker start (a few ms) from the very .task file tasks-vision loads, so both
// paths always run the same weights.
//
// Layout: TFLite is NHWC, ONNX convolutions are NCHW. 4-D activations live in NCHW and are transposed back only where an
// op needs NHWC semantics (reshape, transpose, strided slice, reductions it cannot remap); constants are permuted at
// conversion time. Float16 weights (DEQUANTIZE) are folded to float32.

import { constFloats, constInts, type TfModel, type TfOp } from './tflite.ts';

// ---- a minimal protobuf writer ----
class PB {
  private parts: Uint8Array[] = [];
  private n = 0;
  private push(b: Uint8Array) { this.parts.push(b); this.n += b.length; }
  private varint(v: number | bigint) {
    let x = BigInt.asUintN(64, BigInt(v));
    const out: number[] = [];
    do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; out.push(b); } while (x);
    this.push(new Uint8Array(out));
  }
  private key(field: number, wire: number) { this.varint((field << 3) | wire); }
  int(field: number, v: number | bigint) { this.key(field, 0); this.varint(v); return this; }
  float(field: number, v: number) { this.key(field, 5); const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.push(b); return this; }
  bytes(field: number, b: Uint8Array) { this.key(field, 2); this.varint(b.length); this.push(b); return this; }
  str(field: number, s: string) { return this.bytes(field, new TextEncoder().encode(s)); }
  msg(field: number, m: PB) { return this.bytes(field, m.done()); }
  done(): Uint8Array {
    const out = new Uint8Array(this.n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

type Attr = { name: string; i?: number; f?: number; s?: string; ints?: number[]; floats?: number[] };
interface Node { op: string; inputs: string[]; outputs: string[]; attrs: Attr[] }
interface Init { name: string; dims: number[]; f32?: Float32Array; i64?: number[] }

const FLOAT = 1, INT64 = 7;

function attrPB(a: Attr): PB {
  const p = new PB().str(1, a.name);
  if (a.f !== undefined) p.float(2, a.f).int(20, 1);
  else if (a.i !== undefined) p.int(3, a.i).int(20, 2);
  else if (a.s !== undefined) p.str(4, a.s).int(20, 3);
  else if (a.floats) { for (const v of a.floats) p.float(7, v); p.int(20, 6); }
  else if (a.ints) { for (const v of a.ints) p.int(8, v); p.int(20, 7); }
  return p;
}
function tensorPB(t: Init): PB {
  const p = new PB();
  for (const d of t.dims) p.int(1, d);
  p.int(2, t.f32 ? FLOAT : INT64).str(8, t.name);
  if (t.f32) p.bytes(9, new Uint8Array(t.f32.buffer, t.f32.byteOffset, t.f32.byteLength));
  else { const b = new Uint8Array(t.i64!.length * 8), dv = new DataView(b.buffer); t.i64!.forEach((v, k) => dv.setBigInt64(k * 8, BigInt(v), true)); p.bytes(9, b); }
  return p;
}
function valueInfoPB(name: string, shape: number[]): PB {
  const dims = new PB();
  for (const d of shape) dims.msg(1, new PB().int(1, d));
  const tensorType = new PB().int(1, FLOAT).msg(2, dims);
  return new PB().str(1, name).msg(2, new PB().msg(1, tensorType));
}

export interface OnnxModel {
  bytes: Uint8Array;
  input: { name: string; shape: number[] };
  outputs: { name: string; shape: number[] }[];
}

const TO_NCHW = [0, 3, 1, 2];   // NHWC -> NCHW
const TO_NHWC = [0, 2, 3, 1];   // NCHW -> NHWC
/** an NHWC axis in NCHW */
const AXIS_NCHW = [0, 2, 3, 1];

function permute(data: Float32Array, shape: number[], perm: number[]): Float32Array {
  const r = shape.length, out = new Float32Array(data.length);
  const outShape = perm.map((p) => shape[p]);
  const inStride = new Array(r).fill(1);
  for (let k = r - 2; k >= 0; k--) inStride[k] = inStride[k + 1] * shape[k + 1];
  const idx = new Array(r).fill(0);
  for (let o = 0; o < out.length; o++) {
    let src = 0;
    for (let k = 0; k < r; k++) src += idx[k] * inStride[perm[k]];
    out[o] = data[src];
    for (let k = r - 1; k >= 0; k--) { if (++idx[k] < outShape[k]) break; idx[k] = 0; }
  }
  return out;
}

const pad4 = (shape: number[]) => [...new Array(Math.max(0, 4 - shape.length)).fill(1), ...shape];

/**
 * Convert a TFLite model. `nchwInput`: the (4-D image) input is fed as NCHW float32 ([1, C, H, W]); otherwise inputs keep
 * their TFLite shape. Outputs always keep their TFLite shapes.
 */
export function tfliteToOnnx(m: TfModel, nchwInput = true): OnnxModel {
  const nodes: Node[] = [];
  const inits: Init[] = [];
  const name = new Map<number, string>();
  const layout = new Map<number, 'nchw' | 'nhwc'>();
  const consts = new Map<number, Float32Array>();
  let uid = 0;
  const fresh = (p: string) => `${p}_${uid++}`;
  const shapeOf = (ti: number) => m.tensors[ti].shape;
  const isConst = (ti: number) => consts.has(ti) || (m.buffers[m.tensors[ti].buffer]?.length ?? 0) > 0;
  const cval = (ti: number): Float32Array => {
    let v = consts.get(ti);
    if (!v) { const f = constFloats(m, ti); if (!f) throw new Error(`onnx: tensor ${m.tensors[ti].name} has no data`); v = f; consts.set(ti, v); }
    return v;
  };
  const addInit = (data: Float32Array, dims: number[], p = 'c') => { const n = fresh(p); inits.push({ name: n, dims, f32: data }); return n; };
  const addInts = (vals: number[], p = 'i') => { const n = fresh(p); inits.push({ name: n, dims: [vals.length], i64: vals }); return n; };
  const node = (op: string, inputs: string[], attrs: Attr[] = [], out?: string) => { const o = out ?? fresh(op); nodes.push({ op, inputs, outputs: [o], attrs }); return o; };

  const nchwCache = new Map<number, string>(), nhwcCache = new Map<number, string>();
  /** tensor ti as an NCHW 4-D value (constants permuted, NHWC activations transposed) */
  const asNchw = (ti: number): string => {
    if (isConst(ti)) {
      const s = pad4(shapeOf(ti));
      return addInit(s.length === 4 ? permute(cval(ti), s, TO_NCHW) : cval(ti), TO_NCHW.map((k) => s[k]));
    }
    if (layout.get(ti) === 'nchw') return name.get(ti)!;
    let c = nchwCache.get(ti);
    if (!c) { c = node('Transpose', [name.get(ti)!], [{ name: 'perm', ints: TO_NCHW }]); nchwCache.set(ti, c); }
    return c;
  };
  /** tensor ti in its TFLite (NHWC) layout */
  const asNative = (ti: number): string => {
    if (isConst(ti)) return addInit(cval(ti), shapeOf(ti).length ? shapeOf(ti) : []);
    if (layout.get(ti) !== 'nchw') return name.get(ti)!;
    let c = nhwcCache.get(ti);
    if (!c) { c = node('Transpose', [name.get(ti)!], [{ name: 'perm', ints: TO_NHWC }]); nhwcCache.set(ti, c); }
    return c;
  };
  const set = (ti: number, n: string, l: 'nchw' | 'nhwc') => { name.set(ti, n); layout.set(ti, l); };
  const activation = (v: string, act: number): string => {
    if (!act) return v;
    if (act === 1) return node('Relu', [v]);
    if (act === 2) return node('Clip', [v, addInit(new Float32Array([-1]), []), addInit(new Float32Array([1]), [])]);
    if (act === 3) return node('Clip', [v, addInit(new Float32Array([0]), []), addInit(new Float32Array([6]), [])]);
    if (act === 4) return node('Tanh', [v]);
    throw new Error(`onnx: activation ${act}`);
  };
  const samePads = (inH: number, inW: number, kh: number, kw: number, sh: number, sw: number, dh: number, dw: number) => {
    const one = (n: number, k: number, s: number, d: number) => {
      const out = Math.ceil(n / s), tot = Math.max(0, (out - 1) * s + (k - 1) * d + 1 - n);
      return [Math.floor(tot / 2), tot - Math.floor(tot / 2)];
    };
    const [t, b] = one(inH, kh, sh, dh), [l, r] = one(inW, kw, sw, dw);
    return [t, l, b, r];
  };

  // graph input
  const inTi = m.inputs[0];
  const inShape = shapeOf(inTi);
  const inputName = 'input';
  const image = nchwInput && inShape.length === 4;
  const feedShape = image ? TO_NCHW.map((k) => inShape[k]) : inShape;
  set(inTi, inputName, image ? 'nchw' : 'nhwc');

  const unary: Record<string, string> = { LOGISTIC: 'Sigmoid', RELU: 'Relu', TANH: 'Tanh', NEG: 'Neg', SQRT: 'Sqrt', HARD_SWISH: 'HardSwish' };
  const binary: Record<string, string> = { ADD: 'Add', SUB: 'Sub', MUL: 'Mul', DIV: 'Div', MAXIMUM: 'Max', MINIMUM: 'Min' };

  for (const op of m.ops as TfOp[]) {
    const [a, b, c] = op.inputs;
    const out = op.outputs[0];
    const outShape = shapeOf(out);
    const o = op.opt as Record<string, number & boolean & number[]>;
    switch (op.op) {
      case 'DEQUANTIZE': {
        if (isConst(a)) { consts.set(out, cval(a)); break; }
        set(out, node('Cast', [name.get(a)!], [{ name: 'to', i: FLOAT }]), layout.get(a) ?? 'nhwc');
        break;
      }
      case 'CONV_2D': case 'DEPTHWISE_CONV_2D': {
        const dw = op.op === 'DEPTHWISE_CONV_2D';
        const ws = shapeOf(b), inS = shapeOf(a);
        const kh = ws[1], kw = ws[2];
        // TFLite filter [O, kh, kw, I] (depthwise [1, kh, kw, I*mult]) -> ONNX [O, I/group, kh, kw]
        const wData = dw ? permute(cval(b), ws, [3, 0, 1, 2]) : permute(cval(b), ws, [0, 3, 1, 2]);
        const wDims = dw ? [ws[3], 1, kh, kw] : [ws[0], ws[3], kh, kw];
        const inputs = [asNchw(a), addInit(wData, wDims, 'w')];
        if (c !== undefined && c >= 0) inputs.push(addInit(cval(c), [shapeOf(c)[0]], 'b'));
        const pads = o.padding === 0 ? samePads(inS[1], inS[2], kh, kw, o.strideH, o.strideW, o.dilH, o.dilW) : [0, 0, 0, 0];
        const attrs: Attr[] = [{ name: 'kernel_shape', ints: [kh, kw] }, { name: 'strides', ints: [o.strideH, o.strideW] },
          { name: 'dilations', ints: [o.dilH, o.dilW] }, { name: 'pads', ints: pads }];
        if (dw) attrs.push({ name: 'group', i: inS[3] });
        set(out, activation(node('Conv', inputs, attrs), o.act), 'nchw');
        break;
      }
      case 'MAX_POOL_2D': case 'AVERAGE_POOL_2D': {
        const inS = shapeOf(a);
        const pads = o.padding === 0 ? samePads(inS[1], inS[2], o.fh, o.fw, o.strideH, o.strideW, 1, 1) : [0, 0, 0, 0];
        const attrs: Attr[] = [{ name: 'kernel_shape', ints: [o.fh, o.fw] }, { name: 'strides', ints: [o.strideH, o.strideW] }, { name: 'pads', ints: pads }];
        if (op.op === 'AVERAGE_POOL_2D') attrs.push({ name: 'count_include_pad', i: 0 });
        set(out, activation(node(op.op === 'MAX_POOL_2D' ? 'MaxPool' : 'AveragePool', [asNchw(a)], attrs), o.act), 'nchw');
        break;
      }
      case 'PRELU': {
        if (shapeOf(a).length === 4) {
          const s = pad4(shapeOf(b));
          set(out, node('PRelu', [asNchw(a), addInit(permute(cval(b), s, TO_NCHW), TO_NCHW.map((k) => s[k]), 'slope')]), 'nchw');
        } else set(out, node('PRelu', [asNative(a), asNative(b)]), 'nhwc');
        break;
      }
      case 'RELU6': {
        const nchw = layout.get(a) === 'nchw';
        set(out, activation(nchw ? name.get(a)! : asNative(a), 3), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'RSQRT': {
        const nchw = layout.get(a) === 'nchw';
        set(out, node('Reciprocal', [node('Sqrt', [nchw ? name.get(a)! : asNative(a)])]), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'LOGISTIC': case 'RELU': case 'TANH': case 'NEG': case 'SQRT': case 'HARD_SWISH': {
        const nchw = layout.get(a) === 'nchw';
        set(out, node(unary[op.op], [nchw ? name.get(a)! : asNative(a)]), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MAXIMUM': case 'MINIMUM': case 'SQUARED_DIFFERENCE': {
        const ins = [a, b];
        const acts = ins.filter((t) => !isConst(t));
        const nchw = outShape.length === 4 && acts.length > 0 && acts.every((t) => shapeOf(t).length === 4) && acts.some((t) => layout.get(t) === 'nchw');
        const v = ins.map((t) => (nchw ? asNchw(t) : asNative(t)));
        let r: string;
        if (op.op === 'SQUARED_DIFFERENCE') { const d = node('Sub', v); r = node('Mul', [d, d]); }
        else r = node(binary[op.op], v);
        set(out, activation(r, o.act ?? 0), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'PAD': {
        const p = constInts(m, b)!; // [[before, after] x rank], NHWC order
        const r = shapeOf(a).length;
        const nchw = r === 4 && layout.get(a) === 'nchw';
        const order = nchw ? TO_NCHW : [...Array(r).keys()];
        const pads = [...order.map((k) => p[k * 2]), ...order.map((k) => p[k * 2 + 1])];
        set(out, node('Pad', [nchw ? name.get(a)! : asNative(a), addInts(pads, 'pads')], [{ name: 'mode', s: 'constant' }]), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'CONCATENATION': {
        const r = outShape.length;
        const axis = (o.axis + r) % r;
        const ins = op.inputs;
        const nchw = r === 4 && ins.every((t) => shapeOf(t).length === 4) && ins.some((t) => !isConst(t) && layout.get(t) === 'nchw');
        set(out, activation(node('Concat', ins.map((t) => (nchw ? asNchw(t) : asNative(t))), [{ name: 'axis', i: nchw ? AXIS_NCHW[axis] : axis }]), o.act ?? 0), nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'RESHAPE': {
        set(out, node('Reshape', [asNative(a), addInts(outShape, 'shape')]), 'nhwc');
        break;
      }
      case 'SQUEEZE': {
        set(out, node('Reshape', [asNative(a), addInts(outShape, 'shape')]), 'nhwc');
        break;
      }
      case 'TRANSPOSE': {
        const perm = constInts(m, b)!;
        // (an NCHW input: one transpose with the composed permutation)
        if (layout.get(a) === 'nchw' && perm.length === 4) set(out, node('Transpose', [name.get(a)!], [{ name: 'perm', ints: perm.map((k) => TO_NHWC[k]) }]), 'nhwc');
        else set(out, node('Transpose', [asNative(a)], [{ name: 'perm', ints: perm }]), 'nhwc');
        break;
      }
      case 'MEAN': case 'SUM': {
        const r = shapeOf(a).length;
        const axes = (constInts(m, b) ?? []).map((x) => (x + r) % r);
        const keep = !!o.keepDims;
        const nchw = r === 4 && keep && layout.get(a) === 'nchw';
        const ax = nchw ? axes.map((x) => AXIS_NCHW[x]) : axes;
        const src = nchw ? name.get(a)! : asNative(a);
        const red = op.op === 'MEAN'
          ? node('ReduceMean', [src], [{ name: 'axes', ints: ax }, { name: 'keepdims', i: keep ? 1 : 0 }])
          : node('ReduceSum', [src, addInts(ax, 'axes')], [{ name: 'keepdims', i: keep ? 1 : 0 }]);
        set(out, red, nchw ? 'nchw' : 'nhwc');
        break;
      }
      case 'STRIDED_SLICE': {
        const begin = constInts(m, b)!, end = constInts(m, c)!, strides = constInts(m, op.inputs[3])!;
        if (o.ellipsisMask || o.newAxisMask || o.offset) throw new Error('onnx: strided slice mask not supported');
        const r = begin.length, BIG = 2 ** 31 - 1;
        const starts: number[] = [], ends: number[] = [], axes: number[] = [], steps: number[] = [];
        for (let k = 0; k < r; k++) {
          const st = strides[k] || 1;
          starts.push(o.beginMask & (1 << k) ? (st > 0 ? 0 : BIG) : begin[k]);
          ends.push(o.shrinkAxisMask & (1 << k) ? begin[k] + 1 : o.endMask & (1 << k) ? (st > 0 ? BIG : -BIG) : end[k]);
          axes.push(k); steps.push(st);
        }
        let v = node('Slice', [asNative(a), addInts(starts), addInts(ends), addInts(axes), addInts(steps)]);
        if (o.shrinkAxisMask) v = node('Reshape', [v, addInts(outShape, 'shape')]);
        set(out, v, 'nhwc');
        break;
      }
      case 'FULLY_CONNECTED': {
        const ws = shapeOf(b); // [N, K]
        let x = asNative(a);
        if (shapeOf(a).length !== 2) x = node('Reshape', [x, addInts([-1, ws[1]], 'shape')]);
        const inputs = [x, addInit(cval(b), ws, 'w')];
        if (c !== undefined && c >= 0) inputs.push(addInit(cval(c), [ws[0]], 'b'));
        let v = activation(node('Gemm', inputs, [{ name: 'transB', i: 1 }]), o.act ?? 0);
        if (outShape.length !== 2) v = node('Reshape', [v, addInts(outShape, 'shape')]);
        set(out, v, 'nhwc');
        break;
      }
      case 'RESIZE_BILINEAR': {
        const sz = constInts(m, b)!;
        const n = shapeOf(a);
        const mode = o.alignCorners ? 'align_corners' : o.halfPixel ? 'half_pixel' : 'asymmetric';
        set(out, node('Resize', [asNchw(a), '', '', addInts([n[0], n[3], sz[0], sz[1]], 'sizes')], [{ name: 'mode', s: 'linear' }, { name: 'coordinate_transformation_mode', s: mode }]), 'nchw');
        break;
      }
      case 'SOFTMAX': {
        set(out, node('Softmax', [asNative(a)], [{ name: 'axis', i: -1 }]), 'nhwc');
        break;
      }
      default:
        throw new Error(`onnx: TFLite op ${op.op} is not supported`);
    }
  }

  const outputs = m.outputs.map((ti, k) => {
    const n = `out${k}`;
    node('Identity', [asNative(ti)], [], n);
    return { name: n, shape: shapeOf(ti) };
  });

  const g = new PB();
  for (const nd of nodes) {
    const p = new PB();
    for (const i of nd.inputs) p.str(1, i);
    for (const ou of nd.outputs) p.str(2, ou);
    p.str(4, nd.op);
    for (const at of nd.attrs) p.msg(5, attrPB(at));
    g.msg(1, p);
  }
  g.str(2, 'cpuface');
  for (const t of inits) g.msg(5, tensorPB(t));
  g.msg(11, valueInfoPB(inputName, feedShape));
  for (const ou of outputs) g.msg(12, valueInfoPB(ou.name, ou.shape));
  const model = new PB().int(1, 8).str(2, 'vtp-cpuface').msg(7, g).msg(8, new PB().str(1, '').int(2, 13));
  return { bytes: model.done(), input: { name: inputName, shape: feedShape }, outputs };
}

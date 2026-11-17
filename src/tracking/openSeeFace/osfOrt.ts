// OpenSeeFace's two ONNX models on onnxruntime-web (the copy the app already ships for the voice filter): WebAssembly CPU backend,
// no WebGL, no WebGPU, no Python. `ort` is passed in (the worker imports it from public/vendor/voice; the tests from node_modules).
import type * as OrtNS from 'onnxruntime-web';
import { OSF_RES, type OsfModels } from './osfCore.ts';

const SHAPE = [1, 3, OSF_RES, OSF_RES];

export async function createOsfModels(ort: typeof OrtNS, detector: Uint8Array, landmarks: Uint8Array): Promise<OsfModels & { close(): Promise<void> }> {
  const opts = { executionProviders: ['wasm'] as string[], graphOptimizationLevel: 'all' as const };
  const [d, l] = await Promise.all([ort.InferenceSession.create(detector, opts), ort.InferenceSession.create(landmarks, opts)]);
  const run = async (s: OrtNS.InferenceSession, input: Float32Array) => {
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, SHAPE) });
    return s.outputNames.map((n) => r[n].data as Float32Array);
  };
  return {
    async detect(input) {
      const o = await run(d, input);
      if (o.length < 2) throw new Error('the face detector should give two outputs (scores and their max-pool)');
      return [o[0], o[1]];
    },
    async landmarks(input) { return (await run(l, input))[0]; },
    async close() { await Promise.allSettled([d.release(), l.release()]); },
  };
}

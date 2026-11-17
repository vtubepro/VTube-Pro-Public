// Silero VAD v5 (MIT, snakers4/silero-vad) streaming wrapper over onnxruntime-web — no DOM, so the same code runs
// in the voice worker and in the offline harness (tools/eval_voice.ts).
//
// Input: 512-sample windows @ 16 kHz (32 ms) with 64 samples of context from the previous window of the same
// stream. With an overlapping hop (e.g. 256 = a result every 16 ms) the windows are split round-robin over
// independent model states, so each state still sees contiguous audio.
import type * as OrtNS from 'onnxruntime-web';

type Ort = typeof OrtNS;
const CTX = 64;

export class SileroStreams {
  private states: OrtNS.Tensor[] = [];
  private ctx: Float32Array[] = [];
  private sr: OrtNS.Tensor;
  /** Mean inference time (ms) — reported to the UI. */
  ms = 0;

  private constructor(private ort: Ort, private session: OrtNS.InferenceSession, streams: number) {
    this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    for (let i = 0; i < streams; i++) { this.states.push(this.zero()); this.ctx.push(new Float32Array(CTX)); }
  }

  static async create(ort: Ort, model: ArrayBuffer | Uint8Array, streams = 1) {
    const session = await ort.InferenceSession.create(model instanceof Uint8Array ? model : new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return new SileroStreams(ort, session, Math.max(1, streams));
  }

  private zero() { return new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]); }

  reset() { for (let i = 0; i < this.states.length; i++) { this.states[i] = this.zero(); this.ctx[i].fill(0); } }

  /** Voice probability (0..1) for one 512-sample window; `seq` picks the stream (seq % streams). */
  async process(x: Float32Array, seq: number): Promise<number> {
    const k = seq % this.states.length;
    const t0 = performance.now();
    const b = new Float32Array(CTX + x.length);
    b.set(this.ctx[k], 0); b.set(x, CTX);
    this.ctx[k].set(x.subarray(x.length - CTX));
    const out = await this.session.run({ input: new this.ort.Tensor('float32', b, [1, b.length]), state: this.states[k], sr: this.sr });
    this.states[k] = out.stateN as OrtNS.Tensor;
    this.ms += (performance.now() - t0 - this.ms) * 0.05;
    return (out.output.data as Float32Array)[0];
  }
}

// The optional beat finder model: Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024; CPJKU/beat_this — MIT code AND
// weights) as ONNX, the int8 build published by CattyCathy/beat-this-onnx (MIT; pinned release + SHA-256 below).
// It is NOT shipped: the user fetches it with one click (21 MB) into the helper's data folder, and it is checked
// byte-for-byte against the pinned checksum before it is ever loaded. Runs with onnxruntime-web's WASM backend (MIT,
// already a VTube Pro dependency) in the analysis worker, its runtime files pinned to the installed package (pinOrtLocal:
// nothing is fetched at run time). The one download is the model itself, only when the user clicks "Get it" (users fetch
// their own optional parts). The front end (log-mel) and post-processing are ours
// (shared/trackDsp.ts beatThisMel / beatThisPeaks / fitGrid). Licence note for the panel: the authors say some of the
// training audio was copyrighted or under limited licences; the weights themselves are MIT.
// Without the model our own DSP beat tracking runs (and the DJ app's grid always wins anyway).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BT, beatThisChunks, beatThisMel, beatThisPeaks } from '../../../shared/trackDsp.ts';

export const BEAT_THIS_MODEL = {
  name: 'Beat This! (final0, int8)',
  version: 'beat-this-onnx v0.0.1',
  file: 'beat-this-final0-int8.onnx',
  url: 'https://github.com/CattyCathy/beat-this-onnx/releases/download/v0.0.1/beat-this-final0-int8.onnx',
  sha256: '58601cfb4517f6765929b7c169e9bc2ade3a2c64498ab9d64a9bf0d01618f936',
  bytes: 21955054,
  licence: 'MIT (code and weights), © 2024 Institute of Computational Perception, JKU Linz',
} as const;

export function modelPath(dataDir: string) { return path.join(dataDir, 'models', 'beat_this', BEAT_THIS_MODEL.file); }
export type ModelState = 'missing' | 'ready' | 'downloading' | 'bad';
/** Is the model there and intact? (size check is instant; the hash is checked once per helper run) */
const verified = new Map<string, boolean>();
export function modelState(dataDir: string, spec: { sha256: string; bytes: number } = BEAT_THIS_MODEL): ModelState {
  const p = modelPath(dataDir);
  let st: fs.Stats; try { st = fs.statSync(p); } catch { return 'missing'; }
  if (st.size !== spec.bytes) return 'bad';
  const key = `${p}:${st.mtimeMs}`;
  if (!verified.has(key)) verified.set(key, sha256File(p) === spec.sha256);
  return verified.get(key) ? 'ready' : 'bad';
}
function sha256File(p: string): string { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/** The user pressed "Get it": download to a temp name, check size + SHA-256, then move into place. */
export async function downloadModel(dataDir: string, o: { url?: string; sha256?: string; bytes?: number; fetch?: typeof fetch; progress?: (got: number, total: number) => void } = {}): Promise<{ ok: boolean; says: string }> {
  const url = o.url ?? BEAT_THIS_MODEL.url, sha = o.sha256 ?? BEAT_THIS_MODEL.sha256, bytes = o.bytes ?? BEAT_THIS_MODEL.bytes;
  const dst = modelPath(dataDir), tmp = `${dst}.part`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const f = o.fetch ?? fetch;
  let r: Response;
  try { r = await f(url, { redirect: 'follow' }); } catch (e) { return { ok: false, says: `Couldn’t reach the download (${(e as Error).message}). Check your internet and try again.` }; }
  if (!r.ok || !r.body) return { ok: false, says: `The download answered ${r.status}. Try again later.` };
  const h = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > bytes + 1024) throw new Error('the file is bigger than expected');
      h.update(value);
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      o.progress?.(got, bytes);
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  } catch (e) {
    out.destroy(); try { fs.unlinkSync(tmp); } catch { /* none */ }
    return { ok: false, says: `The download stopped (${(e as Error).message}). Try again.` };
  }
  const digest = h.digest('hex');
  if (got !== bytes || digest !== sha) { try { fs.unlinkSync(tmp); } catch { /* none */ } return { ok: false, says: 'The downloaded file isn’t the one we expect (its checksum differs), so it wasn’t kept.' }; }
  fs.renameSync(tmp, dst);
  return { ok: true, says: 'The better beat finder is ready. New tracks use it from now on.' };
}

/** A loaded model: spectrogram chunk → beat / downbeat logits. (Injectable for tests: no model on the build PC.) */
export interface BeatModel { run(chunk: Float32Array, frames: number): Promise<{ beat: Float32Array; downbeat: Float32Array }> }
/** onnxruntime-web's own runtime files from the installed package (never fetched from anywhere at run time). */
export function ortLocalFiles(resolve: (id: string) => string = createRequire(import.meta.url).resolve): { mjs: string; wasm: string } {
  const dist = path.dirname(resolve('onnxruntime-web'));
  return { mjs: path.join(dist, 'ort-wasm-simd-threaded.mjs'), wasm: path.join(dist, 'ort-wasm-simd-threaded.wasm') };
}
/** Point onnxruntime at those local files: the .mjs by file URL, the .wasm handed over as bytes (no fetch, no CDN). */
export function pinOrtLocal(env: { wasm: { numThreads?: number; wasmPaths?: unknown; wasmBinary?: unknown } }, files = ortLocalFiles()) {
  env.wasm.numThreads = 1;                      // (VTube Pro stays light: one thread, low priority worker)
  env.wasm.wasmPaths = { mjs: pathToFileURL(files.mjs).href, wasm: pathToFileURL(files.wasm).href };
  env.wasm.wasmBinary = new Uint8Array(fs.readFileSync(files.wasm));
}
let session: Promise<BeatModel> | null = null;
export function loadModel(file: string): Promise<BeatModel> {
  session ??= (async () => {
    const ort = await import('onnxruntime-web');
    pinOrtLocal(ort.env as Parameters<typeof pinOrtLocal>[0]);
    const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(file)), { executionProviders: ['wasm'] });
    return {
      async run(chunk: Float32Array, frames: number) {
        const out = await s.run({ spectrogram: new ort.Tensor('float32', chunk, [1, frames, BT.mels]) });
        return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array };
      },
    };
  })();
  session.catch(() => { session = null; });
  return session;
}
/** Mono 22 050 Hz PCM → beat and downbeat times (ms). */
export async function beatThis(pcm22050: Float32Array, model: BeatModel): Promise<{ beats: number[]; downbeats: number[] }> {
  const spec = beatThisMel(pcm22050);
  const { beat, downbeat } = await beatThisChunks(spec, (c, n) => model.run(c, n));
  return beatThisPeaks(beat, downbeat);
}

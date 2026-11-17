// The texture tier builder's process (server/gpuTiers.ts starts it at below-normal priority, never on the helper's event
// loop): reads a .vtp2, builds its tier cache (shared/rig2d/gpu/tiers.ts) into <out>/<key>/, encoding pages on worker
// threads (the Basis WASM encoder, single-threaded each: no COOP/COEP, no native binary). Prints one JSON line per
// progress step and a last {done|error} line.
//   node --import tsx server/gpuTiersChild.ts <model.vtp2> <outDir> [--threads N] [--tiers 0,1,2] [--key-only]
//   (release: <node> dist-helper/gpu_tiers.mjs …)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readVtp2 } from '../shared/rig2d/container.ts';
import { buildTiers } from '../shared/rig2d/gpu/tiers.ts';
import { cacheKey, tiersFor } from '../shared/rig2d/gpu/cache.ts';
import { buildPlan } from './gpuBudget.ts';
import { decodePng, pngInfo, pngRawSize, readPngRows } from '../shared/rig2d/gpu/png.ts';
import { RowShrinker, mipChain, premultiply, type Img } from '../shared/rig2d/gpu/image.ts';
import { BASIS_MODULE_OPTS, assemblePage, encodeStrip, planPage, type BasisModule } from '../shared/rig2d/gpu/basis.ts';

const SELF = fileURLToPath(import.meta.url);
/** Encoder threads by default: a third of the cores, 1..8 (the live studio keeps the rest). */
export const defaultThreads = () => Math.min(8, Math.max(1, Math.floor(os.cpus().length / 3)));
/** The vendored Basis build: public/vendor/basis (source tree) or dist/vendor/basis (a release's built pages). */
export function basisDir(from = path.dirname(SELF)): string {
  const root = path.resolve(from, '..');
  for (const d of [path.join(root, 'public', 'vendor', 'basis'), path.join(root, 'dist', 'vendor', 'basis')]) if (fs.existsSync(path.join(d, 'basis_encoder.wasm'))) return d;
  throw new Error('the texture encoder files are missing (public/vendor/basis)');
}
export async function loadEncoder(dir = basisDir()): Promise<BasisModule> {
  const req = createRequire(import.meta.url);
  const factory = req(path.join(dir, 'basis_encoder.js')) as (o: object) => Promise<BasisModule>;
  const M = await factory({ wasmBinary: fs.readFileSync(path.join(dir, 'basis_encoder.wasm')), ...BASIS_MODULE_OPTS });
  M.initializeBasis();
  return M;
}

/** A pool of encoder threads (default: a third of the cores, 1..8: the live studio keeps the rest). A page is split
 *  into strips (shared/rig2d/gpu/basis.ts planPage) so every thread helps even on a one-page model. */
export class EncoderPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { msg: { id: number; w: number; h: number; data: Uint8Array }; resolve: (b: Uint8Array) => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; w: Worker }>();
  private seq = 0;
  encodeMs = 0;
  constructor(n = defaultThreads()) {
    const dir = basisDir();
    for (let i = 0; i < n; i++) {
      const w = new Worker(SELF, { workerData: { basisDir: dir } });
      w.on('message', (r: { id: number; ktx?: Uint8Array; error?: string; ms?: number }) => {
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        this.encodeMs += r.ms ?? 0;
        if (r.ktx) p.resolve(r.ktx); else p.reject(new Error(r.error ?? 'encoder failed'));
        this.idle.push(w); this.pump();
      });
      w.on('error', (e: Error) => { for (const [id, p] of this.pending) if (p.w === w) { this.pending.delete(id); p.reject(e); } });
      this.workers.push(w); this.idle.push(w);
    }
  }
  get size() { return this.workers.length; }
  private strip(w: number, h: number, data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => { this.queue.push({ msg: { id: ++this.seq, w, h, data }, resolve, reject }); this.pump(); });
  }
  /** A page's mip chain (premultiplied, level 0 first) → its KTX2. */
  async encode(mips: Img[]): Promise<Uint8Array> {
    const jobs = planPage(mips);
    const res = await Promise.all(jobs.map((j) => this.strip(j.w, j.h, j.px.slice())));
    return assemblePage(mips, jobs, res);
  }
  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!, j = this.queue.shift()!;
      this.pending.set(j.msg.id, { resolve: j.resolve, reject: j.reject, w });
      w.postMessage(j.msg, [j.msg.data.buffer as ArrayBuffer]);
    }
  }
  async close() { await Promise.all(this.workers.map((w) => w.terminate())); }
}

async function main() {
  const [, , src, out, ...rest] = process.argv;
  const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
  // (below-normal priority however it was started: the live studio always comes first)
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: fine */ }
  let pool: EncoderPool | null = null;
  try {
    const bytes = new Uint8Array(fs.readFileSync(src));
    const r = await readVtp2(bytes, inflateRawCapped);
    if (!r.ok) throw new Error(r.error);
    const { doc, buffers, files } = r.pkg;
    const key = cacheKey(doc, buffers, files);
    if (rest.includes('--key-only')) { say({ key }); return; }
    const dir = path.join(out, key);
    fs.mkdirSync(dir, { recursive: true });
    const ks = opt('--tiers')?.split(',').map(Number).filter((x) => Number.isInteger(x) && x >= 0);
    // what fits this computer's free memory right now (server/gpuBudget.ts): the tiers, the encoder threads and the
    // pages in flight; tiers that don't fit are left out (the model uses the best one that does, and says so)
    // (an interlaced PNG is read whole at full size: the plan counts that: server/gpuBudget.ts)
    const texs = doc.textures.map((t) => { const b = files.get(t.file); let interlaced = false; try { interlaced = !!b && b[0] === 0x89 && pngInfo(b).interlace === 1; } catch { /* the build says what is wrong */ } return { width: t.width, height: t.height, interlaced }; });
    const plan = buildPlan(texs, ks?.length ? ks : tiersFor(doc), { free: os.freemem(), threads: opt('--threads') ? Math.max(1, Number(opt('--threads'))) : defaultThreads() });
    if (plan.refuse) throw new Error(plan.refuse);
    pool = new EncoderPool(plan.threads);
    say({ key, threads: pool.size, tiers: plan.tiers, skipped: plan.skipped, inflight: plan.inflight, peakMB: Math.round(plan.peak / 1048576), freeMB: Math.round(os.freemem() / 1048576) });
    const t0 = performance.now();
    const man = await buildTiers(doc, buffers, files, key, {
      decode: async (file, b, k0) => decodeShrunk(file, b, k0),
      encode: (mips) => pool!.encode(mips),
      write: async (rel, b) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.part`, b); fs.renameSync(`${f}.part`, f); },
      inflight: plan.inflight,
      progress: (d, t) => say({ progress: d, of: t }),
      ...(plan.note ? { notes: { skipped: plan.skipped, note: plan.note } } : {}),
    }, plan.tiers);
    say({ done: true, key, seconds: (performance.now() - t0) / 1000, encodeThreadSeconds: pool.encodeMs / 1000, tiers: man.tiers.map((t) => ({ k: t.k, pages: t.pages.length, bytes: t.pages.reduce((s, p) => s + p.bytes, 0) })) });
  } catch (e) {
    say({ error: (e as Error).message });
    process.exitCode = 1;
  } finally { await pool?.close(); }
}

/** A .vtp2 entry's raw-deflate data, inflated to at most the size its zip entry declares (a lying entry is refused,
 *  never unpacked past it: shared/rig2d/container.ts zipRead then checks the exact size and the CRC). */
export async function inflateRawCapped(d: Uint8Array, expected: number): Promise<Uint8Array> {
  try { return new Uint8Array(zlib.inflateRawSync(d, { maxOutputLength: Math.max(1, expected) })); }
  catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new Error('a file inside this model unpacks to more than it says: the model file is damaged');
    throw e;
  }
}

/** Node's whole-buffer inflate (~3× fflate), stopped at the size the PNG header promises; only for image data up to
 *  this size: bigger pictures stream through fflate in small steps, so their unpacked data is never all in memory. */
const FAST_INFLATE_MAX = 256 << 20;
const nodeInflate = (z: Uint8Array, max: number) => new Uint8Array(zlib.inflateSync(z, { maxOutputLength: Math.max(1, max) }));

/** PNG → premultiplied RGBA8 at tier k0 (k0 = 0: the whole picture; else area-shrunk while the rows stream in, never
 *  holding the full picture). */
export function decodeShrunk(file: string, bytes: Uint8Array, k0: number): Img {
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) throw new Error(`${path.basename(file)} is not a PNG picture: its compressed versions are made in the studio instead`);
  const info = pngInfo(bytes);
  const inflate = pngRawSize(info) <= FAST_INFLATE_MAX ? nodeInflate : undefined;
  if (k0 === 0) { const d = decodePng(bytes, inflate); premultiply(d.data); return d; }
  const sh = new RowShrinker(info.w, info.h, k0);
  readPngRows(bytes, (y, row) => sh.push(y, row), inflate);
  return sh.out;
}

// (last: everything above is defined before a thread or the process starts working)
if (!isMainThread) {
  // ---- an encoder thread: a strip in, its KTX2 out
  const M = await loadEncoder(workerData.basisDir);
  parentPort!.on('message', (m: { id: number; w: number; h: number; data: Uint8Array }) => {
    try {
      const t = performance.now();
      const ktx = encodeStrip(M, m.data, m.w, m.h);
      parentPort!.postMessage({ id: m.id, ktx, ms: performance.now() - t }, [ktx.buffer as ArrayBuffer]);
    } catch (e) { parentPort!.postMessage({ id: m.id, error: (e as Error).message }); }
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  await main();
}

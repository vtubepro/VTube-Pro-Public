// The texture worker of 2D models (HQ decision #10), with the vendored Basis Universal build (public/vendor/basis/,
// Apache-2.0), loaded by src/avatar/flat/rig2d/gpuTextures.ts:
//   * 'transcode': a KTX2 page (UASTC + zstd) → this GPU's format, off the main thread (the small transcoder build);
//   * 'build': a page without VTube Pro's server makes the model's ≤ 4096 tiers here (the encoder build, single-threaded:
//     tierBuildWeb.ts).
// The Basis builds are classic scripts: each is evaluated here as a CommonJS module.
import { BASIS_MODULE_OPTS, transcodePage, type BasisModule, type GpuTarget } from '../../../../shared/rig2d/gpu/basis.ts';
import { buildTiersWeb } from './tierBuildWeb.ts';

const mods = new Map<string, Promise<BasisModule>>();
async function load(base: string, name: 'basis_transcoder' | 'basis_encoder'): Promise<BasisModule> {
  const [js, wasm] = await Promise.all([
    fetch(`${base}${name}.js`).then((r) => { if (!r.ok) throw new Error(`texture codec: ${r.status}`); return r.text(); }),
    fetch(`${base}${name}.wasm`).then((r) => { if (!r.ok) throw new Error(`texture codec: ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const m = { exports: {} as unknown };
  new Function('module', 'exports', js)(m, m.exports);
  const factory = m.exports as (o: object) => Promise<BasisModule>;
  const M = await factory({ wasmBinary: new Uint8Array(wasm), ...BASIS_MODULE_OPTS });
  M.initializeBasis();
  return M;
}
const mod = (base: string, name: 'basis_transcoder' | 'basis_encoder') => {
  let p = mods.get(name);
  if (!p) { p = load(base, name); mods.set(name, p); p.catch(() => mods.delete(name)); }
  return p;
};

type Req = { id: number; base: string } & ({ t?: 'transcode'; ktx2: Uint8Array; target: GpuTarget } | { t: 'build'; model: Uint8Array; key: string } | { t: 'ack'; n: number; error?: string });
const post = (m: unknown, tr: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(m, tr);
// a build's files go to the page one at a time (it stores them: tierStore.ts) and wait for its answer
const acks = new Map<number, { ok: () => void; no: (e: Error) => void }>();
let ackSeq = 0;
self.onmessage = async (e: MessageEvent<Req>) => {
  const q = e.data;
  if (q.t === 'ack') { const a = acks.get(q.n); acks.delete(q.n); if (q.error) a?.no(new Error(q.error)); else a?.ok(); return; }
  try {
    if (q.t === 'build') {
      const M = await mod(q.base, 'basis_encoder');
      const write = (rel: string, bytes: Uint8Array) => new Promise<void>((ok, no) => { const n = ++ackSeq; acks.set(n, { ok, no }); post({ id: q.id, write: { n, rel, bytes } }, [bytes.buffer as ArrayBuffer]); });
      const r = await buildTiersWeb(M, q.model, q.key, (done, of) => post({ id: q.id, progress: [done, of] }), write);
      post({ id: q.id, built: r });
      return;
    }
    const M = await mod(q.base, 'basis_transcoder');
    const t = performance.now();
    const r = transcodePage(M, q.ktx2, q.target);
    post({ id: q.id, ...r, ms: performance.now() - t }, r.levels.map((l) => l.buffer as ArrayBuffer));
  } catch (err) {
    post({ id: q.id, error: (err as Error).message });
  }
};

// Open an AES-256-GCM blob with the pure-JS fallback (shared/aesGcm.ts) WITHOUT freezing the page: big blobs go to a
// module Worker (src/net/aesOpenWorker.ts). Used only on a stream PC's OBS page (no WebCrypto there, src/net/custody.ts).
// Custody: the caller keeps zeroing its own key copy; the ciphertext is handed over (detached here, zeroed in the worker);
// the plaintext comes back as the only copy. Small blobs, a missing Worker, or a worker that does not come up in time
// are opened inline, exactly as before.
import { aesGcmOpen } from '../../shared/aesGcm.ts';
import type { AesOpenReply, AesOpenReq } from './aesOpenWorker.ts';

/** The slice of the Worker API used here (a test passes a MessagePort-backed one). */
export interface AesWorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}
export interface OffThreadOpts {
  /** Blobs smaller than this open inline (a worker start costs more than they do). */
  inlineBelow?: number;
  /** ms to wait for the worker to say it is up before opening inline. */
  readyMs?: number;
  makeWorker?: () => AesWorkerLike | null;
}
const defaultMake = (): AesWorkerLike | null => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./aesOpenWorker.ts', import.meta.url), { type: 'module', name: 'vtp-aesopen' }) as unknown as AesWorkerLike;
};

/** `sealed` = iv(12) || ciphertext+tag. When opened off-thread the sealed buffer is DETACHED (the caller must not reuse it).
 *  `via` (optional) reports which path ran, for tests. */
export async function aesOpenOffThread(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array, opts: OffThreadOpts = {}, via?: (p: 'inline' | 'worker') => void): Promise<Uint8Array> {
  const inline = () => { via?.('inline'); return aesGcmOpen(key, sealed.subarray(0, 12), sealed.subarray(12), aad); };
  if (sealed.length < (opts.inlineBelow ?? 256 * 1024)) return inline();
  let w: AesWorkerLike | null = null;
  try { w = (opts.makeWorker ?? defaultMake)(); } catch { w = null; }
  if (!w) return inline();
  const worker = w;
  const done = (): void => { worker.onmessage = null; worker.onerror = null; try { worker.terminate(); } catch { /* gone */ } };
  // 1) wait until the worker is up, BEFORE the ciphertext is handed over, so a worker that never starts costs nothing
  const up = await new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), opts.readyMs ?? 4000);
    worker.onmessage = (ev) => { if ((ev.data as AesOpenReply)?.t === 'ready') { clearTimeout(timer); res(true); } };
    worker.onerror = () => { clearTimeout(timer); res(false); };
  });
  if (!up) { done(); return inline(); }
  // 2) hand over: key as a copy, ciphertext transferred (an exact-size buffer, else copy it so nothing else is detached)
  via?.('worker');
  const own = sealed.byteOffset === 0 && sealed.byteLength === sealed.buffer.byteLength ? sealed : sealed.slice();
  if (own !== sealed) sealed.fill(0);
  const keyCopy = key.slice();
  try {
    return await new Promise<Uint8Array>((res, rej) => {
      worker.onmessage = (ev) => {
        const r = ev.data as AesOpenReply;
        if (r?.t === 'ok') res(r.pt);
        else if (r?.t === 'err') rej(new Error(r.msg));
      };
      worker.onerror = () => rej(new Error('The sealed data could not be opened (worker failed)'));
      const req: AesOpenReq = { t: 'open', key: keyCopy, sealed: own, aad };
      worker.postMessage(req, [own.buffer as ArrayBuffer]);
    });
  } finally {
    keyCopy.fill(0); // (a no-op once structured clone has copied it; covers a failed post)
    done();
  }
}

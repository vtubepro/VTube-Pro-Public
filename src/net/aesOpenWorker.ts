// Module Worker for the stream-PC AES-GCM fallback (shared/aesGcm.ts). Opening a big guest model in pure JS blocks
// whatever thread runs it, so the OBS page hands it to this worker (src/net/aesOpenOffThread.ts).
// Custody (docs/MULTIPLAYER_DISCORD.md): the key arrives as a COPY and is zeroed here when done, the ciphertext arrives
// TRANSFERRED (the page keeps no copy) and is zeroed here, the plaintext goes back TRANSFERRED (nothing stays here), and
// aesGcmOpen checks the tag before it produces any output, so a bad blob never releases bytes.
import { aesGcmOpen } from '../../shared/aesGcm.ts';

export interface AesOpenReq { t: 'open'; key: Uint8Array; sealed: Uint8Array; aad: Uint8Array }
export type AesOpenReply = { t: 'ready' } | { t: 'ok'; pt: Uint8Array } | { t: 'err'; msg: string };

/** Pure handler: iv(12) || ciphertext+tag in, plaintext out. Zeroes the key and the ciphertext whatever happens. */
export function handleAesOpen(req: AesOpenReq): { reply: AesOpenReply; transfer: ArrayBuffer[] } {
  try {
    const pt = aesGcmOpen(req.key, req.sealed.subarray(0, 12), req.sealed.subarray(12), req.aad);
    return { reply: { t: 'ok', pt }, transfer: [pt.buffer as ArrayBuffer] };
  } catch (e) {
    return { reply: { t: 'err', msg: String((e as Error)?.message ?? e) }, transfer: [] };
  } finally {
    req.key.fill(0);
    req.sealed.fill(0);
  }
}

/** Wire a worker scope (or a test port) to the handler. */
export function serveAesOpen(scope: { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((ev: { data: unknown }) => void) | null }) {
  scope.onmessage = (ev) => {
    const req = ev.data as AesOpenReq;
    if (!req || req.t !== 'open') return;
    const { reply, transfer } = handleAesOpen(req);
    scope.postMessage(reply, transfer);
  };
  scope.postMessage({ t: 'ready' } satisfies AesOpenReply);
}

// Start serving only when this file really is the worker entry (not when a test or the page imports it).
const gscope = globalThis as unknown as { WorkerGlobalScope?: new () => unknown; postMessage?: unknown };
if (typeof gscope.WorkerGlobalScope === 'function' && globalThis instanceof gscope.WorkerGlobalScope) {
  serveAesOpen(globalThis as unknown as Parameters<typeof serveAesOpen>[0]);
}

// The browser-only 2D import (no server): run the server's own import (shared/mobile/flatPlan.ts) in a worker
// (src/mobile/flatImport.worker.ts), or on the page when this browser can't start module workers. Used by
// (no caller of importFlatFiles remains in this build; RAR_ON_PHONE is still read by src/ui/dropImport.ts).
// Memory on a phone: the picked Files are never read whole (the worker reads slices), each output file is stored before
// the next is sent, and phones get a smaller unpacked budget (PHONE_IMPORT_MB) with one sentence.
import type { WebFlatResult } from '../../shared/mobile/flatPlan.ts';
import { isPhone } from './device.ts';

export class WebFlatError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

/** The most a 2D model may unpack to on a phone (a desktop: the helper's 300 MB). */
export const PHONE_IMPORT_MB = 120;
/** tests: localStorage vtp.test.importCapMB lowers it */
export function importBudget(): number | undefined {
  let t = 0; try { t = Number(localStorage.getItem('vtp.test.importCapMB')) || 0; } catch { /* storage off */ }
  if (t > 0) return t << 20;
  return isPhone() ? PHONE_IMPORT_MB << 20 : undefined;
}

export const RAR_ON_PHONE = 'Phones can’t open .rar or .7z files. Ask the artist or shop for a .zip, or unpack it with an unzip app and choose all the files inside.';
/** Phone words for the sentences the helper writes for a PC (right-click, Windows, 7-Zip, drop the folder …). Pure
 *  apart from isPhone (tools/mobile2d_unit.ts checks every sentence of shared/flatUnzip.ts). */
export function phoneWords(msg: string, phone = isPhone()): string {
  if (!phone) return msg;
  if (/^This is a (RAR|7-Zip|\.gz|\.lz)/.test(msg)) return RAR_ON_PHONE;
  const big = /^This model is (\d+) MB unpacked; at most (\d+) MB can be imported here/.exec(msg);
  if (big) return `On a phone a 2D model can be at most ${big[2]} MB unpacked; this one is ${big[1]} MB. Ask the artist for a version with smaller textures, or import it on a computer.`;
  return msg
    .replace(/Unzip it, then zip the model folder again with Windows \(right-click → Send to → Compressed folder\) or drop the folder itself\./, 'Unpack it with an unzip app and choose all the files inside.')
    .replace(/,? ?or zip it with Windows \(right-click → Send to → Compressed folder\)/g, '')
    .replace(/ \(right-click → [^)]*\)/g, '').replace(/ \(7-Zip[^)]*\)/g, '')
    .replace(/Unzip it yourself \(it asks for the password\), then drop the folder\./, 'Unpack it with an unzip app (it asks for the password), then choose all the files inside.')
    .replace(/unzip it and drop (the|just the) (model )?folder( instead)?/gi, 'unpack it with an unzip app and choose all the files inside')
    .replace(/Zip just the model folder \(the one with the \.model3\.json\) and drop that\./, 'Choose just the model’s .zip (the folder with the .model3.json).')
    .replace(/Zip just the model folder and drop that\./, 'Choose just the model’s .zip.')
    .replace(/Drop the whole model folder \(or a \.zip of it\)/, 'Choose the model’s .zip, or all of its files')
    .replace(/\bdrop (the|that|it|your|this)\b/gi, 'choose $1').replace(/\bdrop\b/gi, 'choose');
}

type Msg = { id: number; ok?: boolean; r?: WebFlatResult; status?: number; error?: string; file?: [string, Uint8Array] };
let worker: Worker | null = null; let seq = 0;
const waiting = new Map<number, (m: Msg) => void>();

function viaWorker(picked: { name: string; blob: Blob }[], roles: Record<string, string>, total: number | undefined, onFile: (p: string, b: Uint8Array) => Promise<void>): Promise<Msg> {
  if (!worker) {
    worker = new Worker(new URL('./flatImport.worker.ts', import.meta.url), { type: 'module', name: 'vtp-2d-import' });
    worker.onmessage = (e: MessageEvent<Msg>) => { const f = waiting.get(e.data.id); if (f) f(e.data); };
    worker.onerror = (e) => { e.preventDefault?.(); for (const f of waiting.values()) f({ id: -1, ok: false, status: -1, error: 'worker' }); waiting.clear(); worker?.terminate(); worker = null; };
  }
  const id = ++seq, w = worker;
  return new Promise((res) => {
    let chain = Promise.resolve();
    let failed: Error | null = null;
    waiting.set(id, (m) => {
      if (m.file) {
        const [p, b] = m.file;
        // store it, then ask for the next one
        chain = chain.then(() => (failed ? undefined : onFile(p, b))).catch((x) => { failed = x as Error; }).then(() => w.postMessage({ id, ack: true }));
        return;
      }
      waiting.delete(id);
      void chain.then(() => res(failed ? { id, ok: false, status: (failed as { status?: number }).status ?? 507, error: failed.message } : m));
    });
    w.postMessage({ id, picked, roles, total });
  });
}

/** Picked files (or one uploaded Blob) → a new 2D avatar's files, each handed to `onFile` (store it) before the next.
 *  Returns the rest (config, warnings …). Throws WebFlatError (status + one sentence). */
export async function runFlatImport(picked: { name: string; blob: Blob }[], roles: Record<string, string>, onFile: (p: string, b: Uint8Array) => Promise<void>): Promise<WebFlatResult> {
  const total = importBudget();
  let m: Msg | null = null;
  if (typeof Worker !== 'undefined') { try { m = await viaWorker(picked, roles, total, onFile); } catch { m = null; } }
  if (!m || m.status === -1) {
    // no module workers here (or it crashed): the same import on the page
    const { planWebFlatPicked } = await import('../../shared/mobile/flatPlan.ts');
    const { FlatUploadError } = await import('../../shared/flatUpload.ts');
    let r: WebFlatResult;
    try { r = await planWebFlatPicked(picked, roles, total); }
    catch (e) { throw new WebFlatError(e instanceof FlatUploadError ? e.status : 500, phoneWords((e as Error).message)); }
    for (const [p, b] of r.files) await onFile(p, b);
    return { ...r, files: [] };
  }
  if (!m.ok || !m.r) throw new WebFlatError(m.status ?? 500, phoneWords(m.error ?? 'The import stopped. Try again.'));
  return m.r;
}

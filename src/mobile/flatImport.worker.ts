// The browser-only 2D import, off the page's thread (src/mobile/flatImportWeb.ts): the server's own read + plan + convert
// (shared/mobile/flatPlan.ts → shared/flatUpload.ts), so a phone converts a Live2D zip without freezing the studio.
// Memory: the picked Files stay on disk (they are read in slices: only the zip's directory and the kept entries), and
// every output file is handed to the page on its own (transferred: this worker no longer holds it), so the page can
// store it before the next one is sent ({ ack } back). Messages: { id, file: [path, bytes] } … then { id, ok, r }.
import { planWebFlatPicked } from '../../shared/mobile/flatPlan.ts';
import { FlatUploadError } from '../../shared/flatUpload.ts';

let acked: (() => void) | null = null;
self.onmessage = async (e: MessageEvent<{ id: number; ack?: true; picked: { name: string; blob: Blob }[]; roles: Record<string, string>; total?: number }>) => {
  if (e.data.ack) { acked?.(); acked = null; return; }
  const { id, picked, roles, total } = e.data;
  const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  try {
    const r = await planWebFlatPicked(picked, roles, total);
    const files = r.files; r.files = [];
    while (files.length) {
      const [p, b0] = files.shift()!;
      const b = b0.byteOffset === 0 && b0.byteLength === b0.buffer.byteLength ? b0 : b0.slice();
      // the next file only after the page has stored this one
      const stored = new Promise<void>((res) => { acked = res; });
      post({ id, file: [p, b] }, [b.buffer as ArrayBuffer]);
      await stored;
    }
    post({ id, ok: true, r });
  } catch (err) {
    post({ id, ok: false, status: err instanceof FlatUploadError ? err.status : 500, error: (err as Error)?.message || String(err) });
  }
};

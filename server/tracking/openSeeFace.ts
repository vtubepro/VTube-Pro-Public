// OpenSeeFace's two ONNX models as an OPTIONAL, user-fetched part of the low-spec face tracker (src/tracking/openSeeFace/).
//
// Licence, checked at the source (https://github.com/emilianavt/OpenSeeFace, 2026-10-23):
//   code    BSD 2-Clause (LICENSE; GitHub reports BSD-2-Clause)
//   models  the README ("License") states "The code and models are distributed under the BSD 2-clause license."
//   caveat  the same README says the landmark model was trained on a 66-point LS3D-W and WFLW (research datasets) plus
//           additional data that is not redistributable; the author licenses the WEIGHTS under BSD-2 himself, which is the
//           grant we rely on. Recorded in THIRD_PARTY_NOTICES.md; the owner can still decide to keep it out of a release.
//
// Nothing is bundled and nothing is fetched by the build or by a test: the user presses "Get the light face tracker" (5 MB) and
// the files come from a PINNED commit of the repository; each is checked against its size and its git blob SHA-1 (the id GitHub
// itself lists for the file at that commit) before it is kept. Tests drive installOpenSeeFace with a fetch mock.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { HttpError } from '../library.ts';
import { requireLocal } from '../routes/util.ts';

export const OSF_REPO = 'https://github.com/emilianavt/OpenSeeFace';
/** master on 2026-09-18; the models last changed in 971f81b0 (2021-01-22). */
export const OSF_COMMIT = '50c09741897010faad721a218b2bbe14ecad6251';
export interface OsfFile { file: string; role: 'detector' | 'landmarks'; bytes: number; gitSha1: string; note: string }
/** Sizes and blob ids as GitHub's contents API lists them at OSF_COMMIT. */
export const OSF_FILES: Record<string, OsfFile> = {
  detector: { file: 'mnv3_detection_opt.onnx', role: 'detector', bytes: 568302, gitSha1: '60bbf7a4388858e4409fcc92a2050c448e2379c3', note: 'face finder' },
  balanced: { file: 'lm_model1_opt.onnx', role: 'landmarks', bytes: 4842329, gitSha1: '07c402f6cfd438911519e7cb06d1282d449f8186', note: 'face points, balanced' },
  fast: { file: 'lm_model0_opt.onnx', role: 'landmarks', bytes: 1902521, gitSha1: 'e3547bef62b2d3a7704cd925f546d9c35de5e0bd', note: 'face points, fastest' },
};
export type OsfVariant = 'balanced' | 'fast';
export const OSF_LICENCE = 'BSD 2-Clause (code and models), © 2019 Emiliana';
export const osfUrl = (file: string) => `https://raw.githubusercontent.com/emilianavt/OpenSeeFace/${OSF_COMMIT}/models/${file}`;
export const osfDir = (dataDir: string) => path.join(dataDir, 'models', 'openseeface');
/** The files one variant needs. */
export const osfNeeds = (variant: OsfVariant = 'balanced', files: Record<string, OsfFile> = OSF_FILES): OsfFile[] => [files.detector, files[variant]];

/** git's id for a file: SHA-1 of "blob <size>\0<content>". */
export function gitBlobSha1(buf: Uint8Array): string {
  const h = crypto.createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

export type OsfFileState = 'missing' | 'ready' | 'bad';
const verified = new Map<string, boolean>();
export function fileState(dataDir: string, f: OsfFile): OsfFileState {
  const p = path.join(osfDir(dataDir), f.file);
  let st: fs.Stats; try { st = fs.statSync(p); } catch { return 'missing'; }
  if (st.size !== f.bytes) return 'bad';
  const key = `${p}:${st.mtimeMs}`;
  if (!verified.has(key)) verified.set(key, gitBlobSha1(fs.readFileSync(p)) === f.gitSha1);
  return verified.get(key) ? 'ready' : 'bad';
}
/** Which variant is installed whole (balanced first), or null. */
export function installedVariant(dataDir: string, files: Record<string, OsfFile> = OSF_FILES): OsfVariant | null {
  for (const v of ['balanced', 'fast'] as const) if (files[v] && osfNeeds(v, files).every((f) => fileState(dataDir, f) === 'ready')) return v;
  return null;
}

/** The user pressed "Get it": each file to a temp name, size + blob id checked, kept only if both match; the tracker counts as installed when every file it needs is there. */
export async function installOpenSeeFace(dataDir: string, o: { variant?: OsfVariant; fetch?: typeof fetch; progress?: (got: number, total: number) => void; files?: OsfFile[]; url?: (file: string) => string } = {}): Promise<{ ok: boolean; says: string }> {
  const need = o.files ?? osfNeeds(o.variant ?? 'balanced');
  const f = o.fetch ?? fetch;
  const dir = osfDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const total = need.reduce((a, x) => a + x.bytes, 0);
  let done = 0;
  for (const spec of need) {
    const dst = path.join(dir, spec.file), tmp = `${dst}.part`;
    if (fileState(dataDir, spec) === 'ready') { done += spec.bytes; o.progress?.(done, total); continue; }
    let r: Response;
    try { r = await f((o.url ?? osfUrl)(spec.file), { redirect: 'follow' }); } catch (e) { return { ok: false, says: `Couldn’t reach the download (${(e as Error).message}). Check your internet and try again.` }; }
    if (!r.ok || !r.body) return { ok: false, says: `The download answered ${r.status}. Try again later.` };
    const chunks: Buffer[] = [];
    let got = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        got += value.length;
        if (got > spec.bytes + 1024) throw new Error('the file is bigger than expected');
        chunks.push(Buffer.from(value));
        o.progress?.(done + got, total);
      }
    } catch (e) { return { ok: false, says: `The download stopped (${(e as Error).message}). Try again.` }; }
    const body = Buffer.concat(chunks);
    if (body.length !== spec.bytes || gitBlobSha1(body) !== spec.gitSha1) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      return { ok: false, says: `The downloaded ${spec.note} file isn’t the one we expect (its checksum differs), so nothing was kept.` };
    }
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dst);
    done += spec.bytes;
  }
  return { ok: true, says: 'The light face tracker is ready. It switches on by itself when your usual tracker cannot keep up.' };
}

export function removeOpenSeeFace(dataDir: string, files: Record<string, OsfFile> = OSF_FILES) {
  const dir = osfDir(dataDir);
  for (const f of Object.values(files)) { try { fs.unlinkSync(path.join(dir, f.file)); } catch { /* not there */ } }
}

// pages that are not on this PC never reach these: the files are fetched and kept for this PC's own studio
// ...except what a page only READS: the "is it installed" answer the Tracking panel shows, and the two model files its
// tracking worker loads (the handler still checks the whitelist). Install / remove / anything else stays on this PC.
const USER_ACTION = 'x-vtp-user-action';
/**
 * GET    /api/openseeface              → { installed, variant, bytes, files[], licence, source, busy }
 * POST   /api/openseeface/install      → the user's click: fetch + check + keep (local only, click header)
 * DELETE /api/openseeface              → remove the files
 * GET    /api/openseeface/model/:file  → an installed model for the studio's tracking worker (whitelisted names, local only)
 */
export function openSeeFaceRoutes(dataDir: string, opts: { fetch?: typeof fetch; files?: Record<string, OsfFile>; url?: (file: string) => string } = {}): Router {
  const FILES = opts.files ?? OSF_FILES;
  const r = Router();
  let busy: { got: number; total: number } | null = null;
  const userAction = (req: { headers: Record<string, unknown> }) => { if (req.headers[USER_ACTION] !== '1') throw new HttpError(403, 'Press the button in VTube Pro on this PC'); };
  const view = () => {
    const variant = installedVariant(dataDir, FILES);
    return {
      installed: !!variant, variant,
      files: osfNeeds(variant ?? 'balanced', FILES).map((f) => ({ file: f.file, bytes: f.bytes, note: f.note, state: fileState(dataDir, f) })),
      bytes: osfNeeds('balanced', FILES).reduce((a, f) => a + f.bytes, 0),
      licence: OSF_LICENCE, source: `${OSF_REPO}/tree/${OSF_COMMIT}/models`, busy,
    };
  };
  r.get('/api/openseeface', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(view()); });
  r.post('/api/openseeface/install', async (req, res) => {
    requireLocal(req); userAction(req);
    if (busy) { res.json({ ok: false, says: 'Already downloading.' }); return; }
    if (installedVariant(dataDir, FILES)) { res.json({ ok: true, says: 'Already installed.', ...view() }); return; }
    const need = osfNeeds('balanced', FILES);
    if (process.env.VTP_TOOLS_DRYRUN === '1' || process.env.VTP_NO_MODEL_DOWNLOAD === '1') { res.json({ ok: true, dryRun: true, says: `Would download ${need.length} files (${Math.round(need.reduce((a, f) => a + f.bytes, 0) / 1e6 * 10) / 10} MB) from the OpenSeeFace repository and check each one.` }); return; }
    busy = { got: 0, total: need.reduce((a, f) => a + f.bytes, 0) };
    res.json({ ok: true, says: 'Downloading…' });
    void installOpenSeeFace(dataDir, { fetch: opts.fetch, files: need, url: opts.url, progress: (got, total) => { busy = { got, total }; } }).then((x) => { busy = null; if (!x.ok) console.log(`[openseeface] ${x.says}`); }).catch((e) => { busy = null; console.log(`[openseeface] ${String(e)}`); });
  });
  r.delete('/api/openseeface', (req, res) => { requireLocal(req); userAction(req); removeOpenSeeFace(dataDir, FILES); res.json(view()); });
  r.get('/api/openseeface/model/:file', (req, res) => {
    requireLocal(req);
    const name = String(req.params.file);
    const spec = Object.values(FILES).find((f) => f.file === name);
    if (!spec || fileState(dataDir, spec) !== 'ready') throw new HttpError(404, 'That model is not installed');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(fs.readFileSync(path.join(osfDir(dataDir), spec.file)));
  });
  return r;
}

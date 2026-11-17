// "Just drop a model": VTube Pro's server part. The studio reads VRM / GLB / .gltf / PMX
// itself (shared/modelImport); formats only Blender reads (FBX, OBJ, .blend, USD, …) come here:
//   POST /api/import/convert?filename=<model path>   body = the model file, or a .zip of the model + its textures /
//        .mtl (paths kept, so relative texture paths still work)  → { token, missing[], meshes }
//   GET  /api/import/convert/:token                  → the converted .glb (once; then it's deleted)
// Nothing is saved to the library here: the studio shows its report first and saves with POST /api/avatars/import.
// Blender runs at low priority (the live studio's tracking comes first) and finds textures anywhere in the upload.
import express, { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runBlender } from '../blender.ts';
import { HttpError } from '../library.ts';
import { CACHE_DIR } from '../paths.ts';
import { stamp } from './util.ts';
import { unzip } from '../../shared/modelImport/files.ts';

export const importConvertRoutes = Router();

const CONVERT_EXT = new Set(['.fbx', '.obj', '.blend', '.dae', '.stl', '.ply', '.usd', '.usda', '.usdc', '.usdz', '.abc']);
const ROOT = path.join(CACHE_DIR, 'tmp', 'import-convert');
const KEEP_MS = 15 * 60_000;
const ready = new Map<string, { file: string; dir: string; at: number }>();

/** A path inside the upload that can't climb out of the stage folder. */
function safeRel(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /[<>:"|?*\u0000-\u001f]/.test(x))) return null;
  return parts.join('/');
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of ready) if (now - v.at > KEEP_MS) { ready.delete(k); void fsp.rm(v.dir, { recursive: true, force: true }).catch(() => {}); }
}

importConvertRoutes.post('/api/import/convert', express.raw({ type: () => true, limit: '700mb' }), async (req, res) => {
  sweep();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Empty upload');
  const wanted = safeRel(String(req.query.filename ?? ''));
  if (!wanted) throw new HttpError(400, 'Pass ?filename=<the model file’s name or its path inside the zip>');
  const token = stamp();
  const dir = path.join(ROOT, token);
  const stage = path.join(dir, 'in');
  await fsp.mkdir(stage, { recursive: true });
  let keep = false;
  try {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
    let main: string;
    if (isZip) {
      let files;
      try { files = unzip(bytes); } catch (e) { throw new HttpError(400, (e as Error).message); }
      for (const f of files) {
        const rel = safeRel(f.path);
        if (!rel) continue;
        const to = path.join(stage, rel);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.writeFile(to, f.bytes);
      }
      main = path.join(stage, wanted);
    } else {
      main = path.join(stage, path.basename(wanted));
      await fsp.writeFile(main, bytes);
    }
    const ext = path.extname(main).toLowerCase();
    if (!CONVERT_EXT.has(ext)) throw new HttpError(400, `${ext || 'This file'} isn’t converted here (VRM, GLB, glTF and PMX open in the studio itself).`);
    try { await fsp.access(main); } catch { throw new HttpError(400, `The upload has no ${wanted}`); }
    const out = path.join(dir, 'model.glb');
    const r = await runBlender<{ meshes: number; missing?: string[] }>('convert.py', { input: main, output: out, search: stage }, { timeoutMs: 600_000, lowPriority: true });
    if (!r.ok) {
      const msg = String(r.error ?? 'Blender stopped');
      throw new HttpError(/not found/i.test(msg) ? 503 : 422, /no meshes/i.test(msg) ? 'The file has no model in it (no meshes): only a skeleton, animation or camera.' : /COLLADA/i.test(msg) ? msg : `Blender couldn’t convert it: ${msg.slice(0, 300)}`);
    }
    ready.set(token, { file: out, dir, at: Date.now() });
    keep = true;
    res.json({ token, meshes: r.result?.meshes ?? 0, missing: (r.result?.missing ?? []).slice(0, 100) });
  } finally {
    if (!keep) void fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

importConvertRoutes.get('/api/import/convert/:token', async (req, res) => {
  const t = ready.get(String(req.params.token));
  if (!t) throw new HttpError(404, 'That conversion is gone (they are kept for 15 minutes). Drop the file again.');
  ready.delete(String(req.params.token));
  try {
    const b = await fsp.readFile(t.file);
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'no-store');
    res.send(b);
  } finally {
    void fsp.rm(t.dir, { recursive: true, force: true }).catch(() => {});
  }
});

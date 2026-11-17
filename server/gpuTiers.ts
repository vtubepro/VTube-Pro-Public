// "Making your model sharper and lighter… you can use it now." (HQ decision #10): the helper builds a rigged 2D
// model's texture tiers in the background, into a rebuildable cache BESIDE the model (library/<id>/gpu/<key>/, see
// shared/rig2d/gpu/cache.ts); the .vtp2 keeps the original art. One build at a time, in a child process at
// below-normal priority (server/gpuTiersChild.ts, started off the event loop: server/spawnOffLoop.ts), so the live
// studio never stutters. The studio finds the cache by its key (src/avatar/flat/rig2d/textureTier.ts computes the
// same key) and asks for a build when it is missing: POST /api/avatars/:id/gpu {key}. Status: GET /api/avatars/:id/gpu.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOffLoop } from './spawnOffLoop.ts';
import { userDir } from './library.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GPU_DIR = 'gpu';

/** How the builder runs here: the bundled entry in a release, tsx from source. */
export function gpuTiersCommand(root = ROOT, exists: (p: string) => boolean = fs.existsSync): string[] {
  const bundled = path.join(root, 'dist-helper', 'gpu_tiers.mjs');
  return exists(bundled) ? [bundled] : ['--import', 'tsx', path.join(root, 'server', 'gpuTiersChild.ts')];
}

export interface GpuState { state: 'none' | 'queued' | 'building' | 'done' | 'failed'; key?: string; error?: string; note?: string; progress?: { tiers: number; of: number } }
const jobs = new Map<string, GpuState & { wantKey?: string }>();
const queue: string[] = [];
let running: string | null = null;

const keyDirsIn = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{16}$/.test(e.name)).map((e) => e.name).sort(); } catch { return []; } };
const keyDirs = (id: string) => keyDirsIn(path.join(userDir(id), GPU_DIR));
const manifestIn = (dir: string, key: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, key, 'manifest.json'), 'utf8')) as { status: string; tiers: { done: boolean }[]; error?: string; note?: string; at?: string }; } catch { return null; } };
const manifestOf = (id: string, key: string) => manifestIn(path.join(userDir(id), GPU_DIR), key);

/** The cache to report when the studio gives no key (a party bundle, the panel): a finished one, newest first; else
 *  the newest one with a manifest (its state shows). Folders without a manifest (a build cut off) never count. */
export function pickCacheDir(gpuDir: string): string | undefined {
  const ms = keyDirsIn(gpuDir).map((k) => ({ k, m: manifestIn(gpuDir, k) })).filter((x) => x.m);
  const at = (x: { m: { at?: string } | null }) => Date.parse(x.m?.at ?? '') || 0;
  const newest = (l: typeof ms) => l.sort((a, b) => at(b) - at(a) || (a.k < b.k ? 1 : -1))[0]?.k;
  return newest(ms.filter((x) => x.m!.status === 'done')) ?? newest(ms);
}

/** Where this avatar's texture tiers stand (`key`: the studio's key; without it, the newest cache). */
export function gpuState(id: string, key?: string): GpuState {
  const j = jobs.get(id);
  const k = key ?? j?.key ?? pickCacheDir(path.join(userDir(id), GPU_DIR));
  const m = k ? manifestOf(id, k) : null;
  if (j && (j.state === 'queued' || j.state === 'building') && (!key || !j.wantKey || j.wantKey === key)) {
    return { ...j, ...(m ? { key: k, progress: { tiers: m.tiers.filter((t) => t.done).length, of: m.tiers.length } } : {}) };
  }
  if (m) return { state: m.status === 'done' ? 'done' : m.status === 'failed' ? 'failed' : (j?.state === 'failed' ? 'failed' : 'none'), key: k, ...(m.error ? { error: m.error } : {}), ...(m.note ? { note: m.note } : {}), progress: { tiers: m.tiers.filter((t) => t.done).length, of: m.tiers.length } };
  return j?.state === 'failed' ? { state: 'failed', error: j.error } : { state: 'none' };
}

/** Queue a build for a rigged 2D model (no-op when one is queued / running, or the cache for `key` is complete). */
export function requestGpuTiers(id: string, key?: string): GpuState {
  const dir = userDir(id), model = path.join(dir, 'model.vtp2');
  if (!fs.existsSync(model)) return { state: 'none' };
  const s = gpuState(id, key);
  if (s.state === 'queued' || s.state === 'building' || (s.state === 'done' && (!key || s.key === key))) return s;
  if (s.state === 'failed' && (!key || s.key === key) && jobs.get(id)?.state === 'failed') return s;   // (no retry loop)
  jobs.set(id, { state: 'queued', ...(key ? { wantKey: key } : {}) });
  queue.push(id);
  void pump();
  return gpuState(id, key);
}

async function pump() {
  if (running || !queue.length) return;
  const id = queue.shift()!;
  running = id;
  const j = jobs.get(id)!;
  j.state = 'building';
  try {
    const dir = path.join(userDir(id), GPU_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const r = await runOffLoop(process.execPath, [...gpuTiersCommand(), path.join(userDir(id), 'model.vtp2'), dir], { timeoutMs: 60 * 60_000, cwd: ROOT });
    const lines = r.stdout.toString('utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
    const last = lines[lines.length - 1] ?? {};
    const key = lines.find((l) => typeof l.key === 'string')?.key as string | undefined;
    if (key) j.key = key;
    if (last.done) {
      j.state = 'done';
      // older caches of this model (its art or layout changed) go
      for (const k of keyDirs(id)) if (k !== key) await fsp.rm(path.join(dir, k), { recursive: true, force: true }).catch(() => undefined);
    } else {
      j.state = 'failed';
      j.error = typeof last.error === 'string' ? plain(last.error) : r.timedOut ? 'Making the lighter versions took too long; the model still works at full size.' : 'Making the lighter versions failed; the model still works at full size.';
      console.warn(`[gpu tiers] ${id}: ${last.error ?? r.error ?? r.stderr.slice(-300)}`);
    }
  } catch (e) {
    j.state = 'failed'; j.error = 'Making the lighter versions failed; the model still works at full size.';
    console.warn(`[gpu tiers] ${id}: ${(e as Error).message}`);
  } finally {
    running = null;
    void pump();
  }
}

/** One plain sentence for the studio (the builder's own messages are already plain; anything technical is replaced). */
const plain = (s: string) => (/^[A-Z][^{}<>]{0,200}$/.test(s) && !/Error|undefined|null/.test(s) ? s : 'Making the lighter versions failed; the model still works at full size.');

/** Tests: wait until nothing is queued or running. */
export async function gpuTiersIdle(timeoutMs = 600_000) {
  const t = Date.now();
  while ((running || queue.length) && Date.now() - t < timeoutMs) await new Promise((r) => setTimeout(r, 200));
}

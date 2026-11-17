// Pro2D → 3D job folders on the helper (lane to3d). <data>/cache/to3d/<jobId>/:
//   job.json      the job (shared/to3d/job.ts), written atomically
//   src/model.vtp2   the user's own file (the only copy outside their library)
//   bundle/       tools/pro2d_bundle.ts export (+ poses evaluated later)
//   refs/         2D reference renders, labels, landmarks, part cut-outs
//   rounds/<n>/   the pipeline's out_dir for round n (VRM, profile.json, l2d/), check/ (renders, compare, review)
//   work/         the ONLY folder an AI's Blender MCP code may write (parts/ for to3d_graft)
// Nothing is ever deleted silently: the drawer's "Delete this job's files" removes a folder (jobs untouched for 30 days
// are listed as old jobs). Model custody: the model never leaves this folder except through the user's own AI chat.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { To3dJob } from '../../shared/to3d/job.ts';
import { CACHE_DIR, DATA_DIR } from '../paths.ts';

export const TO3D_DIR = process.env.VTP_TO3D_DIR || path.join(CACHE_DIR, 'to3d');
/** the 3D toolkit (uv, Python env, the user's own base if they picked one, settings.json) */
export const KIT_DIR = process.env.VTP_TO3D_KIT || path.join(DATA_DIR, 'to3d-kit');
export const OLD_MS = 30 * 24 * 3600 * 1000;
/** to3d_graft limits: checked when the AI asks, again right before the part is read (runner + graft.py) */
export const PART_MAX_BYTES = 32 * 2 ** 20;
export const HIDE_MAX_CHARS = 64;
/** Throws (a user-facing sentence) when a part file is over PART_MAX_BYTES. */
export async function checkPartSizes(files: string[]): Promise<void> {
  for (const f of files) {
    const size = (await fsp.stat(f)).size;
    if (size > PART_MAX_BYTES) throw new Error(`${path.basename(f)} is ${Math.round(size / 2 ** 20)} MB: a part must be under ${PART_MAX_BYTES / 2 ** 20} MB. Lower its polygon count and textures, export it again.`);
  }
}

const ID_RE = /^t3d-[a-z0-9]{10}$/;
export const validJobId = (id: string) => ID_RE.test(id);
export const jobDir = (id: string) => { if (!validJobId(id)) throw new Error('bad job id'); return path.join(TO3D_DIR, id); };
export const jobPaths = (id: string) => {
  const d = jobDir(id);
  return { dir: d, job: path.join(d, 'job.json'), src: path.join(d, 'src', 'model.vtp2'), bundle: path.join(d, 'bundle'), refs: path.join(d, 'refs'),
    rounds: path.join(d, 'rounds'), work: path.join(d, 'work'), parts: path.join(d, 'work', 'parts'), blend: path.join(d, 'work', 'candidate.blend') };
};
export const roundDir = (id: string, n: number) => path.join(jobPaths(id).rounds, String(n));
export const checkDir = (id: string, n: number) => path.join(roundDir(id, n), 'check');

export function newJobId(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(10);
  return 't3d-' + Array.from(b, (x) => a[x % a.length]).join('');
}

const cache = new Map<string, To3dJob>();
const locks = new Map<string, Promise<unknown>>();

export function loadJob(id: string): To3dJob | null {
  if (!validJobId(id)) return null;
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const j = JSON.parse(fs.readFileSync(jobPaths(id).job, 'utf8')) as To3dJob;
    if (j?.id !== id) return null;
    cache.set(id, j);
    return j;
  } catch { return null; }
}

function writeJob(j: To3dJob) {
  const p = jobPaths(j.id).job;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1));
  fs.renameSync(tmp, p);
}

export function saveJob(j: To3dJob): To3dJob {
  j.updatedAt = Date.now();
  cache.set(j.id, j);
  writeJob(j);
  for (const cb of listeners) { try { cb(j); } catch { /* a listener must not break a job */ } }
  return j;
}

/** One change at a time per job (tool calls, the runner and the drawer can overlap). */
export async function withJob<T>(id: string, fn: (j: To3dJob) => T | Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  locks.set(id, prev.then(() => next));
  await prev.catch(() => {});
  try {
    const j = loadJob(id);
    if (!j) throw Object.assign(new Error('There is no such 3D job (it may have been deleted).'), { status: 404 });
    const r = await fn(j);
    saveJob(j);
    return r;
  } finally { release(); if (locks.get(id) === next) locks.delete(id); }
}

export function createJob(j: To3dJob): To3dJob {
  const P = jobPaths(j.id);
  for (const d of [P.dir, path.dirname(P.src), P.bundle, P.refs, P.rounds, P.work, P.parts]) fs.mkdirSync(d, { recursive: true });
  return saveJob(j);
}

export function listJobs(): To3dJob[] {
  let names: string[] = [];
  try { names = fs.readdirSync(TO3D_DIR); } catch { return []; }
  return names.filter(validJobId).map(loadJob).filter((j): j is To3dJob => !!j).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteJob(id: string): Promise<boolean> {
  if (!validJobId(id)) return false;
  cache.delete(id);
  const d = jobDir(id);
  if (!fs.existsSync(d)) return false;
  await fsp.rm(d, { recursive: true, force: true });
  return true;
}

/** Tests: forget what was read. */
export function forgetJobs() { cache.clear(); }

const listeners = new Set<(j: To3dJob) => void>();
/** Hear about every saved job (server/index.ts: a bus notice so the drawer updates at once). */
export function onJobChange(cb: (j: To3dJob) => void) { listeners.add(cb); return () => listeners.delete(cb); }

/** A path inside the job folder, from a job-relative name the AI or the page passes (never outside it). */
export function insideJob(id: string, rel: string): string | null {
  const d = jobDir(id);
  const p = path.resolve(d, rel.replace(/\\/g, '/'));
  return p === d || p.startsWith(d + path.sep) ? p : null;
}

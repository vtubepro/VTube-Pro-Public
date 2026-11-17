// Background jobs (generation, autorig…). Kept in memory, mirrored to cache/jobs/<id>/job.json
// so the log tail and results survive a server restart. Job files (previews) live next to it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Job } from '../shared/types.ts';
import { JOBS_DIR } from './paths.ts';

const MAX_LOG = 500;
const jobs = new Map<string, Job>();
const saveTimers = new Map<string, NodeJS.Timeout>();
/** The last write of each job's job.json: writes are chained, so a late one never lands over a newer one. */
const writes = new Map<string, Promise<void>>();
/** GET /api/jobs answers the newest jobs only (the Create area polls it every 2-6 s; months of jobs made it grow). */
const LIST_MAX = 100;

export interface JobContext {
  job: Job;
  /** Absolute folder for this job's files (served at /api/jobs/:id/files/:name). */
  dir: string;
  log: (line: string) => void;
  progress: (p: number) => void;
  /** Set job.preview to a file in the job dir (by name) or any URL. */
  preview: (fileOrUrl: string) => void;
  fileUrl: (name: string) => string;
}

export const jobDir = (id: string) => path.join(JOBS_DIR, id);
export const jobFileUrl = (id: string, name: string) =>
  `/api/jobs/${id}/files/${name.split(/[\\/]/).map(encodeURIComponent).join('/')}`;

/** JSON with every non-ASCII character as a \uXXXX escape: the same data for any JSON reader, but a reader that guesses
 *  the wrong text encoding (Windows PowerShell 5.1 Get-Content / Invoke-RestMethod, an ANSI editor) can no longer
 *  garble a log line ("Added ... ✔" showed up as "âœ”"). */
export function asciiJson(v: unknown, space?: number): string {
  return JSON.stringify(v, null, space).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function persist(job: Job, now = false) {
  // async: a running job saves every 500 ms (up to 500 log lines), and a sync write on a slow / scanned disk stalls the
  // bus that relays tracking. The text is taken now, written in order.
  const write = () => {
    saveTimers.delete(job.id);
    const text = asciiJson(job, 2), dir = jobDir(job.id);
    const p = (writes.get(job.id) ?? Promise.resolve())
      .then(() => fsp.mkdir(dir, { recursive: true }))
      .then(() => fsp.writeFile(path.join(dir, 'job.json'), text))
      .catch(() => { /* best effort */ });
    writes.set(job.id, p);
    void p.then(() => { if (writes.get(job.id) === p) writes.delete(job.id); });
  };
  if (now) {
    clearTimeout(saveTimers.get(job.id));
    return write();
  }
  if (!saveTimers.has(job.id)) saveTimers.set(job.id, setTimeout(write, 500));
}

/** Load persisted jobs; anything that was mid-flight when the server died is marked failed. */
export function loadJobs() {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(JOBS_DIR);
  } catch {
    return;
  }
  for (const d of dirs) {
    try {
      const job: Job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, d, 'job.json'), 'utf8'));
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'Server restarted while the job was running';
        fs.writeFileSync(path.join(JOBS_DIR, d, 'job.json'), asciiJson(job, 2)); // at startup: sync is fine
      }
      jobs.set(job.id, job);
    } catch {
      /* ignore broken entries */
    }
  }
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

/** The newest `max` jobs (that pass `filter`), each with its last 20 log lines. */
export function listJobs(filter?: (j: Job) => boolean, max = LIST_MAX): Job[] {
  return [...jobs.values()]
    .filter((j) => !filter || filter(j))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, max)
    .map((j) => ({ ...j, log: j.log.slice(-20) }));
}

/** Start a job; `run` returns the job result. Throwing marks the job failed with the message. */
export function startJob(kind: string, run: (ctx: JobContext) => Promise<Job['result']>, meta?: Record<string, unknown>): Job {
  const id = `${kind.replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const job: Job = { id, kind, status: 'queued', progress: 0, log: [], createdAt: new Date().toISOString() };
  if (meta) job.result = { ...meta };
  jobs.set(id, job);
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const ctx: JobContext = {
    job,
    dir,
    log: (line) => {
      const stamp = new Date().toISOString().slice(11, 19);
      for (const l of String(line).split(/\r?\n/)) job.log.push(`[${stamp}] ${l}`);
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
      persist(job);
    },
    progress: (p) => {
      job.progress = Math.max(job.progress, Math.min(1, Math.max(0, p)));
      persist(job);
    },
    preview: (f) => {
      job.preview = /^(\/|https?:)/.test(f) ? f : jobFileUrl(id, f);
      persist(job);
    },
    fileUrl: (name) => jobFileUrl(id, name),
  };
  persist(job, true);
  queueMicrotask(async () => {
    job.status = 'running';
    persist(job);
    try {
      const result = await run(ctx);
      job.result = { ...job.result, ...result };
      job.status = 'succeeded';
      job.progress = 1;
      ctx.log('Done.');
    } catch (e) {
      job.status = 'failed';
      job.error = e instanceof Error ? e.message : String(e);
      const fix = (e as { fixUrl?: unknown } | null)?.fixUrl;
      if (typeof fix === 'string' && fix.startsWith('/')) job.fixUrl = fix; // a helper page that fixes it (the studio offers a button)
      ctx.log(`FAILED: ${job.error}`);
    }
    persist(job, true);
  });
  return job;
}

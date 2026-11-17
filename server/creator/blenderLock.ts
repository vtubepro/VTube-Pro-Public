// The Blender lock (docs/BLENDER_PLAYBOOK.md §3.2) in code, for the Creator Console: exactly ONE headless Blender
// job at a time on this PC, across the studio, the console, the CLI and any agent working here.
//   * lock = a directory created atomically (mkdir fails when it exists): %VTP_BLENDER_LOCK% or %TEMP%\vtp_blender.lock
//   * owner.txt inside it says who holds it ("<who> <what> <time>")
//   * while it exists, or while any other HEADLESS blender (command line with " -b ") runs, wait and retry
//     (a GUI Blender without -b is the owner's own window: never waited for, never touched)
//   * removed as soon as the run ends, also on errors (finally)
// Blender itself runs at the lowest CPU priority (runBlender lowPriority, like tools/blender_low.cmd).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBlender, type RunOptions, type RunResult } from '../blender.ts';

export const blenderLockPath = (env: NodeJS.ProcessEnv = process.env) => env.VTP_BLENDER_LOCK || path.join(os.tmpdir(), 'vtp_blender.lock');

export interface LockStatus { held: boolean; owner: string | null; path: string }
export function lockStatus(env: NodeJS.ProcessEnv = process.env): LockStatus {
  const p = blenderLockPath(env);
  if (!fs.existsSync(p)) return { held: false, owner: null, path: p };
  let owner: string | null = null;
  try { owner = fs.readFileSync(path.join(p, 'owner.txt'), 'utf8').trim().slice(0, 200) || null; } catch { /* being written */ }
  return { held: true, owner, path: p };
}

/** Is another headless Blender (" -b ") running on this PC? (GUI Blender windows don't count.) */
export function otherHeadlessBlender(): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (out: string) => resolve(out.split(/\r?\n/).some((l) => /blender/i.test(l) && /\s-b(\s|$)/.test(` ${l} `)));
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='blender.exe'\" | ForEach-Object { $_.CommandLine }"],
      { windowsHide: true, timeout: 15000 }, (_e, stdout) => done(String(stdout ?? '')));
    } else {
      execFile('ps', ['-axo', 'command'], { timeout: 15000 }, (_e, stdout) => done(String(stdout ?? '').split('\n').filter((l) => /blender/i.test(l)).join('\n')));
    }
  });
}

export interface AcquireOpts {
  who?: string; what?: string;
  pollMs?: number;                     // default 30 s (the playbook's etiquette)
  timeoutMs?: number;                  // default 30 min
  env?: NodeJS.ProcessEnv;
  busy?: () => Promise<boolean>;       // default otherHeadlessBlender
  onWait?: (why: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Take the lock (waiting politely); returns release(). */
export async function acquireBlenderLock(o: AcquireOpts = {}): Promise<() => void> {
  const lock = blenderLockPath(o.env);
  const poll = o.pollMs ?? 30_000, until = Date.now() + (o.timeoutMs ?? 30 * 60_000);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const busy = o.busy ?? otherHeadlessBlender;
  for (;;) {
    if (Date.now() > until) throw new Error(`Blender stayed busy too long (lock: ${lockStatus(o.env).owner ?? lock}). Try again later.`);
    if (await busy()) { o.onWait?.('Another Blender job is running on this PC; waiting for it to finish…'); await sleep(poll); continue; }
    try {
      fs.mkdirSync(lock);                 // atomic: throws EEXIST when someone holds it
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      o.onWait?.(`Blender is in use (${lockStatus(o.env).owner ?? 'someone'}); waiting…`);
      await sleep(poll);
      continue;
    }
    try { fs.writeFileSync(path.join(lock, 'owner.txt'), `${o.who ?? 'vtubepro-creator-console'} ${o.what ?? 'blender'} ${new Date().toISOString()}`); } catch { /* lock still held */ }
    let released = false;
    return () => { if (released) return; released = true; try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ } };
  }
}

/** runBlender inside the team lock, at low priority. */
export async function runBlenderLocked<T = unknown>(script: string, params: Record<string, unknown>, opts: RunOptions & { what?: string; onWait?: (why: string) => void } = {}): Promise<RunResult<T>> {
  const release = await acquireBlenderLock({ what: opts.what ?? script, onWait: opts.onWait });
  try { return await runBlender<T>(script, params, { ...opts, lowPriority: true }); } finally { release(); }
}

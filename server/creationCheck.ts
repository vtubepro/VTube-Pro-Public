// MCP check_creation: the agent file check (shared/agentCheck/*) on a file or folder on this PC.
// It reads and parses whole models (a PSD rig build, a Live2D conversion, a room's triangle soup: up to seconds of CPU),
// and the /mcp route runs inside the helper, whose event loop relays every tracking frame to the OBS page: so the check
// runs in its own Node process at below-normal priority (server/spawnOffLoop.ts runOffLoop), like the room check
// (server/roomCheckJob.ts).
import fs from 'node:fs';
import path from 'node:path';
import { runOffLoop } from './spawnOffLoop.ts';

export const CREATION_CHECK_TIMEOUT_MS = 180_000;

export function vtpCheckCommand(root: string, exists: (p: string) => boolean = fs.existsSync): string[] {
  const bundled = path.join(root, 'dist-helper', 'vtp_check.mjs');
  return exists(bundled) ? [bundled] : ['--import', 'tsx', path.join(root, 'tools', 'vtp_check.ts')];
}

/** The check's JSON result (vtube-pro.check/1), or throws an Error with one plain sentence. */
export async function runCreationCheck(root: string, file: string, kind?: string, timeoutMs = CREATION_CHECK_TIMEOUT_MS): Promise<Record<string, unknown>> {
  if (!path.isAbsolute(file)) throw new Error('path must be an absolute path to a file, a folder or a .zip on this PC.');
  if (!fs.existsSync(file)) throw new Error(`Nothing at ${file}.`);
  const args = [...vtpCheckCommand(root), file, '--json', ...(kind ? ['--kind', kind] : [])];
  const r = await runOffLoop(process.execPath, args, { cwd: root, timeoutMs });
  if (r.timedOut) throw new Error(`The check took over ${Math.round(timeoutMs / 1000)} s and was stopped. Point it at the model / room folder itself, not a bigger folder.`);
  if (r.error && r.code === null) throw new Error('The check could not start on this PC. Try again in a moment.');
  const out = r.stdout.toString('utf8').trim();
  if (r.code === 2 || !out.startsWith('{')) throw new Error(r.stderr.trim().split(/\r?\n/)[0]?.replace(/^vtp-check: /, '') || `The check stopped (exit ${r.code}).`);
  try { return JSON.parse(out); } catch { throw new Error('The check gave no readable answer.'); }
}

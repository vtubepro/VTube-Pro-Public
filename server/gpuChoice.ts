// The owner's answer about GPU lip sync (Audio2Face), kept on the helper in config/gpu.json: "accepted" (it stays on, also after a
// cleared browser) or "declined" (never asked again). Not in the browser's localStorage only: a browser that
// forgot, or a second studio, must not flip a GPU job on or off. Pure file I/O so the tests can point it at a temp folder.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.ts';

export type A2fChoice = 'accepted' | 'declined';
export const GPU_CONFIG_FILE = () => process.env.VTP_GPU_CONFIG || path.join(CONFIG_DIR, 'gpu.json');

export function readA2fChoice(file = GPU_CONFIG_FILE()): A2fChoice | undefined {
  try {
    const c = (JSON.parse(fs.readFileSync(file, 'utf8')) as { a2f?: { choice?: unknown } }).a2f?.choice;
    return c === 'accepted' || c === 'declined' ? c : undefined;
  } catch { return undefined; }
}

export function writeA2fChoice(choice: A2fChoice, file = GPU_CONFIG_FILE()): void {
  let cur: Record<string, unknown> = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...cur, a2f: { choice, at: new Date().toISOString() } }, null, 2));
  fs.renameSync(tmp, file);
}

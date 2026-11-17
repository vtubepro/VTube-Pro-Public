// Filesystem layout for the local server. Read-only content (assets, blender, tools, docs, dist) is relative to the
// project root; what the server WRITES (config, cache, library, videos, saves) lives under DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userConfigDir } from './configDir.ts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(MODULE_DIR, '..');

/** Where the server keeps what it writes.
 *  - The owner's / a developer's SOURCE install (no release_manifest.json): the project root, exactly as always.
 *  - A bundled RELEASE (release_manifest.json + profile "helper", or any release running dist-helper/index.mjs): the
 *    user's own per-OS folder, (server/configDir.ts userConfigDir: %APPDATA%\VTube Pro,
 *    ~/Library/Application Support/VTube Pro, ~/.config/vtube-pro; VTP_CONFIG_HOME overrides). The install folder is
 *    then never written by the server, so an update can replace it whole and a per-machine install works.
 *  - VTP_DATA_HOME=<folder> forces a folder; VTP_PORTABLE=1 forces the install folder (USB-stick style). */
export function dataHome(root: string = ROOT, moduleDir: string = MODULE_DIR, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, home?: string): { dir: string; why: 'env' | 'portable' | 'release' | 'source' } {
  if (env.VTP_DATA_HOME) return { dir: path.resolve(env.VTP_DATA_HOME), why: 'env' };
  if (env.VTP_PORTABLE === '1') return { dir: root, why: 'portable' };
  let profile: unknown;
  try { profile = (JSON.parse(fs.readFileSync(path.join(root, 'release_manifest.json'), 'utf8')) as { profile?: unknown }).profile; }
  catch { return { dir: root, why: 'source' }; }
  if (profile === 'helper' || path.basename(moduleDir) === 'dist-helper') return { dir: userConfigDir(env, platform, home), why: 'release' };
  return { dir: root, why: 'source' };
}
const DATA = dataHome();
export const DATA_DIR = DATA.dir;
export const DATA_WHY = DATA.why;

export const LIBRARY_DIR = path.join(DATA_DIR, 'library');       // user avatars (writable)
export const BUILTIN_DIR = path.join(ROOT, 'assets', 'builtin');  // shipped avatars (read-only)
export const TRASH_DIR = path.join(LIBRARY_DIR, '.trash');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const JOBS_DIR = path.join(CACHE_DIR, 'jobs');
export const CONFIG_DIR = path.join(DATA_DIR, 'config');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
/** Shipped defaults: always read from the install (the example files never move). */
export const SETTINGS_EXAMPLE = path.join(ROOT, 'config', 'settings.example.json');
export const COMFY_WORKFLOWS_DIR = path.join(CONFIG_DIR, 'comfy_workflows');
export const VIDEOS_DATA_DIR = path.join(DATA_DIR, 'videos');
export const SAVES_DIR = path.join(DATA_DIR, 'saves');
export const BLENDER_SCRIPTS = path.join(ROOT, 'blender');
/** Rooms that come with this install (read-only in a release: an update replaces the whole program folder). */
export const SHIPPED_SCENES_DIR = path.join(ROOT, 'assets', 'scenes');
/** Rooms the USER adds (AI-built, "Add my room", room imports): in a
 *  release they live in the per-user data folder (<data>/scenes), so updates never touch them; a source install keeps
 *  using its own assets/scenes exactly as before. VTP_SCENES_DIR overrides (tests, a private helper). The scenes
 *  routes serve both folders (user first). */
export const USER_SCENES_DIR = process.env.VTP_SCENES_DIR || (path.resolve(DATA_DIR) === path.resolve(ROOT) ? SHIPPED_SCENES_DIR : path.join(DATA_DIR, 'scenes'));

export const PORT = Number(process.env.VTP_PORT ?? 5191);
export const HOST = '127.0.0.1';

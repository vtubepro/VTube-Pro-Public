// User rooms out of the program folder (integration wave 3, data-loss fix). In a release, rooms the user added used to
// land in <install>/assets/scenes, which an update replaces. Now they go to the per-user data folder
// (server/paths.ts USER_SCENES_DIR). This moves any room a release finds in its program folder that the release itself
// does not ship (listed in release_manifest.json) over to the user folder, once, at start. A source install (the
// owner's own checkout: no release_manifest.json, DATA_DIR = ROOT) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { ROOM_FOLDER } from '../shared/roomId.ts';

/** Room folder ids the release ships, from release_manifest.json (null = not a release / unreadable: do nothing). */
export function shippedRoomIds(root: string): Set<string> | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'release_manifest.json'), 'utf8')) as { files?: { path?: string }[] };
    const ids = new Set<string>();
    for (const f of m.files ?? []) { const r = /^assets\/scenes\/([^/]+)\//.exec(String(f.path ?? '')); if (r) ids.add(r[1]); }
    return ids;
  } catch { return null; }
}

/** Move user rooms from <shippedDir> to <userDir>. Never overwrites: a room already in the user folder stays there and
 *  the program-folder copy is left alone. Returns what moved. */
export function moveUserRooms(root: string, shippedDir: string, userDir: string, log: (s: string) => void = () => {}): string[] {
  if (path.resolve(shippedDir) === path.resolve(userDir)) return [];
  const shipped = shippedRoomIds(root);
  if (!shipped) return [];
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(shippedDir, { withFileTypes: true }); } catch { return []; }
  const moved: string[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !ROOM_FOLDER.test(d.name) || shipped.has(d.name)) continue;
    const from = path.join(shippedDir, d.name), to = path.join(userDir, d.name);
    if (fs.existsSync(to)) { log(`[rooms] ${d.name}: already in your rooms folder; the copy in the program folder was left as is`); continue; }
    try {
      fs.mkdirSync(userDir, { recursive: true });
      try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true, errorOnExist: true }); fs.rmSync(from, { recursive: true, force: true }); }
      moved.push(d.name);
    } catch (e) { log(`[rooms] could not move ${d.name} to your rooms folder: ${(e as Error).message}`); }
  }
  if (moved.length) log(`[rooms] moved ${moved.length} of your room(s) out of the program folder into ${userDir}: ${moved.join(', ')}`);
  return moved;
}

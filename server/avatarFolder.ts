// import_model (server/mcpTools.ts) for a model a creator script built (blender/human_creator, blender/anime_creator): the
// script writes a folder with the model, a profile.json (eye and mouth anchors, brows, hair spring chains, tracking tuning,
// the look) and costumes/*.glb. The import routes take the model file alone, so a plain import would give an avatar with a
// default profile and no outfits, and say nothing. This carries the rest over with the routes that already exist (a model
// import, the costume import, a profile save), so it works with any helper, and reports what came along.
import fs from 'node:fs/promises';
import path from 'node:path';

/** A call to the helper's API, as server/mcpTools.ts `api` (raw = a binary body). */
export type HelperCall = <T = any>(method: string, p: string, body?: unknown, raw?: Buffer) => Promise<T>;
type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** What the import makes itself (the name is the one the import was given: the AI's, else the profile's), or keeps in the build
 *  folder: never copied from the creator's profile. `creator` points at
 *  params.json of the build folder; `source` and `shipped` are the helper's to decide (the user's own avatar is never builtin). */
const OWN_KEYS = new Set(['id', 'name', 'modelFile', 'thumbnail', 'source', 'shipped', 'createdAt', 'modelStats', 'version', 'creator', 'costumes', 'costume', 'accessories']);

/** The profile.json a creator script wrote next to this model file, when it names this very file (a profile of another model
 *  in the same folder, or any other app's profile.json, is not ours to carry). null = a plain model file. */
export async function readCreatorProfile(modelFile: string): Promise<Json | null> {
  try {
    const f = path.join(path.dirname(modelFile), 'profile.json');
    const st = await fs.stat(f);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const j = JSON.parse(await fs.readFile(f, 'utf8')) as unknown;
    return isObj(j) && j.version === 1 && j.modelFile === path.basename(modelFile) ? j : null;
  } catch { return null; }
}

/** <dir>/<rel> when it stays inside <dir> and is a .glb; null for anything else (a `..`, an absolute path, another type). */
function inside(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || path.extname(rel).toLowerCase() !== '.glb') return null;
  const full = path.resolve(dir, rel), root = path.resolve(dir);
  return full.startsWith(root + path.sep) ? full : null;
}

export interface Carried {
  /** The profile's settings (eyes, mouth, hair chains, tracking ...) were saved onto the new avatar. */
  profile: boolean;
  /** The outfits that were added (the new avatar's own costume ids). */
  costumes: string[];
  /** Plain sentences for anything that did not come along. */
  warnings: string[];
}

/** Carry the creator's profile settings and costumes onto the avatar the model import just made. Never throws: a part that
 *  fails is a warning, the avatar stays (with what did arrive). `dir` = the folder the model and profile.json are in. */
export async function carryCreatorProfile(call: HelperCall, avatarId: string, dir: string, prof: Json): Promise<Carried> {
  const out: Carried = { profile: false, costumes: [], warnings: [] };
  const enc = encodeURIComponent(avatarId);
  const made: { def: Json; id: string }[] = [];
  for (const def of Array.isArray(prof.costumes) ? prof.costumes.filter(isObj) : []) {
    const label = String(def.name ?? def.id ?? 'outfit').slice(0, 80);
    const full = inside(dir, def.file);
    if (!full) { out.warnings.push(`${label}: its file is not a .glb inside the build folder, so it was skipped`); continue; }
    let buf: Buffer;
    try { buf = await fs.readFile(full); } catch { out.warnings.push(`${label}: its file ${String(def.file)} is missing, so it was skipped`); continue; }
    try {
      const q = new URLSearchParams({ filename: path.basename(full), name: label });
      const r = await call<{ costume?: { id?: string }; warnings?: string[] }>('POST', `/api/avatars/${enc}/costumes/import?${q}`, undefined, buf);
      if (r?.costume?.id) made.push({ def, id: r.costume.id });
      for (const w of r?.warnings ?? []) out.warnings.push(`${label}: ${w}`);
    } catch (e) { out.warnings.push(`${label}: could not be added (${(e as Error).message})`); }
  }
  out.costumes = made.map((m) => m.id);
  try {
    const cur = await call<Json>('GET', `/api/avatars/${enc}`);
    const byId = new Map(made.map((m) => [m.id, m.def]));
    // an outfit keeps what the creator said about it (which body meshes it hides, the fit), under the id and file the helper made
    const costumes = (Array.isArray(cur.costumes) ? cur.costumes : []).map((c: Json) => {
      const def = byId.get(c.id);
      if (!def) return c;
      const { id: _id, file: _file, thumbnail: _thumb, source: _source, ...kept } = def;
      return { ...kept, id: c.id, file: c.file, ...(c.thumbnail ? { thumbnail: c.thumbnail } : {}), source: 'import' };
    });
    const patch = Object.fromEntries(Object.entries(prof).filter(([k]) => !OWN_KEYS.has(k)));
    await call('PUT', `/api/avatars/${enc}`, { ...cur, ...patch, costumes });
    out.profile = true;
  } catch (e) {
    out.warnings.push(`its profile settings (eyes, mouth, hair, tracking) were not saved (${(e as Error).message}); use update_avatar with the values from ${path.join(dir, 'profile.json')}`);
  }
  return out;
}

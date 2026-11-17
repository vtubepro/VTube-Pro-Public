// Picture-per-state PNGTuber saves (veadotube mini, and any save that keeps whole pictures per look instead of layers):
// find every picture stored inside the file, group them by the look (state) they sit in, and give each its role (mouth
// closed / mouth open / eyes closed / both) from the name of the field it is stored in, else from its order.
//
// [unknown] The veadotube file layout was not available when this was written. This reads it generically: any picture
// (base64 / data: URI / byte list) found anywhere in the JSON, grouped by the object that holds it, named by that object's
// name / title / label. If a real file groups things differently the result is still a set of pictures with sensible
// roles, and the "needs a real save" list in docs/b16/PNGTUBER.md says what to compare.
import { sniffImageMime } from '../gltf.ts';
import { pictureRole } from '../../flatImport.ts';
import { bytesOf, norm, type Json } from './godot.ts';
import { ROLES, type Converted, type Look, type Pic, type Role } from './layers.ts';

const extOf = (b: Uint8Array): Pic['ext'] | null => {
  const m = sniffImageMime(b);
  return m === 'image/png' ? 'png' : m === 'image/jpeg' ? 'jpg' : m === 'image/gif' ? 'gif' : m === 'image/webp' ? 'webp' : null;
};
const THUMB = /thumb|preview|icon|avatar$|cover|poster/i;
const NAME_KEYS = ['name', 'title', 'label', 'statename', 'id'];

interface Found { path: (string | number)[]; key: string; bytes: Uint8Array; ext: Pic['ext'] }

function harvest(root: Json): { found: Found[]; owners: Map<string, Record<string, Json>> } {
  const found: Found[] = [], owners = new Map<string, Record<string, Json>>();
  let nodes = 0;
  const walk = (v: Json, path: (string | number)[], parent: Record<string, Json> | null, key: string) => {
    if (++nodes > 200_000 || path.length > 12) return;
    if (v instanceof Uint8Array || typeof v === 'string' || (Array.isArray(v) && v.length >= 16 && typeof v[0] === 'number')) {
      const b = bytesOf(v), e = b ? extOf(b) : null;
      if (b && e) { found.push({ path, key, bytes: b, ext: e }); }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path, i], parent, key)); return; }
    if (v && typeof v === 'object') {
      owners.set(path.join('/'), v as Record<string, Json>);
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k], v as Record<string, Json>, k);
    }
  };
  walk(root, [], null, '');
  return { found, owners };
}

/** Pictures grouped into looks. */
export function readStates(root: Json): Converted | { error: string } {
  const { found, owners } = harvest(root);
  const real = found.filter((f) => !THUMB.test(f.key) && !f.path.some((p) => typeof p === 'string' && THUMB.test(p)));
  const pics = real.length ? real : found;
  if (!pics.length) return { error: 'There are no pictures inside this save.' };

  // the group of a picture = the object that holds it (when the picture sits in a list, the object that holds the list)
  const groups = new Map<string, Found[]>();
  for (const f of pics) {
    const last = f.path[f.path.length - 1];
    const up = typeof last === 'number' ? f.path.slice(0, -2) : f.path.slice(0, -1);
    const k = up.join('/');
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  const warnings: string[] = [], notes: string[] = [];
  const looks: Look[] = [];
  let guessed = false, n = 0;
  for (const [k, list] of groups) {
    if (looks.length >= 10) { warnings.push('Only the first 10 looks were brought over.'); break; }
    const roles = new Map<Role, Found>();
    const loose: Found[] = [];
    for (const f of list) {
      const arrKey = typeof f.path[f.path.length - 1] === 'number' ? String(f.path[f.path.length - 2] ?? '') : f.key;
      const r = pictureRole(arrKey.replace(/[0-9]+$/, '')) ?? pictureRole(f.key);
      if (r && !roles.has(r)) roles.set(r, f); else loose.push(f);
    }
    if (!roles.has('idle') && loose.length) roles.set('idle', loose.shift()!);
    if (loose.length) {
      // no names to go by: in order, idle / talk / blink / both
      guessed = true;
      for (const r of ROLES) if (!roles.has(r) && loose.length) roles.set(r, loose.shift()!);
    }
    if (!roles.has('idle')) { const first = [...roles.values()][0]; if (!first) continue; roles.set('idle', first); }
    const owner = owners.get(k) as Record<string, Json> | undefined;
    let name = '';
    if (owner) for (const [kk, v] of Object.entries(owner)) if (NAME_KEYS.includes(norm(kk)) && typeof v === 'string' && v.trim() && !name) name = v.trim();
    n++;
    const out: Look['pics'] = {};
    for (const [r, f] of roles) out[r] = { bytes: f.bytes, ext: f.ext };
    looks.push({ name: name.slice(0, 40) || `Look ${n}`, pics: out });
  }
  if (!looks.length) return { error: 'None of the pictures in this save could be used.' };
  if (guessed) warnings.push('Some pictures had no name saying mouth open or eyes closed, so they were matched by their order: check the mouth opens on the right one.');
  if (!looks[0].pics.talk) warnings.push('No “mouth open” picture was found, so the picture will hop while you talk.');
  return { source: 'veadotube', looks, warnings, notes };
}

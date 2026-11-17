// Finding the files a Live2D model's .model3.json names, in a real user's upload: the names in the JSON and the names in
// the zip rarely agree exactly. Tried in order:
//   1. the exact path;
//   2. the same ignoring case, Unicode normalisation (macOS zips are NFD) and backslashes (also URL-decoded);
//   3. FALLBACK — the file name anywhere in the upload (an absolute path from the artist's PC, a renamed folder, a name
//      mangled by a zip tool's code page), then pictures with another picture extension (.png asked, .jpg there).
// Fallback rules (documented, never alphabetical):
//   - a file that belongs to ANOTHER model of the upload is never used: a file belongs to the model whose
//     .model3.json sits in the deepest folder above it (descendant folders included);
//   - among the rest the winner shares the most folders with the wanted path, then is not in a backup-like folder
//     (old, backup, bak, copy, unused, archive, wip, test), then sits higher up; if the best two still tie, the file
//     is ambiguous: nothing is picked, and `ambiguous` says which candidates (the importer asks the user in one plain
//     sentence to keep only the right one).
// Pure; tests: tools/live2d_chaos_unit.ts.

const key = (p: string) => p.normalize('NFC').replace(/\\/g, '/').toLowerCase();
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (k: string) => k.slice(0, k.lastIndexOf('/') + 1);
const IMG = /\.(png|jpe?g|webp)$/i;
const BACKUP = /(^|\/)[^/]*(old|backup|bak|copy|unused|archive|wip|test)[^/]*\//i;

export interface Live2DResolver {
  /** The upload path for a wanted path (relative to the upload root) of the model in folder `near`, or null. */
  find(wanted: string, near?: string): string | null;
  /** Every upload path (forward slashes). */
  readonly paths: readonly string[];
  /** Wanted paths the fallback found more than one equally good file for (wanted → candidates). */
  readonly ambiguous: Map<string, string[]>;
}

export function makeResolver(paths: Iterable<string>): Live2DResolver {
  const all = [...paths];
  const exact = new Set(all);
  const byKey = new Map<string, string[]>(), byName = new Map<string, string[]>(), byStem = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const p of all) {
    const k = key(p);
    push(byKey, k, p);
    push(byName, base(k), p);
    if (IMG.test(k)) push(byStem, base(k).replace(IMG, ''), p);
  }
  // folders that hold a .model3.json ('' = the upload's top level), deepest first
  const modelDirs = [...new Set(all.filter((p) => /\.model3\.json$/i.test(p)).map((p) => dirOf(key(p))))].sort((a, b) => b.length - a.length);
  /** the model folder a file belongs to (the deepest model folder above it), or null when none is */
  const owner = (k: string) => modelDirs.find((d) => k.startsWith(d)) ?? null;
  const common = (a: string, b: string) => { const x = a.split('/'), y = b.split('/'); let i = 0; while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++; return i; };
  const ambiguous = new Map<string, string[]>();

  /** exact-name matches (step 2): an explicit reference, any folder */
  const pickExact = (list: string[] | undefined, t: string): string | null => {
    if (!list?.length) return null;
    if (list.length === 1) return list[0];
    const exactCase = list.find((p) => p.normalize('NFC') === t.normalize('NFC'));
    return exactCase ?? rank(list, key(t), t);
  };
  /** the fallback (step 3): candidates of this model only, one clear winner */
  const pickFallback = (list: string[] | undefined, wantedKey: string, near: string, wanted: string): string | null => {
    if (!list?.length) return null;
    const nk = near ? key(near).replace(/\/?$/, '/') : '';
    const own = modelDirs.includes(nk) ? nk : owner(nk);
    const pool = list.filter((p) => { const o = owner(key(p)); return o === null || o === own; });
    if (!pool.length) return null;
    return rank(pool, wantedKey, wanted);
  };
  const score = (p: string, wantedKey: string): [number, number, number] => { const k = key(p); return [common(k, wantedKey), BACKUP.test(k) ? 0 : 1, -k.split('/').length]; };
  const rank = (pool: string[], wantedKey: string, wanted: string): string | null => {
    if (pool.length === 1) return pool[0];
    const scored = pool.map((p) => ({ p, s: score(p, wantedKey) })).sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || b.s[2] - a.s[2]);
    const [a, b] = scored;
    if (a.s[0] === b.s[0] && a.s[1] === b.s[1] && a.s[2] === b.s[2]) { ambiguous.set(wanted, scored.filter((x) => x.s.every((v, i) => v === a.s[i])).map((x) => x.p)); return null; }
    return a.p;
  };
  return {
    paths: all,
    ambiguous,
    find(wanted: string, near = '') {
      if (!wanted) return null;
      if (exact.has(wanted)) return wanted;
      const w = wanted.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
      if (exact.has(w)) return w;
      const tries = [w];
      if (/%[0-9a-f]{2}/i.test(w)) { try { tries.push(decodeURIComponent(w)); } catch { /* not URL-encoded */ } }
      for (const t of tries) { const hit = pickExact(byKey.get(key(t)), t); if (hit) return hit; }
      for (const t of tries) { const hit = pickFallback(byName.get(base(key(t))), key(t), near, wanted); if (hit) return hit; }
      if (IMG.test(w)) { const st = base(key(w)).replace(IMG, ''); const hit = pickFallback(byStem.get(st), key(w), near, wanted); if (hit) return hit; }
      return null;
    },
  };
}

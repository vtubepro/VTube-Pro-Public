// 2D avatar import: what an upload (a set of pictures, or a .zip of another kind's model folder) contains, checked before
// anything is written. Pure: the server route (server/routes/avatars.ts POST /api/avatars/import-flat) and the studio's
// import dialog (src/ui/flatPanel.ts) both run it. Tests: tools/flat_unit.ts.
import { defaultFlatConfig, safeRel, type FlatAvatarConfig, type FlatPngState } from './flatAvatar.ts';
import { IMPORT_LIMITS } from './rig2d/limits.ts';

export interface FlatUploadFile { path: string; size: number; /** the first bytes (>= 16) for the format check */ head?: Uint8Array }

/** (the numbers live in shared/rig2d/limits.ts IMPORT_LIMITS: raise them there) */
export const FLAT_LIMITS = { files: IMPORT_LIMITS.files, total: IMPORT_LIMITS.unpackedBytes, image: IMPORT_LIMITS.entryBytes, moc: IMPORT_LIMITS.entryBytes, json: IMPORT_LIMITS.jsonBytes };
export const FLAT_IMAGE_EXT = ['.png', '.apng', '.gif', '.webp', '.jpg', '.jpeg'];
/** Accept string for the studio's file pickers. */
export const FLAT_ACCEPT = '.zip,.png,.apng,.gif,.webp,.jpg,.jpeg,.json,.moc3,.vtp2,.inp,.inx';

export type ImageFormat = 'png' | 'gif' | 'webp' | 'jpeg';
/** Image format from the magic bytes (null = not a picture we take). */
export function sniffImage(b: Uint8Array | undefined): ImageFormat | null {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}
/** A .moc3 starts with 'MOC3'. */
export const isMoc3 = (b: Uint8Array | undefined) => !!b && b.length >= 4 && b[0] === 0x4d && b[1] === 0x4f && b[2] === 0x43 && b[3] === 0x33;

const ext = (p: string) => { const m = /\.[^./]+$/.exec(p.toLowerCase()); return m ? m[0] : ''; };
const base = (p: string) => p.split('/').pop() ?? p;
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '');
/** The folder part of an upload path (with its trailing slash; empty at the top level). */
export const uploadDir = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

/** Zip entries that are never part of a model (OS junk). */
export const isJunk = (p: string) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(p) || /(^|\/)\._/.test(p);

/** Normalise one upload path: forward slashes, no leading './' — null when unsafe (absolute, '..', dot folders). */
export function cleanUploadPath(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return safeRel(s, 300);
}

// ---------------------------------------------------------------- picture roles from file names
const ROLE_WORDS: [RegExp, 'idle' | 'talk' | 'blink' | 'talkBlink'][] = [
  [/(talk|open|speak|loud|mouth[_ -]?open)[^a-z]*(blink|closed[_ -]?eyes|eyes[_ -]?closed)|(blink|eyes[_ -]?closed)[^a-z]*(talk|open|speak)/i, 'talkBlink'],
  [/(^|[^a-z])(blink|eyes[_ -]?closed|closed[_ -]?eyes)([^a-z]|$)/i, 'blink'],
  [/(^|[^a-z])(talk|talking|speak|speaking|open|mouth[_ -]?open|loud|on)([^a-z]|$)/i, 'talk'],
  [/(^|[^a-z])(idle|closed|quiet|silent|default|neutral|base|mouth[_ -]?closed|off|normal)([^a-z]|$)/i, 'idle'],
];
const ROLE_STRIP = /(^|[_\- .])(talk|talking|speak|speaking|open|mouth[_ -]?open|loud|idle|closed|quiet|silent|default|neutral|base|mouth[_ -]?closed|blink|eyes[_ -]?closed|closed[_ -]?eyes|on|off|normal)(?=$|[_\- .])/gi;
/** The role a picture's name suggests. */
export function pictureRole(name: string): 'idle' | 'talk' | 'blink' | 'talkBlink' | null {
  const s = stem(name).replace(/([a-z])([A-Z])/g, '$1_$2');
  for (const [re, role] of ROLE_WORDS) if (re.test(s)) return role;
  return null;
}
/** The state a picture belongs to ('' = the default state): its name without the role words ("happy_talk" → happy). */
export function pictureState(name: string): string {
  const s = stem(name).replace(/([a-z])([A-Z])/g, '$1_$2').replace(ROLE_STRIP, '$1').replace(/[_\- .]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return /^\d+$/.test(s) ? '' : s;
}

export interface PngPlan {
  kind: 'png';
  idle: string; talk?: string; blink?: string; talkBlink?: string;
  states: FlatPngState[];
  warnings: string[];
}
/** Assign idle / talk / blink (+ expression states) to a set of pictures by their names. Two unnamed pictures = idle
 *  + talk in name order; one = idle only (it hops while talking). */
/** `roles`: roles the studio worked out from how the pictures look (shared/flatSimilarity.ts), by upload path; a file name
 *  that says its role wins over them. */
export function planPictures(files: string[], roles: Record<string, string> = {}): PngPlan | { error: string } {
  const pics = files.filter((f) => FLAT_IMAGE_EXT.includes(ext(f))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!pics.length) return { error: 'No pictures found (PNG, GIF, WebP, APNG or JPEG).' };
  const warnings: string[] = [];
  const groups = new Map<string, Partial<Record<'idle' | 'talk' | 'blink' | 'talkBlink', string>>>();
  const loose: string[] = [];
  for (const f of pics) {
    const named = pictureRole(f);
    const guess = roles[f] ?? roles[base(f)];
    const role = named ?? (guess === 'idle' || guess === 'talk' || guess === 'blink' || guess === 'talkBlink' ? guess : null);
    if (!role) { loose.push(f); continue; }
    const st = named ? pictureState(f) : '';   // (a guessed role: the default look)
    const g = groups.get(st) ?? {};
    if (g[role]) warnings.push(`Two "${role}" pictures for ${st || 'the default look'}: using ${base(g[role]!)}, not ${base(f)}`);
    else g[role] = f;
    groups.set(st, g);
  }
  let def = groups.get('') ?? (groups.size === 1 && !loose.length ? [...groups.values()][0] : undefined);
  if (def && groups.size === 1) groups.clear(); else groups.delete('');
  if (!def || !def.idle) {
    // no names to go by: the loose pictures in name order
    const d = { ...def };
    if (!d.idle && loose.length) d.idle = loose.shift();
    if (!d.talk && loose.length && !d.idle?.match(/talk/i)) d.talk = loose.shift();
    if (!d.idle && d.talk) { d.idle = d.talk; delete d.talk; warnings.push('No idle (mouth closed) picture: the talking one is used for both.'); }
    def = d;
  }
  if (!def.idle) return { error: 'Could not tell which picture is the idle one: name it idle.png (and the talking one talk.png).' };
  for (const f of loose) warnings.push(`Not used (name it idle / talk / blink): ${base(f)}`);
  const states: FlatPngState[] = [];
  let n = 0;
  for (const [st, g] of groups) {
    if (!g.idle) { if (g.talk) { g.idle = g.talk; } else { warnings.push(`State "${st}" has no idle picture: skipped`); continue; } }
    const id = st.replace(/[^a-z0-9_-]/g, '').slice(0, 40) || `state${++n}`;
    states.push({ id, name: st.replace(/_/g, ' ').slice(0, 40), idle: g.idle, ...(g.talk ? { talk: g.talk } : {}), ...(g.blink ? { blink: g.blink } : {}), ...(g.talkBlink ? { talkBlink: g.talkBlink } : {}),
      ...(states.length < 9 ? { key: `Digit${states.length + 1}` } : {}) });
  }
  if (!def.talk) warnings.push('No talking picture: the idle picture hops while you talk.');
  return { kind: 'png', idle: def.idle, ...(def.talk ? { talk: def.talk } : {}), ...(def.blink ? { blink: def.blink } : {}), ...(def.talkBlink ? { talkBlink: def.talkBlink } : {}), states, warnings };
}

// ---------------------------------------------------------------- other kinds (Live2D, Inochi2D …) plug in here
/** What an importer made of an upload: the main file and every file to keep (upload paths), stored relative to
 *  `root`; `opts` = the kind's own settings (FlatAvatarConfig.opts). */
export interface FlatImportPlan { kind: string; root: string; main: string; keep: string[]; opts?: Record<string, unknown>; warnings: string[] }
export interface FlatImporter {
  kind: string;
  /** Does this upload look like this kind's model (file names only)? The first importer that says yes plans it. */
  detect(paths: string[]): boolean;
  plan(files: FlatUploadFile[], readJson: (path: string) => unknown): FlatImportPlan | { error: string };
  /** Optional: turn the upload into the files actually stored (e.g. a Live2D folder → one .vtp2). Runs on the server
   *  after plan(); `files` = every upload file by normalised path. Throws an Error with one plain sentence on failure. */
  convert?(files: ReadonlyMap<string, Uint8Array>, plan: FlatImportPlan): FlatConvertOut | Promise<FlatConvertOut>;
}
export interface FlatConvertOut { main: string; files: [string, Uint8Array][]; kind?: string; warnings?: string[] }
const importers: FlatImporter[] = [];
/** Register another kind's import check (from its shared/ module, imported by shared/flatKinds.ts so the server and
 *  the studio both see it). */
export function registerFlatImporter(i: FlatImporter) { if (!importers.some((x) => x.kind === i.kind)) importers.push(i); }
export const flatImporters = (): readonly FlatImporter[] => importers;
export const flatImporterFor = (kind: string): FlatImporter | undefined => importers.find((i) => i.kind === kind);

export type FlatPlan = (PngPlan & { files: string[] }) | (FlatImportPlan & { files: string[] });

/** What an upload is, with every check that needs no decoding: sizes, file types, paths, the kind's own checks. */
export function planFlatUpload(raw: FlatUploadFile[], readJson: (path: string) => unknown, roles: Record<string, string> = {}): FlatPlan | { error: string } {
  const files: FlatUploadFile[] = [];
  let total = 0;
  for (const f of raw) {
    if (isJunk(f.path) || f.path.endsWith('/')) continue;
    const p = cleanUploadPath(f.path);
    if (!p) return { error: `Unsafe file name in the upload: ${f.path.slice(0, 80)}` };
    files.push({ ...f, path: p });
    total += f.size;
  }
  if (!files.length) return { error: 'The upload is empty.' };
  if (files.length > FLAT_LIMITS.files) return { error: `Too many files (${files.length}; at most ${FLAT_LIMITS.files}).` };
  if (total > FLAT_LIMITS.total) return { error: `The upload is too big (${Math.round(total / 1048576)} MB; at most ${FLAT_LIMITS.total >> 20} MB).` };
  for (const f of files) {
    const e = ext(f.path);
    if (FLAT_IMAGE_EXT.includes(e) && f.size > FLAT_LIMITS.image) return { error: `${base(f.path)} is over ${FLAT_LIMITS.image >> 20} MB.` };
    // (only the model's main JSON is read here; big motion / physics files are the converter's business)
    if (/\.model3?\.json$/i.test(f.path) && f.size > FLAT_LIMITS.json) return { error: `${base(f.path)} is over ${FLAT_LIMITS.json >> 20} MB.` };
  }
  const paths = files.map((f) => f.path);
  const imp = importers.find((i) => i.detect(paths));
  if (imp) {
    const p = imp.plan(files, readJson);
    if ('error' in p) return p;
    const keep = new Set(p.keep);
    return { ...p, files: paths.filter((x) => keep.has(x)) };
  }
  if (files.some((f) => /\.(model3?\.json|moc3?|inp|inx)$/i.test(f.path))) return { error: 'This looks like a model from another 2D app (.model3.json / .inx): importing it is not available in this version yet.' };
  for (const f of files) {
    if (!FLAT_IMAGE_EXT.includes(ext(f.path))) continue;
    if (f.head && !sniffImage(f.head)) return { error: `${base(f.path)} is not a picture we can read (PNG, GIF, WebP, APNG, JPEG).` };
  }
  const p = planPictures(paths, roles);
  if ('error' in p) return p;
  const used = new Set([p.idle, p.talk, p.blink, p.talkBlink, ...p.states.flatMap((s) => [s.idle, s.talk, s.blink, s.talkBlink])].filter((x): x is string => !!x));
  return { ...p, files: [...used] };
}

/** Where each kept upload file goes in the avatar folder (other kinds: relative to their root; pictures: their base
 *  names, de-duplicated) + the profile's flat config and main file. */
export function flatLayout(plan: FlatPlan): { map: [from: string, to: string][]; config: FlatAvatarConfig; modelFile: string } {
  if (plan.kind !== 'png' || !('idle' in plan)) {
    const p = plan as FlatImportPlan & { files: string[] };
    const map = p.files.map((f): [string, string] => [f, f.startsWith(p.root) ? f.slice(p.root.length) : f]);
    const cfg = defaultFlatConfig(p.kind, p.main);
    if (p.opts) cfg.opts = p.opts;
    return { map, config: cfg, modelFile: p.main };
  }
  const names = new Map<string, string>();
  const taken = new Set<string>(['profile.json', 'thumb.png']);
  for (const f of plan.files) {
    let b = base(f).replace(/[^A-Za-z0-9_. -]/g, '_').replace(/^\.+/, '_');
    if (taken.has(b.toLowerCase())) { const s = b.replace(/(\.[^.]+)$/, ''), e2 = ext(b); let i = 2; while (taken.has(`${s}_${i}${e2}`.toLowerCase())) i++; b = `${s}_${i}${e2}`; }
    taken.add(b.toLowerCase()); names.set(f, b);
  }
  const n = (f: string | undefined) => (f ? names.get(f) : undefined);
  const cfg = defaultFlatConfig('png', n(plan.idle)!);
  const png = cfg.png!;
  if (plan.talk) png.talk = n(plan.talk);
  if (plan.blink) png.blink = n(plan.blink);
  if (plan.talkBlink) png.talkBlink = n(plan.talkBlink);
  png.states = plan.states.map((s) => ({ ...s, idle: n(s.idle)!, ...(s.talk ? { talk: n(s.talk) } : {}), ...(s.blink ? { blink: n(s.blink) } : {}), ...(s.talkBlink ? { talkBlink: n(s.talkBlink) } : {}) }));
  return { map: [...names.entries()], config: cfg, modelFile: png.idle };
}

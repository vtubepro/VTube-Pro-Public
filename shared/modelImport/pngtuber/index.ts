// "Bring your PNGTuber over" (beta.16, docs/b16/PNGTUBER.md): a PNGTuber Plus / Remix save, a veadotube mini save or a
// VTube Studio model file dropped on the studio becomes
//   * a PNGTuber picture set (idle / talk / blink / talk+blink, one set per costume) that goes through the ordinary
//     2D-avatar import (the pictures are named the way shared/flatImport.ts planPictures reads them), and
//   * reaction rules from a VTube Studio .vtube.json (shared/rig2d/vtsImport.ts), always switched off.
// Everything here is pure (no DOM, no network, no disk): the studio's drop screen and tools/pngtuber_import_unit.ts
// call the same functions. Written from the formats' descriptions, never from another project's code.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import type { DroppedFile } from '../files.ts';
import { vtsHotkeysToRules, vtsRulesFile, type VtsRulesResult } from '../../rig2d/vtsImport.ts';
import { readSave } from './godot.ts';
import { baseName, sniffPngTuber, type PngTuberKind } from './detect.ts';
import { flattenLayered, ROLES, type Converted, type LayerDeps, type Look, type Pic, type Role } from './layers.ts';
import { readStates } from './states.ts';

export { sniffPngTuber, type PngTuberKind } from './detect.ts';

const nameOf = baseName;

const WANT = /\.(save|pngtp|pngremix|veadomini|veado|veadotube)$|\.vtube\.json$/i;
const MAX_SAVE = 400 << 20;
/** Zips (one level) opened for just the files we read; everything else stays packed. */
function expand(input: readonly DroppedFile[]): DroppedFile[] {
  const out: DroppedFile[] = [];
  for (const f of input) {
    const b = f.bytes;
    if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5)) {
      try {
        const got = unzipSync(b, { filter: (z) => WANT.test(z.name) && z.originalSize < MAX_SAVE });
        const base = f.path.replace(/\.[^.]+$/, '');
        for (const [p, bytes] of Object.entries(got)) out.push({ path: `${base}/${p}`, bytes });
      } catch { /* a damaged zip: nothing found */ }
    } else out.push(f);
  }
  return out;
}

export interface ImportedLook {
  /** Shown to the performer ("Look 2", or the state's own name). */
  name: string;
  /** The key that switches to this look in the studio (a digit; the first look is the normal one and has none). */
  key?: string;
  /** The pictures it has. */
  roles: Role[];
  /** For the preview. */
  preview: Pic;
}
export interface PngTuberImport {
  avatar: null | {
    source: Converted['source'];
    /** The avatar's name (the save file's name). */
    name: string;
    looks: ImportedLook[];
    /** The pictures, named for the PNGTuber set import (paths start with a folder named like the avatar). */
    files: DroppedFile[];
  };
  rules: VtsRulesResult | null;
  /** The .vtprules.json text for `rules` (null when none). */
  rulesFile: string | null;
  warnings: string[];
  notes: string[];
  /** One plain sentence when a save was found but could not be used. */
  problem?: string;
}

const ROLE_FILE: Record<Role, string> = { idle: 'idle', talk: 'talk', blink: 'blink', talkBlink: 'talk_blink' };
const ROLE_WORDS = /(^|[_\- .])(talk|talking|speak|speaking|open|opened|mouth|loud|idle|closed|quiet|silent|default|neutral|base|blink|eyes|on|off|normal)(?=$|[_\- .])/gi;

/** A file-name-safe word for a look's name that planPictures will read back as a state (never a role word, never only digits). */
export function lookSlug(name: string, i: number): string {
  const s = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(ROLE_WORDS, '$1').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return !s || /^\d+$/.test(s) ? `look_${i + 1}` : s;
}
const safeFolder = (s: string) => s.replace(/[^A-Za-z0-9 _.-]+/g, '').trim().slice(0, 40) || 'My PNGTuber';

/** Name the pictures like shared/flatImport.ts planPictures reads them: the first look is the normal one
 *  (idle / talk / blink / talk_blink); each other look is "<word>_idle" … and gets the next number key, in the order the
 *  import will list them. */
export function nameSet(looks: readonly Look[], avatarName: string): { files: DroppedFile[]; looks: ImportedLook[] } {
  const folder = safeFolder(avatarName);
  const files: DroppedFile[] = [], out: ImportedLook[] = [];
  const taken = new Set<string>();
  const extras: { look: Look; slug: string; at: number }[] = [];
  looks.forEach((look, i) => {
    if (i === 0) return;
    let slug = lookSlug(look.name, i), n = 2;
    while (taken.has(slug)) slug = `${lookSlug(look.name, i)}_${n++}`;
    taken.add(slug);
    extras.push({ look, slug, at: i });
  });
  // planPictures lists files in natural order and numbers the extra looks as they first appear
  const cmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  const firstFile = (x: { slug: string; look: Look }) => ROLES.filter((r) => x.look.pics[r]).map((r) => `${x.slug}_${ROLE_FILE[r]}.${x.look.pics[r]!.ext}`).sort(cmp)[0];
  const order = extras.slice().sort((a, b) => cmp(firstFile(a), firstFile(b)));
  const keyOf = new Map(order.map((x, i) => [x.look, i < 9 ? String(i + 1) : undefined]));
  looks.forEach((look, i) => {
    const slug = i === 0 ? '' : extras.find((x) => x.look === look)!.slug;
    const roles: Role[] = [];
    for (const r of ROLES) {
      const p = look.pics[r];
      if (!p) continue;
      roles.push(r);
      files.push({ path: `${folder}/${slug ? `${slug}_` : ''}${ROLE_FILE[r]}.${p.ext}`, bytes: p.bytes });
    }
    const key = i === 0 ? undefined : keyOf.get(look);
    out.push({ name: look.name, ...(key ? { key } : {}), roles, preview: look.pics.idle ?? look.pics[roles[0]]! });
  });
  return { files, looks: out };
}

/** Everything useful in a drop: a PNGTuber save -> a picture set, a VTube Studio model file -> rules. */
export async function convertPngTuberDrop(input: readonly DroppedFile[], deps: LayerDeps = {}): Promise<PngTuberImport> {
  const files = expand(input);
  const res: PngTuberImport = { avatar: null, rules: null, rulesFile: null, warnings: [], notes: [] };

  // reactions from the VTube Studio file (the first that has any)
  const vts = files.filter((f) => sniffPngTuber(f.path, f.bytes) === 'vts');
  const skippedAll: VtsRulesResult['skipped'] = [];
  for (const f of vts) {
    try {
      const j = JSON.parse(new TextDecoder().decode(f.bytes).replace(/^﻿/, ''));
      const r = vtsHotkeysToRules(j);
      skippedAll.push(...r.skipped);
      if (r.rules.length && !res.rules) { res.rules = r; res.rulesFile = vtsRulesFile(j, nameOf(f.path).replace(/\.vtube\.json$/i, '') || 'From VTube Studio'); }
    } catch { res.warnings.push(`${nameOf(f.path)} could not be read.`); }
  }
  if (res.rules) res.rules = { ...res.rules, skipped: skippedAll };
  else if (vts.length) res.rules = { rules: [], skipped: skippedAll, notes: [] };

  // the avatar from a save
  const saves = files.map((f) => ({ f, k: sniffPngTuber(f.path, f.bytes) })).filter((x): x is { f: DroppedFile; k: Exclude<PngTuberKind, 'vts'> } => !!x.k && x.k !== 'vts')
    .sort((a, b) => b.f.bytes.length - a.f.bytes.length);
  if (saves.length) {
    const { f, k } = saves[0];
    const app = k === 'plus' ? 'PNGTuber Plus' : k === 'remix' ? 'PNGTuber Remix' : 'veadotube';
    const root = readSave(f.bytes);
    let got: Converted | { error: string } = { error: '' };
    if (root) {
      got = k === 'veadotube' ? readStates(root) : await flattenLayered(root, k, deps);
      // a layered save with no sprite list, or a veadotube-style save that is really layers: try the other reader
      if ('error' in got && k !== 'veadotube') { const alt = readStates(root); if (!('error' in alt)) got = { ...alt, source: k }; }
      else if ('error' in got && k === 'veadotube') { const alt = await flattenLayered(root, 'veadotube', deps); if (!('error' in alt)) got = alt; }
    }
    if (!root || 'error' in got) {
      res.problem = `We couldn’t read this ${app} save${root && 'error' in got && got.error ? ` (${got.error.replace(/\.$/, '')})` : ''}. In ${app} you can save your pictures one by one; put them in a folder named idle, talk and blink (like “idle.png”, “talk.png”, “blink.png”) and drop that folder here instead.`;
    } else {
      const name = nameOf(f.path).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My PNGTuber';
      const set = nameSet(got.looks, name);
      res.avatar = { source: got.source, name: safeFolder(name), looks: set.looks, files: set.files };
      res.warnings.push(...got.warnings);
      res.notes.push(...got.notes);
    }
  }
  if (!res.avatar && !res.rules && !res.problem) res.problem = 'There is nothing in this drop to bring over (no PNGTuber save and no VTube Studio model file).';
  return res;
}

export { vtsHotkeysToRules, vtsRulesFile };

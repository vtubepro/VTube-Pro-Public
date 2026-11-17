// One entry point for every importer (the panel's "Import" buttons, the file watcher). All read-only.
import fs from 'node:fs';
import path from 'node:path';
import { parseRekordboxXml, importAnlzFolder } from './rekordbox.ts';
import { importEngine } from './engine.ts';
import { parseTraktorNml } from './traktorNml.ts';
import { importSerato } from './serato.ts';
import { parseVdjDatabase } from './vdj.ts';
import { importMixxx } from './mixxx.ts';
import type { TrackLibrary } from './store.ts';
import type { ImportedTrack, ImportKind, ImportResult } from './types.ts';

export interface ImportSettings { phrases: boolean; traktorMp3OffsetMs: number }
const MAX_TEXT = 256 << 20;
function readText(p: string): string {
  const st = fs.statSync(p);
  if (st.size > MAX_TEXT) throw new Error('That file is too big to be a DJ library export.');
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}
/** Import one library (a file or folder path) — read-only. */
export async function importAny(kind: ImportKind, where: string, s: ImportSettings, lib?: TrackLibrary): Promise<ImportResult> {
  if (!where || !fs.existsSync(where)) return { tracks: [], says: 'That file or folder isn’t there any more.', warnings: [] };
  switch (kind) {
    case 'rekordbox-xml': return parseRekordboxXml(readText(where));
    case 'rekordbox-anlz': {
      // the XML tracks we know already tell same-named analyses apart
      const known: ImportedTrack[] = lib ? [...lib.entries.values()].filter((e) => e.srcs.includes('rekordbox')).map((e) => {
        const a = lib.analysis(e.id);
        return { src: 'rekordbox' as const, base: e.base, ...(e.path ? { path: e.path } : {}), ...(e.durMs ? { durMs: e.durMs } : {}), part: { srcs: ['rekordbox' as const], ...(a?.grid ? { grid: a.grid } : {}) } };
      }) : [];
      const dir = fs.statSync(where).isDirectory() ? where : path.dirname(where);
      return importAnlzFolder(dir, known, { phrases: s.phrases });
    }
    case 'engine': return importEngine(where);
    case 'traktor': return parseTraktorNml(readText(where), { mp3OffsetMs: s.traktorMp3OffsetMs });
    case 'serato': return importSerato(where);
    case 'vdj': return parseVdjDatabase(readText(where));
    case 'mixxx': return importMixxx(where);
  }
}

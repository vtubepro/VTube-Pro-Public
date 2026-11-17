// Where DJ apps keep their libraries on this computer — looked at ONLY when the user presses "Find my DJ libraries"
// (never at start-up, never in the background). Tests point it at a fixture folder with VTP_DJLIB_HOME (then no other
// place, and no USB drive, is looked at).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImportKind } from './types.ts';

export interface FoundSource { kind: ImportKind; path: string; label: string; mtime: number }

function roots() {
  const fake = process.env.VTP_DJLIB_HOME;
  const home = fake || os.homedir();
  const win = process.platform === 'win32';
  return {
    home, fake: !!fake,
    appData: fake ? path.join(home, 'AppData', 'Roaming') : process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
    localAppData: fake ? path.join(home, 'AppData', 'Local') : process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
    docs: path.join(home, 'Documents'), music: path.join(home, 'Music'), win,
  };
}
const mt = (p: string) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };
const ls = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };

/** Every library found (newest first per kind). */
export function detectSources(): FoundSource[] {
  const r = roots(), out: FoundSource[] = [];
  const add = (kind: ImportKind, p: string, label: string) => { if (exists(p) && !out.some((o) => o.path === p)) out.push({ kind, path: p, label, mtime: mt(p) }); };
  // rekordbox: the exported collection XML (newest), and rekordbox's own analysis files
  for (const d of [r.docs, path.join(r.home, 'Desktop'), path.join(r.home, 'Downloads'), path.join(r.docs, 'rekordbox')]) {
    for (const f of ls(d)) if (/rekordbox.*\.xml$|^collection.*\.xml$/i.test(f)) add('rekordbox-xml', path.join(d, f), `rekordbox collection (${f})`);
  }
  add('rekordbox-anlz', r.win ? path.join(r.appData, 'Pioneer', 'rekordbox', 'share', 'PIONEER', 'USBANLZ') : path.join(r.home, 'Library', 'Pioneer', 'rekordbox', 'share', 'PIONEER', 'USBANLZ'), 'rekordbox’s analysis (phrases + waveforms)');
  add('engine', path.join(r.music, 'Engine Library', 'Database2', 'm.db'), 'Engine DJ library');
  for (const d of ls(path.join(r.docs, 'Native Instruments'))) if (/^Traktor/i.test(d)) add('traktor', path.join(r.docs, 'Native Instruments', d, 'collection.nml'), `${d} collection`);
  add('serato', path.join(r.music, '_Serato_'), 'Serato library');
  add('vdj', path.join(r.docs, 'VirtualDJ', 'database.xml'), 'VirtualDJ database');
  add('vdj', path.join(r.localAppData, 'VirtualDJ', 'database.xml'), 'VirtualDJ database');
  add('mixxx', r.win ? path.join(r.localAppData, 'Mixxx', 'mixxxdb.sqlite') : path.join(r.home, '.mixxx', 'mixxxdb.sqlite'), 'Mixxx library');
  if (!r.win) add('mixxx', path.join(r.home, 'Library', 'Containers', 'org.mixxx.mixxx', 'Data', 'Library', 'Application Support', 'Mixxx', 'mixxxdb.sqlite'), 'Mixxx library');
  // USB sticks / SD cards prepared for CDJs or Engine players (Windows drive letters; not in tests)
  if (r.win && !r.fake) {
    for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${L}:\\`;
      add('rekordbox-anlz', path.join(root, 'PIONEER', 'USBANLZ'), `USB drive ${L}: (rekordbox)`);
      add('engine', path.join(root, 'Engine Library', 'Database2', 'm.db'), `USB drive ${L}: (Engine DJ)`);
    }
  }
  // newest XML first; keep only the newest rekordbox XML (older exports are stale copies)
  const xml = out.filter((o) => o.kind === 'rekordbox-xml').sort((a, b) => b.mtime - a.mtime);
  return out.filter((o) => o.kind !== 'rekordbox-xml' || o === xml[0]);
}

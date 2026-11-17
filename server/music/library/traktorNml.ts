// Traktor Pro 3 / 4: collection.nml (Documents\Native Instruments\Traktor <version>\), read-only. Per ENTRY: the file
// (LOCATION VOLUME + DIR with "/:" separators + FILE), length (INFO PLAYTIME), tempo (TEMPO BPM), cues and the grid
// marker(s) (CUE_V2 TYPE 4, START in ms). Traktor grids are constant tempo from each marker. Traktor stores no phrases:
// those tracks get our own analysis. Some converters shift Traktor MP3 grids by ~26 ms (decoder start offsets): the
// `mp3OffsetMs` option applies such a shift; by default none (the audio matcher absorbs a small remainder).
import { baseName, type GridAnchor, type TrackCue } from '../../../shared/trackAnalysis.ts';
import { attrNum, walkXml } from './xml.ts';
import type { ImportedTrack, ImportResult } from './types.ts';

export function traktorPath(volume: string, dir: string, file: string): string {
  const d = dir.replace(/\/:/g, '/');
  const vol = /^[A-Za-z]:$/.test(volume) ? volume : volume ? `/Volumes/${volume}` : '';
  return `${vol}${d.startsWith('/') ? '' : '/'}${d}${d.endsWith('/') ? '' : '/'}${file}`.replace(/\/+/g, '/');
}

export function parseTraktorNml(src: string, o: { mp3OffsetMs?: number } = {}): ImportResult {
  const tracks: ImportedTrack[] = [];
  let cur: { t: ImportedTrack; grid: number[]; bpm: number; cues: TrackCue[] } | null = null;
  let inColl = false, sawRoot = false;
  const finish = () => {
    if (!cur) return;
    const { t, grid, bpm, cues } = cur;
    if (bpm > 0 && grid.length) {
      const off = /\.mp3$/i.test(t.base) ? (o.mp3OffsetMs ?? 0) : 0;
      const ms = grid.sort((a, b) => a - b);
      const anchors: GridAnchor[] = [{ ms: +(ms[0] + off).toFixed(3), beat: 0, bpm }];
      for (let i = 1; i < ms.length; i++) { const beat = Math.round((ms[i] - ms[0]) * bpm / 60000); if (beat > anchors[anchors.length - 1].beat) anchors.push({ ms: +(ms[i] + off).toFixed(3), beat, bpm }); }
      t.part.grid = { anchors, downbeat: 0, src: 'traktor' };
      t.part.bpm = bpm;
    }
    if (cues.length) t.part.cues = cues.sort((a, b) => a.ms - b.ms);
    tracks.push(t); cur = null;
  };
  walkXml(src, (tag, p) => {
    if (tag.name === 'NML') sawRoot = true;
    if (tag.name === 'COLLECTION') { inColl = true; return; }
    if (!inColl) return;
    if (tag.name === 'ENTRY' && p[p.length - 1] === 'COLLECTION') {
      finish();
      const t: ImportedTrack = { src: 'traktor', base: '', part: { srcs: ['traktor'] } };
      if (tag.attrs.TITLE) t.title = tag.attrs.TITLE.slice(0, 200);
      if (tag.attrs.ARTIST) t.artist = tag.attrs.ARTIST.slice(0, 200);
      cur = { t, grid: [], bpm: 0, cues: [] };
      return;
    }
    if (!cur) return;
    const a = tag.attrs;
    switch (tag.name) {
      case 'LOCATION': if (a.FILE) { cur.t.path = traktorPath(a.VOLUME ?? '', a.DIR ?? '', a.FILE); cur.t.base = baseName(a.FILE); } break;
      case 'INFO': { const s = attrNum(a, 'PLAYTIME_FLOAT'), s2 = attrNum(a, 'PLAYTIME'); const d = Number.isFinite(s) ? s : s2; if (d > 0) cur.t.durMs = d * 1000; break; }
      case 'TEMPO': { const b = attrNum(a, 'BPM'); if (b > 0) { cur.bpm = b; cur.t.bpm = b; } break; }
      case 'CUE_V2': {
        const type = attrNum(a, 'TYPE'), start = attrNum(a, 'START'), len = attrNum(a, 'LEN'), hot = attrNum(a, 'HOTCUE');
        if (!Number.isFinite(start)) break;
        if (type === 4) { cur.grid.push(start); break; }
        const kind: TrackCue['kind'] = type === 5 ? 'loop' : type === 1 ? 'fadein' : type === 2 ? 'fadeout' : type === 3 ? 'load' : hot >= 0 ? 'hot' : 'cue';
        const c: TrackCue = { ms: Math.round(start), kind };
        if (len > 0) c.end = Math.round(start + len);
        if (hot >= 0) c.n = hot;
        if (a.NAME && a.NAME !== 'n.n.') c.name = a.NAME.slice(0, 80);
        cur.cues.push(c);
        break;
      }
    }
  }, (name) => { if (name === 'ENTRY') finish(); if (name === 'COLLECTION') { finish(); inColl = false; } });
  finish();
  const ok = tracks.filter((t) => t.base);
  const g = ok.filter((t) => t.part.grid).length;
  return { tracks: ok, says: !sawRoot ? 'That file isn’t a Traktor collection (collection.nml).' : `${ok.length} track${ok.length === 1 ? '' : 's'} from Traktor (${g} with a beat grid).`, warnings: [] };
}

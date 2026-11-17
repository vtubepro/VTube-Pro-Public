// VirtualDJ: database.xml (in the VirtualDJ folder, Documents\VirtualDJ by default), read-only. Per <Song FilePath>:
// the tags, the length (Infos SongLength, seconds), the tempo (Scan Bpm = SECONDS PER BEAT, so BPM = 60 / value), the
// grid anchor (<Poi Type="beatgrid" Pos> — or, since VirtualDJ's "fluid beatgrids", Scan Phase, also in seconds) and
// cues / loops (<Poi>). VirtualDJ stores no phrase analysis: those tracks get our own.
import { baseName, type TrackCue } from '../../../shared/trackAnalysis.ts';
import { attrNum, walkXml } from './xml.ts';
import type { ImportedTrack, ImportResult } from './types.ts';

export function parseVdjDatabase(src: string): ImportResult {
  const tracks: ImportedTrack[] = [];
  let cur: { t: ImportedTrack; spb: number; anchor: number; phase: number; cues: TrackCue[] } | null = null;
  let sawRoot = false;
  const finish = () => {
    if (!cur) return;
    const { t, spb, anchor, phase, cues } = cur;
    const bpm = spb > 0 ? 60 / spb : 0;
    const first = Number.isFinite(anchor) ? anchor : phase;
    if (bpm > 20 && bpm < 400 && Number.isFinite(first)) {
      // the anchor may sit anywhere in the track: beat 0 = the earliest beat at or after the file start
      const per = spb * 1000;
      let ms = first * 1000; ms -= Math.floor(ms / per) * per;
      t.part.grid = { anchors: [{ ms: +ms.toFixed(3), beat: 0, bpm: +bpm.toFixed(4) }], downbeat: ((Math.round((first * 1000 - ms) / per) % 4) + 4) % 4, src: 'vdj' };   // (the anchor is a bar start)
      t.part.bpm = +bpm.toFixed(4);
    }
    if (bpm) t.bpm = +bpm.toFixed(3);
    if (cues.length) t.part.cues = cues.sort((a, b) => a.ms - b.ms);
    tracks.push(t); cur = null;
  };
  walkXml(src, (tag) => {
    if (tag.name === 'VirtualDJ_Database') { sawRoot = true; return; }
    if (tag.name === 'Song') {
      finish();
      const fp = tag.attrs.FilePath ?? '';
      if (!fp) return;
      cur = { t: { src: 'vdj', path: fp, base: baseName(fp), part: { srcs: ['vdj'] } }, spb: 0, anchor: NaN, phase: NaN, cues: [] };
      if (tag.empty) finish();
      return;
    }
    if (!cur) return;
    const a = tag.attrs;
    switch (tag.name) {
      case 'Tags': if (a.Title) cur.t.title = a.Title.slice(0, 200); if (a.Author) cur.t.artist = a.Author.slice(0, 200); break;
      case 'Infos': { const s = attrNum(a, 'SongLength'); if (s > 0) cur.t.durMs = s * 1000; break; }
      case 'Scan': { const b = attrNum(a, 'Bpm'), ph = attrNum(a, 'Phase'); if (b > 0) cur.spb = b; if (Number.isFinite(ph)) cur.phase = ph; break; }
      case 'Poi': {
        const pos = attrNum(a, 'Pos'), type = (a.Type ?? 'cue').toLowerCase();
        if (!Number.isFinite(pos)) break;
        if (type === 'beatgrid') { if (!Number.isFinite(cur.anchor)) cur.anchor = pos; break; }
        if (type === 'cue' || type === 'loop') {
          const num = attrNum(a, 'Num'), size = attrNum(a, 'Size');
          const c: TrackCue = { ms: Math.round(pos * 1000), kind: type === 'loop' ? 'loop' : num >= 1 ? 'hot' : 'cue' };
          if (num >= 1) c.n = num - 1;
          if (type === 'loop' && size > 0 && cur.spb > 0) c.end = Math.round((pos + size * cur.spb) * 1000);
          if (a.Name) c.name = a.Name.slice(0, 80);
          cur.cues.push(c);
        }
        break;
      }
    }
  }, (name) => { if (name === 'Song') finish(); });
  finish();
  const g = tracks.filter((t) => t.part.grid).length;
  return { tracks, says: !sawRoot ? 'That file isn’t a VirtualDJ database (database.xml).' : `${tracks.length} track${tracks.length === 1 ? '' : 's'} from VirtualDJ (${g} with a beat grid).`, warnings: [] };
}

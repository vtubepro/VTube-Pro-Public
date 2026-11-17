// What every DJ library importer hands the track library (server/music/library/store.ts).
import type { TrackAnalysis, TrackSrc } from '../../../shared/trackAnalysis.ts';
import type { StreamRef } from './streaming.ts';

export interface ImportedTrack {
  src: TrackSrc;
  /** The audio file's full path when the app knows it (rekordbox's local ANLZ only knows the file name). */
  path?: string;
  /** Lower-case file name (the key that ties the apps together). */
  base: string;
  title?: string; artist?: string;
  /** The version ("Original Mix", "Extended Remix"), when the app keeps it apart from the title (rekordbox's Mix). */
  mix?: string;
  durMs?: number; bpm?: number;
  /** A streaming track (Beatport, Spotify, …): no file, keyed by the service's id (streaming.ts). */
  stream?: StreamRef;
  /** The app's own id for the track (rekordbox TrackID, Engine id …). */
  ref?: string;
  /** What the app analysed: grid, phrases, cues, waveform. */
  part: Partial<TrackAnalysis> & { srcs: TrackSrc[] };
}
export interface ImportResult {
  tracks: ImportedTrack[];
  /** One plain sentence for the panel. */
  says: string;
  /** Problems worth showing (a file that couldn't be read …), at most a few. */
  warnings: string[];
  /** Sampler sounds / one-shots left out (not tracks). */
  samples?: number;
}
export const IMPORT_KINDS = ['rekordbox-xml', 'rekordbox-anlz', 'engine', 'traktor', 'serato', 'vdj', 'mixxx'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_LABEL: Record<ImportKind, string> = {
  'rekordbox-xml': 'rekordbox (exported collection XML)', 'rekordbox-anlz': 'rekordbox analysis files (phrases + waveforms)', engine: 'Engine DJ library',
  traktor: 'Traktor collection', serato: 'Serato (tags in your music files)', vdj: 'VirtualDJ database', mixxx: 'Mixxx library',
};

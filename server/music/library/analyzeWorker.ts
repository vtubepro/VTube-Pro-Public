// The heavy part of our own track analysis, off the helper's main thread (so the 30 Hz music clock never stutters):
// a WAV / AIFF file (read and decoded HERE, streamed, the first 20 minutes) or PCM ffmpeg decoded → (the optional beat
// finder model) → shared/trackDsp.ts analysePcm → TrackAnalysis out. The helper gives every job a deadline and
// terminates this thread when it passes (server/music/library/analyzer.ts); nothing of this runs on the main thread.
// No file access except reading the audio file it is given and the model the user downloaded.
import { parentPort } from 'node:worker_threads';
import { analysePcm } from '../../../shared/trackDsp.ts';
import type { TrackGrid } from '../../../shared/trackAnalysis.ts';
import { beatThis, loadModel } from './beatThis.ts';
import { decodePcmFile, MAX_ANALYSIS_SECONDS } from './decode.ts';

export interface WorkIn {
  id: string;
  /** decoded PCM (22 050 Hz mono) … */
  pcm?: Float32Array;
  /** … or a WAV / AIFF file to read here: an open handle the helper checked (store.ts openReadable; it closes it) */
  fd?: number;
  /** (tests) a path instead */
  file?: string;
  /** which job this is (echoed back: the helper matches results to jobs) */
  jid?: number;
  maxSeconds?: number;
  sr: number; grid: TrackGrid | null; model: string | null;
}
/** The worker can't read this file itself (not plain PCM): ffmpeg or the studio page must decode it. */
export const NEEDS_DECODER = 'NEEDS_DECODER';
export async function work(m: WorkIn) {
  let pcm = m.pcm;
  const src = m.fd ?? m.file;
  if (!pcm && src !== undefined) { const p = decodePcmFile(src, m.maxSeconds ?? MAX_ANALYSIS_SECONDS); if (!p) throw new Error(NEEDS_DECODER); pcm = p; }
  if (!pcm) throw new Error('nothing to analyse');
  let bt: { beats: number[]; downbeats: number[] } | null = null;
  if (!m.grid && m.model) { try { bt = await beatThis(pcm, await loadModel(m.model)); } catch { bt = null; } }
  return analysePcm(pcm, m.sr, m.id, { grid: m.grid, beatThis: bt });
}
if (parentPort) {
  parentPort.on('message', (m: WorkIn) => {
    work(m).then((a) => parentPort!.postMessage({ ok: true, a, jid: m.jid }), (e: Error) => parentPort!.postMessage({ ok: false, error: e.message, jid: m.jid }));
  });
  parentPort.postMessage({ ready: true });   // (VTube Pro waits for this: a worker that never starts is "unavailable")
}

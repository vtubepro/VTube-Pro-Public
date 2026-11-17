// Track library: our own analysis of one track, in a Web Worker of the studio page (for files the helper can't decode
// without a user-installed ffmpeg — MP3 / AAC / FLAC are decoded by the browser itself). PCM in (mono 22 050 Hz, already
// decoded off-screen, never played), TrackAnalysis out. The same code the helper runs (shared/trackDsp.ts).
import { analysePcm } from '../../shared/trackDsp.ts';

self.onmessage = (e: MessageEvent<{ id: string; pcm: Float32Array }>) => {
  try { (self as unknown as Worker).postMessage({ ok: true, a: analysePcm(e.data.pcm, 22050, e.data.id) }); }
  catch (err) { (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message }); }
};

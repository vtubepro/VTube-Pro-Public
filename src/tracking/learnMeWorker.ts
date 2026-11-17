// "Keep learning me" worker: reads the stored feature chunks from IndexedDB and runs one gated learning pass
// (learnMeFit.ts) off the main thread. Started only when the camera is not tracking.
import { decodeChunks, lmStore } from './learnMeData.ts';
import { learn } from './learnMeFit.ts';
import type { LearnedModel } from './learnMeFit.ts';
import type { VowelStyle } from './speakingProfile.ts';

self.onmessage = async (e: MessageEvent<{ current: LearnedModel | null; baseStyle: VowelStyle; enunciation: number }>) => {
  try {
    const chunks = await lmStore.all();
    const fr = decodeChunks(chunks);
    const r = learn(fr, e.data.current, { baseStyle: e.data.baseStyle, enunciation: e.data.enunciation });
    const { debug: _debug, ...result } = r;
    void _debug;
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message });
  }
};

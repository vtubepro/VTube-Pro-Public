/// <reference lib="webworker" />
// "My face model" stage 2: the training worker. One job per worker: the studio posts the packed frames (buffers TRANSFERRED, so
// the main thread no longer holds the crops), this trains + judges (teach.ts trainTeach) and posts back only the weights JSON and
// the numbers. Cancel = the studio terminates the worker. The frames never leave this worker, are zeroed when it is done.
import { scrubFrames, trainTeach, unpackFrames, type ModelStats, type PackedFrames } from './teach.ts';

export interface TrainJob { type: 'train'; frames: PackedFrames; t0Sec: number; seed?: number }
export type TrainMsg = { type: 'progress'; epoch: number; epochs: number } | { type: 'done'; json: string; stats: ModelStats } | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<TrainJob>) => {
  const m = e.data;
  if (m?.type !== 'train') return;
  let frames: ReturnType<typeof unpackFrames> = [];
  try {
    frames = unpackFrames(m.frames);
    const out = trainTeach(frames, m.t0Sec, { seed: m.seed ?? 1, onEpoch: (epoch, epochs) => ctx.postMessage({ type: 'progress', epoch, epochs } satisfies TrainMsg) });
    ctx.postMessage({ type: 'done', json: out.json, stats: out.stats } satisfies TrainMsg);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies TrainMsg);
  } finally { scrubFrames(frames); }
};

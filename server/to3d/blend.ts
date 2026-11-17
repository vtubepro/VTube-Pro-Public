// Pro2D → 3D: the round's VRM as the job's work/candidate.blend (blender/to3d/make_blend.py), headless, low priority,
// inside the Blender lock. The user's visible Blender (and their AI, through the Blender MCP) opens this file.
import fs from 'node:fs';
import path from 'node:path';
import { runBlender } from '../blender.ts';
import { acquireBlenderLock } from '../creator/blenderLock.ts';
import { ROOT } from '../paths.ts';
import { jobPaths } from './store.ts';

export async function makeBlend(jobId: string, vrm: string): Promise<string> {
  const out = jobPaths(jobId).blend;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const release = await acquireBlenderLock({ who: 'vtubepro-to3d', what: 'candidate.blend' });
  try {
    await runBlender(path.join(ROOT, 'blender', 'to3d', 'make_blend.py'), [vrm, out], { lowPriority: true, timeoutMs: 5 * 60_000 });
  } finally { release(); }
  if (!fs.existsSync(out)) throw new Error('the .blend could not be made');
  return out;
}

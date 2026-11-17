// Pro2D → 3D live facts (lane to3d): OBS on air (read-only GetStreamStatus / GetRecordStatus, only when OBS is
// connected through VTube Pro: never dials it otherwise) and the studio tracking (the newest diag state.json, the same
// signal tools/live_ok.py reads). The rule itself is shared/to3d/live.ts.
import fs from 'node:fs';
import path from 'node:path';
import { liveRule, type LiveFacts, type LiveRule } from '../../shared/to3d/live.ts';
import { CACHE_DIR } from '../paths.ts';

let obsProbe: () => Promise<boolean | null> = async () => {
  try { const { obs } = await import('../obs.ts'); return await obs.outputActive(); } catch { return null; }
};
/** Tests: a fake OBS. */
export function setObsProbe(fn: () => Promise<boolean | null>) { obsProbe = fn; }

export function diagFacts(dir = path.join(CACHE_DIR, 'diag', 'history'), now = Date.now()): Pick<LiveFacts, 'diagAgeS' | 'struggling'> {
  let best: { f: string; m: number } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('state.json')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    }
  } catch { /* no diagnostics */ }
  if (!best) return { diagAgeS: null, struggling: false };
  let struggling = false;
  try {
    const s = (JSON.parse(fs.readFileSync(path.join(dir, best.f), 'utf8')) as { stats?: { inferMs?: number; trackFps?: number } }).stats ?? {};
    struggling = (s.inferMs ?? 0) >= 25 || (s.trackFps ?? 60) <= 24;
  } catch { /* half written */ }
  return { diagAgeS: Math.max(0, (now - best.m) / 1000), struggling };
}

export async function liveNow(): Promise<LiveRule & { facts: LiveFacts }> {
  const facts: LiveFacts = { obsOutput: await obsProbe(), ...diagFacts() };
  return { ...liveRule(facts), facts };
}

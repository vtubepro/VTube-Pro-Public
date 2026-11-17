// The graphics card as a whole, read by the helper (server/gpuWatch.ts) while an OBS page is connected, a few times a
// minute: dedicated memory used / total and the overall 3D utilisation. Pages use it to tell "a game holds the card"
// (Tracker game mode stays on while it does; the studio's notice says how full the card is) and the OBS page's
// starvation guard uses the memory figure. Nothing here names a process: only the card's totals. Pure: parsers and
// judgements are unit-tested in tools/gamefps_unit.ts.

export interface GpuStat {
  /** epoch ms of the reading */
  at: number;
  source: 'nvidia-smi' | 'counters';
  /** dedicated graphics memory in use (all programs) and the card's total, MB (total 0 = unknown) */
  usedMB: number;
  totalMB: number;
  /** 3D / overall utilisation 0..100 (null = unknown) */
  util: number | null;
  /** epoch ms the utilisation was measured, when not with the reading itself (the Windows counters measure it every
   *  10 s, the memory every 5 s) */
  utilAt?: number;
}

/** A reading older than this says nothing any more. */
export const GPU_STAT_FRESH_MS = 20000;
/** The card counts as busy (a game holding it) at this utilisation or more. */
export const GPU_BUSY_UTIL = 90;
/** A utilisation measured longer ago than this says nothing (a 90 % blip must not stay 'busy': review round 2). */
export const GPU_UTIL_FRESH_MS = 12000;
/** ... and its memory as nearly full at this share. */
export const GPU_VRAM_FULL = 0.9;

export function gpuBusy(s: GpuStat | null | undefined, now = Date.now()): boolean | null {
  if (!s || now - s.at > GPU_STAT_FRESH_MS || s.util === null || now - (s.utilAt ?? s.at) > GPU_UTIL_FRESH_MS) return null;
  return s.util >= GPU_BUSY_UTIL;
}
export function vramFull(s: GpuStat | null | undefined, now = Date.now()): boolean | null {
  if (!s || now - s.at > GPU_STAT_FRESH_MS || !(s.totalMB > 0)) return null;
  return s.usedMB / s.totalMB >= GPU_VRAM_FULL;
}
/** "9.6 of 10 GB" (one decimal under 10 GB used, whole GB of the total). */
export function vramText(s: GpuStat): string {
  const g = (mb: number) => mb / 1024;
  const u = g(s.usedMB), t = g(s.totalMB);
  return `${u < 10 ? u.toFixed(1) : Math.round(u)} of ${Math.round(t)} GB`;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** One line of `nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`
 *  (the first card when there are several lines). */
export function parseNvidiaSmiStat(out: string, now = Date.now()): GpuStat | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length);
  if (!line) return null;
  const [u, t, g] = line.split(',').map((x) => num(x));
  if (!(u >= 0) || !(t > 0)) return null;
  return { at: now, source: 'nvidia-smi', usedMB: Math.round(u), totalMB: Math.round(t), util: g >= 0 && g <= 100 ? Math.round(g) : null };
}

/** One JSON line of the Windows counters probe (server/gpuWatch.ts WIN_LOOP): {"u": dedicated bytes used (the busiest
 *  adapter), "t": dedicated bytes total, "g": the busiest 3D engine's utilisation % (each engine summed over the processes
 *  using it, as Task Manager shows it; the sum of every engine read a hybrid / multi-engine card as full), "ga": how long
 *  ago "g" was measured (ms; -1 = not yet)}. */
export function parseCountersStat(line: string, now = Date.now()): GpuStat | null {
  let d: { u?: unknown; t?: unknown; g?: unknown; ga?: unknown };
  try { d = JSON.parse(line); } catch { return null; }
  const u = num(d?.u), t = num(d?.t), g = num(d?.g), ga = num(d?.ga);
  if (!(u >= 0)) return null;
  const util = g >= 0 ? Math.min(100, Math.round(g)) : null;
  return { at: now, source: 'counters', usedMB: Math.round(u / 1048576), totalMB: t > 0 ? Math.round(t / 1048576) : 0, util,
    ...(util !== null && ga >= 0 ? { utilAt: now - Math.round(ga) } : {}) };
}

/** A GpuStat from the bus (any junk → null). */
export function sanitizeGpuStat(v: unknown): GpuStat | null {
  const o = v as Partial<GpuStat> | null;
  if (!o || typeof o !== 'object') return null;
  const at = num(o.at), u = num(o.usedMB), t = num(o.totalMB), g = o.util === null ? null : num(o.util);
  if (!(at > 0) || !(u >= 0) || !(t >= 0)) return null;
  const ua = num(o.utilAt);
  return { at, source: o.source === 'nvidia-smi' ? 'nvidia-smi' : 'counters', usedMB: Math.round(u), totalMB: Math.round(t), util: g === null || !(g >= 0) ? null : Math.min(100, Math.round(g)),
    ...(ua > 0 ? { utilAt: ua } : {}) };
}

/** What an OBS page says about itself every few seconds (src/output.ts → bus 'obsperf'): the studio keeps the latest per
 *  page for diagnostics (state.json) and the helper for GET /api/gpu. */
export interface ObsPerfReport {
  at: number;
  /** the page's bus id (one entry per OBS source) */
  page: string;
  /** frames a second over the last window, the longest gap between frames (ms) and its p95 */
  fps: number; gapMax: number; gapP95: number;
  /** GPU timer p90 (ms; null = no timer) and the page's main-thread ms per frame (p95) */
  gpuP90: number | null; cpuP95: number | null;
  /** the graphics level drawn now, the starvation level (src/stage/gfx/starve.ts) and the render scale */
  level: string; starved: 0 | 1 | 2; scale: number;
  /** what the page holds on the card (estimate, MB: src/stage/gfx/vramEstimate.ts) */
  vramMB: number | null; texMB: number | null; targetsMB: number | null;
  /** the page is shown (OBS source visible) */
  driven: boolean;
}

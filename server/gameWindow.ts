// Which window is the player's game, and which monitor is it on? Windows only, read-only, only when asked:
//   * the "This game blocks Game Capture" check (server/obsGaming.ts), at most every GAP_MS;
//   * GET /api/game/fullscreen, which the studio asks only while a game is likely running (the graphics card is busy, or
//     stall mode is on: src/ui/gamingNudge.ts), to suggest "For games" tracking. Never on a timer of its own.
// It runs the static script tools/helper/win/ps/game_window.ps1 (server/psLaunch.ts) at below-normal priority off the
// helper's event loop (server/spawnOffLoop.ts) and keeps the answer for GAP_MS, so any number of callers cost one run.
import { Router } from 'express';
import { runOffLoop } from './spawnOffLoop.ts';
import { psFileCommand, psScriptExists, psScriptPath } from './psLaunch.ts';
import { requireLocal } from './routes/util.ts';
import { pickGame, type GameWindow } from '../shared/gamingCapture.ts';

export const GAP_MS = 30_000;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Pure: the script's one JSON line → windows (bad rows dropped). */
export function parseGameWindows(stdout: string): GameWindow[] {
  let j: { w?: unknown };
  try { j = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''); } catch { return []; }
  const rows = Array.isArray(j.w) ? j.w : j.w && typeof j.w === 'object' ? [j.w] : [];   // (PowerShell prints a lone object bare)
  const out: GameWindow[] = [];
  for (const r of rows.slice(0, 200) as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const g: GameWindow = {
      exe: s(r.exe, 100), path: s(r.path, 260), pid: n(r.pid), title: s(r.title, 200), cls: s(r.cls, 100),
      rect: { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) }, monitor: { x: n(r.mx), y: n(r.my), w: n(r.mw), h: n(r.mh) }, primary: r.primary === true,
    };
    if (g.exe && g.rect.w > 0 && g.rect.h > 0 && g.monitor.w > 0 && g.monitor.h > 0) out.push(g);
  }
  return out;
}

export interface WindowScanner { (): Promise<GameWindow[] | null> }
/** The real scan: null = not Windows / the script is missing / it failed (callers then judge without a window). */
export const scanWindows: WindowScanner = async () => {
  if (process.platform !== 'win32') return null;
  const file = psScriptPath('game_window.ps1');
  if (!psScriptExists(file)) return null;
  const cmd = psFileCommand(file, [['Max', 40]], ['-NoLogo']);
  const r = await runOffLoop(cmd.command, cmd.args, { timeoutMs: 15_000 });
  if (r.error || r.timedOut || r.code !== 0) return null;
  return parseGameWindows(r.stdout.toString('utf8'));
};

let scanner: WindowScanner = scanWindows;
/** Tests: stand in for the real scan. */
export function setWindowScanner(f: WindowScanner | null) { scanner = f ?? scanWindows; cache = null; }
let cache: { at: number; ws: GameWindow[] | null } | null = null;
let running: Promise<GameWindow[] | null> | null = null;
let runs = 0;
/** How many real scans ran (tests; diagnostics). */
export const scanCount = () => runs;

/** The windows now, or the answer of the last GAP_MS (`force` = a click: at least 3 s old at most). */
export function windows(force = false, now = Date.now()): Promise<GameWindow[] | null> {
  if (cache && now - cache.at < (force ? 3000 : GAP_MS)) return Promise.resolve(cache.ws);
  if (running) return running;
  runs++;
  running = scanner().catch(() => null).then((ws) => { cache = { at: Date.now(), ws }; return ws; }).finally(() => { running = null; });
  return running;
}

/** The game now: a window of `exe` (a Game Capture set to a specific window), else the topmost fullscreen non-tool window. */
export async function currentGame(exe?: string, force = false): Promise<GameWindow | null> {
  const ws = await windows(force);
  return ws ? pickGame(ws, exe) : null;
}

export const gameWindowRoutes = Router();
/** GET /api/game/fullscreen → { game: { exe, title, monitor } | null, known } — this PC only; never starts anything else. */
gameWindowRoutes.get('/api/game/fullscreen', async (req, res) => {
  requireLocal(req); res.setHeader('Cache-Control', 'no-store');
  const ws = await windows(false);
  const g = ws ? pickGame(ws) : null;
  res.json({ known: ws !== null, game: g ? { exe: g.exe, title: g.title.slice(0, 80), w: g.monitor.w, h: g.monitor.h } : null });
});

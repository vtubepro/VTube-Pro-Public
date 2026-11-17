// The graphics card as a whole, while an OBS page is connected (shared/gpuStat.ts): dedicated memory used / total and
// the overall utilisation, every 5 s, sent to this PC's pages (bus 'gpustat') and kept for diagnostics (GET /api/gpu).
// Why: a game that holds the card starves VTube Pro (face tracking: Tracker game mode; the OBS page: starve.ts); knowing
// the card is busy keeps game mode on until the game lets go, and the studio's notice can say how full the card is.
//   NVIDIA (Windows / Linux): `nvidia-smi --query-gpu=…` once per reading (~90 ms, below-normal priority, started off
//                             the event loop: server/spawnOffLoop.ts).
//   Other cards on Windows:   NOTHING by default (beta.14.1). Opt-in (VTP_GPU_WATCH=counters): one long-lived hidden
//                             PowerShell (no window: windowsHide, below-normal priority) reading
//                             the language-neutral WMI performance classes (GPUAdapterMemory every 5 s, the 3D engine
//                             utilisation every 10 s: that query alone costs ~0.5 s; printed with its age, so a 90 %
//                             blip goes stale after 12 s instead of being re-stamped fresh); it ends by itself when the helper
//                             is gone (parent-process check — id AND start time — every reading; every WMI query has a 4-8 s
//                             timeout, so a hung query cannot keep it alive) and is stopped 30 s after the last OBS page
//                             left; the helper kills it outright when it stops or exits. (A Windows job object that dies
//                             with the helper needs native code; this bounds the loop's life to ~10 s after a hard kill.)
//   nvidia-smi failing: only "not installed" is final; a timeout (a game holding the card) or a failed run is tried again
//                             (5 s, 10 s, ... up to a minute), the Windows counters (when opted in) standing in after 3
//                             failures in a row.
//   macOS / Linux without nvidia-smi, Windows without nvidia-smi and without the opt-in: nothing (pages then judge by their
//                             own frames: the stall guard's readback and graphics-queue probes, src/tracking/stallGuard.ts;
//                             the OBS page's starve guard goes deep only after 8 s of the lightest look instead of at
//                             once on a full card's memory, src/stage/gfx/starve.ts).
// Why the counters are opt-in: a background powershell.exe that node.exe starts by itself, again and again while OBS is
// open, is what antivirus exploit protection is built to stop. Emsisoft blocked it on 13.5 / 14 as "an exploit attempt"
// in the helper's node.exe (then -EncodedCommand + Bypass; the static -File script of 14.1 drops the worst signs, but a
// hidden powershell.exe that node.exe keeps starting by itself is still a pattern behaviour blockers watch, and it could
// not be tested against Emsisoft), on PCs with AMD / Intel cards, which is every PC that takes this path. nvidia-smi is a
// signed program of the graphics driver, not a script host, and stays on. (This covers the counters loop. Other queries
// the helper runs through PowerShell by itself: the phone card's firewall check while it shows, the Stream PC check when
// that mode is on.)
// Off switch: VTP_GPU_WATCH=0 (no reading at all). Only the card's totals: no process names, nothing leaves this PC.
import { Router } from 'express';
import { Worker } from 'node:worker_threads';
import { runOffLoop } from './spawnOffLoop.ts';
import { psFileCommand, psScriptExists, psScriptPath } from './psLaunch.ts';
import { parseCountersStat, parseNvidiaSmiStat, type GpuStat } from '../shared/gpuStat.ts';
import type { BusMessage } from '../shared/types.ts';
import { requireLocal } from './routes/util.ts';

const EVERY_MS = 5000;
const LINGER_MS = 30000;
const KEEP = 72;   // 6 minutes of readings
export const NV_ARGS = ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'];

/** The Windows counters loop (a background PowerShell) only when the person asked for it: VTP_GPU_WATCH=counters. */
export const countersOptIn = (env: NodeJS.ProcessEnv = process.env) => env.VTP_GPU_WATCH === 'counters';
const NO_COUNTERS = 'no graphics-card reading on this PC (no nvidia-smi; the Windows counters are off: VTP_GPU_WATCH=counters turns them on)';

/** The Windows counters loop is a static script (tools/helper/win/ps/gpu_counters.ps1: one JSON line per reading, parsed by
 *  parseCountersStat). `ppid` = the helper: the loop ends when it is gone. Returns the powershell.exe command line. */
export function winLoopCommand(ppid: number) {
  return psFileCommand(psScriptPath('gpu_counters.ps1'), [['ParentPid', Math.floor(ppid)]]);
}

// a long-lived child on a worker thread (its start never holds the event loop), lines relayed back
const LOOP_WORKER = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const os = require('node:os');
let ch = null;
try { ch = spawn(workerData.exe, workerData.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { parentPort.postMessage({ closed: String((e && e.message) || e) }); }
if (ch) {
  if (ch.pid !== undefined) { try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* fine */ } }
  let buf = '';
  ch.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) parentPort.postMessage({ line: l }); } if (buf.length > 4096) buf = ''; });
  if (ch.pid !== undefined) parentPort.postMessage({ pid: ch.pid });
  ch.on('error', (e) => parentPort.postMessage({ closed: String((e && e.message) || e) }));
  ch.on('close', (code) => parentPort.postMessage({ closed: code }));
  parentPort.on('message', (m) => { if (m === 'stop') { try { ch.kill(); } catch (e) { /* gone */ } } });
}
`;

export interface GpuWatchStatus { on: boolean; source: GpuStat['source'] | null; note: string; latest: GpuStat | null; history: GpuStat[] }

export class GpuWatch {
  latest: GpuStat | null = null;
  history: GpuStat[] = [];
  private nv: boolean | null = null;       // nvidia-smi works here (null = not tried yet / not proven; false = not installed)
  private nvFails = 0;                     // failed nvidia-smi runs in a row (timeouts, errors)
  private nvRetryAt = 0;
  private busy = false;
  private wantedAt = 0;
  private loop: Worker | null = null;
  private loopPid = 0;
  private loopDead = false;
  private loopFails = 0;                   // counters loops that ended within a minute, in a row
  private loopRetryAt = 0;
  private loopStartedAt = 0;
  private exitHook = false;
  private timer: NodeJS.Timeout | null = null;
  note = '';

  constructor(private wanted: () => boolean, private send: (m: BusMessage) => void, private platform = process.platform, private env: NodeJS.ProcessEnv = process.env) {}

  start() {
    if (this.env.VTP_GPU_WATCH === '0' || this.timer) { if (!this.timer) this.note = 'off (VTP_GPU_WATCH=0)'; return; }
    this.timer = setInterval(() => { void this.tick(); }, EVERY_MS);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.stopLoop(); }

  status(): GpuWatchStatus { return { on: !!this.timer && (this.nv === true || !!this.loop), source: this.latest?.source ?? null, note: this.note, latest: this.latest, history: [...this.history] }; }

  private take(s: GpuStat) {
    this.latest = s;
    this.history.push(s);
    if (this.history.length > KEEP) this.history.shift();
    try { this.send({ type: 'gpustat', s }); } catch { /* the bus is optional */ }
  }

  private async tick() {
    const now = Date.now();
    if (this.wanted()) this.wantedAt = now;
    else { if (now - this.wantedAt > LINGER_MS) this.stopLoop(); return; }
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.nv !== false && now >= this.nvRetryAt && (this.platform === 'win32' || this.platform === 'linux')) {
        const r = await runOffLoop('nvidia-smi', NV_ARGS, { timeoutMs: 4000 });
        const s = !r.error && r.code === 0 ? parseNvidiaSmiStat(r.stdout.toString('utf8')) : null;
        if (s) { this.nv = true; this.nvFails = 0; this.note = 'nvidia-smi'; this.take(s); if (this.loop) this.stopLoop(); return; }
        const v = nvVerdict(r, this.nvFails);
        this.nvFails++;
        if (v === 'final') this.nv = false;
        else { this.nvRetryAt = Date.now() + Math.min(60000, EVERY_MS * 2 ** this.nvFails); this.note = `nvidia-smi did not answer (${r.timedOut ? 'timed out' : r.error ?? `exit ${r.code}`}): trying again`; }
      }
      // (nvidia-smi worked and only missed a reading or two: the next one tries it again, no counters loop meanwhile)
      if (this.nv === true && this.nvFails < 3) return;
      if (this.platform === 'win32' && countersOptIn(this.env)) this.ensureLoop();
      // (nvidia-smi there but not answering right now keeps its own 'trying again' note)
      else if (this.nv === false || this.platform === 'darwin') this.note = this.platform === 'win32' ? NO_COUNTERS : 'no graphics-card reading on this system (no nvidia-smi)';
    } finally { this.busy = false; }
  }

  private ensureLoop() {
    if (this.loop || this.loopDead || Date.now() < this.loopRetryAt) return;
    try {
      // (a static script file with the helper's pid as -ParentPid: nothing encoded, nothing re-parsed on the command line)
      const cmd = winLoopCommand(process.pid);
      if (!psScriptExists(psScriptPath('gpu_counters.ps1'))) { this.loopDead = true; this.note = 'Windows counters unavailable'; return; }
      const w = new Worker(LOOP_WORKER, { eval: true, workerData: { exe: cmd.command, args: cmd.args } });
      w.unref();
      w.on('message', (m: { line?: string; closed?: unknown; pid?: number }) => {
        if (m.pid) { if (this.loop === w) this.loopPid = m.pid; }
        else if (m.line) { const s = parseCountersStat(m.line); if (s) { this.note = 'Windows counters'; this.take(s); } }
        else if (m.closed !== undefined) {
          if (this.loop === w) {
            this.loop = null; this.loopPid = 0;
            // (a loop that keeps ending at once — powershell.exe blocked or killed — is not restarted every 5 s: 10 s,
            //  20 s, ... up to 5 minutes, given up after 5 in a row)
            if (Date.now() - this.loopStartedAt < 60000) {
              this.loopFails++;
              this.loopRetryAt = Date.now() + Math.min(300000, EVERY_MS * 2 ** this.loopFails);
              if (this.loopFails >= 5) { this.loopDead = true; this.note = 'Windows counters unavailable'; }
            } else this.loopFails = 0;
          }
          void w.terminate();
        }
      });
      w.on('error', () => { if (this.loop === w) { this.loop = null; this.loopPid = 0; } this.loopDead = true; this.note = 'Windows counters unavailable'; });
      this.loop = w; this.loopStartedAt = Date.now();
      // (the helper exiting kills the loop outright: no PowerShell left behind waiting for its next parent check)
      if (!this.exitHook) { this.exitHook = true; process.once('exit', () => this.killLoop()); }
    } catch { this.loopDead = true; this.note = 'Windows counters unavailable'; }
  }

  private stopLoop() {
    const w = this.loop;
    this.killLoop();
    this.loop = null;
    if (!w) return;
    try { w.postMessage('stop'); } catch { /* gone */ }
    setTimeout(() => { void w.terminate(); }, 2000).unref();
  }

  /** End the PowerShell loop now, without waiting for a WMI query it may be in (synchronous: also from 'exit'). */
  private killLoop() {
    const pid = this.loopPid;
    this.loopPid = 0;
    if (pid) try { process.kill(pid); } catch { /* already gone */ }
  }
}

/** A failed nvidia-smi run: 'final' = not installed here (the program is missing), or a run that started and failed 3
 *  times in a row with an exit code (no NVIDIA driver); 'retry' = a timeout (a game holding the card) or a passing
 *  failure (pure: tools/gamefps_unit.ts). */
export function nvVerdict(r: { error?: string; code: number | null; timedOut: boolean }, failsBefore: number): 'final' | 'retry' {
  if (r.timedOut) return 'retry';
  if (r.error && /ENOENT|not found|not recognized/i.test(r.error)) return 'final';
  if (!r.error && r.code !== null && r.code !== 0 && failsBefore >= 2) return 'final';
  return 'retry';
}

/** GET /api/gpu: the card's readings of the last minutes (diagnostics, this PC only). */
export function gpuWatchRoutes(watch: GpuWatch) {
  const r = Router();
  r.get('/api/gpu', (req, res) => { requireLocal(req); res.json(watch.status()); });
  return r;
}

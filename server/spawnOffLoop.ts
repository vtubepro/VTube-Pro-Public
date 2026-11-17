// Child processes started WITHOUT holding the helper's event loop.
//
// child_process.spawn() runs the program asynchronously, but it STARTS it synchronously: on Windows the whole
// CreateProcess (loading python.exe / node.exe, the Microsoft Store python stub, an antivirus scan) happens inside the
// call. On a busy PC that is 60-250 ms on a sizeable share of starts (b10 review: validate_room still stalled the
// studio -> OBS bus 76-165 ms after spawnSync was gone, because spawn() itself held the loop). The helper's event loop
// also relays every tracking frame from the studio to the OBS page (src/bus.ts -> /ws), so each such start is a hitch on
// stream. runOffLoop() starts the program on ONE worker thread instead (made on first use, kept for the next run, never
// keeping the process alive while idle); only the finished result comes back to the main loop.
// Measured on the owner's PC (40 python starts in a row): main-loop gap 110-248 ms with the starts on the main thread,
// 20-21 ms with them on the worker. No child process is ever started on the main thread by these paths.
// The worker's source is plain CommonJS in a string (below), so a bundled server
// needs no extra file. Users: server/aiPackage.ts runPy (the Python room / package checker) and server/roomCheckJob.ts
// runRoomJob (check_room, "Add my room", .gltf packing), server/partyLod.ts (the party LOD child) and
// server/gpuSidecars.ts (the nvidia-smi probe).
//
// spawnStreaming() (bottom of this file) is the same for a program that LIVES on and talks while it runs (the GPU
// sidecars, an ffmpeg encoder): it gets a worker of its own, so its start hitch and its output relay never touch the
// main loop either. Its output comes back to the main thread as Buffers through onStdout / onStderr.
import { EventEmitter } from 'node:events';
import { SHARE_ENV, Worker } from 'node:worker_threads';

export interface OffLoopOptions {
  /** Stop the run after this long (kill); the result then says timedOut. */
  timeoutMs: number;
  cwd?: string;
  /** Written to the program's stdin, which is then closed. None = stdin is not connected. */
  input?: Uint8Array;
  /** `input` is a fresh array the caller never touches again: hand its memory to the worker instead of copying it. */
  transferInput?: boolean;
  /** Below-normal CPU priority for the program (default true), so it never competes with the live studio. */
  lowPriority?: boolean;
  /** Extra environment variables on top of the helper's own (lane to3d: the pipeline's Blender, lock and base folder). */
  env?: Record<string, string>;
}
/** What a run printed and how it ended, or why it did not start (`error`, e.g. "spawn python ENOENT"). Never thrown. */
export interface OffLoopRun { stdout: Buffer; stderr: string; code: number | null; error?: string; timedOut: boolean }
/** A child process runOffLoop started ('spawn', right after its priority was set) or saw end ('close'). */
export interface OffLoopChild { phase: 'spawn' | 'close'; pid: number; exe: string; args: string[] }

// The worker: one message per run in, 'spawn' (pid) and 'done' (the result) out. stdout is kept whole (a multi-byte
// character split over two chunks decodes right), stderr only its last 4000 characters (the reason a run failed).
const WORKER_SOURCE = `'use strict';
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const os = require('node:os');
parentPort.on('message', (m) => {
  const out = [];
  let err = '', error, timedOut = false, done = false, timer = null, ch = null;
  const finish = (code) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    parentPort.postMessage({ id: m.id, t: 'done', code, error, timedOut, stdout: Buffer.concat(out), stderr: err });
  };
  try { ch = spawn(m.exe, m.args, { cwd: m.cwd, env: m.env ? Object.assign({}, process.env, m.env) : undefined, windowsHide: true, stdio: [m.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
  catch (e) { error = String((e && e.message) || e); finish(null); return; }
  if (ch.pid !== undefined) {
    if (m.lowPriority) { try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not allowed: fine */ } }
    parentPort.postMessage({ id: m.id, t: 'spawn', pid: ch.pid });
  }
  timer = setTimeout(() => { timedOut = true; try { ch.kill(); } catch (e) { /* already gone */ } }, m.timeoutMs);
  ch.stdout.on('data', (d) => { out.push(d); });
  ch.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-4000); });
  // could not start (ENOENT: no such program): no 'close' is guaranteed to follow; a running one's error waits for it
  ch.on('error', (e) => { error = e.message; if (ch.pid === undefined) finish(null); });
  ch.on('close', (code) => { finish(code); });
  if (m.input) {
    ch.stdin.on('error', () => { /* the program ended early: its exit says why */ });
    ch.stdin.end(Buffer.from(m.input.buffer, m.input.byteOffset, m.input.byteLength));
  }
});
`;

const events = new EventEmitter();
/** Tests: hear about every child runOffLoop starts and ends (count runs, read a run's priority). Returns the unsubscribe. */
export function onOffLoopChild(fn: (c: OffLoopChild) => void): () => void {
  events.on('child', fn);
  return () => { events.off('child', fn); };
}

interface Pending { resolve: (r: OffLoopRun) => void; exe: string; args: string[]; pid?: number }
interface FromWorker { id: number; t: 'spawn' | 'done'; pid?: number; code?: number | null; error?: string; timedOut?: boolean; stdout?: Uint8Array; stderr?: string }
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const noRun = (error: string): OffLoopRun => ({ stdout: Buffer.alloc(0), stderr: '', code: null, error, timedOut: false });

function settle(id: number, r: OffLoopRun) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.pid !== undefined) events.emit('child', { phase: 'close', pid: p.pid, exe: p.exe, args: p.args } satisfies OffLoopChild);
  if (!pending.size) worker?.unref();          // idle: the starter never keeps VTube Pro (or a CLI tool) alive
  p.resolve(r);
}

function starter(): Worker {
  if (worker) return worker;
  // env: SHARE_ENV = the children see the helper's environment as it is NOW (a worker's own copy would be a snapshot);
  // execArgv: [] = no tsx / --import hooks in the worker, it only runs the plain source above
  const w = new Worker(WORKER_SOURCE, { eval: true, env: SHARE_ENV, execArgv: [] });
  w.on('message', (m: FromWorker) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === 'spawn') {
      p.pid = m.pid;
      events.emit('child', { phase: 'spawn', pid: m.pid!, exe: p.exe, args: p.args } satisfies OffLoopChild);
      return;
    }
    const u = m.stdout ?? new Uint8Array(0);
    settle(m.id, { stdout: Buffer.from(u.buffer, u.byteOffset, u.byteLength), stderr: m.stderr ?? '', code: m.code ?? null, error: m.error, timedOut: !!m.timedOut });
  });
  // a starter that crashed or stopped: every run it had answers with the reason (none hangs); the next run makes a new one
  const lost = (why: string) => {
    if (worker === w) worker = null;
    for (const id of [...pending.keys()]) settle(id, noRun(why));
  };
  w.on('error', (e: unknown) => lost(`the process starter failed: ${e instanceof Error ? e.message : String(e)}`));
  w.on('exit', (code) => lost(`the process starter stopped (exit ${code})`));
  w.unref();
  worker = w;
  return w;
}

/** Run `exe args` as its own process, started and watched on the worker thread: the event loop is never held, not even
 *  for the start. Below-normal priority (unless lowPriority: false), stopped after `timeoutMs`. Never rejects: a program
 *  that is missing (ENOENT) or crashes comes back as a run with `error` / an exit code. */
export function runOffLoop(exe: string, args: string[], o: OffLoopOptions): Promise<OffLoopRun> {
  return new Promise<OffLoopRun>((resolve) => {
    let w: Worker;
    try { w = starter(); } catch (e) { resolve(noRun(`could not start the process starter: ${e instanceof Error ? e.message : String(e)}`)); return; }
    const id = ++seq;
    pending.set(id, { resolve, exe, args: [...args] });
    w.ref();
    const msg = { id, exe, args, cwd: o.cwd, env: o.env, input: o.input, timeoutMs: o.timeoutMs, lowPriority: o.lowPriority !== false };
    try { w.postMessage(msg, o.input && o.transferInput ? [o.input.buffer as ArrayBuffer] : []); } catch (e) { settle(id, noRun(e instanceof Error ? e.message : String(e))); }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Long-lived programs (GPU sidecars, ffmpeg): started and read on a worker thread of their own, one worker per program
// (so one program's start hitch never delays another's output). The main thread gets its output chunks as Buffers, its
// pid, and its end. The worker is ended when the program has ended.

export interface StreamingOptions {
  cwd?: string;
  /** The program's whole environment (default: the helper's own, as it is now). */
  env?: NodeJS.ProcessEnv;
  /** Below-normal CPU priority (default false: the program keeps the priority it would have had with spawn()). */
  lowPriority?: boolean;
  /** 'pipe' = stdin is connected and stays open until endStdin() (default 'ignore'). */
  stdin?: 'ignore' | 'pipe';
  onStdout?: (d: Buffer) => void;
  onStderr?: (d: Buffer) => void;
  /** The program could not start (ENOENT, ...) or reported an error while running. Like 'error' on a ChildProcess. */
  onError?: (message: string) => void;
  /** The program ended (after its output was delivered). `signal` is a signal name, or 'starter-lost' when the worker that
   *  watched it died (the program is then killed by pid). Not called for a program that never started: that is onError. */
  onExit?: (code: number | null, signal: string | null) => void;
}
export interface StreamingChild {
  /** Known a moment after the call, when the worker has started the program. */
  readonly pid: number | undefined;
  /** From the call until the program ended (or never started). */
  readonly running: boolean;
  /** End the program now. Works from the main thread alone, also inside process.on('exit') (kills by pid). */
  kill(): void;
  /** Close its stdin (stdin: 'pipe' only): a program that waits for the end of its input then ends. */
  endStdin(): void;
}

// The worker: starts the program, relays its output (copied into a fresh buffer and transferred: a pipe chunk can sit in
// a shared slab that a plain postMessage would copy whole), reports 'exit' after the pipes are drained (or 1.5 s after
// the exit when a grandchild still holds them open).
const STREAM_WORKER_SOURCE = `'use strict';
const { parentPort, workerData: w } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const os = require('node:os');
let ch = null, done = false, grace = null;
const copy = (d) => { const c = new Uint8Array(d.length); c.set(d); return c; };
const finish = (code, signal) => {
  if (done) return;
  done = true;
  if (grace) clearTimeout(grace);
  parentPort.postMessage({ t: 'exit', code, signal });
};
try { ch = spawn(w.exe, w.args, { cwd: w.cwd, env: w.env, windowsHide: true, stdio: [w.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
catch (e) { done = true; parentPort.postMessage({ t: 'error', message: String((e && e.message) || e), started: false }); }
if (ch) {
  if (ch.pid !== undefined) {
    if (w.lowPriority) { try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not allowed: fine */ } }
    parentPort.postMessage({ t: 'spawn', pid: ch.pid });
  }
  ch.stdout.on('data', (d) => { const c = copy(d); parentPort.postMessage({ t: 'out', d: c }, [c.buffer]); });
  ch.stderr.on('data', (d) => { const c = copy(d); parentPort.postMessage({ t: 'err', d: c }, [c.buffer]); });
  if (ch.stdin) ch.stdin.on('error', () => { /* the program ended early: its exit says why */ });
  // could not start (ENOENT): no 'exit' follows, only this error (the main thread then ends the worker)
  ch.on('error', (e) => parentPort.postMessage({ t: 'error', message: String((e && e.message) || e), started: ch.pid !== undefined }));
  ch.on('exit', (code, signal) => { if (!grace) grace = setTimeout(() => finish(code, signal), 1500); });
  ch.on('close', (code, signal) => finish(code, signal));
  parentPort.on('message', (m) => {
    if (m === 'kill') { try { ch.kill(); } catch (e) { /* gone */ } }
    else if (m === 'endStdin') { try { if (ch.stdin) ch.stdin.end(); } catch (e) { /* gone */ } }
  });
}
`;

interface FromStreamWorker { t: 'spawn' | 'out' | 'err' | 'error' | 'exit'; pid?: number; d?: Uint8Array; message?: string; started?: boolean; code?: number | null; signal?: string | null }

/** Start `exe args` on its own worker thread and keep it running: the event loop is not held, not even for the start.
 *  Never throws: a program that cannot start comes back through onError. The worker keeps the helper alive while the
 *  program runs (as a ChildProcess would). */
export function spawnStreaming(exe: string, args: string[], o: StreamingOptions = {}): StreamingChild {
  let pid: number | undefined;
  let running = true;
  let w: Worker | null = null;
  const argv = [...args];
  // the one place a run ends: tell the tests, end the worker
  const end = () => {
    if (!running) return;
    running = false;
    if (pid !== undefined) events.emit('child', { phase: 'close', pid, exe, args: argv } satisfies OffLoopChild);
    if (w) void w.terminate();
  };
  const killPid = () => { if (pid !== undefined) try { process.kill(pid); } catch { /* already gone */ } };
  const child: StreamingChild = {
    get pid() { return pid; },
    get running() { return running; },
    kill() {
      if (!running) return;
      if (pid !== undefined) killPid();
      else try { w?.postMessage('kill'); } catch { /* the worker is gone */ }
    },
    endStdin() { if (running) try { w?.postMessage('endStdin'); } catch { /* the worker is gone */ } },
  };
  try {
    w = new Worker(STREAM_WORKER_SOURCE, { eval: true, env: SHARE_ENV, execArgv: [], workerData: { exe, args: argv, cwd: o.cwd, env: o.env, lowPriority: !!o.lowPriority, stdin: o.stdin ?? 'ignore' } });
  } catch (e) {
    running = false;
    const msg = `could not start the process starter: ${e instanceof Error ? e.message : String(e)}`;
    queueMicrotask(() => o.onError?.(msg));
    return child;
  }
  w.on('message', (m: FromStreamWorker) => {
    if (!running) return;
    if (m.t === 'spawn') { pid = m.pid; events.emit('child', { phase: 'spawn', pid: m.pid!, exe, args: argv } satisfies OffLoopChild); return; }
    if (m.t === 'out' || m.t === 'err') {
      const u = m.d!;
      (m.t === 'out' ? o.onStdout : o.onStderr)?.(Buffer.from(u.buffer, u.byteOffset, u.byteLength));
      return;
    }
    if (m.t === 'error') {
      // a program that never started has nothing more to say (the run is over); one that runs on keeps running
      if (!m.started) end();
      o.onError?.(m.message ?? 'error');
      return;
    }
    end();
    o.onExit?.(m.code ?? null, m.signal ?? null);
  });
  // the worker crashed or stopped while the program ran: the program may be left with nobody reading it, so stop it by pid
  const lost = (why: string) => {
    if (!running) return;
    killPid();
    end();
    o.onError?.(`the process starter failed: ${why}`);
    o.onExit?.(null, 'starter-lost');
  };
  w.on('error', (e: unknown) => lost(e instanceof Error ? e.message : String(e)));
  w.on('exit', (code) => lost(`stopped (exit ${code})`));
  return child;
}

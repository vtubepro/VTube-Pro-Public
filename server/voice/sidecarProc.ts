// A supervised local Python sidecar (tools/voice/whisper_sidecar.py, kokoro_sidecar.py): started when its feature is
// switched on, restarted with back-off if it dies while still wanted, stopped when switched off, dies with the server
// (--parent-pid) and with this process. Same shape as server/gpuSidecars.ts; only the child this class started is ever
// killed. Exit code 2 = "no model installed": not restarted, the card says "install it".
// It never adopts a process it did not start: the microphone audio goes to this sidecar, so if the configured port is
// already taken by something else, ours starts on a free port instead (`port` says which). Child processes run at
// BELOW_NORMAL priority (like server/gpuWatch.ts): the stream and the face tracking come first.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

export interface SidecarSpec {
  name: string;
  /** Interpreter (the voice venv's python). */
  python(): string;
  script: string;
  port: number;
  /** Extra arguments (model folder, device …); evaluated at every (re)start. */
  args(): string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}
export interface SidecarStatus { running: boolean; ours: boolean; wanted: boolean; restarts: number; port: number; error: string; starting: boolean; log: string[] }

export const portOpen = (port: number) => new Promise<boolean>((res) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v: boolean) => { s.destroy(); res(v); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(400, () => done(false));
});

/** A free port on 127.0.0.1 (the OS picks it). */
export const freeLocalPort = () => new Promise<number>((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});

export class SidecarProc {
  private proc: ChildProcess | null = null;
  /** The port our child listens (or will listen) on: the configured one, or a free one when something else holds it. */
  private curPort: number;
  private exit: number | null = null;
  private wanted = false;
  private restarts = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startedAt = 0;
  private log: string[] = [];
  error = '';
  /** Called after an exit that will not be restarted (or any exit): the manager can show why. */
  onExit: ((code: number | null, reason: string) => void) | null = null;

  constructor(private spec: SidecarSpec) { this.curPort = spec.port; }

  /** The port to talk to this sidecar on (read it AFTER start()). */
  get port() { return this.curPort; }

  async start(): Promise<void> {
    this.wanted = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc && this.exit === null) return;
    // something else already serves the configured port: it is NOT ours (a sidecar we start dies with us, --parent-pid), so
    // no audio goes there; ours takes a free port
    this.curPort = this.spec.port;
    if (await portOpen(this.spec.port)) {
      try { this.curPort = await freeLocalPort(); } catch (e) { this.error = `port ${this.spec.port} is taken by another program and no other port is free (${(e as Error).message})`; return; }
    }
    const py = this.spec.python();
    if (!fs.existsSync(this.spec.script)) { this.error = `${this.spec.script} is missing`; return; }
    this.log = []; this.error = ''; this.exit = null; this.startedAt = Date.now(); this.stopping = false;
    const args = ['-u', this.spec.script, '--port', String(this.curPort), '--parent-pid', String(process.pid), ...this.spec.args()];
    const p = spawn(py, args, { cwd: this.spec.cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...this.spec.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    if (p.pid !== undefined) { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine: it just runs at normal priority */ } }
    const keep = (b: Buffer) => { for (const l of b.toString('utf8').replace(/\0/g, '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) if (l.trim().length > 2) { this.log.push(l.slice(0, 300)); if (this.log.length > 40) this.log.shift(); } };
    p.stdout?.on('data', keep); p.stderr?.on('data', keep);
    p.on('error', (e) => { this.error = `could not start Python (${py}): ${e.message}`; this.exit = -1; });
    p.on('exit', (code, signal) => {
      this.exit = code ?? -1; if (this.proc === p) this.proc = null;
      const reason = this.stopping ? 'stopped' : code === 2 ? 'no model installed' : code === 3 ? 'a GPL component (PyAV) is in the voice environment: reinstall the voice pack' : this.log.filter((l) => /error|Error|No module|not found|Traceback|failed/.test(l)).slice(-2).join(' · ') || `exited (code ${code ?? signal})`;
      if (!this.stopping) this.error = reason;
      try { this.onExit?.(code, reason); } catch { /* listener */ }
      if (this.wanted && !this.stopping && code !== 2 && code !== 3) {
        const wait = Math.min(30000, 1000 * 2 ** Math.min(5, this.restarts));
        this.restarts++;
        this.timer = setTimeout(() => { this.timer = null; if (this.wanted) void this.start(); }, wait);
      }
    });
    setTimeout(() => { if (this.proc === p && this.exit === null) this.restarts = 0; }, 60000).unref();
  }

  stop() {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc && this.exit === null) { this.stopping = true; try { this.proc.kill(); } catch { /* gone */ } }
    this.proc = null;
  }

  async status(): Promise<SidecarStatus> {
    const ours = !!(this.proc && this.exit === null);
    const up = ours && await portOpen(this.curPort);
    return { running: up, ours, wanted: this.wanted, restarts: this.restarts, port: this.curPort, error: up ? '' : this.error,
      starting: !up && ((!!this.proc && this.exit === null && Date.now() - this.startedAt < 90000) || !!this.timer), log: this.log.slice(-8) };
  }
}

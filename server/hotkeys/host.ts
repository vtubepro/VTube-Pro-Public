// Global keys (docs/b16/BINDINGS.md): owns the hidden Windows helper process (hostScript.ts) and nothing else.
//   * No key bound = no process at all (idle = zero cost). The first key starts it; the last one removed stops it.
//   * It registers only the combos VTube Pro hands it (Win32 RegisterHotKey), never listens to the keyboard as a whole.
//   * macOS and Linux have no such process: `supported` is false and the studio falls back to keys inside the page.
// The child process and the clock are injectable, so tools/bindings_unit.ts tests the whole protocol with a fake child.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { HOTKEY_HOST_PS1 } from './hostScript.ts';
import { cmdClear, cmdQuit, cmdReg, failWhy, parseHostLine, planHotkeys, type HotkeyAnswer } from './win32.ts';

export interface ChildLike {
  stdin: { write(s: string): unknown; end(): unknown } | null;
  stdout: NodeJS.ReadableStream | null;
  on(ev: 'exit' | 'error', fn: (...a: unknown[]) => void): unknown;
  kill(): unknown;
}
export type SpawnFn = () => ChildLike;
export interface HotkeyEvent { id: string; combo: string; phase: 'down' | 'up' }
export interface HostStatus { supported: boolean; running: boolean; results: HotkeyAnswer[]; note?: string }
export interface HostOptions {
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  onEvent: (e: HotkeyEvent) => void;
  /** ms to wait for the helper to compile and say "ready" (the first start compiles a small C# class: a second or two). */
  readyMs?: number;
  ackMs?: number;
  log?: (s: string) => void;
}

function defaultSpawn(): ChildLike {
  const dir = path.join(os.tmpdir(), 'vtp-hotkeys');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hotkey-host.ps1');
  fs.writeFileSync(file, HOTKEY_HOST_PS1, 'utf8');
  return nodeSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ChildLike;
}

export class HotkeyHost {
  readonly supported: boolean;
  private child: ChildLike | null = null;
  private ready: Promise<boolean> | null = null;
  private resolveReady: ((ok: boolean) => void) | null = null;
  private wants: { id: string; combo: string; mods: number; vk: number }[] = [];
  private results: HotkeyAnswer[] = [];
  private byHostId = new Map<string, { id: string; combo: string }[]>();     // the id sent to Windows -> every binding on that combo
  private pending = new Map<string, (a: { ok: boolean; code: number }) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private restarts: number[] = [];
  private note = '';
  private readonly o: Required<Pick<HostOptions, 'readyMs' | 'ackMs'>> & HostOptions;

  constructor(o: HostOptions) {
    this.o = { readyMs: 20_000, ackMs: 4000, ...o };
    this.supported = (o.platform ?? process.platform) === 'win32' || !!o.spawn;
  }

  status(): HostStatus { return { supported: this.supported, running: !!this.child, results: this.results.slice(), ...(this.note ? { note: this.note } : {}) }; }

  /** Make exactly these keys global (replaces the previous list). Resolves with one answer per binding. */
  set(input: unknown): Promise<HotkeyAnswer[]> {
    const run = this.chain.then(() => this.apply(input), () => this.apply(input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async apply(input: unknown): Promise<HotkeyAnswer[]> {
    const { keep, refused } = planHotkeys(input);
    if (!this.supported) {
      this.results = [...keep.map((k) => ({ id: k.id, ok: false, why: 'Keys that work inside games need Windows. On this computer a key works while the VTube Pro tab is in front.' })), ...refused];
      return this.results;
    }
    this.wants = keep;
    this.note = '';
    if (!keep.length) { this.stop(); this.results = refused; return this.results; }
    if (!(await this.ensure())) {
      this.results = [...keep.map((k) => ({ id: k.id, ok: false, why: 'The key listener did not start. Keys still work while the VTube Pro tab is in front.' })), ...refused];
      return this.results;
    }
    const answers = await this.register();
    this.results = [...answers, ...refused];
    return this.results;
  }

  private async register(): Promise<HotkeyAnswer[]> {
    const c = this.child;
    if (!c?.stdin) return this.wants.map((k) => ({ id: k.id, ok: false, why: 'The key listener stopped.' }));
    c.stdin.write(cmdClear() + '\n');
    this.byHostId.clear();
    const firstOf = new Map<string, string>();                               // combo -> the id Windows knows it by
    const answered = new Map<string, HotkeyAnswer>();
    const waits: Promise<void>[] = [];
    for (const k of this.wants) {
      const host = firstOf.get(k.combo);
      if (host) { this.byHostId.get(host)!.push({ id: k.id, combo: k.combo }); continue; }
      firstOf.set(k.combo, k.id);
      this.byHostId.set(k.id, [{ id: k.id, combo: k.combo }]);
      waits.push(new Promise<void>((done) => {
        const t = setTimeout(() => { this.pending.delete(k.id); answered.set(k.id, { id: k.id, ok: false, why: 'Windows did not answer in time.' }); done(); }, this.o.ackMs);
        this.pending.set(k.id, (a) => { clearTimeout(t); this.pending.delete(k.id); answered.set(k.id, a.ok ? { id: k.id, ok: true } : { id: k.id, ok: false, why: failWhy(a.code) }); done(); });
      }));
      c.stdin.write(cmdReg(k.id, k.mods, k.vk) + '\n');
    }
    await Promise.all(waits);
    return this.wants.map((k) => {
      const host = firstOf.get(k.combo)!;
      const a = answered.get(host)!;
      return { id: k.id, ok: a.ok, ...(a.ok ? {} : { why: a.why }) };
    });
  }

  private ensure(): Promise<boolean> {
    if (this.child && this.ready) return this.ready;
    let c: ChildLike;
    try { c = (this.o.spawn ?? defaultSpawn)(); } catch (e) { this.o.log?.(`[hotkeys] cannot start: ${(e as Error).message}`); return Promise.resolve(false); }
    this.child = c;
    this.ready = new Promise<boolean>((res) => {
      let done = false;
      this.resolveReady = (ok) => { done = true; res(ok); };
      setTimeout(() => { if (!done && this.child === c) { res(false); this.stop(); } }, this.o.readyMs).unref?.();
    });
    if (c.stdout) readline.createInterface({ input: c.stdout }).on('line', (l) => this.onLine(l));
    c.on('error', () => this.gone(c));
    c.on('exit', () => this.gone(c));
    return this.ready;
  }

  private onLine(line: string) {
    const m = parseHostLine(line);
    if (!m) return;
    if (m.t === 'ready') { this.resolveReady?.(true); return; }
    if (m.t === 'ok' || m.t === 'fail') { this.pending.get(m.id)?.({ ok: m.t === 'ok', code: m.t === 'fail' ? m.code : 0 }); return; }
    const b = this.byHostId.get(m.id)?.[0];                                  // (one event per combo, however many bindings share it)
    if (b) { try { this.o.onEvent({ id: b.id, combo: b.combo, phase: m.t }); } catch (e) { this.o.log?.(`[hotkeys] listener: ${(e as Error).message}`); } }
  }

  private gone(c: ChildLike) {
    if (this.child !== c) return;
    this.child = null; this.ready = null; this.resolveReady?.(false); this.resolveReady = null;
    for (const [, f] of [...this.pending]) f({ ok: false, code: 0 });
    // let go of anything that was held, then try again a few times if it died by itself while keys are wanted
    for (const [, list] of this.byHostId) { const b = list[0]; if (b) { try { this.o.onEvent({ id: b.id, combo: b.combo, phase: 'up' }); } catch { /* listener */ } } }
    this.byHostId.clear();
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.wants.length && this.restarts.length < 3) {
      this.restarts.push(now);
      setTimeout(() => { if (this.wants.length && !this.child) void this.set(this.wants.map((w) => ({ id: w.id, combo: w.combo }))); }, 2000).unref?.();
    } else if (this.wants.length) {
      this.note = 'The key listener stopped. Open Keys & pads and press “Check again”.';
      this.results = this.wants.map((w) => ({ id: w.id, ok: false, why: 'The key listener stopped.' }));
    }
  }

  /** Stop the helper process (no keys wanted, or the app is closing). */
  stop() {
    const c = this.child;
    if (!c) return;
    this.child = null; this.ready = null; this.resolveReady?.(false); this.resolveReady = null;
    try { c.stdin?.write(cmdQuit() + '\n'); c.stdin?.end(); } catch { /* already gone */ }
    setTimeout(() => { try { c.kill(); } catch { /* already gone */ } }, 500).unref?.();
    this.byHostId.clear();
  }
}

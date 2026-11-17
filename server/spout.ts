// Spout2 receiver (Windows): a performer whose model is rendered by ANOTHER app (VSeeFace, VTube Studio's Spout2 output,
// Warudo, VNyan, Animaze …) shows up in VTube Pro rooms WITH its alpha (shared/spout.ts, docs/MULTIPLAYER_DISCORD.md →
// "Spout2 performers"). A browser can't read Spout2, so the server runs a tiny helper (tools/spout/spout_rx.py:
// standard-library Python + Windows' own Direct3D 11, NOTHING to install) that copies the sender's shared texture and
// writes raw RGBA / BGRA frames; this module relays them to the studio page over a localhost WebSocket:
//   GET /api/spout                  { available, reason?, python?, senders: [{name, w, h, format, ok}], active }
//   ws  /ws/spout?name=<sender>&fps=<15..60>   binary frames (shared/spout.ts parseSpoutFrame) + JSON status lines
// One helper per sender, shared by every page watching it, stopped 4 s after the last page leaves; it also exits by
// itself when this server dies (--parent-pid). Frames are RAM only (never written anywhere). A page that falls behind
// skips frames (never buffers more than ~2 frames per page). Loopback pages only (the bus's Origin rule).
// Cost (measured 2026-09-29, 1280×720 BGRA @ 30 fps): see docs; the copy is one GPU→CPU readback per frame.
import { lowerPriority } from './lowPriority.ts';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Router } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { SPOUT_HEADER, SPOUT_MAGIC, guessApp, type SpoutStatus } from '../shared/spout.ts';
import { ROOT } from './paths.ts';
import { busOriginOk, onUpgrade } from './bus.ts';
import { streamPcOf } from './streamPcMark.ts';
import { requireLocal } from './routes/util.ts';

const WIN = process.platform === 'win32';
const SCRIPT = path.join(ROOT, 'tools', 'spout', 'spout_rx.py');
const NAME_OK = (s: string) => s.length > 0 && s.length < 256 && !/[\u0000-\u001f]/.test(s);
/** Receivers (one Python each) at once, and the largest frame a sender may hand over (8K × 8K RGBA). */
export const SPOUT_RX_MAX = 4;
export const SPOUT_MAX_SIDE = 8192;
/** A frame header's size is sane: both sides 1..SPOUT_MAX_SIDE (a bad header would otherwise ask for gigabytes). */
export const spoutFrameOk = (w: number, h: number) => Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= SPOUT_MAX_SIDE && h <= SPOUT_MAX_SIDE;

// ---------------------------------------------------------------- Python (any 3.8+: the helper is stdlib-only)
const run = (exe: string, args: string[], ms = 6000) => new Promise<{ code: number; out: string; err: string }>((res) => {
  execFile(exe, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (e, stdout, stderr) => res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: String(stdout), err: String(stderr) }));
});
function candidates(): string[][] {
  const out: string[][] = [];
  if (process.env.VTP_SPOUT_PYTHON) out.push([process.env.VTP_SPOUT_PYTHON]);
  // the GPU extras' venv (if the user set them up) and the bundled Python, then the system's
  for (const p of [path.join(ROOT, '.gpu', 'venv', 'Scripts', 'python.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'VTubePro', 'gpu', 'venv', 'Scripts', 'python.exe')]) {
    try { if (fs.existsSync(p)) out.push([p]); } catch { /* */ }
  }
  out.push(['py', '-3'], ['python'], ['python3']);
  return out;
}
let pyCache: { at: number; py: string[] | null } | null = null;
async function findPython(): Promise<string[] | null> {
  if (pyCache && (pyCache.py || Date.now() - pyCache.at < 60_000)) return pyCache.py;
  let found: string[] | null = null;
  for (const c of candidates()) {
    const r = await run(c[0], [...c.slice(1), '-c', 'import sys,ctypes;print(sys.version_info[0]*100+sys.version_info[1])'], 5000);
    if (r.code === 0 && Number(r.out.trim()) >= 308) { found = c; break; }
  }
  pyCache = { at: Date.now(), py: found };
  return found;
}

// ---------------------------------------------------------------- one helper per sender
interface Rx {
  name: string;
  fps: number;
  proc: ChildProcess | null;
  clients: Set<WebSocket>;
  stopT: ReturnType<typeof setTimeout> | null;
  buf: Buffer[]; bufLen: number; need: number;
  frames: number; rate: number; rateAt: number;
  w: number; h: number; error: string; state: string;
  restarts: number;
}

/** A page joins a receiver: its frame rate, and whether the running receiver restarts faster for it. A paired stream PC's
 *  page (server/streamPc.ts) never sets the rate and never restarts a receiver: that would blank the picture for every
 *  page watching it (security review r2, 2026-10-08). */
export function spoutJoin(cur: { fps: number; running: boolean } | null, asked: number, lan: boolean): { fps: number; restart: boolean } {
  if (lan) return { fps: cur ? cur.fps : 30, restart: false };
  if (!cur) return { fps: asked, restart: false };
  return { fps: Math.max(cur.fps, asked), restart: asked > cur.fps && cur.running };
}

/** A stream PC may watch ONE Spout sender name: the first it asks for. Another name only once it has closed every socket
 *  for the first AND 30 s have passed: a stream PC can't start a crowd of receivers (security review r3, 2026-10-08). */
export function spoutLanName(claim: { name: string; open: number; at: number } | null, name: string, now: number): 'ok' | 'refused' {
  if (!claim || claim.name === name) return 'ok';
  return claim.open === 0 && now - claim.at >= 30_000 ? 'ok' : 'refused';
}

export class SpoutHub {
  /** Per paired stream PC: the one Spout sender name it watches (spoutLanName). */
  private lanNames = new Map<string, { name: string; open: number; at: number }>();
  private rx = new Map<string, Rx>();
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 }); // pages send only small control messages
  private listCache: { at: number; st: SpoutStatus } | null = null;
  constructor(private opts: { registry?: string; originOk?: (o: string | undefined, req?: IncomingMessage) => boolean } = {}) {}

  /** GET /api/spout */
  async status(): Promise<SpoutStatus> {
    const active = [...this.rx.values()].map((r) => ({ name: r.name, fps: r.rate, want: r.fps, clients: r.clients.size, w: r.w, h: r.h, ...(r.error ? { error: r.error } : {}) }));
    if (this.listCache && Date.now() - this.listCache.at < 1500) return { ...this.listCache.st, active };
    // one `python --list` at a time: pickers asking together share it (each used to start its own Python)
    this.listing ??= this.list(active).finally(() => { this.listing = null; });
    const st = await this.listing;
    return { ...st, active };
  }
  private listing: Promise<SpoutStatus> | null = null;
  private async list(active: SpoutStatus['active']): Promise<SpoutStatus> {
    let st: SpoutStatus;
    if (!WIN) st = { available: false, reason: 'Spout2 is a Windows feature.', senders: [], active };
    else if (!fs.existsSync(SCRIPT)) st = { available: false, reason: 'tools/spout/spout_rx.py is missing (reinstall VTube Pro).', senders: [], active };
    else {
      const py = await findPython();
      if (!py) st = { available: false, reason: 'Needs Python 3 (any version from python.org or the Microsoft Store — nothing else to install). Or use SpoutCam / OBS Virtual Camera (no alpha).', senders: [], active };
      else {
        const r = await run(py[0], [...py.slice(1), SCRIPT, '--list', ...(this.opts.registry ? ['--registry', this.opts.registry] : [])], 8000);
        try {
          const j = JSON.parse(r.out.trim().split(/\r?\n/).pop() ?? '{}') as { senders?: { name: string; w: number; h: number; format: number; ok: boolean; why?: string }[]; d3d11?: boolean };
          st = { available: j.d3d11 !== false, ...(j.d3d11 === false ? { reason: 'Direct3D 11 is not available on this PC (a remote desktop / VM?).' } : {}), python: py.join(' '), senders: (j.senders ?? []).map((s) => ({ ...s, app: guessApp(s.name) })), active };
        } catch { st = { available: false, reason: `The Spout2 helper failed: ${(r.err || r.out).trim().slice(-300) || `exit ${r.code}`}`, python: py.join(' '), senders: [], active }; }
      }
    }
    this.listCache = { at: Date.now(), st };
    return st;
  }

  /** ws /ws/spout upgrade (the caller already checked the loopback Host / the stream PC gate). */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (this.opts.originOk && !this.opts.originOk(req.headers.origin, req)) { socket.destroy(); return; }
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const name = q.get('name') ?? '';
    const fps = Math.round(Math.min(60, Math.max(15, Number(q.get('fps')) || 30)));
    if (!NAME_OK(name)) { socket.destroy(); return; }
    if (!this.rx.has(name) && this.rx.size >= SPOUT_RX_MAX) { socket.destroy(); return; }   // a page can't start a crowd of Pythons
    const lanPc = streamPcOf(req)?.id; // a paired stream PC's page: never sets the rate (spoutJoin), ONE sender name (spoutLanName)
    if (lanPc) {
      const c = this.lanNames.get(lanPc) ?? null;
      if (spoutLanName(c, name, Date.now()) !== 'ok') { socket.destroy(); return; }
      this.lanNames.set(lanPc, { name, open: (c && c.name === name ? c.open : 0) + 1, at: Date.now() });
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (lanPc) ws.on('close', () => { const c = this.lanNames.get(lanPc); if (c && c.name === name) { c.open = Math.max(0, c.open - 1); c.at = Date.now(); } });
      this.join(ws, name, fps, !!lanPc);
    });
  }

  private join(ws: WebSocket, name: string, asked: number, lan = false) {
    let r = this.rx.get(name);
    const j = spoutJoin(r ? { fps: r.fps, running: !!r.proc } : null, asked, lan);
    const fps = j.fps;
    if (!r) { r = { name, fps, proc: null, clients: new Set(), stopT: null, buf: [], bufLen: 0, need: SPOUT_HEADER, frames: 0, rate: 0, rateAt: Date.now(), w: 0, h: 0, error: '', state: 'waiting', restarts: 0 }; this.rx.set(name, r); }
    r.clients.add(ws);
    if (r.stopT) { clearTimeout(r.stopT); r.stopT = null; }
    if (j.restart) { r.fps = fps; this.stop(r); }                   // someone on this PC wants more frames: restart faster
    r.fps = fps;
    ws.send(JSON.stringify({ type: 'status', state: r.state, sender: name, ...(r.w ? { w: r.w, h: r.h } : {}), ...(r.error ? { error: r.error } : {}) }));
    void this.start(r);
    ws.on('close', () => {
      r!.clients.delete(ws);
      if (!r!.clients.size) r!.stopT = setTimeout(() => { if (!r!.clients.size) { this.stop(r!); this.rx.delete(name); } }, 4000);
    });
    ws.on('error', () => ws.terminate());
  }

  private broadcast(r: Rx, text: string) { for (const c of r.clients) if (c.readyState === WebSocket.OPEN) c.send(text); }

  private async start(r: Rx) {
    if (r.proc) return;
    const py = WIN ? await findPython() : null;
    if (!py) { r.state = 'error'; r.error = (await this.status()).reason ?? 'Spout2 receiver unavailable'; this.broadcast(r, JSON.stringify({ type: 'status', state: 'error', sender: r.name, error: r.error })); return; }
    if (r.proc || !r.clients.size) return;
    const p = spawn(py[0], [...py.slice(1), '-u', SCRIPT, '--recv', r.name, '--fps', String(r.fps), '--parent-pid', String(process.pid), ...(this.opts.registry ? ['--registry', this.opts.registry] : [])],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
    r.proc = p; r.buf = []; r.bufLen = 0; r.need = SPOUT_HEADER;
    lowerPriority(p.pid);                                              // (the game wins the processor; the Spout picture is not the tracking)
    p.stdout!.on('data', (d: Buffer) => this.onData(r, d));
    let errTail = '';
    p.stderr!.on('data', (d: Buffer) => {
      errTail += d.toString('utf8');
      const lines = errTail.split(/\r?\n/); errTail = lines.pop() ?? '';
      for (const l of lines) {
        try {
          const m = JSON.parse(l) as { state?: string; error?: string; w?: number; h?: number; format?: number };
          if (!m.state) continue;
          r.state = m.state; r.error = m.error ?? '';
          if (m.w) { r.w = m.w; r.h = m.h ?? 0; }
          this.broadcast(r, JSON.stringify({ type: 'status', state: m.state, sender: r.name, ...(m.w ? { w: m.w, h: m.h } : {}), ...(m.format !== undefined ? { format: m.format } : {}), ...(m.error ? { error: m.error } : {}) }));
        } catch { if (l.trim()) r.error = l.trim().slice(0, 300); }
      }
    });
    p.on('error', (e) => { r.error = `Couldn’t start the Spout2 helper: ${e.message}`; r.state = 'error'; });
    p.on('exit', (code) => {
      if (r.proc !== p) return;
      r.proc = null;
      if (!r.clients.size || !this.rx.has(r.name)) return;
      // crashed while watched: tell the pages and retry (1, 2, 4 … 15 s); code 2 = no Windows / D3D11: don't
      this.broadcast(r, JSON.stringify({ type: 'status', state: code === 2 ? 'error' : 'lost', sender: r.name, error: r.error || `helper exited (${code})` }));
      if (code === 2) return;
      const wait = Math.min(15_000, 1000 * 2 ** Math.min(4, r.restarts++));
      setTimeout(() => { if (r.clients.size && this.rx.get(r.name) === r) void this.start(r); }, wait);
    });
  }

  /** stdout → whole frames (32-byte header + w×h×4) → every page that isn't behind. */
  private onData(r: Rx, d: Buffer) {
    r.buf.push(d); r.bufLen += d.length;
    while (r.bufLen >= r.need) {
      const all = r.buf.length === 1 ? r.buf[0] : Buffer.concat(r.buf, r.bufLen);
      if (r.need === SPOUT_HEADER) {
        if (all.readUInt32LE(0) !== SPOUT_MAGIC) { r.error = 'bad frame from VTube Pro'; this.stop(r); return; }
        const w = all.readUInt32LE(4), h = all.readUInt32LE(8);
        if (!spoutFrameOk(w, h)) { r.error = `bad frame size from VTube Pro (${w}×${h})`; this.stop(r); return; }
        r.need = SPOUT_HEADER + w * h * 4;
        r.buf = [all]; r.bufLen = all.length;
        continue;
      }
      const frame = all.subarray(0, r.need);
      const rest = all.subarray(r.need);
      r.buf = rest.length ? [Buffer.from(rest)] : []; r.bufLen = rest.length; r.need = SPOUT_HEADER;
      r.w = frame.readUInt32LE(4); r.h = frame.readUInt32LE(8);
      r.frames++;
      const now = Date.now();
      if (now - r.rateAt >= 1000) { r.rate = Math.round((r.frames * 1000) / (now - r.rateAt)); r.frames = 0; r.rateAt = now; r.restarts = 0; }
      for (const c of r.clients) if (c.readyState === WebSocket.OPEN && c.bufferedAmount < frame.length * 2) c.send(frame, { binary: true });
    }
  }

  private stop(r: Rx) {
    const p = r.proc;
    r.proc = null;
    if (p && p.exitCode === null) { try { p.kill(); } catch { /* */ } }
  }

  dispose() { for (const r of this.rx.values()) this.stop(r); this.rx.clear(); this.wss.close(); }
}

// ---------------------------------------------------------------- the app's instance + routes
export const spoutRoutes = Router();
let hub: SpoutHub | null = null;
/** Wire into the app (server/index.ts): the upgrade path goes through the bus's router (loopback Host + Origin). */
export function attachSpout() {
  if (hub) return;
  // VTP_SPOUT_REGISTRY: a PRIVATE sender list for tests (tools/spout/spout_test_sender.py --registry), so a smoke test of
  // a built helper never sees or touches the real Spout apps on the PC. Unset = the real list.
  const reg = process.env.VTP_SPOUT_REGISTRY;
  hub = new SpoutHub({ ...(reg && /^[A-Za-z0-9_]{1,64}$/.test(reg) ? { registry: reg } : {}),
    originOk: (o, req) => busOriginOk(o) || (!!req && !!streamPcOf(req)) }); // + a paired stream PC
  onUpgrade('/ws/spout', (req, socket, head) => hub!.upgrade(req, socket, head));
}
spoutRoutes.get('/api/spout', async (req, res) => {
  requireLocal(req);
  res.json(hub ? await hub.status() : { available: false, reason: 'Spout2 receiver not started', senders: [], active: [] });
});

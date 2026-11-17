// DJ sync REST + the studio's MIDI socket.
//   GET  /api/music                      → MusicView (config, per-adapter status, sources best first, the live clock)
//   PUT  /api/music                      → merge a config patch (turn DJ sync on, adapters, ports, opt-ins) → MusicView
//   POST /api/music/tap        { t }     → tap tempo (t = the page's epoch ms of the tap) → { bpm, taps }
//   POST /api/music/tap/clear            → forget the tapped tempo
//   POST /api/music/downbeat   { t }     → "this is beat 1"
//   POST /api/music/calibration/reset    → measure the latency again
//   POST /api/music/carabiner/start      → start the Carabiner program the user downloaded (button click, this PC only)
//   POST /api/music/firewall             → Windows: one firewall rule "VTube Pro DJ sync" for the DJ ports (UAC prompt)
//   GET  /api/music/deck                 → DJ decks: the controller the decks copy, its profile, teach / record state
//   POST /api/music/deck/learn { do: 'start'|'skip'|'cancel'|'forget'|'bind', part?, kind? } → teach my controller
//   POST /api/music/deck/record { sec? } → record the controller's raw MIDI for 20 s into cache/diag (debug)
//   WS   /ws/music                       ← the studio page forwards Web MIDI: { type:'midi', port, m: [[t, st, d1, d2]…], busy? }
// Wiring (server/index.ts): const music = createMusic(); app.use(music.routes); music.start(wss).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { WebSocketServer } from 'ws';
import { broadcast, busRequestOk, onUpgrade } from '../bus.ts';
import { HttpError } from '../library.ts';
import { DATA_DIR } from '../paths.ts';
import { requireLocal } from '../routes/util.ts';
import { elevatedFileCommand, psScriptExists, psScriptPath } from '../psLaunch.ts';
import type { BusMessage } from '../../shared/types.ts';
import { MusicHub, type MusicConfig } from './hub.ts';
import { libraryRoutes } from './libraryRoutes.ts';
import type { MidiMsg } from './midi.ts';

const USER_ACTION = 'x-vtp-user-action';

export const DJ_FIREWALL_RULE = 'VTube Pro DJ sync';
/** The ports DJ gear sends to (inbound): Pro DJ Link, StageLinQ discovery, Art-Net, sACN, OSC (UDP); OS2L (TCP). */
export function djPorts(c: MusicConfig): { udp: number[]; tcp: number[] } {
  // (OSC / OS2L only when the user let DJ apps on another computer in)
  return { udp: [50000, 50001, 50002, 51337, 6454, 5568, ...(c.appsListen ? [c.oscPort] : [])], tcp: c.appsListen ? [c.os2lPort] : [] };
}
/** The inputs of tools/helper/win/ps/firewall_dj.ps1 (the ONE elevated script: replaces the rule named DJ_FIREWALL_RULE with an
 *  inbound allow on the Private profile for these ports). Validated integers only; the rule name and text are in the script. */
export function djFirewallParams(p: { udp: number[]; tcp: number[] }): Array<[name: string, value: string]> {
  const ports = (xs: number[]) => [...new Set(xs.filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535))].join(',');
  const udp = ports(p.udp), tcp = ports(p.tcp);
  return [['Udp', udp], ...(tcp ? [['Tcp', tcp] as [string, string]] : [])];
}

/** Where the user may have put Carabiner (the Ableton Link bridge they download themselves). */
export function findCarabiner(configured: string): string | null {
  const exe = process.platform === 'win32' ? 'Carabiner.exe' : 'Carabiner';
  const cands: string[] = [];
  if (configured) cands.push(configured);
  for (const base of [path.join(DATA_DIR, 'tools'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]) {
    cands.push(path.join(base, exe));
    try { for (const d of fs.readdirSync(base)) if (/^carabiner/i.test(d)) cands.push(path.join(base, d, exe), path.join(base, d)); } catch { /* no folder */ }
  }
  for (const c of cands) { try { const st = fs.statSync(c); if (st.isFile() && /carabiner(\.exe)?$/i.test(c)) return c; } catch { /* not there */ } }
  return null;
}

export function createMusic() {
  const hub = new MusicHub({ broadcast: (m) => broadcast(m as BusMessage) });
  const r = Router();
  const userAction = (req: { headers: Record<string, unknown> }) => { if (req.headers[USER_ACTION] !== '1') throw new HttpError(403, 'Press the button in VTube Pro on this PC'); };
  const tNum = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'Expected { t: epoch ms }'); return v; };

  r.get('/api/music', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ...hub.view(), carabiner: findCarabiner(hub.config.carabinerPath) ? 'found' : 'missing' }); });
  r.put('/api/music', async (req, res) => {
    requireLocal(req);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Expected a JSON object');
    await hub.update(req.body);
    res.json(hub.view());
  });
  r.post('/api/music/tap', (req, res) => { requireLocal(req); res.json(hub.tapTempo(tNum(req.body?.t))); });
  r.post('/api/music/tap/clear', (req, res) => { requireLocal(req); hub.clearTap(); res.json({ ok: true }); });
  r.post('/api/music/downbeat', (req, res) => { requireLocal(req); hub.downbeat(tNum(req.body?.t)); res.json({ ok: true }); });
  r.post('/api/music/calibration/reset', (req, res) => { requireLocal(req); hub.arbiter.resetCalibration(); res.json({ ok: true }); });
  r.post('/api/music/carabiner/start', (req, res) => {
    requireLocal(req); userAction(req);
    const exe = findCarabiner(hub.config.carabinerPath);
    if (!exe) { res.json({ ok: false, says: 'Carabiner isn’t on this PC yet. Download it (free), unzip it into your Downloads folder, then press Start again.' }); return; }
    if (process.env.VTP_TOOLS_DRYRUN === '1') { res.json({ ok: true, dryRun: true, says: `Would start ${exe}` }); return; }
    try {
      const c = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
      c.on('error', () => {});
      c.unref();
      res.json({ ok: true, says: 'Carabiner is starting — it connects in a few seconds.' });
    } catch (e) { res.json({ ok: false, says: `Carabiner didn’t start: ${(e as Error).message}` }); }
  });
  let fwBusy = false;
  r.post('/api/music/firewall', async (req, res) => {
    requireLocal(req); userAction(req);
    if (process.platform !== 'win32') { res.json({ ok: true, says: 'Nothing to do: only Windows needs this.' }); return; }
    if (fwBusy) { res.json({ ok: false, says: 'Windows is already asking. Look for its prompt.' }); return; }
    const script = psScriptPath('firewall_dj.ps1');
    const plan = elevatedFileCommand(script, djFirewallParams(djPorts(hub.config)));
    if (process.env.VTP_TOOLS_DRYRUN === '1') { res.json({ ok: true, dryRun: true, says: 'Dry run: nothing changed.' }); return; }
    fwBusy = true;
    try {
      const code = await new Promise<number>((resolve) => {
        if (!psScriptExists(script)) { resolve(-1); return; } // (script missing: fails like PowerShell failing, nothing runs)
        const c = spawn(plan.command, plan.args, { windowsHide: true, stdio: 'ignore' });
        c.on('error', () => resolve(-1)); c.on('exit', (n) => resolve(n ?? -1));
      });
      res.json(code === 0 ? { ok: true, says: 'Done: DJ gear on your home network can reach VTube Pro now.' } : { ok: false, says: 'Windows didn’t get a “Yes”, so nothing changed. Press the button again and choose Yes.' });
    } finally { fwBusy = false; }
  });

  // DJ decks (server/music/deckRig.ts): teach / record (this PC only)
  r.get('/api/music/deck', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(hub.deck.view()); });
  // (Teach / Record change what VTube Pro keeps or writes: only a click in the studio, which sends x-vtp-user-action like
  //  Firewall / Carabiner — never a page calling in by itself)
  r.post('/api/music/deck/learn', (req, res) => {
    requireLocal(req); userAction(req);
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { do?: unknown; part?: unknown; kind?: unknown };
    try {
      switch (b.do) {
        case 'start': res.json(hub.deck.startLearn()); return;
        case 'skip': res.json(hub.deck.skipLearn()); return;
        case 'cancel': res.json(hub.deck.cancelLearn()); return;
        case 'forget': res.json(hub.deck.forget()); return;
        case 'bind': {
          const part = typeof b.part === 'string' && /^(?:[LR]|ch[1-4]|m)\.[A-Za-z]{1,10}\d?$/.test(b.part) ? b.part : null;
          const kind = typeof b.kind === 'string' && /^(jog|tempo|fader|xfader|knob|button|pad|lever|encoder)$/.test(b.kind) ? b.kind as Parameters<typeof hub.deck.bind>[1] : null;
          if (!part || !kind) throw new HttpError(400, 'Expected { part, kind }');
          res.json({ ...hub.deck.bind(part, kind), view: hub.deck.view() }); return;
        }
        default: throw new HttpError(400, "Expected { do: 'start' | 'skip' | 'cancel' | 'forget' | 'bind' }");
      }
    } catch (e) { if (e instanceof HttpError) throw e; res.json({ ok: false, says: (e as Error).message, view: hub.deck.view() }); }
  });
  r.post('/api/music/deck/record', (req, res) => {
    requireLocal(req); userAction(req);
    const sec = typeof req.body?.sec === 'number' && Number.isFinite(req.body.sec) ? req.body.sec : 20;
    try { res.json({ ok: true, view: hub.deck.record(sec) }); } catch (e) { res.json({ ok: false, says: (e as Error).message, view: hub.deck.view() }); }
  });

  // the studio's Web MIDI forwarding
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
  onUpgrade('/ws/music', (req, socket, head) => {
    if (!busRequestOk(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw, bin) => {
        if (bin) return;
        let m: { type?: unknown; port?: unknown; m?: unknown; busy?: unknown };
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === 'feat') {   // music-input onsets (Track library audio matching): { f: onset 0..255 ×n, l? / mi? / hi?: band onsets, at, sent }
          const f = m as { f?: unknown; l?: unknown; mi?: unknown; hi?: unknown; at?: unknown; sent?: unknown; sid?: unknown; pf?: unknown; pat?: unknown; pk?: unknown };
          const arr = (v: unknown) => (Array.isArray(v) && v.length <= 200 ? v.filter((x): x is number => typeof x === 'number').map((x) => Math.max(0, Math.min(255, x | 0))) : null);
          const on = arr(f.f);
          if (on && typeof f.at === 'number' && Number.isFinite(f.at) && typeof f.sent === 'number' && Number.isFinite(f.sent)) hub.tracks.features(on, f.at, f.sent, { low: arr(f.l) ?? undefined, mid: arr(f.mi) ?? undefined, high: arr(f.hi) ?? undefined });
          // landmark peaks: [stream frame, pitch × 100] pairs + where the newest frame was (page clock)
          if (typeof f.sid === 'string' && /^[a-z0-9]{1,16}$/.test(f.sid) && typeof f.pf === 'number' && Number.isFinite(f.pf) && typeof f.pat === 'number' && Number.isFinite(f.pat) && typeof f.sent === 'number' && Array.isArray(f.pk) && f.pk.length <= 1200) {
            const pk: { f: number; m: number; v: number }[] = [];
            for (let i = 0; i + 1 < f.pk.length; i += 2) { const fr = f.pk[i], mc = f.pk[i + 1]; if (typeof fr === 'number' && Number.isInteger(fr) && fr >= 0 && typeof mc === 'number' && mc > 3000 && mc < 12000) pk.push({ f: fr, m: mc / 100, v: 0 }); }
            hub.tracks.peaks(f.sid, pk, f.pf, f.pat, f.sent);
          }
          return;
        }
        if (m.type !== 'midi') return;
        const msgs = Array.isArray(m.m) ? m.m.filter((x): x is MidiMsg => Array.isArray(x) && x.length === 4 && x.every((v) => typeof v === 'number' && Number.isFinite(v))) : [];
        hub.midi(typeof m.port === 'string' ? m.port : '', msgs, Array.isArray(m.busy) ? m.busy.filter((b): b is string => typeof b === 'string') : undefined);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  r.use(libraryRoutes(() => hub.tracks, DATA_DIR));   // Track library (server/music/libraryRoutes.ts)
  return {
    hub,
    routes: r,
    start(busWss: WebSocketServer) { hub.attachBus(busWss); void hub.init().catch((e) => console.log(`[music] ${(e as Error).message}`)); },
  };
}

// Live captions: HTTP + websocket endpoints (docs/LIVE_CAPTIONS.md). Everything is for pages on THIS PC.
//   GET  /api/captions/status            → state, installed models, engine, lag numbers, files, advice
//   PUT  /api/captions/config {on?, model?, lang?, device?, showTentative?, offsetSec?}
//   POST /api/captions/mark              → "my recording starts now": a new SRT / VTT pair whose time zero is this moment
//   GET  /api/captions/files             → the SRT / VTT files of past sessions · GET /api/captions/files/:name downloads one
//   ws   /ws/captions-in                 → the studio streams the voice front end's 16 kHz audio (server/captions/manager.ts)
//   ws   /ws/captions                    → the OBS overlay page (captions.html) listens
// The caption engine and the model are installed from the card with POST /api/voice/setup (server/voice/routes.ts).
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { busOriginOk, onUpgrade } from '../bus.ts';
import { CACHE_DIR, CONFIG_DIR } from '../paths.ts';
import { HttpError } from '../library.ts';
import { requireLocal } from '../routes/util.ts';
import { voiceSetup } from '../voice/routes.ts';
import { CaptionManager } from './manager.ts';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';


export const captions = new CaptionManager({
  setup: voiceSetup,
  configFile: path.join(CONFIG_DIR, 'captions.json'),
  filesDir: path.join(CACHE_DIR, 'captions'),
  port: Number(process.env.VTP_WHISPER_PORT) || 5200,
});

const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const local = (req: IncomingMessage) => LOOPBACK.test(req.socket.remoteAddress ?? '') && busOriginOk(req.headers.origin);
const gate = (fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!local(req)) { socket.destroy(); return; }
  fn(req, socket, head);
};
export function attachCaptionSockets(m: CaptionManager = captions) {
  onUpgrade('/ws/captions-in', gate((req, socket, head) => m.upgradeSource(req, socket, head)));
  onUpgrade('/ws/captions', gate((req, socket, head) => m.upgradeOverlay(req, socket, head)));
}

export function captionRoutes(m: CaptionManager = captions) {
  const r = Router();
  r.get('/api/captions/status', async (req, res) => { requireLocal(req); const st = await m.status(); res.json(st); });
  r.put('/api/captions/config', async (req, res) => {
    requireLocal(req);
    const cfg = await m.setConfig(req.body);
    res.json({ config: cfg, state: m.state, detail: m.detail });
  });
  r.post('/api/captions/mark', (req, res) => { requireLocal(req); res.json({ files: m.mark() }); });
  r.get('/api/captions/files', (req, res) => { requireLocal(req); res.json({ files: m.files.list() }); });
  r.get('/api/captions/files/:name', (req, res) => {
    requireLocal(req);
    const f = m.files.resolve(String(req.params.name));
    if (!f) throw new HttpError(404, 'No such caption file');
    res.setHeader('Content-Type', f.endsWith('.vtt') ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(f)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(fs.readFileSync(f));
  });
  return r;
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) process.once(sig, () => { try { captions.shutdown(); } catch { /* */ } if (sig !== 'exit') process.exit(0); });

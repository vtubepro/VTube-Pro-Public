// Two small routes for tools on this computer:
//   GET  /health                 { ok, version }: "is VTube Pro answering on this port?" (the launcher, the studio's own start-up
//                                reads). Nothing else, ever: no names, paths or settings.
//   POST /api/helper/shutdown    another VTube Pro copy on this computer (tools/launcher/start.ps1, "Stop it and start this
//                                one?") asks this one to stop. Refused (409) while OBS is streaming, a broadcast VTube Pro
//                                started is on the air, an OBS page is showing VTube Pro, a party is open or a ComfyUI setup
//                                is downloading, so a stream is never cut. Never for a browser page.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { outputPages } from '../bus.ts';
import { comfySetupRunning } from '../comfyInstall.ts';
import { guestViewerConnected } from '../guestFeed.ts';
import { activeBackend } from '../broadcast/backend.ts';
import { obs } from '../obs.ts';
import { vaultStats } from '../partyVault.ts';
import { HttpError } from '../library.ts';
import { ROOT } from '../paths.ts';
import { requireLocal } from './util.ts';

export const healthRoutes = Router();

let version = '0.0.0';
try { version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? version); } catch { /* keep */ }
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

healthRoutes.get('/health', (_req, res) => {
  noStore(res);
  res.json({ ok: true, version }); // nothing else, ever: no names, ids, paths or settings
});

/** Is a broadcast this VTube Pro started running? Never throws and never waits more than 2 s (unreachable = unknown = null). */
async function broadcastActive(): Promise<boolean | null> {
  try {
    const ask = async () => {
      const b = await activeBackend();
      if (!b || typeof b.status !== 'function') return null;
      const st = await b.status();
      return st && st.reachable !== false ? st.outputActive === true : null;
    };
    return await Promise.race([ask(), new Promise<null>((res) => setTimeout(() => res(null), 2000).unref?.())]);
  } catch { return null; }
}

/** Why this copy must not stop right now ('' = it may). */
async function whyBusy(): Promise<string> {
  const pages = outputPages().count;
  const obsOn = pages > 0 || obs.cfg.enabled ? await obs.outputActive() : null;
  const bc = await broadcastActive();
  if (obsOn === true || bc === true) return 'live';
  if (vaultStats().sessions > 0 || guestViewerConnected()) return 'party';
  if (comfySetupRunning()) return 'setup';
  if (pages > 0 && obsOn !== false) return 'obs';
  return '';
}

function fromAnotherCopy(req: Request) {
  requireLocal(req);
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw new HttpError(403, 'not for web pages');
}
healthRoutes.post('/api/helper/shutdown', async (req, res) => {
  fromAnotherCopy(req); noStore(res);
  if (req.headers['x-vtp-shutdown'] !== '1') throw new HttpError(400, 'missing x-vtp-shutdown: 1');
  const why = await whyBusy();
  if (why) { res.status(409).json({ ok: false, busy: true, why }); return; }
  res.json({ ok: true });
  console.log('[vtube-pro] another VTube Pro on this computer asked this one to stop: stopping');
  setTimeout(() => process.exit(0), 300).unref?.();
});

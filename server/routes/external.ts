// External tracking sources (VTube Studio phone app / MeowFace, iFacialMocap, Live Link Face, VMC, VTube Studio API plugins).
//   GET    /api/external                 → { config, status, lan }   (status: per source running/port/phone IP/packets/s/last seen/errors)
//   PUT    /api/external                 → merge config patch, (re)start/stop listeners live → { config, status }
//   GET    /api/external/vts/pending     → plugins waiting for approval
//   POST   /api/external/vts/approve     { id, allow } → hand the token to the plugin (or deny)
//   GET    /api/external/vts/tokens      → approved plugins (no secrets)
//   DELETE /api/external/vts/tokens/:id  → revoke (also accepts DELETE /api/external/vts/tokens { id })
//   GET    /api/external/phone-net[?fresh=1] → { lan (the ONE address + broadcast + hidden), firewall, profile, ports }
//   POST   /api/external/firewall        → the user pressed "Let phones connect": ONE elevated rule add (UAC prompt)
//   POST   /api/external/network-settings → open Windows' network page (switch Public → Private there; never done for them)
//   GET|POST /api/external/detect        → "Find my phone": { on } starts/stops listening on every phone port; answers { on, found[], skipped[] }
import { Router } from 'express';
import type { WebSocketServer } from 'ws';
import { broadcast } from '../bus.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { HttpError, avatarList, listedAvatar } from '../library.ts';
import { ExternalManager } from '../tracking/manager.ts';
import { requireLocal } from './util.ts';
import { addFirewallRule, lanPick, openNetworkSettings, phoneNetView } from '../tracking/phoneNet.ts';
import { discoveryTargets } from '../../shared/phoneNet.ts';

// The Windows firewall prompt and opening Windows Settings only ever start from a page on THIS PC (the helper's own studio),
// never from another website (server/localGuard.ts answers 403 local-only).
// (a trailing slash and any letter case reach the same Express route: matched here too)
/** The page sends this only from a click (navigator.userActivation): a script can't press the button by accident. */
const USER_ACTION = 'x-vtp-user-action';

export function externalRoutes(ext: ExternalManager) {
  const r = Router();
  // `lan`: the ONE address a phone should use (VPN / Hyper-V / WSL / virtual adapters and IPv6 hidden: shared/phoneNet.ts)
  const view = async () => { const p = await lanPick(); return { config: ext.config, status: ext.status(), lan: p.address ? [p.address] : [], lanPick: p }; };

  r.get('/api/external', async (_req, res) => { res.json(await view()); });

  r.put('/api/external', async (req, res) => {
    requireLocal(req);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Expected a JSON object');
    await ext.update(req.body);
    res.json(await view());
  });

  r.get('/api/external/phone-net', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await phoneNetView(ext.receivePorts(), req.query.fresh === '1'));
  });
  let lastFw = 0;
  r.post('/api/external/firewall', async (req, res) => {
    requireLocal(req);
    if (req.headers[USER_ACTION] !== '1') throw new HttpError(403, 'Press the button in VTube Pro on this PC');
    if (Date.now() - lastFw < 2000) { res.status(429).json({ ok: false, says: 'One moment…' }); return; }
    lastFw = Date.now();
    const out = await addFirewallRule(ext.receivePorts());
    res.json({ ...out, view: await phoneNetView(ext.receivePorts(), true) });
  });
  r.post('/api/external/network-settings', async (req, res) => {
    requireLocal(req);
    if (req.headers[USER_ACTION] !== '1') throw new HttpError(403, 'Press the button in VTube Pro on this PC');
    const p = await lanPick();
    res.json(openNetworkSettings(p.iface));
  });

  // "That's not my phone": forget the locked-in sender of one source → { ok }
  r.post('/api/external/forget-phone', (req, res) => {
    requireLocal(req);
    const k = (req.body ?? {}).source;
    if (k !== 'vtsPhone' && k !== 'ifacialmocap' && k !== 'liveLinkFace' && k !== 'vmc') throw new HttpError(400, 'Which source?');
    res.json({ ok: ext.forgetPhone(k) });
  });

  // "Another phone is sending - use it?" [Use it]: the device that knocked while the lock was held takes over → { ok }
  r.post('/api/external/switch-phone', (req, res) => {
    requireLocal(req);
    const k = (req.body ?? {}).source;
    if (k !== 'vtsPhone' && k !== 'ifacialmocap' && k !== 'liveLinkFace' && k !== 'vmc') throw new HttpError(400, 'Which source?');
    res.json({ ok: ext.switchPhone(k) });
  });

  // "Find my phone": listen on every known phone port at once and name the app that sends → { on, since, found[], skipped[] }
  r.get('/api/external/detect', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(ext.detectView()); });
  r.post('/api/external/detect', async (req, res) => {
    requireLocal(req);
    const on = (req.body ?? {}).on;
    if (typeof on !== 'boolean') throw new HttpError(400, 'Body must be { on: boolean }');
    if (on) await ext.detectStart(); else await ext.detectStop();
    res.json(ext.detectView());
  });

  r.get('/api/external/vts/pending', (_req, res) => { res.json(ext.vtsPending()); });

  r.post('/api/external/vts/approve', (req, res) => {
    requireLocal(req);
    const { id, allow } = (req.body ?? {}) as { id?: unknown; allow?: unknown };
    if (typeof id !== 'string' || typeof allow !== 'boolean') throw new HttpError(400, 'Body must be { id: string, allow: boolean }');
    if (!ext.vtsDecide(id, allow)) throw new HttpError(404, 'No such pending request (it may have timed out)');
    res.json({ ok: true });
  });

  r.get('/api/external/vts/tokens', (_req, res) => { res.json(ext.vtsTokens()); });

  const revoke = (id: unknown) => {
    if (typeof id !== 'string' || !id) throw new HttpError(400, 'Token id required');
    if (!ext.vtsRevoke(id)) throw new HttpError(404, 'No such token');
    return { ok: true };
  };
  r.delete('/api/external/vts/tokens/:id', (req, res) => { requireLocal(req); res.json(revoke(req.params.id)); });
  r.delete('/api/external/vts/tokens', (req, res) => { requireLocal(req); res.json(revoke((req.body as { id?: unknown } | undefined)?.id)); });

  return r;
}

/**
 * One-call wiring for server/index.ts: builds the manager on the real bus + avatar library.
 *   const external = createExternal();
 *   app.use(external.routes);
 *   external.start(attachBus(server));
 */
export function createExternal() {
  const info = (p: Readonly<AvatarProfile>) => ({
    id: p.id, name: p.name, thumbnail: p.thumbnail,
    costumes: (p.costumes ?? []).map((c) => ({ id: c.id, name: c.name })),
  });
  const manager = new ExternalManager({
    publish: (d) => broadcast({ type: 'ext', data: d }),
    broadcast,
    // from the in-memory avatar catalog (server/library.ts): a plugin polling the current model at 10 Hz costs nothing
    listAvatars: () => avatarList().map(info),
    getAvatar: (id) => { const p = listedAvatar(id); return p ? info(p) : null; },
    // the phone discovery broadcast: this PC's subnet + 255.255.255.255 (tests: VTP_PHONE_DISCOVERY_TARGETS=127.0.0.1)
    discoveryTargets: async () => {
      const t = process.env.VTP_PHONE_DISCOVERY_TARGETS;
      if (t) return t.split(',').map((x) => x.trim()).filter((x) => /^[0-9.]+$/.test(x));
      return discoveryTargets(await lanPick());
    },
  });
  return {
    manager,
    routes: externalRoutes(manager),
    start(wss: WebSocketServer) {
      manager.attachBus(wss);
      void manager.init();
    },
  };
}

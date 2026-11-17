// Support & store API (beta.13). Every route is this-PC-only (requireLocal) and, through server/localGuard.ts, open to
// this PC's pages, EXCEPT the ones that touch keys: those refuse any web Origin (403 local-only) - keys are
// pasted in the local studio or on the helper's own page /support/connect, and are never sent back to anyone.
//
//   GET  /api/support/status                          SupportStatus (services, vault kind, inbox, rates) - never a key
//   GET  /api/support/settings | PUT                  SupportSettings (no secrets in there)
//   PUT  /api/support/secrets/:service  {fields}      save keys (encrypted, this PC)               [local only]
//   DELETE /api/support/secrets/:service              forget them + switch the service off          [local only]
//   POST /api/support/test {which?}                   test events (test:true) for one source or all ('all')
//   GET  /api/support/events?n=100                    the latest events (moderation + refunds applied)
//   GET  /api/support/log?since=<ISO>                 every event since: what goals / timers sum over
//   POST /api/support/moderate {id, moderated}        ok | hidden  → bus {type:'support-mod'}
//   POST /api/support/void {id, why?}                 a refund / remove (goals drop it)
//   POST /api/support/manual {name, amount, currency, message, kind}
//   POST /api/support/inbox {service}                 → { url } this service's webhook address (makes the inbox once)
//   DELETE /api/support/inbox/:service                stop taking that service's webhooks
//   POST /api/support/inbox/rotate                    new address secret (paste the new addresses again)
//   POST /api/support/hook/:service  (raw body)       a webhook straight to this PC (Stripe CLI `stripe listen
//                                                     --forward-to`, tests); same signature checks              [local only]
//   GET  /api/support/store | POST /refresh           products, collections (cached)
//   POST /api/support/store/product/:id {listed, confirm:true}       show / hide in the shop          (live store!)
//   PUT  /api/support/store/collection/:id {offerIds, confirm:true}  a collection's products         (live store!)
//   POST /api/support/store/promo {code, percent|flat|freeShipping, minutes, maxUses, confirm:true} (live store!)
//   GET  /api/support/store/promos | DELETE /api/support/store/promo/:id
//   GET  /api/support/showcase                        ShowcaseView (OBS pages that load later)
//   GET  /api/support/img/<b64url>                    a product / item image through this PC (cached)
//   GET  /api/support/supporters                      { list, members, claims } (pages: list only)
//   POST /api/support/supporters/code {linkedId}      a 24 h `!link` code
//   PUT  /api/support/supporters/manual {linkedId, platform, name}  |  DELETE /api/support/supporters/:linkedId
//   POST /api/support/supporters/claim {id, linkedId|null}
//   GET  /support/connect                             the helper's own page for keys                   [this PC only]
import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { isWebOrigin } from '../localGuard.ts';
import { HttpError } from '../library.ts';
import { requireLocal, requireLocalOrStreamPc } from '../routes/util.ts';
import { streamPcOf } from '../streamPcMark.ts';
import type { ChatPlatform } from '../../shared/chat.ts';
import { SERVICE_INFO, SUPPORT_SERVICES, type SupportService } from '../../shared/supportConfig.ts';
import type { SupportHub } from './hub.ts';
import type { InboxClient } from './inbox.ts';
import type { Store } from './store.ts';
import type { Supporters } from './supporters.ts';
import { SUPPORT_CONNECT_PAGE } from './connectPage.ts';
import { ImageFetchError, fetchImage } from './imageFetch.ts';

export const KEY_LOCAL_MSG = 'Keys are added in VTube Pro on this computer (it opens in a new tab). They never go through a web page.';

const isService = (v: unknown): v is SupportService => typeof v === 'string' && (SUPPORT_SERVICES as readonly string[]).includes(v);
const origin = (req: Request) => (typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
/** Key routes: this PC's own pages only (any web origin is refused). */
function keyLocal(req: Request) {
  requireLocal(req);
  if (isWebOrigin(origin(req))) throw Object.assign(new HttpError(403, KEY_LOCAL_MSG), { code: 'local-only' });
}
const errOf = (e: unknown) => { const x = e as { message?: string; status?: number }; return new HttpError(typeof x.status === 'number' && x.status >= 400 ? x.status : 502, x.message || 'That didn’t work. Try again.'); };

export interface SupportParts { hub: SupportHub; inbox: InboxClient; store: Store; supporters: Supporters; imgDir: string }

export function supportRoutes(p: SupportParts): Router {
  const { hub, inbox, store, supporters } = p;
  const r = Router();

  r.get('/api/support/status', (req, res) => { requireLocal(req); res.json(hub.status()); });
  r.get('/api/support/settings', (req, res) => { requireLocal(req); res.json(hub.settings); });
  r.put('/api/support/settings', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    // the inbox relay decides where webhooks (with supporter names) go: only from this PC
    if ('inboxRelay' in b && isWebOrigin(origin(req))) throw new HttpError(403, KEY_LOCAL_MSG);
    const before = hub.settings.services.throne.creatorId;
    const s = hub.saveSettings(b);
    if (s.services.throne.creatorId !== before) void inbox.pushConfig();
    res.json(s);
  });

  r.put('/api/support/secrets/:service', async (req, res) => {
    keyLocal(req);
    const svc = req.params.service;
    if (!isService(svc)) throw new HttpError(404, 'Unknown service');
    const allowed = new Set(SERVICE_INFO[svc].secrets.map((f) => f.key));
    const fields = ((req.body ?? {}) as { fields?: Record<string, unknown> }).fields ?? {};
    const clean: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.has(k)) continue;
      if (v === null) { clean[k] = null; continue; }
      if (typeof v !== 'string') continue;
      let t = v.trim().replace(/^Bearer\s+/i, '');
      if (svc === 'kofi' && k === 'verificationToken') t = t.replace(/[^\w-]/g, '');
      if (t.length > 4000) throw new HttpError(400, 'That is too long to be a key. Copy just the key.');
      const shape = keyShape(svc, k, t);
      if (shape) throw new HttpError(400, shape);
      if (t) clean[k] = t;
    }
    await hub.vault.set(svc, clean);
    // saving keys switches the service on (the zero-effort default) and checks them right away
    if (!hub.settings.services[svc].enabled) hub.saveSettings({ services: { [svc]: { enabled: true } } });
    else await hub.restart(svc);
    if (svc === 'fourthwall') void store.load();
    res.json(hub.status().services[svc]);
  });
  r.delete('/api/support/secrets/:service', async (req, res) => {
    keyLocal(req);
    const svc = req.params.service;
    if (!isService(svc)) throw new HttpError(404, 'Unknown service');
    await hub.vault.clear(svc);
    hub.saveSettings({ services: { [svc]: { enabled: false } }, inboxServices: hub.settings.inboxServices.filter((x) => x !== svc) });
    res.json(hub.status().services[svc]);
  });

  r.post('/api/support/test', (req, res) => {
    requireLocal(req);
    const which = String(((req.body ?? {}) as { which?: unknown }).which ?? 'all').slice(0, 20);
    res.json({ ok: true, sent: hub.test(which) });
  });
  r.get('/api/support/events', (req, res) => { requireLocal(req); const n = Math.max(1, Math.min(300, parseInt(String(req.query.n ?? '100'), 10) || 100)); res.json({ events: hub.recent(n) }); });
  r.get('/api/support/log', (req, res) => {
    requireLocal(req);
    const since = Date.parse(String(req.query.since ?? '')) || 0;
    res.json({ events: hub.log.all(since), testMode: hub.settings.testMode, currency: hub.settings.displayCurrency });
  });
  r.post('/api/support/moderate', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { id?: unknown; moderated?: unknown };
    if (b.moderated !== 'ok' && b.moderated !== 'hidden') throw new HttpError(400, 'moderated must be ok or hidden');
    if (!hub.moderate(String(b.id ?? ''), b.moderated)) throw new HttpError(404, 'No message to moderate');
    res.json({ ok: true });
  });
  r.post('/api/support/void', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { id?: unknown; why?: unknown };
    if (!hub.void(String(b.id ?? ''), String(b.why ?? 'removed'))) throw new HttpError(404, 'No such event');
    res.json({ ok: true });
  });
  r.post('/api/support/manual', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ev = hub.manual({ name: String(b.name ?? '').slice(0, 60), amount: typeof b.amount === 'number' ? b.amount : parseFloat(String(b.amount ?? '')) || 0, currency: typeof b.currency === 'string' ? b.currency : undefined, message: typeof b.message === 'string' ? b.message : undefined, kind: b.kind as never, item: typeof b.item === 'string' ? b.item : undefined });
    if (!ev) throw new HttpError(400, 'That didn’t save. Try again.');
    res.json(ev);
  });

  // ---------------------------------------------------------------- webhooks
  // the address carries the inbox secret: like keys, only this PC's own pages see it
  r.post('/api/support/inbox', async (req, res) => {
    keyLocal(req);
    const svc = ((req.body ?? {}) as { service?: unknown }).service;
    if (!isService(svc) || !SERVICE_INFO[svc].how.includes('hook')) throw new HttpError(400, 'That service has no webhook');
    try { res.json({ url: await inbox.ensure(svc) }); } catch (e) { throw errOf(e); }
  });
  r.get('/api/support/inbox/:service', (req, res) => { keyLocal(req); const svc = req.params.service; if (!isService(svc)) throw new HttpError(404, 'Unknown service'); res.json({ url: hub.settings.inboxServices.includes(svc) ? inbox.addressOf(svc) : '' }); });
  r.delete('/api/support/inbox/:service', (req, res) => {
    requireLocal(req);
    const svc = req.params.service;
    hub.saveSettings({ inboxServices: hub.settings.inboxServices.filter((x) => x !== svc) });
    if (!hub.settings.inboxServices.length) inbox.stop();
    res.json({ ok: true });
  });
  r.post('/api/support/inbox/rotate', async (req, res) => { keyLocal(req); try { await inbox.rotate(); inbox.stop(); inbox.start(); res.json({ ok: true }); } catch (e) { throw errOf(e); } });
  r.post('/api/support/hook/:service', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    keyLocal(req);
    const svc = req.params.service;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    const out = await hub.hook(String(svc), { seq: 0, provider: String(svc), at: Date.now(), headers, body });
    res.status(out.ok ? 200 : 400).json(out);
  });

  // ---------------------------------------------------------------- the store
  r.get('/api/support/store', (req, res) => { requireLocal(req); res.json({ ...store.snap, promos: store.promoList() }); });
  r.post('/api/support/store/refresh', async (req, res) => { requireLocal(req); await store.load(); res.json({ ...store.snap, promos: store.promoList() }); });
  const confirmed = (req: Request) => { if (((req.body ?? {}) as { confirm?: unknown }).confirm !== true) throw new HttpError(428, 'This changes your live store: confirm first.'); };
  r.post('/api/support/store/product/:id', async (req, res) => {
    requireLocal(req); confirmed(req);
    try { await store.setListed(String(req.params.id), ((req.body ?? {}) as { listed?: unknown }).listed !== false); res.json({ ok: true }); } catch (e) { throw errOf(e); }
  });
  r.put('/api/support/store/collection/:id', async (req, res) => {
    requireLocal(req); confirmed(req);
    const ids = ((req.body ?? {}) as { offerIds?: unknown }).offerIds;
    if (!Array.isArray(ids)) throw new HttpError(400, 'offerIds: a list of product ids');
    try { await store.setCollection(String(req.params.id), ids.map(String)); res.json({ ok: true }); } catch (e) { throw errOf(e); }
  });
  r.post('/api/support/store/promo', async (req, res) => {
    requireLocal(req); confirmed(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    try { res.json(await store.createPromo({ code: String(b.code ?? ''), percent: Number(b.percent) || undefined, flat: Number(b.flat) || undefined, freeShipping: b.freeShipping === true, minutes: Number(b.minutes) || 10, maxUses: Number(b.maxUses) || undefined, oncePerCustomer: b.oncePerCustomer === true })); } catch (e) { throw errOf(e); }
  });
  r.get('/api/support/store/promos', (req, res) => { requireLocal(req); res.json({ promos: store.promoList() }); });
  r.delete('/api/support/store/promo/:id', async (req, res) => { requireLocal(req); try { await store.endPromo(String(req.params.id)); res.json({ ok: true }); } catch (e) { throw errOf(e); } });
  r.get('/api/support/showcase', (req, res) => { requireLocalOrStreamPc(req); res.json(store.view()); });

  // ---------------------------------------------------------------- images through this PC (OBS pages never fetch shops)
  const inflight = new Map<string, Promise<{ type: string; file: string }>>();
  const fromPath = (img: string) => { const m = /^\/api\/support\/img\/([A-Za-z0-9_-]+)$/.exec(img); return m ? Buffer.from(m[1], 'base64url').toString('utf8') : ''; };
  const norm = (u: string) => { try { return new URL(u).href; } catch { return ''; } };
  const knownImage = (href: string) => store.snap.products.some((x) => norm(fromPath(x.image)) === href) || hub.recent(300).some((e) => !!e.item?.imageUrl && norm(e.item.imageUrl) === href) || norm(fromPath(store.view().flash?.image ?? '')) === href;
  r.get('/api/support/img/:b64', async (req, res) => {
    let url: URL;
    try { url = new URL(Buffer.from(String(req.params.b64), 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'Bad image'); }
    if (url.protocol !== 'https:' || url.username || url.password || !hostOk(url.hostname)) throw new HttpError(403, 'Image host not allowed');
    // only pictures VTube Pro itself put on a page: the store's products and the items of events it accepted (a web page
    // can't make this PC fetch any address it likes)
    if (!knownImage(url.href)) throw new HttpError(403, 'Not a picture from your store or your supporters');
    const key = crypto.createHash('sha1').update(url.href).digest('hex');
    const file = path.join(p.imgDir, key);
    const send = (type: string, f: string) => { res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'public, max-age=86400'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(fs.readFileSync(f)); };
    try { const type = fs.readFileSync(file + '.type', 'utf8'); if (fs.existsSync(file)) { send(type, file); return; } } catch { /* not cached */ }
    // a paired stream PC is display-only: pictures this PC already has, nothing fetched or written for it
    if (streamPcOf(req)) throw new HttpError(404, 'not cached');
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        // checked hop by hop: public addresses only (the socket's own DNS answer), ≤ 3 redirects, ≤ 4 MB, images only
        let got: { type: string; body: Buffer };
        try { got = await fetchImage(url, hostOk); } catch (e) { throw new HttpError(e instanceof ImageFetchError ? e.status : 502, (e as Error).message); }
        const { type, body: buf } = got;
        fs.mkdirSync(p.imgDir, { recursive: true });
        fs.writeFileSync(file, buf); fs.writeFileSync(file + '.type', type);
        return { type, file };
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const got = await job;
    send(got.type, got.file);
  });

  // ---------------------------------------------------------------- supporters
  r.get('/api/support/supporters', (req, res) => {
    requireLocal(req);
    const full = !isWebOrigin(origin(req)) || req.query.full === '1';
    res.json({ list: supporters.entries(), ...(full ? { members: supporters.members().map((m) => ({ ...m, links: supporters.linksOf(m.linkedId) })), claims: supporters.claims } : {}) });
  });
  r.post('/api/support/supporters/code', (req, res) => { requireLocal(req); try { res.json(supporters.makeCode(String(((req.body ?? {}) as { linkedId?: unknown }).linkedId ?? ''))); } catch (e) { throw errOf(e); } });
  r.put('/api/support/supporters/manual', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { linkedId?: unknown; platform?: unknown; name?: unknown };
    const plat = String(b.platform ?? 'twitch') as ChatPlatform;
    if (!/^[a-z]{2,16}$/.test(plat)) throw new HttpError(400, 'platform?');
    supporters.setManual(String(b.linkedId ?? ''), plat, String(b.name ?? ''));
    res.json({ ok: true });
  });
  r.delete('/api/support/supporters/:linkedId', (req, res) => { requireLocal(req); supporters.unlink(String(req.params.linkedId)); res.json({ ok: true }); });
  r.post('/api/support/supporters/claim', (req, res) => {
    requireLocal(req);
    const b = (req.body ?? {}) as { id?: unknown; linkedId?: unknown };
    if (!supporters.answerClaim(String(b.id ?? ''), typeof b.linkedId === 'string' && b.linkedId ? b.linkedId : null)) throw new HttpError(404, 'That request is gone');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- the helper's own page for keys
  r.get(['/support/connect', '/support/connect/'], (req, res) => {
    requireLocal(req);
    if (!pageLocal(req)) { res.status(403).json({ error: 'Open this page on this computer' }); return; }
    const sn = crypto.randomBytes(16).toString('base64url');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${sn}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(SUPPORT_CONNECT_PAGE.replace('__SN__', sn).replace('__INFO__', JSON.stringify(SUPPORT_SERVICES.map((s) => SERVICE_INFO[s])).replace(/</g, '\\u003c')));
  });
  return r;
}

/** A key that is clearly the wrong one, caught before it is saved (one plain sentence, or '' = fine). */
export function keyShape(svc: string, field: string, v: string): string {
  if (svc === 'stripe' && field === 'restrictedKey') {
    if (/^sk_/.test(v)) return 'That is your secret key. Make a RESTRICTED key instead (read only: Checkout Sessions + Events). It is safer, and it starts with rk_.';
    if (/^pk_/.test(v)) return 'That is your publishable key. Make a restricted key instead (it starts with rk_).';
    if (!/^rk_(live|test)_[A-Za-z0-9]{10,}$/.test(v)) return 'That doesn’t look like a Stripe restricted key (it starts with rk_live_ or rk_test_).';
  }
  if (svc === 'stripe' && field === 'hookSecret' && !/^whsec_[A-Za-z0-9+/=_-]{10,}$/.test(v)) return 'That doesn’t look like a webhook signing secret (it starts with whsec_).';
  if (svc === 'streamelements' && field === 'jwt' && v.split('.').length !== 3) return 'That doesn’t look like the JWT token. Press “Show secrets” on StreamElements and copy the JWT Token.';
  return '';
}

/** This PC only: no web Origin, and a cross-site browser request only as a top-level navigation. */
function pageLocal(req: Request) {
  const o = origin(req) ?? '';
  if (o && isWebOrigin(o)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return req.headers['sec-fetch-mode'] === 'navigate' && req.method === 'GET';
  return true;
}

/** Image hosts: any public https host (shops / wishlist retailers), never this PC or a private network. */
export function hostOk(h: string): boolean {
  const x = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (!x.includes('.') || /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.lan|.*\.home)$/.test(x)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(x) || x.includes(':')) return false; // literal IPs (v4 / v6)
  return true;
}

/** Express error answers for HttpError with a `code` (local-only). */
export function supportErrors(err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) {
  const e = err as { status?: number; message?: string; code?: string };
  if (e && e.code === 'local-only' && !res.headersSent) { res.status(403).json({ error: e.message, code: 'local-only' }); return; }
  next(err);
}

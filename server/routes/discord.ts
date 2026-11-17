// Discord multiplayer bridge on the local server (docs/MULTIPLAYER_DISCORD.md).
//
//  * Host sign-in: OAuth2 authorization code + PKCE over a LOOPBACK redirect (http://127.0.0.1:5191/api/discord/callback).
//    The desktop app holds no client secret — the code (+ PKCE verifier) goes to YOUR relay Worker, which returns your
//    identity + a signed host session. The Discord access token never reaches this PC.
//    The sign-in always uses YOUR OWN Discord application (its Client ID is saved here, its secret lives only on your
//    own relay). With a saved Client ID the browser goes straight to discord.com; without one it starts at
//    <relay>/oauth2/authorize, where your relay uses the Client ID it was set up with.
//  * The host session stays in config/discord.json (gitignored) and never goes to the page: room creation, channel
//    list and ticket refresh are proxied through here.
//  * GET /join#relay=…&t=… — where a guest's browser lands after clicking Join in Discord (fragment = never sent in
//    any request / log). Its page hands the ticket to /api/discord/pending-join; the studio asks before joining.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import type { DiscordIdentity } from '../../shared/types.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { requireLocalPage } from '../partyVault.ts';
import { CONFIG_DIR, PORT } from '../paths.ts';
import { RELAY_DNS, relayAddressGone, relayDnsTemporary, relayDnsVerdict, type RelayDnsVerdict } from '../relayGone.ts';
import { requireLocal } from './util.ts';
import { inviteMinutes } from '../../relay/src/inviteExpiry.ts';


/** Where "Connect Discord" may send the browser to sign in: Discord itself, the streamer's own relay, or a relay under
 *  `wrangler dev` on this PC (a saved authorizeUrl anywhere else would be a phishing hop). */
export function discordAuthorizeOk(v: unknown, relayUrl: unknown): boolean {
  const o = relayOrigin(v);
  return !!o && (o === 'https://discord.com' || o === relayOrigin(relayUrl) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o));
}

export const discordRoutes = Router();

const FILE = path.join(CONFIG_DIR, 'discord.json');
const SNOW = /^\d{5,25}$/;
interface Ban { id: string; name: string }
interface DiscordConfig {
  relayUrl: string; clientId: string;
  /** Testing only (the local mock): alternative OAuth authorize URL. */
  authorizeUrl?: string;
  autoApprove: boolean; relayOnly: boolean;
  guildId: string; roleIds: string[]; channelId: string;
  bans: Ban[];
  /** Relays this PC agreed to join through (guest side). */
  trustedRelays: string[];
  user?: DiscordIdentity | null;
  session?: { token: string; exp: number } | null;
  /** When relayUrl was saved (Setup's build, or a newly pasted address): a brand-new name may not be in DNS yet. */
  relaySavedAt?: number;
}
const DEFAULTS: DiscordConfig = { relayUrl: '', clientId: '', autoApprove: false, relayOnly: false, guildId: '', roleIds: [], channelId: '', bans: [], trustedRelays: [] };

function read(): DiscordConfig {
  try { return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<DiscordConfig>) }; } catch { return { ...DEFAULTS }; }
}
function write(c: DiscordConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, FILE);
}
/** https relay, or plain http only on this machine (the local mock). */
export function relayOrigin(v: unknown): string | null {
  try {
    const u = new URL(String(v ?? ''));
    if (u.username || u.password) return null;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return u.origin;
  } catch { /* bad url */ }
  return null;
}
const redirectUri = () => `http://127.0.0.1:${PORT}/api/discord/callback`;

// ---------------------------------------------------------------- the saved relay's address is gone (server/relayGone.ts)
/** Tests only (tools/relay_gone_unit.ts): a mock host-name lookup instead of the real DNS. */
const net = { lookup: (host: string): Promise<unknown> => dns.promises.lookup(host) };
export function configureDiscordNet(s: Partial<typeof net>) { Object.assign(net, s); }
/** Relay origins whose name resolved / that answered since they were saved (memory): no longer "brand new". */
const answered = new Set<string>();
export const noteRelayAnswered = (origin: string) => { answered.add(origin); };
/** Well-known names: when none of them resolves either, this PC is offline (Windows reports that as ENOTFOUND too). */
const CONTROL_HOSTS = ['cloudflare.com', 'discord.com'];
async function dnsWorks(): Promise<boolean> {
  let t: NodeJS.Timeout | undefined;
  const any = Promise.any(CONTROL_HOSTS.map((h) => net.lookup(h))).then(() => true, () => false);
  try { return await Promise.race([any, new Promise<boolean>((r) => { t = setTimeout(() => r(false), 4000); })]); }
  finally { clearTimeout(t); }
}
/** A failed request / lookup on the relay at `origin`: null = not a DNS "no such name"; otherwise renamed / deleted
 *  ('gone'), saved minutes ago and not live yet ('new'), or this PC is offline ('offline'). */
export async function relayDnsTrouble(e: unknown, origin: string): Promise<RelayDnsVerdict | null> {
  if (!relayAddressGone(e)) return null;
  const c = read();
  const savedAt = relayOrigin(c.relayUrl) === origin ? c.relaySavedAt : undefined;
  const temporary = relayDnsTemporary(e);   // ("try again": no need to ask the well-known names)
  return relayDnsVerdict({ internetOk: temporary || await dnsWorks(), savedAt, answered: answered.has(origin), now: Date.now(), temporary });
}
/** fetch on the saved relay: a DNS "no such name" becomes plain words (RELAY_DNS) instead of "fetch failed". */
async function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  let r: Response;
  try { r = await fetch(url, init); } catch (e) { const v = await relayDnsTrouble(e, origin); if (v) throw new HttpError(502, RELAY_DNS[v].message); throw e; }
  noteRelayAnswered(origin);
  return r;
}
/** Before Connect Discord sends the browser there: does the relay's name still exist? (Slow DNS = assume yes.) */
async function relayNameTrouble(origin: string): Promise<RelayDnsVerdict | null> {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  let t: NodeJS.Timeout | undefined;
  try { await Promise.race([net.lookup(host).then(() => noteRelayAnswered(origin)), new Promise((r) => { t = setTimeout(r, 4000); })]); return null; }
  catch (e) { return relayDnsTrouble(e, origin); }
  finally { clearTimeout(t); }
}
const troubleHtml = (v: RelayDnsVerdict) => done(RELAY_DNS[v].title, esc(RELAY_DNS[v].message));

// ---------------------------------------------------------------- "Set up my invite server" (server/routes/relaySetup.ts)
/** The helper's setup page saves the new invite server here itself: nothing to copy or paste into the studio. */
export function saveRelayUrl(url: string): string {
  const o = relayOrigin(url);
  if (!o) throw new HttpError(400, 'bad invite server address');
  const c = read();
  if (o !== relayOrigin(c.relayUrl)) { c.session = null; c.user = null; }
  c.relayUrl = o;
  c.relaySavedAt = Date.now(); answered.delete(o);   // just (re)built: its name may need minutes to appear in DNS
  write(c);
  broadcast({ type: 'command', command: 'discord-changed' });
  return o;
}
export const savedRelayUrl = () => relayOrigin(read().relayUrl) ?? '';
/** The Client ID of the streamer's own Discord application ('' = none saved yet). */
export const savedClientId = () => { const id = String(read().clientId ?? '').trim(); return SNOW.test(id) || id === 'mock-client' ? id : ''; };
/** "Set up my invite server" saves the Client ID it just put on the relay (the secret is never stored on this PC). */
export function saveClientId(id: string) {
  const v = String(id ?? '').trim();
  if (!SNOW.test(v) && v !== 'mock-client') throw new HttpError(400, 'Client ID is the long number from Discord → OAuth2');
  const c = read();
  if (c.clientId !== v) { c.clientId = v; c.session = null; c.user = null; }
  write(c);
  broadcast({ type: 'command', command: 'discord-changed' });
}
/** The one redirect every host needs in their Discord application (OAuth2 → Redirects), next to <relay>/cb for guests. */
export const discordRedirectUri = () => redirectUri();
export const hostSignedIn = () => { const c = read(); return !!c.session && c.session.exp > Date.now(); };
/** The host code the setup page just made (memory only, 30 min, that one invite server): the next Discord sign-in
 *  through THIS helper uses it automatically, so the streamer never has to type it. */
let setupClaim: { origin: string; code: string; at: number } | null = null;
export function offerSetupClaim(origin: string, code: string | null) { setupClaim = code ? { origin, code, at: Date.now() } : null; }
const takeSetupClaim = (origin: string | null) => {
  const s = setupClaim;
  if (!s || !origin || s.origin !== origin || Date.now() - s.at > 1_800_000) return null;
  return s.code;
};
/** "Claim your relay": the relay asked this signed-in Discord user for the setup's claim code. Memory only, 10 min
 *  (the claim ticket is the relay's own signed, short-lived token; it is useless without the code). */
let pendingClaim: { claim: string; name: string; at: number } | null = null;
const claimPending = () => (pendingClaim && Date.now() - pendingClaim.at < 600_000 ? pendingClaim : null);
function publicStatus(c: DiscordConfig) {
  const signedIn = !!c.session && c.session.exp > Date.now();
  return {
    configured: !!relayOrigin(c.relayUrl), relayUrl: c.relayUrl, clientId: c.clientId, redirectUri: redirectUri(),
    user: c.user ?? null, signedIn, sessionExp: c.session?.exp ?? 0,
    claim: !signedIn && claimPending() ? { name: claimPending()!.name } : null,
    autoApprove: c.autoApprove, relayOnly: c.relayOnly, guildId: c.guildId, roleIds: c.roleIds, channelId: c.channelId, bans: c.bans,
    trustedRelays: c.trustedRelays,
  };
}

discordRoutes.get('/api/discord/status', (req, res) => { requireLocalPage(req); res.setHeader('Cache-Control', 'no-store'); res.json(publicStatus(read())); });

discordRoutes.put('/api/discord/config', (req, res) => {
  requireLocalPage(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const c = read();
  if ('relayUrl' in b) { const o = b.relayUrl ? relayOrigin(b.relayUrl) : ''; if (o === null) throw new HttpError(400, 'Relay URL must be https://… (or http://127.0.0.1 for the local mock)'); if (o !== relayOrigin(c.relayUrl)) { c.session = null; if (o) { c.relaySavedAt = Date.now(); answered.delete(o); } } c.relayUrl = o; }
  if ('clientId' in b) { const id = String(b.clientId ?? '').trim(); if (id && !SNOW.test(id) && id !== 'mock-client') throw new HttpError(400, 'Client ID is the long number from Discord → OAuth2'); c.clientId = id; }
  // the sign-in page the user is sent to: Discord itself, the streamer's own relay or a local mock; never some other
  // site (the OAuth code would land there)
  const authOk = (v: unknown) => discordAuthorizeOk(v, c.relayUrl);
  if ('authorizeUrl' in b) c.authorizeUrl = b.authorizeUrl ? authOk(b.authorizeUrl) ? String(b.authorizeUrl) : c.authorizeUrl : undefined;
  if (typeof b.autoApprove === 'boolean') c.autoApprove = b.autoApprove;
  if (typeof b.relayOnly === 'boolean') c.relayOnly = b.relayOnly;
  if ('guildId' in b) { const g = String(b.guildId ?? ''); c.guildId = SNOW.test(g) ? g : ''; }
  if ('roleIds' in b) c.roleIds = (Array.isArray(b.roleIds) ? b.roleIds : String(b.roleIds ?? '').split(/[\s,]+/)).map(String).filter((x) => SNOW.test(x)).slice(0, 10);
  if ('channelId' in b) { const ch = String(b.channelId ?? ''); c.channelId = SNOW.test(ch) ? ch : ''; }
  if (typeof b.trustRelay === 'string') { const o = relayOrigin(b.trustRelay); if (o && !c.trustedRelays.includes(o)) c.trustedRelays = [...c.trustedRelays, o].slice(-10); }
  write(c);
  res.json(publicStatus(c));
});

discordRoutes.post('/api/discord/ban', (req, res) => {
  requireLocalPage(req);
  const b = (req.body ?? {}) as { id?: unknown; name?: unknown; remove?: unknown };
  const id = String(b.id ?? '');
  if (!SNOW.test(id)) throw new HttpError(400, 'bad user id');
  const c = read();
  c.bans = c.bans.filter((x) => x.id !== id);
  if (b.remove !== true) c.bans.push({ id, name: String(b.name ?? '').slice(0, 40) });
  write(c);
  res.json(publicStatus(c));
});

// ---------------------------------------------------------------- host sign-in (loopback + PKCE)
const pending = new Map<string, { verifier: string; at: number }>();
const b64u = (b: Buffer) => b.toString('base64url');
// (top-level navigations: a cross-site Sec-Fetch-Site is normal here; the random state + PKCE protect the flow)
discordRoutes.get('/api/discord/login', async (req, res) => {
  requireLocal(req);
  const c = read();
  const origin = relayOrigin(c.relayUrl);
  if (!origin) throw new HttpError(400, 'Set your relay address first (Multiplayer → Setup)');
  // a renamed / deleted (or brand-new, not live yet) invite server: say so here, not with the browser's "can't reach
  // this page" after the redirect. Offline: redirect as before (the browser says so itself, and may have a proxy).
  const trouble = await relayNameTrouble(origin);
  if (trouble === 'gone' || trouble === 'new') { res.status(502).setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); res.type('html').send(troubleHtml(trouble)); return; }
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  const state = b64u(crypto.randomBytes(18));
  const verifier = b64u(crypto.randomBytes(48));
  pending.set(state, { verifier, at: Date.now() });
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: redirectUri(), scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent' });
  res.redirect(`${c.authorizeUrl || (c.clientId ? 'https://discord.com/oauth2/authorize' : `${origin}/oauth2/authorize`)}?${q}`);
});

const done = (title: string, msg: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;background:#111318;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}main{background:#1b1e26;padding:28px;border-radius:14px;max-width:520px}</style><main><h2>${title}</h2><p>${msg}</p></main>`;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
discordRoutes.get('/api/discord/callback', async (req, res) => {
  requireLocal(req);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  const state = String(req.query.state ?? ''), code = String(req.query.code ?? '');
  const p = pending.get(state);
  pending.delete(state);
  if (!p || !code || code.length > 200) { res.status(400).type('html').send(done('Sign-in expired', 'Close this window and click <b>Connect Discord</b> again.')); return; }
  const c = read();
  try {
    const r = await relayFetch(`${relayOrigin(c.relayUrl)}/oauth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, redirect_uri: redirectUri(), code_verifier: p.verifier }) });
    const b = (await r.json()) as { user?: DiscordIdentity & { username?: string }; session?: string; exp?: number; error?: string; hint?: string; claim?: string };
    if (b.error === 'claim-needed' && typeof b.claim === 'string' && b.claim.length < 2048 && b.user) {
      // relay-setup: this helper just set the invite server up and still holds its host code → use it right away
      const auto = takeSetupClaim(relayOrigin(c.relayUrl));
      if (auto) {
        const cr = await relayFetch(`${relayOrigin(c.relayUrl)}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: b.claim, code: auto }) });
        const cb = (await cr.json().catch(() => ({}))) as { user?: DiscordIdentity & { username?: string }; session?: string; exp?: number };
        if (cr.ok && cb.session && cb.user) {
          setupClaim = null;
          c.user = { id: String(cb.user.id), name: String(cb.user.name).slice(0, 40), username: String(cb.user.username ?? '').slice(0, 40), avatar: cb.user.avatar ?? null };
          c.session = { token: cb.session, exp: Number(cb.exp) || Date.now() + 86400_000 };
          write(c);
          broadcast({ type: 'command', command: 'discord-changed' });
          res.type('html').send(done('You’re the host ✔', 'You’re signed in with Discord. Your invite server knows you now. You can close this window.'));
          return;
        }
      }
      // stream-safe (src/ui/streamSafe.ts): these pages never show the Discord name; the studio hides it behind the eye
      // a fresh relay: whoever types the setup window's claim code becomes its host (done in the studio, not here)
      pendingClaim = { claim: b.claim, name: String(b.user.name ?? '').slice(0, 40), at: Date.now() };
      broadcast({ type: 'command', command: 'discord-changed' });
      res.type('html').send(done('Almost done!', `You’re signed in with Discord. Go back to VTube Pro and type the <b>claim code</b> from the relay setup window. That makes you this relay’s host. You can close this window.`));
      return;
    }
    if (!r.ok || !b.session || !b.user) {
      const who = b.user ? ` (your Discord id: ${esc(b.user.id)})` : ''; // stream-safe: the id helps setup, the name is never shown
      const guestNote = b.error === 'not-a-host'
        ? '<br><br><b>Just want to join a friend?</b> You don’t need to connect Discord in VTube Pro for that. Keep VTube Pro running, click the <b>Join link</b> your host shares, sign in with Discord in the browser, then press <b>Join</b> in your studio.'
        : '';
      res.status(403).type('html').send(done('Can’t host yet', `${esc(b.hint ?? b.error ?? `relay error ${r.status}`)}${who}${guestNote}`));
      return;
    }
    c.user = { id: String(b.user.id), name: String(b.user.name).slice(0, 40), username: String(b.user.username ?? '').slice(0, 40), avatar: b.user.avatar ?? null };
    c.session = { token: b.session, exp: Number(b.exp) || Date.now() + 86400_000 };
    write(c);
    broadcast({ type: 'command', command: 'discord-changed' });
    res.type('html').send(done('Discord connected ✔', 'You’re signed in with Discord. You can close this window and go back to VTube Pro.'));
  } catch (e) {
    const v = (Object.keys(RELAY_DNS) as RelayDnsVerdict[]).find((k) => RELAY_DNS[k].message === (e as Error).message);
    res.status(502).type('html').send(v ? troubleHtml(v) : done('Relay unreachable', esc((e as Error).message)));
  }
});

// "Claim your relay": the code the relay setup window showed (POST /claim on the relay with the pending claim ticket)
discordRoutes.post('/api/discord/claim', async (req, res) => {
  requireLocalPage(req);
  const code = String((req.body as { code?: unknown } | undefined)?.code ?? '').slice(0, 40);
  const p = claimPending();
  if (!p) throw new HttpError(400, 'Click Connect Discord first, then type the code.');
  const c = read();
  const origin = relayOrigin(c.relayUrl);
  if (!origin) throw new HttpError(400, 'Set your relay address first');
  const r = await relayFetch(`${origin}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim: p.claim, code }) });
  const b = (await r.json().catch(() => ({}))) as { user?: DiscordIdentity & { username?: string }; session?: string; exp?: number; error?: string; hint?: string };
  if (!r.ok || !b.session || !b.user) {
    if (b.error === 'expired' || b.error === 'used') pendingClaim = null;
    throw new HttpError(r.status === 429 ? 429 : 400, b.hint ?? b.error ?? `relay error ${r.status}`);
  }
  pendingClaim = null;
  c.user = { id: String(b.user.id), name: String(b.user.name).slice(0, 40), username: String(b.user.username ?? '').slice(0, 40), avatar: b.user.avatar ?? null };
  c.session = { token: b.session, exp: Number(b.exp) || Date.now() + 86400_000 };
  write(c);
  broadcast({ type: 'command', command: 'discord-changed' });
  res.json(publicStatus(c));
});

discordRoutes.post('/api/discord/logout', (req, res) => {
  requireLocalPage(req);
  const c = read(); c.session = null; c.user = null; write(c);
  res.json(publicStatus(c));
});

// ---------------------------------------------------------------- host → relay (session stays here)
async function relay(req: Request, pathname: string, init: RequestInit = {}) {
  requireLocalPage(req);
  const c = read();
  const origin = relayOrigin(c.relayUrl);
  if (!origin) throw new HttpError(400, 'Relay URL not set');
  if (!c.session || c.session.exp < Date.now()) throw new HttpError(401, 'Connect Discord first');
  const r = await relayFetch(`${origin}${pathname}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${c.session.token}` } });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401) { c.session = null; write(c); throw new HttpError(401, 'Discord sign-in expired (or the relay’s secret changed) — click Connect Discord again'); }
  if (!r.ok) throw new HttpError(502, String(body.error ?? `relay ${r.status}`));
  return { c, origin, body };
}
discordRoutes.get('/api/discord/channels', async (req, res) => { const { body } = await relay(req, '/api/channels'); res.json(body); });
discordRoutes.post('/api/discord/room', async (req, res) => {
  const b = (req.body ?? {}) as { post?: boolean; channelId?: string };
  const c0 = read();
  const channelId = b.post === false ? null : (SNOW.test(String(b.channelId ?? '')) ? String(b.channelId) : c0.channelId || null);
  const { origin, body } = await relay(req, '/api/rooms', { method: 'POST', body: JSON.stringify({ guildId: c0.guildId || null, roleIds: c0.roleIds, channelId, bans: c0.bans.map((x) => x.id) }) });
  res.json({ ...body, relay: origin });
});
discordRoutes.post('/api/discord/room/:id/ticket', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9]{16,40}$/.test(id)) throw new HttpError(400, 'bad room');
  const { body } = await relay(req, `/api/rooms/${id}/ticket`, { method: 'POST' });
  res.json(body);
});
// guestlink: the no-sign-in interview link (relay /api/rooms/<id>/guestlink; host session stays here). Body: {max?,
// minutes?, revoke?}. Every link expires: 5-60 min, default 30 (relay/src/inviteExpiry.ts; the relay enforces it too).
// A new link revokes the previous one; ending the party kills it. `hours` is still sent for relays older than this rule.
discordRoutes.post('/api/discord/room/:id/guestlink', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9]{16,40}$/.test(id)) throw new HttpError(400, 'bad room');
  const b = (req.body ?? {}) as { max?: unknown; minutes?: unknown; hours?: unknown; revoke?: unknown };
  const life = inviteMinutes(b);
  if ('error' in life) throw new HttpError(400, life.error);
  const out = b.revoke === true ? { revoke: true } : { max: Math.max(1, Math.min(20, Number(b.max) || 3)), minutes: life.minutes, hours: life.minutes / 60 };
  const { body } = await relay(req, `/api/rooms/${id}/guestlink`, { method: 'POST', body: JSON.stringify(out) });
  res.setHeader('Cache-Control', 'no-store');
  res.json(body);
});
discordRoutes.post('/api/discord/room/:id/end', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9]{16,40}$/.test(id)) throw new HttpError(400, 'bad room');
  const { body } = await relay(req, `/api/rooms/${id}/end`, { method: 'POST' });
  res.json(body);
});

// ---------------------------------------------------------------- guest: /join deep link
let joinReq: { relay: string; ticket: string; at: number } | null = null;
const TICKET = /^[A-Za-z0-9_-]{20,1600}\.[A-Za-z0-9_-]{20,100}$/;
discordRoutes.get('/join', (_req, res) => {
  const nonce = b64u(crypto.randomBytes(12));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Joining a VTube Pro party</title>
<style>body{font:15px system-ui;background:#111318;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}main{background:#1b1e26;padding:28px;border-radius:14px;max-width:520px}</style>
<main><h2 id="h">Handing the invite to VTube Pro…</h2><p id="p"></p></main>
<script nonce="${nonce}">
(function(){
  var q = new URLSearchParams(location.hash.slice(1)); history.replaceState(null, '', location.pathname);
  var h = document.getElementById('h'), p = document.getElementById('p');
  if (!q.get('t')) { h.textContent = 'No invite in this link'; return; }
  fetch('/api/discord/pending-join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relay: q.get('relay'), ticket: q.get('t') }) })
    .then(function(r){ return r.json().then(function(b){ if (!r.ok) throw new Error(b.error || r.status); }); })
    .then(function(){ h.textContent = 'Invite received \\u2714'; p.textContent = 'Switch to your VTube Pro studio window: it asks before your avatar is shared. (No studio open? Open it within 10 minutes and the invite will be waiting.) You can close this tab.'; })
    .catch(function(e){ h.textContent = 'Could not hand over the invite'; p.textContent = String(e.message || e); });
})();
</script>`);
});
discordRoutes.post('/api/discord/pending-join', (req, res) => {
  requireLocalPage(req);
  const b = (req.body ?? {}) as { relay?: unknown; ticket?: unknown };
  const origin = relayOrigin(b.relay);
  const ticket = String(b.ticket ?? '');
  if (!origin || !TICKET.test(ticket)) throw new HttpError(400, 'Not a VTube Pro join link');
  joinReq = { relay: origin, ticket, at: Date.now() };
  broadcast({ type: 'command', command: 'party-join-pending' });
  res.json({ ok: true });
});
/** The studio takes the pending join (once). */
discordRoutes.post('/api/discord/pending-join/take', (req, res) => {
  requireLocalPage(req);
  res.setHeader('Cache-Control', 'no-store');
  const j = joinReq && Date.now() - joinReq.at < 600_000 ? joinReq : null;
  joinReq = null;
  res.json(j ? { relay: j.relay, ticket: j.ticket, trusted: read().trustedRelays.includes(j.relay) || relayOrigin(read().relayUrl) === j.relay } : {});
});

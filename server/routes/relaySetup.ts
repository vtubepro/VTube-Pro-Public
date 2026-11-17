import { spawnSync } from 'node:child_process';
// "Set up my invite server": the helper page that puts the streamer's own invite server (the relay Worker) on THEIR
// Cloudflare account, one big button per step. LOCAL ONLY: it handles a Cloudflare key, so other sites
// are refused by server/localGuard.ts and by localOnly() here.
//
//   GET  /invite-server              the page (http://127.0.0.1:5191/invite-server)
//   GET  /invite-server/state        where the setup is (never the key)
//   POST /invite-server/key          {key, nonce}            check the key, list its accounts (memory only)
//   POST /invite-server/build        {account?, newCode?, clientId?, clientSecret?, botToken?, nonce}   upload
//                                                            relay/dist/worker.js + secrets (incl. YOUR Discord app's
//                                                            Client Secret), turn it on, save the address + Client ID
//                                                            into the helper (config/discord.json)
//   POST /invite-server/check        {nonce}                 say hello to it again (a new workers.dev name can take a minute)
//   POST /invite-server/turn         {mode:'auto'|'manual'|'skip', keyId?, keyToken?, nonce}   optional TURN
//   POST /invite-server/forget       {nonce}                 drop the key + progress now
//
// The Cloudflare key stays in this process's memory for at most 30 minutes after the last step and is dropped as
// soon as the setup is done. It is never written to disk, logged, or sent anywhere but api.cloudflare.com. The same
// goes for the Discord client secret and bot token the streamer pastes: they go into the upload to THEIR Cloudflare
// account and are not kept here afterwards.
// No wrangler, no relay source: the bundle built by tools/build_relay.mjs (relay/dist/worker.js) is uploaded as-is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { ROOT } from '../paths.ts';
import { CfError, Cloudflare, FRIENDLY, TOKEN_TEMPLATE_URL, checkKeyShape, newClaimCode, newTicketSecret,
  privateSubdomain, workersDevUrl, type Account, type RelayManifest } from '../relaySetup/cloudflare.ts';
import { checkBotToken, checkClientId, checkClientSecret } from '../../shared/relaySetup.ts';
import { discordRedirectUri, hostSignedIn, offerSetupClaim, saveClientId, saveRelayUrl, savedClientId, savedRelayUrl } from './discord.ts';


export const relaySetupRoutes = Router();

// ---------------------------------------------------------------- test seams (unit tests + the mock screenshot harness)
interface Seams { api?: string; fetch?: typeof fetch; relayDir?: string; relayOrigin?: (script: string, sub: string) => string; helloTries?: number; helloGapMs?: number }
const seams: Seams = {};
/** Tests only: a mock Cloudflare API, a mock fetch, another relay/dist folder, where the "deployed" relay answers. */
export function configureRelaySetup(s: Seams) { Object.assign(seams, s); }
const apiBase = () => seams.api ?? (/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(process.env.VTP_CF_API ?? '') ? process.env.VTP_CF_API! : undefined);
const relayDir = () => seams.relayDir ?? process.env.VTP_RELAY_DIST ?? path.join(ROOT, 'relay', 'dist');
const relayUrlFor = (script: string, sub: string) => seams.relayOrigin?.(script, sub)
  ?? (/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.VTP_CF_WORKERS_ORIGIN ?? '') ? process.env.VTP_CF_WORKERS_ORIGIN! : workersDevUrl(script, sub));
const doFetch: typeof fetch = (...a) => (seams.fetch ?? fetch)(...a);

// ---------------------------------------------------------------- the one setup session (memory only)
type StepState = 'todo' | 'run' | 'ok' | 'wait' | 'fail';
interface Session {
  key: string; accounts: Account[]; account?: string; touched: number;
  progress: { id: string; label: string; state: StepState }[]; building: boolean;
  error?: { text: string; detail: string; kind: string };
  url?: string; hello?: boolean; claimCode?: string | null; existed?: boolean; subdomainNew?: boolean; subdomain?: string;
  turn?: 'on' | 'skipped' | 'manual-needed'; turnError?: string; vars?: Record<string, string>;
}
let S: Session | null = null;
const TTL = 30 * 60_000;
const live = () => { if (S && Date.now() - S.touched > TTL) S = null; return S; };
const forget = () => { if (S) S.key = ''; S = null; };

// ---------------------------------------------------------------- request checks (same rules as the /pair page)
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const pageNonce = crypto.randomBytes(24).toString('base64url');
function localOnly(req: Request, page = false) {
  const addr = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
  const o = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (req.headers.origin === 'null' || (o && !LOOPBACK_ORIGIN.test(o))) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return page && req.headers['sec-fetch-mode'] === 'navigate' && req.method === 'GET';
  return true;
}
const nonceOk = (req: Request) => {
  const n = (req.body as { nonce?: unknown } | undefined)?.nonce;
  return typeof n === 'string' && n.length === pageNonce.length && crypto.timingSafeEqual(Buffer.from(n), Buffer.from(pageNonce));
};
function guard(req: Request, res: Response, post: boolean) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!localOnly(req) || (post && !nonceOk(req))) { res.status(403).json({ error: 'Open this page on this computer: http://127.0.0.1:5191/invite-server' }); return false; }
  return true;
}

// ---------------------------------------------------------------- the pre-built invite server
function loadBundle(): { m: RelayManifest; code: Buffer } {
  const dir = relayDir();
  let m: RelayManifest, code: Buffer;
  // a source checkout has no relay/dist yet: build it once from relay/src (tools/build_relay.mjs, esbuild, no network)
  if (!seams.relayDir && !process.env.VTP_RELAY_DIST && !fs.existsSync(path.join(dir, 'relay-manifest.json'))) {
    spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build_relay.mjs')], { cwd: ROOT, windowsHide: true, timeout: 120_000 });
  }
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, 'relay-manifest.json'), 'utf8')) as RelayManifest;
    code = fs.readFileSync(path.join(dir, m.mainModule || 'worker.js'));
  } catch {
    throw new CfError('cloudflare', 'The invite server files could not be built. Run "npm install" in the VTube Pro folder, then try again.', 0, `not found in ${path.basename(dir)}`);
  }
  if (m.kind !== 'vtube-pro-relay' || !/^[a-z0-9-]{1,63}$/.test(m.scriptName) || m.bytes !== code.length
    || crypto.createHash('sha256').update(code).digest('hex') !== m.sha256) {
    throw new CfError('cloudflare', 'The invite server files look damaged. Delete the relay/dist folder and try again.', 0, 'checksum mismatch');
  }
  return { m, code };
}

function publicState() {
  const s = live();
  const saved = savedRelayUrl();
  return {
    templateUrl: TOKEN_TEMPLATE_URL,
    saved: saved || null,
    clientId: savedClientId() || null,
    redirectUri: discordRedirectUri(),
    connected: !!s?.key,
    accounts: s?.accounts.map((a) => ({ id: a.id, name: a.name })) ?? [],
    account: s?.account ?? null,
    building: !!s?.building,
    progress: s?.progress ?? [],
    error: s?.error ?? null,
    url: s?.url ?? null,
    hello: !!s?.hello,
    claimCode: s?.claimCode ?? null,
    existed: !!s?.existed,
    subdomain: s?.subdomain ?? null,
    subdomainNew: !!s?.subdomainNew,
    host: hostSignedIn(),
    turn: s?.turn ?? null,
    turnError: s?.turnError ?? null,
  };
}
const fail = (s: Session, e: unknown) => {
  const err = e instanceof CfError ? e : new CfError('cloudflare', 'Something went wrong. Try again, or press Get help.', 0, String((e as Error)?.message ?? e).slice(0, 200));
  s.error = { text: err.message, detail: err.detail.replace(s.key, '[key]'), kind: err.kind };
};

async function hello(url: string): Promise<boolean> {
  const tries = seams.helloTries ?? 12, gap = seams.helloGapMs ?? 5000;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await doFetch(`${url}/health`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
      const j = (await r.json().catch(() => null)) as { service?: string } | null;
      if (r.ok && j?.service === 'vtube-pro-relay') return true;
    } catch { /* DNS for a brand-new workers.dev name can take a minute */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gap));
  }
  return false;
}

/** The whole "Build my invite server" run. Progress lands in S.progress; the page polls /state. */
async function build(s: Session, account: string, newCode: boolean, turn?: { keyId: string; keyToken: string }, app?: { clientId: string; secret: string; botToken: string }) {
  const cf = new Cloudflare({ token: s.key, api: apiBase(), fetch: doFetch });
  const step = (id: string, label: string) => { s.progress.push({ id, label, state: 'run' }); return (st: StepState = 'ok') => { const p = s.progress.find((x) => x.id === id); if (p) p.state = st; }; };
  s.building = true; s.error = undefined; s.progress = []; s.touched = Date.now();
  try {
    let done = step('files', 'Getting your invite server ready');
    const { m, code } = loadBundle(); done();

    done = step('name', 'Picking your free web address');
    let sub = await cf.subdomain(account);
    if (!sub) {
      // first Worker on this account: a private random name (it shows in every guest link, so never their name)
      for (let i = 0; i < 4 && !sub; i++) {
        try { sub = await cf.createSubdomain(account, privateSubdomain()); s.subdomainNew = true; } catch (e) { if (!(e instanceof CfError && e.kind === 'conflict') || i === 3) throw e; }
      }
    }
    s.subdomain = sub; done();

    done = step('upload', s.existed ? 'Updating your invite server' : 'Uploading your invite server');
    const existing = await cf.script(account, m.scriptName);
    s.existed = !!existing;
    const kept = existing ? await cf.bindings(account, m.scriptName) : { vars: {}, secrets: [] as string[] };
    // the template's defaults, then whatever this streamer already set (their Discord app, PUBLIC_NAME, …)
    const vars: Record<string, string> = { ...m.vars, ...kept.vars, ...(turn ? { TURN_KEY_ID: turn.keyId } : {}) };
    const secrets: Record<string, string> = {};
    // YOUR OWN Discord application is required (the relay has no built-in one): its Client ID is a plain setting, its
    // secret (and the optional bot token) are Cloudflare secrets. Not pasted again on an update = keep what is there.
    const clientId = app?.clientId || savedClientId() || vars.DISCORD_CLIENT_ID || '';
    if (!clientId || (!app?.secret && !kept.secrets.includes('DISCORD_CLIENT_SECRET'))) throw new CfError('need-discord', FRIENDLY['need-discord']);
    vars.DISCORD_CLIENT_ID = clientId;
    if (app?.secret) secrets.DISCORD_CLIENT_SECRET = app.secret;
    if (app?.botToken) secrets.DISCORD_BOT_TOKEN = app.botToken;
    if (!kept.secrets.includes('TICKET_SECRET')) secrets.TICKET_SECRET = newTicketSecret();   // a new one signs everyone out
    let claim: { code: string; hash: string } | null = null;
    if (!turn && (newCode || !kept.secrets.includes('HOST_CLAIM'))) { claim = newClaimCode(); secrets.HOST_CLAIM = claim.hash; }
    if (turn) secrets.TURN_KEY_API_TOKEN = turn.keyToken;
    await cf.upload(account, m, code, { vars, secrets, migrateFrom: existing ? existing.migrationTag : '', update: !!existing });
    s.vars = vars;
    if (claim) s.claimCode = claim.code;
    saveClientId(clientId);
    done();

    // an update of a server that already answers on the streamer's own domain (Private links): keep that address
    // and leave workers.dev as they set it; everyone else gets the free workers.dev address switched on
    const saved = savedRelayUrl();
    const ownDomain = !!existing && /^https:/.test(saved) && !/\.workers\.dev$/i.test(new URL(saved).hostname);
    done = step('on', 'Turning it on');
    if (!ownDomain) await cf.enableWorkersDev(account, m.scriptName);
    done();

    const url = ownDomain ? saved : relayUrlFor(m.scriptName, sub);
    done = step('save', 'Saving it in VTube Pro');
    s.url = saveRelayUrl(url);
    if (claim) offerSetupClaim(s.url, claim.code);
    done();

    done = step('hello', 'Saying hello to it');
    s.hello = await hello(s.url);
    done(s.hello ? 'ok' : 'wait');
  } catch (e) {
    const p = s.progress.find((x) => x.state === 'run'); if (p) p.state = 'fail';
    fail(s, e);
  } finally {
    s.building = false; s.touched = Date.now();
  }
}

// ---------------------------------------------------------------- routes
relaySetupRoutes.get(['/invite-server', '/invite-server/'], (req, res) => {
  if (!localOnly(req, true)) { res.status(403).json({ error: 'Open this page on this computer: http://127.0.0.1:5191/invite-server' }); return; }
  const sn = crypto.randomBytes(16).toString('base64url');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${sn}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(PAGE.replace('__SN__', sn).replace('__NONCE__', pageNonce));
});

relaySetupRoutes.get('/invite-server/state', (req, res) => { if (guard(req, res, false)) res.json(publicState()); });

relaySetupRoutes.post('/invite-server/key', async (req, res) => {
  if (!guard(req, res, true)) return;
  const k = checkKeyShape((req.body as { key?: unknown }).key);
  if ('error' in k) { res.status(400).json({ error: k.error }); return; }
  try {
    const accounts = await new Cloudflare({ token: k.key, api: apiBase(), fetch: doFetch }).accounts();
    if (!accounts.length) { res.status(400).json({ error: 'That key can’t reach any Cloudflare account. Make a new one with the Open Cloudflare button.' }); return; }
    forget();
    S = { key: k.key, accounts, account: accounts.length === 1 ? accounts[0].id : undefined, touched: Date.now(), progress: [], building: false };
    res.json(publicState());
  } catch (e) {
    const err = e instanceof CfError ? e : new CfError('cloudflare', 'Something went wrong. Try again, or press Get help.');
    res.status(err.kind === 'network' ? 502 : 400).json({ error: err.message, detail: err.detail.replace(k.key, '[key]') });
  }
});

relaySetupRoutes.post('/invite-server/build', (req, res) => {
  if (!guard(req, res, true)) return;
  const s = live();
  if (!s?.key) { res.status(400).json({ error: 'Connect your Cloudflare account first.' }); return; }
  if (s.building) { res.status(409).json({ error: 'Already building. One moment.' }); return; }
  const b = req.body as { account?: unknown; newCode?: unknown; clientId?: unknown; clientSecret?: unknown; botToken?: unknown };
  const account = typeof b.account === 'string' && s.accounts.some((a) => a.id === b.account) ? b.account : s.account;
  if (!account) { res.status(400).json({ error: 'Pick the Cloudflare account to use.' }); return; }
  // your own Discord application: Client ID (pasted, or the one saved before) + Client Secret (+ optional bot token).
  // "Make a new host code" re-runs this without them: the values already on the server stay.
  const idRaw = String(b.clientId ?? '').trim(), secretRaw = String(b.clientSecret ?? '').trim();
  let app: { clientId: string; secret: string; botToken: string } | undefined;
  if (idRaw || secretRaw || b.newCode !== true) {
    const idc = idRaw ? checkClientId(idRaw) : savedClientId() ? { ok: true as const, id: savedClientId() } : checkClientId('');
    if (!idc.ok) { res.status(400).json({ error: idc.error }); return; }
    const sec = secretRaw ? checkClientSecret(secretRaw) : null;
    if (sec && !sec.ok) { res.status(400).json({ error: sec.error }); return; }
    if (!sec && !savedRelayUrl()) { res.status(400).json({ error: FRIENDLY['need-discord'] }); return; }
    const bot = checkBotToken(String(b.botToken ?? ''));
    if (!bot.ok) { res.status(400).json({ error: bot.error }); return; }
    app = { clientId: idc.id, secret: sec?.ok ? sec.value : '', botToken: bot.value };
  }
  s.account = account;
  void build(s, account, b.newCode === true, undefined, app);
  res.json(publicState());
});

relaySetupRoutes.post('/invite-server/check', async (req, res) => {
  if (!guard(req, res, true)) return;
  const s = live();
  if (!s?.url) { res.status(400).json({ error: 'Build your invite server first.' }); return; }
  s.touched = Date.now();
  const saveTries = seams.helloTries; seams.helloTries = 1;
  try { s.hello = await hello(s.url); } finally { seams.helloTries = saveTries; }
  const p = s.progress.find((x) => x.id === 'hello'); if (p) p.state = s.hello ? 'ok' : 'wait';
  res.json(publicState());
});

relaySetupRoutes.post('/invite-server/turn', async (req, res) => {
  if (!guard(req, res, true)) return;
  const s = live();
  if (!s?.key || !s.account || !s.url) { res.status(400).json({ error: 'Build your invite server first.' }); return; }
  if (s.building) { res.status(409).json({ error: 'Already working on it. One moment.' }); return; }
  const b = req.body as { mode?: unknown; keyId?: unknown; keyToken?: unknown };
  s.turnError = undefined;
  if (b.mode === 'skip') { s.turn = 'skipped'; s.key = ''; res.json(publicState()); return; }   // done: drop the key now
  let turn: { keyId: string; keyToken: string };
  if (b.mode === 'manual') {
    const keyId = String(b.keyId ?? '').trim(), keyToken = String(b.keyToken ?? '').trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(keyId)) { res.status(400).json({ error: 'That Turn Token ID doesn’t look right. Copy it again from Cloudflare.' }); return; }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(keyToken)) { res.status(400).json({ error: 'That API Token doesn’t look right. Copy it again from Cloudflare.' }); return; }
    turn = { keyId, keyToken };
  } else {
    try { const k = await new Cloudflare({ token: s.key, api: apiBase(), fetch: doFetch }).createTurnKey(s.account); turn = { keyId: k.uid, keyToken: k.key }; } catch (e) {
      // the setup key only has Workers rights unless the streamer added Realtime: fall back to two boxes
      s.turn = 'manual-needed';
      s.turnError = e instanceof CfError && (e.kind === 'no-permission' || e.kind === 'bad-key') ? '' : (e as Error).message;
      res.json(publicState()); return;
    }
  }
  await build(s, s.account, false, turn);
  if (!s.error) { s.turn = 'on'; s.key = ''; }   // done: drop the key now
  res.json(publicState());
});

relaySetupRoutes.post('/invite-server/forget', (req, res) => { if (!guard(req, res, true)) return; forget(); res.json(publicState()); });

/** Tests only. */
export const _relaySetupSession = () => S;
export const _resetRelaySetup = () => forget();

// ---------------------------------------------------------------- the page
const LOGO = `<svg viewBox="0 0 100 100" width="30" height="30" aria-hidden="true"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161c21"/><stop offset="1" stop-color="#07090c"/></linearGradient><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient></defs><rect width="100" height="100" rx="23" fill="url(#t)"/><g transform="translate(50 52) scale(.7) translate(-50 -52)"><path d="M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z" fill="url(#g)"/></g></svg>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Set up my invite server · VTube Pro</title>
<style>
:root{color-scheme:dark;--ink:#06080a;--ink2:#0b0f12;--ink3:#11171b;--line:rgb(255 255 255/.08);--line2:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;--lime:#7bd88f;--limehi:#a6f5b4;--sky:#6cc7f5;--amber:#ffcf6a;--err:#ff6b6b;
--disp:Archivo,ui-sans-serif,system-ui,"Segoe UI",sans-serif;--ui:Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;--ease:cubic-bezier(.16,1,.3,1)}
*{box-sizing:border-box}html,body{margin:0;color:var(--fg);font:16px/1.55 var(--ui)}
html{min-height:100%;background:radial-gradient(900px 500px at 85% -10%,rgb(108 199 245/.10),transparent 60%),radial-gradient(800px 500px at -10% 100%,rgb(123 216 143/.08),transparent 60%) fixed,var(--ink)}body{background:transparent}
header{display:flex;align-items:center;gap:10px;padding:18px 24px;max-width:760px;margin:0 auto}
header b{font:700 17px var(--disp);letter-spacing:-.01em}.beta{font:500 10px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--ink);background:var(--lime);border-radius:999px;padding:3px 8px;margin-left:4px}
header .sp{flex:1}header a{color:var(--mute);font-size:14px;text-decoration:none}header a:hover{color:var(--fg)}
main{max-width:760px;margin:0 auto;padding:8px 24px 64px}
.card{background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);border-radius:24px;box-shadow:inset 0 1px 0 rgb(255 255 255/.06),0 30px 80px -40px rgb(0 0 0/.8);padding:34px 36px;animation:in .6s var(--ease)}
@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.eyebrow{font:500 11px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--lime);margin:0 0 10px}
h1{font:700 34px/1.12 var(--disp);letter-spacing:-.02em;margin:0 0 10px}h1 .g{background:linear-gradient(135deg,#7bd88f,#6cc7f5);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:var(--mute);font-size:17px;margin:0 0 22px;max-width:56ch}.note{color:var(--dim);font-size:14px;margin:14px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;font:700 17px var(--disp);letter-spacing:-.01em;color:var(--ink);background:var(--lime);border:0;border-radius:16px;padding:16px 26px;cursor:pointer;text-decoration:none;transition:background .18s var(--ease),transform .18s var(--ease)}
.btn:hover{background:var(--limehi)}.btn:active{transform:translateY(1px)}.btn[disabled]{opacity:.5;cursor:default}
.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line2);font-weight:600}.btn.secondary:hover{background:rgb(255 255 255/.05)}
.link{background:none;border:0;color:var(--sky);font:inherit;font-size:15px;cursor:pointer;padding:6px 2px;text-decoration:underline;text-underline-offset:3px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
:focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:6px}
.paste{display:flex;gap:10px;margin-top:18px}.paste input{flex:1;min-width:0;font:15px var(--mono);color:var(--fg);background:var(--ink2);border:1px solid var(--line2);border-radius:12px;padding:14px 14px}
.paste input::placeholder{color:var(--dim)}
.sub{counter-reset:s;list-style:none;padding:0;margin:0 0 20px}.sub li{counter-increment:s;display:flex;gap:12px;align-items:flex-start;margin:0 0 10px;color:var(--mute)}
.sub li::before{content:counter(s);flex:none;width:26px;height:26px;border-radius:999px;background:rgb(123 216 143/.12);color:var(--lime);font:600 13px/26px var(--mono);text-align:center}
.sub li b{color:var(--fg);font-weight:600}
.progress{list-style:none;margin:6px 0 22px;padding:0}.progress li{display:flex;gap:12px;align-items:center;padding:9px 0;color:var(--mute);border-top:1px solid var(--line)}.progress li:first-child{border-top:0}
.dot{flex:none;width:22px;height:22px;border-radius:999px;border:2px solid var(--line2);display:grid;place-items:center;font:700 12px var(--ui)}
.ok .dot{background:var(--lime);border-color:var(--lime);color:var(--ink)}.ok{color:var(--fg)}
.run .dot{border-color:var(--lime);border-right-color:transparent;animation:spin .8s linear infinite}.wait .dot{border-color:var(--amber);color:var(--amber)}.fail .dot{border-color:var(--err);color:var(--err)}
@keyframes spin{to{transform:rotate(360deg)}}
.code{font:700 52px/1 var(--mono);letter-spacing:.12em;color:var(--lime);background:var(--ink2);border:1px solid var(--line2);border-radius:20px;padding:26px 20px;text-align:center;margin:6px 0 16px;user-select:all}
.err{color:var(--err);margin:14px 0 0;font-size:15px}.ok-msg{color:var(--lime)}
.big-ok{width:72px;height:72px;border-radius:999px;background:var(--lime);color:var(--ink);display:grid;place-items:center;font:800 38px var(--disp);margin:0 0 18px;box-shadow:0 0 0 10px rgb(123 216 143/.12)}
.acc{display:grid;gap:10px;margin:0 0 18px}.acc button{text-align:left;font:600 16px var(--ui);color:var(--fg);background:var(--ink2);border:1px solid var(--line2);border-radius:14px;padding:14px 16px;cursor:pointer}
.acc button[aria-pressed=true]{border-color:var(--lime);box-shadow:0 0 0 1px var(--lime) inset}
details{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;color:var(--mute);font-size:14px}details div{color:var(--dim);font-size:14px;padding:8px 0 0}details code{font:13px var(--mono);color:var(--fg);word-break:break-all}
.addr{font:15px var(--mono);color:var(--fg);background:var(--ink2);border:1px solid var(--line);border-radius:10px;padding:8px 12px;display:inline-block;margin:4px 0 0;word-break:break-all}
.steps{display:flex;gap:6px;margin:0 0 18px}.steps i{height:4px;flex:1;border-radius:9px;background:var(--line2)}.steps i.on{background:var(--lime)}
@media (max-width:560px){.card{padding:24px 20px}h1{font-size:27px}.code{font-size:36px}.paste{flex-direction:column}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header>${LOGO}<b>VTube Pro</b><span class="beta">Beta</span><span class="sp"></span><a href="/" id="home">Back to VTube Pro</a></header>
<main><div class="card" id="card" aria-live="polite"></div></main>
<script nonce="__SN__">
const NONCE='__NONCE__';
let st=null, poll=0, sel=null, msg='', manual=false, skipped=false;
const dc={id:'',sec:'',bot:''};   // the Discord app fields (kept while the page redraws; the secret is never stored anywhere)
const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
async function get(){const r=await fetch('/invite-server/state',{cache:'no-store'});st=await r.json();}
async function post(p,body){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,nonce:NONCE})});const j=await r.json().catch(()=>({error:'Something went wrong. Try again.'}));if(!r.ok){msg=j.error||'Something went wrong. Try again.';if(j.detail)msg+='|'+j.detail;return null}msg='';st=j;return j}
function bar(n){return '<div class="steps" aria-hidden="true">'+[1,2,3,4].map(i=>'<i class="'+(i<=n?'on':'')+'"></i>').join('')+'</div>'}
function errBox(){if(!msg)return '';const [t,d]=msg.split('|');return '<p class="err" role="alert">'+esc(t)+'</p>'+(d?'<details><summary>Details</summary><div><code>'+esc(d)+'</code></div></details>':'')}
function hostOf(u){try{return new URL(u).host}catch{return u}}
function view(){
  const c=$('#card');
  if(!st){c.innerHTML='<p class="lede">One moment…</p>';return}
  // ---- done
  if(st.url&&st.hello&&st.turn&&st.turn!=='manual-needed'){
    c.innerHTML='<div class="big-ok">✓</div><p class="eyebrow">All set</p><h1>Your invite server is <span class="g">ready</span> ✔</h1>'+
    '<p class="lede">It’s saved in VTube Pro. Nothing to copy. Your guests join through it with one link.</p>'+
    '<div class="row"><a class="btn" href="/" id="done">Back to VTube Pro</a></div>'+
    '<p class="note">'+(st.host?'You’re the host. ':'')+(st.turn==='on'?'Guests on any network can connect.':'You can turn on “connect from anywhere” later from this page.')+'</p>'+
    '<details><summary>Details</summary><div>Address: <code>'+esc(st.url)+'</code><br>It runs on your own free Cloudflare account. The key you pasted is already forgotten.</div></details>';
    return;
  }
  // ---- step 4: TURN
  if(st.url&&st.hello&&(st.host||skipped)&&!st.turn||st.turn==='manual-needed'){
    if(st.turn==='manual-needed'||manual){
      c.innerHTML=bar(4)+'<p class="eyebrow">Step 4 of 4 · optional</p><h1>Connect from anywhere</h1>'+
      '<p class="lede">Your key can’t do this part by itself. It takes one more minute on Cloudflare.</p>'+
      '<ol class="sub"><li><span>Open Cloudflare, then <b>Realtime → TURN Server → Create</b>.</span></li><li><span>Copy the <b>Turn Token ID</b> and the <b>API Token</b> into the two boxes below.</span></li></ol>'+
      '<div class="row"><a class="btn secondary" href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Open Cloudflare</a></div>'+
      '<div class="paste"><input id="tid" placeholder="Turn Token ID" autocomplete="off" spellcheck="false"><input id="ttok" type="password" placeholder="API Token" autocomplete="off" spellcheck="false"></div>'+
      '<div class="row" style="margin-top:14px"><button class="btn" id="tsave">Turn it on</button><button class="link" id="tskip">Skip for now</button></div>'+errBox();
      $('#tsave').onclick=async()=>{busyBtn('#tsave','Turning it on…');await post('/invite-server/turn',{mode:'manual',keyId:$('#tid').value,keyToken:$('#ttok').value});manual=!!msg;view()};
      $('#tskip').onclick=async()=>{await post('/invite-server/turn',{mode:'skip'});manual=false;view()};
      return;
    }
    c.innerHTML=bar(4)+'<p class="eyebrow">Step 4 of 4 · optional</p><h1>Let every guest connect</h1>'+
    '<p class="lede">Some home and school networks block video calls. A free Cloudflare service gets everyone through.</p>'+
    '<div class="row"><button class="btn" id="tauto">Turn it on</button><button class="link" id="tskip">Skip for now</button></div>'+
    (st.error?'<p class="err" role="alert">'+esc(st.error.text)+'</p>':'')+(st.turnError?'<p class="err" role="alert">'+esc(st.turnError)+'</p>':'')+errBox()+
    '<details><summary>What is this?</summary><div>Cloudflare calls it TURN. It relays a guest’s video only when a direct connection fails. It uses your Cloudflare account’s free allowance.</div></details>';
    $('#tauto').onclick=async()=>{busyBtn('#tauto','Turning it on…');await post('/invite-server/turn',{mode:'auto'});view()};
    $('#tskip').onclick=async()=>{await post('/invite-server/turn',{mode:'skip'});view()};
    return;
  }
  // ---- step 3: become the host (code)
  if(st.url&&st.hello){
    const code=st.claimCode;
    const redir=st.host?'':'<p class="note" style="margin:0 0 8px">First, in your Discord app → <b>OAuth2 → Redirects</b>, add these two lines, then press <b>Save Changes</b>:</p><div class="addr">'+esc(st.url)+'/cb</div><br><div class="addr">'+esc(st.redirectUri||'')+'</div><p class="note" style="margin:8px 0 16px">Without them Discord says “Invalid OAuth2 redirect_uri”.</p>';
    c.innerHTML=bar(3)+'<p class="eyebrow">Step 3 of 4</p><h1>'+(st.host?'You’re the host ✔':'Make it yours')+'</h1>'+redir+
    (st.host?'<p class="lede">Your invite server knows you. Nobody else can host on it.</p><div class="row"><button class="btn" id="next">Next</button></div>':
     (code?'<p class="lede">This is your host code. Sign in with Discord and we use it for you.</p><div class="code" id="code" aria-label="Your host code">'+esc(code)+'</div>'+
       '<div class="row"><a class="btn" id="signin" href="/api/discord/login" target="_blank" rel="noopener">Sign in with Discord</a><button class="btn secondary" id="copy">Copy code</button></div>'+
       '<p class="note">The code works once. Keep this page open until it says you’re the host.</p>'
      :'<p class="lede">Your invite server already has a host. Sign in with Discord to check it’s you.</p><div class="row"><a class="btn" id="signin" href="/api/discord/login" target="_blank" rel="noopener">Sign in with Discord</a><button class="link" id="newcode">Make a new host code</button></div>')+
     '<div class="row" style="margin-top:6px"><button class="link" id="later">I’ll do this later</button></div>')+errBox()+
    '<details><summary>Details</summary><div>Address: <code>'+esc(st.url)+'</code>'+(st.subdomainNew?'<br>We picked a private web address for you, so guest links never show your name.':'')+'</div></details>';
    if($('#next'))$('#next').onclick=()=>{skipped=true;view()};
    if($('#later'))$('#later').onclick=()=>{skipped=true;view()};
    if($('#copy'))$('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(code);$('#copy').textContent='Copied ✔'}catch{}};
    if($('#newcode'))$('#newcode').onclick=async()=>{await post('/invite-server/build',{newCode:true});tick()};
    return;
  }
  // ---- step 2: build (progress)
  if(st.connected){
    const many=st.accounts.length>1;
    const prog=st.progress.length?'<ul class="progress">'+st.progress.map(p=>'<li class="'+p.state+'"><span class="dot">'+(p.state==='ok'?'✓':p.state==='fail'?'!':p.state==='wait'?'…':'')+'</span>'+esc(p.label)+'</li>').join('')+'</ul>':'';
    const waiting=st.url&&!st.hello&&!st.building;
    const askApp=!st.building&&!waiting;
    const appForm='<p class="note" style="margin:0 0 8px">You sign in with <b>your own Discord app</b> (free). Open <b>discord.com/developers/applications</b> → New Application → OAuth2. Copy its <b>Client ID</b>, press <b>Reset Secret</b> and copy the <b>Client Secret</b>. They go only to your own Cloudflare account, never anywhere else.</p>'+
      '<div class="paste" style="flex-direction:column"><input id="dcid" placeholder="Discord Client ID (only digits)" autocomplete="off" spellcheck="false" aria-label="Discord Client ID"><input id="dcsec" type="password" placeholder="'+(st.saved?'Discord Client Secret (empty = keep the one already on your server)':'Discord Client Secret')+'" autocomplete="off" spellcheck="false" aria-label="Discord Client Secret"></div>'+
      '<details><summary>Optional: a bot that posts “is live · Join” in your server</summary><div class="paste"><input id="dcbot" type="password" placeholder="Discord bot token (optional)" autocomplete="off" spellcheck="false" aria-label="Discord bot token"></div></details>';
    c.innerHTML=bar(2)+'<p class="eyebrow">Step 2 of 4</p><h1>'+(st.building?'Building your invite server…':waiting?'Almost there':'Build your invite server')+'</h1>'+
    (st.building||st.progress.length?'':'<p class="lede">'+(st.saved?'We’ll update the one you have. Your guests and settings stay.':'This takes about a minute. You can watch each step here.')+'</p>')+
    (many&&!st.building&&!st.progress.length?'<p class="note" style="margin:0 0 10px">Which Cloudflare account?</p><div class="acc">'+st.accounts.map(a=>'<button data-id="'+esc(a.id)+'" aria-pressed="'+((sel||st.account)===a.id)+'">'+esc(a.name||a.id)+'</button>').join('')+'</div>':'')+
    prog+(askApp?appForm:'')+(waiting?'<p class="lede">Your invite server is starting. A brand-new address can take a minute.</p><div class="row"><button class="btn" id="check">Check again</button></div>':'')+
    (!st.building&&!waiting?'<div class="row"><button class="btn" id="build">'+(st.error?'Try again':st.saved?'Update my invite server':'Build my invite server')+'</button></div>':'')+
    (st.error?'<p class="err" role="alert">'+esc(st.error.text)+'</p>'+(st.error.detail?'<details><summary>Details</summary><div><code>'+esc(st.error.detail)+'</code></div></details>':''):'')+errBox();
    document.querySelectorAll('.acc button').forEach(b=>b.onclick=()=>{sel=b.dataset.id;view()});
    if($('#dcid')){$('#dcid').value=dc.id||st.clientId||'';$('#dcid').oninput=(e)=>{dc.id=e.target.value};$('#dcsec').value=dc.sec;$('#dcsec').oninput=(e)=>{dc.sec=e.target.value};$('#dcbot').value=dc.bot;$('#dcbot').oninput=(e)=>{dc.bot=e.target.value}}
    if($('#build'))$('#build').onclick=async()=>{if(many&&!(sel||st.account)){msg='Pick the Cloudflare account to use.';view();return}const r=await post('/invite-server/build',{account:sel||st.account,clientId:dc.id||st.clientId||'',clientSecret:dc.sec,botToken:dc.bot});if(r){dc.sec='';dc.bot=''}else view();tick()};
    if($('#check'))$('#check').onclick=async()=>{busyBtn('#check','Checking…');await post('/invite-server/check',{});view()};
    return;
  }
  // ---- step 1: connect Cloudflare
  c.innerHTML=bar(1)+'<p class="eyebrow">Step 1 of 4</p><h1>Set up your <span class="g">invite server</span></h1>'+
  '<p class="lede">Your guests join your show through it. It runs free on your own Cloudflare account.</p>'+
  (st.saved?'<p class="note" style="margin:-8px 0 18px">You already have one: <span class="addr">'+esc(hostOf(st.saved))+'</span>. Doing this again updates it.</p>':'')+
  '<ol class="sub"><li><span>Press <b>Open Cloudflare</b>. Sign in, or make a free account.</span></li><li><span>Scroll down and press <b>Continue to summary</b>, then <b>Create Token</b>.</span></li><li><span>Press <b>Copy</b>, come back here, and paste it below.</span></li></ol>'+
  '<div class="row"><a class="btn" id="open" href="'+esc(st.templateUrl)+'" target="_blank" rel="noopener noreferrer">Open Cloudflare</a></div>'+
  '<div class="paste"><input id="key" type="password" placeholder="Paste your Cloudflare key here" autocomplete="off" spellcheck="false" aria-label="Your Cloudflare key"><button class="btn secondary" id="go">Connect</button></div>'+errBox()+
  '<details><summary>Is this safe?</summary><div>Cloudflare calls this key an “API token”. It can only set up Workers on your account. VTube Pro uses it for this setup only: it stays on this computer, in memory, and is forgotten when you’re done. You can delete it on Cloudflare any time.</div></details>';
  $('#go').onclick=connect;$('#key').onkeydown=(e)=>{if(e.key==='Enter')connect()};
}
function busyBtn(s,t){const b=$(s);if(b){b.disabled=true;b.textContent=t}}
async function connect(){busyBtn('#go','Connecting…');await post('/invite-server/key',{key:$('#key').value});view()}
let last='';
async function tick(){clearTimeout(poll);await get().catch(()=>{});const now=JSON.stringify(st);if(now!==last){last=now;view()}const need=st&&(st.building||(st.url&&st.hello&&!st.host&&!skipped));if(need)poll=setTimeout(tick,st.building?700:2500)}
tick();
</script></body></html>`;

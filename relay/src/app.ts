// Front door of the relay (platform-neutral: the Worker in index.ts and the Node mock both call handle()).
//
//   GET  /j/<room>          guest clicked Join in Discord → Discord OAuth (identify [+ guilds.members.read])
//   GET  /cb                OAuth callback → guild/role/ban checks → a 10-min single-use guest ticket →
//                           a page that opens http://127.0.0.1:5191/join#relay=…&t=… (their own VTube Pro)
//   POST /oauth/exchange    host sign-in: the desktop app's loopback code + PKCE verifier → identity + host session
//   GET  /api/channels      (host) text channels the bot can post in
//   POST /api/rooms         (host) create a room [+ bot posts the invite] → host ticket
//   POST /api/rooms/<id>/ticket | /end   (host)
//   GET  /room/<id>/ws      WebSocket signalling (Durable Object)
//   POST /api/rooms/<id>/guestlink  (host) mint / revoke the NO-SIGN-IN interview link (guestlink) → <relay>/g/<token>
//   GET  /g/<token>         no-sign-in guest page (the same browser page as /tv, with a name box; the host still approves
//                           the knock and sees the name marked "not verified")
//   POST /g/ticket          that page: {inv, name, gk} → a 10-min single-use guest ticket (gk = the tab's random key:
//                           the link counts distinct guests, so reconnecting never uses it up)
//   GET  /j/<room>?as=tv    Discord sign-in link that lands straight on the browser page (verified name, no VTube Pro)
//   GET  /oauth2/authorize  host sign-in: forwards the desktop app's request to Discord with YOUR Discord application
//                           (DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET are required; there is no shared or built-in app)
//   GET  /tv                no VTube Pro? join in this browser as a webcam / VTube Studio TV (the ticket arrives in the
//                           #fragment from /cb, never in a request); the page is bundled in tvGuestPage.gen.ts
//   GET  /phone/<id>/ws     phone link: the browser phone tracker meets the studio (handshake only; phoneLink.ts)
// No request or payload is logged; access tokens are used once and dropped.
import { DISCORD_MISSING, appJoinUrl, discordAuthorize, discordClientId, discordReady, hostIds, localRedirects, shownHostName, type Env } from './env.ts';
import { claimRelay, claimState, isHost, notHost } from './claim.ts';
import { botGuildChannels, exchangeCode, me, memberOk } from './discord.ts';
import { pkce, randomId, sign, verify } from './tickets.ts';
import type { RoomConfig } from './room.ts';
import { TV_GUEST_JS } from './tvGuestPage.gen.ts';
import { INVITE_MAX_MINUTES, inviteMinutes } from './inviteExpiry.ts';
import { brandAsset, guestPageHtml, inviteOg, isUnfurlBot, joinedBody, page, statePage, STATES, unfurlPage } from './guestUi.ts';
import { parseRole } from './phoneLink.ts';

export interface RoomDir { room(id: string): { fetch(req: Request): Promise<Response> } }

const ROOM = /^[a-z0-9]{16,40}$/;
const SNOW = /^\d{5,25}$/;

// ---------------------------------------------------------------- best-effort per-IP rate limit (per isolate)
const buckets = new Map<string, { n: number; t: number }>();
function limited(ip: string, what: string, perMin: number): boolean {
  const k = `${what}:${ip}`, now = Date.now();
  const b = buckets.get(k) ?? { n: perMin, t: now };
  b.n = Math.min(perMin, b.n + ((now - b.t) / 60000) * perMin); b.t = now;
  if (buckets.size > 5000) buckets.clear();
  if (b.n < 1) { buckets.set(k, b); return true; }
  b.n -= 1; buckets.set(k, b);
  return false;
}

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...SEC } });

/** /tv: the webcam-TV guest page. Camera / mic / window sharing only for this page; scripts only with the nonce;
 *  network only to this relay (the WebRTC media itself goes peer-to-peer or through TURN). */
function tvGuestPage(url: URL, invite: { hostName: string } | null = null, show = '') {
  const n = randomId(16);
  const ws = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'; connect-src 'self' ${ws}; media-src 'self' blob: mediastream:; worker-src blob:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  // guestlink: one page for both ways in (Discord ticket in the #fragment, or a no-sign-in invite with a name box).
  // invite-experience: the markup + look live in guestUi.ts (branded, step by step, phone-first); the link preview names
  // only PUBLIC_NAME (`show`), never a Discord name.
  const html = guestPageHtml({ title: invite ? `Join ${invite.hostName}’s show` : 'Join with your webcam', host: invite ? invite.hostName : 'the host', invite: !!invite, nonce: n, js: TV_GUEST_JS, origin: url.origin,
    og: inviteOg(invite ? 'guest' : 'browser', show, `${url.origin}${url.pathname}`) });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self)', ...SEC, 'x-robots-tag': 'noindex, nofollow' } });
}

/** Host sign-in start: the desktop app sends the browser here; we forward it to Discord with the deployer's OWN app. */
function hostStart(env: Env, url: URL, ip: string): Response {
  if (limited(ip, 'oauth', 10)) return statePage('Slow down', STATES.slow(), 429);
  const q = url.searchParams;
  const rd = q.get('redirect_uri') ?? '', st = q.get('state') ?? '', cc = q.get('code_challenge') ?? '';
  if (!localRedirects(env).has(rd) || !/^[A-Za-z0-9_-]{8,128}$/.test(st) || !/^[A-Za-z0-9_-]{43}$/.test(cc) || q.get('code_challenge_method') !== 'S256' || q.get('response_type') !== 'code')
    return json({ error: 'bad request', hint: 'That sign-in link is broken. Go back to VTube Pro and click Connect Discord again.' }, 400);
  if (!discordReady(env)) return statePage('Almost ready', STATES.notSetUp(), 503);
  const fwd = new URLSearchParams({ client_id: discordClientId(env), response_type: 'code', redirect_uri: rd, scope: 'identify', state: st, code_challenge: cc, code_challenge_method: 'S256', prompt: 'consent' });
  return new Response(null, { status: 302, headers: { location: `${discordAuthorize(env)}?${fwd}`, ...SEC } });
}

async function roomInfo(dir: RoomDir, id: string, uid?: string) {
  const r = await dir.room(id).fetch(new Request(`https://room/info${uid ? `?uid=${uid}` : ''}`));
  return (await r.json()) as { alive: boolean; hostUid?: string; hostName?: string; hostAvatar?: string | null; guildId?: string | null; roleIds?: string[]; banned?: boolean; expiresAt?: number };
}
async function hostSession(env: Env, dir: RoomDir, req: Request) {
  const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const s = await verify(env.TICKET_SECRET, tok, 'hs');
  if (!s || !(await isHost(env, dir, String(s.u)))) return null;
  return s;
}
function cookie(req: Request, name: string) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return '';
}

export async function handle(req: Request, env: Env, dir: RoomDir, ip: string): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const p = url.pathname;
  try {
    if (p === '/' || p === '/health') {
      // setup self-check (booleans only — never a secret value): what a working guest join needs
      const ready = {
        clientId: !!discordClientId(env) || !!env.DISCORD_API,
        clientSecret: !!env.DISCORD_CLIENT_SECRET,
        ticketSecret: String(env.TICKET_SECRET ?? '').length >= 32,
        bot: !!env.DISCORD_BOT_TOKEN,
        hosts: hostIds(env).size,
        claim: await claimState(env, dir),
        turn: !!((env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) || (env.TURN_URLS && env.TURN_SHARED_SECRET)),
      };
      // how people sign in here: your own Discord app (client id + secret), or not at all ('off')
      const signIn = { discord: discordReady(env) ? 'own' : 'off' };
      // phone: this relay passes the browser phone tracker's handshake (/phone/<id>/ws, phoneLink.ts)
      return json({ ok: true, service: 'vtube-pro-relay', v: 3, ready, signIn, redirect: `${origin}/cb`, phone: 1, ...(env.INBOXES ? { inbox: 1 } : {}) });
    }
    // invite-experience: the branded link-preview image + favicon (same for every room; cacheable)
    if (req.method === 'GET') { const a = brandAsset(p); if (a) return a; }
    const show = shownHostName(env, '');        // PUBLIC_NAME or '': the only name a link preview may carry
    const secretsOk = discordReady(env) && String(env.TICKET_SECRET ?? '').length >= 32;

    // ---------------------------------------------------------------- phone link socket → its own object (phoneLink.ts)
    const pl = /^\/phone\/([a-z0-9]{24,48})\/ws$/.exec(p);
    if (pl) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket only' }, 426);
      if (!parseRole(url.searchParams.get('role'))) return json({ error: 'role?' }, 400);
      if (limited(ip, 'ws', 30)) return json({ error: 'slow down' }, 429);
      return dir.room(`pl${pl[1]}`).fetch(req);
    }

    // ---------------------------------------------------------------- signalling socket → room object
    const ws = /^\/room\/([a-z0-9]{16,40})\/ws$/.exec(p);
    if (ws) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket only' }, 426);
      if (limited(ip, 'ws', 30)) return json({ error: 'slow down' }, 429);
      return dir.room(ws[1]).fetch(req);
    }

    // ---------------------------------------------------------------- guest join (Discord OAuth)
    const jm = /^\/j\/([a-z0-9]{16,40})$/.exec(p);
    if (jm && req.method === 'GET') {
      // invite-experience: a link-preview bot (Discord / X / iMessage …) gets the preview card, never a sign-in redirect
      // (own bucket: a spoofed bot user-agent still can’t hammer the room objects). This stays FIRST, so a preview bot
      // never gets a sign-in redirect / cookie.
      if (isUnfurlBot(req) && !limited(ip, 'unfurl', 60)) { const alive = (await roomInfo(dir, jm[1])).alive; return unfurlPage(inviteOg(alive ? (url.searchParams.get('as') === 'tv' ? 'browser' : 'party') : 'ended', show, `${origin}${p}${url.search}`), origin, alive ? 200 : 410); }
      if (limited(ip, 'join', 20)) return statePage('Slow down', STATES.slow(), 429);
      if (!secretsOk) return statePage('Almost ready', STATES.notSetUp(), 503);
      const info = await roomInfo(dir, jm[1]);
      if (!info.alive) return statePage('Show ended', STATES.ended(), 410, { og: inviteOg('ended', show, `${origin}${p}`), origin });
      const nonce = randomId(16);
      const state = await sign(env.TICKET_SECRET, { k: 'st', r: jm[1], j: nonce, ...(url.searchParams.get('as') === 'tv' ? { v: 'tv' as const } : {}) }, 600);
      const { challenge } = await pkce(env.TICKET_SECRET, nonce);
      const q = new URLSearchParams({ client_id: discordClientId(env), response_type: 'code', redirect_uri: `${origin}/cb`, scope: info.guildId ? 'identify guilds.members.read' : 'identify', state, code_challenge: challenge, code_challenge_method: 'S256' });
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return new Response(null, { status: 302, headers: { location: `${discordAuthorize(env)}?${q}`, 'set-cookie': `vtp_st=${nonce}; HttpOnly${secure}; SameSite=Lax; Path=/cb; Max-Age=600`, ...SEC } });
    }
    if (p === '/cb' && req.method === 'GET') {
      if (limited(ip, 'join', 20)) return statePage('Slow down', STATES.slow(), 429);
      const st = await verify(env.TICKET_SECRET, url.searchParams.get('state'), 'st');
      const nonce = cookie(req, 'vtp_st');
      if (!st || !st.r || !nonce || nonce !== st.j) return statePage('Link timed out', STATES.linkBroken(), 400);
      const code = url.searchParams.get('code');
      if (!code || code.length > 200) return statePage('Sign-in cancelled', STATES.cancelled(), 400);
      const { verifier } = await pkce(env.TICKET_SECRET, nonce);
      const token = await exchangeCode(env, code, `${origin}/cb`, verifier);
      const user = await me(env, token);
      const info = await roomInfo(dir, st.r, user.id);
      if (!info.alive) return statePage('Show ended', STATES.ended(info.hostName), 410);
      if (info.banned) return statePage('Not allowed', STATES.banned(), 403);
      let guildOk = false;
      if (info.guildId) {
        guildOk = await memberOk(env, token, info.guildId, info.roleIds ?? []);
        if (!guildOk) return statePage('Members only', STATES.membersOnly(String(info.hostName ?? 'The host'), !!info.roleIds?.length), 403);
      }
      const ticket = await sign(env.TICKET_SECRET, { k: 'g', r: st.r, u: user.id, n: user.name, un: user.username, a: user.avatar, g: guildOk ? 1 : 0, hn: info.hostName }, 600);
      const link = `${appJoinUrl(env)}#relay=${encodeURIComponent(origin)}&t=${encodeURIComponent(ticket)}`;
      const tvLink = `${origin}/tv#t=${encodeURIComponent(ticket)}`;
      // guestlink: the "Discord sign-in link" for browser-only guests (/j/<room>?as=tv) skips the VTube Pro page
      if (st.v === 'tv') return new Response(null, { status: 302, headers: { location: tvLink, 'set-cookie': 'vtp_st=; Path=/cb; Max-Age=0', ...SEC } });
      const n = randomId(12);
      // two ways in: your own VTube Pro (opens by itself after 3 s), or — no VTube Pro — this browser as a TV
      const res = page('Joining…', `${joinedBody(String(info.hostName ?? 'the host'), String(user.name ?? ''), link, tvLink)}
<script nonce="${n}">var k=3,go=document.getElementById('go'),cd=document.getElementById('cd'),t=setInterval(function(){k--;if(k<=0){clearInterval(t);cd.textContent='Opening VTube Pro…';location.href=go.href}else cd.textContent='Opening by itself in '+k+'…'},1000);document.getElementById('tv').addEventListener('click',function(){clearInterval(t);cd.textContent=''})</script>`, n);
      res.headers.append('set-cookie', 'vtp_st=; Path=/cb; Max-Age=0');
      return res;
    }

    // ---------------------------------------------------------------- host sign-in start (your own Discord app)
    if (p === '/oauth2/authorize' && req.method === 'GET') return hostStart(env, url, ip);
    // claim your relay: the signed-in Discord user types the setup's one-time code (claim.ts)
    if (p === '/claim' && req.method === 'POST') {
      if (limited(ip, 'claim', 5)) return json({ error: 'slow', hint: 'Too many tries. Wait a minute.' }, 429);
      if (!/^application\/json/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'bad request' }, 400);
      return claimRelay(env, dir, (await req.json().catch(() => ({}))) as Record<string, unknown>);
    }

    // ---------------------------------------------------------------- browser-only TV guest (no VTube Pro)
    if (p === '/tv' && req.method === 'GET') {
      if (limited(ip, 'join', 20)) return statePage('Slow down', STATES.slow(), 429);
      return tvGuestPage(url, null, show);
    }

    // ---------------------------------------------------------------- no-sign-in interview link (guestlink)
    const gm = /^\/g\/([A-Za-z0-9_.-]{20,2048})$/.exec(p);
    if (gm && req.method === 'GET') {
      if (limited(ip, 'join', 20)) return statePage('Slow down', STATES.slow(), 429);
      const inv = await verify(env.TICKET_SECRET, gm[1], 'gi');
      const info = inv?.r ? await roomInfo(dir, inv.r) : null;
      const live = info?.alive && inv?.gen ? ((await (await dir.room(inv.r!).fetch(new Request(`https://room/invite/live?gen=${encodeURIComponent(inv.gen)}`))).json()) as { ok: boolean }).ok : false;
      if (!inv || !info?.alive || !live) return statePage('Link expired', STATES.expired(), 410, { og: inviteOg('ended', show, `${origin}${p}`), origin });
      return tvGuestPage(url, { hostName: String(info.hostName ?? inv.hn ?? 'the host').slice(0, 40) }, show);
    }
    if (p === '/g/ticket' && req.method === 'POST') {
      if (limited(ip, 'gticket', 12)) return json({ error: 'Too many attempts — wait a minute' }, 429);
      // same-origin only (the page above): blocks cross-site form posts; JSON body only
      const o = req.headers.get('origin');
      if ((o && o !== origin) || !/^application\/json/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'bad request' }, 400);
      const b = (await req.json().catch(() => ({}))) as { inv?: unknown; name?: unknown; gk?: unknown };
      const inv = await verify(env.TICKET_SECRET, b.inv, 'gi');
      const name = String(b.name ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
      const gk = String(b.gk ?? '');
      if (!inv?.r || !inv.gen) return json({ error: 'This invite link has expired — ask the host for a new one' }, 410);
      if (!name) return json({ error: 'Type your name first' }, 400);
      if (!/^[a-z0-9]{16,40}$/.test(gk)) return json({ error: 'bad request' }, 400);
      const r = await dir.room(inv.r).fetch(new Request('https://room/invite/use', { method: 'POST', body: JSON.stringify({ gen: inv.gen, gk }) }));
      const { r: use } = (await r.json()) as { r: string };
      if (use === 'full') return json({ error: 'This invite link has already been used by the maximum number of guests — ask the host for a new one' }, 403);
      if (use !== 'ok') return json({ error: 'This invite link has expired — ask the host for a new one' }, 410);
      // a stable, non-Discord id per guest browser (never a snowflake: can't collide with / pretend to be a Discord user)
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.TICKET_SECRET}|${inv.gen}|${gk}`)));
      const uid = 'link' + Array.from(d.slice(0, 10), (x) => x.toString(16).padStart(2, '0')).join('');
      const ticket = await sign(env.TICKET_SECRET, { k: 'g', r: inv.r, u: uid, n: name, un: '', a: null, g: 0, nv: 1, hn: inv.hn }, 600);
      return json({ ticket });
    }

    // ---------------------------------------------------------------- host sign-in (desktop app loopback + PKCE)
    if (p === '/oauth/exchange' && req.method === 'POST') {
      if (limited(ip, 'oauth', 10)) return json({ error: 'slow down' }, 429);
      const b = (await req.json().catch(() => ({}))) as { code?: string; redirect_uri?: string; code_verifier?: string };
      if (!b.code || !b.redirect_uri || !localRedirects(env).has(b.redirect_uri)) return json({ error: 'bad request' }, 400);
      if (!discordReady(env)) return json({ error: 'not-set-up', hint: DISCORD_MISSING }, 503);
      const token = await exchangeCode(env, String(b.code).slice(0, 200), b.redirect_uri, typeof b.code_verifier === 'string' ? b.code_verifier.slice(0, 128) : undefined);
      const user = await me(env, token);
      if (!(await isHost(env, dir, user.id))) return notHost(env, dir, user);
      const ttl = 7 * 86400;
      const session = await sign(env.TICKET_SECRET, { k: 'hs', u: user.id, n: user.name, un: user.username, a: user.avatar }, ttl);
      return json({ user, session, exp: Date.now() + ttl * 1000 });
    }

    // ---------------------------------------------------------------- host API
    if (p.startsWith('/api/')) {
      if (limited(ip, 'api', 60)) return json({ error: 'slow down' }, 429);
      const hs = await hostSession(env, dir, req);
      if (!hs) return json({ error: 'sign in to host (or your id is not in HOST_USER_IDS)' }, 401);
      if (p === '/api/channels' && req.method === 'GET') return json({ guilds: await botGuildChannels(env), bot: !!env.DISCORD_BOT_TOKEN });
      if (p === '/api/rooms' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const roomId = randomId(16);
        const ttlH = Math.min(24, Math.max(1, Number(env.ROOM_TTL_H) || 12));
        const cfg: RoomConfig = {
          roomId, hostUid: String(hs.u), hostName: shownHostName(env, hs.n), hostAvatar: env.PUBLIC_NAME?.trim() ? null : hs.a ?? null,
          guildId: typeof b.guildId === 'string' && SNOW.test(b.guildId) ? b.guildId : null,
          roleIds: (Array.isArray(b.roleIds) ? b.roleIds : []).map(String).filter((x) => SNOW.test(x)).slice(0, 10),
          channelId: typeof b.channelId === 'string' && SNOW.test(b.channelId) ? b.channelId : null,
          bans: (Array.isArray(b.bans) ? b.bans : []).map(String).filter((x) => SNOW.test(x)).slice(0, 500),
          joinUrl: `${origin}/j/${roomId}`, createdAt: Date.now(), expiresAt: Date.now() + ttlH * 3600_000,
        };
        const r = await dir.room(roomId).fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify(cfg) }));
        if (!r.ok) return json({ error: 'could not create room' }, 500);
        const { posted } = (await r.json()) as { posted: boolean };
        const ticket = await sign(env.TICKET_SECRET, { k: 'h', r: roomId, u: hs.u, n: hs.n, un: hs.un, a: hs.a }, 600);
        return json({ roomId, ticket, joinUrl: cfg.joinUrl, expiresAt: cfg.expiresAt, posted });
      }
      const rm = /^\/api\/rooms\/([a-z0-9]{16,40})\/(ticket|end|guestlink)$/.exec(p);
      if (rm && req.method === 'POST') {
        const info = await roomInfo(dir, rm[1]);
        if (!info.alive) return json({ error: 'room ended' }, 410);
        if (info.hostUid !== hs.u) return json({ error: 'not your room' }, 403);
        if (rm[2] === 'end') { await dir.room(rm[1]).fetch(new Request('https://room/end', { method: 'POST' })); return json({ ok: true }); }
        if (rm[2] === 'guestlink') {
          // guestlink: the no-sign-in interview link. A new one revokes the old; {revoke:true} just revokes.
          const b = (await req.json().catch(() => ({}))) as { max?: unknown; minutes?: unknown; hours?: unknown; revoke?: unknown };
          if (b.revoke === true) { await dir.room(rm[1]).fetch(new Request('https://room/invite/revoke', { method: 'POST' })); return json({ ok: true }); }
          const max = Math.max(1, Math.min(20, Math.floor(Number(b.max) || 3)));
          // invite-experience: every link expires — 5-60 min (default 30), rejected above an hour; legacy `hours` from
          // older studios is clamped into that range (inviteExpiry.ts). The room's own end can only make it shorter.
          const life = inviteMinutes(b);
          if ('error' in life) return json({ error: life.error, maxMinutes: INVITE_MAX_MINUTES }, 400);
          const exp = Math.min(info.expiresAt ?? Date.now() + 12 * 3600_000, Date.now() + life.minutes * 60_000);
          const r = await dir.room(rm[1]).fetch(new Request('https://room/invite', { method: 'POST', body: JSON.stringify({ max, exp }) }));
          const { gen } = (await r.json()) as { gen: string };
          const token = await sign(env.TICKET_SECRET, { k: 'gi', r: rm[1], gen, m: max, hn: shownHostName(env, hs.n) }, Math.max(60, Math.floor((exp - Date.now()) / 1000)));
          return json({ url: `${origin}/g/${token}`, discordUrl: `${origin}/j/${rm[1]}?as=tv`, expiresAt: exp, max, minutes: life.minutes });
        }
        return json({ ticket: await sign(env.TICKET_SECRET, { k: 'h', r: rm[1], u: hs.u, n: hs.n, un: hs.un, a: hs.a }, 600) });
      }
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    // never echo internals (could include upstream bodies)
    return json({ error: 'relay error', detail: String((e as Error)?.message ?? e).slice(0, 80) }, 502);
  }
}

/** The room object's own (internal) HTTP surface — reachable only through handle() above. */
export async function roomHttp(core: import('./room.ts').RoomCore, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/init' && req.method === 'POST') {
    try { return json(await core.init((await req.json()) as RoomConfig)); } catch { return json({ error: 'exists' }, 409); }
  }
  if (url.pathname === '/info') return json(core.info(url.searchParams.get('uid')));
  if (url.pathname === '/invite' && req.method === 'POST') { const b = (await req.json()) as { max: number; exp: number }; return json({ gen: core.newInvite(b.max, b.exp) }); }
  if (url.pathname === '/invite/use' && req.method === 'POST') { const b = (await req.json()) as { gen: string; gk: string }; return json({ r: core.useInvite(String(b.gen), String(b.gk)) }); }
  if (url.pathname === '/invite/live') return json({ ok: core.inviteLive(String(url.searchParams.get('gen') ?? '')) });
  if (url.pathname === '/invite/revoke' && req.method === 'POST') { core.revokeInvite(); return json({ ok: true }); }
  if (url.pathname === '/owner') return json({ owner: await core.owner() });
  if (url.pathname === '/claim' && req.method === 'POST') { const b = (await req.json()) as { id: string; name: string; codeHash: string; claimHash: string }; return json({ r: await core.claim(String(b.id), String(b.name ?? ''), String(b.codeHash), String(b.claimHash)) }); }
  if (url.pathname === '/end' && req.method === 'POST') { await core.end('host ended the party'); return json({ ok: true }); }
  return json({ error: 'not found' }, 404);
}

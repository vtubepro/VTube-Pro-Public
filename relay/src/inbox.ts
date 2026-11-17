// The webhook inbox (beta.13, research A13): a dumb, per-streamer, secret-address store-and-forward box, so services
// that can only PUSH (Ko-fi, Throne, Kick) or push faster than polling (Fourthwall, Patreon, Stripe, Buy Me a Coffee)
// reach a helper behind a home router - even while it is switched off.
//
//   POST /inbox/new                          → { inboxId, pullKey, secret }   (a helper makes its inbox once)
//   POST /in/<inboxId>/<service>/<secret>    a service delivers: kept (raw body + signature headers, 7 days), 200 at once
//   GET  /inbox/<inboxId>/ws                 the helper's socket (Authorization: Bearer <pullKey>): every delivery not
//                                            yet acknowledged, in order; {t:'ack',seq} removes one. Hibernates.
//   POST /inbox/<inboxId>/config             { throne:{creator}, kick:{broadcaster} }  what may be checked at the edge
//   POST /inbox/<inboxId>/rotate             → { secret }  new address secret (old addresses stop working)
//   DELETE /inbox/<inboxId>                  remove the inbox and everything in it
//   POST /kick                               Kick's ONE app-wide webhook address: verified (Kick's RSA key), routed to the
//                                            inbox that registered that broadcaster id
//
// What the relay never has: a service's signing secret. HMAC services (Fourthwall, Stripe, BMC, Patreon) and the Ko-fi
// token are checked on the streamer's PC, so the relay can't forge an event. Throne (Ed25519) and Kick (RSA) use public
// keys, so they are ALSO checked here, and a Throne gift must name the creator who owns the inbox (no replays into
// someone else's inbox). Stored: each delivery ENCRYPTED to the helper's public key (made on the PC, sent with
// /inbox/new), until acknowledged or ~7 days. The relay sees a delivery in memory only while it arrives. Nothing is logged.
import type { Env } from './env.ts';
import { randomId } from './tickets.ts';

export const INBOX_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_BODY = 64 * 1024;
export const MAX_ITEMS = 2000;
/** Of MAX_ITEMS, the last slots only for deliveries whose signature the relay checked itself (Throne, Kick). */
export const RESERVED = 200;
const IDLE_DELETE_MS = 180 * 24 * 3600 * 1000;
const SERVICES = new Set(['fourthwall', 'throne', 'stripe', 'bmc', 'patreon', 'kofi', 'kick', 'streamelements', 'streamlabs', 'custom']);
/** Headers a delivery keeps (signatures, their timestamps, the content type). Nothing else (no IPs, no cookies). */
const KEEP_HEADERS = ['content-type', 'x-fourthwall-hmac-sha256', 'x-fourthwall-hmac-apps-sha256', 'stripe-signature', 'x-signature-sha256', 'x-patreon-signature', 'x-patreon-event',
  'x-signature-timestamp', 'x-signature-ed25519', 'kick-event-signature', 'kick-event-message-id', 'kick-event-message-timestamp', 'kick-event-type', 'kick-event-version', 'kick-event-subscription-id'];
const INBOX_ID = /^[a-z0-9]{24}$/;
const SECRET = /^[A-Za-z0-9_-]{20,64}$/;

/** Throne's published webhook key (help.throne.com); the env var replaces it for tests only. */
export const THRONE_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPXbUfxh7XL4SYUVcfhmYMIbxvtR9E9LDd8gPJ1PwSD8=\n-----END PUBLIC KEY-----';
const KICK_KEY_URL = 'https://api.kick.com/public/v1/public-key';

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...SEC } });
const enc = new TextEncoder();

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randKey = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const pemDer = (pem: string) => Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
/** Constant-time string compare (hashes of equal length). */
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };

// ---------------------------------------------------------------- edge checks for public-key services
export async function verifyThroneEdge(body: Uint8Array, ts: string | null, sigHex: string | null, nowMs: number, pem = THRONE_PUBLIC_KEY_PEM): Promise<boolean> {
  if (!ts || !/^\d{9,11}$/.test(ts) || !sigHex || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > 600) return false;
  try {
    const key = await crypto.subtle.importKey('spki', pemDer(pem), { name: 'Ed25519' } as unknown as AlgorithmIdentifier, false, ['verify']);
    const msg = new Uint8Array(ts.length + 1 + body.length);
    msg.set(enc.encode(`${ts}.`), 0); msg.set(body, ts.length + 1);
    return await crypto.subtle.verify({ name: 'Ed25519' } as unknown as AlgorithmIdentifier, key, hexBytes(sigHex), msg);
  } catch { return false; }
}
let kickKey: { pem: string; at: number } | null = null;
async function kickPem(env: Env): Promise<string> {
  if (env.KICK_PUBLIC_KEY) return env.KICK_PUBLIC_KEY;
  if (kickKey && Date.now() - kickKey.at < 6 * 3600_000) return kickKey.pem;
  const r = await fetch(KICK_KEY_URL);
  const j = (await r.json()) as { data?: { public_key?: string } };
  const pem = String(j.data?.public_key ?? '');
  if (pem) kickKey = { pem, at: Date.now() };
  return pem;
}
export async function verifyKickEdge(body: Uint8Array, h: Headers, pem: string): Promise<boolean> {
  const id = h.get('kick-event-message-id'), ts = h.get('kick-event-message-timestamp'), sig = h.get('kick-event-signature');
  if (!id || !ts || !sig || !pem) return false;
  try {
    const key = await crypto.subtle.importKey('spki', pemDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const head = enc.encode(`${id}.${ts}.`);
    const msg = new Uint8Array(head.length + body.length); msg.set(head, 0); msg.set(body, head.length);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), msg);
  } catch { return false; }
}

// ---------------------------------------------------------------- encryption to the helper (stored bodies)
const pubs = new Map<string, CryptoKey>();
async function importPub(spkiB64: string): Promise<CryptoKey | null> {
  const hit = pubs.get(spkiB64);
  if (hit) return hit;
  try {
    const k = await crypto.subtle.importKey('spki', Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0)), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    if (pubs.size > 200) pubs.clear();
    pubs.set(spkiB64, k);
    return k;
  } catch { return null; }
}
/** AES-256-GCM with a fresh key, the key wrapped with RSA-OAEP-SHA256 (only the helper's private key opens it). */
export async function seal(pub: CryptoKey, text: string): Promise<{ k: string; iv: string; c: string }> {
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(text)));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', aes) as ArrayBuffer);
  const k = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw));
  return { k: b64(k), iv: b64(iv), c: b64(c) };
}

// ---------------------------------------------------------------- per-isolate rate limits (best effort)
const buckets = new Map<string, { n: number; t: number }>();
function limited(key: string, perMin: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { n: perMin, t: now };
  b.n = Math.min(perMin, b.n + ((now - b.t) / 60000) * perMin); b.t = now;
  // bounded: the OLDEST key goes (Map order = last use), never every limit at once
  buckets.delete(key);
  if (buckets.size >= 5000) { const oldest = buckets.keys().next().value; if (oldest !== undefined) buckets.delete(oldest); }
  buckets.set(key, b);
  if (b.n < 1) return true;
  b.n -= 1;
  return false;
}

async function readCapped(req: Request): Promise<Uint8Array | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.length > MAX_BODY ? null : buf;
}

/** The Worker's inbox routes; null = not an inbox path (the rest of the relay answers). */
export async function inboxHandle(req: Request, env: Env, ip: string): Promise<Response | null> {
  const url = new URL(req.url), p = url.pathname;
  if (!p.startsWith('/in/') && !p.startsWith('/inbox/') && p !== '/kick') return null;
  if (!env.INBOXES) return json({ error: 'This relay has no webhook inbox' }, 404);
  const box = (id: string) => env.INBOXES!.get(env.INBOXES!.idFromName(`inbox:${id}`));

  if (p === '/inbox/new' && req.method === 'POST') {
    if (limited(`new:${ip}`, 6)) return json({ error: 'slow down' }, 429);
    // the helper's public key (RSA-OAEP, SPKI base64): every delivery is stored encrypted to it
    let pub = '';
    try { pub = String(((await req.json()) as { pub?: unknown }).pub ?? ''); } catch { /* */ }
    if (!/^[A-Za-z0-9+/=]{200,1200}$/.test(pub) || !(await importPub(pub))) return json({ error: 'a helper public key is required' }, 400);
    const inboxId = randomId(18), pullKey = randKey(32), secret = randKey(16); // 24 characters
    const r = await box(inboxId).fetch(new Request('https://inbox/init', { method: 'POST', body: JSON.stringify({ id: inboxId, pull: await sha256hex(pullKey), sec: await sha256hex(secret), pub }) }));
    if (!r.ok) return json({ error: 'could not make the inbox' }, 500);
    return json({ inboxId, pullKey, secret });
  }

  // a service delivers
  const d = /^\/in\/([a-z0-9]{24})\/([a-z]{2,20})\/([A-Za-z0-9_-]{20,64})\/?$/.exec(p);
  if (d) {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const [, id, svc, secret] = d;
    if (!SERVICES.has(svc)) return json({ error: 'unknown service' }, 404);
    if (limited(`in:${id}`, 240) || limited(`inip:${ip}`, 600)) return json({ error: 'slow down' }, 429);
    const body = await readCapped(req);
    if (!body) return json({ error: 'too big' }, 413);
    let throneCreator = '';
    if (svc === 'throne') {
      if (!(await verifyThroneEdge(body, req.headers.get('x-signature-timestamp'), req.headers.get('x-signature-ed25519'), Date.now(), env.THRONE_PUBLIC_KEY || THRONE_PUBLIC_KEY_PEM))) return json({ error: 'bad signature' }, 401);
      try { const j = JSON.parse(new TextDecoder().decode(body)) as { data?: { creator_id?: string; creator_username?: string } }; throneCreator = `${j.data?.creator_id ?? ''}\n${j.data?.creator_username ?? ''}`; } catch { return json({ error: 'bad body' }, 400); }
    }
    const h: Record<string, string> = {};
    for (const k of KEEP_HEADERS) { const v = req.headers.get(k); if (v) h[k] = v.slice(0, 600); }
    const r = await box(id).fetch(new Request('https://inbox/put', { method: 'POST', body: JSON.stringify({ sec: secret, p: svc, h, b: b64(body), throne: throneCreator, verified: svc === 'throne' }) }));
    // stored → 200 at once (Ko-fi / BMC / Kick disable a hook that fails); a full inbox → 429 so the service retries
    // (never a 200 for a body that wasn't stored); a wrong address → 404
    if (r.ok) return json({ ok: true });
    if (r.status === 429) return json({ error: 'inbox full, try again later' }, 429);
    return json({ error: 'no such inbox' }, r.status === 403 ? 403 : 404);
  }

  // Kick: the app's single address → the inbox that registered this broadcaster
  if (p === '/kick' && req.method === 'POST') {
    const body = await readCapped(req);
    if (!body) return json({ error: 'too big' }, 413);
    if (!(await verifyKickEdge(body, req.headers, await kickPem(env).catch(() => '')))) return json({ error: 'bad signature' }, 401);
    let bid = '';
    try { const j = JSON.parse(new TextDecoder().decode(body)) as { broadcaster?: { user_id?: number | string } }; bid = String(j.broadcaster?.user_id ?? ''); } catch { /* */ }
    if (!/^\d{1,20}$/.test(bid)) return json({ ok: true }); // nothing to route: ack anyway (Kick unsubscribes failing hooks)
    const route = await env.INBOXES.get(env.INBOXES.idFromName('kick-router')).fetch(new Request(`https://inbox/kick-route?b=${bid}`));
    const to = route.ok ? ((await route.json()) as { inbox?: string }).inbox ?? '' : '';
    if (INBOX_ID.test(to)) {
      const h: Record<string, string> = {};
      for (const k of KEEP_HEADERS) { const v = req.headers.get(k); if (v) h[k] = v.slice(0, 600); }
      const k = await box(to).fetch(new Request('https://inbox/kput', { method: 'POST', body: JSON.stringify({ p: 'kick', h, b: b64(body), verified: true }) }));
      if (k.status === 429) return json({ error: 'inbox full, try again later' }, 429);
    }
    return json({ ok: true });
  }

  // the helper's own calls
  const m = /^\/inbox\/([a-z0-9]{24})(\/ws|\/config|\/rotate)?$/.exec(p);
  if (m) {
    const id = m[1], what = m[2] ?? '';
    if (limited(`own:${ip}`, 120)) return json({ error: 'slow down' }, 429);
    if (what === '/ws' && req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket only' }, 426);
    const inner = new Request(`https://inbox/${what ? what.slice(1) : 'delete'}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? await req.text() : undefined });
    if (!what && req.method !== 'DELETE') return json({ error: 'DELETE only' }, 405);
    return box(id).fetch(inner);
  }
  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------- the Durable Object: one per inbox (+ the Kick router)
interface Meta { id: string; pull: string; sec: string; pub: string; created: number; seq: number; seen: number; cfg: { throne: string; kick: string } }
/** A stored delivery: `x` = the headers + body, AES-256-GCM encrypted with a one-time key that is itself encrypted to the
 *  helper's RSA-OAEP public key. The relay keeps no readable copy. */
interface Item { seq: number; p: string; at: number; x: { k: string; iv: string; c: string } }
const pad = (n: number) => String(n).padStart(12, '0');

export class Inbox {
  constructor(private state: DurableObjectState, private env: Env) {
    // the helper's keep-alive is answered by Cloudflare itself: a quiet inbox stays asleep
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private async meta(): Promise<Meta | null> { return (await this.state.storage.get<Meta>('meta')) ?? null; }
  private async authed(req: Request, meta: Meta | null): Promise<boolean> {
    const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    return !!meta && !!tok && same(await sha256hex(tok), meta.pull);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), what = url.pathname.slice(1);
    const st = this.state.storage;
    if (what === 'kick-route') { const b = url.searchParams.get('b') ?? ''; return json({ inbox: (await st.get<string>(`k:${b}`)) ?? '' }); }
    if (what === 'kick-set') { const j = (await req.json()) as { b?: string; inbox?: string; old?: string }; if (j.old) await st.delete(`k:${j.old}`); if (j.b && j.inbox) await st.put(`k:${j.b}`, j.inbox); return json({ ok: true }); }
    if (what === 'init') {
      if (await this.meta()) return json({ error: 'exists' }, 409);
      const j = (await req.json()) as { id: string; pull: string; sec: string; pub: string };
      await st.put('meta', { id: j.id, pull: j.pull, sec: j.sec, pub: j.pub, created: Date.now(), seq: 0, seen: Date.now(), cfg: { throne: '', kick: '' } } satisfies Meta);
      await st.setAlarm(Date.now() + 6 * 3600_000);
      return json({ ok: true });
    }
    const meta = await this.meta();
    if (!meta) return json({ error: 'no such inbox' }, 404);
    if (what === 'put' || what === 'kput') {
      const j = (await req.json()) as { sec?: string; p: string; h: Record<string, string>; b: string; throne?: string; verified?: boolean };
      if (what === 'put' && !same(await sha256hex(String(j.sec ?? '')), meta.sec)) return json({ error: 'no such inbox' }, 404);
      if (j.p === 'throne' && meta.cfg.throne) {
        const names = String(j.throne ?? '').toLowerCase().split('\n');
        if (!names.includes(meta.cfg.throne.toLowerCase())) return json({ error: 'not for this creator' }, 403);
      }
      // full → 429 (the service retries later). The last RESERVED slots only take edge-verified deliveries (Throne,
      // Kick), so a flood of junk from a leaked address can't crowd out a real signed gift
      const max = Math.max(2, Math.min(MAX_ITEMS, Number(this.env.INBOX_MAX) || MAX_ITEMS)), reserve = Math.min(RESERVED, Math.max(1, Math.floor(max / 10)));
      const count = (await st.list({ prefix: 'm:', limit: max + 1 })).size;
      if (count >= max || (!j.verified && count >= max - reserve)) return json({ error: 'full' }, 429);
      const key = await importPub(meta.pub);
      if (!key) return json({ error: 'no key' }, 500);
      meta.seq += 1;
      const item: Item = { seq: meta.seq, p: j.p, at: Date.now(), x: await seal(key, JSON.stringify({ h: j.h ?? {}, b: j.b })) };
      await st.put({ meta, [`m:${pad(item.seq)}`]: item });
      const out = JSON.stringify({ t: 'item', ...item });
      for (const ws of this.state.getWebSockets('helper')) { try { ws.send(out); } catch { /* gone */ } }
      return json({ ok: true });
    }
    if (!(await this.authed(req, meta))) return json({ error: 'not allowed' }, 401);
    if (what === 'ws') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // one helper at a time: a new connection replaces the old one
      for (const old of this.state.getWebSockets('helper')) { try { old.close(4000, 'replaced'); } catch { /* */ } }
      this.state.acceptWebSocket(server, ['helper']);
      meta.seen = Date.now();
      await st.put('meta', meta);
      const items = await st.list<Item>({ prefix: 'm:', limit: MAX_ITEMS });
      for (const it of items.values()) { try { server.send(JSON.stringify({ t: 'item', ...it })); } catch { break; } }
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    if (what === 'config') {
      const j = (await req.json().catch(() => ({}))) as { throne?: { creator?: string }; kick?: { broadcaster?: string } };
      if (j.throne) meta.cfg.throne = String(j.throne.creator ?? '').replace(/[^\w.\-]/g, '').slice(0, 80);
      if (j.kick) {
        const b = String(j.kick.broadcaster ?? '').replace(/\D/g, '').slice(0, 20);
        await this.env.INBOXES!.get(this.env.INBOXES!.idFromName('kick-router')).fetch(new Request('https://inbox/kick-set', { method: 'POST', body: JSON.stringify({ b, inbox: b ? meta.id : '', old: meta.cfg.kick }) }));
        meta.cfg.kick = b;
      }
      await st.put('meta', meta);
      return json({ ok: true, cfg: meta.cfg });
    }
    if (what === 'rotate') {
      const secret = randKey(16);
      meta.sec = await sha256hex(secret);
      await st.put('meta', meta);
      return json({ secret });
    }
    if (what === 'delete' && req.method === 'DELETE') {
      if (meta.cfg.kick) await this.env.INBOXES!.get(this.env.INBOXES!.idFromName('kick-router')).fetch(new Request('https://inbox/kick-set', { method: 'POST', body: JSON.stringify({ old: meta.cfg.kick }) }));
      for (const ws of this.state.getWebSockets('helper')) { try { ws.close(4004, 'deleted'); } catch { /* */ } }
      await st.deleteAll();
      await st.deleteAlarm();
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 200) return;
    let m: { t?: string; seq?: number };
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === 'ack' && typeof m.seq === 'number' && m.seq > 0) await this.state.storage.delete(`m:${pad(Math.floor(m.seq))}`);
    void ws;
  }
  async webSocketClose(ws: CfWebSocket, code: number, reason: string) { try { ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); } catch { /* closed */ } }
  async webSocketError() { /* VTube Pro reconnects */ }

  /** Every 6 hours: drop deliveries older than 7 days; an inbox nobody fetched from for 180 days removes itself. */
  async alarm() {
    const st = this.state.storage;
    const meta = await this.meta();
    if (!meta) { await st.deleteAll(); return; }
    const old: string[] = [];
    for (const [k, it] of await st.list<Item>({ prefix: 'm:', limit: MAX_ITEMS })) if (Date.now() - it.at > INBOX_TTL_MS) old.push(k);
    for (let i = 0; i < old.length; i += 128) await st.delete(old.slice(i, i + 128));
    if (Date.now() - meta.seen > IDLE_DELETE_MS && !this.state.getWebSockets('helper').length) { await st.deleteAll(); return; }
    await st.setAlarm(Date.now() + 6 * 3600_000);
  }
}

// "Claim your relay": nobody has to look up their Discord user id. The setup script makes a one-time claim code, shows
// it in big letters and stores only its hash as the HOST_CLAIM secret. The first person who signs in with Discord and
// types that code in VTube Pro becomes the host; the relay remembers that ONE Discord id in Durable Object storage
// (the host box, `host-signin`). HOST_USER_IDS stays as an advanced override (those ids are always hosts too).
//
// Why Durable Object storage: it is a single small value, survives restarts and redeploys, needs no second deploy and
// no write-back from the setup script (which would have to learn the id somehow). A room object only keeps its own
// record while the room runs (hibernation, relay/HIBERNATION.md).
// Making a new claim code (setup again) hands the relay to whoever types the NEW code first: the stored owner is bound
// to the claim hash it was made with, so the old owner stops being host once the secret changes.
import { hostIds, type Env } from './env.ts';
import type { RoomDir } from './app.ts';
import { sign, verify } from './tickets.ts';

/** The Durable Object that holds the claimed owner (not a room). */
export const HOST_BOX = 'host-signin';
export interface Owner { id: string; name: string; claimHash: string; at: number }
export type ClaimResult = 'ok' | 'wrong' | 'used' | 'off' | 'locked';

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
/** Codes are typed by people: case, spaces and dashes don't matter. */
export const normalizeClaim = (code: unknown) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
/** What the setup script stores as HOST_CLAIM: hex SHA-256 of "vtp-claim-v1|" + the normalized code. */
export async function claimHash(code: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', te.encode(`vtp-claim-v1|${normalizeClaim(code)}`))); }
const envClaim = (env: Env) => { const h = String(env.HOST_CLAIM ?? '').trim().toLowerCase(); return /^[0-9a-f]{64}$/.test(h) ? h : ''; };

async function box<T>(dir: RoomDir, path: string, body?: unknown): Promise<T> {
  const r = await dir.room(HOST_BOX).fetch(new Request(`https://room${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
  return (await r.json()) as T;
}
async function owner(env: Env, dir: RoomDir): Promise<Owner | null> {
  const h = envClaim(env);
  if (!h) return null;
  const o = (await box<{ owner: Owner | null }>(dir, '/owner')).owner;
  return o && o.claimHash === h ? o : null;
}

/** 'off' = no claim code set; 'open' = waiting for the first host; 'claimed'. */
export async function claimState(env: Env, dir: RoomDir): Promise<'off' | 'open' | 'claimed'> {
  if (!envClaim(env)) return 'off';
  return (await owner(env, dir)) ? 'claimed' : 'open';
}

/** May this Discord user host? HOST_USER_IDS, or the one who claimed the relay with the current claim code. */
export async function isHost(env: Env, dir: RoomDir, id: string): Promise<boolean> {
  if (hostIds(env).has(id)) return true;
  return (await owner(env, dir))?.id === id;
}

type User = { id: string; name: string; username: string; avatar: string | null };
/** Not a host: either "type your claim code" (with a 10-min claim ticket for POST /claim) or a plain refusal. */
export async function notHost(env: Env, dir: RoomDir, user: User): Promise<Response> {
  const st = await claimState(env, dir);
  if (st === 'open') {
    const claim = await sign(env.TICKET_SECRET, { k: 'cl', u: user.id, n: user.name, un: user.username, a: user.avatar }, 600);
    return json({ error: 'claim-needed', user, claim, hint: 'Almost done: type the claim code from the relay setup window in VTube Pro.' }, 403);
  }
  return json({ error: 'not-a-host', user, hint: st === 'claimed'
    ? 'This relay already has its host. To take it over, run the relay setup again and make a new claim code.'
    : 'This relay has no host yet. Run the relay setup again: it shows a claim code.' }, 403);
}

/** POST /claim {claim, code} → the host session (same answer as /oauth/exchange). */
export async function claimRelay(env: Env, dir: RoomDir, b: { claim?: unknown; code?: unknown }): Promise<Response> {
  const t = await verify(env.TICKET_SECRET, b.claim, 'cl');
  if (!t?.u) return json({ error: 'expired', hint: 'That took too long. Click Connect Discord again.' }, 400);
  const code = normalizeClaim(b.code);
  if (code.length < 4) return json({ error: 'wrong', hint: 'Type the claim code from the relay setup window.' }, 400);
  const h = envClaim(env);
  const r = h ? (await box<{ r: ClaimResult }>(dir, '/claim', { id: t.u, name: t.n, codeHash: await claimHash(code), claimHash: h })).r : 'off';
  if (r === 'wrong') return json({ error: 'wrong', hint: 'That code doesn’t match. Check the setup window (dashes and capitals don’t matter).' }, 403);
  if (r === 'locked') return json({ error: 'locked', hint: 'Too many wrong codes. Wait an hour, or run the relay setup again for a new code.' }, 429);
  if (r === 'used') return json({ error: 'used', hint: 'This relay already has its host. To take it over, run the relay setup again and make a new claim code.' }, 409);
  if (r !== 'ok') return json({ error: 'off', hint: 'This relay has no claim code. Run the relay setup again.' }, 404);
  const user = { id: t.u, name: String(t.n ?? ''), username: String(t.un ?? ''), avatar: t.a ?? null };
  const ttl = 7 * 86400;
  const session = await sign(env.TICKET_SECRET, { k: 'hs', u: user.id, n: user.name, un: user.username, a: user.avatar }, ttl);
  return json({ user, session, exp: Date.now() + ttl * 1000, claimed: true });
}

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...SEC } });

// Signed, short-lived tokens (HMAC-SHA256 over a small JSON payload, base64url). WebCrypto only, so the same
// code runs in the Worker and in the Node mock (tools/mock_relay.ts).
//   'h' host ticket  / 'g' guest ticket : join ONE room once, ≤ 10 min
//   'hs' host session                   : a signed-in host may create rooms (≤ 7 days)
//   'st' OAuth state                    : binds the Discord redirect to the room + a browser cookie (≤ 10 min)
//   'cl' claim ticket                   : a signed-in Discord user may type the relay's claim code (≤ 10 min)
//   'gi' guest-invite link              : no-sign-in interview link for ONE room (≤ 12 h, max distinct guests); revoked
//                                         when the party ends or the host makes a new one (the room keeps the generation)
const te = new TextEncoder();
const td = new TextDecoder();

export const b64u = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = (s: string) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
export const randomId = (bytes = 16) => b64u(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[-_]/g, 'x').toLowerCase();

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('TICKET_SECRET must be set (≥ 32 chars)');
  let k = keys.get(secret);
  if (!k) { k = crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); keys.set(secret, k); }
  return k;
}

export interface TicketBody {
  k: 'h' | 'g' | 'hs' | 'st' | 'gi' | 'cl';
  /** room id */
  r?: string;
  /** Discord user id / display name / username / avatar hash */
  u?: string; n?: string; un?: string; a?: string | null;
  /** guest verified in the room's Discord server (and role, when required) */
  g?: 0 | 1;
  /** host display name (guest tickets, shown on the consent screen) */
  hn?: string;
  /** guest ticket from a no-sign-in invite link: the name is typed by the guest, NOT verified by Discord */
  nv?: 1;
  /** guest-invite link: max distinct guests (browsers) / invite generation / OAuth state: land on the browser page */
  m?: number; gen?: string; v?: 'tv';
  /** nonce (single use) */
  j: string;
  /** expiry, unix seconds */
  x: number;
}

export async function sign(secret: string, body: Omit<TicketBody, 'j' | 'x'> & { j?: string }, ttlSec: number): Promise<string> {
  const full: TicketBody = { ...body, j: body.j ?? randomId(12), x: Math.floor(Date.now() / 1000) + ttlSec } as TicketBody;
  const payload = b64u(te.encode(JSON.stringify(full)));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(payload)));
  return `${payload}.${b64u(mac)}`;
}

/** Verify signature, kind and expiry. Returns null on ANY problem (no oracle). */
export async function verify(secret: string, token: unknown, kind: TicketBody['k']): Promise<TicketBody | null> {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload, mac] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(mac), te.encode(payload));
    if (!ok) return null;
    const body = JSON.parse(td.decode(unb64u(payload))) as TicketBody;
    if (body.k !== kind || typeof body.x !== 'number' || body.x < Date.now() / 1000 || typeof body.j !== 'string') return null;
    return body;
  } catch { return null; }
}

/** PKCE (S256) pair derived from a secret nonce (so nothing has to be stored between redirect and callback). */
export async function pkce(secret: string, nonce: string): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(`pkce:${nonce}`)));
  const verifier = b64u(raw) + b64u(raw.slice(0, 16));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(verifier))));
  return { verifier, challenge };
}

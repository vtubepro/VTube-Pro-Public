// Short-lived TURN credentials, minted per participant when they connect to a room. TURN only ever forwards the
// peers' DTLS-encrypted WebRTC packets — it can't read tracking or models.
import type { Env } from './env.ts';

export interface IceServer { urls: string | string[]; username?: string; credential?: string }
const STUN: IceServer = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };

export async function iceServersFor(env: Env, uid: string): Promise<IceServer[]> {
  const ttl = Math.min(86400, Math.max(600, Number(env.TURN_TTL) || 14400));
  // Cloudflare Realtime TURN (Calls): https://developers.cloudflare.com/realtime/turn/
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const base = env.CF_TURN_API || 'https://rtc.live.cloudflare.com/v1/turn/keys';
      const r = await fetch(`${base}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl }),
      });
      if (r.ok) {
        const b = (await r.json()) as { iceServers?: IceServer | IceServer[] };
        const list = Array.isArray(b.iceServers) ? b.iceServers : b.iceServers ? [b.iceServers] : [];
        // Cloudflare: "The alternate port 53 is known to be blocked by web browsers" — drop those URLs (they only time out)
        const clean = list.filter((s) => s && s.urls)
          .map((s) => ({ urls: [s.urls].flat().filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u)), username: s.username, credential: s.credential }))
          .filter((s) => s.urls.length);
        if (clean.length) return [STUN, ...clean];
      }
    } catch { /* fall through */ }
  }
  // Any TURN server with the standard REST shared secret (coturn --use-auth-secret)
  if (env.TURN_URLS && env.TURN_SHARED_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${uid}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURN_SHARED_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)));
    let s = ''; for (const x of mac) s += String.fromCharCode(x);
    return [STUN, { urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter((u) => /^turns?:/.test(u)), username, credential: btoa(s) }];
  }
  return [STUN];
}

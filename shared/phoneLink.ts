// The link pieces the guest feed ("Be a guest on someone else's show", shared/guestFeed.ts) uses to meet through the
// streamer's OWN invite server (relay/src/phoneLink.ts passes the WebRTC handshake only): the link id and the relay address
// check. (The browser phone tracker that used to share this file needed a page hosted by the author's website and is gone.)

export const PHONE_LINK_ID_RX = /^[a-z0-9]{24,48}$/;
/** A fresh unguessable link id (≈ 155 bits). */
export function newPhoneLinkId(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(rand(30), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
/** The relay address a link may use: https (or a local mock on 127.0.0.1 / localhost). */
export function cleanRelay(o: unknown): string | null {
  if (typeof o !== 'string' || o.length > 200) return null;
  try {
    const u = new URL(o);
    if (u.username || u.password || u.pathname.replace(/\/$/, '') !== '' || u.search || u.hash) return null;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

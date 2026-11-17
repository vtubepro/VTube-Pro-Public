// Phone link: the guest feed (shared/guestFeed.ts, "Be a guest on someone else's show") meets the streamer's studio here.
// The relay only passes the WebRTC handshake (SDP + ICE) between sockets that know the same unguessable link id (from
// the studio's QR code): ONE "studio" and up to MAX_PHONES "phone" sockets, each phone page with its own random peer id.
// The face data itself goes peer-to-peer over a WebRTC data channel (or TURN, DTLS-encrypted), never through here; a
// phone closes its socket once connected (and when the studio tells it to stop).
//   GET /phone/<id>/ws?role=studio            GET /phone/<id>/ws?role=phone&peer=<page id>     (WebSocket)
//   → {t:'ready', ice:[…], peer:boolean}               on join (peer: the other side is already here)
//   → studio: {t:'peer', here:boolean, from}          a phone came / left
//   → phone:  {t:'peer', here:boolean}                the studio came / left
//   phone  → {t:'signal', data} / {t:'bye'}           → studio gets them with `from: <peer>`
//   studio → {t:'signal', to, data} / {t:'bye', to}   → only that phone (no `to`: every phone)
// No storage, no logging. A second STUDIO for the same id is refused ({t:"busy"}, 4409) while the first is connected. A
// phone socket needs a valid peer id (else 4400 'peer id'); it only ever replaces ITS OWN earlier socket (a reloaded page,
// no "phone left" for that one), never another phone's handshake; a phone socket that sends nothing for PHONE_IDLE_MS
// is closed (4408) so a forgotten tab can't keep one of the MAX_PHONES places. Platform-neutral core (PhoneLinks, used
// by the Node mock) + the pure rules the Durable Object uses too.

export const PHONE_LINK_ID = /^[a-z0-9]{24,48}$/;
export const PEER_ID = /^[a-z0-9]{8,32}$/;
export const MAX_PHONES = 4;
/** A phone socket with no signalling for this long is closed (it is not the connected phone: that one has left). */
export const PHONE_IDLE_MS = 2 * 60_000;
export type PhoneRole = 'studio' | 'phone';
export const otherRole = (r: PhoneRole): PhoneRole => (r === 'studio' ? 'phone' : 'studio');
export const parseRole = (v: string | null): PhoneRole | null => (v === 'studio' || v === 'phone' ? v : null);
/** A phone page's peer id, or null (refused: the phone page always sends one). */
export const parsePeer = (v: string | null): string | null => (v && PEER_ID.test(v) ? v : null);
const MAX = 16000, RATE = 80, WINDOW = 10_000;

/**
 * What a raw client message turns into. From a phone: forward to the studio, stamped `from: peer`. From the studio:
 * forward to the phone named by `to` (all phones when there is none), without the `to`.
 */
export function phoneRoute(raw: unknown, from: { role: 'phone'; peer: string } | { role: 'studio' }): { forward: string; to?: string } | null {
  if (typeof raw !== 'string' || raw.length > MAX) return null;
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const to = from.role === 'studio' && typeof m.to === 'string' && PEER_ID.test(m.to) ? m.to : undefined;
  const stamp = from.role === 'phone' ? { from: from.peer } : {};
  if (m.t === 'bye') return { forward: JSON.stringify({ t: 'bye', ...stamp }), to };
  if (m.t !== 'signal' || !m.data || typeof m.data !== 'object') return null;
  const d = m.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (d.sdp && typeof d.sdp === 'object') {
    const s = d.sdp as Record<string, unknown>;
    if ((s.type === 'offer' || s.type === 'answer') && typeof s.sdp === 'string') out.sdp = { type: s.type, sdp: s.sdp };
  }
  if ('candidate' in d) out.candidate = d.candidate && typeof d.candidate === 'object' ? d.candidate : null;
  if (!('sdp' in out) && !('candidate' in out)) return null;
  return { forward: JSON.stringify({ t: 'signal', ...stamp, data: out }), to };
}

/** Per-socket token bucket (memory only). */
export function rateOk(st: { n: number; t: number }, now = Date.now()): boolean {
  st.n = Math.min(RATE, st.n + ((now - st.t) / WINDOW) * RATE); st.t = now;
  if (st.n < 1) return false;
  st.n -= 1;
  return true;
}
/** Phone sockets (their last signalling time) that have been idle too long. */
export const idlePhones = <T>(phones: [T, number][], now: number): T[] => phones.filter(([, at]) => now - at > PHONE_IDLE_MS).map(([k]) => k);

export interface PhoneSock { send(s: string): void; close(code?: number, reason?: string): void }
interface Side { sock: PhoneSock; rate: { n: number; t: number }; at: number }
interface Link { studio?: Side; phones: Map<string, Side> }

/** In-memory links (the Node mock; the Durable Object keeps the same rules with socket tags + attachments). */
export class PhoneLinks {
  private links = new Map<string, Link>();
  constructor(private now: () => number = Date.now) {}
  /** Join `id` as `role` (a phone with its `peer` id); returns the socket's handlers. `ice` = this relay's ICE servers. */
  attach(id: string, role: PhoneRole, sock: PhoneSock, ice: unknown[], peer: string | null = null) {
    const none = { message: () => {}, close: () => {} };
    const refuse = (code: number, why: string) => { try { if (code === 4409) sock.send('{"t":"busy"}'); sock.close(code, why); } catch { /* gone */ } return none; };
    if (role === 'phone' && !peer) return refuse(4400, 'peer id');
    const link = this.links.get(id) ?? { phones: new Map<string, Side>() };
    this.links.set(id, link);
    this.sweep(link);
    // ONE studio per code: a second one is refused while the first is connected (it can't take the code over)
    if (role === 'studio' && link.studio) return refuse(4409, 'busy');
    if (role === 'phone') {
      const own = link.phones.get(peer!);
      if (own) { link.phones.delete(peer!); try { own.sock.close(4000, 'replaced'); } catch { /* gone */ } }   // its own reload only
      else if (link.phones.size >= MAX_PHONES) return refuse(4409, 'busy');
    }
    const me: Side = { sock, rate: { n: RATE, t: this.now() }, at: this.now() };
    if (role === 'studio') link.studio = me; else link.phones.set(peer!, me);
    sock.send(JSON.stringify({ t: 'ready', ice, peer: role === 'studio' ? link.phones.size > 0 : !!link.studio }));
    if (role === 'phone') link.studio?.sock.send(JSON.stringify({ t: 'peer', here: true, from: peer }));
    else for (const p of link.phones.values()) p.sock.send('{"t":"peer","here":true}');
    return {
      message: (raw: unknown) => {
        if (!rateOk(me.rate, this.now())) return;
        const r = phoneRoute(raw, role === 'phone' ? { role, peer: peer! } : { role });
        if (!r) return;
        me.at = this.now();
        if (role === 'phone') link.studio?.sock.send(r.forward);
        else if (r.to) link.phones.get(r.to)?.sock.send(r.forward);
        else for (const p of link.phones.values()) p.sock.send(r.forward);
      },
      close: () => {
        if (role === 'studio') {
          if (link.studio !== me) return;
          delete link.studio;
          for (const p of link.phones.values()) p.sock.send('{"t":"peer","here":false}');
        } else {
          if (link.phones.get(peer!) !== me) return;   // replaced / idled out: already gone, no "phone left"
          link.phones.delete(peer!);
          link.studio?.sock.send(JSON.stringify({ t: 'peer', here: false, from: peer }));
        }
        if (!link.studio && !link.phones.size) this.links.delete(id);
      },
    };
  }
  /** Close phone sockets idle for PHONE_IDLE_MS (also run on every join; a timer in the mock calls it too). */
  sweep(link?: Link) {
    const now = this.now();
    for (const l of link ? [link] : [...this.links.values()]) {
      for (const peer of idlePhones([...l.phones.entries()].map(([k, s]) => [k, s.at] as [string, number]), now)) {
        const s = l.phones.get(peer)!;
        l.phones.delete(peer);
        try { s.sock.close(4408, 'idle'); } catch { /* gone */ }
        l.studio?.sock.send(JSON.stringify({ t: 'peer', here: false, from: peer }));
      }
    }
  }
  get size() { return this.links.size; }
}

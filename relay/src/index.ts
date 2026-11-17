// Cloudflare Worker entry + the per-room Durable Object. Deploy: see relay/README.md (`npx wrangler deploy`).
// Rooms use the WebSocket Hibernation API (relay/HIBERNATION.md): an idle room is dropped from memory while its
// sockets stay open, so a quiet party bills no duration. While a room lives, its state is in its sockets'
// attachments, one storage record and one alarm (room.ts); the record and the alarm are deleted when it ends.
// The ONE lasting stored value is the claimed host's Discord id in the `host-signin` object (claim.ts).
// Logs are off in wrangler.toml and nothing here logs payloads.
import { handle, roomHttp } from './app.ts';
import type { Env } from './env.ts';
import { PING, PONG, RoomCore, type PeerState, type Sock } from './room.ts';
import { MAX_PHONES, idlePhones, parsePeer, parseRole, phoneRoute, rateOk, type PhoneRole } from './phoneLink.ts';
import { iceServersFor } from './turn.ts';
import { inboxHandle } from './inbox.ts';
export { Inbox } from './inbox.ts';

/** A phone-link socket's attachment (phoneLink.ts): its role (+ a phone page's peer id, its last signalling time; quiet =
 *  the relay itself closed it (replaced by the same page, or idle): no "phone left" for it). Never a party peer. */
type PlState = { pl: PhoneRole; peer?: string; at?: number; quiet?: true };
const isPl = (a: unknown): a is PlState => !!a && typeof a === 'object' && 'pl' in (a as object);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
    // the webhook inbox (inbox.ts): /in/…, /inbox/…, /kick
    const inbox = await inboxHandle(req, env, ip);
    if (inbox) return inbox;
    return handle(req, env, { room: (id) => env.ROOMS.get(env.ROOMS.idFromName(id)) }, ip);
  },
};

const sockOf = (ws: CfWebSocket): Sock => ({ send: (s) => ws.send(s), close: (c, r) => ws.close(c, r), keep: (st) => ws.serializeAttachment(st) });

export class Room {
  private core: RoomCore;
  /** phone-link sockets' rate buckets (phoneLink.ts rateOk) */
  private plRate = new WeakMap<CfWebSocket, { n: number; t: number }>();
  constructor(private state: DurableObjectState, private env: Env) {
    const st = state.storage;
    this.core = new RoomCore(env, undefined, st, { set: (at) => st.setAlarm(at), clear: () => st.deleteAlarm() });
    // the clients' keep-alive is answered by Cloudflare itself: it never wakes a sleeping room
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    // a (re)started object: the room's record first, then every socket that stayed open while it was away
    void state.blockConcurrencyWhile(async () => {
      await this.core.load();
      for (const ws of state.getWebSockets()) if ((ws.readyState === undefined || ws.readyState === 1) && !isPl(ws.deserializeAttachment())) this.core.restore(sockOf(ws), ws.deserializeAttachment() as PeerState | null);
    });
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // phone link (phoneLink.ts): two tagged sockets, no room state; hibernation-safe (the tags + attachments say it all)
    const role = /^\/phone\//.test(url.pathname) ? parseRole(url.searchParams.get('role')) : null;
    if (role) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const peer = role === 'phone' ? parsePeer(url.searchParams.get('peer')) : '';
      const refuse = (code: number, why: string) => { server.accept(); if (code === 4409) server.send('{"t":"busy"}'); server.close(code, why); return new Response(null, { status: 101, webSocket: client } as ResponseInit); };
      // a phone page always sends its own peer id (phoneLink.ts): none = refused with a reason
      if (role === 'phone' && !peer) return refuse(4400, 'peer id');
      this.sweepPhones();
      // ONE studio per code: a second one is refused while the first is connected (phoneLink.ts)
      if (role === 'studio' && this.state.getWebSockets('pl:studio').length) return refuse(4409, 'busy');
      if (role === 'phone') {
        // a phone only replaces ITS OWN earlier socket (a reloaded page), never another phone's handshake
        const own = this.state.getWebSockets(`pl:phone:${peer}`);
        if (own.length) for (const old of own) this.quietClose(old, 4000, 'replaced');
        else if (this.livePhones().length >= MAX_PHONES) return refuse(4409, 'busy');
      }
      this.state.acceptWebSocket(server, role === 'phone' ? ['pl:phone', `pl:phone:${peer}`] : ['pl:studio']);
      server.serializeAttachment({ pl: role, ...(role === 'phone' ? { peer: peer!, at: Date.now() } : {}) } satisfies PlState);
      const studios = this.state.getWebSockets('pl:studio'), phones = this.livePhones().filter((w) => w !== server);
      server.send(JSON.stringify({ t: 'ready', ice: await iceServersFor(this.env, `phone-${role}`), peer: role === 'studio' ? phones.length > 0 : studios.length > 0 }));
      if (role === 'phone') for (const o of studios) { try { o.send(JSON.stringify({ t: 'peer', here: true, from: peer })); } catch { /* gone */ } }
      else for (const o of phones) { try { o.send('{"t":"peer","here":true}'); } catch { /* gone */ } }
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    if (/\/ws$/.test(url.pathname)) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // hibernatable: the runtime holds the socket and calls webSocketMessage / webSocketClose below
      this.state.acceptWebSocket(server);
      this.core.attach(sockOf(server), req.headers.get('cf-connecting-ip') ?? '');
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    return roomHttp(this.core, req);
  }
  /** The room's handlers for this socket. A socket the woken object didn't get from getWebSockets() (the runtime may
   *  already have dropped a closing one) comes back from its attachment; one the room let go stays gone. */
  private peer(ws: CfWebSocket) {
    const st = ws.deserializeAttachment() as PeerState | null;
    return this.core.handle(st?.pid) ?? this.core.restore(sockOf(ws), st);
  }
  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer) {
    const a = ws.deserializeAttachment();
    if (isPl(a)) {
      // per-socket rate limit (memory only: a hibernated object comes back with full buckets, like the mock's)
      let b = this.plRate.get(ws); if (!b) { b = { n: 80, t: Date.now() }; this.plRate.set(ws, b); }
      if (!rateOk(b)) return;
      const r = phoneRoute(message, a.pl === 'phone' ? { role: 'phone', peer: a.peer ?? '' } : { role: 'studio' });
      if (r) {
        if (a.pl === 'phone') ws.serializeAttachment({ ...a, at: Date.now() } satisfies PlState);
        this.sweepPhones();
        const to = a.pl === 'phone' ? this.state.getWebSockets('pl:studio') : this.state.getWebSockets(r.to ? `pl:phone:${r.to}` : 'pl:phone');
        for (const o of to) { try { o.send(r.forward); } catch { /* gone */ } }
      }
      return;
    }
    await this.peer(ws)?.message(message);
  }
  async webSocketClose(ws: CfWebSocket, code: number, reason: string) {
    const a = ws.deserializeAttachment();
    if (isPl(a)) {
      // a socket the relay closed itself (replaced by the same page / idle) says nothing (the mock does the same)
      if (!a.quiet) {
        const msg = a.pl === 'phone' ? JSON.stringify({ t: 'peer', here: false, from: a.peer }) : '{"t":"peer","here":false}';
        for (const o of this.state.getWebSockets(a.pl === 'phone' ? 'pl:studio' : 'pl:phone')) { if (o !== ws) try { o.send(msg); } catch { /* gone */ } }
      }
      try { ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); } catch { /* already closed */ }
      return;
    }
    this.peer(ws)?.close();
    // finish the closing handshake (1005 / 1006 / 1015 can't be sent back)
    try { ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); } catch { /* already closed */ }
  }
  async webSocketError(ws: CfWebSocket) {
    if (isPl(ws.deserializeAttachment())) return;
    this.peer(ws)?.close();
  }
  async alarm() {
    await this.core.alarm();
  }
  /** Phone sockets the relay hasn't closed itself. */
  private livePhones() { return this.state.getWebSockets('pl:phone').filter((w) => { const a = w.deserializeAttachment(); return isPl(a) && !a.quiet; }); }
  private quietClose(ws: CfWebSocket, code: number, why: string) {
    const a = ws.deserializeAttachment();
    try { if (isPl(a)) ws.serializeAttachment({ ...a, quiet: true } satisfies PlState); ws.close(code, why); } catch { /* gone */ }
  }
  /** Close phone sockets with no signalling for PHONE_IDLE_MS (on every phone join and message: hibernation-safe). */
  private sweepPhones() {
    const list = this.livePhones().map((w) => { const a = w.deserializeAttachment() as PlState; return [w, a.at ?? 0] as [CfWebSocket, number]; });
    for (const w of idlePhones(list, Date.now())) {
      const peer = (w.deserializeAttachment() as PlState).peer;
      this.quietClose(w, 4408, 'idle');
      for (const o of this.state.getWebSockets('pl:studio')) { try { o.send(JSON.stringify({ t: 'peer', here: false, from: peer })); } catch { /* gone */ } }
    }
  }
}

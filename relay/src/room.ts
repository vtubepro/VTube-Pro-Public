// One party room = one Durable Object (in the Node mock: one object in a Map). Platform-neutral: it only needs a
// socket with send/close. It carries the WebRTC HANDSHAKE (SDP offers/answers + ICE candidates) between the host
// and approved guests — nothing else: tracking and avatars go peer-to-peer over DTLS, never through here.
// No payload logging. The room dies when the host leaves for 3 min, when it expires, or when the host ends it; the
// bot's invite message is then edited to "ended".
// Hibernation (relay/HIBERNATION.md): Cloudflare may drop an idle room object from memory while its sockets stay
// open (no duration billed). So everything a room must remember is kept where it survives that: per-socket state in
// the socket's attachment (Sock.keep), the room's own state in ONE storage record ('room', deleted when the room ends)
// and every deadline (expiry, host away, auth timeout, the bot edit) in ONE alarm (Alarm) — no in-memory timers.
// load() + restore() bring a woken object back exactly where it was.
import { editInvite, postInvite } from './discord.ts';
import type { Env } from './env.ts';
import { verify, type TicketBody } from './tickets.ts';
import type { ClaimResult, Owner } from './claim.ts';
import { iceServersFor } from './turn.ts';

/** Durable Object storage (or a Map in the Node mock). The host box keeps its owner here (claim.ts); a room keeps its
 *  'room' record here only while it is alive (hibernation). */
export interface KV { get<T = unknown>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<unknown> }
const memKV = (): KV => { const m = new Map<string, unknown>(); return { get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k) }; };
/** `keep`: store this socket's state with the socket itself (a hibernatable WebSocket's attachment, ≤ 2 KB). */
export interface Sock { send(s: string): void; close(code?: number, reason?: string): void; keep?(state: PeerState): void }
/** The room's single wake-up (a Durable Object alarm; a timer in the Node mock). set() replaces the previous one. */
export interface Alarm { set(at: number): unknown; clear(): unknown }
const timerAlarm = (fire: () => void): Alarm => {
  let t: ReturnType<typeof setTimeout> | null = null;
  return { set: (at) => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fire(); }, Math.max(0, at - Date.now())); }, clear: () => { if (t) clearTimeout(t); t = null; } };
};
/** Clients send exactly this keep-alive; the Worker answers it with PONG without waking the room (auto-response). */
export const PING = '{"t":"ping","n":0}', PONG = '{"t":"pong","n":0}';
export interface RoomConfig {
  roomId: string;
  hostUid: string; hostName: string; hostAvatar: string | null;
  guildId: string | null; roleIds: string[];
  channelId: string | null;
  bans: string[];
  joinUrl: string;
  createdAt: number; expiresAt: number;
}
/** What a socket remembers across hibernation (its attachment). No IP address, no ticket. */
export interface PeerState {
  pid: string;
  role: 'host' | 'guest' | null;
  user: { id: string; name: string; username: string; avatar: string | null } | null;
  guildOk: boolean;
  /** joined with a no-sign-in guest-invite link: the name is typed by the guest, not verified */
  link: boolean;
  approved: boolean;
  /** not signed in yet: dropped at this time (ms); 0 once authenticated */
  authBy: number;
  /** the room already let this socket go (dropped / closed): a late close event for it changes nothing */
  gone?: true;
}
interface Peer extends PeerState {
  sock: Sock; ip: string;
  /** rate limit (memory only: an object only hibernates after ≥ 10 s idle, when the bucket is full again anyway) */
  tokens: number; last: number;
}
/** The room's 'room' storage record (hibernation): everything else a woken room object needs. */
interface Saved {
  cfg: RoomConfig | null; msg: string | null; roster: string[] | null;
  away: { at: number; why: string } | null; rosterAt: number;
  knocks: number[]; used: [string, number][];
  invite: { gen: string; seen: string[]; max: number; exp: number } | null;
}

const MAX_SOCKETS = 24, MAX_GUESTS = 7, MAX_MSG = 20000;
const HOST_GRACE = 3 * 60_000, AUTH_TIME = 8000, ROSTER_DEBOUNCE = 4000;
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, n);

export class RoomCore {
  cfg: RoomConfig | null = null;
  ended = false;
  private peers = new Map<string, Peer>();
  private used = new Map<string, number>(); // ticket nonces (single use) → expiry
  private messageId: string | null = null;
  private rosterNames: string[] | null = null;
  /** deadlines (ms, 0 / null = none), all served by the one alarm: the bot's debounced roster edit, the host's grace */
  private rosterAt = 0;
  private away: { at: number; why: string } | null = null;
  private armed = 0;
  private knocks: number[] = [];
  /** The current no-sign-in guest-invite link (guestlink): generation, distinct guests (browser keys) seen, cap, expiry.
   *  A new link replaces it (old links stop working); it dies with the room. */
  private invite: { gen: string; seen: Set<string>; max: number; exp: number } | null = null;

  private ownerCache: Owner | null | undefined;
  private claimFails: number[] = [];
  private alarmer: Alarm;
  /** sockets this object already let go (their attachment says so too, when it could still be written) */
  private gone = new Set<string>();

  constructor(private env: Env, private onEnd: () => void = () => {}, private store: KV = memKV(), alarm?: Alarm) {
    this.alarmer = alarm ?? timerAlarm(() => void this.alarm());
  }

  // ---------------------------------------------------------------- hibernation: survive being dropped from memory
  /** A (re)started room object: read the room's record back. Call once, before any event (blockConcurrencyWhile). */
  async load() {
    const s = await this.store.get<Saved>('room');
    if (!s) return;
    // a record left behind long after its room should have ended (its alarm never ran): drop it, nothing else
    if (s.cfg && s.cfg.expiresAt + HOST_GRACE < Date.now()) { await this.store.delete?.('room'); return; }
    this.cfg = s.cfg; this.messageId = s.msg; this.rosterNames = s.roster; this.away = s.away; this.rosterAt = s.rosterAt;
    this.knocks = s.knocks; this.used = new Map(s.used);
    this.invite = s.invite ? { ...s.invite, seen: new Set(s.invite.seen) } : null;
  }
  /** Write the room's record (one row). Storage keeps the order of writes; nothing here waits for it. */
  private persist() {
    // (no room config = the host-signin object: it has no sockets and keeps no room record, which would never be deleted)
    if (this.ended || !this.cfg) return;
    const i = this.invite;
    const s: Saved = { cfg: this.cfg, msg: this.messageId, roster: this.rosterNames, away: this.away, rosterAt: this.rosterAt, knocks: this.knocks,
      used: [...this.used], invite: i ? { ...i, seen: [...i.seen] } : null };
    void this.store.put('room', s).catch(() => { /* the platform resets the object on a failed write */ });
  }
  /** A socket that was open before the object was dropped from memory (its attachment = its PeerState): at wake-up,
   *  or when an event arrives for a socket this object doesn't know yet (a close may come for a socket the runtime
   *  no longer lists). null (and the socket is closed) when the room is over or the room already let it go. */
  restore(sock: Sock, st: PeerState | null) {
    const known = st?.pid ? this.peers.get(st.pid) : undefined;
    if (known) return this.handleOf(known);
    if (!st?.pid || st.gone || this.gone.has(st.pid) || !this.cfg || this.ended) {
      try { if (this.cfg && !this.ended) sock.close(1011, 'unavailable'); else sock.close(1000, 'ended'); } catch { /* gone */ }
      return null;
    }
    const p: Peer = { ...st, sock, ip: '', tokens: 200, last: Date.now() };
    this.peers.set(p.pid, p);
    return this.handleOf(p);
  }
  /** The socket handlers of a known peer (by the pid in its attachment). */
  handle(pid: unknown) { const p = typeof pid === 'string' ? this.peers.get(pid) : undefined; return p ? this.handleOf(p) : null; }
  private handleOf(p: Peer) { return { message: (data: unknown) => this.onMessage(p, data), close: () => this.onClose(p) }; }
  private keep(p: Peer, gone = false) {
    if (!p.sock.keep) return;
    const { pid, role, user, guildOk, link, approved, authBy } = p;
    try { p.sock.keep({ pid, role, user, guildOk, link, approved, authBy, ...(gone ? { gone: true as const } : {}) }); } catch { /* closed */ }
  }
  /** Point the one alarm at the earliest deadline (expiry, host grace, bot edit, sockets that still have to sign in). */
  private schedule() {
    if (!this.cfg || this.ended) return;
    let at = this.cfg.expiresAt;
    if (this.away) at = Math.min(at, this.away.at);
    if (this.rosterAt) at = Math.min(at, this.rosterAt);
    for (const p of this.peers.values()) if (!p.role && p.authBy) at = Math.min(at, p.authBy);
    if (at === this.armed) return;
    this.armed = at;
    try { void Promise.resolve(this.alarmer.set(at)).catch(() => {}); } catch { /* retried at the next change */ }
  }
  /** The alarm rang: run every deadline that is due, then aim it at the next one. */
  async alarm() {
    this.armed = 0;
    if (!this.cfg || this.ended) return;
    const now = Date.now();
    if (this.cfg.expiresAt <= now) return this.end('expired');
    if (this.away && this.away.at <= now) return this.end(this.away.why);
    for (const p of [...this.peers.values()]) if (!p.role && p.authBy && p.authBy <= now) this.drop(p, 'auth timeout');
    if (this.rosterAt && this.rosterAt <= now) {
      this.rosterAt = 0;
      this.persist();
      if (this.cfg.channelId && this.messageId) await editInvite(this.env, this.cfg.channelId, this.messageId, this.view());
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- claim your relay (host box only, claim.ts)
  async owner(): Promise<Owner | null> {
    if (this.ownerCache === undefined) this.ownerCache = (await this.store.get<Owner>('owner')) ?? null;
    return this.ownerCache;
  }
  /** The first correct code for the CURRENT claim hash wins; ≤ 20 wrong codes an hour for the whole relay. */
  async claim(id: string, name: string, codeHash: string, claimHash: string): Promise<ClaimResult> {
    if (!/^[0-9a-f]{64}$/.test(claimHash) || !/^\d{5,25}$/.test(id)) return 'off';
    const o = await this.owner();
    if (o && o.claimHash === claimHash) return 'used';
    const now = Date.now();
    this.claimFails = this.claimFails.filter((t) => t > now - 3600_000);
    if (this.claimFails.length >= 20) return 'locked';
    let diff = codeHash.length ^ claimHash.length;
    for (let i = 0; i < claimHash.length; i++) diff |= claimHash.charCodeAt(i) ^ (codeHash.charCodeAt(i) || 0);
    if (diff) { this.claimFails.push(now); return 'wrong'; }
    const owner: Owner = { id, name: clean(name, 40), claimHash, at: now };
    await this.store.put('owner', owner);
    this.ownerCache = owner;
    return 'ok';
  }

  async init(cfg: RoomConfig) {
    if (this.cfg) throw new Error('room exists');
    this.cfg = cfg;
    // expiry (cfg.expiresAt) + the host has 3 minutes to connect
    this.away = { at: Date.now() + HOST_GRACE, why: 'host never connected' };
    this.persist();
    this.schedule();
    if (cfg.channelId) { this.messageId = await postInvite(this.env, cfg.channelId, this.view()); this.persist(); }
    return { posted: !!this.messageId };
  }

  info(uid?: string | null) {
    const c = this.cfg;
    if (!c || this.ended) return { alive: false };
    return { alive: true, hostUid: c.hostUid, hostName: c.hostName, hostAvatar: c.hostAvatar, guildId: c.guildId, roleIds: c.roleIds, banned: !!uid && c.bans.includes(uid), expiresAt: c.expiresAt };
  }

  private view() {
    const c = this.cfg!;
    const names = this.rosterNames ?? [c.hostName, ...[...this.peers.values()].filter((p) => p.role === 'guest' && p.approved && p.user).map((p) => p.user!.name)];
    // the bot's Join button: always the raw link on this relay
    return { hostName: c.hostName, joinUrl: c.joinUrl, members: names.slice(0, 8), expiresAt: c.expiresAt, ended: this.ended };
  }
  private rosterChanged() {
    if (!this.cfg?.channelId || !this.messageId) return;
    // debounced: the bot edits once things settle (the alarm runs it)
    this.rosterAt = Date.now() + ROSTER_DEBOUNCE;
    this.persist();
    this.schedule();
  }

  async end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    // nothing of the room stays behind: its record and its alarm go first
    this.rosterAt = 0; this.away = null; this.armed = 0;
    try { void Promise.resolve(this.alarmer.clear()).catch(() => {}); } catch { /* gone */ }
    if (this.cfg) void this.store.delete?.('room')?.catch(() => {});
    for (const p of this.peers.values()) { this.send(p, { t: 'ended', reason: clean(reason, 80) }); try { p.sock.close(1000, 'ended'); } catch { /* gone */ } }
    this.peers.clear();
    if (this.cfg?.channelId && this.messageId) await editInvite(this.env, this.cfg.channelId, this.messageId, this.view());
    this.onEnd();
  }

  // ---------------------------------------------------------------- guest-invite links (guestlink)
  /** Host made a (new) invite link: every older link stops working. */
  newInvite(max: number, exp: number): string {
    const gen = rid();
    this.invite = { gen, seen: new Set(), max: Math.max(1, Math.min(20, Math.floor(max) || 1)), exp };
    this.persist();
    return gen;
  }
  revokeInvite() { this.invite = null; this.persist(); }
  /** A guest's browser (key `gk`) wants a ticket from link generation `gen`: counts DISTINCT browsers, so a guest who
   *  reconnects (same tab / session) never uses up the link. */
  useInvite(gen: string, gk: string): 'ok' | 'revoked' | 'full' {
    const inv = this.invite;
    if (!this.cfg || this.ended || !inv || inv.gen !== gen || inv.exp < Date.now()) return 'revoked';
    if (inv.seen.has(gk)) return 'ok';
    if (inv.seen.size >= inv.max) return 'full';
    inv.seen.add(gk);
    this.persist();
    return 'ok';
  }
  inviteLive(gen: string): boolean { const i = this.invite; return !!this.cfg && !this.ended && !!i && i.gen === gen && i.exp > Date.now(); }
  inviteState() { const i = this.invite; return i && i.exp > Date.now() ? { uses: i.seen.size, max: i.max, exp: i.exp } : null; }

  // ---------------------------------------------------------------- sockets
  attach(sock: Sock, ip: string) {
    if (!this.cfg || this.ended || this.peers.size >= MAX_SOCKETS) { try { sock.send(JSON.stringify({ t: 'error', msg: this.ended || !this.cfg ? 'This party has ended' : 'Room full' })); sock.close(1008, 'unavailable'); } catch { /* gone */ } return null; }
    const p: Peer = { pid: rid(), sock, ip, role: null, user: null, guildOk: false, link: false, approved: false, tokens: 200, last: Date.now(), authBy: Date.now() + AUTH_TIME };
    this.peers.set(p.pid, p);
    this.keep(p);
    this.schedule();
    return this.handleOf(p);
  }

  private send(p: Peer, m: unknown) { try { p.sock.send(JSON.stringify(m)); } catch { /* gone */ } }
  private host(): Peer | null { for (const p of this.peers.values()) if (p.role === 'host') return p; return null; }
  private drop(p: Peer, why: string) { this.send(p, { t: 'error', msg: why }); this.keep(p, true); try { p.sock.close(1008, why.slice(0, 60)); } catch { /* gone */ } this.onClose(p); }

  private onClose(p: Peer) {
    if (!this.peers.delete(p.pid)) return;
    this.gone.add(p.pid);
    if (this.gone.size > 500) this.gone.delete(this.gone.values().next().value!);
    this.keep(p, true);
    if (p.role === 'host') {
      for (const g of this.peers.values()) if (g.role === 'guest') this.send(g, { t: 'host-away' });
      this.away = { at: Date.now() + HOST_GRACE, why: 'host left' };
      this.persist();
      this.schedule();
    } else if (p.role === 'guest') {
      const h = this.host();
      if (h) this.send(h, { t: 'left', peer: p.pid });
      if (p.approved) this.rosterChanged();
    }
  }

  private rate(p: Peer): boolean {
    const now = Date.now();
    p.tokens = Math.min(200, p.tokens + ((now - p.last) / 1000) * 40); // 40 msg/s sustained, bursts of 200 (ICE)
    p.last = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;
    return true;
  }

  private async onMessage(p: Peer, data: unknown) {
    if (this.ended) return;
    if (typeof data !== 'string' || data.length > MAX_MSG) return this.drop(p, 'message too large');
    if (!this.rate(p)) return this.drop(p, 'rate limited');
    let m: Record<string, unknown>;
    try { m = JSON.parse(data) as Record<string, unknown>; } catch { return this.drop(p, 'bad json'); }
    if (!p.role) { if (m.t === 'auth') await this.auth(p, m.ticket); else this.drop(p, 'auth first'); return; }
    switch (m.t) {
      case 'ping': this.send(p, { t: 'pong', n: Number(m.n) || 0 }); return;
      case 'signal': return this.signal(p, m);
    }
    if (p.role !== 'host') return;
    const target = typeof m.peer === 'string' ? this.peers.get(m.peer) : undefined;
    switch (m.t) {
      case 'approve': {
        if (!target || target.role !== 'guest' || target.approved) return;
        if ([...this.peers.values()].filter((x) => x.approved).length >= MAX_GUESTS) { this.send(p, { t: 'error', msg: 'Party is full' }); return; }
        target.approved = true;
        this.keep(target);
        this.send(target, { t: 'approved' });
        this.rosterChanged();
        return;
      }
      case 'deny': if (target?.role === 'guest') { this.send(target, { t: 'denied' }); this.drop(target, 'denied'); } return;
      case 'kick': {
        if (!target || target.role !== 'guest') return;
        if (m.ban === true && target.user && !this.cfg!.bans.includes(target.user.id)) { this.cfg!.bans.push(target.user.id); this.persist(); }
        this.send(target, { t: 'kicked', ban: m.ban === true });
        this.drop(target, 'kicked');
        return;
      }
      // moderation: the host's decision about one approved guest (camera hidden / muted). A notice only — the host enforces
      // it in its own studio; this is the backup path to the 'ctl' channel (a guest still connecting gets it too).
      case 'mod': {
        if (!target || target.role !== 'guest' || !target.approved) return;
        this.send(target, { t: 'mod', cam: m.cam === true, mic: m.mic === true });
        return;
      }
      case 'ban': { const uid = String(m.uid ?? ''); if (/^\d{5,25}$/.test(uid) && !this.cfg!.bans.includes(uid)) { this.cfg!.bans.push(uid); this.persist(); } for (const x of this.peers.values()) if (x.user?.id === uid && x.role === 'guest') { this.send(x, { t: 'kicked', ban: true }); this.drop(x, 'banned'); } return; }
      case 'roster': {
        if (!Array.isArray(m.names)) return;
        this.rosterNames = m.names.slice(0, 8).map((n) => clean(n, 40)).filter(Boolean);
        this.persist();
        this.rosterChanged();
        return;
      }
      case 'end': await this.end('host ended the party'); return;
    }
  }

  private async auth(p: Peer, ticket: unknown) {
    const c = this.cfg!;
    const body: TicketBody | null = (await verify(this.env.TICKET_SECRET, ticket, 'h')) ?? (await verify(this.env.TICKET_SECRET, ticket, 'g'));
    if (!body || body.r !== c.roomId) return this.drop(p, 'invalid or expired ticket');
    const now = Date.now();
    for (const [n, x] of this.used) if (x * 1000 < now) this.used.delete(n);
    if (this.used.has(body.j)) return this.drop(p, 'ticket already used');
    this.used.set(body.j, body.x);
    p.authBy = 0;
    this.persist();
    const uid = String(body.u ?? '');
    if (body.k === 'h') {
      if (uid !== c.hostUid) return this.drop(p, 'not the host');
      const old = this.host();
      if (old) this.drop(old, 'host reconnected elsewhere');
      this.away = null;
      p.role = 'host';
      p.user = { id: uid, name: clean(body.n, 40), username: clean(body.un, 40), avatar: body.a ?? null };
      this.keep(p);
      this.persist();
      this.schedule();
      this.send(p, { t: 'welcome', role: 'host', you: p.pid, user: p.user, ice: await iceServersFor(this.env, uid), room: c.roomId, expiresAt: c.expiresAt });
      // guests that knocked while the host was away
      for (const g of this.peers.values()) if (g.role === 'guest') { this.send(g, { t: 'host-back' }); this.send(p, { t: 'knock', peer: g.pid, user: g.user, guildOk: g.guildOk, approved: g.approved, ...(g.link ? { link: true } : {}) }); }
      return;
    }
    // guest
    if (c.bans.includes(uid)) return this.drop(p, 'You can’t join this party');
    if (uid === c.hostUid) return this.drop(p, 'You are the host');
    this.knocks = this.knocks.filter((t) => t > now - 600_000);
    if (this.knocks.length >= 40) return this.drop(p, 'Too many join attempts, try again later');
    this.knocks.push(now);
    for (const x of this.peers.values()) if (x !== p && x.role === 'guest' && x.user?.id === uid) this.drop(x, 'joined again elsewhere');
    p.role = 'guest';
    p.user = { id: uid, name: clean(body.n, 40), username: clean(body.un, 40), avatar: body.a ?? null };
    p.guildOk = body.g === 1 && body.nv !== 1;
    p.link = body.nv === 1;
    this.keep(p);
    this.persist();
    this.schedule();
    // a no-sign-in link guest gets the host's show name only (never their Discord id / avatar)
    const nameOnly = p.link;
    this.send(p, { t: 'welcome', role: 'guest', you: p.pid, user: p.user, host: nameOnly ? { name: c.hostName, avatar: null, uid: '' } : { name: c.hostName, avatar: c.hostAvatar, uid: c.hostUid }, ice: await iceServersFor(this.env, uid), room: c.roomId, hostHere: !!this.host(), ...(p.link ? { link: true } : {}) });
    const h = this.host();
    if (h) this.send(h, { t: 'knock', peer: p.pid, user: p.user, guildOk: p.guildOk, approved: false, ...(p.link ? { link: true } : {}) });
  }

  /** SDP / ICE only, host ↔ approved guest only, shape- and size-checked. */
  private signal(p: Peer, m: Record<string, unknown>) {
    const d = m.data as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== 'object') return;
    let data: unknown = null;
    const sdp = d.sdp as Record<string, unknown> | undefined;
    if (sdp && (sdp.type === 'offer' || sdp.type === 'answer') && typeof sdp.sdp === 'string' && sdp.sdp.length <= 16000) data = { sdp: { type: sdp.type, sdp: sdp.sdp } };
    else if ('candidate' in d) {
      const c = d.candidate as Record<string, unknown> | null;
      if (c === null) data = { candidate: null };
      else if (c && typeof c.candidate === 'string' && c.candidate.length <= 1024) data = { candidate: { candidate: c.candidate, sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 32) : null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null } };
    }
    if (!data) return;
    if (p.role === 'host') {
      const g = typeof m.to === 'string' ? this.peers.get(m.to) : undefined;
      if (g?.role === 'guest' && g.approved) this.send(g, { t: 'signal', from: 'host', data });
    } else if (p.approved) {
      const h = this.host();
      if (h) this.send(h, { t: 'signal', from: p.pid, data });
    }
  }
}

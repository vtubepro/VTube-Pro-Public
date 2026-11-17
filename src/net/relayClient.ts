// WebSocket client for the signalling relay (relay/ — Cloudflare Worker + Durable Object, or tools/mock_relay.ts).
// Carries ONLY the WebRTC handshake (SDP + ICE) and room control (knock / approve / kick). Tracking and avatars
// never touch it: they go peer-to-peer (or through TURN) inside DTLS.
import type { DiscordIdentity } from '../../shared/types.ts';

export interface RelayUser { id: string; name: string; username: string; avatar: string | null }
export interface Welcome { role: 'host' | 'guest'; you: string; user: RelayUser; ice: RTCIceServer[]; room: string; host?: { name: string; avatar: string | null; uid: string }; hostHere?: boolean; expiresAt?: number }
export interface Knock { peer: string; user: RelayUser; guildOk: boolean; approved: boolean; /** guestlink: joined with the no-sign-in link (name typed, NOT verified) */ link?: boolean }
export interface SignalData { sdp?: { type: 'offer' | 'answer'; sdp: string }; candidate?: RTCIceCandidateInit | null }

export interface RelayHandlers {
  welcome(w: Welcome): void;
  knock?(k: Knock): void;
  left?(peer: string): void;
  signal(from: string, d: SignalData): void;
  approved?(): void;
  denied?(): void;
  kicked?(ban: boolean): void;
  /** moderation (guest): the host turned my camera off / muted me (or lifted it) — the backup path to the 'ctl' notice. */
  mod?(m: { cam: boolean; mic: boolean }): void;
  ended?(reason: string): void;
  hostAway?(away: boolean): void;
  error?(msg: string): void;
  /** Socket closed (not by us). */
  closed?(): void;
}

export const toIdentity = (u: RelayUser | null | undefined): DiscordIdentity | null =>
  // (guestlink: 'link<hex>' = a no-sign-in interview guest — a relay-made id, NOT a Discord account)
  u && /^(\d{5,25}|link[0-9a-f]{20})$/.test(u.id) ? { id: u.id, name: String(u.name).slice(0, 40), username: String(u.username ?? '').slice(0, 40), avatar: u.avatar ?? null } : null;

/** Unverified peek at a ticket's payload (display only: the relay verifies it). */
export function peekTicket(t: string): { r?: string; n?: string; hn?: string; x?: number; k?: string } {
  try {
    const p = t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p + '='.repeat((4 - (p.length % 4)) % 4))))) as never;
  } catch { return {}; }
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private pingT = 0;
  constructor(readonly origin: string, readonly room: string, private h: RelayHandlers) {
    if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new Error('relay must be https:// (or a local mock)');
    if (!/^[a-z0-9]{16,40}$/.test(room)) throw new Error('bad room id');
  }

  connect(ticket: string): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const url = `${this.origin.replace(/^http/, 'ws')}/room/${this.room}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.closedByUs = false;
      let welcomed = false;
      const t = setTimeout(() => { if (!welcomed) { reject(new Error('relay did not answer')); ws.close(); } }, 12000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', ticket }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.length > 32000) return;
        let m: Record<string, unknown>;
        try { m = JSON.parse(e.data) as Record<string, unknown>; } catch { return; }
        switch (m.t) {
          case 'welcome': welcomed = true; clearTimeout(t); this.h.welcome(m as unknown as Welcome); resolve(m as unknown as Welcome); break;
          case 'knock': this.h.knock?.(m as unknown as Knock); break;
          case 'left': this.h.left?.(String(m.peer)); break;
          case 'signal': this.h.signal(String(m.from), (m.data ?? {}) as SignalData); break;
          case 'approved': this.h.approved?.(); break;
          case 'denied': this.h.denied?.(); break;
          case 'kicked': this.h.kicked?.(m.ban === true); break;
          case 'mod': this.h.mod?.({ cam: m.cam === true, mic: m.mic === true }); break;
          case 'ended': this.h.ended?.(String(m.reason ?? '')); break;
          case 'host-away': this.h.hostAway?.(true); break;
          case 'host-back': this.h.hostAway?.(false); break;
          case 'error': if (!welcomed) { clearTimeout(t); reject(new Error(String(m.msg))); } else this.h.error?.(String(m.msg)); break;
        }
      };
      ws.onclose = () => {
        clearTimeout(t);
        clearInterval(this.pingT);
        if (!welcomed) reject(new Error('relay closed the connection'));
        else if (!this.closedByUs) this.h.closed?.();
      };
      // keep NATs / proxies from idling the socket out. Always exactly {"t":"ping","n":0} (relay/src/room.ts PING): a
      // hibernating relay answers that text itself without waking the room (relay/HIBERNATION.md); older relays pong it too
      clearInterval(this.pingT);
      this.pingT = window.setInterval(() => this.send({ t: 'ping', n: 0 }), 25000);
    });
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  private send(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  signal(to: string, data: SignalData) { this.send({ t: 'signal', to, data }); }
  approve(peer: string) { this.send({ t: 'approve', peer }); }
  deny(peer: string) { this.send({ t: 'deny', peer }); }
  kick(peer: string, ban: boolean) { this.send({ t: 'kick', peer, ban }); }
  /** moderation (host): tell guest `peer` what I decided (their page shows it; enforcement stays on my side). */
  mod(peer: string, cam: boolean, mic: boolean) { this.send({ t: 'mod', peer, cam, mic }); }
  ban(uid: string) { this.send({ t: 'ban', uid }); }
  roster(names: string[]) { this.send({ t: 'roster', names }); }
  end() { this.send({ t: 'end' }); this.close(); }
  close() { this.closedByUs = true; clearInterval(this.pingT); try { this.ws?.close(); } catch { /* gone */ } this.ws = null; }
}

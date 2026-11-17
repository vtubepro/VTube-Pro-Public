// Studio side of the live chat (read only): keeps the recent events + connection status for the Scene tab, and moves
// them between PCs for the in-world props —
//   host  → every party guest ({t:'chat'} on the party link: sanitised, size-capped, test events never leave this PC;
//           a snapshot of the recent ones when someone joins)
//   guest → this PC's OBS pages (bus {type:'chat', origin:'party'}), and a catch-up batch when an OBS page connects.
// The OBS pages of the host read the server's broadcasts directly (origin 'local').
import { sanitizeChatEvent, sanitizeTotals, type ChatEvent, type ChatStatus, type ChatTotals } from '../../shared/chat.ts';
import type { BusMessage } from '../../shared/types.ts';
import { api } from '../api.ts';
import type { Bus } from '../bus.ts';
import type { Party } from '../party.ts';
import { removedBy } from '../../shared/chatRemove.ts';

const RING = 60;
/** Party control messages are capped at 64 KB (src/party.ts): stay well under it. */
const MAX_WIRE = 40 * 1024;

export class StudioChat {
  events: ChatEvent[] = [];
  support: ChatEvent[] = [];
  totals: ChatTotals | null = null;
  status: ChatStatus | null = null;
  private listeners = new Set<() => void>();
  private members = 0;
  private emitT = 0;

  constructor(private bus: Bus, private party: Party, readonly observer: boolean) {
    bus.on((m) => this.onBus(m));
    void api.get<{ evs: unknown[]; tot: unknown }>('/api/chat/recent?n=40').then((r) => this.add(r.evs ?? [], r.tot, 'local')).catch(() => {});
    // the status is read again whenever the bus (re)connects: the helper only broadcasts changes, so one sent while
    // this page's socket was down (a server restart) would never come back
    const readStatus = () => void api.get<ChatStatus>('/api/chat/status').then((s) => { this.status = s; this.emit(); }).catch(() => {});
    readStatus();
    bus.onLink((up) => { if (up) readStatus(); });
    // host: someone joined → send them the recent chat (their OBS shows the room's monitor right away)
    party.listeners.add(() => {
      const n = party.members.length;
      if (party.role === 'host' && n > this.members) this.sendSnapshot();
      this.members = n;
    });
    const p = party as unknown as { onChat?: (evs: unknown, tot: unknown, snap?: boolean) => void };
    p.onChat = (evs, tot, snap) => this.fromHost(evs, tot, !!snap);
  }

  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { clearTimeout(this.emitT); this.emitT = window.setTimeout(() => { for (const l of this.listeners) try { l(); } catch { /* */ } }, 120); }

  private onBus(m: BusMessage) {
    if (m.type === 'chatStatus') { this.status = m.status; this.emit(); return; }
    // an OBS page connected: a guest hands it the host's recent chat
    if (m.type === 'hello' && m.role === 'output' && this.party.role === 'guest' && !this.observer && this.events.length) {
      this.bus.send({ type: 'chat', evs: [...this.support, ...this.events].slice(-60), ...(this.totals ? { tot: this.totals } : {}), origin: 'party', snap: true });
      return;
    }
    if (m.type !== 'chat' || m.origin === 'party') return;
    // this PC's server (host / solo)
    if (this.party.role === 'guest') return;
    const fresh = this.add(Array.isArray(m.evs) ? m.evs : [], m.tot, 'local');
    if (this.party.role === 'host' && !this.observer) {
      const out = fresh.filter((e) => !e.test);
      if (out.length || m.tot) this.sendWire(out, m.tot);
    }
  }

  /** Guest: the host's events arrived over the party link. */
  private fromHost(evs: unknown, tot: unknown, snap: boolean) {
    if (this.party.role !== 'guest') return;
    const fresh = this.add(Array.isArray(evs) ? evs : [], tot, 'party');
    if (!this.observer && (fresh.length || tot)) this.bus.send({ type: 'chat', evs: fresh, ...(this.totals && tot ? { tot: this.totals } : {}), origin: 'party', ...(snap ? { snap: true } : {}) });
  }

  /** Recent deletes (a deleted line never comes back from a snapshot). */
  private deletes: ChatEvent[] = [];
  private add(list: unknown[], tot: unknown, _origin: string): ChatEvent[] {
    const have = new Set([...this.events, ...this.support].map((e) => e.id));
    const fresh: ChatEvent[] = [];
    for (const raw of list.slice(0, 120)) {
      const e = sanitizeChatEvent(raw);
      if (!e) continue;
      // (shared/chatRemove.ts) a delete takes the line AND its support card out of both lists (catch-ups send both), and is
      // remembered so a later copy of that line (a snapshot, a re-send) is never put back
      if (e.kind === 'delete') { this.events = this.events.filter((x) => !removedBy(e, x)); this.support = this.support.filter((x) => !removedBy(e, x)); this.deletes.push(e); if (this.deletes.length > 100) this.deletes.shift(); fresh.push(e); continue; }
      if (e.kind === 'purge') { this.events = this.events.filter((x) => !removedBy(e, x)); this.support = this.support.filter((x) => !removedBy(e, x)); fresh.push(e); continue; }
      if (have.has(e.id) || this.deletes.some((d) => removedBy(d, e))) continue;
      have.add(e.id);
      fresh.push(e);
      if (e.cue) continue; // Chat Hub "thank on stream" replay: relayed, not stored twice
      this.events.push(e);
      if (e.kind === 'finance') this.support.push(e);
    }
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
    if (this.support.length > 12) this.support.splice(0, this.support.length - 12);
    const t = sanitizeTotals(tot);
    if (t) this.totals = t;
    if (fresh.length || t) this.emit();
    return fresh;
  }

  private sendWire(evs: ChatEvent[], tot: unknown, snap = false) {
    const P = this.party as unknown as { sendChat?: (evs: ChatEvent[], tot?: unknown, snap?: boolean) => void };
    let list = evs;
    while (list.length && JSON.stringify(list).length > MAX_WIRE) list = list.slice(Math.ceil(list.length / 2));
    P.sendChat?.(list, tot ?? undefined, snap);
  }
  private sendSnapshot() {
    if (this.observer) return;
    const list = [...this.support, ...this.events].filter((e) => !e.test).slice(-40);
    this.sendWire(list, this.totals, true);
  }
}

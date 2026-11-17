// ChatFeed: the page-side store of recent chat + support events (OBS output, Scene-tab preview, studio). Dedupes by id,
// applies moderation removals, keeps the session support totals, and notifies subscribers (the in-world props).
import { sanitizeChatEvent, sanitizeTotals, type ChatEvent, type ChatTotals } from '../../shared/chat.ts';
import { removedBy } from '../../shared/chatRemove.ts';

const KEEP = 120;
const KEEP_SUPPORT = 30;

export class ChatFeed {
  /** Newest last (chat, system lines and support events). */
  events: ChatEvent[] = [];
  /** The last support events, kept separately so a busy chat never pushes them off the support board. */
  support: ChatEvent[] = [];
  totals: ChatTotals | null = null;
  /** Bumps on every change (canvases redraw only when it moves). */
  rev = 0;
  /** Epoch ms of the newest chat line (auto-drop). */
  lastChatAt = 0;
  private ids = new Set<string>();
  private subs = new Set<(fresh: ChatEvent[], snap: boolean) => void>();

  on(fn: (fresh: ChatEvent[], snap: boolean) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }

  /** Add events (raw from the bus / party — sanitised here). `snap` = catch-up history: no alerts for these. */
  push(list: unknown[], tot?: unknown, snap = false) {
    const fresh: ChatEvent[] = [];
    for (const raw of list.slice(0, 200)) {
      const e = sanitizeChatEvent(raw);
      if (!e) continue;
      if (e.kind === 'delete') { this.events = this.events.filter((x) => !removedBy(e, x)); this.support = this.support.filter((x) => !removedBy(e, x)); this.rev++; continue; }
      if (e.kind === 'purge') {
        this.events = this.events.filter((x) => !removedBy(e, x));   // (by platform user id when both have one: shared/chatRemove.ts)
        this.rev++; continue;
      }
      if (this.ids.has(e.id)) continue;
      this.ids.add(e.id);
      fresh.push(e);
    }
    const t = sanitizeTotals(tot);
    if (t) { this.totals = t; this.rev++; }
    // Chat Hub "thank on stream" cues: alert subscribers again, but never store a second copy
    const store = fresh.filter((e) => !e.cue);
    if (store.length) {
      this.events.push(...store);
      this.events.sort((a, b) => a.ts - b.ts);
      if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP);
      const fin = store.filter((e) => e.kind === 'finance');
      if (fin.length) {
        this.support.push(...fin);
        this.support.sort((a, b) => a.ts - b.ts);
        if (this.support.length > KEEP_SUPPORT) this.support.splice(0, this.support.length - KEEP_SUPPORT);
      }
      if (this.ids.size > 3000) this.ids = new Set([...this.events, ...this.support].map((e) => e.id));
      const chat = store.filter((e) => e.kind !== 'finance');
      const last = chat.length ? Math.min(Date.now(), chat[chat.length - 1].ts) : 0;
      if (last > this.lastChatAt) this.lastChatAt = last;
      this.rev++;
    }
    if (fresh.length || t) for (const s of this.subs) try { s(fresh, snap); } catch (err) { console.warn('chat feed', err); }
  }

  clear() { this.events = []; this.support = []; this.ids.clear(); this.rev++; }
}

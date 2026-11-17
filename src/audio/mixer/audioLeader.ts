// The studio side of "one studio plays the show's sounds" (the rules: shared/audioLeader.ts).
//   1. Same-origin windows: the browser's Web Lock 'vtp-show-sounds'. This window asks for it; while it holds it, it may
//      play. The other windows wait in the lock's queue; the browser hands the lock on by itself when the holder closes,
//      crashes or is discarded. stop() lets go at once. A page put in the back-forward cache lets go too and asks again
//      when it comes back. Browsers without Web Locks: a BroadcastChannel fallback (the oldest live window leads; peers
//      that stop answering are forgotten; a lone window always leads).
//   2. Across origins: a lock holder announces itself on the server's bus ({type:'soundhello', id, key}) and plays only
//      with the server's grant ({type:'soundlead'}). Without a server to ask, decideLead's "last grant" rule keeps it to
//      one window.
// ShowSounds / the mixer ask isLeader() before every sound and stop what is playing when it turns false (listeners).
// Everything browser-related is injectable (`deps`): a test can drive it with a fake lock manager, bus and timers.
import { ARBITER_WAIT_MS, BUS_DOWN_MS, SOUND_LOCK, decideLead, readSoundLead, type LeadInputs, type LeadWhy, type LeaderState } from '../../../shared/audioLeader.ts';
export type { LeaderState, LeadWhy };

interface BusLike { send(m: unknown): void; on(h: (m: unknown) => void): () => void; connected?: boolean; onLink?(fn: (up: boolean) => void): () => void }
/** The part of navigator.locks we use. */
export interface LockManagerLike {
  request(name: string, opts: { mode?: 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: unknown) => unknown): Promise<unknown>;
}
type Chan = { post(m: unknown): void; onmessage: ((m: unknown) => void) | null; close(): void };
export interface LeaderDeps {
  /** default navigator.locks; null = this browser has none (the BroadcastChannel fallback) */
  locks?: LockManagerLike | null;
  /** the fallback's same-origin channel (default a BroadcastChannel; null = none: a lone window) */
  channel?: (name: string) => Chan | null;
  /** a one-shot timer (returns its canceller) */
  after?: (ms: number, fn: () => void) => () => void;
  /** page lifecycle: hide (persisted = into the back-forward cache) / show again (persisted = back from it) */
  page?: (hide: (persisted: boolean) => void, show: (persisted: boolean) => void) => void;
  /** this site's lineage secret (shared by its tabs in this browser; default kept in localStorage) */
  key?: string;
  id?: string;
}
const rid = (n = 10) => { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
const LINEAGE = 'vtp.soundLineage';
function browserKey(): string {
  try {
    const k = localStorage.getItem(LINEAGE);
    if (k && /^[\w-]{16,64}$/.test(k)) return k;
    const n = rid(24); localStorage.setItem(LINEAGE, n); return n;
  } catch { return rid(24); }
}
const browserLocks = (): LockManagerLike | null => {
  try { return (globalThis.navigator as Navigator & { locks?: LockManagerLike } | undefined)?.locks ?? null; } catch { return null; }
};
const browserChannel = (name: string): Chan | null => {
  try {
    const c = new BroadcastChannel(name);
    const o: Chan = { post: (m) => c.postMessage(m), onmessage: null, close: () => c.close() };
    c.onmessage = (e) => o.onmessage?.(e.data);
    return o;
  } catch { return null; }
};
const browserPage = (hide: (p: boolean) => void, show: (p: boolean) => void) => {
  try {
    window.addEventListener('pagehide', (e) => hide((e as PageTransitionEvent).persisted === true));
    window.addEventListener('pageshow', (e) => show((e as PageTransitionEvent).persisted === true));
  } catch { /* not a page */ }
};
/** The no-locks fallback asks the other windows this often; one that misses two asks is forgotten. */
const FALLBACK_ASK_MS = 3000;

export class AudioLeader {
  readonly id: string;
  readonly listeners = new Set<(s: LeaderState) => void>();
  private key: string;
  private holder: boolean | null = null;
  private bus: LeadInputs['bus'];
  private gone = false;
  private arbiter: LeadInputs['arbiter'] = 'unknown';
  private grant: LeadInputs['grant'] = null;
  private last: LeadInputs['last'] = null;
  /** stop(): for good · away: in the back-forward cache (comes back) */
  private stopped = false;
  private away = false;
  private release: (() => void) | null = null;
  private abort: AbortController | null = null;
  private cancelWait: (() => void) | null = null;
  private cancelDown: (() => void) | null = null;
  private chan: Chan | null = null;
  private leaveFallback: (() => void) | null = null;
  private was: { state: LeaderState; why: LeadWhy } = { state: 'pending', why: 'waiting' };
  private after: (ms: number, fn: () => void) => () => void;
  private locks: LockManagerLike | null;
  private channel: (name: string) => Chan | null;

  constructor(private busRef: BusLike | null, deps: LeaderDeps = {}) {
    this.id = deps.id ?? rid();
    this.key = deps.key ?? browserKey();
    this.after = deps.after ?? ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.bus = busRef ? (busRef.connected ? 'open' : 'connecting') : 'down';
    this.gone = !busRef;                                           // (no bus at all: nothing to wait for)
    busRef?.on((m) => this.hear(m));
    busRef?.onLink?.((up) => this.link(up));
    (deps.page ?? browserPage)((persisted) => (persisted ? this.sleep() : this.stop()), (persisted) => { if (persisted) this.wakeUp(); });
    this.locks = deps.locks === undefined ? browserLocks() : deps.locks;
    this.channel = deps.channel ?? browserChannel;
    this.claim();
    if (this.bus === 'open') this.hello();
  }
  private off() { return this.stopped || this.away; }
  private claim() { if (this.locks) this.lock(this.locks); else this.fallback(); }

  // ---- 1. same origin: the Web Lock
  private lock(L: LockManagerLike) {
    const hold = () => {
      if (this.off()) return undefined;                          // (stopped / away while queued: give it straight back)
      this.setHolder(true);
      return new Promise<void>((res) => { this.release = res; }); // held until stop() / sleep() / the page dies
    };
    L.request(SOUND_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (lock) return hold();
      if (this.off()) return undefined;
      // another window of this studio holds it: wait in the queue (the browser hands it on when that window goes)
      this.setHolder(false);
      this.abort = typeof AbortController === 'function' ? new AbortController() : null;
      L.request(SOUND_LOCK, { mode: 'exclusive', ...(this.abort ? { signal: this.abort.signal } : {}) }, () => hold()).catch(() => { /* aborted */ });
      return undefined;
    }).catch(() => { if (!this.off()) this.setHolder(true); });  // (locks refused, e.g. an opaque origin: lead alone)
  }
  private letGo() {
    if (this.holder && this.bus === 'open') try { this.busRef?.send({ type: 'soundbye', id: this.id }); } catch { /* bus down */ }
    this.release?.(); this.release = null;
    this.abort?.abort(); this.abort = null;
    this.leaveFallback?.(); this.leaveFallback = null;
  }

  // ---- 1b. no Web Locks: the oldest live window of this origin leads; a lone window always leads
  private fallback() {
    const since = Date.now();
    const peers = new Map<string, { since: number; seen: number }>();
    const chan = this.chan = this.channel(SOUND_LOCK);
    if (!chan) { this.setHolder(true); return; }
    let now = 0;                                                      // (asks so far: a peer is "seen" at an ask number)
    const decide = () => {
      for (const [id, p] of peers) if (now - p.seen >= 2) peers.delete(id); // missed two asks: gone (crashed, frozen)
      let mine = true;
      for (const [id, p] of peers) if (p.since < since || (p.since === since && id < this.id)) mine = false;
      this.setHolder(mine);
    };
    chan.onmessage = (raw) => {
      const m = raw as { k?: string; id?: string; since?: number } | null;
      if (!m || typeof m.id !== 'string' || m.id === this.id || this.off()) return;
      if (m.k === 'bye') peers.delete(m.id);
      else if (typeof m.since === 'number') peers.set(m.id, { since: m.since, seen: now });
      if (m.k === 'q') chan.post({ k: 'hi', id: this.id, since });
      if (this.holder !== null) decide();
    };
    let cancel: (() => void) | null = null, alive = true;
    const ask = () => {
      if (!alive) return;
      now++;
      try { chan.post({ k: 'q', id: this.id, since }); } catch { /* closed */ }
      cancel = this.after(300, () => { if (!alive) return; decide(); cancel = this.after(FALLBACK_ASK_MS - 300, ask); });
    };
    ask();
    this.leaveFallback = () => { alive = false; cancel?.(); try { chan.post({ k: 'bye', id: this.id }); chan.close(); } catch { /* closed */ } this.chan = null; };
  }

  // ---- 2. across origins: the server's grant
  private hello() {
    if (!this.holder || this.off() || this.bus !== 'open') return;
    try { this.busRef?.send({ type: 'soundhello', id: this.id, key: this.key }); } catch { /* bus down */ }
    if (this.arbiter === 'unknown') {
      this.cancelWait?.();
      this.cancelWait = this.after(ARBITER_WAIT_MS, () => { if (this.arbiter === 'unknown' && this.bus === 'open') { this.arbiter = 'no'; this.check(); } });
    }
  }
  private hear(m: unknown) {
    const g = readSoundLead(m);
    if (g === undefined || this.off()) return;
    this.arbiter = 'yes'; this.grant = g;
    if (g.id) this.last = { id: g.id, local: g.local };
    this.cancelWait?.(); this.cancelWait = null;
    this.check();
  }
  private link(up: boolean) {
    if (this.stopped) return;
    this.bus = up ? 'open' : 'down';
    this.arbiter = 'unknown'; this.grant = null;              // a new connection: ask again
    this.cancelWait?.(); this.cancelWait = null;
    this.cancelDown?.(); this.cancelDown = null;
    this.gone = false;
    if (up) this.hello();
    else {
      // after BUS_DOWN_MS stop waiting (the last grant decides)
      this.cancelDown = this.after(BUS_DOWN_MS, () => { if (this.bus === 'down') { this.gone = true; this.check(); } });
    }
    this.check();
  }
  private setHolder(on: boolean) {
    if (this.holder === on) return;
    this.holder = on;
    if (on) this.hello();
    this.check();
  }

  // ---- the page's life
  /** Into the back-forward cache: let go now (the next window takes over); wakeUp() asks again. */
  private sleep() {
    if (this.stopped || this.away) return;
    this.letGo();
    this.away = true;
    this.holder = null;
    this.cancelWait?.(); this.cancelWait = null;
    this.check();
  }
  private wakeUp() {
    if (this.stopped || !this.away) return;
    this.away = false;
    this.arbiter = 'unknown'; this.grant = null;
    this.claim();
    this.check();
  }

  private inputs(): LeadInputs {
    return { holder: this.holder, bus: this.bus, gone: this.gone, arbiter: this.arbiter, grant: this.grant, last: this.last, me: this.id };
  }
  /** Re-decide and tell the listeners if it changed. */
  check() {
    const d = this.where();
    if (d.state === this.was.state && d.why === this.was.why) return;
    const changed = d.state !== this.was.state;
    this.was = d;
    if (changed) for (const f of this.listeners) try { f(d.state); } catch { /* listener */ }
  }
  /** Who plays, and why (the mixer card says it). */
  where(): { state: LeaderState; why: LeadWhy } { return this.stopped ? { state: 'follower', why: 'tab' } : this.away ? { state: 'pending', why: 'waiting' } : decideLead(this.inputs()); }
  /** leader = play now · pending = maybe in a moment (queue) · follower = another studio window plays. */
  state(): LeaderState { return this.where().state; }
  isLeader(): boolean { return this.state() === 'leader'; }
  /** Leaving for good: not the leader any more, at once; the lock (and the server's grant) go to the next window. */
  stop() {
    if (this.stopped) return;
    this.letGo();
    this.stopped = true;
    this.cancelWait?.(); this.cancelWait = null;
    this.cancelDown?.(); this.cancelDown = null;
    this.check();
  }
}

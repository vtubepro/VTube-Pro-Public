// One studio plays the show's sounds (beta.12): read-aloud, the room screen video, room sounds, games, the narrator and
// sound inputs must play in exactly ONE studio window, or the stream hears them twice. Two pieces, no heartbeat election:
//   1. Same-origin windows (two tabs of one studio): the browser's Web Lock 'vtp-show-sounds'. The holder plays; the
//      others wait in the lock queue and get it automatically when it closes, crashes or is discarded (sleep and
//      throttling can't split a lock). Very old browsers without Web Locks: a BroadcastChannel fallback (the oldest live
//      window plays; a lone window always plays) in src/audio/mixer/audioLeader.ts.
//   2. Across origins (localhost vs 127.0.0.1, or the same studio open in two browsers): VTube Pro's server decides. Every
//      lock holder announces itself on the server's bus ({type:'soundhello', id, key}); the server knows which sockets are
//      on this PC (their Origin) and grants the show's sounds to exactly one ({type:'soundlead', id}) — a studio on this PC
//      first (the one that announced first), else the oldest other one — and re-grants when that socket closes or stops
//      answering pings (SoundArbiter below, server/bus.ts). Grants go only to sockets that announced themselves. `key` is
//      the studio's lineage: a secret shared by the tabs of one site in one browser (localStorage), never sent out by the
//      server. A hello with a known key replaces that lineage's entry (the next tab took the lock, or the page
//      reconnected); an id held by another lineage is ignored, so no page can take over someone else's grant by
//      repeating its id.
// When the server can't be asked (its bus is down, it died, or no grant arrives in time), decideLead keeps at most one
// player by remembering the last grant: only the studio that last had it (or one that never saw anyone else get it)
// plays on.
// Pure: no DOM, no network.

export type SoundHello = { type: 'soundhello'; id: string; key: string };
export type SoundBye = { type: 'soundbye'; id: string };
/** The server's grant: `id` plays (null = no studio announced); `local` = that studio is on this PC. */
export type SoundLead = { type: 'soundlead'; id: string | null; local?: boolean };
export const SOUND_LOCK = 'vtp-show-sounds';
/** How long a lock holder waits for the server's answer to its hello before deciding "no grant: this window plays". */
export const ARBITER_WAIT_MS = 1500;
/** The server pings announced studios this often; one missed answer drops that studio from the arbiter. */
export const SOUND_PING_MS = 2000;
/** A studio whose bus stays down this long stops waiting for it (decideLead: the last grant decides). */
export const BUS_DOWN_MS = 3000;
const ID = /^[\w-]{4,40}$/;
const KEY = /^[\w-]{16,64}$/;

export function sanitizeSoundHello(x: unknown): SoundHello | SoundBye | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  if (o.type === 'soundbye') return { type: 'soundbye', id: o.id };
  if (o.type !== 'soundhello' || typeof o.key !== 'string' || !KEY.test(o.key)) return null;
  return { type: 'soundhello', id: o.id, key: o.key };
}
/** A grant heard on the bus: undefined = not a grant; else who plays (null = nobody announced) and whether on this PC. */
export function readSoundLead(x: unknown): { id: string | null; local: boolean } | undefined {
  if (!x || typeof x !== 'object' || (x as { type?: unknown }).type !== 'soundlead') return undefined;
  const o = x as { id?: unknown; local?: unknown };
  return { id: typeof o.id === 'string' && ID.test(o.id) ? o.id : null, local: o.local === true };
}

type Entry<C> = { client: C; id: string; key: string; local: boolean; seq: number };
/** The server's side: which studio plays the show's sounds. `C` is the server's handle on a socket; `send` delivers a
 *  grant to one socket. server/bus.ts feeds it every sound* frame, socket close and pong, and calls sweep() every
 *  SOUND_PING_MS (then pings every studio socket). */
export class SoundArbiter<C = unknown> {
  private list: Entry<C>[] = [];
  private seq = 0;
  /** sockets that announced themselves (only they hear grants) → waiting for a pong */
  private studios = new Map<C, boolean>();
  private granted: Entry<C> | null = null;
  constructor(private send: (c: C, m: SoundLead) => void, private log: (why: string) => void = () => {}) {}

  /** A sound* frame from a socket. `local` = that socket comes from a page on this PC (decided from the connection). */
  message(client: C, raw: unknown, local: boolean) {
    const m = sanitizeSoundHello(raw);
    if (!m) return;
    if (m.type === 'soundbye') { this.list = this.list.filter((x) => !(x.client === client && x.id === m.id)); this.publish(null); return; }
    const mine = this.list.find((x) => x.client === client && x.id === m.id && x.key === m.key);
    if (!mine) {
      const sameKey = this.list.find((x) => x.key === m.key);
      const sameId = this.list.find((x) => x.id === m.id);
      // (refused: told once who plays, so it stays quiet, but it doesn't join the studios that hear later grants; a
      // socket that was in line and now repeats another studio's id leaves the line and the studios too)
      if (sameId && sameId.key !== m.key) {
        this.log(`ignored a sound hello repeating another studio's id (${m.id})`);
        this.studios.delete(client); this.list = this.list.filter((x) => x.client !== client); this.publish(null);
        this.send(client, this.grantMessage()); return;
      }
      // this socket's older entry goes; a known lineage (the next tab of that site, or the page on a new connection)
      // keeps its place in line, on this socket now
      this.list = this.list.filter((x) => x.client !== client && x !== sameKey);
      this.list.push({ client, id: m.id, key: m.key, local, seq: sameKey?.seq ?? ++this.seq });
    }
    this.studios.set(client, false);
    this.publish(client);
  }
  /** The socket closed. */
  closed(client: C) { this.studios.delete(client); this.list = this.list.filter((x) => x.client !== client); this.publish(null); }
  /** The socket answered a ping. */
  pong(client: C) { if (this.studios.has(client)) this.studios.set(client, false); }
  /** Every SOUND_PING_MS: studios that didn't answer the last ping are dropped (returned: the server closes them); the
   *  rest are now waiting for an answer (the server pings studioSockets() right after). */
  sweep(): C[] {
    const dead: C[] = [];
    for (const [c, waiting] of this.studios) if (waiting) dead.push(c); else this.studios.set(c, true);
    for (const c of dead) { this.studios.delete(c); this.list = this.list.filter((x) => x.client !== c); this.log('dropped a studio that stopped answering'); }
    if (dead.length) this.publish(null);
    return dead;
  }
  studioSockets(): C[] { return [...this.studios.keys()]; }
  /** Who plays now: a studio on this PC first (the one that announced first), else the oldest other one. */
  private best(): Entry<C> | null {
    let best: Entry<C> | null = null;
    for (const x of this.list) if (!best || (x.local && !best.local) || (x.local === best.local && x.seq < best.seq)) best = x;
    return best;
  }
  lead(): { id: string; local: boolean } | null { const b = this.best(); return b ? { id: b.id, local: b.local } : null; }
  grantMessage(): SoundLead { const b = this.best(); return { type: 'soundlead', id: b?.id ?? null, local: b?.local ?? false }; }
  /** Tell every studio when the winner changed (a different entry, even with the same id); else answer `asker` alone. */
  private publish(asker: C | null) {
    const b = this.best(), m = this.grantMessage();
    if (b !== this.granted) { this.granted = b; for (const c of this.studios.keys()) this.send(c, m); return; }
    if (asker !== null && this.studios.has(asker)) this.send(asker, m);
  }
  get size() { return this.list.length; }
}

/** Why this window plays / stays quiet (the mixer card says it in plain words). */
export type LeadWhy =
  | 'me'        // this window plays
  | 'tab'       // another window of this same studio plays (it holds the lock)
  | 'pc'        // the studio on this PC plays (the server said so)
  | 'other'     // another studio (not on this PC) plays (the server said so)
  | 'waiting';  // still finding out (a moment)
export type LeaderState = 'leader' | 'follower' | 'pending';
export interface LeadInputs {
  /** same-origin: null = still asking the browser; true = this window holds the lock; false = another window does */
  holder: boolean | null;
  /** the server's bus: connecting (never opened yet), open, down (it closed: VTube Pro is restarting / gone) */
  bus: 'connecting' | 'open' | 'down';
  /** the bus has been down for BUS_DOWN_MS */
  gone: boolean;
  /** does the server arbitrate? 'unknown' = it hasn't answered our hello yet; 'no' = no answer in time */
  arbiter: 'unknown' | 'yes' | 'no';
  /** the grant heard on the current connection */
  grant: { id: string | null; local: boolean } | null;
  /** the last grant ever heard (kept across disconnects): who played when we last knew */
  last: { id: string; local: boolean } | null;
  me: string;
}
/** The studio's decision (pure, so every case is tested): may this window play the show's sounds? */
export function decideLead(o: LeadInputs): { state: LeaderState; why: LeadWhy } {
  const W = (why: LeadWhy): { state: LeaderState; why: LeadWhy } => ({ state: why === 'me' ? 'leader' : why === 'waiting' ? 'pending' : 'follower', why });
  if (o.holder === null) return W('waiting');
  if (!o.holder) return W('tab');
  const granted = () => !o.grant || o.grant.id === null ? W('waiting') : o.grant.id === o.me ? W('me') : W(o.grant.local ? 'pc' : 'other');
  // nobody to ask: only the studio that last had the grant plays on (or one that never saw anyone else get it), so two
  // studios that both lost the server (localhost + 127.0.0.1, two browsers) never both start
  const alone = () => !o.last || o.last.id === o.me ? W('me') : W(o.last.local ? 'pc' : 'other');
  if (o.bus === 'connecting') return W('waiting');
  // (a short drop is a reconnect, not a dead server: wait BUS_DOWN_MS — meanwhile the server may grant someone else)
  if (o.bus === 'down') return o.gone ? alone() : W('waiting');
  if (o.arbiter === 'no') return W('me');                    // no grant came in time: this window plays
  return o.arbiter === 'unknown' ? W('waiting') : granted();
}

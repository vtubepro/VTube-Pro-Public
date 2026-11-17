// The guest viewer's connection logic as a pure state machine (no DOM, no sockets, no timers: it returns the actions to do).
// view.html's link.ts executes them. Spec: docs/GUEST_BROWSER_SOURCE.md sections 6.1 and 6.2; tested in tools/guestfeed_view_unit.ts.
import { GS_HANDSHAKE_MS, GS_RETRY_MS, GS_SLOW_RETRY_MS, stateOfSide, type GsSideState, type GsViewerState } from '../../shared/guestFeed.ts';

export type FlowTimer = 'reconnect' | 'reoffer' | 'quiet' | 'handshake' | 'grace';
export type FlowAct =
  | { k: 'socket' }                              // open the relay socket now
  | { k: 'closeSocket' }
  | { k: 'offer'; fresh: boolean }               // fresh: a new peer connection + offer; else send the pending offer again
  | { k: 'closePc' }
  | { k: 'timer'; id: FlowTimer; ms: number }    // (re)start; the timer calls onTimer(id)
  | { k: 'clear'; id: FlowTimer };

/** No answer and no side-band for this long while the sender is there: it is asking its owner (spec 6.2). */
export const GS_QUIET_MS = 4000;
/** While "asking", the offer is repeated at least this often so Allow connects fast. */
export const GS_ASK_REOFFER_MS = 2000;
/** A "disconnected" peer connection gets this long to recover before a fresh offer. */
export const GS_GRACE_MS = 1500;
/** The relay drops a viewer socket that is silent for 2 minutes: send a harmless null candidate this often. */
export const GS_KEEPALIVE_MS = 45_000;
/** A socket that stayed up this long resets the growing retry delay. */
export const GS_STABLE_MS = 30_000;
export const TERMINAL: readonly GsViewerState[] = ['blocked', 'full', 'off'];

export const retryDelay = (n: number): number => GS_RETRY_MS[Math.min(GS_RETRY_MS.length - 1, Math.max(0, Math.floor(n)))];
const ALL_OFFER_TIMERS: FlowAct[] = [{ k: 'clear', id: 'reoffer' }, { k: 'clear', id: 'quiet' }, { k: 'clear', id: 'handshake' }, { k: 'clear', id: 'grace' }];

export class GsViewFlow {
  phase: GsViewerState = 'connecting';
  /** blocked / full / off: look again only every GS_SLOW_RETRY_MS */
  terminal = false;
  ready = false;
  /** relay says the sender (the gaming PC) is on the link: null = not known yet */
  senderHere: boolean | null = null;
  answered = false;
  open = false;
  hasPc = false;
  sideSeen = false;
  attempt = 0;
  offerN = 0;

  begin(): FlowAct[] { return [{ k: 'socket' }]; }

  onReady(peerHere: boolean): FlowAct[] {
    this.ready = true; this.senderHere = peerHere;
    if (peerHere) return this.offer();
    if (!this.terminal) this.phase = 'waiting';
    return [];
  }
  onPeer(here: boolean): FlowAct[] {
    this.senderHere = here;
    if (here) return this.open && this.answered ? [] : this.offer();
    this.answered = false; this.open = false; this.hasPc = false;
    if (!this.terminal) this.phase = 'waiting';
    return [...ALL_OFFER_TIMERS, { k: 'closePc' }];
  }
  onSide(s: GsSideState): FlowAct[] {
    this.sideSeen = true;
    const st = stateOfSide(s);
    if ((TERMINAL as readonly string[]).includes(st)) return this.stop(st as 'blocked' | 'full' | 'off');
    if (!this.answered) this.phase = st;
    return [];
  }
  onBye(): FlowAct[] { return this.terminal ? [] : this.stop('off'); }
  /** the data channel said {t:'off'} */
  onOffMsg(): FlowAct[] { return this.stop('off'); }
  onAnswer(): FlowAct[] {
    if (!this.hasPc) return [];
    // An answer is not a connection (AC28): with a TURN entry that never answers the sender still answers over the relay socket, and
    // the data channel never opens. So the answer only ends the question/blocked sentence ('connecting'); `live` is for the channel
    // opening (onChannelOpen). A viewer that already said "Couldn't connect" keeps saying it through every retry until then
    // (it used to flip failed -> live for 14 ms every 20 s and show nothing).
    this.answered = true; this.terminal = false;
    if (this.phase !== 'failed') this.phase = 'connecting';
    return [{ k: 'clear', id: 'reoffer' }, { k: 'clear', id: 'quiet' }, { k: 'timer', id: 'handshake', ms: GS_HANDSHAKE_MS }];
  }
  onChannelOpen(): FlowAct[] {
    this.open = true; this.attempt = 0; this.terminal = false; this.phase = 'live';
    return [{ k: 'clear', id: 'handshake' }, { k: 'clear', id: 'grace' }];
  }
  onPcState(st: string): FlowAct[] {
    if (st === 'connected') return [{ k: 'clear', id: 'grace' }];
    if (st === 'disconnected') return this.hasPc ? [{ k: 'timer', id: 'grace', ms: GS_GRACE_MS }] : [];
    if (st === 'failed') return this.pcFailed();
    return [];
  }
  /** `code`: the WebSocket close code (4409 = the relay holds its 4 viewer sockets already). */
  onSocketGone(code = 0): FlowAct[] {
    const was = this.ready;
    this.ready = false; this.senderHere = null;
    const acts: FlowAct[] = [{ k: 'clear', id: 'reoffer' }, { k: 'clear', id: 'quiet' }];
    if (this.terminal) return [...acts, { k: 'timer', id: 'reconnect', ms: GS_SLOW_RETRY_MS }];
    if (!was && code === 4409) return [...acts, ...this.stop('full')];
    if (!was) { if (!this.open) this.phase = 'noServer'; }
    else if (!this.open) this.phase = 'connecting';
    return [...acts, { k: 'timer', id: 'reconnect', ms: retryDelay(this.attempt++) }];
  }
  /** the socket stayed up for GS_STABLE_MS */
  onStable(): FlowAct[] { this.attempt = 0; return []; }

  onTimer(id: FlowTimer): FlowAct[] {
    switch (id) {
      case 'reconnect': return [{ k: 'socket' }];
      case 'reoffer': {
        if (this.answered || this.terminal || !this.senderHere || !this.hasPc) return [];
        this.offerN++;
        const ms = this.phase === 'asking' ? Math.min(retryDelay(this.offerN), GS_ASK_REOFFER_MS) : retryDelay(this.offerN);
        return [{ k: 'offer', fresh: false }, { k: 'timer', id: 'reoffer', ms }];
      }
      case 'quiet':
        if (!this.answered && this.senderHere && !this.sideSeen && !this.terminal && this.phase === 'connecting') this.phase = 'asking';
        return [];
      case 'handshake': {
        if (this.open) return [];
        if (!this.terminal) this.phase = 'failed';
        return this.restart();
      }
      case 'grace': return this.pcFailed();
    }
  }

  private offer(): FlowAct[] {
    this.offerN = 0; this.answered = false; this.open = false; this.sideSeen = false; this.hasPc = true;
    if (!this.terminal && this.phase !== 'failed') this.phase = 'connecting';
    return [{ k: 'offer', fresh: true }, { k: 'timer', id: 'reoffer', ms: retryDelay(0) }, { k: 'timer', id: 'quiet', ms: GS_QUIET_MS }];
  }
  private restart(): FlowAct[] {
    const acts: FlowAct[] = [...ALL_OFFER_TIMERS, { k: 'closePc' }];
    this.hasPc = false; this.open = false; this.answered = false;
    return this.senderHere ? [...acts, ...this.offer()] : acts;
  }
  private pcFailed(): FlowAct[] {
    if (!this.hasPc) return [];
    if (!this.terminal) this.phase = 'failed';
    return this.restart();
  }
  private stop(st: 'blocked' | 'full' | 'off'): FlowAct[] {
    this.terminal = true; this.phase = st;
    this.hasPc = false; this.answered = false; this.open = false; this.ready = false;
    return [...ALL_OFFER_TIMERS, { k: 'closePc' }, { k: 'closeSocket' }, { k: 'timer', id: 'reconnect', ms: GS_SLOW_RETRY_MS }];
  }
}

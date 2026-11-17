// DJ decks: which hand works which control right now (pure; the page's performer turns it into IK targets:
// src/scene/djdeck/deckPerformer.ts; tests: tools/djdeck_unit.ts).
//
// Rules (what a DJ's hands really do):
//  - a deck control is worked by that side's hand (left deck ↔ left hand); mixer controls by the nearer hand, or the
//    other one when the nearer hand is busy (scratching left while cutting the crossfader with the right);
//  - a hand stays on its control while the control is active (held, or moved within its hold time), so two moving
//    controls never ping-pong between hands; the newest control on a side wins that side's hand (after a short dwell);
//  - a hand with nothing to do goes back to the groove (the performer blends it out).
import { handFor, partFor, type PartKind, type RigLayout } from './layout.ts';

export type Hand = 'left' | 'right';
export interface HandPick { part: string | null; kind: PartKind | null; since: number; at: number }
/** How long a control keeps its hand after its last move (ms). */
export const HOLD_MS: Record<PartKind, number> = { jog: 450, tempo: 650, fader: 650, xfader: 650, knob: 600, encoder: 500, button: 320, pad: 300, lever: 420, meter: 0, screen: 0 };
/** A hand doesn't jump to a newer control on its side sooner than this after it got its current one (ms). */
export const DWELL_MS = 110;

interface Active { id: string; at: number; kind: PartKind; own: Hand | null; prefer: Hand }

export class HandPlanner {
  readonly hands: Record<Hand, HandPick> = { left: { part: null, kind: null, since: 0, at: 0 }, right: { part: null, kind: null, since: 0, at: 0 } };
  // (reused every frame: the page calls this once a frame)
  private active = new Map<string, Active>();
  private pool: Active[] = [];
  private order: Active[] = [];
  private next: Record<Hand, string | null> = { left: null, right: null };

  /** touches: part id → local ms of its last move; held: parts held down right now. Ids are mapped onto the layout's
   *  parts first (a control the layout doesn't show lands on its stand-in). */
  update(now: number, touches: Record<string, number> | Map<string, number>, held: Iterable<string>, layout: RigLayout): Record<Hand, HandPick> {
    const active = this.active;
    for (const a of active.values()) this.pool.push(a);
    active.clear();
    const heldSet = held instanceof Set ? held as Set<string> : new Set(held);
    const add = (id: string, at: number, isHeld: boolean) => {
      const p = partFor(layout, id); if (!p || p.kind === 'meter' || p.kind === 'screen') return;
      if (!isHeld && now - at > HOLD_MS[p.kind]) return;
      const t = isHeld ? Math.max(at, now - 1) : at;
      const prev = active.get(p.id);
      if (prev && t <= prev.at) return;
      const hf = handFor(p);
      const a = prev ?? this.pool.pop() ?? { id: '', at: 0, kind: p.kind, own: null, prefer: 'left' as Hand };
      a.id = p.id; a.at = t; a.kind = p.kind; a.own = hf.own; a.prefer = hf.prefer;
      active.set(p.id, a);
    };
    if (touches instanceof Map) { for (const [id, at] of touches) add(id, at, heldSet.has(id)); }
    else for (const id in touches) add(id, touches[id], heldSet.has(id));
    for (const id of heldSet) { const known = touches instanceof Map ? touches.has(id) : id in touches; if (!known) add(id, now - 1, true); }

    const next = this.next; next.left = null; next.right = null;
    // a) sticky: a hand keeps its control while that control is active
    if (this.hands.left.part && active.has(this.hands.left.part)) next.left = this.hands.left.part;
    if (this.hands.right.part && active.has(this.hands.right.part)) next.right = this.hands.right.part;
    // b) the rest, newest first
    const order = this.order; order.length = 0;
    for (const a of active.values()) if (a.id !== next.left && a.id !== next.right) order.push(a);
    order.sort((a, b) => b.at - a.at);
    for (const a of order) {
      const id = a.id;
      const other = (h: Hand): Hand => (h === 'left' ? 'right' : 'left');
      if (a.own) {
        const h = a.own, cur = next[h];
        if (!cur) { next[h] = id; continue; }
        const ca = active.get(cur)!;
        // the hand holds a mixer control the other hand could take: hand it over
        if (!ca.own && !next[other(h)]) { next[other(h)] = cur; next[h] = id; continue; }
        // a newer control on the same side wins the hand (after the dwell)
        if (a.at > ca.at && now - this.hands[h].since >= DWELL_MS && !heldSet.has(cur)) next[h] = id;
        continue;
      }
      const p = a.prefer, q = other(p);
      if (!next[p]) next[p] = id;
      else if (!next[q]) next[q] = id;
    }
    for (const h of ['left', 'right'] as const) {
      const id = next[h], cur = this.hands[h];
      if (id !== cur.part) { cur.part = id; cur.kind = id ? active.get(id)!.kind : null; cur.since = now; }
      cur.at = id ? active.get(id)!.at : cur.at;
    }
    return this.hands;
  }
}

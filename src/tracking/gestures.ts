// Hand gesture events from the Gesture Recognizer: debounced onsets ("held for a beat") + wave detection.
// Events drive fun stuff: emoji bursts at the avatar's hand and quick facial reactions.

import type { Side } from './bodySolver.ts';

export type GestureKind = 'thumbs_up' | 'thumbs_down' | 'peace' | 'love' | 'fist' | 'point' | 'wave' | 'palm';

export interface GestureEvent { id: number; kind: GestureKind; side: Side; t: number }

const MAP: Record<string, GestureKind> = {
  Thumb_Up: 'thumbs_up', Thumb_Down: 'thumbs_down', Victory: 'peace', ILoveYou: 'love',
  Closed_Fist: 'fist', Pointing_Up: 'point', Open_Palm: 'palm',
};

interface SideState { cur: GestureKind | null; since: number; fired: Map<GestureKind, number>; xs: { t: number; x: number }[] }

export class GestureDetector {
  private s: Record<Side, SideState> = {
    left: { cur: null, since: 0, fired: new Map(), xs: [] },
    right: { cur: null, since: 0, fired: new Map(), xs: [] },
  };
  private nextId = 1;
  /** Recent events (kept ~1.5 s so late subscribers like OBS still see them). */
  events: GestureEvent[] = [];
  holdSeconds = 0.2;
  cooldown = 1.4;

  /** Fire an event directly (UI test buttons, remote commands). */
  inject(kind: GestureKind, side: Side, t = performance.now() / 1000) {
    this.events.push({ id: this.nextId++, kind, side, t });
  }

  /** name: MediaPipe category name (or null), wristX: normalized image x of the wrist. */
  update(side: Side, name: string | null, score: number, wristX: number | null, t: number) {
    const st = this.s[side];
    const kind = name && score > 0.55 ? MAP[name] ?? null : null;
    if (kind !== st.cur) { st.cur = kind; st.since = t; }
    const fire = (k: GestureKind) => {
      const last = st.fired.get(k) ?? -99;
      if (t - last < this.cooldown) return;
      st.fired.set(k, t);
      this.events.push({ id: this.nextId++, kind: k, side, t });
    };
    if (kind && kind !== 'palm' && t - st.since >= this.holdSeconds) fire(kind);

    // wave: open palm + at least 3 direction reversals of wrist x within ~1.3 s
    if (wristX !== null && (kind === 'palm' || kind === null)) {
      st.xs.push({ t, x: wristX });
      while (st.xs.length && t - st.xs[0].t > 1.3) st.xs.shift();
      if (kind === 'palm' && st.xs.length > 8) {
        let rev = 0, lastDir = 0, lo = Infinity, hi = -Infinity;
        for (let i = 1; i < st.xs.length; i++) {
          const dx = st.xs[i].x - st.xs[i - 1].x;
          lo = Math.min(lo, st.xs[i].x); hi = Math.max(hi, st.xs[i].x);
          if (Math.abs(dx) < 0.002) continue;
          const dir = Math.sign(dx);
          if (lastDir && dir !== lastDir) rev++;
          lastDir = dir;
        }
        if (rev >= 3 && hi - lo > 0.04) { fire('wave'); st.xs = []; }
      }
    } else st.xs = [];
    this.events = this.events.filter((e) => t - e.t < 1.5);
  }
}

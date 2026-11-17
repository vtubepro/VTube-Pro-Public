// DJ decks: the host's room setting (SceneState.djdeck: every OBS page and party guest gets it with the scene).
export interface SceneDjDeckState {
  /** Show the DJ decks in front of the performer at the DJ spot. */
  on: boolean;
  /** 'auto' = look like my controller (a 4-channel controller layout for 4-channel controllers), 'cdj' = two players +
   *  a mixer, 'ctrl4' = a one-piece 4-channel controller. */
  look: 'auto' | 'cdj' | 'ctrl4';
  /** Spot index (0-based) for the decks; null = the room's DJ spot (club / festival booth), else where the host is. */
  spot: number | null;
  /** The performer's hands play what the controller does (off = the decks move by themselves, arms stay tracked). */
  hands: boolean;
  /** Between moves: a groove pose over the decks, or your tracked arms. */
  idle: 'groove' | 'tracked';
  /** A stand under the decks: 'auto' = only when the room has no surface there. */
  stand: 'auto' | 'on' | 'off';
  /** Nudges (m, at the performer's scale): higher / lower, nearer / further. */
  height: number;
  dist: number;
}
export const DEFAULT_DJDECK_STATE: SceneDjDeckState = { on: false, look: 'auto', spot: null, hands: true, idle: 'groove', stand: 'auto', height: 0, dist: 0 };

export function sanitizeDjDeckState(o: unknown): SceneDjDeckState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_DJDECK_STATE;
  const n = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  return {
    on: typeof x.on === 'boolean' ? x.on : d.on,
    look: x.look === 'cdj' || x.look === 'ctrl4' || x.look === 'auto' ? x.look : d.look,
    spot: typeof x.spot === 'number' && Number.isInteger(x.spot) && x.spot >= 0 && x.spot < 64 ? x.spot : null,
    hands: typeof x.hands === 'boolean' ? x.hands : d.hands,
    idle: x.idle === 'tracked' ? 'tracked' : 'groove',
    stand: x.stand === 'on' || x.stand === 'off' ? x.stand : 'auto',
    height: n(x.height, -0.25, 0.25, 0), dist: n(x.dist, -0.25, 0.25, 0),
  };
}

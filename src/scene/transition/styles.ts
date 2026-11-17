// Registry of room-change transition styles (src/scene/transition/*). The VTube Pro set ships with the engine.
import { curtainStyleId, type SceneCurtainState } from '../../../shared/curtain.ts';
import type { CurtainStyleDef } from './kit.ts';
import { VTP_STYLES } from './stylesVtp.ts';

export const CURTAIN_STYLES: CurtainStyleDef[] = [...VTP_STYLES];
/** Pseudo styles: no transition at all / a different style every change. */
export const CUT = 'cut';
export const SHUFFLE = 'shuffle';

export function curtainStyle(id: string): CurtainStyleDef {
  return CURTAIN_STYLES.find((s) => s.id === id) ?? CURTAIN_STYLES.find((s) => s.id === 'vtp-dark') ?? CURTAIN_STYLES[0];
}

/** The pool 'shuffle' cycles through: the host's pick, else the streamer's own themed set (else everything). */
export function shufflePool(st: SceneCurtainState): CurtainStyleDef[] {
  const pick = (st.pool ?? []).map((id) => CURTAIN_STYLES.find((s) => s.id === id)).filter((s): s is CurtainStyleDef => !!s);
  if (pick.length) return pick;
  const own = CURTAIN_STYLES.filter((s) => s.theme !== 'vtp');
  return own.length ? own : CURTAIN_STYLES;
}

/** The style a change plays (null = cut). `seq` picks the shuffle entry, so every page plays the same one. A room style
 *  the host stamped for this change (scene.json `curtain`, shared/curtain.ts stampRoomCurtain) comes first; one this
 *  page doesn't know falls back to the host's own style. */
export function resolveCurtainStyle(st: SceneCurtainState, seq: number): CurtainStyleDef | null {
  if (st.style === CUT) return null;
  const id = curtainStyleId(st, seq);
  if (id !== st.style) {
    if (id === CUT) return null;
    const own = CURTAIN_STYLES.find((s) => s.id === id);
    if (own) return own;
  }
  if (st.style === SHUFFLE) { const pool = shufflePool(st); return pool[((seq % pool.length) + pool.length) % pool.length]; }
  return curtainStyle(st.style);
}

/** Why the style of change `seq` plays: the destination's curtain.in ('in'), the left room's curtain.out ('out'), or
 *  the host's pick (null). */
export function curtainSide(st: SceneCurtainState, seq: number): 'in' | 'out' | null {
  const r = st.room;
  return r && r.seq === seq && st.style !== CUT && st.rooms !== false ? r.side : null;
}

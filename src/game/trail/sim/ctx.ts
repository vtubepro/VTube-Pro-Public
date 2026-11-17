// The Trail v2 — what the sim's sub-systems (camp.ts, memes.ts) may touch of the director (sim.ts). Getters: the
// physics world is replaced at every stop, so nothing here may be cached across steps.
import type { Rng } from '../../../../shared/trail/rng.ts';
import type { Deck, RunState } from '../../../../shared/trail/types.ts';
import type { TrailEvent } from '../../../../shared/trail/wire.ts';
import type { V3 } from '../../../../shared/trail/levels.ts';
import type { Journey } from './journey.ts';
import type { PhysWorld, PlayerPhys } from './world.ts';

export type FxKind = Extract<TrailEvent, { e: 'fx' }>['fx'];
export interface SimCtx {
  readonly phys: PhysWorld;
  readonly run: RunState;
  readonly deck: Deck;
  readonly journey: Journey;
  /** Sim seconds. */
  readonly time: number;
  /** Cosmetic randomness (not the run's event stream). */
  readonly misc: Rng;
  /** The run's event stream (rules effects). */
  readonly rng: Rng;
  emit(e: TrailEvent): void;
  toast(text: string, tone?: 'info' | 'good' | 'bad' | 'meme', who?: string): void;
  fx(fx: FxKind, at: V3, n?: number): void;
  nameOf(id: string): string;
  markDirty(): void;
  /** Players who are alive, not ghosts, not downed (their physics). */
  active(): PlayerPhys[];
  /** Is this player a bot (tests / fillers)? */
  isBot(id: string): boolean;
  /** Re-read the wagon's physical cargo into the run (after props left / were eaten). */
  recount(): void;
  syncAll(): void;
  /** Owned cargo lying around near the wagon goes back into the bed (packing up camp). */
  packUp(radius: number): number;
}

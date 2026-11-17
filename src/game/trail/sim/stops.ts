// The Trail v2 — the sim's side of the generated stops (trailstops): which run values feed the stop generator
// (shared/trail/stopgen.ts). One call from TrailSim.makeLevel; returns null for kinds that aren't generated (road, camp,
// the journey), which then take the old path (theme-pack GLB or grey-box).
import { routeOf } from '../../../../shared/trail/rules.ts';
import { GEN_KINDS, biomeFor, genStop, type GenKind } from '../../../../shared/trail/stopgen.ts';
import type { LevelDesc } from '../../../../shared/trail/levels.ts';
import type { Deck, RouteNode, RunState } from '../../../../shared/trail/types.ts';

export interface StopCtx { seed: string; deck: Deck; run: RunState | null; node: RouteNode | null; lobby: boolean; hunts: number }

export function genStopFor(kind: string, c: StopCtx): LevelDesc | null {
  if (!GEN_KINDS.includes(kind)) return null;
  const { deck, run } = c;
  const route = run ? routeOf(run, deck) : deck.route;
  const total = route[route.length - 1]?.miles || 1;
  const miles = run?.miles ?? 0;
  const bio = biomeFor(deck.biomes, Math.max(0, Math.min(1, miles / total)));
  // the place: the route node (so a fort's store, a named river, a landmark differ from each other and between runs);
  // hunts happen anywhere, so they key on how many hunts this run had + where
  const nodeId = kind === 'hunt' ? `hunt:${c.hunts}:${Math.round(miles)}` : c.lobby || !c.node ? 'start' : c.node.id;
  const d = genStop(kind as GenKind, {
    seed: c.seed, node: nodeId, theme: deck.id, biome: bio.id, biomeIdx: bio.idx, palette: deck.palette,
    river: kind === 'river' ? run?.river ?? null : null,
    animals: deck.animals as Record<string, { count: number; kg?: number; danger?: number; grabs?: string }>,
    name: c.node?.name, storeName: deck.text.storeName, fort: kind === 'store' && c.node?.kind === 'fort',
  });
  if (c.lobby) d.items = [];
  return d;
}

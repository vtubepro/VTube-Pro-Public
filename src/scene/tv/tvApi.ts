// Public API of TV performers for other scene code (modes, interview monitors, gaming strip, TTRPG, the Trail game,
// buddies). Documented in S\tv\PERFORMER_API.md — keep both in step.
import * as THREE from 'three';
import type { SceneActor } from '../actor.ts';
import type { TvFeedState, TvInfo } from '../../../shared/tv.ts';
import { TvScreenMaterial, type ScreenFxKind } from './tvScreen.ts';
import { TV_REACTIONS, type TvReaction } from './tvAnim.ts';
import { isTvRuntime, type TvRuntime } from './tvRuntime.ts';
import { pageFeeds } from './tvFeeds.ts';
import { tvPage } from './tvPage.ts';

export { isTvRuntime, TV_REACTIONS };
export type { TvRuntime, TvReaction };

/** The actor's TvRuntime, or null for a normal avatar. */
export function tvOfActor(a: SceneActor | null | undefined): TvRuntime | null {
  const rt = a?.runtime as unknown;
  return isTvRuntime(rt) ? rt : null;
}

/** Play a reaction on a TV performer. false = not a TV (use your avatar / emote path). */
export function tvReact(a: SceneActor | TvRuntime | null | undefined, clip: TvReaction): boolean {
  const rt = isTvRuntime(a) ? a : tvOfActor(a as SceneActor);
  return rt ? rt.react(clip) : false;
}

export interface TvFeedView { texture: THREE.Texture | null; aspect: number; state: TvFeedState; level: number; stream: MediaStream | null; tv: TvInfo | null }

/** A member's live feed by scene member key ('@host' / party id). null = not a TV (or not on this page). */
export function tvFeedOf(key: string): TvFeedView | null {
  const id = tvPage.feedIdByKey(key);
  if (!id) return null;
  const f = pageFeeds.get(id);
  const rt = tvPage.runtimeByKey(key);
  // (a packed Spout2 frame: the picture is its colour half — use tvFeedMaterial to show it, never the raw texture)
  const pack = rt?.tv.pack;
  return { texture: f?.ready ? f.texture : null, aspect: f ? f.aspect * (pack ? pack.c : 1) : rt?.tv.aspect ?? 4 / 3, state: f?.state ?? 'none', level: pageFeeds.level(id), stream: f?.stream ?? null, tv: rt?.tv ?? null };
}

/** A material showing member `key`'s live picture with THEIR chroma key + backdrop, cover-fit to your mesh's UVs.
 *  fx 'clean' (monitors, strips) or 'tv' (scanlines / curvature like their set). It redraws itself every frame it is
 *  rendered; `material.userData.setAspect(w / h)` = your surface's aspect. Dispose it when done (the video is shared). */
export function tvFeedMaterial(key: string, o: { fx?: ScreenFxKind; aspect?: number } = {}): THREE.ShaderMaterial | null {
  const id = tvPage.feedIdByKey(key);
  const rt = tvPage.runtimeByKey(key);
  if (!id || !rt) return null;
  const sm = new TvScreenMaterial(rt.tv, o.aspect ?? 16 / 9, o.fx ?? 'clean');
  let last = performance.now();
  sm.material.onBeforeRender = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const f = pageFeeds.get(id);
    f?.poll();
    sm.setInfo(rt.tv, o.fx ?? 'clean');
    sm.setMap(f?.ready ? f.texture : null, f?.aspect ?? null, f?.size);
    sm.step(dt, now / 1000, f ? f.state : 'none');
  };
  const dispose = sm.material.dispose.bind(sm.material);
  sm.material.dispose = () => { sm.material.onBeforeRender = () => {}; dispose(); };
  return sm.material;
}

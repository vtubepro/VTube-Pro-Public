// Extra light-shaft (god ray) sources for the Ultra light shafts (Graphics.shaftPoints): any layer may register a
// function returning screen points (uv 0..1) + weights — e.g. the environment's sun (src/scene/environment). Kept here
// so the graphics layer never imports the scene engine.
import type * as THREE from 'three';

export type ShaftSource = (cam: THREE.PerspectiveCamera) => { x: number; y: number; w: number }[];
export const shaftSources = new Set<ShaftSource>();

/** Optional haze override (High / Ultra glowing haze): the environment tints it with the time of day / fog. Called with the
 *  room look's haze each frame; mutate it in place (colour / density / glow). */
export const hazeHook: { fn: ((h: { color: THREE.Color; density: number; glow: number }) => void) | null } = { fn: null };

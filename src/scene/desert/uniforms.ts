// Shared uniform objects: one CPU write per frame drives every desert material (terrain, props, far layers, sky, dust).
// Materials spread these objects into their own `uniforms` (by reference), so nothing is copied per material.
import * as THREE from 'three';
import { CORRIDOR_N, MAX_FLATS, SITE_COUNT, type DesertWorldSpec, type LocalCtx } from '../../../shared/desert/height.ts';
import { MAX_FIRES } from './glsl.ts';

export type HeightUniforms = ReturnType<typeof makeHeightUniforms>;
export type DesertUniforms = ReturnType<typeof makeDesertUniforms>;

export function makeHeightUniforms(spec: DesertWorldSpec) {
  return {
    uSeed: { value: spec.seed >>> 0 },
    uOff: { value: Array.from({ length: SITE_COUNT }, () => new THREE.Vector2()) },
    uOffI: { value: new Int32Array(SITE_COUNT * 2) },
    uPhase: { value: new THREE.Vector4() },
    uWindCS: { value: new THREE.Vector2(spec.c, spec.s) },
    uPoly: { value: Array.from({ length: CORRIDOR_N }, () => new THREE.Vector2()) },
    uCorr: { value: spec.corridor ? 1 : 0 },
    uRelief: { value: spec.relief },
    uFlats: { value: Array.from({ length: MAX_FLATS }, () => new THREE.Vector4()) },
    uFlatN: { value: 0 },
  };
}

/** Copy a LocalCtx (float64) into the height uniforms (float32). */
export function writeHeightUniforms(u: HeightUniforms, spec: DesertWorldSpec, ctx: LocalCtx) {
  for (let k = 0; k < SITE_COUNT; k++) {
    const ix = Math.floor(ctx.off[2 * k]), iz = Math.floor(ctx.off[2 * k + 1]);
    u.uOffI.value[2 * k] = ix; u.uOffI.value[2 * k + 1] = iz;
    u.uOff.value[k].set(ctx.off[2 * k] - ix, ctx.off[2 * k + 1] - iz);
  }
  u.uPhase.value.set(ctx.phase[0], ctx.phase[1], ctx.phase[2], ctx.phase[3]);
  for (let i = 0; i < CORRIDOR_N; i++) u.uPoly.value[i].set(ctx.poly[2 * i], ctx.poly[2 * i + 1]);
  u.uCorr.value = spec.corridor ? 1 : 0;
  u.uRelief.value = spec.relief;
  writeFlatUniforms(u, ctx);
  u.uWindCS.value.set(spec.c, spec.s);
  u.uSeed.value = spec.seed >>> 0;
}

/** Only the flatten discs (runtime setFlats): ctx.flats are terrain-local. */
export function writeFlatUniforms(u: HeightUniforms, ctx: LocalCtx) {
  const n = Math.min(MAX_FLATS, ctx.flats.length);
  u.uFlatN.value = n;
  for (let i = 0; i < n; i++) { const fl = ctx.flats[i]; u.uFlats.value[i].set(fl.x, fl.z, fl.r, fl.h); }
}

export function makeDesertUniforms() {
  return {
    uCamT: { value: new THREE.Vector3() },
    uSunT: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSkyAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
    uGndAmb: { value: new THREE.Color(0.25, 0.18, 0.12) },
    uHazeCol: { value: new THREE.Color(0.8, 0.7, 0.55) },
    uHazeSun: { value: new THREE.Color(1, 0.85, 0.6) },
    uFog: { value: new THREE.Vector4(2e-4, 180, 0, 1) },
    uStorm: { value: 0 },
    uDayK: { value: 1 },
    uDark: { value: 0 },
    uTime: { value: 0 },
    uWindT: { value: new THREE.Vector2(1, 0) },
    uQ: { value: 2 },
    uFlash: { value: new THREE.Color(0, 0, 0) },
    uAnc: { value: new THREE.Vector4() },
    uAncPh: { value: 0 },
    uAerial: { value: new THREE.Vector4(1, 1, 900, 2600) },
    uFires: { value: Array.from({ length: MAX_FIRES }, () => new THREE.Vector4()) },
    uFireCol: { value: new THREE.Color(0, 0, 0) },
  };
}

// Desert sky dome: sky gradient, sun disc + glow, moon, stars, thin drifting cirrus, the distant mountain / mesa
// silhouette ring (> 40 km: 1D ridged noise of WORLD azimuth, so it turns correctly as the route bends), the far-ground
// band below the horizon (lit flat sand + the same aerial perspective as the terrain, so the terrain's far edge
// vanishes into it), and the sandstorm dust (ochre, turbulent, sun reduced to a pale disc). One draw on the far plane.
// Directions are rotated room -> world by the desert group's rotation (uRoomToW), so the sky tilts and turns with the
// ground exactly.
import * as THREE from 'three';
import { DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL } from './glsl.ts';
import type { DesertUniforms } from './uniforms.ts';

const VS = /* glsl */ `
uniform mat3 uRoomToW;
varying vec3 vDirW;
void main() {
  vDirW = uRoomToW * position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FS = /* glsl */ `
${DESERT_UNIFORMS}
uniform vec3 uZenith; uniform vec3 uHorizon;
uniform vec3 uSunW; uniform vec3 uSunDisc; uniform float uSunVis;
uniform vec3 uMoonW; uniform float uMoonVis;
uniform float uStars;
uniform vec3 uDust;
uniform vec3 uFarGround;
uniform float uGroundY;      // terrain-local y of the ground plane far away
uniform vec3 uMtnNear; uniform vec3 uMtnFar;
uniform float uCirrus;
uniform float uSeedF;
uniform float uAlpha;
varying vec3 vDirW;
${NOISE_GLSL}
${SHADE_GLSL}
float ridge(float az, float f, float seed) {
  vec2 c = vec2(cos(az), sin(az)) * f + seed;
  float n = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { n += a * (1.0 - abs(2.0 * vnf(c) - 1.0)); c = c * 2.07 + 3.1; a *= 0.5; }
  return n;
}
void main() {
  vec3 d = normalize(vDirW);
  float up = d.y;
  float az = atan(d.x, -d.z);
  float t = clamp(up, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(t, 0.38));
  float sd = dot(d, uSunW);
  // golden glow on the sun side of the horizon
  col += uSunDisc * pow(max(sd, 0.0), 5.0) * 0.32 * uSunVis * (1.0 - t * 0.6);
  // stars + milky band
  if (uStars > 0.001 && up > 0.0) {
    vec2 st = d.xz / (1.0 + up);                 // stereographic: continuous all round (no azimuth seam)
    vec2 cell = floor(st * 260.0);
    float h = hf(cell);
    float tw = 0.5 + 0.5 * sin(uTime * (1.2 + h * 3.0) + h * 40.0);
    // (a round point inside its cell, off-centre by hash: a whole-cell star read as a square at 1080p)
    vec2 fc = fract(st * 260.0) - 0.5 - (vec2(hf(cell + 3.1), hf(cell + 5.7)) - 0.5) * 0.5;
    float dotK = smoothstep(0.22, 0.04, length(fc));
    col += vec3(0.9, 0.95, 1.0) * step(0.9968, h) * dotK * tw * uStars * 1.6 * smoothstep(0.02, 0.25, up);
    col += vec3(0.25, 0.26, 0.42) * uStars * 0.08 * vnf(st * 4.0 + 3.0);
  }
  // sun + moon discs
  float disc = smoothstep(0.99955, 0.99975, sd);
  col += uSunDisc * (disc * 2.2 + pow(max(sd, 0.0), 160.0) * 0.8) * uSunVis;
  float md = dot(d, uMoonW);
  col = mix(col, vec3(0.86, 0.9, 1.0), smoothstep(0.99925, 0.99945, md) * uMoonVis);
  col += vec3(0.6, 0.66, 0.85) * pow(max(md, 0.0), 90.0) * 0.16 * uMoonVis;
  // thin cirrus, world-fixed, drifting with the wind
  if (uCirrus > 0.01 && up > 0.0) {
    vec2 q = d.xz / (up + 0.12) * 0.35 + uWindT * uTime * 0.0004;
    float n = vnf(q * vec2(1.0, 6.0) + vnf(q * 3.0) * 1.5) * vnf(q * 0.6 + 7.0);
    float a = smoothstep(0.32, 0.7, n) * uCirrus * smoothstep(0.0, 0.15, up) * (0.25 + 0.75 * uDayK);
    vec3 cc = mix(uHorizon * 1.08, uSunDisc * 0.9 + uHorizon * 0.3, pow(max(sd, 0.0), 3.0) * 0.6 * uDayK);
    col = mix(col, cc, a * 0.55);
  }
  // distant ranges: far (bluish, very hazy) then nearer (ochre-violet) silhouettes standing on the horizon
  float eFar = 0.010 + 0.022 * ridge(az, 2.2, uSeedF) * smoothstep(0.15, 0.9, vnf(vec2(cos(az), sin(az)) * 1.3 + uSeedF + 9.0));
  float eNear = 0.004 + 0.03 * pow(ridge(az, 4.0, uSeedF + 21.0), 1.6) * smoothstep(0.35, 0.85, vnf(vec2(cos(az), sin(az)) * 2.1 + uSeedF + 4.0));
  float aa = 0.0015;
  if (up > -0.02) {
    float mf = smoothstep(eFar + aa, eFar - aa, up);
    col = mix(col, mix(uMtnFar, uHorizon, 0.25 + 0.6 * clamp(up / max(eFar, 1e-3), 0.0, 1.0) * 0.4), mf);
    float mn = smoothstep(eNear + aa, eNear - aa, up);
    float lit = clamp(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunW.x, 0.0, uSunW.z))) * 0.5 + 0.5, 0.0, 1.0);
    col = mix(col, uMtnNear * (0.8 + 0.35 * lit), mn);
  }
  // below the horizon: lit flat sand far away + the same aerial perspective as the terrain
  if (up < 0.0) {
    float camH = max(1.0, uCamT.y - uGroundY);
    float D = min(camH / max(-up, 1e-5), 60000.0);
    vec3 p = uCamT + d * D;
    vec3 g = mix(uFarGround, uHorizon, 0.0);
    g = mix(g, dHaze(d), dFogAmt(uCamT, p));
    col = mix(col, g, smoothstep(0.0, -0.0012, up));
  }
  // sandstorm: ochre, turbulent, brighter towards the sun
  if (uStorm > 0.001) {
    vec2 ring = vec2(cos(az), sin(az)) * 3.0;
    vec2 q = ring + vec2(up * 6.0 - uTime * 0.05, up * 4.0);
    float n = vnf(q + vnf(q * 2.3 + uTime * 0.11) * 2.0) * 0.6 + vnf(q * 4.0 - uTime * 0.3) * 0.4;
    vec3 dc = uDust * (0.75 + 0.45 * n) + uSunDisc * pow(max(sd, 0.0), 8.0) * 0.4 * (1.0 - uStorm * 0.5);
    col = mix(col, dc, smoothstep(0.0, 1.0, uStorm) * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.6, up))));
  }
  col += uFlash * 0.12;
  gl_FragColor = vec4(col, uAlpha);
  #include <colorspace_fragment>
}`;

export class DesertSky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly u: Record<string, THREE.IUniform>;

  constructor(du: DesertUniforms, seed: number) {
    this.u = {
      ...du,
      uRoomToW: { value: new THREE.Matrix3() },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSunW: { value: new THREE.Vector3(0, 1, 0) }, uSunDisc: { value: new THREE.Color() }, uSunVis: { value: 1 },
      uMoonW: { value: new THREE.Vector3(0, -1, 0) }, uMoonVis: { value: 0 }, uStars: { value: 0 },
      uDust: { value: new THREE.Color() }, uFarGround: { value: new THREE.Color() }, uGroundY: { value: 0 },
      uMtnNear: { value: new THREE.Color() }, uMtnFar: { value: new THREE.Color() },
      uCirrus: { value: 0.35 }, uSeedF: { value: (seed % 997) * 0.731 }, uAlpha: { value: 1 },
    };
    const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false });
    m.name = 'vtp:desert:sky';
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), m);
    this.mesh.name = 'vtp:desert:sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -999;     // after the environment's dome (-1000): the desert sky wins when both are on
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

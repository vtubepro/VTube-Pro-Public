// Procedural sky dome (cel-friendly): horizon → zenith gradient, sun disc + glow, moon, twinkling stars, a drifting
// banded cloud deck (fbm; coverage / storm darkness from the weather; lit from the sun side), lightning lighting the
// clouds from inside. One draw at the far plane behind everything (depth write off, fog off), following the camera.
// Octaves scale with the graphics level (uniform — no recompiles).
import * as THREE from 'three';

const VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;                // on the far plane
}`;

const FS = /* glsl */ `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform float uSunVis;
uniform vec3 uMoonDir; uniform vec3 uMoonCol; uniform float uMoonVis;
uniform float uStars; uniform float uT;
uniform float uCloud; uniform float uCloudDark; uniform vec3 uCloudLit; uniform vec3 uCloudShade; uniform vec2 uDrift; uniform int uOct;
uniform float uFlash; uniform vec3 uFlashDir; uniform float uHaze; uniform vec3 uHazeCol; uniform float uAlpha;
varying vec3 vDir;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 6; i++) { if (i >= uOct) break; s += a * n2(p); n += a; p = p * 2.03 + vec2(11.7, 5.3); a *= 0.5; } return s / max(n, 1e-3); }
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  float t = clamp(up, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(t, 0.5));
  // a warm glow on the sun side of the horizon (golden hour)
  float sd = dot(d, uSunDir);
  col += uSunCol * pow(max(sd, 0.0), 6.0) * 0.35 * uSunVis * (1.0 - t * 0.6);
  if (up < 0.0) col = mix(uHorizon, uGround, smoothstep(0.0, 0.25, -up));
  // stars
  if (uStars > 0.001 && up > 0.0) {
    vec2 cell = floor(vec2(atan(d.z, d.x) * 190.0, up * 260.0));
    float h = h21(cell);
    float tw = 0.5 + 0.5 * sin(uT * (1.2 + h * 3.0) + h * 40.0);
    col += vec3(0.9, 0.95, 1.0) * step(0.9968, h) * tw * uStars * smoothstep(0.03, 0.3, up);
    col += vec3(0.25, 0.28, 0.45) * uStars * 0.06 * n2(vec2(atan(d.z, d.x) * 3.0, up * 6.0));    // faint milky band
  }
  // sun + moon discs (behind the clouds)
  float disc = smoothstep(0.99955, 0.99975, sd);
  col += uSunCol * (disc * 2.2 + pow(max(sd, 0.0), 180.0) * 0.8) * uSunVis;
  float md = dot(d, uMoonDir);
  float moon = smoothstep(0.99925, 0.99945, md);
  col = mix(col, uMoonCol * 1.1, moon * uMoonVis);
  col += uMoonCol * pow(max(md, 0.0), 90.0) * 0.18 * uMoonVis;
  // clouds: a flat deck projected on the dome, drifting with the wind
  if (uCloud > 0.01 && up > -0.02) {
    vec2 q = d.xz / (max(up, 0.0) + 0.11) * 0.55 + uDrift;
    float n = fbm(q);
    float c = uCloud;
    float lo = 0.78 - c * 0.62, hi = lo + 0.16 + c * 0.1;
    float a = smoothstep(lo, hi, n);
    // light from the sun side: brighter where the noise falls towards the sun
    vec2 sq = normalize(uSunDir.xz + vec2(1e-4)) * 0.09;
    float lit = clamp((n - fbm(q + sq)) * 4.0 + 0.55, 0.0, 1.0);
    lit = floor(lit * 3.0 + 0.5) / 3.0;                              // cel bands
    vec3 cc = mix(uCloudShade, uCloudLit, lit);
    cc += uSunCol * pow(max(sd, 0.0), 12.0) * 0.5 * uSunVis * (1.0 - a * 0.6);   // silver lining
    // storm: thick, dark underside
    cc = mix(cc, uCloudShade * 0.7, uCloudDark * smoothstep(0.4, 1.0, n) * 0.6);
    // lightning lights the clouds from inside
    float fl = uFlash * (0.35 + 0.65 * pow(max(dot(d, uFlashDir), 0.0), 3.0));
    cc += vec3(0.75, 0.8, 1.0) * fl * (0.5 + n);
    float fade = smoothstep(-0.02, 0.12, up);
    col = mix(col, cc, a * fade * (0.55 + 0.45 * smoothstep(0.0, 0.6, c)));
    col += vec3(0.6, 0.66, 0.8) * fl * 0.15 * (1.0 - a);
  } else col += vec3(0.6, 0.66, 0.8) * uFlash * 0.12;
  // horizon haze (fog weather)
  col = mix(col, uHazeCol, uHaze * (1.0 - smoothstep(0.0, 0.35 + uHaze * 0.4, abs(up))));
  gl_FragColor = vec4(col, uAlpha);
  #include <colorspace_fragment>
}`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly u = {
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uSunVis: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonCol: { value: new THREE.Color(0.8, 0.86, 1) }, uMoonVis: { value: 0 },
    uStars: { value: 0 }, uT: { value: 0 },
    uCloud: { value: 0 }, uCloudDark: { value: 0 }, uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
    uDrift: { value: new THREE.Vector2() }, uOct: { value: 5 },
    uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() }, uHaze: { value: 0 }, uHazeCol: { value: new THREE.Color() },
    uAlpha: { value: 1 },
  };

  constructor() {
    const g = new THREE.SphereGeometry(10, 48, 24);
    const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false });
    m.name = 'vtp:env:sky';
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'vtp:env:sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

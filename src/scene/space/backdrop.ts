// The view out of the viewport: a starfield + nebula sky with the sun (one sphere + one Points draw that follow the
// camera), the planet (procedural continents / clouds / night lights, war zones with artillery flashes, fires, smoke,
// tracers and dropship lights, and up to 48 timed impacts — shell flashes, shockwave rings, laser scars, drop-pod
// landings — all in ONE shader), its atmosphere and a moon. No textures, no render targets, no post.
import * as THREE from 'three';
import { Rng } from '../raid/rng.ts';
import type { SpaceRoom } from './spaceRoom.ts';

export const MAX_IMPACTS = 48;
export const MAX_ZONES = 6;
/** Impact kinds (planet shader): shell, hellbomb, laser burn, drop pod, rail (blue), strafe bomb. */
export const IMPACT = { shell: 0, hellbomb: 1, laser: 2, pod: 3, rail: 4, strafe: 5 } as const;

const NOISE = /* glsl */ `
float h31(vec3 p) { p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h21(vec2 p) { p = fract(p * vec2(0.3183099, 0.3678794) + vec2(0.11, 0.17)); p *= 17.0; return fract(p.x * p.y * (p.x + p.y)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
`;

// ---------------------------------------------------------------- sky
const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vDir = wp.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const SKY_FS = /* glsl */ `
uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uBand; uniform float uDetail;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float band = exp(-pow(dot(d, uBand) / 0.32, 2.0));
  vec3 col = vec3(0.006, 0.008, 0.016) + vec3(0.01, 0.012, 0.022) * band;
  if (uDetail > 0.5) {
    float n = fbm(d * 2.2 + vec3(3.0), 4);
    float m = fbm(d * 4.1 + vec3(7.0, 1.0, 2.0), 3);
    col += vec3(0.05, 0.018, 0.07) * smoothstep(0.45, 0.8, n) * (0.4 + band);
    col += vec3(0.0, 0.035, 0.05) * smoothstep(0.5, 0.85, m) * (0.3 + band) ;
    col *= 1.0 - 0.5 * smoothstep(0.55, 0.75, fbm(d * 9.0, 2)) * band;   // dust lanes
  }
  float s = max(dot(d, uSun), 0.0);
  col += uSunCol * (pow(s, 2400.0) * 6.0 + pow(s, 180.0) * 0.5 + pow(s, 12.0) * 0.05);
  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>
}`;
const STAR_VS = /* glsl */ `
attribute float aSize; attribute vec3 aCol; attribute float aPh;
uniform float uTime; uniform float uPx;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.75 + 0.25 * sin(uTime * (1.3 + aPh) + aPh * 20.0);
  vCol = aCol * tw;
  gl_PointSize = aSize * uPx;
}`;
const STAR_FS = /* glsl */ `
varying vec3 vCol;
void main() { vec2 c = gl_PointCoord - 0.5; float r = length(c); float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(vCol * a, 1.0); 
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- planet
const PLANET_VS = /* glsl */ `
varying vec3 vN; varying vec3 vWN; varying vec3 vWP;
void main() {
  vN = normalize(position);
  vWN = normalize(mat3(modelMatrix) * position);
  vec4 wp = modelMatrix * vec4(position, 1.0); vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const PLANET_FS = /* glsl */ `
uniform vec3 uSun; uniform float uTime; uniform float uCloudT; uniform float uDetail; uniform float uCombat; uniform float uMoon;
uniform vec3 uPal[8];
uniform vec4 uZones[${MAX_ZONES}]; uniform int uZoneN;
uniform vec4 uImpA[${MAX_IMPACTS}]; uniform vec4 uImpB[${MAX_IMPACTS}]; uniform int uImpN;
uniform vec3 uAtmo; uniform mat3 uFrame; uniform float uOverlay;
varying vec3 vN; varying vec3 vWN; varying vec3 vWP;
${NOISE}
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
void main() {
  vec3 N0 = normalize(vN);
  vec3 N = uFrame * N0;              // surface pattern frame (the pole away from the viewer)
  vec3 WN = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  float ndl = dot(WN, uSun);
  int oct = uDetail > 0.5 ? 5 : 3;
  vec3 alb; float land = 0.0;
  if (uMoon > 0.5) {
    float c = fbm(N * 3.0, oct);
    float cr = fbm(N * 9.0 + 4.0, 3);
    alb = mix(vec3(0.34, 0.33, 0.32), vec3(0.55, 0.53, 0.5), c) * (0.8 + 0.4 * smoothstep(0.35, 0.65, cr));
    alb *= 1.0 - 0.35 * smoothstep(0.62, 0.7, fbm(N * 5.0 + 9.0, 2));
  } else {
    vec3 q = vec3(fbm(N * 1.6, 3), fbm(N * 1.6 + 5.2, 3), fbm(N * 1.6 + 9.1, 3));
    float c = fbm(N * 2.4 + q * 1.4, oct);
    float m = fbm(N * 3.3 + 7.0, 3);
    float lat = abs(N.y);
    land = smoothstep(0.43, 0.47, c);
    vec3 sea = mix(uPal[0], uPal[1], smoothstep(0.33, 0.45, c));
    vec3 ground = mix(uPal[2], uPal[3], smoothstep(0.35, 0.65, m));
    ground = mix(ground, uPal[4], smoothstep(0.58, 0.7, c));
    ground = mix(ground, uPal[5], smoothstep(0.55, 0.7, m) * smoothstep(0.55, 0.6, c) * 0.7);   // alien growth / bug creep
    alb = mix(sea, ground, land);
    alb *= 0.85 + 0.3 * fbm(N * 22.0, uDetail > 0.5 ? 3 : 1);
    alb = mix(alb, uPal[6], smoothstep(0.78, 0.9, lat + 0.08 * (m - 0.5)));
  }
  vec3 emis = vec3(0.0);
  float night = 1.0 - smoothstep(-0.12, 0.12, ndl);
  // ---- war zones: burnt ground, smoke, fires, artillery flashes, tracers, dropship lights
  if (uMoon < 0.5 && uCombat > 0.0) {
    for (int i = 0; i < ${MAX_ZONES}; i++) {
      if (i >= uZoneN) break;
      vec3 zd = uZones[i].xyz; float zr = uZones[i].w;
      float dz = length(N0 - zd);
      if (dz > zr * 1.3) continue;
      float mask = smoothstep(zr, zr * 0.35, dz) * uCombat;
      vec3 t1 = normalize(cross(zd, abs(zd.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
      vec3 t2 = cross(zd, t1);
      vec2 uv = vec2(dot(N0, t1), dot(N0, t2)) / zr;
      float burn = fbm(N * 40.0 + float(i) * 3.1, 3);
      alb *= 1.0 - 0.55 * mask * smoothstep(0.35, 0.65, burn);
      float smoke = fbm(N * 18.0 + vec3(uTime * 0.01, 0.0, float(i)), 3);
      // fires
      float fire = smoothstep(0.7, 0.8, fbm(N * 70.0 + float(i), 2)) * mask;
      emis += vec3(1.0, 0.35, 0.06) * fire * (0.6 + 0.4 * sin(uTime * 7.0 + burn * 40.0)) * (0.25 + 0.75 * night);
      // artillery / explosions: a flash now and then in a grid of cells
      vec2 g = uv * 16.0; vec2 cell = floor(g); vec2 fr = fract(g) - 0.5;
      float hs = h21(cell + float(i) * 37.0);
      float per = 1.2 + hs * 5.0;
      float ph = fract(uTime / per + hs * 7.13);
      vec2 off = vec2(h21(cell + 3.1), h21(cell + 8.7)) - 0.5;
      float dot_ = smoothstep(0.22, 0.0, length(fr - off * 0.6));
      float fl = hs > 0.35 ? exp(-ph * 22.0) : 0.0;
      emis += vec3(1.0, 0.75, 0.45) * fl * dot_ * mask * 4.0;
      // tracer streams: moving dashes across the zone
      vec2 g2 = uv * 9.0 + vec2(3.3, 1.7); vec2 c2 = floor(g2); vec2 f2 = fract(g2) - 0.5;
      float h2 = h21(c2 + float(i) * 11.0);
      if (h2 > 0.55) {
        float ang = h2 * 40.0; vec2 dir = vec2(cos(ang), sin(ang));
        float along = dot(f2, dir), across = dot(f2, vec2(-dir.y, dir.x));
        float head = fract(uTime * (0.6 + h2) + h2 * 9.0) - 0.5;
        float tr = smoothstep(0.03, 0.0, abs(across)) * smoothstep(0.12, 0.0, abs(along - head)) * step(0.5, fract(uTime * 0.7 + h2 * 3.0));
        emis += vec3(1.0, 0.85, 0.35) * tr * mask * 2.5;
      }
      // dropship lights drifting over the zone
      float dl = smoothstep(0.035, 0.0, length(uv - vec2(sin(uTime * 0.05 + float(i) * 2.0), cos(uTime * 0.043 + float(i))) * 0.6)) * step(0.4, fract(uTime * 1.3));
      emis += vec3(0.8, 0.9, 1.0) * dl * mask * 3.0;
      alb = mix(alb, vec3(0.16, 0.15, 0.14), mask * 0.55 * smoothstep(0.45, 0.75, smoke));
    }
  }
  // night lights (settlements / fires far from the zones)
  if (uMoon < 0.5) emis += vec3(1.0, 0.62, 0.25) * smoothstep(0.74, 0.8, fbm(N * 48.0 + 2.0, 2)) * land * night * 0.35;
  // ---- timed impacts
  vec3 scorch = vec3(0.0);
  for (int i = 0; i < ${MAX_IMPACTS}; i++) {
    if (i >= uImpN) break;
    vec4 A = uImpA[i]; vec4 B = uImpB[i];
    float age = A.w, sz = B.x, kind = B.y, dur = B.z;
    float d = length(N0 - A.xyz);
    if (d > sz * (4.0 + age * 3.0)) continue;
    float life = clamp(1.0 - age / dur, 0.0, 1.0);
    vec3 hot = kind > 3.5 && kind < 4.5 ? vec3(0.6, 0.85, 1.0) : vec3(1.0, 0.8, 0.45);
    float flash = exp(-age * (kind > 0.5 && kind < 1.5 ? 1.4 : 4.0)) * exp(-pow(d / (sz * (kind > 0.5 && kind < 1.5 ? 1.6 : 1.0)), 2.0) * 1.5);
    float rr = sz * (0.4 + age * (kind > 0.5 && kind < 1.5 ? 2.2 : 1.4));
    float ring = exp(-pow((d - rr) / (sz * 0.14 + age * sz * 0.05), 2.0)) * exp(-age * (kind > 0.5 && kind < 1.5 ? 0.35 : 1.1));
    float ember = exp(-pow(d / (sz * 0.7), 2.0)) * life;
    if (kind > 1.5 && kind < 2.5) { flash = exp(-age * 0.8) * exp(-pow(d / sz, 2.0) * 2.0); ring = 0.0; ember = exp(-pow(d / (sz * 1.1), 2.0)) * life; }
    emis += hot * flash * 7.0 + hot * ring * 2.2 + vec3(1.0, 0.3, 0.05) * ember * (0.7 + 0.3 * sin(uTime * 9.0 + B.w)) * 1.2;
    scorch += vec3(ember * 0.6);
  }
  alb *= 1.0 - clamp(scorch, 0.0, 0.7);
  // ---- light: soft terminator, a touch of ambient, atmosphere at grazing angles
  float lit = smoothstep(-0.08, 0.35, ndl) * (0.25 + 0.75 * max(ndl, 0.0));
  vec3 col = alb * (0.02 + 1.25 * lit);
  // clouds (+ their shadow)
  if (uMoon < 0.5) {
    vec3 cn = rotY(N, uCloudT);
    float cl = fbm(cn * 3.6 + vec3(0.0, uCloudT * 0.3, 0.0), uDetail > 0.5 ? 5 : 3);
    float cloud = smoothstep(0.55, 0.78, cl) * 0.8;
    float sh = smoothstep(0.52, 0.74, fbm(rotY(N + uSun * 0.01, uCloudT) * 3.6 + vec3(0.0, uCloudT * 0.3, 0.0), 3));
    col *= 1.0 - 0.35 * sh * lit;
    col = mix(col, vec3(0.92, 0.94, 0.96) * (0.03 + 1.1 * lit), cloud);
    emis *= 1.0 - 0.6 * cloud;
    float fres = pow(1.0 - max(dot(WN, V), 0.0), 5.0);
    col += uAtmo * fres * (0.1 + 0.9 * smoothstep(-0.25, 0.3, ndl)) * 0.45;
  }
  if (uOverlay > 0.5) { gl_FragColor = vec4(emis, 1.0); return; }   // (on a room's own planet mesh: only the fire)
  gl_FragColor = vec4(col + emis, 1.0);

  #include <colorspace_fragment>
}`;
const ATMO_FS = /* glsl */ `
uniform vec3 uSun; uniform vec3 uAtmo;
varying vec3 vN; varying vec3 vWN; varying vec3 vWP;
void main() {
  vec3 WN = normalize(vWN); vec3 V = normalize(cameraPosition - vWP);
  float f = 1.0 - max(dot(WN, V), 0.0);
  float glow = pow(f, 2.2) * smoothstep(1.0, 0.82, f);
  float lit = 0.12 + 0.88 * smoothstep(-0.35, 0.35, dot(WN, uSun));
  gl_FragColor = vec4(uAtmo * glow * lit * 1.6, 1.0);

  #include <colorspace_fragment>
}`;

const PALETTES: Record<string, string[]> = {
  // sea deep, sea shallow, ground A, ground B, highland, alien patches, ice, atmosphere
  helldive: ['#07181c', '#12383a', '#6e5226', '#4e3218', '#827462', '#5a2a3a', '#cfd8de', '#6fb6ff'],
  desert: ['#20170f', '#4a3520', '#b0823f', '#8d5a2b', '#c2a47a', '#6b3b1f', '#e8dcc8', '#ffc38a'],
  ice: ['#0b1c2c', '#1d4462', '#9fb2c2', '#6f8aa0', '#dfe8ef', '#4d6a8c', '#ffffff', '#9fd0ff'],
  toxic: ['#0c1a08', '#284018', '#6a7a24', '#4a5a18', '#8a8a5a', '#8a2a8a', '#d8e0b0', '#b8ff7a'],
  lava: ['#140604', '#3a0e06', '#3a2a24', '#241a16', '#5a4a40', '#b83a0a', '#8a8078', '#ff8a4a'],
  ocean: ['#041426', '#0d3a66', '#4f6b3a', '#3a5a2a', '#7a7a6a', '#2a5a4a', '#e8f0f8', '#79b8ff'],
};

export class Backdrop {
  readonly sky: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly planet: THREE.Mesh;
  readonly atmo: THREE.Mesh;
  readonly moon: THREE.Mesh | null;
  private skyMat: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;
  readonly planetMat: THREE.ShaderMaterial;
  private moonMat: THREE.ShaderMaterial | null = null;
  private atmoMat: THREE.ShaderMaterial;
  private imp = { a: Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4()), b: Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4()) };

  /** `space` = the compressed space group (planet / moon live in it); the sky follows the camera in world space. */
  constructor(readonly room: SpaceRoom, space: THREE.Group, world: THREE.Object3D, skyRadius: number) {
    const sunW = room.sun.pos.clone().sub(room.view.center).normalize();
    // the surface pattern's pole: perpendicular to the planet → viewer direction, so the visible cap is temperate
    const sub = room.view.center.clone().sub(room.planet.center).normalize();
    const pole = new THREE.Vector3().crossVectors(sub, room.view.right).normalize().lerp(sub, 0.18).normalize();
    const frame = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(pole, new THREE.Vector3(0, 1, 0))));
    const pal = (PALETTES[room.planet.palette] ?? PALETTES.helldive).map((c) => new THREE.Color(c));
    // sky + stars (drawn first, no depth: the room and the planet paint over them)
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { uSun: { value: sunW }, uSunCol: { value: room.sun.color.clone() }, uBand: { value: new THREE.Vector3(0.3, 0.8, 0.52).normalize() }, uDetail: { value: 1 } } });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(skyRadius, 48, 24), this.skyMat);
    this.sky.name = 'vtp:space:sky'; this.sky.renderOrder = -1000; this.sky.frustumCulled = false;
    const n = 2600, pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3), ph = new Float32Array(n);
    const r = new Rng(9173);
    const band = new THREE.Vector3(0.3, 0.8, 0.52).normalize();
    for (let i = 0; i < n; i++) {
      let d = new THREE.Vector3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
      if (d.lengthSq() < 1e-4 || d.lengthSq() > 1) { i--; continue; }
      d.normalize();
      // more stars along the galactic band
      if (Math.abs(d.dot(band)) > 0.35 && r.next() < 0.55) { d = d.addScaledVector(band, -d.dot(band) * 0.85).normalize(); }
      d.multiplyScalar(skyRadius * 0.97);
      pos.set([d.x, d.y, d.z], i * 3);
      const m = r.next();
      size[i] = m < 0.9 ? 1.2 + r.next() * 1.2 : 2.4 + r.next() * 2.2;
      const t = r.next(), b = 0.35 + 0.65 * r.next() ** 2 * (m < 0.9 ? 1 : 1.6);
      const c = t < 0.2 ? [0.75, 0.85, 1] : t < 0.8 ? [1, 1, 1] : [1, 0.85, 0.65];
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      ph[i] = r.next();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aCol', new THREE.BufferAttribute(col, 3)); sg.setAttribute('aPh', new THREE.BufferAttribute(ph, 1));
    this.starMat = new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 } } });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.name = 'vtp:space:stars'; this.stars.renderOrder = -999; this.stars.frustumCulled = false;
    world.add(this.sky); this.sky.add(this.stars);

    // planet + atmosphere
    const common = { uSun: { value: room.sun.dir.clone() }, uTime: { value: 0 }, uCloudT: { value: 0 }, uDetail: { value: 1 }, uCombat: { value: 1 }, uMoon: { value: 0 },
      uPal: { value: pal.slice(0, 7).map((c) => new THREE.Vector3(c.r, c.g, c.b)).concat([new THREE.Vector3()]) },
      uZones: { value: Array.from({ length: MAX_ZONES }, () => new THREE.Vector4()) }, uZoneN: { value: 0 },
      uImpA: { value: this.imp.a }, uImpB: { value: this.imp.b }, uImpN: { value: 0 }, uFrame: { value: frame }, uOverlay: { value: room.own.planet ? 1 : 0 }, uAtmo: { value: new THREE.Vector3(pal[7].r, pal[7].g, pal[7].b) } };
    const overlay = room.own.planet;
    this.planetMat = new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: PLANET_FS, uniforms: common, fog: false,
      ...(overlay ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } : {}) });
    this.planet = new THREE.Mesh(overlay ? new THREE.SphereGeometry(1, 112, 72) : new THREE.SphereGeometry(1, 160, 96), this.planetMat);
    this.planet.name = overlay ? 'vtp:space:planet-fx' : 'vtp:space:planet';
    this.planet.position.copy(room.planet.center); this.planet.scale.setScalar(overlay ? room.own.overlayRadius : room.planet.radius);
    this.atmoMat = new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: ATMO_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uSun: common.uSun, uAtmo: common.uAtmo } });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.atmoMat);
    this.atmo.name = 'vtp:space:atmo';
    this.atmo.position.copy(room.planet.center); this.atmo.scale.setScalar(room.planet.radius * 1.035);
    space.add(this.planet);
    if (!overlay) space.add(this.atmo);
    if (room.moon && !room.own.moon) {
      this.moonMat = new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: PLANET_FS, fog: false,
        uniforms: { ...common, uSun: { value: room.sun.pos.clone().sub(room.moon.center).normalize() }, uMoon: { value: 1 }, uImpN: { value: 0 }, uZoneN: { value: 0 }, uCombat: { value: 0 } } });
      this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.moonMat);
      this.moon.name = 'vtp:space:moon';
      this.moon.position.copy(room.moon.center); this.moon.scale.setScalar(room.moon.radius);
      space.add(this.moon);
    } else this.moon = null;
  }

  setZones(zones: THREE.Vector4[]) {
    const u = this.planetMat.uniforms;
    zones.slice(0, MAX_ZONES).forEach((z, i) => (u.uZones.value as THREE.Vector4[])[i].copy(z));
    u.uZoneN.value = Math.min(MAX_ZONES, zones.length);
  }

  /** Impacts for this frame: dir (unit, planet space), age (s), size (chord), kind, duration (s), seed. */
  setImpacts(list: { dir: THREE.Vector3; age: number; size: number; kind: number; dur: number; seed: number }[]) {
    const n = Math.min(MAX_IMPACTS, list.length);
    // newest first when over budget
    const src = list.length > MAX_IMPACTS ? [...list].sort((a, b) => a.age - b.age).slice(0, MAX_IMPACTS) : list;
    for (let i = 0; i < n; i++) { const m = src[i]; this.imp.a[i].set(m.dir.x, m.dir.y, m.dir.z, m.age); this.imp.b[i].set(m.size, m.kind, m.dur, m.seed % 100); }
    this.planetMat.uniforms.uImpN.value = n;
  }

  update(cam: THREE.PerspectiveCamera, tSec: number, detail: number, combat: number, pxH: number) {
    this.sky.position.copy(cam.position);
    this.sky.updateMatrixWorld();
    const u = this.planetMat.uniforms;
    u.uTime.value = tSec % 3600; u.uCloudT.value = (tSec * 0.004 * this.room.planet.spin) % (Math.PI * 2); u.uDetail.value = detail > 0 ? 1 : 0; u.uCombat.value = combat;
    this.skyMat.uniforms.uDetail.value = detail > 0 ? 1 : 0;
    this.starMat.uniforms.uTime.value = tSec % 3600;
    this.starMat.uniforms.uPx.value = Math.max(0.6, pxH / 1080);
    if (this.moonMat) this.moonMat.uniforms.uTime.value = tSec % 3600;
  }

  materials(): THREE.Material[] { return [this.skyMat, this.starMat, this.planetMat, this.atmoMat, ...(this.moonMat ? [this.moonMat] : [])]; }

  dispose() {
    for (const o of [this.sky, this.stars, this.planet, this.atmo, this.moon]) { if (!o) continue; o.removeFromParent(); o.geometry.dispose(); }
    for (const m of this.materials()) m.dispose();
  }
}

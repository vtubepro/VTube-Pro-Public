// Town engine — cheap stateless particles: every particle's position is a closed-form function of the town clock
// (seed + age = (t + offset) mod life), computed in the vertex shader. One Points draw per system, zero CPU per frame
// beyond a uniform. Systems: embers (braziers / beacon), chimney smoke, wave spray on rocks + piles (bursts timed by
// the swell), festival sky lanterns (NIGHT FESTIVAL look), rain (STORM look).
import * as THREE from 'three';

export type SystemKind = 'embers' | 'smoke' | 'spray' | 'lanterns' | 'rain' | 'flame' | 'motes';

interface Cfg { per: number; life: number; size: number; color: string; blend: THREE.Blending; rise: number; spread: number; drift: number; opacity: number }
const CFG: Record<SystemKind, Cfg> = {
  embers: { per: 26, life: 2.6, size: 0.07, color: '#ffa040', blend: THREE.AdditiveBlending, rise: 2.4, spread: 0.35, drift: 0.5, opacity: 1 },
  smoke: { per: 18, life: 10.0, size: 2.6, color: '#8e949c', blend: THREE.NormalBlending, rise: 1.1, spread: 0.4, drift: 1.6, opacity: 0.26 },
  spray: { per: 64, life: 1.4, size: 0.42, color: '#eef6f8', blend: THREE.NormalBlending, rise: 3.2, spread: 1.4, drift: 0.8, opacity: 0.75 },
  lanterns: { per: 1, life: 40.0, size: 0.8, color: '#ffb85a', blend: THREE.AdditiveBlending, rise: 1.2, spread: 25.0, drift: 2.0, opacity: 1 },
  flame: { per: 18, life: 0.7, size: 0.34, color: '#ff8a2a', blend: THREE.AdditiveBlending, rise: 1.1, spread: 0.28, drift: 0.2, opacity: 0.9 },
  motes: { per: 30, life: 5.0, size: 0.07, color: '#8adcff', blend: THREE.AdditiveBlending, rise: 1.6, spread: 2.4, drift: 0.2, opacity: 1 },
  rain: { per: 1, life: 0.9, size: 0.11, color: '#d0dcea', blend: THREE.NormalBlending, rise: -14.0, spread: 26.0, drift: 2.5, opacity: 0.7 },
};

export class Particles {
  readonly points: THREE.Points;
  private u: Record<string, THREE.IUniform>;

  constructor(readonly kind: SystemKind, emitters: THREE.Vector3[], countOverride?: number) {
    const c = CFG[kind];
    const per = countOverride ?? c.per;
    const n = Math.max(1, emitters.length) * per;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n * 2);
    let k = 0;
    const em = emitters.length ? emitters : [new THREE.Vector3()];
    for (let e = 0; e < em.length; e++) {
      for (let i = 0; i < per; i++, k++) {
        pos[k * 3] = em[e].x; pos[k * 3 + 1] = em[e].y; pos[k * 3 + 2] = em[e].z;
        const h1 = Math.sin((k + 1) * 12.9898) * 43758.5453, h2 = Math.sin((k + 1) * 78.233) * 12345.678;
        seed[k * 2] = h1 - Math.floor(h1); seed[k * 2 + 1] = h2 - Math.floor(h2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uLife: { value: c.life }, uSize: { value: c.size }, uRise: { value: c.rise }, uSpread: { value: c.spread },
      uDrift: { value: c.drift }, uColor: { value: new THREE.Color(c.color) }, uOpacity: { value: c.opacity }, uAmount: { value: 1 },
      uPx: { value: 800 }, uWind: { value: new THREE.Vector2(0.6, -0.2) }, uCam: { value: new THREE.Vector3() },
    }]);
    const mode = { embers: 0, smoke: 1, spray: 2, lanterns: 3, rain: 4, flame: 5, motes: 6 }[kind];
    const mat = new THREE.ShaderMaterial({
      name: 'vtp:town:' + kind, uniforms: this.u, fog: true, transparent: true, depthWrite: false, blending: c.blend,
      vertexShader: /* glsl */`
        attribute vec2 seed;
        uniform float uTime, uLife, uSize, uRise, uSpread, uDrift, uAmount, uPx; uniform vec2 uWind; uniform vec3 uCam;
        varying float vA; varying float vS; varying float vAge; varying vec2 vSeed;
        #include <fog_pars_vertex>
        void main() {
          float life = uLife * (0.7 + 0.6 * seed.y);
          float age = mod(uTime + seed.x * 97.0, life) / life;
          float cyc = floor((uTime + seed.x * 97.0) / life);
          float r1 = fract(sin(cyc * 17.13 + seed.x * 91.7) * 4375.5), r2 = fract(sin(cyc * 31.7 + seed.y * 53.3) * 2143.9);
          vec3 p = position;
          float alive = step(seed.y, uAmount);
          vA = 1.0; vS = 1.0;
          #if ${mode} == 0
            p += vec3((r1 - 0.5) * uSpread, 0.0, (r2 - 0.5) * uSpread);
            p.y += age * uRise * (0.6 + 0.8 * r2);
            p.xz += uWind * age * uDrift + vec2(sin(age * 9.0 + r1 * 6.0), cos(age * 7.0 + r2 * 6.0)) * 0.12 * age;
            vA = (1.0 - age) * smoothstep(0.0, 0.08, age) * (0.6 + 0.4 * sin(uTime * 20.0 + r1 * 30.0));
            vS = 1.0 - age * 0.6;
          #elif ${mode} == 1
            p += vec3((r1 - 0.5) * uSpread, 0.0, (r2 - 0.5) * uSpread);
            p.y += age * uRise * 6.0;
            p.xz += uWind * age * uDrift * 6.0;
            vA = smoothstep(0.0, 0.15, age) * (1.0 - age);
            vS = 0.4 + age * 1.8;
          #elif ${mode} == 2
            // a burst when the swell hits (the burst time is shared by the emitter's particles)
            float bl = 3.5;
            float bt = mod(uTime + position.x * 0.37 + position.z * 0.21, bl);
            float a2 = bt / 1.4;
            vec2 dir = vec2(r1 - 0.5, r2 - 0.5) * 2.0;
            p.xz += dir * uSpread * a2;
            p.y += (uRise * (0.6 + r2) * a2 - 4.9 * a2 * a2 * 1.4) ;
            vA = step(a2, 1.0) * (1.0 - a2) * smoothstep(0.0, 0.05, a2);
            vS = 0.6 + a2;
          #elif ${mode} == 3
            p += vec3((r1 - 0.5) * uSpread * 2.0, 0.0, -(r2) * uSpread * 3.0);
            p.y += age * uRise * 30.0;
            p.xz += uWind * age * uDrift * 10.0 + vec2(sin(age * 3.0 + r1 * 6.0), 0.0) * 1.5;
            vA = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.7, 1.0, age)) * (0.75 + 0.25 * sin(uTime * 3.0 + r1 * 20.0));
          #elif ${mode} == 5
            // flame tongues: rise fast, narrow toward the tip, yellow core -> orange -> red as they age
            p += vec3((r1 - 0.5) * uSpread * (1.0 - age), 0.0, (r2 - 0.5) * uSpread * (1.0 - age));
            p.y += age * uRise * (0.7 + 0.6 * r2);
            p.x += sin(uTime * 9.0 + r1 * 20.0) * 0.04 * age;
            vA = smoothstep(0.0, 0.1, age) * (1.0 - age) * (1.0 - age);
            vS = 1.0 - age * 0.7;
          #elif ${mode} == 6
            // waypoint motes: rise from the disc in a slow spiral
            float an = r1 * 6.2831 + age * 3.0;
            float rr = (0.3 + r2 * 0.7) * uSpread * 0.5;
            p += vec3(cos(an) * rr, age * uRise, sin(an) * rr);
            vA = smoothstep(0.0, 0.15, age) * (1.0 - age) * (0.6 + 0.4 * sin(uTime * 6.0 + r1 * 40.0));
          #else
            p = uCam + vec3((r1 - 0.5) * uSpread, 12.0 + age * uRise, (r2 - 0.5) * uSpread - 8.0);
            p.xz += uWind * age * uDrift;
            vA = 1.0;
          #endif
          vA *= alive;
          vAge = age; vSeed = vec2(r1, r2);
          // three's fog_vertex chunk reads \`mvPosition\` — keep that name
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = uSize * vS * uPx / max(0.5, -mvPosition.z);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying float vA; varying float vS; varying float vAge; varying vec2 vSeed;
        float h21(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }
        float vn(vec2 q) { vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
        #include <fog_pars_fragment>
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          #if ${mode} == 4
            float a = (1.0 - smoothstep(0.0, 1.0, abs(c.x) * 8.0)) * (1.0 - abs(c.y) * 2.0);
          #elif ${mode} == 1
            // billowing smoke: soft disc broken up by two octaves of noise that churn with age
            vec2 q = gl_PointCoord * 3.0 + vSeed * 17.0 + vAge * 1.5;
            float nn = vn(q) * 0.65 + vn(q * 2.3) * 0.35;
            float a = (1.0 - smoothstep(0.15, 1.0, d)) * smoothstep(0.25, 0.75, nn + 0.35 - d * 0.4);
          #elif ${mode} == 5
            float a = pow(max(0.0, 1.0 - d), 1.6) * (1.0 - smoothstep(0.3, 1.0, abs(gl_PointCoord.x - 0.5) * 2.0 + (1.0 - gl_PointCoord.y) * 0.3));
          #elif ${mode} == 2
            vec2 q = gl_PointCoord * 4.0 + vSeed * 9.0;
            float a = pow(max(0.0, 1.0 - d), 1.5) * (0.55 + 0.45 * vn(q));
          #else
            float a = 1.0 - smoothstep(0.0, 1.0, d);
            a = a * a;
          #endif
          if (a * vA < 0.01) discard;
          vec3 col = uColor;
          #if ${mode} == 5
            col = mix(vec3(1.0, 0.92, 0.55), mix(vec3(1.0, 0.45, 0.1), vec3(0.6, 0.08, 0.02), smoothstep(0.4, 1.0, vAge)), smoothstep(0.0, 0.45, vAge)) * 1.3;
          #endif
          gl_FragColor = vec4(col, a * vA * uOpacity);
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'vtp:town:' + kind;
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  update(t: number, pxScale: number, amount = 1, cam?: THREE.Vector3) {
    this.u.uTime.value = t;
    this.u.uPx.value = pxScale;
    this.u.uAmount.value = amount;
    if (cam) (this.u.uCam.value as THREE.Vector3).copy(cam);
    this.points.visible = amount > 0.001;
  }

  dispose() { this.points.removeFromParent(); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

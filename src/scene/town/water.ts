// Town engine — the animated sea. Replaces the room's SEA mesh material (scene.json town + a mesh named SEA / a
// material with extras.water): Gerstner swell in the vertex shader (waves.ts, the same waves the boats ride), a
// stylised painterly surface (deep/shallow tint by view angle, sky reflection gradient, a warm sun glint path,
// crest highlights), foam where the sea meets the quay wall, around piles / rocks / hulls (up to 24 foam circles) and
// on the crests in a storm. One draw call; costs nothing on the CPU beyond two uniforms per frame.
import * as THREE from 'three';
import { seaGLSL } from './waves.ts';

export interface WaterLook {
  deep: string; shallow: string; skyTop: string; skyHorizon: string; sun: string; foam: string;
  sunDir: [number, number, number];
}

export const DEFAULT_WATER: WaterLook = {
  deep: '#081a22', shallow: '#1c4650', skyTop: '#2c3648', skyHorizon: '#7a7870', sun: '#ffc890', foam: '#dfe8e6',
  sunDir: [0.42, 0.3, -0.74],
};

function noiseTexture(size = 128, seed = 7): THREE.DataTexture {
  // tileable value noise (3 octaves) in R, a second decorrelated field in G
  const d = new Uint8Array(size * size * 4);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const grids = [8, 16, 32].map((g) => ({ g, v: Array.from({ length: g * g * 2 }, rnd) }));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, b = 0, amp = 1, tot = 0;
      for (const { g, v } of grids) {
        const fx = (x / size) * g, fy = (y / size) * g;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
        const at = (i: number, j: number, o: number) => v[(((j % g) + g) % g) * g * 2 + (((i % g) + g) % g) * 2 + o];
        for (let o = 0; o < 2; o++) {
          const n = (at(x0, y0, o) * (1 - tx) + at(x0 + 1, y0, o) * tx) * (1 - ty) + (at(x0, y0 + 1, o) * (1 - tx) + at(x0 + 1, y0 + 1, o) * tx) * ty;
          if (o === 0) a += n * amp; else b += n * amp;
        }
        tot += amp; amp *= 0.5;
      }
      const i = (y * size + x) * 4;
      d[i] = Math.round((a / tot) * 255); d[i + 1] = Math.round((b / tot) * 255); d[i + 2] = 0; d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export const MAX_FOAM = 24;
/** practical lights mirrored on the water (lantern / window / brazier glitter streaks) */
export const MAX_WLIGHTS = 14;

export class Water {
  readonly material: THREE.ShaderMaterial;
  private noise = noiseTexture();
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(look: WaterLook, shoreZ: number, shoreX: [number, number], waterY: number) {
    const col = (h: string) => new THREE.Color(h);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uStorm: { value: 0 }, uNoise: { value: null },
      uDeep: { value: col(look.deep) }, uShallow: { value: col(look.shallow) }, uSkyTop: { value: col(look.skyTop) },
      uSkyHorizon: { value: col(look.skyHorizon) }, uSun: { value: col(look.sun) }, uFoamCol: { value: col(look.foam) },
      uSunDir: { value: new THREE.Vector3(...look.sunDir).normalize() }, uShore: { value: new THREE.Vector3(shoreZ, shoreX[0], shoreX[1]) },
      uWaterY: { value: waterY }, uFoam: { value: Array.from({ length: MAX_FOAM }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uNight: { value: 0 }, uFlash: { value: 0 }, uQuality: { value: 1 },
      uLights: { value: Array.from({ length: MAX_WLIGHTS }, () => new THREE.Vector4(0, 0, 0, 0)) }, uLightCol: { value: Array.from({ length: MAX_WLIGHTS }, () => new THREE.Color()) },
      uWake: { value: new THREE.Vector4(0, 0, 0, 0) }, uWake2: { value: new THREE.Vector4(0, 0, 0, 0) },
    }]);
    this.uniforms.uNoise.value = this.noise;
    this.material = new THREE.ShaderMaterial({
      name: 'vtp:town:sea', uniforms: this.uniforms, fog: true, lights: false,
      vertexShader: /* glsl */`
        uniform float uTime; uniform float uStorm;
        varying vec3 vW; varying vec2 vSlope; varying float vH; varying float vDist;
        #include <fog_pars_vertex>
        ${seaGLSL()}
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vec3 camW = cameraPosition;
          float dist = length(w.xz - camW.xz);
          float fadeH = 1.0 - smoothstep(60.0, 180.0, dist);
          float fadeL = 1.0 - smoothstep(260.0, 520.0, dist) * 0.7;
          vec2 sl;
          vec3 d = seaDisp(w.xz, uTime, uStorm, fadeL, fadeH, sl);
          w.xyz += d;
          vW = w.xyz; vSlope = sl; vH = d.y; vDist = dist;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform float uStorm; uniform sampler2D uNoise;
        uniform vec3 uDeep, uShallow, uSkyTop, uSkyHorizon, uSun, uFoamCol, uSunDir, uShore;
        uniform float uWaterY; uniform vec4 uFoam[${MAX_FOAM}]; uniform float uNight; uniform float uFlash; uniform float uQuality;
        uniform vec4 uLights[${MAX_WLIGHTS}]; uniform vec3 uLightCol[${MAX_WLIGHTS}]; uniform vec4 uWake; uniform vec4 uWake2;
        float h21(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
        varying vec3 vW; varying vec2 vSlope; varying float vH; varying float vDist;
        #include <fog_pars_fragment>
        float nz(vec2 p) { return texture2D(uNoise, p).r; }
        void main() {
          // micro normal: macro slope + two scrolling noise layers (fades with distance)
          float micro = (1.0 - smoothstep(20.0, 140.0, vDist)) * (0.6 + 0.8 * uStorm);
          vec2 p1 = vW.xz * 0.11 + vec2(0.02, 0.05) * uTime;
          vec2 p2 = vW.xz * 0.23 + vec2(-0.04, 0.03) * uTime;
          float e = 0.012;
          vec2 g1 = vec2(nz(p1 + vec2(e, 0.0)) - nz(p1 - vec2(e, 0.0)), nz(p1 + vec2(0.0, e)) - nz(p1 - vec2(0.0, e)));
          vec2 g2 = vec2(nz(p2 + vec2(e, 0.0)) - nz(p2 - vec2(e, 0.0)), nz(p2 + vec2(0.0, e)) - nz(p2 - vec2(0.0, e)));
          vec3 n = normalize(vec3(-vSlope.x - (g1.x + g2.x) * 1.6 * micro, 1.0, -vSlope.y - (g1.y + g2.y) * 1.6 * micro));
          vec3 V = normalize(cameraPosition - vW);
          float ndv = clamp(dot(n, V), 0.0, 1.0);
          float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, n);
          float up = clamp(R.y, 0.0, 1.0);
          vec3 sky = mix(uSkyHorizon, uSkyTop, pow(up, 0.55));
          // body colour: deeper looking down, lighter + greener on the crests
          // depth colour: shallow teal-green along the quay + the piers, deepening out to sea
          float offshore = max(0.0, uShore.x - vW.z);
          vec3 shallow = mix(uShallow * vec3(0.8, 1.15, 1.0), uShallow, smoothstep(2.0, 18.0, offshore));
          vec3 deep = mix(uDeep * 1.25, uDeep * 0.8, smoothstep(30.0, 200.0, offshore));
          vec3 body = mix(shallow, deep, clamp(ndv * 1.1 + smoothstep(4.0, 40.0, offshore) * 0.35, 0.0, 1.0));
          // sun-lit wave backs glow green (subsurface), crests lighter
          float sss = pow(max(0.0, dot(-V, uSunDir)), 3.0) * clamp(vH * 2.5 + 0.3, 0.0, 1.0);
          body += vec3(0.12, 0.3, 0.26) * sss * (1.0 - uNight * 0.8) + uShallow * clamp(vH * 1.8, 0.0, 0.6);
          vec3 col = mix(body, sky, clamp(fres * 0.85, 0.0, 0.8));
          // sun glint path (stylised: banded)
          float sg = pow(max(dot(R, uSunDir), 0.0), 220.0) * 2.2 + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.18;
          col += uSun * sg * (1.0 - uNight * 0.85);
          // sparkle: tiny stepped glints on the sun path (High / Ultra richer)
          vec2 cell = floor(vW.xz * 2.2);
          float hsh = h21(cell + floor(uTime * 3.0));
          float spk = step(0.992 - 0.01 * uQuality, hsh) * pow(max(dot(R, uSunDir), 0.0), 6.0) * (1.0 - smoothstep(30.0, 160.0, vDist));
          col += uSun * spk * (1.2 + uQuality) * (1.0 - uNight);
          // foam: along the quay wall, around piles / rocks / hulls, storm crests
          float fn = nz(vW.xz * 0.35 + vec2(0.0, uTime * 0.05)) * 0.6 + nz(vW.xz * 0.9 - vec2(uTime * 0.04, 0.0)) * 0.4;
          float dq = abs(vW.z - uShore.x);
          float inX = step(uShore.y, vW.x) * step(vW.x, uShore.z);
          float surge = 0.5 + 0.5 * sin(uTime * 0.9 + vW.x * 0.07);
          float fq = inX * (1.0 - smoothstep(0.0, 1.6 + 1.4 * surge + uStorm * 2.0, dq));
          // shoreline breakers: foam lines rolling in to the wall + the backwash
          float brk = sin(offshore * (0.85 - uStorm * 0.25) + uTime * (2.0 + uStorm) + fn * 2.5);
          fq = max(fq, inX * smoothstep(0.62, 0.95, brk) * exp(-offshore / (5.0 + uStorm * 8.0)));
          float fr = 0.0;
          for (int i = 0; i < ${MAX_FOAM}; i++) {
            vec4 f = uFoam[i];
            if (f.w <= 0.0) continue;
            float d = length(vW.xz - f.xy);
            float ring = 1.0 - smoothstep(f.z * 0.6, f.z * (1.3 + 0.35 * sin(uTime * 1.3 + f.x)), d);
            fr = max(fr, ring * f.w);
          }
          // the sailing ship's wake: a Kelvin V (about 19.5 deg) + a churned centre trail behind the stern (uWake: stern xz, heading, strength)
          float wk = 0.0;
          if (uWake.w > 0.01) {
            vec2 hd = vec2(sin(uWake.z), cos(uWake.z));
            vec2 dv = vW.xz - uWake.xy;
            float along = -dot(dv, hd);
            float lat = abs(dv.x * hd.y - dv.y * hd.x);
            if (along > 0.0 && along < 70.0) {
              float fade = (1.0 - along / 70.0) * uWake.w;
              float arm = 1.0 - smoothstep(0.0, 0.8 + along * 0.05, abs(lat - along * 0.36));
              float trail = (1.0 - smoothstep(0.6 + along * 0.04, 2.2 + along * 0.08, lat)) * (1.0 - smoothstep(0.0, 45.0, along));
              wk = max(arm * 0.9, trail * (0.55 + 0.45 * fn)) * fade;
            }
          }
          // rowboats / the canoe drifting: small bow waves (uWake2: xz, heading, strength)
          if (uWake2.w > 0.01) {
            vec2 hd = vec2(sin(uWake2.z), cos(uWake2.z));
            vec2 dv = vW.xz - uWake2.xy;
            float along = -dot(dv, hd);
            float lat = abs(dv.x * hd.y - dv.y * hd.x);
            if (along > -1.0 && along < 16.0) wk = max(wk, (1.0 - smoothstep(0.0, 0.5 + along * 0.05, abs(lat - max(0.0, along) * 0.36))) * (1.0 - along / 16.0) * uWake2.w);
          }
          float crest = smoothstep(0.28, 0.75, vH) * (0.12 + 0.7 * uStorm) * smoothstep(0.35, 0.75, fn);
          crest = max(crest, wk * smoothstep(0.2, 0.6, fn + 0.3));
          float foam = clamp(max(max(fq, fr), crest) * 1.25 - (1.0 - fn) * 0.75, 0.0, 1.0);
          foam = smoothstep(0.3, 0.72, foam);
          col = mix(col, uFoamCol * (1.0 - uNight * 0.6), foam * 0.82);
          // practical lights mirrored in the swell: long broken glitter streaks towards the camera (all tiers; richer on High / Ultra)
          vec3 lsum = vec3(0.0);
          float sharp = mix(90.0, 260.0, clamp(uQuality, 0.0, 1.0));
          for (int i = 0; i < ${MAX_WLIGHTS}; i++) {
            vec4 lp = uLights[i];
            if (lp.w <= 0.0) continue;
            vec3 Ld = lp.xyz - vW;
            float dl = length(Ld);
            Ld /= dl;
            float rl = max(dot(R, Ld), 0.0);
            float streak = pow(rl, sharp) * 3.0 + pow(rl, 18.0) * 0.12;
            float brk = 0.55 + 0.45 * smoothstep(0.35, 0.7, nz(vW.xz * vec2(0.6, 1.8) + vec2(0.0, uTime * 0.2)));
            lsum += uLightCol[i] * streak * brk * lp.w / (1.0 + dl * dl * 0.004);
          }
          col += lsum * (0.45 + 0.9 * uNight) * (1.0 - foam * 0.6);
          col += vec3(0.7, 0.8, 1.0) * uFlash * 0.6;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
  }

  setFoam(list: { x: number; z: number; r: number; w: number }[]) {
    const u = this.uniforms.uFoam.value as THREE.Vector4[];
    for (let i = 0; i < MAX_FOAM; i++) {
      const f = list[i];
      if (f) u[i].set(f.x, f.z, f.r, f.w); else u[i].set(0, 0, 0, 0);
    }
  }

  /** lights mirrored on the water: [x, y, z, strength] + colour (engine picks the nearest to the camera) */
  setLights(list: { p: THREE.Vector3; c: THREE.Color; k: number }[]) {
    const u = this.uniforms.uLights.value as THREE.Vector4[], c = this.uniforms.uLightCol.value as THREE.Color[];
    for (let i = 0; i < MAX_WLIGHTS; i++) { const l = list[i]; if (l) { u[i].set(l.p.x, l.p.y, l.p.z, l.k); c[i].copy(l.c); } else u[i].set(0, 0, 0, 0); }
  }
  setWake(i: number, x: number, z: number, heading: number, k: number) { (this.uniforms[i ? 'uWake2' : 'uWake'].value as THREE.Vector4).set(x, z, heading, k); }

  update(t: number, storm: number, night: number, flash: number, quality = 1) {
    this.uniforms.uQuality.value = quality;
    this.uniforms.uTime.value = t;
    this.uniforms.uStorm.value = storm;
    this.uniforms.uNight.value = night;
    this.uniforms.uFlash.value = flash;
  }

  dispose() { this.material.dispose(); this.noise.dispose(); }
}

// Town engine — light effects: glow halos round every lantern / candle / brazier / orb display (one additive Points
// draw, per-light flicker from the town clock, so the High / Ultra bloom picks them up through the glow layer), the
// lighthouse's volumetric beam (a soft fresnel-faded double cone that sweeps + a lamp flare), and the Mirror of
// Kalandra's moving sheen. All additive, no depth write, zero CPU beyond uniforms.
import * as THREE from 'three';

export interface HaloSpec { p: THREE.Vector3; size: number; color: THREE.Color; flicker: number; seed: number }

export class Halos {
  readonly points: THREE.Points;
  private u: Record<string, THREE.IUniform>;
  constructor(list: HaloSpec[]) {
    const n = Math.max(1, list.length);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), aux = new Float32Array(n * 3);
    list.forEach((h, i) => {
      pos.set([h.p.x, h.p.y, h.p.z], i * 3); col.set([h.color.r, h.color.g, h.color.b], i * 3); aux.set([h.size, h.flicker, h.seed], i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('hcol', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aux', new THREE.BufferAttribute(aux, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uPx: { value: 800 }, uGain: { value: 1 } }]);
    const mat = new THREE.ShaderMaterial({
      name: 'vtp:town:halos', uniforms: this.u, fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 hcol; attribute vec3 aux;
        uniform float uTime, uPx, uGain;
        varying vec3 vC; varying float vA;
        #include <fog_pars_vertex>
        void main() {
          float t = uTime + aux.z * 13.7;
          // lantern flicker: two incommensurate sines + a fast shimmer, depth set per light
          float fl = 1.0 - aux.y * (0.18 + 0.14 * sin(t * 7.3) + 0.1 * sin(t * 13.1 + 1.7) + 0.06 * sin(t * 31.0));
          vC = hcol * fl * uGain;
          vA = fl;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aux.x * (0.92 + 0.08 * fl) * uPx / max(0.3, -mvPosition.z);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vC; varying float vA;
        #include <fog_pars_fragment>
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-d * d * 18.0);
          float glow = pow(max(0.0, 1.0 - d), 2.4);
          float a = core * 0.9 + glow * 0.45;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vC * a, a);
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'vtp:town:halos';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }
  update(t: number, px: number, gain: number) { this.u.uTime.value = t % 3600; this.u.uPx.value = px; this.u.uGain.value = gain; }
  dispose() { this.points.removeFromParent(); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

/** the lighthouse beam: a long soft cone (apex at the lamp, pointing +X locally) faded by view angle + length. */
export function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:town:beam', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0xfff0c8) }, uAmount: { value: 0.1 }, uLen: { value: 140 } },
    vertexShader: /* glsl */`
      varying float vAlong; varying vec3 vN; varying vec3 vV;
      uniform float uLen;
      void main() {
        vAlong = clamp(position.x / uLen, 0.0, 1.0);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uAmount;
      varying float vAlong; varying vec3 vN; varying vec3 vV;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);   // soft at the silhouette = volume look
        float fall = (1.0 - vAlong) * (1.0 - vAlong) * smoothstep(0.0, 0.03, vAlong);
        float a = edge * fall * uAmount;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

/** Mirror of Kalandra sheen: a disc over the glass, a diagonal highlight sweeping across + a slow inner swirl. */
export function sheenMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'vtp:town:sheen', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uGain: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uGain; varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float sweep = fract(uTime * 0.12);
        float band = exp(-pow((p.x + p.y) * 0.7 - (sweep * 4.0 - 2.0), 2.0) * 22.0);
        float ang = atan(p.y, p.x);
        float sw = 0.5 + 0.5 * sin(ang * 3.0 - uTime * 0.7 + r * 8.0);
        float rim = smoothstep(0.75, 1.0, r) * 0.35;
        vec3 c = vec3(0.75, 0.9, 1.0) * band * 0.6 + vec3(0.55, 0.45, 1.0) * sw * 0.12 * (1.0 - r) + vec3(0.8, 0.95, 1.0) * rim;
        float a = clamp((band * 0.6 + sw * 0.1 + rim * 0.7) * uGain, 0.0, 0.8);
        gl_FragColor = vec4(c * uGain, a);
      }`,
  });
}

/** Anvil sparks: one burst per hammer blow (the crowd reports when the smith's blow lands); stateless GPU points. */
export class Sparks {
  readonly points: THREE.Points;
  private u: Record<string, THREE.IUniform>;
  constructor(n = 44) {
    const dir = new Float32Array(n * 3), aux = new Float32Array(n * 2);
    let s = 1234567;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, up = 0.35 + r() * 0.9, sp = 1.6 + r() * 3.2;
      dir.set([Math.cos(a) * sp, up * sp, Math.sin(a) * sp], i * 3);
      aux.set([0.35 + r() * 0.5, r()], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aux', new THREE.BufferAttribute(aux, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.u = { uT: { value: 9 }, uO: { value: new THREE.Vector3() }, uPx: { value: 800 }, uAmt: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      name: 'vtp:town:sparks', uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 dir; attribute vec2 aux;
        uniform float uT, uPx, uAmt; uniform vec3 uO;
        varying float vA;
        void main() {
          float life = aux.x;
          float t = uT - aux.y * 0.05;
          float k = clamp(t / life, 0.0, 1.0);
          vA = (t > 0.0 && t < life && aux.y < uAmt) ? (1.0 - k) : 0.0;
          vec3 p = uO + dir * t + vec3(0.0, -4.9, 0.0) * t * t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = vA > 0.0 ? 0.045 * uPx / max(0.3, -mv.z) : 0.0;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d) * vA;
          if (a < 0.01) discard;
          vec3 c = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.92, 0.6), vA);
          gl_FragColor = vec4(c * a * 2.2, a);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'vtp:town:sparks';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }
  update(sinceHit: number, at: THREE.Vector3, px: number, amount: number) { this.u.uT.value = sinceHit; this.u.uO.value.copy(at); this.u.uPx.value = px; this.u.uAmt.value = amount; }
  dispose() { this.points.removeFromParent(); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

/** Dramatic cel clouds over a room's painted sky: a big dome slice with drifting fbm cloud banks (2 light bands +
 *  a hot rim towards the sun), coverage + colours following the weather / night. Blended, fog-free, one draw. */
export class CloudDome {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  constructor(radius = 420, sunDir = new THREE.Vector3(0.42, 0.3, -0.74)) {
    const g = new THREE.SphereGeometry(radius, 48, 16, 0, Math.PI * 2, 0, Math.PI * 0.47);
    this.u = {
      uTime: { value: 0 }, uCover: { value: 0.5 }, uNight: { value: 0 }, uStorm: { value: 0 }, uOct: { value: 4 }, uFlash: { value: 0 },
      uSun: { value: sunDir.clone().normalize() },
    };
    const mat = new THREE.ShaderMaterial({
      name: 'vtp:town:clouds', uniforms: this.u, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      vertexShader: /* glsl */`
        varying vec3 vD;
        void main() { vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uCover, uNight, uStorm, uOct, uFlash; uniform vec3 uSun;
        varying vec3 vD;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float a = 0.0, w = 0.5; for (int i = 0; i < 6; i++) { if (float(i) >= uOct) break; a += w * n2(p); p = p * 2.03 + vec2(1.7, 9.2); w *= 0.5; } return a; }
        void main() {
          vec3 d = normalize(vD);
          if (d.y < 0.01) discard;
          // project onto a cloud plane: big banks near the horizon, smaller overhead
          vec2 uv = d.xz / (d.y + 0.18) * 1.6;
          vec2 wind = vec2(uTime * 0.006, uTime * 0.0025);
          float base = fbm(uv * 0.9 + wind);
          float detail = fbm(uv * 2.6 - wind * 1.7);
          float c = base * 0.75 + detail * 0.35;
          float cover = mix(0.62, 0.34, uCover);
          float dens = smoothstep(cover, cover + 0.16, c);
          if (dens < 0.01) discard;
          // light: samples towards the sun = thinner = brighter (cheap self-shadow)
          vec2 sd = normalize(uSun.xz + 1e-4) * 0.08;
          float toward = fbm(uv * 0.9 + wind + sd) * 0.75 + detail * 0.35;
          float lit = clamp(0.55 + (c - toward) * 5.0, 0.0, 1.0);
          float band = lit > 0.62 ? 1.0 : lit > 0.3 ? 0.62 : 0.32;
          float sunAng = max(0.0, dot(d, normalize(uSun)));
          vec3 hi = mix(vec3(1.0, 0.8, 0.58), vec3(0.34, 0.4, 0.58), uNight);
          vec3 lo = mix(vec3(0.34, 0.33, 0.44), vec3(0.08, 0.09, 0.15), uNight);
          hi = mix(hi, vec3(0.34, 0.36, 0.42), uStorm * 0.9); lo = mix(lo, vec3(0.07, 0.075, 0.09), uStorm * 0.9);
          vec3 col = mix(lo, hi, band);
          // hot rim on the thin edges facing the sun (golden hour drama)
          float rim = (1.0 - smoothstep(0.0, 0.35, dens)) * pow(sunAng, 3.0) * (1.0 - uNight) * (1.0 - uStorm * 0.7);
          col += vec3(1.0, 0.62, 0.3) * rim * 1.4;
          col += vec3(0.75, 0.8, 1.0) * uFlash * 0.9 * dens;
          float fadeH = smoothstep(0.01, 0.12, d.y);
          gl_FragColor = vec4(col, dens * fadeH * mix(0.85, 0.95, uStorm));
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vtp:town:clouds';
    this.mesh.renderOrder = -5;
    this.mesh.frustumCulled = false;
  }
  update(t: number, cover: number, night: number, storm: number, oct: number, flash: number, camPos: THREE.Vector3) {
    this.u.uTime.value = t % 7200; this.u.uCover.value = cover; this.u.uNight.value = night; this.u.uStorm.value = storm; this.u.uOct.value = oct; this.u.uFlash.value = flash;
    this.mesh.position.set(camPos.x, 0, camPos.z);
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

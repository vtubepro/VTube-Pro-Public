// Puppet eyes for bulb / inset procedural eyes (EyeConfig.puppet): 'button' (sewn-on button with holes + thread cross),
// 'googly' (white dome, loose black pupil that rolls with gravity and head motion, still nudged by your gaze), 'felt'
// (flat felt disc, felt pupil with a fuzzy cut edge, a sewn white highlight). Same uniforms as the normal bulb sclera,
// so the eyelids, blink, squint and gaze code in eyes.ts is unchanged.
import * as THREE from 'three';
import type { EyeConfig } from '../../shared/types.ts';

export type PuppetEye = NonNullable<EyeConfig['puppet']>;

export function puppetEyeMaterial(kind: PuppetEye, cfg: EyeConfig): THREE.ShaderMaterial {
  const irisAng = Math.asin(THREE.MathUtils.clamp(cfg.irisSize, 0.05, 0.95));
  const button = kind === 'button', googly = kind === 'googly';
  return new THREE.ShaderMaterial({
    name: `vtp-eye-${kind}`,
    defines: { [button ? 'PUP_BUTTON' : googly ? 'PUP_GOOGLY' : 'PUP_FELT']: '' },
    uniforms: {
      uGaze: { value: new THREE.Vector3(0, 0, 1) },
      uScleraC: { value: new THREE.Color(cfg.scleraColor) },
      uIrisC: { value: new THREE.Color(button ? cfg.irisColor : '#111014') },
      uIrisCos: { value: Math.cos(irisAng) },
      uPupilCos: { value: Math.cos(irisAng * cfg.pupilSize) },
      uPupilScale: { value: 1 },
      uHighlight: { value: cfg.highlight ? 1 : 0 },
      uLight: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGaze, uScleraC, uIrisC, uLight; uniform float uIrisCos, uPupilCos, uHighlight, uPupilScale;
      varying vec3 vDir;
      float aa(float d) { float w = max(fwidth(d), 1e-5); return smoothstep(-w, w, d); }
      float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1)), f.x), f.y), f.z); }
      void main() {
        vec3 fwd = vec3(0.0, 0.0, 1.0);
        vec3 g = normalize(uGaze);
        vec3 col;
        #ifdef PUP_BUTTON
          // a button is sewn on: it only tilts a little toward the gaze
          vec3 face = normalize(fwd + (g - fwd) * 0.35);
          float c = dot(vDir, face);
          float ang = acos(clamp(c, -1.0, 1.0));
          vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), face) + 1e-4), t2 = cross(face, t1);
          vec2 q = vec2(dot(vDir, t1), dot(vDir, t2));
          col = uIrisC * mix(0.82, 1.0, smoothstep(0.0, 0.6, ang));                  // dished centre
          col += (smoothstep(0.6, 0.7, ang) * (1.0 - smoothstep(0.86, 0.96, ang))) * (uIrisC * 0.5 + 0.06); // raised rim
          col = mix(col, uIrisC * 0.55, smoothstep(0.96, 1.02, ang));               // side of the button
          float hole = 0.0;
          for (int i = 0; i < 4; i++) { vec2 hp = vec2(i < 2 ? -0.17 : 0.17, mod(float(i), 2.0) < 0.5 ? -0.17 : 0.17); hole = max(hole, aa(0.065 - length(q - hp))); }
          float box = aa(0.19 - max(abs(q.x), abs(q.y)));
          float thread = max(aa(0.028 - abs(q.x - q.y) * 0.7071), aa(0.028 - abs(q.x + q.y) * 0.7071)) * box * step(0.0, c);
          col = mix(col, vec3(0.015), hole * (1.0 - thread));
          col = mix(col, uScleraC * (0.8 + 0.2 * n3(vDir * 180.0)), thread);
          float sp = dot(vDir, normalize(uLight + fwd));
          col = mix(col, vec3(1.0), aa(sp - 0.985) * 0.85 * uHighlight * (1.0 - thread));
        #elif defined(PUP_GOOGLY)
          col = uScleraC * mix(0.84, 1.0, smoothstep(-0.2, 0.9, dot(vDir, fwd)));
          float pr = acos(uIrisCos) * 0.8 * uPupilScale;
          float pc = dot(vDir, g);
          vec3 gs = normalize(g + vec3(0.0, -0.08, 0.0));
          col *= 1.0 - 0.18 * aa(dot(vDir, gs) - cos(pr * 1.12));                     // soft pupil shadow
          col = mix(col, uIrisC, aa(pc - cos(pr)));
          col *= mix(1.0, 0.8, smoothstep(1.15, 1.35, acos(clamp(dot(vDir, fwd), -1.0, 1.0)))); // dome rim
          // fixed dome reflections (the plastic dome doesn't move with the pupil)
          float s1 = dot(vDir, normalize(uLight * 0.8 + fwd));
          float s2 = dot(vDir, normalize(vec3(0.55, -0.35, 1.0)));
          col = mix(col, vec3(1.0), (aa(s1 - 0.975) + 0.6 * aa(s2 - 0.993)) * uHighlight);
        #else
          // felt: matte fibre disc, felt pupil with a fuzzy cut edge, a sewn highlight
          float fib = n3(vDir * 220.0) * 0.6 + n3(vDir * 60.0) * 0.4;
          col = uScleraC * mix(0.86, 1.02, fib);
          float pr = acos(uIrisCos) * 0.85 * uPupilScale;
          float edge = (n3(vDir * 90.0) - 0.5) * 0.05;
          float pupil = aa(dot(vDir, g) - cos(pr + edge));
          col = mix(col, uIrisC * mix(0.8, 1.3, fib), pupil);
          vec3 hd = normalize(g + normalize(vec3(-0.6, 0.8, 0.0)) * sin(pr * 0.45));
          col = mix(col, uScleraC * mix(0.9, 1.05, fib), aa(dot(vDir, hd) - cos(pr * 0.22)) * pupil * uHighlight);
        #endif
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Googly pupil: stays put in WORLD space while the head turns (so it lags and swings), falls with gravity, bounces off
 * the dome rim, and is gently pulled toward the tracked gaze so the performer can still "look".
 */
export class GooglyPupil {
  private p = new THREE.Vector2(0, -0.2);
  private v = new THREE.Vector2();
  private prevQ: THREE.Quaternion | null = null;
  private last = 0;
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();

  /** `gaze` = eye-local look direction; `group` = the eye's group. Returns the pupil direction (eye-local). */
  step(gaze: THREE.Vector3, group: THREE.Object3D): THREE.Vector3 {
    const now = performance.now();
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const q = group.getWorldQuaternion(this.tmpQ);
    // head rotation since last frame: carry the pupil's world direction back into eye space (it lags)
    const dir = this.dir(new THREE.Vector3());
    if (this.prevQ) {
      dir.applyQuaternion(this.prevQ).applyQuaternion(q.clone().invert());
      if (dir.z > 0.2) this.p.set(dir.x, dir.y);
    }
    this.prevQ = (this.prevQ ?? new THREE.Quaternion()).copy(q);
    const grav = this.tmpV.set(0, -1, 0).applyQuaternion(q.clone().invert());
    const ax = grav.x * 4.2 + (gaze.x * 0.55 - this.p.x) * 3.0;
    const ay = grav.y * 4.2 + (gaze.y * 0.55 - this.p.y) * 3.0;
    this.v.x += ax * dt; this.v.y += ay * dt;
    this.v.multiplyScalar(Math.exp(-2.2 * dt));
    this.p.addScaledVector(this.v, dt);
    const R = 0.5;
    const l = this.p.length();
    if (l > R) {
      const n = this.p.clone().multiplyScalar(1 / l);
      this.p.copy(n).multiplyScalar(R);
      const vn = this.v.dot(n);
      if (vn > 0) this.v.addScaledVector(n, -vn * 1.45); // bounce, losing energy
    }
    return this.dir(new THREE.Vector3());
  }

  private dir(out: THREE.Vector3) { return out.set(this.p.x, this.p.y, Math.sqrt(Math.max(0.05, 1 - this.p.lengthSq()))).normalize(); }
}

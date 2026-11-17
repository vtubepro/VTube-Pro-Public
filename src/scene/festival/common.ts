// Festival renderers: shared bits. Every effect material is ADDITIVE on colour and leaves the canvas ALPHA untouched
// (custom blending: colour = src·α + dst, alpha = dst), so the OBS passthrough hole (alpha 0 under the react screen) stays
// exactly transparent and the classic transparent output is never disturbed. Depth-tested, depth-write off, no fog,
// not tone-mapped. They are put on the glow layer, so on High / Ultra the room's bloom picks them up (docs/SCENES.md
// "Festival" → "Bloom").
import * as THREE from 'three';
import { GLOW_LAYER } from '../../stage/gfx/Graphics.ts';

export function fxMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, o: { side?: THREE.Side; additive?: boolean } = {}): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms, transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    side: o.side ?? THREE.FrontSide,
  });
  if (o.additive !== false) {
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  } else {
    // normal alpha blending for colour, canvas alpha untouched (smoke, confetti)
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendEquationAlpha = THREE.AddEquation; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  }
  return m;
}
/** Additive effects bloom on High / Ultra (the Graphics glow pass draws GLOW_LAYER objects). */
export function glow(o: THREE.Object3D) { o.layers.enable(GLOW_LAYER); return o; }

export const NOISE_GLSL = /* glsl */ `
float fhash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fhash(i + vec3(0,0,0)), fhash(i + vec3(1,0,0)), f.x), mix(fhash(i + vec3(0,1,0)), fhash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fhash(i + vec3(0,0,1)), fhash(i + vec3(1,0,1)), f.x), mix(fhash(i + vec3(0,1,1)), fhash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.15 * vnoise(p * 4.1 + 3.3); }
`;

/** sRGB 0..1 → linear (the shaders output linear light; three's output encoding converts). */
export const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** A soft round sprite (glare / particles), drawn once per page. */
let softTex: THREE.Texture | null = null;
export function softSprite(): THREE.Texture {
  if (softTex) return softTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  softTex = new THREE.CanvasTexture(c);
  return softTex;
}

/** A fixture as the rig knows it (from a room anchor, or the Look Lab's mini stage). */
export interface Fixture {
  kind: import('../../../shared/festival.ts').FxKind;
  group: string; index: number; name: string;
  /** world position / orientation of the anchor */
  pos: THREE.Vector3; quat: THREE.Quaternion;
  /** glTF extras (aim, length, pixels, width, height …) */
  extras: Record<string, unknown>;
  /** the anchor mesh (LED walls are meshes) */
  mesh: THREE.Mesh | null;
  /** normalised place in the rig (shared/festivalDirector.ts FixGeo) */
  geo: { x: number; y: number; z: number; i: number; n: number; seed: number };
  /** hung from a truss (true) or standing on a floor (false): from the anchor's +Y (glTF) */
  hung: boolean;
}

/** Direction from yaw (deg, 0 = +Z towards the crowd, + = towards +X) and pitch (deg above the horizon), in the
 *  ROOM frame (the caller applies the room root's rotation). */
export function aimDir(yawDeg: number, pitchDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const y = THREE.MathUtils.degToRad(yawDeg), p = THREE.MathUtils.degToRad(pitchDeg);
  return out.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
}

/** Camera-facing glare quads: the cheap stand-in for bloom on every lens (Medium and up). One instanced draw; the
 *  centre + size come from the instance matrix, the billboard turns in the vertex shader, only colours change per
 *  frame. */
export class Glare {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  constructor(max: number, name = 'festival:glare') {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = fxMaterial(/* glsl */ `
      varying vec2 vUv; varying vec3 vCol;
      void main() {
        vUv = uv;
        vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = length(instanceMatrix[0].xyz);
        vCol = instanceColor;
        c.xy += position.xy * s;
        gl_Position = projectionMatrix * c;
      }`, /* glsl */ `
      varying vec2 vUv; varying vec3 vCol;
      void main() {
        vec2 d = vUv - 0.5; float r = length(d);
        float core = exp(-r * r * 90.0), halo = exp(-r * 9.0) * 0.18, star = exp(-abs(d.x) * 60.0) * exp(-abs(d.y) * 5.0) * 0.5 + exp(-abs(d.y) * 60.0) * exp(-abs(d.x) * 5.0) * 0.5;
        float a = (core + halo + star) * smoothstep(0.5, 0.42, r);
        gl_FragColor = vec4(vCol * a, a);
      }`, {});
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, max) * 3), 3);
    // (not on the bloom layer: the sprite already is the lens's bloom - blooming it again turned every lit lens into a
    // big soft blob over the stage on High / Ultra)
    this.mesh.frustumCulled = false; this.mesh.name = name; this.mesh.renderOrder = 14; this.mesh.count = 0;
  }
  /** register a lens: returns its slot */
  add(pos: THREE.Vector3, size: number): number {
    if (this.n >= this.mesh.instanceMatrix.count) return -1;
    this.m.makeScale(size, size, size).setPosition(pos);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.count = ++this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    return this.n - 1;
  }
  move(slot: number, pos: THREE.Vector3, size: number) { if (slot < 0) return; this.m.makeScale(size, size, size).setPosition(pos); this.mesh.setMatrixAt(slot, this.m); this.mesh.instanceMatrix.needsUpdate = true; }
  set(slot: number, r: number, g: number, b: number) { if (slot < 0) return; const a = this.mesh.instanceColor!.array as Float32Array; a[slot * 3] = r; a[slot * 3 + 1] = g; a[slot * 3 + 2] = b; }
  commit() { this.mesh.instanceColor!.needsUpdate = true; }
  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

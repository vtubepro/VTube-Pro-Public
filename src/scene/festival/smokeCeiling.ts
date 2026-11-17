// The lit smoke over a festival stage and the haze halos round firing flames (docs/SCENES.md "Festival stages" →
// "Lit smoke"). The density + light model is shared/festivalSmoke.ts (pure, unit tested); this draws it:
//   layers  a warm smoke CEILING above and behind the rig (one instanced draw): two huge soft sheets behind the set rising
//           from below its roofline, two over it whose low edge stays above the rig's top - never a veil in front of the
//           stage. The smoke is dark (it hides the sky; its creases stay dark) and lit warm only where there is fire under
//           it (each flame head's light pooled along the stage) or shells bursting in it; a thick finale ceiling turns
//           orange-gold. A ceiling sheet seen from above (a drone over the rig) fades out.
//   halos   a soft glow round each firing flame head (one instanced draw), the size of the haze the fire lights
// The layers blend their colour over the picture and leave the canvas alpha untouched (common.ts fxMaterial, additive
// off): an OBS page's transparent pixels only gain the smoke's light, never coverage. They are drawn FIRST of the
// see-through things (renderOrder -2): whatever is in front of the smoke - a performer's hair edges, the room's glass,
// every beam, laser and firework (all additive) - draws over it, never under it. The halos are additive. The light is
// low-passed (>= 1 s) and passes the stage governor; a React screen up scales the smoke with the rest of the show. Hidden
// (no draw) while there is nothing to see; compiled ahead (warm) so a show that brings it never hitches; when a show that
// brought it ends it thins away (SMOKE_FALL), never vanishing in one frame.
import * as THREE from 'three';
import { NOISE_GLSL, fxMaterial, lin, type Fixture } from './common.ts';
import type { FestivalGov, GovOwner } from './gov.ts';
import { HALO, SMOKE_BINS, SMOKE_FALL, SMOKE_RISE, SmokeDensity, lightBins, smokeCover, smokeTones, smoothToward, type SmokeCfg } from '../../../shared/festivalSmoke.ts';

const LAYER_VS = /* glsl */ `
attribute vec4 aLayer;   // layer index, noise offset, opacity, 0 backdrop / 1 ceiling
uniform float uFire[${SMOKE_BINS}]; uniform float uShell[${SMOKE_BINS}]; uniform float uX0; uniform float uXW;
varying vec2 vUv; varying vec3 vWorld; varying vec4 vLayer; varying float vFire; varying float vShell;
void main() {
  vUv = uv; vLayer = aLayer;
  vec4 lp = instanceMatrix * vec4(position, 1.0);          // (the rig's frame: where the flames and the shells are)
  // the light along the sheet (per vertex: the sheets are cut in 32 along their width)
  float t = clamp((lp.x - uX0) / uXW, 0.0, 1.0) * ${(SMOKE_BINS - 1).toFixed(1)};
  float f = 0.0, s = 0.0;
  for (int i = 0; i < ${SMOKE_BINS}; i++) { float w = max(0.0, 1.0 - abs(t - float(i))); f += uFire[i] * w; s += uShell[i] * w; }
  vFire = f; vShell = s;
  vec4 wp = modelMatrix * lp;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const LAYER_FS = /* glsl */ `
uniform float uTime; uniform vec3 uFireCol; uniform vec3 uShellCol; uniform float uLight; uniform float uCover;
varying vec2 vUv; varying vec3 vWorld; varying vec4 vLayer; varying float vFire; varying float vShell;
${NOISE_GLSL}
void main() {
  // soft edges all round (a sheet must never show its border)
  float edge = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  // (a ceiling sheet seen from above fades: it is the ceiling over the rig, never a lid between a high camera and the stage)
  float under = vLayer.w > 0.5 ? smoothstep(-0.02, 0.1, normalize(vWorld - cameraPosition).y) : 1.0;
  vec3 q = vWorld * 0.045 + vec3(vLayer.y, 0.0, vLayer.y * 0.7) + vec3(uTime * 0.012, uTime * 0.006, -uTime * 0.009);
  // (two noise octaves + one detail: the sheets cover much of the frame - cheap per pixel)
  float n = 0.62 * vnoise(q) + 0.38 * vnoise(q * 2.03 + 7.1);
  float n2 = vnoise(q * 2.7 + 11.0);
  float body = smoothstep(0.25, 0.72, n * 0.8 + n2 * 0.35);       // the smoke's cover: rolling billows
  float crown = smoothstep(0.45, 0.95, n * 0.55 + n2 * 0.6);      // their crowns catch the light; the creases stay dark
  float low = 1.0 - vUv.y;
  // (the fire is under it: a backdrop's low edge, a ceiling's front underside; the shells burst high: the upper smoke)
  float fk = vLayer.w > 0.5 ? 0.55 + 0.45 * low : 0.15 + 0.85 * low * low;
  float sk = 0.5 + 0.5 * vUv.y;
  vec3 light = (uFireCol * (vFire * fk * 0.9) + uShellCol * (vShell * sk * 0.8)) * uLight * (0.2 + 0.8 * crown);
  float a = edge * body * vLayer.z * uCover * under;
  // the smoke itself: a dark warm grey-brown (linear) - it darkens the sky it hides; the light only where it falls
  gl_FragColor = vec4(vec3(0.0055, 0.0042, 0.0036) + light, a);
}`;
const HALO_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol;
void main() {
  vUv = uv; vCol = instanceColor;
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(instanceMatrix[0].xyz);
  c.xy += position.xy * s;
  gl_Position = projectionMatrix * c;
}`;
// (additive: the blend multiplies by the alpha once - the colour goes out as it is)
const HALO_FS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol;
void main() { vec2 d = vUv - 0.5; float r2 = dot(d, d) * 4.0; float e = smoothstep(1.0, 0.7, r2); gl_FragColor = vec4(vCol, exp(-r2 * 6.4) * e * e); }`;

const TF = [0, 0, 0], TS = [0, 0, 0], L = [0, 0, 0];
/** how long the smoke keeps glowing after a shot / a burst (s) */
const HOLD_S = 3;
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), C = new THREE.Color();

export interface SmokeFrameIn {
  dt: number; time: number;
  /** pyro events this frame: shell bursts, flame volleys, comet fans */
  shells: number; volleys: number; fans: number;
  /** the shells' sky light (0..1, governed) and their colour (sRGB) */
  sky: number; skyCol: readonly number[];
  /** the show's level now (lighting state x intensity x the React step-back) and the haze */
  level: number; haze: number;
  /** each flame head's level now (0..1.5) */
  headLevel: (i: number) => number;
  gov: FestivalGov;
}

export class SmokeCeiling {
  readonly group = new THREE.Group();
  readonly density: SmokeDensity;
  private layers: THREE.InstancedMesh; private layerMat: THREE.ShaderMaterial;
  private halos: THREE.InstancedMesh | null = null;
  private heads: { f: Fixture; up: THREE.Vector3; size: number }[] = [];
  /** each head's light pooled along the smoke (heads x SMOKE_BINS), the shells' (SMOKE_BINS) */
  private headW: Float32Array; private shellW = new Float32Array(SMOKE_BINS);
  /** the fire per bin as the smoke remembers it (a peak fading over ~3 s: smoke glows on between shots), the shells' */
  private fireHold = new Float32Array(SMOKE_BINS); private skyHold = 0; private hl: Float32Array;
  private o: GovOwner = {};
  private disposables: { dispose(): void }[] = [];
  /** the light per bin as drawn (low-passed) - the shader's uniforms */
  readonly fireBins = new Float32Array(SMOKE_BINS); readonly shellBins = new Float32Array(SMOKE_BINS);
  /** how much of the sky it covers now (0..1, low-passed) and its drawn brightness at the brightest spot (debug / tests) */
  cover = 0; shown = 0;
  /** a show that brought it ended: it thins away, then `done` (the rig disposes it) */
  fadeOut = false; done = false;

  constructor(readonly cfg: SmokeCfg, box: THREE.Box3, deckY: number, flameHeads: Fixture[], flameSize: number, shellXs: readonly number[] = []) {
    this.group.name = 'festival:smoke';
    this.density = new SmokeDensity(cfg);
    const W = Math.max(10, box.max.x - box.min.x), cx = (box.min.x + box.max.x) / 2;
    const H = Math.max(6, box.max.y - deckY), back = box.min.z, front = box.max.z;
    const sheets: { pos: THREE.Vector3; rotX: number; w: number; h: number; layer: [number, number, number, number] }[] = [];
    const y0 = deckY + cfg.low * H, y1 = deckY + cfg.high * H;
    // behind the set: two backdrops rising from below its roofline (the set stands in front of them)
    [6, 20].forEach((dz, k) => sheets.push({ pos: new THREE.Vector3(cx, (y0 + y1) / 2 + k * 0.08 * H, back - dz), rotX: 0, w: W * cfg.width * (1 + 0.15 * k), h: (y1 - y0) * (1 + 0.1 * k), layer: [k, 13.7 * k + 1.3, 0.8 - 0.12 * k, 0] }));
    // over it: two ceiling sheets - the low (front) edge above the rig's top and a little out over the deck, rising toward
    // the back - from below they read as the ceiling over the rig
    for (let k = 0; k < 2; k++) {
      const th = 0.3 + 0.15 * k, h = Math.max(H, front - back + 0.6 * H), yF = deckY + (1.04 + 0.1 * k) * H, zF = front + 0.1 * H;
      sheets.push({ pos: new THREE.Vector3(cx, yF + (h / 2) * Math.sin(th), zF - (h / 2) * Math.cos(th)), rotX: -Math.PI / 2 + th, w: W * cfg.width * 0.95, h, layer: [2 + k, 41.3 + 7 * k, 0.55, 1] });
    }
    const geo = new THREE.PlaneGeometry(1, 1, 32, 1);
    const la = new Float32Array(sheets.length * 4);
    sheets.forEach((s, i) => la.set(s.layer, i * 4));
    geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(la, 4));
    const XW = Math.max(...sheets.map((s) => s.w)), X0 = cx - XW / 2;
    this.layerMat = fxMaterial(LAYER_VS, LAYER_FS, {
      uTime: { value: 0 }, uFireCol: { value: new THREE.Vector3() }, uShellCol: { value: new THREE.Vector3() }, uLight: { value: 0 }, uCover: { value: 0 },
      uFire: { value: this.fireBins }, uShell: { value: this.shellBins }, uX0: { value: X0 }, uXW: { value: XW },
    }, { side: THREE.DoubleSide, additive: false });
    this.layers = new THREE.InstancedMesh(geo, this.layerMat, sheets.length);
    sheets.forEach((s, i) => { Q.setFromEuler(new THREE.Euler(s.rotX, 0, 0)); M4.compose(s.pos, Q, S.set(s.w, s.h, 1)); this.layers.setMatrixAt(i, M4); });
    this.layers.frustumCulled = false; this.layers.renderOrder = -2; this.layers.name = 'festival:smoke-layers'; this.layers.visible = false;
    this.group.add(this.layers); this.disposables.push(geo, this.layerMat);
    // where the light falls along the smoke: a pool ~8 % of its width round each flame head; the shells round their mortars
    const sigma = Math.max(3, 0.08 * XW);
    this.headW = new Float32Array(flameHeads.length * SMOKE_BINS); this.hl = new Float32Array(flameHeads.length);
    const one = new Float32Array(SMOKE_BINS);
    flameHeads.forEach((f, k) => { lightBins([f.pos.x], X0, XW, sigma, one); this.headW.set(one, k * SMOKE_BINS); });
    lightBins(shellXs, X0, XW, 1.5 * sigma, this.shellW);
    // halos: a soft glow per flame head, up its firing axis (the middle of a column), 2.5 x the flame's width across
    if (flameHeads.length && cfg.halo > 0) {
      this.heads = flameHeads.map((f) => ({ f, up: new THREE.Vector3(0, 1, 0).applyQuaternion(f.quat).normalize(), size: flameSize }));
      const hg = new THREE.PlaneGeometry(1, 1);
      const hm = fxMaterial(HALO_VS, HALO_FS, {});
      this.halos = new THREE.InstancedMesh(hg, hm, this.heads.length);
      this.halos.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.heads.length * 3), 3);
      // (the quad is 2.5 flame widths across: the gaussian glow reads as a halo ~2.5 widths out, the corners cost nothing)
      this.heads.forEach((h, i) => { P.copy(h.f.pos).addScaledVector(h.up, h.size * 1.2); M4.compose(P, Q.identity(), S.setScalar(h.size * 2.5)); this.halos!.setMatrixAt(i, M4); });
      this.halos.frustumCulled = false; this.halos.renderOrder = 7; this.halos.name = 'festival:smoke-halos'; this.halos.visible = false;
      this.group.add(this.halos); this.disposables.push(hg, hm);
    }
  }

  /** compile its shaders ahead (they are hidden until there is something to see - three skips hidden objects) */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene) {
    const lv = this.layers.visible, hv = this.halos?.visible ?? false;
    this.layers.visible = true; if (this.halos) this.halos.visible = true;
    try { void (renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> }).compileAsync?.(this.group, camera, scene)?.catch(() => {}); } catch { /* optional */ }
    this.layers.visible = lv; if (this.halos) this.halos.visible = hv;
  }

  update(i: SmokeFrameIn) {
    const d = this.density, dt = Math.max(0, i.dt), out = this.fadeOut;
    d.add(out ? 0 : i.shells, out ? 0 : i.volleys, out ? 0 : i.fans);
    d.step(dt);
    // the light along the smoke: each head's level pooled round it, held ~3 s (smoke glows on between shots), then
    // low-passed (rises over ~1.2 s, falls over ~2.5 s) - never a flash on the large area it covers
    const fade = Math.exp(-dt / HOLD_S), hl = this.hl, nh = hl.length;
    for (let k = 0; k < nh; k++) hl[k] = out ? 0 : Math.min(1.5, i.headLevel(k));
    this.skyHold = Math.max(this.skyHold * fade, out ? 0 : Math.min(1, i.sky * 1.6));
    let fMax = 0, sMax = 0;
    for (let b = 0; b < SMOKE_BINS; b++) {
      let v = 0;
      for (let k = 0; k < nh; k++) v += hl[k] * this.headW[k * SMOKE_BINS + b];
      this.fireHold[b] = Math.max(this.fireHold[b] * fade, Math.min(1, v * 0.6));
      const fw = this.fireHold[b], sw = this.skyHold * this.shellW[b];
      this.fireBins[b] = smoothToward(this.fireBins[b], fw, dt, fw > this.fireBins[b] ? SMOKE_RISE : SMOKE_FALL);
      this.shellBins[b] = smoothToward(this.shellBins[b], sw, dt, sw > this.shellBins[b] ? SMOKE_RISE : SMOKE_FALL);
      fMax = Math.max(fMax, this.fireBins[b]); sMax = Math.max(sMax, this.shellBins[b]);
    }
    // how much of the sky it hides (low-passed too): the density, the show's level (a React screen up: stepped back)
    const lvl = out ? 0 : Math.min(1.2, i.level), hz = 0.6 + 0.4 * Math.min(1, i.haze / 0.7);
    const cw = smokeCover(d.d, this.cfg.base) * Math.min(1, lvl);
    this.cover = smoothToward(this.cover, cw, dt, cw > this.cover ? SMOKE_RISE : SMOKE_FALL);
    // the governor sees the brightest spot: its colour (normalised to its brightest channel) and its level
    smokeTones(i.skyCol, d.d, TF, TS);
    for (let k = 0; k < 3; k++) L[k] = TF[k] * fMax * 0.9 + TS[k] * sMax * 0.8;
    const peak = Math.max(L[0], L[1], L[2]), amp = this.cfg.gain * lvl * hz;
    const want = this.cover * amp * Math.min(1, peak), n = peak > 1e-4 ? 1 / peak : 0;
    const lv = i.gov.out(this.o, want, Math.min(1, L[0] * n), Math.min(1, L[1] * n), Math.min(1, L[2] * n));
    const U = this.layerMat.uniforms;
    U.uTime.value = i.time; U.uCover.value = this.cover;
    U.uLight.value = want > 1e-6 ? amp * (lv / want) : 0;
    const fc = U.uFireCol.value as THREE.Vector3, sc = U.uShellCol.value as THREE.Vector3;
    // (the governor held the colour - a red low-pass: both tones take its colour)
    if (n > 0 && (Math.abs(i.gov.r - Math.min(1, L[0] * n)) > 1e-6 || Math.abs(i.gov.g - Math.min(1, L[1] * n)) > 1e-6 || Math.abs(i.gov.b - Math.min(1, L[2] * n)) > 1e-6)) { fc.set(lin(i.gov.r), lin(i.gov.g), lin(i.gov.b)); sc.copy(fc); }
    else { fc.set(lin(TF[0]), lin(TF[1]), lin(TF[2])); sc.set(lin(TS[0]), lin(TS[1]), lin(TS[2])); }
    this.shown = this.cover * (U.uLight.value as number) * Math.min(1, peak);
    this.layers.visible = this.cover > 0.004;
    // halos: each head's (governed) level, warm, scaled with the haze
    let any = false;
    if (this.halos) {
      const hk = this.cfg.halo * 0.16 * lvl * Math.min(1, i.haze / 0.6 + 0.3);
      const hr = lin(HALO[0]), hgc = lin(HALO[1]), hb = lin(HALO[2]);
      for (let k = 0; k < this.heads.length; k++) {
        const v = Math.min(1.2, hl[k]) * hk;
        if (v > 0.002) any = true;
        C.setRGB(hr * v, hgc * v, hb * v); this.halos.setColorAt(k, C);
      }
      this.halos.instanceColor!.needsUpdate = true;
      this.halos.visible = any;
    }
    if (out && this.cover < 0.004 && this.shown < 0.002) this.done = true;
  }

  dispose() { for (const x of this.disposables) x.dispose(); this.group.removeFromParent(); }
}

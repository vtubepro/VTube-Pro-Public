// Screen surface shader shared by the big react SCREEN and the solo side screen: a CRT/projector power-on
// (black → a bright line snaps open → scanline flicker → picture) and the OBS passthrough "hole" that fades
// open (alpha → 0) only once the camera has settled, so a fixed Window Capture rect lines up.
//
//   power 0..1  – 0 = off (black panel), 1 = fully on
//   open  0..1  – OBS: 1 = transparent hole (the Window Capture below shows through); preview: 1 = the picture
//   style       – power-on look (room skins, src/scene/screenSkins.ts): 0 CRT (above), 1 hologram (scan bands flicker
//                 in, cyan tint), 2 shimmer (a rippling reveal from the centre, violet edge glow), 3 fade (projector lamp
//                 warms up, dithered). Styles 1–3 are invisible while unpowered (the skin's own frame / glass shows).
//                 Every style ends on the same fully-on picture, so the hole / in-scene content never depends on the skin.
//
// NoBlending + depthWrite: the RGBA written here IS the pixel, so avatars in front still cover the hole.
import * as THREE from 'three';
import { coverUniforms } from './capcover/uniforms.ts';
import { pageGovernor } from '../../shared/flashGovernor.ts';

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const frag = /* glsl */ `
uniform sampler2D uMap;
// uSafe = the flash limit is on (shared/flashGovernor.ts): the power-on's 16-24 Hz random flicker / band popping on
// a whole screen would count as flashing — steady (or 2.5 Hz) instead
uniform float uHasMap, uPower, uOpen, uTime, uHole, uScan, uGlass, uStyle, uDecode, uSafe;
uniform vec2 uFlip;
uniform vec4 uFit;   // 'contain' fit of the source inside the surface: content uv = (uv - uFit.zw) / uFit.xy
uniform sampler2D uCover; uniform float uCoverOn, uCapSurf;   // capture cover (src/scene/capcover): drawn over the WHOLE surface
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 uv = vec2(uFlip.x > 0.5 ? 1.0 - vUv.x : vUv.x, uFlip.y > 0.5 ? 1.0 - vUv.y : vUv.y);
  float p = clamp(uPower, 0.0, 1.0);
  if (uStyle > 0.5 && p <= 0.001) discard;                  // skinned styles: nothing drawn while unpowered
  float row = floor(uv.y * 64.0);
  if (uStyle > 0.5 && uStyle < 1.5 && p < 0.999) uv.x += (hash(vec2(row, floor(uTime * 30.0) + 7.0)) - 0.5) * 0.035 * (1.0 - p);
  if (uStyle > 1.5 && uStyle < 2.5 && p < 0.999) {
    vec2 dd = uv - 0.5;
    float dl = length(dd * vec2(1.78, 1.0));
    uv += dd / max(dl, 1e-3) * sin(dl * 38.0 - uTime * 9.0) * 0.006 * (1.0 - smoothstep(0.6, 1.0, p));
  }
  // CRT: a dot stretches into a horizontal line (0..0.12), the line opens vertically (0.12..0.32)
  float hx = smoothstep(0.0, 0.12, p) * 0.5;
  float vy = mix(0.003, 0.5, pow(smoothstep(0.12, 0.32, p), 1.6));
  float band = step(abs(uv.x - 0.5), hx) * step(abs(uv.y - 0.5), vy);
  vec2 cu = (uv - uFit.zw) / uFit.xy;
  float inside = step(0.0, cu.x) * step(cu.x, 1.0) * step(0.0, cu.y) * step(cu.y, 1.0);
  vec3 content = uHasMap > 0.5 ? texture2D(uMap, clamp(cu, 0.0, 1.0)).rgb * inside : vec3(0.012, 0.016, 0.024);
  // video textures (a shared window, the fast feed, the screen video) are uploaded WITHOUT sRGB decoding (three.js
  // decodes them in its own materials' shaders only): decode here, else they're sRGB-encoded twice (washed out)
  if (uDecode > 0.5) content = sRGBTransferEOTF(vec4(content, 1.0)).rgb;
  vec4 cov = uCoverOn > 0.5 && uCapSurf > 0.5 ? texture2D(uCover, clamp(uv, 0.0, 1.0)) : vec4(0.0);
  content = mix(content, cov.rgb, cov.a);
  float settle = smoothstep(0.32, 1.0, p);
  float scan = 0.72 + 0.28 * sin(uv.y * 820.0 - uTime * 36.0);
  float flick = mix(0.55 + 0.9 * mix(hash(vec2(floor(uTime * 24.0), 3.1)), 0.35, uSafe), 1.0, settle * settle);
  float roll = smoothstep(0.0, 0.04, abs(fract(uv.y * 1.5 + uTime * 0.9) - 0.5)) * 0.25 + 0.75;
  float grain = (hash(uv * 512.0 + fract(uTime * 7.0)) - 0.5) * 0.4 * (1.0 - settle);
  vec3 hot = vec3(0.72, 0.93, 1.0) * (1.8 - 1.4 * smoothstep(0.1, 0.35, p));   // the bright CRT line
  vec3 tv = mix(vec3(0.05, 0.09, 0.12), content, 0.4 + 0.6 * settle) * scan * flick * mix(roll, 1.0, settle);
  // unpowered: matte grey screen fabric with a soft vertical sheen (never a dead-black hole)
  vec3 matte = vec3(0.075, 0.08, 0.09) * (0.85 + 0.3 * smoothstep(0.0, 1.0, uv.y)) * (0.9 + 0.1 * sin(uv.x * 3.14159));
  vec3 col = mix(matte, mix(hot, tv, smoothstep(0.12, 0.45, p)) + grain, band);
  if (uStyle > 0.5) {
    float s = smoothstep(0.0, 1.0, p);
    if (uStyle < 1.5) {
      // hologram: scan bands pop in at random until every row is lit, cyan-tinted until fully on
      if (p < 0.999 && hash(vec2(row, floor(uTime * mix(24.0, 2.5, uSafe)))) > p * 1.25 - 0.08) discard;
      vec3 tint = vec3(0.35, 0.85, 1.0);
      float lum = dot(content, vec3(0.3, 0.59, 0.11));
      col = mix(tint * (0.2 + lum * 1.3), content, s * s) * (1.0 - 0.25 * (1.0 - s) * (0.5 + 0.5 * sin(uv.y * 900.0 - uTime * 40.0)));
      col += tint * 0.6 * (1.0 - s) * step(abs(fract(uv.y * 3.0 - uTime * 2.0) - 0.5), 0.015);
    } else if (uStyle < 2.5) {
      // shimmer: the picture spreads out from the centre behind a glowing violet / gold rim
      float dl = length((uv - 0.5) * vec2(1.78, 1.0));
      float front = p * 1.1;
      if (p < 0.999 && dl > front) discard;
      float edge = smoothstep(0.14, 0.0, front - dl) * (1.0 - smoothstep(0.85, 1.0, p));
      col = content * (0.55 + 0.45 * s) + vec3(0.62, 0.4, 1.0) * edge * 1.5 + vec3(1.0, 0.82, 0.45) * edge * edge * 0.8;
    } else {
      // fade: a projector lamp warming up (dithered in, a little flicker until it's steady)
      if (p < 0.999 && ign(gl_FragCoord.xy) > p * 1.05) discard;
      float lamp = mix(0.55 + 0.45 * mix(hash(vec2(floor(uTime * 16.0), 1.7)), 0.5, uSafe), 1.0, s);
      col = content * lamp;
    }
  }
  float a = 1.0;
  if (uHole > 0.5) {
    float o = clamp(uOpen, 0.0, 1.0);
    a = 1.0 - o; col *= a;
    // capture cover over the OBS hole: premultiplied 'over' (opaque while the cover holds — nothing of the capture shows)
    float ca = cov.a * o;
    col = col * (1.0 - ca) + cov.rgb * ca; a = a * (1.0 - ca) + ca;
  }
  else {
    // in-scene content: optional faint scanlines + a soft glass sheen (a diagonal highlight, brighter at the top)
    vec3 shown = content * (1.0 - uScan * 0.07 * (0.5 + 0.5 * sin(uv.y * 1400.0)));
    // (multiplicative: it lifts the picture's highlights a little and never greys out its blacks — an added linear
    // 0.07 used to read as ~30 % grey over dark content, washing the whole window out)
    float sheen = smoothstep(0.35, 0.0, abs(uv.x * 0.8 + (1.0 - uv.y) * 0.6 - 0.55)) * 0.07 + (1.0 - uv.y) * 0.025;
    shown *= 1.0 + uGlass * sheen * 1.6;
    col = mix(col, shown, clamp(uOpen, 0.0, 1.0));
    // React screens: alpha 1 + how far the picture is up = "verbatim" for the post pipeline (src/stage/post/Pipeline.ts:
    // no grade / LUT, haze, AO, vignette, bloom or shafts on the window). A canvas clamps it to 1.
    a = 1.0 + uCapSurf * clamp(uOpen, 0.0, 1.0);
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), a);
  #include <colorspace_fragment>
}`;

/** three.js uploads a VideoTexture / VideoFrameTexture as plain RGBA8 (never SRGB8_ALPHA8) and only its built-in
 *  materials decode it (DECODE_VIDEO_TEXTURE): a ShaderMaterial sampling one must apply sRGBTransferEOTF itself. */
export function needsVideoDecode(t: THREE.Texture | null | undefined): boolean {
  return !!t && (t as THREE.VideoTexture).isVideoTexture === true && THREE.ColorManagement.getTransfer(t.colorSpace) === THREE.SRGBTransfer;
}

export class ScreenFx {
  readonly material: THREE.ShaderMaterial;
  /** `capture`: a screen that shows the host's capture (React screens) — the capture cover draws on it; chat monitors etc. never. */
  constructor(hole: boolean, capture = false) {
    this.material = new THREE.ShaderMaterial({
      name: 'vtp:screenFx',
      uniforms: {
        uMap: { value: null }, uHasMap: { value: 0 }, uPower: { value: 0 }, uOpen: { value: 0 },
        uCover: coverUniforms.uCover, uCoverOn: coverUniforms.uCoverOn, uCapSurf: { value: capture ? 1 : 0 },
        uTime: { value: 0 }, uSafe: { value: 1 }, uHole: { value: hole ? 1 : 0 }, uFlip: { value: new THREE.Vector2(0, 0) }, uScan: { value: 0 }, uGlass: { value: 0 }, uFit: { value: new THREE.Vector4(1, 1, 0, 0) }, uStyle: { value: 0 }, uDecode: { value: 0 },
      },
      vertexShader: vert, fragmentShader: frag,
      blending: THREE.NoBlending, depthWrite: true, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
    });
  }
  set hole(v: boolean) { this.material.uniforms.uHole.value = v ? 1 : 0; }
  get hole() { return this.material.uniforms.uHole.value > 0.5; }
  setMap(t: THREE.Texture | null) { const U = this.material.uniforms; U.uMap.value = t; U.uHasMap.value = t ? 1 : 0; U.uDecode.value = needsVideoDecode(t) ? 1 : 0; }
  /** Letterbox a source of this aspect inside a surface of that aspect (null = fill). */
  setFit(src: number | null, surface: number) {
    const f = this.material.uniforms.uFit.value as THREE.Vector4;
    if (!src || !surface) { f.set(1, 1, 0, 0); return; }
    const r = src / surface;
    if (r > 1) f.set(1, 1 / r, 0, (1 - 1 / r) / 2); else f.set(r, 1, (1 - r) / 2, 0);
  }
  setExtras(scanlines: boolean, glass: boolean) { this.material.uniforms.uScan.value = scanlines ? 1 : 0; this.material.uniforms.uGlass.value = glass ? 1 : 0; }
  /** Power-on look: 0 crt, 1 hologram, 2 shimmer, 3 fade. */
  setStyle(s: 'crt' | 'hologram' | 'shimmer' | 'fade') { this.material.uniforms.uStyle.value = { crt: 0, hologram: 1, shimmer: 2, fade: 3 }[s] ?? 0; }
  setFlip(u: boolean, v: boolean) { (this.material.uniforms.uFlip.value as THREE.Vector2).set(u ? 1 : 0, v ? 1 : 0); }
  set(power: number, open: number, time: number) {
    const U = this.material.uniforms;
    U.uPower.value = power; U.uOpen.value = open; U.uTime.value = time; U.uSafe.value = pageGovernor().safe ? 1 : 0;
  }
  dispose() { this.material.dispose(); }
}

/** Power / hole sequencing shared by both screens: power-on once landed, hole once the camera settled. */
export class PowerSeq {
  power = 0;
  open = 0;
  /** Seconds of power-on / hole fade. */
  constructor(private onDur = 0.55, private openDur = 0.3, private offDur = 0.28, private closeDur = 0.2) {}
  /** landed: the screen is fully down; settled: the camera is at its react pose. Returns true while "off" is complete. */
  step(dt: number, want: boolean, landed: boolean, settled: boolean) {
    if (want && landed) {
      this.power = Math.min(1, this.power + dt / this.onDur);
      // the hole is only open while the camera is still (a camera move closes it, it reopens once settled)
      if (this.power >= 1 && settled) this.open = Math.min(1, this.open + dt / this.openDur);
      else if (!settled && this.open > 0) this.open = Math.max(0, this.open - dt / this.closeDur);
    } else {
      // close the hole first, then switch the tube off
      if (this.open > 0) this.open = Math.max(0, this.open - dt / this.closeDur);
      else this.power = Math.max(0, this.power - dt / this.offDur);
    }
    return this.power <= 0 && this.open <= 0;
  }
  finish(want: boolean) { this.power = want ? 1 : 0; this.open = want ? 1 : 0; }
}

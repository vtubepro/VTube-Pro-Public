// The TV performer's screen: their live video as a lit-looking CRT / flat panel picture (also used for "the feed
// elsewhere": interview monitors, gaming-strip tiles — fx 'clean').
//
//  * fit: cover (crop to fill, default) / contain (letterbox) of the feed aspect inside the surface aspect; mirror
//  * chroma key (VTube Studio's coloured background): distance in CbCr from the key colour → alpha, soft edge,
//    spill suppression (the key's chroma is pulled out of kept edge pixels) — over a themed procedural backdrop
//  * per-skin look: scanlines, barrel curvature (CRT), glow, vignette, a SUBTLE glass sheen (faces must read)
//  * signal: live → stalled (frozen frame, tearing + chroma shift "bad signal") → lost (static + NO SIGNAL card)
//  * power-on: the CRT dot → line → picture when the feed first arrives
//  * Spout2 real alpha (TvInfo.pack, shared/spout.ts): the frame is [premultiplied colour | gutter | alpha as grey];
//    the shader samples both halves (clamped half a texel inside each, so the halves never bleed), remaps the codec's
//    alpha noise, clamps colour ≤ alpha (no haze, no fringe) and composites premultiplied over the backdrop
// NoBlending, alpha 1: the OBS output is transparent, a screen must never punch a hole into it.
// fx 'standee' is the exception: the model itself stands in the room (src/scene/tv/tvStandee.ts) — no backdrop, no TV
// look, alpha-blended (straight colour + alpha, three's normal blending, so OBS's transparent output stays correct).
import * as THREE from 'three';
import { TV_BACKDROPS, tvSkin, type TvInfo } from '../../../shared/tv.ts';
import { coverOffset, faceOnSurface, type FaceBox } from '../../../shared/framing.ts';
import { needsVideoDecode } from '../screenFx.ts';

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const frag = /* glsl */ `
uniform sampler2D uMap, uCard;
uniform float uDecode;
uniform float uHas, uFeedAspect, uSurfAspect, uFit, uMirror, uTime, uPower;
uniform vec2 uFitOff;     // cover fit: the window follows the face (TvInfo.face, shared/framing.ts coverOffset)
uniform vec4 uKey;        // rgb (sRGB 0..1), on
uniform vec3 uKeyP;       // similarity, smoothness, spill
uniform float uBg;        // backdrop index
uniform vec3 uBgTint;     // skin accent (linear)
uniform vec4 uLook;       // scan, curve, glow, vignette
uniform float uGlass;
uniform float uBad, uLost; // stalled 0..1, lost 0..1
uniform vec2 uFlip;
uniform vec3 uPack;       // Spout2 side-by-side alpha: on, colour width c, alpha start a (fractions of the frame width)
uniform vec2 uTexel;      // 1 / feed size (px)
uniform float uStandee;   // 1 = the standee cut-out: output colour + alpha, no backdrop / TV look
uniform vec3 uOffCol;     // the unpowered surface (TV glass: near black; projector fabric: light grey)        // the mesh's UVs run right→left / top→bottom (glTF screens)
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec2 cbcr(vec3 c) { return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b); }

// packed Spout2 frame → linear premultiplied colour + alpha (shared/spout.ts: alphaRemap, premulClamp)
vec4 packedAt(vec2 fu) {
  vec2 q = clamp(fu, 0.0, 1.0);
  float hx = uTexel.x * 0.5;
  float cx = clamp(q.x * uPack.y, hx, uPack.y - hx);
  float ax = clamp(uPack.z + q.x * (1.0 - uPack.z), uPack.z + hx, 1.0 - hx);
  vec3 c = texture2D(uMap, vec2(cx, q.y)).rgb;
  vec3 ag = texture2D(uMap, vec2(ax, q.y)).rgb;
  float a = dot(ag, vec3(0.299, 0.587, 0.114));
  if (uDecode > 0.5) c = sRGBTransferEOTF(vec4(c, 1.0)).rgb;          // (video textures arrive undecoded: the alpha is raw)
  else a = sRGBTransferOETF(vec4(vec3(a), 1.0)).r;                    // (a decoded texture: take the alpha back to its bytes)
  float ar = clamp((a - ${(6 / 255).toFixed(6)}) / ${((249 - 6) / 255).toFixed(6)}, 0.0, 1.0);
  c *= a > 1e-4 ? ar / a : 0.0;                                       // (premultiplied by the raw alpha: same rescale)
  return vec4(min(max(c, vec3(0.0)), vec3(ar)), ar);
}

vec3 backdrop(vec2 uv) {
  float t = uTime;
  if (uBg < 0.5) {            // studio: soft coloured glow + a light sweep
    vec2 d = uv - vec2(0.5, 0.42);
    float g = exp(-dot(d, d) * 5.0);
    vec3 c = mix(vec3(0.05, 0.04, 0.12), uBgTint * 0.9 + vec3(0.15, 0.08, 0.3), g);
    c += 0.05 * smoothstep(0.08, 0.0, abs(fract(uv.x * 0.7 - uv.y * 0.3 + t * 0.05) - 0.5));
    return c;
  } else if (uBg < 1.5) {     // sunset
    vec3 top = vec3(0.12, 0.05, 0.28), mid = vec3(0.95, 0.35, 0.45), low = vec3(1.0, 0.72, 0.3);
    vec3 c = uv.y > 0.45 ? mix(mid, top, smoothstep(0.45, 1.0, uv.y)) : mix(low, mid, smoothstep(0.0, 0.45, uv.y));
    float sun = smoothstep(0.2, 0.18, length((uv - vec2(0.5, 0.3)) * vec2(1.3, 1.0)));
    return mix(toLin(c), toLin(vec3(1.0, 0.9, 0.6)), sun * 0.8);
  } else if (uBg < 2.5) {     // retro grid
    vec3 c = toLin(mix(vec3(0.02, 0.0, 0.08), vec3(0.35, 0.05, 0.4), smoothstep(0.0, 0.6, uv.y)));
    if (uv.y < 0.45) {
      float z = 0.45 / max(0.45 - uv.y, 0.02);
      vec2 g = vec2((uv.x - 0.5) * z, z + t * 0.8);
      float line = max(smoothstep(0.06, 0.0, abs(fract(g.x) - 0.5) - 0.44), smoothstep(0.08, 0.0, abs(fract(g.y) - 0.5) - 0.42));
      c += vec3(0.9, 0.2, 0.8) * line * 0.6 * smoothstep(0.0, 0.3, 0.45 - uv.y + 0.05);
    }
    return c;
  } else if (uBg < 3.5) {     // night sky
    vec3 c = toLin(mix(vec3(0.01, 0.02, 0.06), vec3(0.06, 0.08, 0.2), uv.y));
    vec2 cell = floor(uv * 60.0);
    float s = step(0.985, hash(cell)) * (0.6 + 0.4 * sin(t * 2.0 + hash(cell + 3.0) * 20.0));
    return c + vec3(s);
  }
  return toLin(mix(vec3(0.06), vec3(0.12), uv.y));   // plain
}

void main() {
  vec2 uv = vec2(uFlip.x > 0.5 ? 1.0 - vUv.x : vUv.x, uFlip.y > 0.5 ? 1.0 - vUv.y : vUv.y);
  // CRT barrel curvature (the picture bulges; the corners fall off into the bezel)
  vec2 cc = uv - 0.5;
  float curve = uLook.y * 0.22;
  vec2 cuv = cc * (1.0 + curve * dot(cc, cc) * 4.0) * (1.0 - curve * 0.25) + 0.5;
  float edge = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
  // bad signal: horizontal tearing + a rolling offset
  float row = floor(cuv.y * 90.0);
  float tear = uBad * (hash(vec2(row, floor(uTime * 20.0))) - 0.5) * 0.06 * step(0.7, hash(vec2(floor(uTime * 7.0), row * 0.1)));
  vec2 puv = cuv + vec2(tear, 0.0);
  // fit the feed inside the surface: content uv
  float r = uFeedAspect / max(uSurfAspect, 1e-3);
  vec2 f = vec2(1.0);
  if (uFit < 0.5) { if (r > 1.0) f.x = 1.0 / r; else f.y = r; }      // cover: show a centred window of the feed
  else { if (r > 1.0) f.y = r; else f.x = 1.0 / r; }                 // contain: the feed shrinks inside
  vec2 fu = (puv - 0.5) * f + 0.5;
  if (uMirror > 0.5) fu.x = 1.0 - fu.x;
  fu += uFitOff;
  float inside = step(0.0, fu.x) * step(fu.x, 1.0) * step(0.0, fu.y) * step(fu.y, 1.0);
  vec3 bg = uStandee > 0.5 ? vec3(0.0) : backdrop(cuv);
  vec3 col = bg;
  float outA = 0.0;       // standee: how much of the model covers this pixel
  if (uHas > 0.5 && uPack.x > 0.5) {
    vec4 pm = packedAt(fu);
    if (uBad > 0.01) pm.r = min(packedAt(fu + vec2(0.006 * uBad, 0.0)).r, pm.a);
    float a = pm.a * inside;
    col = pm.rgb * inside + bg * (1.0 - a);
    outA = a;
  } else if (uHas > 0.5) {
    vec3 px = texture2D(uMap, clamp(fu, 0.0, 1.0)).rgb;
    // chroma shift while the signal is bad
    if (uBad > 0.01) { px.r = texture2D(uMap, clamp(fu + vec2(0.006 * uBad, 0.0), 0.0, 1.0)).r; }
    if (uDecode > 0.5) px = sRGBTransferEOTF(vec4(px, 1.0)).rgb;   // sRGB video textures arrive undecoded (else: encoded twice, a grey wash)
    float a = inside;
    if (uKey.w > 0.5) {
      vec3 ps = pow(max(px, vec3(0.0)), vec3(1.0 / 2.2));             // key in sRGB space like OBS
      vec2 d = cbcr(ps) - cbcr(uKey.rgb);
      float dist = length(d);
      float k = smoothstep(uKeyP.x, uKeyP.x + max(uKeyP.y, 1e-3), dist);
      a *= k;
      // spill: remove the key's chroma direction from what's kept (the green fringe on hair edges)
      vec2 kd = normalize(cbcr(uKey.rgb) + 1e-5);
      vec2 pc = cbcr(ps);
      float along = max(0.0, dot(pc, kd));
      vec2 fixedC = pc - kd * along * uKeyP.z * (1.0 - k * 0.5);
      float y = dot(ps, vec3(0.299, 0.587, 0.114));
      vec3 rgb = vec3(y + 1.402 * fixedC.y, y - 0.344136 * fixedC.x - 0.714136 * fixedC.y, y + 1.772 * fixedC.x);
      px = toLin(clamp(rgb, 0.0, 1.0));
    }
    col = mix(bg, px, a);
    outA = a;
    if (uStandee > 0.5) col = px * a;   // (premultiplied, like the packed branch)
  }
  if (uStandee > 0.5) {
    // the cut-out: fades in with the power-on, a frozen frame shivers while stalled, gone when lost — no TV look
    float vis = smoothstep(0.0, 1.0, uPower) * (1.0 - uLost);
    float a = outA * vis;
    if (a < 0.002) discard;
    gl_FragColor = vec4(col * vis / a, a);
    #include <colorspace_fragment>
    return;
  }
  // lost: static + the NO SIGNAL card; stalled: a grain veil over the frozen frame
  float n = hash(cuv * vec2(320.0, 240.0) + fract(uTime * 13.7));
  vec3 stat = vec3(n * 0.75 + 0.1) * (0.85 + 0.15 * sin(cuv.y * 400.0 + uTime * 80.0));
  float roll = smoothstep(0.0, 0.08, abs(fract(cuv.y + uTime * 0.35) - 0.5)) * 0.35 + 0.65;
  col = mix(col, stat * roll * 0.5, uBad * 0.25);
  vec4 card = texture2D(uCard, cuv);
  vec3 lostCol = mix(stat * roll * 0.55, card.rgb, card.a * (0.75 + 0.25 * step(0.5, fract(uTime * 0.8))));
  col = mix(col, lostCol, uLost);
  // look: scanlines, glow, vignette, glass (subtle — the picture is a face)
  col *= 1.0 - uLook.x * 0.22 * (0.5 + 0.5 * sin(cuv.y * 900.0));
  col *= 1.0 + uLook.z * 0.35;
  vec2 v = cuv - 0.5;
  col *= mix(1.0, smoothstep(0.85, 0.2, length(v * vec2(1.1, 1.25))), uLook.w * 0.6);
  float sheen = smoothstep(0.3, 0.0, abs(uv.x * 0.8 + (1.0 - uv.y) * 0.6 - 0.62)) * 0.06 + (1.0 - uv.y) * 0.02;
  col *= 1.0 + uGlass * sheen * 1.6;                                  // (multiplicative: never greys out the blacks)
  // power-on: dot → line → picture
  float p = clamp(uPower, 0.0, 1.0);
  float hx = smoothstep(0.0, 0.2, p) * 0.5, vy = mix(0.004, 0.5, pow(smoothstep(0.2, 0.55, p), 1.6));
  float band = step(abs(uv.x - 0.5), hx) * step(abs(uv.y - 0.5), vy);
  vec3 off = uOffCol * (0.8 + 0.4 * uv.y);
  vec3 hot = vec3(0.75, 0.95, 1.0) * 1.6;
  col = mix(off, mix(hot, col, smoothstep(0.2, 0.7, p)), band);
  col *= edge;
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <colorspace_fragment>
}`;

let cardTex: THREE.CanvasTexture | null = null;
/** "NO SIGNAL" card (shared by every screen). */
function noSignalCard(): THREE.CanvasTexture {
  if (cardTex) return cardTex;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 384;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 512, 384);
  g.fillStyle = 'rgba(8,10,40,0.82)';
  g.fillRect(96, 150, 320, 84);
  g.font = '700 46px system-ui, Segoe UI, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#e8eefc';
  g.fillText('NO SIGNAL', 256, 194);
  cardTex = new THREE.CanvasTexture(c);
  cardTex.colorSpace = THREE.SRGBColorSpace;
  return cardTex;
}

export type ScreenFxKind = 'tv' | 'clean' | 'projector' | 'standee';

export class TvScreenMaterial {
  readonly material: THREE.ShaderMaterial;
  private power = 0;
  private bad = 0;
  private lost = 1;
  constructor(info: TvInfo, surfaceAspect: number, fx: ScreenFxKind = 'tv') {
    this.material = new THREE.ShaderMaterial({
      name: 'vtp:tvScreen',
      uniforms: {
        uMap: { value: null }, uDecode: { value: 0 }, uCard: { value: noSignalCard() }, uHas: { value: 0 }, uFeedAspect: { value: info.aspect }, uSurfAspect: { value: surfaceAspect },
        uFit: { value: 0 }, uMirror: { value: 0 }, uTime: { value: 0 }, uPower: { value: 0 }, uFitOff: { value: new THREE.Vector2() },
        uPack: { value: new THREE.Vector3() }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) }, uStandee: { value: 0 },
        uKey: { value: new THREE.Vector4(0, 1, 0, 0) }, uKeyP: { value: new THREE.Vector3(0.34, 0.08, 0.5) }, uBg: { value: 0 }, uBgTint: { value: new THREE.Color() },
        uLook: { value: new THREE.Vector4() }, uGlass: { value: 0 }, uBad: { value: 0 }, uLost: { value: 1 }, uFlip: { value: new THREE.Vector2() }, uOffCol: { value: new THREE.Color(0.012, 0.014, 0.018) },
      },
      vertexShader: vert, fragmentShader: frag,
      blending: THREE.NoBlending, depthWrite: true, depthTest: true, toneMapped: false,
    });
    this.material.userData.setAspect = (a: number) => { this.material.uniforms.uSurfAspect.value = a; this.refit(); };
    if (fx === 'standee') {
      // alpha-blended cut-out (straight colour + alpha out; three's normal blending keeps OBS's transparent output right)
      Object.assign(this.material, { transparent: true, blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide });
    }
    this.setInfo(info, fx);
  }
  setInfo(info: TvInfo, fx: ScreenFxKind = 'tv') {
    const U = this.material.uniforms, s = tvSkin(info.skin);
    this.face = fx === 'standee' ? null : info.face ?? null; this.fit = info.fit; this.mirror = info.mirror;
    U.uFit.value = info.fit === 'contain' ? 1 : 0;
    U.uMirror.value = info.mirror ? 1 : 0;
    const k = info.chroma;
    (U.uKey.value as THREE.Vector4).set(k?.color[0] ?? 0, k?.color[1] ?? 1, k?.color[2] ?? 0, k && info.kind === 'vts' && !info.pack ? 1 : 0);
    this.pack = info.pack ?? null;
    (U.uPack.value as THREE.Vector3).set(info.pack ? 1 : 0, info.pack?.c ?? 0.5, info.pack?.a ?? 0.5);
    U.uStandee.value = fx === 'standee' ? 1 : 0;
    (U.uKeyP.value as THREE.Vector3).set(k?.similarity ?? 0.34, k?.smoothness ?? 0.08, k?.spill ?? 0.5);
    U.uBg.value = Math.max(0, TV_BACKDROPS.findIndex((b) => b.id === info.bg));
    (U.uBgTint.value as THREE.Color).set(s.accent);
    const clean = fx !== 'tv';
    if (fx === 'standee') { (U.uLook.value as THREE.Vector4).set(0, 0, 0, 0); U.uGlass.value = 0; U.uBg.value = 0; if (!U.uHas.value) U.uFeedAspect.value = info.aspect; this.refit(); return; }
    // projector: a projected picture — no scanlines / curvature / glass, a soft hot-spot falloff, a fabric-grey when off
    (U.uLook.value as THREE.Vector4).set(clean ? 0 : s.scan, clean ? 0 : s.curve, fx === 'projector' ? 0.02 : clean ? 0.05 : s.glow, fx === 'projector' ? 0.3 : clean ? 0 : s.vignette);
    U.uGlass.value = clean ? 0 : s.glass;
    if (fx === 'projector') (U.uOffCol.value as THREE.Color).setRGB(0.42, 0.43, 0.45); else (U.uOffCol.value as THREE.Color).setRGB(0.012, 0.014, 0.018);
    if (!U.uHas.value) U.uFeedAspect.value = info.aspect;
    this.refit();
  }
  /** The face box (TvInfo.face) and the fit it is followed with. */
  private face: FaceBox | null = null;
  private fit: 'cover' | 'contain' = 'cover';
  private mirror = false;
  /** Cover fit: slide the window so the face stays inside the screen's safe area (framing guarantee). */
  private refit() {
    const U = this.material.uniforms;
    const o = this.fit === 'cover' && this.face ? coverOffset(U.uFeedAspect.value as number, U.uSurfAspect.value as number, this.face) : null;
    (U.uFitOff.value as THREE.Vector2).set(o ? o.ox : 0, o ? o.oy : 0);
  }
  /** Where the face is drawn on the surface (uv, y up) and its height (fraction of the surface), or null. */
  faceOnScreen(): { u: number; v: number; h: number } | null {
    const U = this.material.uniforms;
    return faceOnSurface(this.face, U.uFeedAspect.value as number, U.uSurfAspect.value as number, this.fit, this.mirror);
  }
  setFlip(u: boolean, v: boolean) { (this.material.uniforms.uFlip.value as THREE.Vector2).set(u ? 1 : 0, v ? 1 : 0); }
  private pack: TvInfo['pack'] | null = null;
  /** The feed's texture + its FRAME aspect (w / h of the video) and size in px (for the packed halves' clamping). A packed
   *  Spout2 frame shows only its colour half: the picture aspect is the frame's × pack.c. */
  setMap(t: THREE.Texture | null, aspect: number | null, size?: { w: number; h: number } | null) {
    const U = this.material.uniforms;
    U.uMap.value = t; U.uHas.value = t ? 1 : 0; U.uDecode.value = needsVideoDecode(t) ? 1 : 0;
    if (aspect && Number.isFinite(aspect)) U.uFeedAspect.value = this.pack ? aspect * this.pack.c : aspect;
    if (size && size.w > 1 && size.h > 1) (U.uTexel.value as THREE.Vector2).set(1 / size.w, 1 / size.h);
    if (this.face) this.refit();
  }
  /** The picture aspect currently shown (after unpacking). */
  get feedAspect(): number { return this.material.uniforms.uFeedAspect.value as number; }
  /** Per frame: feed state → power-on / bad-signal / lost blends. */
  step(dt: number, time: number, state: 'none' | 'connecting' | 'live' | 'stalled' | 'lost', gate = true) {
    const U = this.material.uniforms;
    const on = gate && (state === 'live' || state === 'stalled');
    this.power = on ? Math.min(1, this.power + dt / 0.6) : gate && state === 'lost' ? 1 : Math.max(0, this.power - dt / 0.4);
    const ease = (v: number, to: number, r: number) => v + (to - v) * Math.min(1, dt * r);
    this.bad = ease(this.bad, state === 'stalled' ? 1 : 0, 6);
    this.lost = ease(this.lost, state === 'lost' || state === 'none' || state === 'connecting' ? 1 : 0, state === 'lost' ? 3 : 8);
    U.uPower.value = this.power; U.uBad.value = this.bad; U.uLost.value = this.lost; U.uTime.value = time;
  }
  dispose() { this.material.dispose(); }
}

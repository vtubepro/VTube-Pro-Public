// The stage layout's 2D frame, drawn by one full-screen shader (two passes) on the page's own canvas — no render
// targets, no extra shader variants of the room / avatar materials (tiles are plain scissored renders).
//
//   pass 0 'solid'  (blending off → exact straight alpha for OBS): composite views: the styled backdrop everywhere,
//                   the capture rect punched to alpha 0 (or its closed "glass" while a layout morphs), docks' glass,
//                   drop shadows, tile bezels; 3d views: only the tile bezels. Pixels inside a tile are discarded.
//   pass 1 'edges'  (normal blending): the anti-aliased inner edge of every bezel over its tile render, the outer edge
//                   + soft shadow over the room render (3d views), the speaking glow, the line-up test pattern labels.
//   pass 2 'under'  (destination-over): inside cut-out cams and see-through (opacity < 1) cams, what pass 0 would have
//                   drawn there (backdrop, docks, the hole's veil) + the cut-out's drop shadow / outline, BEHIND the
//                   avatar (its alpha from a copy of the canvas: copyCut) - a cut-out never punches a hole in the backdrop.
//   pass 3 'fade'   (alpha multiply): the picture of a cam with opacity < 1 (layout look, shared/layoutLook.ts).
//
// Rects arrive in device px, bottom-left origin (gl_FragCoord space).
import * as THREE from 'three';
import { samePalette, type StagePalette } from '../../../shared/stage.ts';
import { coverUniforms } from '../capcover/uniforms.ts';
import { needsVideoDecode } from '../screenFx.ts';

export const MAX_TILES = 16;

const PATTERNS = ['grid', 'scan', 'runes', 'hex', 'dots', 'stripes'];
const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
precision highp float;
uniform vec2 uRes;
uniform float uTime, uPass, uView, uAlpha, uScale, uTest, uPattern;
uniform vec4 uCap; uniform vec4 uCapP;           // rect · (radius, open 0..1 (1 = hole), mode 0 none / 1 hole / 2 video, 0)
uniform vec4 uTiles[${MAX_TILES}]; uniform vec4 uTileP[${MAX_TILES}];  // rect · (radius, bezel, hero, speak)
uniform vec4 uTileQ[${MAX_TILES}];               // (alpha 0..1, cutout 0/1, steady glow 0..1, picture opacity 0..1)
uniform int uTileN;
uniform vec4 uDocks[2]; uniform vec4 uDockP[2];  // rect · (radius, alpha, 0, 0)
uniform vec3 uBg0, uBg1, uGlass, uAcc, uAcc2, uHero;
uniform vec4 uLook;                              // backdrop opacity, backdrop dim, backdrop blur, screen dim (layout look)
uniform vec4 uLook2;                             // capture ring + shadow, docked panels' opacity, cam drop shadow, 0
uniform sampler2D uCut; uniform vec4 uCutP;      // canvas copy (cut-out alpha) · (outline px, shadow 0..1, shadow px, on)
uniform vec3 uOutC;                              // cut-out outline colour
varying vec2 vUv;

float sdBox(vec2 p, vec4 r, float rad) {
  vec2 c = r.xy + r.zw * 0.5, h = r.zw * 0.5;
  vec2 q = abs(p - c) - h + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }            // 1 inside (d<0), AA over one pixel

vec3 backdrop(vec2 p) {
  vec2 uv = p / uRes;
  vec3 c = mix(uBg1, uBg0, smoothstep(0.0, 1.0, uv.y));
  // soft vignette + a slow light sweep
  float v = length((uv - vec2(0.5, 0.55)) * vec2(uRes.x / uRes.y, 1.0));
  c *= 1.0 - 0.35 * smoothstep(0.35, 1.25, v);
  float sw = sin((uv.x * 1.6 + uv.y * 0.9) * 3.14159 - uTime * 0.18);
  float soft = 1.0 - uLook.z;                                     // look: blur flattens the sweep + the pattern
  c += uAcc * 0.028 * smoothstep(0.6, 1.0, sw) * soft;
  // faint pattern in the accent colour (design px)
  vec2 d = p / uScale;
  float pat = 0.0;
  if (uPattern < 0.5) { vec2 g = abs(fract(d / 48.0) - 0.5); pat = smoothstep(0.485, 0.5, max(g.x, g.y)); }
  else if (uPattern < 1.5) { pat = 0.5 + 0.5 * sin(d.y * 0.9); pat = smoothstep(0.85, 1.0, pat) * 0.6; }
  else if (uPattern < 2.5) { vec2 g = fract(d / 64.0) - 0.5; pat = smoothstep(0.02, 0.0, abs(length(g) - 0.32)) * 0.8; }
  else if (uPattern < 3.5) { vec2 q = d / 40.0; q.x += mod(floor(q.y), 2.0) * 0.5; vec2 g = abs(fract(q) - 0.5); pat = smoothstep(0.47, 0.5, max(g.x * 1.15, g.y)); }
  else if (uPattern < 4.5) { vec2 g = fract(d / 22.0) - 0.5; pat = smoothstep(0.12, 0.08, length(g)); }
  else { pat = smoothstep(0.45, 0.5, abs(fract((d.x + d.y) / 36.0) - 0.5)) * 0.7; }
  c += uAcc * pat * 0.045 * soft;
  c *= 1.0 - uLook.y;                                             // look: dim
  c += (hash(p + uTime) - 0.5) / 255.0;                           // dither (no banding on dark gradients)
  return c;
}

/** Straight-alpha "over": paint (sc, sa) over (c, a). */
void over(inout vec3 c, inout float a, vec3 sc, float sa) {
  float na = sa + a * (1.0 - sa);
  c = na > 1e-5 ? (sc * sa + c * a * (1.0 - sa)) / na : sc;
  a = na;
}

/** The cut-out picture's alpha at p (the canvas copy), 0 outside cut-out cams. */
float cutA(vec2 p) {
  for (int i = 0; i < ${MAX_TILES}; i++) {
    if (i >= uTileN) break;
    vec4 q = uTileQ[i]; vec4 r = uTiles[i];
    if (q.y < 0.5 || q.x <= 0.0) continue;
    if (p.x >= r.x && p.y >= r.y && p.x < r.x + r.z && p.y < r.y + r.w) return texture2D(uCut, p / uRes).a;
  }
  return 0.0;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float px = 1.0;
  // ---- tiles: inside → the tile render stays; the bezel ring (+ glow) around it
  float tileIn = 0.0;                                             // coverage of any tile's inner (picture) area
  float ring = 0.0; vec3 ringC = uAcc; float shadow = 0.0; float glow = 0.0; vec3 glowC = uAcc2;
  float underIn = 0.0;                                            // inside a cut-out / see-through cam (pass 2 draws behind it)
  float cutIn = 0.0;                                              // inside a cut-out cam
  float fadeOp = 1.0;                                             // the picture opacity of the cam here (pass 3)
  for (int i = 0; i < ${MAX_TILES}; i++) {
    if (i >= uTileN) break;
    vec4 r = uTiles[i]; vec4 pr = uTileP[i]; vec4 q = uTileQ[i];
    float a = q.x;
    float dIn = sdBox(p, r, pr.x);
    float dOut = sdBox(p, vec4(r.xy - pr.y, r.zw + 2.0 * pr.y), pr.x + pr.y);
    tileIn = max(tileIn, cov(dIn) * a);
    // (cut-out cams: no bezel, no shadow — just the avatar standing on the capture)
    float cut = q.y;
    if (a > 0.0 && (cut > 0.5 || q.w < 0.999)) underIn = max(underIn, cov(dIn));
    if (a > 0.0 && cut > 0.5) cutIn = max(cutIn, cov(dIn));
    if (a > 0.0 && dIn < 0.0) fadeOp = min(fadeOp, q.w);
    float rg = cov(dOut) * (1.0 - cov(dIn)) * a * (1.0 - cut);
    vec3 rc = mix(mix(uGlass * 1.8 + uAcc * 0.18, uHero, pr.z), uAcc2, clamp(pr.w, 0.0, 1.0) * 0.85);
    if (rg > ring) { ring = rg; ringC = rc; }
    // soft drop shadow below / glow when speaking (+ the look's steady glow)
    float ds = sdBox(p + vec2(0.0, 7.0 * uScale), vec4(r.xy - pr.y, r.zw + 2.0 * pr.y), pr.x + pr.y);
    shadow = max(shadow, (1.0 - smoothstep(0.0, 26.0 * uScale, ds)) * 0.55 * a * (1.0 - cut) * uLook2.z);
    glow = max(glow, (1.0 - smoothstep(0.0, 18.0 * uScale, dOut)) * max(clamp(pr.w, 0.0, 1.0), q.z) * a * (1.0 - cut));
  }
  // ---- pass 3: a see-through cam's picture (alpha x opacity; colours stay: straight alpha)
  if (uPass > 2.5) { if (fadeOp > 0.999) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, fadeOp); return; }
  // ---- capture rect
  float capIn = 0.0; float capRing = 0.0;
  if (uCapP.z > 0.5) {
    float d = sdBox(p, uCap, uCapP.x);
    capIn = cov(d);
    capRing = cov(sdBox(p, vec4(uCap.xy - 3.0 * uScale, uCap.zw + 6.0 * uScale), uCapP.x + 3.0 * uScale)) * (1.0 - capIn) * uLook2.x;
    shadow = max(shadow, (1.0 - smoothstep(0.0, 40.0 * uScale, d)) * 0.5 * (1.0 - capIn) * uLook2.x);
  }
  // ---- docks' glass
  float dockIn = 0.0; float dockRing = 0.0;
  for (int i = 0; i < 2; i++) {
    vec4 r = uDocks[i]; vec4 pr = uDockP[i];
    if (r.z <= 0.0 || pr.y <= 0.0) continue;
    float d = sdBox(p, r, pr.x);
    float op = pr.y * uLook2.y;                                   // (look: the docked panels' opacity)
    dockIn = max(dockIn, cov(d) * op);
    dockRing = max(dockRing, cov(sdBox(p, vec4(r.xy - 2.0 * uScale, r.zw + 4.0 * uScale), pr.x + 2.0 * uScale)) * (1.0 - cov(d)) * op);
    shadow = max(shadow, (1.0 - smoothstep(0.0, 24.0 * uScale, d)) * 0.45 * op * (1.0 - cov(d)));
  }

  bool under = uPass > 1.5;
  if (under && (underIn <= 0.001 || uView < 0.5)) discard;
  if (uPass < 0.5 || under) {
    // ===== solid pass (no blending): every pixel it keeps is fully defined here. The under pass (2) computes the same
    // picture inside cut-out / see-through cams (as if the cam weren't there) + the cut-out's shadow and outline, and
    // is blended destination-over: behind the avatar.
    if (!under && tileIn > 0.001) discard;                        // the tile render (its AA edge: pass 1)
    if (uView < 0.5) {
      // 3d view: only the solid part of the bezels (+ the line-up test on the room's screen); the room render stays
      if (ring >= 0.999) { gl_FragColor = vec4(ringC, 1.0); return; }
      if (uTest > 0.0 && uCapP.z > 0.5) {
        vec2 uv = (p - uCap.xy) / uCap.zw;
        vec2 g = abs(fract(uv * vec2(16.0, 9.0)) - 0.5);
        float lines = smoothstep(0.47, 0.5, max(g.x, g.y)) * capIn;
        float edge = cov(abs(sdBox(p, uCap, 0.0)) - 1.5 * uScale);
        if (edge > 0.02) { gl_FragColor = vec4(1.0, 0.25, 0.8, edge * uTest); return; }
        if (lines > 0.02) { gl_FragColor = vec4(0.2, 1.0, 0.55, lines * 0.85 * uTest); return; }
      }
      discard;
    }
    // (layered straight-alpha "over": with the backdrop at full opacity this is exactly the old opaque mix)
    vec3 c = backdrop(p);
    float a = uLook.x;
    over(c, a, vec3(0.0), shadow * 0.6);
    over(c, a, uGlass, dockIn * 0.92);
    over(c, a, uAcc * 0.55 + uGlass, dockRing * 0.9);
    over(c, a, mix(uAcc, uAcc2, 0.35), capRing * 0.85);
    over(c, a, ringC, ring);
    c += glowC * glow * 0.35; a = max(a, glow * 0.35);
    float alpha = uAlpha * a;
    if (capIn > 0.0) {
      if (uCapP.z < 1.5) {
        // hole: fully transparent once open; while a layout morphs it is closed "screen glass"; the look's screen dim
        // is a black veil over the open hole (OBS shows the capture darker)
        vec2 uv = (p - uCap.xy) / uCap.zw;
        vec3 glass = mix(uGlass * 0.6, uGlass * 1.4 + uAcc * 0.05, uv.y) + uAcc * 0.05 * smoothstep(0.93, 1.0, sin(uv.y * 240.0));
        float open = uCapP.y;
        float shut = 1.0 - open, veil = uLook.w * open;
        float ha = shut + veil * (1.0 - shut);
        vec3 hc = ha > 1e-4 ? glass * shut / ha : glass;
        c = mix(c, hc, capIn);
        alpha = mix(alpha, ha, capIn);
        // line-up test: a grid + crosshair inside the hole (see-through) and brackets at the corners
        if (uTest > 0.0) {
          vec2 g = abs(fract(uv * vec2(16.0, 9.0)) - 0.5);
          float lines = smoothstep(0.47, 0.5, max(g.x, g.y));
          float cross = smoothstep(2.0 * uScale, 0.0, min(abs(p.x - (uCap.x + uCap.z * 0.5)), abs(p.y - (uCap.y + uCap.w * 0.5))));
          float t = max(lines * 0.7, cross);
          c = mix(c, vec3(0.2, 1.0, 0.55), t * capIn * uTest);
          alpha = max(alpha, t * 0.85 * capIn * uTest);
          float edge = cov(abs(sdBox(p, uCap, 0.0)) - 1.5 * uScale);
          c = mix(c, vec3(1.0, 0.25, 0.8), edge * uTest);
          alpha = max(alpha, edge * uTest);
        }
      } else if (!under) discard;                                 // video: drawn by its own quad
      else alpha *= 1.0 - capIn;
    }
    if (under) {
      // the cut-out's drop shadow (down-right, soft) and outline (a dilation of its alpha), inside its cam only
      if (cutIn > 0.0 && uCutP.w > 0.5) {
        if (uCutP.y > 0.0) {
          vec2 o = p + vec2(-0.45, 1.0) * uCutP.z;
          float rr = max(1.0, uCutP.z * 0.7), sh = 0.0;
          for (int k = 0; k < 9; k++) { float an = float(k) * 0.6981; sh += cutA(o + (k == 0 ? vec2(0.0) : vec2(cos(an), sin(an)) * rr)); }
          over(c, alpha, vec3(0.0), clamp(sh / 9.0 * uCutP.y * 0.9, 0.0, 1.0) * cutIn);
        }
        if (uCutP.x > 0.25) {
          float dil = 0.0;
          for (int k = 0; k < 16; k++) {
            float an = float(k) * 0.3927;
            vec2 dv = vec2(cos(an), sin(an));
            dil = max(dil, cutA(p + dv * uCutP.x));
            dil = max(dil, cutA(p + dv * uCutP.x * 0.5));
          }
          over(c, alpha, uOutC, clamp(dil, 0.0, 1.0) * cutIn);
        }
      }
      if (alpha <= 0.002) discard;
      gl_FragColor = vec4(c, alpha);
      return;
    }
    gl_FragColor = vec4(c, alpha);
    return;
  }
  // ===== edges pass (normal blending)
  float a = 0.0; vec3 c = ringC;
  if (tileIn > 0.001 && tileIn < 0.999 && ring > 0.0) { a = 1.0 - tileIn; }     // AA inner bezel edge over the tile picture
  if (uView < 0.5) {
    if (ring > 0.001 && ring < 0.999 && tileIn <= 0.001) a = max(a, ring);   // AA outer edge over the room
    if (a <= 0.0 && ring <= 0.0 && tileIn <= 0.001) {
      // shadow + speaking glow over the room render, docks' rim
      float sh = shadow * 0.55;
      if (glow > 0.01) { gl_FragColor = vec4(glowC, glow * 0.6); return; }
      if (dockRing > 0.01) { gl_FragColor = vec4(uAcc * 0.8 + uGlass, dockRing * 0.85); return; }
      if (sh > 0.01) { gl_FragColor = vec4(0.0, 0.0, 0.0, sh); return; }
      discard;
    }
  }
  if (a <= 0.001) discard;
  gl_FragColor = vec4(c, a);
}`;

/** The two passes + the video quad, drawn with an orthographic full-screen triangle. */
export class FrameFx {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  /** In-scene capture (a video / feed texture) drawn contain-fit in the capture rect. */
  readonly video: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private videoScene = new THREE.Scene();

  constructor() {
    const v4 = () => Array.from({ length: MAX_TILES }, () => new THREE.Vector4());
    this.uniforms = {
      uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uPass: { value: 0 }, uView: { value: 1 }, uAlpha: { value: 1 }, uScale: { value: 1 }, uTest: { value: 0 }, uPattern: { value: 0 },
      uCap: { value: new THREE.Vector4() }, uCapP: { value: new THREE.Vector4() },
      uTiles: { value: v4() }, uTileP: { value: v4() }, uTileQ: { value: v4() }, uTileN: { value: 0 },
      uDocks: { value: [new THREE.Vector4(), new THREE.Vector4()] }, uDockP: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uBg0: { value: new THREE.Color() }, uBg1: { value: new THREE.Color() }, uGlass: { value: new THREE.Color() }, uAcc: { value: new THREE.Color() }, uAcc2: { value: new THREE.Color() }, uHero: { value: new THREE.Color() },
      uLook: { value: new THREE.Vector4(1, 0, 0, 0) }, uLook2: { value: new THREE.Vector4(1, 1, 1, 0) },
      uCut: { value: null }, uCutP: { value: new THREE.Vector4() }, uOutC: { value: new THREE.Color(1, 1, 1) },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending, toneMapped: false });
    // one triangle covering the screen
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    const vm = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uDecode: { value: 0 }, uFit: { value: new THREE.Vector4(1, 1, 0, 0) }, uRect: { value: new THREE.Vector4() }, uR: { value: 0 },
        uTiles: this.uniforms.uTiles, uTileP: this.uniforms.uTileP, uTileQ: this.uniforms.uTileQ, uTileN: this.uniforms.uTileN, uLook: this.uniforms.uLook, uMode: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      // contain-fit: black bars inside the rect, never stretched; rounded corners like the hole
      fragmentShader: `precision highp float; uniform sampler2D uTex; uniform float uDecode; uniform vec4 uFit; uniform vec4 uRect; uniform float uR; varying vec2 vUv;
        uniform vec4 uTiles[${MAX_TILES}]; uniform vec4 uTileP[${MAX_TILES}]; uniform vec4 uTileQ[${MAX_TILES}]; uniform int uTileN; uniform vec4 uLook; uniform float uMode;
        float sdBox(vec2 p, vec4 r, float rad){ vec2 c=r.xy+r.zw*0.5,h=r.zw*0.5; vec2 q=abs(p-c)-h+rad; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-rad; }
        void main(){ vec2 p = gl_FragCoord.xy; if (sdBox(p, uRect, uR) > 0.5) discard;
          // (drawn after the cams: never over them — Full's cams stand in front of the window). Mode 1: only inside
          // cut-out / see-through cams, blended destination-over (behind the avatar)
          float behind = 0.0;
          for (int i = 0; i < ${MAX_TILES}; i++) { if (i >= uTileN) break; if (sdBox(p, uTiles[i], uTileP[i].x) < 0.0) { if (uMode < 0.5) discard; vec4 q = uTileQ[i]; if (q.x > 0.0 && (q.y > 0.5 || q.w < 0.999)) behind = 1.0; } }
          if (uMode > 0.5 && behind < 0.5) discard;
          vec2 uv = (p - uRect.xy) / uRect.zw; vec2 t = (uv - uFit.zw) / uFit.xy;
          vec3 c = (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) ? vec3(0.0) : texture2D(uTex, t).rgb;
          // (video textures arrive undecoded: decode once, the output encode below re-encodes — never twice)
          if (uDecode > 0.5) c = sRGBTransferEOTF(vec4(c, 1.0)).rgb;
          c *= 1.0 - uLook.w;                                       // look: screen dim
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.video = new THREE.Mesh(g, vm);
    this.video.frustumCulled = false;
    this.videoScene.add(this.video);
  }

  private palSnap: StagePalette | null = null;
  setPalette(p: StagePalette) {
    if (samePalette(this.palSnap, p)) return;   // unchanged (called every frame): skip the 6 colour parses
    this.palSnap = { ...p };
    const u = this.uniforms;
    // (sRGB hex written straight out: the shader outputs display values, no colour management)
    for (const [k, v] of [['uBg0', p.bg0], ['uBg1', p.bg1], ['uGlass', p.glass], ['uAcc', p.accent], ['uAcc2', p.accent2], ['uHero', p.hero]] as const) (u[k].value as THREE.Color).setStyle(v, THREE.LinearSRGBColorSpace);
    u.uPattern.value = PATTERNS.indexOf(p.pattern);
  }

  /** `blend`: pass 0 over a room render that is fading out (3d ↔ composite morph). */
  draw(renderer: THREE.WebGLRenderer, pass: 0 | 1, blend = false) {
    this.uniforms.uPass.value = pass;
    this.mat.blending = pass === 0 && !blend ? THREE.NoBlending : THREE.NormalBlending;
    this.mat.transparent = pass === 1;
    renderer.render(this.scene, this.camera);
  }

  /** Pass 2 (behind cut-out / see-through cams, destination-over) or pass 3 (a see-through cam's picture alpha x
   *  opacity). Same shader + uniforms as passes 0 / 1 (no new program: blending is render state). */
  drawUnder(renderer: THREE.WebGLRenderer, pass: 2 | 3) {
    const m = this.mat;
    this.uniforms.uPass.value = pass;
    m.blending = THREE.CustomBlending; m.transparent = true;
    m.blendEquation = THREE.AddEquation; m.blendEquationAlpha = THREE.AddEquation;
    if (pass === 2) { m.blendSrc = THREE.OneMinusDstAlphaFactor; m.blendDst = THREE.DstAlphaFactor; m.blendSrcAlpha = THREE.OneMinusDstAlphaFactor; m.blendDstAlpha = THREE.OneFactor; }
    else { m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.SrcAlphaFactor; }
    renderer.render(this.scene, this.camera);
  }

  /** The canvas as it is now (the cams just drawn) -> uCut, for the cut-out outline / shadow. Drawing-buffer sized. */
  private cutTex: THREE.FramebufferTexture | null = null;
  copyCut(renderer: THREE.WebGLRenderer, w: number, h: number) {
    if (!this.cutTex || this.cutTex.image.width !== w || this.cutTex.image.height !== h) {
      this.cutTex?.dispose();
      this.cutTex = new THREE.FramebufferTexture(w, h);
      this.cutTex.minFilter = this.cutTex.magFilter = THREE.NearestFilter;
      this.cutTex.generateMipmaps = false;
    }
    renderer.copyFramebufferToTexture(this.cutTex);
    this.uniforms.uCut.value = this.cutTex;
  }
  /** Free the canvas copy (no cut-out with an outline / shadow on screen). */
  dropCut() { if (this.cutTex) { this.cutTex.dispose(); this.cutTex = null; this.uniforms.uCut.value = null; } }

  drawVideo(renderer: THREE.WebGLRenderer, tex: THREE.Texture, rectPx: THREE.Vector4, srcAspect: number, radius: number) {
    const u = this.video.material.uniforms;
    u.uTex.value = tex;
    u.uDecode.value = needsVideoDecode(tex) ? 1 : 0;
    u.uRect.value.copy(rectPx);
    u.uR.value = radius;
    const ra = rectPx.z / Math.max(1, rectPx.w);
    const sx = srcAspect > ra ? 1 : srcAspect / ra, sy = srcAspect > ra ? ra / srcAspect : 1;
    (u.uFit.value as THREE.Vector4).set(sx, sy, (1 - sx) / 2, (1 - sy) / 2);
    const m = this.video.material;
    u.uMode.value = 0; m.blending = THREE.NoBlending; m.transparent = false;
    renderer.render(this.videoScene, this.camera);
  }

  /** The window again, behind cut-out / see-through cams (destination-over; after the under pass, so the cut-out's
   *  shadow / outline sit between the window and the avatar). Uses drawVideo's last texture + rect. */
  drawVideoBehind(renderer: THREE.WebGLRenderer) {
    const m = this.video.material, u = m.uniforms;
    if (!u.uTex.value) return;
    u.uMode.value = 1; m.blending = THREE.CustomBlending; m.transparent = true;
    m.blendEquation = THREE.AddEquation; m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrc = THREE.OneMinusDstAlphaFactor; m.blendDst = THREE.DstAlphaFactor; m.blendSrcAlpha = THREE.OneMinusDstAlphaFactor; m.blendDstAlpha = THREE.OneFactor;
    renderer.render(this.videoScene, this.camera);
    u.uMode.value = 0; m.blending = THREE.NoBlending; m.transparent = false;
  }

  /** Capture cover (src/scene/capcover) over the capture rect, drawn after the solid pass: pass A = premultiplied 'over'
   *  everywhere in the rect except on a cam's picture; pass B = 'destination-over' inside cut-out cams (only behind the
   *  avatar standing on the capture). Opaque while the cover holds: the OBS hole under it never shows. */
  private cover: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private coverScene = new THREE.Scene();
  private ensureCover() {
    if (this.cover) return;
    const m = new THREE.ShaderMaterial({
      uniforms: { uCover: coverUniforms.uCover, uRect: { value: new THREE.Vector4() }, uR: { value: 0 }, uMode: { value: 0 },
        uTiles: this.uniforms.uTiles, uTileP: this.uniforms.uTileP, uTileQ: this.uniforms.uTileQ, uTileN: this.uniforms.uTileN },
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; uniform sampler2D uCover; uniform vec4 uRect; uniform float uR, uMode;
        uniform vec4 uTiles[${MAX_TILES}]; uniform vec4 uTileP[${MAX_TILES}]; uniform vec4 uTileQ[${MAX_TILES}]; uniform int uTileN;
        float sdBox(vec2 p, vec4 r, float rad){ vec2 c=r.xy+r.zw*0.5,h=r.zw*0.5; vec2 q=abs(p-c)-h+rad; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-rad; }
        void main(){ vec2 p = gl_FragCoord.xy;
          float capIn = clamp(0.5 - sdBox(p, uRect, uR), 0.0, 1.0);
          if (capIn <= 0.0) discard;
          float inCut = 0.0;
          for (int i = 0; i < ${MAX_TILES}; i++) { if (i >= uTileN) break;
            vec4 r = uTiles[i]; vec4 pr = uTileP[i]; vec4 q = uTileQ[i];
            if (q.x <= 0.0) continue;
            if (q.y > 0.5) { if (sdBox(p, r, pr.x) < 0.0) inCut = 1.0; }
            else if (sdBox(p, r, pr.x) < 0.0) discard;   // a cam's picture: never covered (its bezel over the capture is see-through glass in pass 0: covered too)
          }
          if ((uMode < 0.5) == (inCut > 0.5)) discard;
          vec4 c = texture2D(uCover, (p - uRect.xy) / uRect.zw);
          gl_FragColor = vec4(c.rgb, c.a * capIn);
          #include <colorspace_fragment>
          gl_FragColor.rgb *= gl_FragColor.a;
        }`,
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
    });
    this.cover = new THREE.Mesh(this.mesh.geometry, m);
    this.cover.frustumCulled = false;
    this.coverScene.add(this.cover);
    }
drawCover(renderer: THREE.WebGLRenderer, rectPx: THREE.Vector4, radius: number) {
  if (!coverUniforms.uCover.value) return;
  this.ensureCover();
  if (!this.cover) return;
  const m = this.cover.material, u = m.uniforms;
  u.uRect.value.copy(rectPx);
  u.uR.value = radius;
  for (const mode of [0, 1]) {
    u.uMode.value = mode;
    if (mode === 0) { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; }
    else { m.blendSrc = THREE.OneMinusDstAlphaFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.OneMinusDstAlphaFactor; m.blendDstAlpha = THREE.OneFactor; }
    m.needsUpdate = false;
    renderer.render(this.coverScene, this.camera);
  }
  }

  /** 'Clean' cam backdrop: a soft studio gradient in the room's palette, inside one tile (scissored by the caller). */
  private studio: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private studioScene = new THREE.Scene();
  /** `linear`: into the post pipeline's scene target (linear light), else straight to the canvas. */
  private ensureStudio() {
    if (this.studio) return;
    const m = new THREE.ShaderMaterial({
      uniforms: { uRect: { value: new THREE.Vector4() }, uLin: { value: 0 }, uBg1: this.uniforms.uBg1, uGlass: this.uniforms.uGlass, uAcc: this.uniforms.uAcc, uAcc2: this.uniforms.uAcc2 },
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; uniform vec4 uRect; uniform float uLin; uniform vec3 uBg1, uGlass, uAcc, uAcc2;
        void main(){ vec2 uv = (gl_FragCoord.xy - uRect.xy) / uRect.zw;
          float r = length((uv - vec2(0.5, 0.64)) * vec2(uRect.z / uRect.w, 1.0));
          vec3 c = mix(uGlass * 2.2 + uAcc * 0.10, uBg1, smoothstep(0.0, 0.95, r));
          c += uAcc2 * 0.08 * smoothstep(0.25, 0.0, uv.y);
          c += uAcc * 0.06 * smoothstep(0.9, 1.0, uv.y);
          gl_FragColor = vec4(uLin > 0.5 ? pow(c, vec3(2.2)) : c, 1.0); }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.studio = new THREE.Mesh(this.mesh.geometry, m);
    this.studio.frustumCulled = false;
    this.studioScene.add(this.studio);
    }
drawStudio(renderer: THREE.WebGLRenderer, rectPx: THREE.Vector4, linear = false) {
  this.ensureStudio();
  if (!this.studio) return;
  this.studio.material.uniforms.uRect.value.copy(rectPx);
  this.studio.material.uniforms.uLin.value = linear ? 1 : 0;
  renderer.render(this.studioScene, this.camera);
  }

  /** Every program these passes use, compiled up front (the stage layout warms it when a room loads): they were built on
   *  the first frame that drew them — a mid-show compile on the first React / Gaming switch or the first screen cover.
   *  Both blend states of the passes that switch them (the OPAQUE define), for whatever targets renderer.compile covers
   *  (src/stage/gfx/Graphics.ts compiles the post-pipeline twin too). */
  private warmed = false;
  warm(renderer: THREE.WebGLRenderer) {
    if (this.warmed) return;
    this.warmed = true;
    this.ensureCover(); this.ensureStudio();
    const each = (m: THREE.ShaderMaterial, mesh: THREE.Object3D, scene: THREE.Scene) => {
      const keep = { b: m.blending, t: m.transparent };
      for (const [b, t] of [[THREE.NoBlending, false], [THREE.NormalBlending, false], [THREE.NormalBlending, true], [THREE.CustomBlending, true]] as const) {
        m.blending = b; m.transparent = t;
        try { renderer.compile(mesh, this.camera, scene); } catch { /* compiles on first draw */ }
      }
      m.blending = keep.b; m.transparent = keep.t;
    };
    each(this.mat, this.mesh, this.scene);
    each(this.video.material, this.video, this.videoScene);
    if (this.cover) each(this.cover.material, this.cover, this.coverScene);
    if (this.studio) each(this.studio.material, this.studio, this.studioScene);
  }

  dispose() { this.mat.dispose(); this.video.material.dispose(); this.studio?.material.dispose(); this.cover?.material.dispose(); this.mesh.geometry.dispose(); this.dropCut(); }
}

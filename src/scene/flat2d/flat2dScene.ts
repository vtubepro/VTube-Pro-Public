// 2D environments (scene.json `flat2d`, shared/flat2dRoom.ts): flat layers at different depths behind (and a few in
// front of) the performers — pictures from the room folder, or skies / clouds / hills / tree lines / grass / framing
// trees and bushes drawn here — sized so every camera of the room sees them edge to edge, a ground plane, atmospheric
// perspective (far layers fade into the haze colour), wind sway on grass and leaves, drifting clouds and motes in the
// air, and a slow ambient sway that moves each layer by exactly what a sideways camera breath would (parallax on a still
// camera). Unlit (the pictures keep their colours); everything it makes is freed on detach. Free in every other room.
import * as THREE from 'three';
import { hillProfile, sanitizeFlat2d, type Flat2dConfig, type Flat2dLayer } from '../../../shared/flat2dRoom.ts';
import { sceneFileUrl, type SceneRuntime } from '../SceneRuntime.ts';

const ASPECT = 16 / 9;
const SWAY_PERIOD = 14;

/** Seeded random 0..1. */
function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
/** Lighter (k > 0, toward white) or darker (k < 0) in sRGB, as an artist would mix it. */
const shade = (c: string, k: number) => {
  const v = parseInt(c.slice(1), 16), ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  const o = ch.map((x) => Math.round(k >= 0 ? x + (255 - x) * k : x * (1 + k)));
  return `#${o.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`;
};

// ---------------------------------------------------------------- drawing (canvas)
function drawLayer(l: Flat2dLayer, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (l.gradient) {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, l.gradient[0]); gr.addColorStop(1, l.gradient[1]);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  } else if (l.sky) {
    const S = l.sky;
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, S.top); gr.addColorStop(0.62, shade(S.top, 0.35)); gr.addColorStop(1, S.horizon);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    if (S.sun) {
      const sx = S.sun.x * w, sy = (1 - S.sun.y) * h, r = S.sun.size * h;
      const glow = g.createRadialGradient(sx, sy, 0, sx, sy, r * 9);
      glow.addColorStop(0, 'rgba(255,240,200,0.55)'); glow.addColorStop(0.25, 'rgba(255,214,160,0.22)'); glow.addColorStop(1, 'rgba(255,200,150,0)');
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
      g.fillStyle = S.sun.color; g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill();
    }
  } else if (l.clouds) {
    // cumulus: a crown of big puffs over a softly bumpy base of small ones, lit from above
    const C = l.clouds, R = rng(C.seed);
    for (let i = 0; i < C.count; i++) {
      const cx = (i + 0.2 + R() * 0.6) / C.count * w, base = h * (0.62 + R() * 0.3), cw = w / C.count * (0.4 + R() * 0.35), ch = h * (0.3 + R() * 0.2);
      const puffs: { x: number; y: number; r: number }[] = [];
      const nb = 6 + Math.floor(R() * 4);
      for (let k = 0; k < nb; k++) { const t = k / (nb - 1); puffs.push({ x: cx + (t - 0.5) * cw, y: base - ch * 0.12, r: ch * (0.16 + R() * 0.08) }); }
      const nt = 3 + Math.floor(R() * 3);
      for (let k = 0; k < nt; k++) { const t = (k + 0.5) / nt; puffs.push({ x: cx + (t - 0.5) * cw * 0.8 + (R() - 0.5) * cw * 0.1, y: base - ch * (0.35 + Math.sin(t * Math.PI) * 0.3), r: ch * (0.26 + Math.sin(t * Math.PI) * 0.2) * (0.85 + R() * 0.3) }); }
      g.fillStyle = shade(C.color, -0.14);
      for (const c of puffs) { g.beginPath(); g.arc(c.x, c.y + c.r * 0.12, c.r, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = C.color;
      for (const c of puffs) { g.beginPath(); g.arc(c.x, c.y - c.r * 0.06, c.r * 0.94, 0, Math.PI * 2); g.fill(); }
    }
  } else if (l.hills) {
    const H = l.hills, prof = hillProfile(H.seed, H.bumps, H.jag ?? 0, 256);
    const top = (i: number) => h - prof[i] * H.height * h;
    g.beginPath(); g.moveTo(0, h);
    for (let i = 0; i < prof.length; i++) g.lineTo((i / (prof.length - 1)) * w, top(i));
    g.lineTo(w, h); g.closePath();
    const gr = g.createLinearGradient(0, h * (1 - H.height), 0, h);
    gr.addColorStop(0, shade(H.color, 0.06)); gr.addColorStop(1, shade(H.color, -0.25));
    g.fillStyle = gr; g.fill();
    // a lighter rim along the top edge (the low sun catching the ridges)
    g.beginPath();
    for (let i = 0; i < prof.length; i++) { const x = (i / (prof.length - 1)) * w; if (i) g.lineTo(x, top(i)); else g.moveTo(x, top(i)); }
    g.strokeStyle = shade(H.color, 0.3); g.lineWidth = Math.max(2, h * 0.012); g.stroke();
  } else if (l.trees) {
    const T = l.trees, R = rng(T.seed);
    const base = shade(T.color, 0), lit = shade(T.color, 0.18), dark = shade(T.color, -0.25);
    const items = Array.from({ length: T.count }, (_, i) => ({ x: (i + 0.15 + R() * 0.7) / T.count * w, s: 0.65 + R() * 0.45 })).sort((a, b) => a.s - b.s);
    for (const it of items) {
      const th = T.height * h * it.s, x = it.x;
      if (T.kind === 'pine') {
        const tw = th * 0.42;
        g.fillStyle = dark; g.fillRect(x - tw * 0.05, h - th * 0.18, tw * 0.1, th * 0.18);
        for (let k = 0; k < 4; k++) {
          const y0 = h - th * (0.12 + k * 0.22), y1 = y0 - th * 0.42, ww = tw * (1 - k * 0.2);
          g.fillStyle = k % 2 ? base : lit;
          g.beginPath(); g.moveTo(x - ww / 2, y0); g.lineTo(x, y1); g.lineTo(x + ww / 2, y0); g.closePath(); g.fill();
          g.fillStyle = dark; g.globalAlpha = 0.35;
          g.beginPath(); g.moveTo(x, y1); g.lineTo(x - ww / 2, y0); g.lineTo(x - ww * 0.1, y0); g.closePath(); g.fill();
          g.globalAlpha = 1;
        }
      } else {
        const tw = th * 0.62;
        g.fillStyle = dark; g.fillRect(x - tw * 0.06, h - th * 0.42, tw * 0.12, th * 0.42);
        const blobs = 6;
        for (let k = 0; k < blobs; k++) {
          const a = (k / blobs) * Math.PI * 2, rr = tw * (0.26 + R() * 0.08);
          g.fillStyle = k < 3 ? base : lit;
          g.beginPath(); g.arc(x + Math.cos(a) * tw * 0.2, h - th * 0.66 + Math.sin(a) * th * 0.12, rr, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = lit; g.beginPath(); g.arc(x + tw * 0.08, h - th * 0.78, tw * 0.22, 0, Math.PI * 2); g.fill();
      }
    }
  } else if (l.grass) {
    const G = l.grass, R = rng(G.seed);
    const blades = Math.round(w / 3);
    for (let i = 0; i < blades; i++) {
      const x = R() * w, bh = h * (0.35 + R() * 0.65), bw = 2 + R() * 4, lean = (R() - 0.5) * bw * 4;
      g.fillStyle = shade(G.color, (R() - 0.45) * 0.4);
      g.beginPath(); g.moveTo(x - bw, h); g.quadraticCurveTo(x + lean * 0.3, h - bh * 0.6, x + lean, h - bh); g.quadraticCurveTo(x + lean * 0.3 + bw * 0.3, h - bh * 0.5, x + bw, h); g.closePath(); g.fill();
    }
  } else if (l.frame) {
    const F = l.frame, R = rng(F.seed);
    const leaves = (cx: number, cy: number, r: number, n: number) => {
      for (let k = 0; k < n; k++) {
        const a = R() * Math.PI * 2, d = Math.sqrt(R()) * r, rr = r * (0.28 + R() * 0.22);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.7;
        g.fillStyle = shade(F.color, -0.15); g.beginPath(); g.arc(x + rr * 0.12, y + rr * 0.15, rr, 0, Math.PI * 2); g.fill();
        g.fillStyle = y < cy ? shade(F.color, 0.14) : F.color; g.beginPath(); g.arc(x, y, rr * 0.92, 0, Math.PI * 2); g.fill();
      }
    };
    if (F.kind === 'tree') {
      // a trunk up the outer side bending in (flaring into roots), a crown of leaf clusters across the top
      const bark = shade(F.color, -0.4);
      g.fillStyle = bark;
      g.beginPath(); g.moveTo(w * 0.08, h); g.quadraticCurveTo(w * 0.2, h * 0.93, w * 0.21, h * 0.84); g.lineTo(w * 0.4, h * 0.84); g.quadraticCurveTo(w * 0.42, h * 0.93, w * 0.55, h); g.closePath(); g.fill();
      g.fillStyle = bark;
      g.beginPath(); g.moveTo(w * 0.18, h); g.bezierCurveTo(w * 0.22, h * 0.62, w * 0.2, h * 0.4, w * 0.36, h * 0.22);
      g.lineTo(w * 0.47, h * 0.25); g.bezierCurveTo(w * 0.36, h * 0.42, w * 0.38, h * 0.64, w * 0.42, h); g.closePath(); g.fill();
      g.fillStyle = shade(bark, 0.12);
      g.beginPath(); g.moveTo(w * 0.33, h); g.bezierCurveTo(w * 0.34, h * 0.66, w * 0.33, h * 0.45, w * 0.43, h * 0.26); g.lineTo(w * 0.47, h * 0.25); g.bezierCurveTo(w * 0.36, h * 0.42, w * 0.38, h * 0.64, w * 0.42, h); g.closePath(); g.fill();
      g.strokeStyle = bark; g.lineWidth = w * 0.035; g.lineCap = 'round';
      g.beginPath(); g.moveTo(w * 0.4, h * 0.3); g.quadraticCurveTo(w * 0.6, h * 0.2, w * 0.82, h * 0.16); g.stroke();
      leaves(w * 0.45, h * 0.12, w * 0.42, 34);
      leaves(w * 0.8, h * 0.14, w * 0.2, 14);
    } else {
      const n = 4;
      for (let k = 0; k < n; k++) leaves(w * (0.18 + k * 0.22), h * 0.62, h * 0.42, 12);
    }
    // in their own shade near the ground: darker toward the bottom (where they meet the grass)
    g.save(); g.globalCompositeOperation = 'source-atop';
    const sh = g.createLinearGradient(0, h * 0.7, 0, h);
    sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.38)');
    g.fillStyle = sh; g.fillRect(0, h * 0.7, w, h * 0.3);
    g.restore();
  }
  return c;
}

/** A grass / floor tile for a coloured ground (mottled, mown stripes). */
function groundTile(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!, R = rng(7);
  g.fillStyle = color; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2; i++) { g.fillStyle = shade(color, 0.035); g.fillRect(i * 128, 0, 64, 256); }
  for (let i = 0; i < 1400; i++) { g.fillStyle = shade(color, (R() - 0.55) * 0.18); g.fillRect(R() * 256, R() * 256, 1 + R() * 2, 2 + R() * 3); }
  return c;
}

// ---------------------------------------------------------------- the layer material: haze + wind sway + scroll
const vert = /* glsl */`
uniform float uSway; uniform float uTime; uniform float uWidth;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  float k = uv.y * uv.y;
  p.x += uSway * k * (sin(uTime * 1.6 + position.x * 0.9) * 0.7 + sin(uTime * 2.7 + position.x * 2.3) * 0.3);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const frag = /* glsl */`
uniform sampler2D map; uniform vec3 uHaze; uniform float uHazeK; uniform float uOpacity; uniform vec2 uRepeat; uniform vec2 uOffset;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv * uRepeat + uOffset);
  c.rgb = mix(c.rgb, uHaze, uHazeK);
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
}`;

interface Built { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; tex: THREE.Texture | null; x0: number; depth: number; scroll: number; width: number }

export class Flat2dScene {
  private rt: SceneRuntime | null = null;
  private cfg: Flat2dConfig | null = null;
  private group = new THREE.Group();
  private layers: Built[] = [];
  private owned: { dispose(): void }[] = [];
  private motes: { pts: THREE.Points; base: Float32Array; seed: Float32Array } | null = null;
  private time = 0;
  private cam = { z: 8, y: 1.35, fov: 35 };
  private far = 100;
  private maxD = 100;
  /** Test pages: time advances only through update(); `force` pins the sway phase (0..1). */
  manual = false;
  force: number | null = null;

  attach(rt: SceneRuntime) {
    this.detach();
    const cfg = sanitizeFlat2d((rt.info as unknown as { flat2d?: unknown }).flat2d);
    if (!cfg) return;
    this.rt = rt; this.cfg = cfg;
    this.group = new THREE.Group();
    this.group.name = 'flat2d';
    const wide = rt.room.cameras.get('CAM_WIDE') ?? [...rt.room.cameras.values()][0];
    if (wide) this.cam = { z: Math.max(1.5, wide.position.z), y: wide.position.y, fov: wide.fov };
    const A = cfg.drift * 0.25;
    const maxD = Math.max(...cfg.layers.map((l) => l.depth));
    this.maxD = maxD;
    this.far = this.cam.z + maxD * 1.3 + 10;
    cfg.layers.forEach((l, i) => { const b = this.build(rt, l, i, A); if (b) this.layers.push(b); });
    // the ground: out to the farthest layer, under everything
    const gw = this.coverW(maxD, A), gd = maxD + this.cam.z + 6;
    const gmat = new THREE.MeshLambertMaterial({ color: new THREE.Color('#ffffff') });
    gmat.name = 'vtp:flat2dGround';
    const ggeo = new THREE.PlaneGeometry(gw, gd);
    const ground = new THREE.Mesh(ggeo, gmat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.002, this.cam.z + 6 - gd / 2);
    ground.receiveShadow = true;
    ground.name = 'flat2d:ground';
    this.owned.push(gmat, ggeo);
    const tile = cfg.ground?.tile ?? 2;
    const t = cfg.ground?.file ? new THREE.TextureLoader().load(sceneFileUrl(rt.info.id, cfg.ground.file)) : new THREE.CanvasTexture(groundTile(cfg.ground?.color ?? '#6a8f5a'));
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.repeat.set(gw / tile, gd / tile);
    gmat.map = t;
    this.owned.push(t);
    this.group.add(ground);
    if (cfg.particles && cfg.particles.count > 0) this.buildMotes(cfg.particles);
    rt.root.add(this.group);
  }

  /** Width that covers the widest camera at `depth` (+ the sway's travel there). */
  private coverW(depth: number, A: number) {
    const dist = this.cam.z + depth;
    const viewW = 2 * Math.max(0.5, dist) * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2) * ASPECT;
    return viewW * 1.6 + 2 * A * Math.abs(1 - dist / this.cam.z) + 4;
  }

  private material(l: Flat2dLayer, map: THREE.Texture | null): THREE.ShaderMaterial {
    const hz = this.cfg?.haze;
    // atmospheric perspective: nothing in front of the performers, rising with depth (the sky is the haze itself)
    const k = hz && l.depth > 0 && !l.sky && !l.gradient ? hz.strength * Math.pow(Math.min(1, l.depth / Math.max(1, this.maxD)), 0.8) * (l.clouds ? 0.25 : 1) : 0;
    const m = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      uniforms: {
        map: { value: map }, uHaze: { value: new THREE.Color(hz?.color ?? '#ffffff') }, uHazeK: { value: k }, uOpacity: { value: l.opacity ?? 1 },
        uRepeat: { value: new THREE.Vector2(1, 1) }, uOffset: { value: new THREE.Vector2() }, uSway: { value: 0 }, uTime: { value: 0 }, uWidth: { value: 1 },
      },
    });
    return m;
  }

  private build(rt: SceneRuntime, l: Flat2dLayer, i: number, A: number): Built | null {
    const dist = this.cam.z + l.depth;
    const viewH = 2 * Math.max(0.5, dist) * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2);
    let W = typeof l.width === 'number' ? l.width : this.coverW(l.depth, A);
    const topY = this.cam.y + viewH * 0.75;
    let y = l.y ?? 0;
    let x = 0;
    let H: number;
    let tex: THREE.Texture | null = null;
    let repeat = 1;
    const sway = (l.sway ?? 0);
    if (l.gradient || l.sky) {
      y = Math.min(y, this.cam.y - viewH);
      H = topY + viewH * 0.2 - y;
      tex = new THREE.CanvasTexture(drawLayer(l, l.sky ? 1024 : 8, 512));
    } else if (l.clouds) {
      H = viewH * 0.3; y = this.cam.y + viewH * 0.2;
      tex = new THREE.CanvasTexture(drawLayer(l, 2048, 256));
      repeat = Math.max(1, W / (H * 8));
    } else if (l.hills) {
      H = viewH * 0.55;
      tex = new THREE.CanvasTexture(drawLayer(l, 1024, 320));
    } else if (l.trees) {
      H = viewH * 0.42;
      tex = new THREE.CanvasTexture(drawLayer(l, 2048, 384));
    } else if (l.grass) {
      H = l.grass.height + 0.06; y = -0.06;
      tex = new THREE.CanvasTexture(drawLayer(l, 2048, 96));
      repeat = Math.max(1, W / (H * 21));
    } else if (l.frame) {
      // at the edge of the wide shot, partly outside it
      const halfW = Math.max(0.5, dist) * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2) * ASPECT;
      if (l.frame.kind === 'tree') { H = viewH * 1.1; W = H * 0.6; y = -0.35; }
      else { H = Math.min(1.2, viewH * 0.32); W = H * 2.4; y = -0.3; }
      const side = l.frame.side === 'right' ? 1 : -1;
      // never in front of anyone: its inner edge stays outside the outermost place on its side (as the wide camera sees it)
      const xs = rt.room.spots.filter((sp) => !!sp).map((sp) => sp!.position.x);
      const edge = (side > 0 ? Math.max(0, ...xs) : Math.min(0, ...xs)) + side * 0.75;
      const inner = edge * (dist / this.cam.z);
      const innerOff = l.frame.kind === 'tree' ? 0.15 : 0.08;   // (the tree's trunk / the bushes' inner edge, share of W)
      x = side > 0 ? Math.max(inner + W * (0.5 - innerOff), halfW - W * 0.35) : Math.min(inner - W * (0.5 - innerOff), -halfW + W * 0.32);
      tex = new THREE.CanvasTexture(drawLayer(l, 512, l.frame.kind === 'tree' ? 1024 : 384));
      if (l.frame.side === 'both') {
        const twin = this.build(rt, { ...l, frame: { ...l.frame, side: 'right', seed: l.frame.seed + 1 } }, i, A);
        if (twin) this.layers.push(twin);
        x = -(halfW - W * 0.25);
      }
    } else {
      // a picture: its own aspect once loaded (until then, a 2:1 guess, invisible)
      H = W / 2;
      const mat0 = this.material(l, null);
      mat0.uniforms.uOpacity.value = 0;
      const t = new THREE.TextureLoader().load(sceneFileUrl(rt.info.id, l.file!), (tt) => {
        const img = tt.image as { width: number; height: number };
        const asp = img.width / Math.max(1, img.height);
        const b = this.layers.find((q) => q.tex === tt);
        if (!b) return;
        let w = W, h = W / asp;
        if (i === 0 && !l.repeat) { if (h < topY - y) { h = topY - y; w = h * asp; } }   // the farthest picture is the backdrop: cover the view
        else if (typeof l.width !== 'number' || l.repeat) {
          // a band in the lower half of the view at its depth (its own aspect), repeated sideways to cover every camera
          h = viewH * (0.28 + 0.3 * Math.sqrt(Math.max(0, l.depth) / this.maxD));
          const r = Math.max(1, W / (h * asp));
          tt.wrapS = THREE.RepeatWrapping; b.mat.uniforms.uRepeat.value.set(r, 1); tt.needsUpdate = true;
        }
        b.mesh.geometry.dispose();
        const g = new THREE.PlaneGeometry(w, h, sway ? 48 : 1, sway ? 4 : 1); g.translate(0, h / 2, 0);
        b.mesh.geometry = g;
        b.width = w;
        b.mat.uniforms.uOpacity.value = l.opacity ?? 1;
      });
      t.colorSpace = THREE.SRGBColorSpace;
      mat0.uniforms.map.value = t;
      const geo0 = new THREE.PlaneGeometry(W, H); geo0.translate(0, H / 2, 0);
      const mesh0 = new THREE.Mesh(geo0, mat0);
      this.place(mesh0, i, y, l.depth, 0);
      return { mesh: mesh0, mat: mat0, tex: t, x0: 0, depth: l.depth, scroll: l.scroll ?? 0, width: W };
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true; tex.anisotropy = 4;
    if (repeat > 1 || l.repeat) tex.wrapS = THREE.RepeatWrapping;
    const mat = this.material(l, tex);
    mat.uniforms.uRepeat.value.set(repeat, 1);
    mat.uniforms.uSway.value = sway * (l.grass ? 0.05 : l.frame ? 0.08 : 0.15);
    const geo = new THREE.PlaneGeometry(W, H, sway ? 64 : 1, sway ? 4 : 1);
    geo.translate(0, H / 2, 0);
    const mesh = new THREE.Mesh(geo, mat);
    this.place(mesh, i, y, l.depth, x);
    if (l.frame) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d')!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      const st = new THREE.CanvasTexture(c), sm = new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, toneMapped: false, fog: false });
      const sg = new THREE.PlaneGeometry(W * (l.frame.kind === 'tree' ? 0.6 : 1.1), 1.2);
      const shadow = new THREE.Mesh(sg, sm);
      shadow.rotation.x = -Math.PI / 2; shadow.position.set(x + (l.frame.kind === 'tree' ? -W * 0.15 : 0), 0.01, -l.depth); shadow.renderOrder = 40;
      this.group.add(shadow);
      this.owned.push(st, sm, sg);
    }
    return { mesh, mat, tex, x0: x, depth: l.depth, scroll: l.scroll ?? 0, width: W };
  }

  private place(mesh: THREE.Mesh, i: number, y: number, depth: number, x: number) {
    mesh.name = `flat2d:layer${i}`;
    mesh.position.set(x, y, -depth);
    // far → near; the layers in front of the performers draw after them
    mesh.renderOrder = depth < 0 ? 50 + i : -100 + i;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /** Motes drifting in the air between the camera and the nearest hills. */
  private buildMotes(p: NonNullable<Flat2dConfig['particles']>) {
    const n = p.count, pos = new Float32Array(n * 3), seed = new Float32Array(n);
    const R = rng(17);
    for (let i = 0; i < n; i++) { pos[i * 3] = (R() - 0.5) * 12; pos[i * 3 + 1] = 0.2 + R() * 3; pos[i * 3 + 2] = -R() * 9 + 2; seed[i] = R() * 100; }
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d')!, gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    const mat = new THREE.PointsMaterial({ map: tex, color: new THREE.Color(p.color), size: p.size, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85, fog: false, toneMapped: false });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'flat2d:motes'; pts.frustumCulled = false;
    this.group.add(pts);
    this.owned.push(tex, geo, mat);
    this.motes = { pts, base: pos, seed };
  }

  update(dt: number) {
    const rt = this.rt, cfg = this.cfg;
    if (!rt || !cfg) return;
    if (!this.manual) this.time += dt;
    const cam = rt.stage.camera;
    if (cam.far < this.far) { cam.far = this.far; cam.updateProjectionMatrix(); }
    const A = cfg.drift * 0.25;
    const ph = this.force ?? this.time / SWAY_PERIOD;
    const sway = A * Math.sin(ph * Math.PI * 2);
    for (const b of this.layers) {
      // a sideways camera breath of `sway` m, the performers held still: each layer moves by sway × (1 − D / D0)
      const D = this.cam.z + b.depth;
      b.mesh.position.x = b.x0 + sway * (1 - D / this.cam.z);
      const U = b.mat.uniforms;
      U.uTime.value = this.time;
      if (b.scroll) U.uOffset.value.x = (this.time * b.scroll / Math.max(1, b.width) * U.uRepeat.value.x) % 1;
    }
    const M = this.motes;
    if (M) {
      const p = M.pts.geometry.attributes.position as THREE.BufferAttribute, t = this.time;
      for (let i = 0; i < M.seed.length; i++) {
        const s = M.seed[i];
        p.setXYZ(i, M.base[i * 3] + Math.sin(t * 0.21 + s) * 0.6 + ((t * 0.08 + s) % 4) - 2, M.base[i * 3 + 1] + Math.sin(t * 0.37 + s * 1.7) * 0.25, M.base[i * 3 + 2] + Math.cos(t * 0.17 + s) * 0.3);
      }
      p.needsUpdate = true;
    }
  }

  debug() { return this.cfg ? { layers: this.layers.length, far: this.far, cam: this.cam, time: this.time, motes: this.motes?.seed.length ?? 0 } : null; }

  detach() {
    for (const b of this.layers) { b.mesh.geometry.dispose(); b.tex?.dispose(); b.mat.dispose(); }
    for (const o of this.owned) o.dispose();
    this.layers = []; this.owned = []; this.motes = null;
    this.group.removeFromParent();
    this.rt = null; this.cfg = null;
  }
}

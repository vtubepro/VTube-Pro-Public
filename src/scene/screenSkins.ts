// Room-themed housings for the generated screen rigs (shared/screenSkin.ts): the solo react screen (soloScreen.ts) and
// the chat monitor / support board (skinnedProp.ts; the studio theme keeps chatRig.ts's HangingRig).
//
// A skin is built around a flat W×H screen rectangle (the ScreenFx surface — the only thing in-scene capture draws on
// and the only thing the OBS passthrough hole cuts): the rectangle's centre is the rig origin at rest, +Z faces the
// viewer, the surface sits at z = SURF_Z. Frames may be any shape (arches, sheets, tarps, holo brackets) but never
// cover the rectangle; parts in front of its plane stay outside it by more than they protrude, so an angled camera
// doesn't clip it either.
//
// Each skin = a `moving` group (animated by the motion: drop / rise / unroll / swing / hologram / shimmer, see
// SkinDriver) + fixed parts (ceiling plates, floor emitters, chains are re-laid by the skin's hook every frame), and a
// power-on style for the surface (screenFx.ts setStyle). At rest (landed) the moving group is exactly identity, so
// the rect / quad / two-shot maths (soloScreen.ts) are the same for every skin.
import * as THREE from 'three';
import { govChannel, govern, pageGovernor } from '../../shared/flashGovernor.ts';
let skinSeq = 0;
/** a governed emissive output for one skin part (each skin instance gets its own channel) */
const skinCh = () => { const ch = govChannel(`skin ${skinSeq++}`); return (L: number) => pageGovernor(performance.timeOrigin + performance.now()).step(ch, L); };
import type { ScreenSkinMotion, ScreenSkinProp, ScreenSkinTheme, ResolvedSkinSpec } from '../../shared/screenSkin.ts';

export const SURF_Z = 0.012;
type Disposable = THREE.Material | THREE.BufferGeometry | THREE.Texture;

export interface SkinCtx {
  prop: ScreenSkinProp;
  W: number;
  H: number;
  /** Local y (relative to the rect centre) of the ceiling above / the floor below (null = no floor found). */
  ceilLocal: number;
  floorLocal: number | null;
  /** The W×H ScreenFx surface; the skin parents it (rest pose: origin, z = SURF_Z). */
  surface: THREE.Mesh;
  own: <T extends Disposable>(x: T) => T;
  /** Room GLB node used as the housing (custom skins). */
  template?: THREE.Object3D | null;
}

/** Per-frame pose handed to a skin's hook. */
export interface SkinPose {
  /** Arrival 0..1. */
  a: number;
  /** Offset of the moving group, roll length 0..1, swing angle. */
  y: number; u: number; th: number;
  arrived: boolean; landed: boolean;
  /** Seconds since arrival. */
  tau: number;
  power: number; flash: number; pulse: number; time: number;
  alpha: number;
}

export interface BuiltSkin {
  root: THREE.Group;
  moving: THREE.Group;
  /** Unroll part (child of `moving`, its origin = its top edge): scale.y = roll length. */
  roll: THREE.Group | null;
  /** Moving group's extent at rest (local y), and the roll's top. */
  topY: number; bottomY: number; rollTop: number;
  enterDur: number; exitDur: number;
  /** Seconds after arrival before the picture may power on (a swing must settle first). */
  settle: number;
  /** Drop landing bounce (m). */
  bounce: number;
  /** Chat props sway a little after landing. */
  sway: boolean;
  /** Materials faded in by rise / shimmer. */
  fade: THREE.Material[];
  hook?: (p: SkinPose) => void;
}

// ---------------------------------------------------------------- small helpers
const clamp01 = (x: number) => THREE.MathUtils.clamp(x, 0, 1);
const smoother = (x: number) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeOutBack = (x: number) => { const t = clamp01(x), c1 = 1.2, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const hash1 = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function rng(seed: number) { let r = seed >>> 0 || 1; return () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return ((r >>> 0) % 100000) / 100000; }; }

class Kit {
  constructor(private c: SkinCtx) {}
  std(color: number, roughness = 0.6, metalness = 0.1, extra: THREE.MeshStandardMaterialParameters = {}) {
    return this.c.own(new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
  }
  /** Additive glow that never changes the frame's alpha (the OBS hole / transparent background stay intact). */
  glow(color: number | THREE.Color, opacity = 1, map: THREE.Texture | null = null) {
    return this.c.own(new THREE.MeshBasicMaterial({
      color, map, transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
  }
  tex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeat?: [number, number]) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d')!, w, h);
    const t = this.c.own(new THREE.CanvasTexture(cv));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
    return t;
  }
  box(w: number, h: number, d: number, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(this.c.own(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z); parent.add(m); return m;
  }
  cyl(r0: number, r1: number, h: number, mat: THREE.Material, parent: THREE.Object3D, seg = 12, open = false) {
    const m = new THREE.Mesh(this.c.own(new THREE.CylinderGeometry(r0, r1, h, seg, 1, open)), mat);
    parent.add(m); return m;
  }
  plane(w: number, h: number, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(this.c.own(new THREE.PlaneGeometry(w, h)), mat);
    m.position.set(x, y, z); parent.add(m); return m;
  }
  geo<T extends THREE.BufferGeometry>(g: T): T { return this.c.own(g); }
}

function label(k: Kit, text: string, o: { w?: number; h?: number; bg: string; fg: string; font: string; border?: string; stripes?: [string, string] }) {
  return k.tex(o.w ?? 512, o.h ?? 96, (g, w, h) => {
    g.fillStyle = o.bg; g.fillRect(0, 0, w, h);
    if (o.stripes) {
      g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip();
      for (let x = -h; x < w + h; x += 44) { g.fillStyle = o.stripes[0]; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 22, 0); g.lineTo(x + 22 - h, h); g.lineTo(x - h, h); g.fill(); }
      g.restore();
      g.fillStyle = o.stripes[1]; g.fillRect(w * 0.16, h * 0.16, w * 0.68, h * 0.68);
    }
    if (o.border) { g.strokeStyle = o.border; g.lineWidth = Math.max(3, h * 0.05); g.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12); }
    g.fillStyle = o.fg; g.font = o.font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h * 0.54, w * 0.9);
  });
}
const propLabel = (p: ScreenSkinProp) => (p === 'board' ? 'SUPPORT' : 'LIVE CHAT');

// ---------------------------------------------------------------- procedural textures
function woodTex(k: Kit, base = '#3a2717', seed = 3) {
  return k.tex(256, 256, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const y = r() * h, a = 0.05 + r() * 0.12;
      g.strokeStyle = r() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,210,150,${a * 0.5})`;
      g.lineWidth = 0.6 + r() * 2.2;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 3 * r());
      g.stroke();
    }
  }, [1, 1]);
}
function rustTex(k: Kit, base = '#4a2f1f', seed = 7) {
  return k.tex(256, 256, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = r() * w, y = r() * h, s = 2 + r() * 18;
      const c = r();
      g.fillStyle = c < 0.4 ? `rgba(140,62,22,${0.25 + r() * 0.35})` : c < 0.7 ? `rgba(60,44,36,${0.3 + r() * 0.3})` : `rgba(178,98,40,${0.15 + r() * 0.3})`;
      g.beginPath(); g.ellipse(x, y, s, s * (0.4 + r()), r() * 3, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 20; i++) { g.fillStyle = `rgba(20,14,10,${0.2 + r() * 0.3})`; g.fillRect(r() * w, r() * h, 1 + r() * 2, 10 + r() * 50); }
  }, [2, 1]);
}
function runeAtlas(k: Kit) {
  // 8 procedural glyphs (angular strokes, Futhark-like) in a row; white on black (additive)
  return k.tex(512, 64, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 64);
    g.strokeStyle = '#fff'; g.lineWidth = 5; g.lineCap = 'round';
    const r = rng(11);
    for (let i = 0; i < 8; i++) {
      const cx = i * 64 + 32;
      g.beginPath(); g.moveTo(cx, 8); g.lineTo(cx, 56); g.stroke();
      for (let s = 0; s < 2 + Math.floor(r() * 2); s++) {
        const y0 = 10 + r() * 36, dir = r() < 0.5 ? -1 : 1;
        g.beginPath(); g.moveTo(cx, y0); g.lineTo(cx + dir * (10 + r() * 12), y0 + (r() < 0.5 ? -1 : 1) * (8 + r() * 12)); g.stroke();
      }
    }
  });
}

// ---------------------------------------------------------------- the driver (arrival motion → moving group)
export class SkinDriver {
  a = 0;
  tau = 99;
  arrived = false;
  flash = 0;
  private baseOpacity = new Map<THREE.Material, number>();
  constructor(readonly skin: BuiltSkin, readonly motion: ScreenSkinMotion, private ceilLocal: number, private floorLocal: number | null) {
    for (const m of skin.fade) this.baseOpacity.set(m, m.opacity);
  }
  /** Fully down and settled: the picture may power on. */
  get landed() { return this.arrived && this.tau >= this.skin.settle; }
  get visible() { return this.a > 0.001; }

  /** Returns true on the frame it arrives (the landing accent). */
  step(dt: number, want: boolean, off: boolean): boolean {
    let hit = false;
    if (want) {
      if (!this.arrived) {
        this.a = Math.min(1, this.a + dt / this.skin.enterDur);
        if (this.a >= 1) { this.arrived = true; this.tau = 0; this.flash = 1; hit = true; }
      }
    } else if (off) {
      this.arrived = false;
      this.a = Math.max(0, this.a - dt / this.skin.exitDur);
    }
    this.tau += dt;
    this.flash = Math.max(0, this.flash - dt / 0.9);
    return hit;
  }
  finish(want: boolean) { this.a = want ? 1 : 0; this.arrived = want; this.tau = 99; this.flash = 0; }

  apply(time: number, power: number, pulse = 0) {
    const S = this.skin, k = this.a, mv = S.moving;
    let y = 0, u = 1, th = 0, alpha = 1, sc = 1, sy = 1, vis = true;
    const retractDrop = this.ceilLocal - S.bottomY + 0.05;
    switch (this.motion) {
      case 'drop':
        y = THREE.MathUtils.lerp(retractDrop, 0, smoother(k)) + (this.arrived ? -S.bounce * Math.sin(this.tau * 11) * Math.exp(-4.6 * this.tau) : 0);
        break;
      case 'unroll': {
        const retract = this.ceilLocal - S.rollTop + 0.02;
        y = THREE.MathUtils.lerp(retract, 0, easeOut(k / 0.39));
        u = Math.max(0.0005, smoother((k - 0.26) / 0.74) + (this.arrived ? 0.055 * Math.sin(this.tau * 13.5) * Math.exp(-5.2 * this.tau) : 0));
        break;
      }
      case 'rise': {
        const riseD = this.floorLocal !== null ? THREE.MathUtils.clamp(S.topY - this.floorLocal + 0.05, 0.4, 1.4) : 0.8;
        y = THREE.MathUtils.lerp(-riseD, 0, easeOutBack(k));
        alpha = smoother(k / 0.45);
        sc = THREE.MathUtils.lerp(0.92, 1, easeOut(k));
        break;
      }
      case 'swing':
        // free fall on the chains, a hard stop, then a damped pendulum about the ceiling
        y = retractDrop * (1 - k * k);
        th = this.arrived ? 0.05 * Math.sin(this.tau * 5.6) * Math.exp(-3.9 * this.tau) : 0;
        break;
      case 'hologram':
        sy = THREE.MathUtils.lerp(0.02, 1, easeOut((k - 0.25) / 0.55));
        vis = k >= 1 || hash1(Math.floor(time * 30)) < 0.3 + 0.7 * k;
        alpha = smoother(k / 0.5);
        break;
      case 'shimmer':
        y = THREE.MathUtils.lerp(-0.25, 0, easeOut(k));
        alpha = smoother(k / 0.6);
        sc = THREE.MathUtils.lerp(0.94, 1, easeOut(k));
        break;
    }
    if (this.motion === 'swing' && th !== 0) {
      const pivot = this.ceilLocal, P = pivot - y;
      mv.position.set(0, pivot - P * Math.cos(th), -P * Math.sin(th));
      mv.rotation.set(th, 0, 0);
    } else {
      mv.position.set(0, y, 0);
      mv.rotation.set(0, 0, S.sway && this.arrived ? 0.012 * Math.sin(this.tau * 7.5) * Math.exp(-3 * this.tau) : 0);
    }
    if (this.motion === 'unroll' && !S.roll) { mv.scale.set(1, u, 1); mv.position.y += S.topY * (1 - u); }
    else mv.scale.set(sc, sc * sy, sc);
    if (S.roll) S.roll.scale.y = this.motion === 'unroll' ? u : 1;
    mv.visible = vis;
    for (const [m, o] of this.baseOpacity) {
      m.opacity = o * alpha;
      const tr = alpha < 0.999 || o < 1;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
    }
    S.hook?.({ a: k, y, u, th, arrived: this.arrived, landed: this.landed, tau: this.tau, power, flash: this.flash, pulse, time, alpha });
  }
}

// ---------------------------------------------------------------- builders
export function buildSkin(spec: ResolvedSkinSpec, c: SkinCtx): BuiltSkin {
  if (c.template) return customSkin(c, c.template);
  const b = BUILDERS[spec.theme] ?? BUILDERS.studio;
  return b(c);
}

const BUILDERS: Record<ScreenSkinTheme, (c: SkinCtx) => BuiltSkin> = {
  studio: studioSkin, scrying: scryingSkin, hologram: hologramSkin, terragroup: terragroupSkin, tarp: tarpSkin, bedsheet: bedsheetSkin,
};

function base(): { root: THREE.Group; moving: THREE.Group } {
  const root = new THREE.Group(), moving = new THREE.Group();
  root.add(moving);
  return { root, moving };
}
/** A straight cylinder stretched between two points (cables, ropes, rods). */
function stretch(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a), len = Math.max(0.005, d.length());
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
  m.scale.set(1, len, 1);
}

// ---- studio: the original motorised roller screen (solo only; chat props keep HangingRig)
function studioSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const metal = k.std(0x1a1d23, 0.42, 0.65), dark = k.std(0x0c0e11, 0.6, 0.4);
  const strip = k.std(0x0a1418, 0.4, 0, { emissive: new THREE.Color(0x35e3ff), emissiveIntensity: 0 });
  const hh = 0.17, housingY = H / 2 + 0.03 + hh / 2;
  k.box(W + 0.34, hh, 0.22, metal, moving, 0, housingY);
  k.box(W + 0.2, 0.025, 0.01, strip, moving, 0, housingY - hh / 2 + 0.03, 0.112);
  k.box(0.08, hh + 0.04, 0.26, dark, moving, -(W + 0.34) / 2 - 0.02, housingY);
  k.box(0.08, hh + 0.04, 0.26, dark, moving, (W + 0.34) / 2 + 0.02, housingY);
  const oat = label(k, 'ON AIR', { w: 256, h: 72, bg: '#190406', fg: '#ff4040', border: '#ff3b3b', font: '900 44px Inter, system-ui, sans-serif' });
  const onAirMat = c.own(new THREE.MeshBasicMaterial({ map: oat, toneMapped: false, color: new THREE.Color(0.35, 0.35, 0.35) }));
  const onAir = k.plane(0.42, 0.118, onAirMat, moving, W / 2 - 0.3, housingY + 0.01, 0.113);
  const roll = new THREE.Group();
  roll.position.y = H / 2;
  c.surface.position.set(0, -H / 2, SURF_Z);
  roll.add(c.surface);
  k.box(W + 0.08, H + 0.02, 0.02, dark, roll, 0, -H / 2, -0.004);
  moving.add(roll);
  const bar = k.box(W + 0.16, 0.055, 0.07, metal, moving);
  const cables: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const cab = k.cyl(0.009, 0.009, 1, dark, root, 6);
    cab.position.x = sx * (W / 2 - 0.12);
    cables.push(cab);
    k.box(0.16, 0.03, 0.16, metal, root, sx * (W / 2 - 0.12), c.ceilLocal - 0.015, 0);
  }
  return {
    root, moving, roll, topY: housingY + hh / 2, bottomY: -H / 2 - 0.06, rollTop: H / 2, enterDur: 1.15, exitDur: 0.9, settle: 0, bounce: 0.03, sway: false, fade: [],
    hook: (p) => {
      const top = p.y + housingY + hh / 2;
      for (const cab of cables) { const len = Math.max(0.01, c.ceilLocal - top); cab.scale.y = len; cab.position.y = top + len / 2; }
      bar.position.set(0, H / 2 - H * p.u - 0.028, SURF_Z);
      bar.visible = p.a > 0.2;
      roll.visible = p.u > 0.002;
      const blink = p.flash > 0 ? (Math.sin(p.time * 40) > 0 ? 1 : 0.35) * p.flash : 0;
      onAirMat.color.setScalar(govern(`on-air lamp ${housingY}`, Math.max(0.3, 0.3 + 0.7 * p.power, blink)));   // (6.4 Hz blink: governed)
      onAir.scale.setScalar(1 + 0.12 * p.flash);
      strip.emissiveIntensity = 0.2 + 2.4 * Math.max(p.power, p.flash);
    },
  };
}

// ---- scrying mirror (Kingsmarch): an arched, rune-carved frame around enchanted glass; the screen is the rectangle
// in the glass's lower part. Solo: floats up out of a glowing rune circle. Chat: a carved signboard on ropes.
function archShape(hw: number, bot: number, top: number, rise: number, o: number): THREE.Shape {
  const s = new THREE.Shape(), x = hw + o;
  s.moveTo(-x, bot - o); s.lineTo(x, bot - o); s.lineTo(x, top);
  s.bezierCurveTo(x, top + rise * 0.62, x * 0.42, top + rise * 0.8 + o * 0.5, 0, top + rise + o);
  s.bezierCurveTo(-x * 0.42, top + rise * 0.8 + o * 0.5, -x, top + rise * 0.62, -x, top);
  s.lineTo(-x, bot - o);
  return s;
}
function ringGeo(k: Kit, outer: THREE.Shape, inner: THREE.Shape, depth: number, bevel: number) {
  outer.holes.push(new THREE.Path(inner.getPoints(48)));
  return k.geo(new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 32 }));
}
function magicGlass(c: SkinCtx) {
  return c.own(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGlow: { value: 0.3 }, uAlpha: { value: 1 } },
    transparent: false,
    vertexShader: /* glsl */ `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uGlow, uAlpha; varying vec3 vP;
      void main(){
        vec2 p = vP.xy * 1.7;
        float sw = sin(p.x * 2.1 + sin(p.y * 1.7 + uTime * 0.6) * 1.6 + uTime * 0.4) * sin(p.y * 2.6 - uTime * 0.5 + sin(p.x * 1.3));
        vec3 col = vec3(0.028, 0.02, 0.06) + vec3(0.2, 0.1, 0.42) * (0.5 + 0.5 * sw) * (0.25 + 0.75 * uGlow) * 0.55;
        col += vec3(0.5, 0.35, 0.9) * pow(max(0.0, sw), 8.0) * 0.35 * uGlow;
        gl_FragColor = vec4(col * uAlpha, 1.0);
        #include <colorspace_fragment>
      }`,
  }));
}
function scryingSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const solo = c.prop === 'solo';
  const wood = k.std(0xffffff, 0.72, 0.05, { map: woodTex(k, solo ? '#2e2016' : '#3b2a1a') });
  const gold = k.std(0xc9a14c, 0.32, 0.85);
  const runeMat = k.glow(new THREE.Color(0.7, 0.5, 1.0), 0.8, runeAtlas(k));
  const glass = magicGlass(c);
  const m = solo ? 0.05 * W : 0.025 + 0.02 * W;          // glass margin around the screen rectangle
  const f = solo ? 0.045 * W + 0.05 : 0.05 + 0.03 * W;    // frame width
  const hw = W / 2 + m, bot = -H / 2 - m, top = H / 2 + m;
  const rise = solo ? THREE.MathUtils.clamp(Math.min(0.2 * H + 0.05, c.ceilLocal - top - f - 0.12), 0.1, 0.8) : Math.min(0.16 + 0.1 * W, 0.4);
  // frame + gold trim + glass
  const frame = new THREE.Mesh(ringGeo(k, archShape(hw, bot, top, rise, f), archShape(hw, bot, top, rise, 0), 0.05, 0.014), wood);
  frame.position.z = -0.03;
  moving.add(frame);
  const trim = new THREE.Mesh(ringGeo(k, archShape(hw, bot, top, rise, 0.028), archShape(hw, bot, top, rise, 0), 0.066, 0), gold);
  trim.position.z = -0.03;
  moving.add(trim);
  const g = new THREE.Mesh(k.geo(new THREE.ShapeGeometry(archShape(hw, bot, top, rise, 0), 32)), glass);
  g.position.z = -0.004;
  moving.add(g);
  c.surface.position.set(0, 0, SURF_Z);
  moving.add(c.surface);
  // runes along the middle of the frame
  const mid = archShape(hw, bot, top, rise, f * 0.5).getSpacedPoints(solo ? 26 : 14);
  const rs = f * 0.5;
  for (let i = 0; i < mid.length - 1; i++) {
    const pt = mid[i];
    const geo = k.geo(new THREE.PlaneGeometry(rs * 0.55, rs));
    const cell = i % 8, uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let j = 0; j < uv.count; j++) uv.setX(j, (cell + uv.getX(j)) / 8);
    const r = new THREE.Mesh(geo, runeMat);
    r.position.set(pt.x, pt.y, 0.04);
    moving.add(r);
  }
  // crest gem at the arch's peak
  const gemMat = k.std(0x2a1050, 0.2, 0.3, { emissive: new THREE.Color(0x9a6bff), emissiveIntensity: 1.2 });
  const gem = new THREE.Mesh(k.geo(new THREE.OctahedronGeometry(0.05 + 0.02 * W)), gemMat);
  gem.position.set(0, top + rise + f * 0.55, 0.03);
  gem.scale.y = 1.5;
  moving.add(gem);
  const fade: THREE.Material[] = [wood, gold, gemMat];
  let hookExtra: ((p: SkinPose) => void) | null = null;
  let topY = top + rise + f + 0.1, bottomY = bot - f;
  if (solo) {
    // floor rune circle + rising motes
    let circle: THREE.Mesh | null = null, circleMat: THREE.MeshBasicMaterial | null = null;
    if (c.floorLocal !== null && c.floorLocal > -4.5) {
      const ct = k.tex(512, 512, (g2, w) => {
        g2.fillStyle = '#000'; g2.fillRect(0, 0, w, w);
        g2.strokeStyle = '#fff'; g2.lineWidth = 6;
        for (const r0 of [0.47, 0.4, 0.2]) { g2.beginPath(); g2.arc(w / 2, w / 2, w * r0, 0, Math.PI * 2); g2.stroke(); }
        g2.lineWidth = 3; g2.beginPath();
        for (let i = 0; i <= 5; i++) { const an = (i * 2 * 2 * Math.PI) / 5 - Math.PI / 2; const x = w / 2 + Math.cos(an) * w * 0.4, y = w / 2 + Math.sin(an) * w * 0.4; if (i) g2.lineTo(x, y); else g2.moveTo(x, y); }
        g2.stroke();
        const r = rng(5); g2.lineWidth = 4;
        for (let i = 0; i < 24; i++) {
          const an = (i / 24) * Math.PI * 2, cx = w / 2 + Math.cos(an) * w * 0.435, cy = w / 2 + Math.sin(an) * w * 0.435;
          g2.beginPath(); g2.moveTo(cx - 6 * Math.sin(an), cy + 6 * Math.cos(an)); g2.lineTo(cx + 6 * Math.sin(an), cy - 6 * Math.cos(an));
          g2.lineTo(cx + (r() - 0.5) * 12, cy + (r() - 0.5) * 12); g2.stroke();
        }
      });
      circleMat = k.glow(new THREE.Color(0.65, 0.45, 1.0), 0, ct);
      circle = k.plane(Math.min(W * 0.75, 2.6), Math.min(W * 0.75, 2.6), circleMat, root, 0, c.floorLocal + 0.02, 0.35);
      circle.rotation.x = -Math.PI / 2;
    }
    const N = 44, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), seed = new Float32Array(N);
    const r = rng(9);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (r() - 0.5) * (W + 2 * f); pos[i * 3 + 2] = 0.05 + r() * 0.25; seed[i] = r();
      const warm = r() < 0.35; col[i * 3] = warm ? 1 : 0.7; col[i * 3 + 1] = warm ? 0.82 : 0.5; col[i * 3 + 2] = warm ? 0.45 : 1;
    }
    const pg = k.geo(new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pm = c.own(new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }));
    const motes = new THREE.Points(pg, pm);
    motes.frustumCulled = false;
    root.add(motes);
    const y0 = (c.floorLocal ?? bot - 1) + 0.05, span = top + rise - y0 + 0.4;
    hookExtra = (p) => {
      const rising = p.arrived ? Math.exp(-1.6 * p.tau) : p.a;
      if (circle && circleMat) { circleMat.opacity = Math.min(1, 1.2 * rising + 0.12 * p.power) * p.alpha; circle.rotation.z = p.time * 0.25; circle.visible = circleMat.opacity > 0.01; }
      pm.opacity = (0.25 + 0.75 * rising) * p.alpha;
      for (let i = 0; i < N; i++) pos[i * 3 + 1] = y0 + ((seed[i] * span + p.time * (0.18 + 0.2 * seed[i])) % span);
      pg.attributes.position.needsUpdate = true;
    };
  } else {
    // signboard: a carved plaque on top, two ropes to iron rings in the ceiling
    const pt = label(k, propLabel(c.prop), { w: 512, h: 112, bg: '#24170d', fg: '#e8c46a', border: '#b48a3c', font: '700 58px Georgia, "Times New Roman", serif' });
    const plaqueMat = k.std(0xffffff, 0.6, 0.1, { map: pt, emissive: new THREE.Color(0xe8c46a), emissiveMap: pt, emissiveIntensity: 0.25 });
    fade.push(plaqueMat);
    const pw = Math.min(W * 0.8, 0.9), ph = pw * 0.22;
    const py = top + rise + f + ph / 2 - 0.02;
    k.box(pw, ph, 0.035, plaqueMat, moving, 0, py, -0.005);
    const ropeMat = k.std(0x8a6a3e, 0.9, 0);
    const ropes: THREE.Mesh[] = [];
    const ax = [-pw * 0.42, pw * 0.42];
    for (const x of ax) {
      ropes.push(k.cyl(0.011, 0.011, 1, ropeMat, root, 6));
      const ring = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.03, 0.007, 6, 14)), k.std(0x222222, 0.5, 0.8));
      ring.position.set(x, c.ceilLocal - 0.03, 0); root.add(ring);
    }
    topY = py + ph / 2;
    hookExtra = (p) => {
      for (let i = 0; i < 2; i++) {
        const a = new THREE.Vector3(ax[i], topY, 0).applyMatrix4(moving.matrix.compose(moving.position, moving.quaternion, moving.scale));
        stretch(ropes[i], a, new THREE.Vector3(ax[i], c.ceilLocal - 0.05, 0));
      }
      plaqueMat.emissiveIntensity = 0.25 + 0.9 * Math.max(p.flash, p.pulse);
    };
  }
  return {
    root, moving, roll: null, topY, bottomY, rollTop: topY, enterDur: solo ? 1.5 : 1.05, exitDur: 1.0, settle: 0, bounce: 0.04, sway: !solo, fade,
    hook: (p) => {
      glass.uniforms.uTime.value = p.time;
      glass.uniforms.uGlow.value = 0.35 + 0.65 * Math.max(p.power, p.flash) + 0.4 * p.pulse;
      glass.uniforms.uAlpha.value = p.alpha;
      runeMat.opacity = p.alpha * (0.3 + 0.7 * Math.max(p.power, p.flash, p.arrived ? 0 : p.a * 0.8) + 0.5 * p.pulse) * (0.9 + 0.1 * Math.sin(p.time * 3));
      gemMat.emissiveIntensity = 0.8 + 1.8 * Math.max(p.flash, p.pulse) + 0.4 * Math.sin(p.time * 2.2);
      gem.rotation.y = p.time * 0.8;
      hookExtra?.(p);
    },
  };
}

// ---- hologram (Helldivers): an emitter (floor for the solo screen, ceiling for chat props) fans a light beam to the
// screen's edge; holo edge lines + corner brackets + a header draw in, then the picture flickers in (scan bands).
function hologramSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const solo = c.prop === 'solo';
  const cyan = new THREE.Color(0.38, 0.9, 1.0), amber = new THREE.Color(1.0, 0.78, 0.25);
  const line = k.glow(cyan, 0.9), bracket = k.glow(cyan, 1), amberM = k.glow(amber, 0.95);
  const o = 0.035, t = 0.01;
  // edges + brackets (outside the rectangle)
  k.box(W + 2 * o, t, 0.003, line, moving, 0, H / 2 + o, SURF_Z);
  k.box(W + 2 * o, t, 0.003, line, moving, 0, -H / 2 - o, SURF_Z);
  k.box(t, H + 2 * o, 0.003, line, moving, -W / 2 - o, 0, SURF_Z);
  k.box(t, H + 2 * o, 0.003, line, moving, W / 2 + o, 0, SURF_Z);
  const bl = Math.min(0.25, 0.1 * W), bo = o + 0.035, bt = 0.022;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    k.box(bl, bt, 0.003, bracket, moving, sx * (W / 2 + bo - bl / 2), sy * (H / 2 + bo), SURF_Z + 0.001);
    k.box(bt, bl, 0.003, bracket, moving, sx * (W / 2 + bo), sy * (H / 2 + bo - bl / 2), SURF_Z + 0.001);
  }
  // faint grid glow behind the picture (shows in the margins)
  const grid = k.tex(256, 256, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
    for (let i = 0; i <= w; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
  }, [Math.max(1, Math.round(W * 2)), Math.max(1, Math.round(H * 2))]);
  const gridM = k.glow(cyan, 0.16, grid);
  k.plane(W + 0.24, H + 0.24, gridM, moving, 0, 0, -0.01);
  // header
  const ht = label(k, solo ? 'SUPER EARTH  ▸  LIVE FEED' : propLabel(c.prop), { w: 512, h: 64, bg: '#000', fg: '#fff', font: '700 34px "Segoe UI", Inter, system-ui, sans-serif' });
  const headM = k.glow(solo ? amber : cyan, 0.95, ht);
  const hw = Math.min(W * 0.62, 1.6), hh = hw / 8;
  const headY = solo ? H / 2 + bo + hh * 0.9 : -H / 2 - bo - hh * 0.9;
  k.plane(hw, hh, headM, moving, 0, headY, SURF_Z);
  k.box(hw * 0.3, 0.008, 0.003, amberM, moving, -W / 2 + hw * 0.15, headY, SURF_Z);
  c.surface.position.set(0, 0, SURF_Z);
  moving.add(c.surface);
  // emitter + beam
  const onFloor = solo && c.floorLocal !== null && c.floorLocal > -4.5;
  const emitY = onFloor ? c.floorLocal! : c.ceilLocal;
  const dir = onFloor ? 1 : -1;
  const em = new THREE.Group();
  em.position.set(0, emitY, onFloor ? 0.18 : 0);
  if (!onFloor) em.rotation.x = Math.PI;
  const metal = k.std(0x1d2126, 0.45, 0.7);
  const hz = k.tex(256, 32, (g, w, h) => { g.fillStyle = '#111'; g.fillRect(0, 0, w, h); g.fillStyle = '#f2c200'; for (let x = -h; x < w; x += 28) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 14, h); g.lineTo(x + 14 + h, 0); g.lineTo(x + h, 0); g.fill(); } });
  const hazard = k.std(0xffffff, 0.55, 0.3, { map: hz });
  const baseM = k.cyl(0.2, 0.24, 0.09, metal, em, 24); baseM.position.y = 0.045;
  const ring = k.cyl(0.245, 0.245, 0.03, hazard, em, 24, true); ring.position.y = 0.05;
  const lensM = k.std(0x08202a, 0.2, 0.2, { emissive: cyan.clone(), emissiveIntensity: 0.4 });
  const lens = k.cyl(0.07, 0.1, 0.04, lensM, em, 20); lens.position.y = 0.11;
  root.add(em);
  const apex = new THREE.Vector3(0, emitY + dir * 0.13, onFloor ? 0.18 : 0);
  const edgeY = onFloor ? -H / 2 - o : H / 2 + o;
  const bv = new Float32Array([
    apex.x, apex.y, apex.z, -W / 2 - o, edgeY, SURF_Z, W / 2 + o, edgeY, SURF_Z,
    apex.x, apex.y, apex.z, -W / 2 - o, edgeY, -0.08, W / 2 + o, edgeY, -0.08,
  ]);
  const ba = new Float32Array([1, 0, 0, 1, 0, 0]);
  const bg = k.geo(new THREE.BufferGeometry());
  bg.setAttribute('position', new THREE.BufferAttribute(bv, 3));
  bg.setAttribute('aT', new THREE.BufferAttribute(ba, 1));
  const beamM = c.own(new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uTime: { value: 0 }, uC: { value: cyan } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    vertexShader: /* glsl */ `attribute float aT; varying float vT; varying vec3 vP; void main(){ vT = aT; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `uniform float uI, uTime; uniform vec3 uC; varying float vT; varying vec3 vP;
      void main(){ float s = 0.75 + 0.25 * sin(vP.y * 60.0 - uTime * 12.0); gl_FragColor = vec4(uC * (0.4 + 0.9 * vT), uI * (0.05 + 0.4 * vT * vT) * s); }`,
  }));
  const beam = new THREE.Mesh(bg, beamM);
  beam.frustumCulled = false;
  root.add(beam);
  const mats = [line, bracket, amberM, gridM, headM];
  const baseOp = mats.map((m) => m.opacity);
  return {
    root, moving, roll: null, topY: H / 2 + bo + (solo ? hh * 1.5 : 0), bottomY: -H / 2 - bo - (solo ? 0 : hh * 1.5), rollTop: H / 2, enterDur: 1.1, exitDur: 0.7, settle: 0, bounce: 0, sway: false, fade: [],
    hook: (p) => {
      const pop = easeOut(p.a / 0.25);
      if (onFloor) em.position.y = emitY - 0.1 * (1 - pop);
      em.visible = p.a > 0.001;
      const beamOn = clamp01((p.a - 0.12) / 0.3);
      const hum = p.arrived ? 0.5 + 0.1 * Math.sin(p.time * 9) : 1;
      beamM.uniforms.uI.value = beamOn * hum * (hash1(Math.floor(p.time * 24)) < 0.06 ? 0.4 : 1) * (0.7 + 0.3 * (1 - p.power) + 0.3 * p.pulse);
      beamM.uniforms.uTime.value = p.time;
      lensM.emissiveIntensity = 0.4 + 2.5 * beamOn + 1.5 * p.flash;
      // edge lines draw in and flicker; afterwards an occasional glitch (the picture itself never flickers)
      const glitch = p.arrived && p.power >= 1 && hash1(Math.floor(p.time * 7) + 3) > 0.965 ? 0.35 : 1;
      const lvl = p.alpha * glitch * (1 + 0.8 * p.pulse);
      mats.forEach((m, i) => (m.opacity = baseOp[i] * lvl));
    },
  };
}

// ---- TerraGroup display (Labs): white rounded bezel with a chin (wordmark + blue status strip), on a ceiling mast.
function roundRect(w: number, h: number, r: number, cy = 0): THREE.Shape {
  const s = new THREE.Shape(), x0 = -w / 2, y0 = cy - h / 2;
  s.moveTo(x0 + r, y0); s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}
function terragroupSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const b = 0.028 + 0.004 * W, chin = 0.05 + 0.012 * W;
  const white = k.std(0xe4e7eb, 0.38, 0.08), grey = k.std(0x9aa1a9, 0.4, 0.5), black = k.std(0x07080a, 0.25, 0.2);
  const outer = roundRect(W + 2 * b, H + 2 * b + chin, 0.03, -chin / 2);
  const hole = roundRect(W + 0.008, H + 0.008, 0.004);
  outer.holes.push(new THREE.Path(hole.getPoints(8)));
  const bez = new THREE.Mesh(k.geo(new THREE.ExtrudeGeometry(outer, { depth: 0.032, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 6 })), white);
  bez.position.z = -0.03;
  moving.add(bez);
  k.plane(W + 0.01, H + 0.01, black, moving, 0, 0, 0.002);
  k.box(W * 0.62, H * 0.55, 0.06, grey, moving, 0, 0, -0.065);
  const mount = k.box(0.16, 0.07, 0.1, grey, moving, 0, H / 2 + b + 0.035, -0.06);
  const wm = label(k, c.prop === 'solo' ? 'TERRAGROUP' : `TERRAGROUP · ${propLabel(c.prop)}`, { w: 512, h: 64, bg: '#e4e7eb', fg: '#2c3440', font: '600 34px "Segoe UI", Inter, system-ui, sans-serif' });
  const wmM = k.std(0xffffff, 0.4, 0.05, { map: wm });
  const chinY = -H / 2 - b - chin / 2 + 0.004;
  const ww = Math.min(W * 0.3, c.prop === 'solo' ? 0.5 : W * 0.8);
  k.plane(ww, ww / 8, wmM, moving, 0, chinY + chin * 0.12, 0.0065);
  const led = k.std(0x0a1a2c, 0.3, 0, { emissive: new THREE.Color(0x3aa0ff), emissiveIntensity: 0.3 });
  k.box(W * 0.9, 0.006, 0.004, led, moving, 0, chinY - chin * 0.3, 0.007);
  c.surface.position.set(0, 0, SURF_Z);
  moving.add(c.surface);
  // mast: a ceiling plate + sleeve (fixed) and a rod down to the display's mount
  k.box(0.28, 0.02, 0.28, white, root, 0, c.ceilLocal - 0.01, -0.06);
  const ring = k.std(0x0a1a2c, 0.3, 0, { emissive: new THREE.Color(0x3aa0ff), emissiveIntensity: 0.4 });
  k.box(0.2, 0.006, 0.2, ring, root, 0, c.ceilLocal - 0.023, -0.06);
  k.box(0.1, 0.34, 0.1, white, root, 0, c.ceilLocal - 0.19, -0.06);
  const rod = k.box(0.06, 1, 0.06, grey, root, 0, 0, -0.06);
  const ledCh = govChannel('screen LED'), ringCh = govChannel('screen ring');
  const mountTop = H / 2 + b + 0.07;
  void mount;
  return {
    root, moving, roll: null, topY: mountTop, bottomY: -H / 2 - b - chin, rollTop: mountTop, enterDur: 1.2, exitDur: 0.9, settle: 0, bounce: 0.02, sway: c.prop !== 'solo', fade: [],
    hook: (p) => {
      const top = p.y + mountTop, lo = c.ceilLocal - 0.3, len = Math.max(0.01, lo - top);
      rod.scale.y = len; rod.position.y = top + len / 2; rod.visible = len > 0.02;
      // (photosensitivity: the LED bar and ring are outputs on the page's governor — the pulse runs at ~4.8 Hz)
      const gov = pageGovernor(performance.timeOrigin + performance.now());
      led.emissiveIntensity = gov.step(ledCh, 0.3 + 2.2 * Math.max(p.power, p.flash) + 2 * p.pulse * (0.5 + 0.5 * Math.sin(p.time * 30)));
      ring.emissiveIntensity = gov.step(ringCh, 0.4 + 1.5 * p.flash);
    },
  };
}

// ---- chain-hoist tarp (Factory): a rusty I-beam spreader drops on two chain falls and swings to a stop; a grimy tarp
// is lashed under it with a pipe weight. Chat props: a rusty steel monitor box with a hazard plate, on chains.
function chainLinks(k: Kit, mat: THREE.Material, parent: THREE.Object3D, max = 90) {
  const m = new THREE.InstancedMesh(k.geo(new THREE.TorusGeometry(0.026, 0.0065, 5, 10)), mat, max);
  m.frustumCulled = false;
  m.count = 0;
  parent.add(m);
  const q = new THREE.Quaternion(), tw = new THREE.Quaternion(), mtx = new THREE.Matrix4(), s = new THREE.Vector3(0.62, 1, 1), up = new THREE.Vector3(0, 1, 0);
  return (a: THREE.Vector3, b: THREE.Vector3) => {
    const d = b.clone().sub(a), len = d.length();
    const n = Math.min(max, Math.max(0, Math.floor(len / 0.04)));
    if (len < 1e-4) { m.count = 0; return; }
    d.divideScalar(len);
    q.setFromUnitVectors(up, d);
    for (let i = 0; i < n; i++) {
      tw.setFromAxisAngle(d, (i % 2) * Math.PI / 2).multiply(q);
      mtx.compose(a.clone().addScaledVector(d, (i + 0.5) * (len / n)), tw, s);
      m.setMatrixAt(i, mtx);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  };
}
function tarpSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const solo = c.prop === 'solo';
  const rust = k.std(0xffffff, 0.85, 0.45, { map: rustTex(k) });
  const steel = k.std(0x2b2d30, 0.55, 0.8);
  const yellow = k.std(0xc49a1a, 0.6, 0.35, { map: rustTex(k, '#b88c14', 13) });
  const fade: THREE.Material[] = [];
  let attachX: number, attachY: number, topY: number, bottomY: number;
  let hookExtra: ((p: SkinPose) => void) | null = null;
  if (solo) {
    // I-beam along x
    const fl = 0.13, bh = 0.15, web = 0.012, ft = 0.014;
    const sh = new THREE.Shape();
    sh.moveTo(-fl / 2, -bh / 2); sh.lineTo(fl / 2, -bh / 2); sh.lineTo(fl / 2, -bh / 2 + ft); sh.lineTo(web / 2, -bh / 2 + ft); sh.lineTo(web / 2, bh / 2 - ft);
    sh.lineTo(fl / 2, bh / 2 - ft); sh.lineTo(fl / 2, bh / 2); sh.lineTo(-fl / 2, bh / 2); sh.lineTo(-fl / 2, bh / 2 - ft); sh.lineTo(-web / 2, bh / 2 - ft);
    sh.lineTo(-web / 2, -bh / 2 + ft); sh.lineTo(-fl / 2, -bh / 2 + ft); sh.lineTo(-fl / 2, -bh / 2);
    const L = W + 0.6;
    const bgeo = k.geo(new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false }));
    bgeo.translate(0, 0, -L / 2); bgeo.rotateY(Math.PI / 2);
    const tarpTop = H / 2 + 0.12, beamY = tarpTop + bh / 2 + 0.005;
    const beam = new THREE.Mesh(bgeo, rust); beam.position.y = beamY; moving.add(beam);
    const st = label(k, 'SWL 2 T', { w: 256, h: 64, bg: '#000', fg: '#e8c21c', font: '900 40px Impact, "Arial Black", sans-serif' });
    k.plane(0.26, 0.065, k.glow(new THREE.Color(0.8, 0.7, 0.3), 0.85, st), moving, -W / 4, beamY, web / 2 + 0.002);
    // tarp (margins rumple backwards only, never in front of the picture)
    const tw = W + 0.36, th = H + 0.3;
    const tt = k.tex(512, 320, (g, w, h) => {
      const r = rng(21);
      g.fillStyle = '#5f5d40'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '30,28,18' : '130,125,90'},${0.05 + r() * 0.08})`; g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3); }
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(40,28,14,0.45)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(40,36,22,0.9)'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
      g.setLineDash([7, 6]); g.strokeStyle = 'rgba(200,190,150,0.5)'; g.lineWidth = 2; g.strokeRect(16, 16, w - 32, h - 32); g.setLineDash([]);
      for (let i = 0; i < 9; i++) { g.fillStyle = `rgba(60,40,20,${0.2 + r() * 0.3})`; g.beginPath(); g.ellipse(r() * w, h * (0.6 + r() * 0.4), 10 + r() * 40, 6 + r() * 20, 0, 0, Math.PI * 2); g.fill(); }
    });
    const tarpM = k.std(0xffffff, 0.95, 0, { map: tt, side: THREE.DoubleSide });
    const tg = k.geo(new THREE.PlaneGeometry(tw, th, 18, 12));
    const tp = tg.attributes.position as THREE.BufferAttribute;
    const r = rng(4);
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), y = tp.getY(i) + (tarpTop - th / 2);
      const out = Math.max(Math.abs(x) - W / 2 - 0.015, y - H / 2 - 0.015, -H / 2 - 0.015 - y, 0);
      if (out > 0) tp.setZ(i, -Math.min(0.03, out * 0.25) * (0.5 + r()));
    }
    tg.computeVertexNormals();
    const tarp = new THREE.Mesh(tg, tarpM); tarp.position.set(0, tarpTop - th / 2, -0.004); moving.add(tarp);
    const ropeM = k.std(0x9a8558, 0.9, 0);
    const nT = Math.max(3, Math.round(W / 0.45));
    for (let i = 0; i < nT; i++) {
      const tor = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.03, 0.007, 5, 12)), ropeM);
      tor.position.set(-tw / 2 + 0.06 + (i / (nT - 1)) * (tw - 0.12), tarpTop + 0.01, 0); moving.add(tor);
    }
    const pipe = k.cyl(0.026, 0.026, W + 0.44, rust, moving, 10); pipe.rotation.z = Math.PI / 2; pipe.position.set(0, tarpTop - th - 0.012, 0.004);
    attachX = W / 2 + 0.2; attachY = beamY + 0.2;
    for (const sx of [-1, 1]) {
      k.box(0.11, 0.13, 0.09, yellow, moving, sx * attachX, beamY + 0.13);
      const hk = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.035, 0.01, 6, 12, Math.PI * 1.4)), steel);
      hk.position.set(sx * attachX, beamY + 0.05, 0); moving.add(hk);
    }
    topY = attachY; bottomY = tarpTop - th - 0.04;
  } else {
    // rusty steel monitor box: frame + back + rivets + a hazard plate with a stencil label
    const fb = 0.045, d = 0.08;
    k.box(W + 2 * fb, fb, d, rust, moving, 0, H / 2 + fb / 2, -0.03);
    k.box(W + 2 * fb, fb, d, rust, moving, 0, -H / 2 - fb / 2, -0.03);
    k.box(fb, H, d, rust, moving, -W / 2 - fb / 2, 0, -0.03);
    k.box(fb, H, d, rust, moving, W / 2 + fb / 2, 0, -0.03);
    k.box(W + 0.02, H + 0.02, 0.14, rust, moving, 0, 0, -0.12);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) { const rv = k.cyl(0.011, 0.011, 0.012, steel, moving, 8); rv.rotation.x = Math.PI / 2; rv.position.set(sx * (W / 2 + fb / 2), sy * (H / 2 + fb / 2), 0.016); }
    const pl = label(k, propLabel(c.prop), { w: 512, h: 96, bg: '#d9a912', fg: '#111', font: '900 52px Impact, "Arial Black", sans-serif', stripes: ['#141414', '#d9a912'] });
    const plM = k.std(0xffffff, 0.7, 0.3, { map: pl, emissive: new THREE.Color(0xffc400), emissiveMap: pl, emissiveIntensity: 0.1 });
    const pw = Math.min(W * 0.9, 1.0), ph = pw * 0.19;
    k.box(pw, ph, 0.02, plM, moving, 0, H / 2 + fb + ph / 2 + 0.01, -0.02);
    attachX = pw * 0.42; attachY = H / 2 + fb + ph + 0.04;
    for (const sx of [-1, 1]) { const eb = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.025, 0.007, 6, 12)), steel); eb.position.set(sx * attachX, attachY - 0.02, -0.02); moving.add(eb); }
    topY = attachY; bottomY = -H / 2 - fb;
    const plCh = skinCh();
    hookExtra = (p) => { plM.emissiveIntensity = plCh(0.1 + 1.2 * Math.max(p.flash * 0.6, p.pulse * (0.5 + 0.5 * Math.sin(p.time * 26)))); };   // (4.1 Hz: governed)
  }
  c.surface.position.set(0, 0, SURF_Z);
  moving.add(c.surface);
  // chain falls from ceiling hoists to the unit
  const hoistY = c.ceilLocal - 0.1;
  for (const sx of [-1, 1]) { k.box(0.15, 0.18, 0.13, yellow, root, sx * attachX, hoistY); k.box(0.2, 0.02, 0.18, steel, root, sx * attachX, c.ceilLocal - 0.01); }
  const chains = [chainLinks(k, steel, root), chainLinks(k, steel, root)];
  const tmp = new THREE.Vector3();
  return {
    root, moving, roll: null, topY, bottomY, rollTop: topY, enterDur: solo ? 0.85 : 0.8, exitDur: 1.2, settle: solo ? 0.75 : 0.3, bounce: 0.04, sway: false, fade,
    hook: (p) => {
      moving.updateMatrix();
      [-1, 1].forEach((sx, i) => {
        tmp.set(sx * attachX, attachY, 0).applyMatrix4(moving.matrix);
        chains[i](tmp.clone(), new THREE.Vector3(sx * attachX, hoistY - 0.09, 0));
      });
      hookExtra?.(p);
    },
  };
}

// ---- bedsheet on a clothesline (Customs Dorms): a rope with pegs; the sheet unfurls down from it, its edges sway.
// Chat props: a duct-taped plywood board on ropes with a marker label.
function bedsheetSkin(c: SkinCtx): BuiltSkin {
  const k = new Kit(c), { W, H } = c, { root, moving } = base();
  const solo = c.prop === 'solo';
  const ropeM = k.std(0xb9ab8c, 0.9, 0);
  const pegM = k.std(0xb08a58, 0.8, 0);
  const tapeTex = (text: string) => k.tex(512, 96, (g, w, h) => {
    const r = rng(17);
    g.fillStyle = '#8d9093'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '60,60,60' : '200,200,200'},${0.06 + r() * 0.08})`; g.fillRect(r() * w, r() * h, 2 + r() * 6, 1); }
    g.fillStyle = '#111'; g.font = '700 58px "Segoe Print", "Comic Sans MS", "Marker Felt", cursive'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save(); g.translate(w / 2, h / 2 + 4); g.rotate(-0.03); g.fillText(text, 0, 0, w * 0.9); g.restore();
  });
  const ropes: THREE.Mesh[] = [];
  let ends: number[];
  let lineY: number;
  let topY: number, bottomY: number;
  let roll: THREE.Group | null = null;
  let hookExtra: ((p: SkinPose) => void) | null = null;
  if (solo) {
    lineY = H / 2 + 0.2;
    const ex = W / 2 + 0.4;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-ex, lineY + 0.03, 0), new THREE.Vector3(0, lineY - 0.012, 0), new THREE.Vector3(ex, lineY + 0.03, 0)]);
    const line = new THREE.Mesh(k.geo(new THREE.TubeGeometry(curve, 32, 0.007, 5)), ropeM);
    moving.add(line);
    ends = [-ex, ex];
    // the sheet: its top on the line (roll origin), unrolls downwards
    roll = new THREE.Group(); roll.position.y = lineY; moving.add(roll);
    const sw = W + 0.3, sh = H + 0.36;
    const st = k.tex(512, 384, (g, w, h) => {
      const r = rng(23);
      g.fillStyle = '#e8e2d2'; g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 38) { g.fillStyle = 'rgba(120,150,185,0.28)'; g.fillRect(x, 0, 12, h); g.fillStyle = 'rgba(120,150,185,0.12)'; g.fillRect(x + 18, 0, 4, h); }
      for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(190,160,90,${0.12 + r() * 0.15})`; g.beginPath(); g.ellipse(r() * w, r() * h, 12 + r() * 40, 8 + r() * 26, r() * 3, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = 'rgba(120,110,90,0.5)'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = 'rgba(40,30,20,0.8)'; g.beginPath(); g.arc(w * 0.93, h * 0.9, 5, 0, Math.PI * 2); g.fill();
      for (let i = 0; i < 5; i++) { g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 3; g.beginPath(); const x = r() * w; g.moveTo(x, 0); g.lineTo(x + (r() - 0.5) * 60, h); g.stroke(); }
    });
    const sheetM = k.std(0xffffff, 0.95, 0, { map: st, side: THREE.DoubleSide });
    const sg = k.geo(new THREE.PlaneGeometry(sw, sh, 16, 12));
    sg.translate(0, -sh / 2, 0);
    const sheet = new THREE.Mesh(sg, sheetM); sheet.position.z = -0.004; roll.add(sheet);
    const sp = sg.attributes.position as THREE.BufferAttribute;
    const rest = Float32Array.from(sp.array as Float32Array);
    // margin weight per vertex (0 inside the picture rectangle)
    const wgt = new Float32Array(sp.count);
    for (let i = 0; i < sp.count; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1] + lineY;   // rest y relative to the rect centre
      wgt[i] = clamp01(Math.max(Math.abs(x) - W / 2 - 0.02, y - H / 2 - 0.02, -H / 2 - 0.02 - y, 0) / 0.12);
    }
    // folded-over flap + pegs (above the picture)
    k.plane(sw, 0.12, sheetM, roll, 0, -0.06, 0.006);
    const nP = Math.max(3, Math.round(W / 0.5));
    for (let i = 0; i < nP; i++) k.box(0.018, 0.07, 0.02, pegM, roll, -sw / 2 + 0.1 + (i / (nP - 1)) * (sw - 0.2), -0.015, 0.014);
    c.surface.position.set(0, -lineY, SURF_Z);
    roll.add(c.surface);
    topY = lineY + 0.05; bottomY = lineY - sh;
    let last = -1;
    hookExtra = (p) => {
      if (!moving.visible || (p.arrived && p.tau > 1 && p.time - last < 1 / 30)) return;
      last = p.time;
      const amp = 0.012 + 0.05 * (1 - Math.min(1, p.u));
      for (let i = 0; i < sp.count; i++) {
        const w0 = wgt[i];
        if (w0 <= 0) continue;
        const x = rest[i * 3], y = rest[i * 3 + 1];
        sp.setZ(i, -w0 * amp * (1.2 + Math.sin(p.time * 1.7 + x * 2.3 + y * 1.1)));
      }
      sp.needsUpdate = true;
    };
  } else {
    // plywood board + tape corners + tape label + two ropes
    const ply = k.tex(256, 256, (g, w, h) => {
      const r = rng(31);
      g.fillStyle = '#b89464'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) { g.strokeStyle = `rgba(${r() < 0.5 ? '90,60,30' : '220,190,140'},${0.1 + r() * 0.2})`; g.lineWidth = 1 + r() * 3; g.beginPath(); const y = r() * h; g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 30, w * 0.6, y + (r() - 0.5) * 30, w, y); g.stroke(); }
      g.fillStyle = 'rgba(60,40,20,0.5)'; g.beginPath(); g.ellipse(w * 0.7, h * 0.3, 10, 6, 0.4, 0, Math.PI * 2); g.fill();
    });
    const plyM = k.std(0xffffff, 0.85, 0, { map: ply });
    const bw = W + 0.16, bh = H + 0.16;
    k.box(bw, bh, 0.022, plyM, moving, 0, 0, -0.018);
    const tapeM = k.std(0x8d9093, 0.55, 0.1);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const tp = k.plane(0.16, 0.05, tapeM, moving, sx * (W / 2 + 0.035), sy * (H / 2 + 0.035), -0.006);
      tp.rotation.z = sx * sy * Math.PI / 4;
    }
    const lt = tapeTex(propLabel(c.prop));
    const lM = k.std(0xffffff, 0.6, 0.05, { map: lt, emissive: new THREE.Color(0xffffff), emissiveMap: lt, emissiveIntensity: 0 });
    const lw = Math.min(W * 0.8, 0.8), lh = lw * 0.19;
    const ly = bh / 2 - 0.02 + lh / 2;
    const lab = k.plane(lw, lh, lM, moving, 0, ly, -0.004);
    lab.rotation.z = 0.02;
    lineY = ly + lh / 2 + 0.02;
    ends = [-bw * 0.4, bw * 0.4];
    for (const x of ends) { const eye = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.018, 0.005, 6, 12)), k.std(0x777777, 0.4, 0.8)); eye.position.set(x, lineY - 0.01, -0.018); moving.add(eye); }
    c.surface.position.set(0, 0, SURF_Z);
    moving.add(c.surface);
    topY = lineY; bottomY = -bh / 2;
    const lCh = skinCh();
    hookExtra = (p) => { lM.emissiveIntensity = lCh(0.5 * Math.max(p.flash * 0.5, p.pulse * (0.5 + 0.5 * Math.sin(p.time * 26)))); };   // (governed)
  }
  for (const x of ends) {
    ropes.push(k.cyl(0.007, 0.007, 1, ropeM, root, 5));
    const hk = new THREE.Mesh(k.geo(new THREE.TorusGeometry(0.02, 0.005, 6, 12)), k.std(0x666666, 0.4, 0.8));
    hk.position.set(x, c.ceilLocal - 0.02, 0); root.add(hk);
  }
  const tmp = new THREE.Vector3();
  return {
    root, moving, roll, topY, bottomY, rollTop: lineY, enterDur: solo ? 1.3 : 1.05, exitDur: 1.0, settle: 0, bounce: 0.035, sway: !solo, fade: [],
    hook: (p) => {
      moving.updateMatrix();
      ends.forEach((x, i) => { tmp.set(x, lineY + (solo ? 0.03 : 0), solo ? 0 : -0.018).applyMatrix4(moving.matrix); stretch(ropes[i], tmp.clone(), new THREE.Vector3(x, c.ceilLocal - 0.035, tmp.z)); });
      hookExtra?.(p);
    },
  };
}

// ---- the room's own GLB node as the housing (scene.json screenSkin.node / SOLO_SKIN, CHAT_MONITOR_SKIN, CHAT_BOARD_SKIN)
// Contract: the node's origin is the centre of the screen rectangle, +Z faces the viewer. The rectangle's width is a
// child mesh named *_RECT (its bounds; hidden) or the node's extras.screenWidth (glTF units), else 1. The clone is
// scaled so that width = the rig's W. Children named *_FIXED stay put (ceiling mounts, floor emitters); everything
// else moves with the arrival motion.
function customSkin(c: SkinCtx, tpl: THREE.Object3D): BuiltSkin {
  const { root, moving } = base();
  const clone = tpl.clone(true);
  clone.visible = true;
  clone.position.set(0, 0, 0); clone.quaternion.identity();
  clone.traverse((o) => {
    o.visible = true;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material) m.material = Array.isArray(m.material) ? m.material.map((x) => c.own(x.clone())) : c.own(m.material.clone());
    o.castShadow = false; o.receiveShadow = false;
  });
  clone.updateMatrixWorld(true);
  let rectW = 0; const rc = new THREE.Vector3();
  const rectNode = (() => { let f: THREE.Object3D | null = null; clone.traverse((o) => { if (!f && /_RECT$/i.test(o.name)) f = o; }); return f as THREE.Object3D | null; })();
  if (rectNode) {
    const bb = new THREE.Box3().setFromObject(rectNode, true);
    const inv = new THREE.Matrix4().copy(clone.matrixWorld).invert();
    bb.applyMatrix4(inv);
    rectW = bb.max.x - bb.min.x; bb.getCenter(rc);
    rectNode.visible = false;
  }
  const ex = Number((tpl.userData as Record<string, unknown>).screenWidth);
  if (!(rectW > 1e-3)) rectW = Number.isFinite(ex) && ex > 0 ? ex : 1;
  const holder = new THREE.Group();
  holder.scale.setScalar(c.W / rectW);
  clone.position.set(-rc.x * clone.scale.x, -rc.y * clone.scale.y, -rc.z * clone.scale.z);
  holder.add(clone);
  moving.add(holder);
  // *_FIXED parts stay with the rig, not the motion
  holder.updateMatrixWorld(true);
  const fixed: THREE.Object3D[] = [];
  clone.traverse((o) => { if (/_FIXED$/i.test(o.name)) fixed.push(o); });
  for (const f of fixed) root.attach(f);
  c.surface.position.set(0, 0, SURF_Z);
  moving.add(c.surface);
  const bb = new THREE.Box3().setFromObject(holder, true);
  const fade: THREE.Material[] = [];
  holder.traverse((o) => { const m = (o as THREE.Mesh).material; if ((o as THREE.Mesh).isMesh && m) for (const x of Array.isArray(m) ? m : [m]) fade.push(x); });
  const topY = Number.isFinite(bb.max.y) ? Math.max(bb.max.y, c.H / 2) : c.H / 2;
  const bottomY = Number.isFinite(bb.min.y) ? Math.min(bb.min.y, -c.H / 2) : -c.H / 2;
  return { root, moving, roll: null, topY, bottomY, rollTop: topY, enterDur: 1.2, exitDur: 0.9, settle: 0, bounce: 0.03, sway: c.prop !== 'solo', fade };
}

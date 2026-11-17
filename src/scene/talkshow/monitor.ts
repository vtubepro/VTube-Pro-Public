// The interview's guest MONITOR: an in-set screen (a generated housing from props.ts, or the room's own screen skin —
// scrying mirror, hologram, TerraGroup display, custom SOLO_SKIN nodes) whose picture is split into up to 3 guest
// PANELS + an overlay (names on lower thirds, the show bug, the idle "stand by" card, a chat-free 4th cell with the show
// title). Each panel shows:
//   · a performer guest: a render target of their remote mini set (remote.ts);
//   · a video guest: the host's shared window (in-scene capture, cropped to their tile of a call grid), or an OBS
//     passthrough HOLE (alpha 0 — OBS shows a Window Capture placed under the browser source) that only opens while
//     the camera is settled on that panel's own shot (a fixed Window Capture lines up with exactly one shot);
//   · a card (NO SIGNAL / connecting) when there's nothing.
// The picture rectangle is flat and exactly `W × H`: the OBS hole and the in-scene content never depend on the frame.
import * as THREE from 'three';
import { buildSkin, SkinDriver, SURF_Z } from '../screenSkins.ts';
import type { SkinChoice } from '../soloScreen.ts';
import { needsVideoDecode } from '../screenFx.ts';
import { buildHousing, MONITOR_ASPECT, PropKit, THEME_LOOKS, type BuiltHousing } from './props.ts';
import type { MonitorStyle, SetTheme } from '../../../shared/talkshow.ts';
import { coverCrop } from '../../../shared/framing.ts';
import { pageGovernor } from '../../../shared/flashGovernor.ts';

export type PanelMode = 'card' | 'tex' | 'hole';
export interface PanelSource {
  mode: PanelMode;
  tex?: THREE.Texture | null;
  /** Source sub-rect (fractions, top-left origin) — e.g. a guest's tile of a call window. */
  crop?: [number, number, number, number] | null;
  /** Source aspect (w/h) for a cover fit. */
  aspect?: number;
  /** Where the face is in the source (fractions, top-left; a TV guest's TvInfo.face, a video guest's stamped box): the
   *  cover crop follows it so the face stays inside the panel's safe area (shared/framing.ts coverCrop). */
  face?: [number, number, number, number] | null;
  name: string;
  /** Lower-third second line ('LIVE VIA SATELLITE', 'ON THE LINE' …). */
  tag: string;
  /** Card text when mode = card. */
  card?: string;
}

const vert = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const frag = /* glsl */ `
uniform sampler2D uT0, uT1, uT2, uOver;
uniform vec4 uR0, uR1, uR2;      // panel rect in picture uv (x, y, w, h), origin bottom-left
uniform vec4 uS0, uS1, uS2;      // source uv rect for that panel (x, y, w, h), origin bottom-left
uniform vec3 uMode;
uniform vec3 uDec;               // per panel: 1 = an sRGB video texture three.js uploads undecoded (decode here, else it's encoded twice: a grey wash)              // per panel: 0 card (overlay only), 1 texture, 2 hole
// uSafe = the flash limit is on (shared/flashGovernor.ts): the power-on's 16-24 Hz random flicker / band popping on
// a whole screen would count as flashing — steady (or 2.5 Hz) instead
uniform float uPower, uOpen, uTime, uStyle, uCrt, uN, uSafe;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float inR(vec2 p, vec4 r) { return step(r.x, p.x) * step(p.x, r.x + r.z) * step(r.y, p.y) * step(p.y, r.y + r.w); }
vec3 panel(sampler2D t, vec2 p, vec4 r, vec4 s, float dec) { vec2 q = (p - r.xy) / r.zw; vec3 c = texture2D(t, s.xy + q * s.zw).rgb; return dec > 0.5 ? sRGBTransferEOTF(vec4(c, 1.0)).rgb : c; }
// a phone-in card: deep blue, a pulsing voice waveform in the middle (behind a closed OBS hole)
vec3 caller(vec2 p, vec4 r) {
  vec2 q = (p - r.xy) / r.zw;
  vec3 c = mix(vec3(0.02, 0.04, 0.09), vec3(0.06, 0.1, 0.2), q.y);
  float x = floor(q.x * 28.0);
  float h = 0.06 + 0.22 * abs(sin(x * 1.7 + uTime * 5.0) * sin(x * 0.53 + uTime * 2.3));
  float bar = step(abs(q.y - 0.56), h) * step(0.2, fract(q.x * 28.0)) * step(0.22, q.x) * step(q.x, 0.78);
  return c + vec3(0.25, 0.75, 1.0) * bar * 0.8;
}
void main() {
  vec2 p = vUv;
  float pw = clamp(uPower, 0.0, 1.0);
  if (uStyle > 0.5 && pw <= 0.001) discard;
  // CRT power-on (0): a dot → a line → the picture; hologram (1): scan bands; fade (2): dithered lamp warm-up
  float hx = smoothstep(0.0, 0.12, pw) * 0.5, vy = mix(0.003, 0.5, pow(smoothstep(0.12, 0.32, pw), 1.6));
  float band = uStyle < 0.5 ? step(abs(p.x - 0.5), hx) * step(abs(p.y - 0.5), vy) : 1.0;
  if (uStyle > 0.5 && uStyle < 1.5 && pw < 0.999 && hash(vec2(floor(p.y * 64.0), floor(uTime * mix(24.0, 2.5, uSafe)))) > pw * 1.25 - 0.08) discard;
  if (uStyle > 1.5 && pw < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > pw * 1.05) discard;
  vec3 col = vec3(0.03, 0.035, 0.05);
  float hole = 0.0;
  if (uN > 0.5 && inR(p, uR0) > 0.5) { if (uMode.x > 1.5) { hole = 1.0; col = caller(p, uR0); } else if (uMode.x > 0.5) col = panel(uT0, p, uR0, uS0, uDec.x); }
  if (uN > 1.5 && inR(p, uR1) > 0.5) { if (uMode.y > 1.5) { hole = 1.0; col = caller(p, uR1); } else if (uMode.y > 0.5) col = panel(uT1, p, uR1, uS1, uDec.y); }
  if (uN > 2.5 && inR(p, uR2) > 0.5) { if (uMode.z > 1.5) { hole = 1.0; col = caller(p, uR2); } else if (uMode.z > 0.5) col = panel(uT2, p, uR2, uS2, uDec.z); }
  vec4 ov = texture2D(uOver, p);
  // retro tube: scanlines + a soft vignette (content only, never the hole)
  if (uCrt > 0.5) { col *= 0.86 + 0.14 * sin(p.y * 900.0); vec2 d = p - 0.5; col *= 1.0 - dot(d, d) * 0.55; }
  col = mix(col, ov.rgb, ov.a);
  float settle = smoothstep(0.32, 1.0, pw);
  vec3 hot = vec3(0.72, 0.93, 1.0) * (1.8 - 1.4 * smoothstep(0.1, 0.35, pw));
  vec3 tv = col * mix(0.5 + 0.8 * mix(hash(vec2(floor(uTime * 24.0), 3.1)), 0.4, uSafe), 1.0, settle * settle);
  vec3 off = vec3(0.045, 0.05, 0.058) * (0.85 + 0.3 * p.y);
  vec3 c = uStyle < 0.5 ? mix(off, mix(hot, tv, smoothstep(0.12, 0.45, pw)), band) : tv;
  if (uStyle > 0.5 && uStyle < 1.5) c = mix(vec3(0.35, 0.85, 1.0) * (0.2 + dot(col, vec3(0.3, 0.59, 0.11)) * 1.3), col, pw * pw);
  // the OBS hole: alpha 0 where a hole panel is open and the overlay leaves it clear (name strip stays drawn)
  float a = 1.0 - hole * clamp(uOpen, 0.0, 1.0) * (1.0 - ov.a) * step(0.999, pw);
  gl_FragColor = vec4(c * a, a);
  #include <colorspace_fragment>
}`;

/** Panel rects (picture uv, bottom-left origin) for n guests: 1 = full, 2 = side by side, 3 = 2×2 (4th cell = the show card). */
export function panelRects(n: number): [number, number, number, number][] {
  const g = 0.012;
  if (n <= 1) return [[0, 0, 1, 1]];
  if (n === 2) return [[0, 0, 0.5 - g / 2, 1], [0.5 + g / 2, 0, 0.5 - g / 2, 1]];
  return [[0, 0.5 + g / 2, 0.5 - g / 2, 0.5 - g / 2], [0.5 + g / 2, 0.5 + g / 2, 0.5 - g / 2, 0.5 - g / 2], [0, 0, 0.5 - g / 2, 0.5 - g / 2]];
}

export interface MonitorPlace { center: THREE.Vector3; yaw: number; width: number; floorY: number | null; ceilingY: number | null }

export class TalkMonitor {
  readonly root = new THREE.Group();
  readonly surface: THREE.Mesh;
  readonly W: number; readonly H: number; readonly aspect: number;
  private mat: THREE.ShaderMaterial;
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private housing: BuiltHousing | null = null;
  private skin: { drive: SkinDriver } | null = null;
  private overlay: HTMLCanvasElement;
  private overTex: THREE.CanvasTexture;
  private overKey = '';
  private blank: THREE.Texture;
  /** 0..1 arrival (rise / drop / the skin's motion), power 0..1, hole open 0..1. */
  a = 0; power = 0; open = 0;
  target = 0;
  private sources: PanelSource[] = [];
  readonly occluders: THREE.Mesh[] = [];
  private lamps: THREE.MeshStandardMaterial[] = [];
  private time = 0;
  /** No guest on the monitor but the show is on (seated layout): the show's title card instead of stand-by bars. */
  idleLogo = false;

  constructor(readonly place: MonitorPlace, readonly style: MonitorStyle, readonly theme: SetTheme, readonly title: () => string, skin: SkinChoice | null) {
    const own = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T) => { this.owned.push(x); return x; };
    const k = new PropKit(own);
    this.aspect = MONITOR_ASPECT[style] ?? 16 / 9;
    this.W = place.width; this.H = place.width / this.aspect;
    this.root.name = 'vtp:interview:monitorRig';
    this.root.position.copy(place.center);
    this.root.rotation.set(0, place.yaw, 0);
    this.blank = own(new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1));
    this.blank.needsUpdate = true;
    this.overlay = document.createElement('canvas');
    this.overlay.width = 1024; this.overlay.height = Math.round(1024 / this.aspect);
    this.overTex = own(new THREE.CanvasTexture(this.overlay));
    this.overTex.colorSpace = THREE.SRGBColorSpace;
    const powerStyle = style === 'holo' || (style === 'skin' && skin?.spec.powerOn === 'hologram') ? 1 : style === 'skin' && skin && skin.spec.powerOn !== 'crt' ? 2 : 0;
    this.mat = own(new THREE.ShaderMaterial({
      name: 'vtp:interview:monitor',
      uniforms: {
        uT0: { value: this.blank }, uT1: { value: this.blank }, uT2: { value: this.blank }, uOver: { value: this.overTex },
        uR0: { value: new THREE.Vector4() }, uR1: { value: new THREE.Vector4() }, uR2: { value: new THREE.Vector4() },
        uS0: { value: new THREE.Vector4(0, 0, 1, 1) }, uS1: { value: new THREE.Vector4(0, 0, 1, 1) }, uS2: { value: new THREE.Vector4(0, 0, 1, 1) },
        uMode: { value: new THREE.Vector3() }, uDec: { value: new THREE.Vector3() }, uPower: { value: 0 }, uOpen: { value: 0 }, uTime: { value: 0 }, uSafe: { value: 1 }, uStyle: { value: powerStyle },
        uCrt: { value: style === 'tv' || style === 'crt' || style === 'fieldcrt' ? 1 : 0 }, uN: { value: 0 },
      },
      vertexShader: vert, fragmentShader: frag, blending: THREE.NoBlending, depthWrite: true, depthTest: true, toneMapped: false,
    }));
    this.surface = new THREE.Mesh(own(new THREE.PlaneGeometry(this.W, this.H)), this.mat);
    this.surface.name = 'vtp:interview:picture';
    const floorLocal = place.floorY !== null ? place.floorY - place.center.y : -place.center.y;
    const ceilLocal = place.ceilingY !== null ? place.ceilingY - place.center.y : this.H / 2 + 1.2;
    if (style === 'skin' && skin) {
      // the room's own screen skin (its arrival motion + frame), the picture replaced by ours
      const built = buildSkin(skin.spec, { prop: 'solo', W: this.W, H: this.H, ceilLocal: Math.max(this.H / 2 + 0.5, ceilLocal), floorLocal, surface: this.surface, own, template: skin.template });
      this.root.add(built.root);
      this.skin = { drive: new SkinDriver(built, skin.spec.motion, Math.max(this.H / 2 + 0.5, ceilLocal), floorLocal) };
      built.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== this.surface) this.occluders.push(o as THREE.Mesh); });
    } else {
      this.housing = buildHousing(k, style, theme, this.W, this.H, floorLocal, ceilLocal);
      this.surface.position.set(0, 0, this.housing.zSurf);
      this.housing.moving.add(this.surface);
      this.root.add(this.housing.root);
      this.occluders.push(...this.housing.occluders);
      this.lamps = this.housing.lamps;
    }
    this.surface.renderOrder = -1;
    this.root.visible = false;
  }

  /** The picture's world corners at rest (TL, TR, BR, BL as seen from the front). */
  corners(): THREE.Vector3[] {
    this.root.updateWorldMatrix(true, false);
    const z = this.housing ? this.housing.zSurf : SURF_Z;
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => new THREE.Vector3(x * this.W / 2, y * this.H / 2, z).applyMatrix4(this.root.matrixWorld));
  }
  /** The picture's corners where it is RIGHT NOW (arriving / swinging / flickering in): the drawn surface itself. */
  liveCorners(): THREE.Vector3[] {
    this.surface.updateWorldMatrix(true, false);
    const g = this.surface.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox!;
    return [[b.min.x, b.max.y], [b.max.x, b.max.y], [b.max.x, b.min.y], [b.min.x, b.min.y]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(this.surface.matrixWorld));
  }
  /** Drawn at all (arrived or arriving)? */
  get shown() { return this.root.visible && this.a > 0.001; }
  /** A panel's world centre + size (for panel close-ups). */
  panelFrame(i: number, n: number): { center: THREE.Vector3; width: number; height: number } {
    const r = panelRects(n)[Math.min(i, Math.max(0, n - 1))] ?? [0, 0, 1, 1];
    this.root.updateWorldMatrix(true, false);
    const c = new THREE.Vector3((r[0] + r[2] / 2 - 0.5) * this.W, (r[1] + r[3] / 2 - 0.5) * this.H, 0).applyMatrix4(this.root.matrixWorld);
    return { center: c, width: r[2] * this.W, height: r[3] * this.H };
  }
  get normal() { return new THREE.Vector3(Math.sin(this.place.yaw), 0, Math.cos(this.place.yaw)); }
  get center() { return this.place.center.clone(); }
  /** Projected picture corners in a camera (fractions, top-left origin) — the hole for OBS. */
  quad(cam: THREE.PerspectiveCamera, panel = -1, n = 1): [number, number][] {
    cam.updateMatrixWorld();
    let pts = this.corners();
    if (panel >= 0) {
      const r = panelRects(n)[panel];
      this.root.updateWorldMatrix(true, false);
      const z = this.housing ? this.housing.zSurf : SURF_Z;
      pts = [[r[0], r[1] + r[3]], [r[0] + r[2], r[1] + r[3]], [r[0] + r[2], r[1]], [r[0], r[1]]].map(([u, v]) => new THREE.Vector3((u - 0.5) * this.W, (v - 0.5) * this.H, z).applyMatrix4(this.root.matrixWorld));
    }
    return pts.map((w) => { const v = w.project(cam); return [(v.x + 1) / 2, (1 - v.y) / 2] as [number, number]; });
  }

  setSources(src: PanelSource[]) {
    this.sources = src.slice(0, 3);
    const U = this.mat.uniforms, n = this.sources.length;
    U.uN.value = n;
    const rects = panelRects(n);
    const modes = [0, 0, 0];
    this.sources.forEach((s, i) => {
      const r = rects[i];
      (U[`uR${i}`].value as THREE.Vector4).set(r[0], r[1], r[2], r[3]);
      U[`uT${i}`].value = s.mode === 'tex' && s.tex ? s.tex : this.blank;
      (U.uDec.value as THREE.Vector3).setComponent(i, s.mode === 'tex' && needsVideoDecode(s.tex) ? 1 : 0);
      modes[i] = s.mode === 'tex' && s.tex ? 1 : s.mode === 'hole' ? 2 : 0;
      // cover-fit the (cropped) source into the panel: panel aspect = r.w·W / r.h·H
      const pa = (r[2] * this.W) / (r[3] * this.H);
      // (cover fit, the window sliding to keep the face inside the panel's safe area; no face = the centred crop)
      const [cx, cy, cw, ch] = coverCrop(s.aspect ?? pa, pa, s.crop ?? null, s.face ?? null);
      // (crop is top-left origin; textures sample bottom-left)
      (U[`uS${i}`].value as THREE.Vector4).set(cx, 1 - cy - ch, cw, ch);
    });
    (U.uMode.value as THREE.Vector3).set(modes[0], modes[1], modes[2]);
    this.drawOverlay();
  }

  /** Names, tags, the idle card, the show-title cell (redrawn only when the text changes). */
  private drawOverlay() {
    const look = THEME_LOOKS[this.theme] ?? THEME_LOOKS.studio;
    const key = JSON.stringify([this.sources.map((s) => [s.mode, s.name, s.tag, s.card]), this.title(), this.idleLogo]);
    if (key === this.overKey) return;
    this.overKey = key;
    const c = this.overlay, g = c.getContext('2d')!, w = c.width, h = c.height, n = this.sources.length;
    g.clearRect(0, 0, w, h);
    const accent = `#${new THREE.Color(look.accent).getHexString()}`;
    const font = (sz: number, wt = 800) => `${wt} ${Math.round(sz)}px Inter, "Segoe UI", system-ui, sans-serif`;
    if (!n && this.idleLogo) {
      const gr = g.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, w * 0.7); gr.addColorStop(0, look.plateBg); gr.addColorStop(1, '#000');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = accent; g.lineWidth = h * 0.012; g.strokeRect(w * 0.06, h * 0.08, w * 0.88, h * 0.84);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = look.plateFg;
      g.font = look.font.replace('{s}', String(Math.round(h * 0.16))); g.fillText(this.title().toUpperCase(), w / 2, h * 0.46, w * 0.8);
      g.fillStyle = accent; g.font = font(h * 0.07, 900); g.fillText('● LIVE', w / 2, h * 0.68);
      this.overTex.needsUpdate = true;
      return;
    }
    if (!n) {
      // stand by: colour bars + the show title
      const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      bars.forEach((b, i) => { g.fillStyle = b; g.fillRect((i * w) / 7, 0, w / 7 + 1, h * 0.66); });
      g.fillStyle = '#10131a'; g.fillRect(0, h * 0.66, w, h * 0.34);
      g.fillStyle = 'rgba(8,10,14,0.85)'; g.fillRect(w * 0.1, h * 0.22, w * 0.8, h * 0.3);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = look.plateFg;
      g.font = look.font.replace('{s}', String(Math.round(h * 0.1))); g.fillText(this.title().toUpperCase(), w / 2, h * 0.32, w * 0.76);
      g.fillStyle = '#fff'; g.font = font(h * 0.055, 700); g.fillText('PLEASE STAND BY', w / 2, h * 0.44);
      this.overTex.needsUpdate = true;
      return;
    }
    const rects = panelRects(n);
    // the 4th cell of a 2×2 layout: the show card
    if (n === 3) {
      const x = w * 0.506, y = h * 0.506, cw = w * 0.494, ch = h * 0.494;
      const gr = g.createLinearGradient(0, y, 0, y + ch); gr.addColorStop(0, look.plateBg); gr.addColorStop(1, '#000');
      g.fillStyle = gr; g.fillRect(x, y, cw, ch);
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = look.plateFg;
      g.font = look.font.replace('{s}', String(Math.round(ch * 0.16))); g.fillText(this.title().toUpperCase(), x + cw / 2, y + ch * 0.46, cw * 0.86);
      g.fillStyle = accent; g.font = font(ch * 0.08, 800); g.fillText('● LIVE', x + cw / 2, y + ch * 0.68);
    }
    // dividers
    g.fillStyle = '#05070a';
    if (n >= 2) g.fillRect(w * 0.494, 0, w * 0.012, h);
    if (n >= 3) g.fillRect(0, h * 0.494, w, h * 0.012);
    this.sources.forEach((s, i) => {
      const [rx, ry, rw, rh] = rects[i];
      const X = rx * w, Y = (1 - ry - rh) * h, PW = rw * w, PH = rh * h;
      if (s.mode === 'card') {
        const gr = g.createLinearGradient(0, Y, 0, Y + PH); gr.addColorStop(0, '#1a1d24'); gr.addColorStop(1, '#07080b');
        g.fillStyle = gr; g.fillRect(X, Y, PW, PH);
        // snow
        for (let k = 0; k < 900 * rw * rh; k++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.18})`; g.fillRect(X + Math.random() * PW, Y + Math.random() * PH, 2, 2); }
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#e8eef7';
        g.font = font(PH * 0.1, 900); g.fillText(s.card ?? 'NO SIGNAL', X + PW / 2, Y + PH * 0.44, PW * 0.9);
      }
      // lower third: the guest's name + tag
      const lh = Math.max(PH * 0.16, 34), ly = Y + PH - lh - PH * 0.05, lx = X + PW * 0.04, lw = PW * 0.74;
      g.fillStyle = 'rgba(6,8,12,0.82)'; g.fillRect(lx, ly, lw, lh);
      g.fillStyle = accent; g.fillRect(lx, ly, Math.max(6, lw * 0.018), lh);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillStyle = '#ffffff'; g.font = font(lh * 0.5, 900); g.fillText(s.name.toUpperCase(), lx + lw * 0.05, ly + lh * 0.56, lw * 0.9);
      g.fillStyle = look.plateFg; g.font = font(lh * 0.26, 700); g.fillText(s.tag.toUpperCase(), lx + lw * 0.05, ly + lh * 0.88, lw * 0.9);
    });
    // the show bug (top right of the picture)
    g.textAlign = 'right'; g.textBaseline = 'top'; g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = font(h * 0.04, 900);
    g.fillText('● LIVE', w * 0.97, h * 0.035);
    this.overTex.needsUpdate = true;
  }

  /** Hole opening per frame: `settled` = the camera rests on a shot this hole lines up with. */
  update(dt: number, settled: boolean) {
    this.time += dt;
    const want = this.target > 0.5;
    // arrival first, then power, then (holes only) the opening
    const enter = this.skin ? null : 1.1, exit = 0.8;
    if (this.skin) {
      const off = !want && this.power <= 0 && this.open <= 0;
      this.skin.drive.step(dt, want, off);
      this.a = this.skin.drive.a;
      const landed = this.skin.drive.landed;
      if (want && landed) this.power = Math.min(1, this.power + dt / 0.7);
      else if (!want) { if (this.open > 0) this.open = Math.max(0, this.open - dt / 0.2); else this.power = Math.max(0, this.power - dt / 0.3); }
      this.skin.drive.apply(this.time, this.power);
      this.root.visible = this.skin.drive.visible;
    } else {
      if (want) this.a = Math.min(1, this.a + dt / enter!);
      else if (this.power <= 0 && this.open <= 0) this.a = Math.max(0, this.a - dt / exit);
      if (want && this.a >= 1) this.power = Math.min(1, this.power + dt / 0.55);
      else if (!want) { if (this.open > 0) this.open = Math.max(0, this.open - dt / 0.2); else this.power = Math.max(0, this.power - dt / 0.28); }
      this.applyArrival();
    }
    const hasHole = this.sources.some((s) => s.mode === 'hole');
    if (want && hasHole && settled && this.power >= 1) this.open = Math.min(1, this.open + dt / 0.3);
    else if (this.open > 0 && (!settled || !hasHole)) this.open = Math.max(0, this.open - dt / 0.2);
    const U = this.mat.uniforms;
    U.uPower.value = this.power; U.uOpen.value = this.open; U.uTime.value = this.time; U.uSafe.value = pageGovernor().safe ? 1 : 0;
    for (const l of this.lamps) l.emissiveIntensity = 0.2 + 2.2 * this.power * (0.8 + 0.2 * Math.sin(this.time * 6));
  }

  finish() {
    const want = this.target > 0.5;
    this.a = want ? 1 : 0; this.power = want ? 1 : 0;
    if (this.skin) { this.skin.drive.finish(want); this.skin.drive.apply(0, this.power); this.root.visible = this.skin.drive.visible; }
    else this.applyArrival();
    this.mat.uniforms.uPower.value = this.power;
  }

  private applyArrival() {
    const h = this.housing!;
    const e = this.a >= 1 ? 1 : 1 - Math.pow(1 - this.a, 3);
    if (h.motion === 'rise') {
      const d = Math.max(0.4, h.topY - (this.place.floorY !== null ? this.place.floorY - this.place.center.y : -1.5) + 0.05);
      h.moving.position.y = -d * (1 - e);
      // (under the floor while rising: clip by scaling from the floor would distort — the floor hides it)
    } else {
      const up = (this.place.ceilingY !== null ? this.place.ceilingY - this.place.center.y : 1.5) + this.H;
      h.moving.position.y = up * (1 - e) + (this.a >= 1 ? 0 : 0);
    }
    this.root.visible = this.a > 0.001;
  }

  get landed() { return this.a >= 1 && this.power >= 1; }
  get away() { return this.a <= 0 && this.power <= 0; }

  dispose() {
    this.root.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}

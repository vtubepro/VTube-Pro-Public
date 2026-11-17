// The chat audience's name tags: every name drawn once into a shared 2048² atlas (a dark pill, the name in the chatter's
// colour or their supporter tier's, a badge, a glow, an optional platform dot), shown as GPU-instanced billboards — ONE
// draw call for every name. The vertex shader faces each tag to the camera and keeps it between a minimum and maximum
// on-screen height (readable when far, never huge when close); per-instance alpha (declutter fades) and pulse.
import * as THREE from 'three';
import { PLATFORM_COLORS, type ChatPlatform } from '../../../shared/chat.ts';
import type { NameStyle } from '../../../shared/audience.ts';
import { drawBadge } from '../../chat/nameStyle.ts';

const ATLAS = 2048, CW = 256, CH = 56, COLS = ATLAS / CW, ROWS = Math.floor(ATLAS / CH);
export const TAG_CELLS = COLS * ROWS;   // 288
const FONT = '"Segoe UI", "Noto Sans", system-ui, sans-serif';

export interface TagSpec { name: string; platform: ChatPlatform; color: string; style: NameStyle; showPlatform: boolean }
interface Cell { key: string; used: number; i: number; last: number; uv: [number, number, number, number]; aspect: number }
/** The atlas key of a tag (callers cache it: no string building per frame). */
export const tagKey = (t: TagSpec) => `${t.name}|${t.platform}|${t.color}|${t.style.color}|${t.style.glow}|${t.style.badge}|${t.showPlatform ? 1 : 0}`;

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iUv;      // u0 v0 u1 v1
attribute vec3 iSize;    // world w, world h, pulse
attribute float iAlpha;
uniform float uViewH;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float depth = max(0.05, -mv.z);
  float pxPerUnit = projectionMatrix[1][1] * uViewH * 0.5 / depth;
  float hPx = iSize.y * pxPerUnit;
  float k = clamp(hPx, uMinPx, uMaxPx) / max(hPx, 1e-4);
  float pulse = 1.0 + iSize.z * 0.07 * sin(uTime * 3.2 + iPos.x * 3.0);
  vec2 corner = position.xy;   // -0.5..0.5, anchored at the bottom centre
  mv.xy += vec2(corner.x * iSize.x, (corner.y + 0.5) * iSize.y) * k * pulse;
  gl_Position = projectionMatrix * mv;
  vUv = vec2(mix(iUv.x, iUv.z, corner.x + 0.5), mix(iUv.y, iUv.w, corner.y + 0.5));
  vAlpha = iAlpha * (1.0 + iSize.z * 0.12 * sin(uTime * 3.2 + iPos.x * 3.0));
}`;
const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 c = texture2D(uMap, vUv);
  c.a *= clamp(vAlpha, 0.0, 1.0);
  if (c.a < 0.01) discard;
  gl_FragColor = c;
}`;

export class NameTags {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  private cells = new Map<string, Cell>();
  private free: number[] = [];
  private iPos: THREE.InstancedBufferAttribute;
  private iUv: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iAlpha: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private dirty = false;
  private tick = 0;
  private uploadedAt = -1e9;
  /** what each instance slot held last frame (attributes are re-uploaded only when they change) */
  private prevCell: (Cell | null)[] = [];
  private prevPulse: number[] = [];
  private prevH: number[] = [];
  private prevA: number[] = [];
  private changedStatic = false;
  private changedAlpha = false;
  n = 0;

  constructor(readonly cap: number) {
    this.canvas.width = ATLAS; this.canvas.height = ATLAS;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // no mip chain: tags are drawn 22-40 px from 56 px cells (a mild minification bilinear handles), and a new name then
    // uploads only the atlas, never a regenerated chain
    this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
    for (let i = TAG_CELLS - 1; i >= 0; i--) this.free.push(i);
    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    geo.index = plane.index; geo.setAttribute('position', plane.attributes.position);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iUv = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iSize = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iUv', this.iUv); geo.setAttribute('iSize', this.iSize); geo.setAttribute('iAlpha', this.iAlpha);
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true,
      uniforms: { uMap: { value: this.tex }, uViewH: { value: 1080 }, uMinPx: { value: 22 }, uMaxPx: { value: 40 }, uTime: { value: 0 } },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'audience-names';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }

  /** The atlas cell of a name + style (drawn on first use; least recently used cells are recycled): uv rect + aspect
   *  (used width / height). `key` = tagKey(t), cached by the caller. */
  cell(t: TagSpec, key = tagKey(t)): Cell {
    let c = this.cells.get(key);
    if (!c) {
      let i = this.free.pop();
      if (i === undefined) {
        // recycle the least recently used cell
        let old: Cell | null = null;
        for (const x of this.cells.values()) if (!old || x.last < old.last) old = x;
        this.cells.delete(old!.key); i = old!.i;
      }
      const used = this.draw(i, t);
      const col = i % COLS, row = Math.floor(i / COLS);
      c = { key, used, i, last: this.tick, uv: [(col * CW) / ATLAS, 1 - ((row + 1) * CH) / ATLAS, (col * CW + used) / ATLAS, 1 - (row * CH) / ATLAS], aspect: used / CH };
      this.cells.set(key, c);
      this.dirty = true;
    }
    c.last = this.tick;
    return c;
  }

  private draw(i: number, t: TagSpec): number {
    const g = this.g, x0 = (i % COLS) * CW, y0 = Math.floor(i / COLS) * CH;
    g.save();
    g.clearRect(x0, y0, CW, CH);
    g.beginPath(); g.rect(x0, y0, CW, CH); g.clip();
    const st = t.style;
    const pad = 9, badgeW = st.badge !== 'none' ? 30 : 0, dotW = t.showPlatform ? 14 : 0;
    let fs = 27;
    g.font = `800 ${fs}px ${FONT}`;
    let name = t.name;
    const room = CW - pad * 2 - badgeW - dotW - 6;
    while (g.measureText(name).width > room && fs > 17) { fs -= 1; g.font = `800 ${fs}px ${FONT}`; }
    if (g.measureText(name).width > room) { while (name.length > 2 && g.measureText(name + '…').width > room) name = name.slice(0, -1); name += '…'; }
    const tw = g.measureText(name).width;
    const used = Math.min(CW, Math.ceil(pad * 2 + badgeW + dotW + tw + 6));
    const ph = 38, py = y0 + (CH - ph) / 2;
    // the pill (glow: a soft halo + a tinted border)
    const r = ph / 2;
    const pill = () => { g.beginPath(); g.moveTo(x0 + 3 + r, py); g.arcTo(x0 + used - 3, py, x0 + used - 3, py + ph, r); g.arcTo(x0 + used - 3, py + ph, x0 + 3, py + ph, r); g.arcTo(x0 + 3, py + ph, x0 + 3, py, r); g.arcTo(x0 + 3, py, x0 + used - 3, py, r); g.closePath(); };
    if (st.glow) { g.shadowColor = st.glow; g.shadowBlur = 9; }
    pill(); g.fillStyle = 'rgba(10,12,20,0.78)'; g.fill();
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    g.lineWidth = st.glow ? 2.5 : 1.5; g.strokeStyle = st.glow || 'rgba(255,255,255,0.22)'; g.stroke();
    let x = x0 + pad + 3;
    if (t.showPlatform) { g.beginPath(); g.arc(x + 4, y0 + CH / 2, 4.5, 0, Math.PI * 2); g.fillStyle = PLATFORM_COLORS[t.platform] ?? '#9aa4b8'; g.fill(); x += dotW; }
    if (badgeW) { drawBadge(g, st.badge, x, y0 + CH / 2 - 12, 24); x += badgeW; }
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(name, x, y0 + CH / 2 + 1);
    if (st.glow) { g.shadowColor = st.glow; g.shadowBlur = 8; }
    g.fillStyle = readable(st.color || t.color);
    g.fillText(name, x, y0 + CH / 2 + 1);
    g.restore();
    return used;
  }

  /** Per frame: begin → put … → end. */
  begin(viewH: number, time: number, sizeK: number) {
    this.n = 0; this.tick++;
    this.mat.uniforms.uViewH.value = viewH;
    this.mat.uniforms.uTime.value = time;
    // 22 … 40 px tag height at 1080p (the name itself ≈ half of it), scaled with the frame and the "name size" setting
    this.mat.uniforms.uMinPx.value = 22 * (viewH / 1080) * sizeK;
    this.mat.uniforms.uMaxPx.value = 40 * (viewH / 1080) * sizeK;
  }
  put(pos: THREE.Vector3, t: TagSpec, key: string, worldH: number, alpha: number, pulse: boolean) {
    if (this.n >= this.cap || alpha <= 0.01) return;
    const c = this.cell(t, key), i = this.n++;
    this.iPos.setXYZ(i, pos.x, pos.y, pos.z);
    const pu = pulse ? 1 : 0;
    if (this.prevCell[i] !== c || this.prevH[i] !== worldH || this.prevPulse[i] !== pu) {
      this.prevCell[i] = c; this.prevH[i] = worldH; this.prevPulse[i] = pu; this.changedStatic = true;
      this.iUv.setXYZW(i, c.uv[0], c.uv[1], c.uv[2], c.uv[3]);
      this.iSize.setXYZ(i, worldH * c.aspect, worldH, pu);
    }
    const qa = Math.round(alpha * 64) / 64;
    if (this.prevA[i] !== qa) { this.prevA[i] = qa; this.iAlpha.setX(i, qa); this.changedAlpha = true; }
  }
  end() {
    const g = this.mesh.geometry as unknown as THREE.InstancedBufferGeometry;
    if (g.instanceCount !== this.n) { g.instanceCount = this.n; }
    this.iPos.needsUpdate = true;   // (they bob with their owners)
    if (this.changedStatic) { this.iUv.needsUpdate = this.iSize.needsUpdate = true; this.changedStatic = false; }
    if (this.changedAlpha) { this.iAlpha.needsUpdate = true; this.changedAlpha = false; }
    // new names: the atlas (+ its mip chain) uploads at most 4 times a second, never on every new chatter in a raid
    if (this.dirty && performance.now() - this.uploadedAt > 250) { this.tex.needsUpdate = true; this.dirty = false; this.uploadedAt = performance.now(); }
  }
  /** On-screen height (px) of a tag with world height `worldH` at view depth `depth` (the shader's clamp, for declutter). */
  pxHeight(worldH: number, depth: number, projY: number): number {
    const u = this.mat.uniforms;
    const h = worldH * projY * u.uViewH.value * 0.5 / Math.max(0.05, depth);
    return Math.min(u.uMaxPx.value, Math.max(u.uMinPx.value, h));
  }
  /** Width / height of a name's tag (declutter). */
  aspectOf(t: TagSpec, key?: string) { return this.cell(t, key).aspect; }
  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); this.mesh.removeFromParent(); }
}

/** A name colour readable on the dark pill: dark colours are lifted. */
export function readable(hex: string): string {
  const c = new THREE.Color(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#e8ecf6');
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum < 0.35) c.lerp(new THREE.Color(1, 1, 1), 0.5);
  return `#${c.getHexString()}`;
}

// The chat audience's little effects: instanced billboard particles from a procedural 4×2 atlas (sparkle, heart, star,
// ember, confetti, "HA", a soft glow, a clap burst) — supporter name trails, cheers, laughs, applause — plus the "now
// answering" spotlight (a soft additive cone + a glowing ring). Every frame is rebuilt from pure functions of time.
import * as THREE from 'three';

const CELLS = { sparkle: 0, heart: 1, star: 2, ember: 3, confetti: 4, ha: 5, glow: 6, clap: 7 } as const;
export type FxCell = keyof typeof CELLS;
const ADD = new Set<FxCell>(['sparkle', 'ember', 'glow']);

function atlas(): THREE.CanvasTexture {
  const S = 128, c = document.createElement('canvas'); c.width = S * 4; c.height = S * 2;
  const g = c.getContext('2d')!;
  const at = (i: number) => [(i % 4) * S, Math.floor(i / 4) * S] as const;
  const star = (cx: number, cy: number, r1: number, r2: number, n: number) => { g.beginPath(); for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? r2 : r1; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.closePath(); };
  // sparkle: a 4-point glint with a soft core
  { const [x, y] = at(0); const gr = g.createRadialGradient(x + 64, y + 64, 0, x + 64, y + 64, 60); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; star(x + 64, y + 64, 60, 9, 4); g.fill(); }
  // heart
  { const [x, y] = at(1); g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(x + 64, y + 108); g.bezierCurveTo(x + 10, y + 70, x + 4, y + 30, x + 34, y + 22); g.bezierCurveTo(x + 50, y + 16, x + 60, y + 26, x + 64, y + 38); g.bezierCurveTo(x + 68, y + 26, x + 78, y + 16, x + 94, y + 22); g.bezierCurveTo(x + 124, y + 30, x + 118, y + 70, x + 64, y + 108); g.fill(); }
  // star
  { const [x, y] = at(2); g.fillStyle = '#ffffff'; star(x + 64, y + 68, 56, 24, 5); g.fill(); }
  // ember: a soft round glow
  { const [x, y] = at(3); const gr = g.createRadialGradient(x + 64, y + 64, 0, x + 64, y + 64, 40); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x, y, S, S); }
  // confetti: a little ribbon rectangle
  { const [x, y] = at(4); g.fillStyle = '#ffffff'; g.fillRect(x + 44, y + 30, 40, 68); }
  // "HA"
  { const [x, y] = at(5); g.font = '900 64px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 10; g.strokeStyle = '#000000'; g.strokeText('HA', x + 64, y + 66); g.fillStyle = '#ffffff'; g.fillText('HA', x + 64, y + 66); }
  // big soft glow
  { const [x, y] = at(6); const gr = g.createRadialGradient(x + 64, y + 64, 0, x + 64, y + 64, 64); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x, y, S, S); }
  // clap burst: short radiating strokes
  { const [x, y] = at(7); g.strokeStyle = '#ffffff'; g.lineWidth = 9; g.lineCap = 'round'; for (let i = 0; i < 7; i++) { const a = -Math.PI * 0.9 + (i * Math.PI * 0.8) / 6; g.beginPath(); g.moveTo(x + 64 + Math.cos(a) * 26, y + 84 + Math.sin(a) * 26); g.lineTo(x + 64 + Math.cos(a) * 54, y + 84 + Math.sin(a) * 54); g.stroke(); } }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iCol;    // rgb, alpha
attribute vec3 iMisc;   // size, rotation, cell
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iMisc.y), s = sin(iMisc.y);
  vec2 p = position.xy;
  mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y) * iMisc.x;
  gl_Position = projectionMatrix * mv;
  float cell = iMisc.z;
  vec2 cc = vec2(mod(cell, 4.0), floor(cell / 4.0));
  vUv = vec2((cc.x + p.x + 0.5) / 4.0, 1.0 - (cc.y + 0.5 - p.y) / 2.0);
  vCol = iCol;
}`;
const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(t.rgb * vCol.rgb, a);
}`;

class Batch {
  readonly mesh: THREE.Mesh;
  private pos: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private misc: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  n = 0;
  constructor(readonly cap: number, map: THREE.Texture, additive: boolean) {
    this.geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geo.index = plane.index; this.geo.setAttribute('position', plane.attributes.position);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.misc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos); this.geo.setAttribute('iCol', this.col); this.geo.setAttribute('iMisc', this.misc);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uMap: { value: map } }, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 24 : 21;
  }
  add(cell: number, p: THREE.Vector3, size: number, rot: number, c: THREE.Color, a: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos.setXYZ(i, p.x, p.y, p.z); this.col.setXYZW(i, c.r, c.g, c.b, a); this.misc.setXYZ(i, size, rot, cell);
  }
  flush() { this.geo.instanceCount = this.n; this.pos.needsUpdate = this.col.needsUpdate = this.misc.needsUpdate = true; this.n = 0; }
  dispose() { this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

const tv = new THREE.Vector3(), tc = new THREE.Color();

export class AudienceFx {
  readonly group = new THREE.Group();
  private map = atlas();
  private norm: Batch;
  private add: Batch;
  private cone: THREE.Mesh;
  private ring: THREE.Mesh;

  constructor() {
    this.group.name = 'audience-fx';
    this.norm = new Batch(1600, this.map, false);
    this.add = new Batch(1200, this.map, true);
    this.group.add(this.norm.mesh, this.add.mesh);
    // the spotlight: an open cone with a vertical alpha gradient (vertex alpha), additive
    const h = 4.2, cg = new THREE.CylinderGeometry(0.12, 0.85, h, 32, 6, true);
    cg.translate(0, -h / 2, 0);
    const p = cg.attributes.position, col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) { const k = 1 + p.getY(i) / h; col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1; col[i * 4 + 3] = 0.05 + 0.32 * k * k; }
    cg.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, side: THREE.DoubleSide, toneMapped: false }));
    this.cone.visible = false; this.cone.renderOrder = 19; this.cone.frustumCulled = false;
    const rg = new THREE.RingGeometry(0.32, 0.5, 40); rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: '#ffd34d', transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.ring.visible = false; this.ring.renderOrder = 19;
    this.group.add(this.cone, this.ring);
  }

  bill(cell: FxCell, p: THREE.Vector3, size: number, color: THREE.Color | string, alpha = 1, rot = 0) {
    const c = typeof color === 'string' ? tc.set(color) : color;
    (ADD.has(cell) ? this.add : this.norm).add(CELLS[cell], p, size, rot, c, alpha);
  }

  /** The spotlight on a person: `top` = above their head (root space), `k` 0…1 fades it. */
  spot(at: THREE.Vector3 | null, floorY: number, k: number, color = '#fff3c4') {
    if (!at || k <= 0.01) { this.cone.visible = false; this.ring.visible = false; return; }
    this.cone.visible = true; this.ring.visible = true;
    this.cone.position.set(at.x, at.y + 3.2, at.z);
    this.cone.scale.set(1, 1, 1);
    (this.cone.material as THREE.MeshBasicMaterial).color.set(color);
    (this.cone.material as THREE.MeshBasicMaterial).opacity = 0.9 * k;
    this.ring.position.set(at.x, floorY + 0.02, at.z);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.65 * k;
  }

  /** Trail particles round a name: deterministic from time + a seed. */
  trail(kind: 'sparkle' | 'hearts' | 'stars' | 'embers', at: THREE.Vector3, w: number, t: number, seed: number, color: string) {
    const cell: FxCell = kind === 'hearts' ? 'heart' : kind === 'stars' ? 'star' : kind === 'embers' ? 'ember' : 'sparkle';
    const n = kind === 'embers' ? 6 : 4;
    for (let j = 0; j < n; j++) {
      const per = 1.6 + ((seed >> (j * 3)) & 7) * 0.12;
      const ph = ((t + j * per / n + (seed % 97) * 0.01) % per) / per;
      const side = ((seed >> j) & 1) ? 1 : -1;
      const x = at.x + side * (w * 0.45) * (0.4 + 0.6 * Math.sin(j * 2.1 + seed)) + Math.sin(t * 2 + j) * 0.03;
      tv.set(x, at.y + ph * 0.32, at.z);
      const a = Math.sin(ph * Math.PI);
      this.bill(cell, tv, (cell === 'sparkle' ? 0.07 : 0.055) * (0.6 + 0.6 * a), color, a, cell === 'sparkle' ? t * 2 + j : 0);
    }
  }

  begin() { /* batches are filled by bill() and flushed in end() */ }
  end() { this.norm.flush(); this.add.flush(); }
  dispose() { this.norm.dispose(); this.add.dispose(); this.map.dispose(); this.cone.geometry.dispose(); (this.cone.material as THREE.Material).dispose(); this.ring.geometry.dispose(); (this.ring.material as THREE.Material).dispose(); this.group.removeFromParent(); }
}

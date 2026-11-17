// Ship crew: the small effects around the crew (welding / hammer sparks, sand + dust puffs, coin glints),
// the speech bubbles, the rope ladder + hoist rope and the loose loot (chests on the sand, a bag in flight).
// Every particle is a pure function of (burst time, burst seed, now): bursts are listed per frame from the plan and the
// clips' event times, nothing is integrated, so every page draws the same sparks. Two draw calls for particles, one per
// visible bubble / rope / item.
import * as THREE from 'three';

const MAX_P = 640;
export interface Burst { t0: number; pos: THREE.Vector3; kind: 'spark' | 'weld' | 'dust' | 'sand' | 'coins'; seed: number; size: number; dir?: THREE.Vector3 }

const hashF = (a: number, b: number) => { let h = Math.imul(a ^ 0x9e3779b9, 2654435761) ^ Math.imul(b + 0x7f4a7c15, 2246822519); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) / 4294967296; };

function particleMat(additive: boolean) {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexColors: true,
    uniforms: { uScale: { value: 600 } },
    vertexShader: `attribute float size; attribute float alpha; varying vec3 vC; varying float vA;
      uniform float uScale;
      void main() { vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = max(1.0, size * uScale / -mv.z); }`,
    fragmentShader: `varying vec3 vC; varying float vA;
      void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d); if (r > 0.25) discard; gl_FragColor = vec4(vC, vA * smoothstep(0.25, 0.08, r)); }`,
  });
  return m;
}

class Particles {
  readonly geo = new THREE.BufferGeometry();
  readonly pts: THREE.Points;
  private pos = new Float32Array(MAX_P * 3);
  private col = new Float32Array(MAX_P * 3);
  private size = new Float32Array(MAX_P);
  private alpha = new Float32Array(MAX_P);
  n = 0;
  constructor(additive: boolean, name: string) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.pts = new THREE.Points(this.geo, particleMat(additive));
    this.pts.frustumCulled = false;
    this.pts.name = name;
    this.pts.renderOrder = 5;
  }
  begin() { this.n = 0; }
  add(x: number, y: number, z: number, r: number, g: number, b: number, s: number, a: number) {
    if (this.n >= MAX_P) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.size[i] = s; this.alpha[i] = a;
  }
  end(scale: number) {
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'color', 'size', 'alpha']) (this.geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    (this.pts.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
    this.pts.visible = this.n > 0;
  }
  dispose() { this.geo.dispose(); (this.pts.material as THREE.Material).dispose(); }
}

/** a speech bubble: canvas sprite (comic white bubble, warm ink) */
class BubbleSprite {
  readonly sprite: THREE.Sprite;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  text = '';
  constructor() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    this.ctx = c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: true, toneMapped: false }));
    this.sprite.center.set(0.5, 0.0);
    this.sprite.renderOrder = 8;
    this.sprite.visible = false;
    this.sprite.name = 'vtp:crew:bubble';
  }
  set(text: string, loud: boolean) {
    if (text === this.text) return;
    this.text = text;
    const g = this.ctx, W = 512, H = 256;
    g.clearRect(0, 0, W, H);
    const words = text.split(/\s+/);
    let size = loud ? 46 : 40;
    let lines: string[] = [];
    for (; size >= 22; size -= 2) {
      g.font = `900 ${size}px "Comic Sans MS", "Trebuchet MS", sans-serif`;
      lines = []; let cur = '';
      for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (g.measureText(t).width > W - 80 && cur) { lines.push(cur); cur = w; } else cur = t; }
      if (cur) lines.push(cur);
      if (lines.length * size * 1.1 < H - 90) break;
    }
    const bw = Math.min(W - 16, Math.max(...lines.map((l) => g.measureText(l).width)) + 64), bh = lines.length * size * 1.12 + 40;
    const x0 = (W - bw) / 2, y0 = 8;
    g.lineWidth = 8; g.strokeStyle = '#2a1a12'; g.fillStyle = loud ? '#fff6d8' : '#ffffff';
    const r = Math.min(40, bh / 2);
    g.beginPath();
    g.moveTo(x0 + r, y0); g.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r); g.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
    g.lineTo(W / 2 + 26, y0 + bh); g.lineTo(W / 2 - 4, Math.min(H - 6, y0 + bh + 54)); g.lineTo(W / 2 - 10, y0 + bh);
    g.arcTo(x0, y0 + bh, x0, y0, r); g.arcTo(x0, y0, x0 + bw, y0, r); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = '#2a1a12'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, k) => g.fillText(l, W / 2, y0 + 20 + size * 0.56 + k * size * 1.12));
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); this.sprite.material.dispose(); }
}

/** rope ladder (two rails + rungs) / single hoist rope, built for a length, scaled by the unroll */
function ropeMesh(kind: 'ladder' | 'hoist', L: number, mat: THREE.Material): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number) => { g.translate(x, y, 0); parts.push(g); };
  if (kind === 'ladder') {
    add(new THREE.BoxGeometry(0.035, L, 0.035), -0.2, -L / 2);
    add(new THREE.BoxGeometry(0.035, L, 0.035), 0.2, -L / 2);
    for (let y = 0.25; y < L; y += 0.25) add(new THREE.BoxGeometry(0.42, 0.03, 0.05), 0, -y);
  } else add(new THREE.BoxGeometry(0.03, L, 0.03), 0, -L / 2);
  let n = 0; for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); const idx: number[] = [];
  let o = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position') as THREE.BufferAttribute, nn = p.getAttribute('normal') as THREE.BufferAttribute;
    pos.set(pp.array as Float32Array, o * 3); nor.set(nn.array as Float32Array, o * 3);
    const ii = p.getIndex()!; for (let k = 0; k < ii.count; k++) idx.push(ii.getX(k) + o);
    o += pp.count; p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.name = `vtp:crew:${kind}`;
  return m;
}

export class CrewFx {
  readonly group = new THREE.Group();
  private add = new Particles(true, 'vtp:crew:sparks');
  private norm = new Particles(false, 'vtp:crew:puffs');
  private bubbles: BubbleSprite[] = [];
  private ropes = new Map<string, THREE.Mesh>();
  private ropeMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3e });
  private items = new Map<string, THREE.Mesh>();
  /** screen rects (0..1) bubbles must not cover */
  faceRects: { x0: number; y0: number; x1: number; y1: number }[] = [];
  counts = { particles: 0, bubbles: 0, ropes: 0, items: 0 };

  constructor() {
    this.group.name = 'vtp:crew:fx';
    this.group.add(this.add.pts, this.norm.pts);
  }

  begin() { this.add.begin(); this.norm.begin(); }

  /** draw a burst at time `t` (s, same clock as b.t0) */
  burst(b: Burst, t: number) {
    const age = t - b.t0;
    if (age < 0) return;
    const g = -9.81;
    if (b.kind === 'spark' || b.kind === 'weld') {
      const N = b.kind === 'spark' ? 14 : 5, life = b.kind === 'spark' ? 0.55 : 0.35;
      if (age > life) return;
      for (let k = 0; k < N; k++) {
        const r1 = hashF(b.seed, k), r2 = hashF(b.seed, k + 101), r3 = hashF(b.seed, k + 211);
        const sp = (b.kind === 'spark' ? 2.6 : 1.6) * (0.4 + r1 * 0.8) * b.size;
        const th = r2 * Math.PI * 2, ph = (r3 - 0.25) * Math.PI * 0.8;
        const vx = Math.cos(th) * Math.cos(ph) * sp, vz = Math.sin(th) * Math.cos(ph) * sp, vy = Math.sin(ph) * sp + 0.8;
        const a = Math.max(0, 1 - age / (life * (0.6 + r1 * 0.4)));
        if (a <= 0) continue;
        this.add.add(b.pos.x + vx * age, b.pos.y + vy * age + 0.5 * g * age * age, b.pos.z + vz * age, 1.0, 0.75 + 0.25 * r3, 0.35 + 0.3 * r2, 0.035 * b.size, a);
      }
    } else if (b.kind === 'dust' || b.kind === 'sand') {
      const life = b.kind === 'dust' ? 1.4 : 0.9, N = b.kind === 'dust' ? 10 : 6;
      if (age > life) return;
      for (let k = 0; k < N; k++) {
        const r1 = hashF(b.seed, k), r2 = hashF(b.seed, k + 57);
        const th = (k / N) * Math.PI * 2 + r1;
        const R = (0.25 + age * 1.1) * b.size * (0.7 + r2 * 0.6);
        const a = 0.55 * (1 - age / life);
        this.norm.add(b.pos.x + Math.cos(th) * R, b.pos.y + 0.12 + age * 0.35 * b.size + r2 * 0.1, b.pos.z + Math.sin(th) * R, 0.86, 0.74, 0.55, (0.35 + age * 0.6) * b.size, a);
      }
    } else if (b.kind === 'coins') {
      const life = 1.2;
      if (age > life) return;
      for (let k = 0; k < 12; k++) {
        const r1 = hashF(b.seed, k), r2 = hashF(b.seed, k + 31);
        const th = r1 * Math.PI * 2, sp = 0.6 + r2;
        const tw = 0.5 + 0.5 * Math.sin(age * 30 + k);
        this.add.add(b.pos.x + Math.cos(th) * sp * age * b.size, b.pos.y + (1.8 * age - 2.4 * age * age) * b.size, b.pos.z + Math.sin(th) * sp * age * b.size, 1.0, 0.82, 0.25, 0.06 * b.size * tw, 1 - age / life);
      }
    }
  }

  end(cam: THREE.PerspectiveCamera, H: number) {
    const s = H / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    this.add.end(s); this.norm.end(s);
    this.counts.particles = this.add.n + this.norm.n;
  }

  /** speech bubbles this frame: [world anchor (above the head), text, loud, opacity] */
  setBubbles(list: { at: THREE.Vector3; text: string; loud: boolean; scale: number }[], cam: THREE.PerspectiveCamera) {
    while (this.bubbles.length < list.length && this.bubbles.length < 4) { const b = new BubbleSprite(); this.bubbles.push(b); this.group.add(b.sprite); }
    const v = new THREE.Vector3();
    let shown = 0;
    this.bubbles.forEach((b, k) => {
      const it = list[k];
      if (!it) { b.sprite.visible = false; return; }
      b.set(it.text, it.loud);
      b.sprite.position.copy(it.at);
      const d = cam.position.distanceTo(it.at);
      // a readable size on screen: ~1.3 m wide near, held at >= ~9 % of the frame height far away
      const w = Math.max(1.1 * it.scale, d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * 0.32);
      b.sprite.scale.set(w, w / 2, 1);
      // never over a performer's face
      v.copy(it.at).project(cam);
      const x = (v.x + 1) / 2, y = (1 - v.y) / 2;
      const hw = (w / (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2))) / cam.aspect * 0.5;
      const hh = w / 2 / (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      const box = { x0: x - hw, x1: x + hw, y0: y - hh, y1: y };
      const blocked = v.z > 1 || this.faceRects.some((r) => !(box.x1 < r.x0 || box.x0 > r.x1 || box.y1 < r.y0 || box.y0 > r.y1));
      b.sprite.visible = !blocked;
      if (!blocked) shown++;
    });
    this.counts.bubbles = shown;
  }

  /** ropes alive this frame: key -> {kind, top, bottom, unroll 0..1} */
  setRopes(list: { key: string; kind: 'ladder' | 'hoist'; top: THREE.Vector3; bottom: THREE.Vector3; k: number; yaw: number; tilt?: number }[]) {
    const keep = new Set<string>();
    for (const r of list) {
      const L = Math.max(0.2, r.top.distanceTo(r.bottom));
      const key = `${r.key}|${L.toFixed(2)}`;
      keep.add(key);
      let m = this.ropes.get(key);
      if (!m) { m = ropeMesh(r.kind, L, this.ropeMat); this.ropes.set(key, m); this.group.add(m); }
      m.position.copy(r.top);
      m.rotation.set(-(r.tilt ?? 0), r.yaw, 0, 'YXZ');      // (hangs along the hull: tilted outboard by `tilt`)
      m.scale.set(1, Math.max(0.001, r.k), 1);
      m.visible = r.k > 0.001;
    }
    for (const [k, m] of this.ropes) if (!keep.has(k)) { m.removeFromParent(); m.geometry.dispose(); this.ropes.delete(k); }
    this.counts.ropes = list.length;
  }

  /** loose items this frame (prop geometry + the crew material) */
  setItems(list: { key: string; geo: THREE.BufferGeometry; mat: THREE.Material; pos: THREE.Vector3; yaw: number; tilt?: number }[]) {
    const keep = new Set<string>();
    for (const it of list) {
      keep.add(it.key);
      let m = this.items.get(it.key);
      if (!m) { m = new THREE.Mesh(it.geo, it.mat); m.name = `vtp:crew:item:${it.key}`; m.frustumCulled = false; this.items.set(it.key, m); this.group.add(m); }
      m.position.copy(it.pos);
      m.rotation.set(it.tilt ?? 0, it.yaw, 0, 'YXZ');
      m.visible = true;
    }
    for (const [k, m] of this.items) if (!keep.has(k)) { m.removeFromParent(); this.items.delete(k); }
    this.counts.items = list.length;
  }

  /** Materials lit like the room (crewScene env-patches them before its warm-up). */
  litMaterials(): THREE.Material[] { return [this.ropeMat]; }
  /** Before the crew shows: one pooled bubble and a hidden stand-in rope join the group, so a compile of the group
   *  builds every program the effects use (nothing compiles on air at the first shout / rope). Returns the cleanup. */
  prewarm(): () => void {
    if (!this.bubbles.length) { const b = new BubbleSprite(); b.sprite.visible = false; this.bubbles.push(b); this.group.add(b.sprite); }
    const rope = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), this.ropeMat);
    rope.visible = false;
    this.group.add(rope);
    return () => { rope.removeFromParent(); rope.geometry.dispose(); };
  }
  dispose() {
    this.add.dispose(); this.norm.dispose();
    for (const b of this.bubbles) b.dispose();
    for (const m of this.ropes.values()) m.geometry.dispose();
    this.ropeMat.dispose();
    this.group.removeFromParent();
  }
}

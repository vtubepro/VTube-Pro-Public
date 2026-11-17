// Ambient crowd FX: instanced billboards from a 4x4 atlas (notes, zzz, splashes, drops, ripples, stars, sparks, fire,
// smoke, hearts, '!', sweat, confetti, glow, the "10" card), flat water ripples, juggling torches, bobbers + fishing lines
// and speech bubbles. Rebuilt every frame from pure functions of time (every page matches); a few draw calls in total.
import * as THREE from 'three';

const CELL = {
  note: [0, 0], note2: [0, 1], zzz: [0, 2], burst: [0, 3],
  drop: [1, 0], ring: [1, 1], star: [1, 2], spark: [1, 3],
  fire: [2, 0], smoke: [2, 1], heart: [2, 2], bang: [2, 3],
  sweat: [3, 0], confetti: [3, 1], glow: [3, 2], card: [3, 3],
  mist: [2, 1],
} as const;
export type Cell = keyof typeof CELL;
const ADDITIVE = new Set<Cell>(['fire', 'spark', 'glow']);

function cellGeom(r: number, c: number, grid = 4) {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (c + uv.getX(i)) / grid, 1 - (r + 1 - uv.getY(i)) / grid);
  return g;
}

const M = new THREE.Matrix4(), S = new THREE.Vector3(), QQ = new THREE.Quaternion(), QR = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

export class CrowdFx {
  readonly group = new THREE.Group();
  private bills = new Map<Cell, THREE.InstancedMesh>();
  private nBill = new Map<Cell, number>();
  private flats: THREE.InstancedMesh;
  private nFlat = 0;
  private torches: THREE.InstancedMesh;
  private nTorch = 0;
  private bobbers: THREE.InstancedMesh;
  private nBob = 0;
  private lines: THREE.LineSegments;
  private nLine = 0;
  private bubbles = new Map<string, { sprite: THREE.Sprite; used: boolean; aspect: number }>();
  private colors = new Map<Cell, THREE.Color[]>();

  constructor(atlas: THREE.Texture) {
    this.group.name = 'crowd:fx';
    atlas.colorSpace = THREE.SRGBColorSpace;
    for (const [name, [r, c]] of Object.entries(CELL) as [Cell, readonly [number, number]][]) {
      const add = ADDITIVE.has(name);
      const mat = new THREE.MeshBasicMaterial({ map: atlas, transparent: true, depthWrite: false, alphaTest: add || name === 'mist' ? 0 : 0.04, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, fog: true, opacity: name === 'mist' ? 0.2 : 1 });
      const n = name === 'glow' ? 320 : name === 'drop' || name === 'confetti' || name === 'smoke' ? 160 : 96;
      const m = new THREE.InstancedMesh(cellGeom(r, c), mat, n);
      m.count = 0; m.frustumCulled = false; m.renderOrder = add ? 6 : name === 'mist' ? 3 : 5;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      this.group.add(m); this.bills.set(name, m);
    }
    const ringMat = new THREE.MeshBasicMaterial({ map: atlas, transparent: true, depthWrite: false, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.flats = new THREE.InstancedMesh(cellGeom(1, 1), ringMat, 64); this.flats.count = 0; this.flats.frustumCulled = false; this.flats.renderOrder = 4;
    this.group.add(this.flats);
    const tg = new THREE.CylinderGeometry(0.025, 0.018, 0.5, 6); tg.translate(0, 0.0, 0);
    this.torches = new THREE.InstancedMesh(tg, new THREE.MeshToonMaterial({ color: 0x6a4a2a }), 12); this.torches.count = 0; this.torches.frustumCulled = false;
    this.group.add(this.torches);
    const bg = new THREE.SphereGeometry(0.05, 8, 6);
    this.bobbers = new THREE.InstancedMesh(bg, new THREE.MeshToonMaterial({ color: 0xe8312a }), 8); this.bobbers.count = 0; this.bobbers.frustumCulled = false;
    this.group.add(this.bobbers);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 2 * 3), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xdedede, transparent: true, opacity: 0.55 })); this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  begin() {
    this.nBill.clear(); this.nFlat = 0; this.nTorch = 0; this.nBob = 0; this.nLine = 0;
    for (const b of this.bubbles.values()) b.used = false;
  }

  bill(kind: Cell, pos: THREE.Vector3, size: number, cam: THREE.Camera, roll = 0, color?: THREE.Color) {
    if (size <= 0.002) return;
    const m = this.bills.get(kind)!; const n = this.nBill.get(kind) ?? 0;
    if (n >= m.instanceMatrix.count) return;
    QQ.copy(cam.quaternion);
    if (roll) QQ.multiply(QR.setFromAxisAngle(Z, roll));
    M.compose(pos, QQ, S.set(size, size, size));
    m.setMatrixAt(n, M);
    if (m.instanceColor) m.setColorAt(n, color ?? WHITE);
    this.nBill.set(kind, n + 1);
  }

  ring(pos: THREE.Vector3, size: number) {
    if (this.nFlat >= this.flats.instanceMatrix.count || size <= 0.01) return;
    M.compose(pos, FLAT, S.set(size, size, size));
    this.flats.setMatrixAt(this.nFlat++, M);
  }

  torch(pos: THREE.Vector3, q: THREE.Quaternion) {
    if (this.nTorch >= this.torches.instanceMatrix.count) return;
    M.compose(pos, q, S.set(1, 1, 1));
    this.torches.setMatrixAt(this.nTorch++, M);
  }

  bobber(pos: THREE.Vector3, from: THREE.Vector3 | null) {
    if (this.nBob >= this.bobbers.instanceMatrix.count) return;
    M.compose(pos, QQ.identity(), S.set(1, 1, 1));
    this.bobbers.setMatrixAt(this.nBob++, M);
    if (from && this.nLine < 8) {
      const a = this.lines.geometry.attributes.position as THREE.BufferAttribute;
      a.setXYZ(this.nLine * 2, from.x, from.y, from.z); a.setXYZ(this.nLine * 2 + 1, pos.x, pos.y + 0.04, pos.z);
      this.nLine++;
    }
  }

  bubble(text: string, pos: THREE.Vector3, h: number) {
    let b = this.bubbles.get(text);
    if (!b) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      const fs = 46, font = `900 ${fs}px Impact, "Arial Black", sans-serif`;
      ctx.font = font;
      const W = Math.min(640, ctx.measureText(text).width + 70), H = fs + 56;
      c.width = Math.ceil(W); c.height = Math.ceil(H + 30);
      const g = c.getContext('2d')!;
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#fffbe0'; g.strokeStyle = '#142a10'; g.lineWidth = 6;
      g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 26); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(W * 0.4, H - 6); g.lineTo(W * 0.32, H + 24); g.lineTo(W * 0.52, H - 6); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#2f8a24'; g.fillText(text, W / 2, H / 2, W - 30);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
      sp.renderOrder = 20; sp.center.set(0.35, 0);
      this.group.add(sp);
      b = { sprite: sp, used: false, aspect: c.width / c.height };
      this.bubbles.set(text, b);
    }
    b.used = true; b.sprite.visible = true;
    b.sprite.position.copy(pos); b.sprite.scale.set(h * b.aspect, h, 1);
  }

  end() {
    for (const [k, m] of this.bills) { m.count = this.nBill.get(k) ?? 0; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.flats.count = this.nFlat; this.flats.instanceMatrix.needsUpdate = true;
    this.torches.count = this.nTorch; this.torches.instanceMatrix.needsUpdate = true;
    this.bobbers.count = this.nBob; this.bobbers.instanceMatrix.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, this.nLine * 2); (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    for (const [k, b] of this.bubbles) {
      if (!b.used) {
        b.sprite.visible = false;
        if (this.bubbles.size > 12) { b.sprite.removeFromParent(); (b.sprite.material as THREE.SpriteMaterial).map?.dispose(); b.sprite.material.dispose(); this.bubbles.delete(k); }
      }
    }
  }

  palette(kind: Cell, cols: string[]) { this.colors.set(kind, cols.map((c) => new THREE.Color(c))); }
  color(kind: Cell, i: number) { const c = this.colors.get(kind); return c ? c[i % c.length] : WHITE; }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh || (o as THREE.Sprite).isSprite || (o as THREE.LineSegments).isLineSegments) {
        (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const x of mats) { if ((x as THREE.SpriteMaterial).map && (o as THREE.Sprite).isSprite) (x as THREE.SpriteMaterial).map!.dispose(); x?.dispose?.(); }
      }
    });
  }
}
const WHITE = new THREE.Color(1, 1, 1);

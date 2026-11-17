// Chatter name tags on ships (docs/SCENES.md "Chatter names on ships"): a small billboard pill ("Skiff · Maple")
// above each tagged ship — room-styled (scene.json shipNames.style; amber on a dark pill by default), a constant size on
// screen, faded in only while the ship itself is big enough to read and faded out when the pill would cover a performer's
// face or the React screen. Depth-tested (the room hides it like the ship), never written to depth, not tone mapped.
// One canvas texture per distinct text (shared by every sprite showing it), one sprite material per tag (its opacity).
import * as THREE from 'three';
import type { RoomShipNamesStyle } from '../../../shared/afk.ts';

export interface TagSpec {
  /** Stable id (the flight / craft): a tag keeps its sprite while the id lives. */
  id: string;
  text: string;
  /** Where the pill's bottom centre sits (world): above the ship. */
  anchor: THREE.Vector3;
  /** The ship's size (m): the pill only shows while the ship is big enough on screen. */
  size: number;
}
export interface TagAvoid { faces: { center: THREE.Vector3; size: number }[]; rects: { x: number; y: number; w: number; h: number }[] }

interface Tex { tex: THREE.CanvasTexture; aspect: number; refs: number }
interface Tag { id: string; text: string; sprite: THREE.Sprite; mat: THREE.SpriteMaterial; op: number; seen: number }

const V = new THREE.Vector3(), V2 = new THREE.Vector3(), FWD = new THREE.Vector3();

export const DEFAULT_TAG_STYLE: Required<RoomShipNamesStyle> = { text: '#F5A623', bg: 'rgba(12,10,6,0.82)', border: 'rgba(245,166,35,0.55)', font: '700 44px "Inter", "Segoe UI", system-ui, sans-serif', size: 20, upper: false };

export class ShipTags {
  readonly group = new THREE.Group();
  private tags = new Map<string, Tag>();
  private texs = new Map<string, Tex>();
  private frame = 0;
  style: Required<RoomShipNamesStyle> = { ...DEFAULT_TAG_STYLE };
  /** Beyond this (m) no tag. */
  maxDistance = 1200;
  /** At most this many pills at once (the biggest ships win). */
  maxTags = 8;
  /** Debug: tags drawn last frame. */
  shown: { id: string; text: string; op: number }[] = [];

  constructor() { this.group.name = 'vtp:afk-tags'; this.group.renderOrder = 999; }

  setStyle(s: RoomShipNamesStyle | undefined) {
    const next = { ...DEFAULT_TAG_STYLE, ...(s ?? {}) };
    next.size = Math.min(48, Math.max(10, Number(next.size) || DEFAULT_TAG_STYLE.size));
    if (JSON.stringify(next) === JSON.stringify(this.style)) return;
    this.style = next;
    for (const t of this.tags.values()) this.drop(t);
    this.tags.clear();
  }

  private texFor(text: string): Tex {
    let t = this.texs.get(text);
    if (t) return t;
    const st = this.style;
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    const font = st.font;
    g.font = font;
    const shown = st.upper ? text.toUpperCase() : text;
    const H = 64, padX = 26, w = Math.ceil(g.measureText(shown).width) + padX * 2;
    c.width = Math.min(1024, Math.max(96, w)); c.height = H;
    g.font = font;
    const r = H / 2 - 3;
    g.beginPath();
    g.moveTo(3 + r, 3); g.lineTo(c.width - 3 - r, 3); g.arc(c.width - 3 - r, H / 2, r, -Math.PI / 2, Math.PI / 2); g.lineTo(3 + r, H - 3); g.arc(3 + r, H / 2, r, Math.PI / 2, Math.PI * 1.5); g.closePath();
    g.fillStyle = st.bg; g.fill();
    if (st.border) { g.lineWidth = 3; g.strokeStyle = st.border; g.stroke(); }
    g.fillStyle = st.text; g.textAlign = 'center'; g.textBaseline = 'middle';
    // a name wider than the canvas cap is squeezed, never cut
    const tw = g.measureText(shown).width, room = c.width - padX * 2;
    if (tw > room) { g.save(); g.translate(c.width / 2, H / 2 + 2); g.scale(room / tw, 1); g.fillText(shown, 0, 0); g.restore(); }
    else g.fillText(shown, c.width / 2, H / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    t = { tex, aspect: c.width / H, refs: 0 };
    this.texs.set(text, t);
    return t;
  }

  private release(text: string) {
    const t = this.texs.get(text);
    if (!t) return;
    if (--t.refs <= 0) { t.tex.dispose(); this.texs.delete(text); }
  }

  private make(s: TagSpec): Tag {
    const tx = this.texFor(s.text);
    tx.refs++;
    const mat = new THREE.SpriteMaterial({ map: tx.tex, transparent: true, depthTest: true, depthWrite: false, fog: false, toneMapped: false, opacity: 0 });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 999;
    sprite.frustumCulled = false;
    sprite.name = `tag:${s.id}`;
    this.group.add(sprite);
    return { id: s.id, text: s.text, sprite, mat, op: 0, seen: 0 };
  }

  private drop(t: Tag) {
    t.sprite.removeFromParent();
    t.mat.dispose();
    this.release(t.text);
  }

  /** Place / fade every tag for this frame's camera. `viewH` = drawing-buffer height (px). */
  update(specs: TagSpec[], cam: THREE.PerspectiveCamera, viewH: number, dt: number, avoid: TagAvoid) {
    this.frame++;
    this.shown = [];
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const f = viewH / (2 * tanH);                                   // px per (m / m of depth)
    const aspect = cam.aspect || 16 / 9;
    const px = this.style.size * (viewH / 1080);
    cam.updateMatrixWorld();
    const fwd = FWD.set(0, 0, -1).applyQuaternion(cam.quaternion);
    // faces in NDC (a generous box: the pill must never touch one)
    const faces = avoid.faces.map((fc) => {
      const depth = V.copy(fc.center).sub(cam.position).dot(fwd);
      const q = V2.copy(fc.center).project(cam);
      return depth > 0.1 && q.z < 1 ? { x: q.x, y: q.y, r: (fc.size * 1.4) / (depth * tanH) } : null;
    }).filter((x): x is { x: number; y: number; r: number } => !!x);
    // pass 1: where each pill lands, whether it may show at all (readable ship, on screen, off faces / screens)
    const cand: { t: Tag; want: number; x0: number; x1: number; y0: number; y1: number; rank: number }[] = [];
    for (const s of specs) {
      let t = this.tags.get(s.id);
      if (t && t.text !== s.text) { this.drop(t); this.tags.delete(s.id); t = undefined; }
      if (!t) { t = this.make(s); this.tags.set(s.id, t); }
      t.seen = this.frame;
      const d = V.copy(s.anchor).sub(cam.position).dot(fwd);
      let want = 0;
      if (d > 0.5 && d < this.maxDistance) {
        const shipPx = (s.size * f) / d;
        want = THREE.MathUtils.smoothstep(shipPx, 20, 40);
        const tx = this.texs.get(t.text)!;
        const hw = (px / viewH) * 2 * d * tanH;
        t.sprite.scale.set(hw * tx.aspect, hw, 1);
        t.sprite.position.copy(s.anchor);
        if (want > 0) {
          const hN = (2 * px) / viewH, wN = (hN * tx.aspect) / aspect;
          const p = V.copy(s.anchor).project(cam);
          const x0 = p.x - wN / 2, x1 = p.x + wN / 2, y0 = p.y, y1 = p.y + hN;
          if (p.z > 1 || x0 < -0.99 || x1 > 0.99 || y0 < -0.99 || y1 > 0.99) want = 0;      // (whole pills only)
          else {
            for (const q of faces) if (x1 > q.x - q.r / aspect && x0 < q.x + q.r / aspect && y1 > q.y - q.r && y0 < q.y + q.r * 1.2) { want = 0; break; }
            if (want > 0) for (const rc of avoid.rects) {
              const rx0 = rc.x * 2 - 1, rx1 = (rc.x + rc.w) * 2 - 1, ry1 = 1 - rc.y * 2, ry0 = 1 - (rc.y + rc.h) * 2;
              if (x1 > rx0 && x0 < rx1 && y1 > ry0 && y0 < ry1) { want = 0; break; }
            }
            // (bigger ships first — decided from this frame alone, so every page shows the same pills)
            if (want > 0) cand.push({ t, want, x0, x1, y0, y1, rank: shipPx });
          }
        }
      }
      if (!want) this.fade(t, 0, dt);
    }
    // pass 2: at most maxTags, never two pills on top of each other
    cand.sort((a, b) => b.rank - a.rank || (a.t.id < b.t.id ? -1 : 1));
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const mx = 0.01, my = 0.012;
    for (const c of cand) {
      const free = placed.length < this.maxTags && !placed.some((r) => c.x1 + mx > r.x0 && c.x0 - mx < r.x1 && c.y1 + my > r.y0 && c.y0 - my < r.y1);
      if (free) placed.push(c);
      this.fade(c.t, free ? c.want : 0, dt);
    }
    for (const t of this.tags.values()) if (t.seen === this.frame && t.sprite.visible) this.shown.push({ id: t.id, text: t.text, op: +t.op.toFixed(2) });
    for (const [k, t] of this.tags) if (t.seen !== this.frame) { this.drop(t); this.tags.delete(k); }
  }

  private fade(t: Tag, want: number, dt: number) {
    t.op += (want - t.op) * Math.min(1, dt / 0.25);
    if (want === 0 && t.op < 0.02) t.op = 0;
    t.mat.opacity = t.op;
    t.sprite.visible = t.op > 0.01;
  }

  clear() { for (const t of this.tags.values()) this.drop(t); this.tags.clear(); this.shown = []; }

  dispose() {
    this.clear();
    for (const t of this.texs.values()) t.tex.dispose();
    this.texs.clear();
    this.group.removeFromParent();
  }
}

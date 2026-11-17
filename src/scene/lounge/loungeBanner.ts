// Lounge events — the supporter banner (like the warzone's, a camera-locked card): a dark glass plate with a gold edge,
// the tier icon, the title ("GIFT TRAIN ×20", "FIREWORKS!") and the supporter + amount. It slides in, holds, slides out.
// It takes the first frame corner (top-left, top-right, bottom-left, bottom-right) that covers no performer's face and
// not the React screen; with no free corner it waits hidden. One canvas per celebration, redrawn never.
import * as THREE from 'three';
import type { FxRect } from './loungeFx.ts';

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const tv = new THREE.Vector3();
const W = 1024, H = 232;
/** fraction of the frame height the card takes */
const FRAC = 0.092;
const ASPECT = W / H;

export interface BannerSpec { key: string; title: string; who: string; icon: string; tier: number; from: number; to: number }

export class LoungeBanner {
  readonly sprite: THREE.Sprite;
  private tex: THREE.CanvasTexture | null = null;
  private key = '';
  /** where it went (debug): 'tl' | 'tr' | 'bl' | 'br' | '' (hidden) */
  corner = '';
  /** its screen rect (0…1, y down) when shown — other effects may avoid it */
  rect: FxRect | null = null;

  constructor() {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false }));
    this.sprite.name = 'vtp:lounge:banner'; this.sprite.renderOrder = 20; this.sprite.visible = false; this.sprite.frustumCulled = false;
  }

  private draw(b: BannerSpec) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const r = 30, x0 = 6, y0 = 16, w = W - 12, h = H - 32;
    const path = () => { g.beginPath(); g.moveTo(x0 + r, y0); g.arcTo(x0 + w, y0, x0 + w, y0 + h, r); g.arcTo(x0 + w, y0 + h, x0, y0 + h, r); g.arcTo(x0, y0 + h, x0, y0, r); g.arcTo(x0, y0, x0 + w, y0, r); g.closePath(); };
    // plate: smoked glass with a warm vertical gradient
    const bg = g.createLinearGradient(0, y0, 0, y0 + h);
    bg.addColorStop(0, 'rgba(34,26,22,0.92)'); bg.addColorStop(1, 'rgba(12,9,10,0.92)');
    path(); g.fillStyle = bg; g.fill();
    // gold edge (brighter for the big tiers)
    const gold = g.createLinearGradient(0, 0, W, 0);
    gold.addColorStop(0, '#f7dd8a'); gold.addColorStop(0.45, '#c9963a'); gold.addColorStop(0.7, '#ffe7a3'); gold.addColorStop(1, '#a8772a');
    g.lineWidth = b.tier >= 4 ? 6 : 4; g.strokeStyle = gold; path(); g.stroke();
    // inner hairline
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,236,190,0.18)';
    g.beginPath(); g.moveTo(x0 + 190, y0 + 22); g.lineTo(x0 + 190, y0 + h - 22); g.stroke();
    // the icon medallion
    const cx = x0 + 98, cy = y0 + h / 2;
    const med = g.createRadialGradient(cx - 18, cy - 18, 6, cx, cy, 70);
    med.addColorStop(0, '#fff3c4'); med.addColorStop(0.55, '#d6a440'); med.addColorStop(1, '#7a521a');
    g.beginPath(); g.arc(cx, cy, 64, 0, Math.PI * 2); g.fillStyle = med; g.fill();
    g.beginPath(); g.arc(cx, cy, 56, 0, Math.PI * 2); g.fillStyle = 'rgba(20,14,12,0.88)'; g.fill();
    g.font = '64px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(b.icon, cx, cy + 4);
    // title (gold) + who (cream), fitted
    g.textAlign = 'left';
    const tx = x0 + 222, maxW = w - 250;
    let fs = 76;
    const titleFont = (s: number) => `900 ${s}px "Bahnschrift", "Segoe UI", Impact, "Arial Black", sans-serif`;
    g.font = titleFont(fs); while (g.measureText(b.title).width > maxW && fs > 34) { fs -= 4; g.font = titleFont(fs); }
    const tg = g.createLinearGradient(0, y0 + 30, 0, y0 + 30 + fs);
    tg.addColorStop(0, '#fff2c2'); tg.addColorStop(0.55, '#f0c552'); tg.addColorStop(1, '#c48a2a');
    g.fillStyle = tg; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
    g.fillText(b.title, tx, y0 + (b.who ? 74 : h / 2));
    if (b.who) {
      let ws = 52;
      const whoFont = (s: number) => `700 ${s}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
      g.font = whoFont(ws); while (g.measureText(b.who).width > maxW && ws > 24) { ws -= 3; g.font = whoFont(ws); }
      g.fillStyle = '#f6efe2'; g.fillText(b.who, tx, y0 + h - 56);
    }
    this.tex?.dispose();
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 4;
    const m = this.sprite.material as THREE.SpriteMaterial; m.map = this.tex; m.needsUpdate = true;
  }

  /** place + fade the current banner (null = none). avoid = faces + the React screen (0…1, y down). */
  update(b: BannerSpec | null, tSec: number, cam: THREE.PerspectiveCamera, avoid: FxRect[]) {
    if (!b) { this.sprite.visible = false; this.corner = ''; this.rect = null; return; }
    if (b.key !== this.key) { this.key = b.key; this.draw(b); }
    const age = tSec - b.from, left = b.to - tSec;
    const k = smooth(age / 0.45) * smooth(left / 0.6);
    if (k <= 0.001) { this.sprite.visible = false; this.corner = ''; this.rect = null; return; }
    const aspect = cam.aspect || 16 / 9;
    const hN = FRAC, wN = (FRAC * ASPECT) / aspect;               // normalized height / width (of the frame)
    const mx = 0.035, my = 0.05;
    const cands: [string, number, number][] = [['tl', mx, my], ['tr', 1 - mx - wN, my], ['bl', mx, 1 - my - hN], ['br', 1 - mx - wN, 1 - my - hN]];
    let pick: [string, number, number] | null = null;
    for (const c of cands) {
      const r = { x0: c[1], y0: c[2], x1: c[1] + wN, y1: c[2] + hN };
      if (!avoid.some((a) => r.x0 < a.x1 && r.x1 > a.x0 && r.y0 < a.y1 && r.y1 > a.y0)) { pick = c; break; }
    }
    if (!pick) { this.sprite.visible = false; this.corner = ''; this.rect = null; return; }
    this.corner = pick[0];
    const slide = (1 - smooth(age / 0.45)) * (pick[0].endsWith('l') ? -1 : 1) * 0.06;
    const cxN = pick[1] + wN / 2 + slide, cyN = pick[2] + hN / 2;
    this.rect = { x0: pick[1], y0: pick[2], x1: pick[1] + wN, y1: pick[2] + hN, d: 0 };
    const d = Math.max(cam.near * 4, 0.5);
    tv.set(cxN * 2 - 1, 1 - cyN * 2, 0.5).unproject(cam).sub(cam.position).normalize();
    // distance along the ray so that the card sits on the plane at depth d
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const s = d / Math.max(0.1, tv.dot(fwd));
    this.sprite.position.copy(cam.position).addScaledVector(tv, s);
    if (this.sprite.parent) this.sprite.parent.worldToLocal(this.sprite.position);
    const hW = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * hN;
    this.sprite.scale.set(hW * ASPECT, hW, 1);
    (this.sprite.material as THREE.SpriteMaterial).opacity = k;
    this.sprite.visible = true;
  }

  dispose() { this.tex?.dispose(); (this.sprite.material as THREE.SpriteMaterial).dispose(); this.sprite.removeFromParent(); }
}

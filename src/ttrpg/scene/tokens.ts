// Minis on the battle map: a coloured base (HP ring, a glow on whoever's turn it is) with a standee card that turns
// to the camera so names read on stream. Players' minis get a gold frame, monsters red, NPCs blue, objects grey.
// Moves hop from cell to cell; the fallen tip over. Positions come from SceneTtrpgState.tokens (map cells).
import * as THREE from 'three';
import type { TtrpgToken } from '../../../shared/ttrpg/state.ts';
import type { Surface } from './anchors.ts';
import { roundRect } from './mapCanvas.ts';

const FRAME: Record<string, string> = { pc: '#f2c14e', monster: '#d64545', npc: '#4f8fe0', object: '#9aa0a6' };
const DEFAULT_ICON: Record<string, string> = { pc: '', monster: '☠', npc: '☺', object: '◆' };

interface Mini { tok: TtrpgToken; root: THREE.Group; card: THREE.Mesh; base: THREE.Mesh; ring: THREE.Mesh; turn: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; key: string; fall: number }

function cardTexture(t: TtrpgToken): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 360;
  const x = c.getContext('2d')!;
  const frame = FRAME[t.kind] ?? '#999';
  x.clearRect(0, 0, 256, 360);
  x.fillStyle = frame; roundRect(x, 6, 6, 244, 348, 26); x.fill();
  const g = x.createLinearGradient(0, 20, 0, 340); g.addColorStop(0, t.color); g.addColorStop(1, shade(t.color, -0.45));
  x.fillStyle = g; roundRect(x, 18, 18, 220, 324, 18); x.fill();
  // portrait disc
  x.fillStyle = 'rgba(255,255,255,0.18)'; x.beginPath(); x.arc(128, 140, 92, 0, 7); x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.8)'; x.lineWidth = 6; x.stroke();
  const icon = t.icon || DEFAULT_ICON[t.kind] || t.name.slice(0, 1).toUpperCase();
  x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `900 ${[...icon].length > 1 && /^[A-Za-z0-9]+$/.test(icon) ? 88 : 110}px "Segoe UI Emoji", "Segoe UI", system-ui, sans-serif`;
  x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 10; x.fillText(icon, 128, 146); x.shadowBlur = 0;
  // name banner
  x.fillStyle = 'rgba(10,10,14,0.78)'; roundRect(x, 18, 262, 220, 80, 14); x.fill();
  let size = 44; const name = t.name.slice(0, 18);
  do { x.font = `800 ${size}px "Segoe UI", system-ui, sans-serif`; size -= 2; } while (x.measureText(name).width > 204 && size > 18);
  x.fillStyle = '#ffffff'; x.fillText(name, 128, 303);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
function shade(hex: string, k: number) { const c = new THREE.Color(hex); c.multiplyScalar(1 + k); return `#${c.getHexString()}`; }

export class TokenLayer {
  readonly group = new THREE.Group();
  private minis = new Map<string, Mini>();
  private cols = 20; private rows = 14;
  private cell = 0.05;
  hideHidden = true;

  constructor(private map: Surface) { this.group.name = 'ttrpg:tokens'; }

  setGrid(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.cell = this.map.width / cols; }
  get cellSize() { return this.cell; }

  /** Map cell → world point on the surface. */
  cellPoint(x: number, y: number, out = new THREE.Vector3()) {
    return this.map.at((x + 0.5) / this.cols, (y + 0.5) / this.rows, out).addScaledVector(this.map.normal, 0.002);
  }

  sync(tokens: TtrpgToken[], turnId: string | null, miniH?: number) {
    const keep = new Set<string>();
    const h = miniH ?? this.cell * 1.45;
    for (const t of tokens) {
      if (t.hidden && this.hideHidden) continue;
      keep.add(t.id);
      let m = this.minis.get(t.id);
      const key = `${t.name}|${t.color}|${t.icon ?? ''}|${t.kind}|${t.size ?? 1}`;
      if (!m || m.key !== key) { if (m) this.drop(m); m = this.build(t, h); m.key = key; this.minis.set(t.id, m); }
      const target = this.cellPoint(t.x + ((t.size ?? 1) - 1) / 2, t.y + ((t.size ?? 1) - 1) / 2);
      if (!m.to.equals(target)) { m.from.copy(m.root.position.lengthSq() ? m.root.position : target); m.to.copy(target); m.t = m.root.position.lengthSq() ? 0 : 1; }
      m.tok = t;
      const hp = t.hp;
      const frac = hp ? Math.max(0, Math.min(1, hp[0] / Math.max(1, hp[1]))) : 1;
      m.ring.visible = !!hp;
      (m.ring.geometry as THREE.RingGeometry).dispose();
      m.ring.geometry = new THREE.RingGeometry(this.cell * 0.36 * (t.size ?? 1), this.cell * 0.44 * (t.size ?? 1), 40, 1, Math.PI / 2, Math.PI * 2 * Math.max(0.001, frac));
      (m.ring.material as THREE.MeshBasicMaterial).color.setHSL(0.33 * frac, 0.85, 0.5);
      m.turn.visible = t.id === turnId;
    }
    for (const [id, m] of this.minis) if (!keep.has(id)) { this.drop(m); this.minis.delete(id); }
  }

  private build(t: TtrpgToken, h: number): Mini {
    const s = t.size ?? 1;
    const root = new THREE.Group();
    const baseR = this.cell * 0.42 * s;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(baseR, baseR * 1.06, this.cell * 0.12, 32), new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.4, metalness: 0.2 }));
    base.position.y = this.cell * 0.06;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(baseR * 1.02, this.cell * 0.025, 8, 40), new THREE.MeshStandardMaterial({ color: FRAME[t.kind] ?? '#999', metalness: 0.6, roughness: 0.3 }));
    rim.rotation.x = Math.PI / 2; rim.position.y = this.cell * 0.12;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 2, 8), new THREE.MeshBasicMaterial({ color: '#3c3', toneMapped: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = this.cell * 0.125;
    const turn = new THREE.Mesh(new THREE.RingGeometry(baseR * 1.15, baseR * 1.4, 48), new THREE.MeshBasicMaterial({ color: '#fff3a0', transparent: true, opacity: 0.8, toneMapped: false, side: THREE.DoubleSide, depthWrite: false }));
    turn.rotation.x = -Math.PI / 2; turn.position.y = this.cell * 0.01; turn.visible = false;
    const cw = h * 0.72 * Math.sqrt(s), ch = h * Math.sqrt(s);
    const geo = new THREE.PlaneGeometry(cw, ch); geo.translate(0, ch / 2, 0);        // pivot at the bottom edge: it leans back like a real standee
    const card = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: cardTexture(t), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, roughness: 0.6 }));
    card.position.y = this.cell * 0.12;
    root.add(base, rim, ring, turn, card);
    // orient to the surface
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.map.normal);
    this.group.add(root);
    return { tok: t, root, card, base, ring, turn, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, key: '', fall: 0 };
  }

  update(dt: number, camera: THREE.Camera, time: number) {
    const camP = camera.getWorldPosition(new THREE.Vector3());
    for (const m of this.minis.values()) {
      m.t = Math.min(1, m.t + dt / 0.55);
      const e = m.t < 1 ? m.t * m.t * (3 - 2 * m.t) : 1;
      m.root.position.lerpVectors(m.from, m.to, e);
      if (m.t < 1) m.root.position.addScaledVector(this.map.normal, Math.sin(m.t * Math.PI) * this.cell * 0.6);
      // standee faces the camera around the surface normal (reads on every shot); the fallen lie flat
      const dead = !!m.tok.dead || (m.tok.hp ? m.tok.hp[0] <= 0 : false);
      m.fall += ((dead ? 1 : 0) - m.fall) * Math.min(1, dt * 5);
      const local = m.root.worldToLocal(camP.clone());
      const yaw = Math.atan2(local.x, local.z);
      // lean back towards a camera that looks down (the map shot reads the portraits), never past 65°
      const elev = Math.atan2(local.y, Math.hypot(local.x, local.z));
      const lean = Math.max(0, Math.min(1.13, elev - 0.25));
      m.card.rotation.set(-(lean * (1 - m.fall) + m.fall * Math.PI / 2 * 0.98), yaw, 0, 'YXZ');
      (m.card.material as THREE.MeshStandardMaterial).color.setScalar(dead ? 0.45 : 1);
      if (m.turn.visible) { const k = 0.6 + 0.4 * Math.sin(time * 5); (m.turn.material as THREE.MeshBasicMaterial).opacity = k; m.turn.scale.setScalar(1 + 0.08 * Math.sin(time * 5)); }
    }
  }

  /** World position of a token (director: "look at the goblin"). */
  where(id: string): THREE.Vector3 | null { const m = this.minis.get(id); return m ? m.root.position.clone() : null; }

  private drop(m: Mini) {
    m.root.removeFromParent();
    m.root.traverse((o) => { const x = o as THREE.Mesh; if (x.isMesh) { x.geometry.dispose(); const mt = x.material as THREE.MeshStandardMaterial; mt.map?.dispose(); mt.dispose(); } });
  }
  dispose() { for (const m of this.minis.values()) this.drop(m); this.minis.clear(); this.group.removeFromParent(); }
}

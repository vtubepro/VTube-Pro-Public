// The Trail v2 — the camp you can see: trailart's camp kit (camp_kit.glb: FIRE, POT, TENT, TROUGH, BENCH, WATCH,
// LOG_seat …) placed on the sim's task spots, each showing the state child that matches its progress (`_s0` → `_s1`
// → `_s2`, ART_PLAN_AAA / DESIGN_V2 §12): the fire grows, tents rise, the pot bubbles. Nothing here is physics.
import * as THREE from 'three';
import type { CampState } from '../../../../shared/trail/types.ts';
import { loadThemeGlb } from './assets.ts';

const PIECE: Record<string, string> = { fire: 'FIRE', cook: 'POT', animals: 'TROUGH', repair: 'BENCH', watch: 'WATCH' };

export class CampView {
  readonly root = new THREE.Group();
  private kit: THREE.Object3D | null = null;
  private kitTheme = '';
  private placed = new Map<string, THREE.Object3D>();
  private key = '';

  constructor(parent: THREE.Object3D) { parent.add(this.root); this.root.name = 'camp-view'; }

  update(theme: string, camp: CampState | null | undefined) {
    if (!camp) { if (this.placed.size) this.clear(); return; }
    if (this.kitTheme !== theme) { this.kitTheme = theme; this.kit = null; void loadThemeGlb(theme, 'camp_kit.glb').then((g) => { if (this.kitTheme === theme) this.kit = g; this.clear(); }).catch(() => {}); }
    if (!this.kit) return;
    const key = camp.tasks.map((t) => `${t.id}@${t.p.map((v) => v.toFixed(1)).join(',')}`).join('|');
    if (key !== this.key) { this.clear(); this.key = key; this.build(camp); }
    for (const t of camp.tasks) {
      const o = this.placed.get(t.id);
      if (!o) continue;
      const v = t.id === 'fire' ? camp.fire / 100 : t.progress;
      const stage = t.id === 'watch' ? (camp.night && t.who.length ? 1 : 0) : t.id === 'repair' || t.id === 'animals' ? (v >= 0.5 ? 1 : 0) : v >= 0.85 ? 2 : v >= 0.35 ? 1 : 0;
      o.visible = !(t.id.startsWith('tent') && t.progress <= 0);   // a tent shows once its bundle is on the spot
      o.traverse((c) => { const m = /_s(\d)$/.exec(c.name); if (m) c.visible = Number(m[1]) === stage; });
    }
  }
  private build(camp: CampState) {
    const kit = this.kit!;
    const piece = (name: string) => { const src = kit.getObjectByName(name); if (!src) return null; const c = src.clone(); c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); return c; };
    for (const t of camp.tasks) {
      const name = t.id.startsWith('tent') ? 'TENT' : PIECE[t.id];
      const o = name ? piece(name) : null;
      if (!o) continue;
      o.position.set(t.p[0], t.p[1] - 0.1, t.p[2]);
      o.rotation.y = (t.p[0] * 13.7 + t.p[2] * 7.1) % (Math.PI * 2);
      this.root.add(o);
      this.placed.set(t.id, o);
    }
    // seats around the fire
    const fire = camp.tasks.find((t) => t.id === 'fire');
    if (fire) for (let i = 0; i < 4; i++) {
      const s = piece('LOG_seat');
      if (!s) break;
      const a = i / 4 * Math.PI * 2 + 0.4;
      s.position.set(fire.p[0] + Math.cos(a) * 2.4, fire.p[1] - 0.1, fire.p[2] + Math.sin(a) * 2.4);
      s.rotation.y = -a;
      this.root.add(s);
    }
  }
  /** The floating origin moved: the camp's spots are local coordinates. */
  shift(dx: number, dz: number) { this.root.position.x += dx; this.root.position.z += dz; }
  private clear() { for (const c of [...this.root.children]) this.root.remove(c); this.placed.clear(); this.key = ''; this.root.position.set(0, 0, 0); }
  dispose() { this.clear(); this.root.removeFromParent(); }
}

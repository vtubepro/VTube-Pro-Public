// The Trail — weight feedback ("show if something is too heavy or not"). Over every held object: a small strain meter
// (the object's mass against the combined lift of everyone holding it: green → yellow → red) and, when it is more than
// they can lift, "too heavy — needs 2" (or ×3 …). For this view's own player, the thing in front of you within reach
// gets a quiet weight tag before you grab it ("58 kg · needs 2"). Holders' strain (mass / lift) goes to their avatars
// (the strain animation + tremble, src/game/trail/client/anim.ts). Lift = sizeStats(height).lift × role strength (the
// sim's rule: hunters ×1.5 at a hunt). Cheap: sprites with a small canvas redrawn only when the shown numbers change.
import * as THREE from 'three';
import { sizeStats } from '../../../../shared/trail/sizes.ts';
import { F } from '../../../../shared/trail/wire.ts';
import type { GameState } from '../../../../shared/trail/types.ts';
import type { EntView } from './ents.ts';
import type { PlayerAvatar } from './avatars.ts';
import { roundRect } from './kit.ts';

/** What the meter needs from a view (GameView satisfies it). */
export interface WeightSource {
  readonly ents: { map: Map<number, EntView>; players(): Map<string, EntView> };
  readonly avatars: Map<string, PlayerAvatar>;
  readonly state: GameState | null;
  readonly o: { link: { myId: string }; spectator?: boolean };
}

/** Lift (kg) a player can hold up alone — mirrors the sim (world.ts: p.st.lift × p.strengthMul). */
export function liftOf(st: GameState | null, playerId: string): number {
  const p = st?.players.find((x) => x.id === playerId);
  const base = sizeStats(p?.height ?? 1.7).lift;
  return base * (p?.role === 'hunter' && st?.stop?.kind === 'hunt' ? 1.5 : 1);
}
/** Mass (kg) of an entity as the sim sees it (props default 10 kg like the sim; the wagon is heavy). */
export function massOf(e: EntView | undefined): number {
  if (!e) return 0;
  return e.info.mass ?? (e.info.kind === 'wagon' ? 600 : 10);
}

const COL = { ok: '#4cd964', mid: '#ffcc00', hard: '#ff9500', bad: '#ff3b30' };
export const strainColor = (r: number) => (r < 0.6 ? COL.ok : r < 0.85 ? COL.mid : r <= 1 ? COL.hard : COL.bad);
/** "too heavy — needs 2" / "… needs ×3" (N people of the holders' average strength), '' when liftable. */
export function tooHeavyText(mass: number, lifts: number, avgLift: number): string {
  if (mass <= lifts + 1e-6) return '';
  const n = Math.max(2, Math.ceil(mass / Math.max(1, avgLift)));
  return n === 2 ? 'too heavy — needs 2' : `too heavy — needs ×${n}`;
}

class Meter {
  readonly sprite: THREE.Sprite;
  private c = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private key = '';
  constructor(parent: THREE.Object3D) {
    this.c.width = 360; this.c.height = 104;
    this.g = this.c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
    this.sprite.renderOrder = 30;
    this.sprite.scale.set(0.27, 0.078, 1);
    this.sprite.visible = false;
    this.sprite.raycast = () => {};
    parent.add(this.sprite);
  }
  /** ratio = mass / lift (0..∞); compact = the look-at tag (no bar). Redraws only when what it shows changes. */
  draw(mass: number, ratio: number, label: string, compact: boolean) {
    const r = Math.round(Math.min(ratio, 2) * 40) / 40;
    const kg = mass >= 100 ? Math.round(mass / 5) * 5 : Math.round(mass);
    const key = `${kg}|${r}|${label}|${compact ? 1 : 0}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g, W = this.c.width, H = this.c.height;
    g.clearRect(0, 0, W, H);
    const col = strainColor(ratio);
    const font = '"Bahnschrift", "Segoe UI", sans-serif';
    if (compact) {
      const text = label ? `${kg} kg · ${label.replace('too heavy — ', '')}` : `${kg} kg`;
      g.font = `700 30px ${font}`;
      const w = Math.min(W - 4, g.measureText(text).width + 40);
      g.fillStyle = 'rgba(12,14,18,0.62)'; roundRect(g, (W - w) / 2, 30, w, 46, 23); g.fill();
      g.fillStyle = col; g.beginPath(); g.arc((W - w) / 2 + 20, 53, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, W / 2 + 8, 55);
    } else {
      g.fillStyle = 'rgba(12,14,18,0.74)'; roundRect(g, 2, 2, W - 4, H - 4, 22); g.fill();
      // bar: 0 … 1.25 × lift, a tick at 100 %
      const bx = 20, by = 16, bw = W - 40, bh = 22;
      g.fillStyle = 'rgba(255,255,255,0.14)'; roundRect(g, bx, by, bw, bh, 11); g.fill();
      g.fillStyle = col; roundRect(g, bx, by, Math.max(bh, bw * Math.min(1, ratio / 1.25)), bh, 11); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(bx + bw * 0.8 - 1.5, by - 4, 3, bh + 8);
      g.font = `800 30px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = label ? COL.bad : '#fff';
      g.fillText(label || `${kg} kg`, W / 2, 70);
    }
    this.tex.needsUpdate = true;
  }
  dispose() { this.sprite.removeFromParent(); this.tex.dispose(); this.sprite.material.dispose(); }
}

/** Strain meters over held things + the own player's look-at weight tag. One per GameView. */
export class WeightMeters {
  private pool: Meter[] = [];
  private used = 0;
  private hint: Meter;
  private holders = new Map<number, string[]>();
  private lookT = 0;
  private lookId = 0;
  private tmp = new THREE.Vector3();
  constructor(private root: THREE.Object3D) { this.hint = new Meter(root); }

  update(v: WeightSource, dt: number) {
    const st = v.state;
    // group holders by held entity (reuse arrays)
    if (this.holders.size > 64) this.holders.clear();
    for (const a of this.holders.values()) a.length = 0;
    for (const [id, pv] of v.ents.players()) {
      const h = pv.cur.hold;
      const av = v.avatars.get(id);
      if (!h || (pv.cur.flags & (F.ragdoll | F.downed | F.ghost))) { if (av) av.strain = 0; continue; }
      let arr = this.holders.get(h);
      if (!arr) { arr = []; this.holders.set(h, arr); }
      arr.push(id);
    }
    this.used = 0;
    for (const [hid, ids] of this.holders) {
      if (!ids.length) continue;
      const e = v.ents.map.get(hid);
      if (!e) continue;
      const mass = massOf(e);
      let lifts = 0;
      for (const id of ids) lifts += liftOf(st, id);
      const ratio = mass / Math.max(1, lifts);
      for (const id of ids) { const av = v.avatars.get(id); if (av) av.strain = ratio; }
      const m = this.pool[this.used] ?? (this.pool[this.used] = new Meter(this.root));
      this.used++;
      m.draw(mass, ratio, tooHeavyText(mass, lifts, lifts / ids.length), false);
      const top = e.info.shape === 'capsule' ? e.info.size[0] + e.info.size[1] : e.info.size[1];
      m.sprite.position.copy(e.cur.p); m.sprite.position.y += top + 0.35;
      m.sprite.visible = true;
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].sprite.visible = false;
    // the own player's look-at tag (a player view, empty hands)
    const me = v.o.spectator ? null : v.ents.players().get(v.o.link.myId);
    this.lookT -= dt;
    if (!me || me.cur.hold || (me.cur.flags & (F.seated | F.ragdoll | F.downed | F.ghost))) { this.hint.sprite.visible = false; this.lookId = 0; return; }
    if (this.lookT <= 0) { this.lookT = 0.1; this.lookId = this.pick(v, me); }
    const e = this.lookId ? v.ents.map.get(this.lookId) : undefined;
    if (!e) { this.hint.sprite.visible = false; return; }
    const lift = liftOf(st, v.o.link.myId), mass = massOf(e);
    this.hint.draw(mass, mass / Math.max(1, lift), tooHeavyText(mass, lift, lift), true);
    const top = e.info.shape === 'capsule' ? e.info.size[0] + e.info.size[1] : e.info.size[1];
    this.hint.sprite.position.copy(e.cur.p); this.hint.sprite.position.y += top + 0.3;
    this.hint.sprite.visible = true;
  }

  /** Nearest grabbable thing in front of the player within reach (props + carcasses; not held by anyone). */
  private pick(v: WeightSource, me: EntView): number {
    const p = me.cur.p, yaw = me.cur.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const h = v.state?.players.find((x) => x.id === v.o.link.myId)?.height ?? 1.7;
    const reach = Math.max(1.8, h * 1.15) + 0.6;
    let best = 0, bd = Infinity;
    for (const e of v.ents.map.values()) {
      const k = e.info.kind;
      if (!(k === 'prop' || (k === 'animal' && e.info.sub.startsWith('carcass'))) || e.info.sub === 'draft' || this.holders.get(e.info.id)?.length) continue;
      const d = this.tmp.copy(e.cur.p).sub(p);
      d.y = 0;
      const dist = d.length();
      if (dist > reach + Math.max(e.info.size[0], e.info.size[2]) || dist < 1e-3) continue;
      if ((d.x * fx + d.z * fz) / dist < 0.55) continue;
      if (dist < bd) { bd = dist; best = e.info.id; }
    }
    return best;
  }

  dispose() { for (const m of this.pool) m.dispose(); this.pool.length = 0; this.hint.dispose(); }
}

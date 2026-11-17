// Sky-traffic rooms — ambient background patrons (scene.json `traffic.patrons`): a few locals sitting at the window
// counters, leaning on the bar, playing the holo table. Built on the town NPC tech (TownAssets / TownNpc: the shared
// NPC skeleton, cel-ramp toon material + ink, LOD1) and the retargeted clip library (assets/library/anims/npc/
// town_anims_ual.json: sitting / talking / leaning idles). Stationary: each patron is a pure function of the clock
// (clip phase from wall-clock seconds + a per-patron offset), so every page matches.
// Never in front of the show: patrons are authored away from the SPOT_xx seats, and any patron whose head comes within
// ~0.14 of a performer's face on screen (and is further from the camera) fades out; checked 4×/s.
import * as THREE from 'three';
import { TownAssets, TownNpc, type TownClip } from '../town/townUnits.ts';

const ANIMS_URL = new URL('../../../assets/library/anims/npc/town_anims_ual.json', import.meta.url).href;

export interface PatronSpec { name: string; unit: string; clip: string; sit?: number; position: [number, number, number]; facing: [number, number, number] }
export interface PatronCfg { units?: string; scale?: number; list?: PatronSpec[] }

interface Live { npc: TownNpc; spec: PatronSpec; clip: TownClip | null; phase: number; fade: number; want: number }

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

export class Patrons {
  readonly group = new THREE.Group();
  private live: Live[] = [];
  private nextCheck = 0;
  error = '';
  ready = false;

  constructor(private cfg: PatronCfg) { this.group.name = 'vtp:traffic-patrons'; }

  async load(unitsUrl: string, toWorld: (p: THREE.Vector3) => THREE.Vector3, gen: () => boolean) {
    try {
      const assets = await TownAssets.load(unitsUrl, ANIMS_URL);
      if (!gen()) return;
      const sc = Math.min(1.1, Math.max(0.8, this.cfg.scale ?? 0.92));
      (this.cfg.list ?? []).forEach((s, i) => {
        const npc = new TownNpc(assets, s.unit, this.group);
        const p = toWorld(new THREE.Vector3(...s.position));
        npc.root.position.copy(p);
        npc.root.rotation.y = Math.atan2(s.facing[0], s.facing[2]);
        npc.root.scale.setScalar(sc);
        const clip = assets.clips.get(s.clip) ?? assets.clips.get('ual_idle') ?? null;
        this.live.push({ npc, spec: s, clip, phase: (i * 7.31) % 11, fade: 1, want: 1 });
      });
      this.ready = true;
    } catch (e) {
      this.error = String(e);
      console.warn('traffic: patrons failed to load', e);
    }
  }

  get count() { return this.live.length; }

  /** t = clock (s); faces = performers' face centres (world); lodBias from the graphics tier (0.6 … 1.8) */
  update(t: number, dt: number, cam: THREE.PerspectiveCamera, faces: THREE.Vector3[], lodBias: number) {
    if (!this.ready) return;
    const check = t >= this.nextCheck || t < this.nextCheck - 1;
    if (check) this.nextCheck = t + 0.25;
    for (const l of this.live) {
      if (l.clip) {
        const tt = t + l.phase;
        l.npc.pose(l.clip, l.clip.loop ? tt : tt % Math.max(0.1, l.clip.dur), null, 0, 0);
      }
      // LOD: the full mesh + ink only close up on the richer tiers
      const d = l.npc.root.position.distanceTo(cam.position);
      l.npc.setLod(lodBias < 1.2 ? 1 : d < 7 * lodBias ? 0 : 1);
      if (check) {
        l.want = 1;
        l.npc.headWorld(tv);
        const dp = tv.distanceTo(cam.position);
        tv.project(cam);
        for (const f of faces) {
          const df = f.distanceTo(cam.position);
          tv2.copy(f).project(cam);
          const dx = (tv.x - tv2.x) * cam.aspect, dy = tv.y - tv2.y;
          if (dp > df - 0.2 && dx * dx + dy * dy < 0.14 * 0.14 && tv.z < 1) { l.want = 0; break; }
        }
      }
      l.fade += Math.sign(l.want - l.fade) * Math.min(Math.abs(l.want - l.fade), dt / 0.35);
      l.npc.setOpacity(l.fade);
    }
  }

  dispose() {
    for (const l of this.live) l.npc.dispose();
    this.live = [];
    this.group.removeFromParent();
    this.ready = false;
  }
}

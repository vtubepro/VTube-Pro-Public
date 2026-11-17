// Raceway — the lounge regulars (town NPC tech: TownAssets / TownNpc, the shared 20-bone skeleton, the retargeted
// library clips). Each role runs a deterministic routine on the wall clock (seeded segments, cross-faded), so every
// page shows the same bar:
//   bettor       shouts at the race board, taps in bets, jumps for joy when the house pays out
//   drunk        sways at the end of the bar, staggers to the glass and back, now and then falls over and gets up
//   barfly       sits at the bar, drinks, talks
//   mechanic     kneels at the busted junction box; the sparks make him flinch
//   holo_bookie  the hologram bookie (cyan, scanlines, flicker) talks odds and dances when someone wins big
// Support events make everybody cheer. Never in front of a performer's face (fades, like the sky-traffic patrons).
import * as THREE from 'three';
import { TownAssets, TownNpc, type TownClip } from '../../town/townUnits.ts';
import { hash32 } from '../../raid/rng.ts';
import type { Anchor } from './racewayRoom.ts';

const ANIMS_URL = new URL('../../../../assets/library/anims/npc/town_anims_ual.json', import.meta.url).href;
const UNIT: Record<string, string> = { bettor: 'bettor', drunk: 'drunk', barfly: 'barfly', mechanic: 'mechanic', holo_bookie: 'bookie' };
const hr = (...p: (number | string)[]) => hash32(...p) / 4294967296;
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();

type Seg = { clip: string; t0: number; t1: number; loop?: boolean; walk?: [number, number] };
interface Live { role: string; npc: TownNpc; a: Anchor; path: THREE.Vector3[]; seed: number; fade: number; want: number; sitY: number; holo: boolean }

export class LoungeNpcs {
  readonly group = new THREE.Group();
  private assets: TownAssets | null = null;
  private live: Live[] = [];
  private nextCheck = 0;
  error = '';
  ready = false;

  constructor(private anchors: Anchor[]) { this.group.name = 'vtp:raceway:npcs'; }

  async load(url: string, gen: () => boolean) {
    try {
      const assets = await TownAssets.load(url, ANIMS_URL);
      if (!gen()) return;
      this.assets = assets;
      for (const a of this.anchors) {
        const role = String(a.extras.role ?? a.name.replace(/^NPC_/, '').toLowerCase());
        const unit = UNIT[role];
        if (!unit || !assets.templates.has(unit)) continue;
        const npc = new TownNpc(assets, unit, this.group);
        npc.root.scale.setScalar(0.93);
        const sit = typeof a.extras.sit === 'number' ? a.extras.sit : 0;
        const path = Array.isArray(a.extras.path) ? (a.extras.path as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length >= 3).map((p) => new THREE.Vector3(p[0], p[1], p[2])) : [];
        const holo = role === 'holo_bookie';
        if (holo) hologram(npc);
        this.live.push({ role, npc, a, path, seed: hash32(a.name), fade: 1, want: 1, sitY: sit ? sit - 0.46 : 0, holo });
      }
      this.ready = true;
    } catch (e) {
      this.error = String(e);
      console.warn('[raceway] lounge NPCs failed to load', e);
    }
  }

  private clip(name: string): TownClip | null { return this.assets?.clips.get(name) ?? this.assets?.clips.get('ual_idle') ?? null; }

  /** the routine of a role around time t: [previous segment, current segment] (seeded 12 s windows). */
  private routine(l: Live, t: number, cheer: number): [Seg | null, Seg] {
    const role = l.role;
    if (cheer > 0 && role !== 'barfly') {
      const c0 = t - cheer;
      const clip = role === 'drunk' || role === 'holo_bookie' ? 'ual_dance' : role === 'mechanic' ? 'ual_yes' : 'ual_jump';
      return [null, { clip, t0: c0, t1: c0 + 6, loop: true }];
    }
    const W = role === 'drunk' ? 14 : 11;
    const k = Math.floor(t / W);
    const seg = (kk: number): Seg => {
      const r = hr(l.seed, kk);
      const t0 = kk * W, t1 = t0 + W;
      switch (role) {
        case 'bettor': return { clip: r < 0.35 ? 'ual_idle_rail_call' : r < 0.6 ? 'ual_interact' : r < 0.85 ? 'ual_idle_talking' : 'ual_idle_fold_arms', t0, t1, loop: true };
        case 'barfly': return { clip: r < 0.4 ? 'ual_sitting_idle' : r < 0.75 ? 'ual_sitting_talking' : 'ual_consume', t0, t1, loop: true };
        case 'mechanic': return { clip: r < 0.75 ? 'ual_fixing_kneeling' : r < 0.9 ? 'ual_idle_no' : 'ual_idle', t0, t1, loop: true };
        case 'holo_bookie': return { clip: r < 0.45 ? 'ual_idle_talking' : r < 0.7 ? 'ual_spell_simple_idle' : r < 0.85 ? 'ual_yes' : 'style_proud_idle', t0, t1, loop: true };
        case 'drunk': {
          if (hr(l.seed, kk, 'fall') < 0.09) return { clip: 'FALL', t0, t1 };
          if (l.path.length >= 2 && r < 0.4) return { clip: 'style_drunk_walk', t0, t1, walk: [0, 1] };
          return { clip: r < 0.75 ? 'style_drunk_idle' : 'ual_consume', t0, t1, loop: true };
        }
        default: return { clip: 'ual_idle', t0, t1, loop: true };
      }
    };
    return [seg(k - 1), seg(k)];
  }

  update(t: number, dt: number, cam: THREE.PerspectiveCamera, faces: THREE.Vector3[], lodBias: number, cheer: number, sparks: number) {
    if (!this.ready || !this.assets) return;
    const check = t >= this.nextCheck || t < this.nextCheck - 1;
    if (check) this.nextCheck = t + 0.25;
    for (const l of this.live) {
      const [prev, cur] = this.routine(l, t, cheer > 0 && t - cheer < 6 ? cheer : 0);
      const npc = l.npc;
      // placement (walkers move along their path)
      const base = l.a.pos.clone();
      let yaw = Math.atan2(l.a.fwd.x, l.a.fwd.z);
      let clipName = cur.clip, ct = t - cur.t0;
      if (l.role === 'drunk' && cur.clip === 'style_drunk_walk' && l.path.length >= 2) {
        // out to the glass and back within the window, slow (drunk) speed
        const u = (t - cur.t0) / (cur.t1 - cur.t0);
        const leg = u < 0.5 ? u * 2 : (1 - u) * 2;
        const pa = l.path[0], pb = l.path[1];
        const k = smooth3(leg);
        base.copy(pa).lerp(pb, k);
        const dir = (u < 0.5 ? pb.clone().sub(pa) : pa.clone().sub(pb)).normalize();
        if (u > 0.45 && u < 0.55) clipName = 'style_drunk_idle';
        else yaw = Math.atan2(dir.x, dir.z);
      } else if (cur.clip === 'FALL') {
        const a = t - cur.t0;
        if (a < 1.3) { clipName = 'ual_hit_knockback'; ct = a; }
        else if (a < 6) { clipName = 'ual_hit_knockback'; ct = 1.29; }
        else if (a < 9) { clipName = 'ual_lay_to_idle'; ct = a - 6; }
        else { clipName = 'style_drunk_idle'; ct = a; }
      }
      npc.root.position.copy(base); npc.root.position.y += l.sitY;
      npc.root.rotation.y = yaw;
      const A = this.clip(clipName);
      if (A) {
        const ta = A.loop ? ct + (l.seed % 7) : Math.min(ct, A.dur - 0.01);
        // cross-fade from the previous segment's clip over 0.5 s
        const blend = clamp01((t - cur.t0) / 0.5);
        const P = prev && blend < 1 ? this.clip(prev.clip === 'FALL' ? 'style_drunk_idle' : prev.clip === 'style_drunk_walk' ? 'style_drunk_idle' : prev.clip) : null;
        if (P && P !== A) npc.pose(P, t - prev!.t0 + (l.seed % 5), A, ta, blend);
        else npc.pose(A, ta, null, 0, 0);
      }
      if (l.role === 'mechanic' && sparks > 0 && t - sparks < 0.8) npc.root.rotation.y += Math.sin((t - sparks) * 30) * 0.05;
      // look at the performers now and then (the bettor at the board, the bookie at the room)
      if (faces[0] && (l.role === 'holo_bookie' || l.role === 'bettor') && hr(l.seed, Math.floor(t / 6), 'look') < 0.4) npc.lookAt(faces[0], 0.7);
      const d = npc.root.position.distanceTo(cam.position);
      npc.setLod(lodBias < 1.2 ? 1 : d < 7 * lodBias ? 0 : 1);
      if (l.holo) {
        npc.setInk(false);
        const m = npc.mat as THREE.MeshToonMaterial & { userData: { hk?: number } };
        const glitch = hr(Math.floor(t * 12), l.seed) < 0.05 ? 0.35 : 1;
        m.opacity = (0.55 + 0.15 * Math.sin(t * 7)) * glitch * l.fade;
        npc.root.visible = l.fade > 0.02;
        npc.root.position.x += glitch < 1 ? 0.03 : 0;
      }
      if (check) {
        l.want = 1;
        npc.headWorld(tv);
        const dp = tv.distanceTo(cam.position);
        tv.project(cam);
        for (const f of faces) {
          const df = f.distanceTo(cam.position);
          tv2.copy(f).project(cam);
          const dx = (tv.x - tv2.x) * cam.aspect, dy = tv.y - tv2.y;
          if (dp > df - 0.2 && dx * dx + dy * dy < 0.16 * 0.16 && tv.z < 1) { l.want = 0; break; }
        }
      }
      l.fade += Math.sign(l.want - l.fade) * Math.min(Math.abs(l.want - l.fade), dt / 0.35);
      if (!l.holo) npc.setOpacity(l.fade);
    }
  }

  debug() { return this.live.map((l) => ({ role: l.role, fade: +l.fade.toFixed(2), pos: l.npc.root.position.toArray().map((v) => +v.toFixed(2)) })); }

  dispose() {
    for (const l of this.live) l.npc.dispose();
    this.live = [];
    this.group.removeFromParent();
    this.ready = false;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth3(v: number) { const k = clamp01(v); return k * k * (3 - 2 * k); }

/** turn a town NPC into a hologram: additive cyan, fresnel-ish rim, scanlines, no ink. */
function hologram(npc: TownNpc) {
  const m = npc.mat;
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  m.color.setRGB(0.1, 0.35, 0.45);
  m.emissive = new THREE.Color(0.1, 0.55, 0.7);
  m.opacity = 0.65;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  float scan = 0.55 + 0.45 * step(0.5, fract(gl_FragCoord.y * 0.25));
  gl_FragColor.rgb *= scan;
  gl_FragColor.rgb += vec3(0.05, 0.25, 0.32) * scan;`);
  };
  m.customProgramCacheKey = () => 'vtp:raceway:holo';
  m.needsUpdate = true;
}

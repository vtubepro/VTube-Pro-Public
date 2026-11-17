// Colour tints on named parts of the avatar (the VTube Studio "ColorTint" request, shared/b16Commands.ts `art-tint`) and the list of
// part names a plugin may aim at (`art-list`). The same code runs on the studio and on every OBS page: a tint is a plain command
// that reaches all of them, so they agree without talking to each other.
//
// A tint multiplies a material's colour toward the tint (mix 0..1). The first time a material is touched its original colour is
// remembered; every change is recomputed from that original, so tints never pile up and clearing puts the exact colour back.
// Idle cost: none. A timed tint is one setTimeout.
// A plugin fading a colour sends up to 300 tints a second: apply() / clearAll() only mark the tinter dirty and ONE recompute runs per
// frame (RECOMPUTE_MS), over a mesh list that is cached with the names already lower-cased (MESH_TTL_MS, or until reattach()).
import * as THREE from 'three';
import type { ArtList, ArtTint } from '../../../shared/b16Commands.ts';
import type { AvatarRuntime } from '../AvatarRuntime.ts';

interface Active { tint: ArtTint; key: string; timer: ReturnType<typeof setTimeout> | null }
interface MeshEntry { mesh: THREE.Mesh; lname: string; mats: { mat: Tintable; lname: string }[] }

/** One recompute per frame at most. */
const RECOMPUTE_MS = 16;
/** How long the traversed mesh list is trusted (a costume swap shows within this; reattach() drops it at once). */
const MESH_TTL_MS = 3000;

/** Tags (groups of names) a plugin can use without knowing this model's mesh names. */
const TAGS: Record<string, RegExp> = {
  hair: /hair|bang|fringe|ponytail|twintail/i,
  skin: /skin|body|face|head|arm|leg|hand/i,
  eyes: /eye|iris|pupil|sclera|lash/i,
  clothes: /cloth|shirt|dress|skirt|jacket|pants|shoe|boot|sock|glove|costume|outfit|cape|coat|tie|ribbon/i,
};

type Tintable = THREE.Material & { color: THREE.Color; userData: Record<string, unknown> };
const tintable = (m: THREE.Material | undefined): m is Tintable => !!m && (m as Tintable).color instanceof THREE.Color;

export class ArtTinter {
  private active: Active[] = [];
  private touched = new Set<Tintable>();
  private dirty: ReturnType<typeof setTimeout> | null = null;
  private cache: { model: THREE.Object3D; at: number; list: MeshEntry[] } | null = null;
  /** How many recomputes ran (the unit test reads this). */
  recomputes = 0;

  constructor(private readonly getRuntime: () => AvatarRuntime | null) {}

  private meshes(): THREE.Mesh[] {
    const rt = this.getRuntime();
    const out: THREE.Mesh[] = [];
    rt?.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.vtpItem && !o.name.startsWith('Normalized_')) out.push(m); });
    return out;
  }

  /** The meshes of the current avatar with their lower-cased names, cached for MESH_TTL_MS. */
  private entries(now = Date.now()): MeshEntry[] {
    const model = this.getRuntime()?.model ?? null;
    if (!model) { this.cache = null; return []; }
    if (this.cache && this.cache.model === model && now - this.cache.at < MESH_TTL_MS) return this.cache.list;
    const list = this.meshes().map((mesh): MeshEntry => ({
      mesh, lname: mesh.name.toLowerCase(),
      mats: [mesh.material].flat().filter(tintable).map((mat) => ({ mat, lname: mat.name ? mat.name.toLowerCase() : '' })),
    }));
    this.cache = { model, at: now, list };
    return list;
  }

  /** Mark the tinter dirty: the next frame recomputes once, however many messages came in. */
  private schedule() {
    if (this.dirty) return;
    this.dirty = setTimeout(() => { this.dirty = null; this.recompute(); }, RECOMPUTE_MS);
    (this.dirty as { unref?: () => void }).unref?.();
  }

  /** Recompute now if a change is waiting (the unit test, and anything that needs the colours this instant). Returns how many materials the tints reach. */
  flush(): number {
    if (this.dirty) { clearTimeout(this.dirty); this.dirty = null; }
    return this.recompute();
  }

  /** The part names of the current avatar (mesh and material names, unique) and the tags that match something on it. */
  list(req?: string): ArtList {
    const names = new Set<string>();
    for (const m of this.meshes()) {
      if (m.name) names.add(m.name);
      for (const mat of [m.material].flat()) if (mat?.name) names.add(mat.name);
    }
    const all = [...names].filter((n) => /^[\w .:\-/()]{1,64}$/.test(n)).slice(0, 400);
    const tags = Object.entries(TAGS).filter(([, re]) => all.some((n) => re.test(n))).map(([t]) => t);
    return { ...(req ? { req } : {}), names: all, tags };
  }

  /** Add (or, with `clear`, take away) a tint. The colours change at the next frame (see flush()). */
  apply(t: ArtTint): void {
    if (t.clear) {
      this.active = this.active.filter((a) => {
        const hit = (t.by !== undefined && a.tint.by === t.by) && !t.names?.length && !t.tags?.length && !t.all
          || (!!t.names?.length && t.names.some((n) => a.tint.names?.includes(n)))
          || (!!t.tags?.length && t.tags.some((n) => a.tint.tags?.includes(n)))
          || (!!t.all && !t.by);
        if (hit && a.timer) clearTimeout(a.timer);
        return !hit;
      });
      this.schedule();
      return;
    }
    // the same names tinted again replace the earlier tint (a plugin fading a colour sends many)
    const key = `${t.by ?? ''}|${(t.names ?? []).join(',')}|${(t.tags ?? []).join(',')}|${t.all ? 'all' : ''}`;
    const old = this.active.findIndex((a) => a.key === key);
    if (old >= 0) { const o = this.active[old]; if (o.timer) clearTimeout(o.timer); this.active.splice(old, 1); }
    const a: Active = { tint: t, key, timer: null };
    if (t.secs && t.secs > 0) { a.timer = setTimeout(() => { this.active = this.active.filter((x) => x !== a); this.schedule(); }, t.secs * 1000); }
    this.active.push(a);
    if (this.active.length > 64) { const x = this.active.shift(); if (x?.timer) clearTimeout(x.timer); }
    this.schedule();
  }

  /** The avatar was replaced: put the same tints on the new one. */
  reattach() { this.touched.clear(); this.cache = null; this.flush(); }

  /** Remove every tint of one plugin (it disconnected) or all of them. */
  clearAll(by?: string) {
    this.active = this.active.filter((a) => { const hit = by === undefined || a.tint.by === by; if (hit && a.timer) clearTimeout(a.timer); return !hit; });
    this.schedule();
  }

  get count() { return this.active.length; }

  private recompute(): number {
    this.recomputes++;
    // back to the original colours, then every tint in the order it arrived
    for (const m of this.touched) { const b = m.userData.vtpTintBase as THREE.Color | undefined; if (b) m.color.copy(b); }
    let reached = 0;
    if (!this.active.length) { this.touched.clear(); return 0; }
    const meshes = this.entries();
    const tc = new THREE.Color();
    for (const a of this.active) {
      const t = a.tint;
      const wantNames = new Set((t.names ?? []).map((n) => n.toLowerCase()));
      const wantTags = (t.tags ?? []).map((g) => TAGS[g.toLowerCase()]).filter(Boolean);
      tc.setRGB(t.r / 255, t.g / 255, t.b / 255, THREE.SRGBColorSpace);
      const mix = Math.min(1, Math.max(0, t.mix ?? 1));
      for (const { mesh: m, lname, mats } of meshes) {
        for (const { mat, lname: matLname } of mats) {
          const hit = t.all || wantNames.has(lname) || (!!matLname && wantNames.has(matLname))
            || wantTags.some((re) => re.test(m.name) || re.test(mat.name));
          if (!hit) continue;
          if (!mat.userData.vtpTintBase) mat.userData.vtpTintBase = mat.color.clone();
          this.touched.add(mat);
          // (the colour was put back to its original above, so overlapping tints multiply in the order they arrived)
          mat.color.lerp(_to.copy(mat.color).multiply(tc), mix);
          reached++;
        }
      }
    }
    return reached;
  }
}
const _to = new THREE.Color();

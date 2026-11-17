// Room prop toggles, page side (shared/roomToggles.ts, docs/SCENES.md → "Room prop toggles"): finds each toggle's
// root nodes in the loaded room (scene.json `toggles[].nodes` by name + glTF nodes whose extras say `toggleGroup`),
// and applies the host's SceneState.toggles to them:
//   - hidden = `visible = false` on the root (its whole subtree stops drawing);
//   - its meshes leave room.occluders (every camera / screen / solver ray test reads that list) and its COLLIDE_*
//     nodes leave room.colliders, and come back when it is shown again;
//   - FLOOR_* walk data under a hidden root stops counting (floors.ts asks underHiddenToggle);
//   - room clips whose every target sits under a hidden root stop being evaluated (roomClips.ts setHidden).
// A room without toggles gets an empty instance: apply() is a no-op.
import * as THREE from 'three';
import type { SceneInfo } from '../../shared/types.ts';
import { hiddenToggles, parseRoomToggles, toggleOn, type RoomToggleDef, type SceneToggles, type ToggleNodeExtras } from '../../shared/roomToggles.ts';
import type { RoomInfo } from './contract.ts';

/** userData flag on a hidden toggle root (checked up the parent chain by walk data that is invisible anyway). */
const OFF = 'vtpToggleOff';

/** Is `o` inside (or itself) a toggle root that is switched off? */
export function underHiddenToggle(o: THREE.Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if ((p.userData as Record<string, unknown> | undefined)?.[OFF] === true) return true;
  return false;
}

/** Does every one of a clip's targets sit under one of the hidden roots? (no targets / an unresolved one = no) */
export function targetsHidden(targets: readonly (THREE.Object3D | null)[], hiddenRoots: ReadonlySet<THREE.Object3D>): boolean {
  if (!targets.length || !hiddenRoots.size) return false;
  for (const t of targets) {
    if (!t) return false;
    let under = false;
    for (let p: THREE.Object3D | null = t; p && !under; p = p.parent) if (hiddenRoots.has(p)) under = true;
    if (!under) return false;
  }
  return true;
}

export class RoomToggles {
  readonly defs: RoomToggleDef[];
  /** Toggle id → its root nodes in this room. */
  private roots = new Map<string, THREE.Object3D[]>();
  /** Per root: its meshes that were room occluders, its COLLIDE_* nodes that were room colliders. */
  private owned = new Map<THREE.Object3D, { occ: THREE.Mesh[]; col: THREE.Object3D[] }>();
  private hiddenIds = '';
  /** Roots switched off right now. */
  readonly hidden = new Set<THREE.Object3D>();

  constructor(private room: RoomInfo, info: Pick<SceneInfo, 'toggles'>) {
    const tagged: ToggleNodeExtras[] = [];
    const byTag = new Map<THREE.Object3D, string>();
    room.root.traverse((o) => {
      const x = o.userData as Record<string, unknown> | undefined;
      if (x && typeof x.toggleGroup === 'string') { tagged.push({ node: o.name, extras: x }); byTag.set(o, x.toggleGroup); }
    });
    this.defs = parseRoomToggles(info.toggles, tagged);
    if (!this.defs.length) return;
    // names as GLTFLoader keeps them (PropertyBinding.sanitizeNodeName: spaces → _, no [ ] . : /)
    const byName = new Map<string, THREE.Object3D[]>();
    room.root.traverse((o) => { if (o.name) { const l = byName.get(o.name); if (l) l.push(o); else byName.set(o.name, [o]); } });
    for (const d of this.defs) {
      const list: THREE.Object3D[] = [];
      for (const n of d.nodes) for (const o of byName.get(n) ?? byName.get(THREE.PropertyBinding.sanitizeNodeName(n)) ?? []) if (!list.includes(o)) list.push(o);
      for (const [o, id] of byTag) if (id === d.id && !list.includes(o)) list.push(o);
      // (a root inside another root of the same toggle is covered by it)
      this.roots.set(d.id, list.filter((o) => !list.some((p) => p !== o && isAncestor(p, o))));
    }
    for (const list of this.roots.values()) for (const r of list) {
      if (this.owned.has(r)) continue;
      const inside = new Set<THREE.Object3D>();
      r.traverse((o) => inside.add(o));
      this.owned.set(r, { occ: room.occluders.filter((m) => inside.has(m)), col: room.colliders.filter((c) => inside.has(c)) });
    }
  }

  get any() { return this.defs.length > 0; }

  /** Apply the host's choices. true = what is hidden changed (callers re-solve cached shots). */
  apply(state: SceneToggles | undefined): boolean {
    if (!this.defs.length) return false;
    const off = hiddenToggles(this.defs, state);
    const sig = off.join('|');
    if (sig === this.hiddenIds) return false;
    this.hiddenIds = sig;
    const want = new Set<THREE.Object3D>();
    for (const id of off) for (const r of this.roots.get(id) ?? []) want.add(r);
    // a root shared by a shown toggle and a hidden one: hidden wins (the safe side for "must not be on stream")
    for (const r of [...this.hidden]) if (!want.has(r)) this.show(r);
    for (const r of want) if (!this.hidden.has(r)) this.hide(r);
    return true;
  }

  /** The room's objects were put back to their authored state (a Room-editor save: restoreRoomObjects writes the visibility
   *  it first saw, usually before a toggle hid the node, and re-adds the occluders it had taken out): hide what is switched
   *  off again. apply() alone cannot, it only acts when the set of hidden toggles changes. */
  reassert() {
    for (const r of this.hidden) {
      // (an object a layer had hidden at load was not an occluder when we took our list, and the save put it back: take it
      // over as this group's own, so it leaves the occluders now and returns with the group)
      const own = this.owned.get(r);
      if (own) {
        const inside = new Set<THREE.Object3D>();
        r.traverse((o) => inside.add(o));
        for (const m of this.room.occluders) if (inside.has(m) && !own.occ.includes(m)) own.occ.push(m);
        for (const c of this.room.colliders) if (inside.has(c) && !own.col.includes(c)) own.col.push(c);
      }
      this.hide(r);
    }
  }

  private hide(r: THREE.Object3D) {
    this.hidden.add(r);
    r.userData[OFF] = true;
    r.userData.vtpToggleWasVisible ??= r.visible;
    r.visible = false;
    const own = this.owned.get(r);
    if (!own) return;
    const occ = new Set<THREE.Object3D>(own.occ), col = new Set(own.col);
    spliceOut(this.room.occluders, occ);
    spliceOut(this.room.colliders, col);
  }

  private show(r: THREE.Object3D) {
    this.hidden.delete(r);
    delete r.userData[OFF];
    r.visible = r.userData.vtpToggleWasVisible !== false;
    delete r.userData.vtpToggleWasVisible;
    const own = this.owned.get(r);
    if (!own) return;
    for (const m of own.occ) if (!this.room.occluders.includes(m) && !underHiddenToggle(m)) this.room.occluders.push(m);
    for (const c of own.col) if (!this.room.colliders.includes(c) && !underHiddenToggle(c)) this.room.colliders.push(c);
  }

  /** For the studio (RoomSummary.toggles): each toggle, whether it is on here, how many root nodes were found. */
  summary(state: SceneToggles | undefined) {
    return this.defs.map((d) => ({ id: d.id, label: d.label, default: d.default, on: toggleOn(this.defs, state, d.id), found: this.roots.get(d.id)?.length ?? 0 }));
  }
}

function isAncestor(p: THREE.Object3D, o: THREE.Object3D) {
  for (let q = o.parent; q; q = q.parent) if (q === p) return true;
  return false;
}

/** Remove every item of `drop` from `arr` in place (other holders of the same array see it too). */
function spliceOut<T>(arr: T[], drop: Set<T>) {
  if (!drop.size) return;
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (!drop.has(arr[i])) arr[w++] = arr[i];
  arr.length = w;
}

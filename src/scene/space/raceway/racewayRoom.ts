// Raceway (space race course + station defence + a living lounge) — the room contract. Rooms opt in with a
// scene.json `raceway` key; everything else is named nodes in scene.glb (all optional except RACE_PATH_xx):
//
//   RACE_PATH_01…      the racing line (closed, in order). extras gate = gate number (0 = plain control point)
//   RACE_GATE_xx       gate centres (+Z = through direction), extras radius
//   RACE_LIGHTS_xx     the gate's light pods (mesh; its RW_gates / RW_start material is cloned per gate and lit as racers pass)
//   RACE_CRASH_xx      a rock surface next to the line (+Z = out of the rock, towards the line); extras leg = path index
//   RACE_CONTROL       race control (the start / finish announcer, PA flavour)
//   BATTLE_ENTRY_xx    where raiders jump in (+Z = their heading)      BATTLE_LAUNCH_xx  hangar mouth (+Z = out)
//   BATTLE_TURRET_xx   station turret muzzles (+Z = rest aim)         BATTLE_ZONE       box empty, extras size [x, y, z]
//   STATION_PAD_xx     landing pads (extras size, parked = ship kind)  SKY_SUN            direction to the sun
//   RACE_BOARD, PA_TICKER   UV 0..1 planes the engine draws on (canvas textures)
//   BAR_DROID          the bartender droid (moved along extras path [a, b])
//   NPC_<ROLE>         lounge NPC spots (+Z facing; extras role, path, sit)   FX_SPARKS_xx / FX_STEAM_xx / FX_CONFETTI
//   materials RW_*     glows the engine drives itself (RW_flicker, RW_deadI, RW_clinic, RW_alarm, RW_beacon, RW_launch,
//                      RW_gates, RW_start, RW_turret, RW_pa, RW_board) — never EMIT_*, so the light show never fights us
//   materials X_* (incl. the X_Space sky dome), M_Giant, M_Moon   drawn UNLIT (texture × baked light: space has no
//                      ambient; never name a space sky M_Sky: the graphics layer paints drifting clouds on M_Sky)
//   materials ADD_*glow                      atmosphere shells: fresnel additive
// Positions are read in rt.root space (every raceway object lives under rt.root).
import * as THREE from 'three';

type V3 = THREE.Vector3;

export interface RacewayCfg {
  on?: boolean;
  ships?: string; meta?: string; npc?: string;
  seed?: number; racers?: number; speed?: number; pilots?: string[];
  battle?: { every?: [number, number]; raiders?: [number, number]; defenders?: [number, number]; armadaRaiders?: number; armadaDefenders?: number };
  crashEvery?: [number, number];
  traffic?: { every?: [number, number] };
  support?: { bounty?: number; armada?: number };
  unlit?: string[];
  stars?: { count?: number; radius?: number };
}

export interface Anchor { name: string; pos: V3; fwd: V3; extras: Record<string, unknown> }
export interface RacewayRoom {
  path: V3[];
  pathGate: number[];
  gates: { g: number; pos: V3; fwd: V3; r: number; lights: THREE.Mesh | null }[];
  crash: Anchor[];
  turrets: Anchor[]; launch: Anchor[]; entries: Anchor[]; pads: Anchor[];
  zone: THREE.Box3;
  sun: V3;
  control: V3 | null;
  board: THREE.Mesh | null; ticker: THREE.Mesh | null;
  droid: THREE.Object3D | null; droidPath: [V3, V3] | null;
  npcs: Anchor[];
  fx: Anchor[];
  /** RW_* materials by name (every instance: the GLB may have split a material over several primitives). */
  rw: Map<string, THREE.MeshStandardMaterial[]>;
  eye: V3;
}

const tq = new THREE.Quaternion(), rq = new THREE.Quaternion();

function anchor(o: THREE.Object3D, root: THREE.Object3D): Anchor {
  o.updateWorldMatrix(true, false);
  const pos = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  o.getWorldQuaternion(tq);
  root.getWorldQuaternion(rq).invert();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(tq).applyQuaternion(rq).normalize();
  return { name: o.name, pos, fwd, extras: { ...(o.userData ?? {}) } };
}
const byNum = (a: Anchor, b: Anchor) => a.name.localeCompare(b.name, undefined, { numeric: true });
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const v3 = (v: unknown): V3 | null => (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number') ? new THREE.Vector3(v[0], v[1], v[2]) : null);

export function racewayRoomOf(root: THREE.Object3D, eye: V3): RacewayRoom | null {
  const path: Anchor[] = [], gates: Anchor[] = [], crash: Anchor[] = [], turrets: Anchor[] = [], launch: Anchor[] = [], entries: Anchor[] = [], pads: Anchor[] = [], npcs: Anchor[] = [], fx: Anchor[] = [];
  const lights = new Map<number, THREE.Mesh>();
  let zone: THREE.Box3 | null = null, sun: V3 | null = null, control: V3 | null = null;
  let board: THREE.Mesh | null = null, ticker: THREE.Mesh | null = null, droid: THREE.Object3D | null = null, droidPath: [V3, V3] | null = null;
  const rw = new Map<string, THREE.MeshStandardMaterial[]>();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const n = o.name;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mt as THREE.MeshStandardMaterial;
        const k = sm?.name?.replace(/\.\d+$/, '') ?? '';
        if (/^RW_/.test(k)) { const l = rw.get(k) ?? []; if (!l.includes(sm)) l.push(sm); rw.set(k, l); }
      }
    }
    let mm: RegExpExecArray | null;
    if (/^RACE_PATH_\d+$/.test(n)) path.push(anchor(o, root));
    else if (/^RACE_GATE_\d+$/.test(n)) gates.push(anchor(o, root));
    else if ((mm = /^RACE_LIGHTS_(\d+)$/.exec(n)) && m.isMesh) lights.set(+mm[1], m);
    else if ((mm = /^RACE_LIGHTS_(\d+)$/.exec(n))) { o.traverse((c) => { if ((c as THREE.Mesh).isMesh && !lights.has(+mm![1])) lights.set(+mm![1], c as THREE.Mesh); }); }
    else if (/^RACE_CRASH_\d+$/.test(n)) crash.push(anchor(o, root));
    else if (n === 'RACE_CONTROL') control = anchor(o, root).pos;
    else if (/^BATTLE_TURRET_\d+$/.test(n)) turrets.push(anchor(o, root));
    else if (/^BATTLE_LAUNCH_\d+$/.test(n)) launch.push(anchor(o, root));
    else if (/^BATTLE_ENTRY_\d+$/.test(n)) entries.push(anchor(o, root));
    else if (/^STATION_PAD_\d+$/.test(n)) pads.push(anchor(o, root));
    else if (n === 'BATTLE_ZONE') {
      const a = anchor(o, root);
      const s = v3(a.extras.size) ?? new THREE.Vector3(800, 350, 800);
      zone = new THREE.Box3().setFromCenterAndSize(a.pos, new THREE.Vector3(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
    }
    else if (n === 'SKY_SUN') { const a = anchor(o, root); sun = a.pos.clone().normalize(); }
    else if (n === 'RACE_BOARD' && m.isMesh) board = m;
    else if (n === 'PA_TICKER' && m.isMesh) ticker = m;
    else if (n === 'BAR_DROID') {
      droid = o;
      const p = (o.userData as Record<string, unknown>).path;
      if (Array.isArray(p) && p.length >= 2) { const a = v3(p[0]), b = v3(p[1]); if (a && b) droidPath = [a, b]; }
    }
    else if (/^NPC_[A-Z_]+$/.test(n)) npcs.push(anchor(o, root));
    else if (/^FX_(SPARKS|STEAM|CONFETTI)(_\d+)?$/.test(n)) fx.push(anchor(o, root));
  });
  if (path.length < 3) return null;
  path.sort(byNum); gates.sort(byNum); crash.sort(byNum); turrets.sort(byNum); launch.sort(byNum); entries.sort(byNum); pads.sort(byNum);
  const gateList = gates.map((a) => {
    const g = +(/(\d+)$/.exec(a.name)?.[1] ?? 0);
    return { g, pos: a.pos, fwd: a.fwd, r: num(a.extras.radius, 14), lights: lights.get(g) ?? null };
  });
  return {
    path: path.map((a) => a.pos), pathGate: path.map((a) => num(a.extras.gate, 0)), gates: gateList, crash, turrets, launch, entries, pads,
    zone: zone ?? new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(0, 60, -560), new THREE.Vector3(900, 380, 800)),
    sun: sun ?? new THREE.Vector3(0.62, 0.69, 0.38).normalize(), control, board, ticker, droid, droidPath, npcs, fx, rw, eye,
  };
}

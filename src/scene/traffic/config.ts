// Sky traffic — room config (scene.json `traffic`). All positions are glTF / room space (metres, +Y up).
// A room without a `traffic` key costs nothing (TrafficScene.attach returns at once).
import * as THREE from 'three';

export interface PadCfg { name: string; position: [number, number, number]; size: number; cls: string; heading: [number, number, number] }
export interface LaneCfg {
  name: string; points: [number, number, number][]; closed?: boolean; kind?: string;
  /** car streams */ cars?: number; speed?: number; width?: number; twoWay?: number;
  /** ship cruise lanes: comma list of ship ids, one every `every` s */ ships?: string; every?: number;
  /** streams: which vehicle template (car | tug | drone …); trains: a consist of `cars` every `every` s */
  vehicle?: string; train?: { cars?: number; gap?: number; every?: number };
}
export interface ShipMeta { id: string; node: string; length: number; cls: string; gearH: number; label?: string; children?: string[] }
export interface TrafficCfg {
  ships?: string;                 // GLB with SHIP_<id> nodes (default traffic/ships.glb)
  shipsMeta?: string;             // its json (default traffic/ships.json)
  pads?: PadCfg[];
  lanes?: LaneCfg[];
  /** which ship ids may use a pad of each class */
  classes?: Record<string, string[]>;
  /** pad cycle length range (s) */ cycle?: [number, number];
  /** 0.5 … 2: how busy (scales the gaps) */ busy?: number;
  seed?: number;
  /** car stream density 0 … 1.5 (× the lane counts) */ cars?: number;
  /** holo props that spin (node names → turns / s) */ spin?: Record<string, number>;
  /** smart glass: node name + opacity in React */ smartGlass?: { node?: string; opacity?: number; color?: string };
  /** a second sliding door leaf that mirrors DOOR */ doorMirror?: string;
  /** drawn ship scale (default 1.2) */ shipScale?: number;
  /** ships parked for good (spaceport apron): glTF position + heading (nose direction) */
  parked?: { ship: string; position: [number, number, number]; heading: [number, number, number] }[];
  /** animated holo ads: node name -> atlas cells [col,row] cycled every `period` s (the mesh's UVs sit on the first cell) */
  ads?: Record<string, { cells: [number, number][]; period?: number; grid?: [number, number] }>;
}

export const DEFAULT_CLASSES: Record<string, string[]> = {
  S: ['aurora', 'shuttle', 'aurora'],
  M: ['cutlass', 'aurora', 'shuttle', 'cutlass'],
  L: ['constellation', 'cutlass', 'constellation'],
  XL: ['carrack', 'caterpillar', 'hammerhead', 'constellation'],
};

/** A polyline with an arc-length table (sampled every frame by many cars; allocation-free). */
export class Polyline {
  readonly pts: THREE.Vector3[];
  readonly cum: number[] = [0];
  readonly length: number;
  constructor(points: [number, number, number][], readonly closed = false) {
    this.pts = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    if (closed && this.pts.length > 2) this.pts.push(this.pts[0].clone());
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
    this.length = this.cum[this.cum.length - 1] || 1;
  }
  /** position (and optionally the unit tangent) at arc length s (wrapped for closed lanes, clamped otherwise) */
  at(s: number, out: THREE.Vector3, tan?: THREE.Vector3): THREE.Vector3 {
    const L = this.length;
    s = this.closed ? ((s % L) + L) % L : Math.min(L, Math.max(0, s));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[hi], seg = this.cum[hi] - this.cum[lo] || 1;
    out.copy(a).lerp(b, (s - this.cum[lo]) / seg);
    if (tan) tan.copy(b).sub(a).normalize();
    return out;
  }
}

export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((c | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

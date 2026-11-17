// Battle "moments" in a room's own clips (docs/SCENES.md "AFK cinematic director"): the instant a node named *EXPLOSION*
// / *BOOM* / *BLAST* / *KILL* / *DEATH* pops in (its scale key goes from ~0 to visible) is a kill the AFK director can cut
// to, plus any moment the room lists in scene.json `afk.moments`. Room clips loop on the shared room clock
// (src/scene/roomClips.ts), so a moment at `at` s in a loop of `period` s happens at every room-clock time ≡ at (mod
// period) — on every page at once. Where it happens (the node's world position at that instant) is measured once by
// posing the clips at that time: the same data → the same answer on every page.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { AfkMomentKind, RoomAfkConfig } from '../../../shared/afk.ts';

export interface ClipMoment {
  idx: number;
  /** The node the moment happens at. */
  name: string;
  node: THREE.Object3D;
  /** Seconds into its loop, and the loop length (s, room clock). */
  at: number;
  period: number;
  kind: AfkMomentKind;
  /** World position at the moment. */
  pos: THREE.Vector3;
  /** The top-level node it belongs to under the room root (a battle group): craft in the same group star in it. */
  group: THREE.Object3D | null;
  cams: string[] | null;
  lead: number;
  tail: number;
}

const BOOM = /(EXPLO|BOOM|BLAST|KILL|DEATH|DESTROY)/i;
const VISIBLE = 0.02;

/** Top-level ancestor of `o` under `root` (null = `o` is at the top). */
export function groupOf(o: THREE.Object3D, root: THREE.Object3D): THREE.Object3D | null {
  let p: THREE.Object3D | null = o;
  while (p && p.parent && p.parent !== root) p = p.parent;
  return p && p !== o ? p : null;
}

/** Times (s) at which a scale track pops in: the largest axis goes from < 0.02 to ≥ 0.02 (and the loop's start, when the
 *  clip ends hidden and starts visible). Pop-ins closer than 1.5 s count once. */
export function popIns(track: THREE.KeyframeTrack, duration: number): number[] {
  const times = track.times, vals = track.values;
  const n = times.length;
  if (!n) return [];
  const stride = vals.length / n;                   // 3 (linear / step) or 9 (cubic spline: in-tangent, value, out-tangent)
  const off = stride === 9 ? 3 : 0;
  const v = (k: number) => Math.max(Math.abs(vals[k * stride + off]), Math.abs(vals[k * stride + off + 1]), Math.abs(vals[k * stride + off + 2]));
  const out: number[] = [];
  if (v(0) >= VISIBLE && v(n - 1) < VISIBLE) out.push(times[0]);
  for (let k = 1; k < n; k++) if (v(k - 1) < VISIBLE && v(k) >= VISIBLE) out.push(times[k]);
  const merged: number[] = [];
  for (const t of out) if (!merged.length || t - merged[merged.length - 1] > 1.5) merged.push(Math.min(duration, Math.max(0, t)));
  return merged;
}

/** Every moment of the room: automatic pop-ins (unless `autoMoments: false`) + scene.json `afk.moments`. Their positions
 *  (`pos`) are NOT measured yet: `measureMoment` poses the room clips for one moment at a time, so a page can spread that
 *  over frames (src/scene/afk/afkScene.ts plan); `findMoments` does all of it at once. */
export function collectMoments(rt: SceneRuntime, cfg: RoomAfkConfig): ClipMoment[] {
  const clips = rt.clips?.list ?? [];
  const root = rt.room.root;
  const out: ClipMoment[] = [];
  const byNode = new Map<string, THREE.AnimationClip>();
  for (const c of clips) for (const tr of c.tracks) { const { nodeName } = THREE.PropertyBinding.parseTrackName(tr.name); if (!byNode.has(nodeName)) byNode.set(nodeName, c); }
  const find = (name: string) => root.getObjectByName(name) ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) ?? null;
  const add = (node: THREE.Object3D, at: number, period: number, kind: AfkMomentKind, extra: { cams?: string[] | null; lead?: number; tail?: number } = {}) => {
    if (!(period > 0.5) || !Number.isFinite(at)) return;
    out.push({ idx: out.length, name: node.name, node, at: ((at % period) + period) % period, period, kind, pos: new THREE.Vector3(), group: groupOf(node, root),
      cams: extra.cams ?? null, lead: Math.min(8, Math.max(1, extra.lead ?? 3.2)), tail: Math.min(8, Math.max(1, extra.tail ?? 3.3)) });
  };
  if (cfg.autoMoments !== false) {
    for (const c of clips) for (const tr of c.tracks) {
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(tr.name);
      if (propertyName !== 'scale' || !BOOM.test(nodeName)) continue;
      const node = find(nodeName);
      if (!node) continue;
      for (const at of popIns(tr, c.duration)) add(node, at, c.duration, 'kill');
    }
  }
  for (const m of cfg.moments ?? []) {
    if (!m || typeof m !== 'object' || typeof m.at !== 'number') continue;
    const node = typeof m.node === 'string' ? find(m.node) : null;
    const clip = typeof m.clip === 'string' ? clips.find((c) => c.name === m.clip) ?? null : node ? byNode.get(node.name) ?? null : null;
    const period = typeof m.every === 'number' && m.every > 0 ? m.every : clip?.duration ?? 0;
    const target = node ?? (clip ? find(THREE.PropertyBinding.parseTrackName(clip.tracks[0]?.name ?? '').nodeName) : null);
    if (!target) continue;
    const kind = m.kind === 'dies' || m.kind === 'land' || m.kind === 'launch' || m.kind === 'moment' ? m.kind : 'kill';
    add(target, m.at, period, kind, { cams: Array.isArray(m.cams) ? m.cams.filter((x): x is string => typeof x === 'string') : null, lead: m.lead, tail: m.tail });
  }
  return out;
}

/** Where one moment happens: pose the room clips at its loop time and read the node's world position. Returns true when it
 *  posed the clips (the caller puts them back at the room clock before the frame is drawn: `restoreClips`). One call = one
 *  pose of every room clip, the unit of work the page spreads over frames. */
export function measureMoment(rt: SceneRuntime, m: ClipMoment): boolean {
  if (rt.clips) rt.clips.update(m.at);
  m.node.updateWorldMatrix(true, false);
  m.node.getWorldPosition(m.pos);
  return !!rt.clips;
}
/** Put the room clips back at the room clock (what the frame is drawn from). */
export function restoreClips(rt: SceneRuntime) {
  rt.clips?.update((rt.clipClock ?? (() => (Date.now() % 86400000) / 1000))());
}

/** Every moment of the room, positions measured (all at once: tests, tools; the page uses collectMoments + measureMoment). */
export function findMoments(rt: SceneRuntime, cfg: RoomAfkConfig): ClipMoment[] {
  const out = collectMoments(rt, cfg);
  let posed = false;
  for (const m of out) posed = measureMoment(rt, m) || posed;
  if (posed) restoreClips(rt);
  return out;
}

/** Room-clock seconds (s since UTC midnight) → wall ms of each occurrence of a moment between w0 and w1 (wall ms). */
export function occurrences(m: { at: number; period: number }, w0: number, w1: number): { k: number; wall: number }[] {
  const DAY = 86400000;
  const out: { k: number; wall: number }[] = [];
  for (let day = Math.floor(w0 / DAY); day <= Math.floor(w1 / DAY); day++) {
    const base = day * DAY;
    const c0 = Math.max(0, (w0 - base) / 1000), c1 = Math.min(86400, (w1 - base) / 1000);
    for (let k = Math.ceil((c0 - m.at) / m.period); k * m.period + m.at <= c1; k++) {
      const c = k * m.period + m.at;
      if (c < 0 || c >= 86400) continue;
      out.push({ k: day * 100000 + k, wall: base + c * 1000 });
    }
  }
  return out;
}

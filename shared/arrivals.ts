// Per-role entrance / exit styles (docs/SCENES.md → "Per-role entrances and exits").
//
// scene.json `entrance` / `exit` is either a style string for everyone (as before: "cryo", "droppod", "lift", "door")
// or an object that gives the host (member key '@host') and everyone else their own style:
//
//   "entrance": { "host": "lift", "guests": "cryo" },
//   "exit":     { "host": "lift", "guests": "droppod" }
//
// A role left out of the object gets what the room would do without the key (the anchors decide: CRYO_POD_xx → cryo,
// DROP_POD_xx → droppod, else the door walk). Pure data: every page (studio preview, OBS, party guests' OBS) resolves
// the same style from the same scene.json, and the movers then run from the host's move stamps as before.

/** '@host' (shared/scene.ts HOST_KEY; repeated here so this module has no imports). */
const HOST = '@host';
const STYLE = /^[a-z][a-z0-9-]{0,23}$/;

export type RoleStyleSpec = string | { host?: unknown; guests?: unknown } | null | undefined;

export interface RoleStyles {
  host: string | null;
  guests: string | null;
}

const clean = (v: unknown): string | null => (typeof v === 'string' && STYLE.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

/** scene.json `entrance` / `exit` → the style per role. `inferred` = the room's default without the key (from its anchors). */
export function parseRoleStyles(v: unknown, inferred: string | null = null): RoleStyles {
  if (typeof v === 'string') { const s = clean(v); return { host: s ?? inferred, guests: s ?? inferred }; }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return { host: clean(o.host) ?? inferred, guests: clean(o.guests ?? o.guest) ?? inferred };
  }
  return { host: inferred, guests: inferred };
}

/** The style a member (actor key) uses. */
export function styleFor(r: RoleStyles, key: string): string | null {
  return key === HOST ? r.host : r.guests;
}

/** Does any role use this style? */
export function usesStyle(r: RoleStyles, style: string): boolean {
  return r.host === style || r.guests === style;
}

/** The single style string older code expects (SpaceRoom.entrance / .exit): the string itself, or — for the object
 *  form — `prefer` when a role uses it, else the host's style, else the guests'. */
export function legacyStyle(v: unknown, inferred: string | null, prefer: string): string | null {
  if (typeof v === 'string') return v;
  const r = parseRoleStyles(v, inferred);
  if (usesStyle(r, prefer)) return prefer;
  return r.host ?? r.guests;
}

// ------------------------------------------------------------------------------------------------ cryo pods v2
// scene.json `cryo` (docs/SCENES.md → "Cryo pods: frozen occupants, the cryo exit"): what the pods show for members who
// are in the party but NOT in the room, and the look of a frozen performer. Only rooms that use it change:
//
//   "exit": { "host": "cryo", "guests": "cryo" },            (walk back into a pod: the window frosts over, it seals)
//   "cryo": { "hold": "frozen", "breathe": 0.35, "tint": "#bfe6ff", "strength": 0.8 }
//
//   hold      'frozen' = absent members stand frozen in their pod, seen through its window (what a cryo exit ends in, and
//             where guests wait before they thaw in) · 'sealed' = the window frosts over completely and the pod is shown
//             sealed (nobody visible) · 'hidden' = nobody in the pods (the old behaviour).
//             Default: 'frozen' when a role's exit is "cryo", else 'hidden' (rooms without the key are unchanged).
//   breathe   0..1 a very slow breathing idle while frozen (0 = perfectly still). Default 0.35.
//   tint      the frost colour a frozen performer takes on (hex). Default #bfe6ff.
//   strength  0..1 how strongly (tint, ice rim). Default 0.8.
//   forward   m (0..0.5): a frozen occupant stands this far in front of the CRYO_POD_xx anchor, towards the door, so the
//             face sits close behind a small view window (less parallax from an angled camera). Default 0.

export type CryoHold = 'frozen' | 'sealed' | 'hidden';
export interface CryoConfig { hold: CryoHold; breathe: number; tint: string; strength: number; forward: number }

const HEX = /^#[0-9a-f]{6}$/i;
const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

/** scene.json `cryo` (+ whether a role exits by cryo) → the pods' behaviour. */
export function parseCryoConfig(v: unknown, cryoExit: boolean): CryoConfig {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const h = typeof o.hold === 'string' ? o.hold.trim().toLowerCase() : '';
  const hold: CryoHold = h === 'frozen' || h === 'sealed' || h === 'hidden' ? h : cryoExit ? 'frozen' : 'hidden';
  return { hold, breathe: unit(o.breathe, 0.35), tint: typeof o.tint === 'string' && HEX.test(o.tint.trim()) ? o.tint.trim().toLowerCase() : '#bfe6ff', strength: unit(o.strength, 0.8),
    forward: typeof o.forward === 'number' && Number.isFinite(o.forward) ? Math.min(0.5, Math.max(0, o.forward)) : 0 };
}

/**
 * Which pod each member uses (cryo exit, frozen wait, thaw): a pure function of the host's scene state — the member keys
 * and their spot indices (SceneState.spots, which absent members keep) — so every page (studio preview, OBS, party
 * guests' OBS) gives everyone the same pod, and a member keeps theirs while they come and go.
 * `rank` = pod indices by preference (the cryo camera's best first). The host prefers rank[0], a guest rank[(1 + spot) % n]
 * (the same pod the thaw always used); a taken pod passes them to the next free one. More members than pods: the extra
 * ones get none (-1: they walk the door instead).
 */
export function allocatePods(spots: Record<string, number>, rank: number[], uses: (key: string) => boolean): Map<string, number> {
  const n = rank.length, out = new Map<string, number>();
  const keys = Object.keys(spots).filter((k) => uses(k))
    .sort((a, b) => (a === HOST ? -1 : b === HOST ? 1 : (spots[a] - spots[b]) || a.localeCompare(b)));
  const taken = new Set<number>();
  for (const k of keys) {
    let pod = -1;
    if (n) {
      const s0 = k === HOST ? 0 : (1 + Math.max(0, Math.floor(spots[k]))) % n;
      for (let i = 0; i < n; i++) { const r = (s0 + i) % n; if (!taken.has(r)) { pod = r; break; } }
    }
    if (pod >= 0) { taken.add(pod); out.set(k, rank[pod]); } else out.set(k, -1);
  }
  return out;
}

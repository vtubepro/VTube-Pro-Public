// A chat-buddy hand tuning that travels WITH the avatar (AvatarProfile.buddy), so a hand-tuned model keeps its tablet
// hold, size and cartoon arm wherever it is loaded from: the shipped folder, the user library, a crew pack, a model
// brought over from another PC, or this browser's storage. The app's own presets
// (src/scene/chatBuddyPlace.ts TUNED_BUDDIES, keyed by avatar id) still win; every other model without this block is
// measured from its rig as before. Pure data + a sanitizer (no three.js), shared by the studio, server and tools.

/** Hold proportions as fractions of the model's height (mirrors src/scene/chatBuddyPlace.ts BuddyBody). */
export interface BuddyTuneBody {
  chest: number; chin: number; head: number; headW: number; reach: number;
  hold: 'one' | 'two' | 'stand';
  face?: number; top?: number; front?: number; halfW?: number;
}

export interface BuddyTune {
  /** 'classic' = the classic tuned body (short arms, big head: CLASSIC_BODY), or explicit proportions. */
  body: 'classic' | BuddyTuneBody;
  /** Height as a fraction of the room's avatar height (a big head for the body stands smaller). */
  heightK: number;
  /** The cartoon arm that holds the tablet into the frame (colours, '#rrggbb'). Absent = no arm, the tablet slides in. */
  arm?: { skin: string; dark: string };
}

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const colour = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return `#${v.toString(16).padStart(6, '0')}`;
  return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined;
};

/** A clean BuddyTune, or undefined (anything malformed = no tuning: the model is measured from its rig). */
export function sanitizeBuddyTune(v: unknown): BuddyTune | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const heightK = num(o.heightK, 0.3, 1.5);
  if (heightK === undefined) return undefined;
  let body: BuddyTune['body'];
  if (o.body === 'classic') body = 'classic';
  else if (o.body && typeof o.body === 'object' && !Array.isArray(o.body)) {
    const b = o.body as Record<string, unknown>;
    const req = { chest: num(b.chest, 0, 1.5), chin: num(b.chin, 0, 1.5), head: num(b.head, 0, 1.5), headW: num(b.headW, 0.01, 1.5), reach: num(b.reach, 0, 1.5) };
    if (Object.values(req).some((x) => x === undefined)) return undefined;
    const hold = b.hold === 'two' || b.hold === 'stand' ? b.hold : 'one';
    const out: BuddyTuneBody = { ...(req as Omit<BuddyTuneBody, 'hold'>), hold };
    for (const k of ['face', 'top', 'front', 'halfW'] as const) { const x = num(b[k], 0, 1.5); if (x !== undefined) out[k] = x; }
    body = out;
  } else return undefined;
  const t: BuddyTune = { body, heightK };
  if (o.arm && typeof o.arm === 'object') {
    const a = o.arm as Record<string, unknown>;
    const skin = colour(a.skin), dark = colour(a.dark);
    if (skin && dark) t.arm = { skin, dark };
  }
  return t;
}

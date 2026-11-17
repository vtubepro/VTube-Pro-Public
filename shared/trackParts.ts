// Hands / Body switches (owner: "Under tracking, we need to also make sure people can quickly disable hand and body
// tracking in simple mode"). ONE choice per browser for the whole studio, every avatar: Simple → Tracking, Advanced →
// Feel, Live → Me and Ctrl+K all read and write the same thing (src/app.ts setTrackPart). The face is always tracked.
//
// Off = that model stops (the hand model / the body model is closed, the body worker ends when both are off), and the
// avatar's arms / hands ease into the retargeter's relaxed rest pose (src/tracking/trackParts.ts composeParts).
// Before this choice existed, the same two switches lived in each avatar profile (profile.tracking.trackHands /
// trackBody): until a browser has a choice of its own, that old value is what the switches show.
//
// Pure: no DOM, no storage (callers hand in what they read), so tools/tracking_toggles_unit.ts tests all of it.

export type TrackPart = 'hands' | 'body';
export interface TrackParts { hands: boolean; body: boolean }
export const TRACK_PARTS: readonly TrackPart[] = ['hands', 'body'];
/** localStorage key (this browser): {"hands":false,"body":true}. Missing = never chosen in this browser. */
export const TRACK_PARTS_KEY = 'vtp.trackParts';
/** How long a switched-off part takes to ease into the rest pose (seconds). */
export const TRACK_PART_FADE_S = 0.4;

/** The words every screen uses (VOICE.md: short, plain, second person). */
export const TRACK_PART_TEXT: Record<TrackPart, { name: string; hint: string; what: string; off: string; on: string }> = {
  hands: {
    name: 'Hands',
    hint: 'Turn off if your hands keep glitching or you want more speed.',
    what: 'Hand tracking',
    off: 'Hand tracking off. Your hands rest.',
    on: 'Hand tracking on.',
  },
  body: {
    name: 'Body',
    hint: 'Turn off to track only your face.',
    what: 'Body tracking',
    off: 'Body tracking off. Your arms rest.',
    on: 'Body tracking on.',
  },
};

/** Junk-safe read of the stored choice (a JSON string or an already-parsed value): only real booleans count. */
export function parseTrackParts(raw: unknown): Partial<TrackParts> {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>, out: Partial<TrackParts> = {};
  for (const k of TRACK_PARTS) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  return out;
}

/** What the switches show: this browser's choice, else the avatar's old per-avatar setting, else on. */
export function resolveTrackParts(saved: Partial<TrackParts> | null | undefined, legacy?: { trackHands?: unknown; trackBody?: unknown } | null): TrackParts {
  const old = (v: unknown) => (typeof v === 'boolean' ? v : true);
  return {
    hands: typeof saved?.hands === 'boolean' ? saved.hands : old(legacy?.trackHands),
    body: typeof saved?.body === 'boolean' ? saved.body : old(legacy?.trackBody),
  };
}

/** Flip / set one part. */
export function withPart(p: TrackParts, part: TrackPart, on: boolean | 'toggle'): TrackParts {
  return { ...p, [part]: on === 'toggle' ? !p[part] : !!on };
}

export const serializeTrackParts = (p: TrackParts) => JSON.stringify({ hands: !!p.hands, body: !!p.body });
export const sameParts = (a: TrackParts, b: TrackParts) => a.hands === b.hands && a.body === b.body;

/** What the tracker runs for these switches (the face model always runs). */
export function trackerWants(p: TrackParts): { hands: boolean; body: boolean } { return { hands: !!p.hands, body: !!p.body }; }

// ---------------------------------------------------------------- Ctrl+K
const HAND_W = /\b(hands?|fingers?)\b/;
const BODY_W = /\b(body|arms?|torso)\b/;
const TRACK_W = /\btrack(ing|ed|s)?\b/;
const OFF_W = /\b(off|disable[ds]?|stop|pause[ds]?|no|without|hide)\b/;
const ON_W = /\b(on|enable[ds]?|start|resume|back)\b/;

/**
 * Ctrl+K: "hand tracking off", "turn off body tracking", "hands on", "stop tracking my arms" … → which switch to flip.
 * Needs a part word (hand / finger / body / arm) AND a tracking or on / off word, so "body physics" or "hands" alone
 * stay plain searches. No on / off word ("hand tracking") = the opposite of `cur` (what the switch would do now).
 */
export function trackPartsCommand(q: string, cur: TrackParts): { part: TrackPart; on: boolean }[] {
  const s = ` ${q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (s.trim().length < 3) return [];
  const parts = TRACK_PARTS.filter((p) => (p === 'hands' ? HAND_W : BODY_W).test(s));
  if (!parts.length) return [];
  const off = OFF_W.test(s), on = ON_W.test(s);
  if (!off && !on && !TRACK_W.test(s)) return [];
  return parts.map((part) => ({ part, on: off === on ? !cur[part] : on }));
}

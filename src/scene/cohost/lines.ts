// AI co-host (docs/b16/COHOST.md): what a spoken line looks like on a page. PURE (no DOM, no three.js), so
// tools/cohost_unit.ts tests it: when the buddy's mouth moves, and how long a caption stays.
//
// The helper sends one `cohost-line` bus command per line (server/cohost/engine.ts) with the text and how long it lasts. The
// voice itself plays in the studio window (src/audio/mixer/showSounds.ts: OBS pages are silent), so an OBS page can only
// follow it: it moves the chat buddy's mouth in the rhythm of the words (a pause at each comma and full stop) and shows the
// caption. Nothing here runs between lines.

export interface Seg { from: number; to: number }

/** Syllable-ish weight of a word: vowel groups, at least 1. */
const syl = (w: string) => Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) ?? []).length);

/**
 * The stretches of a line where the mouth is open, in ms from the start of the line, for a line that lasts `ms`.
 * Words share the time by their syllables; a comma, a full stop and the like add a short pause. The last 6 % of the line is left
 * closed. Deterministic: the same text always makes the same shape.
 */
export function mouthSegments(text: string, ms: number): Seg[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || ms <= 0) return [];
  const pause = (w: string) => (/[.!?…]$/.test(w) ? 3.2 : /[,;:\-–—]$/.test(w) ? 1.6 : 0);
  const weights = words.map((w) => syl(w) + pause(w));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = ms * 0.94;
  const out: Seg[] = [];
  let t = 0;
  words.forEach((w, i) => {
    const len = (weights[i] / total) * span;
    const talk = len * (syl(w) / weights[i]);
    const from = Math.round(t), to = Math.round(t + talk * 0.92);
    if (to > from) {
      const last = out[out.length - 1];
      if (last && from - last.to < 45) last.to = to; else out.push({ from, to });
    }
    t += len;
  });
  return out;
}

/** Is the mouth open `t` ms into the line? */
export function mouthOpenAt(segs: readonly Seg[], t: number): boolean {
  for (const s of segs) { if (t < s.from) return false; if (t < s.to) return true; }
  return false;
}

/** How long the caption stays: the line, plus a moment to read the end of it. */
export const captionMs = (ms: number) => Math.round(Math.min(65_000, Math.max(3500, ms + 900)));

/** The mood's accent colour for the caption's name tag. Soft colours (no flashing: it is a steady colour, never animated). */
export const MOOD_COLOR: Record<string, string> = { neutral: '#9fb3c8', happy: '#8fdc9f', excited: '#ffd166', curious: '#7fd4f0', sad: '#8fa6ff', sarcastic: '#e0a2ff' };

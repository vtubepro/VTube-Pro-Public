// Kick channel-point reward title -> frontline support (scene.json frontline.rewards keywords + frontline.rewardPriority).
// Pure (no three.js scene, no DOM): FrontlineScene.rewardKind() calls it; tools/frontline_rewards_unit.ts tests it.
//
// A title often hits several keywords: "Orbital Laser" = orbital + laser, "Napalm Airstrike" = napalm + airstrike,
// "Hellbomb" = hellbomb + bomb. The old rule (longest keyword wins) sent "Orbital Laser" to the barrage. Now the most
// explicit hit wins, in this order:
//   1. the whole title IS a rewards key ("call in a mech": "mech") -> that support, outright
//   2. a keyword that starts a word ("laser" in "Orbital Lasers", "500" in "500kg") beats one buried inside a word
//      ("bomb" in "Hellbomb", "rail" in "Trail Mix")
//   3. a multi-word phrase key ("orbital laser") beats a single word
//   4. frontline.rewardPriority (support kinds, most specific first): the kind listed earlier wins. Kinds it leaves out
//      follow in DEFAULT_REWARD_PRIORITY order. The default puts the family defaults last (the generic words map to
//      them: orbital -> barrage, eagle -> airstrike), so "Orbital Laser" -> laser and "Eagle Napalm" -> napalm.
//   5. then the longer keyword, then the one earlier in the title
// Matching ignores case, punctuation and repeated spaces (on both the title and the keys). The rewards map is
// authoritative: the support kind names themselves (laser, railcannon, ...) are tried only when no rewards key hits,
// and keys that map to something that is not a support kind are ignored (as before). Nothing hits -> eagle airstrike.
import { SUPPORT_KINDS, type SupportKind } from './frontlinePlan.ts';

/** Most specific first; barrage / airstrike (what "orbital" / "eagle" mean on their own) come last. */
export const DEFAULT_REWARD_PRIORITY: readonly SupportKind[] = ['hellbomb', 'railcannon', 'laser', 'napalm', 'bomb500', 'mech', 'sentry', 'supply', 'strafe', 'barrage', 'airstrike'];
/** What an unrecognised reward title calls in. */
export const DEFAULT_REWARD_KIND: SupportKind = 'airstrike';

const isKind = (k: unknown): k is SupportKind => typeof k === 'string' && (SUPPORT_KINDS as string[]).includes(k);
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** support kind -> rank (0 = wins ties): the listed kinds in order, then the rest in default order. */
export function rewardRanks(priority?: readonly unknown[] | null): Map<SupportKind, number> {
  const rank = new Map<SupportKind, number>();
  const add = (k: unknown) => { const v = typeof k === 'string' ? k.trim().toLowerCase() : k; if (isKind(v) && !rank.has(v)) rank.set(v, rank.size); };
  if (Array.isArray(priority)) for (const k of priority) add(k);
  for (const k of DEFAULT_REWARD_PRIORITY) add(k);
  for (const k of SUPPORT_KINDS) add(k);
  return rank;
}

interface Hit { kind: SupportKind; word: boolean; words: number; rank: number; len: number; at: number }
const better = (a: Hit, b: Hit) =>
  a.word !== b.word ? a.word
    : a.words !== b.words ? a.words > b.words
      : a.rank !== b.rank ? a.rank < b.rank
        : a.len !== b.len ? a.len > b.len
          : a.at < b.at;

function bestHit(t: string, pairs: [string, unknown][], rank: Map<SupportKind, number>): SupportKind | null {
  let win: Hit | null = null;
  for (const [key, kind] of pairs) {
    if (!isKind(kind)) continue;
    const k = norm(key);
    if (!k) continue;
    let at = -1, word = false;
    for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
      if (i === 0 || t[i - 1] === ' ') { at = i; word = true; break; }
      if (at < 0) at = i;
    }
    if (at < 0) continue;
    const h: Hit = { kind, word, words: k.split(' ').length, rank: rank.get(kind) ?? 99, len: k.length, at };
    if (!win || better(h, win)) win = h;
  }
  return win ? win.kind : null;
}

/** Reward title -> support kind (see the header for the rules). */
export function rewardKindOf(title: string, rewards?: Record<string, unknown> | null, priority?: readonly unknown[] | null): SupportKind {
  const t = norm(title);
  if (!t) return DEFAULT_REWARD_KIND;
  const pairs: [string, unknown][] = rewards && typeof rewards === 'object' ? Object.entries(rewards) : [];
  for (const [key, kind] of pairs) if (isKind(kind) && norm(key) === t) return kind;
  const rank = rewardRanks(priority);
  return bestHit(t, pairs, rank) ?? bestHit(t, SUPPORT_KINDS.map((k): [string, unknown] => [k, k]), rank) ?? DEFAULT_REWARD_KIND;
}

// Plain-word sentences for rules ("When someone redeems Hydrate, the avatar waves, then goes back after 20 seconds").
// The Rules screen, the Try-it toast and the tests use these; no DOM, no jargon, nothing a Streamer.bot user would not say.
import { FINANCE_LABELS, type FinanceKind } from '../../shared/chat.ts';
import { ACTION_BY_ID, type DeckParam } from '../../shared/deck.ts';
import INDEX from '../../assets/library/anims/vrma/index.json';
import type { RuleSetFile, RuleStep, RuleWhen, StreamRule } from '../../shared/streamRules.ts';

const EMOTE_NAMES = new Map((INDEX as { clips: { id: string; label: string }[] }).clips.map((c) => [c.id, c.label]));
const PLATFORM_NAMES: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', tiktok: 'TikTok', rumble: 'Rumble' };
const ROLE_WORDS: Record<string, string> = { everyone: 'anyone', sub: 'subscribers', vip: 'VIPs', mod: 'mods', me: 'only me' };
const SIGN_WORDS: Record<string, string> = { thumbs_up: 'thumbs up', thumbs_down: 'thumbs down', peace: 'peace sign', love: 'heart', fist: 'fist', point: 'pointing', wave: 'wave', palm: 'open palm', rock: 'rock sign' };
const TIER_WORDS: Record<string, string> = { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3', Prime: 'Prime' };

const on = (p?: string) => (p ? ` on ${PLATFORM_NAMES[p] ?? p}` : '');
const rng = (lo: number | undefined, hi: number | undefined, unit: string, one = unit) => {
  const sp = (t: string) => t.replace(/\s+/g, ' ').trim();
  if (lo !== undefined && hi !== undefined) return sp(lo === hi ? `exactly ${lo} ${lo === 1 ? one : unit}` : `${lo} to ${hi} ${unit}`);
  if (lo !== undefined) return sp(`${lo} ${lo === 1 ? one : unit} or more`);
  if (hi !== undefined) return sp(`up to ${hi} ${unit}`);
  return '';
};

/** "someone redeems Hydrate" ... (starts lower-case: the caller puts "When " in front). */
export function describeWhen(w: RuleWhen): string {
  switch (w.kind) {
    case 'redeem': return `someone redeems ${w.contains ? 'a reward with ' : ''}“${w.title}”${w.contains ? ' in its name' : ''}${on(w.platform)}`;
    case 'money': {
      const kinds = w.fkind?.length ? w.fkind.map((k) => FINANCE_LABELS[k as FinanceKind] ?? k).join(' / ') : 'a donation, bits, Kicks or tip';
      const r = w.minUsd !== undefined || w.maxUsd !== undefined
        ? (w.minUsd !== undefined && w.maxUsd !== undefined ? `$${w.minUsd} up to $${w.maxUsd}` : w.minUsd !== undefined ? `$${w.minUsd} or more` : `under $${w.maxUsd}`)
        : rng(w.minAmount, w.maxAmount, '', '');
      return `someone sends ${kinds}${r ? ` (${r})` : ''}${on(w.platform)}`;
    }
    case 'giftSub': { const r = rng(w.min, w.max, 'subs', 'sub'); return `someone gifts ${r || 'subs'}${on(w.platform)}`; }
    case 'sub': return `someone subscribes${w.tier?.length ? ` (${w.tier.map((t) => TIER_WORDS[t] ?? t).join(' or ')})` : ''}${on(w.platform)}`;
    case 'follow': return `someone follows${on(w.platform)}`;
    case 'raid': { const r = rng(w.minViewers, w.maxViewers, 'viewers', 'viewer'); return `a raid arrives${r ? ` with ${r}` : ''}${on(w.platform)}`; }
    case 'tiktokGift': { const r = rng(w.minCoins, w.maxCoins, 'coins', 'coin'); return `someone sends a TikTok ${w.name ? `“${w.name}”` : 'gift'}${r ? ` (${r})` : ''}`; }
    case 'chat': {
      const who = w.role && w.role !== 'everyone' ? ` (${ROLE_WORDS[w.role]} only)` : '';
      if (w.command && w.word) return `chat says ${w.command} with “${w.word}”${who}${on(w.platform)}`;
      return `chat ${w.command ? `types ${w.command}` : `says “${w.word}”`}${who}${on(w.platform)}`;
    }
    case 'key': return `I press ${w.combo}`;
    case 'pad': return `I hit MIDI ${w.note !== undefined ? `pad ${w.note}` : `knob ${w.cc}`}`;
    case 'gamepad': return `I press controller button ${w.button}`;
    case 'hand': return `I make a ${SIGN_WORDS[w.sign] ?? w.sign}${w.side && w.side !== 'any' ? ` with my ${w.side} hand` : ''}${w.holdMs ? ` for ${(w.holdMs / 1000).toFixed(1)} s` : ''}`;
    case 'loud': return `I get loud for ${((w.forMs ?? 0) / 1000).toFixed(1)} s`;
    case 'manual': return 'I press Try it';
  }
}

const labelOfParam = (p: DeckParam, v: string | number | boolean) => {
  const o = p.options?.find((x) => x.value === String(v));
  return o ? o.label : String(v);
};

/** "Outfit (cozy)" · "Throw at my head (5 × Chat emotes)" ... Unknown actions keep their id. */
export function describeStep(step: RuleStep, label?: (id: string) => string | undefined, params?: (id: string) => DeckParam[] | undefined): string {
  const def = ACTION_BY_ID.get(step.action);
  const name = label?.(step.action) ?? def?.label ?? step.action;
  const defs = params?.(step.action) ?? def?.params ?? [];
  const bits: string[] = [];
  for (const [k, v] of Object.entries(step.params ?? {})) {
    if (v === '' || v === undefined) continue;
    const d = defs.find((x) => x.key === k);
    if (d && d.default !== undefined && String(d.default) === String(v) && d.type !== 'text') continue;   // defaults add nothing
    bits.push(step.action === 'emote' && k === 'name' ? EMOTE_NAMES.get(String(v)) ?? String(v) : d?.type === 'number' && /second/i.test(d.label) ? `${v} s` : d ? labelOfParam(d, v) : String(v));
  }
  return bits.length ? `${name} (${bits.join(', ')})` : name;
}

export function describeSecs(n: number): string {
  if (n < 90) return `${Math.round(n * 10) / 10} second${n === 1 ? '' : 's'}`;
  const m = Math.round(n / 6) / 10;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The whole rule as one sentence. */
export function describeRule(r: StreamRule, label?: (id: string) => string | undefined, params?: (id: string) => DeckParam[] | undefined): string {
  const when = r.when.map(describeWhen);
  const w = when.length > 1 ? when.slice(0, -1).join(', ') + ' or ' + when[when.length - 1] : when[0] ?? 'something happens';
  const steps = r.then.map((s) => describeStep(s, label, params));
  const t = steps.length > 1 ? steps.slice(0, -1).join(', then ') + ', then ' + steps[steps.length - 1] : steps[0] ?? 'nothing';
  const back = r.revertSecs > 0 ? `, then it goes back after ${describeSecs(r.revertSecs)}` : '';
  return `When ${w}: ${t}${back}.`;
}

/** What a file import found, in one line. */
export function describeImport(set: RuleSetFile): string {
  const n = set.rules.length;
  return n ? `${n} rule${n === 1 ? '' : 's'} found${set.name ? ` in “${set.name}”` : ''}. They are all switched off: look at each one, then turn it on.` : 'No rules found in that file.';
}

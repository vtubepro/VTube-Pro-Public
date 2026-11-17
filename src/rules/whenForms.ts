// What the editor asks for each kind of trigger ("When ..."), as data: plain labels, which boxes, which defaults. The editor draws
// these generically and tools/stream_rules_unit.ts checks that every form builds a rule shared/streamRules.ts accepts.
import { FINANCE_LABELS, type FinanceKind } from '../../shared/chat.ts';
import { HAND_SIGNS, type RuleWhen, type RuleWhenKind } from '../../shared/streamRules.ts';

export type FieldKind = 'text' | 'num' | 'check' | 'select' | 'multi';
export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  options?: [string, string][];
  placeholder?: string;
  min?: number;
  max?: number;
  /** Stored value = shown value x mul (a "seconds" box that stores ms: 1000; a "percent" box that stores 0..1: 0.01). */
  mul?: number;
  hint?: string;
}
export interface WhenForm {
  kind: Exclude<RuleWhenKind, 'manual'>;
  /** The choice in the "When" list. */
  label: string;
  /** What a new entry of this kind starts as. */
  make(): RuleWhen;
  fields: Field[];
}

export const PLATFORM_OPTIONS: [string, string][] = [['', 'Any site'], ['twitch', 'Twitch'], ['youtube', 'YouTube'], ['kick', 'Kick'], ['tiktok', 'TikTok'], ['rumble', 'Rumble']];
const platform: Field = { key: 'platform', label: 'Where', kind: 'select', options: PLATFORM_OPTIONS };
const MONEY: FinanceKind[] = ['bits', 'kicks', 'superchat', 'supersticker', 'rant', 'jewels', 'tip', 'donation', 'wallet', 'purchase', 'wishlist'];
export const SIGN_OPTIONS: [string, string][] = HAND_SIGNS.map((s) => [s, s.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())]);

export const WHEN_FORMS: WhenForm[] = [
  { kind: 'redeem', label: 'Someone redeems a channel-point reward', make: () => ({ kind: 'redeem', title: '' }),
    fields: [{ key: 'title', label: 'Reward name', kind: 'text', placeholder: 'Hydrate', hint: 'Type it exactly as it shows on your channel.' }, { key: 'contains', label: 'The name only has to contain this', kind: 'check' }, platform] },
  { kind: 'chat', label: 'Chat types a command or a word', make: () => ({ kind: 'chat', command: '!wave' }),
    fields: [{ key: 'command', label: 'Command', kind: 'text', placeholder: '!wave', hint: 'The first word of the message.' }, { key: 'word', label: 'or a word anywhere', kind: 'text', placeholder: 'pog' },
      { key: 'role', label: 'Who can use it', kind: 'select', options: [['', 'Anyone'], ['sub', 'Subscribers'], ['vip', 'VIPs'], ['mod', 'Mods'], ['me', 'Only me']] }, platform] },
  { kind: 'follow', label: 'Someone follows', make: () => ({ kind: 'follow' }), fields: [platform] },
  { kind: 'sub', label: 'Someone subscribes', make: () => ({ kind: 'sub' }),
    fields: [{ key: 'tier', label: 'Which tier', kind: 'multi', options: [['1000', 'Tier 1'], ['2000', 'Tier 2'], ['3000', 'Tier 3'], ['Prime', 'Prime']], hint: 'None ticked = any.' }, platform] },
  { kind: 'giftSub', label: 'Someone gifts subs', make: () => ({ kind: 'giftSub', min: 5 }),
    fields: [{ key: 'min', label: 'At least', kind: 'num', min: 1, max: 100000 }, { key: 'max', label: 'At most', kind: 'num', min: 1, max: 100000 }, platform] },
  { kind: 'money', label: 'Someone sends bits, Kicks, Super Chats or tips', make: () => ({ kind: 'money', fkind: ['bits'], minAmount: 100 }),
    fields: [{ key: 'fkind', label: 'What', kind: 'multi', options: MONEY.map((k) => [k, FINANCE_LABELS[k]] as [string, string]), hint: 'None ticked = any of them.' },
      { key: 'minAmount', label: 'At least (bits, Kicks ...)', kind: 'num', min: 0, max: 1e9 }, { key: 'maxAmount', label: 'At most', kind: 'num', min: 0, max: 1e9 },
      { key: 'minUsd', label: 'Or at least this many dollars', kind: 'num', min: 0, max: 1e6 }, { key: 'maxUsd', label: 'and under this many dollars', kind: 'num', min: 0, max: 1e6 }, platform] },
  { kind: 'raid', label: 'A raid arrives', make: () => ({ kind: 'raid', minViewers: 3 }),
    fields: [{ key: 'minViewers', label: 'At least this many viewers', kind: 'num', min: 0, max: 1e7 }, { key: 'maxViewers', label: 'At most', kind: 'num', min: 0, max: 1e7 }, platform] },
  { kind: 'tiktokGift', label: 'Someone sends a TikTok gift', make: () => ({ kind: 'tiktokGift' }),
    fields: [{ key: 'name', label: 'Gift name (empty = any)', kind: 'text', placeholder: 'Rose' }, { key: 'minCoins', label: 'At least this many coins', kind: 'num', min: 0, max: 1e9 }, { key: 'maxCoins', label: 'At most', kind: 'num', min: 0, max: 1e9 }] },
  { kind: 'key', label: 'I press a key', make: () => ({ kind: 'key', combo: '' }),
    fields: [{ key: 'combo', label: 'Key', kind: 'text', placeholder: 'Ctrl+Shift+F9', hint: 'Letters, numbers or F-keys, with Ctrl, Alt or Shift.' }] },
  { kind: 'hand', label: 'I make a hand sign', make: () => ({ kind: 'hand', sign: 'peace', holdMs: 800 }),
    fields: [{ key: 'sign', label: 'Sign', kind: 'select', options: SIGN_OPTIONS }, { key: 'side', label: 'Which hand', kind: 'select', options: [['', 'Either'], ['left', 'Left'], ['right', 'Right']] },
      { key: 'holdMs', label: 'Hold for (seconds)', kind: 'num', min: 0, max: 10, mul: 1000 }] },
  { kind: 'pad', label: 'I hit a MIDI pad or knob', make: () => ({ kind: 'pad', note: 36 }),
    fields: [{ key: 'note', label: 'Pad note (0-127)', kind: 'num', min: 0, max: 127 }, { key: 'cc', label: 'or knob number (0-127)', kind: 'num', min: 0, max: 127 }, { key: 'channel', label: 'Channel (empty = any)', kind: 'num', min: 1, max: 16 }] },
  { kind: 'gamepad', label: 'I press a controller button', make: () => ({ kind: 'gamepad', button: 0 }),
    fields: [{ key: 'button', label: 'Button number', kind: 'num', min: 0, max: 63 }, { key: 'pad', label: 'Controller (empty = any)', kind: 'num', min: 0, max: 7 }] },
  { kind: 'loud', label: 'I get loud (a scream)', make: () => ({ kind: 'loud', above: 0.8, forMs: 600 }),
    fields: [{ key: 'above', label: 'Louder than (%)', kind: 'num', min: 0, max: 100, mul: 0.01 }, { key: 'forMs', label: 'For at least (seconds)', kind: 'num', min: 0, max: 10, mul: 1000 }] },
];
export const WHEN_FORM_BY_KIND = new Map<string, WhenForm>(WHEN_FORMS.map((f) => [f.kind, f]));

/** Shown value of a stored one (rounded so 0.8 / 0.01 reads 80, not 80.00000000000001). */
export const shown = (f: Field, v: unknown): string => {
  if (typeof v !== 'number') return typeof v === 'string' ? v : '';
  return String(Math.round((v / (f.mul ?? 1)) * 1000) / 1000);
};
/** Stored value of a typed one ('' = not set). */
export const stored = (f: Field, text: string): number | undefined => {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * (f.mul ?? 1) * 1e6) / 1e6 : undefined;
};

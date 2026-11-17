// Ten ready-made rules (docs/b16/RULES.md). They are in the list from the first time the Rules screen opens, all switched OFF:
// nothing happens on stream until the streamer turns one on. "Try it" runs one for real without posting anything anywhere.
// The "wave" is the library's Call out clip (assets/library/anims/vrma/index.json: the library has no clip called wave).
// Reward names are examples ("Hat", "Bonk"): the streamer changes them to the names of their own rewards.
// Pure data, made with sanitizeRules so a starter can never be a shape the engine would refuse.
import { sanitizeRules, type StreamRule } from '../../shared/streamRules.ts';

const RAW: Partial<StreamRule>[] = [
  { id: 'starter-follow', name: 'New follower: happy face', when: [{ kind: 'follow' }],
    then: [{ action: 'expression', params: { name: 'happy', seconds: 3 } }, { action: 'emote', params: { name: 'idle_rail_call' } }], cooldownSecs: 6,
    note: 'Smile and call out to every new follower.' },
  { id: 'starter-hat', name: 'Chat gives me a hat', when: [{ kind: 'redeem', title: 'Hat' }],
    then: [{ action: 'sticker', params: { op: 'random' } }], revertSecs: 30, cooldownSecs: 5,
    note: 'A random sticker or hat from your item set for 30 seconds. Change “Hat” to the name of your reward.' },
  { id: 'starter-bonk', name: 'Bonk!', when: [{ kind: 'redeem', title: 'Bonk' }],
    then: [{ action: 'throw', params: { what: 'emote', count: 5, from: 'redeemer' } }, { action: 'expression', params: { name: 'surprised', seconds: 2 }, delayMs: 700 }],
    cooldownSecs: 4, queue: { max: 5, gapMs: 1500 },
    note: 'Their emotes fly at your head. Change “Bonk” to the name of your reward.' },
  { id: 'starter-headpat', name: 'Headpat', when: [{ kind: 'redeem', title: 'Headpat' }],
    then: [{ action: 'throw', params: { what: 'headpat' } }, { action: 'expression', params: { name: 'happy', seconds: 3 }, delayMs: 600 }], cooldownSecs: 5, queue: { max: 3, gapMs: 3000 },
    note: 'A hand pats your head. Change “Headpat” to the name of your reward.' },
  { id: 'starter-raid', name: 'Raid: it rains emotes', when: [{ kind: 'raid', minViewers: 3 }],
    then: [{ action: 'emote-rain', params: { op: 'burst', secs: 10, from: 'raider' } }, { action: 'lighting', params: { state: 'react' } }], revertSecs: 12, cooldownSecs: 30,
    note: 'The raiders’ emotes fall on you while the lights change, then everything goes back.' },
  { id: 'starter-bits', name: 'Big bits: sparkle', when: [{ kind: 'money', fkind: ['bits'], minAmount: 500 }],
    then: [{ action: 'screen-fx', params: { preset: 'bloom', secs: 3 } }, { action: 'expression', params: { name: 'surprised', seconds: 3 } }], cooldownSecs: 15,
    note: '500 bits or more: a bright flash-safe pop and a surprised face.' },
  { id: 'starter-giftbomb', name: 'Gift bomb: emote shower', when: [{ kind: 'giftSub', min: 5 }],
    then: [{ action: 'emote-rain', params: { op: 'burst', secs: 8, from: 'chat' } }, { action: 'emote', params: { name: 'idle_rail_call' } }], cooldownSecs: 8, queue: { max: 10, gapMs: 2500 },
    note: '5 or more gifted subs. Several gift bombs in a row wait their turn instead of piling up.' },
  { id: 'starter-sub', name: 'New sub: call out', when: [{ kind: 'sub' }],
    then: [{ action: 'emote', params: { name: 'idle_rail_call' } }, { action: 'expression', params: { name: 'happy', seconds: 3 } }], cooldownSecs: 6, queue: { max: 3, gapMs: 2500 },
    note: 'Call out and smile for every new subscriber.' },
  { id: 'starter-wave', name: 'Chat types !wave', when: [{ kind: 'chat', command: '!wave', role: 'everyone' }],
    then: [{ action: 'emote', params: { name: 'idle_rail_call' } }], cooldownSecs: 20,
    note: 'Anyone in chat can make you call out. Once every 20 seconds.' },
  { id: 'starter-wide', name: 'Mods: !wide shows the whole room', when: [{ kind: 'chat', command: '!wide', role: 'mod' }],
    then: [{ action: 'camera', params: { cam: 'wide' } }], revertSecs: 15, cooldownSecs: 30,
    note: 'Only your mods. The camera pulls back for 15 seconds, then returns.' },
];

/** The ten starters, as the engine reads them: always `enabled: false`, always `starter: true`. */
export function starterRules(): StreamRule[] {
  return sanitizeRules(RAW.map((r) => ({ revertSecs: 0, cooldownSecs: 0, ...r, enabled: false, starter: true })));
}
export const STARTER_IDS: readonly string[] = RAW.map((r) => r.id!);

// The interview director's ears for the CHAT AUDIENCE (studio only): turns what the studio's bus carries - chat messages, support
// events, the audience engine's "now answering" question and the crowd applause - into the raw events src/scene/talkshow/crowd.ts
// merges (a gift train is one event, a wave of laughing chatters is one) and the director reacts to. The decisions stay in the
// director (one decider): this only listens, nothing here cuts a camera.
//
//   chat message that laughs (LUL / KEKW / 😂 …)      → chatLaugh   (3 different chatters inside 2.5 s = a laugh wave)
//   support event: a cheer / tip / sub worth $20+      → cheer       (cheerSize)
//   gifted subs / memberships                          → gift        (5 within 3 s each = a gift train)
//   a raid of 10+                                      → raid
//   the audience engine's question set to "answering"  → ask         ("Answer now": the asker's close-up, then the addressee; cut:false
//                                                                       when the owner's "Close-up of the asker" is off: no close-up)
//   the crowd applause counter bumps                   → applause
//   (the show-open card is the host's bag: interviewHost.ts)
//
// Test events (the Scene tab's test button) are never counted. A view that arrives first (a reload) only seeds the state: a question
// already being answered then is not "Answer now" pressed again.
import type { Bus } from '../../bus.ts';
import { sanitizeChatEvent } from '../../../shared/chat.ts';
import { isLaugh, sanitizeView } from '../../../shared/audience.ts';
import { raidDonationValue } from '../../../shared/raid.ts';
import type { RawEvent } from '../../scene/talkshow/crowd.ts';

export function listenCrowd(bus: Pick<Bus, 'on'>, now: () => number, push: (e: RawEvent) => void): () => void {
  const seen = new Set<string>();
  let seeded = false, answering = '', applause = 0;
  return bus.on((m) => {
    const x = m as unknown as Record<string, unknown>;
    if (x.type === 'chat' && x.origin !== 'party' && !x.snap) {
      for (const raw of Array.isArray(x.evs) ? x.evs.slice(0, 60) : []) {
        const e = sanitizeChatEvent(raw);
        if (!e || e.test || seen.has(e.id)) continue;
        seen.add(e.id);
        if (seen.size > 400) for (const k of [...seen].slice(0, 200)) seen.delete(k);
        const t = now();
        if (e.kind === 'chat') {
          const emotes = (e.parts ?? []).filter((p) => p.t === 'emote').map((p) => (p as { n: string }).n);
          if (isLaugh(e.text, emotes)) push({ t, kind: 'chatLaugh', who: e.uid ?? e.user });
        } else if (e.kind === 'finance') {
          if (e.fkind === 'raid') push({ t, kind: 'raid', n: Math.max(0, e.amount ?? 0) });
          else if (e.fkind === 'giftSub' || e.fkind === 'giftMembership') push({ t, kind: 'gift', n: Math.max(1, Math.round(e.amount ?? 1)) });
          else { const usd = raidDonationValue(e); if (usd > 0) push({ t, kind: 'cheer', usd }); }
        }
      }
      return;
    }
    if (x.type === 'audience') {
      const v = sanitizeView(x.s);
      if (!v) return;
      const ans = v.questions.find((q) => q.status === 'answering') ?? null;
      // (the owner's "Close-up of the asker" switch off: the director still knows who was asked - the think, the guest's turn - but cuts no close-up)
      if (seeded && ans && ans.id !== answering) push({ t: now(), kind: 'ask', key: ans.k, text: ans.text, ...(v.look.ask.askerCut ? {} : { cut: false as const }) });
      answering = ans?.id ?? '';
      if (seeded && v.applause.seq !== applause) push({ t: now(), kind: 'applause' });
      applause = v.applause.seq; seeded = true;
    }
  });
}

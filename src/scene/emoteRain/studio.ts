// Emote rain, the studio's side (docs/b16/EMOTE_RAIN.md; no DOM, so the unit test drives it with a fake scene).
// The studio owns the scene state. A button, a Stream Deck key, a rule or the panel's Try it asks for rain; the studio
// writes a stamp {seq, at, op, secs, from, user} into SceneState.modes.emoterain and every OBS page of this PC plays it once
// (src/scene/emoteRain/driver.ts). Nothing is sent to chat, nothing is saved but the stamp.
import { DECK_ACTIONS } from '../../../shared/deck.ts';
import {
  EMOTE_RAIN_BAG, emoteRainJson, planRainOp, sanitizeEmoteRain, type RainEvent, type RainOp,
} from '../../../shared/emoteRain.ts';
import { registerRuleAction, type RuleActionCtx, type RuleActionResult } from '../../../shared/streamRules.ts';

/** The bit of the scene controller this needs (src/scene/controller.ts). */
export interface RainScene {
  readonly observer: boolean;
  readonly canEdit: boolean;
  modeBag(id: string): unknown;
  setModeBag(id: string, v: unknown): void;
}

export const RAIN_OFF_MESSAGE = 'Emote rain is switched off. Turn it on in Live > Stream extras > Emote rain.';
/** The stamp starts this long after it is written, so every page has it before it begins. */
export const STAMP_LEAD_MS = 150;

export interface StampOptions { test?: boolean; now?: number }

/** Ask the pages to play `op`. Refused for observer tabs, party guests, and (unless it is a Try it) while the rain is Off. */
export function stampRain(S: RainScene, op: RainOp, o: StampOptions = {}): { ok: boolean; error?: string } {
  if (S.observer) return { ok: false, error: 'This is a read-only preview: nothing was sent.' };
  if (!S.canEdit) return { ok: false, error: 'Only the host starts emote rain.' };
  const bag = sanitizeEmoteRain(S.modeBag(EMOTE_RAIN_BAG));
  if (bag.mode === 'off' && !o.test) return { ok: false, error: RAIN_OFF_MESSAGE };
  const ev: RainEvent = {
    seq: (bag.ev?.seq ?? 0) + 1, at: (o.now ?? Date.now()) + STAMP_LEAD_MS, op: op.op, secs: op.secs, from: op.from,
    ...(op.user ? { user: op.user } : {}), ...(o.test ? { test: true } : {}),
  };
  S.setModeBag(EMOTE_RAIN_BAG, emoteRainJson({ ...bag, ev }));
  return { ok: true };
}

/** Bus command "emote-rain" (deck, keys, MCP): args {op, secs, from}. */
export function rainCommand(S: RainScene, args: unknown): { ok: boolean; error?: string } {
  const op = planRainOp(args);
  return op ? stampRain(S, op) : { ok: false, error: 'Bad emote rain request' };
}

/** Rule action "emote-rain": the same, with the person behind the trigger (raider / redeemer) filled in. */
export function registerRainRuleAction(S: RainScene): () => void {
  const deck = DECK_ACTIONS.find((a) => a.id === 'emote-rain');
  return registerRuleAction('emote-rain', (ctx: RuleActionCtx): RuleActionResult => {
    const op = planRainOp(ctx.params, ctx.event.user);
    if (!op) return { ok: false, error: 'Bad emote rain request' };
    const r = stampRain(S, op, { test: ctx.test, now: ctx.now });
    if (!r.ok) return r;
    // a steady rain can be put back (stopped) when the rule's timer says so
    return op.op === 'start' ? { ok: true, undo: { action: 'emote-rain', params: { op: 'stop' } } } : { ok: true };
  }, { label: 'Emote rain', group: 'Stream extras', icon: deck?.icon ?? '🌧️', params: deck?.params, where: 'studio', undoable: true });
}

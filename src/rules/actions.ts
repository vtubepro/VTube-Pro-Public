// The list of things a rule can DO, for the editor: every Stream Deck action (shared/deck.ts, old and new) plus the rule actions
// other lanes registered (shared/streamRules.ts registerRuleAction). Grouped in plain words. No DOM: the editor and the tests share it.
import { DECK_ACTIONS, type DeckParam } from '../../shared/deck.ts';
import { listRuleActions } from '../../shared/streamRules.ts';
import { UNDOABLE_DECK_ACTIONS } from './undo.ts';

export interface ActionOption {
  id: string;
  label: string;
  /** Plain-word group. */
  group: string;
  hint: string;
  params: DeckParam[];
  /** The rule can put it back after N seconds. */
  undoable: boolean;
  /** Plays a sound (only ever on the host's OBS page, and only if the user switched sounds on). */
  sound: boolean;
}

/** Deck group -> the words the editor shows, in this order. Groups not listed go under "More". */
export const ACTION_GROUPS: [string, string][] = [
  ['Stream extras', 'Fun for chat'], ['Fun', 'Fun for chat'], ['Me', 'My avatar'], ['Scene', 'Room and camera'],
];
const MORE = 'More';
export const GROUP_ORDER = ['Fun for chat', 'My avatar', 'Room and camera', MORE];
/** Deck actions that make no sense as a reaction (they only move around the deck itself). */
const SKIP = new Set(['page-next', 'page-prev', 'page-go']);

export function actionOptions(): ActionOption[] {
  const out = new Map<string, ActionOption>();
  for (const a of DECK_ACTIONS) {
    if (a.local || SKIP.has(a.id)) continue;
    const group = ACTION_GROUPS.find(([g]) => g === a.group)?.[1] ?? MORE;
    out.set(a.id, { id: a.id, label: a.label, group, hint: a.hint, params: a.params ?? [], undoable: UNDOABLE_DECK_ACTIONS.includes(a.id), sound: a.id === 'sfx' });
  }
  // rule actions other lanes registered: they may add their own labels, parameters and "can be put back" flag
  for (const { id, meta } of listRuleActions()) {
    const old = out.get(id);
    out.set(id, {
      id, label: meta.label || old?.label || id, group: old?.group ?? (meta.group && ACTION_GROUPS.find(([g]) => g === meta.group)?.[1]) ?? MORE,
      hint: old?.hint ?? '', params: meta.params ?? old?.params ?? [], undoable: !!meta.undoable || !!old?.undoable, sound: !!meta.sound || !!old?.sound,
    });
  }
  return [...out.values()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** The params a fresh step starts with: each parameter's default (empty ones are left out). */
export function defaultParams(opt: ActionOption | undefined): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  for (const d of opt?.params ?? []) if (d.default !== undefined && d.default !== '') p[d.key] = d.default;
  return p;
}

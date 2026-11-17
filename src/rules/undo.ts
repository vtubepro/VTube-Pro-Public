// "Put it back after N seconds" for the old Stream Deck actions (docs/b16/RULES.md). A new action (sticker, item scene ...) hands
// back its own undo step when it runs; the older deck actions (outfit, lights, camera ...) do not, so the engine takes a
// snapshot of what they are about to change and plans the step that restores it. Pure data in, data out: no DOM, no network,
// so tools/stream_rules_unit.ts can test every case and a revert stamp (plain JSON) can be run after a studio reload.
import type { DeckLiveState } from '../../shared/deck.ts';
import type { RuleStep } from '../../shared/streamRules.ts';

/** What the studio knew just before a step ran. */
export interface UndoBefore {
  live: DeckLiveState;
  /** Worn outfit id (null = none). */
  costume: string | null;
  /** Accessory ids worn. */
  accessories: string[];
}

type P = Record<string, string | number | boolean>;
const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** Deck actions a rule can put back (the editor offers "Put back after" when a step is in this list or its action says `undoable`). */
export const UNDOABLE_DECK_ACTIONS: readonly string[] = ['lighting', 'mode', 'room', 'camera', 'costume', 'accessory', 'cover', 'chat-hide', 'weather', 'model-slider'];

/**
 * The step that puts back what `action` is about to change, or undefined when it cannot (or need not) be undone.
 * `params` are the step's params with the {placeholders} filled in.
 */
export function planUndo(action: string, params: P | undefined, before: UndoBefore): RuleStep | undefined {
  const p = params ?? {};
  const L = before.live;
  switch (action) {
    case 'lighting': return L.lighting ? { action: 'lighting', params: { state: L.lighting } } : undefined;
    case 'mode': return L.mode ? { action: 'mode', params: { mode: L.mode } } : undefined;
    case 'room': return { action: 'room', params: { sceneId: L.sceneId ?? '' } };
    case 'camera': {
      // a camera the host picked by hand goes back to that camera; otherwise back to the automatic one
      if (!L.camHand) return { action: 'camera', params: { cam: 'auto' } };
      return { action: 'camera', params: { cam: L.camera ?? 'talk', focus: L.focus === '@host' ? 'me' : s(L.focus) } };
    }
    case 'costume': return { action: 'costume', params: { id: before.costume ?? '' } };
    case 'accessory': {
      const id = s(p.id);
      return id ? { action: 'accessory', params: { id } } : undefined;   // it is a toggle: pressing it again puts it back
    }
    case 'cover': return { action: 'cover', params: { on: L.cover ? 'true' : 'false' } };
    case 'chat-hide': return { action: 'chat-hide', params: { on: L.chatHidden ? 'true' : 'false' } };
    // (a room whose weather changes by itself goes back to changing by itself: the weather action alone would pin it)
    case 'weather': return { action: 'weather', params: { weather: L.weather || 'clear', ...(L.weatherAuto ? { auto: 'true' } : {}) } };
    case 'model-slider': {
      const d = s(p.do) || 'toggle', slider = s(p.slider);
      if (d === 'on') return { action: 'model-slider', params: { slider, do: 'off' } };
      if (d === 'off') return { action: 'model-slider', params: { slider, do: 'on' } };
      if (d === 'toggle') return { action: 'model-slider', params: { slider, do: 'toggle' } };
      return undefined;   // step / set / reset: the old value is not known
    }
  }
  return undefined;
}

/**
 * A step that flips a state instead of setting it (the deck "accessory" and "model-slider" with do=toggle), as a key naming
 * what it flips; undefined for every other step. Running such a step twice before it is put back would undo the first run,
 * so the engine runs it once and only holds the revert longer.
 */
export function toggleKey(action: string, params: P | undefined): string | undefined {
  const p = params ?? {};
  if (action === 'accessory') return s(p.id) ? 'accessory:' + s(p.id) : undefined;
  if (action === 'model-slider') return (s(p.do) || 'toggle') === 'toggle' && s(p.slider) ? 'model-slider:' + s(p.slider) : undefined;
  return undefined;
}

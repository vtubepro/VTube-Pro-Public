// Which inputs the switched-on rules need to be listening. A rule "when I press F13" or "when I make a wave sign" only fires if the
// key listener, MIDI, controller poll or hand reader is running, and those start only for a Keys & pads binding or when a screen asks
// (src/input/runtime.ts wantKey / wantInput, docs/b16/BINDINGS.md). This file works out what the rules ask for and holds exactly that,
// releasing it when a rule is removed, switched off or edited. No browser, no timers: the studio mount feeds it the rule list.
import type { StreamRule } from '../../shared/streamRules.ts';

export type WantedInput = 'midi' | 'gamepad' | 'hand';
export interface InputNeeds { keys: string[]; inputs: WantedInput[]; /** a "loud" trigger: needs the Soundboard scream detector */ loud: boolean }

/** What the switched-on rules need (switched-off rules need nothing). Order and duplicates do not matter. */
export function inputNeeds(rules: readonly StreamRule[]): InputNeeds {
  const keys = new Set<string>(), inputs = new Set<WantedInput>();
  let loud = false;
  for (const r of rules) {
    if (!r.enabled) continue;
    for (const w of r.when) {
      if (w.kind === 'key' && w.combo) keys.add(w.combo);
      else if (w.kind === 'pad') inputs.add('midi');
      else if (w.kind === 'gamepad') inputs.add('gamepad');
      else if (w.kind === 'hand') inputs.add('hand');
      else if (w.kind === 'loud') loud = true;
    }
  }
  return { keys: [...keys].sort(), inputs: [...inputs].sort(), loud };
}

/** Which of this rule's triggers need the scream detector, for the status line ("loud" fires only while it is on). */
export const ruleNeedsScream = (r: StreamRule): boolean => r.when.some((w) => w.kind === 'loud');

export interface InputWantDeps {
  wantKey(combo: string): () => void;
  wantInput(kind: WantedInput): () => void;
}

/** Holds one wantKey / wantInput per thing the rules need; `sync` after every change of the list, `release` when the lane unmounts. */
export class InputWanter {
  private held = new Map<string, () => void>();
  constructor(private d: InputWantDeps) {}

  sync(rules: readonly StreamRule[]): InputNeeds {
    const need = inputNeeds(rules);
    const want = new Map<string, () => () => void>();
    for (const k of need.keys) want.set('key:' + k, () => this.d.wantKey(k));
    for (const i of need.inputs) want.set('in:' + i, () => this.d.wantInput(i));
    for (const [id, rel] of [...this.held]) if (!want.has(id)) { this.held.delete(id); try { rel(); } catch { /* releasing is best effort */ } }
    for (const [id, take] of want) if (!this.held.has(id)) this.held.set(id, take());
    return need;
  }

  /** What is held right now (for tests and the status line). */
  get holding(): string[] { return [...this.held.keys()].sort(); }

  release() {
    for (const rel of [...this.held.values()]) { try { rel(); } catch { /* best effort */ } }
    this.held.clear();
  }
}

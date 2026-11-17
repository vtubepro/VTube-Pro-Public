// Moods: the expression state machine (docs/RIG2D_FORMAT.md §8.5) as simple rules the 2D avatar maker shows:
// "When <trigger> → show <expression> (for N s)". Rules live in one state-machine layer ('user_moods'): a calm state, one
// state per rule, a transition from any state on the trigger, and back to calm after the hold time (or on silence for
// a voice rule). The automatic layers ('auto_mood', 'auto_blink') are switched as a whole. Pure (no DOM).
import type { EdDoc, EdStateLayer } from './doc.ts';

export type TriggerKind = 'voice' | 'silence' | 'emotion' | 'chat' | 'event' | 'hotkey' | 'timer';
export interface MoodRule { on: { kind: TriggerKind; value?: string; above?: number }; expression: string; hold: number }

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  voice: 'I start talking', silence: 'I stop talking', emotion: 'My face looks', chat: 'Chat says', event: 'A stream event', hotkey: 'I press the hotkey', timer: 'Every few seconds',
};
export const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
export const EVENTS = ['follow', 'sub', 'raid', 'cheer', 'donation', 'redeem'];

const LAYER = 'user_moods';

export function readRules(doc: EdDoc): MoodRule[] {
  const L = doc.extras?.states?.find((l) => l.id === LAYER);
  if (!L) return [];
  const rules: MoodRule[] = [];
  for (const st of L.states) {
    if (st.id === 'calm') continue;
    const into = L.transitions.find((t) => t.to === st.id);
    const back = L.transitions.find((t) => t.from === st.id && t.to === 'calm');
    if (!into || !st.expression) continue;
    rules.push({ on: { kind: into.on.kind as TriggerKind, ...(into.on.value !== undefined ? { value: into.on.value } : {}), ...(into.on.above !== undefined ? { above: into.on.above } : {}), ...(into.on.kind === 'timer' ? { above: into.on.after } : {}) },
      expression: st.expression, hold: back?.on.kind === 'timer' ? back.on.after ?? 3 : 0 });
  }
  return rules;
}

export function writeRules(doc: EdDoc, rules: MoodRule[]) {
  const X = (doc.extras ??= {});
  const others = (X.states ?? []).filter((l) => l.id !== LAYER);
  if (!rules.length) { X.states = others; return; }
  const L: EdStateLayer = { id: LAYER, name: 'My moods', initial: 'calm', states: [{ id: 'calm' }], transitions: [] };
  rules.forEach((r, i) => {
    const id = `rule${i + 1}`;
    L.states.push({ id, expression: r.expression });
    const on = r.on.kind === 'timer' ? { kind: 'timer' as const, after: Math.max(0.5, r.on.above ?? 6) } : { kind: r.on.kind, ...(r.on.value ? { value: r.on.value } : {}), ...(r.on.above !== undefined ? { above: r.on.above } : {}) };
    L.transitions.push({ from: r.on.kind === 'timer' ? 'calm' : '*', to: id, fade: 0.25, on });
    L.transitions.push({ from: id, to: 'calm', fade: 0.3, on: r.on.kind === 'voice' ? { kind: 'silence', after: Math.max(0.3, r.hold || 0.8) } : { kind: 'timer', after: Math.max(0.2, r.hold || 3) } });
  });
  X.states = [...others, L];
}

/** The automatic layers on / off. */
export function autoLayerOn(doc: EdDoc, id: 'auto_mood' | 'auto_blink'): boolean { return !!doc.extras?.states?.some((l) => l.id === id); }
export function setAutoLayer(doc: EdDoc, id: 'auto_mood' | 'auto_blink', on: boolean, make: () => EdStateLayer[]) {
  const X = (doc.extras ??= {});
  const list = (X.states ?? []).filter((l) => l.id !== id);
  if (on) { const m = make().find((l) => l.id === id); if (m) list.unshift(m); }
  X.states = list;
}

/** A rule as one plain sentence. */
export function ruleText(r: MoodRule, exprName: (id: string) => string): string {
  const v = r.on.value ? ` "${r.on.value}"` : '';
  const when = r.on.kind === 'timer' ? `Every ${r.on.above ?? 6} s` : `When ${TRIGGER_LABEL[r.on.kind].toLowerCase()}${v}`;
  return `${when} → ${exprName(r.expression)}${r.on.kind === 'voice' ? ' while talking' : ` for ${r.hold || 3} s`}`;
}

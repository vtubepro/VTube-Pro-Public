// The saved place of a setup wizard (localStorage 'vtp.wiz.<id>'), and the honest marks the wizard shows (FR-01).
// Pure: no DOM, so tools/ux_v2_ux2first_unit.ts can run it in Node.
//  * Pressing Next or Skip means "seen" or "skipped", never "done". A step is "done" only when its real state says so
//    (camera on, mic on, OBS seen, room loaded, profile chosen): the wizard asks the step (WizStep.isDone), it does not
//    remember a click.
//  * A beta.15 blob ({ step, done, skipped, finished, at }, where `done` meant "Next was pressed") still loads: its
//    `done` ids become "seen" and are never trusted as real state.
export interface WizState { step: string | null; done: string[]; seen: string[]; skipped: string[]; finished: boolean; at: number }
export type WizMark = 'done' | 'seen' | 'skipped' | 'none';

export const emptyWizState = (): WizState => ({ step: null, done: [], seen: [], skipped: [], finished: false, at: 0 });
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const uniq = (l: string[]) => [...new Set(l)];

/** Parse a saved blob (any version). Never throws; bad data is an empty state. */
export function parseWizState(raw: string | null | undefined): WizState {
  try {
    const v = JSON.parse(raw || 'null') as Record<string, unknown> | null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const legacyDone = strs(v.done);
      return {
        step: typeof v.step === 'string' ? v.step : null,
        done: legacyDone,
        seen: uniq([...strs(v.seen), ...legacyDone]),
        skipped: strs(v.skipped),
        finished: v.finished === true,
        at: typeof v.at === 'number' ? v.at : 0,
      };
    }
  } catch { /* bad json */ }
  return emptyWizState();
}

/** What pressing Next on a step means: a step that has a real state and does not meet it is "skipped", else "seen". */
export const nextMark = (hasRealState: boolean, real: boolean): 'seen' | 'skipped' => (hasRealState && !real ? 'skipped' : 'seen');

/** Record that the person went past a step. Never touches `done`. */
export function markStep(st: WizState, id: string, how: 'seen' | 'skipped') {
  if (how === 'seen') { if (!st.seen.includes(id)) st.seen.push(id); st.skipped = st.skipped.filter((x) => x !== id); }
  else { if (!st.skipped.includes(id)) st.skipped.push(id); st.seen = st.seen.filter((x) => x !== id); }
}

/** The mark of one step. `real` is the step's live state (undefined: the step has none, so it can only be seen or skipped). */
export function stepMark(st: WizState, id: string, real: boolean | undefined): WizMark {
  if (real === true) return 'done';
  if (st.skipped.includes(id)) return 'skipped';
  if (st.seen.includes(id)) return 'seen';
  return 'none';
}

/** The sidebar counter. Only steps with a real state count; a wizard with none of them counts steps seen, and says so. */
export function counterText(st: WizState, steps: { id: string; real?: boolean }[]): { n: number; of: number; text: string; pct: number } {
  const counted = steps.filter((s) => s.real !== undefined);
  if (counted.length) {
    const n = counted.filter((s) => s.real).length;
    return { n, of: counted.length, text: `${n} of ${counted.length} set up`, pct: Math.round((n / counted.length) * 100) };
  }
  const n = steps.filter((s) => st.seen.includes(s.id) || st.skipped.includes(s.id)).length;
  return { n, of: steps.length, text: `${n} of ${steps.length} seen`, pct: steps.length ? Math.round((n / steps.length) * 100) : 0 };
}

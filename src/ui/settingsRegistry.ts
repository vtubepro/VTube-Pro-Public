// Settings essentials registry (UX redesign v2, L4 / FR-02): the card ids the Simple Settings view shows, and the card ids
// the Advanced Settings view shows, in order. Advanced is a superset: every Simple card is in it, as itself or as the
// Advanced card that replaces it (SETTINGS_COVERED_BY). Pure data (no DOM) so tools/ux_v2_ux4settings_unit.ts can test it
// and the e2e can compare it with the real page. Each card carries `data-card="<id>"` (src/ui/settingsCards.ts, simple.ts,
// panels.ts).

/** The cards of Settings in Simple, top to bottom. */
export const SETTINGS_SIMPLE_CARDS = ['look-feel', 'guided-setups', 'performance', 'your-computer', 'keyboard-shortcuts'] as const;

/** The cards of Settings in Advanced, top to bottom: the Simple essentials first, then the original Advanced cards. */
export const SETTINGS_ADVANCED_CARDS = ['look-feel', 'guided-setups', 'performance', 'status', 'ai-apps', 'models-tools', 'credits', 'keyboard-shortcuts'] as const;

/** A Simple card that Advanced shows as another card, because the Advanced one holds everything it has (and more). */
export const SETTINGS_COVERED_BY: Record<string, string> = { 'your-computer': 'status' };

/** The Simple cards that Advanced does not show (must be empty). */
export function settingsMissingInAdvanced(simple: readonly string[] = SETTINGS_SIMPLE_CARDS, advanced: readonly string[] = SETTINGS_ADVANCED_CARDS): string[] {
  return simple.filter((id) => !advanced.includes(id) && !advanced.includes(SETTINGS_COVERED_BY[id] ?? ''));
}

/** The "Guided set-ups" rows: every wizard of src/ui/wizards.ts WIZARD_LIST must have a row (8). */
export const SETTINGS_WIZARD_IDS = ['firstRun', 'model', 'room', 'chat', 'react', 'phone', 'multicam', 'multiplayer'] as const;

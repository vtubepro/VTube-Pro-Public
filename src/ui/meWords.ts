// Plain names for the Me area (UX redesign L3, AV-07): the speech mouth shapes the face tester offers, and the rig kinds the
// loaded-model readout shows. The internal keys (TEST_EXPRESSIONS in src/app.ts, rt.info.rig) do not change; only what the
// person reads does. No viseme codes, no file formats in the label.

/** Face tester pills: the speech-shape tests ("V·PP" ...) read as the sound they make. Everything else is already plain. */
const MOUTH_SHAPE: Record<string, string> = {
  'V·PP': 'P/B/M', 'V·FF': 'F/V', 'V·TH': 'Th', 'V·L': 'L', 'V·SH': 'Sh/Ch', 'V·SS': 'S', 'V·OO': 'Oo', 'V·RR': 'R', 'V·aa': 'Ah',
  'V·smile-talk': 'Smiling talk', 'V·angry-shout': 'Angry shout',
};
export const expressionLabel = (key: string): string => MOUTH_SHAPE[key] ?? key;
/** The longer tooltip of a speech-shape pill ("" for an ordinary expression). */
export const expressionHint = (key: string): string => (MOUTH_SHAPE[key] ? `Test the mouth shape for the sound “${MOUTH_SHAPE[key]}”` : '');

/** "Rig: ..." in plain words. */
export function rigLabel(rig: string): string {
  switch (rig) {
    case 'vrm': return 'ready-made (VRM)';
    case 'humanoid': return 'ready-made (human skeleton)';
    case 'soft': return 'generated for this model';
    case 'none': return 'none (not rigged)';
    default: return rig;
  }
}

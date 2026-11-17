// The Quality team's first pass over the generated festival looks (shared/festivalLooks.ts, LOOKS_VERSION 1): looks
// that read badly on a real stage, removed by default. The owner's Look Lab picks replace this list entirely
// (SceneFestivalState.curation). Reviewed from the Look Lab contact sheets (tools/festival_e2e.mjs sheets) and measured:
// each look run for 4 bars at 150 BPM through the safe flash gate (average beam + wash level); the mid / peak looks far
// below the rest (under 25 % where the class median is ~54 %) read as an empty stage.
export const QUALITY_KILL = new Set<string>([
  '1bh62ku', // Blood Moon Converge
  '105q86f', // Toxic V-Spread
  '1mssah2', // Deep Ocean Spiral
  '0chabhg', // Arctic White Figure-8
  '0e034zx', // Gold Rush Wave
  '1q4u08z', // Full Spectrum Crowd Sweep
]);
/** Why each removal (shown in the Look Lab on hover). */
export const QUALITY_NOTES: Record<string, string> = {
  '1bh62ku': 'Too dark for its slot: chase beams over a stack wash leave the stage mostly black (20 % average level vs ~54 % for mid looks).',
  '105q86f': 'Too dark for its slot: chase beams over a halftime wash leave the stage mostly black (24 % average level vs ~54 % for mid looks).',
  '1mssah2': 'Too dark for its slot: chase beams over a sparkle wash leave the stage mostly black (25 % average level vs ~54 % for mid looks).',
  '0chabhg': 'Too dark for its slot: chase beams over a halftime wash leave the stage mostly black (24 % average level vs ~54 % for mid looks).',
  '0e034zx': 'Too dark for its slot: chase beams over a halftime wash leave the stage mostly black (25 % average level vs ~54 % for mid looks).',
  '1q4u08z': 'Too dark for its slot: chase beams over a halftime wash leave the stage mostly black (24 % average level vs ~54 % for mid looks).',
};

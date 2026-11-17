// Stage mode registry — import THIS (not modeCore.ts) from engine / studio code: it loads every mode module in
// ./modes/ (Talk, React, Gaming + whatever other workstreams drop in there: a new mode is a new file, nothing else).
export * from './modeCore.ts';

// Vite turns this into static imports of every file in ./modes (eager): studio and OBS page alike.
(import.meta as unknown as { glob: (p: string, o: { eager: true }) => Record<string, unknown> }).glob('./modes/*.ts', { eager: true });

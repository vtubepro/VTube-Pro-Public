// Import THIS from studio UI code: it loads every mode sub-panel in ./panels/ (React, Gaming + other workstreams' files).
export * from './panelCore.ts';
(import.meta as unknown as { glob: (p: string, o: { eager: true }) => Record<string, unknown> }).glob('./panels/*.ts', { eager: true });

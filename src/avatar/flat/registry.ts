// 2D-avatar kinds: factories register here (src/avatar/flat/kinds.ts imports each kind's module once).
import type { FlatSourceFactory } from './types.ts';

const factories = new Map<string, FlatSourceFactory>();

/** Register a kind's loader (a second registration of the same kind replaces the first: HMR). */
export function registerFlatSource(f: FlatSourceFactory) { factories.set(f.kind, f); }
export function flatSourceFor(kind: string): FlatSourceFactory | null { return factories.get(kind) ?? null; }
export function flatKinds(): FlatSourceFactory[] { return [...factories.values()]; }

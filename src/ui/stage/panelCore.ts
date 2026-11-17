// Scene tab → mode bar: per-mode preset sub-panels (studio only). A mode adds its panel with a new file in ./panels/
// (loaded by ./panelRegistry.ts): registerModePanel('<mode id>', (app, S) => element). Spec: S\stagemodes\MODE_REGISTRY.md.
import type { App } from '../../app.ts';
import type { SceneController } from '../../scene/controller.ts';

export type ModePanel = (app: App, S: SceneController) => HTMLElement | null;
const panels = new Map<string, ModePanel>();
export function registerModePanel(id: string, fn: ModePanel) { panels.set(id, fn); }
export const modePanel = (id: string): ModePanel | null => panels.get(id) ?? null;

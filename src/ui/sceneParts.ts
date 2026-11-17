// What the top of each part of the old Scene tab shows (src/ui/scenePanel.ts). Brave / Edge testers (2026-10-04): "Room and
// Show & layout display similar top content": both opened on the same "Room lights" bar and the same preview. Now each
// area opens on its own job:
//   Room           - the room's lights, then the preview of what OBS shows (then the room picker, cameras, seats ...)
//   Show & layout  - the show mode (Talk / React / Gaming and its presets), then the preview with the layout editor
// Pure, so tools/browser_ui_unit.ts can check it without a DOM.
export type ScenePartId = 'all' | 'room' | 'show' | 'chat' | 'stream';

export interface SceneTop {
  /** The "Room lights" bar (Preshow / Show / React / BRB / Outro) at the very top. */
  lights: boolean;
  /** The show mode section (stageSection) above the preview instead of further down. */
  showModeFirst: boolean;
  /** The live preview of what OBS shows (the layout editor draws on it in Show). */
  preview: boolean;
}

export function sceneTop(part: ScenePartId, hasRoom: boolean): SceneTop {
  const room = part === 'all' || part === 'room', show = part === 'all' || part === 'show';
  return { lights: hasRoom && room, showModeFirst: part === 'show', preview: room || show };
}

/** The label of the "Room lights" bar: where the show mode lives (it is a separate area now, not "further down"). */
export const LIGHTS_BAR_NOTE = ' · the show mode (Talk, React, Gaming) is in Show & layout';

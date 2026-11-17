// Full screen: the captured game / window fills the whole frame (an OBS passthrough hole, or the in-scene window when
// one is shared), the performers stand on it as cut-outs (or boxed cams) in a corner, and the layout's HUD elements —
// alerts, a goal bar … — are drawn over it; the chat box (shared/chatBox.ts) takes the layout's chat place unless the
// streamer placed it, drawn as plain text when the layout's look says so. The layouts are data (shared/hud.ts: two built-ins +
// the user's / an AI's own, stored in the `hud` mode bag); docs/LAYOUTS.md.
import { registerStageMode } from '../modeCore.ts';
import { HUD_BAG, HUD_MODE, hudLayout, lookFor, planHud, sanitizeHudBag } from '../../../../shared/hud.ts';
import { slotKey } from '../../../../shared/stageLayout.ts';

registerStageMode({
  id: HUD_MODE, label: 'Full screen', icon: '🖼', order: 35,
  hint: 'Your game / window fills the screen; you stand on it as a cut-out in a corner (+ chat as text, alerts …)',
  camera: 'group', curtain: false, hole: true, chat: 'docked',
  page: {
    plan(ctx) {
      const bag = sanitizeHudBag((ctx.state.modes ?? {})[HUD_BAG]);
      const def = hudLayout(bag);
      const keys = ctx.performers.filter((p) => p.present).map((p) => p.key);
      // (the compositor applies the look's geometry — scale, corner — and the layout editor's custom rects after this)
      return planHud(def, { aspect: ctx.aspect, keys, content: ctx.stage.content, look: lookFor(bag, slotKey(HUD_MODE, def.label), def.look), chat: ctx.docks.chat });
    },
  },
});

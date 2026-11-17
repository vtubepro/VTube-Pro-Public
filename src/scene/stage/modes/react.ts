// React: watch something together. Window size presets (shared/stage.ts): Side (the solo side screen beside the host),
// Big (the room's big centre screen), Medium / Full (screen-space layouts: the capture + performer cams + chat), Auto
// (by group size). Big / Side stay in 3D; performers the React camera can't clearly see get cams in free space.
import { registerStageMode } from '../modeCore.ts';
import { plan3d, planReactFull, planReactMedium, resolveReact } from '../../../../shared/stage.ts';

registerStageMode({
  id: 'react', label: 'React', icon: '🖥', order: 20, key: 'R', hint: 'Watch something together — pick how big the window is', camera: 'react', hole: true,
  page: {
    plan(ctx) {
      const keys = ctx.performers.filter((p) => p.present).map((p) => p.key);
      const kind = resolveReact(ctx.stage.react, Math.max(1, keys.length), ctx.room.hasScreen);
      const inp = { aspect: ctx.aspect, keys, content: ctx.stage.content, chat: ctx.docks.chat, support: ctx.docks.support };
      if (kind === 'full') return planReactFull(inp);
      if (kind === 'medium') return planReactMedium(inp);
      // Big / Side: the room's shot at 80 % (top-left), the view widened around it: chat, support and the cams of anyone the
      // shot can't show get the column beside it and the band under it — never over the screen or a face
      // (Big / Side are 3D room shots: the chat stays in the world — only cams for performers the shot can't show widen the view)
      const room = keys.length > 1;
      // (Side where the solo two-shot can't be clean — a DJ booth, a podium — shows the big screen: say so)
      const label = kind === 'big' ? 'Big' : ctx.rt.layout() === 'big' ? 'Side → Big here' : 'Side';
      return plan3d(label, true, false, false, room ? 0.8 : 1);
    },
  },
});

// Gaming: the game capture (an OBS Game / Window / Display Capture under the browser source, seen through the hole) is
// the star; every performer is a live, face-tracked cam. Solo: a corner cam; 2: a strip (host left); 3+: the party
// moves to the Gaming Lounge (a row of gaming chairs, LED strips) and the strip shows everyone, host leftmost.
import { registerStageMode } from '../modeCore.ts';
import { planGaming, resolveGaming, wantsLounge } from '../../../../shared/stage.ts';

registerStageMode({
  id: 'gaming', label: 'Gaming', icon: '🎮', order: 30, key: 'G', hint: 'Your game is the star — everyone is a live cam', camera: 'group',
  curtain: true, hole: true, chat: 'docked',
  enter(ctx) {
    const lounge = ctx.stage.loungeRoom;
    const has = ctx.scenes.some((s) => s.id === lounge && s.ready !== false);
    // 3+ performers (or no room at all) → the Gaming Lounge, seated in join order (host on the left)
    if (has && ctx.state.sceneId !== lounge && (wantsLounge(ctx.stage, ctx.present.length) || !ctx.state.sceneId)) return { room: lounge, seats: 'order' };
  },
  page: {
    plan(ctx) {
      const keys = ctx.performers.filter((p) => p.present).map((p) => p.key);
      const st = ctx.stage;
      return planGaming({ aspect: ctx.aspect, keys, content: st.content, chat: ctx.docks.chat, support: ctx.docks.support,
        layout: resolveGaming(st.gaming, keys.length), strip: st.strip, corner: st.corner, cam: st.cam, framing: st.framing, backdrop: st.backdrop });
    },
  },
});

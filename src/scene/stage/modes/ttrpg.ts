// "TTRPG" in the stage-mode bar (stagemodes' registry, S/stagemodes/MODE_REGISTRY.md): the party moves to this
// environment's TTRPG room (the curtain plays) and the table turns on; picking another mode turns it off and the core
// takes everyone back to the room they came from. Installed by install_ttrpgcore.py only when the registry exists.
// The game itself (sheets, dice, the GM) is src/ttrpg/studio — it follows SceneState.ttrpg.on.
import { registerStageMode } from '../modeCore.ts';
import { DEFAULT_TTRPG_STATE, sanitizeTtrpgState } from '../../../../shared/ttrpg/state.ts';
import { envOfRoom, ttrpgRoomFor } from '../../../../shared/ttrpg/rooms.ts';

registerStageMode({
  id: 'ttrpg',
  label: 'Tabletop game',
  icon: '🎲',
  order: 50,
  key: 'P',
  hint: 'Move the party to this setting’s tabletop room and open the table (dice, map, the GM)',
  camera: 'wide',
  chat: 'auto',
  enter(ctx) {
    const cur = ctx.prev.sceneId;
    const inTable = !!cur && ttrpgRoomFor(ctx.scenes, cur) === cur;
    const env = inTable ? envOfRoom(ctx.scenes, cur) || ctx.prev.ttrpg?.from || '' : cur ?? '';
    const room = ttrpgRoomFor(ctx.scenes, env || cur);
    const t = ctx.state.ttrpg ? sanitizeTtrpgState(ctx.state.ttrpg) : structuredClone(DEFAULT_TTRPG_STATE);
    ctx.state.ttrpg = { ...t, on: true, ...(env ? { from: env } : {}) };
    return room && room !== cur ? { room, seats: 'keep' } : {};
  },
  exit(ctx) {
    if (ctx.state.ttrpg) ctx.state.ttrpg = { ...ctx.state.ttrpg, on: false };
  },
});

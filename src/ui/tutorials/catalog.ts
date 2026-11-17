// Tutorials: the list, in the hub's order. One file per tutorial in ./defs: add a file, then add it here.
import type { Tutorial } from './types.ts';
import { firstSetup } from './defs/firstSetup.ts';
import { importModel } from './defs/importModel.ts';
import { obs } from './defs/obs.ts';
import { costumes } from './defs/costumes.ts';
import { room } from './defs/room.ts';
import { goLive } from './defs/goLive.ts';
import { react } from './defs/react.ts';
import { guest } from './defs/guest.ts';
import { brb } from './defs/brb.ts';
import { chat } from './defs/chat.ts';
import { aiCreate } from './defs/aiCreate.ts';

export const TUT_GROUPS: Tutorial['group'][] = ['Start here', 'Your look', 'Your show', 'Make things'];

export const TUTORIALS: Tutorial[] = [firstSetup, importModel, obs, costumes, room, goLive, react, guest, brb, chat, aiCreate];

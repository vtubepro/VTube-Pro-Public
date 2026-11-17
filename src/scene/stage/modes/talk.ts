// Talk: the room camera (talk / group / wide / presets). The stage layer only adds docked chat / support panels when
// the in-world chat monitor, support board or Sprocket's tablet can't show them in the current shot.
import { registerStageMode } from '../modeCore.ts';

registerStageMode({ id: 'talk', label: 'Talk', icon: '🎙', order: 10, key: 'T', hint: 'Hang out in the room — the camera frames whoever is talking', camera: 'talk' });

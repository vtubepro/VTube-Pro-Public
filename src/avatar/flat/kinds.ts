// Every 2D-avatar kind the studio and the OBS pages know: ONE import line per kind (its module calls
// registerFlatSource). FlatAvatar imports this file, so a kind is available wherever 2D avatars load.
import './pngSource.ts';
import './rig2d/source.ts'; // VTube Pro 2D rigs (.vtp2) incl. Live2D models converted on import (live2d lane)
import '../../../shared/flatKinds.ts';

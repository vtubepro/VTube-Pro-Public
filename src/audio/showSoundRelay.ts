// OBS / output pages: a room engine's sound goes to the studio instead of the speakers (shared/showSound.ts).
// src/output.ts sets the sink on real OBS pages only (previews, ?sceneTest and test pages send nothing).
import type { ShowSound } from '../../shared/showSound.ts';

let sink: ((id: string, s: ShowSound) => void) | null = null;
/** The page's way to the studio (null = this page sends nothing). */
export function setShowSoundSink(f: ((id: string, s: ShowSound) => void) | null) { sink = f; }
/** A room sound happened: the studio plays it (once, however many OBS pages report it). */
export function relayShowSound(id: string, s: ShowSound) { try { sink?.(id, s); } catch { /* never break a scene */ } }

// a live stream on the room screen: this page's player tells the studio how far behind the live edge it plays, so the
// studio's sound of the same stream follows the picture (shared/showSound.ts liveSteer)
let clockSink: ((src: string, lag: number) => void) | null = null;
export function setLiveClockSink(f: ((src: string, lag: number) => void) | null) { clockSink = f; }
export function relayLiveClock(src: string, lag: number) { try { clockSink?.(src, lag); } catch { /* never break a scene */ } }

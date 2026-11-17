// One rule for every WebRTC sender on the studio side (window share, TV feeds; mode B has the same in src/streamPcSend.ts):
// a page saying `hello` again while its link is up (or still connecting, just started) does NOT get a new link. Tearing it
// down and re-offering restarts that encoder: a page (or a stream PC, server/streamPc.ts) repeating hello must not be
// able to hitch the live picture (security review r3, 2026-10-08).
const born = new WeakMap<RTCPeerConnection, number>();
/** Call when a link is created. */
export function markBorn(pc: RTCPeerConnection) { born.set(pc, performance.now()); }
/** Keep this link instead of re-offering? Connected, or new / connecting and younger than `ms`. */
export function keepPeer(pc: RTCPeerConnection | undefined, ms = 8000): boolean {
  if (!pc) return false;
  const s = pc.connectionState;
  if (s === 'connected') return true;
  if (s === 'failed' || s === 'closed' || s === 'disconnected') return false;
  return performance.now() - (born.get(pc) ?? -Infinity) < ms;
}

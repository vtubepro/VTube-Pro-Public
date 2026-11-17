// "Am I on air?" for parts of the studio that must never interrupt a stream (src/ui/keepAwake.ts keeps the screen awake
// while it is in use). The shell (src/ui/shell.ts) sets it from the on-air state and the party.
let live = false, party = false;
const fns = new Set<() => void>();
export function setStudioPresence(l: boolean, p: boolean) {
  if (l === live && p === party) return;
  live = l; party = p;
  for (const f of fns) { try { f(); } catch { /* listener */ } }
}
export const studioPresence = () => ({ live, party });
export function onStudioPresence(fn: () => void) { fns.add(fn); return () => fns.delete(fn); }

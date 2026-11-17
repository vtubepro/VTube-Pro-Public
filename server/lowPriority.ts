// A background helper process (a sidecar that is not the live tracking or the stream itself) runs at below-normal CPU
// priority, like server/gpuWatch.ts and server/screenFeed.ts do, so a game (normal priority) wins the processor when both
// want it. Never raises anything. Off switch for a PC where that hurts: VTP_SIDECAR_PRIORITY=normal.
import os from 'node:os';

export function lowerPriority(pid: number | undefined, env: NodeJS.ProcessEnv = process.env, set: (pid: number, p: number) => void = os.setPriority): boolean {
  if (!pid || env.VTP_SIDECAR_PRIORITY === 'normal') return false;
  try { set(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); return true; } catch { return false; }   // (not allowed: stays normal)
}

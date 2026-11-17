// The VTube Pro Live Engine supervisor: an INERT STUB (VTube Pro Live, Phase 1, workstream W2).
//
// Phase 1 only DETECTS whether the engine is installed. It never launches, adopts, stops or talks to it: the engine
// does not exist yet (Phase 2 makes this a live supervisor: launch, adopt from engine.json, health, never restart while
// outputs are live). What Go Live needs from it today is one fact: "is the OTHER broadcaster already on the air?"
// (Go Live is refused with `other-live` when it is). With no engine that answer is a plain "no".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EngineDetect {
  installed: boolean;
  running: boolean;
  /** An engine output is on the air. null = cannot tell (never connected). */
  outputActive: boolean | null;
  version: string | null;
}

export interface EngineSupervisor {
  detect(): Promise<EngineDetect>;
  /** Phase 1: false. The studio shows "coming soon". */
  readonly available: boolean;
}

/** Where the engine would be installed (per user, no admin): %LOCALAPPDATA%\Programs\VTube Pro Live Engine. */
export function engineDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'VTube Pro Live Engine');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'vtube-pro-live-engine');
}

export function createEngineSupervisor(opts: { dir?: string } = {}): EngineSupervisor {
  return {
    available: false,
    async detect() {
      const dir = opts.dir ?? engineDir();
      let installed = false;
      try { installed = fs.existsSync(path.join(dir, process.platform === 'win32' ? 'vtplive-engine.exe' : 'vtplive-engine')); } catch { /* unreadable = not installed */ }
      // no engine on this PC: it cannot be live, so "is your other broadcaster live?" is a plain no (installed but not asked yet: unknown)
      return { installed, running: false, outputActive: installed ? null : false, version: null };
    },
  };
}

export const engineSupervisor: EngineSupervisor = createEngineSupervisor();

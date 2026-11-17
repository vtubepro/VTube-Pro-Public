import os from 'node:os';
import path from 'node:path';

/** The user's own per-OS config folder: Windows %APPDATA%\VTube Pro · macOS ~/Library/Application Support/VTube Pro ·
 *  Linux $XDG_CONFIG_HOME/vtube-pro (~/.config/vtube-pro). Override: VTP_CONFIG_HOME (a folder). A bundled release keeps
 *  its data here (server/paths.ts dataHome). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.VTP_CONFIG_HOME) return env.VTP_CONFIG_HOME;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'VTube Pro');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'VTube Pro');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'vtube-pro');
}

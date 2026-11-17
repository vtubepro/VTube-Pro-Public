// How VTube Pro starts PowerShell: always a static script FILE (tools/helper/win/ps/*.ps1) with its inputs as named parameters, never -EncodedCommand / a base64 blob and
// never a script built on the fly. That is what it is, and what antivirus / EDR products expect from an installed program.
// The only inputs are validated integers, port lists and the helper's own paths; no user text reaches a command line.
// No -ExecutionPolicy Bypass for an installed script either (psPolicyFor).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.ts';

/** tools/helper/win/ps in the install. */
export const PS_DIR = path.join(ROOT, 'tools', 'helper', 'win', 'ps');
export const psScriptPath = (name: string, dir: string = PS_DIR) => path.join(dir, name);
export const psScriptExists = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * -ExecutionPolicy for running `file` with -File. RemoteSigned (the mildest policy that runs a script at all; Windows'
 * own default on clients is Restricted, which runs none) for a script installed on this PC, which is what the Inno setup
 * and the Mac / Linux installs write. Bypass only for a script that carries Mark-of-the-Web (a Zone.Identifier stream: a
 * zip extracted by Explorer). There RemoteSigned refuses an unsigned script outright, and for a signed one it asks
 * "run software from this untrusted publisher?", which -NonInteractive turns into a refusal. The signature doesn't
 * decide it: a script without Mark-of-the-Web runs under RemoteSigned either way. (The policy only governs script
 * FILES, which is why -Command never needed it.)
 */
export function psPolicyFor(file: string, hasMotw: (f: string) => boolean = markOfTheWeb): 'RemoteSigned' | 'Bypass' {
  try { return hasMotw(file) ? 'Bypass' : 'RemoteSigned'; } catch { return 'Bypass'; }
}
/** NTFS keeps a download's zone in the file's "Zone.Identifier" alternate data stream (Windows only). */
function markOfTheWeb(file: string): boolean {
  if (process.platform !== 'win32') return false;
  try { fs.statSync(`${file}:Zone.Identifier`); return true; } catch { return false; }
}

export type PsParams = ReadonlyArray<readonly [name: string, value: string | number]>;
/** One named parameter as separate argv words: -Name value. A string with spaces (a path) is wrapped in double quotes
 *  because Start-Process joins its ArgumentList with spaces; plain words / numbers / port lists go bare. */
function paramWords(params: PsParams, wrapQuoted: boolean): string[] {
  const out: string[] = [];
  for (const [name, value] of params) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error('bad parameter name');
    out.push(`-${name}`);
    if (typeof value === 'number') { if (!Number.isInteger(value)) throw new Error('bad parameter value'); out.push(String(value)); continue; }
    if (/["\r\n\0]/.test(value)) throw new Error('bad parameter value');
    out.push(wrapQuoted && !/^[\w.,:-]+$/.test(value) ? `"${value}"` : value);
  }
  return out;
}
const psSingle = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** powershell.exe running `script` directly (a long-lived worker, no elevation). `extra` = leading switches (-NoLogo ...). */
export function psFileCommand(script: string, params: PsParams = [], extra: string[] = []): { command: string; args: string[] } {
  return { command: 'powershell.exe', args: [...extra, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', psPolicyFor(script), '-File', script, ...paramWords(params, false)] };
}

/**
 * The elevated launch (the person answers Windows' own UAC prompt): ONE non-elevated powershell.exe whose only job is
 * `Start-Process -Verb RunAs -Wait` on the static script, then it exits with the script's exit code. Minimised, not
 * hidden: a visible launch is what an installer does. Paths with spaces / apostrophes survive both quoting layers.
 */
export function elevatedFileCommand(script: string, params: PsParams): { command: string; args: string[] } {
  if (/["\r\n\0]/.test(script)) throw new Error('bad script path');
  const argList = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', psPolicyFor(script), '-File', `"${script}"`, ...paramWords(params, true)];
  const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Minimized -ArgumentList ${argList.map(psSingle).join(',')}; exit $p.ExitCode`;
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', outer] };
}

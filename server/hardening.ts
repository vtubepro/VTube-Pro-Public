// Release-mode guards for VTube Pro's local server. Small and boring on purpose:
//
//  * RELEASE_BUILD  true when the environment variable VTP_BUILD is "release", false in a normal checkout (the default).
//  * No remote debugging in release mode: a server started with --inspect / --inspect-brk / --debug (on its command line or
//    in NODE_OPTIONS) refuses to start with one plain line, and a watchdog closes the inspector if anything opens it anyway
//    (inspector.open() from injected code, a SIGUSR1 on a Node without --disable-sigusr1). Debug flags are also removed from
//    the environment the server's own child processes inherit.
//    A normal checkout is untouched: you can debug your own copy as usual.
// Pure helpers are exported so they can be tested.
import inspector from 'node:inspector';

/** True only when VTP_BUILD=release is set in the environment. */
export const RELEASE_BUILD: boolean = process.env.VTP_BUILD === 'release';

const DEBUG_FLAG = /^--(inspect(-brk|-port|-wait|-publish-uid)?|debug(-brk|-port)?)(=.*)?$/;

/** The remote-debugging flags among the process's own flags and NODE_OPTIONS (an empty list = none). */
export function debugFlags(execArgv: readonly string[], nodeOptions: string | undefined): string[] {
  const opts = String(nodeOptions ?? '').split(/\s+/).filter(Boolean);
  return [...execArgv, ...opts].filter((a) => DEBUG_FLAG.test(a));
}

/** NODE_OPTIONS without the debugging flags (null = nothing left), so the server's child processes cannot inherit them. */
export function scrubNodeOptions(nodeOptions: string | undefined): string | null {
  const kept = String(nodeOptions ?? '').split(/\s+/).filter((a) => a && !DEBUG_FLAG.test(a));
  return kept.length ? kept.join(' ') : null;
}

export type GuardVerdict = { ok: true } | { ok: false; message: string };
/** May this process start? Only a release refuses, and only for remote-debugging flags or an inspector that is already open. */
export function releaseGuard(o: { release: boolean; execArgv: readonly string[]; nodeOptions: string | undefined; inspectorUrl: string | undefined }): GuardVerdict {
  if (!o.release) return { ok: true };
  const flags = debugFlags(o.execArgv, o.nodeOptions);
  if (flags.length || o.inspectorUrl) {
    return { ok: false, message: `VTube Pro does not start with a debugger attached (${flags.join(' ') || 'inspector open'}). Start it from the VTube Pro shortcut instead.` };
  }
  return { ok: true };
}

/** Run once at start (server/index.ts, before anything listens). Never does anything in a source install. */
export function applyReleaseGuard(): void {
  if (!RELEASE_BUILD) return;
  const v = releaseGuard({ release: true, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, inspectorUrl: inspector.url() });
  if (!v.ok) {
    console.error(`[vtube-pro] ${v.message}`);
    process.exit(1);
  }
  const scrubbed = scrubNodeOptions(process.env.NODE_OPTIONS);
  if (scrubbed === null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = scrubbed;
  // anything that opens the inspector later (a SIGUSR1 where the flag is missing, injected code) is closed again
  setInterval(() => {
    if (!inspector.url()) return;
    try { inspector.close(); } catch { /* already closing */ }
    console.warn('[vtube-pro] a debugger port was opened on VTube Pro; it was closed again (release build).');
  }, 2000).unref();
}

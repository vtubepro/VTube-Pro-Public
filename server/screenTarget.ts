// What the fast window feed (server/screenFeed.ts) captures: the window / monitor the performer's OBS capture source
// shows (read-only obs-websocket requests), or a window picked in the Scene tab. Split out of screenFeed.ts so it can be
// tested against a mock obs-websocket without starting a capture (tools/react_obs_unit.ts).
//
//  * Reading the OBS source needs only a saved OBS password (or the automation on) — NOT the "Automate OBS" toggle:
//    that toggle moves the Window Capture for passthrough and switches scenes; the in-scene feed just reads.
//  * It uses the helper's shared OBS read connection (server/obs.ts readOnly), so the 10 s re-check doesn't open and
//    close an obs-websocket session every time.
//  * A Display Capture's monitor index is looked up ONCE per OBS monitor id (OBS can take seconds to list monitors:
//    4.4 s seen on a 4-monitor PC) and never silently falls back to monitor 1.
import type { CaptureSettings } from '../shared/capture.ts';
import type { ObsClient } from './obs.ts';

/** `size`: a whole monitor's resolution when OBS says it (its monitor list names them "LG ULTRAGEAR+ (3840x2160)"). */
export interface Target { selectors: string[]; label: string; obsSource: string | null; obsKind: string | null; target: string; size?: { w: number; h: number } | null }
/** Pure: "LG ULTRAGEAR+ (3840x2160)" → 3840 × 2160 (null = no size in the name). */
export function sizeInName(name: string): { w: number; h: number } | null {
  const m = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(name);
  return m ? { w: +m[1], h: +m[2] } : null;
}
/** `setup`: a setting the performer has to change (no OBS password, no capture source, no window chosen, a source
 *  the feed can't follow …) — retrying never gets past it, so the OBS pages hear a definite no ('unavailable') at once
 *  instead of waiting out a 4 s 'connecting…' card on every React switch. Without it: a passing problem (OBS not
 *  reachable / slow) that the pages wait out. */
export interface Problem { problem: string; obsSource?: string | null; obsKind?: string | null; setup?: boolean }
/** Pure: an OBS request error that says the thing isn't there (vs. OBS being slow / not connected). */
export const notThere = (msg: string) => !/timed out|not connected|connection|closed|did not answer/i.test(msg);
/** Pure: an OBS connection error that only a setting fixes (the password). */
export const authProblem = (msg: string) => /password|4009|auth/i.test(msg);

/** What resolveTarget needs from the OBS side (server/obs.ts `obs`; tests pass a stand-in). */
export interface ObsReader {
  cfg: { captureSource: string };
  /** VTube Pro may read OBS: a password is saved (or the automation is on). */
  canRead(): boolean;
  readOnly<T>(fn: (c: ObsClient) => Promise<T>): Promise<T>;
}

/** OBS window setting "title:class:exe" (OBS escapes ':' as #3A and '#' as #22). */
export function parseObsWindow(s: string): { title: string; cls: string; exe: string } | null {
  const p = s.split(':');
  if (p.length < 3) return null;
  const dec = (x: string) => x.replace(/#3A/g, ':').replace(/#22/g, '#');
  return { title: dec(p[0]), cls: dec(p[1]), exe: dec(p.slice(2).join(':')) };
}
/** A gfxcapture regex that is also safe inside an ffmpeg filtergraph: only [A-Za-z0-9 _-] kept, the rest = ".*". */
const rx = (s: string) => `^${s.replace(/[^A-Za-z0-9 _-]+/g, '.*')}$`;

export function windowTarget(spec: string, label: string, obsSource: string | null, obsKind: string | null): Target | Problem {
  const w = parseObsWindow(spec);
  if (!w || !w.exe) return { problem: `${label}: no window is chosen.`, obsSource, obsKind, setup: true };
  const base = `window_exe=${rx(w.exe)}${w.cls ? `:window_class=${rx(w.cls)}` : ''}`;
  // exact title first; titles change (browser tabs, documents), so then any window of that app (what OBS does too)
  const selectors = w.title ? [`${base}:window_title=${rx(w.title)}`, base] : [base];
  return { selectors, label, obsSource, obsKind, target: `[${w.exe}] ${w.title || '(any window)'}` };
}

/** Display Capture → gfxcapture monitor index, per OBS source + its monitor setting (10 min). */
const monitors = new Map<string, { idx: number; name: string; at: number }>();
const MONITOR_TTL = 10 * 60_000;
/** Tests: forget the cached monitor lookups. */
export function clearMonitorCache() { monitors.clear(); }

export async function resolveTarget(s: CaptureSettings, o: ObsReader): Promise<Target | Problem> {
  if (s.source === 'off') return { problem: 'The fast window feed is off.', setup: true };
  if (s.source === 'window') return windowTarget(s.window, 'Picked window', null, null);
  if (!o.canRead()) return { problem: 'VTube Pro isn’t connected to OBS yet, so it can’t see which window your OBS capture shows. Connect OBS once (VTube Pro’s OBS page → Find it for me), or pick a window here.', setup: true };
  const src = o.cfg.captureSource;
  if (!src) return { problem: 'No OBS capture source is set (Scene tab → OBS automation → Capture source), or pick a window here.', setup: true };
  try {
    return await o.readOnly(async (cl): Promise<Target | Problem> => {
      let r: { inputKind: string; inputSettings: Record<string, unknown> };
      try { r = await cl.request('GetInputSettings', { inputName: src }); }
      catch (e) {
        const msg = (e as Error)?.message ?? '';
        // (OBS answered "no such source" = a name to fix; a time-out / dropped connection = ask again)
        return notThere(msg)
          ? { problem: `OBS has no source called “${src}”. Check the name in Scene tab → OBS automation.`, obsSource: src, setup: true }
          : { problem: `OBS didn’t answer about “${src}” (${msg}). VTube Pro asks again in a few seconds.`, obsSource: src };
      }
      const kind = r.inputKind, set = r.inputSettings ?? {};
      if (kind === 'window_capture' || (kind === 'game_capture' && set.capture_mode === 'window')) {
        if (!set.window) return { problem: `OBS “${src}” has no window chosen (OBS → the source → Properties → Window).`, obsSource: src, obsKind: kind, setup: true };
        return windowTarget(String(set.window), `OBS “${src}”`, src, kind);
      }
      if (kind === 'game_capture') return { problem: `OBS “${src}” is a Game Capture in “${String(set.capture_mode ?? 'any fullscreen')}” mode — VTube Pro can only follow a Game Capture set to “Capture specific window”. Use a Window Capture, or pick a window here.`, obsSource: src, obsKind: kind, setup: true };
      if (kind === 'monitor_capture') {
        const mid = typeof set.monitor_id === 'string' ? set.monitor_id : '';
        const key = `${src}|${mid}|${typeof set.monitor === 'number' ? set.monitor : ''}`;
        const label = `OBS “${src}” (whole monitor)`;
        const hit = monitors.get(key);
        if (hit && Date.now() - hit.at < MONITOR_TTL) return { selectors: [`monitor_idx=${hit.idx}`], label, obsSource: src, obsKind: kind, target: hit.name, size: sizeInName(hit.name) };
        // gfxcapture's monitor index follows the same order as OBS's monitor list (asked once, with time to answer)
        const items = await cl.request<{ propertyItems: { itemName: string; itemValue: unknown }[] }>('GetInputPropertiesListPropertyItems', { inputName: src, propertyName: 'monitor_id' }, 10_000)
          .then((x) => x.propertyItems ?? []).catch(() => null);
        let idx = items && mid ? items.findIndex((i) => i.itemValue === mid) : -1;
        if (idx < 0 && typeof set.monitor === 'number') idx = set.monitor;            // older OBS: a plain index
        if (idx < 0 && !mid && items) idx = 0;                                         // never picked: OBS shows its first monitor
        if (idx < 0) return items === null
          ? { problem: `OBS didn’t say which monitor “${src}” shows (it took too long to answer). VTube Pro asks again in a few seconds.`, obsSource: src, obsKind: kind }
          : { problem: `OBS “${src}” is set to a monitor that isn’t in OBS’s monitor list any more — open its Properties in OBS and pick the monitor again (or pick a window here).`, obsSource: src, obsKind: kind, setup: true };
        const name = items?.[idx]?.itemName ?? `monitor ${idx + 1}`;
        monitors.set(key, { idx, name, at: Date.now() });
        return { selectors: [`monitor_idx=${idx}`], label, obsSource: src, obsKind: kind, target: name, size: sizeInName(name) };
      }
      return { problem: `OBS “${src}” is a ${kind}, not a Window / Display Capture.`, obsSource: src, obsKind: kind, setup: true };
    });
  } catch (e) {
    const msg = (e as Error).message;
    // a wrong / missing password only changes when the performer fixes it; OBS closed or busy comes back by itself
    return authProblem(msg)
      ? { problem: `OBS didn’t accept VTube Pro’s connection (${msg}). Open VTube Pro’s OBS page → Find it for me.`, setup: true }
      : { problem: `Can’t reach OBS (${msg}). Is OBS open with its WebSocket server on?` };
  }
}

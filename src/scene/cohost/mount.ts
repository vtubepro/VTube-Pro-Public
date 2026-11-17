// beta.16 "cohost" lane entry (docs/b16/LANES.md): the AI co-host on the chat buddy (docs/b16/COHOST.md).
//   OBS / preview page ('output'): plays each `cohost-line` the helper sends: the buddy's mouth, a hop, the caption. Silent.
//   studio page ('studio'): registers the "AI co-host" screen under Live > Stream extras, and, only while the co-host is ON and
//                           not muted, tells the helper when the streamer is talking, so the co-host waits for a quiet moment.
// Nothing runs per frame: a bus listener, and (studio, co-host on) one 250 ms mic-level check that stops when it is switched off.
import type { B16Ctx } from '../../b16/mount.ts';
import { registerB16Panel } from '../../b16/panels.ts';
import { sanitizeLine } from '../../../server/cohost/config.ts';
import { CohostPlayer } from './player.ts';

const SPEAKING_ON = 0.08;
const SPEAKING_OFF_MS = 700;
const POLL_MS = 250;

/** Studio only: keep the helper told whether the streamer is talking. `level` reads the mic (0..1); `post` sends the change. */
export function speakingReporter(level: () => number, post: (speaking: boolean) => void, now: () => number = Date.now) {
  let timer = 0, speaking = false, lastLoud = 0;
  const step = () => {
    const t = now();
    if (level() > SPEAKING_ON) lastLoud = t;
    const s = t - lastLoud < SPEAKING_OFF_MS && lastLoud > 0;
    if (s !== speaking) { speaking = s; post(s); }
  };
  return {
    start() { if (!timer) timer = window.setInterval(step, POLL_MS); },
    stop() { if (timer) { clearInterval(timer); timer = 0; } if (speaking) { speaking = false; post(false); } },
    step,
    get running() { return !!timer; },
  };
}

export function mount(ctx: B16Ctx): void | (() => void) {
  const undo: (() => void)[] = [];
  const player = ctx.role === 'output' ? new CohostPlayer() : null;
  const observer = (() => { try { return new URLSearchParams(location.search).has('observer'); } catch { return false; } })();
  const app = ctx.app;
  const reporter = ctx.role === 'studio' && !observer && app
    ? speakingReporter(() => (app.audio.active ? app.audio.last.level ?? 0 : 0), (speaking) => {
      void fetch('/api/cohost/host-speaking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speaking }) }).catch(() => { /* VTube Pro is busy: the next change will tell it */ });
    })
    : null;
  const follow = (s: { on?: boolean; muted?: boolean }) => { if (!reporter) return; if (s.on && !s.muted) reporter.start(); else reporter.stop(); };

  undo.push(ctx.bus.on((m) => {
    if (m.type !== 'command') return;
    if (m.command === 'cohost-line' && player) { const l = sanitizeLine(m.args); if (l) player.play(l); }
    else if (m.command === 'cohost-state') { const a = (m.args ?? {}) as { on?: unknown; muted?: unknown }; if (player && (a.on !== true || a.muted === true)) player.stop(); follow({ on: a.on === true, muted: a.muted === true }); }
  }));

  if (ctx.role === 'studio' && !observer) {   // (an observer studio is a read-only sandbox: it gets no settings screen)
    undo.push(registerB16Panel({
      id: 'cohost', title: 'AI co-host', lane: 'cohost', simple: true, order: 40,
      blurb: 'Your chat buddy answers chat out loud, in character. Off until you turn it on.',
      mount(host) {
        let handle: { destroy(): void } | null = null, gone = false;
        void import('../../ui/cohostPanel.ts').then((m) => { if (!gone) handle = m.mountCohostPanel(host, { onState: follow, buddy: app ? { isOn: () => !!app.scene.state.chat?.buddy, turnOn: () => app.scene.setChat({ buddy: true }) } : undefined }); });
        return { destroy() { gone = true; handle?.destroy(); } };
      },
    }));
    // learn whether it is on without the panel being open (an older version has no route: stay quiet)
    void fetch('/api/cohost/state').then((r) => (r.ok ? r.json() : null)).then((j: { config?: { on?: boolean }; state?: { muted?: boolean } } | null) => { if (j?.config) follow({ on: !!j.config.on, muted: !!j.state?.muted }); }).catch(() => { /* no co-host on VTube Pro */ });
  }
  return () => { for (const u of undo.splice(0)) u(); player?.stop(); reporter?.stop(); };
}

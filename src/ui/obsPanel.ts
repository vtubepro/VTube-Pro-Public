// Scene tab → "OBS automation (optional)": obs-websocket v5 settings for server/obs.ts. Off by default; the
// password is sent once to this PC's server (config/obs.json) and never shown or broadcast again.
import type { ObsProbe, ObsPublic, ObsTestReport, ObsUpdate } from '../../shared/obs.ts';
import { button, clear, h, rerender, section, toast, toggle } from './dom.ts';

const j = async <T>(r: Response) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<T>; };

export function obsSection(observer: boolean): HTMLElement {
  const box = h('div');
  const status = h('p', { class: 'note' }, 'Checking…');
  // live status: hint (why nothing happens), setup warnings, last placement, the recent log — refreshed every 3 s
  const live = h('div');
  const testOut = h('div', { class: 'note' });
  const paint = (c: ObsPublic) => {
    const s = c.status;
    const canRead = c.canRead ?? c.hasPassword;
    status.textContent = !c.enabled
      ? `Off — VTube Pro won’t move your capture or switch OBS scenes.${canRead ? ' (The in-scene window feed still follows your OBS capture source — it works with this off.)' : ' (For the in-scene window feed to follow your OBS capture source, connect OBS once: VTube Pro’s OBS page → Find it for me.)'}`
      : s.error ? `⚠ ${s.error}` : s.connected ? `● connected${s.version ? ` (obs-websocket ${s.version})` : ''}${s.lastAction ? ` · last: ${s.lastAction}` : ''}${s.fit ? ` · fit: ${s.fit}` : ''}`
      : 'On — connects when it’s needed. It only moves your Window Capture for OBS passthrough and switches scenes; the in-scene window feed works with this on or off.';
    clear(live);
    const warnStyle = 'color:var(--warn,#e0a030)';
    // (setup warnings show with the automation off too: a whole-monitor Display Capture or a stray browser source also
    // matter for the in-scene window feed)
    for (const w of s.warnings ?? []) live.append(h('p', { class: 'note', style: warnStyle }, '⚠ ', w));
    if (!c.enabled) return;
    if (s.hint) live.prepend(h('p', { class: 'note', style: warnStyle }, '⚠ ', s.hint));
    live.append(h('p', { class: 'note' },
      `Hole reports from OBS pages: ${s.reports ?? 0}`, s.at ? ` · last action ${new Date(s.at).toLocaleTimeString()}` : '', s.placed ? h('span', null, h('br'), `Capture placed at ${s.placed}`) : ''));
    const log = (c.log ?? []).slice(-12).reverse();
    if (log.length) {
      const colour = { info: '', ok: 'color:var(--ok,#4caf50)', warn: warnStyle, err: 'color:var(--err,#e05050)' } as const;
      live.append(h('details', null, h('summary', null, `Automation log (${c.log?.length ?? 0})`),
        h('div', { style: 'font-size:11px;max-height:180px;overflow:auto' }, ...log.map((e) => h('div', { style: colour[e.level] }, `${new Date(e.at).toLocaleTimeString()} · ${e.msg}`)))));
    }
  };
  const refresh = () => { if (!box.isConnected) { clearInterval(poll); return; } if (document.hidden) return; /* a hidden / covered studio (a game in front) asks nothing */ fetch('/api/obs').then((r) => j<ObsPublic>(r)).then(paint).catch(() => {}); };
  const poll = setInterval(refresh, 3000);
  const render = (c: ObsPublic) => rerender(box, () => {
    const draft: ObsUpdate = {};
    const text = (label: string, key: 'url' | 'captureSource' | 'browserSource' | 'sceneName' | 'talkScene' | 'reactScene', hint: string, list?: string) => {
      const inp = h('input', { type: 'text', value: c[key], placeholder: hint, disabled: observer, style: 'width:100%', onChange: (e: Event) => { draft[key] = (e.target as HTMLInputElement).value.trim(); } }) as HTMLInputElement;
      if (list) inp.setAttribute('list', list);
      return h('label', { class: 'row', title: hint }, h('span', { class: 'lbl' }, label), inp);
    };
    const pw = h('input', { type: 'password', placeholder: c.hasPassword ? '•••••• saved (type to change)' : 'OBS → Tools → WebSocket Server Settings', disabled: observer, autocomplete: 'off', style: 'width:100%', onChange: (e: Event) => { draft.password = (e.target as HTMLInputElement).value; } }) as HTMLInputElement;
    const sceneList = h('datalist', { id: 'vtp-obs-scenes' }), inputList = h('datalist', { id: 'vtp-obs-inputs' });
    const probeOut = h('p', { class: 'note' });
    const save = async (extra: ObsUpdate = {}) => {
      if (observer) { toast('Observer: OBS settings are not saved', 'warn'); return; }
      try {
        const v = await fetch('/api/obs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, ...extra }) }).then((r) => j<ObsPublic>(r));
        pw.value = '';
        render(v); toast('OBS automation saved', 'ok');
      } catch (e) { toast(`Save failed: ${(e as Error).message}`, 'err'); }
    };
    box.append(
      toggle('Automate OBS', c.enabled, (v) => void save({ enabled: v }), 'Moves your Window Capture onto the React screen (OBS passthrough — only when it can line up exactly) and switches OBS scenes. Off by default. Needs OBS 28+ with its WebSocket server enabled. The in-scene window feed only needs the password below, not this switch.'),
      text('WebSocket URL', 'url', 'ws://127.0.0.1:4455'),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Password'), pw),
      text('Window Capture', 'captureSource', 'the source to line up with the screen', 'vtp-obs-inputs'),
      text('Browser source', 'browserSource', 'optional: if it doesn’t fill the canvas', 'vtp-obs-inputs'),
      text('OBS scene', 'sceneName', 'optional: scene holding the capture (default: current)', 'vtp-obs-scenes'),
      toggle('Switch OBS scenes', c.switchScenes, (v) => { draft.switchScenes = v; }, 'Change the OBS program scene with Talk / React'),
      toggle('Perspective corner-pin', c.cornerPin, (v) => { draft.cornerPin = v; }, 'Passthrough only: warps the Window Capture onto an angled screen\u2019s exact corners. Needs the free obs-shaderfilter plugin (by exeldro) installed in OBS — VTube Pro adds a filter named “VTube Pro corner pin” to the capture. Without it, an angled screen is never covered with a box that doesn’t fit: it is drawn in the room instead, with your window from the fast window feed (NO SIGNAL if the feed can’t run).'),
      text('Talk scene', 'talkScene', 'OBS scene for Talk', 'vtp-obs-scenes'),
      text('React scene', 'reactScene', 'OBS scene for React', 'vtp-obs-scenes'),
      sceneList, inputList,
      h('div', { class: 'btns tight' },
        button('Save', () => void save(), 'primary'),
        button('Test OBS automation', async () => {
          testOut.textContent = 'Testing… (places the capture once, then restores it)';
          try {
            const r = await fetch('/api/obs/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((x) => j<ObsTestReport>(x));
            clear(testOut);
            testOut.append(h('b', null, r.ok ? '✔ Test passed' : `✕ Test failed${r.error ? `: ${r.error}` : ''}`), ...r.steps.map((s) => h('div', null, '· ', s)));
            refresh();
          } catch (e) { testOut.textContent = `✕ ${(e as Error).message}`; }
        }),
        button('Test connection', async () => {
          probeOut.textContent = 'Connecting…';
          const body = observer ? {} : { url: draft.url, password: draft.password };
          try {
            const p = await fetch('/api/obs/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<ObsProbe>(r));
            if (!p.ok) { probeOut.textContent = `✕ ${p.error}`; return; }
            clear(sceneList); clear(inputList);
            for (const s of p.scenes ?? []) sceneList.append(h('option', { value: s }));
            for (const i of p.inputs ?? []) inputList.append(h('option', { value: i.name }, i.kind));
            probeOut.textContent = `✔ obs-websocket ${p.version ?? ''} · canvas ${p.canvas?.width}×${p.canvas?.height} · program “${p.current ?? '?'}” · ${p.scenes?.length ?? 0} scenes, ${p.inputs?.length ?? 0} sources (pick them above) · obs-shaderfilter: ${p.shaderFilter ? 'installed ✔ (corner-pin available)' : 'not installed (angled screens are drawn in the room instead of passthrough)'}`;
          } catch (e) { probeOut.textContent = `✕ ${(e as Error).message}`; }
        })),
      probeOut, testOut,
      h('p', { class: 'note' }, 'When on: as the React hole finishes opening, the Window Capture is moved + sized onto it (and shown); it hides again once the hole closes, and goes back to where you had it when you leave React. It is only shown when it can match the screen exactly — a screen at an angle (without the corner-pin) or out of the camera’s shot is drawn in the room instead, never as a crooked box. The OBS canvas size is read from OBS, so the numbers always match. The password stays in config/obs.json on this PC.'),
    );
    paint(c);
  });
  fetch('/api/obs').then((r) => j<ObsPublic>(r)).then(render).catch(() => { status.textContent = 'OBS automation unavailable (server not updated yet?)'; });
  return section('OBS automation (optional)', status, live, box);
}

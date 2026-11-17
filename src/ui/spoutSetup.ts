// Multiplayer → How you appear → "Spout2 (VSeeFace / VTube Studio / Warudo …)": a model rendered by another app that
// shares it over Spout2. Two routes, both first-class (shared/spout.ts; docs/MULTIPLAYER_DISCORD.md → "Spout2 performers"):
//   * Real alpha (this PC): VTube Pro's own receiver (server/spout.ts) lists the Spout senders; pick one → the model
//     arrives with its transparency (no key, no green fringe) and can STAND in the room (look 'standee').
//   * Webcam bridge: SpoutCam / OBS Virtual Camera → a camera + a colour key matched to the app's solid background.
// Health (fps, alpha on / off, the picture size) is shown live under the controls.
import type { App } from '../app.ts';
import { SPOUT_APPS, SPOUT_BRIDGE_KEY, spoutHealth, type SpoutStatus } from '../../shared/spout.ts';
import { TV_HEIGHT, type TvChroma } from '../../shared/tv.ts';
import type { TvSourceSettings } from '../net/tv/tvSource.ts';
import { spoutStatus } from '../net/tv/spoutSource.ts';
import { button, h, select, slider, toggle } from './dom.ts';

const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

let status: SpoutStatus | null = null;
let statusAt = 0;
let appId = 'vseeface';

export interface SpoutUi {
  app: App;
  set: (patch: Partial<TvSourceSettings>) => void;
  start: (patch?: Partial<TvSourceSettings>) => Promise<void>;
  draw: () => void;
  cams: { id: string; label: string; virtual: boolean; bridge: boolean }[];
  refreshDevices: () => Promise<void>;
}

/** Ask the server who is sending (at most every 2 s; the panel redraws when it arrives). */
function refreshStatus(draw: () => void, force = false) {
  if (!force && Date.now() - statusAt < 2000) return;
  statusAt = Date.now();
  void spoutStatus().then((s) => { status = s; draw(); });
}

/** The Spout2 part of "How you appear" (added to `add`). */
export function spoutSection(u: SpoutUi, add: (...n: (Node | string | null | false | undefined)[]) => void) {
  const T = u.app.party.tv;
  const s = T.source.settings;
  const native = s.via === 'spout';
  const rx = T.source.spoutRx;
  add(h('div', { class: 'note', style: 'margin:6px 0 2px' }, h('b', null, 'How your model gets here')),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('button', { class: `btn ${native ? 'primary' : ''}`, title: 'VTube Pro reads the Spout2 picture itself, transparency included (this PC only)', onClick: () => { u.set({ via: 'spout', input: 'spout', chroma: null, look: s.look === 'tv' ? 'standee' : s.look }); refreshStatus(u.draw, true); } }, '✨ Real alpha (this PC)'),
      h('button', { class: `btn ${!native ? 'primary' : ''}`, title: 'SpoutCam or OBS Virtual Camera turns the Spout2 picture into a webcam (no transparency: a colour key cuts it out)', onClick: () => u.set({ via: 'bridge', input: 'camera', chroma: s.chroma ?? { ...SPOUT_BRIDGE_KEY.green } }) }, '🎥 Webcam bridge (SpoutCam / OBS)')));

  // ---- which app (instructions follow it)
  add(select('Your app', appId, SPOUT_APPS.map((a): [string, string] => [a.id, a.id === 'other' ? 'Another app' : a.name]), (v) => { appId = v; u.set({ spout: { ...s.spout, app: v === 'other' ? '' : SPOUT_APPS.find((a) => a.id === v)?.name ?? '' } }); }));
  const A = SPOUT_APPS.find((a) => a.id === appId) ?? SPOUT_APPS[0];

  if (native) {
    refreshStatus(u.draw);
    const st = status;
    if (st && !st.available) add(h('p', { class: 'note', style: 'color:#f5c451;margin:4px 0' }, `Real alpha isn’t available here: ${st.reason ?? 'unknown reason'} — use the webcam bridge instead.`));
    const senders = st?.senders ?? [];
    const opts: [string, string][] = [['', senders.length ? '— pick your app’s sender —' : st ? 'No Spout2 senders — is your app’s Spout2 output on?' : 'Looking for Spout2 senders…'],
      ...senders.map((x): [string, string] => [x.name, `${x.name}${x.app && x.app !== x.name ? ` (${x.app})` : ''} · ${x.w}×${x.h}${x.ok ? '' : ' · unsupported format'}`])];
    if (s.spout.sender && !senders.some((x) => x.name === s.spout.sender)) opts.push([s.spout.sender, `${s.spout.sender} (not sending right now)`]);
    add(select('Spout2 sender', s.spout.sender, opts, (v) => void u.start({ input: 'spout', via: 'spout', spout: { ...s.spout, sender: v } })));
    add(h('div', { class: 'btns tight' },
      button(T.source.live ? 'Restart' : 'Start', () => void u.start({ input: 'spout', via: 'spout' }), T.source.live ? '' : 'primary'),
      button('Refresh senders', () => refreshStatus(u.draw, true)),
      T.source.live ? button('Stop', () => { T.source.stop(); T.refresh(); u.draw(); }) : null));
    // health
    if (rx) {
      const x = rx.stats;
      const alpha = x.alpha === 'straight' || x.alpha === 'premultiplied';
      const line = x.state === 'live' ? `${spoutHealth({ native: true, alpha: alpha && !!rx.pack, fps: x.fps })} · ${x.w}×${x.h} → sends ${x.outW}×${x.outH}${x.alpha ? ` · ${x.alpha} alpha` : ''}`
        : x.state === 'waiting' ? `Waiting for “${x.sender}” — start its Spout2 output` : x.state === 'lost' ? `“${x.sender}” stopped sending (paused, closed, or resized) — it comes back by itself` : x.state === 'error' ? x.error : 'Connecting to VTube Pro’s Spout2 receiver…';
      add(h('p', { class: 'note', style: `margin:2px 0;color:${x.state === 'live' ? '#7bd88f' : x.state === 'error' ? '#f57' : '#f5c451'}` }, line));
      if (x.state === 'live' && x.alpha === 'opaque') add(h('p', { class: 'note', style: 'color:#f5c451;margin:2px 0' }, `Your app sends a solid background (no transparency). In ${A.name}: ${A.spout}. Or key the colour below.`));
      if (x.state === 'live' && !rx.pack && x.alpha !== 'opaque') add(h('p', { class: 'note', style: 'color:#f5c451;margin:2px 0' }, 'The host’s VTube Pro is older: your model goes over green and is keyed there (ask them to update for real alpha).'));
      if (x.state === 'live' && x.coverage < 0.01) add(h('p', { class: 'note', style: 'color:#f5c451;margin:2px 0' }, 'The picture is empty (fully transparent) — is the model in view in your app?'));
    } else if (T.source.error) add(h('p', { class: 'note', style: 'margin:2px 0;color:#f57' }, T.source.error));
    add(toggle('Frame my model automatically', s.spout.auto, (v) => u.set({ spout: { ...s.spout, auto: v } }), 'Crops to your model’s outline (only the model travels; a standing model’s feet are the picture’s bottom edge). Off: use the whole picture'));
    if (rx?.stats.alpha === 'opaque') keyControls(u, s, add);
    add(toggle('Show me in my own rooms without a party', s.solo !== false, (v) => u.set({ solo: v }), 'Your Spout2 model replaces your VTube Pro avatar on THIS PC’s OBS pages even when you’re not in a party'));
  } else {
    // ---- bridge: a camera device (labels only — nothing opens until Start)
    const bridges = u.cams.filter((c) => c.bridge);
    const camOpts: [string, string][] = [['', bridges.length ? '— pick SpoutCam / OBS Virtual Camera —' : 'Default camera'], ...u.cams.map((c): [string, string] => [c.id, `${c.bridge ? '🟢 ' : c.virtual ? '· ' : ''}${c.label}`])];
    add(select('Bridge camera', s.input === 'camera' ? s.deviceId : '', camOpts, (v) => void u.start({ input: 'camera', via: 'bridge', deviceId: v }), bridges.length ? `Found: ${bridges.map((b) => b.label).join(', ')}` : 'No SpoutCam / OBS Virtual Camera found yet — see the steps below (names appear after the first camera permission)'));
    add(h('div', { class: 'btns tight' },
      button(T.source.live ? 'Restart camera' : 'Start camera', () => void u.start({ input: 'camera', via: 'bridge' }), T.source.live ? '' : 'primary'),
      button('Refresh list', () => void u.refreshDevices()),
      T.source.live ? button('Stop', () => { T.source.stop(); T.refresh(); u.draw(); }) : null));
    if (T.source.live) add(h('p', { class: 'note', style: 'margin:2px 0;color:#7bd88f' }, `${spoutHealth({ native: false, alpha: false })} · ${T.source.label.slice(0, 60)}`));
    else if (T.source.error) add(h('p', { class: 'note', style: 'margin:2px 0;color:#f57' }, T.source.error));
    keyControls(u, s, add);
  }
  // ---- standing model: its real height
  if (s.look === 'standee') add(slider('Your model’s height', s.height || 1.6, TV_HEIGHT.min, TV_HEIGHT.max, 0.01, (v) => u.set({ height: v }), 'How tall the picture stands in the room (the whole picture: framed to your model when automatic framing is on)', { def: 1.6, unit: ' m' }));

  // ---- 3 steps + honest limits
  add(h('details', { open: !T.source.live }, h('summary', null, native ? `Set up ${A.name} → real alpha (3 steps)` : `Set up ${A.name} → webcam bridge (3 steps)`),
    native
      ? h('ol', { class: 'note', style: 'margin:4px 0 4px 18px;padding:0' },
        h('li', null, `In ${A.name}: ${A.spout}.`),
        h('li', null, 'Click ', h('b', null, 'Refresh senders'), ' here and pick its sender (VTube Pro reads it on this PC — nothing to install).'),
        h('li', null, 'Show me as ', h('b', null, '🧍 Standing in the room'), ' (or a TV / projector). Set your height. Done: parties get your model with its transparency.'))
      : h('ol', { class: 'note', style: 'margin:4px 0 4px 18px;padding:0' },
        h('li', null, `In ${A.name}: ${A.colour}. Turn its Spout2 output on.`),
        h('li', null, h('b', null, 'SpoutCam'), ' (free, from the official Spout project: github.com/leadedge/SpoutCam — run SpoutCamSettings, pick your app’s sender, Register) or OBS (Spout2 source → ', h('b', null, 'Start Virtual Camera'), '). Then Refresh list and pick it here.'),
        h('li', null, 'Keep the key on ', h('b', null, 'Green'), ' (or the colour you picked). Nudge Similarity until the background is gone but hair edges stay.')),
    h('p', { class: 'note', style: 'margin:2px 0' }, native
      ? 'Limits: Windows only; the app and VTube Pro must run on the same GPU (hybrid laptops: set both to the same one in Windows graphics settings); 8-bit output (HDR / 16-bit float Spout isn’t read). Other PCs get your model over the party link at your quality preset — alpha included.'
      : 'Limits: a webcam has no transparency — a colour key can’t keep semi-transparent bits (glass, glow, wispy hair) and a green outfit needs another key colour. Real alpha needs VTube Pro on your PC.')));
}

/** Key colour for a solid-background picture (bridge, or an app sending no alpha). */
function keyControls(u: SpoutUi, s: TvSourceSettings, add: (...n: (Node | string | null | false | undefined)[]) => void) {
  const k = s.chroma;
  const kid = !k ? 'off' : (Object.entries(SPOUT_BRIDGE_KEY).find(([, c]) => hex(c.color) === hex(k.color))?.[0] ?? 'custom');
  add(h('div', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Cut out the background'), ' — one click: the preset matches a pure-colour background'));
  add(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
    ...(['green', 'magenta', 'blue'] as const).map((c) => h('button', { class: `btn ${kid === c ? 'primary' : ''}`, onClick: () => u.set({ chroma: { ...SPOUT_BRIDGE_KEY[c] } }) }, c === 'green' ? '🟩 Green (0, 255, 0)' : c === 'magenta' ? '🟪 Magenta' : '🟦 Blue')),
    h('button', { class: `btn ${kid === 'off' ? 'primary' : ''}`, onClick: () => u.set({ chroma: null }) }, 'Off')));
  if (k) {
    const ck = (patch: Partial<TvChroma>) => u.set({ chroma: { ...k, ...patch } });
    const def = SPOUT_BRIDGE_KEY[kid as 'green'] ?? SPOUT_BRIDGE_KEY.green;
    add(slider('Similarity', k.similarity, 0.05, 0.8, 0.01, (v) => ck({ similarity: v }), 'Higher = more of the background colour is removed (too high eats into the model)', { def: def.similarity, hard: [0.01, 0.9] }));
    add(slider('Spill removal', k.spill, 0, 1, 0.05, (v) => ck({ spill: v }), 'Removes the coloured fringe on hair edges (lower it if your outfit shifts colour)', { def: def.spill }));
  }
}

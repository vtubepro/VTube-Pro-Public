// Track tab: "External tracking" — phones (VTube Studio app / MeowFace, iFacialMocap, Live Link Face), VMC apps and
// VTube Studio API plugins. Everything here talks to /api/external; the listeners live in the server.
//
//   el.append(externalSection(app));
//
// `app` is duck-typed so this module doesn't depend on App internals. If the app exposes any of these,
// the section shows the matching controls:
//   app.trackingSource: 'webcam' | ExternalSourceKind          (current selector value)
//   app.setTrackingSource(kind): void                          (switch source)
//   app.external?.recenter(): void                             (ExternalFaceSource — "Recenter" button)
import { MEOWFACE_NOTE } from '../../shared/phoneNet.ts';
import { EXTRAS_HELP } from '../../shared/helpCatalog.ts';
import { externalApi, type ExternalPatch, type ExternalView, type SourceStatus, type VtsPending, type VtsToken } from '../externalApi.ts';
import { TRACKING_SOURCES, type TrackingSourceChoice } from '../tracking/externalSource.ts';
import { button, clear, h, rerender, row, section, select, toast, toggle } from './dom.ts';

type AppLike = {
  trackingSource?: TrackingSourceChoice;
  setTrackingSource?: (k: TrackingSourceChoice) => void;
  external?: { recenter?: () => void };
};

type Key = 'vtsPhone' | 'ifacialmocap' | 'liveLinkFace' | 'vmc' | 'vtsApi';
const KEYS: Key[] = ['vtsPhone', 'ifacialmocap', 'liveLinkFace', 'vmc', 'vtsApi'];

const INFO: Record<Key, { title: string; how: string }> = {
  vtsPhone: {
    title: 'VTube Studio phone app',
    how: `VTube Studio on iPhone or iPad (turn on "3rd Party PC Clients"; the Android app can't send to other PC apps): enter the phone's IP shown in the app. Phone and PC must be on the same Wi-Fi. Free VTube Studio may stop sending after 5 minutes; its PRO upgrade removes that; your PC's webcam is the free way. (MeowFace uses the same connection. ${MEOWFACE_NOTE})`,
  },
  ifacialmocap: {
    title: 'iFacialMocap / FaceMotion3D',
    how: 'Open iFacialMocap (or FaceMotion3D) on the iPhone and enter the IP it shows. The app streams to this PC on UDP 49983.',
  },
  liveLinkFace: {
    title: 'Live Link Face (iPhone, Epic)',
    how: 'In the free Live Link Face app pick "Live Link (ARKit)", then Settings (gear) → Live Link → Add Target: this PC\'s IP and the port below (default 11111). Keep "Stream Head Rotation" on. Phone and PC must be on the same Wi-Fi.',
  },
  vmc: {
    title: 'VMC protocol (receive)',
    how: 'In VSeeFace, XR Animator, Webcam Motion Capture, Warudo, VNyan…: enable "VMC protocol sender" and point it at this PC\'s IP and the port below.',
  },
  vtsApi: {
    title: 'VTube Studio API (plugins)',
    how: 'Lets VTube Studio plugins (hotkey bots, parameter injectors, Twitch integrations) control VTube Pro. Point them at ws://localhost:8001. Every plugin must be approved below.',
  },
};

const ago = (ms: number | null) => {
  if (ms === null) return 'never';
  const s = (Date.now() - ms) / 1000;
  return s < 1.5 ? 'now' : s < 90 ? `${s.toFixed(0)} s ago` : `${(s / 60).toFixed(0)} min ago`;
};

function statusText(s: SourceStatus): { text: string; color: string } {
  if (!s.enabled) return { text: 'Off', color: 'var(--muted, #888)' };
  if (!s.running) return { text: `Not listening — ${s.lastError ?? 'starting…'}`, color: '#e5484d' };
  const live = s.lastSeen !== null && Date.now() - s.lastSeen < 1000;
  const base = `Listening ${s.bind}:${s.port} · ${s.packetsPerSec} pkt/s · last ${ago(s.lastSeen)}`;
  const extra = s.kind === 'vts-api' ? ` · ${(s.info?.clients as unknown[] | undefined)?.length ?? 0} plugin(s)` : live ? (s.faceFound ? ' · face found' : ' · no face') : '';
  const err = s.lastError ? ` · ${s.lastError}` : '';
  return { text: base + extra + err, color: live ? '#30a46c' : s.lastError ? '#f5a524' : 'var(--muted, #888)' };
}

/** Last server view: a re-rendered Track tab shows it at once (no "Loading…" height jump). */
let cachedView: ExternalView | null = null;

export function externalSection(app: unknown): HTMLElement {
  const a = (app ?? {}) as AppLike;
  const body = h('div');
  const root = section('External tracking', body);
  let view: ExternalView | null = cachedView;
  const statusEls: Partial<Record<Key, HTMLElement>> = {};
  const pendingEl = h('div');
  const tokensEl = h('div');
  const vmcOutEl = h('p', { class: 'note' });
  let lastPendingIds = '';
  let tokenSig = '';

  const put = async (patch: ExternalPatch) => {
    try {
      view = cachedView = await externalApi.update(patch);
      render();
    } catch (e) { toast(`External tracking: ${(e as Error).message}`, 'err'); }
  };

  const text = (value: string, placeholder: string, onSet: (v: string) => void, width = '11em') =>
    h('input', { type: 'text', value, placeholder, spellcheck: false, style: `width:${width}`, onChange: (e: Event) => onSet((e.target as HTMLInputElement).value.trim()) });
  const portIn = (value: number, onSet: (v: number) => void) =>
    h('input', { type: 'number', min: 1, max: 65535, value, style: 'width:6.5em', onChange: (e: Event) => { const v = Math.trunc(Number((e.target as HTMLInputElement).value)); if (v >= 1 && v <= 65535) onSet(v); else toast('Port must be 1–65535', 'warn'); } });

  function source(k: Key) {
    const c = view!.config[k];
    const st = h('p', { class: 'note' });
    statusEls[k] = st;
    const parts: (Node | null)[] = [
      h('h4', { style: 'margin:.8em 0 .2em' }, INFO[k].title),
      toggle('Enabled', c.enabled, (v) => void put({ [k]: { enabled: v } } as ExternalPatch)),
    ];
    if (k === 'vtsPhone') {
      const p = view!.config.vtsPhone;
      parts.push(
        row('Phone IP', text(p.phoneIp, '192.168.1.23', (v) => void put({ vtsPhone: { phoneIp: v } }))),
        row('Listen port', portIn(p.listenPort || 21413, (v) => void put({ vtsPhone: { listenPort: v } })), 'Local UDP port the phone streams to'),
      );
    } else if (k === 'ifacialmocap') {
      const p = view!.config.ifacialmocap;
      parts.push(row('Phone IP', text(p.phoneIp, '192.168.1.23', (v) => void put({ ifacialmocap: { phoneIp: v } }))));
    } else if (k === 'liveLinkFace') {
      const p = view!.config.liveLinkFace;
      parts.push(
        row('Port', portIn(p.port, (v) => void put({ liveLinkFace: { port: v } })), 'Live Link Face default is 11111'),
        row('Phone IP (optional)', text(p.phoneIp, 'any phone', (v) => void put({ liveLinkFace: { phoneIp: v } })), 'Only accept this phone; empty = any'),
      );
    } else if (k === 'vmc') {
      const p = view!.config.vmc;
      parts.push(row('Port', portIn(p.port, (v) => void put({ vmc: { port: v } })), 'VMC default is 39539'));
    } else {
      const p = view!.config.vtsApi;
      parts.push(
        row('Port', portIn(p.port, (v) => void put({ vtsApi: { port: v } })), 'VTube Studio default is 8001'),
        toggle('Allow plugins on other PCs', p.bind === '0.0.0.0', (v) => void put({ vtsApi: { bind: v ? '0.0.0.0' : '127.0.0.1' } }), 'Off = only plugins running on this PC can connect'),
        button('How plugins work', () => void import('./help/helpViewer.ts').then((m) => m.openHelp(EXTRAS_HELP.vts)), 'ghost'),
      );
    }
    if (k === 'vtsPhone' || k === 'ifacialmocap' || k === 'liveLinkFace') {
      const inv = view!.config[k].invert;
      parts.push(h('details', null, h('summary', { class: 'note' }, 'Avatar turns/tilts the wrong way?'),
        toggle('Flip turn (yaw)', inv.yaw, (v) => void put({ [k]: { invert: { yaw: v } } } as ExternalPatch)),
        toggle('Flip nod (pitch)', inv.pitch, (v) => void put({ [k]: { invert: { pitch: v } } } as ExternalPatch)),
        toggle('Flip tilt (roll)', inv.roll, (v) => void put({ [k]: { invert: { roll: v } } } as ExternalPatch)),
      ));
    }
    parts.push(h('p', { class: 'note' }, INFO[k].how), st);
    return parts;
  }

  // statusEls point into the built tree, so always swap it in (reuse: false); scroll / focus / open state stay
  function render() { rerender(body, build, { reuse: false }); }
  function build() {
    if (!view) { body.append(h('p', { class: 'note' }, 'Loading…')); return; }
    const intro = h('p', { class: 'note' },
      'Use a phone or another tracking app instead of (or alongside) the webcam. Everything is off until you enable it.',
      view.lan.length ? ` This PC: ${view.lan.join(', ')}` : '');
    body.append(intro);
    if (a.setTrackingSource) {
      body.append(select<TrackingSourceChoice>('Drive the avatar from', a.trackingSource ?? 'webcam', TRACKING_SOURCES,
        (v) => { a.setTrackingSource!(v); render(); }, 'Which tracker moves the avatar. External sources fall back to the webcam if they go quiet.'));
    }
    if (a.external?.recenter) body.append(h('div', { class: 'btns' }, button('Recenter external tracking', () => { a.external!.recenter!(); toast('Hold still — recentering…'); })));
    for (const k of KEYS) body.append(...source(k).filter(Boolean) as Node[]);

    // VMC sender
    const o = view.config.vmc.out;
    body.append(
      h('h4', { style: 'margin:.8em 0 .2em' }, 'VMC protocol (send)'),
      toggle('Send my tracking over VMC', o.enabled, (v) => void put({ vmc: { out: { enabled: v } } })),
      row('Target host', text(o.host, '127.0.0.1', (v) => void put({ vmc: { out: { host: v } } }))),
      row('Target port', portIn(o.port, (v) => {
        if (v === view!.config.vmc.port && /^(127\.|localhost)/.test(view!.config.vmc.out.host)) { toast('That is VTube Pro\'s own VMC receive port — pick another (e.g. 39540)', 'warn'); return; }
        void put({ vmc: { out: { port: v } } });
      })),
      h('p', { class: 'note' }, 'Streams your face (Perfect-Sync ARKit blendshapes + head) to VSeeFace / Warudo / VNyan / VMagicMirror VMC receivers.'),
      vmcOutEl,
    );

    // VTS plugin approvals
    body.append(h('h4', { style: 'margin:.8em 0 .2em' }, 'VTube Studio plugins'), pendingEl, tokensEl);
    lastPendingIds = '__force__';
    tokenSig = '__force__';
    refreshStatus();
    void refreshLists();
  }

  function refreshStatus() {
    if (!view) return;
    for (const k of KEYS) {
      const el = statusEls[k];
      if (!el) continue;
      const s = statusText(view.status[k]);
      el.textContent = `● ${s.text}`;
      el.style.color = s.color;
    }
    const o = view.status.vmcOut;
    vmcOutEl.textContent = o.enabled ? `Sending to ${o.host}:${o.port} · ${o.sent} packets${o.lastError ? ` · ${o.lastError}` : ''}` : '';
  }

  function renderPending(list: VtsPending[]) {
    clear(pendingEl);
    if (!list.length) return;
    for (const p of list) {
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      pendingEl.append(h('div', { class: 'row', style: 'gap:.5em;align-items:center' },
        p.icon ? h('img', { src: p.icon, width: 32, height: 32, style: 'border-radius:6px' }) : null,
        h('span', { class: 'lbl', style: 'flex:1' }, h('b', null, p.pluginName), ` by ${p.pluginDeveloper} wants to control VTube Pro (${left} s)`),
        button('Allow', () => void externalApi.decide(p.id, true).then(() => { toast(`${p.pluginName} allowed`, 'ok'); void refreshLists(); }).catch((e) => toast((e as Error).message, 'err')), 'primary'),
        button('Deny', () => void externalApi.decide(p.id, false).then(() => void refreshLists()).catch((e) => toast((e as Error).message, 'err')), 'danger'),
      ));
    }
  }

  function renderTokens(list: VtsToken[]) {
    clear(tokensEl);
    if (!list.length) { tokensEl.append(h('p', { class: 'note' }, 'No plugins approved yet.')); return; }
    for (const t of list) {
      tokensEl.append(h('div', { class: 'row', style: 'gap:.5em;align-items:center' },
        h('span', { class: 'lbl', style: 'flex:1' }, h('b', null, t.pluginName), ` by ${t.pluginDeveloper} · approved ${new Date(t.createdAt).toLocaleDateString()}${t.lastUsed ? ` · used ${new Date(t.lastUsed).toLocaleString()}` : ''}`),
        button('Revoke', () => void externalApi.revoke(t.id).then(() => { toast(`${t.pluginName} revoked`, 'ok'); void refreshLists(); }).catch((e) => toast((e as Error).message, 'err')), 'danger'),
      ));
    }
  }

  async function refreshLists() {
    try {
      const [pending, tokens] = await Promise.all([externalApi.pending(), externalApi.tokens()]);
      const ids = pending.map((p) => p.id).join(',');
      if (ids !== lastPendingIds || pending.length) { lastPendingIds = ids; renderPending(pending); }
      const sig = JSON.stringify(tokens);
      if (sig !== tokenSig) { tokenSig = sig; renderTokens(tokens); }
      if (pending.length && !document.hidden) root.classList.add('attention'); else root.classList.remove('attention');
    } catch { /* server restarting */ }
  }

  // poll while the section is on screen
  let alive = true, seen = false, waits = 0;
  const tick = async () => {
    if (!alive) return;
    if (root.isConnected) seen = true;
    else if (seen || ++waits > 5) { alive = false; return; } // removed, or built but never shown
    try {
      const v = await externalApi.get();
      const first = !view;
      const cfgChanged = !view || JSON.stringify(v.config) !== JSON.stringify(view.config);
      view = cachedView = v;
      if (first || (cfgChanged && !root.contains(document.activeElement))) render(); else refreshStatus();
      await refreshLists();
    } catch (e) {
      if (!view) { clear(body); body.append(h('p', { class: 'note' }, `External tracking unavailable: ${(e as Error).message}`)); }
    }
    setTimeout(() => void tick(), 1000);
  };
  render();
  void tick();
  return root;
}

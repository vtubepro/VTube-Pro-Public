// "Two cameras": a second USB webcam next to the main one (src/tracking/multicam/*). A Go Live card with a live
// status light, the step-by-step wizard (role → camera 2 → placement with both live pictures + landmarks →
// look-around calibration → before/after readout) and the Advanced settings. Nothing opens a camera unless the
// performer clicks; the main camera is never touched here.
import type { App } from '../app.ts';
import type { McRole } from '../tracking/multicam/multiCam.ts';
import { CompareMeter, MC_DEFAULTS } from '../tracking/multicam/multiCam.ts';
import type { CameraOption } from '../tracking/camera.ts';
import { button, h, select, slider, toast, toggle } from './dom.ts';
import { add, card, item, live, seg } from './bits.ts';
import { cameraMirror } from './liveOps.ts';
import { wizHead, type WizCtx, type WizDef } from './wizard.ts';

export const ROLES: { id: McRole; icon: string; name: string; blurb: string; place: string[] }[] = [
  { id: 'stereo', icon: '👀', name: 'Stereo (two angles)', blurb: 'Both cameras see your face from different sides. True depth, a steadier head, and your face keeps tracking when one camera can’t see it (hand over your mouth, head turned away).',
    place: ['Put camera 2 about 30–60 cm to the side of the main camera (left or right), same height or a bit lower, turned so your face is in the middle of its picture.',
      'Both cameras must see your WHOLE face (forehead to chin) from where you sit.',
      'Don’t move either camera after calibrating — if you bump one, just calibrate again (15 s).'] },
  { id: 'mouth', icon: '👄', name: 'Close-up mouth', blurb: 'Camera 2 closer and lower, looking up at your mouth: it sees your lips, teeth and tongue better, so M / B / P closures, pucker and lip rolls read more clearly.',
    place: ['Put camera 2 below your monitor or on the desk, 35–50 cm from your face, tilted up at your mouth.',
      'Your whole face should still be in its picture (the face model needs it) — just bigger and from below.',
      'Works right away; calibrating (15 s) lets it also help the head and the rest of the face.'] },
  { id: 'body', icon: '🧍', name: 'Body & hands', blurb: 'A wider camera further back for your body, arms and hands, while the main camera stays tight on your face for the best face tracking.',
    place: ['Put camera 2 behind or above the main camera, 1–2 m from you, so your head, shoulders, arms and hands fit in its picture.',
      'Face it the same way as the main camera (straight at you) — the avatar’s body turns with what camera 2 sees.',
      'The main camera can then be zoomed in / closer on your face.'] },
];
const role = (app: App) => ROLES.find((r) => r.id === app.multicam.settings.role) ?? ROLES[0];

function status(app: App): { state: 'ok' | 'warn' | 'err' | ''; text: string } {
  const m = app.multicam;
  if (!m.settings.on && !m.running) return { state: '', text: m.settings.deviceId ? `Off · ${m.settings.label || 'camera 2'}` : 'Not set up' };
  if (m.state === 'error') return { state: 'err', text: m.error || 'Camera 2 failed' };
  if (m.state === 'starting') return { state: 'warn', text: 'Starting camera 2…' };
  if (m.state === 'dropped') return { state: 'warn', text: `${m.error || 'Camera 2 dropped'} — using the main camera alone, retrying…` };
  if (m.state === 'off') return { state: 'warn', text: app.trackingOn ? 'Camera 2 is off' : 'Waiting for the main camera' };
  const s = m.stats;
  const mode = s.mode === 'stereo' ? `stereo · ${Math.round(s.fps)} Hz · ${Math.round(s.ageMs)} ms` : s.mode === 'B-only' ? 'main camera lost you — camera 2 is carrying your face' : s.mode === 'body' ? `body & hands from camera 2 · ${Math.round(s.fps)} Hz` : s.mode.startsWith('mouth') ? `mouth from camera 2 · ${Math.round(s.fps)} Hz` : s.mode;
  return { state: s.mode.startsWith('mono') ? 'warn' : 'ok', text: `${m.cam?.label ?? 'camera 2'} · ${mode}${s.faceB || m.settings.role === 'body' ? '' : ' · no face in camera 2'}` };
}

/** Go Live → card. */
export function multicamCard(app: App, openWizard: () => void, refresh: () => void): HTMLElement {
  const light = h('div');
  const paint = () => { const s = status(app); light.replaceChildren(item(s.state, role(app).icon, app.multicam.settings.on ? `Two cameras: ${role(app).name}` : 'Two cameras', s.text,
    app.multicam.settings.on ? button('Turn off', () => { app.multicam.set({ on: false }); app.stopCamera2(); refresh(); }, 'ghost') : null)); };
  paint();
  live(() => { if (!light.isConnected) return false; paint(); return true; });
  const m = app.multicam;
  return card('📷📷 Second webcam', null, light, h('div', { class: 's-row', style: 'margin-top:8px' },
    button(m.settings.deviceId ? 'Change two-camera set-up' : 'Use two webcams', openWizard, m.settings.deviceId ? '' : 'primary'),
    m.settings.deviceId && !m.settings.on ? button('Turn on', async () => { m.set({ on: true }); if (app.trackingOn && !m.running) await app.startCamera2(); refresh(); }, 'ghost') : null));
}

/** Two live pictures (main + camera 2) with the face landmarks drawn on top. */
function camPair(app: App, ctx: WizCtx) {
  const box = (label: string, v: HTMLVideoElement | null, which: 'A' | 'B') => {
    const c = h('canvas', { width: 640, height: 360 }) as HTMLCanvasElement;
    const el = h('div', { class: 'wiz-cam' }, v ?? h('div', { class: 'off' }, which === 'A' ? 'Turn the main camera on (Tracking).' : 'Camera 2 shows up here once it’s on.'), c,
      h('span', { style: 'position:absolute;left:8px;top:6px;font-size:11px;background:#000a;color:#fff;padding:2px 6px;border-radius:6px' }, label));
    const draw = () => {
      if (!c.isConnected) return;
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      const r = which === 'A' ? app.multicam.lastA : app.multicam.lastB;
      const lm = r?.face?.faceLandmarks?.[0];
      if (lm) { g.fillStyle = which === 'A' ? '#39ff14' : '#4cc9f0'; for (let i = 0; i < lm.length; i += 4) g.fillRect(lm[i].x * c.width - 1, lm[i].y * c.height - 1, 2, 2); }
      const pl = r?.pose?.landmarks?.[0];
      if (pl && which === 'B') { g.fillStyle = '#ff3fa4'; for (const p of pl) if ((p.visibility ?? 1) > 0.5) g.fillRect(p.x * c.width - 3, p.y * c.height - 3, 6, 6); }
      setTimeout(() => requestAnimationFrame(draw), 66);
    };
    requestAnimationFrame(draw);
    return el;
  };
  let va = ctx.data.va as HTMLVideoElement | undefined;
  if (app.trackingOn && (!va || va.srcObject !== app.video.video.srcObject)) { va = cameraMirror(app); ctx.data.va = va; }
  let vb = ctx.data.vb as HTMLVideoElement | undefined;
  const vB = app.multicam.video.video, srcB = vB.srcObject, urlB = srcB ? '' : vB.currentSrc || vB.src;
  const haveB = app.multicam.running && (!!srcB || !!urlB);
  if (haveB && (!vb || (srcB ? vb.srcObject !== srcB : vb.src !== urlB))) {
    vb = h('video', { muted: true, autoplay: true, playsInline: true, loop: true }) as HTMLVideoElement;
    if (srcB) vb.srcObject = srcB; else { vb.src = urlB; vb.currentTime = vB.currentTime; }
    void vb.play().catch(() => {}); ctx.data.vb = vb;
  }
  return h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' }, box('1 · main camera', app.trackingOn ? va! : null, 'A'), box('2 · second camera', haveB ? vb! : null, 'B'));
}

function statusLine(app: App) {
  const el = h('div', { class: 'wiz-checks', 'aria-live': 'polite' });
  const paint = () => {
    const m = app.multicam, s = status(app);
    const faceA = !!m.lastA?.face, faceB = !!m.lastB?.face;
    const rows: [string, string, string][] = [
      [app.trackingOn ? (faceA ? 'ok' : 'warn') : 'err', 'Main camera', app.trackingOn ? (faceA ? 'sees your face' : 'no face found') : 'off — turn it on in Tracking first'],
      [m.running ? (m.settings.role === 'body' ? (m.lastB?.pose ? 'ok' : 'warn') : faceB ? 'ok' : 'warn') : '', 'Camera 2', m.running ? (m.settings.role === 'body' ? (m.lastB?.pose ? 'sees your body' : 'can’t see your body yet') : faceB ? `sees your face · ${Math.round(m.stats.fps)} results/s · ${m.stats.ms.toFixed(1)} ms` : 'no face found — aim it at you') : s.text],
    ];
    el.replaceChildren(...rows.map(([st, t, d]) => h('div', { class: `wiz-check ${st}` }, h('span', { class: 'ic' }, st === 'ok' ? '✓' : st ? '!' : '·'), h('div', null, h('b', null, t), h('span', null, d)))));
  };
  paint();
  live(() => { if (!el.isConnected) return false; paint(); return true; });
  return el;
}

/** The wizard. */
export function multicamWizard(app: App): WizDef {
  const m = app.multicam;
  return {
    id: 'multicam', title: 'Use two webcams', blurb: 'A second USB webcam for sharper face capture, a close-up of your mouth, or your body and hands.',
    steps: [
      {
        id: 'role', title: 'What for',
        render: (ctx, el) => add(el, ...wizHead('What should camera 2 do?', 'Any second USB webcam works (a Logitech next to your Elgato is perfect). You can change this later.'),
          h('div', { class: 'wiz-choice', style: 'grid-template-columns:repeat(3,1fr)' }, ...ROLES.map((r) => h('button', { class: `wiz-opt ${m.settings.role === r.id ? 'on' : ''}`, onClick: () => { m.set({ role: r.id }); if (m.running) void app.startCamera2(); ctx.next(); } },
            h('b', null, `${r.icon} ${r.name}`), h('span', null, r.blurb)))),
          h('p', { class: 'note', style: 'margin-top:12px' }, 'Your main camera keeps doing its job; if camera 2 is unplugged or can’t see you, VTube Pro quietly carries on with the main camera alone.')),
      },
      {
        id: 'camera', title: 'Camera 2',
        render: (ctx, el) => {
          const list = ctx.data.cams as CameraOption[] | undefined;
          const mainId = app.mainCam?.deviceId ?? '';
          if (!list) void m.candidates(mainId).then((c) => { ctx.data.cams = c; ctx.refresh(); });
          const cur = (ctx.data.cam as string | undefined) ?? (list?.find((c) => c.deviceId === m.settings.deviceId) ?? list?.find((c) => /logi|c9\d\d|brio|streamcam/i.test(c.label)) ?? list?.[0])?.deviceId;
          const sel = h('select', { 'aria-label': 'Camera 2', onChange: (e: Event) => { ctx.data.cam = (e.target as HTMLSelectElement).value; } },
            ...(list?.length ? list.map((c) => h('option', { value: c.deviceId, selected: c.deviceId === cur }, c.label || 'Camera')) : [h('option', null, list ? 'No second camera found — plug one in' : 'Looking for cameras…')]));
          add(el, ...wizHead('Pick camera 2', 'The main camera stays as it is. Pick the other webcam here.'),
            !app.trackingOn ? h('div', { class: 's-banner warn' }, 'Turn your main camera on first (Tracking → Start camera & mic), then come back.') : null,
            h('div', { class: 'wiz-cols', style: 'grid-template-columns:1fr;gap:12px' }, camPair(app, ctx), h('div', null,
              h('label', { class: 's-field' }, h('span', null, 'Camera 2'), sel),
              h('div', { class: 's-field' }, h('span', null, 'Picture'), seg<string>([['480', '480p', 'lightest'], ['720', '720p', 'recommended'], ['1080', '1080p', 'USB 3 only']], String(m.settings.res), (v) => { m.set({ res: Number(v) as 480 | 720 | 1080 }); ctx.refresh(); })),
              h('div', { class: 's-row', style: 'margin-top:10px' },
                button(m.running ? 'Use this camera' : '📷 Turn on camera 2', async () => {
                  const id = (ctx.data.cam as string | undefined) ?? sel.value;
                  if (!id || !list?.length) { toast('No second camera found', 'warn'); return; }
                  m.set({ on: true });
                  await app.startCamera2(id);
                  ctx.refresh();
                }, 'primary'),
                m.running ? button('Turn off', () => { app.stopCamera2(); ctx.refresh(); }, 'ghost') : null,
                h('button', { class: 'btn ghost', onClick: () => { ctx.data.cams = undefined; ctx.refresh(); } }, '↻')),
              statusLine(app),
              h('p', { class: 'note' }, 'Two cameras on one USB port can run out of bandwidth: if camera 2 fails to start, try 720p or 480p, or another USB port (a different side of the PC).'))));
        },
        live: (ctx) => { const on = m.running; if (ctx.data.wasOn !== on) { ctx.data.wasOn = on; ctx.refresh(); } },
        blocker: () => (m.running ? null : 'Turn camera 2 on (or skip)'),
      },
      {
        id: 'place', title: 'Placement',
        render: (ctx, el) => add(el, ...wizHead('Place camera 2', role(app).name),
          h('div', { class: 'wiz-cols', style: 'grid-template-columns:1fr;gap:12px' }, camPair(app, ctx), h('div', null,
            h('ol', { class: 's-steps' }, ...role(app).place.map((t) => h('li', null, h('span', null, t)))),
            statusLine(app)))),
      },
      {
        id: 'calib', title: 'Calibrate', hidden: () => m.settings.role === 'body',
        render: (ctx, el) => {
          const bar = h('i', { style: 'width:0%' });
          const hint = h('div', { class: 'note', style: 'margin:6px 0' });
          const res = ctx.data.calRes as string | undefined;
          const c = m.settings.calib;
          live(() => {
            if (!bar.isConnected) return false;
            if (!m.calibrating) return true;
            const p = m.calibProgress();
            bar.style.width = `${Math.round(p.p * 100)}%`;
            hint.textContent = `${p.hint} · ${p.pairs} synced views · turn ${Math.round(p.yawDeg)}° / nod ${Math.round(p.pitchDeg)}°`;
            if (p.p >= 1 && !ctx.data.solving) {
              ctx.data.solving = true;
              hint.textContent = 'Working it out…';
              void m.finishCalibration().then((k) => { ctx.data.calRes = `✓ ${k.grade === 'good' ? 'Great' : k.grade === 'ok' ? 'Good enough' : 'Poor — try again with slower, bigger head turns'} · cameras ${Math.round(k.baselineMm / 10)} cm apart, ${Math.round(k.angleDeg)}° between them · accuracy ${k.rmsPx.toFixed(1)} px · clocks ${Math.round(k.offsetMs)} ms apart${k.notes.length ? ` · ${k.notes.join('; ')}` : ''}`; })
                .catch((e) => { ctx.data.calRes = `✕ ${(e as Error).message}`; })
                .finally(() => { ctx.data.solving = false; ctx.refresh(); });
            }
            return true;
          });
          add(el, ...wizHead('Calibrate (about 15 seconds)', 'VTube Pro works out where the two cameras are from your face — no printouts. Sit normally, then slowly turn your head left and right, and nod up and down, while both cameras can see you.'),
            h('div', { class: 'wiz-cols', style: 'grid-template-columns:1fr;gap:12px' }, camPair(app, ctx), h('div', null,
              statusLine(app),
              h('div', { class: 's-field', style: 'margin-top:10px' }, h('span', null, 'Progress'), h('div', { class: 's-meter' }, bar)), hint,
              h('div', { class: 's-row' },
                button(m.calibrating ? 'Calibrating…' : c ? 'Calibrate again' : '▶ Start calibration', () => {
                  if (!m.running) { toast('Turn camera 2 on first', 'warn'); return; }
                  if (!app.trackingOn) { toast('Turn the main camera on first', 'warn'); return; }
                  ctx.data.calRes = undefined; m.startCalibration(); ctx.refresh();
                }, m.calibrating ? '' : 'primary'),
                m.calibrating ? button('Cancel', () => { m.cancelCalibration(); ctx.refresh(); }, 'ghost') : null),
              res ? h('p', { class: 'note' }, res) : c ? h('p', { class: 'note' }, `Calibrated ${new Date(c.at).toLocaleString()} · ${c.grade} · ${Math.round(c.baselineMm / 10)} cm apart${m.calibrated ? '' : ' — for different cameras: calibrate again'}`) : null,
              m.settings.role === 'mouth' ? h('p', { class: 'note' }, 'Optional for the close-up mouth camera — it already helps the mouth without it.') : null)));
        },
        blocker: () => (m.settings.role === 'stereo' && !m.calibrated ? 'Calibrate first (or skip)' : null),
      },
      {
        id: 'check', title: 'Before / after',
        render: (ctx, el) => {
          const out = h('div', { class: 's-list' });
          const paint = () => {
            const r = (m.compare ?? (ctx.data.lastCompare as CompareMeter | undefined))?.result();
            const s = status(app);
            out.replaceChildren(...[item(s.state, '📡', 'Right now', s.text),
              r?.mono && r.fused ? item(r.fused.rotDeg <= r.mono.rotDeg * 1.02 ? 'ok' : 'warn', '🎯', 'Head wobble (lower is better)', `main camera alone ${r.mono.rotDeg.toFixed(3)}° → with camera 2 ${r.fused.rotDeg.toFixed(3)}°`) : null,
              r?.mono && r.fused ? item(r.fused.lmPx <= r.mono.lmPx * 1.02 ? 'ok' : 'warn', '✨', 'Face-point shimmer (lower is better)', `${r.mono.lmPx.toFixed(2)} px → ${r.fused.lmPx.toFixed(2)} px`) : null,
              r ? item(r.faceFramesFused > r.faceFramesMono ? 'ok' : '', '🙈', 'Frames with your face', `main camera alone ${r.faceFramesMono} → with camera 2 ${r.faceFramesFused} (of ${r.frames})`) : null,
              m.info?.zM ? item('ok', '📏', 'Distance (measured by the two cameras)', `${(m.info.zM * 100).toFixed(0)} cm from the main camera`) : null].filter((x): x is HTMLDivElement => !!x));
          };
          paint();
          live(() => { if (!out.isConnected) return false; paint(); return true; });
          add(el, ...wizHead('Before / after', 'A 12-second test: sit still for a few seconds, talk, then cover your mouth with your hand and turn your head far to the side — watch camera 2 take over.'),
            h('div', { class: 'wiz-cols', style: 'grid-template-columns:1fr;gap:12px' }, camPair(app, ctx), h('div', null,
              h('div', { class: 's-row' }, button(m.compare ? 'Measuring… (click to stop)' : '▶ Start the 12 s test', () => {
                if (m.compare) { ctx.data.lastCompare = m.compare; m.compare = null; ctx.refresh(); return; }
                if (!m.settings.on) m.set({ on: true });
                m.compare = new CompareMeter(12); ctx.refresh();
                setTimeout(() => { if (m.compare) { ctx.data.lastCompare = m.compare; m.compare = null; ctx.refresh(); } }, 12500);
              }, 'primary')), out)));
        },
      },
      {
        id: 'done', title: 'Done',
        render: (ctx, el) => add(el, ...wizHead('Two cameras ready 📷📷', 'It turns on with your main camera from now on. Tracking shows its status; Tracking → Advanced has every setting.'),
          toggle('Use camera 2', m.settings.on, (v) => { m.set({ on: v }); if (v && app.trackingOn && !m.running) void app.startCamera2(); if (!v) app.stopCamera2(); ctx.refresh(); })),
        nextLabel: 'Finish',
      },
    ],
  };
}

/** Go Live → Advanced. */
export function multicamAdvanced(app: App, openWizard: () => void, refresh: () => void): HTMLElement {
  const m = app.multicam, s = m.settings;
  const dbg = h('pre', { class: 'note', style: 'white-space:pre-wrap;font-size:11px;max-height:180px;overflow:auto' });
  live(() => { if (!dbg.isConnected) return false; dbg.textContent = JSON.stringify(m.diag(), null, 1); return true; });
  const restart = () => { if (m.running) void app.startCamera2(); };
  return card('📷📷 Second webcam (advanced)', 'Settings for the two-camera mode. The calibration is saved on this PC for this pair of cameras.',
    toggle('Use camera 2', s.on, (v) => { m.set({ on: v }); if (v && app.trackingOn && !m.running) void app.startCamera2(); if (!v) app.stopCamera2(); refresh(); }),
    select<McRole>('Role', s.role, ROLES.map((r) => [r.id, r.name] as [McRole, string]), (v) => { m.set({ role: v }); restart(); refresh(); }),
    select<string>('Camera 2 picture', String(s.res), [['480', '640×480 (lightest)'], ['720', '1280×720 (recommended)'], ['1080', '1920×1080 (USB 3)']], (v) => { m.set({ res: Number(v) as 480 | 720 | 1080 }); restart(); }, 'Resolution changes need a new calibration only if the picture SHAPE changes (4:3 vs 16:9).'),
    select<string>('Camera 2 frame rate', String(s.fps), [['30', '30 fps'], ['60', '60 fps']], (v) => { m.set({ fps: Number(v) as 30 | 60 }); restart(); }),
    slider('Camera 2 face model rate (per second)', s.hz, 10, 60, 5, (v) => { m.set({ hz: v }); }, 'How often camera 2’s face is analysed. It only runs while the main camera’s face model is idle, so the main camera never waits; lower = less GPU. (Applies when camera 2 restarts.)', (v) => v.toFixed(0), { def: MC_DEFAULTS.hz, unit: '/s' }),
    toggle('Keep my face when only camera 2 sees it', s.bOnly, (v) => { m.set({ bOnly: v }); restart(); }, 'Turned far away from the main camera or a hand over the whole face: the face is carried by camera 2.'),
    h('div', { class: 's-row', style: 'margin:8px 0' },
      button('Open the two-camera wizard', openWizard),
      s.calib ? button('Forget calibration', () => { if (confirm('Forget the two-camera calibration? Stereo stops until you calibrate again.')) { m.forgetCalibration(); refresh(); } }, 'ghost') : null),
    dbg);
}

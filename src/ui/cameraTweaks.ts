// Live camera quick-adjust (docs/ROOM_EDITOR.md → "Live camera sliders"): while the show runs, nudge the angle that is on
// air — orbit left / right, tilt (from higher / lower), distance (dolly in / out), height, lens — with sliders. The tweak is
// remembered FOR THAT ANGLE of this room (the talk shot of a place, the group / wide / React shot, a preset camera) in the
// Room editor's override layer and comes back every time that angle is used. A deliberate live action: each change goes
// to the helper (PUT /api/rooms/<room>/edits/tweak), which sends one message; the OBS pages ease the camera there with the
// normal camera transition (SceneRuntime: the tweak is part of the shot key, so it moves like any camera change).
//
//   mountCameraTweaks(el, app)  → the panel (one mount function; the layout decides where it lives). Returns unmount.
import type { App } from '../app.ts';
import type { SceneState } from '../../shared/types.ts';
import { HOST_KEY, MAX_SPOTS } from '../../shared/scene.ts';
import { TWEAK_LIMITS, ZERO_TWEAK, spotKey, tweakEmpty, type CamTweak, type RoomEdits } from '../../shared/roomEdits.ts';
import { button, h, slider, toast } from './dom.ts';

/** The angle a camera choice is on (the same rule as SceneRuntime.angleNow): talk / solo React at the focus' spot,
 *  group / wide / react, or a preset name. null = not a tweakable angle ("screen"). */
export function angleOf(s: Pick<SceneState, 'camera' | 'focus' | 'spots'>, layout?: 'big' | 'solo' | null): string | null {
  const c = s.camera;
  const i = s.spots[s.focus] ?? s.spots[HOST_KEY];
  const at = i !== undefined && i < MAX_SPOTS ? spotKey(i) : null;
  if (c === 'talk') return at ? `talk:${at}` : null;
  if (c === 'react' && layout === 'solo') return at ? `solo:${at}` : null;
  if (c === 'group' || c === 'wide' || c === 'react') return c;
  return /^CAM_[A-Z0-9_]+$/.test(c) ? c : null;
}
export function angleLabel(a: string, spotLabel: (k: string) => string): string {
  if (a.startsWith('talk:')) return `Talk shot · ${spotLabel(a.slice(5))}`;
  if (a.startsWith('solo:')) return `Solo React · ${spotLabel(a.slice(5))}`;
  if (a === 'group') return 'Group shot';
  if (a === 'wide') return 'Wide shot';
  if (a === 'react') return 'React shot';
  if (/^CAM_MY_\d$/.test(a)) return `My camera ${a.slice(7)}`;
  return a.replace(/^CAM_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase());
}

const LABELS: Record<keyof CamTweak, [string, string, (v: number) => string]> = {
  orbit: ['Direction', 'Swing the camera round the subject (left ← → right)', (v) => `${v > 0 ? '→ ' : v < 0 ? '← ' : ''}${Math.abs(Math.round(v))}°`],
  tilt: ['Tilt', 'From lower (looking up) to higher (looking down)', (v) => `${v > 0 ? '↓ ' : v < 0 ? '↑ ' : ''}${Math.abs(Math.round(v))}°`],
  dolly: ['Distance', 'Dolly in (closer) or out', (v) => `${v > 0 ? 'in ' : v < 0 ? 'out ' : ''}${Math.abs(v).toFixed(2)} m`],
  height: ['Height', 'Raise or lower the camera (keeps looking level)', (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} m`],
  fov: ['Zoom (lens)', 'Narrower = zoom in, wider = zoom out', (v) => (v === 0 ? '0°' : `${v < 0 ? 'in ' : 'out '}${Math.abs(Math.round(v))}°`)],
};
const STEP: Record<keyof CamTweak, number> = { orbit: 1, tilt: 1, dolly: 0.05, height: 0.05, fov: 1 };

export function mountCameraTweaks(el: HTMLElement, app: App): () => void {
  const S = app.scene;
  const box = h('div', { class: 'cam-tweaks' });
  el.append(box);
  let room: string | null = null, angle: string | null = null;
  let tweaks: Record<string, CamTweak> = {};
  let loading: string | null = null;
  let sendT = 0, inflight = false, queued: { room: string; angle: string; t: CamTweak | null } | null = null;

  const load = async (id: string) => {
    loading = id;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(id)}/edits`);
      const j = await r.json() as { edits?: RoomEdits | null };
      if (loading !== id) return;
      tweaks = { ...(j.edits?.camTweaks ?? {}) };
    } catch { tweaks = {}; }
    loading = null;
    draw();
  };
  const flush = async () => {
    if (inflight || !queued) return;
    const q = queued; queued = null; inflight = true;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(q.room)}/edits/tweak`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ angle: q.angle, tweak: q.t }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; toast(j.error ?? `Camera tweak not saved (${r.status})`, 'warn'); }
    } catch { toast('Camera tweak not saved: VTube Pro did not answer.', 'warn'); }
    inflight = false;
    if (queued) void flush();
  };
  /** Sliders send at most ~8 changes a second; the last one always goes. */
  const send = (t: CamTweak | null) => {
    if (!room || !angle) return;
    queued = { room, angle, t };
    clearTimeout(sendT);
    sendT = window.setTimeout(() => void flush(), 120);
  };

  const draw = () => {
    const st = S.effective;
    const sum = st.sceneId ? S.rooms.get(st.sceneId) : null;
    const a = angleOf(st, sum?.layout ?? null);
    const spotLabel = (k: string) => sum?.spots[+k.slice(5) - 1]?.label ?? k.replace('SPOT_', 'Spot ');
    if (!st.sceneId) { box.replaceChildren(h('p', { class: 'muted' }, 'Pick a room to adjust its cameras.')); return; }
    if (!a) { box.replaceChildren(h('p', { class: 'muted' }, 'This shot follows the screen; pick a camera to adjust it.')); return; }
    const t: CamTweak = { ...ZERO_TWEAK, ...(tweaks[a] ?? {}) };
    const set = (k: keyof CamTweak, v: number) => {
      t[k] = v;
      tweaks[a] = { ...t };
      if (tweakEmpty(t)) delete tweaks[a];
      send(tweakEmpty(t) ? null : { ...t });
      reset.disabled = tweakEmpty(t);
    };
    const reset = button('Reset this angle', () => { delete tweaks[a]; send(null); draw(); }, 'ghost');
    reset.disabled = tweakEmpty(t);
    box.replaceChildren(
      h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' }, h('b', null, angleLabel(a, spotLabel)), reset),
      ...(Object.keys(LABELS) as (keyof CamTweak)[]).map((k) => slider(LABELS[k][0], t[k], TWEAK_LIMITS[k][0], TWEAK_LIMITS[k][1], STEP[k], (v) => set(k, v), LABELS[k][1], LABELS[k][2])),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Remembered for this angle in this room; your OBS output eases there with the normal camera transition.'),
    );
  };
  const off = S.on(() => {
    const st = S.effective;
    const sum = st.sceneId ? S.rooms.get(st.sceneId) : null;
    const a = angleOf(st, sum?.layout ?? null);
    if (st.sceneId !== room) { room = st.sceneId; angle = a; tweaks = {}; if (room) void load(room); else draw(); return; }
    if (a !== angle) { angle = a; draw(); }
  });
  room = S.effective.sceneId; angle = angleOf(S.effective, room ? S.rooms.get(room)?.layout ?? null : null);
  if (room) void load(room); else draw();
  // (another page saved edits for this room: the Room editor, another studio tab)
  return () => { off(); clearTimeout(sendT); box.remove(); };
}

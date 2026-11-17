// Multiplayer → "How you appear": my VTube Pro avatar, my webcam on a walking TV, my VTube Studio / Live2D model on
// a walking TV, or a Spout2 model from another app (VSeeFace, Warudo … — src/ui/spoutSetup.ts: real alpha, standing
// in the room). Picks the picture source (camera / virtual camera / a shared window), the TV body, the chroma key and
// the crop, and shows a LIVE PREVIEW of me on that TV (the same body + screen shader every OBS page uses).
// Engine: src/net/tv/* (studio) and src/scene/tv/* (OBS pages). Docs: docs/MULTIPLAYER_DISCORD.md → "TV guests".
import * as THREE from 'three';
import type { App } from '../app.ts';
import { CHROMA_PRESETS, TV_BACKDROPS, TV_PRESETS, TV_SKINS, tvSkin, type TvChroma } from '../../shared/tv.ts';
import { DEFAULT_TV_SETTINGS, listCameras, listMics, type TvSourceSettings } from '../net/tv/tvSource.ts';
import { PageFeeds } from '../scene/tv/tvFeeds.ts';
import { TvRuntime } from '../scene/tv/tvRuntime.ts';
import { ProjectorRuntime } from '../scene/tv/tvProjector.ts';
import { StandeeRuntime } from '../scene/tv/tvStandee.ts';
import { spoutSection } from './spoutSetup.ts';
import { SPOUT_BRIDGE_KEY } from '../../shared/spout.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import { TV_BAG, sanitizeTvBag, type TvBag, type TvLook } from '../../shared/tv.ts';
import { button, h, rerender, select, slider, toast, toggle } from './dom.ts';

const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const unhex = (s: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number];

let cached: HTMLElement | null = null;

/** The section (built once per studio page; the Multiplayer panel re-renders around it). */
export function tvAppearSection(app: App): HTMLElement {
  if (cached) return cached;
  const T = app.party.tv;
  const P = app.party;
  const wrap = h('div', { class: 'tv-appear', style: 'padding:8px 10px;background:#1f2533;border-radius:8px;margin:0 0 10px' });
  const controls = h('div');
  const preview = new TvPreview();
  let cams: { id: string; label: string; virtual: boolean; bridge: boolean }[] = [];
  let mics: { id: string; label: string }[] = [];
  const refreshDevices = async () => { cams = await listCameras(); mics = await listMics(); draw(); };

  const draw = () => rerender(controls, build);
  const set = (patch: Partial<TvSourceSettings>) => { T.source.update(patch); preview.sync(T); draw(); };
  const start = async (patch: Partial<TvSourceSettings> = {}) => {
    T.source.update(patch);
    await T.source.start();
    if (T.source.error) toast(T.source.error, 'err', 6000);
    else { T.setAppear('tv'); void refreshDevices(); }
    preview.sync(T); draw();
  };

  function build() {
    const add = (...n: (Node | string | null | false | undefined)[]) => controls.append(...n.filter((x): x is Node | string => !!x));
    const s = T.source.settings;
    const tvMode = T.appear === 'tv';
    const mode = tvMode ? (s.via ? 'spout' : s.kind) : 'avatar';
    const pick = (v: string) => {
      if (v === 'avatar') { T.setAppear('avatar'); preview.sync(T); draw(); return; }
      if (v === 'spout') {
        // Spout2: real alpha on this PC by default, standing in the room
        const via = s.via || 'spout';
        T.source.update({ kind: 'vts', via, input: via === 'spout' ? 'spout' : 'camera', chroma: via === 'bridge' ? s.chroma ?? { ...SPOUT_BRIDGE_KEY.green } : null, look: s.via ? s.look : 'standee', mirror: false, height: s.via ? s.height : 1.6 });
      } else T.source.update({ kind: v as 'webcam' | 'vts', via: '', ...(s.input === 'spout' ? { input: 'camera' as const } : {}), ...(s.look === 'standee' ? { look: 'tv' as const } : {}), ...(v === 'vts' && !s.chroma ? { chroma: CHROMA_PRESETS.green, bg: 'studio', mirror: false } : {}) });
      T.appear = 'tv';
      if (T.source.live) T.setAppear('tv');
      preview.sync(T); draw();
    };
    add(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px' },
      ...([['avatar', '🧍 My VTube Pro avatar'], ['webcam', '🎥 My webcam'], ['vts', '🎥 VTube Studio'], ['spout', '✨ Spout2 (VSeeFace / VTube Studio / Warudo…)']] as const).map(([v, l]) =>
        h('button', { class: `btn ${mode === v ? 'primary' : ''}`, title: v === 'spout' ? 'A model rendered by another app that outputs Spout2 — with its transparency, standing in the room' : '', onClick: () => pick(v) }, l))));
    if (!tvMode) {
      add(h('p', { class: 'note', style: 'margin:0' }, 'No 3D avatar? Use your webcam (or your VTube Studio model): you appear on a walking TV or on a projector screen that comes down beside the host — on everyone’s OBS.'));
      return;
    }
    // ---- walking TV or projector screen (+ the TV's motion)
    add(h('div', { class: 'note', style: 'margin:2px 0 2px' }, h('b', null, 'Show me as')),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        s.via ? h('button', { class: `btn ${s.look === 'standee' ? 'primary' : ''}`, title: 'Your model itself stands in the room (its transparency cuts it out) and always faces the camera', onClick: () => { set({ look: 'standee' }); preview.rebuild(T); } }, '🧍 Standing in the room') : null,
        h('button', { class: `btn ${s.look === 'tv' ? 'primary' : ''}`, title: 'A little TV on legs that walks in, sits and gestures', onClick: () => { set({ look: 'tv' }); preview.rebuild(T); } }, '🚶 Walking TV'),
        h('button', { class: `btn ${s.look === 'projector' ? 'primary' : ''}`, title: 'A projector screen that comes down beside the host in every room', onClick: () => { set({ look: 'projector' }); preview.rebuild(T); } }, '📽 Projector screen')));
    if (s.look === 'tv') add(select('TV motion', s.motion ?? 'calm', [['calm', 'Calm (subtle)'], ['lively', 'Lively (bouncy)']], (v) => set({ motion: v })));
    const hostLook = P.role === 'guest' ? tvHostLookFor(app) : null;
    if (hostLook && hostLook !== s.look) add(h('p', { class: 'note', style: 'color:#f5c451;margin:2px 0' }, `The host shows you as a ${hostLook === 'projector' ? 'projector screen' : hostLook === 'standee' ? 'model standing in the room' : 'walking TV'} in this party.`));
    const hostOld = P.role === 'guest' && P.members.length > 0 && !P.tvLinks.peers().length;
    if (hostOld) add(h('p', { class: 'note', style: 'color:#f5c451' }, 'The host’s VTube Pro is older and can’t show TV guests yet — ask them to update. You’re in the party without a picture meanwhile.'));
    // ---- Spout2: its own source section (real alpha / bridge), then the shared bits (voice, party note)
    if (s.via) {
      spoutSection({ app, set, start, draw, cams, refreshDevices }, add);
      if (s.look !== 'standee') add(select('Quality', s.preset, TV_PRESETS.map((p): [string, string] => [p.id, p.name]), (v) => set({ preset: v }), 'Lower it if your upload is slow — the host forwards a smaller copy to everyone else anyway'));
      else add(select('Quality', s.preset, TV_PRESETS.map((p): [string, string] => [p.id, p.name]), (v) => set({ preset: v }), 'The picture height sent (a standing model: 720p keeps faces sharp in close-ups)'));
      if (s.look === 'tv') add(h('div', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Your TV')),
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, ...TV_SKINS.map((k) => h('button', { class: `btn ${tvSkin(s.skin).id === k.id ? 'primary' : ''}`, onClick: () => { set({ skin: k.id }); preview.rebuild(T); } }, k.name))));
      if (s.look !== 'standee') add(select('Behind your model', s.bg, TV_BACKDROPS.map((b): [string, string] => [b.id, b.name]), (v) => set({ bg: v })));
      add(toggle('Mirror my picture', s.mirror, (v) => set({ mirror: v }), 'Flip left / right (off = everyone sees you the right way round)'));
      voiceAndNote();
      return;
    }
    // ---- source
    const camOpts: [string, string][] = [['', 'Default camera'], ...cams.map((c): [string, string] => [c.id, `${c.virtual ? '🟢 ' : ''}${c.label}`])];
    add(h('div', { class: 'note', style: 'margin:6px 0 2px' }, h('b', null, s.kind === 'vts' ? 'Where your VTube Studio picture comes from' : 'Your camera')));
    add(select('Camera', s.input === 'camera' ? s.deviceId : '', camOpts, (v) => void start({ input: 'camera', deviceId: v }), s.kind === 'vts' ? 'VTube Studio’s own virtual webcam shows up as “VTubeStudioCam”; OBS’s as “OBS Virtual Camera”' : ''));
    add(h('div', { class: 'btns tight' },
      button(T.source.live ? 'Restart camera' : 'Start camera', () => void start({ input: 'camera' }), T.source.live ? '' : 'primary'),
      s.kind === 'vts' ? button('Share the VTube Studio window instead…', () => void start({ input: 'window' })) : null,
      button('Refresh list', () => void refreshDevices()),
      T.source.live ? button('Stop', () => { T.source.stop(); T.refresh(); preview.sync(T); draw(); }) : null));
    if (T.source.live) add(h('p', { class: 'note', style: 'margin:2px 0;color:#7bd88f' }, `Live: ${T.source.label.length > 60 ? s.input === 'window' ? 'a shared window' : 'camera' : T.source.label} · ${Math.round(T.source.aspect * 100) / 100}:1 picture`));
    else if (T.source.error) add(h('p', { class: 'note', style: 'margin:2px 0;color:#f57' }, T.source.error));
    add(select('Quality', s.preset, TV_PRESETS.map((p): [string, string] => [p.id, p.name]), (v) => set({ preset: v }), 'Lower it if your upload is slow — the host forwards a smaller copy to everyone else anyway'));
    // ---- TV body (the projector uses the room's own screen rig)
    if (s.look !== 'projector') add(h('div', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Your TV')),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, ...TV_SKINS.map((k) => h('button', { class: `btn ${tvSkin(s.skin).id === k.id ? 'primary' : ''}`, title: `${k.height} m${k.height < 0.6 ? ' — tiny: sits on tables / perches' : k.height > 2.6 ? ' — giant: stands at the back' : ''}`, onClick: () => { set({ skin: k.id }); preview.rebuild(T); } }, k.name))));
    add(toggle('Mirror my picture', s.mirror, (v) => set({ mirror: v }), 'Flip left / right on the TV (off = everyone sees you the right way round, text reads correctly)'));
    add(select('Fit', s.fit, [['cover', 'Fill the screen (crop the edges)'], ['contain', 'Whole picture (bars)']], (v) => set({ fit: v })));
    // ---- VTube Studio: chroma key + crop
    if (s.kind === 'vts') {
      const k = s.chroma;
      const kid = !k ? 'off' : (Object.entries(CHROMA_PRESETS).find(([, c]) => hex(c.color) === hex(k.color))?.[0] ?? 'custom');
      add(h('div', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Cut out the background (chroma key)')));
      add(select('Key colour', kid, [['green', 'Green (0, 255, 0)'], ['blue', 'Blue (0, 0, 255)'], ['magenta', 'Magenta'], ['custom', 'Custom colour…'], ['off', 'Off (show the whole picture)']], (v) => {
        if (v === 'off') set({ chroma: null }); else if (v === 'custom') set({ chroma: { ...(k ?? CHROMA_PRESETS.green) } }); else set({ chroma: { ...CHROMA_PRESETS[v as 'green'] } });
      }));
      if (k) {
        const ck = (patch: Partial<TvChroma>) => set({ chroma: { ...k, ...patch } });
        const kd = CHROMA_PRESETS[kid as 'green'] ?? CHROMA_PRESETS.green; // the key colour's preset values: what ↺ restores
        add(h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Colour'), h('input', { type: 'color', value: hex(k.color), onInput: (e: Event) => ck({ color: unhex((e.target as HTMLInputElement).value) }) })));
        add(slider('Similarity', k.similarity, 0.05, 0.8, 0.01, (v) => ck({ similarity: v }), 'Higher = more of the background colour is removed (too high eats into the model)', { def: kd.similarity, hard: [0.01, 0.9] }));
        add(slider('Smoothness', k.smoothness, 0, 0.3, 0.01, (v) => ck({ smoothness: v }), 'Softer edges', { def: kd.smoothness, hard: [0, 0.5] }));
        add(slider('Spill removal', k.spill, 0, 1, 0.05, (v) => ck({ spill: v }), 'Removes the coloured fringe on hair edges', { def: kd.spill }));
        add(select('Behind your model', s.bg, TV_BACKDROPS.map((b): [string, string] => [b.id, b.name]), (v) => set({ bg: v })));
      }
      add(h('div', { class: 'note', style: 'margin:8px 0 2px' }, h('b', null, 'Frame your face'), ' (only this part is sent — sharper for the same bandwidth)'));
      add(slider('Zoom', s.crop.zoom, 1, 4, 0.05, (v) => set({ crop: { ...s.crop, zoom: v } }), undefined, { def: DEFAULT_TV_SETTINGS.crop.zoom, unit: '×' }));
      add(slider('Left / right', s.crop.x, -1, 1, 0.02, (v) => set({ crop: { ...s.crop, x: v } }), undefined, { def: DEFAULT_TV_SETTINGS.crop.x }));
      add(slider('Up / down', s.crop.y, -1, 1, 0.02, (v) => set({ crop: { ...s.crop, y: v } }), undefined, { def: DEFAULT_TV_SETTINGS.crop.y }));
      add(h('details', { open: !T.source.live }, h('summary', null, 'How to set up VTube Studio (2 minutes)'),
        h('ol', { class: 'note', style: 'margin:4px 0 4px 18px;padding:0' },
          h('li', null, 'In VTube Studio open the ', h('b', null, 'Background'), ' menu (left side) → ', h('b', null, 'Color Picker Background'), ' → pick pure ', h('b', null, 'green'), ' (0, 255, 0). If your model has a lot of green, use blue and pick Blue above. ', h('b', null, 'Turn “Transparent in capture / OBS” OFF'), ' — a browser can’t see transparency, it would turn black.'),
          h('li', null, 'Easiest: VTube Studio ', h('b', null, 'Settings'), ' (gear) → camera settings → ', h('b', null, 'Virtual Webcam'), ' → Enable. Then click Refresh list here and pick ', h('b', null, '“VTubeStudioCam”'), ' as the camera.'),
          h('li', null, 'Or click ', h('b', null, 'Share the VTube Studio window'), ' and pick its window (keep it un-minimised).'),
          h('li', null, 'Or, if you already bring VTube Studio into OBS (Spout2 / Game Capture): put a green Color Source behind it in its own scene and use ', h('b', null, 'Start Virtual Camera'), ' in OBS, then pick “OBS Virtual Camera” here.'),
          h('li', null, 'Use Zoom / Left-right / Up-down until your face fills the TV in the preview. Nudge Similarity until the green is gone but your hair edges stay.'))));
    }
    voiceAndNote();
  }
  function voiceAndNote() {
    const add = (...n: (Node | string | null | false | undefined)[]) => controls.append(...n.filter((x): x is Node | string => !!x));
    const s = T.source.settings;
    // ---- voice → talk gestures
    add(select('Talk gestures from', s.mic || '', [['', 'Default microphone'], ['none', 'Off (just idle)'], ...mics.map((m): [string, string] => [m.id, m.label])], (v) => set({ mic: v }), 'Your TV bounces and gestures while you speak (only a loudness level is sent — never your audio; voice stays in Discord)'));
    const pages = T.pages.length;
    add(h('p', { class: 'note', style: 'margin:6px 0 0' }, P.role === 'none' ? (T.soloShow ? 'Showing in your own rooms now. ' : '') + `Join or host a party and you appear ${s.look === 'projector' ? 'on this projector screen' : s.look === 'standee' ? 'standing in the room' : 'as this TV'}.`+ ' Your picture only goes to the party (and the host forwards it only as your sharing rule allows). VTube Pro never stores or records it, but it is on the party’s streams, which they may save.'
      : !T.source.live ? 'Start your camera to appear as this TV — until then the party sees your avatar (if you share it).'
        : `In the party as this TV${pages ? ` · on ${pages} OBS page${pages > 1 ? 's' : ''} here` : ''}.`));
  }

  wrap.append(h('div', { style: 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap' },
    h('div', { style: 'flex:1 1 260px;min-width:240px' }, h('b', null, 'How you appear'), controls),
    preview.el));
  T.listeners.add(() => { if (wrap.isConnected) { preview.sync(T); draw(); } });
  // Spout2 health (fps, alpha) changes every second without an event: redraw while it is shown
  setInterval(() => { if (wrap.isConnected && T.appear === 'tv' && T.source.spoutRx && !wrap.contains(document.activeElement)) draw(); }, 1000);
  void refreshDevices();
  build();
  preview.sync(T);
  cached = wrap;
  return wrap;
}

/** Guest: how the host shows me (their override in the scene state's TV bag), or null. */
function tvHostLookFor(app: App): TvLook | null {
  const bag = sanitizeTvBag(app.scene.modeBag(TV_BAG));
  return bag.looks[app.party.myId] ?? null;
}

/** Host: TV / projector guests — switch a guest between walking TV and projector, the motion for everyone, Talk cuts. */
export function tvHostControls(app: App): HTMLElement | null {
  const P = app.party, S = app.scene;
  if (P.role !== 'host') return null;
  const tvs = P.view().filter((m) => m.tv);
  if (!tvs.length) return null;
  const bag: TvBag = sanitizeTvBag(S.modeBag(TV_BAG));
  const save = (b: TvBag) => S.setModeBag(TV_BAG, b);
  const box = h('div', { style: 'padding:6px 8px;background:#1f2533;border-radius:8px;margin:6px 0' }, h('b', null, 'TV guests'));
  for (const m of tvs) {
    const key = m.me ? HOST_KEY : m.id;
    const cur: TvLook = bag.looks[key] ?? m.tv!.look ?? 'tv';
    box.append(h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px' },
      h('span', { style: 'flex:1;min-width:120px' }, m.me ? `${m.name} (you)` : m.name),
      // (a Spout2 model can stand in the room itself — needs alpha: real alpha or a keyed picture)
      m.tv!.spout || m.tv!.chroma || m.tv!.pack ? h('button', { class: `btn ${cur === 'standee' ? 'primary' : ''}`, title: 'Their model stands in the room (cut out by its alpha / key)', onClick: () => save({ ...bag, looks: { ...bag.looks, [key]: 'standee' } }) }, '🧍 Standing') : null,
      h('button', { class: `btn ${cur === 'tv' ? 'primary' : ''}`, onClick: () => save({ ...bag, looks: { ...bag.looks, [key]: 'tv' } }) }, '🚶 Walking TV'),
      h('button', { class: `btn ${cur === 'projector' ? 'primary' : ''}`, onClick: () => save({ ...bag, looks: { ...bag.looks, [key]: 'projector' } }) }, '📽 Projector'),
      bag.looks[key] ? h('button', { class: 'btn', title: 'Let them choose again', onClick: () => { const l = { ...bag.looks }; delete l[key]; save({ ...bag, looks: l }); } }, 'Their choice') : null));
  }
  box.append(select('TV motion', bag.motion, [['auto', 'Each guest’s own choice'], ['calm', 'Calm for everyone'], ['lively', 'Lively for everyone']], (v) => save({ ...bag, motion: v })),
    toggle('Talk camera cuts to projector guests', bag.cut, (v) => save({ ...bag, cut: v }), 'In Talk mode the camera goes to a projector guest while they speak, then back'));
  return box;
}

/** Live preview: the real TV body + screen shader with my own picture, turning slowly (only while visible). */
class TvPreview {
  readonly el: HTMLElement;
  private canvas = h('canvas', { width: 360, height: 360, style: 'width:220px;height:220px;border-radius:8px;background:#0e1118' }) as HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  private anchor = new THREE.Group();
  private rt: TvRuntime | null = null;
  private feeds = new PageFeeds();
  private skin = '';
  private raf = 0;
  private last = 0;
  private loading = false;
  private t = 0;
  private tvRef: App['party']['tv'] | null = null;
  constructor() {
    this.el = h('div', { style: 'flex:none;text-align:center' }, this.canvas, h('div', { class: 'note', style: 'margin:2px 0 0' }, 'Preview — what everyone sees'));
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x302a26, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2.5, 3); this.scene.add(key);
    this.scene.add(this.anchor);
  }
  sync(T: App['party']['tv']) {
    this.tvRef = T;
    const on = T.appear === 'tv';
    this.el.style.display = on ? '' : 'none';
    if (!on) { this.stop(); return; }
    this.feeds.inject('preview', T.source.live ? T.source.out : null);
    if (this.skin !== tvSkin(T.source.settings.skin).id + (T.source.settings.look ?? 'tv')) void this.rebuild(T);
    else { this.rt?.setInfo(T.source.info()); if (this.rt) this.rt.motion = T.source.settings.motion ?? 'calm'; }
    this.startLoop();
  }
  async rebuild(T: App['party']['tv']) {
    if (this.loading) return;
    this.loading = true;
    try {
      const info = T.source.info();
      this.skin = info.skin + info.look;
      this.rt?.dispose();
      this.rt = info.look === 'projector' ? new ProjectorRuntime('preview', info, this.anchor, this.feeds, 'You') as unknown as TvRuntime
        : info.look === 'standee' ? new StandeeRuntime('preview', info, this.anchor, this.feeds, 'You') as unknown as TvRuntime
        : await TvRuntime.load({ feedId: 'preview', name: 'You', tv: info, anchor: this.anchor, feeds: this.feeds });
      this.rt.motion = info.motion ?? 'calm';
      const b = this.rt.bounds(), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      const f = this.rt.faceInfo().center;
      // frame the set (the face) with a bit of body below it
      const proj = info.look === 'projector', stand = info.look === 'standee';
      const y = proj ? f.y + 0.05 : stand ? 0.55 : f.y - s.y * 0.08;
      const dist = proj ? s.x * 2.1 : stand ? 2.3 : s.y * 1.55;
      this.camera.position.set(0, y + (proj ? 0.1 : s.y * 0.05), dist);
      this.camera.lookAt(0, y, 0);
    } catch (e) { console.warn('tv preview', e); } finally { this.loading = false; }
    if (this.skin !== tvSkin(T.source.settings.skin).id + (T.source.settings.look ?? 'tv')) void this.rebuild(T);
  }
  private startLoop() {
    if (this.raf) return;
    const loop = (now: number) => {
      this.raf = 0;
      if (!this.el.isConnected || this.el.style.display === 'none') return;
      this.raf = requestAnimationFrame(loop);
      if (now - this.last < 33) return;                 // 30 fps is plenty (the studio is also tracking)
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.t += dt;
      if (!this.renderer) { this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true }); this.renderer.outputColorSpace = THREE.SRGBColorSpace; }
      if (this.tvRef) this.feeds.testLevels.set('preview', this.tvRef.source.level);
      this.anchor.rotation.y = Math.sin(this.t * 0.5) * 0.45;
      this.rt?.update(null as never, null, null, dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }
  private stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
}

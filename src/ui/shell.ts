// App shell (UI overhaul): top bar with status chips + Simple/Advanced + theme + help, a rail of six plain-language
// areas (Me · Go Live · Room · Create · Friends · Settings), and per area either the Simple view (src/ui/simple.ts)
// or, under Advanced, the original panels (src/ui/panels.ts renderPanel — untouched, so every setting stays where
// it was and its re-render preservation keeps working). The chosen area / mode / sub-tab persist in localStorage.
import { setStudioPresence } from '../net/studioPresence.ts';
import type { App } from '../app.ts';
import { api } from '../api.ts';
import { renderPanel, type TabId } from './panels.ts';
import { multiplayerSection } from './multiplayerPanel.ts';
import { applyOpenState, button, cancelRerender, clear, foldCard, h, rerender, toast } from './dom.ts';
import { icon } from './icons.ts';
import { brandMark } from './brandMark.ts';
import { add } from './bits.ts';
import { effectiveTheme, injectTheme, setTheme } from './theme.ts';
import { SIMPLE, invalidateSimpleLibrary, pollObs, syncRoomPip, type AreaId, type Nav } from './simple.ts';
import { openNamed, setWizardNav } from './wizards.ts';
import { installStreamSetupEvent } from './streamSetup/index.ts';
import { voiceAdvanced } from './voicePanel.ts';
import { gpuTrackingCards } from './gpuPanel.ts';
import { phoneCard } from './phonePanel.ts';
import { multicamAdvanced } from './multicamPanel.ts';
import { speakingProfileCard } from './speakingPanel.ts';
import { learnMeCard } from './learnMePanel.ts';
import { faceModelCard } from './faceModelPanel.ts';
import { wizardOpen, wizardState } from './wizard.ts';
import { initGuide, nextHint, startHomeDue } from './guide/guide.ts';
import { gamesHub } from './gamesHub.ts';
import { initStudioLayout, learnSections, searchBox, watchColumns } from './studioLayout.ts';
import { initPremium, shortcutSheet } from './premium.ts';
import { initLiveStudio } from './live/liveStudio.ts';
import { initDockTools } from './dockTools.ts';
import { initHelpStyles, openHelp, preloadHelp, setHelpExtras } from './help/helpViewer.ts';
import { AREA_HELP } from '../../shared/helpCatalog.ts';
import { closeGuides, initGuidesPage, isGuidesOpen, openGuides } from './help/guidesPage.ts';
import { trackPartActions } from './trackPartsPanel.ts';
import { PREVIEW_RATE_TIP, previewRateText, studioViewHidden } from './previewRate.ts';
// UX redesign (owner 2026-10-04): grouped rail, one notification tray, a Tools menu, folding cards; Settings -> Layout:
// Classic brings back this shell exactly as it was (src/ui/layoutMode.ts)
import { fitMenu, initLayoutMode, isClassic, onLayoutMode } from './layoutMode.ts';
import { lampLabel, railPlan } from '../../shared/uxLayout.ts';
import { initNotifyTray } from './notifyTray.ts';
import { closeToolsMenu, toolsButton } from './toolsMenu.ts';
// beta.12 UX: the show dock (src/ui/showDock.ts): the live show one click away in every area (new layout; Classic keeps the mini-bar)
import { initShowDock } from './showDock.ts';
// beta.12 zero-effort mount points: the global "Fix it" button + the first-run flow (src/ui/assistHooks.ts)
import { fixItButton, openFirstRunIfDue } from './assistHooks.ts';
// beta.12: narrow windows put the secondary top-bar items in one More menu (src/ui/topbarMore.ts)
import { initTopbarFit, topbarMoreButton } from './topbarMore.ts';
import { cardNamed, stallChipText } from './gameText.ts';

type Sub = { id: TabId | 'party' | 'voice' | 'games'; label: string };
// Studio layout overhaul 2: clear top-level groups (Show & layout, Chat & events and OBS & stream split out of the old
// all-in-one Room tab; OBS output moved out of Go Live). Every setting is still here, and search finds any of them.
export const AREAS: { id: AreaId; label: string; title: string; sub: string; icon: string; legacy: Sub[] }[] = [
  // premium pass: Home (src/ui/home.ts) — status of everything + the next thing to do. No Advanced view of its own.
  { id: 'home', label: 'Home', title: 'Home', sub: 'Everything at a glance, and what to do next', icon: 'home', legacy: [] },
  // livedash: Live Control — everything you change mid-show on one screen (src/ui/live). Alt+L.
  // (clarity: "Live" is the show's remote control; it never streams. You go live from OBS.)
  { id: 'onair', label: 'Live', title: 'Live Control', sub: 'Your show’s remote control: lights, rooms, guests. You go live from OBS (Alt+L)', icon: 'live', legacy: [] },
  { id: 'me', label: 'Me', title: 'Me', sub: 'Your avatar, outfit and look', icon: 'me', legacy: [{ id: 'avatars', label: 'Avatars' }, { id: 'wardrobe', label: 'Outfits' }, { id: 'face', label: 'Face' }, { id: 'body', label: 'Body & physics' }] },
  // (clarity: this is where the camera turns on, so it isn't called "Go live": turning on the camera doesn't stream)
  { id: 'live', label: 'Tracking', title: 'Camera & tracking', sub: 'Camera, face and body tracking, mic and voice', icon: 'track', legacy: [{ id: 'tracking', label: 'Camera & tracking' }, { id: 'voice', label: 'Voice, phone & 2nd camera' }] },
  { id: 'room', label: 'Room', title: 'Room', sub: 'Where you stream from: room, seats, camera, lights, weather', icon: 'room', legacy: [{ id: 'scene', label: 'Room, seats & lights' }] },
  { id: 'show', label: 'Show', title: 'Show & layout', sub: 'Talk, React or Gaming, and where every cam, the game and the chat sit', icon: 'show', legacy: [{ id: 'show', label: 'Show & layout' }] },
  { id: 'chat', label: 'Chat', title: 'Chat & events', sub: 'Chats, donations, alerts, raids and slaps', icon: 'chat', legacy: [{ id: 'chatev', label: 'Chat & events' }] },
  { id: 'games', label: 'Games', title: 'Games', sub: 'The Trail and a tabletop RPG, solo or with friends', icon: 'games', legacy: [{ id: 'games', label: 'Games' }] },
  { id: 'friends', label: 'Party', title: 'Party', sub: 'Stream together (multiplayer)', icon: 'friends', legacy: [{ id: 'party', label: 'Party' }] },
  { id: 'stream', label: 'OBS', title: 'OBS & stream', sub: 'The Browser Source, output size and OBS automation', icon: 'stream', legacy: [{ id: 'output', label: 'Browser Source & output' }, { id: 'obs', label: 'OBS automation' }] },
  { id: 'create', label: 'Create', title: 'Create', sub: 'Make an avatar, outfit or room', icon: 'create', legacy: [{ id: 'create', label: 'Avatar builder' }, { id: 'wardrobe', label: 'Outfit maker' }] },
  { id: 'settings', label: 'Settings', title: 'Settings', sub: 'Theme, guided set-ups, tools', icon: 'settings', legacy: [{ id: 'settings', label: 'Tools & credits' }] },
];
/** Areas without a separate Simple view: they always show their full, grouped settings. */
const FULL = new Set<AreaId>(['show', 'chat', 'stream']);
/** Areas that only have a Simple view (no Advanced switch). */
const SIMPLE_ONLY = new Set<AreaId>(['home', 'onair']);
/** livedash: set-up areas that fade back in Streaming mode (still clickable). */
const SETUP_AREAS = new Set<AreaId>(['create', 'settings', 'stream', 'games']);
const LEGACY_AREA: Record<string, AreaId> = { avatars: 'me', wardrobe: 'me', face: 'me', body: 'me', tracking: 'live', output: 'stream', scene: 'room', create: 'create', settings: 'settings' };

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
  json<T>(k: string, d: T): T { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v as T : d; } catch { return d; } },
};

export interface Shell {
  /** App events the panels care about ('avatar', 'library', 'tracking', 'costume', 'setup'). */
  onApp(what: string): void;
  isAdvanced(): boolean;
  /** Advanced was chosen for this area (not just an always-full area): raw tuning numbers may show. */
  isTuning(): boolean;
  showShortcuts(): void;
  go(area: AreaId): void;
}

/** The observer tab's line in the area header (plain words; leaving = closing the tab, so a click here can never open a
 *  second, writing studio next to the live one). */
function observerBar(): HTMLElement {
  if (!document.getElementById('vtp-observer-css')) {
    document.head.append(h('style', { id: 'vtp-observer-css' }, `
#vtp-observer-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.35;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--text); }
#vtp-observer-bar .d { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--warn); }
#vtp-observer-bar small { display: block; color: var(--dim); font-size: 12px; }`));
  }
  return h('div', { id: 'vtp-observer-bar', role: 'status', 'data-ui': 'observer-bar' }, h('span', { class: 'd', 'aria-hidden': 'true' }),
    h('span', null, h('b', null, 'Observer tab: read-only. '), 'Nothing you change here is saved or sent to OBS, and the camera and mic stay off.',
      h('small', null, 'This tab stays an observer until you close it.')));
}

export function initShell(app: App): Shell {
  injectTheme();
  initLayoutMode();
  initPremium((a) => { if (AREAS.some((x) => x.id === a)) go(a as AreaId); });
  // ---------------------------------------------------------------- state (+ one-time migration from the old tabs)
  const oldTab = ls.get('vtp.tab') as TabId | null;
  const existing = !!(oldTab || ls.get('vtp.lastAvatar') || ls.get('vtp.web.lastAvatar'));
  let area: AreaId = (ls.get('vtp.ui.area') as AreaId) || (oldTab && LEGACY_AREA[oldTab]) || (existing ? 'me' : 'home');
  if (!AREAS.some((a) => a.id === area)) area = 'home';
  let globalAdv = ls.get('vtp.ui.mode') === 'advanced';
  const areaAdv = ls.json<Partial<Record<AreaId, boolean>>>('vtp.ui.adv', {});
  const subOf = ls.json<Partial<Record<AreaId, string>>>('vtp.ui.sub', {});
  if (!ls.get('vtp.ui.area') && oldTab && LEGACY_AREA[oldTab]) {
    // someone who used the old tabs lands exactly where they were (that area opens in Advanced on that tab)
    areaAdv[LEGACY_AREA[oldTab]] = true; subOf[LEGACY_AREA[oldTab]] = oldTab;
    ls.set('vtp.ui.adv', JSON.stringify(areaAdv)); ls.set('vtp.ui.sub', JSON.stringify(subOf));
  }
  const advOf = (a: AreaId) => !SIMPLE_ONLY.has(a) && (FULL.has(a) || (areaAdv[a] ?? globalAdv));
  /** The user chose Advanced here (Show, Chat and OBS always show every setting, but that is not a choice): the raw
   *  tuning numbers (face meters, fps) show only then. */
  const tuneOf = (a: AreaId) => !SIMPLE_ONLY.has(a) && (areaAdv[a] ?? globalAdv);

  // ---------------------------------------------------------------- DOM
  const top = document.getElementById('topbar')!;
  const rail = document.getElementById('tabs')!;
  const panel = document.getElementById('panel')!;
  clear(top); clear(rail); clear(panel);
  rail.setAttribute('role', 'navigation'); rail.setAttribute('aria-label', 'Areas');
  const head = h('div', { class: 'area-head' });
  // a slot for a notice that shows in every area and never covers a control; the slot survives every repaint of the header
  const headSlot = h('div', { id: 'area-head-slot' });
  // observer tab (?observer=1, src/ui/observerMode.ts): one line in EVERY area's header (Brave / Edge testers lost track of
  // it: the top-bar chip got crowded out and the note only showed in the Simple views)
  if (app.observer) headSlot.append(observerBar());
  const body = h('div', { class: 'area-body', tabindex: -1 });
  panel.append(head, body);
  // resizable options panel + docked / mini / hidden studio view, two-column cards when wide, settings search
  const layout = initStudioLayout();
  watchColumns(body);
  const liveStudio = initLiveStudio(app, () => go('onair'));
  initDockTools(() => go('onair'));
  // Ctrl+K "Run": the Hands / Body switches ("hand tracking off" …, src/ui/trackPartsPanel.ts), then Live Control's actions
  const search = searchBox(body, () => area, (a, sub) => { const id = AREAS.some((x) => x.id === a) ? a as AreaId : 'me'; if (sub && !FULL.has(id)) nav.advanced(id, sub); else { if (sub) subOf[id] = sub; saveNav(); go(id, true); } }, (q) => [...trackPartActions(app, q), ...liveStudio.actions(q)]);
  panel.insertBefore(liveStudio.miniBar, body);
  const showDockEl = initShowDock(app, { go: (a) => { if (AREAS.some((x) => x.id === a)) go(a as AreaId); }, status: () => liveStudio.status() }).el;
  document.getElementById('app')?.append(showDockEl);
  // AV-09: toasts sit bottom-centre above the show dock: --sd-h = how far the dock's top edge is above the window bottom
  // (0 without a dock: Classic, or hidden), kept current as the dock or the window changes size (styles.css #toasts)
  { const root = document.documentElement;
    const dockH = () => { const r = showDockEl.getBoundingClientRect(); const v = r.height > 0 && getComputedStyle(showDockEl).display !== 'none' ? Math.max(0, Math.round(innerHeight - r.top)) : 0; const px = `${v}px`; if (root.style.getPropertyValue('--sd-h') !== px) root.style.setProperty('--sd-h', px); };
    new ResizeObserver(dockH).observe(showDockEl); addEventListener('resize', dockH); window.setInterval(dockH, 1000); dockH(); }

  // top bar
  const avatarPill = h('button', { class: 'tb-avatar', title: 'Your avatar — click to change', onClick: () => go('me') });
  const chip = (title: string, onClick: () => void) => h('button', { class: 'chip', title, 'data-base': title, onClick });
  const chips = {
    cam: chip('Your camera moves your avatar. Viewers see your avatar, not your camera picture. Click for Tracking.', () => go('live')),
    mic: chip('Microphone lip-sync — click for Tracking', () => go('live')),
    obs: chip('OBS Browser Source — click for OBS & stream', () => go('stream')),
    room: chip('The room your stream shows — click for Room', () => go('room')),
    perf: h('span', { class: 'chip', title: '', 'data-ui': 'perf' }),
  };
  const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Menus', title: 'Simple: the essentials. Advanced: every setting.' });
  const themeBtn = h('button', { class: 'icon-btn', 'data-ui': 'theme', title: 'Light / dark theme', 'aria-label': 'Toggle light / dark theme', onClick: () => { setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); paintTop(); if (area === 'settings') refresh(); } });
  // Help: the searchable guide viewer (src/ui/help/helpViewer.ts, also F1); ? still shows the keyboard shortcuts
  const helpBtn = h('button', { class: 'icon-btn', 'data-ui': 'help', title: 'Help & guides (F1) · keyboard shortcuts: ?', 'aria-label': 'Help and guides', onClick: () => openHelp() }, icon('help', 18));
  // UX redesign (new layout only, class ux-only): the Tools menu (every helper page / tool in one place) and the bell
  // (one notification tray: notices, guests knocking, every message)
  const toolsBtn = toolsButton({ shortcuts: () => showShortcuts() });
  const bellBtn = initNotifyTray(app);
  // narrow windows only (CSS in topbarMore.ts): what the stream is doing, always in sight (red only when OBS shows VTube Pro)
  const airChip = h('button', { type: 'button', class: 'chip tb-air', 'data-ui': 'tb-air', onClick: () => go('onair') });
  add(top,
    h('div', { class: 'logo' }, h('span', { class: 'mark', 'aria-hidden': 'true', style: 'background:none' }, brandMark('tile', 30)), h('span', null, 'VTube ', h('b', null, 'Pro'))),
    avatarPill,
    h('div', { class: 'tb-chips', 'data-tut': 'status-chips' }, chips.cam, chips.mic, chips.obs, chips.room),
    app.observer ? h('span', { class: 'chip warn', 'data-ui': 'observer-chip', 'aria-label': 'Observer tab: read-only', style: 'flex:none', title: 'Read-only sandbox: never saves, never sends to OBS' }, h('span', { class: 'dot' }), 'Observer') : null,
    h('div', { class: 'spacer' }),
    airChip, chips.perf, layout.viewControl, modeSeg, themeBtn, fixItButton(), helpBtn, toolsBtn, bellBtn, topbarMoreButton(),
  );

  // FR-09: the lamps, Help and Simple / Advanced never clip: lamps shrink to dots, then the avatar and logo words go (src/ui/topbarMore.ts)
  initTopbarFit();
  // cr-01: the Help menu (src/ui/guide/guide.ts builds it) fits the window like the Tools menu: it scrolls inside, and at
  // 600 px or less it is a bottom sheet with Close
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n instanceof HTMLElement && n.classList.contains('gd-menu')) fitMenu(n, { anchor: document.querySelector<HTMLElement>('.gd-help'), close: () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) });
    }
  }).observe(document.body, { childList: true });

  // rail
  const railBtns = new Map<AreaId, HTMLButtonElement>();
  // "Guides": every guide as a page in the studio (src/ui/help/guidesPage.ts); owner: "guides need to be in the studio"
  const guidesBtn = h('button', { class: 'rail-btn', title: 'Guides — every guide, with search, right here', 'aria-label': 'Guides', 'data-ui': 'rail-guides', onClick: () => { if (isGuidesOpen()) { openGuides(); return; } openGuides(undefined, guidesBtn); } }, icon('book', 22), h('span', null, 'Guides')) as HTMLButtonElement;
  for (const a of AREAS) {
    const b = h('button', { class: 'rail-btn', title: `${a.title} — ${a.sub}`, 'aria-label': a.title, onClick: () => go(a.id) }, icon(a.icon, 22), h('span', null, a.label)) as HTMLButtonElement;
    railBtns.set(a.id, b);
    if (SETUP_AREAS.has(a.id)) b.dataset.setup = '1';
  }
  // UX redesign: the same buttons in the same order; the new layout puts a small group label above each group (You,
  // Stream, Set up). Classic = spacer, Guides before Settings, nothing else (shared/uxLayout.ts railPlan).
  const railSpacer = h('div', { class: 'rail-spacer' });
  function paintRail() {
    const kids: HTMLElement[] = [];
    for (const it of railPlan(AREAS.map((a) => a.id), isClassic())) {
      if (it.kind === 'area') { const b = railBtns.get(it.id as AreaId); if (b) kids.push(b); }
      else if (it.kind === 'guides') kids.push(guidesBtn);
      else if (it.kind === 'spacer') kids.push(railSpacer);
      else kids.push(h('div', { class: 'rail-grp', 'aria-hidden': 'true' }, it.label));
    }
    rail.replaceChildren(...kids);
  }
  paintRail();

  // ---------------------------------------------------------------- navigation
  const nav: Nav = {
    go: (a) => go(a),
    advanced: (a, sub) => { areaAdv[a] = true; if (sub) subOf[a] = sub; saveNav(); go(a, true); },
    wizard: (id, at) => openNamed(app, id, at),
    refresh: () => refresh(),
    setGlobalAdvanced: (on) => setGlobal(on),
    globalAdvanced: () => globalAdv,
    shortcuts: () => showShortcuts(),
  };
  setWizardNav({ go: (a) => go(a as AreaId), advanced: (a, s) => nav.advanced(a as AreaId, s), refresh: () => refresh() });
  installStreamSetupEvent(app); // lane stream-setup: the Live panel's "Set up" (CONTRACT.md "stream-setup") opens the chat & stream set-up
  const saveNav = () => { ls.set('vtp.ui.area', area); ls.set('vtp.ui.adv', JSON.stringify(areaAdv)); ls.set('vtp.ui.sub', JSON.stringify(subOf)); };
  function setGlobal(on: boolean) {
    globalAdv = on; ls.set('vtp.ui.mode', on ? 'advanced' : 'simple');
    for (const k of Object.keys(areaAdv)) delete areaAdv[k as AreaId];
    saveNav(); paintTop(); go(area, true);
    toast(on ? 'Advanced: every setting is shown.' : 'Simple: just the essentials. Each area’s Advanced switch shows the rest.', 'info', 3200);
  }
  const curSub = (a: AreaId) => { const L = AREAS.find((x) => x.id === a)!.legacy; return L.find((s) => s.id === subOf[a]) ?? L[0]; };

  function paintHead() {
    const a = AREAS.find((x) => x.id === area)!;
    const adv = advOf(area);
    const sw = h('input', { type: 'checkbox', checked: adv, 'aria-label': `Advanced settings for ${a.title}`, onChange: (e: Event) => { areaAdv[area] = (e.target as HTMLInputElement).checked; saveNav(); go(area, true); } });
    clear(head);
    const hp = AREA_HELP[area];
    const helpTo = hp ? (adv ? hp.advanced : hp.simple) : null;
    head.append(h('div', { class: 'ttl' }, h('h2', null, a.title),
      helpTo ? h('button', { class: 'area-help', title: `Help for ${a.title}${adv ? ' (Advanced)' : ''}`, 'aria-label': `Help for ${a.title}`, onClick: () => openHelp(helpTo) }, icon('help', 15)) : null,
      FULL.has(area) || SIMPLE_ONLY.has(area) ? null : h('label', { class: 'adv-switch', title: 'Show every setting of this area', 'data-tut': 'adv-switch' }, 'Advanced', h('span', { class: 'switch' }, sw, h('i')))),
      h('div', { class: 'sub' }, FULL.has(area) ? a.sub : adv ? 'Every setting. Switch Advanced off for the essentials.' : a.sub));
    if (adv && a.legacy.length > 1) {
      const cur = curSub(area).id;
      head.append(h('div', { class: 'subtabs', role: 'tablist' }, ...a.legacy.map((s) => h('button', { class: s.id === cur ? 'on' : '', role: 'tab', 'aria-selected': String(s.id === cur), onClick: () => { subOf[area] = s.id; saveNav(); go(area, true); } }, s.label))));
    }
    // premium pass: an empty state with the fix, when an area needs something first
    const hint = areaHint(area) ?? nextHint(area); // ux-simplicity: else a one-line "Next:" for this area (src/ui/guide)
    head.append(headSlot);
    if (hint) head.append(hint);
    head.append(search);
  }
  function areaHint(a: AreaId): HTMLElement | null {
    const room = !!app.scene.effective.sceneId;
    if ((a === 'show' || a === 'games') && !room && app.scene.canEdit) return h('div', { class: 'pm-hint' }, h('span', null, a === 'show' ? 'Show modes and the layout editor work inside a room. Your avatar is on a see-through background right now.' : 'Games play in a room. Pick one first (the Gaming Lounge or a table room works best).'), h('button', { class: 'btn primary', onClick: () => go('room') }, 'Pick a room'));
    if (a === 'chat' && app.scene.chat.status && !app.scene.chat.status.configured) return h('div', { class: 'pm-hint' }, h('span', null, 'No chat connected yet. The guided set-up takes about 3 minutes. VTube Pro never posts in your chat.'), h('button', { class: 'btn primary', onClick: () => openNamed(app, 'chat') }, 'Set up my chat'));
    return null;
  }
  function paintTop() {
    const guides = isGuidesOpen();
    for (const [id, b] of railBtns) { const on = !guides && id === area; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); }
    guidesBtn.classList.toggle('on', guides); guidesBtn.setAttribute('aria-current', guides ? 'page' : 'false');
    clear(modeSeg);
    modeSeg.append(
      h('button', { class: globalAdv ? '' : 'on', role: 'radio', 'aria-checked': String(!globalAdv), onClick: () => { if (globalAdv) setGlobal(false); } }, 'Simple'),
      h('button', { class: globalAdv ? 'on' : '', role: 'radio', 'aria-checked': String(globalAdv), onClick: () => { if (!globalAdv) setGlobal(true); } }, 'Advanced'));
    clear(themeBtn); themeBtn.append(icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', 18));
    chips.perf.style.display = tuneOf(area) ? '' : 'none';
  }

  /** What is showing in the body: a legacy tab id, 'party', or `simple:<area>`. */
  let showing = '';
  function go(a: AreaId, force = false) {
    if (isGuidesOpen()) closeGuides(); // … and the Guides page
    const changed = a !== area;
    area = a; saveNav();
    paintTop(); paintHead();
    const adv = advOf(a);
    syncRoomPip(!adv && a === 'room');
    if (adv) {
      const s = curSub(a);
      if (s.id === 'party') {
        if (showing !== 'party' || force) { cancelRerender(body); clear(body); body.dataset.ui = 'party'; body.append(multiplayerSection(app)); applyOpenState(body); showing = 'party'; }
        app.showGizmos = false; app.drawGizmos();
      } else if (s.id === 'games') {
        // the Games hub (src/ui/gamesHub.ts) — the same cards as Simple, plus pointers to every game setting
        cancelRerender(body); clear(body); body.dataset.ui = 'games'; buildGames(); showing = 'games';
        app.showGizmos = false; app.drawGizmos();
      } else if (s.id === 'voice') {
        cancelRerender(body); clear(body); body.dataset.ui = 'voice'; buildVoice(); showing = 'voice';
        app.showGizmos = false; app.drawGizmos();
      } else {
        ls.set('vtp.tab', s.id);
        if (showing.startsWith('simple:') || showing === 'party' || showing === 'games') { cancelRerender(body); clear(body); delete body.dataset.ui; }
        renderPanel(app, s.id, body);
        showing = s.id;
      }
    } else {
      const key = `simple:${a}`;
      app.showGizmos = false; app.drawGizmos();
      if (showing !== key || force || changed) {
        cancelRerender(body); clear(body);
        body.dataset.ui = key;
        if (a === 'onair') liveStudio.view(body); else SIMPLE[a](app, body, nav);
        applyOpenState(body);
        body.scrollTop = a === 'home' ? 0 : Number(ls.json<Record<string, number>>('vtp.ui.sscroll', {})[key] ?? 0); // Home always opens on its headline
        showing = key;
      } else refresh();
    }
    if (changed) body.focus({ preventScroll: true });
    // search index: remember the sections this view shows (after late renders settle)
    const A = AREAS.find((x) => x.id === a)!, sub = adv ? curSub(a).id : undefined;
    const where = `${A.title}${adv && A.legacy.length > 1 ? ` › ${curSub(a).label}` : ''}`;
    window.setTimeout(() => { if (area === a) learnSections(body, a, sub, where); }, 1200);
  }
  function buildGames() { gamesHub(app, body, nav, { advanced: true }); }
  function buildVoice() { body.append(voiceAdvanced(app, () => refresh()), gpuTrackingCards(app, () => refresh()), phoneCard(app, () => openNamed(app, 'phone'), () => refresh()), speakingProfileCard(app, () => refresh()), learnMeCard(app, () => refresh()), faceModelCard(app, () => refresh()), multicamAdvanced(app, () => openNamed(app, 'multicam'), () => refresh())); }
  /** Re-render what is showing, keeping the user's place. */
  function refresh() {
    if (showing === 'voice') { rerender(body, buildVoice); return; }
    if (showing === 'games') { if (body.dataset.ui === 'games') rerender(body, buildGames); return; }
    if (showing === 'simple:onair') return; // Live Control repaints itself from the live state
    if (showing.startsWith('simple:')) { const a = showing.slice(7) as AreaId; if (body.dataset.ui === showing) rerender(body, () => SIMPLE[a](app, body, nav)); }
    else if (showing && showing !== 'party' && showing !== 'voice' && showing !== 'games') renderPanel(app, showing as TabId, body);
  }
  // remember Simple scroll positions
  let st = 0;
  body.addEventListener('scroll', () => { clearTimeout(st); st = window.setTimeout(() => { if (!showing.startsWith('simple:')) return; const m = ls.json<Record<string, number>>('vtp.ui.sscroll', {}); m[showing] = Math.round(body.scrollTop); ls.set('vtp.ui.sscroll', JSON.stringify(m)); }, 300); }, { passive: true });
  document.addEventListener('vtp-refresh', () => refresh());
  // the room / chat can change from anywhere (a hotkey, Stream Deck, the MCP): keep Room and Go Live current
  app.scene.on((what) => { if (what === 'state' && (showing === 'simple:room' || showing === 'simple:live')) refresh(); });
  app.scene.chat.on(() => { if (showing === 'simple:live') refresh(); });
  document.addEventListener('vtp-wizard', () => { if (area === 'settings' || area === 'live') refresh(); });
  // UX redesign: a card folds from its chevron or its title (not from a control inside the title); remembered per panel
  body.addEventListener('click', (e) => {
    if (isClassic()) return;
    const t = e.target as Element | null;
    const head = t?.closest?.('.s-card > h3');
    if (!head || !body.contains(head) || !head.querySelector(':scope > .s-fold')) return;
    if (!t!.closest('.s-fold') && t!.closest('button, a, input, select, textarea, label')) return;
    e.preventDefault();
    foldCard(head.parentElement as HTMLElement);
  });
  // the layout switch applies at once: rail labels, top bar (CSS), notices (the tray moves them), Home's tiles
  onLayoutMode(() => {
    closeToolsMenu();
    paintRail(); paintTop();
    if (showing === 'simple:home' || showing === 'simple:settings') refresh();
  });

  // ---------------------------------------------------------------- status chips (4×/s, cheap)
  let serverOk: boolean | null = null;
  // FR-09: every lamp keeps its words for screen readers and the tooltip, whatever the top bar shows (full text or a dot)
  const tip = (el: HTMLElement, base: string) => { el.dataset.base = base; const t = `${el.getAttribute('aria-label') ?? ''} — ${base}`; if (el.title !== t) el.title = t; };
  const setChip = (el: HTMLElement, state: '' | 'ok' | 'warn' | 'err', text: string, word: 'Camera' | 'Mic' | 'OBS' | 'Room') => {
    const cls = `chip ${state}`; if (el.className !== cls) el.className = cls; const t = `${text}`;
    if (el.dataset.t !== t) { el.dataset.t = t; el.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), t); }
    const lab = lampLabel(word, t); if (el.getAttribute('aria-label') !== lab) el.setAttribute('aria-label', lab);
    tip(el, el.dataset.base ?? '');
  };
  let lastAv = '';
  let wasInObs = false;
  const paintChips = () => {
    // livedash: the mini-bar in every other area while the studio is in use (camera on or OBS showing VTube Pro).
    // clarity (owner: "people wonder what they're live to"): the camera alone never counts as live. Red on the rail and
    // the jump from Home to Live Control happen only when OBS really shows VTube Pro (first time this session).
    const air = liveStudio.onAir(), inObs = liveStudio.inObs();
    liveStudio.miniBar.style.display = air && area !== 'onair' && isClassic() ? '' : 'none'; // (new layout: the show dock instead)
    const liveBtn = railBtns.get('onair');
    liveBtn?.classList.toggle('onair-live', inObs);
    liveBtn?.classList.toggle('onair-cam', air && !inObs);
    setStudioPresence(air, app.party.role !== 'none'); // (src/ui/keepAwake.ts)
    const airS = inObs ? 'live' : air ? 'ok' : '', airT = inObs ? 'In OBS' : app.trackingOn ? 'Camera on' : 'Not in OBS';
    if (airChip.dataset.t !== airT) {
      airChip.dataset.t = airT; airChip.className = `chip tb-air ${airS}`; airChip.replaceChildren(h('span', { class: 'dot' }), airT);
      airChip.title = `${inObs ? 'OBS is showing VTube Pro.' : app.trackingOn ? 'Your camera is on. OBS isn’t showing VTube Pro.' : 'OBS isn’t showing VTube Pro.'} Click for Live Control (Alt+L).`;
    }
    if (inObs && !wasInObs && area === 'home' && !app.observer) go('onair');
    wasInObs = inObs;
    const s = app.stats;
    if (serverOk === false) { setChip(chips.cam, 'err', 'Studio server offline — start VTube Pro again', 'Camera'); chips.mic.style.display = chips.obs.style.display = chips.room.style.display = 'none'; return; }
    chips.mic.style.display = chips.obs.style.display = chips.room.style.display = '';
    // (stall mode: tracking fell behind, usually a game holding the graphics card — src/tracking/stallGuard.ts; tracking
    //  carries on, on the processor. "Game mode" only with evidence of the card: src/ui/gameText.ts cardNamed)
    const si = app.tracker.gameMode ? app.tracker.stallInfo() : null;
    setChip(chips.cam, app.trackingOn ? (s.tracked && !si ? 'ok' : 'warn') : '', app.trackingOn ? (si ? stallChipText({ named: cardNamed(si.gpu, app.tracker.gpuStat), faceCpu: si.faceDelegate === 'CPU' }) : s.tracked ? 'Tracking' : 'No face') : 'Camera off', 'Camera');
    setChip(chips.mic, app.audio.active ? 'ok' : '', app.audio.active ? 'Mic' : 'Mic off', 'Mic');
    const n = pollObs();
    setChip(chips.obs, n > 0 ? 'ok' : '', n > 0 ? 'In OBS' : 'Not in OBS', 'OBS');
    tip(chips.obs, n > 0 ? 'OBS is showing VTube Pro. You go live when you press Start Streaming in OBS.' : 'VTube Pro isn’t in OBS yet. Click to set it up.');
    const sid = app.scene.effective.sceneId;
    const rn = sid ? app.scene.scenes.find((x) => x.id === sid)?.name ?? sid : 'No room';
    setChip(chips.room, sid ? 'ok' : '', rn.length > 22 ? `${rn.slice(0, 21)}…` : rn, 'Room');
    tip(chips.room, rn.length > 22 ? `${rn}. Click for Room` : 'Click for Room');
    const gl = app.gpuLine();
    // (s.fps counts studio preview frames only: "preview hidden" rather than a 0 fps that reads as broken; previewRate.ts)
    { const t = tuneOf(area) ? `${previewRateText(s.fps, studioViewHidden(document.body?.classList))}${app.trackingOn ? ` · track ${Math.round(s.trackFps ?? 0)} Hz · ${Math.round(s.latencyMs ?? s.inferMs)} ms lag` : ''}${gl.text ? ` · ${gl.text}` : ''}` : gl.text; if (chips.perf.textContent !== t) chips.perf.textContent = t; }   // (only when it changed: no 4×/s text-node swap + layout)
    chips.perf.title = gl.text ? `GPU tracking (Tracking → Advanced → Voice, phone & 2nd camera): ✓n = working, n results per second · ✗ = sidecar not connected (it restarts by itself) · idle = connected but no results reach the avatar` : '';
    if (gl.state === 'warn') chips.perf.style.color = 'var(--warn)'; else chips.perf.style.color = '';
    if (gl.text) chips.perf.style.display = ''; // the GPU status shows in Simple mode too
    chips.perf.title = `${tuneOf(area) ? `${PREVIEW_RATE_TIP}\n` : ''}face ${s.inferMs.toFixed(1)} ms · body ${(s.bodyMs ?? 0).toFixed(1)} ms · ${s.trackMode ?? ''}`;
    const p = app.profile;
    const sig = p ? `${p.id}|${p.name}|${p.thumbnail ?? ''}` : '';
    if (sig !== lastAv) {
      lastAv = sig;
      clear(avatarPill);
      avatarPill.append(p?.thumbnail ? h('img', { src: api.fileUrl(p, p.thumbnail), alt: '' }) : h('span', { class: 'ph' }, '☺'), h('span', null, p?.name ?? 'No avatar yet'));
    }
  };
  window.setInterval(paintChips, 250);
  const pollServer = async () => { try { await api.status(); serverOk = true; } catch { serverOk = false; } };
  void pollServer(); window.setInterval(pollServer, 10000);

  // ---------------------------------------------------------------- overlays
  function showShortcuts() {
    if (document.querySelector('.sc-back')) return;
    const prev = document.activeElement as HTMLElement | null;
    const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); e.preventDefault(); close(); } };
    // premium pass: the grouped sheet (src/ui/premium.ts); the short list stays in Settings (simple.ts shortcutList)
    const back = shortcutSheet({ close, onHelpers: () => { close(); go('settings'); }, onFirstRun: () => { close(); openNamed(app, 'firstRun'); }, onHelp: (t) => { close(); openHelp(t); } });
    document.body.append(back);
    window.addEventListener('keydown', onKey, true);
    (back.querySelector('.icon-btn') as HTMLElement | null)?.focus();
  }

  initHelpStyles();
  setHelpExtras({ shortcuts: () => showShortcuts() });
  initGuidesPage({ onChange: () => paintTop() });
  // the guides are a lazy chunk: fetch it once the studio is up, so Help / Guides work offline later
  window.setTimeout(() => preloadHelp(), 5000);

  // ---------------------------------------------------------------- first launch
  go(area, true);
  paintChips();
  const fr = wizardState('firstRun');
  const firstOpen = !existing && !fr.finished && !fr.step;
  // ux-simplicity (src/ui/guide): the Help button + tour, and for a brand-new user "What do you want to do?" first (its
  // "Go live now" opens this same first-time setup). Once that was answered, the old behaviour below applies.
  initGuide(app, { area: () => area, areaTitle: (a) => AREAS.find((x) => x.id === a)?.title ?? a, advanced: () => advOf(area), go: (a) => go(a as AreaId), showShortcuts }, { firstOpen });
  void import('./tutorials/index.ts').then((m) => m.mountTutorials(app, { go: (a) => go(a as AreaId), advanced: (a, s) => nav.advanced(a as AreaId, s), wizard: (id, at) => openNamed(app, id, at) })); // step-by-step tutorials (src/ui/tutorials)
  // (a registered first-run flow takes over from the old first-time wizard when it says it is due)
  if (firstOpen && !app.observer && !startHomeDue() && !wizardOpen()) setTimeout(() => { if (!openFirstRunIfDue()) openNamed(app, 'firstRun'); }, 600);
  else if (existing && !ls.get('vtp.ui.introSeen')) {
    ls.set('vtp.ui.introSeen', '1');
    setTimeout(() => toast('New look! Simple menus by default — every setting you had is under each area’s “Advanced” switch (top right of the panel). Press ? for shortcuts.', 'info', 9000), 1500);
  }
  // UX redesign: say once where the old arrangement is (never from an observer tab: it shares storage with the live one)
  if (!app.observer && !ls.get('vtp.ui.layout2')) {
    ls.set('vtp.ui.layout2', '1');
    if (existing && !isClassic()) setTimeout(() => toast('New layout: a grouped menu, one bell for notices and messages, a Tools menu and cards that fold. Nothing was removed. Prefer the old one? Settings > Look & feel > Layout: Classic.', 'info', 10000), 2600);
  }

  return {
    onApp(what) {
      if (what === 'library') invalidateSimpleLibrary();
      if (showing.startsWith('simple:')) {
        const a = showing.slice(7);
        if ((what === 'avatar' || what === 'costume' || what === 'library') && (a === 'me' || a === 'create')) refresh();
        else if ((what === 'tracking' || what === 'setup') && a === 'live') refresh();
        return;
      }
      if (what === 'avatar' && (showing === 'avatars' || showing === 'wardrobe' || showing === 'face' || showing === 'body')) renderPanel(app, showing, body);
      if (what === 'library' && showing === 'avatars') renderPanel(app, 'avatars', body);
      if (what === 'tracking' && showing === 'tracking') renderPanel(app, 'tracking', body);
    },
    isAdvanced: () => advOf(area),
    isTuning: () => tuneOf(area),
    showShortcuts,
    go,
  };
}

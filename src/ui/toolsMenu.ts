// UX redesign: the server's pages and tools, reachable from inside the studio in one place. Testers asked to "open local
// pages inside the studio": Chat Hub, Stream Deck & controllers, AI connectors and Tools & add-ons already open
// as a panel beside the stage (src/ui/dockTools.ts: the very same pages in a frame, "Pop out" for a second monitor);
// Guides is a page over the studio. They were spread over Home, Chat, Create and Settings: this menu (the
// top bar's Tools button, new layout only) and Home's "Tools" row list them all, with the same openers as before.
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { fitMenu } from './layoutMode.ts';
import { openChatHub } from './chatPanel.ts';
import { openDeck } from './deckOpen.ts';
import { openTool } from './dockTools.ts';
import { openGuides } from './help/guidesPage.ts';
import { hasTutorials, openTutorials, tutorialsLabel } from './tutorialsHook.ts';
import { firstRunLabel, hasFirstRun, openFirstRun } from './assistHooks.ts';

export interface ToolItem { id: string; icon: string; title: string; line: string; /** Home's tile */ short: string; run(from?: HTMLElement | null): void }
export interface ToolsHost { shortcuts(): void }

/** beta.12: other workstreams add their own page / tool here with ONE call from their own file (returns the remover);
 *  it shows after the built-in items, in the Tools menu (and wherever toolItems() is listed). */
const extraTools = new Map<string, ToolItem>();
export function registerTool(t: ToolItem): () => void { extraTools.set(t.id, t); return () => { if (extraTools.get(t.id) === t) extraTools.delete(t.id); }; }

/** Every tool / helper page, in the order the menu shows them. */
export function toolItems(host: ToolsHost): ToolItem[] {
  const seen = new Set<string>(); // one row per id (the built-in Tutorials row and the tutorials player's own registration)
  return ([
    { id: 'chathub', icon: 'chat', title: 'Chat Hub', line: 'Every chat, donation and alert in one panel beside the stage.', short: 'All chats in one panel', run: () => openChatHub() },
    { id: 'deck', icon: 'keys', title: 'Stream Deck & controllers', line: 'Buttons for your show: Stream Deck, MIDI, game pads, hotkeys.', short: 'Buttons for your show', run: () => openDeck() },
    { id: 'aiconnect', icon: 'aiapp', title: 'AI connectors', line: 'Connect Claude, ChatGPT or Grok to create with you.', short: 'Claude, ChatGPT, Grok', run: () => openTool('aiconnect') },
    { id: 'tools', icon: 'chip', title: 'Tools & add-ons', line: 'Blender, ffmpeg, free local AI and OBS plug-ins, checked on this PC.', short: 'Blender, local AI, plug-ins', run: () => openTool('tools') },
    { id: 'tutorials', icon: 'target', title: 'Tutorials', line: 'Step by step: we point at each button and wait for you.', short: 'Learn it step by step', run: () => void import('./tutorials/index.ts').then((m) => m.openTutorials()) },
    { id: 'guides', icon: 'book', title: 'Guides', line: 'Every guide, with search, as a page right here.', short: 'Every guide, right here', run: (from) => openGuides(undefined, from) },
    { id: 'mypc', icon: 'chip', title: 'What can my PC do?', line: 'Every feature: works, works slower, or not on this PC, and why.', short: 'What works on this PC', run: () => void import('./capabilityView.ts').then((m) => m.openCapabilityPage()) },
    { id: 'check', icon: 'check', title: 'Check my setup', line: 'What works, what needs a fix, and how to fix it.', short: 'What needs a fix', run: () => void import('./guide/helpCheck.ts').then((m) => m.openHelpCheck()) },
    { id: 'shortcuts', icon: 'keys', title: 'Keyboard shortcuts', line: 'Or press ? any time.', short: 'Or press ? any time', run: () => host.shortcuts() },
    // (beta.12: shown once a tutorials player registers itself: src/ui/tutorialsHook.ts)
    ...(hasTutorials() ? [{ id: 'tutorials', icon: 'play', title: tutorialsLabel(), line: 'Step-by-step help, played right here.', short: 'Step by step', run: () => openTutorials() }] : []),
    ...(hasFirstRun() ? [{ id: 'firstrun', icon: 'wand', title: firstRunLabel(), line: 'Camera, avatar, room and OBS, set up for you.', short: 'Set up for you', run: () => { openFirstRun(); } }] : []),
    ...extraTools.values(),
  ] as ToolItem[]).filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

let menu: HTMLElement | null = null;
let btnRef: HTMLButtonElement | null = null;
const outside = (e: Event) => { const t = e.target as Node; if (menu && !menu.contains(t) && !btnRef?.contains(t)) closeToolsMenu(); };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && menu) { e.preventDefault(); e.stopPropagation(); closeToolsMenu(); btnRef?.focus(); } };
export function closeToolsMenu() {
  if (!menu) return;
  menu.remove(); menu = null;
  btnRef?.setAttribute('aria-expanded', 'false'); btnRef?.classList.remove('on');
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', onKey, true);
}
export const toolsMenuOpen = () => !!menu;

function openMenu(host: ToolsHost, viaKeyboard: boolean) {
  if (menu) { closeToolsMenu(); return; }
  if (!btnRef) return;
  const from = btnRef;
  menu = h('div', { class: 'tl-menu', role: 'menu', 'aria-label': 'Tools', tabindex: -1, 'data-ui': 'tools-menu' },
    h('div', { class: 'tl-head' }, h('b', null, 'Tools'), h('span', null, 'Open beside the stage, or as a page here.')),
    ...toolItems(host).map((t) => h('button', { class: 'tl-mi', role: 'menuitem', type: 'button', 'data-tool': t.id, onClick: () => { closeToolsMenu(); t.run(from); } },
      h('span', { class: 'tl-ic', 'aria-hidden': 'true' }, icon(t.icon, 18)), h('span', null, h('b', null, t.title), h('span', null, t.line)))));
  document.body.append(menu);
  // cr-01: max height = innerHeight - top - 8 with its own scroll; a bottom sheet with Close at 600 px or less
  fitMenu(menu, { anchor: btnRef, close: () => { closeToolsMenu(); from.focus(); } });
  btnRef.setAttribute('aria-expanded', 'true'); btnRef.classList.add('on');
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', onKey, true);
  if (viaKeyboard) (menu.querySelector('.tl-mi') as HTMLElement | null)?.focus(); else menu.focus({ preventScroll: true });
}

/** The top bar's Tools button (new layout only: class ux-only). */
export function toolsButton(host: ToolsHost): HTMLButtonElement {
  if (!document.getElementById('vtp-tl-css')) document.head.append(h('style', { id: 'vtp-tl-css' }, CSS));
  btnRef = h('button', { class: 'icon-btn tl-btn ux-only', type: 'button', title: 'Tools: Chat Hub, Stream Deck, AI connectors, add-ons, guides', 'aria-label': 'Tools', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-ui': 'tools-button',
    onClick: (e: MouseEvent) => openMenu(host, e.detail === 0) }, icon('apps', 18)) as HTMLButtonElement;
  return btnRef;
}

const CSS = `
.tl-btn.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line2)); background: var(--accent-soft); }
.tl-menu { position: fixed; z-index: 9060; width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 90px); overflow-y: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text);
  border: 1px solid var(--line2); border-radius: 16px; padding: 8px; box-shadow: 0 30px 80px -24px #000d; }
.tl-menu:focus, .tl-menu:focus-visible { outline: none !important; }
body.clean .tl-menu { display: none; }
.tl-head { padding: 8px 10px 10px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.tl-head b { display: block; font-size: 15px; }
.tl-head span { color: var(--dim); font-size: 12.5px; }
.tl-mi { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: center; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 11px; background: none; color: var(--text); font: inherit; cursor: pointer; }
.tl-mi:hover, .tl-mi:focus-visible { background: var(--card2); outline: none; }
.tl-ic { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.tl-mi b { display: block; font-size: 13.5px; }
.tl-mi span > span { display: block; color: var(--dim); font-size: 12px; margin-top: 1px; line-height: 1.35; }
`;

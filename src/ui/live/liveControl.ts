// Live Control — a broadcast console (livedash, redesigned by livepremium, put into tabs by live-tabs). A PROGRAM
// monitor (the studio's own view, framed with an on-air tally and a lower third) with a "what viewers can't see right
// now" strip under it, and ONE row of labelled tabs beside it (shared/liveTabs.ts): Show · Cameras · Transitions ·
// Privacy · Guests · Audio · Chat & alerts · Me · OBS — each with an icon and a one-line "what this is for". The
// selected tab is remembered (localStorage vtp.live.tab). A thin health strip runs along the bottom. Used by the
// studio's "Live" area (src/ui/shell.ts) and the pop-out window (live.html → src/ui/live/popout.ts).
//
// Every button runs a Stream Deck registry action through /ws/deck (deckClient.ts); the lit state comes from the same
// server state the physical deck uses, plus the studio's liveStatus (party, outfits, emotes, health). Buttons can be
// pinned to the quick bar (= the on-air mini-bar), and quick bars saved as show presets (localStorage vtp.live.*).
// Destructive actions (kick, end party, End show) need a second click to confirm.
import { autoCamera, keyActive, lineupIndex, type DeckLiveState } from '../../../shared/deck.ts';
import { cameraDriverNote, quickActive } from '../../../shared/cameraHelp.ts';
import { reactShotNote } from '../../../shared/reactShot.ts';
import { DEFAULT_PRESETS, TILES, TURN_SETUP, defaultLayout, joinText, paintKey, quickKey, sanitizeLayout, sanitizePresets, spoutLabel, type LiveGreen, type LiveLayout, type LiveMember, type LivePreset, type LiveQuick, type LiveSpout, type LiveStatus, type TileId } from '../../../shared/liveControl.ts';
import { GR_PRESETS, HOST_MSG_MAX } from '../../../shared/greenroom.ts';
import { icon } from '../icons.ts';
import { deckClient } from './deckClient.ts';
import { CAMERA_MOVES, CURTAIN_SPEEDS, LIVE_TABS, nearestPreset, sanitizeTab, tabDef, type LiveTabId } from '../../../shared/liveTabs.ts';
import { CURTAIN_STYLES, CUT, SHUFFLE } from '../../scene/transition/styles.ts';
import { drawCurtainMini } from '../../scene/transition/mini.ts';
import { COVER_STYLES, coverStyle } from '../../scene/capcover/styles.ts';
import { drawCoverMini } from '../../scene/capcover/mini.ts';
import { HIDE_SCREEN_DEFAULT, comboConflict, comboLabel, comboOf, loadHideScreenKey, sanitizeCombo, saveHideScreenKey } from '../../../shared/hotkey.ts';
import { setHotkeyRecording } from './hideHotkey.ts';
import { THUMB_CSS, liveThumb } from './thumb.ts';
import { BrbOverlay, brbMediaEl } from '../../scene/brb/overlay.ts';
import { brbMediaOf, drawBrbCard } from '../../scene/brb/card.ts';
import { cancelStill, drawStill } from '../../scene/stillCache.ts';
import { BRB_BG_MAX, BRB_DEFAULT_TEXT, BRB_STYLES, sniffBrbMedia, type SceneBrbState } from '../../../shared/brb.ts';
import { createGoLiveTab, type GoLiveTab } from '../broadcast/goLiveTab.ts';
import { DEFAULT_LOOK, brbUsing, lookOfLive, lookRoute, lookToDeckRuns, type LiveLook, type LookPatch } from '../../../shared/liveLook.ts';
import { TRACK_PARTS, TRACK_PART_TEXT, type TrackPart, type TrackParts } from '../../../shared/trackParts.ts';
// beta.12 UX (owner feedback): a small / hidden studio view, folding pickers, room favourites, a Help / Tutorials hook
import { FOLD_KEY, PGM_KEY, PGM_SIZES, favFirst, foldOpen, parseFolds, parsePgmSize, type PgmSize } from '../../../shared/liveView.ts';
import { onRoomFavs, roomFavs, toggleRoomFav } from '../roomFavs.ts';
import { onTutorials, openTutorials, tutorialsLabel } from '../tutorialsHook.ts';

export interface LiveSource {
  status(): LiveStatus;
  onStatus(cb: () => void): void;
  /** False = buttons are shown but do nothing (an observer tab of the live studio). */
  canRun: boolean;
  popout: boolean;
  /** Studio only: "Streaming mode" (de-emphasise set-up menus). */
  streaming?: { get(): boolean; set(on: boolean): void };
  /** Studio only (docked): open the Chat Hub beside the console (a drawer, or its window if the user chose that). */
  openChat?(): void;
  /** Called ~4x/s while a guest-camera picture slot is on screen (moderation preview, green-room tile): the studio only
   *  grabs those thumbnails while someone asks. The sender throttles. */
  wantThumbs?(): void;
  /** Studio only: copy the guest link right here (the pop-out asks the studio over the bus instead). */
  copyLink?(): void;
  /** Studio only: show the studio's own view inside this frame (no second renderer). Returns the undo. */
  program?(frame: HTMLElement, overlays: HTMLElement[]): () => void;
  /** live-tabs: OBS tab → "Set up OBS automation" (the obs-wizard lane's wizard; see openObsWizard). */
  obsWizard?(): void;
  /** live-layout: the studio sets / reads the hider + BRB look on its own scene state (any helper version). The pop-out
   *  has none: it asks the helper, only when the helper knows looks (shared/liveLook.ts). */
  look?: { get(): LiveLook; set(p: LookPatch): { ok: boolean; error?: string }; saveError?(): { at: number; msg: string } | null; on?(cb: () => void): void };
  /** Studio only: the Hands / Body switches (shared/trackParts.ts; the same state as Simple → Tracking). The tracker
   *  lives in the studio page, so the pop-out has none and shows no row. `on` returns its unsubscribe. */
  tracking?: { get(): TrackParts; set(part: TrackPart, on: boolean): void; on(cb: () => void): () => void };
  toast(msg: string, kind?: 'ok' | 'warn' | 'err' | 'info'): void;
}

type Kid = Node | string | null | undefined | false;
/** Live → Transitions → "When OBS switches scenes" (live-tabs × obs-wizard): pick OBS's own scene transition + length
 *  through the helper, by document events the studio answers (src/ui/obsWizardHook.ts). Built once and kept across
 *  repaints. Not answered (a popped-out Live window, or no helper) → a plain note + "Set up OBS". */
let obsTrEl: HTMLElement | null = null;
function obsTransitionBox(): HTMLElement {
  if (obsTrEl) return obsTrEl;
  const box = el('div', { class: 'lc-row', style: 'flex-wrap:wrap;gap:8px' });
  obsTrEl = box;
  const say = (t: string) => box.replaceChildren(el('span', { class: 'lc-note', style: 'flex:1' }, t),
    el('button', { class: 'lc-btn s', onClick: () => { if (document.dispatchEvent(new CustomEvent('vtp:obs-wizard', { cancelable: true, detail: { from: 'live' } }))) say('Open the studio window to set up OBS (this pop-out can’t open it).'); } }, 'Set up OBS'),
    el('button', { class: 'lc-btn s', onClick: () => { obsTrEl = null; box.replaceWith(obsTransitionBox()); } }, 'Try again'));
  box.append(el('span', { class: 'lc-note' }, 'Asking OBS…'));
  type Tr = { ok: boolean; transitions: string[]; current: { name: string; ms: number | null } | null; lengths: number[]; error?: string };
  const asked = !document.dispatchEvent(new CustomEvent('vtp:obs-transitions', { cancelable: true, detail: { reply: (r: Tr | null) => {
    // (a raw network error such as "read ECONNRESET" means the same as "not connected": say it in plain words)
    if (!r?.ok || !r.transitions.length) { say(!r?.error || /ECONN|EPIPE|socket hang up|connection failed|stopped answering|not connected/i.test(r.error) ? 'OBS isn’t connected to VTube Pro yet. Open OBS, then press Set up OBS (once).' : r.error); return; }
    const name = el('select', { 'aria-label': 'OBS transition' }, ...r.transitions.map((t) => el('option', { value: t, selected: t === r.current?.name }, t))) as HTMLSelectElement;
    const lens = r.lengths.length ? r.lengths : [300, 500, 800, 1200];
    const ms = el('select', { 'aria-label': 'How long' }, ...lens.map((n) => el('option', { value: String(n), selected: n === (r.current?.ms ?? 300) }, `${(n / 1000).toFixed(1)} s`))) as HTMLSelectElement;
    const note = el('span', { class: 'lc-note', style: 'flex-basis:100%' }, r.current ? `Now: ${r.current.name}${r.current.ms ? ` · ${(r.current.ms / 1000).toFixed(1)} s` : ''}` : '');
    const use = el('button', { class: 'lc-btn s pri', onClick: () => {
      use.setAttribute('disabled', '');
      document.dispatchEvent(new CustomEvent('vtp:obs-transition', { cancelable: true, detail: { name: name.value, ms: Number(ms.value), reply: (x: { ok: boolean; summary: string; undoId: string | null; error?: string }) => {
        use.removeAttribute('disabled');
        if (!x.ok) { note.textContent = x.error ?? 'OBS didn’t take it. Is OBS still open?'; return; }
        note.replaceChildren(document.createTextNode(`✓ ${x.summary} `), ...(x.undoId ? [el('button', { class: 'lc-btn s', onClick: () => {
          document.dispatchEvent(new CustomEvent('vtp:obs-undo', { cancelable: true, detail: { id: x.undoId, reply: (u: { ok: boolean; error?: string }) => { note.textContent = u.ok ? 'Undone: OBS is back how it was.' : (u.error ?? 'Couldn’t undo.'); } } }));
        } }, 'Undo')] : []));
      } } }));
    } }, 'Use in OBS');
    box.replaceChildren(name, ms, use, note);
  } } }));
  if (!asked) say('OBS uses its own transition there. Open the studio (or set up OBS) to pick it from here.');
  return box;
}

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...kids: Kid[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value') (e as HTMLInputElement).value = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

const LS = { layout: 'vtp.live.layout', presets: 'vtp.live.presets', preset: 'vtp.live.preset', tab: 'vtp.live.tab', panes: 'vtp.live.panes', roomsFav: 'vtp.live.roomsFav' };
/** live-layout: the tabbed tiles' panes (the original console's Rooms | Guests | Chat & polls | Me, plus the new
 *  Privacy | Transitions | Audio | OBS). Show and Camera are always-visible tiles, as in the original. */
type Pane = 'rooms' | 'guests' | 'chat' | 'me' | 'privacy' | 'transitions' | 'audio' | 'obs' | 'golive';
const PANES: { id: Pane; label: string; icon: string; hint: string }[] = [
  { id: 'rooms', label: 'Rooms', icon: 'room', hint: 'Switch rooms. A card covers the change.' },
  { id: 'guests', label: 'Guests', icon: 'users', hint: 'Let people in, seat them, and control their camera and mic.' },
  { id: 'chat', label: 'Chat & polls', icon: 'chat', hint: 'Read chat, thank supporters, run polls, hide chat.' },
  { id: 'me', label: 'Me', icon: 'me', hint: 'Your outfit, emotes and face tracking.' },
  { id: 'privacy', label: 'Privacy', icon: 'shield', hint: 'Hide your screen, BRB, hide chat or guests. One click each way.' },
  { id: 'transitions', label: 'Transitions', icon: 'transition', hint: 'How the picture changes when you switch rooms or cameras.' },
  { id: 'audio', label: 'Audio', icon: 'speak', hint: 'What you and your guests hear, and your mic level.' },
  { id: 'obs', label: 'OBS', icon: 'stream', hint: 'Check that OBS can see VTube Pro, and switch OBS scenes.' },
  { id: 'golive', label: 'Go Live', icon: 'live', hint: 'Check your setup, go live, end the show, record, and save a clip.' },
];
const PANE_A: Pane[] = ['rooms', 'guests', 'chat', 'me'], PANE_B: Pane[] = ['golive', 'privacy', 'transitions', 'audio', 'obs'];
/** Any tab / pane id (old tab ids, Ctrl+K, junk) → a pane; `slot` keeps it inside that tile's group. */
function paneOf(v: unknown, slot?: 'a' | 'b'): Pane {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  const p: Pane = (PANES.some((x) => x.id === s) ? s : s === 'show' || s === 'scene' || s === 'cameras' || s === 'camera' ? 'rooms' : s === 'people' ? 'guests' : s === 'health' ? 'obs' : 'rooms') as Pane;
  if (slot === 'a' && !PANE_A.includes(p)) return 'rooms';
  if (slot === 'b' && !PANE_B.includes(p)) return 'privacy';
  return p;
}
const paneTab = (p: Pane): LiveTabId => (p === 'rooms' ? 'show' : p);
const lsGet = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
export const loadLayout = (): LiveLayout => { const v = lsGet(LS.layout); return v ? sanitizeLayout(v) : defaultLayout(); };
export const saveLayout = (l: LiveLayout) => { lsSet(LS.layout, l); document.dispatchEvent(new CustomEvent('vtp-live-layout')); };
const loadPresets = (): LivePreset[] => { const v = lsGet(LS.presets); return v ? sanitizePresets(v) : DEFAULT_PRESETS.map((p) => structuredClone(p)); };

// ---------------------------------------------------------------- design system (one type scale, 8-pt spacing, 40/32/24 controls)
export const CSS = `
.lc, .lc-mini, .lc-tip, .lc-pgm-tag, .lc-lt, .lc-pop {
  --lc-s1: 4px; --lc-s2: 8px; --lc-s3: 12px; --lc-s4: 16px; --lc-s5: 24px;
  --lc-h-l: 40px; --lc-h-m: 32px; --lc-h-s: 24px;
  --lc-f-cap: 11px; --lc-f-s: 12px; --lc-f-m: 13px; --lc-f-l: 15px; --lc-f-xl: 18px;
  --lc-bg0: var(--bg, #0e1015); --lc-bg1: var(--panel, #161920); --lc-bg2: var(--card, #1b1f28); --lc-bg3: var(--card2, #222733); --lc-bg4: var(--card3, #2a3040);
  --lc-text: var(--text, #eef1f6); --lc-dim: var(--dim, #a3abba); --lc-faint: var(--faint, #717a8b);
  --lc-edge: color-mix(in srgb, var(--lc-text) 9%, transparent); --lc-edge2: color-mix(in srgb, var(--lc-text) 16%, transparent);
  --lc-hi: color-mix(in srgb, #fff 5%, transparent);
  --lc-acc: var(--accent, #7bd88f); --lc-acc-ink: var(--accent-ink, #08130b);
  --lc-tally: #ff3b4e; --lc-next: #2fd27a; --lc-warn: #ffb454; --lc-err: #ff6b6b; --lc-ok: #3ddc84;
  --lc-shadow: 0 1px 0 var(--lc-hi) inset, 0 0 0 1px var(--lc-edge) inset, 0 10px 28px -18px #000c;
  --lc-dur: 150ms; --lc-ease: cubic-bezier(.2, .7, .2, 1);
  --lc-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  color: var(--lc-text);
}
:root[data-theme=light] :is(.lc, .lc-mini, .lc-tip, .lc-pgm-tag, .lc-lt, .lc-pop) { --lc-hi: #fff8; --lc-shadow: 0 0 0 1px var(--lc-edge) inset, 0 1px 2px #0000000d, 0 8px 24px -16px #0003; --lc-tally: #e5263a; --lc-next: #179d55; }
.lc { font-size: var(--lc-f-m); line-height: 1.3; display: flex; flex-direction: column; gap: var(--lc-s2); min-height: 0; height: 100%; }
.lc *, .lc-mini * { box-sizing: border-box; }
.lc button, .lc-mini button, .lc select { font: inherit; color: inherit; }
.lc button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.lc :focus-visible, .lc-mini :focus-visible { outline: 2px solid var(--focus, #8ab4ff); outline-offset: 2px; }
.lc svg { flex: none; }

/* header */
.lc-head { display: flex; align-items: center; gap: var(--lc-s2); min-height: var(--lc-h-l); flex-wrap: wrap; }
.lc-air { display: inline-flex; align-items: center; gap: 8px; height: var(--lc-h-m); padding: 0 12px 0 10px; border-radius: 999px; font-size: var(--lc-f-s); font-weight: 750; letter-spacing: .08em;
  background: var(--lc-bg3); color: var(--lc-dim); box-shadow: 0 0 0 1px var(--lc-edge) inset; transition: background var(--lc-dur) var(--lc-ease), color var(--lc-dur); white-space: nowrap; }
.lc-air i { width: 8px; height: 8px; border-radius: 50%; background: var(--lc-faint); }
.lc-air.on { background: var(--lc-tally); color: #fff; box-shadow: 0 0 0 1px #fff3 inset, 0 0 18px -4px var(--lc-tally); }
.lc-air.on i { background: #fff; animation: lc-pulse 1.6s ease-in-out infinite; }
/* clarity: the camera alone is not "on air" (nobody sees anything): a calm pill with a green dot, no red, no pulse */
.lc-air.cam { color: var(--lc-text); }
.lc-air.cam i { background: var(--lc-ok); }
@keyframes lc-pulse { 50% { opacity: .35; } }
.lc-title { font: 650 var(--lc-f-xl)/1 var(--font-display, inherit); letter-spacing: -.01em; margin: 0 var(--lc-s2) 0 var(--lc-s1); white-space: nowrap; }
.lc-quick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.lc-quick .lc-qlbl { font-size: var(--lc-f-cap); letter-spacing: .08em; text-transform: uppercase; color: var(--lc-faint); margin-right: 2px; }
.lc-sp { flex: 1; }
.lc-select { appearance: none; height: var(--lc-h-m); padding: 0 30px 0 12px; border-radius: 8px; border: 0; background: var(--lc-bg3) no-repeat right 10px center / 10px 6px; color: var(--lc-text);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  box-shadow: 0 0 0 1px var(--lc-edge) inset; font-weight: 550; cursor: pointer; max-width: 220px; }
.lc-select:hover { box-shadow: 0 0 0 1px var(--lc-edge2) inset; }

/* buttons: one family, three heights */
.lc-btn { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: var(--lc-h-m); padding: 0 12px; border: 0; border-radius: 8px;
  background: var(--lc-bg3); box-shadow: 0 0 0 1px var(--lc-edge) inset, 0 1px 0 var(--lc-hi) inset; font-weight: 580; white-space: nowrap;
  transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease), transform 90ms, color var(--lc-dur); }
.lc-btn:hover { background: var(--lc-bg4); box-shadow: 0 0 0 1px var(--lc-edge2) inset, 0 1px 0 var(--lc-hi) inset; }
.lc-btn:active { transform: translateY(1px) scale(.985); }
.lc-btn.s { height: var(--lc-h-s); padding: 0 9px; font-size: var(--lc-f-s); border-radius: 6px; gap: 5px; }
.lc-btn.l { height: var(--lc-h-l); padding: 0 16px; font-size: var(--lc-f-l); }
.lc-btn.ic { width: var(--lc-h-m); padding: 0; }
.lc-btn.ic.s { width: var(--lc-h-s); }
.lc-btn.on { background: color-mix(in srgb, var(--lc-acc) 20%, var(--lc-bg3)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-acc) 70%, transparent) inset; color: var(--lc-text); }
.lc-btn.pri { background: var(--lc-acc); color: var(--lc-acc-ink); box-shadow: 0 1px 0 #fff4 inset, 0 6px 16px -8px var(--lc-acc); }
.lc-btn.pri:hover { filter: brightness(1.06); }
.lc-btn.danger { color: var(--lc-err); }
.lc-btn.arm { background: var(--lc-err); color: #fff; box-shadow: none; }
.lc-btn.pin { outline: 1.5px dashed var(--lc-warn); outline-offset: 1px; }
.lc-btn:disabled { opacity: .45; cursor: default; }
.lc-btn.live { color: var(--lc-text); }
.lc-btn.live::after { content: ""; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--lc-tally); }

/* segmented control */
.lc-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; min-width: 0; }
.lc-seg > button { flex: 1 1 auto; height: calc(var(--lc-h-m) - 6px); padding: 0 11px; border: 0; border-radius: 7px; background: transparent; color: var(--lc-dim); font-weight: 580; white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background var(--lc-dur) var(--lc-ease), color var(--lc-dur), box-shadow var(--lc-dur); }
.lc-seg > button:hover { color: var(--lc-text); background: var(--lc-hi); }
.lc-seg > button.on { background: var(--lc-bg4); color: var(--lc-text); box-shadow: 0 1px 2px #0005, 0 0 0 1px var(--lc-edge2) inset; }
.lc-seg.s > button { height: calc(var(--lc-h-s) - 2px); padding: 0 8px; font-size: var(--lc-f-s); }
.lc-seg.full { display: flex; }

/* panels */
.lc-panel { background: var(--lc-bg2); border-radius: 14px; box-shadow: var(--lc-shadow); padding: var(--lc-s3); display: flex; flex-direction: column; gap: var(--lc-s2); min-width: 0; min-height: 0; }
.lc-ph { display: flex; align-items: center; gap: var(--lc-s2); min-height: var(--lc-h-s); color: var(--lc-dim); }
.lc-ph h3 { margin: 0; font-size: var(--lc-f-cap); font-weight: 700; letter-spacing: .09em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.lc-ph .lc-count { font: 600 var(--lc-f-cap)/1 var(--lc-mono); padding: 3px 6px; border-radius: 6px; background: var(--lc-bg3); color: var(--lc-text); }
.lc-scroll { overflow: auto; min-height: 0; scrollbar-width: thin; }
.lc-note { color: var(--lc-faint); font-size: var(--lc-f-s); }
.lc-lbl { font-size: var(--lc-f-cap); font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--lc-faint); }
.lc-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }

/* console grid */
.lc-main { flex: 1; min-height: 0; display: grid; gap: var(--lc-s3);
  grid-template-columns: minmax(0, min(var(--lc-pgm-col, 60%), 64%)) minmax(340px, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, var(--lc-sec-h, 300px));
  grid-template-areas: "L R" "sec sec"; }
.lc-col { display: flex; flex-direction: column; gap: var(--lc-s3); min-height: 0; min-width: 0; }
.lc-colL { grid-area: L; } .lc-colR { grid-area: R; } .lc-a-sec { grid-area: sec; }
.lc-colL > .lc-pgm { flex: 1 1 auto; } .lc-col > :is(.lc-a-cam, .lc-a-show) { flex: none; } .lc-colR > .lc-a-rooms { flex: 1 1 auto; } .lc-colR > .lc-tabs { flex: 1.25 1 0; }
.lc-a-rooms { overflow: hidden; }
.lc-rooms-wrap { flex: 1 1 auto; min-height: 64px; }
.lc-sec { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: var(--lc-s3); min-height: 0; }

/* PROGRAM monitor */
.lc-pgm { background: #07080b; border-radius: 16px; box-shadow: 0 0 0 1px #ffffff12 inset, 0 12px 32px -16px #000; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 10px;
  container-type: size; position: relative; }
/* In the studio the live picture is #viewport (position: fixed, z-index 60, liveStudio.ts) laid over this frame. The frame
   must paint UNDER it: z-index 0 keeps its own stacking context (tag / lower third / BRB stay ordered) without climbing over
   the studio view, and the picture box is see-through there. (It used to be z-index 70 over an opaque #0b0d12 box: PROGRAM
   rendered solid black in every writable studio. Observer tabs hid it: .lc-ro's opacity made .lc a stacking context.) */
.lc-pgm-frame { position: relative; z-index: 0; width: min(100cqw, 100cqh * 16 / 9); aspect-ratio: 16 / 9; border-radius: 10px; pointer-events: none;
  box-shadow: 0 0 0 2px #2a2f3b; transition: box-shadow 180ms var(--lc-ease); }
.lc-pgm-frame.air { box-shadow: 0 0 0 3px var(--lc-tally), 0 0 28px -6px var(--lc-tally); }
.lc-pgm-pic { position: absolute; inset: 0; border-radius: 10px; overflow: hidden; background: transparent center / cover no-repeat; }
.lc-pgm-pic.popout { background-color: #0b0d12; }
.lc-pgm-pic.popout::after { content: ""; position: absolute; inset: 0; background: linear-gradient(#0008, #000a); }
.lc-pgm-msg { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: #cfd5e2; font-size: var(--lc-f-m); text-align: center; padding: 16px; z-index: 1; }
.lc-pgm-msg b { font-size: var(--lc-f-l); color: #fff; }
.lc-pgm-tag { position: absolute; top: 10px; left: 10px; display: flex; gap: 6px; z-index: 50; pointer-events: none; }
.lc-pgm-tag span { font: 750 10.5px/1 var(--font-ui, inherit); letter-spacing: .12em; padding: 5px 7px; border-radius: 5px; background: #000a; color: #fff; backdrop-filter: blur(6px); white-space: nowrap; }
/* (a narrow studio view, a phone: whole tags move to a second row instead of breaking inside) */
.lc-pgm-tag { right: 10px; flex-wrap: wrap; align-items: flex-start; }
.lc-pgm-tag .t-air { background: var(--lc-tally); }
.lc-pgm-tag .t-off { color: #aab; }
.lc-lt { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: stretch; z-index: 50; max-width: calc(100% - 24px); pointer-events: none; }
.lc-lt > div { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 7px 12px; background: #0b0d12d9; backdrop-filter: blur(8px); color: #fff; border-radius: 0 8px 8px 0; min-width: 0; box-shadow: 0 0 0 1px #ffffff14 inset; }
.lc-lt::before { content: ""; width: 4px; border-radius: 8px 0 0 8px; background: var(--lc-tally); flex: none; }
.lc-lt.off::before { background: #5b6475; }
.lc-lt .l1 { font-weight: 700; font-size: var(--lc-f-l); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-lt .l2 { font-size: var(--lc-f-s); color: #c3c9d6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* rooms */
.lc-rooms { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: var(--lc-s2); align-content: start; }
.lc-room { position: relative; padding: 0; border: 0; border-radius: 10px; background: var(--lc-bg3); text-align: left; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 0 0 1px var(--lc-edge) inset; transition: box-shadow var(--lc-dur) var(--lc-ease), transform 120ms var(--lc-ease); }
.lc-room:hover { transform: translateY(-1px); box-shadow: 0 0 0 1px var(--lc-edge2) inset, 0 8px 18px -12px #000; }
.lc-room .th { position: relative; aspect-ratio: 16 / 9; background: linear-gradient(135deg, var(--lc-bg4), var(--lc-bg1)) center / cover no-repeat; display: flex; align-items: center; justify-content: center; color: var(--lc-faint); }
.lc-room .nm, .lc-of .nm { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.25; min-height: 2.5em; max-height: 2.5em; overflow-wrap: anywhere; }
.lc.lc-compact .lc-cb .flag { display: none; }
.lc-room .nm { margin: 6px 8px; font-size: var(--lc-f-s); font-weight: 600; min-height: 2.5em; }
/* clarity: the room you're in, not a "LIVE" room (it said LIVE with nobody watching): the accent, never the red tally */
.lc-room.on { box-shadow: 0 0 0 2px var(--lc-acc) inset, 0 0 20px -8px var(--lc-acc); }
.lc-room.on::after { content: "IN USE"; position: absolute; top: 6px; right: 6px; font: 750 9.5px/1 var(--font-ui, inherit); letter-spacing: .12em; color: var(--lc-acc-ink); background: var(--lc-acc); padding: 3px 5px; border-radius: 4px; }
.lc-room.on .th { box-shadow: 0 -2px 0 var(--lc-acc) inset; }

/* marquee for names that don't fit */
.lc-mq { display: block; overflow: hidden; white-space: nowrap; }
.lc-mq > span { display: inline-block; }
.lc-mq.over > span { transition: transform 0s; }
.lc-mq.over { -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); mask-image: linear-gradient(90deg, #000 85%, transparent); }
:is(button, .lc-mqh):hover .lc-mq.over { -webkit-mask-image: none; mask-image: none; }
:is(button, .lc-mqh):hover .lc-mq.over > span { transform: translateX(var(--mq, 0px)); transition: transform var(--mq-t, 2s) linear .35s; }

/* show-state "scene buttons" */
.lc-states { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--lc-s2); }
.lc-sb { position: relative; height: 76px; border: 0; border-radius: 12px; background: var(--lc-bg3); display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-end; gap: 2px; padding: 10px 12px; text-align: left;
  box-shadow: 0 0 0 1px var(--lc-edge) inset, 0 1px 0 var(--lc-hi) inset; transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease), transform 90ms; overflow: hidden; }
.lc-sb svg { position: absolute; top: 10px; left: 12px; color: var(--lc-dim); transition: color var(--lc-dur); }
.lc-sb b { font-size: var(--lc-f-l); font-weight: 650; }
.lc-sb small { font-size: var(--lc-f-cap); color: var(--lc-faint); white-space: nowrap; }
.lc-sb:hover { background: var(--lc-bg4); }
.lc-sb:active { transform: scale(.98); }
.lc-sb.on { background: color-mix(in srgb, var(--lc-tally) 16%, var(--lc-bg3)); box-shadow: 0 0 0 2px var(--lc-tally) inset, 0 0 22px -10px var(--lc-tally); }
.lc-sb.on svg { color: var(--lc-tally); }
.lc-sb.on::after { content: ""; position: absolute; top: 12px; right: 12px; width: 8px; height: 8px; border-radius: 50%; background: var(--lc-tally); box-shadow: 0 0 8px var(--lc-tally); }

/* camera switcher */
.lc-cams { display: flex; gap: var(--lc-s2); min-width: 0; }
.lc-cams .grp { display: flex; gap: var(--lc-s2); min-width: 0; flex: 1; }
.lc-cb { position: relative; flex: 1 1 0; min-width: 88px; height: 80px; border: 0; border-radius: 12px; background: var(--lc-bg3); padding: 12px 10px 8px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 5px;
  box-shadow: 0 0 0 1px var(--lc-edge) inset, 0 1px 0 var(--lc-hi) inset; transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease), transform 90ms; overflow: hidden; }
.lc-cb::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: transparent; transition: background var(--lc-dur); }
.lc-cb:hover { background: var(--lc-bg4); }
.lc-cb:active { transform: scale(.98); }
.lc-cb .no { position: absolute; top: 9px; left: 10px; font: 700 var(--lc-f-cap)/1 var(--lc-mono); color: var(--lc-faint); }
.lc-cb .nm { font-weight: 650; font-size: var(--lc-f-m); max-width: 100%; }
.lc-cb .av { width: 30px; height: 30px; }
.lc-cb.pgm { background: color-mix(in srgb, var(--lc-tally) 18%, var(--lc-bg3)); box-shadow: 0 0 0 2px var(--lc-tally) inset; }
.lc-cb.pgm::before { background: var(--lc-tally); }
.lc-cb.pvw { box-shadow: 0 0 0 2px var(--lc-next) inset; }
.lc-cb.pvw::before { background: var(--lc-next); }
.lc-cb:is(.pgm, .pvw) .no { visibility: hidden; }
.lc-cb .flag { position: absolute; top: 8px; left: 8px; font: 750 9.5px/1 var(--font-ui, inherit); letter-spacing: .1em; padding: 3px 5px; border-radius: 4px; color: #fff; }
.lc-cb.pgm .flag { background: var(--lc-tally); } .lc-cb.pvw .flag { background: var(--lc-next); }
.lc-cb.auto { flex: 0 0 104px; }
.lc-cb.auto.on { background: color-mix(in srgb, var(--lc-warn) 18%, var(--lc-bg3)); box-shadow: 0 0 0 2px var(--lc-warn) inset; }
.lc-cb.auto.on::before { background: var(--lc-warn); }
.lc-cb.auto svg { color: var(--lc-dim); } .lc-cb.auto.on svg { color: var(--lc-warn); }
.lc-cb[disabled] { opacity: .5; }
.lc-camfoot { display: flex; align-items: center; gap: var(--lc-s2); flex-wrap: wrap; }
/* scene cameras outside Interview: more shots, they wrap; room presets as chips */
.lc-cams.scn .grp { flex-wrap: wrap; }
.lc-cams.scn .lc-cb { height: 66px; min-width: 84px; flex: 1 1 84px; }
.lc-cams.scn .lc-cb.out { opacity: .55; }
.lc-presets { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* people in the room */
.lc-guest .st { font-size: var(--lc-f-cap); letter-spacing: .06em; text-transform: uppercase; font-weight: 700; color: var(--lc-faint); white-space: nowrap; }
.lc-guest .st.in { color: var(--lc-tally); }
.lc-guest.me { background: color-mix(in srgb, var(--lc-acc) 7%, var(--lc-bg3)); }
.lc-guest.outside .av { opacity: .5; }
.lc-ent { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-top: 4px; }
.lc-camhint { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: color-mix(in srgb, var(--lc-warn) 12%, transparent); color: var(--lc-text); font-size: var(--lc-f-s); }

/* avatars / initials */
.av { position: relative; flex: none; width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: #fff;
  background: linear-gradient(135deg, hsl(var(--h, 250) 70% 58%), hsl(calc(var(--h, 250) + 40) 70% 42%)); box-shadow: 0 0 0 1px #fff2 inset; }
.av .tvb { position: absolute; right: -4px; bottom: -4px; width: 18px; height: 18px; border-radius: 50%; background: var(--lc-bg1); color: var(--lc-text); display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 1px var(--lc-edge2); }
.av.talk { box-shadow: 0 0 0 2px var(--lc-bg2), 0 0 0 4px var(--lc-ok); animation: lc-talk 1.2s ease-in-out infinite; }
@keyframes lc-talk { 50% { box-shadow: 0 0 0 2px var(--lc-bg2), 0 0 0 5px color-mix(in srgb, var(--lc-ok) 55%, transparent); } }

/* guests */
.lc-guest { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; column-gap: 10px; row-gap: 6px; align-items: center; padding: 8px 10px; min-height: 56px; border-radius: 10px; background: var(--lc-bg3); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-guest .av { width: 36px; height: 36px; font-size: 12.5px; }
.lc-guest .who { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 650; }
.lc-guest .who .lc-mq { min-width: 0; }
.lc-guest .tag { font-size: 10px; font-weight: 700; letter-spacing: .06em; padding: 2px 5px; border-radius: 4px; background: var(--lc-bg1); color: var(--lc-dim); white-space: nowrap; }
.lc-guest .talking { display: none; align-items: flex-end; gap: 2px; height: 12px; }
.lc-guest .talking i { width: 3px; background: var(--lc-ok); border-radius: 2px; animation: lc-eq .9s ease-in-out infinite; }
.lc-guest .talking i:nth-child(2) { animation-delay: .15s; } .lc-guest .talking i:nth-child(3) { animation-delay: .3s; }
.lc-guest.speaking .talking { display: inline-flex; }
@keyframes lc-eq { 0%, 100% { height: 4px; } 50% { height: 12px; } }
.lc-guest .ctl { grid-column: 3; grid-row: 1; display: flex; gap: 6px; align-items: center; }
.lc-guest > .lc-btn { grid-column: 4; grid-row: 1; }
.lc-guest > .lc-acts { grid-column: 4; grid-row: 1; display: flex; gap: 6px; align-items: center; }
.lc-guest.knock .ctl { grid-column: 3 / 5; }
.lc-narrow .lc-guest, .lc-compact .lc-guest { grid-template-columns: auto minmax(0, 1fr) auto; }
.lc-narrow .lc-guest .ctl, .lc-compact .lc-guest .ctl { grid-column: 2 / 4; grid-row: 2; }
.lc-narrow .lc-guest > .lc-btn, .lc-compact .lc-guest > .lc-btn { grid-column: 3; }
.lc-narrow .lc-guest .av, .lc-compact .lc-guest .av { grid-row: span 2; }
.lc-guest.knock { background: color-mix(in srgb, var(--lc-warn) 12%, var(--lc-bg3)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-warn) 60%, transparent) inset; }
.lc-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 8px; padding: 8px; }
.lc-empty .ic { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; background: var(--lc-bg3); color: var(--lc-dim); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-empty b { font-size: var(--lc-f-l); }
.lc-steps { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; color: var(--lc-faint); font-size: var(--lc-f-s); }
.lc-steps span { display: inline-flex; align-items: center; gap: 5px; }
.lc-steps b { font: 700 10px/1 var(--lc-mono); width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--lc-bg3); color: var(--lc-dim); }

/* chat & polls */
.lc-chatgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.lc-chatgrid .lc-btn { flex-direction: column; height: 56px; gap: 4px; font-size: var(--lc-f-s); padding: 0 4px; }
.lc-poll { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; background: var(--lc-bg3); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-poll .q { display: flex; align-items: center; gap: 8px; font-weight: 650; }
.lc-poll .q .lc-mq { flex: 1; min-width: 0; }
.lc-livepill { font: 750 9.5px/1 var(--font-ui, inherit); letter-spacing: .1em; padding: 3px 5px; border-radius: 4px; background: var(--lc-tally); color: #fff; flex: none; }
.lc-livepill.open { background: var(--lc-acc); color: var(--lc-acc-ink); }
.lc-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; font-size: var(--lc-f-s); align-items: center; }
.lc-bar .trk { grid-column: 1 / 3; height: 6px; border-radius: 3px; background: var(--lc-bg1); overflow: hidden; }
.lc-bar .trk i { display: block; height: 100%; border-radius: 3px; background: var(--lc-acc); transition: width 400ms var(--lc-ease); }
.lc-bar.win .trk i { background: var(--lc-warn); }
.lc-bar .v { font: 600 var(--lc-f-s)/1 var(--lc-mono); color: var(--lc-dim); }

/* me */
.lc-outfits { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
.lc-of { border: 0; padding: 0; border-radius: 10px; background: var(--lc-bg3); overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 0 0 1px var(--lc-edge) inset; transition: box-shadow var(--lc-dur); text-align: left; }
.lc-of .th { position: relative; aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center; font-weight: 750; font-size: 17px; color: #fff; background: linear-gradient(135deg, hsl(var(--h, 200) 55% 45%), hsl(calc(var(--h, 200) + 50) 60% 30%)) center / cover no-repeat; }
.lc-of .nm { margin: 5px 7px; font-size: 11.5px; font-weight: 600; min-height: 2.5em; }
.lc-of:hover { box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-of.on { box-shadow: 0 0 0 2px var(--lc-acc) inset; }
.lc-of.on .nm::before { content: "\\2713  "; color: var(--lc-acc); }
.lc-emotes { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 6px; }
.lc-emotes .lc-btn { height: 40px; padding: 0; font-size: 19px; }
/* an emote without an icon shows its name (it showed garbled initials: "T(", "E/") */
.lc-emotes .lc-btn.txt { grid-column: span 2; font-size: 11px; font-weight: 600; line-height: 1.15; padding: 0 6px; white-space: normal; text-align: center; }
.lc-chipset { display: flex; flex-wrap: wrap; gap: 6px; }
.lc-meta { display: flex; align-items: center; gap: 8px; font-size: var(--lc-f-s); color: var(--lc-dim); }

/* tabs (compact) */
.lc-tabs { display: flex; flex-direction: column; min-height: 0; gap: var(--lc-s2); }
.lc-tabs > .lc-seg { align-self: flex-start; }
.lc-tabs > .lc-panel { flex: 1; }
.lc-seg .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lc-tally); }

/* health strip */
.lc-health { display: flex; align-items: center; gap: var(--lc-s4); height: 32px; padding: 0 var(--lc-s3); border-radius: 10px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; font-size: var(--lc-f-s); color: var(--lc-dim); overflow: hidden; flex: none; }
.lc-pip { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.lc-pip i { width: 7px; height: 7px; border-radius: 50%; background: var(--lc-faint); box-shadow: 0 0 0 2px color-mix(in srgb, var(--lc-faint) 20%, transparent); transition: background var(--lc-dur), box-shadow var(--lc-dur); }
.lc-pip.ok i { background: var(--lc-ok); box-shadow: 0 0 0 2px color-mix(in srgb, var(--lc-ok) 22%, transparent), 0 0 6px var(--lc-ok); }
.lc-pip.warn i { background: var(--lc-warn); box-shadow: 0 0 0 2px color-mix(in srgb, var(--lc-warn) 22%, transparent); }
.lc-pip.err i { background: var(--lc-err); box-shadow: 0 0 0 2px color-mix(in srgb, var(--lc-err) 22%, transparent); }
.lc-pip b { color: var(--lc-text); font-weight: 600; }
.lc-pip .v { font-family: var(--lc-mono); font-size: 11.5px; }
.lc-pip .mtr { width: 44px; height: 5px; border-radius: 3px; background: var(--lc-bg3); overflow: hidden; }
.lc-pip .mtr u { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--lc-ok) 70%, var(--lc-warn) 88%, var(--lc-err)); background-size: 44px 100%; transition: width 90ms linear; }
.lc-health .warnmsg { color: var(--lc-warn); font-weight: 600; }

/* tooltip */
.lc-tip { position: fixed; z-index: 10000; pointer-events: none; max-width: 280px; padding: 8px 10px; border-radius: 9px; background: #10131a; color: #eef1f6; font: 12px/1.35 var(--font-ui, "Segoe UI", system-ui, sans-serif);
  box-shadow: 0 0 0 1px #ffffff1c inset, 0 12px 28px -10px #000c; opacity: 0; transform: translateY(3px); transition: opacity 120ms, transform 120ms; }
.lc-tip.show { opacity: 1; transform: none; }
.lc-tip b { display: block; font-size: 12.5px; margin-bottom: 2px; }
.lc-tip .h { color: #a3abba; }
.lc-tip .k { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: #c9cfdb; }
.lc-tip kbd { font: 600 10.5px/1 var(--lc-mono, monospace); padding: 3px 5px; border-radius: 4px; background: #262c3a; box-shadow: 0 -1px 0 #0006 inset; color: #fff; }

/* customise */
.lc-edit .lc-panel, .lc-edit .lc-pgm { outline: 1.5px dashed color-mix(in srgb, var(--lc-acc) 70%, transparent); outline-offset: 2px; }
.lc-hiddenbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.lc-ro { opacity: .92; }

/* ---- responsive: compact (1366×768-ish) ---- */
.lc.lc-compact { gap: 6px; }
.lc.lc-compact .lc-main { gap: var(--lc-s2); grid-template-columns: minmax(0, min(var(--lc-pgm-col, 56%), 60%)) minmax(320px, 1fr); grid-template-rows: minmax(0, 1fr); grid-template-areas: "L R"; }
.lc.lc-compact .lc-col { gap: var(--lc-s2); }
.lc.lc-compact .lc-states { gap: 6px; }
.lc.lc-compact .lc-sb { height: 56px; padding: 7px 9px; } .lc.lc-compact .lc-sb svg { top: 7px; left: 9px; width: 16px; height: 16px; } .lc.lc-compact .lc-sb small { display: none; }
.lc.lc-compact .lc-cb { height: 64px; min-width: 64px; padding: 8px 6px 6px; } .lc.lc-compact .lc-cb .av { width: 24px; height: 24px; font-size: 10px; }
.lc.lc-compact .lc-cb.auto { flex-basis: 80px; }
/* docked: a tool drawer can squeeze the studio: scene / camera labels shrink instead of clipping */
.lc.lc-compact .lc-sb b { font-size: clamp(11px, 1.05vw, var(--lc-f-l)); letter-spacing: -.01em; white-space: nowrap; }
.lc.lc-compact .lc-cb { min-width: 44px; } .lc.lc-compact .lc-cb .nm { font-size: clamp(11px, 1vw, var(--lc-f-m)); }
.lc.lc-compact .lc-panel { padding: 10px; }
.lc.lc-compact .lc-rooms { grid-template-columns: repeat(auto-fill, minmax(var(--lc-room-min, 128px), 1fr)); gap: 6px; }
.lc.lc-compact .lc-a-show { padding: 8px 10px; gap: 6px; }
.lc.lc-compact .lc-a-show .lc-seg > button { height: 22px; padding: 0 8px; font-size: var(--lc-f-s); }
.lc.lc-compact .lc-a-show .lc-row .lc-btn { height: var(--lc-h-s); }
.lc.lc-compact .lc-tabs .lc-seg > button { height: 24px; font-size: var(--lc-f-s); padding: 0 9px; }
/* (spacing as margin: the name box is a fixed two lines tall, border-box padding inside it cut the second line in half) */
.lc.lc-compact .lc-room .nm { padding: 0; margin: 5px 7px 6px; }
.lc.lc-compact .lc-head { min-height: var(--lc-h-m); }
.lc.lc-compact .lc-quick { display: none; }
.lc.lc-compact.lc-edit .lc-quick { display: flex; }
.lc.lc-compact .lc-chatgrid .lc-btn { height: 44px; }
/* room cards: the picture never grows past --lc-th-max, so a wide column shows more rooms instead of taller cards */
.lc-room .th { max-height: var(--lc-th-max, 108px); }
.lc.lc-compact .lc-tabpanel .lc-rooms { grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); }
/* ---- tall (a window taller than the PROGRAM column needs, e.g. 1092x1114): PROGRAM is exactly 16:9 (no letterbox
   bars), Camera under it; the room / people / chat / me row takes the rest of the height along the bottom ---- */
.lc.lc-tall .lc-main { grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "L R" "sec sec"; }
.lc.lc-tall .lc-colL { container-type: inline-size; }
.lc.lc-tall .lc-colL > .lc-pgm { flex: none; height: calc((100cqw - 20px) * 9 / 16 + 20px); }
.lc.lc-tall .lc-colR { contain: size; }

/* ---- responsive: narrow (OBS dock, ~420 px) — one column, the column scrolls ---- */
.lc.lc-narrow { height: auto; }
.lc.lc-narrow .lc-main, .lc.lc-narrow .lc-col { display: flex; flex-direction: column; gap: var(--lc-s2); }
.lc.lc-narrow .lc-a-rooms { overflow: visible; }
.lc.lc-narrow .lc-a-show { display: flex; }
.lc.lc-narrow .lc-pgm { height: auto; padding: 6px; container-type: inline-size; }
.lc.lc-narrow .lc-pgm-frame { width: 100%; }
.lc.lc-narrow .lc-states { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
.lc.lc-narrow .lc-sb { height: 52px; padding: 6px 7px; border-radius: 10px; } .lc.lc-narrow .lc-sb b { font-size: var(--lc-f-s); } .lc.lc-narrow .lc-sb small { display: none; } .lc.lc-narrow .lc-sb svg { top: 6px; left: 7px; width: 15px; height: 15px; }
.lc.lc-narrow .lc-sb.on::after { top: 7px; right: 7px; width: 6px; height: 6px; }
.lc.lc-narrow .lc-cams { flex-direction: column; }
.lc.lc-narrow .lc-cams .grp { flex-wrap: wrap; }
.lc.lc-narrow .lc-cb { flex: 1 1 calc(33% - 8px); height: 60px; min-width: 0; }
.lc.lc-narrow .lc-cb.auto { flex: 1 1 100%; height: 40px; flex-direction: row; justify-content: center; padding: 6px; }
.lc.lc-narrow .lc-rooms { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.lc.lc-narrow .lc-health { flex-wrap: wrap; height: auto; padding: 6px 10px; gap: 6px 14px; order: -1; }
.lc.lc-narrow .lc-quick { display: none; }
.lc.lc-narrow .lc-title { display: none; }
.lc.lc-narrow .lc-rooms-wrap { max-height: 240px; }
.lc.lc-narrow .lc-ph { flex-wrap: wrap; row-gap: 6px; }
.lc.lc-narrow .lc-ph > .lc-seg { width: 100%; }
.lc.lc-narrow .lc-a-show { order: -1; }
.lc.lc-narrow .lc-head .lc-select { flex: 1; max-width: none; }

/* docked: people-in-this-shot popover (right-click / long-press / the ⋯ on a camera button) */
.lc-cb .more { position: absolute; top: 5px; right: 5px; width: 22px; height: 18px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font: 700 13px/1 var(--font-ui, inherit);
  color: var(--lc-dim); background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge2) inset; opacity: 0; transition: opacity var(--lc-dur); z-index: 2; }
.lc-cb:hover .more, .lc-cb:focus-visible .more, .lc-cb.popon .more { opacity: 1; }
.lc-cb .more:hover { color: var(--lc-text); background: var(--lc-bg4); }
.lc-cb.popon { box-shadow: 0 0 0 2px var(--lc-acc) inset; }
@media (hover: none) { .lc-cb .more { opacity: .8; } }
.lc-pop { position: fixed; z-index: 9000; width: 380px; max-width: calc(100vw - 16px); max-height: min(72vh, 540px); overflow: auto; background: var(--lc-bg2); border-radius: 14px; padding: 12px;
  box-shadow: 0 0 0 1px var(--lc-edge2) inset, 0 18px 48px -12px #000d; font-size: var(--lc-f-m); line-height: 1.3; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
.lc-pop * { box-sizing: border-box; }
.lc-pop button { font: inherit; color: inherit; cursor: pointer; }
.lc-pop :focus-visible { outline: 2px solid var(--focus, #8ab4ff); outline-offset: 2px; }
.lc-pop .ph { display: flex; align-items: center; gap: 8px; }
.lc-pop .ph b { font-size: var(--lc-f-l); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-pop .who { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; padding: 8px; border-radius: 10px; background: var(--lc-bg3); }
.lc-pop .who.out { opacity: .62; }
.lc-pop .who .av { width: 32px; height: 32px; }
.lc-pop .who .nm { font-weight: 650; min-width: 0; display: flex; gap: 6px; align-items: center; }
.lc-pop .who .nm > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-pop .who .st { font-size: var(--lc-f-cap); letter-spacing: .06em; text-transform: uppercase; font-weight: 700; color: var(--lc-faint); white-space: nowrap; }
.lc-pop .who .st.in { color: var(--lc-tally); }
.lc-pop .who .ctl { grid-column: 1 / 4; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.lc-pop .tag { font: 700 10px/1 var(--font-ui, inherit); letter-spacing: .06em; padding: 3px 5px; border-radius: 4px; background: var(--lc-bg1); color: var(--lc-dim); }
.lc-pop .foot { display: flex; gap: 6px; align-items: center; }

/* greenroom: the waiting room inside People */
.lc-grbox { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 12px; background: color-mix(in srgb, var(--lc-next) 6%, var(--lc-bg1)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-next) 30%, var(--lc-edge)) inset; }
.lc-grhead { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lc-grhead h4 { margin: 0; display: inline-flex; gap: 6px; align-items: center; font-size: var(--lc-f-m); font-weight: 700; }
.lc-grhead .lc-select { height: var(--lc-h-s); font-size: var(--lc-f-s); max-width: 210px; }
.lc-gr { display: grid; grid-template-columns: 136px minmax(0, 1fr); gap: 6px 10px; padding: 8px; border-radius: 10px; background: var(--lc-bg3); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-gr.ready { box-shadow: 0 0 0 2px var(--lc-next) inset, 0 0 18px -8px var(--lc-next); }
.lc-gr .thumb { position: relative; width: 136px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: #000; align-self: start; }
.lc-gr .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.lc-gr .thumb .none { position: absolute; inset: 0; display: grid; place-items: center; color: var(--lc-faint); font-size: var(--lc-f-cap); text-align: center; padding: 4px; }
.lc-gr .thumb .muted { position: absolute; left: 5px; top: 5px; display: inline-flex; gap: 3px; align-items: center; padding: 2px 5px; border-radius: 4px; background: var(--lc-err); color: #fff; font: 750 9.5px/1 var(--font-ui, inherit); letter-spacing: .08em; }
.lc-gr .thumb .lv { position: absolute; left: 5px; right: 5px; bottom: 5px; height: 5px; border-radius: 3px; background: #0009; overflow: hidden; }
.lc-gr .thumb .lv u { display: block; height: 100%; width: 0; background: var(--lc-ok); transition: width .1s; }
.lc-gr .body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.lc-gr .who { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-weight: 650; min-width: 0; }
.lc-gr .tag, .lc-guest .tag.rdy { font-size: 10px; font-weight: 700; letter-spacing: .06em; padding: 2px 5px; border-radius: 4px; background: var(--lc-bg1); color: var(--lc-dim); white-space: nowrap; }
.lc-gr .tag.rdy, .lc-guest .tag.rdy { background: var(--lc-next); color: #04140b; }
.lc-gr .tag.off, .lc-guest .tag.off { background: var(--lc-err); color: #fff; display: inline-flex; gap: 3px; align-items: center; }
.lc-gr .tag.talk { background: var(--lc-warn); color: #1d1300; }
.lc-gr .conn { display: flex; gap: 6px; align-items: center; font: 500 var(--lc-f-s)/1.3 var(--lc-mono, ui-monospace, monospace); color: var(--lc-dim); }
.lc-gr .conn i { width: 7px; height: 7px; border-radius: 50%; background: var(--lc-faint); flex: none; }
.lc-gr .conn i.good { background: var(--lc-ok); } .lc-gr .conn i.fair { background: var(--lc-warn); } .lc-gr .conn i.poor { background: var(--lc-err); }
.lc-grsay { font-size: var(--lc-f-s); color: var(--lc-text); overflow-wrap: anywhere; }
.lc-grsay q { font-style: italic; } .lc-grsay time, .lc-grsent time { color: var(--lc-faint); }
.lc-grsent { font-size: var(--lc-f-s); color: var(--lc-dim); overflow-wrap: anywhere; }
.lc-gr .acts, .lc-grmsg { grid-column: 1 / 3; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.lc-grmsg input { flex: 1 1 140px; min-width: 0; height: var(--lc-h-s); border: 0; border-radius: 6px; padding: 0 8px; background: var(--lc-bg1); color: var(--lc-text); font: inherit; font-size: var(--lc-f-s); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-grmsg input:focus { outline: 2px solid var(--lc-acc); outline-offset: 0; }
.lc-guest .grline { grid-column: 2 / 5; font-size: var(--lc-f-s); color: var(--lc-dim); overflow-wrap: anywhere; }
.lc-guest .lc-grmsg { grid-column: 1 / 5; }
.lc-grwarn { font-size: var(--lc-f-s); color: var(--lc-warn); }
.lc-narrow .lc-gr, .lc-compact .lc-gr { grid-template-columns: 112px minmax(0, 1fr); } .lc-narrow .lc-gr .thumb, .lc-compact .lc-gr .thumb { width: 112px; }
/* moderation (shared/moderation.ts): camera / mic / volume / cut per guest, Cut all, Undo — instant, no confirm */
.lc-gr .thumb.hid img, .lc-modpv.hid img { filter: blur(7px) grayscale(1) brightness(.55); transform: scale(1.08); }
.lc-gr .thumb .hidtag, .lc-modpv .hidtag { position: absolute; inset: auto 5px 5px 5px; display: flex; gap: 4px; align-items: center; justify-content: center; padding: 3px 5px; border-radius: 5px; background: #000b; color: #fff; font-size: 9.5px; font-weight: 750; line-height: 1; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
/* (rows grow with their moderation strip: the People list scrolls instead of squeezing rows into each other) */
[data-tile="guests"] .lc-scroll > * { flex-shrink: 0; }
.lc-gr .thumb .hidtag { bottom: 14px; }
.lc-guest > .lc-modrow { grid-column: 1 / -1; grid-row: auto; }
.lc-modrow { display: flex; gap: 10px; align-items: stretch; padding-top: 2px; min-width: 0; }
.lc-modpv { position: relative; flex: none; align-self: flex-start; width: 112px; aspect-ratio: 16 / 9; border-radius: 7px; overflow: hidden; background: #000; box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-modpv img { width: 100%; height: 100%; object-fit: cover; display: block; transition: filter .25s var(--lc-ease); }
.lc-modpv .none { position: absolute; inset: 0; display: grid; place-items: center; color: var(--lc-faint); font-size: var(--lc-f-cap); text-align: center; padding: 4px; }
.lc-modcol { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; justify-content: center; }
.lc-mod { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.lc-mt { display: inline-flex; align-items: center; gap: 6px; height: var(--lc-h-s); padding: 0 10px 0 8px; border: 0; border-radius: 999px; font-size: var(--lc-f-s); font-weight: 650; background: var(--lc-bg1); color: var(--lc-text);
  box-shadow: 0 0 0 1px var(--lc-edge2) inset; transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease), color var(--lc-dur); }
.lc-mt:hover { background: var(--lc-bg4); }
.lc-mt i.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--lc-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lc-ok) 22%, transparent); }
.lc-mt.off { background: color-mix(in srgb, var(--lc-err) 18%, var(--lc-bg2)); color: #fff; box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-err) 70%, transparent) inset; }
.lc-mt.off i.dot { background: var(--lc-err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lc-err) 25%, transparent); }
.lc-vol { display: inline-flex; align-items: center; gap: 6px; min-width: 120px; flex: 1 1 120px; max-width: 220px; color: var(--lc-dim); font: 600 var(--lc-f-cap)/1 var(--lc-mono); }
.lc-vol input { flex: 1; min-width: 60px; accent-color: var(--lc-acc); height: 18px; }
.lc-vol input:disabled { opacity: .4; }
.lc-vol b { min-width: 3.2em; text-align: right; font-weight: 600; color: var(--lc-text); }
.lc-cut { height: var(--lc-h-s); padding: 0 11px; border: 0; border-radius: 999px; font-size: var(--lc-f-s); font-weight: 750; letter-spacing: .02em; display: inline-flex; gap: 6px; align-items: center;
  background: color-mix(in srgb, var(--lc-err) 14%, var(--lc-bg1)); color: var(--lc-err); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-err) 55%, transparent) inset; }
.lc-cut:hover { background: var(--lc-err); color: #fff; }
.lc-cut.back { background: var(--lc-acc); color: var(--lc-acc-ink); box-shadow: 0 6px 16px -8px var(--lc-acc); }
.lc-guest.modcut { background: color-mix(in srgb, var(--lc-err) 9%, var(--lc-bg3)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-err) 55%, transparent) inset; }
.lc-guest.modcut .av { filter: grayscale(1); opacity: .7; }
.lc-modfollow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 8px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; font-size: var(--lc-f-s); }
.lc-modfollow .what { display: inline-flex; gap: 6px; align-items: center; color: var(--lc-text); margin-right: auto; min-width: 0; }
.lc-modfollow .what svg { color: var(--lc-err); flex: none; }
.lc-cutall { height: var(--lc-h-s); padding: 0 10px; border: 0; border-radius: 6px; font-size: var(--lc-f-s); font-weight: 750; display: inline-flex; gap: 6px; align-items: center;
  background: color-mix(in srgb, var(--lc-tally) 86%, #000); color: #fff; box-shadow: 0 1px 0 #fff3 inset, 0 6px 16px -8px var(--lc-tally); }
.lc-cutall:hover { filter: brightness(1.08); }
.lc-cutall.back { background: var(--lc-acc); color: var(--lc-acc-ink); box-shadow: 0 6px 16px -8px var(--lc-acc); }
.lc-undo { display: flex; gap: 8px; align-items: center; padding: 6px 8px 6px 10px; border-radius: 10px; font-size: var(--lc-f-s); background: color-mix(in srgb, var(--lc-warn) 12%, var(--lc-bg2));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-warn) 45%, transparent) inset; animation: lc-undo-in .35s var(--lc-ease); }
.lc-undo .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .lc-undo time { color: var(--lc-dim); }
.lc-undo kbd { font: 600 10px/1 var(--lc-mono); padding: 2px 4px; border-radius: 4px; background: var(--lc-bg1); color: var(--lc-dim); box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
@keyframes lc-undo-in { from { opacity: 0; transform: translateY(-4px); } }
.lc-narrow .lc-modpv, .lc-compact .lc-modpv { width: 96px; }

/* ---- live-tabs: the console is ONE row of labelled tabs beside the PROGRAM monitor ---- */
.lc-tabbar { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 6px; flex: none; }
/* (one row of nine when there is room; else two even rows, 5 + 4; a phone: 3 × 3) */
@container (max-width: 700px) { .lc-tabbar { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@container (max-width: 430px) { .lc-tabbar { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.lc-tab { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; min-height: 60px; padding: 8px 4px 7px; border: 0; border-radius: 12px;
  background: var(--lc-bg2); color: var(--lc-dim); font-weight: 650; font-size: var(--lc-f-s); line-height: 1.15; text-align: center; box-shadow: var(--lc-shadow);
  transition: background var(--lc-dur) var(--lc-ease), color var(--lc-dur), box-shadow var(--lc-dur) var(--lc-ease); }
.lc-tab svg { color: var(--lc-faint); transition: color var(--lc-dur); }
.lc-tab:hover { color: var(--lc-text); background: var(--lc-bg3); }
.lc-tab:hover svg { color: var(--lc-text); }
.lc-tab.on { color: var(--lc-text); background: color-mix(in srgb, var(--lc-acc) 15%, var(--lc-bg2)); box-shadow: 0 0 0 2px var(--lc-acc) inset, 0 8px 20px -14px var(--lc-acc); }
.lc-tab.on svg { color: var(--lc-acc); }
.lc-tab .bdg { position: absolute; top: 5px; right: 5px; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px; font: 700 10px/17px var(--lc-mono); background: var(--lc-bg4); color: var(--lc-text); box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-tab .bdg.hot { background: var(--lc-tally); color: #fff; box-shadow: 0 0 10px -2px var(--lc-tally); }
.lc-tab .bdg.dot { min-width: 9px; width: 9px; height: 9px; padding: 0; top: 8px; right: 8px; }
.lc-tabhint { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; background: var(--lc-bg1); color: var(--lc-dim); font-size: var(--lc-f-m); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-tabhint b { color: var(--lc-text); font-size: var(--lc-f-l); font-weight: 700; white-space: nowrap; }
.lc-tabhint svg { color: var(--lc-acc); }
.lc-tabpanel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.lc-tabpanel > .lc-scroll { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--lc-s3); padding: 2px 2px 14px; }
.lc-tabpanel > .lc-scroll > * { flex: none; }
.lc-tabpanel .lc-a-rooms { overflow: visible; }
.lc-tabpanel .lc-panel > .lc-scroll { overflow: visible; }
.lc-tabpanel .lc-rooms-wrap { max-height: none; overflow: visible; }
.lc-tabpanel .lc-ph h3 { font-size: var(--lc-f-s); color: var(--lc-text); letter-spacing: .06em; }
.lc-sub { margin: -2px 0 2px; color: var(--lc-dim); font-size: var(--lc-f-s); }
.lc-go { display: flex; align-items: center; gap: var(--lc-s3); flex-wrap: wrap; }
.lc-go .now { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 160px; }
.lc-go .now small { font-size: var(--lc-f-cap); letter-spacing: .09em; text-transform: uppercase; color: var(--lc-faint); font-weight: 700; }
.lc-go .now b { font-size: var(--lc-f-xl); font-weight: 750; }
.lc-btn.big { height: 52px; padding: 0 26px; font-size: var(--lc-f-xl); font-weight: 750; border-radius: 12px; }
.lc-btn.big.end { background: color-mix(in srgb, var(--lc-err) 14%, var(--lc-bg3)); color: var(--lc-text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-err) 55%, transparent) inset; }
.lc-btn.big.arm { background: var(--lc-err); color: #fff; }
/* "viewers can't see ..." strip under the program monitor */
.lc-now { flex: none; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 44px; padding: 7px 10px; border-radius: 12px; background: var(--lc-bg2); box-shadow: var(--lc-shadow); font-size: var(--lc-f-s); color: var(--lc-dim); }
.lc-now .ok { display: inline-flex; align-items: center; gap: 7px; }
.lc-now .ok svg { color: var(--lc-ok); }
.lc-now .chip { display: inline-flex; gap: 6px; align-items: center; height: 30px; padding: 0 12px 0 9px; border-radius: 999px; border: 0; font-weight: 700; font-size: var(--lc-f-s);
  background: color-mix(in srgb, var(--lc-tally) 18%, var(--lc-bg3)); color: var(--lc-text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-tally) 60%, transparent) inset; }
.lc-now .chip svg { color: var(--lc-tally); }
.lc-now .chip.warn { background: color-mix(in srgb, var(--lc-warn) 16%, var(--lc-bg3)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-warn) 60%, transparent) inset; }
.lc-now .chip.warn svg { color: var(--lc-warn); }
.lc-now .chip:hover { filter: brightness(1.12); }
/* Privacy: big on / off cards */
.lc-pvlist { display: flex; flex-direction: column; gap: var(--lc-s2); }
.lc-pv { display: grid; grid-template-columns: 44px minmax(0, 1fr) max-content; gap: 4px 12px; align-items: center; width: 100%; min-height: 72px; padding: 12px 14px; border: 0; border-radius: 14px; text-align: left;
  background: var(--lc-bg2); box-shadow: var(--lc-shadow); transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease); }
.lc-pv:hover { background: var(--lc-bg3); }
.lc-pv > .ic { grid-row: span 2; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--lc-bg3); color: var(--lc-dim); }
.lc-pv > b { font-size: var(--lc-f-l); font-weight: 700; }
.lc-pv > .d { grid-column: 2; color: var(--lc-dim); font-size: var(--lc-f-s); line-height: 1.35; }
.lc-pv > .sw { grid-column: 3; grid-row: 1 / span 2; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border-radius: 999px; font-weight: 750; font-size: var(--lc-f-s);
  background: var(--lc-bg1); color: var(--lc-dim); box-shadow: 0 0 0 1px var(--lc-edge2) inset; white-space: nowrap; }
.lc-pv > .sw { min-width: max-content; justify-self: end; }
.lc-pv > .sw i { width: 9px; height: 9px; border-radius: 50%; background: var(--lc-ok); }
.lc-pv.on { background: color-mix(in srgb, var(--lc-tally) 12%, var(--lc-bg2)); box-shadow: 0 0 0 2px var(--lc-tally) inset, 0 0 22px -12px var(--lc-tally); }
.lc-pv.on > .ic { background: var(--lc-tally); color: #fff; }
.lc-pv.on > .sw { background: var(--lc-tally); color: #fff; box-shadow: none; }
.lc-pv.on > .sw i { background: #fff; }
.lc-pv.arm { box-shadow: 0 0 0 2px var(--lc-err) inset; }
.lc-pv[disabled] { opacity: .55; cursor: default; }
.lc-soon { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; background: color-mix(in srgb, #fff 6%, transparent); color: color-mix(in srgb, var(--lc-text) 55%, transparent);
  font: 600 10px/1 var(--lc-mono); letter-spacing: .08em; text-transform: uppercase; cursor: not-allowed; white-space: nowrap; }
.lc-cvrow { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 12px; align-items: start; }
.lc-cvrow canvas, .lc-trpv canvas { display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; background: #000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0 / 12px 12px; box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-cvrow .side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.lc-field { display: flex; gap: 6px; align-items: center; min-width: 0; }
.lc-field input { flex: 1 1 140px; min-width: 0; height: var(--lc-h-m); border: 0; border-radius: 8px; padding: 0 10px; background: var(--lc-bg1); color: var(--lc-text); font: inherit; box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-field input:focus { outline: 2px solid var(--lc-acc); outline-offset: 0; }
/* Transitions */
.lc-trgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 8px; }
.lc-trc { position: relative; display: flex; flex-direction: column; gap: 0; padding: 0; border: 0; border-radius: 10px; overflow: hidden; background: var(--lc-bg3); text-align: left; box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-trc canvas, .lc-trc .ph { display: block; width: 100%; aspect-ratio: 16 / 9; background: repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0 / 12px 12px; }
.lc-trc .ph { display: flex; align-items: center; justify-content: center; color: var(--lc-dim); }
.lc-trc .nm { margin: 6px 8px 7px; font-size: var(--lc-f-s); font-weight: 650; }
.lc-trc:hover { box-shadow: 0 0 0 1px var(--lc-edge2) inset, 0 8px 18px -12px #000; }
.lc-trc.on { box-shadow: 0 0 0 2px var(--lc-acc) inset; }
.lc-trc.on .nm::before { content: "\\2713  "; color: var(--lc-acc); }
.lc-cvgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
/* live-layout: a picked look reads "Using"; each option has its own Preview (only you see it) */
.lc-pick { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lc-pick > .lc-trc { width: 100%; }
.lc-pick .using { position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; gap: 3px; font: 750 9.5px/1 var(--font-ui, inherit); letter-spacing: .1em; text-transform: uppercase; padding: 3px 6px; border-radius: 5px; background: var(--lc-acc); color: var(--lc-acc-ink); }
.lc-pv1 { align-self: stretch; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--lc-dim); font-size: var(--lc-f-cap); font-weight: 650; box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-pv1:hover { color: var(--lc-text); background: var(--lc-bg3); }
.lc-using { font-size: var(--lc-f-s); color: var(--lc-dim); } .lc-using b { color: var(--lc-text); font-weight: 700; }
.lc-lookerr { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; background: color-mix(in srgb, var(--lc-err) 12%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-err) 45%, transparent) inset; color: var(--lc-text); font-size: var(--lc-f-s); }
.lc-lookerr svg { color: var(--lc-err); }
.lc-looknote { color: var(--lc-faint); font-size: var(--lc-f-s); padding: 2px 2px 0; }
.lc-cvc canvas { background: #000; }
.lc-hk { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-hk kbd { font: 700 var(--lc-f-m)/1 var(--lc-mono); padding: 7px 10px; border-radius: 7px; background: var(--lc-bg3); color: var(--lc-text); box-shadow: 0 -2px 0 #0006 inset, 0 0 0 1px var(--lc-edge2) inset; }
.lc-hk kbd.rec { color: var(--lc-acc); box-shadow: 0 0 0 2px var(--lc-acc) inset; animation: lc-pulse 1.2s ease-in-out infinite; }
.lc-hknote { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: var(--lc-f-s); color: var(--lc-text); }
.lc-hknote.warn { color: var(--lc-warn); }
.lc.lc-narrow .lc-cvgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.lc-trpv { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 12px; align-items: center; }
.lc-trpv .side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.lc-camdemo { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: linear-gradient(180deg, #1d2433, #0f131b 62%, #18140f); box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-camdemo .p { position: absolute; bottom: 16%; width: 13%; aspect-ratio: 1 / 1.6; border-radius: 40% 40% 8px 8px; background: var(--c, #7bd88f); opacity: .85; }
.lc-camdemo .p::before { content: ""; position: absolute; left: 22%; right: 22%; top: -36%; aspect-ratio: 1; border-radius: 50%; background: inherit; }
.lc-camdemo .f { position: absolute; top: 12%; left: 6%; width: 44%; height: 76%; border-radius: 6px; box-shadow: 0 0 0 2px #fff, 0 0 0 999px #0009; transition: left var(--mv, 1.2s) cubic-bezier(.45, 0, .2, 1); }
.lc-camdemo .f::after { content: "CAMERA"; position: absolute; top: 5px; left: 6px; font: 750 9px/1 var(--lc-mono); letter-spacing: .1em; color: #fff; background: var(--lc-tally); padding: 2px 4px; border-radius: 3px; }
.lc-camdemo.b .f { left: 50%; }
.lc-camdemo.cut .f { transition: none; }
.lc.lc-narrow .lc-tabbar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.lc.lc-narrow .lc-pgm-msg > span { display: none; }
.lc.lc-narrow .lc-tab { min-height: 54px; }
.lc.lc-narrow .lc-tabpanel > .lc-scroll { overflow: visible; }
.lc.lc-narrow .lc-cvrow, .lc.lc-narrow .lc-trpv { grid-template-columns: 1fr; }
.lc.lc-narrow .lc-pv { grid-template-columns: 40px minmax(0, 1fr); }
.lc.lc-narrow .lc-pv > .sw { grid-column: 2; grid-row: auto; justify-self: start; }
.lc.lc-narrow .lc-go .lc-btn.big { flex: 1 1 100%; }
.lc.lc-compact .lc-tab { min-height: 54px; }
/* live-tabs: the "Now · Lights" status line above the tabs (slim, one line) */
.lc-status { flex: none; display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 10px; border: 0; border-radius: 8px; text-align: left; overflow: hidden; white-space: nowrap;
  background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; color: var(--lc-text); font-size: var(--lc-f-s); }
.lc-status .k { font-size: var(--lc-f-cap); font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--lc-faint); }
.lc-status .v { display: inline-flex; align-items: center; gap: 5px; font-weight: 650; }
.lc-status .v svg { color: var(--lc-acc); }
.lc-status .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--lc-faint); }
.lc-status:hover { background: var(--lc-bg2); }
/* (scoped: an unscoped .sw squeezed every other .sw in the studio, e.g. Me → Material style cards, to 10 px) */
.lc-status .sw { display: inline-block; flex: none; width: 10px; height: 10px; border-radius: 3px; box-shadow: 0 0 0 1px #fff3 inset; }
.lc-lbl.lc-w { min-width: 0; }
.lc.lc-narrow .lc-status .v { font-size: var(--lc-f-l); }

/* ---- live-layout: the original console + the new options as compact tabbed tiles (owner: "I liked the old layout,
   I just wanted more options") ---- */
.lc-tilepair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--lc-s3); flex: 1.25 1 0; min-height: 0; }
.lc.lc-compact .lc-tilepair { gap: var(--lc-s2); }
.lc-tilepair > .lc-tabs { min-height: 0; min-width: 0; }
.lc-paneseg { flex-wrap: wrap; max-width: 100%; }
.lc-paneseg > button { flex: 0 1 auto; position: relative; }
.lc-paneseg .bdg { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font: 700 10px/16px var(--lc-mono); background: var(--lc-bg4); color: var(--lc-text); box-shadow: 0 0 0 1px var(--lc-edge2) inset; }
.lc-paneseg .bdg.hot { background: var(--lc-tally); color: #fff; box-shadow: 0 0 10px -2px var(--lc-tally); }
.lc-paneseg .bdg.dot { min-width: 8px; width: 8px; height: 8px; padding: 0; }
.lc-pane { flex: 1 1 auto; }
.lc-pane.lc-multi { padding: 0; overflow: hidden; }
.lc-panebody { flex: 1 1 auto; display: flex; flex-direction: column; gap: 0; padding: 4px var(--lc-s3) var(--lc-s3); }
.lc-panebody > * { flex: none; }
.lc-panebody > .lc-panel { background: none; box-shadow: none; border-radius: 0; padding: 10px 0; }
.lc-panebody > * + * { border-top: 1px solid var(--lc-edge); }
.lc-panebody > .lc-pvlist { padding: 10px 0; }
.lc-pane .lc-pv { min-height: 54px; padding: 8px 10px; border-radius: 12px; background: var(--lc-bg3); box-shadow: 0 0 0 1px var(--lc-edge) inset; }
.lc-pane .lc-pv > .ic { width: 34px; height: 34px; border-radius: 10px; }
.lc-pane .lc-pv > .sw { height: 28px; padding: 0 12px; }
.lc-pane .lc-sub { margin: 0; }
.lc-pane .lc-trgrid { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 6px; }
.lc-pane .lc-cvgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.lc-pane .lc-cvrow, .lc-pane .lc-trpv { grid-template-columns: minmax(0, 200px) minmax(0, 1fr); gap: 10px; }
.lc-pane .lc-hk { padding: 8px 10px; }
.lc-pane .lc-go .lc-btn.big { height: 40px; padding: 0 16px; font-size: var(--lc-f-l); }
@container (max-width: 420px) { .lc-pane .lc-cvrow, .lc-pane .lc-trpv { grid-template-columns: 1fr; } }
.lc-tabs { container-type: inline-size; }
.lc-panehead { display: flex; align-items: center; gap: 10px; min-width: 0; flex: none; }
.lc-panehead > .lc-seg { flex: none; }
.lc-panehint { flex: 1 1 0; min-width: 0; color: var(--lc-faint); font-size: var(--lc-f-s); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-paneseg { flex-wrap: wrap; }
.lc.lc-narrow .lc-panehint, .lc-tilepair .lc-panehint { display: none; }
.lc-tilepair .lc-panehead > .lc-seg { flex: 1 1 auto; }
.lc-pane .lc-cvgrid { grid-template-columns: repeat(3, minmax(0, 190px)); }
/* the slim status line in the header: Now · Lights + what viewers can't see */
.lc-statusline { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; overflow: hidden; }
.lc-statusline .lc-status { width: auto; flex: none; height: 26px; }
.lc-statusline .chip { display: inline-flex; gap: 5px; align-items: center; height: 26px; padding: 0 10px 0 8px; border-radius: 999px; border: 0; font-weight: 700; font-size: var(--lc-f-s); white-space: nowrap; flex: none;
  background: color-mix(in srgb, var(--lc-tally) 18%, var(--lc-bg3)); color: var(--lc-text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-tally) 60%, transparent) inset; }
.lc-statusline .chip svg { color: var(--lc-tally); }
.lc-statusline .chip.warn { background: color-mix(in srgb, var(--lc-warn) 16%, var(--lc-bg3)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-warn) 60%, transparent) inset; }
.lc-statusline .chip.warn svg { color: var(--lc-warn); }
.lc.lc-narrow .lc-statusline { order: 5; flex: 1 1 100%; flex-wrap: wrap; }
/* wide: the bottom row is Rooms | People | Chat & polls | Me */
.lc-sec > .lc-panel { min-height: 0; }
/* rooms grow to fill their tile (few rooms = bigger pictures; many = a scrolling grid) */
.lc-rooms { grid-template-columns: repeat(auto-fill, minmax(var(--lc-room-min, 132px), 1fr)); }
.lc.lc-narrow .lc-tilepair { display: flex; flex-direction: column; }
@media (prefers-reduced-motion: reduce) {
  .lc *, .lc-mini *, .lc-tip { transition-duration: 0s !important; animation: none !important; }
}
`;

const MODES: [string, string][] = [['talk', 'Talk'], ['react', 'React'], ['gaming', 'Gaming'], ['interview', 'Interview'], ['ttrpg', 'Tabletop game']];
const MODE_HINT: Record<string, string> = { talk: 'You (and friends) chatting in your room', react: 'Watch a video or a stream together on a big screen', gaming: 'Your game big, you in a corner', interview: 'Guests, plus a camera switcher', ttrpg: 'A tabletop game night' };
// (live-tabs, owner 2026-10-01: these are LIGHTING STATES — the real names of shared/lightShow.ts LIGHTING_STATES —
// not "what you're doing"; that is the show mode below. `sw` = the swatch colour of each state's lights.)
export const LIGHTS: { id: string; label: string; sub: string; hint: string; ic: string; short: string; sw: string }[] = [
  { id: 'preshow', label: 'Preshow', sub: 'Before you start', hint: 'House lights off, light show', ic: 'preshow', short: 'Preshow', sw: 'linear-gradient(135deg,#6c4cff,#ff5fb4 55%,#6cc7f5)' },
  { id: 'show', label: 'Show', sub: 'Main lights', hint: 'Normal studio lights while you’re on', ic: 'sun', short: 'Show', sw: 'linear-gradient(135deg,#fff3c4,#ffcf6a)' },
  { id: 'react', label: 'React', sub: 'Dim, screen up', hint: 'Room a little dimmed, towards the screen', ic: 'react', short: 'React', sw: 'linear-gradient(135deg,#2a3350,#6cc7f5)' },
  { id: 'brb', label: 'BRB', sub: 'Be right back', hint: 'Fades to black, mutes guests and shows your Be Right Back card (Privacy)', ic: 'brb', short: 'BRB', sw: 'linear-gradient(135deg,#1b1f2e,#7a5cff 70%,#1b1f2e)' },
  { id: 'outro', label: 'Outro', sub: 'Wrap up', hint: 'Warm afterparty lights', ic: 'outro', short: 'Outro', sw: 'linear-gradient(135deg,#ff8a4a,#ff5fb4)' },
];
/** live-tabs: "What you're doing" (the show mode) — Talk is the default. `doing` reads in the status strip. */
export const DOING: { id: string; label: string; doing: string; sub: string; ic: string }[] = [
  { id: 'talk', label: 'Talk', doing: 'Talking', sub: 'Just chatting in your room. The default.', ic: 'chat' },
  { id: 'react', label: 'React', doing: 'Reacting', sub: 'Watching a video or stream together on a big screen.', ic: 'tv' },
  { id: 'gaming', label: 'Gaming', doing: 'Gaming', sub: 'Your game big, you in a corner.', ic: 'games' },
  { id: 'interview', label: 'Interview', doing: 'Interviewing', sub: 'Guests on the show, with a camera switcher.', ic: 'users' },
  { id: 'ttrpg', label: 'Tabletop game', doing: 'Tabletop game', sub: 'A tabletop game night.', ic: 'wand' },
];
/** The studio's status light (clarity pass, owner: "people wonder what they're live to … they think I'm stealing their
 *  camera feed"). It used to say ON AIR as soon as the webcam was on. Now it says exactly what it knows:
 *  'obs' = OBS is showing VTube Pro (red, like a tally light); 'cam' = only the camera is on (calm: nobody sees
 *  anything); 'off'. VTube Pro itself never streams: OBS does, when you press Start Streaming there. */
export type AirState = 'obs' | 'cam' | 'off';
export const airState = (st: { tracking: boolean; obs: number }): AirState => (st.obs > 0 ? 'obs' : st.tracking ? 'cam' : 'off');
export const AIR_TEXT: Record<AirState, { label: string; tip: string; hint: string }> = {
  obs: { label: 'IN OBS', tip: 'OBS is showing VTube Pro', hint: 'You’re live only while OBS is streaming (Start Streaming in OBS). Viewers see your avatar, not your camera picture.' },
  cam: { label: 'CAMERA ON', tip: 'Your camera is on. OBS isn’t showing VTube Pro.', hint: 'Your camera only moves your avatar here. You go live when OBS shows VTube Pro and you press Start Streaming there.' },
  off: { label: 'NOT IN OBS', tip: 'OBS isn’t showing VTube Pro', hint: 'VTube Pro never streams by itself. You go live when you add VTube Pro to OBS and press Start Streaming there.' },
};
const SHOT_NAMES: Record<string, string> = { host: 'Host', two: 'Two-shot', wide: 'Wide', establishing: 'Establishing', ots: 'Over shoulder', push: 'Push-in', bumper: 'Show open', snap: 'Snap zoom', reverse: 'Reverse', sidekick: 'Sidekick', hosts: 'Hosts', panel: 'Panel' };
const EMOTE_ICON: Record<string, string> = { wave: '\u{1F44B}', clap: '\u{1F44F}', dance: '\u{1F483}', bow: '\u{1F647}', cheer: '\u{1F389}', laugh: '\u{1F602}', think: '\u{1F914}', shrug: '\u{1F937}', heart: '\u{1F496}', jump: '\u{1F998}', nod: '\u{1F642}', point: '\u{1F449}', salute: '\u{1FAE1}', sit: '\u{1FA91}', spin: '\u{1F300}', victory: '✌️', idle: '\u{1F9CD}', surprised: '\u{1F62E}', sad: '\u{1F622}', angry: '\u{1F620}' };
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (s: string) => (s.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
/** Ctrl+K phrase that runs the same action (shown in tooltips). */
function phrase(action: string, p?: Record<string, string | number>): string | null {
  switch (action) {
    case 'lighting': return String(p?.state ?? 'show');
    case 'interview': { const s = String(p?.shot ?? 'auto'); return s === 'auto' ? 'auto cam' : s === 'manual' ? 'manual cam' : s.startsWith('guest') ? `cut to guest ${s.slice(5)}` : s.startsWith('cohost') ? `cut to cohost ${s.slice(6)}` : s === 'two' ? 'two shot' : s === 'hosts' ? 'hosts shot' : s === 'panel' ? 'panel shot' : s === 'host' ? 'cut to host' : s === 'wide' ? 'wide' : s === 'house' ? 'house wide' : s === 'audience' ? 'cut to audience' : null; }
    case 'interview-role': return p?.role === 'cohost' ? `make ${String(p?.who ?? 'guest 1').replace(/(\d)$/, ' $1')} cohost` : null;
    case 'cover': return p?.on === 'false' ? 'show my screen' : 'hide my screen'; case 'chat-hide': return p?.on === 'false' ? 'show chat' : 'hide chat';
    case 'camera-move': return Number(p?.secs) === 0 ? 'hard cut' : 'glide';
    case 'recalibrate': return 'recalibrate'; case 'hub-tts': return 'read aloud'; case 'hub-ack-next': return 'ack'; case 'hub-thank-next': return 'thank';
    case 'poll-start': return p?.template === 'Yes / No' ? 'poll yes/no' : p?.template === '1–4' ? 'poll 1-4' : 'poll'; case 'poll-end': return 'end poll';
    case 'knock-approve': return 'let in'; case 'guest-link': return 'invite link'; case 'curtain': return 'reveal'; case 'area': return 'next area';
    default: return null;
  }
}

export const ensureLiveCss = () => { if (!document.getElementById('vtp-live-css')) document.head.append(el('style', { id: 'vtp-live-css' }, CSS + THUMB_CSS + B12_CSS)); };
/** beta.12 UX (owner feedback): small / hidden studio view, the "viewers see" line, big mode + lighting rows, folding
 *  sections, the big Hide my screen switch, room favourites. Same tokens as above. */
const B12_CSS = `
/* Hide: the studio view is not drawn (src/app.ts skips it: src/ui/previewRate.ts studioViewHidden) and leaves the screen */
body.lc-console.lc-pgm-off:not(.clean):not(.vp-hidden) #viewport { left: -10000px !important; top: 0 !important; width: 192px !important; height: 108px !important; pointer-events: none !important; }
/* the studio view's size switch */
.lc-pgmbar { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 4px 0 8px; color: var(--lc-dim); font-size: var(--lc-f-s); flex: none; }
.lc-pgmbar .t { font-weight: 650; color: var(--lc-text); }
.lc-pgmbar.off { padding: 8px 8px 8px 12px; border-radius: 12px; background: var(--lc-bg2); box-shadow: var(--lc-shadow); }
.lc-pgmbar .lc-note { min-width: 0; }
/* small / hidden studio view: a fixed left column (picture, camera, rooms); the tabs take the right */
.lc.lc-pgms .lc-main { grid-template-columns: minmax(0, clamp(360px, 30%, calc(27vh * 16 / 9))) minmax(340px, 1fr); grid-template-rows: minmax(0, 1fr); grid-template-areas: "L R"; }
.lc.lc-pgms .lc-colL { container-type: inline-size; }
.lc.lc-pgms .lc-colL > .lc-pgm { flex: none; height: calc((100cqw - 20px) * 9 / 16 + 20px); }
.lc.lc-pgms .lc-colL > .lc-tabs { flex: 1 1 0; min-height: 0; }
.lc.lc-pgms .lc-colR > .lc-a-rooms { flex: 1 1 0; min-height: 0; }
/* short windows (1366 x 768): a smaller picture, and the tab row keeps one line (icons; the open tab keeps its name) */
.lc.lc-compact.lc-pgms .lc-main { grid-template-columns: minmax(0, clamp(300px, 28%, calc(22vh * 16 / 9))) minmax(340px, 1fr); }
.lc.lc-compact.lc-pgms .lc-colL .lc-paneseg { flex-wrap: nowrap; max-width: 100%; }
.lc.lc-compact.lc-pgms .lc-colL .lc-paneseg > button:not(.on) .tl { display: none; }
.lc.lc-compact.lc-pgms .lc-colL .lc-paneseg > button { padding: 0 7px; }
.lc.lc-compact.lc-pgms .lc-cams.scn .lc-cb { height: 52px; padding: 6px 4px; }
.lc.lc-compact.lc-pgms .lc-cb .no { display: none; }
.lc.lc-pgms .lc-roompair { flex: 1 1 0; min-height: 0; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
@media (min-width: 2200px) { .lc.lc-pgms .lc-roompair { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); } }
.lc.lc-pgms .lc-roompair > .lc-a-rooms { min-height: 0; min-width: 0; }
.lc.lc-pgms .lc-colL .lc-panehint { display: none; }
.lc.lc-pgms .lc-cams .grp { flex-wrap: wrap; }
.lc.lc-pgms .lc-cams:not(.scn) .lc-cb { flex: 1 1 88px; height: 64px; }
.lc.lc-pgms .lc-cams.scn .lc-cb { height: 58px; flex: 1 1 70px; min-width: 64px; }
.lc.lc-pgms .lc-lt { transform: scale(.82); transform-origin: left bottom; }
/* what viewers see right now (red only when OBS shows VTube Pro) */
.lc-now { display: flex; align-items: center; gap: 12px; padding: 8px 12px 8px 8px; border-radius: 12px; background: var(--lc-bg1); box-shadow: 0 0 0 1px var(--lc-edge) inset; min-width: 0; }
.lc-nowair { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px 0 12px; border-radius: 999px; font-weight: 750; font-size: var(--lc-f-m); white-space: nowrap; background: var(--lc-bg3); color: var(--lc-dim); flex: none; }
.lc-nowair i { width: 9px; height: 9px; border-radius: 50%; background: var(--lc-faint); }
.lc-now.cam .lc-nowair { color: var(--lc-text); } .lc-now.cam .lc-nowair i { background: var(--lc-ok); }
.lc-now.obs { background: color-mix(in srgb, var(--lc-tally) 10%, var(--lc-bg1)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--lc-tally) 55%, transparent) inset; }
.lc-now.obs .lc-nowair { background: var(--lc-tally); color: #fff; box-shadow: 0 0 18px -4px var(--lc-tally); }
.lc-now.obs .lc-nowair i { background: #fff; animation: lc-pulse 1.6s ease-in-out infinite; }
.lc-nowtxt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lc-nowtxt b { font-size: var(--lc-f-cap); color: var(--lc-faint); font-weight: 650; }
.lc-nowtxt span { font-size: var(--lc-f-l); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* the two rows: what you're doing / lighting, each with a plain line saying what it changes */
.lc-rowh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
.lc-rowh b { font-size: var(--lc-f-m); font-weight: 700; }
.lc-rowh span { font-size: var(--lc-f-s); color: var(--lc-faint); }
.lc-modes { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--lc-s2); }
.lc-mb, .lc-sb { position: relative; height: 84px; border: 0; border-radius: 12px; background: var(--lc-bg3); display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-end; gap: 2px; padding: 10px 12px; text-align: left;
  box-shadow: 0 0 0 1px var(--lc-edge) inset, 0 1px 0 var(--lc-hi) inset; transition: background var(--lc-dur) var(--lc-ease), box-shadow var(--lc-dur) var(--lc-ease), transform 90ms; overflow: hidden; }
.lc-mb svg { position: absolute; top: 10px; left: 12px; color: var(--lc-dim); }
.lc-mb b, .lc-sb b { font-size: var(--lc-f-l); font-weight: 680; }
.lc-mb small, .lc-sb small { font-size: var(--lc-f-cap); color: var(--lc-faint); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; }
.lc-mb:hover, .lc-sb:hover { background: var(--lc-bg4); }
.lc-mb:active, .lc-sb:active { transform: scale(.98); }
.lc-mb.on, .lc-sb.on { background: color-mix(in srgb, var(--lc-acc) 16%, var(--lc-bg3)); box-shadow: 0 0 0 2px var(--lc-acc) inset, 0 0 22px -12px var(--lc-acc); }
.lc-mb.on svg, .lc-sb.on svg { color: var(--lc-acc); }
.lc-sb.on::after { display: none; }
.lc-sb::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: var(--sw, transparent); opacity: .45; }
.lc-sb.on::before { opacity: 1; height: 5px; }
:is(.lc-mb, .lc-sb) .flag { position: absolute; top: 9px; right: 9px; font: 750 10px/1 var(--font-ui, inherit); letter-spacing: .04em; padding: 3px 6px; border-radius: 5px; background: var(--lc-acc); color: var(--lc-acc-ink); }
.lc.lc-compact :is(.lc-mb, .lc-sb) { height: 66px; padding: 7px 9px; }
.lc.lc-compact :is(.lc-mb, .lc-sb) svg { top: 7px; left: 9px; width: 16px; height: 16px; }
.lc.lc-compact .lc-sb small { display: -webkit-box; }
.lc.lc-compact :is(.lc-mb, .lc-sb) small { -webkit-line-clamp: 1; }
.lc.lc-compact .lc-modes { gap: 6px; }
.lc.lc-narrow .lc-modes { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
.lc.lc-narrow :is(.lc-mb, .lc-sb) { height: 54px; padding: 6px 7px; } .lc.lc-narrow :is(.lc-mb, .lc-sb) small { display: none; } .lc.lc-narrow :is(.lc-mb, .lc-sb) b { font-size: var(--lc-f-s); }
.lc.lc-narrow :is(.lc-mb, .lc-sb) svg { top: 6px; left: 7px; width: 15px; height: 15px; } .lc.lc-narrow :is(.lc-mb, .lc-sb) .flag { display: none; }
.lc.lc-narrow .lc-rowh span { display: none; }
/* Hide my screen: obvious in the Show header, unmistakable in Privacy */
.lc-btn.lc-hidebtn { height: 30px; font-size: var(--lc-f-m); padding: 0 12px; }
.lc-btn.lc-hidebtn.hidden-on { background: var(--lc-warn); color: #1a1205; box-shadow: 0 0 18px -6px var(--lc-warn); }
.lc-bighide { position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 72px; padding: 12px 16px; border: 0; border-radius: 14px; text-align: left;
  background: var(--lc-acc); color: var(--lc-acc-ink); box-shadow: 0 1px 0 #fff4 inset, 0 10px 26px -14px var(--lc-acc); transition: filter var(--lc-dur), transform 90ms; }
.lc-bighide:hover { filter: brightness(1.06); } .lc-bighide:active { transform: scale(.995); }
.lc-bighide .ic { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: #0000001f; flex: none; }
.lc-bighide .tx { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.lc-bighide .tx b { font-size: var(--lc-f-xl); font-weight: 750; }
.lc-bighide .tx span { font-size: var(--lc-f-s); opacity: .85; }
.lc-bighide .kb kbd { font: 650 11px/1 var(--font-ui, inherit); padding: 5px 7px; border-radius: 6px; background: #0000002a; }
.lc-bighide.on { background: var(--lc-warn); color: #1a1205; box-shadow: 0 0 0 2px #fff6 inset, 0 0 26px -6px var(--lc-warn); }
/* folding sections */
.lc-fold { display: flex; flex-direction: column; gap: var(--lc-s2); min-width: 0; }
.lc-foldh { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px 4px 4px; border: 0; border-radius: 8px; background: transparent; color: var(--lc-text); text-align: left; }
.lc-foldh:hover { background: var(--lc-hi); }
.lc-foldh .chev { display: inline-grid; transform: rotate(-90deg); transition: transform var(--lc-dur) var(--lc-ease); color: var(--lc-faint); }
.lc-fold.open > .lc-foldh .chev { transform: none; }
.lc-foldh > svg { color: var(--lc-dim); }
.lc-foldh .t { font-weight: 680; font-size: var(--lc-f-m); white-space: nowrap; }
.lc-foldsum { margin-left: auto; font-size: var(--lc-f-s); color: var(--lc-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lc-foldsum b { color: var(--lc-dim); font-weight: 650; }
.lc-foldb { display: flex; flex-direction: column; gap: var(--lc-s2); min-width: 0; }
/* room favourites */
.lc-roomw { position: relative; display: flex; min-width: 0; }
.lc-roomw > .lc-room { flex: 1; min-width: 0; }
.lc-star { position: absolute; top: 5px; left: 5px; width: 26px; height: 26px; border: 0; border-radius: 7px; display: grid; place-items: center; font-size: 15px; line-height: 1;
  background: #000a; color: #fff; opacity: 0; transition: opacity var(--lc-dur); z-index: 2; backdrop-filter: blur(4px); }
.lc-roomw:hover .lc-star, .lc-star:focus-visible, .lc-star.on { opacity: 1; }
.lc-star.on { color: #ffcf4a; }
@media (hover: none) { .lc-star { opacity: .85; } }
.lc-ph .lc-seg.s > button[disabled] { opacity: .45; cursor: default; }
/* small studio view in a narrow left column: the camera buttons share one row */
.lc.lc-pgms .lc-cams.scn .grp { flex-wrap: nowrap; }
.lc.lc-pgms .lc-cams.scn .lc-cb { flex: 1 1 0; min-width: 0; }
.lc.lc-pgms .lc-cams.scn .lc-cb .nm { font-size: var(--lc-f-s); }
.lc-pgmbar { flex-wrap: wrap; }
.lc-pgmbar.off .lc-note { order: 9; flex: 1 1 100%; }
/* compact (1366 x 768-ish): the same two rows, denser — icon and name on one line, the plain line under them */
.lc.lc-compact .lc-now { padding: 4px 10px 4px 4px; gap: 10px; }
.lc.lc-compact .lc-nowair { height: 26px; font-size: var(--lc-f-s); }
.lc.lc-compact .lc-nowtxt { flex-direction: row; align-items: baseline; gap: 8px; }
.lc.lc-compact .lc-nowtxt span { font-size: var(--lc-f-m); }
.lc.lc-compact .lc-rowh { margin-top: 0; }
.lc.lc-compact :is(.lc-mb, .lc-sb) { height: 54px; display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto auto; align-content: center; column-gap: 6px; row-gap: 2px; padding: 6px 9px; }
.lc.lc-compact :is(.lc-mb, .lc-sb) svg { position: static; width: 15px; height: 15px; }
.lc.lc-compact :is(.lc-mb, .lc-sb) b { font-size: var(--lc-f-m); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc.lc-compact :is(.lc-mb, .lc-sb) small { grid-column: 1 / -1; -webkit-line-clamp: 1; }
.lc.lc-compact :is(.lc-mb, .lc-sb) .flag { top: 6px; right: 6px; font-size: 9px; padding: 2px 5px; }
.lc.lc-compact .lc-a-show { gap: 5px; }
`;

/** Shared hover tooltip (label, hint, Ctrl+K phrase, Stream Deck key). */
function tooltip() {
  const tip = el('div', { class: 'lc-tip', role: 'tooltip' });
  let t = 0, cur: HTMLElement | null = null;
  const hide = () => { clearTimeout(t); cur = null; tip.classList.remove('show'); };
  const show = (e: HTMLElement) => {
    const d = e.dataset;
    tip.replaceChildren(...[el('b', null, d.tip ?? ''), d.hint ? el('div', { class: 'h' }, d.hint) : null,
      d.deck ? el('div', { class: 'k' }, el('kbd', null, 'Stream Deck'), d.deck) : null,
      d.ck ? el('div', { class: 'k' }, el('kbd', null, 'Ctrl K'), `“${d.ck}”`) : null,
      d.key ? el('div', { class: 'k' }, el('kbd', null, d.key), d.keyl ?? '') : null].filter((x): x is HTMLElement => !!x));
    if (!tip.isConnected) document.body.append(tip);
    const r = e.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.classList.add('show');
  };
  const over = (ev: Event) => {
    const e = (ev.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
    if (e === cur) return; hide(); if (!e) return;
    cur = e; t = window.setTimeout(() => { if (cur === e && e.isConnected) show(e); }, 380);
  };
  return { tip, over, hide };
}

export function mountLiveControl(root: HTMLElement, src: LiveSource): { destroy(): void } {
  ensureLiveCss();
  const deck = deckClient();
  let layout = loadLayout(), presets = loadPresets(), edit = false;
  let rooms: { id: string; name: string; thumb?: string | null }[] = [];
  type PollNow = { live: boolean; question: string; shown: boolean; options: { label: string; votes: number }[]; total: number; voters: number; winner: number[] };
  let poll: PollNow | null = null, templates: string[] = [], ping = -1;
  let deckKeys = new Map<string, string>();
  // live-layout (owner: "I liked the old layout, I just wanted more options"): the original console (PROGRAM + Camera
  // on the left, Show on the right, the panel row along the bottom) with the new options as compact tabbed tiles in
  // the original segmented style. Which pane each tile shows is remembered (vtp.live.panes); Ctrl+K / openLiveTab /
  // the old vtp.live.tab still pick one.
  const saved = lsGet(LS.panes) as Partial<Record<'a' | 'b' | 'last', string>> | null;
  const panes: Record<'a' | 'b', Pane> & { last: Pane } = {
    a: paneOf(saved?.a ?? lsGet(LS.tab) ?? 'rooms', 'a'), b: paneOf(saved?.b ?? 'privacy', 'b'), last: paneOf(saved?.last ?? lsGet(LS.tab) ?? 'rooms') };
  /** The legacy single value (Ctrl+K, presets, other pages read vtp.live.tab). */
  let tab: LiveTabId = sanitizeTab(lsGet(LS.tab));
  /** Scroll position per pane, so coming back to a pane lands where you left it. */
  const tabScroll = new Map<Pane, number>();
  let size: 'wide' | 'compact' | 'narrow' = 'wide';
  /** compact, but so tall that a 16:9 PROGRAM leaves a big empty band: use the bottom panel row (see .lc-tall) */
  let tall = false;
  let alive = true;
  // beta.12 UX (owner: "the big studio preview isn't needed most of the time and eats rendering power"): the studio view
  // is small by default (Hide = not drawn at all, Large = the old console); folded sections and the favourites filter
  // are remembered in this browser
  let pgmSize: PgmSize = parsePgmSize(lsGet(PGM_KEY));
  const folds = parseFolds(lsGet(FOLD_KEY));
  let favOnly = lsGet(LS.roomsFav) === true;
  /** Small / hidden studio view: Rooms sits under the camera, the tabs take the rest (the narrow column is unchanged). */
  const pgmSmall = () => pgmSize !== 'large' && size !== 'narrow';
  /** greenroom: message text being typed per guest (survives repaints) + on-air guests whose message row is open. */
  const drafts = new Map<string, string>();
  const msgOpen = new Set<string>();
  /** moderation: when a volume slider last moved (no rebuild under a drag) + the Undo strip's visibility window. */
  let slideAt = 0;
  const UNDO_SHOW_MS = 45_000;
  const undoShown = () => { const md = src.status().party.mod; return !!md?.last && md.undo > 0 && Date.now() - md.last.at < UNDO_SHOW_MS; };
  const wrap = el('div', { class: 'lc' });
  root.append(wrap);
  const tt = tooltip();
  wrap.addEventListener('pointerover', tt.over);
  wrap.addEventListener('pointerleave', tt.hide);
  wrap.addEventListener('pointerdown', tt.hide);
  // moderation: Ctrl+Z (⌘Z) in the Live panel undoes the last guest camera / mic change (never while typing)
  wrap.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === 'text') || t.isContentEditable) return;
    if (!(src.status().party.mod?.undo ?? 0)) return;
    e.preventDefault(); void run('guest-undo', undefined, 'Undo');
  });

  const run = async (action: string, params?: Record<string, unknown>, label = action) => {
    if (!src.canRun) { src.toast('Read-only here (observer tab): Live Control buttons are off', 'warn'); return; }
    const r = await deck.run(action, params);
    if (!r.ok) src.toast(`${label}: ${r.error ?? 'failed'}`, 'err');
    else if (action.startsWith('poll-') || action.startsWith('hub-')) void refreshPoll();
  };
  /** Destructive: first click arms (3 s), second click runs. */
  const armed = new WeakMap<HTMLElement, number>();
  const confirmClick = (b: HTMLElement, label: string, go: () => void) => {
    if (armed.has(b)) { clearTimeout(armed.get(b)); armed.delete(b); b.classList.remove('arm'); go(); return; }
    const old = [...b.childNodes];
    b.classList.add('arm'); b.replaceChildren(`Confirm ${label.toLowerCase()}?`);
    armed.set(b, window.setTimeout(() => { armed.delete(b); b.classList.remove('arm'); b.replaceChildren(...old); }, 3000));
  };
  interface BOpts { on?: boolean | null; danger?: boolean; cls?: string; tip?: string; hint?: string; ic?: string; icSize?: number; kids?: Kid[]; lbl?: boolean; tut?: string }
  /** One button = one registry action. `on` overrides the registry's lit check (studio-only state). */
  const B = (label: string, action: string, params?: Record<string, string | number>, o: BOpts = {}) => {
    const live = deck.live();
    const lit = o.on !== undefined ? o.on : quickActive(action, params, live);   // ("Auto cam" = the Interview director: dark outside Interview)
    const q: LiveQuick = { action, ...(params ? { params } : {}), label };
    const pinned = layout.quick.some((x) => quickKey(x) === quickKey(q));
    const ck = phrase(action, params);
    const b = el('button', {
      class: `${o.cls ?? 'lc-btn'}${lit ? ' on' : ''}${o.danger ? ' danger' : ''}${edit && pinned ? ' pin' : ''}`, 'data-action': action, 'data-params': params ? JSON.stringify(params) : null,
      'aria-pressed': lit === null || lit === undefined ? null : String(!!lit), 'aria-label': o.lbl === false || o.kids ? label : null,
      'data-tip': edit ? (pinned ? `Unpin “${label}”` : `Pin “${label}” to the quick bar`) : (o.tip ?? label), 'data-hint': edit ? null : o.hint ?? null,
      'data-deck': edit ? null : deckKeys.get(quickKey(q)) ?? null, 'data-ck': edit ? null : ck, 'data-tut': o.tut ?? null,
    }, ...(o.kids ?? [o.ic ? icon(o.ic, o.icSize ?? 16) : null, o.lbl === false ? null : label]));
    b.addEventListener('click', () => {
      if (edit) { layout.quick = pinned ? layout.quick.filter((x) => quickKey(x) !== quickKey(q)) : [...layout.quick, q].slice(0, 12); saveLayout(layout); paint(true); return; }
      if (o.danger) confirmClick(b, label, () => void run(action, params, label)); else void run(action, params, label);
    });
    return b;
  };
  const mq = (text: string, cls = '') => el('span', { class: `lc-mq ${cls}` }, el('span', null, text));
  // (live-tabs: tiles are tabs now; nothing is hidden or reordered — Customise only pins buttons to the quick bar)
  const panelHead = (_id: TileId | null, ic: string, label: string, ...right: Kid[]) => el('div', { class: 'lc-ph' }, el('h3', null, icon(ic, 14), label), el('span', { class: 'lc-sp' }), ...right);
  /** beta.12: a section that folds from its title (remembered per section, shared/liveView.ts FOLD_DEFAULTS); folded it
   *  still says what is in use. Nothing inside is built while it is folded (no previews animate). */
  const fold = (key: string, ic: string, title: string, summary: Kid, ...content: Kid[]) => {
    const open = foldOpen(folds, key);
    const head = el('button', { class: 'lc-foldh', type: 'button', 'data-fold': key, 'aria-expanded': String(open), 'data-tip': open ? `Fold “${title}”` : `Show “${title}”`, 'data-hint': 'Remembered in this browser',
      onClick: () => { folds[key] = !open; lsSet(FOLD_KEY, folds); paint(true); (wrap.querySelector(`[data-fold="${key}"]`) as HTMLElement | null)?.focus(); } },
      el('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chev', 14)), icon(ic, 14), el('span', { class: 't' }, title), summary ? el('span', { class: 'lc-foldsum' }, summary) : null);
    return el('div', { class: `lc-fold${open ? ' open' : ''}`, 'data-foldkey': key }, head, open ? el('div', { class: 'lc-foldb' }, ...content) : null);
  };
  /** Open a pane (or flash the always-visible Show / Camera tile): remembered, each pane keeps its scroll. */
  const setTab = (t: LiveTabId | Pane) => {
    if (t === 'show' || t === 'cameras') {
      tab = t; lsSet(LS.tab, tab);
      const tile = wrap.querySelector(t === 'show' ? '.lc-a-show' : '.lc-a-cam') as HTMLElement | null;
      tile?.scrollIntoView({ block: 'nearest' }); tile?.animate?.([{ boxShadow: '0 0 0 2px var(--lc-acc) inset' }, { boxShadow: '0 0 0 0 transparent inset' }], { duration: 1100 });
      if (t === 'cameras') return;
    }
    const p = paneOf(t);
    // (small studio view: Rooms is a tile under the camera, not a tab: flash it instead)
    if (p === 'rooms' && pgmSmall()) { const tile = wrap.querySelector('.lc-colR .lc-a-rooms') as HTMLElement | null; tile?.scrollIntoView({ block: 'nearest' }); tile?.animate?.([{ boxShadow: '0 0 0 2px var(--lc-acc) inset' }, { boxShadow: '0 0 0 0 transparent inset' }], { duration: 1100 }); return; }
    for (const sc of wrap.querySelectorAll<HTMLElement>('[data-pane] > .lc-scroll, [data-pane] .lc-panebody')) { const k = sc.closest('[data-pane]')?.getAttribute('data-pane') as Pane | null; if (k) tabScroll.set(k, sc.scrollTop); }
    const g = groupsNow().find((x) => x.includes(p)) ?? null;
    const slot: 'a' | 'b' = groupsNow().indexOf(g ?? []) === 1 ? 'b' : 'a';
    if (panes[slot] === p && panes.last === p) return;
    panes[slot] = p; panes.last = p; lsSet(LS.panes, panes);
    if (t !== 'show') { tab = paneTab(p); lsSet(LS.tab, tab); }
    closePop(); stopRecording(); paint(true);
    const ns = wrap.querySelector(`[data-pane="${p}"] .lc-panebody, [data-pane="${p}"] > .lc-scroll`) as HTMLElement | null;
    if (ns) ns.scrollTop = tabScroll.get(p) ?? 0;
  };
  const avatar = (name: string, o: { tv?: boolean; talk?: boolean; cls?: string } = {}) => el('span', { class: `av${o.talk ? ' talk' : ''}${o.cls ? ` ${o.cls}` : ''}`, style: `--h:${hue(name)}` }, initials(name),
    o.tv ? el('span', { class: 'tvb', title: 'TV guest (picture on the studio TV)' }, icon('tv', 11)) : null);

  // ---------------------------------------------------------------- docked: who is in a camera shot (popover)
  // Opens with right-click, a long-press or the ⋯ on a camera button; the button itself still cuts in one click.
  let pop: { shot: string; label: string } | null = null;
  const popEl = el('div', { class: 'lc-pop', role: 'dialog', 'aria-label': 'People in this shot' });
  popEl.addEventListener('pointerover', tt.over); popEl.addEventListener('pointerleave', tt.hide);
  const popAway = (e: Event) => { const t = e.target as HTMLElement; if (!popEl.contains(t) && !t.closest?.('.lc-cb .more')) closePop(); };
  const popKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; e.preventDefault(); e.stopPropagation(); const s = pop?.shot; closePop(); (wrap.querySelector(`.lc-cb[data-shot="${s}"]`) as HTMLElement | null)?.focus(); };
  function closePop() {
    if (!pop) return;
    wrap.querySelector('.lc-cb.popon')?.classList.remove('popon');
    pop = null; popEl.remove(); tt.hide();
    document.removeEventListener('pointerdown', popAway, true); document.removeEventListener('keydown', popKey, true); removeEventListener('resize', closePop);
  }
  function openPop(shot: string, label: string) {
    if (pop?.shot === shot) { closePop(); return; }
    closePop(); pop = { shot, label };
    document.addEventListener('pointerdown', popAway, true); document.addEventListener('keydown', popKey, true); addEventListener('resize', closePop);
    renderPop(); (popEl.querySelector('.foot button') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  function shotPopHooks(b: HTMLElement, shot: string, label: string) {
    let lp = 0, fired = false;
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!edit) openPop(shot, label); });
    b.addEventListener('pointerdown', (e) => { fired = false; if (e.button !== 0 || edit) return; lp = window.setTimeout(() => { fired = true; openPop(shot, label); }, 520); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(lp));
    // capture phase: the ⋯ and a finished long-press open the popover instead of cutting
    b.addEventListener('click', (e) => {
      const more = (e.target as HTMLElement).closest('[data-more]');
      if (!fired && !(more && !edit)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (more && !fired) openPop(shot, label);
      fired = false;
    }, { capture: true });
  }
  /** Who a shot frames (src/scene/talkshow/shots.ts): host / guest N / two = host + the first seated guest (else the monitor) / wide = everyone. */
  function renderPop() {
    if (!pop) return;
    const anchor = wrap.querySelector(`.lc-cb[data-shot="${pop.shot}"]`) as HTMLElement | null;
    if (!anchor) { closePop(); return; }
    anchor.classList.add('popon');
    const live = deck.live(), st = src.status(), shot = pop.shot;
    const others = st.party.members.filter((m) => !m.me);
    const lineup = live.guests ?? [];
    // (Co-host N / Guest N count within their role: shared/deck.ts lineupIndex)
    const nth = (gi: number) => { const r = lineup[gi]?.role === 'cohost' ? 'cohost' : 'guest'; let n = 0; for (let k = 0; k <= gi; k++) if ((lineup[k]?.role === 'cohost' ? 'cohost' : 'guest') === r) n++; return { role: r, n }; };
    const twoIdx = lineup.findIndex((g) => g.place === 'studio' && g.role !== 'cohost');
    type Person = { host: boolean; name: string; gi: number; m: (typeof others)[number] | null };
    const people: Person[] = [{ host: true, name: st.me.avatar || 'Host', gi: -1, m: null },
      ...others.map((m, i) => { const k = lineup.findIndex((g) => g.key === m.id); return { host: false, name: m.name, gi: k >= 0 ? k : !lineup.length && i < 4 ? i : -1, m }; })];
    const inShot = (p: Person) => {
      if (shot === 'wide' || shot === 'establishing') return true;
      if (p.host) return shot === 'host' || shot === 'two' || shot === 'hosts' || shot === 'panel';
      if (p.gi < 0) return false;
      const q = lineup.length ? nth(p.gi) : { role: 'guest', n: p.gi + 1 };
      if (q.role === 'cohost') return shot === `cohost${q.n}` || shot === 'panel' || (shot === 'hosts' && q.n === 1);
      return shot === `guest${q.n}` || (shot === 'guest' && q.n === 1) || (shot === 'two' && p.gi === (twoIdx >= 0 ? twoIdx : lineup.findIndex((g) => g.role !== 'cohost')));
    };
    const sorted = [...people.filter(inShot), ...people.filter((p) => !inShot(p))];
    const isPgm = live.mode === 'interview' && live.shot === shot;
    const row = (p: Person) => {
      const m = p.m, on = inShot(p), place = p.gi >= 0 ? lineup[p.gi]?.place : undefined, co = p.gi >= 0 && lineup[p.gi]?.role === 'cohost';
      return el('div', { class: `who${on ? '' : ' out'}`, 'data-person': m?.id ?? 'host' },
        avatar(p.name, { tv: !!m?.tv, talk: !!m?.speaking }),
        el('span', { class: 'nm' }, el('span', null, p.name), p.host ? el('span', { class: 'tag' }, 'YOU') : null, m?.tv ? el('span', { class: 'tag' }, 'TV') : null, m ? voiceTag(m) : null),
        el('span', { class: `st${on ? ' in' : ''}`, 'data-tip': on ? 'In this shot' : 'Not in this shot', 'data-hint': 'The camera frames who is in a shot by itself (seats, the monitor). Pick another shot, or move them In studio / On monitor.' }, on ? '● In shot' : 'Not in shot'),
        m ? el('div', { class: 'ctl' },
          p.gi >= 0 && lineup.length ? roleSeg(m.id, p.name, co) : null,
          p.gi >= 0 && !co ? el('div', { class: 'lc-seg s', role: 'group', 'aria-label': `${p.name}: where they sit` },
            B('In studio', 'guest-place', { peer: m.id, where: 'studio' }, { cls: '', ic: 'seat', icSize: 13, on: place === 'studio', tip: `${p.name}: sit in the studio` }),
            B('On monitor', 'guest-place', { peer: m.id, where: 'monitor' }, { cls: '', ic: 'tv', icSize: 13, on: place === 'monitor', tip: `${p.name}: show on the studio monitor` })) : p.gi >= 0 ? null : el('span', { class: 'lc-note' }, 'Not in the interview line-up'),
          m.voice ? B(m.muted ? 'Unmute' : 'Mute', 'guest-mute', { peer: m.id, on: m.muted ? 'false' : 'true' }, { cls: 'lc-btn s', ic: 'speak', icSize: 13, on: !!m.muted, tip: `${m.muted ? 'Unmute' : 'Mute'} ${p.name}'s voice`, hint: 'Their voice for everyone (Audio mixer has their volume and Mute for me)' }) : null,
          el('span', { style: 'flex:1' }),
          B('Kick', 'guest-kick', { peer: m.id, guest: others.indexOf(m) + 1 }, { cls: 'lc-btn s', ic: 'kick', icSize: 13, danger: true, tip: `Remove ${p.name} from the party`, hint: 'Click twice to confirm' })) : null);
    };
    popEl.replaceChildren(
      el('div', { class: 'ph' }, el('b', null, /^guest\d$/.test(shot) ? `${pop.label} · Guest ${shot.slice(5)}` : /^cohost\d$/.test(shot) ? `${pop.label} · Co-host ${shot.slice(6)}` : pop.label), isPgm ? el('span', { class: 'lc-livepill' }, 'NOW') : null,
        el('button', { class: 'lc-btn s ic', 'aria-label': 'Close', 'data-tip': 'Close', 'data-hint': 'Esc', onClick: closePop }, icon('x', 14))),
      ...sorted.map(row),
      ...(live.mode === 'interview' ? [] : [el('div', { class: 'lc-note' }, 'Camera cuts work in Interview mode.')]),
      el('div', { class: 'foot' },
        B(isPgm ? 'Showing now' : `Cut to ${pop.label}`, 'interview', { shot }, { cls: 'lc-btn s pri', ic: 'camera', icSize: 13, on: null }),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'lc-btn s', 'data-tip': 'Manage group', 'data-hint': 'Open the Guests panel', onClick: () => {
          closePop(); setTab('guests'); paint(true);
          const g = wrap.querySelector('[data-tile="guests"]') as HTMLElement | null;
          g?.scrollIntoView({ block: 'nearest' }); g?.animate?.([{ boxShadow: '0 0 0 2px var(--lc-acc) inset' }, { boxShadow: '0 0 0 0 transparent inset' }], { duration: 1100 });
        } }, icon('users', 13), 'Manage group')));
    if (!popEl.isConnected) document.body.append(popEl);
    const r = anchor.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const y = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8);
    popEl.style.left = `${Math.round(x)}px`; popEl.style.top = `${Math.round(Math.max(8, y))}px`;
  }

  // ---------------------------------------------------------------- PROGRAM monitor (persistent: the studio view sits over it)
  const pgmPic = el('div', { class: `lc-pgm-pic${src.program ? '' : ' popout'}` });
  const pgmTag = el('div', { class: 'lc-pgm-tag' });
  const pgmLt = el('div', { class: 'lc-lt' });
  const pgmMsg = el('div', { class: 'lc-pgm-msg' });
  // live-tabs BRB: the program monitor shows what viewers see — fade to black + the BRB card (src/scene/brb/overlay.ts)
  const pgmBrbHost = el('div', { class: 'lc-pgm-brb', style: 'position:absolute;inset:0;z-index:45;pointer-events:none;border-radius:10px;overflow:hidden' });
  const pgmBrb = new BrbOverlay(pgmBrbHost, { z: 1, maxW: 960 });
  /** live-layout: the look in effect — the studio's own state, else what the server reports, else the defaults. */
  const lookNow = (live: DeckLiveState): LiveLook => src.look?.get() ?? lookOfLive(live) ?? DEFAULT_LOOK;
  const brbLook = (live: DeckLiveState): SceneBrbState => {
    const lk = lookNow(live), m = /^(image|video):(\d+)$/.exec(lk.brbBg);
    return { style: lk.brbStyle, theme: lk.brbTheme, text: lk.brbText, ...(m ? { bg: { kind: m[1] as 'image' | 'video', rev: Number(m[2]) } } : {}) };
  };
  const pgmFrame = el('div', { class: 'lc-pgm-frame', 'data-live': 'program' }, pgmPic, pgmBrbHost, pgmTag, pgmLt);
  const pgm = el('section', { class: 'lc-pgm lc-a-pgm', 'aria-label': 'Studio view' }, pgmFrame);
  let undoProgram: (() => void) | null = null;
  /** beta.12: the studio view's size switch (above the picture; Hide = not drawn: body.lc-pgm-off, src/app.ts skips it). */
  function pgmBar() {
    const off = pgmSize === 'hidden';
    return el('div', { class: `lc-pgmbar${off ? ' off' : ''}`, role: 'group', 'aria-label': 'Studio view size', 'data-live': 'pgm-size' },
      icon(off ? 'eyeoff' : 'show', 14), el('span', { class: 't' }, 'Studio view'),
      off ? el('span', { class: 'lc-note' }, src.program ? 'Hidden: not drawn, so your graphics card works for OBS only. OBS and tracking keep running.' : 'Hidden') : null,
      el('span', { class: 'lc-sp' }),
      el('div', { class: 'lc-seg s' }, ...PGM_SIZES.map((x) => el('button', { type: 'button', class: pgmSize === x.id ? 'on' : '', 'aria-pressed': String(pgmSize === x.id), 'data-pgm': x.id,
        'data-tip': `Studio view: ${x.label}`, 'data-hint': x.hint, onClick: () => setPgm(x.id) }, x.label))));
  }
  const syncPgmBody = () => { if (src.program) document.body.classList.toggle('lc-pgm-off', pgmSize === 'hidden'); };
  function setPgm(v: PgmSize) {
    if (v === pgmSize) return;
    pgmSize = v; lsSet(PGM_KEY, v); syncPgmBody(); tall = false; wrap.classList.remove('lc-tall');
    paint(true); (wrap.querySelector(`[data-pgm="${v}"]`) as HTMLElement | null)?.focus();
  }
  syncPgmBody();
  let pgmThumbFor = '';
  // clarity (owner: people asked "what am I live to?"): red means OBS is showing VTube Pro, never the camera alone
  const onAir = (st: LiveStatus) => airState(st) === 'obs';
  const shotName = (live: DeckLiveState, s: string | undefined) => {
    if (!s) return 'Studio camera';
    const g = /^(guest|cohost)(\d)$/.exec(s);
    if (g) { const n = Number(g[2]), who = live.guests?.[lineupIndex(live.guests ?? [], g[1] as 'guest' | 'cohost', n)]?.name; return `${g[1] === 'cohost' ? 'Co-host' : 'Guest'} ${n}${who ? ` · ${who}` : ''}`; }
    return SHOT_NAMES[s] ?? s[0].toUpperCase() + s.slice(1);
  };
  /** Interview role of a member (one click each way): Guest | Co-host (co-hosts sit at the desk with you). */
  const roleSeg = (id: string, name: string, co: boolean) => el('div', { class: 'lc-seg s', role: 'group', 'aria-label': `${name}: guest or co-host` },
    B('Guest', 'interview-role', { who: id, role: 'guest' }, { cls: '', on: !co, tip: `${name}: a guest`, hint: 'On the monitor or in a guest chair' }),
    B('Co-host', 'interview-role', { who: id, role: 'cohost' }, { cls: '', ic: 'mic', icSize: 12, on: co, tip: `${name}: co-host`, hint: 'Sits with you at the desk, with their own camera and the Hosts / Panel shots (up to 2)' }));
  function paintProgram(live: DeckLiveState, st: LiveStatus) {
    pgmBrb.setState({ lights: { state: live.lighting }, brb: brbLook(live) });
    const air = onAir(st);
    pgmFrame.classList.toggle('air', air);
    const room = live.sceneId ? rooms.find((r) => r.id === live.sceneId) : null;
    const modeL = MODES.find((m) => m[0] === live.mode)?.[1] ?? live.mode;
    const iv = live.mode === 'interview';
    const shot = iv ? `${shotName(live, live.shot)}${(live.director ?? 'auto') === 'auto' ? ' · Auto director' : ''}` : (st.me.avatar || 'Studio camera');
    // the studio view draws your avatar only; a room is drawn by the OBS page (output.html), so say so instead of a
    // picture that silently lacks the room the lower third names. (clarity: "STUDIO VIEW" + where it is, not "PGM · ON AIR")
    pgmTag.replaceChildren(el('span', null, 'STUDIO VIEW'), el('span', { class: air ? 't-air' : 't-off', 'data-live': 'air-state' }, AIR_TEXT[airState(st)].label),
      ...(src.program && live.sceneId ? [el('span', { class: 't-off', 'data-live': 'room-in-obs' }, 'OBS ADDS YOUR ROOM')] : []));
    pgmLt.className = `lc-lt${air ? '' : ' off'}`;
    pgmLt.replaceChildren(el('div', null, el('span', { class: 'l1' }, shot), el('span', { class: 'l2' }, `${modeL} · ${room?.name ?? (live.sceneId ? live.sceneId : 'Classic (no room)')} · Lights: ${LIGHTS.find((l) => l.id === live.lighting)?.label ?? live.lighting}`)));
    if (!src.program) {
      // (an <img> over a placeholder, never a CSS url(): web mode routes <img> to the helper — src/ui/live/thumb.ts)
      const th = room?.thumb ?? '';
      if (th !== pgmThumbFor || !pgmPic.querySelector('.lc-thumb')) { pgmThumbFor = th; pgmPic.querySelector('.lc-thumb')?.remove(); pgmPic.prepend(liveThumb(th, null, room?.name ?? '')); }
      pgmMsg.replaceChildren(icon('show', 28), el('b', null, live.studio ? 'Your picture is in the studio tab' : 'Studio closed'), el('span', null, live.studio ? 'This window is a remote control. Its buttons change your show.' : 'Open the VTube Pro studio. These buttons do nothing until it’s open.'));
      if (!pgmMsg.isConnected) pgmPic.append(pgmMsg);
    }
  }

  // ---------------------------------------------------------------- regions
  function rRooms(live: DeckLiveState) {
    const cur = live.sceneId ?? '';
    const favs = roomFavs();
    const card = (id: string, name: string, thumb?: string | null) => {
      const fav = !!id && favs.includes(id);
      const b = el('button', {
        class: `lc-room${cur === id ? ' on' : ''}`, 'data-action': 'room', 'data-params': JSON.stringify({ sceneId: id }), 'aria-pressed': String(cur === id),
        'data-tip': id ? name : 'Classic (no room)', 'data-hint': id ? 'Switch room (the curtain covers the change)' : 'See-through background: your avatar over OBS', 'data-deck': deckKeys.get(quickKey({ action: 'room', params: { sceneId: id } })) ?? null,
        'data-ck': id ? `go to ${name.toLowerCase()} room` : null,
        onClick: () => { if (edit) return; void run('room', { sceneId: id }, name); },
      }, el('span', { class: 'th' }, liveThumb(thumb, icon(id ? 'room' : 'eyeoff', 22), name)), el('span', { class: 'nm' }, name));
      // beta.12: a star on each room (favourites come first; the filter shows only them). Not a button inside the card's
      // button: a sibling laid over its corner.
      const star = id ? el('button', { type: 'button', class: `lc-star${fav ? ' on' : ''}`, 'data-fav': id, 'aria-pressed': String(fav), 'aria-label': fav ? `Remove ${name} from favourites` : `Add ${name} to favourites`,
        'data-tip': fav ? 'Favourite (click to remove)' : 'Add to favourites', 'data-hint': 'Favourites come first here, in the show dock and in Room → Change room',
        onClick: (e: Event) => { e.stopPropagation(); const on = toggleRoomFav(id); src.toast(on ? `★ ${name}: a favourite` : `${name}: not a favourite any more`, 'ok'); (wrap.querySelector(`[data-fav="${globalThis.CSS.escape(id)}"]`) as HTMLElement | null)?.focus(); } }, fav ? '★' : '☆') : null;
      return el('div', { class: `lc-roomw${fav ? ' fav' : ''}` }, b, star);
    };
    const list = favFirst(rooms, favs, favOnly && favs.length > 0);
    const nFav = rooms.filter((r) => favs.includes(r.id)).length;
    const filter = el('div', { class: 'lc-seg s', role: 'group', 'aria-label': 'Which rooms' },
      el('button', { type: 'button', class: favOnly && nFav ? '' : 'on', 'aria-pressed': String(!(favOnly && nFav)), 'data-rooms': 'all', 'data-tip': 'Every room', 'data-hint': 'Favourites first', onClick: () => { favOnly = false; lsSet(LS.roomsFav, false); paint(true); } }, 'All'),
      el('button', { type: 'button', class: favOnly && nFav ? 'on' : '', 'aria-pressed': String(favOnly && nFav > 0), 'data-rooms': 'fav', disabled: nFav ? null : true, 'data-tip': nFav ? 'Only your favourites' : 'No favourites yet', 'data-hint': nFav ? `${nFav} starred` : 'Star a room (☆ on its card) to keep it here',
        onClick: () => { favOnly = true; lsSet(LS.roomsFav, true); paint(true); } }, `★ ${nFav || ''}`.trim()));
    return el('section', { class: 'lc-panel lc-a-rooms', 'data-tile': 'scene' },
      panelHead('scene', 'room', 'Rooms', el('span', { class: 'lc-count' }, String(rooms.length + 1)), filter,
        B('Prev area', 'area', { area: 'prev' }, { cls: 'lc-btn s ic', ic: 'prev', icSize: 14, lbl: false, tip: 'Previous area of this room' }),
        B('Next area', 'area', { area: 'next' }, { cls: 'lc-btn s ic', ic: 'next', icSize: 14, lbl: false, tip: 'Next area of this room' }),
        B('Reveal', 'curtain', undefined, { cls: 'lc-btn s', ic: 'curtain', icSize: 14, tip: 'Curtain: reveal the new room now', on: null })),
      el('div', { class: 'lc-scroll lc-rooms-wrap' }, el('div', { class: 'lc-rooms' }, favOnly && nFav ? null : card('', 'Classic'), ...list.map((r) => card(r.id, r.name, r.thumb)))));
  }
  function rShow(live: DeckLiveState) {
    // (owner: the original size was right — compact rows, not big cards; the split stays: what you're doing ≠ lighting)
    // beta.12 (owner: "What you're doing is too small, and people still mix up lighting and the show"): one line says what
    // viewers see right now (and whether anyone can: red only when OBS shows VTube Pro); then two clearly named rows of
    // big buttons, each saying what it changes. The lit lighting button is the accent, never the red "in OBS" tally.
    const onAirLook = live.lighting === 'show' || live.lighting === 'react';
    const go = onAirLook
      // (clarity: these only change the lights. so this one says Start show, not Go Live)
      ? B('End show', 'lighting', { state: 'outro' }, { cls: 'lc-btn s', ic: 'power', icSize: 13, danger: true, on: null, tut: 'live-end-show', tip: 'End show (lights only)', hint: 'Changes the lights to Outro. Click twice. Your stream keeps going: stop it in OBS.' })
      : B('Start show', 'lighting', { state: 'show' }, { cls: 'lc-btn s pri', ic: 'live', icSize: 13, on: null, tut: 'live-start-show', tip: 'Start show (lights only)', hint: 'Changes the lights to Show. It doesn’t start a stream: you go live with Start Streaming in OBS.' });
    const st = src.status(), as = airState(st);
    const lit = LIGHTS.find((l) => l.id === live.lighting), now = DOING.find((d) => d.id === live.mode);
    const roomN = live.sceneId ? rooms.find((r) => r.id === live.sceneId)?.name ?? live.sceneId : 'no room (see-through)';
    const hidden = [live.cover ? 'your screen is hidden' : '', live.chatHidden ? 'chat is hidden' : ''].filter(Boolean);
    const nowLine = el('div', { class: `lc-now ${as}`, role: 'status', 'data-live': 'now', 'data-air': as },
      el('span', { class: 'lc-nowair', 'data-tip': AIR_TEXT[as].tip, 'data-hint': AIR_TEXT[as].hint }, el('i'), as === 'obs' ? 'In OBS' : as === 'cam' ? 'Camera on' : 'Not in OBS'),
      el('span', { class: 'lc-nowtxt' }, el('b', null, as === 'obs' ? 'Viewers see now' : 'Viewers will see'),
        el('span', null, `${now?.doing ?? live.mode} · ${lit?.label ?? live.lighting} lights · ${roomN}${hidden.length ? ` · ${hidden.join(', ')}` : ''}`)));
    const modeKey = (id: string) => ({ talk: 'T', react: 'R', gaming: 'G', interview: 'I', ttrpg: 'P' } as Record<string, string>)[id];
    const flag = (on: boolean) => (on ? el('span', { class: 'flag' }, 'Now') : null);
    const doing = el('div', { class: 'lc-modes', role: 'group', 'aria-label': 'What you’re doing', 'data-tut': 'live-modes' }, ...DOING.map((d) => B(d.label, 'mode', { mode: d.id }, {
      cls: 'lc-mb', tip: `${d.label}${modeKey(d.id) ? ` (Shift+${modeKey(d.id)})` : ''}`, hint: `Click to switch. ${d.sub} Changes the layout and camera, not the lights.`,
      kids: [icon(d.ic, 20), el('b', null, d.label), el('small', null, d.sub.replace(/\. The default\.$/, '.')), flag(live.mode === d.id)] })));
    const lights = el('div', { class: 'lc-states', role: 'group', 'aria-label': 'Lighting', 'data-tut': 'live-lights' }, ...LIGHTS.map((l, i) => {
      const b = B(l.label, 'lighting', { state: l.id }, {
        cls: 'lc-sb', tip: `${l.label} lighting (Shift+${i + 1})`, hint: `Click: ${l.hint}. Only the room’s lights and screen change.`, kids: [icon(l.ic, 20), el('b', null, l.label), el('small', null, l.sub), flag(live.lighting === l.id)],
      });
      b.style.setProperty('--sw', l.sw);
      return b;
    }));
    const hideOn = !!live.cover;
    return el('section', { class: 'lc-panel lc-a-show', 'data-tile': 'show' },
      panelHead(null, 'sun', 'Show', B(hideOn ? 'Show my screen' : 'Hide my screen', 'cover', { on: 'toggle' }, { cls: `lc-btn lc-hidebtn${hideOn ? ' hidden-on' : ''}`, ic: 'eyeoff', icSize: 15, on: hideOn, tip: hideOn ? 'Your screen is hidden: click to show it' : 'Hide my screen', hint: 'An animated card covers your game or window (pick it in Privacy). Your avatar stays on screen.' }), go),
      nowLine,
      el('div', { class: 'lc-rowh', 'data-group': 'doing' }, el('b', null, 'What you’re doing'), el('span', null, 'Changes the layout and the camera on stream.')),
      doing,
      el('div', { class: 'lc-rowh', 'data-group': 'lighting' }, el('b', null, 'Lighting'), el('span', null, 'Only the room’s lights and screen. It never starts or stops your stream.')),
      lights,
      el('div', { class: 'lc-row', role: 'group', 'aria-label': 'Background video' }, el('span', { class: 'lc-lbl' }, 'Background video'),
        el('div', { class: 'lc-seg s' },
          B('On', 'video', { action: 'on', slot: '' }, { cls: '', on: live.videoOn, tip: 'Background video on', hint: 'The room screen plays your playlists (Starting soon / Talk ambience / Be right back / Ending)' }),
          B('Off', 'video', { action: 'off', slot: '' }, { cls: '', on: !live.videoOn, tip: 'Background video off', hint: 'Stays off when your look changes, until you turn it back on' })),
        live.videoOn ? B('Next', 'video', { action: 'next', slot: '' }, { cls: 'lc-btn s', ic: 'next', icSize: 13, on: null, tip: 'Next video' }) : null,
        B('Frame it', 'camera', { cam: 'screen' }, { cls: 'lc-btn s', ic: 'tv', icSize: 13, tip: 'Camera: centre the screen', hint: 'Centres the screen the video plays on (Camera: Screen). Auto puts the normal camera back.' }),
        B('Sound', 'video-audio', undefined, { cls: 'lc-btn s', ic: 'speak', icSize: 13, tip: 'Background video sound on / off (plays in the studio)' })));
  }
  function rCam(live: DeckLiveState, st: LiveStatus) {
    const inIv = live.mode === 'interview';
    const others = st.party.members.filter((m) => !m.me);
    // the line-up by role: co-hosts (at the desk) and guests (no line-up yet: the party members, as guests)
    const lineup = live.guests ?? [];
    const cos = lineup.filter((g) => g.role === 'cohost');
    const gus = lineup.length ? lineup.filter((g) => g.role !== 'cohost') : others.slice(0, 4).map((m) => ({ name: m.name, key: m.id, place: 'monitor' }));
    const n = Math.max(1, Math.min(4, gus.length));
    const auto = (live.director ?? 'auto') === 'auto';
    // (the auto director's likely next cut: whoever is talking)
    const talk = others.find((m) => m.speaking);
    const ci = talk ? cos.findIndex((g) => g.key === talk.id) : -1, gi = talk ? gus.findIndex((g) => g.key === talk.id) : -1;
    const nextShot = !inIv || !auto || !talk ? null : ci >= 0 ? `cohost${ci + 1}` : gi >= 0 ? `guest${gi + 1}` : null;
    const camB = (id: string, label: string, no: string, face: Node, hint?: string) => {
      const isPgm = inIv && live.shot === id, isNext = !isPgm && nextShot === id;
      const b = B(label, 'interview', { shot: id }, {
        cls: `lc-cb${isPgm ? ' pgm' : ''}${isNext ? ' pvw' : ''}${pop?.shot === id ? ' popon' : ''}`, on: isPgm, tip: `Cut to ${label}`, hint: `${hint ?? (auto ? 'Holds ~4 s, then the auto director takes over again' : 'Manual director: stays on this shot')}. Right-click, hold or ⋯: who is in it`,
        kids: [el('span', { class: 'no' }, no), isPgm ? el('span', { class: 'flag' }, 'NOW') : isNext ? el('span', { class: 'flag' }, 'NEXT') : null, face, el('span', { class: 'nm' }, mq(label)),
          el('span', { class: 'more', 'aria-hidden': 'true', 'data-more': '1' }, '⋯')],
      });
      b.dataset.shot = id; b.setAttribute('aria-haspopup', 'dialog');
      shotPopHooks(b, id, label);
      return b;
    };
    const memberOf = (g: { key: string; name: string }) => others.find((x) => x.id === g.key) ?? others.find((x) => x.name === g.name) ?? null;
    let no = 0;
    const face = (g: { key: string; name: string }) => { const m = memberOf(g); return avatar(g.name, { tv: !!m?.tv, talk: !!m?.speaking }); };
    const cams = el('div', { class: 'lc-cams', role: 'group', 'aria-label': 'Camera switcher' },
      el('div', { class: 'grp' },
        camB('host', 'Host', String(++no), avatar(st.me.avatar || 'Host', { cls: 'av' }), undefined),
        ...cos.slice(0, 2).map((g, i) => camB(`cohost${i + 1}`, g.name || `Co-host ${i + 1}`, String(++no), face(g), `Co-host ${i + 1}: at the desk with you`)),
        ...Array.from({ length: n }, (_, i) => { const g = gus[i] ?? { name: `Guest ${i + 1}`, key: '', place: '' }; return camB(`guest${i + 1}`, g.name || `Guest ${i + 1}`, String(++no), face(g)); }),
        ...(cos.length ? [camB('hosts', cos.length > 1 ? 'Hosts' : `You + ${cos[0].name || 'co-host'}`, String(++no), icon('two', 26), 'You and your co-host, side by side')] : []),
        ...(cos.length > 1 ? [camB('panel', 'Panel', String(++no), icon('users', 24), 'Everyone at the desk: you and both co-hosts')] : []),
        camB('two', 'Two-shot', String(++no), icon('two', 26)),
        camB('wide', 'Wide', String(++no), icon('wide', 26))),
      B(auto ? 'Auto on' : 'Auto off', 'interview', { shot: auto ? 'manual' : 'auto' }, {
        cls: `lc-cb auto${auto ? ' on' : ''}`, on: auto, tip: auto ? 'Auto director is ON' : 'Auto director is OFF', hint: auto ? 'Cuts to whoever is speaking. Click for manual.' : 'You cut by hand. Click to let the director cut on speakers.',
        kids: [icon('auto', 24), el('span', { class: 'nm' }, auto ? 'AUTO' : 'MANUAL'), el('span', { class: 'lc-note' }, auto ? 'director on' : 'director off')],
      }));
    if (!inIv) return rSceneCam(live, st);
    return el('section', { class: 'lc-panel lc-a-cam', 'data-tile': 'camera' },
      panelHead('camera', 'camera', 'Camera',
        B('Establishing', 'interview', { shot: 'establishing' }, { cls: 'lc-btn s' }), B('Over shoulder', 'interview', { shot: 'ots' }, { cls: 'lc-btn s' }),
        B('Push-in', 'interview', { shot: 'push' }, { cls: 'lc-btn s' }), B('Show open', 'interview', { shot: 'bumper' }, { cls: 'lc-btn s', ic: 'play', icSize: 12, on: null, hint: 'Plays the show-open bumper' })),
      cams);
  }
  /** Talk / React / Gaming …: the scene camera (SceneState.camera) — close-ups of anyone in the room, group, wide, the
   *  screen (centres the video / react window), the room's own presets. Interview has its own switcher above. */
  function rSceneCam(live: DeckLiveState, st: LiveStatus) {
    const modeL = MODES.find((m) => m[0] === live.mode)?.[1] ?? live.mode;
    const others = st.party.members.filter((m) => !m.me).slice(0, 4);
    const out = new Set(live.out ?? []);
    const auto = autoCamera(live.mode);
    const autoName = auto === 'react' ? 'React shot' : auto === 'group' ? 'Group' : auto === 'wide' ? 'Wide' : 'Close-up';
    let no = 0;
    const cb = (label: string, params: Record<string, string>, face: Node, hint: string, away = false) => {
      const lit = keyActive({ action: 'camera', params }, live) === true;
      return B(label, 'camera', params, {
        cls: `lc-cb${lit ? ' pgm' : ''}${away ? ' out' : ''}`, on: lit, tip: `Camera: ${label}`, hint: away ? `${hint}. They are outside the room right now: the camera frames whoever is in.` : hint,
        kids: [el('span', { class: 'no' }, String(++no)), lit ? el('span', { class: 'flag' }, 'NOW') : null, face, el('span', { class: 'nm' }, mq(label))],
      });
    };
    const cams = el('div', { class: 'lc-cams scn', role: 'group', 'aria-label': 'Scene camera' },
      el('div', { class: 'grp' },
        cb('Auto', { cam: 'auto' }, icon('auto', 24), `${modeL}: its own camera (${autoName})`),
        cb('Me', { cam: 'talk', focus: 'me' }, avatar(st.me.avatar || 'Me'), 'Close-up of you', out.has('@host')),
        ...others.map((m) => cb(m.name, { cam: 'talk', focus: m.id }, avatar(m.name, { tv: m.tv, talk: m.speaking }), `Close-up of ${m.name}`, out.has(m.id))),
        cb('Group', { cam: 'group' }, icon('two', 24), 'Everyone in the room, framed together'),
        cb('Wide', { cam: 'wide' }, icon('wide', 24), 'The whole room'),
        cb('Screen', { cam: 'screen' }, icon('tv', 24), 'Centred on the screen that shows the video / your React window (wide when nothing is on a screen)')));
    const presets = (st.cams ?? []).map((c) => B(c.replace(/^CAM_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()), 'camera', { cam: c }, { cls: 'lc-btn s', ic: 'camera', icSize: 12, tip: `Room camera ${c}` }));
    // React: the screen out of shot (a close-up never shows the side screen) — say so plainly, and what to press
    // (performers in the room: Auto picks the side screen for one, a stage layout or the big screen for a group)
    const inRoom = Math.max(1, st.party.members.filter((m) => !out.has(m.me ? '@host' : m.id)).length);
    const shotNote = reactShotNote(live, st.reactShot, inRoom);
    const driverNote = cameraDriverNote({ ...live, ttrpgOn: !!live.ttrpgOn && !!st.table });   // (a game left on in an ordinary room drives nothing)
    return el('section', { class: 'lc-panel lc-a-cam', 'data-tile': 'camera' },
      panelHead('camera', 'camera', `Camera · ${modeL}`, B('Interview cams', 'mode', { mode: 'interview' }, { cls: 'lc-btn s', on: null, hint: 'Switch to Interview mode: guests seated + the auto director' })),
      shotNote ? el('div', { class: 'lc-camhint', role: 'status', 'data-live': 'react-shot' }, icon('tv', 14), el('span', null, shotNote)) : null,
      driverNote ? el('div', { class: 'lc-camhint', role: 'status', 'data-live': 'cam-driver' }, icon('camera', 14), el('span', null, driverNote)) : null,
      cams,
      presets.length ? el('div', { class: 'lc-presets' }, el('span', { class: 'lc-lbl' }, 'Room cameras'), ...presets) : null);
  }
  /** Guest voice (link + app guests): hear them here, also on OBS, they hear me, which mic (Audio tab). */
  function voiceBlock(st: LiveStatus): HTMLElement | null {
    const others = st.party.members.filter((m) => !m.me);
    const v = st.voice;
    return v && others.some((m) => m.voice || m.vox === 'app' || m.vox === 'wait') || v?.error ? el('div', { class: 'lc-ent', role: 'group', 'aria-label': 'Guest voice (link + app guests)' },
      el('span', { class: 'lc-lbl', 'data-tip': 'Voice without Discord', 'data-hint': 'Link guests and VTube Pro app guests who talk in the app: everyone hears everyone (each gets a mix without their own voice)' }, 'Guest voice'),
      B('Hear them', 'guest-voice', { what: 'hear', on: v!.hear ? 'false' : 'true' }, { cls: 'lc-btn s', ic: 'speak', icSize: 13, on: v!.hear, tip: v!.hear ? 'You hear your guests here' : 'Guests are silent here (and never on the OBS page)', hint: 'Plays their voice in the studio window: the only place VTube Pro plays guests (never the OBS page). Wear headphones, or it echoes into your mic. Your stream gets them from this window, like a Discord call.' }),
      B('They hear me', 'guest-voice', { what: 'talkback', on: v!.talkback ? 'false' : 'true' }, { cls: 'lc-btn s', ic: 'mic', icSize: 13, on: v!.talkback, tip: v!.talkback ? 'Link guests hear you' : 'Link guests do not hear you', hint: 'Sends your mic to link guests (on by default when one arrives)' }),
      v!.mics?.length ? (() => {
        const sel = el('select', { class: 'lc-select', 'aria-label': 'Microphone link guests hear', 'data-tip': 'Your mic for link guests', 'data-hint': 'Which microphone link guests (not in Discord) hear. Same as lip sync = the mic VTube Pro tracks your mouth with.', style: 'max-width:220px' },
          el('option', { value: '' }, 'Mic: same as lip sync'), ...v!.mics!.map((m) => el('option', { value: m.id }, `Mic: ${m.label}`)));
        sel.value = v!.mics!.some((m) => m.id === v!.micSel) ? v!.micSel! : '';
        sel.addEventListener('change', () => void run('guest-voice', { what: 'mic', mic: sel.value }, 'Microphone'));
        return sel;
      })() : null,
      v!.talkback && !v!.error ? el('span', { class: 'lc-note', 'data-tip': 'What link guests hear', 'data-hint': 'Your mic for talk-back (the same one lip sync uses). The bar moves when you talk: if it stays still, guests hear silence.' },
        `Sending: ${v!.mic || 'mic'} `, el('span', { class: 'mtr', style: 'display:inline-block;width:46px;height:5px;border-radius:3px;background:var(--lc-bg1);vertical-align:middle;overflow:hidden' },
          el('u', { 'data-talkmeter': '1', style: `display:block;height:100%;width:${Math.round((v!.level ?? 0) * 100)}%;background:var(--lc-ok)` }))) : null,
      v!.error ? el('span', { class: 'lc-note', style: 'color:var(--lc-warn)' }, `Mic: ${v!.error}`) : null,
      // guest ↔ guest mix paused (the browser starts audio only after a click in the studio window)
      v!.mix?.state === 'suspended' ? el('button', { class: 'lc-btn s', style: 'color:var(--lc-warn)', 'data-tip': 'Guests can’t hear each other yet', 'data-hint': 'The browser only starts the guest-to-guest mix after a click or key press in the STUDIO window. Click this (in the studio), or anywhere in the studio window.', onClick: () => src.toast(src.program ? 'Starting guest-to-guest audio…' : 'Click once inside the STUDIO window: the pop-out can’t start it', src.program ? 'ok' : 'warn') }, '⚠ Guests can’t hear each other — click to start') : null) : null;
  }
  function pGuests(live: DeckLiveState, st: LiveStatus) {
    const others = st.party.members.filter((m) => !m.me);
    // (by member id; by position only when no line-up key matches anyone — never pair a member with someone else's slot)
    const anyKey = others.some((m) => live.guests?.some((g) => g.key === m.id));
    const ivIndex = (id: string, i: number) => { const k = live.guests?.findIndex((g) => g.key === id) ?? -1; return k >= 0 ? k : !anyKey && i < (live.guests?.length ?? 0) ? i : -1; };
    const linkBtn = (cls: string) => src.copyLink
      ? el('button', { class: cls, 'data-action': 'guest-link', 'data-tip': 'Copy guest link', 'data-hint': 'A link that works for 10, 30 or 60 minutes (choose in Invite someone). Guests open it in any browser, no install, no Discord: you talk over the link.', 'data-ck': 'invite link', onClick: () => src.copyLink!() }, icon('link', 16), 'Copy guest link')
      : B('Copy guest link', 'guest-link', undefined, { cls, ic: 'link', on: null, hint: 'Copied in the studio window (it must be open)' });
    const inRoom = !!live.sceneId;
    const out = new Set(live.out ?? []);
    const walk = live.walk !== false;
    /** In the room / outside: status + the two ways in (walk / already here) or out (walk out / gone). */
    const presence = (key: string, who: string, name: string) => {
      if (!inRoom) return null;
      const isIn = !out.has(key);
      const tipName = key === '@host' ? 'You' : name;
      return el('div', { class: 'lc-row', role: 'group', 'aria-label': `${name}: in the room` },
        el('span', { class: `st${isIn ? ' in' : ''}`, 'data-tip': isIn ? 'In the room' : 'Outside the room' }, isIn ? '● In room' : '○ Outside'),
        ...(isIn
          ? [B(walk ? 'Walk out' : 'Leave', 'presence', { who, on: 'out', how: walk ? 'walk' : 'instant' }, { cls: 'lc-btn s', ic: 'door', icSize: 13, on: null, tip: `${tipName}: ${walk ? 'walk out through the door' : 'leave the room'}` }),
            walk ? B('Gone', 'presence', { who, on: 'out', how: 'instant' }, { cls: 'lc-btn s', on: null, tip: `${tipName}: vanish from the room now (no walk)` }) : null]
          : [B(walk ? 'Walk in' : 'Come in', 'presence', { who, on: 'in', how: walk ? 'walk' : 'instant' }, { cls: 'lc-btn s pri', ic: 'door', icSize: 13, on: null, tip: `${tipName}: ${walk ? 'enter through the door and sit down' : 'come into the room'}` }),
            walk ? B('Already here', 'presence', { who, on: 'in', how: 'instant' }, { cls: 'lc-btn s', ic: 'seat', icSize: 13, on: null, tip: `${tipName}: already in the seat (no walk-in)` }) : null]));
    };
    // ---- greenroom: waiting guests (tech check + Bring on) and the settings
    const G = st.party.green;
    const waiting = others.filter((m) => m.gr?.wait);
    const onAirRows = others.filter((m) => !m.gr?.wait);
    const ago = (at: number) => el('time', { 'data-at': String(at) }, agoText(at));
    const msgRow = (m: LiveMember) => {
      const inp = el('input', { type: 'text', maxlength: String(HOST_MSG_MAX), placeholder: m.gr?.caps === false ? 'Their page is too old for messages' : `Message ${m.name}…`, 'aria-label': `Message to ${m.name}`, 'data-grdraft': m.id, value: drafts.get(m.id) ?? '', disabled: m.gr?.caps === false ? true : null });
      const send = () => { const t = inp.value.trim(); if (!t) return; drafts.delete(m.id); inp.value = ''; void run('greenroom-msg', { preset: 'text', text: t, to: 'member', peer: m.id }, 'Message'); };
      inp.addEventListener('input', () => drafts.set(m.id, inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
      return el('div', { class: 'lc-grmsg', role: 'group', 'aria-label': `Messages to ${m.name}` },
        ...GR_PRESETS.map((p) => B(p.label, 'greenroom-msg', { preset: p.id, to: 'member', peer: m.id }, { cls: 'lc-btn s', on: null, tip: `Send “${p.text}”`, hint: 'A banner on their page (no sound)' })),
        inp, el('button', { class: 'lc-btn s', onClick: send, disabled: m.gr?.caps === false ? true : null }, 'Send'));
    };
    const saying = (g: NonNullable<LiveMember['gr']>) => {
      const said = g.ready?.text ? g.ready : g.note && (!g.ready || g.note.at > g.ready.at) ? g.note : null;
      return said ? el('div', { class: 'lc-grsay' }, el('q', null, said.text), ' · ', ago(said.at)) : null;
    };
    // ---- moderation: per guest — camera, mic, volume, cut (instant; Undo in the strip at the top; enforced in the studio)
    const camPill = (m: LiveMember) => {
      const off = !!m.mod?.cam, what = m.tv ? 'Camera' : 'Avatar';
      return B(off ? `${what} hidden` : `${what} on`, 'guest-cam', { peer: m.id, on: off ? 'false' : 'true' }, { cls: `lc-mt${off ? ' off' : ''}`, on: null, kids: [el('i', { class: 'dot' }), icon(off ? 'eyeoff' : 'camera', 13), off ? `${what} hidden` : `${what} on`],
        tip: off ? `Show ${m.name}’s ${what.toLowerCase()} again` : `Hide ${m.name}’s ${what.toLowerCase()} from the show`,
        hint: m.tv ? 'Instant. Stream, the OBS page and the other guests see a “Camera off” card instead. They are told. Undo at the top.' : 'Instant. Their avatar leaves the room on stream and for the other guests. They are told. Undo at the top.' });
    };
    const micPill = (m: LiveMember) => {
      const off = !!m.mod?.mic;
      return B(off ? 'Muted' : 'Mic on', 'guest-mute', { peer: m.id, on: off ? 'false' : 'true' }, { cls: `lc-mt${off ? ' off' : ''}`, on: null, kids: [el('i', { class: 'dot' }), icon(off ? 'micoff' : 'mic', 13), off ? 'Muted' : 'Mic on'],
        tip: off ? `Unmute ${m.name}` : `Mute ${m.name}`,
        hint: m.vox === 'discord' ? 'Instant in VTube Pro (stream, OBS page, other guests). They talk through Discord: server-mute them there too.' : 'Instant. Off the stream, your speakers and every other guest’s ears. They still hear the show and can’t unmute themselves. Undo at the top.' });
    };
    const volCtl = (m: LiveMember) => {
      const v = Math.round((m.mod?.vol ?? m.vol ?? 1) * 100), muted = !!m.mod?.mic;
      const out = el('b', null, `${v}%`);
      const inp = el('input', { type: 'range', min: '0', max: '100', step: '1', value: String(v), 'aria-label': `${m.name}: volume`, 'data-modvol': m.id, disabled: muted || !src.canRun ? true : null });
      let sentAt = 0, last = v, t = 0;
      const send = (x: number) => { if (x === last) return; last = x; sentAt = performance.now(); void run('guest-volume', { peer: m.id, vol: x }, 'Volume'); };
      inp.addEventListener('input', () => { slideAt = performance.now(); const x = Number(inp.value); out.textContent = `${x}%`; clearTimeout(t); if (performance.now() - sentAt > 140) send(x); else t = window.setTimeout(() => send(x), 150); });
      inp.addEventListener('change', () => { clearTimeout(t); send(Number(inp.value)); });
      return el('label', { class: 'lc-vol', 'data-tip': muted ? 'Muted (unmute first)' : `${m.name}: volume`, 'data-hint': 'On stream, in your speakers and in the other guests’ mix. A drag is one Undo step.' }, icon('speak', 13), inp, out);
    };
    const cutBtn = (m: LiveMember) => {
      const cut = !!m.mod?.cam && !!m.mod?.mic;
      const b = el('button', { class: `lc-cut${cut ? ' back' : ''}`, 'data-action': 'guest-cut', 'data-tip': cut ? `Bring ${m.name} back` : `Cut ${m.name}: camera AND mic off now`, 'data-hint': cut ? 'Camera and mic back on' : 'Instant, no confirm. Undo at the top brings them back.',
        onClick: () => void run('guest-cut', { peer: m.id, on: cut ? 'false' : 'true' }, 'Cut') }, icon(cut ? 'check' : 'x', 13), cut ? 'Bring back' : 'Cut');
      return b;
    };
    const modStrip = (m: LiveMember) => el('div', { class: 'lc-mod', role: 'group', 'aria-label': `${m.name}: camera and mic` }, camPill(m), micPill(m), volCtl(m), cutBtn(m));
    /** After a cut: what next (all plain words) — bring back, hold in the green room, remove, remove + block. */
    const follow = (m: LiveMember) => {
      const md = m.mod;
      if (!md?.cam || !md?.mic) return null;
      const link = !!m.gr?.link;
      return el('div', { class: 'lc-modfollow', role: 'group', 'aria-label': `${m.name}: after the cut` },
        el('span', { class: 'what' }, icon('eyeoff', 13), el('span', null, 'Cut ', el('time', { 'data-at': String(md.at) }, agoText(md.at)), ' — viewers see a “Camera off” card, nobody hears them.')),
        m.gr && !m.gr.wait ? B('Hold in green room', 'greenroom-back', { peer: m.id }, { cls: 'lc-btn s', ic: 'sofa', icSize: 13, on: null, tip: `Send ${m.name} to the green room`, hint: 'Off the show until you bring them on (they stay cut)' }) : null,
        B('Remove', 'guest-kick', { peer: m.id }, { cls: 'lc-btn s', ic: 'kick', icSize: 13, danger: true, on: null, tip: `Remove ${m.name} from the party`, hint: 'Click twice to confirm. They can come back with the link.' }),
        B('Remove + block', 'guest-kick', { peer: m.id, ban: 'true' }, { cls: 'lc-btn s', ic: 'kick', icSize: 13, danger: true, on: null, tip: `Remove ${m.name} and block them`, hint: link ? 'Click twice to confirm. Blocks their browser tab from this party. To stop the invite link for everyone, use Turn link off.' : 'Click twice to confirm. Their Discord account can’t join this party again.' }),
        link ? B('Turn link off', 'guest-link', { do: 'off' }, { cls: 'lc-btn s', ic: 'link', icSize: 13, danger: true, on: null, tip: 'Turn the invite link off', hint: 'Click twice to confirm. The link stops working for everyone (guests already here stay). Make a new one any time.' }) : null);
    };
    const modRow = (m: LiveMember) => {
      const hid = !!m.mod?.cam;
      const pv = m.tv ? el('div', { class: `lc-modpv${hid ? ' hid' : ''}`, 'data-tip': hid ? 'Hidden from the show — only you see this' : 'Their camera right now', 'data-hint': 'Live preview (only you see it)' },
        m.cam ? el('img', { src: m.cam, alt: `${m.name}’s camera`, 'data-modcam': m.id }) : el('span', { class: 'none' }, 'Waiting for their picture…'),
        hid ? el('span', { class: 'hidtag' }, icon('eyeoff', 10), 'Hidden') : null) : null;
      return el('div', { class: 'lc-modrow' }, pv, el('div', { class: 'lc-modcol' }, modStrip(m), follow(m)));
    };
    const greenCard = (m: LiveMember) => {
      const g = m.gr!, c = g.conn, hid = !!m.mod?.cam;
      return el('div', { class: `lc-gr${g.ready ? ' ready' : ''}`, 'data-gr': m.id },
        el('div', { class: `thumb${hid ? ' hid' : ''}`, 'data-tip': hid ? 'Hidden from the show (they stay hidden when you bring them on)' : 'Their camera (tech check: only you see it)' },
          g.thumb ? el('img', { src: g.thumb, alt: `${m.name}’s camera`, 'data-grthumb': m.id }) : el('span', { class: 'none', 'data-grthumb': m.id }, m.tv ? 'Waiting for their picture…' : 'No camera on the link'),
          g.micOff ? el('span', { class: 'muted' }, icon('micoff', 10), 'MUTED') : null,
          hid ? el('span', { class: 'hidtag' }, icon('eyeoff', 10), 'Hidden') : null,
          g.level !== undefined ? el('i', { class: 'lv', 'data-tip': 'Their mic level' }, el('u', { 'data-grlevel': m.id, style: `width:${Math.round((g.level ?? 0) * 100)}%` })) : null),
        el('div', { class: 'body' },
          el('div', { class: 'who' }, mq(m.name), g.link ? el('span', { class: 'tag', 'data-tip': 'Joined by link', 'data-hint': 'Not verified: the name is what they typed' }, 'LINK') : null,
            g.ready ? el('span', { class: 'tag rdy', 'data-tip': 'They pressed “I’m ready”' }, 'READY') : null,
            g.micOff ? el('span', { class: 'tag off', 'data-tip': 'Their mic is muted on their page' }, icon('micoff', 11), 'MUTED') : null,
            g.talk ? el('span', { class: 'tag talk', 'data-tip': 'Backstage voice: only you two' }, 'BACKSTAGE') : null),
          el('div', { class: 'conn', 'data-tip': 'Connection', 'data-hint': 'Round trip · their picture as it arrives here' }, el('i', { class: c?.st ?? '', 'data-grdot': m.id }), el('span', { 'data-grconn': m.id }, connText(c))),
          el('div', { class: 'lc-note' }, 'Waiting for ', el('time', { 'data-at': String(g.since), 'data-dur': '1' }, agoText(g.since, true))),
          saying(g),
          g.last ? el('div', { class: 'lc-grsent' }, 'You sent: ', el('q', null, g.last.text), ' · ', ago(g.last.at)) : null),
        el('div', { class: 'acts' },
          B('Bring on', 'greenroom-on', { peer: m.id }, { cls: 'lc-btn s pri', ic: 'door', icSize: 13, on: null, tip: `Bring ${m.name} onto the show`, hint: 'They enter with your Entrances setting (walk in / appear) and take their place in Interview' }),
          B(g.talk ? 'Stop backstage voice' : 'Talk backstage', 'greenroom-talk', { peer: m.id, on: g.talk ? 'false' : 'true' }, { cls: 'lc-btn s', ic: 'mic', icSize: 13, on: !!g.talk, tip: 'Two-way voice with this guest only', hint: 'Plays on the backstage output below, never on the OBS page. Your mic may also be on stream: mute it there while you talk backstage.' }),
          B('Remove', 'guest-kick', { peer: m.id }, { cls: 'lc-btn s', ic: 'kick', icSize: 13, danger: true, on: null, tip: `Remove ${m.name} from the party`, hint: 'Click twice to confirm' }),
          // moderation: decide before they come on (it stays when you bring them on)
          camPill(m), micPill(m)),
        msgRow(m));
    };
    const greenBox = G ? el('div', { class: 'lc-grbox', 'data-greenroom': '1' },
      el('div', { class: 'lc-grhead' }, el('h4', null, icon('sofa', 14), 'Green room'), el('span', { class: 'lc-count' }, String(waiting.length)),
        (() => {
          const sel = el('select', { class: 'lc-select', 'aria-label': 'Who waits in the green room', 'data-tip': 'New guests', 'data-hint': 'Who waits here when they join (you bring them on when you’re ready). Guests who reconnect keep their place.' },
            el('option', { value: 'link' }, 'Link guests wait'), el('option', { value: 'all' }, 'Everyone waits'), el('option', { value: 'off' }, 'Nobody waits'));
          sel.value = G.mode;
          sel.addEventListener('change', () => void run('greenroom-mode', { mode: sel.value }, 'Green room'));
          return sel;
        })(),
        el('span', { class: 'lc-sp', style: 'flex:1' }),
        waiting.length ? B('Bring on next', 'greenroom-on', undefined, { cls: 'lc-btn s pri', on: null, tip: 'Bring on the next guest', hint: 'READY guests first, then who has waited longest' }) : null,
        waiting.length && onAirRows.length ? B('Next guest', 'greenroom-next', undefined, { cls: 'lc-btn s', on: null, tip: 'Swap: the guest brought on last goes back, the next one comes on' }) : null),
      waiting.length ? null : el('div', { class: 'lc-note' }, G.mode === 'off' ? 'Off: new guests come straight into the show.' : `${G.mode === 'all' ? 'Everyone who joins' : 'People who join by link'} wait here first: you see their camera, mic and connection, and bring them on when you’re ready.`),
      ...waiting.map(greenCard),
      waiting.length ? el('div', { class: 'lc-ent', role: 'group', 'aria-label': 'Backstage voice output' },
        el('span', { class: 'lc-lbl' }, 'Backstage output'),
        G.sinkOk ? (() => {
          const sel = el('select', { class: 'lc-select', 'aria-label': 'Backstage voice output', style: 'max-width:240px', 'data-tip': 'Where backstage voice plays', 'data-hint': 'Pick headphones that OBS does NOT capture. The default output is usually what OBS Desktop Audio records.' },
            el('option', { value: '' }, 'Default output (OBS may capture it)'), ...G.sinks.map((d) => el('option', { value: d.id }, d.label)));
          sel.value = G.sinks.some((d) => d.id === G.sink) ? G.sink : '';
          sel.addEventListener('change', () => void run('greenroom-output', { sink: sel.value }, 'Backstage output'));
          return sel;
        })() : el('span', { class: 'lc-grwarn' }, 'This browser can’t pick an output: backstage voice plays on the default output.'),
        el('span', { class: 'lc-grwarn' }, !G.sinkOk || !G.sink ? '⚠ If OBS captures Desktop Audio, backstage talk can reach stream. ' : '',
          waiting.some((m) => m.gr?.talk) ? 'Backstage voice: only you two, never on the OBS page — but your own mic may be live on stream: mute it there while you talk.' : 'Messages only by default: no voice either way while they wait.'),
        G.error ? el('span', { class: 'lc-grwarn' }, G.error) : null) : null) : null;
    const meRow = el('div', { class: `lc-guest me${out.has('@host') ? ' outside' : ''}`, 'data-member': 'host' },
      avatar(st.me.avatar || 'Me'), el('div', { class: 'who lc-mqh' }, mq(st.me.avatar || 'You'), el('span', { class: 'tag' }, 'YOU'), st.me.spout ? spoutTag(st.me.spout, 'host') : null), el('span'), el('span'),
      el('div', { class: 'ctl' }, presence('@host', 'me', 'You')));
    const list = el('div', { class: 'lc-scroll', style: 'display:flex;flex-direction:column;gap:6px' },
      ...st.party.knocks.map((k) => el('div', { class: 'lc-guest knock' }, avatar(k.name),
        el('div', { class: 'who' }, icon('door', 14), mq(`${k.name} is knocking`), k.link ? el('span', { class: 'tag', 'data-tip': 'Joined by link', 'data-hint': 'Not verified: anyone with the link can knock' }, 'LINK') : null),
        el('div', { class: 'ctl' }, B('Let in', 'knock-approve', { peer: k.peer }, { cls: 'lc-btn s pri', on: null }), B('Deny', 'knock-deny', { peer: k.peer }, { cls: 'lc-btn s', on: null })))),
      // guestlink: people I let in whose connection is still coming up / never came up (else they'd just vanish)
      ...(st.party.joins ?? []).map((j) => el('div', { class: `lc-guest knock${j.state === 'failed' ? ' outside' : ''}`, 'data-join': j.peer }, avatar(j.name),
        el('div', { class: 'who' }, mq(j.name), j.link ? el('span', { class: 'tag' }, 'LINK') : null),
        el('div', { class: 'ctl' }, el('span', { class: 'lc-note', 'data-jointext': j.peer, style: j.state === 'failed' ? 'color:var(--lc-warn)' : '', 'data-tip': j.state === 'failed' && st.party.turn === false ? 'Their network needs TURN' : '', 'data-hint': j.state === 'failed' && st.party.turn === false ? TURN_SETUP : '' }, joinText(j, st.party.turn))))),
      meRow,
      greenBox,
      ...onAirRows.map((m) => {
        const i = others.indexOf(m);
        const gi = ivIndex(m.id, i), place = gi >= 0 ? live.guests?.[gi]?.place : undefined, co = gi >= 0 && live.guests?.[gi]?.role === 'cohost';
        const g = m.gr;
        const cutNow = !!m.mod?.cam && !!m.mod?.mic;
        return el('div', { class: `lc-guest${m.speaking ? ' speaking' : ''}${out.has(m.id) ? ' outside' : ''}${cutNow ? ' modcut' : ''}`, 'data-member': m.id },
          avatar(m.name, { tv: m.tv, talk: m.speaking }),
          el('div', { class: 'who lc-mqh' }, mq(m.name), m.spout ? spoutTag(m.spout, m.id) : m.tv ? el('span', { class: 'tag' }, 'TV') : null, voiceTag(m),
            m.verified ? el('span', { class: 'tag', title: 'Signed in' }, '✓') : null,
            g?.ready ? el('span', { class: 'tag rdy', 'data-tip': 'They pressed “I’m ready”' }, 'READY') : null,
            g?.micOff ? el('span', { class: 'tag off', 'data-tip': 'They muted their mic on their page' }, icon('micoff', 11), 'MUTED') : null,
            el('span', { class: 'talking', 'aria-label': 'Talking' }, el('i'), el('i'), el('i'))),
          // (one cell: Mute and Remove used to share grid column 4 and the Remove button covered Mute)
          // (moderation: Mute moved into the strip below with Camera / Volume / Cut)
          el('div', { class: 'lc-acts' },
            B('Remove', 'guest-kick', { peer: m.id, guest: i + 1 }, { cls: 'lc-btn s ic', ic: 'kick', icSize: 14, lbl: false, danger: true, tip: `Remove ${m.name} from the party`, hint: 'Click twice to confirm' })),
          el('div', { class: 'ctl' }, presence(m.id, m.id, m.name),
            live.mode === 'interview' ? (gi >= 0 && live.guests?.length ? el('div', { class: 'lc-row', role: 'group', 'aria-label': `${m.name}: on the show` },
              roleSeg(m.id, m.name, co),
              co ? el('span', { class: 'lc-note', 'data-tip': 'Co-host', 'data-hint': 'Sits with you at the desk' }, 'At the desk') : el('div', { class: 'lc-seg s', role: 'group', 'aria-label': `${m.name}: where they sit` },
                B('In studio', 'guest-place', { peer: m.id, where: 'studio' }, { cls: '', ic: 'seat', icSize: 13, on: place === 'studio', tip: `${m.name}: sit in the studio` }),
                B('On monitor', 'guest-place', { peer: m.id, where: 'monitor' }, { cls: '', ic: 'tv', icSize: 13, on: place === 'monitor', tip: `${m.name}: show on the studio monitor` })))
              : el('span', { class: 'lc-note' }, 'Not in the interview line-up')) : null,
            g ? B('Green room', 'greenroom-back', { peer: m.id }, { cls: 'lc-btn s', ic: 'sofa', icSize: 13, on: null, tip: `Send ${m.name} back to the green room`, hint: 'They walk out (walk-ins on) or vanish, and wait off the show: no voice on stream' }) : null,
            g ? el('button', { class: `lc-btn s ic${msgOpen.has(m.id) ? ' on' : ''}`, 'aria-label': `Message ${m.name}`, 'aria-pressed': String(msgOpen.has(m.id)), 'data-tip': `Message ${m.name}`, 'data-hint': 'A banner on their page (no sound)', onClick: () => { if (msgOpen.has(m.id)) msgOpen.delete(m.id); else msgOpen.add(m.id); paint(true); } }, icon('chat', 14)) : null),
          g && (saying(g) || g.last) ? el('div', { class: 'grline' }, saying(g), g.last ? el('div', { class: 'lc-grsent' }, 'You sent: ', el('q', null, g.last.text), ' · ', ago(g.last.at)) : null) : null,
          st.party.role === 'host' ? modRow(m) : null,
          g && msgOpen.has(m.id) ? msgRow(m) : null);
      }),
      st.party.role === 'host' && st.party.turn === false ? el('div', { class: 'lc-note', 'data-tip': 'No TURN on your relay', 'data-hint': TURN_SETUP },
        '⚠ No TURN on your relay: guests on mobile data, work / school Wi-Fi or strict routers can’t connect (hover: how to fix)') : null,
      others.length || st.party.knocks.length ? null : el('div', { class: 'lc-empty' }, el('b', null, 'No guests yet'),
        el('div', { class: 'lc-note' }, st.party.role === 'none' ? 'Invite someone to your show.' : 'Your party is open. Nobody has joined yet.'),
        linkBtn('lc-btn pri'),
        el('div', { class: 'lc-steps' }, el('span', null, el('b', null, '1'), 'Send the link'), el('span', null, el('b', null, '2'), 'They open it, no install'), el('span', null, el('b', null, '3'), 'Bring them on'))));
    // entrances: walk-ins on / off, how people who join arrive
    const join = live.join ?? 'walk';
    const ent = inRoom ? el('div', { class: 'lc-ent', role: 'group', 'aria-label': 'Entrances' },
      el('span', { class: 'lc-lbl' }, 'Walk-ins'),
      el('div', { class: 'lc-seg s' },
        B('On', 'entrances', { walk: 'true' }, { cls: '', on: walk, tip: 'Walk-ins on', hint: 'People walk in through the door and out again' }),
        B('Off', 'entrances', { walk: 'false' }, { cls: '', on: !walk, tip: 'Walk-ins off', hint: 'People appear in (and vanish from) their seats, no walking' })),
      el('span', { class: 'lc-lbl' }, 'Joiners'),
      el('div', { class: 'lc-seg s' },
        B('Walk in', 'entrances', { join: 'walk' }, { cls: '', on: join === 'walk', tip: 'People who join walk in' }),
        B('Seated', 'entrances', { join: 'seated' }, { cls: '', on: join === 'seated', tip: 'People who join are already in their seat' }),
        B('Outside', 'entrances', { join: 'outside' }, { cls: '', on: join === 'outside', tip: 'People who join wait outside', hint: 'They are in the party but not in the room until you press Walk in / Already here' }))) : null;
    // live-tabs: guest voice (hear them / they hear me / mic) lives in the Audio tab; a one-line way there
    const voice = st.voice && (others.some((m) => m.voice || m.vox === 'app' || m.vox === 'wait') || st.voice.error) ? el('div', { class: 'lc-ent' }, icon('speak', 14),
      el('span', { class: 'lc-note' }, 'Hear your guests, and choose if they hear you:'), el('button', { class: 'lc-btn s', 'data-goto': 'audio', onClick: () => setTab('audio') }, 'Open Audio')) : null;
    const hasGuests = others.length > 0 || st.party.knocks.length > 0 || !!G;
    // moderation: the emergency button (instant, no confirm) + the Undo strip + what a cut also does
    const M = st.party.mod, host = st.party.role === 'host';
    const allCut = others.length > 0 && others.every((m) => m.mod?.cam && m.mod?.mic);
    const cutAll = host && others.length ? el('button', { class: `lc-cutall${allCut ? ' back' : ''}`, 'data-action': 'guests-cut-all', 'data-ck': 'cut all',
      'data-tip': allCut ? 'Bring every guest back on' : 'Cut all guests: every camera and mic off, now', 'data-hint': allCut ? 'Cameras and mics back on for everyone' : 'Instant, no confirm. One Undo brings everyone back.',
      onClick: () => void run('guests-cut-all', { on: allCut ? 'false' : 'true' }, 'Cut all') }, icon(allCut ? 'check' : 'power', 13), allCut ? 'Bring all back' : 'Cut all') : null;
    const undo = host && M?.last && undoShown() ? el('div', { class: 'lc-undo', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'what' }, el('b', null, M.last.label), ' · ', el('time', { 'data-at': String(M.last.at) }, agoText(M.last.at))),
      el('kbd', { 'data-tip': 'Ctrl+Z in this panel' }, 'Ctrl Z'),
      B('Undo', 'guest-undo', undefined, { cls: 'lc-btn s pri', on: null, tip: `Undo: ${M.last.label}`, hint: 'Puts the camera / mic / volume back exactly as before' })) : null;
    const holdRow = host && others.length ? el('div', { class: 'lc-ent', role: 'group', 'aria-label': 'When you cut a guest' },
      el('span', { class: 'lc-lbl', 'data-tip': 'When you cut a guest', 'data-hint': 'Cut = camera and mic off at once. Optionally also send them to the green room (off the show until you bring them on).' }, 'When I cut'),
      el('div', { class: 'lc-seg s' },
        B('Keep in place', 'guest-cut-hold', { on: 'false' }, { cls: '', on: !M?.hold, tip: 'They stay where they are: a “Camera off” card, no voice' }),
        B('Send to green room', 'guest-cut-hold', { on: 'true' }, { cls: '', on: !!M?.hold, tip: 'They also leave the show and wait in the green room' }))) : null;
    return el('section', { class: 'lc-panel', 'data-tile': 'guests' },
      panelHead('guests', 'users', 'People', others.length ? el('span', { class: 'lc-count' }, String(others.length + 1)) : null,
        cutAll, hasGuests ? linkBtn('lc-btn s') : null, st.party.role !== 'none' ? B('End party', 'party-end', undefined, { cls: 'lc-btn s', danger: true, on: null, hint: 'Everyone leaves. Click twice to confirm.' }) : null),
      undo, list, ent, holdRow, voice);
  }
  // poll composer: the draft lives here (the panel rebuilds; typing is kept), sent straight to /api/poll/* (same origin)
  const pollDraft = { open: false, q: '', opts: ['', ''], dur: 60 };
  const DURS: [number, string][] = [[30, '30 s'], [45, '45 s'], [60, '1 min'], [90, '1.5 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']];
  async function pollSend(method: 'POST' | 'PUT', url: string, body: unknown): Promise<boolean> {
    if (!src.canRun) { src.toast('Read-only here (observer tab): polls are off', 'warn'); return false; }
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text().catch(() => ''); src.toast(`Poll: ${(t.match(/"error"\s*:\s*"([^"]+)"/)?.[1] ?? t) || r.status}`, 'err'); return false; }
      return true;
    } catch { src.toast('Poll: the VTube Pro server did not answer', 'err'); return false; }
  }
  const draftDef = () => {
    const opts = pollDraft.opts.map((o) => o.trim()).filter(Boolean);
    const q = pollDraft.q.trim();
    if (!q) { src.toast('Poll: type the question first', 'warn'); return null; }
    if (opts.length < 2) { src.toast('Poll: give it at least 2 options', 'warn'); return null; }
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) { src.toast('Poll: two options are the same', 'warn'); return null; }
    return { question: q.slice(0, 120), options: opts.map((label) => ({ label: label.slice(0, 40) })), durationSec: pollDraft.dur };
  };
  function pollComposer(): HTMLElement {
    const d = pollDraft;
    if (!d.open) return el('div', { class: 'lc-row' }, el('span', { class: 'lc-lbl' }, 'Start'),
      el('button', { class: 'lc-btn s pri', 'data-tip': 'New poll', 'data-hint': 'Your own question and 2–8 options. Chat votes by typing an option (or its number).', onClick: () => { d.open = true; paint(true); (wrap.querySelector('[data-poll-q]') as HTMLInputElement | null)?.focus(); } }, icon('poll', 13), 'New poll…'),
      B('Yes / No', 'poll-start', { template: 'Yes / No' }, { cls: 'lc-btn s', on: null, tip: 'Quick Yes / No poll' }));
    const q = el('input', { type: 'text', class: 'lc-select', 'data-poll-q': '1', maxlength: '120', placeholder: 'Question (e.g. What should we play next?)', style: 'flex:1;min-width:0;max-width:none', 'aria-label': 'Poll question' }) as HTMLInputElement;
    q.value = d.q; q.addEventListener('input', () => { d.q = q.value; });
    const rows = d.opts.map((o, i) => {
      const inp = el('input', { type: 'text', class: 'lc-select', maxlength: '40', placeholder: `Option ${i + 1}`, style: 'flex:1;min-width:0;max-width:none', 'aria-label': `Option ${i + 1}` }) as HTMLInputElement;
      inp.value = o; inp.addEventListener('input', () => { d.opts[i] = inp.value; });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i === d.opts.length - 1 && d.opts.length < 8) { e.preventDefault(); d.opts.push(''); paint(true); (wrap.querySelectorAll('[aria-label^="Option "]')[i + 1] as HTMLInputElement | undefined)?.focus(); } });
      return el('div', { class: 'lc-row', style: 'flex-wrap:nowrap' }, el('span', { class: 'lc-note', style: 'width:14px;text-align:right' }, String(i + 1)), inp,
        d.opts.length > 2 ? el('button', { class: 'lc-btn s ic', 'aria-label': `Remove option ${i + 1}`, 'data-tip': 'Remove this option', onClick: () => { d.opts.splice(i, 1); paint(true); } }, icon('x', 12)) : null);
    });
    const dur = el('select', { class: 'lc-select', 'aria-label': 'Poll length' }, ...DURS.map(([v, l]) => el('option', { value: String(v) }, l))) as HTMLSelectElement;
    dur.value = String(d.dur); dur.addEventListener('change', () => { d.dur = Number(dur.value) || 60; });
    return el('div', { class: 'lc-poll', style: 'display:flex;flex-direction:column;gap:6px' },
      el('div', { class: 'lc-row', style: 'flex-wrap:nowrap' }, q),
      ...rows,
      el('div', { class: 'lc-row' },
        d.opts.length < 8 ? el('button', { class: 'lc-btn s', onClick: () => { d.opts.push(''); paint(true); } }, '+ Option') : null,
        el('span', { class: 'lc-lbl' }, 'Length'), dur, el('span', { class: 'lc-sp' }),
        el('button', { class: 'lc-btn s', 'data-tip': 'Save for later', 'data-hint': 'Keeps it in your saved polls (Stream Deck / Ctrl+K can start it by name)', onClick: async () => {
          const def = draftDef(); if (!def) return;
          if (await pollSend('PUT', '/api/poll/templates', { name: def.question.slice(0, 32), ...def })) { src.toast(`Saved poll “${def.question.slice(0, 32)}”`, 'ok'); void refreshPoll(); }
        } }, 'Save'),
        el('button', { class: 'lc-btn s', onClick: () => { d.open = false; paint(true); } }, 'Cancel'),
        el('button', { class: 'lc-btn s pri', 'data-tip': 'Start this poll now', onClick: async () => {
          const def = draftDef(); if (!def) return;
          if (await pollSend('POST', '/api/poll/start', def)) { d.open = false; d.q = ''; d.opts = ['', '']; src.toast('Poll started', 'ok'); paint(true); void refreshPoll(); }
        } }, icon('poll', 13), 'Start')));
  }
  function pChat(live: DeckLiveState) {
    const sel = el('select', { class: 'lc-select', 'aria-label': 'Saved poll', style: 'flex:1;min-width:0;max-width:none' }, ...templates.map((t) => el('option', { value: t }, t)));
    const pollBox = poll ? el('div', { class: 'lc-poll' },
      el('div', { class: 'q lc-mqh' }, poll.live ? el('span', { class: 'lc-livepill open', title: 'Chat can vote now' }, 'OPEN') : el('span', { class: 'tag lc-note' }, 'ENDED'), mq(poll.question || 'Poll'),
        el('span', { class: 'lc-note', style: 'font-family:var(--lc-mono)' }, `${poll.voters} vote${poll.voters === 1 ? '' : 's'}`)),
      ...poll.options.slice(0, 8).map((o, i) => { const pc = poll!.total > 0 ? Math.round((o.votes / poll!.total) * 100) : 0; return el('div', { class: `lc-bar${!poll!.live && poll!.winner.includes(i) ? ' win' : ''}` }, mq(o.label), el('span', { class: 'v' }, `${pc}%`), el('div', { class: 'trk' }, el('i', { style: `width:${pc}%` }))); }),
      el('div', { class: 'lc-row' }, poll.live ? B('End poll', 'poll-end', undefined, { cls: 'lc-btn s', ic: 'check', icSize: 13, on: null }) : null,
        B(poll.shown ? 'Card on stream' : 'Card hidden', 'poll-show', { on: 'toggle' }, { cls: 'lc-btn s', ic: poll.shown ? 'show' : 'eyeoff', icSize: 13, on: poll.shown, tip: 'Show / hide the poll card on stream' })))
      : null;
    return el('section', { class: 'lc-panel', 'data-tile': 'chat' },
      panelHead('chat', 'chat', 'Chat & polls', src.openChat ? el('button', { class: 'lc-btn s', 'data-live': 'chathub', 'data-tip': 'Chat Hub', 'data-hint': 'All chats + events beside the console (Pop out ↗ for its own window)', onClick: () => src.openChat!() }, icon('chat', 13), 'Chat Hub') : null),
      el('div', { class: 'lc-row', 'data-group': 'chat-hide' },
        el('button', { class: 'lc-btn s', 'data-live': 'stream-setup', 'data-tip': 'Set up chat & alerts', 'data-hint': 'Connect your chat, try your alerts, pick where chat shows. Step by step.',
          onClick: () => { if (document.dispatchEvent(new CustomEvent('vtp:stream-setup', { cancelable: true, detail: { from: 'live' } }))) src.toast('Open the studio window to set up chat & alerts (this pop-out can’t open it).', 'info'); } }, icon('wand', 13), 'Set up chat & alerts'),
        B(live.chatHidden ? 'Show chat' : 'Hide chat', 'chat-hide', { on: live.chatHidden ? 'false' : 'true' }, { cls: `lc-btn s${live.chatHidden ? ' pri' : ''}`, ic: live.chatHidden ? 'chat' : 'chatoff', icSize: 13, on: null, tip: live.chatHidden ? 'Show chat to viewers again' : 'Hide chat from viewers' }),
        el('button', { class: 'lc-btn s', 'data-live': 'chat-place', 'data-tip': 'Move the chat', 'data-hint': 'Pick where the chat shows: drag the chat box on your stream, per room, or put it on the room’s screen', onClick: () => { if (document.dispatchEvent(new CustomEvent('vtp:chat-place', { cancelable: true }))) src.toast('Open the studio window to move the chat (this pop-out can’t).', 'info'); } }, icon('chat', 13), 'Move chat'),   // chatfx (src/ui/chatBoxPanel.ts CHAT_PLACE_EVENT)
        B('Emote sounds', 'emote-sounds', undefined, { cls: `lc-btn s${live.emoteSounds ? ' pri' : ''}`, ic: 'speak', icSize: 13, on: !!live.emoteSounds, tip: live.emoteSounds ? 'Emote sounds are on: click to turn them off' : 'Play the sounds you gave emotes (Chat → Emotes & emote sounds). Off by default' }),   // chatfx
        el('span', { class: 'lc-note' }, live.chatHidden ? 'Chat is hidden from viewers.' : '')),
      el('div', { class: 'lc-chatgrid' },
        B('Read-aloud', 'hub-tts', undefined, { ic: 'speak', icSize: 18, on: live.tts, hint: 'Reads chat out loud (Chat Hub)' }), B('Ack next', 'hub-ack-next', undefined, { ic: 'check', icSize: 18, on: null, hint: 'Acknowledge the next highlighted message' }),
        B('Thank', 'hub-thank-next', undefined, { ic: 'thanks', icSize: 18, on: null, hint: 'Thank the next supporter' }), B('Skip', 'hub-skip', undefined, { ic: 'skip', icSize: 18, on: null, hint: 'Skip the current read-aloud' })),
      el('div', { class: 'lc-scroll', style: 'display:flex;flex-direction:column;gap:6px' },
        pollBox ?? el('div', { class: 'lc-note' }, 'No poll yet. New poll… → your question + options; chat votes by typing an option.'),
        poll?.live ? null : pollComposer(),
        !poll?.live && templates.length ? el('div', { class: 'lc-row', style: 'flex-wrap:nowrap' }, sel, el('button', { class: 'lc-btn s', 'data-action': 'poll-start', 'data-tip': 'Start the saved poll', onClick: () => void run('poll-start', { template: sel.value }, `Poll ${sel.value}`) }, 'Start')) : null));
  }
  /** Me: the Hands / Body switches (studio only: src.tracking). Lit = tracked; one click flips it, right away. */
  function trackRow(): HTMLElement | null {
    const T = src.tracking;
    if (!T) return null;
    const parts = T.get();
    return el('div', { class: 'lc-row', role: 'group', 'aria-label': 'Track hands and body' }, el('span', { class: 'lc-lbl' }, 'Track'),
      ...TRACK_PARTS.map((p) => el('button', {
        class: `lc-btn s${parts[p] ? ' on' : ''}`, 'data-live': `track-${p}`, 'aria-pressed': String(parts[p]),
        'data-tip': `${TRACK_PART_TEXT[p].what}: ${parts[p] ? 'on' : 'off'}`, 'data-hint': `${TRACK_PART_TEXT[p].hint} Your face is always tracked.`,
        onClick: () => { if (!src.canRun) { src.toast('Read-only here (observer tab): Live Control buttons are off', 'warn'); return; } T.set(p, !T.get()[p]); },
      }, icon(p === 'hands' ? 'hand' : 'body', 13), TRACK_PART_TEXT[p].name)));
  }
  function pMe(st: LiveStatus) {
    const me = st.me;
    const of = (id: string, name: string, thumb?: string) => B(name, 'costume', { id }, {
      cls: 'lc-of', on: (me.outfit ?? '') === id, tip: id ? `Wear ${name}` : 'Default look',
      kids: [el('span', { class: 'th', style: `--h:${hue(name)}` }, liveThumb(thumb, document.createTextNode(initials(name)), name)), el('span', { class: 'nm' }, name)],
    });
    return el('section', { class: 'lc-panel', 'data-tile': 'me' },
      panelHead('me', 'me', 'Me', el('span', { class: 'lc-meta', 'data-tip': 'Size class', 'data-hint': 'Seats and camera shots follow it (Me → Size)' }, `${me.size} · ${me.height.toFixed(2)} m`),
        B('Recalibrate', 'recalibrate', undefined, { cls: 'lc-btn s', ic: 'target', icSize: 13, on: null, hint: me.avatar ? `${me.avatar}: hold a neutral face for 2.5 s` : 'Hold a neutral face for 2.5 s' })),
      el('div', { class: 'lc-scroll', style: 'display:flex;flex-direction:column;gap:10px' },
        fold('me-outfits', 'me', 'Outfits', `Wearing: ${me.outfits.find((c) => c.id === me.outfit)?.name ?? 'Default'}`,
          el('div', { class: 'lc-outfits', role: 'group', 'aria-label': 'Outfits' }, of('', 'Default'), ...me.outfits.map((c) => of(c.id, c.name, c.thumb)))),
        el('div', { class: 'lc-row', role: 'group', 'aria-label': 'When tracking is lost' }, el('span', { class: 'lc-lbl' }, 'Tracking lost'),
          B('Hold', 'trackloss', { mode: 'hold', part: 'all' }, { cls: 'lc-btn s', on: null, hint: 'Freeze and pick up where you left off' }),
          B('Rest', 'trackloss', { mode: 'rest', part: 'all' }, { cls: 'lc-btn s', on: null, hint: 'Ease back to the rest pose' }),
          B('Voice life', 'trackloss', { mode: 'life', part: 'all' }, { cls: 'lc-btn s', on: null, hint: 'Face follows your voice (body / hands rest)' })),
        trackRow(),
        me.accessories.length ? el('div', { class: 'lc-chipset', role: 'group', 'aria-label': 'Extras' }, ...me.accessories.map((c) => B(c.name, 'accessory', { id: c.id }, { cls: 'lc-btn s', on: c.on, ic: c.on ? 'check' : undefined, icSize: 12, tip: `${c.on ? 'Take off' : 'Put on'} ${c.name}` }))) : null,
        st.emotes.length ? fold('me-emotes', 'play', 'Emotes', `${st.emotes.length}`, el('div', { class: 'lc-emotes', role: 'group', 'aria-label': 'Emotes' },
          ...st.emotes.map((e) => B(e.label, 'emote', { name: e.id }, { lbl: false, tip: `Emote: ${e.label}`, on: null, ...(EMOTE_ICON[e.id] ? { kids: [EMOTE_ICON[e.id]] } : { cls: 'lc-btn txt', kids: [el('span', null, e.label)] }) })),
          B('Stop emote', 'emote', { name: 'stop' }, { lbl: false, on: null, kids: [icon('x', 16)] }))) : el('div', { class: 'lc-note' }, 'No emotes on this avatar.')));
  }
  // ---------------------------------------------------------------- live-tabs: Transitions · Privacy · Audio · OBS
  /** Persistent preview canvases / demos (built once: a repaint never restarts an animation that is playing). */
  const trPreview = el('canvas', { width: 384, height: 216, 'aria-label': 'Transition preview' }) as HTMLCanvasElement;
  const cvPreview = el('canvas', { width: 384, height: 216, 'aria-label': 'What viewers see' }) as HTMLCanvasElement;
  const camDemo = el('div', { class: 'lc-camdemo', 'aria-hidden': 'true' },
    el('span', { class: 'p', style: 'left:14%;--c:#7bd88f' }), el('span', { class: 'p', style: 'left:30%;--c:#6cc7f5' }), el('span', { class: 'p', style: 'left:62%;--c:#ff5fb4' }), el('span', { class: 'p', style: 'left:78%;--c:#ffcf6a' }),
    el('span', { class: 'f' }));
  let anim = 0;
  const stopAnim = () => { cancelAnimationFrame(anim); anim = 0; };
  /** Play a mini preview on a canvas for `secs` (never on OBS). */
  function playOn(cv: HTMLCanvasElement, draw: (ctx: CanvasRenderingContext2D, t: number | null) => void, secs: number) {
    stopAnim();
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (!alive || !cv.isConnected || t > secs) { anim = 0; draw(ctx, null); return; }
      draw(ctx, t); anim = requestAnimationFrame(loop);
    };
    loop();
  }
  const roomName = (live: DeckLiveState) => rooms.find((r) => r.id === live.sceneId)?.name ?? 'Your next room';
  const curtainDraw = (id: string, live: DeckLiveState) => (ctx: CanvasRenderingContext2D, t: number | null) => {
    const st = CURTAIN_STYLES.find((s) => s.id === (id === SHUFFLE ? CURTAIN_STYLES[0]?.id : id));
    if (!st) { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); return; }
    drawCurtainMini(ctx, ctx.canvas.width, ctx.canvas.height, st, t, roomName(live), null);
  };
  const coverDraw = (lk: LiveLook, style = lk.coverStyle) => (ctx: CanvasRenderingContext2D, t: number | null) => drawCoverMini(ctx, ctx.canvas.width, ctx.canvas.height, coverStyle(style), t, lk.coverText);
  // ---- live-layout: setting the look (hider + BRB card). Every failure is shown next to the picker, not swallowed.
  let lookErr: { what: string; text: string } | null = null;
  async function setLook(p: LookPatch, what: string) {
    if (!src.canRun) { src.toast('Read-only here (observer tab): Live Control buttons are off', 'warn'); return; }
    let r: { ok: boolean; error?: string };
    const route = lookRoute({ studio: !!src.look, online: deck.online(), live: deck.live() });
    if (route.via === 'studio') r = src.look!.set(p);
    else if (route.via === 'none') {   // the pop-out can't reach VTube Pro: not an error — one calm line
      lookErr = null; src.toast('Pick this in the studio window.', 'info'); paint(true); return;
    }
    else { r = { ok: true }; for (const x of lookToDeckRuns(p)) { const y = await deck.run(x.action, x.params); if (!y.ok) { r = y; break; } } }
    lookErr = r.ok ? null : { what, text: r.error ?? 'That didn’t save. Try again.' };
    if (!r.ok) src.toast(`${what}: ${lookErr!.text}`, 'err');
    paint(true);
  }
  /** Under a picker: a red line only when a change really didn't take. */
  const lookNote = (group: 'cover' | 'brb'): HTMLElement | null => {
    const se = src.look?.saveError?.();
    const why = lookErr && (group === 'cover' ? /hider|screen/i.test(lookErr.what) : /brb/i.test(lookErr.what)) ? lookErr.text
      : se ? `Couldn’t save (${se.msg}). Your pick works in this window; it may reset next time.` : null;
    if (why) return el('div', { class: 'lc-lookerr', role: 'alert', 'data-lookerr': group }, icon('help', 13), why);
    return null;
  };

  function tTransitions(live: DeckLiveState): HTMLElement[] {
    const cur = live.curtain ?? 'vtp-dark', dur = live.curtainDur ?? 0.6, hold = !!live.curtainHold, cm = live.camMove ?? 1.2;
    const own = CURTAIN_STYLES.filter((s) => s.theme !== 'vtp');
    const card = (id: string, name: string, hint: string, still: boolean) => {
      const cv = still ? el('canvas', { width: 192, height: 108 }) as HTMLCanvasElement : null;
      const b = B(name, 'transition', { style: id }, { cls: 'lc-trc', on: cur === id, tip: name, hint: `${hint} Click to use it.`,
        kids: [cv ?? el('span', { class: 'ph' }, icon(id === CUT ? 'x' : 'transition', 26)), el('span', { class: 'nm' }, name)] });
      if (cv) {
        const draw = curtainDraw(id, live);
        const ctx = cv.getContext('2d'); if (ctx) draw(ctx, null);
        // hover = play it here (only you see it)
        let raf = 0, t0 = 0;
        b.addEventListener('pointerenter', () => { if (raf) return; t0 = performance.now(); const loop = () => { if (!cv.isConnected) { raf = 0; return; } if (ctx) draw(ctx, (performance.now() - t0) / 1000); raf = requestAnimationFrame(loop); }; loop(); });
        b.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); raf = 0; if (ctx) draw(ctx, null); });
      }
      return b;
    };
    const ci = nearestPreset(CURTAIN_SPEEDS.map((x) => ({ v: x.dur })), dur), mi = nearestPreset(CAMERA_MOVES.map((x) => ({ v: x.secs })), cm);
    const curName = cur === CUT ? 'No transition' : cur === SHUFFLE ? 'Shuffle' : CURTAIN_STYLES.find((s) => s.id === cur)?.name ?? cur;
    // beta.12 (owner: "not needed all the time"): each section folds (remembered); folded it says what is in use
    const rooms1 = el('section', { class: 'lc-panel', 'data-group': 'room-transition' },
      live.curtainWaiting ? el('div', { class: 'lc-row' }, B('Show the room now', 'curtain', undefined, { cls: 'lc-btn s pri', ic: 'curtain', icSize: 14, on: null, tip: 'Reveal the new room', hint: 'The card goes away on every OBS page' })) : null,
      fold('tr-rooms', 'room', 'When you switch rooms', el('span', null, 'Now: ', el('b', null, curName), ` · ${dur.toFixed(2)} s${hold ? ' · waits for you' : ''}`),
      el('p', { class: 'lc-sub' }, 'A card covers the screen while the new room loads, so viewers never see it pop in.'),
      el('div', { class: 'lc-trgrid', role: 'group', 'aria-label': 'Transition style' },
        ...CURTAIN_STYLES.filter((s) => s.theme === 'vtp').map((s) => card(s.id, s.name, s.blurb, true)),
        ...own.map((s) => card(s.id, s.name, s.blurb, true)),
        own.length ? card(SHUFFLE, 'Shuffle', 'A different one of your own styles every time.', false) : null,
        card(CUT, 'No transition', 'The room swaps instantly. Viewers may see it load.', false)),
      el('div', { class: 'lc-trpv' }, trPreview,
        el('div', { class: 'side' },
          el('div', { class: 'lc-meta' }, 'Now: ', el('b', null, curName)),
          el('button', { class: 'lc-btn pri', 'data-live': 'preview-transition', disabled: cur === CUT ? true : null, 'data-tip': 'Preview', 'data-hint': 'Plays it here only. Viewers and OBS never see a preview.',
            onClick: () => playOn(trPreview, curtainDraw(cur === SHUFFLE ? own[0]?.id ?? 'vtp-dark' : cur, live), 4.6) }, icon('play', 15), 'Preview'),
          el('span', { class: 'lc-note' }, 'Only you see the preview.'))),
      el('div', { class: 'lc-row', role: 'group', 'aria-label': 'Speed' }, el('span', { class: 'lc-lbl' }, 'Speed'),
        el('div', { class: 'lc-seg s' }, ...CURTAIN_SPEEDS.map((x, i) => B(x.label, 'transition', { style: 'keep', dur: x.dur }, { cls: '', on: i === ci, tip: `${x.label}: ${x.dur} s`, hint: 'How fast the card covers the screen' }))),
        el('span', { class: 'lc-note' }, `${dur.toFixed(2)} s`)),
      el('div', { class: 'lc-row', role: 'group', 'aria-label': 'Wait for me' }, el('span', { class: 'lc-lbl' }, 'Wait for me'),
        el('div', { class: 'lc-seg s' },
          B('Off', 'transition', { style: 'keep', hold: 'false' }, { cls: '', on: !hold, tip: 'Show the new room as soon as it’s ready' }),
          B('On', 'transition', { style: 'keep', hold: 'true' }, { cls: '', on: hold, tip: 'Keep the card up until you press Show the room', hint: 'Good for a big reveal. Shift+Enter or the Stream Deck works too.' })))));
    const cams1 = el('section', { class: 'lc-panel', 'data-group': 'camera-transition' },
      fold('tr-camera', 'camera', 'When the camera changes shot', el('span', null, 'Now: ', el('b', null, cm <= 0.01 ? 'Cut' : `Glide · ${cm.toFixed(1)} s`)),
      el('p', { class: 'lc-sub' }, 'Cut jumps straight to the new shot. Glide moves the camera there.'),
      el('div', { class: 'lc-seg full', role: 'group', 'aria-label': 'Camera change' }, ...CAMERA_MOVES.map((x, i) => B(x.label, 'camera-move', { secs: x.secs }, { cls: '', on: i === mi, tip: x.label, hint: x.hint }))),
      el('div', { class: 'lc-trpv' }, camDemo,
        el('div', { class: 'side' },
          el('div', { class: 'lc-meta' }, 'Now: ', el('b', null, cm <= 0.01 ? 'Cut' : `Glide · ${cm.toFixed(1)} s`)),
          el('button', { class: 'lc-btn pri', 'data-live': 'preview-camera', 'data-tip': 'Preview', 'data-hint': 'A little drawing of the camera moving. Only you see it.',
            onClick: () => { camDemo.classList.toggle('cut', cm <= 0.01); camDemo.style.setProperty('--mv', `${Math.max(0.05, cm)}s`); camDemo.classList.toggle('b'); } }, icon('play', 15), 'Preview'),
          el('span', { class: 'lc-note' }, 'Walk-ins and the auto director use their own moves.')))));
    const obs1 = el('section', { class: 'lc-panel', 'data-group': 'obs-transition' },
      fold('tr-obs', 'stream', 'When OBS switches scenes', el('span', null, 'OBS’s own transition'), obsTransitionBox()));
    return [rooms1, cams1, obs1];
  }

  /** One big on / off card: what it hides, what viewers see, and its state in words. */
  const pvCard = (o: { id: string; title: string; on: boolean; ic: string; d: string; action: string; params?: Record<string, string | number>; danger?: boolean; onWord?: string; offWord?: string }) =>
    B(o.title, o.action, o.params, { cls: `lc-pv${o.on ? ' on' : ''}`, tut: `live-pv-${o.id}`, on: o.on, danger: o.danger, tip: o.title, hint: o.d,
      kids: [el('span', { class: 'ic' }, icon(o.ic, 22)), el('b', null, o.title), el('span', { class: 'd' }, o.d),
        el('span', { class: 'sw', 'data-pv': o.id }, el('i'), o.on ? (o.onWord ?? 'Hidden') : (o.offWord ?? 'Viewers see it'))] });
  /** beta.12: Privacy's Hide my screen as one big, unmistakable switch (what viewers see, the shortcut, one click). */
  function bigHide(live: DeckLiveState): HTMLElement {
    const on = !!live.cover;
    return B(on ? 'Show my screen again' : 'Hide my screen', 'cover', { on: on ? 'false' : 'true' }, {
      cls: `lc-bighide${on ? ' on' : ''}`, on, tip: on ? 'Your screen is hidden' : 'Hide my screen', hint: 'Covers your game or shared window with the animated card below. Your avatar stays on screen.',
      kids: [el('span', { class: 'ic' }, icon(on ? 'eye' : 'eyeoff', 26)),
        el('span', { class: 'tx', 'data-pv': 'screen' }, el('b', null, on ? 'Your screen is hidden' : 'Hide my screen'),
          el('span', null, on ? 'Viewers see the hiding card. Click to show your screen again.' : 'Viewers see your game or window now. Click to cover it.')),
        el('span', { class: 'kb' }, el('kbd', null, comboLabel(hideKey())))],
    });
  }
  function tPrivacy(live: DeckLiveState, st: LiveStatus): HTMLElement[] {
    const others = st.party.members.filter((m) => !m.me), host = st.party.role === 'host';
    const brb = live.lighting === 'brb', allCut = others.length > 0 && others.every((m) => m.mod?.cam && m.mod?.mic);
    const lk = lookNow(live), style = coverStyle(lk.coverStyle);
    const ctx = cvPreview.getContext('2d'); if (ctx && !anim) coverDraw(lk)(ctx, null);
    const txt = el('input', { type: 'text', maxlength: '60', placeholder: style.line || 'Setting things up…', 'aria-label': 'What the card says', value: coverDraft ?? lk.coverText }) as HTMLInputElement;
    txt.addEventListener('input', () => { coverDraft = txt.value; });
    const saveText = () => { const t = txt.value.trim(); coverDraft = null; void setLook({ coverText: t }, 'Hider words'); };
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveText(); } });
    // the screen-hider animations that ship with VTube Pro (src/scene/capcover/stylesVtp.ts): click a card = use it
    // (it stays picked: the button, your key, Ctrl+K and the Stream Deck all play THIS one); Preview = here only
    const own = COVER_STYLES.filter((s) => s.theme !== 'vtp');
    const pick = (kind: 'cover' | 'brb', id: string, name: string, blurb: string, on: boolean, canvas: HTMLCanvasElement, use: () => void, preview: () => void) =>
      el('div', { class: `lc-pick${on ? ' on' : ''}`, 'data-pick': kind, 'data-style': id },
        el('button', { class: `lc-trc lc-cvc${on ? ' on' : ''}`, 'data-look': kind, 'data-style': id, 'aria-pressed': String(on), 'data-tip': on ? `Using ${name}` : `Use ${name}`, 'data-hint': `${blurb}.`, onClick: use },
          canvas, el('span', { class: 'nm' }, name), on ? el('span', { class: 'using' }, icon('check', 11), 'Using') : null),
        el('button', { class: 'lc-pv1', 'data-live': `preview-${kind}`, 'data-style': id, 'aria-label': `Preview ${name}`, 'data-tip': `Preview ${name}`, 'data-hint': 'Plays it here only. Viewers never see a preview.', onClick: preview }, icon('play', 11), 'Preview'));
    const coverCard = (s: (typeof COVER_STYLES)[number]) => pick('cover', s.id, s.name, s.blurb, style.id === s.id,
      el('canvas', { width: 256, height: 144, 'data-cover-style': s.id, 'aria-hidden': 'true' }) as HTMLCanvasElement,
      () => void setLook({ coverStyle: s.id }, 'Hider animation'), () => playOn(cvPreview, coverDraw(lk, s.id), 9));
    const ownSel = own.length ? (() => {
      const sel = el('select', { class: 'lc-select', 'aria-label': 'Your own card styles', 'data-tip': 'Your own styles' },
        el('option', { value: '' }, own.some((s) => s.id === style.id) ? 'Your own styles' : 'Your own styles…'), ...own.map((s) => el('option', { value: s.id }, s.name)));
      sel.value = own.some((s) => s.id === style.id) ? style.id : '';
      sel.addEventListener('change', () => { if (sel.value) void setLook({ coverStyle: sel.value }, 'Hider animation'); });
      return sel;
    })() : null;
    // beta.12 (owner: "the hide action itself must be a much more obvious button"): one big switch that says what viewers
    // see; the animation picker folds away (remembered) and says which card is in use
    const screen = el('section', { class: 'lc-panel', 'data-group': 'hide-screen', 'data-tut': 'live-hide' },
      bigHide(live),
      lookNote('cover'),
      fold('cover-styles', 'eyeoff', 'Hiding animation', el('span', { 'data-using': 'cover' }, 'Using: ', el('b', null, style.name)),
        el('div', { class: 'lc-trgrid lc-cvgrid', role: 'group', 'aria-label': 'Screen hider animation' }, ...COVER_STYLES.filter((s) => s.theme === 'vtp').map(coverCard)),
        el('div', { class: 'lc-cvrow' }, cvPreview,
          el('div', { class: 'side' },
            el('span', { class: 'lc-lbl' }, 'What viewers see'),
            el('div', { class: 'lc-field' }, txt, el('button', { class: 'lc-btn s', onClick: saveText }, 'Save')),
            el('div', { class: 'lc-field' }, ownSel,
              el('button', { class: 'lc-btn s', 'data-live': 'preview-cover', 'data-tip': 'Preview', 'data-hint': 'Plays the card you use, from the start, here only', onClick: () => playOn(cvPreview, coverDraw(lk), 9) }, icon('play', 13), 'Preview')))),
        hotkeyRow()));
    requestAnimationFrame(startCoverCards);
    const cards = el('div', { class: 'lc-pvlist' },
      pvCard({ id: 'chat', title: 'Hide chat', on: !!live.chatHidden, ic: 'chatoff', action: 'chat-hide', params: { on: live.chatHidden ? 'false' : 'true' },
        d: 'The chat screen, the chat buddy and the chat box disappear. Donation alerts still show.' }),
      host && others.length ? pvCard({ id: 'guests', title: 'Hide all guests', on: allCut, ic: 'users', action: 'guests-cut-all', params: { on: allCut ? 'false' : 'true' }, onWord: 'Hidden', offWord: 'Viewers see them',
        d: 'Every guest’s camera and mic go off at once. Undo is in Guests.' }) : null);
    const mic = el('section', { class: 'lc-panel', 'data-group': 'my-mic' },
      panelHead(null, 'micoff', 'My microphone'),
      el('div', { class: 'lc-row' }, el('span', { class: 'lc-note' }, 'Your stream mic is in OBS. To mute it, click the speaker next to it in OBS.'), el('span', { class: 'lc-soon', title: 'Coming soon' }, 'Mute from here: coming soon')),
      st.voice && (others.some((m) => m.voice || m.vox === 'app' || m.vox === 'wait')) ? el('div', { class: 'lc-row' },
        B(st.voice.talkback ? 'Guests hear me' : 'Guests can’t hear me', 'guest-voice', { what: 'talkback', on: st.voice.talkback ? 'false' : 'true' }, { cls: 'lc-btn s', ic: st.voice.talkback ? 'mic' : 'micoff', icSize: 13, on: st.voice.talkback, tip: st.voice.talkback ? 'Stop sending your mic to link guests' : 'Send your mic to link guests' })) : null);
    // ---- BRB (shared/brb.ts): fade to black, guests muted, the Be Right Back card — its look picked here (same path)
    const look = brbLook(live);
    const btxt = el('input', { type: 'text', maxlength: '40', placeholder: BRB_DEFAULT_TEXT, 'aria-label': 'What the BRB card says', value: brbDraft ?? look.text }) as HTMLInputElement;
    btxt.addEventListener('input', () => { brbDraft = btxt.value; });
    const saveBrb = () => { const t = btxt.value.trim(); brbDraft = null; void setLook({ brbText: t }, 'BRB words'); };
    btxt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBrb(); } });
    const brbPreview = (sty: string) => (c: CanvasRenderingContext2D, t: number | null) => { const x = { ...look, style: sty }; drawBrbCard(c, c.canvas.width, c.canvas.height, x, t ?? 2, brbMediaOf(brbMediaEl(x))); };
    const brbSec = el('section', { class: 'lc-panel', 'data-group': 'brb', 'data-tut': 'live-brb' },
      pvCard({ id: 'brb', title: 'Be right back', on: brb, ic: 'brb', action: 'lighting', params: { state: brb ? 'show' : 'brb' }, onWord: 'On', offWord: 'Off',
        d: brb ? 'Viewers see your BRB card and hear no guests. Click to fade back in to the show.' : 'Fades to black, mutes your guests and shows a Be Right Back card. Click again to fade back in.' }),
      lookNote('brb'),
      fold('brb-styles', 'brb', 'The BRB card', el('span', { 'data-using': 'brb' }, 'Using: ', el('b', null, brbUsing(lk))),
      el('div', { class: 'lc-trgrid lc-cvgrid', role: 'group', 'aria-label': 'BRB card animation', 'data-tut': 'live-brb-style' }, ...BRB_STYLES.map((x) => pick('brb', x.id, x.name, x.blurb, look.style === x.id,
        el('canvas', { width: 256, height: 144, 'data-brb-style': x.id, 'aria-hidden': 'true' }) as HTMLCanvasElement,
        () => void setLook({ brbStyle: x.id }, 'BRB animation'), () => playOn(cvPreview, brbPreview(x.id), 6)))),
      el('div', { class: 'lc-row' },
        el('span', { class: 'lc-lbl' }, 'Theme'),
        el('div', { class: 'lc-seg s', role: 'group', 'aria-label': 'BRB card theme' },
          el('button', { class: look.theme === 'dark' ? 'on' : '', 'data-look': 'brb-theme', 'data-theme': 'dark', 'aria-pressed': String(look.theme === 'dark'), 'data-tip': 'Dark VTube Pro card', onClick: () => void setLook({ brbTheme: 'dark' }, 'BRB theme') }, 'Dark'),
          el('button', { class: look.theme === 'light' ? 'on' : '', 'data-look': 'brb-theme', 'data-theme': 'light', 'aria-pressed': String(look.theme === 'light'), 'data-tip': 'Light VTube Pro card', onClick: () => void setLook({ brbTheme: 'light' }, 'BRB theme') }, 'Light')),
        el('div', { class: 'lc-field', style: 'flex:1 1 200px' }, btxt, el('button', { class: 'lc-btn s', onClick: saveBrb }, 'Save'))),
      ownBrbRow(look),
      el('div', { class: 'lc-note' }, 'Also: the BRB lighting button, Shift+4, Ctrl+K “brb”, a Stream Deck key and your OBS BRB scene. They all use this card.')));
    return [screen, brbSec, cards, mic];
  }
  let coverDraft: string | null = null, brbDraft: string | null = null;
  // ---- your own BRB screen: one picture / short looping video behind the words (docs/BRB_SCREENS.md)
  let brbUp: string | null = null;
  async function uploadBrb(f: File) {
    if (!src.canRun) { src.toast('Read-only here (observer tab): Live Control buttons are off', 'warn'); return; }
    if (f.size > BRB_BG_MAX) { src.toast(`That file is too big. Use one under ${Math.round(BRB_BG_MAX / 1048576)} MB.`, 'warn'); return; }
    const kind = sniffBrbMedia(new Uint8Array(await f.slice(0, 64).arrayBuffer()));
    if (!kind) { src.toast('Use a PNG, JPG, WebP or GIF picture, or an MP4 / WebM video.', 'warn'); return; }
    brbUp = `Adding ${f.name}…`; paint(true);
    try {
      const r = await fetch('/api/brb/background', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({})) as { kind?: string; rev?: number; error?: string };
      if (!r.ok || !j.rev) { brbUp = null; src.toast(`Your BRB screen didn't save: ${j.error ?? 'try again'}`, 'err'); paint(true); return; }
      brbUp = null;
      await setLook({ brbBg: `${j.kind}:${j.rev}` }, 'Your BRB screen');
      src.toast(kind.kind === 'video' ? 'Your video is the BRB screen now (it plays without sound).' : 'Your picture is the BRB screen now.', 'ok');
    } catch { brbUp = null; src.toast('VTube Pro didn’t answer. Is VTube Pro running?', 'err'); }
    paint(true);
  }
  function ownBrbRow(look: SceneBrbState): HTMLElement {
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm', style: 'display:none', 'data-brb-file': '1' }) as HTMLInputElement;
    file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void uploadBrb(f); });
    return el('div', { class: 'lc-row', 'data-group': 'brb-own' },
      el('span', { class: 'lc-lbl' }, 'Your own screen'), file,
      el('button', { class: 'lc-btn s', 'data-live': 'brb-upload', 'data-tip': 'Use your own picture or video', 'data-hint': 'A PNG / JPG / GIF / WebP picture or a short MP4 / WebM loop, up to 40 MB. It stays on your computer. Videos play without sound.', onClick: () => file.click() }, icon('create', 13), look.bg ? 'Change…' : 'Choose a picture or video…'),
      look.bg ? el('button', { class: 'lc-btn s', 'data-look': 'brb-bg-off', 'data-tip': 'Back to the theme’s own background', onClick: () => void setLook({ brbBg: 'none' }, 'Your BRB screen') }, 'Remove') : null,
      el('span', { class: 'lc-note' }, brbUp ?? (look.bg ? `Using your ${look.bg.kind === 'video' ? 'video (no sound)' : 'picture'} behind the words.` : 'Optional: your words go on top.')));
  }
  const brbStillKeys = new Map<string, object>();
  // the three hider cards play their animation while the Privacy tab is open (30 fps; a still with reduced motion).
  // While the camera tracks or OBS is on air the cards are stills and only the card under the pointer plays: all of them
  // at 30 fps cost the studio's main thread (the tracker's) ~70 ms a second (tools/perf_tabs.mjs, measured).
  let cardsRaf = 0;
  function startCoverCards() {
    if (cardsRaf) return;
    const still = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
    const t0 = performance.now(); let last = 0;
    const frame = (now: number) => {
      const cvs = [...wrap.querySelectorAll<HTMLCanvasElement>('canvas[data-cover-style], canvas[data-brb-style]')];
      if (!alive || !cvs.length) { cardsRaf = 0; return; }
      if (now - last >= 33) {
        last = now;
        const live = deck.live();
        const st = src.status(), calm = st.tracking || st.obs > 0;
        for (const cv of cvs) {
          // (calm: a still once per canvas — a repaint makes new ones — and the hovered card's animation)
          const moving = !calm || !!cv.parentElement?.matches(':hover');
          if (!moving && cv.dataset.still === '1') continue;
          cv.dataset.still = moving ? '' : '1';
          const ctx = cv.getContext('2d'); if (!ctx) continue;
          const stillNow = still || !moving, tt = stillNow ? 2 : (now - t0) / 1000;
          if (cv.dataset.brbStyle) {
            const lk = { ...brbLook(live), style: cv.dataset.brbStyle }, media = brbMediaOf(brbMediaEl(lk));
            // (a still without your own picture / video: drawn once, in idle time, then copied — src/scene/stillCache.ts)
            if (stillNow && !media) { let so = brbStillKeys.get(lk.style); if (!so) brbStillKeys.set(lk.style, (so = {})); drawStill(ctx, cv.width, cv.height, so, JSON.stringify(lk), (g) => drawBrbCard(g, cv.width, cv.height, lk, 2, null)); }
            else { cancelStill(cv); drawBrbCard(ctx, cv.width, cv.height, lk, tt, media); }
          }
          else drawCoverMini(ctx, cv.width, cv.height, coverStyle(cv.dataset.coverStyle ?? ''), stillNow ? null : tt, lookNow(live).coverText);
        }
      }
      if (still) { cardsRaf = 0; return; }
      cardsRaf = requestAnimationFrame(frame);
    };
    cardsRaf = requestAnimationFrame(frame);
  }

  // ---- the Hide my screen hotkey: show / change (press to record) / reset; saved per browser (shared/hotkey.ts)
  const lsStore = () => { try { return localStorage; } catch { return null; } };
  const hideKey = () => loadHideScreenKey(lsStore());
  let hkRec = false, hkNote: { text: string; warn: boolean; pending?: string } | null = null;
  let hkStop: (() => void) | null = null;
  function stopRecording() { if (!hkRec) return; hkRec = false; setHotkeyRecording(false); hkStop?.(); hkStop = null; }
  function startRecording() {
    if (hkRec) return;
    hkRec = true; hkNote = null; setHotkeyRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { stopRecording(); hkNote = { text: 'Nothing changed.', warn: false }; paint(true); return; }
      const c = comboOf(e);
      if (!c) return;   // (a modifier on its own: keep waiting for the key)
      stopRecording();
      const clash = comboConflict(c);
      if (clash) hkNote = { text: `${comboLabel(c)}: ${clash}`, warn: true, pending: sanitizeCombo(c) ?? undefined };
      else { saveHideScreenKey(lsStore(), c); hkNote = { text: `Saved. ${comboLabel(c)} now hides and shows your screen.`, warn: false }; }
      paint(true);
    };
    addEventListener('keydown', onKey, true);
    hkStop = () => removeEventListener('keydown', onKey, true);
    paint(true);
  }
  function hotkeyRow(): HTMLElement {
    const k = hideKey(), isDefault = k === HIDE_SCREEN_DEFAULT;
    return el('div', { class: 'lc-hk', role: 'group', 'aria-label': 'Hide my screen shortcut', 'data-hotkey': k },
      el('div', { class: 'lc-row' },
        el('span', { class: 'lc-lbl' }, 'Shortcut'),
        hkRec ? el('kbd', { class: 'rec', 'aria-live': 'polite' }, 'Press the keys you want…') : el('kbd', null, comboLabel(k)),
        hkRec ? el('button', { class: 'lc-btn s', 'data-live': 'hotkey-cancel', onClick: () => { stopRecording(); paint(true); } }, 'Cancel')
          : el('button', { class: 'lc-btn s', 'data-live': 'hotkey-change', 'data-tip': 'Change the shortcut', 'data-hint': 'Click, then press the new keys. Esc keeps the old one.', onClick: startRecording }, icon('edit', 13), 'Change'),
        !hkRec && !isDefault ? el('button', { class: 'lc-btn s', 'data-live': 'hotkey-reset', 'data-tip': `Back to ${comboLabel(HIDE_SCREEN_DEFAULT)}`, onClick: () => { saveHideScreenKey(lsStore(), null); hkNote = { text: `Back to ${comboLabel(HIDE_SCREEN_DEFAULT)}.`, warn: false }; paint(true); } }, 'Reset') : null),
      el('div', { class: 'lc-note' }, 'Works everywhere in VTube Pro, in any tab and in the Live pop-out. Not while you type in a text box.'),
      hkNote ? el('div', { class: `lc-hknote${hkNote.warn ? ' warn' : ''}`, role: 'status' }, hkNote.text,
        hkNote.pending ? el('button', { class: 'lc-btn s', 'data-live': 'hotkey-anyway', onClick: () => { const p = hkNote?.pending; if (p) { saveHideScreenKey(lsStore(), p); hkNote = { text: `Saved. ${comboLabel(p)} now hides and shows your screen.`, warn: false }; paint(true); } } }, 'Use it anyway') : null,
        hkNote.pending ? el('button', { class: 'lc-btn s', onClick: startRecording }, 'Try another') : null) : null);
  }

  function tAudio(live: DeckLiveState, st: LiveStatus): HTMLElement[] {
    const me = el('section', { class: 'lc-panel', 'data-group': 'my-mic-level' },
      panelHead(null, 'mic', 'Your mic'),
      el('div', { class: 'lc-row' },
        el('span', { class: 'lc-pip' + (st.mic ? ' ok' : ''), 'data-tip': 'Your mic', 'data-hint': 'The mic VTube Pro listens to for lip sync. The bar moves when you talk.' }, el('i'), el('b', null, st.mic ? 'Listening' : 'Off'),
          el('span', { class: 'mtr', style: 'display:inline-block;width:120px;height:8px;border-radius:4px;background:var(--lc-bg1);overflow:hidden' }, el('u', { 'data-micmeter': '1', style: 'display:block;height:100%;width:0;background:var(--lc-ok);transition:width 90ms linear' })))),
      el('div', { class: 'lc-row' }, el('span', { class: 'lc-note' }, 'Your stream hears the mic you added in OBS.'), el('span', { class: 'lc-soon', title: 'Coming soon' }, 'Mute from here: coming soon')));
    const vb = voiceBlock(st);
    const guests = el('section', { class: 'lc-panel', 'data-group': 'guest-voice' },
      panelHead(null, 'users', 'Your guests’ voices'),
      vb ?? el('div', { class: 'lc-note' }, 'Nobody is talking over a link right now. When a guest joins with their voice, you choose here if you hear them and if they hear you.'));
    const sounds = el('section', { class: 'lc-panel', 'data-group': 'show-sounds' },
      panelHead(null, 'speak', 'Show sounds'),
      el('div', { class: 'lc-row' },
        B('Background video sound', 'video-audio', undefined, { cls: 'lc-btn', ic: 'speak', icSize: 15, tip: 'Background video sound on / off', hint: 'The sound of the video on your room screen: plays here in the studio, never on the OBS page' }),
        B('Read chat aloud', 'hub-tts', undefined, { cls: 'lc-btn', ic: 'chat', icSize: 15, on: live.tts, tip: 'Read donation messages aloud', hint: 'A voice reads supporters’ messages, played in the studio (your stream hears it from there)' })));
    return [me, guests, sounds];
  }

  // OBS tab: what the helper knows about OBS (GET /api/obs/status, /api/obs/scenes; obs-web lane). Polled while the tab is open.
  type ObsInfo = { enabled?: boolean; connected?: boolean; obsVersion?: string; error?: string; fix?: string; outputs?: { count?: number; inObs?: number } };
  let obsInfo: ObsInfo | null = null, obsScenes: { ok: boolean; scenes: string[]; current: string | null } | null = null, obsAt = 0;
  async function refreshObs(force = false) {
    if (!force && Date.now() - obsAt < 4000) return;
    obsAt = Date.now();
    try {
      const r = await fetch('/api/obs/status', { cache: 'no-store' });
      obsInfo = r.ok ? await r.json() as ObsInfo : null;
      if (obsInfo?.connected) {
        const s = await fetch('/api/obs/scenes', { cache: 'no-store' });
        const j = s.ok ? await s.json() as { ok?: boolean; scenes?: unknown[]; current?: string | null } : null;
        obsScenes = j?.ok ? { ok: true, scenes: (j.scenes ?? []).map((x) => (typeof x === 'string' ? x : (x as { sceneName?: string; name?: string })?.sceneName ?? (x as { name?: string })?.name ?? '')).filter(Boolean).slice(0, 24), current: j.current ?? null } : null;
      } else obsScenes = null;
    } catch { obsInfo = null; obsScenes = null; }
    if (wrap.querySelector('[data-pane="obs"]')) paint();
  }
  async function obsSwitch(name: string) {
    if (!src.canRun) { src.toast('Read-only here (observer tab): Live Control buttons are off', 'warn'); return; }
    try {
      const r = await fetch('/api/obs/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneName: name }) });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) src.toast(`OBS: ${j.error ?? 'that didn’t work'}`, 'err'); else { src.toast(`OBS scene: ${name}`, 'ok'); void refreshObs(true); }
    } catch { src.toast('OBS: VTube Pro didn’t answer. Try again.', 'err'); }
  }
  function tObs(st: LiveStatus): HTMLElement[] {
    void refreshObs();
    // (st.obs = output pages inside OBS; `tabs` = the page open in a normal browser tab, which is not OBS)
    const pages = st.obs, linked = !!obsInfo?.connected;
    const tabs = Math.max(0, (obsInfo?.outputs?.count ?? 0) - (obsInfo?.outputs?.inObs ?? 0));
    const row = (ok: boolean | null, title: string, text: string, ...act: Kid[]) => el('div', { class: 'lc-pv' + (ok === false ? ' warn' : ''), style: 'cursor:default' },
      el('span', { class: 'ic', style: ok ? 'color:var(--lc-ok)' : ok === false ? 'color:var(--lc-warn)' : '' }, icon(ok ? 'check' : ok === false ? 'help' : 'stream', 22)), el('b', null, title), el('span', { class: 'd' }, text),
      act.length ? el('span', { class: 'lc-row', style: 'grid-column:3;grid-row:1 / span 2' }, ...act) : null);
    const copySrc = el('button', { class: 'lc-btn s', 'data-live': 'copy-obs-link', 'data-tip': 'Copy the OBS link', 'data-hint': 'In OBS: + under Sources → Browser → paste this as the URL, 1920 × 1080', onClick: () => {
      const u = `${location.origin}/output.html`;
      void navigator.clipboard?.writeText(u).then(() => src.toast('Copied. In OBS: add a Browser source and paste it.', 'ok'), () => src.toast(u, 'info'));
    } }, icon('copy', 13), 'Copy OBS link');
    const status = el('section', { class: 'lc-panel', 'data-group': 'obs-status' },
      panelHead(null, 'stream', 'Is OBS showing VTube Pro?'),
      row(pages > 0, pages > 0 ? 'Yes: OBS is showing VTube Pro' : tabs > 0 ? 'Open in a browser tab, not in OBS' : 'Not yet',
        pages > 0 ? 'You go live when you press Start Streaming in OBS.' : tabs > 0 ? 'Paste the OBS link into an OBS Browser source.' : 'Add VTube Pro to OBS as a Browser source. Copy the link, then paste it in OBS.', pages > 0 ? null : copySrc),
      row(obsInfo ? linked : null, linked ? `VTube Pro can control OBS${obsInfo?.obsVersion ? ` (OBS ${obsInfo.obsVersion})` : ''}` : obsInfo?.enabled ? 'VTube Pro can’t reach OBS' : 'OBS automation is off',
        linked ? 'Scene switching and fitting your window capture work.' : obsInfo?.enabled ? (obsInfo.fix || obsInfo.error || 'Is OBS open? Then run the set-up again.') : 'Turn it on to switch OBS scenes from here.'));
    const setup = el('section', { class: 'lc-panel', 'data-group': 'obs-setup' },
      el('div', { class: 'lc-go' }, el('div', { class: 'now' }, el('small', null, 'Easiest way'), el('b', null, 'Let VTube Pro set up OBS for you')),
        el('button', { class: 'lc-btn big pri', 'data-live': 'obs-wizard', 'data-tut': 'live-obs-setup', 'data-tip': 'Set up OBS automation', 'data-hint': 'A short guide: connect OBS, add VTube Pro, switch scenes by itself.', onClick: () => openObsWizard(src) }, icon('wand', 20), 'Set up OBS automation')));
    const scenes = linked && obsScenes?.scenes.length ? el('section', { class: 'lc-panel', 'data-group': 'obs-scenes' },
      panelHead(null, 'show', 'Switch OBS scene'),
      el('div', { class: 'lc-chipset', role: 'group', 'aria-label': 'OBS scenes' }, ...obsScenes.scenes.map((n) => el('button', { class: `lc-btn${n === obsScenes!.current ? ' on' : ''}`, 'aria-pressed': String(n === obsScenes!.current), 'data-obs-scene': n, 'data-tip': `OBS: ${n}`, 'data-hint': 'Switches the scene in OBS right now', onClick: () => void obsSwitch(n) }, n)))) : null;
    return [setup, status, ...(scenes ? [scenes] : [])];
  }

  // Go Live tab (VTube Pro Live, src/ui/broadcast/): ONE tab object that lives as long as this console, built the first time the
  // pane is shown and moved into each repaint. It asks the helper nothing unless its pane is on screen (setActive in paint).
  let goLive: GoLiveTab | null = null;
  function tGoLive(): HTMLElement[] {
    goLive ??= createGoLiveTab({ canRun: () => src.canRun, toast: (m, k) => src.toast(m, k) });
    return [goLive.el];
  }

  // ---------------------------------------------------------------- live-layout: the tabbed tiles + the slim status line
  /** A small count / dot on a pane's tab (people waiting, something hidden, a room waiting, a poll running, OBS). */
  function paneBadge(live: DeckLiveState, st: LiveStatus, p: Pane): Kid {
    const others = st.party.members.filter((m) => !m.me).length, knocks = st.party.knocks.length + st.party.members.filter((m) => m.gr?.wait).length;
    const hiddenN = (live.cover ? 1 : 0) + (live.chatHidden ? 1 : 0) + (live.lighting === 'brb' ? 1 : 0);
    if (p === 'guests' && knocks) return el('span', { class: 'bdg hot', title: 'Waiting to come in' }, String(knocks));
    if (p === 'guests' && others) return el('span', { class: 'bdg' }, String(others));
    if (p === 'privacy' && hiddenN) return el('span', { class: 'bdg hot', title: 'Something is hidden from viewers' }, String(hiddenN));
    if (p === 'transitions' && live.curtainWaiting) return el('span', { class: 'bdg hot dot', title: 'A room is waiting for you to show it' });
    if (p === 'chat' && poll?.live) return el('span', { class: 'bdg hot dot', title: 'A poll is running' });
    if (p === 'obs' && st.obs === 0) return el('span', { class: 'bdg dot', style: 'background:var(--lc-warn)', title: 'OBS isn’t showing VTube Pro yet' });
    return null;
  }
  /** What a pane shows: one panel (Rooms, Guests, Chat & polls, Me) or a few sections in one scrolling panel. */
  function paneBody(live: DeckLiveState, st: LiveStatus, p: Pane): HTMLElement {
    const kids: (HTMLElement | null)[] = p === 'rooms' ? [rRooms(live)] : p === 'guests' ? [pGuests(live, st)] : p === 'chat' ? [pChat(live)] : p === 'me' ? [pMe(st)]
      : p === 'privacy' ? tPrivacy(live, st)
      : p === 'transitions' ? [...tTransitions(live), el('section', { class: 'lc-panel', 'data-group': 'ambient' },
        panelHead(null, 'auto', 'Moving cameras on breaks'),
        el('div', { class: 'lc-row' }, el('span', { class: 'lc-note', style: 'flex:1' }, 'Slow camera moves during the Preshow, BRB and Outro lighting.'),
          B(live.ambcam ? 'On' : 'Off', 'ambcam', { action: 'toggle' }, { cls: 'lc-btn s', on: !!live.ambcam, tip: 'Moving cameras on / off' })))]
      : p === 'audio' ? tAudio(live, st) : p === 'golive' ? tGoLive() : tObs(st);
    const list = kids.filter((k): k is HTMLElement => !!k);
    if (list.length === 1 && list[0].classList.contains('lc-panel')) { list[0].classList.add('lc-pane'); list[0].dataset.pane = p; return list[0]; }
    return el('section', { class: 'lc-panel lc-pane lc-multi', 'data-pane': p, 'data-tile': p }, el('div', { class: 'lc-scroll lc-panebody' }, ...list));
  }
  /** One tile: the original segmented tabs on top, the pane under it (keyboard: arrows / Home / End). */
  function paneTile(live: DeckLiveState, st: LiveStatus, group: Pane[], cur: Pane, slot: 'a' | 'b'): HTMLElement {
    const seg = el('div', { class: 'lc-seg lc-paneseg', role: 'tablist', 'aria-label': 'Live panels' }, ...group.map((id) => {
      const d = PANES.find((x) => x.id === id)!;
      return el('button', { class: id === cur ? 'on' : '', role: 'tab', id: `lc-tab-${id}`, 'aria-selected': String(id === cur), 'aria-controls': `lc-pane-${slot}`, tabindex: id === cur ? '0' : '-1', 'data-tab': id,
        'data-tip': d.label, 'data-hint': d.hint, onClick: () => setTab(id) }, icon(d.icon, 14), el('span', { class: 'tl' }, d.label), paneBadge(live, st, id));
    }));
    seg.addEventListener('keydown', (e) => {
      const i = group.indexOf(cur), n = group.length;
      const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (j < 0) return;
      e.preventDefault(); setTab(group[j]); (wrap.querySelector(`#lc-tab-${group[j]}`) as HTMLElement | null)?.focus();
    });
    const body = paneBody(live, st, cur);
    body.id = `lc-pane-${slot}`; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `lc-tab-${cur}`);
    return el('div', { class: 'lc-tabs', 'data-slot': slot }, el('div', { class: 'lc-panehead' }, seg, el('span', { class: 'lc-panehint', 'data-panehint': cur }, PANES.find((x) => x.id === cur)!.hint)), body);
  }
  /** "Now: Talking · Lights: Show" + what viewers can't see right now — one slim line in the header. */
  function statusLine(live: DeckLiveState, st: LiveStatus) {
    const d = DOING.find((x) => x.id === live.mode), l = LIGHTS.find((x) => x.id === live.lighting);
    const chip = (ic: string, text: string, to: Pane, warn = false) => el('button', { class: `chip${warn ? ' warn' : ''}`, 'data-goto': to, 'data-tip': text, 'data-hint': `Open ${PANES.find((x) => x.id === to)!.label}`, onClick: () => setTab(to) }, icon(ic, 13), text);
    const others = st.party.members.filter((m) => !m.me);
    const cut = others.filter((m) => m.mod?.cam && m.mod?.mic).length, knocks = st.party.knocks.length;
    const chips: HTMLElement[] = [
      ...(live.cover ? [chip('eyeoff', 'Screen hidden', 'privacy')] : []),
      ...(live.chatHidden ? [chip('chatoff', 'Chat hidden', 'privacy')] : []),
      ...(live.lighting === 'brb' ? [chip('brb', 'BRB card up', 'privacy')] : []),
      ...(cut ? [chip('users', `${cut} guest${cut === 1 ? '' : 's'} hidden`, 'guests')] : []),
      ...(live.curtainWaiting ? [chip('curtain', 'Room waiting', 'transitions', true)] : []),
      ...(knocks ? [chip('door', `${knocks} waiting`, 'guests', true)] : []),
    ];
    return el('div', { class: 'lc-statusline', role: 'status', 'aria-live': 'polite' },
      el('button', { class: 'lc-status', 'data-status': `${live.mode}|${live.lighting}`, 'data-goto': 'show', 'data-tip': 'What you’re doing and your lights', 'data-hint': 'Change them in Show', onClick: () => setTab('show') },
        el('span', { class: 'k' }, 'Now'), el('span', { class: 'v' }, icon(d?.ic ?? 'show', 13), d?.doing ?? live.mode),
        el('span', { class: 'dot' }),
        el('span', { class: 'k' }, 'Lights'), el('span', { class: 'v' }, el('i', { class: 'sw', style: `background:${l?.sw ?? 'var(--lc-bg4)'}` }), l?.label ?? live.lighting)),
      ...chips);
  }

  // health strip: LEDs + values, updated 4×/s in place
  const hv: Record<string, HTMLElement> = {};
  const meter = el('u');
  const pip = (k: string, label: string, tip: string, ...extra: Kid[]) => (hv[k] = el('span', { class: 'lc-pip', 'data-tip': label, 'data-hint': tip }, el('i'), el('b', null, label), ...extra, (hv[`${k}v`] = el('span', { class: 'v' }))));
  const health = el('footer', { class: 'lc-health', 'data-tile': 'health', 'aria-label': 'Health' },
    pip('trk', 'Tracking', 'Face tracking from your camera'), pip('mic', 'Mic', 'Microphone level (lip-sync)', el('span', { class: 'mtr' }, meter)),
    pip('obs', 'OBS', 'Whether OBS is showing VTube Pro'), pip('party', 'Party', 'Party members and knocks'),
    pip('srv', 'Server', 'VTube Pro’s engine on this computer'),
    pip('lat', 'Delay', 'How fast VTube Pro answers your clicks (under 60 ms is good). It has nothing to do with your stream.'),
    pip('gfx', 'Picture', 'How sharp your avatar looks in OBS. If it stutters, lower it in Room → Advanced → Graphics quality.'), (hv.warn = el('span', { class: 'warnmsg' })));
  function paintHealth() {
    const st = src.status(), live = deck.live();
    const tm = wrap.querySelector('[data-talkmeter]') as HTMLElement | null;
    if (tm) tm.style.width = `${Math.round((st.voice?.level ?? 0) * 100)}%`;
    const mm = wrap.querySelector('[data-micmeter]') as HTMLElement | null;   // (Audio tab)
    if (mm) mm.style.width = `${Math.round((st.mic ? st.micLevel : 0) * 100)}%`;
    const set = (k: string, cls: string, text: string) => { const c = `lc-pip ${cls}`; if (hv[k].className !== c) hv[k].className = c; if (hv[`${k}v`].textContent !== text) hv[`${k}v`].textContent = text; };
    set('trk', st.tracking ? (st.face ? 'ok' : 'warn') : '', st.tracking ? (st.face ? 'on' : 'no face found') : 'off');
    { const hint = st.tracking ? `Face tracking from your camera: ${Math.round(st.trackFps)} updates a second, picture ${Math.round(st.fps)} fps` : 'Face tracking from your camera'; if (hv.trk.dataset.hint !== hint) hv.trk.dataset.hint = hint; }
    set('mic', st.mic ? 'ok' : '', st.mic ? '' : 'off'); meter.style.width = `${Math.round((st.mic ? st.micLevel : 0) * 100)}%`;
    set('obs', st.obs > 0 ? 'ok' : 'warn', st.obs > 0 ? 'shows you' : 'not added yet');
    const others = st.party.members.filter((m) => !m.me).length;
    set('party', st.party.role === 'none' ? '' : st.party.knocks.length ? 'warn' : 'ok', st.party.role === 'none' ? 'off' : `${others}${st.party.knocks.length ? ` +${st.party.knocks.length} knocking` : ''}`);
    set('srv', deck.online() ? (live.studio ? 'ok' : 'warn') : 'err', deck.online() ? (live.studio ? 'ok' : 'studio closed') : 'not running');
    set('lat', ping < 0 ? '' : ping < 60 ? 'ok' : 'warn', ping < 0 ? '—' : `${ping} ms`);
    const gq = st.gfx;
    set('gfx', gq ? (gq.obs === 'Ultra' ? 'warn' : 'ok') : '', gq ? `OBS ${gq.obs}${gq.scale < 1 ? ` ${Math.round(gq.scale * 100)}%` : ''}${gq.lower ? ' · auto-lower' : ''} · studio ${gq.now || gq.preview}` : '—');
    const w = live.studio === 0 && deck.online() ? 'Studio window closed: buttons reach nobody' : !src.canRun ? 'Observer tab: read-only'
      : '';
    if (hv.warn.textContent !== w) hv.warn.textContent = w;
    if (!src.program || pgmFrame.classList.contains('air') !== onAir(st)) paintProgram(live, st);
    for (const m of st.party.members) {
      const row = wrap.querySelector(`[data-member="${window.CSS.escape(m.id)}"]`);
      if (row && row.classList.contains('speaking') !== m.speaking) { row.classList.toggle('speaking', m.speaking); row.querySelector('.av')?.classList.toggle('talk', m.speaking); }
      // greenroom: tech-check media in place (a rebuild would drop what the host is typing)
      const q = (k: string) => wrap.querySelector<HTMLElement>(`[data-${k}="${window.CSS.escape(m.id)}"]`);
      // moderation: the on-air preview in place
      const mc = q('modcam');
      if (mc instanceof HTMLImageElement && m.cam && mc.src !== m.cam) mc.src = m.cam;
      const g = m.gr;
      if (!g?.wait) continue;
      const img = q('grthumb');
      if (img instanceof HTMLImageElement && g.thumb && img.src !== g.thumb) img.src = g.thumb;
      const lv = q('grlevel'); if (lv) lv.style.width = `${Math.round((g.level ?? 0) * 100)}%`;
      const ct = q('grconn'); if (ct && ct.textContent !== connText(g.conn)) ct.textContent = connText(g.conn);
      const dot = q('grdot'), dc = g.conn?.st ?? ''; if (dot && (dot.getAttribute('class') ?? '') !== dc) dot.setAttribute('class', dc);
    }
    // (what paintKey leaves out of a rebuild, in place: how long a join has been connecting, Spout2 fps)
    for (const j of st.party.joins ?? []) {
      const e = wrap.querySelector<HTMLElement>(`[data-jointext="${window.CSS.escape(j.peer)}"]`), x = joinText(j, st.party.turn);
      if (e && e.textContent !== x) e.textContent = x;
    }
    const spoutIn = (key: string, sp: LiveSpout | undefined) => {
      const e = sp ? wrap.querySelector<HTMLElement>(`[data-spout="${window.CSS.escape(key)}"]`) : null;
      if (!e || !sp) return;
      const x = spoutLabel(sp), hn = spoutHint(sp);
      if (e.textContent !== x) e.textContent = x;
      if (e.dataset.hint !== hn) e.dataset.hint = hn;
    };
    spoutIn('host', st.me.spout);
    for (const m of st.party.members) spoutIn(m.id, m.spout);
    for (const t of wrap.querySelectorAll<HTMLElement>('time[data-at]')) { const x = agoText(Number(t.dataset.at), !!t.dataset.dur); if (t.textContent !== x) t.textContent = x; }
  }

  // ---------------------------------------------------------------- header + frame
  function header(st: LiveStatus) {
    const cur = lsGet(LS.preset) as string | null;
    const psel = el('select', { class: 'lc-select', 'aria-label': 'Show preset', 'data-tip': 'Show presets', 'data-hint': 'A quick bar, a kind of show and the tab it opens on' },
      el('option', { value: '' }, cur && presets.some((p) => p.name === cur) ? cur : 'Show preset'), ...presets.map((p, i) => el('option', { value: String(i) }, p.name)));
    psel.addEventListener('change', () => {
      const p = presets[Number(psel.value)]; if (!p) return;
      layout = sanitizeLayout(structuredClone(p.layout)); saveLayout(layout); lsSet(LS.preset, p.name);
      if (p.mode) void run('mode', { mode: p.mode }, `Mode ${p.mode}`);
      // (live-tabs: a preset opens the tab of its first panel — e.g. Interview night → Cameras)
      setTab(sanitizeTab(layout.order.find((t) => !layout.hidden.includes(t))));
      src.toast(`Preset “${p.name}”`, 'ok'); paint(true);
    });
    const savePreset = () => {
      const name = (prompt('Save this layout as a show preset. Name:', lsGet(LS.preset) || 'My show') || '').trim().slice(0, 32);
      if (!name) return;
      const mode = deck.live().mode;
      // (the tab you are on goes first in the saved order, so the preset opens on it)
      const cur = panes.last;
      const first: TileId = cur === 'rooms' || cur === 'transitions' || cur === 'privacy' ? 'scene' : cur === 'guests' || cur === 'audio' ? 'guests' : cur === 'chat' ? 'chat' : cur === 'me' ? 'me' : 'health';
      const saved: LiveLayout = { ...structuredClone(layout), order: [first, ...layout.order.filter((t) => t !== first)], hidden: [] };
      presets = presets.filter((p) => p.name !== name).concat({ name, layout: saved, mode });
      lsSet(LS.presets, presets); lsSet(LS.preset, name); src.toast(`Saved preset “${name}”`, 'ok'); paint(true);
    };
    const sm = src.streaming;
    // clarity: the light says exactly what it refers to (IN OBS / CAMERA ON / NOT IN OBS), never a bare "ON AIR"
    const as = airState(st), at = AIR_TEXT[as];
    return el('header', { class: 'lc-head' },
      el('span', { class: `lc-air${as === 'obs' ? ' on' : as === 'cam' ? ' cam' : ''}`, 'data-live': 'air', 'data-tut': 'live-air', 'data-air': as, 'data-tip': at.tip, 'data-hint': at.hint, 'data-key': src.popout ? null : 'Alt L', 'data-keyl': 'opens Live from anywhere' }, el('i'), at.label),
      el('h2', { class: 'lc-title', 'data-tip': 'Live', 'data-hint': 'Your show’s remote control: lights, rooms, guests, privacy. You go live from OBS.' }, 'Live'),
      statusLine(deck.live(), st),
      el('div', { class: 'lc-quick', role: 'toolbar', 'aria-label': 'Quick actions' }, el('span', { class: 'lc-qlbl' }, edit ? 'Pinned · click to unpin' : 'Pinned'),
        ...layout.quick.map((q) => B(q.label, q.action, q.params, { cls: 'lc-btn s' })),
        layout.quick.length ? null : el('span', { class: 'lc-note' }, 'Customise, then click any button to pin it.')),
      el('span', { class: 'lc-sp' }),
      psel,
      el('button', { class: 'lc-btn ic', 'aria-label': 'Save preset', 'data-tip': 'Save preset', 'data-hint': 'Keeps the quick bar, the kind of show and this tab', onClick: savePreset }, icon('pin', 16)),
      el('button', { class: `lc-btn${edit ? ' on' : ''}`, 'data-live': 'customise', 'data-tip': edit ? 'Done customising' : 'Customise', 'data-hint': 'Then click any button to pin it to the quick bar (click it again to unpin)', onClick: () => { edit = !edit; paint(true); } }, icon(edit ? 'check' : 'edit', 16), edit ? 'Done' : 'Customise'),
      edit ? el('button', { class: 'lc-btn', 'data-tip': 'Reset the quick bar', onClick: () => { layout = defaultLayout(); saveLayout(layout); paint(true); } }, 'Reset') : null,
      // (clarity: it was called "Streaming", and people pressed it to start streaming: it only fades the set-up menus)
      sm ? el('button', { class: `lc-btn${sm.get() ? ' on' : ''}`, 'data-live': 'streaming', 'aria-pressed': String(sm.get()), 'data-tip': 'Focus mode', 'data-hint': 'Dims the set-up menus so the show buttons stand out. It doesn’t start or stop your stream.', onClick: () => { sm.set(!sm.get()); paint(true); } }, icon('stream', 16), 'Focus mode') : null,
      // beta.12: Help / Tutorials for Live (the tutorials workstream plugs in via src/ui/tutorialsHook.ts; until then Help)
      el('button', { class: 'lc-btn ic', 'data-live': 'tutorials', 'aria-label': `${tutorialsLabel()}: Live Control`, 'data-tip': `${tutorialsLabel()}: Live Control`, 'data-hint': 'How each part of Live works', onClick: () => openTutorials('live') }, icon('help', 16)),
      src.popout ? null : el('button', { class: 'lc-btn ic', 'data-live': 'popout', 'aria-label': 'Pop out', 'data-tip': 'Pop out', 'data-hint': 'Own window: a 2nd monitor or an OBS Custom Browser Dock', onClick: () => popOut(src) }, icon('popout', 16)));
  }
  let lastSig = '';
  function paint(force = false) {
    if (!alive) return;
    const live = deck.live(), st = src.status();
    // (live meters — tracking rate, mic level, the talk-back level — update in place in paintHealth: a rebuild would close
    // an open dropdown under the user's mouse)
    // (paintKey: the status minus what changes all the time — those are painted in place by paintHealth)
    const sig = JSON.stringify([live, paintKey(st), rooms.length, poll, templates, deck.online(), size, tab, deckKeys.size, msgOpen.size, undoShown(), lookNow(live), lookErr, src.look?.saveError?.()?.at ?? 0, src.tracking?.get() ?? null]);
    if (!force && sig === lastSig) { paintHealth(); return; }
    // moderation: a volume slider being dragged is never rebuilt under the mouse (it would drop the drag)
    if (!force && performance.now() - slideAt < 900) { paintHealth(); return; }
    // a dropdown is open / focused in here (mic picker, poll select, preset): don't rebuild under it — it would snap shut
    const ae = document.activeElement;
    if (!force && (ae instanceof HTMLSelectElement || (ae instanceof HTMLInputElement && (ae.type === 'text' || !!ae.closest('.gl-root')))) && wrap.contains(ae)) { paintHealth(); return; }
    lastSig = sig;
    tt.hide();
    wrap.classList.toggle('lc-edit', edit);
    wrap.classList.toggle('lc-ro', !src.canRun);
    const groups = groupsNow();
    const shownPanes = groups.map((g, i) => g.includes(panes[i === 1 ? 'b' : 'a']) ? panes[i === 1 ? 'b' : 'a'] : g.includes(panes.last) ? panes.last : g[0]);
    if (!shownPanes.includes('transitions') && !shownPanes.includes('privacy')) stopAnim();
    // (the Go Live tab is moved into the new tile below and only asks the helper while its pane is shown)
    // live-layout: the original console (790057c) — PROGRAM + Camera on the left; Show and the tabbed tile(s) on the
    // right; wide: the panel row along the bottom (Rooms | People | Chat & polls | Me). Narrow: one column.
    const small = pgmSmall();
    wrap.classList.toggle('lc-pgms', small); wrap.classList.toggle('lc-pgmh', pgmSize === 'hidden');
    const wide = !small && (size === 'wide' || tall);
    const tiles = groups.map((g, i) => paneTile(live, st, g, shownPanes[i], i === 1 ? 'b' : 'a'));
    const main = el('div', { class: `lc-main${groups.length > 1 ? ' lc-split' : ''}` },
      // (small / hidden studio view: Guests · Chat · Me under the camera; under Show, Privacy · Transitions · Audio · OBS
      //  side by side with Rooms, whose cards grow to fill the space — no dead space)
      el('div', { class: 'lc-col lc-colL' }, pgmBar(), pgmSize === 'hidden' ? null : pgm, rCam(live, st), small ? tiles[0] : null),
      // (a short window, e.g. 1366 x 768: every tab under the camera, Rooms alone under Show)
      small ? el('div', { class: 'lc-col lc-colR' }, rShow(live), tiles[1] ? el('div', { class: 'lc-tilepair lc-roompair' }, tiles[1], rRooms(live)) : rRooms(live))
        : el('div', { class: 'lc-col lc-colR' }, rShow(live), groups.length > 1 ? el('div', { class: 'lc-tilepair' }, ...tiles) : tiles[0]),
      wide ? el('div', { class: 'lc-sec lc-a-sec' }, rRooms(live), pGuests(live, st), pChat(live), pMe(st)) : null);
    const kids: Kid[] = [header(st), main, health];
    // keep every scrolled list where the user left it (People, Rooms, Chat …): a rebuild makes new elements, which
    // would all start at the top — a guest's status changing must never yank the list back up
    const scrollKey = (e: Element) => { const t = e.closest('[data-tile]') as HTMLElement | null; const all = t ? [...t.querySelectorAll('.lc-scroll')] : [...wrap.querySelectorAll('.lc-scroll')]; return `${t?.dataset.tile ?? '-'}:${all.indexOf(e)}`; };
    const scrolls = new Map<string, number>();
    for (const e of wrap.querySelectorAll('.lc-scroll')) if (e.scrollTop > 0) scrolls.set(scrollKey(e), e.scrollTop);
    wrap.replaceChildren(...kids.filter((k): k is HTMLElement => !!k && typeof k !== 'string'));
    if (scrolls.size) for (const e of wrap.querySelectorAll('.lc-scroll')) { const y = scrolls.get(scrollKey(e)); if (y) e.scrollTop = y; }
    goLive?.setActive(shownPanes.includes('golive'));
    paintProgram(live, st);
    paintHealth();
    if (pop) renderPop();
    requestAnimationFrame(measureMarquees);
    requestAnimationFrame(layoutCheck);
  }
  function measureMarquees() {
    for (const m of wrap.querySelectorAll<HTMLElement>('.lc-mq')) {
      const inner = m.firstElementChild as HTMLElement | null; if (!inner) continue;
      const over = inner.scrollWidth - m.clientWidth;
      m.classList.toggle('over', over > 1);
      if (over > 1) { m.style.setProperty('--mq', `${-over - 6}px`); m.style.setProperty('--mq-t', `${Math.max(1.2, over / 40)}s`); const b = m.closest('[data-tip]') as HTMLElement | null; if (b && !b.dataset.tip) b.dataset.tip = inner.textContent ?? ''; }
    }
  }
  // size class from the space we actually get (studio panel, pop-out window or a narrow OBS dock). live-layout: the
  // PROGRAM monitor fills its column as in the original (790057c) — no fixed height.
  /** The right column is wide enough for two tabbed tiles side by side. */
  let split = false;
  function groupsNow(): Pane[][] {
    if (size === 'narrow') return [[...PANE_A, ...PANE_B]];
    if (pgmSmall()) return size === 'compact' ? [[...PANE_A.filter((p) => p !== 'rooms'), ...PANE_B]] : [PANE_A.filter((p) => p !== 'rooms'), PANE_B];
    if (size === 'wide' || tall) return split ? [['golive', 'privacy'], ['transitions', 'audio', 'obs']] : [PANE_B];
    return split ? [PANE_A, PANE_B] : [[...PANE_A, ...PANE_B]];
  }
  const ro = new ResizeObserver(() => {
    const r = wrap.getBoundingClientRect(), h = src.program ? r.height : innerHeight;
    // docked: the one-column 'narrow' layout is for the pop-out / OBS dock; in the studio the PROGRAM view is pinned
    // over its frame, so a squeezed studio (a tool drawer open) stays 'compact'
    // (beta.12: a phone / small tablet window is narrow too: the one-column console instead of an overlapping grid)
    const next = r.width < 760 && (!src.program || innerWidth <= 900) ? 'narrow' : r.width < 1500 || h < 860 ? 'compact' : 'wide';
    wrap.classList.toggle('lc-narrow', next === 'narrow'); wrap.classList.toggle('lc-compact', next === 'compact');
    wrap.style.setProperty('--lc-sec-h', `${Math.round(Math.max(250, Math.min(340, h * 0.31)))}px`);
    if (next !== size) { size = next; paint(true); } else { measureMarquees(); layoutCheck(); }
  });
  /** After a paint / resize: two tiles side by side when the right column has the room; rooms sized to fill. */
  function layoutCheck() {
    if (!alive) return;
    const cr = (wrap.querySelector('.lc-colR') as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const nextSplit = size !== 'narrow' && cr >= (split ? 860 : 900);
    if (nextSplit !== split) { split = nextSplit; paint(true); return; }
    // tall: the PROGRAM column is width-bound and a 16:9 picture would leave >= 200 px of letterbox: stack the panel row
    // under it instead. Measured from the column width + the camera tile (neither changes with the switch: no flapping).
    const main = wrap.querySelector('.lc-main') as HTMLElement | null, colL = wrap.querySelector('.lc-colL') as HTMLElement | null;
    const cam = wrap.querySelector('.lc-colL > .lc-a-cam') as HTMLElement | null;
    if (main && colL && size === 'compact' && !pgmSmall()) {
      const need = (colL.clientWidth - 20) * 9 / 16 + 20, free = main.clientHeight - (cam?.offsetHeight ?? 0) - 8 - need;
      const nextTall = tall ? free > 160 : free > 200;
      if (nextTall !== tall) { tall = nextTall; wrap.classList.toggle('lc-tall', tall); paint(true); return; }
    } else if (tall) { tall = false; wrap.classList.remove('lc-tall'); paint(true); return; }
    fitRooms();
  }
  /** Few rooms = bigger pictures that fill the Rooms tile; many = the normal scrolling grid (132 px minimum). */
  function fitRooms() {
    for (const box of wrap.querySelectorAll<HTMLElement>('.lc-rooms-wrap')) {
      const grid = box.querySelector<HTMLElement>('.lc-rooms'); if (!grid) continue;
      const n = grid.children.length, W = box.clientWidth, H = box.clientHeight, gap = size === 'compact' ? 6 : 8;
      const nameH = (grid.querySelector('.lc-room .nm') as HTMLElement | null)?.offsetHeight ?? 30;
      let best = 0;
      if (size !== 'narrow' && n && W > 0 && H > 0) for (let c = 1; c <= n; c++) {
        const w = Math.floor((W - 10 - (c - 1) * gap) / c), rows = Math.ceil(n / c);   // (10 px: room for a scrollbar)
        if (rows * (Math.min(w * 9 / 16, 108) + nameH + 12) + (rows - 1) * gap <= H && w > best) best = w;
      }
      const v = best >= 96 ? `${Math.min(best, 420)}px` : size === 'compact' ? '96px' : '';   // too many to fit: more, smaller cards (it scrolls)   // cards stay readable at 96 px; the picture is capped (--lc-th-max)
      if (grid.style.getPropertyValue('--lc-room-min') !== v) { if (v) grid.style.setProperty('--lc-room-min', v); else grid.style.removeProperty('--lc-room-min'); }
    }
  }
  ro.observe(wrap);
  const pro = new ResizeObserver(() => { if (size === 'narrow') return; const h = pgm.clientHeight - 20; if (h > 60) wrap.style.setProperty('--lc-pgm-col', `${Math.round(h * 16 / 9 + 20)}px`); });
  pro.observe(pgm);

  async function refreshPoll() {
    try {
      const t0 = performance.now();
      const r = await fetch('/api/poll/state', { cache: 'no-store' }); if (!r.ok) return;
      ping = Math.round(performance.now() - t0);
      const j = await r.json() as { poll: { state: string; question: string; shown: boolean; options?: { label: string; votes: number }[]; total?: number; voters?: number; winner?: number[] } | null; templates: { name: string }[] };
      poll = j.poll ? { live: j.poll.state === 'live', question: j.poll.question, shown: j.poll.shown, options: (j.poll.options ?? []).map((o) => ({ label: o.label, votes: o.votes })), total: j.poll.total ?? 0, voters: j.poll.voters ?? 0, winner: j.poll.winner ?? [] } : null;
      templates = (j.templates ?? []).map((t) => t.name).filter(Boolean).slice(0, 30);
      paint();
    } catch { ping = -1; /* server busy */ }
  }
  async function refreshDeck() {
    try {
      const r = await fetch('/api/deck/layout', { cache: 'no-store' }); if (!r.ok) return;
      const j = await r.json() as { layout?: { cols: number; pages: { name: string; keys: ({ action: string; params?: Record<string, string | number> } | null)[] }[] } };
      const m = new Map<string, string>(), L = j.layout;
      L?.pages.forEach((p, pi) => p.keys.forEach((k, i) => { if (!k?.action) return; const key = quickKey(k); if (!m.has(key)) m.set(key, `${L.pages.length > 1 ? `${p.name || `Page ${pi + 1}`} · ` : ''}row ${Math.floor(i / L.cols) + 1}, key ${(i % L.cols) + 1}`); }));
      if (m.size !== deckKeys.size || [...m].some(([k, v]) => deckKeys.get(k) !== v)) { deckKeys = m; paint(true); }
    } catch { /* no deck layout */ }
  }
  const loadRooms = () => void fetch('/api/scenes').then((r) => (r.ok ? r.json() : [])).then((s: { id: string; name: string; thumb?: string | null; hidden?: boolean }[]) => { rooms = s.filter((x) => !x.hidden).map((x) => ({ id: x.id, name: x.name, thumb: x.thumb })); paint(true); }).catch(() => {});
  loadRooms();
  void refreshPoll(); void refreshDeck();
  const off = deck.on(() => paint());
  const offFavs = onRoomFavs(() => paint(true));
  const offTut = onTutorials(() => paint(true));
  src.onStatus(() => paint());
  src.look?.on?.(() => paint());
  const offTracking = src.tracking?.on(() => paint()) ?? null;
  const tick = window.setInterval(() => {
    if (document.hidden) return;
    paintHealth();
    if (src.wantThumbs && wrap.querySelector('.lc-modpv, .lc-gr .thumb')) src.wantThumbs();
  }, 250);
  const pt = window.setInterval(() => { if (!document.hidden) void refreshPoll(); }, 2000);
  const dt = window.setInterval(() => { if (!document.hidden) void refreshDeck(); }, 30000);
  const onLayout = () => { layout = loadLayout(); paint(true); };
  document.addEventListener('vtp-live-layout', onLayout);
  // live-tabs: Ctrl+K "open Transitions" / another page asks for a tab (openLiveTab)
  const onTab = (e: Event) => { const t = sanitizeTab((e as CustomEvent<{ tab?: string }>).detail?.tab); setTab(t); };
  document.addEventListener(LIVE_TAB_EVENT, onTab);
  paint(true);
  if (src.program) undoProgram = src.program(pgmFrame, [pgmBrbHost, pgmTag, pgmLt]);
  (window as unknown as { vtpLive?: unknown }).vtpLive = { get layout() { return layout; }, get live() { return deck.live(); }, get status() { return src.status(); }, get size() { return size; }, get tab() { return tab; }, setTab, paint };
  return { destroy() { alive = false; goLive?.destroy(); closePop(); off(); offTracking?.(); ro.disconnect(); pro.disconnect(); clearInterval(tick); clearInterval(pt); clearInterval(dt); tt.hide(); tt.tip.remove(); undoProgram?.(); if (src.program) document.body.classList.remove('lc-pgm-off'); offFavs(); offTut(); pgmBrb.destroy(); stopAnim(); stopRecording(); cancelAnimationFrame(cardsRaf); document.removeEventListener('vtp-live-layout', onLayout); document.removeEventListener(LIVE_TAB_EVENT, onTab); wrap.remove(); } };
}

/** greenroom: "just now" / "40 s ago" / "3 min ago". */
function agoText(at: number, dur = false): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (!at) return '';
  if (dur) return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return s < 5 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
/** greenroom: a waiting guest's connection in one line. */
function connText(c: LiveGreen['conn']): string {
  if (!c) return 'no link info';
  const w = c.st === 'connecting' ? 'connecting…' : c.st;
  return `${w}${c.rtt ? ` · ${c.rtt} ms` : ''}${c.video ? ` · ${c.video}` : ''}`;
}

// ---------------------------------------------------------------- live-tabs: opening a tab / the OBS wizard from outside
/** Event the mounted panel listens to: {detail: {tab}} switches to that tab (remembered). */
export const LIVE_TAB_EVENT = 'vtp-live-tab';
/** Open a Live tab (Ctrl+K, other areas): remembers it, and switches a mounted panel right away. */
export function openLiveTab(tab: LiveTabId) {
  try { localStorage.setItem(LS.tab, JSON.stringify(tab)); } catch { /* storage off */ }
  document.dispatchEvent(new CustomEvent(LIVE_TAB_EVENT, { detail: { tab } }));
}
/** The OBS tab's "Set up OBS automation" (contract with the obs-wizard lane, CONTRACT.md "live-tabs"): a cancelable
 *  `vtp:obs-wizard` event on document, detail {from: 'live'}. The obs-wizard code calls preventDefault() when it opens
 *  its wizard. Nobody did → the page's own fallback (src.obsWizard: the studio's OBS set-up), else a plain hint. */
export const OBS_WIZARD_EVENT = 'vtp:obs-wizard';
export function openObsWizard(src: Pick<LiveSource, 'obsWizard' | 'toast'>) {
  const ev = new CustomEvent(OBS_WIZARD_EVENT, { cancelable: true, detail: { from: 'live' } });
  if (!document.dispatchEvent(ev)) return;
  if (src.obsWizard) { src.obsWizard(); return; }
  src.toast('Open the VTube Pro studio window to set up OBS (Live → OBS → Set up OBS automation).', 'info');
}

/** Open the pop-out (same server, same guards: it is just another page of this origin). */
export function popOut(src: Pick<LiveSource, 'toast'>) {
  const w = window.open('/live.html', 'vtp-live', 'popup,width=1440,height=900');
  if (!w) src.toast(`Pop-up blocked. Open ${location.origin}/live.html yourself (or add it to OBS as a Custom Browser Dock).`, 'warn');
}

/** People tile: a Spout2 performer's tag + its health in the tooltip (real alpha / keyed, fps, live). `key`: the row's
 *  member id ('host' = me), so paintHealth can update the fps in place. */
function spoutTag(sp: LiveSpout, key: string): HTMLElement {
  const warn = !sp.live || (sp.native && !sp.alpha);
  const tip = `Spout2${sp.app ? ` · ${sp.app}` : ''}${sp.native ? '' : ' via webcam bridge'}`;
  return el('span', { class: 'tag', style: warn ? 'color:var(--lc-warn)' : '', 'data-spout': key, 'data-tip': tip, 'data-hint': spoutHint(sp) }, spoutLabel(sp));
}
function spoutHint(sp: LiveSpout): string {
  return `${sp.alpha ? 'Real alpha (transparent background)' : sp.native ? 'Alpha off: keyed over green (an older host, or the app sends no transparency)' : 'Colour key (a webcam bridge has no alpha)'} · ${sp.live ? `${sp.fps || '?'} fps` : 'no frames right now'}`;
}

/** People tile: how a guest talks — LINK (browser link guest), VOICE (app guest talking in VTube Pro), or why an app guest
 *  has no in-app voice (their choice: Discord / off; or their app is too old: use Discord). */
function voiceTag(m: LiveMember): HTMLElement | null {
  switch (m.vox) {
    case 'app': return el('span', { class: 'tag', 'data-tip': 'Talks in VTube Pro', 'data-hint': 'In-app voice, no Discord: you hear them here (Hear them), they hear you + everyone else on the call (never themselves)' }, 'VOICE');
    case 'wait': return el('span', { class: 'tag', 'data-tip': 'In-app voice connecting', 'data-hint': 'Their VTube Pro supports in-app voice; the audio link is still coming up (or their mic is blocked)' }, 'VOICE…');
    case 'discord': return el('span', { class: 'tag', 'data-tip': 'Uses Discord voice', 'data-hint': 'They picked “Using Discord voice instead”: talk to them in your Discord call' }, 'DISCORD');
    case 'off': return el('span', { class: 'tag', 'data-tip': 'In-app voice off', 'data-hint': 'They switched “Talk in VTube Pro” off: no voice from or to them here' }, 'NO VOICE');
    case 'old': return el('span', { class: 'tag', style: 'color:var(--lc-warn)', 'data-tip': 'This guest’s app is too old for in-app voice — use Discord', 'data-hint': 'Their VTube Pro doesn’t have in-app voice yet: talk in your Discord call (or they update VTube Pro)' }, 'OLD APP · USE DISCORD');
  }
  return m.voice ? el('span', { class: 'tag', 'data-tip': 'Talks over the link', 'data-hint': 'Not in your Discord call: their voice comes over the link (you hear them here if Hear them is on)' }, 'LINK') : null;
}

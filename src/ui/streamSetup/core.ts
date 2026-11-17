// "Set up my chat & stream" — the guided set-up (lane stream-setup). One premium screen per step:
//   1. Your platforms  — big tiles: Twitch, YouTube, Kick, Rumble, TikTok (pick any).
//   2. Connect         — one platform at a time, the simplest real way the connectors support (a channel name, a channel
//                        link, the Rumble link, TikFinity), then a live chat box: "Say hi in your chat" → "I can see your
//                        chat ✔" the moment a REAL message arrives (Send a test message shows the path works too).
//   3. Alerts          — follows / subs / gifts / raids / tips: who sends each, a Try it button, a live preview of the card
//                        your viewers see, and where alerts show.
//   4. Chat on screen  — where (a screen in your room, a friend holding a tablet, beside your game, not on screen), size,
//                        side, filters, the chat buddy picker, with the real chat renderer as the preview.
//   5. You're ready ✔  — what is connected, what shows where, and one next step.
// Read only: nothing is ever posted to a platform.
// Everything the wizard needs comes through StreamSetupHost (the studio: src/ui/streamSetup/index.ts; tests: a mock).
import { ChatCanvas } from '../../chat/chatCanvas.ts';
import { ChatFeed } from '../../chat/feed.ts';
import { icon as platIcon } from '../../chathub/util.ts';
import { buddyChoices, DEFAULT_CHAT_STATE, testChatEvents, type ChatEvent, type ChatStatus, type LivePlatform, type SceneChatState } from '../../../shared/chat.ts';
import {
  ALERT_INFO, ALERT_KINDS, MIN_ALERT_CHOICES, PLATFORM_INFO, SETUP_PLATFORMS, SIZE_CHOICES, SPOTS, TITLE_SUPPORTED, alertTest, alertWho, isGood, parseInput,
  seenReal, setupSummary, sizeOf, spotOf, verdict, visibleSteps, type AlertKind, type ScreenSpot, type StepId, type Verdict,
} from '../../../shared/streamSetup.ts';
import { brandMark } from '../brandMark.ts';
import { h } from '../dom.ts';

export type DockMode = 'auto' | 'always' | 'off';
export interface ChatConfigView {
  kick: { enabled: boolean; channel: string };
  rumble: { enabled: boolean; hasKey: boolean };
  youtube: { enabled: boolean; handle: string; channelId: string; videoId: string };
  twitch: { enabled: boolean; channel: string };
  tiktok: { enabled: boolean; user: string };
  exists?: boolean;
}
export interface Marks { alerts?: boolean; screen?: boolean; picked?: LivePlatform[] }
export interface BuddyAvatar { id: string; name?: string; source?: string; thumb?: string | null }

/** What the wizard needs from the page it runs in. */
export interface StreamSetupHost {
  /** ?observer=1 studios: nothing is saved (the wizard says so). */
  observer: boolean;
  getConfig(): Promise<ChatConfigView>;
  saveConfig(patch: Record<string, unknown>): Promise<ChatConfigView>;
  /** A local test event (POST /api/chat/test): your OBS + preview only, never your real chat. */
  sendTest(what: string, platform?: LivePlatform): Promise<void>;
  status(): ChatStatus | null;
  events(): readonly ChatEvent[];
  onChange(fn: () => void): () => void;
  canEdit(): boolean;
  inRoom(): boolean;
  chatState(): SceneChatState;
  setChat(p: Partial<SceneChatState>): void;
  dockChat(): DockMode;
  /** beta.12: the chat box placement control (where on the stream, how big: src/ui/chatBoxPanel.ts), when the studio has it. */
  chatBoxPlace?(): HTMLElement;
  setDockChat(m: DockMode): void;
  avatars(): Promise<BuddyAvatar[]>;
  openChatHub(): void;
  marks(): Marks;
  setMarks(m: Marks): void;
  close(): void;
}

export interface MountOpts { startAt?: StepId; platform?: LivePlatform }
export interface StreamSetupHandle { destroy(): void; go(step: StepId): void; readonly step: StepId }

// ---------------------------------------------------------------- icons (local set: alert kinds + UI bits)
const SVG: Record<string, string> = {
  follow: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  sub: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5S10.8 4 8.3 4.3C6.4 4.5 6.6 7.6 8.6 8.5M12 8.5s1.2-4.5 3.7-4.2c1.9.2 1.7 3.3-.3 4.2"/>',
  raid: '<path d="M3 12h11M10 7l5 5-5 5M17 5v14"/>',
  tip: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2 2.8.8 2.8 2.1-1.2 2.1-2.8 2.1c-1.3 0-2.4-.6-2.9-1.5M12 6.3v1.5M12 16.4v1.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4.5"/>',
  room: '<path d="M3.5 10.5 12 3.8l8.5 6.7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  buddy: '<circle cx="9" cy="7" r="3"/><path d="M3.5 20c0-3.5 2.5-6 5.5-6"/><rect x="12" y="10" width="9" height="11" rx="1.5"/><path d="M14.5 13.5h4M14.5 16.5h3"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M17.3 8h1.7M17.3 11h1.7M17.3 14h1.7"/>',
  none: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M4 4l16 16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  send: '<path d="M4 12 20 4l-6 16-2.5-6.5z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  hub: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8M8 16h5"/>',
};
function ic(name: string, size = 20): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = SVG[name] ?? '';
  return s;
}
const plat = (p: LivePlatform, size = 28) => { const s = platIcon(p, 'ss-plat'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size)); s.setAttribute('aria-hidden', 'true'); return s; };

// ---------------------------------------------------------------- styles (brand tokens: portal BRAND.md)
export const STREAM_SETUP_CSS = `
.ss{--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--pink:#ff5fb4;--amber:#ffcf6a;--err:#ff6b6b;
  --ease:cubic-bezier(.16,1,.3,1);display:grid;grid-template-columns:248px 1fr;height:100%;min-height:0;background:var(--ink-2);color:var(--fg);font:15px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.ss *{box-sizing:border-box}
.ss button{font:inherit;color:inherit}
.ss :focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:6px}
.ss-rail{background:linear-gradient(180deg,#0d1316,#080b0e);border-right:1px solid var(--line);padding:22px 18px;display:flex;flex-direction:column;gap:18px;min-height:0}
.ss-brand{display:flex;align-items:center;gap:10px;font:700 16px/1 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em}
.ss-rail h2{margin:6px 0 0;font:700 19px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em}
.ss-rail p{margin:0;color:var(--mute);font-size:13px}
.ss-steps{list-style:none;margin:4px 0 0;padding:0;display:grid;gap:4px}
.ss-steps button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border-radius:12px;cursor:pointer;color:var(--mute);transition:background .18s var(--ease),color .18s var(--ease)}
.ss-steps button:hover{background:rgb(255 255 255/.04);color:var(--fg)}
.ss-steps .n{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line-strong);font:600 12px/1 ui-monospace,"Geist Mono",Consolas,monospace;flex:none}
.ss-steps .cur button{background:rgb(123 216 143/.09);color:var(--fg)}
.ss-steps .cur .n{border-color:var(--lime);color:var(--lime)}
.ss-steps .done .n{background:var(--lime);border-color:var(--lime);color:var(--ink)}
.ss-rail-foot{margin-top:auto;display:flex;gap:8px;align-items:flex-start;color:var(--dim);font-size:12.5px;line-height:1.45}
.ss-rail-foot svg{flex:none;color:var(--lime);margin-top:1px}
.ss-main{display:grid;grid-template-rows:auto 1fr auto;min-height:0;min-width:0;position:relative}
.ss-head{padding:26px 32px 8px;position:relative}
.ss-eyebrow{display:flex;align-items:center;gap:10px;font:500 11px/1 ui-monospace,"Geist Mono",Consolas,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--lime);margin-bottom:12px}
.ss-eyebrow i{width:24px;height:1px;background:var(--lime)}
.ss-head h1{margin:0;font:700 30px/1.12 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;max-width:640px}
.ss-head .lead{margin:8px 0 0;color:var(--mute);font-size:16px;max-width:620px}
.ss-x{position:absolute;top:18px;right:18px;width:40px;height:40px;border-radius:12px;border:1px solid transparent;background:transparent;color:var(--mute);display:grid;place-items:center;cursor:pointer;transition:background .18s var(--ease),color .18s var(--ease)}
.ss-x:hover{background:rgb(255 255 255/.06);color:var(--fg)}
.ss-body{overflow:auto;padding:18px 32px 24px;min-height:0}
.ss-body.in{animation:ss-in .5s var(--ease) both}
@keyframes ss-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.ss-foot{display:flex;align-items:center;gap:12px;padding:16px 32px 22px;border-top:1px solid var(--line);background:linear-gradient(180deg,transparent,rgb(0 0 0/.18))}
.ss-next{flex:1;min-width:0;color:var(--dim);font-size:13px;display:flex;gap:8px;align-items:center}
.ss-next b{font:500 11px/1 ui-monospace,"Geist Mono",Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.ss-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--line-strong);background:rgb(255 255 255/.06);color:var(--fg);font-weight:600;cursor:pointer;white-space:nowrap;transition:background .18s var(--ease),border-color .18s var(--ease),transform .18s var(--ease)}
.ss-btn:hover{background:rgb(255 255 255/.1)}
.ss-btn:disabled{opacity:.45;cursor:not-allowed}
.ss-btn.primary{background:var(--lime);border-color:transparent;color:var(--ink);height:52px;padding:0 26px;font-size:16px}
.ss-btn.primary:hover:not(:disabled){background:var(--lime-hi)}
.ss-btn.ghost{background:transparent;border-color:transparent;color:var(--mute)}
.ss-btn.ghost:hover{color:var(--fg);background:rgb(255 255 255/.04)}
.ss-btn.small{height:36px;padding:0 13px;font-size:13.5px;border-radius:10px}
.ss .ss-link{all:unset;cursor:pointer;color:var(--sky);font-weight:600;display:inline-flex;gap:6px;align-items:center}
.ss .ss-link:hover{text-decoration:underline}
.ss .ss-link:focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:4px}
.ss-note{color:var(--dim);font-size:13px;margin:10px 0 0}
.ss-banner{display:flex;gap:10px;align-items:center;padding:11px 14px;border-radius:12px;border:1px solid rgb(255 207 106/.3);background:rgb(255 207 106/.08);color:var(--amber);font-size:13.5px;margin-bottom:14px}
/* step 1: platform tiles */
.ss-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.ss-tile{position:relative;text-align:left;display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(180deg,rgb(255 255 255/.05),rgb(255 255 255/.015));cursor:pointer;min-height:158px;transition:border-color .18s var(--ease),background .18s var(--ease),transform .18s var(--ease);animation:ss-in .55s var(--ease) both;animation-delay:calc(var(--i,0)*45ms)}
.ss-tile:hover{border-color:var(--line-strong);transform:translateY(-1px)}
.ss-tile.on{border-color:color-mix(in srgb,var(--pc) 70%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--pc) 14%,transparent),rgb(255 255 255/.015));box-shadow:0 0 0 1px color-mix(in srgb,var(--pc) 35%,transparent),0 18px 50px -30px var(--pc)}
.ss-tile b{font:700 18px/1.1 Archivo,ui-sans-serif,system-ui,sans-serif}
.ss-tile span.l{color:var(--mute);font-size:13.5px;line-height:1.4}
.ss-tile .tick{position:absolute;top:14px;right:14px;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line-strong);display:grid;place-items:center;color:transparent;transition:all .18s var(--ease)}
.ss-tile.on .tick{background:var(--lime);border-color:var(--lime);color:var(--ink)}
.ss-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:99px;border:1px solid var(--line-strong);background:rgb(255 255 255/.03);color:var(--mute);font-size:12px;font-weight:500;width:max-content}
.ss-chip.ok{border-color:rgb(123 216 143/.35);background:rgb(123 216 143/.1);color:var(--lime)}
.ss-chip.warn{border-color:rgb(255 207 106/.3);background:rgb(255 207 106/.08);color:var(--amber)}
.ss-chip.soon{background:rgb(255 255 255/.06);color:rgb(255 255 255/.55);border-color:var(--line)}
/* step 2: connect */
.ss-ptabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.ss-ptab{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 14px 0 10px;border-radius:99px;border:1px solid var(--line);background:rgb(255 255 255/.03);color:var(--mute);cursor:pointer;font-weight:600;font-size:14px;transition:all .18s var(--ease)}
.ss-ptab.cur{border-color:var(--line-strong);background:rgb(255 255 255/.08);color:var(--fg)}
.ss-ptab .lt{width:8px;height:8px;border-radius:50%;background:#3a4450}
.ss-lt-seen,.ss-lt-ok,.ss-lt-wait{background:var(--lime)!important;box-shadow:0 0 10px rgb(123 216 143/.7)}
.ss-lt-connecting{background:var(--amber)!important;animation:ss-pulse 1.1s ease-in-out infinite}
.ss-lt-bad{background:var(--err)!important}
@keyframes ss-pulse{50%{opacity:.35}}
.ss-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,400px);gap:24px;align-items:start}
.ss-card{border:1px solid var(--line);border-radius:20px;background:linear-gradient(180deg,rgb(255 255 255/.05),rgb(255 255 255/.018));box-shadow:inset 0 1px 0 rgb(255 255 255/.05);padding:22px}
.ss-card h3{margin:0;display:flex;align-items:center;gap:12px;font:700 21px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em}
.ss-field{display:grid;gap:7px;margin-top:18px}
.ss-field label{font-weight:600;font-size:14px}
.ss-field input{height:52px;border-radius:12px;border:1px solid var(--line-strong);background:var(--ink);color:var(--fg);font:500 17px/1 Geist,ui-sans-serif,system-ui,sans-serif;padding:0 16px;transition:border-color .18s var(--ease),box-shadow .18s var(--ease);width:100%}
.ss-field input:focus{outline:none;border-color:var(--lime);box-shadow:0 0 0 4px rgb(123 216 143/.14)}
.ss-field input.bad{border-color:var(--err)}
.ss-field .hint{color:var(--dim);font-size:13px}
.ss-field .err{color:var(--err);font-size:13.5px;font-weight:500}
.ss-state{display:flex;gap:14px;align-items:flex-start;margin-top:18px;padding:16px;border-radius:16px;border:1px solid var(--line);background:rgb(0 0 0/.18)}
.ss-state .big{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none;background:rgb(255 255 255/.06);color:var(--mute)}
.ss-state.seen .big,.ss-state.ok .big,.ss-state.wait .big{background:var(--lime);color:var(--ink)}
.ss-state.bad .big{background:rgb(255 107 107/.15);color:var(--err)}
.ss-state.connecting .big::after{content:"";width:18px;height:18px;border-radius:50%;border:2px solid var(--amber);border-right-color:transparent;animation:ss-spin .8s linear infinite}
@keyframes ss-spin{to{transform:rotate(360deg)}}
.ss-state b{display:block;font:700 18px/1.25 Archivo,ui-sans-serif,system-ui,sans-serif}
.ss-state span{color:var(--mute);font-size:14px}
.ss-state.seen{border-color:rgb(123 216 143/.4);background:rgb(123 216 143/.07)}
.ss-state.seen .big{animation:ss-pop .6s var(--ease)}
@keyframes ss-pop{0%{transform:scale(.4)}60%{transform:scale(1.12)}100%{transform:scale(1)}}
.ss-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px}
.ss-steps-ol{margin:14px 0 0;padding-left:20px;color:var(--mute);display:grid;gap:6px}
.ss-steps-ol b{color:var(--fg)}
.ss-feed{border:1px solid var(--line);border-radius:20px;background:#090d11;overflow:hidden;display:flex;flex-direction:column;min-height:340px}
.ss-feed-h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);font:600 13px/1 Geist,ui-sans-serif,system-ui,sans-serif;color:var(--mute)}
.ss-feed-h .live{width:8px;height:8px;border-radius:50%;background:#ff3b4a;box-shadow:0 0 8px #ff3b4a}
.ss-feed-list{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;padding:12px;min-height:240px}
.ss-msg{display:flex;gap:9px;align-items:flex-start;padding:8px 10px;border-radius:12px;animation:ss-in .45s var(--ease) both;font-size:14.5px;line-height:1.4}
.ss-msg .ss-plat{flex:none;margin-top:1px}
.ss-msg .u{font-weight:700;margin-right:6px}
.ss-msg .t{color:#dfe7e3;word-break:break-word}
.ss-msg .tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:99px;font-size:10.5px;font-weight:600;letter-spacing:.04em;background:rgb(255 255 255/.08);color:var(--mute);vertical-align:1px}
.ss-msg.real{background:rgb(123 216 143/.08)}
.ss-empty{margin:auto;display:grid;justify-items:center;gap:10px;text-align:center;color:var(--mute);max-width:260px;padding:24px 8px}
.ss-empty .dots{display:flex;gap:6px}.ss-empty .dots i{width:7px;height:7px;border-radius:50%;background:var(--mute);animation:ss-pulse 1.2s ease-in-out infinite}
.ss-empty .dots i:nth-child(2){animation-delay:.2s}.ss-empty .dots i:nth-child(3){animation-delay:.4s}
.ss-feed-f{padding:12px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:12.5px;color:var(--dim)}
/* step 3: alerts */
.ss-alerts{display:grid;gap:8px}
.ss-alert{display:grid;grid-template-columns:40px 1fr auto;gap:14px;align-items:center;padding:11px 14px;border-radius:16px;border:1px solid var(--line);background:rgb(255 255 255/.025);transition:border-color .18s var(--ease),background .18s var(--ease)}
.ss-alert.cur{border-color:rgb(123 216 143/.4);background:rgb(123 216 143/.06)}
.ss-alert .ai{width:40px;height:40px;border-radius:14px;display:grid;place-items:center;background:rgb(255 255 255/.05);color:var(--lime)}
.ss-alert.off .ai{color:var(--dim)}
.ss-alert b{font-weight:700;font-size:15.5px}
.ss-alert .l{color:var(--mute);font-size:13.5px;display:block}
.ss-alert .w{color:var(--dim);font-size:12.5px;display:block;margin-top:2px}
.ss-seg{display:inline-flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ss-seg button{height:38px;padding:0 14px;border-radius:99px;border:1px solid var(--line-strong);background:rgb(255 255 255/.03);color:var(--mute);cursor:pointer;font-weight:600;font-size:13.5px;transition:all .18s var(--ease)}
.ss-seg button[aria-pressed="true"]{background:var(--fg);border-color:var(--fg);color:var(--ink)}
.ss-sub{font:700 15px/1.3 Archivo,ui-sans-serif,system-ui,sans-serif;margin:22px 0 2px}
.ss-preview{border:1px solid var(--line);border-radius:20px;overflow:hidden;padding-top:44px;background:radial-gradient(520px 260px at 70% 0%,#173248,transparent),linear-gradient(180deg,#0e151c,#090c10);position:relative}
.ss-preview canvas{display:block;width:100%;height:auto}
.ss-preview .cap{position:absolute;left:12px;top:11px;display:inline-flex;gap:6px;align-items:center;height:24px;padding:0 10px;border-radius:99px;background:rgb(0 0 0/.55);color:#dfe7e3;font:500 10.5px/1 ui-monospace,"Geist Mono",Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;backdrop-filter:blur(8px)}
.ss-preview .cap i{width:6px;height:6px;border-radius:50%;background:#ff3b4a}
.ss-where{display:grid;gap:8px;margin-top:14px}
.ss-where div{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--mute)}
.ss-where svg{flex:none;color:var(--sky);margin-top:1px}
.ss-where b{color:var(--fg);font-weight:600}
/* step 4: chat on screen */
.ss-spots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ss-spot{text-align:left;display:grid;grid-template-columns:40px 1fr;gap:12px;align-items:start;padding:14px;border-radius:16px;border:1px solid var(--line);background:rgb(255 255 255/.025);cursor:pointer;transition:all .18s var(--ease)}
.ss-spot:hover{border-color:var(--line-strong)}
.ss-spot[aria-checked="true"]{border-color:var(--lime);background:rgb(123 216 143/.07);box-shadow:0 0 0 1px rgb(123 216 143/.25)}
.ss-spot .si{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgb(255 255 255/.05);color:var(--fg)}
.ss-spot[aria-checked="true"] .si{background:var(--lime);color:var(--ink)}
.ss-spot b{font-weight:700;display:block}
.ss-spot span{color:var(--mute);font-size:13px;line-height:1.4;display:block}
.ss-spot .ss-chip{margin-top:6px}
.ss-buddies{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin-top:8px;max-height:236px;overflow:auto;padding:2px}
.ss-buddy{position:relative;display:grid;gap:6px;padding:8px;border-radius:14px;border:1px solid var(--line);background:rgb(255 255 255/.025);cursor:pointer;text-align:center;font-size:12.5px;font-weight:600;transition:all .18s var(--ease)}
.ss-buddy[aria-pressed="true"]{border-color:var(--lime);background:rgb(123 216 143/.08)}
.ss-buddy .img{aspect-ratio:1;border-radius:10px;background:#141b20 center/cover no-repeat;display:grid;place-items:center;color:var(--dim)}
.ss-buddy .ck{position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;background:var(--lime);color:var(--ink);display:grid;place-items:center}
.ss-buddy small{display:block;color:var(--dim);font-weight:500;font-size:10.5px}
.ss-switch{display:flex;align-items:center;gap:12px;margin-top:14px;cursor:pointer;font-size:14px}
.ss-switch input{appearance:none;width:42px;height:24px;border-radius:99px;background:#26303a;position:relative;cursor:pointer;transition:background .18s var(--ease);flex:none;margin:0}
.ss-switch input::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s var(--ease)}
.ss-switch input:checked{background:var(--lime)}
.ss-switch input:checked::after{transform:translateX(18px)}
/* step 5: done */
.ss-done{max-width:720px}
.ss-done-hero{display:flex;gap:18px;align-items:center;margin-bottom:22px}
.ss-done-hero .big{width:64px;height:64px;border-radius:50%;background:var(--lime);color:var(--ink);display:grid;place-items:center;flex:none;animation:ss-pop .7s var(--ease);box-shadow:0 0 0 10px rgb(123 216 143/.12)}
.ss-sum{display:grid;gap:8px}
.ss-sum .r{display:grid;grid-template-columns:36px 1fr auto;gap:14px;align-items:center;padding:13px 16px;border-radius:14px;border:1px solid var(--line);background:rgb(255 255 255/.025)}
.ss-sum .r b{display:block;font-weight:700}.ss-sum .r span{color:var(--mute);font-size:13.5px}
.ss-sum .r .i{color:var(--lime);display:grid;place-items:center}
@media (max-width:860px){.ss-next{display:none}.ss-foot{flex-wrap:wrap;justify-content:flex-end}.ss{grid-template-columns:1fr}.ss-rail{display:none}.ss-split{grid-template-columns:1fr}.ss-spots{grid-template-columns:1fr}.ss-head,.ss-body,.ss-foot{padding-left:18px;padding-right:18px}.ss-head h1{font-size:25px}}
@media (prefers-reduced-motion:reduce){.ss *{animation:none!important;transition:none!important}}
`;

// ---------------------------------------------------------------- the wizard
const SAMPLE: { u: string; c: string; t: string }[] = [
  { u: 'NightOwl42', c: '#7bd88f', t: 'just got here, hi everyone' },
  { u: 'PixelPioneer', c: '#6cc7f5', t: 'the room looks so good today' },
  { u: 'LateShiftLiz', c: '#ff5fb4', t: 'what are we playing?' },
];
function sampleEvents(platforms: readonly LivePlatform[]): ChatEvent[] {
  const now = Date.now();
  return SAMPLE.map((s, i) => ({ id: `ss-sample:${i}`, kind: 'chat', platform: platforms[i % Math.max(1, platforms.length)] ?? 'twitch', user: s.u, color: s.c, text: s.t, ts: now - (SAMPLE.length - i) * 4000, test: true }));
}

export function mountStreamSetup(root: HTMLElement, host: StreamSetupHost, opts: MountOpts = {}): StreamSetupHandle {
  if (!document.getElementById('ss-style')) document.head.append(h('style', { id: 'ss-style' }, STREAM_SETUP_CSS));
  const steps = visibleSteps();
  const marks = host.marks();
  let cfg: ChatConfigView | null = null;
  const enabledOf = (c: ChatConfigView | null) => (c ? SETUP_PLATFORMS.filter((p) => c[p]?.enabled) : []);
  const s = {
    step: (opts.startAt ?? setupSummary(host.status(), host.events(), marks).firstOpen) as StepId,
    picked: [...new Set([...(marks.picked ?? []), ...SETUP_PLATFORMS.filter((p) => host.status()?.platforms[p]?.enabled)])] as LivePlatform[],
    cur: 0,
    input: {} as Partial<Record<LivePlatform, string>>,
    err: {} as Partial<Record<LivePlatform, string>>,
    editing: {} as Partial<Record<LivePlatform, boolean>>,
    busy: null as LivePlatform | null,
    alert: null as AlertKind | null,
    tested: {} as Partial<Record<LivePlatform, number>>,
    savedAt: {} as Partial<Record<LivePlatform, number>>,
  };
  /** Observer tests (never reach the server): shown in the chat box only. */
  const localEvents: ChatEvent[] = [];
  const allEvents = () => [...host.events(), ...localEvents];
  if (opts.platform) { if (!s.picked.includes(opts.platform)) s.picked.push(opts.platform); s.cur = s.picked.indexOf(opts.platform); s.step = 'connect'; }
  if (s.step === 'connect' && !s.picked.length) s.step = 'platforms';
  // the first platform that still needs work
  if (s.step === 'connect' && !opts.platform) { const i = s.picked.findIndex((p) => !isGood(verdictOf(p))); s.cur = Math.max(0, i); }

  const rail = h('ol', { class: 'ss-steps' });
  const eyebrow = h('div', { class: 'ss-eyebrow' });
  const title = h('h1', { id: 'ss-title' });
  const lead = h('p', { class: 'lead' });
  const body = h('div', { class: 'ss-body' });
  const next = h('div', { class: 'ss-next', 'aria-live': 'polite' });
  const foot = h('div', { class: 'ss-foot', 'data-tut': 'ss-foot' });
  const close = h('button', { class: 'ss-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => host.close() }, ic('x', 20));
  const ui = h('div', { class: 'ss', role: 'document' },
    h('aside', { class: 'ss-rail' },
      h('div', { class: 'ss-brand' }, brandMark('tile', 30), 'VTube Pro'),
      h('div', null, h('h2', null, 'Chat & stream'), h('p', null, 'Your chat and alerts, on stream.')),
      rail,
      h('div', { class: 'ss-rail-foot' }, ic('lock', 16), h('span', null, 'Read only. VTube Pro never posts in your chat. Keys stay on your computer.'))),
    h('section', { class: 'ss-main', 'aria-labelledby': 'ss-title' },
      h('div', { class: 'ss-head' }, eyebrow, title, lead, close),
      body, foot));
  root.replaceChildren(ui);

  let live: (() => void)[] = [];
  let raf = 0;
  let destroyed = false;
  const canvases: { cv: ChatCanvas; st: () => SceneChatState }[] = [];
  const feed = new ChatFeed();
  const off = host.onChange(() => { for (const f of live) try { f(); } catch (e) { console.warn('stream setup', e); } paintRail(); });
  const tick = window.setInterval(() => { for (const f of live) try { f(); } catch { /* */ } }, 1000);
  const loop = () => {
    if (destroyed) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    for (const c of canvases) c.cv.update(feed, c.st());
  };
  raf = requestAnimationFrame(loop);
  const syncFeed = () => feed.push([...host.events()].filter((e) => e.kind !== 'delete' && e.kind !== 'purge').slice(-40));

  function verdictOf(p: LivePlatform): Verdict {
    const v = verdict(p, host.status()?.platforms[p], host.events());
    // just saved: the server's status arrives a moment later; show "Connecting…" instead of "Not connected yet"
    if (v.light === 'off' && Date.now() - (s.savedAt[p] ?? 0) < 10000) return { light: 'connecting', title: `Connecting to ${PLATFORM_INFO[p].name}…`, line: 'This takes a few seconds.' };
    return v;
  }
  const name = (p: LivePlatform) => PLATFORM_INFO[p].name;
  const stepIx = () => steps.findIndex((x) => x.id === s.step);
  const saveMarks = (m: Marks) => { Object.assign(marks, m); host.setMarks({ ...marks }); };

  function btn(label: string | (string | Node)[], onClick: () => void, cls = '', attrs: Record<string, unknown> = {}) {
    return h('button', { class: `ss-btn ${cls}`.trim(), type: 'button', onClick, ...attrs }, ...(Array.isArray(label) ? label : [label]));
  }
  function seg<T extends string | number>(label: string, options: { v: T; label: string }[], value: T, onPick: (v: T) => void) {
    const box = h('div', { class: 'ss-seg', role: 'group', 'aria-label': label });
    const paint = (cur: T) => box.replaceChildren(...options.map((o) => h('button', { type: 'button', 'aria-pressed': String(o.v === cur), onClick: () => { onPick(o.v); paint(o.v); } }, o.label)));
    paint(value);
    return box;
  }
  function switchRow(label: string, on: boolean, onChange: (v: boolean) => void) {
    const inp = h('input', { type: 'checkbox', role: 'switch', checked: on, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
    return h('label', { class: 'ss-switch' }, inp, h('span', null, label));
  }
  const observerBanner = () => host.observer ? h('div', { class: 'ss-banner', role: 'note' }, ic('lock', 16), 'Observer sandbox: saving is off here. Nothing changes on your stream.') : null;
  const guestBanner = () => !host.canEdit() ? h('div', { class: 'ss-banner', role: 'note' }, 'You’re a guest in a party. The host decides what shows on stream.') : null;

  // ---------------------------------------------------------------- frame
  function paintRail() {
    const sum = setupSummary(host.status(), host.events(), marks);
    const doneOf: Record<string, boolean> = { platforms: sum.platforms.length > 0, connect: sum.platforms.length > 0 && sum.good.length === sum.platforms.length, alerts: !!marks.alerts, screen: !!marks.screen, done: sum.ready };
    rail.replaceChildren(...steps.map((st, i) => h('li', { class: `${st.id === s.step ? 'cur' : ''} ${doneOf[st.id] && st.id !== s.step ? 'done' : ''}`.trim() },
      h('button', { type: 'button', 'aria-current': st.id === s.step ? 'step' : null, onClick: () => go(st.id) },
        h('span', { class: 'n' }, doneOf[st.id] && st.id !== s.step ? ic('check', 14) : String(i + 1)), st.title))));
  }
  function frame(t: string, l: string) {
    const i = stepIx(), n = steps.length - 1;   // "Step x of 4": the last screen is the moment, not a step
    eyebrow.replaceChildren(h('i'), s.step === 'done' ? 'All set' : `Step ${i + 1} of ${n}`);
    title.textContent = t; lead.textContent = l;
  }
  function footer(primary: HTMLButtonElement | null, hint: string, extra: (Node | null)[] = []) {
    const i = stepIx();
    foot.replaceChildren(
      i > 0 && s.step !== 'done' ? btn([ic('back', 16), 'Back'], back, 'ghost') : h('span'),
      h('div', { class: 'ss-next' }, hint ? [h('b', null, 'Next'), h('span', null, hint)] : null),
      ...extra.filter((x): x is Node => !!x), ...(primary ? [primary] : []));
  }
  function go(step: StepId) {
    if (step === 'connect' && !s.picked.length) step = 'platforms';
    s.step = step; live = []; canvases.length = 0;
    body.classList.remove('in'); void body.offsetWidth; body.classList.add('in');
    body.scrollTop = 0;
    render();
    (foot.querySelector('.ss-btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
  }
  function back() {
    if (s.step === 'connect' && s.cur > 0) { s.cur--; render(); return; }
    const i = stepIx();
    if (i > 0) go(steps[i - 1].id);
  }
  function render() {
    live = []; canvases.length = 0;
    paintRail();
    if (s.step === 'platforms') stepPlatforms();
    else if (s.step === 'connect') stepConnect();
    else if (s.step === 'alerts') stepAlerts();
    else if (s.step === 'screen') stepScreen();
    else stepDone();
  }

  // ---------------------------------------------------------------- 1. platforms
  function stepPlatforms() {
    frame('Where do you stream?', 'Pick every place you go live. You can add more later.');
    const tiles = SETUP_PLATFORMS.map((p, i) => {
      const info = PLATFORM_INFO[p];
      const on = s.picked.includes(p);
      const v = verdictOf(p);
      const tile = h('button', { class: `ss-tile${on ? ' on' : ''}`, type: 'button', role: 'checkbox', 'aria-checked': String(on), style: `--pc:${info.color};--i:${i}`, 'data-platform': p,
        onClick: () => { s.picked = on ? s.picked.filter((x) => x !== p) : [...s.picked, p]; saveMarks({ picked: s.picked }); render(); } },
        plat(p, 34), h('b', null, info.name), h('span', { class: 'l' }, info.need),
        v.light !== 'off' ? h('span', { class: `ss-chip ${isGood(v) ? 'ok' : 'warn'}` }, isGood(v) ? 'Connected' : 'Needs a look') : null,
        h('span', { class: 'tick', 'aria-hidden': 'true' }, ic('check', 15)));
      return tile;
    });
    body.replaceChildren(...[observerBanner(), h('div', { class: 'ss-tiles', role: 'group', 'aria-label': 'Your platforms', 'data-tut': 'ss-platforms' }, ...tiles),
      h('p', { class: 'ss-note' }, 'VTube Pro only reads your chat. It never posts, and never needs your password.')].filter(Boolean) as HTMLElement[]);
    const n = s.picked.length;
    const primary = btn(n === 0 ? 'Pick a platform' : n === 1 ? `Connect ${name(s.picked[0])}` : `Connect ${n} platforms`, () => { s.cur = 0; go('connect'); }, 'primary');
    primary.disabled = n === 0;
    footer(primary, n ? `Connect ${n === 1 ? name(s.picked[0]) : 'each one'} and check your chat.` : 'Pick where you stream.', [btn('I’ll do this later', () => host.close(), 'ghost')]);
  }

  // ---------------------------------------------------------------- 2. connect
  function configValue(p: LivePlatform): string {
    if (!cfg) return '';
    if (p === 'twitch') return cfg.twitch.channel;
    if (p === 'kick') return cfg.kick.channel;
    if (p === 'youtube') return cfg.youtube.handle || cfg.youtube.channelId || cfg.youtube.videoId;
    if (p === 'tiktok') return cfg.tiktok.user;
    return '';
  }
  async function connect(p: LivePlatform) {
    if (host.observer) { s.err[p] = 'Observer sandbox: saving is off here.'; render(); return; }
    const raw = s.input[p] ?? configValue(p);
    const r = parseInput(p, raw);
    if (!r.ok) { s.err[p] = r.error; render(); (body.querySelector('input') as HTMLInputElement | null)?.focus(); return; }
    s.err[p] = ''; s.busy = p; render();
    try { cfg = await host.saveConfig(r.patch!); s.editing[p] = false; s.tested[p] = 0; s.savedAt[p] = Date.now(); s.input[p] = undefined; }
    catch (e) { s.err[p] = /local-only|VTube Pro on this computer/i.test(String((e as Error).message)) ? 'Add this in VTube Pro on your computer.' : 'That didn’t save. Is VTube Pro still running? Try again.'; }
    s.busy = null; render();
  }
  async function disconnect(p: LivePlatform) {
    if (host.observer) return;
    try { cfg = await host.saveConfig({ [p]: { enabled: false } }); } catch { /* the light stays as it is */ }
    s.picked = s.picked.filter((x) => x !== p); saveMarks({ picked: s.picked });
    s.cur = Math.min(s.cur, Math.max(0, s.picked.length - 1));
    if (!s.picked.length) go('platforms'); else render();
  }
  function stateBox(p: LivePlatform, hasInput = false) {
    const box = h('div', { class: 'ss-state', role: 'status', 'aria-live': 'polite' });
    let last = '';
    const paint = () => {
      const v = verdictOf(p);
      const key = `${v.light}|${v.title}|${v.line}`;
      if (key === last) return; last = key;
      box.className = `ss-state ${v.light}`;
      box.replaceChildren(h('div', { class: 'big' }, v.light === 'seen' || v.light === 'ok' || v.light === 'wait' ? ic('check', 22) : v.light === 'bad' ? ic('x', 20) : v.light === 'connecting' ? null : plat(p, 22)),
        h('div', null, h('b', null, v.title), h('span', null, v.line),
          v.light === 'bad' && v.fix ? h('div', { class: 'ss-row' },
            v.fix === 'retype' && !hasInput ? btn('Change the name', () => { s.editing[p] = true; render(); }, 'small') : null,
            v.fix === 'key' ? btn([ic('ext', 15), 'Paste it again'], () => { s.editing[p] = true; render(); }, 'small') : null,
            v.fix === 'app' ? btn([ic('ext', 15), 'Get TikFinity'], () => window.open(PLATFORM_INFO.tiktok.findIt!.url, '_blank', 'noopener'), 'small') : null,
            btn('Try again', () => void connect(p), 'small')) : null));
      paintTabs();
    };
    paint(); live.push(paint);
    return box;
  }
  let paintTabs = () => {};
  function feedBox(p: LivePlatform) {
    const list = h('div', { class: 'ss-feed-list', 'aria-live': 'polite', 'aria-label': `Your ${name(p)} chat` });
    const foot2 = h('div', { class: 'ss-feed-f' });
    const box = h('div', { class: 'ss-feed' },
      h('div', { class: 'ss-feed-h' }, h('span', { class: 'live' }), `Your ${name(p)} chat`, h('span', { style: 'margin-left:auto' }, plat(p, 18))), list, foot2);
    let lastKey = '';
    const paint = () => {
      const evs = allEvents().filter((e) => e.platform === p && (e.kind === 'chat' || e.kind === 'system' || e.kind === 'finance')).slice(-6);
      const v = verdictOf(p);
      const key = `${evs.map((e) => e.id).join(',')}|${v.light}`;
      if (key === lastKey) return; lastKey = key;
      if (!evs.length) {
        const waitText = v.light === 'off' ? `Connect ${name(p)} to see your chat here.` : v.light === 'bad' ? 'Fix the problem on the left first.' : PLATFORM_INFO[p].liveOnly ? `Go live on ${name(p)}, then say hi in your chat.` : `Say hi in your ${name(p)} chat.`;
        list.replaceChildren(h('div', { class: 'ss-empty' }, v.light === 'off' || v.light === 'bad' ? ic('chat', 28) : h('div', { class: 'dots' }, h('i'), h('i'), h('i')), h('div', null, waitText)));
      } else list.replaceChildren(...evs.map((e) => h('div', { class: `ss-msg${e.test ? '' : ' real'}` }, plat(p, 18),
        h('div', null, h('span', { class: 'u', style: `color:${e.color ?? PLATFORM_INFO[p].color}` }, e.user), h('span', { class: 't' }, e.kind === 'finance' ? `${e.label ?? 'Support'} ${e.display ?? ''} · ${e.text}` : e.text), e.test ? h('span', { class: 'tag' }, 'TEST') : null))));
      const seen = seenReal(p, host.events());
      foot2.replaceChildren(h('span', null, seen ? 'Real messages are coming in.' : 'Only you see test messages.'),
        btn([ic('send', 15), 'Send a test message'], async () => {
          if (host.observer) { localEvents.push(...testChatEvents('chat').map((e) => ({ ...e, platform: p }))); paint(); return; }
          s.tested[p] = Date.now();
          try { await host.sendTest('chat', p); } catch { /* the box simply stays empty */ }
        }, 'small', { disabled: v.light === 'off' && !host.observer }));
    };
    paint(); live.push(paint);
    return box;
  }
  function stepConnectFooter() {
    const p = s.picked[s.cur];
    if (!p) return;
    const v = verdictOf(p);
    const more = s.cur < s.picked.length - 1;
    const needsInput = !isGood(v) && (v.light === 'off' || s.editing[p] || v.fix === 'retype');
    let primary: HTMLButtonElement;
    if (isGood(v) && !s.editing[p]) {
      primary = btn(more ? [`Next: ${name(s.picked[s.cur + 1])}`, ic('arrow', 18)] : ['Set up alerts', ic('arrow', 18)], () => { if (more) { s.cur++; render(); } else go('alerts'); }, 'primary');
      primary.dataset.mode = 'next';
    } else {
      primary = btn(s.busy === p ? 'Connecting…' : p === 'tiktok' ? 'Find TikFinity' : `Connect ${name(p)}`, () => void connect(p), 'primary');
      primary.disabled = s.busy === p || (!needsInput && v.light === 'connecting');
      primary.dataset.mode = 'connect';
    }
    footer(primary, isGood(v) ? (more ? `Connect ${name(s.picked[s.cur + 1])}.` : 'Try an alert and pick which ones show.') : PLATFORM_INFO[p].ask === 'key' ? 'Add your Rumble link.' : `Connect ${name(p)}.`,
      [!isGood(v) ? btn(more ? 'Skip for now' : 'Skip to alerts', () => { if (more) { s.cur++; render(); } else go('alerts'); }, 'ghost') : null]);
  }
  function stepConnect() {
    const p = s.picked[s.cur];
    if (!p) { go('platforms'); return; }
    const info = PLATFORM_INFO[p];
    const v = verdictOf(p);
    frame(s.picked.length > 1 ? `Connect ${info.name} · ${s.cur + 1} of ${s.picked.length}` : `Connect ${info.name}`,
      info.ask === 'app' ? 'TikTok needs one free app on your computer. Then it’s automatic.' : info.ask === 'key' ? 'Rumble gives you a private link for your chat. Paste it once.' : 'Type it once. We check that your chat comes through.');
    // platform pills (each one's live light)
    const tabs = h('div', { class: 'ss-ptabs', role: 'tablist', 'aria-label': 'Your platforms' });
    paintTabs = () => tabs.replaceChildren(...s.picked.map((q, i) => h('button', { class: `ss-ptab${i === s.cur ? ' cur' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(i === s.cur), onClick: () => { s.cur = i; render(); } },
      plat(q, 20), name(q), h('span', { class: `lt ss-lt-${verdictOf(q).light}`, 'aria-label': verdictOf(q).title }))));
    paintTabs();
    const card = h('div', { class: 'ss-card' }, h('h3', null, plat(p, 32), info.name));
    const showInput = v.light === 'off' || !!s.editing[p] || (v.light === 'bad' && (v.fix === 'retype' || v.fix === 'key'));
    if (showInput) {
      const inp = h('input', { id: `ss-in-${p}`, type: info.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: false, placeholder: info.placeholder,
        value: s.input[p] ?? (info.secret ? '' : configValue(p)), class: s.err[p] ? 'bad' : '', 'aria-invalid': s.err[p] ? 'true' : 'false', 'aria-describedby': `ss-hint-${p}`,
        onInput: (e: Event) => { s.input[p] = (e.target as HTMLInputElement).value; if (s.err[p]) { s.err[p] = ''; (e.target as HTMLElement).classList.remove('bad'); errEl.textContent = ''; } },
        onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void connect(p); } } }) as HTMLInputElement;
      const errEl = h('div', { class: 'err', role: 'alert' }, s.err[p] ?? '');
      if (info.ask === 'app') card.append(h('ol', { class: 'ss-steps-ol' },
        h('li', null, 'Get TikFinity and open it. It’s free.'), h('li', null, 'Connect TikFinity to your TikTok.'), h('li', null, 'Press ', h('b', null, 'Find TikFinity'), ' below.')));
      if (info.ask === 'key') card.append(h('ol', { class: 'ss-steps-ol' }, h('li', null, 'Open Rumble’s Live Stream page and sign in.'), h('li', null, 'Copy the whole link it shows you.'), h('li', null, 'Paste it here.')));
      card.append(h('div', { class: 'ss-field' }, h('label', { for: `ss-in-${p}` }, info.label), inp, h('div', { class: 'hint', id: `ss-hint-${p}` }, info.hint), errEl));
      if (info.findIt) card.append(h('div', { class: 'ss-row' }, h('button', { class: 'ss-link', type: 'button', onClick: () => window.open(info.findIt!.url, '_blank', 'noopener') }, ic('ext', 15), info.findIt.label)));
      queueMicrotask(() => { if (inp.isConnected && !info.secret) inp.focus({ preventScroll: true }); });
    }
    if (!showInput || v.light !== 'off') card.append(stateBox(p, showInput));
    if (!showInput && v.light !== 'off') {
      const shown = configValue(p);
      card.append(h('div', { class: 'ss-row' },
        shown ? h('span', { class: 'ss-chip' }, p === 'twitch' ? `twitch.tv/${shown}` : p === 'kick' ? `kick.com/${shown}` : p === 'tiktok' ? `@${shown.replace(/^@/, '')}` : shown) : null,
        p === 'rumble' ? h('span', { class: 'ss-chip' }, ic('lock', 13), 'Link saved on your computer') : null,
        info.ask !== 'app' ? h('button', { class: 'ss-link', type: 'button', onClick: () => { s.editing[p] = true; render(); } }, p === 'rumble' ? 'Change the link' : 'Change') : null,
        h('button', { class: 'ss-link', type: 'button', style: 'color:var(--mute)', onClick: () => void disconnect(p) }, 'Disconnect')));
    }
    body.replaceChildren(...[observerBanner(), tabs, h('div', { class: 'ss-split' }, card, feedBox(p))].filter(Boolean) as HTMLElement[]);
    stepConnectFooter();
    // the whole card follows the light's group (typing → connecting → connected / a problem), never while typing
    const group = (l: string) => (l === 'seen' || l === 'ok' || l === 'wait' ? 'good' : l);
    const drawn = group(v.light);
    live.push(() => { const now = group(verdictOf(p).light); if (now !== drawn && !(document.activeElement?.tagName === 'INPUT' && (document.activeElement as HTMLInputElement).value)) render(); });
  }

  // ---------------------------------------------------------------- 3. alerts
  function stepAlerts() {
    frame('Your alerts', 'Viewers see a big card when someone supports you. Try each one.');
    const plats = s.picked.length ? s.picked : enabledOf(cfg);
    const st = () => ({ ...host.chatState(), panel: 'panel' as const });
    const board = new ChatCanvas('board', 800, 450);
    const line = new ChatCanvas('monitor', 800, 450);   // follows are a line in the chat, not a big card
    const frameBox = h('div', { class: 'ss-preview' });
    const showCanvas = (which: 'board' | 'line') => {
      canvases.length = 0;
      const cv = which === 'board' ? board : line;
      canvases.push({ cv, st: which === 'board' ? st : () => ({ ...host.chatState(), panel: 'off' }) });
      frameBox.replaceChildren(cv.canvas, h('span', { class: 'cap' }, h('i'), which === 'board' ? 'What viewers see' : 'In your chat'));
    };
    showCanvas('board');
    syncFeed();
    const where = h('div', { class: 'ss-where' });
    const paintWhere = () => {
      const c = host.chatState(), room = host.inRoom();
      where.replaceChildren(
        h('div', null, ic('room', 16), h('span', null, h('b', null, room ? 'In your room: ' : 'In a 3D room: '), c.panel === 'off' ? 'off. Pick Support board above.' : c.panel === 'monitor' ? 'on the chat screen.' : 'on a glowing support board.')),
        h('div', null, ic('side', 16), h('span', null, h('b', null, 'Beside your game: '), 'a support panel next to what you share.')),
        h('div', null, ic('hub', 16), h('span', null, h('b', null, 'Chat Hub: '), 'every alert waits there until you thank them.')));
    };
    paintWhere(); live.push(paintWhere);
    const rows = ALERT_KINDS.map((k) => {
      const who = alertWho(k, plats);
      const row = h('div', { class: `ss-alert${s.alert === k ? ' cur' : ''}${who.any ? '' : ' off'}`, 'data-alert': k },
        h('div', { class: 'ai' }, ic(k, 22)),
        h('div', null, h('b', null, ALERT_INFO[k].title), h('span', { class: 'l' }, ALERT_INFO[k].line), who.line ? h('span', { class: 'w' }, who.line) : null),
        btn([ic('play', 14), 'Try it'], () => void tryAlert(k), 'small'));
      return row;
    });
    async function tryAlert(k: AlertKind) {
      s.alert = k; saveMarks({ alerts: true });
      for (const r of body.querySelectorAll('.ss-alert')) r.classList.toggle('cur', (r as HTMLElement).dataset.alert === k);
      const what = alertTest(k, plats);
      const evs = testChatEvents(what);
      feed.push(evs);
      const e = evs[0];
      if (e && e.kind === 'finance') { board.alert = { e, at: Date.now() }; showCanvas('board'); }
      else showCanvas('line');
      paintRail();
      if (!host.observer) try { await host.sendTest(what); } catch { /* the preview here still shows it */ }
    }
    const c = host.chatState();
    const left = h('div', null,
      h('div', { class: 'ss-alerts', 'data-tut': 'ss-alerts' }, ...rows),
      h('div', { class: 'ss-sub' }, 'Big alerts for tips'),
      seg('Big alerts for tips', MIN_ALERT_CHOICES, MIN_ALERT_CHOICES.some((m) => m.v === c.minAlert) ? c.minAlert : 0, (v) => { host.setChat({ minAlert: v }); }),
      switchRow('Big alerts for new subs and members', c.alertSubs, (v) => host.setChat({ alertSubs: v })));
    const right = h('div', null,
      frameBox,
      h('div', { class: 'ss-sub' }, 'Where alerts show'),
      seg('Where alerts show in a room', [{ v: 'panel', label: 'Support board' }, { v: 'monitor', label: 'On the chat screen' }, { v: 'off', label: 'Off' }], c.panel, (v) => { host.setChat({ panel: v as SceneChatState['panel'] }); paintWhere(); }),
      where,
      h('p', { class: 'ss-note' }, 'Tests show only on your computer and your OBS. They never reach your real chat.'));
    body.replaceChildren(...[observerBanner(), guestBanner(), h('div', { class: 'ss-split' }, left, right)].filter(Boolean) as HTMLElement[]);
    // show one alert straight away so the preview isn't empty
    if (!s.alert) { const e = testChatEvents(alertTest('tip', plats))[0]; feed.push([e]); board.alert = { e, at: Date.now() - 600 }; }
    footer(btn(['Next: chat on screen', ic('arrow', 18)], () => { saveMarks({ alerts: true }); go('screen'); }, 'primary'), 'Pick where viewers see your chat.');
  }

  // ---------------------------------------------------------------- 4. chat on screen
  let lib: BuddyAvatar[] | null = null;
  function stepScreen() {
    frame('Chat on screen', 'Pick where viewers see your chat. The preview shows the real thing.');
    const c0 = host.chatState();
    let spot: ScreenSpot = spotOf(c0, host.dockChat());
    syncFeed();
    if (feed.events.length < 3) feed.push(sampleEvents(s.picked.length ? s.picked : SETUP_PLATFORMS));
    const monitor = new ChatCanvas('monitor', 600, 800);
    const tablet = new ChatCanvas('tablet', 640, 480);
    const prev = h('div', { class: 'ss-preview' });
    const paintPrev = () => {
      canvases.length = 0;
      if (spot === 'none') { prev.replaceChildren(h('div', { class: 'ss-empty', style: 'min-height:320px' }, ic('none', 30), h('div', null, 'Viewers won’t see chat. You still see it in the Chat Hub.'))); return; }
      const cv = spot === 'buddy' ? tablet : monitor;
      canvases.push({ cv, st: () => ({ ...host.chatState(), panel: 'off' }) });
      const wrap = spot === 'monitor' ? h('div', { style: 'max-width:300px;margin:18px auto' }, cv.canvas) : spot === 'side' ? h('div', { style: 'max-width:240px;margin:18px 18px 18px auto' }, cv.canvas) : h('div', { style: 'max-width:340px;margin:18px auto' }, cv.canvas);
      prev.replaceChildren(wrap, h('span', { class: 'cap' }, h('i'), spot === 'buddy' ? 'On the tablet' : spot === 'side' ? 'Beside your game' : 'In your room'));
    };
    const setSpot = (v: ScreenSpot) => {
      spot = v; saveMarks({ screen: true });
      if (v === 'monitor') { host.setChat({ monitor: true, buddy: false }); if (host.dockChat() === 'off') host.setDockChat('auto'); }
      else if (v === 'buddy') { host.setChat({ buddy: true, monitor: false }); if (host.dockChat() === 'off') host.setDockChat('auto'); }
      else if (v === 'side') { host.setChat({ monitor: false, buddy: false }); host.setDockChat('always'); }
      else { host.setChat({ monitor: false, buddy: false }); host.setDockChat('off'); }
      paintSpots(); paintOpts(); paintPrev(); paintRail();
    };
    const spots = h('div', { class: 'ss-spots', role: 'radiogroup', 'aria-label': 'Where viewers see your chat', 'data-tut': 'ss-spots' });
    const paintSpots = () => spots.replaceChildren(...SPOTS.map((x) => h('button', { class: 'ss-spot', type: 'button', role: 'radio', 'aria-checked': String(x.id === spot), 'data-spot': x.id, disabled: !host.canEdit(), onClick: () => setSpot(x.id) },
      h('div', { class: 'si' }, ic(x.id, 20)), h('div', null, h('b', null, x.title), h('span', null, x.line), x.needsRoom && !host.inRoom() ? h('span', { class: 'ss-chip warn' }, 'Shows when you’re in a room') : null))));
    const opts2 = h('div');
    let placeEl: HTMLElement | null = null;   // (built once: it keeps its own drag state)
    const paintOpts = () => {
      const c = host.chatState();
      const kids: (Node | null)[] = [];
      if (spot !== 'none') {
        kids.push(h('div', { class: 'ss-sub' }, 'Size'), seg('Size', SIZE_CHOICES.map((z) => ({ v: z.id as string, label: z.label })), sizeOf(c), (v) => {
          const z = SIZE_CHOICES.find((q) => q.id === v)!;
          host.setChat(spot === 'buddy' ? { tablet: z.tablet, tabletText: z.font } : { size: z.size, font: z.font });
        }));
      }
      if (spot === 'monitor') kids.push(h('div', { class: 'ss-sub' }, 'Which side'), seg('Which side', [{ v: 'left', label: 'Left' }, { v: 'auto', label: 'Best spot' }, { v: 'right', label: 'Right' }], c.side, (v) => host.setChat({ side: v as SceneChatState['side'] })));
      if (spot === 'buddy') kids.push(h('div', { class: 'ss-sub' }, 'Who brings the chat?'), buddyGrid());
      // beta.12: "Beside your game" = the chat box on the stream: say where it sits and how big (the Chat area's control)
      if (spot === 'side' && host.chatBoxPlace) { placeEl ??= host.chatBoxPlace(); kids.push(h('div', { class: 'ss-sub' }, 'Where on the stream'), placeEl); }
      if (spot !== 'none') kids.push(switchRow('Hide bots and !commands', c.hideBots && c.hideCommands, (v) => host.setChat({ hideBots: v, hideCommands: v })));
      opts2.replaceChildren(...kids.filter((x): x is Node => !!x));
    };
    const buddyGrid = () => {
      const grid = h('div', { class: 'ss-buddies', role: 'group', 'aria-label': 'Who brings the chat?' });
      const paint = () => {
        if (!lib) { grid.replaceChildren(h('p', { class: 'ss-note' }, 'Loading your avatars…')); return; }
        const cur = host.chatState().buddyModel;
        grid.replaceChildren(...buddyChoices(lib, cur).filter((x) => !x.missing).map((x) => h('button', { class: 'ss-buddy', type: 'button', 'aria-pressed': String(x.id === cur), title: `${x.name} brings the chat`, onClick: () => { host.setChat({ buddyModel: x.id }); paint(); } },
          h('div', { class: 'img', style: x.item?.thumb ? `background-image:url("${x.item.thumb.replace(/"/g, '%22')}")` : '' }, x.item?.thumb ? null : ic('buddy', 26)),
          x.id === cur ? h('span', { class: 'ck' }, ic('check', 13)) : null,
          h('span', null, x.name, x.isDefault ? h('small', null, 'Default') : null))));
      };
      paint();
      if (!lib) void host.avatars().then((l) => { lib = l; paint(); }).catch(() => { lib = []; paint(); });
      return grid;
    };
    paintSpots(); paintOpts(); paintPrev();
    body.replaceChildren(...[observerBanner(), guestBanner(), h('div', { class: 'ss-split' }, h('div', null, spots, opts2), h('div', null, prev,
      h('p', { class: 'ss-note' }, 'Your OBS shows the same. Change it any time in the Chat area.')))].filter(Boolean) as HTMLElement[]);
    footer(btn(['Finish', ic('arrow', 18)], () => { saveMarks({ screen: true }); go('done'); }, 'primary'), 'You’re ready to go live.');
  }

  // ---------------------------------------------------------------- 5. done
  function stepDone() {
    const sum = setupSummary(host.status(), host.events(), marks);
    const plats = sum.platforms;
    frame(plats.length && sum.good.length === plats.length ? 'You’re ready ✔' : 'Almost ready', plats.length ? 'Your chat and alerts are set. Everything is saved on your computer.' : 'Connect a platform any time to bring your chat in.');
    const rows: HTMLElement[] = plats.map((p) => {
      const v = verdictOf(p);
      return h('div', { class: 'r' }, plat(p, 28), h('div', null, h('b', null, name(p)), h('span', null, v.light === 'seen' ? 'I can see your chat.' : v.light === 'wait' ? 'Your chat shows up when you go live.' : v.light === 'ok' ? 'Connected.' : v.title)),
        isGood(v) ? h('span', { class: 'ss-chip ok' }, ic('check', 13), 'Ready') : btn('Fix it', () => { s.cur = Math.max(0, s.picked.indexOf(p)); if (!s.picked.includes(p)) { s.picked.push(p); s.cur = s.picked.length - 1; } go('connect'); }, 'small'));
    });
    const c = host.chatState();
    const spot = SPOTS.find((x) => x.id === spotOf(c, host.dockChat()))!;
    rows.push(h('div', { class: 'r' }, h('div', { class: 'i' }, ic('tip', 24)), h('div', null, h('b', null, 'Alerts'), h('span', null, c.panel === 'off' ? 'In the Chat Hub. Turn on the support board to show them in your room.' : `${c.panel === 'monitor' ? 'On the chat screen' : 'On the support board'}, and in the Chat Hub.`)),
      btn('Change', () => go('alerts'), 'small ghost')));
    rows.push(h('div', { class: 'r' }, h('div', { class: 'i' }, ic(spot.id, 24)), h('div', null, h('b', null, 'Chat on screen'), h('span', null, spot.title + '.')), btn('Change', () => go('screen'), 'small ghost')));
    if (!TITLE_SUPPORTED) rows.push(h('div', { class: 'r', style: 'opacity:.85' }, h('div', { class: 'i', style: 'color:var(--dim)' }, ic('clock', 22)), h('div', null, h('b', null, 'Stream title & category'), h('span', null, 'Set them on your platform for now.')),
      h('span', { class: 'ss-chip soon' }, ic('clock', 13), 'Coming soon')));
    body.replaceChildren(h('div', { class: 'ss-done' },
      h('div', { class: 'ss-done-hero' }, h('div', { class: 'big' }, ic('check', 34)), h('div', null, h('b', { style: 'font:700 20px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif;display:block' }, plats.length ? 'Your chat is on stream' : 'Nothing connected yet'),
        h('span', { style: 'color:var(--mute)' }, 'It reconnects by itself every time you go live.'))),
      h('div', { class: 'ss-sum' }, ...rows)));
    footer(btn('Back to the studio', () => host.close(), 'primary'), 'Open the Chat Hub to see every message.', [btn([ic('hub', 16), 'Open Chat Hub'], () => { host.openChatHub(); host.close(); })]);
  }

  // ---------------------------------------------------------------- start
  void host.getConfig().then((c) => {
    cfg = c;
    const on = enabledOf(c);
    const add = on.filter((p) => !s.picked.includes(p));
    if (add.length) s.picked.push(...add);
    if (!destroyed && (s.step === 'connect' || s.step === 'platforms' || s.step === 'done')) render();
  }).catch(() => { /* status still works; the inputs start empty */ });
  render();

  return {
    destroy() { destroyed = true; off(); window.clearInterval(tick); cancelAnimationFrame(raf); live = []; canvases.length = 0; },
    go: (st: StepId) => go(st),
    get step() { return s.step; },
  };
}

/** The default chat state (for hosts without a scene yet). */
export const defaultChatState = (): SceneChatState => ({ ...DEFAULT_CHAT_STATE, goal: { ...DEFAULT_CHAT_STATE.goal }, bots: [] });

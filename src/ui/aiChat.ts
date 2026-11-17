// "Ask your AI": a small chat in the studio that runs THROUGH the VTube Pro Helper (POST /api/ai/chat). The helper talks
// to the model running on this PC; this page only sees the conversation. Approvals (Blender, live changes)
// are answered in the helper on the PC, never here.
// Two ways to show it: the dialog (openAiChat, Home → Chat & donations, Create's "Ask your AI") and the panel built
// into Create's "I don't have an AI app" path (chatPanel, lane create-connect). Both share one conversation view.
// No sound. Lane ai-connect.
import { aiApi, chatCapable, helperOrigin, openHelperAi, type AiConnectorInfo, type AiEvent } from '../net/aiHelper.ts';
import { button, h } from './dom.ts';

const CSS = `
.aic-back{position:fixed;inset:0;background:rgb(5 7 11/.7);z-index:1200;display:grid;place-items:center;padding:16px}
.aic{width:min(640px,100%);max-height:min(760px,100%);display:flex;flex-direction:column;background:var(--panel,#11171b);color:var(--text,#eef3ef);
  border:1px solid var(--line,rgb(255 255 255/.08));border-radius:18px;box-shadow:0 30px 80px -30px #000;overflow:hidden;font:14px/1.5 var(--font-ui,system-ui,sans-serif)}
.aic-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line,rgb(255 255 255/.08))}
.aic-head b{font:700 19px/1.2 var(--font-display,inherit);letter-spacing:-.01em;flex:1}
.aic-x{width:34px;height:34px;border-radius:10px;border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer}
.aic-body{flex:1;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:8px;min-height:180px}
.aic-msg{padding:9px 12px;border-radius:12px;background:var(--card2,rgb(255 255 255/.05));white-space:pre-wrap;word-break:break-word;max-width:92%}
.aic-msg.me{align-self:flex-end;background:color-mix(in srgb,var(--accent,#7bd88f) 18%,transparent)}
.aic-msg.tool{font-size:12.5px;color:var(--dim,#9aa6a0);background:transparent;padding:2px 4px}
.aic-msg.err{border:1px solid rgb(255 107 107/.5);color:#ffb3b3}
.aic-msg.wait{border:1px solid rgb(255 207 106/.45)}
.aic-msg img{display:block;max-width:240px;border-radius:8px;margin-top:6px}
.aic-foot{padding:12px 18px 16px;border-top:1px solid var(--line,rgb(255 255 255/.08));display:flex;flex-direction:column;gap:8px}
.aic-foot textarea{width:100%;min-height:64px;resize:vertical;border-radius:12px;padding:10px 12px;font:inherit;background:var(--bg,#0b0f12);color:inherit;border:1px solid var(--line2,rgb(255 255 255/.14))}
.aic-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.aic-row .sp{flex:1}
.aic-note{font-size:12.5px;color:var(--dim,#9aa6a0)}
.aic-empty{text-align:center;padding:26px 10px}.aic-empty p{color:var(--dim,#9aa6a0);margin:6px auto 14px;max-width:440px}
.aic-pills{display:flex;gap:6px;flex-wrap:wrap}
.aic-pill{border-radius:999px;border:1px solid var(--line,rgb(255 255 255/.12));background:transparent;color:var(--dim,#9aa6a0);padding:6px 11px;font:inherit;font-size:12.5px;cursor:pointer}
.aic-pill[aria-pressed=true]{color:var(--accent,#7bd88f);border-color:var(--accent,#7bd88f);background:color-mix(in srgb,var(--accent,#7bd88f) 12%,transparent)}
.aic-pill:disabled{opacity:.6;cursor:default}
.aic-panel{display:flex;flex-direction:column;border:1px solid var(--line,rgb(255 255 255/.1));border-radius:14px;overflow:hidden;background:var(--bg,#0e1015)}
.aic-panel .aic-body{max-height:340px;min-height:150px}
.aic-panel .aic-foot{border-top:1px solid var(--line,rgb(255 255 255/.08))}
@media (max-width:640px){.aic-panel .aic-body{max-height:260px}}
`;
const css = () => { if (!document.getElementById('vtp-aichat-css')) document.head.append(h('style', { id: 'vtp-aichat-css' }, CSS)); };

/** One conversation (messages + input + which AI), ready to put in a dialog or a panel. */
function conversation(usable: AiConnectorInfo[], o: { hello: string; placeholder: string }) {
  const body = h('div', { class: 'aic-body', 'aria-live': 'polite' });
  const foot = h('div', { class: 'aic-foot' });
  let alive = true;
  const say = (text: string, cls = '') => { const m = h('div', { class: `aic-msg ${cls}` }, text); body.append(m); body.scrollTop = body.scrollHeight; return m; };
  say(o.hello);
  // which AI: plain pills (no raw <select> on a main path, VOICE.md); one AI = no picker at all
  let pick = usable[0]?.id ?? '';
  const pillsEl = h('div', { class: 'aic-pills', role: 'group', 'aria-label': 'Which AI answers' });
  const paintPills = () => pillsEl.replaceChildren(...usable.map((c) => h('button', { class: 'aic-pill', type: 'button', 'aria-pressed': String(c.id === pick), disabled: send.disabled && c.id !== pick,
    onClick: () => { if (pick === c.id) return; pick = c.id; session = undefined; since = 0; paintPills(); say(`Now talking to ${c.name}${c.model ? ` · ${c.model}` : ''}.`, 'tool'); } }, `${c.name}${c.model ? ` · ${c.model}` : ''}`)));
  const ta = h('textarea', { placeholder: o.placeholder, 'aria-label': 'Your message' }) as HTMLTextAreaElement;
  const send = button('Send', () => void go(), 'primary');
  paintPills();
  foot.append(ta, h('div', { class: 'aic-row' }, usable.length > 1 ? pillsEl : null, h('span', { class: 'sp' }), button('AI settings', () => openHelperAi(pick), 'ghost'), send),
    h('div', { class: 'aic-note' }, 'This AI runs on your computer: nothing leaves it. Ctrl+Enter sends.'));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go(); } });

  let session: string | undefined;
  let since = 0;
  const show = (ev: AiEvent) => {
    if (ev.kind === 'user' || ev.kind === 'usage' || ev.kind === 'done') return;
    if (ev.kind === 'assistant') say(ev.text ?? '');
    else if (ev.kind === 'tool') say(`Using ${ev.tool}…`, 'tool');
    else if (ev.kind === 'result') return;
    else if (ev.kind === 'image' && ev.image?.startsWith('data:image/')) { const m = say('', ''); m.append(h('img', { src: ev.image, alt: 'Preview from your AI' })); }
    else if (ev.kind === 'waiting') {
      const m = say('Waiting for your OK in VTube Pro on your computer.', 'wait');
      m.append(h('div', { class: 'aic-row', style: 'margin-top:6px' }, button('Open VTube Pro', () => { window.open(`${helperOrigin()}/aiconnect`, '_blank', 'noopener'); }, 'primary')));
    } else if (ev.kind === 'error') {
      const m = say(ev.text ?? 'Something went wrong.', 'err');
      m.append(h('div', { class: 'aic-row', style: 'margin-top:6px' }, button('Check my AI', () => openHelperAi(pick), 'ghost')));
    }
  };
  const busy = (on: boolean) => { send.disabled = on; paintPills(); };
  const poll = async () => {
    if (!alive || !session) return;
    try {
      const r = await aiApi.poll(session, since);
      since = r.next; r.events.forEach(show);
      if (r.busy) setTimeout(() => void poll(), 1200); else busy(false);
    } catch (e) { say((e as Error).message, 'err'); busy(false); }
  };
  async function go() {
    const text = ta.value.trim();
    if (!text || send.disabled || !pick) return;
    say(text, 'me'); ta.value = '';
    busy(true);
    try { const r = await aiApi.chat(pick, text, session); session = r.sessionId; void poll(); }
    catch (e) {
      busy(false);
      const m = say((e as Error).message, 'err');
      m.append(h('div', { class: 'aic-row', style: 'margin-top:6px' }, button('Try again', () => { ta.value = text; void go(); }, ''), button('Check my AI', () => openHelperAi(pick), 'ghost')));
    }
  }
  return { body, foot, ta, ids: usable.map((c) => c.id).join(','), started: () => !!session, stop: () => { alive = false; }, fill: (t: string) => { ta.value = t; ta.focus(); } };
}

const HELLO = 'Hi! Ask me to build or fix a room, check your avatar, or explain a setting. I follow VTube Pro’s guides and check my work. Anything that changes your stream or runs Blender waits for your OK in VTube Pro.';

let open: HTMLElement | null = null;
export async function openAiChat() {
  if (open) return;
  css();
  const body = h('div', { class: 'aic-body', 'aria-live': 'polite' });
  const close = () => { conv?.stop(); back.remove(); open = null; removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
  const box = h('div', { class: 'aic' }, h('div', { class: 'aic-head' }, h('b', null, 'Ask your AI'), h('button', { class: 'aic-x', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => close() }, '✕')), body);
  const back = h('div', { class: 'aic-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ask your AI' }, box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  addEventListener('keydown', onKey);
  document.body.append(back);
  open = back;
  let conv: ReturnType<typeof conversation> | null = null;

  body.append(h('div', { class: 'aic-note' }, 'Checking your AI connections…'));
  let list: AiConnectorInfo[] = [];
  try { list = await aiApi.connectors(); } catch (e) {
    body.replaceChildren(h('div', { class: 'aic-empty' }, h('b', null, 'VTube Pro is needed for AI'),
      h('p', null, 'AI runs through VTube Pro on your computer. Open VTube Pro, then try again.'),
      h('div', { class: 'aic-row', style: 'justify-content:center' }, button('Set up AI in VTube Pro', () => openHelperAi(), 'primary'), button('Close', close, 'ghost')),
      h('p', { class: 'aic-note' }, (e as Error).message)));
    return;
  }
  const usable = list.filter(chatCapable);
  if (!usable.length) {
    body.replaceChildren(h('div', { class: 'aic-empty' }, h('b', null, 'No AI is connected yet'),
      h('p', null, 'Add a free model on your computer in VTube Pro. The Claude, ChatGPT and Grok apps chat in their own app.'),
      h('div', { class: 'aic-row', style: 'justify-content:center' }, button('Connect an AI', () => openHelperAi(), 'primary'), button('Close', close, 'ghost'))));
    return;
  }
  conv = conversation(usable, { hello: HELLO, placeholder: 'e.g. "Check my room and add two more seats if it needs them."' });
  body.replaceWith(conv.body);
  box.append(conv.foot);
  setTimeout(() => conv!.ta.focus(), 30);
}

// ---------------------------------------------------------------- the panel inside Create (lane create-connect)
let panel: { el: HTMLElement; conv: ReturnType<typeof conversation> } | null = null;
/**
 * The chat as a panel (Create → "I don't have an AI app"). The SAME element is returned on every call while the AIs on offer
 * stay the same, so the conversation survives the Create area's re-renders (the caller re-attaches it).
 */
export function chatPanel(list: AiConnectorInfo[]): HTMLElement | null {
  css();
  const usable = list.filter(chatCapable);
  if (!usable.length) return null;
  const ids = usable.map((c) => c.id).join(',');
  if (panel && (panel.conv.ids === ids || panel.conv.started())) return panel.el;
  panel?.conv.stop();
  const conv = conversation(usable, { hello: 'Hi! Tell me what to make, like “Make me a cozy cabin room for VTube Pro.” Big changes wait for your OK in VTube Pro.', placeholder: 'What should your AI make?' });
  panel = { el: h('div', { class: 'aic-panel', 'data-aichat': '1' }, conv.body, conv.foot), conv };
  return panel.el;
}
/** Put words in the panel's box (the "Try this" buttons). */
export const fillChat = (text: string) => panel?.conv.fill(text);

// invite-experience: the studio's "Invite someone" moment. One sheet, one obvious action: the link is already copied
// when it opens (big "Copied ✓"), with Copy again / Share, the plain facts (until when, how many, you let them in), the
// one-line "post it in Discord" helper (paste it in any channel; your own bot posts the card when you set one up), and the
// quieter New link / Turn off.
// Pure UI: no App / network imports (guestLink.ts wires it), so it can be rendered on its own. Brand: T\portal\BRAND.md.
// QR code for a phone guest: src/ui/inviteQr.ts (vendored qrcode-generator, MIT), level H, V tile in the centre,
// 4 CSS px per module so every invite length stays scannable (tools/invite_qr_unit.ts decodes it with OpenCV).
// Every link expires (owner): "Link works for 10 min / 30 min / 1 hour" (relay/src/inviteExpiry.ts; the relay enforces
// it), a live "Expires in 24 min" chip, and when it runs out (or is turned off) the sheet says so and offers
// "Make a new link" as the one big button.
import { qrSvg } from './inviteQr.ts';
import { INVITE_CHOICES, INVITE_DEFAULT_MINUTES, choiceLabel, expiresInText, expiryTone } from '../../relay/src/inviteExpiry.ts';

export interface InviteLink { url: string; discordUrl?: string; expiresAt: number; max: number; minutes?: number }
export interface InviteSheetOpts {
  link: InviteLink;
  /** The current "Link works for" choice (minutes); default 30. */
  minutes?: number;
  /** Mint a new link (the old one stops working), optionally with a new lifetime. Resolve null when it failed (the
   *  caller already said why). */
  onNew?: (minutes?: number) => Promise<InviteLink | null>;
  /** Turn the link off now. Resolve false when it failed. */
  onOff?: () => Promise<boolean | void>;
  /** Copy the Discord sign-in (verified name) link instead. */
  onDiscordLink?: () => void;
  /** One sentence when the link shows something private (a workers.dev account name), + the help opener. */
  privacy?: string | null;
  onPrivacyHelp?: () => void;
  /** The relay has no TURN: some guests on mobile data / strict networks won't connect. */
  turnMissing?: boolean;
  onTurnHelp?: () => void;
  /** Already copied by the caller (skip the auto-copy). */
  copied?: boolean;
}

/** What the sheet shows for a link right now (pure: unit-tested in tools/invite_expiry_unit.ts). */
export interface InviteStatus { state: 'live' | 'soon' | 'expired' | 'off'; chip: string; canCopy: boolean; message: string }
export function inviteStatus(link: Pick<InviteLink, 'expiresAt'>, now = Date.now(), off = false): InviteStatus {
  if (off) return { state: 'off', chip: 'Turned off', canCopy: false, message: 'Link turned off. Nobody new can join with it.' };
  const tone = expiryTone(link.expiresAt, now);
  if (tone === 'gone') return { state: 'expired', chip: 'Expired', canCopy: false, message: 'This link has expired, so nobody new can join with it.' };
  return { state: tone === 'soon' ? 'soon' : 'live', chip: expiresInText(link.expiresAt, now), canCopy: true, message: '' };
}

const CSS = `
.vtpi-shade{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:16px;background:rgb(5 7 11/.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:vtpi-fade .25s ease both}
.vtpi{--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--ls:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--amber:#ffcf6a;--ease:cubic-bezier(.16,1,.3,1);
  position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left;
  background:linear-gradient(180deg,rgb(255 255 255/.05),rgb(255 255 255/.015)),var(--ink-3);border:1px solid var(--line);border-radius:22px;padding:26px 24px 20px;
  box-shadow:inset 0 1px 0 rgb(255 255 255/.06),0 40px 120px -40px rgb(0 0 0/.95),0 0 0 1px rgb(0 0 0/.4);animation:vtpi-rise .6s var(--ease) both}
.vtpi::before{content:"";position:absolute;inset:0 0 auto;height:160px;border-radius:22px 22px 0 0;pointer-events:none;background:radial-gradient(60% 100% at 20% 0,rgb(123 216 143/.16),transparent 70%),radial-gradient(50% 90% at 85% 0,rgb(108 199 245/.12),transparent 70%)}
@keyframes vtpi-fade{from{opacity:0}}@keyframes vtpi-rise{from{opacity:0;transform:translateY(18px) scale(.98)}}
.vtpi *{box-sizing:border-box}.vtpi [hidden]{display:none!important}
.vtpi .linkbox .copy:disabled{background:rgb(255 255 255/.08);color:var(--dim);box-shadow:none;cursor:default;transform:none}
.vtpi .x{position:absolute;top:14px;right:14px;width:36px;height:36px;border-radius:12px;border:1px solid var(--line);background:rgb(255 255 255/.03);color:var(--mute);font-size:18px;line-height:1;cursor:pointer}.vtpi .x:hover{color:var(--fg);background:rgb(255 255 255/.07)}
.vtpi .eb{position:relative;display:flex;align-items:center;gap:10px;margin:0 0 10px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--lime)}.vtpi .eb::before{content:"";width:24px;height:1px;background:currentColor}
.vtpi h2{position:relative;margin:0 0 6px;font:700 25px/1.15 "Archivo","Bahnschrift","Segoe UI Variable Display",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em}
.vtpi .sub{position:relative;margin:0 0 18px;color:var(--mute)}
.vtpi .linkbox{display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;border:1px solid var(--ls);border-radius:16px;background:var(--ink-2);transition:border-color .3s,box-shadow .3s}
.vtpi .linkbox.ok{border-color:rgb(123 216 143/.6);box-shadow:0 0 0 4px rgb(123 216 143/.12)}
.vtpi .linkbox input{flex:1;min-width:0;border:0;background:none;color:#cfe7d6;font:13.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none;text-overflow:ellipsis;padding:8px 0}
.vtpi .copy{flex:none;display:inline-flex;align-items:center;gap:8px;min-height:46px;padding:0 20px;border:0;border-radius:12px;background:var(--lime);color:var(--ink);font:inherit;font-weight:650;font-size:16px;line-height:1;cursor:pointer;box-shadow:0 12px 30px -14px rgb(123 216 143/.7);transition:background .18s,transform .2s var(--ease)}
.vtpi .copy:hover{background:var(--lime-hi)}.vtpi .copy:active{transform:scale(.97)}.vtpi .copy.done{background:var(--lime-hi)}
.vtpi .copy svg{width:18px;height:18px}
.vtpi .said{min-height:22px;margin:8px 2px 0;font-size:13.5px;color:var(--lime);opacity:0;transform:translateY(-3px);transition:opacity .3s,transform .3s var(--ease)}.vtpi .said.on{opacity:1;transform:none}.vtpi .said.warn{color:var(--amber)}
.vtpi .facts{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px;padding:0;list-style:none}.vtpi .facts li{font-size:12.5px;color:var(--mute);border:1px solid var(--ls);background:rgb(255 255 255/.03);border-radius:999px;padding:5px 11px}
.vtpi .facts li.timer{color:var(--fg);border-color:rgb(123 216 143/.45);background:rgb(123 216 143/.08);font-variant-numeric:tabular-nums}.vtpi .facts li.timer::before{content:"";display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:var(--lime);vertical-align:1px}
.vtpi .facts li.timer.soon{color:#ffe2a0;border-color:rgb(255 207 106/.5);background:rgb(255 207 106/.08)}.vtpi .facts li.timer.soon::before{background:var(--amber)}
.vtpi .facts li.timer.expired,.vtpi .facts li.timer.off{color:#ffb3b3;border-color:rgb(255 107 107/.45);background:rgb(255 107 107/.08)}.vtpi .facts li.timer.expired::before,.vtpi .facts li.timer.off::before{background:#ff6b6b}
.vtpi .dur{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:12px 0 0}.vtpi .dur>span{font-size:13.5px;color:var(--mute)}
.vtpi .seg{display:inline-flex;padding:3px;border-radius:12px;border:1px solid var(--ls);background:var(--ink-2)}
.vtpi .seg button{min-height:34px;padding:0 14px;border:0;border-radius:9px;background:none;color:var(--mute);font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;transition:background .18s,color .18s}
.vtpi .seg button:hover{color:var(--fg)}.vtpi .seg button[aria-pressed=true]{background:var(--lime);color:var(--ink)}.vtpi .seg button:disabled{opacity:.5;cursor:default}
.vtpi .linkbox.dead{opacity:.55}.vtpi .linkbox.dead input{text-decoration:line-through;text-decoration-color:rgb(255 255 255/.35)}
.vtpi .revive{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:10px 0 0;padding:12px 14px;border-radius:14px;border:1px solid rgb(255 107 107/.3);background:rgb(255 107 107/.07);animation:vtpi-rise .4s var(--ease) both}
.vtpi .revive p{margin:0;font-size:14px;color:#ffd0d0}.vtpi .revive .copy{min-height:42px;font-size:15px}
.vtpi .share{display:flex;gap:8px;margin:14px 0 0}.vtpi .ghostbtn{flex:1;min-height:44px;border-radius:12px;border:1px solid var(--ls);background:rgb(255 255 255/.05);color:var(--fg);font:inherit;font-weight:600;font-size:14.5px;line-height:1.2;cursor:pointer}.vtpi .ghostbtn:hover{background:rgb(255 255 255/.09)}.vtpi .ghostbtn:disabled{opacity:.45;cursor:default}
.vtpi .qr{margin:14px 0 0;padding:18px 16px 16px;border-radius:18px;border:1px solid var(--line);background:rgb(255 255 255/.03);text-align:center;animation:vtpi-rise .5s var(--ease) both}
.vtpi .qr .frame{display:inline-block;max-width:100%;padding:0;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px rgb(255 255 255/.1),0 24px 60px -24px rgb(123 216 143/.45)}
.vtpi .qr .frame svg{display:block;width:100%;height:auto}
.vtpi .qr b{display:block;margin:14px 0 2px;font-size:16px}.vtpi .qr p{margin:0;color:var(--mute);font-size:13.5px}
.vtpi .dc{display:flex;gap:14px;align-items:flex-start;margin:18px 0 0;padding:14px 16px;border-radius:16px;border:1px solid rgb(88 101 242/.35);background:rgb(88 101 242/.08)}
.vtpi .dc .ic{flex:none;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:#5865f2;color:#fff}.vtpi .dc .ic svg{width:20px;height:20px}
.vtpi .dc b{display:block;margin-bottom:2px}.vtpi .dc p{margin:0;color:var(--mute);font-size:13.5px}
.vtpi kbd{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg);background:var(--ink-2);border:1px solid var(--ls);border-bottom-width:2px;border-radius:6px;padding:1px 6px;white-space:nowrap}
.vtpi .warn{margin:12px 0 0;padding:10px 14px;border-radius:12px;font-size:13.5px;color:#ffe2a0;background:rgb(255 207 106/.08);border:1px solid rgb(255 207 106/.28)}
.vtpi .warn button,.vtpi .lnk{background:none;border:0;padding:0;color:var(--sky);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.vtpi .verify{margin:14px 0 0;font-size:13px;color:var(--dim)}
.vtpi .foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:20px -24px -20px;padding:14px 24px;border-top:1px solid var(--line);background:rgb(0 0 0/.18);border-radius:0 0 22px 22px}
.vtpi .foot .q{background:none;border:0;color:var(--mute);font:inherit;font-weight:500;font-size:13.5px;line-height:1;padding:10px 8px;cursor:pointer;border-radius:8px}.vtpi .foot .q:hover{color:var(--fg);background:rgb(255 255 255/.05)}.vtpi .foot .q.danger:hover{color:#ffb3b3}
.vtpi .foot .done{margin-left:auto;min-height:40px;padding:0 18px;border-radius:12px;border:1px solid var(--ls);background:rgb(255 255 255/.06);color:var(--fg);font:inherit;font-weight:600;font-size:14px;line-height:1;cursor:pointer}.vtpi .foot .done:hover{background:rgb(255 255 255/.1)}
.vtpi :focus-visible{outline:2px solid var(--lime);outline-offset:3px}
@media (max-width:520px){.vtpi{padding:22px 18px 18px}.vtpi .foot{margin:18px -18px -18px;padding:12px 18px}.vtpi .linkbox{flex-wrap:wrap;padding:8px}.vtpi .linkbox input{flex-basis:100%;padding:4px 6px 8px}.vtpi .copy{flex:1;justify-content:center}}
@media (prefers-reduced-motion:reduce){.vtpi,.vtpi-shade,.vtpi *{animation:none!important;transition:none!important}}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_DISCORD = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.3 5.6A16.6 16.6 0 0 0 15.2 4.3l-.5 1a15.4 15.4 0 0 0-5.4 0l-.5-1a16.6 16.6 0 0 0-4.1 1.3C2.1 9.4 1.4 13.1 1.7 16.8a16.8 16.8 0 0 0 5.1 2.6l1.1-1.7a10.8 10.8 0 0 1-1.7-.8l.4-.3a11.9 11.9 0 0 0 10.8 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.7a16.8 16.8 0 0 0 5.1-2.6c.4-4.3-.7-8-3-11.2ZM8.9 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.2 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"/></svg>';

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* blocked: fall back below */ }
  try {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

let open: (() => void) | null = null;
/** Show the sheet. Returns a close function. One sheet at a time. */
export function openInviteSheet(o: InviteSheetOpts): () => void {
  open?.();
  if (!document.getElementById('vtp-invite-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'vtp-invite-css', textContent: CSS }));
  let link = o.link;
  const shade = el('div', 'vtpi-shade');
  const box = el('div', 'vtpi'); box.dataset.tut = 'invite-sheet';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'vtpi-title');
  const x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
  const h = el('h2', '', 'Your guest link is ready'); h.id = 'vtpi-title';
  const input = el('input'); input.readOnly = true; input.setAttribute('aria-label', 'Guest link'); input.addEventListener('focus', () => input.select());
  const copyBtn = el('button', 'copy'); copyBtn.type = 'button'; copyBtn.dataset.tut = 'invite-copy';
  const linkbox = el('div', 'linkbox'); linkbox.append(input, copyBtn);
  const said = el('p', 'said'); said.setAttribute('role', 'status'); said.setAttribute('aria-live', 'polite');
  const facts = el('ul', 'facts');
  const timer = el('li', 'timer'); timer.setAttribute('aria-live', 'off');
  let minutes = o.link.minutes ?? o.minutes ?? INVITE_DEFAULT_MINUTES;
  let off = false;
  const drawLink = () => {
    input.value = link.url;
    timer.title = `Until ${time(link.expiresAt)}`;
    facts.replaceChildren(timer, el('li', '', `Up to ${link.max} ${link.max === 1 ? 'guest' : 'guests'}`), el('li', '', 'You let each one in'), el('li', '', 'Phones work too'));
    drawStatus();
  };
  // "Link works for": changing it makes a fresh link with that lifetime (the old one stops working)
  const dur = el('div', 'dur'); const seg = el('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Link works for');
  dur.append(el('span', '', 'Link works for'), seg);
  const segBtns = INVITE_CHOICES.map((m) => {
    const b = el('button', '', choiceLabel(m)); b.type = 'button';
    b.addEventListener('click', () => { if (m !== minutes || off || inviteStatus(link).state === 'expired') void renew(m); });
    seg.append(b); return { m, b };
  });
  const drawSeg = () => segBtns.forEach(({ m, b }) => { b.setAttribute('aria-pressed', String(m === minutes)); b.disabled = !o.onNew; });
  // expired / turned off: say so, one big "Make a new link"
  const revive = el('div', 'revive'); revive.hidden = true;
  const reviveMsg = el('p'); const reviveBtn = el('button', 'copy', 'Make a new link'); reviveBtn.type = 'button';
  revive.append(reviveMsg, reviveBtn);
  reviveBtn.addEventListener('click', () => void renew(minutes));
  if (!o.onNew) reviveBtn.hidden = true;
  let lastState = '';
  function drawStatus() {
    const st = inviteStatus(link, Date.now(), off);
    timer.textContent = st.chip; timer.className = `timer ${st.state}`;
    if (st.state === lastState) return;
    lastState = st.state;
    const dead = !st.canCopy;
    linkbox.classList.toggle('dead', dead); copyBtn.disabled = dead; input.disabled = dead;
    revive.hidden = !dead; reviveMsg.textContent = st.message;
    h.textContent = dead ? (st.state === 'off' ? 'Your guest link is off' : 'Your guest link has expired') : 'Your guest link is ready';
    if (dead) {
      clearTimeout(resetT); copyBtn.innerHTML = `${ICON_COPY}<span>Copy link</span>`; copyBtn.classList.remove('done'); linkbox.classList.remove('ok');
      qrBox.hidden = true; qb.textContent = 'Show QR code for a phone'; qb.setAttribute('aria-expanded', 'false'); said.className = 'said';
    }
    qb.disabled = dead;
  }
  let busy = false;
  async function renew(m: number) {
    if (!o.onNew || busy) return;
    busy = true; segBtns.forEach(({ b }) => (b.disabled = true)); reviveBtn.disabled = true;
    const n = await o.onNew(m);
    busy = false; reviveBtn.disabled = false; drawSeg();
    if (!n) return;
    link = n; minutes = n.minutes ?? m; off = false; lastState = '';
    drawSeg(); drawLink(); drawQr();
    void doCopy(`New link copied. It works for ${choiceLabel(minutes)}; the old one no longer works.`);
  }
  let resetT = 0;
  const doCopy = async (why = 'Copied! Paste it to your guest in a text, DM or Discord.') => {
    const ok = await copyText(link.url);
    copyBtn.innerHTML = ok ? `${ICON_OK}<span>Copied</span>` : `${ICON_COPY}<span>Copy link</span>`;
    copyBtn.classList.toggle('done', ok); linkbox.classList.toggle('ok', ok);
    said.className = `said on${ok ? '' : ' warn'}`;
    said.textContent = ok ? why : 'Your browser blocked copying. The link is selected: press Ctrl+C (⌘C on a Mac).';
    if (!ok) { input.focus(); input.select(); }
    clearTimeout(resetT);
    resetT = window.setTimeout(() => { copyBtn.innerHTML = `${ICON_COPY}<span>Copy again</span>`; copyBtn.classList.remove('done'); linkbox.classList.remove('ok'); }, 2600);
  };
  copyBtn.addEventListener('click', () => void doCopy());
  const share = el('div', 'share');
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    const sb = el('button', 'ghostbtn', 'Share…'); sb.type = 'button';
    sb.addEventListener('click', () => void nav.share!({ title: 'Join my show', text: 'You’re invited on my show! Open this link, allow your camera, and I’ll let you in:', url: link.url }).catch(() => {}));
    share.append(sb);
  }
  // phone guest nearby (or reading it off the stream): a big, crisp, branded QR on demand
  const qrBox = el('div', 'qr'); qrBox.hidden = true;
  const drawQr = () => {
    if (qrBox.hidden) return;
    const { svg, px } = qrSvg(link.url, { label: 'QR code for your guest link' });
    const frame = el('div', 'frame'); frame.style.width = `${px}px`; frame.innerHTML = svg;   // (our own SVG markup)
    qrBox.replaceChildren(frame, el('b', '', 'Scan with your phone camera'), el('p', '', 'Point the camera at the code, then tap the link that pops up.'));
  };
  const qb = el('button', 'ghostbtn', 'Show QR code for a phone'); qb.type = 'button'; qb.setAttribute('aria-expanded', 'false');
  qb.addEventListener('click', () => { qrBox.hidden = !qrBox.hidden; qb.textContent = qrBox.hidden ? 'Show QR code for a phone' : 'Hide QR code'; qb.setAttribute('aria-expanded', String(!qrBox.hidden)); drawQr(); });
  share.append(qb);
  const dc = el('div', 'dc');
  const dci = el('div', 'ic'); dci.innerHTML = ICON_DISCORD;
  const dcp = el('p');
  dcp.append('Paste the link in any Discord channel. (With your own Discord bot set up on your invite server, “Go live · post invite” posts a card with a big Join button for you.)');
  const dct = el('div'); dct.append(el('b', '', 'Post it in Discord'), dcp);
  dc.append(dci, dct);
  box.append(x, el('p', 'eb', 'Invite someone'), h, el('p', 'sub', 'Send it to your guest. They open it in any browser, type their name, allow their camera, and you let them in. Nothing to install.'), linkbox, said, revive, facts, dur);
  box.append(share, qrBox);
  box.append(dc);
  if (o.privacy) { const w = el('p', 'warn'); w.append('🔒 ', o.privacy, ' '); if (o.onPrivacyHelp) { const b = el('button', '', 'Private links'); b.type = 'button'; b.addEventListener('click', o.onPrivacyHelp); w.append(b); } box.append(w); }
  if (o.turnMissing) { const w = el('p', 'warn'); w.append('Heads-up: guests on mobile data or school / work Wi-Fi may not connect until your relay has TURN. '); if (o.onTurnHelp) { const b = el('button', '', 'How to fix'); b.type = 'button'; b.addEventListener('click', o.onTurnHelp); w.append(b); } box.append(w); }
  if (o.onDiscordLink) {
    const v = el('p', 'verify'); const b = el('button', 'lnk', 'Copy the Discord sign-in link'); b.type = 'button';
    b.addEventListener('click', () => { o.onDiscordLink!(); said.className = 'said on'; said.textContent = 'Discord sign-in link copied: your guest signs in, so their name is verified.'; });
    v.append('The name a guest types is marked “not verified”. Need real names? ', b, '.'); box.append(v);
  }
  const foot = el('div', 'foot');
  if (o.onNew) {
    const nb = el('button', 'q', 'Make a new link'); nb.type = 'button'; nb.title = 'Makes a fresh link. The old one stops working.';
    nb.addEventListener('click', () => void renew(minutes));
    foot.append(nb);
  }
  if (o.onOff) {
    const ob = el('button', 'q danger', 'Turn link off now'); ob.type = 'button'; ob.title = 'Nobody new can join with it. Guests already in stay in.';
    ob.addEventListener('click', async () => { ob.disabled = true; const r = await o.onOff!(); ob.disabled = false; if (r !== false) { off = true; drawStatus(); } });
    foot.append(ob);
  }
  const done = el('button', 'done', 'Done'); done.type = 'button';
  foot.append(done);
  box.append(foot);
  shade.append(box);
  const prevFocus = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const tick = window.setInterval(drawStatus, 1000);   // the countdown chip (text only; cheap)
  function close() { if (!shade.isConnected) return; clearTimeout(resetT); clearInterval(tick); window.removeEventListener('keydown', onKey, true); shade.remove(); open = null; prevFocus?.focus?.(); }
  x.addEventListener('click', close); done.addEventListener('click', close);
  shade.addEventListener('click', (e) => { if (e.target === shade) close(); });
  window.addEventListener('keydown', onKey, true);
  drawSeg();
  drawLink();
  copyBtn.innerHTML = `${ICON_COPY}<span>Copy link</span>`;
  document.body.append(shade);
  copyBtn.focus();
  if (o.copied) { copyBtn.innerHTML = `${ICON_OK}<span>Copied</span>`; copyBtn.classList.add('done'); linkbox.classList.add('ok'); said.className = 'said on'; said.textContent = 'Copied! Paste it to your guest in a text, DM or Discord.'; resetT = window.setTimeout(() => { copyBtn.innerHTML = `${ICON_COPY}<span>Copy again</span>`; copyBtn.classList.remove('done'); linkbox.classList.remove('ok'); }, 2600); }
  else if (inviteStatus(link).canCopy) void doCopy();
  open = close;
  return close;
}

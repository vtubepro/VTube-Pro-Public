// guestlink — interview guests WITHOUT VTube Pro, one click for the host:
//  * "Copy interview guest link" (no sign-in): the relay mints a link (open 10 min / 30 min / 1 hour — default 30, never
//    longer: relay/src/inviteExpiry.ts — for a few guests, revoked by a new link or by ending the party). The guest opens it in any browser (phones too), types a name, allows camera + mic, presses Join;
//    you still let them in (their name is shown as "not verified"). Their voice can come over the same link.
//  * "Copy Discord sign-in link" (verified name): the same browser page after a Discord sign-in.
//  * "Use their Discord camera instead…": crop their tile out of the Discord call window → a local projector guest.
// Used by Multiplayer, the Home party card and the Interview panel. Docs: docs/MULTIPLAYER_DISCORD.md → "Interview guests"; set-up + private links: docs/HOSTING_SETUP.md.
import type { App } from '../app.ts';
import { discord, goLive } from '../net/discordClient.ts';
import type { CamRect } from '../net/tv/tvDiscordCam.ts';
import { button, h, select, toast } from './dom.ts';
import { TURN_SETUP, TURN_SETUP_HELP, joinText } from '../../shared/liveControl.ts';
import { PRIVATE_LINKS_HELP, linkPrivacy, privacyWarning } from '../../shared/relaySetup.ts';
import { openHelp } from './help/helpViewer.ts';
import { openInviteSheet } from './inviteSheet.ts';
import { INVITE_CHOICES, INVITE_DEFAULT_MINUTES, choiceLabel, expiresInText } from '../../relay/src/inviteExpiry.ts';
import { shareLink } from '../net/shareLink.ts';
import { inviteNeedsSetup } from './autopilot/invite.ts';

let current: { room: string; url: string; discordUrl: string; expiresAt: number; max: number; minutes: number } | null = null;
// how long a new link stays open (the Invite sheet's "Link works for"; remembered per browser; default 30 min). The quick
// copy paths (deck hotkey, Live panel, "Just copy the link") use the same choice.
const MIN_KEY = 'vtp.gl.minutes';
let linkMinutes = ((): number => { try { const m = Number(localStorage.getItem(MIN_KEY)); return (INVITE_CHOICES as readonly number[]).includes(m) ? m : INVITE_DEFAULT_MINUTES; } catch { return INVITE_DEFAULT_MINUTES; } })();
const setLinkMinutes = (m: number) => { linkMinutes = m; try { localStorage.setItem(MIN_KEY, String(m)); } catch { /* storage off */ } };
let maxGuests = 3;
let warnedPrivacy = false;

const copy = (s: string, what: string) => void navigator.clipboard.writeText(s).then(() => toast(`✓ ${what} copied — paste it to your guest`, 'ok', 5000), () => toast('Couldn’t copy (clipboard blocked) — select the link and copy it', 'warn', 6000));
const oldRelay = (e: Error) => /not found|404/i.test(e.message) ? 'Your invite server is older than this feature. Update it once: Help → Set up your invite server → Updating it later.' : e.message;

/** Make sure I'm hosting a Discord party (open one without posting if not). */
async function ensureRoom(app: App): Promise<string> {
  const P = app.party;
  if (app.observer) throw new Error('Observer sandbox: parties stay off here');
  if (P.role === 'host' && P.via === 'discord' && P.roomId) return P.roomId;
  if (P.role !== 'none') throw new Error('You are in someone else’s party');
  const st = await discord.status();
  if (!st.configured || !st.signedIn) throw new Error('Connect Discord first (Multiplayer → Discord) — the link runs on your relay');
  const r = await goLive(P, st, { post: false });
  return r.roomId;
}

/** The current interview link for my room (minted when missing, expiring within a minute, or `fresh`). */
async function ensureLink(app: App, fresh = false) {
  const room = await ensureRoom(app);
  if (!current || current.room !== room || fresh || current.expiresAt < Date.now() + 60_000) {
    const r = await discord.guestLink(room, { max: maxGuests, minutes: linkMinutes });
    current = { room, url: r.url ?? '', discordUrl: r.discordUrl ?? '', expiresAt: r.expiresAt ?? 0, max: r.max ?? maxGuests, minutes: r.minutes ?? linkMinutes };
  }
  return current;
}

/** invite-experience: the "Invite someone" sheet: the link (already copied, big Copy / Share), the facts, the
 *  post-it-in-Discord helper, New link / Turn off. Quick paths (deck hotkey, Live panel) keep copyInterviewLink(). */
export async function openInvite(app: App, redraw: () => void = () => {}) {
  let link: NonNullable<typeof current>;
  try { link = await ensureLink(app); } catch (e) { if (inviteNeedsSetup(app, e)) return; toast(`Guest link: ${oldRelay(e as Error)}`, 'err', 8000); return; } // autopilot: not set up yet → one-click set-up
  // the sheet (its text box, Copy, Share and QR) gets the link through shareLink() (the raw link on your own relay);
  // the privacy check below still reads the real relay URL.
  const shown = <T extends { url: string }>(l: T): T => ({ ...l, url: shareLink(l.url) });
  openInviteSheet({
    link: shown(link),
    minutes: link.minutes,
    onNew: async (minutes?: number) => {
      if (minutes) setLinkMinutes(minutes);
      try { const n = await ensureLink(app, true); redraw(); return n ? shown(n) : n; } catch (e) { toast(oldRelay(e as Error), 'err', 7000); return null; }
    },
    onOff: async () => { const ok = await revoke(app); redraw(); return ok; },
    onDiscordLink: () => void copyDiscordGuestLink(app),
    privacy: privacyWarning(linkPrivacy(link.url)),
    onPrivacyHelp: () => openHelp(PRIVATE_LINKS_HELP),
    turnMissing: app.party.turnReady === false,
  });
  redraw();
}

export async function copyInterviewLink(app: App, fresh = false) {
  try {
    await ensureLink(app, fresh);
    if (!current) return;
    copy(shareLink(current.url), fresh ? 'New guest link (the old one no longer works)' : 'Interview guest link');
    // once per session: what this link shows (a workers.dev link carries the Cloudflare account's subdomain)
    const pw = privacyWarning(linkPrivacy(current.url));
    if (pw && !warnedPrivacy) { warnedPrivacy = true; setTimeout(() => toast(pw, 'info', 10000), 5400); }
    // honest heads-up: without TURN the link opens for everyone, but some networks can never connect
    if (app.party.turnReady === false) setTimeout(() => toast('Heads-up: your relay has no TURN server — guests on mobile data or strict networks won’t be able to connect. Fix: Multiplayer → Interview guests.', 'warn', 9000), 5200);
  } catch (e) { if (!inviteNeedsSetup(app, e)) toast(`Guest link: ${oldRelay(e as Error)}`, 'err', 8000); }
}
export async function copyDiscordGuestLink(app: App) {
  try {
    const room = await ensureRoom(app);
    const base = app.party.joinUrl || '';
    copy(shareLink(current?.room === room && current.discordUrl ? current.discordUrl : `${base}${base.includes('?') ? '&' : '?'}as=tv`), 'Discord sign-in guest link');
  } catch (e) { toast(`Guest link: ${(e as Error).message}`, 'err', 8000); }
}
/** moderation: "Remove + block" can also turn the invite link off for everyone (old link stops working). */
export async function revokeGuestLink(app: App) { await revoke(app); }
async function revoke(app: App): Promise<boolean> {
  const room = app.party.roomId;
  if (!room) return false;
  try { await discord.guestLink(room, { revoke: true }); current = null; toast('Guest link turned off — it no longer works', 'ok'); return true; } catch (e) { toast(oldRelay(e as Error), 'err', 7000); return false; }
}

/** The whole block (Multiplayer / Interview panel). `redraw` re-renders the host panel. */
export function guestLinkBox(app: App, redraw: () => void = () => {}): HTMLElement {
  const P = app.party;
  const T = P.tv;
  const box = h('div', { class: 'gl-box', style: 'padding:8px 10px;background:#1f2533;border-radius:10px;margin:8px 0' },
    h('b', null, '🎙 Interview guests (no VTube Pro needed)'),
    h('p', { class: 'note', style: 'margin:4px 0' }, 'Send a link: they open it in any browser (phones too), type their name, allow camera + mic, press Join — you let them in. They show up on a projector screen / the show’s monitor.'),
    h('div', { class: 'btns tight', style: 'flex-wrap:wrap' },
      button('✉ Invite someone…', () => void openInvite(app, redraw), 'primary', 'guest-invite'),
      button('🔗 Just copy the link', () => void copyInterviewLink(app).then(redraw)),
      button('Copy Discord sign-in link (verified)', () => void copyDiscordGuestLink(app)),
      button('🎥 Use their Discord camera instead…', () => openCamPicker(app))),
    select('Link works for', String(linkMinutes), INVITE_CHOICES.map((m): [string, string] => [String(m), choiceLabel(m)]), (v) => { setLinkMinutes(+v); current = null; redraw(); }, 'Every guest link expires. New links stay open this long (at most 1 hour).'),
    select('Guests per link', String(maxGuests) as '1' | '2' | '3' | '5', [['1', '1 person'], ['2', '2 people'], ['3', '3 people'], ['5', '5 people']], (v) => { maxGuests = +v; current = null; }, 'How many different people can use one link (reconnecting doesn’t count)'));
  if (current && current.room === P.roomId && P.role === 'host') {
    box.append(h('p', { class: 'note', style: 'margin:4px 0' }, 'Link: ', h('code', { style: 'user-select:all;word-break:break-all' }, shareLink(current.url)),
      ` · ${expiresInText(current.expiresAt)} (${new Date(current.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}), for up to ${current.max} ${current.max === 1 ? 'person' : 'people'}. The name they type is `, h('b', null, 'not verified'), ' (use the Discord sign-in link when that matters).'),
    privacyWarning(linkPrivacy(current.url)) ? h('p', { class: 'note', style: 'margin:4px 0;color:#f5c451' }, '🔒 ', privacyWarning(linkPrivacy(current.url)), ' ', button('Private links', () => openHelp(PRIVATE_LINKS_HELP))) : '',
    h('div', { class: 'btns tight' }, button('New link (old one stops working)', () => void copyInterviewLink(app, true).then(redraw)), button('Turn link off', () => void revoke(app).then(redraw))));
  }
  // who I let in and how their connection is doing (connecting / couldn't connect: why), and whether TURN is there
  if (P.role === 'host') {
    const joins = P.joinStates();
    if (joins.length) box.append(h('div', { style: 'margin:4px 0' }, ...joins.map((j) => h('div', { class: 'note', style: j.state === 'failed' ? 'color:#f5c451' : '' },
      `${j.state === 'failed' ? '⚠' : '⏳'} ${j.name}${j.link ? ' (link)' : ''}: ${joinText(j, P.turnReady)}`))));
    if (P.turnReady === false) box.append(h('p', { class: 'note', style: 'margin:4px 0;color:#f5c451' },
      '⚠ Your relay has no TURN server, so guests on mobile data, work / school Wi-Fi, VPNs or strict routers can’t connect (they see “couldn’t connect”). ', TURN_SETUP, ' ', button('Show me how', () => openHelp(TURN_SETUP_HELP))));
  }
  // voices of link guests (they aren't in Discord voice): heard here in the studio only (never on the OBS page); my voice back to them
  const voices = [...T.allVoices().keys()];   // (link guests + app guests talking in VTube Pro: same volume / mute)
  const rv = T.returnVoice;
  box.append(h('details', { open: voices.length > 0 || rv.on }, h('summary', null, `Guest voices over the link${voices.length ? ` (${voices.length})` : ''}`),
    h('p', { class: 'note' }, 'Link guests talk over the link by default — no Discord needed. You hear them here in the studio (use headphones, or they echo) and they hear you. VTube Pro never sends their voice to the OBS page: like a Discord call, they reach your stream through your desktop / app audio capture. If they’re also in your Discord call, use Mute for me in the Audio mixer (the cameras still follow them).'),
    h('label', { class: 'row toggle', title: 'Play link guests’ voices in this studio window (your headphones)' }, h('span', { class: 'lbl' }, 'Hear them here'),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: T.hear, onChange: (e: Event) => { T.setHear((e.target as HTMLInputElement).checked); redraw(); } }), h('i'))),
    ...voices.map((id) => {
      const name = P.view().find((m) => m.id === id)?.name ?? id;
      const s = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(T.voiceVol(id)), style: 'flex:1', onInput: (e: Event) => T.setVoiceVol(id, Number((e.target as HTMLInputElement).value)) });
      return h('label', { class: 'row' }, h('span', { class: 'lbl' }, `🔊 ${name}`), s);
    }),
    h('label', { class: 'row toggle', title: 'They hear you in their browser tab (echo-cancelled mic)' }, h('span', { class: 'lbl' }, 'Send my voice to them'),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: rv.on, onChange: (e: Event) => void T.setTalkback((e.target as HTMLInputElement).checked).then(redraw) }), h('i'))),
    T.mics.length ? select('Microphone they hear', T.mics.some((m) => m.id === rv.mic) ? rv.mic : '', [['', 'Same as lip sync'], ...T.mics.map((m): [string, string] => [m.id, m.label])],
      (v) => void T.setTalkbackMic(v).then(redraw), 'Which of your microphones link guests hear (remembered)') : null,
    rv.error ? h('p', { class: 'note', style: 'color:#f5c451' }, `Mic: ${rv.error}`) : null));
  // Discord-camera guests
  if (T.cams.list.length) box.append(h('div', null, h('span', { class: 'note' }, 'From the Discord window: '),
    ...T.cams.list.map((c) => h('span', { class: 'chip', style: 'margin-right:6px' }, `🎥 ${c.name} `, h('a', { href: '#', title: 'Remove', onClick: (e: Event) => { e.preventDefault(); T.cams.remove(c.id); redraw(); } }, '✕'))),
    button('Edit crops…', () => openCamPicker(app))));
  return box;
}

/** A one-line version for the Home party card. */
export function guestLinkQuick(app: App): HTMLElement {
  return h('div', { class: 'btns tight' }, button('✉ Invite someone…', () => void openInvite(app), 'primary'), button('🎥 Discord camera…', () => openCamPicker(app)));
}

// ---------------------------------------------------------------- crop picker (drag a box over their video tile)
export function openCamPicker(app: App) {
  const cams = app.party.tv.cams;
  const shade = h('div', { style: 'position:fixed;inset:0;background:#000b;z-index:9999;display:grid;place-items:center' });
  const panel = h('div', { style: 'background:#1b1e26;border-radius:14px;padding:16px;width:min(1100px,94vw);max-height:94vh;overflow:auto;color:#e8e8ef' });
  const video = h('video', { muted: true, autoplay: true, playsInline: true, style: 'width:100%;display:block;border-radius:8px;background:#000' }) as HTMLVideoElement;
  const wrap = h('div', { style: 'position:relative;user-select:none;cursor:crosshair' }, video);
  const boxes = h('div', { style: 'position:absolute;inset:0;pointer-events:none' });
  const drag = h('div', { style: 'position:absolute;border:2px dashed #7bd88f;background:#7bd88f22;display:none' });
  wrap.append(boxes, drag);
  const name = h('input', { type: 'text', placeholder: 'Their name', maxLength: 32, style: 'width:14em' }) as HTMLInputElement;
  const look = h('select', null, h('option', { value: 'projector' }, '📽 Projector screen'), h('option', { value: 'tv' }, '🚶 Walking TV')) as HTMLSelectElement;
  const msg = h('p', { class: 'note' });
  let rect: CamRect | null = null;
  const close = () => { off(); shade.remove(); };
  const drawBoxes = () => {
    boxes.replaceChildren(...cams.list.map((c) => h('div', { style: `position:absolute;left:${c.rect[0] * 100}%;top:${c.rect[1] * 100}%;width:${c.rect[2] * 100}%;height:${c.rect[3] * 100}%;border:2px solid #5865f2;background:#5865f222` },
      h('span', { style: 'background:#5865f2;color:#fff;font-size:12px;padding:1px 6px' }, c.name))));
    list.replaceChildren(...cams.list.map((c) => h('div', { class: 'row', style: 'gap:6px' }, h('span', { style: 'flex:1' }, `🎥 ${c.name} (${c.look === 'tv' ? 'walking TV' : 'projector'})`),
      button('Use the box as their crop', () => { if (rect) { cams.update(c.id, { rect }); rect = null; drag.style.display = 'none'; drawBoxes(); } else msg.textContent = 'Drag a new box first.'; }),
      button('Remove', () => { cams.remove(c.id); drawBoxes(); }))));
    const saved = cams.saved().filter((s) => !cams.list.some((c) => c.name === s.name));
    restore.replaceChildren(...(saved.length ? [h('span', { class: 'note' }, 'Last time with this window size: '), ...saved.map((s) => button(`+ ${s.name}`, () => { cams.add(s.name, s.rect); drawBoxes(); }))] : []));
  };
  const list = h('div');
  const restore = h('div', { class: 'btns tight' });
  const show = () => { video.srcObject = cams.window; void video.play().catch(() => {}); msg.textContent = cams.window ? `Sharing: ${cams.label}. Drag a box over a guest’s video tile, name them, then Add.` : (cams.error || 'Pick the Discord call window first.'); drawBoxes(); };
  const pick = button('Pick the Discord call window…', () => void cams.pickWindow().then(show), 'primary');
  // drag a box (fractions of the picture)
  let start: [number, number] | null = null;
  const frac = (e: PointerEvent): [number, number] => { const r = video.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  wrap.addEventListener('pointerdown', (e) => { if (!cams.window) return; start = frac(e); wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = frac(e);
    rect = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])];
    Object.assign(drag.style, { display: 'block', left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` });
  });
  wrap.addEventListener('pointerup', () => { start = null; if (rect && (rect[2] < 0.03 || rect[3] < 0.03)) { rect = null; drag.style.display = 'none'; } });
  const add = button('Add to the scene', () => {
    if (!cams.window) { msg.textContent = 'Pick the Discord call window first.'; return; }
    if (!rect) { msg.textContent = 'Drag a box over their video tile first.'; return; }
    const g = cams.add(name.value || 'Guest', rect, look.value === 'tv' ? 'tv' : 'projector');
    if (!g) { msg.textContent = 'Up to 4 Discord-camera guests.'; return; }
    toast(`${g.name} is in the scene (${g.look === 'tv' ? 'walking TV' : 'projector screen'})`, 'ok');
    rect = null; name.value = ''; drag.style.display = 'none'; drawBoxes();
  }, 'primary');
  const off = (() => { const t = window.setInterval(() => { if (video.srcObject !== cams.window) show(); }, 1000); return () => clearInterval(t); })();
  panel.append(h('h3', { style: 'margin:0 0 6px' }, '🎥 Use their Discord camera'),
    // (clarity: this puts someone's camera on your stream without them doing anything: ask first, and be honest about saving)
    h('p', { class: 'note' }, 'Ask your guest first: their Discord video goes on your stream. Share the Discord call window (Discord’s own pop-out works best), drag a box over their video tile and name them. They appear in your scene like a webcam guest. VTube Pro doesn’t record it, but your stream may be saved. Boxes are remembered for this window size.'),
    h('div', { class: 'btns tight' }, pick, button('Done', close)), msg, wrap,
    h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, name, look, add), restore, list);
  shade.append(panel);
  shade.addEventListener('click', (e) => { if (e.target === shade) close(); });
  document.body.append(shade);
  show();
}

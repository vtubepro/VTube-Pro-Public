// invite-experience: everything a guest SEES on the relay — the branded page shell (BRAND.md tokens, V lock-up, Beta
// badge, "Powered by VTube Pro" footer), friendly state pages (ended / expired / full / slow down / not allowed / …),
// the link-preview (OpenGraph + Twitter card + the branded /og/invite.jpg) and the browser guest page markup (/tv, /g).
// Presentation only: no auth decisions live here (app.ts decides; this file draws). No external requests:
// system fonts, inline SVG, the preview image is bundled (inviteCard.gen.ts). Nothing personal: the only name ever put
// in a link preview is the relay's PUBLIC_NAME.
import { INVITE_CARD_JPG_B64 } from './inviteCard.gen.ts';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow' };

// ---------------------------------------------------------------- brand (T\portal\BRAND.md)
const V_PATH = 'M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z';
/** The V tile (rounded near-black square + gradient V), inline so no img-src is needed. */
export function tileSvg(size = 30, id = 'vg') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient><linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161c21"/><stop offset="1" stop-color="#07090c"/></linearGradient></defs><rect width="100" height="100" rx="23" fill="url(#${id}b)"/><rect x=".5" y=".5" width="99" height="99" rx="22.5" fill="none" stroke="#fff" stroke-opacity=".14"/><path d="${V_PATH}" fill="url(#${id})" transform="translate(50 52) scale(.7) translate(-50 -52)"/></svg>`;
}
const markSvg = (size = 14) => `<svg width="${size}" height="${size}" viewBox="8 16 84 72" aria-hidden="true" focusable="false"><defs><linearGradient id="vm" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset="1" stop-color="#6cc7f5"/></linearGradient></defs><path d="${V_PATH}" fill="url(#vm)"/></svg>`;
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" ${tileSvg(64, 'f').slice(5)}`;

const ICONS: Record<string, string> = {
  ended: '<path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M10 20v-5h4v5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/><path d="M14.5 6.5 17 4"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4.2 4.2 0 0 1 6 6l-1 1M13 18l-1 1a4.2 4.2 0 0 1-6-6l1-1"/><path d="M4 4l16 16" opacity=".55"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>',
  wave: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-12.2 4.7L4.5 15.5a1.5 1.5 0 0 1 2.3-1.9L8 15"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.5L16 9.5"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.4" r="1"/>',
  cam: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>',
  door: '<path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h9A1.5 1.5 0 0 1 17 4.5V21M3 21h18"/><circle cx="13.5" cy="12.5" r=".9"/>',
};
export type IconName = keyof typeof ICONS | string;
export const icon = (name: IconName, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.check}</svg>`;

/** Shared look (tokens from BRAND.md §2/§4/§7). System fonts only (no Google Fonts: privacy + CSP). */
export const BRAND_CSS = `:root{--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--pink:#ff5fb4;--amber:#ffcf6a;--err:#ff6b6b;--air:#ff3b4a;--ease:cubic-bezier(.16,1,.3,1);
--display:"Archivo","Bahnschrift","Segoe UI Variable Display","SF Pro Display",ui-sans-serif,system-ui,-apple-system,sans-serif;--body:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-text-size-adjust:100%;background:var(--ink)}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--ink);color:var(--fg);font:16px/1.55 var(--body);-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;left:-20%;right:-20%;top:-30vh;height:85vh;z-index:-1;pointer-events:none;background:radial-gradient(42% 52% at 32% 46%,rgb(123 216 143/.16),transparent 70%),radial-gradient(36% 46% at 72% 36%,rgb(108 199 245/.13),transparent 70%);animation:drift 18s ease-in-out infinite alternate}
@keyframes drift{to{transform:translate3d(3%,2%,0) scale(1.05)}}
::selection{background:rgb(123 216 143/.35);color:#fff}
.top{display:flex;align-items:center;gap:10px;width:100%;max-width:1080px;margin:0 auto;padding:16px 20px;padding-top:max(16px,env(safe-area-inset-top))}
.lock{display:inline-flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font:700 17px/1 var(--display);letter-spacing:-.01em;white-space:nowrap}
.beta{font:500 10px/1 var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--lime);background:rgb(123 216 143/.1);border:1px solid rgb(123 216 143/.3);border-radius:999px;padding:5px 8px}
.top .host{margin-left:auto;display:inline-flex;align-items:center;gap:8px;min-width:0;font-size:13px;color:var(--mute);border:1px solid var(--line-strong);background:rgb(255 255 255/.03);border-radius:999px;padding:6px 12px}
.top .host span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.top .host i{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 0 3px rgb(123 216 143/.18);flex:none}
.wrap{flex:1;width:100%;max-width:560px;margin:0 auto;padding:8px 16px 28px}.wrap.state{display:flex;flex-direction:column;justify-content:center;padding-bottom:9vh}
.card{position:relative;background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);box-shadow:inset 0 1px 0 rgb(255 255 255/.06),0 30px 80px -40px rgb(0 0 0/.8);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border-radius:24px;padding:30px 24px 26px;animation:rise .8s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 14px;font:500 11px/1 var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--lime)}.eyebrow::before{content:"";width:24px;height:1px;background:currentColor}
h1{font:700 clamp(26px,6.6vw,36px)/1.1 var(--display);letter-spacing:-.02em;margin:0 0 10px;text-wrap:balance}
h2{font:700 21px/1.2 var(--display);letter-spacing:-.01em;margin:0 0 6px}
p{margin:0 0 12px}.note{color:var(--mute);font-size:14px}.lede{color:var(--mute);font-size:16.5px;margin:0 0 6px}
a{color:var(--sky);text-underline-offset:3px}b,strong{color:var(--fg);font-weight:650}
.grad{background:linear-gradient(135deg,#7bd88f,#6cc7f5);-webkit-background-clip:text;background-clip:text;color:transparent}
.btn,a.btn,button.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:52px;margin:0;padding:14px 20px;border-radius:14px;border:1px solid transparent;background:var(--lime);color:var(--ink);font:650 17px/1.2 var(--body);text-decoration:none;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .18s,transform .2s var(--ease),box-shadow .2s,opacity .2s;box-shadow:0 12px 32px -14px rgb(123 216 143/.65)}
.btn:hover{background:var(--lime-hi)}.btn:active{transform:scale(.98)}.btn:disabled{opacity:.42;cursor:default;box-shadow:none;transform:none;background:var(--lime)}
.btn.secondary,a.btn.secondary{background:rgb(255 255 255/.06);color:var(--fg);border-color:var(--line-strong);box-shadow:none}.btn.secondary:hover{background:rgb(255 255 255/.1)}
.btn.ghost{background:transparent;color:var(--mute);box-shadow:none;min-height:44px;font-weight:500;font-size:15px}.btn.ghost:hover{color:var(--fg);background:rgb(255 255 255/.04)}
.btn.danger{background:rgb(255 107 107/.1);color:#ffb3b3;border-color:rgb(255 107 107/.3);box-shadow:none}.btn.danger:hover{background:rgb(255 107 107/.16)}
.btn.discord,a.btn.discord{background:#5865f2;color:#fff;box-shadow:0 12px 32px -14px rgb(88 101 242/.8)}.btn.discord:hover{background:#6d78f5}

.btn .ico{width:20px;height:20px}
.btns{display:grid;gap:10px;margin:22px 0 4px}
:focus{outline:none}:focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:6px}.btn:focus-visible{border-radius:14px}
code{font:13px var(--mono);background:rgb(255 255 255/.06);border:1px solid var(--line);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
textarea{width:100%;height:86px;font:12px/1.45 var(--mono);background:var(--ink-2);color:#cfe7d6;border:1px solid var(--line-strong);border-radius:12px;padding:10px 12px;resize:vertical}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
details.help{margin:16px 0 0;border:1px solid var(--line);border-radius:14px;background:rgb(255 255 255/.02)}details.help>summary{cursor:pointer;list-style:none;padding:12px 16px;color:var(--mute);font-size:14px}details.help>summary::-webkit-details-marker{display:none}details.help>summary::after{content:"+";float:right;color:var(--dim)}details.help[open]>summary::after{content:"–"}details.help>div{padding:0 16px 14px}
.badge-ico{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;margin:0 0 20px;color:var(--lime);background:radial-gradient(circle at 30% 25%,rgb(123 216 143/.22),rgb(108 199 245/.08) 70%);border:1px solid rgb(123 216 143/.25);box-shadow:0 18px 40px -18px rgb(123 216 143/.55)}
.badge-ico .ico{width:30px;height:30px}.badge-ico.warn{color:var(--amber);background:radial-gradient(circle at 30% 25%,rgb(255 207 106/.2),rgb(255 207 106/.05) 70%);border-color:rgb(255 207 106/.28);box-shadow:0 18px 40px -18px rgb(255 207 106/.45)}
.badge-ico.err{color:var(--err);background:radial-gradient(circle at 30% 25%,rgb(255 107 107/.18),rgb(255 107 107/.04) 70%);border-color:rgb(255 107 107/.28);box-shadow:none}
.foot{width:100%;max-width:1080px;margin:0 auto;padding:18px 20px;padding-bottom:max(18px,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;align-items:center;color:var(--dim);font-size:12.5px}
.foot .pw{display:inline-flex;align-items:center;gap:7px;color:var(--mute);text-decoration:none}.foot .pw b{font:700 13px/1 var(--display);letter-spacing:-.01em}.foot .sep{opacity:.5}
@media (max-width:420px){.card{padding:26px 18px 22px;border-radius:22px}.top{padding-left:16px;padding-right:16px}.top .host{display:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;

// ---------------------------------------------------------------- link previews (Discord / X / iMessage / Slack …)
export interface Og { title: string; description: string; url: string; image?: string; imageAlt?: string }
export const OG_IMAGE_PATH = '/og/invite.jpg';
const OG_ALT = 'VTube Pro: you’re invited. Join the show live, from your browser.';
/** OpenGraph + Twitter card tags. `image` defaults to the bundled branded card on this relay. */
export function ogTags(og: Og, origin: string) {
  const img = og.image ?? `${origin}${OG_IMAGE_PATH}`;
  const m = (k: string, v: string, attr = 'property') => `<meta ${attr}="${k}" content="${esc(v)}">`;
  return [m('og:type', 'website'), m('og:site_name', 'VTube Pro'), m('og:title', og.title), m('og:description', og.description), m('og:url', og.url),
    m('og:image', img), m('og:image:secure_url', img), m('og:image:type', 'image/jpeg'), m('og:image:width', '1200'), m('og:image:height', '630'), m('og:image:alt', og.imageAlt ?? OG_ALT),
    m('twitter:card', 'summary_large_image', 'name'), m('twitter:title', og.title, 'name'), m('twitter:description', og.description, 'name'), m('twitter:image', img, 'name'), m('twitter:image:alt', og.imageAlt ?? OG_ALT, 'name'),
    `<meta name="description" content="${esc(og.description)}">`].join('');
}
/** Link-preview fetchers (they never run scripts or follow sign-in redirects). Only used to answer them with a preview. */
export const UNFURL_UA = /discordbot|twitterbot|facebookexternalhit|facebot|slackbot|slack-imgproxy|telegrambot|whatsapp|linkedinbot|skypeuripreview|redditbot|applebot|embedly|iframely|pinterestbot|mastodon|bluesky|cardyb|vkshare|snapchat|discourse|bingpreview|google-pagerenderer|chatwork|line-poker|kakaotalk-scrap|zalo|viber|microsoftpreview|teams/i;
export const isUnfurlBot = (req: Request) => UNFURL_UA.test(req.headers.get('user-agent') ?? '');

/** Preview copy per link. `show` = the relay's PUBLIC_NAME or '' (never a Discord name: previews are cached by others). */
export function inviteOg(kind: 'guest' | 'party' | 'browser' | 'ended', show: string, url: string): Og {
  const who = show ? `${show}’s` : 'a';
  switch (kind) {
    case 'guest': return { url, title: show ? `Join ${show}’s show — you’re invited` : 'You’re invited on a live show', description: 'Tap to join from your phone or computer. Type your name, allow your camera, and the host lets you in. Nothing to install.' };
    case 'browser': return { url, title: show ? `Join ${show}’s show — you’re invited` : 'You’re invited on a live show', description: 'Sign in with Discord, allow your camera, and you’re in. Runs in your browser: nothing to install.' };
    case 'party': return { url, title: show ? `${show} is live — come join the party` : `Join ${who} VTube Pro party`, description: 'Click Join and sign in with Discord. Bring your avatar with VTube Pro, or just your webcam in the browser.' };
    default: return { url, title: 'This invite has ended', description: 'The show is over or the host made a new link. Ask them for a fresh one.' };
  }
}

// ---------------------------------------------------------------- page shell
export interface ShellOpts { nonce?: string; status?: number; og?: Og; origin?: string; host?: string; bodyClass?: string; css?: string; csp?: string; headers?: Record<string, string>; wide?: boolean }
const fallbackIcon = (status: number): [IconName, string] | null =>
  status === 410 ? ['clock', ''] : status === 403 ? ['lock', 'warn'] : status === 429 ? ['hourglass', 'warn'] : status === 503 ? ['wrench', 'warn'] : status >= 400 ? ['link', 'warn'] : null;

/** The whole document: head (meta, OG, favicon, styles), header with the lock-up + Beta badge, content, footer. */
export function shellHtml(title: string, content: string, o: ShellOpts = {}) {
  const og = o.og && o.origin ? ogTags(o.og, o.origin) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · VTube Pro</title><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#7bd88f"><meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">${og}
<style>${BRAND_CSS}${o.css ?? ''}</style></head><body${o.bodyClass ? ` class="${o.bodyClass}"` : ''}>
<header class="top"><span class="lock">${tileSvg(30)}VTube Pro</span><span class="beta">Beta</span>${o.host ? `<span class="host" title="Your host"><i></i><span>${esc(o.host)}</span></span>` : ''}</header>
${content}
<footer class="foot"><span class="pw">${markSvg(14)}<span>Powered by <b>VTube Pro</b></span></span><span class="sep">·</span><span>Beta</span></footer>
</body></html>`;
}

/** Drop-in for the old `page(title, body, nonce, status)`: same arguments, branded. A body without its own icon gets a
 *  friendly one from the status (410 clock, 403 lock, 429 hourglass, 503 wrench, other 4xx link). Body classes that
 *  look right: <h1>, <p>, <p class="note">, <a class="btn">, <a class="btn secondary|discord">, <div class="btns">,
 *  <textarea readonly>, <code>, <details class="help"><summary>…</summary><div>…</div></details>. */
export function page(title: string, body: string, nonce = '', status = 200, o: ShellOpts = {}) {
  const fb = /badge-ico/.test(body) ? null : fallbackIcon(status);
  const ico = fb ? `<div class="badge-ico ${fb[1]}">${icon(fb[0])}</div>` : '';
  const csp = o.csp ?? `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com; ${nonce ? `script-src 'nonce-${nonce}';` : ''} base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const html = shellHtml(title, `<main class="wrap state"><div class="card">${ico}${body}</div></main>`, o);
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, ...SEC, ...(o.headers ?? {}) } });
}

/** A friendly state card: icon, eyebrow, title, one or two sentences, and at most one main action. */
export interface State { icon: IconName; tone?: '' | 'warn' | 'err'; eyebrow?: string; title: string; text: string; note?: string; action?: { label: string; href: string; cls?: string }; extra?: string }
export function stateBody(s: State) {
  return `<div class="badge-ico ${s.tone ?? ''}">${icon(s.icon)}</div>${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}<h1>${esc(s.title)}</h1><p class="lede">${s.text}</p>${s.note ? `<p class="note">${s.note}</p>` : ''}${s.action ? `<div class="btns"><a class="btn ${s.action.cls ?? ''}" href="${esc(s.action.href)}">${esc(s.action.label)}</a></div>` : ''}${s.extra ?? ''}`;
}
export const statePage = (title: string, s: State, status: number, o: ShellOpts = {}) => page(title, stateBody(s), '', status, o);

// The relay's own guest-facing states, in plain words (owner: "allergic to technology").
export const STATES = {
  slow: (): State => ({ icon: 'hourglass', tone: 'warn', eyebrow: 'One moment', title: 'Lots of clicks at once', text: 'Wait about a minute, then try the link again. Nothing is broken.' }),
  ended: (host?: string): State => ({ icon: 'ended', eyebrow: 'Show’s over', title: host ? `${host}’s show has ended` : 'This show has ended', text: 'Thanks for stopping by! If you were hoping to join, ask the host for a new invite link.' }),
  expired: (): State => ({ icon: 'clock', eyebrow: 'Link expired', title: 'This invite link has expired', text: 'The show may have ended, or the host made a new link. Ask them to send you a fresh one — it only takes them a second.' }),
  notSetUp: (): State => ({ icon: 'wrench', tone: 'warn', eyebrow: 'Almost ready', title: 'The host is still setting up', text: 'Their invite system isn’t finished yet. Let the host know — nothing of yours was shared.',
    extra: '<details class="help"><summary>For the host</summary><div><p class="note">Your invite server is missing its ticket secret, or the Client ID and client secret of your own Discord application (DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET). Run <b>Set up my invite server</b> again (see relay/README.md).</p></div></details>' }),
  linkBroken: (): State => ({ icon: 'link', tone: 'warn', eyebrow: 'Link timed out', title: 'That sign-in took too long', text: 'Go back to Discord and click <b>Join</b> again. It works right away the second time.' }),
  cancelled: (): State => ({ icon: 'door', eyebrow: 'No problem', title: 'Sign-in cancelled', text: 'Nothing was shared. Changed your mind? Go back and click <b>Join</b> again.' }),
  banned: (): State => ({ icon: 'lock', tone: 'err', eyebrow: 'Not available', title: 'You can’t join this party', text: 'The host has closed this party to you. Nothing of yours was shared.' }),
  membersOnly: (host: string, role: boolean): State => ({ icon: 'users', tone: 'warn', eyebrow: 'Members only', title: 'This party is for server members', text: `${esc(host)}’s party is open to members of their Discord server${role ? ' who have the right role' : ''}. Ask the host to add you, then click <b>Join</b> again.` }),
};

// ---------------------------------------------------------------- the bundled preview image + favicon
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
let cardBytes: Uint8Array | null = null;
/** GET /og/invite.jpg and /favicon.svg (public, cacheable: they're the same for every room). null = not ours. */
export function brandAsset(path: string): Response | null {
  if (path === OG_IMAGE_PATH) {
    cardBytes ??= b64ToBytes(INVITE_CARD_JPG_B64);
    return new Response(cardBytes as unknown as BodyInit, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } });
  }
  if (path === '/favicon.svg' || path === '/favicon.ico') {
    return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  }
  return null;
}
/** What a link-preview bot gets for a link it may not follow (e.g. /j/<room>, which starts a sign-in). */
export function unfurlPage(og: Og, origin: string, status = 200) {
  return page(og.title, `<p class="eyebrow">You’re invited</p><h1>${esc(og.title)}</h1><p class="lede">${esc(og.description)}</p><div class="btns"><a class="btn" href="${esc(og.url)}">Join</a></div>`, '', status, { og, origin });
}

// ---------------------------------------------------------------- after Discord sign-in (/cb): two ways in
/** Stream-safe: the guest's own name is not shown here (guests may be live too); `_you` stays for callers. */
export function joinedBody(host: string, _you: string, appLink: string, tvLink: string) {
  return `<div class="badge-ico">${icon('check')}</div><p class="eyebrow">You’re signed in</p><h1>Joining ${esc(host)}’s party</h1>
<p class="lede">How do you want to join?</p>
<div class="btns"><a class="btn" id="go" href="${esc(appLink)}">${icon('door')}Open VTube Pro</a><p class="note" id="cd" style="text-align:center;margin:0">Opening by itself in 3…</p>
<a class="btn secondary" id="tv" href="${esc(tvLink)}">${icon('cam')}Join with my webcam</a></div>
<p class="note" style="margin-top:14px"><b>No VTube Pro?</b> Pick <b>Join with my webcam</b>: you join right here in your browser, on a big screen beside the host. Nothing to install.</p>
<details class="help"><summary>VTube Pro didn’t open?</summary><div><p class="note">Make sure VTube Pro is running on this computer, then press <b>Open VTube Pro</b> again. Or copy this link into <b>Multiplayer → Paste join link</b> (it works once, for 10 minutes):</p><textarea readonly aria-label="Join link">${esc(appLink)}</textarea></div></details>`;
}

// ---------------------------------------------------------------- the browser guest page (/tv and /g/<token>)
export interface GuestPage { title: string; host: string; invite: boolean; nonce: string; js: string; og?: Og; origin: string }
const GUEST_CSS = `
.wrap.guest{max-width:640px;padding-top:0}
.intro{padding:14px 2px 6px;animation:rise .8s var(--ease) both}
.progress{display:flex;gap:6px;margin:14px 0 4px;padding:0;list-style:none}.progress li{flex:1;display:flex;flex-direction:column;gap:7px;font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.progress li::before{content:"";height:3px;border-radius:3px;background:var(--line-strong);transition:background .4s var(--ease)}.progress li.on{color:var(--fg)}.progress li.on::before{background:linear-gradient(90deg,#7bd88f,#6cc7f5)}.progress li.done::before{background:var(--lime)}.progress li.done{color:var(--lime)}
.stage{position:relative;width:100%;aspect-ratio:16/10;background:#000;border-radius:22px;overflow:hidden;margin:14px 0 8px;border:1px solid var(--line-strong);box-shadow:0 30px 80px -40px rgb(0 0 0/.9),inset 0 0 0 1px rgb(255 255 255/.03);transition:box-shadow .5s var(--ease),border-color .5s}
body[data-step=live] .stage{border-color:rgb(255 59 74/.55);box-shadow:0 0 0 4px rgb(255 59 74/.14),0 30px 80px -40px rgb(255 59 74/.5)}
body[data-step=green] .stage{border-color:rgb(123 216 143/.5);box-shadow:0 0 0 4px rgb(123 216 143/.12),0 30px 80px -40px rgb(123 216 143/.4)}
.stage video{width:100%;height:100%;object-fit:cover;display:block}
.stage .off{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:20px;color:var(--mute);background:radial-gradient(70% 80% at 50% 40%,#10171b,#050607)}
.stage .off .ico{width:38px;height:38px;color:var(--lime);opacity:.9}.stage .off b{font:650 17px/1.3 var(--display);color:var(--fg)}.stage .off .note{max-width:34ch;margin:0}
.stage .off .btn{width:auto;min-height:44px;font-size:15px;padding:10px 18px;margin-top:4px}
.stage .off.bad .ico{color:var(--amber)}
.stage:has(.off:not([hidden])) .meter{display:none}
.tag{position:absolute;left:12px;top:12px;display:none;align-items:center;gap:7px;font:700 12px/1 var(--mono);letter-spacing:.14em;border-radius:999px;padding:7px 11px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.tag i{width:8px;height:8px;border-radius:50%;background:currentColor}
body[data-step=live] .tag.air{display:inline-flex;color:#fff;background:rgb(255 59 74/.85)}body[data-step=live] .tag.air i{background:#fff;animation:tally 1.6s ease-in-out infinite}body[data-step=live] .stage.modhid .tag.air{display:none}
body[data-step=green] .tag.gr{display:inline-flex;color:#06140b;background:rgb(123 216 143/.92)}
@keyframes tally{50%{opacity:.35}}
.meter{position:absolute;left:12px;right:12px;bottom:12px;height:30px;display:flex;align-items:center;gap:9px;padding:0 12px;border-radius:999px;background:rgb(0 0 0/.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#dfe;font:500 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}
.meter b{flex:1;height:6px;border-radius:6px;background:rgb(255 255 255/.12);overflow:hidden;display:block}.meter i{display:block;height:100%;width:0;border-radius:6px;background:linear-gradient(90deg,#7bd88f,#6cc7f5);transition:width .08s linear}
.mutedtag{position:absolute;right:12px;top:12px;background:rgb(255 59 74/.9);color:#fff;font:700 12px/1 var(--mono);letter-spacing:.12em;border-radius:999px;padding:7px 11px}
.hint{text-align:center;color:var(--dim);font-size:13px;margin:0 0 6px}
.panel{background:linear-gradient(180deg,rgb(255 255 255/.05),rgb(255 255 255/.02));border:1px solid var(--line);border-radius:22px;padding:18px;margin:12px 0;box-shadow:inset 0 1px 0 rgb(255 255 255/.05);animation:rise .7s var(--ease) both}
.field{display:block;margin:0 0 14px}.field>span{display:block;color:var(--mute);font-size:13px;margin:0 0 6px}
input[type=text],select{font:inherit;font-size:16px;width:100%;min-width:0;min-height:50px;padding:12px 14px;color:var(--fg);background:var(--ink-2);border:1px solid var(--line-strong);border-radius:12px;transition:border-color .18s,box-shadow .18s;-webkit-appearance:none;appearance:none}
select{background-image:linear-gradient(45deg,transparent 50%,#9aa6a0 50%),linear-gradient(135deg,#9aa6a0 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 14px) 50%;background-size:6px 6px;background-repeat:no-repeat;padding-right:38px}
input[type=text]:focus,select:focus{border-color:var(--lime);box-shadow:0 0 0 4px rgb(123 216 143/.15);outline:none}
input[type=text]::placeholder{color:#5f6b66}
#name{font-size:19px;font-weight:600;min-height:56px}
.devices{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;margin-top:14px}.devices .field{margin-bottom:10px}
.switchrow{display:flex;gap:12px;align-items:flex-start;margin:6px 0 0;cursor:pointer}.switchrow small{display:block;color:var(--mute);font-size:13px;line-height:1.45;margin-top:2px}
.switchrow input{appearance:none;-webkit-appearance:none;flex:none;width:44px;height:26px;margin:1px 0 0;border-radius:999px;background:rgb(255 255 255/.12);border:1px solid var(--line-strong);position:relative;cursor:pointer;transition:background .2s}
.switchrow input::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .25s var(--ease)}.switchrow input:checked{background:var(--lime);border-color:var(--lime)}.switchrow input:checked::after{transform:translateX(18px)}
#join{margin-top:6px;font-size:18px;min-height:58px}#start{margin-top:6px}
.joinhint{text-align:center;margin:10px 0 0;font-size:13.5px;color:var(--dim);min-height:1.4em}
.linkbtn{background:none;border:0;color:var(--mute);font:inherit;font-size:14px;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:8px;margin:6px auto 0;display:block}.linkbtn:hover{color:var(--fg)}
#status{margin:6px 0;font-size:15px;color:var(--mute);text-align:center;min-height:0}#status:empty{display:none}#status.bad{color:var(--amber)}
.stateCard{text-align:center;padding:30px 22px}.stateCard .badge-ico{margin:0 auto 18px}.stateCard h2{font-size:24px}.stateCard .btns{margin-top:18px}
.spin{width:64px;height:64px;margin:0 auto 18px;border-radius:50%;position:relative;display:grid;place-items:center;color:var(--lime)}
.spin::before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid rgb(123 216 143/.18);border-top-color:var(--lime);animation:spin 1.1s linear infinite}.spin::after{content:"";position:absolute;inset:10px;border-radius:50%;background:rgb(123 216 143/.08);animation:breathe 2.2s ease-in-out infinite}
.spin .ico{width:26px;height:26px;position:relative;z-index:1}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{50%{transform:scale(.86);opacity:.6}}
.grcard{text-align:left}.grcard .row{display:flex;gap:12px;align-items:flex-start}.grcard .row .badge-ico{width:44px;height:44px;border-radius:14px;margin:0;flex:none}.grcard .row .badge-ico .ico{width:22px;height:22px}
.grcard.on .row .badge-ico{color:var(--air);border-color:rgb(255 59 74/.35);background:rgb(255 59 74/.1);box-shadow:none}
.grrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 0}.grrow input{flex:1 1 180px;width:auto;min-height:48px}.grrow .btn{width:auto;min-height:48px;padding:10px 16px;font-size:15px}
#ready{flex:1 1 100%}#ready.on{background:var(--lime-hi)}
#grbar{position:sticky;top:8px;z-index:20;margin:8px 0 12px;padding:12px 12px 12px 16px;display:flex;gap:12px;align-items:center;border-radius:16px;background:rgb(43 36 18/.92);border:1px solid rgb(255 207 106/.4);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 20px 50px -20px rgb(0 0 0/.9)}
#grbar .t{flex:1;font-size:16px;font-weight:650;color:#ffe9b8;overflow-wrap:anywhere}#grbar .t small{display:block;font-size:12px;font-weight:500;color:#cdb07a;margin-top:2px}
#grbar.new{animation:grpulse 1.6s ease-out 3}@keyframes grpulse{0%{box-shadow:0 0 0 0 rgb(255 207 106/.7)}70%{box-shadow:0 0 0 16px rgb(255 207 106/0)}100%{box-shadow:0 0 0 0 rgb(255 207 106/0)}}
#grbar .btn{width:auto;min-height:40px;padding:8px 14px;font-size:14px;background:var(--amber);box-shadow:none}
#grbar.mod{background:rgb(52 18 22/.94);border-color:rgb(255 107 107/.45)}#grbar.mod .t{color:#ffd9d9}#grbar.mod .t small{color:#d79a9a}#grbar.mod .btn{background:#ff8a8a}
.modcard{text-align:left;border-color:rgb(255 107 107/.32);background:linear-gradient(180deg,rgb(255 107 107/.08),rgb(255 107 107/.02))}.modcard .row{display:flex;gap:12px;align-items:flex-start}.modcard .badge-ico{width:44px;height:44px;border-radius:14px;margin:0;flex:none}.modcard .badge-ico .ico{width:22px;height:22px}
.stage.modhid video{filter:grayscale(1) brightness(.4) blur(2px);transition:filter .4s var(--ease)}
.hidtag{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;padding:12px 18px;border-radius:16px;background:rgb(0 0 0/.55);border:1px solid var(--line-strong);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:var(--fg);max-width:80%}.hidtag b{font:700 16px/1.2 var(--display)}.hidtag span{font-size:13px;color:var(--mute)}
#mute.locked,#mute.locked:disabled{opacity:1;background:rgb(255 107 107/.14);color:#ffd9d9;border-color:rgb(255 107 107/.4);box-shadow:none;cursor:not-allowed}
#grhist{margin:12px 0 0}#grhist ol{margin:4px 0;padding-left:20px}#grhist li{margin:4px 0;overflow-wrap:anywhere}#grhist time{color:var(--dim);font-size:12px;margin-left:6px}
#mutebox{margin:12px 0}#mute{font-size:19px;min-height:60px;background:rgb(255 255 255/.08);color:var(--fg);border-color:var(--line-strong);box-shadow:none}#mute.muted{background:var(--air);color:#fff;border-color:transparent;box-shadow:0 12px 32px -14px rgb(255 59 74/.8)}
#mutebox details{margin-top:10px}.kbd{display:inline-block;font:600 13px var(--mono);background:var(--ink-2);border:1px solid var(--line-strong);border-bottom-width:3px;border-radius:7px;padding:2px 8px;min-width:1.6em;text-align:center}
.small.btn,.btn.small{width:auto;min-height:40px;padding:8px 14px;font-size:14px}
#hear{background:var(--amber);color:#1b1404;margin:10px 0}
#leave{margin:14px 0 4px}#members{text-align:center}
details.more{margin:16px 0 0;border:1px solid var(--line);border-radius:16px;background:rgb(255 255 255/.02)}details.more>summary{cursor:pointer;padding:14px 16px;color:var(--mute);font-size:14px;list-style:none}details.more>summary::-webkit-details-marker{display:none}details.more>summary::after{content:"+";float:right;color:var(--dim)}details.more[open]>summary::after{content:"–"}
details.more>.in{padding:2px 16px 16px}details.more .btns{margin:4px 0 14px;grid-template-columns:1fr 1fr}details.more .btn{min-height:46px;font-size:14.5px;padding:10px 12px}
.check{display:flex;gap:10px;align-items:center;margin:10px 0}.check input{width:20px;height:20px;accent-color:var(--lime)}
input[type=range]{width:100%;accent-color:var(--lime)}
.privacy{color:var(--dim);font-size:12.5px;text-align:center;margin:22px auto 0;max-width:46ch}
.permhelp{text-align:left;margin:4px 0 0;font-size:13.5px;color:#dfe7e2;background:rgb(0 0 0/.35);border:1px solid var(--line);border-radius:12px;padding:10px 12px;max-width:40ch}
.warn{color:var(--amber)}
body[data-step=knock] .forsetup,body[data-step=green] .forsetup,body[data-step=live] .forsetup,body[data-step=over] .forsetup{display:none!important}
body[data-step=over] .stagewrap{display:none}
body[data-step=setup] .forjoined,body[data-step=over] .forjoined{display:none!important}
@media (max-width:560px){.devices{grid-template-columns:1fr}details.more .btns{grid-template-columns:1fr}.stage{aspect-ratio:4/3;border-radius:20px}}`;

/** The /tv + /g page. Element ids are the contract with relay/tvguest/main.ts (do not rename). */
export function guestPageHtml(p: GuestPage) {
  const host = esc(p.host);
  const body = `<main class="wrap guest">
<section class="intro forsetup"><p class="eyebrow" id="eyebrow">${p.invite ? 'You’re invited' : 'Join in your browser'}</p>
<h1 id="title" data-host="${host}">${esc(p.title)}</h1><p class="lede" id="who"></p>
<ol class="progress" id="progress" aria-label="Steps"></ol></section>
<div class="stagewrap"><div class="stage"><video id="preview" muted playsinline autoplay></video>
<div class="off" id="camoff">${icon('cam')}<b id="camofft">Your camera will show up here</b><p class="note" id="camoffn">Your browser will ask to use your camera and microphone. Tap <b>Allow</b>.</p></div>
<span class="tag air"><i></i>ON THE SHOW</span><span class="tag gr"><i></i>GREEN ROOM</span>
<div class="meter" title="Your microphone" aria-hidden="true"><span>Mic</span><b><i id="meter"></i></b></div></div>
<p class="hint forsetup" id="michint">Say hi. The bar moves when your mic hears you.</p></div>
<section class="panel forsetup" id="setup">
<label id="namerow" class="field"${p.invite ? '' : ' hidden'}><span>Your name, as everyone will see it</span><input type="text" id="name" maxlength="32" autocomplete="nickname" enterkeyhint="go" placeholder="Type your name"></label>
<button id="start" class="btn" type="button">${icon('cam')}Turn on my camera</button>
<button id="join" class="btn" type="button" disabled>Join the show</button><p class="joinhint" id="joinhint"></p>
<div class="devices"><label class="field"><span>Camera</span><select id="cam"></select></label><label class="field"><span>Microphone</span><select id="mic"></select></label></div>
<label class="switchrow"><input type="checkbox" id="voice" role="switch"><span><b>${p.invite ? 'Talk through this page' : 'I’m not in Discord voice'}</b><small>${p.invite ? `You and ${host} hear each other right here. Already in a Discord call with them? Turn this off, or they’ll hear you twice.` : `Talk to ${host} through this page instead. Leave it off if you’re in their Discord call.`} Headphones stop echo.</small></span></label>
</section>
<p id="status" role="status" aria-live="polite"></p>
<button id="leave" class="btn danger forjoined" type="button">Leave the show</button><p class="note" id="members"></p>
<details id="more" class="more forsetup"><summary>More options: how you appear, quality, VTube Studio</summary><div class="in">
<div class="btns"><button id="window" class="btn secondary" type="button">Share a window instead</button><button id="spoutbtn" class="btn secondary" type="button">My model is in a Spout2 app</button></div>
<label class="field"><span>Join as</span><select id="look"></select></label><label class="field"><span>What to show</span><select id="kind"></select></label>
<label class="field" id="skinrow"><span>Your TV</span><select id="skin"></select></label><label class="field"><span>Quality</span><select id="preset"></select></label>
<label class="check"><input type="checkbox" id="mirror"><span>Mirror my picture</span></label>
<div id="vtsbox"><label class="field"><span>Key out</span><select id="key"></select></label><label class="field"><span>Zoom on face</span><input type="range" id="zoom" min="1" max="4" step="0.05"></label>
<p class="note" id="vtsnote">VTube Studio: Background → Color Picker Background → pure green, with “Transparent” OFF; Settings → Virtual Webcam → Enable, then pick “VTubeStudioCam” above (or Share a window → the VTube Studio window).</p></div>
<div id="spoutbox"><label class="field"><span>Your app</span><select id="spoutapp"></select></label><p class="note" id="spoutfound"></p><ol class="note" id="spoutsteps" style="padding-left:18px;margin:4px 0"></ol>
<p class="note">A browser can’t read Spout2 or transparency: your model comes through a webcam bridge on a solid colour and is cut out by the key above. Glass, glow and very wispy hair lose their see-through bits, and a green outfit needs Magenta. Real transparency needs VTube Pro on your PC.</p></div></div></details>
<p class="privacy">Your camera${p.invite ? ' and voice go' : ' goes'} only to ${host}’s show. Viewers see you only while ${host} is streaming. VTube Pro doesn’t record or store it, but ${host}’s stream may be saved. ${p.invite ? `The name you type is shown to ${host} as “not verified”. ` : ''}Closing this tab leaves the show.</p>
</main>
<script nonce="${p.nonce}">window.VTP_INVITE=${p.invite ? 'true' : 'false'};${p.js}</script>`;
  return shellHtml(p.title, body, { og: p.og, origin: p.origin, host: p.host, css: GUEST_CSS });
}

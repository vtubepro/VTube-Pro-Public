// Chat secrets stay on this computer (lane stream-setup; the same rule as the OBS
// password, server/obs.ts checkObsWrite):
//   * from any Origin that is not a page on this PC a write may not set or clear the
//     Rumble Live Stream key, and may not point a connector at another address (that would hand the stored key to
//     it): PUT /api/chat/config with rumble.apiKey / clearRumbleKey / an endpoint override → 403 {code:'local-only'};
//   * the helper's own page /chat/connect (top-level tab, this PC only: localGuard + no framing) is where the Rumble
//     link is pasted. The studio opens it with helperPageUrl('/chat/connect#rumble').
//   There is no sign-in of any kind in this build: Twitch, Kick and YouTube chat are read from a public channel name / link.
// Everything else (channel names, on / off, the test buttons, status) stays open to pages on this PC:
// server/localGuard.ts already answers other sites 403 before this runs.
import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { isWebOrigin } from '../localGuard.ts';
import { requireLocal } from '../routes/util.ts';


export const LOCAL_ONLY_MSG = 'Keys are added in VTube Pro on this computer (it opens in a new tab). They never go through a web page.';
/** Fields that repoint a connector (tests / power users): never from a web page. */
const ENDPOINTS: Record<string, string[]> = { kick: ['apiBase', 'realtimeBase', 'pusher', 'sevenTvBase'], rumble: ['apiBase', 'ssePath'], youtube: ['base'], twitch: ['irc'] };
const filled = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== false;

export type ChatWriteVerdict = { ok: true } | { ok: false; status: 403; code: 'local-only'; error: string; field: string };
/** Pure policy (unit-tested in tools/stream_setup_unit.ts). */
export function checkChatWrite(method: string, pathName: string, origin: string | undefined, body: unknown): ChatWriteVerdict {
  if (!isWebOrigin(origin) || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return { ok: true };
  const no = (field: string): ChatWriteVerdict => ({ ok: false, status: 403, code: 'local-only', error: LOCAL_ONLY_MSG, field });
  if (/^\/chat\/connect\/?$/.test(pathName)) return no('page');
  if (pathName !== '/api/chat/config') return { ok: true };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (b.clearRumbleKey === true) return no('clearRumbleKey');
  const sec = (p: string) => (b[p] && typeof b[p] === 'object' ? b[p] as Record<string, unknown> : {});
  if (filled(sec('rumble').apiKey)) return no('rumble.apiKey');
  for (const [p, keys] of Object.entries(ENDPOINTS)) for (const k of keys) if (filled(sec(p)[k])) return no(`${p}.${k}`);
  return { ok: true };
}

/** Mounted FIRST on chatRoutes (server/routes/chat.ts), after express.json(). */
export function chatWriteGuard(req: Request, res: Response, next: NextFunction) {
  const p = (req.url ?? '').split('?')[0];
  if (!/^\/(api\/chat\/|chat\/)/.test(p)) { next(); return; }
  const v = checkChatWrite(req.method, p, typeof req.headers.origin === 'string' ? req.headers.origin : undefined, req.body);
  if (!v.ok) { res.status(v.status).json({ error: v.error, code: v.code }); return; }
  next();
}

// ---------------------------------------------------------------- the helper's own page
/** This PC only: no web Origin, and a cross-site / same-site browser request only as a top-level navigation. */
function pageLocal(req: Request) {
  const o = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (o && isWebOrigin(o)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return req.headers['sec-fetch-mode'] === 'navigate' && req.method === 'GET';
  return true;
}

export const connectPageRoutes = Router();
connectPageRoutes.get(['/chat/connect', '/chat/connect/'], (req, res) => {
  requireLocal(req);
  if (!pageLocal(req)) { res.status(403).json({ error: 'Open this page on this computer' }); return; }
  const sn = crypto.randomBytes(16).toString('base64url');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${sn}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(CONNECT_PAGE.replace('__SN__', sn));
});

// One page, two cards (#rumble, #tiktok): the pasted Rumble link and TikFinity. Same brand as the helper's other pages (BRAND.md tokens, no web fonts).
export const CONNECT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VTube Pro · Your chat</title>
<style>
:root{color-scheme:dark;--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--err:#ff6b6b;--amber:#ffcf6a}
*{box-sizing:border-box}html{background:var(--ink)}body{margin:0;min-height:100vh;background:radial-gradient(1100px 560px at 15% -10%,#12301e55,transparent),var(--ink);color:var(--fg);font:16px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:620px;margin:0 auto;padding:32px 16px 56px}
.brand{display:flex;align-items:center;gap:10px;font:700 17px/1 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em}
.beta{border:1px solid rgb(123 216 143/.3);background:rgb(123 216 143/.1);color:var(--lime);font:500 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;padding:4px 7px;border-radius:99px}
h1{font:700 28px/1.15 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;margin:22px 0 6px}h2{font:700 20px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif;margin:0 0 4px;display:flex;align-items:center;gap:10px}
p{color:var(--mute);margin:6px 0}b{color:var(--fg)}
section{background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);border-radius:18px;padding:20px;margin:16px 0;box-shadow:inset 0 1px 0 rgb(255 255 255/.06)}
section:target{border-color:rgb(123 216 143/.45)}
.eyebrow{display:flex;align-items:center;gap:10px;font:500 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--lime);margin-bottom:10px}.eyebrow i{width:24px;height:1px;background:var(--lime)}
button{font:600 16px/1 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;border-radius:12px;padding:15px 20px;border:1px solid var(--line-strong);background:rgb(255 255 255/.06);color:var(--fg);cursor:pointer;width:100%;margin-top:6px;transition:background .18s cubic-bezier(.16,1,.3,1)}
button.primary{background:var(--lime);color:var(--ink);border-color:transparent}button.primary:hover{background:var(--lime-hi)}button:disabled{opacity:.6;cursor:progress}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--lime);outline-offset:3px}
input{font:inherit;width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--line-strong);background:var(--ink-2);color:var(--fg);margin:6px 0 4px}
label{font-size:14px;color:var(--mute);display:block;margin-top:10px}a{color:var(--sky)}
ol{color:var(--mute);padding-left:20px;margin:8px 0}li{margin:4px 0}
details summary{cursor:pointer;color:var(--mute);margin-top:6px}
.out{margin-top:12px;font-size:15px;min-height:1.5em}.out.ok{color:var(--lime)}.out.err{color:var(--err)}
.dot{width:12px;height:12px;border-radius:50%;flex:none}
small{color:var(--mute)}code{font:13px ui-monospace,Consolas,monospace;background:var(--ink-2);border:1px solid var(--line);border-radius:6px;padding:2px 6px;word-break:break-all}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main>
<div class="brand">VTube Pro <span class="beta">Beta</span></div>
<h1>Connect your chat</h1>
<p>Keys are added here, on this computer. They are <b>never</b> sent to a website, and never shown again.</p>

<section id="rumble"><div class="eyebrow"><i></i>Rumble</div>
<h2><span class="dot" style="background:#85c742"></span>Add your Rumble link</h2>
<ol><li>Open <a href="https://rumble.com/account/livestream-api" target="_blank" rel="noopener noreferrer">Rumble’s Live Stream page</a> in your browser.</li><li>Copy the whole link it shows you.</li><li>Paste it here and press <b>Save my Rumble link</b>.</li></ol>
<label for="rk">Your Live Stream link</label><input id="rk" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the whole link from Rumble">
<button class="primary" id="rsave">Save my Rumble link</button>
<details><summary>Remove my Rumble link</summary><button id="rclear">Remove it from this computer</button></details>
<div class="out" id="rout" role="status"></div></section>

<section id="tiktok"><div class="eyebrow"><i></i>TikTok</div>
<h2><span class="dot" style="background:#fe2c55"></span>TikTok through TikFinity</h2>
<p>TikTok doesn’t share LIVE chat with other apps. The free <a href="https://tikfinity.zerody.one/" target="_blank" rel="noopener noreferrer">TikFinity</a> app does it for you.</p>
<ol><li>Download TikFinity, open it and connect it to your TikTok.</li><li>Keep it open while you stream. VTube Pro finds it by itself.</li></ol>
<button id="tcheck">Check for TikFinity</button><div class="out" id="kout" role="status"></div></section>

<p><small>Close this tab when you’re done.</small></p>
</main>
<script nonce="__SN__">
const $=(id)=>document.getElementById(id);
// one big green button per visit: the card the studio sent you to (#rumble, #tiktok)
{const t=(location.hash||'#rumble').slice(1);for(const s of document.querySelectorAll('section'))if(s.id!==t)for(const b of s.querySelectorAll('button.primary'))b.classList.remove('primary');}
async function call(u,m,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function say(id,ok,t){const o=$(id);o.className='out '+(ok?'ok':'err');o.textContent=t}
async function state(p){try{const s=await call('/api/chat/status','GET');return s.platforms[p]}catch{return null}}
function wait(p,id,okText){let n=0;const t=setInterval(async()=>{n++;const s=await state(p);if(s&&s.state==='live'){clearInterval(t);say(id,true,okText)}else if(s&&s.state==='waiting'&&p!=='tiktok'){clearInterval(t);say(id,true,'Saved ✔ Your chat shows up when you go live.')}else if(s&&s.state==='error'){clearInterval(t);say(id,false,p==='rumble'?'Rumble didn’t accept that link. Copy the whole link again.':'Something went wrong. Try again.')}else if(n>20){clearInterval(t);say(id,p!=='tiktok',p==='tiktok'?'We can’t see TikFinity yet. Open it, then press Check again.':'Saved ✔ It connects in a moment.')}},1000)}
$('rsave').onclick=async()=>{const v=$('rk').value.trim();if(!v){say('rout',false,'Paste your Live Stream link first.');return}
 try{await call('/api/chat/config','PUT',{rumble:{enabled:true,apiKey:v}});$('rk').value='';say('rout',true,'Saved. Checking with Rumble…');wait('rumble','rout','I can see your Rumble channel ✔ You can close this tab.')}catch(e){say('rout',false,'That didn’t save. Is VTube Pro still running?')}};
$('rclear').onclick=async()=>{try{await call('/api/chat/config','PUT',{clearRumbleKey:true});say('rout',true,'Removed from this computer.')}catch{say('rout',false,'That didn’t work. Try again.')}};
call('/api/chat/config','GET').then((c)=>{if(c.rumble&&c.rumble.hasKey)say('rout',true,'Your Rumble link is saved ✔')}).catch(()=>{});
$('tcheck').onclick=async()=>{try{await call('/api/chat/config','PUT',{tiktok:{enabled:true}});say('kout',true,'Looking for TikFinity…');wait('tiktok','kout','TikFinity is connected ✔ You can close this tab.')}catch{say('kout',false,'That didn’t work. Is VTube Pro still running?')}};
</script></body></html>`;

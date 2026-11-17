// The AI connectors page (served at http://127.0.0.1:5191/aiconnect, also opened from the studio). Plain HTML + JS so it
// works in dev and in the built app and needs no bundler entry. Makes no sound. Docs: docs/AI_CONNECT.md.
export const AICONNECT_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI connectors - VTube Pro</title>
<style>
:root{color-scheme:dark;--bg:#06080a;--card:#0e1317;--card2:#131a1f;--line:rgb(255 255 255/.09);--fg:#eef3ef;--mute:#a3afa9;--dim:#8b9791;--acc:#7bd88f;--acc-hi:#a6f5b4;--sky:#6cc7f5;--ok:#7bd88f;--warn:#ffcf6a;--bad:#ff7b7b;--r:14px;--ease:cubic-bezier(.16,1,.3,1);--state:var(--ok)}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:radial-gradient(800px 340px at 50% -10%,rgb(123 216 143/.07),transparent 70%),var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
main{max-width:1040px;margin:0 auto;padding:20px 16px 64px}.vtp-docked main{padding-top:12px}.vtp-docked .top{padding-right:130px}
.top{display:flex;align-items:center;gap:10px;margin:0 0 14px}.top svg{width:28px;height:28px;flex:none}
h1{font-size:22px;line-height:1.2;letter-spacing:-.01em;margin:0}h2{font-size:16px;line-height:1.3;margin:0 0 8px}
.beta{font:600 10px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--acc);border:1px solid rgb(123 216 143/.35);background:rgb(123 216 143/.08);border-radius:999px;padding:4px 8px}
.sub{color:var(--mute);margin:0 0 16px;max-width:760px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;margin:0 0 12px}
section,details.sec{background:linear-gradient(180deg,rgb(255 255 255/.045),rgb(255 255 255/.018));border:1px solid var(--line);border-radius:var(--r);padding:16px;margin:0 0 12px;box-shadow:inset 0 1px 0 rgb(255 255 255/.05)}
.grid>section{margin:0}
details.sec>summary{cursor:pointer;font-size:16px;font-weight:700;list-style:none;display:flex;align-items:center;gap:8px;min-height:28px}
details.sec>summary::-webkit-details-marker{display:none}details.sec>summary::before{content:"";width:8px;height:8px;border-right:2px solid var(--mute);border-bottom:2px solid var(--mute);transform:rotate(-45deg);transition:transform .2s var(--ease);flex:none}
details.sec[open]>summary::before{transform:rotate(45deg)}details.sec[open]>summary{margin:0 0 8px}
section,details.sec,.top,.sub{animation:rise .28s var(--ease) both}section:nth-of-type(2){animation-delay:.04s}.grid>section:nth-child(n+2){animation-delay:.08s}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;background:var(--acc);color:#06080a;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;transition:background-color .18s,transform .18s var(--ease),opacity .18s}
button:hover,.btn:hover{background:var(--acc-hi);color:#06080a}button:active,.btn:active{transform:scale(.97)}
button.s{background:var(--card2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}button.s:hover{background:#1b252c;color:var(--fg)}
button.d{background:var(--bad);color:#06080a}button.d:hover{background:#ff9a9a}button:disabled{opacity:.5;cursor:default;transform:none}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:8px}
pre,textarea,input,select{background:#080b0e;color:var(--fg);border:1px solid var(--line);border-radius:10px;font:12.5px/1.45 ui-monospace,Consolas,Menlo,monospace;transition:border-color .18s}
input:focus,textarea:focus,select:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px rgb(123 216 143/.2)}
::placeholder{color:#8b9791;opacity:1}
pre{padding:10px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;margin:8px 0}textarea{width:100%;padding:10px;resize:vertical}input,select{padding:8px;max-width:100%}
code{font:12.5px ui-monospace,Consolas,Menlo,monospace;background:#080b0e;border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.pill{display:inline-block;white-space:nowrap;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600;background:var(--card2);border:1px solid var(--line);color:var(--fg);vertical-align:1px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.pill.warn{border-color:rgb(255 207 106/.4)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.mute{color:var(--mute)}a{color:var(--sky);transition:color .18s}a:hover{color:#9bdcff}
details summary{cursor:pointer;color:var(--mute);min-height:28px}details summary:hover{color:var(--fg)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;font-size:13px;vertical-align:top}th{color:var(--mute);font-weight:600}
#chatlog{max-height:420px;overflow:auto}.ev{margin:4px 0;padding:8px 10px;border-radius:10px;background:var(--card2)}.ev img{max-width:min(260px,100%);display:block;margin-top:4px}
/* the one status at the top: calm green, amber when an AI is waiting or the helper cannot be reached */
.status{border-radius:var(--r);padding:16px 18px;margin:0 0 12px;border:1px solid color-mix(in srgb,var(--state) 35%,transparent);background:color-mix(in srgb,var(--state) 7%,var(--card));transition:background-color .3s,border-color .3s}
.status h2{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:17px;margin:0}.status #appr{margin-top:8px}
.status[data-s=waiting],.status[data-s=attention]{--state:var(--warn)}.status[data-s=waiting]{border-width:2px}
.pip{position:relative;width:10px;height:10px;border-radius:50%;background:var(--state);flex:none;transition:background-color .3s}
.pip::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--state);opacity:0;animation:breathe 2.6s ease-out infinite}
.status[data-s=waiting] .pip::after{animation-duration:1.4s}
@keyframes breathe{0%{opacity:.55;transform:scale(1)}70%,100%{opacity:0;transform:scale(2.8)}}
.appr-item{padding:10px 0}.appr-item+.appr-item{border-top:1px solid var(--line)}
.hero{border-color:rgb(123 216 143/.28)}body[data-s=waiting] .hero .btn{background:var(--card2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}
.status[data-s=idle] #apprCount,.status[data-s=attention] #apprCount{display:none}
@media (max-width:480px){#scopes td:nth-child(3){display:none}.row button,.row .btn{flex:1 1 auto}.row input,.row select{flex:1 1 100%;width:100%}h1{font-size:19px}}
html[data-hidden] *,html[data-hidden] *::after{animation-play-state:paused!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.pip::after{opacity:0}}
</style></head><body><main>
<div class="top"><svg viewBox="8 16 84 72" aria-hidden="true"><defs><linearGradient id="lg" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient></defs><path fill="url(#lg)" d="M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z"/></svg><h1>AI connectors</h1><span class="beta">Beta</span></div>
<p class="sub">Let your own AI app (Claude, ChatGPT, Grok ...) or a model on this PC build rooms and more in VTube Pro. Full guide: <code>docs/AI_CONNECT.md</code>. Nothing here changes your stream unless you click Approve.</p>

<section id="apprBox" class="status" data-s="idle" aria-live="polite"><h2><span class="pip" aria-hidden="true"></span><span id="apprTitle">Nothing is waiting for your OK</span> <span id="apprCount" class="pill">0</span></h2><div id="appr" class="mute">No AI is waiting for you.</div></section>

<section class="hero"><h2>New here? Connect an AI in 3 steps</h2><p class="mute" style="margin:0 0 12px">The AI app you already use (Claude, ChatGPT, Grok, Cursor ...) or a free model on this PC: one page each, with a Test button. VTube Pro holds no AI account or key.</p><a id="wizLink" class="btn" href="/aiconnect/connect">Connect an AI</a></section>
<script>(function(){var a=document.getElementById('wizLink');if(a)a.href='/aiconnect/connect'+location.search})()</script>

<div class="grid">
<section><h2>Claude Desktop</h2><div id="cd"></div>
<div class="row"><button id="cdAdd">Add to Claude Desktop</button></div>
<p class="mute">Writes a "vtube-pro" entry into Claude Desktop's config and keeps a backup of the old file. Then quit Claude Desktop fully and reopen it.</p>
<details><summary>Or paste it yourself</summary><pre id="cdJson"></pre></details></section>

<section><h2>Claude Code</h2><p class="mute">Inside this folder it already works (.mcp.json). Anywhere else, run:</p><pre id="cc"></pre><button class="s" data-copy="cc">Copy</button></section>

<section><h2>Grok Build (CLI)</h2><p class="mute">Grok Build runs local MCP servers too:</p><pre id="gb"></pre><button class="s" data-copy="gb">Copy</button>
<details><summary>~/.grok/config.toml</summary><pre id="gbt"></pre></details></section>

<section><h2>ChatGPT and grok.com on the web</h2><p class="mute">These only take an HTTPS address, so they need the <b>Remote connector</b> below plus a tunnel, or the <b>Instruction pack</b> (works with any chat AI, no setup).</p></section>

<section><h2>Other AI tools on this PC</h2><p class="mute">For agent tools such as LangChain, the OpenAI Agents SDK or LM Studio (a local HTTP MCP address):</p><pre id="lh"></pre><button class="s" data-copy="lh">Copy</button></section>

<section><h2>Blender</h2><div id="bl"></div></section>
</div>

<section><h2>Permissions</h2><p class="mute">Changing the live stream and running Blender Python always need your click.</p><div class="tw"><table id="scopes"></table></div></section>

<section><h2>Local setup (no cloud, no keys)</h2>
<p><a href="/local-ai" target="_blank" rel="noopener"><b>Which local AI fits my computer?</b></a> <span class="mute">Opens the Local AI page: it asks first, then checks your graphics card and recommends a chat model and a ComfyUI setup with step-by-step install help.</span></p>
<div class="tw"><table><tr><th>Tool</th><th>Status</th><th>Get it (official)</th></tr>
<tr><td>Ollama</td><td id="stOl"></td><td><a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a></td></tr>
<tr><td>LM Studio</td><td id="stLm"></td><td><a href="https://lmstudio.ai/download" target="_blank" rel="noopener">lmstudio.ai/download</a></td></tr>
<tr><td>ComfyUI</td><td id="stCf"></td><td><a href="https://www.comfy.org/download" target="_blank" rel="noopener">comfy.org/download</a> - <a href="https://github.com/comfyanonymous/ComfyUI" target="_blank" rel="noopener">GitHub</a></td></tr>
<tr><td>SDXL base 1.0 (for ComfyUI)</td><td class="mute">put in ComfyUI/models/checkpoints</td><td><a href="https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0" target="_blank" rel="noopener">Hugging Face</a></td></tr>
<tr><td>Blender</td><td id="stBl"></td><td><a href="https://www.blender.org/download/" target="_blank" rel="noopener">blender.org/download</a></td></tr></table></div>
<p class="mute">Which model fits your graphics card changes every few months: the <a href="/local-ai" target="_blank" rel="noopener">Local AI page</a> checks your PC (after asking) and gives today's best pick with the exact download command. Then use <a href="/aiconnect/connect#local">Connect an AI &rarr; A model on this PC</a>.</p>
<p class="mute">Recommended local workflow: describe a room -> the local model plans it with the guide -> ComfyUI paints textures -> Blender builds it -> validate -> install. Use "Create with AI" below with Ollama. More example workflows coming soon.</p>
<div class="row"><button class="s" id="recheck">Re-check</button></div></section>

<section><h2>Create with AI (built-in, for a model on this PC)</h2>
<div class="row"><select id="prov"></select><input id="model" placeholder="model (blank = default)" size="24"><input id="burl" placeholder="address on this PC (blank = default)" size="26"><button class="s" id="saveProv">Save</button></div>
<div class="row"><select id="lmodels"></select><span class="mute" id="toolWarn"></span></div>
<div id="chatlog"></div>
<div class="row"><textarea id="msg" rows="3" placeholder="e.g. Build a cosy neon ramen bar room with 4 stools, a booth for 3, a react screen over the counter."></textarea></div>
<div class="row"><button id="send">Send</button><span id="usage" class="mute"></span></div></section>

<section><h2>Instruction pack + import (any AI)</h2>
<p class="mute">1. Copy the pack and paste it into any AI chat with your request. 2. Paste the JSON it returns here. 3. Validate, then Build (runs Blender on this PC and installs the room).</p>
<div class="row"><button class="s" id="copyPack">Copy instruction pack</button></div>
<textarea id="pkg" rows="6" placeholder='{"format":"vtube-pro.creation/1", ...}'></textarea>
<div class="row"><button class="s" id="val">Validate</button><button id="build">Build + install</button></div><pre id="valOut" class="mute"></pre>
<h2>Inbox</h2><div id="inbox" class="mute">Nothing sent yet.</div><pre id="jobOut" class="mute"></pre></section>

<details class="sec" id="remoteSec"><summary>Remote connector (ChatGPT / grok.com on the web) <span class="pill warn">advanced</span></summary>
<p class="warn">Off by default. When on, anyone with the full address can read your avatar list, render previews and drop packages in the inbox. They can never run Blender, change the stream or edit your library. Keep the address secret and switch it off when done.</p>
<div class="row"><label><input type="checkbox" id="remoteOn"> Remote connector on</label></div>
<ol class="mute"><li>Start the listener: <code>npx tsx server/mcpRemote.ts</code></li><li>Start a tunnel: <code>cloudflared tunnel --url http://127.0.0.1:5193</code> (or <code>ngrok http 5193</code>)</li><li>Paste the tunnel host below and copy the connector URL into ChatGPT / Grok (authentication: none).</li></ol>
<div class="row"><input id="thost" placeholder="https://xxxx.trycloudflare.com" size="40"></div><pre id="rurl"></pre><button class="s" data-copy="rurl">Copy</button></details>
</main>
<script>
const $=(id)=>document.getElementById(id);const j=async(u,o)=>{const r=await fetch(u,o);const t=await r.text();let d;try{d=JSON.parse(t)}catch{d=t}if(!r.ok)throw new Error(d&&d.error||t);return d};
const post=(u,b,m)=>j(u,{method:m||'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imgSrc=(s)=>/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(String(s||''))?s:'';
let S=null,session=null,since=0,token='';
document.addEventListener('click',e=>{const id=e.target.dataset&&e.target.dataset.copy;if(id){navigator.clipboard.writeText($(id).textContent);e.target.textContent='Copied'}});
async function load(){S=await j('/api/aiconnect/status');const c=S.claudeDesktop;
$('cd').innerHTML=c.installed?('<span class=ok>Found</span> '+esc(c.configPath)+(c.hasEntry?'<br><span class=ok>vtube-pro is already added.</span>':'')):'<span class=warn>Claude Desktop not found.</span> Get it at <a href="https://claude.ai/download" target=_blank>claude.ai/download</a>.';
$('cdAdd').disabled=!c.configPath;$('cdJson').textContent=S.snippets.claudeDesktopJson;$('cc').textContent=S.snippets.claudeCode;$('gb').textContent=S.snippets.grokBuild;$('gbt').textContent=S.snippets.grokToml;
$('lh').textContent='URL: '+S.snippets.localHttpUrl+'\nHeader: '+S.snippets.localHttpHeader+'\nTools: '+S.tools.length;
$('bl').innerHTML=S.blender.available?'<span class=ok>Blender '+esc(S.blender.version)+'</span> '+esc(S.blender.path):'<span class=bad>Blender not found.</span> Rooms are built with Blender. <button id=blI>Install Blender (opens winget)</button> or <a href="https://www.blender.org/download/" target=_blank>download it</a>.';
if($('blI'))$('blI').onclick=async()=>{const r=await post('/api/aiconnect/install-blender',{confirm:true});alert(r.next)};
const L=S.local,st=(x,n)=>x.running?'<span class=ok>running</span>'+(n!=null?' - '+n+' models':''):'<span class=mute>not running</span>';
$('stOl').innerHTML=st(L.ollama,L.ollama.models.length);$('stLm').innerHTML=st(L.lmstudio,L.lmstudio.models.length);$('stCf').innerHTML=st(L.comfy)+(L.comfy.vramMB?' - '+L.comfy.vramMB+' MB VRAM':'');$('stBl').innerHTML=S.blender.available?'<span class=ok>installed</span>':'<span class=bad>missing</span>';
const sc=S.conf.scopes,opts={read:['allow','deny'],render:['allow','deny'],create:['allow','ask','deny'],library:['allow','ask','deny'],live:['ask','deny'],python:['ask','deny'],diag:['allow','deny']};
$('scopes').innerHTML=Object.keys(opts).map(k=>'<tr><td>'+esc(S.scopeLabels[k])+'</td><td><select data-scope="'+k+'">'+opts[k].map(o=>'<option'+(o===sc[k]?' selected':'')+'>'+o+'</option>').join('')+'</select></td><td class=mute>'+S.tools.filter(t=>t.scope===k).map(t=>t.name).join(', ')+'</td></tr>').join('');
document.querySelectorAll('[data-scope]').forEach(s=>s.onchange=()=>post('/api/aiconnect/scopes',{scopes:{[s.dataset.scope]:s.value}},'PUT'));
if(!$('prov').options.length){$('prov').innerHTML=S.providers.map(p=>'<option value="'+p.id+'">'+esc(p.label)+'</option>').join('');}
const lm=[...L.ollama.models.map(m=>['ollama',m]),...L.lmstudio.models.map(m=>['lmstudio',m])];
$('lmodels').innerHTML='<option value="">local models found: '+lm.length+'</option>'+lm.map(([p,m])=>'<option value="'+p+'|'+esc(m.name)+'">'+p+': '+esc(m.name)+(m.tools?'':' (no tool calling - JSON mode)')+'</option>').join('');
$('remoteOn').checked=S.conf.remote.enabled;token=S.conf.remote.token;rurl();}
$('lmodels').onchange=()=>{const v=$('lmodels').value;if(!v)return;const[p,m]=v.split('|');$('prov').value=p;$('model').value=m;$('toolWarn').textContent=/no tool/.test($('lmodels').selectedOptions[0].text)?'This model has no native tool calling; VTube Pro uses JSON-plan mode (slower, less reliable).':''};
function rurl(){const h=$('thost').value.trim().replace(/\/+$/,'');$('rurl').textContent=S&&S.conf.remote.enabled&&token?(h||'https://<tunnel-host>')+'/t/'+token+'/mcp':'(switch the remote connector on first)'}
$('thost').oninput=rurl;$('remoteOn').onchange=async()=>{if($('remoteOn').checked&&!confirm('Turn on the remote connector? Anyone with the full address can read your avatar list and send packages to your inbox.')){$('remoteOn').checked=false;return}const c=await post('/api/aiconnect/remote',{enabled:$('remoteOn').checked});S.conf=c;token=c.remote.token;rurl()};
$('cdAdd').onclick=async()=>{try{const r=await post('/api/aiconnect/claude-desktop',{confirm:true});alert('Added. '+(r.backup?'Backup: '+r.backup+'\n':'')+r.next);load()}catch(e){alert(e.message)}};
$('recheck').onclick=load;
function setStatus(k,t){$('apprBox').setAttribute('data-s',k);document.body.setAttribute('data-s',k);$('apprTitle').textContent=t;$('appr').className=k==='idle'?'mute':''}
let lastAppr='';
async function appr(){try{const p=await j('/api/aiconnect/approvals');const key=JSON.stringify(p);if(key===lastAppr&&$('apprBox').getAttribute('data-s')!=='attention')return;lastAppr=key;$('apprCount').textContent=p.length;setStatus(p.length?'waiting':'idle',p.length?'An AI is waiting for your OK':'Nothing is waiting for your OK');
$('appr').innerHTML=p.length?p.map(a=>'<div class=appr-item><b>'+esc(a.client)+'</b> wants to run <b>'+esc(a.tool)+'</b> ('+esc(a.scope)+')<pre>'+esc(a.summary)+'</pre><div class=row><button data-a="'+a.id+'|approve">Approve once</button><button class=s data-a="'+a.id+'|session" title="Every '+esc(a.tool)+' call from '+esc(a.client)+' for 30 minutes, whatever it asks">Approve all '+esc(a.tool)+' calls for 30 min (any arguments)</button><button class=d data-a="'+a.id+'|deny">Deny</button></div></div>').join(''):'No AI is waiting for you.';
document.querySelectorAll('[data-a]').forEach(b=>b.onclick=async()=>{const[id,d]=b.dataset.a.split('|');await post('/api/aiconnect/approvals/'+id,{decision:d});appr()})}catch{setStatus('attention','Cannot reach VTube Pro');$('appr').textContent='Start VTube Pro again, then reload this page.'}}
$('saveProv').onclick=async()=>{await post('/api/aiconnect/provider',{id:$('prov').value,baseUrl:$('burl').value||undefined,model:$('model').value||undefined});alert('Saved on this PC.')};
function ev(e){if(e.kind==='usage'){const u=e.usage;$('usage').textContent='tokens: '+u.promptTokens+' in / '+u.completionTokens+' out';return}if(e.kind==='done'){$('send').disabled=false;return}
const d=document.createElement('div');d.className='ev';d.innerHTML='<span class=pill>'+esc(e.kind)+(e.tool?' '+esc(e.tool):'')+'</span> '+(e.image?(imgSrc(e.image)?'<img src="'+imgSrc(e.image)+'">':'[image]'):esc(e.text||''));$('chatlog').appendChild(d);$('chatlog').scrollTop=1e9}
async function poll(){if(!session)return;const r=await j('/api/aiconnect/agent/'+session+'?since='+since);since=r.next;r.events.forEach(ev);if(r.busy)setTimeout(poll,1200)}
$('send').onclick=async()=>{const m=$('msg').value.trim();if(!m)return;$('send').disabled=true;try{const r=await post('/api/aiconnect/agent/chat',{sessionId:session,provider:$('prov').value,model:$('model').value||undefined,message:m});session=r.sessionId;$('msg').value='';poll()}catch(e){$('send').disabled=false;alert(e.message)}};
$('copyPack').onclick=async()=>{const t=await (await fetch('/api/aiconnect/pack')).text();await navigator.clipboard.writeText(t);$('copyPack').textContent='Copied ('+Math.round(t.length/1000)+' KB)'};
const pkg=()=>{try{return JSON.parse($('pkg').value.replace(/^[^{]*/,'').replace(/[^}]*$/,''))}catch(e){throw new Error('That is not JSON: '+e.message)}};
const show=(r)=>{$('valOut').textContent=(r.ok?'OK - ready to build':'Not ready')+'\n'+r.errors.map(e=>'ERROR '+e.msg+'\n  fix: '+e.fix).join('\n')+'\n'+r.warnings.map(e=>'warning '+e.msg+'\n  fix: '+e.fix).join('\n')};
$('val').onclick=async()=>{try{show(await post('/api/aiconnect/package/validate',{package:pkg()}))}catch(e){$('valOut').textContent=e.message}};
async function job(id){const r=await j('/api/jobs/'+id);$('jobOut').textContent=r.status+' '+Math.round((r.progress||0)*100)+'%\n'+(r.log||[]).slice(-14).join('\n');if(r.status!=='succeeded'&&r.status!=='failed')setTimeout(()=>job(id),1500)}
$('build').onclick=async()=>{try{const p=pkg();if(!confirm('Build "'+p.id+'"? This runs the package\'s Blender script on this PC (read it first), then installs the room.'))return;const r=await post('/api/aiconnect/package/install',{package:p,approved:true});job(r.jobId)}catch(e){$('jobOut').textContent=e.message}};
async function inbox(){const l=await j('/api/aiconnect/inbox');$('inbox').innerHTML=l.length?l.map(i=>'<div class=row><span>'+esc(i.from)+': <b>'+esc(i.name||i.id)+'</b> ('+esc(i.action)+') '+(i.ok?'<span class=ok>valid</span>':'<span class=bad>has errors</span>')+'</span><button class=s data-view="'+esc(i.inboxId)+'">Review</button><button data-b="'+esc(i.inboxId)+'"'+(i.ok?'':' disabled')+'>Build</button></div>').join(''):'Nothing sent yet.';
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=async()=>{$('pkg').value=JSON.stringify(await j('/api/aiconnect/inbox/'+b.dataset.view),null,2)});
document.querySelectorAll('[data-b]').forEach(b=>b.onclick=async()=>{if(!confirm('Build this package? It runs its Blender script on this PC.'))return;const r=await post('/api/aiconnect/inbox/'+b.dataset.b+'/build',{});job(r.jobId)})}
load().catch(e=>document.querySelector('.sub').textContent='Could not reach VTube Pro ('+e.message+'). Start VTube Pro again, then reload this page.');
/* polling runs only while this page is visible (approvals every 2 s, the inbox every 8 s) and the breathing dot pauses when it is hidden */
let ta=0,ti=0;const startPoll=()=>{if(!ta){appr();inbox();ta=setInterval(appr,2000);ti=setInterval(inbox,8000)}},stopPoll=()=>{clearInterval(ta);clearInterval(ti);ta=ti=0};
const vis=()=>{if(document.hidden){document.documentElement.setAttribute('data-hidden','');stopPoll()}else{document.documentElement.removeAttribute('data-hidden');startPoll()}};
document.addEventListener('visibilitychange',vis);vis();
</script>
<script>/* docked: a drawer inside the studio (Pop out) or its own window opened by the studio (Dock back); Esc closes the drawer */
(function(){var dk=new URLSearchParams(location.search).get('docked')==='1'&&window.parent!==window,op=!dk&&window.opener;
function say(k){var m={vtpDock:{k:k,tool:'aiconnect'}};try{(dk?window.parent:window.opener).postMessage(m,'*')}catch(e){}}
if(dk){document.documentElement.classList.add('vtp-docked');addEventListener('keydown',function(e){var a=document.activeElement;if(e.key==='Escape'&&!e.defaultPrevented&&!(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)&&a.value))say('close')})}
if(!op)return;var b=document.createElement('button');b.className='s';b.id='dockBtn';b.style.cssText='position:fixed;top:12px;right:14px;z-index:5';
b.textContent=dk?'Pop out ↗':'Dock back';b.title=dk?'Open in its own window':'Put this back inside the studio and close this window';
b.onclick=function(){say('dock');setTimeout(function(){window.close()},150)};document.body.appendChild(b)})();
</script></body></html>`;

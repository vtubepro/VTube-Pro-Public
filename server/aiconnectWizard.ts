// "Connect an AI in 3 steps": the helper's own page at http://127.0.0.1:5191/aiconnect/connect (lane ai-connect).
// One page per AI (#claude-desktop, #claude-code, #chatgpt-desktop, #codex-cli, #grok-build, #lm-studio, #grok-bot, #local),
// each with three steps and a big Test button. No page here asks for a key: VTube Pro holds none. It is
// served only to this PC (server/localGuard.ts). Plain HTML + JS (no bundler
// entry), VTube Pro brand tokens (T\portal\BRAND.md), system fonts (no web fonts: offline + no third-party requests).
// Makes no sound. The client script avoids template literals on purpose (this file is a String.raw template).
export const AI_WIZARD_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Connect an AI - VTube Pro</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='23' fill='%2311171b'/%3E%3Cpath transform='translate(15 17) scale(.7)' d='M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z' fill='%237bd88f'/%3E%3C/svg%3E">
<style>
:root{--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;
--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--pink:#ff5fb4;--amber:#ffcf6a;--err:#ff6b6b;--radius:12px;
--display:"Archivo",ui-sans-serif,system-ui,"Segoe UI",sans-serif;--sans:"Geist",ui-sans-serif,system-ui,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.16,1,.3,1)}
*{box-sizing:border-box}html{background:var(--ink);color:var(--fg);color-scheme:dark;-webkit-font-smoothing:antialiased}
body{margin:0;font:15px/1.55 var(--sans);min-height:100vh;background:radial-gradient(900px 420px at 15% -10%,rgb(123 216 143/.08),transparent 60%),radial-gradient(800px 400px at 95% 0%,rgb(108 199 245/.07),transparent 60%),var(--ink)}
::selection{background:rgb(123 216 143/.35);color:#fff}
:focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:6px}
a{color:var(--sky)}a:hover{color:#9bdcff}
.top{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgb(6 8 10/.82);backdrop-filter:blur(14px) saturate(140%);z-index:5}
.top svg{width:30px;height:30px;flex:none}.wm{font:700 17px/1 var(--display);letter-spacing:-.01em}
.beta{font:500 10px/1 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--lime);background:rgb(123 216 143/.1);border:1px solid rgb(123 216 143/.3);border-radius:999px;padding:4px 8px}
.top .sp{flex:1}.top .where{font:12px var(--mono);color:var(--dim)}.wm{white-space:nowrap}
@media (max-width:560px){.top .where{display:none}}
.vtp-docked .top{display:none}
main{max-width:980px;margin:0 auto;padding:28px 20px 80px}
.eyebrow{display:flex;align-items:center;gap:10px;font:500 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.2em;color:var(--lime);margin:0 0 12px}
.eyebrow::before{content:"";width:24px;height:1px;background:var(--lime)}
h1{font:700 clamp(28px,4vw,40px)/1.1 var(--display);letter-spacing:-.02em;margin:0 0 10px}
h1 .g{background:linear-gradient(135deg,#7bd88f 0%,#6cc7f5 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--mute);font-size:16px;max-width:640px;margin:0 0 26px}
.glass{background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);box-shadow:inset 0 1px 0 rgb(255 255 255/.06),0 30px 80px -40px rgb(0 0 0/.8);border-radius:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.card{display:flex;flex-direction:column;gap:8px;padding:18px;text-align:left;color:inherit;font:inherit;cursor:pointer;transition:border-color .2s var(--ease),transform .2s var(--ease)}
.card:hover{border-color:var(--line-strong);transform:translateY(-1px)}
.card h3{margin:0;font:700 18px/1.2 var(--display);letter-spacing:-.01em}.card p{margin:0;color:var(--mute);font-size:14px}
.card .kind{font:500 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.chip{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;border-radius:999px;border:1px solid var(--line-strong);background:rgb(255 255 255/.03);color:var(--mute);font-size:12px;padding:3px 10px}
.chip.ok{color:var(--lime);border-color:rgb(123 216 143/.35);background:rgb(123 216 143/.08)}.chip.warn{color:var(--amber);border-color:rgb(255 207 106/.35)}.chip.off{opacity:.7}
.chip .d{width:7px;height:7px;border-radius:50%;background:currentColor}
.back{background:none;border:0;color:var(--mute);font:inherit;cursor:pointer;padding:6px 0;margin:0 0 14px}.back:hover{color:var(--fg)}
.steps{display:flex;flex-direction:column;gap:12px}
.step{padding:20px 20px 20px 72px;position:relative;transition:opacity .3s var(--ease),border-color .3s var(--ease)}
.step .n{position:absolute;left:20px;top:20px;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font:700 15px var(--display);border:1px solid var(--line-strong);color:var(--mute)}
.step.cur{border-color:rgb(123 216 143/.45)}.step.cur .n{background:var(--lime);color:var(--ink);border-color:var(--lime)}
.step.done .n{background:rgb(123 216 143/.14);color:var(--lime);border-color:rgb(123 216 143/.4)}
.step.later{opacity:.55}
.step h2{margin:2px 0 6px;font:700 19px/1.25 var(--display);letter-spacing:-.01em}.step p{margin:0 0 10px;color:var(--mute)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0 0}
.btn{height:44px;padding:0 18px;border-radius:12px;font:600 15px var(--sans);cursor:pointer;border:1px solid var(--line-strong);background:rgb(255 255 255/.06);color:var(--fg);display:inline-flex;align-items:center;gap:8px;text-decoration:none;transition:background .15s}
.btn:hover{background:rgb(255 255 255/.1);color:var(--fg)}
.btn.p{background:var(--lime);color:var(--ink);border-color:var(--lime)}.btn.p:hover{background:var(--lime-hi)}
.btn.big{height:52px;font-size:16px;padding:0 24px}
.btn.ghost{border-color:transparent;background:none;color:var(--mute)}.btn.ghost:hover{color:var(--fg)}
.btn:disabled{opacity:.45;cursor:not-allowed}
input[type=password],input[type=text],input[type=url],select{height:44px;border-radius:12px;border:1px solid var(--line-strong);background:var(--ink-2);color:var(--fg);font:15px var(--sans);padding:0 14px;min-width:0}
input.key{flex:1 1 320px;font-family:var(--mono)}
label.consent{display:flex;gap:10px;align-items:flex-start;color:var(--fg);cursor:pointer;max-width:620px}label.consent input{width:20px;height:20px;margin-top:2px;accent-color:var(--lime)}
.note{font-size:13px;color:var(--dim)}.ok{color:var(--lime)}.warn{color:var(--amber)}.bad{color:var(--err)}
.res{margin:12px 0 0;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--ink-3)}
.res.good{border-color:rgb(123 216 143/.4)}.res.fail{border-color:rgb(255 107 107/.45)}
.res b{display:block;font:700 16px/1.3 var(--display);margin:0 0 4px}.res .fix{color:var(--fg);margin:6px 0 0}
pre{background:var(--ink-2);border:1px solid var(--line);border-radius:12px;padding:12px;font:12.5px/1.45 var(--mono);white-space:pre-wrap;word-break:break-all;margin:10px 0 0;max-height:240px;overflow:auto}
details{margin:12px 0 0}summary{cursor:pointer;color:var(--mute)}
.honest{padding:16px 18px;border-radius:16px;border:1px solid rgb(255 207 106/.3);background:rgb(255 207 106/.06);margin:0 0 14px}.honest b{color:var(--amber)}
.finish{padding:26px;text-align:center;margin:14px 0 0;border-color:rgb(123 216 143/.45)}
.finish .big{font:700 30px/1.1 var(--display);letter-spacing:-.02em;margin:0 0 6px}.finish p{color:var(--mute);margin:0 auto 14px;max-width:560px}
.found{display:flex;flex-direction:column;gap:8px;margin:10px 0 0}.found label{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
.found label:has(input:checked){border-color:rgb(123 216 143/.5);background:rgb(123 216 143/.05)}.found input{accent-color:var(--lime)}
.cites{margin:22px 0 0;font-size:12px;color:var(--dim)}.cites a{color:var(--dim)}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;display:inline-block;animation:sp .8s linear infinite;vertical-align:-3px}
@keyframes sp{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:560px){.step{padding:18px 16px 18px 60px}.step .n{left:14px;width:30px;height:30px}main{padding:20px 16px 60px}}
</style></head><body>
<header class="top"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="g" x1="22" y1="66" x2="80" y2="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161c21"/><stop offset="1" stop-color="#07090c"/></linearGradient></defs><rect width="100" height="100" rx="23" fill="url(#t)"/><g transform="translate(50 52.5) scale(.7) translate(-50 -52)"><path d="M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z" fill="url(#g)"/></g></svg>
<span class="wm">VTube Pro</span><span class="beta">Beta</span><span class="sp"></span><span class="where">VTube Pro · this PC only</span></header>
<main id="main" aria-live="polite"><p class="note">Loading…</p></main>
<script src="/aiconnect/connect-home.js"></script>
<script>
(function(){
var $=function(s,r){return (r||document).querySelector(s)};
function el(tag,attrs){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;if(k==='text')e.textContent=v;else if(k==='class')e.className=v;else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null||c===false)continue;if(Array.isArray(c))(c.flat?c.flat(9):c).forEach(function(x){if(x!=null&&x!==false)e.append(x)});else e.append(c)}return e}
function api(method,url,body){return fetch(url,{method:method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'}).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}if(!r.ok)throw new Error((j&&j.error)||('Something went wrong (error '+r.status+').'));return j})})}
function add(p){for(var i=1;i<arguments.length;i++){var x=arguments[i];if(x!=null&&x!==false)p.append(x)}return p}
var S={list:[],platform:'',ack:{},result:{},busy:{},found:null,bridge:null,models:{}};
var KIND={desktop:'App on this PC',remote:'Cloud bot',local:'Free, on this PC'};
function load(){return api('GET','/api/ai/connectors').then(function(r){S.list=r.connectors;S.platform=r.platform;render()},function(e){fatal(e.message)})}
function fatal(msg){var m=$('#main');m.replaceChildren(el('div',{class:'res fail'},el('b',{text:'We couldn\'t reach VTube Pro'}),el('p',{class:'fix',text:'Start VTube Pro on this PC, then press Try again.'}),el('div',{class:'row'},el('button',{class:'btn p',onclick:load,text:'Try again'})),el('p',{class:'note',text:msg})))}
function conn(id){for(var i=0;i<S.list.length;i++)if(S.list[i].id===id)return S.list[i];return null}
function chipFor(c){if(!c.supported)return el('span',{class:'chip off'},'Not on this computer');if(c.lastTest&&c.lastTest.ok)return el('span',{class:'chip ok'},el('span',{class:'d'}),'Connected');if(c.ready)return el('span',{class:'chip warn'},el('span',{class:'d'}),'Set up, not tested');return el('span',{class:'chip'},'Not set up')}
function render(){var id=(location.hash||'').slice(1);var c=conn(id);try{if(c)wizard(c);else home()}catch(e){$('#main').replaceChildren(el('div',{class:'res fail'},el('b',{text:'Something went wrong on this page'}),el('p',{class:'fix',text:'Reload the page. If it keeps happening, use the full AI page.'}),el('div',{class:'row'},el('button',{class:'btn p',onclick:function(){location.reload()},text:'Reload'}),el('a',{class:'btn ghost',href:'/aiconnect',text:'Full AI page'})),el('p',{class:'note',text:String(e&&e.message||e)})))}}
window.addEventListener('hashchange',function(){render();window.scrollTo(0,0)});
function home(){if(window.vtpConnectHome){window.vtpConnectHome({main:$('#main'),S:S,el:el,api:api});return}var m=$('#main');m.replaceChildren(
 el('p',{class:'eyebrow',text:'AI connectors'}),
 el('h1',null,'Connect an ',el('span',{class:'g',text:'AI'}),' to VTube Pro'),
 el('p',{class:'lead',text:'Pick the AI you use. Each one takes 3 small steps and ends with a Test button. Your settings stay on this PC: VTube Pro\'s website never sees them.'}),
 el('div',{class:'grid'},S.list.map(function(c){return el('button',{class:'card glass',onclick:function(){location.hash=c.id}},el('span',{class:'kind',text:KIND[c.kind]||''}),el('h3',{text:c.name}),el('p',{text:c.blurb}),chipFor(c))})),
 el('p',{class:'note',style:'margin-top:22px'},'Looking for approvals, the instruction pack or the built-in chat? ',el('a',{href:'/aiconnect'+(location.search||''),text:'Open the full AI page'}),'.'))}
// ---------------------------------------------------------------- one wizard page
function stepBox(n,state,title,text){var b=el('section',{class:'step glass '+state},el('span',{class:'n',text:state==='done'?'✓':String(n)}),el('h2',{text:title}));if(text)add(b,el('p',{text:text}));return b}
function resultBox(r,retry){if(!r)return null;if(r.busy)return el('div',{class:'res'},el('span',{class:'spin'}),' ',r.busy);
 var box=el('div',{class:'res '+(r.ok?'good':'fail')},el('b',{text:(r.ok?'✔ ':'')+r.title}));if(r.detail)box.append(el('p',{text:r.detail}));if(r.fix)box.append(el('p',{class:'fix',text:r.fix}));
 if(!r.ok)box.append(el('div',{class:'row'},retry?el('button',{class:'btn',onclick:retry,text:'Try again'}):null,el('a',{class:'btn ghost',href:'/api/docs/AI_CONNECT.md',target:'_blank',rel:'noopener',text:'Get help'})));return box}
function cur(steps){for(var i=0;i<steps.length;i++)if(!steps[i])return i;return steps.length}
function frame(c,doneFlags,blocks,extra){var at=cur(doneFlags);var m=$('#main');
 var states=doneFlags.map(function(d,i){return d?'done':(i===at?'cur':'later')});
 m.replaceChildren.apply(m,[el('button',{class:'back',onclick:function(){location.hash=''},text:'← All AIs'}),
  el('p',{class:'eyebrow',text:at>=3?'All done':'Step '+(at+1)+' of 3'}),el('h1',null,'Connect ',el('span',{class:'g',text:c.name})),el('p',{class:'lead',text:c.blurb}),
  extra||null,el('div',{class:'steps'},blocks.map(function(f,i){return f(states[i])})),
  at>=3?doneCard(c):null,
  c.cites&&c.cites.length?el('p',{class:'cites'},'How we know (checked 1 Oct 2026): ',c.cites.map(function(u,i){return [i?' · ':'',el('a',{href:u,target:'_blank',rel:'noopener noreferrer',text:u.replace(/^https:\/\//,'')})]})):null].filter(Boolean))}
function doneCard(c){var tip={desktop:'Open '+c.name+' and ask: "Use VTube Pro to show me my avatars." Big changes (Blender, your live stream) always wait for your OK in VTube Pro.',local:'Use it from the studio\'s AI chat or "Create with AI". It is free and never leaves this PC.',remote:'In Grok, ask it to look at your VTube Pro rooms. Switch the bridge off when you are done.'}[c.kind];
 return el('div',{class:'finish glass'},el('div',{class:'big',text:'You\'re all set!'}),el('p',{text:tip}),el('div',{class:'row',style:'justify-content:center'},el('button',{class:'btn p big',onclick:function(){location.hash=''},text:'Back to all AIs'}),c.kind==='local'?el('a',{class:'btn',href:'/aiconnect'+(location.search||''),text:'Open Create with AI'}):null))}
function test(c){S.result[c.id]={busy:'Testing… this can take up to a minute.'};render();
 api('POST','/api/ai/connectors/'+c.id+'/test',{}).then(function(r){S.result[c.id]=r;if(r.models)S.models[c.id]=r.models;return load()}).catch(function(e){S.result[c.id]={ok:false,title:e.message,fix:'Press Try again.'};render()})}
function testStep(c,label){return function(st){var b=stepBox(3,st,'Test it',label);var r=S.result[c.id];
 add(b,el('div',{class:'row'},el('button',{class:'btn p big',disabled:st==='later'||(r&&r.busy)?true:null,onclick:function(){test(c)},text:'Test'})));
 add(b,resultBox(r,function(){test(c)}));
 var ms=S.models[c.id];if(r&&r.ok&&ms&&ms.length&&c.kind==='local'){var sel=el('select',{'aria-label':'Model'},ms.map(function(m){return el('option',{value:m,selected:m===c.model?true:null,text:m})}));
  add(b,el('div',{class:'row'},el('span',{class:'note',text:'Model VTube Pro uses:'}),sel,el('button',{class:'btn',onclick:function(){api('PUT','/api/ai/model/'+c.id,{model:sel.value}).then(load)},text:'Use this model'})))}
 return b}}
function wizard(c){if(c.kind==='desktop')return desktop(c);if(c.kind==='local')return local(c);return remote(c)}
// ---- Claude Desktop / ChatGPT Desktop / Grok Build
function desktop(c){var tested=!!(c.lastTest&&c.lastTest.ok);var have=c.installed===true||!!S.ack[c.id]||c.added;
 if(!c.supported){var m=$('#main');m.replaceChildren(el('button',{class:'back',onclick:function(){location.hash=''},text:'← All AIs'}),el('h1',null,c.name),
  el('div',{class:'honest'},el('b',{text:'Not available on this computer. '}),c.why||'This app is not made for your system.'),el('div',{class:'row'},el('a',{class:'btn p big',href:'#claude-code',text:'Use Claude Code instead'}),el('a',{class:'btn',href:'#local',text:'Use a free model on this PC'})));return}
 var extra=c.id==='chatgpt-desktop'?el('div',{class:'honest'},el('b',{text:'Good to know: '}),'this works in the ChatGPT ',el('i',{text:'desktop app'}),' (it shares its tool list with Codex). ChatGPT in a web browser can\'t start programs on your PC; for that use the ',el('a',{href:'#grok-bot',text:'internet bridge'}),' or Codex (',el('a',{href:'#codex-cli',text:'set up here'}),').'):c.id==='claude-code'?el('div',{class:'honest'},el('b',{text:'Good to know: '}),'we add VTube Pro for you in every folder you open with Claude Code. If Claude Code is open now, start a new session after this (or type /mcp).'):c.id==='codex-cli'?el('div',{class:'honest'},el('b',{text:'Good to know: '}),'Codex and the ChatGPT desktop app share one settings file. Adding VTube Pro here adds it to both.'):c.id==='lm-studio'?el('div',{class:'honest'},el('b',{text:'Good to know: '}),'LM Studio 0.3.17 or newer loads VTube Pro by itself as soon as it is added: no restart. Chat with a model that can use tools. LM Studio asks before each tool call (allow it once, or always). Its own local server (for the chat in VTube Pro) is a different thing: see ',el('a',{href:'#local',text:'a model on this PC'}),'.'):null;
 frame(c,[have,c.added&&c.current,tested],[
  function(st){var b=stepBox(1,st,'Get '+c.name,c.installed===true?'We found it on this PC.':'Install it if you haven\'t yet (it\'s free to download).');
   add(b,el('div',{class:'row'},c.installed===true?el('span',{class:'ok',text:'✔ Found on this PC'}):el('a',{class:'btn'+(st==='cur'?' p':''),href:c.getUrl,target:'_blank',rel:'noopener noreferrer',text:c.getLabel}),c.installed!==true&&!have?el('button',{class:'btn ghost',onclick:function(){S.ack[c.id]=1;render()},text:'I have it'}):null));return b},
  function(st){var b=stepBox(2,st,'Add VTube Pro to '+c.name,c.added&&!c.current?'VTube Pro moved since you added it. Add it again so '+c.name+' finds it.':'We add one entry to '+c.name+'\'s settings and keep a backup of the old file. Nothing else changes.');
   var box=el('input',{type:'checkbox',id:'consent'});var addBtn=el('button',{class:'btn'+(st==='cur'?' p big':''),disabled:true,text:c.added?'Add it again':'Add VTube Pro'});
   box.addEventListener('change',function(){addBtn.disabled=!box.checked});
   addBtn.addEventListener('click',function(){S.result[c.id+':add']={busy:'Adding…'};render();api('POST','/api/ai/setup/'+c.id,{consent:true}).then(function(r){S.result[c.id+':add']={ok:true,title:'Added',detail:(r.backup?'Backup of the old settings: '+r.backup+'. ':'')+r.next};return load()}).catch(function(e){S.result[c.id+':add']={ok:false,title:e.message};render()})});
   add(b,el('label',{class:'consent'},box,el('span',{text:'Yes, add VTube Pro to '+c.name+'\'s settings on this PC.'})),el('div',{class:'row'},addBtn));
   if(c.added&&c.current)add(b,el('p',{class:'ok',text:'✔ VTube Pro is in '+c.name+'\'s settings.'}));
   add(b,resultBox(S.result[c.id+':add']));
   if(c.added)add(b,el('div',{class:'row'},el('button',{class:'btn ghost',onclick:function(){if(confirm('Remove VTube Pro from '+c.name+'?'))api('DELETE','/api/ai/setup/'+c.id).then(load)},text:'Remove VTube Pro from '+c.name})));
   var pre=el('pre',{text:c.manual||''});add(b,el('details',null,el('summary',{text:'I\'d rather do it myself'}),c.configPath?el('p',{class:'note',text:'Settings file: '+c.configPath}):null,pre,el('div',{class:'row'},el('button',{class:'btn',onclick:function(e){navigator.clipboard.writeText(pre.textContent);e.target.textContent='Copied!'},text:'Copy'}))));return b},
  testStep(c,'We start VTube Pro\'s connection exactly the way '+c.name+' will, and check its tools answer.')],extra)}
// ---- a model on this PC
function local(c){var tested=!!(c.lastTest&&c.lastTest.ok);
 frame(c,[!!c.baseUrl||!!S.ack.local||(S.found&&S.found.length>0),!!c.baseUrl,tested],[
  function(st){var b=stepBox(1,st,'Get a free model app','Ollama is the easiest. Then download ONE model. Not sure which? Let VTube Pro check your PC and pick the best one for it.');
   var cmd=el('pre',{text:'ollama pull '+((c.starter&&c.starter.ollama)||'qwen3:8b')});
   add(b,el('div',{class:'row'},el('a',{class:'btn'+(st==='cur'?' p big':''),href:'https://ollama.com/download',target:'_blank',rel:'noopener noreferrer',text:'Get Ollama (free)'}),el('a',{class:'btn',href:'https://lmstudio.ai/download',target:'_blank',rel:'noopener noreferrer',text:'or LM Studio'}),!c.baseUrl&&!S.ack.local?el('button',{class:'btn ghost',onclick:function(){S.ack.local=1;render()},text:'I have one'}):null),
    el('div',{class:'row'},el('a',{class:'btn',href:'/local-ai',target:'_blank',rel:'noopener',text:'Which model fits my PC?'})),
    el('p',{class:'note',text:'Or start with this one'+(c.starter?' ('+c.starter.name+', about '+c.starter.sizeGB+' GB, good for 8 GB graphics cards)':'')+': copy it into a terminal after installing Ollama.'}),
    cmd,el('div',{class:'row'},el('button',{class:'btn',onclick:function(e){navigator.clipboard.writeText(cmd.textContent);e.target.textContent='Copied!'},text:'Copy'})));return b},
  function(st){var b=stepBox(2,st,'Find my model','We look for Ollama, LM Studio, llama.cpp, vLLM, KoboldCpp and Jan on this PC only.');
   var find=el('button',{class:'btn'+(st==='cur'&&!(S.found&&S.found.length)?' p big':''),text:S.found&&S.found.length?'Look again':'Find my model'});
   find.addEventListener('click',function(){S.found=null;S.result['local:scan']={busy:'Looking on this PC…'};render();api('GET','/api/ai/local/scan').then(function(r){S.found=r.found;S.result['local:scan']=r.found.length?null:{ok:false,title:'We didn\'t find a running model app',fix:'Open Ollama or LM Studio (in LM Studio switch "Start server" on), then press Find my model again.'};render()}).catch(function(e){S.result['local:scan']={ok:false,title:e.message};render()})});
   add(b,el('div',{class:'row'},find));add(b,resultBox(S.result['local:scan'],function(){find.click()}));
   if(S.found&&S.found.length){var list=el('div',{class:'found'});var first=true;
    S.found.forEach(function(f){(f.models.length?f.models:['(no model downloaded yet)']).forEach(function(m){var r=el('input',{type:'radio',name:'lm',value:f.baseUrl+'|'+m+'|'+f.kind,disabled:f.models.length?null:true,checked:first&&f.models.length?true:null});if(f.models.length)first=false;list.append(el('label',null,r,el('span',null,el('b',{text:m}),el('span',{class:'note',text:'  in '+f.label})))) })});
    var use=el('button',{class:'btn p',text:'Use this one'});use.addEventListener('click',function(){var r=list.querySelector('input:checked');if(!r)return;var p=r.value.split('|');api('POST','/api/ai/local/use',{baseUrl:p[0],model:p[1],kind:p[2]}).then(function(){S.result.local=null;return load()}).catch(function(e){S.result['local:scan']={ok:false,title:e.message};render()})});
    add(b,list,el('div',{class:'row'},use))}
   if(c.baseUrl)add(b,el('p',{class:'ok',text:'✔ Using '+(c.model||'your model')+' at '+c.baseUrl}));
   var addr=el('input',{type:'url',placeholder:'http://127.0.0.1:11434/v1',value:c.baseUrl||''});var mdl=el('input',{type:'text',placeholder:'model name',value:c.model||''});
   add(b,el('details',null,el('summary',{text:'Type the address myself'}),el('div',{class:'row'},addr,mdl,el('button',{class:'btn',onclick:function(){api('POST','/api/ai/local/use',{baseUrl:addr.value,model:mdl.value}).then(load).catch(function(e){alert(e.message)})},text:'Save'}))));return b},
  testStep(c,'We ask your model for one word. The first answer can take a minute while it loads.')])}
// ---- Grok Bot / grok.com: the internet bridge
function remote(c){var tested=!!(c.lastTest&&c.lastTest.ok);
 function refreshBridge(){return api('GET','/api/ai/bridge').then(function(b){S.bridge=b;render()})}
 if(!S.bridge){refreshBridge().catch(function(e){S.bridge={on:false,error:e.message};render()});}
 var B=S.bridge||{};
 frame(c,[!!B.on,!!B.connectorUrl,tested],[
  function(st){var b=stepBox(1,st,'Switch on the bridge','The bridge lets an AI on the internet look at your VTube Pro. It can read your avatar and room lists, check rooms and send room plans to your Inbox. It can never run Blender, change your stream or edit your library.');
   var on=el('button',{class:'btn'+(st==='cur'?' p big':''),text:B.on?'Switch the bridge off':'Switch the bridge on'});
   on.addEventListener('click',function(){api('POST','/api/ai/bridge',{on:!B.on}).then(function(x){S.bridge=x;return load()}).catch(function(e){S.result['bridge']={ok:false,title:e.message};render()})});
   add(b,el('div',{class:'row'},on,B.on?el('span',{class:'ok',text:'✔ On'}):null));if(B.note)add(b,el('p',{class:'warn',text:B.note}));add(b,resultBox(S.result['bridge']));return b},
  function(st){var b=stepBox(2,st,'Make a private internet address','Cloudflare\'s free "cloudflared" tool makes a temporary address that points at the bridge. Treat it like a password: anyone with it can use the bridge until you switch it off.');
   if(!B.cloudflared)add(b,el('div',{class:'row'},el('a',{class:'btn'+(st==='cur'?' p':''),href:'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/',target:'_blank',rel:'noopener noreferrer',text:'Get cloudflared (free)'}),el('button',{class:'btn ghost',onclick:refreshBridge,text:'I installed it'})));
   var mk=el('button',{class:'btn'+(st==='cur'&&B.cloudflared?' p big':''),disabled:!B.on||!B.cloudflared?true:null,text:B.tunnel?'Make a new address':'Make my address'});
   mk.addEventListener('click',function(){S.result['tunnel']={busy:'Asking Cloudflare for an address… (up to 30 seconds)'};render();api('POST','/api/ai/bridge/tunnel',{on:true}).then(function(x){S.bridge=x;S.result['tunnel']=null;return load()}).catch(function(e){S.result['tunnel']={ok:false,title:e.message};render()})});
   add(b,el('div',{class:'row'},mk));add(b,resultBox(S.result['tunnel'],function(){mk.click()}));
   if(B.connectorUrl){var pre=el('pre',{text:B.connectorUrl});add(b,pre,el('div',{class:'row'},el('button',{class:'btn p',onclick:function(e){navigator.clipboard.writeText(B.connectorUrl);e.target.textContent='Copied!'},text:'Copy the address'})))}
   return b},
  function(st){var b=testStep(c,'In Grok: Connectors → New Connector → Custom, paste the address (no sign-in needed). Then press Test: we call the address from the internet side, like Grok will.')(st);return b}],
  el('div',{class:'honest'},el('b',{text:'Good to know: '}),'Grok Bot works on a computer in the cloud, not on your PC, so it can\'t start VTube Pro by itself. The internet bridge below is the way in. Easier and more powerful: ',el('a',{href:'#grok-build',text:'use Grok Build'}),' on this PC (it runs VTube Pro\'s tools directly).'))}
// docked in the studio drawer on this PC
try{if(new URLSearchParams(location.search).get('docked')==='1'&&window.parent!==window)document.documentElement.classList.add('vtp-docked')}catch(e){}
load();
})();
</script></body></html>`;

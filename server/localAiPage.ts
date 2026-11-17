// The helper's "Local AI" page (http://127.0.0.1:5191/local-ai). Plain HTML + JS (no bundler entry, works in dev and in
// the built app), VTube Pro brand tokens (T/portal/BRAND.md), written for people who are allergic to technology:
// one big button per step, plain words, copy buttons, "Check again" instead of instructions to verify.
// It ASKS before scanning; the scan is read-only and stays on this PC (server/hwScan.ts). Makes no sound.
// NOTE: this is a String.raw template: the script below must not use backticks or dollar-brace.
export const LOCAL_AI_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local AI - VTube Pro</title>
<style>
:root{--ink:#06080a;--ink-2:#0b0f12;--ink-3:#11171b;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--dim:#85918b;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--pink:#ff5fb4;--amber:#ffcf6a;--err:#ff6b6b;--radius:12px;color-scheme:dark}
*{box-sizing:border-box}html,body{background:var(--ink);color:var(--fg)}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:980px;margin:0 auto;padding:20px 16px 72px}.vtp-docked main{padding-top:10px}
header{display:flex;align-items:center;gap:10px;margin:0 0 18px}header svg{width:30px;height:30px;flex:none}
.word{font-weight:700;letter-spacing:-.01em;font-size:17px}.beta{font:500 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--lime);background:rgb(123 216 143/.1);border:1px solid rgb(123 216 143/.3);border-radius:999px;padding:4px 8px}
.crumb{margin-left:auto;color:var(--mute);font-size:13px}
.eyebrow{display:flex;align-items:center;gap:8px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--lime);margin:0 0 10px}.eyebrow:before{content:"";width:24px;height:1px;background:var(--lime)}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:0 0 8px}h2{font-size:20px;letter-spacing:-.01em;margin:0 0 6px}h3{font-size:16px;margin:14px 0 6px}
.lead{color:var(--mute);font-size:16px;margin:0 0 18px;max-width:680px}
.glass{background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);box-shadow:inset 0 1px 0 rgb(255 255 255/.06),0 30px 80px -40px rgb(0 0 0/.8);border-radius:20px;padding:22px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}.grid>*{min-width:0}.stack{display:grid;gap:0}
button,.btn{font:600 15px/1 inherit;font-family:inherit;border-radius:var(--radius);cursor:pointer;min-height:44px;padding:0 18px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none}
.primary{background:var(--lime);color:var(--ink);border:0}.primary:hover{background:var(--lime-hi)}.big{min-height:52px;font-size:16px;width:100%;max-width:420px}
.secondary{background:rgb(255 255 255/.06);color:var(--fg);border:1px solid var(--line-strong)}.secondary:hover{background:rgb(255 255 255/.1)}
.ghost{background:none;border:0;color:var(--mute);padding:0 6px}.ghost:hover{color:var(--fg)}
button:disabled{opacity:.55;cursor:default}:focus-visible{outline:2px solid var(--lime);outline-offset:3px;border-radius:6px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}
ul.reads{margin:8px 0 14px;padding:0;list-style:none;display:grid;gap:6px}ul.reads li:before{content:"\2713  ";color:var(--lime);font-weight:700}
.private{border-left:3px solid var(--lime);padding:8px 12px;background:rgb(123 216 143/.06);border-radius:0 10px 10px 0;color:var(--fg);margin:10px 0 16px}
.chip{display:inline-block;border:1px solid var(--line-strong);background:rgb(255 255 255/.03);color:var(--mute);border-radius:999px;padding:2px 10px;font-size:12px;margin:2px 4px 2px 0}
.chip.ok{color:var(--lime);border-color:rgb(123 216 143/.35)}.chip.warn{color:var(--amber);border-color:rgb(255 207 106/.35)}.chip.bad{color:var(--err);border-color:rgb(255 107 107/.35)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:10px 0}.fact{background:var(--ink-3);border:1px solid var(--line);border-radius:14px;padding:10px 12px}.fact b{display:block;font-size:12px;color:var(--dim);font-weight:500;text-transform:uppercase;letter-spacing:.06em}.fact span{font-size:15px}
.pick{font-size:22px;font-weight:700;letter-spacing:-.01em;margin:4px 0}.mute{color:var(--mute)}.dim{color:var(--dim);font-size:13px}
ol.steps{padding-left:0;list-style:none;counter-reset:s;margin:10px 0}ol.steps li{counter-increment:s;position:relative;padding:8px 0 8px 40px;border-top:1px solid var(--line)}ol.steps li:before{content:counter(s);position:absolute;left:0;top:8px;width:26px;height:26px;border-radius:50%;background:rgb(123 216 143/.14);color:var(--lime);font-weight:700;display:grid;place-items:center;font-size:13px}
code.cp{display:inline-block;background:var(--ink);border:1px solid var(--line-strong);border-radius:8px;padding:6px 10px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:6px 8px 0 0;word-break:break-all}
a{color:var(--sky);overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed}td,th{overflow-wrap:anywhere;text-align:left;border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
details{margin:10px 0}summary{cursor:pointer;color:var(--sky)}
.status{display:flex;gap:8px;align-items:center;font-size:14px}.dot{width:9px;height:9px;border-radius:50%;background:var(--dim)}.dot.on{background:var(--lime)}
.done{border:1px solid rgb(123 216 143/.4);background:rgb(123 216 143/.08);border-radius:16px;padding:14px 16px;margin:0 0 16px;font-size:16px}
.err{border:1px solid rgb(255 107 107/.4);background:rgb(255 107 107/.08);border-radius:14px;padding:12px 14px;margin:10px 0}
label.f{display:grid;gap:4px;font-size:13px;color:var(--mute)}select,input{background:var(--ink);color:var(--fg);border:1px solid var(--line-strong);border-radius:12px;padding:10px;font:inherit;min-height:44px}
.switch{display:flex;gap:10px;align-items:flex-start}.switch input{width:20px;height:20px;min-height:0;margin-top:2px;accent-color:var(--lime)}
.hide{display:none!important}
@media (prefers-reduced-motion:no-preference){.glass{animation:in .6s cubic-bezier(.16,1,.3,1)}@keyframes in{from{opacity:0;transform:translateY(6px)}}}
</style></head><body><main>
<header><svg viewBox="8 16 84 72" aria-hidden="true"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient></defs><path fill="url(#g)" d="M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z"/></svg>
<span class="word">VTube Pro</span><span class="beta">Beta</span><span class="crumb">Local AI</span></header>

<div id="err" class="err hide" role="alert"></div>

<!-- STEP 1: ask -->
<section id="s1" class="glass">
<p class="eyebrow">Step 1 of 3</p>
<h1>Find the best AI that runs on your own computer</h1>
<p class="lead">Free AI models can run on your PC with no account and no monthly bill. Which ones work depends on your computer, so we'd like to take a quick look at it first.</p>
<h3>With your OK, we look at:</h3>
<ul class="reads"><li>Your graphics card (its name and how much memory it has)</li><li>How much memory (RAM) your computer has</li><li>Your processor (its name and number of cores)</li><li>How much free disk space you have</li><li>Your operating system and its version</li></ul>
<div class="private"><b>Nothing leaves this PC.</b> We don't look at your files, your name or any serial numbers. The result stays inside VTube Pro and is forgotten when you close it.</div>
<div class="row"><button id="scan" class="primary big">Yes, scan my computer</button></div>
<div class="row"><button id="manual" class="ghost">No thanks, I'll type in my details</button></div>
</section>

<!-- STEP 1b: type it in -->
<section id="s1b" class="glass hide">
<p class="eyebrow">Step 1 of 3</p><h2>Tell us about your computer</h2>
<p class="mute">Not sure? Pick your best guess. You can change it any time.</p>
<div class="grid">
<label class="f">Your computer<select id="fOs"><option value="windows">Windows PC</option><option value="macos">Mac</option><option value="linux">Linux</option></select></label>
<label class="f">Graphics card<select id="fVendor"><option value="nvidia">NVIDIA (GeForce / RTX)</option><option value="amd">AMD (Radeon)</option><option value="intel">Intel Arc</option><option value="apple">Apple M1 / M2 / M3 / M4 / M5 (Mac)</option><option value="none">None / built-in graphics</option></select></label>
<label class="f" id="fVramL">Graphics card memory<select id="fVram"><option>4</option><option>6</option><option selected>8</option><option>10</option><option>12</option><option>16</option><option>20</option><option>24</option><option>32</option><option>48</option></select></label>
<label class="f">Computer memory (RAM)<select id="fRam"><option>8</option><option selected>16</option><option>24</option><option>32</option><option>48</option><option>64</option><option>96</option><option>128</option></select></label>
</div>
<div class="row"><button id="fGo" class="primary">Show my recommendations</button><button id="fBack" class="secondary">Back</button></div>
</section>

<!-- STEP 2 + 3: results -->
<section id="s2" class="hide">
<div id="doneBox" class="done hide" role="status"></div>
<div class="glass">
<p class="eyebrow">Step 2 of 3</p>
<h2>Here's what we found</h2>
<div id="facts" class="facts"></div>
<p id="tier" class="mute"></p>
<div id="notes" class="dim"></div>
<div class="row"><button id="again" class="secondary">Scan again</button><button id="edit" class="ghost">Not right? Type it in</button><button id="forget" class="ghost">Forget my scan</button></div>
</div>
<p class="eyebrow">Step 3 of 3</p>
<div class="stack">
<div class="glass" id="llmCard"></div>
<div class="glass" id="comfyCard"></div>
</div>
<div class="glass" id="wfCard"></div>
<div class="glass">
<h2>Let your AI assistant use this</h2>
<label class="switch"><input type="checkbox" id="share"><span>Let AI assistants connected to VTube Pro (Claude, ChatGPT, Grok, a local model) see a <b>short summary</b>: your graphics card, its memory, your RAM and system. Then they can suggest models and picture workflows that fit. Off by default. If your assistant is a cloud service, that summary goes to it.</span></label>
</div>
<details class="glass" id="srcBox"><summary>Where these recommendations come from</summary><div id="sources"></div></details>
</section>
<p class="dim">VTube Pro never downloads or installs AI models for you: every link above goes to the official page. Models have their own licences, shown next to each one.</p>
</main>
<script>
(function(){
var q=new URLSearchParams(location.search);if(q.get('docked')==='1'&&window.parent!==window)document.documentElement.classList.add('vtp-docked');
var $=function(id){return document.getElementById(id)};
function h(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){if(k==='text')e.textContent=attrs[k];else if(k==='cls')e.className=attrs[k];else if(k==='on')e.addEventListener('click',attrs[k]);else e.setAttribute(k,attrs[k])}(kids||[]).forEach(function(c){if(c!=null)e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
function clear(e){while(e.firstChild)e.removeChild(e.firstChild);return e}
function show(id,on){$(id).classList.toggle('hide',!on)}
function err(msg,retry){var e=clear($('err'));e.appendChild(h('span',{text:msg+' '}));if(retry)e.appendChild(h('button',{cls:'secondary',text:'Try again',on:function(){show('err',false);retry()}}));show('err',true)}
function api(method,path,body){return fetch(path,{method:method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw new Error(j.error||('VTube Pro answered '+r.status));return j})})}
function copyBtn(text){var b=h('button',{cls:'secondary',text:'Copy'});b.addEventListener('click',function(){var done=function(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},1500)};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,function(){fallback()});else fallback();function fallback(){var t=h('textarea');t.value=text;document.body.appendChild(t);t.select();try{document.execCommand('copy');done()}catch(e){}document.body.removeChild(t)}});return b}
function link(url,label){return h('a',{href:url,target:'_blank',rel:'noopener noreferrer',text:label||url})}
function steps(list){var ol=h('ol',{cls:'steps'});list.forEach(function(s){var li=h('li',null,[s.text]);if(s.copy){li.appendChild(h('br'));li.appendChild(h('code',{cls:'cp',text:s.copy}));li.appendChild(copyBtn(s.copy))}if(s.link){li.appendChild(h('br'));li.appendChild(link(s.link,'Open the official page'))}ol.appendChild(li)});return ol}
function chipLic(ok,text){return h('span',{cls:'chip '+(ok?'ok':'warn'),text:text})}
var state=null,det=null;

function render(d){
  state=d;show('s1',false);show('s1b',false);show('s2',true);show('err',false);try{scrollTo(0,0)}catch(e){}
  var hw=d.hw,rec=d.rec,b=rec.budget,g=b.gpu;
  var f=clear($('facts'));
  function fact(k,v){f.appendChild(h('div',{cls:'fact'},[h('b',{text:k}),h('span',{text:v})]))}
  fact('Graphics card',g?g.name:'None found for AI');
  fact(b.kind==='unified'?'Memory for AI (shared)':'Graphics memory',b.kind==='cpu'?'-':(b.effectiveGB+' GB'));
  fact('Memory (RAM)',Math.round(hw.ramGB)+' GB');
  if(hw.cpu&&hw.cpu.model)fact('Processor',hw.cpu.model+(hw.cpu.cores?' ('+hw.cpu.cores+' threads)':''));
  if(hw.diskFreeGB!=null)fact('Free disk space',Math.floor(hw.diskFreeGB)+' GB');
  fact('System',hw.osName||hw.os);
  var tierNames={cpu:'No graphics card for AI',entry:'Entry (4-6 GB)',mid:'Mid (8 GB)',high:'High (12 GB)',enthusiast:'Enthusiast (16 GB)',pro:'Pro (24 GB)',workstation:'Workstation (32 GB+)'};
  $('tier').textContent='Your AI tier: '+tierNames[b.tier]+'. When VTube Pro is closed, AI can use about '+b.offAirGB+' GB; while you stream, about '+b.liveGB+' GB.';
  var nt=clear($('notes'));nt.appendChild(document.createTextNode(d.scanned?'Scanned just now on this PC. ':'Based on the details you typed in. '));
  if(d.scanned&&hw.notes&&hw.notes.length){var ul=h('ul');hw.notes.forEach(function(x){ul.appendChild(h('li',{text:x}))});nt.appendChild(h('details',null,[h('summary',{text:'Scan details (for helpers)'}),ul]))}
  show('again',!!d.scanned);show('forget',!!d.scanned);
  renderLlm(rec.llm);renderComfy(rec.comfy,rec.nodes);renderWf(rec.workflows);
  $('share').checked=!!d.share;$('share').disabled=!d.scanned;
  var s=clear($('sources'));var ul=h('ul');rec.sources.forEach(function(x){ul.appendChild(h('li',null,[/^https?:/.test(x.url)?link(x.url,x.title):h('span',{text:x.title+' ('+x.url+')'}),h('span',{cls:'dim',text:'  checked '+x.checked})]))});s.appendChild(h('p',{cls:'mute',text:'Catalogue checked '+rec.catalogChecked+'. AI models change fast: if a link looks different, the official page wins.'}));s.appendChild(ul);
  detect();
}
function renderLlm(l){
  var c=clear($('llmCard'));
  c.appendChild(h('h2',{text:'Chat AI on your PC'}));
  c.appendChild(h('p',{cls:'mute',text:'A language model that answers questions, writes chat replies and can drive VTube Pro through its AI connection.'}));
  if(!l.best){c.appendChild(h('p',{text:'Your computer doesn\'t have enough memory for a good local model. An AI app of your own, connected to VTube Pro, works great instead.'}));l.notes.forEach(function(n){c.appendChild(h('p',{cls:'dim',text:n}))});return}
  var m=l.best.model;
  c.appendChild(h('p',{cls:'dim',text:'Best for you'}));
  c.appendChild(h('div',{cls:'pick',text:m.name}));
  c.appendChild(h('p',{text:m.blurb}));
  c.appendChild(h('div',null,[chipLic(m.commercialOk,m.licence),h('span',{cls:'chip',text:m.sizeGB+' GB download'}),m.vision?h('span',{cls:'chip',text:'sees images'}):null,m.moe?h('span',{cls:'chip',text:'fast (mixture of experts)'}):null]));
  c.appendChild(h('div',{cls:'status',id:'llmStatus'},[h('span',{cls:'dot'}),h('span',{text:'Checking if '+l.runner.name+' is running...'})]));
  c.appendChild(h('h3',{text:'Install it with '+l.runner.name+' ('+'free'+')'}));
  c.appendChild(h('p',{cls:'mute',text:l.runner.what}));
  c.appendChild(steps(l.steps));
  c.appendChild(h('div',{cls:'row'},[h('button',{cls:'primary',text:'Check again',on:detect}),link(m.page,'About this model'),link(m.licenceUrl,'Licence')]));
  if(l.alternative)c.appendChild(h('p',{cls:'dim',text:'Also good: '+l.alternative.model.name+' (ollama pull '+l.alternative.model.ollama+'), '+l.alternative.model.licence+'.'}));
  if(l.otherRunner){var r=l.otherRunner;c.appendChild(h('details',null,[h('summary',{text:'Prefer an app with buttons? Use '+r.name}),h('p',{cls:'mute',text:r.what}),link(r.download.windows||r.download.macos,'Download '+r.name),h('p',{cls:'dim',text:'In '+r.name+', search for: '+m.lmSearch})]))}
  l.notes.forEach(function(n){c.appendChild(h('p',{cls:'dim',text:n}))});
}
function renderComfy(cf,nodes){
  var c=clear($('comfyCard'));
  c.appendChild(h('h2',{text:'Picture AI (ComfyUI)'}));
  c.appendChild(h('p',{cls:'mute',text:'ComfyUI makes pictures on your PC: textures for your avatar and rooms, skies, thumbnails, emotes.'}));
  if(!cf.recommended){c.appendChild(h('p',{text:'We don\'t recommend ComfyUI on this computer. That\'s okay: everything else in VTube Pro works without it, and the chat AI above still runs here.'}));cf.notes.forEach(function(n){c.appendChild(h('p',{cls:'dim',text:n}))});return}
  c.appendChild(h('p',{cls:'dim',text:'Best way to install'}));
  c.appendChild(h('div',{cls:'pick',text:cf.setup.name}));
  c.appendChild(h('p',{text:cf.setup.what}));
  c.appendChild(h('div',{cls:'status',id:'comfyStatus'},[h('span',{cls:'dot'}),h('span',{text:'Checking if ComfyUI is running...'})]));
  c.appendChild(steps(cf.steps));
  c.appendChild(h('div',{cls:'row'},[h('button',{cls:'primary',text:'Check again',on:detect}),link(cf.setup.link,'Official page')]));
  if(cf.altSetup)c.appendChild(h('p',{cls:'dim'},['Other way: ',link(cf.altSetup.link,cf.altSetup.name)]));
  var all=cf.start.map(function(m){return[m,true]}).concat(cf.tight.map(function(m){return[m,false]})).concat(cf.helpers.map(function(m){return[m,true]}));
  function files(m){return m.files.map(function(f){return h('div',{cls:'dim'},[link(f.url,f.file),h('br'),'Put it in the folder ComfyUI/'+f.folder])})}
  var first=cf.start[0]||cf.tight[0];
  if(first){
    c.appendChild(h('h3',{text:'Your first picture model'}));
    c.appendChild(h('div',{cls:'pick',text:first.name}));
    c.appendChild(h('p',{text:first.good}));
    c.appendChild(h('div',null,[chipLic(first.commercialOk,first.licence),h('span',{cls:'chip',text:'about '+first.downloadGB+' GB'}),cf.start[0]?null:h('span',{cls:'chip warn',text:'needs low-memory settings'})]));
    files(first).forEach(function(e){c.appendChild(e)});
    if(first.settings)c.appendChild(h('p',{cls:'dim',text:'Settings: '+first.settings}));
  }
  if(all.length>1){
    var t=h('table');t.appendChild(h('tr',null,[h('th',{text:'Model'}),h('th',{text:'Download'}),h('th',{text:'Licence'})]));
    all.forEach(function(p){var m=p[0];t.appendChild(h('tr',null,[h('td',null,[link(m.page,m.name),h('br'),h('span',{cls:'dim',text:m.good}),p[1]?null:h('span',{cls:'chip warn',text:'needs low-memory settings'})]),h('td',null,files(m)),h('td',null,[chipLic(m.commercialOk,m.licence)])]))});
    c.appendChild(h('details',null,[h('summary',{text:'All '+all.length+' models that fit your card'}),t]));
  }
  if(nodes&&nodes.length){var ul=h('ul');nodes.forEach(function(n){ul.appendChild(h('li',null,[link(n.repo,n.name),' - '+n.why+' ',h('span',{cls:'dim',text:n.manager+' Licence: '+n.licence})]))});c.appendChild(h('details',null,[h('summary',{text:'Extra pieces some recipes need (custom nodes)'}),ul]))}
  cf.notes.forEach(function(n){c.appendChild(h('p',{cls:'dim',text:n}))});
}
function renderWf(list){
  var c=clear($('wfCard'));c.appendChild(h('h2',{text:'Things you can make'}));
  if(!list.length){c.appendChild(h('p',{cls:'mute',text:'Picture workflows need ComfyUI and a graphics card.'}));return}
  c.appendChild(h('p',{cls:'mute',text:'Ready-made ComfyUI recipes for VTube Pro, picked for your card. Ask your AI assistant to walk you through any of them.'}));
  c.appendChild(h('div',{cls:'row'},[h('a',{cls:'btn primary',href:'/comfyui',text:'Set one up for me'})]));
  var t=h('table');t.appendChild(h('tr',null,[h('th',{text:'Make'}),h('th',{text:'Recipe for your card'}),h('th',{text:'Size'})]));
  list.forEach(function(p){t.appendChild(h('tr',null,[h('td',null,[h('b',{text:p.workflow.title}),h('br'),h('span',{cls:'dim',text:p.workflow.forWhat})]),h('td',{text:p.variant.label}),h('td',{cls:'dim',text:p.workflow.output})]))});
  c.appendChild(t);
}
function setStatus(id,on,text){var e=$(id);if(!e)return;clear(e).appendChild(h('span',{cls:'dot'+(on?' on':'')}));e.appendChild(h('span',{text:text}))}
function detect(){
  api('GET','/api/local-ai/detect').then(function(d){det=d;if(!state)return;var l=state.rec.llm,cf=state.rec.comfy;
    var have=false;
    if(l.best){var tag=l.best.model.ollama,base=tag.split(':')[0];var ol=d.ollama,lm=d.lmstudio;
      var pulled=ol.models.some(function(n){return n===tag||n.indexOf(tag)===0})||lm.models.some(function(n){return n.toLowerCase().indexOf(base.replace(/[^a-z0-9]/g,''))>=0||n.toLowerCase().indexOf(l.best.model.lmSearch.toLowerCase().split(' ')[0])>=0});
      have=pulled;
      setStatus('llmStatus',ol.running||lm.running,pulled?(l.best.model.name+' is installed. You\'re all set!'):(ol.running?'Ollama is running. Now download the model (step 3).':lm.running?'LM Studio\'s server is running. Now download and load the model.':'Not installed yet (or not running).'))}
    setStatus('comfyStatus',d.comfy.running,d.comfy.running?('ComfyUI is running ('+d.comfy.url+'). You\'re all set!'):'ComfyUI is not running yet.');
    var db=$('doneBox');if(have||d.comfy.running){db.textContent=(have&&d.comfy.running)?'You\'re all set! Your chat AI and ComfyUI are both ready on this PC.':have?'You\'re all set with your chat AI! ComfyUI is optional.':'ComfyUI is ready! The chat AI is optional.';show('doneBox',true)}else show('doneBox',false);
  }).catch(function(){setStatus('llmStatus',false,'Could not check right now.');setStatus('comfyStatus',false,'Could not check right now.')});
}
function doScan(){var b=$('scan');b.disabled=true;b.textContent='Looking at your computer...';
  api('POST','/api/local-ai/scan',{consent:true}).then(render).catch(function(e){err('The scan didn\'t work: '+e.message,doScan)}).then(function(){b.disabled=false;b.textContent='Yes, scan my computer'})}
$('scan').addEventListener('click',doScan);
$('again').addEventListener('click',function(){show('s2',false);show('s1',true);doScan()});
$('manual').addEventListener('click',function(){show('s1',false);show('s2',false);show('s1b',true)});
$('edit').addEventListener('click',function(){show('s2',false);show('s1b',true)});
$('fBack').addEventListener('click',function(){show('s1b',false);show(state?'s2':'s1',true)});
$('fVendor').addEventListener('change',function(){var v=$('fVendor').value;show('fVramL',v!=='apple'&&v!=='none');if(v==='apple')$('fOs').value='macos'});
function doManual(){var v=$('fVendor').value;api('POST','/api/local-ai/recommend',{facts:{os:$('fOs').value,gpuVendor:v==='none'?undefined:v,appleSilicon:v==='apple',vramGB:(v==='apple'||v==='none')?0:Number($('fVram').value),ramGB:Number($('fRam').value)}}).then(render).catch(function(e){err('Something went wrong: '+e.message,doManual)})}
$('fGo').addEventListener('click',doManual);
$('forget').addEventListener('click',function(){api('POST','/api/local-ai/forget').then(function(){state=null;show('s2',false);show('s1',true)}).catch(function(e){err(e.message)})});
$('share').addEventListener('change',function(){var on=$('share').checked;api('POST','/api/local-ai/share',{on:on}).catch(function(e){$('share').checked=!on;err(e.message)})});
api('GET','/api/local-ai/last').then(function(d){if(d.scanned)render(d)}).catch(function(){err('VTube Pro is not answering. Is it running?',function(){location.reload()})});
})();
</script></body></html>`;

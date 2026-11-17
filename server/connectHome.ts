// "Connect your AI" home (lane aiskills, beta.12): the first screen of the helper's /aiconnect/connect page, the ONE page
// for connecting any AI app (owner: "simple, easy, and intuitive to get any desktop AI program ... to connect and be
// usable"). It replaces the old grid of cards with:
//   1. the recommended model (shared/aiAddons.ts MODEL_ADVICE, with a "Why?" and its sources);
//   2. "On this computer": the AI apps found here, each with its status (Connected / Restart / Connect) and ONE button;
//      a connected app gets "Copy the first message" (it tells the AI to read VTube Pro's build instructions);
//   3. "Other ways": the rest (Grok Bot bridge, a free model on this PC with an honest note and a tool-calling
//      check, ComfyUI as the picture maker every AI can use);
//   4. "Make your AI better": the add-ons recommended for the chosen app (our skill, Blender MCP, GIMP + GIMP MCP when
//      there is no Photoshop ...), each installed only after a tick on its own consent sheet.
// The per-app 3-step pages (#claude-desktop ...) stay in server/aiconnectWizard.ts; that page loads this script and calls
// window.vtpConnectHome(ctx) for its home view. Plain JS (no bundler entry), textContent only, no sound, no storage.
// NOTE: this is a String.raw template: the script must not contain backticks or a dollar sign followed by a brace.
export const CONNECT_HOME_JS = String.raw`(function(){
var CSS=[
'.ch-model{padding:18px 20px;margin:0 0 22px;display:grid;gap:8px}',
'.ch-model .star{font:700 17px/1.35 var(--display);letter-spacing:-.01em}.ch-model .star b{color:var(--lime)}',
'.ch-model ul{margin:4px 0 0;padding-left:18px;color:var(--mute);font-size:14px}.ch-model li{margin:2px 0}',
'.ch-model .small{font-size:13px;color:var(--dim)}',
'.ch-sec{margin:26px 0 12px}',
'.ch-list{display:grid;gap:10px}',
'.ch-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 16px}',
'.ch-row .nm{font:700 16px/1.2 var(--display);min-width:150px}.ch-row .sp{flex:1}.ch-row .sub{color:var(--mute);font-size:13px;flex-basis:100%;margin-top:-4px}',
'.ch-row .btn{height:40px;font-size:14px}',
'.ch-other{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}',
'.ch-other a{display:flex;flex-direction:column;gap:4px;padding:14px;text-decoration:none;color:inherit}.ch-other a:hover{border-color:var(--line-strong)}',
'.ch-other a b{font:700 15px var(--display)}.ch-other a span{color:var(--mute);font-size:13px}',
'.ch-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}',
'.ch-tabs button{height:36px;border-radius:999px;border:1px solid var(--line-strong);background:none;color:var(--mute);font:600 13px var(--sans);padding:0 14px;cursor:pointer}',
'.ch-tabs button[aria-pressed=true]{background:rgb(123 216 143/.14);border-color:rgb(123 216 143/.5);color:var(--lime)}',
'.ch-add{padding:16px 18px;display:grid;gap:8px}',
'.ch-add .top2{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ch-add h3{margin:0;font:700 17px/1.25 var(--display)}',
'.badge{font:500 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;border-radius:999px;padding:4px 8px;border:1px solid var(--line-strong);color:var(--mute)}',
'.badge.ours{color:var(--lime);border-color:rgb(123 216 143/.4)}.badge.off{color:var(--sky);border-color:rgb(108 199 245/.4)}.badge.com{color:var(--amber);border-color:rgb(255 207 106/.35)}',
'.ch-add p{margin:0;color:var(--mute)}.ch-add .why{font-size:13px;color:var(--dim)}',
'.ch-add .state{font-size:14px}.ch-add ol{margin:4px 0 0;padding-left:20px;color:var(--mute);font-size:14px}',
'.ch-sheet{border:1px solid rgb(123 216 143/.35);border-radius:14px;padding:14px;background:var(--ink-3);display:grid;gap:10px}',
'.ch-sheet ul{margin:0;padding-left:18px;color:var(--fg);font-size:14px}.ch-sheet li{margin:4px 0}',
'.ch-more{margin-top:12px}.ch-more>summary{font-weight:600}',
'.ch-adv{margin-top:30px;font-size:14px;color:var(--dim);display:flex;gap:16px;flex-wrap:wrap}',
'@media (max-width:560px){.ch-row .nm{min-width:0;flex-basis:100%}.ch-row .sp{display:none}.ch-row .btn{flex:1 1 auto;justify-content:center}}'
].join('\n');
var A={st:null,err:null,loading:0,app:null,open:{},res:{},busy:{},ltc:null,timer:0,ctx:null};
var SKILL_APPS=['claude-code','codex-cli','chatgpt-desktop','grok-build','antigravity','gemini-cli'];
var SHORT={'claude-desktop':'Claude','chatgpt-desktop':'ChatGPT','claude-code':'Claude Code','codex-cli':'Codex','grok-build':'Grok Build','lm-studio':'LM Studio','cursor':'Cursor','vscode':'VS Code','gemini-cli':'Gemini CLI','antigravity':'Antigravity'};
var TOOL_NAME={blender:'Blender',gimp:'GIMP',uv:'uv',comfyui:'ComfyUI'};
function css(){if(document.getElementById('vtp-ch-css'))return;var s=document.createElement('style');s.id='vtp-ch-css';s.textContent=CSS;document.head.append(s)}
function el(){return A.ctx.el.apply(null,arguments)}
function q(s){return encodeURIComponent(s)}
function press(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-vtp-user-action':'1'},body:JSON.stringify(body),cache:'no-store'}).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}if(!r.ok)throw new Error((j&&j.error)||('Something went wrong (error '+r.status+').'));return j})})}
window.vtpConnectHome=function(ctx){A.ctx=ctx;css();paint();if(!A.st&&!A.loading)refresh(false);
 if(!A.timer)A.timer=setInterval(function(){if(document.visibilityState==='visible'&&!location.hash&&!anyBusy())refresh(false)},15000)};
function anyBusy(){for(var k in A.busy)if(A.busy[k])return true;return false}
function refresh(force){A.loading=1;return A.ctx.api('GET','/api/ai-addons/status'+(force?'?force=1':'')).then(function(s){A.st=s;A.err=null;A.loading=0;if(!location.hash)paint()},function(e){A.err=e.message;A.loading=0;if(!location.hash)paint()})}
function copyBtn(label,text){var b=el('button',{class:'btn',type:'button',text:label});b.addEventListener('click',function(){try{navigator.clipboard.writeText(text);b.textContent='Copied!';setTimeout(function(){b.textContent=label},1800)}catch(e){prompt('Copy this:',text)}});return b}
function short(id){return SHORT[id]||id}
// ---------------------------------------------------------------- the page
function paint(){var S=A.ctx.S;var m=A.ctx.main;var y=window.scrollY;
 var desk=S.list.filter(function(c){return c.kind==='desktop'});
 var here=desk.filter(function(c){return c.supported&&(c.installed===true||c.added)});
 var rest=S.list.filter(function(c){return here.indexOf(c)<0&&c.supported!==false});
 m.replaceChildren(
  el('p',{class:'eyebrow',text:'AI connectors'}),
  el('h1',null,'Connect your ',el('span',{class:'g',text:'AI'})),
  el('p',{class:'lead',text:'Your AI app gets VTube Pro\'s tools and our build instructions. Nothing on your stream changes without your OK, and your settings stay on this PC.'}),
  modelCard(),
  el('p',{class:'eyebrow ch-sec',text:here.length?'On this computer':'Get an AI app'}),
  here.length?el('div',{class:'ch-list'},here.map(appRow)):noApps(),
  el('p',{class:'eyebrow ch-sec',text:'Other ways'}),
  el('div',{class:'ch-other'},rest.map(otherCard),comfyCard()),
  localNote(),
  el('p',{class:'eyebrow ch-sec',text:'Make your AI better'}),
  addons(here),
  el('div',{class:'ch-adv'},el('a',{href:'/aiconnect'+(location.search||''),text:'Advanced: approvals, internet bridge, instruction pack'}),el('a',{href:'/tools.html?view=ai-setup',target:'_blank',rel:'noopener',text:'Blender and connection checks'})));
 window.scrollTo(0,y)}
function modelCard(){var st=A.st;if(!st)return el('div',{class:'ch-model glass'},el('p',{class:'note',text:A.err?'We couldn\'t check the add-ons: '+A.err:'Checking this computer…'}));
 var M=st.model;var why=el('details',null,el('summary',{text:'Why?'}),
  el('p',{class:'small',text:M.honest}),
  el('ul',null,M.sources.map(function(s){return el('li',null,el('a',{href:s.url,target:'_blank',rel:'noopener noreferrer',text:s.label}))})),
  el('p',{class:'small',text:'Last checked '+M.checkedAt+'.'}));
 return el('section',{class:'ch-model glass','aria-label':'Recommended model'},
  el('div',{class:'star'},el('b',{text:'★ '}),M.headline.text),el('p',{class:'small',style:'margin:0',text:M.headline.where}),
  el('ul',null,M.alsoGreat.map(function(x){return el('li',null,el('b',{text:'Also great: '+x.name+'. '}),x.text+' ',el('span',{class:'small',text:x.where}))}),el('li',null,el('b',{text:'On your own PC: '+M.local.name+'. '}),M.local.text+' ',el('span',{class:'small',text:M.local.where}))),why)}
function stat(c){if(!c.supported)return ['off','Not on this computer'];if(c.added&&c.current===false)return ['warn','Connect again'];
 if(c.ready)return (c.seenAt||(c.lastTest&&c.lastTest.ok)||c.id==='lm-studio')?['ok','Connected']:['warn','Restart '+short(c.id)];
 if(c.installed===true)return ['','Found, not connected'];return ['','Not set up']}
function appRow(c){var s=stat(c);var chip=el('span',{class:'chip '+s[0]},s[0]==='ok'?el('span',{class:'d'}):null,s[1]);
 var acts=[];
 if(!c.added||c.current===false)acts.push(el('a',{class:'btn p',href:'#'+c.id,text:c.added?'Connect again':'Connect'}));
 else if(s[0]==='warn')acts.push(el('a',{class:'btn p',href:'#'+c.id,text:'Restart, then test'}));
 if(c.ready&&A.st)acts.push(copyBtn('Copy the first message',A.st.firstMessage));
 if(c.ready)acts.push(el('a',{class:'btn ghost',href:'#'+c.id,text:'Test'}));
 var sub=c.ready?(s[0]==='ok'?'Start a new chat and paste the first message: your AI reads VTube Pro\'s build instructions first.':'Quit '+short(c.id)+' fully and open it again so it loads VTube Pro.'):'One click: we add VTube Pro to '+short(c.id)+'\'s settings and keep a backup.';
 return el('div',{class:'ch-row glass'},el('span',{class:'nm',text:c.name}),chip,el('span',{class:'sp'}),acts,el('span',{class:'sub',text:sub}))}
function noApps(){return el('div',{class:'ch-row glass'},el('span',{class:'nm',text:'No AI app found yet'}),el('span',{class:'sp'}),
 el('a',{class:'btn p',href:'https://claude.ai/download',target:'_blank',rel:'noopener noreferrer',text:'Get Claude (recommended)'}),el('a',{class:'btn',href:'https://chatgpt.com/download',target:'_blank',rel:'noopener noreferrer',text:'Get ChatGPT'}),
 el('span',{class:'sub',text:'Install one, log in, then come back: this page finds it by itself.'}))}
var KIND={desktop:'App',remote:'Cloud bot',local:'Free, on this PC'};
function otherCard(c){var s=stat(c);var line=c.kind==='local'?'Ollama, LM Studio or llama.cpp: free and private.':c.kind==='remote'?'Grok Bot and grok.com, through a private internet address you switch on.':c.blurb;
 return el('a',{class:'glass',href:'#'+c.id},el('span',{class:'note',text:KIND[c.kind]||''}),el('b',{text:c.name}),el('span',{text:line}),s[0]==='ok'?el('span',{class:'ok',text:'✔ Connected'}):null)}
function comfyCard(){var st=A.st;var t=st&&st.tools.comfyui;var line=!t?'Checking…':t.running?'Running ✓ Every connected AI can make thumbnails, emotes and textures with it.':t.found?'Installed, not running: open ComfyUI to use it.':'A free picture maker on your graphics card (for thumbnails, emotes, textures).';
 return el('a',{class:'glass',href:t&&t.found?'/comfyui':'/tools.html?tool=comfyui',target:'_blank',rel:'noopener'},el('span',{class:'note',text:'Picture maker'}),el('b',{text:'ComfyUI'}),el('span',{text:line}))}
function localNote(){var S=A.ctx.S;var L=null;for(var i=0;i<S.list.length;i++)if(S.list[i].kind==='local')L=S.list[i];if(!L||!A.st)return null;
 var box=el('div',{class:'honest',style:'margin-top:12px'},el('b',{text:'Free model on this PC: '}),A.st.localNote+' Best local pick: '+A.st.model.local.name+' ('+A.st.model.local.size+'; needs a strong graphics card).');
 if(L.baseUrl&&L.model){var b=el('button',{class:'btn',type:'button',style:'margin-left:8px',text:'Can '+L.model+' use tools?'});
  b.addEventListener('click',function(){A.ltc={busy:1};paint();press('/api/ai-addons/local-tools',{baseUrl:L.baseUrl,model:L.model}).then(function(r){A.ltc=r;paint()},function(e){A.ltc={title:e.message,detail:''};paint()})});
  box.append(' ',b);if(A.ltc)box.append(A.ltc.busy?el('p',{class:'note',text:'Asking your model… (up to a minute)'}):el('p',null,el('b',{class:A.ltc.state==='tools'?'ok':'warn',text:A.ltc.title}),' '+(A.ltc.detail||'')))}
 return box}
// ---------------------------------------------------------------- add-ons
function addons(here){var st=A.st;if(!st)return el('p',{class:'note',text:A.err?'':'Checking which add-ons fit this computer…'});
 var apps=here.map(function(c){return c.id}).filter(function(id){return st.recs[id]});if(!apps.length)apps=['claude-desktop','chatgpt-desktop','claude-code','codex-cli'];
 if(!A.app||apps.indexOf(A.app)<0)A.app=apps[0];var app=A.app;
 var tabs=el('div',{class:'ch-tabs',role:'group','aria-label':'Which AI app'},apps.map(function(id){var b=el('button',{type:'button','aria-pressed':String(id===app),text:'For '+short(id)});b.addEventListener('click',function(){A.app=id;paint()});return b}));
 var recs=st.recs[app]||[];var main=[],more=[];
 recs.forEach(function(r){var a=byId(r.id);if(!a)return;(r.level==='default'?main:more).push(addonCard(a,r,app))});
 return el('div',null,el('p',{class:'note',style:'margin:0 0 10px',text:'Free extras that make your AI better at building for VTube Pro. Nothing is installed until you tick “Yes”.'}),tabs,
  el('div',{class:'ch-list'},main),more.length?el('details',{class:'ch-more'},el('summary',{text:'More add-ons ('+more.length+')'}),el('div',{class:'ch-list',style:'margin-top:10px'},more)):null,
  el('div',{class:'row'},el('button',{class:'btn ghost',type:'button',onclick:function(){refresh(true)},text:'Check again'})))}
function byId(id){var l=A.st.addons;for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i];return null}
function badge(a){var cls=a.status==='ours'?'ours':a.status==='first-party'?'off':a.status==='community'?'com':'';var t=a.status==='ours'?'By VTube Pro':a.status==='first-party'?'Official · '+a.maker:a.status==='community'?'Community · '+a.maker.replace(/ \(community\)/,''):'By '+a.maker;return el('span',{class:'badge '+cls,text:t})}
function inApp(a,app){var x=a.inApps[app];if(!x&&(app==='codex-cli'||app==='chatgpt-desktop'))x=a.inApps[app==='codex-cli'?'chatgpt-desktop':'codex-cli'];return x||null}
function missing(a){var t=A.st.tools;return (a.requires||[]).filter(function(id){return t[id]&&!t[id].found})}
function skillDest(app){var d=A.st.skill.dests;for(var i=0;i<d.length;i++)if(d[i].app===app)return d[i];return null}
function addonCard(a,r,app){var way=a.ways[app]||{};var card=el('section',{class:'ch-add glass'});
 card.append(el('div',{class:'top2'},el('h3',{text:a.name}),badge(a),a.price!=='free'?el('span',{class:'badge',text:a.price==='paid'?'Paid':'Free tier'}):null));
 var res=A.res[a.id+':'+app];var need=missing(a);
 card.append(el('p',{text:a.blurb}));if(r.why&&!need.length)card.append(el('p',{class:'why',text:r.why}));
 // state + actions
 if(a.kind==='ours-skill'){
  if(app==='claude-desktop'){card.append(el('ol',null,(way.steps||[]).map(function(s){return el('li',{text:s})})),el('div',{class:'row'},el('a',{class:'btn p',href:'/api/ai-addons/skill.zip',download:'vtube-pro-creator.zip',text:'Get the skill file'}),el('a',{class:'btn',href:way.url,target:'_blank',rel:'noopener noreferrer',text:'Open Claude’s Skills page'})))}
  else{var d=skillDest(app);var s=d?d.state:'missing';
   if(s==='current')card.append(el('p',{class:'state ok',text:'✔ Added to '+short(app)+' (version '+A.st.skill.version+').'}));
   else if(s==='foreign')card.append(el('p',{class:'state warn',text:'There is already a folder with this name that VTube Pro didn’t make, so we won’t touch it: '+d.dir}));
   else card.append(sheetOrButton(a,app,s==='missing'?'Add it':'Update it',s==='edited'?'You changed your copy: we keep it as a backup and put the new one in its place.':''));}
 }else if(a.kind==='mcp-local'&&way.how==='auto'){var x=inApp(a,app);
  if(x){var run=a.extra.running;card.append(el('p',{class:'state ok',text:'✔ '+(x.ours?'Added to ':'Already in ')+short(app)+(x.ours?'':' (your own setup, “'+x.name+'”)')+'.'}));
   if(a.id==='gimp-mcp'&&a.extra.pluginInstalled===false)card.append(el('p',{class:'state warn',text:'GIMP doesn’t have its MCP plug-in yet.'}));
   card.append(el('p',{class:'state '+(run?'ok':''),text:run?'✔ Running now: your AI can use it.':a.id==='gimp-mcp'?'To use it: open GIMP, then Tools > MCP > Start MCP Server.':'To use it: open Blender, press N in the 3D view, open the BlenderMCP tab and press Connect.'}));
   if(x.ours)card.append(el('div',{class:'row'},el('button',{class:'btn ghost',type:'button',onclick:function(){if(confirm('Take '+a.name+' out of '+short(app)+'? We back up its settings first.'))act(a,app,'remove')},text:'Take it out of '+short(app)})));}
  else if(need.length)card.append(el('p',{class:'state',text:'Needs '+need.map(function(n){return TOOL_NAME[n]||n}).join(' and ')+' first (free).'}),el('div',{class:'row'},need.map(function(n){return el('a',{class:'btn p',href:'/tools.html?tool='+q(n),target:'_blank',rel:'noopener',text:'Get '+(TOOL_NAME[n]||n)})}),el('button',{class:'btn ghost',type:'button',onclick:function(){refresh(true)},text:'I installed it'})));
  else card.append(sheetOrButton(a,app,'Set it up',''));
 }else if(way.how==='link'||way.how==='copy'){
  if(way.steps)card.append(el('ol',null,way.steps.map(function(s){return el('li',{text:s})})));
  var row=el('div',{class:'row'});if(way.url)row.append(el('a',{class:'btn',href:way.url,target:'_blank',rel:'noopener noreferrer',text:'Open'}));if(way.command){row.append(el('code',{text:way.command}),copyBtn('Copy',way.command))}card.append(row);
  if(a.id==='blender-lab-mcp'&&app==='claude-desktop')card.append(sheetOrButton(a,app,'Get Blender’s extension file instead',''));
 }else if(way.how==='built-in')card.append(el('p',{class:'state ok',text:'✔ Already part of '+short(app)+': nothing to install.'}));
 else if(a.links&&a.links.length)card.append(el('div',{class:'row'},a.links.map(function(l){return el('a',{class:'btn',href:l.url,target:'_blank',rel:'noopener noreferrer',text:l.label})})));
 if(res)card.append(result(res));
 card.append(el('p',{class:'note',style:'margin:0'},a.licence.name+' · ',el('a',{href:a.homepage,target:'_blank',rel:'noopener noreferrer',text:'about it'})));
 return card}
function sheetOrButton(a,app,label,extra){var k=a.id+':'+app;
 if(!A.open[k]){var b=el('button',{class:'btn p',type:'button',text:label});b.addEventListener('click',function(){A.open[k]=1;paint()});return el('div',{class:'row'},b)}
 var sheet=el('div',{class:'ch-sheet'});
 var targets=a.kind==='ours-skill'?skillTargets(app):[app];
 if(a.cautions&&a.cautions.length)sheet.append(el('b',{text:'Before you say yes:'}),el('ul',null,a.cautions.map(function(c){return el('li',{text:c})})));
 if(extra)sheet.append(el('p',{class:'warn',text:extra}));
 var what=el('p',{class:'note',text:a.kind==='ours-skill'?'We put the skill folder in each app’s skills folder (nothing else changes).':a.id==='blender-lab-mcp'?'We download Blender’s own extension file from its releases page, check it, and open it with Claude Desktop (Claude asks you before installing).':'We add one entry to '+short(app)+'’s settings and keep a backup of the old file. Nothing else changes.'});
 sheet.append(what);
 var pv=el('pre',{text:'…'});if(a.kind==='mcp-local'&&a.id!=='blender-lab-mcp'){sheet.append(el('details',null,el('summary',{text:'Show exactly what we add'}),pv));
  A.ctx.api('GET','/api/ai-addons/'+q(a.id)+'/preview?app='+q(app)).then(function(p){pv.textContent=(p.skipped?p.skipped+'\n':'')+'File: '+p.configPath+'\n\n'+p.entryText+(p.others.length?'\n\nKept as they are: '+p.others.join(', '):'')},function(e){pv.textContent=e.message})}
 var box=el('input',{type:'checkbox'});var extraBox=null;
 var go=el('button',{class:'btn p',type:'button',disabled:true,text:a.id==='blender-lab-mcp'?'Download and open':'Set it up'});box.addEventListener('change',function(){go.disabled=!box.checked});
 sheet.append(el('label',{class:'consent'},box,el('span',{text:a.id==='blender-lab-mcp'?'I understand Blender’s warning above.':'Yes, set up '+a.name+' for '+targets.map(short).join(', ')+'.'})));
 if(a.id==='mcp-for-blender'){extraBox=el('input',{type:'checkbox'});sheet.append(el('label',{class:'consent'},extraBox,el('span',{text:'Also put its add-on into my Blender (recommended).'})))}
 go.addEventListener('click',function(){act(a,app,'setup',{apps:targets,blenderAddon:!!(extraBox&&extraBox.checked)})});
 sheet.append(el('div',{class:'row'},go,el('button',{class:'btn ghost',type:'button',onclick:function(){A.open[k]=0;paint()},text:'Cancel'})));
 if(A.busy[k])sheet.append(el('div',{class:'res'},el('span',{class:'spin'}),' Working… this can take a minute.'));
 return sheet}
function skillTargets(app){var S=A.ctx.S;var t=[app];S.list.forEach(function(c){if(c.kind==='desktop'&&(c.installed===true||c.added)&&SKILL_APPS.indexOf(c.id)>=0&&t.indexOf(c.id)<0)t.push(c.id)});return t}
function act(a,app,what,body){var k=a.id+':'+app;A.busy[k]=1;paint();
 var kind=a.kind==='ours-skill'?'skill':a.id==='blender-lab-mcp'&&what==='setup'?'mcpb':what;
 var url=kind==='skill'?'/api/ai-addons/skill':kind==='mcpb'?'/api/ai-addons/blender-lab-mcp/mcpb':'/api/ai-addons/'+q(a.id)+'/'+what;
 var apps=(body&&body.apps)||[app];
 var payload={consent:true,apps:apps};if(body&&body.blenderAddon)payload.blenderAddon=true;
 press('/api/ai-addons/consent',{action:kind,id:a.id,apps:apps}).then(function(g){payload.token=g.token;return press(url,payload)}).then(function(r){A.busy[k]=0;A.open[k]=0;A.res[k]=what==='remove'?{ok:true,title:'Taken out of '+short(app),detail:(r.writes||[]).map(function(w){return w.note||(w.backup?'Backup: '+w.backup:'')}).join(' ')}:r;return refresh(true)},
  function(e){A.busy[k]=0;A.res[k]={ok:false,title:e.message};paint()})}
function result(r){var box=el('div',{class:'res '+(r.ok?'good':'fail')},el('b',{text:(r.ok?'✔ ':'')+r.title}));if(r.detail)box.append(el('p',{text:r.detail}));
 if(r.steps&&r.steps.length)box.append(el('ul',null,r.steps.map(function(s){return el('li',{text:s})})));
 if(r.next&&r.next.length&&r.ok)box.append(el('b',{text:'Next:'}),el('ol',null,r.next.map(function(s){return el('li',{text:s})})));
 if(r.fix)box.append(el('p',{class:'fix',text:r.fix}));return box}
})();`;

// The Stream keys page (served at http://127.0.0.1:<helper port>/stream-keys; the Go Live tab's "Stream keys" button opens it).
// Why it exists: pasted stream keys and a typed stream address are accepted from the Helper's OWN page on this PC only
// (origin 'local-page', server/routes/broadcast.ts), never from a website. A key is never typed into a normal studio tab, so without this page nobody could enter a key. It lists the destinations and calls the
// existing /api/broadcast endpoints; it adds no new way to write a key. A key is typed into a password box, sent once as the body of
// POST /api/broadcast/keys/:id, and the box is emptied. It is never put in the page, an attribute, storage or a log, and the server
// never sends it back. Plain HTML + JS (no bundler entry), like server/aiconnectPage.ts. Makes no sound. Docs: docs/GO_LIVE.md.
// Served with a one-time script nonce and frame-ancestors 'none' (server/routes/streamKeys.ts).
export const STREAM_KEYS_NONCE_TOKEN = '__VTP_NONCE__';

export const STREAM_KEYS_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Stream keys - VTube Pro</title>
<style>
:root{color-scheme:dark;--bg:#06080a;--card:#0e1317;--card2:#131a1f;--line:rgb(255 255 255/.09);--fg:#eef3ef;--mute:#a3afa9;--dim:#8b9791;--acc:#7bd88f;--acc-hi:#a6f5b4;--sky:#6cc7f5;--ok:#7bd88f;--warn:#ffcf6a;--bad:#ff7b7b;--r:14px;--ease:cubic-bezier(.16,1,.3,1)}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;background:radial-gradient(800px 340px at 50% -10%,rgb(123 216 143/.07),transparent 70%),var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
main{max-width:760px;margin:0 auto;padding:20px 16px 64px}
.top{display:flex;align-items:center;gap:10px;margin:0 0 14px}.top svg{width:28px;height:28px;flex:none}
h1{font-size:22px;line-height:1.2;letter-spacing:-.01em;margin:0}h2{font-size:16px;line-height:1.3;margin:0 0 8px}
.beta{font:600 10px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--acc);border:1px solid rgb(123 216 143/.35);background:rgb(123 216 143/.08);border-radius:999px;padding:4px 8px}
.sub{color:var(--mute);margin:0 0 16px;max-width:640px}
section{background:linear-gradient(180deg,rgb(255 255 255/.045),rgb(255 255 255/.018));border:1px solid var(--line);border-radius:var(--r);padding:16px;margin:0 0 12px;box-shadow:inset 0 1px 0 rgb(255 255 255/.05);animation:rise .28s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;background:var(--acc);color:#06080a;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;transition:background-color .18s,transform .18s var(--ease),opacity .18s}
button:hover,.btn:hover{background:var(--acc-hi);color:#06080a}button:active,.btn:active{transform:scale(.97)}
button.s{background:var(--card2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}button.s:hover{background:#1b252c;color:var(--fg)}
button.d{background:var(--bad);color:#06080a}button.d:hover{background:#ff9a9a}button:disabled{opacity:.5;cursor:default;transform:none}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:8px}
input{background:#080b0e;color:var(--fg);border:1px solid var(--line);border-radius:10px;font:12.5px/1.45 ui-monospace,Consolas,Menlo,monospace;padding:8px;max-width:100%;width:100%;transition:border-color .18s}
input:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px rgb(123 216 143/.2)}
::placeholder{color:#8b9791;opacity:1}
.pill{display:inline-block;white-space:nowrap;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600;background:var(--card2);border:1px solid var(--line);color:var(--fg);vertical-align:1px}
.pill.ok{color:var(--ok);border-color:rgb(123 216 143/.4)}.pill.warn{color:var(--warn);border-color:rgb(255 207 106/.4)}.pill.bad{color:var(--bad);border-color:rgb(255 123 123/.4)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mute{color:var(--mute)}.small{font-size:12.5px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.row.grow>*{flex:1 1 200px}
label.f{display:block;margin:10px 0 0}label.f>span{display:block;color:var(--mute);font-size:12.5px;margin:0 0 4px}
.dest{border-top:1px solid var(--line);padding:14px 0 0;margin:14px 0 0}.dest:first-of-type{border-top:0;padding-top:0;margin-top:0}
.dest h3{font-size:15px;margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.code{font:700 26px/1.2 ui-monospace,Consolas,Menlo,monospace;letter-spacing:.2em;background:#080b0e;border:1px solid var(--line);border-radius:10px;padding:10px 14px;display:inline-block;margin:6px 0}
a{color:var(--sky);transition:color .18s}a:hover{color:#9bdcff}
#msg{min-height:22px;margin:0 0 10px}
@media (max-width:480px){.row button,.row .btn{flex:1 1 auto}h1{font-size:19px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style></head><body><main>
<div class="top"><svg viewBox="8 16 84 72" aria-hidden="true"><defs><linearGradient id="lg" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient></defs><path fill="url(#lg)" d="M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z"/></svg><h1>Stream keys</h1><span class="beta">Beta</span></div>
<p class="sub">Paste your stream key once, here, on this computer. It is locked away on this computer, sent to OBS only when you press Go Live in the VTube Pro studio, and never shown again. It never goes through a website.</p>
<p id="msg" role="status" aria-live="polite" class="mute"></p>

<section id="destSec"><h2>Where you stream</h2><div id="dests"><p class="mute">Loading...</p></div></section>

<section id="addSec"><h2>Add another place</h2><p class="mute small">Pick the site you stream to. You paste its key next.</p><div class="row" id="addRow"></div></section>

<p class="mute small">Nothing here starts a stream. Press Go Live in the VTube Pro studio when you are ready.</p>
</main>
<script nonce="__VTP_NONCE__">(function(){
'use strict';
var API='/api/broadcast';
var NAMES={twitch:'Twitch',youtube:'YouTube',kick:'Kick',tiktok:'TikTok',custom:'Other site'};
var ORDER=['twitch','youtube','kick','tiktok','custom'];
var state={dests:[],busy:false};
function $(id){return document.getElementById(id)}
function el(tag,attrs){var e=document.createElement(tag);if(attrs)for(var k in attrs){if(k==='text')e.textContent=attrs[k];else if(k==='cls')e.className=attrs[k];else e.setAttribute(k,attrs[k])}for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c)e.appendChild(c)}return e}
function say(text,cls){var m=$('msg');m.textContent=text||'';m.className=cls||'mute'}

/* One call. Never logs a request or an answer. A key leaves this page only as the body of POST /keys/:id. */
function call(method,path,body){
  var h={};if(body!==undefined)h['content-type']='application/json';if(method!=='GET')h['x-vtp-user-action']='1';
  return fetch(API+path,{method:method,cache:'no-store',headers:h,body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){
    return r.json().then(function(j){return j&&typeof j==='object'&&typeof j.ok==='boolean'?j:{ok:false,error:'VTube Pro did not understand that.'}},function(){return {ok:false,error:'VTube Pro did not understand that.'}});
  },function(){return {ok:false,error:'Can’t reach VTube Pro. Is it running on this computer?'}});
}
function why(r){return r&&typeof r.error==='string'&&r.error?r.error:'That did not work. Try again.'}

function load(){
  return call('GET','/destinations').then(function(r){
    if(!r.ok){say(why(r),'bad');state.dests=[];render();return}
    state.dests=Array.isArray(r.destinations)?r.destinations:[];render();
  });
}

function stateOf(d){
  if(d.keyState==='saved')return {t:'Key saved',c:'ok'};
  return {t:'Needs a key',c:'warn'};
}

function destCard(d){
  var st=stateOf(d),has=d.keyState==='saved';
  var name=(d.label&&d.label.trim())||NAMES[d.platform]||'Other';
  var card=el('div',{cls:'dest','data-dest':d.id});
  card.appendChild(el('h3',null,el('span',{text:name}),el('span',{cls:'pill '+st.c,text:st.t})));
  if(d.needs)card.appendChild(el('p',{cls:'mute small',text:d.needs}));
  {
    var key=el('input',{type:'password',autocomplete:'off',autocapitalize:'off',spellcheck:'false',maxlength:'512','aria-label':'Stream key','data-f':'key',placeholder:has?'A key is saved. Paste a new one to replace it.':'Paste your stream key'});
    var save=function(){saveKey(d,key)};
    key.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();save()}});
    card.appendChild(el('label',{cls:'f'},el('span',{text:'Your '+(NAMES[d.platform]||'stream')+' stream key'}),key));
    var kr=el('div',{cls:'row'},btn(has?'Replace key':'Save key','',save,'save-key'));
    if(has)kr.appendChild(btn('Forget the key','s',function(){clearKey(d)},'clear-key'));
    card.appendChild(kr);
  }
  /* a typed stream address: Kick, TikTok and other sites (Twitch and YouTube use their own) */
  if(d.platform==='kick'||d.platform==='tiktok'||d.platform==='custom'){
    var url=el('input',{type:'text',autocomplete:'off',spellcheck:'false',maxlength:'300','aria-label':'Stream address','data-f':'url',placeholder:d.platform==='custom'?'rtmp://... (where your site wants the stream sent)':'Leave empty to use '+NAMES[d.platform]+'’s own address'});
    url.value=d.url||'';
    var nm=el('input',{type:'text',autocomplete:'off',maxlength:'60','aria-label':'Name','data-f':'label',placeholder:NAMES[d.platform]});nm.value=d.label||'';
    card.appendChild(el('label',{cls:'f'},el('span',{text:'Name'}),nm));
    card.appendChild(el('label',{cls:'f'},el('span',{text:'Stream address (starts with rtmp:// or rtmps://; never put the key in it)'}),url));
    card.appendChild(el('div',{cls:'row'},btn('Save name and address','s',function(){saveMeta(d,nm.value,url.value)},'save-meta')));
  }
  var rm=btn('Remove this one','s',null,'remove-dest'),armed=0;
  rm.addEventListener('click',function(){
    if(armed){clearTimeout(armed);armed=0;remove(d)}else{rm.textContent='Press again to remove';armed=setTimeout(function(){armed=0;rm.textContent='Remove this one'},3000)}
  });
  card.appendChild(el('div',{cls:'row'},rm));
  return card;
}
function btn(text,cls,fn,tag){var b=el('button',{type:'button',cls:cls||'','data-a':tag||'',text:text});if(fn)b.addEventListener('click',fn);return b}

function render(){
  var box=$('dests');box.textContent='';
  if(!state.dests.length)box.appendChild(el('p',{cls:'mute',text:'You have not added anywhere to stream yet. Pick a site below.'}));
  state.dests.forEach(function(d){box.appendChild(destCard(d))});
  var add=$('addRow');add.textContent='';
  ORDER.forEach(function(p){add.appendChild(btn(NAMES[p],'s',function(){addDest(p)},'add-'+p))});
}

function busy(on){state.busy=on;var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].disabled=on}
function act(p,ok){busy(true);return p.then(function(r){busy(false);return ok(r)},function(){busy(false);say('Something went wrong. Try again.','bad')})}

function saveKey(d,input){
  var k=input.value;
  if(!k.trim()){say('Paste your stream key first.','warn');input.focus();return}
  input.value='';                                   /* emptied the moment it is sent: the key is never kept on this page */
  act(call('POST','/keys/'+encodeURIComponent(d.id),{key:k}),function(r){
    k='';
    if(!r.ok){say(why(r),'bad');return}
    say('Saved. Your key is locked on this computer and will not be shown again.','ok');return load();
  });
}
function clearKey(d){
  act(call('DELETE','/keys/'+encodeURIComponent(d.id)),function(r){if(!r.ok){say(why(r),'bad');return}say('The key was forgotten.','ok');return load()});
}
function saveMeta(d,label,url){
  var input={id:d.id,platform:d.platform,label:label.trim(),url:url.trim(),enabled:d.enabled!==false};
  act(call('POST','/destinations',{destination:input}),function(r){if(!r.ok){say(why(r),'bad');return}say('Saved.','ok');return load()});
}
function addDest(p){
  act(call('POST','/destinations',{destination:{platform:p,label:'',url:''}}),function(r){
    if(!r.ok){say(why(r),'bad');return}
    say('Added '+NAMES[p]+'. Paste its stream key below.','ok');return load().then(function(){
      var c=r.destination&&document.querySelector('[data-dest="'+String(r.destination.id).replace(/[^\w-]/g,'')+'"] [data-f="key"]');if(c)c.focus();
    });
  });
}
function remove(d){
  act(call('DELETE','/destinations/'+encodeURIComponent(d.id)),function(r){if(!r.ok){say(why(r),'bad');return}say('Removed.','ok');return load()});
}

load();
})();</script></body></html>`;

// The helper's own page for support keys: /support/connect#<service> (this PC only, never framed, no web Origin).
// The studio opens it in a new tab (keys are never typed into the studio tab itself).
// One card per service from SERVICE_INFO: plain steps, the key boxes (password fields, never filled back in), Save,
// "Get my address" for webhooks (copy button), "Send a test", and a status line that follows the real connector.
// Same look as the helper's other pages (server/chat/connectPage.ts).
export const SUPPORT_CONNECT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VTube Pro · Support & store</title>
<style>
:root{color-scheme:dark;--ink:#06080a;--ink-2:#0b0f12;--line:rgb(255 255 255/.08);--line-strong:rgb(255 255 255/.14);--fg:#eef3ef;--mute:#9aa6a0;--lime:#7bd88f;--lime-hi:#a6f5b4;--sky:#6cc7f5;--err:#ff6b6b;--amber:#ffcf6a}
*{box-sizing:border-box}html{background:var(--ink)}body{margin:0;min-height:100vh;background:radial-gradient(1100px 560px at 15% -10%,#12301e55,transparent),var(--ink);color:var(--fg);font:16px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 56px}
.brand{display:flex;align-items:center;gap:10px;font:700 17px/1 Archivo,ui-sans-serif,system-ui,sans-serif}
h1{font:700 28px/1.15 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;margin:22px 0 6px}h2{font:700 19px/1.2 Archivo,ui-sans-serif,system-ui,sans-serif;margin:0;display:flex;align-items:center;gap:10px}
p{color:var(--mute);margin:6px 0}b{color:var(--fg)}
section{background:linear-gradient(180deg,rgb(255 255 255/.055),rgb(255 255 255/.02));border:1px solid var(--line);border-radius:18px;padding:18px 20px;margin:14px 0}
section.on{border-color:rgb(123 216 143/.45)}
section summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px}section summary::-webkit-details-marker{display:none}
.st{font-size:14px;color:var(--mute);margin-left:auto;text-align:right}.st.ok{color:var(--lime)}.st.err{color:var(--err)}
button{font:600 15px/1 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;border-radius:12px;padding:13px 18px;border:1px solid var(--line-strong);background:rgb(255 255 255/.06);color:var(--fg);cursor:pointer;margin:6px 6px 0 0}
button.primary{background:var(--lime);color:var(--ink);border-color:transparent}button.primary:hover{background:var(--lime-hi)}button:disabled{opacity:.6;cursor:progress}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--lime);outline-offset:3px}
input{font:inherit;width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line-strong);background:var(--ink-2);color:var(--fg);margin:4px 0}
label{font-size:14px;color:var(--mute);display:block;margin-top:10px}label small{display:block;color:var(--mute);opacity:.85}a{color:var(--sky)}
ol{color:var(--mute);padding-left:20px;margin:10px 0}li{margin:4px 0}
.addr{display:flex;gap:8px;align-items:center;margin-top:8px}.addr code{flex:1;min-width:0;font:12.5px ui-monospace,Consolas,monospace;background:var(--ink-2);border:1px solid var(--line);border-radius:8px;padding:9px;word-break:break-all}
.out{margin-top:10px;font-size:15px;min-height:1.4em}.out.ok{color:var(--lime)}.out.err{color:var(--err)}
.dot{width:12px;height:12px;border-radius:50%;flex:none}
.vault{font-size:13px;color:var(--mute)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main>
<div class="brand">VTube Pro</div>
<h1>Support &amp; store</h1>
<p>Keys are added here, on this computer. They are <b>never</b> sent to a website and never shown again.</p>
<p class="vault" id="vault"></p>
<div id="cards"></div>
<p><small style="color:var(--mute)">Close this tab when you’re done.</small></p>
</main>
<script nonce="__SN__">
const INFO=__INFO__;
const COLORS={fourthwall:'#ff5c39',throne:'#a77bff',stripe:'#635bff',bmc:'#ffdd00',patreon:'#ff424d',kofi:'#29abe0',streamelements:'#3c74f6',streamlabs:'#80f5d2'};
const $=(s,r=document)=>r.querySelector(s);
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[n,v]of Object.entries(a)){if(n==='on')for(const[ev,f]of Object.entries(v))e.addEventListener(ev,f);else if(n==='text')e.textContent=v;else e.setAttribute(n,v)}for(const c of k)if(c!=null)e.append(c);return e};
async function call(u,m,b){const r=await fetch(u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function say(o,ok,t){o.className='out '+(ok?'ok':'err');o.textContent=t}
const want=(location.hash||'').slice(1);
let status=null;const lights={};
function paint(){if(!status)return;$('#vault').textContent='How your keys are kept: '+status.vault.label+'.';for(const[id,l]of Object.entries(lights)){const s=status.services[id];if(!s)continue;const saved=s.saved.length?' · saved: '+s.saved.length+' key'+(s.saved.length>1?'s':''):'';l.className='st '+(s.state==='live'?'ok':s.state==='error'?'err':'');l.textContent=(s.enabled?(s.state==='live'?'connected ✓':s.state==='error'?'needs a fix':s.state==='connecting'?'connecting…':'not finished'):'off')+saved}}
async function refresh(){try{status=await call('/api/support/status','GET');paint()}catch{}}
for(const s of INFO){
 const out=el('div',{class:'out',role:'status'});
 const light=el('span',{class:'st'});lights[s.id]=light;
 const inputs=s.secrets.map(f=>{const i=el('input',{type:'password',autocomplete:'off',spellcheck:'false',placeholder:f.optional?'(optional)':'Paste it here'});i.dataset.key=f.key;return el('label',{},f.label,el('small',{text:f.hint}),i,f.where?el('a',{href:f.where,target:'_blank',rel:'noopener noreferrer',text:'Open the page where you find it ↗'}):null)});
 const body=el('div',{});
 body.append(el('p',{text:s.what}),el('ol',{},...s.steps.map(t=>el('li',{text:t}))));
 if(s.unofficial)body.append(el('p',{text:'Unofficial: may break when the service changes.'}));
 if(s.id==='throne')body.append(el('label',{},'Your Throne username',el('small',{text:'So only gifts for you are accepted.'}),Object.assign(el('input',{type:'text',id:'thr-cr',placeholder:'your Throne name'}),{})));
 body.append(...inputs);
 const btns=el('div',{});
 if(s.secrets.length){btns.append(el('button',{class:'primary',on:{click:async(ev)=>{const b=ev.currentTarget;const fields={};for(const i of body.querySelectorAll('input[data-key]'))if(i.value.trim())fields[i.dataset.key]=i.value.trim();if(!Object.keys(fields).length){say(out,false,'Paste the key first.');return}b.disabled=true;say(out,true,'Checking…');try{const st=await call('/api/support/secrets/'+s.id,'PUT',{fields});for(const i of body.querySelectorAll('input[data-key]'))i.value='';say(out,st.state!=='error',st.state==='error'?st.detail:(st.detail||'Saved ✓'))}catch(e){say(out,false,e.message)}b.disabled=false;refresh()}}},'Save and connect'))}
 if(s.how.includes('hook')){const addr=el('div',{class:'addr'});btns.append(el('button',{class:s.secrets.length?'':'primary',on:{click:async()=>{say(out,true,'Getting your address…');try{if(s.id==='throne'){const c=$('#thr-cr').value.trim();if(c)await call('/api/support/settings','PUT',{services:{throne:{creatorId:c,enabled:true}}})}const r=await call('/api/support/inbox','POST',{service:s.id});const code=el('code',{text:r.url});addr.replaceChildren(code,el('button',{on:{click:async()=>{try{await navigator.clipboard.writeText(r.url);say(out,true,'Copied ✓ Paste it into '+s.name+'.')}catch{say(out,false,'Select the address and copy it.')}}}},'Copy'));say(out,true,'Your address is ready. Paste it into '+s.name+'.');if(s.id!=='kofi'&&s.id!=='bmc')await call('/api/support/settings','PUT',{services:{[s.id]:{enabled:true}}})}catch(e){say(out,false,e.message)}refresh()}}},'Get my address'));body.append(addr)}
 btns.append(el('button',{on:{click:async()=>{try{const r=await call('/api/support/test','POST',{which:s.id});say(out,true,r.sent?'Test sent ✓ Look at the studio.':'Sent.')}catch(e){say(out,false,e.message)}}}},'Send a test'));
 btns.append(el('button',{on:{click:async()=>{if(!confirm('Remove the '+s.name+' keys from this computer and switch it off?'))return;try{await call('/api/support/secrets/'+s.id,'DELETE');say(out,true,'Removed from this computer.')}catch(e){say(out,false,e.message)}refresh()}}},'Remove'));
 body.append(btns,out);
 const det=el('details',{},el('summary',{},el('span',{class:'dot',style:'background:'+(COLORS[s.id]||'#888')}),el('h2',{text:s.name}),light),body);
 if(!want||want===s.id)det.open=true;
 const sec=el('section',{id:s.id,class:want===s.id?'on':''},det);
 $('#cards').append(sec);
}
refresh();setInterval(refresh,3000);
if(want){const t=document.getElementById(want);if(t)t.scrollIntoView({block:'start'})}
</script></body></html>`;

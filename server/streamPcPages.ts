// The pages a STREAM PC sees (served by the gaming PC's helper over the home network, server/streamPc.ts):
//   /streampc          pairing: type the code the gaming PC shows -> this PC gets its own OBS link
//   /streampc/view     mode B receiver: the finished video from the gaming PC, transparency put back (OBS loads it)
//   (no token)         a plain "connect this stream PC first" card instead of the app
// Self-contained HTML (no build step, no outside files). The pages never make a sound (video muted, no audio track).

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--ink:#14161f;--mut:#5b6175;--acc:#5b5bf0;--ok:#138a52;--err:#c0392b;--line:#dfe2ec}
@media (prefers-color-scheme:dark){:root{--bg:#12131a;--card:#1c1e28;--ink:#eef0f7;--mut:#a3a8bb;--acc:#8c8cff;--ok:#3ccf8e;--err:#ff7a6b;--line:#2c2f3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:22px;margin:0 0 6px}p{margin:8px 0;color:var(--mut)}b{color:var(--ink)}
label{display:block;font-weight:600;margin:16px 0 6px}
input{width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
#code{font:600 28px/1 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase;text-align:center}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 18px;background:var(--acc);color:#fff;cursor:pointer;margin-top:16px;width:100%}
button.sec{background:transparent;color:var(--acc);border:1px solid var(--line)}
.url{font:14px/1.4 ui-monospace,Consolas,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:8px;user-select:all}
.msg{margin-top:12px;font-weight:600}.msg.err{color:var(--err)}.msg.ok{color:var(--ok)}
ol{padding-left:22px;color:var(--mut)}li{margin:6px 0}
`;

/** GET /streampc: type the code from the gaming PC. (No computer names on this public page: stream-safe.) */
export function pairPage(o: { pcName: string; address: string; port: number }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Connect your stream PC</title><style>${BASE_CSS}</style></head><body><main>
<div class="card" id="step1">
  <h1>Connect this stream PC</h1>
  <p>On your gaming PC, open VTube Pro: <b>OBS &amp; stream → Streaming from a second PC</b>. It shows a 6-letter code.</p>
  <form id="f" autocomplete="off">
    <label for="code">Code from your gaming PC</label>
    <input id="code" inputmode="text" maxlength="7" placeholder="ABC-DEF" autofocus required>
    <label for="name">Name for this PC <span style="font-weight:400;color:var(--mut)">(optional)</span></label>
    <input id="name" maxlength="40" placeholder="Stream PC">
    <button type="submit">Connect</button>
    <div class="msg" id="msg" role="status"></div>
  </form>
</div>
<div class="card" id="step2" hidden>
  <h1>Connected ✓</h1>
  <p>Now put VTube Pro in OBS on this PC:</p>
  <ol><li>OBS → <b>Sources</b> → <b>+</b> → <b>Browser</b>.</li><li>Paste this link as the URL. Width <b>1920</b>, Height <b>1080</b>.</li><li>Press OK. Your avatar appears with a see-through background.</li></ol>
  <div class="url" id="url"></div>
  <button id="copy">Copy OBS link</button>
  <button class="sec" id="open">See it here</button>
  <div class="msg ok" id="msg2" role="status"></div>
  <p style="margin-top:16px">Keep this link private: it lets this PC show your stream from your gaming PC.</p>
</div>
</main><script>
const $=(i)=>document.getElementById(i);
const show=(url)=>{$('step1').hidden=true;$('step2').hidden=false;$('url').textContent=url;};
$('f').onsubmit=async(e)=>{e.preventDefault();const m=$('msg');m.className='msg';m.textContent='Connecting…';
  try{const r=await fetch('/streampc/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:$('code').value,name:$('name').value})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.url){m.className='msg err';m.textContent=j.error||'That didn’t work. Check the code on your gaming PC and try again.';return;}
    show(j.url);
  }catch(_){m.className='msg err';m.textContent='Your gaming PC didn’t answer. Is VTube Pro still open there?';}};
$('copy').onclick=async()=>{const u=$('url').textContent;let ok=false;
  try{await navigator.clipboard.writeText(u);ok=true;}catch(_){const t=document.createElement('textarea');t.value=u;document.body.append(t);t.select();try{ok=document.execCommand('copy');}catch(_){}t.remove();}
  $('msg2').textContent=ok?'Copied. Paste it into OBS.':'Select the link above and copy it (Ctrl+C).';};
$('open').onclick=()=>{location.href=$('url').textContent;};
</script></body></html>`;
}

/** An entry page (output.html, /streampc/obs, /streampc/view) asked for without a valid token. Transparent in OBS, with
 *  one plain sentence so the streamer sees what to do in the OBS preview. */
export function notPairedPage(o: { address: string; port: number; forgotten: boolean }): string {
  const url = `http://${o.address}:${o.port}/streampc`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect your stream PC</title>
<style>html,body{margin:0;background:transparent;font:28px/1.4 system-ui,"Segoe UI",sans-serif}
.c{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(16,18,26,.88);color:#fff;padding:28px 34px;border-radius:18px;max-width:80vw;text-align:center}
b{color:#9da0ff}</style></head><body><div class="c">
${o.forgotten ? 'This stream PC was disconnected on your gaming PC.' : 'This stream PC isn’t connected to VTube Pro yet.'}<br>
In a browser on this PC open <b>${esc(url)}</b> and type the code your gaming PC shows.</div></body></html>`;
}

/** Mode B receiver (OBS loads it via /streampc/obs): finished frames from the gaming PC over WebRTC on the home network.
 *  The sender packs each frame as colour (top half) + transparency as grey (bottom half); a WebGL pass puts the
 *  see-through background back. Signalling over the helper's bus (`spv` messages); no STUN / TURN, no internet. */
export function receiverPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>VTube Pro (stream PC)</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{position:fixed;inset:0;width:100%;height:100%}
video{position:fixed;width:2px;height:2px;opacity:0;pointer-events:none}
#note{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(16,18,26,.88);color:#fff;font:26px/1.4 system-ui,"Segoe UI",sans-serif;padding:24px 30px;border-radius:16px;max-width:80vw;text-align:center;display:none}</style>
</head><body><video id="v" muted playsinline autoplay></video><canvas id="c"></canvas><div id="note"></div><script>
'use strict';
const id=Math.random().toString(36).slice(2,10), v=document.getElementById('v'), cv=document.getElementById('c'), note=document.getElementById('note');
const q=new URLSearchParams(location.search), stampTest=q.get('spStamp')==='1';
let ws=null, pc=null, sender=null, wantT=0, lastFrameAt=0, frames=0, lat=[], st={}, enc=null;
const say=(t)=>{note.textContent=t;note.style.display=t?'block':'none';};
// ---- WebGL unpack: rgb from the top half, alpha from the bottom half's red (the codec's few levels of noise around
//      0 and 1 are squeezed out: no grey haze over the stream, solid stays solid)
const gl=cv.getContext('webgl',{premultipliedAlpha:false,alpha:true,antialias:false,preserveDrawingBuffer:stampTest});
const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);return o;};
const pr=gl.createProgram();
gl.attachShader(pr,sh(gl.VERTEX_SHADER,'attribute vec2 p;varying vec2 u;void main(){u=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}'));
gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D t;varying vec2 u;void main(){vec3 c=texture2D(t,vec2(u.x,u.y*.5)).rgb;float a=clamp((texture2D(t,vec2(u.x,.5+u.y*.5)).r-.03)/.94,0.,1.);gl_FragColor=vec4(c,a);}'));
gl.linkProgram(pr);gl.useProgram(pr);
const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
const loc=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
for(const [k,x] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,k,x);
// test switch (spStamp=1): the sender paints Date.now() into the bottom-left of the alpha band; read it back = latency
function readStamp(){
  const W=v.videoWidth,H=v.videoHeight;if(!W||!H)return null;
  const tmp=document.createElement('canvas');tmp.width=24*16;tmp.height=16;const c2=tmp.getContext('2d',{willReadFrequently:true});
  c2.drawImage(v,0,H-16,24*16,16,0,0,24*16,16);const d=c2.getImageData(0,0,24*16,16).data;let n=0;
  for(let i=0;i<24;i++){const px=((8*24*16)+i*16+8)*4;n|=(d[px]>127?1:0)<<i;}
  const now=Date.now()%(1<<24);let dt=now-n;if(dt<0)dt+=1<<24;return dt<5000?dt:null;}
function draw(){
  frames++;lastFrameAt=performance.now();
  const W=v.videoWidth,H=v.videoHeight;
  if(W&&H){const w=W,h=Math.round(H/2);if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
    gl.viewport(0,0,w,h);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    if(stampTest){const s=readStamp();if(s!==null){lat.push(s);if(lat.length>600)lat.shift();}}}
  if(v.requestVideoFrameCallback)v.requestVideoFrameCallback(draw);
}
v.addEventListener('loadeddata',()=>{say('');if(v.requestVideoFrameCallback)v.requestVideoFrameCallback(draw);else(function f(){draw();requestAnimationFrame(f);})();});
// ---- signalling over the helper's bus
const send=(m)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(Object.assign({type:'spv',from:id},m)));};
function want(){clearTimeout(wantT);if(!pc||pc.connectionState!=='connected')send({k:'want',obs:!!window.obsstudio});wantT=setTimeout(want,3000);}
function drop(){try{pc&&pc.close();}catch(_){}pc=null;sender=null;}
async function onOffer(m){
  drop();sender=m.from;
  pc=new RTCPeerConnection({iceServers:[]});
  pc.ontrack=(e)=>{const s=e.streams[0]||new MediaStream([e.track]);if(v.srcObject!==s){v.srcObject=s;v.play().catch(()=>{});}
    try{e.receiver.jitterBufferTarget=0;}catch(_){}try{e.receiver.playoutDelayHint=0;}catch(_){}};
  pc.onicecandidate=(e)=>send({k:'ice',to:sender,cand:e.candidate?e.candidate.toJSON():null});
  pc.onconnectionstatechange=()=>{if(pc&&(pc.connectionState==='failed'||pc.connectionState==='closed')){drop();want();}};
  await pc.setRemoteDescription({type:'offer',sdp:m.sdp});
  const a=await pc.createAnswer();await pc.setLocalDescription(a);
  send({k:'answer',to:sender,sdp:pc.localDescription.sdp});
}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  ws.onopen=()=>{want();};
  ws.onmessage=(e)=>{let m;try{m=JSON.parse(e.data);}catch(_){return;}if(!m||m.type!=='spv')return;
    if(m.k==='here'&&(!pc||pc.connectionState!=='connected'))want();
    else if(m.k==='offer'&&m.to===id)onOffer(m).catch((x)=>console.warn('offer',x));
    else if(m.k==='ice'&&m.to===id&&pc&&m.from===sender){pc.addIceCandidate(m.cand||null).catch(()=>{});}
    else if(m.k==='stats'&&m.to===id&&m.from===sender&&m.enc){enc=m.enc;}
    else if(m.k==='bye'&&m.from===sender){drop();want();}};
  ws.onclose=()=>{setTimeout(connect,1500);};
}
connect();
// ---- stats back to the gaming PC's card, and the "nothing arrives" sentence
setInterval(async()=>{
  const out={fps:0,lat:null,dec:'',codec:'',w:v.videoWidth,h:Math.round(v.videoHeight/2),obs:!!window.obsstudio,state:pc?pc.connectionState:'none'};
  if(pc){try{const r=await pc.getStats();r.forEach((x)=>{if(x.type==='inbound-rtp'&&x.kind==='video'){out.fps=Math.round(x.framesPerSecond||0);out.dec=x.decoderImplementation||'';out.jb=x.jitterBufferEmittedCount?Math.round(1000*x.jitterBufferDelay/x.jitterBufferEmittedCount):null;out.lost=x.packetsLost||0;const cd=r.get(x.codecId);if(cd)out.codec=cd.mimeType||'';}});}catch(_){}}
  if(lat.length){const s=lat.slice().sort((a,b)=>a-b);out.lat={p50:s[s.length>>1],p90:s[Math.floor(s.length*.9)],n:s.length};}
  if(enc)out.enc=enc;st=out;if(sender)send({k:'stats',to:sender,stats:out});
  const stale=performance.now()-lastFrameAt>4000;
  if(stale&&frames===0)say('Waiting for the picture from your gaming PC…');else if(stale)say('The picture from your gaming PC stopped. It comes back by itself.');
},1000);
setInterval(async()=>{try{const r=await fetch('/streampc/state',{cache:'no-store'});if(r.status===401){location.reload();return;}const j=await r.json();if(j.mode&&j.mode!=='B')location.replace('/streampc/obs'+location.search);}catch(_){}},5000);
window.__spv={stats:()=>st,lat:()=>lat.slice(),frames:()=>frames,id};
</script></body></html>`;
}

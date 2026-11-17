// The helper's "ComfyUI workflows" page (http://127.0.0.1:5191/comfyui). Plain HTML + JS, the Local AI page's brand
// styles. Pick what you want to make -> "Set it up for me" -> a list of EVERY download with its size and licence ->
// one big "Yes" -> progress -> "You're all set!". An AI's request (?request=<id>) opens straight on that list.
// Nothing downloads without the Yes on this page. Makes no sound.
// A setup that stops never sends you back to the list in silence: the progress screen turns into "Stopped", keeps the
// reason on screen and offers "Try again" (the same list you already said Yes to starts again) or "See the list".
// A recipe whose model has a licence limit (Character 3D) shows that notice on its card and above the Yes button.
// NOTE: String.raw template: the script below must not use backticks or dollar-brace.
import { LOCAL_AI_PAGE } from './localAiPage.ts';

const STYLE = (LOCAL_AI_PAGE.match(/<style>[\s\S]*?<\/style>/) ?? ['<style></style>'])[0].replace('</style>', String.raw`
button,.btn{font-size:15px;font-weight:600}.big{font-size:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:14px}
.card{background:var(--ink-2);border:1px solid var(--line);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:8px;min-width:0}
.card h3{margin:0;font-size:17px}.card p{margin:0;color:var(--mute);font-size:14px}.card .row{margin:6px 0 0}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:12px;overflow:hidden;flex-wrap:wrap}.seg button{border:0;border-radius:0;background:none;color:var(--mute);min-height:40px}
.seg button[aria-pressed=true]{background:rgb(123 216 143/.16);color:var(--lime)}
.bar{height:10px;border-radius:999px;background:var(--ink-3);overflow:hidden;margin:10px 0}.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--lime),var(--sky));transition:width .4s cubic-bezier(.16,1,.3,1)}
.stopped .bar i{background:var(--amber)}
ul.plan{list-style:none;padding:0;margin:10px 0;display:grid;gap:6px}ul.plan li{border-top:1px solid var(--line);padding:8px 0 0}
.ask{border-left:3px solid var(--sky);padding:8px 12px;background:rgb(108 199 245/.06);border-radius:0 10px 10px 0;margin:8px 0}
.lic{border-left:3px solid var(--amber);padding:8px 12px;background:rgb(255 207 106/.07);border-radius:0 10px 10px 0;margin:8px 0;color:var(--fg);font-size:14px}
code.sha{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);word-break:break-all}
</style>`);
const LOGO = (LOCAL_AI_PAGE.match(/<header>[\s\S]*?<\/svg>/) ?? ['<header>'])[0];

export const COMFY_WORKFLOWS_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ComfyUI workflows - VTube Pro</title>
` + STYLE + String.raw`</head><body><main>
` + LOGO + String.raw`
<span class="word">VTube Pro</span><span class="beta">Beta</span><span class="crumb">ComfyUI workflows</span></header>

<div id="err" class="err hide" role="alert"></div>

<!-- PICK -->
<section id="pick">
<div class="glass">
<p class="eyebrow">Recipes</p>
<h1>Make your character and stream art with ComfyUI</h1>
<p class="lead">Pick what you want to make. We set it up in ComfyUI for you: the AI models, the add-ons and the recipe. You see every download before anything starts.</p>
<div class="status" id="cfStatus"><span class="dot"></span><span>Looking for ComfyUI...</span></div>
<div class="row" id="cfHelp"></div>
<h3>Your graphics card memory</h3>
<div class="seg" role="group" aria-label="Graphics card memory" id="tiers"></div>
<p class="dim" id="tierNote"></p>
</div>
<div class="cards" id="cards"></div>
</section>

<!-- CONSENT -->
<section id="consent" class="glass hide">
<p class="eyebrow" id="cEyebrow">Step 1 of 2</p>
<h2 id="cTitle">Here's what we'll do</h2>
<p class="lead" id="cLead"></p>
<ul class="plan" id="cList"></ul>
<p id="cTotal" class="pick"></p>
<p class="dim" id="cSpace"></p>
<div id="cNotices"></div>
<div class="private">Everything comes from the official pages. We check every file after it downloads. Your files stay on this computer.</div>
<details><summary>Details: exact addresses and checksums</summary><div id="cDetails"></div></details>
<div class="row"><button id="yes" class="primary big">Yes, set it up</button></div>
<div class="row"><button id="no" class="ghost">Not now</button></div>
</section>

<!-- PROGRESS (and STOPPED: same screen, the reason stays on it) -->
<section id="progress" class="glass hide" aria-live="polite">
<p class="eyebrow">Step 2 of 2</p>
<h2 id="pTitle">Setting it up</h2>
<p class="lead" id="pWhat">Starting...</p>
<div class="bar"><i id="pBar"></i></div>
<p class="dim" id="pNums"></p>
<p class="mute" id="pMute">You can keep using your computer. Big files take a while. If you stop, it continues where it left off next time.</p>
<div class="row" id="pRun"><button id="stop" class="secondary">Stop</button></div>
<div id="pStopped" class="hide">
<div class="err" id="pWhy" role="alert"></div>
<p class="mute">What already downloaded is kept. Nothing starts again until you press the button.</p>
<div class="row"><button id="retry2" class="primary big">Try again</button><button id="toList" class="secondary">See the list</button></div>
</div>
</section>

<!-- DONE -->
<section id="done" class="hide">
<div class="done" role="status"><b>You're all set!</b> <span id="dWhat"></span></div>
<div class="glass">
<h2>Make your first one</h2>
<ol class="steps" id="dSteps"></ol>
<div class="row"><a id="openComfy" class="btn primary" target="_blank" rel="noopener">Open ComfyUI</a><button id="again" class="secondary">Make something else</button></div>
</div>
</section>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  if (qs.get('docked') === '1') document.documentElement.classList.add('vtp-docked');
  var data = null, tier = 'medium', autoTier = false, current = null, consentTok = null, jobId = null, requestId = qs.get('request');
  // shown: what the list on screen covers (files, add-ons, notices). A Try again with the same list needs no second look.
  var shown = null, lastStop = null;
  var LABEL = { small: '8 GB', medium: '16 GB', large: '24 GB' };
  function gb(n){ return n < 1e9 ? (n / 1e6).toFixed(0) + ' MB' : (n / 1e9).toFixed(1) + ' GB'; }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function nameOf(id){ var w = data && data.workflows ? data.workflows.filter(function(x){ return x.id === id; })[0] : null; return w ? '“' + w.short + '”' : id; }
  function show(id){
    ['pick','consent','progress','done'].forEach(function(x){ $(x).classList.toggle('hide', x !== id); });
    // the progress screen says WHICH recipe (at 24 GB two recipes download the same files and look alike)
    if (id === 'progress' && current) $('pTitle').textContent = 'Setting up ' + nameOf(current.id) + (LABEL[current.tier] ? ' (' + LABEL[current.tier] + ')' : '');
    window.scrollTo(0, 0);
  }
  // quiet: the message already names the button to press (Yes, right below it), so no "Try again" next to it
  function err(msg, quiet){ var e = $('err'); if (!msg) { e.classList.add('hide'); return; } e.innerHTML = esc(msg) + (quiet ? '' : ' <button class="secondary" id="retry">Try again</button>'); e.classList.remove('hide'); if (!quiet) $('retry').onclick = function(){ err(''); load(); }; }
  function api(method, url, body){
    return fetch(url, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Try again, or press Help.'); e.body = j; e.status = r.status; throw e; } return j; }); });
  }
  function sig(p){ return JSON.stringify([p.files.map(function(f){ return [f.dest, f.url, f.sha256]; }), p.nodes.map(function(x){ return [x.dest, x.commit]; }), p.notices || []]); }
  function renderTiers(){
    var box = $('tiers'); box.innerHTML = '';
    ['small','medium','large'].forEach(function(t){
      var b = document.createElement('button'); b.textContent = LABEL[t]; b.setAttribute('aria-pressed', String(t === tier));
      b.onclick = function(){ tier = t; autoTier = false; try { localStorage.setItem('vtp.comfy.tier', t); } catch (e) {} renderTiers(); renderCards(); };
      box.appendChild(b);
    });
    $('tierNote').textContent = (data && data.tiers ? data.tiers[tier].note : '') + (autoTier && data.comfy && data.comfy.vramGB ? ' We picked this size because ComfyUI reports about ' + data.comfy.vramGB + ' GB of graphics memory.' : '');
  }
  function renderStatus(){
    var on = data && data.comfy && data.comfy.running;
    // why: the ComfyUI you use is on another computer, or too busy to answer (the helper says so in plain words)
    var why = !on && data && data.comfy && data.comfy.why;
    $('cfStatus').innerHTML = '<span class="dot' + (on ? ' on' : '') + '"></span><span>' + (on ? 'ComfyUI is open. Ready.' : why ? esc(why) : 'ComfyUI isn’t open. Open it first, then press Check again.') + '</span>';
    $('cfHelp').innerHTML = on ? '' : '<button class="secondary" id="check">Check again</button>' + (why ? '' : ' <a class="btn ghost" href="/local-ai">I don’t have ComfyUI yet</a>');
    if (!on) $('check').onclick = load;
  }
  function renderCards(){
    var box = $('cards'); box.innerHTML = '';
    var on = !!(data.comfy && data.comfy.running);
    var folder = data.comfy && data.comfy.workflowsFolder;
    data.workflows.forEach(function(w){
      var t = w.tiers.filter(function(x){ return x.tier === tier; })[0];
      var c = document.createElement('div'); c.className = 'card';
      c.innerHTML = '<h3>' + esc(w.short) + '</h3><p>' + esc(w.forWhat) + '</p>' +
        (t ? '<p class="dim">Download: ' + gb(t.downloadBytes) + (t.customNodes.length ? ' · 1 add-on' : '') + '</p>' : '<p class="dim">Not made for this size.</p>') +
        (t && t.notices ? t.notices.map(function(n){ return '<div class="lic" role="note">' + esc(n) + '</div>'; }).join('') : '') +
        '<div class="ask">Or ask your AI: “' + esc(w.ask) + '”</div>' +
        '<div class="row">' + (t ? '<button class="primary" data-go="1">Set it up for me</button><a class="btn secondary" data-dl="1" href="/comfy-workflows/' + esc(t.files.ui) + '?download=1">Download the file</a>' + (on ? '<button class="secondary" data-add="1">Add it to ComfyUI for me</button>' : '') : '') + '</div>' +
        '<div class="hide" data-added="1" role="status"></div>' +
        // Doing it by hand: where the file goes (a tester asked, 2026-10-03). Shown once they press Download.
        '<div class="ask hide" data-how="1"><b>Now put it in ComfyUI:</b><ol class="steps">' +
        '<li>Open ComfyUI.</li>' +
        '<li>Find the file you just downloaded (in your Downloads folder, its name starts with “VTube Pro”).</li>' +
        '<li>Drag it onto the ComfyUI window. Or in ComfyUI, open the <b>Workflow</b> menu, choose <b>Open</b> and pick the file.</li>' +
        '<li>To keep it in ComfyUI’s own Workflows list (the <b>W</b> panel), put the file in its workflows folder: ' + (folder ? '<code class="cp">' + esc(folder) + '</code>' : '<code class="cp">ComfyUI/user/default/workflows</code>') + (on ? ' Or press <b>Add it to ComfyUI for me</b> above and we do it.' : ' Or open ComfyUI, then press <b>Check again</b> and <b>Add it to ComfyUI for me</b>.') + '</li>' +
        '<li>ComfyUI may say models are missing. Let it download them, or press <b>Set it up for me</b> above and we get them for you.</li>' +
        '<li>Change the green boxes, then press <b>Run</b>.</li></ol></div>';
      var go = c.querySelector('[data-go]'); if (go) go.onclick = function(){ plan(w.id, tier, null); };
      var dl = c.querySelector('[data-dl]'); if (dl) dl.onclick = function(){ c.querySelector('[data-how]').classList.remove('hide'); };
      var add = c.querySelector('[data-add]');
      // Never replaces a workflow of the same name unasked (people save their own changes over it in ComfyUI): then it says so and
      // offers "Replace it with the original", which is the only thing that sends replace:true.
      function addNow(replace){
        var out = c.querySelector('[data-added]'); add.disabled = true; out.className = 'hide';
        api('POST', '/api/comfy-workflows/add', { workflow: w.id, tier: tier, replace: replace ? true : undefined }).then(function(j){
          out.className = 'ask'; out.innerHTML = (j.replaced ? 'Replaced with the original. ' : 'Added. ') + 'In ComfyUI press <b>W</b> and open “' + esc(j.name) + '”.' + (j.folder ? ' (It is in ' + esc(j.folder) + '.)' : '');
        }).catch(function(e){
          if (e.body && e.body.code === 'exists') {
            out.className = 'ask'; out.textContent = e.message + ' ';
            var rb = document.createElement('button'); rb.className = 'secondary'; rb.setAttribute('data-replace', '1'); rb.textContent = 'Replace it with the original';
            rb.onclick = function(){ addNow(true); };
            out.appendChild(rb);
          } else { out.className = 'err'; out.textContent = e.message; }
        }).then(function(){ add.disabled = false; });
      }
      if (add) add.onclick = function(){ addNow(false); };
      box.appendChild(c);
    });
  }
  // note: why we are back on this list (a stopped setup, an expired OK). It stays on screen: clearing it here made the
  // page jump back to step 1 with no word of what went wrong.
  function plan(id, t, req, note){
    err(note || '', true); current = { id: id, tier: t };
    $('yes').disabled = true;
    return api('POST', '/api/comfy-workflows/plan', { workflow: id, tier: t, request: req || undefined }).then(function(j){
      renderPlan(j, req, note);
    }).catch(function(e){ show('pick'); err(e.message); });
  }
  function renderPlan(j, req, note){
    var p = j.plan; consentTok = j.consent ? j.consent.token : null; shown = sig(p);
    $('cEyebrow').textContent = req ? 'Your AI asked to set this up · Step 1 of 2' : 'Step 1 of 2';
    $('cTitle').textContent = p.title + ' (' + p.tierLabel + ')';
    $('cLead').textContent = 'Here’s everything we’ll do in your ComfyUI. Nothing starts until you press Yes.';
    $('cList').innerHTML = p.summary.map(function(s){ return '<li>' + esc(s) + '</li>'; }).join('');
    var n = p.files.filter(function(f){ return f.state !== 'present'; }).length;
    $('cTotal').textContent = n ? 'Download ' + n + (n === 1 ? ' file' : ' files') + ', ' + gb(p.downloadBytes) : 'Nothing to download';
    $('cSpace').textContent = p.freeBytes === null ? '' : 'Free space on that drive: ' + gb(p.freeBytes) + '.';
    // a licence limit comes before the button, in plain words (Hunyuan3D: not for the EU, UK or South Korea)
    $('cNotices').innerHTML = (p.notices || []).map(function(t){ return '<div class="lic" role="note"><b>Check this first.</b> ' + esc(t) + '</div>'; }).join('');
    $('cDetails').innerHTML = p.files.map(function(f){ return '<p><b>' + esc(f.file) + '</b> → ' + esc(f.dest) + '<br><a href="' + esc(f.page) + '" target="_blank" rel="noopener">' + esc(f.url) + '</a><br>Licence: ' + esc(f.licence) + '<br><code class="sha">SHA-256 ' + esc(f.sha256) + '</code></p>'; }).join('') +
      p.nodes.map(function(x){ return '<p><b>' + esc(x.name) + '</b> → ' + esc(x.dest) + '<br>' + esc(x.repo) + ' @ <code class="sha">' + esc(x.commit) + '</code></p>'; }).join('');
    $('yes').textContent = n ? 'Yes, download ' + gb(p.downloadBytes) + ' and set it up' : 'Yes, set it up';
    // the old reason and the new blocker both stay on screen (the blocker used to replace the reason)
    var msg = [note, p.blockers[0]].filter(Boolean).join(' ');
    if (p.blockers.length) { err(msg); $('yes').disabled = true; }
    else { err(msg, true); $('yes').disabled = !consentTok; }
    show('consent');
  }
  function resetProgress(){
    $('progress').classList.remove('stopped'); $('pRun').classList.remove('hide'); $('pMute').classList.remove('hide'); $('pStopped').classList.add('hide');
    $('pBar').style.width = '0%'; $('pNums').textContent = ''; $('pWhat').textContent = 'Starting...';
  }
  // The setup stopped (a dropped download, no internet, ComfyUI closed, a bad checksum ...). This screen stays: the reason,
  // the bar frozen where it got to, and one clear button. It never jumps back to Step 1 by itself.
  // base: the reason it first stopped for. A Try again / Check again that fails again shows base + only the newest failure
  // (stoppedAgain), so pressing it again and again never piles the same sentences up.
  function stopped(reason, code, base){
    lastStop = { reason: reason, base: base === undefined ? reason : base, code: code || 'other' };
    show('progress');
    $('progress').classList.add('stopped');
    $('pTitle').textContent = 'Stopped: ' + nameOf(current.id) + (LABEL[current.tier] ? ' (' + LABEL[current.tier] + ')' : '');
    $('pWhat').textContent = '';
    $('pWhy').textContent = reason;
    $('pRun').classList.add('hide'); $('pMute').classList.add('hide'); $('pStopped').classList.remove('hide');
    $('retry2').textContent = lastStop.code === 'comfy-closed' ? 'Check again' : 'Try again';
    $('retry2').disabled = false;
  }
  function stoppedAgain(prev, e){
    // (no status = the connection to the helper dropped: say so in plain words, not the browser's own text)
    var now = e && e.status ? String(e.message || '') : 'VTube Pro did not answer just now.';
    stopped(!now || prev.base.indexOf(now) !== -1 ? prev.base : prev.base + ' ' + now, (e && e.body && e.body.code) || prev.code, prev.base);
  }
  function startInstall(onFail){
    return api('POST', '/api/comfy-workflows/install', { workflow: current.id, tier: current.tier, token: consentTok, iUnderstand: true, request: requestId || undefined }).then(function(j){
      consentTok = null; jobId = j.job.id; lastStop = null; resetProgress(); show('progress'); poll();
    }).catch(onFail);
  }
  $('yes').onclick = function(){
    if (!current || !consentTok) return;
    $('yes').disabled = true;
    startInstall(function(e){ $('yes').disabled = false; if (e.body && e.body.consent) plan(current.id, current.tier, requestId, e.message); else err(e.message); });
  };
  // Try again: ask for the list once more. The same list you already said Yes to starts at once (this click is the OK);
  // a different list (a new file, a new notice, a new problem) is shown first, with the reason it stopped.
  $('retry2').onclick = function(){
    if (!current || !lastStop) return;
    var prev = lastStop, was = shown;
    $('retry2').disabled = true;
    api('POST', '/api/comfy-workflows/plan', { workflow: current.id, tier: current.tier, request: requestId || undefined }).then(function(j){
      var p = j.plan;
      if (was && j.consent && !p.blockers.length && sig(p) === was) {
        consentTok = j.consent.token;
        startInstall(function(e){ stoppedAgain(prev, e); });
        return;
      }
      renderPlan(j, requestId, (was && j.consent ? 'The list changed: look at it again, then press Yes. ' : '') + 'It stopped because: ' + prev.reason);
    }).catch(function(e){ stoppedAgain(prev, e); });
  };
  $('toList').onclick = function(){ if (current) plan(current.id, current.tier, requestId, lastStop ? 'It stopped because: ' + lastStop.reason : ''); };
  $('no').onclick = function(){ consentTok = null; show('pick'); };
  $('stop').onclick = function(){ if (jobId) api('POST', '/api/comfy-workflows/jobs/' + jobId + '/cancel'); };
  $('again').onclick = function(){ show('pick'); load(); };
  var PH = { starting: 'Getting ready...', checking: 'Checking a file you already have:', downloading: 'Downloading', 'add-on': 'Adding the add-on', workflow: 'Adding the workflow to ComfyUI', done: 'Finishing...' };
  function poll(){
    api('GET', '/api/comfy-workflows/jobs/' + jobId).then(function(j){
      $('pWhat').textContent = (PH[j.phase] || j.phase) + (j.file ? ' ' + j.file : '');
      var pct = j.total ? Math.min(100, Math.round(j.done / j.total * 100)) : 0;
      $('pBar').style.width = pct + '%';
      $('pNums').textContent = j.total ? gb(j.done) + ' of ' + gb(j.total) + ' (' + pct + '%)' : '';
      if (j.state === 'running') { setTimeout(poll, 1000); return; }
      if (j.state === 'done') {
        // workflowKept: they already had a workflow of that name (maybe with their own changes): it was left exactly as it is
        $('dWhat').textContent = '“' + j.workflowName.replace(/\.json$/, '') + '” is in your ComfyUI.' + (j.workflowKept ? ' It was already there, so we left your copy as it is. To get the original back, press “Add it to ComfyUI for me” on its card and choose “Replace it with the original”.' : '');
        var steps = [];
        if (j.restartNeeded) steps.push('Close ComfyUI and open it again (it needs to load the new add-on).');
        if (current && current.id === 'character-3d') steps.push('Back in the VTube Pro studio: open the Create tab, add a picture of your character and press Create my character.', 'Or in ComfyUI: press W, open “' + esc(j.workflowName.replace(/\.json$/, '')) + '”, pick your picture in the green box and press Run.');
        else {
          steps.push('In ComfyUI, press W (or click Workflows on the left).');
          steps.push('Open “' + esc(j.workflowName.replace(/\.json$/, '')) + '”.');
          steps.push('Change the green boxes, then press Run.');
        }
        $('dSteps').innerHTML = steps.map(function(s){ return '<li>' + s + '</li>'; }).join('');
        $('openComfy').href = j.comfyUrl || '#';
        show('done'); return;
      }
      stopped(j.error || 'It stopped. Press Try again to continue where it left off.', j.code);
    }).catch(function(e){
      // the helper restarted: the setup is gone (what downloaded is kept)
      if (e.status === 404) { stopped('The setup stopped because VTube Pro restarted. Press Try again to continue where it left off.', 'other'); return; }
      setTimeout(poll, 2000);
    });
  }
  function load(){
    var saved = null;
    try { saved = localStorage.getItem('vtp.comfy.tier'); } catch (e) {}
    api('GET', '/api/comfy-workflows').then(function(j){
      data = j;
      // which size to start on: the link, then what you picked before, then what your graphics card fits
      autoTier = false;
      if (qs.get('tier') && LABEL[qs.get('tier')]) tier = qs.get('tier');
      else if (saved && LABEL[saved]) tier = saved;
      else if (j.comfy && j.comfy.suggestedTier && LABEL[j.comfy.suggestedTier]) { tier = j.comfy.suggestedTier; autoTier = true; }
      renderStatus(); renderTiers(); renderCards();
      var other = j.job && j.job.state === 'running' ? { id: j.job.key.split('/')[0], tier: j.job.key.split('/')[1] } : null;
      // An AI's request comes first: a different setup that is still running must not take over its page (2026-10-03:
      // a texture-repaint request showed the outfit-variant setup, and the request was tied to that job).
      if (requestId) {
        api('GET', '/api/comfy-workflows/requests/' + encodeURIComponent(requestId)).then(function(q){
          if (q.job && q.job.state === 'running') { jobId = q.job.id; current = { id: q.workflow, tier: q.tier }; show('progress'); poll(); return; }
          tier = q.tier; autoTier = false; renderTiers(); renderCards();
          var busy = other && (other.id !== q.workflow || other.tier !== q.tier) ? 'Another setup is still running (' + nameOf(other.id) + '). When it finishes, press Yes here.' : '';
          if (j.comfy.running) plan(q.workflow, q.tier, requestId, busy); else err(j.comfy.why || 'Open ComfyUI first, then press Check again.');
        }).catch(function(e){ err(e.message); });
        return;
      }
      if (other) { jobId = j.job.id; current = other; show('progress'); poll(); return; }
      if (qs.get('workflow') && j.comfy.running) plan(qs.get('workflow'), tier, null);
    }).catch(function(e){ err(e.message); });
  }
  load();
})();
</script>
</main></body></html>`;

// Chat Hub window styles (big, high-contrast, readable from across the desk).
export const CSS = `
:root { --bg:#0e1117; --panel:#161b24; --panel2:#1d2430; --line:#2a3342; --text:#eef2f8; --dim:#9aa6b8; --accent:#35d46a; --warn:#e9c440; --err:#ff5c5c; --fs:20px; }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font:15px/1.35 system-ui, "Segoe UI", sans-serif; }
button { font:inherit; color:inherit; background:var(--panel2); border:1px solid var(--line); border-radius:8px; padding:5px 10px; cursor:pointer; }
button:hover { border-color:#4a5870; } button.pri { background:#1f6f3d; border-color:#2f9a57; } button.warn { background:#5a2323; border-color:#8a3434; }
button.on { background:#24406b; border-color:#3f6fb5; } button:disabled { opacity:.45; cursor:default; }
input, select { font:inherit; color:var(--text); background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:5px 8px; }
input[type=checkbox] { width:18px; height:18px; vertical-align:middle; }
.app { display:grid; grid-template-rows:auto 1fr auto; height:100vh; }
header { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:8px 12px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { font-size:17px; margin:0 6px 0 0; letter-spacing:.3px; }
.lights { display:flex; gap:8px; flex-wrap:wrap; cursor:pointer; }
.light { display:flex; align-items:center; gap:5px; padding:3px 8px; border-radius:20px; background:var(--panel2); font-size:13px; }
.dot { width:10px; height:10px; border-radius:50%; background:#3a4254; flex:none; }
.dot.live { background:#35d46a; box-shadow:0 0 7px #35d46a; } .dot.connecting, .dot.waiting { background:#e9c440; } .dot.error { background:#ff5c5c; }
.grow { flex:1; }
.totals { font-size:14px; color:var(--dim); } .totals b { color:var(--text); font-size:16px; }
main { display:grid; grid-template-columns: minmax(0, 1.6fr) minmax(340px, 1fr); min-height:0; }
main.nochat { grid-template-columns: 1fr; } main.noev { grid-template-columns: 1fr; }
.col { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--line); }
.bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:6px 10px; background:var(--panel); border-bottom:1px solid var(--line); font-size:13px; }
.chip { padding:3px 9px; border-radius:14px; font-size:13px; }
.chip.off { opacity:.4; }
.feed { flex:1; overflow-y:auto; padding:6px 10px 20px; font-size:var(--fs); }
.msg { padding:4px 6px; border-radius:6px; display:flex; gap:8px; align-items:flex-start; position:relative; word-wrap:break-word; overflow-wrap:anywhere; }
.msg:hover { background:#ffffff08; } .msg .acts { display:none; position:absolute; right:4px; top:2px; gap:4px; }
.msg:hover .acts { display:flex; } .msg .acts button { padding:1px 7px; font-size:13px; }
.msg.sys { color:var(--dim); font-style:italic; } .msg.mention { background:#3a2f0a; } .msg.vip, .msg.hl { background:#16324a; }
.msg .t { color:#5d6a7e; font-size:.62em; min-width:3.2em; padding-top:.35em; } .msg .body { flex:1; min-width:0; }
.msg .name { font-weight:700; margin-right:.35em; }
.msg img.em { height:1.5em; vertical-align:middle; margin:0 1px; }
.badge { display:inline-block; font-size:.55em; font-weight:800; padding:1px 5px; border-radius:4px; margin-right:4px; vertical-align:.2em; background:#384256; color:#fff; letter-spacing:.3px; }
.badge.moderator { background:#1f8b3a; } .badge.broadcaster { background:#c0392b; } .badge.vip { background:#b0339c; } .badge.subscriber, .badge.member, .badge.founder { background:#6441a5; } .badge.verified { background:#2d6cdf; }
.pic { width:1.1em; height:1.1em; flex:none; margin-top:.15em; }
.fin { border-left:5px solid var(--tier, #ffd84a); background:#1b2230; margin:4px 0; }
.fin .amt { font-weight:800; color:var(--tier, #ffd84a); margin-right:.4em; }
.pins { background:#211a08; border-bottom:1px solid #5a4410; padding:4px 10px; font-size:calc(var(--fs) * .85); }
.pins .msg { background:transparent; }
.newbtn { position:sticky; bottom:6px; margin:0 auto; display:block; background:#24406b; border-color:#3f6fb5; }
.events { flex:1; overflow-y:auto; padding:8px; }
.ev { display:grid; grid-template-columns: 6px 1fr auto; gap:0 10px; background:var(--panel); border:1px solid var(--line); border-radius:10px; margin-bottom:8px; overflow:hidden; }
.ev .strip { background:var(--tier, #ffd84a); } .ev .c { padding:8px 0; min-width:0; } .ev .b { display:flex; flex-direction:column; gap:4px; padding:8px 8px 8px 0; }
.ev .b button { padding:4px 9px; font-size:14px; }
.ev .who { font-size:18px; font-weight:800; } .ev .what { font-size:15px; color:var(--dim); } .ev .what b { color:var(--tier, #ffd84a); font-size:17px; }
.ev .txt { font-size:17px; margin-top:3px; overflow-wrap:anywhere; } .ev .meta { font-size:12px; color:#6f7b8e; margin-top:3px; }
.ev.acked { opacity:.45; } .ev.acked:hover { opacity:.8; }
.ev.playing { outline:2px solid #3f6fb5; }
.sect { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); margin:10px 2px 6px; }
.tts { padding:8px 10px; background:var(--panel2); border-bottom:1px solid var(--line); font-size:14px; }
.tts .now { margin-top:4px; color:#bcd3ff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.grid2 { display:grid; grid-template-columns: 170px minmax(0, 1fr); gap:6px 10px; align-items:center; margin-top:8px; }
/* a phone-narrow window: chat above events, settings labels above their controls */
@media (max-width: 600px) {
  html:not(.vtp-docked) main:not(.noev) { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 2fr) minmax(0, 3fr); }
  html:not(.vtp-docked) .col { border-right:0; border-bottom:1px solid var(--line); }
  .grid2 { grid-template-columns: minmax(0, 1fr); gap:3px; }
  .grid2 > span:empty { display:none; }
  .tts { overflow-y:auto; max-height:70vh; }
}
footer { padding:4px 12px; font-size:12px; color:#6f7b8e; background:var(--panel); border-top:1px solid var(--line); }
kbd { background:#2a3342; border-radius:4px; padding:0 5px; font-size:11px; }
.modal { position:fixed; inset:0; background:#000a; display:grid; place-items:center; z-index:10; }
.modal > .box { background:var(--panel); border:1px solid var(--line); border-radius:14px; width:min(980px, 96vw); max-height:92vh; overflow:auto; padding:16px 20px; }
.box h2 { margin:0 0 4px; } .box .x { float:right; }
.cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap:12px; margin-top:12px; }
.card { background:var(--panel2); border:1px solid var(--line); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:7px; }
.card h3 { margin:0; display:flex; align-items:center; gap:8px; font-size:18px; } .card h3 .pic { width:22px; height:22px; }
.card .st { font-size:13px; display:flex; gap:6px; align-items:center; color:var(--dim); }
.card ol { margin:0; padding-left:18px; font-size:13px; color:var(--dim); } .card label { font-size:13px; color:var(--dim); display:flex; flex-direction:column; gap:3px; }
.card .row { display:flex; gap:6px; flex-wrap:wrap; }
.note { font-size:12.5px; color:var(--dim); margin:4px 0; } .note a { color:#8fb8ff; }
.urls input { width:100%; font-size:12px; }
.toast { position:fixed; bottom:34px; left:50%; transform:translateX(-50%); background:#24406b; padding:8px 14px; border-radius:8px; z-index:20; }
`;

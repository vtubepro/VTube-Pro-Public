// TTRPG drawer styles. Built on the studio's theme tokens (src/ui/theme.ts: --bg --card --line --text --accent …) so
// it follows light / dark; adds one warm "candle" accent for the table and a book serif for the storyteller's lines.
export const TTRPG_CSS = `
:root, :root[data-theme=dark] { --tt-ember: #eeae55; --tt-ember-soft: #eeae5522; --tt-felt: #1c2b24; --tt-gm: #d9c7a5; }
:root[data-theme=light] { --tt-ember: #a4600c; --tt-ember-soft: #a4600c1a; --tt-felt: #e3ece6; --tt-gm: #4a3616; }
.tt-drawer { position: fixed; top: 56px; right: 0; bottom: 0; width: min(440px, 100vw); z-index: 60; display: flex; flex-direction: column;
  background: var(--panel); border-left: 1px solid var(--line); box-shadow: var(--shadow); transform: translateX(102%); transition: transform .22s ease; }
.tt-drawer.open { transform: none; }
.tt-head { padding: 12px 14px 0; border-bottom: 1px solid var(--line); flex: none; }
.tt-head .top { display: flex; align-items: center; gap: 8px; }
.tt-head h2 { margin: 0; font-size: 17px; font-weight: 750; flex: 1; letter-spacing: -.01em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tt-head .room { color: var(--dim); font-size: 12px; margin: 2px 0 8px; }
.tt-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--dim); padding: 3px 9px; border-radius: 99px; background: var(--card); border: 1px solid var(--line); }
.tt-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.tt-status.thinking i { background: var(--accent2); animation: tt-pulse 1s infinite; } .tt-status.speaking i { background: var(--tt-ember); animation: tt-pulse .6s infinite; }
.tt-status.waiting i { background: var(--warn); } .tt-status.error i { background: var(--err); } .tt-status.approve i { background: var(--violet); }
@keyframes tt-pulse { 50% { opacity: .35; } }
.tt-x { border: 2px solid var(--err); color: var(--err); background: transparent; font: inherit; font-weight: 900; font-size: 15px; width: 34px; height: 30px; border-radius: 8px; cursor: pointer; }
.tt-x:hover { background: var(--err-soft); }
.tt-tabs { display: flex; gap: 2px; margin-top: 4px; }
.tt-tabs button { flex: 1; border: 0; background: transparent; color: var(--dim); font: inherit; font-weight: 650; font-size: 12.5px; padding: 9px 4px 10px; cursor: pointer; border-bottom: 2px solid transparent; }
.tt-tabs button.on { color: var(--text); border-bottom-color: var(--tt-ember); }
.tt-body { flex: 1; overflow-y: auto; padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 12px; }
.tt-body.table-view { padding-bottom: 0; }
.tt-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.tt-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--text); }
.tt-card .hint { color: var(--dim); font-size: 12px; margin: 4px 0 0; line-height: 1.45; }
.tt-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tt-row > label { color: var(--dim); font-size: 12px; min-width: 92px; }
.tt-row input[type=text], .tt-row input[type=password], .tt-row input[type=url], .tt-row select, .tt-row input[type=number] { flex: 1; min-width: 0; }
.tt-grow { flex: 1; }
.tt-field { display: grid; gap: 4px; margin-bottom: 8px; } .tt-field > span { color: var(--dim); font-size: 12px; }

/* the dice tray: the one loud thing */
.tt-tray { background: var(--tt-felt); border: 1px solid var(--line); border-radius: 14px; padding: 10px; display: grid; gap: 8px; }
.tt-dice { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.tt-die { position: relative; aspect-ratio: 1; border: 0; background: none; cursor: pointer; padding: 0; color: var(--text); font: inherit; }
.tt-die svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.tt-die svg .f { fill: var(--card2); stroke: var(--tt-ember); stroke-width: 2.2; transition: fill .12s; }
.tt-die:hover svg .f { fill: var(--tt-ember-soft); } .tt-die:active { transform: scale(.94); }
.tt-die b { position: relative; font-size: 12px; font-weight: 800; display: grid; place-items: center; height: 100%; }
.tt-die .n { position: absolute; top: -4px; right: -2px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--tt-ember); color: #1a1004; font-size: 10.5px; font-weight: 800; display: none; place-items: center; padding: 0 3px; }
.tt-die.picked .n { display: grid; }
.tt-traybar { display: flex; gap: 6px; align-items: center; }
.tt-traybar input { width: 0; flex: 1; font-variant-numeric: tabular-nums; }
.tt-traybar .seg button { padding: 4px 8px; }
.tt-rollbtn { background: var(--tt-ember); color: #1a1004; border: 0; font: inherit; font-weight: 800; border-radius: 10px; padding: 7px 14px; cursor: pointer; }
.tt-rollbtn:disabled { opacity: .45; cursor: not-allowed; }

/* roll requests from the GM */
.tt-req { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--tt-ember-soft); border: 1px solid var(--tt-ember); }
.tt-req.other { opacity: .78; background: var(--card); border-color: var(--line2); }
.tt-reqs { display: grid; gap: 6px; padding: 0 14px; } .tt-reqs:not(:empty) { padding-top: 10px; border-top: 1px solid var(--line); }
.tt-req .what { flex: 1; min-width: 0; } .tt-req .what b { display: block; font-size: 14px; } .tt-req .what span { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }

/* the log: the GM speaks in a book serif, the table in the UI face */
.tt-log { display: flex; flex-direction: column; gap: 7px; min-height: 120px; }
.tt-e { font-size: 13px; line-height: 1.45; }
.tt-e .who { font-weight: 700; margin-right: 6px; }
.tt-e.gm { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 14.5px; line-height: 1.55; color: var(--tt-gm); padding: 2px 0 2px 10px; border-left: 2px solid var(--tt-ember); }
.tt-e.gm .who { display: none; }
.tt-e.npc { font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-style: italic; color: var(--tt-gm); padding-left: 10px; border-left: 2px solid var(--line2); }
.tt-e.ooc { color: var(--dim); } .tt-e.system { color: var(--faint); font-size: 12px; }
.tt-e.roll { font-size: 12.5px; color: var(--dim); font-variant-numeric: tabular-nums; } .tt-e.roll::before { content: '🎲 '; }
.tt-e.x { color: var(--err); font-weight: 650; }
.tt-e.live { opacity: .75; }
.tt-composer { background: var(--panel); padding: 10px 14px 12px; border-top: 1px solid var(--line); display: grid; gap: 6px; flex: none; }
.tt-composer textarea { resize: none; height: 52px; font: inherit; }
.tt-ptt { border: 1px solid var(--line2); background: var(--card2); color: var(--text); border-radius: 10px; padding: 7px 12px; font: inherit; font-weight: 650; cursor: pointer; user-select: none; }
.tt-ptt.on { background: var(--err); color: #fff; border-color: transparent; }

/* character sheet */
.tt-sheet-top { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
.tt-sheet-top .name { font-size: 18px; font-weight: 800; background: transparent; border: 0; padding: 0; color: var(--text); width: 100%; }
.tt-vitals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 8px 0; }
.tt-vital { background: var(--card2); border-radius: 10px; padding: 7px 8px; text-align: center; }
.tt-vital b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; } .tt-vital span { font-size: 11.5px; color: var(--dim); }
.tt-vital .hpbtns { display: flex; gap: 4px; justify-content: center; margin-top: 4px; }
.tt-vital .hpbtns button { border: 1px solid var(--line2); background: var(--card); color: var(--text); border-radius: 6px; width: 26px; height: 22px; cursor: pointer; font: inherit; font-weight: 700; }
.tt-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.tt-stat { border: 1px solid var(--line); border-radius: 9px; padding: 5px 2px; text-align: center; cursor: pointer; background: var(--card); color: var(--text); font: inherit; }
.tt-stat:hover { border-color: var(--tt-ember); } .tt-stat small { display: block; font-size: 10.5px; color: var(--dim); } .tt-stat b { font-size: 15px; font-variant-numeric: tabular-nums; } .tt-stat i { display: block; font-style: normal; font-size: 11px; color: var(--dim); }
.tt-list { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; }
.tt-list button { display: flex; justify-content: space-between; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 12.5px; padding: 3px 4px; border-radius: 6px; cursor: pointer; text-align: left; }
.tt-list button:hover { background: var(--card2); } .tt-list button span { color: var(--dim); font-variant-numeric: tabular-nums; }
.tt-atk { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; padding: 5px 0; border-top: 1px solid var(--line); font-size: 13px; }
.tt-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.tt-chip { font-size: 12px; padding: 3px 9px; border-radius: 99px; background: var(--card2); border: 1px solid var(--line); color: var(--text); cursor: pointer; font-family: inherit; }
.tt-chip.on { background: var(--tt-ember); color: #1a1004; border-color: transparent; font-weight: 700; }
.tt-chip.bad { border-color: var(--err); color: var(--err); }

/* GM looks */
.tt-looks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tt-look { border: 1px solid var(--line); background: var(--card2); border-radius: 10px; padding: 8px 6px; cursor: pointer; text-align: center; color: var(--text); font: inherit; font-size: 12px; }
.tt-look .ic { font-size: 22px; display: block; margin-bottom: 2px; }
.tt-look.on { border-color: var(--tt-ember); box-shadow: inset 0 0 0 1px var(--tt-ember); }
.tt-pending textarea { width: 100%; min-height: 110px; font-family: "Iowan Old Style", Georgia, serif; font-size: 14px; line-height: 1.5; box-sizing: border-box; }
.tt-act { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; padding: 4px 0; }
.tt-act code { color: var(--dim); font-size: 11.5px; word-break: break-word; }
.tt-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12.5px; } .tt-kv span:nth-child(odd) { color: var(--dim); }
.tt-key { display: flex; gap: 6px; align-items: center; } .tt-key .ok { color: var(--ok); font-size: 12px; font-weight: 650; }
.tt-start { display: grid; gap: 10px; text-align: left; }
.tt-start .big { font-size: 20px; font-weight: 800; letter-spacing: -.01em; margin: 0; color: var(--text) !important; }
.tt-start p { margin: 0; color: var(--dim); line-height: 1.5; }
.tt-camps { display: grid; gap: 6px; }
.tt-camp { display: flex; justify-content: space-between; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--card2); }
.tt-camp b { font-size: 13px; } .tt-camp span { color: var(--dim); font-size: 12px; }
.tt-launch { position: fixed; right: 14px; bottom: 14px; z-index: 55; display: flex; align-items: center; gap: 8px; padding: 9px 14px 9px 10px; border-radius: 99px;
  background: var(--card); color: var(--text); border: 1px solid var(--line2); box-shadow: var(--shadow); font: inherit; font-weight: 750; cursor: pointer; }
.tt-launch svg { width: 22px; height: 22px; } .tt-launch.live { border-color: var(--tt-ember); } .tt-launch.live svg path { fill: var(--tt-ember); }
.tt-launch:hover { border-color: var(--tt-ember); }
/* (it sat on top of the camera self-view in the corner of the studio view: move up while the camera is on) */
body:has(#campip.on:not(.pip-off)):not(.clean):not(.lc-console) .tt-launch { bottom: 236px; }
.tt-mini { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.tt-mini div { background: var(--card2); aspect-ratio: 1; display: grid; place-items: center; font-size: 9px; font-weight: 800; cursor: pointer; color: #fff; }
.tt-srd { color: var(--faint); font-size: 11px; line-height: 1.4; }
@media (max-width: 640px) { .tt-drawer { top: 0; } }
`;

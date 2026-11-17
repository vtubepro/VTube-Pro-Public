// The 2D avatar maker's styles: scoped under .r2e, built on the studio's theme tokens (src/ui/theme.ts) with
// fallbacks, so it reads right in the dark and light themes and also stands alone.
let injected = false;
export function injectEditorStyle() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'r2e-style';
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.r2e { --r2e-bg: var(--bg, #0e1015); --r2e-panel: var(--panel, #161920); --r2e-card: var(--card, #1b1f28); --r2e-card2: var(--card2, #222733);
  --r2e-line: var(--line, #262b37); --r2e-text: var(--text, #eef1f6); --r2e-dim: var(--dim, #a3abba); --r2e-accent: var(--accent, #7bd88f);
  --r2e-ink: var(--accent-ink, #08130b); --r2e-accent2: var(--accent2, #6cc7f5); --r2e-warn: var(--warn, #ffb454); --r2e-err: var(--err, #ff6b6b);
  --r2e-stage: var(--stage, #1b1d24); --r2e-input: var(--input, #10131a); --r2e-r: var(--radius, 12px);
  display: grid; grid-template-columns: 250px 1fr 330px; grid-template-rows: auto 1fr; height: 100%; min-height: 0; width: 100%;
  background: var(--r2e-bg); color: var(--r2e-text); font: 13.5px/1.4 Inter, system-ui, sans-serif; outline: none; position: relative; }
.r2e * { box-sizing: border-box; }
.r2e button { font: inherit; color: var(--r2e-text); background: var(--r2e-card2); border: 1px solid var(--r2e-line); border-radius: 8px; padding: 6px 11px; cursor: pointer; }
.r2e button:hover:not(:disabled) { border-color: var(--r2e-accent2); }
.r2e button:disabled { opacity: .45; cursor: default; }
.r2e button.primary { background: var(--r2e-accent); color: var(--r2e-ink); border-color: transparent; font-weight: 600; }
.r2e button.on { background: var(--r2e-accent2); color: #001018; border-color: transparent; }
.r2e input[type=text], .r2e select { font: inherit; color: var(--r2e-text); background: var(--r2e-input); border: 1px solid var(--r2e-line); border-radius: 8px; padding: 5px 8px; min-width: 0; }
.r2e input[type=range] { width: 100%; accent-color: var(--r2e-accent2); }
.r2e-top { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--r2e-line); background: var(--r2e-panel); }
.r2e-top h2 { margin: 0 10px 0 0; font-size: 15px; font-weight: 700; }
.r2e-top .sp { flex: 1; }
.r2e-seg { display: inline-flex; border: 1px solid var(--r2e-line); border-radius: 9px; overflow: hidden; }
.r2e-seg button { border: 0; border-radius: 0; background: transparent; padding: 6px 10px; }
.r2e-seg button.on { background: var(--r2e-accent2); color: #001018; }
.r2e-left, .r2e-right { min-height: 0; overflow: auto; background: var(--r2e-panel); padding: 10px; }
.r2e-left { border-right: 1px solid var(--r2e-line); }
.r2e-right { border-left: 1px solid var(--r2e-line); }
.r2e-stage { position: relative; min-height: 0; min-width: 0; background: var(--r2e-stage); overflow: hidden; touch-action: none; }
.r2e-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.r2e-stage.checker { background-color: var(--r2e-stage); background-image: linear-gradient(45deg, #ffffff08 25%, transparent 25%, transparent 75%, #ffffff08 75%), linear-gradient(45deg, #ffffff08 25%, transparent 25%, transparent 75%, #ffffff08 75%); background-size: 24px 24px; background-position: 0 0, 12px 12px; }
.r2e-tools { position: absolute; left: 10px; top: 10px; display: flex; gap: 6px; flex-wrap: wrap; z-index: 2; }
.r2e-tools button { background: var(--r2e-card); box-shadow: 0 2px 8px #0004; }
.r2e-status { position: absolute; left: 10px; right: 10px; bottom: 10px; z-index: 2; display: flex; gap: 8px; align-items: center; pointer-events: none; }
.r2e-status span { background: var(--r2e-card); border: 1px solid var(--r2e-line); padding: 5px 10px; border-radius: 99px; color: var(--r2e-dim); pointer-events: auto; }
.r2e-status span.rec { color: var(--r2e-err); border-color: var(--r2e-err); }
.r2e-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 3; padding: 20px; }
.r2e-drop { max-width: 520px; width: 100%; text-align: center; border: 2px dashed var(--r2e-line); border-radius: 18px; padding: 34px 26px; background: var(--r2e-panel); }
.r2e-drop.hot { border-color: var(--r2e-accent); }
.r2e-drop h3 { margin: 0 0 8px; font-size: 20px; }
.r2e-drop p { margin: 6px 0 16px; color: var(--r2e-dim); }
.r2e-drop .row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.r2e-busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 4; background: #0008; color: #fff; font-size: 16px; }
.r2e h4 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--r2e-dim); }
.r2e-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.r2e-tabs button { padding: 5px 9px; }
.r2e-parts { display: flex; flex-direction: column; gap: 2px; }
.r2e-part { display: grid; grid-template-columns: 34px 1fr auto; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.r2e-part:hover { background: var(--r2e-card); }
.r2e-part.sel { background: var(--r2e-card2); border-color: var(--r2e-accent2); }
.r2e-part img { width: 34px; height: 34px; object-fit: contain; background: #8882; border-radius: 6px; }
.r2e-part .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r2e-part > .nm { min-width: 0; }
.r2e-part .rl { display: block; font-size: 11.5px; color: var(--r2e-dim); white-space: normal; overflow-wrap: anywhere; }   /* "Whole eye (one layer) (right)" wraps instead of being cut off */
.r2e-part .rl.unk { color: var(--r2e-warn); }
.r2e-card { background: var(--r2e-card); border: 1px solid var(--r2e-line); border-radius: var(--r2e-r); padding: 10px 12px; margin-bottom: 10px; }
.r2e-card.good { border-color: color-mix(in srgb, var(--r2e-accent) 60%, transparent); }
.r2e-card p { margin: 4px 0; }
.r2e-dim { color: var(--r2e-dim); }
.r2e-q .pics { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.r2e-q .pics button { padding: 4px; width: 76px; height: 76px; display: flex; align-items: center; justify-content: center; background: #8882; }
.r2e-q .pics button img, .r2e-q .pics .pic img { max-width: 100%; max-height: 100%; }
.r2e-q .pics .pic { width: 76px; height: 76px; display: flex; align-items: center; justify-content: center; background: #8882; border-radius: 8px; }
.r2e.nodoc { grid-template-columns: 1fr; }
.r2e.nodoc .r2e-left, .r2e.nodoc .r2e-right { display: none; }
.r2e-part input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--r2e-accent2); }
.r2e-q .choices { display: flex; flex-wrap: wrap; gap: 6px; }
.r2e-got { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.r2e-got span { display: inline-flex; align-items: center; gap: 4px; background: var(--r2e-card2); border-radius: 99px; padding: 3px 9px 3px 4px; font-size: 12px; }
.r2e-got img { width: 22px; height: 22px; object-fit: contain; }
.r2e-row { display: grid; grid-template-columns: 1fr 56px; gap: 6px; align-items: center; margin: 3px 0; }
.r2e-row label { font-size: 12.5px; }
.r2e-row .v { text-align: right; font-variant-numeric: tabular-nums; color: var(--r2e-dim); font-size: 12px; }
.r2e-prm { padding: 4px 6px; border-radius: 8px; border: 1px solid transparent; }
.r2e-prm.focus { border-color: var(--r2e-err); background: var(--r2e-card); }
.r2e-prm .keys { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.r2e-prm .keys button { padding: 1px 7px; font-size: 11.5px; border-radius: 99px; }
.r2e-field { display: grid; grid-template-columns: 110px 1fr; gap: 8px; align-items: center; margin: 6px 0; }
.r2e-field > span { font-size: 12.5px; color: var(--r2e-dim); }
.r2e-btns { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.r2e-toast { position: absolute; left: 50%; bottom: 52px; transform: translateX(-50%);   /* at the bottom: at the top it covered the avatar's head */ z-index: 6; background: var(--r2e-card); border: 1px solid var(--r2e-line); border-radius: 10px; padding: 8px 14px; box-shadow: 0 8px 24px #0006; max-width: min(560px, 90%); }
.r2e-toast.err { border-color: var(--r2e-err); }
.r2e-toast { padding-right: 34px; }
.r2e-toast .x { position: absolute; right: 6px; top: 6px; padding: 0 7px; border: 0; background: transparent; font-size: 16px; line-height: 1.2; }
.r2e-toast .r2e-notes { margin-top: 6px; max-height: 46vh; overflow: auto; }
.r2e-toast .r2e-notes summary { cursor: pointer; color: var(--r2e-accent2); }
.r2e-toast .r2e-notes ul { margin: 2px 0 6px 18px; padding: 0; }
.r2e-toast .r2e-notes li { margin: 2px 0; color: var(--r2e-dim); }
.r2e-back { position: fixed; inset: 0; z-index: 9100; display: grid; place-items: center; padding: 16px; background: #05070bb8; }
.r2e-dlg { width: min(440px, 100%); background: var(--r2e-card); color: var(--r2e-text); border: 1px solid var(--r2e-line); border-radius: 16px; box-shadow: 0 16px 48px #0008; padding: 18px; }
.r2e-dlg h3 { margin: 0 0 8px; font-size: 17px; }
.r2e-dlg p { margin: 0 0 12px; color: var(--r2e-dim); }
.r2e-dlg .r2e-btns { justify-content: flex-end; margin: 0; }
.r2e button.danger { color: var(--r2e-err); }
.r2e-overlay { position: fixed; inset: 0; z-index: 9000; background: var(--bg, #0e1015); overflow: auto; }   /* (narrow: the stacked layout is taller than the window and scrolls) */
@media (max-width: 900px) {
  .r2e { grid-template-columns: 1fr; grid-template-rows: auto minmax(320px, 52vh) auto auto; height: auto; min-height: 100%; }
  .r2e-stage { grid-row: 2; }
  .r2e-right { grid-row: 3; border-left: 0; border-top: 1px solid var(--r2e-line); }
  .r2e-left { grid-row: 4; border-right: 0; border-top: 1px solid var(--r2e-line); }
  .r2e-top h2 { width: 100%; }
  .r2e-toast { position: fixed; top: auto; bottom: 14px; }
}
`;

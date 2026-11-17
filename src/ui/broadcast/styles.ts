// Go Live tab styles. One <style> element, added once. Colours come from the Live panel's own tokens (--lc-*) when the tab
// sits inside it, and fall back to the studio's tokens, so the tab also works on its own (tests, a pop-out).
export const GL_CSS = `
.gl-root { --gl-bg: var(--lc-bg2, var(--card, #1b1f28)); --gl-bg2: var(--lc-bg3, var(--card2, #222733)); --gl-bg3: var(--lc-bg4, var(--card3, #2a3040));
  --gl-text: var(--lc-text, var(--text, #eef1f6)); --gl-dim: var(--lc-dim, var(--dim, #a3abba));
  --gl-edge: var(--lc-edge2, rgb(255 255 255 / .16)); --gl-acc: var(--lc-acc, var(--accent, #7bd88f)); --gl-acc-ink: var(--lc-acc-ink, #08130b);
  --gl-ok: var(--lc-ok, #3ddc84); --gl-warn: var(--lc-warn, #ffb454); --gl-bad: var(--lc-err, #ff6b6b); --gl-live: var(--lc-tally, #ff3b4e);
  display: grid; gap: 12px; min-width: 0; padding: 2px 2px 12px; color: var(--gl-text); font-size: 13px; line-height: 1.4; }
.gl-root *, .gl-root *::before, .gl-root *::after { box-sizing: border-box; }
.gl-root h3, .gl-root h4 { margin: 0; font-size: 14px; font-weight: 650; }
.gl-root p { margin: 0; }
.gl-sec { display: grid; gap: 12px; min-width: 0; }
.gl-sec:empty { display: none; }
.gl-card { background: var(--gl-bg); border-radius: 12px; padding: 12px; display: grid; gap: 10px; min-width: 0; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gl-text) 8%, transparent); }
.gl-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gl-head h3 { flex: 1; min-width: 0; }
.gl-dim { color: var(--gl-dim); }
.gl-small { font-size: 12px; }
.gl-cols { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); align-items: start; }

/* buttons */
.gl-btn { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 14px; border-radius: 10px;
  background: var(--gl-bg3); color: var(--gl-text); font-weight: 600; font-size: 13px; text-align: center; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gl-text) 10%, transparent); }
.gl-btn:hover:not([disabled]) { background: color-mix(in srgb, var(--gl-bg3) 80%, var(--gl-text) 20%); }
.gl-btn:focus-visible, .gl-chip:focus-visible, .gl-opt:focus-visible, .gl-input:focus-visible { outline: 2px solid var(--gl-acc); outline-offset: 2px; }
.gl-btn[disabled] { opacity: .5; cursor: not-allowed; }
.gl-btn.pri { background: var(--gl-acc); color: var(--gl-acc-ink); box-shadow: none; }
.gl-btn.warn { background: color-mix(in srgb, var(--gl-warn) 22%, var(--gl-bg3)); }
.gl-btn.bad { background: color-mix(in srgb, var(--gl-bad) 28%, var(--gl-bg3)); }
.gl-btn.s { min-height: 30px; padding: 0 10px; font-size: 12px; }
.gl-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.gl-row > .gl-grow { flex: 1; min-width: 0; }

/* the big button */
.gl-hero { display: grid; gap: 8px; }
.gl-go { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 64px; padding: 0 20px; border-radius: 16px;
  font-size: 20px; font-weight: 750; letter-spacing: .01em; text-align: center; background: var(--gl-acc); color: var(--gl-acc-ink); transition: transform .08s ease, filter .15s ease; }
.gl-go:hover:not([disabled]) { filter: brightness(1.08); }
.gl-go:active:not([disabled]) { transform: scale(.985); }
.gl-go:focus-visible { outline: 3px solid var(--gl-text); outline-offset: 3px; }
.gl-go[disabled] { cursor: not-allowed; }
.gl-go.off { background: var(--gl-bg3); color: var(--gl-dim); }
.gl-go.wait { background: var(--gl-bg3); color: var(--gl-text); }
.gl-go.end { background: var(--gl-live); color: #fff; }
.gl-go.arm { background: #fff; color: var(--gl-live); outline: 3px solid var(--gl-live); outline-offset: 2px; }
.gl-sub { text-align: center; color: var(--gl-dim); min-height: 1.4em; }
.gl-onair { display: flex; align-items: center; justify-content: center; gap: 10px; font-weight: 700; }
.gl-onair .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--gl-live); box-shadow: 0 0 0 0 color-mix(in srgb, var(--gl-live) 60%, transparent); }
.gl-timer { font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 700; }
@media (prefers-reduced-motion: no-preference) { .gl-onair .dot { animation: gl-pulse 1.6s ease-out infinite; } @keyframes gl-pulse { 70% { box-shadow: 0 0 0 9px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } } }
.gl-note { font-size: 12px; color: var(--gl-dim); text-align: center; }

/* tones */
.gl-ok { --gl-tone: var(--gl-ok); } .gl-warn { --gl-tone: var(--gl-warn); } .gl-bad { --gl-tone: var(--gl-bad); } .gl-quiet { --gl-tone: var(--gl-dim); }
.gl-mark { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 800; color: #0b0d12; background: var(--gl-tone, var(--gl-dim)); }

/* the confirm card */
.gl-confirm { border-radius: 14px; padding: 14px; display: grid; gap: 10px; background: var(--gl-bg2); box-shadow: 0 0 0 2px var(--gl-acc), 0 8px 24px rgb(0 0 0 / .35); }
.gl-confirm.quiet { box-shadow: 0 0 0 2px var(--gl-edge); }
.gl-confirm h3 { font-size: 16px; }
.gl-confirm ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.gl-confirm:focus { outline: none; }

/* health tile */
.gl-health { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: start; border-left: 4px solid var(--gl-tone, var(--gl-dim)); }
.gl-health .gl-mark { margin-top: 1px; }
.gl-health .body { display: grid; gap: 6px; min-width: 0; }
.gl-health b { font-size: 14px; }

/* preflight */
.gl-rows { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.gl-prow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px 10px; align-items: center; padding: 8px; border-radius: 10px; background: var(--gl-bg2); }
.gl-prow .t { display: grid; gap: 1px; min-width: 0; }
.gl-prow .t b { font-weight: 650; }
.gl-prow .t span { color: var(--gl-dim); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 460px) { .gl-prow { grid-template-columns: auto minmax(0, 1fr); } .gl-prow .gl-btn { grid-column: 1 / -1; } }

/* destinations */
.gl-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.gl-chip { all: unset; box-sizing: border-box; cursor: pointer; display: inline-grid; grid-template-columns: auto 1fr; gap: 0 8px; align-items: center; min-height: 44px; padding: 4px 12px; border-radius: 12px; background: var(--gl-bg2);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gl-text) 10%, transparent); max-width: 100%; }
.gl-chip .dot { grid-row: span 2; width: 10px; height: 10px; border-radius: 50%; background: var(--gl-tone, var(--gl-dim)); }
.gl-chip b { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-chip small { color: var(--gl-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-chip.off { opacity: .6; }
.gl-chip.editing { box-shadow: 0 0 0 2px var(--gl-acc); }
.gl-edit { display: grid; gap: 10px; padding: 10px; border-radius: 10px; background: var(--gl-bg2); }
.gl-field { display: grid; gap: 4px; }
.gl-field > span { font-size: 12px; color: var(--gl-dim); }
.gl-input { all: unset; box-sizing: border-box; width: 100%; min-height: 36px; padding: 0 10px; border-radius: 8px; background: var(--gl-bg); color: var(--gl-text); box-shadow: inset 0 0 0 1px var(--gl-edge); }
.gl-code { font-size: 26px; font-weight: 800; letter-spacing: .12em; text-align: center; font-variant-numeric: tabular-nums; padding: 6px 0; user-select: all; }
.gl-add { display: flex; flex-wrap: wrap; gap: 8px; }

/* which one do you stream with */
.gl-opts { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); }
.gl-opt { all: unset; box-sizing: border-box; cursor: pointer; display: grid; gap: 4px; align-content: start; padding: 10px; border-radius: 12px; background: var(--gl-bg2); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gl-text) 10%, transparent); }
.gl-opt[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--gl-acc); }
.gl-opt[disabled] { opacity: .55; cursor: not-allowed; }
.gl-opt b { font-weight: 650; }
.gl-opt span { color: var(--gl-dim); font-size: 12px; }
.gl-badge { display: inline-block; justify-self: start; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; background: var(--gl-bg3); color: var(--gl-dim); }

/* notices (old helper, no helper, a resume offer) */
.gl-notice { display: grid; gap: 8px; text-align: center; justify-items: center; padding: 18px 14px; }
.gl-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--gl-warn) 16%, var(--gl-bg)); }
.gl-banner span { flex: 1; min-width: 160px; }
.gl-keynote { font-size: 12px; color: var(--gl-dim); text-align: center; }
.gl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export function ensureGoLiveCss(): void {
  if (document.getElementById('vtp-gl-css')) return;
  const s = document.createElement('style');
  s.id = 'vtp-gl-css';
  s.textContent = GL_CSS;
  document.head.append(s);
}

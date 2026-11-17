// The first time an area of the studio is shown, the browser lays out its text for the first time: it loads font files
// (the emoji and symbol fonts behind the icons in the labels), looks up a fallback font for every new symbol and builds
// its text-shaping caches — measured 60-90 ms of the studio's main thread inside one click (first visit to Room / Me),
// time the face tracker's results wait. All of that is cached for the rest of the session, so the studio does it ONCE,
// a little at a time, in idle time after it starts: every non-ASCII character its interface uses (WARM_CHARS, checked
// against the sources by tools/fontwarm_unit.ts) in each font weight, in an invisible box, one weight per idle slice.
//   localStorage vtp.fontWarm = '0' turns it off.

/** Every non-ASCII character in the studio's interface strings (src/ui, shared, …; CJK / control characters excluded). */
export const WARM_CHARS = '£¥§°±²·×éøłαω‍–—‘’“”•…‹›₩€₱₹₺ℹ⅔←↑→↓↔↕↗↩↶↺↻⇤⇥⇧⇩∅−∞∧∨≈≤≥⋮⋯⌘⏭⏱⏳⏸⏹①②■▣▪▬▲▴▶▸▼▾◀◆◉○◍◎●☀☁☄★☆☑☕☝☢☹☺♛♥♦♪⚓⚔⚙⚠⚡⚪⛅⛈⛔⛨✂✅✈✉✊✋✌✎✓✔✕✗✚✦✨❓❔❚❤➕➡⟲⟳⤒⤓⤢⬅⬛⭐🌃🌅🌆🌇🌈🌌🌐🌙🌦🌧🌪🌫🌱🌴🌿🍅🍔🍝🍟🍳🍹🍾🎁🎆🎇🎉🎊🎙🎚🎛🎞🎡🎤🎥🎧🎨🎩🎬🎭🎮🎯🎲🎵🏁🏘🏛🏠🏰🏷🐍🐕🐡🐦🐱🐸🐾👀👁👄👋👍👎👏👑👔👕👗👢👥👯👻👾💃💍💎💖💜💡💥💨💬💵📄📊📌📍📏📖📡📯📱📲📷📺📼📽🔁🔄🔇🔉🔊🔎🔒🔔🔗🔘🔤🔥🔨🔴🕒🕗🕶🕺🖐🖥🖼🗑🗣🗿😁😂😊😏😑😗😠😢😮😲😵🙂🙈🙊🙌🙏🚀🚁🚂🚦🚨🚪🚶🛋🛍🛑🛡🛰🛻🟢🟦🟩🟪🤐🤕🤖🤝🤟🤨🤫🤳🥂🦎🦖🧊🧌🧍🧒🧚🧝🧠🧩🧪🧭🧰🧶🧸🧻🪐🪑🪖🪜🪟🪩';
const WEIGHTS = [400, 500, 600, 650, 700, 750, 800];
/** Text sizes the interface uses (px). The system UI font is a variable font with an optical-size axis: every size is a
 *  font instance of its own, created on first use (~5 ms each, measured). */
const SIZES = [9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 19, 20, 22, 26, 28];

let started = false;
/** Progress (tests / diagnostics): slices run, the longest slice (ms), done. */
export const fontWarmStats = { slices: 0, maxMs: 0, totalMs: 0, done: false };
export function warmFonts(doc: Document = document) {
  if (started) return;
  started = true;
  try { if (localStorage.getItem('vtp.fontWarm') === '0') return; } catch { /* storage off: warm anyway */ }
  const idle: (fn: (d?: IdleDeadline) => void) => void = typeof requestIdleCallback === 'function' ? (fn) => { requestIdleCallback((d) => fn(d), { timeout: 4000 }); } : (fn) => { setTimeout(() => fn(), 100); };
  const emojiPresentation = Array.from(WARM_CHARS).filter((c) => (c.codePointAt(0) ?? 0) >= 0x2190 && (c.codePointAt(0) ?? 0) < 0x2c00).map((c) => `${c}\uFE0F`).join(' ');
  // every character once per weight (the fallback-font lookups), then each weight x size with a few characters from each
  // fallback font (the font instances): small slices, at most ~6 ms of work each
  const sample = 'Aa09 ' + ['é', '–', '→', '▶', '●', '★', '✓', '⚙', '⏱', '📷', '🎙', '🙂'].join('');
  const jobs: { w: number; z: number; t: string }[] = [];
  const chars = Array.from(`${WARM_CHARS} ${emojiPresentation}`);
  for (const w of WEIGHTS) for (let k = 0; k < chars.length; k += 40) jobs.push({ w, z: 13, t: chars.slice(k, k + 40).join('') });
  for (const w of WEIGHTS) for (const z of SIZES) jobs.push({ w, z, t: sample });
  let i = 0;
  const box = doc.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  // laid out and shaped (visibility, not display:none), never seen, never in the way; emptied after each slice
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:1600px;height:400px;visibility:hidden;pointer-events:none;contain:strict';
  const step = (d?: IdleDeadline) => {
    if (!doc.body) return;
    if (!box.isConnected) doc.body.append(box);
    const t0 = performance.now();
    while (i < jobs.length) {
      const j = jobs[i++];
      const s = doc.createElement('span');
      s.style.cssText = `font-weight:${j.w};font-size:${j.z}px`;
      s.textContent = j.t;
      box.replaceChildren(s);
      void box.offsetHeight;
      if (performance.now() - t0 > 4 || (d && d.timeRemaining() < 2)) break;
    }
    const ms = performance.now() - t0;
    fontWarmStats.slices++; fontWarmStats.totalMs += ms; fontWarmStats.maxMs = Math.max(fontWarmStats.maxMs, ms);
    if (i >= jobs.length) { box.remove(); fontWarmStats.done = true; return; }
    idle(step);
  };
  idle(step);
}

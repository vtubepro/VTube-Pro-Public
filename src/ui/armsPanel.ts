// "Arms" (Advanced -> Tracking -> Arms & hands): what the avatar's arms do. Three plain choices with small pictures
// (Follow my arms / At my sides / In front), and for "In front" how the hands sit + whether big gestures still come
// through. Saved per avatar (profile.tracking.armPose / armFront / armFrontReact, shared/armPose.ts); live, no rebuild.
// Hidden for 2D avatars, four-legged bodies and walking machines (armPoseAvailable): no message, nothing saved.
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { ARM_FRONT_STYLES, ARM_FRONT_TEXT, ARM_POSE_MODES, ARM_POSE_TEXT, armPoseAvailable, armSettings, type ArmFrontStyle, type ArmPoseMode } from '../../shared/armPose.ts';
import { h, toggle } from './dom.ts';
import { capabilityChip } from './capabilityView.ts';

const CSS = `
.armpick { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 2px 0 6px; }
.armpick button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 4px 5px; background: #232835; color: var(--text); border: 1px solid #333b4b; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; line-height: 1.2; }
.armpick button:hover { background: #2b3243; }
.armpick button[aria-pressed="true"] { outline: 2px solid var(--accent2); background: #263040; }
.armpick svg { width: 54px; height: 62px; display: block; }
.armpick.small { grid-template-columns: repeat(4, 1fr); }
.armpick.small svg { width: 38px; height: 30px; }
.armpick .ink { stroke: #cfd6e4; fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.armpick .skin { fill: #f2c9a5; stroke: none; }
.armpick .body { fill: #3a4256; stroke: none; }
.armpick .hint { stroke: var(--accent2); stroke-width: 2; fill: none; stroke-linecap: round; opacity: .8; }
`;
function ensureCss() {
  if (document.getElementById('vtp-armpick-css')) return;
  const s = document.createElement('style'); s.id = 'vtp-armpick-css'; s.textContent = CSS; document.head.append(s);
}

/** A person, front view: head, body, and the arms as asked. Static markup written here, not user text. */
const FIG = (arms: string, extra = '') => `<svg viewBox="0 0 54 62" aria-hidden="true"><circle class="skin" cx="27" cy="10" r="7"/><rect class="body" x="16" y="19" width="22" height="28" rx="7"/><path class="ink" d="M21 47v12M33 47v12"/>${arms}${extra}</svg>`;
const ICON: Record<ArmPoseMode, string> = {
  // one arm raised in a wave, the other relaxed, motion marks
  follow: FIG('<path class="ink" d="M17 23 L9 38 M37 22 L46 8"/><circle class="skin" cx="46" cy="7" r="3.2"/><circle class="skin" cx="9" cy="39" r="3.2"/>', '<path class="hint" d="M51 4q3 5 0 10M42 2q-3 4-1 9"/>'),
  // both arms straight down
  sides: FIG('<path class="ink" d="M17 23 L11 46 M37 23 L43 46"/><circle class="skin" cx="11" cy="48" r="3.2"/><circle class="skin" cx="43" cy="48" r="3.2"/>'),
  // elbows out, forearms forward and in, hands together in front of the belly
  front: FIG('<path class="ink" d="M17 23 L12 38 L25 41 M37 23 L42 38 L29 41"/><circle class="skin" cx="27" cy="41" r="4"/>'),
};
const SMALL = (inner: string) => `<svg viewBox="0 0 38 30" aria-hidden="true">${inner}</svg>`;
const STYLE_ICON: Record<ArmFrontStyle, string> = {
  together: SMALL('<circle class="skin" cx="14" cy="15" r="6"/><circle class="skin" cx="24" cy="15" r="6"/>'),
  clasped: SMALL('<ellipse class="skin" cx="19" cy="15" rx="10" ry="6"/><path class="ink" d="M12 15h14M14 11l10 8M24 11l-10 8" style="stroke-width:1.6;stroke:#a9805f"/>'),
  desk: SMALL('<path class="ink" d="M3 24h32"/><ellipse class="skin" cx="10" cy="19" rx="6" ry="3.5"/><ellipse class="skin" cx="28" cy="19" rx="6" ry="3.5"/>'),
  controller: SMALL('<path d="M8 12h22a5 5 0 0 1 5 6l-2 5a3 3 0 0 1-5 0l-1-3H11l-1 3a3 3 0 0 1-5 0l-2-5a5 5 0 0 1 5-6z" fill="#4b5470"/><circle class="skin" cx="9" cy="14" r="3.6"/><circle class="skin" cx="29" cy="14" r="3.6"/>'),
};

/** The Arms picker, or null when this avatar has no use for it (2D, four-legged, walking machine, nothing loaded). */
export function armsPicker(app: App, redraw: () => void): HTMLElement | null {
  const p = app.profile;
  if (!p || !armPoseAvailable(p)) return null;
  ensureCss();
  const cur = armSettings(p.tracking);
  const edit = (fn: (t: AvatarProfile['tracking']) => void) => { app.edit((q) => fn(q.tracking), false); redraw(); };
  const setMode = (m: ArmPoseMode) => edit((t) => { if (m === 'follow') delete t.armPose; else t.armPose = m; });
  const setStyle = (s: ArmFrontStyle) => edit((t) => { if (s === 'together') delete t.armFront; else t.armFront = s; });
  const pick = h('div', { class: 'armpick', role: 'group', 'aria-label': 'What the arms do' },
    ...ARM_POSE_MODES.map((m) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(cur.mode === m), title: ARM_POSE_TEXT[m].hint, 'data-arms': m, onClick: () => setMode(m) }, h('span'), ARM_POSE_TEXT[m].name);
      b.firstElementChild!.innerHTML = ICON[m];
      return b;
    }));
  const hint = h('p', { class: 'note' }, ARM_POSE_TEXT[cur.mode].hint);
  const out = h('div', { class: 'armsbox' }, h('div', { class: 'lbl', style: 'margin:2px 0 4px' }, 'Arms ', capabilityChip('arms-front')), pick, hint);
  if (cur.mode === 'front') {
    const styles = h('div', { class: 'armpick small', role: 'group', 'aria-label': 'How the hands sit' },
      ...ARM_FRONT_STYLES.map((s) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(cur.style === s), title: ARM_FRONT_TEXT[s].hint, 'data-arms-style': s, onClick: () => setStyle(s) }, h('span'), ARM_FRONT_TEXT[s].name);
        b.firstElementChild!.innerHTML = STYLE_ICON[s];
        return b;
      }));
    out.append(styles, h('p', { class: 'note' }, ARM_FRONT_TEXT[cur.style].hint),
      toggle('Big gestures still come through', cur.react, (v) => edit((t) => { if (v) delete t.armFrontReact; else t.armFrontReact = false; }),
        'When your camera clearly sees you raise or throw out an arm, the avatar’s arm follows it, then settles back. Your fingers follow whenever the camera sees your hand clearly.'));
  }
  return out;
}

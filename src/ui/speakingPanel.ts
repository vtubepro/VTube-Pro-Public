// "My speaking profile" card (Go Live → Advanced → Voice, phone & 2nd camera): everything VTube Pro has learned about
// how THIS person talks and emotes — voice (vowels, consonants, the personal neural layer) and face (the voice → mouth
// style, the expression recogniser, the neutral face) — in one place, learned by the one 45-second setup test, used by
// every avatar. Save / load keeps it as ONE file on the performer's own PC (e.g. for a new PC); nothing is uploaded.
import type { App } from '../app.ts';
import { button, h, toast } from './dom.ts';
import { card, item, live } from './bits.ts';

/** Every piece of the profile, by its localStorage key (the owners keep reading their own keys). */
const PARTS: { key: string; name: string; what: string }[] = [
  { key: 'vtp.speakingProfile', name: 'Mouth style', what: 'how wide / round your mouth really gets per vowel (camera + mic)' },
  { key: 'vtp.visemeProfile', name: 'Your vowels', what: 'what your AAH / EEE / OOO sound like' },
  { key: 'vtp.consonantProfile', name: 'Your consonants', what: 'your F, S, SH, L, TH, R, W, M' },
  { key: 'vtp.nvPersonal.fast', name: 'Neural voice layer', what: 'the lip-sync voice model tuned to your voice (fast model: Standard / Better at 60 ms)' },
  { key: 'vtp.nvPersonal', name: 'Neural voice layer (full model)', what: 'the same for the full model (lookahead 80 ms and up)' },
  { key: 'vtp.exprModel', name: 'Your expressions', what: 'what your smile, grin, sad, angry, surprised … look like' },
  { key: 'vtp.faceCalibration', name: 'Neutral face', what: 'your relaxed face and expression peaks' },
  { key: 'vtp.learnMe', name: 'Keep learning me', what: 'your learned lip-sync / blink / head-movement versions and their settings (the training numbers themselves stay in this browser)' },
  { key: 'vtp.naturalCapture', name: 'Natural mode', what: 'your relaxed face per head pose + how big your everyday expressions are (learned while you stream)' },
];
const has = (k: string) => { try { return !!localStorage.getItem(k); } catch { return false; } };

export function speakingProfileCard(app: App, refresh: () => void): HTMLElement {
  const list = h('div', { class: 's-list' });
  const paint = () => {
    const p = app.speakingProfile;
    list.replaceChildren(...PARTS.map((x) => {
      let d = x.what;
      if (x.key === 'vtp.speakingProfile' && p?.face) {
        const e = p.face.fitErr;
        d = `${x.what} · learned ${new Date(p.at).toLocaleString()} from ${p.face.samples} frames · error vs your camera: wide ${e.wide?.[0]} → ${e.wide?.[1]}, round ${e.round?.[0]} → ${e.round?.[1]}`;
      }
      // the last setup test couldn't learn the mouth style: say why instead of just leaving it unticked
      const note = x.key === 'vtp.speakingProfile' ? app.speakingStyleNote : null;
      if (note && !note.ok) return item('warn', '!', x.name, `Not learned in the last test (${new Date(note.at).toLocaleTimeString()}): ${note.reason}`);
      return item(has(x.key) ? 'ok' : '', has(x.key) ? '✓' : '·', x.name, d);
    }));
  };
  paint();
  live(() => { if (!list.isConnected) return false; paint(); return true; });
  const save = () => {
    const data: Record<string, string> = {};
    for (const x of PARTS) { try { const v = localStorage.getItem(x.key); if (v) data[x.key] = v; } catch { /* storage off */ } }
    const blob = new Blob([JSON.stringify({ kind: 'vtube-pro-speaking-profile', v: 1, at: new Date().toISOString(), data }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'my-speaking-profile.json' }) as HTMLAnchorElement;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  const load = () => {
    const inp = h('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text()) as { kind?: string; data?: Record<string, string> };
        if (j.kind !== 'vtube-pro-speaking-profile' || !j.data) throw new Error('not a VTube Pro speaking profile');
        if (app.observer) { toast('Observer sandbox: not loaded here.', 'warn'); return; }
        for (const x of PARTS) if (typeof j.data[x.key] === 'string') localStorage.setItem(x.key, j.data[x.key]);
        toast('Speaking profile loaded — reloading the studio to use it everywhere…', 'ok', 4000);
        setTimeout(() => location.reload(), 1500);
      } catch (e) { toast(`Couldn’t load: ${(e as Error).message}`, 'err'); }
    };
    inp.click();
  };
  return card('🗣 My speaking profile', 'How YOU talk and emote, learned by the 45-second test (camera + mic on) and used by every avatar you wear. Stored only on this PC.',
    list,
    h('div', { class: 's-row', style: 'margin-top:8px' },
      button(app.setupRunning ? 'Running…' : 'Learn it now (45-second test)', () => {
        if (!app.trackingOn) { toast('Turn the camera on first', 'warn'); return; }
        if (!app.audio.active) toast('Tip: turn the mic on too — the voice parts and the mouth style need it', 'info', 5000);
        void app.runSetupTest();
      }, 'primary'),
      button('Save a copy…', save, 'ghost'),
      button('Load…', load, 'ghost'),
      app.speakingProfile ? button('Reset mouth style', () => { if (app.observer) { toast('Observer sandbox: nothing is reset here.', 'warn'); return; } if (confirm('Forget your learned mouth style? (Voice and expressions stay.)')) { app.applySpeakingProfile(null); refresh(); } }, 'ghost') : null));
}

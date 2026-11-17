// Body & physics -> "Skeleton for anything": say what the model is (a person, four legs, a bird, a snake, a thing), tap a few
// spots on its picture, and the helper's headless Blender builds the skeleton (blender/autorig.py). Plain words only.
// Under it, for everyone: "Smart skeleton", a learned model that needs a big graphics
// card (the panel says what the PC needs), installed on demand after a short notice (server/rigMl.ts; docs/AUTORIG_3D.md).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { api, waitJob, type RigMlStatus } from '../api.ts';
import { guessSoftRig } from '../avatar/softRig.ts';
import { BODY_TYPE_INFO } from '../../shared/rigTaps.ts';
import { describeRigMap } from '../../shared/rigMap.ts';
import { NOTE_TEXT } from '../../shared/rigMl.ts';
import { button, h, section, toast } from './dom.ts';
import { askBodyTaps } from './bodyTaps.ts';
import { capabilityChip, gateButton } from './capabilityView.ts';

/** Is OBS streaming / recording right now? (VTube Pro's own reading; null = it cannot tell) */
async function obsLive(): Promise<boolean | null> {
  try { const r = await fetch('/api/gpu/status'); const v = ((await r.json()) as { live?: unknown }).live; return typeof v === 'boolean' ? v : null; } catch { return null; }
}
/**
 * A rig job finished (it ran for minutes: the person may have switched avatars, or gone live, since). Reload only when this avatar is the one being
 * worn, and ask first while OBS is live (the reload shows on stream). Any other avatar is left alone: nothing is switched.
 */
async function afterRigJob(app: App, id: string, result: { [k: string]: unknown } | undefined, onHeld?: (apply: () => Promise<void>) => void) {
  const worn = app.profile?.id === id;
  const live = (await obsLive()) !== false;   // unknown counts as live (VTube Pro holds a result back the same way)
  if (result?.applied === false) {
    // the helper held the profile change back because OBS was live when the job finished
    if (!worn) { try { await api.rigMlApply(id, true); } catch (e) { toast((e as Error).message, 'err'); } return; }   // (not on screen: nothing reloads)
    const apply = async () => { try { await api.rigMlApply(id, true); toast('The new skeleton is on.', 'ok'); } catch (e) { toast((e as Error).message, 'err'); } };
    if (live && !confirm('The new skeleton is ready. Switching it on reloads your avatar, and you are live right now. Do it now?')) { toast('The skeleton is ready. Switch it on when you are not streaming (the button under “Smart skeleton”).', 'info', 9000); onHeld?.(apply); return; }
    await apply();
    return;
  }
  if (!worn) return;
  if (live && !confirm('The skeleton is ready. Reloading your avatar shows on stream, and you are live right now. Reload it now?')) { toast('The skeleton is saved. Your avatar reloads the next time you load it.', 'info', 9000); return; }
  await app.loadAvatar(id, true);
}

export function skeletonSection(app: App, p: AvatarProfile): HTMLElement {
  const rt = app.runtime!;
  const map = p.rig.retarget;
  const state = h('p', { class: 'note' },
    map ? `Built for: ${BODY_TYPE_INFO[map.bodyType ?? 'thing'].label.toLowerCase()}. ${describeRigMap(map).join(' ')}` : 'Works for a person, an animal on four legs, a bird, a snake or a thing.');
  const go = button('Pick what it is, then tap a few spots', async () => {
    try {
      const bytes = await (await fetch(api.modelUrl(p))).arrayBuffer();
      const r = await askBodyTaps({ bytes });
      if (!r) return;
      const soft = p.rig.soft ?? guessSoftRig(rt.model);
      const { jobId } = await api.autorig(p.id, r.bodyType === 'person' ? soft : undefined, r);
      toast('Building the skeleton… (about a minute)');
      const j = await waitJob(jobId, () => {});
      if (j.status === 'succeeded') { toast('Skeleton ready ✔', 'ok'); await afterRigJob(app, p.id, j.result); }
      else toast(`Could not build it: ${j.error}`, 'err', 8000);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }, 'primary');
  const ml = h('div', {});
  void smartBlock(app, p, ml);
  gateButton(go as HTMLButtonElement, 'blender-rig', { keepForHelper: true });   // Blender missing / slow PC: said under the button
  return section('Skeleton for anything',
    h('p', { class: 'note' }, 'Say what it is and tap a few spots on a picture of it. VTube Pro builds a skeleton your face can drive (it needs Blender, about a minute). Your original file is kept.'),
    h('div', { class: 'btns' }, go),
    state,
    ml,
  );
}

/** Plain words for the main text: model names are licence facts, they live behind "Licence details". */
const plain = (t: string) => t.replace(/(SkinTokens|UniRig)/g, 'the smart skeleton model');
const MODEL_LABEL: Record<string, string> = { skintokens: 'Smart skeleton (best quality)', unirig: 'Smart skeleton (smaller card)' };
const LICENCE_LINE = /Objaverse|OPT-350m|GPL|licen[cs]e/i;

/** The optional learned model: both models get an Install button; a card that is too small is told why and what it needs. */
async function smartBlock(app: App, p: AvatarProfile, into: HTMLElement): Promise<void> {
  let st: RigMlStatus;
  try { st = await api.rigMlStatus(); } catch { return; }       // no answer: no add-on block
  const accept = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const rows = st.models.map((m) => {
    // full speed: just the size; low-memory staged mode: it works by itself and says it takes longer; under the floor: the Blender skeleton is used
    const why = m.installed ? 'Installed.' : m.tier === 'normal' ? `A download of about ${m.downloadGB} GB.` : `${m.why}${m.tier === 'staged' ? ` A download of about ${m.downloadGB} GB.` : ''}`;
    const suggested = st.recommended === m.id && !m.installed ? ' (suggested for your card)' : '';
    const install = button(m.installed ? 'Installed' : 'Install', async () => {
      if (!accept.checked) { toast('Tick the box once you have read the notice', 'warn'); return; }
      try {
        const { jobId } = await api.rigMlInstall(m.id);
        toast('Installing… this takes a while');
        const j = await waitJob(jobId, () => {});
        toast(j.status === 'succeeded' ? 'Smart skeleton installed ✔' : `Install did not finish: ${j.error}`, j.status === 'succeeded' ? 'ok' : 'err', 8000);
      } catch (e) { toast((e as Error).message, 'err'); }
    }) as HTMLButtonElement;
    install.disabled = !m.usable || m.installed;
    return h('div', { class: 'row' }, h('b', null, (MODEL_LABEL[m.id] ?? 'Smart skeleton') + suggested), h('span', { class: 'note' }, ` ${plain(m.summary)} ${plain(why)}`), install);
  });
  const use = button('Use the smart skeleton', async () => {
    try {
      const bytes = await (await fetch(api.modelUrl(p))).arrayBuffer();
      const r = await askBodyTaps({ bytes });       // the nose and tail taps tell it which end is the head
      if (!r) return;
      const { jobId } = await api.autorigMl(p.id, r);
      toast('The smart model is working… (a few minutes)');
      const j = await waitJob(jobId, () => {});
      if (j.status === 'succeeded') { toast('Skeleton ready ✔', 'ok'); await afterRigJob(app, p.id, j.result, (apply) => into.append(h('div', { class: 'btns' }, button('Switch on the new skeleton', () => void apply(), 'primary')))); }
      else toast(`Could not build it: ${j.error}`, 'err', 8000);
    } catch (e) { toast((e as Error).message, 'err'); }
  }) as HTMLButtonElement;
  use.disabled = !st.models.some((m) => m.installed);
  into.append(
    h('h3', { style: 'margin-top:10px' }, 'Smart skeleton (optional) ', capabilityChip('rig-ml', { always: true })),
    h('p', { class: 'note' }, `Your graphics card: ${st.gpu.name || 'none found'} (${st.gpu.vramGB} GB).${st.plan.message ? ` ${plain(st.plan.message)}` : ''}`),
    h('ul', { class: 'note' }, ...st.notice.lines.filter((l) => !LICENCE_LINE.test(l)).map((l) => h('li', null, plain(l)))),
    h('details', { class: 'note', 'data-cg': 'rig-licence' }, h('summary', null, 'Licence details'),
      h('ul', null,
        h('li', null, `Models: ${st.models.map((m) => `${m.id === 'skintokens' ? 'SkinTokens' : 'UniRig'} (${MODEL_LABEL[m.id]?.replace('Smart skeleton ', '').replace(/[()]/g, '') ?? ''})`).join(', ')}.`),
        ...st.notice.lines.filter((l) => LICENCE_LINE.test(l)).map((l) => h('li', null, l)),
        ...st.models.flatMap((m) => m.notes.map((n) => h('li', null, `${m.id === 'skintokens' ? 'SkinTokens' : 'UniRig'}: ${NOTE_TEXT[n] ?? n}`))))),
    h('label', { class: 'row' }, accept, h('span', { class: 'lbl' }, 'I read this')),
    ...rows,
    h('div', { class: 'btns' }, use),
  );
}

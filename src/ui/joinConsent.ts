// Consent screen shown before joining a party from a Discord invite (and reused by the invite-code flow):
// nothing about your avatar leaves this PC until you press Join with "Share my avatar" ticked.
import type { SharePolicy } from '../../shared/types.ts';
import type { JoinRequest, Party } from '../party.ts';
import { discord } from '../net/discordClient.ts';
import { button, h, toast } from './dom.ts';

export const CUSTODY_NOTE = 'Your avatar travels encrypted, only to the people you allow. It is kept in memory only — never saved to anyone’s disk, never exportable — and deleted the moment you leave or stop sharing. Honest limit: this is not DRM — a PC that shows your avatar has its geometry and textures in memory while it renders, so a determined person with GPU capture tools could still copy it. Only share with people you trust.';

export function policyOptions(host: string): [SharePolicy, string][] {
  return [
    ['party', 'Everyone in this party'],
    ['guild', `Only people verified in ${host}’s Discord server / role`],
    ['host', `Only ${host}`],
  ];
}

/** Overlay dialog. Resolves once joined, cancelled or failed. */
export function askJoinConsent(party: Party, req: JoinRequest): Promise<boolean> {
  document.getElementById('vtp-join-consent')?.remove();
  return new Promise((resolve) => {
    const share = h('input', { type: 'checkbox', checked: party.shareMine });
    // how I appear: my avatar, or my webcam / VTube Studio picture on a walking TV (Multiplayer → How you appear)
    const S = party.tv.source.settings;
    const what = S.via ? 'Spout2 model' : S.kind === 'vts' ? 'VTube Studio model' : 'webcam';
    const cur = party.tv.appear !== 'tv' ? 'avatar' : S.look === 'projector' ? 'projector' : S.look === 'standee' && S.via ? 'standee' : 'tv';
    const appear = h('select', null, h('option', { value: 'avatar', selected: cur === 'avatar' }, 'My VTube Pro avatar'),
      // (Spout2: set up in Multiplayer → How you appear; offered here once it is)
      S.via ? h('option', { value: 'standee', selected: cur === 'standee' }, `My ${what} standing in the room`) : null,
      h('option', { value: 'tv', selected: cur === 'tv' }, `My ${what} on a walking TV`),
      h('option', { value: 'projector', selected: cur === 'projector' }, `My ${what} on a projector screen`));
    const policy = h('select', null, ...policyOptions(req.hostName).map(([v, l]) => h('option', { value: v, selected: v === party.sharePolicy }, l)));
    const close = (v: boolean) => { wrap.remove(); resolve(v); };
    const origin = (() => { try { return new URL(req.relay).host; } catch { return req.relay; } })();
    const go = button('Join', async () => {
      go.disabled = true;
      try {
        if (appear.value === 'avatar') party.tv.setAppear('avatar');
        else { party.tv.source.update({ look: appear.value === 'projector' ? 'projector' : appear.value === 'standee' ? 'standee' : 'tv' }); await party.tv.ensureStarted(); }
        if (!req.trusted) await discord.save({ trustRelay: req.relay }).catch(() => {});
        await party.joinDiscord({ relay: req.relay, ticket: req.ticket, share: share.checked, policy: policy.value as SharePolicy });
        toast(`Joining ${req.hostName}’s party…`, 'ok');
        close(true);
      } catch (e) { toast(`Couldn’t join: ${(e as Error).message}`, 'err', 7000); go.disabled = false; }
    }, 'primary');
    const card = h('div', { style: 'background:#1b1e26;color:#e8e8ef;border-radius:14px;padding:22px 24px;max-width:520px;width:calc(100% - 40px);box-shadow:0 10px 50px #000a;font-size:14px' },
      h('h2', { style: 'margin:0 0 6px;font-size:19px' }, `Join ${req.hostName}’s party?`),
      h('p', { class: 'note' }, req.you ? `Discord verified you as ${req.you}. ` : '', `Signalling relay: ${origin}`),
      req.trusted ? null : h('p', { class: 'note', style: 'color:#f5c451' }, `First time joining through ${origin}. Only continue if you just clicked Join on ${req.hostName}’s invite in Discord.`),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Appear as'), appear),
      h('label', { style: 'display:flex;gap:8px;align-items:center;margin:12px 0 6px;font-weight:600' }, share, `Share my avatar with ${req.hostName} for this session`),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Who else sees it'), policy),
      h('p', { class: 'note' }, 'Unticked: you still join (voice stays in Discord), but nobody receives your model or tracking.'),
      h('p', { class: 'note', style: 'font-size:11.5px' }, CUSTODY_NOTE),
      h('div', { class: 'btns', style: 'justify-content:flex-end;margin-top:12px' }, button('Cancel', () => close(false)), go),
    );
    const wrap = h('div', { id: 'vtp-join-consent', style: 'position:fixed;inset:0;background:#0009;display:grid;place-items:center;z-index:9999' }, card);
    document.body.append(wrap);
    go.focus();
  });
}

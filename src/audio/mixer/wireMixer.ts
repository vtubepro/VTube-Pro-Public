// Connects the audio mixer to the party (src/party.ts): its guest voices, TvStudio's fallback / backstage players,
// TvLinks' levels (link guests → the director) and the party's voice-mouth samples (app guests → the director).
// One function, used by the studio (src/ui/audioMixerPanel.ts mountAudioMixer) and by the e2e test page
// (tools/audio_mixer_e2e_page.ts), so the test exercises exactly this wiring.
import { AudioMixer, type MixSource, type MixerPort } from './audioMixer.ts';
import type { TvStudio } from '../../net/tv/tvStudio.ts';
import type { TvLinks } from '../../net/tv/tvLink.ts';
import type { PartyVoice } from '../../net/voice/partyVoice.ts';
import type { Moderation } from '../../net/moderation.ts';

/** The parts of the Party the mixer uses (src/party.ts satisfies it). */
export interface MixerParty {
  readonly role: 'none' | 'host' | 'guest';
  readonly myId: string;
  readonly members: readonly { id: string; name: string; discord?: { id: string } | null }[];
  readonly tv: TvStudio;
  readonly tvLinks: TvLinks;
  readonly voice: PartyVoice;
  readonly mod: Moderation;
  voiceGate(id: string): 'air' | 'back' | 'off';
  readonly listeners: Set<() => void>;
  /** Set here: app guests' voice-mouth samples are dropped while this says so (their gate is shut). */
  voiceGated: ((id: string) => boolean) | null;
}
export interface WiredMixer {
  mixer: AudioMixer;
  port: MixerPort;
  /** 0..1: what the camera director / speaking glow get for a guest right now (after the gate; Mute for me never matters). */
  activity(id: string): number;
}

export function wireMixer(P: MixerParty, observer: boolean, mic: () => MediaStream | null, leads?: () => boolean): WiredMixer {
  const port: MixerPort = {
    observer,
    sources: () => {
      if (P.role !== 'host') return [];
      const out: MixSource[] = [];
      for (const [id, v] of P.tv.allVoices()) {
        const m = P.members.find((x) => x.id === id);
        out.push({ id, name: m?.name ?? 'Guest', uid: m?.discord?.id ?? null, track: v.track, kind: P.tvLinks.voices.has(id) ? 'link' : 'app' });
      }
      return out;
    },
    roster: () => (P.role === 'host' ? P.members.filter((m) => m.id !== P.myId).map((m) => ({ id: m.id, name: m.name, uid: m.discord?.id ?? null })) : []),
    who: (id) => { const m = P.members.find((x) => x.id === id); return m ? { name: m.name, uid: m.discord?.id ?? null } : null; },
    hear: () => P.tv.hear,
    air: (id) => P.voiceGate(id) === 'air',
    muted: (id) => P.mod.micOff(id),
    vol: (id) => P.tv.voiceVol(id),
    modVol: (id) => P.mod.vol(id),
    setModVol: (id, v) => P.tv.setVoiceVol(id, v),
    refresh: () => P.tv.modChanged(),
    mic,
    ...(leads ? { leads } : {}),
  };
  const mixer = new AudioMixer(port);
  P.tv.mix = mixer;
  P.tvLinks.levelGate = (id, lv) => mixer.levelGate(id, lv);
  P.voiceGated = (id) => mixer.voiceGated(id);
  P.listeners.add(() => mixer.sync());
  P.tv.listeners.add(() => mixer.sync());
  mixer.sync();
  const activity = (id: string) => {
    if (P.mod.micOff(id)) return 0;
    if (P.tvLinks.voices.has(id) || P.tvLinks.feeds.has(id)) return P.tvLinks.feeds.get(id)?.level ?? 0;
    return mixer.voiceGated(id) ? 0 : Math.min(1, P.voice.level(id) * 2.5);
  };
  return { mixer, port, activity };
}

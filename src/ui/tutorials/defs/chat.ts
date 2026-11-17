import type { Tutorial } from '../types.ts';

/** Chat & alerts: Chat → "Set up my chat & stream" (platforms → connect → alerts → chat on screen). */
export const chat: Tutorial = {
  id: 'chat',
  title: 'Show your chat and alerts',
  blurb: 'Connect Twitch, YouTube, Kick, Rumble or TikTok. Chat and alerts show in your room.',
  icon: 'chat',
  minutes: 3,
  group: 'Your show',
  readMore: 'CHAT_HUB.md#set-up-my-chat--stream',
  steps: [
    {
      id: 'where', area: 'chat', open: { wizard: 'chat' }, at: ['ss-platforms'],
      title: 'Where do you stream?',
      text: 'Click every place you stream. VTube Pro only reads your chat.',
      doc: 'In **Chat**, press **Set up my chat & stream**. Click every place you stream. VTube Pro only reads your chat.',
      more: 'It never posts in your chat and never needs your password.',
      wait: { click: true },
    },
    {
      id: 'connect', at: ['ss-foot'],
      title: 'Connect',
      text: 'Press the green button and sign in where it asks.',
      more: 'Each platform shows its own short steps, then **Send a test message** checks it works.',
      wait: { shows: 'ss-alerts' },
      orDone: 'chat-on',
    },
    {
      id: 'alerts', at: ['ss-alerts'], ifShown: true,
      title: 'Try your alerts',
      text: 'Press Try it to see each alert. Only your own OBS shows test alerts.',
    },
    {
      id: 'spot', at: ['ss-spots', 'ss-foot'],
      title: 'Where should chat show?',
      text: 'Pick where viewers see your chat. Then press Finish.',
      more: 'Later, the test buttons in **Chat** send pretend chat and alerts (never to your real chat), and **Open Chat Hub** shows every chat in one panel beside your stage.',
      wait: { state: 'wizard-closed' },
    },
  ],
  fixes: [
    { problem: 'It says waiting', fix: 'Your chat connects when you are live on that platform. Go live, then look again.' },
    { problem: 'Alerts don’t show in OBS', fix: 'Check that OBS shows VTube Pro, and that you picked a room.' },
  ],
};

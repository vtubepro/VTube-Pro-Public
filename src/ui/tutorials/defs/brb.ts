import type { Tutorial } from '../types.ts';

/** Be right back + Hide my screen: Live Control → Privacy (opened for you). Shift+4 / Ctrl+B. */
export const brb: Tutorial = {
  id: 'brb',
  title: 'BRB and hide my screen',
  blurb: 'Show a Be Right Back card, or cover your screen when something private is on it.',
  icon: 'brb',
  minutes: 2,
  group: 'Your show',
  readMore: 'BRB_SCREENS.md',
  steps: [
    {
      id: 'brb', area: 'onair', press: '#lc-tab-privacy', at: ['live-pv-brb', 'live-brb'],
      title: 'Be right back',
      text: 'Press Be right back. Your stream fades to your BRB card and guests are muted.',
      doc: 'In **Live → Privacy**, press **Be right back**. Your stream fades to your BRB card and guests are muted.',
      wait: { state: 'brb-on' },
    },
    {
      id: 'style', area: 'onair', at: ['live-brb-style'], ifShown: true,
      title: 'Pick a card',
      text: 'Pick the animation viewers see. You can use your own picture or video too.',
    },
    {
      id: 'back', area: 'onair', at: ['live-pv-brb', 'live-brb'],
      title: 'You’re back',
      text: 'Press it again to fade back in. Shift+4 does the same.',
      wait: { state: 'brb-off' },
    },
    {
      id: 'hide', area: 'onair', at: ['live-pv-screen', 'live-hide'],
      title: 'Hide my screen',
      text: 'Press Hide my screen to cover your game or shared window. Your avatar stays.',
      more: 'Use it when a password, a message or anything private is on screen.',
      wait: { state: 'cover-on' },
    },
    {
      id: 'show', area: 'onair', at: ['live-pv-screen', 'live-hide'],
      title: 'Show it again',
      text: 'Press it again to show your screen. Ctrl+B works from anywhere.',
      wait: { state: 'cover-off' },
    },
  ],
  fixes: [
    { problem: 'Shift+4 or Ctrl+B does nothing', fix: 'Click the studio once first, so the keys go to it.' },
    { problem: 'My game still shows', fix: 'It covers the screen in your room and the game in Gaming mode. A game added straight in OBS stays visible.' },
    { problem: 'Nothing happens on stream', fix: 'Check that OBS shows VTube Pro: the OBS light at the top must be green.' },
  ],
};

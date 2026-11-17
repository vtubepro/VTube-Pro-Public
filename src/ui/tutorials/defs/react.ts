import type { Tutorial } from '../types.ts';

/** The React screen: a room with a screen → the react set-up opens at "Pick a window" → In-scene → React; Live later. */
export const react: Tutorial = {
  id: 'react',
  title: 'Watch videos together',
  blurb: 'Put a video, stream or game on the big screen in your room.',
  icon: 'react',
  minutes: 2,
  group: 'Your show',
  readMore: 'SIMPLE_MODE.md#the-react-screen',
  steps: [
    {
      id: 'room', area: 'room', at: ['room-change'], skipIf: 'room-on',
      title: 'Pick a room first',
      text: 'The react screen lives in a room. Press Change room and pick one.',
      wait: { state: 'room-on' },
    },
    {
      id: 'pick', area: 'room', open: { wizard: 'react', at: 'pick' }, at: ['react-pick'], orShows: 'react-mode',
      title: 'Pick what to show',
      text: 'Press Pick a window. Choose the browser or game, then press Share.',
      doc: 'In **Room**, press **Set up the react screen**, then **Pick a window**. Choose the browser or game, then press **Share**.',
      more: 'Its sound stays in OBS as usual: capture the game or browser audio in OBS like you always do.',
      wait: { state: 'sharing' },
    },
    {
      id: 'way', at: ['react-mode', 'ui:wiz-react'], ifShown: true, orDone: 'wizard-closed',
      title: 'Which way?',
      text: 'Press Next. Then pick In-scene, the best choice, and press Next again.',
      more: '**In-scene** draws your window on the screen in the room. **OBS passthrough** is the old way: an OBS Window Capture under VTube Pro.',
      wait: { shows: 'react-try' },
    },
    {
      id: 'try', at: ['react-try'], ifShown: true,
      title: 'Try it',
      text: 'Press React. The screen comes down and the camera turns to it.',
      more: 'Then press **Next** and **Finish**.',
      wait: { state: 'mode-react' },
    },
    {
      id: 'live', area: 'onair', at: ['live-modes'],
      title: 'Switch while you stream',
      text: 'During your show, switch between Talk and React here. Shift+R works too.',
      doc: 'During your show, switch between Talk and React in Live (What you’re doing). Shift+R works too.',
    },
  ],
  fixes: [
    { problem: 'The screen stays black', fix: 'Some apps and sites block sharing. Try a different browser window or the game window.' },
    { problem: 'My window isn’t in the list', fix: 'Open it first and don’t minimise it. Then press Pick a window again.' },
    { problem: 'Viewers can’t hear the video', fix: 'Sound goes through OBS. Add the game or browser sound in OBS as usual.' },
    { problem: 'After a restart it says No signal', fix: 'Browsers forget the window. Press Pick a window again.' },
  ],
};

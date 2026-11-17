import type { Tutorial } from '../types.ts';

/** First-time setup: the camera and the microphone. */
export const firstSetup: Tutorial = {
  id: 'first-setup',
  title: 'First-time setup',
  blurb: 'Turn on your camera and microphone so your avatar copies you.',
  icon: 'camera',
  minutes: 2,
  group: 'Start here',
  readMore: 'QUICK_START.md',
  steps: [
    {
      id: 'camera', area: 'live', at: ['live-start'], skipIf: 'camera-on',
      title: 'Turn on your camera',
      text: 'Press Start camera & mic. If your browser asks, press Allow.',
      more: 'This is in **Tracking**. Any webcam works. Nobody sees your camera picture: viewers only see your avatar.',
      wait: { state: 'camera-on' },
    },
    {
      id: 'face', area: 'live', at: ['live-status'],
      title: 'Look at the camera',
      text: 'Look at your screen. Face found turns green when the camera sees you.',
      wait: { state: 'face-found' },
    },
    {
      id: 'mic', area: 'live', at: ['live-start'], skipIf: 'mic-on',
      title: 'Turn on your microphone',
      text: 'Press the button to turn on your microphone. Your avatar’s mouth then follows your voice.',
      wait: { state: 'mic-on' },
    },
    {
      id: 'lights', at: ['status-chips'],
      title: 'Your status lights',
      text: 'These show your camera, mic, OBS and room. Green means it works.',
      doc: 'The lights at the top show your camera, mic, OBS and room. Green means it works. Next: pick your avatar in **Me**, then do **Show your avatar in OBS**.',
    },
  ],
  fixes: [
    { problem: 'The camera won’t start', fix: 'Close other apps that use the camera, like Zoom, Discord or OBS. Then press Start again.' },
    { problem: 'The browser blocked the camera', fix: 'Click the camera icon in the address bar, pick Allow, then reload the page.' },
    { problem: 'It says “Looking for your face”', fix: 'Put more light on your face and sit a little further back.' },
    { problem: 'The wrong camera or microphone', fix: 'Tracking, then the Advanced switch: pick the right one under Camera or Microphone.' },
  ],
};

import type { Tutorial } from '../types.ts';

/** OBS: copy the link, add a Browser Source, 1920 × 1080, leave the two boxes unticked; the background is see-through. */
export const obs: Tutorial = {
  id: 'obs',
  title: 'Show your avatar in OBS',
  blurb: 'Put VTube Pro into OBS once. Your avatar shows with a see-through background.',
  icon: 'stream',
  minutes: 3,
  group: 'Start here',
  readMore: 'QUICK_START.md',
  steps: [
    {
      id: 'copy', area: 'stream', at: ['obs-copy', 'obs-link'],
      title: 'Copy your OBS link',
      text: 'Press Copy OBS link. You paste it into OBS next.',
      more: 'It is in **OBS** on the left.',
      wait: { click: true },
    },
    {
      id: 'add',
      title: 'Add it in OBS',
      text: 'In OBS, press + under Sources and pick Browser. Paste the link into URL.',
      more: 'Name the source **VTube Pro**.',
    },
    {
      id: 'size',
      title: 'Size it and press OK',
      text: 'Set Width 1920 and Height 1080. Leave the two boxes at the bottom unticked.',
      more: 'They are “Shutdown source when not visible” and “Refresh browser when scene becomes active”: ticked, your avatar reloads every time you switch scenes. Use your OBS canvas size if it is different. The background is already see-through: no green screen needed.',
    },
    {
      id: 'see', at: ['status-chips'],
      title: 'Check the light',
      text: 'When OBS shows you, the OBS light up here says In OBS.',
      doc: 'When OBS shows you, the OBS light at the top of the studio says **In OBS**.',
      wait: { state: 'in-obs' },
    },
    {
      id: 'auto', area: 'onair', at: ['live-obs-setup'], press: '#lc-tab-obs', ifShown: true, skipIf: 'in-obs',
      title: 'Want it done for you?',
      text: 'Press Set up OBS automation. It adds VTube Pro to OBS for you.',
      doc: 'In **Live → OBS**, press **Set up OBS automation**. It adds VTube Pro to OBS for you.',
      more: 'It also makes your stream scenes (Talk, React, Gaming, Interview, BRB) and switches them as you change what you are doing.',
    },
  ],
  fixes: [
    { problem: 'OBS shows nothing', fix: 'Keep VTube Pro running. In OBS, open the source and press Refresh cache of current page.' },
    { problem: 'A black or white box behind your avatar', fix: 'Don’t add a chroma key. In OBS, turn on Browser Source Hardware Acceleration (Settings → Advanced).' },
    { problem: 'Your avatar reloads when you switch scenes', fix: 'Untick both boxes at the bottom of the source’s settings.' },
    { problem: 'It is too big or cut off', fix: 'Set the source to your canvas size, like 1920 by 1080. Then right-click it and pick Transform, Fit to screen.' },
  ],
};

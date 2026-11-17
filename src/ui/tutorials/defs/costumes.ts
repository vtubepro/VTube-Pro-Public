import type { Tutorial } from '../types.ts';

/** Outfits: wear one (Me → Outfit), switch with Ctrl+1…9, change or remove them, make one with AI or bring one. */
export const costumes: Tutorial = {
  id: 'costumes',
  title: 'Outfits and costumes',
  blurb: 'Change clothes, switch outfits live with a key, and make new ones.',
  icon: 'me',
  minutes: 3,
  group: 'Your look',
  readMore: 'AVATARS_SIMPLE.md',
  steps: [
    {
      id: 'wear', area: 'me', adv: 'wardrobe', at: ['wardrobe-list'],
      title: 'Put an outfit on',
      text: 'Click an outfit to wear it. While you stream, Ctrl+1 to Ctrl+9 switch outfits.',
      doc: 'In **Me**, click an outfit under **Outfit** to wear it (all of them, with more options: the **Advanced** switch, then **Outfits**). While you stream, Ctrl+1 to Ctrl+9 switch outfits.',
      more: 'Ctrl+0 takes the outfit off. The ✕ on a card moves that outfit to the trash.',
      wait: { click: true },
    },
    {
      id: 'describe', area: 'me', adv: 'wardrobe', at: ['wardrobe-prompt'],
      title: 'Make a new outfit',
      text: 'Ask your AI app for it, like “a red hoodie with cat ears”. It builds the outfit in Blender and adds it here.',
      more: 'It needs Blender and an AI app connected to VTube Pro (the **Make things with AI** tutorial). Or build the outfit yourself in Blender and import the file below.',
    },
    {
      id: 'import', area: 'me', adv: 'wardrobe', at: ['wardrobe-import'],
      title: 'Or bring an outfit file',
      text: 'Have an outfit as a .glb file? Drop it here.',
      doc: 'Have an outfit as a .glb file? Drop it on **Import costume GLB…**. It must be rigged to the same skeleton as your avatar.',
    },
    {
      id: 'labels', area: 'me', adv: 'wardrobe', at: ['wardrobe-labels'], ifShown: true,
      title: 'Change the words',
      text: 'Some outfits have words on them, like a sign or a shirt. Type new words here.',
      doc: 'Some outfits have words on them, like a sign or a shirt. Type new words under **Labels**.',
    },
    {
      id: 'simple', area: 'me', at: ['adv-switch'],
      title: 'Back to the short view',
      text: 'All done? Turn Advanced off again for the short, simple view.',
    },
  ],
  fixes: [
    { problem: 'This avatar has no outfits', fix: 'Ask your AI app to make one, or import an outfit file.' },
    { problem: 'My AI app can’t make an outfit', fix: 'It needs Blender and your AI app connected to VTube Pro. Settings shows what is missing.' },
    { problem: 'The new outfit looks wrong', fix: 'Try clearer words or a reference picture. Remove the bad one with ✕.' },
    { problem: 'Ctrl+number does nothing', fix: 'Click the studio once first, so the keys go to it. Number 1 is the first outfit.' },
  ],
};

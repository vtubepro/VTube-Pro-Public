import type { Tutorial } from '../types.ts';

/** Bring your own model (VRM, GLB, FBX …): Me → Add my model (the drop-anywhere importer, src/ui/dropImport.ts) → the
 *  check + automatic fixes → Import → Wear it now. (beta.12: was the guided wizard; it is one "Step by step" away.) */
export const importModel: Tutorial = {
  id: 'import-model',
  title: 'Add your own model',
  blurb: 'Bring your VRoid, VRM, GLB or FBX model. We check it and fix what we can.',
  icon: 'me',
  minutes: 3,
  group: 'Start here',
  readMore: 'AVATARS_SIMPLE.md',
  steps: [
    {
      id: 'file', open: { wizard: 'model' }, at: ['imp-drop'],
      title: 'Choose your model file',
      text: 'We opened Add my model. Click here and pick your model file.',
      doc: 'In **Me**, press **Add my model**, then click the big box and pick your model file. Or drop the file anywhere on the studio.',
      more: 'VRM (from VRoid Studio) works best. GLB, GLTF and PMX open straight away; FBX, OBJ, BLEND and other 3D files need VTube Pro (it converts them). A folder or a .zip works too.',
      wait: { shows: 'imp-save' },
    },
    {
      id: 'import', at: ['imp-save'], orDone: 'avatar-added',
      title: 'We checked it',
      text: 'We fixed what we could. Press Import to add it to your avatars.',
      more: 'Want to set it up yourself? **Details** shows every fix with a switch, and **Set it up step by step instead** walks you through it.',
      wait: { click: true },
    },
    {
      id: 'wear', at: ['imp-use'],
      title: 'Wear it',
      text: 'It’s in your avatars. Press Wear it now to put it on.',
      wait: { click: true },
    },
  ],
  fixes: [
    { problem: '“We can’t open this kind of file”', fix: 'Export your model again as .vrm or .glb. Most 3D programs can save a .glb.' },
    { problem: '“Files need VTube Pro”', fix: 'FBX, OBJ and BLEND files need VTube Pro. Press Open VTube Pro, then Try again. Or export a .glb.' },
    { problem: '“This file is over 300 MB”', fix: 'Make a lighter copy: fewer triangles and 2K textures. Then try again.' },
    { problem: 'It moves as one piece', fix: 'It has no skeleton yet. With VTube Pro, we add one after you save it.' },
    { problem: 'The mouth or eyes don’t move', fix: 'Pick Set it up for me: it adds mouth shapes and fixes painted-on eyes.' },
  ],
};

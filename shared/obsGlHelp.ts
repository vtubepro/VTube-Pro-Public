// What to tell someone whose OBS can't draw VTube Pro (no WebGL 2 in OBS's browser: OBS on its OpenGL renderer on
// Windows, browser source hardware acceleration switched off, very old graphics drivers). Used by the OBS page's own
// card (src/outputNoGl.ts) and the "Fix it" doctor's OBS row. Pure.
export const OBS_GL_TITLE = 'VTube Pro can’t draw here';

/** The steps, in order, for the OS of this browser (OBS's own browser reports its OS in the user agent). */
export function obsGlSteps(ua: string): string[] {
  const win = /Windows/.test(ua), mac = /Mac OS X|Macintosh/.test(ua);
  return [
    ...(win ? ['In OBS, open Settings → Advanced and set Renderer to Direct3D 11.'] : []),
    'In OBS, open Settings → Advanced → Sources and tick “Enable Browser Source Hardware Acceleration”.',
    win || mac ? 'Restart OBS.' : 'Restart OBS. If it still shows this, update your graphics drivers.',
  ];
}

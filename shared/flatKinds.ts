// Every 2D-avatar kind's SHARED module (import checks, config sanitising) is imported here once, so the server's import
// route and the studio see the same importers (shared/flatImport.ts registerFlatImporter). 'png' is built in.
// Other kinds add ONE import line below (their module calls registerFlatImporter on load):
//   import './live2dImport.ts';
import './rig2d/importers.ts'; // Live2D zips → VTube Pro rigs (.vtp2), .vtp2 files (live2d lane)
export {};

// Registry of capture-cover styles (src/scene/capcover/*). The VTube Pro set ships with the engine.
import type { CoverStyleDef } from './kit.ts';
import { VTP_COVERS } from './stylesVtp.ts';

export const COVER_STYLES: CoverStyleDef[] = [...VTP_COVERS];

export function coverStyle(id: string): CoverStyleDef {
  return COVER_STYLES.find((s) => s.id === id) ?? COVER_STYLES.find((s) => s.id === 'cc-cartridge') ?? COVER_STYLES[0];
}

// The room a first-time user starts in (pure: tools/autopilot_unit.ts). Used by src/ui/autopilot/firstRun.ts + doctor.ts.
/** The studio room if this helper has it, else a lounge / hangout, else the first room that isn't a test room. */
export function starterRoom(scenes: { id: string; name?: string }[]): string | null {
  const ok = scenes.filter((s) => !/test|grey ?box|sandbox|yard/i.test(`${s.id} ${s.name ?? ''}`));
  return (scenes.find((s) => s.id === 'vtubepro_studio') ?? ok.find((s) => /studio|lounge|hangout/i.test(`${s.id} ${s.name ?? ''}`)) ?? ok[0] ?? null)?.id ?? null;
}

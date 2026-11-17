// The agent file check ("vtp-check"): what an AI agent (Claude, ChatGPT / Codex, Gemini, Grok, Cursor …) runs on a
// file it made, BEFORE it hands it to the user, to know whether VTube Pro will take it as it is. One verdict, then one
// line per topic, each problem with the exact fix. It reuses the studio's own readers and checks (the drop importer's
// report, the 2D avatar maker's PSD reader + layer classifier, the Live2D converter + auto mapping, the "Add my room"
// check), so what it says is what the studio will do; on top it holds AI-made work to the stricter "right the first
// time" bar of docs/AGENT_GUIDE.md (a performer may forgive an auto-fix; an agent should not need one).
// Pure (no node: / DOM): tools/vtp_check.ts reads the files, server/mcpTools.ts `check_creation` runs that CLI.

export type CheckKind = 'avatar3d' | 'room3d' | 'pro2d-psd' | 'pro2d-pictures' | 'live2d' | 'inochi2d' | 'vtp2' | 'pngtuber' | 'flat2d-room';
export const CHECK_KINDS: readonly CheckKind[] = ['avatar3d', 'room3d', 'pro2d-psd', 'pro2d-pictures', 'live2d', 'inochi2d', 'vtp2', 'pngtuber', 'flat2d-room'];

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface CheckItem {
  /** Stable id (the rule), e.g. "skeleton", "face.arkit", "psd.eyes". */
  id: string;
  level: CheckLevel;
  /** What was found, one plain sentence. */
  what: string;
  /** What to change (for the agent: exact names, numbers, export settings). */
  fix?: string;
  /** Where the rule is explained: an AGENT_GUIDE.md section anchor or another guide. */
  doc?: string;
}

export interface CheckResult {
  format: 'vtube-pro.check/1';
  kind: CheckKind;
  /** pass = ship it; warn = it works, but read the warnings; fail = VTube Pro will refuse it or it will look broken. */
  verdict: 'pass' | 'warn' | 'fail';
  summary: string;
  file: string;
  items: CheckItem[];
  /** Measured facts (numbers, names), for the agent's own reasoning. */
  facts: Record<string, unknown>;
}

/** One input file: a path relative to the dropped folder / zip ('/' separators) and its bytes. */
export interface CheckFile { path: string; bytes: Uint8Array }

export function verdictOf(items: readonly CheckItem[]): CheckResult['verdict'] {
  return items.some((i) => i.level === 'error') ? 'fail' : items.some((i) => i.level === 'warn') ? 'warn' : 'pass';
}

export function finish(kind: CheckKind, file: string, items: CheckItem[], facts: Record<string, unknown>, what: string): CheckResult {
  const verdict = verdictOf(items);
  const n = (l: CheckLevel) => items.filter((i) => i.level === l).length;
  const summary = verdict === 'pass' ? `${what}: ready for VTube Pro.`
    : verdict === 'warn' ? `${what}: VTube Pro will take it, but fix ${n('warn')} warning${n('warn') === 1 ? '' : 's'} for a first-time-right result.`
      : `${what}: ${n('error')} problem${n('error') === 1 ? '' : 's'} to fix before handing it over.`;
  return { format: 'vtube-pro.check/1', kind, verdict, summary, file, items, facts };
}

const G = 'docs/AGENT_GUIDE.md';
/** Guide anchors used in `doc` (kept in one place so a renamed heading is one edit). */
export const DOC = {
  avatar3d: `${G}#3-3d-avatars-vrm--glb`,
  avatarFailures: `${G}#10-failure-modes-symptom--cause--fix`,
  pro2dPsd: `${G}#4-pro2d-from-a-layered-psd`,
  live2d: `${G}#5-live2d-and-inochi2d-models`,
  pngtuber: `${G}#6-pngtuber-picture-sets`,
  room3d: `${G}#7-3d-rooms`,
  flat2d: `${G}#8-2d-rooms-and-25d-overlays`,
} as const;

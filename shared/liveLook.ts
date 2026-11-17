// live-layout: the LOOK of the screen hider (style, words) and of the BRB card (animation, theme, words, your own
// picture / video) — picked in Live → Privacy.
//
// In the studio the look is set on the studio's own scene state (the studio owns the scene; every trigger — the button,
// Ctrl+B / your key, Shift+4, Ctrl+K, Stream Deck, the OBS dock — keeps the style that is in it) and read back from it.
// The pop-out goes through the server's Stream Deck action planner (cover / brb-card runs) and reads the look from the
// live state. Nothing falls back silently: every failure is shown next to the picker.
import { DEFAULT_CAPCOVER, cleanCoverText, isCoverStyle } from './capcover.ts';
import { BRB_STYLES, DEFAULT_BRB, cleanBrbText, isBrbStyle } from './brb.ts';

export interface LiveLook {
  coverStyle: string;
  coverText: string;
  brbStyle: string;
  brbTheme: 'dark' | 'light';
  brbText: string;
  /** '' | 'image:<rev>' | 'video:<rev>' */
  brbBg: string;
}
/** A change: only the fields given. brbBg 'none' = back to the theme's own background. */
export type LookPatch = Partial<LiveLook>;

export const DEFAULT_LOOK: LiveLook = { coverStyle: DEFAULT_CAPCOVER.style, coverText: '', brbStyle: DEFAULT_BRB.style, brbTheme: 'dark', brbText: '', brbBg: '' };

const bgStr = (bg: unknown): string => {
  const b = (bg && typeof bg === 'object' ? bg : null) as { kind?: unknown; rev?: unknown } | null;
  return b && (b.kind === 'image' || b.kind === 'video') && Number(b.rev) > 0 ? `${b.kind}:${Math.round(Number(b.rev))}` : '';
};
/** The look in a scene state (SceneState.capcover / .brb). */
export function lookOfScene(s: { capcover?: unknown; brb?: unknown } | null | undefined): LiveLook {
  const c = (s?.capcover && typeof s.capcover === 'object' ? s.capcover : {}) as Record<string, unknown>;
  const b = (s?.brb && typeof s.brb === 'object' ? s.brb : {}) as Record<string, unknown>;
  return {
    coverStyle: isCoverStyle(c.style) ? c.style : DEFAULT_LOOK.coverStyle, coverText: cleanCoverText(c.text),
    brbStyle: isBrbStyle(b.style) ? b.style : DEFAULT_LOOK.brbStyle, brbTheme: b.theme === 'light' ? 'light' : 'dark', brbText: cleanBrbText(b.text), brbBg: bgStr(b.bg),
  };
}

/** The look as the server reports it in its live state (null = not reported yet). */
export function lookOfLive(live: { coverStyle?: string; coverText?: string; brbStyle?: string; brbTheme?: string; brbText?: string; brbBg?: string } | null | undefined): LiveLook | null {
  if (!live || typeof live.coverStyle !== 'string' || typeof live.brbStyle !== 'string') return null;
  return { coverStyle: live!.coverStyle!, coverText: live!.coverText ?? '', brbStyle: live!.brbStyle!, brbTheme: live!.brbTheme === 'light' ? 'light' : 'dark', brbText: live!.brbText ?? '', brbBg: live!.brbBg ?? '' };
}

/** Check a change. Returns the clean patch or the reason it can't be used. */
export function cleanLookPatch(p: LookPatch): { ok: true; patch: LookPatch } | { ok: false; error: string } {
  const out: LookPatch = {};
  if (p.coverStyle !== undefined) { if (!isCoverStyle(p.coverStyle)) return { ok: false, error: 'That hider animation doesn’t exist.' }; out.coverStyle = p.coverStyle; }
  if (p.coverText !== undefined) out.coverText = cleanCoverText(p.coverText);
  if (p.brbStyle !== undefined) { if (!isBrbStyle(p.brbStyle)) return { ok: false, error: 'That BRB animation doesn’t exist.' }; out.brbStyle = p.brbStyle; }
  if (p.brbTheme !== undefined) { if (p.brbTheme !== 'dark' && p.brbTheme !== 'light') return { ok: false, error: 'The theme is Dark or Light.' }; out.brbTheme = p.brbTheme; }
  if (p.brbText !== undefined) out.brbText = cleanBrbText(p.brbText);
  if (p.brbBg !== undefined) { if (p.brbBg !== '' && p.brbBg !== 'none' && !/^(image|video):\d{1,16}$/.test(p.brbBg)) return { ok: false, error: 'That picture didn’t save. Try again.' }; out.brbBg = p.brbBg; }
  return Object.keys(out).length ? { ok: true, patch: out } : { ok: false, error: 'Nothing to change.' };
}

/** The studio's scene command for a change (controller.command): never turns the cover or BRB on / off. */
export function lookToSceneArgs(p: LookPatch): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (p.coverStyle !== undefined || p.coverText !== undefined) a.cover = { ...(p.coverStyle !== undefined ? { style: p.coverStyle } : {}), ...(p.coverText !== undefined ? { text: p.coverText } : {}) };
  if (p.brbStyle !== undefined || p.brbTheme !== undefined || p.brbText !== undefined || p.brbBg !== undefined) {
    const m = p.brbBg ? /^(image|video):(\d+)$/.exec(p.brbBg) : null;
    a.brb = { ...(p.brbStyle !== undefined ? { style: p.brbStyle } : {}), ...(p.brbTheme !== undefined ? { theme: p.brbTheme } : {}), ...(p.brbText !== undefined ? { text: p.brbText } : {}),
      ...(p.brbBg === 'none' || p.brbBg === '' ? { bg: null } : m ? { bg: { kind: m[1], rev: Number(m[2]) } } : {}) };
  }
  return a;
}

/** The same change as Stream Deck registry actions. `on: 'keep'` never toggles the cover. */
export function lookToDeckRuns(p: LookPatch): { action: string; params: Record<string, string> }[] {
  const runs: { action: string; params: Record<string, string> }[] = [];
  if (p.coverStyle !== undefined || p.coverText !== undefined) runs.push({ action: 'cover', params: { on: 'keep', ...(p.coverStyle !== undefined ? { style: p.coverStyle } : {}), ...(p.coverText !== undefined ? { text: p.coverText || ' ' } : {}) } });
  if (p.brbStyle !== undefined || p.brbTheme !== undefined || p.brbText !== undefined || p.brbBg !== undefined)
    runs.push({ action: 'brb-card', params: { theme: p.brbTheme ?? 'keep', ...(p.brbStyle !== undefined ? { style: p.brbStyle } : {}), ...(p.brbText !== undefined ? { text: p.brbText || ' ' } : {}), ...(p.brbBg !== undefined ? { bg: p.brbBg || 'none' } : {}) } });
  return runs;
}

/** Did the change land? (read back after setting) — the fields that didn't, in plain words. */
export function lookMissed(want: LookPatch, got: LiveLook): string[] {
  const miss: string[] = [];
  if (want.coverStyle !== undefined && got.coverStyle !== want.coverStyle) miss.push('hider animation');
  if (want.coverText !== undefined && got.coverText !== cleanCoverText(want.coverText)) miss.push('hider words');
  if (want.brbStyle !== undefined && got.brbStyle !== want.brbStyle) miss.push('BRB animation');
  if (want.brbTheme !== undefined && got.brbTheme !== want.brbTheme) miss.push('BRB theme');
  if (want.brbText !== undefined && got.brbText !== cleanBrbText(want.brbText)) miss.push('BRB words');
  if (want.brbBg !== undefined && got.brbBg !== (want.brbBg === 'none' ? '' : want.brbBg)) miss.push('BRB picture');
  return miss;
}

/** "Using: Jacking in" / "Using: Light · Bouncing dots". */
export const brbStyleName = (id: string) => BRB_STYLES.find((s) => s.id === id)?.name ?? id;
export function brbUsing(l: LiveLook): string {
  return `${l.brbTheme === 'light' ? 'Light' : 'Dark'} · ${brbStyleName(l.brbStyle)}${l.brbBg ? ` · your ${l.brbBg.startsWith('video') ? 'video' : 'picture'}` : ''}`;
}

/** Where a look change goes: the studio's own scene state; the server's action planner; or nowhere, with the reason to show. */
export type LookRoute = { via: 'studio' } | { via: 'helper' } | { via: 'none'; error: string };
export function lookRoute(o: { studio: boolean; online: boolean; live: { coverStyle?: unknown; brbStyle?: unknown } | null | undefined }): LookRoute {
  if (o.studio) return { via: 'studio' };
  if (!o.online) return { via: 'none', error: 'Not connected to VTube Pro. Is it running?' };
  return { via: 'helper' };
}

/** The studio's scene command, look part (src/scene/controller.ts command uses these, the tests too). */
export function coverArgsPatch(cv: Record<string, unknown>, curOn: boolean): { on?: boolean; style?: string; text?: string } {
  const p: { on?: boolean; style?: string; text?: string } = {};
  if (isCoverStyle(cv.style)) p.style = cv.style;
  if (typeof cv.text === 'string') p.text = cleanCoverText(cv.text);
  if (typeof cv.on === 'boolean') p.on = cv.on; else if (cv.on === 'toggle') p.on = !curOn;
  return p;
}
export function brbArgsMerge(cur: Record<string, unknown>, bb: Record<string, unknown>): Record<string, unknown> {
  return { ...cur, ...(isBrbStyle(bb.style) ? { style: bb.style } : {}), ...(bb.theme === 'light' || bb.theme === 'dark' ? { theme: bb.theme } : {}), ...(typeof bb.text === 'string' ? { text: bb.text } : {}), ...('bg' in bb ? { bg: bb.bg } : {}) };
}

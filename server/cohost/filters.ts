// AI co-host (docs/b16/COHOST.md): everything that decides WHAT may go in and WHAT may come out. PURE (no network, no files):
// tools/cohost_unit.ts drives it with lists of nasty, sneaky and ordinary lines.
//
//   in   a viewer's line is answered only if it is visible chat (never a hidden, deleted or banned line, never a command or
//        a bot), is not rude (profanity / slurs / spelled-out versions of them) and is not an attempt to re-program the AI;
//   out  the model's reply is cleaned (no thinking text, no links, no pings, no markdown), cut to a short spoken size and
//        DROPPED, not bleeped, if it holds a slur, profanity or one of the streamer's banned words. A dropped reply is
//        never retried with the same text and never shown or spoken.
// This is a word list and some patterns, not a moderator: the streamer's own banned words and the reply-rate cap sit on top.
import { CHAT_BOTS, chatVisible, type ChatEvent, type SceneChatState } from '../../shared/chat.ts';
import { CHEER_MOODS, COHOST_LIMITS, COHOST_MOODS, COHOST_REACTIONS, type CohostMood, type CohostPersona, type CohostReaction } from './config.ts';

// ---------------------------------------------------------------- word lists (English; conservative)
/** Slurs: a reply holding one is dropped and a line holding one is never answered. */
const SLURS = ['nigger', 'nigga', 'faggot', 'fag', 'dyke', 'tranny', 'retard', 'retarded', 'spic', 'chink', 'kike', 'gook', 'wetback', 'coon', 'paki', 'beaner', 'raghead', 'towelhead'];
/** Profanity and "go hurt yourself" phrases. */
const PROFANE = ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'cunt', 'asshole', 'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard', 'twat', 'wanker', 'kys', 'rape', 'rapist', 'molest', 'porn', 'nazi', 'hitler', 'suicide'];
const wordRe = (list: readonly string[]) => new RegExp(`(?<![a-z])(${list.join('|')})(s|es|ed|er|ers|ing)?(?![a-z])`, 'i');
const SLUR_RE = wordRe(SLURS);
const PROFANE_RE = wordRe(PROFANE);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '+': 't' };

/** Lower case, look-alike digits and symbols turned into letters, accents and zero-width characters gone, "fuuuuck" -> "fuuck". */
export function normalizeForFilter(s: string): string {
  let t = s.normalize('NFKD').replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff\u00ad]/g, '').toLowerCase();
  t = t.replace(/[013457@$+]/g, (c) => LEET[c] ?? c).replace(/(?<=[a-z])[!|](?=[a-z])/g, 'i');   // ("fuck!" keeps its "!"; "sh!t" becomes "shit")
  return t.replace(/([a-z])\1{2,}/g, '$1$1');
}
/** "f u c k" / "f.u.c.k" -> "fuck": a run of single letters joined into one word. */
function joinSpelled(t: string): string {
  return t.replace(/(?<![a-z])([a-z])(?:[\s._*-]+[a-z](?![a-z])){2,}/g, (m) => m.replace(/[^a-z]/g, ''));
}
/** A forms-of-the-word check that also catches "fuuuck" (collapsed to "fuuck" -> try the double-letter forms too). */
function variants(text: string): string[] {
  const n = normalizeForFilter(text);
  const v = new Set([n, joinSpelled(n), n.replace(/([a-z])\1/g, '$1')]);
  return [...v];
}
export const hasSlur = (text: string) => variants(text).some((t) => SLUR_RE.test(t));
export const hasProfanity = (text: string) => variants(text).some((t) => PROFANE_RE.test(t));

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|gg|tv|io|ly|me|co|xyz|live|link|app|dev|ai)(?:\/\S*)?\b/i;
export const hasLink = (text: string) => URL_RE.test(text);
/** Re-programming attempts: "ignore your instructions", "you are now", role tags, "system prompt". */
const INJECTION_RE = /\b(?:ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(?:instruction|prompt|rule|persona|previous|prior|above|system|filter|guideline)s?\b|\b(?:system|developer|assistant)\s*(?:prompt|message|mode|:)|\byou are now\b|\bnew (?:persona|instructions?|rules?)\b|\bjailbreak\b|\bdan mode\b|\brepeat (?:your|the) (?:prompt|instructions)\b|\breveal (?:your|the) (?:prompt|instructions)\b|\bact as (?:if|an? )/i;
export const looksLikeInjection = (text: string) => INJECTION_RE.test(text);

// ---------------------------------------------------------------- what a viewer line may be
export type InVerdict = { ok: true; text: string } | { ok: false; why: 'hidden' | 'command' | 'bot' | 'rude' | 'injection' | 'empty' | 'test' | 'not chat' };

const isBot = (e: ChatEvent) => CHAT_BOTS.includes(e.user.toLowerCase());
/** Is this a line the co-host may read at all? Visible chat only: the scene's "hide commands / bots", the "Hide chat" switch
 *  and moderator removals all apply. `chat` null = the studio has not saved a scene yet (nothing is hidden then). */
export function readable(e: ChatEvent, chat: Pick<SceneChatState, 'hideBots' | 'hideCommands' | 'bots' | 'hidden'> | null): InVerdict | null {
  if (e.kind !== 'chat') return { ok: false, why: 'not chat' };
  if (e.test) return { ok: false, why: 'test' };
  if (e.cue) return { ok: false, why: 'not chat' };
  if (chat?.hidden) return { ok: false, why: 'hidden' };
  if (/^\s*[!/]\w/.test(e.text)) return { ok: false, why: 'command' };
  if (isBot(e) || (chat?.bots ?? []).includes(e.user.toLowerCase())) return { ok: false, why: 'bot' };
  const st = { hideBots: true, hideCommands: true, bots: [], ...(chat ?? {}) } as SceneChatState;
  if (!chatVisible(e, st)) return { ok: false, why: 'hidden' };
  return null;
}

/** A viewer's words made safe to hand to the model: no control characters, links, pings or emote spam, short. */
export function cleanViewerText(text: string, max = 200): string {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(URL_RE, 'link').replace(/(.)\1{4,}/g, '$1$1$1').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** May this viewer text go to the model? `text` is the cleaned version to send. */
export function checkViewer(raw: string, persona?: Pick<CohostPersona, 'banned'>): InVerdict {
  const text = cleanViewerText(raw);
  if (!text) return { ok: false, why: 'empty' };
  if (hasSlur(text) || hasProfanity(text)) return { ok: false, why: 'rude' };
  if (persona && hasBanned(text, persona.banned)) return { ok: false, why: 'rude' };
  if (looksLikeInjection(text)) return { ok: false, why: 'injection' };
  return { ok: true, text };
}

const QUESTION_START = /^(?:who|what|whats|what's|why|how|when|where|which|is|are|am|do|does|did|can|could|should|would|will|has|have|any|anyone|tell me)\b/i;
/** A real question: ends in "?" with a few words, or starts like one. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 2) return false;
  if (/\?\s*$/.test(t) || /\?\s/.test(t)) return words >= 2;
  return words >= 4 && QUESTION_START.test(t);
}
/** The co-host's name said in the line: "@Buddy", "hey buddy". The name is matched as whole words, case and accents ignored
 *  ("Mr Buddy" needs both words in a row; a name of one letter never matches). */
export function mentionsName(text: string, name: string): boolean {
  const words = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f\u200b-\u200f\ufeff]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const want = words(name);
  if (!want.length || want.join('').length < 2) return false;
  const have = words(text);
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, j) => have[i + j] === w)) return true;
  return false;
}

// ---------------------------------------------------------------- what a reply may be
export function hasBanned(text: string, banned: readonly string[]): boolean {
  if (!banned.length) return false;
  const squash = (s: string) => normalizeForFilter(s).replace(/[^a-z0-9]/g, '');
  const flat = squash(text);
  const words = ` ${normalizeForFilter(text).replace(/[^a-z0-9]+/g, ' ')} `;
  for (const b of banned) {
    const k = squash(b);
    if (!k) continue;
    // a phrase or a short word must match as whole words; a long word also inside other words ("assistance" is fine, "f-word" is not)
    if (words.includes(` ${normalizeForFilter(b).replace(/[^a-z0-9]+/g, ' ').trim()} `)) return true;
    if (k.length >= 6 && flat.includes(k)) return true;
  }
  return false;
}

export interface OutOk { ok: true; text: string; mood: CohostMood; reactions: CohostReaction[] }
export interface OutNo { ok: false; why: 'empty' | 'rude' | 'banned' | 'link' | 'leak' | 'refusal' }
const MOOD_TAG = /^\s*\[(neutral|happy|excited|curious|sad|sarcastic)\]\s*/i;
const REACT_TAG = /\[react:\s*([a-z]+)\]/gi;
const LEAK_RE = /\b(?:system prompt|my instructions|as an ai(?: language model)?|i am an ai language model|i('| a)m (?:just )?a language model|untrusted|viewer says)\b/i;
const REFUSAL_RE = /^(?:i('| a)m sorry|sorry,|i can(?:no|')t (?:help|assist|comply|do that)|i cannot (?:help|assist|comply))/i;

/** Cut at the last sentence end inside `max`, else at a word. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= max * 0.45) return cut.slice(0, end + 1).trim();
  return cut.replace(/\s+\S*$/, '').replace(/[,;:\-\s]+$/, '').trim() + '…';
}

/** The model's raw reply -> one short sentence or two to say, or the reason it was dropped. */
export function checkReply(raw: string, persona: Pick<CohostPersona, 'name' | 'banned'>, allowed: readonly CohostReaction[] = []): OutOk | OutNo {
  let t = String(raw ?? '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ').replace(/<think(?:ing)?>[\s\S]*$/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const reactions: CohostReaction[] = [];
  t = t.replace(REACT_TAG, (_m, k: string) => { const r = k.toLowerCase() as CohostReaction; if ((COHOST_REACTIONS as readonly string[]).includes(r) && allowed.includes(r) && !reactions.includes(r)) reactions.push(r); return ' '; });
  t = t.replace(/\s+/g, ' ').trim();
  // "Buddy: ..." / quotes / a leading mood tag
  const nm = persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t = t.replace(new RegExp(`^(?:${nm}|co-?host|assistant)\\s*[:\\-]\\s*`, 'i'), '');
  let mood: CohostMood = 'neutral';
  const mt = MOOD_TAG.exec(t);
  if (mt) { mood = mt[1].toLowerCase() as CohostMood; t = t.slice(mt[0].length); }
  t = t.replace(/^["“'`]+|["”'`]+$/g, '').replace(/[*_#~>]+/g, '').replace(/@(?:everyone|here|channel)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (REFUSAL_RE.test(t)) return { ok: false, why: 'refusal' };
  if (LEAK_RE.test(t)) return { ok: false, why: 'leak' };
  if (hasLink(t)) return { ok: false, why: 'link' };
  if (hasSlur(t) || hasProfanity(t)) return { ok: false, why: 'rude' };
  if (hasBanned(t, persona.banned)) return { ok: false, why: 'banned' };
  if (!(COHOST_MOODS as readonly string[]).includes(mood)) mood = 'neutral';
  return { ok: true, text: clip(t, COHOST_LIMITS.replyMaxChars), mood, reactions };
}

/** Does this mood make the chat buddy cheer? */
export const cheers = (m: CohostMood) => CHEER_MOODS.includes(m);

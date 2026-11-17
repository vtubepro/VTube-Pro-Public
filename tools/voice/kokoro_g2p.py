"""Text -> Kokoro phonemes, with no GPL anywhere.

Kokoro's own front end (misaki[en]) falls back to espeak-ng (GPL-3) for words its dictionary lacks, and drags in
phonemizer (GPL-3) and espeakng-loader to do it. VTube Pro must not ship or download that, so this is a small
dictionary G2P over misaki's own gold / silver American-English pronunciation dictionaries (misaki, Apache-2.0; the two
JSON files are unpacked from the pinned misaki wheel by voice_setup.ts, misaki itself is not installed):

  * known words (and their -s / -ed / -ing forms) come from the dictionaries, in misaki's phoneme alphabet, which is
    exactly Kokoro's vocabulary;
  * numbers are spoken as words ("42" -> forty two);
  * a name the dictionaries lack ("NightOwl42", "pixel_pioneer") is split at case / digit / underscore boundaries and
    each piece looked up; a piece still unknown is spelled out letter by letter (so a viewer's name is never dropped);
  * punctuation Kokoro knows is kept (it shapes the pauses); everything else (emoji, markup) is dropped.

Quality note: no part-of-speech tagging, so heteronyms ("read", "lead") get the dictionary's default reading.
"""
from __future__ import annotations

import re
import unicodedata

from translit import ascii_fold, roman_phonemes, runs, to_latin

# letter names in misaki's alphabet, used only when a dictionary has no entry for the single letter
LETTER_NAMES = {
    'a': 'ˈA', 'b': 'bˈi', 'c': 'sˈi', 'd': 'dˈi', 'e': 'ˈi', 'f': 'ˈɛf', 'g': 'ʤˈi', 'h': 'ˈAʧ', 'i': 'ˈI', 'j': 'ʤˈA', 'k': 'kˈA',
    'l': 'ˈɛl', 'm': 'ˈɛm', 'n': 'ˈɛn', 'o': 'ˈO', 'p': 'pˈi', 'q': 'kjˈu', 'r': 'ˈɑɹ', 's': 'ˈɛs', 't': 'tˈi', 'u': 'jˈu', 'v': 'vˈi',
    'w': 'dˈʌbᵊlju', 'x': 'ˈɛks', 'y': 'wˈI', 'z': 'zˈi',
}
ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
        'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
SCALES = [(10**9, 'billion'), (10**6, 'million'), (10**3, 'thousand')]
SYMBOL_WORDS = {'&': 'and', '+': 'plus', '%': 'percent', '@': 'at', '#': 'number', '$': 'dollars', '=': 'equals'}
PUNCT = set(';:,.!?—…"()“”')
# a word in ANY script (Unicode letters), a number, or one symbol / punctuation mark (emoji land here and are ignored)
TOKEN = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*|\d+(?:[.,]\d+)*|[^\s\w]")
PUNCT_MAP = str.maketrans({'。': '.', '、': ',', '「': '"', '」': '"', '『': '"', '』': '"', '・': ' ', '〜': ' ', '～': ' ', '‘': "'", '’': "'", '‚': ',', '„': '"', '«': '"', '»': '"'})
SPLIT = re.compile(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+')


def number_words(n: int) -> list[str]:
    if n < 0:
        return ['minus'] + number_words(-n)
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n < 1000:
        return [ONES[n // 100], 'hundred'] + (number_words(n % 100) if n % 100 else [])
    if 1900 <= n <= 1999 or 2010 <= n <= 2099:   # years: "twenty twenty six"
        hi, lo = n // 100, n % 100
        return number_words(hi) + (number_words(lo) if lo >= 10 else (['oh', ONES[lo]] if lo else ['hundred']))
    for size, name in SCALES:
        if n >= size:
            return number_words(n // size) + [name] + (number_words(n % size) if n % size else [])
    return [str(n)]


def speak_number(tok: str) -> list[str]:
    t = tok.replace(',', '')
    if '.' in t:
        a, _, b = t.partition('.')
        return (number_words(int(a)) if a else ['zero']) + ['point'] + [ONES[int(c)] for c in b if c.isdigit()]
    return number_words(int(t)) if len(t) <= 12 else [ONES[int(c)] for c in t]


class G2P:
    def __init__(self, gold: dict, silver: dict, vocab: set[str]):
        self.gold, self.silver, self.vocab = gold, silver, vocab

    # ------------------------------------------------------------------ dictionary
    def _entry(self, w: str) -> str | None:
        for d in (self.gold, self.silver):
            v = d.get(w)
            if isinstance(v, dict):
                v = v.get('DEFAULT') or next((x for x in v.values() if x), None)
            if v:
                return v
        return None

    @staticmethod
    def _s(stem: str) -> str:
        if stem[-1] in 'ptkfθ':
            return stem + 's'
        if stem[-1] in 'szʃʒʧʤ':
            return stem + 'ᵻz'
        return stem + 'z'

    @staticmethod
    def _ed(stem: str) -> str:
        if stem[-1] in 'pkfθʃsʧ':
            return stem + 't'
        if stem[-1] in 'dt':
            return stem + 'ᵻd'
        return stem + 'd'

    def word(self, w: str) -> str | None:
        """Phonemes of one lower-case word, or None."""
        w = w.lower().replace('’', "'")
        p = self._entry(w)
        if p:
            return p
        if len(w) >= 3 and w.endswith('s'):                                   # plurals, 3rd person, possessives
            for cut, ok in ((1, not w.endswith('ss')), (2, w.endswith("'s") or (len(w) > 4 and w.endswith('es') and not w.endswith('ies')))):
                if ok:
                    st = self._entry(w[:-cut])
                    if st:
                        return self._s(st)
            if len(w) > 4 and w.endswith('ies'):
                st = self._entry(w[:-3] + 'y')
                if st:
                    return self._s(st)
        if len(w) >= 4 and w.endswith('d'):                                    # -ed
            for cut in (1, 2):
                if (cut == 1 and not w.endswith('dd')) or (cut == 2 and len(w) > 4 and w.endswith('ed') and not w.endswith('eed')):
                    st = self._entry(w[:-cut])
                    if st:
                        return self._ed(st)
            if len(w) > 5 and re.search(r'([bcdgklmnprstvxz])\1ed$', w):      # stopped -> stop
                st = self._entry(w[:-3])
                if st:
                    return self._ed(st)
        if len(w) >= 5 and w.endswith('ing'):                                  # -ing
            for stem in (w[:-3], w[:-3] + 'e', w[:-4] if re.search(r'([bcdgklmnprstvxz])\1ing$', w) else ''):
                st = self._entry(stem) if len(stem) >= 2 else None
                if st:
                    return st + 'ɪŋ'
        if len(w) >= 4 and w.endswith('ly'):
            st = self._entry(w[:-2])
            if st:
                return st + 'li'
        if "'" in w:                                                          # contractions the dictionaries lack
            base, _, suf = w.partition("'")
            tail = {'m': 'm', 'll': 'ᵊl', 've': 'ᵊv', 're': 'ɚ', 'd': 'd'}.get(suf)
            st = self._entry(base) if tail else None
            if st:
                return st + tail
        return None

    def spell(self, w: str) -> str:
        out = []
        for c in w.lower():
            if c.isalpha() and c.isascii():
                out.append(LETTER_NAMES.get(c, ''))
            elif c.isdigit():
                out.extend(self.phonemes(ONES[int(c)])[0:1])
        return ' '.join(x for x in out if x)

    def name_part(self, piece: str, unknown: list[str]) -> str:
        p = self.word(piece)
        if p:
            return p
        # glued words ("pixelpioneer"): the longest dictionary prefix, then the rest
        n = len(piece)
        for i in range(n - 2, 2, -1):
            a, b = self.word(piece[:i]), self.word(piece[i:]) if n - i >= 3 else None
            if a and b:
                return f'{a} {b}'
        unknown.append(piece)
        return self.spell(piece)

    # ------------------------------------------------------------------ text
    def phonemes(self, text: str) -> tuple[str, list[str]]:
        """-> (phoneme string, words that had to be spelled out)"""
        ph, unknown, _skipped = self.speak(text)
        return ph, unknown

    def _latin(self, tok: str, out: list[str], unknown: list[str]) -> None:
        tok = tok.strip("'")
        if not tok:
            return
        p = self.word(tok)
        if p:
            out.append(p)
            return
        pieces = SPLIT.findall(tok.replace("'", ''))
        if len(pieces) > 1 or tok != tok.lower():
            out.extend(self.name_part(x, unknown) if not x.isdigit() else ' '.join(self.word(y) or '' for y in speak_number(x)) for x in pieces)
        else:
            out.append(self.name_part(tok, unknown))

    def speak(self, text: str) -> tuple[str, list[str], list[str]]:
        """-> (phonemes, words spelled out letter by letter, words skipped because no table speaks them: Han, Hangul, emoji
        words ...). Accented Latin is folded (José -> Jose); kana, Cyrillic and Greek are romanised and read by letter rules
        (translit.py); a token that mixes scripts is split into runs. Emoji and symbols are ignored."""
        unknown: list[str] = []
        skipped: list[str] = []
        out: list[str] = []
        text = unicodedata.normalize('NFKC', text).translate(PUNCT_MAP)
        for tok in TOKEN.findall(text):
            if tok[0].isdecimal():
                out.extend(self.word(x) or self.spell(x) for x in speak_number(tok))
            elif tok[0].isalpha():
                for script, run in runs(tok):
                    if script == 'latin':
                        self._latin(ascii_fold(run), out, unknown)
                        continue
                    lat = to_latin(script, run)
                    ph = roman_phonemes(lat) if lat else ''
                    if ph:
                        out.append(ph)
                    else:
                        skipped.append(run)
            elif tok in SYMBOL_WORDS:
                out.append(self.word(SYMBOL_WORDS[tok]) or '')
            elif tok in PUNCT:
                if out and not out[-1].endswith((' ',)):
                    out.append('\x00' + tok)       # punctuation sticks to the word before it
            # anything else (emoji, dashes, markup characters): ignored
        s = ''
        for x in out:
            if x.startswith('\x00'):
                s += x[1:]
            elif x:
                s += (' ' if s and not s.endswith(' ') else '') + x
        s = re.sub(r' +', ' ', s).strip()
        s = ''.join(c for c in s if c in self.vocab)       # nothing Kokoro does not know
        if not any(c not in ' ;:,.!?—…"()“”' for c in s):  # only punctuation left = nothing was said
            s = ''
        return s, unknown, skipped


def chunk(phonemes: str, limit: int = 400) -> list[str]:
    """Split at sentence ends, then at spaces, so each piece fits Kokoro's 510-token context."""
    if len(phonemes) <= limit:
        return [phonemes] if phonemes else []
    parts, cur = [], ''
    for sent in re.split(r'(?<=[.!?…])\s+', phonemes):
        if len(cur) + len(sent) + 1 <= limit:
            cur = f'{cur} {sent}'.strip()
            continue
        if cur:
            parts.append(cur)
        cur = ''
        while len(sent) > limit:
            cut = sent.rfind(' ', 0, limit)
            cut = cut if cut > 40 else limit
            parts.append(sent[:cut].strip())
            sent = sent[cut:].strip()
        cur = sent
    if cur:
        parts.append(cur)
    return parts

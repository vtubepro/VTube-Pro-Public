"""Non-English names and lines for the Kokoro alert voice, with our own small tables (written for this project; no
dictionary, no GPL, nothing downloaded):

  * accents are folded to plain letters (José -> Jose, Zoë -> Zoe, Łukasz -> Lukasz, straße -> strasse);
  * kana -> romaji (Hepburn: ナイト -> naito, しゃ -> sha, っ doubles, ー lengthens), Cyrillic -> Latin (Привет -> privet),
    Greek -> Latin (Αλέξης -> alexis);
  * romanised text is turned into rough Kokoro phonemes by plain letter rules (roman_phonemes): the way an English
    speaker would read "naito" or "privet", which is what a viewer's name needs on an alert;
  * any other script (Han, Hangul, Arabic, Thai ...) and emoji have no table here: script_of() says 'other' and the caller
    skips that word silently.
"""
from __future__ import annotations

import unicodedata

# ---------------------------------------------------------------------------------------------- scripts
KANA = [(0x3041, 0x3096), (0x309D, 0x309F), (0x30A1, 0x30FA), (0x30FC, 0x30FF), (0x31F0, 0x31FF)]


def script_of(ch: str) -> str:
    """'latin' | 'cyrillic' | 'greek' | 'kana' | 'other' (Han, Hangul, Arabic ... and anything unknown)."""
    o = ord(ch)
    if ch.isascii():
        return 'latin' if (ch.isalpha() or ch == "'") else 'other'
    if any(a <= o <= b for a, b in KANA):
        return 'kana'
    if 0x0400 <= o <= 0x052F:
        return 'cyrillic'
    if 0x0370 <= o <= 0x03FF or 0x1F00 <= o <= 0x1FFF:
        return 'greek'
    if o < 0x250 or 0x1E00 <= o <= 0x1EFF:
        return 'latin' if ch.isalpha() else 'other'
    return 'other'


def runs(token: str) -> list[tuple[str, str]]:
    """Split a token into (script, text) runs: 'NightナイトX' -> latin, kana, latin."""
    out: list[tuple[str, str]] = []
    for ch in token:
        s = script_of(ch)
        if out and out[-1][0] == s:
            out[-1] = (s, out[-1][1] + ch)
        else:
            out.append((s, ch))
    return out


# ---------------------------------------------------------------------------------------------- accents
FOLD = {'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', 'þ': 'th', 'Þ': 'Th',
        'ð': 'd', 'Ð': 'D', 'ı': 'i', 'ħ': 'h', 'ŋ': 'ng'}


def ascii_fold(s: str) -> str:
    """José -> Jose. Letters with no decomposition (ß, æ, ø, ł ...) come from a small table; anything still not ASCII is dropped."""
    out = []
    for ch in s:
        if ch.isascii():
            out.append(ch)
            continue
        if ch in FOLD:
            out.append(FOLD[ch])
            continue
        d = unicodedata.normalize('NFKD', ch)
        out.append(''.join(c for c in d if c.isascii() and c.isalpha()))
    return ''.join(out)


# ---------------------------------------------------------------------------------------------- kana -> romaji
_ROWS = [
    ('あいうえお', 'アイウエオ', 'a i u e o'), ('かきくけこ', 'カキクケコ', 'ka ki ku ke ko'), ('さしすせそ', 'サシスセソ', 'sa shi su se so'),
    ('たちつてと', 'タチツテト', 'ta chi tsu te to'), ('なにぬねの', 'ナニヌネノ', 'na ni nu ne no'), ('はひふへほ', 'ハヒフヘホ', 'ha hi fu he ho'),
    ('まみむめも', 'マミムメモ', 'ma mi mu me mo'), ('やゆよ', 'ヤユヨ', 'ya yu yo'), ('らりるれろ', 'ラリルレロ', 'ra ri ru re ro'), ('わゐゑを', 'ワヰヱヲ', 'wa i e o'),
    ('ん', 'ン', 'n'), ('がぎぐげご', 'ガギグゲゴ', 'ga gi gu ge go'), ('ざじずぜぞ', 'ザジズゼゾ', 'za ji zu ze zo'), ('だぢづでど', 'ダヂヅデド', 'da ji zu de do'),
    ('ばびぶべぼ', 'バビブベボ', 'ba bi bu be bo'), ('ぱぴぷぺぽ', 'パピプペポ', 'pa pi pu pe po'), ('', 'ヴ', 'vu'),
]
KANA_SYL: dict[str, str] = {}
for _h, _k, _r in _ROWS:
    for _chars in (_h, _k):
        for _c, _s in zip(_chars, _r.split()):
            KANA_SYL[_c] = _s
SMALL_Y = {'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o', 'ャ': 'a', 'ュ': 'u', 'ョ': 'o'}
SMALL_V = {'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o'}
SOKUON = 'っッ'
LONG = 'ー'
VOWELS = 'aeiou'


def kana_to_romaji(s: str) -> str:
    """ナイト -> naito · ちゃんと -> chanto · ファイト -> faito · ティ -> ti · きっと -> kitto · ラーメン -> raamen."""
    out: list[str] = []
    gem = False
    for ch in s:
        if ch in SOKUON:
            gem = True
            continue
        if ch == LONG:
            if out and out[-1][-1:] in VOWELS:
                out.append(out[-1][-1])
            continue
        if ch in SMALL_Y and out:
            prev = out[-1]
            if prev.endswith('i') and len(prev) >= 2:
                stem = prev[:-1]
                out[-1] = (stem if stem in ('sh', 'ch', 'j') else stem + 'y') + SMALL_Y[ch]
            else:
                out.append('y' + SMALL_Y[ch])
            continue
        if ch in SMALL_V and out:
            prev = out[-1]
            if prev and prev[-1] in VOWELS:
                cons = prev[:-1] if len(prev) > 1 else 'w'
                out[-1] = cons + SMALL_V[ch]
            else:
                out.append(SMALL_V[ch])
            continue
        syl = KANA_SYL.get(ch)
        if syl is None:
            continue
        if gem and syl[0] not in VOWELS and syl[0] != 'n':
            syl = ('t' if syl.startswith('ch') else syl[0]) + syl
        gem = False
        out.append(syl)
    return ''.join(out)


# ---------------------------------------------------------------------------------------------- Cyrillic / Greek -> Latin
CYR = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    # Ukrainian / Belarusian / Serbian / Macedonian / Bulgarian extras
    'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g', 'ў': 'u', 'ј': 'y', 'љ': 'lj', 'њ': 'nj', 'ћ': 'ch', 'ђ': 'dj', 'џ': 'dzh', 'ѓ': 'g', 'ќ': 'k', 'ѕ': 'dz',
}
GRK = {
    'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'ks',
    'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'i', 'φ': 'f', 'χ': 'kh', 'ψ': 'ps', 'ω': 'o',
}


def cyrillic_to_latin(s: str) -> str:
    return ''.join(CYR.get(c, CYR.get(c.lower(), '')) for c in unicodedata.normalize('NFC', s))


def greek_to_latin(s: str) -> str:
    base = unicodedata.normalize('NFD', s)
    base = ''.join(c for c in base if not unicodedata.combining(c))     # tonos, dialytika ...
    return ''.join(GRK.get(c.lower(), '') for c in base)


def to_latin(script: str, s: str) -> str | None:
    if script == 'kana':
        return kana_to_romaji(s)
    if script == 'cyrillic':
        return cyrillic_to_latin(s)
    if script == 'greek':
        return greek_to_latin(s)
    return None


# ---------------------------------------------------------------------------------------------- romanised text -> phonemes
_MULTI = [
    ('shch', 'ʃʧ'), ('tsu', 'tsu'), ('dzh', 'ʤ'), ('tch', 'ʧ'), ('sch', 'ʃ'), ('sh', 'ʃ'), ('ch', 'ʧ'), ('zh', 'ʒ'), ('kh', 'k'), ('ts', 'ts'),
    ('dj', 'ʤ'), ('ya', 'jɑ'), ('yu', 'ju'), ('yo', 'jo'), ('ye', 'jɛ'), ('yi', 'ji'), ('ai', 'ɑɪ'), ('ei', 'ɛɪ'), ('oi', 'ɔɪ'), ('ks', 'ks'), ('ps', 'ps'),
    ('th', 'θ'), ('ng', 'ŋ'),
]
_ONE = {
    'a': 'ɑ', 'b': 'b', 'c': 'k', 'd': 'd', 'e': 'ɛ', 'f': 'f', 'g': 'ɡ', 'h': 'h', 'i': 'i', 'j': 'ʤ', 'k': 'k', 'l': 'l', 'm': 'm', 'n': 'n', 'o': 'o',
    'p': 'p', 'q': 'k', 'r': 'ɾ', 's': 's', 't': 't', 'u': 'u', 'v': 'v', 'w': 'w', 'x': 'ks', 'y': 'j', 'z': 'z',
}


def roman_phonemes(word: str) -> str:
    """Rough Kokoro phonemes for romanised (Japanese / Slavic / Greek) text, by letter rules; 'naito' -> nɑɪto, 'privet' -> pɾivɛt."""
    w = ''.join(c for c in word.lower() if c.isascii() and c.isalpha())
    out: list[str] = []
    i = 0
    while i < len(w):
        hit = next(((a, p) for a, p in _MULTI if w.startswith(a, i)), None)
        if hit:
            out.append(hit[1]); i += len(hit[0]); continue
        c = w[i]
        if c == 'y' and (i + 1 >= len(w) or w[i + 1] not in 'aeiou'):
            out.append('i')                                  # "sergey", "dmitry": a vowel, not the y-glide
        elif c == 'c' and i + 1 < len(w) and w[i + 1] in 'ei':
            out.append('s')
        elif i + 1 < len(w) and w[i + 1] == c and c in 'aeiou':
            out.append(_ONE[c] + 'ː'); i += 1                 # a double vowel is one long one
        elif i + 1 < len(w) and w[i + 1] == c:
            pass                                              # a double consonant is one (the gap shows in speech anyway)
        else:
            out.append(_ONE.get(c, ''))
        i += 1
    return ''.join(out)

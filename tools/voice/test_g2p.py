"""Unit checks for tools/voice/kokoro_g2p.py on a tiny synthetic dictionary (the real ones are misaki's, installed on
demand). Run by tools/voice_sidecars_unit.ts, or directly: python tools/voice/test_g2p.py"""
import os
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kokoro_g2p import G2P, chunk, number_words, speak_number  # noqa: E402
from translit import ascii_fold, cyrillic_to_latin, greek_to_latin, kana_to_romaji, roman_phonemes  # noqa: E402

GOLD = {
    'hello': 'həlˈO', 'the': 'ðə', 'night': 'nˈIt', 'owl': 'ˈWl', 'thank': 'θˈæŋk', 'you': 'ju', 'for': 'fɔɹ', 'follow': 'fˈɑlO',
    'stream': 'stɹˈim', 'one': 'wˈʌn', 'two': 'tˈu', 'four': 'fˈɔɹ', 'forty': 'fˈɔɹɾi', 'twenty': 'twˈɛnti', 'six': 'sˈɪks', 'a': 'A', 'i': 'ˈI',
    'raid': 'ɹˈAd', 'point': 'pˈɔɪnt', 'three': 'θɹˈi', 'five': 'fˈIv', 'thousand': 'θˈWzᵊnd', 'hundred': 'hˈʌndɹᵻd', 'fifty': 'fˈɪfti',
    'read': {'DEFAULT': 'ɹˈid', 'VBD': 'ɹˈɛd'}, 'dollars': None, 'and': 'ænd', 'plus': 'plˈʌs', 'box': 'bˈɑks', 'pixel': 'pˈɪksᵊl', 'pioneer': 'pˌIənˈɪɹ',
    'oh': 'ˈO', 'sub': 'sˈʌb', 'cheer': 'ʧˈɪɹ', 'stop': 'stˈɑp',
}
SILVER = {'dollars': 'dˈɑləɹz'}
VOCAB = set(''.join(v for v in list(GOLD.values()) + list(SILVER.values()) if isinstance(v, str)) + ''.join(v['DEFAULT'] for v in GOLD.values() if isinstance(v, dict))
            + ' ;:,.!?—…"()“”' + ''.join('ˈA ˈi ˈɛ ˈO ˈI ˈW'.split()) + 'bdfghjklmnpqrstvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZɛʤʧɑɹ')
# Kokoro's real symbol set (tokenizer.json of onnx-community/Kokoro-82M-v1.0-ONNX)
VOCAB = set(';:,.!?—…"()“” ' + 'AIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ')
g = G2P(GOLD, SILVER, VOCAB)
fails = 0


def ok(name, cond, extra=''):
    global fails
    print(('PASS  ' if cond else 'FAIL  ') + name + (f'  ({extra})' if extra and not cond else ''))
    if not cond:
        fails += 1


def ph(t):
    return g.phonemes(t)[0]


ok('dictionary word', ph('hello') == 'həlˈO', ph('hello'))
ok('punctuation stays, sticks to the word', ph('Hello, the stream!') == 'həlˈO, ðə stɹˈim!', ph('Hello, the stream!'))
ok('silver dictionary is the second chance', ph('dollars') == 'dˈɑləɹz')
ok('heteronym: the default reading', ph('read') == 'ɹˈid')
ok('plural -s', ph('streams') == 'stɹˈimz', ph('streams'))
ok('plural after a sibilant -> ᵻz', ph('boxes') == 'bˈɑksᵻz', ph('boxes'))
ok('-ed after a voiceless sound -> t', ph('followed') == 'fˈɑlOd', ph('followed'))
ok('-ed doubled consonant (stopped)', ph('stopped') == 'stˈɑpt', ph('stopped'))
ok('-ing', ph('following') == 'fˈɑlOɪŋ', ph('following'))
ok("contraction: I'm", ph("I'm") == 'ˈIm', ph("I'm"))
ok("possessive: stream's", ph("stream's") == 'stɹˈimz', ph("stream's"))
ok('number words', ' '.join(number_words(42)) == 'forty two' and ' '.join(number_words(2026)) == 'twenty twenty six' and ' '.join(number_words(1005)) == 'one thousand five' and ' '.join(number_words(1250)) == 'one thousand two hundred fifty', ' '.join(number_words(2026)))
ok('decimals', ' '.join(speak_number('3.5')) == 'three point five' and ' '.join(speak_number('1,250')) == 'one thousand two hundred fifty')
ok('digits are spoken', ph('42') == 'fˈɔɹɾi tˈu', ph('42'))
ok('a name is split at case / digit boundaries and spoken, not dropped', ph('NightOwl42') == 'nˈIt ˈWl fˈɔɹɾi tˈu', ph('NightOwl42'))
ok('underscores and glued words', ph('pixel_pioneer') == 'pˈɪksᵊl pˌIənˈɪɹ' and ph('pixelpioneer') == 'pˈɪksᵊl pˌIənˈɪɹ', ph('pixelpioneer'))
p, unk = g.phonemes('Qzxv')
ok('an unknown word is spelled out letter by letter and reported', len(p) > 0 and unk == ['Qzxv'], f'{p!r} {unk}')
ok('nothing the vocabulary lacks survives (emoji, markup)', all(c in VOCAB for c in ph('hello 🎉 <b>raid</b> ☃')), ph('hello 🎉 <b>raid</b> ☃'))
ok('symbols become words', ph('one & two') == 'wˈʌn ænd tˈu' and ph('1+2') == 'wˈʌn plˈʌs tˈu', ph('1+2'))
ok('empty / punctuation only -> nothing', ph('') == '' and ph('...') == '')
long = ' '.join(['hello world. ' * 2] * 60)
parts = chunk(ph(long) if ph(long) else 'həlˈO ' * 300, 120)
ok('chunking keeps each piece under the limit', all(len(x) <= 120 for x in parts) and len(parts) > 1, str([len(x) for x in parts][:6]))
ok('chunking a short text is one piece', chunk('həlˈO') == ['həlˈO'] and chunk('') == [])

# ---------------------------------------------------------------------------------------------- other scripts and accents
def speak(t):
    return g.speak(t)


ok('kana -> romaji', kana_to_romaji('ナイト') == 'naito' and kana_to_romaji('ちゃんと') == 'chanto' and kana_to_romaji('ファイト') == 'faito'
   and kana_to_romaji('きっと') == 'kitto' and kana_to_romaji('ラーメン') == 'raamen' and kana_to_romaji('しゃ') == 'sha' and kana_to_romaji('ティ') == 'ti'
   and kana_to_romaji('ウィ') == 'wi' and kana_to_romaji('さくら') == 'sakura' and kana_to_romaji('ヴァ') == 'va' and kana_to_romaji('じゅん') == 'jun',
   [kana_to_romaji(x) for x in ('ナイト', 'ちゃんと', 'ファイト', 'きっと', 'ラーメン', 'しゃ', 'ティ', 'ウィ', 'さくら', 'ヴァ', 'じゅん')])
ok('Cyrillic / Greek -> Latin', cyrillic_to_latin('Привет') == 'privet' and cyrillic_to_latin('Щука') == 'shchuka' and cyrillic_to_latin('Ёж') == 'yozh' and cyrillic_to_latin('Дмитрий') == 'dmitriy' and greek_to_latin('Αλέξης') == 'aleksis')
ok('accents are folded to ASCII', ascii_fold('José') == 'Jose' and ascii_fold('Zoë') == 'Zoe' and ascii_fold('Łukasz') == 'Lukasz' and ascii_fold('straße') == 'strasse' and ascii_fold('Søren') == 'Soren' and ascii_fold('Çağrı') == 'Cagri' and ascii_fold('plain') == 'plain')
ok('romanised text -> phonemes by letter rules', roman_phonemes('naito') == 'nɑɪto' and roman_phonemes('privet') == 'pɾivɛt' and roman_phonemes('shchi').startswith('ʃʧ'), roman_phonemes('naito'))
p, unk, sk = speak('ナイト')
ok('ナイト is spoken (not silent, not spelled, nothing skipped)', p == 'nɑɪto' and not sk and not unk, f'{p!r} {sk}')
p, unk, sk = speak('Привет')
ok('Привет is spoken', p == 'pɾivɛt' and not sk, f'{p!r} {sk}')
p, unk, sk = speak('田中')
ok('田中 (Han) has no table: skipped silently, the line has nothing to say', p == '' and sk == ['田中'], f'{p!r} {sk}')
p, unk, sk = speak('😀😀')
ok('😀😀 (emoji only) -> nothing to say, nothing skipped', p == '' and sk == [], f'{p!r} {sk}')
ok('José is read as Jose', speak('José')[0] == speak('Jose')[0] and speak('José')[0] != '' and 'Jose' in speak('José')[1], speak('José')[0])
ok('Zoë / Łukasz / Søren are spoken too', all(speak(w)[0] for w in ('Zoë', 'Łukasz', 'Søren', 'Müller', 'François')))
p, unk, sk = speak('Привет, 田中 sent 5 hello 😀')
ok('a mixed line: Cyrillic spoken, Han skipped, emoji ignored, the English kept', p.startswith('pɾivɛt,') and 'həlˈO' in p and 'fˈIv' in p and sk == ['田中'] and '😀' not in p, f'{p!r} {sk}')
p, unk, sk = speak('Nightナイト_田中')
ok('one name mixing Latin, kana and Han: each part handled on its own', 'nˈIt' in p and 'nɑɪto' in p and sk == ['田中'], f'{p!r} {sk}')
p, unk, sk = speak('Αλέξης Ñoño Ｗｉｄｅ')
ok('Greek, tilde letters and fullwidth Latin are spoken', len(p) > 5 and not sk, f'{p!r} {sk}')
ok('Arabic-Indic digits are numbers', speak('٣')[0] == 'θɹˈi')
ok('lines of only punctuation / symbols / unknown scripts have nothing to say', all(speak(t)[0] == '' for t in ('', '...', '?!', '田中!', '한국어', 'مرحبا', '☃♥', '😀 ✨ 🎉')))
ok('a line with real words and an unspeakable name still speaks the words', speak('thanks 田中 for the follow')[0].count(' ') >= 2 and speak('thanks 田中 for the follow')[2] == ['田中'])
sys.exit(1 if fails else 0)

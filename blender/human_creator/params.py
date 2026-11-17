"""
Parameter document for the realistic / semi-realistic human creator (one JSON file drives everything).
Every field is optional - `load_params` fills defaults, clamps ranges and derives the automatic choices (skin
texture from ethnicity/age/sex, hair colour, outfit per sex) so a one-line spec still builds a finished avatar.
See README.md for the schema.
"""
import copy
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

EYE_COLORS = ['brown', 'brownlight', 'blue', 'bluegreen', 'deepblue', 'green', 'grey', 'ice', 'lightblue']
HAIR_STYLES = ['afro01', 'bob01', 'bob02', 'braid01', 'long01', 'ponytail01', 'short01', 'short02', 'short03', 'short04']
# long styles get spring-bone chains (hair_*), short ones are rigid on the head
LONG_HAIR = {'long01': 'long', 'braid01': 'braid', 'ponytail01': 'ponytail', 'bob01': 'bob', 'bob02': 'bob'}
CLOTHES = ['female_casualsuit01', 'female_casualsuit02', 'female_elegantsuit01', 'female_sportsuit01',
           'male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05',
           'male_casualsuit06', 'male_elegantsuit01', 'male_worksuit01', 'fedora01', 'fedora_cocked']
SHOES = ['shoes01', 'shoes02', 'shoes03', 'shoes04', 'shoes05', 'shoes06']

HAIR_COLORS = {  # natural hair colour presets (sRGB) - any '#rrggbb' works too
    'black': '#141110', 'darkbrown': '#2b1d14', 'brown': '#4a3021', 'chestnut': '#6b3b22', 'auburn': '#7a2e1c',
    'red': '#9a3a1c', 'blonde': '#b8925a', 'platinum': '#d8cdb8', 'grey': '#8d8a86', 'white': '#d9d6d0',
    'original': None,
}

DEFAULTS = {
    'id': 'human_custom',
    'name': 'Custom Human',
    'sex': 'female',            # 'female' | 'male' - picks defaults (gender macro, outfit, brows, hair)
    'body': {
        'gender': None,         # 0 = female .. 1 = male (None = from sex: 0.0 / 1.0)
        'age': 25,              # years (18..90)
        'muscle': 0.5,          # 0..1
        'weight': 0.5,          # 0..1
        'height': 0.5,          # 0..1
        'proportions': 0.5,     # 0..1 (idealised proportions at 1)
        'cupsize': 0.5,         # 0..1 (female)
        'firmness': 0.5,        # 0..1
        'race': {'african': 0.0, 'asian': 0.0, 'caucasian': 1.0},  # blend weights (normalised)
    },
    # MakeHuman detail targets, bipolar -1..1 ('nose-volume': -0.3 -> nose-volume-decr 0.3). Symmetric l-/r-
    # targets use the bare name ('eye-scale' drives l-eye-scale + r-eye-scale). Unipolar names ('head-oval') 0..1.
    'faceStyle': 'auto',        # curated base face: 'auto' (by sex) | 'female_soft' | 'male_strong' | 'none'
    'face': {},
    'shape': {},
    'skin': {
        'texture': 'auto',      # 'auto' or a MakeHuman skin name, e.g. 'young_asian_female'
        'tint': None,           # '#rrggbb' multiplied into the albedo (fine skin-tone adjust), None = off
        'smooth': 0.0,          # 0..1 skin retouch (blur pores/blotches) - stylisation raises it
        'roughness': 0.52,      # base skin roughness (T-zone gets a little shinier automatically)
        'makeup': {'lips': 0.0, 'lipColor': '#b04a55', 'blush': 0.0, 'blushColor': '#e07a7a', 'liner': 0.0},
    },
    'eyes': {'color': 'brown'},
    'eyebrows': 'auto',         # eyebrow001..012, 'auto' (sex based) or 'none'
    'eyebrowColor': 'hair',     # 'hair' | '#rrggbb' | 'original'
    'eyelashes': 'auto',        # eyelashes01..04 or 'auto'
    'hair': {'style': 'auto', 'color': 'brown', 'physics': True},
    'teeth': 'teeth_base',      # MakeHuman teeth proxy ('none' = no teeth mesh)
    'tongue': 'tongue01',
    'outfit': {
        'clothes': 'auto',      # list of clothes proxies for the base outfit, or 'auto'
        'shoes': 'auto',
        'costumes': 'auto',     # list of {id, name, clothes: [...], shoes} or 'auto' (2 extra outfits per sex)
    },
    'stylization': 0.0,         # 0 = realistic .. 1 = semi-stylised (bigger eyes, smoother skin, simpler shading)
    'expression': {'strength': 1.0},
}


def _merge(dst, src):
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def clamp(v, lo, hi):
    return max(lo, min(hi, float(v)))


def age_to_macro(years):
    """MakeHuman age macro: 0 = 1y, 0.1875 = 11y, 0.5 = 25y, 1 = 90y."""
    y = clamp(years, 1, 90)
    if y < 11:
        return (y - 1) / 10 * 0.1875
    if y < 25:
        return 0.1875 + (y - 11) / 14 * (0.5 - 0.1875)
    return 0.5 + (y - 25) / 65 * 0.5


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def load_params(spec):
    if isinstance(spec, str):
        with open(spec, encoding='utf-8') as f:
            user = json.load(f)
    else:
        user = spec or {}
    p = _merge(copy.deepcopy(DEFAULTS), user)
    male = str(p['sex']).lower().startswith('m')
    p['sex'] = 'male' if male else 'female'
    b = p['body']
    if b['gender'] is None:
        b['gender'] = 1.0 if male else 0.0
    b['gender'] = clamp(b['gender'], 0, 1)
    b['age'] = clamp(b['age'], 18, 90)
    for k in ('muscle', 'weight', 'height', 'proportions', 'cupsize', 'firmness'):
        b[k] = clamp(b[k], 0, 1)
    r = {k: max(0.0, float(b['race'].get(k, 0))) for k in ('african', 'asian', 'caucasian')}
    s = sum(r.values()) or 1.0
    b['race'] = {k: v / s for k, v in r.items()}
    p['stylization'] = clamp(p['stylization'], 0, 1)
    p['id'] = re.sub(r'[^a-z0-9_-]+', '_', str(p['id']).lower()).strip('_') or 'human_custom'
    # ---- automatic choices
    sk = p['skin']
    if sk['texture'] == 'auto':
        race = max(b['race'], key=b['race'].get)
        age = 'young' if b['age'] < 36 else ('middleage' if b['age'] < 58 else 'old')
        sk['texture'] = '%s_%s_%s' % (age, race, p['sex'])
    sk['smooth'] = clamp(max(sk['smooth'], 0.75 * p['stylization']), 0, 1)
    if p['eyes']['color'] not in EYE_COLORS:
        p['eyes']['color'] = 'brown'
    if p['eyebrows'] == 'auto':
        p['eyebrows'] = 'eyebrow001' if male else 'eyebrow002'
    if p['eyelashes'] == 'auto':
        p['eyelashes'] = 'eyelashes01' if male else 'eyelashes02'
    h = p['hair']
    if h['style'] == 'auto':
        h['style'] = 'short02' if male else 'long01'
    if isinstance(h['color'], str) and h['color'] in HAIR_COLORS:
        h['color'] = HAIR_COLORS[h['color']]
    if b['age'] >= 70 and user.get('hair', {}).get('color') is None:
        h['color'] = HAIR_COLORS['grey']
    o = p['outfit']
    if o['clothes'] == 'auto':
        o['clothes'] = ['male_casualsuit04'] if male else ['female_casualsuit01']
    if isinstance(o['clothes'], str):
        o['clothes'] = [o['clothes']]
    if o['shoes'] == 'auto':
        o['shoes'] = 'shoes02' if male else 'shoes01'
    if o['costumes'] == 'auto':
        o['costumes'] = ([
            {'id': 'smart', 'name': 'Smart suit', 'clothes': ['male_elegantsuit01'], 'shoes': 'shoes02'},
            {'id': 'work', 'name': 'Work wear', 'clothes': ['male_worksuit01'], 'shoes': 'shoes05'},
        ] if male else [
            {'id': 'elegant', 'name': 'Elegant suit', 'clothes': ['female_elegantsuit01'], 'shoes': 'shoes03'},
            {'id': 'sport', 'name': 'Sport suit', 'clothes': ['female_sportsuit01'], 'shoes': 'shoes06'},
        ])
    return p


FACE_STYLES = {
    # curated, appealing base faces (MakeHuman's default face is a neutral average). User 'face' values add on top.
    'female_soft': {
        'chin-width': -0.55, 'chin-bones': -0.45, 'chin-height': -0.15, 'chin-prominent': 0.15,
        'cheek-bones': 0.4, 'cheek-volume': 0.05, 'head-oval': 0.7, 'head-fat': -0.35, 'head-age': -0.3,
        'nose-scale-horiz': -0.4, 'nose-width1': -0.35, 'nose-width2': -0.3, 'nose-width3': -0.3, 'nose-point': 0.4,
        'nose-hump': -0.5, 'nose-volume': -0.35, 'nose-nostrils-width': -0.3,
        'mouth-upperlip-volume': 0.45, 'mouth-lowerlip-volume': 0.5, 'mouth-cupidsbow': 0.5, 'mouth-angles': 0.25,
        'eye-scale': 0.3, 'eye-corner2': 0.35, 'eye-height2': 0.25, 'eyebrows-trans': 0.15, 'neck-scale-horiz': -0.35,
    },
    'male_strong': {
        'chin-width': 0.4, 'chin-prominent': 0.4, 'chin-bones': 0.6, 'chin-height': 0.15,
        'cheek-bones': 0.45, 'cheek-volume': -0.4, 'head-square': 0.55, 'head-fat': -0.4, 'head-age': -0.15,
        'nose-width1': -0.25, 'nose-hump': -0.3, 'nose-point': 0.15, 'nose-scale-horiz': -0.15,
        'eye-scale': 0.1, 'eye-corner2': 0.15, 'eyebrows-trans': -0.25,
        'mouth-lowerlip-volume': 0.3, 'mouth-upperlip-volume': 0.15, 'neck-scale-horiz': 0.3,
    },
    'none': {},
}


def base_face(p):
    st = p.get('faceStyle', 'auto')
    if st == 'auto':
        st = 'male_strong' if p['sex'] == 'male' else 'female_soft'
    return dict(FACE_STYLES.get(st, {}))


def stylized_face(p):
    """Detail targets added by the stylisation slider (realistic -> semi-stylised / anime-leaning)."""
    s = p['stylization']
    if s <= 0:
        return {}
    return {
        'eye-scale': 0.55 * s, 'eye-height2': 0.35 * s, 'eye-trans-up': 0.1 * s,
        'nose-scale-horiz': -0.25 * s, 'nose-volume': -0.35 * s, 'nose-point-width': -0.3 * s,
        'mouth-scale-horiz': -0.15 * s, 'mouth-lowerlip-volume': 0.1 * s,
        'chin-width': -0.2 * s, 'head-age': -0.4 * s, 'head-fat': -0.15 * s, 'cheek-inner': -0.2 * s,
    }


def preset_path(name):
    return os.path.join(HERE, 'presets', name + '.json')

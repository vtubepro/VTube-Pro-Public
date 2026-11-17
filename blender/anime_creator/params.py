"""
Parameter schema for the anime creator (all fields optional except base; see presets/*.json).

{
  "id": "anime_kaito", "name": "Kaito", "source": "import", "prompt": "...",   # "builtin" = ships with VTube Pro: only for the repo's own assets/builtin
  "base": "fumiriya",                     # body + face donor, one of BASES (gender follows the base)
  "hair": {
    "style": "hairsample_male",           # hairstyle donor (any BASES key; male<->female works too)
    "scale": 1.0,                         # uniform hair volume about the head
    "volume": [1, 1, 1],                  # extra x / y / z puff (back volume = z)
    "messy": 0.0,                         # 0..1 strand-tip jitter (curly / unkempt look)
    "springs": {"stiffness": 1, "gravity": 1, "drag": 1}   # multipliers on the donor spring bones
  },
  "colors": {
    "skin": "#f6dccb" | null,             # null = keep the base's painted skin
    "hair": "#2a2f45",                    # hair base colour (texture shading is preserved)
    "hairTip": "#b9a6ff" | null,          # gradient towards the strand tips
    "hairShade": null,                    # shade colour (default: derived, cooler + darker)
    "eyes": "#3a7bd5",                    # iris colour
    "eyeGlow": 0.0,                       # 0..1 emissive iris (hollow glowing eyes)
    "sclera": null,                       # sclera colour (null keeps white)
    "brows": null, "lashes": null, "lips": null
  },
  "face": {
    "eyeSize": 1.0, "eyeHeight": 0.0, "eyeTilt": 0.0, "faceWidth": 1.0, "chin": 0.0, "jaw": 1.0,
    "socketShadow": 0.0,                  # 0..1 dark eye sockets painted into the skin
    "socketColor": "#3a3050",
    "mouth": {"grinWidth": 1.0, "teeth": "flat"|"shark", "jawOpen": 1.0}
  },
  "body": {"height": 1.0, "legs": 1.0, "arms": 1.0, "head": 1.0, "shoulders": 1.0, "build": 1.0,
           "waist": 1.0, "hips": 1.0, "bust": 1.0, "neck": 1.0},
  "outfit": {                             # garment slots: from = donor base key (or "base"), null = remove
    "tops": {"from": "base", "color": "#...", "pattern": {...}},
    "bottoms": {...}, "shoes": {...}, "accessory": {...}|null
  },
  "props": [ {"kind": "skull_mask", ...} ],        # rigid accessories baked into the model
  "costumes": [ {"id": "casual", "name": "...", "outfit": {...}, "props": [...]} ],
  "look": {"exposure": 0.62}
}
"""
from __future__ import annotations

import copy

BASES = {
    'fumiriya': {'file': 'Sakurada_Fumiriya.vrm', 'gender': 'male', 'label': 'Sakurada Fumiriya (school vest)'},
    'hairsample_male': {'file': 'HairSample_Male.vrm', 'gender': 'male', 'label': 'VRoid male (hoodie)'},
    'shibu': {'file': 'Sendagaya_Shibu.vrm', 'gender': 'female', 'label': 'Sendagaya Shibu (school uniform, bob)'},
    'shino': {'file': 'Sendagaya_Shino.vrm', 'gender': 'female', 'label': 'Sendagaya Shino (school uniform, long)'},
    'darkness_shibu': {'file': 'Darkness_Shibu.vrm', 'gender': 'female', 'label': 'Darkness Shibu (gothic dress)'},
    'hairsample_female': {'file': 'HairSample_Female.vrm', 'gender': 'female', 'label': 'VRoid female (white dress, twintails)'},
}

DEFAULTS = {
    'id': 'anime_custom', 'name': 'Anime avatar', 'source': 'import', 'prompt': '',
    'base': 'fumiriya',
    'hair': {'style': None, 'scale': 1.0, 'volume': [1.0, 1.0, 1.0], 'messy': 0.0,
             'springs': {'stiffness': 1.0, 'gravity': 1.0, 'drag': 1.0}},
    'colors': {'skin': None, 'hair': None, 'hairTip': None, 'hairShade': None, 'eyes': None, 'eyeGlow': 0.0,
               'sclera': None, 'brows': None, 'lashes': None, 'lips': None},
    'face': {'eyeSize': 1.0, 'eyeHeight': 0.0, 'eyeTilt': 0.0, 'faceWidth': 1.0, 'chin': 0.0, 'jaw': 1.0,
             'socketShadow': 0.0, 'socketColor': '#3a3050',
             'mouth': {'grinWidth': 1.0, 'teeth': 'flat', 'jawOpen': 1.0}},
    'body': {'height': 1.0, 'legs': 1.0, 'arms': 1.0, 'head': 1.0, 'shoulders': 1.0, 'build': 1.0,
             'waist': 1.0, 'hips': 1.0, 'bust': 1.0, 'neck': 1.0},
    'outfit': {},
    'props': [],
    'costumes': [],
    'look': {'exposure': 0.62},
}


def _merge(d, p):
    out = copy.deepcopy(d)
    for k, v in (p or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def normalize(p: dict) -> dict:
    q = _merge(DEFAULTS, p)
    if q['base'] not in BASES:
        raise ValueError(f"unknown base '{q['base']}' (one of {', '.join(BASES)})")
    if q['hair']['style'] is None:
        q['hair']['style'] = q['base']
    if q['colors']['eyes'] is None:
        q['colors']['eyes'] = '#4a6fd8'
    return q


def gender(p: dict) -> str:
    return BASES[p['base']]['gender']

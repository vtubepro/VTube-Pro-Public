"""Final profile.json touches for a Live2D conversion (source, name, provenance)."""
import json
import os


def profile(A, pre, out, signature=False):
    p = os.path.join(out, 'profile.json')
    with open(p, encoding='utf-8') as f:
        prof = json.load(f)
    prof['source'] = 'import'
    prof['name'] = pre.get('name', prof.get('name'))
    cr = prof.get('creator') or {}
    cr.pop('params', None)                    # face_kit's params.json is not kept next to a converted avatar
    cr.update({'kind': 'live2d' if A.model is not None else 'drawing',
               'model': A.model.name if A.model is not None else os.path.basename(getattr(A, 'image_path', '')), 'sex': pre['l2d']['sex'],
               'reference': 'live2d_ref/front.png', 'analysis': 'live2d_ref/analysis.json'})
    cr['signatureRest'] = bool(signature)     # the rest face is the --ref signature grin (default off)
    prof['creator'] = cr
    # the app scales every VRM's MToon lit + shade colours by look.vrmExposure (default 0.62, tuned for VRoid
    # models): measured in the app, a converted face then renders at ~84 % of the drawn skin value (grey skin in
    # every review). A converted drawing's colours ARE the lit colours: 0.74 brings the lit face to the drawn value.
    look = prof.setdefault('look', {})
    look['vrmExposure'] = 0.74
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(prof, f, indent=1)

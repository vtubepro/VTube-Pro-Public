"""Render preview + thumbnail of a costume GLB worn on its base avatar (uses costume_kit).

    blender -b --factory-startup --python blender/costume_preview.py -- BASE.glb COSTUME.glb OUT_PREFIX
            [--sclera '#f2c94c'] [--posed OUT.png]

Writes OUT_PREFIX_preview.png (front + 3/4) and OUT_PREFIX_thumb.png (512 px). The base's
profile.json (next to BASE.glb) supplies the eye markers for the preview eye bulbs.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import costume_kit as kit  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:]
base, costume, prefix = args[0], args[1], args[2]
sclera = args[args.index('--sclera') + 1] if '--sclera' in args else None
kit.load_base(base)
kit.measure()
kit.wear(costume)
kit.render_preview(prefix + '_preview.png', objects=[], sclera=sclera)
kit.render_thumb(prefix + '_thumb.png', objects=[], sclera=sclera)
if '--posed' in args:
    kit.pose(head_yaw=25, arms_raise=70, elbow_bend=25)
    kit.render_preview(args[args.index('--posed') + 1], objects=[], sclera=sclera, views=(0, 30))

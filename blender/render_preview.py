"""Render preview images of a model (Eevee, transparent film, soft 3-point light).

params: {
  "input": "<model path>",
  "out_dir": "<dir>",
  "views": ["front", "three_quarter", "left", "right", "back", "top"],
  "size": 768,
  "camera": "ortho" | "persp",      # persp = 35mm lens
  "prefix": "view"                   # files are <prefix>_<view>.png
}
If "input" is omitted the current scene is rendered (used by run_user.py).
VTP_OK {"images": [{"view": ..., "path": ...}], "bbox": {...}}

View naming follows the character: the model faces glTF +Z = Blender -Y,
its left side is +X. "left" shows the character's left side.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import common  # noqa: E402

# Direction from the model centre TO the camera, in Blender space.
VIEW_DIRS = {
    "front": Vector((0, -1, 0)),
    "back": Vector((0, 1, 0)),
    "left": Vector((1, 0, 0)),
    "right": Vector((-1, 0, 0)),
    "three_quarter": Vector((0.6, -1, 0.25)).normalized(),
    "top": Vector((0, -0.001, 1)).normalized(),
}


def look_at(obj, target):
    d = (target - obj.location).normalized()
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def setup_render(size):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.use_freestyle = False
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    # Soft ambient from the world (film stays transparent).
    world = scene.world or bpy.data.worlds.new("VTP_World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.8, 0.82, 0.86, 1)
        bg.inputs["Strength"].default_value = 0.6


def add_sun(name, energy, angle_deg):
    data = bpy.data.lights.new(name, "SUN")
    data.energy = energy
    data.angle = math.radians(angle_deg)  # large angle = soft shadows
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def place_lights(lights, center, cam_dir, radius):
    """Key (front-left-high), fill (front-right-low), rim (behind-high) relative to the camera."""
    up = Vector((0, 0, 1))
    right = cam_dir.cross(up)
    if right.length < 1e-4:
        right = Vector((1, 0, 0))
    right.normalize()
    key, fill, rim = lights
    for light, offset in (
        (key, cam_dir + right * -0.8 + up * 0.9),
        (fill, cam_dir + right * 0.9 + up * 0.1),
        (rim, -cam_dir + up * 0.8 + right * 0.3),
    ):
        light.location = center + offset.normalized() * radius * 3
        look_at(light, center)


def frame_camera(cam, lo, hi, direction, mode, aspect=1.0):
    center = (lo + hi) / 2
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    radius = max((c - center).length for c in corners) or 1.0
    world_up = Vector((0, 0, 1)) if abs(direction.z) < 0.99 else Vector((0, 1, 0))
    right = world_up.cross(direction).normalized()
    up = direction.cross(right).normalized()
    # extents of the bbox projected on the camera plane
    w = max(abs((c - center).dot(right)) for c in corners) * 2
    h = max(abs((c - center).dot(up)) for c in corners) * 2
    extent = max(w, h / aspect) * 1.12
    if mode == "persp":
        cam.data.type = "PERSP"
        cam.data.lens = 35
        cam.data.sensor_fit = "AUTO"
        fov = cam.data.angle
        depth = max(abs((c - center).dot(direction)) for c in corners)
        dist = (extent / 2) / math.tan(fov / 2) + depth
    else:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = extent
        dist = radius * 3
    cam.location = center + direction * dist
    look_at(cam, center)
    cam.data.clip_start = max(0.001, dist - radius * 2)
    cam.data.clip_end = dist + radius * 4
    return center, radius


def render_views(out_dir, views, size=768, mode="ortho", prefix="view"):
    meshes = common.mesh_objects()
    if not meshes:
        raise RuntimeError("Nothing to render: scene has no meshes")
    lo, hi = common.scene_bbox(meshes)
    setup_render(size)
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("VTP_Cam")
    cam = bpy.data.objects.new("VTP_Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    lights = [add_sun("VTP_Key", 3.0, 25), add_sun("VTP_Fill", 1.2, 40), add_sun("VTP_Rim", 2.0, 15)]
    os.makedirs(out_dir, exist_ok=True)
    images = []
    for view in views:
        if view not in VIEW_DIRS:
            raise ValueError(f"Unknown view '{view}' (valid: {', '.join(VIEW_DIRS)})")
        direction = VIEW_DIRS[view]
        center, radius = frame_camera(cam, lo, hi, direction, mode)
        place_lights(lights, center, direction, radius)
        path = os.path.join(out_dir, f"{prefix}_{view}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        images.append({"view": view, "path": path})
        common.log("rendered", view, path)
    # clean up so callers can keep using the scene / export it
    for o in [cam] + lights:
        bpy.data.objects.remove(o, do_unlink=True)
    return {"images": images, "bbox": common.bbox_gltf(lo, hi)}


def main(p):
    if p.get("input"):
        common.reset_scene()
        common.import_model(p["input"])
    return render_views(
        p["out_dir"],
        p.get("views") or ["front"],
        int(p.get("size") or 768),
        p.get("camera") or "ortho",
        p.get("prefix") or "view",
    )


if __name__ == "__main__":
    common.run_main(main)

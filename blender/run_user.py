"""Run an arbitrary bpy script headlessly (POST /api/blender/run: scripts written by your AI app).

params: {
  "script": "<path to .py>",
  "model": "<optional model path pre-imported into an empty scene>",
  "out_dir": "<dir, also exposed as os.environ['VTP_OUT']>",
  "require": ["model.glb"],        # optional: files that must exist in out_dir afterwards
  "render": {"views": [...], "size": 512, "prefix": "render"}   # optional: render out_dir/model.glb after
}
The user script may print its own VTP_OK line; the server uses the last marker,
which this wrapper always prints after the script finishes.
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def main(p):
    out_dir = p["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    os.environ["VTP_OUT"] = out_dir
    common.reset_scene()
    if p.get("model"):
        common.import_model(p["model"])
    with open(p["script"], "r", encoding="utf-8") as f:
        code = f.read()
    g = {"__name__": "__main__", "__file__": p["script"]}
    try:
        exec(compile(code, "user_script.py", "exec"), g)
    except SystemExit as e:  # scripts sometimes call sys.exit(); treat 0/None as success
        if e.code not in (0, None):
            raise RuntimeError(f"script called sys.exit({e.code})")
    except BaseException:
        # print the traceback with user_script.py line numbers so an LLM can fix it
        tb = traceback.format_exc()
        sys.stdout.write("VTP_TRACEBACK_BEGIN\n" + tb + "VTP_TRACEBACK_END\n")
        sys.stdout.flush()
        raise
    missing = [r for r in (p.get("require") or []) if not os.path.isfile(os.path.join(out_dir, r))]
    if missing:
        raise RuntimeError(f"script finished but did not write {', '.join(missing)} into VTP_OUT")
    result = {"files": sorted(os.listdir(out_dir))}
    render = p.get("render")
    if render:
        import render_preview
        common.reset_scene()
        common.import_model(os.path.join(out_dir, "model.glb"))
        r = render_preview.render_views(out_dir, render.get("views") or ["front"],
                                        int(render.get("size") or 512), render.get("camera") or "ortho",
                                        render.get("prefix") or "render")
        result["renders"] = [i["path"] for i in r["images"]]
        result["bbox"] = r["bbox"]
        result["files"] = sorted(os.listdir(out_dir))
    return result


common.run_main(main)

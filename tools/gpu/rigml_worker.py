"""The ML rigging worker: one mesh in, one rigged GLB out, run by the helper as a job (server/rigMl.ts). Runs in the pack's own
Python environment, never inside VTube Pro's process. Prints one JSON object per line on stdout:

    {"event":"start","model":"skintokens"}
    {"event":"progress","pct":0.3,"msg":"..."}      (also {"event":"log","msg":"..."} for the model's own output)
    {"event":"done","output":"<path>","seconds":12.3}
    {"event":"error","msg":"..."}                    (exit code 2; 3 = pack not installed; 4 = the model ran out of graphics memory)

    python rigml_worker.py --model skintokens --input in.glb --output out.glb --code-dir <pack>/code [--device cuda]
    python rigml_worker.py --model unirig --input proxy.glb --output rigged.glb --code-dir <pack>/code --staged --faces 30000 --beams 5 --skin-chunk 256
    python rigml_worker.py --model unirig --input in.glb --output out.glb --code-dir <pack>/code --plan      (print the steps, run nothing)
    python rigml_worker.py --model skintokens --input in.glb --output out.glb --mock [--mock-delay 2] [--mock-fail 2]

--mock stands in for the model (tests, CI, a PC without the pack): it writes a small rigged GLB with generic bone names and loads
nothing. Real mode runs the pinned project's own command line (demo.py) inside --code-dir and relays its output.

--staged is the low-memory mode (the helper hands it a DECIMATED copy of the mesh and transfers the weights back afterwards):
  UniRig   skeleton, skin and merge run as three separate bash processes (the card is empty between them), with the knobs its pinned
           repo really has: `--faces_target_count` on generate_skeleton.sh / generate_skin.sh, `num_beams` (system config) and
           `num_train_vertex` (model config: "increase this for faster speed at the cost of memory", the skinning chunk size). Both of
           its quick-inference task files already set `precision: bf16-mixed`; the scripts have NO precision, device or CPU-offload flag, so none
           is passed or invented here. `--seed`, `--faces_target_count`, `--skeleton_task`, `--skin_task` are the only options added.
  SkinTokens  is one unified sequence (skeleton then skin tokens), so there is no step to split; the one real knob is `--num_beams`.
UNVERIFIED on real models (none is downloaded or run on this PC): the memory these knobs save, and the exact staged floors.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import time

EXIT_ERROR, EXIT_MISSING, EXIT_VRAM = 2, 3, 4
MIN_VRAM_GB = {"skintokens": 14, "unirig": 8}
SHORT = {"skintokens": "SkinTokens", "unirig": "UniRig"}
# what the pack's own output says when the card is too small (PyTorch / CUDA / spconv wording)
# the pinned UniRig configs (commit 6793c664) hold these keys; the staged mode copies them with a smaller value
UNIRIG_BEAMS_KEY = r"^(\s*num_beams:\s*)\d+"            # configs/system/ar_inference_articulationxl.yaml  (generate_kwargs: num_beams: 15)
UNIRIG_CHUNK_KEY = r"^(\s*num_train_vertex:\s*)\d+"     # configs/model/unirig_skin.yaml                    (num_train_vertex: 512)
OOM_MARKERS = ("out of memory", "outofmemoryerror", "cuda error: out of memory", "cublas_status_alloc_failed", "cudnn_status_alloc_failed", "cudaerrormemoryallocation")


def emit(event, **kw):
    sys.stdout.write(json.dumps(dict(event=event, **kw)) + "\n")
    sys.stdout.flush()


def die(msg, code=EXIT_ERROR):
    emit("error", msg=msg)
    sys.exit(code)


# ---------------------------------------------------------------- mock model: a small skinned GLB, hand-written

def write_mock_glb(path, bones=5):
    """A strip of triangles skinned to a chain of `bones` generic joints ("Bone", "Bone.001" ...). Valid glTF 2.0."""
    n = bones
    # geometry: a ribbon along +Y (glTF up), 2 verts per segment boundary
    pos, joints, weights, idx = [], [], [], []
    for i in range(n + 1):
        y = i * 0.3
        for x in (-0.05, 0.05):
            pos.append((x, y, 0.0))
            a = min(i, n - 1)
            joints.append((a, 0, 0, 0))
            weights.append((1.0, 0.0, 0.0, 0.0))
    for i in range(n):
        a, b, c, d = 2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3
        idx += [a, b, c, c, b, d]
    ibm = []
    for i in range(n):          # inverse bind: undo each joint's translation (joint i sits at y = i * 0.3, parent-relative 0.3)
        ibm += [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -i * 0.3, 0, 1]
    chunks, views, accessors = [], [], []

    def add(data, target=None):
        pad = (-len(b"".join(chunks))) % 4
        if pad:
            chunks.append(b"\0" * pad)
        off = len(b"".join(chunks))
        chunks.append(data)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    pb = b"".join(struct.pack("<3f", *p) for p in pos)
    jb = b"".join(struct.pack("<4B", *j) for j in joints)
    wb = b"".join(struct.pack("<4f", *w) for w in weights)
    ib = b"".join(struct.pack("<H", i) for i in idx)
    mb = struct.pack(f"<{16 * n}f", *ibm)
    lo = [min(p[k] for p in pos) for k in range(3)]
    hi = [max(p[k] for p in pos) for k in range(3)]
    accessors += [
        {"bufferView": add(pb, 34962), "componentType": 5126, "count": len(pos), "type": "VEC3", "min": lo, "max": hi},
        {"bufferView": add(jb, 34962), "componentType": 5121, "count": len(joints), "type": "VEC4"},
        {"bufferView": add(wb, 34962), "componentType": 5126, "count": len(weights), "type": "VEC4"},
        {"bufferView": add(ib, 34963), "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        {"bufferView": add(mb), "componentType": 5126, "count": n, "type": "MAT4"},
    ]
    data = b"".join(chunks)
    data += b"\0" * ((-len(data)) % 4)
    nodes = [{"name": "Mesh", "mesh": 0, "skin": 0}]
    for i in range(n):
        node = {"name": "Bone" if i == 0 else f"Bone.{i:03d}", "translation": [0, 0.0 if i == 0 else 0.3, 0]}
        if i + 1 < n:
            node["children"] = [2 + i]
        nodes.append(node)
    doc = {
        "asset": {"version": "2.0", "generator": "vtp rigml_worker mock"},
        "scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": nodes,
        "meshes": [{"name": "MockMesh", "primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}, "indices": 3}]}],
        "skins": [{"joints": list(range(1, n + 1)), "inverseBindMatrices": 4, "skeleton": 1}],
        "buffers": [{"byteLength": len(data)}], "bufferViews": views, "accessors": accessors,
    }
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(data))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(data), 0x004E4942) + data
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(out)


def run_mock(a):
    emit("progress", pct=0.1, msg="Reading the model (mock)")
    t0 = time.time()
    steps = max(1, int(a.mock_delay * 4))
    for i in range(steps):
        time.sleep(a.mock_delay / steps)
        emit("progress", pct=round(0.1 + 0.8 * (i + 1) / steps, 3), msg="Thinking (mock)")
    if a.mock_fail:
        die(f"mock failure {a.mock_fail}", a.mock_fail)
    if a.mock_oom_above and a.faces and a.faces > a.mock_oom_above:
        die(oom_text(a.model), EXIT_VRAM)                 # a pretend card that cannot hold a proxy this big (tests of the retry)
    write_mock_glb(a.output)
    emit("done", output=os.path.abspath(a.output), seconds=round(time.time() - t0, 2))


# ---------------------------------------------------------------- real model

def vram_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=8)
        return int(out.stdout.strip().split("\n")[0])
    except Exception:
        return 0


def stream(cmd, code, env, pct0):
    """Run one command of the pack, relay its output as log lines, return (exit code, ran out of graphics memory?).
    Progress creeps from pct0 up to 0.9."""
    p = subprocess.Popen(cmd, cwd=code, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    pct = pct0
    oom = False
    for line in p.stdout:
        line = line.rstrip()
        if line:
            emit("log", msg=line[:300])
            if any(m in line.lower() for m in OOM_MARKERS):
                oom = True
            pct = min(0.9, pct + 0.01)
            emit("progress", pct=round(pct, 3), msg="Working")
    return p.wait(), oom


def oom_text(model):
    """What happened and what would work, in plain words (mirrors outOfMemoryText in shared/rigMl.ts)."""
    have = vram_mb()
    card = f" (this card has {round(have / 1024, 1)} GB)" if have else ""
    if model == "skintokens":
        return f"SkinTokens ran out of graphics memory{card}; it wants 14 GB. UniRig needs only 8 GB and is the better choice on a smaller card, or use “Skeleton for anything” (Blender), which needs no graphics memory."
    return f"UniRig ran out of graphics memory{card}; it wants 8 GB. Close other programs that use the graphics card (games, OBS scenes, browsers) and try again, or use “Skeleton for anything” (Blender), which needs no graphics memory."


def venv_dirs(python=None):
    """(venv root, its Scripts/ or bin/ folder) for the Python this worker runs on: the pack's own virtual environment."""
    exe = os.path.abspath(python or sys.executable)
    bindir = os.path.dirname(exe)
    return os.path.dirname(bindir), bindir


def pack_env(offline, python=None):
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    # the project's launch/inference/*.sh scripts call a bare `python`: put THIS environment's folder first on PATH (Scripts/ on
    # Windows, bin/ elsewhere) and set VIRTUAL_ENV, so they never pick up whatever Python the PC has on its PATH
    root, bindir = venv_dirs(python)
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
    env["VIRTUAL_ENV"] = root
    env.pop("PYTHONHOME", None)
    if offline:
        env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")      # SkinTokens: never fetch anything while running
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        env.pop(k, None)                                         # (the project's server fails to start with a proxy set)
    return env


def run_skintokens(a, code):
    entry = os.path.join(code, "demo.py")
    if not os.path.isfile(entry):
        die("The ML pack is not installed.", EXIT_MISSING)
    for need_file in ("experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt", "experiments/skin_vae_2_10_32768/last.ckpt", "models/Qwen3-0.6B/config.json"):
        if not os.path.isfile(os.path.join(code, need_file)):
            die(f"The ML pack is incomplete (missing {need_file}).", EXIT_MISSING)
    check_vram(a)
    cmd = [sys.executable, "-u", entry, "--input", os.path.abspath(a.input), "--output", os.path.abspath(a.output), "--use_transfer"]
    if a.staged and a.beams:
        cmd += ["--num_beams", str(a.beams)]          # demo.py: --num_beams (default 10); fewer beams = less memory
        emit("log", msg=f"Low-memory staged mode: SkinTokens with {a.beams} beams on a decimated copy of your model.")
    rc, oom = stream(cmd, code, pack_env(True), 0.1)
    if rc != 0 and oom:
        die(oom_text("skintokens"), EXIT_VRAM)
    return rc


def find_bash():
    """UniRig documents its three steps as `bash launch/inference/*.sh`. On Windows that needs a real bash (Git for Windows); the
    WSL launcher in System32 is skipped because it cannot see Windows paths the way the scripts expect."""
    import shutil
    for cand in (os.path.join(os.environ.get("ProgramFiles", ""), "Git", "bin", "bash.exe"), os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Git", "bin", "bash.exe")):
        if os.path.isfile(cand):
            return cand
    found = shutil.which("bash")
    if found and "system32" not in found.lower():
        return found
    return None


def lowmem_configs(code, beams, chunk, write=True):
    """The staged mode's copies of two pinned UniRig configs with smaller numbers (the originals are never touched):
         configs/system/ar_inference_articulationxl.yaml  num_beams        -> `beams`   (beam search keeps `beams` candidates in memory)
         configs/model/unirig_skin.yaml                   num_train_vertex -> `chunk`   (the skin step handles this many vertices at a time)
       and the two task files that point at them. Returns ({"skeleton_task":..., "skin_task":...}, [notes]); a task whose key is not
       found in the pack's file is left as it was (the note says so) - only keys that exist are changed."""
    import re
    notes, tasks = [], {}

    def derive(kind, name, edits):
        src = os.path.join(code, "configs", kind, name + ".yaml")
        if not os.path.isfile(src):
            notes.append(f"configs/{kind}/{name}.yaml not found: left as it is")
            return None
        text = open(src, encoding="utf-8").read()
        for pattern, value, label in edits:
            text, n = re.subn(pattern, lambda m: m.group(1) + str(value), text, count=1, flags=re.M)
            if not n:
                notes.append(f"{name}.yaml has no {label} line: left as it is")
        dst = os.path.join(code, "configs", kind, name + "_lowmem.yaml")
        if write:
            with open(dst, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
        return name + "_lowmem"

    sysname = derive("system", "ar_inference_articulationxl", [(UNIRIG_BEAMS_KEY, beams, "num_beams")] if beams else [])
    modname = derive("model", "unirig_skin", [(UNIRIG_CHUNK_KEY, chunk, "num_train_vertex")] if chunk else [])
    for task, comp, newname, key in (("quick_inference_skeleton_articulationxl_ar_256", "system", sysname, "skeleton_task"), ("quick_inference_unirig_skin", "model", modname, "skin_task")):
        path = os.path.join(code, "configs", "task", task + ".yaml")
        if not newname or not os.path.isfile(path):
            continue
        text = open(path, encoding="utf-8").read()
        base = newname[: -len("_lowmem")]
        text, n = re.subn(r"^(\s*" + comp + r":\s*)" + re.escape(base) + r"\s*$", lambda m: m.group(1) + newname, text, count=1, flags=re.M)
        if not n:
            notes.append(f"{task}.yaml does not name {base}: left as it is")
            continue
        out = os.path.join(code, "configs", "task", task + "_lowmem.yaml")
        if write:
            with open(out, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
        tasks[key] = "configs/task/" + task + "_lowmem.yaml"
    return tasks, notes


def unirig_steps(a, code, bash, work):
    """UniRig's three steps as SEPARATE processes (so the graphics card is completely empty between them), exactly the commands its
    README documents, plus - only in staged mode - flags the pinned scripts really take:
         bash launch/inference/generate_skeleton.sh --input <mesh> --output <skeleton.fbx> --seed N [--faces_target_count F] [--skeleton_task T]
         bash launch/inference/generate_skin.sh     --input <skeleton.fbx> --output <skin.fbx>      [--faces_target_count F] [--skin_task T]
         bash launch/inference/merge.sh             --source <skin.fbx> --target <mesh> --output <rigged.glb>
    Returns a list of dicts {name, argv, expect, pct}."""
    fwd = lambda p: os.path.abspath(p).replace("\\", "/")
    skel, skin = fwd(os.path.join(work, "skeleton.fbx")), fwd(os.path.join(work, "skin.fbx"))
    src, dst = fwd(a.input), fwd(a.output)
    sk_extra, sn_extra = [], []
    if a.staged:
        if a.faces:
            sk_extra += ["--faces_target_count", str(a.faces)]
            sn_extra += ["--faces_target_count", str(a.faces)]
        tasks, _ = lowmem_configs(code, a.beams, a.skin_chunk, write=False)
        if "skeleton_task" in tasks:
            sk_extra += ["--skeleton_task", tasks["skeleton_task"]]
        if "skin_task" in tasks:
            sn_extra += ["--skin_task", tasks["skin_task"]]
    return [
        {"name": "Reading the shape and drawing the skeleton", "argv": [bash, "launch/inference/generate_skeleton.sh", "--input", src, "--output", skel, "--seed", "12345"] + sk_extra, "expect": skel, "pct": 0.1},
        {"name": "Working out the skin weights", "argv": [bash, "launch/inference/generate_skin.sh", "--input", skel, "--output", skin] + sn_extra, "expect": skin, "pct": 0.4},
        {"name": "Putting the skeleton into your model", "argv": [bash, "launch/inference/merge.sh", "--source", skin, "--target", src, "--output", dst], "expect": dst, "pct": 0.7},
    ]


def run_unirig(a, code):
    """UniRig's own three steps, exactly as its README (pinned commit) documents them (see unirig_steps).
    (README: supported inputs .obj .fbx .glb .vrm; merging the skeleton file alone gives no skinning, so merge the skin result.)
    Not run on this PC: no model was downloaded here. The README does not say where the scripts look for the checkpoints, so the
    pack keeps them at the paths rigml_setup.ts installs them to. Its model config names facebook/opt-350m (config file only,
    Meta's OPT licence): the pack fetches that small file itself the first time, into its own folder (HF_HOME), so it is the
    one model that is not run offline."""
    if not os.path.isfile(os.path.join(code, "run.py")):
        die("The ML pack is not installed.", EXIT_MISSING)
    for need_file in ("skeleton/articulation-xl_quantization_256/model.ckpt", "skin/articulation-xl/model.ckpt"):
        if not os.path.isfile(os.path.join(code, need_file)):
            die(f"The ML pack is incomplete (missing {need_file}).", EXIT_MISSING)
    check_vram(a)
    bash = find_bash()
    if not bash:
        die("This add-on runs its steps with bash. Install Git for Windows (it includes bash) and try again.", EXIT_MISSING)
    env = pack_env(False)
    env["HF_HOME"] = os.path.join(os.path.dirname(code), "hf-home")
    work = os.path.join(os.path.dirname(code), "work")
    os.makedirs(work, exist_ok=True)
    if a.staged:
        tasks, notes = lowmem_configs(code, a.beams, a.skin_chunk)
        emit("log", msg=f"Low-memory staged mode: UniRig on a decimated copy ({a.faces or 'default'} faces), {a.beams or 'default'} beams, skin chunks of {a.skin_chunk or 'default'}; one step per process.")
        for n in notes:
            emit("log", msg="Note: " + n)
    steps = unirig_steps(a, code, bash, work)
    for st in steps[:2]:
        if os.path.isfile(st["expect"]):
            os.remove(st["expect"])
    for st in steps:
        emit("progress", pct=st["pct"], msg=st["name"])
        rc, oom = stream(st["argv"], code, env, st["pct"])       # (each step is its own process: the card is empty again when it ends)
        if rc != 0 and oom:
            die(oom_text("unirig"), EXIT_VRAM)
        if rc != 0 or not os.path.isfile(st["expect"]):
            return rc or 1
    return 0


def check_vram(a):
    """Only a note, never a refusal. The helper decides the mode before it starts the worker (shared/rigMl.ts rigPlan): a card under the
    authors' figure gets --staged (a decimated copy, one step per process); if the model still runs out of memory, run_* turns that
    into a plain message (exit code 4) and the helper retries once with a smaller copy, then falls back to the Blender templates."""
    if a.staged:
        return
    need = MIN_VRAM_GB[a.model]
    have = vram_mb()
    if have and have < need * 1024 - 64:
        emit("log", msg=f"Note: {SHORT[a.model]} wants {need} GB of graphics memory; this card has {round(have / 1024, 1)} GB.")
    elif not have:
        emit("log", msg="Note: could not read the graphics card's memory (nvidia-smi).")


def run_real(a):
    code = os.path.abspath(a.code_dir or "")
    os.makedirs(os.path.dirname(os.path.abspath(a.output)), exist_ok=True)
    emit("progress", pct=0.05, msg="Starting the model")
    t0 = time.time()
    code_ = (run_skintokens if a.model == "skintokens" else run_unirig)(a, code)
    if code_ != 0 or not os.path.isfile(a.output):
        die(f"The model stopped with code {code_}.", EXIT_ERROR)
    emit("done", output=os.path.abspath(a.output), seconds=round(time.time() - t0, 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["skintokens", "unirig"], required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--code-dir")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--mock-delay", type=float, default=0.0)
    ap.add_argument("--mock-fail", type=int, default=0)
    ap.add_argument("--mock-oom-above", type=int, default=0, help="mock: run out of graphics memory when --faces is above this")
    ap.add_argument("--staged", action="store_true", help="low-memory staged mode (the input is a decimated copy of the mesh)")
    ap.add_argument("--faces", type=int, default=0, help="staged: the proxy's face count (UniRig --faces_target_count)")
    ap.add_argument("--beams", type=int, default=0, help="staged: beam-search width (UniRig system config / SkinTokens --num_beams)")
    ap.add_argument("--skin-chunk", type=int, default=0, help="staged, UniRig: vertices per skinning chunk (num_train_vertex)")
    ap.add_argument("--plan", action="store_true", help="print the steps that would run and stop (nothing runs, nothing is written)")
    a = ap.parse_args()
    emit("start", model=a.model, mock=a.mock, staged=a.staged)
    if a.plan:
        code = os.path.abspath(a.code_dir or ".")
        if a.model == "unirig":
            steps = unirig_steps(a, code, find_bash() or "bash", os.path.join(os.path.dirname(code), "work"))
        else:
            steps = [{"name": "SkinTokens (one unified step)", "argv": [sys.executable, "demo.py", "--input", a.input, "--output", a.output, "--use_transfer"] + (["--num_beams", str(a.beams)] if a.staged and a.beams else [])}]
        emit("plan", steps=steps)
        return
    if not os.path.isfile(a.input):
        die("The input file is missing.")
    (run_mock if a.mock else run_real)(a)


if __name__ == "__main__":
    main()

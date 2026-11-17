"""Exit 0 if the user's live studio tracking is healthy, 1 if it is struggling (so background work should pause).
Reads the newest cache/diag/history/*state.json (written every 3 s by the live studio)."""
import glob, json, os, sys, time
files = sorted(glob.glob(os.path.join(os.path.dirname(__file__), '..', 'cache', 'diag', 'history', '*state.json')), key=os.path.getmtime)
if not files: print('no diag'); sys.exit(0)
d = json.load(open(files[-1])); s = d.get('stats', {})
age = time.time() - os.path.getmtime(files[-1])
# struggling = inference slow (GPU contention) or tracking far below a 30 fps camera
ok = age > 30 or (s.get('inferMs', 0) < 25 and s.get('trackFps', 60) > 24)
state = 'IDLE (studio not tracking / no fresh data)' if age > 30 else ('OK' if ok else 'STRUGGLING')
print(f"live: infer {s.get('inferMs', 0):.1f} ms, track {s.get('trackFps', 0):.0f} Hz, age {age:.0f}s -> {state}")
sys.exit(0 if ok else 1)

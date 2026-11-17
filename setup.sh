#!/usr/bin/env bash
# VTube Pro - setup + launcher for macOS / Linux (best effort; Windows users: double-click START_HERE.bat).
#
#   ./setup.sh [--yes] [--port N] [--quick] [--no-start] [--no-browser] [--detach] [--stop] [--dev] [--rebuild]
#
# Checks Node.js >= 22.12 + npm (+ git), runs npm ci when package-lock.json changed, creates config/settings.json
# from the example, optionally installs R&D models (--dev), builds when the
# sources changed and starts the server on http://127.0.0.1:<port>/ (default 5191). Safe to re-run.
set -u
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
STATE="$ROOT/.setup-state"
mkdir -p "$STATE"
MIN_NODE="22.12.0"
PORT="${VTP_PORT:-5191}"
YES=0; QUICK=0; NOSTART=0; NOBROWSER=0; DETACH=0; STOP=0; DEV=0; REBUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --port) PORT="$2"; shift ;;
    --quick) QUICK=1 ;;
    --no-start) NOSTART=1 ;;
    --no-browser) NOBROWSER=1 ;;
    --detach) DETACH=1 ;;
    --stop) STOP=1 ;;
    --dev) DEV=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
BASE="http://127.0.0.1:$PORT"

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step() { echo; c 36 "== $1"; }
ok() { c 32 "   [ok] $1"; }
warn() { c 33 "   [!] $1"; }
fail() { echo; c 31 "   [X] $1"; exit 1; }
ask() { # ask "question" default(y|n)
  if [ "$YES" = 1 ]; then echo "   $1 -> $2 (--yes)"; [ "$2" = y ]; return; fi
  local hint="[y/N]"; [ "$2" = y ] && hint="[Y/n]"
  while true; do
    read -r -p "   $1 $hint " a || a=""
    [ -z "$a" ] && a="$2"
    case "$a" in y|Y|yes) return 0 ;; n|N|no) return 1 ;; esac
  done
}
has() { command -v "$1" >/dev/null 2>&1; }
sha256() { if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# ver_ge A B -> A >= B for x.y.z versions (no `sort -V`: the sort on older macOS has no -V; tools/shell_compat.mjs)
vkey() { printf '%s\n' "$1" | awk -F. '{ printf "%06d%06d%06d\n", $1, $2, $3 }'; }
ver_ge() { [ "$(printf '%s\n%s\n' "$(vkey "$2")" "$(vkey "$1")" | LC_ALL=C sort | head -n1)" = "$(vkey "$2")" ]; }
is_vtp() { curl -fsS --max-time 3 "http://127.0.0.1:$1/api/settings" 2>/dev/null | grep -q '"comfyUrl"'; }
os_hint() {
  case "$(uname -s)" in
    Darwin) echo "   macOS: brew install $1   (Homebrew: https://brew.sh)" ;;
    Linux) if has apt-get; then echo "   Debian/Ubuntu: $2"; elif has dnf; then echo "   Fedora: $3"; else echo "   use your package manager"; fi ;;
  esac
}

if [ "$STOP" = 1 ]; then
  if [ -f "$STATE/server.pid" ]; then kill "$(cat "$STATE/server.pid")" 2>/dev/null; rm -f "$STATE/server.pid"; ok "stopped"; else warn "no detached server"; fi
  exit 0
fi

echo; c 35 "  VTube Pro setup"; c 90 "  folder: $ROOT"

step "Checking required tools"
NODE_V="$(node -v 2>/dev/null | sed 's/^v//')"
if [ -n "$NODE_V" ] && ver_ge "$NODE_V" "$MIN_NODE" && has npm; then ok "Node.js $NODE_V + npm"
else
  [ -n "$NODE_V" ] && warn "Node.js $NODE_V is too old (need $MIN_NODE+)." || warn "Node.js is not installed."
  echo "   Install the Node.js LTS (22 or newer):"
  os_hint "node" "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs" "sudo dnf install nodejs"
  echo "   or with nvm: https://github.com/nvm-sh/nvm  ->  nvm install --lts"
  fail "Node.js $MIN_NODE+ is required - install it and run ./setup.sh again."
fi
if has git; then ok "$(git --version)"; else warn "git is not installed (optional)"; os_hint git "sudo apt-get install -y git" "sudo dnf install git"; fi
if [ "$QUICK" = 0 ]; then
  if has blender; then ok "Blender: $(command -v blender)"; else echo "   Blender not found - OPTIONAL (only for creating / rebuilding avatars): https://www.blender.org/download/"; fi
fi


step "Installing app dependencies"
LOCK_HASH="$(sha256 package-lock.json)"
if [ "$REBUILD" = 1 ] || [ ! -f node_modules/.package-lock.json ] || [ "$(cat "$STATE/npm.lock" 2>/dev/null)" != "$LOCK_HASH" ]; then
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund || fail "npm could not install the dependencies"
  echo "$LOCK_HASH" > "$STATE/npm.lock"; ok "dependencies installed"
else ok "dependencies already up to date"; fi

step "Local configuration"
if [ ! -f config/settings.json ]; then cp config/settings.example.json config/settings.json; ok "created config/settings.json (stays on this PC)"; else ok "config/settings.json exists (kept)"; fi

step "Checking built-in assets"
for f in public/mediapipe/face_landmarker.task public/vendor/voice/silero_vad_v5.onnx assets/builtin/robot/robot.glb assets/hdri/hdri.json; do
  [ -f "$f" ] || fail "missing $f - download the repository again"
done
ok "tracking models, voice models, avatars, rooms present"

if [ "$DEV" = 1 ]; then
  step "Optional R&D downloads (--dev) from their original sources"
  node -e "
    const j=require('./tools/setup/downloads.json');
    for (const g of j.groups) for (const it of g.items) console.log([it.url,it.dest,it.sha256].join(' '));
  " | while read -r URL DEST SHA; do
    if [ -f "$DEST" ] && [ "$(sha256 "$DEST")" = "$SHA" ]; then continue; fi
    mkdir -p "$(dirname "$DEST")"
    curl -fL --retry 3 --progress-bar -o "$DEST.part" "$URL" || fail "download failed: $URL"
    [ "$(sha256 "$DEST.part")" = "$SHA" ] || { rm -f "$DEST.part"; fail "SHA-256 mismatch: $URL"; }
    mv "$DEST.part" "$DEST"; ok "$DEST"
  done
fi

step "Building the app"
# rebuild when any build input is newer than the last build stamp
if [ "$REBUILD" = 1 ] || [ ! -f dist/index.html ] || [ ! -f "$STATE/build.stamp" ] || \
   [ -n "$(find src shared public assets/hdri assets/raid assets/space assets/library/anims index.html output.html dj.html vite.config.ts package-lock.json -newer "$STATE/build.stamp" -print -quit 2>/dev/null)" ]; then
  npm run build || fail "the build failed"
  touch "$STATE/build.stamp"; ok "built dist/"
else ok "build is up to date"; fi

if [ "$NOSTART" = 1 ]; then step "Done"; echo "   Start later with ./setup.sh --quick (or npm start). Studio: $BASE/"; exit 0; fi

step "Starting VTube Pro on $BASE"
if is_vtp "$PORT"; then ok "VTube Pro is already running on port $PORT"; [ "$NOBROWSER" = 1 ] || { (open "$BASE/" || xdg-open "$BASE/") >/dev/null 2>&1 & }; exit 0; fi
if (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then fail "port $PORT is used by another program - try: ./setup.sh --quick --port 5291"; fi
export VTP_PORT="$PORT"
if [ "$DETACH" = 1 ]; then
  nohup node --import tsx server/index.ts > "$STATE/server.log" 2>&1 &
  echo $! > "$STATE/server.pid"
else
  node --import tsx server/index.ts &
fi
SPID=$!
for _ in $(seq 1 60); do sleep 0.5; is_vtp "$PORT" && break; kill -0 "$SPID" 2>/dev/null || fail "the server exited - see the messages above"; done
is_vtp "$PORT" || fail "the server did not start"
echo
c 32 "  VTube Pro is running."
echo "  Studio (Chrome / Edge):   $BASE/"
echo "  OBS Browser Source URL:   $BASE/output.html?focus=bust   (1920x1080, 60 FPS, hardware acceleration ON)"
[ "$NOBROWSER" = 1 ] || { (open "$BASE/" || xdg-open "$BASE/") >/dev/null 2>&1 & }
if [ "$DETACH" = 1 ]; then echo "  running in the background (PID $SPID) - stop: ./setup.sh --stop"; exit 0; fi
echo "  Press Ctrl+C to stop."
trap 'kill $SPID 2>/dev/null' INT TERM
wait "$SPID"

#!/usr/bin/env sh
# VTube Pro relay setup for macOS / Linux / Git Bash (Windows: double-click "Set up my relay.cmd" instead).
# Same steps as deploy.ps1: asks for your values, writes wrangler.local.toml, deploys with YOUR Cloudflare account,
# sets the secrets (typed into wrangler's hidden prompt) and prints what to paste where. Guide: docs/HOSTING_SETUP.md
#   sh deploy.sh             set up / update (Enter keeps the saved value)
#   sh deploy.sh --dry-run   practice run: nothing signed in, uploaded or saved
set -e
cd "$(dirname "$0")"
DRY=0; [ "$1" = "--dry-run" ] && DRY=1
TPL=wrangler.toml; CFG=wrangler.local.toml
run() { if [ $DRY = 1 ]; then echo "  [practice run] would run: npx wrangler@4 $*"; else npx --yes wrangler@4 "$@"; fi; }
getv() { [ -f "$CFG" ] && sed -n "s/^$1 = \"\(.*\)\"/\1/p" "$CFG" | head -n1 || true; }
ask() { # ask "question" current-value regex(empty=optional)
  while :; do
    printf '\n%s\n  > [%s] ' "$1" "${2:-Enter to skip}" >&2; read -r a || a=""
    [ -z "$a" ] && a="$2"; [ "$a" = "-" ] && a=""
    if [ -z "$3" ] || printf '%s' "$a" | grep -Eq "$3"; then printf '%s' "$a"; return; fi
    echo "  That doesn't look right. See docs/HOSTING_SETUP.md (step 1)." >&2
  done
}
command -v npx >/dev/null 2>&1 || { [ $DRY = 1 ] || { echo "Node.js is needed (it brings 'npx'): install the LTS version from https://nodejs.org, then run this again."; exit 1; }; }

# You and your guests sign in with YOUR OWN Discord application (discord.com/developers/applications): its Client ID is
# asked here, its client secret goes to wrangler's hidden prompt below. No shared or hosted sign-in exists.
CID=$(getv DISCORD_CLIENT_ID)
CID=$(ask "Your Discord app's CLIENT ID (only digits; Developer Portal -> your app -> OAuth2 -> Client ID)" "$CID" '^[0-9]{17,20}$')
# Who may host: the claim code shown at the end (HOST_USER_IDS is only kept as an advanced override).
HID=$(getv HOST_USER_IDS)
PUB=$(ask "Show name guests see (optional, - clears)" "$(getv PUBLIC_NAME)" '')
TURN=$(ask "Cloudflare TURN key id (optional, - clears)" "$(getv TURN_KEY_ID)" '')
DOM=$(ask "Your own address for guest links, e.g. join.example.com (optional, - clears)" "$([ -f "$CFG" ] && sed -n 's/^pattern = "\(.*\)"/\1/p' "$CFG" | head -n1)" '')
WD=true
if [ -n "$DOM" ]; then printf '\nSwitch OFF the old workers.dev address? Only once the new one works in VTube Pro and Discord. [y/N] '; read -r a || a=""; [ "$a" = "y" ] && WD=false; fi

esc() { printf '%s' "$1" | sed 's/[\\"&|]//g'; }
OUT=$(sed -e "s|^DISCORD_CLIENT_ID = \".*\"|DISCORD_CLIENT_ID = \"$(esc "$CID")\"|" -e "s|^HOST_USER_IDS = \".*\"|HOST_USER_IDS = \"$(esc "$HID")\"|" \
  -e "s|^PUBLIC_NAME = \".*\"|PUBLIC_NAME = \"$(esc "$PUB")\"|" -e "s|^TURN_KEY_ID = \".*\"|TURN_KEY_ID = \"$(esc "$TURN")\"|" \
  -e "s|^workers_dev = .*|workers_dev = $WD|" -e '/^# This file is the TEMPLATE/d' -e '/^# \[\[routes\]\]/d' -e '/^# pattern = /d' -e '/^# custom_domain = /d' \
  -e '/^# Optional: your own address for the relay/d' -e '/^# The domain must be on your Cloudflare/d' "$TPL")
[ -n "$DOM" ] && OUT="$OUT
# Your own address for the relay (private links). docs/HOSTING_SETUP.md#private-links
[[routes]]
pattern = \"$(esc "$DOM")\"
custom_domain = true"
if [ $DRY = 1 ]; then printf '\n[practice run] %s would be:\n%s\n' "$CFG" "$OUT"
else [ -f "$CFG" ] && cp "$CFG" "$CFG.bak"; printf '# YOUR relay settings (written by deploy.sh). Stays on this PC: git-ignored, never shipped.\n%s\n' "$OUT" > "$CFG"; fi

run login
LOG=$(mktemp 2>/dev/null || echo /tmp/vtp-deploy.log)
if [ $DRY = 1 ]; then run deploy -c "$CFG"; URL="https://vtube-pro-relay.<your-subdomain>.workers.dev"
else npx --yes wrangler@4 deploy -c "$CFG" 2>&1 | tee "$LOG"; URL=$(grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' "$LOG" | head -n1 || true); rm -f "$LOG"; fi
[ -n "$DOM" ] && URL="https://$DOM"

echo; echo "TICKET_SECRET: made for you."
if [ $DRY = 1 ]; then run secret put TICKET_SECRET -c "$CFG"
else printf "Make a new TICKET_SECRET? First time: y. Later: n (y signs everyone out). [y/N] "; read -r a || a=""
  [ "$a" = "y" ] && node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64'))" | npx --yes wrangler@4 secret put TICKET_SECRET -c "$CFG"; fi
printf "\nSet the DISCORD_CLIENT_SECRET now (your Discord app: OAuth2 -> Reset Secret -> Copy, paste at the hidden prompt)? [Y/n] "; read -r a || a=""
[ "$a" != "n" ] && run secret put DISCORD_CLIENT_SECRET -c "$CFG"
printf "Set the Discord BOT token now (optional; Bot -> Reset Token)? [y/N] "; read -r a || a=""
[ "$a" = "y" ] && run secret put DISCORD_BOT_TOKEN -c "$CFG"
if [ -n "$TURN" ]; then printf "Set the TURN_KEY_API_TOKEN now? [y/N] "; read -r a || a=""; [ "$a" = "y" ] && run secret put TURN_KEY_API_TOKEN -c "$CFG"; fi
# claim code: the first person who signs in with Discord in VTube Pro and types it becomes the host
printf "\nMake a claim code? First time: y. Later: only if you lost it or someone else should host. [y/N] "; read -r a || a=""
CODE=""
if [ "$a" = "y" ]; then
  CODE=$(node -e "const a='ABCDEFGHJKMNPQRSTUVWXYZ23456789',b=require('crypto').randomBytes(8);let s='';for(const x of b)s+=a[x%a.length];process.stdout.write(s.slice(0,4)+'-'+s.slice(4))" 2>/dev/null || echo "")
  if [ -n "$CODE" ]; then
    HASH=$(node -e "process.stdout.write(require('crypto').createHash('sha256').update('vtp-claim-v1|'+process.argv[1].toUpperCase().replace(/[^A-Z0-9]/g,'')).digest('hex'))" "$CODE")
    if [ $DRY = 1 ]; then run secret put HOST_CLAIM -c "$CFG"; else printf '%s' "$HASH" | npx --yes wrangler@4 secret put HOST_CLAIM -c "$CFG"; fi
  else echo "  (Node.js is needed to make a claim code.)"; fi
fi

echo
echo "DONE. 1) Discord -> your app -> OAuth2 -> Redirects, add both:"
echo "       http://127.0.0.1:5191/api/discord/callback"
echo "       $URL/cb"
echo "   2) VTube Pro -> multiplayer setup helper -> Paste & test:"
echo "       Relay address: $URL"
echo "       Client ID:     $CID"
if [ -n "$CODE" ]; then
  echo
  echo "   3) Then click Connect Discord and type this CLAIM CODE (it makes you the host; it works once):"
  echo
  echo "          $CODE"
  echo
fi
case "$URL" in *.workers.dev) echo "   Privacy: guest links show your Cloudflare workers.dev name. See docs/HOSTING_SETUP.md -> Private links.";; esac

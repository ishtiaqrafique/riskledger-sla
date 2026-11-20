#!/usr/bin/env bash
# Installs the SLA management module into RiskLedger.
# Usage (as root, from the folder this script is in):   bash install.sh [/opt/riskledger]
set -euo pipefail

APP="${1:-/opt/riskledger}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODEMAILER_VERSION="6.9.16"
ANCHOR='app.get("/api/audit"'
HOOK='require("./sla")(app, { pool, needAuth, needPwOk, needAdmin });'

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$APP/server/server.js" ] || die "RiskLedger not found at $APP (no server/server.js)."
[ -f "$APP/docker-compose.yml" ] || [ -f "$APP/compose.yaml" ] || [ -f "$APP/docker-compose.yaml" ] || die "No docker compose file in $APP."
command -v docker >/dev/null || die "docker is not installed."

STAMP="$(date +%Y%m%d-%H%M%S)"
say "Backing up server.js and package files to $APP/backup-$STAMP"
mkdir -p "$APP/backup-$STAMP"
cp -a "$APP/server/server.js" "$APP/server/package.json" "$APP/backup-$STAMP/"
[ -f "$APP/server/package-lock.json" ] && cp -a "$APP/server/package-lock.json" "$APP/backup-$STAMP/"

say "Copying SLA module files"
# files may sit in server/ + public/ subfolders, or all at the top level (GitHub upload)
SRC_SERVER="$HERE/server"; SRC_PUBLIC="$HERE/public"
[ -f "$SRC_SERVER/sla.js" ] || SRC_SERVER="$HERE"
[ -f "$SRC_PUBLIC/sla.html" ] || SRC_PUBLIC="$HERE"
for f in "$SRC_SERVER/sla.js" "$SRC_PUBLIC/sla.html" "$SRC_PUBLIC/sla.css" "$SRC_PUBLIC/sla-app.js"; do
  [ -f "$f" ] || die "Missing $f"
done
install -m 0644 "$SRC_SERVER/sla.js"      "$APP/server/sla.js"
install -m 0644 "$SRC_PUBLIC/sla.html"    "$APP/public/sla.html"
install -m 0644 "$SRC_PUBLIC/sla.css"     "$APP/public/sla.css"
install -m 0644 "$SRC_PUBLIC/sla-app.js"  "$APP/public/sla-app.js"
[ -f "$SRC_PUBLIC/sla-embed.js" ] && install -m 0644 "$SRC_PUBLIC/sla-embed.js" "$APP/public/sla-embed.js"

if [ -f "$HERE/integrate.py" ] && [ -f "$APP/public/sla-embed.js" ]; then
  say "Adding Contracts & SLAs to the RiskLedger menu"
  [ -f "$APP/public/index.html" ] && cp -a "$APP/public/index.html" "$APP/backup-$STAMP/index.html"
  python3 "$HERE/integrate.py" "$APP/public/index.html" || die "Menu integration failed (index.html unchanged). The SLA page still works at /sla.html."
fi

say "Hooking the module into server.js"
if grep -qF 'require("./sla")' "$APP/server/server.js"; then
  echo "Already hooked in; skipping."
else
  grep -qF "$ANCHOR" "$APP/server/server.js" || die "Could not find '$ANCHOR' in server.js. Add this line by hand after the auth middleware: $HOOK"
  for fn in pool needAuth needPwOk needAdmin; do
    grep -qE "(const|let|var|function)[^=]*\b$fn\b" "$APP/server/server.js" || die "server.js has no '$fn'. Add the hook by hand: $HOOK"
  done
  # insert the hook on its own line just before the audit route
  awk -v anchor="$ANCHOR" -v hook="$HOOK" 'index($0, anchor)==1 && !done {print hook; done=1} {print}' \
    "$APP/server/server.js" > "$APP/server/server.js.new"
  mv "$APP/server/server.js.new" "$APP/server/server.js"
  grep -nF 'require("./sla")' "$APP/server/server.js"
fi

say "Adding nodemailer $NODEMAILER_VERSION to server/package.json (via a temporary node container)"
if grep -q '"nodemailer"' "$APP/server/package.json"; then
  echo "nodemailer already listed; skipping."
else
  docker run --rm -v "$APP/server":/app -w /app node:22-alpine \
    npm install "nodemailer@$NODEMAILER_VERSION" --package-lock-only --no-audit --no-fund --save-exact
fi

say "Rebuilding and restarting RiskLedger"
cd "$APP"
docker compose up -d --build

say "Checking the SLA page"
ok=""
for i in $(seq 1 30); do
  code="$(curl -k -s -o /dev/null -w '%{http_code}' https://localhost:8443/sla.html || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
docker compose logs --tail=20 app || true
if [ -n "$ok" ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\n\033[1;32mDone. Open https://%s:8443/#sla (Contracts & SLAs in the RiskLedger menu).\033[0m\n' "${IP:-<server-ip>}"
  echo "Then go to Settings to set up email (SMTP) and send a test email."
  echo "To undo: copy server.js and package files from $APP/backup-$STAMP into $APP/server, index.html into $APP/public, then run: docker compose up -d --build"
else
  die "sla.html did not answer with HTTP 200. Check the log above. Backup is in $APP/backup-$STAMP."
fi

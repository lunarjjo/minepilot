#!/usr/bin/env bash
# minepilot — download-and-run launcher.
#
#   ./run.sh            full local demo: a throwaway vanilla server + the
#                       bot + the web cockpit. one command, zero config.
#                       Ctrl-C stops everything.
#   ./run.sh connect    connect the bot + cockpit to any server:
#                       MINEPILOT_HOST=... MINEPILOT_PORT=... ./run.sh connect
#   ./run.sh console    just the web cockpit + stdin REPL (bot connects
#                       through env / flags as above, default localhost)
#
# requirements: node >= 20, curl; java for demo mode
#   (java 25+  -> demo runs minecraft 26.2
#    java 21-24 -> demo runs minecraft 1.21.8
#    override with MC_VERSION if you want a specific one)
#
# env knobs (all optional):
#   PORT             cockpit port           (default 3000)
#   MINEPILOT_HOST   connect-mode host      (default 127.0.0.1)
#   MINEPILOT_PORT   connect-mode port      (default 25565)
#   MINEPILOT_USERNAME  bot name            (default Minepilot)
#   MINEPILOT_VERSION  force the mc version (default: auto)
#   MC_PORT          demo server port       (default 25565)
#   MC_VERSION       force a vanilla version (default: picked from your java)
#   MC_DIR           demo server directory  (default "mcserver")
#   MC_SEED          world seed             (default "minepilot-demo")
#   MC_LEVEL         terrain shape          (default superflat; empty = natural)
#   MC_HEAP          java heap cap          (default 1024M)
#   JAVA_BIN         java executable        (default: java from PATH)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-demo}"
PORT="${PORT:-3000}"
MC_PORT="${MC_PORT:-25565}"
MC_DIR="${MC_DIR:-mcserver}"
MC_SEED="${MC_SEED:-minepilot-demo}"
MC_LEVEL="${MC_LEVEL:-minecraft\:flat}"
MC_HEAP="${MC_HEAP:-1024M}"
JAVA_BIN="${JAVA_BIN:-java}"

c_info ()  { printf '\033[1;35m[minepilot]\033[0m %s\n' "$*"; }
c_ok ()    { printf '\033[1;32m[minepilot]\033[0m %s\n' "$*"; }
c_err ()   { printf '\033[1;31m[minepilot]\033[0m %s\n' "$*" >&2; }
die ()     { c_err "$*"; exit 1; }

# ---------------------------------------------------------------- node check
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found: $(node -v 2>/dev/null || echo none)). ubuntu: sudo apt install nodejs npm (or use nvm)"
command -v curl >/dev/null || die "curl is required. ubuntu: sudo apt install curl"

# ------------------------------------------------------- dependencies check
if [ ! -d node_modules ]; then
  c_info "first run: installing node dependencies (a minute or two)…"
  npm install --no-audit --no-fund --loglevel=error
  c_ok "dependencies installed."
fi

port_busy () { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

STACK_PID=""
cleanup () {
  [ -n "$STACK_PID" ] && kill "$STACK_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  exit 0
}
trap 'cleanup' INT TERM

start_stack () {
  if port_busy "$PORT"; then die "port $PORT is already in use — stop the other process or set PORT=xxxx ./run.sh"; fi
  c_ok "cockpit starting on http://127.0.0.1:$PORT"
  PORT="$PORT" "$@" node src/index.js &
  STACK_PID=$!
  while kill -0 "$STACK_PID" 2>/dev/null; do sleep 1; done
}

if [ "$MODE" = "console" ]; then
  start_stack
fi
if [ "$MODE" = "connect" ]; then
  start_stack MINEPILOT_HOST="${MINEPILOT_HOST:-127.0.0.1}" MINEPILOT_PORT="${MINEPILOT_PORT:-25565}" MINEPILOT_USERNAME="${MINEPILOT_USERNAME:-Minepilot}" ${MINEPILOT_VERSION:+MINEPILOT_VERSION="$MINEPILOT_VERSION"}
fi
[ "$MODE" = "demo" ] || die "unknown mode '$MODE' — use './run.sh demo', './run.sh connect' or './run.sh console'"

# ---------------------------------------------------------------- java check
JAVA_MAJOR=$("$JAVA_BIN" -version 2>&1 | head -1 | sed 's/^[^"]*"\([0-9]*\).*/\1/')
if [ -z "${JAVA_MAJOR:-}" ] || [ "$JAVA_MAJOR" -eq 0 ] 2>/dev/null; then
  c_err "demo mode needs java, which was not found."
  c_err "  ubuntu 22/24: sudo apt install openjdk-21-jre-headless   (demo will run minecraft 1.21.8)"
  c_err "  for minecraft 26.x: install a java 25+ jre and put it on PATH (or set JAVA_BIN=...)"
  c_err "  connect mode still works: MINEPILOT_HOST=... ./run.sh connect"
  exit 1
fi
if [ -z "${MC_VERSION:-}" ]; then
  if [ "$JAVA_MAJOR" -ge 25 ]; then MC_VERSION=26.2; else MC_VERSION=1.21.8; fi
fi
c_info "java $JAVA_MAJOR detected -> demo server: minecraft $MC_VERSION"

# ------------------------------------------------------- fetch vanilla server
mkdir -p "$MC_DIR"
if [ ! -f "$MC_DIR/server.jar" ]; then
  c_info "downloading vanilla $MC_VERSION server (first run only)…"
  URL=$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).versions.find(x=>x.id===process.argv[1]);if(!v){process.exit(2)}console.log(v.url)})' "$MC_VERSION" \
    | xargs curl -s \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).downloads.server.url;console.log(u)})') \
    || die "could not resolve the download for minecraft $MC_VERSION (check the version id)"
  curl -f -o "$MC_DIR/server.jar" "$URL" || die "server jar download failed"
  c_ok "server jar saved to $MC_DIR/server.jar"
fi

printf 'eula=true\n' > "$MC_DIR/eula.txt"

# op the demo bot (offline uuid) so e2e runs can /give themselves materials
BOT_OPS_UUID=$(node -e "
const crypto = require('crypto')
const h = crypto.createHash('md5').update('OfflinePlayer:' + (process.env.MINEPILOT_USERNAME || 'Minepilot')).digest()
h[6] = (h[6] & 0x0f) | 0x30
h[8] = (h[8] & 0x3f) | 0x80
const s = h.toString('hex')
console.log(s.slice(0,8) + '-' + s.slice(8,12) + '-' + s.slice(12,16) + '-' + s.slice(16,20) + '-' + s.slice(20))
" 2>/dev/null || echo 8628d38b-3759-3cc8-9693-a7e097beb72b)
printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":true}]\n' "$BOT_OPS_UUID" "${MINEPILOT_USERNAME:-Minepilot}" > $MC_DIR/ops.json

if [ ! -f "$MC_DIR/server.properties" ]; then
  cat > "$MC_DIR/server.properties" <<PROPS
online-mode=false
server-port=$MC_PORT
level-seed=$MC_SEED
generate-structures=false
view-distance=6
spawn-protection=0
sync-chunk-writes=false
motd=minepilot demo
max-players=8
white-list=false
spawn-monsters=false
level-type=$MC_LEVEL
spawn-monsters=false
PROPS
fi
# minecraft 26.x regenerates server.properties with white-list=true when the
# key is absent — keep our value alive across regenerations
if grep -q '^white-list=' "$MC_DIR/server.properties"; then
  sed -i "s/^white-list=.*/white-list=false/" "$MC_DIR/server.properties"
else
  printf 'white-list=false\n' >> "$MC_DIR/server.properties"
fi
if port_busy "$MC_PORT"; then die "port $MC_PORT is already in use — stop the other server or set MC_PORT=xxxx ./run.sh"; fi

# ------------------------------------------------------------- boot the server
c_info "starting demo server on port $MC_PORT (heap $MC_HEAP, first boot takes a while)…"
( cd "$MC_DIR" && exec "$JAVA_BIN" -Xms512M -Xmx"$MC_HEAP" -jar server.jar nogui ) &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

LOG="$MC_DIR/logs/latest.log"
DEADLINE=$(( $(date +%s) + 300 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    c_err "the minecraft server exited early — its last log lines:"
    tail -n 15 "$LOG" 2>/dev/null || true
    exit 1
  fi
  if [ -f "$LOG" ] && grep -q 'Done (' "$LOG"; then break; fi
  sleep 2
done
if [ -f "$LOG" ] && grep -q 'Done (' "$LOG"; then
  c_ok "minecraft $MC_VERSION is up on 127.0.0.1:$MC_PORT"
else
  c_err "server did not report Done within 300s — check $LOG"
  exit 1
fi

# ------------------------------------------------------------ start the stack
c_info "cockpit: http://127.0.0.1:$PORT — the bot is connecting to the demo server."
c_info "click the map to walk it; drag to select an area; try 'mine 8 stone' in the console."
c_info "Ctrl-C stops the cockpit and the demo server."
start_stack MINEPILOT_HOST=127.0.0.1 MINEPILOT_PORT="$MC_PORT" MINEPILOT_USERNAME="Minepilot" MINEPILOT_VERSION="$MC_VERSION"
c_info "cockpit stopped — stopping the demo server too."

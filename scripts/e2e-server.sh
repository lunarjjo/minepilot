#!/usr/bin/env bash
# boots a throwaway vanilla minecraft server for the e2e check in test/live.js.
# requires java 21+ (minecraft 26.x requires java 25). the server lands in
# ./server (gitignored) with a fixed superflat seed so runs are deterministic.
#
# env knobs:
#   MC_VERSION     vanilla version (default 1.21.8)
#   MC_DIR         server directory (default "server")
#   MC_PORT        listening port (default 25565)
#   MC_LEVEL_TYPE  minecraft:flat for superflat, default for real terrain
#   MC_SEED        level seed (default "botfleet")
#   MC_HEAP        java heap cap (default 1024M)
#
# terrain server for the pilot engine checks:
#   MC_DIR=server-normal MC_PORT=25566 MC_LEVEL_TYPE=default MC_SEED=botfleet2 ./scripts/e2e-server.sh
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${MC_VERSION:-1.21.8}"
DIR="${MC_DIR:-server}"
PORT="${MC_PORT:-25565}"
LEVEL_TYPE="${MC_LEVEL_TYPE:-minecraft\:flat}"
SEED="${MC_SEED:-botfleet}"
HEAP="${MC_HEAP:-1024M}"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f server.jar ]; then
  echo "downloading vanilla $VERSION server..."
  URL=$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json \
    | python3 -c "import json,sys; m=json.load(sys.stdin); print(next(v['url'] for v in m['versions'] if v['id']=='$VERSION'))" \
    | xargs curl -s \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['downloads']['server']['url'])")
  curl -s -o server.jar "$URL"
fi

[ -f eula.txt ] || echo 'eula=true' > eula.txt
if [ ! -f server.properties ]; then
  PROPS="online-mode=false
server-port=$PORT
level-type=$LEVEL_TYPE
level-seed=$SEED
generate-structures=false
view-distance=6
spawn-protection=0
sync-chunk-writes=false
motd=botfleet e2e
max-players=8
white-list=false"
  printf '%s\n' "$PROPS" > server.properties
fi

# minecraft 26.x regenerates server.properties with white-list=true when the
# key is absent — make sure our value survives regeneration on every boot
if grep -q '^white-list=' server.properties; then
  sed -i 's/^white-list=.*/white-list=false/' server.properties
else
  echo 'white-list=false' >> server.properties
fi

echo "starting server (heap $HEAP, port $PORT, dir $DIR)..."
exec java -Xms512M -Xmx"$HEAP" -jar server.jar nogui

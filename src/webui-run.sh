#!/bin/bash
# Supervisor that keeps the Nest web-ui API alive alongside sshd.
#
# Deliberately NOT `set -e`: this script's entire purpose is to outlive a
# crashing child and keep restarting it. Any failure that should stop the
# supervisor entirely does so via an explicit `exit 0` (never nonzero -
# sshd and the container must stay up regardless of what happens here) or
# by falling through to the log-and-exit paths below.
set -u

[ -r /run/devcontainer/webui.env ] && {
  set -a
  . /run/devcontainer/webui.env
  set +a
}

DIR="${WEBUI_DIR:-/opt/webui}"
ENTRY="$DIR/api/dist/main.js"

log() {
  echo "webui-run.sh: $*" >&2
}

# 1. Pinned interpreter. Never resolve `node` from PATH: the login shell's
# .bashrc puts $HOME/.n/bin first, so a stray `n 22` on the host would hand
# this supervisor a different Node ABI than the one the api was built
# against.
NODE_BIN_FILE="$DIR/.node-bin"
NODE=""
if [ -r "$NODE_BIN_FILE" ]; then
  NODE="$(cat "$NODE_BIN_FILE" 2>/dev/null)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="/usr/local/bin/node"
fi
if [ ! -x "$NODE" ]; then
  log "no usable node interpreter (checked $NODE_BIN_FILE and /usr/local/bin/node) - not starting the web ui"
  exit 0
fi

# 2. ABI check. A mismatch means the pinned node was rebuilt/replaced since
# the api's native deps were built against it; log both values and exit
# cleanly rather than crash-loop against an ABI it cannot load.
NODE_ABI_FILE="$DIR/.node-abi"
if [ -r "$NODE_ABI_FILE" ]; then
  expected_abi="$(cat "$NODE_ABI_FILE" 2>/dev/null)"
  actual_abi="$("$NODE" -p 'process.versions.modules' 2>/dev/null)"
  if [ -z "$actual_abi" ] || [ "$actual_abi" != "$expected_abi" ]; then
    log "node ABI mismatch: expected '$expected_abi' (from $NODE_ABI_FILE), got '$actual_abi' (from $NODE) - not starting the web ui"
    exit 0
  fi
fi

# 3. Tolerate a bind-mount override of $DIR with unbuilt source.
if [ ! -f "$ENTRY" ]; then
  log "entry point $ENTRY not found (bind-mounted $DIR without a build?) - not starting the web ui"
  exit 0
fi

# 4. Restart loop with exponential backoff: 1s -> doubling -> capped at 60s,
# reset to 1s once the child has proven itself by running >= 30s.
backoff=1
while :; do
  started_at="$(date +%s)"
  "$NODE" "$ENTRY"
  code=$?
  ended_at="$(date +%s)"
  ran_for=$((ended_at - started_at))

  log "api exited with code $code after ${ran_for}s"

  if [ "$ran_for" -ge 30 ]; then
    backoff=1
  fi

  log "restarting in ${backoff}s"
  sleep "$backoff"

  backoff=$((backoff * 2))
  if [ "$backoff" -gt 60 ]; then
    backoff=60
  fi
done

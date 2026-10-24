#!/bin/sh
# Starts Tailscale in userspace mode, exposes the Hub on the tailnet over HTTPS, then runs the
# Scion Hub bound to loopback. Nothing listens on a public interface. If either process dies,
# the container exits so Railway restarts it instead of running a Hub nobody can reach.
set -eu

fail() { echo "grove-hub: $*" >&2; exit 1; }

: "${SCION_SERVER_SESSION_SECRET:?SCION_SERVER_SESSION_SECRET is required; it also encrypts Hub secrets, never rotate it casually}"
: "${GROVE_PUBLIC_URL:?GROVE_PUBLIC_URL is required, e.g. https://grove-hub.<tailnet>.ts.net}"
: "${GROVE_ADMIN_EMAIL:?GROVE_ADMIN_EMAIL is required (the GitHub account email allowed to administer the Hub)}"

case "$GROVE_PUBLIC_URL" in
  https://*.ts.net|https://*.ts.net/) ;;
  *) fail "GROVE_PUBLIC_URL must be the tailnet HTTPS name (https://<host>.<tailnet>.ts.net)";;
esac

DATA="${GROVE_DATA_DIR:-/data}"

# Refuse to start on ephemeral storage: the database, the secrets and the node identity must
# survive redeploys. Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached.
[ "${RAILWAY_VOLUME_MOUNT_PATH:-}" = "$DATA" ] || [ "${GROVE_ALLOW_EPHEMERAL:-0}" = "1" ] \
  || fail "no Railway volume mounted at $DATA (RAILWAY_VOLUME_MOUNT_PATH='${RAILWAY_VOLUME_MOUNT_PATH:-}')"
probe="$DATA/.grove-write-probe"
( : > "$probe" && rm -f "$probe" ) || fail "$DATA is not writable"

TS_SOCK=/tmp/tailscaled.sock
export HOME="$DATA/home"
mkdir -p "$HOME/.scion" "$DATA/tailscale" "$DATA/storage"
chmod 700 "$DATA/tailscale" "$HOME/.scion"

tailscaled --tun=userspace-networking --statedir="$DATA/tailscale" --socket="$TS_SOCK" &
TS_PID=$!
SCION_PID=""

stop_all() {
  [ -n "$SCION_PID" ] && kill "$SCION_PID" 2>/dev/null || true
  kill "$TS_PID" 2>/dev/null || true
}
trap 'stop_all; exit 143' TERM INT

i=0
until [ -S "$TS_SOCK" ]; do
  i=$((i + 1)); [ "$i" -le 60 ] || { stop_all; fail "tailscaled socket did not appear"; }
  sleep 0.5
done

# The node identity lives on the volume, so the auth key is needed on first boot only.
set -- --hostname="${TS_HOSTNAME:-grove-hub}" --advertise-tags="${TS_TAGS:-tag:grove-hub}" --accept-dns=false
if [ -f "$DATA/tailscale/tailscaled.state" ] && [ -z "${TS_AUTHKEY:-}" ]; then
  tailscale --socket="$TS_SOCK" up "$@"
else
  [ -n "${TS_AUTHKEY:-}" ] || { stop_all; fail "TS_AUTHKEY is required on first boot (one-off, pre-approved, tagged tag:grove-hub)"; }
  # The key goes through a 0600 file so it never appears in the process list.
  umask 077
  printf '%s' "$TS_AUTHKEY" > /tmp/ts-authkey
  tailscale --socket="$TS_SOCK" up --auth-key="file:/tmp/ts-authkey" "$@"
  rm -f /tmp/ts-authkey
  umask 022
fi

tailscale --socket="$TS_SOCK" serve --bg --https=443 http://127.0.0.1:8080

cat > "$HOME/.scion/settings.yaml" <<EOF
schema_version: "1"
server:
  mode: hosted
  env: prod
  log_level: ${SCION_LOG_LEVEL:-info}
  hub:
    host: "127.0.0.1"
    public_url: "${GROVE_PUBLIC_URL%/}"
  database:
    driver: sqlite
    url: "$DATA/hub.db"
  storage:
    provider: local
    local_path: "$DATA/storage"
  secrets:
    backend: local
  auth:
    dev_mode: false
    user_access_mode: invite_only
EOF

scion --global server start \
  --foreground \
  --production \
  --enable-hub \
  --enable-web \
  --web-port 8080 \
  --host 127.0.0.1 \
  --base-url "${GROVE_PUBLIC_URL%/}" \
  --admin-emails "$GROVE_ADMIN_EMAIL" &
SCION_PID=$!

# Readiness: the Hub answers locally and Serve is configured. Logged, not fatal, so a slow
# first migration doesn't loop the container.
i=0
until curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 120 ] || { echo "grove-hub: Hub not healthy after 120s, still waiting" >&2; break; }
  sleep 1
done
tailscale --socket="$TS_SOCK" serve status >&2 || true

while kill -0 "$TS_PID" 2>/dev/null && kill -0 "$SCION_PID" 2>/dev/null; do
  sleep 5
done
echo "grove-hub: a supervised process exited; stopping so Railway restarts the container" >&2
stop_all
exit 1

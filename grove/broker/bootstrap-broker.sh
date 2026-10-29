#!/bin/sh
# One-time broker registration. Run as the grove user on the broker VM:
#   grove-bootstrap https://grove-hub.<tailnet>.ts.net [broker-name]
#
# It signs in to the Hub with GitHub device flow (approve the code on your phone), mints a
# single-use join token for this broker, redeems it, then signs out. The sign-out runs on every
# exit path, including failures and Ctrl-C, so the broker host never keeps a user login.
set -eu

HUB="${1:?usage: grove-bootstrap https://grove-hub.<tailnet>.ts.net [broker-name]}"
NAME="${2:-grove-broker-1}"
HUB="${HUB%/}"

[ "$(id -un)" = grove ] || { echo "Run this as the grove user." >&2; exit 1; }
[ -f /var/lib/grove-provisioned ] || { echo "Provisioning did not finish. Run: cloud-init status --long" >&2; exit 1; }
# Tailscale SSH sessions may not get a logind session; systemctl --user and rootless Podman need this.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if ! curl -fsS "$HUB/healthz" >/dev/null; then
  echo "The Hub does not answer at $HUB/healthz over the tailnet. Check that grove-hub shows as" >&2
  echo "connected in the Tailscale admin console and that the Railway deploy is running." >&2
  exit 1
fi

umask 077
tokfile="$(mktemp)"
logged_in=0
cleanup() {
  status=$?
  rm -f "$tokfile"
  if [ "$logged_in" = 1 ] && ! scion hub auth logout >/dev/null 2>&1; then
    echo "ERROR: sign-out failed, so your user login is still on this broker. Run 'scion hub auth logout' now." >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

scion config set --global hub.endpoint "$HUB"
scion config set --global use_host_credentials false
scion config set --global image_registry "${GROVE_IMAGE_REGISTRY:-ghcr.io/homebrew-scion}"

echo "Signing in with GitHub device flow. Open the link on your phone and enter the code."
logged_in=1
scion hub auth login --hub-url "$HUB" --no-browser --provider github

json="$(scion hub brokers join-token create "$NAME" --ttl 30m --json)"
broker_id="$(printf '%s' "$json" | jq -er .brokerId)"
printf '%s' "$json" | jq -er .joinToken > "$tokfile"
json=""

SCION_HUB_ENDPOINT="$HUB" scion runtime-broker join --broker-id "$broker_id" --token-file "$tokfile"

mkdir -p "$HOME/.config/grove"
printf 'SCION_HUB_ENDPOINT=%s\nGROVE_BROKER_NAME=%s\n' "$HUB" "$NAME" > "$HOME/.config/grove/broker.env"

systemctl --user daemon-reload
systemctl --user enable --now scion-broker.service
sleep 5
systemctl --user --no-pager status scion-broker.service | head -n 12 || true

echo
echo "Broker $NAME ($broker_id) has joined the Hub. Signing out of your user account now."
echo "Next, in the Hub dashboard: open your project, Settings > Resources > Runtime Brokers, link $NAME."

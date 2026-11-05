#!/bin/sh
# Grove smoke test. Run as the grove user on the broker VM after grove-bootstrap.
#
#   grove-smoke                               infrastructure checks only
#   GROVE_RUN_AGENTS=1 grove-smoke <project>  also runs a maker (Claude Code) and a checker (Codex)
#
# The agent phase needs an operator credential, because the broker keeps none. Create a
# project token in the Hub dashboard (Create Token, scopes agent:manage and project:read,
# expiry 2h); the script asks for it without echoing and never writes it to disk. Revoke the
# token afterwards.
#
# Output goes to ~/grove-smoke/<utc-timestamp>/ with a receipt.json. The agent phase passes
# only with evidence: both agents reach a terminal state, run in distinct containers, the
# maker's SMOKE.md exists with the expected line, and the checker's log contains PASS.
set -u

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
ENV_FILE="$HOME/.config/grove/broker.env"
[ -r "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Run grove-bootstrap first." >&2; exit 2; }
. "$ENV_FILE"
HUB="${SCION_HUB_ENDPOINT%/}"
BROKER="${GROVE_BROKER_NAME:-grove-broker-1}"

OUT="$HOME/grove-smoke/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
fails=0

record() { printf '%s\t%s\n' "$1" "$2" >> "$RESULTS"; }
check() {
  name="$1"; shift
  if "$@" >"$OUT/$name.log" 2>&1; then code=0; echo "PASS  $name"
  else code=$?; echo "FAIL  $name  (see $OUT/$name.log)"; fails=$((fails + 1)); fi
  record "$name" "$code"
}

git_ok() {
  v="$(git --version | awk '{print $3}')"
  [ "$(printf '%s\n2.48.0\n' "$v" | sort -V | head -n 1)" = "2.48.0" ]
}

check hub-healthz      curl -fsS "$HUB/healthz"
check hub-readyz       curl -fsS "$HUB/readyz"
check broker-service   systemctl --user is-active --quiet scion-broker.service
check broker-status    scion runtime-broker status
check podman-rootless  sh -c 'podman info --format "{{.Host.Security.Rootless}}" | grep -qx true'
check podman-run       podman run --rm docker.io/library/busybox:1.36 true
check git-2-48         git_ok
check inotify-limits   sh -c '[ "$(cat /proc/sys/fs/inotify/max_user_watches)" -ge 524288 ]'
check no-host-creds    grep -Eq '^[[:space:]]*use_host_credentials:[[:space:]]*false' "$HOME/.scion/settings.yaml"

# The maker's worktree must exist and hold SMOKE.md with exactly the expected line.
smoke_file_ok() {
  dir="$(grep -F "/$1/" "$OUT/worktrees.txt" | head -n 1)"
  [ -n "$dir" ] && [ -f "$dir/SMOKE.md" ] && [ "$(cat "$dir/SMOKE.md")" = "$2" ]
}

agents_phase() {
  project="$1"
  stamp="$(date -u +%H%M%S)"
  maker="smoke-maker-$stamp"
  checker="smoke-checker-$stamp"
  expected="grove smoke $stamp"
  deadline=$(( $(date +%s) + ${GROVE_AGENT_DEADLINE_SECONDS:-900} ))

  if [ -z "${SCION_HUB_TOKEN:-}" ]; then
    printf 'Project token (input hidden): ' >&2
    stty -echo 2>/dev/null; IFS= read -r SCION_HUB_TOKEN; stty echo 2>/dev/null; echo >&2
  fi
  [ -n "$SCION_HUB_TOKEN" ] || { echo "No token given." >&2; return 1; }
  export SCION_HUB_TOKEN

  # Try both agents even if one fails, then confirm neither is still listed as running.
  cleanup_agents() {
    bad=0
    for a in "$maker" "$checker"; do
      scion stop "$a" >> "$OUT/cleanup.log" 2>&1 || true
      scion delete "$a" >> "$OUT/cleanup.log" 2>&1 || { echo "delete failed for $a" >> "$OUT/cleanup.log"; bad=1; }
    done
    scion list > "$OUT/list-after-cleanup.txt" 2>&1 || bad=1
    if grep -E "$maker|$checker" "$OUT/list-after-cleanup.txt" | grep -qiE 'running|starting|creating'; then bad=1; fi
    return "$bad"
  }
  finish_agents() {
    if cleanup_agents; then record cleanup 0; else record cleanup 1; fails=$((fails + 1)); fi
    trap - INT TERM
    unset SCION_HUB_TOKEN
  }
  trap 'cleanup_agents; exit 130' INT TERM

  # wait_terminal <agent> <label>: the agent's row must exist and leave every active state
  # before the deadline. A missing row or a timeout is a failure, never a pass.
  wait_terminal() {
    while :; do
      scion list > "$OUT/list.txt" 2>&1
      row="$(grep -F "$1" "$OUT/list.txt" || true)"
      if [ -n "$row" ] && ! printf '%s\n' "$row" | grep -qiE 'running|starting|creating|stopping'; then
        printf '%s\n' "$row" > "$OUT/$2-final-row.txt"; return 0
      fi
      [ "$(date +%s)" -lt "$deadline" ] || { echo "no terminal row for $1 before the deadline" > "$OUT/$2-timeout.txt"; return 1; }
      sleep 15
    done
  }

  scion start --help > "$OUT/scion-start-help.txt" 2>&1 || true
  before="$fails"
  check use-project   scion use "$project"
  check maker-start   scion start "$maker" \
    "Create SMOKE.md containing exactly one line: $expected. Commit it on your branch, then stop." \
    --type "${GROVE_MAKER_TEMPLATE:-claude}" --broker "$BROKER" --wait-timeout 10m
  if [ "$fails" -ne "$before" ]; then
    echo "Agent phase stopped: project selection or maker start failed." >&2
    finish_agents; return 1
  fi
  podman ps --all --format '{{.ID}} {{.Names}} {{.Image}}' > "$OUT/containers-after-maker.txt" 2>&1

  check maker-terminal wait_terminal "$maker" maker

  check checker-start scion start "$checker" \
    "Review the branch of agent $maker. Your final message must be exactly one line: the word PASS if SMOKE.md contains exactly '$expected', otherwise FAIL followed by the reason." \
    --type "${GROVE_CHECKER_TEMPLATE:-codex}" --broker "$BROKER" --wait-timeout 10m
  podman ps --all --format '{{.ID}} {{.Names}} {{.Image}}' > "$OUT/containers-after-checker.txt" 2>&1
  check checker-terminal wait_terminal "$checker" checker

  scion logs "$maker" > "$OUT/maker.log" 2>&1
  scion logs "$checker" > "$OUT/checker.log" 2>&1

  # Evidence, not exit codes. The checker's verdict is its last non-empty log line, and it must
  # be exactly PASS, so an echoed copy of the instructions cannot count.
  check distinct-containers sh -c "[ \"\$(grep -cE 'smoke-(maker|checker)' '$OUT/containers-after-checker.txt')\" -ge 2 ]"
  find "$HOME" -maxdepth 8 -type d -path '*/.scion/agents/*/workspace' > "$OUT/worktrees.txt" 2>/dev/null
  check smoke-file    smoke_file_ok "$maker" "$expected"
  check checker-pass  sh -c "grep -v '^[[:space:]]*\$' '$OUT/checker.log' | tail -n 1 | tr -d '[:space:]' | grep -qx PASS"

  finish_agents
}

if [ "${GROVE_RUN_AGENTS:-0}" = "1" ]; then
  agents_phase "${1:?usage: GROVE_RUN_AGENTS=1 grove-smoke <project>}" || fails=$((fails + 1))
fi

jq -Rn --arg hub "$HUB" --arg broker "$BROKER" --arg at "$(date -u +%FT%TZ)" \
  '{hub: $hub, broker: $broker, at: $at,
    checks: [inputs | split("\t") | {name: .[0], exit: (.[1] | tonumber), pass: (.[1] == "0")}]}' \
  < "$RESULTS" > "$OUT/receipt.json"

echo
echo "Receipt: $OUT/receipt.json  ($fails failed)"
[ "$fails" -eq 0 ]

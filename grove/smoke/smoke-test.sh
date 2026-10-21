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

  cleanup_agents() {
    for a in "$maker" "$checker"; do
      scion stop "$a" >> "$OUT/cleanup.log" 2>&1
      scion delete "$a" >> "$OUT/cleanup.log" 2>&1 || { echo "cleanup failed for $a" >> "$OUT/cleanup.log"; return 1; }
    done
  }
  trap 'cleanup_agents; exit 130' INT TERM

  scion start --help > "$OUT/scion-start-help.txt" 2>&1 || true
  check use-project   scion use "$project"
  check maker-start   scion start "$maker" \
    "Create SMOKE.md containing exactly one line: $expected. Commit it on your branch, then stop." \
    --type "${GROVE_MAKER_TEMPLATE:-claude}" --broker "$BROKER" --wait-timeout 10m

  podman ps --all --format '{{.ID}} {{.Names}} {{.Image}}' > "$OUT/containers-after-maker.txt" 2>&1

  # Wait for the maker to finish before the checker reviews its branch.
  until scion list > "$OUT/list.txt" 2>&1 && ! grep "$maker" "$OUT/list.txt" | grep -qiE 'running|starting|creating'; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "maker did not finish before the deadline" >> "$OUT/maker-wait.log"; break; }
    sleep 15
  done
  check maker-terminal sh -c "! grep '$maker' '$OUT/list.txt' | grep -qiE 'running|starting|creating'"

  check checker-start scion start "$checker" \
    "Review the branch of agent $maker. Reply with exactly one line: PASS if SMOKE.md contains exactly '$expected', otherwise FAIL and the reason." \
    --type "${GROVE_CHECKER_TEMPLATE:-codex}" --broker "$BROKER" --wait-timeout 10m
  podman ps --all --format '{{.ID}} {{.Names}} {{.Image}}' > "$OUT/containers-after-checker.txt" 2>&1

  until scion list > "$OUT/list.txt" 2>&1 && ! grep "$checker" "$OUT/list.txt" | grep -qiE 'running|starting|creating'; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "checker did not finish before the deadline" >> "$OUT/checker-wait.log"; break; }
    sleep 15
  done

  scion logs "$maker" > "$OUT/maker.log" 2>&1
  scion logs "$checker" > "$OUT/checker.log" 2>&1

  # Evidence, not exit codes.
  check distinct-containers sh -c "[ \"\$(grep -cE 'smoke-(maker|checker)' '$OUT/containers-after-checker.txt')\" -ge 2 ]"
  find "$HOME" -maxdepth 8 -type d -path '*/.scion/agents/*/workspace' > "$OUT/worktrees.txt" 2>/dev/null
  check smoke-file    smoke_file_ok "$maker" "$expected"
  check checker-pass  grep -qE '(^|[^A-Z])PASS([^A-Z]|$)' "$OUT/checker.log"

  if cleanup_agents; then record cleanup 0; else record cleanup 1; fails=$((fails + 1)); fi
  trap - INT TERM
  unset SCION_HUB_TOKEN
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

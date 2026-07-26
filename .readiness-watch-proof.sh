#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
IMAGE_NAME="${OPENCLAW_READINESS_WATCH_IMAGE:-openclaw-readiness-watch-proof:local}"
CONTAINER_NAME="openclaw-readiness-watch-proof-$$"
ARTIFACT_DIR="${OPENCLAW_READINESS_WATCH_ARTIFACT_DIR:-$ROOT_DIR/artifacts/readiness-watch-proof}"

cd "$ROOT_DIR"
source scripts/lib/docker-e2e-image.sh

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  readiness-watch-proof \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  functional \
  0

docker_e2e_docker_cmd run -d \
  --name "$CONTAINER_NAME" \
  --tmpfs "/tmp/readiness-watch-workspace:rw,uid=1001,gid=1001,mode=0700,size=1m" \
  -e OPENCLAW_GATEWAY_TOKEN=readiness-watch-proof-token \
  -e OPENCLAW_INSTANCE_ID=readiness-watch-proof-host \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  "$IMAGE_NAME" \
  sleep infinity >/dev/null

set +e
docker_e2e_docker_cmd exec -i "$CONTAINER_NAME" bash -s <<'CONTAINER_PROOF'
set -euo pipefail

entry="$(node -e 'const fs=require("node:fs"); for (const p of ["dist/index.mjs","dist/index.js"]) if (fs.existsSync(p)) { process.stdout.write(p); process.exit(0); } process.exit(1)')"
node "$entry" config set --batch-json '[{"path":"gateway.controlUi.enabled","value":false},{"path":"agents.defaults.workspace","value":"/tmp/readiness-watch-workspace"},{"path":"gateway.readiness.requiredCriteria","value":["openclaw.workspace-writable"]}]' >/dev/null

wait_for() {
  local label="$1"
  shift
  local attempt
  for attempt in $(seq 1 160); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for $label" >&2
  return 1
}

probe_status() {
  local expected="$1"
  node - "$expected" <<'NODE'
const expected = Number(process.argv[2]);
try {
  const response = await fetch("http://127.0.0.1:18789/readyz");
  process.exit(response.status === expected ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

wait_lines() {
  local expected="$1"
  local count=0
  if [ -f /tmp/readiness-watch.jsonl ]; then
    count="$(grep -cve '^[[:space:]]*$' /tmp/readiness-watch.jsonl || true)"
  fi
  [ "$count" -ge "$expected" ]
}

start_gateway() {
  : > /tmp/readiness-gateway.log
  node "$entry" gateway --port 18789 --bind loopback --allow-unconfigured \
    >/tmp/readiness-gateway.log 2>&1 &
  gateway_pid=$!
}

fill_workspace() {
  set +e
  dd if=/dev/zero of=/tmp/readiness-watch-workspace/fill bs=64K status=none
  local status=$?
  set -e
  sync
  [ "$status" -ne 0 ]
}

start_gateway
wait_for "initial Gateway readiness" probe_status 200

: > /tmp/readiness-watch.jsonl
: > /tmp/readiness-watch.stderr
node "$entry" ready --watch --json --interval 250 --timeout 500 \
  >/tmp/readiness-watch.jsonl 2>/tmp/readiness-watch.stderr &
watch_pid=$!
wait_for "initial readiness snapshot" wait_lines 1

fill_workspace
wait_for "workspace degradation" probe_status 503
wait_for "workspace degradation event" wait_lines 2

rm -f /tmp/readiness-watch-workspace/fill
wait_for "workspace recovery" probe_status 200
wait_for "workspace recovery event" wait_lines 3

kill -TERM "$gateway_pid"
wait "$gateway_pid" >/dev/null 2>&1 || true
wait_for "Gateway unavailable event" wait_lines 4

fill_workspace
start_gateway
wait_for "restarted Gateway degraded readiness" probe_status 503
wait_for "recovered-but-degraded event" wait_lines 5

rm -f /tmp/readiness-watch-workspace/fill
wait_for "final readiness" probe_status 200
wait_for "final readiness event" wait_lines 6

kill -INT "$watch_pid"
set +e
wait "$watch_pid"
watch_status=$?
set -e
if [ "$watch_status" -ne 130 ]; then
  echo "Expected watch exit 130 after SIGINT, got $watch_status" >&2
  exit 1
fi

kill -TERM "$gateway_pid"
wait "$gateway_pid" >/dev/null 2>&1 || true

node <<'NODE'
const fs = require("node:fs");
const lines = fs.readFileSync("/tmp/readiness-watch.jsonl", "utf8").trim().split(/\r?\n/u);
const events = lines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`line ${index + 1} is not JSON: ${error.message}`);
  }
});
if (events.length < 6) throw new Error(`expected at least 6 events, got ${events.length}`);
if (!events.every((event) => event.eventVersion === 1)) throw new Error("unexpected eventVersion");
if (events[0].event !== "snapshot" || events[0].state !== "available" || events[0].ready !== true) {
  throw new Error("first event is not an available ready snapshot");
}

const workspaceFalse = (event) => event.state === "available" && event.ready === false &&
  event.readiness?.conditions?.some((condition) => condition.type === "WorkspaceWritable" && condition.status === "False");
const workspaceTrue = (event) => event.state === "available" && event.ready === true &&
  event.readiness?.conditions?.some((condition) => condition.type === "WorkspaceWritable" && condition.status === "True");

let cursor = 1;
const take = (predicate, label) => {
  const index = events.findIndex((event, candidate) => candidate >= cursor && predicate(event));
  if (index < 0) throw new Error(`missing ${label}`);
  cursor = index + 1;
  return events[index];
};

const firstDegraded = take(workspaceFalse, "workspace degradation");
const firstRecovered = take(workspaceTrue, "workspace recovery");
const unavailable = take((event) => event.state === "unavailable" && event.ready === false, "Gateway outage");
const recoveredDegraded = take(workspaceFalse, "recovered-but-degraded state");
const finalReady = take(workspaceTrue, "final recovery");

const subject = (event, kind) => event.readiness?.identity?.subjects?.find((item) => item.kind === kind);
const hostBefore = subject(firstRecovered, "openclaw.host-instance");
const hostAfter = subject(recoveredDegraded, "openclaw.host-instance");
const gatewayBefore = subject(firstRecovered, "openclaw.gateway");
const gatewayAfter = subject(recoveredDegraded, "openclaw.gateway");
const processBefore = subject(firstRecovered, "openclaw.process");
const processAfter = subject(recoveredDegraded, "openclaw.process");

if (!hostBefore?.id || hostBefore.id !== hostAfter?.id) throw new Error("host identity did not remain stable");
if (!gatewayBefore?.id || gatewayBefore.id === gatewayAfter?.id) throw new Error("Gateway identity did not renew");
if (!processBefore?.id || processBefore.id === processAfter?.id) throw new Error("process identity did not renew");
if (!unavailable.error?.reason) throw new Error("unavailable event lacks structured error");
if (finalReady.readiness?.identity?.producerRef !== gatewayAfter.ref) throw new Error("producer does not reference the restarted Gateway");

const summary = {
  exactEventCount: events.length,
  sequence: [
    "ready",
    "workspace-degraded",
    "ready",
    "gateway-unavailable",
    "recovered-but-degraded",
    "ready",
  ],
  hostIdentityStable: true,
  gatewayIdentityRenewed: true,
  processIdentityRenewed: true,
  unavailableReason: unavailable.error.reason,
  signalExitCode: 130,
};
fs.writeFileSync("/tmp/readiness-watch-summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE
CONTAINER_PROOF
proof_status=$?
set -e

for file in readiness-watch.jsonl readiness-watch.stderr readiness-watch-summary.json readiness-gateway.log; do
  docker_e2e_docker_cmd cp "$CONTAINER_NAME:/tmp/$file" "$ARTIFACT_DIR/$file" >/dev/null 2>&1 || true
done

if [ "$proof_status" -ne 0 ]; then
  echo "Readiness watch proof failed; artifacts retained at $ARTIFACT_DIR" >&2
  exit "$proof_status"
fi

echo "Readiness watch Docker proof passed"
echo "Artifacts: $ARTIFACT_DIR"
cat "$ARTIFACT_DIR/readiness-watch-summary.json"

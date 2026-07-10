#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-hosting-profiles-e2e" OPENCLAW_HOSTING_PROFILES_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_HOSTING_PROFILES_E2E_SKIP_BUILD:-0}"
PORT="18789"
TOKEN="hosting-profiles-$(date +%s)-$$"
CONTAINER_NAME="openclaw-hosting-profiles-local-$$"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse \
  "$IMAGE_NAME" \
  hosting-profiles \
  "$ROOT_DIR/scripts/e2e/Dockerfile" \
  "$ROOT_DIR" \
  "" \
  "$SKIP_BUILD"

docker_e2e_harness_mount_args
docker_e2e_docker_cmd run -d \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry="$(openclaw_e2e_resolve_entrypoint)"; node "$entry" config set gateway.controlUi.enabled false >/dev/null; openclaw_e2e_exec_gateway "$entry" 18789 loopback /tmp/hosting-profiles.log' \
  >/dev/null

if ! docker_e2e_wait_container_bash "$CONTAINER_NAME" 180 0.5 \
  'source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_http http://127.0.0.1:18789/readyz 200 1000'; then
  docker_e2e_tail_container_file_if_running "$CONTAINER_NAME" /tmp/hosting-profiles.log 120
  exit 1
fi

docker_e2e_docker_cmd exec "$CONTAINER_NAME" \
  node scripts/e2e/hosting-profiles-client.mjs local "http://127.0.0.1:$PORT/readyz"

echo "Hosting profiles Docker E2E passed"

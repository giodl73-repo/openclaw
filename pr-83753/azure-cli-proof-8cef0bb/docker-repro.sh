#!/usr/bin/env bash
set -euo pipefail
# Repeatable non-privileged repro for PR 83753 shell-completion CLI proof.
# This intentionally does not claim systemd/loginctl coverage; use a disposable Linux host for that.
docker build -t openclaw-pr83753-doctor-proof - <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y ca-certificates curl git build-essential python3 jq && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && corepack enable
RUN git clone --filter=blob:none --branch doctor-detection-interactive-maintenance https://github.com/giodl73-repo/openclaw.git /src/openclaw
WORKDIR /src/openclaw
RUN git checkout 8cef0bb2833a683b1f681aa72defc10812c852bb && pnpm install --frozen-lockfile && pnpm build
CMD bash -lc 'set -euo pipefail; export HOME=/tmp/openclaw-home OPENCLAW_HOME=/tmp/openclaw-home OPENCLAW_STATE_DIR=/tmp/openclaw-home/.openclaw/state SHELL=/bin/bash NO_COLOR=1 CI=1; mkdir -p "$HOME/.openclaw"; printf "{\"gateway\":{\"mode\":\"local\",\"auth\":{\"mode\":\"none\"}},\"channels\":{},\"agents\":{}}\n" > "$HOME/.openclaw/openclaw.json"; printf "# OpenClaw Completion\nsource <(openclaw completion bash)\n" > "$HOME/.bashrc"; node openclaw.mjs doctor --lint --only core/doctor/shell-completion --json || test "$?" = 1; node openclaw.mjs doctor --fix --yes; node openclaw.mjs doctor --lint --only core/doctor/shell-completion --json'
EOF
docker run --rm openclaw-pr83753-doctor-proof

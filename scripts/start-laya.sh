#!/usr/bin/env bash
# Start the laya decision-model server for the model-router extension.
#
# First run:  ./start-laya.sh          (creates a venv and installs laya[serve] if missing)
# Later runs: ./start-laya.sh
#
# The server downloads the convaiinnovations/laya checkpoints from Hugging Face
# on first use (~850 MB). LAYA_PRELOAD=1 loads them at startup instead of on
# the first request.
#
# laya requires Python >= 3.10. The system python3 may be older, so uv (or any
# python3.10+ on PATH) is used to build the venv.
#
# Configurable via environment variables (all optional):
#   LAYA_PORT=9731        port to listen on (must match "decision.url" in model-router.json)
#   LAYA_DEVICE=cpu|cuda  inference device (defaults to cpu; MPS is used automatically on Apple Silicon)
#   LAYA_PRELOAD=1        build checkpoints at startup
#   LAYA_MODELS=english   comma list of checkpoints to keep resident (default: auto-routed)
#   LAYA_API_KEY=secret   require Authorization: Bearer <secret> (set decision.apiKey "$LAYA_API_KEY")
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv-laya"

if [ ! -x "$VENV/bin/laya-serve" ]; then
	echo "[start-laya] Creating venv and installing laya[serve] (first run only)..."
	rm -rf "$VENV"
	if command -v uv >/dev/null 2>&1; then
		uv venv --python 3.12 "$VENV"
		uv pip install --python "$VENV/bin/python" "laya[serve]"
	elif command -v python3.13 >/dev/null 2>&1; then
		python3.13 -m venv "$VENV"
		"$VENV/bin/pip" install --quiet "laya[serve]"
	elif command -v python3.12 >/dev/null 2>&1; then
		python3.12 -m venv "$VENV"
		"$VENV/bin/pip" install --quiet "laya[serve]"
	else
		echo "[start-laya] ERROR: laya needs Python >= 3.10; install uv or python3.12+ first." >&2
		exit 1
	fi
fi

echo "[start-laya] Starting laya-serve on port ${LAYA_PORT:-8000}..."
exec "$VENV/bin/laya-serve"

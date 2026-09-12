#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
python3.12 -m venv .venv
"$ROOT/.venv/bin/python" -m pip install --upgrade pip
"$ROOT/.venv/bin/python" -m pip install -r requirements.txt
# Optional native key engine (Linux/macOS wheels; Windows pip build fails):
# "$ROOT/.venv/bin/python" -m pip install essentia
echo "Sidecar venv ready at $ROOT/.venv"

#!/usr/bin/env bash
# Regenerate test/fixtures with mymc++ (installed into .venv on first run).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  if command -v uv >/dev/null; then
    uv venv -q .venv
    uv pip install -q --python .venv/bin/python mymcplusplus==3.2.0
  else
    python3 -m venv .venv
    .venv/bin/pip install -q mymcplusplus==3.2.0
  fi
fi

.venv/bin/python scripts/make_fixtures.py

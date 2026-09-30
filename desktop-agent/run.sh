#!/usr/bin/env bash
set -euo pipefail
AGENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${FUSION_AGENT_PYTHON:-}" ]]; then
  AGENT_PYTHON="$FUSION_AGENT_PYTHON"
elif [[ -n "${VIRTUAL_ENV:-}" && -x "$VIRTUAL_ENV/bin/python" ]]; then
  AGENT_PYTHON="$VIRTUAL_ENV/bin/python"
elif [[ -x "$AGENT_ROOT/.venv/bin/python" ]]; then
  AGENT_PYTHON="$AGENT_ROOT/.venv/bin/python"
else
  AGENT_PYTHON=python3
fi
export PYTHONPATH="$AGENT_ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$AGENT_PYTHON" "$AGENT_ROOT/bootstrap.py" "$@"

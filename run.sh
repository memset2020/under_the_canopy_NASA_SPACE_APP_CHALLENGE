#!/usr/bin/env bash
# Start Under the Canopy on http://127.0.0.1:8090 and open it in the browser.
# Usage: ./run.sh   (from WSL, Linux or macOS; needs the pipeline's .venv or python3)
set -euo pipefail
cd "$(dirname "$0")/pipeline"
PY=../.venv/bin/python; [ -x "$PY" ] || PY=python3
PORT=${PORT:-8090}
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  nohup "$PY" cli.py serve --port "$PORT" > /tmp/under-the-canopy-serve.log 2>&1 &
  sleep 2
fi
URL="http://127.0.0.1:$PORT/?v=$(date +%s)"   # a fresh link: no stale copies in the browser
echo "Under the Canopy: $URL"
if command -v cmd.exe > /dev/null; then cmd.exe /c start "" "$URL" 2> /dev/null
elif command -v xdg-open > /dev/null; then xdg-open "$URL"
elif command -v open > /dev/null; then open "$URL"
fi

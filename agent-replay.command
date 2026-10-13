#!/bin/bash
# Double-click launcher for macOS: starts the local replay service and opens the browser.
# Close this window or press Ctrl+C to stop the service.
cd "$(dirname "$0")" || exit 1
PORT="${AGENT_REPLAY_PORT:-8790}"
URL="http://127.0.0.1:$PORT/"
# Reuse a service that is already running instead of starting a second one.
if curl -fs -m 2 "${URL}api/sessions" -o /dev/null 2>&1; then
  echo "服务已在运行：$URL"
  open "$URL"
  exit 0
fi
python3 src/cli.py serve --port "$PORT"
status=$?
if [ -t 0 ] && [ "$status" -ne 0 ]; then echo "按任意键关闭…"; read -n 1 -s || true; fi
exit $status

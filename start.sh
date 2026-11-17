#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x ./runtime/linux64/python3 ]]; then
  exec ./runtime/linux64/python3 ./server.py --open --port 19706 "$@"
fi
exec python3 ./server.py --open --port 19706 "$@"

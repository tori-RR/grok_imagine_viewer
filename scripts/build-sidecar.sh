#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/backend-go/bin"
mkdir -p "$BIN_DIR"
(
  cd "$ROOT/backend-go"
  go test ./...
  go vet ./...
  go build -trimpath -ldflags="-s -w" -o "$BIN_DIR/giv-backend" .
)
printf 'Built Go sidecar: %s\n' "$BIN_DIR/giv-backend"

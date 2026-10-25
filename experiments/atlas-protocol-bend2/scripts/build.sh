#!/bin/sh
set -eu

experiment_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$experiment_dir"
bend_bin=${BEND:-"$experiment_dir/.tools/bend-2.0.39/bin/bend"}
if [ ! -x "$bend_bin" ]; then
  bend_bin=$(command -v bend || true)
fi
if [ -z "$bend_bin" ]; then
  echo 'Run sh scripts/install-bend.sh or set BEND to Bend 2.0.39.' >&2
  exit 1
fi
if [ "$(BEND_NO_TELEMETRY=1 "$bend_bin" version)" != 'bend 2.0.39' ]; then
  echo 'This experiment requires Bend 2.0.39.' >&2
  exit 1
fi

export BEND_NO_TELEMETRY=1
mkdir -p dist
"$bend_bin" api.bend --check-only
"$bend_bin" api.bend -o dist/protocol.mjs
"$bend_bin" main.bend -o dist/atlas-protocol

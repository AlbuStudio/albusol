#!/usr/bin/env bash
# Devnet smoke test: creates a token, a CPMM pool, burns the LP, mints an NFT.
# Usage: ALBUSOL_HOME=/tmp/albusol-test test/devnet-smoke.sh <answers.json>
set -euo pipefail
cd "$(dirname "$0")/.."
ALBUSOL_ANSWERS="${1:?answers.json}" node bin/albusol.js

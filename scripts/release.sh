#!/usr/bin/env bash
# Package the committed tree as albusol-<version>.zip and publish it on albustudio.com/albusol.
# Writes /downloads/albusol/latest.json, which the product page reads for the Download button.
# Usage: bash scripts/release.sh
set -euo pipefail
HOST=${HOST:-root@70.34.243.138}
KEY=${KEY:-~/.ssh/id_ed25519}
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Commit first: the zip is built from HEAD." >&2; exit 1; }
VERSION=$(node -p 'require("./package.json").version')
OUT=$(mktemp -d)
ZIP="albusol-$VERSION.zip"
git archive --format=zip --prefix="albusol-$VERSION/" -o "$OUT/$ZIP" HEAD -- . ':!TODO.md' ':!scripts'
SIZE=$(stat -f%z "$OUT/$ZIP" 2>/dev/null || stat -c%s "$OUT/$ZIP")
SHA=$(shasum -a 256 "$OUT/$ZIP" | cut -d' ' -f1)
cat > "$OUT/latest.json" <<JSON
{"version":"$VERSION","build":"$(git rev-parse --short HEAD)","url":"/downloads/albusol/$ZIP","size":$SIZE,"sha256":"$SHA","requires":"Node.js 20+"}
JSON
ssh -i "$KEY" "$HOST" "mkdir -p /var/www/albustudio/downloads/albusol"
rsync -az -e "ssh -i $KEY" "$OUT/$ZIP" "$OUT/latest.json" "$HOST:/var/www/albustudio/downloads/albusol/"
ssh -i "$KEY" "$HOST" "chown -R www-data:www-data /var/www/albustudio/downloads/albusol"
echo "Published $ZIP ($SIZE bytes, sha256 $SHA)"

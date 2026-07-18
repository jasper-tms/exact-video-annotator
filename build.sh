#!/usr/bin/env bash
# Cloudflare Pages build: there is no compile step; stage the static app in dist/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp index.html style.css dist/
cp -R css js dist/

echo "Staged $(find dist -type f | wc -l | tr -d ' ') files into dist/"

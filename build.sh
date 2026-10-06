#!/usr/bin/env bash
# Cloudflare Pages build: there is no compile step; stage the static app in dist/.
#
# All the work, including the version stamp, lives in build.mjs (plain Node, so
# it also runs on Windows without bash). This wrapper only exists so the
# Cloudflare dashboard command can stay `bash build.sh`. Cloudflare Pages' build
# image ships Node by default.
set -euo pipefail
cd "$(dirname "$0")"

node build.mjs --dist

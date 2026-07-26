#!/usr/bin/env bash
# Cloudflare Pages build: there is no compile step; stage the static app in dist/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp index.html style.css dist/
cp -R css js dist/

# ---------- Version stamp ----------
# The deployed app is static, so "what is live right now" has to be baked in at
# build time and served as a file. Cloudflare Pages exports CF_PAGES_* for the
# commit it is building; prefer those, since its checkout is shallow and may
# carry no tags or branch name. Every lookup degrades to "unknown" rather than
# failing the build — a missing version stamp must never cost us a deploy.

repositoryUrl="https://github.com/jasper-tms/exact-video-annotator"

commit="${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo '')}"
branch="${CF_PAGES_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}"

# The VERSION file, not `git describe`: VERSION is checked in, so it survives
# the shallow tagless clone a host builds from, and it is the same value the
# release workflow cuts the vX.Y.Z tag from. Bare, with no leading "v".
annotatorVersion="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo '')"

if [[ -n "$commit" ]]; then
  commitUrl="${repositoryUrl}/commit/${commit}"
else
  commit="unknown"
  commitUrl="unknown"
fi
[[ -n "$annotatorVersion" ]] || annotatorVersion="unknown"
[[ -n "$branch" ]] || branch="unknown"

# Read the engine pin out of index.html so this stays a single source of truth:
# the whole point of the stamp is telling which engine the live app is running.
# The pin names a tag, so it carries a leading "v"; strip it so both versions in
# the stamp read the same way.
videoEngineVersion="$(sed -n 's|.*exact-video-engine\.js@v\{0,1\}\([^/]*\)/exact-video-engine\.js.*|\1|p' \
  index.html | head -1)"
[[ -n "$videoEngineVersion" ]] || videoEngineVersion="unknown"

buildTimestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

cat > dist/version.json <<EOF
{
  "annotatorVersion": "${annotatorVersion}",
  "commit": "${commit}",
  "commitUrl": "${commitUrl}",
  "branch": "${branch}",
  "buildTimestamp": "${buildTimestamp}",
  "videoEngineVersion": "${videoEngineVersion}"
}
EOF

# Serve the same bytes at the extensionless /version too, so either URL works.
cp dist/version.json dist/version

# Extensionless files are not served as JSON by default, and a version stamp
# that can be answered from cache defeats its own purpose.
cat > dist/_headers <<'EOF'
/version
  Content-Type: application/json; charset=utf-8
  Cache-Control: no-store

/version.json
  Cache-Control: no-store
EOF

echo "Staged $(find dist -type f | wc -l | tr -d ' ') files into dist/"
echo "Version stamp: ${annotatorVersion} (engine ${videoEngineVersion}) built ${buildTimestamp}"

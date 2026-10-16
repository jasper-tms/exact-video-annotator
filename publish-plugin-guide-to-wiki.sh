#!/usr/bin/env bash
#
# Publish the plugin-building guide to the project wiki's "Building plugins"
# page (https://github.com/jasper-tms/exact-video-annotator/wiki/Building-plugins).
#
# agent-skills/building-video-examiner-plugins/SKILL.md is the source of truth:
# the wiki page is the same text with the skill's frontmatter replaced by a
# line pointing coding agents at the skill. Edit the skill, then run this.
# Re-running with no edits is a no-op.
#
# Usage:  ./publish-plugin-guide-to-wiki.sh             # publish
#         ./publish-plugin-guide-to-wiki.sh --dry-run   # print the page instead
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill_path="${repository_root}/agent-skills/building-video-examiner-plugins/SKILL.md"
skill_url='https://github.com/jasper-tms/exact-video-annotator/blob/main/agent-skills/building-video-examiner-plugins/SKILL.md'
wiki_repository='git@github.com:jasper-tms/exact-video-annotator.wiki.git'
page_name='Building-plugins'

render_page() {
    printf 'To get your coding agent to read these instructions and help you, tell it to read %s.\n\n---\n\n' \
        "${skill_url}"
    # Drop the frontmatter (the first "---" … "---" block) and the blank lines after it.
    awk '
        NR == 1 && $0 == "---" { in_frontmatter = 1; next }
        in_frontmatter && $0 == "---" { in_frontmatter = 0; after_frontmatter = 1; next }
        in_frontmatter { next }
        after_frontmatter && $0 == "" { next }
        { after_frontmatter = 0; print }
    ' "${skill_path}"
}

if [[ "${1:-}" == "--dry-run" ]]; then
    render_page
    exit 0
fi

wiki_checkout="$(mktemp -d)"
trap 'rm -rf "${wiki_checkout}"' EXIT
git clone --quiet "${wiki_repository}" "${wiki_checkout}"
render_page > "${wiki_checkout}/${page_name}.md"

cd "${wiki_checkout}"
if [[ -z "$(git status --porcelain)" ]]; then
    echo "The wiki page is already up to date."
    exit 0
fi
git add "${page_name}.md"
git commit --quiet -m "Update ${page_name} from the building-video-examiner-plugins skill"
git push --quiet
echo "Published https://github.com/jasper-tms/exact-video-annotator/wiki/${page_name}"

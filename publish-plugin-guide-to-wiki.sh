#!/usr/bin/env bash
#
# Publish the plugin-building guide to the project wiki's "Building plugins"
# page (https://github.com/jasper-tms/exact-video-annotator/wiki/Building-plugins).
#
# agent-skills/building-video-examiner-plugins/SKILL.md is the source of truth:
# the wiki page is the same text with the skill's frontmatter replaced by a
# line pointing coding agents at the skill. Edit the skill, then run this.
# Re-running with no edits is a no-op. Pushes to main that change the skill run
# this automatically (.github/workflows/publish-plugin-guide-to-wiki.yml).
#
# Usage:  ./publish-plugin-guide-to-wiki.sh             # publish
#         ./publish-plugin-guide-to-wiki.sh --dry-run   # print the page instead
#         ./publish-plugin-guide-to-wiki.sh --only-if-wiki-matches <commit>
#             # publish only if the wiki page is still exactly what the skill
#             # at <commit> renders to, so manual wiki edits are never overwritten
#
# The WIKI_REPOSITORY environment variable overrides the wiki's clone address.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill_relative_path='agent-skills/building-video-examiner-plugins/SKILL.md'
skill_url="https://github.com/jasper-tms/exact-video-annotator/blob/main/${skill_relative_path}"
wiki_repository="${WIKI_REPOSITORY:-git@github.com:jasper-tms/exact-video-annotator.wiki.git}"
page_name='Building-plugins'

# Render the wiki page from the skill text given on standard input.
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
    '
}

mode='publish'
case "${1:-}" in
    '') ;;
    --dry-run) mode='dry-run' ;;
    --only-if-wiki-matches)
        mode='only-if-wiki-matches'
        previous_commit="${2:?--only-if-wiki-matches needs a commit}"
        ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

if [[ "${mode}" == 'dry-run' ]]; then
    render_page < "${repository_root}/${skill_relative_path}"
    exit 0
fi

working_directory="$(mktemp -d)"
trap 'rm -rf "${working_directory}"' EXIT
wiki_checkout="${working_directory}/wiki"
page_path="${wiki_checkout}/${page_name}.md"
git clone --quiet "${wiki_repository}" "${wiki_checkout}"
render_page < "${repository_root}/${skill_relative_path}" > "${working_directory}/new-page.md"

if [[ "${mode}" == 'only-if-wiki-matches' ]]; then
    if [[ -f "${page_path}" ]] && cmp --silent "${page_path}" "${working_directory}/new-page.md"; then
        echo "The wiki page is already up to date."
        exit 0
    fi
    # What the wiki page should hold if nobody has edited it by hand: the skill
    # as it was at the previous commit, rendered. If the skill didn't exist
    # then, the page shouldn't either.
    if git -C "${repository_root}" cat-file -e "${previous_commit}:${skill_relative_path}" 2>/dev/null; then
        git -C "${repository_root}" show "${previous_commit}:${skill_relative_path}" \
            | render_page > "${working_directory}/expected-page.md"
        if [[ ! -f "${page_path}" ]]; then
            echo "The wiki page ${page_name} doesn't exist, though the skill did at ${previous_commit}." >&2
            echo "Not publishing; run ./publish-plugin-guide-to-wiki.sh by hand to recreate it." >&2
            exit 1
        fi
        if ! cmp --silent "${page_path}" "${working_directory}/expected-page.md"; then
            echo "The wiki page ${page_name} has been edited since it was last published" >&2
            echo "from the skill at ${previous_commit}. Not overwriting those edits." >&2
            echo "Copy them into ${skill_relative_path} (or discard them), then run" >&2
            echo "./publish-plugin-guide-to-wiki.sh by hand. The wiki's edits:" >&2
            diff -u --label "skill at ${previous_commit}" --label "wiki" \
                "${working_directory}/expected-page.md" "${page_path}" >&2 || true
            exit 1
        fi
    elif [[ -f "${page_path}" ]]; then
        echo "The wiki page ${page_name} exists, but the skill didn't at ${previous_commit}." >&2
        echo "Not overwriting it; run ./publish-plugin-guide-to-wiki.sh by hand if that's intended." >&2
        exit 1
    fi
fi

cp "${working_directory}/new-page.md" "${page_path}"
cd "${wiki_checkout}"
if [[ -z "$(git status --porcelain)" ]]; then
    echo "The wiki page is already up to date."
    exit 0
fi
git add "${page_name}.md"
git commit --quiet -m "Update ${page_name} from the building-video-examiner-plugins skill"
git push --quiet
echo "Published https://github.com/jasper-tms/exact-video-annotator/wiki/${page_name}"

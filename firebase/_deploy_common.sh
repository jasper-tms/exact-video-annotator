#!/usr/bin/env bash
#
# Shared setup for the deploy-firebase-*.sh scripts at the repo root.
# Not runnable on its own — source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/firebase/_deploy_common.sh"
#
# Provides: $project, $repo_root, the $firebase command array, and confirm().
# Copied from reaction-test's firebase/_deploy_common.sh (itself from
# movim-website).

project='exact-video-annotator'
firebase_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${firebase_dir}/.." && pwd)"

# firebase.json lives at the repo root and its paths are relative to it.
cd "${repo_root}"

# firebase-tools is pinned in firebase/package.json, but node_modules is
# gitignored, so it may be absent on a fresh clone — fall back to npx.
if [[ -x "${firebase_dir}/node_modules/.bin/firebase" ]]; then
    firebase=("${firebase_dir}/node_modules/.bin/firebase")
elif command -v npx >/dev/null 2>&1; then
    firebase=(npx --yes firebase-tools)
else
    echo "Neither firebase/node_modules/.bin/firebase nor npx is available." >&2
    echo "Install firebase-tools with:  (cd firebase && npm install)" >&2
    exit 1
fi

# Distinguish "not logged in" from "the CLI could not even run" — the pinned
# binary is a Node script, so with node missing from PATH (nvm installs are not
# on the default PATH on every machine) it fails before printing anything, and
# swallowing its stderr would misreport that as a missing login.
if ! login_output="$("${firebase[@]}" login:list 2>&1)"; then
    echo "Could not run the Firebase CLI (is node on your PATH?):" >&2
    echo "${login_output}" >&2
    exit 1
fi
if ! grep -q 'Logged in as' <<< "${login_output}"; then
    echo "Not logged in to Firebase. Run:  ${firebase[*]} login" >&2
    exit 1
fi

# confirm <message> — prompt before touching the live project. Skipped when the
# calling script was passed --yes (it sets $script_arg). Aborts on anything but
# an explicit y.
confirm() {
    echo
    echo "$1"
    echo
    if [[ "${script_arg:-}" == '--yes' ]]; then
        return 0
    fi
    read -r -p "Deploy to ${project}? [y/N] " reply
    if [[ ! "${reply}" =~ ^[Yy]$ ]]; then
        echo "Aborted; nothing deployed."
        exit 1
    fi
}

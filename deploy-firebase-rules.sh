#!/usr/bin/env bash
#
# Deploy the Firestore security rules to the live exact-video-annotator
# project.
#
# firebase/firestore.rules is the source of truth for the rules — the Firebase
# console is not. If someone edits the rules in the console, the next run of
# this script overwrites them; that is the intent. Re-running with no local
# edits is a no-op.
#
# Usage:  ./deploy-firebase-rules.sh              # validate, confirm, deploy
#         ./deploy-firebase-rules.sh --dry-run    # validate only; never touches the project
#         ./deploy-firebase-rules.sh --yes        # skip the confirmation prompt
set -euo pipefail

script_arg="${1:-}"
source "$(dirname "${BASH_SOURCE[0]}")/firebase/_deploy_common.sh"

if [[ ! -f firebase/firestore.rules ]]; then
    echo "Missing firebase/firestore.rules in ${repo_root}" >&2
    exit 1
fi

# Compile the rules against the live project without changing anything, so a
# syntax error surfaces before the confirmation prompt rather than after it.
# --non-interactive and </dev/null matter: without a TTY the CLI will otherwise
# try to prompt and block forever instead of failing.
echo "Validating rules against '${project}'..."
"${firebase[@]}" deploy --only firestore:rules \
    --project "${project}" --dry-run --non-interactive < /dev/null

if [[ "${script_arg}" == '--dry-run' ]]; then
    echo
    echo "Dry run only; nothing deployed."
    exit 0
fi

confirm "This REPLACES the live security rules on '${project}', which serves
real users. Any changes made in the console will be lost."

"${firebase[@]}" deploy --only firestore:rules \
    --project "${project}" --non-interactive < /dev/null

echo
echo "Deployed. Verify in the console:"
echo "  https://console.firebase.google.com/u/0/project/${project}/firestore/databases/-default-/security/rules"

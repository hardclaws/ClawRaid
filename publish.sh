#!/usr/bin/env bash
# Scaffold a git repo for Clawraid and push it to GitHub.
# Usage:  ./publish.sh <github-username> <repo-name>
# Example: ./publish.sh alice clawraid
#
# Prereqs: git installed and `gh` authenticated (https://cli.github.com).
# This only creates the repo + initial commit + enables GitHub Pages on the
# branch you choose. You still connect your own Twitch Client ID in the UI.

set -e

USER="${1:?Provide your GitHub username as the first argument}"
REPO="${2:-clawraid}"
REMOTE="git@github.com:${USER}/${REPO}.git"

cd "$(dirname "$0")"

# Init repo if needed
if [ ! -d .git ]; then
  git init -q
  git checkout -q -b main 2>/dev/null || git checkout -q -B main
fi

git add -A
git commit -q -m "Initial commit: Clawraid" || echo "Nothing new to commit."

# Create the GitHub repo via gh (if available) and push.
if command -v gh >/dev/null 2>&1; then
  if ! gh repo view "${REPO}" >/dev/null 2>&1; then
    gh repo create "${REPO}" --public --source=. --push || true
  fi
  git remote add origin "${REMOTE}" 2>/dev/null || git remote set-url origin "${REMOTE}"
  git push -u origin main
  # Enable GitHub Pages from the main branch root.
  gh api -X POST "repos/${USER}/${REPO}/pages" -f source='{"branch":"main","path":"/"}' >/dev/null 2>&1 || \
    echo "Couldn't auto-enable Pages — do it manually in repo Settings ▸ Pages."
  echo "Done. Enable Pages in Settings ▸ Pages if it isn't already, then visit:"
  echo "  https://${USER}.github.io/${REPO}/"
else
  echo "-------------------------------------------------------------------"
  echo "'gh' is not installed/authenticated, so here's what to do manually:"
  echo "  git remote add origin ${REMOTE}"
  echo "  git push -u origin main"
  echo "Then on GitHub: Settings ▸ Pages ▸ Source = branch 'main' / root."
  echo "Your dock will be live at: https://${USER}.github.io/${REPO}/"
  echo "-------------------------------------------------------------------"
fi

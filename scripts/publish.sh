#!/bin/sh
# Builds ./public with update.mjs, then force-pushes it as the only commit on the
# gh-pages branch, which GitHub Pages serves. A single commit keeps the repo small.
# Needs GITHUB_REPO (owner/name) and GITHUB_TOKEN (contents: write on that repo).
set -eu

node scripts/update.mjs

cd public
git init -q -b gh-pages
git add -A
git -c user.name="FuelScout updater" -c user.email="fuelscout-updater@users.noreply.github.com" \
  commit -q -m "Fuel prices $(date -u +%Y-%m-%dT%H:%MZ)"

# Send the token as a header so it never appears in a URL or error message.
auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
git -c http.extraHeader="Authorization: Basic $auth" \
  push -q --force "https://github.com/$GITHUB_REPO.git" gh-pages
echo "Published to https://github.com/$GITHUB_REPO/tree/gh-pages"

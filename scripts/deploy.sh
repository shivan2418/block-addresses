#!/usr/bin/env bash
# Build the site around the already-built data in public/blockdb/, then publish dist/ as the
# gh-pages branch. Run `pnpm build-data` first whenever data/ has changed.
#
# The blocks are built from data/ (gitignored, 11 GB), so this runs locally, not in Actions.
# gh-pages is force-pushed as a single commit: it holds ~660 MB of content-hashed blocks, and
# keeping each deploy's history would grow the repo by that much every time.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f public/blockdb/manifest.json.gz ]; then
  echo "no public/blockdb/manifest.json.gz: run pnpm build-data first" >&2
  exit 1
fi

remote=$(git remote get-url origin)
pnpm build
touch dist/.nojekyll # plain static files; Jekyll would only slow down publishing ~9k of them

cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -q -f "$remote" gh-pages
rm -rf .git

#!/usr/bin/env bash
# Build the site around the already-built data in public/blockdb/, then publish dist/ as the
# gh-pages branch. Run `pnpm build-data` first whenever data/ has changed.
#
# The blocks are built from data/ (gitignored, 11 GB), so this runs locally, not in Actions.
#
# .gh-pages.git (gitignored) keeps the last deploy between runs. When the data is unchanged
# (same manifest), the new commit goes on top of it, so git knows what GitHub already has and
# the push uploads only changed files: a page-only change sends kilobytes. When the data was
# rebuilt, nearly every content-hashed block changes anyway, so the branch restarts as a
# single parentless commit instead, and GitHub can drop the old blocks rather than keep
# ~700 MB of history per data refresh.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f public/blockdb/manifest.json.gz ]; then
  echo "no public/blockdb/manifest.json.gz: run pnpm build-data first" >&2
  exit 1
fi

remote=${DEPLOY_REMOTE:-$(git remote get-url origin)}
source_commit=$(git rev-parse --short HEAD)
export GIT_AUTHOR_NAME GIT_COMMITTER_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
GIT_AUTHOR_NAME=$(git config user.name) GIT_AUTHOR_EMAIL=$(git config user.email)
GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
pnpm build
touch dist/.nojekyll # plain static files; Jekyll would only slow down publishing ~9k of them

export GIT_DIR="$PWD/.gh-pages.git" GIT_WORK_TREE="$PWD/dist"
if [ ! -d "$GIT_DIR" ]; then
  env -u GIT_DIR -u GIT_WORK_TREE git init -q --bare "$GIT_DIR"
  git config core.bare false # its work tree is dist/
  # First run on this machine: fetch what's deployed, so even this push sends only changes.
  git fetch -q --depth 1 "$remote" gh-pages:refs/heads/gh-pages 2>/dev/null || true
  git read-tree refs/heads/gh-pages 2>/dev/null || true
fi

# A browser may still hold the previous index.html for a few minutes (Pages caches for 10), and
# it loads the previous build's hashed scripts (and they, the search worker). Each deploy lists
# its own build's assets in .build-assets, and the next one keeps exactly those for one more
# deploy.
ls dist/assets | sed 's|^|assets/|' > dist/.build-assets
previous=$(git show refs/heads/gh-pages:.build-assets 2>/dev/null ||
  git show refs/heads/gh-pages:index.html 2>/dev/null | grep -o 'assets/[^"]*' || true) # before .build-assets existed
if [ -n "$previous" ]; then
  for f in $previous; do
    [ -e "dist/$f" ] || git show "refs/heads/gh-pages:$f" > "dist/$f"
  done
fi

git add -A
manifest=blockdb/manifest.json.gz
parent=()
if [ "$(git rev-parse -q --verify "refs/heads/gh-pages:$manifest" || true)" = "$(git hash-object "dist/$manifest")" ]; then
  parent=(-p refs/heads/gh-pages)
fi
commit=$(git commit-tree "$(git write-tree)" "${parent[@]}" -m "Deploy $source_commit")
git push -q -f "$remote" "$commit:refs/heads/gh-pages"
git update-ref refs/heads/gh-pages "$commit"
# After a data rebuild, drop the previous deploy's blocks from the local cache.
[ ${#parent[@]} -gt 0 ] || { git reflog expire --expire=now --all && git gc -q --prune=now; }

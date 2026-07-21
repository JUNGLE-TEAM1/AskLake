#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAIR_REF="${1:-origin/pair1}"
DEV_REF="${2:-origin/dev}"
PAIR_FILES="$(mktemp)"
DEV_FILES="$(mktemp)"
MERGE_OUTPUT="$(mktemp)"

cleanup() {
  rm -f "$PAIR_FILES" "$DEV_FILES" "$MERGE_OUTPUT"
}
trap cleanup EXIT

cd "$ROOT_DIR"
git rev-parse --verify "${PAIR_REF}^{commit}" >/dev/null
git rev-parse --verify "${DEV_REF}^{commit}" >/dev/null

pair_sha="$(git rev-parse "$PAIR_REF")"
dev_sha="$(git rev-parse "$DEV_REF")"
merge_base="$(git merge-base "$PAIR_REF" "$DEV_REF")"
read -r pair_unique dev_unique <<<"$(git rev-list --left-right --count "$PAIR_REF...$DEV_REF")"

git diff --name-only "$merge_base..$PAIR_REF" | sort >"$PAIR_FILES"
git diff --name-only "$merge_base..$DEV_REF" | sort >"$DEV_FILES"

merge_clean=true
if ! git merge-tree --write-tree "$PAIR_REF" "$DEV_REF" >"$MERGE_OUTPUT" 2>&1; then
  merge_clean=false
fi

conflict_count="$(sed -n 's/^CONFLICT (content): Merge conflict in //p' "$MERGE_OUTPUT" | wc -l | tr -d ' ')"

echo "pair_ref=$PAIR_REF"
echo "pair_sha=$pair_sha"
echo "dev_ref=$DEV_REF"
echo "dev_sha=$dev_sha"
echo "merge_base=$merge_base"
echo "pair_unique_commits=$pair_unique"
echo "dev_unique_commits=$dev_unique"
echo "pair_changed_files=$(wc -l <"$PAIR_FILES" | tr -d ' ')"
echo "dev_changed_files=$(wc -l <"$DEV_FILES" | tr -d ' ')"
echo "both_changed_files=$(comm -12 "$PAIR_FILES" "$DEV_FILES" | wc -l | tr -d ' ')"
echo "merge_clean=$merge_clean"
echo "conflict_count=$conflict_count"
sed -n 's/^CONFLICT (content): Merge conflict in /conflict_file=/p' "$MERGE_OUTPUT"

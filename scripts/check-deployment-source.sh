#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
git rev-parse --is-inside-work-tree >/dev/null

source_status=$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)
if [ -n "$source_status" ]; then
  printf '%s\n' 'Deployment stopped: the source checkout differs from its Git commit.' >&2
  printf '%s\n' "$source_status" >&2
  printf '%s\n' 'Review tracked changes and untracked files before building. No files were changed or deleted.' >&2
  exit 1
fi

printf 'Deployment source verified: %s\n' "$(git rev-parse --short HEAD)"

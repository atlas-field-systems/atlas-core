#!/usr/bin/env bash
set -euo pipefail
for attempt in 1 2 3 4 5; do
  if git push origin HEAD:refs/heads/eval-history; then exit 0; fi
  git fetch origin eval-history
  git rebase FETCH_HEAD || { git rebase --abort; exit 1; }
done
exit 1

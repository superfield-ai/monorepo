#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r tsconfig; do
  echo "::group::tsc --noEmit for $tsconfig"
  bun x tsc --noEmit --project "$tsconfig"
  echo "::endgroup::"
done < <(find . -name tsconfig.json -not -path '*/node_modules/*')

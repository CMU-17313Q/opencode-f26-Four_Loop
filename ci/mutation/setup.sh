#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<16)) { console.error("Use Node 22.16+ (CI uses Node 24)."); process.exit(1) }'
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts --no-audit --no-fund --workspaces=false
else
  if [ "${1:-}" = "--ci" ] || [ "${CI:-}" = "true" ]; then
    echo "Missing lockfile: run this setup.sh locally, then commit this directory's package-lock.json." >&2
    exit 1
  fi
  npm install --ignore-scripts --no-audit --no-fund --workspaces=false
  echo "Created package-lock.json. Review and commit it with this check."
fi

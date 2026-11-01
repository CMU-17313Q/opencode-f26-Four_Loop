#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
python3 install_k6.py
./bin/k6 version

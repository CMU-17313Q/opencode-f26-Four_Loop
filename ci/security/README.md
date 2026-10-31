# Retire.js scan scope

`check.mjs` scans JavaScript files under `packages/` and dependencies reachable through installed `node_modules` links. Bun's `.bun` store can retain old versions after an upgrade; scanning the whole store would report versions that the lockfile no longer installs. The inventory follows the live links instead.

One narrow exception skips `@mixmark-io/domino/.yarn/`. Its published tarball bundles a Yarn plugin containing lodash 4.17.21, while the repository installs lodash 4.18.1. The plugin is package-manager tooling, not Domino runtime code. Domino's runtime JavaScript remains in the scan. Owner: Yousef (P3 security check). Review by 2027-01-31 or when Domino changes version.

This is a JavaScript file scan, not a complete `bun.lock` audit. A clean result means Retire.js recognized at least one library and found no high or critical advisories in the scanned files at the fetched database revision. The inventory, database hash, report, and logs are retained as CI artifacts.

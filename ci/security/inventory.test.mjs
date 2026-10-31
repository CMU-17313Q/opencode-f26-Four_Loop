import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { stageJavaScript } from "./inventory.mjs"
test("stages physical Bun-store files once and excludes TypeScript", () => {
  const root = mkdtempSync(path.join(tmpdir(), "p3-inventory-"))
  try {
    mkdirSync(path.join(root, "packages/a"), { recursive: true })
    mkdirSync(path.join(root, "node_modules/.bun/demo/node_modules/demo"), { recursive: true })
    mkdirSync(path.join(root, "node_modules/.bun/stale/node_modules/stale"), { recursive: true })
    mkdirSync(path.join(root, "node_modules/.bun/domino/node_modules/@mixmark-io/domino/.yarn/plugins"), { recursive: true })
    writeFileSync(path.join(root, "packages/a/a.ts"), "export const x = 1")
    writeFileSync(path.join(root, "node_modules/.bun/demo/node_modules/demo/index.js"), "export const x = 1")
    writeFileSync(path.join(root, "node_modules/.bun/stale/node_modules/stale/index.js"), "// obsolete package")
    writeFileSync(path.join(root, "node_modules/.bun/domino/node_modules/@mixmark-io/domino/index.js"), "export const x = 1")
    writeFileSync(path.join(root, "node_modules/.bun/domino/node_modules/@mixmark-io/domino/.yarn/plugins/plugin.cjs"), "// vendored package-manager tooling")
    symlinkSync(".bun/demo/node_modules/demo", path.join(root, "node_modules/demo"))
    symlinkSync(".bun/domino/node_modules/@mixmark-io/domino", path.join(root, "node_modules/domino"))
    const items = stageJavaScript(root, path.join(root, "stage"))
    assert.equal(items.length, 2)
    assert.ok(items.every((item) => item.staged.includes("bun-store")))
    assert.ok(items.every((item) => !item.source.includes(".yarn")))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

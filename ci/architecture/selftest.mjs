import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const production = require("./config.cjs")
const temp = mkdtempSync(path.join(tmpdir(), "p3-architecture-"))
const log = []
mkdirSync(path.join(here, "out"), { recursive: true })
try {
  mkdirSync(path.join(temp, "src"))
  writeFileSync(path.join(temp, "package.json"), '{"type":"module"}')
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({ forbidden: production.forbidden, options: { includeOnly: "^src/", tsPreCompilationDeps: true } }))
  writeFileSync(path.join(temp, "src/a.js"), 'import { b } from "./b.js"; export function a() { return b() }\n')
  writeFileSync(path.join(temp, "src/b.js"), 'export function b() { return 1 }\n')
  const check = () => spawnSync(process.execPath, [path.join(here, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"), "--config", "config.json", "--output-type", "json", "src"], { cwd: temp, encoding: "utf8", timeout: 30000 })
  const clean = check()
  assert.equal(clean.status, 0, clean.stderr || clean.error?.message)
  assert.ok(JSON.parse(clean.stdout).modules.length >= 2)
  log.push("PASS: real dependency-cruiser accepted an acyclic JavaScript fixture.")
  writeFileSync(path.join(temp, "src/b.js"), 'import { a } from "./a.js"; export function b() { return a() }\n')
  const cyclic = check()
  assert.ok(!cyclic.error, cyclic.error?.message)
  const report = JSON.parse(cyclic.stdout)
  assert.ok(report.modules?.length >= 2, "Circular fixture produced no dependency graph")
  const cycles = report.summary?.violations?.filter((v) => v.rule?.name === "no-tool-cycles") ?? []
  assert.ok(cycles.length > 0, "No cycle rule violation in report: " + JSON.stringify(report.summary))
  log.push("PASS: real dependency-cruiser rejected the circular fixture with no-tool-cycles.")
  console.log(log.join("\n"))
  writeFileSync(path.join(here, "out/selftest.txt"), log.join("\n") + "\n")
} finally { rmSync(temp, { recursive: true, force: true }) }

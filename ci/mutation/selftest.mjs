import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const temp = mkdtempSync(path.join(tmpdir(), "p3-mutation-contract-"))
const pkg = path.join(temp, "packages/opencode")
const target = "src/tool/edit-explanation.ts"
const tests = "test/tool/edit-explanation-contract.test.ts"
const lines = []
try {
  for (const file of [target, tests]) {
    mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true })
    copyFileSync(path.join(root, "packages/opencode", file), path.join(pkg, file))
  }
  // This isolated pure-function self-test deliberately does not load application preloads.
  writeFileSync(path.join(pkg, "bunfig.toml"), "[test]\n")
  const run = () => spawnSync("bun", ["test", "--timeout", "30000", "./" + tests], { cwd: pkg, encoding: "utf8", timeout: 45000 })
  const clean = run()
  assert.equal(clean.status, 0, clean.error?.message || clean.stderr)
  lines.push("PASS: the actual validator satisfies the fixed specification tests.")
  const source = readFileSync(path.join(pkg, target), "utf8")
  const needle = "explanation.length > MAX_EDIT_EXPLANATION_LENGTH"
  assert.ok(source.includes(needle), "Validator changed; inspect and update the deliberate mutation test")
  writeFileSync(path.join(pkg, target), source.replace(needle, "explanation.length >= MAX_EDIT_EXPLANATION_LENGTH"))
  const broken = run()
  assert.ok(broken.status !== null && broken.status !== 0, "Boundary mutation incorrectly passed")
  assert.match((broken.stdout || "") + (broken.stderr || ""), /requirement is exactly 4000 characters/)
  lines.push("PASS: the tests reject an off-by-one mutation in an isolated copy; repository source is unchanged.")
  mkdirSync(path.join(here, "out"), { recursive: true })
  writeFileSync(path.join(here, "out/selftest.txt"), lines.join("\n") + "\n")
  console.log(lines.join("\n"))
} finally { rmSync(temp, { recursive: true, force: true }) }

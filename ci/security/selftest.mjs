import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assessSecurity } from "./policy.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(path.join(tmpdir(), "p3-retire-selftest-"))
const lines = []
try {
  const input = path.join(temp, "input")
  mkdirSync(input)
  const database = { "p3-selftest": {
    licenses: ["MIT >=0"],
    vulnerabilities: [{
      below: "2.0.0",
      severity: "high",
      cwe: ["CWE-20"],
      identifiers: { bug: "p3-selftest", summary: "Synthetic scanner self-test, not a real vulnerability" },
      info: ["https://example.invalid/p3-selftest"],
    }],
    extractors: { filename: ["p3-selftest-(§§version§§)\\.js"], hashes: {} },
  } }
  writeFileSync(path.join(temp, "db.json"), JSON.stringify(database))
  writeFileSync(path.join(temp, "ignore.json"), "[]")
  const check = (version) => {
    rmSync(input, { recursive: true, force: true }); mkdirSync(input)
    writeFileSync(path.join(input, `p3-selftest-${version}.js`), "// inert fixture; no vulnerable library is installed\n")
    const report = path.join(temp, "report.json")
    rmSync(report, { force: true })
    const run = spawnSync(process.execPath, [path.join(here, "node_modules/retire/lib/cli.js"), "--path", input, "--jsrepo", path.join(temp, "db.json"), "--ignorefile", path.join(temp, "ignore.json"), "--verbose", "--severity", "high", "--exitwith", "13", "--outputformat", "json", "--outputpath", report], { cwd: temp, encoding: "utf8", timeout: 30000 })
    if (run.error) throw run.error
    return { status: run.status, report: JSON.parse(readFileSync(report, "utf8")), stderr: run.stderr }
  }
  const clean = check("2.0.0")
  assert.equal(clean.status, 0, clean.stderr)
  assessSecurity(clean.report, 1, clean.status)
  lines.push("PASS: real Retire.js accepted the non-vulnerable synthetic fixture.")
  const vulnerable = check("1.0.0")
  assert.equal(vulnerable.status, 13, vulnerable.stderr)
  assert.ok(vulnerable.report.data.some((f) => f.results.some((r) => r.component === "p3-selftest" && r.vulnerabilities?.some((v) => v.severity === "high"))))
  assert.throws(() => assessSecurity(vulnerable.report, 1, vulnerable.status))
  lines.push("PASS: real Retire.js and the policy gate rejected the synthetic high-severity fixture.")
  mkdirSync(path.join(here, "out"), { recursive: true })
  writeFileSync(path.join(here, "out/selftest.txt"), lines.join("\n") + "\n")
  console.log(lines.join("\n"))
} finally { rmSync(temp, { recursive: true, force: true }) }

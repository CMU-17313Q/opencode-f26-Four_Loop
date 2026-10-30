import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { assessGraph, isAllowedSelfExport } from "./policy.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const out = path.join(here, "out")
mkdirSync(out, { recursive: true })
const run = spawnSync(process.execPath, [
  path.join(here, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"),
  "--config", "ci/architecture/config.cjs", "--output-type", "json",
  "packages/opencode/src/tool",
], { cwd: root, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 })
writeFileSync(path.join(out, "report.json"), run.stdout || "")
writeFileSync(path.join(out, "scanner.log"), run.stderr || "")
if (run.stderr) process.stderr.write(run.stderr)
if (run.error || run.status !== 0) {
  console.error(run.error?.message || `dependency-cruiser exited ${run.status}. Inspect ci/architecture/out/report.json.`)
  process.exit(1)
}
const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"))
const count = assessGraph(report, "packages/opencode/src/tool/edit-explanation.ts", 5)
const accepted = report.summary.violations.filter(isAllowedSelfExport)
writeFileSync(path.join(out, "accepted-self-exports.json"), JSON.stringify(accepted, null, 2) + "\n")
console.log(`Allowed ${accepted.length} reviewed namespace self-export(s); no files excluded.`)
console.log(`Architecture check passed: ${count} modules analyzed in the declared scope.`)

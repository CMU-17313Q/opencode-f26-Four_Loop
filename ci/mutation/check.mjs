import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { validateMutationReport } from "./policy.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const out = path.join(here, "out")
mkdirSync(out, { recursive: true })
rmSync(path.join(out, "mutation.json"), { force: true })
const run = spawnSync(process.execPath, [path.join(here, "node_modules/@stryker-mutator/core/bin/stryker.js"), "run", "ci/mutation/stryker.config.cjs"], {
  cwd: root, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
})
writeFileSync(path.join(out, "stryker.log"), (run.stdout || "") + (run.stderr || ""))
process.stdout.write(run.stdout || "")
process.stderr.write(run.stderr || "")
if (run.error || run.status !== 0) {
  console.error(run.error?.message || `Stryker exited ${run.status}; do not lower the threshold just to get green.`)
  process.exit(1)
}
const count = validateMutationReport(JSON.parse(readFileSync(path.join(out, "mutation.json"), "utf8")))
console.log(`Completed mutation run: ${count} mutants. Stryker enforced the 80% failure threshold.`)

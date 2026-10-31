import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { stageJavaScript } from "./inventory.mjs"
import { assessSecurity } from "./policy.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const out = path.join(here, "out")
const temp = mkdtempSync(path.join(tmpdir(), "p3-retire-scan-"))
const databaseURL = "https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v5.json"
mkdirSync(out, { recursive: true })
rmSync(path.join(out, "report.json"), { force: true })
try {
  if (!existsSync(path.join(root, "node_modules"))) throw new Error("Run bun install --frozen-lockfile from the repository root first")
  const stage = path.join(temp, "inputs")
  mkdirSync(stage)
  const inputs = stageJavaScript(root, stage)
  writeFileSync(path.join(out, "inventory.json"), JSON.stringify(inputs, null, 2) + "\n")
  if (!inputs.length) throw new Error("No JavaScript files found in repository/dependencies")
  const response = await fetch(databaseURL, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Vulnerability data download failed: HTTP ${response.status}`)
  const database = await response.text()
  const parsed = JSON.parse(database)
  if (Object.keys(parsed).length < 10 || !parsed.jquery) throw new Error("Unexpected/empty vulnerability database")
  const db = path.join(temp, "jsrepository.json")
  writeFileSync(db, database)
  writeFileSync(path.join(out, "database.json"), JSON.stringify({ url: databaseURL, fetchedAt: new Date().toISOString(), sha256: createHash("sha256").update(database).digest("hex") }, null, 2) + "\n")
  // No production ignores by default. Any future exception needs explicit review.
  const emptyIgnores = path.join(temp, "empty-ignores.json")
  writeFileSync(emptyIgnores, "[]\n")
  const run = spawnSync(process.execPath, [path.join(here, "node_modules/retire/lib/cli.js"),
    "--path", stage, "--ext", "js,mjs,cjs", "--jsrepo", db,
    "--ignorefile", emptyIgnores, "--verbose", "--severity", "high", "--exitwith", "13",
    "--outputformat", "json", "--outputpath", path.join(out, "report.json"),
  ], { cwd: temp, encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(path.join(out, "scanner.log"), (run.stdout || "") + (run.stderr || ""))
  if (run.stderr) process.stderr.write(run.stderr)
  if (run.error || ![0,13].includes(run.status)) throw new Error(run.error?.message || `Retire.js exited ${run.status}; inspect scanner.log`)
  const summary = assessSecurity(JSON.parse(readFileSync(path.join(out, "report.json"), "utf8")), inputs.length, run.status)
  writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify(summary, null, 2))
  console.log("PASS: completed file-based scan under the high/critical policy; this is not a complete bun.lock audit.")
} finally { rmSync(temp, { recursive: true, force: true }) }

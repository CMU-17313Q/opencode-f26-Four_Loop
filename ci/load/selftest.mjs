import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, "out")
mkdirSync(out, { recursive: true })
const temp = mkdtempSync(path.join(tmpdir(), "p3-load-selftest-"))
const lines = []
try {
  for (const healthy of [true, false]) {
    const server = createServer((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ healthy })) })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const base = `http://127.0.0.1:${server.address().port}`
      const summary = path.join(out, `selftest-${healthy}.json`)
      const run = spawn(path.join(here, "bin/k6"), ["run", "--quiet", path.join(here, "opencode-load.js")], {
        cwd: out,
        env: {
          PATH: process.env.PATH, HOME: temp, LANG: "C.UTF-8", TMPDIR: temp,
          XDG_CONFIG_HOME: path.join(temp, "config"), XDG_CACHE_HOME: path.join(temp, "cache"),
          P3_BASE_URL: base, P3_SELFTEST: "1", P3_SUMMARY_PATH: summary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      run.stdout.on("data", (data) => { output += data })
      run.stderr.on("data", (data) => { output += data })
      const timer = setTimeout(() => run.kill("SIGKILL"), 20000)
      const status = await new Promise((resolve, reject) => { run.once("error", reject); run.once("close", resolve) }).finally(() => clearTimeout(timer))
      writeFileSync(path.join(out, `selftest-${healthy}.log`), output)
      assert.equal(status, healthy ? 0 : 99, output)
      const report = JSON.parse(readFileSync(summary, "utf8"))
      assert.equal(report.metrics.checks.thresholds["rate>=0.99"].ok, healthy)
      lines.push(healthy ? "PASS: real k6 accepted a healthy local fixture." : "PASS: real k6 failed its threshold on an unhealthy local fixture (exit 99).")
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  }
} finally { rmSync(temp, { recursive: true, force: true }) }
writeFileSync(path.join(out, "selftest.txt"), lines.join("\n") + "\n")
console.log(lines.join("\n"))

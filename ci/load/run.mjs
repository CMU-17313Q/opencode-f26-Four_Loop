import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isHealthy, assertLoopback } from "./policy.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")
const out = path.join(here, "out")
const temp = mkdtempSync(path.join(tmpdir(), "p3-opencode-load-"))
mkdirSync(out, { recursive: true })
const portProbe = createServer()
await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve) })
const port = portProbe.address().port
await new Promise((resolve) => portProbe.close(resolve))
const base = `http://127.0.0.1:${port}`
assertLoopback(base)
const serverLog = openSync(path.join(out, "server.log"), "w")
const env = {
  PATH: process.env.PATH, HOME: temp, LANG: "C.UTF-8", TMPDIR: temp,
  XDG_DATA_HOME: path.join(temp, "data"), XDG_CONFIG_HOME: path.join(temp, "config"),
  XDG_CACHE_HOME: path.join(temp, "cache"), XDG_STATE_HOME: path.join(temp, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PURE: "1",
  OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"deny"}}',
}
const server = spawn("bun", ["run", "--conditions=browser", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(root, "packages/opencode"), env, detached: process.platform !== "win32", stdio: ["ignore", serverLog, serverLog],
})
closeSync(serverLog)
let startupError
server.once("error", (error) => { startupError = error })
let loadProcess
async function stop() {
  if (loadProcess && loadProcess.exitCode === null) loadProcess.kill("SIGKILL")
  if (server.pid && server.exitCode === null) {
    try { process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGTERM") } catch {}
    await Promise.race([once(server, "close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))])
    if (server.exitCode === null) {
      try { process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGKILL") } catch {}
    }
  }
  rmSync(temp, { recursive: true, force: true })
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)) })
try {
  const deadline = Date.now() + 120000
  let ready = false
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}; inspect ci/load/out/server.log`)
    try {
      const response = await fetch(base + "/global/health", { signal: AbortSignal.timeout(2000), redirect: "error" })
      ready = isHealthy(response.status, await response.json())
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error("Server was not healthy within 120 seconds; inspect server.log")
  console.log("Temporary OpenCode is ready. Running 5 virtual users for 60 seconds on loopback only.")
  const summary = path.join(out, "summary.json")
  rmSync(summary, { force: true })
  const loadLog = openSync(path.join(out, "k6.log"), "w")
  loadProcess = spawn(path.join(here, "bin/k6"), ["run", "--quiet", path.join(here, "opencode-load.js")], {
    cwd: out, env: { PATH: process.env.PATH, HOME: temp, P3_BASE_URL: base, P3_SUMMARY_PATH: summary }, stdio: ["ignore", loadLog, loadLog],
  })
  closeSync(loadLog)
  const timer = setTimeout(() => loadProcess.kill("SIGKILL"), 100000)
  const code = await new Promise((resolve, reject) => { loadProcess.once("error", reject); loadProcess.once("close", resolve) }).finally(() => clearTimeout(timer))
  console.log(readFileSync(path.join(out, "k6.log"), "utf8"))
  if (code !== 0) throw new Error(`k6 failed with status ${code}; do not suppress the failure`)
  const data = JSON.parse(readFileSync(summary, "utf8"))
  if (!data.metrics?.http_reqs?.values?.count) throw new Error("Missing measured requests")
  console.log(JSON.stringify({ requests: data.metrics.http_reqs.values.count, p95Milliseconds: data.metrics.http_req_duration.values["p(95)"], errorRate: data.metrics.http_req_failed.values.rate }, null, 2))
  console.log("PASS: real local OpenCode passed all configured k6 thresholds.")
} finally { await stop() }

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { once } from "node:events"
import { Process } from "@/util/process"
import { withTimeout } from "@/util/timeout"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("run forwards an already aborted signal", async () => {
    const abort = AbortSignal.abort(new Error("cancelled before start"))
    await expect(Process.run(node("process.exit(0)"), { abort })).rejects.toThrow("cancelled before start")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const proc = Process.spawn(node('setInterval(() => {}, 1000); process.stdout.write("ready")'), {
      abort: abort.signal,
      stdout: "pipe",
    })
    try {
      if (!proc.stdout) throw new Error("Process output not available")
      // Child startup is separate from the deadline for handling cancellation.
      const [ready] = await withTimeout(once(proc.stdout, "data"), 5_000, "Child did not become ready")
      expect(ready.toString()).toBe("ready")
      abort.abort()
      expect(await withTimeout(proc.exited, 2_500, "Child did not stop after abort")).not.toBe(0)
      if (process.platform !== "win32") expect(proc.signalCode).toBe("SIGTERM")
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
      await proc.exited
    }
  }, 10_000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const proc = Process.spawn(
      node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready")'),
      {
        abort: abort.signal,
        stdout: "pipe",
        timeout: 25,
      },
    )
    try {
      if (!proc.stdout) throw new Error("Process output not available")
      const [ready] = await withTimeout(once(proc.stdout, "data"), 5_000, "Child did not install its signal handler")
      expect(ready.toString()).toBe("ready")
      abort.abort()
      expect(await withTimeout(proc.exited, 2_500, "Child was not killed after its termination grace period")).not.toBe(
        0,
      )
      expect(proc.signalCode).toBe("SIGKILL")
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
      await proc.exited
    }
  }, 10_000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.OPENCODE_TEST ?? "")'), {
      env: {
        OPENCODE_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "OPENCODE_TEST_SHELL"], {
      shell: true,
      env: {
        OPENCODE_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("OPENCODE_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })
})

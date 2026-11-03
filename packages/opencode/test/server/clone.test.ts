import { describe, expect, test } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Git } from "../../src/git"
import { ProjectClone } from "../../src/server/routes/instance/httpapi/clone"
import { testEffect } from "../lib/effect"

describe("ProjectClone.repoName", () => {
  test("derives the folder name from public https URLs", () => {
    expect(ProjectClone.repoName("https://github.com/octocat/Hello-World.git")).toBe("Hello-World")
    expect(ProjectClone.repoName("https://github.com/octocat/Hello-World")).toBe("Hello-World")
    expect(ProjectClone.repoName("https://gitlab.com/group/sub/my_repo.git/")).toBe("my_repo")
  })

  test("rejects non-https, credentialed, and unsafe URLs", () => {
    expect(ProjectClone.repoName("git@github.com:octocat/Hello-World.git")).toBeUndefined()
    expect(ProjectClone.repoName("http://github.com/octocat/Hello-World")).toBeUndefined()
    expect(ProjectClone.repoName("file:///etc/passwd")).toBeUndefined()
    expect(ProjectClone.repoName("https://user:token@github.com/octocat/Hello-World")).toBeUndefined()
    expect(ProjectClone.repoName("https://github.com/octocat/..")).toBeUndefined()
    expect(ProjectClone.repoName("https://github.com/")).toBeUndefined()
    expect(ProjectClone.repoName("not a url")).toBeUndefined()
  })
})

test("rejects unapproved hosts, custom ports, queries, and fragments", () => {
  expect(ProjectClone.repoName("https://localhost/owner/repo.git")).toBeUndefined()
  expect(ProjectClone.repoName("https://127.0.0.1/owner/repo.git")).toBeUndefined()
  expect(ProjectClone.repoName("https://github.com.evil.example/owner/repo.git")).toBeUndefined()
  expect(ProjectClone.repoName("https://example.com/owner/repo.git")).toBeUndefined()
  expect(ProjectClone.repoName("https://github.com:8443/owner/repo.git")).toBeUndefined()
  expect(ProjectClone.repoName("https://github.com/owner/repo.git?token=secret")).toBeUndefined()
  expect(ProjectClone.repoName("https://github.com/owner/repo.git#fragment")).toBeUndefined()
})

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

function request(name: string, run: Git.Interface["run"]) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    return yield* ProjectClone.handler({ fs, git })
  }).pipe(
    Effect.provide(Layer.mock(Git.Service, { run })),
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://localhost/experimental/clone", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: `https://github.com/owner/${name}.git` }),
        }),
      ),
    ),
    Effect.map(HttpServerResponse.toWeb),
  )
}

function result(exitCode = 0, stderr = ""): Git.Result {
  return { exitCode, text: () => "", stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), truncated: false }
}

describe("ProjectClone resource limits", () => {
  it.live("publishes a complete shallow clone and removes its staging directory", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const directory = path.join(Global.Path.home, "projects", "resource-success")
      const response = yield* request("resource-success", (args, options) =>
        Effect.gen(function* () {
          expect(args).toContain("--depth=1")
          expect(args).toContain("--single-branch")
          expect(args).toContain("--no-tags")
          expect(options.forceKillAfter).toBe("5 seconds")
          expect(options.maxOutputBytes).toBe(64 * 1024)
          const target = args.at(-1)!
          expect(target).not.toBe(directory)
          yield* fs.writeWithDirs(path.join(target, "README"), "complete").pipe(Effect.orDie)
          return result()
        }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({ directory, existing: false })
      expect(yield* fs.readFileString(path.join(directory, "README"))).toBe("complete")
      expect(
        (yield* fs.readDirectoryEntries(path.dirname(directory))).some((entry) => entry.name.startsWith(".clone-")),
      ).toBe(false)
    }),
  )

  it.live("removes failed clones so retrying downloads the repository again", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const directory = path.join(Global.Path.home, "projects", "resource-retry")
      const failed = yield* request("resource-retry", (args) =>
        Effect.gen(function* () {
          yield* fs.writeWithDirs(path.join(args.at(-1)!, "README"), "partial").pipe(Effect.orDie)
          return result(1, "download failed")
        }),
      )
      expect(failed.status).toBe(422)
      expect(yield* fs.existsSafe(directory)).toBe(false)
      const retried = yield* request("resource-retry", (args) =>
        Effect.gen(function* () {
          yield* fs.writeWithDirs(path.join(args.at(-1)!, "README"), "retried").pipe(Effect.orDie)
          return result()
        }),
      )
      expect(retried.status).toBe(200)
      expect(yield* fs.readFileString(path.join(directory, "README"))).toBe("retried")
    }),
  )

  it.effect("interrupts a stalled clone at two minutes and cleans up before allowing a retry", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const ready = yield* Deferred.make<string>()
      const interrupted = yield* Deferred.make<void>()
      const directory = path.join(Global.Path.home, "projects", "resource-timeout")
      const running = yield* request("resource-timeout", (args) =>
        Effect.gen(function* () {
          const target = args.at(-1)!
          yield* fs.writeWithDirs(path.join(target, "README"), "partial").pipe(Effect.orDie)
          yield* Deferred.succeed(ready, target)
          return yield* Effect.never
        }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      const target = yield* Deferred.await(ready)
      yield* TestClock.adjust("2 minutes")
      const response = yield* Fiber.join(running)
      expect(response.status).toBe(504)
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
      expect(yield* fs.existsSafe(path.dirname(target))).toBe(false)
      expect(yield* fs.existsSafe(directory)).toBe(false)
      const retried = yield* request("resource-timeout", (args) =>
        Effect.gen(function* () {
          yield* fs.writeWithDirs(path.join(args.at(-1)!, "README"), "retry after timeout").pipe(Effect.orDie)
          return result()
        }),
      )
      expect(retried.status).toBe(200)
    }),
  )

  it.live("rejects a concurrent clone and releases the permit after the first finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let calls = 0
      const run: Git.Interface["run"] = (args) =>
        Effect.gen(function* () {
          calls += 1
          yield* fs.writeWithDirs(path.join(args.at(-1)!, "README"), "complete").pipe(Effect.orDie)
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          return result()
        })
      const first = yield* request("resource-concurrent-first", run).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(ready)
      const second = yield* request("resource-concurrent-second", run)
      expect(second.status).toBe(429)
      expect(calls).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).status).toBe(200)
      expect((yield* request("resource-concurrent-second", run)).status).toBe(200)
      expect(calls).toBe(2)
    }),
  )
})

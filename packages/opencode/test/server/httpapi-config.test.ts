import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false, explain_before_edit: true }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
        explain_before_edit: true,
      })
      const reloaded = yield* Effect.promise(() =>
        Promise.resolve(app().request(`/config?directory=${encodeURIComponent(tmp.path)}`)),
      )
      expect(reloaded.status).toBe(200)
      expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({
        username: "patched-user",
        explain_before_edit: true,
      })
    }),
  )

  it.live(
    "persists project review toggles in the active JSONC file without affecting another project",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false, username: "keep-json" } })
      const other = yield* tmpdirEffect({ config: { formatter: false, lsp: false, explain_before_edit: false } })
      const file = path.join(tmp.path, "opencode.jsonc")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          '{\n  // Preserve this project comment.\n  "username": "keep-jsonc",\n  "explain_before_edit": false\n}\n',
        ),
      )
      for (const enabled of [true, false]) {
        const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request(`/config?directory=${encodeURIComponent(tmp.path)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ explain_before_edit: enabled }),
            }),
          ),
        )
        expect(response.status).toBe(200)
        yield* Fiber.join(disposed)
        const loaded = yield* Effect.promise(() =>
          Promise.resolve(app().request(`/config?directory=${encodeURIComponent(tmp.path)}`)),
        )
        expect(yield* Effect.promise(() => loaded.json())).toMatchObject({
          username: "keep-jsonc",
          explain_before_edit: enabled,
          formatter: false,
        })
        expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("// Preserve this project comment.")
        const untouched = yield* Effect.promise(() =>
          Promise.resolve(app().request(`/config?directory=${encodeURIComponent(other.path)}`)),
        )
        expect(yield* Effect.promise(() => untouched.json())).toMatchObject({ explain_before_edit: false })
      }
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json())).toMatchObject({
        username: "keep-json",
      })
    }),
  )

  it.live(
    "creates discoverable configuration for a newly cloned project",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect(undefined)
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request(`/config?directory=${encodeURIComponent(tmp.path)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ explain_before_edit: true, formatter: false, lsp: false }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json())).toMatchObject({
        explain_before_edit: true,
      })
      const loaded = yield* Effect.promise(() =>
        Promise.resolve(app().request(`/config?directory=${encodeURIComponent(tmp.path)}`)),
      )
      expect(yield* Effect.promise(() => loaded.json())).toMatchObject({ explain_before_edit: true })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})

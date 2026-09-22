import { expect } from "bun:test"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { MAX_EDIT_EXPLANATION_LENGTH } from "../../src/tool/edit-explanation"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Exercise real configuration and permission services. Reuse existing fixtures
// only for external account/auth/network/package-install dependencies.
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, Config.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`Unexpected HTTP request: ${request.url}`)),
      ),
    ],
  ],
)
const it = testEffect(env)
const enabled = { git: true, config: { explain_before_edit: true } }

function proposal(overrides: Partial<PermissionV1.AskInput> = {}): PermissionV1.AskInput {
  return {
    id: PermissionV1.ID.ascending(),
    sessionID: SessionID.make("session_explain_test"),
    permission: "edit",
    patterns: ["src/example.ts"],
    metadata: {
      filepath: "src/example.ts",
      diff: "-return total / items.length\n+return items.length ? total / items.length : 0",
      explanation: "Handle the empty-list case to avoid division by zero.",
    },
    always: ["*"],
    ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
    ...overrides,
  }
}

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const pending = yield* permission.list()
        if (pending.length === count) return pending
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error(`Timed out waiting for ${count} pending requests`)),
      }),
    )
  })

function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("Expected the permission request to fail")
  })
}

it.instance(
  "explain mode loads config, overrides allow, and derives trusted metadata",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      expect((yield* config.get()).explain_before_edit).toBe(true)
      const permission = yield* Permission.Service
      const metadata = { diff: "example diff", explanation: "  Explain this change.  ", explainBeforeEdit: false }
      const request = proposal({ metadata })
      const fiber = yield* permission.ask(request).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].metadata).toEqual({
        diff: "example diff",
        explanation: "Explain this change.",
        explainBeforeEdit: true,
      })
      expect(pending[0].always).toEqual([])
      expect(metadata.explanation).toBe("  Explain this change.  ")
      expect(metadata.explainBeforeEdit).toBe(false)
      yield* permission.reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  enabled,
)

for (const config of [{}, { explain_before_edit: false }]) {
  it.instance(
    `disabled or omitted setting preserves automatic approval: ${JSON.stringify(config)}`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        yield* permission.ask(proposal({ metadata: {} }))
        expect(yield* permission.list()).toHaveLength(0)
      }),
    { git: true, config },
  )
}

it.instance(
  "enabled setting does not change non-edit permission behavior",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.ask(
        proposal({
          permission: "read",
          metadata: {},
          ruleset: [{ permission: "read", pattern: "*", action: "allow" }],
        }),
      )
      expect(yield* permission.list()).toHaveLength(0)
    }),
  enabled,
)

for (const explanation of [undefined, null, 12, {}, "", "  \n ", "x".repeat(MAX_EDIT_EXPLANATION_LENGTH + 1)]) {
  it.instance(
    `enabled setting rejects invalid explanation (${typeof explanation}, length ${String(explanation).length})`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const error = yield* failure(permission.ask(proposal({ metadata: { explanation } })))
        expect(error).toBeInstanceOf(PermissionV1.InvalidExplanationError)
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )
}

it.instance(
  "configured deny wins before explanation validation",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const error = yield* failure(
        permission.ask(proposal({ metadata: {}, ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] })),
      )
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  enabled,
)

it.instance(
  "enabled mode preserves last-matching-rule precedence",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const request = proposal({
        ruleset: [
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "edit", pattern: "src/*", action: "allow" },
        ],
      })
      const fiber = yield* permission.ask(request).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* permission.reply({ requestID: pending[0].id, reply: "once" })
      yield* Fiber.join(fiber)
      const error = yield* failure(permission.ask(proposal({ ruleset: [...request.ruleset].reverse() })))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  enabled,
)

it.instance(
  "always is downgraded to once and does not release another or a future proposal",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const events = yield* EventV2Bridge.Service
      const seen: unknown[] = []
      const stop = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type) seen.push(event.data)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => stop)
      const first = proposal()
      const second = proposal()
      const one = yield* permission.ask(first).pipe(Effect.forkScoped)
      const two = yield* permission.ask(second).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(2)
      // Reply policy must use the internal flag, not mutable public metadata.
      const exposed = pending.find((item) => item.id === first.id)!
      Object.assign(exposed.metadata, { explainBeforeEdit: false })
      yield* permission.reply({ requestID: first.id!, reply: "always" })
      yield* Fiber.join(one)
      expect((yield* permission.list()).map((item) => item.id)).toEqual([second.id!])
      expect(seen).toContainEqual({ sessionID: first.sessionID, requestID: first.id!, reply: "once" })
      yield* permission.reply({ requestID: second.id!, reply: "once" })
      yield* Fiber.join(two)
      const third = proposal()
      const three = yield* permission.ask(third).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* permission.reply({ requestID: third.id!, reply: "once" })
      yield* Fiber.join(three)
    }),
  enabled,
)

it.instance(
  "legacy remembered approval neither skips enabled review nor overrides a configured deny",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const settings = yield* config.get()
      const permission = yield* Permission.Service
      const legacy = proposal({ metadata: {}, ruleset: [] })
      const old = yield* permission.ask(legacy).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* permission.reply({ requestID: legacy.id!, reply: "always" })
      yield* Fiber.join(old)
      // Model a setting transition while retaining the same permission state.
      settings.explain_before_edit = true
      const next = proposal({ ruleset: [] })
      const nextFiber = yield* permission.ask(next).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* permission.reply({ requestID: next.id!, reply: "once" })
      yield* Fiber.join(nextFiber)
      const error = yield* failure(
        permission.ask(proposal({ ruleset: [{ permission: "edit", pattern: "*", action: "deny" }] })),
      )
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true, config: { explain_before_edit: false } },
)

it.instance(
  "a legacy bulk approval skips a protected pending proposal",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const settings = yield* config.get()
      const permission = yield* Permission.Service
      const legacy = proposal({ metadata: {}, ruleset: [] })
      const old = yield* permission.ask(legacy).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      settings.explain_before_edit = true
      const protectedRequest = proposal()
      const protectedFiber = yield* permission.ask(protectedRequest).pipe(Effect.forkScoped)
      yield* waitForPending(2)
      yield* permission.reply({ requestID: legacy.id!, reply: "always" })
      yield* Fiber.join(old)
      expect((yield* permission.list()).map((item) => item.id)).toEqual([protectedRequest.id!])
      yield* permission.reply({ requestID: protectedRequest.id!, reply: "once" })
      yield* Fiber.join(protectedFiber)
    }),
  { git: true, config: { explain_before_edit: false } },
)

it.instance(
  "disabled mode keeps legacy ask/always behavior and strips a forged feature marker",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const legacy = proposal({ metadata: { explainBeforeEdit: true }, ruleset: [] })
      const fiber = yield* permission.ask(legacy).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending[0].metadata.explainBeforeEdit).toBeUndefined()
      expect(pending[0].always).toEqual(["*"])
      yield* permission.reply({ requestID: legacy.id!, reply: "always" })
      yield* Fiber.join(fiber)
      yield* permission.ask(proposal({ metadata: {}, ruleset: [] }))
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true, config: { explain_before_edit: false } },
)

for (const answer of ["once", "reject"] as const) {
  it.instance(
    `filesystem continuation waits for approval: ${answer}`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const instance = yield* TestInstance
        const file = path.join(instance.directory, "approval-sentinel.txt")
        yield* Effect.promise(() => Bun.write(file, "before"))
        const request = proposal({ patterns: [file] })
        // This is a real write AFTER the permission boundary, not an edit-tool integration test.
        const fiber = yield* permission
          .ask(request)
          .pipe(Effect.andThen(Effect.promise(() => Bun.write(file, "after"))), Effect.forkScoped)
        yield* waitForPending(1)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("before")
        yield* permission.reply({ requestID: request.id!, reply: answer })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(answer === "once")
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(answer === "once" ? "after" : "before")
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )
}

it.instance(
  "interrupting a request removes it without permitting its continuation",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      let continued = false
      const fiber = yield* permission.ask(proposal()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            continued = true
          }),
        ),
        Effect.forkScoped,
      )
      yield* waitForPending(1)
      yield* Fiber.interrupt(fiber)
      expect(continued).toBe(false)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  enabled,
)

it.instance(
  "empty pattern lists do not bypass enabled review",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const request = proposal({ patterns: [] })
      const fiber = yield* permission.ask(request).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* permission.reply({ requestID: request.id!, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  enabled,
)

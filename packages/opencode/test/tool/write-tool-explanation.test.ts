import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import type * as Scope from "effect/Scope"
import { Account } from "../../src/account/account"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID, MessageID } from "../../src/session/schema"
import { WriteTool, Parameters as WriteParameters } from "../../src/tool/write"
import { MAX_EDIT_EXPLANATION_LENGTH } from "../../src/tool/edit-explanation"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"

// Runs the real write tool, filesystem, config, and permission service together.
// Only external account/auth/network/package installation is swapped for existing fakes.
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    Config.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    FSUtil.node,
    LSP.node,
    Format.node,
    Truncate.node,
    Agent.node,
  ]),
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

type TestRequirements =
  | Permission.Service
  | Config.Service
  | InstanceStore.Service
  | LSP.Service
  | FSUtil.Service
  | Format.Service
  | EventV2Bridge.Service
  | Truncate.Service
  | Agent.Service
  | TestInstance
  | Scope.Scope

// Use runPromise so an Effect failure rejects the Bun test instead of resolving quietly.
const it = {
  instance(
    name: string,
    body: () => Effect.Effect<unknown, unknown, TestRequirements>,
    options: { git?: boolean; config?: Partial<ConfigV1.Info> },
  ) {
    return test(name, () =>
      Effect.runPromise(body().pipe(withTmpdirInstance(options), Effect.scoped, Effect.provide(env))),
    )
  },
}

const enabled = { git: true, config: { explain_before_edit: true, formatter: false, lsp: false } } as const
const sessionID = SessionID.make("ses_write_explanation")
const explanation = "Replace the old greeting in target.txt so the student sees the requested new greeting."
const allow: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]

function context(permission: Permission.Interface, ruleset = allow): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_write_explanation"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => permission.ask({ ...input, sessionID, ruleset }).pipe(Effect.orDie),
  }
}

const runWrite = Effect.fn("WriteExplanationTest.run")(function* (
  filePath: string,
  explanation: string | undefined,
  ctx: Tool.Context,
) {
  const info = yield* WriteTool
  const tool = yield* info.init()
  return yield* tool.execute({ filePath, content: "new\n", ...(explanation === undefined ? {} : { explanation }) }, ctx)
})

const waitForPending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* Effect.gen(function* () {
    while (true) {
      const pending = yield* permission.list()
      if (pending.length > 0) return pending[0]
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("No permission request appeared; inspect the tool failure")),
    }),
  )
})

function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("Expected the write to fail")
  })
}

// existed = true  -> target.txt already contains "old\n" (overwrite case)
// existed = false -> nested/target.txt does not exist yet (create case)
const target = (existed: boolean) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, existed ? "target.txt" : "nested/target.txt")
    if (existed) yield* Effect.promise(() => fs.writeFile(file, "old\n"))
    return file
  })

const unchanged = (file: string, existed: boolean) =>
  Effect.gen(function* () {
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(existed)
    if (existed) expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("old\n")
  })

for (const existed of [true, false]) {
  const name = `write ${existed ? "existing" : "new"} file`

  it.instance(
    `${name}: explanation and diff arrive before writing; approval writes the file`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const fiber = yield* runWrite(file, `  ${explanation}  `, context(permission)).pipe(Effect.forkScoped)
        const request = yield* waitForPending
        expect(request.permission).toBe("edit")
        expect(request.metadata.explainBeforeEdit).toBe(true)
        expect(request.metadata.explanation).toBe(explanation)
        expect(request.metadata.filepath).toBe(file)
        expect(request.metadata.diff).toContain("+new")
        expect(request.always).toEqual([])
        yield* unchanged(file, existed)
        yield* permission.reply({ requestID: request.id, reply: "once" })
        yield* Fiber.join(fiber)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("new\n")
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )

  it.instance(
    `${name}: rejection leaves the target unchanged`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const fiber = yield* runWrite(file, explanation, context(permission)).pipe(Effect.forkScoped)
        const request = yield* waitForPending
        yield* permission.reply({ requestID: request.id, reply: "reject" })
        expect(yield* failure(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
        yield* unchanged(file, existed)
      }),
    enabled,
  )

  for (const invalid of [undefined, " \n ", "x".repeat(MAX_EDIT_EXPLANATION_LENGTH + 1)]) {
    const label = invalid === undefined ? "missing" : invalid.trim() === "" ? "blank" : "too long"
    it.instance(
      `${name}: ${label} explanation blocks the write`,
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const file = yield* target(existed)
          expect(yield* failure(runWrite(file, invalid, context(permission)))).toBeInstanceOf(
            PermissionV1.InvalidExplanationError,
          )
          yield* unchanged(file, existed)
          expect(yield* permission.list()).toHaveLength(0)
        }),
      enabled,
    )
  }

  for (const setting of [false, undefined]) {
    it.instance(
      `${name}: disabled/omitted setting (${String(setting)}) keeps old behavior without an explanation`,
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const file = yield* target(existed)
          yield* runWrite(file, undefined, context(permission))
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("new\n")
          expect(yield* permission.list()).toHaveLength(0)
        }),
      {
        git: true,
        config: { ...(setting === undefined ? {} : { explain_before_edit: setting }), formatter: false, lsp: false },
      },
    )
  }

  it.instance(
    `${name}: configured deny still blocks the write`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const ctx = context(permission, [...allow, { permission: "edit", pattern: "*", action: "deny" }])
        expect(yield* failure(runWrite(file, explanation, ctx))).toBeInstanceOf(PermissionV1.DeniedError)
        yield* unchanged(file, existed)
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )
}

it.instance(
  "cancelling a pending write leaves the file unchanged",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const file = yield* target(true)
      const fiber = yield* runWrite(file, explanation, context(permission)).pipe(Effect.forkScoped)
      yield* waitForPending
      yield* Fiber.interrupt(fiber)
      yield* unchanged(file, true)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  enabled,
)

test("write JSON schema exposes an optional string explanation", () => {
  const schema = ToolJsonSchema.fromSchema(WriteParameters)
  expect(schema.properties).toHaveProperty("explanation")
  expect(schema.required ?? []).not.toContain("explanation")
})

test("write decoder rejects a non-string explanation", () => {
  expect(() => Schema.decodeUnknownSync(WriteParameters)({ filePath: "x", content: "b", explanation: null })).toThrow()
  expect(() => Schema.decodeUnknownSync(WriteParameters)({ filePath: "x", content: "b", explanation: 5 })).toThrow()
})

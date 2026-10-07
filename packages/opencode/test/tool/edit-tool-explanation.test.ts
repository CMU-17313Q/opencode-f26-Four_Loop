import { expect, test } from "bun:test"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
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
import { EditTool, Parameters } from "../../src/tool/edit"
import { MAX_EDIT_EXPLANATION_LENGTH } from "../../src/tool/edit-explanation"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Keep the tool, filesystem, configuration, and permission service real.
// Only external account, authentication, and package/network access use fixtures.
const it = testEffect(
  AppNodeBuilder.build(
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
  ),
)
const enabled = { git: true, config: { explain_before_edit: true, formatter: false, lsp: false } } as const
const sessionID = SessionID.make("ses_edit_tool_explanation")
const explanation = "Set the greeting in target.txt to new so it matches the requested greeting."
const allow: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]

function context(permission: Permission.Interface, ruleset = allow): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_edit_tool_explanation"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => permission.ask({ ...input, sessionID, ruleset }).pipe(Effect.orDie),
  }
}

const run = Effect.fn("EditExplanationTest.run")(function* (
  filePath: string,
  existed: boolean,
  explanation: string | undefined,
  ctx: Tool.Context,
) {
  const info = yield* EditTool
  const tool = yield* info.init()
  return yield* tool.execute(
    {
      filePath,
      oldString: existed ? "old\n" : "",
      newString: "new\n",
      ...(explanation === undefined ? {} : { explanation }),
    },
    ctx,
  )
})

const waitForPending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* pollWithTimeout(
    permission.list().pipe(Effect.map((pending) => pending[0])),
    "No edit permission request appeared",
  )
})

function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("Expected the edit operation to fail")
  })
}

const target = (existed: boolean) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, existed ? "target.txt" : "nested/target.txt")
    if (existed) yield* Effect.promise(() => Bun.write(file, "old\n"))
    return file
  })

const unchanged = (file: string, existed: boolean) =>
  Effect.gen(function* () {
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(existed)
    if (existed) expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("old\n")
  })

for (const existed of [true, false]) {
  const name = `edit ${existed ? "existing" : "new"} file`

  it.instance(
    `${name}: explanation and diff arrive before modification; approval applies the change`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const fiber = yield* run(file, existed, `  ${explanation}  `, context(permission)).pipe(Effect.forkScoped)
        const request = yield* waitForPending
        expect(request.permission).toBe("edit")
        expect(request.metadata.explainBeforeEdit).toBe(true)
        expect(request.metadata.explanation).toBe(explanation)
        expect(request.metadata.filepath).toBe(file)
        expect(request.metadata.diff).toContain("+new")
        if (existed) expect(request.metadata.diff).toContain("-old")
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
        const fiber = yield* run(file, existed, explanation, context(permission)).pipe(Effect.forkScoped)
        const request = yield* waitForPending
        yield* permission.reply({ requestID: request.id, reply: "reject" })
        expect(yield* failure(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
        yield* unchanged(file, existed)
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )

  for (const invalid of [undefined, " \n ", "x".repeat(MAX_EDIT_EXPLANATION_LENGTH + 1)]) {
    it.instance(
      `${name}: invalid explanation (${invalid === undefined ? "missing" : invalid.length}) blocks modification`,
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const file = yield* target(existed)
          expect(yield* failure(run(file, existed, invalid, context(permission)))).toBeInstanceOf(
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
      `${name}: disabled/omitted setting (${String(setting)}) preserves legacy arguments`,
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const file = yield* target(existed)
          yield* run(file, existed, undefined, context(permission))
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
    `${name}: configured deny remains enforced`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const ctx = context(permission, [...allow, { permission: "edit", pattern: "*", action: "deny" }])
        expect(yield* failure(run(file, existed, explanation, ctx))).toBeInstanceOf(PermissionV1.DeniedError)
        yield* unchanged(file, existed)
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )

  it.instance(
    `${name}: cancellation leaves the target unchanged`,
    () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const file = yield* target(existed)
        const fiber = yield* run(file, existed, explanation, context(permission)).pipe(Effect.forkScoped)
        yield* waitForPending
        yield* Fiber.interrupt(fiber)
        yield* unchanged(file, existed)
        expect(yield* permission.list()).toHaveLength(0)
      }),
    enabled,
  )
}

test("edit JSON schema exposes an optional string explanation", () => {
  const schema = ToolJsonSchema.fromSchema(Parameters)
  expect(schema.properties?.explanation).toMatchObject({ type: "string" })
  expect(schema.required ?? []).not.toContain("explanation")
})

test("edit decoder rejects a non-string explanation", () => {
  expect(() =>
    Schema.decodeUnknownSync(Parameters)({ filePath: "x", oldString: "a", newString: "b", explanation: 5 }),
  ).toThrow()
})

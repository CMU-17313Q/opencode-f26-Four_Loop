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
import { ApplyPatchTool, Parameters } from "../../src/tool/apply_patch"
import { MAX_EDIT_EXPLANATION_LENGTH } from "../../src/tool/edit-explanation"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"

// Exercise the real patch tool, filesystem, config, and approval service together.
// Only external account/auth/network/package installation is replaced by existing fakes.
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node, Config.node, EventV2Bridge.node, CrossSpawnSpawner.node,
    InstanceStore.node, FSUtil.node, LSP.node, Format.node, Truncate.node, Agent.node,
  ]),
  [
    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.die(`Unexpected HTTP request: ${request.url}`)))],
  ],
)
type TestRequirements = Permission.Service | Config.Service | InstanceStore.Service |
  LSP.Service | FSUtil.Service | Format.Service | EventV2Bridge.Service |
  Truncate.Service | Agent.Service | TestInstance | Scope.Scope

// Reject the Bun test promise on an Effect failure/defect. Do not return a failed
// Exit as an ordinary resolved value, which would hide an assertion failure.
const it = {
  instance(name: string, body: () => Effect.Effect<unknown, unknown, TestRequirements>, options: {
    git?: boolean
    config?: Partial<ConfigV1.Info>
  }) {
    return test(name, () => Effect.runPromise(
      body().pipe(withTmpdirInstance(options), Effect.scoped, Effect.provide(env)),
    ))
  },
}
const enabled = { git: true, config: { explain_before_edit: true, formatter: false, lsp: false } } as const
const sessionID = SessionID.make("ses_patch_explanations")
const allow: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
const explanation = "Create nested/new.txt for the new greeting, update modify.txt, remove the obsolete delete.txt, and move original.txt to moved.txt while updating its greeting."
const patchText = [
  "*** Begin Patch",
  "*** Add File: nested/new.txt", "+created",
  "*** Update File: modify.txt", "@@", "-old", "+new",
  "*** Delete File: delete.txt",
  "*** Update File: original.txt", "*** Move to: moved.txt", "@@", "-original", "+moved",
  "*** End Patch",
].join("\n")

function context(permission: Permission.Interface, ruleset = allow): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_patch_explanations"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => permission.ask({ ...input, sessionID, ruleset }).pipe(Effect.orDie),
  }
}
const run = Effect.fn("ExplainPatchTest.run")(function* (
  args: Tool.InferParameters<typeof ApplyPatchTool>, ctx: Tool.Context,
) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const setup = Effect.gen(function* () {
  const instance = yield* TestInstance
  const file = (name: string) => path.join(instance.directory, name)
  yield* Effect.promise(() => fs.writeFile(file("modify.txt"), "old\n"))
  yield* Effect.promise(() => fs.writeFile(file("delete.txt"), "obsolete\n"))
  yield* Effect.promise(() => fs.writeFile(file("original.txt"), "original\n"))
  return file
})
const unchanged = (file: (name: string) => string) => Effect.gen(function* () {
  expect(yield* Effect.promise(() => Bun.file(file("modify.txt")).text())).toBe("old\n")
  expect(yield* Effect.promise(() => Bun.file(file("delete.txt")).text())).toBe("obsolete\n")
  expect(yield* Effect.promise(() => Bun.file(file("original.txt")).text())).toBe("original\n")
  expect(yield* Effect.promise(() => Bun.file(file("nested/new.txt")).exists())).toBe(false)
  expect(yield* Effect.promise(() => Bun.file(file("moved.txt")).exists())).toBe(false)
})
const changed = (file: (name: string) => string) => Effect.gen(function* () {
  expect(yield* Effect.promise(() => Bun.file(file("modify.txt")).text())).toBe("new\n")
  expect(yield* Effect.promise(() => Bun.file(file("delete.txt")).exists())).toBe(false)
  expect(yield* Effect.promise(() => Bun.file(file("original.txt")).exists())).toBe(false)
  expect(yield* Effect.promise(() => Bun.file(file("nested/new.txt")).text())).toBe("created\n")
  expect(yield* Effect.promise(() => Bun.file(file("moved.txt")).text())).toBe("moved\n")
})
const waitForPending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* Effect.gen(function* () {
    while (true) {
      const pending = yield* permission.list()
      if (pending.length > 0) return pending[0]
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () => Effect.fail(new Error("No patch permission request appeared; inspect the tool failure")),
  }))
})
function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("Expected the patch operation to fail")
  })
}

it.instance("one explanation and one approval cover a multi-file add/update/delete/move proposal", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const file = yield* setup
    const fiber = yield* run({ patchText, explanation: `  ${explanation}  ` }, context(permission)).pipe(Effect.forkScoped)
    const request = yield* waitForPending
    expect(yield* permission.list()).toHaveLength(1)
    expect(request.metadata.explainBeforeEdit).toBe(true)
    expect(request.metadata.explanation).toBe(explanation)
    expect(request.metadata.files).toHaveLength(4)
    expect(request.metadata.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "add", relativePath: "nested/new.txt" }),
      expect.objectContaining({ type: "update", relativePath: "modify.txt" }),
      expect.objectContaining({ type: "delete", relativePath: "delete.txt" }),
      expect.objectContaining({ type: "move", filePath: file("original.txt"), movePath: file("moved.txt") }),
    ]))
    expect(request.metadata.diff).toContain("+created")
    expect(request.metadata.diff).toContain("-obsolete")
    expect(request.always).toEqual([])
    yield* unchanged(file)
    yield* permission.reply({ requestID: request.id, reply: "once" })
    const result = yield* Fiber.join(fiber)
    expect(result.output).toContain("Success. Updated the following files")
    yield* changed(file)
    expect(yield* permission.list()).toHaveLength(0)
  }), enabled)

it.instance("rejecting the complete patch leaves every affected file unchanged", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const file = yield* setup
    const fiber = yield* run({ patchText, explanation }, context(permission)).pipe(Effect.forkScoped)
    const request = yield* waitForPending
    yield* permission.reply({ requestID: request.id, reply: "reject" })
    expect(yield* failure(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
    yield* unchanged(file)
    expect(yield* permission.list()).toHaveLength(0)
  }), enabled)

for (const invalid of [undefined, " \n ", "x".repeat(MAX_EDIT_EXPLANATION_LENGTH + 1)]) {
  it.instance(`invalid patch explanation (${invalid === undefined ? "missing" : invalid.length}) causes no changes`, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const file = yield* setup
      const args = { patchText, ...(invalid === undefined ? {} : { explanation: invalid }) }
      expect(yield* failure(run(args, context(permission)))).toBeInstanceOf(PermissionV1.InvalidExplanationError)
      yield* unchanged(file)
      expect(yield* permission.list()).toHaveLength(0)
    }), enabled)
}

for (const setting of [false, undefined]) {
  it.instance(`disabled/omitted setting (${String(setting)}) preserves a patchText-only invocation`, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const file = yield* setup
      yield* run({ patchText }, context(permission))
      yield* changed(file)
      expect(yield* permission.list()).toHaveLength(0)
    }), { git: true, config: { ...(setting === undefined ? {} : { explain_before_edit: setting }), formatter: false, lsp: false } })
}

it.instance("a denied affected file prevents the whole proposal", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const file = yield* setup
    const ctx = context(permission, [...allow, { permission: "edit", pattern: "delete.txt", action: "deny" }])
    expect(yield* failure(run({ patchText, explanation }, ctx))).toBeInstanceOf(PermissionV1.DeniedError)
    yield* unchanged(file)
    expect(yield* permission.list()).toHaveLength(0)
  }), enabled)

it.instance("cancelling a pending multi-file patch causes no changes", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const file = yield* setup
    const fiber = yield* run({ patchText, explanation }, context(permission)).pipe(Effect.forkScoped)
    yield* waitForPending
    yield* Fiber.interrupt(fiber)
    yield* unchanged(file)
    expect(yield* permission.list()).toHaveLength(0)
  }), enabled)

for (const invalid of ["not a patch", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"]) {
  it.instance(`malformed/unapplicable patch causes no changes (${invalid.length})`, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const file = yield* setup
      yield* failure(run({ patchText: invalid, explanation }, context(permission)))
      yield* unchanged(file)
      expect(yield* permission.list()).toHaveLength(0)
    }), enabled)
}

test("the model-facing schema has separate patchText and optional explanation fields", () => {
  const schema = ToolJsonSchema.fromSchema(Parameters)
  expect(schema.properties).toHaveProperty("patchText")
  expect(schema.properties).toHaveProperty("explanation")
  expect(schema.required ?? []).toContain("patchText")
  expect(schema.required ?? []).not.toContain("explanation")
  expect(() => Schema.decodeUnknownSync(Parameters)({ patchText, explanation: 5 })).toThrow()
})
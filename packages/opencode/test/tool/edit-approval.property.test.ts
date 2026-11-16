import { expect } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import fc from "fast-check"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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
import { MessageID, SessionID } from "../../src/session/schema"
import { EditTool } from "../../src/tool/edit"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { getEditDiffs, getEditReview } from "../../../tui/src/routes/session/edit-review"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Edit, permission, config and filesystem are real. Only external account,
// authentication, package access and unexpected HTTP use existing fixtures.
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
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
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
const settings = { numRuns: 100, seed: 173134 }

// Safe relative paths explore languages, spaces and nesting without escaping the fixture.
// Distinct prefixed lines provide an independent exact-replacement oracle, including
// multiline replacement, LF/CRLF and the new-file branch (oldString = "").
const scenario = fc.record({
  name: fc
    .tuple(
      fc.constantFrom("src", "nested dir/lib", "tests"),
      fc.nat({ max: 9999 }),
      fc.constantFrom("ts", "py", "js", "rs", "txt"),
    )
    .map(([dir, id, ext]) => `${dir}/target ${id}.${ext}`),
  existed: fc.boolean(),
  ending: fc.constantFrom("\n", "\r\n"),
  before: fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 8 }),
  after: fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 8 }),
  explanation: fc.oneof(
    fc.constant("x"),
    fc.constant("é".repeat(4000)),
    fc.string({ minLength: 1, maxLength: 120 }).map((s) => `Update target: ${s}`),
  ),
})

function context(permission: Permission.Interface): Tool.Context {
  return {
    sessionID: SessionID.make("ses_yousefh_properties"),
    messageID: MessageID.make("msg_yousefh_properties"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      permission
        .ask({
          ...input,
          sessionID: SessionID.make("ses_yousefh_properties"),
          ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        .pipe(Effect.orDie),
  }
}

const pending = (permission: Permission.Interface) =>
  pollWithTimeout(permission.list().pipe(Effect.map((items) => items[0])), "Expected a pending protected edit")

function rejected<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("The rejected edit unexpectedly succeeded")
  })
}

// R1: Before requesting a review decision, display all affected filenames, a diff
// distinguishing additions/deletions, and an explanation of the edit.
// Kind: invariant. Exercises edit-tool -> permission -> TUI representation;
// multi-file identification is additionally checked in edit-review.property.test.ts.
// R2: A proposed edit must not modify the original unless explicitly approved;
// rejecting a proposal must leave the file unchanged.
// Kind: model/oracle (generated literal before/after bytes are the oracle).
it.instance(
  "R1/R2: generated real edits expose review data and preserve bytes until approval",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const instance = yield* TestInstance
      const info = yield* EditTool
      const tool = yield* info.init()
      const services = yield* Effect.context<never>()
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(scenario, async (input) => {
            await Effect.runPromiseWith(services)(
              Effect.scoped(
                Effect.gen(function* () {
                  const file = path.join(instance.directory, input.name)
                  const old = input.existed ? input.before.map((n) => `old:${n}${input.ending}`).join("") : ""
                  const next = input.after.map((n) => `new:${n}${input.ending}`).join("")
                  // Reset only the generated fixture file, including during shrinking.
                  yield* Effect.promise(() => rm(file, { force: true }))
                  if (input.existed) yield* Effect.promise(() => Bun.write(file, old))
                  const unchanged = Effect.promise(async () => {
                    expect(await Bun.file(file).exists()).toBe(input.existed)
                    if (input.existed) expect(await Bun.file(file).text()).toBe(old)
                  })
                  const edit = () =>
                    tool.execute(
                      { filePath: file, oldString: old, newString: next, explanation: ` \n${input.explanation}\t ` },
                      context(permission),
                    )
                  const first = yield* edit().pipe(Effect.forkScoped)
                  const request = yield* pending(permission)
                  expect(getEditReview(request)).toMatchObject({
                    enabled: true,
                    files: [file],
                    explanation: input.explanation.trim(),
                    problem: undefined,
                  })
                  const diffs = getEditDiffs(request)
                  expect(diffs).toHaveLength(1)
                  expect(diffs[0].path).toBe(file)
                  input.after.forEach((n) => expect(diffs[0].diff).toContain(`+new:${n}`))
                  if (input.existed) input.before.forEach((n) => expect(diffs[0].diff).toContain(`-old:${n}`))
                  expect(request.always).toEqual([])
                  yield* unchanged
                  yield* permission.reply({ requestID: request.id, reply: "reject" })
                  expect(yield* rejected(Fiber.join(first))).toBeInstanceOf(PermissionV1.RejectedError)
                  yield* unchanged
                  const second = yield* edit().pipe(Effect.forkScoped)
                  const approval = yield* pending(permission)
                  yield* unchanged
                  yield* permission.reply({ requestID: approval.id, reply: "once" })
                  yield* Fiber.join(second)
                  expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(next)
                  expect(yield* permission.list()).toHaveLength(0)
                }),
              ),
            )
          }),
          settings,
        ),
      )
      console.info("P4B edit-approval.property.test.ts: R1/R2 passed (100 cases; seed 173134)")
    }),
  enabled,
  30000,
)

// R7: After rejection with feedback, any revised proposal requires a new review
// decision rather than being applied automatically. Kind: invariant.
// Feedback includes whitespace, multiline and non-ASCII; blank input is plain Reject.
it.instance(
  "R7: feedback never authorizes a generated revised edit",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const instance = yield* TestInstance
      const info = yield* EditTool
      const tool = yield* info.init()
      const services = yield* Effect.context<never>()
      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(
            scenario,
            fc.oneof(fc.constantFrom("", " \n\t", "Keep café\nغيّر الاسم"), fc.string({ maxLength: 160 })),
            async (input, feedback) => {
              await Effect.runPromiseWith(services)(
                Effect.scoped(
                  Effect.gen(function* () {
                    const file = path.join(instance.directory, input.name)
                    const old = input.before.map((n) => `old:${n}\n`).join("")
                    yield* Effect.promise(() => Bun.write(file, old))
                    const edit = (newString: string) =>
                      tool.execute(
                        { filePath: file, oldString: old, newString, explanation: input.explanation },
                        context(permission),
                      )
                    const first = yield* edit("proposal A\n").pipe(Effect.forkScoped)
                    const a = yield* pending(permission)
                    yield* permission.reply({ requestID: a.id, reply: "reject", message: feedback.trim() || undefined })
                    const error = yield* rejected(Fiber.join(first))
                    expect(error).toBeInstanceOf(
                      feedback.trim() ? PermissionV1.CorrectedError : PermissionV1.RejectedError,
                    )
                    if (feedback.trim()) expect(error).toMatchObject({ feedback: feedback.trim() })
                    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(old)
                    const next = input.after.map((n) => `revised:${n}\n`).join("")
                    const second = yield* edit(next).pipe(Effect.forkScoped)
                    const b = yield* pending(permission)
                    expect(b.id).not.toBe(a.id)
                    expect(b.always).toEqual([])
                    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(old)
                    // A stale approval must not release B.
                    expect(yield* rejected(permission.reply({ requestID: a.id, reply: "once" }))).toBeInstanceOf(
                      PermissionV1.NotFoundError,
                    )
                    expect((yield* permission.list()).map((item) => item.id)).toEqual([b.id])
                    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(old)
                    yield* permission.reply({ requestID: b.id, reply: "once" })
                    yield* Fiber.join(second)
                    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(next)
                    expect(yield* permission.list()).toHaveLength(0)
                  }),
                ),
              )
            },
          ),
          settings,
        ),
      )
      console.info("P4B edit-approval.property.test.ts: R7 passed (100 cases; seed 173134)")
    }),
  enabled,
  30000,
)

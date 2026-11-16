// P4B property tests for explain before edit on the write tool (haq)
// requirements come from traceability/haq.md
import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import fc from "fast-check"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
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
import { WriteTool } from "../../src/tool/write"
import { MAX_EDIT_EXPLANATION_LENGTH, validateEditExplanation } from "../../src/tool/edit-explanation"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"

// same setup as write-tool-explanation.test.ts: real write tool, filesystem, config and
// permission service, only account/auth/network/npm are faked
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

type Requirements =
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

const on = { git: true, config: { explain_before_edit: true, formatter: false, lsp: false } } as const
const off = { git: true, config: { explain_before_edit: false, formatter: false, lsp: false } } as const

// each property spins up one instance and then does every generated run inside it,
// so the runs are kept small to keep CI fast
const RUNS = 50

function propertyTest(
  name: string,
  body: () => Effect.Effect<unknown, unknown, Requirements>,
  options: { git?: boolean; config?: Partial<ConfigV1.Info> },
) {
  return test(
    name,
    () => Effect.runPromise(body().pipe(withTmpdirInstance(options), Effect.scoped, Effect.provide(env))),
    60_000,
  )
}

const sessionID = SessionID.make("ses_write_property")
const allow: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]

function context(permission: Permission.Interface, ruleset = allow): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_write_property"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => permission.ask({ ...input, sessionID, ruleset }).pipe(Effect.orDie),
  }
}

const write = (filePath: string, content: string, explanation: string | undefined, ctx: Tool.Context) =>
  Effect.gen(function* () {
    const info = yield* WriteTool
    const tool = yield* info.init()
    return yield* tool.execute({ filePath, content, ...(explanation === undefined ? {} : { explanation }) }, ctx)
  })

const waitForPending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* Effect.gen(function* () {
    while (true) {
      const pending = yield* permission.list()
      if (pending.length > 0) return pending[0]
      yield* Effect.sleep("5 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("no approval prompt showed up")),
    }),
  )
})

// returns the error the write failed with (throws if it didnt fail)
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the write to fail")
  })

// read the raw bytes so a BOM or \r\n difference cant hide
const snapshot = (file: string) =>
  Effect.promise(async () => {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      return null
    }
  })

// every run gets its own file so runs dont affect each other
let counter = 0
const setup = (old: string | null) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, `run${counter++}`, "target.txt")
    if (old !== null) {
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(file, old, "utf8"))
    }
    return file
  })

// runs a fast-check async property inside the effect test
const check = <T>(arb: fc.Arbitrary<T>, run: (value: T) => Effect.Effect<void, unknown, Requirements>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Requirements>()
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(arb, (value) => Effect.runPromise(run(value).pipe(Effect.provide(services)))),
        { numRuns: RUNS },
      ),
    )
  })

// ---------- generators ----------

// file contents: mixes normal text with the stuff that usually breaks file writing,
// empty files, \r\n line endings, tabs, a BOM at the start, and non ascii (emoji, arabic)
const piece = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  { weight: 2, arbitrary: fc.constantFrom("\n", "\r\n", "\t", " ", "", "مرحبا", "👋🏽") },
)
const body = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(""))
const content = fc.tuple(fc.boolean(), body).map(([bom, text]) => (bom ? "\uFEFF" + text : text))

// old file: null means the file doesnt exist yet (the "new file" case from C-6)
const oldContent = fc.option(content, { nil: null, freq: 3 })

// a real explanation: something non blank, with random padding around it since the tool trims
const whitespace = fc.string({ unit: fc.constantFrom(" ", "\n", "\t", "\r"), maxLength: 5 })
const goodExplanation = fc
  .tuple(whitespace, fc.string({ unit: "grapheme", minLength: 1, maxLength: 80 }), whitespace)
  .filter(([, middle]) => middle.trim().length > 0)
  .map(([a, middle, b]) => a + middle + b)

// bad explanations: missing, only whitespace, or longer than the 4000 cap after trimming
const badExplanation = fc.oneof(
  fc.constant(undefined),
  whitespace,
  fc.integer({ min: MAX_EDIT_EXPLANATION_LENGTH + 1, max: MAX_EDIT_EXPLANATION_LENGTH + 50 }).map((n) => "x".repeat(n)),
)

// oracle for what the file should contain after an approved write: the tool keeps a BOM
// if either the old file or the new content had one, and never doubles it
const expectedAfterWrite = (old: string | null, next: string) => {
  const bom = (old ?? "").startsWith("\uFEFF") || next.startsWith("\uFEFF")
  const text = next.startsWith("\uFEFF") ? next.slice(1) : next
  return bom ? "\uFEFF" + text : text
}

// ---------- properties ----------

// R3 (revised): a write with a missing, blank, or over 4000 character explanation is blocked.
// Kind: model/oracle. validateEditExplanation should agree with a dumb version of the rule.
// Generator: mostly whitespace junk, lengths right around the 4000 boundary, and non strings,
// since thats where off by one or trim bugs would show up.
test("R3 property: explanation validation matches the simple rule", () => {
  const nearLimit = fc
    .tuple(
      whitespace,
      fc.integer({ min: MAX_EDIT_EXPLANATION_LENGTH - 3, max: MAX_EDIT_EXPLANATION_LENGTH + 3 }),
      whitespace,
    )
    .map(([a, n, b]) => a + "y".repeat(n) + b)
  const anyValue = fc.oneof(
    whitespace,
    goodExplanation,
    nearLimit,
    fc.string(),
    fc.constantFrom(undefined, null, 0, 42, true, {}, []),
  )
  fc.assert(
    fc.property(anyValue, (value) => {
      const oracleValid =
        typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_EDIT_EXPLANATION_LENGTH
      const result = validateEditExplanation(value)
      expect(result.valid).toBe(oracleValid)
      if (result.valid) expect(result.explanation).toBe((value as string).trim())
    }),
    { numRuns: 1000 },
  )
})

// R3 (revised): a write with a missing, blank, or over 4000 character explanation is blocked.
// Kind: invariant. For any file and any bad explanation: error, no approval prompt, file untouched.
propertyTest(
  "R3 property: bad explanations never reach the prompt or the file",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* check(
        fc.record({ old: oldContent, next: content, explanation: badExplanation }),
        ({ old, next, explanation }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const error = yield* failure(write(file, next, explanation, context(permission)))
            expect(error).toBeInstanceOf(PermissionV1.InvalidExplanationError)
            expect(yield* permission.list()).toHaveLength(0)
            expect(yield* snapshot(file)).toBe(old)
          }),
      )
    }),
  on,
)

// R2: rejecting or cancelling a write leaves the file exactly how it was, and a rejected new file is never created.
// R6 (revised): when I reject a write, the write tool returns a rejected error instead of a success.
// Kind: round-trip. propose a write then reject it, the file should come back to exactly where it started
// (same bytes, or still missing). Generator: random old/new contents incl. empty, BOM, \r\n and
// missing files, since C-6 and S-4 cared about "not even an empty file" and "not even a space".
propertyTest(
  "R2/R6 property: reject round-trips the file back to how it was",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* check(
        fc.record({ old: oldContent, next: content, explanation: goodExplanation }),
        ({ old, next, explanation }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const before = yield* snapshot(file)
            const fiber = yield* write(file, next, explanation, context(permission)).pipe(Effect.forkScoped)
            const request = yield* waitForPending
            yield* permission.reply({ requestID: request.id, reply: "reject" })
            expect(yield* failure(Fiber.join(fiber))).toBeInstanceOf(PermissionV1.RejectedError)
            expect(yield* snapshot(file)).toBe(before)
            expect(yield* permission.list()).toHaveLength(0)
          }),
      )
    }),
  on,
)

// R2: same requirement, the cancel half (O-5: cancel halfway and nothing is half written).
// Kind: round-trip. propose a write then cancel it while the prompt is open, file comes back unchanged.
propertyTest(
  "R2 property: cancelling while the prompt is open round-trips the file",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* check(
        fc.record({ old: oldContent, next: content, explanation: goodExplanation }),
        ({ old, next, explanation }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const before = yield* snapshot(file)
            const fiber = yield* write(file, next, explanation, context(permission)).pipe(Effect.forkScoped)
            yield* waitForPending
            yield* Fiber.interrupt(fiber)
            expect(yield* snapshot(file)).toBe(before)
            expect(yield* permission.list()).toHaveLength(0)
          }),
      )
    }),
  on,
)

// R1: when explain before edit is on, the write tool doesnt change the file until I approve it.
// R4: the approval prompt shows the explanation together with the diff and the file path.
// Kind: invariant. for any write, while the prompt is open the file is untouched and the prompt has
// the path, the trimmed explanation, and a diff. after approving, the file matches the BOM aware oracle.
propertyTest(
  "R1/R4 property: nothing changes before approval and the prompt has path, explanation and diff",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* check(
        fc.record({ old: oldContent, next: content, explanation: goodExplanation }),
        ({ old, next, explanation }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const before = yield* snapshot(file)
            const fiber = yield* write(file, next, explanation, context(permission)).pipe(Effect.forkScoped)
            const request = yield* waitForPending
            expect(yield* snapshot(file)).toBe(before)
            expect(request.permission).toBe("edit")
            expect(request.metadata.filepath).toBe(file)
            expect(request.metadata.explanation).toBe(explanation.trim())
            expect(typeof request.metadata.diff).toBe("string")
            expect(request.metadata.diff as string).toContain(file)
            yield* permission.reply({ requestID: request.id, reply: "once" })
            yield* Fiber.join(fiber)
            expect(yield* snapshot(file)).toBe(expectedAfterWrite(old, next))
          }),
      )
    }),
  on,
)

// R4: the approval prompt shows the explanation together with the diff and the file path.
// Kind: metamorphic. if the same change is proposed twice with different explanation wording (C-7, S-5),
// the path and diff should be identical and only the explanation should differ.
propertyTest(
  "R4 property: rewording the explanation doesnt change the diff or path",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const propose = (file: string, next: string, explanation: string) =>
        Effect.gen(function* () {
          const fiber = yield* write(file, next, explanation, context(permission)).pipe(Effect.forkScoped)
          const request = yield* waitForPending
          yield* permission.reply({ requestID: request.id, reply: "reject" })
          yield* failure(Fiber.join(fiber))
          return request.metadata
        })
      yield* check(
        fc.record({ old: oldContent, next: content, first: goodExplanation, second: goodExplanation }),
        ({ old, next, first, second }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const a = yield* propose(file, next, first)
            const b = yield* propose(file, next, second)
            expect(b.filepath).toBe(a.filepath)
            expect(b.diff).toBe(a.diff)
            expect(a.explanation).toBe(first.trim())
            expect(b.explanation).toBe(second.trim())
          }),
      )
    }),
  on,
)

// R5: when the feature is off, the write tool works like normal without an explanation.
// Kind: model/oracle. with the setting off and no explanation, the file ends up exactly like the
// simple model says (new content, BOM kept if either side had one) and no prompt is created.
propertyTest(
  "R5 property: with the feature off writes behave like the plain model",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* check(fc.record({ old: oldContent, next: content }), ({ old, next }) =>
        Effect.gen(function* () {
          const file = yield* setup(old)
          yield* write(file, next, undefined, context(permission))
          expect(yield* snapshot(file)).toBe(expectedAfterWrite(old, next))
          expect(yield* permission.list()).toHaveLength(0)
        }),
      )
    }),
  off,
)

// R7: my permission rules still win when explain before edit is on. if edit is denied, the write is denied without asking me.
// Kind: invariant. for any file, content, and even a good explanation, a deny rule means DeniedError,
// no prompt, and the file is untouched.
propertyTest(
  "R7 property: a deny rule always wins over explain before edit",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const deny: PermissionV1.Ruleset = [...allow, { permission: "edit", pattern: "*", action: "deny" }]
      yield* check(
        fc.record({ old: oldContent, next: content, explanation: goodExplanation }),
        ({ old, next, explanation }) =>
          Effect.gen(function* () {
            const file = yield* setup(old)
            const error = yield* failure(write(file, next, explanation, context(permission, deny)))
            expect(error).toBeInstanceOf(PermissionV1.DeniedError)
            expect(yield* permission.list()).toHaveLength(0)
            expect(yield* snapshot(file)).toBe(old)
          }),
      )
    }),
  on,
)

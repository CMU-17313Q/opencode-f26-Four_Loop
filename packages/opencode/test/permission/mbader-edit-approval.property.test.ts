import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import fc from "fast-check"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

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
    [InstanceStore.bootstrapNode, Layer.mock(InstanceBootstrap.Service, { run: Effect.void })],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
    ],
  ],
)
const it = testEffect(env)
const project = { git: true, config: { explain_before_edit: true, formatter: false, lsp: false } }

// Generate short LF-delimited files with whitespace and Unicode, nested or top-level
// targets, and nonidentical replacements. Each run covers both an existing and an absent path.
const line = fc.string({ unit: fc.constantFrom("a", "b", "0", " ", "'", "é", "界", "🙂"), maxLength: 12 })
const proposal = fc.record({
  root: fc.constantFrom("", "src/", "nested/sub/"),
  suffix: fc.nat(99),
  before: fc.array(line, { minLength: 1, maxLength: 4 }).map((lines) => lines.map((text) => `old:${text}`)),
  after: fc.array(line, { minLength: 1, maxLength: 4 }).map((lines) => lines.map((text) => `new:${text}`)),
  emptyOriginal: fc.boolean(),
})

const numRuns = 36
const tools = ["write", "edit", "apply_patch"] as const
type ToolName = (typeof tools)[number]
type Proposal = ReturnType<typeof proposal.generate>["value"]
type Target = { path: string; before?: string; after?: string }

for (const tool of tools) {
  // R1: While Explain Before Edit is enabled, a pending proposal shall not modify its
  // target files before explicit approval.
  // Kind: invariant.
  it.live(
    `P4B mbader R1 (${tool}): targets stay unchanged until explicit approval`,
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<Layer.Success<typeof env>>()
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(proposal, (input) => runCase(tool, input, "once").pipe(Effect.runPromiseWith(context))),
            { numRuns },
          ),
        )
        console.log(`P4B mbader R1: ${numRuns} ${tool} proposals passed the pending and approved checks`)
      }),
    60_000,
  )

  // R2: Rejecting a proposal shall not apply any of that proposal’s changes.
  // Kind: invariant.
  it.live(
    `P4B mbader R2 (${tool}): rejection preserves every target`,
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<Layer.Success<typeof env>>()
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(proposal, (input) => runCase(tool, input, "reject").pipe(Effect.runPromiseWith(context))),
            { numRuns },
          ),
        )
        console.log(`P4B mbader R2: ${numRuns} ${tool} proposals passed the rejection check`)
      }),
    60_000,
  )
}

function runCase(name: ToolName, input: Proposal, reply: "once" | "reject") {
  return Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const permission = yield* Permission.Service
    const sessionID = SessionID.make("ses_mbader_property")
    const existing = `${input.root}existing-${input.suffix}.txt`
    const created = `${input.root}new-${input.suffix}.txt`
    const removed = `${input.root}remove-${input.suffix}.txt`
    const source = `${input.root}source-${input.suffix}.txt`
    const destination = `${input.root}moved-${input.suffix}.txt`
    const oldText = input.before.join("\n") + "\n"
    const newText = input.after.join("\n") + "\n"
    const original = name === "write" && input.emptyOriginal ? "" : oldText
    // A patch groups an overwrite, creation, deletion, and move into one decision.
    const targets: Target[] = [
      { path: existing, before: original, after: newText },
      { path: created, after: newText },
      ...(name === "apply_patch"
        ? [
            { path: removed, before: oldText },
            { path: source, before: oldText },
            { path: destination, after: newText },
          ]
        : []),
    ]
    yield* Effect.promise(async () => {
      await fs.mkdir(path.dirname(path.join(directory, existing)), { recursive: true })
      for (const target of targets) {
        if (target.before !== undefined) await fs.writeFile(path.join(directory, target.path), target.before)
      }
    })

    const run = (
      paths: string[],
      touched: Target[],
      operation: Effect.Effect<unknown, unknown, Layer.Success<typeof env>>,
    ) =>
      Effect.gen(function* () {
        const fiber = yield* operation.pipe(Effect.forkScoped)
        const request = yield* pollWithTimeout(
          Effect.gen(function* () {
            const result = fiber.pollUnsafe()
            if (result) {
              if (Exit.isFailure(result)) throw Cause.squash(result.cause)
              throw new Error("Tool completed before showing an approval request")
            }
            return (yield* permission.list())[0]
          }),
          "Tool did not issue a pending approval request",
        )
        expect(request.sessionID).toBe(sessionID)
        expect(request.permission).toBe("edit")
        expect(request.patterns).toEqual(paths)
        expect(request.metadata.explainBeforeEdit).toBe(true)
        expect(yield* permission.list()).toHaveLength(1)
        yield* assertFiles(directory, touched, "before")
        yield* permission.reply({ requestID: request.id, reply })
        const result = yield* awaitWithTimeout(Fiber.await(fiber), "Decision did not resolve the tool operation")
        if (reply === "once") {
          // A valid proposal in this fixture can actually write after the explicit decision.
          if (Exit.isFailure(result)) throw Cause.squash(result.cause)
          yield* assertFiles(directory, touched, "after")
        } else {
          if (Exit.isSuccess(result)) throw new Error("Tool succeeded after rejection")
          expect(Cause.squash(result.cause)).toBeInstanceOf(PermissionV1.RejectedError)
          yield* assertFiles(directory, touched, "before")
        }
        expect(yield* permission.list()).toHaveLength(0)
      }).pipe(Effect.scoped)

    const context: Tool.Context = {
      sessionID,
      messageID: MessageID.make("msg_mbader_property"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        permission
          .ask({ ...request, sessionID, ruleset: [{ permission: "*", pattern: "*", action: "allow" }] })
          .pipe(Effect.orDie),
    }
    if (name === "apply_patch") {
      const info = yield* ApplyPatchTool
      const tool = yield* info.init()
      const replacement = [...input.before.map((line) => `-${line}`), ...input.after.map((line) => `+${line}`)]
      const patchText = [
        "*** Begin Patch",
        `*** Update File: ${existing}`,
        "@@",
        ...replacement,
        `*** Add File: ${created}`,
        ...input.after.map((line) => `+${line}`),
        `*** Delete File: ${removed}`,
        `*** Update File: ${source}`,
        `*** Move to: ${destination}`,
        "@@",
        ...replacement,
        "*** End Patch",
      ].join("\n")
      const explanation = `Update ${existing}, add ${created}, remove ${removed}, and move ${source} to ${destination}.`
      yield* run([existing, created, removed, source], targets, tool.execute({ patchText, explanation }, context))
      return
    }
    const writeInfo = yield* WriteTool
    const editInfo = yield* EditTool
    const write = yield* writeInfo.init()
    const edit = yield* editInfo.init()
    for (const target of targets) {
      const filePath = path.join(directory, target.path)
      const explanation = `Write the new greeting to ${target.path} for the student's example.`
      const operation =
        name === "write"
          ? write.execute({ filePath, content: newText, explanation }, context)
          : edit.execute({ filePath, oldString: target.before ?? "", newString: newText, explanation }, context)
      yield* run([target.path], [target], operation)
    }
  }).pipe(withTmpdirInstance(project), Effect.scoped)
}

function assertFiles(directory: string, targets: Target[], state: "before" | "after") {
  return Effect.promise(async () => {
    for (const target of targets) {
      const filename = path.join(directory, target.path)
      const contents = target[state]
      if (contents === undefined) {
        await expect(fs.lstat(filename)).rejects.toMatchObject({ code: "ENOENT" })
        continue
      }
      expect(await fs.readFile(filename)).toEqual(Buffer.from(contents))
    }
  })
}

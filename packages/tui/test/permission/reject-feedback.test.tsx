/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

const proposal: PermissionRequest = {
  id: "per_feedback",
  sessionID: "ses_feedback",
  permission: "edit",
  patterns: ["greeting.txt"],
  always: [],
  metadata: {
    explainBeforeEdit: true,
    explanation: "Change the greeting as requested.",
    filepath: "greeting.txt",
    diff: "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-Hi\n+Hello\n",
  },
}

async function wait(fn: () => boolean | Promise<boolean>) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for permission UI")
    await Bun.sleep(10)
  }
}

async function mount(root: string, width = 100) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const replies: unknown[] = []
  const calls = createFetch()
  const [request, setRequest] = createSignal(proposal)
  const [
    { ArgsProvider },
    { SDKProvider },
    { ProjectProvider },
    { SyncProvider },
    { PermissionProvider },
    { ExitProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { LocationProvider },
    { PermissionPrompt },
  ] = await Promise.all([
    import("../../src/context/args"),
    import("../../src/context/sdk"),
    import("../../src/context/project"),
    import("../../src/context/sync"),
    import("../../src/context/permission"),
    import("../../src/context/exit"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/keymap"),
    import("../../src/context/location"),
    import("../../src/routes/session/permission"),
  ])
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider
                    url="http://test"
                    directory={directory}
                    events={eventSource()}
                    fetch={Object.assign(
                      async (input: RequestInfo | URL, init?: RequestInit) => {
                        const request = input instanceof Request ? input : new Request(input, init)
                        if (new URL(request.url).pathname.endsWith("/reply")) {
                          replies.push(await request.json())
                          return json(true)
                        }
                        return calls.fetch(input, init)
                      },
                      { preconnect: () => {} },
                    )}
                  >
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <LocationProvider location={{ directory }}>
                              <PermissionPrompt request={request()} directory={directory} />
                            </LocationProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </ThemeProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width, height: 30, kittyKeyboard: true })
  await wait(async () => {
    await app.renderOnce()
    return app.captureCharFrame().includes("Permission required")
  })
  return { app, replies, setRequest }
}

async function feedback(ui: Awaited<ReturnType<typeof mount>>) {
  ui.app.mockInput.pressArrow("right")
  ui.app.mockInput.pressArrow("right")
  ui.app.mockInput.pressEnter()
  await wait(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const input = ui.app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("expected feedback textarea")
  return input
}

test("ordinary edit feedback is sent as a rejection through the actual SDK", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    const input = await feedback(ui)
    input.setText("  Keep the existing function name.  ")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies).toEqual([{ reply: "reject", message: "Keep the existing function name." }])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("plain Reject and Escape still reject without feedback", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    ui.app.mockInput.pressArrow("right")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies[0]).toEqual({ reply: "reject" })
    ui.app.mockInput.pressEscape()
    await wait(() => ui.replies.length === 2)
    expect(ui.replies[1]).toEqual({ reply: "reject" })
  } finally {
    ui.app.renderer.destroy()
  }
})

test("canceling feedback keeps the proposal pending and a new request clears the draft", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, 60)
  try {
    const input = await feedback(ui)
    input.setText("OLD-DRAFT")
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("OLD-DRAFT")
    ui.app.mockInput.pressEscape()
    await ui.app.renderOnce()
    expect(ui.replies).toEqual([])
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    const next = await feedback(ui)
    next.setText("STALE-DRAFT")
    ui.setRequest({ ...proposal, id: "per_next" })
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).not.toContain("STALE-DRAFT")
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    expect(ui.replies).toEqual([])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("blank feedback is a plain rejection", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    const input = await feedback(ui)
    input.setText("   ")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies).toEqual([{ reply: "reject" }])
  } finally {
    ui.app.renderer.destroy()
  }
})

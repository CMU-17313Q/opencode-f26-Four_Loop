import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "./mock-server"
import { installSseTransport } from "./sse-transport"
import { expectSessionTitle } from "./waits"

export const directory = "/root/projects/Hello-World"
export const sessionID = "ses_web_edit_review"
export const title = "Website edit review"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
export const diff = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-Hi\n+Hello\n"
export const explanation = "Use a clearer greeting while preserving the existing file."

export async function setupEditReview(
  page: Page,
  options: { failRead?: boolean; failSave?: boolean; draft?: boolean; home?: boolean } = {},
) {
  const state = {
    enabled: false,
    failRead: false,
    updates: [] as { directory: string | null; body: unknown }[],
    replies: [] as { path: string; body: unknown }[],
  }
  const transport = await installSseTransport(page, { server })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_web_edit_review",
      worktree: directory,
      vcs: "git",
      name: "Hello-World",
      time: { created: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        projectID: "proj_web_edit_review",
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === "/pty/shells") return route.fulfill({ json: [] })
    if (url.pathname === "/config") {
      if (request.method() === "PATCH") {
        state.updates.push({ directory: url.searchParams.get("directory"), body: request.postDataJSON() })
        if (options.failSave) return route.fulfill({ status: 500, json: { message: "Cannot save" } })
        state.enabled = request.postDataJSON().explain_before_edit === true
      } else if (state.failRead) return route.fulfill({ status: 500, json: { message: "Cannot read" } })
      return route.fulfill({ json: { explain_before_edit: state.enabled } })
    }
    if (request.method() === "POST" && /\/permission(s)?\//.test(url.pathname)) {
      state.replies.push({ path: url.pathname, body: request.postDataJSON() })
      return route.fulfill({ json: true })
    }
    return route.fallback()
  })
  await page.addInitScript(
    ({ draft, server, directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [server],
          projects: {
            local: [{ worktree: directory, expanded: true }],
            [server]: [{ worktree: directory, expanded: true }],
          },
        }),
      )
      if (draft)
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([{ type: "draft", draftID: "draft_review", server, directory }]),
        )
    },
    { draft: options.draft === true, server, directory },
  )
  await page.goto(
    options.home
      ? "/"
      : options.draft
        ? "/new-session?draftId=draft_review"
        : `/${base64Encode(directory)}/session/${sessionID}`,
  )
  if (options.draft) await expect(page.locator('[data-action="prompt-project"]')).toContainText("Hello-World")
  else if (!options.home) await expectSessionTitle(page, title)
  await transport.waitForConnection()
  state.failRead = options.failRead === true
  return {
    state,
    async ask(
      metadata: Record<string, unknown> = {
        explainBeforeEdit: true,
        explanation,
        filepath: `${directory}/greeting.txt`,
        diff,
      },
      id = "perm_web_edit_review",
      patterns = ["greeting.txt"],
    ) {
      await transport.send({
        directory,
        payload: {
          type: "permission.asked",
          properties: {
            id,
            sessionID,
            permission: "edit",
            patterns,
            always: [],
            metadata,
          },
        },
      })
    },
    async replied(id = "perm_web_edit_review") {
      await transport.send({
        directory,
        payload: { type: "permission.replied", properties: { sessionID, requestID: id, reply: "reject" } },
      })
    },
  }
}

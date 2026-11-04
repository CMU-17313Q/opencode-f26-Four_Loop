import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const directory = "/root/projects/Hello-World"
const sessionID = "ses_web_edit_review"
const title = "Website edit review"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const diff = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-Hi\n+Hello\n"
const explanation = "Use a clearer greeting while preserving the existing file."

async function setup(
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
    ) {
      await transport.send({
        directory,
        payload: {
          type: "permission.asked",
          properties: {
            id,
            sessionID,
            permission: "edit",
            patterns: ["greeting.txt"],
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

async function settings(page: Page) {
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  return dialog
}

test("saves the project switch, reads it after refresh, and can turn it off", async ({ page }) => {
  const fixture = await setup(page)
  const dialog = await settings(page)
  const row = dialog.locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("switch", { name: "Explain before edit" })).toBeEnabled()
  await expect(row.getByText(directory, { exact: true })).toBeVisible()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).toBeChecked()
  expect(fixture.state.updates).toEqual([{ directory, body: { explain_before_edit: true } }])
  await test.info().attach("project-review-setting", { body: await page.screenshot(), contentType: "image/png" })
  await page.reload()
  await expectSessionTitle(page, title)
  const refreshed = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(refreshed.getByRole("switch")).toBeChecked()
  await expect(refreshed.getByRole("switch")).toBeEnabled()
  await refreshed.locator('[data-slot="switch-control"]').click()
  await expect(refreshed.getByRole("switch")).not.toBeChecked()
  expect(fixture.state.updates).toEqual([
    { directory, body: { explain_before_edit: true } },
    { directory, body: { explain_before_edit: false } },
  ])
})

test("can turn review on and off in a new session before sending a message", async ({ page }) => {
  const fixture = await setup(page, { draft: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByText(directory, { exact: true })).toBeVisible()
  await expect(row.getByRole("switch")).toBeEnabled()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).toBeChecked()
  await expect(row.getByRole("switch")).toBeEnabled()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).not.toBeChecked()
  expect(fixture.state.updates).toEqual([
    { directory, body: { explain_before_edit: true } },
    { directory, body: { explain_before_edit: false } },
  ])
})

test("enables review for the only open project from home without creating a session", async ({ page }) => {
  const fixture = await setup(page, { home: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("button", { name: "Project Hello-World", exact: true })).toContainText("Hello-World")
  await expect(row.getByText(directory, { exact: true })).toBeVisible()
  await expect(row.getByRole("switch")).toBeEnabled()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).toBeChecked()
  expect(fixture.state.updates).toEqual([{ directory, body: { explain_before_edit: true } }])
})

test("reports a failed save without showing the project as enabled", async ({ page }) => {
  const fixture = await setup(page, { failSave: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("switch")).toBeEnabled()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(
    page.getByText("Could not save this project's explain-before-edit setting.", { exact: true }),
  ).toBeVisible()
  await expect(row.getByRole("switch")).not.toBeChecked()
  expect(fixture.state.enabled).toBe(false)
})

test("disables the project switch when the setting cannot be read", async ({ page }) => {
  await setup(page, { failRead: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("alert")).toHaveText("Could not read this project's explain-before-edit setting.")
  await expect(row.getByRole("switch")).toBeDisabled()
})

for (const action of ["Accept change", "Reject"] as const) {
  test(`requires a manual ${action} even when auto-accept is enabled`, async ({ page }) => {
    const fixture = await setup(page)
    const dialog = await settings(page)
    const auto = dialog.locator('[data-action="settings-auto-accept-permissions"]')
    await expect(auto.getByRole("switch")).toBeEnabled()
    await auto.locator('[data-slot="switch-control"]').click()
    await expect(auto.getByRole("switch")).toBeChecked()
    await page.keyboard.press("Escape")
    await fixture.ask()
    const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    await expect(dock.getByRole("heading", { name: "Why this change?" })).toBeVisible()
    await expect(dock.getByText(explanation, { exact: true })).toBeVisible()
    await expect(dock.locator("pre")).toHaveText(diff)
    await expect(dock.getByRole("button", { name: "Allow always", exact: true })).toHaveCount(0)
    await expect(dock.getByRole("button", { name: action, exact: true })).toBeEnabled()
    expect(fixture.state.replies).toEqual([])
    if (action === "Accept change") {
      await test.info().attach("protected-edit-review", { body: await page.screenshot(), contentType: "image/png" })
    }
    await dock.getByRole("button", { name: action, exact: true }).click()
    await expect
      .poll(() => fixture.state.replies)
      .toEqual([
        {
          path: `/session/${sessionID}/permissions/perm_web_edit_review`,
          body: { response: action === "Accept change" ? "once" : "reject" },
        },
      ])
    await fixture.replied()
    await expect(dock).toHaveCount(0)
  })
}

test("rejects with trimmed feedback and clears it for the next proposal", async ({ page }) => {
  const fixture = await setup(page)
  await fixture.ask()
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await dock.getByRole("button", { name: "Reject with feedback", exact: true }).click()
  await expect(dock.getByRole("button", { name: "Reject with feedback", exact: true })).toBeDisabled()
  await dock.getByRole("textbox", { name: "What should the agent change?" }).fill("A draft correction")
  await dock.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dock.getByRole("textbox")).toHaveCount(0)
  expect(fixture.state.replies).toEqual([])
  await dock.getByRole("button", { name: "Reject with feedback", exact: true }).click()
  await expect(dock.getByRole("textbox")).toHaveValue("")
  await dock.getByRole("textbox", { name: "What should the agent change?" }).fill("  Keep the original greeting.  ")
  await dock.getByRole("button", { name: "Reject with feedback", exact: true }).click()
  await expect
    .poll(() => fixture.state.replies)
    .toEqual([
      {
        path: "/permission/perm_web_edit_review/reply",
        body: { reply: "reject", message: "Keep the original greeting." },
      },
    ])
  await fixture.replied()
  await expect(dock).toHaveCount(0)
  await fixture.ask(
    {
      explainBeforeEdit: true,
      explanation: "Only add punctuation.",
      filepath: "greeting.txt",
      diff: diff.replace("+Hello", "+Hi!"),
    },
    "perm_next_edit_review",
  )
  await expect(dock.getByText("Only add punctuation.", { exact: true })).toBeVisible()
  await expect(dock.getByText(explanation, { exact: true })).toHaveCount(0)
  await dock.getByRole("button", { name: "Reject with feedback", exact: true }).click()
  await expect(dock.getByRole("textbox")).toHaveValue("")
})

test("only offers rejection for an invalid protected proposal", async ({ page }) => {
  const fixture = await setup(page)
  await fixture.ask({ explainBeforeEdit: true, explanation: " ", diff })
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(dock.getByRole("alert")).toHaveText(
    "This proposal has no valid explanation. Reject it and request a new proposal.",
  )
  await expect(dock.getByRole("button")).toHaveCount(1)
  await expect(dock.getByRole("button", { name: "Reject", exact: true })).toBeEnabled()
  expect(fixture.state.replies).toEqual([])
})

test("shows every file in a multi-file patch on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const fixture = await setup(page)
  await fixture.ask({
    explainBeforeEdit: true,
    explanation: "Update the greeting and add a note.",
    files: [
      { filePath: "greeting.txt", relativePath: "greeting.txt", patch: diff },
      { filePath: "note.txt", relativePath: "note.txt", patch: "+A note\n" },
    ],
  })
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(dock.locator("pre")).toHaveCount(2)
  await expect(dock.locator("pre").filter({ hasText: "+A note" })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Accept change", exact: true })).toBeVisible()
})

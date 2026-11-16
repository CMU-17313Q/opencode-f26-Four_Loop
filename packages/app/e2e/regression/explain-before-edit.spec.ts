import { expect, test, type Page } from "@playwright/test"
import { diff, directory, explanation, sessionID, setupEditReview, title } from "../utils/edit-review-fixture"
import { expectSessionTitle } from "../utils/waits"

async function settings(page: Page) {
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expect(dialog).toBeVisible()
  return dialog
}

test("saves the project switch, reads it after refresh, and can turn it off", async ({ page }) => {
  const fixture = await setupEditReview(page)
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
  const fixture = await setupEditReview(page, { draft: true })
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
  const fixture = await setupEditReview(page, { home: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("button", { name: "Project Hello-World", exact: true })).toContainText("Hello-World")
  await expect(row.getByText(directory, { exact: true })).toBeVisible()
  await expect(row.getByRole("switch")).toBeEnabled()
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).toBeChecked()
  expect(fixture.state.updates).toEqual([{ directory, body: { explain_before_edit: true } }])
})

test("reports a failed save without showing the project as enabled", async ({ page }) => {
  const fixture = await setupEditReview(page, { failSave: true })
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
  await setupEditReview(page, { failRead: true })
  const row = (await settings(page)).locator('[data-component="settings-edit-review"]')
  await expect(row.getByRole("alert")).toHaveText("Could not read this project's explain-before-edit setting.")
  await expect(row.getByRole("switch")).toBeDisabled()
})

for (const action of ["Accept change", "Reject"] as const) {
  test(`requires a manual ${action} even when auto-accept is enabled`, async ({ page }) => {
    const fixture = await setupEditReview(page)
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
  const fixture = await setupEditReview(page)
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
  const fixture = await setupEditReview(page)
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
  const fixture = await setupEditReview(page)
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

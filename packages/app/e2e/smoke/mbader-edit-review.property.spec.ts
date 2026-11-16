import { expect, test, type Locator } from "@playwright/test"
import { createTwoFilesPatch } from "diff"
import fc from "fast-check"
import { directory, sessionID, setupEditReview } from "../utils/edit-review-fixture"

// Generate distinguishable before/after text, including punctuation and Unicode.
// The feedback generator also includes newlines and surrounding whitespace.
const text = fc.string({ unit: fc.constantFrom("a", "b", "-", " ", "<", "&", "é", "界"), maxLength: 16 })
const feedback = fc.tuple(text, text).map(([first, second]) => `  Keep ${first}\nRevise ${second}  `)
const file = fc.record({
  folder: fc.constantFrom("", "src/", "nested/sub/"),
  id: fc.nat(99),
  before: text,
  after: text,
})
type FileInput = ReturnType<typeof file.generate>["value"]
const cases = 20

function fileDiff(input: FileInput) {
  const relativePath = `${input.folder}greeting-${input.id}.txt`
  return {
    type: "update",
    filePath: `${directory}/${relativePath}`,
    relativePath,
    patch: createTwoFilesPatch(
      relativePath,
      relativePath,
      `Hi ${input.id} ${input.before}\n`,
      `Hello ${input.id} ${input.after}\n`,
    ),
  }
}

async function expectDecisionControls(dock: Locator) {
  const actions = dock.locator('[data-slot="permission-footer-actions"]')
  await expect(actions.getByRole("button")).toHaveCount(3)
  for (const name of ["Accept change", "Reject", "Reject with feedback"]) {
    const button = actions.getByRole("button", { name, exact: true })
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
  }
}

// R3: Cancelling an unsubmitted rejection-feedback form shall return to the same
// pending proposal and its three decision controls without applying the edit.
// Kind: round-trip. R1 separately checks actual file state while approval is pending.
test("P4B mbader R3: cancelling feedback restores the same pending review", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  await fc.assert(
    fc.asyncProperty(file, feedback, async (input, draft) => {
      const context = await browser.newContext({ baseURL, locale: "en-US" })
      try {
        const page = await context.newPage()
        const fixture = await setupEditReview(page)
        const change = fileDiff(input)
        const requestID = `perm_mbader_cancel_${input.id}`
        const explanation = `Replace the greeting in ${change.relativePath}.`
        await fixture.ask(
          {
            explainBeforeEdit: true,
            explanation,
            filepath: change.relativePath,
            diff: change.patch,
          },
          requestID,
          [change.relativePath],
        )
        const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
        const review = dock.getByRole("region", { name: "Why this change?" })
        await expect(review.getByText(explanation, { exact: true })).toBeVisible()
        await expect(review.locator("pre code")).toHaveJSProperty("textContent", change.patch)
        await expectDecisionControls(dock)

        await dock.getByRole("button", { name: "Reject with feedback", exact: true }).click()
        const inputBox = review.getByRole("textbox", { name: "What should the agent change?" })
        await inputBox.fill(draft)
        await expect(inputBox).toHaveValue(draft)
        await dock.getByRole("button", { name: "Cancel", exact: true }).click()

        await expect(inputBox).toHaveCount(0)
        await expect(review.getByText(explanation, { exact: true })).toBeVisible()
        await expect(review.locator("pre code")).toHaveJSProperty("textContent", change.patch)
        await expectDecisionControls(dock)
        expect(fixture.state.replies).toEqual([])

        // After the round-trip assertions, prove the restored controls still address the original ID.
        await dock.getByRole("button", { name: "Reject", exact: true }).click()
        await expect
          .poll(() => fixture.state.replies)
          .toEqual([{ path: `/session/${sessionID}/permissions/${requestID}`, body: { response: "reject" } }])
      } finally {
        await context.close()
      }
    }),
    { numRuns: cases },
  )
  console.log(`P4B mbader R3: ${cases} browser feedback round trips passed`)
})

// Generate a baseline and a distinct extra file together, so all existing and added
// filenames are unique and their diff contents can detect accidental swaps.
const files = fc.uniqueArray(file, { selector: (input) => input.id, minLength: 3, maxLength: 6 })

// R4: For a multi-file proposal, the review shall make all affected filenames and
// their proposed diffs available together before the approval decision.
// Kind: metamorphic.
test("P4B mbader R4: adding a file preserves every original filename and diff", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  await fc.assert(
    fc.asyncProperty(files, async (input) => {
      const context = await browser.newContext({ baseURL, locale: "en-US" })
      try {
        const page = await context.newPage()
        const fixture = await setupEditReview(page)
        const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
        const review = dock.getByRole("region", { name: "Why this change?" })
        const allFiles = input.map(fileDiff)

        async function showAndCheck(changes: typeof allFiles, id: string) {
          await fixture.ask(
            {
              explainBeforeEdit: true,
              explanation: "Update the greeting in each listed file.",
              files: changes,
            },
            id,
            changes.map((change) => change.relativePath),
          )
          await expect(review).toBeVisible()
          await expect(review.locator("pre code")).toHaveCount(changes.length)
          for (const change of changes) {
            const labels = review.getByText(change.relativePath, { exact: true })
            const diffCard = labels.locator("..").filter({ has: page.locator("pre code") })
            const code = diffCard.locator("pre code")
            await expect(code).toBeVisible()
            await expect(code).toHaveJSProperty("textContent", change.patch)
          }
          await expectDecisionControls(dock)
          expect(fixture.state.replies).toEqual([])
        }

        await showAndCheck(allFiles.slice(0, -1), "perm_mbader_original")
        await fixture.replied("perm_mbader_original")
        await expect(review).toHaveCount(0)
        await showAndCheck(allFiles, "perm_mbader_extended")
      } finally {
        await context.close()
      }
    }),
    { numRuns: cases },
  )
  console.log(`P4B mbader R4: ${cases} comparisons of multi-file reviews passed`)
})

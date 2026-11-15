import { expect, test } from "bun:test"
import fc from "fast-check"
import { getEditDiffs, getEditReview, selectEditReviewOption } from "../../src/routes/session/edit-review"
import { tmpdir } from "../fixture/fixture"
import { feedback, mount, proposal, wait } from "./edit-review.fixture"

const settings = { numRuns: 100, seed: 173135 }
// Bounded readable paths/lines reach real review states, including nesting and spaces,
// without terminal control sequences that make text-position assertions ambiguous.
const filename = fc
  .tuple(fc.constantFrom("src", "nested dir"), fc.nat({ max: 999 }), fc.constantFrom("ts", "py", "js", "rs"))
  .map(([dir, id, ext]) => `${dir}/file ${id}.${ext}`)
const change = fc.record({ filename, value: fc.integer({ min: -999, max: 999 }) })
const draft = fc.oneof(
  fc.constantFrom("", " \n\t", "Keep café\nغيّر الاسم", "First line\nSecond line"),
  fc.string({ maxLength: 120 }),
)

function request(input: { filename: string; value: number }, id: string) {
  return {
    ...proposal,
    id,
    patterns: [input.filename],
    metadata: {
      explainBeforeEdit: true,
      explanation: `Update value ${input.value}.`,
      filepath: input.filename,
      diff: `--- a/${input.filename}\n+++ b/${input.filename}\n@@ -1 +1 @@\n-old:${input.value}\n+new:${input.value}\n`,
    },
  }
}

// R3: Cancelling Reject with Feedback must close the form without submitting
// feedback, rejecting the edit, or losing the pending proposal. Kind: round-trip.
// Repeated opens/cancels use the actual textarea, Escape binding and SDK transport.
test("R3: generated feedback drafts cancel back to the same pending review", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    await fc.assert(
      fc.asyncProperty(change, fc.array(draft, { minLength: 1, maxLength: 3 }), async (input, drafts) => {
        ui.setRequest(request(input, `per_cancel_${input.filename}_${input.value}`))
        await ui.app.renderOnce()
        const before = ui.app.captureCharFrame()
        const count = ui.replies.length
        for (const text of drafts) {
          const editor = await feedback(ui)
          editor.setText(text)
          ui.app.mockInput.pressEscape()
          await ui.app.renderOnce()
          expect(ui.replies).toHaveLength(count)
          expect(ui.app.captureCharFrame()).toBe(before)
        }
        // The restored controls still operate on this request, not a discarded form.
        ui.app.mockInput.pressEscape()
        await wait(() => ui.replies.length === count + 1)
        expect(ui.replies[count]).toEqual({ reply: "reject" })
      }),
      settings,
    )
    console.info("P4B edit-review.property.test.ts: R3 passed (100 cases; seed 173135)")
  } finally {
    ui.app.renderer.destroy()
  }
}, 30000)

// R5: Preserve consistent labels, keyboard shortcuts and control placement across
// target files and programming languages. Kind: metamorphic.
// Compare rendered control coordinates at a fixed viewport and independently exercise
// Accept/Reject/feedback keyboard semantics for both generated proposals.
test("R5: changing proposal content preserves rendered controls and keyboard semantics", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, 120)
  try {
    await fc.assert(
      fc.asyncProperty(change, change, fc.constantFrom("once", "reject", "feedback"), async (a, b, action) => {
        const positions: number[][] = []
        for (const [index, input] of [a, b].entries()) {
          ui.setRequest(request(input, `per_controls_${index}_${input.filename}_${input.value}`))
          await ui.app.renderOnce()
          const frame = ui.app.captureCharFrame()
          expect(frame).toContain(input.filename)
          expect(frame).toContain(`Update value ${input.value}.`)
          // The compact viewport can put the diff below the fold. Check the real
          // diff representation rather than incorrectly requiring it all onscreen.
          expect(getEditDiffs(request(input, "unused"))[0].diff).toContain(`-old:${input.value}`)
          expect(getEditDiffs(request(input, "unused"))[0].diff).toContain(`+new:${input.value}`)
          positions.push(
            ["Accept change", "Reject", "Reject with feedback"].map((label) => {
              expect(frame).toContain(label)
              return frame.indexOf(label)
            }),
          )
          const count = ui.replies.length
          if (action === "feedback") {
            const editor = await feedback(ui)
            editor.setText("Keep the name.")
          }
          if (action === "reject") ui.app.mockInput.pressArrow("right")
          ui.app.mockInput.pressEnter()
          await wait(() => ui.replies.length === count + 1)
          expect(ui.replies[count]).toEqual(
            action === "feedback" ? { reply: "reject", message: "Keep the name." } : { reply: action },
          )
        }
        expect(positions[1]).toEqual(positions[0])
      }),
      settings,
    )
    console.info("P4B edit-review.property.test.ts: R5 passed (100 cases; seed 173135)")
  } finally {
    ui.app.renderer.destroy()
  }
}, 30000)

// R8: For multi-file proposed edits, identify every affected file before allowing
// approval. Kind: metamorphic. Add a file, duplicate an entry and reverse the list:
// no distinct file disappears; duplicate labels are deduplicated in first-seen order.
// Moves identify both endpoints; every patch stays paired with its target path.
test("R8: multi-file review preserves all paths and patches under reordering and duplication", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(change, { minLength: 2, maxLength: 8, selector: (item) => item.filename }),
      fc.boolean(),
      (inputs, move) => {
        const files = inputs.map((input, index) => ({
          filePath: `/repo/${input.filename}`,
          relativePath: input.filename,
          type: move && index === 0 ? "move" : "update",
          movePath: move && index === 0 ? `/repo/moved/${input.filename}` : undefined,
          patch: request(input, "unused").metadata.diff,
        }))
        const labels = files.map((file) =>
          file.type === "move" ? `${file.filePath} -> ${file.movePath}` : file.relativePath,
        )
        const review = (items: typeof files) => ({ ...proposal, metadata: { ...proposal.metadata, files: items } })
        expect(getEditReview(review(files.slice(0, -1))).files).toEqual(labels.slice(0, -1))
        expect(getEditReview(review(files)).files).toEqual(labels)
        expect(getEditReview(review([...files].reverse())).files).toEqual([...labels].reverse())
        expect(getEditReview(review([...files, files[0]])).files).toEqual(labels)
        expect(getEditDiffs(review(files))).toEqual(
          files.map((file) => ({ path: file.relativePath, diff: file.patch })),
        )
        expect(selectEditReviewOption(review(files), "once")).toBe("once")
      },
    ),
    settings,
  )
  console.info("P4B edit-review.property.test.ts: R8 passed (100 cases; seed 173135)")
})

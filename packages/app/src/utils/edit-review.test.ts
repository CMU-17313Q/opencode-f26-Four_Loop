import { describe, expect, test } from "bun:test"
import { getEditReview, requiresEditReview } from "./edit-review"

const diff = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-Hi\n+Hello\n"
const request = (metadata: Record<string, unknown>) => ({
  permission: "edit",
  metadata: { explainBeforeEdit: true, ...metadata },
})

describe("protected edit review", () => {
  test("requires the backend review marker on an edit permission", () => {
    expect(requiresEditReview({ permission: "edit", metadata: { explanation: "ordinary" } })).toBe(false)
    expect(requiresEditReview({ permission: "bash", metadata: { explainBeforeEdit: true } })).toBe(false)
    expect(getEditReview({ permission: "edit", metadata: null })).toBeUndefined()
    expect(requiresEditReview(request({}))).toBe(true)
  })

  test("shows a complete single-file proposal", () => {
    expect(
      getEditReview(request({ explanation: "  Make the greeting clearer.  ", filepath: "greeting.txt", diff })),
    ).toEqual({
      explanation: "Make the greeting clearer.",
      files: ["greeting.txt"],
      diffs: [{ path: "greeting.txt", diff }],
      problem: undefined,
    })
  })

  test("keeps all patch files and move destinations", () => {
    const result = getEditReview(
      request({
        explanation: "Move the greeting and add a note.",
        files: [
          { type: "move", filePath: "old.txt", movePath: "new.txt", patch: diff },
          { type: "add", filePath: "/project/note.txt", relativePath: "note.txt", patch: "+A note\n" },
        ],
      }),
    )
    expect(result?.files).toEqual(["old.txt → new.txt", "note.txt"])
    expect(result?.diffs).toHaveLength(2)
    expect(result?.problem).toBeUndefined()
  })

  test("falls back to the combined diff rather than hiding incomplete patch metadata", () => {
    const result = getEditReview(
      request({
        explanation: "Update both files.",
        diff,
        files: [{ filePath: "a.txt", patch: diff }, { filePath: "b.txt" }],
      }),
    )
    expect(result?.diffs).toEqual([{ path: "", diff }])
  })

  test("rejects missing, oversized, or unreviewable proposal metadata", () => {
    expect(getEditReview(request({ explanation: " ", diff }))?.problem).toBe("missing")
    expect(getEditReview(request({ explanation: "x".repeat(4001), diff }))?.problem).toBe("tooLong")
    expect(getEditReview(request({ explanation: "x".repeat(4000), diff }))?.problem).toBeUndefined()
    expect(getEditReview(request({ explanation: "A valid explanation." }))?.problem).toBe("missingDiff")
  })
})

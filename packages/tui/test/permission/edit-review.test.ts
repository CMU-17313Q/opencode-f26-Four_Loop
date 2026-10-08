import { expect, test } from "bun:test"
import {
  editReviewOptions,
  getEditDiffs,
  getEditReview,
  MAX_REVIEW_EXPLANATION_LENGTH,
  selectEditReviewOption,
  type EditReviewRequest,
} from "../../src/routes/session/edit-review"

function request(metadata: Record<string, unknown> = {}): EditReviewRequest {
  return {
    permission: "edit",
    metadata: { explainBeforeEdit: true, explanation: "Explain this change.", filepath: "src/example.ts", ...metadata },
  }
}

test("valid explained edits expose acceptance, rejection, and feedback, never always", () => {
  const input = request({ explanation: "  Explain this change.\n" })
  expect(getEditReview(input)).toMatchObject({
    enabled: true,
    explanation: "Explain this change.",
    files: ["src/example.ts"],
  })
  expect(getEditReview(input).problem).toBeUndefined()
  expect(editReviewOptions(input)).toEqual({
    once: "Accept change",
    reject: "Reject",
    feedback: "Reject with feedback",
  })
  expect(selectEditReviewOption(input, "once")).toBe("once")
  expect(selectEditReviewOption(input, "reject")).toBe("reject")
  expect(selectEditReviewOption(input, "feedback")).toBe("feedback")
  expect(selectEditReviewOption(input, "always")).toBeUndefined()
  expect(input.metadata).toMatchObject({ explanation: "  Explain this change.\n" })
})

for (const value of [undefined, null, 5, {}, [], "", " \n ", "x".repeat(MAX_REVIEW_EXPLANATION_LENGTH + 1)]) {
  test(`invalid explanation (${typeof value}, ${String(value).length}) offers rejection only`, () => {
    const input = request({ explanation: value })
    expect(getEditReview(input).problem).toBeDefined()
    expect(editReviewOptions(input)).toEqual({ reject: "Reject" })
    expect(selectEditReviewOption(input, "once")).toBeUndefined()
    expect(selectEditReviewOption(input, "feedback")).toBeUndefined()
    expect(selectEditReviewOption(input, "always")).toBeUndefined()
    expect(selectEditReviewOption(input, "reject")).toBe("reject")
  })
}

test("a trimmed explanation at the exact limit is accepted", () => {
  const input = request({ explanation: `  ${"x".repeat(MAX_REVIEW_EXPLANATION_LENGTH)}  ` })
  expect(getEditReview(input).problem).toBeUndefined()
  expect(selectEditReviewOption(input, "once")).toBe("once")
})

for (const metadata of [undefined, null, false, [], {}, { explainBeforeEdit: false }, { explainBeforeEdit: "true" }]) {
  test(`legacy metadata (${JSON.stringify(metadata)}) preserves ordinary options`, () => {
    const input = { permission: "edit", metadata }
    expect(getEditReview(input).enabled).toBe(false)
    expect(selectEditReviewOption(input, "feedback")).toBeUndefined()
    expect(editReviewOptions(input)).toEqual({ once: "Allow once", always: "Allow always", reject: "Reject" })
    expect(selectEditReviewOption(input, "always")).toBe("always")
  })
}

test("non-edit permission ignores an unrelated explanation marker", () => {
  const input = { ...request(), permission: "read" }
  expect(getEditReview(input).enabled).toBe(false)
  expect(selectEditReviewOption(input, "always")).toBe("always")
})

test("multi-file metadata lists actual files, both ends of a move, and skips malformed entries", () => {
  const input = request({
    files: [
      { relativePath: "src/a.ts", filePath: "/repo/src/a.ts", type: "update" },
      { filePath: "/repo/old.ts", movePath: "/repo/new.ts", type: "move" },
      { filePath: "deleted.txt", type: "delete" },
      null,
      4,
      {},
      { relativePath: " " },
      { relativePath: "src/a.ts" },
    ],
  })
  expect(getEditReview(input).files).toEqual(["src/a.ts", "/repo/old.ts -> /repo/new.ts", "deleted.txt"])
})

test("malformed files metadata falls back to filepath", () => {
  expect(getEditReview(request({ files: "invalid" })).files).toEqual(["src/example.ts"])
  expect(getEditReview(request({ files: [null, 5], filepath: 8 })).files).toEqual([])
})

test("selection uses the current request, not a prior proposal's allowed actions", () => {
  const legacy = request({ explainBeforeEdit: false })
  const protectedEdit = request()
  const invalid = request({ explanation: "" })
  expect(selectEditReviewOption(legacy, "always")).toBe("always")
  expect(selectEditReviewOption(protectedEdit, "always")).toBeUndefined()
  expect(selectEditReviewOption(invalid, "once")).toBeUndefined()
  expect(selectEditReviewOption(protectedEdit, "once")).toBe("once")
})

test("unknown/prototype choices cannot fall through to approval", () => {
  for (const option of ["__proto__", "constructor", "confirm", "cancel", "", 1, Symbol("once")]) {
    expect(selectEditReviewOption(request(), option)).toBeUndefined()
  }
})

test("an explanation alone does not enable protected review", () => {
  const input = { permission: "edit", metadata: { explanation: "Explain this change." } }
  expect(getEditReview(input).enabled).toBe(false)
  expect(selectEditReviewOption(input, "always")).toBe("always")
})

test("a protected invalid proposal never exposes the oversized text", () => {
  const input = request({ explanation: "x".repeat(MAX_REVIEW_EXPLANATION_LENGTH + 1) })
  expect(getEditReview(input).explanation).toBe("")
  expect(getEditReview(input).problem).toBeDefined()
})

test("frozen request metadata can be rendered without changing the request", () => {
  const metadata = Object.freeze({
    explainBeforeEdit: true,
    explanation: "  Explain this change.  ",
    filepath: "src/frozen.ts",
  })
  const input = Object.freeze({ permission: "edit", metadata })
  expect(getEditReview(input).explanation).toBe("Explain this change.")
  expect(editReviewOptions(input)).toEqual({
    once: "Accept change",
    reject: "Reject",
    feedback: "Reject with feedback",
  })
  expect(input.metadata.explanation).toBe("  Explain this change.  ")
})

test("per-file patches keep every file's diff in a protected multi-file proposal", () => {
  const input = request({
    diff: "combined fallback",
    files: [
      { relativePath: "a.ts", patch: "first diff" },
      { relativePath: "b.ts", patch: "second diff" },
    ],
  })
  expect(getEditDiffs(input)).toEqual([
    { path: "a.ts", diff: "first diff" },
    { path: "b.ts", diff: "second diff" },
  ])
})

test("legacy proposals keep the original combined-diff behavior", () => {
  const input = request({
    explainBeforeEdit: false,
    diff: "combined",
    files: [{ relativePath: "a.ts", patch: "individual" }],
  })
  expect(getEditDiffs(input)).toEqual([{ path: "src/example.ts", diff: "combined" }])
})

test("incomplete per-file metadata falls back to the complete combined diff", () => {
  for (const files of [[], [null], [{ patch: "one" }, {}], [{ patch: 5 }], [{ patch: " " }], "bad"]) {
    expect(getEditDiffs(request({ files, diff: "combined" }))).toEqual([{ path: "src/example.ts", diff: "combined" }])
  }
})

test("missing or malformed diffs do not crash rendering", () => {
  for (const diff of [undefined, null, 5, {}, "", " "]) expect(getEditDiffs(request({ diff }))).toEqual([])
  expect(getEditDiffs({ permission: "edit", metadata: null })).toEqual([])
})

test("per-file diff falls back to filePath when relativePath is absent", () => {
  expect(getEditDiffs(request({ files: [{ filePath: "/repo/a.ts", patch: "a" }] }))).toEqual([
    { path: "/repo/a.ts", diff: "a" },
  ])
})

test("blank relative paths do not hide a usable absolute path", () => {
  expect(getEditReview(request({ files: [{ relativePath: " ", filePath: "/repo/a.ts" }] })).files).toEqual([
    "/repo/a.ts",
  ])
})

test("one-character explanation is accepted while spaces are rejected", () => {
  expect(editReviewOptions(request({ explanation: " x " }))).toEqual({
    once: "Accept change",
    reject: "Reject",
    feedback: "Reject with feedback",
  })
  expect(editReviewOptions(request({ explanation: "   " }))).toEqual({ reject: "Reject" })
})

test("valid metadata changing to invalid immediately removes acceptance", () => {
  const input = request()
  expect(selectEditReviewOption(input, "once")).toBe("once")
  const metadata = input.metadata as Record<string, unknown>
  metadata.explanation = " "
  expect(editReviewOptions(input)).toEqual({ reject: "Reject" })
  expect(selectEditReviewOption(input, "once")).toBeUndefined()
})

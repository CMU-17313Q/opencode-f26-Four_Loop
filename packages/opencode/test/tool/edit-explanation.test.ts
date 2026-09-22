import { describe, expect, test } from "bun:test"
import { MAX_EDIT_EXPLANATION_LENGTH, validateEditExplanation } from "../../src/tool/edit-explanation"

describe("edit explanation validation", () => {
  test("trims a valid explanation", () => {
    expect(validateEditExplanation("  Add an empty-list check to prevent division by zero.  ")).toEqual({
      valid: true,
      explanation: "Add an empty-list check to prevent division by zero.",
    })
  })

  for (const value of [undefined, null, 42, true, {}, [], "", " \n\t "]) {
    test(`rejects invalid explanation ${JSON.stringify(value)}`, () => {
      const result = validateEditExplanation(value)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.error.length).toBeGreaterThan(0)
    })
  }

  test("accepts the length boundary after trimming", () => {
    expect(validateEditExplanation(`  ${"x".repeat(MAX_EDIT_EXPLANATION_LENGTH)}  `).valid).toBe(true)
  })

  test("rejects text over the length boundary", () => {
    expect(validateEditExplanation("x".repeat(MAX_EDIT_EXPLANATION_LENGTH + 1)).valid).toBe(false)
  })
})

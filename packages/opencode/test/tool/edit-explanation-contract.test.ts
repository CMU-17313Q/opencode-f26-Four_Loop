import { describe, expect, test } from "bun:test"
import { MAX_EDIT_EXPLANATION_LENGTH, validateEditExplanation } from "../../src/tool/edit-explanation"

describe("explanation requirement regression", () => {
  test("requirement is exactly 4000 characters", () => {
    expect(MAX_EDIT_EXPLANATION_LENGTH).toBe(4000)
    expect(validateEditExplanation("x".repeat(4000))).toEqual({ valid: true, explanation: "x".repeat(4000) })
    expect(validateEditExplanation("x".repeat(4001))).toEqual({
      valid: false,
      error: "Keep the explanation within 4000 characters after trimming.",
    })
  })
  test("trims outer whitespace, keeps internal text", () => {
    expect(validateEditExplanation(" \nFix A.\n\nKeep B.\t ")).toEqual({ valid: true, explanation: "Fix A.\n\nKeep B." })
    expect(validateEditExplanation(" ".repeat(5000) + "x" + " ".repeat(5000))).toEqual({ valid: true, explanation: "x" })
  })
  test("rejects blank text with the intended explanation", () => {
    for (const value of ["", " ", "\n\t"]) {
      expect(validateEditExplanation(value)).toEqual({ valid: false, error: "The explanation must not be blank." })
    }
  })
  test("rejects non-strings without coercion", () => {
    for (const value of [undefined, null, 4, false, {}, [], new String("valid text")]) {
      expect(validateEditExplanation(value)).toEqual({
        valid: false,
        error: "Provide an explanation string describing what changes and why.",
      })
    }
  })
})

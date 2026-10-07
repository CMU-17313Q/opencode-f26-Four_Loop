export const MAX_EDIT_EXPLANATION_LENGTH = 4000

export type EditExplanationResult = { valid: true; explanation: string } | { valid: false; error: string }

/** Validates presentation requirements, not the factual correctness of an explanation. */
export function validateEditExplanation(value: unknown): EditExplanationResult {
  if (typeof value !== "string") {
    return { valid: false, error: "Provide an explanation string describing what changes and why." }
  }
  const explanation = value.trim()
  if (explanation.length === 0) {
    return { valid: false, error: "The explanation must not be blank." }
  }
  if (explanation.length > MAX_EDIT_EXPLANATION_LENGTH) {
    return {
      valid: false,
      error: `Keep the explanation within ${MAX_EDIT_EXPLANATION_LENGTH} characters after trimming.`,
    }
  }
  return { valid: true, explanation }
}

import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  editReviewOptions,
  getEditDiffs,
  getEditReview,
  MAX_REVIEW_EXPLANATION_LENGTH,
  selectEditReviewOption,
  type EditReviewRequest,
} from "../../src/routes/session/edit-review"

// Property tests for Rashid Al-Kubaisi (ralkubai), P4B.
// Target: the terminal review of multi-file Explain Before Edit proposals
// (packages/tui/src/routes/session/edit-review.ts). These functions decide what
// the reviewer is shown and which decisions they may take, so they are where my
// Satisfaction requirements are actually enforced.
//
// Scope note carried over from P4A: these properties check what the review
// displays and offers, never whether an LLM-written explanation is factually
// correct. That distinction is why R2, R3 and R8 were revised in Step 1.

// ---------------------------------------------------------------------------
// Generators
//
// The interviews pointed at specific boundaries, so the generators aim at them
// rather than at random strings:
//  - S-3 and C-2 worried about multi-file patches, so file lists run 0..4 and
//    reuse a small pool of paths, which makes duplicates and near-duplicates
//    common instead of astronomically unlikely.
//  - the review drops entries whose name is blank and renders "move" entries as
//    "from -> to", so blank strings, whitespace-only strings and move records
//    are generated deliberately.
//  - the explanation limit is 4000 characters after trimming, so lengths are
//    drawn from just under, exactly on, and just over that edge, plus the blank
//    and whitespace-only cases that force the "no valid explanation" path.
//  - patches are sometimes blank, because getEditDiffs is only allowed to use
//    per-file diffs when every file has one.
// ---------------------------------------------------------------------------

const PATHS = ["src/a.ts", "src/b.ts", "src/nested/c.tsx", "README.md", "src/a.ts"]

const pathArb = fc.constantFrom(...PATHS)
const blankishArb = fc.constantFrom("", " ", "\n", "  \t ")
const maybeBlankPath = fc.oneof({ weight: 4, arbitrary: pathArb }, { weight: 1, arbitrary: blankishArb })

/** A patch body; sometimes blank, which must force the combined-diff fallback. */
const patchArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("@@ -1 +1 @@\n-old\n+new\n", "@@ -2,3 +2,4 @@\n context\n+added\n") },
  { weight: 1, arbitrary: blankishArb },
)

/** A normal file entry. relativePath wins over filePath when it is non-blank. */
const plainFileArb = fc.record(
  {
    filePath: maybeBlankPath,
    relativePath: fc.option(maybeBlankPath, { nil: undefined }),
    patch: fc.option(patchArb, { nil: undefined }),
  },
  { requiredKeys: ["filePath"] },
)

/** A rename entry, rendered as "from -> to" only when both sides are non-blank. */
const moveFileArb = fc.record({
  type: fc.constant("move"),
  filePath: maybeBlankPath,
  movePath: maybeBlankPath,
  patch: fc.option(patchArb, { nil: undefined }),
})

/** Entries that are not records at all, which the review must skip. */
const junkFileArb = fc.constantFrom(null, 7, "src/x.ts", [], true)

const fileEntryArb = fc.oneof(
  { weight: 6, arbitrary: plainFileArb },
  { weight: 2, arbitrary: moveFileArb },
  { weight: 1, arbitrary: junkFileArb },
)

const fileListArb = fc.array(fileEntryArb, { minLength: 0, maxLength: 4 })

/** Explanations clustered on the 4000-character limit and the blank cases. */
const explanationArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("Renames the helper and updates its callers.", "  Adds a null check.\n") },
  { weight: 1, arbitrary: blankishArb },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: MAX_REVIEW_EXPLANATION_LENGTH - 2, max: MAX_REVIEW_EXPLANATION_LENGTH + 2 })
      .map((n) => "x".repeat(n)),
  },
  { weight: 1, arbitrary: fc.constantFrom(undefined, null, 42, {}, []) },
)

const metadataArb = fc.record(
  {
    explainBeforeEdit: fc.constantFrom(true, false, undefined),
    explanation: explanationArb,
    files: fc.option(fileListArb, { nil: undefined }),
    filepath: fc.option(maybeBlankPath, { nil: undefined }),
    diff: fc.option(fc.oneof(patchArb, blankishArb), { nil: undefined }),
  },
  { requiredKeys: [] },
)

const requestArb: fc.Arbitrary<EditReviewRequest> = fc.record({
  permission: fc.constantFrom("edit", "bash", "webfetch"),
  metadata: fc.oneof({ weight: 8, arbitrary: metadataArb }, { weight: 1, arbitrary: fc.constantFrom(null, 5, "x", []) }),
})

/** Requests that reach the explained-review path with a valid explanation. */
const enabledRequestArb: fc.Arbitrary<EditReviewRequest> = fc
  .record({
    files: fileListArb,
    filepath: fc.option(maybeBlankPath, { nil: undefined }),
    diff: fc.option(patchArb, { nil: undefined }),
    explanation: fc.constantFrom("Renames the helper.", "Adds a guard clause.", "Splits the parser in two."),
  })
  .map(({ files, filepath, diff, explanation }) => ({
    permission: "edit",
    metadata: { explainBeforeEdit: true, explanation, files, filepath, diff },
  }))

// ---------------------------------------------------------------------------
// Helpers shared by several properties
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataOf(request: EditReviewRequest): Record<string, unknown> {
  return isRecord(request.metadata) ? request.metadata : {}
}

/**
 * Print a line after a property passes. The package runs
 * `bun test --only-failures`, which hides the names of passing tests, so
 * without this the CI log would not show that these properties ran at all.
 */
function report(label: string, cases: number) {
  console.log(`[P4B ralkubai] ${label}: ${cases} generated cases passed`)
}

// ---------------------------------------------------------------------------
// R1: While a proposal is pending, the review offers an explicit decision for
// that proposal only, and never a standing "always allow".
// Kind: invariant
// ---------------------------------------------------------------------------
test("R1: an explained proposal never offers a standing allow, and reject is always available", () => {
  let cases = 0
  fc.assert(
    fc.property(requestArb, (request) => {
      cases++
      const review = getEditReview(request)
      const options = editReviewOptions(request)
      if (!review.enabled) return
      expect(Object.keys(options)).toContain("reject")
      expect(Object.hasOwn(options, "always")).toBe(false)
    }),
    { numRuns: 500 },
  )
  report("R1 invariant", cases)
})

// ---------------------------------------------------------------------------
// R3: The review lists every file the proposal touches and no others.
// Kind: invariant
// ---------------------------------------------------------------------------
test("R3: the listed files are exactly the proposal's own files, deduplicated and never blank", () => {
  let cases = 0
  fc.assert(
    fc.property(requestArb, (request) => {
      cases++
      const review = getEditReview(request)
      if (!review.enabled) {
        expect(review.files).toEqual([])
        return
      }

      // No blanks, and no duplicates: the reviewer sees each file once.
      for (const name of review.files) expect(name.trim().length).toBeGreaterThan(0)
      expect(new Set(review.files).size).toBe(review.files.length)

      // Nothing invented: every listed name traces back to an entry the
      // proposal supplied, or to the single-file fallback path.
      const metadata = metadataOf(request)
      const entries = Array.isArray(metadata.files) ? metadata.files.filter(isRecord) : []
      const fallback = typeof metadata.filepath === "string" ? metadata.filepath : undefined
      for (const name of review.files) {
        const fromEntry = entries.some((entry) => {
          const movePath = typeof entry.movePath === "string" ? entry.movePath : undefined
          const filePath = typeof entry.filePath === "string" ? entry.filePath : undefined
          const relativePath = typeof entry.relativePath === "string" ? entry.relativePath : undefined
          return name === relativePath || name === filePath || (filePath && movePath && name === `${filePath} -> ${movePath}`)
        })
        expect(fromEntry || name === fallback).toBe(true)
      }

      // Nothing hidden: every entry that has a usable name is shown.
      for (const entry of entries) {
        const isMove =
          entry.type === "move" &&
          typeof entry.filePath === "string" &&
          entry.filePath.trim() &&
          typeof entry.movePath === "string" &&
          entry.movePath.trim()
        const expected = isMove
          ? `${entry.filePath} -> ${entry.movePath}`
          : typeof entry.relativePath === "string" && entry.relativePath.trim()
            ? entry.relativePath
            : typeof entry.filePath === "string"
              ? entry.filePath
              : ""
        if (expected.trim()) expect(review.files).toContain(expected)
      }
    }),
    { numRuns: 500 },
  )
  report("R3 invariant", cases)
})

// ---------------------------------------------------------------------------
// R4: When a proposal's explanation is missing, blank or over the review limit,
// the review shows no explanation text, states the problem, and offers only
// Reject.
// Kind: model / oracle — compared against a direct statement of the rule.
// ---------------------------------------------------------------------------
test("R4: explanation validity matches the plain rule, and an invalid one offers only Reject", () => {
  let cases = 0
  fc.assert(
    fc.property(requestArb, (request) => {
      cases++
      const review = getEditReview(request)
      if (!review.enabled) return

      // The obviously-correct version of the rule.
      const raw = metadataOf(request).explanation
      const text = typeof raw === "string" ? raw.trim() : ""
      const expectValid = text.length > 0 && text.length <= MAX_REVIEW_EXPLANATION_LENGTH

      expect(review.problem === undefined).toBe(expectValid)
      if (expectValid) {
        expect(review.explanation).toBe(text)
        expect(editReviewOptions(request)).toEqual({
          once: "Accept change",
          reject: "Reject",
          feedback: "Reject with feedback",
        })
      } else {
        // Nothing the review could not vouch for is presented as an explanation.
        expect(review.explanation).toBe("")
        expect(review.problem).toBeString()
        expect(editReviewOptions(request)).toEqual({ reject: "Reject" })
      }
    }),
    { numRuns: 500 },
  )
  report("R4 model/oracle", cases)
})

// ---------------------------------------------------------------------------
// R5: The review never yields a decision it did not offer, so cancelling or
// mis-keying cannot submit anything.
// Kind: round-trip — offer, select, and land back on the same option.
// ---------------------------------------------------------------------------
test("R5: a decision round-trips iff it was offered, and anything else yields nothing", () => {
  let cases = 0
  const anyOption = fc.constantFrom("once", "always", "reject", "feedback", "cancel", "", "__proto__", 0)
  fc.assert(
    fc.property(requestArb, anyOption, (request, option) => {
      cases++
      const options = editReviewOptions(request)
      const selected = selectEditReviewOption(request, option as PropertyKey)

      if (selected === undefined) {
        // Either the key is not a decision at all, or it was not on offer.
        const isDecision = option === "once" || option === "always" || option === "reject" || option === "feedback"
        expect(!isDecision || !Object.hasOwn(options, option as string)).toBe(true)
        return
      }

      // A returned decision is always one that was actually offered, and it
      // round-trips to itself.
      expect(Object.hasOwn(options, selected)).toBe(true)
      expect(selected).toBe(option as typeof selected)
      expect(selectEditReviewOption(request, selected)).toBe(selected)
    }),
    { numRuns: 500 },
  )
  report("R5 round-trip", cases)
})

// ---------------------------------------------------------------------------
// R7: For a fixed proposal, changing only the explanation text does not change
// the list of target files, the proposed diffs, or the decisions on offer.
// Kind: metamorphic
// ---------------------------------------------------------------------------
test("R7: rewording the explanation changes nothing but the explanation", () => {
  let cases = 0
  fc.assert(
    fc.property(
      enabledRequestArb,
      fc.constantFrom("A different wording of the same change.", "Refactors the helper; callers updated."),
      (request, reworded) => {
        cases++
        const metadata = metadataOf(request)
        const alternative: EditReviewRequest = {
          permission: request.permission,
          metadata: { ...metadata, explanation: reworded },
        }

        const before = getEditReview(request)
        const after = getEditReview(alternative)

        expect(after.files).toEqual(before.files)
        expect(after.enabled).toBe(before.enabled)
        expect(after.problem).toBe(before.problem)
        expect(getEditDiffs(alternative)).toEqual(getEditDiffs(request))
        expect(editReviewOptions(alternative)).toEqual(editReviewOptions(request))

        // The explanation itself is the one thing that is allowed to differ.
        expect(after.explanation).toBe(reworded)
      },
    ),
    { numRuns: 500 },
  )
  report("R7 metamorphic", cases)
})

// ---------------------------------------------------------------------------
// R8: The review provides one diff per file when every file has one, and falls
// back to the combined diff rather than showing a subset.
// Kind: invariant
// ---------------------------------------------------------------------------
test("R8: diffs are per-file or the combined fallback, never a partial subset", () => {
  let cases = 0
  fc.assert(
    fc.property(requestArb, (request) => {
      cases++
      const diffs = getEditDiffs(request)
      const metadata = metadataOf(request)

      // Whatever is shown always carries a diff body.
      for (const entry of diffs) expect(entry.diff.trim().length).toBeGreaterThan(0)

      const entries = Array.isArray(metadata.files) ? metadata.files : []
      const records = entries.filter(isRecord)
      const everyFileHasPatch =
        request.permission === "edit" &&
        metadata.explainBeforeEdit === true &&
        Array.isArray(metadata.files) &&
        records.length === entries.length &&
        records.length > 0 &&
        records.every((item) => typeof item.patch === "string" && item.patch.trim().length > 0)

      if (everyFileHasPatch) {
        // One diff per file, in the proposal's own order, with matching paths.
        expect(diffs.length).toBe(records.length)
        records.forEach((item, index) => {
          const expectedPath =
            typeof item.relativePath === "string" && item.relativePath.trim()
              ? item.relativePath
              : typeof item.filePath === "string"
                ? item.filePath
                : ""
          expect(diffs[index].path).toBe(expectedPath)
          expect(diffs[index].diff).toBe(item.patch as string)
        })
      } else {
        // Never a subset of the per-file diffs: either the single combined
        // diff, or nothing at all.
        expect(diffs.length).toBeLessThanOrEqual(1)
        if (diffs.length === 1) {
          expect(diffs[0].diff).toBe(metadata.diff as string)
        }
      }
    }),
    { numRuns: 500 },
  )
  report("R8 invariant", cases)
})

# P4B Traceability

Name: Rashid Al-Kubaisi
Andrew ID: ralkubai
Team: Four Loop

**Target feature:** Explain Before Edit — the terminal review of multi-file
`apply_patch` proposals. My P4A focus was Satisfaction: whether the explanation
and the review screen give the reviewer enough to decide with confidence.

The logic that decides what the reviewer is shown and which decisions they may
take lives in
[`packages/tui/src/routes/session/edit-review.ts`](../packages/tui/src/routes/session/edit-review.ts)
(`getEditReview`, `editReviewOptions`, `selectEditReviewOption`, `getEditDiffs`),
rendered by
[`edit-explanation.tsx`](../packages/tui/src/routes/session/edit-explanation.tsx)
and [`permission.tsx`](../packages/tui/src/routes/session/permission.tsx).
The proposals themselves come from
[`apply_patch.ts`](../packages/opencode/src/tool/apply_patch.ts).

**Property test file:**
[`packages/tui/test/permission/ralkubai-edit-review.property.test.ts`](../packages/tui/test/permission/ralkubai-edit-review.property.test.ts)

Evidence IDs refer to my P4A interview notes: **C** = Abdulrahman Al-Marri
(classmate), **S** = Jeremy Ru (course staff), **O** = the CS student outside the
course who uses Copilot and ChatGPT.

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4B? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | S-1, S-2, C-11 | No file is modified until the explanation has been shown and the user has explicitly approved the change. | Given a pending multi-file patch, when the proposal is generated, then no file on disk changes and the review screen shows the explanation with approve and reject controls. | No | For any proposal that reaches the explained review, Reject is always on offer and a standing "Allow always" never is, so every proposal needs its own decision (**invariant**) | `R1: an explained proposal never offers a standing allow, and reject is always available` |
| R2 | S-7, S-10, C-8, O-8 | **Revised.** The review displays the path of every file the proposal touches alongside the explanation, so the reviewer can see what is affected without opening each diff. | Given a patch touching `src/auth.ts` and `src/session.ts`, when the review renders, then both paths are displayed with the explanation. | **Yes** — feasibility | Covered by the file-listing property for R3; no separate property. | — |
| R3 | C-2, C-9, O-4 | **Revised.** The review lists every file the proposal touches and no others, each exactly once. | Given a patch touching `src/display.ts` and `src/storage.ts` from a request about display only, when the review renders, then both paths appear, neither appears twice, and no path appears that the patch does not touch. | **Yes** — checkability | Every listed name is non-blank, unique, and traceable to an entry the proposal supplied or to the single-file fallback; and every entry with a usable name is listed (**invariant**) | `R3: the listed files are exactly the proposal's own files, deduplicated and never blank` |
| R4 | C-3, C-4, O-3 | **Revised.** When a proposal's explanation is missing, blank, or longer than the review limit, the review shows no explanation text, states the problem, and offers only Reject. | Given a proposal whose explanation is blank, when the review renders, then the explanation area is empty, a problem message tells the reviewer to reject, and Accept and Reject-with-feedback are not offered. Given one of 4000 characters after trimming, the same proposal is accepted as valid. | **Yes** — feasibility | The validity decision agrees with a direct statement of the rule (non-blank after trimming, at most 4000 characters) for every generated explanation, and an invalid one collapses the options to Reject only (**model / oracle**) | `R4: explanation validity matches the plain rule, and an invalid one offers only Reject` |
| R5 | S-5, C-5, C-6, O-5, O-6 | Cancelling the rejection-feedback form leaves the proposal pending and submits nothing. | Given a pending proposal and partially typed rejection text, when the user cancels the form, then the proposal is still pending, no rejection is recorded, and no file has changed. | No | A decision key is accepted if and only if the review actually offered it, and an accepted one round-trips to itself; anything else yields no decision at all (**round-trip**) | `R5: a decision round-trips iff it was offered, and anything else yields nothing` |
| R6 | C-6 | **Revised.** Cancelling the rejection-feedback form discards the unsubmitted draft and returns the review to its pre-feedback state. | Given a user typed "wrong file" and cancelled, when they reopen the rejection form, then the field is empty and the proposal is still pending. | **Yes** — conflict | Not implemented; no property. | — |
| R7 | S-6, C-7, O-7 | For a fixed proposal, changing only the explanation text does not change the list of target files, the proposed diffs, or the approval state. | Given one proposal rendered with two different explanation texts, when both render, then the target file list, the per-file diffs, and the pending approval state are identical in both. | No | Rewording the explanation of a fixed proposal leaves the file list, the per-file diffs, the problem state and the offered decisions byte-identical; only the explanation text differs (**metamorphic**) | `R7: rewording the explanation changes nothing but the explanation` |
| R8 | S-8, S-9, C-10, O-10 | **Revised.** The review provides one diff per file when every file in the proposal carries its own patch, and otherwise falls back to the single combined diff rather than showing a subset. | Given a proposal whose three files each carry a patch, the review shows three diffs with matching paths in the proposal's order. Given a proposal where one file's patch is missing, it shows the combined diff or nothing — never two of the three. | **Yes** — checkability | Every diff shown carries a non-empty body; when every file has a patch there is exactly one diff per file with matching path and order; otherwise at most the combined diff (**invariant**) | `R8: diffs are per-file or the combined fallback, never a partial subset` |

Properties and generators were drafted with Claude's help: all six. I reviewed
each one, ran them, and then deliberately broke the source four separate ways to
confirm each property actually fails when the behaviour it describes is wrong
(see Triage below). I am responsible for every property being correct and tied
to a real requirement.

## Requirement changes

| ID | Original (P4A) | Why it can't be built as written | What the user actually needed | Revised (P4B) |
|---|---|---|---|---|
| R2 | Every explanation names the file path and the affected function or line range for each change, and includes a stated problem and a stated reason for the fix. | **Feasibility.** The explanation is free text written by a model. There is no structured problem or reason field anywhere in the review, and nothing can force a model's prose to contain a line range. Requiring it would mean inventing fields the feature does not have and still could not fill reliably. | S-7 and C-8 wanted to know *where* a change lands without reading the whole diff; O-8 wanted the problem and the fix stated. The "where" is the part the interface itself can guarantee. | The review displays the path of every file the proposal touches alongside the explanation, so the reviewer can see what is affected without opening each diff. |
| R3 | The explanation covers every file the patch touches, with a stated reason for each file beyond the one the user asked about. | **Checkability.** "A stated reason for each file" is model-written prose. A test can confirm text exists, but not that it is a reason, or that it is the right one — so the requirement cannot be judged pass or fail. | C-2 and O-4 were worried about a change being made to a file they did not ask about and never being told. The actionable half is that no touched file is hidden and no untouched file is implied. | The review lists every file the proposal touches and no others, each exactly once. |
| R4 | The review displays a verification status taken from recorded test results: "Not tested", "Failed", "Passed". | **Feasibility.** Nothing in the review pipeline runs tests or receives test results — there is no such data to display. Building it would mean adding a test-execution and result-reporting path, which is a different feature. | C-3 and C-4 did not want a proposal to look more trustworthy than it is; O-3 did not want to be told something is safe when the system does not know. | When a proposal's explanation is missing, blank, or longer than the review limit, the review shows no explanation text, states the problem, and offers only Reject. |
| R6 | Reopening the rejection form for the same pending proposal restores its unsubmitted draft text. | **Conflict.** C-6 asked for the draft to be kept. S-5 expected the opposite — "return the prompt and text to the original state that I submitted before this" — and O-6 was indifferent. Both C-6 and S-5 made it into the P4A table, and they cannot both hold. | All three agreed on the part that actually mattered: cancelling must not submit anything and must leave the proposal pending. That is R5, and it is unaffected. On the draft itself, two of three pointed at discarding, and keeping a draft risks showing stale text against a later proposal. | Cancelling the rejection-feedback form discards the unsubmitted draft and returns the review to its pre-feedback state. |
| R8 | The explanation and the per-file diff are viewable together without leaving the review screen, with added and removed lines marked. | **Checkability.** Added and removed lines are marked by the terminal theme rendering ordinary patch text; the review does not decide it, and a property over this module cannot observe it. | S-8, C-10 and O-10 wanted to compare the explanation against what actually changed, per file, without losing track of a file. The reviewable guarantee is that the per-file breakdown is complete or honestly absent. | The review provides one diff per file when every file in the proposal carries its own patch, and otherwise falls back to the single combined diff rather than showing a subset. |

R1, R5 and R7 are unchanged. R1 and R5 describe behaviour the feature already
has and that can be observed. R7 was already narrowed during P4A, for the same
reason R2 and R3 are narrowed here: the interface can guarantee that rewording
changes nothing structural, but not that two wordings mean the same thing.

## Test scope

These properties run against the real review logic with generated proposal
metadata. They check what the review displays and which decisions it offers.
They do not call a model and do not assert that any explanation is factually
correct — that distinction is the reason five of the eight requirements were
revised.

Generators aim at the boundaries the interviews pointed to, rather than at
random strings:

- File lists run 0–4 entries drawn from a small pool of paths, so duplicates and
  near-duplicates are common. C-2 and S-3 were both about multi-file patches.
- Blank and whitespace-only paths, rename (`move`) entries, and non-record junk
  entries are generated deliberately, because each takes a different branch of
  the file-name logic.
- Explanation lengths are drawn from 3998 to 4002 characters, straddling the
  4000-character limit exactly, plus blank, whitespace-only and non-string
  values.
- Patch bodies are sometimes blank, because `getEditDiffs` may only use the
  per-file diffs when every file has one.

## Triage

All six properties passed on the first run (5,523 generated assertions across
the file). Because a property that checks nothing also passes, I then broke the
source four ways and confirmed the right property failed each time:

| Deliberate bug | Property that caught it |
|---|---|
| Removed the de-duplication of the file list | R3 |
| Changed the length check from `>` to `>=`, so an explanation of exactly 4000 characters is rejected | R4 |
| Added a standing "Allow always" option to explained proposals | R1 (and R4, whose option set also tightened) |
| Let the per-file diffs render when per-file metadata is incomplete, showing a subset | R8 |

The 4000-character mutation is the useful one: it only fails if the generator
actually produces an explanation of exactly that length, which confirms the
boundary is being reached rather than approximated.

Each property prints a named line with its generated-case count after it
passes. `packages/tui` runs `bun test --only-failures`, which suppresses the
names of passing tests, so without this the GitHub Actions log would not show
that these properties ran at all:

```
[P4B ralkubai] R1 invariant: 500 generated cases passed
[P4B ralkubai] R3 invariant: 500 generated cases passed
[P4B ralkubai] R4 model/oracle: 500 generated cases passed
[P4B ralkubai] R5 round-trip: 500 generated cases passed
[P4B ralkubai] R7 metamorphic: 500 generated cases passed
[P4B ralkubai] R8 invariant: 500 generated cases passed
```

No property failed against the real implementation, so there was no code fix or
requirement change arising from Step 3. The requirement changes above all come
from Step 1.

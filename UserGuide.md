# Four Loop User Guide: Explain-Before-Edit

This guide covers the explain-before-edit feature our team added to opencode. When it's on, the AI has to explain every file change it wants to make, and you approve or reject each one before anything touches your files.

Each teammate owns one section below.

---

## Write tool explanations (Hassan, issue #12, PR #16)

### What it does

The `write` tool is what opencode uses to create a new file or replace a whole file. With explain-before-edit turned on, every write now comes with a short explanation of what's changing and why. You see that explanation together with the diff, and the file is only written if you approve it. If you reject, nothing changes on disk.

### How to turn it on

Add this to `opencode.json` in your project root (create the file if it isn't there):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "explain_before_edit": true
}
```

If you leave it out or set it to `false`, the write tool works exactly like before and no explanation is needed.

### How to user test it

From the repo root, in the devcontainer:

1. Add the config above to `opencode.json`.
2. Run `bun dev` to start opencode.
3. **Create a new file:** ask something like
   `Create a file called hello.txt that says hi`
   - You should get a permission prompt for the edit before `hello.txt` exists.
   - The request carries an explanation of the change plus the diff.
   - Check in another terminal that `hello.txt` does NOT exist yet.
   - Approve it. Now `hello.txt` exists with `hi` in it.
4. **Overwrite an existing file:** ask
   `Replace everything in hello.txt with bye`
   - Reject the prompt.
   - Open `hello.txt`. It should still say `hi`.
5. **Approve an overwrite:** ask the same thing again and approve. Now it says `bye`.
6. **Feature off:** set `"explain_before_edit": false`, restart `bun dev`, and ask for a new file. It should work like normal opencode with no explanation needed.

> Note: showing the explanation nicely in the terminal UI is a separate issue (#10). Until that lands, the explanation is attached to the permission request metadata, and the automated tests below are the most reliable way to confirm it's there.

### Automated tests

**Where:** `packages/opencode/test/tool/write-tool-explanation.test.ts`

**Run them:**

```bash
cd packages/opencode
bun test test/tool/write-tool-explanation.test.ts
```

There are 19 tests. They run the real write tool together with the real config and permission services on a temp directory, so they test the actual path a write takes, not mocks of it. Every behavior test runs twice, once for a brand new file and once for an existing file.

| What's tested | Why it matters |
| --- | --- |
| Explanation (trimmed) and diff reach the permission request, and the file is still untouched at that point. Approving then writes it. | The core promise: you see the explanation before anything changes. |
| Rejecting leaves the file exactly as it was (or still missing, for a new file). | Rejecting has to actually protect your files. |
| Missing, blank, or too long (over 4000 chars) explanation blocks the write. | The AI can't skip the explanation or dodge it with an empty one. |
| A configured `deny` rule still blocks the write. | Our feature doesn't weaken existing permission rules. |
| With the setting off or not set, writes without an explanation still work. | Nobody who doesn't opt in gets their workflow broken. |
| Cancelling a pending write leaves the file unchanged. | Stopping mid approval is safe. |
| The tool schema shows `explanation` as an optional string and rejects non strings. | The AI is told the right input shape and bad input gets caught early. |

**Why this is enough:** each acceptance criterion from issue #12 maps to at least one test (see the PR for the exact mapping). Both the create and overwrite paths are covered for every rule, plus the edge cases most likely to break things: bad explanations, rejection, cancelling, deny rules, and the feature being off. The existing `test/tool/write.test.ts` suite (15 tests) still passes, which shows normal write behavior didn't regress, and the package typecheck passes too.


---

## Approval policy and terminal review (Mohammed, issues #6 and #10)

### Purpose and scope

Explain-before-edit adds a review step to supported `edit`, `write`, and `apply_patch` proposals.
The explanation describes what the agent proposes and why; the diff shows the code it actually intends to change.
This is an opportunity to review, not a guarantee that the explanation or implementation is correct.
It is not a general sandbox for arbitrary shell commands, plugins, or other tools.

### Enable it

In the project being edited, add `"explain_before_edit": true` to its `opencode.json`.
Preserve the file's existing settings. A minimal configuration is:

```json
{
  "explain_before_edit": true
}
```

Restart the development instance after changing this setting. Omitted or false uses normal permissions.
An effective deny rule still blocks an edit. Otherwise, supported edits require a nonblank string explanation,
at most 4,000 characters after trimming, and a separate approval for each proposal.

### Run our checkout

After installing dependencies with `bun install --frozen-lockfile`, run from the repository root:

```bash
bun run dev /absolute/path/to/a/disposable/project
```

Use the team's configured provider through the normal OpenCode setup. Do not commit an API key.
The requested project directory should contain its own opencode.json and harmless sample files.

### Review a proposal

The protected permission dialog shows “Why this change?”, the affected files, and the proposed diff(s).
For a multi-file patch, one approval covers the complete proposal; it is not one approval per line.
The file listing identifies both source and destination for a move when that metadata is provided.

Choose Accept change to send `once`, or Reject to send `reject`. There is no Allow always option for protected proposals.
Use the mouse, or left/right (also h/l) and Enter. Escape rejects; existing subagent rejection feedback is retained.
Use the displayed fullscreen shortcut and the scroll area to review long content.

An invalid explanation normally causes a tool error before any approval screen is created. The backend does not
regenerate explanations or guarantee a retry. A later corrected tool proposal can be reviewed separately.
Defensive UI handling shows a problem and offers only Reject if malformed protected metadata nevertheless reaches it.
Rejecting does not undo already completed edits; the current backend can also reject other pending requests in the same session.

### Manual user test

Use a temporary project with greeting.ts returning Hi. Ask the edit tool to change it to Hello.
Check the explanation and diff. While waiting, read the file in another terminal: it must still return Hi.
Accept and check Hello. Repeat a different change and reject: its original contents must remain.

Also test creating a file with write (it must not exist before approval), rejecting an overwrite,
and accepting/rejecting a multi-file apply_patch proposal. Check the actual tool used.
Try two consecutive proposals and narrow/expanded layouts, ensuring the explanation never belongs to a previous request.
Repeat with the feature disabled and verify the ordinary permission workflow.

### Automated tests

From the repository root:

```bash
cd packages/tui
bun test --timeout 30000 ./test/permission
bun run typecheck
bun run test
cd ../opencode
bun test --timeout 30000 \
  ./test/config/explain-before-edit.test.ts \
  ./test/tool/edit-explanation.test.ts \
  ./test/permission/explain-before-edit.test.ts
cd ../..
```

The backend test files cover setting validation and disabled/omitted behavior, explanation types/blankness/length,
deny precedence, individual approval, rejection, cancellation, and protection from remembered/bulk approval.

The UI test files are:
- `packages/tui/test/permission/edit-review.test.ts`: 33 helper scenarios covering markers, invalid metadata,
  the 4,000-character boundary, allowed responses, multi-file/move labels, safe diff fallbacks, and changing metadata.
- `packages/tui/test/permission/edit-explanation.test.tsx`: 7 OpenTUI rendering scenarios covering explanation/file text,
  problems, legacy requests, replacement/removal of stale text, multiple files, and narrow wrapping.

The UI helper tests do not alone verify the full dialog's SDK connection, keyboard/mouse handling, or scrolling.
Manual checks above and the combined backend/tool tests cover those additional boundaries.
The new `@opencode-ai/tui#test` Turbo task includes TUI tests in CI. Before final integration, run:

```bash
bun run typecheck
GITHUB_ACTIONS=false bun turbo test --concurrency=4
```

### Verification evidence

The terminal UI was verified with both automated and manual testing.

- Permission UI tests: 40 passed, 0 failed.
- Full TUI test suite: 233 passed, 1 skipped, 0 failed.
- TUI typecheck passed.
- Manual end-to-end testing used a buggy Dijkstra implementation. Before approval, the source file remained unchanged. After accepting the proposed edit, the program returned the correct shortest-path result of 3 instead of 101.
- GitHub Actions `test` and `typecheck` both passed on PR #18.

These checks cover explanation rendering, protected approval choices, malformed metadata, multi-file changes, consecutive requests, and normal unprotected behavior.

---

## Reject with feedback

Explained edit reviews now offer **Reject with feedback** alongside **Accept change** and
**Reject**. Use it to tell the agent what to change in its next proposal, for example:
“Keep the existing function name and change only the greeting.” This extends the edit tool's
explanation support from issue #11 / PR #15 using the existing permission feedback channel.

### How to use it

1. Set `"explain_before_edit": true` in the project’s `opencode.json` and restart OpenCode.
2. Ask for an edit and check the actual tool call, explanation, affected files, and diff.
3. Select **Reject with feedback** using the mouse or left/right followed by Enter.
4. Enter your correction and press Enter. The proposed edit is rejected; the agent receives
   your feedback. Leading and trailing whitespace is removed.
5. Review any revised proposal separately. Feedback never approves the original or revised edit.

Escape in the feedback form cancels the form and returns to the pending review without sending
feedback or a decision. Submitting an empty or whitespace-only form behaves like plain Reject.
Plain Reject and Escape in the main review keep their existing behavior. Invalid protected
proposals still offer only Reject. Ordinary permissions with the feature disabled keep their
existing options; subagent rejection feedback remains available.

### Manual user test

Use a disposable project with `greeting.txt` containing `Hi` and the feature enabled. Choose a
configured model that exposes the `edit` tool; model IDs containing `gpt-` but neither `gpt-4`
nor `oss` use `apply_patch` instead.

Ask: “Read greeting.txt and use edit to change Hi to Hello. Explain why.”

- While the proposal waits, confirm the file still contains `Hi`.
- Open **Reject with feedback**, type a draft, then press Escape. The original review should
  return, and the file should still contain `Hi`.
- Open it again and submit: “Use Welcome instead of Hello. Propose a new edit and wait for approval.”
- Confirm the rejected proposal leaves `Hi` unchanged. If the agent proposes `Hi` → `Welcome`,
  verify it has a fresh explanation and review. Accept it and confirm the file contains `Welcome`.
- Repeat with plain Reject and with the feature disabled to check the existing workflows.

The agent may respond to feedback with a revised proposal or a question; a retry is not guaranteed.
Rejection does not undo earlier accepted edits and can also reject other pending requests in the
same session. This feature does not protect shell commands or unrelated tools.

### Automated tests and coverage

From the repository root:

```bash
cd packages/tui
bun test --timeout 30000 ./test/permission
bun typecheck
cd ../opencode
bun test --timeout 30000 ./test/tool/edit-tool-explanation.test.ts ./test/permission/explain-before-edit.test.ts
bun typecheck
```

[`reject-feedback.test.tsx`](packages/tui/test/permission/reject-feedback.test.tsx) renders the
actual permission dialog and exercises its keyboard controls and SDK replies with a test HTTP
transport. It checks trimmed feedback, plain rejection, blank input, cancellation, narrow
layout, and clearing a draft when a new request arrives.
[`edit-review.test.ts`](packages/tui/test/permission/edit-review.test.ts) checks that feedback is
available only for valid protected reviews and never grants approval.
[`edit-tool-explanation.test.ts`](packages/opencode/test/tool/edit-tool-explanation.test.ts) uses
the real edit tool and permission service to verify feedback delivery, unchanged files after
rejection, and a fresh approval requirement for another proposal on both edit paths.

These checks cover the UI-to-permission reply and permission-to-edit boundaries. The manual
test additionally checks a live model receiving the correction and producing a revised proposal;
automated tests do not establish the quality of the model’s response.

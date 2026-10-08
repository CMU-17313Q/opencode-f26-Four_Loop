# Four Loop User Guide: Explain-Before-Edit

This guide covers the explain-before-edit feature our team added to opencode. When it's on, the AI has to explain every file change it wants to make, and you approve or reject each one before anything touches your files.

Each teammate owns one section below.

---

## Targeted edit explanations (Yousef, issue #11, PR #15)

### What it does

The `edit` tool replaces matching text inside a file. Unlike `write`, it does not require the
agent to send the entire file. This contribution adds an optional `explanation` input and
forwards it with the existing diff to the shared permission service, including the edit tool's
new-file path. The tool instructions ask for a concise description of what changes and why.

With `explain_before_edit` enabled, a supported proposal needs a nonblank explanation of at
most 4,000 characters after trimming. An effective deny rule still blocks the operation.
Otherwise, the proposal waits for its own approval before the edit is applied. These rules
come from the shared backend; the edit tool does not introduce a second approval policy.

### Enable it and choose the tool

Use the team's checkout containing both the edit integration and terminal review UI. In the
project being edited, add `"explain_before_edit": true` to `opencode.json`, preserving existing
settings. Restart OpenCode after changing the setting.

The current tool registry selects editing tools by model ID: IDs containing `gpt-`, but neither
`gpt-4` nor `oss`, use `apply_patch` instead of `edit`/`write`. For this manual test, use a
configured, tool-capable model outside that group and verify that the actual call is `edit`.
A successful patch or shell command is not an edit-tool test. Existing permission rules and
agent mode can also restrict the available tools.

### Manual user test

Use a disposable project, not the team repository. From the repository root, run:

```bash
bun install --frozen-lockfile
DEMO_DIR="$(mktemp -d /tmp/opencode-edit-demo.XXXXXX)"
git -C "$DEMO_DIR" init -q
printf 'Hi\n' > "$DEMO_DIR/greeting.txt"
printf '{"explain_before_edit": true}\n' > "$DEMO_DIR/opencode.json"
printf 'Copy this line into a second terminal:\nDEMO_DIR="%s"\n' "$DEMO_DIR"
bun run dev "$DEMO_DIR"
```

Connect a provider using the normal OpenCode setup and select a model as described above.
Keep API keys out of the repository. The automated tests below do not need a live provider;
manual agent use can consume provider credit.

Ask the agent:

> Read greeting.txt, then use the edit tool to change Hi to Hello. Explain what changes and
> why. Do not use write, apply_patch, or a shell command to modify it. If I reject the proposal,
> stop instead of submitting the change again.

The review should show **Why this change?**, the affected file, the proposed diff, and
**Accept change / Reject**, with no **Allow always** option for this protected proposal.

Copy the printed `DEMO_DIR` assignment into a second terminal, then inspect the file there:

```bash
cat "$DEMO_DIR/greeting.txt"
```

The expected outcomes are:

| Stage | Expected contents of greeting.txt |
| --- | --- |
| Proposal is waiting for a decision | Hi |
| Reject the proposal | Hi |
| Ask again explicitly, then accept the new proposal | Hello |

Check the contents after each decision. An explanation describes the agent's proposed reason;
it is not proof that its proposed change is correct. If several calls are proposed, each
protected call has a separate review. Rejecting does not undo earlier accepted edits and may
also reject other pending requests in the same session.

For the disabled-mode check, exit OpenCode. In the original terminal, change only the setting
in the disposable project's configuration and restart:

```bash
printf '{"explain_before_edit": false}\n' > "$DEMO_DIR/opencode.json"
bun run dev "$DEMO_DIR"
```

Request another targeted edit. Normal allow/ask/deny rules apply; disabling this feature does
not guarantee automatic approval and does not remove an existing deny rule.

### Automated tests

From the repository root:

```bash
cd packages/opencode
bun test --timeout 30000 ./test/tool/edit-tool-explanation.test.ts
bun test --timeout 30000 ./test/tool/edit.test.ts ./test/tool/parameters.test.ts
bun run typecheck
cd ../core
bun run typecheck
cd ../..
```

The focused suite is [`edit-tool-explanation.test.ts`](packages/opencode/test/tool/edit-tool-explanation.test.ts).
It uses the real edit tool, filesystem, configuration, and permission service. External
account/authentication and package/network dependencies use test fixtures.

| Coverage | Reason for the check |
| --- | --- |
| Explanation and diff arrive before modification; approval applies the change | Verifies the tool-to-permission connection and review-before-edit ordering. |
| Existing-file and new-file paths | Neither edit path should omit the explanation or bypass review. |
| Rejection and cancellation preserve the target | A waiting or rejected edit must not be applied. |
| Missing, blank, and over-limit explanations | Enabled mode must enforce the backend's input requirements. |
| Configured deny rules | An explanation must not override a forbidden operation. |
| Disabled and omitted configuration | Existing calls without an explanation remain compatible. |
| Optional string schema and rejection of a non-string value | Checks the model-facing input shape and decoding. |

The existing [`edit.test.ts`](packages/opencode/test/tool/edit.test.ts) suite checks the edit
implementation beyond this feature. [`parameters.test.ts`](packages/opencode/test/tool/parameters.test.ts)
checks the tool schemas, including the saved explanation-field snapshot.

### Coverage rationale and limits

These tests exercise every acceptance criterion in issue #11: explanation forwarding,
approval-before-modification, rejection, and compatibility with the feature disabled. Both
file paths and the main failure cases are covered, with existing edit tests and typechecks
providing regression checks. The manual steps above additionally exercise the model, tool,
backend, and terminal screen together.

The automated tests supply explanation text themselves. They do not establish that a live
model always chooses `edit` or gives a correct explanation. Missing or invalid explanations
can fail before a review screen appears; the backend does not guarantee an automatic retry.
This feature is not a sandbox for shell commands or unrelated tools.

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

---

## Patch proposal explanations (Rashid, issue #14, PR #17)

### What it does

The `apply_patch` tool applies a structured patch that can create, update, delete, or move files.
This contribution adds an optional `explanation` input beside `patchText` and forwards it with
the existing diff and affected-file metadata to the shared permission service. The explanation
is separate from the patch syntax; the patch parser and application logic are reused.

With `explain_before_edit` enabled, the backend requires a nonblank explanation of at most
4,000 characters after trimming and approval of the complete proposal. **One decision covers
one patch proposal**, even when it affects several files; there is no per-line or per-file
acceptance within that proposal. Denials evaluated by the permission service remain enforced.

### Enable it and choose the tool

Use the team's checkout containing both the patch integration and terminal review UI. In the
project being edited, add `"explain_before_edit": true` to `opencode.json`, preserving existing
settings. Restart OpenCode after changing the setting.

In the current [`tool registry`](packages/opencode/src/tool/registry.ts), `apply_patch` is
selected for model IDs containing `gpt-`, but neither `gpt-4` nor `oss`. Other model IDs normally
receive `edit`/`write` instead. For this manual test, use a configured, tool-capable model in
the patch-enabled group and check its current provider pricing before use. Permission rules
and agent mode can also restrict tools. Asking for `apply_patch` does not make an unavailable
tool appear; a run using `edit` or shell commands does not verify the patch integration.

The automated tests below invoke the patch tool directly and do not need a live model or API credit.

### Manual user test

Use only disposable files for the delete/move example. From the repository root, run:

```bash
bun install --frozen-lockfile
DEMO_DIR="$(mktemp -d /tmp/opencode-patch-demo.XXXXXX)"
git -C "$DEMO_DIR" init -q
printf 'old\n' > "$DEMO_DIR/modify.txt"
printf 'obsolete\n' > "$DEMO_DIR/delete.txt"
printf 'original\n' > "$DEMO_DIR/original.txt"
printf '{"explain_before_edit": true}\n' > "$DEMO_DIR/opencode.json"
printf 'Copy this line into a second terminal:\nDEMO_DIR="%s"\n' "$DEMO_DIR"
bun run dev "$DEMO_DIR"
```

Connect a provider using the normal OpenCode setup and choose a model as described above.
Do not commit provider credentials. Ask the agent:

> Read the sample files, then use ONE apply_patch call to create nested/new.txt containing
> created, change modify.txt from old to new, delete delete.txt, and move original.txt to
> moved.txt while changing its contents from original to moved. Include one explanation
> covering all four operations. Do not modify opencode.json or use edit, write, or shell
> commands to change files. If I reject, stop instead of submitting the patch again.

The protected review should show the explanation, affected files, and the proposed diffs,
with **Accept change / Reject** and no **Allow always**. Inspect both ends of the move and
review all files before deciding. Use the displayed fullscreen shortcut and scroll area as needed.

Copy the printed `DEMO_DIR` assignment into a second terminal. Run this inspection command
while the proposal is pending and again after each decision:

```bash
for name in modify.txt delete.txt original.txt nested/new.txt moved.txt; do
  printf '\n%s: ' "$name"
  if test -f "$DEMO_DIR/$name"; then
    cat "$DEMO_DIR/$name"
  else
    printf '(missing)\n'
  fi
done
```

Reject the first proposal. Then explicitly ask again and accept the new proposal. The expected
file state is:

| File | While waiting / after Reject | After Accept |
| --- | --- | --- |
| modify.txt | old | new |
| delete.txt | obsolete | Missing |
| original.txt | original | Missing |
| nested/new.txt | Missing | created |
| moved.txt | Missing | moved |

If the agent splits the task into several calls, review each call separately and record that
this was not the one-proposal scenario. Rejection does not undo a previously accepted patch
and may also reject other pending requests in the same session.

To check disabled mode, exit OpenCode and, in the original terminal, restart with the setting off:

```bash
printf '{"explain_before_edit": false}\n' > "$DEMO_DIR/opencode.json"
bun run dev "$DEMO_DIR"
```

Ask for a small patch to modify.txt. The normal permission workflow should apply. Existing
deny rules still matter, and an ordinary permission prompt may still appear.

### Automated tests

From the repository root:

```bash
cd packages/opencode
bun test --timeout 30000 ./test/tool/apply-patch-explanation.test.ts
bun test --timeout 30000 ./test/tool/apply_patch.test.ts ./test/tool/parameters.test.ts
bun run typecheck
cd ../core
bun run typecheck
cd ../..
```

The focused suite is [`apply-patch-explanation.test.ts`](packages/opencode/test/tool/apply-patch-explanation.test.ts).
It exercises the real patch tool, filesystem, configuration, and permission service, using
fixtures for external account/authentication and package/network dependencies.

| Coverage | Reason for the check |
| --- | --- |
| One explanation, file metadata, and diff accompany an add/update/delete/move proposal | Verifies the complete proposal reaches the approval boundary. |
| No target changes while waiting; approval applies the expected file changes | Checks ordering and the successful multi-file result. |
| Rejection and cancellation preserve all sample targets | Verifies the unapproved proposal is not applied. |
| Missing, blank, and over-limit explanations | Enabled mode must enforce the backend's input requirements. |
| Denying delete.txt blocks the sample proposal | Checks a denied affected path stops the proposal before application. |
| Disabled and omitted configuration | Calls containing only patchText remain compatible. |
| Malformed, empty, and unapplicable patches | Checks these validation failures leave the sample targets unchanged. |
| Separate patchText and optional explanation fields; non-string rejection | Checks schema compatibility and input decoding. |

The existing [`apply_patch.test.ts`](packages/opencode/test/tool/apply_patch.test.ts) suite
provides additional patch regression coverage, while
[`parameters.test.ts`](packages/opencode/test/tool/parameters.test.ts) checks the model-facing schemas.

### Coverage rationale and limits

The focused cases cover issue #14's explanation forwarding, waiting, approval, rejection,
and disabled-mode requirements, plus multi-file and error cases. Existing patch tests and
package typechecks provide additional regression checks. The manual steps exercise the
model-to-tool-to-screen interaction that the tool tests do not run.

The tests provide explanation text directly; they do not establish its factual quality or
live-model reliability. The denied-path case above is not exhaustive permission coverage
for every source/destination combination. One approval for a patch is not a transactional
rollback guarantee if filesystem operations fail after approval. This feature also does
not govern arbitrary shell commands or unrelated tools.

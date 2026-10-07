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

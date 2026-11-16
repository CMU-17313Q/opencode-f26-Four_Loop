# P4B Traceability

Name: Hassan Al Qassabi
Andrew ID: haq
Team: Four Loop

Target feature: explain before edit for the write tool (`packages/opencode/src/tool/write.ts`). when its on, the AI has to explain what its changing and why before it creates or overwrites a file, and the file only gets written if I approve it.

Property test file: `packages/opencode/test/tool/write-tool-explanation.property.test.ts`

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Changed in P4B? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-3, S-2 | When explain before edit is on, the write tool doesnt change the file until I approve it. | Ask the AI to overwrite hello.txt that says hi. While the approval prompt is open hello.txt still says hi. After I approve it has the new content. | No | For any old file (or no file) and any new content, while the prompt is open the file is byte for byte the same, and after approving it matches the expected content (invariant) | `R1/R4 property: nothing changes before approval and the prompt has path, explanation and diff` |
| R2 | C-5, C-6, S-4, O-5 | Rejecting or cancelling a write leaves the file exactly how it was, and a rejected new file is never created. | Reject an overwrite of hello.txt and it still says hi. Reject creating new.txt and new.txt doesnt exist. Cancel the prompt halfway and hello.txt still says hi, nothing half written. | No | Propose a write then reject it, the file goes back to exactly how it started or still doesnt exist (round-trip). Same thing for cancelling while the prompt is open (round-trip) | `R2/R6 property: reject round-trips the file back to how it was`, `R2 property: cancelling while the prompt is open round-trips the file` |
| R3 | C-8, S-6, O-3 | A write with a missing, blank, or too long (over 4000 characters after trimming) explanation is blocked. | With the feature on, a write with no explanation, an explanation of "" or just spaces, or one longer than 4000 characters after trimming returns an error, no approval prompt shows up, and hello.txt still says hi. | Yes | The validator agrees with a simple version of the rule for any value (model/oracle). For any file and any bad explanation the write errors, no prompt, file unchanged (invariant) | `R3 property: explanation validation matches the simple rule`, `R3 property: bad explanations never reach the prompt or the file` |
| R4 | C-7, C-9, S-5, O-2 | The approval prompt shows the explanation together with the diff and the file path. | When the AI asks to overwrite hello.txt, the approval request has the explanation, the path to hello.txt, and the diff with the new content. | No | The prompt always has the path, the trimmed explanation and a diff (invariant). Same change with different explanation wording gives the exact same path and diff (metamorphic) | `R1/R4 property: nothing changes before approval and the prompt has path, explanation and diff`, `R4 property: rewording the explanation doesnt change the diff or path` |
| R5 | C-11 | When the feature is off, the write tool works like normal without an explanation. | With explain_before_edit set to false, writing hello.txt with no explanation works and the file gets the new content. | No | With the feature off and no explanation, the file ends up exactly like a simple model of a normal write (BOM kept if either side had one) and no prompt is made (model/oracle) | `R5 property: with the feature off writes behave like the plain model` |
| R6 | C-4, S-3 | When I reject a write, the write tool returns a rejected error to the agent instead of a success. | Reject an overwrite of hello.txt. The write tool returns a rejected error to the agent instead of a success, and hello.txt still says hi. | Yes | Checked inside the reject round-trip: every rejected write ends in a RejectedError and the file is unchanged (round-trip) | `R2/R6 property: reject round-trips the file back to how it was` |
| R7 | O-4 | My permission rules still win when explain before edit is on. If edit is denied for a file, the write is denied without asking me. | With explain_before_edit on and edit set to deny for secret.txt, asking the AI to write secret.txt fails right away, no approval prompt shows up, and secret.txt doesnt change. | No | For any file, content and even a good explanation, a deny rule always gives DeniedError, no prompt, file unchanged (invariant) | `R7 property: a deny rule always wins over explain before edit` |

AI-suggested properties: all 8 properties in the test file were drafted with help from an AI assistant (the generators and the BOM oracle too). I went through each one, ran them, and checked they fail when the write tool is broken on purpose (writing the file before asking), so I'm responsible for them.

## Requirement changes

| ID | Original | Revised | Why |
|---|---|---|---|
| R3 | A write with a missing or blank explanation is blocked. | A write with a missing, blank, or too long (over 4000 characters after trimming) explanation is blocked. | Checkability. O-3 said explanations should be short ("like 2 or 3 lines"), but "short" cant be checked automatically and a line count doesnt work since one line can be huge. The tool already enforces a 4000 character cap after trimming, so I made that the checkable version of the "not an essay" need. The user need (a real explanation, not empty and not a wall of text) stays the same and still traces to C-8, S-6 and O-3. |
| R6 | When I reject a write, the tool ends with a rejected error so the AI knows I said no and doesnt act like it was approved. | When I reject a write, the write tool returns a rejected error to the agent instead of a success. | Feasibility and checkability. The write tool cant control what the AI does after a rejection (like trying again through the terminal, which C-4 and S-3 worried about). That part is only an instruction in write.txt and depends on the model, so it cant be tested. What the tool can guarantee is that the agent gets a RejectedError and not a success, so the requirement now only covers that. The need (the AI is clearly told no) still traces to C-4 and S-3. |

## Triage

All properties passed on the first run, so there were no failures to triage. I ran them a few times with different seeds and they kept passing.

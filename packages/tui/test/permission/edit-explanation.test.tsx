/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { EditExplanation } from "../../src/routes/session/edit-explanation"
import { getEditReview, type EditReviewRequest } from "../../src/routes/session/edit-review"

function request(explanation: unknown = "Add a guard in average() to handle an empty list."): EditReviewRequest {
  return { permission: "edit", metadata: { explainBeforeEdit: true, explanation, filepath: "src/average.ts" } }
}

test("renders the explanation and affected file", async () => {
  const app = await testRender(() => <EditExplanation review={getEditReview(request())} />)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Why this change?")
    expect(frame).toContain("average()")
    expect(frame).toContain("src/average.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("renders a clear problem for missing explanation metadata", async () => {
  const app = await testRender(() => <EditExplanation review={getEditReview(request(null))} />)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("no valid explanation")
  } finally {
    app.renderer.destroy()
  }
})

test("does not add the explanation block to legacy requests", async () => {
  const app = await testRender(() => <EditExplanation review={getEditReview({ permission: "edit", metadata: {} })} />)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Why this change?")
  } finally {
    app.renderer.destroy()
  }
})

test("changing the request replaces the previous explanation", async () => {
  const [value, setValue] = createSignal(request("FIRST-PROPOSAL explanation."))
  const app = await testRender(() => <EditExplanation review={getEditReview(value())} />)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("FIRST-PROPOSAL")
    setValue(request("SECOND-PROPOSAL explanation."))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("SECOND-PROPOSAL")
    expect(app.captureCharFrame()).not.toContain("FIRST-PROPOSAL")
  } finally {
    app.renderer.destroy()
  }
})

test("wraps a paragraph inside a narrow content region", async () => {
  const message =
    "Add an empty list guard before division so the average calculation returns the requested default value."
  const app = await testRender(() => (
    <box width={32}>
      <EditExplanation review={getEditReview(request(message))} />
    </box>
  ))
  try {
    await app.renderOnce()
    const text = app.captureCharFrame().replace(/\s+/g, " ")
    expect(text).toContain(message)
  } finally {
    app.renderer.destroy()
  }
})

test("renders all affected files including both ends of a move", async () => {
  const input: EditReviewRequest = {
    permission: "edit",
    metadata: {
      explainBeforeEdit: true,
      explanation: "Move the helper and update its caller.",
      files: [
        { filePath: "old.ts", movePath: "new.ts", type: "move" },
        { relativePath: "caller.ts", type: "update" },
      ],
    },
  }
  const app = await testRender(() => <EditExplanation review={getEditReview(input)} />)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("old.ts -> new.ts")
    expect(frame).toContain("caller.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("switching to a legacy request removes the previous explanation block", async () => {
  const [value, setValue] = createSignal<EditReviewRequest>(request("OLD-EXPLANATION"))
  const app = await testRender(() => <EditExplanation review={getEditReview(value())} />)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("OLD-EXPLANATION")
    setValue({ permission: "read", metadata: {} })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("OLD-EXPLANATION")
    expect(app.captureCharFrame()).not.toContain("Why this change?")
  } finally {
    app.renderer.destroy()
  }
})

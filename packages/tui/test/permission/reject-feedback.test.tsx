import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { feedback, mount, proposal, wait } from "./edit-review.fixture"

test("ordinary edit feedback is sent as a rejection through the actual SDK", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    const input = await feedback(ui)
    input.setText("  Keep the existing function name.  ")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies).toEqual([{ reply: "reject", message: "Keep the existing function name." }])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("plain Reject and Escape still reject without feedback", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    ui.app.mockInput.pressArrow("right")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies[0]).toEqual({ reply: "reject" })
    ui.app.mockInput.pressEscape()
    await wait(() => ui.replies.length === 2)
    expect(ui.replies[1]).toEqual({ reply: "reject" })
  } finally {
    ui.app.renderer.destroy()
  }
})

test("canceling feedback keeps the proposal pending and a new request clears the draft", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, 60)
  try {
    const input = await feedback(ui)
    input.setText("OLD-DRAFT")
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("OLD-DRAFT")
    ui.app.mockInput.pressEscape()
    await ui.app.renderOnce()
    expect(ui.replies).toEqual([])
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    const next = await feedback(ui)
    next.setText("STALE-DRAFT")
    ui.setRequest({ ...proposal, id: "per_next" })
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).not.toContain("STALE-DRAFT")
    expect(ui.app.captureCharFrame()).toContain("Reject with feedback")
    expect(ui.replies).toEqual([])
  } finally {
    ui.app.renderer.destroy()
  }
})

test("blank feedback is a plain rejection", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    const input = await feedback(ui)
    input.setText("   ")
    ui.app.mockInput.pressEnter()
    await wait(() => ui.replies.length === 1)
    expect(ui.replies).toEqual([{ reply: "reject" }])
  } finally {
    ui.app.renderer.destroy()
  }
})

import test from "node:test"
import assert from "node:assert/strict"
import { assessSecurity } from "./policy.mjs"
const good = { data: [{ results: [{ component: "fixture", version: "2.0.0" }] }], errors: [] }
test("accepts a completed populated scan", () => assert.equal(assessSecurity(good, 4, 0).scannedFiles, 4))
test("rejects an empty inventory", () => assert.throws(() => assessSecurity(good, 0, 0)))
test("rejects no identified components", () => assert.throws(() => assessSecurity({ data: [], errors: [] }, 4, 0)))
test("rejects scanner errors", () => assert.throws(() => assessSecurity({ ...good, errors: ["download failed"] }, 4, 0)))
test("rejects unknown exit status", () => assert.throws(() => assessSecurity(good, 4, 1)))
test("rejects missing component or version", () => {
  assert.throws(() => assessSecurity({ data: [{ results: [{ version: "1.0.0" }] }], errors: [] }, 4, 0))
  assert.throws(() => assessSecurity({ data: [{ results: [{ component: "fixture", version: " " }] }], errors: [] }, 4, 0))
})
test("rejects unknown severity", () => assert.throws(() => assessSecurity({ data: [{ results: [{ component: "fixture", version: "1.0.0", vulnerabilities: [{ severity: "urgent" }] }] }], errors: [] }, 4, 0)))
test("rejects high severity", () => assert.throws(() => assessSecurity({ data: [{ results: [{ component: "fixture", version: "1.0.0", vulnerabilities: [{ severity: "high" }] }] }], errors: [] }, 4, 13)))
test("keeps medium findings visible without failing high threshold", () => assert.equal(assessSecurity({ data: [{ results: [{ component: "fixture", version: "1.0.0", vulnerabilities: [{ severity: "medium" }] }] }], errors: [] }, 4, 0).advisoryEntries, 1))

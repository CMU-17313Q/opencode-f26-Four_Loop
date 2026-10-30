import test from "node:test"
import assert from "node:assert/strict"
import { assessGraph } from "./policy.mjs"
const good = { modules: [{ source: "a.ts" }], summary: { violations: [] } }
test("accepts a populated clean graph", () => assert.equal(assessGraph(good, "a.ts"), 1))
test("rejects an empty graph", () => assert.throws(() => assessGraph({ modules: [], summary: { violations: [] } })))
test("rejects missing expected input", () => assert.throws(() => assessGraph(good, "missing.ts")))
test("rejects violations", () => assert.throws(() => assessGraph({ ...good, summary: { violations: [{ rule: { name: "no-tool-cycles" } }] } })))
test("rejects malformed reports", () => assert.throws(() => assessGraph({ modules: [] })))

// Regression tests for the reviewed namespace self-export exceptions.
const knownPaths = [
  "json-schema.ts", "registry.ts", "shell/id.ts", "shell/prompt.ts", "tool.ts", "truncate.ts",
].map((name) => `packages/opencode/src/tool/${name}`)
const selfExport = (source) => ({
  type: "cycle", from: source, to: source,
  rule: { name: "no-tool-cycles", severity: "error" },
  cycle: [{ name: source, dependencyTypes: ["local", "export"] }],
})
const withViolations = (violations) => ({
  modules: knownPaths.map((source) => ({ source })),
  summary: { violations },
})
for (const source of knownPaths) {
  test(`allows reviewed namespace self-export: ${source}`, () => {
    assert.equal(assessGraph(withViolations([selfExport(source)])), knownPaths.length)
  })
}
test("allows the six reviewed edges without modifying the raw report", () => {
  const report = withViolations(knownPaths.map(selfExport))
  const before = JSON.stringify(report)
  assert.equal(assessGraph(report), knownPaths.length)
  assert.equal(JSON.stringify(report), before)
})
test("rejects a new self-export outside the reviewed set", () => {
  assert.throws(() => assessGraph(withViolations([
    selfExport("packages/opencode/src/tool/new-module.ts"),
  ])))
})
test("rejects a self-import even in a reviewed file", () => {
  const violation = selfExport(knownPaths[0])
  violation.cycle[0].dependencyTypes = ["local", "import"]
  assert.throws(() => assessGraph(withViolations([violation])))
})
test("rejects a multi-file re-export cycle between reviewed files", () => {
  const violation = selfExport(knownPaths[0])
  violation.to = knownPaths[1]
  violation.cycle.push({ name: knownPaths[1], dependencyTypes: ["local", "export"] })
  assert.throws(() => assessGraph(withViolations([violation])))
})
test("rejects a multi-file cycle even if from and to are equal", () => {
  const violation = selfExport(knownPaths[0])
  violation.cycle.push({ name: knownPaths[1], dependencyTypes: ["local", "export"] })
  assert.throws(() => assessGraph(withViolations([violation])))
})
test("rejects findings from a different rule", () => {
  const violation = selfExport(knownPaths[0])
  violation.rule.name = "another-rule"
  assert.throws(() => assessGraph(withViolations([violation])))
})
test("rejects mixed self-import/self-export dependencies", () => {
  const violation = selfExport(knownPaths[0])
  violation.cycle[0].dependencyTypes.push("import")
  assert.throws(() => assessGraph(withViolations([violation])))
})
test("rejects malformed cycle entries instead of allowing them", () => {
  const violation = selfExport(knownPaths[0])
  violation.cycle = []
  assert.throws(() => assessGraph(withViolations([violation])))
})

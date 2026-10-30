// Reviewed existing namespace self-exports, not a blanket exemption for these files.
// These exact single-file export edges are accepted. Other cycles still fail.
const knownSelfExports = new Set([
  "json-schema.ts",
  "registry.ts",
  "shell/id.ts",
  "shell/prompt.ts",
  "tool.ts",
  "truncate.ts",
].map((name) => `packages/opencode/src/tool/${name}`))

export function isAllowedSelfExport(violation) {
  const edge = violation?.cycle?.[0]
  const types = edge?.dependencyTypes
  return Boolean(
    violation?.type === "cycle" &&
    violation?.rule?.name === "no-tool-cycles" &&
    violation?.rule?.severity === "error" &&
    knownSelfExports.has(violation.from) &&
    violation.from === violation.to &&
    Array.isArray(violation.cycle) &&
    violation.cycle.length === 1 &&
    edge?.name === violation.from &&
    Array.isArray(types) &&
    types.length === 2 &&
    types.includes("local") &&
    types.includes("export")
  )
}

export function assessGraph(report, requiredSource = null, minimum = 1) {
  if (!report || !Array.isArray(report.modules) || !Array.isArray(report.summary?.violations)) {
    throw new Error("Invalid dependency-cruiser report: missing modules or violations")
  }
  if (report.modules.length < minimum) throw new Error("Empty or unexpectedly small dependency graph")
  if (requiredSource && !report.modules.some((item) => item.source === requiredSource)) {
    throw new Error(`The requested source was not analyzed: ${requiredSource}`)
  }
  const blocking = report.summary.violations.filter((item) => !isAllowedSelfExport(item))
  if (blocking.length) {
    throw new Error(`${blocking.length} architecture violation(s); inspect report.json`)
  }
  return report.modules.length
}

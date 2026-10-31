export function assessSecurity(report, scannedFiles, exitCode) {
  if (!report || !Array.isArray(report.data) || !Array.isArray(report.errors)) throw new Error("Malformed Retire.js report")
  if (!Number.isInteger(scannedFiles) || scannedFiles < 1) throw new Error("No JavaScript inputs were scanned")
  if (report.errors.length) throw new Error(`Scanner reported errors/warnings: ${report.errors.join("; ")}`)
  if (![0, 13].includes(exitCode)) throw new Error(`Scanner failed with unexpected status ${exitCode}`)
  const results = report.data.flatMap((finding) => finding.results || [])
  if (!results.length) throw new Error("No recognizable libraries found: an empty identification result is not accepted as a clean security scan")
  if (results.some((item) => typeof item.component !== "string" || !item.component.trim() || typeof item.version !== "string" || !item.version.trim())) {
    throw new Error("Scanner reported a library without a component name or version")
  }
  const vulnerabilities = results.flatMap((item) => item.vulnerabilities || [])
  if (vulnerabilities.some((item) => !["low", "medium", "high", "critical"].includes(item.severity))) {
    throw new Error("Scanner reported an unrecognized vulnerability severity")
  }
  const severe = vulnerabilities.filter((item) => ["high", "critical"].includes(item.severity))
  if (severe.length || exitCode === 13) throw new Error(`Security policy failed: ${severe.length} high/critical finding(s). Inspect report.json.`)
  return { identifiedLibraries: results.length, advisoryEntries: vulnerabilities.length, scannedFiles }
}

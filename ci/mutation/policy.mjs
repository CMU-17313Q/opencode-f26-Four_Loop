export function validateMutationReport(report) {
  if (!report || !report.files || typeof report.files !== "object") throw new Error("Missing mutation report files")
  const mutants = Object.values(report.files).flatMap((entry) => entry.mutants || [])
  if (mutants.length === 0) throw new Error("No mutants were produced; this is not a successful mutation run")
  if (mutants.some((m) => m.status === "Pending" || m.status === "RuntimeError")) throw new Error("Mutation run has incomplete/runtime-error results")
  if (!mutants.some((m) => ["Killed", "Survived", "NoCoverage"].includes(m.status))) throw new Error("No completed, executable mutants were assessed")
  return mutants.length
}

export interface EditReviewRequest {
  permission?: string
  metadata?: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function requiresEditReview(request: EditReviewRequest) {
  return request.permission === "edit" && record(request.metadata) && request.metadata.explainBeforeEdit === true
}

export function getEditReview(request: EditReviewRequest) {
  if (!requiresEditReview(request)) return
  const metadata = record(request.metadata) ? request.metadata : {}
  const explanation = typeof metadata.explanation === "string" ? metadata.explanation.trim() : ""
  const files = (Array.isArray(metadata.files) ? metadata.files : []).filter(record)
  const paths = files.flatMap((file) => {
    const source = typeof file.filePath === "string" ? file.filePath.trim() : ""
    const relative = typeof file.relativePath === "string" ? file.relativePath.trim() : ""
    const destination = typeof file.movePath === "string" ? file.movePath.trim() : ""
    if (file.type === "move" && source && destination) return [`${source} → ${destination}`]
    return relative || source ? [relative || source] : []
  })
  const fallback = typeof metadata.filepath === "string" ? metadata.filepath.trim() : ""
  const complete =
    Array.isArray(metadata.files) &&
    files.length === metadata.files.length &&
    files.length > 0 &&
    files.every((file) => typeof file.patch === "string" && file.patch.trim())
  const diffs = complete
    ? files.map((file) => ({
        path:
          typeof file.relativePath === "string"
            ? file.relativePath
            : typeof file.filePath === "string"
              ? file.filePath
              : "",
        diff: file.patch as string,
      }))
    : typeof metadata.diff === "string" && metadata.diff.trim()
      ? [{ path: fallback, diff: metadata.diff }]
      : []
  // Keep this presentation bound aligned with the backend explanation validator.
  const problem = !explanation
    ? "missing"
    : explanation.length > 4000
      ? "tooLong"
      : !diffs.length
        ? "missingDiff"
        : undefined
  return { explanation, files: [...new Set(paths.length ? paths : fallback ? [fallback] : [])], diffs, problem }
}

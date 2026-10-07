// Keep this presentation limit aligned with the backend validator.
// The backend, not this helper, remains the permission authority.
export const MAX_REVIEW_EXPLANATION_LENGTH = 4000

export interface EditReviewRequest {
  readonly permission: string
  readonly metadata?: unknown
}

export interface EditReview {
  enabled: boolean
  explanation: string
  problem?: string
  files: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read the server-provided review marker; do not infer it from an explanation alone. */
export function getEditReview(request: EditReviewRequest): EditReview {
  const metadata = isRecord(request.metadata) ? request.metadata : {}
  const enabled = request.permission === "edit" && metadata.explainBeforeEdit === true
  if (!enabled) return { enabled: false, explanation: "", files: [] }

  const text = typeof metadata.explanation === "string" ? metadata.explanation.trim() : ""
  const problem =
    text.length === 0
      ? "This proposal has no valid explanation. Reject this proposal; a new proposal needs a valid explanation."
      : text.length > MAX_REVIEW_EXPLANATION_LENGTH
        ? "This explanation exceeds the review limit. Reject this proposal; a new proposal needs a shorter explanation."
        : undefined

  const files = (Array.isArray(metadata.files) ? metadata.files : []).flatMap((file: unknown) => {
    if (!isRecord(file)) return []
    if (
      file.type === "move" &&
      typeof file.filePath === "string" &&
      file.filePath.trim() &&
      typeof file.movePath === "string" &&
      file.movePath.trim()
    ) {
      return [`${file.filePath} -> ${file.movePath}`]
    }
    const name =
      typeof file.relativePath === "string" && file.relativePath.trim()
        ? file.relativePath
        : typeof file.filePath === "string"
          ? file.filePath
          : ""
    return name.trim() ? [name] : []
  })
  const fallback = typeof metadata.filepath === "string" && metadata.filepath.trim() ? [metadata.filepath] : []

  return {
    enabled: true,
    explanation: problem ? "" : text,
    problem,
    files: [...new Set(files.length ? files : fallback)],
  }
}

export function editReviewOptions(request: EditReviewRequest): Record<string, string> {
  const review = getEditReview(request)
  if (!review.enabled) return { once: "Allow once", always: "Allow always", reject: "Reject" }
  // Normally invalid explanations never get this far: the backend rejects them.
  // Keep the UI conservative if malformed protected metadata nevertheless arrives.
  if (review.problem) return { reject: "Reject" }
  return { once: "Accept change", reject: "Reject" }
}

/** Shared by mouse, keyboard, and the existing always-confirmation handler. */
export function selectEditReviewOption(
  request: EditReviewRequest,
  option: PropertyKey,
): "once" | "always" | "reject" | undefined {
  if (option !== "once" && option !== "always" && option !== "reject") return
  return Object.hasOwn(editReviewOptions(request), option) ? option : undefined
}

export interface EditReviewDiff {
  path: string
  diff: string
}

/** Render each patch file separately, while retaining the ordinary combined-diff fallback. */
export function getEditDiffs(request: EditReviewRequest): EditReviewDiff[] {
  const metadata = isRecord(request.metadata) ? request.metadata : {}
  if (request.permission === "edit" && metadata.explainBeforeEdit === true && Array.isArray(metadata.files)) {
    const items = metadata.files.filter(isRecord)
    // Do not silently show only a subset if per-file metadata is incomplete.
    if (
      items.length === metadata.files.length &&
      items.length > 0 &&
      items.every((item) => typeof item.patch === "string" && item.patch.trim().length > 0)
    ) {
      return items.map((item) => ({
        path:
          typeof item.relativePath === "string" && item.relativePath.trim()
            ? item.relativePath
            : typeof item.filePath === "string"
              ? item.filePath
              : "",
        diff: item.patch as string,
      }))
    }
  }
  if (typeof metadata.diff !== "string" || !metadata.diff.trim()) return []
  return [{ path: typeof metadata.filepath === "string" ? metadata.filepath : "", diff: metadata.diff }]
}

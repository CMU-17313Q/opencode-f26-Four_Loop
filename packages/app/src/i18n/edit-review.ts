// Explicit English fallback until reviewed translations of these new controls are available.
export const EDIT_REVIEW_ENGLISH = {
  "editReview.setting.title": "Explain before edit",
  "editReview.setting.description":
    "Require an explanation and your approval before edit, write, or patch tools change this project.",
  "editReview.setting.noProject": "Open a project to change this setting.",
  "editReview.setting.unsupported": "This server does not support explain before edit.",
  "editReview.setting.readFailed": "Could not read this project's explain-before-edit setting.",
  "editReview.setting.saveFailed": "Could not save this project's explain-before-edit setting.",
  "editReview.setting.verifyFailed": "The project did not load the saved explain-before-edit setting.",
  "editReview.heading": "Why this change?",
  "editReview.files": "Affected files",
  "editReview.diff": "Proposed changes",
  "editReview.accept": "Accept change",
  "editReview.reject": "Reject",
  "editReview.feedback": "Reject with feedback",
  "editReview.feedback.label": "What should the agent change?",
  "editReview.problem.missing": "This proposal has no valid explanation. Reject it and request a new proposal.",
  "editReview.problem.tooLong":
    "This explanation exceeds the review limit. Reject it and request a shorter explanation.",
  "editReview.problem.missingDiff": "The proposed changes are unavailable. Reject this proposal and request a new one.",
} as const

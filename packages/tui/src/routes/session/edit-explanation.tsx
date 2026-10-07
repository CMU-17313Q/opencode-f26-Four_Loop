import type { RGBA } from "@opentui/core"
import { For, Show } from "solid-js"
import type { EditReview } from "./edit-review"

/** Explain the current proposal above its diff. Approval is handled by the existing dialog. */
export function EditExplanation(props: {
  review: EditReview
  textColor?: string | RGBA
  mutedColor?: string | RGBA
  errorColor?: string | RGBA
}) {
  return (
    <Show when={props.review.enabled}>
      <box flexDirection="column" gap={1} paddingLeft={1} paddingBottom={1} flexShrink={0}>
        <text fg={props.textColor}>Why this change?</text>
        <Show
          when={props.review.problem}
          fallback={
            <text fg={props.textColor} wrapMode="word">
              {props.review.explanation}
            </text>
          }
        >
          <text fg={props.errorColor} wrapMode="word">
            {props.review.problem}
          </text>
        </Show>
        <Show when={props.review.files.length > 0}>
          <box flexDirection="column" flexShrink={0}>
            <text fg={props.mutedColor}>Affected files</text>
            <For each={props.review.files}>
              {(file) => (
                <text fg={props.mutedColor} wrapMode="word">
                  {`- ${file}`}
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

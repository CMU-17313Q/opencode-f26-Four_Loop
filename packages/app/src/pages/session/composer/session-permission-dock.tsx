import { For, Show, createEffect, createMemo, createUniqueId, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { getEditReview } from "@/utils/edit-review"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject", message?: string) => void
}) {
  const language = useLanguage()
  const review = createMemo(() => getEditReview(props.request))
  const [state, setState] = createStore({ feedback: false, text: "" })
  const feedbackID = createUniqueId()
  createEffect(
    on(
      () => props.request.id,
      () => setState({ feedback: false, text: "" }),
    ),
  )
  const decide = (response: "once" | "always" | "reject", message?: string) => {
    if (props.responding) return
    if (review() && (response === "always" || (review()?.problem && response !== "reject"))) return
    props.onDecide(response, message)
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions" class="flex flex-wrap justify-end gap-2">
            <Show
              when={review()}
              fallback={
                <>
                  <Button variant="ghost" size="normal" onClick={() => decide("reject")} disabled={props.responding}>
                    {language.t("ui.permission.deny")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="normal"
                    onClick={() => decide("always")}
                    disabled={props.responding}
                  >
                    {language.t("ui.permission.allowAlways")}
                  </Button>
                  <Button variant="primary" size="normal" onClick={() => decide("once")} disabled={props.responding}>
                    {language.t("ui.permission.allowOnce")}
                  </Button>
                </>
              }
            >
              <Show
                when={state.feedback}
                fallback={
                  <>
                    <Button variant="ghost" size="normal" onClick={() => decide("reject")} disabled={props.responding}>
                      {language.t("editReview.reject")}
                    </Button>
                    <Show when={!review()?.problem}>
                      <Button
                        variant="secondary"
                        size="normal"
                        onClick={() => setState("feedback", true)}
                        disabled={props.responding}
                      >
                        {language.t("editReview.feedback")}
                      </Button>
                      <Button
                        variant="primary"
                        size="normal"
                        onClick={() => decide("once")}
                        disabled={props.responding}
                      >
                        {language.t("editReview.accept")}
                      </Button>
                    </Show>
                  </>
                }
              >
                <Button
                  variant="ghost"
                  size="normal"
                  onClick={() => setState({ feedback: false, text: "" })}
                  disabled={props.responding}
                >
                  {language.t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="normal"
                  onClick={() => decide("reject", state.text.trim())}
                  disabled={props.responding || !state.text.trim()}
                >
                  {language.t("editReview.feedback")}
                </Button>
              </Show>
            </Show>
          </div>
        </>
      }
    >
      <Show when={review()} keyed>
        {(item) => (
          <section
            data-component="edit-review"
            aria-label={language.t("editReview.heading")}
            class="flex min-w-0 flex-col gap-3 max-h-96 overflow-y-auto px-1"
          >
            <h3 class="text-14-medium text-text-strong">{language.t("editReview.heading")}</h3>
            <Show when={item.problem} fallback={<p class="whitespace-pre-wrap break-words">{item.explanation}</p>}>
              <p role="alert">{language.t(`editReview.problem.${item.problem!}`)}</p>
            </Show>
            <Show when={item.files.length}>
              <div>
                <h4 class="text-12-medium text-text-weak">{language.t("editReview.files")}</h4>
                <For each={item.files}>{(file) => <div class="font-mono text-12-regular break-all">{file}</div>}</For>
              </div>
            </Show>
            <Show when={item.diffs.length}>
              <h4 class="text-12-medium text-text-weak">{language.t("editReview.diff")}</h4>
              <For each={item.diffs}>
                {(file) => (
                  <div class="min-w-0 rounded-md border border-border-weak-base">
                    <div class="font-mono text-12-regular break-all px-2 py-1">{file.path}</div>
                    <pre class="overflow-x-auto p-2 font-mono text-12-regular">
                      <code>{file.diff}</code>
                    </pre>
                  </div>
                )}
              </For>
            </Show>
            <Show when={state.feedback}>
              <div class="flex flex-col gap-2">
                <label for={feedbackID}>{language.t("editReview.feedback.label")}</label>
                <textarea
                  id={feedbackID}
                  class="w-full min-h-20 rounded-md border border-border-weak-base p-2"
                  value={state.text}
                  maxlength={4000}
                  onInput={(event) => setState("text", event.currentTarget.value)}
                  disabled={props.responding}
                />
              </div>
            </Show>
          </section>
        )}
      </Show>

      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}

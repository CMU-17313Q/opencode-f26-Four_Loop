import { Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import type { Config } from "@opencode-ai/sdk/v2"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

export function SettingsEditReview(props: { directory?: string }) {
  const language = useLanguage()
  const server = useServerSDK()
  const [state, setState] = createStore({ saving: false })
  const target = createMemo(() => {
    const sdk = server()
    const directory = props.directory
    if (!directory || sdk.protocolKind() !== "v1") return
    return { sdk, directory }
  })
  const [enabled, { mutate }] = createResource(target, async ({ sdk, directory }) => {
    const result = await sdk.client.config.get({ directory }, { throwOnError: true })
    return (result.data as { explain_before_edit?: boolean } | undefined)?.explain_before_edit === true
  })

  const save = async (checked: boolean) => {
    const selected = target()
    if (!selected || state.saving || enabled.loading || enabled.error) return
    setState("saving", true)
    try {
      const config: Config & { explain_before_edit: boolean } = { explain_before_edit: checked }
      await selected.sdk.client.config.update({ directory: selected.directory, config }, { throwOnError: true })
      const result = await selected.sdk.client.config.get({ directory: selected.directory }, { throwOnError: true })
      const value = (result.data as { explain_before_edit?: boolean } | undefined)?.explain_before_edit === true
      if (value !== checked) throw new Error(language.t("editReview.setting.verifyFailed"))
      if (selected === target()) mutate(value)
    } catch {
      showToast({ title: language.t("common.requestFailed"), description: language.t("editReview.setting.saveFailed") })
    } finally {
      setState("saving", false)
    }
  }

  return (
    <div data-component="settings-edit-review" class="flex items-center justify-between gap-6 px-4 py-3">
      <div class="flex min-w-0 flex-col gap-1">
        <div class="text-14-medium text-text-strong">{language.t("editReview.setting.title")}</div>
        <div class="text-12-regular text-text-weak">
          {!props.directory
            ? language.t("editReview.setting.noProject")
            : server().protocolKind() !== "v1"
              ? language.t("editReview.setting.unsupported")
              : language.t("editReview.setting.description")}
        </div>
        <Show when={props.directory}>
          <code class="text-12-regular text-text-weak break-all">{props.directory}</code>
        </Show>
        <Show when={enabled.error}>
          <div role="alert" class="text-12-regular text-text-weak">
            {language.t("editReview.setting.readFailed")}
          </div>
        </Show>
      </div>
      <div data-action="settings-explain-before-edit" class="shrink-0">
        <Switch
          checked={!enabled.error && enabled.latest === true}
          disabled={!target() || enabled.loading || !!enabled.error || state.saving}
          onChange={(checked) => void save(checked)}
          hideLabel
        >
          {language.t("editReview.setting.title")}
        </Switch>
      </div>
    </div>
  )
}

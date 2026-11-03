import path from "path"
import { Effect, Option, Schema, Semaphore } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Git } from "@/git"

// Clones a public HTTPS git repository into ~/projects/<name> so the web UI can open it as a project.
// Raw route (outside the typed HttpApi) so it needs no SDK regeneration or exerciser scenario.
export const route = "/experimental/clone"

const Payload = Schema.Struct({ url: Schema.String })
const clones = Semaphore.makeUnsafe(1)

export function handler(input: { git: Git.Interface; fs: FSUtil.Interface }) {
  return Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(Payload).pipe(Effect.option)
    if (Option.isNone(body)) return error(400, 'Expected a JSON body like { "url": "https://..." }')
    const url = body.value.url.trim()
    const name = repoName(url)
    if (!name)
      return error(
        400,
        "Use a public HTTPS repository URL from github.com or gitlab.com without credentials, a custom port, query parameters, or a fragment",
      )

    const response = yield* clones.withPermitsIfAvailable(1)(clone(input, url, name))
    return Option.isSome(response) ? response.value : error(429, "Another clone is running. Try again shortly.")
  }).pipe(Effect.catch((cause) => Effect.succeed(error(500, String(cause)))))
}

function clone(input: { git: Git.Interface; fs: FSUtil.Interface }, url: string, name: string) {
  return Effect.gen(function* () {
    const parent = path.join(Global.Path.home, "projects")
    const directory = path.join(parent, name)
    if (yield* input.fs.existsSafe(directory)) return HttpServerResponse.jsonUnsafe({ directory, existing: true })

    yield* input.fs.ensureDir(parent)
    // Publish only complete clones. Scoped staging is removed on failure, timeout, or cancellation.
    const temporary = yield* input.fs.makeTempDirectoryScoped({ directory: parent, prefix: ".clone-" })
    const target = path.join(temporary, "repository")
    // Disable credential prompts and helpers so private or missing repos fail fast instead of hanging.
    const result = yield* input.git
      .run(
        [
          "-c",
          "credential.helper=",
          "-c",
          "http.followRedirects=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "clone",
          "--depth=1",
          "--single-branch",
          "--no-tags",
          "--",
          new URL(url).href,
          target,
        ],
        {
          cwd: parent,
          env: { GIT_TERMINAL_PROMPT: "0" },
          maxOutputBytes: 64 * 1024,
          forceKillAfter: "5 seconds",
        },
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () => Effect.succeed(undefined),
        }),
      )
    if (!result) return error(504, "Cloning timed out after two minutes. Try a smaller repository.")
    const stderr = result.stderr.toString("utf8").trim()
    // With prompts disabled, git reports missing and private repos as an auth failure.
    if (stderr.includes("could not read Username")) return error(422, "Repository not found or not public")
    if (result.exitCode !== 0) return error(422, stderr || "git clone failed")
    yield* input.fs.rename(target, directory)
    return HttpServerResponse.jsonUnsafe({ directory, existing: false })
  }).pipe(Effect.scoped)
}

export function repoName(url: string) {
  const parsed = URL.parse(url)
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    !["github.com", "gitlab.com"].includes(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return
  const name = parsed.pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, "")
  if (!name || name.startsWith(".") || !/^[\w.-]+$/.test(name)) return
  return name
}

function error(status: number, message: string) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status })
}

export * as ProjectClone from "./clone"

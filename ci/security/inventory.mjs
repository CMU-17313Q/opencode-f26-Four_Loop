import { readdirSync, statSync, realpathSync, mkdirSync, copyFileSync } from "node:fs"
import path from "node:path"
// Follow Bun workspace/package symlinks, once per physical directory/file.
// Never follow a link outside the repository, and keep the source/destination map.
export function stageJavaScript(root, destination) {
  const canonicalRoot = realpathSync(root)
  const seen = new Set()
  const inventory = []
  const externalLinks = []
  function walk(entry) {
    const actual = realpathSync(entry)
    if (!(actual === canonicalRoot || actual.startsWith(canonicalRoot + path.sep))) {
      externalLinks.push(path.relative(root, entry))
      return
    }
    if (seen.has(actual)) return
    seen.add(actual)
    const info = statSync(actual)
    if (info.isDirectory()) {
      for (const child of readdirSync(actual, { withFileTypes: true })) {
        if ([".git", ".cache", ".turbo"].includes(child.name)) continue
        // Bun keeps obsolete package versions in .bun after upgrades; traverse installed package links instead.
        if (child.name === ".bun" && actual === path.join(canonicalRoot, "node_modules")) continue
        // domino publishes a Yarn plugin with vendored lodash; it is not application or dependency runtime code.
        if (child.name === ".yarn" && actual.endsWith(path.join("node_modules", "@mixmark-io", "domino"))) continue
        walk(path.join(actual, child.name))
      }
      return
    }
    if (!info.isFile() || !/\.(?:js|mjs|cjs)$/.test(actual)) return
    const source = path.relative(canonicalRoot, actual).split(path.sep).join("/")
    // Make Bun's hidden store explicit to directory-based scanners.
    const relative = source.replaceAll("/.bun/", "/bun-store/")
    const target = path.join(destination, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(actual, target)
    inventory.push({ source, staged: relative, bytes: info.size })
  }
  for (const directory of ["packages", "node_modules"]) walk(path.join(canonicalRoot, directory))
  if (externalLinks.length) throw new Error(`Dependencies resolve outside the checkout; reinstall them locally before scanning: ${externalLinks.slice(0,5).join(", ")}`)
  return inventory
}

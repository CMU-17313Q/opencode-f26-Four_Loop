# Architecture check: reviewed self-export edges

The scanner examines imports and re-exports within `packages/opencode/src/tool/`.
It does not claim to check cycles through code outside that directory.

The initial real scan reported six single-node cycles. Each corresponds to an
existing namespace self-export (`export * as Name from "./same-file"`) in:

- `json-schema.ts`
- `registry.ts`
- `shell/id.ts`
- `shell/prompt.ts`
- `tool.ts`
- `truncate.ts`

These existing source statements were checked against repository revision
`e891f0472dd25f5db5c17c80f3d8a975eea4f968`.

`policy.mjs` permits only the exact reviewed paths, the `no-tool-cycles` rule,
and a single-node cycle with only `local` and `export` dependency types.
No file is removed from the scan. New self-cycles, self-imports, and multi-file
cycles (including cycles involving the listed files) remain blocking.

The original scanner report is retained unchanged in `out/report.json`.
The accepted entries are separately written to `out/accepted-self-exports.json`
and their count is printed in the job log. This is a documented policy exception,
not a claim that the raw dependency graph contains zero cycles.

The policy unit tests cover the exceptions and the blocking cases. The scanner
self-test separately checks an acyclic fixture and a real two-file cycle.

Run from the repository root:

```sh
node --test ci/architecture/policy.test.mjs
node ci/architecture/selftest.mjs
node ci/architecture/check.mjs
```

No application source files need to change for this exception. Any future
extension to the exception list requires source review and regression tests.

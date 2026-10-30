const path = require("node:path")

module.exports = {
  forbidden: [
    {
      name: "no-tool-cycles",
      severity: "error",
      comment: "Tool implementation modules must not form circular import chains.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    includeOnly: "^packages/opencode/src/tool/",
    doNotFollow: { path: "(^|/)node_modules/" },
    tsConfig: {
      fileName: path.resolve(__dirname, "tsconfig.json"),
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ["bun", "import", "default"],
      exportsFields: ["exports"],
    },
  },
}

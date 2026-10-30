module.exports = {
  testRunner: "command",
  commandRunner: {
    command: "cd packages/opencode && bun test --timeout 30000 ./test/tool/edit-explanation.test.ts ./test/tool/edit-explanation-contract.test.ts",
  },
  coverageAnalysis: "off",
  // The default sandbox copies the whole monorepo and crashes on symlinked folders
  // (packages/console/app/public/email). Mutating in place avoids the copy; Stryker
  // restores the original file when the run ends.
  inPlace: true,
  // Bun does not type-check tests, and this preprocessor would rewrite source files
  // when running in place, so it is turned off.
  disableTypeChecks: false,
  mutate: ["packages/opencode/src/tool/edit-explanation.ts"],
  concurrency: 1,
  timeoutMS: 10000,
  timeoutFactor: 1.5,
  dryRunTimeoutMinutes: 3,
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ["clear-text", "json", "html"],
  jsonReporter: { fileName: "ci/mutation/out/mutation.json" },
  htmlReporter: { fileName: "ci/mutation/out/mutation.html" },
  tempDirName: "ci/mutation/.stryker-tmp",
  cleanTempDir: true,
  ignorePatterns: ["ci/**/node_modules/**", "ci/**/out/**", "ci/**/.tmp/**", "ci/load/bin/**", "artifacts/**"],
}

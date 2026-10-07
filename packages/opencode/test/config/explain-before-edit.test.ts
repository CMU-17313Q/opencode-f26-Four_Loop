import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"

describe("explain_before_edit configuration schema", () => {
  for (const value of [true, false]) {
    test(`accepts ${value}`, () => {
      const config = ConfigParse.schema(ConfigV1.Info, { explain_before_edit: value }, "test-config")
      expect(config.explain_before_edit).toBe(value)
    })
  }

  test("does not require the setting", () => {
    const config = ConfigParse.schema(ConfigV1.Info, {}, "test-config")
    expect(config.explain_before_edit).toBeUndefined()
  })

  for (const value of ["true", "false", 1, 0, null, {}, []]) {
    test(`rejects non-boolean ${JSON.stringify(value)}`, () => {
      expect(() => ConfigParse.schema(ConfigV1.Info, { explain_before_edit: value }, "test-config")).toThrow()
    })
  }
})

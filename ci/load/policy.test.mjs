import test from "node:test"
import assert from "node:assert/strict"
import { isHealthy, assertLoopback } from "./policy.mjs"
test("accepts explicit healthy JSON", () => assert.equal(isHealthy(200, { healthy: true }), true))
test("rejects false health", () => assert.equal(isHealthy(200, { healthy: false }), false))
test("rejects status-only success", () => assert.equal(isHealthy(200, "<html>"), false))
test("rejects non-success status", () => assert.equal(isHealthy(500, { healthy: true }), false))
test("permits loopback", () => assert.equal(assertLoopback("http://127.0.0.1:49100/").hostname, "127.0.0.1"))
test("refuses production targets", () => assert.throws(() => assertLoopback("https://crs-17313-the-boys.qatar.cmu.edu/")))

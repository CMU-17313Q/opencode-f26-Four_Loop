import test from "node:test"
import assert from "node:assert/strict"
import { validateMutationReport } from "./policy.mjs"
test("accepts completed mutation evidence", () => assert.equal(validateMutationReport({ files: { a: { mutants: [{ status: "Killed" }] } } }), 1))
test("rejects zero mutants", () => assert.throws(() => validateMutationReport({ files: {} })))
test("rejects incomplete results", () => assert.throws(() => validateMutationReport({ files: { a: { mutants: [{ status: "Pending" }] } } })))
test("rejects runtime errors", () => assert.throws(() => validateMutationReport({ files: { a: { mutants: [{ status: "RuntimeError" }] } } })))
test("rejects a report containing only compile errors", () => assert.throws(() => validateMutationReport({ files: { a: { mutants: [{ status: "CompileError" }] } } })))

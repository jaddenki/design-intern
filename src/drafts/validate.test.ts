import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceRef } from "../run-context.js";
import { validateLines, validateNotes } from "./validate.js";

const known = new Map<string, SourceRef>([
  ["linear:DES-142", { id: "linear:DES-142", kind: "linear", title: "DES-142" }],
  ["github:Infisical/infisical#4512", { id: "github:Infisical/infisical#4512", kind: "github", title: "#4512" }],
]);

test("accepts lines citing sources seen this run", () => {
  const errors = validateLines([{ section: "shipped", text: "Sidebar shipped.", sourceIds: ["linear:DES-142", "github:Infisical/infisical#4512"] }], known);
  assert.deepEqual(errors, []);
});

test("rejects invented sources", () => {
  const errors = validateLines([{ section: "shipped", text: "Sidebar shipped.", sourceIds: ["linear:DES-999"] }], known);
  assert.match(errors.join(), /DES-999.*no tool returned/);
});

test("rejects uncited lines, unknown sections, and empty drafts", () => {
  assert.match(validateLines([{ section: "shipped", text: "x", sourceIds: [] }], known).join(), /cites no sources/);
  assert.match(validateLines([{ section: "done", text: "x", sourceIds: ["linear:DES-142"] }], known).join(), /unknown section/);
  assert.match(validateLines([], known).join(), /no lines/);
});

test("rejects credential-like text in lines and notes", () => {
  const line = { section: "shipped", text: "token xoxb-1234567890-abcdef", sourceIds: ["linear:DES-142"] };
  assert.match(validateLines([line], known).join(), /credential/);
  assert.equal(validateNotes(["see __slack_bot_token__"]).length, 1);
});

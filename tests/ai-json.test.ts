// JSON extraction for AI providers without an output-schema flag (lib/ai-json.ts, used by lib/gemini-runner.ts).
// Pure string tests: no model or CLI is started.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/ai-json.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { conformToSchema, extractJson, parseCliEnvelope, type JsonSchema } from "@/lib/ai-json";

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "items", "note"],
  properties: {
    summary: { type: "string" },
    items: { type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, required: ["name", "rate"], properties: { name: { type: "string" }, rate: { type: ["number", "null"] } } } },
    note: { type: ["string", "null"] },
    kind: { type: "string", enum: ["core", "flex"] },
  },
};

test("extractJson reads plain JSON, fenced JSON and JSON wrapped in prose", () => {
  assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJson("```json\n{\"ok\": true}\n```"), { ok: true });
  assert.deepEqual(extractJson("```\r\n{\"ok\": 1}\r\n```"), { ok: 1 });
  assert.deepEqual(extractJson('Here is the answer:\n{"text":"a } inside \\" a string","list":[1,{"x":2}]}\nHope that helps.'), { text: "a } inside \" a string", list: [1, { x: 2 }] });
  assert.deepEqual(extractJson('﻿  {"ok":true}  '), { ok: true });
});

test("extractJson skips a broken object and finds the next good one, or gives up", () => {
  assert.deepEqual(extractJson('{not json} then {"ok":true}'), { ok: true });
  assert.equal(extractJson("no json here"), undefined);
  assert.equal(extractJson('{"open": [1, 2'), undefined);
});

test("conformToSchema accepts valid answers, drops unknown keys and trims long lists", () => {
  const result = conformToSchema({ summary: "s", items: [{ name: "a", rate: 1, extra: 1 }, { name: "b", rate: null }, { name: "c", rate: 0.5 }], note: null, chatty: "x" }, schema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, { summary: "s", items: [{ name: "a", rate: 1 }, { name: "b", rate: null }], note: null });
});

test("conformToSchema reports the first problem with its path", () => {
  const missing = conformToSchema({ summary: "s", items: [] }, schema);
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.error : "", /missing "note"/);
  const wrongType = conformToSchema({ summary: "s", items: [{ name: "a", rate: "12%" }], note: null }, schema);
  assert.match(!wrongType.ok ? wrongType.error : "", /\$\.items\[0\]\.rate: expected number or null, got string/);
  const badEnum = conformToSchema({ summary: "s", items: [], note: null, kind: "other" }, schema);
  assert.equal(badEnum.ok, false);
  assert.equal(conformToSchema({ summary: "s", items: [], note: null }, { ...schema, properties: { ...schema.properties, items: { type: "array", minItems: 1 } } }).ok, false);
});

test("parseCliEnvelope reads the Gemini CLI JSON envelope even after log lines", () => {
  const envelope = JSON.stringify({ session_id: "x", response: "```json\n{\"ok\":true}\n```", stats: { models: {} } }, null, 2);
  const parsed = parseCliEnvelope(`Loaded cached credentials.\n${envelope}\n`);
  assert.equal(parsed?.response, "```json\n{\"ok\":true}\n```");
  assert.deepEqual(extractJson(parsed?.response ?? ""), { ok: true });
  assert.equal(parseCliEnvelope(JSON.stringify({ error: { type: "Error", message: "boom" } }))?.error?.message, "boom");
  assert.equal(parseCliEnvelope("not json at all"), null);
});

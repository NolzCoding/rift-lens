// Pure helpers for AI providers without an output-schema flag (Gemini CLI): pull one JSON value out of the model's
// text and check it against the subset of JSON Schema that lib/*-schema.json files use. No I/O, so it is unit-tested.

export type JsonSchema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
};

/** Every balanced {...} or [...] that starts at `start`, respecting strings and escapes. Returns the end index or -1. */
function balancedEnd(text: string, start: number) {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

/**
 * Parses the JSON answer out of a model reply: the whole text, else the body of a ```json fence, else the first balanced
 * object in the text (prose before/after is ignored). Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^﻿/, "");
  const attempts: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) attempts.push(match[1].trim());
  for (const candidate of attempts) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the next shape */ }
  }
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const end = balancedEnd(trimmed, start);
    if (end === -1) continue;
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* keep scanning */ }
  }
  return undefined;
}

function typeOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string) {
  return expected === actual || (expected === "number" && actual === "integer");
}

/**
 * Checks `value` against the schema subset (type, required, properties, items, enum, anyOf). Unknown keys are dropped
 * where the schema says `additionalProperties: false`, so a chatty model does not fail on an extra field.
 * Returns the cleaned value, or the first problem as a short path message.
 */
export function conformToSchema(value: unknown, schema: JsonSchema, at = "$"): { ok: true; value: unknown } | { ok: false; error: string } {
  if (schema.anyOf?.length) {
    let first = "";
    for (const option of schema.anyOf) {
      const result = conformToSchema(value, option, at);
      if (result.ok) return result;
      first ||= result.error;
    }
    return { ok: false, error: first || `${at}: matches no allowed shape` };
  }
  const actual = typeOf(value);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => typeMatches(type, actual))) return { ok: false, error: `${at}: expected ${types.join(" or ")}, got ${actual}` };
  if (schema.enum && !schema.enum.some((option) => option === value)) return { ok: false, error: `${at}: not one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}` };
  if (actual === "array") {
    const list = value as unknown[];
    if (schema.minItems !== undefined && list.length < schema.minItems) return { ok: false, error: `${at}: needs at least ${schema.minItems} entries` };
    if (!schema.items) return { ok: true, value: list };
    const cleaned: unknown[] = [];
    for (let index = 0; index < list.length; index++) {
      const result = conformToSchema(list[index], schema.items, `${at}[${index}]`);
      if (!result.ok) return result;
      cleaned.push(result.value);
    }
    return { ok: true, value: schema.maxItems !== undefined ? cleaned.slice(0, schema.maxItems) : cleaned };
  }
  if (actual === "object" && (schema.properties || schema.required)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) return { ok: false, error: `${at}: missing "${key}"` };
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties !== false) cleaned[key] = entry;
        continue;
      }
      const result = conformToSchema(entry, property, `${at}.${key}`);
      if (!result.ok) return result;
      cleaned[key] = result.value;
    }
    return { ok: true, value: cleaned };
  }
  return { ok: true, value };
}

/** The Gemini CLI `--output-format json` envelope: `{ response, stats, error }`. Tolerates log lines before it. */
export function parseCliEnvelope(stdout: string): { response?: string; error?: { message?: string; type?: string; code?: unknown }; stats?: unknown } | null {
  const trimmed = stdout.trim();
  for (let start = trimmed.lastIndexOf("\n{"); ; start = trimmed.lastIndexOf("\n{", start - 1)) {
    const from = start === -1 ? trimmed.indexOf("{") : start + 1;
    if (from === -1) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(from)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ReturnType<typeof parseCliEnvelope>;
    } catch { /* an earlier line may start the envelope */ }
    if (start <= 0) return null;
  }
}

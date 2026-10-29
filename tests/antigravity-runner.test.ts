// Antigravity CLI runner (lib/antigravity-runner.ts) against a fake `agy` that behaves like the documented headless mode.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/antigravity-runner.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import { antigravityStatus, resetAntigravityRunner, runAntigravityJson } from "@/lib/antigravity-runner";

const folder = await mkdtemp(path.join(os.tmpdir(), "rift-lens-agy-"));
const schemaPath = path.join(folder, "schema.json");
await writeFile(schemaPath, JSON.stringify({
  type: "object", additionalProperties: false, required: ["answer", "items"],
  properties: { answer: { type: "string" }, items: { type: "array", items: { type: "string" } } },
}));
const savedPath = process.env.RIFT_LENS_AGY_PATH;
after(() => { if (savedPath === undefined) delete process.env.RIFT_LENS_AGY_PATH; else process.env.RIFT_LENS_AGY_PATH = savedPath; });
beforeEach(() => resetAntigravityRunner());

/** A fake agy: `behaviour` gets the args and the piped stdin and writes like the CLI would. */
async function fakeAgy(name: string, behaviour: string) {
  const file = path.join(folder, `${name}.mjs`);
  await writeFile(file, `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const envelope = (response, status = "SUCCESS") => process.stdout.write(JSON.stringify({ conversation_id: "c1", status, response, num_turns: 1 }) + "\\n");
  ${behaviour}
});`);
  process.env.RIFT_LENS_AGY_PATH = file;
  // The runner remembers where it found agy: forget it so this fake is used.
  resetAntigravityRunner();
}
const run = () => runAntigravityJson({ cacheRoot: folder, schemaPath, prompt: "Say hi.", model: "unused", reasoning: "low", timeoutMs: 60_000 });

test("antigravity: prompt on stdin, read-only plan mode, JSON envelope; the reply is extracted and checked", async () => {
  await fakeAgy("ok", `
    if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "plan") { process.stderr.write("not read-only"); process.exit(3); }
    if (!input.includes("Say hi.") || !input.includes("OUTPUT FORMAT")) { process.stderr.write("prompt missing"); process.exit(4); }
    envelope("Here you go:\\n\`\`\`json\\n{\\"answer\\":\\"hi\\",\\"items\\":[\\"a\\"]}\\n\`\`\`");`);
  assert.deepEqual(await run(), { answer: "hi", items: ["a"] });
  assert.equal((await antigravityStatus()).signedIn, true, "a successful call proves the login");
});

test("antigravity: 'authentication required' is a sign-in error with the hint, and the status says so", async () => {
  await fakeAgy("auth", `process.stderr.write("Error: authentication required. Run agy to sign in."); process.exit(1);`);
  await assert.rejects(run, (error: Error & { details?: string }) => /not signed in/.test(error.message) && /agy/.test(error.details || ""));
  assert.match((await antigravityStatus()).hint, /sign in/);
});

test("antigravity: a CLI that ignores stdin gets the prompt as -p instead", async () => {
  await fakeAgy("needs-p", `
    const at = args.indexOf("-p");
    if (at === -1) process.exit(0);
    if (!args[at + 1].includes("Say hi.")) process.exit(5);
    envelope(JSON.stringify({ answer: "via -p", items: [] }));`);
  assert.deepEqual(await run(), { answer: "via -p", items: [] });
});

test("antigravity: a reply that does not fit the schema is asked for once more, then rejected", async () => {
  await fakeAgy("bad", `envelope(input.includes("could not be used") ? JSON.stringify({ answer: "fixed", items: [] }) : JSON.stringify({ answer: 3 }));`);
  assert.deepEqual(await run(), { answer: "fixed", items: [] });
  await fakeAgy("worse", `envelope("no json here");`);
  await assert.rejects(run, /could not read/);
});

test("antigravity: a non-success status or a usage limit is reported, not parsed", async () => {
  await fakeAgy("quota", `process.stdout.write(JSON.stringify({ status: "ERROR", error: "Weekly usage limit reached for your plan" }) + "\\n"); process.exit(1);`);
  await assert.rejects(run, /usage limit/);
});

test("provider setting: a Gemini choice saved before Antigravity existed means Antigravity; one saved since stays Gemini", async () => {
  const { aiProviderChoice, setAiProvider } = await import("@/lib/ai-runner");
  const savedMemory = process.env.RIFT_LENS_MEMORY_DIR;
  process.env.RIFT_LENS_MEMORY_DIR = await mkdtemp(path.join(os.tmpdir(), "rift-lens-memory-"));
  try {
    await writeFile(path.join(process.env.RIFT_LENS_MEMORY_DIR, "ai-settings.json"), JSON.stringify({ provider: "gemini" }));
    assert.equal((await aiProviderChoice()).provider, "antigravity");
    await setAiProvider("gemini");
    assert.equal((await aiProviderChoice()).provider, "gemini", "chosen on purpose after the update");
    await setAiProvider("codex");
    assert.equal((await aiProviderChoice()).provider, "codex");
  } finally {
    if (savedMemory === undefined) delete process.env.RIFT_LENS_MEMORY_DIR; else process.env.RIFT_LENS_MEMORY_DIR = savedMemory;
  }
});

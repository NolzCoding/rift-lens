import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { conformToSchema, extractJson, parseCliEnvelope, type JsonSchema } from "@/lib/ai-json";
import { CodexRunError, type CodexJsonOptions } from "@/lib/codex-runner";

// Spawns Google's Gemini CLI (`gemini -p`, signed in with a Google account — never an API key) for one JSON answer.
// The CLI has no output-schema flag, so the schema goes into the prompt and the reply is extracted + checked here.
//
// Headless shape (gemini-cli 0.31): prompt on stdin, `-p <short instruction>` forces non-interactive mode, and
// `--output-format json` prints `{ session_id, response, stats, error? }` on stdout. In default approval mode the
// headless CLI already removes shell/edit/write/web_fetch; the per-call workspace settings below also deny every
// other local tool, and leave `google_web_search` (+ `web_fetch`) on only for the build-research call.

const MAX_OUTPUT = 2_000_000;
export const GEMINI_SIGN_IN_HINT = "Run `gemini` once in a terminal and sign in with Google (choose \"Login with Google\"), then try again.";
const SIGN_IN_PROMPT = /Opening authentication page|authorize the application|Enter the authorization code|Do you want to continue\? \[Y\/n\]/i;
const LOCAL_TOOLS = [
  "run_shell_command", "replace", "write_file", "read_file", "read_many_files", "glob", "grep_search", "list_directory",
  "save_memory", "write_todos", "get_internal_docs", "activate_skill", "ask_user", "enter_plan_mode", "exit_plan_mode",
];
const WEB_TOOLS = ["google_web_search", "web_fetch"];

type RunnerState = { entry?: Promise<GeminiCommand | null>; prepared: Map<string, Promise<string>> };
const state: RunnerState = ((globalThis as { __riftLensGeminiRunner?: RunnerState }).__riftLensGeminiRunner ??= { prepared: new Map() });

type GeminiCommand = { command: string; prefix: string[] };

async function exists(file: string) {
  try { await access(file); return true; } catch { return false; }
}

/**
 * The CLI's JS entry run with this Node (no `.cmd` shim, so no cmd.exe quoting and no shell). Order:
 * RIFT_LENS_GEMINI_PATH (a .js entry or an executable), the npm global folder, then any PATH folder holding `gemini.cmd`.
 */
async function findGemini(): Promise<GeminiCommand | null> {
  const override = process.env.RIFT_LENS_GEMINI_PATH;
  if (override && await exists(override)) {
    return /\.(c|m)?js$/i.test(override) ? { command: process.execPath, prefix: ["--no-warnings=DEP0040", override] } : { command: override, prefix: [] };
  }
  const entryIn = (folder: string) => path.join(folder, "node_modules", "@google", "gemini-cli", "dist", "index.js");
  const folders = [
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : []),
    ...(process.env.npm_config_prefix ? [process.env.npm_config_prefix, path.join(process.env.npm_config_prefix, "lib")] : []),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((folder) => process.platform === "win32" ? folder : path.join(folder, "..", "lib")),
  ];
  for (const folder of folders) {
    const entry = entryIn(folder);
    if (await exists(entry)) return { command: process.execPath, prefix: ["--no-warnings=DEP0040", entry] };
  }
  if (process.platform !== "win32") {
    for (const folder of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const binary = path.join(folder, "gemini");
      if (await exists(binary)) return { command: binary, prefix: [] };
    }
  }
  return null;
}

export function geminiCommand() {
  const pending = state.entry ??= findGemini();
  // A miss is re-checked next time (the user may install the CLI while Rift Lens runs).
  pending.then((found) => { if (!found) state.entry = undefined; }, () => { state.entry = undefined; });
  return pending;
}

/** The Gemini CLI's config folder (honours GEMINI_CLI_HOME like the CLI does). */
function geminiDir() {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini");
}

/**
 * Whether a Google login is cached. The CLI keeps it in `~/.gemini/oauth_creds.json` by default; with
 * GEMINI_FORCE_ENCRYPTED_FILE_STORAGE it uses the OS keychain / an encrypted file we cannot inspect, so that counts as yes.
 * Only existence is checked — the file is never read.
 */
export async function geminiSignedIn() {
  if (process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === "true") return true;
  return exists(path.join(geminiDir(), "oauth_creds.json"));
}

/** Installed + signed in, for status displays. Never starts the CLI. */
export async function geminiStatus() {
  const [command, signedIn] = await Promise.all([geminiCommand(), geminiSignedIn()]);
  return {
    installed: Boolean(command),
    signedIn: Boolean(command) && signedIn,
    hint: !command ? "Install it with `npm install -g @google/gemini-cli`, then run `gemini` once and sign in with Google." : signedIn ? "" : GEMINI_SIGN_IN_HINT,
  };
}

function cleanEnvironment() {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", NO_BROWSER: "true", GEMINI_CLI_NO_RELAUNCH: "true", GOOGLE_GENAI_USE_GCA: "true" };
  // Google-login mode only: never hand the CLI an API key (or an OpenAI one) from this process.
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY", "CODEX_API_KEY", "CI"]) delete environment[key];
  return environment;
}

/** `<cacheRoot>/gemini-<web|offline>`: an empty working folder whose `.gemini/settings.json` limits the tools. */
function prepareWorkspace(cacheRoot: string, webSearch: boolean) {
  const folder = path.join(cacheRoot, webSearch ? "gemini-web" : "gemini-offline");
  let pending = state.prepared.get(folder);
  if (!pending) {
    pending = (async () => {
      await mkdir(path.join(folder, ".gemini"), { recursive: true });
      const settings = {
        tools: { exclude: webSearch ? LOCAL_TOOLS : [...LOCAL_TOOLS, ...WEB_TOOLS], ...(webSearch ? { allowed: WEB_TOOLS } : {}) },
        context: { includeDirectoryTree: false },
      };
      await writeFile(path.join(folder, ".gemini", "settings.json"), JSON.stringify(settings, null, 2), "utf8");
      return folder;
    })();
    state.prepared.set(folder, pending);
    pending.catch(() => state.prepared.delete(folder));
  }
  return pending;
}

function stopTree(pid: number | undefined, kill: () => void) {
  if (process.platform === "win32" && pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", kill);
  } else kill();
}

function runGemini(command: GeminiCommand, args: string[], cwd: string, input: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command.command, [...command.prefix, ...args], { cwd, env: cleanEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "output" | "sign-in" | null = null;
    const stop = (reason: NonNullable<typeof stopped>) => { if (!stopped) { stopped = reason; stopTree(child.pid, () => child.kill()); } };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const capture = (target: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (target === "stdout") stdout += text; else stderr += text;
      // No cached login: the CLI asks on the terminal. Never answer it from here — stop and tell the user.
      if (SIGN_IN_PROMPT.test(text)) stop("sign-in");
      if (stdout.length + stderr.length > MAX_OUTPUT) stop("output");
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.stdin.on("error", () => { /* the CLI may exit before reading all of stdin */ });
    child.on("error", (error) => { clearTimeout(timer); reject(new CodexRunError("Gemini CLI could not be started.", error.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped === "sign-in") reject(new CodexRunError("Gemini CLI is not signed in.", GEMINI_SIGN_IN_HINT));
      else if (stopped === "timeout") reject(new CodexRunError(`Gemini took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
      else if (stopped === "output") reject(new CodexRunError("Gemini returned too much output and was stopped."));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

/** Model per reasoning level: "low" (in-game Quick reads) → the flash alias; otherwise the CLI's own default (auto routing). */
export function geminiModelFor(reasoning: string) {
  if (reasoning === "low") return process.env.RIFT_LENS_GEMINI_MODEL_FAST || process.env.RIFT_LENS_GEMINI_MODEL || "flash";
  return process.env.RIFT_LENS_GEMINI_MODEL || "";
}

export function geminiModelLabel(reasoning: string) {
  return `gemini:${geminiModelFor(reasoning) || "default"}`;
}

function outputInstructions(schema: JsonSchema, webSearch: boolean) {
  return [
    "",
    "---",
    webSearch
      ? "Research with the google_web_search tool (and web_fetch for the pages it finds) before answering; cite only pages you actually used. Do not use any other tool."
      : "Do not call any tools; answer from the information above.",
    "OUTPUT FORMAT (strict): reply with exactly one JSON object and nothing else: no prose, no markdown, no code fences.",
    "It must validate against this JSON Schema: every \"required\" key present, no extra keys, null only where the schema allows it.",
    JSON.stringify(schema),
  ].join("\n");
}

function failureFrom(result: { stdout: string; stderr: string; code: number | null }) {
  const envelope = parseCliEnvelope(result.stdout);
  const message = envelope?.error?.message || "";
  const tail = `${message}\n${result.stderr}`.trim();
  if (/\bauth(entication|orization|enticate)?\b|\blogin\b|credential|sign.?in|consent|oauth|Auth method/i.test(tail)) {
    return new CodexRunError("Gemini CLI is not signed in with Google.", `${GEMINI_SIGN_IN_HINT}${message ? ` (${message.slice(0, 300)})` : ""}`);
  }
  if (/quota|rate.?limit|429|RESOURCE_EXHAUSTED/i.test(tail)) {
    return new CodexRunError("Gemini's free-tier limit was reached. Try again later or switch the AI provider to Codex.", tail.slice(-1200));
  }
  return new CodexRunError("Gemini CLI could not finish the analysis.", tail.slice(-1600));
}

/** One headless `gemini -p` turn: schema in the prompt, JSON pulled from `response`, one retry when it does not fit. */
export async function runGeminiJson(options: CodexJsonOptions): Promise<unknown> {
  const command = await geminiCommand();
  if (!command) throw new CodexRunError("Gemini CLI was not found on this computer.", "Install it with `npm install -g @google/gemini-cli`, then run `gemini` once and sign in with Google.");
  if (!await geminiSignedIn()) throw new CodexRunError("Gemini CLI is not signed in with Google.", GEMINI_SIGN_IN_HINT);
  const schema = JSON.parse(await readFile(options.schemaPath, "utf8")) as JsonSchema;
  const webSearch = options.webSearch === true;
  const cwd = await prepareWorkspace(options.cacheRoot, webSearch);
  const model = geminiModelFor(options.reasoning);
  const args = [
    "-p", "Answer the request above with only the JSON object it describes.",
    "--output-format", "json", "--approval-mode", "default", "-e", "none", "--allowed-mcp-server-names", "rift-lens-no-mcp",
    ...(model ? ["-m", model] : []),
  ];
  const deadline = Date.now() + options.timeoutMs;
  let prompt = `${options.prompt}\n${outputInstructions(schema, webSearch)}`;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    const result = await runGemini(command, args, cwd, prompt, remaining);
    const envelope = parseCliEnvelope(result.stdout);
    if (result.code !== 0 || envelope?.error || typeof envelope?.response !== "string") throw failureFrom(result);
    const parsed = extractJson(envelope.response);
    const checked = parsed === undefined ? { ok: false as const, error: "the reply was not JSON" } : conformToSchema(parsed, schema);
    if (checked.ok) return checked.value;
    lastProblem = `${checked.error}\n${envelope.response.slice(-800)}`;
    prompt = `${options.prompt}\n${outputInstructions(schema, webSearch)}\n\nYour previous reply could not be used (${checked.error}). Reply again with only the corrected JSON object.`;
  }
  throw new CodexRunError("Gemini returned advice Rift Lens could not read.", lastProblem.slice(-1200));
}

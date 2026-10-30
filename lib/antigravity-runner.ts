import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { conformToSchema, extractJson, parseCliEnvelope, type JsonSchema } from "@/lib/ai-json";
import { CodexRunError, type CodexJsonOptions } from "@/lib/codex-runner";

// Spawns Google's Antigravity CLI (`agy`, signed in with a Google account — Google AI Pro/Ultra or the free plan — never
// an API key) for one JSON answer. Google replaced Gemini CLI with it for personal accounts on 2026-06-18.
//
// Headless shape (antigravity.google/docs/cli/headless, agy 1.1.x): with stdin piped and no `-p`, agy runs one prompt
// from stdin and exits; `--output-format json` prints one envelope `{ conversation_id, status, response, error?, … }`.
// `--mode plan` is read-only (no file edits, no shell); the run happens in an empty folder of its own (`--add-dir`).
// The schema goes in the prompt and the reply is extracted + checked here, as for Gemini CLI. A run without a cached
// Google login exits with "authentication required" instead of waiting for input.

const MAX_OUTPUT = 2_000_000;
export const AGY_SIGN_IN_HINT = "Run `agy` once in a terminal and sign in with your Google account, then try again.";
export const AGY_INSTALL_HINT = "Install Antigravity CLI (PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`), then run `agy` once and sign in with Google.";
/** The longest prompt passed as a `-p` argument when piping stdin did not work (Windows caps a command line at 32,767 chars). */
const ARGUMENT_PROMPT_LIMIT = 24_000;

/** The executable, or Node + a script (RIFT_LENS_AGY_PATH pointing at a .js file, used by the tests). */
type AgyCommand = { command: string; prefix: string[] };
type RunnerState = { binary?: Promise<AgyCommand | null>; signedIn: boolean | null; workspace?: Promise<string> };
const state: RunnerState = ((globalThis as { __riftLensAgyRunner?: RunnerState }).__riftLensAgyRunner ??= { signedIn: null });

async function exists(file: string) {
  try { await access(file); return true; } catch { return false; }
}

/** `agy.exe` up to two folders deep under `root` (the Windows installer's folder layout is not documented). */
async function findBelow(root: string, name: string, depth = 2): Promise<string | null> {
  if (await exists(path.join(root, name))) return path.join(root, name);
  if (depth <= 0) return null;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findBelow(path.join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** RIFT_LENS_AGY_PATH, then PATH, then the installer's folders (%LOCALAPPDATA%\Antigravity on Windows, ~/.local/bin elsewhere). */
async function findAgy(): Promise<AgyCommand | null> {
  const override = process.env.RIFT_LENS_AGY_PATH;
  if (override && await exists(override)) return /\.(c|m)?js$/i.test(override) ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  const found = await findAgyExecutable();
  return found ? { command: found, prefix: [] } : null;
}

async function findAgyExecutable(): Promise<string | null> {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  for (const folder of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (await exists(path.join(folder, name))) return path.join(folder, name);
  }
  if (process.platform === "win32") return process.env.LOCALAPPDATA ? findBelow(path.join(process.env.LOCALAPPDATA, "Antigravity"), name) : null;
  const local = path.join(os.homedir(), ".local", "bin", name);
  return await exists(local) ? local : null;
}

export function agyBinary() {
  const pending = state.binary ??= findAgy();
  // A miss is re-checked next time (the user may install the CLI while Rift Lens runs).
  pending.then((found) => { if (!found) state.binary = undefined; }, () => { state.binary = undefined; });
  return pending;
}

/**
 * Installed + signed in, for status displays. Never starts the CLI. The login sits in the OS credential store (Windows
 * Credential Manager), which Rift Lens does not read, so "signed in" is only known after a call: null until then.
 */
export async function antigravityStatus() {
  const binary = await agyBinary();
  return {
    installed: Boolean(binary),
    signedIn: Boolean(binary) && state.signedIn === true,
    hint: !binary ? AGY_INSTALL_HINT : state.signedIn === false ? AGY_SIGN_IN_HINT : state.signedIn === null ? "Installed. Sign-in is checked on the first AI call (run `agy` once to sign in)." : "",
  };
}

function cleanEnvironment() {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // Google-login mode only: never hand the CLI an API key from this process.
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete environment[key];
  return environment;
}

/** `<cacheRoot>/agy`: an empty working folder, so the agent sees no project files. */
function workspace(cacheRoot: string) {
  const folder = path.join(cacheRoot, "agy");
  state.workspace ??= mkdir(folder, { recursive: true }).then(() => folder);
  state.workspace.catch(() => { state.workspace = undefined; });
  return state.workspace;
}

function stopTree(pid: number | undefined, kill: () => void) {
  if (process.platform === "win32" && pid) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", kill);
  } else kill();
}

function runAgy(binary: AgyCommand, args: string[], cwd: string, input: string | null, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Hidden console, not detached: a detached process has no console on Windows, so agy (or what it starts) opened a
    // visible window on every call. A sign-in it cannot do headless ends in "authentication required" or the timeout.
    const child = spawn(binary.command, [...binary.prefix, ...args], { cwd, env: cleanEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "output" | null = null;
    const stop = (reason: NonNullable<typeof stopped>) => { if (!stopped) { stopped = reason; stopTree(child.pid, () => child.kill()); } };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const capture = (target: "stdout" | "stderr") => (chunk: Buffer | string) => {
      if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT) stop("output");
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.stdin.on("error", () => { /* the CLI may exit before reading all of stdin */ });
    child.on("error", (error) => { clearTimeout(timer); reject(new CodexRunError("Antigravity CLI could not be started.", error.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped === "timeout") reject(new CodexRunError(`Antigravity took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
      else if (stopped === "output") reject(new CodexRunError("Antigravity returned too much output and was stopped."));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.end(input ?? "");
  });
}

/** `--effort` per reasoning level; a model only when set (RIFT_LENS_AGY_MODEL / _FAST for quick reads), else agy's default. */
export function agyOptions(reasoning: string) {
  const effort = reasoning === "low" || reasoning === "high" ? reasoning : "medium";
  const model = (reasoning === "low" ? process.env.RIFT_LENS_AGY_MODEL_FAST : "") || process.env.RIFT_LENS_AGY_MODEL || "";
  return { effort, model };
}

export function agyModelLabel(reasoning: string) {
  const { effort, model } = agyOptions(reasoning);
  return `antigravity:${model || "default"}:${effort}`;
}

function outputInstructions(schema: JsonSchema, webSearch: boolean) {
  return [
    "",
    "---",
    webSearch
      ? "Research with web search (and open the pages it finds) before answering; cite only pages you actually used. Do not read or change local files and do not run commands."
      : "Do not call any tools; answer from the information above.",
    "OUTPUT FORMAT (strict): reply with exactly one JSON object and nothing else: no prose, no markdown, no code fences.",
    "It must validate against this JSON Schema: every \"required\" key present, no extra keys, null only where the schema allows it.",
    JSON.stringify(schema),
  ].join("\n");
}

type Envelope = ReturnType<typeof parseCliEnvelope> & { status?: string };

function failureFrom(result: { stdout: string; stderr: string; code: number | null }, envelope: Envelope | null) {
  const message = typeof envelope?.error === "string" ? envelope.error : envelope?.error?.message || "";
  const tail = `${message}\n${result.stderr}`.trim();
  if (/authentication required|not (signed|logged) in|sign.?in|log.?in|oauth|credential/i.test(tail)) {
    state.signedIn = false;
    return new CodexRunError("Antigravity CLI is not signed in with Google.", `${AGY_SIGN_IN_HINT}${message ? ` (${message.slice(0, 300)})` : ""}`);
  }
  if (/quota|credits?|rate.?limit|429|RESOURCE_EXHAUSTED|usage limit/i.test(tail)) {
    return new CodexRunError("Antigravity's usage limit was reached. Try again later or switch the AI provider to Codex.", tail.slice(-1200));
  }
  return new CodexRunError("Antigravity CLI could not finish the analysis.", tail.slice(-1600) || `exit code ${result.code}`);
}

/**
 * One headless agy turn, prompt on stdin. When that produced no envelope at all (a CLI that wants `-p`), it is repeated
 * once with the prompt as the `-p` argument if it fits on a command line.
 */
async function turn(binary: AgyCommand, base: string[], cwd: string, prompt: string, deadline: number) {
  let result = await runAgy(binary, base, cwd, prompt, deadline - Date.now());
  let envelope = parseCliEnvelope(result.stdout) as Envelope | null;
  if (!envelope && prompt.length <= ARGUMENT_PROMPT_LIMIT && deadline - Date.now() > 15_000 && !/authentication required/i.test(result.stderr)) {
    result = await runAgy(binary, ["-p", prompt, ...base], cwd, null, deadline - Date.now());
    envelope = parseCliEnvelope(result.stdout) as Envelope | null;
  }
  return { result, envelope };
}

/** One headless agy turn: schema in the prompt, JSON pulled from `response`, one retry when it does not fit. */
export async function runAntigravityJson(options: CodexJsonOptions): Promise<unknown> {
  const binary = await agyBinary();
  if (!binary) throw new CodexRunError("Antigravity CLI was not found on this computer.", AGY_INSTALL_HINT);
  const schema = JSON.parse(await readFile(options.schemaPath, "utf8")) as JsonSchema;
  const webSearch = options.webSearch === true;
  const cwd = await workspace(options.cacheRoot);
  const { effort, model } = agyOptions(options.reasoning);
  const deadline = Date.now() + options.timeoutMs;
  const minutes = Math.max(1, Math.ceil(options.timeoutMs / 60_000));
  const base = ["--output-format", "json", "--mode", "plan", "--add-dir", cwd, "--effort", effort, "--print-timeout", `${minutes}m`, ...(model ? ["--model", model] : [])];
  let prompt = `${options.prompt}\n${outputInstructions(schema, webSearch)}`;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    const { result, envelope } = await turn(binary, base, cwd, prompt, deadline);
    if (!envelope || envelope.error || (envelope.status && envelope.status !== "SUCCESS") || typeof envelope.response !== "string") throw failureFrom(result, envelope);
    state.signedIn = true;
    const parsed = extractJson(envelope.response);
    const checked = parsed === undefined ? { ok: false as const, error: "the reply was not JSON" } : conformToSchema(parsed, schema);
    if (checked.ok) return checked.value;
    lastProblem = `${checked.error}\n${envelope.response.slice(-800)}`;
    prompt = `${options.prompt}\n${outputInstructions(schema, webSearch)}\n\nYour previous reply could not be used (${checked.error}). Reply again with only the corrected JSON object.`;
  }
  throw new CodexRunError("Antigravity returned advice Rift Lens could not read.", lastProblem.slice(-1200));
}

/** Forget the found CLI and the sign-in result (tests). */
export function resetAntigravityRunner() {
  state.binary = undefined;
  state.signedIn = null;
  state.workspace = undefined;
}

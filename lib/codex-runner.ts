import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Spawns the local Codex CLI (ChatGPT login, never an API key) for one structured JSON answer.
// Process-wide state lives on globalThis so `next dev` route reloads keep the warm login/home cache.

const MAX_OUTPUT = 1_000_000;
const LOGIN_TTL_MS = 10 * 60_000;

export class CodexRunError extends Error {
  constructor(message: string, readonly details = "") { super(message); }
}

type RunnerState = { homes: Map<string, Promise<string>>; logins: Map<string, number>; executable?: Promise<string> };
const state: RunnerState = ((globalThis as { __riftLensCodexRunner?: RunnerState }).__riftLensCodexRunner ??= { homes: new Map(), logins: new Map() });

function cleanEnvironment(codexHome?: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  if (codexHome) environment.CODEX_HOME = codexHome;
  return environment;
}

async function firstExisting(candidates: Array<string | undefined>) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* Try next path. */ }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function codexExecutable() {
  const localBinary = process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
    : path.join(process.cwd(), "node_modules", ".bin", "codex");
  const bundled = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe") : undefined;
  return state.executable ??= firstExisting([process.env.RIFT_LENS_CODEX_PATH, localBinary, process.env.CODEX_CLI_PATH, bundled]);
}

function userAuthPath() {
  const home = process.env.CODEX_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex") : undefined);
  return home ? path.join(home, "auth.json") : undefined;
}

async function readText(file: string) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

async function writeAtomic(file: string, text: string) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text, "utf8");
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

// ChatGPT refresh tokens are single-use: when either copy of auth.json refreshes, the other copy's token is burned
// ("refresh_token_reused"). So every run starts from the user's current login, and a refresh made inside the
// isolated home is written back to ~/.codex — but only if the user's file did not change in the meantime.
export async function withSyncedAuth<T>(codexHome: string, run: () => Promise<T>): Promise<T> {
  const source = userAuthPath();
  const isolated = path.join(codexHome, "auth.json");
  const before = source ? await readText(source) : null;
  if (!before) throw new CodexRunError("Rift Lens could not locate your Codex ChatGPT login.", "Run `codex login` once, then try again.");
  if (await readText(isolated) !== before) {
    try { await writeAtomic(isolated, before); }
    catch { throw new CodexRunError("Rift Lens could not copy your Codex ChatGPT login into its isolated local runtime.", "Run `codex login` once, then try again."); }
  }
  try { return await run(); }
  finally {
    const after = await readText(isolated);
    if (source && after && after !== before && await readText(source) === before) {
      await writeAtomic(source, after).catch((error) => console.error("Rift Lens could not hand the refreshed Codex login back to ~/.codex:", error));
    }
  }
}

async function createCodexHome(cacheRoot: string) {
  const isolatedHome = path.join(cacheRoot, "codex-home");
  await mkdir(isolatedHome, { recursive: true });
  await writeFile(path.join(isolatedHome, "config.toml"), 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n', "utf8");
  await mkdir(path.join(cacheRoot, "runtime"), { recursive: true });
  return isolatedHome;
}

/** Prepares `<cacheRoot>/codex-home` once per process (retried after a failure). */
export function prepareCodexHome(cacheRoot: string) {
  let pending = state.homes.get(cacheRoot);
  if (!pending) {
    pending = createCodexHome(cacheRoot);
    state.homes.set(cacheRoot, pending);
    pending.catch(() => state.homes.delete(cacheRoot));
  }
  return pending;
}

export function runCodex(executable: string, args: string[], cwd: string, input: string | undefined, timeoutMs: number, codexHome?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: cleanEnvironment(codexHome), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const capture = (target: "stdout" | "stderr") => (chunk: Buffer | string) => {
      if (target === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT) child.kill();
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.on("error", (error) => { clearTimeout(timer); reject(new CodexRunError("Codex could not be started.", error.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new CodexRunError(`Codex took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
      else if (stdout.length + stderr.length > MAX_OUTPUT) reject(new CodexRunError("Codex returned too much output and was stopped."));
      else if (code !== 0) reject(new CodexRunError("Codex could not finish the live analysis.", stderr.slice(-1600)));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** `codex login status`, cached for 10 minutes per isolated home; any failure clears the cache. */
export async function assertChatGptLogin(executable: string, cwd: string, codexHome: string, force = false) {
  const checkedAt = state.logins.get(codexHome);
  if (!force && checkedAt && Date.now() - checkedAt < LOGIN_TTL_MS) return;
  state.logins.delete(codexHome);
  const result = await withSyncedAuth(codexHome, () => runCodex(executable, ["login", "status"], cwd, undefined, 15_000, codexHome));
  if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new CodexRunError("HELP ME requires Codex signed in with ChatGPT.", "Run `codex login` and choose ChatGPT sign-in.");
  }
  state.logins.set(codexHome, Date.now());
}

export function forgetLogin(codexHome: string) { state.logins.delete(codexHome); }

// Lean-session overrides, each confirmed against codex-cli 0.157.1 (`--strict-config` accepts the keys,
// `codex features list` knows the feature names). They strip ~9 KB of skills/permissions/environment
// preamble and skip startup work (apps/plugins/hooks connectors, shell snapshot) the JSON coach never uses.
// Set RIFT_LENS_AI_LEAN=0 to fall back to the stock session if a future CLI rejects any of them.
const LEAN_CONFIG = [
  "model_reasoning_summary=\"none\"", "hide_agent_reasoning=true", "project_doc_max_bytes=0",
  "skills.include_instructions=false", "skills.bundled.enabled=false",
  "include_environment_context=false", "include_permissions_instructions=false",
];
const LEAN_DISABLED_FEATURES = ["apps", "plugins", "hooks", "shell_snapshot", "image_generation", "browser_use", "computer_use", "goals", "tool_suggest", "skill_search"];

export type CodexJsonOptions = {
  cacheRoot: string;
  schemaPath: string;
  prompt: string;
  model: string;
  reasoning: string;
  timeoutMs: number;
  /** Passed as model_verbosity when set (e.g. "low" for glanceable answers). */
  verbosity?: "low" | "medium" | "high";
  /**
   * Enables Codex's native live web search (`web_search="live"`) for this one call. Only lib/build-research.ts sets it;
   * every other call (HELP ME, reviews) keeps `web_search="disabled"`.
   */
  webSearch?: boolean;
};

/** One read-only, no-approval `codex exec` turn constrained by an output schema (no web unless `webSearch`). Returns parsed stdout JSON. */
export async function runCodexJson(options: CodexJsonOptions): Promise<unknown> {
  const executable = await codexExecutable();
  const codexHome = await prepareCodexHome(options.cacheRoot);
  await assertChatGptLogin(executable, options.cacheRoot, codexHome);
  const lean = process.env.RIFT_LENS_AI_LEAN !== "0";
  const serviceTier = process.env.RIFT_LENS_AI_SERVICE_TIER;
  const args = [
    "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--sandbox", "read-only", "--color", "never",
    "--model", options.model, "--config", `model_reasoning_effort="${options.reasoning}"`, "--config", 'approval_policy="never"',
    "--config", options.webSearch === true ? 'web_search="live"' : 'web_search="disabled"',
    ...(lean ? [...LEAN_CONFIG.flatMap((entry) => ["--config", entry]), ...LEAN_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])] : []),
    ...(lean && options.verbosity ? ["--config", `model_verbosity="${options.verbosity}"`] : []),
    ...(serviceTier && /^[a-z_-]+$/.test(serviceTier) ? ["--config", `service_tier="${serviceTier}"`] : []),
    "--output-schema", options.schemaPath, "-",
  ];
  let result: { stdout: string; stderr: string };
  try {
    result = await withSyncedAuth(codexHome, () => runCodex(executable, args, path.join(options.cacheRoot, "runtime"), options.prompt, options.timeoutMs, codexHome));
  } catch (error) {
    forgetLogin(codexHome);
    // Turn an opaque exec failure into the actionable login message when that is the cause.
    if (error instanceof CodexRunError && !/longer than|too much output/.test(error.message)) await assertChatGptLogin(executable, options.cacheRoot, codexHome, true);
    throw error;
  }
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw new CodexRunError("Codex returned advice Rift Lens could not read.", result.stdout.slice(-1200)); }
}

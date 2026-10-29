import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { agyModelLabel, antigravityStatus, runAntigravityJson } from "@/lib/antigravity-runner";
import { CodexRunError, codexExecutable, runCodexJson, type CodexJsonOptions } from "@/lib/codex-runner";
import { geminiModelLabel, geminiStatus, runGeminiJson } from "@/lib/gemini-runner";
import { memoryRoot } from "@/lib/memory-store";

// Which local AI CLI answers: Codex (ChatGPT login, the default), Antigravity CLI (Google login: Google AI Pro/Ultra or the
// free plan; Google's replacement for Gemini CLI on personal accounts since 2026-06-18) or Gemini CLI (now only for Gemini
// Code Assist Standard/Enterprise licenses).
// Choice order: the in-app setting (<memory>/ai-settings.json), then RIFT_LENS_AI_PROVIDER, then "codex".

export type AiProvider = "codex" | "antigravity" | "gemini";
export const AI_PROVIDERS: readonly AiProvider[] = ["codex", "antigravity", "gemini"];
export type AiProviderSource = "setting" | "env" | "default";
export const PROVIDER_NAMES: Record<AiProvider, string> = { codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" };
export { CodexRunError as AiRunError };

const settingsFile = () => path.join(memoryRoot(), "ai-settings.json");
const isProvider = (value: unknown): value is AiProvider => AI_PROVIDERS.includes(value as AiProvider);

export function envProvider(): AiProvider | null {
  const value = (process.env.RIFT_LENS_AI_PROVIDER || "").trim().toLowerCase();
  return isProvider(value) ? value : null;
}

/** Settings written since the Antigravity option exists carry this version. */
const SETTINGS_VERSION = 2;

async function savedProvider(): Promise<AiProvider | null> {
  try {
    const stored = JSON.parse(await readFile(settingsFile(), "utf8")) as { provider?: unknown; version?: unknown };
    // "gemini" saved before Antigravity was an option meant "my Google account": Gemini CLI stopped serving personal
    // accounts, so that choice is now Antigravity. A Gemini choice made since (a Code Assist license) stays.
    if (stored.provider === "gemini" && stored.version !== SETTINGS_VERSION) return "antigravity";
    return isProvider(stored.provider) ? stored.provider : null;
  } catch { return null; }
}

export async function aiProviderChoice(): Promise<{ provider: AiProvider; source: AiProviderSource }> {
  const saved = await savedProvider();
  if (saved) return { provider: saved, source: "setting" };
  const fromEnv = envProvider();
  return fromEnv ? { provider: fromEnv, source: "env" } : { provider: "codex", source: "default" };
}

export async function aiProvider() { return (await aiProviderChoice()).provider; }

/** Saves the in-app choice; `null` clears it so RIFT_LENS_AI_PROVIDER (or Codex) applies again. */
export async function setAiProvider(provider: AiProvider | null) {
  const file = settingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ provider, version: SETTINGS_VERSION }, null, 2), "utf8");
  await rename(temporary, file);
}

/** What gets stored as `model` next to an answer, so caches and the UI tell providers apart. */
export function aiModelLabel(provider: AiProvider, codexModel: string, reasoning: string) {
  return provider === "gemini" ? geminiModelLabel(reasoning) : provider === "antigravity" ? agyModelLabel(reasoning) : codexModel;
}

/** Same contract as runCodexJson (prompt + schema file → parsed JSON) for the chosen provider. */
export async function runAiJson(options: CodexJsonOptions & { provider?: AiProvider }): Promise<unknown> {
  const provider = options.provider ?? await aiProvider();
  return provider === "gemini" ? runGeminiJson(options) : provider === "antigravity" ? runAntigravityJson(options) : runCodexJson(options);
}

export const CODEX_SIGN_IN_HINT = "Run `codex login` and choose ChatGPT sign-in.";

/**
 * Cheap readiness check for status displays: never runs a model. Gemini: CLI found + a cached Google login. Antigravity:
 * CLI found; its login is in the OS credential store, so "signed in" is known only after a call.
 * Codex: CLI found + ~/.codex/auth.json present (the real `codex login status` check runs before each call).
 */
export async function aiStatus() {
  const choice = await aiProviderChoice();
  const codexHome = process.env.CODEX_HOME || (process.env.USERPROFILE || process.env.HOME ? path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex") : "");
  const [gemini, antigravity, codexBinary, codexAuth] = await Promise.all([
    geminiStatus(),
    antigravityStatus(),
    codexExecutable(),
    // Existence only: the login file is never read here.
    codexHome ? access(path.join(codexHome, "auth.json")).then(() => true, () => false) : Promise.resolve(false),
  ]);
  // A bare "codex.exe" means no known install path was found; it may still be on PATH, so that is "unknown" (null).
  const codexInstalled = path.isAbsolute(codexBinary) ? true : null;
  return {
    ...choice,
    envProvider: envProvider(),
    providers: {
      codex: { installed: codexInstalled, signedIn: codexAuth, hint: codexAuth ? "" : CODEX_SIGN_IN_HINT },
      antigravity,
      gemini,
    },
  };
}

import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Where the .rofl reader lives: a workspace folder holding `work/rofllens/.venv` (Python) and
 * `outputs/League Replay Reviewer/reviewer.py`. Set RIFT_LENS_REPLAY_WORKSPACE (e.g. in .env.local) when
 * Rift Lens is not inside that workspace; the old layout (two folders up from the app) is the fallback.
 */
export type ReplayTool = { workspace: string; python: string; reviewer: string };

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

export async function findReplayTool(): Promise<ReplayTool | null> {
  const candidates = [process.env.RIFT_LENS_REPLAY_WORKSPACE, path.resolve(process.cwd(), "..", "..")].filter((entry): entry is string => Boolean(entry));
  for (const workspace of candidates) {
    const python = path.join(workspace, "work", "rofllens", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    const reviewer = path.join(workspace, "outputs", "League Replay Reviewer", "reviewer.py");
    if (await exists(python) && await exists(reviewer)) return { workspace, python, reviewer };
  }
  return null;
}

export const REPLAY_TOOL_MISSING = "The replay reader was not found. Set RIFT_LENS_REPLAY_WORKSPACE in .env.local to the folder that contains work\\rofllens and outputs\\League Replay Reviewer, then restart Rift Lens.";

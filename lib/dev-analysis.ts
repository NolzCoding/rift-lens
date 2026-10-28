// Development only: every analyzed replay is saved to .rift-lens/analyses/<replay name>.json (gitignored) so the review
// page can be reopened without the file picker: http://localhost:3000/?analysis=EUW1-1234567890. Disabled in production.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "@/lib/memory-store";
import type { ReplayAnalysis } from "@/lib/types";

export const devAnalysisEnabled = () => process.env.NODE_ENV === "development";
const dir = () => path.join(process.cwd(), ".rift-lens", "analyses");
const fileFor = (name: string) => {
  const safe = path.basename(name).replace(/\.(rofl|json)$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  return safe ? path.join(dir(), `${safe}.json`) : null;
};

export async function saveDevAnalysis(name: string, analysis: ReplayAnalysis) {
  const file = devAnalysisEnabled() ? fileFor(name) : null;
  if (file) await writeJsonAtomic(file, analysis).catch(() => undefined);
}

export async function loadDevAnalysis(name: string): Promise<ReplayAnalysis | null> {
  const file = devAnalysisEnabled() ? fileFor(name) : null;
  if (!file) return null;
  try { return JSON.parse(await readFile(file, "utf8")) as ReplayAnalysis; } catch { return null; }
}

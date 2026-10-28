import type { NextRequest } from "next/server";

import { devAnalysisEnabled, loadDevAnalysis } from "@/lib/dev-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Development only: a saved analysis (lib/dev-analysis.ts) for /?analysis=<replay name>. 404 in production. */
export async function GET(request: NextRequest) {
  if (!devAnalysisEnabled()) return Response.json({ error: "Not found." }, { status: 404 });
  const name = request.nextUrl.searchParams.get("name") || "";
  const analysis = name ? await loadDevAnalysis(name) : null;
  if (!analysis) return Response.json({ error: `No saved analysis named ${name.slice(0, 80)}. Upload the replay once in development to save it.` }, { status: 404 });
  return Response.json(analysis);
}

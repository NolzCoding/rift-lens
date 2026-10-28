import { NextResponse } from "next/server";

import { reloadResearch, requestManualResearch, researchOverview } from "@/lib/build-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** Stored researched builds + research job statuses (the /profile page polls this while a research runs). ?reload=1 re-reads disk. */
export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("reload") === "1") await reloadResearch();
    return NextResponse.json(await researchOverview(), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Build research status unavailable." }, { status: 500, headers });
  }
}

/**
 * Manual "Refresh build data": { champion, role? } starts a web research in the background and returns at once
 * (status "started", or "running"/"busy" when one is already going). Role defaults to the champion's main role.
 */
export async function POST(request: Request) {
  let body: { champion?: unknown; role?: unknown };
  try { body = await request.json() as { champion?: unknown; role?: unknown }; } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  const champion = typeof body?.champion === "string" ? body.champion.trim().slice(0, 40) : "";
  if (!champion) return NextResponse.json({ error: "Champion is required." }, { status: 400, headers });
  try {
    const outcome = await requestManualResearch(champion, body.role);
    return NextResponse.json({ outcome, overview: await researchOverview() }, { status: outcome.status === "busy" ? 409 : 202, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Build research could not start." }, { status: 400, headers });
  }
}

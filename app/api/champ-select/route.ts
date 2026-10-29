import { NextResponse } from "next/server";

import { champSelectView, savePool } from "@/lib/champ-select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** The champion pool, and while the client is in champ select: picks, bans, guessed enemy roles and the ranked pool. `?champions=1` adds every champion name; `?mock=1` uses a made-up champ select. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await champSelectView({ withChampions: params.get("champions") === "1", mock: params.get("mock") === "1" }), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Champ select is unavailable." }, { status: 503, headers });
  }
}

/** `{ pool: [{ champion, roles }] }` saves the champion pool (and queues matchup research for it). */
export async function POST(request: Request) {
  let body: { pool?: unknown };
  try { body = await request.json() as { pool?: unknown }; } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400, headers }); }
  try {
    await savePool(body?.pool);
    return NextResponse.json(await champSelectView(), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the pool." }, { status: 400, headers });
  }
}

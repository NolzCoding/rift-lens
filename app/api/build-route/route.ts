import { NextResponse } from "next/server";

import { saveRouteChoice } from "@/lib/build-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** `{ champion, route }` saves which build route to play on a champion for the next few hours; `route: null` goes back to the recommended one. */
export async function POST(request: Request) {
  let body: { champion?: unknown; route?: unknown };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400, headers }); }
  const champion = typeof body?.champion === "string" ? body.champion.trim().slice(0, 40) : "";
  const route = body?.route === null ? null : typeof body?.route === "string" ? body.route.trim().slice(0, 40) : undefined;
  if (!champion || route === undefined || (route !== null && !/^[a-z0-9-]+$/.test(route))) return NextResponse.json({ error: "A champion and a route are needed." }, { status: 400, headers });
  await saveRouteChoice(champion, route);
  return NextResponse.json({ ok: true }, { headers });
}

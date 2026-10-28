import { NextResponse } from "next/server";

import { ensureResearchLoaded, scheduleChampSelectResearch, scheduleLiveResearch } from "@/lib/build-research";
import { handleOffline, recordSnapshot, soldItemIdsForGame } from "@/lib/game-recorder";
import { scheduleItemSetCapture } from "@/lib/item-set-import";
import { normalizeLiveData, type RawLiveData } from "@/lib/live-game";
import { getPlayerBrief, scheduleMatchHistoryImport } from "@/lib/player-profile";
import { captureRawSample } from "@/lib/raw-capture";
import { replayApi } from "@/lib/replay-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const raw = await replayApi<RawLiveData>("/liveclientdata/allgamedata", "GET", undefined, 2200);
    // Fire-and-forget raw sample for the replay test suite (scripts/check.ts); never throws or blocks.
    captureRawSample(raw);
    // Researched builds are read from disk once per server start; afterwards this resolves immediately.
    await ensureResearchLoaded();
    const snapshot = await normalizeLiveData(raw, { loadBrief: getPlayerBrief, soldItemIds: soldItemIdsForGame });
    recordSnapshot(snapshot);
    // Fire-and-forget, throttled to ~60s in game: never delays the poll.
    scheduleItemSetCapture("live");
    // Fire-and-forget, checked at most every 30s: web-research this champion's build when no current-patch build is known.
    scheduleLiveResearch(snapshot);
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    handleOffline();
    // No live game: the client may be in champ select, where Mobalytics pushes its item set. Throttled to ~10s.
    scheduleItemSetCapture("offline");
    // Fire-and-forget, ~10s: in champ select, research the picked champion's build when no current-patch build is known.
    scheduleChampSelectResearch();
    // Fire-and-forget, at most every 10 min (first poll after server start runs it): learn from the client's match history.
    scheduleMatchHistoryImport();
    const details = error instanceof Error ? error.message : "League's live endpoint did not respond.";
    return NextResponse.json({
      status: "offline",
      reason: details.includes("identify the active player") || details.startsWith("Spectating") ? details : "No active League match detected. Rift Lens will keep checking locally.",
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  }
}

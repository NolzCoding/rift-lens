import { NextResponse } from "next/server";

import { replayApi } from "@/lib/replay-api";

export const runtime = "nodejs";

type ReplayPlayback = {
  paused?: boolean;
  time?: number;
  speed?: number;
  seeking?: boolean;
  [key: string]: unknown;
};

export async function GET() {
  try {
    const playback = await replayApi<ReplayPlayback>("/replay/playback");
    return NextResponse.json({ connected: true, playback });
  } catch {
    return NextResponse.json({ connected: false }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as { timestamp?: unknown; leadIn?: unknown } | null;
  const timestamp = Number(input?.timestamp);
  const leadIn = Number(input?.leadIn ?? 3);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return NextResponse.json({ error: "A valid replay timestamp is required." }, { status: 400 });
  }

  const seekTime = Math.max(0, timestamp - Math.max(0, Math.min(10, leadIn)));
  try {
    const playback = await replayApi<ReplayPlayback>("/replay/playback", "POST", {
      paused: false,
      time: seekTime,
      speed: 1,
      seeking: false,
    });
    return NextResponse.json({ connected: true, seekTime, playback });
  } catch {
    return NextResponse.json(
      {
        connected: false,
        error: "No controllable League replay is running.",
        setup: [
          "Open this .rofl replay in the League client.",
          "Set EnableReplayApi=1 under [General] in League of Legends/Config/game.cfg.",
          "Restart the replay after changing the setting.",
        ],
      },
      { status: 503 },
    );
  }
}

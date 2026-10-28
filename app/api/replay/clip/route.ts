import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { replayApi } from "@/lib/replay-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordingState = {
  recording?: boolean;
  path?: string;
  startTime?: number;
  endTime?: number;
  currentTime?: number;
  [key: string]: unknown;
};

const clipDirectory = path.join(process.cwd(), ".rift-lens", "clips");
const captureTimeoutMs = 120_000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function webmFiles() {
  await mkdir(clipDirectory, { recursive: true });
  const names = await readdir(clipDirectory);
  return names.filter((name) => name.toLowerCase().endsWith(".webm"));
}

async function newestNewClip(previous: Set<string>, startedAt: number, statePath?: string) {
  const directPath = statePath && path.extname(statePath).toLowerCase() === ".webm"
    ? path.resolve(statePath)
    : null;
  if (directPath && path.dirname(directPath) === path.resolve(clipDirectory)) {
    try {
      const details = await stat(directPath);
      if (details.isFile() && details.size > 0) return directPath;
    } catch {
      // The encoder may still be flushing the final file.
    }
  }

  const candidates = await Promise.all((await webmFiles()).map(async (name) => {
    const fullPath = path.join(clipDirectory, name);
    const details = await stat(fullPath);
    return { name, fullPath, details };
  }));
  return candidates
    .filter(({ name, details }) => !previous.has(name) || details.mtimeMs >= startedAt - 1000)
    .filter(({ details }) => details.isFile() && details.size > 0)
    .sort((a, b) => b.details.mtimeMs - a.details.mtimeMs)[0]?.fullPath;
}

function setupResponse() {
  return NextResponse.json(
    {
      connected: false,
      error: "No controllable League replay is running.",
      setup: [
        "Open the same .rofl replay in the League client.",
        "Keep the replay window open while Rift Lens captures the clip.",
        "If it was already open, restart it so EnableReplayApi=1 takes effect.",
      ],
    },
    { status: 503 },
  );
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as {
    timestamp?: unknown;
    before?: unknown;
    after?: unknown;
  } | null;
  const timestamp = Number(input?.timestamp);
  const before = Math.max(1, Math.min(8, Number(input?.before ?? 4)));
  const after = Math.max(2, Math.min(12, Number(input?.after ?? 5)));
  if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isFinite(before) || !Number.isFinite(after)) {
    return NextResponse.json({ error: "A valid replay timestamp is required." }, { status: 400 });
  }

  let recordingState: RecordingState;
  try {
    recordingState = await replayApi<RecordingState>("/replay/recording");
  } catch {
    return setupResponse();
  }
  if (recordingState.recording) {
    return NextResponse.json(
      { error: "League is already capturing another clip. Wait for it to finish and try again." },
      { status: 409 },
    );
  }

  const startTime = Math.max(0, timestamp - before);
  const endTime = timestamp + after;
  const previous = new Set(await webmFiles());
  const startedAt = Date.now();

  try {
    await replayApi("/replay/playback", "POST", {
      paused: false,
      time: startTime,
      speed: 1,
      seeking: false,
    });
    recordingState = await replayApi<RecordingState>("/replay/recording", "POST", {
      recording: true,
      codec: "webm",
      startTime,
      endTime,
      framesPerSecond: 30,
      enforceFrameRate: true,
      lossless: false,
      path: clipDirectory,
    });

    let observedRecording = Boolean(recordingState.recording);
    while (Date.now() - startedAt < captureTimeoutMs) {
      await wait(500);
      recordingState = await replayApi<RecordingState>("/replay/recording");
      observedRecording ||= Boolean(recordingState.recording);
      if (observedRecording && !recordingState.recording) break;
    }

    if (recordingState.recording || !observedRecording) {
      await replayApi("/replay/recording", "POST", { recording: false }).catch(() => undefined);
      return NextResponse.json(
        { error: "The League recorder did not finish the clip in time. Try again with the replay window visible." },
        { status: 504 },
      );
    }

    let clipPath: string | undefined;
    for (let attempt = 0; attempt < 10 && !clipPath; attempt += 1) {
      clipPath = await newestNewClip(previous, startedAt, recordingState.path);
      if (!clipPath) await wait(300);
    }
    if (!clipPath) {
      return NextResponse.json(
        { error: "League finished recording, but Rift Lens could not find the WebM clip." },
        { status: 500 },
      );
    }

    const name = path.basename(clipPath);
    return NextResponse.json({
      connected: true,
      name,
      url: `/api/replay/clip?name=${encodeURIComponent(name)}`,
      startTime,
      endTime,
      duration: endTime - startTime,
    });
  } catch {
    return setupResponse();
  }
}

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!name || path.basename(name) !== name || path.extname(name).toLowerCase() !== ".webm") {
    return NextResponse.json({ error: "Invalid clip name." }, { status: 400 });
  }

  const clipPath = path.join(clipDirectory, name);
  let file: Buffer;
  try {
    file = await readFile(clipPath);
  } catch {
    return NextResponse.json({ error: "Clip not found." }, { status: 404 });
  }

  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${name.replaceAll('"', "")}"`,
    "Content-Type": "video/webm",
  };
  const range = request.headers.get("range");
  if (!range) {
    return new Response(new Uint8Array(file), {
      headers: { ...baseHeaders, "Content-Length": String(file.length) },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= file.length) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.length}` } });
  }
  const chunk = file.subarray(start, end + 1);
  return new Response(new Uint8Array(chunk), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${file.length}`,
    },
  });
}

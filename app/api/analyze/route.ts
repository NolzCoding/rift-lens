import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

import { lcuJson } from "@/lib/lcu";
import { getProfile } from "@/lib/player-profile";
import { enrichAnalysis, findUploader } from "@/lib/replay-enrich";
import { saveDevAnalysis } from "@/lib/dev-analysis";
import { findReplayTool, REPLAY_TOOL_MISSING } from "@/lib/replay-tool";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const form = await request.formData();
  const replay = form.get("replay");
  const deep = form.get("deep") !== "false";

  if (!(replay instanceof File) || !replay.name.toLowerCase().endsWith(".rofl")) {
    return NextResponse.json({ error: "Choose a valid .rofl replay." }, { status: 400 });
  }
  if (replay.size > 80 * 1024 * 1024) {
    return NextResponse.json({ error: "Replay is larger than the 80 MB local limit." }, { status: 400 });
  }

  const tool = await findReplayTool();
  if (!tool) return NextResponse.json({ error: REPLAY_TOOL_MISSING }, { status: 500 });
  const { workspace, python, reviewer } = tool;
  const uploadRoot = path.join(workspace, "work", "web-replay-uploads");
  const id = randomUUID();
  const safeOriginalName = path.basename(replay.name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const replayPath = path.join(uploadRoot, `${id}-${safeOriginalName}`);
  const jsonPath = path.join(uploadRoot, `${id}.json`);

  await mkdir(uploadRoot, { recursive: true });
  const rofl = Buffer.from(await replay.arrayBuffer());
  await writeFile(replayPath, rofl);

  try {
    const args = [reviewer, replayPath, "--json-output", jsonPath];
    if (!deep) args.push("--quick");
    // Review the uploader on whatever champion they played: their Riot ID from the League client (or, for another account
    // or a closed client, the player the match history places on this game id), and their most-played champions as the
    // reader's last fallback.
    const me = await lcuJson<{ gameName?: string; tagLine?: string }>("/lol-summoner/v1/current-summoner").catch(() => null);
    const clientName = me?.gameName ? (me.tagLine ? `${me.gameName}#${me.tagLine}` : me.gameName) : null;
    const playerName = await findUploader(rofl, replay.name, clientName).catch(() => clientName);
    if (playerName) args.push("--player", playerName);
    const played = await getProfile().then((profile) => [...profile.champions].sort((a, b) => b.games - a.games).map((entry) => entry.champion)).catch(() => []);
    if (played.length) args.push("--champions", played.slice(0, 8).join(","));
    await execFileAsync(python, args, {
      cwd: workspace,
      timeout: 280_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    payload.replay.name = replay.name;
    const analysis = await enrichAnalysis(payload, { rofl, fileName: replay.name, playerName });
    await saveDevAnalysis(replay.name, analysis);
    return NextResponse.json(analysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Replay analysis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await Promise.allSettled([unlink(replayPath), unlink(jsonPath)]);
  }
}

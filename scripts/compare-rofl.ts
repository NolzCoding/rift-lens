// Recorder vs replay-analyzer cross-check.
//
//   npm run check:rofl -- <analysis.json> [<game-record.json>]   compare one analysis (auto-matches the record if omitted)
//   npm run check:rofl -- --scan [<dir> ...]                       find cached analysis JSONs and match them to recorded games
//
// <analysis.json> is the output of `reviewer.py <replay.rofl> --json-output <file>` (what app/api/analyze returns;
// shape = ReplayAnalysis in lib/types.ts). Records are matched by champion + duration (±90s) + outcome. Reads only;
// never touches .rofl files.
//
// Note: reviewer.py (schemaVersion 1-2) exports end-of-game stats only: final items, K/D/A, CS, level, outcome. Its own
// report says "exact item purchase order and every death sequence are not yet reconstructed", so the purchase/death
// *timeline* can only be compared when a future analysis adds `purchases` [{time,itemId}] / `deathTimes` [s] per player.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { memoryRoot } from "@/lib/memory-store";
import type { GameRecord, ReplayAnalysis } from "@/lib/types";

import { loadRecords } from "./replay-data";

type AnalysisPlayer = ReplayAnalysis["players"][number] & { purchases?: Array<{ time: number; itemId: number }>; deathTimes?: number[] };
type Analysis = Omit<ReplayAnalysis, "players"> & { players: AnalysisPlayer[] };

const key = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const TRINKETS = /totem|oracle lens|farsight|scarecrow|stealth ward|poro-snax/i;
const DURATION_TOLERANCE = 90;

function readAnalysis(file: string): Analysis | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Analysis;
    return value?.replay && typeof value.replay.durationMs === "number" && Array.isArray(value.players) ? value : null;
  } catch { return null; }
}

function findAnalysisFiles(dirs: string[]) {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (/^(node_modules|\.venv|\.git|codex-home|raw|games)$/i.test(name)) continue;
      const full = path.join(dir, name);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) { if (depth < 5) walk(full, depth + 1); }
      else if (name.endsWith(".json") && info.size < 20 * 1024 * 1024 && readAnalysis(full)) found.push(full);
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return found;
}

function matchRecord(analysis: Analysis, records: GameRecord[]) {
  const seconds = analysis.replay.durationMs / 1000;
  const scored = records.flatMap((record) => {
    const player = analysis.players.find((entry) => key(entry.champion) === key(record.champion));
    if (!player) return [];
    const gap = Math.abs(record.durationSeconds - seconds);
    if (gap > DURATION_TOLERANCE) return [];
    if (record.result !== "unknown" && record.result !== analysis.replay.outcome) return [];
    return [{ record, player, gap }];
  });
  return scored.sort((a, b) => a.gap - b.gap)[0] || null;
}

function compare(analysis: Analysis, player: AnalysisPlayer, record: GameRecord) {
  const mismatches: string[] = [];
  const notes: string[] = [];
  const seconds = Math.round(analysis.replay.durationMs / 1000);
  const diff = (label: string, replay: unknown, recorder: unknown) => { if (replay !== recorder) mismatches.push(`${label}: replay ${replay} vs recorder ${recorder}`); };
  const durationGap = record.durationSeconds - seconds;
  if (Math.abs(durationGap) > 20) mismatches.push(`duration: replay ${clock(seconds)} vs recorder ${clock(record.durationSeconds)} (${durationGap > 0 ? "+" : ""}${durationGap}s)`);
  if (record.result !== "unknown") diff("result", analysis.replay.outcome, record.result);
  diff("kills", player.kills, record.final.kills);
  diff("deaths", player.deaths, record.final.deaths);
  diff("deaths recorded (record.deaths[])", player.deaths, record.deaths.length);
  diff("assists", player.assists, record.final.assists);
  if (Math.abs(player.cs - record.final.cs) > 3) mismatches.push(`cs: replay ${player.cs} vs recorder ${record.final.cs}`);
  diff("level", player.level ?? record.final.level, record.final.level);
  const replayItems = player.items.filter((name) => name && !TRINKETS.test(name)).map(key).sort();
  const recordItems = record.final.items.filter((name) => !TRINKETS.test(name)).map(key).sort();
  const missing = replayItems.filter((name) => !recordItems.includes(name));
  const extra = recordItems.filter((name) => !replayItems.includes(name));
  if (missing.length || extra.length) mismatches.push(`final items: replay-only [${missing.join(", ")}], recorder-only [${extra.join(", ")}]`);

  // Timelines, only when the analysis carries them.
  if (player.purchases?.length) {
    const bought = record.purchases.filter((entry) => entry.kind === "bought");
    for (const purchase of player.purchases) {
      const hit = bought.find((entry) => entry.itemId === purchase.itemId && Math.abs(entry.time - purchase.time) <= 15);
      if (!hit) mismatches.push(`purchase ${purchase.itemId} @${clock(purchase.time)} missing in recorder (±15s)`);
    }
    for (const entry of bought) {
      if (!player.purchases.some((purchase) => purchase.itemId === entry.itemId && Math.abs(entry.time - purchase.time) <= 15)) mismatches.push(`recorder purchase ${entry.item} @${clock(entry.time)} not in replay`);
    }
  } else notes.push("analysis has no purchase timeline: compared final items only");
  if (player.deathTimes?.length) {
    for (const time of player.deathTimes) if (!record.deaths.some((death) => Math.abs(death.time - time) <= 5)) mismatches.push(`death @${clock(time)} missing in recorder (±5s)`);
    for (const death of record.deaths) if (!player.deathTimes.some((time) => Math.abs(death.time - time) <= 5)) mismatches.push(`recorder death @${clock(death.time)} not in replay`);
  } else notes.push("analysis has no death timeline: compared death counts only");
  if (record.partial) notes.push("record is flagged partial (feed opened late / dropped): gaps are expected");
  return { mismatches, notes };
}

function report(file: string, analysis: Analysis, record: GameRecord | null, player: AnalysisPlayer | null) {
  const champs = analysis.players.map((entry) => entry.champion).join("/");
  console.log(`\n${path.basename(file)} · ${analysis.replay.name} · ${champs} · ${clock(analysis.replay.durationMs / 1000)} · ${analysis.replay.outcome}`);
  if (!record || !player) { console.log("  no matching recorded game (champion + duration ±90s + outcome)"); return 0; }
  console.log(`  ↔ record ${record.id} (${record.champion}, ${clock(record.durationSeconds)}, ${record.result})`);
  const { mismatches, notes } = compare(analysis, player, record);
  for (const line of mismatches) console.log(`  MISMATCH ${line}`);
  for (const line of notes) console.log(`  note: ${line}`);
  if (!mismatches.length) console.log("  ok: recorder agrees with the replay");
  return mismatches.length;
}

const args = process.argv.slice(2);
const records = loadRecords().filter((record) => record.durationSeconds > 0);
console.log(`Recorder vs replay cross-check · ${records.length} recorded games in ${path.join(memoryRoot(), "games")}`);
let mismatchCount = 0;
if (!args.length || args[0] === "--scan") {
  const workspace = path.resolve(process.cwd(), "..", "..");
  const dirs = args.length > 1 ? args.slice(1) : [path.join(workspace, "work"), path.join(workspace, "outputs")].filter(existsSync);
  const files = findAnalysisFiles(dirs);
  console.log(`Scanned ${dirs.join(", ")}: ${files.length} analysis JSON file(s).`);
  let matched = 0;
  for (const file of files) {
    const analysis = readAnalysis(file)!;
    const match = matchRecord(analysis, records);
    if (match) matched += 1;
    mismatchCount += report(file, analysis, match?.record || null, match?.player || null);
  }
  if (!matched) console.log("\nNo analysis matched a recorded game. Analyze the .rofl of a recorded game (Replay page), save the JSON, then run:\n  npm run check:rofl -- <analysis.json> [<game-record.json>]");
} else {
  const analysis = readAnalysis(args[0]);
  if (!analysis) { console.error(`Not a replay analysis JSON: ${args[0]}`); process.exit(2); }
  let record: GameRecord | null = null;
  let player: AnalysisPlayer | null = null;
  if (args[1]) {
    record = JSON.parse(readFileSync(args[1], "utf8")) as GameRecord;
    player = analysis.players.find((entry) => key(entry.champion) === key(record!.champion)) || null;
    if (!player) { console.error(`The analysis has no ${record.champion} (players: ${analysis.players.map((entry) => entry.champion).join(", ")}).`); process.exit(2); }
  } else {
    const match = matchRecord(analysis, records);
    record = match?.record || null;
    player = match?.player || null;
  }
  mismatchCount += report(args[0], analysis, record, player);
}
process.exit(mismatchCount ? 1 : 0);

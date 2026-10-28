import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { liveGameId, type RawLiveData } from "@/lib/live-game";
import { memoryRoot } from "@/lib/memory-store";

/**
 * Raw Live Client capture for replay tests (scripts/check.ts).
 *
 * File: <memory>/raw/<YYYYMMDD-HHMMSS start>-<gameId>.jsonl, one JSON line per sample:
 *   { v: 1, at: ISO wall clock, eventsFrom: n, raw: RawLiveData }
 * `raw.events.Events` holds only the events with index >= eventsFrom (the delta since the previous line);
 * concatenate them in order to rebuild the full list (see readRawCapture in scripts/replay-data.ts). Fields the engine never
 * reads (raw* localisation keys, skins, general/stat rune lists, rune/ability ids, item slot flags) are stripped
 * and floats are rounded to 2 decimals.
 * A sample is written every ~10s of game time, and immediately when the active player's items, isDead,
 * level or the event count change (every 30s once a file passes 2 MB). Each file is capped at 3 MB (~9 KB/line,
 * ~35-45 min of game); only the newest 30 files are kept.
 */

const SAMPLE_EVERY_SECONDS = 10;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const KEEP_FILES = 30;
// Never read by lib/live-game.ts (RawLiveData). `id` only appears on runes/abilities; items use itemID, events EventID.
const DROP_KEYS = new Set([
  "rawDescription", "rawDisplayName", "rawChampionName", "rawSkinName", "skinName", "skinID", "generalRunes", "statRunes",
  "id", "isBot", "riotIdGameName", "riotIdTagLine", "teamRelativeColors", "canUse", "consumable", "slot",
]);

type GameCapture = {
  file: string;
  bytes: number;
  lastGameTime: number;
  signature: string;
  eventCount: number;
  full: boolean;
};
type CaptureState = { games: Map<string, GameCapture>; queue: Promise<void>; errorLogged: boolean };

const globalStore = globalThis as typeof globalThis & { __riftLensRawCaptureV1?: CaptureState };
const state: CaptureState = globalStore.__riftLensRawCaptureV1 ??= { games: new Map(), queue: Promise.resolve(), errorLogged: false };

export const rawCaptureDir = () => path.join(memoryRoot(), "raw");

function stamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  // Floats (stats, timers, ward score) to 2 decimals: halves the line size, irrelevant to the engine.
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(name)) continue;
    out[name] = strip(child);
  }
  return out;
}

function activeRawPlayer(raw: RawLiveData) {
  const riotId = raw.activePlayer?.riotId?.toLowerCase();
  const name = raw.activePlayer?.summonerName?.toLowerCase();
  return (raw.allPlayers || []).find((player) => (riotId && player.riotId?.toLowerCase() === riotId) || (name && player.summonerName?.toLowerCase() === name)) || null;
}

function signatureOf(raw: RawLiveData) {
  const me = activeRawPlayer(raw);
  const items = (me?.items || []).map((item) => `${item.itemID}x${item.count ?? 1}`).sort().join(",");
  return `${items}|${me?.isDead ? 1 : 0}|${raw.activePlayer?.level ?? me?.level ?? 0}|${raw.events?.Events?.length ?? 0}`;
}

async function prune(dir: string) {
  // Called just before a new file is created, so keep one slot free for it.
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  for (const name of files.slice(0, Math.max(0, files.length - (KEEP_FILES - 1)))) await unlink(path.join(dir, name)).catch(() => undefined);
}

/**
 * Players only, no champions: liveGameId hashes riotId + championName, and Viego's possession changes his
 * championName mid-game (Yasuo, Morgana, ...), which would split one match across several files.
 */
function rosterKey(raw: RawLiveData) {
  const roster = (raw.allPlayers || []).map((player) => player.riotId || player.summonerName || "").sort().join("|");
  return createHash("sha1").update(roster).digest("hex").slice(0, 16);
}

async function write(raw: RawLiveData) {
  const gameTime = Number(raw.gameData?.gameTime) || 0;
  const roster = rosterKey(raw);
  let capture = state.games.get(roster);
  // Same roster with the clock jumping back: a new match (or a replay); start a fresh file.
  if (capture && gameTime + 30 < capture.lastGameTime) capture = undefined;
  const signature = signatureOf(raw);
  if (capture) {
    if (capture.full) return;
    // Long games: past 2/3 of the cap, periodic samples thin out to every 30s (change-triggered ones still land).
    const every = capture.bytes > MAX_FILE_BYTES * 0.66 ? 30 : SAMPLE_EVERY_SECONDS;
    const due = gameTime - capture.lastGameTime >= every;
    if (!due && signature === capture.signature) return;
  }
  const dir = rawCaptureDir();
  if (!capture) {
    await mkdir(dir, { recursive: true });
    const started = new Date(Date.now() - Math.max(0, gameTime) * 1000);
    // Named with the engine's gameId at first sight, so it lines up with the recorder's GameRecord id.
    const file = path.join(dir, `${stamp(started)}-${liveGameId(raw)}.jsonl`);
    const bytes = await stat(file).then((info) => info.size, () => 0);
    capture = { file, bytes, lastGameTime: -Infinity, signature: "", eventCount: 0, full: false };
    if (state.games.size > 8) state.games.clear();
    state.games.set(roster, capture);
    await prune(dir);
  }
  const events = raw.events?.Events || [];
  const eventsFrom = events.length >= capture.eventCount ? capture.eventCount : 0;
  const compact = strip({ ...raw, events: { Events: events.slice(eventsFrom) } });
  const line = `${JSON.stringify({ v: 1, at: new Date().toISOString(), eventsFrom, raw: compact })}\n`;
  const size = Buffer.byteLength(line);
  if (capture.bytes + size > MAX_FILE_BYTES) {
    capture.full = true;
    console.warn(`[rift-lens] raw capture reached ${MAX_FILE_BYTES / 1024 / 1024} MB for ${path.basename(capture.file)}; further samples skipped.`);
    return;
  }
  await appendFile(capture.file, line, "utf8");
  capture.bytes += size;
  capture.lastGameTime = gameTime;
  capture.signature = signature;
  capture.eventCount = events.length;
}

type RawLine = { v: number; at: string; eventsFrom: number; raw: RawLiveData };

/** Parse one capture file's text, rebuilding each sample's full event list from the per-line deltas. */
export function parseRawCapture(text: string): RawLiveData[] {
  const samples: RawLiveData[] = [];
  let events: NonNullable<NonNullable<RawLiveData["events"]>["Events"]> = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    let line: RawLine;
    try { line = JSON.parse(row) as RawLine; } catch { continue; }
    const delta = line.raw.events?.Events || [];
    events = line.eventsFrom > 0 ? [...events.slice(0, line.eventsFrom), ...delta] : [...delta];
    samples.push({ ...line.raw, events: { Events: events } });
  }
  return samples;
}

/** Every capture file of one match (<stamp>-<gameId>.jsonl), samples in game-time order; [] when none is kept. */
export async function readRawCaptureFor(gameId: string): Promise<RawLiveData[]> {
  if (!/^[0-9a-f]{16}$/.test(gameId)) return [];
  const dir = rawCaptureDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const samples: RawLiveData[] = [];
  for (const name of names.filter((entry) => entry.endsWith(`-${gameId}.jsonl`)).sort()) {
    samples.push(...parseRawCapture(await readFile(path.join(dir, name), "utf8").catch(() => "")));
  }
  return samples.sort((a, b) => (Number(a.gameData?.gameTime) || 0) - (Number(b.gameData?.gameTime) || 0));
}

/** Fire-and-forget: never throws, never awaited by the poll. Writes are serialized so lines stay ordered. */
export function captureRawSample(raw: RawLiveData): void {
  if (process.env.RIFT_LENS_RAW_CAPTURE === "off") return;
  // Spectating / replays have no player of your own (activePlayer: { error }): nothing to replay-test.
  if (raw.activePlayer && "error" in (raw.activePlayer as Record<string, unknown>)) return;
  state.queue = state.queue.then(() => write(raw)).catch((error) => {
    if (state.errorLogged) return;
    state.errorLogged = true;
    console.error("[rift-lens] raw capture failed (logged once):", error);
  });
}

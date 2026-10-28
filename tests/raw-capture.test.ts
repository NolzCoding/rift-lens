// lib/raw-capture.ts writes deltas that scripts/replay-data.ts must rebuild exactly. Runs offline.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/raw-capture.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const memory = mkdtempSync(path.join(tmpdir(), "rift-lens-raw-"));
process.env.RIFT_LENS_MEMORY_DIR = memory;
after(() => rmSync(memory, { recursive: true, force: true }));

const { captureRawSample, rawCaptureDir } = await import("@/lib/raw-capture");
const { readRawCapture } = await import("../scripts/replay-data");
type Raw = Parameters<typeof captureRawSample>[0];

function sample(time: number, items: number[], events: number, opts: { dead?: boolean; level?: number } = {}): Raw {
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: 500.123456, level: opts.level ?? 5, abilities: { Q: { abilityLevel: 1, displayName: "Q", id: "SpellQ" } as never } },
    allPlayers: [
      { championName: "Caitlyn", riotId: "Me#EUW", summonerName: "Me", team: "ORDER", isDead: Boolean(opts.dead), level: opts.level ?? 5, items: items.map((id) => ({ itemID: id, displayName: `Item ${id}`, count: 1, price: 100, rawDescription: "x".repeat(200) })) },
      { championName: "Jhin", riotId: "E1#EUW", summonerName: "E1", team: "CHAOS", level: 5, items: [] },
    ],
    events: { Events: Array.from({ length: events }, (_, index) => ({ EventID: index, EventName: index ? "ChampionKill" : "GameStart", EventTime: index * 10 })) },
    gameData: { gameMode: "SWIFTPLAY", gameTime: time, mapName: "Map11", mapNumber: 11 },
  };
}

async function settle() {
  // captureRawSample is fire-and-forget; give the serialized write queue time to drain.
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

test("capture: periodic + change-triggered samples, event deltas rebuild to the full list", async () => {
  const feed = [
    sample(60, [1055], 1),          // first sample: written
    sample(62.5, [1055], 1),        // nothing changed, <10s: skipped
    sample(64, [1055, 1036], 1),    // item change: written
    sample(66, [1055, 1036], 2),    // new event: written
    sample(68, [1055, 1036], 2, { dead: true }), // death: written
    sample(70, [1055, 1036], 2, { dead: true }), // skipped
    sample(79, [1055, 1036], 3, { dead: true }), // 11s after last write + new event: written
  ];
  for (const raw of feed) { captureRawSample(raw); await settle(); }
  const files = readdirSync(rawCaptureDir());
  assert.equal(files.length, 1, `one file per game, got ${files.join(", ")}`);
  assert.match(files[0], /^\d{8}-\d{6}-[0-9a-f]{16}\.jsonl$/);
  const rebuilt = readRawCapture(path.join(rawCaptureDir(), files[0]));
  assert.deepEqual(rebuilt.map((raw) => raw.gameData?.gameTime), [60, 64, 66, 68, 79]);
  assert.deepEqual(rebuilt.map((raw) => raw.events?.Events?.length), [1, 1, 2, 2, 3]);
  assert.deepEqual(rebuilt.at(-1)?.events?.Events?.map((event) => event.EventID), [0, 1, 2]);
  const first = rebuilt[0];
  assert.equal(first.activePlayer?.currentGold, 500.12, "floats rounded to 2 decimals");
  assert.equal((first.allPlayers?.[0].items?.[0] as Record<string, unknown>).rawDescription, undefined, "rawDescription stripped");
  assert.equal((first.activePlayer?.abilities?.Q as Record<string, unknown>).id, undefined, "ability id stripped");
  assert.equal(first.activePlayer?.abilities?.Q?.abilityLevel, 1, "ability level kept");
});

test("capture: Viego possession (championName changes mid-game) stays in the same file", async () => {
  const before = readdirSync(rawCaptureDir()).length;
  const possessed = sample(95, [1055, 1036], 3, { dead: true });
  possessed.allPlayers![1].championName = "Viego→Yasuo";
  captureRawSample(possessed);
  await settle();
  assert.equal(readdirSync(rawCaptureDir()).length, before, "no new file for a champion-name change");
  const file = readdirSync(rawCaptureDir())[0];
  assert.equal(readRawCapture(path.join(rawCaptureDir(), file)).at(-1)?.gameData?.gameTime, 95);
});

test("capture: the newest 30 files are kept", async () => {
  const dir = rawCaptureDir();
  for (let i = 0; i < 35; i += 1) writeFileSync(path.join(dir, `20200101-0000${String(i).padStart(2, "0")}-${"0".repeat(16)}.jsonl`), "\n");
  const other = sample(30, [1001], 1);
  other.allPlayers![1].riotId = "E9#EUW"; // new roster = new game = new file (triggers pruning)
  captureRawSample(other);
  await settle();
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 30);
  assert.ok(files.some((name) => !name.startsWith("2020")), "the new game's file survives pruning");
});

test("readRawCapture: eventsFrom=0 resets the event list (server restart mid-game)", () => {
  const file = path.join(memory, "restart.jsonl");
  const line = (eventsFrom: number, ids: number[]) => JSON.stringify({ v: 1, at: "", eventsFrom, raw: { events: { Events: ids.map((EventID) => ({ EventID })) }, gameData: { gameTime: 1 } } });
  writeFileSync(file, [line(0, [0, 1]), line(2, [2]), line(0, [0, 1, 2, 3]), line(4, [4]), "not json"].join("\n"));
  assert.deepEqual(readRawCapture(file).map((raw) => raw.events?.Events?.map((event) => event.EventID)), [[0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4]]);
});

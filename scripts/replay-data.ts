// Loads replayable game data for scripts/check.ts:
//  - raw Live Client captures written by lib/raw-capture.ts (<memory>/raw/*.jsonl)
//  - recorder GameRecords (<memory>/games/*.json), turned into synthetic RawLiveData samples over time.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ItemCatalog, RawLiveData } from "@/lib/live-game";
import { memoryRoot } from "@/lib/memory-store";
import { parseRawCapture } from "@/lib/raw-capture";
import type { GameRecord } from "@/lib/types";

export type ReplaySample = {
  /** Game clock (seconds). */
  time: number;
  raw: RawLiveData;
  /** Item ids the player sold earlier this game (what the recorder would report). */
  sold: number[];
  /** Short label for reports, e.g. "dead, 1789g". */
  note: string;
};
export type ReplayGame = { source: "raw" | "record"; name: string; champion: string; mode: string; samples: ReplaySample[] };

type RawPlayer = NonNullable<RawLiveData["allPlayers"]>[number];

const CONSUMABLES = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 2150, 2151, 2152]);
const TRINKETS = new Set([3340, 3363, 3364, 3330, 3513]);

export const isCompletedId = (catalog: ItemCatalog, id: number) => {
  const item = catalog.byId.get(id);
  return Boolean(item && item.cost >= 2000 && !item.into?.length && !item.tags?.includes("Boots"));
};

function activePlayerOf(raw: RawLiveData): RawPlayer | null {
  const riotId = raw.activePlayer?.riotId?.toLowerCase();
  const name = raw.activePlayer?.summonerName?.toLowerCase();
  return (raw.allPlayers || []).find((player) => (riotId && player.riotId?.toLowerCase() === riotId) || (name && player.summonerName?.toLowerCase() === name)) || null;
}

/** Parse one capture file, rebuilding each sample's full event list from the per-line deltas (lib/raw-capture.ts). */
export function readRawCapture(file: string): RawLiveData[] {
  return parseRawCapture(readFileSync(file, "utf8"));
}

export function loadRawGames(catalog: ItemCatalog): ReplayGame[] {
  const dir = path.join(memoryRoot(), "raw");
  if (!existsSync(dir)) return [];
  // Captures from before the roster-key fix could split one match into several files (Viego possession changes the
  // gameId): merge files with the same start stamp and the same ten riotIds.
  const groups = new Map<string, { name: string; raws: RawLiveData[] }>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const raws = readRawCapture(path.join(dir, name));
    if (!raws.length) continue;
    const roster = (raws[0].allPlayers || []).map((player) => player.riotId || player.summonerName || "").sort().join("|");
    const groupKey = `${name.slice(0, 15)}|${roster}`;
    const group = groups.get(groupKey);
    if (group) { group.raws.push(...raws); group.name += `+${name.slice(16, 20)}`; }
    else groups.set(groupKey, { name, raws });
  }
  return [...groups.values()].flatMap(({ name, raws: unsorted }) => {
    const raws = unsorted.sort((a, b) => (Number(a.gameData?.gameTime) || 0) - (Number(b.gameData?.gameTime) || 0));
    const everCompleted = new Set<number>();
    const samples = raws.map((raw) => {
      const me = activePlayerOf(raw);
      const ids = (me?.items || []).map((item) => Number(item.itemID) || 0);
      // A completed item that disappears was sold (completed items never build into anything).
      const sold = [...everCompleted].filter((id) => !ids.includes(id));
      for (const id of ids) if (isCompletedId(catalog, id)) everCompleted.add(id);
      const time = Number(raw.gameData?.gameTime) || 0;
      return { time, raw, sold, note: `${me?.isDead ? "dead, " : ""}${Math.floor(Number(raw.activePlayer?.currentGold) || 0)}g` };
    });
    const me = activePlayerOf(raws[0]);
    return [{ source: "raw" as const, name, champion: me?.championName || "?", mode: raws[0].gameData?.gameMode || "?", samples }];
  });
}

export function loadRecords(): GameRecord[] {
  const dir = path.join(memoryRoot(), "games");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
    try {
      const record = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as GameRecord;
      return record && typeof record.champion === "string" && Array.isArray(record.purchases) ? [record] : [];
    } catch { return []; }
  });
}

/** Inventory at game time t: buying an item consumes owned components anywhere in its recipe tree. */
export function inventoryAt(record: GameRecord, t: number, catalog: ItemCatalog): number[] {
  const inv: number[] = [];
  const consume = (id: number, depth = 0) => {
    for (const child of catalog.byId.get(id)?.from || []) {
      const at = inv.indexOf(child);
      if (at >= 0) inv.splice(at, 1);
      else if (depth < 3) consume(child, depth + 1);
    }
  };
  for (const purchase of record.purchases) {
    if (purchase.time > t) break;
    if (purchase.kind === "sold") {
      const at = inv.indexOf(purchase.itemId);
      if (at >= 0) inv.splice(at, 1);
      continue;
    }
    if (CONSUMABLES.has(purchase.itemId) || TRINKETS.has(purchase.itemId)) continue;
    consume(purchase.itemId);
    inv.push(purchase.itemId);
  }
  // Recorder gaps can leave >6 items; drop the cheapest leftovers (stray components) first.
  while (inv.length > 6) {
    const cheapest = inv.reduce((best, id, index) => (catalog.byId.get(id)?.cost || 0) < (catalog.byId.get(inv[best])?.cost || 0) ? index : best, 0);
    inv.splice(cheapest, 1);
  }
  return inv;
}

const playerName = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, "") || "Player";

/** A synthetic Live Client payload for a recorded game at time t (gold/level are estimates unless dead). */
export function rawFromRecord(record: GameRecord, t: number, catalog: ItemCatalog, options: { gold: number; dead?: GameRecord["deaths"][number] }): RawLiveData {
  const ids = inventoryAt(record, t, catalog);
  const death = options.dead;
  const swift = /swift/i.test(record.mode);
  const level = death?.level || Math.min(18, Math.max(1, Math.floor((swift ? 3 : 1) + t / (swift ? 75 : 100))));
  // Name enemies after the summoner names the recorder saw in kill credit, so kill events resolve.
  const enemyNames = new Map<string, string>();
  for (const entry of record.deaths) if (entry.killerChampion && !enemyNames.has(entry.killerChampion)) enemyNames.set(entry.killerChampion, entry.killer);
  const enemyName = (champion: string, index: number) => enemyNames.get(champion) || `Enemy${index}`;
  const item = (id: number) => ({ itemID: id, displayName: catalog.byId.get(id)?.name || String(id), price: catalog.byId.get(id)?.cost || 0, count: 1 });
  const player = (name: string, champion: string, team: string, position: string, extra: Partial<RawPlayer> = {}): RawPlayer => ({
    championName: champion, riotId: `${name}#EUW`, summonerName: name, team, position, level, isDead: false, respawnTimer: 0, items: [],
    scores: { kills: 0, deaths: 0, assists: 0, creepScore: Math.round(t / 10), wardScore: 0 }, ...extra,
  });
  const events: NonNullable<NonNullable<RawLiveData["events"]>["Events"]> = [{ EventID: 0, EventName: "GameStart", EventTime: 0 }];
  let id = 1;
  for (const entry of record.deaths) {
    if (entry.time > t) break;
    const killerIndex = record.enemies.indexOf(entry.killerChampion);
    events.push({
      EventID: id++, EventName: "ChampionKill", EventTime: entry.time,
      KillerName: killerIndex >= 0 ? enemyName(entry.killerChampion, killerIndex) : entry.killer,
      VictimName: "Me",
      Assisters: entry.assisters.map((champion) => { const index = record.enemies.indexOf(champion); return index >= 0 ? enemyName(champion, index) : champion; }),
    });
  }
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: options.gold, level, championStats: { currentHealth: death ? 0 : 900, maxHealth: 1300 } },
    allPlayers: [
      player("Me", record.champion, "ORDER", record.position, { items: ids.map(item), isDead: Boolean(death), respawnTimer: death ? 15 : 0 }),
      ...record.allies.map((champion, index) => player(`Ally${index}`, champion, "ORDER", "")),
      ...record.enemies.map((champion, index) => player(enemyName(champion, index), champion, "CHAOS", champion === record.laneOpponent ? record.position : "")),
    ],
    events: { Events: events },
    gameData: { gameMode: record.mode, gameTime: t, mapName: "Map11", mapNumber: 11 },
  };
}

/** Samples for a recorded game: each purchase (+2s) at three gold levels, each death (+3s, dead), and a 60s grid. */
export function recordGame(record: GameRecord, catalog: ItemCatalog): ReplayGame {
  const samples: ReplaySample[] = [];
  const soldBefore = (t: number) => record.purchases.filter((entry) => entry.kind === "sold" && entry.time <= t).map((entry) => entry.itemId);
  const times = new Set<number>();
  for (const purchase of record.purchases) times.add(Math.round(purchase.time) + 2);
  for (let t = 60; t < record.durationSeconds; t += 60) times.add(t);
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t > record.durationSeconds + 5) continue;
    for (const gold of [250, 1300, 3200]) samples.push({ time: t, raw: rawFromRecord(record, t, catalog, { gold }), sold: soldBefore(t), note: `${gold}g` });
  }
  for (const death of record.deaths) {
    const t = Math.round(death.time) + 3;
    samples.push({ time: t, raw: rawFromRecord(record, t, catalog, { gold: death.goldUnspent, dead: death }), sold: soldBefore(t), note: `dead, ${death.goldUnspent}g` });
  }
  samples.sort((a, b) => a.time - b.time);
  return { source: "record", name: record.id, champion: record.champion, mode: record.mode, samples };
}

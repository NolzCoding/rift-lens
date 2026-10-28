// Pairs an uploaded replay with the live recorder's copy of the same match (work/rift-lens-memory/games) and turns the
// recording into review facts: purchase order with times, deaths with killer/assisters and the gold held, CS@10.
// This fills the gap while deep (spell-sequence) replay decoding is unavailable. Pure: records are passed in.
import { championKey } from "@/lib/champion-data";
import type { GameRecord, RecordedTimeline, TimelineEvent } from "@/lib/types";

/** Same window the profile uses to link match history to recordings (lib/player-profile.ts). */
export const RECORD_MATCH_WINDOW_MS = 3 * 60_000;
/** Without a start time: the recording's length must be this close to the replay's, with the same result. */
export const RECORD_DURATION_WINDOW_S = 90;
/** Gold held at death that counts as "an item's worth unspent" (same bar as the profile's recurring issue). */
export const UNSPENT_GOLD = 1000;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const listText = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "");

export type RecordQuery = {
  champion: string;
  durationSeconds: number;
  /** Game start (ms since epoch) when known: match history's gameCreation for the replay's game id. */
  startedAtMs: number | null;
  win: boolean | null;
};

/**
 * Same champion, then the nearest start within ±3 min when the start is known; otherwise the nearest length within
 * ±90 s with the same result. Remakes never match.
 */
export function matchRecordedGame(records: GameRecord[], query: RecordQuery): { record: GameRecord; matchedBy: RecordedTimeline["matchedBy"] } | null {
  const pool = records.filter((record) => championKey(record.champion) === championKey(query.champion) && !record.remake && record.durationSeconds >= 180);
  const nearest = (score: (record: GameRecord) => number, limit: number) => {
    let best: GameRecord | null = null;
    let gap = Infinity;
    for (const record of pool) {
      const value = score(record);
      if (value <= limit && value < gap) { best = record; gap = value; }
    }
    return best;
  };
  if (query.startedAtMs) {
    const record = nearest((entry) => Math.abs(Date.parse(entry.startedAt) - query.startedAtMs!), RECORD_MATCH_WINDOW_MS);
    return record ? { record, matchedBy: "game-id" } : null;
  }
  const result = query.win === null ? null : query.win ? "win" : "loss";
  const record = nearest((entry) => (result && entry.result !== "unknown" && entry.result !== result ? Infinity : Math.abs(entry.durationSeconds - query.durationSeconds)), RECORD_DURATION_WINDOW_S);
  return record ? { record, matchedBy: "duration" } : null;
}

/** `isFinished` = a completed item or upgraded boots (by item id, from the catalog). */
export function recordedTimeline(record: GameRecord, matchedBy: RecordedTimeline["matchedBy"], others: GameRecord[], isFinished: (itemId: number) => boolean): RecordedTimeline {
  const sameChampion = others.filter((entry) => entry.id !== record.id && championKey(entry.champion) === championKey(record.champion) && entry.csAt10 != null && !entry.partial && !entry.remake);
  const average = sameChampion.length ? Math.round(sameChampion.reduce((sum, entry) => sum + (entry.csAt10 || 0), 0) / sameChampion.length) : null;
  return {
    recordId: record.id,
    startedAt: record.startedAt,
    matchedBy,
    partial: Boolean(record.partial),
    csAt10: record.csAt10,
    csAt10Average: average,
    csAt10Games: sameChampion.length,
    completed: record.purchases.filter((entry) => entry.kind === "bought" && isFinished(entry.itemId)).map((entry) => ({ time: entry.time, item: entry.item, itemId: entry.itemId })),
    purchases: record.purchases,
    deaths: record.deaths,
  };
}

/**
 * Timeline moments from the recorded deaths (used when the replay has no decoded timeline), so the review timeline and
 * "View in League" still work. Every sentence states only what the recorder saw.
 */
export function deathEvents(recorded: RecordedTimeline, champion: string, laneOpponent: string | null): TimelineEvent[] {
  return recorded.deaths.map((death, index): TimelineEvent => {
    const helpers = death.assisters.filter(Boolean);
    const killer = death.killerChampion || death.killer || "an enemy";
    const why: string[] = [];
    const better: string[] = [];
    if (helpers.length >= 2) {
      why.push(`You were caught ${helpers.length + 1} against 1.`);
      better.push("When several enemies are missing from the map, back off toward your team instead of staying alone.");
    } else if (helpers.length === 1) {
      why.push("Two enemies collapsed on you.");
    }
    if (death.goldUnspent >= UNSPENT_GOLD) {
      why.push(`You were holding ${death.goldUnspent.toLocaleString("en-US")}g: an item's worth of stats you weren't using.`);
      better.push(`Recall and spend once you have ${UNSPENT_GOLD.toLocaleString("en-US")}g+, before taking the next fight.`);
    }
    if (death.time < 600 && laneOpponent && championKey(killer) === championKey(laneOpponent) && !helpers.length) {
      why.push(`An early solo death to your lane opponent hands ${laneOpponent} gold and lane control.`);
      better.push(`Trade with ${laneOpponent} only when your key spells are ready and theirs are not.`);
    }
    if (!why.length) why.push("Each death gives the enemy gold and costs you farm and map time while you wait to respawn.");
    if (!better.length) better.push("Before you commit, check your health and whether the enemy still has their big spells; if unsure, step back.");
    return {
      id: `death-${Math.round(death.time)}-${index}`,
      timestamp: death.time,
      champion,
      kind: "death",
      quality: "improve",
      title: `Died to ${killer}${helpers.length ? ` + ${helpers.length}` : ""}`,
      happened: `${killer}${helpers.length ? ` (with ${listText(helpers)})` : ""} killed you at ${clock(death.time)}, level ${death.level}, holding ${death.goldUnspent.toLocaleString("en-US")}g.`,
      why: why.join(" "),
      recommendation: better.join(" "),
      confidence: "recorded live by Rift Lens",
    };
  });
}

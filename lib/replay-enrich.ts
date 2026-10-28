// Server side of the replay review: adds Rift Lens's own knowledge to the replay reader's output (lib/types.ts
// ReplayAnalysis.review). Item and rune names from Data Dragon, the whole enemy team's final items from the .rofl,
// a build review per reviewed player (lib/replay-build-review.ts) and, when the live recorder saw the same match, its
// purchase/death timeline (lib/replay-recorded.ts).
import { ensureResearchLoaded } from "@/lib/build-research";
import { loadChampionIndex } from "@/lib/champion-data";
import { enemyThreatProfile, loadEnemyStatsData, type EnemyProfile, type EnemyStatsData } from "@/lib/enemy-stats";
import type { HistoryGame } from "@/lib/history-import";
import { ensureItemGroups } from "@/lib/item-groups";
import { lcuJson } from "@/lib/lcu";
import { championScaling, getItemCatalog, type ItemCatalog, type RawLiveData } from "@/lib/live-game";
import { historyImportPath, listGameRecords, readJson } from "@/lib/memory-store";
import { metaBuildFor } from "@/lib/meta-builds";
import { isBoots, isCompleted, reviewBuild } from "@/lib/replay-build-review";
import { deathEvents, matchRecordedGame, recordedTimeline } from "@/lib/replay-recorded";
import { readRawCaptureFor } from "@/lib/raw-capture";
import { gameIdFromReplayName, readRoflMetadata } from "@/lib/rofl-metadata";
import type { ReplayAnalysis, ReplayParticipant, ReplayReviewData } from "@/lib/types";

const key = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const runePromises = new Map<string, Promise<Map<number, string>>>();
/** Rune id → name from Data Dragon runesReforged.json (keystones and minor runes; stat shards are not in it). */
function loadRuneNames(version: string) {
  let pending = runePromises.get(version);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(4000) } as RequestInit);
        if (!response.ok) throw new Error(String(response.status));
        const trees = await response.json() as Array<{ id: number; name: string; slots?: Array<{ runes?: Array<{ id: number; name: string }> }> }>;
        const names = new Map<number, string>();
        for (const tree of trees) {
          names.set(tree.id, tree.name);
          for (const slot of tree.slots || []) for (const rune of slot.runes || []) names.set(rune.id, rune.name);
        }
        return names;
      } catch {
        runePromises.delete(version);
        return new Map<number, string>();
      }
    })();
    runePromises.set(version, pending);
  }
  return pending;
}

function itemNamer(catalog: ItemCatalog, stats: EnemyStatsData | null) {
  // Mode copies carry a prefix on the base id (323070 = Tear of the Goddess 3070 in Swiftplay).
  const ids = (id: number) => (id >= 100000 ? [id, id % 10000, id % 100000] : [id]);
  return (id: number) => ids(id).map((candidate) => catalog.byId.get(candidate)?.name || stats?.items.get(candidate)?.name).find(Boolean) || `Item ${id}`;
}

/** One timeline point per this many game seconds (plus one at each of the player's completed purchases). */
const TIMELINE_STEP_S = 60;

/**
 * The enemy team's threat profile over the match, from the raw live capture of the recorded game (lib/raw-capture.ts):
 * one point per minute and one at each of the player's completed purchases, oldest first. Empty when no capture is kept.
 */
export function enemyTimeline(samples: RawLiveData[], stats: EnemyStatsData, purchaseTimes: number[] = []): Array<{ time: number; profile: EnemyProfile }> {
  const out: Array<{ time: number; profile: EnemyProfile }> = [];
  const wanted = new Set(purchaseTimes.map((time) => Math.floor(time)));
  let nextAt = 0;
  for (const [index, raw] of samples.entries()) {
    const time = Number(raw.gameData?.gameTime) || 0;
    const following = Number(samples[index + 1]?.gameData?.gameTime);
    // The last sample at or before a purchase stands for that purchase.
    const purchase = [...wanted].some((at) => time <= at && (!Number.isFinite(following) || following > at));
    if (time < nextAt && !purchase && index !== samples.length - 1) continue;
    const me = (raw.allPlayers || []).find((player) => (raw.activePlayer?.riotId && player.riotId === raw.activePlayer.riotId)
      || (raw.activePlayer?.summonerName && player.summonerName === raw.activePlayer.summonerName));
    if (!me) continue;
    const enemies = (raw.allPlayers || []).filter((player) => player.team && player.team !== me.team);
    if (!enemies.length) continue;
    const profile = enemyThreatProfile(enemies.map((enemy) => ({
      champion: enemy.championName || "", level: Number(enemy.level) || 1, items: (enemy.items || []).map((item) => ({ id: Number(item.itemID) || 0, count: item.count, price: item.price })),
      kills: enemy.scores?.kills, deaths: enemy.scores?.deaths, assists: enemy.scores?.assists,
    })), stats, {
      referenceLevel: Number(raw.activePlayer?.level) || Number(me.level) || undefined,
      referenceItemGold: (me.items || []).reduce((sum, item) => sum + (Number(item.price) || 0) * Math.max(1, Number(item.count) || 1), 0),
    });
    out.push({ time, profile });
    if (time >= nextAt) nextAt = time + TIMELINE_STEP_S;
  }
  return out;
}

/** Riot's game creation time for the replay's game id: the imported match history first, then the League client. */
async function gameCreation(gameId: number | null) {
  if (!gameId) return null;
  const history = await readJson<{ games?: HistoryGame[] }>(historyImportPath());
  const stored = history?.games?.find((game) => game.gameId === gameId);
  if (stored?.gameCreation) return stored.gameCreation;
  const live = await lcuJson<{ gameCreation?: number }>(`/lol-match-history/v1/games/${gameId}`).catch(() => null);
  return typeof live?.gameCreation === "number" ? live.gameCreation : null;
}

/**
 * The uploader's Riot ID as it appears in the replay: the League client's signed-in player when they are in it, else
 * the player on the champion the imported match history says you played in this game id (another account of yours, or
 * the client closed). Null when neither applies (the reader then falls back to your most-played champions).
 */
export async function findUploader(rofl: Buffer, fileName: string, clientName: string | null) {
  const participants = readRoflMetadata(rofl)?.participants || [];
  if (clientName && participants.some((entry) => key(entry.name) === key(clientName))) return clientName;
  const gameId = gameIdFromReplayName(fileName);
  const history = gameId ? await readJson<{ games?: HistoryGame[] }>(historyImportPath()) : null;
  const game = history?.games?.find((entry) => entry.gameId === gameId);
  if (!game) return clientName;
  const candidates = participants.filter((entry) => key(entry.champion) === key(game.champion) && entry.name);
  // Mirror matches: the one whose teammates are the game's allies.
  const allies = new Set(game.allies.map(key));
  const scored = candidates.map((entry) => ({ entry, score: participants.filter((other) => other.team === entry.team && allies.has(key(other.champion))).length }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.entry.name || clientName;
}

export type EnrichOptions = {
  /** The uploaded .rofl (for all ten players' items); null when only the reader's JSON is available. */
  rofl: Buffer | null;
  fileName: string;
  /** The uploader's Riot ID from the League client, when known. */
  playerName?: string | null;
};

export async function enrichAnalysis(analysis: ReplayAnalysis, options: EnrichOptions): Promise<ReplayAnalysis> {
  const caveats: string[] = [];
  const [catalog] = await Promise.all([getItemCatalog(), ensureResearchLoaded()]);
  if (!catalog.fallback) await ensureItemGroups(catalog.version, (id) => catalog.byId.has(id));
  else caveats.push("Data Dragon was unreachable: item checks use a small offline item list.");
  const [stats, champions, runes] = await Promise.all([
    catalog.fallback ? Promise.resolve(null) : loadEnemyStatsData(catalog.version),
    catalog.fallback ? Promise.resolve(new Map()) : loadChampionIndex(catalog.version),
    catalog.fallback ? Promise.resolve(new Map<number, string>()) : loadRuneNames(catalog.version),
  ]);
  const nameOf = itemNamer(catalog, stats);

  // Names the reader could not resolve on a new patch ("Item 6673", "Rune 8010").
  for (const player of analysis.players) {
    player.items = player.itemIds.map((id, index) => (/^Item \d+$/.test(player.items[index] || "") || !player.items[index] ? nameOf(id) : player.items[index]));
    player.runes = player.runes.map((rune) => {
      const id = /^Rune (\d+)$/.exec(rune)?.[1];
      return id ? runes.get(Number(id)) || rune : rune;
    });
  }

  const you = analysis.players.find((player) => options.playerName && key(player.name) === key(options.playerName)) || analysis.players[0] || null;

  // The whole match from the .rofl's own stats.
  const metadata = options.rofl ? readRoflMetadata(options.rofl) : null;
  const named = (entry: ReplayParticipant): ReplayParticipant => ({ ...entry, items: entry.itemIds.map(nameOf) });
  const everyone = (metadata?.participants || []).map(named);
  const myTeam = everyone.find((entry) => entry.participantId === you?.participantId)?.team ?? you?.team ?? 100;
  const allies = everyone.filter((entry) => entry.team === myTeam);
  const enemies = everyone.filter((entry) => entry.team !== myTeam);
  if (!enemies.length) caveats.push("The enemy team's items could not be read from this replay, so counter-build checks are skipped.");

  // The live recorder's copy of the same match.
  let recorded: ReplayReviewData["recorded"] = null;
  let recordGameId = "";
  if (you) {
    const records = await listGameRecords().catch(() => []);
    const startedAtMs = await gameCreation(gameIdFromReplayName(options.fileName)).catch(() => null);
    const match = matchRecordedGame(records, { champion: you.champion, durationSeconds: analysis.replay.durationMs / 1000, startedAtMs, win: typeof you.win === "boolean" ? you.win : null });
    if (match) {
      recordGameId = match.record.gameId;
      recorded = recordedTimeline(match.record, match.matchedBy, records, (id) => {
        const item = catalog.byId.get(id);
        return Boolean(item && (isCompleted(item) || isBoots(item)));
      });
      if (recorded.partial) caveats.push("Rift Lens's live recording of this match has gaps (the live page was opened late or lost the game feed): some purchases or deaths may be missing.");
    } else {
      caveats.push("Rift Lens did not record this match live, so purchase order and deaths are unknown. Keep the Live page open while you play to get them in the review.");
    }
  }

  const profile = stats && enemies.length ? enemyThreatProfile(enemies.map((enemy) => ({
    champion: enemy.champion, level: enemy.level, items: enemy.itemIds.map((id) => ({ id })), kills: enemy.kills, deaths: enemy.deaths, assists: enemy.assists,
  })), stats, {
    referenceLevel: you?.level,
    referenceItemGold: you ? you.itemIds.reduce((sum, id) => sum + (catalog.byId.get(id)?.cost || 0), 0) : undefined,
  }) : null;

  // The enemies' items over the match (raw live capture of the recorded game): counter needs are judged when they arose.
  let timeline: ReturnType<typeof enemyTimeline> = [];
  if (stats && recorded && you) {
    const samples = await readRawCaptureFor(recordGameId).catch(() => []);
    timeline = samples.length ? enemyTimeline(samples, stats, recorded.completed.map((entry) => entry.time)) : [];
    if (!timeline.length) caveats.push("No raw live capture of this match is kept, so counter needs are judged on the enemies' final items only.");
  }

  const builds = analysis.players.map((player) => reviewBuild({
    participantId: player.participantId,
    champion: player.champion,
    role: player.position,
    itemIds: player.itemIds,
    catalog,
    scaling: championScaling(player.champion, champions, player.itemIds.map((id) => ({ id })), catalog),
    meta: metaBuildFor(player.champion, player.position, analysis.replay.clientVersion),
    enemyProfile: profile,
    completedOrder: player === you && recorded ? recorded.completed : undefined,
    enemyTimeline: timeline.length ? timeline : undefined,
  }));

  if (!analysis.deepMetrics) caveats.push("Spell-by-spell decoding is not available for this patch yet; the review uses end-of-game stats" + (recorded ? " plus Rift Lens's live recording." : "."));
  if (!analysis.timeline?.length && recorded && you) {
    const opponent = analysis.enemyLane.find((enemy) => enemy.position === you.position)?.champion || analysis.enemyLane[0]?.champion || null;
    analysis.timeline = deathEvents(recorded, you.champion, opponent);
  }

  analysis.review = {
    version: 1,
    dataPatch: catalog.fallback ? null : catalog.version,
    youId: you?.participantId ?? null,
    allies,
    enemies,
    builds,
    recorded,
    caveats,
  };
  return analysis;
}

import {
  championKey,
  deriveFirstBack,
  isOffRiftMode,
  isPartial,
  isRemake,
  isUpgradedBoots,
  listGameRecords,
  readSettings,
  writeProfileFile,
  writeSettings,
  type ProfileSettings,
} from "@/lib/memory-store";
import { importBeforeRebuild, readHistoryGames, scheduleHistoryImport, type HistoryGame } from "@/lib/history-import";
import { importedBuildFor, importsRevision } from "@/lib/item-set-import";
import { buildCheck, buildCheckLine, metaBuildFor, metaRevision, NEW_CHAMPION_GAMES, type BuildCheck } from "@/lib/meta-builds";
import type {
  ChampionProfile,
  GameRecord,
  ImportedBuild,
  MatchupRecord,
  PlayerBrief,
  PlayerFocus,
  PlayerPreferences,
  PlayerProfile,
  RecurringIssue,
} from "@/lib/types";

type Cache = {
  profile: PlayerProfile | null;
  rebuilding: Promise<PlayerProfile> | null;
  rerun: boolean;
  briefs: Map<string, PlayerBrief | null>;
};

const MIN_GAME_SECONDS = 300;
const STALE_OPEN_MS = 30 * 60_000;
const ISSUE_WINDOW = 20;
const isSwiftplay = (game: Pick<GameRecord, "mode" | "modeLabel">) => /swift/i.test(`${game.mode} ${game.modeLabel}`);
const CS_BASELINE: Record<string, number> = { TOP: 70, MIDDLE: 72, BOTTOM: 75, JUNGLE: 55 };
const ASSASSINS = new Set([
  "akali", "diana", "ekko", "evelynn", "fizz", "kassadin", "katarina", "khazix", "leblanc", "naafiri", "nocturne",
  "pyke", "qiyana", "rengar", "shaco", "talon", "zed", "kayn", "nidalee", "elise", "yone",
]);

const globalStore = globalThis as typeof globalThis & { __riftLensProfileV2?: Cache };
const cache: Cache = globalStore.__riftLensProfileV2 ??= { profile: null, rebuilding: null, rerun: false, briefs: new Map() };

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const pct = (part: number, whole: number) => whole ? Math.round(part / whole * 100) : 0;
// Turrets, minions and monsters also kill; only count enemy champions from that game's roster.
const byEnemyChampion = (game: GameRecord, champion: string) => Boolean(champion && champion !== "Unknown" && (!game.enemies.length || game.enemies.includes(champion)));

function isEnded(record: GameRecord, now: number) {
  if (record.endedAt) return true;
  return now - Date.parse(record.startedAt) - record.durationSeconds * 1000 > STALE_OPEN_MS;
}

function firstBoots(record: GameRecord) {
  return record.purchases.find((entry) => entry.kind === "bought" && isUpgradedBoots(entry.item))?.item || null;
}

/** A record as the profile reads it: remake/partial settled (older records have no flags), firstBack derived when missing. */
type Interpreted = GameRecord & { remake: boolean; partial: boolean };

function interpret(record: GameRecord): Interpreted {
  const remake = isRemake(record);
  const partial = !remake && isPartial(record);
  return {
    ...record,
    remake,
    partial,
    // A remake has no result even if Riot's GameEnd (or a mismatched client lookup) said "win".
    result: remake ? "unknown" : record.result,
    firstBack: remake || partial ? undefined : record.firstBack ?? deriveFirstBack(record) ?? undefined,
  };
}

/** Learned habits for one champion, from the most recent complete (non-partial) games. `of` = games in the window that had the data. */
export type LearnedBuild = {
  window: number;
  /**
   * `core` = how many leading items are slot-by-slot habits (recorded games only: they know the purchase order); the rest
   * are items finished in 2+ of the last `laterOf` games (recorded + match history), by usual position. `core: 0` = the
   * champion has no recorded purchase order, so the whole path is match-history items in their usual inventory slot.
   */
  path: {
    items: string[]; games: number; of: number; wins: number; core?: number;
    later?: Array<{ item: string; games: number }>; laterOf?: number;
  } | null;
  firstBack: { items: string[]; games: number; of: number } | null;
  boots: { item: string; games: number; of: number } | null;
};
/** ChampionProfile as stored in profile.json; the extra fields are optional so older profile files still read. */
export type LearnedChampionProfile = ChampionProfile & {
  learned?: LearnedBuild;
  /** Where `games` came from: recorded with /live open, or imported from the League client's match history only. */
  sources?: { recorded: number; history: number };
  /** Completed items by how many games finished them (all complete games, both sources). */
  finishedItems?: Array<{ item: string; games: number }>;
  /** Complete games behind finishedItems (the build check's denominator). */
  buildGames?: number;
  /** Complete (non-remake, non-partial, 5+ min) games on this champion: recorded + match-history-only. */
  completeGames?: number;
  /** What the player finishes vs the top build (lib/meta-builds.ts, researched or curated); only for champions with an entry. */
  buildCheck?: BuildCheck | null;
};
/** Game counts by source: `history` = match-history games not also recorded; `linked` = recorded games also found in history. */
export type ProfileSources = { recorded: number; history: number; linked: number; historyStored: number };
/** PlayerProfile as stored in profile.json; `sources` is optional so older profile files still read. */
export type StoredProfile = PlayerProfile & { sources?: ProfileSources };
/** recentGames entry as stored; remake/partial are optional so older profile files still read. */
export type RecentGame = PlayerProfile["recentGames"][number] & { remake?: boolean; partial?: boolean };

/** Build learning looks at the last N complete games; each older game weighs DECAY times the next newer one. */
const LEARN_WINDOW = 10;
const LEARN_DECAY = 0.85;
/** A learned choice needs this share of the window's weight (one fresh game ≈ 19% of a full window, so it cannot override a habit). */
const LEARN_SHARE = 0.35;
/** Past the first slot, the leader must beat the runner-up by this factor and appear in at least two games. */
const LEARN_MARGIN = 1.25;

type Vote = { value: string; weight: number; games: number[] };

/** Weighted vote over chronological `entries` (newest last); null entries are games without that data. */
function weightedVote(entries: Array<string | null>, strict: boolean): { best: Vote; of: number } | null {
  const window = entries.slice(-LEARN_WINDOW);
  const votes = new Map<string, Vote>();
  let total = 0;
  let of = 0;
  window.forEach((value, index) => {
    if (value === null) return;
    const weight = LEARN_DECAY ** (window.length - 1 - index);
    total += weight;
    of += 1;
    const vote = votes.get(value) || { value, weight: 0, games: [] };
    vote.weight += weight;
    vote.games.push(index);
    votes.set(value, vote);
  });
  const ranked = [...votes.values()].sort((a, b) => b.weight - a.weight);
  const [best, runner] = ranked;
  if (!best || best.weight < total * LEARN_SHARE || (runner && best.weight <= runner.weight)) return null;
  if (strict && of > 1 && (best.games.length < 2 || (runner && best.weight < runner.weight * LEARN_MARGIN))) return null;
  return { best, of };
}

/**
 * Slot-by-slot consensus over the last LEARN_WINDOW complete games, newer games weighing more. Exact first-3 combos rarely
 * repeat (the 3rd item varies), so each slot votes on its own; a later slot needs a clear, repeated winner.
 */
/**
 * One complete game as build learning sees it. Recorded games know the purchase `order`; match-history games (and partial
 * recordings filled in from their match-history copy) only know which items were `finished`, in inventory-slot order.
 */
type BuildGame = { at: number; order: string[] | null; finished: string[]; boots: string | null; win: boolean };

function learnPath(list: Interpreted[], builds: BuildGame[] = []): LearnedBuild["path"] {
  const games = list.filter((game) => game.completedItemOrder.length > 0).slice(-LEARN_WINDOW);
  const items: string[] = [];
  for (let slot = 0; slot < 3; slot += 1) {
    const voted = weightedVote(games.map((game) => {
      const item = game.completedItemOrder[slot];
      return item && !items.includes(item) && items.every((chosen, index) => game.completedItemOrder[index] === chosen) ? item : null;
    }), slot > 0);
    if (!voted) break;
    items.push(voted.best.value);
  }
  // A champion seen with mixed recorded openings has no core and no path; only a champion with no recorded order at all
  // (match history only) falls back to its usually-finished items below.
  if (!items.length && games.length) return null;
  const core = items.length;
  // The rest of the build: late items vary in slot but repeat across games (e.g. LDR 3rd one game, 4th another).
  // Every item finished in 2+ of the last LEARN_WINDOW games (recorded + match history, newer weighing more) qualifies;
  // the most-finished fill the free slots. Order: weighted average of recorded purchase positions and match-history inventory
  // slots (a weaker proxy: items fill the first free slot), else frequency.
  const window = (builds.length ? builds : games.map((game) => ({
    at: Date.parse(game.startedAt), order: game.completedItemOrder, finished: game.completedItemOrder, boots: null, win: game.result === "win",
  }))).filter((game) => game.finished.length > 0).slice(-LEARN_WINDOW);
  const later = new Map<string, { weight: number; games: number; position: number; positionWeight: number; slot: number; slotWeight: number }>();
  window.forEach((game, index) => {
    const weight = LEARN_DECAY ** (window.length - 1 - index);
    if (game.order) {
      // Recorded: absolute purchase position, exactly as before match history existed.
      game.order.forEach((item, position) => {
        if (items.includes(item)) return;
        const entry = later.get(item) || { weight: 0, games: 0, position: 0, positionWeight: 0, slot: 0, slotWeight: 0 };
        entry.weight += weight;
        entry.games += 1;
        entry.position += position * weight;
        entry.positionWeight += weight;
        later.set(item, entry);
      });
      return;
    }
    // Match history: slot among the non-core items, placed after the core so it reads on the recorded scale (a game
    // without Hexoptics would otherwise put its 2nd item ahead of a recorded 4th item).
    game.finished.filter((item) => !items.includes(item)).forEach((item, slot) => {
      const entry = later.get(item) || { weight: 0, games: 0, position: 0, positionWeight: 0, slot: 0, slotWeight: 0 };
      entry.weight += weight;
      entry.games += 1;
      entry.slot += (core + slot) * weight;
      entry.slotWeight += weight;
      later.set(item, entry);
    });
  });
  // Slot proxy: a match-history game that never finished the item counts it as "after everything it finished", so an
  // item finished in 5 of 10 games does not jump ahead of one finished in all 10 just because it sat in slot 1 (Viktor:
  // Luden's in 10/10 stays ahead of Zhonya's in 5/10).
  window.forEach((game, index) => {
    if (game.order) return;
    const weight = LEARN_DECAY ** (window.length - 1 - index);
    const end = core + game.finished.filter((item) => !items.includes(item)).length;
    for (const [item, entry] of later) {
      if (entry.slotWeight && !game.finished.includes(item)) { entry.slot += end * weight; entry.slotWeight += weight; }
    }
  });
  type Later = [string, NonNullable<ReturnType<typeof later.get>>];
  // Recorded positions and match-history slots are on the same scale, so average them together: a single recorded game
  // must not override where the item usually sits across all the other games.
  const rank = ([, entry]: Later) => entry.positionWeight + entry.slotWeight
    ? (entry.position + entry.slot) / (entry.positionWeight + entry.slotWeight)
    : Number.MAX_SAFE_INTEGER;
  const extra = [...later.entries()]
    .filter(([, entry]) => entry.games >= 2)
    .sort((a, b) => b[1].weight - a[1].weight || b[1].games - a[1].games)
    .slice(0, Math.max(0, 6 - core))
    .sort((a, b) => rank(a) - rank(b) || b[1].weight - a[1].weight);
  if (!core && !extra.length) return null;
  items.push(...extra.map(([item]) => item));
  const laterFields = { later: extra.map(([item, entry]) => ({ item, games: entry.games })), laterOf: window.length };
  if (!core) {
    // Backed by the games that finished the most-finished item (always 2+).
    const top = [...extra].sort((a, b) => b[1].weight - a[1].weight)[0][0];
    const backing = window.filter((game) => game.finished.includes(top));
    return { items, games: backing.length, of: window.length, wins: backing.filter((game) => game.win).length, core, ...laterFields };
  }
  const prefix = items.slice(0, 2);
  const backing = games.filter((game) => prefix.every((item, index) => game.completedItemOrder[index] === item));
  return {
    items, games: backing.length, of: games.length, wins: backing.filter((game) => game.result === "win").length,
    core, ...laterFields,
  };
}

function learnFirstBack(list: Interpreted[]): LearnedBuild["firstBack"] {
  const games = list.slice(-LEARN_WINDOW);
  const keyOf = (items: string[] | undefined) => items?.length ? [...items].sort().join(" + ") : null;
  const voted = weightedVote(games.map((game) => keyOf(game.firstBack)), true);
  if (!voted) return null;
  // Show it in the purchase order of the newest game that did it.
  const newest = games[voted.best.games.at(-1)!].firstBack!;
  return { items: newest, games: voted.best.games.length, of: voted.of };
}

function learnBoots(builds: BuildGame[]): LearnedBuild["boots"] {
  const voted = weightedVote(builds.slice(-LEARN_WINDOW).map((game) => game.boots), false);
  return voted ? { item: voted.best.value, games: voted.best.games.length, of: voted.of } : null;
}

/** Match-history copies of recorded games are dropped; a recording that started within this of the client's game creation is the same match. */
const LINK_WINDOW_MS = 3 * 60_000;

/**
 * Pairs each match-history game with the recorded game of the same match (same champion, start within ±3 min), which
 * wins because it knows the purchase order. `linked` maps record id → its history copy; `unlinked` = history-only games.
 */
function linkHistory(records: Interpreted[], history: HistoryGame[]) {
  const linked = new Map<string, HistoryGame>();
  const unlinked: HistoryGame[] = [];
  for (const game of history) {
    let best: Interpreted | null = null;
    let gap = Infinity;
    for (const record of records) {
      if (record.remake || linked.has(record.id) || championKey(record.champion) !== championKey(game.champion)) continue;
      const delta = Math.abs(Date.parse(record.startedAt) - game.gameCreation);
      if (delta <= LINK_WINDOW_MS && delta < gap) { best = record; gap = delta; }
    }
    if (best) linked.set(best.id, game); else unlinked.push(game);
  }
  return { linked, unlinked };
}

/** Complete games on the champion for the "new on this champion" rule (older profile files: buildGames, then games). */
export function newChampionGames(profile: LearnedChampionProfile) {
  return profile.completeGames ?? profile.buildGames ?? profile.games;
}

/** Build check vs the champion's top build (researched or curated); works on older stored profiles (falls back to `games`). */
export function checkBuild(profile: LearnedChampionProfile): BuildCheck | null {
  const meta = metaBuildFor(profile.champion);
  if (!meta || !profile.finishedItems?.length) return null;
  return buildCheck(meta, { finished: profile.finishedItems, boots: profile.boots, games: profile.buildGames ?? profile.games });
}

function championProfiles(games: Interpreted[], history: HistoryGame[] = [], linked = new Map<string, HistoryGame>()): LearnedChampionProfile[] {
  const byChampion = new Map<string, { champion: string; list: Interpreted[]; imported: HistoryGame[] }>();
  const group = (champion: string) => {
    const id = championKey(champion);
    const entry = byChampion.get(id) || { champion, list: [], imported: [] };
    byChampion.set(id, entry);
    return entry;
  };
  for (const game of games) group(game.champion).list.push(game);
  for (const game of history) group(game.champion).imported.push(game);
  return [...byChampion.values()].map(({ champion, list, imported }) => {
    // Partial games count for results and deaths, but their purchase log / CS@10 / first-item time may be incomplete.
    const complete = list.filter((game) => !game.partial);
    // `complete` is chronological; `last` lets a one-game path from the most recent game win ties.
    const paths = new Map<string, { items: string[]; games: number; wins: number; last: number }>();
    for (const [order, game] of complete.entries()) {
      if (game.completedItemOrder.length >= 1) {
        const items = game.completedItemOrder.slice(0, 3);
        const entry = paths.get(items.join(" > ")) || { items, games: 0, wins: 0, last: 0 };
        entry.games += 1;
        entry.wins += game.result === "win" ? 1 : 0;
        entry.last = order;
        paths.set(items.join(" > "), entry);
      }
    }
    // Build learning over both sources, chronological. A partial recording uses its match-history copy's final items.
    const builds: BuildGame[] = [
      ...list.flatMap((game): BuildGame[] => {
        const at = Date.parse(game.startedAt);
        if (!game.partial) return [{ at, order: game.completedItemOrder, finished: game.completedItemOrder, boots: firstBoots(game), win: game.result === "win" }];
        const copy = linked.get(game.id);
        return copy ? [{ at, order: null, finished: copy.items, boots: copy.boots, win: copy.win }] : [];
      }),
      ...imported.map((game): BuildGame => ({ at: game.gameCreation, order: null, finished: game.items, boots: game.boots, win: game.win })),
    ].sort((a, b) => a.at - b.at);
    const boots = new Map<string, number>();
    const finished = new Map<string, number>();
    for (const game of builds) {
      if (game.boots) boots.set(game.boots, (boots.get(game.boots) || 0) + 1);
      for (const item of game.finished) finished.set(item, (finished.get(item) || 0) + 1);
    }
    const finals = [...list.map((game) => game.final), ...imported.map((game) => ({ kills: game.kills, deaths: game.deaths, assists: game.assists, cs: game.cs }))];
    const csAt10 = average(complete.flatMap((game) => game.csAt10 === null ? [] : [game.csAt10]));
    const firstItem = average(complete.flatMap((game) => game.firstCompletedItem ? [game.firstCompletedItem.time] : []));
    const profile: LearnedChampionProfile = {
      champion,
      games: list.length + imported.length,
      wins: list.filter((game) => game.result === "win").length + imported.filter((game) => game.win).length,
      losses: list.filter((game) => game.result === "loss").length + imported.filter((game) => !game.win).length,
      avg: {
        kills: round(average(finals.map((final) => final.kills)) || 0),
        deaths: round(average(finals.map((final) => final.deaths)) || 0),
        assists: round(average(finals.map((final) => final.assists)) || 0),
        cs: Math.round(average(finals.map((final) => final.cs)) || 0),
      },
      avgCsAt10: csAt10 === null ? null : Math.round(csAt10),
      avgFirstItemTime: firstItem === null ? null : Math.round(firstItem),
      buildPaths: [...paths.values()]
        .sort((a, b) => b.games - a.games || b.last - a.last || b.items.length - a.items.length)
        .slice(0, 5)
        .map(({ items, games: count, wins }) => ({ items, games: count, wins })),
      boots: [...boots.entries()].map(([item, count]) => ({ item, games: count })).sort((a, b) => b.games - a.games),
      learned: { window: LEARN_WINDOW, path: learnPath(complete, builds), firstBack: learnFirstBack(complete), boots: learnBoots(builds) },
      sources: { recorded: list.length, history: imported.length },
      finishedItems: [...finished.entries()].map(([item, count]) => ({ item, games: count })).sort((a, b) => b.games - a.games || a.item.localeCompare(b.item)).slice(0, 12),
      buildGames: builds.filter((game) => game.finished.length > 0 || game.boots).length,
      completeGames: complete.length + imported.length,
    };
    profile.buildCheck = checkBuild(profile);
    return profile;
  }).sort((a, b) => b.games - a.games || a.champion.localeCompare(b.champion));
}

function matchupRecords(games: GameRecord[]): MatchupRecord[] {
  const map = new Map<string, MatchupRecord>();
  for (const game of games) {
    if (!game.laneOpponent) continue;
    const id = `${game.champion}|${game.laneOpponent}`;
    const entry = map.get(id) || { champion: game.champion, enemy: game.laneOpponent, games: 0, wins: 0, deathsToEnemy: 0 };
    entry.games += 1;
    entry.wins += game.result === "win" ? 1 : 0;
    entry.deathsToEnemy += game.deaths.filter((death) => death.killerChampion === game.laneOpponent).length;
    map.set(id, entry);
  }
  return [...map.values()].sort((a, b) => b.games - a.games || b.deathsToEnemy - a.deathsToEnemy).slice(0, 60);
}

function killerStats(games: GameRecord[]) {
  const map = new Map<string, { champion: string; deathsTo: number; games: number; early: number }>();
  for (const game of games) {
    const seen = new Set<string>();
    for (const death of game.deaths) {
      if (!byEnemyChampion(game, death.killerChampion)) continue;
      const entry = map.get(death.killerChampion) || { champion: death.killerChampion, deathsTo: 0, games: 0, early: 0 };
      entry.deathsTo += 1;
      entry.early += death.time < 600 ? 1 : 0;
      if (!seen.has(death.killerChampion)) { entry.games += 1; seen.add(death.killerChampion); }
      map.set(death.killerChampion, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.deathsTo - a.deathsTo || b.games - a.games);
}

function detectIssues(allGames: Interpreted[]): RecurringIssue[] {
  const games = allGames.slice(-ISSUE_WINDOW);
  if (games.length < 3) return [];
  const issues: RecurringIssue[] = [];
  const deaths = games.flatMap((game) => game.deaths.map((death) => ({ ...death, game })));

  const unspent = deaths.filter((death) => death.goldUnspent >= 1000);
  if (unspent.length >= 3 && unspent.length / Math.max(1, deaths.length) >= 0.2) {
    const worst = unspent.reduce((best, death) => death.goldUnspent > best.goldUnspent ? death : best);
    const share = pct(unspent.length, deaths.length);
    issues.push({
      id: "unspent-gold-deaths",
      label: "Dying with gold in pocket",
      detail: "Recall and spend before contesting when you hold 1000g+; that gold is a component you are not using.",
      severity: share >= 40 ? "high" : "medium",
      evidence: `${unspent.length} of ${deaths.length} deaths (${share}%) held 1000g+ unspent; worst ${worst.goldUnspent}g at ${clock(worst.time)} on ${worst.game.champion}.`,
    });
  }

  const tenMinuteGames = games.filter((game) => game.durationSeconds >= 600);
  if (tenMinuteGames.length >= 3) {
    const early = tenMinuteGames.map((game) => game.deaths.filter((death) => death.time < 600).length);
    const perGame = average(early) || 0;
    if (perGame >= 1.5) {
      issues.push({
        id: "early-deaths",
        label: "Frequent deaths before 10:00",
        detail: "Early deaths hand over lane priority and first-item timing; respect the enemy jungler and level spikes.",
        severity: perGame >= 2.5 ? "high" : "medium",
        evidence: `${round(perGame)} deaths before 10:00 per game over the last ${tenMinuteGames.length} games (${early.reduce((a, b) => a + b, 0)} total).`,
      });
    }
  }

  const byRole = new Map<string, number[]>();
  for (const game of games) {
    // Swiftplay's nearby-minion gold and level-3 start make normal-SR CS@10 baselines meaningless.
    if (game.partial || game.csAt10 === null || !(game.position in CS_BASELINE) || isSwiftplay(game)) continue;
    byRole.set(game.position, [...(byRole.get(game.position) || []), game.csAt10]);
  }
  for (const [role, values] of byRole) {
    const baseline = CS_BASELINE[role];
    const avg = average(values) || 0;
    if (values.length >= 3 && avg < baseline - 10) {
      issues.push({
        id: `low-cs-${role.toLowerCase()}`,
        label: `Low CS@10 in ${role.toLowerCase()}`,
        detail: `A solid ${role.toLowerCase()} baseline is about ${baseline} CS at 10:00; missed waves are free gold left behind.`,
        severity: avg < baseline - 20 ? "high" : "medium",
        evidence: `Average CS@10 ${Math.round(avg)} over ${values.length} ${role.toLowerCase()} games (baseline ${baseline}); best ${Math.max(...values)}.`,
      });
    }
  }

  for (const killer of killerStats(games).filter((entry) => entry.games >= 3 && entry.deathsTo >= 5).slice(0, 2)) {
    issues.push({
      id: `repeat-killer-${championKey(killer.champion)}`,
      label: `${killer.champion} keeps finding you`,
      detail: `Track ${killer.champion}'s position and power spikes; play behind vision when they are missing.`,
      severity: killer.games >= 5 || killer.deathsTo >= 10 ? "high" : "medium",
      evidence: `${killer.deathsTo} deaths to ${killer.champion} across ${killer.games} games${killer.early ? ` (${killer.early} before 10:00)` : ""}.`,
    });
  }

  const known = deaths.filter((death) => byEnemyChampion(death.game, death.killerChampion));
  const toAssassins = known.filter((death) => ASSASSINS.has(championKey(death.killerChampion)));
  if (known.length >= 10 && toAssassins.length / known.length >= 0.35) {
    issues.push({
      id: "assassin-deaths",
      label: "Assassins are your main killers",
      detail: "Hold a defensive tool (Flash, Zhonya's, stopwatch) for the assassin and avoid face-checking side lanes.",
      severity: toAssassins.length / known.length >= 0.5 ? "high" : "medium",
      evidence: `${toAssassins.length} of ${known.length} champion kills on you (${pct(toAssassins.length, known.length)}%) came from assassins.`,
    });
  }

  // Swiftplay starts with 1400g and faster income, so its first item is judged against ~11:00 instead of 15:00.
  const itemGames = games.filter((game) => !game.partial && game.position !== "UTILITY" && game.firstCompletedItem);
  const itemTimes = itemGames.map((game) => game.firstCompletedItem!.time);
  const itemSlack = itemGames.map((game) => game.firstCompletedItem!.time - (isSwiftplay(game) ? 660 : 900));
  const avgItem = average(itemTimes);
  const avgSlack = average(itemSlack);
  if (itemTimes.length >= 3 && avgItem !== null && avgSlack !== null && avgSlack > 0) {
    issues.push({
      id: "slow-first-item",
      label: "Slow first completed item",
      detail: "Aim for your first legendary around 12-14 minutes on normal SR (about 9-11 in Swiftplay): fewer early deaths, cleaner waves, and timely recalls.",
      severity: avgSlack > 120 ? "high" : "medium",
      evidence: `First completed item at ${clock(avgItem)} on average over ${itemTimes.length} games; fastest ${clock(Math.min(...itemTimes))}.`,
    });
  }

  const avgDeaths = average(games.map((game) => game.final.deaths)) || 0;
  if (avgDeaths >= 7) {
    issues.push({
      id: "high-deaths",
      label: "High death count",
      detail: "Most games are lost through repeated deaths; trade one fewer risky fight per recall.",
      severity: avgDeaths >= 9 ? "high" : "medium",
      evidence: `${round(avgDeaths)} deaths per game over the last ${games.length} games.`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * One player cannot be in two games at once: a shorter same-champion record that starts inside another record's span is
 * a fragment of that game (older recorders split a match when its gameId changed, e.g. Viego possessing a champion).
 * Hidden at read time; the files stay on disk.
 */
function withoutFragments(records: GameRecord[]) {
  const span = (record: GameRecord) => [Date.parse(record.startedAt), Date.parse(record.startedAt) + record.durationSeconds * 1000] as const;
  return records.filter((record) => {
    const [start] = span(record);
    return !records.some((other) => {
      if (other === record || other.champion !== record.champion) return false;
      if (other.durationSeconds < record.durationSeconds || (other.durationSeconds === record.durationSeconds && other.id > record.id)) return false;
      const [otherStart, otherEnd] = span(other);
      return start >= otherStart - 60_000 && start <= otherEnd + 60_000;
    });
  });
}

export function computeProfile(records: GameRecord[], settings: ProfileSettings, now = Date.now(), history: HistoryGame[] = []): StoredProfile {
  const kept = withoutFragments(records).map(interpret);
  const ended = kept.filter((record) => isEnded(record, now));
  // Remakes never count; other games under 5 minutes are listed but too short for stats.
  const counted = ended.filter((record) => !record.remake && record.durationSeconds >= MIN_GAME_SECONDS);
  const rift = counted.filter((record) => !isOffRiftMode(record));
  // Linked against every kept record (open ones too) so a just-finished game is never counted from both sources.
  const { linked, unlinked } = linkHistory(kept, history);
  const historyRift = unlinked.filter((game) => game.durationSeconds >= MIN_GAME_SECONDS && (!game.mapId || game.mapId === 11) && !isOffRiftMode({ mode: game.mode, modeLabel: "" }));
  const recordedCount = ended.filter((record) => !record.remake).length;
  const recentGames: RecentGame[] = [...ended].reverse().slice(0, 25).map((record) => ({
    id: record.id, startedAt: record.startedAt, champion: record.champion, laneOpponent: record.laneOpponent, result: record.result,
    final: record.final, durationSeconds: record.durationSeconds, focusResult: record.remake ? null : record.focusResult,
    ...(record.remake ? { remake: true } : {}), ...(record.partial ? { partial: true } : {}),
  }));
  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    // Every remembered game: recorded ones plus match-history games that were not also recorded.
    gamesRecorded: recordedCount + unlinked.length,
    sources: { recorded: recordedCount, history: unlinked.length, linked: linked.size, historyStored: history.length },
    // Champion stats and build learning use both sources; matchups, killers and issues need deaths, so recorded games only.
    champions: championProfiles(rift, historyRift, linked),
    matchups: matchupRecords(rift),
    killers: killerStats(rift).slice(0, 12).map(({ champion, deathsTo, games }) => ({ champion, deathsTo, games })),
    issues: detectIssues(rift),
    preferences: settings.preferences,
    focus: settings.focus,
    recentGames,
  };
}

async function runRebuild() {
  const [records, settings, history] = await Promise.all([listGameRecords(), readSettings(), readHistoryGames().catch(() => [])]);
  const profile = computeProfile(records, settings, Date.now(), history);
  await writeProfileFile(profile);
  cache.profile = profile;
  cache.briefs.clear();
  return profile;
}

/** Recomputes profile.json from every game record. Concurrent calls coalesce. */
export async function rebuildProfile(): Promise<PlayerProfile> {
  if (cache.rebuilding) { cache.rerun = true; return cache.rebuilding; }
  cache.rebuilding = (async () => {
    try {
      let profile = await runRebuild();
      while (cache.rerun) { cache.rerun = false; profile = await runRebuild(); }
      return profile;
    } finally { cache.rebuilding = null; }
  })();
  return cache.rebuilding;
}

/**
 * Throttled, fire-and-forget import of the League client's match history (see lib/history-import.ts); the profile is
 * rebuilt only when new games were stored. Returns immediately.
 */
export function scheduleMatchHistoryImport() {
  scheduleHistoryImport(() => rebuildProfile());
}

/** Explicit rebuild: pull new match-history games first (waiting at most a few seconds), then recompute. */
export async function rebuildProfileWithHistory(): Promise<PlayerProfile> {
  await importBeforeRebuild(5000, () => rebuildProfile());
  return rebuildProfile();
}

/** In-memory profile; rebuilt from disk once per server start so stale open records are settled. */
export async function getProfile(): Promise<PlayerProfile> {
  return cache.profile || rebuildProfile();
}

export async function saveSettings(settings: ProfileSettings) {
  await writeSettings(settings);
  cache.briefs.clear();
  if (cache.profile) cache.profile = { ...cache.profile, preferences: settings.preferences, focus: settings.focus };
  await writeProfileFile(await getProfile());
  return settings;
}

function itemsFor(map: PlayerPreferences["preferredItems"], champion: string) {
  const match = Object.keys(map).find((name) => championKey(name) === championKey(champion));
  return match ? map[match] : [];
}

function notesFor(notes: string[], champion: string) {
  return notes.flatMap((note) => {
    const prefixed = /^\[([^\]]{2,40})\]\s*(.+)$/.exec(note);
    if (!prefixed) return [note];
    return championKey(prefixed[1]) === championKey(champion) ? [prefixed[2]] : [];
  });
}

function focusTarget(focus: PlayerFocus) {
  const metric = focus.metric;
  if (!metric || metric.kind === "none") return "";
  if (metric.kind === "csAt10") return ` (target: ${metric.target}+ CS at 10:00)`;
  if (metric.kind === "deathsBefore10") return ` (target: ≤ ${metric.target} deaths before 10:00)`;
  return ` (target: ≤ ${metric.target} deaths holding 1000g+)`;
}

const winLoss = (wins: number, games: number) => `${wins}W-${games - wins}L`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function buildBrief(
  profile: PlayerProfile,
  champion: string,
  enemyChampions: string[],
  laneOpponent: string | null,
  importedBuild: ImportedBuild | null = null,
): PlayerBrief | null {
  const pinned = itemsFor(profile.preferences.builds || {}, champion);
  const pinnedBuild = pinned.length ? pinned : null;
  if (!profile.gamesRecorded && !pinnedBuild && !importedBuild) return null;
  const champ = profile.champions.find((entry) => championKey(entry.champion) === championKey(champion)) as LearnedChampionProfile | undefined;
  const decided = champ ? champ.wins + champ.losses : 0;
  // Remakes and games under 5 minutes never reach champion stats, and partial games never reach build learning,
  // so one complete game is enough for a path. Older profile.json files have no `learned`: they are rebuilt on start.
  const learned = champ?.learned;
  const learnedPath = learned?.path ?? null;
  // New on the champion: the games so far were played while learning it (often on Rift Lens' generic defaults, which the
  // profile would then learn and feed back), so the history does not shape the build until NEW_CHAMPION_GAMES.
  const completeGames = champ ? newChampionGames(champ) : 0;
  const newOnChampion = completeGames < NEW_CHAMPION_GAMES;
  const usualBuild = !newOnChampion && learnedPath?.items.length ? learnedPath.items : null;
  const usualBuildGames = usualBuild ? learnedPath!.games : 0;
  const habitLine = [
    learned?.firstBack ? `Usual first back: ${learned.firstBack.items.join(" + ")} (${learned.firstBack.games} of last ${learned.firstBack.of} games)` : "",
    learned?.boots ? `usual boots: ${learned.boots.item} (${learned.boots.games} of ${learned.boots.of} games)` : champ?.boots[0] ? `usual boots: ${champ.boots[0].item}` : "",
  ].filter(Boolean).join("; ");
  const preferredItems = itemsFor(profile.preferences.preferredItems, champion);
  const avoidItems = itemsFor(profile.preferences.avoidItems, champion);
  const notes = notesFor(profile.preferences.notes, champion).slice(0, 4);

  let matchupNote: string | null = null;
  if (laneOpponent) {
    const matchup = profile.matchups.find((entry) => championKey(entry.champion) === championKey(champion) && championKey(entry.enemy) === championKey(laneOpponent));
    const generic = profile.matchups.filter((entry) => championKey(entry.enemy) === championKey(laneOpponent));
    if (matchup) matchupNote = `${champion} vs ${laneOpponent}: ${plural(matchup.wins, "win")} in ${plural(matchup.games, "game")}, died to ${laneOpponent} ${plural(matchup.deathsToEnemy, "time")}.`;
    else if (generic.length) {
      const games = generic.reduce((sum, entry) => sum + entry.games, 0);
      const wins = generic.reduce((sum, entry) => sum + entry.wins, 0);
      const deaths = generic.reduce((sum, entry) => sum + entry.deathsToEnemy, 0);
      matchupNote = `First time on ${champion} into ${laneOpponent}; on other champions: ${plural(wins, "win")} in ${plural(games, "game")}, ${plural(deaths, "death")} to them.`;
    }
  }

  const enemyKeys = new Set(enemyChampions.map(championKey));
  const killerNotes = profile.killers
    .filter((entry) => enemyKeys.has(championKey(entry.champion)) && entry.deathsTo >= 2)
    .slice(0, 3)
    .map((entry) => `${entry.champion} has killed you ${entry.deathsTo} times across ${entry.games} game${entry.games === 1 ? "" : "s"}.`);
  const issues = profile.issues.slice(0, 3);
  const focus = profile.focus;
  const winRateOnChampion = decided ? round(champ!.wins / decided, 2) : null;

  const fromHistory = champ?.sources?.history || 0;
  // With a curated top build, history is no longer the build source: it only picks between the top build's options.
  const meta = metaBuildFor(champion);
  const metaLeads = Boolean(meta && !pinnedBuild && !importedBuild);
  const historyLabel = pinnedBuild || importedBuild || metaLeads ? "" : "Active build source: history. ";
  const metaLine = metaLeads
    ? `Active build source: the current top ${champion} build (patch ${meta!.patch}, ${meta!.sample})${newOnChampion ? "." : "; the usual build is what the player actually does and only picks between its options."}`
    : "";
  const following = pinnedBuild ? "following your pinned build" : importedBuild ? "following your imported item set" : meta ? "following the top build" : "following Rift Lens defaults";
  const newLine = `New on ${champion} (${plural(completeGames, "game")}): ${following}; past ${champion} games do not shape the build until ${NEW_CHAMPION_GAMES} complete games.`;
  // Recomputed from the finished-item counts so a build researched after the last rebuild is used right away.
  const checkLine = champ ? buildCheckLine(champ.finishedItems?.length ? checkBuild(champ) : champ.buildCheck ?? null) : "";
  const laterText = (later: NonNullable<LearnedBuild["path"]>["later"]) => (later || []).map((entry) => `${entry.item} (${entry.games} games)`).join(" > ");
  const buildLine = newOnChampion
    ? (champ ? newLine : "")
    : !usualBuild
    ? ""
    : learnedPath!.core === 0
      // No recorded purchase order on this champion: match-history items in their usual inventory slot.
      ? `${historyLabel}Items usually finished on ${champion} (client match history, order approximate): ${laterText(learnedPath!.later)}.`
      : usualBuildGames === 1
        ? `${historyLabel}${champion} build from the last recorded game: ${usualBuild.join(" > ")} (${learnedPath!.wins ? "a win" : "not a win"}).`
        : `${historyLabel}Usual ${champion} build: core ${usualBuild.slice(0, learnedPath!.core ?? usualBuild.length).join(" > ")} (${usualBuildGames} of last ${learnedPath!.of} games, ${plural(champ!.wins, "win")} overall on ${champion})${learnedPath!.later?.length ? `, then usually ${laterText(learnedPath!.later)}` : ""}.`;
  const lines = [
    champ
      ? `On ${champion}: ${champ.games} ${fromHistory ? `game${champ.games === 1 ? "" : "s"} (${fromHistory} from match history)` : `recorded game${champ.games === 1 ? "" : "s"}`}${decided ? `, ${winLoss(champ.wins, decided)} (${Math.round((winRateOnChampion || 0) * 100)}% WR)` : ""}, avg KDA ${champ.avg.kills}/${champ.avg.deaths}/${champ.avg.assists}${champ.avgCsAt10 !== null ? `, CS@10 ${champ.avgCsAt10}` : ""}.`
      : `No recorded games on ${champion} yet (${profile.gamesRecorded} games recorded overall).`,
    pinnedBuild
      ? `Active build source: the player's pinned ${champion} build: ${pinnedBuild.join(" > ")}. Follow it; label any change a deviation.`
      : importedBuild
        ? `Active build source: imported item set "${importedBuild.title}": ${importedBuild.items.join(" > ")}.`
        : "",
    buildLine,
    metaLine,
    checkLine,
    habitLine ? `${habitLine.charAt(0).toUpperCase()}${habitLine.slice(1)}.` : "",
    preferredItems.length ? `Player prefers: ${preferredItems.join(", ")}.` : "",
    avoidItems.length ? `Player avoids: ${avoidItems.join(", ")}.` : "",
    matchupNote || "",
    ...killerNotes.slice(0, 2),
    ...issues.slice(0, 2).map((issue) => `Recurring issue - ${issue.label}: ${issue.evidence}`),
    focus ? `Current focus: ${focus.title}${focusTarget(focus)}.` : "",
    ...notes.slice(0, 2).map((note) => `Player note: ${note}`),
    // The build line carries up to six items with game counts, so it may run longer than the rest.
  ].filter(Boolean).map((line) => {
    const max = line === buildLine || line === checkLine ? 280 : 200;
    return line.length > max ? `${line.slice(0, max - 3)}...` : line;
  }).slice(0, 10);

  return {
    champion,
    gamesOnChampion: champ?.games || 0,
    winRateOnChampion,
    usualBuild,
    usualBuildGames,
    newOnChampion,
    completeGamesOnChampion: completeGames,
    pinnedBuild,
    importedBuild,
    preferredItems,
    avoidItems,
    matchupNote,
    killerNotes,
    issues,
    focus,
    notes,
    lines,
  };
}

/** Cheap per-poll lookup: served from memory, recomputed only after a rebuild or settings change. */
export async function getPlayerBrief(champion: string, enemyChampions: string[], laneOpponent: string | null): Promise<PlayerBrief | null> {
  try {
    const imported = await importedBuildFor(champion).catch(() => null);
    const key = `${importsRevision()}|${metaRevision()}|${champion}|${laneOpponent || ""}|${[...enemyChampions].sort().join(",")}`;
    if (cache.briefs.has(key)) return cache.briefs.get(key) || null;
    const brief = buildBrief(await getProfile(), champion, enemyChampions, laneOpponent, imported);
    if (cache.briefs.size > 50) cache.briefs.clear();
    cache.briefs.set(key, brief);
    return brief;
  } catch (error) {
    console.error("[rift-lens] player brief failed:", error);
    return null;
  }
}

// Match-history import + merge into build learning, with synthetic games. The parse test uses the real Data Dragon catalog
// and is skipped when it is unreachable; the profile tests are pure.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/history.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChampionEntry, ChampionIndex } from "@/lib/champion-data";
import { isRealMatch, parseHistoryGame, type HistoryGame } from "@/lib/history-import";
import { getItemCatalog } from "@/lib/live-game";
import { emptySettings } from "@/lib/memory-store";
import { buildBrief, computeProfile, type LearnedChampionProfile } from "@/lib/player-profile";
import type { GameRecord } from "@/lib/types";

const catalog = await getItemCatalog();
const skip = catalog.fallback || catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;

const T0 = Date.parse("2026-10-01T18:00:00Z");
const HOUR = 3_600_000;

function record(index: number, order: string[], extra: Partial<GameRecord> = {}): GameRecord {
  const startedAt = new Date(T0 + index * HOUR).toISOString();
  return {
    id: `rec-${index}`, gameId: `g${index}`, startedAt, endedAt: new Date(T0 + index * HOUR + 1200_000).toISOString(),
    champion: "Caitlyn", position: "BOTTOM", mode: "SWIFTPLAY", modeLabel: "Swiftplay", result: "win", durationSeconds: 1200,
    laneOpponent: "Jinx", allies: [], enemies: ["Jinx"], final: { kills: 5, deaths: 2, assists: 4, cs: 60, level: 15, items: order },
    purchases: [
      { time: 5, itemId: 1055, item: "Doran's Blade", kind: "bought" },
      { time: 400, itemId: 3006, item: "Berserker's Greaves", kind: "bought" },
    ],
    deaths: [], csAt10: 40, firstCompletedItem: order[0] ? { item: order[0], time: 600 } : null, completedItemOrder: order, focusResult: null,
    ...extra,
  };
}

function imported(index: number, items: string[], extra: Partial<HistoryGame> = {}): HistoryGame {
  return {
    gameId: 1000 + index, gameCreation: T0 + index * HOUR - 20_000, durationSeconds: 1300, queueId: 480, mode: "SWIFTPLAY", mapId: 11,
    champion: "Caitlyn", championId: 51, position: null, win: false, kills: 1, deaths: 6, assists: 2, cs: 50, items, boots: "Berserker's Greaves",
    laneOpponent: null, allies: [], enemies: [], importedAt: new Date(T0).toISOString(), ...extra,
  };
}

const caitlyn = (profile: ReturnType<typeof computeProfile>) => profile.champions.find((entry) => entry.champion === "Caitlyn") as LearnedChampionProfile;

test("recorded copy wins over its match-history copy; history-only games count for stats", () => {
  const records = [record(0, ["Hexoptics C44", "The Collector"]), record(1, ["Hexoptics C44", "The Collector", "Lord Dominik's Regards"])];
  // Game 1 is in both sources (created 20s before the recording started); games 2 and 3 only in match history.
  const history = [imported(1, ["Hexoptics C44", "The Collector", "Lord Dominik's Regards"]), imported(2, ["The Collector", "Rapid Firecannon"]), imported(3, ["The Collector"])];
  const profile = computeProfile(records, emptySettings(), T0 + 10 * HOUR, history);
  assert.deepEqual(profile.sources, { recorded: 2, history: 2, linked: 1, historyStored: 3 });
  assert.equal(profile.gamesRecorded, 4);
  const champ = caitlyn(profile);
  assert.deepEqual(champ.sources, { recorded: 2, history: 2 });
  assert.equal(champ.games, 4);
  assert.equal(champ.wins, 2);
  assert.equal(champ.losses, 2);
  assert.equal(champ.avgCsAt10, 40, "CS@10 stays recorded-only");
  assert.deepEqual(champ.buildPaths.map((path) => path.games).reduce((a, b) => a + b, 0), 2, "build paths stay recorded-only");
  // Matchups need deaths: recorded only.
  assert.equal(profile.matchups.reduce((sum, entry) => sum + entry.games, 0), 2);
});

test("later items: finished in 2+ games across both sources, recorded position first, then slot", () => {
  const core = ["Hexoptics C44", "The Collector", "Yun Tal Wildarrows"];
  const records = [
    record(10, [...core, "Lord Dominik's Regards"]),
    record(11, [...core]),
    record(12, [...core, "Essence Reaver", "Lord Dominik's Regards"]),
  ];
  // Rapid Firecannon only in match history (twice), after LDR there; those games never bought Hexoptics or Yun Tal, so
  // their slots must be read after the core to compare with recorded positions.
  const history = [
    imported(1, ["The Collector", "Lord Dominik's Regards", "Rapid Firecannon"]),
    imported(2, ["The Collector", "Lord Dominik's Regards", "Rapid Firecannon"]),
  ];
  const before = caitlyn(computeProfile(records, emptySettings(), T0 + 20 * HOUR)).learned!.path!;
  assert.deepEqual(before.items, [...core, "Lord Dominik's Regards"], "recorded-only: ER finished once is not enough");
  const after = caitlyn(computeProfile(records, emptySettings(), T0 + 20 * HOUR, history)).learned!.path!;
  assert.equal(after.core, 3);
  assert.deepEqual(after.items, [...core, "Lord Dominik's Regards", "Rapid Firecannon"]);
  assert.deepEqual(after.later, [{ item: "Lord Dominik's Regards", games: 4 }, { item: "Rapid Firecannon", games: 2 }]);
  assert.equal(after.laterOf, 5);
  assert.deepEqual(caitlyn(computeProfile(records, emptySettings(), T0 + 20 * HOUR, history)).learned!.boots, { item: "Berserker's Greaves", games: 5, of: 5 });
  const brief = buildBrief(computeProfile(records, emptySettings(), T0 + 20 * HOUR, history), "Caitlyn", [], null)!;
  assert.match(brief.lines[1], /core Hexoptics C44 > The Collector > Yun Tal Wildarrows \(3 of last 3 games.*then usually Lord Dominik's Regards \(4 games\) > Rapid Firecannon \(2 games\)\.$/);
});

test("a champion only seen in match history gets its usually-finished items, most-finished first", () => {
  const viktor = (index: number, items: string[]) => imported(index, items, { champion: "Viktor", championId: 112, boots: "Sorcerer's Shoes" });
  // Zhonya's sits in slot 0 once (rearranged inventory) but is finished in only 2 of 4 games: it must not lead.
  const history = [
    viktor(1, ["Luden's Echo", "Shadowflame"]),
    viktor(2, ["Luden's Echo", "Shadowflame", "Zhonya's Hourglass"]),
    viktor(3, ["Luden's Echo", "Shadowflame"]),
    viktor(4, ["Zhonya's Hourglass", "Luden's Echo", "Shadowflame"]),
    // A 5th game: below NEW_CHAMPION_GAMES the brief would say "New on Viktor" instead.
    viktor(5, ["Luden's Echo", "Shadowflame"]),
  ];
  const champ = computeProfile([], emptySettings(), T0, history).champions[0] as LearnedChampionProfile;
  assert.equal(champ.learned!.path!.core, 0);
  assert.deepEqual(champ.learned!.path!.items, ["Luden's Echo", "Shadowflame", "Zhonya's Hourglass"]);
  assert.deepEqual(champ.learned!.boots, { item: "Sorcerer's Shoes", games: 5, of: 5 });
  const brief = buildBrief(computeProfile([], emptySettings(), T0, history), "Viktor", [], null)!;
  assert.match(brief.lines.join("\n"), /Items usually finished on Viktor \(client match history, order approximate\): Luden's Echo \(5 games\)/);
});

test("new on a champion: under 5 complete games the history never shapes the build; from 5 it does", () => {
  const yone = (index: number, items: string[]) => imported(index, items, { champion: "Yone", championId: 777, boots: "Plated Steelcaps" });
  const learning = ["Blade of The Ruined King", "Guardian Angel", "Banshee's Veil"];
  const four = [1, 2, 3, 4].map((index) => yone(index, learning));
  const newBrief = buildBrief(computeProfile([], emptySettings(), T0 + 20 * HOUR, four), "Yone", [], null)!;
  assert.equal(newBrief.newOnChampion, true);
  assert.equal(newBrief.completeGamesOnChampion, 4);
  assert.equal(newBrief.usualBuild, null, "the learning-time build is not a usual build yet");
  assert.match(newBrief.lines.join("\n"), /New on Yone \(4 games\): following (the top build|Rift Lens defaults)/);
  assert.doesNotMatch(newBrief.lines.join("\n"), /Usual Yone build|Items usually finished on Yone/);
  // A partial recording or a remake does not count toward the 5.
  const partial = record(9, learning, { champion: "Yone", partial: true, enemies: [] });
  assert.equal(buildBrief(computeProfile([partial], emptySettings(), T0 + 20 * HOUR, four), "Yone", [], null)!.newOnChampion, true);
  const five = [...four, yone(5, learning)];
  const brief = buildBrief(computeProfile([], emptySettings(), T0 + 20 * HOUR, five), "Yone", [], null)!;
  assert.equal(brief.newOnChampion, false);
  assert.deepEqual(brief.usualBuild?.slice(0, 2), ["Blade of The Ruined King", "Guardian Angel"]);
});

test("list filter keeps matchmade games only", () => {
  assert.equal(isRealMatch({ gameType: "MATCHED_GAME", gameMode: "SWIFTPLAY", gameDuration: 1100 }), true);
  assert.equal(isRealMatch({ gameType: "CUSTOM_GAME", gameMode: "PRACTICETOOL", gameDuration: 1100 }), false);
  assert.equal(isRealMatch({ gameType: "CUSTOM_GAME", gameMode: "CLASSIC", gameDuration: 1100 }), false);
  assert.equal(isRealMatch({ gameType: "MATCHED_GAME", gameMode: "SWIFTPLAY", gameDuration: 150 }), false, "remake");
});

test("detail parse: completed items in slot order, boots apart, trinket/components dropped", { skip }, () => {
  const index: ChampionIndex = new Map();
  const add = (entry: Pick<ChampionEntry, "id" | "key" | "name">) => index.set(entry.name.toLowerCase(), { ...entry, tags: [], info: { attack: 0, defense: 0, magic: 0, difficulty: 0 } });
  add({ id: "Caitlyn", key: "51", name: "Caitlyn" });
  add({ id: "Jinx", key: "222", name: "Jinx" });
  const entry = { gameId: 7, participants: [{ participantId: 2, championId: 51 }], participantIdentities: [{ participantId: 2, player: { puuid: "me" } }] };
  const detail = {
    gameId: 7, gameCreation: T0, gameDuration: 1200, gameMode: "SWIFTPLAY", gameType: "MATCHED_GAME", queueId: 480, mapId: 11,
    participantIdentities: [{ participantId: 1, player: { puuid: "other" } }, { participantId: 2, player: { puuid: "me" } }],
    participants: [
      { participantId: 1, teamId: 200, championId: 222, timeline: { lane: "BOTTOM", role: "DUO_CARRY" }, stats: {} },
      // Hexoptics, Berserker's, Collector, Caulfield's (component), Yun Tal, Sheen, Stealth Ward.
      { participantId: 2, teamId: 100, championId: 51, timeline: { lane: "BOTTOM", role: "DUO_CARRY" },
        stats: { item0: 2523, item1: 3006, item2: 6676, item3: 3133, item4: 3032, item5: 3057, item6: 3340, win: true, kills: 11, deaths: 0, assists: 6, totalMinionsKilled: 50, neutralMinionsKilled: 6 } },
    ],
  };
  const parsed = parseHistoryGame(entry, detail, catalog, index);
  assert.ok("game" in parsed);
  const game = parsed.game;
  assert.equal(game.champion, "Caitlyn");
  assert.deepEqual(game.items, ["Hexoptics C44", "The Collector", "Yun Tal Wildarrows"]);
  assert.equal(game.boots, "Berserker's Greaves");
  assert.equal(game.cs, 56);
  assert.equal(game.win, true);
  assert.deepEqual(game.enemies, ["Jinx"]);
  assert.equal(game.position, null, "Swiftplay lanes are not trusted");
  assert.equal(game.laneOpponent, null);
});

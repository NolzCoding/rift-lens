// Post-game replay review for any champion (lib/replay-build-review.ts, lib/replay-recorded.ts, lib/replay-insights.ts,
// lib/rofl-metadata.ts). Offline: a synthetic item catalog, item-group table, top build and enemy stats.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/replay-review.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { buildEnemyStatsData, counterLevel, enemyThreatProfile } from "@/lib/enemy-stats";
import { configureItemGroups, setItemGroupsForTest } from "@/lib/item-groups";
import type { MetaBuild } from "@/lib/meta-builds";
import { reviewBuild, type BuildReviewInput, type ReviewItem } from "@/lib/replay-build-review";
import { reviewInsights } from "@/lib/replay-insights";
import { deathEvents, matchRecordedGame, recordedTimeline } from "@/lib/replay-recorded";
import { gameIdFromReplayName, readRoflMetadata } from "@/lib/rofl-metadata";
import type { GameRecord, ReplayAnalysis } from "@/lib/types";

configureItemGroups({ network: false });
setItemGroupsForTest({ patch: "test", source: "test", generatedAt: "", groups: { LastWhisper: { max: 1, items: [3035, 3036, 3033] } } });
after(() => setItemGroupsForTest(null));

const ITEMS: ReviewItem[] = [
  { id: 2523, name: "Hexoptics C44", cost: 3000, scaling: "ad", carry: true, from: [1038] },
  { id: 3031, name: "Infinity Edge", cost: 3450, scaling: "ad", carry: true, from: [1038] },
  { id: 3094, name: "Rapid Firecannon", cost: 2650, scaling: "ad", carry: true, from: [1018] },
  { id: 3036, name: "Lord Dominik's Regards", cost: 3100, scaling: "ad", carry: true, from: [3035] },
  { id: 3033, name: "Mortal Reminder", cost: 3000, scaling: "ad", carry: true, from: [3035] },
  { id: 6672, name: "Kraken Slayer", cost: 3100, scaling: "ad", from: [1038] },
  { id: 3089, name: "Rabadon's Deathcap", cost: 3600, scaling: "ap", from: [1058] },
  { id: 3165, name: "Morellonomicon", cost: 2950, scaling: "ap", from: [3916] },
  { id: 3075, name: "Thornmail", cost: 2450, scaling: "neutral", from: [1029] },
  { id: 3026, name: "Guardian Angel", cost: 3200, scaling: "neutral", from: [1038] },
  { id: 6609, name: "Chempunk Chainsword", cost: 3000, scaling: "ad", from: [3123] },
  { id: 3035, name: "Last Whisper", cost: 1450, scaling: "ad", into: [3036, 3033], from: [1036] },
  { id: 1038, name: "B. F. Sword", cost: 1300, scaling: "ad", into: [3031, 2523, 3026] },
  { id: 1001, name: "Boots", cost: 300, tags: ["Boots"], into: [3006, 3047] },
  { id: 3006, name: "Berserker's Greaves", cost: 1100, tags: ["Boots"], scaling: "neutral", from: [1001] },
  { id: 3047, name: "Plated Steelcaps", cost: 1200, tags: ["Boots"], scaling: "neutral", from: [1001] },
];
const catalog = { byId: new Map(ITEMS.map((item) => [item.id, item])) };
const ID = Object.fromEntries(ITEMS.map((item) => [item.name, item.id]));

const META: MetaBuild = {
  champion: "Caitlyn", role: "BOTTOM", patch: "16.20", verified: "2026-10-12", sample: "test", sources: [],
  slots: [
    { id: "first", label: "1st item", kind: "core", options: [{ item: "Hexoptics C44", pickRate: 62.4 }] },
    { id: "boots", label: "Boots", kind: "boots", options: [{ item: "Berserker's Greaves", pickRate: 84.6 }] },
    { id: "second", label: "2nd item", kind: "core", options: [{ item: "Infinity Edge", pickRate: 86.7 }] },
    { id: "third", label: "3rd item", kind: "core", options: [{ item: "Rapid Firecannon" }, { item: "Lord Dominik's Regards" }] },
    { id: "late", label: "Late item", kind: "situational", options: [{ item: "Guardian Angel" }, { item: "Mortal Reminder", when: "healing" }] },
  ],
  cores: [],
  offMeta: [{ item: "Kraken Slayer", pickRate: 3.1, note: "rare" }],
};

// Synthetic Data Dragon: squishy carries, a healing pair, an armor-stacking pair.
const champion = (id: string, tags: string[], hp = 600, armor = 30) => ({ id, name: id, tags, info: { attack: 5, defense: 5, magic: 5, difficulty: 5 }, stats: { hp, hpperlevel: 100, armor, armorperlevel: 4.5, spellblock: 30, spellblockperlevel: 1.3, attackdamage: 60, attackdamageperlevel: 3, attackspeed: 0.65, attackspeedperlevel: 2, attackrange: 500 } });
const STATS = buildEnemyStatsData("16.20.1", {
  Soraka: champion("Soraka", ["Support"]), Aatrox: champion("Aatrox", ["Fighter"]), Jinx: champion("Jinx", ["Marksman"]),
  Ornn: champion("Ornn", ["Tank"], 660, 33), Sejuani: champion("Sejuani", ["Tank"], 630, 34), Lux: champion("Lux", ["Mage"]),
}, {
  3075: { name: "Thornmail", gold: { total: 2450 }, stats: { FlatHPPoolMod: 150, FlatArmorMod: 75 } },
  3143: { name: "Randuin's Omen", gold: { total: 2700 }, stats: { FlatHPPoolMod: 350, FlatArmorMod: 75 } },
  3072: { name: "Bloodthirster", gold: { total: 3400 }, stats: { FlatPhysicalDamageMod: 80, PercentLifeStealMod: 0.15 } },
});
const enemies = (list: Array<[string, number[]]>) => enemyThreatProfile(list.map(([name, items]) => ({ champion: name, level: 16, items: items.map((id) => ({ id })), kills: 2, deaths: 2 })), STATS);
const QUIET = enemies([["Jinx", []], ["Lux", []]]);
const HEALING = enemies([["Soraka", []], ["Aatrox", []], ["Jinx", []]]);
const ARMOR = enemies([["Ornn", [3075, 3143]], ["Sejuani", [3075, 3143]], ["Jinx", []]]);

const input = (itemNames: string[], extra: Partial<BuildReviewInput> = {}): BuildReviewInput => ({
  participantId: 1, champion: "Caitlyn", role: "BOTTOM", itemIds: itemNames.map((name) => ID[name]), catalog, scaling: "ad", meta: META, enemyProfile: QUIET, ...extra,
});
const verdict = (review: ReturnType<typeof reviewBuild>, item: string) => review.items.find((entry) => entry.item === item)!;
const kinds = (review: ReturnType<typeof reviewBuild>) => review.findings.map((finding) => finding.kind);

test("top build: each owned item fills one slot; core items and boots read as good", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Berserker's Greaves", "Infinity Edge", "Rapid Firecannon"]));
  assert.equal(verdict(review, "Hexoptics C44").kind, "core");
  assert.equal(verdict(review, "Berserker's Greaves").kind, "boots");
  assert.equal(verdict(review, "Rapid Firecannon").tone, "good");
  assert.deepEqual(review.topBuild?.slots.map((slot) => slot.matched), ["Hexoptics C44", "Berserker's Greaves", "Infinity Edge", "Rapid Firecannon", null]);
  assert.deepEqual(review.findings, []);
});

test("off-meta: an item the top build never uses is flagged with its pick rate", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Kraken Slayer", "Infinity Edge"]));
  const kraken = verdict(review, "Kraken Slayer");
  assert.equal(kraken.kind, "off-meta");
  assert.equal(kraken.tone, "warn");
  assert.match(kraken.reason, /3\.1% of Caitlyns/);
  assert.ok(kinds(review).includes("off-meta"));
});

test("scaling misfit: an AP item on an AD champion is wrong stats; the same item on an AP champion is not", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Rabadon's Deathcap"]));
  assert.equal(verdict(review, "Rabadon's Deathcap").kind, "misfit");
  assert.equal(verdict(review, "Rabadon's Deathcap").tone, "bad");
  assert.ok(review.findings.some((finding) => finding.kind === "misfit" && /Rabadon's Deathcap doesn't fit Caitlyn/.test(finding.title)));
  const mage = reviewBuild(input(["Rabadon's Deathcap"], { champion: "Lux", role: "MIDDLE", scaling: "ap", meta: null }));
  assert.equal(verdict(mage, "Rabadon's Deathcap").kind, "unrated");
  assert.ok(!kinds(mage).includes("misfit"));
});

test("group lock: an unneeded Mortal Reminder took the Last Whisper slot the top build's Lord Dominik's needs", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Berserker's Greaves", "Infinity Edge", "Mortal Reminder"]));
  const lock = review.findings.find((finding) => finding.kind === "group-lock");
  assert.ok(lock, "group-lock finding");
  assert.equal(lock.title, "Your Mortal Reminder locked Lord Dominik's Regards");
  assert.match(lock.detail, /one Last Whisper item/);
  // Mortal Reminder is only a "vs healing" option and nobody healed.
  assert.equal(verdict(review, "Mortal Reminder").label, "Not needed");
});

test("group clash: two held items from one exclusive group are flagged", () => {
  const review = reviewBuild(input(["Lord Dominik's Regards", "Mortal Reminder"]));
  assert.ok(review.findings.some((finding) => finding.kind === "group-clash" && /share the Last Whisper group/.test(finding.title)));
});

test("counter misfit: Lord Dominik's with no armor stacking names the better option for the slot", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Lord Dominik's Regards"]));
  const ldr = verdict(review, "Lord Dominik's Regards");
  assert.equal(ldr.label, "Not needed");
  assert.match(ldr.reason, /no enemy stacked armor/);
  assert.match(ldr.reason, /Rapid Firecannon was the better pick/);
  assert.ok(review.findings.some((finding) => finding.kind === "counter-unneeded" && finding.title === "Lord Dominik's Regards but no enemy stacked armor"));
  // Into stacked armor the same item is the right call.
  const into = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Lord Dominik's Regards"], { enemyProfile: ARMOR }));
  assert.equal(verdict(into, "Lord Dominik's Regards").kind, "counter");
  assert.equal(verdict(into, "Lord Dominik's Regards").tone, "good");
});

test("counter gaps: no anti-heal into Soraka + Aatrox suggests one that fits the champion", () => {
  const review = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: HEALING }));
  const gap = review.findings.find((finding) => finding.kind === "counter-gap");
  assert.ok(gap, "counter-gap finding");
  assert.match(gap.title, /^No anti-heal vs .*Soraka/);
  assert.match(gap.detail, /Mortal Reminder cuts healing/);
  assert.equal(review.findings[0].kind, "counter-gap", "gaps come first");
  const mage = reviewBuild(input(["Rabadon's Deathcap"], { champion: "Lux", role: "MIDDLE", scaling: "ap", meta: null, enemyProfile: HEALING }));
  assert.match(mage.findings.find((finding) => finding.kind === "counter-gap")!.detail, /Morellonomicon/, "an AP anti-heal, not Thornmail");
  // No armor-pen gap for a mage, even into stacked armor.
  const mageArmor = reviewBuild(input(["Rabadon's Deathcap"], { champion: "Lux", role: "MIDDLE", scaling: "ap", meta: null, enemyProfile: ARMOR }));
  assert.ok(!mageArmor.findings.some((finding) => /armor penetration/.test(finding.title)));
});

// The live coach acts on heavy signals only (lib/enemy-stats.ts counterLevel); the review uses the same bar.
const SOME_HEALING = enemies([["Soraka", []], ["Jinx", [3072]], ["Lux", []]]);
const ARMOR_AND_HEALING = enemies([["Ornn", [3075, 3143]], ["Sejuani", [3075, 3143]], ["Soraka", []], ["Aatrox", []]]);

test("counter gaps use the live coach's bar: \"some\" healing (even past the card score) is no anti-heal finding", () => {
  assert.equal(SOME_HEALING.healing.level, "some", "fixture premise");
  assert.equal(counterLevel(SOME_HEALING, "healing"), "consider", "the live coach would only show a situational card");
  const review = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: SOME_HEALING }));
  assert.ok(!review.findings.some((finding) => finding.kind === "counter-gap"), review.findings.map((finding) => finding.title).join("; "));
  assert.ok(review.enemySignals.some((line) => /^healing some/.test(line)), "still listed as context");
});

test("counter gaps respect item groups: armor + healing both heavy → one Last Whisper item, anti-heal from outside the group", () => {
  assert.equal(ARMOR_AND_HEALING.armorStack.level, "heavy");
  assert.equal(ARMOR_AND_HEALING.healing.level, "heavy");
  const review = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: ARMOR_AND_HEALING }));
  const gaps = review.findings.filter((finding) => finding.kind === "counter-gap");
  const armor = gaps.find((finding) => /armor penetration/.test(finding.title));
  const heal = gaps.find((finding) => /anti-heal/.test(finding.title));
  assert.ok(armor && heal, gaps.map((finding) => finding.title).join("; "));
  assert.match(armor.detail, /Lord Dominik's Regards fits Caitlyn/, "armor comes first (the engine's order) and keeps the group");
  assert.match(heal.detail, /Chempunk Chainsword cuts healing/, "anti-heal from outside the Last Whisper group");
  const text = gaps.map((finding) => finding.detail).join(" ");
  assert.ok(!(/Lord Dominik's Regards (fits|cuts)/.test(text) && /Mortal Reminder (fits|cuts)/.test(text)), `both Last Whisper items suggested: ${text}`);
  // No other anti-heal fits an AD champion: one line names the trade-off instead of a second Last Whisper item.
  const narrow = { byId: new Map([...catalog.byId].filter(([id]) => id !== 6609)) };
  const traded = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: ARMOR_AND_HEALING, catalog: narrow }));
  const tradedHeal = traded.findings.find((finding) => /anti-heal/.test(finding.title))!;
  assert.match(tradedHeal.detail, /Mortal Reminder would answer it too, but it shares the Last Whisper group with Lord Dominik's Regards/);
  assert.ok(!/Thornmail/.test(tradedHeal.detail), "never a tank item as a marksman's anti-heal");
  // Owning Mortal Reminder (the final items) locks every Last Whisper suggestion.
  const owning = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Mortal Reminder"], { enemyProfile: ARMOR_AND_HEALING }));
  assert.ok(!owning.findings.some((finding) => finding.kind === "counter-gap" && /Lord Dominik's Regards fits/.test(finding.detail)));
});

test("counter gaps with the recorded timeline: judged from when the signal turned heavy, with what was bought after", () => {
  const timeline = [{ time: 600, profile: QUIET }, { time: 1324, profile: ARMOR }, { time: 1500, profile: ARMOR }];
  const review = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon", "Guardian Angel"], {
    enemyProfile: ARMOR, enemyTimeline: timeline,
    completedOrder: [{ itemId: 2523, item: "Hexoptics C44", time: 500 }, { itemId: 3031, item: "Infinity Edge", time: 900 }, { itemId: 3094, item: "Rapid Firecannon", time: 1100 }, { itemId: 3026, item: "Guardian Angel", time: 1330 }],
  }));
  const armor = review.findings.find((finding) => finding.kind === "counter-gap" && /armor penetration/.test(finding.title));
  assert.ok(armor, review.findings.map((finding) => finding.title).join("; "));
  assert.match(armor.detail, /^From ~22:00: their armor is stacking/);
  assert.match(armor.detail, /You finished Guardian Angel at 22:10 after that/);
  // Heavy only in the final items, never during the recorded game (no purchase could answer it): still flagged, labelled.
  const late = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: ARMOR, enemyTimeline: [{ time: 600, profile: QUIET }] }));
  assert.match(late.findings.find((finding) => /armor penetration/.test(finding.title))!.detail, /^By the end of the game: /);
  // Heavy during the game but not at the end still counts (the decision was mid-game).
  const midGame = reviewBuild(input(["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], { enemyProfile: QUIET, enemyTimeline: [{ time: 900, profile: ARMOR }] }));
  assert.ok(midGame.findings.some((finding) => /armor penetration/.test(finding.title)));
});

test("missing core and buy order (recorded purchase times)", () => {
  const missing = reviewBuild(input(["Hexoptics C44", "Rapid Firecannon", "Guardian Angel"]));
  assert.ok(missing.findings.some((finding) => finding.kind === "missing-core" && finding.title === "No Infinity Edge"));
  const order = reviewBuild(input(["Hexoptics C44", "Rapid Firecannon", "Infinity Edge"], {
    completedOrder: [{ itemId: 2523, item: "Hexoptics C44", time: 500 }, { itemId: 3094, item: "Rapid Firecannon", time: 800 }, { itemId: 3031, item: "Infinity Edge", time: 1100 }],
  }));
  const finding = order.findings.find((entry) => entry.kind === "order");
  assert.ok(finding);
  assert.equal(finding.title, "You bought Rapid Firecannon before Infinity Edge");
  assert.match(finding.detail, /13:20 and Infinity Edge at 18:20/);
});

// ---------------------------------------------------------------------------------------------------------------
// Recorded match pairing + timeline

const record = (extra: Partial<GameRecord>): GameRecord => ({
  id: "r1", gameId: "g", startedAt: "2026-10-18T19:46:33.000Z", endedAt: null, champion: "Yone", position: "MIDDLE", mode: "SWIFTPLAY", modeLabel: "Swiftplay",
  result: "win", durationSeconds: 1596, laneOpponent: "Akali", allies: [], enemies: [],
  final: { kills: 0, deaths: 0, assists: 0, cs: 0, level: 18, items: [] }, purchases: [], deaths: [], csAt10: 50, firstCompletedItem: null, completedItemOrder: [], focusResult: null,
  ...extra,
});

test("recorded match: game start within ±3 min wins; otherwise same length (±90 s) and result", () => {
  const records = [record({ id: "a" }), record({ id: "b", startedAt: "2026-10-18T21:00:00.000Z", durationSeconds: 1600 }), record({ id: "c", champion: "Caitlyn" })];
  const start = Date.parse("2026-10-18T19:46:22.715Z");
  assert.equal(matchRecordedGame(records, { champion: "Yone", durationSeconds: 1595, startedAtMs: start, win: true })?.record.id, "a");
  assert.equal(matchRecordedGame(records, { champion: "Yone", durationSeconds: 1595, startedAtMs: start + 10 * 60_000, win: true }), null, "known start out of window: no guess");
  const byLength = matchRecordedGame(records, { champion: "Yone", durationSeconds: 1601, startedAtMs: null, win: true });
  assert.equal(byLength?.record.id, "b");
  assert.equal(byLength?.matchedBy, "duration");
  assert.equal(matchRecordedGame(records, { champion: "Yone", durationSeconds: 1601, startedAtMs: null, win: false }), null, "result must agree");
});

test("recorded timeline: finished items in order, CS@10 average, deaths become timeline moments", () => {
  const game = record({
    purchases: [
      { time: 232, itemId: 1001, item: "Boots", kind: "bought" }, { time: 406, itemId: 6673, item: "Immortal Shieldbow", kind: "bought" },
      { time: 408, itemId: 3006, item: "Berserker's Greaves", kind: "bought" }, { time: 890, itemId: 3031, item: "Infinity Edge", kind: "bought" },
    ],
    deaths: [
      { time: 884, killer: "x", killerChampion: "Teemo", assisters: ["Zaahen", "Akali"], goldUnspent: 3283, level: 14, items: [] },
      { time: 300, killer: "y", killerChampion: "Akali", assisters: [], goldUnspent: 200, level: 6, items: [] },
    ],
  });
  const timeline = recordedTimeline(game, "game-id", [game, record({ id: "old", csAt10: 30 }), record({ id: "old2", csAt10: 40 })], (id) => [6673, 3006, 3031].includes(id));
  assert.deepEqual(timeline.completed.map((entry) => entry.item), ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge"]);
  assert.equal(timeline.csAt10Average, 35);
  const events = deathEvents(timeline, "Yone", "Akali");
  assert.equal(events[0].title, "Died to Teemo + 2");
  assert.match(events[0].why, /3 against 1.*3,283g/);
  assert.match(events[0].recommendation, /Recall and spend/);
  assert.match(events[1].why, /early solo death to your lane opponent/);
  assert.ok(events.every((event) => event.quality === "improve" && event.confidence.includes("recorded")));
});

// ---------------------------------------------------------------------------------------------------------------
// Insights (overview + priorities) and .rofl metadata

test("insights: lane gold decides the headline and deaths holding gold become the first priority", () => {
  const analysis = {
    schemaVersion: 2,
    replay: { name: "x.rofl", sha256: "x", clientVersion: "16.20.1", durationMs: 1_595_000, teamKills: 40, outcome: "win", mode: { queueId: 480, gameMode: "SWIFTPLAY", gameType: "", mapId: 11, label: "Swiftplay", class: "swiftplay", source: "league-client", verified: true } },
    players: [{ index: 2, participantId: 3, champion: "Yone", name: "Me#1", team: 100, position: "MIDDLE", win: true, kills: 17, deaths: 4, assists: 5, killParticipation: 0.55, laneCs: 124, jungleCs: 0, cs: 124, gold: 19692, level: 18, damage: 43704, damageShare: 0.34, buildingDamage: 7696, vision: 19, wardsPlaced: 7, wardsKilled: 0, longestLife: 677, teammateShielding: 0, items: [], itemIds: [], runes: [], spellInputs: { Q: 0, W: 0, E: 0, R: 0 }, immobilizations: 0 }],
    enemyLane: [{ participantId: 8, champion: "Akali", name: "", position: "MIDDLE", kills: 1, deaths: 13, assists: 4, cs: 33, gold: 14583, level: 14, damage: 14708, buildingDamage: 0 }],
    deepMetrics: null, timeline: [], deepStatus: "", reportMarkdown: "",
    review: {
      version: 1, dataPatch: "16.20.1", youId: 3, allies: [], enemies: [], builds: [], caveats: [],
      recorded: { recordId: "r", startedAt: "", matchedBy: "game-id", partial: false, csAt10: 50, csAt10Average: 38, csAt10Games: 4, completed: [], purchases: [], deaths: [
        { time: 884, killer: "x", killerChampion: "Teemo", assisters: ["Zaahen", "Akali"], goldUnspent: 3283, level: 14, items: [] },
        { time: 1326, killer: "x", killerChampion: "Teemo", assisters: ["Akali", "Galio"], goldUnspent: 2952, level: 18, items: [] },
      ] },
    },
  } satisfies ReplayAnalysis;
  const insights = reviewInsights(analysis);
  assert.match(insights.headline, /^Win: You finished 5,109g and 4 levels ahead of Akali/);
  assert.equal(insights.priorities.length, 3);
  assert.equal(insights.priorities[0].title, "Spend your gold before fighting");
  assert.match(insights.priorities[0].description, /14:44 with 3,283g/);
  assert.ok(!JSON.stringify(insights).match(/Viktor|Lux/));
});

test(".rofl metadata: all ten players with items from the file's end-of-game stats; game id from the file name", () => {
  const rows = [
    { ID: 3, SKIN: "Yone", TEAM: "100", TEAM_POSITION: "MIDDLE", LEVEL: "18", ITEM0: "6673", ITEM1: "3006", ITEM6: "3340", CHAMPIONS_KILLED: "17", NUM_DEATHS: "4", ASSISTS: "5", RIOT_ID_GAME_NAME: "Sample", RIOT_ID_TAG_LINE: "TAG", WIN: "Win", GOLD_EARNED: "19692", MINIONS_KILLED: "120", NEUTRAL_MINIONS_KILLED: "4" },
    { ID: 8, SKIN: "Akali", TEAM: "200", TEAM_POSITION: "MIDDLE", LEVEL: "14", ITEM0: "3157", WIN: "Fail" },
  ];
  const json = Buffer.from(JSON.stringify({ gameLength: 1595743, statsJson: JSON.stringify(rows) }), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  const metadata = readRoflMetadata(Buffer.concat([Buffer.from("RIOT\u0002\u0000replay-bytes", "latin1"), json, length]));
  assert.ok(metadata);
  assert.equal(metadata.gameLengthMs, 1595743);
  assert.deepEqual(metadata.participants[0], { participantId: 3, champion: "Yone", name: "Sample#TAG", team: 100, position: "MIDDLE", level: 18, kills: 17, deaths: 4, assists: 5, gold: 19692, cs: 124, win: true, itemIds: [6673, 3006], items: [] });
  assert.equal(metadata.participants[1].win, false);
  assert.equal(readRoflMetadata(Buffer.from("not a replay at all")), null);
  assert.equal(gameIdFromReplayName("EUW1-1234567890.rofl"), 1234567890);
  assert.equal(gameIdFromReplayName("my replay.rofl"), null);
});

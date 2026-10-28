// Deterministic engine unit tests with synthetic inputs (ported from the swap/boots/resell scratch checks).
// Uses the real Data Dragon catalog; every test is skipped when it is unreachable.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/engine.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { configureItemGroups } from "@/lib/item-groups";
import { findItem, getItemCatalog, normalizeLiveData, resetGameMemory, type ItemCatalog, type RawLiveData } from "@/lib/live-game";
import { resolveBuys } from "@/lib/live-help-build";
import { configureChampionTraits } from "@/lib/champion-traits";
import { buildCheck, buildCheckLine, metaBuildFor, registerResearchedBuilds } from "@/lib/meta-builds";
import type { LiveGameSnapshot, PlayerBrief } from "@/lib/types";

import { caitlynResearched } from "./fixtures/meta";

// Exclusive item groups: the disk cache or the bundled table, never a background CommunityDragon download from a test.
configureItemGroups({ network: false });
// Champion traits from the bundled table only (no disk cache, no CommunityDragon download), so results are reproducible.
configureChampionTraits({ network: false, disk: false });
const catalog: ItemCatalog = await getItemCatalog();
// The Caitlyn BOTTOM top build these tests follow, registered as research for the current patch (lib/meta-builds.ts no
// longer holds curated champion data).
registerResearchedBuilds([caitlynResearched(catalog.version)]);
const skip = catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;

const ID = {
  hexoptics: 2523, collector: 6676, berserkers: 3006, ldr: 3036, rfc: 3094, longSword: 1036, ie: 3031, bt: 3072,
  noonquiver: 6670, boots: 1001, ward: 3340, yunTal: 3032, ga: 3026,
};
const name = (id: number) => catalog.byId.get(id)?.name || String(id);

type It = number;
const player = (who: string, champ: string, team: string, position: string, items: It[] = [], opts: { k?: number; d?: number; dead?: boolean; level?: number } = {}) => ({
  championName: champ, riotId: `${who}#EUW`, summonerName: who, team, position, level: opts.level ?? 16, isDead: Boolean(opts.dead), respawnTimer: opts.dead ? 18 : 0,
  scores: { kills: opts.k ?? 0, deaths: opts.d ?? 0, assists: 0, creepScore: 150 },
  items: items.map((id) => ({ itemID: id, displayName: name(id), price: catalog.byId.get(id)?.cost || 0, count: 1 })),
});
function raw(items: It[], gold: number, time: number, opts: { dead?: boolean; level?: number } = {}): RawLiveData {
  const level = opts.level ?? 16;
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: gold, level, championStats: { currentHealth: opts.dead ? 0 : 900, maxHealth: 1700 } },
    allPlayers: [
      player("Me", "Caitlyn", "ORDER", "BOTTOM", items, { dead: opts.dead, level }),
      player("A1", "Lux", "ORDER", "UTILITY"), player("A2", "Viktor", "ORDER", "MIDDLE"), player("A3", "Darius", "ORDER", "TOP"), player("A4", "Vi", "ORDER", "JUNGLE"),
      player("E1", "Jhin", "CHAOS", "BOTTOM", [], { k: 8, d: 1 }), player("E2", "Soraka", "CHAOS", "UTILITY"), player("E3", "Zed", "CHAOS", "MIDDLE", [], { k: 5, d: 1 }),
      player("E4", "Aatrox", "CHAOS", "TOP"), player("E5", "Kha'Zix", "CHAOS", "JUNGLE", [], { k: 9, d: 2 }),
    ],
    events: { Events: opts.dead ? [{ EventID: 9, EventName: "ChampionKill", EventTime: time - 4, KillerName: "E3", VictimName: "Me", Assisters: ["E5"] }] : [] },
    gameData: { gameMode: "SWIFTPLAY", gameTime: time, mapName: "Map11", mapNumber: 11 },
  };
}
const brief: PlayerBrief = {
  champion: "Caitlyn", gamesOnChampion: 2, winRateOnChampion: 1, usualBuild: ["Hexoptics C44", "The Collector"], usualBuildGames: 2, pinnedBuild: null, importedBuild: null,
  preferredItems: [], avoidItems: [], matchupNote: null, killerNotes: [], issues: [], focus: null, notes: [], lines: [],
};
// Every call is its own scenario on one shared roster: no steady signals or slotted boots from the previous call.
const run = (input: RawLiveData, sold: number[] = []) => { resetGameMemory(); return normalizeLiveData(input, { loadBrief: async () => brief, soldItemIds: () => sold }); };

function tree(id: number, out = new Set<number>(), depth = 0) {
  for (const child of catalog.byId.get(id)?.from || []) { out.add(child); if (depth < 4) tree(child, out, depth + 1); }
  return out;
}
const isUpgradedBoots = (id: number) => id !== ID.boots && Boolean(catalog.byId.get(id)?.tags?.includes("Boots"));
const allRecs = (snap: LiveGameSnapshot) => [...snap.recommendations, ...(snap.mobilityRecommendation ? [snap.mobilityRecommendation] : [])];
const pathText = (snap: LiveGameSnapshot) => snap.buildPath.steps.map((s) => `${s.item}(${s.status})`).join(" > ");

function assertNoSellRebuy(snap: LiveGameSnapshot) {
  const ownedPath = new Set(snap.buildPath.steps.filter((s) => s.status === "owned").map((s) => s.itemId));
  for (const rec of allRecs(snap)) {
    if (!rec.swapPlan) continue;
    const sell = rec.swapPlan.sellItemId;
    assert.ok(!tree(rec.itemId).has(sell), `swap for ${rec.item} sells ${rec.swapPlan.sellItem}, which is in its recipe tree`);
    assert.ok(!ownedPath.has(sell), `swap for ${rec.item} sells ${rec.swapPlan.sellItem}, an owned build-path step (${pathText(snap)})`);
  }
}

test("swap: 26m full inventory with a Long Sword never sells a recipe piece of the target", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.collector, ID.berserkers, ID.ldr, ID.rfc, ID.longSword], 2900, 1560));
  assertNoSellRebuy(snap);
});

test("swap: 31m full inventory without boots never sells Hexoptics/Collector (owned path steps)", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.collector, ID.ldr, ID.rfc, ID.ie, ID.bt], 3800, 1860));
  assertNoSellRebuy(snap);
  for (const rec of allRecs(snap)) {
    assert.notEqual(rec.swapPlan?.sellItemId, ID.hexoptics, `${rec.item} swap sells Hexoptics C44`);
    assert.notEqual(rec.swapPlan?.sellItemId, ID.collector, `${rec.item} swap sells The Collector`);
  }
});

test("sold: Hexoptics sold earlier this game is not recommended or put back on the path", { skip }, async () => {
  const snap = await run(raw([ID.collector, ID.berserkers], 2500, 1200), [ID.hexoptics]);
  assert.ok(!allRecs(snap).some((rec) => rec.itemId === ID.hexoptics), `recommendations include Hexoptics: ${allRecs(snap).map((r) => r.item).join(", ")}`);
  assert.ok(!snap.buildPath.steps.some((s) => s.itemId === ID.hexoptics && s.status !== "owned"), `path re-adds Hexoptics: ${pathText(snap)}`);
});

test("boots: dead at 9:00 with Noonquiver + Boots, 1480g: buyNow fits gold, no duplicate buys, goals consistent", { skip }, async () => {
  const snap = await run(raw([ID.noonquiver, ID.boots, ID.ward], 1480, 540, { dead: true, level: 9 }));
  const moment = snap.deathMoment;
  assert.ok(moment, "deathMoment is set while dead");
  const total = moment.buyNow.reduce((sum, buy) => sum + buy.cost, 0);
  assert.ok(total <= 1480, `buyNow ${total}g > 1480g`);
  assert.ok(!moment.buyNow.some((buy) => buy.itemId === ID.noonquiver), "buyNow re-buys Noonquiver");
  for (const goal of moment.goals) {
    assert.ok(goal.remainingAfter >= 0 && goal.remainingAfter === Math.max(0, goal.costNow - goal.spendNow), `goal ${goal.item} inconsistent: ${JSON.stringify(goal)}`);
    assert.ok(goal.spendNow <= goal.costNow, `goal ${goal.item} spends ${goal.spendNow} > costNow ${goal.costNow}`);
  }
});

test("boots: alive at 10:00 with Hexoptics done and no boots: upgraded boots are an early path step", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.ward], 900, 600, { level: 10 }));
  const early = snap.buildPath.steps.filter((s) => s.status !== "owned").slice(0, 2);
  assert.ok(early.some((s) => isUpgradedBoots(s.itemId)), `no boots in the next 2 steps: ${pathText(snap)}`);
  assert.ok(snap.mobilityRecommendation && isUpgradedBoots(snap.mobilityRecommendation.itemId), "boots card missing");
});

test("boots: dead at 12:00 with Hexoptics, no boots, 2100g: shopping list starts on boots and fits gold", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.ward], 2100, 720, { dead: true, level: 11 }));
  const moment = snap.deathMoment;
  assert.ok(moment, "deathMoment is set while dead");
  assert.ok(moment.buyNow.length > 0, "buyNow is empty with 2100g");
  assert.ok(moment.buyNow.reduce((sum, buy) => sum + buy.cost, 0) <= 2100, "buyNow exceeds gold");
  assert.ok(moment.buyNow.some((buy) => isUpgradedBoots(buy.itemId) || buy.itemId === ID.boots), `no boots purchase: ${moment.buyNow.map((b) => b.item).join(", ")}`);
});

test("boots: owning Berserker's Greaves means no boots step or boots card", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers], 900, 700, { level: 11 }));
  assert.equal(snap.mobilityRecommendation, null);
  assert.ok(!snap.buildPath.steps.some((s) => s.status !== "owned" && isUpgradedBoots(s.itemId)), `unowned boots step: ${pathText(snap)}`);
});

test("objectives: Swiftplay at 5:00 shows Baron 12:00 and Elder 15:00, no grubs/herald/atakhan", { skip }, async () => {
  const snap = await run(raw([ID.noonquiver], 500, 300, { level: 6 }));
  const byId = new Map(snap.objectives.map((o) => [o.id, o]));
  assert.equal(byId.get("baron")?.nextSpawnAt, 720);
  assert.equal(byId.get("elder")?.nextSpawnAt, 900);
  for (const gone of ["grubs", "herald", "atakhan"] as const) assert.ok(!byId.has(gone), `Swiftplay shows ${gone}`);
});

// Top build (lib/meta-builds.ts): Caitlyn bottom follows the fixture build's slots; history only picks between a slot's options.
const runWith = (input: RawLiveData, usualBuild: string[]) => { resetGameMemory(); return normalizeLiveData(input, { loadBrief: async () => ({ ...brief, usualBuild }), soldItemIds: () => [] }); };
const unownedSteps = (snap: LiveGameSnapshot) => snap.buildPath.steps.filter((s) => s.status !== "owned").map((s) => s.item);

test("meta: a player who builds The Collector first gets The Collector in slot 1 (Hexoptics dropped)", { skip }, async () => {
  const snap = await runWith(raw([ID.ward], 500, 60, { level: 3 }), ["The Collector", "Hexoptics C44", "Rapid Firecannon"]);
  assert.equal(snap.buildPath.source, "meta", pathText(snap));
  assert.equal(snap.buildPath.steps[0]?.item, name(ID.collector), pathText(snap));
  assert.ok(!snap.buildPath.steps.some((s) => s.itemId === ID.hexoptics), `Hexoptics also on the path: ${pathText(snap)}`);
  assert.equal(snap.recommendations[0]?.itemId, ID.collector);
  assert.match(snap.buildPath.label, /your picks/);
});

test("meta: Yun Tal / Essence Reaver from history never enter the path; IE does", { skip }, async () => {
  const snap = await runWith(raw([ID.hexoptics, ID.berserkers], 500, 600, { level: 10 }), ["Hexoptics C44", "Yun Tal Wildarrows", "Essence Reaver", "The Collector"]);
  const names = snap.buildPath.steps.map((s) => s.item);
  assert.ok(!names.includes(name(ID.yunTal)) && !names.includes("Essence Reaver"), `off-meta item on the path: ${pathText(snap)}`);
  assert.equal(unownedSteps(snap)[0], name(ID.ie), pathText(snap));
  assert.equal(snap.recommendations[0]?.itemId, ID.ie);
});

test("meta: owned LDR fills the 3rd slot and Rapid Firecannon moves to the 4th", { skip }, async () => {
  const snap = await runWith(raw([ID.hexoptics, ID.berserkers, ID.ldr], 500, 900, { level: 12 }), ["Hexoptics C44", "The Collector"]);
  assert.ok(snap.buildPath.steps.some((s) => s.itemId === ID.ldr && s.status === "owned"), pathText(snap));
  // The fixture's enemies are fed and 4 levels up (heavy burst), so Guardian Angel moves up to the 4th completed item.
  const burstHeavy = snap.enemyProfile?.burstThreat.level === "heavy";
  assert.deepEqual(unownedSteps(snap).slice(0, 3), burstHeavy ? [name(ID.ie), name(ID.ga), name(ID.rfc)] : [name(ID.ie), name(ID.rfc), name(ID.ga)], pathText(snap));
  assert.equal(snap.buildPath.steps.filter((s) => s.itemId === ID.rfc).length, 1, pathText(snap));
});

test("meta: a started later item (Last Whisper toward LDR) is finished before Infinity Edge", { skip }, async () => {
  const lastWhisper = 3035;
  if (!catalog.byId.get(ID.ldr)?.from?.includes(lastWhisper)) return; // recipe changed on this patch
  const snap = await runWith(raw([ID.hexoptics, ID.berserkers, lastWhisper], 500, 800, { level: 11 }), ["Hexoptics C44", "The Collector"]);
  // The fixture's Soraka + Aatrox heal heavily: Mortal Reminder then claims the Last Whisper group (one item per inventory),
  // so the Last Whisper finishes into Mortal Reminder instead of Lord Dominik's Regards.
  const lastWhisperItem = snap.enemyProfile?.healing.level === "heavy" ? 3033 : ID.ldr;
  assert.deepEqual(unownedSteps(snap).slice(0, 2), [name(lastWhisperItem), name(ID.ie)], pathText(snap));
  assert.equal(snap.recommendations[0]?.itemId, lastWhisperItem);
  assert.ok(!snap.buildPath.steps.some((s) => s.itemId === (lastWhisperItem === ID.ldr ? 3033 : ID.ldr)), `both Last Whisper items on the path: ${pathText(snap)}`);
});

test("meta: an owned off-meta item stays an owned step and is never re-recommended", { skip }, async () => {
  const snap = await runWith(raw([ID.hexoptics, ID.berserkers, ID.yunTal], 500, 900, { level: 12 }), ["Hexoptics C44", "Yun Tal Wildarrows"]);
  assert.ok(snap.buildPath.steps.some((s) => s.itemId === ID.yunTal && s.status === "owned"), pathText(snap));
  assert.ok(!allRecs(snap).some((rec) => rec.itemId === ID.yunTal), "Yun Tal recommended again");
  assert.equal(unownedSteps(snap)[0], name(ID.ie), pathText(snap));
});

test("build check: off-meta habits and rarely finished core items carry the pick-rate facts", () => {
  const meta = metaBuildFor("Caitlyn", "BOTTOM")!;
  const check = buildCheck(meta, {
    finished: [{ item: "The Collector", games: 11 }, { item: "Rapid Firecannon", games: 5 }, { item: "Lord Dominik's Regards", games: 4 }, { item: "Yun Tal Wildarrows", games: 3 }, { item: "Essence Reaver", games: 2 }, { item: "Infinity Edge", games: 1 }, { item: "Jak'Sho, The Protean", games: 1 }],
    boots: [{ item: "Berserker's Greaves", games: 6 }, { item: "Boots of Swiftness", games: 4 }],
    games: 11,
  })!;
  assert.deepEqual(check.offMeta.map((row) => row.item), ["Boots of Swiftness", "Yun Tal Wildarrows", "Essence Reaver"]);
  assert.equal(check.offMeta[1].text, "Yun Tal Wildarrows: 4.6% of Caitlyns build it — you finished it in 3 of 11 games");
  assert.deepEqual(check.rareCore.map((row) => row.text), ["Infinity Edge: 87% of Caitlyns build it — you finished it in 1 of 11 games"]);
  assert.match(buildCheckLine(check), /^Build check \(top build 16\.20\): off-meta .*Yun Tal Wildarrows 3\/11 \(4\.6% of Caitlyns\).*rarely finished Infinity Edge 1\/11 \(87% of Caitlyns\)\.$/);
  assert.equal(metaBuildFor("Caitlyn", "MIDDLE")?.servedFor, "MIDDLE", "no mid entry: the bot build stands in");
  assert.equal(metaBuildFor("Caitlyn", "UTILITY"), null);
  assert.equal(metaBuildFor("Jinx", "BOTTOM"), null);
});

// HELP ME: AI buy options that sell an item only to buy it (or its recipe) back are dropped server-side.
function helpSnapshot(ids: number[], gold: number, path: Array<[number, "owned" | "next" | "later"]>) {
  return {
    activePlayer: { items: ids.map((id) => ({ id, name: name(id), count: 1, price: catalog.byId.get(id)?.cost || 0, description: "" })), currentGold: gold, champion: "Caitlyn", roles: ["Marksman"], damageProfile: "physical" },
    buildPath: { source: "history", label: "", steps: path.map(([id, status]) => ({ itemId: id, item: name(id), cost: catalog.byId.get(id)?.cost || 0, status })) },
    playerBrief: null,
  } as unknown as LiveGameSnapshot;
}

test("resell: AI 'sell Long Sword, buy Yun Tal' is dropped (Long Sword is in Yun Tal's tree)", { skip }, () => {
  const snapshot = helpSnapshot([ID.hexoptics, ID.collector, ID.berserkers, ID.ldr, ID.rfc, ID.longSword], 2900, [[ID.hexoptics, "owned"], [ID.collector, "owned"], [ID.yunTal, "next"], [ID.ie, "later"]]);
  const review = { buyOptions: [{ item: "Yun Tal Wildarrows", targetItem: "Yun Tal Wildarrows", timing: "next-recall" as const, reason: "Endgame swap: sell Long Sword for 245g, then buy Yun Tal Wildarrows for 3000g." }] };
  if (!tree(ID.yunTal).has(ID.longSword)) return; // recipe changed on this patch: the premise no longer holds
  assert.deepEqual(resolveBuys(review, snapshot, catalog).map((b) => b.item), []);
});

test("resell: AI 'sell Hexoptics for GA / boots' is dropped (owned path step); 'sell RFC for GA' is kept", { skip }, () => {
  const snapshot = helpSnapshot([ID.hexoptics, ID.collector, ID.ldr, ID.rfc, ID.ie, ID.bt], 3800, [[ID.hexoptics, "owned"], [ID.collector, "owned"], [ID.yunTal, "next"], [ID.ga, "later"]]);
  const bad = { buyOptions: [
    { item: "Guardian Angel", targetItem: "Guardian Angel", timing: "endgame-swap" as const, reason: "Conditional survival swap: sell Hexoptics C44 for 1960g, buy Guardian Angel for 3200g." },
    { item: "Berserker's Greaves", targetItem: "Berserker's Greaves", timing: "endgame-swap" as const, reason: "Boots checkpoint: sell Hexoptics C44 for 1960g, buy Berserker's Greaves for 1100g." },
  ] };
  assert.deepEqual(resolveBuys(bad, snapshot, catalog).map((b) => b.item), []);
  const good = { buyOptions: [{ item: "Guardian Angel", targetItem: "Guardian Angel", timing: "endgame-swap" as const, reason: "Sell Rapid Firecannon for 1855g, buy Guardian Angel." }] };
  assert.deepEqual(resolveBuys(good, snapshot, catalog).map((b) => b.item), ["Guardian Angel"]);
});

test("one build: an AI buy of a completed item off the build path is dropped; path steps are kept", { skip }, () => {
  const snapshot = helpSnapshot([ID.hexoptics, ID.berserkers], 3500, [[ID.hexoptics, "owned"], [ID.ie, "next"], [ID.rfc, "later"]]);
  const review = { buyOptions: [
    { item: "Guardian Angel", targetItem: "Guardian Angel", timing: "next-recall" as const, reason: "Changes your build: Guardian Angel instead of Rapid Firecannon." },
    { item: "Infinity Edge", targetItem: "Infinity Edge", timing: "next-recall" as const, reason: "Next build step." },
  ] };
  assert.deepEqual(resolveBuys(review, snapshot, catalog).map((b) => b.item), ["Infinity Edge"]);
});

// Counter-build from enemy signals inside the top build (last real game: squishy Pyke/Evelynn/MF/Tristana/Gwen team,
// Pyke fed with lethality; the path kept LDR and left Guardian Angel 6th).
const squishyPath = (snap: LiveGameSnapshot) => unownedSteps(snap);
test("meta: against a squishy team (no armor/HP stacking) armor penetration is not picked over another option", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers], 500, 600, { level: 14 }));
  const steps = squishyPath(snap);
  assert.equal(snap.enemyProfile?.armorStack.level, "none", "fixture enemies carry no armor items");
  assert.ok(!steps.slice(0, 3).includes(name(ID.ldr)), `LDR should not be among the next three steps vs no armor: ${pathText(snap)}`);
});
test("meta: heavy burst (fed lethality assassin) moves Guardian Angel up to the 4th completed item", { skip }, async () => {
  const input = raw([ID.hexoptics, ID.berserkers], 500, 900, { level: 13 });
  const lethal = ["Youmuu's Ghostblade", "Edge of Night", "Serylda's Grudge"].map((item) => findItem(catalog, item)!.id);
  input.allPlayers = input.allPlayers!.map((p) => p.championName === "Zed" ? player("E3", "Zed", "CHAOS", "MIDDLE", lethal, { k: 9, d: 1, level: 16 }) : p);
  const snap = await run(input);
  assert.equal(snap.enemyProfile?.burstThreat.level, "heavy", "fed Zed with lethality is a heavy burst threat");
  const completed = snap.buildPath.steps.filter((s) => !isUpgradedBoots(s.itemId)).map((s) => s.item);
  assert.ok(completed.indexOf(name(ID.ga)) >= 0 && completed.indexOf(name(ID.ga)) <= 3, `GA should be the 4th completed item at the latest: ${pathText(snap)}`);
});

test("mode-copy ids: Swiftplay item ids (323075-style) count as the owned catalog item, never sold or re-bought", { skip }, async () => {
  const input = raw([ID.hexoptics, ID.collector, ID.berserkers], 1200, 18 * 60);
  for (const item of input.allPlayers![0].items!) item.itemID = 320000 + Number(item.itemID);
  const snap = await run(input);
  for (const id of [ID.hexoptics, ID.collector, ID.berserkers]) {
    assert.ok(snap.activePlayer.items.some((item) => item.id === id), `${name(id)} is owned under its catalog id`);
    const step = snap.buildPath.steps.find((entry) => entry.itemId === id);
    if (step) assert.equal(step.status, "owned", `${name(id)} path step is owned`);
    assert.ok(!snap.recommendations.some((rec) => rec.itemId === id), `${name(id)} is not recommended again`);
    assert.ok(!snap.recommendations.some((rec) => rec.swapPlan?.sellItemId === id && snap.buildPath.steps.some((entry) => entry.itemId === id)), `${name(id)} is not sold off the path`);
  }
});

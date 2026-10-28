// Counter-builds in the live coach: heavy resist signals always reach a visible card (even with a full inventory), take a
// path slot when one is not started, alternatives come from the researched build, and enemy resist purchases raise an
// alert naming the engine's own counter. Built from a real game: Yone MIDDLE (Swiftplay 16.20) vs Teemo / Cassiopeia /
// Galio / Zaahen / Akali, where heavy armor at 22:04 met a full inventory and no armor-penetration card appeared.
// Uses the real Data Dragon catalog; skipped when it is unreachable.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/counters.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { configureChampionTraits } from "@/lib/champion-traits";
import { configureItemGroups, conflict } from "@/lib/item-groups";
import { deriveAlerts } from "@/lib/live-alerts";
import { findItem, getItemCatalog, itemFitsScaling, itemRecipe, normalizeLiveData, type ItemCatalog, type RawLiveData } from "@/lib/live-game";
import { isMetaItem, registerResearchedBuilds, type MetaBuild, type MetaOption } from "@/lib/meta-builds";
import type { LiveGameSnapshot, LiveRecommendation } from "@/lib/types";

configureItemGroups({ network: false });
configureChampionTraits({ network: false, disk: false });
const catalog: ItemCatalog = await getItemCatalog();
const skip = catalog.fallback || catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;
after(() => registerResearchedBuilds([]));

// The researched Yone MIDDLE build (patch 16.20) as stored in meta-research/yone-middle.json, item names only.
const option = (item: string, when?: MetaOption["when"], condition?: string): MetaOption => ({ item, ...(when ? { when, condition } : {}) });
const YONE_MIDDLE: MetaBuild = {
  champion: "Yone", role: "MIDDLE", patch: "16.20", verified: "2026-10-18", sample: "Emerald+ ranked", origin: "researched",
  researchedAt: "2026-10-17T22:40:42.864Z", researchedOn: catalog.version,
  sources: [{ name: "op.gg", url: "https://op.gg/", site: "op.gg" }],
  slots: [
    { id: "slot1", label: "1st item", kind: "core", options: [option("Immortal Shieldbow"), option("Blade of The Ruined King", "healing", "vs high-health targets")] },
    { id: "boots", label: "Boots", kind: "boots", options: [option("Berserker's Greaves"), option("Mercury's Treads", "situational", "vs magic damage or crowd control"), option("Plated Steelcaps", "situational", "vs physical damage or basic attacks")] },
    { id: "slot2", label: "2nd item", kind: "core", options: [option("Infinity Edge"), option("Immortal Shieldbow", "situational", "after Blade of The Ruined King")] },
    { id: "slot3", label: "3rd item", kind: "core", options: [option("Death's Dance"), option("Infinity Edge", "situational", "after Blade of The Ruined King and Immortal Shieldbow"), option("Mortal Reminder", "healing", "vs heavy healing"), option("Lord Dominik's Regards", "situational", "vs armor")] },
    { id: "slot4", label: "4th item", kind: "flex", options: [option("Death's Dance"), option("Guardian Angel"), option("Mortal Reminder", "healing", "vs heavy healing"), option("Bloodthirster")] },
    { id: "slot5", label: "5th item", kind: "flex", options: [option("Guardian Angel"), option("Death's Dance"), option("Bloodthirster"), option("Wit's End", "situational", "vs magic damage")] },
    { id: "slot6", label: "6th item", kind: "situational", options: [option("Guardian Angel"), option("Phantom Dancer"), option("Bloodthirster"), option("Wit's End", "situational", "vs magic damage")] },
  ],
  cores: [], offMeta: [],
};

type Seat = { champion: string; items?: string[]; level?: number; k?: number; d?: number; position?: string };
const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const named = (names: string[]) => names.map((name) => { const item = findItem(catalog, name)!; return { itemID: item.id, displayName: item.name, price: item.cost, count: 1 }; });
function raw(me: { champion: string; position: string; items?: string[]; level?: number; gold?: number }, enemies: Seat[], time = 1324): RawLiveData {
  const level = me.level ?? 15;
  const seat = (who: string, champion: string, team: string, position: string, items: string[] = [], extra: Partial<Seat> = {}) => ({
    championName: champion, riotId: `${who}#EUW`, summonerName: who, team, position, level: extra.level ?? level, isDead: false, respawnTimer: 0,
    scores: { kills: extra.k ?? 2, deaths: extra.d ?? 3, assists: 0, creepScore: 100 }, items: named(items),
  });
  const allyPositions = POSITIONS.filter((position) => position !== me.position);
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: me.gold ?? 900, level, championStats: { currentHealth: 1500, maxHealth: 2500 } },
    allPlayers: [
      seat("Me", me.champion, "ORDER", me.position, me.items),
      ...["Nasus", "Vi", "Jinx", "Lulu"].map((champion, at) => seat(`A${at}`, champion, "ORDER", allyPositions[at])),
      ...enemies.map((entry, at) => seat(`E${at}`, entry.champion, "CHAOS", entry.position ?? POSITIONS[at], entry.items, entry)),
    ],
    events: { Events: [] },
    gameData: { gameMode: "SWIFTPLAY", gameTime: time, mapName: "Map11", mapNumber: 11 },
  };
}
const run = (input: RawLiveData) => normalizeLiveData(input, { loadBrief: async () => null, soldItemIds: () => [] });
const pathText = (snap: LiveGameSnapshot) => snap.buildPath.steps.map((step) => `${step.item}(${step.status})`).join(" > ");
const cards = (snap: LiveGameSnapshot) => snap.recommendations.map((rec) => `${rec.item}[${rec.action}]`).join(", ");
const armorPen = (rec: LiveRecommendation) => (catalog.byId.get(rec.itemId)?.pen?.armorPercent || 0) > 0;
/** The card can be acted on: a buy, an endorsed swap, or a line naming what to finish or sell first. */
const actionable = (rec: LiveRecommendation) => rec.action === "buy" || Boolean(rec.swapPlan) || /Inventory full/.test(rec.trigger);

// The real game's enemies at 22:04: Galio ~195 armor, Zaahen ~165 (heavy armor), ~80% magic damage.
const ENEMIES_2204: Seat[] = [
  { champion: "Zaahen", position: "TOP", level: 13, k: 1, d: 7, items: ["Trinity Force", "Sundered Sky", "Plated Steelcaps", "Death's Dance"] },
  { champion: "Teemo", position: "JUNGLE", level: 18, k: 7, d: 4, items: ["Liandry's Torment", "Nashor's Tooth", "Sorcerer's Shoes", "Rabadon's Deathcap", "Malignance"] },
  { champion: "Akali", position: "MIDDLE", level: 12, k: 1, d: 11, items: ["Sorcerer's Shoes", "Hextech Gunblade", "Zhonya's Hourglass", "Shadowflame"] },
  { champion: "Cassiopeia", position: "BOTTOM", level: 13, k: 5, d: 7, items: ["Rod of Ages", "Boots of Swiftness", "Rylai's Crystal Scepter", "Rabadon's Deathcap"] },
  { champion: "Galio", position: "UTILITY", level: 15, k: 3, d: 6, items: ["Thornmail", "Heartsteel", "Hollow Radiance", "Plated Steelcaps"] },
];
const FULL_2204 = ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Death's Dance", "Steel Sigil", "B. F. Sword"];
const FULL_2600 = ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Death's Dance", "Guardian Angel", "B. F. Sword"];

for (const research of [true, false]) {
  test(`heavy armor + full inventory (${research ? "researched build" : "no research"}): a fitting armor-pen counter is a top-3 card with an action`, { skip }, async () => {
    registerResearchedBuilds(research ? [YONE_MIDDLE] : []);
    for (const items of [FULL_2204, FULL_2600]) {
      const snap = await run(raw({ champion: "Yone", position: "MIDDLE", items, gold: 900 }, ENEMIES_2204));
      assert.equal(snap.enemyProfile?.armorStack.level, "heavy", "fixture premise: their armor stacks");
      const counter = snap.recommendations.slice(0, 3).find(armorPen);
      assert.ok(counter, `no armor-pen card in the top 3: ${cards(snap)}; path=${pathText(snap)}`);
      const item = catalog.byId.get(counter.itemId)!;
      assert.ok(itemFitsScaling(item, snap.scaling!), `${item.name} does not fit ${snap.scaling}`);
      const owned = snap.activePlayer.items.map((entry) => ({ id: entry.id, count: entry.count }));
      assert.equal(conflict(item.id, owned, [], itemRecipe(catalog)), null, `${item.name} is group-locked`);
      assert.ok(actionable(counter), `${item.name}: ${counter.action}, trigger "${counter.trigger}"`);
      // The path reflects it and recommendations[0] is still the path's next step.
      assert.ok(snap.buildPath.steps.some((step) => step.itemId === item.id && step.status !== "owned"), pathText(snap));
      assert.equal(snap.recommendations[0].itemId, snap.buildPath.steps.find((step) => step.status === "next")?.itemId, pathText(snap));
      assert.equal(snap.counterPicks?.find((pick) => pick.signal === "armorStack")?.itemId, item.id, "the alert's pick is the card");
    }
    // 22:04: Guardian Angel uses the held Steel Sigil + B. F. Sword and frees the slot.
    const at2204 = await run(raw({ champion: "Yone", position: "MIDDLE", items: FULL_2204 }, ENEMIES_2204));
    const card = at2204.recommendations.find(armorPen)!;
    assert.match(card.trigger, /finish Guardian Angel first \(it uses your Steel Sigil and B\. F\. Sword and frees a slot\)/);
    const steps = at2204.buildPath.steps.map((step) => step.item);
    assert.ok(steps.indexOf("Guardian Angel") < steps.indexOf(card.item), `path should finish Guardian Angel first: ${pathText(at2204)}`);
    registerResearchedBuilds([]);
  });
}

test("heavy armor: the counter takes the next path slot when that step is not started (rec0 = path next, with the numbers)", { skip }, async () => {
  registerResearchedBuilds([YONE_MIDDLE]);
  // Nobody fed enough for heavy burst here: a heavy burst counter on the path (Guardian Angel) would keep its place first.
  const calm = ENEMIES_2204.map((seat) => ({ ...seat, k: 2, d: 4, level: 15 }));
  const snap = await run(raw({ champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Death's Dance"], gold: 600 }, calm));
  assert.notEqual(snap.enemyProfile?.burstThreat.level, "heavy", "fixture premise");
  const next = snap.buildPath.steps.find((step) => step.status === "next");
  assert.ok(next && (catalog.byId.get(next.itemId)?.pen?.armorPercent || 0) > 0, `next is not armor pen: ${pathText(snap)}`);
  assert.equal(snap.recommendations[0].itemId, next.itemId);
  assert.match(snap.recommendations[0].counterReason || "", /^Their armor is stacking \(Galio ~\d+ armor, Zaahen ~\d+\)/);
  // A started next step keeps its place: the counter goes right after it.
  const started = await run(raw({ champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Death's Dance", "Steel Sigil"], gold: 600 }, calm));
  const order = started.buildPath.steps.filter((step) => step.status !== "owned").map((step) => step.item);
  assert.equal(order[0], "Guardian Angel", pathText(started));
  assert.ok((catalog.byId.get(findItem(catalog, order[1])!.id)?.pen?.armorPercent || 0) > 0, pathText(started));
  registerResearchedBuilds([]);
});

test("alternatives come from the researched build: no class-default filler or off-build in-progress item", { skip }, async () => {
  registerResearchedBuilds([YONE_MIDDLE]);
  // 26:00 of the real game: the B. F. Sword was read as Yun Tal Wildarrows (a marksman item) and filler cards followed.
  const snap = await run(raw({ champion: "Yone", position: "MIDDLE", items: FULL_2600, gold: 900 }, ENEMIES_2204, 1560));
  const pathIds = new Set(snap.buildPath.steps.map((step) => step.itemId));
  for (const rec of snap.recommendations) {
    const fromResearch = pathIds.has(rec.itemId) || isMetaItem(YONE_MIDDLE, rec.item);
    const counter = /^Deviation/.test(rec.reason) || /Counter-buy/.test(rec.reason);
    assert.ok(fromResearch || counter, `${rec.item} is neither a top-build option nor a counter: ${rec.reason}`);
    assert.doesNotMatch(rec.reason, /Fallback option|Alternative to the top/, rec.item);
  }
  assert.ok(!snap.recommendations.some((rec) => rec.item === "Yun Tal Wildarrows"), cards(snap));
  // Earlier, with room: other top-build options are the alternatives, labelled with their slot.
  const roomy = await run(raw({ champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge"], gold: 900 }, ENEMIES_2204.map((seat) => ({ ...seat, items: [] })), 900));
  const alternatives = roomy.recommendations.filter((rec) => /^Top-build alternative/.test(rec.reason));
  assert.ok(alternatives.length, cards(roomy));
  for (const rec of alternatives) assert.ok(isMetaItem(YONE_MIDDLE, rec.item), rec.item);
  // Without any research the class defaults remain the fallback (the panel is never empty).
  registerResearchedBuilds([]);
  const bare = await run(raw({ champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge"], gold: 900 }, ENEMIES_2204.map((seat) => ({ ...seat, items: [] })), 900));
  assert.ok(bare.recommendations.length >= 2, cards(bare));
});

// ---------------------------------------------------------------------------------------------------------------
// Resist alerts (lib/live-alerts.ts): prev → next poll, the enemy buys resistance against the player's damage type.

const alertsBetween = async (me: Parameters<typeof raw>[0], before: Seat[], afterSeats: Seat[]) => {
  const prev = await run(raw(me, before, 1000));
  const next = await run(raw(me, afterSeats, 1010));
  return { next, alerts: deriveAlerts(prev, next, { itemCost: (id) => catalog.byId.get(id)?.cost }) };
};
const TANK_TEAM = (tankItems: string[]): Seat[] => [
  { champion: "Ornn", position: "TOP", level: 14, items: tankItems }, { champion: "Lux", position: "MIDDLE", level: 14 }, { champion: "Jinx", position: "BOTTOM", level: 14 },
  { champion: "Lee Sin", position: "JUNGLE", level: 14 }, { champion: "Lulu", position: "UTILITY", level: 14 },
];

test("resist alert: a physical player + an enemy finishing an armor item → one alert naming the engine's armor-pen counter", { skip }, async () => {
  registerResearchedBuilds([YONE_MIDDLE]);
  const me = { champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge"], level: 14 };
  const { next, alerts } = await alertsBetween(me, TANK_TEAM(["Plated Steelcaps", "Heartsteel"]), TANK_TEAM(["Plated Steelcaps", "Heartsteel", "Thornmail"]));
  const resist = alerts.filter((alert) => alert.kind === "enemy-resist");
  assert.equal(resist.length, 1, alerts.map((alert) => alert.text).join(" | "));
  const pick = next.counterPicks?.find((entry) => entry.signal === "armorStack");
  assert.ok(pick?.item && (catalog.byId.get(pick.itemId!)?.pen?.armorPercent || 0) > 0, JSON.stringify(next.counterPicks));
  assert.match(resist[0].text, new RegExp(`^Ornn built Thornmail: ~\\d+ armor.*${pick.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(resist[0].call && resist[0].call.includes(pick.item), resist[0].call);
  assert.equal(resist[0].id, `resist:E0#EUW:${findItem(catalog, "Thornmail")!.id}:armorStack`, "stable id: once per enemy item purchase");
  assert.ok(!alerts.some((alert) => alert.kind === "enemy-item" && /Thornmail/.test(alert.text)), "no second generic alert for the same purchase");
  // No MR alert for a physical champion.
  const mr = await alertsBetween(me, TANK_TEAM([]), TANK_TEAM(["Kaenic Rookern"]));
  assert.ok(!mr.alerts.some((alert) => alert.kind === "enemy-resist"), mr.alerts.map((alert) => alert.text).join(" | "));
  registerResearchedBuilds([]);
});

test("resist alert: a magic player + an enemy finishing an MR item → alert with a magic-penetration counter", { skip }, async () => {
  const me = { champion: "Syndra", position: "MIDDLE", items: ["Luden's Echo", "Sorcerer's Shoes"], level: 14 };
  const { next, alerts } = await alertsBetween(me, TANK_TEAM(["Plated Steelcaps"]), TANK_TEAM(["Plated Steelcaps", "Kaenic Rookern"]));
  const resist = alerts.find((alert) => alert.kind === "enemy-resist");
  assert.ok(resist, alerts.map((alert) => alert.text).join(" | "));
  const pick = next.counterPicks?.find((entry) => entry.signal === "mrStack");
  const pen = catalog.byId.get(pick?.itemId ?? 0)?.pen;
  assert.ok(pick?.item && pen && (pen.magicPercent > 0 || pen.magicFlat > 0), JSON.stringify(next.counterPicks));
  assert.match(resist.text, /^Ornn built Kaenic Rookern: ~\d+ MR/);
  assert.ok(resist.text.includes(pick.item) && resist.call?.includes(pick.item), resist.text);
  assert.ok(!next.counterPicks?.some((entry) => entry.signal === "armorStack"), "an AP champion does not watch armor");
});

test("resist alert: a small resist component (Cloth Armor / Null-Magic Mantle) raises no alert", { skip }, async () => {
  const yone = { champion: "Yone", position: "MIDDLE", items: ["Immortal Shieldbow", "Berserker's Greaves"], level: 9 };
  const cloth = await alertsBetween(yone, TANK_TEAM([]).map((seat) => ({ ...seat, level: 9 })), TANK_TEAM(["Cloth Armor"]).map((seat) => ({ ...seat, level: 9 })));
  assert.ok(!cloth.alerts.some((alert) => alert.kind === "enemy-resist"), cloth.alerts.map((alert) => alert.text).join(" | "));
  const syndra = { champion: "Syndra", position: "MIDDLE", items: ["Luden's Echo"], level: 9 };
  const mantle = await alertsBetween(syndra, TANK_TEAM([]).map((seat) => ({ ...seat, level: 9 })), TANK_TEAM(["Null-Magic Mantle"]).map((seat) => ({ ...seat, level: 9 })));
  assert.ok(!mantle.alerts.some((alert) => alert.kind === "enemy-resist"), mantle.alerts.map((alert) => alert.text).join(" | "));
});

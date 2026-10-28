// Exclusive item groups (lib/item-groups.ts): League allows one Last Whisper item, one Spellblade item, one Lifeline item…
// The table tests run offline on the bundled fallback (lib/item-groups-fallback.json); the engine tests use the real
// Data Dragon catalog and skip themselves when it is unreachable.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/item-groups.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { configureChampionTraits } from "@/lib/champion-traits";
import { configureItemGroups, conflict, extractItemGroups, filledGroups, groupsOf, setItemGroupsForTest } from "@/lib/item-groups";
import { findItem, getItemCatalog, itemRecipe, normalizeLiveData, type ItemCatalog, type RawLiveData } from "@/lib/live-game";
import { lockedGroups, resolveBuys } from "@/lib/live-help-build";
import { registerResearchedBuilds } from "@/lib/meta-builds";
import type { LiveGameSnapshot, PlayerBrief } from "@/lib/types";

import { caitlynResearched } from "./fixtures/meta";

configureItemGroups({ network: false });
configureChampionTraits({ network: false, disk: false });
setItemGroupsForTest(null);

const ID = {
  mortalReminder: 3033, lastWhisper: 3035, ldr: 3036, blackCleaver: 3071, terminus: 3302, serylda: 6694, noonquiver: 6670,
  essenceReaver: 3508, trinity: 3078, sheen: 3057, maw: 3156, steraks: 3053, hexdrinker: 3155,
  hexoptics: 2523, berserkers: 3006, ie: 3031, ga: 3026, rfc: 3094, bt: 3072, pd: 3046, ward: 3340,
};
// Hand-written recipes for the offline tests (Data Dragon 16.20): only the edges the component rule needs.
const RECIPE: Record<number, number[]> = { [ID.ldr]: [ID.lastWhisper, ID.noonquiver], [ID.mortalReminder]: [3123, ID.lastWhisper, 1018], [ID.serylda]: [3133, ID.lastWhisper], [ID.blackCleaver]: [3044, 3067, 1037] };
const recipe = (id: number) => RECIPE[id];

test("groups: Mortal Reminder and Lord Dominik's share the Last Whisper group (max 1)", () => {
  const group = groupsOf(ID.ldr).find((entry) => entry.key === "LastWhisper");
  assert.ok(group, "LDR is in LastWhisper");
  assert.equal(group.max, 1);
  for (const id of [ID.mortalReminder, ID.lastWhisper, ID.blackCleaver, ID.terminus, ID.serylda]) assert.ok(group.items.has(id), `${id} in LastWhisper`);
  assert.equal(group.label, "Last Whisper");
  assert.equal(groupsOf(ID.essenceReaver)[0]?.label, "Spellblade");
});

test("conflict: owning Mortal Reminder locks LDR, Serylda's, Black Cleaver, Terminus and the Last Whisper component", () => {
  for (const id of [ID.ldr, ID.serylda, ID.blackCleaver, ID.terminus, ID.lastWhisper]) {
    const found = conflict(id, [ID.mortalReminder, ID.ie], [], recipe);
    assert.ok(found, `${id} should be locked`);
    assert.deepEqual(found.blocking, [ID.mortalReminder]);
    assert.equal(found.owned, true);
  }
  assert.equal(conflict(ID.rfc, [ID.mortalReminder], [], recipe), null);
});

test("conflict: the Last Whisper component counts, but not against items built from it", () => {
  assert.equal(conflict(ID.ldr, [ID.lastWhisper], [], recipe), null, "LDR uses up the owned Last Whisper");
  assert.equal(conflict(ID.mortalReminder, [ID.lastWhisper], [], recipe), null, "Mortal Reminder uses up the owned Last Whisper");
  assert.ok(conflict(ID.blackCleaver, [ID.lastWhisper], [], recipe), "Black Cleaver does not build from Last Whisper");
  assert.ok(conflict(ID.lastWhisper, [ID.lastWhisper], [], recipe), "a second Last Whisper is refused");
});

test("conflict: planned items count (Mortal Reminder earlier in the path rules out a later LDR)", () => {
  const found = conflict(ID.ldr, [ID.ie], [ID.mortalReminder], recipe);
  assert.ok(found);
  assert.equal(found.owned, false);
  assert.deepEqual(found.blocking, [ID.mortalReminder]);
  // Counts as a Map work the same way.
  assert.ok(conflict(ID.serylda, new Map([[ID.ldr, 1]]), [], recipe));
});

test("conflict: Spellblade (Essence Reaver vs Trinity/Sheen) and Lifeline (Maw vs Sterak's)", () => {
  assert.ok(conflict(ID.trinity, [ID.essenceReaver]));
  assert.ok(conflict(ID.sheen, [ID.essenceReaver]));
  assert.ok(conflict(ID.steraks, [ID.maw]));
  assert.ok(conflict(ID.maw, [ID.steraks]));
  assert.equal(conflict(ID.maw, [ID.hexdrinker], [], (id) => id === ID.maw ? [ID.hexdrinker, 3133] : undefined), null, "Maw uses up the owned Hexdrinker");
});

test("filledGroups: owning Mortal Reminder lists the rest of the Last Whisper group as locked", () => {
  const filled = filledGroups([ID.mortalReminder], undefined, recipe).find((group) => group.group === "LastWhisper");
  assert.ok(filled);
  assert.deepEqual(new Set(filled.locked), new Set([ID.lastWhisper, ID.ldr, ID.blackCleaver, ID.terminus, ID.serylda]));
  // Owning only the component: items built from it stay buyable.
  const component = filledGroups([ID.lastWhisper], undefined, recipe).find((group) => group.group === "LastWhisper");
  assert.ok(component && !component.locked.includes(ID.ldr) && component.locked.includes(ID.blackCleaver));
});

test("extractItemGroups: CommunityDragon shape → compact table (named + hashed groups, purchasable filter, ≥2 items)", () => {
  const bin = {
    "Items/ItemGroups/LastWhisper": { mItemGroupID: "LastWhisper", mMaxGroupOwnable: 1, __type: "ItemGroup" },
    "{8b55a7b3}": { mItemGroupID: "{57352a0f}", mMaxGroupOwnable: 1, __type: "ItemGroup" },
    "Items/ItemGroups/Default": { mItemGroupID: "Default", __type: "ItemGroup" },
    "Items/3033": { itemID: 3033, mItemGroups: ["Items/ItemGroups/Default", "Items/ItemGroups/LastWhisper"] },
    "Items/3036": { itemID: 3036, mItemGroups: ["Items/ItemGroups/LastWhisper"] },
    "Items/223036": { itemID: 223036, mItemGroups: ["Items/ItemGroups/LastWhisper"] },
    "Items/3078": { itemID: 3078, mItemGroups: ["{8b55a7b3}"] },
    "Items/3057": { itemID: 3057, mItemGroups: ["{8b55a7b3}"] },
    "Items/9999": { itemID: 9999, mItemGroups: ["{8b55a7b3}"] },
  };
  const table = extractItemGroups(bin, "16.20.1", (id) => id !== 9999);
  assert.deepEqual(table.groups, { LastWhisper: { max: 1, items: [3033, 3036] }, "{8b55a7b3}": { max: 1, items: [3057, 3078] } });
  assert.equal(table.patch, "16.20.1");
});

// --- engine (real Data Dragon catalog) ---
const catalog: ItemCatalog = await getItemCatalog();
// The Caitlyn BOTTOM top build (test fixture; lib/meta-builds.ts holds no curated champion data).
registerResearchedBuilds([caitlynResearched(catalog.version)]);
const skip = catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;
const name = (id: number) => catalog.byId.get(id)?.name || String(id);
const idOf = (item: string) => findItem(catalog, item)!.id;

type Opts = { k?: number; d?: number; dead?: boolean; level?: number };
const player = (who: string, champ: string, team: string, position: string, items: number[] = [], opts: Opts = {}) => ({
  championName: champ, riotId: `${who}#EUW`, summonerName: who, team, position, level: opts.level ?? 16, isDead: Boolean(opts.dead), respawnTimer: opts.dead ? 18 : 0,
  scores: { kills: opts.k ?? 0, deaths: opts.d ?? 0, assists: 0, creepScore: 150 },
  items: items.map((id) => ({ itemID: id, displayName: name(id), price: catalog.byId.get(id)?.cost || 0, count: 1 })),
});
/** Caitlyn vs a balanced team; `enemyItems` per enemy slot (Jhin, Soraka, Zed, Aatrox, Kha'Zix). */
function raw(items: number[], gold: number, time: number, opts: Opts & { enemyItems?: number[][] } = {}): RawLiveData {
  const level = opts.level ?? 14;
  const enemy = (index: number) => opts.enemyItems?.[index] ?? [];
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: gold, level, championStats: { currentHealth: opts.dead ? 0 : 900, maxHealth: 1700 } },
    allPlayers: [
      player("Me", "Caitlyn", "ORDER", "BOTTOM", items, { dead: opts.dead, level }),
      player("A1", "Lux", "ORDER", "UTILITY"), player("A2", "Viktor", "ORDER", "MIDDLE"), player("A3", "Darius", "ORDER", "TOP"), player("A4", "Vi", "ORDER", "JUNGLE"),
      player("E1", "Jhin", "CHAOS", "BOTTOM", enemy(0), { level }), player("E2", "Soraka", "CHAOS", "UTILITY", enemy(1), { level }), player("E3", "Zed", "CHAOS", "MIDDLE", enemy(2), { level }),
      player("E4", "Aatrox", "CHAOS", "TOP", enemy(3), { level }), player("E5", "Kha'Zix", "CHAOS", "JUNGLE", enemy(4), { level }),
    ],
    events: { Events: opts.dead ? [{ EventID: 9, EventName: "ChampionKill", EventTime: time - 4, KillerName: "E3", VictimName: "Me", Assisters: [] }] : [] },
    gameData: { gameMode: "SWIFTPLAY", gameTime: time, mapName: "Map11", mapNumber: 11 },
  };
}
const brief = (extra: Partial<PlayerBrief> = {}): PlayerBrief => ({
  champion: "Caitlyn", gamesOnChampion: 2, winRateOnChampion: 1, usualBuild: ["Hexoptics C44", "Lord Dominik's Regards"], usualBuildGames: 2, pinnedBuild: null, importedBuild: null,
  preferredItems: [], avoidItems: [], matchupNote: null, killerNotes: [], issues: [], focus: null, notes: [], lines: [], ...extra,
});
const run = (input: RawLiveData, extra: Partial<PlayerBrief> | null = {}) => normalizeLiveData(input, { loadBrief: async () => extra === null ? null : brief(extra), soldItemIds: () => [] });
const pathText = (snap: LiveGameSnapshot) => snap.buildPath.steps.map((s) => `${s.item}(${s.status})`).join(" > ");
const everything = (snap: LiveGameSnapshot) => [
  ...snap.recommendations.map((rec) => rec.itemId), ...snap.recommendations.flatMap((rec) => rec.nextStep ? [rec.nextStep.itemId] : []),
  ...(snap.mobilityRecommendation ? [snap.mobilityRecommendation.itemId] : []),
  ...snap.buildPath.steps.filter((s) => s.status === "next" || s.status === "later").map((s) => s.itemId),
  ...(snap.deathMoment?.buyNow || []).map((buy) => buy.itemId),
];
const LOCKED_BY_MR = [ID.ldr, ID.serylda, ID.blackCleaver, ID.terminus, ID.lastWhisper];
// Heavy armor: every enemy wears an armor item, so the engine wants armor penetration.
const ARMORED = () => [["Randuin's Omen"], ["Thornmail"], ["Dead Man's Plate"], ["Randuin's Omen", "Frozen Heart"], ["Dead Man's Plate"]].map((list) => list.map(idOf));
// Heavy healing on top of Soraka: Aatrox and Kha'Zix with life steal / healing items.
const HEALING = () => [["Bloodthirster"], ["Redemption", "Moonstone Renewer"], [], ["Sundered Sky", "Sterak's Gage", "Death's Dance"], ["Ravenous Hydra", "Bloodthirster"]].map((list) => list.map(idOf));

test("engine: owning Mortal Reminder → no Last Whisper item in path, recommendations, nextStep or buyNow (alive and dead)", { skip }, async () => {
  for (const extra of [{}, null] as const) {
    const items = [ID.hexoptics, ID.berserkers, ID.ie, ID.mortalReminder];
    for (const input of [raw(items, 1400, 1100, { enemyItems: ARMORED() }), raw(items, 3400, 1100, { dead: true, enemyItems: ARMORED() }), raw([...items, ID.noonquiver], 2900, 1180, { dead: true, enemyItems: ARMORED() })]) {
      const snap = await run(input, extra);
      const bad = everything(snap).filter((id) => LOCKED_BY_MR.includes(id));
      assert.deepEqual(bad.map(name), [], `locked items suggested: ${pathText(snap)} · recs ${snap.recommendations.map((r) => r.item).join(", ")} · buyNow ${snap.deathMoment?.buyNow.map((b) => b.item).join(", ")}`);
    }
  }
});

test("engine: heavy armor while owning Mortal Reminder → the next buy explains that armor penetration is locked", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers, ID.ie, ID.mortalReminder], 1400, 1100, { enemyItems: ARMORED() }));
  assert.equal(snap.enemyProfile?.armorStack.level, "heavy", "fixture premise: their armor stacks");
  assert.match(snap.recommendations[0]?.reason || "", /locked: you already own Mortal Reminder \(Last Whisper group/, snap.recommendations[0]?.reason);
});

test("engine: dead holding gold with Mortal Reminder never buys the Last Whisper component", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers, ID.ie, ID.mortalReminder], 1450, 1100, { dead: true, enemyItems: ARMORED() }));
  assert.ok(snap.deathMoment, "deathMoment while dead");
  assert.ok(!snap.deathMoment.buyNow.some((buy) => LOCKED_BY_MR.includes(buy.itemId)), snap.deathMoment.buyNow.map((b) => b.item).join(", "));
});

test("engine: pinned LDR while owning Mortal Reminder is skipped with a reason, never 'next'", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers, ID.ie, ID.mortalReminder], 1400, 1100), { pinnedBuild: ["Hexoptics C44", "Infinity Edge", "Lord Dominik's Regards", "Rapid Firecannon"] });
  const step = snap.buildPath.steps.find((s) => s.itemId === ID.ldr);
  assert.equal(snap.buildPath.source, "pinned");
  assert.equal(step?.status, "skipped", pathText(snap));
  assert.match(step?.note || "", /Mortal Reminder/);
  assert.equal(snap.buildPath.steps.find((s) => s.status === "next")?.itemId, ID.rfc, pathText(snap));
  assert.equal(snap.recommendations[0]?.itemId, ID.rfc);
});

test("engine: a pinned build with Mortal Reminder then LDR keeps the first and skips the second", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers], 900, 700), { pinnedBuild: ["Hexoptics C44", "Mortal Reminder", "Lord Dominik's Regards", "Infinity Edge"] });
  const status = new Map(snap.buildPath.steps.map((s) => [s.itemId, s.status]));
  assert.equal(status.get(ID.mortalReminder), "next", pathText(snap));
  assert.equal(status.get(ID.ldr), "skipped", pathText(snap));
});

test("engine: Spellblade — owning Essence Reaver means no Trinity Force / Sheen; a pinned Trinity is skipped", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers, ID.essenceReaver], 1500, 900), { pinnedBuild: ["Hexoptics C44", "Essence Reaver", "Trinity Force", "Infinity Edge"] });
  assert.equal(snap.buildPath.steps.find((s) => s.itemId === ID.trinity)?.status, "skipped", pathText(snap));
  assert.ok(!everything(snap).some((id) => id === ID.trinity || id === ID.sheen), pathText(snap));
});

test("engine: Lifeline — owning Maw of Malmortius means Sterak's Gage is never suggested", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers, ID.maw], 1500, 900), { pinnedBuild: ["Hexoptics C44", "Maw of Malmortius", "Sterak's Gage", "Infinity Edge"] });
  assert.equal(snap.buildPath.steps.find((s) => s.itemId === ID.steraks)?.status, "skipped", pathText(snap));
  assert.ok(!everything(snap).includes(ID.steraks), pathText(snap));
});

test("engine: top build — heavy healing keeps the Last Whisper group for Mortal Reminder (LDR leaves the 3rd/4th slots)", { skip }, async () => {
  const snap = await run(raw([ID.hexoptics, ID.berserkers], 600, 900, { enemyItems: HEALING() }));
  assert.equal(snap.enemyProfile?.healing.level, "heavy", "fixture premise: heavy healing");
  const ids = snap.buildPath.steps.map((s) => s.itemId);
  assert.ok(ids.includes(ID.mortalReminder), `Mortal Reminder missing: ${pathText(snap)}`);
  assert.ok(!ids.includes(ID.ldr), `LDR would lock out Mortal Reminder: ${pathText(snap)}`);
});

test("engine: top build — heavy armor AND heavy healing: one Last Whisper item on the path, never both", { skip }, async () => {
  const both = ARMORED().map((list, index) => [...list, ...HEALING()[index]].slice(0, 6));
  const snap = await run(raw([ID.hexoptics, ID.berserkers], 600, 900, { enemyItems: both }));
  const inGroup = snap.buildPath.steps.filter((s) => s.status !== "skipped" && groupsOf(s.itemId).some((g) => g.key === "LastWhisper"));
  assert.ok(inGroup.length <= 1, `two Last Whisper items on the path: ${pathText(snap)}`);
  // Owning LDR: Mortal Reminder drops out of the late slot even into heavy healing.
  const owned = await run(raw([ID.hexoptics, ID.berserkers, ID.ie, ID.ldr], 600, 1100, { enemyItems: both }));
  assert.ok(!owned.buildPath.steps.some((s) => s.itemId === ID.mortalReminder), pathText(owned));
  assert.ok(!owned.recommendations.some((rec) => rec.itemId === ID.mortalReminder), owned.recommendations.map((r) => r.item).join(", "));
});

test("HELP ME: AI buys locked by an exclusive group are dropped; the prompt's locked list names them", { skip }, () => {
  const snapshot = {
    activePlayer: { items: [ID.hexoptics, ID.berserkers, ID.ie, ID.mortalReminder].map((id) => ({ id, name: name(id), count: 1, price: catalog.byId.get(id)?.cost || 0, description: "" })), currentGold: 1500, champion: "Caitlyn", roles: ["Marksman"], damageProfile: "physical" },
    buildPath: { source: "meta", label: "", steps: [] },
    playerBrief: null,
  } as unknown as LiveGameSnapshot;
  const review = { buyOptions: [
    { item: "Last Whisper", targetItem: "Lord Dominik's Regards", timing: "next-recall" as const, reason: "Armor pen into their tanks." },
    { item: "Serylda's Grudge", targetItem: "Serylda's Grudge", timing: "later-conditional" as const, reason: "Armor pen." },
    { item: "Rapid Firecannon", targetItem: "Rapid Firecannon", timing: "first-item-goal" as const, reason: "Range." },
  ] };
  assert.deepEqual(resolveBuys(review, snapshot, catalog).map((buy) => buy.targetItem), [name(ID.rfc)]);
  const locked = lockedGroups(snapshot, catalog).find((line) => line.startsWith("Last Whisper"));
  assert.ok(locked, lockedGroups(snapshot, catalog).join(" | "));
  assert.match(locked, /^Last Whisper: owns Mortal Reminder → .*Lord Dominik's Regards.* locked$/);
  for (const id of [ID.serylda, ID.blackCleaver, ID.terminus, ID.lastWhisper]) assert.ok(locked.includes(name(id)), `${name(id)} missing from ${locked}`);
  assert.ok(itemRecipe(catalog)(ID.ldr)?.length, "recipes come from Data Dragon");
});

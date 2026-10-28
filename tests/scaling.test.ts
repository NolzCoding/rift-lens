// Champion scaling ↔ item fit, the role fallback for top builds, magic-heavy boots and the "new on this champion" rule.
// Built from a real game: Yone MIDDLE (Swiftplay) vs Varus / Milio / Dr. Mundo / Anivia / Gragas with only a researched
// TOP Yone build; the coach followed the learned BotRK → Steelcaps → GA → Banshee's Veil and offered Oblivion Orb and
// Liandry's Torment. Uses the real Data Dragon catalog; skipped when it is unreachable.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/scaling.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildClass, bundledTraitsTable, championTraits, configureChampionTraits, deriveChampionTraits, isDiver, isEnchanter, isMarksman, isTank, TRAITS_ALGORITHM,
} from "@/lib/champion-traits";
import { configureItemGroups } from "@/lib/item-groups";
import { getItemUsageTip, itemUsageTip } from "@/lib/item-synergy";
import { findItem, getItemCatalog, itemFitsScaling, normalizeLiveData, type ItemCatalog, type RawLiveData } from "@/lib/live-game";
import { registerResearchedBuilds, type MetaBuild, type MetaOption } from "@/lib/meta-builds";
import type { LiveGameSnapshot, PlayerBrief } from "@/lib/types";

configureItemGroups({ network: false });
configureChampionTraits({ network: false, disk: false });
const catalog: ItemCatalog = await getItemCatalog();
const skip = catalog.fallback || catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;
const id = (name: string) => findItem(catalog, name)?.id ?? 0;

// The researched Yone TOP build (patch 16.20) as stored in meta-research/yone-top.json, item names only.
const option = (item: string, when?: MetaOption["when"], condition?: string): MetaOption => ({ item, ...(when ? { when, condition } : {}) });
const YONE_TOP: MetaBuild = {
  champion: "Yone", role: "TOP", patch: "16.20", verified: "2026-10-17", sample: "Emerald+ ranked", origin: "researched",
  researchedAt: "2026-10-17T12:00:00.000Z", researchedOn: catalog.version,
  sources: [{ name: "op.gg", url: "https://op.gg/", site: "op.gg" }, { name: "lolalytics", url: "https://lolalytics.com/", site: "lolalytics" }],
  slots: [
    { id: "slot1", label: "1st item", kind: "core", options: [option("Blade of The Ruined King"), option("Immortal Shieldbow")] },
    { id: "boots", label: "Boots", kind: "boots", options: [option("Berserker's Greaves"), option("Plated Steelcaps", "situational", "vs physical damage"), option("Mercury's Treads", "situational", "vs magic damage and crowd control")] },
    { id: "slot2", label: "2nd item", kind: "core", options: [option("Immortal Shieldbow"), option("Infinity Edge")] },
    { id: "slot3", label: "3rd item", kind: "core", options: [option("Infinity Edge"), option("Lord Dominik's Regards", "situational", "vs tanks"), option("Mortal Reminder", "healing", "vs heavy healing"), option("Death's Dance", "situational", "vs physical burst")] },
    { id: "slot4", label: "4th item", kind: "flex", options: [option("Death's Dance"), option("Guardian Angel", "situational", "when revival is valuable"), option("Infinity Edge", "situational", "if delayed at third item"), option("Wit's End", "situational", "vs magic damage")] },
    { id: "slot5", label: "5th item", kind: "flex", options: [option("Guardian Angel"), option("Death's Dance", "situational", "vs physical burst"), option("Jak'Sho, The Protean", "situational", "vs mixed damage"), option("Bloodthirster", "situational", "for extra sustain")] },
    { id: "slot6", label: "Situational swap", kind: "situational", options: [option("Lord Dominik's Regards"), option("Mortal Reminder", "healing", "vs heavy healing"), option("Wit's End", "situational", "vs magic damage"), option("Mercurial Scimitar", "situational", "vs disabling crowd control")] },
  ],
  cores: [], offMeta: [],
};
after(() => registerResearchedBuilds([]));

type Seat = { champion: string; items?: string[]; level?: number; k?: number; d?: number; position?: string };
const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const named = (names: string[]) => names.map((name) => { const item = findItem(catalog, name)!; return { itemID: item.id, displayName: item.name, price: item.cost, count: 1 }; });
function raw(me: { champion: string; position: string; items?: string[]; level?: number; gold?: number }, enemies: Seat[], time = 900): RawLiveData {
  const level = me.level ?? 11;
  const seat = (who: string, champion: string, team: string, position: string, items: string[] = [], extra: Partial<Seat> = {}) => ({
    championName: champion, riotId: `${who}#EUW`, summonerName: who, team, position, level: extra.level ?? level, isDead: false, respawnTimer: 0,
    scores: { kills: extra.k ?? 1, deaths: extra.d ?? 1, assists: 0, creepScore: 100 }, items: named(items),
  });
  const allyPositions = POSITIONS.filter((position) => position !== me.position);
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: me.gold ?? 400, level, championStats: { currentHealth: 900, maxHealth: 1700 } },
    allPlayers: [
      seat("Me", me.champion, "ORDER", me.position, me.items),
      ...["Garen", "Vi", "Jinx", "Lulu"].map((champion, at) => seat(`A${at}`, champion, "ORDER", allyPositions[at])),
      ...enemies.map((entry, at) => seat(`E${at}`, entry.champion, "CHAOS", entry.position ?? POSITIONS[at], entry.items, entry)),
    ],
    events: { Events: [] },
    gameData: { gameMode: "SWIFTPLAY", gameTime: time, mapName: "Map11", mapNumber: 11 },
  };
}
const brief = (champion: string, extra: Partial<PlayerBrief> = {}): PlayerBrief => ({
  champion, gamesOnChampion: 6, winRateOnChampion: 0.5, usualBuild: null, usualBuildGames: 0, pinnedBuild: null, importedBuild: null,
  preferredItems: [], avoidItems: [], matchupNote: null, killerNotes: [], issues: [], focus: null, notes: [], lines: [], ...extra,
});
const run = (input: RawLiveData, memory: PlayerBrief | null = null) => normalizeLiveData(input, { loadBrief: async () => memory, soldItemIds: () => [] });
const pathText = (snap: LiveGameSnapshot) => snap.buildPath.steps.map((step) => `${step.item}(${step.status})`).join(" > ");
const cardNames = (snap: LiveGameSnapshot) => [...snap.recommendations, ...(snap.mobilityRecommendation ? [snap.mobilityRecommendation] : [])].map((rec) => rec.item);
const unowned = (snap: LiveGameSnapshot) => snap.buildPath.steps.filter((step) => step.status !== "owned").map((step) => step.item);
const completed = (snap: LiveGameSnapshot) => snap.buildPath.steps.filter((step) => !(catalog.byId.get(step.itemId)?.tags || []).includes("Boots")).map((step) => step.item);

// The real game's enemies: ~60% magic damage, healing from Dr. Mundo + Milio.
const REAL_ENEMIES: Seat[] = [
  { champion: "Dr. Mundo", position: "TOP" }, { champion: "Gragas", position: "JUNGLE" }, { champion: "Anivia", position: "MIDDLE" },
  { champion: "Varus", position: "BOTTOM" }, { champion: "Milio", position: "UTILITY" },
];
// Heavy healing (Soraka 2 + Aatrox 2 + Dr. Mundo 2) and two health stackers (Warmog's / Heartsteel, 800+ bonus HP each).
const HEALERS: Seat[] = [{ champion: "Soraka" }, { champion: "Aatrox" }, { champion: "Dr. Mundo" }, { champion: "Jinx" }, { champion: "Lux" }];
const HP_STACKERS: Seat[] = [
  { champion: "Dr. Mundo", items: ["Warmog's Armor", "Heartsteel"] }, { champion: "Sion", items: ["Heartsteel", "Warmog's Armor"] },
  { champion: "Jinx" }, { champion: "Lux" }, { champion: "Ahri" },
];

test("item fit: AP items do not fit AD champions, AD/crit items do not fit AP mages, defensive items fit everyone", { skip }, () => {
  const item = (name: string) => catalog.byId.get(id(name))!;
  for (const name of ["Banshee's Veil", "Oblivion Orb", "Liandry's Torment", "Morellonomicon", "Zhonya's Hourglass"]) assert.equal(itemFitsScaling(item(name), "ad"), false, name);
  for (const name of ["Infinity Edge", "Mortal Reminder", "Executioner's Calling", "Chempunk Chainsword"]) assert.equal(itemFitsScaling(item(name), "ap"), false, name);
  for (const name of ["Guardian Angel", "Thornmail", "Jak'Sho, The Protean", "Mercury's Treads", "Wit's End"]) {
    assert.ok(itemFitsScaling(item(name), "ad") && itemFitsScaling(item(name), "ap") && itemFitsScaling(item(name), "tank"), name);
  }
  assert.equal(itemFitsScaling(item("Infinity Edge"), "tank"), false, "crit does not fit a tank");
  assert.equal(itemFitsScaling(item("Banshee's Veil"), "hybrid"), true);
});

test("role fallback: Yone MIDDLE with only the TOP research follows it (GA not 2nd; Shieldbow and IE before GA)", { skip }, async () => {
  registerResearchedBuilds([YONE_TOP]);
  // Learned while new on Yone: BotRK → Steelcaps → GA → Banshee's Veil (and flagged new: the history must not count).
  const learning = brief("Yone", { gamesOnChampion: 2, usualBuild: ["Blade of The Ruined King", "Plated Steelcaps", "Guardian Angel", "Banshee's Veil"], usualBuildGames: 2, newOnChampion: true, completeGamesOnChampion: 2 });
  const snap = await run(raw({ champion: "Yone", position: "MIDDLE", items: ["Vampiric Scepter", "Dagger"], level: 5, gold: 1100 }, REAL_ENEMIES, 200), learning);
  assert.equal(snap.scaling, "ad");
  assert.equal(snap.buildPath.source, "meta", pathText(snap));
  assert.match(snap.buildPath.label, /Top Yone build \(patch 16\.20, researched for top\)/);
  assert.equal(snap.buildPath.meta?.builtFor, "TOP");
  const items = completed(snap);
  const ga = items.indexOf("Guardian Angel");
  assert.notEqual(items[1], "Guardian Angel", pathText(snap));
  assert.ok(items.indexOf("Immortal Shieldbow") >= 0 && items.indexOf("Infinity Edge") >= 0, pathText(snap));
  assert.ok(ga < 0 || (items.indexOf("Immortal Shieldbow") < ga && items.indexOf("Infinity Edge") < ga), pathText(snap));
  assert.ok(!snap.buildPath.steps.some((step) => step.item === "Banshee's Veil"), `Banshee's Veil on the path: ${pathText(snap)}`);
  assert.ok(!cardNames(snap).some((name) => ["Oblivion Orb", "Morellonomicon", "Banshee's Veil", "Liandry's Torment"].includes(name)), cardNames(snap).join(", "));
  assert.ok(snap.caveats.some((line) => /No mid build is known for Yone yet/.test(line)));
  registerResearchedBuilds([]);
});

test("heavy healing: an AD fighter gets Executioner's / Chempunk / Mortal Reminder, never Oblivion Orb or Morellonomicon", { skip }, async () => {
  for (const champion of ["Darius", "Yone"]) {
    const snap = await run(raw({ champion, position: "TOP", items: ["Long Sword"], level: 9 }, HEALERS));
    assert.equal(snap.enemyProfile?.healing.level, "heavy");
    const names = [...cardNames(snap), ...unowned(snap)];
    assert.ok(names.some((name) => ["Executioner's Calling", "Chempunk Chainsword", "Mortal Reminder"].includes(name)), `${champion}: no AD anti-heal in ${names.join(", ")}`);
    assert.ok(!names.some((name) => name === "Oblivion Orb" || name === "Morellonomicon"), `${champion}: AP anti-heal in ${names.join(", ")}`);
    const card = snap.recommendations.find((rec) => /healing/i.test(rec.reason) && /Deviation/.test(rec.reason));
    if (card) assert.ok(["Chempunk Chainsword", "Mortal Reminder"].includes(card.item), `${champion}: anti-heal card ${card.item}`);
  }
});

test("HP stacking: an AD champion never gets Liandry's Torment; an AP mage still gets Oblivion Orb / Morellonomicon / Liandry's", { skip }, async () => {
  const darius = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 13 }, HP_STACKERS));
  assert.equal(darius.enemyProfile?.hpStack.level, "heavy");
  assert.ok(![...cardNames(darius), ...unowned(darius)].includes("Liandry's Torment"), cardNames(darius).join(", "));
  assert.ok(cardNames(darius).some((name) => ["Black Cleaver", "Blade of The Ruined King", "Serylda's Grudge"].includes(name)), cardNames(darius).join(", "));

  const syndraHp = await run(raw({ champion: "Syndra", position: "MIDDLE", items: ["Amplifying Tome"], level: 13 }, HP_STACKERS));
  assert.equal(syndraHp.scaling, "ap");
  assert.ok(cardNames(syndraHp).includes("Liandry's Torment"), cardNames(syndraHp).join(", "));
  const syndraHeal = await run(raw({ champion: "Syndra", position: "MIDDLE", items: ["Amplifying Tome"], level: 9 }, HEALERS));
  assert.ok(cardNames(syndraHeal).some((name) => name === "Oblivion Orb" || name === "Morellonomicon"), cardNames(syndraHeal).join(", "));
  assert.ok(!cardNames(syndraHeal).some((name) => ["Mortal Reminder", "Chempunk Chainsword", "Executioner's Calling"].includes(name)), cardNames(syndraHeal).join(", "));
});

test("history fit: Banshee's Veil learned on an AD champion is dropped from the path (owned stays owned, pinned stays)", { skip }, async () => {
  const usual = ["Sundered Sky", "Banshee's Veil", "Sterak's Gage"];
  const learned = brief("Darius", { usualBuild: usual, usualBuildGames: 6 });
  const snap = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 9 }, HEALERS), learned);
  assert.equal(snap.buildPath.source, "history", pathText(snap));
  assert.ok(!snap.buildPath.steps.some((step) => step.item === "Banshee's Veil"), pathText(snap));
  assert.ok(unowned(snap).includes("Sundered Sky") && unowned(snap).includes("Sterak's Gage"), pathText(snap));
  const owning = await run(raw({ champion: "Darius", position: "TOP", items: ["Sundered Sky", "Banshee's Veil"], level: 13 }, HEALERS), learned);
  assert.ok(owning.buildPath.steps.some((step) => step.item === "Banshee's Veil" && step.status === "owned"), pathText(owning));
  assert.ok(!owning.recommendations.some((rec) => rec.item === "Banshee's Veil"));
  const pinned = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 9 }, HEALERS), brief("Darius", { pinnedBuild: usual }));
  assert.ok(pinned.buildPath.steps.some((step) => step.item === "Banshee's Veil" && step.status !== "owned"), `pinned item dropped: ${pathText(pinned)}`);
});

test("new on a champion: under 5 games the learned path is ignored; from 5 games it is the build source", { skip }, async () => {
  const usual = ["Sundered Sky", "Sterak's Gage", "Death's Dance"];
  const fresh = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 9 }, HEALERS), brief("Darius", { usualBuild: usual, usualBuildGames: 2, newOnChampion: true, completeGamesOnChampion: 2 }));
  assert.notEqual(fresh.buildPath.source, "history", pathText(fresh));
  const habit = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 9 }, HEALERS), brief("Darius", { usualBuild: usual, usualBuildGames: 5, newOnChampion: false, completeGamesOnChampion: 5 }));
  assert.equal(habit.buildPath.source, "history", pathText(habit));
  assert.deepEqual(unowned(habit).filter((name) => usual.includes(name)), usual);
});

test("boots: ~60% magic damage names Mercury's Treads as the alternative; ~70% makes it the pick", { skip }, async () => {
  // Two physical (Zed, Jinx) and three magic (Lux, Syndra, Brand) champions, no items: physical share 0.4.
  const some = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 6 }, [{ champion: "Zed" }, { champion: "Jinx" }, { champion: "Lux" }, { champion: "Syndra" }, { champion: "Brand" }], 400));
  assert.equal(some.enemyProfile?.physicalShare.share, 0.4);
  assert.notEqual(some.mobilityRecommendation?.item, "Mercury's Treads");
  assert.match(some.mobilityRecommendation?.trigger || "", /Alternative: Mercury's Treads: ~60% of enemy damage looks magic \(estimated\)/);
  // One physical, four magic: 0.2 → Mercury's is the boots step and the card, with the numbers.
  const heavy = await run(raw({ champion: "Darius", position: "TOP", items: ["Long Sword"], level: 6 }, [{ champion: "Zed" }, { champion: "Ahri" }, { champion: "Lux" }, { champion: "Syndra" }, { champion: "Brand" }], 400));
  assert.ok((heavy.enemyProfile?.physicalShare.share ?? 1) <= 0.3);
  assert.equal(heavy.mobilityRecommendation?.item, "Mercury's Treads");
  assert.ok(heavy.buildPath.steps.some((step) => step.item === "Mercury's Treads"), pathText(heavy));
  assert.match(heavy.mobilityRecommendation?.reason || "", /looks magic/);
});

// Regression (real capture 2026-10-17 22:39, Yone dead at 16:58 with 6329g holding Shieldbow / Berserker's / IE / Long
// Sword): the shopping list bought Death's Dance (using the Long Sword) and then Guardian Angel, but Guardian Angel's goal
// still credited the Long Sword (costNow 2850 while spendNow was 3200). Each goal now credits only components unclaimed
// by the purchases planned before it.
test("death goals: a component spent on the first goal is not credited to the next one (costNow ≥ spendNow)", { skip }, async () => {
  registerResearchedBuilds([YONE_TOP]);
  const input = raw({ champion: "Yone", position: "TOP", items: ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Long Sword"], level: 15, gold: 6329 }, REAL_ENEMIES, 1018);
  const me = input.allPlayers![0];
  me.isDead = true;
  me.respawnTimer = 30;
  input.activePlayer!.championStats = { currentHealth: 0, maxHealth: 2200 };
  input.events = { Events: [{ EventID: 1, EventName: "ChampionKill", EventTime: 1010, KillerName: "E0", VictimName: "Me", Assisters: [] }] };
  const snap = await run(input);
  const moment = snap.deathMoment;
  assert.ok(moment, "dead: a death moment");
  assert.ok(moment.goals.length >= 2, `goals: ${moment.goals.map((goal) => goal.item).join(", ")}`);
  for (const goal of moment.goals) {
    assert.ok(goal.costNow <= goal.cost && goal.spendNow <= goal.costNow && goal.remainingAfter === Math.max(0, goal.costNow - goal.spendNow),
      `goal ${goal.item}: ${JSON.stringify(goal)}; buyNow=${moment.buyNow.map((buy) => `${buy.item} ${buy.cost}`).join(", ")}`);
  }
  registerResearchedBuilds([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Champion traits (lib/champion-traits.ts) come from Riot data, never from champion names. These read the bundled table
// (generated from CommunityDragon by scripts/build-champion-traits.ts) and run offline.

test("traits: the bundled table is current with the derivation rules and covers every champion", () => {
  const table = bundledTraitsTable();
  assert.ok(table, "lib/champion-traits-fallback.json loads");
  assert.equal(table.algorithm, TRAITS_ALGORITHM, "rules changed: regenerate with scripts/build-champion-traits.ts");
  assert.ok(Object.keys(table.champions).length >= 170, `${Object.keys(table.champions).length} champions`);
});

test("traits: real champions get the expected class and signals from their data", () => {
  const caitlyn = championTraits("Caitlyn");
  assert.equal(buildClass(caitlyn), "marksman-crit");
  assert.ok(caitlyn.critScaling && caitlyn.poke >= 1 && caitlyn.damage === "physical");
  const yone = championTraits("Yone");
  assert.equal(buildClass(yone), "fighter-crit");
  assert.ok(isDiver(yone) && yone.critScaling && yone.damage === "physical");
  const soraka = championTraits("Soraka");
  assert.ok(isEnchanter(soraka) && soraka.healing === 2);
  const malzahar = championTraits("Malzahar");
  assert.ok(malzahar.hardCc === 2 && malzahar.ccKinds.includes("suppress"));
  const mundo = championTraits("Dr. Mundo");
  assert.ok(isTank(mundo) && mundo.healing === 2 && mundo.damage === "mixed");
  assert.equal(championTraits("DrMundo"), mundo, "Data Dragon id and display name find the same champion");
  assert.equal(championTraits("Wukong"), championTraits("MonkeyKing"));
  assert.ok(isMarksman(championTraits("Yunara")), "a 2025 release is covered by the same rules");
  assert.ok(championTraits("Ambessa").hardCc === 2 && isDiver(championTraits("Ambessa")));
});

test("traits: the derivation reads Riot's markup and ranges, and an unknown champion falls back to Data Dragon tags", () => {
  const raw = {
    id: 9999, name: "Testchamp", alias: "Testchamp", roles: ["mage", "support"], tacticalInfo: { damageType: "kMagic", attackType: "ranged" },
    playstyleInfo: { damage: 3, durability: 1, crowdControl: 3, mobility: 1, utility: 2 },
    passive: { description: "Testchamp's abilities heal her for a portion of damage dealt." },
    spells: [
      { spellKey: "q", description: "", dynamicDescription: "Deals <magicDamage>80 magic damage</magicDamage> and <status>Stuns</status>.", range: [1300, 1300] },
      { spellKey: "w", description: "", dynamicDescription: "Heals allies for <healing>50</healing> plus <healing>10%</healing>.", range: [700] },
      { spellKey: "e", description: "", dynamicDescription: "Deals <magicDamage>60 magic damage</magicDamage> and <status>Roots</status>.", range: [1150] },
      { spellKey: "r", description: "", dynamicDescription: "<status>Suppresses</status> the target, dealing <magicDamage>200 magic damage</magicDamage>.", range: [3500] },
    ],
  };
  const derived = deriveChampionTraits(raw);
  assert.equal(derived.hardCc, 2, "suppression");
  assert.ok(derived.healing >= 1 && derived.allyUtility);
  assert.equal(derived.poke, 2, "two long-range damaging abilities plus an artillery ultimate");
  const fresh = championTraits("Brand New Champion", { id: "BrandNew", key: "1000", name: "Brand New Champion", tags: ["Marksman"], info: { attack: 8, defense: 2, magic: 2, difficulty: 5 } });
  assert.equal(fresh.source, "datadragon");
  assert.ok(isMarksman(fresh) && fresh.damage === "physical");
});

test("item tips come from the item's own text and are the same for every champion", () => {
  assert.match(itemUsageTip("<mainText><stats>65 Ability Power</stats><br><active>Time Stop</active><br>Enter Stasis for 2.5 seconds.</mainText>"), /Stasis/);
  assert.match(itemUsageTip("<passive>Spellblade</passive><br>After using an Ability, your next Attack deals bonus damage."), /Spellblade/);
  assert.equal(itemUsageTip("<stats>40 Attack Damage</stats>"), "", "stats only: nothing to use");
  assert.equal(itemUsageTip("<active>Drink</active> Restores health.", ["Consumable"]), "");
  assert.equal(getItemUsageTip("Caitlyn", "Zhonya's Hourglass"), getItemUsageTip("Malphite", "Zhonya's Hourglass"));
  assert.match(getItemUsageTip("anyone", "Zhonya's Hourglass"), /Stasis/);
});

test("no champion names drive behaviour: the engine sources hold no champion-name string literals", () => {
  const names = new Set(Object.values(bundledTraitsTable()!.champions).flatMap((entry) => [entry.id, entry.name]).map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const file of ["lib/live-game.ts", "lib/enemy-stats.ts", "lib/item-synergy.ts", "lib/meta-builds.ts", "lib/champion-traits.ts", "lib/champion-data.ts"]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const literals = [...source.matchAll(/"([^"\n]{2,30})"/g)].map((match) => match[1]);
    const hits = literals.filter((literal) => names.has(literal.toLowerCase().replace(/[^a-z0-9]/g, "")));
    assert.deepEqual(hits, [], `${file} names champions: ${hits.join(", ")}`);
  }
});

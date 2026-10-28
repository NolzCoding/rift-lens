// Estimated enemy stats + team threat profile (lib/enemy-stats.ts).
// The formula and parsing tests use small synthetic payloads and run offline; the "real catalog" tests load the
// current Data Dragon patch and skip themselves when it is unreachable.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/enemy-stats.test.ts
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  buildEnemyStatsData, counterSignalFor, enemyThreatProfile, estimateStats, loadEnemyStatsData, parseDescriptionStats, parseItemStats, statAtLevel,
  type EnemyInput, type EnemyStatsData,
} from "@/lib/enemy-stats";
import { configureChampionTraits } from "@/lib/champion-traits";
import { configureItemGroups } from "@/lib/item-groups";
import { getItemCatalog, normalizeLiveData, type RawLiveData } from "@/lib/live-game";
import { registerResearchedBuilds } from "@/lib/meta-builds";

import { caitlynResearched } from "./fixtures/meta";

// Exclusive item groups: the disk cache or the bundled table, never a background CommunityDragon download from a test.
configureItemGroups({ network: false });
// Champion traits (healing / hard CC / poke / burst weights) from the bundled table only, so results are reproducible.
configureChampionTraits({ network: false, disk: false });

// ---------------------------------------------------------------------------------------------------------------
// Offline: formula, parsing, AD-growth fallback

const riot = (base: number, growth: number, n: number) => base + growth * (n - 1) * (0.7025 + 0.0175 * (n - 1));

const SYNTHETIC_CHAMPIONS = {
  Caitlyn: { id: "Caitlyn", name: "Caitlyn", tags: ["Marksman"], info: { attack: 8, defense: 2, magic: 2, difficulty: 6 }, stats: { hp: 580, hpperlevel: 107, armor: 27, armorperlevel: 4.7, spellblock: 30, spellblockperlevel: 1.3, attackdamage: 62, attackdamageperlevel: 0, attackspeed: 0.681, attackspeedperlevel: 4, attackrange: 650 } },
  Ornn: { id: "Ornn", name: "Ornn", tags: ["Tank"], info: { attack: 5, defense: 9, magic: 3, difficulty: 5 }, stats: { hp: 660, hpperlevel: 109, armor: 33, armorperlevel: 5.2, spellblock: 32, spellblockperlevel: 2.05, attackdamage: 69, attackdamageperlevel: 0, attackspeed: 0.625, attackspeedperlevel: 2, attackrange: 175 } },
};
const OLD_CHAMPIONS = { Caitlyn: { id: "Caitlyn", stats: { attackdamageperlevel: 3.8 } }, Ornn: { id: "Ornn", stats: { attackdamageperlevel: 3.5 } } };
const SYNTHETIC_ITEMS = {
  3075: { name: "Thornmail", gold: { total: 2450 }, stats: { FlatHPPoolMod: 150, FlatArmorMod: 75 }, description: "<mainText><stats><attention>150</attention> Health<br><attention>75</attention> Armor</stats></mainText>" },
  3142: { name: "Youmuu's Ghostblade", gold: { total: 2800 }, stats: { FlatPhysicalDamageMod: 55 }, description: "<mainText><stats><attention>55</attention> Attack Damage<br><attention>18</attention> Lethality<br><attention>4%</attention> Move Speed</stats></mainText>" },
  3036: { name: "Lord Dominik's Regards", gold: { total: 3100 }, stats: { FlatPhysicalDamageMod: 35, FlatCritChanceMod: 0.25 }, description: "<stats><attention>35</attention> Attack Damage<br><attention>35%</attention> Armor Penetration<br><attention>25%</attention> Critical Strike Chance</stats>" },
  3020: { name: "Sorcerer's Shoes", gold: { total: 1100 }, stats: {}, description: "<stats><attention>12</attention> Magic Penetration</stats>" },
  3135: { name: "Void Staff", gold: { total: 3000 }, stats: { FlatMagicDamageMod: 95 }, description: "<stats><attention>95</attention> Ability Power<br><attention>40%</attention> Magic Penetration</stats>" },
};

test("growth formula: level 1 = base, level 18 = base + 17 × growth, mid levels follow Riot's curve", () => {
  assert.equal(statAtLevel(580, 107, 1), 580);
  assert.equal(Math.round(statAtLevel(580, 107, 18)), 580 + 107 * 17);
  assert.ok(Math.abs(statAtLevel(580, 107, 9) - riot(580, 107, 9)) < 1e-9);
  assert.equal(statAtLevel(580, 107, 25), statAtLevel(580, 107, 18), "levels clamp to 18");
});

test("description <stats> parsing picks up lethality, % armor pen and flat vs % magic pen", () => {
  assert.deepEqual(parseDescriptionStats(SYNTHETIC_ITEMS[3142].description), { attackDamage: 55, lethality: 18 });
  const ldr = parseItemStats(3036, SYNTHETIC_ITEMS[3036]);
  assert.equal(ldr.armorPenPercent, 35);
  assert.equal(ldr.critChance, 25);
  assert.equal(ldr.source, "both");
  assert.equal(parseItemStats(3020, SYNTHETIC_ITEMS[3020]).magicPenFlat, 12);
  assert.equal(parseItemStats(3020, SYNTHETIC_ITEMS[3020]).source, "description");
  assert.equal(parseItemStats(3135, SYNTHETIC_ITEMS[3135]).magicPenPercent, 40);
});

test("AD growth: borrowed from the older patch when the current champion.json reports 0 for everyone", () => {
  const data = buildEnemyStatsData("16.20.1", SYNTHETIC_CHAMPIONS, SYNTHETIC_ITEMS, { version: "16.4.1", data: OLD_CHAMPIONS });
  assert.equal(data.adGrowthSource, "16.4.1");
  const caitlyn18 = estimateStats("Caitlyn", 18, [], data);
  assert.equal(caitlyn18.attackDamage, Math.round(62 + 3.8 * 17));
  assert.equal(caitlyn18.hp, 580 + 107 * 17);
  assert.equal(caitlyn18.armor, Math.round(27 + 4.7 * 17));
  assert.equal(caitlyn18.attackSpeed, Math.round(0.681 * (1 + 4 * 17 / 100) * 100) / 100);
  const ornn = estimateStats("Ornn", 10, [{ id: 3075 }], data);
  assert.equal(ornn.armor, Math.round(riot(33, 5.2, 10) + 75));
  assert.equal(ornn.bonusArmor, 75);
  assert.equal(ornn.bonusHp, 150);
  assert.equal(estimateStats("Nobody", 5, [], data).championKnown, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Real catalog (current Data Dragon patch); skipped offline

type RawChampionStats = Record<string, number>;
let real: Promise<{ data: EnemyStatsData; raw: Record<string, { stats: RawChampionStats }>; items: Record<string, { stats?: RawChampionStats }> } | null> | null = null;
function realData() {
  real ||= (async () => {
    try {
      const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json", { signal: AbortSignal.timeout(6000) })).json() as string[];
      const version = versions[0];
      const data = await loadEnemyStatsData(version);
      if (!data) return null;
      const raw = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, { signal: AbortSignal.timeout(6000) })).json() as { data: Record<string, { stats: RawChampionStats }> };
      const items = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`, { signal: AbortSignal.timeout(6000) })).json() as { data: Record<string, { stats?: RawChampionStats }> };
      return { data, raw: raw.data, items: items.data };
    } catch {
      return null;
    }
  })();
  return real;
}
async function needReal(t: TestContext) {
  const loaded = await realData();
  if (!loaded) t.skip("Data Dragon unreachable");
  return loaded;
}

const items = (...names: string[]) => names.map((name) => ({ name }));

test("real catalog: level 1 and 18 HP/armor/MR follow Riot's formula for Caitlyn, Ornn and Soraka", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  for (const champion of ["Caitlyn", "Ornn", "Soraka"]) {
    const stats: RawChampionStats = loaded.raw[champion].stats;
    for (const level of [1, 9, 18]) {
      const estimate = estimateStats(champion, level, [], loaded.data);
      assert.equal(estimate.hp, Math.round(riot(stats.hp, stats.hpperlevel, level)), `${champion} hp @${level}`);
      assert.equal(estimate.armor, Math.round(riot(stats.armor, stats.armorperlevel, level)), `${champion} armor @${level}`);
      assert.equal(estimate.magicResist, Math.round(riot(stats.spellblock, stats.spellblockperlevel, level)), `${champion} MR @${level}`);
      assert.ok(estimate.championKnown);
    }
    // AD grows with level even though recent Data Dragon champion.json lists 0 growth.
    assert.ok(estimateStats(champion, 18, [], loaded.data).attackDamage > estimateStats(champion, 1, [], loaded.data).attackDamage, `${champion} AD grows`);
  }
});

test("real catalog: Thornmail and Sunfire Aegis add their armor and health", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  const bare = estimateStats("Ornn", 12, [], loaded.data);
  const thorn = estimateStats("Ornn", 12, items("Thornmail"), loaded.data);
  const both = estimateStats("Ornn", 12, items("Thornmail", "Sunfire Aegis"), loaded.data);
  const thornArmor = loaded.items["3075"].stats!.FlatArmorMod;
  const sunfireArmor = loaded.items["3068"].stats!.FlatArmorMod;
  assert.ok(thornArmor > 0 && sunfireArmor > 0);
  assert.equal(thorn.armor - bare.armor, thornArmor);
  assert.equal(both.armor - bare.armor, thornArmor + sunfireArmor);
  assert.equal(both.bonusHp, loaded.items["3075"].stats!.FlatHPPoolMod + loaded.items["3068"].stats!.FlatHPPoolMod);
  // Lethality only exists in the description block.
  assert.ok(estimateStats("Zed", 10, items("Youmuu's Ghostblade"), loaded.data).lethality > 0);
});

const enemy = (champion: string, level: number, names: string[] = [], extra: Partial<EnemyInput> = {}): EnemyInput => ({ champion, level, items: items(...names), ...extra });

test("real catalog: a three-tank comp with armor items is heavy armorStack", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  const profile = enemyThreatProfile([
    enemy("Ornn", 14, ["Thornmail", "Sunfire Aegis", "Plated Steelcaps"]),
    enemy("Sejuani", 13, ["Randuin's Omen", "Plated Steelcaps"]),
    enemy("Malphite", 13, ["Frozen Heart", "Sunfire Aegis"]),
    enemy("Ahri", 13, ["Luden's Echo"]),
    enemy("Jinx", 13, ["Infinity Edge"]),
  ], loaded.data);
  assert.equal(profile.armorStack.level, "heavy");
  assert.ok(profile.armorStack.high >= 3);
  assert.match(profile.armorStack.reasons[0], /^Ornn ~\d+ armor/);
  assert.ok(profile.armorStack.reasons.every((reason) => reason.split(/\s+/).length <= 12));
  // A squishy comp at the same levels with no armor items is not stacking.
  const squishy = enemyThreatProfile([enemy("Ahri", 13), enemy("Jinx", 13), enemy("Lux", 13)], loaded.data);
  assert.equal(squishy.armorStack.level, "none");
});

test("real catalog: Soraka + Aatrox with Sundered Sky is heavy healing", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  const profile = enemyThreatProfile([enemy("Soraka", 10), enemy("Aatrox", 11, ["Sundered Sky"]), enemy("Ahri", 10)], loaded.data);
  assert.equal(profile.healing.level, "heavy");
  assert.equal(profile.healing.reasons[0], "Aatrox (Sundered Sky) + Soraka");
  assert.equal(profile.healing.counter, "anti-heal");
  // One lone Bloodthirster is not a healing comp.
  assert.equal(enemyThreatProfile([enemy("Jinx", 12, ["Bloodthirster"]), enemy("Ahri", 12)], loaded.data).healing.level, "none");
});

// Poke weights come from the champions' damaging ability cast ranges (lib/champion-traits.ts). Lux / Ezreal / Smolder have
// several 1100+ range damaging basic abilities (weight 2 each); Jayce's data ranges are his melee form's, so the old
// hand-written "Xerath + Ziggs + Jayce" trio is no longer the example.
test("real catalog: Malzahar is hard CC, Lux + Ezreal + Smolder is heavy poke, AD comps lean physical", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  const mal = enemyThreatProfile([enemy("Malzahar", 9), enemy("Jinx", 9)], loaded.data);
  assert.notEqual(mal.hardCc.level, "none");
  assert.match(mal.hardCc.reasons[0], /Malzahar/);
  assert.equal(enemyThreatProfile([enemy("Malzahar", 9), enemy("Warwick", 9)], loaded.data).hardCc.level, "heavy");
  const poke = enemyThreatProfile([enemy("Lux", 9), enemy("Ezreal", 9), enemy("Smolder", 9)], loaded.data);
  assert.equal(poke.poke.level, "heavy");
  // Xerath and Ziggs still count as poke, just not heavy on their own.
  assert.equal(enemyThreatProfile([enemy("Xerath", 9), enemy("Ziggs", 9)], loaded.data).poke.level, "some");
  const ad = enemyThreatProfile([enemy("Zed", 12, ["Youmuu's Ghostblade"]), enemy("Jinx", 12, ["Infinity Edge"]), enemy("Darius", 12, ["Black Cleaver"]), enemy("Lux", 12)], loaded.data);
  assert.equal(ad.physicalShare.lean, "physical");
  const ap = enemyThreatProfile([enemy("Ahri", 12, ["Luden's Echo"]), enemy("Syndra", 12, ["Void Staff"]), enemy("Leona", 12)], loaded.data);
  assert.equal(ap.physicalShare.lean, "magic");
});

test("real catalog: a fed Zed with lethality and a level lead is a heavy burst threat", async (t) => {
  const loaded = await needReal(t);
  if (!loaded) return;
  const fed = enemyThreatProfile([enemy("Zed", 12, ["Youmuu's Ghostblade", "Edge of Night"], { kills: 8, deaths: 1 }), enemy("Jinx", 10)], loaded.data, { referenceLevel: 10 });
  assert.equal(fed.burstThreat.level, "heavy");
  assert.match(fed.burstThreat.reasons[0], /^Zed, 8\/1, level 12 vs your 10/);
  const quiet = enemyThreatProfile([enemy("Zed", 6, [], { kills: 0, deaths: 2 })], loaded.data, { referenceLevel: 6 });
  assert.equal(quiet.burstThreat.level, "none");
});

test("meta conditions map to signals: healing / heavy-poke by condition, situational options by item or wording", () => {
  assert.equal(counterSignalFor("Mortal Reminder", "healing"), "healing");
  assert.equal(counterSignalFor("Gluttonous Greaves", "heavy-poke"), "poke");
  assert.equal(counterSignalFor("Lord Dominik's Regards", "situational", "vs tanks"), "armorStack");
  assert.equal(counterSignalFor("Mercurial Scimitar", "situational"), "hardCc");
  assert.equal(counterSignalFor("Some New Item", "situational", "vs heavy CC"), "hardCc");
  assert.equal(counterSignalFor("Some New Item", "situational", "late game"), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Engine: the live snapshot uses the profile (Caitlyn, top build, no player memory)

registerResearchedBuilds([caitlynResearched((await getItemCatalog()).version)]);

const ITEM = { hexoptics: 2523, berserkers: 3006, ie: 3031, rfc: 3094, ldr: 3036, ga: 3026, mr: 3033, thornmail: 3075, sunfire: 3068, steelcaps: 3047, randuin: 3143, frozenHeart: 3110, sundered: 6610, luden: 6655 };
type Seat = { champion: string; items?: number[]; level?: number; k?: number; d?: number };
async function snapshot(mine: number[], enemies: Seat[], opts: { level?: number; gold?: number } = {}) {
  const catalog = await getItemCatalog();
  const named = (ids: number[]) => ids.map((id) => ({ itemID: id, displayName: catalog.byId.get(id)?.name || String(id), price: catalog.byId.get(id)?.cost || 0, count: 1 }));
  const level = opts.level ?? 13;
  const seat = (who: string, champion: string, team: string, position: string, items: number[] = [], extra: Partial<Seat> = {}) => ({
    championName: champion, riotId: `${who}#EUW`, summonerName: who, team, position, level: extra.level ?? level, isDead: false, respawnTimer: 0,
    scores: { kills: extra.k ?? 1, deaths: extra.d ?? 1, assists: 0, creepScore: 120 }, items: named(items),
  });
  const positions = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
  const raw: RawLiveData = {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: opts.gold ?? 300, level, championStats: { currentHealth: 900, maxHealth: 1700 } },
    allPlayers: [
      seat("Me", "Caitlyn", "ORDER", "BOTTOM", mine),
      seat("A1", "Lux", "ORDER", "UTILITY"), seat("A2", "Ahri", "ORDER", "MIDDLE"), seat("A3", "Garen", "ORDER", "TOP"), seat("A4", "Vi", "ORDER", "JUNGLE"),
      ...enemies.map((entry, at) => seat(`E${at}`, entry.champion, "CHAOS", positions[at], entry.items, entry)),
    ],
    events: { Events: [] },
    gameData: { gameMode: "CLASSIC", gameTime: 1500, mapName: "Map11", mapNumber: 11 },
  };
  return { catalog, snap: await normalizeLiveData(raw, { loadBrief: async () => null, soldItemIds: () => [] }) };
}
const nextStep = (snap: Awaited<ReturnType<typeof snapshot>>["snap"]) => snap.buildPath.steps.find((step) => step.status === "next")?.item;
// No armor/HP stacking, no healing, and not a poke comp: with poke derived from ability ranges, Jinx + Lux + Ezreal is heavy
// poke (Bloodthirster would then win the late slot), so the fifth seat is Akali.
const SQUISHY: Seat[] = [{ champion: "Jinx" }, { champion: "Lux" }, { champion: "Ahri" }, { champion: "Zed" }, { champion: "Akali" }];

test("engine: heavy armor stacking makes Lord Dominik's Regards the 3rd item (with the numbers), otherwise Rapid Firecannon", async (t) => {
  const { catalog, snap } = await snapshot([ITEM.hexoptics, ITEM.berserkers, ITEM.ie], [
    { champion: "Ornn", items: [ITEM.thornmail, ITEM.sunfire, ITEM.steelcaps] }, { champion: "Sejuani", items: [ITEM.randuin, ITEM.steelcaps] },
    { champion: "Malphite", items: [ITEM.thornmail, ITEM.frozenHeart] }, { champion: "Jinx" }, { champion: "Lux" },
  ]);
  if (catalog.fallback) return t.skip("Data Dragon unreachable");
  assert.ok(snap.enemyProfile, "profile present");
  assert.equal(snap.enemyProfile!.armorStack.level, "heavy");
  assert.equal(nextStep(snap), "Lord Dominik's Regards");
  assert.equal(snap.recommendations[0].item, "Lord Dominik's Regards");
  assert.match(snap.recommendations[0].counterReason || "", /^Their armor is stacking \((Ornn|Malphite|Sejuani) ~\d+ armor, (Ornn|Malphite|Sejuani) ~\d+\)$/);
  const ornn = snap.enemies.find((entry) => entry.champion === "Ornn")!;
  assert.ok(ornn.estStats && ornn.estStats.armor >= 150, `Ornn armor ${ornn.estStats?.armor}`);

  const plain = (await snapshot([ITEM.hexoptics, ITEM.berserkers, ITEM.ie], SQUISHY)).snap;
  assert.equal(nextStep(plain), "Rapid Firecannon");
  assert.equal(plain.recommendations[0].counterReason, undefined);
  assert.ok(!plain.recommendations.some((rec) => /armor/.test(rec.reason) && rec.item === "Lord Dominik's Regards" && /Deviation/.test(rec.reason)), "no armor deviation card vs squishies");
});

test("engine: Mortal Reminder takes the late slot only into heavy healing", async (t) => {
  // Phantom Dancer fills the 4th slot: Lord Dominik's Regards would share Mortal Reminder's Last Whisper group.
  const core = [ITEM.hexoptics, ITEM.berserkers, ITEM.ie, ITEM.rfc, 3046];
  const healers: Seat[] = [{ champion: "Soraka" }, { champion: "Aatrox", items: [ITEM.sundered] }, { champion: "Jinx" }, { champion: "Lux" }, { champion: "Ahri" }];
  const { catalog, snap } = await snapshot(core, healers, { level: 16 });
  if (catalog.fallback) return t.skip("Data Dragon unreachable");
  assert.equal(snap.enemyProfile!.healing.level, "heavy");
  assert.equal(nextStep(snap), "Mortal Reminder");
  assert.match(snap.recommendations[0].counterReason || "", /^Heavy healing \(Aatrox \(Sundered Sky\) \+ Soraka\)/);
  const plain = (await snapshot(core, SQUISHY, { level: 16 })).snap;
  assert.equal(nextStep(plain), "Guardian Angel");
  assert.ok(!plain.buildPath.steps.some((step) => step.item === "Mortal Reminder"));
  // Owning Lord Dominik's Regards fills the Last Whisper group: League refuses Mortal Reminder, so the path moves on and
  // the next buy says why there is no anti-heal.
  const ldr = (await snapshot([ITEM.hexoptics, ITEM.berserkers, ITEM.ie, ITEM.rfc, ITEM.ldr], healers, { level: 16 })).snap;
  assert.equal(nextStep(ldr), "Guardian Angel");
  assert.ok(!ldr.buildPath.steps.some((step) => step.item === "Mortal Reminder") && !ldr.recommendations.some((rec) => rec.item === "Mortal Reminder"));
  assert.match(ldr.recommendations[0].reason, /Mortal Reminder is locked: you already own Lord Dominik's Regards \(Last Whisper group/);
});

test("engine: heavy poke puts Gluttonous Greaves in the boots slot; a physical comp offers armor boots as a deviation", async (t) => {
  const { catalog, snap } = await snapshot([ITEM.hexoptics], [{ champion: "Lux" }, { champion: "Ezreal" }, { champion: "Smolder" }, { champion: "Leona" }, { champion: "Ornn" }], { level: 8 });
  if (catalog.fallback) return t.skip("Data Dragon unreachable");
  assert.equal(snap.enemyProfile!.poke.level, "heavy");
  assert.equal(nextStep(snap), "Gluttonous Greaves");
  assert.match(snap.mobilityRecommendation?.reason || "", /Chosen because heavy poke \(Lux, Ezreal, Smolder\)/);
  const physical = (await snapshot([ITEM.hexoptics], [
    { champion: "Zed", items: [3142] }, { champion: "Jinx", items: [ITEM.ie] }, { champion: "Darius", items: [3071] }, { champion: "Kha'Zix", items: [3142] }, { champion: "Pyke" },
  ], { level: 8 })).snap;
  assert.equal(nextStep(physical), "Berserker's Greaves");
  assert.match(physical.mobilityRecommendation?.trigger || "", /Deviation to consider: Plated Steelcaps\. ~\d+% of enemy damage looks physical/);
});

// Top-build defaults from evidence, not popularity (lib/meta-builds.ts evidencePick, lib/live-game.ts resolveMetaSlots), the
// crit-kit preference, the anti-heal condition read from Riot item text (lib/build-research.ts), and how far a "some" HP
// signal goes (lib/enemy-stats.ts counterLevel / profilePromptLines). Built from the real Yone research of 16.20 (top) and
// 16.21 (middle), copied into tests/fixtures. Offline: a hand-made catalog with Data Dragon's tags and item text.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/meta-evidence.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { conditionOf, normalizeResearchedBuild, validateResearch, type RawResearch } from "@/lib/build-research";
import { configureItemGroups } from "@/lib/item-groups";
import { counterLevel, profilePromptLines, type EnemyProfile, type ThreatLevel } from "@/lib/enemy-stats";
import { resolveMetaSlots, type ItemCatalog, type ItemInfo, type MetaContext } from "@/lib/live-game";
import { EVIDENCE, evidencePick, type MetaBuild, type MetaOption } from "@/lib/meta-builds";
import type { LiveGameSnapshot } from "@/lib/types";

configureItemGroups({ network: false });

const fixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", `${name}-research.json`), "utf8")) as { build: MetaBuild; raw: RawResearch };
const TOP = fixture("yone-top");
const MIDDLE = fixture("yone-middle");

// Data Dragon 16.21 ids, costs, tags and (shortened) item text.
const WOUNDS = "Dealing physical damage applies 40% Wounds to enemy champions for 3 seconds.";
const ITEMS: ItemInfo[] = [
  { id: 6673, name: "Immortal Shieldbow", cost: 3000, tags: ["Damage", "CriticalStrike"], from: [1018, 1053], description: "55 Attack Damage 25% Critical Strike Chance Lifeline: a shield when taking damage at low Health." },
  { id: 3153, name: "Blade of The Ruined King", cost: 3200, tags: ["Damage", "AttackSpeed", "LifeSteal", "Slow", "OnHit"], from: [3144, 1043], description: "40 Attack Damage 25% Attack Speed 10% Life Steal Mist's Edge: Attacks deal a percentage of enemy's current Health as bonus physical damage On-Hit." },
  { id: 3031, name: "Infinity Edge", cost: 3500, tags: ["CriticalStrike", "Damage"], description: "75 Attack Damage 25% Critical Strike Chance" },
  { id: 6333, name: "Death's Dance", cost: 3300, tags: ["Armor", "Damage", "AbilityHaste"], description: "60 Attack Damage 50 Armor Ignore Pain" },
  { id: 3026, name: "Guardian Angel", cost: 3200, tags: ["Armor", "Damage"], description: "55 Attack Damage 45 Armor Rebirth" },
  { id: 3033, name: "Mortal Reminder", cost: 3000, tags: ["Damage", "CriticalStrike", "ArmorPenetration"], description: `35 Attack Damage 30% Armor Penetration Grievous Wounds ${WOUNDS}` },
  { id: 3036, name: "Lord Dominik's Regards", cost: 3300, tags: ["Damage", "CriticalStrike", "ArmorPenetration"], description: "35 Attack Damage 35% Armor Penetration Giant Slayer" },
  { id: 3091, name: "Wit's End", cost: 2800, tags: ["SpellBlock", "AttackSpeed", "OnHit", "Tenacity"], description: "45 Magic Resist 50% Attack Speed Fray" },
  { id: 3072, name: "Bloodthirster", cost: 3400, tags: ["Damage", "LifeSteal"], description: "80 Attack Damage 15% Life Steal Ichorshield" },
  { id: 3139, name: "Mercurial Scimitar", cost: 3200, tags: ["SpellBlock", "Damage", "Active"], description: "40 Attack Damage 35 Magic Resist Quicksilver" },
  { id: 6665, name: "Jak'Sho, The Protean", cost: 3200, tags: ["Health", "Armor", "SpellBlock"], description: "350 Health 45 Armor 45 Magic Resist Voidborn Resilience" },
  { id: 3075, name: "Thornmail", cost: 2450, tags: ["Health", "Armor"], description: "150 Health 75 Armor Thorns: when struck by an Attack, apply 40% Wounds for 3 seconds." },
  { id: 3006, name: "Berserker's Greaves", cost: 1100, tags: ["Boots", "AttackSpeed"], description: "25% Attack Speed 45 Move Speed" },
  { id: 3047, name: "Plated Steelcaps", cost: 1200, tags: ["Boots", "Armor"], description: "25 Armor 45 Move Speed" },
  { id: 3111, name: "Mercury's Treads", cost: 1250, tags: ["Boots", "SpellBlock"], description: "20 Magic Resist 45 Move Speed" },
  { id: 3144, name: "Bilgewater Cutlass", cost: 1300, tags: ["Damage", "LifeSteal"], from: [1036, 1053], description: "18 Attack Damage 10% Life Steal" },
  { id: 1043, name: "Recurve Bow", cost: 700, tags: ["AttackSpeed"], description: "15% Attack Speed" },
  { id: 1018, name: "Cloak of Agility", cost: 600, tags: ["CriticalStrike"], description: "15% Critical Strike Chance" },
  { id: 1053, name: "Vampiric Scepter", cost: 900, tags: ["Damage", "LifeSteal"], description: "15 Attack Damage 7% Life Steal" },
  { id: 1036, name: "Long Sword", cost: 350, tags: ["Damage"], description: "10 Attack Damage" },
  { id: 1001, name: "Boots", cost: 300, tags: ["Boots"], description: "25 Move Speed" },
];
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const catalog: ItemCatalog = { version: "16.21.1", byId: new Map(ITEMS.map((item) => [item.id, item])), byName: new Map(ITEMS.map((item) => [norm(item.name), item])), fallback: false };

const SIGNALS = ["armorStack", "mrStack", "hpStack", "healing", "burstThreat", "hardCc", "poke"] as const;
/** A team profile with every signal at "none" except the ones given. */
function profile(levels: Partial<Record<(typeof SIGNALS)[number], ThreatLevel>> = {}): EnemyProfile {
  const signal = (name: (typeof SIGNALS)[number]) => {
    const level = levels[name] || "none";
    return { level, score: level === "heavy" ? 3 : level === "some" ? 1 : 0, reasons: level === "none" ? [] : name === "hpStack" ? ["Darius ~3200 HP"] : [`${name} reason`], counter: "" };
  };
  return {
    estimated: true, version: "16.21.1", enemies: [],
    armorStack: { ...signal("armorStack"), perEnemy: [], high: 0, veryHigh: 0, frontlineAverage: 0 },
    mrStack: { ...signal("mrStack"), perEnemy: [], high: 0, veryHigh: 0, frontlineAverage: 0 },
    hpStack: { ...signal("hpStack"), high: levels.hpStack === "heavy" ? 2 : levels.hpStack === "some" ? 1 : 0 },
    healing: { ...signal("healing"), sources: [] },
    burstThreat: { ...signal("burstThreat"), threats: [] },
    hardCc: { ...signal("hardCc"), champions: [] },
    poke: { ...signal("poke"), champions: [] },
    physicalShare: { level: "some", score: 0.6, reasons: ["~60% of enemy damage looks physical"], counter: "", share: 0.6, lean: "mixed" },
  };
}
const me = (items: number[] = []) => ({ champion: "Yone", items: items.map((id) => ({ id, name: catalog.byId.get(id)!.name, count: 1, price: 0 })) }) as unknown as LiveGameSnapshot["activePlayer"];
const resolve = (context: MetaContext, items: number[] = []) => resolveMetaSlots(context, me(items), catalog, null, new Set(), new Set());
const names = (result: ReturnType<typeof resolve>) => result.items.map((item) => item.name);

test("evidence: Yone top 16.20 slot 1 lists Blade of The Ruined King first, but Shieldbow's core wins more (60.0% over 7,820 games vs 58.5%)", () => {
  const slot = TOP.build.slots[0];
  assert.deepEqual(slot.options.map((option) => option.item), ["Blade of The Ruined King", "Immortal Shieldbow"]);
  const pick = evidencePick(TOP.build, slot.options);
  assert.equal(slot.options[pick.index].item, "Immortal Shieldbow");
  assert.equal(pick.kind, "core");
  assert.equal(pick.gap, 1.5);
  // The whole path: Shieldbow opens, Blade of The Ruined King is nowhere (no heavy HP signal), for any kit.
  const result = resolve({ entry: TOP.build, profile: null });
  assert.equal(names(result)[0], "Immortal Shieldbow");
  assert.ok(!names(result).includes("Blade of The Ruined King"), names(result).join(" > "));
  assert.match(result.notes.get(6673) || "", /Immortal Shieldbow over Blade of The Ruined King: its builds win more \(60% over 7,820 games vs 58\.5%\)/);
});

test("evidence: Yone middle 16.21, ranked by its cores: Shieldbow + IE + Death's Dance 58.5% (1,283) beats BotRK + Shieldbow + IE 54.3% (921)", () => {
  const options: MetaOption[] = [{ item: "Blade of The Ruined King" }, { item: "Immortal Shieldbow" }];
  const pick = evidencePick(MIDDLE.build, options);
  assert.equal(options[pick.index].item, "Immortal Shieldbow");
  assert.equal(pick.gap, 4.2);
});

test("evidence: a low-sample or barely better option does not outrank the source's first option", () => {
  const base: MetaBuild = { ...TOP.build, cores: [] };
  // A 129-game core (10% of the top core) at 70% does not count; the 1,283-game core does.
  const cores = [
    { items: ["Infinity Edge", "Death's Dance", "Immortal Shieldbow"], games: 1283, winRate: 55 },
    { items: ["Infinity Edge", "Death's Dance", "Blade of The Ruined King"], games: 129, winRate: 70 },
  ];
  const options: MetaOption[] = [{ item: "Immortal Shieldbow" }, { item: "Blade of The Ruined King" }];
  assert.equal(evidencePick({ ...base, cores }, options).index, 0);
  // Above the share but under the absolute floor: still ignored.
  const small = [{ items: ["Immortal Shieldbow"], games: 150, winRate: 50 }, { items: ["Blade of The Ruined King"], games: 150, winRate: 65 }];
  assert.ok(150 < EVIDENCE.minCoreGames);
  assert.equal(evidencePick({ ...base, cores: small }, options).index, 0);
  // An option's own win rate with a tiny pick rate does not count.
  assert.equal(evidencePick(base, [{ item: "Death's Dance", winRate: 55, pickRate: 40 }, { item: "Guardian Angel", winRate: 70, pickRate: 1 }]).index, 0);
  // A gap under EVIDENCE.minGap keeps the source order.
  assert.equal(evidencePick(base, [{ item: "Death's Dance", winRate: 55 }, { item: "Guardian Angel", winRate: 55.5 }]).index, 0);
  assert.equal(evidencePick(base, [{ item: "Death's Dance", winRate: 55 }, { item: "Guardian Angel", winRate: 57 }]).index, 1);
  // Mixed evidence (own win rate vs a core's) never decides.
  assert.equal(evidencePick({ ...base, cores: [{ items: ["Guardian Angel"], games: 5000, winRate: 70 }] }, [{ item: "Death's Dance", winRate: 55 }, { item: "Guardian Angel" }]).index, 0);
});

/** One slot [Blade of The Ruined King, Immortal Shieldbow] with no win-rate evidence: only the kit and the enemy decide. */
const OPENER: MetaBuild = {
  ...TOP.build, cores: [],
  slots: [
    { id: "slot1", label: "1st item", kind: "core", options: [{ item: "Blade of The Ruined King" }, { item: "Immortal Shieldbow" }] },
    { id: "slot2", label: "2nd item", kind: "core", options: [{ item: "Infinity Edge" }] },
  ],
};

test("crit kit: a crit-scaling champion takes the crit option of a slot over an on-hit / attack-speed-only one; other kits keep the source order", () => {
  // Armor at "some": the team is not squishy (a squishy team already drops %-health / armor-pen options).
  const crit = resolve({ entry: OPENER, profile: profile({ armorStack: "some" }), critScaling: true });
  assert.deepEqual(names(crit), ["Immortal Shieldbow", "Infinity Edge"]);
  assert.match(crit.notes.get(6673) || "", /your kit scales with critical strikes/);
  assert.deepEqual(names(resolve({ entry: OPENER, profile: profile({ armorStack: "some" }), critScaling: false })), ["Blade of The Ruined King", "Infinity Edge"]);
});

test("crit kit: heavy HP stacking still picks the %-health option; 'some' HP does not", () => {
  // The counter displaces the crit default, which closes the path instead of being lost.
  assert.deepEqual(names(resolve({ entry: OPENER, profile: profile({ hpStack: "heavy" }), critScaling: true })), ["Blade of The Ruined King", "Infinity Edge", "Immortal Shieldbow"]);
  assert.deepEqual(names(resolve({ entry: OPENER, profile: profile({ hpStack: "some", armorStack: "some" }), critScaling: true })), ["Immortal Shieldbow", "Infinity Edge"]);
});

test("started item: held components keep an off-default option on the path, labelled with the stronger default", () => {
  // A Bilgewater Cutlass (Blade of The Ruined King's component) in the inventory.
  const result = resolve({ entry: OPENER, profile: profile({ armorStack: "some" }), critScaling: true }, [3144]);
  assert.equal(names(result)[0], "Blade of The Ruined King");
  assert.equal(result.started.get(3153), "Immortal Shieldbow");
  // Heavy HP backs it: no label.
  assert.equal(resolve({ entry: OPENER, profile: profile({ hpStack: "heavy" }), critScaling: true }, [3144]).started.size, 0);
});

test("anti-heal condition comes from item text: Blade of The Ruined King is never 'healing', Mortal Reminder is", () => {
  // The source's text: "vs high-health targets" is about HP ("health" is not "heal").
  assert.notEqual(conditionOf("vs high-health targets").when, "healing");
  assert.equal(conditionOf("vs heavy healing").when, "healing");
  const result = validateResearch(MIDDLE.raw, { catalog, version: "16.21.1", champion: "Yone", role: "MIDDLE", researchedAt: "2026-10-21T22:02:06.801Z" });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const options = result.build.slots.flatMap((slot) => slot.options);
  assert.ok(options.filter((option) => option.item === "Blade of The Ruined King").every((option) => option.when !== "healing"));
  assert.ok(options.some((option) => option.item === "Mortal Reminder" && option.when === "healing"));
  // A source that calls a non-anti-heal item a pick "vs heavy healing" keeps it conditional, but not as anti-heal.
  const build: MetaBuild = { ...OPENER, slots: [{ id: "s", label: "4th item", kind: "flex", options: [{ item: "Death's Dance" }, { item: "Blade of The Ruined King", when: "healing", condition: "vs heavy healing" }, { item: "Thornmail", when: "healing", condition: "vs heavy healing" }] }] };
  const normalized = normalizeResearchedBuild(build, catalog).build.slots[0].options;
  assert.equal(normalized[1].when, "situational");
  assert.equal(normalized[1].condition, "vs heavy healing");
  assert.equal(normalized[2].when, "healing");
});

test("stored research is re-checked on load: the stored Yone middle build drops BotRK's 'healing' and its 5th slot gets a default", () => {
  const stored = MIDDLE.build;
  assert.equal(stored.slots[0].options[1].when, "healing", "the stored file still has the old mapping (it is never rewritten)");
  const { build, changes } = normalizeResearchedBuild(stored, catalog);
  assert.equal(build.slots[0].options[1].when, "situational");
  assert.ok(changes.length >= 2, changes.join("\n"));
  // 4th/5th item: Death's Dance repeats the 3rd item, so the most built "situational" option (Guardian Angel) is the default.
  const fourth = build.slots.find((slot) => slot.label === "4th item")!;
  assert.equal(fourth.options.find((option) => option.item === "Guardian Angel")?.when, undefined);
  const path = names(resolve({ entry: build, profile: profile(), critScaling: true }));
  assert.deepEqual(path, ["Immortal Shieldbow", "Berserker's Greaves", "Infinity Edge", "Death's Dance", "Guardian Angel"]);
  // Without item data (offline catalog) the source's mapping stays.
  assert.equal(normalizeResearchedBuild(stored, null).build.slots[0].options[1].when, "healing");
});

test("HP 'some' is context only (no %-health push), heavy acts — in the engine's rule and in the HELP ME payload", () => {
  assert.equal(counterLevel(profile({ hpStack: "some" }), "hpStack"), null);
  assert.equal(counterLevel(profile({ hpStack: "heavy" }), "hpStack"), "act");
  const some = profilePromptLines(profile({ hpStack: "some" }));
  assert.ok(some.includes("HP some (context only: %-health damage needs HP heavy): Darius ~3200 HP"), some.join("\n"));
  const heavy = profilePromptLines(profile({ hpStack: "heavy" }));
  assert.ok(heavy.some((line) => line.startsWith("HP heavy (act: may reorder the build)")), heavy.join("\n"));
  const burst = profilePromptLines(profile({ burstThreat: "some" }));
  assert.ok(burst.some((line) => line.startsWith("burst some (watch:")), burst.join("\n"));
});

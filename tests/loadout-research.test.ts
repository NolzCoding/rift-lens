// Rune page and summoner spell research (lib/loadout-research.ts): answers are checked against Riot's rune and spell data.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/loadout-research.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadoutPrompt, validateLoadout, type LoadoutData } from "@/lib/loadout-research";

let nextId = 1;
const rune = (name: string) => ({ id: nextId++, name, icon: `perk-images/${name.replace(/\W/g, "")}.png` });
const tree = (name: string, rows: string[][]) => ({ ...rune(name), slots: rows.map((row) => row.map(rune)) });
const data: LoadoutData = {
  version: "16.21.1",
  trees: [
    tree("Precision", [["Press the Attack", "Lethal Tempo", "Fleet Footwork", "Conqueror"], ["Absorb Life", "Triumph", "Presence of Mind"], ["Legend: Alacrity", "Legend: Haste", "Legend: Bloodline"], ["Coup de Grace", "Cut Down", "Last Stand"]]),
    tree("Inspiration", [["Glacial Augment", "Unsealed Spellbook", "First Strike"], ["Hextech Flashtraption", "Magical Footwear", "Cash Back"], ["Triple Tonic", "Time Warp Tonic", "Biscuit Delivery"], ["Cosmic Insight", "Approach Velocity", "Jack Of All Trades"]]),
    tree("Sorcery", [["Summon Aery", "Arcane Comet", "Phase Rush"], ["Axiom Arcanist", "Manaflow Band", "Nimbus Cloak"], ["Transcendence", "Celerity", "Absolute Focus"], ["Scorch", "Waterwalking", "Gathering Storm"]]),
  ],
  shards: [
    [{ id: 5008, name: "Adaptive Force" }, { id: 5005, name: "Attack Speed" }, { id: 5007, name: "Ability Haste" }],
    [{ id: 5008, name: "Adaptive Force" }, { id: 5010, name: "Move Speed" }, { id: 5001, name: "Health Scaling" }],
    [{ id: 5011, name: "Health" }, { id: 5013, name: "Tenacity and Slow Resist" }, { id: 5001, name: "Health Scaling" }],
  ],
  spells: [
    { id: "SummonerFlash", key: 4, name: "Flash" }, { id: "SummonerHeal", key: 7, name: "Heal" }, { id: "SummonerDot", key: 14, name: "Ignite" },
    { id: "SummonerBoost", key: 1, name: "Cleanse" }, { id: "SummonerTeleport", key: 12, name: "Teleport" },
  ],
};
const page = (overrides: Record<string, unknown> = {}) => ({
  primaryTree: "Precision", keystone: "Press the Attack", primary: ["Absorb Life", "Legend: Alacrity", "Cut Down"],
  secondaryTree: "Inspiration", secondary: ["Magical Footwear", "Biscuit Delivery"], shards: ["Attack Speed", "Adaptive Force", "Health"],
  pickRate: 55.2, winRate: 51.3, when: null, note: null, ...overrides,
});
const answer = (pages: unknown[], spells: unknown[] = [{ spells: ["Flash", "Heal"], pickRate: 80, winRate: 51, when: null, note: null }]) => ({
  champion: "Caitlyn", role: "BOTTOM", patch: "16.21", sample: "Emerald+", notes: "",
  sources: [{ url: "https://lolalytics.com/lol/caitlyn/build/", site: "lolalytics", read: "runes" }, { url: "https://u.gg/lol/champions/caitlyn/build", site: "u.gg", read: "runes" }],
  pages, spells,
});

test("a valid page is kept with Riot's ids and icons; runes are put in row order", () => {
  const result = validateLoadout(answer([page({ primary: ["Cut Down", "Absorb Life", "Legend: Alacrity"], secondary: ["Biscuit Delivery", "Magical Footwear"] })]), "Caitlyn", "BOTTOM", data);
  assert.ok(result.ok);
  const [kept] = result.entry.pages;
  assert.equal(kept.keystone.name, "Press the Attack");
  assert.deepEqual(kept.primary.map((entry) => entry.name), ["Absorb Life", "Legend: Alacrity", "Cut Down"]);
  assert.deepEqual(kept.secondary.map((entry) => entry.name), ["Magical Footwear", "Biscuit Delivery"]);
  assert.deepEqual(kept.shards.map((entry) => entry.id), [5005, 5008, 5011]);
  assert.ok(kept.keystone.icon.startsWith("perk-images/"));
});

test("pages the game would not allow are dropped: another tree's keystone, two runes from one row, the same tree twice", () => {
  const result = validateLoadout(answer([
    page({ keystone: "Arcane Comet" }),
    page({ primary: ["Absorb Life", "Triumph", "Cut Down"] }),
    page({ keystone: "Lethal Tempo", when: "vs short-range lanes" }),
  ]), "Caitlyn", "BOTTOM", data);
  assert.ok(result.ok);
  assert.deepEqual(result.entry.pages.map((entry) => entry.keystone.name), ["Lethal Tempo"]);
  assert.equal(result.entry.pages[0].when, "vs short-range lanes");
  assert.equal(result.entry.dropped.length, 2);
  const same = validateLoadout(answer([page({ secondaryTree: "Precision", secondary: ["Triumph", "Cut Down"] })]), "Caitlyn", "BOTTOM", data);
  assert.equal(same.ok, false, "the secondary tree cannot be the primary tree");
});

test("no possible page at all rejects the answer", () => {
  const result = validateLoadout(answer([page({ keystone: "Electrocute" })]), "Caitlyn", "BOTTOM", data);
  assert.equal(result.ok, false);
});

test("spells: names as sites write them, unknown and duplicate pairs dropped", () => {
  const result = validateLoadout(answer([page()], [
    { spells: ["Flash", "Heal"], pickRate: 80, winRate: 51, when: null, note: null },
    { spells: ["Heal", "Flash"], pickRate: 5, winRate: 50, when: null, note: null },
    { spells: ["Flash", "Mark"], pickRate: 1, winRate: 40, when: null, note: null },
    { spells: ["Unleashed Teleport", "Flash"], pickRate: 3, winRate: 52, when: "vs poke", note: null },
  ]), "Caitlyn", "BOTTOM", data);
  assert.ok(result.ok);
  assert.deepEqual(result.entry.spells.map((pair) => pair.spells.map((spell) => spell.name).join("+")), ["Flash+Heal", "Teleport+Flash"]);
  assert.equal(result.entry.spells[1].when, "vs poke");
});

test("shards that do not fit their rows are left out, the runes kept", () => {
  const result = validateLoadout(answer([page({ shards: ["Health", "Adaptive Force", "Attack Speed"] })]), "Caitlyn", "BOTTOM", data);
  assert.ok(result.ok);
  assert.deepEqual(result.entry.pages[0].shards, []);
});

test("the prompt lists the real rune rows and spells", () => {
  const prompt = loadoutPrompt("Caitlyn", "BOTTOM", data);
  assert.match(prompt, /Precision: keystones Press the Attack, Lethal Tempo, Fleet Footwork, Conqueror; row 1: Absorb Life/);
  assert.match(prompt, /Summoner spells: Flash, Heal, Ignite, Cleanse, Teleport/);
  assert.match(prompt, /Stat shards: offense: Adaptive Force, Attack Speed, Ability Haste/);
});

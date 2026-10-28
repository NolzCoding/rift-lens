// Boots in the role-quest boots slot (lib/boots-slot.ts): the Live Client API stops listing them.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/boots-slot.test.ts
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { resetBootsSlot, slottedBoots, type BootsItem, type MoveStats } from "@/lib/boots-slot";

beforeEach(() => resetBootsSlot());

const boots: BootsItem = { id: 1001, name: "Boots", price: 300, flat: 25 };
const berserkers: BootsItem = { id: 3006, name: "Berserker's Greaves", price: 1100, flat: 45, from: [1001], description: "25% Attack Speed 45 Move Speed" };
const sorcerers: BootsItem = { id: 3020, name: "Sorcerer's Shoes", price: 1100, flat: 45, from: [1001], description: "12 Magic Penetration 45 Move Speed" };
const swiftness: BootsItem = { id: 3009, name: "Boots of Swiftness", price: 1000, flat: 55, from: [1001] };
const gunmetal: BootsItem = { id: 3172, name: "Gunmetal Greaves", price: 1600, flat: 45, from: [3006] };
const allBoots = [boots, berserkers, sorcerers, swiftness, gunmetal];
const stats = (moveSpeed: number, attackSpeed = 1.04): MoveStats => ({ moveSpeed, attackSpeed, armor: 60, magicResist: 40, magicPenetrationFlat: 0, abilityHaste: 0, abilityPower: 0, attackDamage: 150 });

/** One sample every 10 game seconds from `from` to `to`, returning the last result. */
function walk(from: number, to: number, ms: number, visible: BootsItem | null, attackSpeed?: number, alive = true, baseMoveSpeed: number | null = null, roleQuests = true) {
  let result: BootsItem | null = null;
  for (let time = from; time <= to; time += 10) result = slottedBoots("g1", { time, dead: !alive, stats: stats(ms, attackSpeed), visible, percent: 0, boots: allBoots, baseMoveSpeed, roleQuests });
  return result;
}

test("boots slot: listed boots are not added twice; hidden boots stay owned", () => {
  assert.equal(walk(480, 780, 350, boots), null, "listed: the item list already has them");
  assert.equal(walk(790, 900, 350, null)?.name, "Boots", "hidden in the boots slot: still owned");
  assert.equal(walk(910, 940, 0, null, 1.04, false)?.name, "Boots", "dead: kept");
});

test("boots slot: a move speed jump while hidden is the upgrade the stats point to", () => {
  walk(480, 780, 350, boots);
  walk(790, 880, 350, null);
  // Fountain speed while shopping is ignored, however long.
  assert.equal(walk(890, 960, 700, null, 1.18)?.name, "Boots");
  assert.equal(walk(970, 1040, 370, null, 1.18)?.name, "Berserker's Greaves", "+20 move speed and +attack speed: Berserker's");
  assert.equal(walk(1050, 1300, 370, null, 1.18)?.name, "Berserker's Greaves", "stays");
});

test("boots slot: a bonus that fits no upgrade of these boots changes nothing; one that vanishes means sold", () => {
  walk(480, 780, 350, boots);
  walk(790, 880, 350, null);
  assert.equal(walk(890, 1000, 410, null)?.name, "Boots", "+60 fits no Boots upgrade (Swiftness is +55 → bonus 85)");
  assert.equal(walk(1010, 1200, 325, null), null, "back to base speed: the boots were sold");
});

test("boots slot: a replay going back in time starts over", () => {
  walk(480, 900, 350, boots);
  walk(910, 1000, 350, null);
  assert.equal(walk(0, 60, 325, null), null, "a new game on the same roster has no boots yet");
});

test("boots slot: boots bought straight into the slot (never listed) are found from the champion's base move speed", () => {
  // Caitlyn-like: base 325, no boots listed all game; a dead-shop Berserker's shows only as 370 move speed.
  assert.equal(walk(400, 830, 325, null, 1.04, true, 325), null, "no boots yet");
  // Dead, the game reports the plain speed: the death-shop Berserker's counts before respawning.
  assert.equal(walk(840, 860, 370, null, 1.2, false, 325)?.name, "Berserker's Greaves", "dead in the shop: counted at once");
  assert.equal(walk(870, 960, 370, null, 1.2, true, 325)?.name, "Berserker's Greaves", "+45 and attack speed: Berserker's");
  assert.equal(walk(970, 1200, 370, null, 1.2, true, 325)?.name, "Berserker's Greaves", "stays");
});

test("boots slot: without a base move speed nothing is guessed", () => {
  assert.equal(walk(400, 960, 370, null), null);
});

test("boots slot: outside role-quest queues a small constant bonus (a jungle pet) is never taken for unlisted boots", () => {
  // Warwick-like Swiftplay: base 335, a pet keeps him at 360 (+25, exactly Boots) with no boots listed.
  assert.equal(walk(300, 900, 360, null, 1.04, true, 335, false), null);
});

test("boots slot: a bonus a few points off every boots item is not boots", () => {
  assert.equal(walk(300, 900, 355, null, 1.04, true, 335), null, "+20 is not Boots' +25");
});

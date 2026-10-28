// Every counter-build threshold Rift Lens uses (lib/enemy-stats.ts profile + counterLevel, lib/live-alerts.ts resist
// alerts). Pure data with no imports, so client components can read it.

/**
 * Every threshold the profile uses, in one place.
 *  - Armor/MR: "high" = total ≥ high OR item-bonus ≥ bonusHigh; "very high" = total ≥ veryHigh. A level-18 squishy
 *    already has ~105 armor / ~50 MR with no items, so totals alone are not a stacking signal early.
 *    heavy = ≥ 2 high enemies or ≥ 1 very high; some = 1 high enemy.
 *  - Healing: champion weight (lib/champion-traits.ts `healing`, 0–2 from the kit's healing abilities) + per completed item: (life steal + omnivamp) / 15% capped at 1, or the
 *    HEALING_ITEM_WEIGHTS value, or 0.5 for a heal-and-shield-power item; some ≥ 2, heavy ≥ 4 (two big healers, or one
 *    big healer plus two healing items). The anti-heal deviation card needs score ≥ 3 (one healer alone is not enough).
 *  - Burst: per burst-capable enemy (assassin/diver by champion traits, ≥ 18 lethality, or ≥ 200 AP) count "fed" signs: kills − deaths ≥ 3,
 *    ≥ 2 levels above you, ≥ 1500 more item gold than you. heavy = one with ≥ 2 signs (or ≥ 30 lethality + 1 sign);
 *    some = one with 1 sign, or ≥ 18 lethality.
 *  - Hard CC (cleansable lockdown): champion trait `hardCc` (suppression 2, a crowd-control kit 1); some ≥ 2, heavy ≥ 3.
 *  - Poke: champion trait `poke` (0–2 from damaging ability cast ranges); some ≥ 2, heavy ≥ 4.
 *  - HP stack: enemies with ≥ 800 bonus HP from items; some = 1, heavy ≥ 2.
 *  - Physical share: weighted by 1 + item gold / 3000; heavy ≥ 0.7, some ≥ 0.55; lean physical ≥ 0.65, magic ≤ 0.35.
 *    Boots override: armor boots at ≥ 0.7, MR boots at ≤ 0.3. Named boots alternative on the boots card ("some"): armor
 *    boots at ≥ 0.6, MR boots at ≤ 0.4.
 *  - Resist alerts (lib/live-alerts.ts): an enemy's new completed item adding ≥ armorBonus armor / ≥ mrBonus MR that leaves
 *    them at the armor/MR "high" bar, or any purchase that raises the team's armorStack/mrStack level. Watched when at
 *    least damageShare of the player's damage is of the matching type (a hybrid champion watches both).
 */
export const THREAT_THRESHOLDS = {
  armor: { high: 150, veryHigh: 200, bonusHigh: 60 },
  magicResist: { high: 100, veryHigh: 150, bonusHigh: 50 },
  stack: { someHigh: 1, heavyHigh: 2, heavyVeryHigh: 1 },
  hp: { bonusHigh: 800, some: 1, heavy: 2 },
  healing: { some: 2, heavy: 4, card: 3, itemWeight: 1, supportItemWeight: 0.5, fullVamp: 15 },
  burst: { lethality: 18, bigLethality: 30, abilityPower: 200, killLead: 3, levelLead: 2, goldLead: 1500 },
  hardCc: { some: 2, heavy: 3 },
  poke: { some: 2, heavy: 4 },
  physical: { some: 0.55, heavy: 0.7, leanPhysical: 0.65, leanMagic: 0.35, bootsArmor: 0.7, bootsMagic: 0.3, bootsArmorAlt: 0.6, bootsMagicAlt: 0.4 },
  resistAlert: { armorBonus: 40, mrBonus: 35, damageShare: 0.35 },
} as const;

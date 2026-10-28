// Estimated enemy stats + a team-level threat profile for counter-build decisions.
//
// Riot's Live Client Data API reports enemies' champion, level, items and scores but NOT their stats, so we rebuild
// them from Data Dragon: champion base stats + per-level growth (champion.json) plus item stats (item.json).
// Everything here is an ESTIMATE: runes/stat shards, stacking passives (Heartsteel, Mejai's...), Ornn upgrades,
// champion passives that grant stats, and temporary buffs are unknown and ignored.
//
// Data notes (checked against the real catalog, patch 16.20.1):
//  - Riot's growth formula: stat(n) = base + growth × (n − 1) × (0.7025 + 0.0175 × (n − 1)).
//  - Since 16.5.1 Data Dragon's champion.json reports attackdamageperlevel = 0 for EVERY champion (the game files still
//    have it, e.g. Caitlyn 3.8). When the current list looks broken like that, AD growth is taken from the last good
//    Data Dragon patch (AD_GROWTH_FALLBACK_VERSION); champions newer than that get the median growth.
//  - item.json `stats` covers health/armor/MR/AD/AP/attack speed/crit/life steal for every completed item, but never
//    lethality, armor/magic penetration, omnivamp or ability haste. Those come from the description's <stats> block
//    ("<attention>18</attention> Lethality"), which lists every stat; the two sources agree where both exist.
//
// The module is pure and synchronous once an EnemyStatsData is built; loadEnemyStatsData() fetches and caches it per
// Data Dragon version.
import { championKey, inferDamageProfile, type ChampionEntry } from "@/lib/champion-data";
import { championTraits, isDiver, type ChampionTraits } from "@/lib/champion-traits";
import { THREAT_THRESHOLDS } from "@/lib/threat-thresholds";

/** Last Data Dragon patch whose champion.json still carried real attackdamageperlevel values. */
export const AD_GROWTH_FALLBACK_VERSION = "16.4.1";

export type ChampionBaseStats = {
  id: string;
  name: string;
  tags: string[];
  info: ChampionEntry["info"];
  hp: number;
  hpPerLevel: number;
  armor: number;
  armorPerLevel: number;
  magicResist: number;
  magicResistPerLevel: number;
  attackDamage: number;
  attackDamagePerLevel: number;
  /** Base attacks per second. */
  attackSpeed: number;
  /** Bonus attack speed per level, in percent (Data Dragon `attackspeedperlevel`). */
  attackSpeedPerLevel: number;
  attackRange: number;
  /** Base move speed (Data Dragon `movespeed`); does not grow with level. Absent on the generic fallback. */
  moveSpeed?: number;
};

/** Flat stats one copy of an item grants. Percent fields are 0–100. */
export type ItemStatBlock = {
  id: number;
  name: string;
  cost: number;
  hp: number;
  armor: number;
  magicResist: number;
  attackDamage: number;
  abilityPower: number;
  attackSpeed: number;
  critChance: number;
  lethality: number;
  armorPenPercent: number;
  magicPenFlat: number;
  magicPenPercent: number;
  lifeSteal: number;
  omnivamp: number;
  abilityHaste: number;
  healShieldPower: number;
  /** Where the numbers came from: item.json `stats`, the description's <stats> block, or both merged. */
  source: "stats" | "description" | "both" | "none";
};

export type EnemyStatsData = {
  version: string;
  champions: Map<string, ChampionBaseStats>;
  items: Map<number, ItemStatBlock>;
  itemsByName: Map<string, ItemStatBlock>;
  /** "current" = the current champion.json had AD growth; otherwise the patch it was borrowed from. */
  adGrowthSource: string;
};

/** Estimated stats for one champion. Percent fields (attack-speed bonus, crit, pen %, vamp) are 0–100. */
export type EstimatedStats = {
  hp: number;
  bonusHp: number;
  armor: number;
  bonusArmor: number;
  magicResist: number;
  bonusMagicResist: number;
  attackDamage: number;
  bonusAttackDamage: number;
  abilityPower: number;
  /** Attacks per second (capped at 2.5). */
  attackSpeed: number;
  critChance: number;
  lethality: number;
  armorPenPercent: number;
  magicPenFlat: number;
  magicPenPercent: number;
  lifeSteal: number;
  omnivamp: number;
  abilityHaste: number;
  /** Total catalog cost of the items counted. */
  itemGold: number;
  /** False when the champion was not found and generic base stats were used. */
  championKnown: boolean;
  estimated: true;
};

export type EnemyItemInput = { id?: number; itemID?: number; name?: string; displayName?: string; count?: number; price?: number };
export type EnemyInput = {
  champion: string;
  level: number;
  items: EnemyItemInput[];
  kills?: number;
  deaths?: number;
  assists?: number;
  /** Optional override (e.g. LivePlayer.damageProfile, from the champion traits). */
  damageProfile?: "physical" | "magic" | "mixed" | "unknown";
  /** Optional champion traits (lib/champion-traits.ts); looked up by champion name when absent. */
  traits?: ChampionTraits;
};

export type ThreatLevel = "none" | "some" | "heavy";
export type ThreatSignal = {
  level: ThreatLevel;
  /** Raw score the level was derived from (see THREAT_THRESHOLDS). */
  score: number;
  /** Plain-English facts with rounded numbers, each ≤ 12 words. */
  reasons: string[];
  /** Generic counter idea, e.g. "armor penetration earlier"; empty when level is none. */
  counter: string;
};
export type EnemyEstimate = { champion: string; level: number; stats: EstimatedStats; keyItems: string[] };
export type EnemyProfile = {
  estimated: true;
  version: string;
  enemies: EnemyEstimate[];
  armorStack: ThreatSignal & { perEnemy: Array<{ champion: string; armor: number }>; high: number; veryHigh: number; frontlineAverage: number };
  mrStack: ThreatSignal & { perEnemy: Array<{ champion: string; magicResist: number }>; high: number; veryHigh: number; frontlineAverage: number };
  /** Health stacking (long fights): enemies with ≥ 800 bonus HP from items. */
  hpStack: ThreatSignal & { high: number };
  healing: ThreatSignal & { sources: string[] };
  burstThreat: ThreatSignal & { threats: string[] };
  hardCc: ThreatSignal & { champions: string[] };
  poke: ThreatSignal & { champions: string[] };
  physicalShare: ThreatSignal & { share: number; lean: "physical" | "magic" | "mixed" };
};

// Thresholds live in lib/threat-thresholds.ts (no server imports, so client code such as lib/live-alerts.ts can use them).
export { THREAT_THRESHOLDS };

/**
 * Completed items whose healing is not (fully) visible in a life-steal/omnivamp stat. Death's Dance (heal on takedown)
 * and Sterak's Gage (a shield) only count half.
 */
const HEALING_ITEM_WEIGHTS: Record<string, number> = {
  spiritvisage: 1, sunderedsky: 1, warmogsarmor: 1, redemption: 1, moonstonerenewer: 1, echoesofhelia: 1, deathsdance: 0.5, steraksgage: 0.5,
};
// ---------------------------------------------------------------------------------------------------------------
// Formulas

/** Riot's per-level growth: base + growth × (n − 1) × (0.7025 + 0.0175 × (n − 1)). */
export function statAtLevel(base: number, perLevel: number, level: number) {
  const n = Math.min(18, Math.max(1, Math.floor(level) || 1));
  return base + perLevel * (n - 1) * (0.7025 + 0.0175 * (n - 1));
}

const key = championKey;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// ---------------------------------------------------------------------------------------------------------------
// Data Dragon parsing (pure; testable with real or synthetic payloads)

type RawChampion = { id?: string; name?: string; tags?: string[]; info?: Partial<ChampionEntry["info"]>; stats?: Record<string, number> };
type RawItemEntry = { name?: string; description?: string; stats?: Record<string, number>; gold?: { total?: number; purchasable?: boolean }; maps?: Record<string, boolean> };

type ItemNumbers = Omit<ItemStatBlock, "id" | "name" | "cost" | "source">;
const EMPTY_ITEM: ItemNumbers = {
  hp: 0, armor: 0, magicResist: 0, attackDamage: 0, abilityPower: 0, attackSpeed: 0, critChance: 0, lethality: 0, armorPenPercent: 0,
  magicPenFlat: 0, magicPenPercent: 0, lifeSteal: 0, omnivamp: 0, abilityHaste: 0, healShieldPower: 0,
};
/** item.json `stats` key → field and multiplier (fractions become 0–100). */
const STAT_KEYS: Record<string, [keyof ItemNumbers, number]> = {
  FlatHPPoolMod: ["hp", 1], FlatArmorMod: ["armor", 1], FlatSpellBlockMod: ["magicResist", 1], FlatPhysicalDamageMod: ["attackDamage", 1],
  FlatMagicDamageMod: ["abilityPower", 1], PercentAttackSpeedMod: ["attackSpeed", 100], FlatCritChanceMod: ["critChance", 100],
  PercentLifeStealMod: ["lifeSteal", 100],
};
/** Description <stats> label → field. "Magic Penetration" is flat or % depending on the number. */
const DESCRIPTION_LABELS: Record<string, keyof ItemNumbers> = {
  health: "hp", armor: "armor", magicresist: "magicResist", attackdamage: "attackDamage", abilitypower: "abilityPower",
  attackspeed: "attackSpeed", criticalstrikechance: "critChance", lethality: "lethality", armorpenetration: "armorPenPercent",
  magicpenetration: "magicPenFlat", lifesteal: "lifeSteal", omnivamp: "omnivamp", abilityhaste: "abilityHaste", healandshieldpower: "healShieldPower",
};

/** Parse the "<stats>…</stats>" block of an item description: "<attention>40</attention> Armor<br>…". */
export function parseDescriptionStats(description = ""): Partial<ItemNumbers> {
  const block = /<stats>([\s\S]*?)<\/stats>/i.exec(description)?.[1];
  if (!block) return {};
  const result: Partial<ItemNumbers> = {};
  for (const rawLine of block.split(/<br\s*\/?>/i)) {
    const line = rawLine.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const match = /^([\d.]+)\s*(%?)\s+(.+)$/.exec(line);
    if (!match) continue;
    let field = DESCRIPTION_LABELS[key(match[3])];
    if (!field) continue;
    if (field === "magicPenFlat" && match[2] === "%") field = "magicPenPercent";
    result[field] = (result[field] || 0) + Number(match[1]);
  }
  return result;
}

/** One item's stats: item.json `stats` where present, the description <stats> block for everything else. */
export function parseItemStats(id: number, raw: RawItemEntry): ItemStatBlock {
  const fromStats: Partial<ItemNumbers> = {};
  for (const [statKey, value] of Object.entries(raw.stats || {})) {
    const mapped = STAT_KEYS[statKey];
    if (mapped && num(value)) fromStats[mapped[0]] = Math.round(num(value) * mapped[1] * 100) / 100;
  }
  const fromDescription = parseDescriptionStats(raw.description);
  const numbers: ItemNumbers = { ...EMPTY_ITEM };
  let usedStats = false;
  let usedDescription = false;
  for (const field of Object.keys(EMPTY_ITEM) as Array<keyof ItemNumbers>) {
    if (fromStats[field]) { numbers[field] = fromStats[field]!; usedStats = true; }
    else if (fromDescription[field]) { numbers[field] = fromDescription[field]!; usedDescription = true; }
  }
  return {
    id, name: raw.name || String(id), cost: num(raw.gold?.total), ...numbers,
    source: usedStats && usedDescription ? "both" : usedStats ? "stats" : usedDescription ? "description" : "none",
  };
}

function median(values: number[]) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 3;
}

/**
 * Build the lookup tables from raw Data Dragon payloads. `adGrowthFrom` is an older champion.json `data` map used only
 * when the current one has (almost) no AD growth values.
 */
export function buildEnemyStatsData(
  version: string,
  championData: Record<string, RawChampion>,
  itemData: Record<string, RawItemEntry>,
  adGrowthFrom?: { version: string; data: Record<string, RawChampion> } | null,
): EnemyStatsData {
  const raws = Object.values(championData).filter((raw) => raw.id && raw.stats);
  const zeroAdGrowth = raws.filter((raw) => !num(raw.stats?.attackdamageperlevel)).length;
  const brokenAdGrowth = raws.length > 0 && zeroAdGrowth / raws.length > 0.8;
  const fallbackGrowth = new Map<string, number>();
  if (brokenAdGrowth && adGrowthFrom) {
    for (const raw of Object.values(adGrowthFrom.data)) if (raw.id && raw.stats) fallbackGrowth.set(raw.id, num(raw.stats.attackdamageperlevel));
  }
  const medianGrowth = median([...fallbackGrowth.values()]);
  const champions = new Map<string, ChampionBaseStats>();
  for (const raw of raws) {
    const stats = raw.stats!;
    const adGrowth = brokenAdGrowth ? fallbackGrowth.get(raw.id!) ?? medianGrowth : num(stats.attackdamageperlevel);
    const entry: ChampionBaseStats = {
      id: raw.id!, name: raw.name || raw.id!, tags: raw.tags || [],
      info: { attack: num(raw.info?.attack), defense: num(raw.info?.defense), magic: num(raw.info?.magic), difficulty: num(raw.info?.difficulty) },
      hp: num(stats.hp), hpPerLevel: num(stats.hpperlevel), armor: num(stats.armor), armorPerLevel: num(stats.armorperlevel),
      magicResist: num(stats.spellblock), magicResistPerLevel: num(stats.spellblockperlevel),
      attackDamage: num(stats.attackdamage), attackDamagePerLevel: adGrowth,
      attackSpeed: num(stats.attackspeed) || 0.625, attackSpeedPerLevel: num(stats.attackspeedperlevel), attackRange: num(stats.attackrange),
      moveSpeed: num(stats.movespeed) || undefined,
    };
    champions.set(key(entry.name), entry);
    champions.set(key(entry.id), entry);
  }
  const items = new Map<number, ItemStatBlock>();
  for (const [id, raw] of Object.entries(itemData)) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || !raw.name) continue;
    items.set(numericId, parseItemStats(numericId, raw));
  }
  // Same display name twice (mode copies with ids >= 100000): prefer the Summoner's Rift (lowest) id.
  const itemsByName = new Map<string, ItemStatBlock>();
  for (const item of [...items.values()].sort((a, b) => a.id - b.id)) if (!itemsByName.has(key(item.name))) itemsByName.set(key(item.name), item);
  return { version, champions, items, itemsByName, adGrowthSource: !brokenAdGrowth ? "current" : adGrowthFrom ? adGrowthFrom.version : "median" };
}

// ---------------------------------------------------------------------------------------------------------------
// Loader (cached per Data Dragon version)

const dataPromises = new Map<string, Promise<EnemyStatsData | null>>();
const DDRAGON = "https://ddragon.leagueoflegends.com/cdn";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(6000) } as RequestInit);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return await response.json() as T;
}

/** Champion base stats + item stats for a Data Dragon version; null when Data Dragon is unreachable (retried after 2 min). */
export function loadEnemyStatsData(version: string): Promise<EnemyStatsData | null> {
  let pending = dataPromises.get(version);
  if (!pending) {
    pending = (async () => {
      try {
        const [champions, items] = await Promise.all([
          fetchJson<{ data?: Record<string, RawChampion> }>(`${DDRAGON}/${version}/data/en_US/champion.json`),
          fetchJson<{ data?: Record<string, RawItemEntry> }>(`${DDRAGON}/${version}/data/en_US/item.json`),
        ]);
        const championData = champions.data || {};
        const raws = Object.values(championData);
        const broken = raws.length > 0 && raws.filter((raw) => !num(raw.stats?.attackdamageperlevel)).length / raws.length > 0.8;
        let adGrowthFrom: { version: string; data: Record<string, RawChampion> } | null = null;
        if (broken && version !== AD_GROWTH_FALLBACK_VERSION) {
          adGrowthFrom = await fetchJson<{ data?: Record<string, RawChampion> }>(`${DDRAGON}/${AD_GROWTH_FALLBACK_VERSION}/data/en_US/champion.json`)
            .then((payload) => ({ version: AD_GROWTH_FALLBACK_VERSION, data: payload.data || {} }))
            .catch(() => null);
        }
        const data = buildEnemyStatsData(version, championData, items.data || {}, adGrowthFrom);
        if (!data.champions.size || !data.items.size) throw new Error("Empty Data Dragon payload");
        return data;
      } catch {
        const retry = setTimeout(() => dataPromises.delete(version), 120_000);
        (retry as { unref?: () => void }).unref?.();
        return null;
      }
    })();
    dataPromises.set(version, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-champion estimate

/** Generic base stats for a champion Data Dragon does not know yet (estimates are flagged championKnown: false). */
const GENERIC_CHAMPION: ChampionBaseStats = {
  id: "Unknown", name: "Unknown", tags: [], info: { attack: 5, defense: 5, magic: 5, difficulty: 5 },
  hp: 620, hpPerLevel: 105, armor: 32, armorPerLevel: 4.7, magicResist: 30, magicResistPerLevel: 1.6,
  attackDamage: 60, attackDamagePerLevel: 3.1, attackSpeed: 0.65, attackSpeedPerLevel: 2.5, attackRange: 300,
};

export function championBase(data: EnemyStatsData, champion: string) {
  return data.champions.get(key(champion)) || null;
}

export function itemStats(data: EnemyStatsData, item: EnemyItemInput) {
  const id = num(item.id ?? item.itemID);
  return (id && data.items.get(id)) || data.itemsByName.get(key(item.name || item.displayName || "")) || null;
}

const round = (value: number, step = 1) => Math.round(value / step) * step;

export function estimateStats(champion: string, level: number, items: EnemyItemInput[], data: EnemyStatsData): EstimatedStats {
  const base = championBase(data, champion);
  const c = base || GENERIC_CHAMPION;
  const sum: ItemNumbers = { ...EMPTY_ITEM };
  let itemGold = 0;
  let armorPen = 0;
  let magicPenPercent = 0;
  for (const owned of items) {
    const stats = itemStats(data, owned);
    if (!stats) continue;
    const count = Math.max(1, Math.floor(num(owned.count)) || 1);
    itemGold += (num(owned.price) || stats.cost) * count;
    for (const field of Object.keys(EMPTY_ITEM) as Array<keyof ItemNumbers>) sum[field] += stats[field] * count;
    // Percent penetration from different items does not add up (each such item is unique); keep the largest.
    armorPen = Math.max(armorPen, stats.armorPenPercent);
    magicPenPercent = Math.max(magicPenPercent, stats.magicPenPercent);
  }
  const hpBase = statAtLevel(c.hp, c.hpPerLevel, level);
  const armorBase = statAtLevel(c.armor, c.armorPerLevel, level);
  const mrBase = statAtLevel(c.magicResist, c.magicResistPerLevel, level);
  const adBase = statAtLevel(c.attackDamage, c.attackDamagePerLevel, level);
  const bonusAs = statAtLevel(0, c.attackSpeedPerLevel, level) + sum.attackSpeed;
  return {
    hp: round(hpBase + sum.hp),
    bonusHp: round(sum.hp),
    armor: round(armorBase + sum.armor),
    bonusArmor: round(sum.armor),
    magicResist: round(mrBase + sum.magicResist),
    bonusMagicResist: round(sum.magicResist),
    attackDamage: round(adBase + sum.attackDamage),
    bonusAttackDamage: round(sum.attackDamage),
    abilityPower: round(sum.abilityPower),
    attackSpeed: Math.round(Math.min(2.5, c.attackSpeed * (1 + bonusAs / 100)) * 100) / 100,
    critChance: Math.min(100, round(sum.critChance)),
    lethality: round(sum.lethality),
    armorPenPercent: round(armorPen),
    magicPenFlat: round(sum.magicPenFlat),
    magicPenPercent: round(magicPenPercent),
    lifeSteal: round(sum.lifeSteal),
    omnivamp: round(sum.omnivamp),
    abilityHaste: round(sum.abilityHaste),
    itemGold: round(itemGold),
    championKnown: Boolean(base),
    estimated: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Team threat profile

const levelOf = (score: number, some: number, heavy: number): ThreatLevel => (score >= heavy ? "heavy" : score >= some ? "some" : "none");
const list = (names: string[], max = 3) => names.slice(0, max).join(" + ") + (names.length > max ? ` +${names.length - max}` : "");

/** Completed items and upgraded boots, for compact tables ("Thornmail", "Plated Steelcaps"). */
function keyItemNames(items: EnemyItemInput[], data: EnemyStatsData) {
  return items.flatMap((owned) => {
    const stats = itemStats(data, owned);
    if (!stats) return [];
    const boots = /greaves|steelcaps|treads|shoes|boots of swiftness|lucidity|swiftmarch|crimson lucidity|spellslinger|gunmetal|chainlaced|armored advance|forever forward/i.test(stats.name);
    return stats.cost >= 2000 || (boots && stats.cost >= 900) ? [stats.name] : [];
  });
}

function damageLean(enemy: EnemyInput, base: ChampionBaseStats | null, stats: EstimatedStats, traits: ChampionTraits) {
  const profile = enemy.damageProfile && enemy.damageProfile !== "unknown"
    ? enemy.damageProfile
    : traits.damage !== "unknown" ? traits.damage
    : inferDamageProfile(base ? { id: base.id, key: "", name: base.name, tags: base.tags, info: base.info } : null);
  const fromChampion = profile === "physical" ? 1 : profile === "magic" ? 0 : 0.5;
  // Items say what the champion is actually building (AP Varus, AD Kai'Sa…): blend 50/50 once there are damage items.
  const itemAd = stats.bonusAttackDamage + stats.lethality * 2;
  const itemAp = stats.abilityPower;
  if (itemAd + itemAp < 40) return fromChampion;
  return (fromChampion + itemAd / (itemAd + itemAp)) / 2;
}

export type ProfileOptions = { referenceLevel?: number; referenceItemGold?: number };

type StackStat = "armor" | "magicResist";
function stackSignal(estimates: EnemyEstimate[], stat: StackStat, counter: string) {
  const t = stat === "armor" ? THREAT_THRESHOLDS.armor : THREAT_THRESHOLDS.magicResist;
  const bonusField = stat === "armor" ? "bonusArmor" : "bonusMagicResist";
  const label = stat === "armor" ? "armor" : "MR";
  const perEnemy = estimates.map((entry) => ({ champion: entry.champion, value: entry.stats[stat], bonus: entry.stats[bonusField] })).sort((a, b) => b.value - a.value);
  const high = perEnemy.filter((entry) => entry.value >= t.high || entry.bonus >= t.bonusHigh);
  const veryHigh = perEnemy.filter((entry) => entry.value >= t.veryHigh);
  const top = perEnemy.slice(0, 2);
  const frontlineAverage = top.length ? round(top.reduce((total, entry) => total + entry.value, 0) / top.length) : 0;
  const level: ThreatLevel = high.length >= THREAT_THRESHOLDS.stack.heavyHigh || veryHigh.length >= THREAT_THRESHOLDS.stack.heavyVeryHigh
    ? "heavy" : high.length >= THREAT_THRESHOLDS.stack.someHigh ? "some" : "none";
  const reasons: string[] = [];
  if (level !== "none") {
    reasons.push(high.slice(0, 2).map((entry, index) => `${entry.champion} ~${round(entry.value, 5)}${index ? "" : ` ${label}`}`).join(", "));
    if (high.length >= 2) reasons.push(`${high.length} enemies at ${t.high}+ ${label} or stacking it`);
  }
  return {
    level, score: high.length + veryHigh.length, reasons, counter: level === "none" ? "" : counter,
    perEnemy: perEnemy.map((entry) => ({ champion: entry.champion, value: entry.value })),
    high: high.length, veryHigh: veryHigh.length, frontlineAverage,
  };
}

/** Team-level counter-build signals from estimated stats, champions and items. All numbers are estimates. */
export function enemyThreatProfile(enemies: EnemyInput[], data: EnemyStatsData, options: ProfileOptions = {}): EnemyProfile {
  // Champion traits from Riot data (lib/champion-traits.ts); Data Dragon tags/info for a champion no table knows yet.
  const traitsOf = enemies.map((enemy) => {
    if (enemy.traits) return enemy.traits;
    const base = championBase(data, enemy.champion);
    return championTraits(enemy.champion, base ? { id: base.id, key: "", name: base.name, tags: base.tags, info: base.info } : null);
  });
  const estimates: EnemyEstimate[] = enemies.map((enemy) => ({
    champion: enemy.champion,
    level: Math.max(1, Math.floor(num(enemy.level)) || 1),
    stats: estimateStats(enemy.champion, enemy.level, enemy.items || [], data),
    keyItems: keyItemNames(enemy.items || [], data),
  }));

  // Armor / MR stacking.
  const armor = stackSignal(estimates, "armor", "armor penetration earlier");
  const mr = stackSignal(estimates, "magicResist", "magic penetration earlier");

  // Health stacking.
  const hpHigh = estimates.filter((entry) => entry.stats.bonusHp >= THREAT_THRESHOLDS.hp.bonusHigh).sort((a, b) => b.stats.hp - a.stats.hp);
  const hpLevel = levelOf(hpHigh.length, THREAT_THRESHOLDS.hp.some, THREAT_THRESHOLDS.hp.heavy);
  const hpReasons = hpLevel === "none" ? [] : [hpHigh.slice(0, 2).map((entry, index) => `${entry.champion} ~${round(entry.stats.hp, 100)}${index ? "" : " HP"}`).join(", ")];

  // Healing.
  const healSources: string[] = [];
  let healScore = 0;
  const healContributors: Array<{ champion: string; score: number; items: string[] }> = [];
  enemies.forEach((enemy, index) => {
    const weight = traitsOf[index].healing;
    let score = weight;
    const healItems: string[] = [];
    if (weight) healSources.push(enemy.champion);
    for (const owned of enemy.items || []) {
      const stats = itemStats(data, owned);
      // Completed items only: components (Vampiric Scepter, Doran's Blade's omnivamp) would double-count the finished item.
      if (!stats || stats.cost < 2000) continue;
      const vamp = stats.lifeSteal + stats.omnivamp;
      const named = HEALING_ITEM_WEIGHTS[key(stats.name)] || 0;
      // 15% life steal (Bloodthirster) = one full item; BotRK's 10% = 0.7.
      const weight = Math.max(named, vamp > 0 ? Math.min(1, Math.round((vamp / THREAT_THRESHOLDS.healing.fullVamp) * 10) / 10) : 0)
        * THREAT_THRESHOLDS.healing.itemWeight;
      if (weight > 0) {
        score += weight;
        healItems.push(stats.name);
        healSources.push(`${enemy.champion}: ${stats.name}`);
      } else if (stats.healShieldPower > 0) {
        score += THREAT_THRESHOLDS.healing.supportItemWeight;
        healSources.push(`${enemy.champion}: ${stats.name}`);
      }
    }
    score = Math.round(score * 10) / 10;
    healScore += score;
    if (score > 0) healContributors.push({ champion: enemy.champion, score, items: healItems });
  });
  const healLevel = levelOf(healScore, THREAT_THRESHOLDS.healing.some, THREAT_THRESHOLDS.healing.heavy);
  const healReasons: string[] = [];
  if (healLevel !== "none") {
    // "Soraka + Aatrox (Sundered Sky)": the biggest contributors, their healing items in brackets.
    const top = [...healContributors].sort((a, b) => b.score - a.score).slice(0, 3);
    healReasons.push(top.map((entry) => entry.items.length ? `${entry.champion} (${entry.items.slice(0, 1).join("")})` : entry.champion).join(" + "));
  }

  // Burst threats (fed assassins / divers / burst builds).
  const refLevel = num(options.referenceLevel);
  const refGold = num(options.referenceItemGold);
  const t = THREAT_THRESHOLDS.burst;
  let burstLevel: ThreatLevel = "none";
  const threats: string[] = [];
  const burstReasons: Array<{ text: string; weight: number }> = [];
  enemies.forEach((enemy, index) => {
    const stats = estimates[index].stats;
    const capable = isDiver(traitsOf[index]) || championBase(data, enemy.champion)?.tags[0] === "Assassin"
      || stats.lethality >= t.lethality || stats.abilityPower >= t.abilityPower;
    if (!capable) return;
    const kd = num(enemy.kills) - num(enemy.deaths);
    const signs: string[] = [];
    if (kd >= t.killLead) signs.push(`${num(enemy.kills)}/${num(enemy.deaths)}`);
    if (refLevel && estimates[index].level - refLevel >= t.levelLead) signs.push(`level ${estimates[index].level} vs your ${refLevel}`);
    if (refGold && stats.itemGold - refGold >= t.goldLead) signs.push("big item lead");
    const heavy = signs.length >= 2 || (stats.lethality >= t.bigLethality && signs.length >= 1);
    const some = signs.length >= 1 || stats.lethality >= t.lethality;
    if (!heavy && !some) return;
    threats.push(enemy.champion);
    if (heavy) burstLevel = "heavy";
    else if (burstLevel === "none") burstLevel = "some";
    const damage = stats.lethality >= t.lethality ? `${stats.lethality} lethality` : stats.abilityPower >= 100 ? `~${round(stats.abilityPower, 10)} AP` : "";
    const text = [enemy.champion, ...signs.slice(0, 2), damage].filter(Boolean).join(", ");
    burstReasons.push({ text, weight: (heavy ? 10 : 0) + signs.length });
  });
  burstReasons.sort((a, b) => b.weight - a.weight);

  // Hard CC.
  const ccChampions = enemies.filter((_enemy, index) => traitsOf[index].hardCc > 0).map((enemy) => enemy.champion);
  const ccScore = enemies.reduce((total, _enemy, index) => total + traitsOf[index].hardCc, 0);
  const ccLevel = levelOf(ccScore, THREAT_THRESHOLDS.hardCc.some, THREAT_THRESHOLDS.hardCc.heavy);
  const suppressors = enemies.filter((_enemy, index) => traitsOf[index].hardCc >= 2).map((enemy) => enemy.champion);

  // Poke.
  const pokeChampions = enemies.filter((_enemy, index) => traitsOf[index].poke > 0).map((enemy) => enemy.champion);
  const pokeScore = enemies.reduce((total, _enemy, index) => total + traitsOf[index].poke, 0);
  const pokeLevel = levelOf(pokeScore, THREAT_THRESHOLDS.poke.some, THREAT_THRESHOLDS.poke.heavy);

  // Physical share of enemy damage, weighted toward whoever has the most items.
  let weightSum = 0;
  let physicalSum = 0;
  enemies.forEach((enemy, index) => {
    const stats = estimates[index].stats;
    const weight = 1 + stats.itemGold / 3000;
    weightSum += weight;
    physicalSum += weight * damageLean(enemy, championBase(data, enemy.champion), stats, traitsOf[index]);
  });
  const share = weightSum ? Math.round((physicalSum / weightSum) * 100) / 100 : 0.5;
  const p = THREAT_THRESHOLDS.physical;
  const lean = share >= p.leanPhysical ? "physical" : share <= p.leanMagic ? "magic" : "mixed";
  const physicalLevel: ThreatLevel = share >= p.heavy ? "heavy" : share >= p.some ? "some" : "none";

  return {
    estimated: true,
    version: data.version,
    enemies: estimates,
    armorStack: { ...armor, perEnemy: armor.perEnemy.map((entry) => ({ champion: entry.champion, armor: entry.value })) },
    mrStack: { ...mr, perEnemy: mr.perEnemy.map((entry) => ({ champion: entry.champion, magicResist: entry.value })) },
    hpStack: { level: hpLevel, score: hpHigh.length, reasons: hpReasons, counter: hpLevel === "none" ? "" : "%-health damage", high: hpHigh.length },
    healing: { level: healLevel, score: Math.round(healScore * 10) / 10, reasons: healReasons, counter: healLevel === "none" ? "" : "anti-heal", sources: healSources },
    burstThreat: {
      level: burstLevel, score: threats.length, reasons: burstReasons.slice(0, 2).map((entry) => entry.text),
      counter: burstLevel === "none" ? "" : "defensive item earlier", threats,
    },
    hardCc: {
      level: ccLevel, score: ccScore,
      reasons: ccLevel === "none" ? [] : [suppressors.length ? `Lockdown: ${list(suppressors)}${ccChampions.length > suppressors.length ? ` + ${ccChampions.length - suppressors.length} more` : ""}` : `Hard CC: ${list(ccChampions)}`],
      counter: ccLevel === "none" ? "" : "cleanse item (QSS / Mercurial)", champions: ccChampions,
    },
    poke: {
      level: pokeLevel, score: pokeScore, reasons: pokeLevel === "none" ? [] : [`Long-range poke: ${list(pokeChampions)}`],
      counter: pokeLevel === "none" ? "" : "sustain (life steal)", champions: pokeChampions,
    },
    physicalShare: {
      level: physicalLevel, score: share, share, lean,
      reasons: [`~${Math.round(share * 100)}% of enemy damage looks physical`],
      counter: lean === "physical" ? "armor boots (Plated Steelcaps)" : lean === "magic" ? "MR boots (Mercury's Treads)" : "",
    },
  };
}

/** The profile without the per-enemy estimates (those travel on LivePlayer.estStats in the snapshot). */
export type EnemyProfileSummary = Omit<EnemyProfile, "enemies">;
export function summarizeProfile(profile: EnemyProfile): EnemyProfileSummary {
  const { enemies: _enemies, ...summary } = profile;
  void _enemies;
  return summary;
}

type ProfileLike = EnemyProfileSummary | EnemyProfile;
const SIGNAL_LABELS: Array<[keyof Pick<EnemyProfile, "armorStack" | "mrStack" | "hpStack" | "healing" | "burstThreat" | "hardCc" | "poke">, string]> = [
  ["armorStack", "armor"], ["mrStack", "MR"], ["hpStack", "HP"], ["healing", "healing"], ["burstThreat", "burst"], ["hardCc", "hard CC"], ["poke", "poke"],
];

/** One compact line per signal that fired, e.g. "armor heavy: Ornn ~185 armor, Sejuani ~160". */
export function profileSummary(profile: ProfileLike) {
  const lines = SIGNAL_LABELS.filter(([name]) => profile[name].level !== "none").map(([name, label]) => `${label} ${profile[name].level}: ${profile[name].reasons.join("; ")}`);
  lines.push(`damage ${profile.physicalShare.lean}: ${profile.physicalShare.reasons[0]}`);
  return lines;
}

/**
 * profileSummary for the HELP ME prompt: each line says how far Rift Lens acts on it (counterLevel, the engine's own
 * rule), so the model does not argue a counter item from a signal the engine only treats as context:
 * "HP some (context only: %-health damage needs HP heavy): Darius ~3200 HP".
 */
export function profilePromptLines(profile: ProfileLike) {
  const lines = SIGNAL_LABELS.filter(([name]) => profile[name].level !== "none").map(([name, label]) => {
    const level = profile[name].level;
    const action = counterLevel(profile, name);
    const how = action === "act" ? "act: may reorder the build"
      : name === "hpStack" ? "context only: %-health damage needs HP heavy"
        : action === "consider" ? "watch: a labelled option, not a reason to leave the path" : "context only: not a reason to buy a counter";
    return `${label} ${level} (${how}): ${profile[name].reasons.join("; ")}`;
  });
  lines.push(`damage ${profile.physicalShare.lean}: ${profile.physicalShare.reasons[0]}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Counter items ↔ signals (meta-build conditions, path preferences)

/** A signal a counter item answers. "armorBoots"/"mrBoots" read the physical share. */
export type CounterSignal = "armorStack" | "mrStack" | "hpStack" | "healing" | "burstThreat" | "hardCc" | "poke" | "armorBoots" | "mrBoots";

const COUNTER_ITEMS: Record<string, CounterSignal> = {
  lorddominiksregards: "armorStack", seryldasgrudge: "armorStack", blackcleaver: "armorStack",
  voidstaff: "mrStack", cryptbloom: "mrStack",
  bladeoftheruinedking: "hpStack", liandrystorment: "hpStack", terminus: "hpStack",
  mortalreminder: "healing", morellonomicon: "healing", thornmail: "healing", chempunkchainsword: "healing", executionerscalling: "healing", oblivionorb: "healing",
  gluttonousgreaves: "poke", bloodthirster: "poke",
  mercurialscimitar: "hardCc", quicksilversash: "hardCc", mikaelsblessing: "hardCc",
  guardianangel: "burstThreat", zhonyashourglass: "burstThreat", bansheesveil: "burstThreat", edgeofnight: "burstThreat", mawofmalmortius: "burstThreat",
  platedsteelcaps: "armorBoots", randuinsomen: "armorBoots", mercurystreads: "mrBoots",
};

/**
 * Which signal makes a counter option worth choosing. Meta-build conditions: "healing" → healing, "heavy-poke" → poke;
 * "situational" options go by the item (Lord Dominik's → armorStack, Mercurial → hardCc…), then by the source's wording
 * ("vs tanks", "vs heavy CC"…). Null = no signal can justify it automatically.
 */
export function counterSignalFor(item: string, when?: string | null, condition?: string | null): CounterSignal | null {
  if (when === "healing") return "healing";
  if (when === "heavy-poke") return "poke";
  const byItem = COUNTER_ITEMS[key(item)];
  if (byItem) return byItem;
  const text = (condition || "").toLowerCase();
  // "heal", not "health" ("vs high-health targets" is HP stacking).
  if (/heal(?!th)|sustain|lifesteal|life steal/.test(text)) return "healing";
  if (/poke|range/.test(text)) return "poke";
  if (/tank|armou?r|frontline/.test(text)) return "armorStack";
  if (/magic resist|\bmr\b/.test(text)) return "mrStack";
  if (/\bcc\b|crowd control|suppress|stun|lockdown/.test(text)) return "hardCc";
  if (/burst|assassin|dive|all-in/.test(text)) return "burstThreat";
  if (/health|hp stack/.test(text)) return "hpStack";
  return null;
}

/** True when the signal is at "heavy" (boots: the physical share is past the boots threshold). */
export function signalHeavy(profile: ProfileLike | null | undefined, signal: CounterSignal | null) {
  if (!profile || !signal) return false;
  if (signal === "armorBoots") return profile.physicalShare.share >= THREAT_THRESHOLDS.physical.bootsArmor;
  if (signal === "mrBoots") return profile.physicalShare.share <= THREAT_THRESHOLDS.physical.bootsMagic;
  return profile[signal].level === "heavy";
}

/**
 * How Rift Lens treats a counter signal — the one decision the live engine (cards, path) and the post-game review share:
 *  - "act": heavy (signalHeavy). The live coach changes the path / Buy-next for it; the review may say "you should have
 *    built X".
 *  - "consider": a labelled situational card in the live coach (armor/MR/burst/hard CC "some"; healing only once its score
 *    reaches THREAT_THRESHOLDS.healing.card; boots past the "named alternative" bar). The review mentions it as context at most.
 *  - null: nothing.
 * Health stacking only ever acts at heavy (no "some" card).
 */
export function counterLevel(profile: ProfileLike | null | undefined, signal: CounterSignal | null): "act" | "consider" | null {
  if (!profile || !signal) return null;
  if (signalHeavy(profile, signal)) return "act";
  const physical = THREAT_THRESHOLDS.physical;
  if (signal === "armorBoots") return profile.physicalShare.share >= physical.bootsArmorAlt ? "consider" : null;
  if (signal === "mrBoots") return profile.physicalShare.share <= physical.bootsMagicAlt ? "consider" : null;
  if (signal === "healing") return profile.healing.score >= THREAT_THRESHOLDS.healing.card ? "consider" : null;
  if (signal === "hpStack") return null;
  return profile[signal].level === "some" ? "consider" : null;
}

/** Short numeric reason for a signal, e.g. "their frontline: Ornn ~185 armor, Sejuani ~160". */
export function signalReason(profile: ProfileLike, signal: CounterSignal) {
  switch (signal) {
    case "armorStack": return `their armor is stacking (${profile.armorStack.reasons[0] || `~${profile.armorStack.frontlineAverage} on their tankiest two`})`;
    case "mrStack": return `their MR is stacking (${profile.mrStack.reasons[0] || `~${profile.mrStack.frontlineAverage} on their tankiest two`})`;
    case "hpStack": return `they stack health (${profile.hpStack.reasons[0] || "big HP pools"})`;
    case "healing": return `heavy healing (${profile.healing.reasons[0] || "healers"})`;
    case "burstThreat": return `burst threat (${profile.burstThreat.reasons[0] || profile.burstThreat.threats.join(", ")})`;
    case "hardCc": return `hard CC (${profile.hardCc.champions.slice(0, 3).join(", ")})`;
    case "poke": return `heavy poke (${profile.poke.champions.slice(0, 3).join(", ")})`;
    case "armorBoots": return profile.physicalShare.reasons[0];
    case "mrBoots": return `~${Math.round((1 - profile.physicalShare.share) * 100)}% of enemy damage looks magic`;
  }
}

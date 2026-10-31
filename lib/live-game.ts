import { createHash } from "node:crypto";

import type {
  LiveActiveStats,
  LiveBuildPath,
  LiveDeathMoment,
  LiveDeathSource,
  LiveDragonState,
  LiveGameSnapshot,
  LiveItem,
  LiveObjectiveTimer,
  LivePlayer,
  LiveRecentEvent,
  LiveRecommendation,
  PlayerBrief,
} from "@/lib/types";
import { conflict, ensureItemGroups, type GroupConflict } from "@/lib/item-groups";
import { getItemUsageTip, itemUsageTip, registerItemTips } from "@/lib/item-synergy";
import { championEntry, inferDamageProfile, loadChampionIndex, type ChampionIndex } from "@/lib/champion-data";
import {
  buildClass, championTraits, championTraitsStatus, ensureChampionTraits, isDiver, isEnchanter, isMarksman, isTank, type BuildClass, type ChampionTraits,
} from "@/lib/champion-traits";
import { resetBootsSlot, slottedBoots, type BootsItem } from "@/lib/boots-slot";
import { aliveSampleAt, historyKey, recordSample, type HistorySample } from "@/lib/live-history";
import { evidencePick, isMetaItem, metaBuildFor, metaOption, metaOriginLabel, metaPatchNote, optionEvidence, roleName, type MetaBuild } from "@/lib/meta-builds";
import {
  championBase, counterLevel, counterSignalFor, enemyThreatProfile, loadEnemyStatsData, parseItemStats, signalHeavy, signalReason, summarizeProfile, THREAT_THRESHOLDS,
  type CounterSignal, type EnemyProfile,
} from "@/lib/enemy-stats";

type RawName = { displayName?: string };

type RawItem = {
  itemID?: number;
  displayName?: string;
  count?: number;
  price?: number;
  rawDescription?: string;
};

type RawPlayer = {
  championName?: string;
  isDead?: boolean;
  items?: RawItem[];
  level?: number;
  position?: string;
  respawnTimer?: number;
  riotId?: string;
  summonerName?: string;
  team?: string;
  scores?: { assists?: number; creepScore?: number; deaths?: number; kills?: number; wardScore?: number };
  summonerSpells?: { summonerSpellOne?: RawName; summonerSpellTwo?: RawName };
  runes?: { keystone?: RawName; primaryRuneTree?: RawName; secondaryRuneTree?: RawName };
};

type RawEvent = {
  EventID?: number;
  EventName?: string;
  EventTime?: number;
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  DragonType?: string;
  Stolen?: string | boolean;
  Result?: string;
};

type RawChampionStats = {
  currentHealth?: number;
  maxHealth?: number;
  resourceValue?: number;
  resourceMax?: number;
  abilityPower?: number;
  attackDamage?: number;
  armor?: number;
  magicResist?: number;
  abilityHaste?: number;
  attackSpeed?: number;
  magicPenetrationFlat?: number;
  magicPenetrationPercent?: number;
  armorPenetrationFlat?: number;
  armorPenetrationPercent?: number;
  lifeSteal?: number;
  omnivamp?: number;
  moveSpeed?: number;
  attackRange?: number;
};

export type RawLiveData = {
  activePlayer?: {
    riotId?: string;
    summonerName?: string;
    currentGold?: number;
    level?: number;
    championStats?: RawChampionStats;
    abilities?: Partial<Record<"Q" | "W" | "E" | "R" | "Passive", { abilityLevel?: number; displayName?: string }>>;
    fullRunes?: { keystone?: RawName; primaryRuneTree?: RawName; secondaryRuneTree?: RawName; generalRunes?: Array<{ id?: number; displayName?: string }> };
  };
  allPlayers?: RawPlayer[];
  events?: { Events?: RawEvent[] };
  gameData?: { gameMode?: string; gameTime?: number; mapName?: string; mapNumber?: number };
};

type CatalogItem = {
  id: number;
  name: string;
  cost: number;
  sellValue?: number;
  baseCost?: number;
  description?: string;
  from?: number[];
  /** Reverse of `from` within the Summoner's Rift catalog (what this component builds into). */
  into?: number[];
  tags?: string[];
  /**
   * What the item's damage stats scale (from Data Dragon item stats + the description's stat block): ad = attack damage,
   * crit, lethality, armor pen or life steal; ap = ability power or magic pen; hybrid = both; neutral = neither (defensive /
   * utility). Absent on the offline fallback list (treated as neutral).
   */
  scaling?: "ad" | "ap" | "hybrid" | "neutral";
  /** Crit or lethality: a carry stat a tank does not use. */
  carry?: boolean;
  /** Percent armor penetration / percent and flat magic penetration (Data Dragon stats + the description's stat block). */
  pen?: { armorPercent: number; magicPercent: number; magicFlat: number };
  /** "How to use it" line generated from the item's passive/active text (lib/item-synergy.ts); absent offline. */
  usageTip?: string;
  /** The item applies Grievous Wounds (its full Data Dragon description); absent offline / on hand-made test items. */
  antiHeal?: boolean;
  /** Data Dragon movement speed: flat bonus and percent (0.04 = 4%); absent when the item gives none. */
  moveSpeed?: { flat: number; percent: number };
};
/**
 * `fallback` = Data Dragon was unreachable and the small hard-coded FALLBACK_ITEMS list is in use. `aliases` = item id →
 * the catalog item it counts as (free rune boots → Boots).
 */
type Catalog = { version: string; byName: Map<string, CatalogItem>; byId: Map<number, CatalogItem>; fallback?: boolean; aliases?: Map<number, number> };

/**
 * Patch the FALLBACK_ITEMS prices were last checked against. Only used when Data Dragon is unreachable; it is NOT the
 * current patch (snapshot.patchStatus.fallback says so), but it stays a real version so Data Dragon image URLs resolve.
 */
const FALLBACK_ITEMS_PATCH = "16.19.1";

const FALLBACK_ITEMS: CatalogItem[] = [
  { id: 6657, name: "Rod of Ages", cost: 2600 },
  { id: 6655, name: "Luden's Companion", cost: 2850 },
  { id: 2503, name: "Blackfire Torch", cost: 2800 },
  { id: 4628, name: "Horizon Focus", cost: 2700 },
  { id: 4645, name: "Shadowflame", cost: 3200 },
  { id: 3157, name: "Zhonya's Hourglass", cost: 3250 },
  { id: 3102, name: "Banshee's Veil", cost: 3100 },
  { id: 3135, name: "Void Staff", cost: 3000 },
  { id: 3137, name: "Cryptbloom", cost: 2850 },
  { id: 3118, name: "Malignance", cost: 2700 },
  { id: 6653, name: "Liandry's Torment", cost: 3000 },
  { id: 3089, name: "Rabadon's Deathcap", cost: 3600 },
  { id: 3165, name: "Morellonomicon", cost: 2950 },
  { id: 3916, name: "Oblivion Orb", cost: 800 },
  { id: 3115, name: "Nashor's Tooth", cost: 3000 },
  { id: 3124, name: "Guinsoo's Rageblade", cost: 3000 },
  { id: 3302, name: "Terminus", cost: 3000 },
  { id: 6672, name: "Kraken Slayer", cost: 3100 },
  { id: 3091, name: "Wit's End", cost: 2800 },
  { id: 3026, name: "Guardian Angel", cost: 3200 },
  { id: 3072, name: "Bloodthirster", cost: 3400 },
  { id: 3031, name: "Infinity Edge", cost: 3450 },
  { id: 3036, name: "Lord Dominik's Regards", cost: 3100 },
  { id: 3033, name: "Mortal Reminder", cost: 3200 },
  { id: 2523, name: "Hexoptics C44", cost: 2800 },
  { id: 6676, name: "The Collector", cost: 3000 },
  { id: 3094, name: "Rapid Firecannon", cost: 2650 },
  { id: 3046, name: "Phantom Dancer", cost: 2650 },
  { id: 3006, name: "Berserker's Greaves", cost: 1100 },
  { id: 3153, name: "Blade of The Ruined King", cost: 3200 },
  { id: 3100, name: "Lich Bane", cost: 3200 },
  { id: 4629, name: "Cosmic Drive", cost: 3000 },
  { id: 6665, name: "Jak'Sho, The Protean", cost: 3200 },
  { id: 3075, name: "Thornmail", cost: 2450 },
  { id: 6667, name: "Kaenic Rookern", cost: 2900 },
  { id: 6617, name: "Moonstone Renewer", cost: 2200 },
  { id: 3107, name: "Redemption", cost: 2300 },
  { id: 3222, name: "Mikael's Blessing", cost: 2300 },
];

const STANDARD_POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const TRINKETS = [3340, 3363, 3364];
/** Takes one of the six item slots: not a trinket, and not boots in the role-quest boots slot. */
const inSlot = (item: LiveItem) => !TRINKETS.includes(item.id) && !item.bootsSlot;
const CONTROL_WARD: CatalogItem = { id: 2055, name: "Control Ward", cost: 75 };
// Objective timings in game seconds. 2026 season: Atakhan removed in every queue, first Baron back to 20:00 on SR.
// Swiftplay (Riot support page + "/dev: A Swifter Swiftplay", Dec 2025): no grubs/herald, Baron 12:00, max 2 elemental
// drakes (one team needs both for soul), Elder at exactly 15:00 then +6:00, rift transforms after the 1st drake.
// Grub/Herald times and Swiftplay's first-drake time are not confirmed by Riot and are labelled as assumptions.
const SR = { dragon: 300, dragonRespawn: 300, elderAfterSoul: 360, elderRespawn: 360, grubs: 480, herald: 900, baron: 1200, baronRespawn: 360 };
const SWIFT = { dragon: 300, dragonRespawn: 300, maxElemental: 2, elder: 900, elderRespawn: 360, baron: 720, baronRespawn: 360 };
type Ruleset = "sr" | "swiftplay" | null;
const DRAGON_NAMES: Record<string, string> = { fire: "Infernal", water: "Ocean", earth: "Mountain", air: "Cloud", hextech: "Hextech", chemtech: "Chemtech", elder: "Elder" };
const PASSIVE_GOLD_PER_SECOND = 2.04;

/** A good catalog is re-checked every 6h (new patch mid-session); a failed load is retried after 60s. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_RETRY_MS = 60 * 1000;
let catalogState: { promise: Promise<Catalog>; expiresAt: number } | null = null;
const championContextPromises = new Map<string, Promise<LiveGameSnapshot["championContext"]>>();

/** Item text that applies anti-heal: a "Grievous Wounds" passive or "apply 40% Wounds" (Data Dragon wording). */
const GRIEVOUS_WOUNDS = /grievous wounds|\d+%\s*wounds\b/i;

/**
 * Whether an item applies Grievous Wounds, from its Data Dragon description: the computed flag when the catalog came from
 * Data Dragon, else its (clipped) description; null when there is no item text to read (offline / hand-made items).
 */
export function appliesGrievousWounds(item: Pick<CatalogItem, "antiHeal" | "description">): boolean | null {
  if (typeof item.antiHeal === "boolean") return item.antiHeal;
  return item.description ? GRIEVOUS_WOUNDS.test(item.description) : null;
}

function cleanText(value = "") {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function key(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sameName(left = "", right = "") {
  return Boolean(left && right && key(left) === key(right));
}

/** Riot's damage type for the champion (lib/champion-traits.ts); Data Dragon attack/magic ratings when no table knows it. */
function damageProfile(champion: string, index: ChampionIndex | null): LivePlayer["damageProfile"] {
  const data = championTraits(champion, index);
  return data.damage !== "unknown" ? data.damage : inferDamageProfile(championEntry(index, champion));
}

/**
 * What the engine asks about a champion, all derived from Riot game data (lib/champion-traits.ts: CommunityDragon roles,
 * damage type, playstyle ratings and ability text; Data Dragon tags for a champion no table knows yet). No champion
 * names anywhere: a rework or a new release is covered by the same rules.
 */
function traits(champion: string, index: ChampionIndex | null) {
  const data = championTraits(champion, index);
  return {
    data,
    profile: damageProfile(champion, index),
    diver: isDiver(data),
    tank: isTank(data),
    healer: data.healing > 0,
    marksman: isMarksman(data),
    enchanter: isEnchanter(data),
    magic: data.damage === "magic",
    cls: buildClass(data),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Champion scaling ↔ item fit: an AD champion is never told to buy an AP item (Banshee's Veil, Oblivion Orb, Liandry's on
// Yone) and an AP mage never an AD/crit item. Defensive/utility items without damage stats fit everyone.

export type ChampionScaling = "ad" | "ap" | "tank" | "hybrid";
/** Damage items any class builds: Guardian Angel's AD is incidental to its revive. */
const FITS_EVERYONE = new Set(["guardianangel"]);

function itemScaling(id: number, raw: Parameters<typeof parseItemStats>[1] & { name?: string; tags?: string[] }): Pick<CatalogItem, "scaling" | "carry" | "pen"> {
  const stats = parseItemStats(id, raw);
  const tags = new Set(raw.tags || []);
  let ad = stats.attackDamage + stats.critChance + stats.lethality + stats.armorPenPercent + stats.lifeSteal > 0;
  let ap = stats.abilityPower + stats.magicPenFlat + stats.magicPenPercent > 0;
  // Data Dragon tags only when the stat parse found nothing at all.
  if (!ad && !ap && stats.source === "none") {
    ad = tags.has("Damage") || tags.has("CriticalStrike");
    ap = tags.has("SpellDamage");
  }
  const scaling = FITS_EVERYONE.has(key(raw.name)) ? "neutral" : ad && ap ? "hybrid" : ad ? "ad" : ap ? "ap" : "neutral";
  const pen = stats.armorPenPercent || stats.magicPenPercent || stats.magicPenFlat
    ? { pen: { armorPercent: stats.armorPenPercent, magicPercent: stats.magicPenPercent, magicFlat: stats.magicPenFlat } } : {};
  return { scaling, carry: stats.critChance > 0 || stats.lethality > 0, ...pen };
}

/**
 * From the champion traits (Riot data): tanks → tank, then Riot's damage type (mixed → hybrid, physical → ad,
 * magic → ap). A hybrid champion's own completed items decide once they all lean one way. A committed off-type build
 * (two or more completed items of the other type and none of its own: AP Kai'Sa, AD Varus), or a top build (`meta`)
 * whose core is mostly the other type, follows the items instead of the champion's base type.
 */
export function championScaling(
  champion: string, index: ChampionIndex | null, items: Array<{ id: number }>, catalog: Pick<Catalog, "byId">,
  meta: { core: Array<Pick<CatalogItem, "scaling">> } | null = null,
): ChampionScaling {
  const self = traits(champion, index);
  let base: ChampionScaling;
  if (self.tank) base = "tank";
  else if (self.profile === "mixed") base = "hybrid";
  else if (self.profile === "physical") base = "ad";
  else if (self.profile === "magic") base = "ap";
  else base = self.enchanter ? "ap" : self.marksman ? "ad" : "hybrid";
  if (base === "tank") return base;
  const completed = items.map((item) => catalog.byId.get(item.id)).filter((item): item is CatalogItem => Boolean(item && isCompletedItem(item)));
  const ad = completed.filter((item) => item.scaling === "ad").length;
  const ap = completed.filter((item) => item.scaling === "ap").length;
  if (base === "hybrid") return ad && !ap ? "ad" : ap && !ad ? "ap" : "hybrid";
  const other = base === "ad" ? "ap" : "ad";
  const own = base === "ad" ? ad : ap;
  const off = base === "ad" ? ap : ad;
  if (off >= 2 && !own) return other;
  const core = meta?.core || [];
  if (!own && core.filter((item) => item.scaling === other).length > core.filter((item) => item.scaling === base).length) return other;
  return base;
}

/** True when the item suits the champion's scaling. Items without stat data (offline list) always fit. */
export function itemFitsScaling(item: Pick<CatalogItem, "scaling" | "carry">, scaling: ChampionScaling) {
  if (scaling === "hybrid" || !item.scaling || item.scaling === "neutral" || item.scaling === "hybrid") return true;
  if (scaling === "tank") return !item.carry;
  return item.scaling === scaling;
}

// Riot reports percent penetration as a damage multiplier in some client versions (1.0 = 0% pen, 0.6 = 40% pen)
// and as a fraction or percentage in others. Real pen never exceeds ~45%, so values >= 0.5 are read as multipliers.
function penetrationPercent(value: unknown) {
  const raw = num(value);
  if (raw > 1) return Math.round(raw * 10) / 10;
  return Math.round((raw >= 0.5 ? 1 - raw : raw) * 1000) / 10;
}

function fractionPercent(value: unknown) {
  const raw = num(value);
  return raw > 1 ? Math.round(raw * 10) / 10 : Math.round(raw * 1000) / 10;
}

function activeStats(stats: RawChampionStats): LiveActiveStats {
  const round = (value: unknown, digits = 0) => Number(num(value).toFixed(digits));
  return {
    abilityPower: round(stats.abilityPower),
    attackDamage: round(stats.attackDamage),
    armor: round(stats.armor),
    magicResist: round(stats.magicResist),
    abilityHaste: round(stats.abilityHaste),
    attackSpeed: round(stats.attackSpeed, 2),
    magicPenetrationFlat: round(stats.magicPenetrationFlat, 1),
    magicPenetrationPercent: penetrationPercent(stats.magicPenetrationPercent),
    armorPenetrationFlat: round(stats.armorPenetrationFlat, 1),
    armorPenetrationPercent: penetrationPercent(stats.armorPenetrationPercent),
    lifeSteal: fractionPercent(stats.lifeSteal),
    omnivamp: fractionPercent(stats.omnivamp),
    moveSpeed: round(stats.moveSpeed),
    attackRange: round(stats.attackRange),
  };
}

function normalizeItem(item: RawItem): LiveItem {
  const description = cleanText(item.rawDescription);
  return {
    id: num(item.itemID),
    name: item.displayName || "Unknown item",
    count: Math.max(1, num(item.count)),
    price: num(item.price),
    description: description.startsWith("GeneratedTip_") ? "" : description.slice(0, 280),
  };
}

function threatScore(player: RawPlayer) {
  const scores = player.scores || {};
  const itemValue = (player.items || []).reduce((sum, item) => sum + num(item.price) * Math.max(1, num(item.count)), 0);
  return Number((num(scores.kills) * 4 + num(scores.assists) * 1.35 - num(scores.deaths) * 1.1 + num(scores.creepScore) * 0.025 + num(player.level) * 1.7 + itemValue / 1200).toFixed(1));
}

function normalizePlayer(player: RawPlayer, activeScore: number, rank: number, index: ChampionIndex | null): LivePlayer {
  const score = threatScore(player);
  const kills = num(player.scores?.kills);
  let threat: LivePlayer["threat"] = "normal";
  if (rank === 0 && (kills >= 5 || score >= activeScore + 7)) threat = "critical";
  else if (kills >= 4 || score >= activeScore + 4) threat = "high";
  else if (rank <= 1 || kills >= 2) threat = "watch";
  return {
    champion: player.championName || "Unknown",
    name: player.riotId || player.summonerName || "Unknown player",
    riotId: player.riotId || "",
    team: player.team || "UNKNOWN",
    position: player.position || "UNKNOWN",
    level: num(player.level),
    isDead: Boolean(player.isDead),
    respawnTimer: num(player.respawnTimer),
    kills,
    deaths: num(player.scores?.deaths),
    assists: num(player.scores?.assists),
    cs: num(player.scores?.creepScore),
    wardScore: num(player.scores?.wardScore),
    items: (player.items || []).filter((item) => num(item.itemID) > 0).map(normalizeItem),
    threatScore: score,
    threat,
    damageProfile: damageProfile(player.championName || "", index),
    roles: championEntry(index, player.championName || "")?.tags || [],
    summonerSpells: [player.summonerSpells?.summonerSpellOne?.displayName, player.summonerSpells?.summonerSpellTwo?.displayName].filter((name): name is string => Boolean(name)),
    keystone: player.runes?.keystone?.displayName || null,
  };
}

function fallbackCatalog(): Catalog {
  return {
    version: FALLBACK_ITEMS_PATCH,
    byName: new Map(FALLBACK_ITEMS.map((item) => [key(item.name), item])),
    byId: new Map(FALLBACK_ITEMS.map((item) => [item.id, item])),
    fallback: true,
  };
}

async function loadCatalog(): Promise<Catalog> {
  const now = Date.now();
  if (!catalogState || now >= catalogState.expiresAt) {
    const previous = catalogState?.promise ?? null;
    const state = { promise: null as unknown as Promise<Catalog>, expiresAt: now + CATALOG_TTL_MS };
    state.promise = fetchCatalog().catch(async () => {
      // Keep the last good catalog over the fallback list, and retry soon either way.
      state.expiresAt = Date.now() + CATALOG_RETRY_MS;
      const last = previous ? await previous.catch(() => null) : null;
      return last && !last.fallback ? last : fallbackCatalog();
    });
    catalogState = state;
  }
  return catalogState.promise;
}

async function fetchCatalog(): Promise<Catalog> {
  const versionsResponse = await fetch("https://ddragon.leagueoflegends.com/api/versions.json", { next: { revalidate: 21600 }, signal: AbortSignal.timeout(3000) });
  if (!versionsResponse.ok) throw new Error("No Data Dragon version");
  const versions = await versionsResponse.json() as string[];
  const version = versions[0];
  if (!version) throw new Error("Data Dragon version list was empty");
  const itemResponse = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(3000) });
  if (!itemResponse.ok) throw new Error("No Data Dragon item data");
  const payload = await itemResponse.json() as { data?: Record<string, {
    name?: string;
    description?: string;
    from?: string[];
    into?: string[];
    tags?: string[];
    stats?: Record<string, number>;
    maps?: Record<string, boolean>;
    requiredChampion?: string;
    requiredAlly?: string;
    inStore?: boolean;
    gold?: { total?: number; base?: number; sell?: number; purchasable?: boolean };
  }> };
  // Mode copies (ids >= 100000, e.g. 667666 The Collector) and champion/ally-locked items are left out.
  const items: CatalogItem[] = Object.entries(payload.data || {}).flatMap(([id, item]) => item.name && item.gold?.purchasable && item.maps?.["11"] && Number(id) < 100000
    && !item.requiredChampion && !item.requiredAlly && item.inStore !== false
    ? [{
        id: Number(id),
        name: item.name,
        cost: num(item.gold.total),
        sellValue: num(item.gold.sell),
        baseCost: num(item.gold.base),
        description: cleanText(item.description).slice(0, 320),
        from: (item.from || []).map(Number).filter(Number.isFinite),
        tags: item.tags || [],
        ...itemScaling(Number(id), item),
        usageTip: itemUsageTip(item.description, item.tags),
        antiHeal: GRIEVOUS_WOUNDS.test(cleanText(item.description)),
        ...(item.stats?.FlatMovementSpeedMod || item.stats?.PercentMovementSpeedMod
          ? { moveSpeed: { flat: num(item.stats.FlatMovementSpeedMod), percent: num(item.stats.PercentMovementSpeedMod) } } : {}),
      }]
    : []);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const childId of item.from || []) {
      const child = byId.get(childId);
      if (child && !(child.into ||= []).includes(item.id)) child.into.push(item.id);
    }
  }
  // Same display name twice (rare duplicates): the lowest id wins.
  const byName = new Map<string, CatalogItem>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) if (!byName.has(key(item.name))) byName.set(key(item.name), item);
  if (!byId.size) throw new Error("Data Dragon item data was empty");
  // Free boots no shop sells (Slightly Magical Footwear's) build into the same upgrades as a purchasable boots item: they
  // count as that item, so the build path, upgrades and the boots slot see boots.
  const aliases = new Map<number, number>();
  for (const [id, item] of Object.entries(payload.data || {})) {
    if (byId.has(Number(id)) || !item.tags?.includes("Boots") || !item.into?.length) continue;
    const base = byId.get(Number(item.into[0]))?.from?.find((from) => byId.get(from)?.tags?.includes("Boots"));
    if (base) aliases.set(Number(id), base);
  }
  // This patch's item tips for every getItemUsageTip caller on the server (lib/item-synergy.ts).
  registerItemTips(version, [...byName.values()]);
  return { version, byName, byId, fallback: false, aliases };
}

async function loadChampionContext(version: string, champion: string, index: ChampionIndex): Promise<LiveGameSnapshot["championContext"]> {
  const championId = championEntry(index, champion)?.id;
  // Don't cache a miss caused by an unavailable champion list; a later poll can retry.
  if (!championId) return { source: "fallback", patch: version, passive: { name: "Passive", description: "" }, abilities: [], allyTips: [] };
  const cacheKey = `${version}:${key(champion)}`;
  let pending = championContextPromises.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${championId}.json`, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("No champion detail");
        const payload = await response.json() as { data?: Record<string, {
          allytips?: string[];
          passive?: { name?: string; description?: string };
          spells?: Array<{ name?: string; description?: string }>;
        }> };
        const detail = payload.data?.[championId];
        if (!detail) throw new Error("Champion detail was empty");
        const abilityKeys = ["Q", "W", "E", "R"] as const;
        return {
          source: "Riot Data Dragon" as const,
          patch: version,
          passive: { name: detail.passive?.name || "Passive", description: cleanText(detail.passive?.description).slice(0, 420) },
          abilities: (detail.spells || []).slice(0, 4).map((spell, index) => ({
            key: abilityKeys[index], name: spell.name || abilityKeys[index], description: cleanText(spell.description).slice(0, 420),
          })),
          allyTips: (detail.allytips || []).slice(0, 4).map((tip) => cleanText(tip).slice(0, 320)),
        };
      } catch {
        return { source: "fallback" as const, patch: version, passive: { name: "Passive", description: "" }, abilities: [], allyTips: [] };
      }
    })();
    championContextPromises.set(cacheKey, pending);
  }
  return pending;
}

function purchaseStep(target: CatalogItem, active: LiveGameSnapshot["activePlayer"], catalog: Catalog): LiveRecommendation["nextStep"] {
  const currentGold = Math.max(0, Math.floor(active.currentGold));
  const ownedCounts = new Map<number, number>();
  for (const item of active.items) ownedCounts.set(item.id, (ownedCounts.get(item.id) || 0) + Math.max(1, item.count));
  const direct = (target.from || []).map((id) => catalog.byId.get(id)).filter((item): item is CatalogItem => Boolean(item));
  const remainingDirect = direct.filter((component) => {
    const count = ownedCounts.get(component.id) || 0;
    if (count <= 0) return true;
    ownedCounts.set(component.id, count - 1);
    return false;
  });

  if (!remainingDirect.length && direct.length) {
    const combineCost = target.baseCost || Math.max(0, target.cost - direct.reduce((sum, component) => sum + component.cost, 0));
    return { itemId: target.id, item: target.name, cost: combineCost, affordable: currentGold >= combineCost, goldNeeded: Math.max(0, combineCost - currentGold) };
  }

  const candidates = new Map<number, CatalogItem>();
  const visit = (item: CatalogItem, depth: number) => {
    candidates.set(item.id, item);
    if (depth >= 3) return;
    for (const childId of item.from || []) {
      const child = catalog.byId.get(childId);
      if (child) visit(child, depth + 1);
    }
  };
  for (const item of remainingDirect) visit(item, 0);
  // A recipe piece League would refuse (an exclusive group the inventory already fills) is never the next purchase.
  const stock = active.items.map((item) => ({ id: item.id, count: item.count }));
  const available = [...candidates.values()].filter((item) => !(active.items.some((owned) => owned.id === item.id) && remainingDirect.some((directItem) => directItem.id !== item.id))
    && (item.id === target.id || !conflict(item.id, stock, [], recipeOf(catalog))));
  const affordable = available.filter((item) => item.cost <= currentGold).sort((a, b) => b.cost - a.cost)[0];
  const next = affordable || available.sort((a, b) => a.cost - b.cost)[0] || target;
  return { itemId: next.id, item: next.name, cost: next.cost, affordable: currentGold >= next.cost, goldNeeded: Math.max(0, next.cost - currentGold) };
}

// Shared catalog helpers for other server modules (HELP ME route validates AI-named items with these).
export type ItemInfo = CatalogItem;
export type ItemCatalog = Catalog;
export const getItemCatalog = () => loadCatalog();
export const nextPurchaseToward = (target: ItemInfo, active: LiveGameSnapshot["activePlayer"], catalog: ItemCatalog) => purchaseStep(target, active, catalog);

/** Exact name, then id-mapped fallback, then a unique prefix/substring match ("Collector" → The Collector). */
export function findItem(catalog: ItemCatalog, name: string): ItemInfo | null {
  const wanted = key(name);
  if (!wanted) return null;
  const exact = catalogChoice(catalog, [name]);
  if (exact) return exact;
  const items = [...catalog.byName.values()];
  const loose = items.filter((item) => key(item.name).startsWith(wanted) || key(item.name).replace(/^the/, "").startsWith(wanted));
  if (loose.length === 1) return loose[0];
  const contains = items.filter((item) => key(item.name).includes(wanted));
  return contains.length === 1 ? contains[0] : null;
}

function catalogChoice(catalog: Catalog, names: string[], avoid?: Set<string>): CatalogItem | null {
  const allowed = avoid ? names.filter((name) => !avoid.has(key(name))) : names;
  for (const name of allowed) {
    const found = catalog.byName.get(key(name));
    if (found) return found;
  }
  // Resolve by id so renamed items (e.g. Luden's Companion -> Luden's Echo) still get live recipe data.
  const fallback = FALLBACK_ITEMS.find((item) => allowed.some((name) => key(name) === key(item.name)));
  return fallback ? catalog.byId.get(fallback.id) || fallback : null;
}

function ownedCounts(active: LiveGameSnapshot["activePlayer"]) {
  const counts = new Map<number, number>();
  for (const item of active.items) counts.set(item.id, (counts.get(item.id) || 0) + Math.max(1, item.count));
  return counts;
}

/** Recipe lookup for lib/item-groups (a purchase uses up owned components, so they stop counting toward a group). */
const recipeOf = (catalog: Catalog) => (id: number) => catalog.byId.get(id)?.from;
export const itemRecipe = (catalog: ItemCatalog) => recipeOf(catalog);

/** Exclusive-group clash of buying `item` with the inventory (and `planned` items bought before it), else null. */
function groupClash(item: CatalogItem, active: LiveGameSnapshot["activePlayer"], catalog: Catalog, planned: number[] = []): GroupConflict | null {
  return conflict(item.id, ownedCounts(active), planned, recipeOf(catalog));
}

/** "you already own Mortal Reminder (Last Whisper group: one per inventory)". */
function clashText(found: GroupConflict, catalog: Catalog) {
  const names = found.blocking.map((id) => catalog.byId.get(id)?.name || `item ${id}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "an item";
  const limit = found.max === 1 ? "one per inventory" : `${found.max} per inventory`;
  return found.owned ? `you already own ${list} (${found.label} group: ${limit})` : `${list} is already in this build (${found.label} group: ${limit})`;
}

/** Owned components (anywhere in the recipe tree) the shop would consume when buying `item`; mutates `owned`. */
function consumeOwned(item: CatalogItem, owned: Map<number, number>, catalog: Catalog, depth = 0): { value: number; slots: number } {
  let value = 0;
  let slots = 0;
  for (const childId of item.from || []) {
    const child = catalog.byId.get(childId);
    const count = owned.get(childId) || 0;
    if (count > 0) {
      owned.set(childId, count - 1);
      value += child?.cost || 0;
      slots += 1;
    } else if (child && depth < 3) {
      const nested = consumeOwned(child, owned, catalog, depth + 1);
      value += nested.value;
      slots += nested.slots;
    }
  }
  return { value, slots };
}

function investedValue(item: CatalogItem, active: LiveGameSnapshot["activePlayer"], catalog: Catalog) {
  return consumeOwned(item, ownedCounts(active), catalog).value;
}

type Purchase = LiveDeathMoment["buyNow"][number];

/** Greedy recipe walk: buy the target outright if it fits, else the most valuable affordable components toward it. */
function planPurchases(target: CatalogItem, state: { gold: number; slots: number; owned: Map<number, number>; bought: number[] }, catalog: Catalog, limit: number): Purchase[] {
  const buys: Purchase[] = [];
  const queue: CatalogItem[] = [target];
  let guard = 0;
  while (queue.length && buys.length < limit && guard++ < 40) {
    queue.sort((left, right) => right.cost - left.cost);
    const item = queue.shift()!;
    // League refuses a purchase that overflows an exclusive group (Last Whisper while owning Mortal Reminder), counting
    // what this trip already bought.
    if (conflict(item.id, state.owned, state.bought, recipeOf(catalog))) continue;
    const trial = new Map(state.owned);
    const consumed = consumeOwned(item, trial, catalog);
    const cost = Math.max(0, item.cost - consumed.value);
    const slotsAfter = state.slots + 1 - consumed.slots;
    if (cost <= state.gold && slotsAfter <= 6) {
      buys.push({ itemId: item.id, item: item.name, cost, forItem: item.id === target.id ? null : target.name });
      state.gold -= cost;
      state.slots = slotsAfter;
      state.owned = trial;
      state.bought.push(item.id);
      continue;
    }
    for (const childId of item.from || []) {
      const count = state.owned.get(childId) || 0;
      // Owned components are reserved for this recipe; only missing ones become purchase candidates.
      if (count > 0) state.owned.set(childId, count - 1);
      else {
        const child = catalog.byId.get(childId);
        if (child) queue.push(child);
      }
    }
  }
  return buys;
}

type Self = ReturnType<typeof traits>;
type Underway = { item: CatalogItem; via: CatalogItem | null; invested: number };
type BuildPlan = {
  path: LiveBuildPath;
  /** Un-owned path items in order; recommendations[0] is the first one. */
  next: CatalogItem[];
  /** Used inside reasons, e.g. "your Mobalytics build". */
  phrase: string;
  underway: Underway | null;
  /** Upgraded boots named by the path (pinned/imported), not yet owned. */
  boots: CatalogItem | null;
  /** Ids appended after a fully-owned pinned/imported/meta/history path (in-progress item, then defaults). */
  continuation: Set<number>;
  /** The curated top build the path came from (source "meta"), else null. */
  meta: MetaBuild | null;
  /** Meta paths: item id → why an enemy signal chose it ("their armor is stacking (Ornn ~185 armor, Sejuani ~160)"). */
  counters: Map<number, string>;
  /** Meta paths: item id → why the slot's default is not the source's first option (win-rate evidence / crit kit). */
  notes: Map<number, string>;
  /** Item id → the stronger default it stands in for only because the player holds its components (no heavy signal). */
  started: Map<number, string>;
};

const BOOTS_NAME = /\bboots\b|greaves|shoes|treads|steelcaps|swiftness|lucidity|swiftmarch|crushers|armored advance|forever forward|symbiotic soles|synchronized souls|spellslinger/i;
const isBootsItem = (item: { name: string; tags?: string[] }) => Boolean(item.tags?.includes("Boots")) || BOOTS_NAME.test(item.name);
const isUpgradedBootsItem = (item: { id: number; name: string; tags?: string[] }) => item.id !== 1001 && !/^boots$/i.test(item.name) && isBootsItem(item);
const isCompletedItem = (item: CatalogItem) => item.cost >= 2000 && !isBootsItem(item) && !item.into?.length;
/** Upgraded boots as the engine counts them (tier-3 boots such as Gunmetal Greaves carry no "Boots" tag in Data Dragon). */
export const isUpgradedBoots = (item: Pick<ItemInfo, "id" | "name" | "tags">) => isUpgradedBootsItem(item);

function soldUpgradedBoots(sold: Set<number>, catalog: Catalog) {
  return [...sold].some((id) => isUpgradedBootsItem(catalog.byId.get(id) || { id, name: "" }));
}

/** With a full inventory, a component cannot be bought on its own: the next step is the whole item at its remaining cost. */
function wholeItemStep(target: CatalogItem, active: LiveGameSnapshot["activePlayer"], catalog: Catalog): NonNullable<LiveRecommendation["nextStep"]> {
  const cost = Math.max(0, target.cost - investedValue(target, active, catalog));
  const gold = Math.max(0, Math.floor(active.currentGold));
  return { itemId: target.id, item: target.name, cost, affordable: gold >= cost, goldNeeded: Math.max(0, cost - gold) };
}

function ownsUpgradedBoots(active: LiveGameSnapshot["activePlayer"], catalog: Catalog) {
  return active.items.some((item) => isUpgradedBootsItem(catalog.byId.get(item.id) || { id: item.id, name: item.name }));
}

const TAG_WORDS: Record<string, string> = {
  SpellDamage: "ability power", Damage: "attack damage", CriticalStrike: "critical strike", AttackSpeed: "attack speed", OnHit: "on-hit damage",
  ArmorPenetration: "armor penetration", MagicPenetration: "magic penetration", LifeSteal: "life steal", SpellVamp: "omnivamp",
  AbilityHaste: "ability haste", CooldownReduction: "ability haste", Mana: "mana", ManaRegen: "mana regen", Health: "health",
  HealthRegen: "health regen", Armor: "armor", SpellBlock: "magic resist", NonbootsMovement: "move speed", Boots: "move speed", Slow: "slows",
};

/** Generic one-liner from Data Dragon tags, for items without a hand-written reason. */
function itemBlurb(item: CatalogItem) {
  const words = [...new Set((item.tags || []).flatMap((tag) => TAG_WORDS[tag] ? [TAG_WORDS[tag]] : []))].slice(0, 4);
  return words.length ? `${item.name}: ${words.join(", ")} (${item.cost}g).` : `${item.name} (${item.cost}g).`;
}

/** The item's own mechanic tip (generated from its description), else a generic line from its Data Dragon tags. */
function usageTip(champion: string, item: CatalogItem) {
  const written = item.usageTip || getItemUsageTip(champion, item.name);
  if (written) return written;
  const tags = new Set(item.tags || []);
  if (tags.has("Active")) return `${item.name} has an active: keep it on a comfortable key and spend it on purpose, not on cooldown.`;
  if (isBootsItem(item)) return "Upgrade boots on a recall where the gold would not finish a bigger component.";
  if (tags.has("CriticalStrike")) return "Crit value compounds: finish this before starting the next crit component.";
  if (tags.has("SpellDamage")) return "Pure power spike: play around landing your main damage spell once it completes.";
  if (tags.has("Armor") || tags.has("SpellBlock")) return "Defensive stats pay off only if you stay in range long enough to use them.";
  return "";
}

/** Data Dragon tags consistent with the champion's class (soft preference for inventory inference). */
function classFit(item: CatalogItem, self: Self, apBuild: boolean) {
  const tags = new Set(item.tags || []);
  if (apBuild) return tags.has("SpellDamage");
  if (self.marksman) return tags.has("Damage") || tags.has("CriticalStrike") || tags.has("AttackSpeed");
  if (self.enchanter) return tags.has("ManaRegen") || tags.has("SpellDamage") || tags.has("Aura") || tags.has("Active");
  if (self.tank) return tags.has("Health") || tags.has("Armor") || tags.has("SpellBlock");
  return tags.has("Damage") || tags.has("Health");
}

function recipeContains(item: CatalogItem, id: number, catalog: Catalog, depth = 0): boolean {
  return (item.from || []).some((childId) => childId === id || (depth < 3 && Boolean(catalog.byId.get(childId)) && recipeContains(catalog.byId.get(childId)!, id, catalog, depth + 1)));
}

/**
 * Completed item(s) the owned components are heading toward, via the reverse recipe tree. Ranked by gold already invested,
 * then the player's own paths (pinned/imported/history/preferred), the default list, and class-consistent Data Dragon tags.
 */
function inferUnderway(
  active: LiveGameSnapshot["activePlayer"],
  catalog: Catalog,
  self: Self,
  apBuild: boolean,
  hints: Map<string, number>,
  defaultWeights: Map<string, number>,
  avoid: Set<string>,
  fits: (item: CatalogItem) => boolean = () => true,
): Underway | null {
  const ownedIds = new Set(active.items.map((item) => item.id));
  const components = active.items
    .map((item) => catalog.byId.get(item.id))
    .filter((item): item is CatalogItem => Boolean(item && item.cost > 0 && item.cost < 2000 && item.into?.length && !isBootsItem(item)
      && !(item.tags || []).some((tag) => tag === "GoldPer" || tag === "Consumable" || tag === "Trinket")));
  if (!components.length) return null;
  const candidates = new Map<number, CatalogItem>();
  const climb = (item: CatalogItem, depth: number) => {
    for (const parentId of item.into || []) {
      const parent = catalog.byId.get(parentId);
      if (!parent || candidates.has(parent.id)) continue;
      if (isCompletedItem(parent)) candidates.set(parent.id, parent);
      else if (depth < 3) climb(parent, depth + 1);
    }
  };
  for (const component of components) climb(component, 0);
  let best: (Underway & { score: number }) | null = null;
  for (const item of candidates.values()) {
    // Amplifying Tomes on Yone are not heading toward Banshee's Veil as far as the coach is concerned.
    if (ownedIds.has(item.id) || avoid.has(key(item.name)) || !fits(item) || groupClash(item, active, catalog)) continue;
    const invested = investedValue(item, active, catalog);
    if (invested <= 0) continue;
    const score = invested + invested / Math.max(1, item.cost) * 500 + (hints.get(key(item.name)) || 0)
      + (defaultWeights.get(key(item.name)) || 0) - (classFit(item, self, apBuild) ? 0 : 1500);
    if (best && score <= best.score) continue;
    const via = components.filter((component) => recipeContains(item, component.id, catalog)).sort((a, b) => b.cost - a.cost)[0] || null;
    best = { item, via, invested, score };
  }
  return best ? { item: best.item, via: best.via, invested: best.invested } : null;
}

/** `profile` = the enemy team's estimated-stat signals (lib/enemy-stats.ts); null when Data Dragon stats are unavailable. */
export type MetaContext = {
  entry: MetaBuild;
  profile: EnemyProfile | null;
  fits?: (item: CatalogItem) => boolean;
  /** The champion's kit scales with critical strikes (lib/champion-traits.ts, Riot ability text). */
  critScaling?: boolean;
};

/** Data Dragon's crit tag: the item gives critical strike chance or works with crits. */
const isCritItem = (item: CatalogItem) => Boolean(item.tags?.includes("CriticalStrike"));
/** On-hit / attack-speed value without crit (Blade of The Ruined King, Kraken Slayer, Wit's End…), from Data Dragon tags. */
const isOnHitOnly = (item: CatalogItem) => !isCritItem(item) && Boolean(item.tags?.some((tag) => tag === "OnHit" || tag === "AttackSpeed"));

/**
 * Turns the curated top build's slots into items. Per slot, the first rule that applies wins:
 * 1. an owned option fills the slot (any owned upgraded boots fill the boots slot);
 * 2. the option the player already holds components for (most gold invested; components claimed by an earlier slot don't count twice);
 * 3. a counter option whose enemy signal is HEAVY (lib/enemy-stats.ts counterSignalFor: Lord Dominik's Regards when their
 *    armor stacks, Mortal Reminder into heavy healing, Gluttonous Greaves into heavy poke, Mercurial into heavy hard CC);
 * 4. the player's own pick among the options: a marked preferred item, else the option earliest in their usual build;
 * 5. the default: for a crit-scaling kit, on-hit / attack-speed options without crit (Data Dragon tags) step aside while a
 *    crit option is left; then the best-evidenced option (lib/meta-builds.ts evidencePick: its own win rate, else the best
 *    core containing it, sample-guarded) when it beats the source's first option by EVIDENCE.minGap; else the first option
 *    (the most-built one: slots are ordered by popularity, not results).
 * Only options of the slot are ever considered, so items the player habitually builds outside the top build never enter the
 * path. Avoided items, items sold this game and conditional options (`when`) whose signal is not heavy are skipped.
 * `personal` = the player's history/preferences decided at least one real choice; `counters` = item id → the numeric reason
 * a heavy signal gave for picking it; `notes` = item id → why the default differs from the source's first option;
 * `started` = item id → the slot default it displaced only because the player holds its components (no heavy signal).
 */
export function resolveMetaSlots(
  meta: MetaContext,
  active: LiveGameSnapshot["activePlayer"],
  catalog: Catalog,
  brief: PlayerBrief | null,
  avoid: Set<string>,
  sold: Set<number>,
): { items: CatalogItem[]; personal: boolean; counters: Map<number, string>; notes: Map<number, string>; started: Map<number, string> } {
  const ownedIds = new Set(active.items.map((item) => item.id));
  const counters = new Map<number, string>();
  const notes = new Map<number, string>();
  const started = new Map<number, string>();
  const components = ownedCounts(active);
  const usual = (brief?.usualBuild || []).map(key);
  const preferred = new Set((brief?.preferredItems || []).map(key));
  const ownedBoots = active.items.map((item) => catalog.byId.get(item.id)).find((item): item is CatalogItem => Boolean(item && isUpgradedBootsItem(item))) || null;
  const used = new Set<number>();
  const items: CatalogItem[] = [];
  let personal = false;
  const profile = meta.profile;
  // Heavy burst (fed assassins/divers): the slot holding the anti-burst option (Guardian Angel…) moves up to the 4th
  // completed item instead of waiting for the 6th: the player was dying to them long before then.
  let slots = [...meta.entry.slots];
  if (signalHeavy(profile, "burstThreat")) {
    const isDefensive = (slot: (typeof slots)[number]) => slot.options.some((option) => counterSignalFor(option.item, option.when, option.condition) === "burstThreat");
    const from = slots.findIndex((slot, index) => index > 0 && isDefensive(slot));
    let seen = 0;
    const after = slots.findIndex((slot) => slot.kind !== "boots" && ++seen === 3);
    if (from > after + 1 && after >= 0) {
      const [moved] = slots.splice(from, 1);
      slots.splice(after + 1, 0, moved);
    }
  }
  // Nobody stacking armor or HP: armor penetration (Lord Dominik's…) is the weakest choice in its slot.
  const squishy = Boolean(profile && profile.armorStack.level === "none" && profile.hpStack.level === "none");
  const penetration = (item: CatalogItem) => { const signal = counterSignalFor(item.name); return signal === "armorStack" || signal === "hpStack"; };
  // Exclusive item groups (lib/item-groups.ts): an un-owned option is skipped when the inventory or an earlier un-owned pick
  // already fills its group (owning Mortal Reminder rules out Lord Dominik's Regards, Serylda's, Black Cleaver, Terminus).
  const recipe = recipeOf(catalog);
  const planned: number[] = [];
  const displaced = new Set<number>();
  // A heavy counter option (Mortal Reminder into heavy healing) claims its group up front, so an earlier slot does not
  // spend that group on a non-counter option (Lord Dominik's Regards in the 3rd slot would lock Mortal Reminder out of the 5th).
  const reserved = slots.flatMap((slot) => slot.options).flatMap((option) => {
    const item = catalogChoice(catalog, [option.item]);
    const signal = counterSignalFor(option.item, option.when, option.condition);
    if (!item || !signal || !signalHeavy(profile, signal) || ownedIds.has(item.id) || sold.has(item.id) || avoid.has(key(item.name))) return [];
    return conflict(item.id, ownedCounts(active), [], recipe) ? [] : [item.id];
  });
  for (const slot of slots) {
    if (slot.kind === "boots" && ownedBoots) {
      if (!used.has(ownedBoots.id)) { used.add(ownedBoots.id); items.push(ownedBoots); }
      continue;
    }
    const options = slot.options.flatMap((option) => {
      const item = catalogChoice(catalog, [option.item]);
      if (!item || used.has(item.id) || avoid.has(key(item.name))) return [];
      const owned = ownedIds.has(item.id);
      const signal = counterSignalFor(option.item, option.when, option.condition);
      const heavy = signalHeavy(meta.profile, signal);
      // A conditional option is only chosen when its enemy signal is heavy (an owned one still fills the slot); an option
      // that does not suit the champion's scaling is never picked.
      // An item a counter pushed out of an earlier slot is not conditional here (Infinity Edge "if delayed at third item").
      if (!owned && (sold.has(item.id) || (option.when && !heavy && !displaced.has(item.id)) || (meta.fits && !meta.fits(item)))) return [];
      if (!owned && conflict(item.id, ownedCounts(active), planned, recipe)) return [];
      if (!owned && !(heavy && signal) && reserved.some((id) => id !== item.id && Boolean(conflict(item.id, ownedCounts(active), [...planned, id], recipe)))) return [];
      return [{ item, owned, counter: heavy && signal ? signalReason(meta.profile!, signal) : null }];
    });
    if (!options.length) continue;
    let pick = options.find((option) => option.owned) || null;
    if (!pick) {
      const invested = options.map((option) => ({ option, value: consumeOwned(option.item, new Map(components), catalog).value }));
      const most = Math.max(...invested.map((entry) => entry.value));
      // Components decide only between options that use them; equal investment falls through to the counter / player's pick.
      const funded = most > 0 ? invested.filter((entry) => entry.value === most).map((entry) => entry.option) : options;
      // Against a squishy team, drop armor-pen options while something else is left (owned/funded picks already won above).
      const unarmored = <T extends { item: CatalogItem }>(list: T[]) => {
        const kept = squishy && list.length > 1 ? list.filter((option) => !penetration(option.item)) : list;
        return kept.length ? kept : list;
      };
      const candidates = unarmored(funded);
      const demoted = candidates.length < funded.length;
      const counter = candidates.length > 1 ? candidates.find((option) => option.counter) : undefined;
      const rank = (item: CatalogItem) => preferred.has(key(item.name)) ? -1 : usual.includes(key(item.name)) ? usual.indexOf(key(item.name)) : Infinity;
      const mine = candidates.length > 1 ? [...candidates].sort((a, b) => rank(a.item) - rank(b.item)).find((option) => rank(option.item) !== Infinity) : undefined;
      // Rule 5, the default: crit before on-hit-only for a crit-scaling kit, then the research's win-rate evidence.
      const metaOf = (item: CatalogItem) => slot.options.find((option) => key(option.item) === key(item.name)) || { item: item.name };
      const defaultOf = (list: typeof candidates) => {
        const critPool = meta.critScaling && list.some((option) => isCritItem(option.item)) ? list.filter((option) => !isOnHitOnly(option.item)) : list;
        const pool = critPool.length ? critPool : list;
        const evidence = evidencePick(meta.entry, pool.map((option) => metaOf(option.item)));
        const chosen = pool[evidence.index];
        let note = "";
        const over = list[0].item.name;
        if (!pool.includes(list[0])) note = `${chosen.item.name} over ${over}: your kit scales with critical strikes`;
        else if (chosen !== list[0]) {
          const own = optionEvidence(meta.entry, metaOf(chosen.item));
          const was = optionEvidence(meta.entry, metaOf(list[0].item));
          note = evidence.kind === "own" ? `${chosen.item.name} over ${over}: it wins more in this slot (${own.own}% vs ${was.own}%)`
            : `${chosen.item.name} over ${over}: its builds win more (${own.core!.winRate}% over ${own.core!.games.toLocaleString("en-US")} games vs ${was.core!.winRate}%)`;
        }
        return { chosen, note };
      };
      const fallback = defaultOf(candidates);
      const usualPick = mine || fallback.chosen;
      // A core item a counter displaced earlier (heavy healing: Mortal Reminder took Infinity Edge's 3rd slot) takes the
      // first later slot that lists it, ahead of that slot's own default.
      const carried = candidates.find((option) => displaced.has(option.item.id));
      if (!counter && !carried && mine) personal = true;
      pick = counter || carried || usualPick;
      if (carried && pick === carried) displaced.delete(carried.item.id);
      if (counter && pick === counter && usualPick !== counter && !slot.options.find((option) => key(option.item) === key(usualPick.item.name))?.when) {
        displaced.add(usualPick.item.id);
      }
      // The counter reason travels only when the signal changed the pick, or picked a conditional option.
      const conditional = Boolean(slot.options.find((option) => key(option.item) === key(pick!.item.name))?.when);
      if (pick.counter && (pick !== usualPick || conditional)) counters.set(pick.item.id, pick.counter);
      // Explain the squishy-team demotion only when it changed the pick (armor pen was the habit / first option).
      const habitual = [...funded].sort((a, b) => rank(a.item) - rank(b.item)).find((option) => rank(option.item) !== Infinity) || funded[0];
      if (demoted && profile && penetration(habitual.item) && habitual.item.id !== pick.item.id && !counters.has(pick.item.id)) {
        counters.set(pick.item.id, `their team has little armor (no one stacking it) → ${pick.item.name} before ${habitual.item.name}`);
      }
      if (pick === fallback.chosen && !mine && fallback.note && !counters.has(pick.item.id)) notes.set(pick.item.id, fallback.note);
      // Held components picked an option the slot would not default to, and no heavy signal backs it: still the path step
      // (finishing it uses that gold), but the card says the default is the stronger pick.
      if (most > 0 && !counter && !carried && !mine && !pick.counter) {
        const natural = defaultOf(unarmored(options)).chosen;
        if (natural.item.id !== pick.item.id) started.set(pick.item.id, natural.item.name);
      }
      consumeOwned(pick.item, components, catalog);
      planned.push(pick.item.id);
    }
    used.add(pick.item.id);
    items.push(pick.item);
  }
  // A displaced core item no later slot took (an owned item filled that slot) is never lost: it closes the path.
  for (const id of displaced) {
    const item = catalog.byId.get(id);
    if (!item || used.has(id) || ownedIds.has(id) || conflict(id, ownedCounts(active), planned, recipe)) continue;
    used.add(id);
    planned.push(id);
    items.push(item);
  }
  return { items, personal, counters, notes, started };
}

/** Build-source priority: pinned > imported (League-client item set) > meta (curated top build) > history > inventory inference > default. */
function resolvePlan(
  active: LiveGameSnapshot["activePlayer"],
  catalog: Catalog,
  brief: PlayerBrief | null,
  defaults: CatalogItem[],
  underway: Underway | null,
  avoid: Set<string>,
  sold: Set<number> = new Set(),
  bootsDefault: CatalogItem | null = null,
  meta: MetaContext | null = null,
  fits: (item: CatalogItem) => boolean = () => true,
): BuildPlan {
  const ownedIds = new Set(active.items.map((item) => item.id));
  const ownedKeys = new Set(active.items.map((item) => key(item.name)));
  const hasBoots = ownsUpgradedBoots(active, catalog);
  // Any upgraded boots satisfy a boots step: the slot is filled.
  const isOwned = (item: CatalogItem) => ownedIds.has(item.id) || ownedKeys.has(key(item.name)) || (hasBoots && isUpgradedBootsItem(item));
  // Only the player's own pinned list may name an item that does not suit the champion's scaling (Banshee's Veil learned
  // on Yone is dropped); an owned one stays an owned step.
  const suits = (item: CatalogItem) => isOwned(item) || fits(item);
  const resolveNames = (names: string[], skipAvoided: boolean) => {
    const seen = new Set<number>();
    return names.flatMap((name) => {
      const item = findItem(catalog, name);
      if (!item || seen.has(item.id) || (skipAvoided && avoid.has(key(item.name)))) return [];
      seen.add(item.id);
      return [item];
    });
  };
  const champion = active.champion;
  const pinned = resolveNames(brief?.pinnedBuild || [], false);
  const imported = resolveNames(brief?.importedBuild?.items || [], true).filter(suits);
  const history = resolveNames(brief?.usualBuild || [], true).filter(suits);
  let source: LiveBuildPath["source"];
  let label: string;
  let phrase: string;
  let items: CatalogItem[];
  let resolvedMeta: ReturnType<typeof resolveMetaSlots> | null = null;
  if (pinned.length) {
    [source, items, label, phrase] = ["pinned", pinned, `Your pinned ${champion} build`, "your pinned build"];
  } else if (imported.length) {
    const title = brief!.importedBuild!.title;
    const mobalytics = /mobalytics/i.test(title);
    [source, items] = ["imported", imported];
    label = `${mobalytics ? "Mobalytics item set" : "League client item set"} · ${title}`;
    phrase = mobalytics ? "your Mobalytics build" : "your imported item set";
  } else if (meta && (resolvedMeta = resolveMetaSlots(meta, active, catalog, brief, avoid, sold)).items.length) {
    [source, items] = ["meta", resolvedMeta.items];
    // No entry for the player's role yet: the champion's build for another role, labelled ("researched for top").
    const builtFor = meta.entry.servedFor ? ` for ${roleName(meta.entry.role)}` : "";
    const origin = meta.entry.origin === "researched" ? `, researched${builtFor}` : builtFor ? `, curated${builtFor}` : "";
    label = `Top ${champion} build (patch ${meta.entry.patch}${origin})${resolvedMeta.personal ? " · your picks where there's a choice" : ""}`;
    phrase = `the top ${champion} build`;
  } else if (history.length) {
    const games = Math.max(1, brief!.usualBuildGames || 0);
    const winRate = brief!.winRateOnChampion;
    [source, items] = ["history", history];
    label = games === 1 ? "From your last game" : `Your usual path (${games} games${winRate == null ? "" : `, ${Math.round(winRate <= 1 ? winRate * 100 : winRate)}% WR`})`;
    phrase = games === 1 ? "the build from your last game" : "your usual path";
  } else if (underway) {
    [source, items] = ["inventory", [underway.item, ...defaults.filter((item) => item.id !== underway.item.id)]];
    label = underway.via ? `Following your ${underway.via.name} → ${underway.item.name}` : `Following your ${underway.item.name} components`;
    phrase = "your in-progress path";
  } else {
    [source, items, label, phrase] = ["default", defaults, `Rift Lens default for ${champion}`, `the default ${champion} path`];
  }
  if (source === "inventory" || source === "default") {
    // Inferred paths start with the completed items already owned so the path reads in order.
    const ownedCompleted = [...new Map(active.items.map((item) => catalog.byId.get(item.id)).filter((item): item is CatalogItem => Boolean(item && isCompletedItem(item))).map((item) => [item.id, item])).values()];
    items = [...ownedCompleted, ...items.filter((item) => !ownedCompleted.some((ownedItem) => ownedItem.id === item.id))];
  } else if (source === "meta") {
    // Owned slot items first (in slot order), then any other owned completed item (it holds a slot, e.g. an off-meta
    // item bought earlier), then the un-owned slots in order.
    const extra = [...new Map(active.items.map((item) => catalog.byId.get(item.id))
      .filter((item): item is CatalogItem => Boolean(item && isCompletedItem(item) && !items.some((entry) => entry.id === item.id)))
      .map((item) => [item.id, item])).values()];
    const pending = items.filter((item) => !isOwned(item));
    // Finish what you started: a later top-build item with 1000g+ of owned components (e.g. Last Whisper toward Lord
    // Dominik's Regards) moves ahead of the next item when that one has less invested, instead of leaving the gold idle.
    const firstItem = pending.find((item) => !isUpgradedBootsItem(item));
    const started = pending.filter((item) => !isUpgradedBootsItem(item))
      .map((item) => ({ item, value: investedValue(item, active, catalog) }))
      .sort((a, b) => b.value - a.value)[0];
    if (firstItem && started && started.item !== firstItem && started.value >= 1000 && started.value > investedValue(firstItem, active, catalog)) {
      pending.splice(pending.indexOf(started.item), 1);
      pending.splice(pending.indexOf(firstItem), 0, started.item);
    }
    items = [...items.filter(isOwned), ...extra, ...pending];
  }
  if (source !== "pinned") items = items.filter(suits);
  // Every role needs upgraded boots, but learned/imported paths usually list only completed items:
  // slot boots in right after the first item so they show up as a real "buy next" step.
  // Selling upgraded boots (any pair) is a late-game slot decision: no boots step comes back after it.
  const bootsSold = !hasBoots && soldUpgradedBoots(sold, catalog);
  if (bootsSold) items = items.filter((item) => !isUpgradedBootsItem(item));
  if (bootsDefault && !hasBoots && !bootsSold && !items.some(isUpgradedBootsItem) && !avoid.has(key(bootsDefault.name)) && !sold.has(bootsDefault.id)) {
    items.splice(Math.min(1, items.length), 0, bootsDefault);
  }
  // Something the player sold this game is a decision, not a gap to refill.
  items = items.filter((item) => isOwned(item) || !sold.has(item.id));
  // Exclusive item groups (lib/item-groups.ts): League refuses an item whose group the inventory, or an earlier un-owned
  // step, already fills (Lord Dominik's Regards after Mortal Reminder). The player's own pinned/imported list keeps the
  // step, marked skipped with the reason; every other source just drops it.
  const recipe = recipeOf(catalog);
  const stock = ownedCounts(active);
  const planned: number[] = [];
  const skipped = new Map<number, string>();
  items = items.filter((item) => {
    if (isOwned(item)) return true;
    const found = conflict(item.id, stock, planned, recipe);
    if (!found) { planned.push(item.id); return true; }
    if (source !== "pinned" && source !== "imported") return false;
    skipped.set(item.id, `Skipped: ${clashText(found, catalog)}.`);
    return true;
  });
  const settled = (item: CatalogItem) => isOwned(item) || skipped.has(item.id);
  // A finished player path continues with the in-progress recipe, then the defaults, instead of going blank.
  const continuation = new Set<number>();
  // After a finished top build, the continuation follows the top build's own rules too: an item it lists only as a
  // conditional option (Blade of The Ruined King "vs high-health targets") needs its enemy signal heavy, and an item it
  // lists as off-meta never continues it, whether it comes from the class defaults or from held components.
  const metaRefuses = (item: CatalogItem) => {
    if (source !== "meta" || !meta) return false;
    if (meta.entry.offMeta.some((entry) => key(entry.item) === key(item.name)) && !isMetaItem(meta.entry, item.name)) return true;
    const listed = meta.entry.slots.flatMap((slot) => slot.options).filter((option) => key(option.item) === key(item.name));
    return listed.length > 0 && listed.every((option) => option.when) && !signalHeavy(meta.profile, optionSignal(listed[0]));
  };
  if ((source === "pinned" || source === "imported" || source === "meta" || source === "history") && items.every(settled)) {
    for (const item of [...(underway ? [underway.item] : []), ...defaults]) {
      if (items.some((entry) => entry.id === item.id) || isOwned(item) || sold.has(item.id) || metaRefuses(item)) continue;
      if (conflict(item.id, stock, planned, recipe)) continue;
      items.push(item);
      planned.push(item.id);
      continuation.add(item.id);
    }
    if (continuation.size) label = `${label} · then ${underway ? `your ${underway.item.name}` : "Rift Lens defaults"}`;
  }
  items = items.slice(0, 8);
  let marked = false;
  const steps = items.map((item): LiveBuildPath["steps"][number] => {
    const owned = isOwned(item);
    const note = owned ? undefined : skipped.get(item.id);
    if (note) return { itemId: item.id, item: item.name, cost: item.cost, status: "skipped", note };
    const status: LiveBuildPath["steps"][number]["status"] = owned ? "owned" : marked ? "later" : "next";
    if (!owned) marked = true;
    return { itemId: item.id, item: item.name, cost: item.cost, status };
  });
  const next = items.filter((item) => !settled(item));
  const metaEntry = source === "meta" ? meta!.entry : null;
  const provenance: LiveBuildPath["meta"] = metaEntry ? {
    origin: metaEntry.origin === "researched" ? "researched" : "curated",
    patch: metaEntry.patch,
    label: metaOriginLabel(metaEntry),
    sample: metaEntry.sample,
    checked: metaEntry.verified,
    outdated: Boolean(metaEntry.outdated || metaEntry.stale),
    sources: metaEntry.sources.map((entry) => ({ name: entry.name, url: entry.url, site: entry.site || entry.name.split(" ")[0] })),
    ...(metaEntry.servedFor ? { builtFor: metaEntry.role } : {}),
  } : undefined;
  return {
    path: { source, label, steps, ...(provenance ? { meta: provenance } : {}) }, next, phrase, underway, boots: next.find(isUpgradedBootsItem) || null, continuation, meta: metaEntry,
    counters: source === "meta" && resolvedMeta ? resolvedMeta.counters : new Map(),
    notes: source === "meta" && resolvedMeta ? resolvedMeta.notes : new Map(),
    started: source === "meta" && resolvedMeta ? resolvedMeta.started : new Map(),
  };
}

/** Items the player must not be told to sell: owned path steps and every recipe piece of an un-owned path step. */
function protectedFromSale(plan: BuildPlan, catalog: Catalog) {
  const ids = new Set<number>();
  const walk = (id: number, depth: number) => {
    if (ids.has(id) && depth > 0) return;
    ids.add(id);
    if (depth >= 4) return;
    for (const child of catalog.byId.get(id)?.from || []) walk(child, depth + 1);
  };
  // An owned step only protects itself: its recipe pieces are already spent (a held B. F. Sword is not "for" an owned
  // Guardian Angel).
  for (const step of plan.path.steps) {
    if (step.status === "skipped") continue;
    if (step.status === "owned") ids.add(step.itemId);
    else walk(step.itemId, 0);
  }
  return ids;
}

/** A potion, Biscuit or elixir: using it frees its slot, so it is never the thing to sell. */
function isConsumable(item: LiveItem, catalog: Catalog) {
  return (catalog.byId.get(item.id)?.tags || []).includes("Consumable") || /potion|biscuit|elixir/i.test(item.name);
}

/** True when buying `target` uses up an owned component, which frees its slot: no sale is needed. */
function freesSlot(target: CatalogItem, active: LiveGameSnapshot["activePlayer"], catalog: Catalog) {
  return consumeOwned(target, ownedCounts(active), catalog).slots > 0;
}

function buildSwapPlan(
  target: CatalogItem,
  active: LiveGameSnapshot["activePlayer"],
  catalog: Catalog,
  gameTime: number,
  protectedIds: Set<number>,
  /** A heavy counter-buy: the cheapest completed item outside the path may be swapped before the endgame too. */
  options: { anyTime?: boolean } = {},
): LiveRecommendation["swapPlan"] {
  const inventory = active.items.filter((item) => inSlot(item) && item.id !== target.id);
  if (inventory.length < 6) return null;
  // Selling something the target is built from, or something on the player's own path, only means buying it again.
  const targetTree = protectedFromSale({ path: { source: "default", label: "", steps: [{ itemId: target.id, item: target.name, cost: target.cost, status: "next" }] } } as BuildPlan, catalog);
  const targetIsBoots = isUpgradedBootsItem(target);
  const sellable = inventory.filter((item) => {
    const catalogItem = catalog.byId.get(item.id);
    // Unknown to the catalog (a rune's Biscuit, an unmapped id): no sell value, so never a sale (use it instead).
    if (!catalogItem || isConsumable(item, catalog)) return false;
    if (targetTree.has(item.id) || protectedIds.has(item.id)) return false;
    if (/ward|lens|potion|elixir/i.test(item.name)) return false;
    if (catalogItem && isUpgradedBootsItem(catalogItem) || /\bboots\b/i.test(item.name)) return false;
    return !(targetIsBoots && catalogItem && isCompletedItem(catalogItem) && protectedIds.has(catalogItem.id));
  });
  const endgame = gameTime >= 28 * 60 || active.level >= 17;
  const starter = sellable.find((item) => /doran|guardian's|cull|support quest|dark seal/i.test(item.name));
  const component = sellable
    .filter((item) => {
      const cost = catalog.byId.get(item.id)?.cost || 0;
      return cost > 0 && cost < 2200;
    })
    .sort((left, right) => (catalog.byId.get(left.id)?.cost || 0) - (catalog.byId.get(right.id)?.cost || 0))[0];

  let sellItem: LiveItem | null = starter || component || null;
  if (!sellItem && (endgame || options.anyTime)) {
    sellItem = [...sellable].sort((left, right) => {
      const leftCost = catalog.byId.get(left.id)?.cost || Number.MAX_SAFE_INTEGER;
      const rightCost = catalog.byId.get(right.id)?.cost || Number.MAX_SAFE_INTEGER;
      return leftCost - rightCost;
    })[0] || null;
  }
  if (!sellItem) return null;

  const soldCatalogItem = catalog.byId.get(sellItem.id);
  const sellValue = soldCatalogItem?.sellValue || Math.round((soldCatalogItem?.cost || 0) * 0.7);
  const availableGoldAfterSale = Math.floor(active.currentGold) + sellValue;
  const affordable = availableGoldAfterSale >= target.cost;
  const isLowCommitmentSlot = Boolean(starter || component);
  return {
    sellItemId: sellItem.id,
    sellItem: sellItem.name,
    sellValue,
    buyCost: target.cost,
    availableGoldAfterSale,
    affordable,
    goldNeeded: Math.max(0, target.cost - availableGoldAfterSale),
    goldAfter: affordable ? availableGoldAfterSale - target.cost : 0,
    rationale: isLowCommitmentSlot
      ? `${sellItem.name} is a low-value slot that is not part of ${target.name} or your build path.`
      : `${sellItem.name} is the cheapest completed item outside your build path; replace it only when ${target.name}'s condition matters more than the effect you lose.`,
  };
}

/**
 * The class whose default items to use: the champion's trait class (lib/champion-traits.ts buildClass), adjusted by what
 * is actually being built: an AP-committed inventory on an AD class takes the AP defaults (and the reverse), and a
 * marksman who already finished crit or on-hit items keeps going that way.
 */
function defaultClass(self: Self, scaling: ChampionScaling, apBuild: boolean, ownedCompleted: CatalogItem[]): BuildClass {
  let cls = self.cls;
  const apClass = cls === "mage-burst" || cls === "mage-battle" || cls === "assassin-ap";
  if (apBuild && !apClass && cls !== "tank" && cls !== "engage-support" && cls !== "enchanter") {
    cls = self.data.onHit || !self.data.ranged || self.data.ratings.durability >= 2 ? "mage-battle" : "mage-burst";
  } else if (scaling === "ad" && apClass) cls = self.data.critScaling ? "fighter-crit" : "fighter";
  if (cls === "marksman-crit" || cls === "marksman-onhit") {
    const crit = ownedCompleted.some((item) => (item.tags || []).includes("CriticalStrike"));
    const onHit = ownedCompleted.some((item) => (item.tags || []).includes("OnHit"));
    if (crit) cls = "marksman-crit";
    else if (onHit) cls = "marksman-onhit";
  }
  if (cls === "unknown") cls = scaling === "tank" ? "tank" : scaling === "ap" ? "mage-burst" : "fighter";
  return cls;
}

type AddChoice = (names: string[], priority: LiveRecommendation["priority"], reason: string, trigger: string, timing?: LiveRecommendation["timing"]) => void;

/**
 * Class defaults (the fallback path when no researched top build, pinned/imported build or history exists). Item names
 * are generic class staples; catalogChoice takes the first that exists on the patch, and the scaling filter drops any
 * that do not fit the champion. Primary choices form the default path in order.
 */
function addClassDefaults(add: AddChoice, cls: BuildClass, data: ChampionTraits, context: { critBuild: boolean; coreTiming: LiveRecommendation["timing"]; hasCompletedItem: boolean; supportGold: boolean }) {
  const first = context.hasCompletedItem ? "Only finish another first-item option once the core items are done." : "This is the first completed-item goal; the card's buy-now line shows the affordable recipe piece for this recall.";
  const poke = data.poke >= 1 || data.pokeRange >= 1100;
  switch (cls) {
    case "marksman-crit":
      add(["Yun Tal Wildarrows", "The Collector", "Kraken Slayer"], "primary", `First crit item for a marksman${data.critScaling ? " whose kit scales with critical strikes" : ""}.`, first, context.coreTiming);
      add(["Infinity Edge"], "primary", "Crit damage multiplies every critical strike: the core second item of a crit build.", "Finish it right after the first item and boots.");
      add(poke ? ["Rapid Firecannon", "Phantom Dancer"] : ["Phantom Dancer", "Rapid Firecannon"], "primary", poke ? "Extra range on the energized shot fits a long-range kit: poke and siege from further away." : "More crit and attack speed for kiting.", "Third item unless their armor calls for Lord Dominik's Regards first.");
      add(["Lord Dominik's Regards"], "situational", "Armor penetration keeps a crit build hurting tanks and armor items.", "Move it up into armor or two+ frontliners.");
      add(["Guardian Angel", "Bloodthirster"], "defensive", "A late survival or sustain item without giving up carry damage.", "Guardian Angel when one death loses the fight; Bloodthirster when poke keeps pushing you out.", "late-game");
      return;
    case "marksman-onhit":
      add(["Kraken Slayer", "Blade of The Ruined King"], "primary", "An on-hit opener for a marksman whose kit pays off on repeated attacks.", first, context.coreTiming);
      add(["Guinsoo's Rageblade"], "primary", "Attack speed that doubles on-hit effects: the core of an on-hit build.", "Best when you can keep attacking rather than only poke.");
      add(["Terminus"], "primary", "Hybrid penetration and resistances for longer fights.", "Move it up into armor or magic resist stacking.");
      add(["Wit's End", "Guardian Angel"], "defensive", "Keeps the attack-speed build alive: magic resist on-hit, or a revive.", "Wit's End into magic damage reaching you; Guardian Angel when you are the fed carry.", "late-game");
      return;
    case "fighter-crit":
      add(["Blade of The Ruined King", "Immortal Shieldbow"], "primary", "An opener for a crit-scaling fighter: on-hit damage or a lifeline shield before the crit core.", first, context.coreTiming);
      add(["Infinity Edge"], "primary", "The kit scales with critical strikes: Infinity Edge multiplies it.", "Second item once the opener is done.");
      add(["Death's Dance"], "primary", "Durability for a melee carry that has to stay in fights.", "Take it earlier into physical burst.");
      add(["Guardian Angel"], "defensive", "A late safety net when one death loses the fight.", "Prioritize when you hold a shutdown or are your team's main damage.", "late-game");
      return;
    case "fighter":
      add(["Sundered Sky", "Trinity Force", "Black Cleaver"], "primary", "A bruiser opener: damage, health and sustain for extended fights.", first, context.coreTiming);
      add(["Sterak's Gage"], "primary", "A lifeline shield and damage for a fighter that dives into the enemy team.", "Second item when you are the one starting fights.");
      add(["Death's Dance"], "primary", "Turns burst into damage over time so you survive long enough to fight back.", "Earlier into physical burst.");
      add(["Spirit Visage", "Maw of Malmortius"], "situational", "Magic resist that keeps a bruiser in the fight (Spirit Visage boosts your own healing).", "Choose it when magic damage is what stops you.");
      add(["Guardian Angel"], "defensive", "A late safety net when protecting your life matters most.", "Prioritize when you hold a shutdown or are the team's main damage source.", "late-game");
      return;
    case "assassin-ad":
      add(["Profane Hydra", "Youmuu's Ghostblade", "Hubris"], "primary", "A lethality opener: burst a squishy target before they can answer.", first, context.coreTiming);
      add(["Hubris", "Axiom Arc", "Youmuu's Ghostblade"], "primary", "More lethality that snowballs with takedowns.", "Second item while you are ahead.");
      add(["Serylda's Grudge", "Axiom Arc"], "primary", "Armor penetration so your burst still kills once they buy armor.", "Third item, earlier into armor.");
      add(["Edge of Night", "Guardian Angel"], "defensive", "A spell shield or a revive for an assassin who has to go in.", "Edge of Night when one ability stops your engage.", "late-game");
      return;
    case "assassin-ap":
      add(["Luden's Echo", "Luden's Companion", "Stormsurge", "Lich Bane"], "primary", "An AP burst opener.", first, context.coreTiming);
      add(["Shadowflame"], "primary", "Burst that finishes low-health targets.", "Second item when you are looking for picks.");
      add(["Rabadon's Deathcap"], "primary", "Raw AP once the core is done.", "Take it when ahead and not forced into defense.");
      add(["Zhonya's Hourglass", "Banshee's Veil"], "defensive", "Survive the retaliation after your burst.", "Zhonya's into physical divers, Banshee's into catch abilities.", "late-game");
      add(["Void Staff", "Cryptbloom"], "situational", "Magic penetration so the burst still lands into magic resist.", "Move it earlier when MR appears.");
      return;
    case "mage-battle":
      add(data.onHit ? ["Nashor's Tooth", "Riftmaker"] : ["Liandry's Torment", "Riftmaker", "Rylai's Crystal Scepter"], "primary",
        data.onHit ? "An AP on-hit opener for a kit that attacks a lot." : "A sustained-damage AP opener for a kit that stays in fights.", first, context.coreTiming);
      add(data.onHit ? ["Riftmaker", "Lich Bane"] : ["Rylai's Crystal Scepter", "Riftmaker"], "primary", "More sustained AP damage for extended fights.", "Second item.");
      add(["Rabadon's Deathcap"], "primary", "Raw AP once the core is done.", "Prefer when ahead and not forced into defense.");
      add(["Zhonya's Hourglass", "Banshee's Veil"], "defensive", "Survive the enemy's engage while your damage keeps ticking.", "Match it to the threat that is actually reaching you.", "late-game");
      add(["Void Staff", "Cryptbloom"], "situational", "Magic penetration prevents magic resist from blanking your damage.", "Move it earlier when meaningful MR appears.");
      return;
    case "mage-burst":
      add(poke ? ["Horizon Focus", "Luden's Echo", "Luden's Companion"] : ["Luden's Echo", "Luden's Companion", "Malignance"], "primary",
        poke ? "A long-range AP opener: the kit's damaging abilities reach far enough to use it." : "A reliable AP damage opener when no urgent counter-buy is visible.", first, context.coreTiming);
      add(["Shadowflame", "Malignance"], "primary", "More burst for finishing targets.", "Second item while you are surviving fights.");
      add(["Rabadon's Deathcap"], "primary", "High raw AP payoff after the core build is established.", "Prefer when ahead and not forced into defense or penetration.");
      add(["Zhonya's Hourglass", "Banshee's Veil"], "defensive", "Keeps an AP carry alive through the enemy's most dangerous engage.", "Match the defensive item to the threat that is actually reaching you.", "late-game");
      add(context.supportGold ? ["Cryptbloom", "Void Staff"] : ["Void Staff", "Cryptbloom"], "situational", "Late-game penetration prevents magic resistance from blanking your damage.", "Move it earlier when meaningful MR appears.");
      return;
    case "tank":
      add(["Heartsteel", "Sunfire Aegis", "Hollow Radiance"], "primary", "A tank opener: health and damage from being in the middle of fights.", first, context.coreTiming);
      add(["Jak'Sho, The Protean"], "primary", "A broad durability option when enemy damage is mixed.", "Use a more specialized defense when one damage type clearly dominates.");
      add(["Kaenic Rookern", "Force of Nature"], "defensive", "Strong protection into repeated magic burst or poke.", "Prioritize when the dangerous enemies are magic-heavy.", "late-game");
      add(["Thornmail", "Randuin's Omen"], "situational", "Armor (with anti-heal or crit reduction) into attack-based carries.", "Choose it when their attackers are the threat.");
      return;
    case "engage-support":
      add(["Locket of the Iron Solari", "Knight's Vow"], "primary", "A team-protecting item for a support who starts fights.", first, context.coreTiming);
      add(["Zeke's Convergence", "Knight's Vow"], "primary", "Engage support utility that pays off around your ultimate.", "Second item.");
      add(["Kaenic Rookern", "Randuin's Omen"], "defensive", "Durability against the damage type that is actually hitting you.", "Pick the resist that matches their carries.", "late-game");
      add(["Thornmail"], "situational", "Armor plus anti-heal into attack-based sustain.", "Choose only when both armor and healing reduction matter.");
      return;
    case "enchanter":
      add(["Moonstone Renewer", "Echoes of Helia"], "primary", "Reliable teamfight amplification for a kit that heals or shields allies.", first, context.coreTiming);
      add(["Ardent Censer", "Staff of Flowing Water"], "primary", "Empowers the ally you heal or shield.", "Second item when you have a carry to enable.");
      add(["Redemption"], "situational", "Adds a long-range teamfight swing and team sustain.", "Choose when fights are grouped and predictable.");
      add(["Mikael's Blessing"], "defensive", "Protects a carry from a fight-deciding crowd-control effect.", "Buy when one cleansable disable is repeatedly deciding fights.", "late-game");
      return;
    default:
      add(["Guardian Angel"], "defensive", "A safe late-fight option when protecting your life matters most.", "Prioritize when you hold a shutdown or are the team's main damage source.", "late-game");
      add(["Bloodthirster"], "situational", "Sustain helps recover from poke before objectives and repeated fights.", "Choose when attrition, not burst, is pushing you out.");
      add(["Blade of The Ruined King"], "primary", "A broadly useful sustained-damage option into durable targets.", "Choose when repeated attacks are central to your champion's fights.");
  }
}

function buildRecommendations(
  active: LiveGameSnapshot["activePlayer"],
  enemies: LivePlayer[],
  catalog: Catalog,
  gameTime: number,
  index: ChampionIndex | null,
  brief: PlayerBrief | null,
  sold: Set<number> = new Set(),
  profile: EnemyProfile | null = null,
): { recommendations: LiveRecommendation[]; plan: BuildPlan; scaling: ChampionScaling; counterPicks: NonNullable<LiveGameSnapshot["counterPicks"]> } {
  // New on this champion (lib/player-profile.ts, < NEW_CHAMPION_GAMES complete games): the history was built while
  // learning and never shapes the build; pinned > imported > top build > defaults.
  if (brief?.newOnChampion && brief.usualBuild) brief = { ...brief, usualBuild: null, usualBuildGames: 0 };
  const owned = new Set(active.items.map((item) => key(item.name)));
  // Counter-build signals come from the enemies' estimated stats (lib/enemy-stats.ts). Without Data Dragon stats only the
  // trait-based burst check below remains.
  const biggestThreat = enemies[0];
  const burstEnemy = profile
    ? enemies.find((enemy) => enemy.champion === profile.burstThreat.threats[0]) || null
    : biggestThreat && traits(biggestThreat.champion, index).diver ? biggestThreat : null;
  // Everything about the champion comes from its traits (lib/champion-traits.ts: Riot's roles, damage type, ratings and
  // ability text), never from its name.
  const self = traits(active.champion, index);
  const isMarksman = self.marksman;
  const isTank = self.tank;
  const isEnchanter = self.enchanter || active.position === "UTILITY" && !self.magic;
  const ownedCompleted = active.items.map((item) => catalog.byId.get(item.id)).filter((item): item is CatalogItem => Boolean(item && isCompletedItem(item)));
  // Top build for this champion/role (lib/meta-builds.ts: researched for this patch > curated > older research; another
  // role's build when the player's role has none): outranks history, below pinned/imported builds. In-memory; never reads disk.
  const metaEntry = metaBuildFor(active.champion, active.position, catalog.fallback ? null : catalog.version);
  const metaCore = (metaEntry?.slots || []).filter((slot) => slot.kind === "core").flatMap((slot) => slot.options.filter((option) => !option.when))
    .map((option) => catalogChoice(catalog, [option.item])).filter((item): item is CatalogItem => Boolean(item));
  // What the champion's damage scales with: items that do not fit it never become a path step or a card (unless the
  // player owns, pinned or marked them preferred).
  const scaling = championScaling(active.champion, index, active.items, catalog, { core: metaCore });
  const fits = (item: CatalogItem) => itemFitsScaling(item, scaling);
  const fitsName = (name: string) => { const item = catalogChoice(catalog, [name]); return !item || fits(item); };
  // An AD champion is never in AP mode because of one AP item (Zhonya's on Zed). Item scaling comes from Data Dragon stats.
  const apBuild = scaling !== "ad" && (self.magic || (scaling === "ap" && !isEnchanter) || ownedCompleted.some((item) => item.scaling === "ap"));
  const critBuild = ownedCompleted.some((item) => (item.tags || []).includes("CriticalStrike") && item.scaling !== "ap");
  // Counter cards pick by class: AD (crit users, other fighters/assassins), AP, tank. A hybrid champion with no committed
  // build leans the way its top build (else Data Dragon's attack/magic rating) does.
  const hybridLean = (): "ad" | "ap" => {
    const ap = metaCore.filter((item) => item.scaling === "ap").length;
    const ad = metaCore.filter((item) => item.scaling === "ad").length;
    if (ap !== ad) return ap > ad ? "ap" : "ad";
    const info = championEntry(index, active.champion)?.info;
    return info && info.magic > info.attack ? "ap" : "ad";
  };
  const dmg: "ad" | "ap" | "tank" = scaling === "tank" ? "tank" : apBuild || scaling === "ap" ? "ap" : scaling === "ad" ? "ad" : hybridLean();
  // Crit users: marksmen, a crit build in the inventory or top build, and kits that scale with crit (Riot ability text).
  const critUser = isMarksman || critBuild || self.data.critScaling || metaCore.some((item) => (item.tags || []).includes("CriticalStrike"));
  const lethalityAssassin = !critUser && self.cls === "assassin-ad";
  // A mage played as support buys the cheaper penetration first (support gold).
  const supportMage = active.position === "UTILITY" && self.magic;
  const hasCompletedItem = active.items.some((item) => (catalog.byId.get(item.id)?.cost || 0) >= 2200 && !/boots/i.test(item.name));
  const coreTiming: LiveRecommendation["timing"] = hasCompletedItem ? "mid-game" : "first-item";
  type Choice = {
    names: string[];
    priority: LiveRecommendation["priority"];
    timing: LiveRecommendation["timing"];
    reason: string;
    trigger: string;
    /** Driven by the enemy comp/inventory rather than the default path. */
    threat?: boolean;
    /** The enemy signal a threat choice answers (lib/enemy-stats.ts counterLevel decides how hard the engine acts on it). */
    signal?: CounterSignal;
  };
  const choices: Choice[] = [];
  const realInventory = active.items.filter(inSlot);
  const fullInventory = realInventory.length >= 6;
  let threatMode = false;
  let threatSignal: CounterSignal | undefined;

  const add = (names: string[], priority: LiveRecommendation["priority"], reason: string, trigger: string, timing: LiveRecommendation["timing"] = "mid-game") => {
    choices.push({ names, priority, reason, trigger, timing, threat: threatMode, ...(threatMode && threatSignal ? { signal: threatSignal } : {}) });
  };
  const threat = (signal: CounterSignal) => { threatSignal = signal; return add; };

  // Threat cards are labelled deviations; each reason cites the estimated numbers that triggered it.
  threatMode = true;
  // Which resists the player's damage runs into: armor for physical, magic resist for magic. A hybrid champion's split comes
  // from its own AD vs AP right now (items included); both count once each is at least THREAT_THRESHOLDS.resistAlert.damageShare.
  const physicalPart = scaling === "hybrid"
    ? (() => { const ad = num(active.stats?.attackDamage); const ap = num(active.stats?.abilityPower); return ad + ap > 0 ? ad / (ad + ap) : dmg === "ad" ? 1 : 0; })()
    : dmg === "ad" ? 1 : dmg === "ap" ? 0 : null;
  const share = THREAT_THRESHOLDS.resistAlert.damageShare;
  const physicalDealer = (dmg === "ad" || (physicalPart !== null && physicalPart >= share)) && !isEnchanter;
  const magicDealer = apBuild || supportMage || (physicalPart !== null && scaling === "hybrid" && 1 - physicalPart >= share);
  const adMarksman = dmg === "ad" && isMarksman;
  // The engine's counter items per resist (class-informed order); a top-build option answering the same signal is tried
  // first and Data Dragon's penetration tags close the list (lib/live-game.ts pickCounter).
  const armorNames = isMarksman ? (critBuild ? ["Lord Dominik's Regards", "Terminus"] : ["Terminus", "Lord Dominik's Regards"])
    : critUser ? ["Lord Dominik's Regards", "Serylda's Grudge"] : ["Serylda's Grudge", "Black Cleaver"];
  const mrNames = supportMage ? ["Cryptbloom", "Void Staff"] : ["Void Staff", "Cryptbloom"];
  if (burstEnemy) {
    const physical = burstEnemy.damageProfile === "physical";
    const burst = profile?.burstThreat;
    const defense = dmg === "ap" ? (physical ? ["Zhonya's Hourglass"] : ["Banshee's Veil", "Zhonya's Hourglass"])
      : dmg === "tank" ? (physical ? ["Randuin's Omen", "Thornmail"] : ["Kaenic Rookern", "Force of Nature"])
      : adMarksman ? [physical ? "Guardian Angel" : "Wit's End"]
      // AD fighters/assassins: Death's Dance / GA into physical burst, Maw (or Edge of Night for lethality assassins) into magic.
      : physical ? ["Death's Dance", "Guardian Angel"] : lethalityAssassin ? ["Edge of Night", "Maw of Malmortius"] : ["Maw of Malmortius", "Wit's End"];
    threat("burstThreat")(
      defense,
      "defensive",
      burst ? `${burst.level === "heavy" ? "Fed burst threat" : "Burst threat"}: ${burst.reasons[0]} (estimated).` : `${burstEnemy.champion} is the leading inferred threat and can reach you.`,
      physical ? "Prioritize if their engage is repeatedly killing you." : "Choose the defense that answers their most important engage spell.",
      "late-game",
    );
  }
  // Card gating and "heavy" come from counterLevel (lib/enemy-stats.ts), the same decision the post-game review uses.
  const mrLevel = counterLevel(profile, "mrStack");
  if (profile && mrLevel && magicDealer) {
    threat("mrStack")(
      mrNames,
      mrLevel === "act" ? "primary" : "situational",
      `${profile.mrStack.reasons[0]} (estimated) → magic penetration earlier.`,
      mrLevel === "act" ? "Their MR is stacking: build penetration before another pure damage item." : "Move it up only if your spells stop chunking them.",
    );
  }
  const armorLevel = counterLevel(profile, "armorStack");
  if (profile && armorLevel && physicalDealer) {
    threat("armorStack")(
      armorNames,
      armorLevel === "act" ? "primary" : "situational",
      `${profile.armorStack.reasons[0]} (estimated) → armor penetration earlier.`,
      armorLevel === "act" ? "Their armor is stacking: armor penetration before another pure damage item." : "Move it up when your attacks stop hurting their frontline.",
    );
  }
  // A tank only answers HP stacking when it builds AP (Liandry's); otherwise its job is not out-damaging their HP.
  const hpAnswer = dmg === "ap" || (dmg === "tank" && apBuild) ? ["Liandry's Torment"]
    : dmg === "tank" ? []
    : adMarksman ? ["Blade of The Ruined King", "Terminus"]
    : critUser ? ["Blade of The Ruined King", "Lord Dominik's Regards"]
    : lethalityAssassin ? ["Serylda's Grudge", "Black Cleaver"] : ["Black Cleaver", "Blade of The Ruined King"];
  if (profile && counterLevel(profile, "hpStack") && hpAnswer.length) {
    threat("hpStack")(hpAnswer, "situational",
      `${profile.hpStack.reasons[0]} (estimated) → ${dmg === "ap" || dmg === "tank" ? "%-health damage" : "%-health or armor-shred damage"} for long fights.`, "Best when fights last long enough to apply repeated damage.");
  }
  const healLevel = counterLevel(profile, "healing");
  if (profile && healLevel) {
    const heavy = healLevel === "act";
    // AD: Executioner's Calling is the cheap first step; it builds into Mortal Reminder (crit) or Chempunk Chainsword.
    // Chempunk is outside the Last Whisper group, so it stays buyable when Lord Dominik's locks Mortal Reminder out.
    const antiHeal = dmg === "tank" ? ["Thornmail"] : dmg === "ap" ? ["Oblivion Orb", "Morellonomicon"]
      : adMarksman ? ["Mortal Reminder"] : critUser ? ["Mortal Reminder", "Chempunk Chainsword"] : ["Chempunk Chainsword", "Mortal Reminder"];
    threat("healing")(antiHeal, "situational",
      `${heavy ? "Heavy" : "Some"} healing: ${profile.healing.reasons[0]}${heavy ? " → anti-heal is worth it." : "."}`,
      heavy ? "Healing is heavy: anti-heal pays off in every fight now." : "Buy anti-heal only once healing is deciding fights.");
  }
  if (profile && counterLevel(profile, "hardCc") === "act") {
    threat("hardCc")(dmg === "ad" ? ["Mercurial Scimitar"] : ["Quicksilver Sash"], "defensive",
      `${profile.hardCc.reasons[0]} → a cleanse can save you in fights.`, "Worth it when one lockdown spell keeps deciding who dies.", "late-game");
  }
  threatMode = false;
  // Threat choices in COUNTER_PRIORITY order: the order their cards are pushed and heavy counters claim path slots (and
  // with them exclusive item groups). The post-game review breaks ties between counters in one group the same way.
  const priorityOf = (choice: Choice) => (choice.signal ? COUNTER_PRIORITY.indexOf(choice.signal) : COUNTER_PRIORITY.length);
  choices.sort((left, right) => Number(!left.threat) - Number(!right.threat) || (left.threat && right.threat ? priorityOf(left) - priorityOf(right) : 0));

  // Class defaults: only the fallback when no researched top build, player build or history exists (and the near-tie
  // breaker / alternatives otherwise). Champion-specific builds come from the web research (lib/meta-builds.ts).
  addClassDefaults(add, defaultClass(self, scaling, apBuild, ownedCompleted), self.data, { critBuild, coreTiming, hasCompletedItem, supportGold: active.position === "UTILITY" });

  // Long-term memory + build path: pinned > imported item set > top build > history > inventory inference > the class defaults above.
  const avoid = new Set((brief?.avoidItems || []).map(key));
  const preferred = new Set((brief?.preferredItems || []).map(key));
  const preferredFirst = (names: string[]) => [...names].sort((left, right) => Number(preferred.has(key(right))) - Number(preferred.has(key(left))));
  const ownedOrAvoided = new Set([...avoid, ...owned]);
  // Names League would refuse right now (an exclusive group the inventory fills: Lord Dominik's Regards while owning
  // Mortal Reminder) never resolve to a card.
  const clashOf = (name: string) => { const item = catalogChoice(catalog, [name]); return item ? groupClash(item, active, catalog) : null; };
  // …and names that do not suit the champion's scaling never do either.
  const buyable = (names: string[]) => names.filter((name) => !clashOf(name) && fitsName(name));
  // A crit-scaling kit (Riot ability text) takes a class default's crit option before an on-hit-only one (Data Dragon tags);
  // counter choices keep their order (the signal decides those).
  const critFirst = (names: string[]) => {
    if (!self.data.critScaling) return names;
    const onHitOnly = (name: string) => { const item = catalogChoice(catalog, [name]); return Boolean(item && isOnHitOnly(item)); };
    return [...names].sort((left, right) => Number(onHitOnly(left)) - Number(onHitOnly(right)));
  };
  const resolveChoice = (choice: Choice) => catalogChoice(catalog, preferredFirst(choice.threat ? buyable(choice.names) : critFirst(buyable(choice.names))), ownedOrAvoided);
  /**
   * The engine's counter item for a threat choice: a top-build option answering the same signal first (item mapping, then
   * the option's condition), then the choice's class-informed names, then (armor / MR) any completed item with that
   * penetration in its Data Dragon stats (percent penetration first).
   * Always fits the champion and is never locked by the inventory; with `planned`, never by a planned path item either.
   */
  const pickCounter = (choice: { names: string[]; signal?: CounterSignal }, planned: number[] | null = null): CatalogItem | null => {
    const signal = choice.signal;
    const research = signal && RESEARCH_COUNTERS.has(signal) && metaEntry
      ? metaEntry.slots.filter((slot) => slot.kind !== "boots").flatMap((slot) => slot.options).filter((option) => optionSignal(option) === signal).map((option) => option.item)
      : [];
    const tagged = signal ? [...catalog.byId.values()].filter((item) => isCompletedItem(item) && penetrationFor(item, signal) > 0)
      .sort((a, b) => penetrationFor(b, signal) - penetrationFor(a, signal) || a.cost - b.cost || a.id - b.id).map((item) => item.name) : [];
    const free = (name: string) => {
      const item = planned ? catalogChoice(catalog, [name]) : null;
      return !item || !conflict(item.id, ownedCounts(active), planned!.filter((id) => id !== item.id), recipeOf(catalog));
    };
    return catalogChoice(catalog, buyable([...new Set([...research, ...preferredFirst(choice.names), ...tagged])]).filter(free), avoid);
  };
  const defaults: CatalogItem[] = [];
  const writtenReason = new Map<string, Choice>();
  for (const choice of choices) {
    if (choice.threat) continue;
    const item = resolveChoice(choice);
    if (!item) continue;
    if (!writtenReason.has(key(item.name))) writtenReason.set(key(item.name), choice);
    if (choice.priority === "primary" && !defaults.some((entry) => entry.id === item.id)) defaults.push(item);
  }
  const metaLeads = Boolean(metaEntry && !brief?.pinnedBuild?.length && !brief?.importedBuild?.items.length);
  // Inventory inference leans toward the player's own paths, highest-priority source first. Under the top build, the usual
  // build only counts where it names a top-build option (a habit outside it must not steer the in-progress item).
  const hints = new Map<string, number>();
  const usualHints = metaLeads ? (brief?.usualBuild || []).filter((name) => isMetaItem(metaEntry!, name)) : brief?.usualBuild;
  const weighted: Array<[string[] | null | undefined, number]> = [
    [brief?.pinnedBuild, 8000], [brief?.importedBuild?.items, 6000],
    [metaLeads ? metaEntry!.slots.flatMap((slot) => slot.options.filter((option) => !option.when).map((option) => option.item)) : null, 5000],
    [usualHints, 4000], [brief?.preferredItems, 1000],
  ];
  for (const [names, weight] of weighted) {
    for (const name of names || []) {
      const item = findItem(catalog, name);
      if (item) hints.set(key(item.name), Math.max(weight, hints.get(key(item.name)) || 0));
    }
  }
  // Hand-written defaults only break near-ties: primary picks +150, situational/defensive +30.
  const defaultWeights = new Map([...writtenReason.entries()].map(([name, choice]) => [name, choice.priority === "primary" ? 150 : 30]));
  const underway = inferUnderway(active, catalog, self, apBuild, hints, defaultWeights, avoid, fits);
  // Default upgraded boots for the role; threat-based alternatives stay on the boots checkpoint card as deviations.
  // Past the boots thresholds (THREAT_THRESHOLDS.physical bootsMagic / bootsArmor) the defensive pair is the pick.
  const bootsSignal = signalHeavy(profile, "mrBoots") ? "mrBoots" as const : signalHeavy(profile, "armorBoots") ? "armorBoots" as const : null;
  const bootsDefault = catalogChoice(catalog, bootsSignal === "mrBoots" ? ["Mercury's Treads"] : bootsSignal === "armorBoots" ? ["Plated Steelcaps"]
    : isMarksman && !apBuild ? ["Berserker's Greaves"] : apBuild ? ["Sorcerer's Shoes"] : isEnchanter ? ["Ionian Boots of Lucidity"] : ["Plated Steelcaps", "Mercury's Treads"], avoid);
  const plan = resolvePlan(active, catalog, brief, defaults, underway, avoid, sold, bootsDefault, metaEntry ? { entry: metaEntry, profile, fits, critScaling: self.data.critScaling } : null, fits);
  if (bootsSignal && bootsDefault && plan.boots?.id === bootsDefault.id && !plan.counters.has(bootsDefault.id)) plan.counters.set(bootsDefault.id, signalReason(profile!, bootsSignal));
  // Heavy signal beats habit (as in resolveMetaSlots): a heavy armor / MR / healing counter that nothing owned or planned
  // already answers takes the first path slot that is not started yet (no gold in its components once the earlier steps
  // used theirs): the next step when that one is not started, else a later one. Pinned/imported lists are the player's own.
  const heavySignals = choices.flatMap((choice) => choice.threat && choice.signal && counterLevel(profile, choice.signal) === "act" ? [choice.signal] : []);
  if (plan.path.source !== "pinned" && plan.path.source !== "imported") {
    const ownedItems = active.items.map((entry) => catalog.byId.get(entry.id)).filter((entry): entry is CatalogItem => Boolean(entry));
    for (const choice of choices) {
      const signal = choice.signal;
      if (!choice.threat || !signal || !PATH_COUNTERS.has(signal) || counterLevel(profile, signal) !== "act") continue;
      if ([...ownedItems, ...plan.next].some((entry) => answersSignal(entry, signal))) continue;
      const item = pickCounter(choice, plan.next.map((entry) => entry.id));
      if (!item || owned.has(key(item.name)) || sold.has(item.id)) continue;
      insertCounter(plan, item, signalReason(profile!, signal), active, catalog, heavySignals);
    }
  }
  const saleGuard = protectedFromSale(plan, catalog);
  const pathKeys = new Set(plan.path.steps.map((step) => key(step.item)));
  const hasBoots = ownsUpgradedBoots(active, catalog);

  // A threat choice can resolve to a path item; that path card then also carries the threat's reason.
  const threatByItem = new Map<string, Choice>();
  // A counter the inventory has locked out (heavy armor, but Mortal Reminder fills the Last Whisper group): no card for
  // the locked item; the best available buy says why instead.
  const lockedCounters: string[] = [];
  // Counter items whose signal is heavy: they always get a visible card, even with a full inventory (see push).
  const heavyCounters = new Map<number, Choice>();
  // A threat's card item: one that does not share an exclusive group with a planned path item when such an item exists
  // (anti-heal outside the Last Whisper group while Lord Dominik's Regards is on the path), else the plain pick.
  const threatItem = (choice: { names: string[]; signal?: CounterSignal }) => pickCounter(choice, plan.next.map((entry) => entry.id)) || pickCounter(choice);
  for (const choice of choices) {
    if (!choice.threat) continue;
    const item = threatItem(choice);
    if (item && !threatByItem.has(key(item.name))) threatByItem.set(key(item.name), choice);
    if (item && counterLevel(profile, choice.signal || null) === "act" && !heavyCounters.has(item.id)) heavyCounters.set(item.id, choice);
    const locked = choice.names.filter(fitsName).map((name) => ({ name, found: clashOf(name) })).filter((entry) => entry.found);
    if (!item && locked.length && !choice.names.some((name) => owned.has(key(name)))) {
      const names = locked.map((entry) => catalogChoice(catalog, [entry.name])?.name || entry.name);
      lockedCounters.push(`${choice.reason.replace(/\.$/, "")}, but ${names.join(" / ")} ${names.length > 1 ? "are" : "is"} locked: ${clashText(locked[0].found!, catalog)}.`);
    }
  }

  const used = new Set<string>();
  const recommendations: LiveRecommendation[] = [];
  const pathPlanned = plan.next.map((item) => item.id);
  const pinnedKeys = new Set((brief?.pinnedBuild || []).map((name) => key(findItem(catalog, name)?.name || name)));
  const push = (item: CatalogItem, priority: LiveRecommendation["priority"], timing: LiveRecommendation["timing"], reason: string, trigger: string) => {
    const itemKey = key(item.name);
    if (owned.has(itemKey) || used.has(itemKey) || (hasBoots && isUpgradedBootsItem(item))) return;
    if (sold.has(item.id)) return;
    // Never an AP item for an AD champion (or the reverse), unless the player pinned or marked it preferred.
    if (!fits(item) && !pinnedKeys.has(itemKey) && !preferred.has(itemKey)) return;
    // League would refuse it: an exclusive group (one Last Whisper item, one Spellblade item…) is already filled.
    if (groupClash(item, active, catalog)) return;
    // Off-path cards that would lock out a planned path item say so (buying one rules out the other).
    if (!pathPlanned.includes(item.id)) {
      const planClash = conflict(item.id, ownedCounts(active), pathPlanned.filter((id) => id !== item.id), recipeOf(catalog));
      if (planClash && !planClash.owned) {
        const names = planClash.blocking.map((id) => catalog.byId.get(id)?.name || `item ${id}`).join(" / ");
        reason = `${reason} Same ${planClash.label} group as ${names} on your path: you can own only ${planClash.max === 1 ? "one" : planClash.max}.`;
      }
    }
    const needsSale = fullInventory && !freesSlot(item, active, catalog);
    const heavy = heavyCounters.has(item.id);
    let swapPlan = needsSale ? buildSwapPlan(item, active, catalog, gameTime, saleGuard) : null;
    // A heavy counter is never dropped for lack of room: a swap of the cheapest completed item outside the path (any
    // time, not only in the endgame), else "finish X first" (an in-progress path item that frees a slot), else the card
    // names what to sell.
    let room: string | null = null;
    if (needsSale && !swapPlan && heavy) {
      swapPlan = buildSwapPlan(item, active, catalog, gameTime, saleGuard, { anyTime: true });
      if (!swapPlan) room = fullInventoryAdvice(item, plan, active, catalog);
    }
    // A potion or Biscuit holds the slot: using it makes room, nothing needs selling.
    const snack = needsSale && !swapPlan ? active.items.find((entry) => inSlot(entry) && isConsumable(entry, catalog)) : null;
    if (snack) room = `Inventory full: use your ${snack.name} to free a slot, then buy ${item.name}.`;
    if (needsSale && !swapPlan && !room) return;
    used.add(itemKey);
    if (preferred.has(itemKey) && !/preferred/i.test(reason)) reason = `${reason} Matches your preferred items.`;
    const swapPrefix = swapPlan
      ? swapPlan.affordable
        ? `${heavy && !(gameTime >= 28 * 60 || active.level >= 17) ? "Swap" : "Endgame swap"} is affordable: sell ${swapPlan.sellItem} for ${swapPlan.sellValue}g, buy ${item.name}, and keep ${swapPlan.goldAfter}g. `
        : `After selling ${swapPlan.sellItem}, you still need ${swapPlan.goldNeeded}g for ${item.name}. `
      : room ? `${room} ` : "";
    // "Finish X first" keeps it a buy (the slot frees itself); naming a sale keeps it a swap without an endorsed plan.
    const finishFirst = Boolean(room && (room.startsWith("Inventory full: finish") || room.startsWith("Inventory full: use")));
    recommendations.push({
      itemId: item.id,
      item: item.name,
      cost: item.cost,
      description: item.description || itemBlurb(item),
      priority,
      // A full inventory only makes it a swap when a sale is actually needed (buying it may consume an owned component).
      action: needsSale && !finishFirst ? "swap" : "buy",
      timing: needsSale && !finishFirst ? "swap" : timing,
      reason,
      trigger: `${swapPrefix}${trigger}`,
      usageTip: usageTip(active.champion, item),
      nextStep: needsSale ? null : fullInventory ? wholeItemStep(item, active, catalog) : purchaseStep(item, active, catalog),
      swapPlan,
    });
  };
  const why = (item: CatalogItem) => {
    const threat = threatByItem.get(key(item.name));
    const written = plan.path.source === "default" || plan.path.source === "inventory" || plan.path.source === "meta" || plan.continuation.has(item.id) ? writtenReason.get(key(item.name))?.reason : null;
    const option = plan.meta ? metaOption(plan.meta, item.name) : null;
    const fact = option?.pickRate != null
      ? ` ${Math.round(option.pickRate)}% of ${plan.meta!.sample} ${plan.meta!.champion}s build it (patch ${plan.meta!.patch}).`
      : option?.note ? ` Top build: ${option.note}.` : "";
    const counter = plan.counters.get(item.id);
    const note = plan.notes.get(item.id);
    const instead = plan.started.get(item.id);
    const honest = instead ? `You started ${item.name}; finishing it saves gold, but ${instead} is the stronger pick here. ` : "";
    return `${honest}${counter ? `Chosen over the usual pick because ${counter} (estimated). ` : ""}${note ? `${note}. ` : ""}${written || itemBlurb(item)}${fact}${threat && !counter ? ` It also answers the current threat: ${threat.reason}` : ""}`;
  };

  // 1-2: the next steps of the build path.
  const [next, after, ...rest] = plan.next;
  if (next) {
    const invested = investedValue(next, active, catalog);
    const done = plan.continuation.has(next.id) ? `You have completed ${plan.phrase}. ` : "";
    const lead = underway?.item.id === next.id && plan.path.source === "meta" && !done
      ? `Next in ${plan.phrase}; you already own ${underway.via?.name || "components"} toward it (${underway.invested}g invested).`
      : underway?.item.id === next.id && (plan.path.source === "inventory" || done)
        ? `${done}You already own ${underway.via?.name || "components"} toward ${next.name} (${underway.invested}g invested); finishing it keeps that gold working.`
        : done ? `${done}Continuing with the default path.` : `Next in ${plan.phrase}.`;
    push(next, "primary", coreTiming, `${lead} ${why(next)}`, invested > 0
      ? `You already hold ${invested}g of its components; the buy-now line shows the next recipe piece.`
      : "Stay on this path unless a labelled deviation below answers a real threat.");
  }
  // A threat choice's card: on the path (a heavy counter took a slot) it reads as a path step with the numbers; off the
  // path it is a labelled deviation.
  const pushThreat = (choice: Choice) => {
    const item = threatItem(choice);
    if (!item) return;
    const onPath = plan.next.some((entry) => entry.id === item.id);
    if (onPath && plan.counters.has(item.id)) {
      push(item, "primary", "mid-game", `Counter-buy in ${plan.phrase}: ${why(item)}`, choice.trigger);
      return;
    }
    push(item, choice.priority === "defensive" ? "defensive" : "situational", choice.timing,
      onPath ? `Deviation (move it earlier in ${plan.phrase}): ${choice.reason}` : `Deviation from ${plan.phrase}: ${choice.reason}`,
      choice.trigger);
  };
  // Right after the next step, so they land in the top three: every heavy counter, and an armor / MR counter at "some" while
  // the next path step is not started yet (it can still be swapped for the counter at no cost; the path itself only changes
  // at heavy, the same bar the post-game review uses).
  const nextStarted = next ? investedValue(next, active, catalog) > 0 : true;
  const early = new Set<Choice>();
  for (const choice of choices) {
    if (!choice.threat || !choice.signal) continue;
    const level = counterLevel(profile, choice.signal);
    if (level === "act" || (level === "consider" && !nextStarted && (choice.signal === "armorStack" || choice.signal === "mrStack"))) {
      early.add(choice);
      pushThreat(choice);
    }
  }
  if (next && after) push(after, "primary", "mid-game", `After ${next.name}${plan.continuation.has(after.id) ? "" : ` in ${plan.phrase}`}. ${why(after)}`, `Complete ${next.name} first.`);

  // An in-progress recipe that is not on the path: never silently waste invested gold. With a researched top build, only
  // when that item is one of its options; without one, when the player's own builds or the class defaults name it, or at
  // least half of it is already paid for (a shared component alone, like a B. F. Sword, is not a commitment to any one item).
  const underwayKey = underway ? key(underway.item.name) : "";
  const underwayFits = underway && (metaEntry ? isMetaItem(metaEntry, underway.item.name)
    : hints.has(underwayKey) || defaultWeights.has(underwayKey) || underway.invested * 2 >= underway.item.cost);
  if (underway && underwayFits && !pathKeys.has(underwayKey) && !(next && investedValue(next, active, catalog) >= underway.invested)) {
    push(underway.item, "situational", "mid-game",
      `Deviation from ${plan.phrase}: you already own ${underway.via?.name || "components"} toward ${underway.item.name} (${underway.invested}g invested).${next ? ` ${next.name} stays the path item.` : ""}`,
      "Finish it only if the path item's recipe would leave that gold idle for several recalls.");
  }

  // Threat/counter logic: situational or defensive deviations.
  for (const choice of choices) if (choice.threat && !early.has(choice)) pushThreat(choice);

  for (const item of rest) push(item, "primary", "mid-game", `${plan.continuation.has(item.id) ? "Later on the default path." : `Later in ${plan.phrase}.`} ${why(item)}`, "Finish the earlier path items first.");

  if (metaEntry) {
    // A researched top build exists: alternatives are its own options (any slot, in slot order). A conditional option shows
    // only while its enemy signal is at least at card level; an option whose condition Rift Lens cannot read stays a
    // labelled alternative. No class-default filler.
    for (const slot of metaEntry.slots) {
      if (slot.kind === "boots") continue;
      for (const option of slot.options) {
        const item = catalogChoice(catalog, [option.item]);
        if (!item || avoid.has(key(item.name))) continue;
        const signal = optionSignal(option);
        if (option.when && signal && !counterLevel(profile, signal)) continue;
        const condition = option.when ? option.condition || (option.when === "healing" ? "vs heavy healing" : option.when === "heavy-poke" ? "vs heavy poke" : "situational") : "";
        push(item, "situational", "late-game", `Top-build alternative (${slot.label}${condition ? `, ${condition}` : ""}): ${why(item)}`,
          condition ? `Take it ${condition.replace(/^situational$/, "when the game calls for it")}.` : "Swap it in for a later path item when it suits this game better.");
      }
    }
  } else {
    const timingRank: Record<LiveRecommendation["timing"], number> = { "first-item": 0, "mid-game": 1, "late-game": 2, swap: 3 };
    const isPreferred = (choice: Choice) => choice.names.some((name) => preferred.has(key(name)));
    const defaultChoices = choices.filter((choice) => !choice.threat)
      .sort((left, right) => timingRank[left.timing] - timingRank[right.timing] || Number(isPreferred(right)) - Number(isPreferred(left)));
    for (const choice of defaultChoices) {
      const item = resolveChoice(choice);
      if (!item) continue;
      if (plan.path.source === "default") push(item, choice.priority, choice.timing, choice.reason, choice.trigger);
      else push(item, choice.priority === "primary" ? "situational" : choice.priority, choice.timing, `Alternative to ${plan.phrase}: ${choice.reason}`, choice.trigger);
    }
  }
  for (const name of brief?.preferredItems || []) {
    const item = findItem(catalog, name);
    if (item && !avoid.has(key(item.name))) push(item, "situational", "mid-game", `You marked ${item.name} as a preferred item on ${active.champion}.`, "Fit it in when it does not delay a more urgent counter-buy.");
  }

  // The panel must never be empty. These broad class fallbacks are reached only when no researched top build exists (its
  // options cover that case above), or when path, top-build and counter choices left nothing at all.
  const fallbackPool = apBuild
    ? [["Cosmic Drive"], ["Lich Bane"], ["Banshee's Veil"], ["Rabadon's Deathcap"], ["Void Staff"]]
    : isMarksman
      ? [["Wit's End"], ["Guardian Angel"], ["Bloodthirster"], ["Terminus"], ["Lord Dominik's Regards"]]
      : [["Guardian Angel"], ["Bloodthirster"], ["Blade of The Ruined King"]];
  for (const names of metaEntry && recommendations.length ? [] : fallbackPool) {
    if (recommendations.length >= 6) break;
    const item = catalogChoice(catalog, names, avoid);
    if (item) push(item, "situational", "late-game", "Fallback option for the current build when higher-priority counters are already covered.", "Consider after checking whether defense or penetration is more urgent.");
  }
  // The UI shows three at a time, while HELP ME receives the wider branch set
  // so a player question can justify a coherent deviation without inventing items.
  // Invariant: the path's "next" step is recommendations[0]. A step that could not become a card (e.g. full inventory and
  // nothing sellable) stays on the path as "later"; the first path step that did become a card leads instead.
  const recIds = new Set(recommendations.map((rec) => rec.itemId));
  const lead = plan.path.steps.find((step) => step.status !== "owned" && step.status !== "skipped" && recIds.has(step.itemId)) || null;
  if (lead) {
    const at = recommendations.findIndex((rec) => rec.itemId === lead.itemId);
    if (at > 0) recommendations.unshift(...recommendations.splice(at, 1));
  }
  for (const step of plan.path.steps) if (step.status !== "owned" && step.status !== "skipped") step.status = step === lead ? "next" : "later";
  // The main view shows a counter-build reason only when an enemy signal changed the next buy.
  const first = recommendations[0];
  if (first && lockedCounters.length) first.reason = `${first.reason} ${lockedCounters.join(" ")}`;
  const counter = first && lead?.itemId === first.itemId ? plan.counters.get(first.itemId) : undefined;
  if (first && counter) first.counterReason = `${counter[0].toUpperCase()}${counter.slice(1)}`;
  // The resists the player's damage runs into, with the engine's own counter pick (read by the resist alerts).
  const counterPicks: NonNullable<LiveGameSnapshot["counterPicks"]> = [];
  const watch: Array<[boolean, "armorStack" | "mrStack", string[]]> = [[physicalDealer, "armorStack", armorNames], [magicDealer, "mrStack", mrNames]];
  for (const [relevant, signal, names] of watch) {
    if (!profile || !relevant) continue;
    // The same pick as the threat card: one that does not clash with a planned path item first (heavy healing put Mortal
    // Reminder on the path, so its armor penetration is the armor answer, not a Lord Dominik's Regards it locks out).
    const item = threatItem({ names, signal });
    const usable = item && !owned.has(key(item.name)) && !sold.has(item.id) ? item : null;
    counterPicks.push({ signal, level: profile[signal].level, itemId: usable?.id ?? null, item: usable?.name ?? null });
  }
  return { recommendations: recommendations.slice(0, 6), plan, scaling, counterPicks };
}

/**
 * Which enemy signal the engine answers first when counters compete (cards, path slots, an exclusive item group such as
 * Last Whisper shared by armor penetration and anti-heal). Exported for the post-game review's tie-break.
 */
export const COUNTER_PRIORITY: readonly CounterSignal[] = ["burstThreat", "mrStack", "armorStack", "hpStack", "healing", "hardCc", "poke", "armorBoots", "mrBoots"];

/** Signals whose top-build options are preferred as the counter item (defensive picks depend on the threat's damage type). */
const RESEARCH_COUNTERS = new Set<CounterSignal>(["armorStack", "mrStack", "healing", "hpStack"]);
/** Signals whose heavy level lets a counter take a path slot (heavy signal beats habit). */
const PATH_COUNTERS = new Set<CounterSignal>(["armorStack", "mrStack", "healing"]);
/** How much an item's own stats answer a resist signal: percent penetration, flat magic penetration at a third (0 = none). */
function penetrationFor(item: CatalogItem, signal: CounterSignal) {
  if (signal === "armorStack") return item.pen?.armorPercent || 0;
  if (signal === "mrStack") return (item.pen?.magicPercent || 0) + (item.pen?.magicFlat || 0) / 3;
  return 0;
}

/** The signal a top-build option answers: the item's own mapping first, then the option's condition (as the review reads it). */
const optionSignal = (option: { item: string; when?: string | null; condition?: string | null }) => counterSignalFor(option.item) ?? counterSignalFor(option.item, option.when, option.condition);

/** True when an item already answers a signal: its counter mapping, or (armor / MR) a completed item with percent penetration. */
function answersSignal(item: CatalogItem, signal: CounterSignal) {
  if (counterSignalFor(item.name) === signal) return true;
  const percent = signal === "armorStack" ? item.pen?.armorPercent : signal === "mrStack" ? item.pen?.magicPercent : 0;
  return Boolean(percent && isCompletedItem(item));
}

/**
 * Puts a heavy counter on the path at the first un-owned, non-boots step that is not started (walking the path in order,
 * each step uses up the owned components it needs, so a component already claimed by an earlier step does not count as a
 * start), else at the end. Keeps the path at 8 steps by dropping its last un-owned non-counter step.
 */
function insertCounter(plan: BuildPlan, item: CatalogItem, reason: string, active: LiveGameSnapshot["activePlayer"], catalog: Catalog, heavySignals: CounterSignal[] = []) {
  const stock = ownedCounts(active);
  // Never ahead of another counter already on the path, nor (top build) ahead of an un-started core item: the top build's
  // own slots already placed the counters it lists; this only finds room for one it could not place.
  const coreNames = new Set((plan.meta?.slots || []).filter((slot) => slot.kind === "core").flatMap((slot) => slot.options.filter((option) => !option.when).map((option) => key(option.item))));
  const keep = (step: CatalogItem) => isUpgradedBootsItem(step) || plan.counters.has(step.id) || coreNames.has(key(step.name))
    || heavySignals.some((signal) => answersSignal(step, signal));
  let at = plan.next.length;
  for (const [index, step] of plan.next.entries()) {
    const invested = consumeOwned(step, stock, catalog).value;
    if (!keep(step) && invested === 0) { at = index; break; }
  }
  // Full inventory and the counter frees no slot itself: the in-progress step whose purchase frees one (two or more held
  // components) comes first, so the path reads "finish X, then the counter" like the card does.
  const full = active.items.filter(inSlot).length >= 6;
  if (full && !freesSlot(item, active, catalog)) {
    const opener = plan.next.findIndex((step) => consumeOwned(step, ownedCounts(active), catalog).slots >= 2);
    if (opener > at) {
      const [moved] = plan.next.splice(opener, 1);
      plan.next.splice(at, 0, moved);
      const movedAt = plan.path.steps.findIndex((entry) => entry.itemId === moved.id);
      const targetAt = plan.path.steps.findIndex((entry) => entry.itemId === plan.next[at + 1]?.id);
      if (movedAt >= 0 && targetAt >= 0) {
        const [movedStep] = plan.path.steps.splice(movedAt, 1);
        plan.path.steps.splice(movedAt < targetAt ? targetAt - 1 : targetAt, 0, movedStep);
      }
      at += 1;
    }
  }
  const before = plan.next[at];
  plan.next.splice(at, 0, item);
  const step: LiveBuildPath["steps"][number] = { itemId: item.id, item: item.name, cost: item.cost, status: "later" };
  const stepAt = before ? plan.path.steps.findIndex((entry) => entry.itemId === before.id) : -1;
  if (stepAt >= 0) plan.path.steps.splice(stepAt, 0, step);
  else plan.path.steps.push(step);
  plan.counters.set(item.id, reason);
  while (plan.path.steps.length > 8) {
    const drop = [...plan.path.steps].reverse().find((entry) => entry.status !== "owned" && entry.status !== "skipped" && !plan.counters.has(entry.itemId));
    if (!drop) break;
    plan.path.steps.splice(plan.path.steps.indexOf(drop), 1);
    const nextAt = plan.next.findIndex((entry) => entry.id === drop.itemId);
    if (nextAt >= 0) plan.next.splice(nextAt, 1);
  }
}

/**
 * What to do when a heavy counter needs a slot and no swap plan exists: "finish X first" when an in-progress path item
 * uses up two or more held components (buying it frees a slot), else the cheapest held item outside the counter's recipe
 * to sell (named, with the path item it was for), else "replace your least useful completed item".
 */
function fullInventoryAdvice(item: CatalogItem, plan: BuildPlan, active: LiveGameSnapshot["activePlayer"], catalog: Catalog) {
  const owned = ownedCounts(active);
  for (const step of plan.next) {
    if (step.id === item.id) continue;
    const stock = new Map(owned);
    if (consumeOwned(step, stock, catalog).slots < 2) continue;
    const parts = [...owned.entries()].filter(([id, count]) => (stock.get(id) || 0) < count).map(([id]) => catalog.byId.get(id)?.name || `item ${id}`);
    return `Inventory full: finish ${step.name} first (it uses your ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]} and frees a slot), then buy ${item.name}.`;
  }
  const targetTree = new Set<number>();
  const walk = (id: number, depth: number) => { for (const child of catalog.byId.get(id)?.from || []) { targetTree.add(child); if (depth < 4) walk(child, depth + 1); } };
  walk(item.id, 0);
  const candidates = active.items
    .filter((entry) => inSlot(entry) && !targetTree.has(entry.id) && !/ward|lens|potion|elixir/i.test(entry.name))
    .map((entry) => ({ entry, info: catalog.byId.get(entry.id) }))
    // An item kept as a counter to this enemy team is never the one to sell for another item.
    .filter(({ info }) => info && !isUpgradedBootsItem(info) && !plan.counters.has(info.id))
    .sort((a, b) => Number(isCompletedItem(a.info!)) - Number(isCompletedItem(b.info!)) || a.info!.cost - b.info!.cost);
  const sell = candidates[0];
  if (!sell) return `Inventory full: replace your least useful completed item with ${item.name}.`;
  const value = sell.info!.sellValue || Math.round(sell.info!.cost * 0.7);
  const forItem = plan.next.find((step) => step.id !== item.id && recipeContains(step, sell.entry.id, catalog));
  return `Inventory full and every slot is on your build path: to fit ${item.name}, sell ${sell.entry.name} (+${value}g)${forItem ? ` instead of finishing ${forItem.name}` : ""}.`;
}

function buildMobilityRecommendation(active: LiveGameSnapshot["activePlayer"], catalog: Catalog, gameTime: number, index: ChampionIndex | null, plan: BuildPlan, sold: Set<number> = new Set(), profile: EnemyProfile | null = null): LiveRecommendation | null {
  const realInventory = active.items.filter(inSlot);
  if (ownsUpgradedBoots(active, catalog)) return null;
  // Boots sold this game were a deliberate slot trade: no boots checkpoint afterwards.
  if (soldUpgradedBoots(sold, catalog)) return null;
  const fullInventory = realInventory.length >= 6;

  const self = traits(active.champion, index);
  const isMarksman = self.marksman;
  const apChampion = self.magic;
  let names: string[];
  let reason: string;
  let trigger: string;
  // Defensive boots only when the estimated damage split is lopsided (THREAT_THRESHOLDS.physical in lib/enemy-stats.ts).
  const share = profile?.physicalShare.share ?? 0.5;

  if (profile && share >= THREAT_THRESHOLDS.physical.bootsArmor) {
    names = ["Plated Steelcaps"];
    reason = `${profile.physicalShare.reasons[0]} (estimated) → armor boots.`;
    trigger = "Take the defensive boot branch when repeated basic attacks or physical all-ins matter more than maximum damage output.";
  } else if (profile && share <= THREAT_THRESHOLDS.physical.bootsMagic) {
    names = ["Mercury's Treads"];
    reason = `~${Math.round((1 - share) * 100)}% of enemy damage looks magic (estimated) → MR boots.`;
    trigger = "Prefer these when magic pressure and reducible crowd control are both stopping you from dealing damage.";
  } else if (isMarksman) {
    names = ["Berserker's Greaves"];
    reason = "The whole enemy team does not currently force a clear defensive boot override, so attack speed and movement support normal marksman spacing.";
    trigger = "Buy or upgrade boots around the first-item path; delay briefly only when the exact gold completes a much stronger item spike.";
  } else if (apChampion) {
    names = ["Sorcerer's Shoes", "Ionian Boots of Lucidity"];
    reason = "No single defensive boot override is established, so an offensive AP boot path remains reasonable.";
    trigger = "Switch to defensive boots when the whole-team threat scan shows survival or crowd control is the real limit.";
  } else {
    names = ["Ionian Boots of Lucidity", "Plated Steelcaps", "Mercury's Treads"];
    reason = "A general movement and haste upgrade is useful while no stronger defensive override is established.";
    trigger = "Choose the defensive branch if the enemy team's dominant threat profile becomes clear.";
  }

  // A "some" lean (THREAT_THRESHOLDS.physical bootsMagicAlt / bootsArmorAlt) names the defensive boots as the card's
  // alternative with the numbers; only past bootsMagic / bootsArmor do they become the pick.
  const t = THREAT_THRESHOLDS.physical;
  const alternative = !profile ? null
    : share <= t.bootsMagicAlt ? { name: "Mercury's Treads", text: `~${Math.round((1 - share) * 100)}% of enemy damage looks magic (estimated)`, when: "magic damage or crowd control keeps killing you" }
    : share >= t.bootsArmorAlt ? { name: "Plated Steelcaps", text: `${profile.physicalShare.reasons[0]} (estimated)`, when: "basic attacks keep killing you" }
    : null;
  // Boots named by the player's path (pinned/imported set) drive the checkpoint; a threat override becomes a labelled deviation.
  const engineBoots = catalogChoice(catalog, names);
  let item = engineBoots;
  if (plan.boots) {
    const override = engineBoots && engineBoots.id !== plan.boots.id && /Steelcaps|Mercury/.test(engineBoots.name) ? engineBoots : null;
    const threatReason = reason;
    item = plan.boots;
    names = [plan.boots.name];
    const counter = plan.counters.get(plan.boots.id);
    reason = `Boots from ${plan.phrase} (${plan.path.label}).${counter ? ` Chosen because ${counter} (estimated).` : ""}`;
    trigger = override
      ? `Deviation to consider: ${override.name}. ${threatReason}`
      : "Buy or upgrade them around the path's first completed item; delay briefly only when the exact gold finishes a bigger spike.";
    // Conditional boots in the top build (e.g. Gluttonous Greaves vs heavy poke) stay a named alternative.
    const alternatives = (plan.meta?.slots.find((slot) => slot.kind === "boots")?.options || [])
      .filter((option) => option.when && key(option.item) !== key(plan.boots!.name) && key(option.item) !== key(alternative?.name))
      // Not armor boots into a magic-leaning team (or MR boots into a physical one).
      .filter((option) => {
        const signal = counterSignalFor(option.item, option.when, option.condition);
        return !profile || !((signal === "armorBoots" && share <= t.bootsMagicAlt) || (signal === "mrBoots" && share >= t.bootsArmorAlt));
      })
      .map((option) => `${option.item} ${option.when === "heavy-poke" ? "into heavy poke" : option.when === "healing" ? "into heavy healing" : option.condition || "situational"}${option.note ? ` (${option.note})` : ""}`);
    if (alternatives.length) trigger = `${trigger} Top-build alternative: ${alternatives.join("; ")}.`;
  }
  const alternativeItem = alternative ? catalogChoice(catalog, [alternative.name]) : null;
  if (item && alternative && alternativeItem && alternativeItem.id !== item.id && !trigger.includes(`Deviation to consider: ${alternativeItem.name}`)) {
    trigger = `${trigger} Alternative: ${alternativeItem.name}: ${alternative.text}; take them instead if ${alternative.when}.`;
  }
  if (!item || groupClash(item, active, catalog)) return null;
  const hasCompletedItem = realInventory.some((ownedItem) => (catalog.byId.get(ownedItem.id)?.cost || 0) >= 2200 && !/boots/i.test(ownedItem.name));
  const needsSale = fullInventory && !freesSlot(item, active, catalog);
  const swapPlan = needsSale ? buildSwapPlan(item, active, catalog, gameTime, protectedFromSale(plan, catalog)) : null;
  if (needsSale && !swapPlan) return null;
  const inventoryPrefix = swapPlan
    ? swapPlan.affordable
      ? `Affordable endgame swap: sell ${swapPlan.sellItem} for ${swapPlan.sellValue}g, buy ${item.name}, and keep ${swapPlan.goldAfter}g. `
      : `After selling ${swapPlan.sellItem}, save ${swapPlan.goldNeeded}g more before buying ${item.name}. `
    : "";
  return {
    itemId: item.id,
    item: item.name,
    cost: item.cost,
    description: item.description || "",
    priority: plan.boots || names[0] === "Berserker's Greaves" || names[0] === "Sorcerer's Shoes" ? "primary" : "defensive",
    action: needsSale ? "swap" : "buy",
    timing: needsSale ? "swap" : hasCompletedItem ? "mid-game" : "first-item",
    reason,
    trigger: `${inventoryPrefix}${trigger}`,
    usageTip: item.name === "Berserker's Greaves"
      ? "Use the movement speed to hold maximum attack range; the attack speed only matters while you keep firing safely."
      : item.name === "Plated Steelcaps"
        ? "These reduce attack pressure, but they do not replace positioning against abilities."
        : item.name === "Mercury's Treads"
          ? "Tenacity shortens many disables, but it does not help against knock-ups or suppression."
          : "Use the movement upgrade to reach safer angles before the fight starts.",
    nextStep: needsSale ? null : fullInventory ? wholeItemStep(item, active, catalog) : purchaseStep(item, active, catalog),
    swapPlan,
  };
}

function inferActivePosition(active: RawPlayer, allies: RawPlayer[], index: ChampionIndex | null) {
  const reported = (active.position || "").toUpperCase();
  if (STANDARD_POSITIONS.includes(reported)) {
    return { position: reported, basis: "riot-position" as const, note: "Matched using Riot's reported position." };
  }

  const occupied = new Set(allies.map((ally) => (ally.position || "").toUpperCase()).filter((position) => STANDARD_POSITIONS.includes(position)));
  const missing = STANDARD_POSITIONS.filter((position) => !occupied.has(position));
  if (missing.length === 1) {
    return { position: missing[0], basis: "team-gap" as const, note: `Riot reported your role as ${reported || "NONE"}; inferred ${missing[0]} because it is the missing role on your team.` };
  }

  const self = traits(active.championName || "", index);
  if (self.marksman) {
    return { position: "BOTTOM", basis: "champion-role" as const, note: "Riot did not report a role; inferred BOTTOM from the champion's usual role." };
  }
  if (self.magic && !self.enchanter) {
    return { position: "MIDDLE", basis: "champion-role" as const, note: "Riot did not report a role; inferred MIDDLE from the champion's usual role." };
  }
  if (self.enchanter) {
    return { position: "UTILITY", basis: "champion-role" as const, note: "Riot did not report a role; inferred UTILITY from the champion's usual role." };
  }
  return { position: reported || "UNKNOWN", basis: "highest-threat" as const, note: "No reliable lane role was available, so this card shows the highest-ranked enemy threat." };
}

function modeLabel(raw: RawLiveData["gameData"]) {
  const mode = (raw?.gameMode || "UNKNOWN").toUpperCase();
  const map = raw?.mapName || "Unknown map";
  if (mode.includes("ARAM") || map.toLowerCase().includes("howling")) return "ARAM";
  if (mode.includes("SWIFT")) return "Swiftplay";
  if (mode.includes("CHERRY") || mode.includes("ARENA")) return "Arena";
  if (mode === "CLASSIC" && map.toLowerCase().includes("summoner")) return "Summoner's Rift · exact queue unknown";
  return mode.replaceAll("_", " ");
}

function gamePhase(seconds: number, ruleset: Ruleset): LiveGameSnapshot["game"]["phase"] {
  // Swiftplay starts at level 3, Baron is up at 12:00, Elder at 15:00 and Sudden Death at 25:00.
  const [opening, early, mid] = ruleset === "swiftplay" ? [240, 600, 1080] : [360, 840, 1500];
  if (seconds < opening) return "opening";
  if (seconds < early) return "early";
  if (seconds < mid) return "mid";
  return "late";
}

function eventNameMatches(name: string | undefined, player: LivePlayer) {
  return sameName(name, player.name) || sameName(name, player.riotId) || sameName(name, player.name.split("#")[0]);
}

function deathSources(events: RawEvent[], active: LivePlayer, enemies: LivePlayer[]): LiveDeathSource[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.EventName !== "ChampionKill" || !eventNameMatches(event.VictimName, active)) continue;
    const killer = event.KillerName || "Unknown";
    counts.set(killer, (counts.get(killer) || 0) + 1);
  }
  return [...counts.entries()].map(([playerName, deathsTo]) => {
    const enemy = enemies.find((candidate) => eventNameMatches(playerName, candidate));
    return { champion: enemy?.champion || "Unknown", playerName, deathsTo };
  }).sort((a, b) => b.deathsTo - a.deathsTo);
}


type Side = "ally" | "enemy" | null;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function wordMatch(text: string, phrase: string) {
  const norm = (value: string) => ` ${value.toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
  return Boolean(phrase.trim()) && norm(text).includes(norm(phrase));
}

function dragonName(type = "") {
  return DRAGON_NAMES[key(type)] || type || "Unknown";
}

function nonPlayerKiller(name = "") {
  if (/turret|tower/i.test(name)) return "Turret";
  if (/minion/i.test(name)) return "Minions";
  if (/^sru_|monster/i.test(name)) return "Jungle monster";
  return name || "Unknown";
}

function itemGold(player: LivePlayer) {
  return player.items.reduce((sum, item) => sum + item.price * Math.max(1, item.count), 0);
}

function isSummonersRift(gameData: RawLiveData["gameData"]) {
  const mode = (gameData?.gameMode || "").toUpperCase();
  if (/ARAM|CHERRY|ARENA|TUTORIAL/.test(mode)) return false;
  return num(gameData?.mapNumber) === 11 || /map11|summoner/i.test(gameData?.mapName || "");
}

function rulesetFor(gameData: RawLiveData["gameData"]): Ruleset {
  if (!isSummonersRift(gameData)) return null;
  return /SWIFT/i.test(gameData?.gameMode || "") ? "swiftplay" : "sr";
}

function objectiveLabel(event: RawEvent) {
  const type = event.EventName || "";
  if (type === "DragonKill") return /elder/i.test(event.DragonType || "") ? "Elder Dragon" : `${dragonName(event.DragonType)} Dragon`;
  if (type === "BaronKill") return "Baron Nashor";
  if (type === "HeraldKill") return "Rift Herald";
  if (/horde|grub/i.test(type)) return "Void Grub";
  if (/atakhan/i.test(type)) return "Atakhan";
  return null;
}

function objectiveState(events: RawEvent[], time: number, sideOf: (name?: string) => Side, ruleset: Ruleset): { objectives: LiveObjectiveTimer[]; dragonState: LiveDragonState } {
  const swift = ruleset === "swiftplay";
  const soulAt = swift ? SWIFT.maxElemental : 4;
  const dragonKills = events.filter((event) => event.EventName === "DragonKill").map((event) => ({
    time: num(event.EventTime), type: dragonName(event.DragonType), side: sideOf(event.KillerName), elder: /elder/i.test(event.DragonType || ""),
  }));
  const elemental = dragonKills.filter((kill) => !kill.elder);
  const alliedDragons = elemental.filter((kill) => kill.side === "ally").map((kill) => kill.type);
  const enemyDragons = elemental.filter((kill) => kill.side === "enemy").map((kill) => kill.type);
  const counts = { ally: 0, enemy: 0 };
  let soul: { side: "ally" | "enemy"; time: number } | null = null;
  for (const kill of elemental) {
    if (!kill.side) continue;
    counts[kill.side] += 1;
    if (!soul && counts[kill.side] >= soulAt) soul = { side: kill.side, time: kill.time };
  }
  // SR transforms after the 2nd drake (3rd+ share the soul element); Swiftplay after the 1st (only 2 drakes exist).
  const soulType = swift ? elemental[1]?.type || null : elemental.length >= 3 ? elemental[2].type : null;
  const point = soulAt - 1;
  // Swiftplay: once both drakes are down without one team taking both, nobody gets soul.
  const soulPossible = !swift || elemental.length < SWIFT.maxElemental;
  const soulPoint: LiveDragonState["soulPoint"] = soul || !soulPossible
    ? null
    : alliedDragons.length === point && enemyDragons.length === point ? "both" : alliedDragons.length === point ? "ally" : enemyDragons.length === point ? "enemy" : null;
  const dragonState: LiveDragonState = { alliedDragons, enemyDragons, soulPoint, soulType };
  if (!ruleset) return { objectives: [], dragonState };

  const sideText = (side: Side) => side === "ally" ? "your team" : side === "enemy" ? "the enemy" : "an unknown team";
  const timer = (id: LiveObjectiveTimer["id"], label: string, spawnAt: number, respawn: boolean, note: string): LiveObjectiveTimer => time < spawnAt
    ? { id, label, status: respawn ? "respawning" : "not-spawned", nextSpawnAt: spawnAt, note }
    : { id, label, status: "up", nextSpawnAt: null, note };
  const gone = (id: LiveObjectiveTimer["id"], label: string, note: string, status: "taken" | "unknown" = "unknown"): LiveObjectiveTimer => ({ id, label, status, nextSpawnAt: null, note });
  const objectives: LiveObjectiveTimer[] = [];

  const score = `Dragons ${alliedDragons.length}–${enemyDragons.length}.`;
  if (swift) {
    const lastElder = dragonKills.filter((kill) => kill.elder).at(-1);
    const last = elemental.at(-1);
    const nextDrake = elemental.length >= SWIFT.maxElemental ? null : last ? last.time + SWIFT.dragonRespawn : SWIFT.dragon;
    const soulText = soul ? ` ${soul.side === "ally" ? "Your team" : "The enemy"} has ${soulType || "the"} Soul.` : soulPossible ? " Soul needs both drakes." : " Drakes split 1–1: no soul this game.";
    if (nextDrake !== null && nextDrake < SWIFT.elder) {
      objectives.push(timer("dragon", "Dragon", nextDrake, Boolean(last), `${score}${soulText} Swiftplay: max 2 elemental drakes${last ? `; last ${last.type} at ${clock(last.time)}` : "; first drake assumed at 5:00 (unconfirmed)"}. Elder replaces any drake at 15:00.`));
    }
    objectives.push(lastElder
      ? timer("elder", "Elder Dragon", lastElder.time + SWIFT.elderRespawn, true, `Elder taken by ${sideText(lastElder.side)} at ${clock(lastElder.time)}; next one 6:00 later.${soulText}`)
      : timer("elder", "Elder Dragon", SWIFT.elder, false, `Swiftplay: Elder spawns at 15:00 regardless of soul.${soulText}`));
    const baron = events.filter((event) => event.EventName === "BaronKill").at(-1);
    objectives.push(baron
      ? timer("baron", "Baron Nashor", num(baron.EventTime) + SWIFT.baronRespawn, true, `Last taken by ${sideText(sideOf(baron.KillerName))} at ${clock(num(baron.EventTime))}; respawn assumed 6:00 after each kill.`)
      : timer("baron", "Baron Nashor", SWIFT.baron, false, "Swiftplay: Baron spawns at 12:00. Baron buff persists through death."));
    return { objectives, dragonState };
  }
  if (soul) {
    const claimed = soul;
    const lastElder = dragonKills.filter((kill) => kill.elder && kill.time >= claimed.time).at(-1);
    const soulNote = `${claimed.side === "ally" ? "Your team" : "The enemy"} claimed ${soulType || "the"} Soul at ${clock(claimed.time)}.`;
    objectives.push(lastElder
      ? timer("elder", "Elder Dragon", lastElder.time + SR.elderRespawn, true, `${soulNote} Elder last taken by ${sideText(lastElder.side)} at ${clock(lastElder.time)}; respawns 6:00 later.`)
      : timer("elder", "Elder Dragon", claimed.time + SR.elderAfterSoul, false, `${soulNote} Elder spawns 6:00 after the soul.`));
  } else {
    const last = elemental.at(-1);
    objectives.push(last
      ? timer("dragon", "Dragon", last.time + SR.dragonRespawn, true, `${score} Last: ${last.type} by ${sideText(last.side)} at ${clock(last.time)}; respawns 5:00 after each kill.${soulType ? ` Soul element: ${soulType}.` : ""}`)
      : timer("dragon", "Dragon", SR.dragon, false, `${score} First dragon at 5:00.`));
  }

  const grubKills = events.filter((event) => /horde|grub/i.test(event.EventName || ""));
  const grubNote = "Assumed one wave of 3 at 8:00 (2025 timing; verify on your patch).";
  if (grubKills.length >= 3) {
    const ally = grubKills.filter((event) => sideOf(event.KillerName) === "ally").length;
    objectives.push(gone("grubs", "Void Grubs", `All taken (your team ${ally}, enemy ${grubKills.length - ally}); no respawn assumed.`, "taken"));
  } else if (time >= SR.herald) objectives.push(gone("grubs", "Void Grubs", `Likely despawned before Rift Herald. ${grubNote}`));
  else objectives.push(timer("grubs", "Void Grubs", SR.grubs, false, `${grubKills.length ? `${grubKills.length}/3 taken. ` : ""}${grubNote}`));

  const herald = events.find((event) => event.EventName === "HeraldKill");
  const heraldNote = "Assumed single spawn at 15:00 (2025 timing; verify on your patch).";
  if (herald) objectives.push(gone("herald", "Rift Herald", `Taken by ${sideText(sideOf(herald.KillerName))} at ${clock(num(herald.EventTime))}; does not respawn.`, "taken"));
  else if (time >= SR.baron) objectives.push(gone("herald", "Rift Herald", `May have despawned. ${heraldNote}`));
  else objectives.push(timer("herald", "Rift Herald", SR.herald, false, heraldNote));

  const baron = events.filter((event) => event.EventName === "BaronKill").at(-1);
  objectives.push(baron
    ? timer("baron", "Baron Nashor", num(baron.EventTime) + SR.baronRespawn, true, `Last taken by ${sideText(sideOf(baron.KillerName))} at ${clock(num(baron.EventTime))}; respawns 6:00 after each kill.`)
    : timer("baron", "Baron Nashor", SR.baron, false, "First spawn at 20:00 (2026 season)."));
  return { objectives, dragonState };
}

function buildDeathMoment(input: {
  events: RawEvent[];
  time: number;
  active: LiveGameSnapshot["activePlayer"];
  findPlayer: (name?: string) => LivePlayer | null;
  recommendations: LiveRecommendation[];
  mobility: LiveRecommendation | null;
  /** The build path's un-owned steps in order: the follow-up goal is the path's next step, never an off-path card. */
  pathAhead: number[];
  catalog: Catalog;
  brief: PlayerBrief | null;
  sr: boolean;
  ruleset: Ruleset;
  /** Last alive poll at/just before the death (lib/live-history), or null when this server was not polling then. */
  atDeath: (diedAt: number) => HistorySample | null;
}): { moment: LiveDeathMoment; history: "full" | "gold" | "none" } | null {
  const { events, time, active, findPlayer, catalog, brief, sr, ruleset } = input;
  if (!active.isDead) return null;
  const deaths = events.filter((event) => event.EventName === "ChampionKill" && eventNameMatches(event.VictimName, active));
  const death = deaths.at(-1);
  const diedAt = death ? num(death.EventTime) : Math.floor(time);
  const killer = findPlayer(death?.KillerName);
  const killerChampion = killer?.champion || nonPlayerKiller(death?.KillerName);
  const assisterPlayers = (death?.Assisters || []).map((name) => ({ name, player: findPlayer(name) }));
  const assisters = assisterPlayers.map(({ name, player }) => player?.champion || nonPlayerKiller(name));
  const goldNow = Math.max(0, Math.floor(active.currentGold));

  const owned = ownedCounts(active);
  const state = { gold: goldNow, slots: active.items.filter(inSlot).length, owned: new Map(owned), bought: [] as number[] };
  // Follows recommendations[0] (the next build-path step) whenever it is a buy.
  // A swap on top (full inventory): the first buy that is a path step, never an off-path card further down.
  const primary = input.recommendations[0]?.action === "buy" ? input.recommendations[0]
    : input.recommendations.find((entry) => entry.action === "buy" && input.pathAhead.includes(entry.itemId));
  const target = primary ? catalog.byId.get(primary.itemId) || catalogChoice(catalog, [primary.item]) : null;
  // Each goal's costNow credits only the owned components still unclaimed when its purchases are planned: an earlier
  // goal's buy uses up (or reserves) shared components (a Long Sword spent on Death's Dance no longer discounts Guardian
  // Angel), so crediting every goal against the full inventory made spendNow exceed costNow.
  const stockAt = new Map<number, Map<number, number>>();
  const plan = (item: CatalogItem, limit: number) => { if (!stockAt.has(item.id)) stockAt.set(item.id, new Map(state.owned)); return planPurchases(item, state, catalog, limit); };
  const buyNow = target ? plan(target, 4) : [];
  const boots = input.mobility?.action === "buy" && input.mobility.itemId !== target?.id ? catalog.byId.get(input.mobility.itemId) : null;
  if (boots) buyNow.push(...plan(boots, 1));
  // Leftover gold starts the following build step instead of sitting in the pocket: the path's step after the main goal,
  // the same item the build path shows next (a counter card further down the list, Wit's End, is not the path).
  const secondId = input.pathAhead.find((id) => id !== target?.id && id !== boots?.id && !(catalog.byId.get(id) && isBootsItem(catalog.byId.get(id)!)));
  const secondRec = secondId ? input.recommendations.find((entry) => entry.action === "buy" && entry.itemId === secondId) || null : null;
  const secondItem = secondId ? catalog.byId.get(secondId) || null : null;
  // Only once the main goal is finished this trip: planning both made it buy a duplicate of a component the main
  // goal had reserved (a 2nd Cloak of Agility for LDR while the owned Cloak waited for Infinity Edge).
  const mainDone = !target || buyNow.some((buy) => buy.itemId === target.id);
  const second = mainDone && secondItem && state.gold >= 250 ? secondItem : null;
  if (second) buyNow.push(...plan(second, 2));
  // What the components are for: finishing cost with owned parts credited, minus what this trip spends on it.
  const goal = (item: CatalogItem | null | undefined, rec: LiveRecommendation | null | undefined): LiveDeathMoment["goals"][number] | null => {
    if (!item) return null;
    const costNow = Math.max(0, item.cost - consumeOwned(item, new Map(stockAt.get(item.id) || owned), catalog).value);
    const mine = buyNow.filter((buy) => buy.itemId === item.id || buy.forItem === item.name);
    const spendNow = mine.reduce((sum, buy) => sum + buy.cost, 0);
    const next = !mine.length && rec?.nextStep ? rec.nextStep : null;
    return {
      itemId: item.id, item: item.name, cost: item.cost, costNow, spendNow,
      remainingAfter: Math.max(0, costNow - spendNow), completes: mine.some((buy) => buy.itemId === item.id),
      nextPiece: next ? { itemId: next.itemId, item: next.item, cost: next.cost, goldNeeded: Math.max(0, next.cost - goldLeft()) } : null,
    };
  };
  const goldLeft = () => goldNow - buyNow.reduce((sum, buy) => sum + buy.cost, 0);
  const ward = catalog.byId.get(CONTROL_WARD.id) || CONTROL_WARD;
  const wardsOwned = owned.get(ward.id) || 0;
  if (sr && state.gold >= ward.cost && wardsOwned < 2 && (wardsOwned > 0 || state.slots < 6)) {
    buyNow.push({ itemId: ward.id, item: ward.name, cost: ward.cost, forItem: null });
  }
  const goals = [goal(target, primary), goal(boots, input.mobility), goal(second, secondRec)].filter((entry): entry is LiveDeathMoment["goals"][number] => Boolean(entry));

  const reasons: string[] = [];
  if (!death) reasons.push("Riot has not emitted a kill event for this death yet, so the read is limited.");
  else if (!killer) reasons.push(killerChampion === "Turret" ? "Killed by a turret: check tower aggro before diving." : `Killed by ${killerChampion}, not an enemy champion.`);
  if (assisters.length) reasons.push(`Outnumbered ${assisters.length + 1}v1 on the kill credit: ${killerChampion} + ${assisters.join(", ")}.`);
  // Levels / item gold / gold held from the last poll before the death when the history has it; else current values.
  const sample = death ? input.atDeath(diedAt) : null;
  const killerThen = killer && sample ? sample.players[historyKey(killer)] ?? null : null;
  const history: "full" | "gold" | "none" = !sample ? "none" : !killer || killerThen ? "full" : "gold";
  if (killer) {
    const levels = killerThen && sample ? { killer: killerThen.level, me: sample.level } : { killer: killer.level, me: active.level };
    const gap = levels.killer - levels.me;
    if (gap >= 2) {
      reasons.push(killerThen
        ? `${killer.champion} was ${gap} levels ahead when you died (${levels.killer} vs ${levels.me}).`
        : `${killer.champion} is ${gap} levels ahead (${levels.killer} vs ${levels.me}, current levels).`);
    }
    const myItemGold = killerThen && sample ? sample.players[historyKey(active)]?.itemGold ?? itemGold(active) : itemGold(active);
    const goldLead = (killerThen ? killerThen.itemGold : itemGold(killer)) - myItemGold;
    if (goldLead >= 1000) reasons.push(`${killer.champion}'s items ${killerThen ? "were" : "are"} worth ~${Math.round(goldLead / 100) * 100}g more than yours${killerThen ? " at the time" : ""}.`);
    if (killer.kills >= 5 && killer.kills >= killer.deaths * 2) reasons.push(`${killer.champion} is fed (${killer.kills}/${killer.deaths}/${killer.assists}).`);
    const repeat = deaths.filter((event) => sameName(event.KillerName, death?.KillerName)).length;
    if (repeat >= 2) reasons.push(`Death #${repeat} to ${killer.champion} this game.`);
  }
  const isJungler = (player: LivePlayer | null) => Boolean(player && (player.position === "JUNGLE" || player.summonerSpells.some((spell) => /smite/i.test(spell))));
  if (death && diedAt < 600) {
    const assistingJungler = assisterPlayers.find(({ player }) => isJungler(player))?.player;
    if (isJungler(killer)) reasons.push(`Died before 10:00 to the enemy jungler (${killerChampion}).`);
    else if (assistingJungler) reasons.push(`The enemy jungler (${assistingJungler.champion}) assisted before 10:00: likely a gank.`);
  }
  // Gold held at death: the last poll before it. Without one, standard SR subtracts passive income (~2.04g/s) since the
  // death (spending while dead makes that an underestimate); Swiftplay's passive rate is unknown, so it is never estimated.
  const goldAtDeath = sample ? Math.floor(sample.gold)
    : ruleset === "sr" && death ? Math.round(goldNow - Math.max(0, time - diedAt) * PASSIVE_GOLD_PER_SECOND) : null;
  if (death && goldAtDeath !== null && goldAtDeath >= 1000) reasons.push(sample ? `Died holding ${goldAtDeath}g unspent.` : `Died holding ~${goldAtDeath}g unspent (estimated).`);
  else if (goldNow >= 1000) reasons.push(`You're holding ${goldNow}g: spend it before you respawn.`);

  let patternNote: string | null = null;
  if (brief && killer) {
    const note = brief.killerNotes.find((line) => wordMatch(line, killer.champion));
    const issue = brief.issues.find((entry) => wordMatch(`${entry.label} ${entry.detail} ${entry.evidence}`, killer.champion));
    patternNote = note || (issue ? `${issue.label}: ${issue.evidence || issue.detail}` : null);
  }

  return {
    history,
    moment: {
      diedAt,
      respawnIn: Math.max(0, Math.round(active.respawnTimer * 10) / 10),
      killer: death?.KillerName || "Unknown",
      killerChampion,
      assisters,
      goldNow,
      buyNow,
      goals,
      reasons: reasons.slice(0, 6),
      patternNote,
    },
  };
}

/**
 * Item-data health. unknownBuildItems = saved/imported/learned build names that findItem no longer resolves on this
 * patch (renamed or removed items). Only checked against real Data Dragon data: the fallback list is too small to judge.
 */
function buildPatchStatus(catalog: Catalog, brief: PlayerBrief | null, meta: MetaBuild | null = null): NonNullable<LiveGameSnapshot["patchStatus"]> {
  const fallback = Boolean(catalog.fallback);
  const names = [...(brief?.pinnedBuild || []), ...(brief?.importedBuild?.items || []), ...(brief?.usualBuild || []), ...(meta ? meta.slots.flatMap((slot) => slot.options.map((option) => option.item)) : [])];
  const unknownBuildItems = fallback ? [] : [...new Map(names
    .filter((name) => name.trim() && !findItem(catalog, name))
    .map((name) => [key(name), name.trim()])).values()];
  const itemNote = fallback
    ? `Item data offline — using a built-in list from patch ${catalog.version}; prices may be out of date.`
    : unknownBuildItems.length
      ? `Not on patch ${catalog.version}: ${unknownBuildItems.slice(0, 3).join(", ")}${unknownBuildItems.length > 3 ? ` +${unknownBuildItems.length - 3}` : ""} — skipped in your build.`
      : null;
  // The curated top build is still used when it is 2+ patches old, with this warning (offline: the version is the fallback list's).
  const metaNote = meta && !fallback ? metaPatchNote(meta, catalog.version) : null;
  const note = [itemNote, metaNote].filter(Boolean).join(" · ") || null;
  return { version: catalog.version, fallback, unknownBuildItems, note };
}

/** Where the champion traits (classes, damage types, healing / CC / poke signals) came from on this poll. */
function championTraitsCaveat(index: ChampionIndex) {
  const status = championTraitsStatus();
  const where = status.origin === "cache" || status.origin === "communitydragon" ? `CommunityDragon's patch ${status.patch} champion data`
    : status.origin === "fallback" ? `Rift Lens' bundled copy of CommunityDragon champion data (patch ${status.patch}) while this patch's data loads`
    : "Data Dragon tags only (CommunityDragon champion data unavailable)";
  return `Champion classes, damage types and healing / crowd-control / poke signals are derived from Riot's game data (${where}: roles, damage type, playstyle ratings and ability text)${index.size ? "" : "; Data Dragon's champion list was unavailable"}. They are rule-based reads of ability text, not measured in-game numbers.`;
}

function gameResult(events: RawEvent[]): LiveGameSnapshot["gameResult"] {
  const end = events.filter((event) => event.EventName === "GameEnd").at(-1);
  if (!end) return null;
  if (/win|victory/i.test(end.Result || "")) return "win";
  if (/los|defeat/i.test(end.Result || "")) return "loss";
  return null;
}

/**
 * First 16 hex of sha1 over the sorted riotIds (summonerName fallback) of every player. Champion names are NOT hashed:
 * Viego's possession changes his championName mid-game, which used to split one match into several gameIds.
 */
const LATCHED_SIGNALS = ["armorStack", "mrStack", "hpStack", "healing", "burstThreat", "hardCc", "poke"] as const;
const LEVEL_RANK: Record<string, number> = { none: 0, some: 1, heavy: 2 };
/** How far the enemy physical share must move before the boots choice follows it. */
const SHARE_DEAD_BAND = 0.08;
const steadyStore = globalThis as typeof globalThis & { __riftLensSteadySignalsV1?: Map<string, { time: number; profile: EnemyProfile }> };
const steadyProfiles = steadyStore.__riftLensSteadySignalsV1 ??= new Map();

/**
 * Per game, each enemy signal keeps the strongest level (then score) it reached: a threat that counted keeps counting, so
 * the build path and counter cards do not flip every time an estimate wobbles across a threshold (a 2026 game swapped its
 * last three items 13 times on burst threat alone). The physical share only moves past a dead band.
 */
function steadyProfile(gameId: string, time: number, profile: EnemyProfile): EnemyProfile {
  const previous = steadyProfiles.get(gameId);
  const steady: EnemyProfile = { ...profile };
  if (previous && time >= previous.time - 5) {
    for (const signal of LATCHED_SIGNALS) {
      const before = previous.profile[signal];
      const now = profile[signal];
      const stronger = LEVEL_RANK[before.level] - LEVEL_RANK[now.level] || before.score - now.score;
      if (stronger > 0) (steady as Record<string, unknown>)[signal] = before;
    }
    if (Math.abs(profile.physicalShare.share - previous.profile.physicalShare.share) < SHARE_DEAD_BAND) steady.physicalShare = previous.profile.physicalShare;
  }
  steadyProfiles.set(gameId, { time, profile: steady });
  while (steadyProfiles.size > 4) steadyProfiles.delete(steadyProfiles.keys().next().value!);
  return steady;
}

/** Forget what earlier samples of every game taught (steady signals, slotted boots): tests that reuse one roster. */
export function resetGameMemory() {
  steadyProfiles.clear();
  resetBootsSlot();
}

/** Starting items can be bought until about this long into the game (minions arrive after it). */
const START_WINDOW_SECONDS = 90;

/**
 * The game-start buy on Summoner's Rift draft/ranked (500g, nothing owned yet): the top build's researched start
 * (Doran's Bow + Health Potion), not a component of the first item. A Long Sword gives 10 AD for 350g; Doran's Blade
 * gives the same 10 AD plus 80 HP and omnivamp for 450g, stats made for the lane. Swiftplay starts with 1400g at level 3
 * and keeps its own first buy.
 */
function startingRecommendation(active: LiveGameSnapshot["activePlayer"], catalog: Catalog, plan: BuildPlan, ruleset: Ruleset, time: number): LiveRecommendation | null {
  if (ruleset !== "sr" || time > START_WINDOW_SECONDS || active.items.some(inSlot) || !plan.meta?.starting?.length) return null;
  const items = plan.meta.starting.flatMap((name) => catalogChoice(catalog, [name]) || []);
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + item.cost, 0);
  const [first] = items;
  return {
    itemId: first.id, item: first.name, cost: total, description: first.description || "",
    priority: "primary", action: "buy", timing: "first-item",
    reason: `Start with ${items.map((item) => item.name).join(" + ")}: the usual ${plan.meta.champion} start on patch ${plan.meta.patch}, laning stats now instead of a component that does little until the item is finished.`,
    trigger: "Game start", usageTip: "", nextStep: null, swapPlan: null,
    starting: items.map((item) => ({ itemId: item.id, item: item.name, cost: item.cost })),
  };
}

/** The boots in the role-quest boots slot this sample, as an owned item, or null (lib/boots-slot.ts). */
const runeBootsState = globalThis as typeof globalThis & { __riftLensRuneBootsV1?: Map<string, Promise<Map<string, number>>> };
const runeBootsCache = runeBootsState.__riftLensRuneBootsV1 ??= new Map();

/**
 * Rune name → move speed it adds to any boots, from Riot's rune text (Data Dragon runesReforged): Magical Footwear's
 * "Slightly Magical Footwear grants you an additional 10 Move Speed". Empty when the data cannot be loaded.
 */
function runeBootsBonuses(version: string) {
  let pending = runeBootsCache.get(version);
  if (!pending) {
    pending = fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`, { signal: AbortSignal.timeout(3000) })
      .then((response) => response.ok ? response.json() as Promise<Array<{ slots?: Array<{ runes?: Array<{ name?: string; longDesc?: string }> }> }>> : [])
      .then((trees) => {
        const bonuses = new Map<string, number>();
        for (const rune of trees.flatMap((tree) => tree.slots || []).flatMap((slot) => slot.runes || [])) {
          const text = cleanText(rune.longDesc);
          const extra = /boots|footwear/i.test(text) ? /additional (\d+) Move Speed/i.exec(text) : null;
          if (rune.name && extra) bonuses.set(key(rune.name), Number(extra[1]));
        }
        return bonuses;
      })
      .catch(() => { runeBootsCache.delete(version); return new Map<string, number>(); });
    runeBootsCache.set(version, pending);
  }
  return pending;
}

function bootsSlotItem(gameId: string, time: number, active: LiveGameSnapshot["activePlayer"], stats: RawChampionStats, catalog: Catalog, baseMoveSpeed: number | null, roleQuests: boolean, runeBonus: number): LiveItem | null {
  const asBoots = (item: CatalogItem): BootsItem => ({ id: item.id, name: item.name, price: item.cost, description: item.description, flat: item.moveSpeed?.flat || 0, from: item.from });
  const listed = active.items.flatMap((item) => catalog.byId.get(item.id) || []);
  const visible = listed.find((item) => isBootsItem(item));
  const percent = listed.reduce((sum, item) => sum + (isBootsItem(item) ? 0 : item.moveSpeed?.percent || 0), 0);
  const allBoots = [...catalog.byId.values()].filter((item) => (isBootsItem(item) || isUpgradedBootsItem(item)) && (item.moveSpeed?.flat || 0) > 0).map(asBoots);
  const boots = slottedBoots(gameId, {
    time,
    dead: active.isDead,
    stats: {
      moveSpeed: num(stats.moveSpeed), attackSpeed: num(stats.attackSpeed), armor: num(stats.armor), magicResist: num(stats.magicResist),
      magicPenetrationFlat: num(stats.magicPenetrationFlat), abilityHaste: num(stats.abilityHaste), abilityPower: num(stats.abilityPower), attackDamage: num(stats.attackDamage),
    },
    visible: visible ? asBoots(visible) : null,
    percent,
    boots: allBoots,
    baseMoveSpeed,
    roleQuests,
    runeBonus,
    gold: active.currentGold,
    // Boots left out: boots moving into the slot is not a purchase.
    listedValue: listed.filter((item) => !isBootsItem(item)).reduce((sum, item) => sum + item.cost * Math.max(1, active.items.find((entry) => entry.id === item.id)?.count || 1), 0),
  });
  return boots ? { id: boots.id, name: boots.name, count: 1, price: boots.price, description: boots.description || "", bootsSlot: true } : null;
}

export function liveGameId(raw: RawLiveData) {
  const roster = (raw.allPlayers || []).map((player) => player.riotId || player.summonerName || "").sort().join("|");
  return createHash("sha1").update(roster).digest("hex").slice(0, 16);
}

function recentEvents(events: RawEvent[], active: LivePlayer, sideOf: (name?: string) => Side): LiveRecentEvent[] {
  return events.flatMap<LiveRecentEvent>((event) => {
    const type = event.EventName || "Event";
    const involved = eventNameMatches(event.KillerName, active) || eventNameMatches(event.VictimName, active) || (event.Assisters || []).some((name) => eventNameMatches(name, active));
    if (type === "ChampionKill" && involved) {
      const activeDied = eventNameMatches(event.VictimName, active);
      const activeKilled = eventNameMatches(event.KillerName, active);
      return [{
        id: num(event.EventID), type, time: num(event.EventTime),
        text: activeDied ? `Killed by ${event.KillerName || "an enemy"}` : activeKilled ? `Killed ${event.VictimName || "an enemy"}` : `Assisted on ${event.VictimName || "a kill"}`,
        tone: activeDied ? "bad" as const : "good" as const,
      }];
    }
    const label = objectiveLabel(event);
    if (label) {
      const side = sideOf(event.KillerName);
      const stolen = String(event.Stolen).toLowerCase() === "true" ? " (stolen)" : "";
      return [{
        id: num(event.EventID), type, time: num(event.EventTime),
        text: `${label} secured${side === "ally" ? " by your team" : side === "enemy" ? " by the enemy" : ""}${stolen}`,
        tone: side === "ally" ? "good" as const : side === "enemy" ? "bad" as const : "neutral" as const,
      }];
    }
    return [];
  }).slice(-8).reverse();
}

async function loadBriefSafely(
  loadBrief: NormalizeOptions["loadBrief"],
  champion: string,
  enemyChampions: string[],
  laneOpponent: string | null,
): Promise<PlayerBrief | null> {
  if (!loadBrief) return null;
  try {
    // Never let memory stall the 2.5s poll.
    return await Promise.race([
      loadBrief(champion, enemyChampions, laneOpponent),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]) || null;
  } catch {
    return null;
  }
}

function safeSold(options: NormalizeOptions, gameId: string) {
  try { return options.soldItemIds?.(gameId) || []; } catch { return []; }
}

export type NormalizeOptions = {
  loadBrief?: (champion: string, enemyChampions: string[], laneOpponent: string | null) => Promise<PlayerBrief | null>;
  /** Completed items the player sold earlier this game (from the recorder); never suggested again. */
  soldItemIds?: (gameId: string) => number[];
};

/** Riot sends `activePlayer: { error }` when there is no player of your own: spectating or a replay. */
export const SPECTATOR_MESSAGE = "Spectating or watching a replay: Rift Lens only coaches games you are playing.";
export const isSpectating = (raw: RawLiveData) => Boolean(raw.activePlayer && "error" in (raw.activePlayer as Record<string, unknown>));

export async function normalizeLiveData(raw: RawLiveData, options: NormalizeOptions = {}): Promise<LiveGameSnapshot> {
  if (isSpectating(raw)) throw new Error(SPECTATOR_MESSAGE);
  const rawPlayers = raw.allPlayers || [];
  const activeRaw = rawPlayers.find((player) => sameName(player.riotId, raw.activePlayer?.riotId))
    || rawPlayers.find((player) => sameName(player.summonerName, raw.activePlayer?.summonerName))
    || rawPlayers.find((player) => sameName(player.riotId?.split("#")[0], raw.activePlayer?.summonerName));
  if (!activeRaw) throw new Error("The live API responded, but Rift Lens could not identify the active player.");

  const catalog = await loadCatalog();
  // Game modes report some items under mode-copy ids (Swiftplay Thornmail = 323075 for 3075). Map them back to the
  // catalog item so ownership, path steps, sell values and "never sell your own build" checks see the real item.
  for (const player of rawPlayers) {
    for (const item of player.items || []) {
      const id = num(item.itemID);
      if (!id || catalog.byId.has(id)) continue;
      const alias = catalog.aliases?.get(id);
      if (alias) { item.itemID = alias; continue; }
      const base = id >= 100000 ? catalog.byId.get(id % 10000) : undefined;
      const named = item.displayName ? catalog.byName.get(key(item.displayName)) : undefined;
      const match = base && (!named || named.id === base.id) ? base : named;
      if (match) item.itemID = match.id;
    }
  }
  // Exclusive item groups for this patch: disk cache or a background CommunityDragon fetch; never awaited by the poll.
  if (!catalog.fallback) void ensureItemGroups(catalog.version, (id) => catalog.byId.has(id));
  const index = await loadChampionIndex(catalog.version);
  // Champion traits for this patch (lib/champion-traits.ts): disk cache or a background CommunityDragon fetch, this
  // game's champions first; never awaited by the poll (the bundled table answers meanwhile).
  if (!catalog.fallback) void ensureChampionTraits(catalog.version, index, rawPlayers.map((player) => player.championName || ""));
  const activeScore = threatScore(activeRaw);
  const alliedRaw = rawPlayers.filter((player) => player !== activeRaw && player.team === activeRaw.team);
  const inferredPosition = inferActivePosition(activeRaw, alliedRaw, index);
  const enemyRaw = rawPlayers.filter((player) => player.team && player.team !== activeRaw.team).sort((a, b) => threatScore(b) - threatScore(a));
  const enemies = enemyRaw.map((player, rank) => normalizePlayer(player, activeScore, rank, index));
  const allies = alliedRaw.map((player) => normalizePlayer(player, activeScore, 99, index));
  const baseActive = normalizePlayer(activeRaw, activeScore, 99, index);
  const rawActive = raw.activePlayer || {};
  const stats = rawActive.championStats || {};
  const abilityLevel = (slot: "Q" | "W" | "E" | "R") => num(rawActive.abilities?.[slot]?.abilityLevel);
  const activePlayer: LiveGameSnapshot["activePlayer"] = {
    ...baseActive,
    position: inferredPosition.position,
    positionBasis: inferredPosition.basis,
    level: num(rawActive.level) || baseActive.level,
    currentGold: num(rawActive.currentGold),
    health: num(stats.currentHealth),
    maxHealth: num(stats.maxHealth),
    resource: num(stats.resourceValue),
    maxResource: num(stats.resourceMax),
    stats: activeStats(stats),
    abilityLevels: { Q: abilityLevel("Q"), W: abilityLevel("W"), E: abilityLevel("E"), R: abilityLevel("R") },
    runes: {
      keystone: rawActive.fullRunes?.keystone?.displayName || activeRaw.runes?.keystone?.displayName || null,
      primaryTree: rawActive.fullRunes?.primaryRuneTree?.displayName || activeRaw.runes?.primaryRuneTree?.displayName || null,
      secondaryTree: rawActive.fullRunes?.secondaryRuneTree?.displayName || activeRaw.runes?.secondaryRuneTree?.displayName || null,
    },
  };
  const positionOpponent = enemies.find((enemy) => STANDARD_POSITIONS.includes(activePlayer.position) && enemy.position === activePlayer.position);
  const laneOpponent = positionOpponent || enemies[0] || null;
  const matchup = positionOpponent
    ? { basis: inferredPosition.basis, note: inferredPosition.note }
    : { basis: "highest-threat" as const, note: "No enemy shared the inferred position, so this card shows the highest-ranked enemy threat." };
  const [championContext, playerBrief, enemyStatsData] = await Promise.all([
    loadChampionContext(catalog.version, activePlayer.champion, index),
    loadBriefSafely(options.loadBrief, activePlayer.champion, enemies.map((enemy) => enemy.champion), positionOpponent?.champion || null),
    // Cached per version after the first load; a slow first fetch must not stall the poll (the next poll retries).
    catalog.fallback ? null : Promise.race([
      loadEnemyStatsData(catalog.version),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]),
  ]);
  // Boots in the role-quest boots slot are not listed (lib/boots-slot.ts): they still count as owned. Before anything reads
  // the inventory (enemy profile's item gold, recommendations, death shop, recorder).
  const baseMoveSpeed = enemyStatsData ? championBase(enemyStatsData, activePlayer.champion)?.moveSpeed ?? null : null;
  const runeBonuses = catalog.fallback ? new Map<string, number>() : await runeBootsBonuses(catalog.version);
  const runeBonus = (rawActive.fullRunes?.generalRunes || []).reduce((sum, rune) => sum + (runeBonuses.get(key(rune.displayName || "")) || 0), 0);
  const hiddenBoots = bootsSlotItem(liveGameId(raw), num(raw.gameData?.gameTime), activePlayer, stats, catalog, baseMoveSpeed, rulesetFor(raw.gameData) === "sr", runeBonus);
  if (hiddenBoots) activePlayer.items.push(hiddenBoots);
  // Estimated enemy stats + team counter-build signals (lib/enemy-stats.ts). Cheap once Data Dragon data is cached.
  const enemyProfile: EnemyProfile | null = enemyStatsData
    ? steadyProfile(liveGameId(raw), num(raw.gameData?.gameTime), enemyThreatProfile(
      enemies.map((enemy) => ({ champion: enemy.champion, level: enemy.level, items: enemy.items, kills: enemy.kills, deaths: enemy.deaths, assists: enemy.assists, damageProfile: enemy.damageProfile })),
      enemyStatsData,
      { referenceLevel: activePlayer.level, referenceItemGold: itemGold(activePlayer) },
    ))
    : null;
  if (enemyProfile) enemies.forEach((enemy, at) => { enemy.estStats = enemyProfile.enemies[at].stats; });
  // Each enemy item's armor / MR (Data Dragon stats): the resist alerts name the purchase that moved a resist.
  if (enemyStatsData) {
    for (const enemy of enemies) {
      for (const item of enemy.items) {
        const stats = enemyStatsData.items.get(item.id);
        if (stats?.armor) item.armor = stats.armor;
        if (stats?.magicResist) item.magicResist = stats.magicResist;
      }
    }
  }
  const events = raw.events?.Events || [];
  const mode = raw.gameData?.gameMode || "UNKNOWN";
  const time = num(raw.gameData?.gameTime);
  const ruleset = rulesetFor(raw.gameData);
  const sr = ruleset !== null;

  const everyone = [activePlayer, ...allies, ...enemies];
  const findPlayer = (name?: string) => name ? everyone.find((player) => eventNameMatches(name, player)) || null : null;
  const sideOf = (name?: string): Side => {
    const player = findPlayer(name);
    return player ? player.team === activePlayer.team ? "ally" : "enemy" : null;
  };
  const gameId = liveGameId(raw);
  // Short in-game history (lib/live-history): one sample per poll, so the death read can look back to the moment of death.
  recordSample(gameId, {
    time,
    level: activePlayer.level,
    gold: Math.floor(activePlayer.currentGold),
    itemIds: activePlayer.items.map((item) => item.id),
    cs: activePlayer.cs,
    hp: activePlayer.health,
    maxHp: activePlayer.maxHealth,
    alive: !activePlayer.isDead,
    players: Object.fromEntries(everyone.map((player) => [historyKey(player), { level: player.level, itemGold: itemGold(player) }])),
  });
  const sold = new Set(safeSold(options, gameId));
  const { recommendations, plan, scaling, counterPicks } = buildRecommendations(activePlayer, enemies, catalog, time, index, playerBrief, sold, enemyProfile);
  const start = startingRecommendation(activePlayer, catalog, plan, ruleset, time);
  if (start) recommendations.unshift(start);
  const mobilityRecommendation = buildMobilityRecommendation(activePlayer, catalog, time, index, plan, sold, enemyProfile);
  const { objectives, dragonState } = objectiveState(events, time, sideOf, ruleset);
  const death = buildDeathMoment({
    events, time, active: activePlayer, findPlayer, recommendations, mobility: mobilityRecommendation, catalog, brief: playerBrief, sr, ruleset,
    pathAhead: plan.path.steps.filter((step) => step.status !== "owned" && step.status !== "skipped").map((step) => step.itemId),
    atDeath: (diedAt) => aliveSampleAt(gameId, diedAt),
  });
  const deathMoment = death?.moment ?? null;
  const patchStatus = buildPatchStatus(catalog, playerBrief, plan.meta);
  const buildPath = plan.path;
  const metaStale = plan.meta && !catalog.fallback ? metaPatchNote(plan.meta, catalog.version) : null;
  const sourceNote: Record<LiveBuildPath["source"], string> = {
    pinned: "the build you pinned on the Memory page",
    imported: "an item set captured from the League client (e.g. pushed by Mobalytics in champ select)",
    meta: plan.meta
      ? `the current top ${plan.meta.champion} build (patch ${plan.meta.patch} ${plan.meta.sample} stats from ${[...new Set(plan.meta.sources.map((entry) => entry.site || entry.name.split(" ")[0]))].join(", ")}, ${plan.meta.origin === "researched" ? `researched on the web ${plan.meta.verified}, validated against Data Dragon ${plan.meta.researchedOn}` : `checked by hand ${plan.meta.verified}`})${playerBrief?.newOnChampion ? `; you are new on ${plan.meta.champion}, so your past games do not change it` : "; your history only picks between its options"}`
      : "the current top build",
    history: "your past games on this champion",
    inventory: "the components in your inventory (recipe tree inference)",
    default: "Rift Lens' class defaults for the champion's Riot class (no researched build for it yet)",
  };

  return {
    status: "live",
    capturedAt: new Date().toISOString(),
    gameId,
    game: {
      mode,
      modeLabel: modeLabel(raw.gameData),
      map: raw.gameData?.mapName || "Unknown map",
      time,
      phase: gamePhase(time, ruleset),
      queuePrecision: mode.toUpperCase() === "CLASSIC" ? "limited" : "exact",
    },
    matchup,
    activePlayer,
    laneOpponent,
    allies,
    enemies,
    recommendations,
    mobilityRecommendation,
    deathSources: deathSources(events, activePlayer, enemies),
    recentEvents: recentEvents(events, activePlayer, sideOf),
    dataDragonVersion: catalog.version,
    championContext,
    objectives,
    dragonState,
    deathMoment,
    playerBrief,
    gameResult: gameResult(events),
    buildPath,
    scaling,
    patchStatus,
    ...(enemyProfile ? { enemyProfile: summarizeProfile(enemyProfile) } : {}),
    ...(counterPicks.length ? { counterPicks } : {}),
    caveats: [
      `Build source: ${buildPath.label} — from ${sourceNote[buildPath.source]}. The first recommendation is the next step of this path; threat-driven cards are labelled deviations.`,
      "Threat scores and damage profiles are inferred from champion, items, level, CS, and KDA; they are not Riot-measured damage received.",
      enemyProfile
        ? `Enemy armor/MR/HP are estimates from Data Dragon ${catalog.version} base stats, level growth and item stats (AD growth from ${enemyStatsData?.adGrowthSource === "current" ? "the current patch" : `patch ${enemyStatsData?.adGrowthSource}`}); runes, stat shards, stacking passives and buffs are not included. Counter-build cards cite these numbers.`
        : "Enemy stat estimates were unavailable (Data Dragon champion/item stats did not load), so counter-build cards are limited to the burst-threat check.",
      championTraitsCaveat(index),
      mode.toUpperCase() === "CLASSIC" ? "The Live Client API identifies the map and CLASSIC ruleset but does not expose the exact queue, so Swiftplay versus standard queue may remain ambiguous here." : "The displayed mode comes from Riot's live game data.",
      catalog.fallback
        ? `Riot Data Dragon was unreachable, so item prices and recipes come from Rift Lens' small built-in fallback list (last checked on patch ${catalog.version}) and may be out of date; recommendation ranking is Rift Lens coaching logic.`
        : `Item prices, recipes, descriptions, and champion mechanics come from Riot Data Dragon ${catalog.version}; recommendation ranking is Rift Lens coaching logic.`,
      ...(plan.meta?.servedFor ? [`No ${roleName(plan.meta.servedFor)} build is known for ${plan.meta.champion} yet, so the path follows the ${roleName(plan.meta.role)} build (completed items mostly carry over between lanes); a ${roleName(plan.meta.servedFor)} build is researched in the background and replaces it once validated.`] : []),
      ...(metaStale ? [`${metaStale}: Data Dragon is on ${catalog.version}; the build path still follows it until ${plan.meta?.origin === "researched" ? "a new research for this patch succeeds" : "the table is re-checked"}.`] : []),
      ...(patchStatus.unknownBuildItems.length ? [`Not in Data Dragon ${catalog.version} item data (renamed or removed): ${patchStatus.unknownBuildItems.join(", ")}. Your build path skips them.`] : []),
      ...(ruleset === "swiftplay" ? ["Swiftplay rules applied: start at level 3 with 1400g, no Void Grubs or Rift Herald, Baron at 12:00, max 2 elemental drakes (both needed for soul), Elder at 15:00 then every 6:00, Sudden Death at 25:00. The first drake's 5:00 spawn is assumed; timers derive from Riot's kill events."]
        : ruleset === "sr" ? ["Objective timers are derived from Riot's kill events and 2026 Summoner's Rift timings (dragon 5:00 then +5:00, elder +6:00 after soul, Baron 20:00 then +6:00; Atakhan removed). Void Grub (8:00) and Rift Herald (15:00) times are assumptions; objectives taken by an unresolved killer are not credited to either team."] : []),
      ...(death ? [death.history === "full"
        ? "Death read uses the latest kill event plus Rift Lens' short in-game history: levels, item values and gold held are from the last poll before the death (polls are ~2.5s apart)."
        : death.history === "gold"
          ? "Death read uses the latest kill event; gold held is from the last poll before the death, but the killer's level and item values are current (the killer was not in the history)."
          : `Death read uses the latest kill event; this page was not polling when you died, so levels and item values are current${ruleset === "sr" ? " and gold held at death is estimated from current gold minus passive income" : ""}.`] : []),
      ...(playerBrief ? [`Recommendations use your memory on ${playerBrief.champion} (${playerBrief.gamesOnChampion} game${playerBrief.gamesOnChampion === 1 ? "" : "s"})${playerBrief.avoidItems.length ? "; items you avoid are filtered out" : ""}.`] : []),
      "HELP ME performs the optional deeper AI read only when pressed and reuses its cached answer for the same game state.",
    ],
  };
}

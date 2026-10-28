// Exclusive item groups: League lets you own at most `max` items of a group (one Last Whisper item: Black Cleaver,
// Terminus, Mortal Reminder, Lord Dominik's Regards, Serylda's Grudge and the Last Whisper component itself; one
// Spellblade item; one Lifeline item…). Riot does not publish these in Data Dragon, so the table comes from
// CommunityDragon's game data (items.cdtb.bin.json: each item's mItemGroups + each ItemGroup's mMaxGroupOwnable).
//
// Loading never blocks a poll: the engine reads the in-memory table synchronously. Per Data Dragon patch it is
//   1. the disk cache <memory>/cache/item-groups-<patch>.json when present, else
//   2. fetched from CommunityDragon in the background (~16 MB, parsed once, only the compact table is kept, the cache is
//      written atomically), failures backing off 1 min → 2 → 4 … → 1 h;
//   3. lib/item-groups-fallback.json (patch 16.20) until one of those lands.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { memoryRoot, writeJsonAtomic } from "@/lib/memory-store";

export type ItemGroupTable = {
  patch: string;
  source: string;
  generatedAt: string;
  groups: Record<string, { max: number; items: number[] }>;
};

export type ItemGroup = { key: string; label: string; max: number; items: ReadonlySet<number> };

export type GroupConflict = {
  /** Raw group key from the game data ("LastWhisper", "{8b55a7b3}"). */
  group: string;
  /** Readable name ("Last Whisper", "Spellblade"). */
  label: string;
  max: number;
  /** Items already held (owned, or planned earlier) that fill the group, owned ones first. */
  blocking: number[];
  /** True when at least one blocking item is owned (not only planned). */
  owned: boolean;
};

/** Readable names; hashed keys are unnamed groups in the game data. Unknown keys fall back to a split of the key. */
const LABELS: Record<string, string> = {
  LastWhisper: "Last Whisper",
  "{8b55a7b3}": "Spellblade",
  "{87f1e822}": "Thornmail",
  "{3fcdbdac}": "Spell shield",
  "{3aa8b165}": "Jungle pet",
  "{3541a6d4}": "Hydra",
  LifelineItems: "Lifeline",
  CleaveItems: "Hydra / Cleave",
  VoidPen: "Magic penetration",
  ImmolateItems: "Immolate",
  EternityItems: "Eternity",
  GuardianItems: "Guardian starter",
  DoransItems: "Starter item",
  GoldItems: "Starter quest item",
  StopwatchGroup: "Stopwatch",
  TearItems: "Tear (mana charge)",
  Glory: "Glory (Dark Seal)",
  Quicksilver: "Quicksilver",
  Boots: "Boots",
  BootsWithoutActives: "Boots",
  Potion: "Potion",
  TheBlackSpear: "Black Spear",
};

export function groupLabel(key: string) {
  return LABELS[key] || key.replace(/Items?$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") || key;
}

const FALLBACK_FILE = "item-groups-fallback.json";
const CDRAGON = "https://raw.communitydragon.org";
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 120_000;

type Compiled = { table: ItemGroupTable; origin: "fallback" | "cache" | "communitydragon" | "test"; byItem: Map<number, ItemGroup[]> };

function compile(table: ItemGroupTable, origin: Compiled["origin"]): Compiled {
  const byItem = new Map<number, ItemGroup[]>();
  for (const [key, entry] of Object.entries(table.groups || {})) {
    if (!entry || !(entry.max > 0) || !Array.isArray(entry.items)) continue;
    const group: ItemGroup = { key, label: groupLabel(key), max: entry.max, items: new Set(entry.items) };
    for (const id of group.items) {
      const list = byItem.get(id);
      if (list) list.push(group); else byItem.set(id, [group]);
    }
  }
  return { table, origin, byItem };
}

function loadFallback(): Compiled {
  // The bundled table is read relative to the project root (Next.js and the node scripts both run from there).
  for (const file of [path.join(process.cwd(), "lib", FALLBACK_FILE)]) {
    try { return compile(JSON.parse(readFileSync(file, "utf8")) as ItemGroupTable, "fallback"); } catch { /* try next */ }
  }
  return compile({ patch: "none", source: "empty", generatedAt: "", groups: {} }, "fallback");
}

let current: Compiled | null = null;
const active = () => (current ||= loadFallback());

type Refresh = { patch: string; disk: Promise<void> | null; inFlight: boolean; failures: number; retryAt: number; done: boolean };
let refresh: Refresh | null = null;
let networkEnabled = true;

/** Tests / the replay check: never touch the network (the disk cache is still read). */
export function configureItemGroups(options: { network?: boolean }) {
  if (options.network !== undefined) networkEnabled = options.network;
}

/** Test hook: replace the table (null = back to the bundled fallback). */
export function setItemGroupsForTest(table: ItemGroupTable | null) {
  current = table ? compile(table, "test") : loadFallback();
  refresh = null;
}

export function itemGroupsStatus() {
  const { table, origin } = active();
  return { patch: table.patch, origin, groups: Object.keys(table.groups).length };
}

const cachePath = (patch: string) => path.join(memoryRoot(), "cache", `item-groups-${patch.replace(/[^0-9a-z.]/gi, "_")}.json`);

/**
 * Compact table from CommunityDragon's items.cdtb.bin.json: groups with a mMaxGroupOwnable and at least two
 * purchasable items (ids < 100000; `purchasable` = the Summoner's Rift Data Dragon catalog when given).
 */
export function extractItemGroups(bin: Record<string, unknown>, patch: string, purchasable?: (id: number) => boolean): ItemGroupTable {
  const limits = new Map<string, number>();
  const members = new Map<string, Set<number>>();
  for (const [entryKey, value] of Object.entries(bin)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { __type?: string; mMaxGroupOwnable?: unknown; itemID?: unknown; mItemGroups?: unknown };
    if (entry.__type === "ItemGroup") {
      if (typeof entry.mMaxGroupOwnable === "number" && entry.mMaxGroupOwnable > 0) limits.set(entryKey, entry.mMaxGroupOwnable);
      continue;
    }
    if (typeof entry.itemID !== "number" || !Array.isArray(entry.mItemGroups) || entry.itemID >= 100000) continue;
    if (purchasable && !purchasable(entry.itemID)) continue;
    for (const group of entry.mItemGroups) {
      if (typeof group !== "string") continue;
      const set = members.get(group);
      if (set) set.add(entry.itemID); else members.set(group, new Set([entry.itemID]));
    }
  }
  const groups: ItemGroupTable["groups"] = {};
  for (const [groupKey, max] of limits) {
    const items = members.get(groupKey);
    if (items && items.size >= 2) groups[groupKey.replace(/^Items\/ItemGroups\//, "")] = { max, items: [...items].sort((a, b) => a - b) };
  }
  return { patch, source: `${CDRAGON} items.cdtb.bin.json (mItemGroups / mMaxGroupOwnable)`, generatedAt: new Date().toISOString().slice(0, 10), groups };
}

async function fetchTable(patch: string, purchasable?: (id: number) => boolean): Promise<ItemGroupTable> {
  const [major, minor] = patch.split(".");
  const urls = [...(major && minor ? [`${CDRAGON}/${major}.${minor}/game/items.cdtb.bin.json`] : []), `${CDRAGON}/latest/game/items.cdtb.bin.json`];
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      // no-store: the 16 MB body must not land in Next's fetch cache. Parsed once; only the compact table survives.
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`CommunityDragon ${response.status} for ${url}`);
      const table = extractItemGroups(await response.json() as Record<string, unknown>, patch, purchasable);
      if (!table.groups.LastWhisper || Object.keys(table.groups).length < 5) throw new Error("CommunityDragon item groups looked incomplete");
      return { ...table, source: url };
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error("CommunityDragon item groups unavailable");
}

function startNetwork(state: Refresh, purchasable?: (id: number) => boolean) {
  if (!networkEnabled || state.inFlight || state.done || Date.now() < state.retryAt) return;
  state.inFlight = true;
  void fetchTable(state.patch, purchasable).then(async (table) => {
    if (refresh !== state) return;
    current = compile(table, "communitydragon");
    state.done = true;
    await writeJsonAtomic(cachePath(state.patch), table).catch((error) => console.warn(`[item-groups] cache write failed: ${error instanceof Error ? error.message : error}`));
  }).catch((error) => {
    state.failures += 1;
    state.retryAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (state.failures - 1));
    if (state.failures === 1) console.warn(`[item-groups] CommunityDragon fetch failed (${error instanceof Error ? error.message : error}); using ${active().table.patch} groups, retrying with back-off.`);
  }).finally(() => { state.inFlight = false; });
}

/**
 * Makes sure the table for this Data Dragon patch is loaded or loading. Never blocks on the network: the returned promise
 * settles once the disk cache has been checked (HELP ME awaits it; the poll does not). Call again on every poll: a
 * patch change restarts the refresh, a failed fetch retries after its back-off.
 */
export function ensureItemGroups(patch: string, purchasable?: (id: number) => boolean): Promise<void> {
  if (!patch) return Promise.resolve();
  if (!refresh || refresh.patch !== patch) {
    const state: Refresh = { patch, disk: null, inFlight: false, failures: 0, retryAt: 0, done: false };
    refresh = state;
    state.disk = readFile(cachePath(patch), "utf8").then((text) => {
      const table = JSON.parse(text) as ItemGroupTable;
      if (refresh === state && table.groups && Object.keys(table.groups).length) { current = compile(table, "cache"); state.done = true; }
    }).catch(() => undefined).then(() => { if (refresh === state) startNetwork(state, purchasable); });
    return state.disk;
  }
  if (!refresh.done) startNetwork(refresh, purchasable);
  return refresh.disk || Promise.resolve();
}

export function groupsOf(itemId: number): readonly ItemGroup[] {
  return active().byItem.get(itemId) || [];
}

type Held = Map<number, number> | Iterable<number> | ReadonlyArray<{ id: number; count?: number }>;

function toCounts(held: Held): Map<number, number> {
  if (held instanceof Map) return new Map(held);
  const counts = new Map<number, number>();
  for (const entry of held as Iterable<number | { id: number; count?: number }>) {
    const [id, count] = typeof entry === "number" ? [entry, 1] : [entry.id, Math.max(1, entry.count || 1)];
    counts.set(id, (counts.get(id) || 0) + count);
  }
  return counts;
}

/** Removes the owned pieces the shop would use up when `id` is bought (same walk as the engine's consumeOwned). */
function consume(id: number, stock: Map<number, number>, recipe: (id: number) => readonly number[] | undefined, depth = 0) {
  for (const child of recipe(id) || []) {
    const count = stock.get(child) || 0;
    if (count > 0) stock.set(child, count - 1);
    else if (depth < 3) consume(child, stock, recipe, depth + 1);
  }
}

/**
 * Would buying `itemId` exceed an exclusive group? `owned` = the inventory (Map of counts, ids with repeats, or items with
 * counts); `planned` = items bought before it (earlier path steps, earlier purchases this trip), in order. With `recipe`,
 * components a purchase uses up stop counting (owning the Last Whisper component does not block Lord Dominik's Regards,
 * which is built from it, but does block Black Cleaver). Returns the first group that would overflow, else null.
 */
export function conflict(itemId: number, owned: Held, planned: readonly number[] = [], recipe?: (id: number) => readonly number[] | undefined): GroupConflict | null {
  const all = conflicts(itemId, owned, planned, recipe);
  // A group the inventory already fills is the more useful explanation than one an earlier plan fills.
  return all.find((entry) => entry.owned) || all[0] || null;
}

/** Every group that buying `itemId` would overflow (see conflict). */
export function conflicts(itemId: number, owned: Held, planned: readonly number[] = [], recipe?: (id: number) => readonly number[] | undefined): GroupConflict[] {
  const groups = groupsOf(itemId);
  if (!groups.length) return [];
  const ownedStock = toCounts(owned);
  const stock = new Map(ownedStock);
  for (const id of planned) {
    if (id === itemId) continue;
    if (recipe) consume(id, stock, recipe);
    stock.set(id, (stock.get(id) || 0) + 1);
  }
  if (recipe) consume(itemId, stock, recipe);
  const isOwned = (id: number) => (ownedStock.get(id) || 0) > 0;
  const out: GroupConflict[] = [];
  for (const group of groups) {
    const blocking: number[] = [];
    let held = 0;
    for (const [id, count] of stock) {
      if (count <= 0 || !group.items.has(id)) continue;
      held += count;
      blocking.push(id);
    }
    if (held + 1 <= group.max) continue;
    blocking.sort((left, right) => Number(isOwned(right)) - Number(isOwned(left)));
    out.push({ group: group.key, label: group.label, max: group.max, blocking, owned: blocking.some(isOwned) });
  }
  return out;
}

/**
 * Groups the owned items fill (held >= max), with every other purchasable member that is therefore locked. With `recipe`,
 * members built from the owned piece are not locked (owning the Last Whisper component still allows Lord Dominik's Regards).
 */
export function filledGroups(owned: Held, purchasable?: (id: number) => boolean, recipe?: (id: number) => readonly number[] | undefined): Array<{ group: string; label: string; max: number; owned: number[]; locked: number[] }> {
  const stock = toCounts(owned);
  const seen = new Set<string>();
  const out: Array<{ group: string; label: string; max: number; owned: number[]; locked: number[] }> = [];
  for (const id of stock.keys()) {
    for (const group of groupsOf(id)) {
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      const held = [...stock].filter(([member, count]) => count > 0 && group.items.has(member));
      if (held.reduce((sum, [, count]) => sum + count, 0) < group.max) continue;
      const locked = [...group.items].filter((member) => !stock.has(member) && (!purchasable || purchasable(member))
        && conflicts(member, stock, [], recipe).some((entry) => entry.group === group.key));
      if (locked.length) out.push({ group: group.key, label: group.label, max: group.max, owned: held.map(([member]) => member), locked });
    }
  }
  return out;
}

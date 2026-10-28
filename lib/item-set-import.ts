import { championByNumericKey, loadChampionIndex, type ChampionIndex } from "@/lib/champion-data";
import { lcuJson } from "@/lib/lcu";
import { getItemCatalog, type ItemCatalog, type ItemInfo } from "@/lib/live-game";
import { championKey, importedBuildsPath, isUpgradedBoots, readJson, writeJsonAtomic } from "@/lib/memory-store";
import type { ImportedBuild } from "@/lib/types";

/**
 * League-client item sets (lol-item-sets) captured while they exist. Mobalytics (via Overwolf) pushes its build into the
 * client as an item set during champ select and removes it afterwards, so we copy it into memory and never delete it.
 */
export type RawItemSet = {
  uid?: string;
  title?: string;
  associatedChampions?: Array<number | string>;
  associatedMaps?: Array<number | string>;
  blocks?: Array<{ type?: string; items?: Array<{ id?: string | number; count?: number }> }>;
};
export type StoredImport = ImportedBuild & { mobalytics: boolean; uid: string | null };
type ImportFile = { version: 1; updatedAt: string; builds: Record<string, StoredImport>; seen: Record<string, string> };
type ChampSelectSession = { localPlayerCellId?: number; myTeam?: Array<{ cellId?: number; championId?: number; championPickIntent?: number }> };
export type CaptureResult = { ok: boolean; reason: string | null; sets: number; picked: string | null; captured: string[] };
type ParseContext = { catalog: ItemCatalog; index: ChampionIndex | null; pickedChampion: string | null; capturedAt: string };
type Candidate = StoredImport & { setKey: string; order: number };

const CONSUMABLE_BLOCK = /consumable|potion|elixir|\bwards?\b|trinket|biscuit/i;
const STARTING_BLOCK = /start|opening|early|first back|laning phase/i;
const SITUATIONAL_BLOCK = /situational|optional|option|extra|alternative|\balt\b|swap|counter|defensive|\bvs\.?\b|against|luxury|replace|if /i;
const BOOTS_BLOCK = /boots|shoes/i;
const MOBALYTICS = /mobalytics/i;
// Other build tools that push untagged sets in champ select; only these may inherit the champion being picked.
const TOOL_TITLE = /mobalytics|mobafire|u\.gg|op\.gg|blitz|porofessor|overwolf|lolalytics|metasrc|ugg/i;
const MAX_ITEMS = 8;
const RELOAD_MS = 30_000;

type ImportState = { file: ImportFile | null; loadedAt: number; revision: number; lastRun: number; running: boolean; failures: number };
const globalStore = globalThis as typeof globalThis & { __riftLensImportsV1?: ImportState };
const state: ImportState = globalStore.__riftLensImportsV1 ??= { file: null, loadedAt: 0, revision: 0, lastRun: 0, running: false, failures: 0 };

const emptyFile = (): ImportFile => ({ version: 1, updatedAt: new Date(0).toISOString(), builds: {}, seen: {} });

function resolveId(catalog: ItemCatalog, raw: unknown): ItemInfo | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  // Mode-specific copies (e.g. 223032 = Arena Yun Tal) map back to the Summoner's Rift id.
  return catalog.byId.get(id) || (id > 100000 ? catalog.byId.get(id % 10000) || null : null);
}

const isConsumable = (item: ItemInfo) => (item.tags || []).some((tag) => tag === "Consumable" || tag === "Trinket") || item.cost <= 0;
const isBoots = (item: ItemInfo) => isUpgradedBoots(item.name) || ((item.tags || []).includes("Boots") && item.cost > 300);
/** Legendary-tier (≥ 2000g) or tier-2 boots. */
export const isCompletedImport = (item: ItemInfo) => !isConsumable(item) && (isBoots(item) || item.cost >= 2000);

function blockKind(type = "", items: ItemInfo[]): "consumable" | "starting" | "situational" | "boots" | "core" {
  if (items.length && items.every(isConsumable)) return "consumable";
  if (CONSUMABLE_BLOCK.test(type) && !/build|core/i.test(type)) return "consumable";
  if (STARTING_BLOCK.test(type)) return "starting";
  if (SITUATIONAL_BLOCK.test(type)) return "situational";
  if (BOOTS_BLOCK.test(type) && items.every(isBoots)) return "boots";
  return "core";
}

function championsInTitle(title: string, index: ChampionIndex | null) {
  if (!index || !title) return [];
  const words = ` ${title.toLowerCase().replace(/['’.&]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
  const found = new Map<string, number>();
  for (const entry of new Set(index.values())) {
    for (const name of [entry.name, entry.id]) {
      const needle = ` ${name.toLowerCase().replace(/['’.&]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
      const at = words.indexOf(needle);
      if (needle.trim() && at >= 0 && !found.has(entry.name)) found.set(entry.name, at);
    }
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

function setChampions(set: RawItemSet, ctx: ParseContext): string[] {
  const named = (set.associatedChampions || []).map((id) => championByNumericKey(ctx.index, Number(id))?.name).filter((name): name is string => Boolean(name));
  if (named.length) return [...new Set(named)];
  const title = set.title || "";
  const inTitle = championsInTitle(title, ctx.index);
  if (inTitle.length) return inTitle.slice(0, 1);
  return ctx.pickedChampion && TOOL_TITLE.test(title) ? [ctx.pickedChampion] : [];
}

/** Parses one client item set into an ordered build. Returns null when it holds no completed items. */
export function parseItemSet(set: RawItemSet, catalog: ItemCatalog): Pick<ImportedBuild, "items" | "starting" | "situational"> | null {
  const core: string[] = [];
  const boots: string[] = [];
  const starting: string[] = [];
  const situational: string[] = [];
  const push = (list: string[], name: string) => { if (!list.includes(name)) list.push(name); };
  for (const block of set.blocks || []) {
    const items = (block.items || []).map((entry) => resolveId(catalog, entry.id)).filter((item): item is ItemInfo => Boolean(item));
    const kind = blockKind(block.type, items);
    if (kind === "consumable") continue;
    for (const item of items) {
      if (kind === "starting") { if (!isConsumable(item)) push(starting, item.name); continue; }
      if (!isCompletedImport(item)) continue;
      if (kind === "situational") push(situational, item.name);
      else if (kind === "boots") push(boots, item.name);
      else push(core, item.name);
    }
  }
  // A separate boots block is usually bought around the first completed item: slot one pair in after it.
  const items = [...core];
  if (boots.length && !items.some((name) => boots.includes(name))) items.splice(Math.min(1, items.length), 0, boots[0]);
  const path = [...new Set(items)].slice(0, MAX_ITEMS);
  if (!path.length) return null;
  return { items: path, starting: starting.slice(0, 6), situational: situational.filter((name) => !path.includes(name)).slice(0, 8) };
}

const setKey = (set: RawItemSet) => set.uid || `${set.title || ""}|${(set.associatedChampions || []).join(",")}`;

function candidates(sets: RawItemSet[], ctx: ParseContext): Candidate[] {
  return sets.flatMap((set, order) => {
    const maps = (set.associatedMaps || []).map(Number).filter((map) => map > 0);
    if (maps.length && !maps.includes(11)) return [];
    const parsed = parseItemSet(set, ctx.catalog);
    if (!parsed) return [];
    const title = (set.title || "Untitled item set").replace(/\s+/g, " ").trim().slice(0, 80);
    return setChampions(set, ctx).map((champion) => ({
      champion, title, capturedAt: ctx.capturedAt, ...parsed, mobalytics: MOBALYTICS.test(title), uid: set.uid || null, setKey: setKey(set), order,
    }));
  });
}

/** One set per champion: Mobalytics-titled first, then the most recently appeared set, then the fuller one. */
export function selectImports(sets: RawItemSet[], ctx: ParseContext, seen: Record<string, string> = {}): Candidate[] {
  const best = new Map<string, Candidate>();
  const firstSeen = (candidate: Candidate) => seen[candidate.setKey] || ctx.capturedAt;
  for (const candidate of candidates(sets, ctx)) {
    const id = championKey(candidate.champion);
    const current = best.get(id);
    const better = !current
      || Number(candidate.mobalytics) - Number(current.mobalytics)
      || firstSeen(candidate).localeCompare(firstSeen(current))
      || candidate.items.length - current.items.length
      || candidate.order - current.order;
    if (!current || (typeof better === "number" && better > 0)) best.set(id, candidate);
  }
  return [...best.values()];
}

async function loadFile(force = false): Promise<ImportFile> {
  if (state.file && !force && Date.now() - state.loadedAt < RELOAD_MS) return state.file;
  const stored = await readJson<Partial<ImportFile>>(importedBuildsPath());
  const file = emptyFile();
  if (stored && typeof stored === "object") {
    file.updatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : file.updatedAt;
    for (const [champion, entry] of Object.entries(stored.builds || {})) {
      if (!entry || !Array.isArray(entry.items) || !entry.items.length) continue;
      const strings = (value: unknown) => Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
      file.builds[champion] = {
        champion: typeof entry.champion === "string" ? entry.champion : champion,
        title: typeof entry.title === "string" ? entry.title : "Item set",
        capturedAt: typeof entry.capturedAt === "string" ? entry.capturedAt : file.updatedAt,
        items: strings(entry.items), starting: strings(entry.starting), situational: strings(entry.situational),
        mobalytics: Boolean(entry.mobalytics), uid: typeof entry.uid === "string" ? entry.uid : null,
      };
    }
    if (stored.seen && typeof stored.seen === "object") file.seen = Object.fromEntries(Object.entries(stored.seen).filter(([, at]) => typeof at === "string"));
  }
  if (JSON.stringify(file.builds) !== JSON.stringify(state.file?.builds || {})) state.revision += 1;
  state.file = file;
  state.loadedAt = Date.now();
  return file;
}

/** Stored imports keyed by champion display name. */
export async function readImportedBuilds(): Promise<Record<string, StoredImport>> {
  return (await loadFile()).builds;
}

export async function importedBuildFor(champion: string): Promise<ImportedBuild | null> {
  const builds = await readImportedBuilds();
  const match = Object.keys(builds).find((name) => championKey(name) === championKey(champion));
  if (!match) return null;
  const { champion: name, title, capturedAt, items, starting, situational } = builds[match];
  return { champion: name, title, capturedAt, items, starting, situational };
}

/** Bumps whenever the stored imports change; part of the player-brief cache key. */
export const importsRevision = () => state.revision;

function pickedChampion(session: ChampSelectSession | null, index: ChampionIndex | null) {
  const me = session?.myTeam?.find((member) => member.cellId === session.localPlayerCellId);
  const id = me?.championId || me?.championPickIntent || 0;
  return id ? championByNumericKey(index, id)?.name || null : null;
}

/** One read-only pass over the client's item sets; persists new/changed builds. Never throws. */
export async function captureItemSets(): Promise<CaptureResult> {
  const result: CaptureResult = { ok: false, reason: null, sets: 0, picked: null, captured: [] };
  try {
    const summoner = await lcuJson<{ summonerId?: number }>("/lol-summoner/v1/current-summoner");
    if (!summoner?.summonerId) return { ...result, reason: "League client is not running or not logged in." };
    const [payload, session] = await Promise.all([
      lcuJson<{ itemSets?: RawItemSet[] }>(`/lol-item-sets/v1/item-sets/${summoner.summonerId}/sets`),
      lcuJson<ChampSelectSession>("/lol-champ-select/v1/session"),
    ]);
    if (!payload) return { ...result, reason: "Item sets endpoint did not respond." };
    const sets = Array.isArray(payload.itemSets) ? payload.itemSets : [];
    const catalog = await getItemCatalog();
    // The offline fallback catalog has no recipes and few items; parsing against it would store truncated builds.
    if (catalog.byId.size < 100) return { ...result, sets: sets.length, reason: "Item data unavailable; skipped." };
    const index = await loadChampionIndex(catalog.version);
    const capturedAt = new Date().toISOString();
    const picked = pickedChampion(session, index);
    const file = await loadFile(true);
    let changed = false;
    for (const set of sets) {
      const id = setKey(set);
      if (!file.seen[id]) { file.seen[id] = capturedAt; changed = true; }
    }
    for (const candidate of selectImports(sets, { catalog, index, pickedChampion: picked, capturedAt }, file.seen)) {
      const existingName = Object.keys(file.builds).find((name) => championKey(name) === championKey(candidate.champion));
      const existing = existingName ? file.builds[existingName] : null;
      const { setKey: candidateKey, order: _order, ...entry } = candidate;
      void _order;
      if (existing && JSON.stringify([existing.title, existing.items, existing.starting, existing.situational]) === JSON.stringify([entry.title, entry.items, entry.starting, entry.situational])) continue;
      // A permanent custom set must not overwrite a captured Mobalytics push, and only sets that appeared after the stored capture replace it.
      const sameSet = Boolean(existing && ((existing.uid && existing.uid === entry.uid) || existing.title === entry.title));
      if (existing && !sameSet) {
        if (existing.mobalytics && !entry.mobalytics) continue;
        if (!(entry.mobalytics && !existing.mobalytics) && (file.seen[candidateKey] || capturedAt) < existing.capturedAt) continue;
      }
      if (existingName && existingName !== entry.champion) delete file.builds[existingName];
      file.builds[entry.champion] = entry;
      result.captured.push(`${entry.champion}: ${entry.title}`);
      changed = true;
    }
    // Keep the seen-set ledger bounded.
    const seen = Object.entries(file.seen).sort((a, b) => b[1].localeCompare(a[1]));
    if (seen.length > 200) { file.seen = Object.fromEntries(seen.slice(0, 200)); changed = true; }
    if (changed) {
      file.updatedAt = capturedAt;
      await writeJsonAtomic(importedBuildsPath(), file);
      if (result.captured.length) state.revision += 1;
      state.file = file;
      state.loadedAt = Date.now();
      for (const line of result.captured) console.info(`[rift-lens] captured League client item set → ${line}`);
    }
    return { ok: true, reason: null, sets: sets.length, picked, captured: result.captured };
  } catch (error) {
    return { ...result, reason: error instanceof Error ? error.message : "Item-set capture failed." };
  }
}

/** Throttled fire-and-forget capture for the live poll: ~10s while no game is running (champ select), ~60s in game. */
export function scheduleItemSetCapture(phase: "offline" | "live") {
  try {
    const now = Date.now();
    const interval = Math.max(phase === "live" ? 60_000 : 10_000, Math.min(state.failures, 6) * 10_000);
    if (state.running || now - state.lastRun < interval) return;
    state.lastRun = now;
    state.running = true;
    void captureItemSets()
      .then((outcome) => { state.failures = outcome.ok ? 0 : state.failures + 1; })
      .catch(() => { state.failures += 1; })
      .finally(() => { state.running = false; });
  } catch { state.running = false; }
}

export type ItemOption = { id: number; name: string; cost: number };
export type ProfileImports = { imports: Record<string, StoredImport>; catalog: { version: string; items: ItemOption[] } };

/** Stored imports + completed items/tier-2 boots for the /profile build editor (search + icons). */
export async function profileImports(): Promise<ProfileImports> {
  const [imports, catalog] = await Promise.all([readImportedBuilds(), getItemCatalog()]);
  const items = [...catalog.byId.values()].filter(isCompletedImport).map(({ id, name, cost }) => ({ id, name, cost })).sort((a, b) => a.name.localeCompare(b.name));
  return { imports, catalog: { version: catalog.version, items } };
}

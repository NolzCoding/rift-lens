import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GameRecord, PlayerFocus, PlayerPreferences, PlayerProfile } from "@/lib/types";

export type ProfileSettings = { preferences: PlayerPreferences; focus: PlayerFocus | null };

/** The player's data (games, settings, research, caches): `data/` in the app folder unless RIFT_LENS_MEMORY_DIR says otherwise. Never in git. */
export function memoryRoot() {
  return path.resolve(process.env.RIFT_LENS_MEMORY_DIR || path.join(process.cwd(), "data"));
}

const gamesDir = () => path.join(memoryRoot(), "games");
const profilePath = () => path.join(memoryRoot(), "profile.json");
const settingsPath = () => path.join(memoryRoot(), "profile-settings.json");
/** League-client item sets (e.g. Mobalytics imports) captured per champion; see lib/item-set-import.ts. */
export const importedBuildsPath = () => path.join(memoryRoot(), "imported-builds.json");
/** Compact copies of the League client's match history (final items, K/D/A, result); see lib/history-import.ts. */
export const historyImportPath = () => path.join(memoryRoot(), "history-import.json");

export function emptySettings(): ProfileSettings {
  return { preferences: { notes: [], preferredItems: {}, avoidItems: {}, builds: {} }, focus: null };
}

export function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80) || "unknown";
}

export async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, file); return; } catch (error) {
      // Windows can briefly refuse the replace while another reader holds the file.
      if (attempt >= 4) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}

export const gameRecordPath = (id: string) => path.join(gamesDir(), `${safeId(id)}.json`);
export const writeGameRecord = (record: GameRecord) => writeJsonAtomic(gameRecordPath(record.id), record);

export async function listGameFiles() {
  try { return (await readdir(gamesDir())).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
}

function validRecord(value: unknown): value is GameRecord {
  const record = value as Partial<GameRecord> | null;
  return Boolean(record && typeof record.id === "string" && typeof record.champion === "string" && record.final && Array.isArray(record.deaths) && Array.isArray(record.purchases));
}

export async function readGameRecord(file: string): Promise<GameRecord | null> {
  const record = await readJson<GameRecord>(path.join(gamesDir(), file));
  return validRecord(record) ? record : null;
}

export async function listGameRecords(): Promise<GameRecord[]> {
  const records = await Promise.all((await listGameFiles()).map(readGameRecord));
  return records.filter((record): record is GameRecord => Boolean(record)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function readSettings(): Promise<ProfileSettings> {
  const stored = await readJson<Partial<ProfileSettings>>(settingsPath());
  const base = emptySettings();
  if (!stored) return base;
  const preferences = stored.preferences || base.preferences;
  return {
    preferences: {
      notes: Array.isArray(preferences.notes) ? preferences.notes.filter((note) => typeof note === "string") : [],
      preferredItems: preferences.preferredItems && typeof preferences.preferredItems === "object" ? preferences.preferredItems : {},
      avoidItems: preferences.avoidItems && typeof preferences.avoidItems === "object" ? preferences.avoidItems : {},
      // Older settings files have no `builds`.
      builds: preferences.builds && typeof preferences.builds === "object" && !Array.isArray(preferences.builds) ? preferences.builds : {},
    },
    focus: stored.focus && typeof stored.focus.title === "string" ? stored.focus : null,
  };
}

export const writeSettings = (settings: ProfileSettings) => writeJsonAtomic(settingsPath(), settings);
export const readProfileFile = () => readJson<PlayerProfile>(profilePath());
export const writeProfileFile = (profile: PlayerProfile) => writeJsonAtomic(profilePath(), profile);

export function championKey(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Tier-2+ boots by display name (excludes plain "Boots"). */
export function isUpgradedBoots(name: string) {
  return /greaves|sorcerer's shoes|steelcaps|treads|lucidity|swiftness|symbiotic soles|synchronized souls|spellslinger|crushers|armored advance|swiftmarch|forever forward/i.test(name);
}

// ---------------------------------------------------------------------------
// Record interpretation shared by the recorder (write time) and the profile (read time, for older records).
// ---------------------------------------------------------------------------

/** A game that ended before 3:00 is a remake / early end: no result and no stats. */
export const REMAKE_SECONDS = 180;
/** First live sample later than this (page opened late) makes the record partial. */
export const LATE_START_SECONDS = 120;
/** A gap this long between two live samples makes the record partial (purchases/CS@10 may be missing). */
export const FEED_GAP_SECONDS = 90;
/** Purchases before this game time are the starting buy, not a back. */
const START_WINDOW_SECONDS = 90;
/** One shop visit: purchases within this many seconds of the first post-start purchase. */
const SHOP_VISIT_SECONDS = 45;

export const TRINKET_IDS = new Set([3340, 3363, 3364, 3330, 3513]);
export const CONSUMABLE_IDS = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 2150, 2151, 2152]);
export const isTrinketItem = (item: { id: number; name: string }) => TRINKET_IDS.has(item.id) || /totem|oracle lens|farsight|scarecrow|poro-snax/i.test(item.name);
export const isConsumableItem = (item: { id: number; name: string }) => CONSUMABLE_IDS.has(item.id) || /potion|elixir|biscuit|control ward|cookie/i.test(item.name);

/** Ended records only: stored flag first, else the duration rule (older records have no flag). */
export function isRemake(record: Pick<GameRecord, "remake" | "durationSeconds">) {
  return record.remake ?? record.durationSeconds < REMAKE_SECONDS;
}

/** Stored flag first; for older records, a missing starting buy means the recorder joined after the start. */
export function isPartial(record: Pick<GameRecord, "partial" | "purchases" | "durationSeconds">) {
  if (record.partial !== undefined) return record.partial;
  return record.durationSeconds > LATE_START_SECONDS && !record.purchases.some((entry) => entry.kind === "bought" && entry.time <= LATE_START_SECONDS);
}

/**
 * The first shop visit after the starting buy: non-consumable purchases within one visit of the first post-start purchase.
 * Null when there is no recorded starting buy (joined late) or no back yet.
 */
export function deriveFirstBack(record: Pick<GameRecord, "purchases">): string[] | null {
  const bought = record.purchases.filter((entry) => entry.kind === "bought");
  if (!bought.some((entry) => entry.time < START_WINDOW_SECONDS)) return null;
  const real = bought.filter((entry) => entry.time >= START_WINDOW_SECONDS && !isConsumableItem({ id: entry.itemId, name: entry.item }) && !isTrinketItem({ id: entry.itemId, name: entry.item }));
  if (!real.length) return null;
  const start = real[0].time;
  return real.filter((entry) => entry.time - start <= SHOP_VISIT_SECONDS).map((entry) => entry.item);
}

/** Modes whose itemization or lanes do not transfer to Summoner's Rift stats. */
export function isOffRiftMode(record: Pick<GameRecord, "mode" | "modeLabel">) {
  return /aram|arena|cherry|urf|nexusblitz|ultbook|swarm|strawberry|brawl/i.test(`${record.mode} ${record.modeLabel}`);
}

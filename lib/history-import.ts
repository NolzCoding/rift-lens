import { championByNumericKey, loadChampionIndex, type ChampionIndex } from "@/lib/champion-data";
import { lcuJson } from "@/lib/lcu";
import { getItemCatalog, type ItemCatalog, type ItemInfo } from "@/lib/live-game";
import { historyImportPath, isConsumableItem, isTrinketItem, isUpgradedBoots, readJson, writeJsonAtomic } from "@/lib/memory-store";

/**
 * Games from the League client's own match history (lol-match-history), so builds are learned from every match and not
 * only from the ones played with /live open. The client keeps final inventories but no purchase events, so an imported
 * game knows WHICH items were finished, never in what order. Read-only GETs; each game's detail is fetched once.
 */
export type HistoryGame = {
  gameId: number;
  /** Lobby creation time (ms); the recorded GameRecord.startedAt of the same match is usually within a minute of it. */
  gameCreation: number;
  durationSeconds: number;
  queueId: number;
  mode: string;
  mapId: number;
  champion: string;
  championId: number;
  /** TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY from the client's inferred lane; null when none, and always null in Swiftplay. */
  position: string | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  /** Completed (≥ 2000g, not a component) items in inventory-slot order; boots, trinkets and consumables left out. */
  items: string[];
  /** Tier-2+ boots in the final inventory. */
  boots: string | null;
  laneOpponent: string | null;
  allies: string[];
  enemies: string[];
  importedAt: string;
};

type HistoryFile = { version: 1; updatedAt: string; games: HistoryGame[]; skipped: Record<string, string> };
export type HistoryImportResult = { ok: boolean; reason: string | null; listed: number; added: number; stored: number };

type RawParticipant = {
  participantId?: number;
  teamId?: number;
  championId?: number;
  timeline?: { lane?: string; role?: string };
  stats?: Record<string, number | boolean | undefined>;
};
type RawGame = {
  gameId?: number;
  gameCreation?: number;
  gameDuration?: number;
  gameMode?: string;
  gameType?: string;
  queueId?: number;
  mapId?: number;
  participants?: RawParticipant[];
  participantIdentities?: Array<{ participantId?: number; player?: { puuid?: string } }>;
};
type RawHistory = { games?: { games?: RawGame[] } };

const PAGE = 50;
const MAX_LISTED = 100;
const MAX_STORED = 300;
/** Games shorter than this are remakes / early ends (same rule as recorded games). */
const MIN_SECONDS = 180;
const RUN_EVERY_MS = 10 * 60_000;
/** Client closed / not logged in / item data missing: try again sooner, still quietly. */
const RETRY_MS = 2 * 60_000;
/** An explicit profile rebuild re-imports unless an import ran within this long. */
const REBUILD_FRESH_MS = 60_000;
const NOT_REAL_MODE = /practicetool|tutorial/i;

type ImportState = { running: Promise<HistoryImportResult> | null; lastRun: number; delay: number; last: HistoryImportResult | null };
const globalStore = globalThis as typeof globalThis & { __riftLensHistoryV1?: ImportState };
const state: ImportState = globalStore.__riftLensHistoryV1 ??= { running: null, lastRun: 0, delay: 0, last: null };

const emptyFile = (): HistoryFile => ({ version: 1, updatedAt: new Date(0).toISOString(), games: [], skipped: {} });
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function validGame(value: unknown): value is HistoryGame {
  const game = value as Partial<HistoryGame> | null;
  return Boolean(game && typeof game.gameId === "number" && typeof game.gameCreation === "number" && typeof game.champion === "string"
    && typeof game.win === "boolean" && Array.isArray(game.items));
}

async function loadFile(): Promise<HistoryFile> {
  const stored = await readJson<Partial<HistoryFile>>(historyImportPath());
  const file = emptyFile();
  if (!stored || typeof stored !== "object") return file;
  file.updatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : file.updatedAt;
  file.games = (Array.isArray(stored.games) ? stored.games : []).filter(validGame).map((game) => ({
    ...game, items: strings(game.items), allies: strings(game.allies), enemies: strings(game.enemies),
    boots: typeof game.boots === "string" ? game.boots : null, laneOpponent: typeof game.laneOpponent === "string" ? game.laneOpponent : null,
  }));
  if (stored.skipped && typeof stored.skipped === "object") {
    file.skipped = Object.fromEntries(Object.entries(stored.skipped).filter(([, reason]) => typeof reason === "string"));
  }
  return file;
}

/** Stored match-history games, oldest first. Empty when nothing was imported yet. */
export async function readHistoryGames(): Promise<HistoryGame[]> {
  return (await loadFile()).games.sort((a, b) => a.gameCreation - b.gameCreation);
}

async function saveFile(file: HistoryFile) {
  file.games.sort((a, b) => a.gameCreation - b.gameCreation);
  if (file.games.length > MAX_STORED) file.games = file.games.slice(-MAX_STORED);
  const skipped = Object.entries(file.skipped);
  if (skipped.length > MAX_STORED) file.skipped = Object.fromEntries(skipped.slice(-MAX_STORED));
  file.updatedAt = new Date().toISOString();
  await writeJsonAtomic(historyImportPath(), file);
}

/** Summoner's Rift-style matchmade games only: no Practice Tool, customs, tutorials or remakes. */
export function isRealMatch(game: RawGame) {
  return game.gameType === "MATCHED_GAME" && !NOT_REAL_MODE.test(game.gameMode || "") && num(game.gameDuration) >= MIN_SECONDS;
}

function resolveItem(catalog: ItemCatalog, raw: unknown): ItemInfo | null {
  const id = num(raw);
  if (id <= 0) return null;
  // Mode copies (e.g. 323075) map back to the Summoner's Rift id.
  return catalog.byId.get(id) || (id > 100000 ? catalog.byId.get(id % 10000) || null : null);
}

/** Same rule as the recorder: ≥ 2000g and not a component of another Summoner's Rift item; boots are counted separately. */
function isFinished(item: ItemInfo) {
  if (isUpgradedBoots(item.name) || /^boots$/i.test(item.name) || isConsumableItem(item) || isTrinketItem(item)) return false;
  return item.cost >= 2000 && !(item.into || []).length;
}

function positionOf(participant: RawParticipant) {
  const lane = (participant.timeline?.lane || "").toUpperCase();
  const role = (participant.timeline?.role || "").toUpperCase();
  if (lane === "TOP") return "TOP";
  if (lane === "JUNGLE") return "JUNGLE";
  if (lane === "MIDDLE" || lane === "MID") return "MIDDLE";
  if (lane === "BOTTOM" || lane === "BOT") return role === "DUO_SUPPORT" ? "UTILITY" : "BOTTOM";
  return null;
}

type Parsed = { game: HistoryGame } | { skip: string } | { retry: string };

/** One match-history detail → compact record for the list entry's player (participants[0] of the list entry). */
export function parseHistoryGame(entry: RawGame, detail: RawGame, catalog: ItemCatalog, index: ChampionIndex): Parsed {
  const listed = entry.participants?.[0];
  const puuid = entry.participantIdentities?.[0]?.player?.puuid;
  const participants = detail.participants || [];
  const byPuuid = puuid ? detail.participantIdentities?.find((identity) => identity.player?.puuid === puuid)?.participantId : undefined;
  const participantId = byPuuid ?? listed?.participantId;
  const me = participants.find((participant) => participant.participantId === participantId);
  if (!me || !me.championId || (listed?.championId && listed.championId !== me.championId)) return { skip: "player not found in game detail" };
  const nameOf = (participant: RawParticipant) => championByNumericKey(index, num(participant.championId))?.name || null;
  const champion = nameOf(me);
  if (!champion) return { retry: "champion list unavailable" };
  const stats = me.stats || {};
  const items: string[] = [];
  let boots: string | null = null;
  for (let slot = 0; slot <= 6; slot += 1) {
    const item = resolveItem(catalog, stats[`item${slot}`]);
    if (!item) continue;
    if (isUpgradedBoots(item.name)) boots ||= item.name;
    else if (isFinished(item) && !items.includes(item.name)) items.push(item.name);
  }
  const allies = participants.filter((participant) => participant !== me && participant.teamId === me.teamId);
  const enemyList = participants.filter((participant) => participant.teamId !== me.teamId);
  // The client infers lanes from movement; in Swiftplay that is unreliable (a bot-lane Caitlyn shows up as MIDDLE vs Irelia).
  const position = /swift/i.test(detail.gameMode || entry.gameMode || "") ? null : positionOf(me);
  const facing = position ? enemyList.filter((participant) => positionOf(participant) === position) : [];
  return {
    game: {
      gameId: num(detail.gameId || entry.gameId),
      gameCreation: num(detail.gameCreation || entry.gameCreation),
      durationSeconds: num(detail.gameDuration ?? entry.gameDuration),
      queueId: num(detail.queueId ?? entry.queueId),
      mode: detail.gameMode || entry.gameMode || "",
      mapId: num(detail.mapId ?? entry.mapId),
      champion,
      championId: me.championId,
      position,
      win: stats.win === true,
      kills: num(stats.kills),
      deaths: num(stats.deaths),
      assists: num(stats.assists),
      cs: num(stats.totalMinionsKilled) + num(stats.neutralMinionsKilled),
      items,
      boots,
      laneOpponent: facing.length === 1 ? nameOf(facing[0]) : null,
      allies: allies.map(nameOf).filter((name): name is string => Boolean(name)),
      enemies: enemyList.map(nameOf).filter((name): name is string => Boolean(name)),
      importedAt: new Date().toISOString(),
    },
  };
}

/**
 * One read-only pass: list up to ~100 recent games, fetch the detail of each new real match once, store it.
 * Never throws; stops quietly when the client goes away.
 */
export async function importMatchHistory(): Promise<HistoryImportResult> {
  const result: HistoryImportResult = { ok: false, reason: null, listed: 0, added: 0, stored: 0 };
  try {
    const catalog = await getItemCatalog();
    // The offline fallback catalog has no recipes; parsing against it would store wrong item lists.
    if (catalog.fallback || catalog.byId.size < 100) return { ...result, reason: "Item data unavailable; skipped." };
    const index = await loadChampionIndex(catalog.version);
    if (!index.size) return { ...result, reason: "Champion data unavailable; skipped." };

    const listed = new Map<number, RawGame>();
    for (let begin = 0; begin < MAX_LISTED; begin += PAGE) {
      const page = await lcuJson<RawHistory>(`/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${begin}&endIndex=${begin + PAGE}`, 8000);
      if (!page) {
        if (begin === 0) return { ...result, reason: "League client is not running or match history is unavailable." };
        break;
      }
      const games = page.games?.games || [];
      let fresh = 0;
      for (const game of games) {
        if (game.gameId && !listed.has(game.gameId) && listed.size < MAX_LISTED) { listed.set(game.gameId, game); fresh += 1; }
      }
      if (!fresh || games.length < PAGE) break;
    }
    result.listed = listed.size;

    const file = await loadFile();
    const known = new Set(file.games.map((game) => game.gameId));
    const todo = [...listed.values()]
      .filter((game) => isRealMatch(game) && !known.has(game.gameId!) && !file.skipped[String(game.gameId)])
      .sort((a, b) => num(b.gameCreation) - num(a.gameCreation));
    let changed = false;
    let misses = 0;
    for (const entry of todo) {
      const detail = await lcuJson<RawGame>(`/lol-match-history/v1/games/${entry.gameId}`, 5000);
      if (!detail) {
        misses += 1;
        if (misses >= 3) break; // Client closed mid-run: the rest is fetched next time.
        continue;
      }
      const parsed = parseHistoryGame(entry, detail, catalog, index);
      if ("game" in parsed) { file.games.push(parsed.game); result.added += 1; changed = true; }
      else if ("skip" in parsed) { file.skipped[String(entry.gameId)] = parsed.skip; changed = true; }
      if (changed && result.added && result.added % 10 === 0) await saveFile(file);
    }
    if (changed) await saveFile(file);
    if (result.added) console.info(`[rift-lens] imported ${result.added} game${result.added === 1 ? "" : "s"} from the League client's match history`);
    return { ...result, ok: true, stored: file.games.length };
  } catch (error) {
    return { ...result, reason: error instanceof Error ? error.message : "Match-history import failed." };
  }
}

function startRun(onNewGames?: () => unknown) {
  state.lastRun = Date.now();
  const run = importMatchHistory()
    .then((outcome) => {
      state.last = outcome;
      state.delay = outcome.ok ? RUN_EVERY_MS : RETRY_MS;
      if (outcome.added && onNewGames) void Promise.resolve().then(onNewGames).catch(() => undefined);
      return outcome;
    })
    .finally(() => { state.running = null; });
  state.running = run;
  return run;
}

/**
 * Throttled fire-and-forget import: the first call after server start runs at once, then at most every 10 minutes
 * (2 minutes while the client is down). Returns immediately; `onNewGames` runs only when games were added.
 */
export function scheduleHistoryImport(onNewGames?: () => unknown) {
  try {
    if (state.running || Date.now() - state.lastRun < state.delay) return;
    void startRun(onNewGames).catch(() => undefined);
  } catch { /* Never let the import affect the caller. */ }
}

/** For an explicit rebuild: import unless one ran in the last minute, waiting at most `waitMs` for it. */
export async function importBeforeRebuild(waitMs: number, onLateNewGames?: () => unknown) {
  try {
    if (!state.running && Date.now() - state.lastRun >= REBUILD_FRESH_MS) void startRun(onLateNewGames).catch(() => undefined);
    const running = state.running;
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running.catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
    clearTimeout(timer);
  } catch { /* A failed import never blocks the rebuild. */ }
}

/** Last import outcome in this server process (for the profile page). */
export const lastHistoryImport = () => state.last;

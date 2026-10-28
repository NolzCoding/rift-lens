import { createHash } from "node:crypto";

import { lcuLastGameResult } from "@/lib/lcu";
import {
  deriveFirstBack,
  FEED_GAP_SECONDS,
  isConsumableItem,
  isTrinketItem,
  isUpgradedBoots,
  LATE_START_SECONDS,
  listGameFiles,
  readGameRecord,
  readSettings,
  REMAKE_SECONDS,
  safeId,
  writeGameRecord,
} from "@/lib/memory-store";
import { rebuildProfile } from "@/lib/player-profile";
import type { GameRecord, GameRecordDeath, LiveGameSnapshot, LiveItem, PlayerFocus } from "@/lib/types";

type ItemInfo = { cost: number; from: number[]; into: number[] };
type Catalog = Map<number, ItemInfo>;
type Session = {
  record: GameRecord;
  items: Map<number, { name: string; count: number; price: number }>;
  wasDead: boolean;
  lastTime: number;
  lastCs: number;
  sources: Map<string, number>;
  lastWriteAt: number;
  finalized: boolean;
  /** Riot ids (or names) of all ten players, to recognise the same match under a new gameId. */
  roster: string[];
};
type RecorderState = {
  sessions: Map<string, Session>;
  activeKey: string | null;
  offlineSince: number | null;
  offlineDue: boolean;
  latest: LiveGameSnapshot | null;
  busy: boolean;
  catalog: Promise<Catalog | null> | null;
  catalogFailedAt: number;
};

const WRITE_EVERY_MS = 15_000;
const OFFLINE_FINALIZE_MS = 60_000;
const SKIPPED_MODES = /practicetool|tutorial/i;
// Automatic upgrades that are not purchases (tear items, support quest).
const TRANSFORMS: Record<number, number[]> = {
  3004: [3042], 3003: [3040], 3119: [3121], 3865: [3866], 3866: [3867], 3867: [3869, 3870, 3871, 3876, 3877],
};

const globalStore = globalThis as typeof globalThis & { __riftLensRecorderV1?: RecorderState };
const state: RecorderState = globalStore.__riftLensRecorderV1 ??= {
  sessions: new Map(), activeKey: null, offlineSince: null, offlineDue: false, latest: null, busy: false, catalog: null, catalogFailedAt: 0,
};

function loadCatalog(): Promise<Catalog | null> {
  if (state.catalog) return state.catalog;
  if (Date.now() - state.catalogFailedAt < 10 * 60_000) return Promise.resolve(null);
  state.catalog = (async () => {
    try {
      const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json", { signal: AbortSignal.timeout(3000) })).json() as string[];
      const payload = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/item.json`, { signal: AbortSignal.timeout(3000) })).json() as {
        data?: Record<string, { from?: string[]; into?: string[]; gold?: { total?: number; purchasable?: boolean } }>;
      };
      const catalog: Catalog = new Map();
      for (const [id, item] of Object.entries(payload.data || {})) {
        if (Number(id) >= 100000 || !item.gold?.purchasable) continue;
        catalog.set(Number(id), { cost: item.gold.total || 0, from: (item.from || []).map(Number), into: (item.into || []).map(Number) });
      }
      if (!catalog.size) throw new Error("Empty item catalog");
      return catalog;
    } catch {
      state.catalogFailedAt = Date.now();
      state.catalog = null;
      return null;
    }
  })();
  return state.catalog;
}

const isTrinket = (item: Pick<LiveItem, "id" | "name">) => isTrinketItem(item);
const isConsumable = (item: Pick<LiveItem, "id" | "name">) => isConsumableItem(item);

function isCompleted(item: { id: number; name: string; price: number }, catalog: Catalog | null) {
  if (isUpgradedBoots(item.name) || /^boots$/i.test(item.name) || isConsumable(item) || isTrinket(item)) return false;
  const info = catalog?.get(item.id);
  if (!info) return item.price >= 2000;
  return info.cost >= 2000 && !info.into.some((id) => catalog?.has(id));
}

function recipeTree(id: number, catalog: Catalog, seen = new Set<number>()) {
  for (const child of catalog.get(id)?.from || []) {
    if (seen.has(child)) continue;
    seen.add(child);
    recipeTree(child, catalog, seen);
  }
  return seen;
}

function inventory(items: LiveItem[]) {
  const map = new Map<number, { name: string; count: number; price: number }>();
  for (const item of items) {
    if (!item.id || isTrinket(item)) continue;
    const entry = map.get(item.id);
    if (entry) entry.count += Math.max(1, item.count);
    else map.set(item.id, { name: item.name, count: Math.max(1, item.count), price: item.price });
  }
  return map;
}

function fallbackGameId(snapshot: LiveGameSnapshot) {
  const players = [snapshot.activePlayer, ...snapshot.allies, ...snapshot.enemies].map((player) => `${player.champion}|${player.riotId || player.name}`).sort();
  return createHash("sha1").update(players.join("\n")).digest("hex").slice(0, 16);
}

const gameKey = (snapshot: LiveGameSnapshot) => safeId(snapshot.gameId || fallbackGameId(snapshot)).slice(0, 24);
const itemNames = (items: LiveItem[]) => items.filter((item) => !isTrinket(item)).map((item) => item.name);

function stamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function newRecord(snapshot: LiveGameSnapshot, key: string): GameRecord {
  const started = new Date(Date.now() - Math.max(0, snapshot.game.time) * 1000);
  return {
    id: `${stamp(started)}-${key}`,
    gameId: snapshot.gameId || key,
    startedAt: started.toISOString(),
    endedAt: null,
    champion: snapshot.activePlayer.champion,
    position: snapshot.activePlayer.position,
    mode: snapshot.game.mode,
    modeLabel: snapshot.game.modeLabel,
    result: "unknown",
    durationSeconds: 0,
    laneOpponent: snapshot.laneOpponent?.champion || null,
    allies: snapshot.allies.map((player) => player.champion),
    enemies: snapshot.enemies.map((player) => player.champion),
    final: { kills: 0, deaths: 0, assists: 0, cs: 0, level: 1, items: [] },
    purchases: [],
    deaths: [],
    csAt10: null,
    firstCompletedItem: null,
    completedItemOrder: [],
    focusResult: null,
    // Always explicit (opened after ~2:00 = partial) so the profile's read-time heuristic for older records never applies.
    partial: snapshot.game.time > LATE_START_SECONDS,
  };
}

function sessionFrom(record: GameRecord, snapshot: LiveGameSnapshot, baseline: boolean): Session {
  const active = snapshot.activePlayer;
  return {
    record,
    items: baseline ? inventory(active.items) : new Map(),
    wasDead: baseline ? active.isDead : false,
    lastTime: snapshot.game.time,
    lastCs: active.cs,
    sources: new Map(snapshot.deathSources.map((source) => [source.playerName, source.deathsTo])),
    lastWriteAt: 0,
    finalized: false,
    roster: rosterOf(snapshot),
  };
}

const rosterOf = (snapshot: LiveGameSnapshot) => [snapshot.activePlayer, ...snapshot.allies, ...snapshot.enemies].map((player) => player.riotId || player.name || "");

/**
 * gameId hashes champion names, which change mid-match (Viego possessing a champion), so a new key can still be the
 * running game: same active player, same people (one difference allowed) and a clock that continues.
 */
function sameMatch(session: Session, snapshot: LiveGameSnapshot) {
  const time = snapshot.game.time;
  if (time < session.lastTime - 60 || time > session.lastTime + 600) return false;
  const roster = rosterOf(snapshot);
  const before = session.roster ?? []; // sessions created before this field existed have none
  if (!roster[0] || roster[0] !== before[0]) return false;
  const known = new Set(before.filter(Boolean));
  const shared = roster.filter((name) => name && known.has(name)).length;
  return shared >= Math.max(2, Math.min(known.size, roster.length) - 1);
}

async function latestRecordOnDisk(key: string) {
  const file = (await listGameFiles()).filter((name) => name.endsWith(`-${key}.json`)).at(-1);
  return file ? readGameRecord(file) : null;
}

async function openSession(snapshot: LiveGameSnapshot, key: string, catalog: Catalog | null): Promise<Session> {
  const time = snapshot.game.time;
  const existing = state.sessions.get(key)?.record || await latestRecordOnDisk(key);
  // Same game continuing (server restart or reconnect after an offline finalize without a known result).
  if (existing && time >= existing.durationSeconds - 30 && (!existing.endedAt || existing.result === "unknown")) {
    existing.endedAt = null;
    existing.focusResult = null;
    // Re-opened after an offline finalize: it was not a remake after all, and anything bought in the gap is lost.
    delete existing.remake;
    delete existing.firstBack;
    if (time - existing.durationSeconds > FEED_GAP_SECONDS) existing.partial = true;
    return sessionFrom(existing, snapshot, true);
  }
  const record = newRecord(snapshot, key);
  const lateJoin = time > 90;
  const session = sessionFrom(record, snapshot, lateJoin);
  if (lateJoin) {
    // Joined mid-game: keep the current inventory as baseline; completion times are unknown.
    for (const item of snapshot.activePlayer.items) {
      if (isCompleted(item, catalog) && !record.completedItemOrder.includes(item.name)) record.completedItemOrder.push(item.name);
    }
  }
  return session;
}

function diffInventory(session: Session, snapshot: LiveGameSnapshot, catalog: Catalog | null) {
  const record = session.record;
  const time = Math.round(snapshot.game.time);
  const next = inventory(snapshot.activePlayer.items);
  const added: Array<{ id: number; name: string; price: number; count: number }> = [];
  const removed: Array<{ id: number; name: string; price: number; count: number }> = [];
  for (const [id, entry] of next) {
    const before = session.items.get(id)?.count || 0;
    if (entry.count > before) added.push({ id, name: entry.name, price: entry.price, count: entry.count - before });
  }
  for (const [id, entry] of session.items) {
    const after = next.get(id)?.count || 0;
    if (entry.count > after) removed.push({ id, name: entry.name, price: entry.price, count: entry.count - after });
  }
  session.items = next;
  if (!added.length && !removed.length) return false;

  for (const gone of removed) {
    const target = added.find((entry) => entry.count > 0 && TRANSFORMS[gone.id]?.includes(entry.id));
    if (target) { target.count -= 1; gone.count -= 1; }
  }
  const trees = catalog ? added.filter((entry) => entry.count > 0).map((entry) => recipeTree(entry.id, catalog)) : [];
  const maxAddedPrice = Math.max(0, ...added.filter((entry) => entry.count > 0 && !isConsumable(entry)).map((entry) => catalog?.get(entry.id)?.cost || entry.price));
  const restored = new Set<number>();
  for (const gone of removed) {
    if (gone.count <= 0 || isConsumable(gone)) continue;
    const consumed = catalog ? trees.some((tree) => tree.has(gone.id)) : maxAddedPrice > (gone.price || 0);
    if (consumed) continue;
    for (let index = 0; index < gone.count; index += 1) {
      const lastIndex = record.purchases.findLastIndex((entry) => entry.itemId === gone.id);
      const last = record.purchases[lastIndex];
      if (last?.kind === "bought" && time - last.time <= 20) {
        record.purchases.splice(lastIndex, 1);
        if (catalog) for (const id of recipeTree(gone.id, catalog)) restored.add(id); // undo hands the components back
        if (record.completedItemOrder.at(-1) === gone.name) record.completedItemOrder.pop();
        if (record.firstCompletedItem?.item === gone.name && !record.completedItemOrder.includes(gone.name)) record.firstCompletedItem = null;
      } else {
        record.purchases.push({ time, itemId: gone.id, item: gone.name, kind: "sold" });
      }
    }
  }
  for (const entry of added) {
    if (restored.has(entry.id)) continue;
    for (let index = 0; index < entry.count; index += 1) record.purchases.push({ time, itemId: entry.id, item: entry.name, kind: "bought" });
    if (entry.count > 0 && isCompleted(entry, catalog) && !record.completedItemOrder.includes(entry.name)) {
      record.completedItemOrder.push(entry.name);
      if (!record.firstCompletedItem && record.completedItemOrder.length === 1) record.firstCompletedItem = { item: entry.name, time };
    }
  }
  return true;
}

function killerFor(session: Session, snapshot: LiveGameSnapshot) {
  const moment = snapshot.deathMoment;
  if (moment?.killer) return { killer: moment.killer, killerChampion: moment.killerChampion || "Unknown", assisters: moment.assisters || [] };
  const source = snapshot.deathSources.find((entry) => entry.deathsTo > (session.sources.get(entry.playerName) || 0));
  if (source) return { killer: source.playerName, killerChampion: source.champion || "Unknown", assisters: [] };
  const event = snapshot.recentEvents.find((entry) => entry.tone === "bad" && entry.text.startsWith("Killed by "));
  const killer = event ? event.text.slice("Killed by ".length) : "Unknown";
  const enemy = snapshot.enemies.find((player) => player.name === killer || player.riotId === killer || player.name.split("#")[0] === killer);
  return { killer, killerChampion: enemy?.champion || "Unknown", assisters: [] };
}

function trackDeath(session: Session, snapshot: LiveGameSnapshot) {
  const active = snapshot.activePlayer;
  let changed = false;
  if (active.isDead && !session.wasDead) {
    const death: GameRecordDeath = {
      time: Math.round(snapshot.deathMoment?.diedAt ?? snapshot.game.time),
      ...killerFor(session, snapshot),
      goldUnspent: Math.floor(snapshot.deathMoment?.goldNow ?? active.currentGold),
      level: active.level,
      items: itemNames(active.items),
    };
    session.record.deaths.push(death);
    changed = true;
  } else if (active.isDead && snapshot.deathMoment?.killer) {
    // The kill event can land a poll after isDead flips; fill in the killer then.
    const last = session.record.deaths.at(-1);
    if (last && last.killer === "Unknown") {
      Object.assign(last, { killer: snapshot.deathMoment.killer, killerChampion: snapshot.deathMoment.killerChampion || "Unknown", assisters: snapshot.deathMoment.assisters || [] });
      changed = true;
    }
  }
  session.wasDead = active.isDead;
  session.sources = new Map(snapshot.deathSources.map((source) => [source.playerName, source.deathsTo]));
  return changed;
}

function trackStats(session: Session, snapshot: LiveGameSnapshot) {
  const record = session.record;
  const active = snapshot.activePlayer;
  const time = snapshot.game.time;
  if (record.csAt10 === null && session.lastTime < 600 && time >= 600 && time - session.lastTime <= 90) {
    const span = time - session.lastTime;
    record.csAt10 = span <= 5 ? active.cs : Math.round(session.lastCs + (active.cs - session.lastCs) * (600 - session.lastTime) / span);
  }
  // The feed dropped (page closed, client hiccup): purchases and deaths in that stretch were not seen.
  if (time - session.lastTime > FEED_GAP_SECONDS) record.partial = true;
  session.lastTime = time;
  session.lastCs = active.cs;
  record.durationSeconds = Math.max(record.durationSeconds, Math.round(time));
  record.position = active.position || record.position;
  record.modeLabel = snapshot.game.modeLabel;
  record.laneOpponent = snapshot.laneOpponent?.champion || record.laneOpponent;
  record.allies = snapshot.allies.map((player) => player.champion);
  record.enemies = snapshot.enemies.map((player) => player.champion);
  record.final = { kills: active.kills, deaths: active.deaths, assists: active.assists, cs: active.cs, level: active.level, items: itemNames(active.items) };
}

async function persist(session: Session) {
  session.lastWriteAt = Date.now();
  await writeGameRecord(session.record);
}

export function evaluateFocus(focus: PlayerFocus | null, record: GameRecord): GameRecord["focusResult"] {
  if (!focus) return null;
  const metric = focus.metric;
  if (!metric || metric.kind === "none") return { title: focus.title, met: null, detail: "No automatic metric; judge this one in review." };
  if (metric.kind === "csAt10") {
    if (record.csAt10 === null) return { title: focus.title, met: null, detail: "CS@10 was not captured this game." };
    return { title: focus.title, met: record.csAt10 >= metric.target, detail: `CS@10 ${record.csAt10} (target ${metric.target}+).` };
  }
  if (metric.kind === "deathsBefore10") {
    const early = record.deaths.filter((death) => death.time < 600).length;
    const met = early > metric.target ? false : record.durationSeconds >= 600 ? true : null;
    return { title: focus.title, met, detail: `${early} death${early === 1 ? "" : "s"} before 10:00 (target ≤ ${metric.target}).` };
  }
  const unspent = record.deaths.filter((death) => death.goldUnspent >= 1000).length;
  return { title: focus.title, met: unspent <= metric.target, detail: `${unspent} death${unspent === 1 ? "" : "s"} holding 1000g+ (target ≤ ${metric.target}).` };
}

async function finalize(session: Session, result: GameRecord["result"]) {
  if (session.finalized) return;
  session.finalized = true;
  const record = session.record;
  record.endedAt = new Date().toISOString();
  if (record.durationSeconds < REMAKE_SECONDS) {
    // Remake / early end: Riot still emits a GameEnd "win" for one team, and the League client's last match is the
    // previous game, so no result source is trusted. Remakes never reach stats, builds or focus tracking.
    record.remake = true;
    record.result = "unknown";
    record.focusResult = null;
    delete record.firstBack;
  } else {
    delete record.remake;
    record.result = result;
    if (result === "unknown") record.result = await lcuLastGameResult(record.durationSeconds, Date.now()) || "unknown";
    const firstBack = deriveFirstBack(record);
    if (firstBack) record.firstBack = firstBack; else delete record.firstBack;
    record.focusResult = evaluateFocus((await readSettings()).focus, record);
  }
  await persist(session);
  await rebuildProfile();
}

async function processSnapshot(snapshot: LiveGameSnapshot) {
  if (SKIPPED_MODES.test(snapshot.game.mode)) return;
  const key = gameKey(snapshot);
  let session = state.sessions.get(key);
  const time = snapshot.game.time;
  if (session?.finalized) {
    const continuing = time >= session.record.durationSeconds - 30;
    if (continuing && session.record.result !== "unknown") return; // post-game screen after GameEnd
    if (continuing && session.record.remake && time <= session.record.durationSeconds + 30) return; // a remake's frozen clock
    if (!continuing || session.record.result === "unknown") session = undefined;
  } else if (session && time < session.lastTime - 60) {
    await finalize(session, "unknown"); // clock restarted with the same ten players: a new game
    session = undefined;
  }
  if (state.activeKey && state.activeKey !== key) {
    const previous = state.sessions.get(state.activeKey);
    if (!session && previous && !previous.finalized && sameMatch(previous, snapshot)) {
      // Same match under a new gameId: keep one record instead of splitting the game into fragments.
      state.sessions.delete(state.activeKey);
      state.sessions.set(key, previous);
      session = previous;
    } else if (previous && !previous.finalized) await finalize(previous, "unknown");
  }
  const catalog = await loadCatalog();
  let important = false;
  if (!session) {
    session = await openSession(snapshot, key, catalog);
    state.sessions.set(key, session);
    important = true;
  }
  state.activeKey = key;
  session.roster = rosterOf(snapshot);
  important = diffInventory(session, snapshot, catalog) || important;
  important = trackDeath(session, snapshot) || important;
  trackStats(session, snapshot);
  if (snapshot.gameResult) return finalize(session, snapshot.gameResult);
  if (important || Date.now() - session.lastWriteAt >= WRITE_EVERY_MS) await persist(session);
}

async function finalizeActive() {
  const session = state.activeKey ? state.sessions.get(state.activeKey) : null;
  if (session && !session.finalized) await finalize(session, "unknown");
}

async function drain() {
  try {
    while (state.latest || state.offlineDue) {
      const snapshot = state.latest;
      state.latest = null;
      try {
        if (snapshot) await processSnapshot(snapshot);
        else { state.offlineDue = false; await finalizeActive(); }
      } catch (error) {
        console.error("[rift-lens] game recorder failed:", error);
      }
    }
  } finally { state.busy = false; }
}

function kick() {
  if (state.busy) return;
  state.busy = true;
  void drain();
}

/** Fire-and-forget: records one live poll. Never throws and never blocks the caller. */
export function recordSnapshot(snapshot: LiveGameSnapshot) {
  try {
    state.offlineSince = null;
    state.latest = snapshot;
    kick();
  } catch (error) { console.error("[rift-lens] game recorder failed:", error); }
}

/** Called on every offline poll; finalizes an open record after ~60s without a live feed. */
export function handleOffline() {
  try {
    const now = Date.now();
    state.offlineSince ??= now;
    if (now - state.offlineSince < OFFLINE_FINALIZE_MS) return;
    const session = state.activeKey ? state.sessions.get(state.activeKey) : null;
    if (!session || session.finalized || state.offlineDue) return;
    state.offlineDue = true;
    kick();
  } catch (error) { console.error("[rift-lens] game recorder failed:", error); }
}

/** Item ids the player sold during the given live game (undo-within-20s sales are already dropped). */
export function soldItemIdsForGame(gameId: string): number[] {
  // By key (a re-keyed session keeps its original record.gameId), else the open active session, which a gameId change
  // (Viego possession) is about to adopt on this same poll.
  const active = state.activeKey ? state.sessions.get(state.activeKey) : undefined;
  const session = state.sessions.get(safeId(gameId).slice(0, 24)) ?? active;
  if (!session || session.finalized) return [];
  return session.record.purchases.filter((entry) => entry.kind === "sold").map((entry) => entry.itemId);
}

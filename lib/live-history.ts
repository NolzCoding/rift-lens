// Short in-game history: a per-game ring buffer of the last ~3 game-minutes of polls, kept in server memory.
// Fed by normalizeLiveData on every /api/live-game poll; lets the death read use values from the moment of
// death (levels, item gold, gold held) instead of whatever they are while the player waits to respawn.
// Server-only, process-local, never persisted. Lives on globalThis so dev hot reloads keep it.

export type HistoryPlayerState = { level: number; itemGold: number };

export type HistorySample = {
  /** Game seconds (gameData.gameTime). */
  time: number;
  /** Active player. */
  level: number;
  gold: number;
  itemIds: number[];
  cs: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** Every player (active included), keyed by historyKey(). */
  players: Record<string, HistoryPlayerState>;
};

/** Game seconds of samples kept per game. */
export const HISTORY_WINDOW_SECONDS = 180;
/** Hard cap per game (2.5s polls ≈ 72 samples in the window; extra tabs polling can double that). */
export const HISTORY_MAX_SAMPLES = 160;
/** Games kept at once; the least recently fed is dropped first. */
export const HISTORY_MAX_GAMES = 3;
/** A game not fed for this long (wall clock) is dropped. */
const HISTORY_IDLE_MS = 30 * 60 * 1000;
/** A sample counts as "at" an event only if it is at most this many game seconds before it (a poll or two). */
export const AT_EVENT_MAX_AGE = 10;

type GameBuffer = { touchedAt: number; samples: HistorySample[] };
type Store = { version: 1; games: Map<string, GameBuffer> };

const STORE_KEY = Symbol.for("rift-lens.live-history");

function store(): Store {
  const holder = globalThis as unknown as Record<symbol, Store | undefined>;
  const current = holder[STORE_KEY];
  if (current?.version === 1 && current.games instanceof Map) return current;
  const fresh: Store = { version: 1, games: new Map() };
  holder[STORE_KEY] = fresh;
  return fresh;
}

/** Stable per-player key inside one game: the account, never the champion (Viego's possession renames him mid-game). */
export function historyKey(player: { riotId?: string; name?: string; champion?: string }) {
  return (player.riotId || player.name || player.champion || "").toLowerCase();
}

function prune(games: Map<string, GameBuffer>, now: number) {
  for (const [id, buffer] of games) if (now - buffer.touchedAt > HISTORY_IDLE_MS) games.delete(id);
  while (games.size > HISTORY_MAX_GAMES) {
    const oldest = [...games.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
    games.delete(oldest[0]);
  }
}

/** Append one poll. Same game time again (paused game, two tabs) replaces the last sample; time going backwards restarts the buffer. */
export function recordSample(gameId: string, sample: HistorySample, now = Date.now()) {
  if (!gameId || !Number.isFinite(sample.time)) return;
  const { games } = store();
  let buffer = games.get(gameId);
  if (!buffer) {
    buffer = { touchedAt: now, samples: [] };
    games.set(gameId, buffer);
  }
  buffer.touchedAt = now;
  const samples = buffer.samples;
  const last = samples.at(-1);
  // A remake / replay with the same roster restarts the clock: old samples belong to another match.
  if (last && sample.time < last.time - 5) samples.length = 0;
  const tail = samples.at(-1);
  if (tail && Math.abs(sample.time - tail.time) < 0.5) samples[samples.length - 1] = sample;
  else if (!tail || sample.time > tail.time) samples.push(sample);
  else {
    // Slightly out of order (< 5s back): insert in place.
    const at = samples.findIndex((entry) => entry.time > sample.time);
    samples.splice(at < 0 ? samples.length : at, 0, sample);
  }
  const cutoff = (samples.at(-1)?.time ?? sample.time) - HISTORY_WINDOW_SECONDS;
  let drop = 0;
  while (drop < samples.length && samples[drop].time < cutoff) drop++;
  if (samples.length - drop > HISTORY_MAX_SAMPLES) drop = samples.length - HISTORY_MAX_SAMPLES;
  if (drop) samples.splice(0, drop);
  prune(games, now);
}

/** All kept samples for a game, oldest first (read-only view). */
export function gameHistory(gameId: string): readonly HistorySample[] {
  return store().games.get(gameId)?.samples ?? [];
}

/** The latest sample at or just before `time` (within `maxAge` game seconds), or null when the page was not polling then. */
export function sampleAt(gameId: string, time: number, maxAge = AT_EVENT_MAX_AGE): HistorySample | null {
  const samples = gameHistory(gameId);
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index];
    if (sample.time > time + 0.25) continue;
    return time - sample.time <= maxAge ? sample : null;
  }
  return null;
}

/** The last sample at or before `time` in which the active player was alive (within `maxAge`). */
export function aliveSampleAt(gameId: string, time: number, maxAge = AT_EVENT_MAX_AGE): HistorySample | null {
  const samples = gameHistory(gameId);
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index];
    if (sample.time > time + 0.25 || !sample.alive) continue;
    return time - sample.time <= maxAge ? sample : null;
  }
  return null;
}

/** Test/debug helper: forget everything (or one game). */
export function clearHistory(gameId?: string) {
  const { games } = store();
  if (gameId) games.delete(gameId);
  else games.clear();
}

import path from "node:path";

import { buildRoutes, type BuildRoute, type MetaBuild } from "@/lib/meta-builds";
import { championKey, memoryRoot, readJson, writeJsonAtomic } from "@/lib/memory-store";

// Choosing between a champion's build routes (AP burst vs on-hit Katarina; lib/meta-builds.ts BuildRoute, researched by
// lib/build-research.ts). Every route gets points for this game with a reason each, from Riot data only: the enemy
// front line (tanks against lethality, penetration and on-hit), the team's damage split, and the player's own usual
// build. How many people play a route counts a little; its win rate is shown but never decides (a route's win rate mostly
// says who plays it). In a game the route is decided once and kept: by the items bought, else the player's choice, else
// the recommendation made when the game was first seen.

/** What a route's items are, read from Riot's item data by the caller (live-game catalog). */
export type RouteItem = {
  id: number;
  name: string;
  scaling: "ad" | "ap" | "hybrid" | "neutral";
  /** Lethality: flat armor penetration, strongest against low-armor targets. */
  lethality: boolean;
  /** Percent armor/magic penetration, on-hit damage or damage based on the target's health: what beats tanks. */
  antiTank: boolean;
};
export type RouteFeatures = { route: BuildRoute; damage: "ad" | "ap" | "hybrid"; items: RouteItem[] };
export type RouteChampion = { champion: string; damage: "physical" | "magic" | "mixed" | "unknown"; tank: boolean };
export type RoutePart = { text: string; points: number; counted?: false };
export type RankedRoute = {
  id: string;
  name: string;
  share: number | null;
  winRate: number | null;
  summary: string;
  damage: "ad" | "ap" | "hybrid";
  /** The route's first three core items (defaults); id null when Riot's item data has no such item. */
  core: Array<{ name: string; id: number | null }>;
  score: number;
  parts: RoutePart[];
  recommended: boolean;
};

/** The core items (each core slot's default, then the first flex slot's), boots left out. */
export const routeCoreNames = (route: BuildRoute, count = 4) => route.slots.filter((slot) => slot.kind !== "boots" && slot.kind !== "situational")
  .map((slot) => slot.options.find((option) => !option.when)?.item || slot.options[0]?.item).filter((name): name is string => Boolean(name)).slice(0, count);

export function routeFeatures(entry: MetaBuild, itemOf: (name: string) => RouteItem | null): RouteFeatures[] {
  return buildRoutes(entry).map((route) => {
    const items = routeCoreNames(route).map(itemOf).filter((item): item is RouteItem => Boolean(item));
    const ad = items.filter((item) => item.scaling === "ad").length;
    const ap = items.filter((item) => item.scaling === "ap").length;
    return { route, items, damage: ad > ap * 2 ? "ad" : ap > ad * 2 ? "ap" : "hybrid" };
  });
}

const DAMAGE_WORD = { ad: "AD", ap: "AP", hybrid: "mixed" } as const;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Points for each route in this game, best first; the first is `recommended`. Ties keep the sites' order (the most
 * played route first).
 */
export function rankRoutes(input: { routes: RouteFeatures[]; enemies: RouteChampion[]; allies: RouteChampion[]; usualBuild: string[] | null }): RankedRoute[] {
  const tanks = input.enemies.filter((enemy) => enemy.tank);
  const squishy = input.enemies.length - tanks.length;
  const usual = new Set((input.usualBuild || []).map(championKey));
  const known = input.allies.filter((ally) => ally.damage === "physical" || ally.damage === "magic");
  const ranked = input.routes.map(({ route, damage, items }, order) => {
    const parts: RoutePart[] = [];
    // The enemy front line.
    const antiTank = items.filter((item) => item.antiTank);
    const lethality = items.filter((item) => item.lethality);
    if (tanks.length >= 2) {
      if (antiTank.length) {
        const names = `${antiTank.slice(0, 2).map((item) => item.name).join(", ")}${antiTank.length > 2 ? ` +${antiTank.length - 2}` : ""}`;
        parts.push({ text: `beats their ${tanks.length} tanks (${tanks.map((tank) => tank.champion).join(", ")}): ${names} cut through health and resists`, points: Math.min(1.5, 0.75 * antiTank.length) });
      }
      if (lethality.length >= 2) parts.push({ text: `lethality falls off against ${plural(tanks.length, "tank")}: they stack armor and health`, points: -1 });
    } else if (squishy >= 4 && lethality.length) {
      parts.push({ text: `their team is squishy (${tanks.length ? `${tanks[0].champion} is the only tank` : "no tank"}): lethality kills fast`, points: 0.75 });
    }
    // The team's damage split: all one type lets the enemy build one resist against everyone.
    if (known.length >= 3 && damage !== "hybrid") {
      const same = known.filter((ally) => (ally.damage === "physical") === (damage === "ad")).length;
      if (same / known.length >= 0.75) parts.push({ text: `your team is already ${same} of ${known.length} ${DAMAGE_WORD[damage]}: one resist item stops all of you`, points: -1 });
      else if (same / known.length <= 0.25) parts.push({ text: `your team has ${same} ${DAMAGE_WORD[damage]} of ${known.length}: ${DAMAGE_WORD[damage]} damage splits what they must build`, points: 1 });
    }
    // The player's own build: comfort counts for a player still learning the champion.
    const core = routeCoreNames(route, 3);
    const familiar = core.filter((name) => usual.has(championKey(name)));
    if (usual.size && familiar.length >= 2) parts.push({ text: `your usual build (${familiar.join(", ")})`, points: 1 });
    // The sites: the most played route a little, its win rate shown only.
    if (order === 0) parts.push({ text: `most played${route.share !== null ? ` (${route.share}% of games)` : ""}`, points: 0.5 });
    else if (route.share !== null) parts.push({ text: `played in ${route.share}% of games`, points: 0 });
    if (route.winRate !== null) parts.push({ text: `${route.winRate}% win rate (shown, not counted: it mostly says who plays it)`, points: 0, counted: false });
    const score = Math.round(parts.filter((part) => part.counted !== false).reduce((sum, part) => sum + part.points, 0) * 10) / 10;
    const coreItems = core.map((name) => ({ name, id: items.find((item) => championKey(item.name) === championKey(name))?.id ?? null }));
    return { id: route.id, name: route.name, share: route.share, winRate: route.winRate, summary: route.summary, damage, core: coreItems, score, parts, recommended: false, order };
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.map(({ order: _order, ...route }, at) => { void _order; return { ...route, recommended: at === 0 }; });
}

/**
 * The route the items bought already commit to: completed items that only one route builds. Null while nothing bought
 * tells them apart (no items yet, or only items every route builds).
 */
export function committedRoute(entry: MetaBuild, ownedCompleted: string[]): string | null {
  const routes = buildRoutes(entry);
  const owned = new Set(ownedCompleted.map(championKey));
  const itemsOf = (route: BuildRoute) => new Set(route.slots.filter((slot) => slot.kind !== "boots").flatMap((slot) => slot.options.map((option) => championKey(option.item))));
  const sets = routes.map(itemsOf);
  const unique = routes.map((route, at) => [...owned].filter((item) => sets[at].has(item) && sets.every((other, j) => j === at || !other.has(item))).length);
  const hits = unique.flatMap((count, at) => count ? [at] : []);
  return hits.length === 1 ? routes[hits[0]].id : null;
}

// ---------------------------------------------------------------------------
// The player's choice (champ select or the live page), kept for the next few hours
// ---------------------------------------------------------------------------

/** A choice is for the game being picked now, not forever: after this long it no longer applies. */
export const CHOICE_HOURS = 4;
type ChoiceFile = { version: 1; choices: Record<string, { champion: string; route: string; at: string }> };
type ChoiceState = { choices: ChoiceFile["choices"]; loading: Promise<void> | null; latched: Map<string, { route: string; source: RouteSource }> };
const state: ChoiceState = ((globalThis as { __riftLensRouteChoicesV1?: ChoiceState }).__riftLensRouteChoicesV1 ??= { choices: {}, loading: null, latched: new Map() });
const choiceFile = () => path.join(memoryRoot(), "build-route-choices.json");

export function ensureRouteChoicesLoaded() {
  state.loading ??= readJson<ChoiceFile>(choiceFile()).then((file) => { if (file?.version === 1 && file.choices) state.choices = file.choices; }).catch(() => { state.loading = null; });
  return state.loading;
}

/** The route the player picked for this champion in the last CHOICE_HOURS, or null. */
export function routeChoice(champion: string, now = Date.now()): string | null {
  const entry = state.choices[championKey(champion)];
  return entry && now - Date.parse(entry.at) < CHOICE_HOURS * 3600_000 ? entry.route : null;
}

/** Saves (or with null clears) the player's route for a champion. The current game follows it unless items already commit. */
export async function saveRouteChoice(champion: string, route: string | null) {
  await ensureRouteChoicesLoaded();
  const id = championKey(champion);
  if (route) state.choices[id] = { champion, route, at: new Date().toISOString() };
  else delete state.choices[id];
  for (const key of [...state.latched.keys()]) if (key.endsWith(`:${id}`)) state.latched.delete(key);
  await writeJsonAtomic(choiceFile(), { version: 1, choices: state.choices } satisfies ChoiceFile);
}

export type RouteSource = "items" | "choice" | "recommended";

/**
 * The route for this game: the items bought (when they commit), else the player's choice, else the recommendation
 * latched when the game was first seen with this champion, so the build never flips on its own mid-game.
 */
export function gameRoute(gameId: string, champion: string, entry: MetaBuild, ranked: RankedRoute[], ownedCompleted: string[], now = Date.now()): { route: string; source: RouteSource } {
  const ids = buildRoutes(entry).map((route) => route.id);
  const committed = committedRoute(entry, ownedCompleted);
  if (committed) return { route: committed, source: "items" };
  const chosen = routeChoice(champion, now);
  if (chosen && ids.includes(chosen)) return { route: chosen, source: "choice" };
  const key = `${gameId}:${championKey(champion)}`;
  const latched = state.latched.get(key);
  if (latched && ids.includes(latched.route)) return latched;
  const pick = { route: ranked[0]?.id || "main", source: "recommended" as const };
  state.latched.set(key, pick);
  while (state.latched.size > 8) state.latched.delete(state.latched.keys().next().value!);
  return pick;
}

/** Forget latched per-game routes (tests that reuse one game id). */
export function resetRouteMemory() {
  state.latched.clear();
  state.choices = {};
}

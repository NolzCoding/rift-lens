import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChampionEntry } from "@/lib/champion-data";
import { memoryRoot } from "@/lib/memory-store";
import type { MetaRole } from "@/lib/meta-builds";

// How often each champion is played in each role, and a guess of the enemy team's roles in champ select (Riot hides
// them there). Play rates come from Meraki Analytics' public champion rates (keyed by Riot's numeric champion id; it
// lags a few patches, which hardly moves who plays where), cached on disk for a week; a champion it does not know falls
// back to its Data Dragon class (Marksman → bot lane…).

export const ROLES: MetaRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const RATES_URL = "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/championrates.json";
const REFRESH_MS = 7 * 24 * 3600_000;
const cacheFile = () => path.join(memoryRoot(), "cache", "championrates.json");

export type RoleOdds = Record<MetaRole, number>;
type RatesFile = { fetchedAt: string; patch: string | null; rates: Record<string, Partial<Record<MetaRole, number>>> };
type RatesState = { file: RatesFile | null; loading: Promise<RatesFile | null> | null; checkedAt: number };
const state: RatesState = ((globalThis as { __riftLensRoleRatesV1?: RatesState }).__riftLensRoleRatesV1 ??= { file: null, loading: null, checkedAt: 0 });

async function fetchRates(): Promise<RatesFile | null> {
  const response = await fetch(RATES_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const payload = await response.json() as { patch?: string; data?: Record<string, Partial<Record<MetaRole, { playRate?: number }>>> };
  const rates: RatesFile["rates"] = {};
  for (const [id, roles] of Object.entries(payload.data || {})) {
    rates[id] = Object.fromEntries(ROLES.map((role) => [role, Number(roles[role]?.playRate) || 0]));
  }
  return Object.keys(rates).length ? { fetchedAt: new Date().toISOString(), patch: payload.patch || null, rates } : null;
}

/** The play-rate table: memory, then the disk cache, refreshed from the CDN when a week old. Null when neither works. */
export function loadRoleRates(): Promise<RatesFile | null> {
  const stale = !state.file || Date.now() - Date.parse(state.file.fetchedAt) > REFRESH_MS;
  if (!stale) return Promise.resolve(state.file);
  // At most one attempt every 10 minutes after a failure.
  if (state.loading || Date.now() - state.checkedAt < 10 * 60_000) return state.loading || Promise.resolve(state.file);
  state.checkedAt = Date.now();
  state.loading = (async () => {
    let file = state.file;
    if (!file) file = await readFile(cacheFile(), "utf8").then((text) => JSON.parse(text) as RatesFile).catch(() => null);
    if (!file || Date.now() - Date.parse(file.fetchedAt) > REFRESH_MS) {
      const fresh = await fetchRates().catch(() => null);
      if (fresh) {
        file = fresh;
        await mkdir(path.dirname(cacheFile()), { recursive: true }).then(() => writeFile(cacheFile(), JSON.stringify(fresh), "utf8")).catch(() => undefined);
      }
    }
    state.file = file;
    return file;
  })().finally(() => { state.loading = null; });
  return state.loading;
}

/** Data Dragon class → the role such champions usually play (only for champions the play-rate table lacks). */
function classRole(entry: Pick<ChampionEntry, "tags">): MetaRole {
  const [first, second] = entry.tags;
  if (first === "Marksman") return "BOTTOM";
  if (first === "Support" || second === "Support") return "UTILITY";
  if (first === "Mage" || first === "Assassin") return "MIDDLE";
  return "TOP";
}

/**
 * Probability of each role for one champion: its play rates normalised, with a small floor so an off-role pick stays
 * possible; Data Dragon class (70% main role) when the table does not know the champion.
 */
export function roleOdds(entry: Pick<ChampionEntry, "key" | "tags">, rates: RatesFile | null): RoleOdds {
  const known = rates?.rates[entry.key];
  const total = known ? ROLES.reduce((sum, role) => sum + (known[role] || 0), 0) : 0;
  if (known && total > 0) {
    const floor = total * 0.01;
    const smoothed = ROLES.map((role) => (known[role] || 0) + floor);
    const sum = smoothed.reduce((a, b) => a + b, 0);
    return Object.fromEntries(ROLES.map((role, at) => [role, smoothed[at] / sum])) as RoleOdds;
  }
  const main = classRole(entry);
  return Object.fromEntries(ROLES.map((role) => [role, role === main ? 0.7 : 0.075])) as RoleOdds;
}

/**
 * Each champion's role odds given the whole team: five champions fill five different roles, so every one-to-one
 * assignment of roles to the picked champions is weighed by the product of their odds and each champion's role
 * probability is its share over all assignments (Ezreal + Thresh + Seraphine → Seraphine is most likely mid).
 * At most 5 champions: 5!/(5−k)! ≤ 120 assignments.
 */
export function guessTeamRoles(odds: RoleOdds[]): RoleOdds[] {
  const totals = odds.map(() => Object.fromEntries(ROLES.map((role) => [role, 0])) as RoleOdds);
  let sum = 0;
  const walk = (at: number, used: Set<MetaRole>, weight: number, picks: MetaRole[]) => {
    if (at === odds.length) {
      sum += weight;
      picks.forEach((role, index) => { totals[index][role] += weight; });
      return;
    }
    for (const role of ROLES) {
      if (used.has(role)) continue;
      used.add(role);
      walk(at + 1, used, weight * odds[at][role], [...picks, role]);
      used.delete(role);
    }
  };
  walk(0, new Set(), 1, []);
  if (!sum) return odds;
  return totals.map((row) => Object.fromEntries(ROLES.map((role) => [role, row[role] / sum])) as RoleOdds);
}

export type LaneOdds = { members: number[]; roles: MetaRole[]; chance: number };

/**
 * Who fills a lane, from the same one-to-one assignments as guessTeamRoles: the champions (by index) given `roles` and
 * which of those roles each gets, with the share of all assignments. Bot lane (["BOTTOM", "UTILITY"]) is a pair, so
 * "Veigar + Viktor" is one answer with one chance, not two separate 31% guesses. Best first.
 */
export function laneOdds(odds: RoleOdds[], roles: MetaRole[]): LaneOdds[] {
  const totals = new Map<string, LaneOdds>();
  let sum = 0;
  const walk = (at: number, used: Set<MetaRole>, weight: number, picks: MetaRole[]) => {
    if (at === odds.length) {
      sum += weight;
      const members = picks.flatMap((role, index) => roles.includes(role) ? [index] : []);
      const id = members.map((index) => `${index}:${picks[index]}`).join(",");
      const entry = totals.get(id) || { members, roles: members.map((index) => picks[index]), chance: 0 };
      entry.chance += weight;
      totals.set(id, entry);
      return;
    }
    for (const role of ROLES) {
      if (used.has(role)) continue;
      used.add(role);
      walk(at + 1, used, weight * odds[at][role], [...picks, role]);
      used.delete(role);
    }
  };
  walk(0, new Set(), 1, []);
  if (!sum) return [];
  return [...totals.values()].map((entry) => ({ ...entry, chance: entry.chance / sum })).sort((a, b) => b.chance - a.chance);
}

/** laneOdds merged by who is in the lane, whatever the roles between them (Veigar ADC + Viktor support and the reverse). */
export function lanePairs(lanes: LaneOdds[]): Array<{ members: number[]; chance: number }> {
  const merged = new Map<string, { members: number[]; chance: number }>();
  for (const lane of lanes) {
    const members = [...lane.members].sort((a, b) => a - b);
    const entry = merged.get(members.join(",")) || { members, chance: 0 };
    entry.chance += lane.chance;
    merged.set(members.join(","), entry);
  }
  return [...merged.values()].sort((a, b) => b.chance - a.chance);
}

/** The single likeliest full assignment (each champion a different role). */
export function likeliestAssignment(odds: RoleOdds[]): MetaRole[] {
  let best: { roles: MetaRole[]; weight: number } = { roles: [], weight: -1 };
  const walk = (at: number, used: Set<MetaRole>, weight: number, picks: MetaRole[]) => {
    if (at === odds.length) { if (weight > best.weight) best = { roles: picks, weight }; return; }
    for (const role of ROLES) {
      if (used.has(role)) continue;
      used.add(role);
      walk(at + 1, used, weight * odds[at][role], [...picks, role]);
      used.delete(role);
    }
  };
  walk(0, new Set(), 1, []);
  return best.roles;
}

/** The likeliest role and its probability. */
export function likeliestRole(odds: RoleOdds): { role: MetaRole; chance: number } {
  const role = ROLES.reduce((best, next) => odds[next] > odds[best] ? next : best, ROLES[0]);
  return { role, chance: odds[role] };
}

import type { DamageType } from "@/lib/champion-traits";
import type { Matchup } from "@/lib/matchup-research";
import type { MetaRole } from "@/lib/meta-builds";
import type { RoleOdds } from "@/lib/role-rates";

// Ranks the champions of the player's pool for their role in champ select. Every part is in win-rate points so the
// reasons can show their numbers: the champion's own strength this patch, its matchups against the enemy laners
// picked so far (weighted by how likely each enemy is to be in that lane), the player's own record on it, and what
// the team comp is missing. It only ranks options; the player picks.

/** How much each enemy role counts for a role's lane: the bot lane is a 2v2, the support less than the ADC. */
export const LANE_WEIGHT: Record<MetaRole, Partial<Record<MetaRole, number>>> = {
  TOP: { TOP: 1 }, JUNGLE: { JUNGLE: 1 }, MIDDLE: { MIDDLE: 1 }, BOTTOM: { BOTTOM: 1, UTILITY: 0.6 }, UTILITY: { UTILITY: 1, BOTTOM: 0.6 },
};
/**
 * Enemy role probability below this is not counted as a lane opponent. Each one counts in proportion to its chance, so
 * an off-role bot lane (Veigar ADC + Viktor support, each ~31% bot or support) still weighs in instead of vanishing.
 */
const LANE_CHANCE = 0.15;
/** The player's record is shrunk toward 50% as if they had this many extra games at 50%. */
const RECORD_PRIOR_GAMES = 20;
const RECORD_CAP = 4;
/** Experience: fewer games than this on a champion costs points (an unfamiliar pick), this many or more earns a little. */
const COMFORT_GAMES = 5;
const MAIN_GAMES = 20;
/** A matchup's edge is shrunk toward 0 below this many games. */
const MATCHUP_FULL_GAMES = 500;

export type PickCandidate = {
  champion: string;
  damage: DamageType;
  tank: boolean;
  /** Researched patch data for this champion in this role, or null when none yet. */
  overallWinRate: number | null;
  matchups: Matchup[] | null;
  /** The player's games on this champion (recorded + client history). */
  record: { games: number; wins: number } | null;
};
export type PickEnemy = { champion: string; odds: RoleOdds };
export type PickAlly = { champion: string; damage: DamageType; tank: boolean };
/** `counted: false` = shown, but left out of the score because not every candidate has this kind of data yet. */
export type PickPart = { kind: "patch" | "lane" | "record" | "comfort" | "team"; points: number; text: string; counted?: false };
/** `partial` = some candidates have no researched data yet, so the ranking uses only the player's games and the team. */
export type PickSuggestion = { champion: string; score: number; parts: PickPart[]; missingData: boolean; partial: boolean };

const fmt = (points: number) => `${points >= 0 ? "+" : ""}${points.toFixed(1)}`;

/**
 * One part per enemy who may be in the lane: weighted by how likely they are there (bot lane: ADC 1, support 0.6 — see
 * LANE_WEIGHT) and by the sample size. The row for the role they most likely play is used, else any row for them, so a
 * missing "Viktor support" row never counts the "Viktor ADC" row twice.
 */
function lanePart(candidate: PickCandidate, role: MetaRole, enemies: PickEnemy[]): PickPart[] {
  const parts: PickPart[] = [];
  for (const enemy of enemies) {
    const lanes = (Object.entries(LANE_WEIGHT[role]) as Array<[MetaRole, number]>)
      .map(([lane, weight]) => ({ lane, weight, chance: enemy.odds[lane] || 0 }))
      .filter((entry) => entry.chance >= LANE_CHANCE)
      .sort((a, b) => b.chance * b.weight - a.chance * a.weight);
    if (!lanes.length) continue;
    const weight = lanes.reduce((sum, entry) => sum + entry.weight * entry.chance, 0);
    const inLane = Math.min(1, lanes.reduce((sum, entry) => sum + entry.chance, 0));
    const where = inLane < 0.75 ? ` (${Math.round(inLane * 100)}% likely in your lane)` : "";
    const row = lanes.map((entry) => candidate.matchups?.find((match) => match.opponent === enemy.champion && match.opponentRole === entry.lane)).find(Boolean)
      || candidate.matchups?.find((match) => match.opponent === enemy.champion);
    if (!row) {
      parts.push({ kind: "lane", points: 0, text: `vs ${enemy.champion}${where}: no matchup data` });
      continue;
    }
    // The edge over the champion's own average, so its general strength is not counted twice.
    const edge = row.winRate - (candidate.overallWinRate ?? 50);
    const trust = row.games === null ? 0.5 : Math.min(1, row.games / MATCHUP_FULL_GAMES);
    parts.push({ kind: "lane", points: edge * weight * trust, text: `${row.winRate.toFixed(1)}% vs ${enemy.champion}${where}${row.games ? ` (${row.games.toLocaleString("en-US")} games)` : ""}` });
  }
  return parts;
}

function teamPart(candidate: PickCandidate, allies: PickAlly[]): PickPart[] {
  const known = allies.filter((ally) => ally.damage === "physical" || ally.damage === "magic");
  const parts: PickPart[] = [];
  if (known.length >= 2) {
    const physical = known.filter((ally) => ally.damage === "physical").length;
    if (physical === known.length && candidate.damage === "magic") parts.push({ kind: "team", points: 2, text: "your team is all physical damage so far: magic damage is harder to itemize against" });
    if (physical === 0 && candidate.damage === "physical") parts.push({ kind: "team", points: 2, text: "your team is all magic damage so far: physical damage is harder to itemize against" });
  }
  if (allies.length >= 3 && !allies.some((ally) => ally.tank) && candidate.tank) parts.push({ kind: "team", points: 1, text: "no frontline on your team yet" });
  return parts;
}

/**
 * The pool ranked for this role, best first. Champions already picked or banned must be left out by the caller.
 * Like with like: while any candidate still has no researched data, the patch and lane parts are shown but not counted,
 * so a champion is never ranked up just because its numbers are missing (no data scored 0 against another's known minus).
 */
export function rankPicks(input: { role: MetaRole; candidates: PickCandidate[]; enemies: PickEnemy[]; allies: PickAlly[] }): PickSuggestion[] {
  const partial = input.candidates.some((candidate) => candidate.matchups === null);
  return input.candidates.map((candidate) => {
    const parts: PickPart[] = [];
    if (candidate.overallWinRate !== null) parts.push({ kind: "patch", points: candidate.overallWinRate - 50, text: `${candidate.overallWinRate.toFixed(1)}% win rate this patch` });
    parts.push(...lanePart(candidate, input.role, input.enemies));
    const record = candidate.record;
    const games = record?.games || 0;
    if (record && games > 0) {
      const shrunk = (record.wins + RECORD_PRIOR_GAMES / 2) / (games + RECORD_PRIOR_GAMES) * 100 - 50;
      const points = Math.max(-RECORD_CAP, Math.min(RECORD_CAP, shrunk));
      parts.push({ kind: "record", points, text: `you: ${record.wins}-${games - record.wins} on ${candidate.champion}` });
    }
    // Experience apart from results: a champion you barely know is a worse pick than its numbers say.
    if (games < COMFORT_GAMES) parts.push({ kind: "comfort", points: -(COMFORT_GAMES - games) * 0.6, text: games ? `only ${games} game${games === 1 ? "" : "s"} on ${candidate.champion}` : `new to you` });
    else if (games >= MAIN_GAMES) parts.push({ kind: "comfort", points: 1.5, text: `one of your most played (${games} games)` });
    parts.push(...teamPart(candidate, input.allies));
    const shown = parts.map((part): PickPart => ({ ...part, points: Math.round(part.points * 10) / 10, ...(partial && (part.kind === "patch" || part.kind === "lane") ? { counted: false as const } : {}) }));
    const score = shown.reduce((sum, part) => sum + (part.counted === false ? 0 : part.points), 0);
    return { champion: candidate.champion, score: Math.round(score * 10) / 10, parts: shown, missingData: candidate.matchups === null, partial };
  }).sort((a, b) => b.score - a.score || a.champion.localeCompare(b.champion));
}

/** One line for a part, with its points. */
export const partLine = (part: PickPart) => `${part.text} (${fmt(part.points)})`;

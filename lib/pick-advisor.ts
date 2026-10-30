import type { DamageType } from "@/lib/champion-traits";
import type { Matchup } from "@/lib/matchup-research";
import type { MetaRole } from "@/lib/meta-builds";
import { laneOdds, lanePairs, type RoleOdds } from "@/lib/role-rates";

// Ranks the champions of the player's pool for their role in champ select. Every part is in win-rate points so the
// reasons can show their numbers: the champion's own strength this patch, the lane against the enemy laners picked so
// far (the bot lane as a 2v2 pair) from matchup stats AND from the kits (attack range and poke reach against theirs,
// their crowd control against an immobile pick), weighted by how likely each pairing is; the player's own record on
// it; and what the team comp is missing. Win rates are one input, not the verdict. It only ranks options.

/** How much each enemy role counts for a role's lane: the bot lane is a 2v2, the support less than the ADC. */
export const LANE_WEIGHT: Record<MetaRole, Partial<Record<MetaRole, number>>> = {
  TOP: { TOP: 1 }, JUNGLE: { JUNGLE: 1 }, MIDDLE: { MIDDLE: 1 }, BOTTOM: { BOTTOM: 1, UTILITY: 0.6 }, UTILITY: { UTILITY: 1, BOTTOM: 0.6 },
};
/** Lane pairings less likely than this are left out (each counts in proportion to its chance). */
const LANE_CHANCE = 0.03;
/** Range: each 100 units of attack range over (or under) the enemy laners' best is worth this much, up to RANGE_CAP. */
const RANGE_POINTS_PER_100 = 1;
const RANGE_CAP = 1.5;
/** Poke reach (longest attack or damaging spell) 100+ beyond or short of theirs. */
const REACH_POINTS = 0.5;
/** Each enemy laner with hard crowd control, against a pick with no dash and low mobility; at most CC_CAP. */
const CC_POINTS = 0.5;
const CC_CAP = 1;
/** The player's record is shrunk toward 50% as if they had this many extra games at 50%. */
const RECORD_PRIOR_GAMES = 20;
const RECORD_CAP = 4;
/** Experience: fewer games than this on a champion costs points (an unfamiliar pick), this many or more earns a little. */
const COMFORT_GAMES = 5;
const MAIN_GAMES = 20;
/** A matchup's edge is shrunk toward 0 below this many games. */
const MATCHUP_FULL_GAMES = 500;

/** From Riot data: attack range, longest damaging spell range, hard crowd control in the kit, and whether it can escape. */
export type LaneKit = { range: number | null; reach: number | null; hardCc: boolean; mobile: boolean };
export type PickCandidate = {
  champion: string;
  damage: DamageType;
  tank: boolean;
  kit?: LaneKit;
  /** Researched patch data for this champion in this role, or null when none yet. */
  overallWinRate: number | null;
  matchups: Matchup[] | null;
  /** The player's games on this champion (recorded + client history). */
  record: { games: number; wins: number } | null;
};
/** `odds` = this champion's own role odds (not team-adjusted: the pairing is solved here, see laneOdds). */
export type PickEnemy = { champion: string; odds: RoleOdds; kit?: LaneKit };
export type PickAlly = { champion: string; damage: DamageType; tank: boolean };
/** `counted: false` = shown, but left out of the score because not every candidate has this kind of data yet. */
export type PickPart = { kind: "patch" | "lane" | "kit" | "record" | "comfort" | "team"; points: number; text: string; counted?: false };
/** `partial` = some candidates have no researched data yet, so the ranking uses only the player's games and the team. */
export type PickSuggestion = { champion: string; score: number; parts: PickPart[]; missingData: boolean; partial: boolean };

const fmt = (points: number) => `${points >= 0 ? "+" : ""}${points.toFixed(1)}`;

/** Which roles make up a role's lane: the bot lane is the enemy ADC and support together. */
const LANE_ROLES: Record<MetaRole, MetaRole[]> = { TOP: ["TOP"], JUNGLE: ["JUNGLE"], MIDDLE: ["MIDDLE"], BOTTOM: ["BOTTOM", "UTILITY"], UTILITY: ["UTILITY", "BOTTOM"] };

const pct = (chance: number) => `${Math.round(chance * 100)}%`;

/** Range and crowd control of one possible enemy lane against the candidate's kit (null when the data is missing). */
function kitValue(kit: LaneKit, lane: PickEnemy[]) {
  const ranges = lane.map((enemy) => enemy.kit?.range).filter((value): value is number => typeof value === "number");
  let range: { points: number; theirs: number; theirReach: number } | null = null;
  if (kit.range !== null && ranges.length) {
    const theirs = Math.max(...ranges);
    const theirReach = Math.max(theirs, ...lane.map((enemy) => Math.max(enemy.kit?.range || 0, enemy.kit?.reach || 0)));
    const mine = Math.max(kit.range, kit.reach || 0);
    const auto = Math.max(-RANGE_CAP, Math.min(RANGE_CAP, (kit.range - theirs) / 100 * RANGE_POINTS_PER_100));
    const poke = mine - theirReach >= 100 ? REACH_POINTS : theirReach - mine >= 100 ? -REACH_POINTS : 0;
    range = { points: auto + poke, theirs, theirReach };
  }
  const stunners = lane.filter((enemy) => enemy.kit?.hardCc).length;
  const cc = !kit.mobile && stunners ? { points: -Math.min(CC_CAP, stunners * CC_POINTS), stunners } : null;
  return { range, cc };
}

/**
 * The lane, solved as a whole: every likely pairing of enemy laners (bot lane = ADC + support) weighed by its chance
 * (laneOdds), so "Veigar + Viktor" is one 2v2 guess instead of two separate mid guesses. Matchup stats give one part
 * per enemy (bot lane: ADC 1, support 0.6, see LANE_WEIGHT; the row for the role they play in that pairing, else any
 * row for them); the kits give a range part and a crowd-control part. Each part's points are the chance-weighted sum
 * over the pairings; the text describes the likeliest one.
 */
function laneParts(candidate: PickCandidate, role: MetaRole, enemies: PickEnemy[]): PickPart[] {
  if (!enemies.length) return [];
  const lanes = laneOdds(enemies.map((enemy) => enemy.odds), LANE_ROLES[role]).filter((lane) => lane.members.length && lane.chance >= LANE_CHANCE);
  if (!lanes.length) return [];
  const stats = new Map<string, { points: number; chance: number; text: string; missing: boolean }>();
  const kit = { range: 0, cc: 0, rangeText: "", ccText: "" };
  for (const lane of lanes) {
    lane.members.forEach((index, at) => {
      const enemy = enemies[index];
      const enemyRole = lane.roles[at];
      const weight = LANE_WEIGHT[role][enemyRole] ?? 0.6;
      const row = candidate.matchups?.find((match) => match.opponent === enemy.champion && match.opponentRole === enemyRole)
        || candidate.matchups?.find((match) => match.opponent === enemy.champion);
      const entry = stats.get(enemy.champion) || { points: 0, chance: 0, text: "", missing: !row };
      entry.chance += lane.chance;
      if (row) {
        // The edge over the champion's own average, so its general strength is not counted twice.
        const edge = row.winRate - (candidate.overallWinRate ?? 50);
        const trust = row.games === null ? 0.5 : Math.min(1, row.games / MATCHUP_FULL_GAMES);
        entry.points += edge * weight * trust * lane.chance;
        entry.text ||= `${row.winRate.toFixed(1)}% vs ${enemy.champion}${row.games ? ` (${row.games.toLocaleString("en-US")} games)` : ""}`;
        entry.missing = false;
      }
      stats.set(enemy.champion, entry);
    });
    if (candidate.kit) {
      const value = kitValue(candidate.kit, lane.members.map((index) => enemies[index]));
      if (value.range) {
        kit.range += value.range.points * lane.chance;
        kit.rangeText ||= `range: your ${candidate.kit.range} attack / ${Math.max(candidate.kit.range || 0, candidate.kit.reach || 0)} poke vs their ${value.range.theirs} / ${value.range.theirReach}`;
      }
      if (value.cc) {
        kit.cc += value.cc.points * lane.chance;
        kit.ccText ||= `${value.cc.stunners === 1 ? "a stun or root" : `${value.cc.stunners} stuns or roots`} in their lane and no dash to escape`;
      }
    }
  }
  const inLane = (chance: number) => chance < 0.75 ? ` (${pct(chance)} likely in your lane)` : "";
  const parts: PickPart[] = [...stats.entries()].map(([champion, entry]): PickPart => entry.missing
    ? { kind: "lane", points: 0, text: `vs ${champion}${inLane(entry.chance)}: no matchup data` }
    : { kind: "lane", points: entry.points, text: `${entry.text}${inLane(entry.chance)}` });
  const [pair] = lanePairs(lanes);
  const likeliest = pair.chance >= 0.75 ? "" : ` (likeliest: ${pair.members.map((index) => enemies[index].champion).join(" + ")}, ${pct(pair.chance)})`;
  if (kit.rangeText) parts.push({ kind: "kit", points: kit.range, text: `${kit.rangeText}${likeliest}` });
  if (kit.ccText) parts.push({ kind: "kit", points: kit.cc, text: `${kit.ccText}${likeliest}` });
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
    parts.push(...laneParts(candidate, input.role, input.enemies));
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

// Champ select pick helper: enemy role guesses (lib/role-rates.ts) and the pool ranking (lib/pick-advisor.ts).
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/pick-advisor.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { rankPicks, type PickCandidate } from "@/lib/pick-advisor";
import { guessTeamRoles, likeliestRole, roleOdds, type RoleOdds } from "@/lib/role-rates";

// Play-rate rows shaped like Meraki's table (percent of games per role), keyed by numeric champion id.
const rates = {
  fetchedAt: new Date().toISOString(), patch: "test",
  rates: {
    "81": { TOP: 0, JUNGLE: 0, MIDDLE: 0.2, BOTTOM: 9, UTILITY: 0 }, // a bot-lane marksman
    "412": { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 7 }, // a support
    "147": { TOP: 0, JUNGLE: 0, MIDDLE: 1.2, BOTTOM: 1.4, UTILITY: 2.1 }, // a flex pick: support first, also bot and mid
  },
};
const odds = (key: string, tags: string[] = []) => roleOdds({ key, tags }, rates);

test("role odds: play rates normalised; unknown champions fall back to their Data Dragon class", () => {
  assert.ok(odds("81").BOTTOM > 0.9);
  const unknown = odds("9999", ["Marksman"]);
  assert.equal(likeliestRole(unknown).role, "BOTTOM");
  assert.ok(Math.abs(Object.values(unknown).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("team roles: five champions fill five roles, so a flex pick takes the role the others leave free", () => {
  const alone = likeliestRole(guessTeamRoles([odds("147")])[0]);
  assert.equal(alone.role, "UTILITY", "on its own the flex pick looks like a support");
  const [, support, flex] = guessTeamRoles([odds("81"), odds("412"), odds("147")]);
  assert.equal(likeliestRole(support).role, "UTILITY");
  assert.notEqual(likeliestRole(flex).role, "UTILITY", "with a real support picked, the flex pick moves to another role");
});

const enemy = (champion: string, role: keyof RoleOdds, chance = 0.95) => ({
  champion, odds: Object.fromEntries((["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const).map((entry) => [entry, entry === role ? chance : (1 - chance) / 4])) as RoleOdds,
});
const candidate = (champion: string, overall: number, vs: Record<string, number>, record: PickCandidate["record"] = null): PickCandidate => ({
  champion, damage: "physical", tank: false, overallWinRate: overall, record,
  matchups: Object.entries(vs).map(([opponent, winRate]) => ({ opponent, opponentRole: opponent === "Thresh" ? "UTILITY" : "BOTTOM", winRate, games: 5000 })),
});

test("ranking: bot lane weighs the enemy ADC fully and the support less; a matchup edge is over the champion's own average", () => {
  const ranked = rankPicks({
    role: "BOTTOM",
    candidates: [candidate("Caitlyn", 50, { Ezreal: 55, Thresh: 49 }), candidate("Jinx", 51, { Ezreal: 48, Thresh: 52 })],
    enemies: [enemy("Ezreal", "BOTTOM"), enemy("Thresh", "UTILITY")],
    allies: [],
  });
  assert.equal(ranked[0].champion, "Caitlyn", "+5 vs the ADC beats Jinx's 1-point higher average and -3 vs the ADC");
  const lane = ranked[0].parts.filter((part) => part.kind === "lane");
  assert.equal(lane.length, 2);
  assert.ok(Math.abs(lane[0].points) > Math.abs(lane[1].points) || lane[0].text.includes("Ezreal"));
});

test("ranking: the player's own record counts, shrunk toward 50% and capped", () => {
  const ranked = rankPicks({
    role: "BOTTOM",
    candidates: [candidate("Caitlyn", 50, {}, { games: 30, wins: 20 }), candidate("Jinx", 51, {}, { games: 2, wins: 0 })],
    enemies: [], allies: [],
  });
  assert.equal(ranked[0].champion, "Caitlyn");
  const record = ranked[0].parts.find((part) => part.kind === "record")!;
  assert.ok(record.points > 0 && record.points <= 5, `capped: ${record.points}`);
});

test("ranking: missing matchup data is said, not guessed", () => {
  const ranked = rankPicks({ role: "BOTTOM", candidates: [{ ...candidate("Caitlyn", 50, {}), matchups: null }], enemies: [enemy("Ezreal", "BOTTOM")], allies: [] });
  assert.ok(ranked[0].missingData);
  assert.ok(ranked[0].parts.some((part) => /no matchup data/.test(part.text) && part.points === 0));
});

test("ranking: an all-physical team so far favours a magic damage pick", () => {
  const ad = { damage: "physical" as const, tank: false };
  const ranked = rankPicks({
    role: "MIDDLE",
    candidates: [{ ...candidate("Talon", 50, {}), damage: "physical" }, { ...candidate("Ahri", 50, {}), damage: "magic" }],
    enemies: [], allies: [{ champion: "Darius", ...ad }, { champion: "Graves", ...ad }],
  });
  assert.equal(ranked[0].champion, "Ahri");
});

test("ranking: experience counts apart from results; a main with a losing record beats a champion played 3 times", () => {
  const ranked = rankPicks({
    role: "BOTTOM",
    candidates: [{ ...candidate("Caitlyn", 50, {}, { games: 47, wins: 20 }), matchups: null }, { ...candidate("Kai'Sa", 50, {}, { games: 3, wins: 1 }), matchups: null }],
    enemies: [], allies: [],
  });
  assert.equal(ranked[0].champion, "Caitlyn");
  assert.ok(ranked[1].parts.some((part) => part.kind === "comfort" && part.points < 0));
});

test("ranking: like with like — while one champion has no matchup data, patch and lane data are shown but not counted", () => {
  const ranked = rankPicks({
    role: "BOTTOM",
    candidates: [
      { ...candidate("Caitlyn", 48.3, { Ezreal: 50.5 }, { games: 48, wins: 20 }) },
      { ...candidate("Miss Fortune", 50, {}, { games: 4, wins: 2 }), overallWinRate: null, matchups: null },
    ],
    enemies: [enemy("Ezreal", "BOTTOM")], allies: [],
  });
  assert.ok(ranked.every((entry) => entry.partial));
  const caitlyn = ranked.find((entry) => entry.champion === "Caitlyn")!;
  assert.ok(caitlyn.parts.filter((part) => part.kind === "patch" || part.kind === "lane").every((part) => part.counted === false));
  const counted = caitlyn.parts.filter((part) => part.counted !== false).reduce((sum, part) => sum + part.points, 0);
  assert.equal(caitlyn.score, Math.round(counted * 10) / 10, "the score is only the counted parts");
});

test("ranking: an off-role bot lane (each enemy ~31% bot or support) still counts, each enemy once", () => {
  const split = (champion: string): ReturnType<typeof enemy> => ({ champion, odds: { TOP: 0.01, JUNGLE: 0.01, MIDDLE: 0.36, BOTTOM: 0.31, UTILITY: 0.31 } });
  const [only] = rankPicks({
    role: "BOTTOM",
    candidates: [{ ...candidate("Caitlyn", 48, {}), matchups: [{ opponent: "Veigar", opponentRole: "BOTTOM", winRate: 46, games: 800 }] }],
    enemies: [split("Veigar")], allies: [],
  });
  const lane = only.parts.filter((part) => part.kind === "lane");
  assert.equal(lane.length, 1, "one part per enemy, not one per possible lane");
  assert.match(lane[0].text, /62% likely in your lane/);
  assert.ok(lane[0].points < 0);
});

test("2v2 kit: longer range than their best and an escape beat a short-range, immobile pick against two stuns", () => {
  const bot = (champion: string, role: "BOTTOM" | "UTILITY", kit: { range: number; reach: number; hardCc: boolean }) => ({ ...enemy(champion, role), kit: { ...kit, mobile: false } });
  const ranked = rankPicks({
    role: "BOTTOM",
    candidates: [
      { ...candidate("Caitlyn", 50, {}), kit: { range: 650, reach: 1250, hardCc: true, mobile: true } },
      { ...candidate("Miss Fortune", 50, {}), kit: { range: 550, reach: 1000, hardCc: false, mobile: false } },
    ],
    enemies: [bot("Veigar", "BOTTOM", { range: 550, reach: 1000, hardCc: true }), bot("Viktor", "UTILITY", { range: 525, reach: 600, hardCc: true })],
    allies: [],
  });
  assert.equal(ranked[0].champion, "Caitlyn");
  const range = (name: string) => ranked.find((entry) => entry.champion === name)!.parts.find((part) => part.kind === "kit" && part.text.startsWith("range"))!;
  assert.ok(range("Caitlyn").points >= 1, `650 vs 550 and 1250 vs 1000 poke: ${range("Caitlyn").points}`);
  assert.equal(range("Miss Fortune").points, 0, "550 vs 550, 1000 vs 1000");
  const stuns = ranked.find((entry) => entry.champion === "Miss Fortune")!.parts.find((part) => /stuns or roots/.test(part.text));
  assert.ok(stuns && stuns.points < 0, "two stunners against no dash");
  assert.ok(!ranked.find((entry) => entry.champion === "Caitlyn")!.parts.some((part) => /stun/.test(part.text)), "Caitlyn can escape");
});

test("lane pairs: two usual mid laners with top, jungle and mid taken are read as one bot lane pair", async () => {
  const { laneOdds, lanePairs } = await import("@/lib/role-rates");
  const solo = (role: keyof RoleOdds) => Object.fromEntries((["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const).map((entry) => [entry, entry === role ? 0.96 : 0.01])) as RoleOdds;
  const midder = { TOP: 0.01, JUNGLE: 0.01, MIDDLE: 0.9, BOTTOM: 0.04, UTILITY: 0.04 } as RoleOdds;
  const [pair] = lanePairs(laneOdds([solo("TOP"), solo("JUNGLE"), solo("MIDDLE"), midder, midder], ["BOTTOM", "UTILITY"]));
  assert.deepEqual(pair.members, [3, 4]);
  assert.ok(pair.chance > 0.5, `the likeliest pair by a clear margin: ${pair.chance}`);
});

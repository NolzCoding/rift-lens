import path from "node:path";

import { mainRoleFor } from "@/lib/build-research";
import { championByNumericKey, championEntry, loadChampionIndex, type ChampionIndex } from "@/lib/champion-data";
import { championTraits, isTank, type CcKind } from "@/lib/champion-traits";
import { championBase, loadEnemyStatsData, type EnemyStatsData } from "@/lib/enemy-stats";
import { lcuJson } from "@/lib/lcu";
import { getItemCatalog } from "@/lib/live-game";
import { ensureLoadoutsLoaded, loadoutJobState, requestLoadout, storedLoadout, type StoredLoadout } from "@/lib/loadout-research";
import { ensureMatchupsLoaded, matchupJobState, requestMatchups, storedMatchups } from "@/lib/matchup-research";
import { championKey, memoryRoot, readJson, writeJsonAtomic } from "@/lib/memory-store";
import { isMetaRole, majorMinor, type MetaRole } from "@/lib/meta-builds";
import { rankPicks, type LaneKit, type PickAlly, type PickCandidate, type PickSuggestion } from "@/lib/pick-advisor";
import { getProfile } from "@/lib/player-profile";
import { guessTeamRoles, laneOdds, lanePairs, likeliestRole, loadRoleRates, roleOdds, ROLES } from "@/lib/role-rates";

// Champ select pick helper: the player's champion pool, the League client's live champ select (/lol-champ-select/v1/session:
// own assigned role, both teams' locked picks, bans; Riot hides enemy roles, so lib/role-rates.ts guesses them), and the
// pool ranked for the player's role by lib/pick-advisor.ts. Read-only: it never hovers, bans or locks anything.

export type PoolEntry = { champion: string; roles: MetaRole[] };
type PoolFile = { version: 1; updatedAt: string; champions: PoolEntry[] };
const poolFile = () => path.join(memoryRoot(), "champion-pool.json");

type Member = { cellId?: number; championId?: number; championPickIntent?: number; assignedPosition?: string };
type Action = { actorCellId?: number; championId?: number; completed?: boolean; isInProgress?: boolean; type?: string };
type Session = {
  localPlayerCellId?: number;
  myTeam?: Member[];
  theirTeam?: Member[];
  actions?: Action[][];
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] };
  timer?: { phase?: string };
};
type Gameflow = { phase?: string; gameData?: { queue?: { id?: number; gameMode?: string; description?: string } } };

export type ResearchState = "fresh" | "stale" | "missing" | "researching" | "queued" | "failed";
export type ChampSelectView = {
  active: boolean;
  queue: { id: number | null; label: string; draft: boolean } | null;
  myRole: MetaRole | null;
  myTurn: boolean;
  /** Locked champion, else the one being hovered. */
  myChampion: string | null;
  myLocked: boolean;
  allies: Array<{ champion: string | null; role: MetaRole | null; locked: boolean }>;
  /** Each enemy's role from the whole-team guess; `alt` = the next likeliest when it is not clear (below 60%). */
  enemies: Array<{ champion: string; role: MetaRole; chance: number; alt: MetaRole | null }>;
  /** The likeliest enemy line-ups of the player's lane (bot lane: the ADC + support pair), best first. */
  laneGuess: Array<{ champions: string[]; chance: number }>;
  bans: string[];
  pool: PoolEntry[];
  poolSource: "saved" | "history" | "empty";
  /** For the player's role (every pool role when no role is assigned). */
  suggestions: Array<PickSuggestion & { role: MetaRole; research: ResearchState }>;
  /** Runes and summoner spells for the champion you locked or hover (lib/loadout-research.ts). */
  loadout: { champion: string; role: MetaRole; research: ResearchState; entry: StoredLoadout | null } | null;
  note: string | null;
  patch: string | null;
  /** Data Dragon version and champion name → Data Dragon id, for champion images. */
  version: string;
  imageIds: Record<string, string>;
  champions?: string[];
};

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export async function readPool(): Promise<PoolFile | null> {
  const stored = await readJson<PoolFile>(poolFile());
  return stored?.version === 1 && Array.isArray(stored.champions) ? stored : null;
}

/** Canonical names, standard roles, no duplicates; at most 12 champions. Throws on an unknown champion. */
export async function savePool(input: unknown): Promise<PoolEntry[]> {
  const catalog = await getItemCatalog();
  const index = await loadChampionIndex(catalog.version);
  const rows = Array.isArray(input) ? input : [];
  const pool: PoolEntry[] = [];
  for (const row of rows.slice(0, 12)) {
    const entry = championEntry(index, String((row as PoolEntry)?.champion || ""));
    if (!entry) throw new Error(`Unknown champion "${String((row as PoolEntry)?.champion || "").slice(0, 40)}".`);
    const roles = [...new Set(((row as PoolEntry).roles || []).filter(isMetaRole))];
    if (!roles.length || pool.some((existing) => existing.champion === entry.name)) continue;
    pool.push({ champion: entry.name, roles });
  }
  await writeJsonAtomic(poolFile(), { version: 1, updatedAt: new Date().toISOString(), champions: pool } satisfies PoolFile);
  for (const entry of pool) for (const role of entry.roles) requestMatchups(entry.champion, role, catalog.version);
  return pool;
}

/** No saved pool yet: the champions the player has 3+ games on, each in its likeliest role. */
async function poolFromHistory(index: ChampionIndex): Promise<PoolEntry[]> {
  const [profile, rates] = await Promise.all([getProfile().catch(() => null), loadRoleRates()]);
  return (profile?.champions || [])
    .filter((entry) => entry.games >= 3)
    .sort((a, b) => b.games - a.games)
    .slice(0, 6)
    .flatMap((entry) => {
      const champion = championEntry(index, entry.champion);
      return champion ? [{ champion: champion.name, roles: [likeliestRole(roleOdds(champion, rates)).role] }] : [];
    });
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const QUEUE_LABELS: Record<number, string> = { 400: "Normal Draft", 420: "Ranked Solo/Duo", 440: "Ranked Flex", 430: "Blind Pick", 480: "Swiftplay", 490: "Quickplay" };

/**
 * A made-up ranked champ select (/live?champselect=mock): you are bot lane on your pick turn, an ally support and top have
 * picked, the enemy has Ezreal, Thresh and Ahri locked. Real pool, real matchup data; only the client's answer is fake.
 */
const MOCK_SESSION: Session = {
  localPlayerCellId: 3,
  myTeam: [
    { cellId: 0, championId: 122, assignedPosition: "top" }, { cellId: 1, championPickIntent: 64, assignedPosition: "jungle" },
    { cellId: 2, championId: 0, assignedPosition: "middle" }, { cellId: 3, championPickIntent: 51, assignedPosition: "bottom" },
    { cellId: 4, championId: 117, assignedPosition: "utility" },
  ],
  theirTeam: [{ cellId: 5, championId: 81 }, { cellId: 6, championId: 412 }, { cellId: 7, championId: 103 }, { cellId: 8 }, { cellId: 9 }],
  actions: [[{ actorCellId: 3, type: "pick", isInProgress: true, completed: false }]],
  bans: { myTeamBans: [222], theirTeamBans: [119] },
};
const MOCK_FLOW: Gameflow = { gameData: { queue: { id: 420 } } };

export async function champSelectView(options: { withChampions?: boolean; mock?: boolean } = {}): Promise<ChampSelectView> {
  const catalog = await getItemCatalog();
  const index = await loadChampionIndex(catalog.version);
  await Promise.all([ensureMatchupsLoaded(), ensureLoadoutsLoaded()]);
  const saved = await readPool();
  const pool = saved?.champions.length ? saved.champions : await poolFromHistory(index);
  const poolSource: ChampSelectView["poolSource"] = saved?.champions.length ? "saved" : pool.length ? "history" : "empty";
  // Research ahead of time (once per patch, one at a time; requestMatchups returns at once): a champ select is shorter
  // than a few researches, so data started there arrived after the pick. A guessed pool: its 4 most played only.
  if (!options.mock) {
    for (const entry of pool.slice(0, poolSource === "saved" ? pool.length : 4)) {
      for (const role of entry.roles) { requestMatchups(entry.champion, role, catalog.version); requestLoadout(entry.champion, role, catalog.version); }
    }
  }
  const base: ChampSelectView = {
    active: false, queue: null, myRole: null, myTurn: false, myChampion: null, myLocked: false, allies: [], enemies: [], laneGuess: [], bans: [],
    pool, poolSource, suggestions: [], loadout: null, note: null, patch: majorMinor(catalog.version) || null, version: catalog.version, imageIds: {},
    ...(options.withChampions ? { champions: [...new Set([...index.values()].map((entry) => entry.name))].sort() } : {}),
  };
  const [session, flow] = options.mock ? [MOCK_SESSION, MOCK_FLOW]
    : await Promise.all([lcuJson<Session>("/lol-champ-select/v1/session", 1500), lcuJson<Gameflow>("/lol-gameflow/v1/session", 1500)]);
  if (!session?.myTeam?.length) return withImages(base, index);

  const name = (id: number | undefined) => (id && id > 0 ? championByNumericKey(index, id)?.name : null) || null;
  const me = session.myTeam.find((member) => member.cellId === session.localPlayerCellId) || null;
  const assigned = (me?.assignedPosition || "").toUpperCase();
  const myRole = isMetaRole(assigned) ? assigned : null;
  const queueId = flow?.gameData?.queue?.id ?? null;
  const queue = { id: queueId, label: (queueId !== null && QUEUE_LABELS[queueId]) || flow?.gameData?.queue?.description || "Champ select", draft: myRole !== null };
  const actions = (session.actions || []).flat();
  const myTurn = actions.some((action) => action.actorCellId === session.localPlayerCellId && action.type === "pick" && action.isInProgress && !action.completed);
  const bans = [...new Set([
    ...(session.bans?.myTeamBans || []), ...(session.bans?.theirTeamBans || []),
    ...actions.filter((action) => action.type === "ban" && action.completed).map((action) => action.championId || 0),
  ].map(name).filter((entry): entry is string => Boolean(entry)))];

  const allies = session.myTeam.filter((member) => member !== me).map((member) => {
    const role = (member.assignedPosition || "").toUpperCase();
    return { champion: name(member.championId) || name(member.championPickIntent), role: isMetaRole(role) ? role : null, locked: Boolean(member.championId) };
  });
  const enemyNames = (session.theirTeam || []).map((member) => name(member.championId)).filter((entry): entry is string => Boolean(entry));
  const rates = await loadRoleRates();
  // Each champion's own role odds go to the ranking (it solves the lane pairing itself); the whole-team guess is shown.
  const priors = enemyNames.map((champion) => roleOdds(championEntry(index, champion)!, rates));
  const teamOdds = guessTeamRoles(priors);
  const stats = await Promise.race([loadEnemyStatsData(catalog.version), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
  const enemies = enemyNames.map((champion, at) => ({ champion, odds: priors[at], kit: laneKit(champion, index, stats) }));
  const shownEnemies = enemyNames.map((champion, at) => {
    const [first, second] = [...ROLES].sort((a, b) => teamOdds[at][b] - teamOdds[at][a]);
    const chance = teamOdds[at][first];
    return { champion, role: first, chance: Math.round(chance * 100) / 100, alt: chance < 0.6 ? second : null };
  });

  const taken = new Set([...bans, ...enemyNames, ...allies.filter((ally) => ally.locked).map((ally) => ally.champion || "")].map(championKey));
  const profile = await getProfile().catch(() => null);
  const record = (champion: string) => {
    const entry = profile?.champions.find((row) => championKey(row.champion) === championKey(champion));
    return entry ? { games: entry.games, wins: entry.wins } : null;
  };
  const traitsOf = (champion: string) => { const traits = championTraits(champion, index); return { damage: traits.damage, tank: isTank(traits) }; };
  const pickAllies: PickAlly[] = allies.flatMap((ally) => ally.champion ? [{ champion: ally.champion, ...traitsOf(ally.champion) }] : []);

  // Assigned role: the pool champions that play it. No role (blind / Swiftplay): every pool champion in its first role.
  const lineup = pool.flatMap((entry) => myRole ? (entry.roles.includes(myRole) ? [{ champion: entry.champion, role: myRole }] : []) : [{ champion: entry.champion, role: entry.roles[0] }]);
  const suggestions: ChampSelectView["suggestions"] = [];
  for (const role of ROLES) {
    const group = lineup.filter((entry) => entry.role === role && !taken.has(championKey(entry.champion)));
    if (!group.length) continue;
    // A made-up champ select never starts research.
    if (!options.mock) for (const entry of group) requestMatchups(entry.champion, role, catalog.version);
    const candidates: PickCandidate[] = group.map((entry) => {
      const stored = storedMatchups(entry.champion, role);
      return { champion: entry.champion, ...traitsOf(entry.champion), kit: laneKit(entry.champion, index, stats), overallWinRate: stored?.overallWinRate ?? null, matchups: stored?.matchups ?? null, record: record(entry.champion) };
    });
    for (const suggestion of rankPicks({ role, candidates, enemies, allies: pickAllies })) {
      suggestions.push({ ...suggestion, role, research: matchupJobState(suggestion.champion, role, catalog.version) });
    }
  }
  if (!myRole) suggestions.sort((a, b) => b.score - a.score);

  const note = !pool.length ? "Add the champions you play to get pick suggestions."
    : !myRole ? "No assigned role here (blind pick or Swiftplay): ranked by this patch and your own games, plus any enemy picks."
    : !lineup.length ? `None of your pool champions is set for ${myRole.toLowerCase()}.`
    : !enemies.length ? "No enemy picks yet: ranked by this patch, your games and your team. Updates as they lock in."
    : null;
  // Runes and spells for the champion you have locked or hover: your assigned role, else its role in your pool, else its usual role.
  const myChampion = name(me?.championId) || name(me?.championPickIntent);
  let loadout: ChampSelectView["loadout"] = null;
  if (myChampion) {
    const role = myRole || pool.find((entry) => entry.champion === myChampion)?.roles[0] || mainRoleFor(myChampion, championEntry(index, myChampion));
    if (!options.mock) requestLoadout(myChampion, role, catalog.version, true);
    loadout = { champion: myChampion, role, research: loadoutJobState(myChampion, role, catalog.version), entry: storedLoadout(myChampion, role) };
  }
  return withImages({
    ...base, active: true, queue, myRole, myTurn, myChampion, myLocked: Boolean(me?.championId), allies,
    enemies: shownEnemies, bans, suggestions, loadout, note,
    laneGuess: myRole && enemyNames.length ? lanePairs(laneOdds(priors, myRole === "BOTTOM" || myRole === "UTILITY" ? ["BOTTOM", "UTILITY"] : [myRole]))
      .filter((lane) => lane.members.length && lane.chance >= 0.05).slice(0, 3)
      .map((lane) => ({ champions: lane.members.map((at) => enemyNames[at]), chance: Math.round(lane.chance * 100) / 100 })) : [],
  }, index);
}

const HARD_CC: CcKind[] = ["stun", "root", "charm", "taunt", "fear", "sleep", "polymorph", "knockup", "suppress", "pull"];

/** Lane kit from Riot data: attack range (Data Dragon), longest damaging spell, hard crowd control, a dash or high mobility. */
function laneKit(champion: string, index: ChampionIndex, stats: EnemyStatsData | null): LaneKit {
  const traits = championTraits(champion, index);
  return {
    range: (stats && championBase(stats, champion)?.attackRange) || null,
    reach: traits.pokeRange || null,
    hardCc: traits.ccKinds.some((kind) => HARD_CC.includes(kind)),
    mobile: traits.dashes > 0 || traits.ratings.mobility >= 2,
  };
}

/** Image ids for every champion the view names (and the autocomplete list). */
function withImages(view: ChampSelectView, index: ChampionIndex): ChampSelectView {
  const names = [
    ...view.pool.map((entry) => entry.champion), ...view.suggestions.map((entry) => entry.champion), ...view.enemies.map((entry) => entry.champion),
    ...view.allies.map((entry) => entry.champion || ""), ...view.bans, ...view.laneGuess.flatMap((lane) => lane.champions), ...(view.myChampion ? [view.myChampion] : []), ...(view.champions || []),
  ];
  const imageIds: Record<string, string> = {};
  for (const name of names) { const entry = name ? championEntry(index, name) : null; if (entry) imageIds[entry.name] = entry.id; }
  return { ...view, imageIds };
}

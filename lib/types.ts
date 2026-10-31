import type { EnemyProfileSummary, EstimatedStats } from "@/lib/enemy-stats";

export type SpellInputs = { Q: number; W: number; E: number; R: number };

export type Player = {
  index: number;
  participantId: number;
  champion: string;
  name: string;
  team: number;
  position: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  killParticipation: number;
  laneCs: number;
  jungleCs: number;
  cs: number;
  gold: number;
  level: number;
  damage: number;
  damageShare: number;
  buildingDamage: number;
  vision: number;
  wardsPlaced: number;
  wardsKilled: number;
  longestLife: number;
  teammateShielding: number;
  items: string[];
  itemIds: number[];
  runes: string[];
  spellInputs: SpellInputs;
  immobilizations: number;
};

export type Enemy = {
  participantId: number;
  champion: string;
  name: string;
  position: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  level: number;
  damage: number;
  buildingDamage: number;
};

export type ModeContext = {
  queueId: number | null;
  gameMode: string;
  gameType: string;
  mapId: number | null;
  label: string;
  class: "swiftplay" | "aram" | "arena" | "classic" | "unknown" | string;
  source: "league-client" | "replay-only" | string;
  verified: boolean;
};

export type TimelinePlayerState = {
  participantId: number;
  champion: string;
  level: number;
  xp: number;
  currentGold: number;
  totalGold: number;
  cs: number;
};

export type TimelineContext = {
  source: string;
  sampledAt: number;
  sampleLagSeconds: number;
  allies: TimelinePlayerState[];
  enemies: TimelinePlayerState[];
  goldDelta: number;
  levelDelta: number;
  csDelta: number;
  teamGoldDelta: number;
  insight: string;
};

export type DeepMetrics = {
  Viktor?: {
    observedQ: number;
    observedW: number;
    observedE: number;
    observedRPackets: number;
    qDirectHits: number;
    qEmpoweredChampionHits: number;
    eChampionContacts: number;
    eCastsWithChampionContact: number;
    rDamageTicks: number;
    spellPackets: number;
  };
  Lux?: {
    observedQ: number;
    observedW: number;
    observedEPlacements: number;
    observedRDistinct: number;
    qChampionContacts: number;
    eChampionContacts: number;
    ePlacementsWithChampionContact: number;
    rChampionContacts: number;
    rCastsWithChampionContact: number;
  };
  Duo?: {
    decodedLuxQContacts: number;
    viktorDamageFollowups: number;
    viktorSpellFollowups: number;
    luxRFollowups: number;
  };
};

export type TimelineEvent = {
  id: string;
  timestamp: number;
  champion: string;
  kind: "q-auto" | "root-conversion" | "ultimate" | string;
  quality: "strong" | "partial" | "improve";
  title: string;
  happened: string;
  why: string;
  recommendation: string;
  confidence: string;
  context?: TimelineContext;
};

export type ReplayAnalysis = {
  schemaVersion: number;
  replay: {
    name: string;
    sha256: string;
    clientVersion: string;
    durationMs: number;
    teamKills: number;
    outcome: "win" | "loss";
    mode: ModeContext;
  };
  players: Player[];
  enemyLane: Enemy[];
  deepMetrics: DeepMetrics | null;
  timeline: TimelineEvent[];
  deepStatus: string;
  reportMarkdown: string;
  /** Added by Rift Lens after the reader runs (lib/replay-enrich.ts); absent on raw reader output and the sample. */
  review?: ReplayReviewData;
};

/** One of the ten players, from the .rofl's end-of-game stats (lib/rofl-metadata.ts). */
export type ReplayParticipant = {
  participantId: number;
  champion: string;
  name: string;
  team: number;
  position: string;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  cs: number;
  win: boolean;
  itemIds: number[];
  items: string[];
};

export type BuildTone = "good" | "warn" | "bad" | "info";

/** Rift Lens's verdict on one final-inventory item (lib/replay-build-review.ts). */
export type BuildItemVerdict = {
  itemId: number;
  item: string;
  /** core/boots/meta = in the top build; counter = an answer to something the enemy team built; component = unfinished. */
  kind: "core" | "boots" | "meta" | "counter" | "situational" | "off-meta" | "misfit" | "component" | "unrated";
  tone: BuildTone;
  label: string;
  reason: string;
};

export type BuildFinding = {
  kind: "missing-core" | "order" | "group-lock" | "group-clash" | "counter-gap" | "counter-unneeded" | "misfit" | "off-meta";
  tone: BuildTone;
  title: string;
  detail: string;
};

export type BuildReview = {
  participantId: number;
  champion: string;
  role: string;
  scaling: "ad" | "ap" | "tank" | "hybrid";
  topBuild: {
    label: string;
    role: string;
    /** The build was made for this role, not the one played (role fallback). */
    builtFor: string | null;
    slots: Array<{ label: string; kind: string; options: string[]; matched: string | null }>;
  } | null;
  items: BuildItemVerdict[];
  findings: BuildFinding[];
  /** Enemy-team signals that fired, e.g. "healing heavy: Soraka + Aatrox (Sundered Sky)". */
  enemySignals: string[];
};

/** What the live recorder saw in the same match (work/rift-lens-memory/games). */
export type RecordedTimeline = {
  recordId: string;
  startedAt: string;
  matchedBy: "game-id" | "duration";
  partial: boolean;
  csAt10: number | null;
  /** The player's average CS@10 on this champion over their other recorded games, and how many. */
  csAt10Average: number | null;
  csAt10Games: number;
  /** Completed items (boots included) in purchase order, with game seconds. */
  completed: Array<{ time: number; item: string; itemId: number }>;
  purchases: GameRecordPurchase[];
  deaths: GameRecordDeath[];
};

export type ReplayReviewData = {
  version: 1;
  /** Data Dragon version used for item names and stats. */
  dataPatch: string | null;
  /** participantId of the uploader (players[] may also hold their bot-lane partner). */
  youId: number | null;
  allies: ReplayParticipant[];
  enemies: ReplayParticipant[];
  builds: BuildReview[];
  recorded: RecordedTimeline | null;
  caveats: string[];
};

export type AiFinding = {
  title: string;
  evidence: string;
  advice: string;
};

export type AiPlayerReview = {
  champion: string;
  verdict: "excellent" | "good" | "mixed" | "needs-work";
  summary: string;
  strengths: AiFinding[];
  improvements: AiFinding[];
  buildVerdict: string;
  buildNotes: string[];
};

export type AiMomentReview = {
  eventId: string;
  timestamp: number;
  champion: string;
  quality: "strong" | "partial" | "improve";
  title: string;
  read: string;
  betterPlay: string;
};

export type AiPriority = {
  title: string;
  why: string;
  drill: string;
};

export type AiReplayReview = {
  headline: string;
  overview: string;
  confidence: "high" | "medium" | "limited";
  evidenceLimits: string[];
  playerReviews: AiPlayerReview[];
  keyMoments: AiMomentReview[];
  priorities: AiPriority[];
};

export type AiReviewEnvelope = {
  cacheKey: string;
  generatedAt: string;
  model: string;
  source: "cache" | "generated";
  review: AiReplayReview;
};

export type LiveItem = {
  id: number;
  name: string;
  count: number;
  price: number;
  description: string;
  /** Active player only: boots in the role-quest boots slot, which the Live Client API no longer lists (lib/boots-slot.ts). */
  bootsSlot?: true;
  /** Enemies only: armor / magic resist one copy grants (Data Dragon item stats), when it grants any. */
  armor?: number;
  magicResist?: number;
};

export type LivePlayer = {
  champion: string;
  name: string;
  riotId: string;
  team: string;
  position: string;
  level: number;
  isDead: boolean;
  respawnTimer: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  wardScore: number;
  items: LiveItem[];
  threatScore: number;
  threat: "critical" | "high" | "watch" | "normal";
  damageProfile: "physical" | "magic" | "mixed" | "unknown";
  /** Data Dragon champion tags, e.g. ["Assassin", "Mage"]. Empty when unavailable. */
  roles: string[];
  /** Display names from allPlayers[].summonerSpells, e.g. ["Flash", "Ignite"]. */
  summonerSpells: string[];
  /** allPlayers[].runes.keystone display name, or null. */
  keystone: string | null;
  /** Enemies only: stats estimated from Data Dragon base stats + growth + item stats (lib/enemy-stats.ts). Runes, stacks and buffs are not included. */
  estStats?: EstimatedStats;
};

/** Percent fields (pen %, lifeSteal, omnivamp) are normalised to 0–100. */
export type LiveActiveStats = {
  abilityPower: number;
  attackDamage: number;
  armor: number;
  magicResist: number;
  abilityHaste: number;
  attackSpeed: number;
  magicPenetrationFlat: number;
  magicPenetrationPercent: number;
  armorPenetrationFlat: number;
  armorPenetrationPercent: number;
  lifeSteal: number;
  omnivamp: number;
  moveSpeed: number;
  attackRange: number;
};

export type LiveObjectiveTimer = {
  id: "dragon" | "baron" | "herald" | "grubs" | "atakhan" | "elder";
  label: string;
  status: "up" | "respawning" | "not-spawned" | "taken" | "unknown";
  /** Game seconds when it (re)spawns; null when up or unknown. */
  nextSpawnAt: number | null;
  note: string;
};

export type LiveDragonState = {
  alliedDragons: string[];
  enemyDragons: string[];
  soulPoint: "ally" | "enemy" | "both" | null;
  soulType: string | null;
};

/** Deterministic, no-AI read of the player's most recent death while they are dead. */
export type LiveDeathMoment = {
  diedAt: number;
  respawnIn: number;
  killer: string;
  killerChampion: string;
  assisters: string[];
  goldNow: number;
  /** Concrete purchases that fit currentGold right now, in priority order. */
  buyNow: Array<{ itemId: number; item: string; cost: number; forItem: string | null }>;
  /**
   * The completed items those purchases build toward (build-path item first, then boots).
   * costNow = what finishing it costs given owned components; spendNow = buyNow gold going into it;
   * remainingAfter = gold still needed after this shopping trip; nextPiece = cheapest next component when nothing fits.
   */
  goals: Array<{
    itemId: number;
    item: string;
    cost: number;
    costNow: number;
    spendNow: number;
    remainingAfter: number;
    completes: boolean;
    nextPiece: { itemId: number; item: string; cost: number; goldNeeded: number } | null;
  }>;
  /** Short measured/inferred reasons, e.g. "3v1: killer had 2 assisters". */
  reasons: string[];
  /** From PlayerBrief history, e.g. "4th game in a row dying to Kha'Zix pre-10". */
  patternNote: string | null;
};

export type LiveDeathSource = {
  champion: string;
  playerName: string;
  deathsTo: number;
};

export type LiveRecommendation = {
  itemId: number;
  item: string;
  cost: number;
  description: string;
  priority: "primary" | "situational" | "defensive";
  action: "buy" | "swap";
  timing: "first-item" | "mid-game" | "late-game" | "swap";
  reason: string;
  /** Set on recommendations[0] when an enemy-stat signal (lib/enemy-stats.ts) changed the next buy, e.g. "Their armor is stacking (Ornn ~185 armor, Sejuani ~160)". */
  counterReason?: string;
  /** The game-start buy (Summoner's Rift with 500g, nothing owned yet): every starting item; `item` is the first, `cost` the total. */
  starting?: Array<{ itemId: number; item: string; cost: number }>;
  trigger: string;
  usageTip: string;
  nextStep: {
    itemId: number;
    item: string;
    cost: number;
    affordable: boolean;
    goldNeeded: number;
  } | null;
  swapPlan: {
    sellItemId: number;
    sellItem: string;
    sellValue: number;
    buyCost: number;
    availableGoldAfterSale: number;
    affordable: boolean;
    goldNeeded: number;
    goldAfter: number;
    rationale: string;
  } | null;
};

export type LiveChampionContext = {
  source: "Riot Data Dragon" | "fallback";
  patch: string;
  passive: { name: string; description: string };
  abilities: Array<{ key: "Q" | "W" | "E" | "R"; name: string; description: string }>;
  allyTips: string[];
};

export type LiveRecentEvent = {
  id: number;
  type: string;
  time: number;
  text: string;
  tone: "good" | "bad" | "neutral";
};

export type LiveGameSnapshot = {
  status: "live";
  capturedAt: string;
  /** Stable per-match id derived from the 10 players (see liveGameId in lib/live-game.ts). */
  gameId: string;
  game: {
    mode: string;
    modeLabel: string;
    map: string;
    time: number;
    phase: "opening" | "early" | "mid" | "late";
    queuePrecision: "exact" | "limited";
  };
  matchup: {
    basis: "riot-position" | "team-gap" | "champion-role" | "highest-threat";
    note: string;
  };
  activePlayer: LivePlayer & {
    currentGold: number;
    health: number;
    maxHealth: number;
    resource: number;
    maxResource: number;
    stats: LiveActiveStats;
    abilityLevels: { Q: number; W: number; E: number; R: number };
    runes: { keystone: string | null; primaryTree: string | null; secondaryTree: string | null };
    /** How `position` was decided: Riot's live position, the team's missing role, or the champion's usual role. */
    positionBasis?: "riot-position" | "team-gap" | "champion-role" | "highest-threat";
  };
  laneOpponent: LivePlayer | null;
  allies: LivePlayer[];
  enemies: LivePlayer[];
  recommendations: LiveRecommendation[];
  mobilityRecommendation: LiveRecommendation | null;
  deathSources: LiveDeathSource[];
  recentEvents: LiveRecentEvent[];
  dataDragonVersion: string;
  championContext: LiveChampionContext;
  objectives: LiveObjectiveTimer[];
  dragonState: LiveDragonState;
  /** Non-null only while the active player is dead. */
  deathMoment: LiveDeathMoment | null;
  /** Long-term memory for this champion/matchup; null when no history exists yet. */
  playerBrief: PlayerBrief | null;
  /** Raw GameEnd result when Riot has emitted it. */
  gameResult: "win" | "loss" | null;
  /** The build the engine believes the player is on, in order. Drives recommendations[0]. */
  buildPath: LiveBuildPath;
  /**
   * What the champion's damage scales with (lib/live-game.ts championScaling): ad / ap / tank, or hybrid (both fit).
   * Path steps and cards never name an item that does not fit it (an AP item for an AD champion…) unless owned or pinned.
   */
  scaling?: "ad" | "ap" | "tank" | "hybrid";
  /** Team-level counter-build signals from the enemies' estimated stats (lib/enemy-stats.ts); absent when Data Dragon is unreachable. */
  enemyProfile?: EnemyProfileSummary;
  /**
   * The engine's answer to each resist the player's damage runs into (armor for physical damage, magic resist for magic;
   * a hybrid champion gets both): the signal's level and the counter item the engine's own counter logic picks (fits the
   * champion, not group-locked, a top-build option first). Read by the resist alerts (lib/live-alerts.ts).
   */
  counterPicks?: Array<{ signal: "armorStack" | "mrStack"; level: "none" | "some" | "heavy"; itemId: number | null; item: string | null }>;
  /** Item-data health: which Data Dragon patch is in use and whether saved/imported builds still resolve. */
  patchStatus?: { version: string; fallback: boolean; unknownBuildItems: string[]; note: string | null };
  caveats: string[];
};

export type LiveBuildPath = {
  /**
   * pinned = player set it; imported = item set pushed into the League client (e.g. by Mobalytics/Overwolf); meta = the
   * patch-stamped top build for the champion/role (lib/meta-builds.ts: researched on the web for this patch, else curated), with the player's history choosing only between its
   * options; history = learned from recorded games; inventory = inferred from owned items/components; default = engine's champion/class logic.
   */
  source: "pinned" | "imported" | "meta" | "history" | "inventory" | "default";
  /** e.g. "Your pinned Caitlyn build", "Top Caitlyn build (patch 16.20) · your picks where there's a choice", "Following your Noonquiver → Hexoptics C44". */
  label: string;
  /**
   * skipped = a pinned/imported step League will not let the player buy (an exclusive item group is already filled, e.g.
   * Lord Dominik's Regards while owning Mortal Reminder); `note` says why. Other sources drop such items instead.
   */
  steps: Array<{ itemId: number; item: string; cost: number; status: "owned" | "next" | "later" | "skipped"; note?: string }>;
  /** source "meta" only: where the top build came from (web research validated by Rift Lens, or the hand-curated table). */
  meta?: {
    origin: "researched" | "curated";
    patch: string;
    /** "researched 16.20 (op.gg, lolalytics)" / "curated 16.20". */
    label: string;
    sample: string;
    /** Date researched / hand-checked. */
    checked: string;
    /** Older-patch research or stale site data. */
    outdated: boolean;
    sources: Array<{ name: string; url: string; site: string }>;
    /** The build was made for another role than the one the player is in (no entry for theirs yet), e.g. "TOP". */
    builtFor?: string;
  };
};

/** An AI buy option resolved against Riot's item catalog by the HELP ME route. */
export type LiveResolvedBuy = {
  item: string;
  itemId: number;
  cost: number;
  /** The completed goal this purchase builds toward (same as item for a completed purchase). */
  targetItem: string;
  targetItemId: number;
  targetCost: number;
  timing: LiveHelpAdvice["buyOptions"][number]["timing"];
  reason: string;
  affordable: boolean;
  goldNeeded: number;
  /** True when the goal is not on snapshot.buildPath (the AI is changing the path). */
  deviation: boolean;
};

// ---------------------------------------------------------------------------
// Long-term memory (written by lib/game-recorder.ts + lib/player-profile.ts)
// ---------------------------------------------------------------------------

export type GameRecordPurchase = { time: number; itemId: number; item: string; kind: "bought" | "sold" };

export type GameRecordDeath = {
  time: number;
  killer: string;
  killerChampion: string;
  assisters: string[];
  goldUnspent: number;
  level: number;
  items: string[];
};

export type GameRecord = {
  id: string;
  gameId: string;
  startedAt: string;
  endedAt: string | null;
  champion: string;
  position: string;
  mode: string;
  modeLabel: string;
  result: "win" | "loss" | "unknown";
  durationSeconds: number;
  laneOpponent: string | null;
  allies: string[];
  enemies: string[];
  final: { kills: number; deaths: number; assists: number; cs: number; level: number; items: string[] };
  purchases: GameRecordPurchase[];
  deaths: GameRecordDeath[];
  csAt10: number | null;
  firstCompletedItem: { item: string; time: number } | null;
  completedItemOrder: string[];
  focusResult: { title: string; met: boolean | null; detail: string } | null;
  /** Ended before ~3:00 (remake / early dodge): no result, never used for stats or build learning. */
  remake?: boolean;
  /** The live page was opened late or the feed dropped for a long stretch: purchases/CS@10 may be incomplete. */
  partial?: boolean;
  /** First purchase made after the first death/recall (the "first back"), for first-back learning. */
  firstBack?: string[];
};

export type ChampionProfile = {
  champion: string;
  games: number;
  wins: number;
  losses: number;
  avg: { kills: number; deaths: number; assists: number; cs: number };
  avgCsAt10: number | null;
  avgFirstItemTime: number | null;
  /** Most common first-three completed items, most frequent first. */
  buildPaths: Array<{ items: string[]; games: number; wins: number }>;
  boots: Array<{ item: string; games: number }>;
};

export type MatchupRecord = { champion: string; enemy: string; games: number; wins: number; deathsToEnemy: number };

export type RecurringIssue = {
  id: string;
  label: string;
  detail: string;
  severity: "high" | "medium" | "low";
  evidence: string;
};

export type PlayerFocus = {
  title: string;
  why: string;
  drill: string;
  source: "replay-review" | "manual";
  setAt: string;
  metric: { kind: "csAt10" | "deathsBefore10" | "unspentGoldDeaths" | "none"; target: number } | null;
};

export type PlayerPreferences = {
  notes: string[];
  preferredItems: Record<string, string[]>;
  avoidItems: Record<string, string[]>;
  /** Player-pinned completed-item order per champion (boots allowed). Highest-priority build source. */
  builds: Record<string, string[]>;
};

export type PlayerProfile = {
  version: 1;
  updatedAt: string;
  gamesRecorded: number;
  champions: ChampionProfile[];
  matchups: MatchupRecord[];
  killers: Array<{ champion: string; deathsTo: number; games: number }>;
  issues: RecurringIssue[];
  preferences: PlayerPreferences;
  focus: PlayerFocus | null;
  recentGames: Array<Pick<GameRecord, "id" | "startedAt" | "champion" | "laneOpponent" | "result" | "final" | "durationSeconds" | "focusResult">>;
};

/** A League-client item set (lol-item-sets) captured while it existed, e.g. a Mobalytics import pushed in champ select. */
export type ImportedBuild = {
  champion: string;
  title: string;
  capturedAt: string;
  /** Ordered completed items (boots included) parsed from the set's core/build blocks. */
  items: string[];
  starting: string[];
  situational: string[];
};

/** Compact slice of PlayerProfile for one live game. Keep it small: it goes into AI prompts. */
export type PlayerBrief = {
  champion: string;
  gamesOnChampion: number;
  winRateOnChampion: number | null;
  /** Ordered completed-item names the player usually builds on this champion, or null if no pattern yet. */
  usualBuild: string[] | null;
  /** How many recorded games back usualBuild (1 = "from your last game"). 0 when usualBuild is null. */
  usualBuildGames: number;
  /**
   * Fewer than NEW_CHAMPION_GAMES (lib/meta-builds.ts) complete games on this champion: usualBuild is null and the
   * history never shapes the build (pinned > imported > top build > defaults). Absent on older briefs = not new.
   */
  newOnChampion?: boolean;
  /** Complete (non-remake, non-partial) games on this champion, recorded + match history. */
  completeGamesOnChampion?: number;
  /** The player's pinned build for this champion (PlayerPreferences.builds), or null. Overrides everything. */
  pinnedBuild: string[] | null;
  /** Latest League-client item set captured for this champion (see ImportedBuild), or null. Overrides usualBuild. */
  importedBuild: ImportedBuild | null;
  preferredItems: string[];
  avoidItems: string[];
  matchupNote: string | null;
  killerNotes: string[];
  issues: RecurringIssue[];
  focus: PlayerFocus | null;
  notes: string[];
  /** ≤ 10 short pre-written lines summarising all of the above, for prompts. */
  lines: string[];
};

export type LiveGameResponse =
  | LiveGameSnapshot
  | { status: "offline"; reason: string; checkedAt: string };

export type LiveHelpAdvice = {
  urgentSummary: string;
  userResponse: {
    question: string;
    answer: string;
  };
  buildPath: {
    currentPath: string;
    recommendedPath: string[];
    deviation: string;
    reason: string;
  };
  biggestThreat: {
    champion: string;
    reason: string;
    response: string;
  };
  enemyPlan: Array<{
    champion: string;
    priority: "avoid" | "focus" | "watch";
    reason: string;
    response: string;
  }>;
  buyOptions: Array<{
    item: string;
    targetItem: string;
    timing: "next-recall" | "first-item-goal" | "later-conditional" | "endgame-swap";
    reason: string;
  }>;
  nextFiveMinutes: string[];
  fightPlan: string[];
  warnings: string[];
  /** One line tying advice to the player's history (PlayerBrief); "" when no history. */
  historyCallout: string;
};

/**
 * fast    – low reasoning, short output; used by the HELP ME button and auto death coach.
 * deep    – medium reasoning; the full read.
 * death   – fast read framed around "you just died, here is what to buy and change".
 * pregame – loading screen / first 90s: lane + team plan from history and comps.
 */
export type LiveHelpMode = "fast" | "deep" | "death" | "pregame";

/** quick = low reasoning everywhere; strong (default) = medium for in-game reads, high for deep; max = high everywhere. */
export type LiveHelpPower = "quick" | "strong" | "max";

export type LiveHelpRequest = {
  snapshot: LiveGameSnapshot;
  userFocus?: string;
  mode?: LiveHelpMode;
  power?: LiveHelpPower;
};

export type LiveHelpEnvelope = {
  cacheKey: string;
  generatedAt: string;
  model: string;
  mode: LiveHelpMode;
  /** Reasoning effort actually used (low/medium/high). Absent on older cache entries. */
  reasoning?: string;
  elapsedMs: number;
  source: "cache" | "generated";
  review: LiveHelpAdvice;
  /** review.buyOptions validated against the item catalog; unknown item names are dropped. */
  buys: LiveResolvedBuy[];
  /** Game time of the snapshot this answer was generated for. */
  gameTime: number;
};

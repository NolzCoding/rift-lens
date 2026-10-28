// Dev-only snapshots for /live?mock=pregame|mid|dead|over. Not used by the live poller.
import type { EnemyProfileSummary, EstimatedStats } from "@/lib/enemy-stats";
import type { LiveBuildPath, LiveGameSnapshot, LiveHelpEnvelope, LiveItem, LivePlayer, LiveRecommendation, PlayerBrief } from "@/lib/types";

export const LIVE_FIXTURE_NAMES = ["pregame", "mid", "dead", "over"] as const;
export type LiveFixtureName = (typeof LIVE_FIXTURE_NAMES)[number];

export function isLiveFixtureName(value: unknown): value is LiveFixtureName {
  return typeof value === "string" && (LIVE_FIXTURE_NAMES as readonly string[]).includes(value);
}

const ITEMS: Record<number, [string, number]> = {
  1056: ["Doran's Ring", 400], 1055: ["Doran's Blade", 450], 1054: ["Doran's Shield", 450], 2003: ["Health Potion", 50],
  3340: ["Stealth Ward", 0], 3364: ["Oracle Lens", 0], 2055: ["Control Ward", 75], 1001: ["Boots", 300],
  3020: ["Sorcerer's Shoes", 1100], 3047: ["Plated Steelcaps", 1200], 3006: ["Berserker's Greaves", 1100], 3158: ["Ionian Boots of Lucidity", 900],
  6655: ["Luden's Echo", 2750], 3802: ["Lost Chapter", 1200], 1058: ["Needlessly Large Rod", 1200], 1052: ["Amplifying Tome", 400],
  3157: ["Zhonya's Hourglass", 3250], 2420: ["Seeker's Armguard", 1600], 3089: ["Rabadon's Deathcap", 3500],
  6692: ["Eclipse", 2900], 3134: ["Serrated Dirk", 1000], 1036: ["Long Sword", 350], 3142: ["Youmuu's Ghostblade", 2800],
  6672: ["Kraken Slayer", 3000], 3046: ["Phantom Dancer", 2650], 3031: ["Infinity Edge", 3500],
  3068: ["Sunfire Aegis", 2800], 3076: ["Bramble Vest", 800], 3071: ["Black Cleaver", 3000], 3190: ["Locket of the Iron Solari", 2200],
  6670: ["Noonquiver", 1300], 2523: ["Hexoptics C44", 2800], 6676: ["The Collector", 3000], 3036: ["Lord Dominik's Regards", 3300],
  3033: ["Mortal Reminder", 3000], 3123: ["Executioner's Calling", 800], 1037: ["Pickaxe", 875], 1042: ["Dagger", 250], 1018: ["Cloak of Agility", 600],
  3026: ["Guardian Angel", 3200], 1031: ["Chain Vest", 800], 6617: ["Moonstone Renewer", 2200], 3135: ["Void Staff", 3000],
  3072: ["Bloodthirster", 3400], 6610: ["Sundered Sky", 3100],
};

const items = (...ids: number[]): LiveItem[] => ids.map((id) => ({ id, name: ITEMS[id]?.[0] || `Item ${id}`, count: id === 2003 ? 2 : 1, price: ITEMS[id]?.[1] || 0, description: "" }));

type PlayerSeed = [champion: string, name: string, position: string, level: number, k: number, d: number, a: number, cs: number, itemIds: number[], roles: string[], spells: string[], keystone: string];

function player(team: "ORDER" | "CHAOS", seed: PlayerSeed, threat: LivePlayer["threat"] = "normal", damageProfile: LivePlayer["damageProfile"] = "physical"): LivePlayer {
  const [champion, name, position, level, kills, deaths, assists, cs, itemIds, roles, summonerSpells, keystone] = seed;
  return {
    champion, name: `${name}#EUW`, riotId: `${name}#EUW`, team, position, level, isDead: false, respawnTimer: 0,
    kills, deaths, assists, cs, wardScore: Math.round(cs / 12), items: items(...itemIds),
    threatScore: { critical: 90, high: 70, watch: 45, normal: 25 }[threat], threat, damageProfile, roles, summonerSpells, keystone,
  };
}

const BRIEF: PlayerBrief = {
  champion: "Viktor", gamesOnChampion: 14, winRateOnChampion: 0.57,
  usualBuild: ["Luden's Echo", "Sorcerer's Shoes", "Rabadon's Deathcap", "Zhonya's Hourglass"],
  preferredItems: ["Zhonya's Hourglass"], avoidItems: ["Rod of Ages"],
  matchupNote: "Viktor vs Zed: 1W–3L, died to Zed 9× across those games.",
  killerNotes: ["Zed killed you 7× in your last 5 games, mostly 6:00–9:00 after his level 6.", "Lee Sin gank deaths happen when you shove without a river ward."],
  issues: [
    { id: "early-deaths", label: "Early deaths", detail: "1.8 deaths before 10:00 on average", severity: "high", evidence: "8 of last 10 games" },
    { id: "unspent-gold", label: "Dying with gold", detail: "4 deaths last week holding 1300g+", severity: "medium", evidence: "Game records" },
    { id: "cs", label: "Low CS at 10", detail: "Average 61 CS at 10:00", severity: "low", evidence: "Last 10 Viktor games" },
  ],
  focus: { title: "Hit 70 CS by 10:00", why: "You average 61 CS at 10 on Viktor.", drill: "Last-hit with autos only until level 3; shove only with a ward up.", source: "replay-review", setAt: "2026-10-08T19:00:00.000Z", metric: { kind: "csAt10", target: 70 } },
  notes: ["Likes Luden's first into squishy mids."], lines: [],
  usualBuildGames: 6, pinnedBuild: null, importedBuild: null,
};

const step = (id: number, status: LiveBuildPath["steps"][number]["status"]) => ({ itemId: id, item: ITEMS[id][0], cost: ITEMS[id][1], status });
const VIKTOR_PATH: LiveBuildPath = {
  source: "history", label: "From your games (6 games)",
  steps: [step(6655, "owned"), step(3020, "owned"), step(3089, "next"), step(3157, "later"), step(3135, "later")],
};
const CAITLYN_PATH: LiveBuildPath = {
  source: "imported", label: "Mobalytics: Caitlyn ADC — Crit Lethality",
  steps: [step(6670, "owned"), step(3006, "owned"), step(2523, "next"), step(6676, "later"), step(3031, "later"), step(3036, "later")],
};
const CAITLYN_BRIEF: PlayerBrief = {
  champion: "Caitlyn", gamesOnChampion: 9, winRateOnChampion: 0.56,
  usualBuild: ["Hexoptics C44", "The Collector", "Infinity Edge"], usualBuildGames: 4, pinnedBuild: null,
  importedBuild: {
    champion: "Caitlyn", title: "Mobalytics: Caitlyn ADC — Crit Lethality", capturedAt: "2026-10-11T18:02:00.000Z",
    items: ["Noonquiver", "Berserker's Greaves", "Hexoptics C44", "The Collector", "Infinity Edge", "Lord Dominik's Regards"],
    starting: ["Doran's Blade", "Health Potion"], situational: ["Mortal Reminder", "Guardian Angel"],
  },
  preferredItems: [], avoidItems: ["Statikk Shiv"],
  matchupNote: "Caitlyn vs Jinx: 2W–1L, you won lane every time you held 1 trap at the bush.",
  killerNotes: ["Zed killed you 4× in your last 5 games, mostly while you walked up alone mid-game."],
  issues: [{ id: "early-deaths", label: "Mid-game picks", detail: "1.4 deaths 14:00–20:00 on average", severity: "medium", evidence: "Last 9 Caitlyn games" }],
  focus: null, notes: [], lines: [],
};

const RABADON: LiveRecommendation = {
  itemId: 3089, item: "Rabadon's Deathcap", cost: 3500, description: "", priority: "primary", action: "buy", timing: "mid-game",
  reason: "You are the main magic damage source; Deathcap multiplies Q, E and storm damage.", trigger: "Buy after your first two items while ahead.", usageTip: "",
  nextStep: { itemId: 1058, item: "Needlessly Large Rod", cost: 1200, affordable: true, goldNeeded: 0 }, swapPlan: null,
};
const ZHONYA: LiveRecommendation = {
  itemId: 3157, item: "Zhonya's Hourglass", cost: 3250, description: "", priority: "defensive", action: "buy", timing: "mid-game",
  reason: "Zed and Lee Sin are physical divers; stasis cancels Zed's ult mark.", trigger: "Rush when Zed is ahead of you.", usageTip: "",
  nextStep: { itemId: 2420, item: "Seeker's Armguard", cost: 1600, affordable: false, goldNeeded: 120 }, swapPlan: null,
};

/** Hand-written estimates for the mock enemies (the live engine computes these from Data Dragon). [armor, MR, HP, lethality, AP] */
const EST: Record<string, [number, number, number, number, number]> = {
  Zed: [72, 41, 1420, 18, 0], "Lee Sin": [74, 43, 1480, 0, 0], Jinx: [58, 37, 1250, 0, 0], Ornn: [140, 52, 1880, 0, 0], Thresh: [88, 48, 1620, 0, 0],
  Soraka: [64, 40, 1330, 0, 60], Aatrox: [92, 49, 2050, 0, 0],
};
function withEst(entry: LivePlayer): LivePlayer {
  const est = EST[entry.champion];
  if (!est) return entry;
  const [armor, magicResist, hp, lethality, abilityPower] = est;
  const estStats: EstimatedStats = {
    hp, bonusHp: 0, armor, bonusArmor: 0, magicResist, bonusMagicResist: 0, attackDamage: 0, bonusAttackDamage: 0, abilityPower, attackSpeed: 0.7, critChance: 0,
    lethality, armorPenPercent: 0, magicPenFlat: 0, magicPenPercent: 0, lifeSteal: 0, omnivamp: 0, abilityHaste: 0, itemGold: 0, championKnown: true, estimated: true,
  };
  return { ...entry, estStats };
}
const quiet = { level: "none" as const, score: 0, reasons: [], counter: "" };
const MOCK_PROFILE: EnemyProfileSummary = {
  estimated: true, version: "16.20.1",
  armorStack: { ...quiet, perEnemy: [], high: 0, veryHigh: 0, frontlineAverage: 114 },
  mrStack: { ...quiet, perEnemy: [], high: 0, veryHigh: 0, frontlineAverage: 50 },
  hpStack: { ...quiet, high: 0 },
  healing: { ...quiet, sources: [] },
  burstThreat: { level: "some", score: 1, reasons: ["Zed, 18 lethality"], counter: "defensive item earlier", threats: ["Zed"] },
  hardCc: { ...quiet, champions: ["Thresh"] },
  poke: { ...quiet, champions: [] },
  physicalShare: { level: "some", score: 0.62, share: 0.62, lean: "mixed", reasons: ["~62% of enemy damage looks physical"], counter: "" },
};

function base(time: number): LiveGameSnapshot {
  const enemies = [
    player("CHAOS", ["Zed", "ShadowStep", "MIDDLE", 7, 3, 1, 1, 70, [1055, 6692, 3047, 2003], ["Assassin"], ["Flash", "Ignite"], "Electrocute"], "critical"),
    player("CHAOS", ["Lee Sin", "BlindMonk", "JUNGLE", 7, 2, 1, 4, 72, [1036, 3134, 3047], ["Fighter", "Assassin"], ["Flash", "Smite"], "Conqueror"], "high"),
    player("CHAOS", ["Jinx", "Pow Pow", "BOTTOM", 6, 1, 2, 1, 104, [1055, 3006, 1036], ["Marksman"], ["Flash", "Heal"], "Lethal Tempo"], "watch"),
    player("CHAOS", ["Ornn", "Forgemaster", "TOP", 7, 0, 1, 2, 90, [1054, 3076, 3047], ["Tank", "Fighter"], ["Flash", "Teleport"], "Grasp of the Undying"], "normal", "mixed"),
    player("CHAOS", ["Thresh", "Lantern", "UTILITY", 5, 0, 2, 3, 12, [3190, 3047], ["Support", "Fighter"], ["Flash", "Ignite"], "Aftershock"], "normal", "magic"),
  ].map(withEst);
  const allies = [
    player("ORDER", ["Lux", "LightBinder", "UTILITY", 6, 1, 1, 4, 14, [3802, 3020], ["Mage", "Support"], ["Flash", "Ignite"], "Arcane Comet"], "normal", "magic"),
    player("ORDER", ["Garen", "Demacia", "TOP", 7, 1, 1, 0, 88, [1055, 3047, 3071], ["Fighter", "Tank"], ["Flash", "Teleport"], "Conqueror"]),
    player("ORDER", ["Vi", "PiltoverPunch", "JUNGLE", 6, 1, 2, 2, 70, [1036, 3047], ["Fighter", "Assassin"], ["Flash", "Smite"], "Conqueror"]),
    player("ORDER", ["Kai'Sa", "Voidborn", "BOTTOM", 6, 2, 1, 2, 101, [1055, 3006, 3134], ["Marksman"], ["Flash", "Heal"], "Hail of Blades"], "normal", "mixed"),
  ];
  const active = player("ORDER", ["Viktor", "You", "MIDDLE", 7, 2, 2, 3, 62, [1056, 6655, 3020, 3340], ["Mage"], ["Flash", "Teleport"], "First Strike"], "normal", "magic");
  return {
    status: "live", capturedAt: new Date().toISOString(), gameId: "mock-viktor-vs-zed",
    game: { mode: "CLASSIC", modeLabel: "Ranked Solo/Duo", map: "Summoner's Rift", time, phase: time < 120 ? "opening" : time < 840 ? "early" : "mid", queuePrecision: "exact" },
    matchup: { basis: "riot-position", note: "Matched using Riot's reported position." },
    activePlayer: {
      ...active, currentGold: 1320, health: 1210, maxHealth: 1640, resource: 520, maxResource: 890,
      stats: { abilityPower: 186, attackDamage: 78, armor: 64, magicResist: 42, abilityHaste: 25, attackSpeed: 0.71, magicPenetrationFlat: 0, magicPenetrationPercent: 0, armorPenetrationFlat: 0, armorPenetrationPercent: 0, lifeSteal: 0, omnivamp: 0, moveSpeed: 385, attackRange: 525 },
      abilityLevels: { Q: 4, W: 1, E: 2, R: 1 },
      runes: { keystone: "First Strike", primaryTree: "Inspiration", secondaryTree: "Sorcery" },
    },
    laneOpponent: enemies[0], allies, enemies,
    recommendations: [RABADON, ZHONYA, { ...RABADON, itemId: 3135, item: "Void Staff", cost: 3000, priority: "situational", reason: "Ornn is stacking magic resist.", trigger: "Buy once Ornn has 2 MR items.", nextStep: null }],
    mobilityRecommendation: null,
    deathSources: [{ champion: "Zed", playerName: "ShadowStep#EUW", deathsTo: 1 }, { champion: "Lee Sin", playerName: "BlindMonk#EUW", deathsTo: 1 }],
    recentEvents: [
      { id: 3, type: "ChampionKill", time: time - 120, text: "You killed Jinx", tone: "good" },
      { id: 2, type: "ChampionKill", time: time - 260, text: "Zed killed you", tone: "bad" },
      { id: 1, type: "DragonKill", time: time - 330, text: "Your team took Infernal Drake", tone: "good" },
    ],
    dataDragonVersion: "16.20.1",
    championContext: { source: "fallback", patch: "16.19", passive: { name: "Glorious Evolution", description: "" }, abilities: [], allyTips: [] },
    objectives: [
      { id: "dragon", label: "Dragon", status: "respawning", nextSpawnAt: time + 50, note: "Hextech rift" },
      { id: "herald", label: "Herald", status: "not-spawned", nextSpawnAt: 900, note: "" },
      { id: "atakhan", label: "Atakhan", status: "not-spawned", nextSpawnAt: 1200, note: "" },
      { id: "baron", label: "Baron", status: "not-spawned", nextSpawnAt: 1500, note: "" },
    ],
    dragonState: { alliedDragons: ["Infernal"], enemyDragons: ["Mountain", "Ocean"], soulPoint: null, soulType: "Hextech" },
    deathMoment: null, playerBrief: BRIEF, gameResult: null, buildPath: VIKTOR_PATH, enemyProfile: MOCK_PROFILE,
    patchStatus: { version: "16.20.1", fallback: false, unknownBuildItems: [], note: null },
    caveats: ["Mock fixture: not a live match."],
  };
}

function pregame(): LiveGameSnapshot {
  const snap = base(45);
  const reset = (p: LivePlayer): LivePlayer => ({ ...p, level: 1, kills: 0, deaths: 0, assists: 0, cs: 0, items: p.items.filter((item) => ITEMS[item.id][1] <= 450) });
  return {
    ...snap, game: { ...snap.game, phase: "opening" },
    activePlayer: { ...snap.activePlayer, ...reset(snap.activePlayer), items: items(1056, 2003, 3340), currentGold: 0, health: 640, maxHealth: 640, resource: 405, maxResource: 405, abilityLevels: { Q: 0, W: 0, E: 0, R: 0 },
      stats: { ...snap.activePlayer.stats, abilityPower: 18, attackDamage: 53, armor: 23, magicResist: 30, abilityHaste: 0 } },
    laneOpponent: reset(snap.enemies[0]), allies: snap.allies.map(reset), enemies: snap.enemies.map(reset),
    recommendations: [
      { ...RABADON, itemId: 6655, item: "Luden's Echo", cost: 2750, timing: "first-item", reason: "Your usual first item on Viktor (6 games).", trigger: "First back at 1200g+.",
        nextStep: { itemId: 3802, item: "Lost Chapter", cost: 1200, affordable: false, goldNeeded: 1200 } },
      ...snap.recommendations.slice(0, 2).map((r) => ({ ...r, nextStep: r.nextStep && { ...r.nextStep, affordable: false, goldNeeded: r.nextStep.cost } })),
    ],
    deathSources: [], recentEvents: [{ id: 0, type: "GameStart", time: 0, text: "Game started", tone: "neutral" }],
    objectives: [
      { id: "dragon", label: "Dragon", status: "not-spawned", nextSpawnAt: 300, note: "" },
      { id: "grubs", label: "Voidgrubs", status: "not-spawned", nextSpawnAt: 480, note: "" },
      { id: "herald", label: "Herald", status: "not-spawned", nextSpawnAt: 900, note: "" },
    ],
    dragonState: { alliedDragons: [], enemyDragons: [], soulPoint: null, soulType: null },
    buildPath: { ...VIKTOR_PATH, steps: VIKTOR_PATH.steps.map((entry, index) => ({ ...entry, status: index === 0 ? "next" : "later" })) },
  };
}

/** Caitlyn bot on an imported Mobalytics build: Noonquiver + boots owned, Hexoptics C44 next. */
function caitlyn(time: number): LiveGameSnapshot {
  const snap = base(time);
  const enemies = snap.enemies.map((entry) => entry.champion === "Thresh"
    ? withEst(player("CHAOS", ["Soraka", "Starchild", "UTILITY", 7, 0, 1, 6, 18, [6617, 3158], ["Support", "Mage"], ["Flash", "Exhaust"], "Summon Aery"], "watch", "magic"))
    : entry.champion === "Ornn" ? withEst(player("CHAOS", ["Aatrox", "Darkin", "TOP", 9, 4, 1, 1, 98, [1055, 6610, 3047], ["Fighter", "Tank"], ["Flash", "Teleport"], "Conqueror"], "high")) : entry);
  const allies = snap.allies.map((entry) => entry.champion === "Kai'Sa"
    ? player("ORDER", ["Viktor", "Glorious", "MIDDLE", 8, 2, 1, 2, 80, [1056, 6655, 3020], ["Mage"], ["Flash", "Teleport"], "First Strike"], "normal", "magic") : entry);
  const active = player("ORDER", ["Caitlyn", "You", "BOTTOM", 8, 3, 1, 2, 84, [1055, 6670, 3006, 1036, 3340], ["Marksman"], ["Flash", "Heal"], "Fleet Footwork"]);
  const rec = (itemId: number, priority: LiveRecommendation["priority"], reason: string, trigger: string, next: number | null, gold = 1320): LiveRecommendation => ({
    itemId, item: ITEMS[itemId][0], cost: ITEMS[itemId][1], description: "", priority, action: "buy", timing: "mid-game", reason, trigger, usageTip: "",
    nextStep: next === null ? null : { itemId: next, item: ITEMS[next][0], cost: ITEMS[next][1], affordable: ITEMS[next][1] <= gold, goldNeeded: Math.max(0, ITEMS[next][1] - gold) },
    swapPlan: null,
  });
  return {
    ...snap, gameId: "mock-caitlyn-vs-jinx",
    game: { ...snap.game, mode: "SWIFTPLAY", modeLabel: "Swiftplay" },
    objectives: [
      { id: "dragon", label: "Dragon", status: "respawning", nextSpawnAt: time + 50, note: "Swiftplay: next drake 5:00 after the last one." },
      { id: "baron", label: "Baron Nashor", status: time >= 720 ? "up" : "not-spawned", nextSpawnAt: time >= 720 ? null : 720, note: "Swiftplay: Baron spawns at 12:00." },
      { id: "elder", label: "Elder Dragon", status: time >= 900 ? "up" : "not-spawned", nextSpawnAt: time >= 900 ? null : 900, note: "Swiftplay: Elder spawns at 15:00." },
    ],
    activePlayer: {
      ...snap.activePlayer, ...active, currentGold: 1320, health: 980, maxHealth: 1460, resource: 410, maxResource: 690,
      stats: { ...snap.activePlayer.stats, abilityPower: 0, attackDamage: 148, armor: 58, magicResist: 38, abilityHaste: 0, attackSpeed: 0.98, attackRange: 650, moveSpeed: 375 },
      abilityLevels: { Q: 4, W: 2, E: 2, R: 1 }, runes: { keystone: "Fleet Footwork", primaryTree: "Precision", secondaryTree: "Inspiration" },
    },
    laneOpponent: enemies.find((entry) => entry.champion === "Jinx") ?? null, allies, enemies,
    recommendations: [
      rec(2523, "primary", "Next step of your Mobalytics build: Hexoptics C44 finishes the Noonquiver you own.", "Finish it on this recall.", 1037),
      rec(6676, "situational", "Lethality + execute: your second item on the imported path.", "After Hexoptics C44.", 3134),
      rec(3026, "defensive", "Zed and Aatrox can both reach you in fights.", "Third item if Zed keeps diving you.", 1031),
    ],
    mobilityRecommendation: null,
    deathSources: [{ champion: "Zed", playerName: "ShadowStep#EUW", deathsTo: 1 }],
    recentEvents: [
      { id: 3, type: "ChampionKill", time: time - 90, text: "You killed Jinx", tone: "good" },
      { id: 2, type: "ChampionKill", time: time - 210, text: "Zed killed you", tone: "bad" },
      { id: 1, type: "DragonKill", time: time - 330, text: "Your team took Infernal Drake", tone: "good" },
    ],
    championContext: { source: "fallback", patch: "16.20", passive: { name: "Headshot", description: "" }, abilities: [], allyTips: [] },
    playerBrief: CAITLYN_BRIEF, buildPath: CAITLYN_PATH,
  };
}

/** Caitlyn game that just ended (Swiftplay win at 16:10). */
function over(): LiveGameSnapshot {
  const snap = caitlyn(970);
  const active = snap.activePlayer;
  return {
    ...snap, game: { ...snap.game, phase: "mid" }, gameResult: "win",
    activePlayer: { ...active, level: 14, kills: 9, deaths: 3, assists: 7, cs: 168, wardScore: 9, currentGold: 640,
      items: items(6670, 3006, 2523, 6676, 1055, 3340) },
    laneOpponent: snap.laneOpponent && { ...snap.laneOpponent, level: 12, cs: 141, kills: 3, deaths: 6 },
    enemies: snap.enemies.map((e) => e.champion === "Jinx" ? { ...e, level: 12, cs: 141, kills: 3, deaths: 6 } : e),
    deathSources: [{ champion: "Zed", playerName: "ShadowStep#EUW", deathsTo: 2 }, { champion: "Aatrox", playerName: "Darkin#EUW", deathsTo: 1 }],
    buildPath: { ...snap.buildPath, steps: snap.buildPath.steps.map((entry, index) => ({ ...entry, status: index < 4 ? "owned" : index === 4 ? "next" : "later" })) },
  };
}

/** Caitlyn (Swiftplay) dead at 9:00 holding Noonquiver + basic Boots and 1,480g — the engine's real output for this state. */
function dead(): LiveGameSnapshot {
  const snap = caitlyn(540);
  const items = [1055, 6670, 1001, 3340].map((id) => ({ id, name: ITEMS[id][0], count: 1, price: ITEMS[id][1], description: "" }));
  const steps = [step(2523, "next"), step(3006, "later"), step(6676, "later")];
  return {
    ...snap, game: { ...snap.game, phase: "early" },
    activePlayer: { ...snap.activePlayer, items, isDead: true, respawnTimer: 18, deaths: 3, health: 0, currentGold: 1480 },
    buildPath: { source: "history", label: "Your usual path (2 games, 100% WR)", steps },
    recommendations: [
      { ...snap.recommendations[0], itemId: 2523, item: "Hexoptics C44", cost: 2800, reason: "Next in your usual path.", nextStep: { itemId: 1037, item: "Pickaxe", cost: 875, affordable: true, goldNeeded: 0 }, swapPlan: null },
      ...snap.recommendations.slice(1),
    ],
    deathSources: [{ champion: "Zed", playerName: "ShadowStep#EUW", deathsTo: 2 }, { champion: "Jinx", playerName: "Jinxed#EUW", deathsTo: 1 }],
    deathMoment: {
      diedAt: 536, respawnIn: 18, killer: "ShadowStep#EUW", killerChampion: "Zed", assisters: ["Lee Sin"], goldNow: 1480,
      buyNow: [
        { itemId: 1037, item: "Pickaxe", cost: 875, forItem: "Hexoptics C44" },
        { itemId: 1036, item: "Long Sword", cost: 350, forItem: "Hexoptics C44" },
        { itemId: 1042, item: "Dagger", cost: 250, forItem: "Berserker's Greaves" },
      ],
      goals: [
        { itemId: 2523, item: "Hexoptics C44", cost: 2800, costNow: 1500, spendNow: 1225, remainingAfter: 275, completes: false, nextPiece: null },
        { itemId: 3006, item: "Berserker's Greaves", cost: 1100, costNow: 800, spendNow: 250, remainingAfter: 550, completes: false, nextPiece: null },
      ],
      reasons: ["Outnumbered 2v1: Zed + Lee Sin", "Died holding 1480g unspent.","Death #2 to Zed this game"],
      patternNote: "Zed killed you 4× in your last 5 games, mostly after his level 6.",
    },
  };
}

export function getLiveFixture(name: LiveFixtureName): LiveGameSnapshot {
  return name === "pregame" ? pregame() : name === "dead" ? dead() : name === "over" ? over() : caitlyn(520);
}

/** Previous poll for a fixture, so mock mode can show diff-based alerts (level-ups, completed items). */
export function getLiveFixturePrev(name: LiveFixtureName): LiveGameSnapshot | null {
  if (name !== "mid") return null;
  const snap = caitlyn(517.5);
  return { ...snap, enemies: snap.enemies.map((e) => e.champion === "Zed" ? { ...e, level: 5, items: e.items.filter((item) => item.id !== 6692) } : e) };
}

type MockBuy = [itemId: number, targetId: number, timing: LiveHelpEnvelope["buys"][number]["timing"], reason: string, deviation?: boolean];

/** Canned AI answer for /live?mock=…&ai=1 (ai=stale → generated 4 game-minutes ago). Never calls a model. */
export function getLiveFixtureHelp(name: LiveFixtureName, stale = false): LiveHelpEnvelope {
  const snap = getLiveFixture(name);
  const gold = Math.floor(snap.activePlayer.currentGold);
  const mode = name === "dead" ? "death" : name === "pregame" ? "pregame" : "fast";
  const plan: MockBuy[] = name === "mid" || name === "over" ? [
    [1037, 2523, "next-recall", "Pickaxe finishes Hexoptics C44 next back — your imported path, 445g left over."],
    [3123, 3033, "first-item-goal", "Changes your build: Mortal Reminder replaces The Collector. Soraka + Aatrox heal through your poke; you give up Collector's execute.", true],
    [6676, 6676, "later-conditional", "Back to The Collector if Soraka stops healing the front line."],
  ] : name === "dead" ? [
    [1058, 3089, "next-recall", "Rod now — Deathcap is still your next item."],
    [2055, 2055, "next-recall", "Ward the river bush Zed walked through."],
    [2420, 3157, "later-conditional", "Pull Zhonya's (already on your path) ahead of Deathcap while Zed is 7/2 — stasis answers his ult."],
  ] : [
    [1052, 6655, "next-recall", "First back: Tome toward Luden's at 1250g+."],
    [6655, 6655, "first-item-goal", "Luden's first, as in your last 6 games."],
  ];
  const name0 = (id: number) => ITEMS[id]?.[0] ?? `Item ${id}`;
  const cost0 = (id: number) => ITEMS[id]?.[1] ?? 0;
  const buys = plan.map(([itemId, targetId, timing, reason, deviation = false]) => ({
    item: name0(itemId), itemId, cost: cost0(itemId), targetItem: name0(targetId), targetItemId: targetId, targetCost: cost0(targetId),
    timing, reason, affordable: cost0(itemId) <= gold, goldNeeded: Math.max(0, cost0(itemId) - gold), deviation,
  }));
  return {
    cacheKey: `mock-${name}`, generatedAt: new Date().toISOString(), model: "mock", mode, elapsedMs: 0, source: "cache",
    gameTime: Math.max(0, snap.game.time - (stale ? 240 : 30)),
    buys,
    review: {
      urgentSummary: name === "mid" || name === "over" ? "Finish Hexoptics, then go anti-heal — Soraka is out-healing your lane poke." : name === "dead" ? "Zed + Lee 2v1 at the river: you walked past vision with 1480g unspent." : "Trap the bush and poke Jinx early; Zed roams bot after 6.",
      userResponse: { question: "", answer: "" },
      buildPath: {
        currentPath: snap.buildPath.steps.map((entry) => entry.item).join(" → "),
        recommendedPath: buys.map((buy) => buy.targetItem),
        deviation: buys.find((buy) => buy.deviation)?.targetItem ? `Swap in ${buys.find((buy) => buy.deviation)?.targetItem}` : "Stay on path",
        reason: buys.find((buy) => buy.deviation)?.reason ?? "Your path already fits this game.",
      },
      biggestThreat: { champion: "Zed", reason: "Fed assassin roaming for picks.", response: "Stay behind your front line after 6." },
      enemyPlan: [
        { champion: "Zed", priority: "avoid", reason: "Fed and roaming.", response: "Never walk a side lane alone." },
        { champion: name === "mid" || name === "over" ? "Soraka" : "Jinx", priority: "focus", reason: "Squishy and key to their fights.", response: "Poke her first." },
      ],
      buyOptions: buys.map((buy) => ({ item: buy.item, targetItem: buy.targetItem, timing: buy.timing, reason: buy.reason })),
      nextFiveMinutes: ["Shove and back on the next cannon wave.", "Ward river before dragon spawns."],
      fightPlan: ["Trap your own feet when Zed ults.", "Hit the closest target, not the backline."],
      warnings: ["Mock AI answer — no model was called."],
      historyCallout: "Zed killed you 4× in your last 5 games.",
    },
  };
}

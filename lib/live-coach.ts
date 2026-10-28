// Deterministic, no-AI "how am I doing" coach for the live screen.
// Pure functions only: same inputs → same verdicts. Uses nothing but snapshot data
// (plus CoachTrack, a tiny cross-poll memory the dashboard threads through trackCoach).
import type { LiveGameSnapshot, LiveObjectiveTimer, LivePlayer } from "@/lib/types";

export type VerdictTone = "good" | "fix";

export type Verdict = {
  /** Stable per rule, so React keys and dedupe stay steady across polls. */
  id: string;
  tone: VerdictTone;
  /** ≤ 8 words, human and direct. */
  headline: string;
  /** Optional ≤ 12-word sub-line. */
  detail: string | null;
  /** Higher = more important. Only used for ranking. */
  weight: number;
  /** One verdict per topic survives (good and fix compete), so the card never contradicts itself. */
  topic: "deaths" | "gold" | "cs" | "level" | "kda" | "kp" | "vision" | "item" | "focus";
};

export type CoachVerdicts = { good: Verdict[]; fix: Verdict[] };

/** Cross-poll memory that one snapshot cannot carry. Rebuild with trackCoach on every poll. */
export type CoachTrack = {
  gameId: string;
  lastTime: number;
  /** Game time since which the player has been alive AND able to afford their next buy; null otherwise. */
  richSince: number | null;
  /** Item names in the inventory at the previous poll (completion detection). */
  inventory: string[];
  /** Build-path items that appeared in the inventory while this page was watching. */
  completed: Array<{ item: string; at: number }>;
  /** Deaths seen live, with the gold held at the time. */
  deaths: Array<{ at: number; gold: number; killer: string }>;
  /** Gold at the last poll where the player was alive: the gold held at death when that poll was just before it. */
  alive?: { at: number; gold: number } | null;
};

/** A poll this close before the death counts as "at death" (polls are ~2.5s apart). */
const AT_DEATH_SECONDS = 10;

function goldAtDeath(alive: CoachTrack["alive"], moment: NonNullable<LiveGameSnapshot["deathMoment"]>) {
  return alive && alive.at <= moment.diedAt + 0.25 && moment.diedAt - alive.at <= AT_DEATH_SECONDS ? alive.gold : moment.goldNow;
}

const MAX_PER_SIDE = 2;
const RICH_SECONDS = 90;
const RICH_FALLBACK_GOLD = 1300;
const UNSPENT_DEATH_GOLD = 1000;
const FRESH_ITEM_SECONDS = 150;
/** A death while holding gold stays on the card this long (game seconds). */
const RICH_DEATH_SECONDS = 300;

const ROLE_SUPPORT = /support|utility/i;

export const formatGold = (gold: number) => Math.floor(gold).toLocaleString("en-US");
export const clock = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// CS precision. Riot's Live Client Data API updates scores.creepScore only in steps of 10, so a reading of 40 means
// 40–49 and a lane gap can be off by up to ±9. Rules: never judge a lane gap under CS_GAP_MIN, show gaps as "~N",
// and phrase projections as "about N". A reading that is not a multiple of 10 can only come from an exact feed.
// ---------------------------------------------------------------------------

/** Smallest reported lane CS gap the coach will call good or bad. */
export const CS_GAP_MIN = 20;

/** The true CS behind one reading: [low, high], plus the midpoint used for projections. */
export function csRange(reading: number) {
  const low = Math.max(0, Math.floor(reading));
  const coarse = low % 10 === 0;
  const high = coarse ? low + 9 : low;
  return { low, high, mid: (low + high) / 2, coarse };
}

/** Round for display without false precision: nearest 5 (nearest 10 above 100). */
export function aboutCs(value: number) {
  const step = value >= 100 ? 10 : 5;
  return Math.max(0, Math.round(value / step) * step);
}

/** A raw reading for stat displays: "40+" when it is a coarse step (40–49), the exact number otherwise. */
export function csText(reading: number) {
  const range = csRange(reading);
  return range.coarse && range.low > 0 ? `${range.low}+` : String(range.low);
}

/** Lane CS gap with the coarse feed in mind. call is "close" whenever |gap| < CS_GAP_MIN. */
export function csGap(mine: number, theirs: number) {
  const gap = Math.floor(mine) - Math.floor(theirs);
  const approx = Math.round(Math.abs(gap) / 10) * 10;
  const call: "ahead" | "behind" | "close" = Math.abs(gap) < CS_GAP_MIN ? "close" : gap > 0 ? "ahead" : "behind";
  return { gap, approx, call, label: call === "close" ? "close" : `${gap > 0 ? "+" : "−"}~${approx}` };
}

/**
 * Projected CS at 10:00 from one reading, as a range (low/high from the reading's ±9) and a midpoint.
 * FIRST_WAVE_SECONDS = first minions reach lane (~1:05). Null before the first wave has really started.
 */
export const FIRST_WAVE_SECONDS = 65;
export function csPaceAt10(reading: number, time: number) {
  if (time <= FIRST_WAVE_SECONDS + 30 || time >= 600) return null;
  const range = csRange(reading);
  const factor = (600 - FIRST_WAVE_SECONDS) / (time - FIRST_WAVE_SECONDS);
  return { low: range.low * factor, high: range.high * factor, mid: range.mid * factor, about: aboutCs(range.mid * factor) };
}

/** Verdict on a CS target from a reading: met only if even the low end clears it, missed only if even the high end falls short. */
export function csTargetCall(reading: number, target: number): "met" | "missed" | "unclear" {
  const range = csRange(reading);
  return range.low >= target ? "met" : range.high < target ? "missed" : "unclear";
}

export function isSwiftplay(snap: LiveGameSnapshot) {
  return /swift/i.test(snap.game.mode) || /swift/i.test(snap.game.modeLabel);
}

/** Gold needed for the next concrete purchase (recommendation's next component, else the item, else the next build step). */
export function nextBuyCost(snap: LiveGameSnapshot): number {
  const rec = snap.recommendations[0];
  const cost = rec?.nextStep?.cost || rec?.cost || snap.buildPath?.steps.find((step) => step.status === "next")?.cost || 0;
  return cost > 0 ? cost : RICH_FALLBACK_GOLD;
}

/** Fold one snapshot into the cross-poll memory. Returns a new object; never mutates. */
export function trackCoach(track: CoachTrack | null, snap: LiveGameSnapshot): CoachTrack {
  const time = snap.game.time;
  const me = snap.activePlayer;
  const inventory = me.items.map((item) => item.name);
  const alive = !me.isDead && !snap.deathMoment ? { at: time, gold: Math.floor(me.currentGold) } : null;
  if (!track || track.gameId !== snap.gameId) {
    return {
      gameId: snap.gameId, lastTime: time, inventory, completed: [],
      richSince: !me.isDead && me.currentGold >= nextBuyCost(snap) ? time : null,
      deaths: snap.deathMoment ? [{ at: snap.deathMoment.diedAt, gold: snap.deathMoment.goldNow, killer: snap.deathMoment.killerChampion }] : [],
      alive,
    };
  }
  const before = new Set(track.inventory);
  const pathItems = new Set((snap.buildPath?.steps ?? []).map((step) => step.item));
  const fresh = inventory.filter((name) => pathItems.has(name) && !before.has(name) && !track.completed.some((entry) => entry.item === name));
  const rich = !me.isDead && me.currentGold >= nextBuyCost(snap);
  const moment = snap.deathMoment;
  return {
    gameId: track.gameId,
    lastTime: time,
    inventory,
    completed: [...track.completed, ...fresh.map((item) => ({ item, at: time }))],
    richSince: rich ? track.richSince ?? time : null,
    deaths: moment && !track.deaths.some((death) => death.at === moment.diedAt)
      ? [...track.deaths, { at: moment.diedAt, gold: goldAtDeath(track.alive, moment), killer: moment.killerChampion }]
      : track.deaths,
    alive: alive ?? track.alive ?? null,
  };
}

/** The lane opponent only when the comparison is fair (real lane match, not a support vs a carry). */
function fairOpponent(snap: LiveGameSnapshot): LivePlayer | null {
  const opp = snap.laneOpponent;
  if (!opp || snap.matchup.basis === "highest-threat") return null;
  const me = snap.activePlayer;
  if (ROLE_SUPPORT.test(opp.position) !== ROLE_SUPPORT.test(me.position)) return null;
  return opp;
}

function killerTail(enemy: LivePlayer | undefined) {
  const roles = enemy?.roles ?? [];
  if (roles.includes("Assassin") || enemy?.position === "JUNGLE") return "stop face-checking";
  if (roles.includes("Fighter") || roles.includes("Tank")) return "keep your distance";
  return "stop trading into them";
}

/** "First completed item at 9:40 on average" from the slow-first-item issue's evidence, in seconds. */
function usualFirstItem(snap: LiveGameSnapshot): number | null {
  const evidence = snap.playerBrief?.issues.find((issue) => issue.id === "slow-first-item")?.evidence ?? "";
  const match = /First completed item at (\d+):(\d{2})/i.exec(evidence);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Ranked "doing well" / "fix this" calls, at most 2 each.
 * `prev` is the previous poll (ignored if it is another game); `track` is the cross-poll memory.
 * Without a track, one is rebuilt from prev → snap so the function still works on two snapshots.
 */
export function coachVerdicts(prev: LiveGameSnapshot | null, snap: LiveGameSnapshot, track: CoachTrack | null = null): CoachVerdicts {
  if (prev && prev.gameId !== snap.gameId) prev = null;
  const memory = track && track.gameId === snap.gameId ? track : trackCoach(prev ? trackCoach(null, prev) : null, snap);
  const time = snap.game.time;
  const me = snap.activePlayer;
  const brief = snap.playerBrief;
  const issue = (prefix: string) => brief?.issues.find((entry) => entry.id.startsWith(prefix)) ?? null;
  const opp = fairOpponent(snap);
  const swift = isSwiftplay(snap);
  const out: Verdict[] = [];
  const add = (verdict: Verdict) => out.push(verdict);

  // --- Deaths -------------------------------------------------------------
  const topKiller = snap.deathSources.filter((source) => source.champion && source.champion !== "Unknown")[0];
  if (topKiller && topKiller.deathsTo >= 2) {
    const enemy = snap.enemies.find((entry) => entry.champion === topKiller.champion);
    const known = issue(`repeat-killer-`)?.label.startsWith(topKiller.champion) || brief?.killerNotes.some((note) => note.includes(topKiller.champion));
    const assassin = enemy?.roles.includes("Assassin") || enemy?.position === "JUNGLE";
    add({
      id: "deaths-repeat", tone: "fix", topic: "deaths", weight: 90 + topKiller.deathsTo * 5,
      headline: `${topKiller.deathsTo} deaths to ${topKiller.champion} — ${killerTail(enemy)}`,
      detail: known ? `Same as your recent games — track ${topKiller.champion} on the map.`
        : assassin ? `Ward where you walk; keep Flash for their jump.` : `Only fight ${topKiller.champion} next to your team.`,
    });
  }
  const earlyIssue = issue("early-deaths");
  if (earlyIssue && time < 600 && me.deaths >= 2) {
    add({ id: "deaths-early", tone: "fix", topic: "deaths", weight: 80, headline: `${me.deaths} deaths before 10:00 again`, detail: "Your usual pattern — play behind your support until 10:00." });
  } else if (me.deaths >= 3 && me.deaths > me.kills + 1) {
    add({ id: "deaths-many", tone: "fix", topic: "deaths", weight: 50 + me.deaths * 4, headline: `${me.deaths} deaths — play safer`, detail: "Stay behind your team; let the enemy come to you." });
  }
  if (me.deaths === 0 && time >= 300) {
    const beatHabit = earlyIssue && time >= 600;
    add({
      id: "deaths-none", tone: "good", topic: "deaths", weight: beatHabit ? 72 : 40 + Math.min(20, time / 60),
      headline: beatHabit ? "No deaths before 10:00 — habit beaten" : "No deaths yet — keep it clean",
      detail: beatHabit ? "You usually die early here. Not this game." : null,
    });
  } else if (me.deaths <= 1 && me.kills + me.assists >= 5) {
    add({ id: "kda-clean", tone: "good", topic: "kda", weight: 50, headline: `${me.kills}/${me.deaths}/${me.assists} — you're winning fights`, detail: null });
  }

  // --- Gold ---------------------------------------------------------------
  const unspentIssue = issue("unspent-gold");
  const richDeath = [...memory.deaths].reverse().find((death) => death.gold >= UNSPENT_DEATH_GOLD && time - death.at <= RICH_DEATH_SECONDS);
  if (richDeath) {
    add({
      id: "gold-death", tone: "fix", topic: "gold", weight: unspentIssue ? 88 : 78,
      headline: `Died holding ${formatGold(richDeath.gold)}g${unspentIssue ? " again" : ""}`,
      detail: "Back and spend before fights when you have 1,000g+.",
    });
  }
  const nextCost = nextBuyCost(snap);
  const nextName = snap.recommendations[0]?.nextStep?.item || snap.recommendations[0]?.item || null;
  if (!me.isDead && memory.richSince !== null && time - memory.richSince >= RICH_SECONDS) {
    const minutes = Math.max(1, Math.round((time - memory.richSince) / 60));
    add({
      id: "gold-unspent", tone: "fix", topic: "gold", weight: 85,
      headline: `Back now — ${formatGold(me.currentGold)}g unspent`,
      detail: nextName ? `You've had ${nextName} money for ${minutes} min.` : `Unspent for ${minutes} min — that gold isn't fighting.`,
    });
  } else if (!me.isDead && me.currentGold >= Math.max(2500, nextCost * 2)) {
    add({ id: "gold-unspent", tone: "fix", topic: "gold", weight: 70, headline: `Back and spend — ${formatGold(me.currentGold)}g`, detail: "Unspent gold doesn't win fights." });
  }

  // --- Lane: CS and levels vs the lane opponent (relative, never absolute) ---
  if (opp && time >= 180) {
    // Riot's CS feed moves in steps of 10: gaps under CS_GAP_MIN are noise and never judged; bigger ones read "~N".
    const lane = csGap(me.cs, opp.cs);
    const rel = lane.gap / Math.max(opp.cs, 20);
    if (lane.call === "behind" && rel <= -0.1) {
      add({ id: "cs-behind", tone: "fix", topic: "cs", weight: 60 + Math.min(25, lane.approx / 2), headline: `~${lane.approx} CS behind ${opp.champion}`, detail: "Last-hit first; trade only when the wave is safe." });
    } else if (lane.call === "ahead" && rel >= 0.1) {
      add({ id: "cs-ahead", tone: "good", topic: "cs", weight: 55 + Math.min(25, lane.approx / 2), headline: `Clearly ahead on farm vs ${opp.champion}`, detail: `~${lane.approx} CS up — that gold is your next item.` });
    }
    const levels = me.level - opp.level;
    if (levels <= -2) add({ id: "level-behind", tone: "fix", topic: "level", weight: 70, headline: `${-levels} levels behind ${opp.champion}`, detail: "Don't fight them until you catch up." });
    else if (levels >= 2) add({ id: "level-ahead", tone: "good", topic: "level", weight: 60, headline: `${levels} levels up on ${opp.champion}`, detail: "You win fights now — punish when they step up." });
  }

  // --- Kill participation -------------------------------------------------
  const teamKills = me.kills + snap.allies.reduce((sum, ally) => sum + ally.kills, 0);
  if (time >= 360 && teamKills >= 5) {
    const kp = Math.round((me.kills + me.assists) / teamKills * 100);
    if (kp >= 60) add({ id: "kp-high", tone: "good", topic: "kp", weight: 45, headline: `In ${kp}% of your team's kills`, detail: "You're showing up — keep grouping for fights." });
    else if (kp < 30 && time >= 480) add({ id: "kp-low", tone: "fix", topic: "kp", weight: 45, headline: `Only ${kp}% kill participation`, detail: "Join your team for fights and objectives." });
  }

  // --- Vision -------------------------------------------------------------
  if (time >= (swift ? 480 : 600)) {
    const perMinute = me.wardScore / (time / 60);
    if (perMinute < 0.35) add({ id: "vision-low", tone: "fix", topic: "vision", weight: 25, headline: `Ward score ${Math.round(me.wardScore)} — ward more`, detail: "Buy a Control Ward each back; ward before objectives." });
    else if (perMinute >= 1) add({ id: "vision-good", tone: "good", topic: "vision", weight: 25, headline: `Good vision — ward score ${Math.round(me.wardScore)}`, detail: null });
  }

  // --- Items --------------------------------------------------------------
  const steps = snap.buildPath?.steps ?? [];
  const latest = memory.completed[memory.completed.length - 1];
  if (latest && time - latest.at <= FRESH_ITEM_SECONDS) {
    const usual = usualFirstItem(snap);
    const first = memory.completed.length === 1 && !steps.some((step) => step.status === "owned" && step.cost >= 2000 && step.item !== latest.item);
    const nextStep = steps.find((step) => step.status !== "owned" && step.item !== latest.item);
    if (first && usual !== null && latest.at < usual - 30) {
      add({ id: "item-fast", tone: "good", topic: "item", weight: 78, headline: `${latest.item} ${clock(usual - latest.at)} faster than usual`, detail: `Your usual first item lands at ${clock(usual)}.` });
    } else {
      add({ id: "item-done", tone: "good", topic: "item", weight: 62, headline: `${latest.item} done — right on your build`, detail: nextStep ? `Next spike: ${nextStep.item}.` : null });
    }
  }
  const legendaryOwned = steps.some((step) => step.status === "owned" && step.cost >= 2000);
  if (issue("slow-first-item") && !legendaryOwned && time >= (swift ? 660 : 900)) {
    add({ id: "item-slow", tone: "fix", topic: "item", weight: 66, headline: `No item yet at ${clock(time)} — again`, detail: "Back on your next safe wave and finish it." });
  }

  // --- The player's focus (from replay review) -----------------------------
  const focus = brief?.focus;
  const metric = focus?.metric;
  // Pace from a ±9 reading: "good" only if even the low end makes the target, "fix" only if even the high end misses by 10%+.
  const pace = focus && metric && metric.kind === "csAt10" && time >= 180 ? csPaceAt10(me.cs, time) : null;
  if (focus && metric && pace) {
    if (pace.low >= metric.target) add({ id: "focus-cs", tone: "good", topic: "cs", weight: 76, headline: `On pace for about ${pace.about} CS at 10:00`, detail: `Your focus: ${focus.title}.` });
    else if (pace.high < metric.target * 0.9) add({ id: "focus-cs", tone: "fix", topic: "cs", weight: 76, headline: `CS pace about ${pace.about} — target ${metric.target}`, detail: shorten(focus.drill, 12) });
  }
  if (focus && metric && metric.kind === "deathsBefore10" && time < 600) {
    if (me.deaths > metric.target) add({ id: "focus-deaths", tone: "fix", topic: "deaths", weight: 86, headline: `${me.deaths} deaths — focus is ${metric.target} max`, detail: shorten(focus.drill, 12) });
    else if (time >= 300) add({ id: "focus-deaths", tone: "good", topic: "deaths", weight: 70, headline: `Focus on track: ${me.deaths}/${metric.target} deaths`, detail: `Keep it up until 10:00.` });
  }

  return rank(out);
}

function shorten(text: string, words: number) {
  const parts = text.trim().split(/\s+/);
  return parts.length <= words ? text.trim() : `${parts.slice(0, words).join(" ").replace(/[,;:.]$/, "")}…`;
}

function rank(all: Verdict[]): CoachVerdicts {
  // One verdict per topic (good and fix compete), then top 2 per side.
  const byTopic = new Map<string, Verdict>();
  for (const verdict of all) {
    const current = byTopic.get(verdict.topic);
    if (!current || verdict.weight > current.weight) byTopic.set(verdict.topic, verdict);
  }
  const kept = [...byTopic.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return { good: kept.filter((v) => v.tone === "good").slice(0, MAX_PER_SIDE), fix: kept.filter((v) => v.tone === "fix").slice(0, MAX_PER_SIDE) };
}

// ---------------------------------------------------------------------------
// "What should I do right now?" — the single most urgent call.
// ---------------------------------------------------------------------------

export type NowTone = "danger" | "soon" | "go" | "ai" | "calm";
export type NowCall = { tone: NowTone; text: string; source: "death" | "soul" | "objective" | "spike" | "ai" | "buy" | "default" };

export type RecentAlert = { kind: string; priority: "high" | "normal"; text: string; call?: string; gameTime: number };

const BIG = new Set<LiveObjectiveTimer["id"]>(["dragon", "baron", "elder", "atakhan"]);
const SPIKE_WINDOW = 30;

export function objectiveRemaining(objective: LiveObjectiveTimer, time: number): number | null {
  if (objective.status === "up") return 0;
  if (objective.nextSpawnAt == null) return null;
  return Math.max(0, objective.nextSpawnAt - time);
}

/** The next `count` objectives that matter: up first, then soonest. Taken/unknown ones are dropped. */
export function nextObjectives(snap: LiveGameSnapshot, time: number, count = 2): LiveObjectiveTimer[] {
  return (snap.objectives || [])
    .filter((objective) => objective.status !== "taken" && objective.status !== "unknown" && objectiveRemaining(objective, time) !== null)
    .sort((a, b) => (objectiveRemaining(a, time)! - objectiveRemaining(b, time)!) || Number(BIG.has(b.id)) - Number(BIG.has(a.id)))
    .slice(0, count);
}

const shortLabel = (label: string) => label.replace(/ Nashor$/, "").replace(/ Dragon$/, "");

export function nowCall(snap: LiveGameSnapshot, options: { time?: number; alerts?: RecentAlert[]; aiSummary?: string | null } = {}): NowCall {
  const time = options.time ?? snap.game.time;
  const me = snap.activePlayer;
  if (me.isDead || snap.deathMoment) {
    return { tone: "danger", source: "death", text: "You're dead — shop and plan your respawn" };
  }
  const objectives = (snap.objectives || []).map((objective) => ({ objective, remaining: objectiveRemaining(objective, time) }));
  const dragon = objectives.find((entry) => entry.objective.id === "dragon");
  const soul = snap.dragonState?.soulPoint;
  // Walking into an objective fight with 1000g+ that already buys the next piece is how most deaths-with-gold happen.
  const rec0 = snap.recommendations[0];
  const piece = rec0?.nextStep;
  const unspent = Math.floor(me.currentGold);
  const holding = unspent >= 1000 && Boolean(piece?.affordable || (rec0 && !piece && rec0.cost > 0 && unspent >= rec0.cost));
  const spendFirst = (what: string) => `Spend your ${unspent.toLocaleString("en-US")}g first (${piece?.item ?? rec0?.item}) — then ${what}`;
  if ((soul === "enemy" || soul === "both") && dragon && dragon.remaining !== null && dragon.remaining <= 60) {
    if (holding) return { tone: "danger", source: "buy", text: spendFirst("group for the soul Dragon") };
    return { tone: "danger", source: "soul", text: dragon.remaining <= 0 ? "Enemy soul point — Dragon is up, contest it" : `Enemy soul point — Dragon in ${Math.ceil(dragon.remaining)}s, group now` };
  }
  const upBig = objectives.find((entry) => BIG.has(entry.objective.id) && entry.remaining === 0);
  if (upBig) {
    const label = shortLabel(upBig.objective.label);
    if (holding) return { tone: "go", source: "buy", text: spendFirst(`group for ${label}`) };
    const forSoul = upBig.objective.id === "dragon" && soul === "ally";
    return { tone: "go", source: "objective", text: forSoul ? "Dragon is up — take it for soul" : `${label} is up — group and take it` };
  }
  const spike = [...(options.alerts ?? [])].reverse()
    .find((alert) => alert.priority === "high" && (alert.kind === "enemy-level" || alert.kind === "enemy-item") && time - alert.gameTime <= SPIKE_WINDOW);
  if (spike) return { tone: "danger", source: "spike", text: spike.call || spike.text };
  // An enemy just stacked resistance against your damage (heavy): what to build against it.
  const resist = [...(options.alerts ?? [])].reverse()
    .find((alert) => alert.priority === "high" && alert.kind === "enemy-resist" && time - alert.gameTime <= SPIKE_WINDOW);
  if (resist) return { tone: "soon", source: "buy", text: resist.call || resist.text };
  const soon = objectives
    .filter((entry) => entry.remaining !== null && entry.remaining > 0 && entry.remaining <= 60)
    .sort((a, b) => a.remaining! - b.remaining!)[0];
  if (soon) {
    const label = shortLabel(soon.objective.label);
    if (holding) return { tone: "go", source: "buy", text: spendFirst(`${label} in ${Math.ceil(soon.remaining!)}s`) };
    return { tone: "soon", source: "objective", text: `${label} in ${Math.ceil(soon.remaining!)}s — shove and move up` };
  }
  const upSmall = objectives.find((entry) => entry.remaining === 0);
  if (upSmall) return { tone: "go", source: "objective", text: `${shortLabel(upSmall.objective.label)} is up — take it if it's safe` };
  if (options.aiSummary) return { tone: "ai", source: "ai", text: options.aiSummary };
  const rec = snap.recommendations[0];
  const step = rec?.nextStep;
  if (step?.affordable || (rec && !step && rec.cost > 0 && me.currentGold >= rec.cost)) {
    return { tone: "go", source: "buy", text: `You can buy ${step?.item ?? rec.item} — back on a safe wave` };
  }
  const next = nextObjectives(snap, time, 1)[0];
  const remaining = next ? objectiveRemaining(next, time) : null;
  if (next && remaining !== null && remaining <= 180) return { tone: "calm", source: "default", text: `Farm safely — ${shortLabel(next.label)} in ${clock(remaining)}` };
  const threat = [...snap.enemies].sort((a, b) => b.threatScore - a.threatScore)[0];
  return { tone: "calm", source: "default", text: threat && (threat.threat === "critical" || threat.threat === "high") ? `Farm safely and track ${threat.champion}` : "Farm safely and keep your wave healthy" };
}

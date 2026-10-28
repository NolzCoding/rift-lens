// The review page's plain-language read of a replay, for any champion: what decided the game, a headline, and three
// next-game priorities, all computed from the analysis (reader stats + Rift Lens's review data). Pure and client-safe.
import type { BuildReview, Enemy, Player, ReplayAnalysis } from "@/lib/types";

export type FactTone = "good" | "bad" | "neutral";
export type Fact = { id: string; label: string; value: string; detail: string; tone: FactTone; weight: number; sentence: string };
export type PriorityIcon = "target" | "crosshair" | "shield" | "eye" | "coins" | "swords";
export type Priority = { id: string; title: string; description: string; icon: PriorityIcon };

export type ReviewInsights = {
  you: Player | null;
  partner: Player | null;
  opponents: Enemy[];
  /** "Akali" / "Yasuo + Rengar". */
  laneLabel: string;
  goldDiff: number;
  levelDiff: number;
  headline: string;
  summary: string;
  facts: Fact[];
  priorities: Priority[];
  build: BuildReview | null;
};

export const UNSPENT_GOLD = 1000;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const gold = (value: number) => `${Math.round(Math.abs(value)).toLocaleString("en-US")}g`;
const pct = (value: number) => `${Math.round(value * 100)}%`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const signedGold = (value: number) => `${value >= 0 ? "+" : "−"}${gold(value)}`;

/** Badge for a player card. */
export function impactBadge(player: Player): { label: string; tone: "good" | "warn" | "bad" } {
  const kda = (player.kills + player.assists) / Math.max(1, player.deaths);
  if (player.deaths >= 8 || kda < 1.5) return { label: "Rough game", tone: "bad" };
  if (player.damageShare >= 0.28 && player.kills >= player.deaths) return { label: "Carried", tone: "good" };
  if (kda >= 3) return { label: "Solid", tone: "good" };
  return { label: "Mixed", tone: "warn" };
}

const isSupport = (player: Player) => player.position === "UTILITY";

export function reviewInsights(analysis: ReplayAnalysis): ReviewInsights {
  const review = analysis.review;
  const minutes = Math.max(1, analysis.replay.durationMs / 60000);
  const seconds = analysis.replay.durationMs / 1000;
  const you = analysis.players.find((player) => player.participantId === review?.youId) || analysis.players[0] || null;
  const partner = analysis.players.find((player) => player !== you) || null;
  const opponents = analysis.enemyLane;
  const laneLabel = opponents.map((enemy) => enemy.champion).join(" + ") || "your lane opponent";
  const mainOpponent = (you && opponents.find((enemy) => enemy.position === you.position)) || opponents[0] || null;
  const side = analysis.players;
  const goldDiff = side.reduce((sum, player) => sum + player.gold, 0) - opponents.reduce((sum, enemy) => sum + (enemy.gold || 0), 0);
  const levelDiff = you && mainOpponent ? you.level - mainOpponent.level : 0;
  const swiftplay = analysis.replay.mode?.class === "swiftplay";
  const build = (you && review?.builds.find((entry) => entry.participantId === you.participantId)) || null;
  const recorded = review?.recorded || null;
  const facts: Fact[] = [];
  const priorities: Array<Priority & { weight: number }> = [];

  if (!you) {
    return { you, partner, opponents, laneLabel, goldDiff, levelDiff, headline: "No reviewed player in this replay.", summary: "", facts, priorities: [], build };
  }

  // Deaths.
  const per10 = (you.deaths / minutes) * 10;
  const deathTone: FactTone = you.deaths >= 8 || per10 >= 3 ? "bad" : you.deaths <= 3 || per10 <= 1.5 ? "good" : "neutral";
  facts.push({
    id: "deaths", label: "Deaths", value: `${you.kills} / ${you.deaths} / ${you.assists}`,
    detail: you.deaths ? `one death every ${clock(seconds / you.deaths)}` : "no deaths", tone: deathTone, weight: deathTone === "bad" ? per10 * 1.6 : deathTone === "good" ? 2 : 0.5,
    sentence: deathTone === "bad" ? `${plural(you.deaths, "death")} gave the enemy too much gold` : `you died only ${plural(you.deaths, "time")}`,
  });

  // Lane economy.
  if (mainOpponent) {
    const duo = side.length > 1 ? "your duo" : "you";
    const tone: FactTone = goldDiff >= 1500 ? "good" : goldDiff <= -1500 ? "bad" : "neutral";
    const levelWord = `${Math.abs(levelDiff)} level${Math.abs(levelDiff) === 1 ? "" : "s"}`;
    const levels = levelDiff ? `, ${levelWord} ${levelDiff > 0 ? "ahead" : "behind"}` : "";
    // "5,109g and 4 levels ahead of Akali" / "1,819g behind Yasuo (1 level ahead)".
    const sameWay = levelDiff && (levelDiff > 0) === (goldDiff >= 0);
    const levelTail = !levelDiff ? "" : sameWay ? ` and ${levelWord}` : ` (${levelWord} ${levelDiff > 0 ? "ahead" : "behind"})`;
    facts.push({
      id: "gold", label: `Gold vs ${laneLabel}`, value: signedGold(goldDiff),
      detail: `${gold(side.reduce((sum, player) => sum + player.gold, 0))} vs ${gold(opponents.reduce((sum, enemy) => sum + (enemy.gold || 0), 0))}${levels}`,
      tone, weight: Math.abs(goldDiff) / 1000 + Math.abs(levelDiff) * 0.5,
      sentence: sameWay || !levelDiff
        ? `${duo} finished ${gold(goldDiff)}${levelTail} ${goldDiff >= 0 ? "ahead of" : "behind"} ${laneLabel}`
        : `${duo} finished ${gold(goldDiff)} ${goldDiff >= 0 ? "ahead of" : "behind"} ${laneLabel}${levelTail}`,
    });
    const ratio = mainOpponent.cs ? you.cs / mainOpponent.cs : 1;
    const csTone: FactTone = ratio >= 1.25 ? "good" : ratio <= 0.8 ? "bad" : "neutral";
    facts.push({
      id: "cs", label: swiftplay ? `Last hits vs ${mainOpponent.champion}` : `Farm vs ${mainOpponent.champion}`,
      value: `${you.cs} vs ${mainOpponent.cs}`,
      detail: swiftplay ? "Swiftplay: compare to your opponent, not normal CS targets" : `${(you.cs / minutes).toFixed(1)} vs ${(mainOpponent.cs / minutes).toFixed(1)} per minute`,
      // CS backs up the gold read; it never outweighs it (Swiftplay's nearby-minion gold makes it weaker still).
      tone: isSupport(you) ? "neutral" : csTone, weight: isSupport(you) ? 0 : Math.min(swiftplay ? 1.5 : 3, Math.abs(ratio - 1) * 3),
      sentence: ratio >= 1 ? `you out-farmed ${mainOpponent.champion} ${you.cs} to ${mainOpponent.cs}` : `${mainOpponent.champion} out-farmed you ${mainOpponent.cs} to ${you.cs}`,
    });
  }

  // Damage share and kill participation.
  const damageTone: FactTone = isSupport(you) ? "neutral" : you.damageShare >= 0.28 ? "good" : you.damageShare < 0.18 ? "bad" : "neutral";
  facts.push({
    id: "damage", label: "Team damage", value: pct(you.damageShare), detail: `${Math.round(you.damage).toLocaleString("en-US")} damage to champions`,
    tone: damageTone, weight: damageTone === "neutral" ? 0.5 : Math.abs(you.damageShare - 0.22) * 15,
    sentence: you.damageShare >= 0.22 ? `you dealt ${pct(you.damageShare)} of your team's damage` : `you dealt only ${pct(you.damageShare)} of your team's damage`,
  });
  const kpTone: FactTone = you.killParticipation >= 0.6 ? "good" : you.killParticipation < 0.4 ? "bad" : "neutral";
  facts.push({
    id: "kp", label: "Kill participation", value: pct(you.killParticipation), detail: `in ${you.kills + you.assists} of your team's ${analysis.replay.teamKills} kills`,
    tone: kpTone, weight: kpTone === "neutral" ? 0.3 : Math.abs(you.killParticipation - 0.5) * 6,
    sentence: kpTone === "bad" ? `you were in only ${pct(you.killParticipation)} of your team's kills` : `you were in ${pct(you.killParticipation)} of your team's kills`,
  });

  // Vision.
  const visionPerMin = you.vision / minutes;
  const visionBar = isSupport(you) ? 1.5 : 0.5;
  const visionTone: FactTone = visionPerMin < visionBar ? "bad" : visionPerMin >= visionBar * 2 ? "good" : "neutral";
  facts.push({
    id: "vision", label: "Vision", value: String(you.vision), detail: `${plural(you.wardsPlaced, "ward")} placed in ${Math.round(minutes)} min`,
    tone: visionTone, weight: visionTone === "bad" ? 1.5 : 0.3,
    sentence: `you placed ${plural(you.wardsPlaced, "ward")} in ${Math.round(minutes)} minutes`,
  });

  // From the live recording.
  const unspent = recorded ? recorded.deaths.filter((death) => death.goldUnspent >= UNSPENT_GOLD) : [];
  const outnumbered = recorded ? recorded.deaths.filter((death) => death.assisters.length >= 2) : [];
  if (recorded && recorded.deaths.length) {
    const worst = unspent.reduce<typeof unspent[number] | null>((best, death) => (!best || death.goldUnspent > best.goldUnspent ? death : best), null);
    facts.push({
      id: "unspent", label: "Gold held at death", value: `${unspent.length} of ${recorded.deaths.length}`,
      detail: worst ? `worst: ${clock(worst.time)} holding ${gold(worst.goldUnspent)}` : "you spent your gold before dying",
      tone: unspent.length ? "bad" : "good", weight: unspent.length * 1.5,
      sentence: unspent.length ? `you died ${plural(unspent.length, "time")} holding ${gold(UNSPENT_GOLD)}+` : "you spent your gold before fights",
    });
  }
  if (recorded?.csAt10 != null) {
    const average = recorded.csAt10Average;
    const tone: FactTone = average == null ? "neutral" : recorded.csAt10 >= average + 5 ? "good" : recorded.csAt10 <= average - 5 ? "bad" : "neutral";
    facts.push({
      id: "cs10", label: "CS at 10:00", value: String(recorded.csAt10),
      detail: average != null ? `your ${you.champion} average: ${average} (${plural(recorded.csAt10Games, "game")})` : "first recorded game on this champion",
      tone, weight: average == null ? 0 : Math.abs(recorded.csAt10 - average) / 8,
      sentence: `you had ${recorded.csAt10} CS at 10:00`,
    });
  }

  // Build.
  if (build) {
    const matched = build.topBuild?.slots.filter((slot) => slot.matched).length ?? 0;
    const bad = build.findings.filter((finding) => finding.tone === "bad");
    const tone: FactTone = bad.length ? "bad" : build.findings.length ? "neutral" : "good";
    facts.push({
      id: "build", label: "Build", value: build.topBuild ? `${matched} of ${build.topBuild.slots.length}` : "no top build",
      detail: build.topBuild ? "top-build slots you filled" : `no saved top build for ${you.champion}`,
      tone, weight: bad.length * 1.2,
      sentence: bad.length ? `your build left a gap: ${bad[0].title.charAt(0).toLowerCase()}${bad[0].title.slice(1)}` : "your build matched the top build",
    });
  }

  // Headline: the result plus the two facts that weighed most in its direction.
  const win = analysis.replay.outcome === "win";
  const direction = facts.filter((fact) => fact.tone === (win ? "good" : "bad")).sort((a, b) => b.weight - a.weight);
  const against = facts.filter((fact) => fact.tone === (win ? "bad" : "good")).sort((a, b) => b.weight - a.weight);
  const leads = direction.slice(0, 2).map((fact) => fact.sentence);
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const headline = leads.length
    ? `${win ? "Win" : "Loss"}: ${capital(leads.join(", and "))}.`
    : `${win ? "Win" : "Loss"} on ${you.champion}: no single stat decided it.`;
  const summaryParts = [
    `${you.champion} ${you.position ? `(${you.position.toLowerCase().replace("utility", "support").replace("middle", "mid").replace("bottom", "bot")}) ` : ""}vs ${laneLabel}, ${Math.round(minutes)} minutes.`,
    against[0] ? `Watch out: ${against[0].sentence}.` : "",
    swiftplay ? "Swiftplay: judged on gold, levels and CS against your lane opponent, not normal Summoner's Rift CS targets." : "",
  ];

  // Priorities, most important first.
  if (unspent.length) {
    const worst = unspent.reduce((best, death) => (death.goldUnspent > best.goldUnspent ? death : best));
    priorities.push({
      id: "unspent", icon: "coins", weight: 9 + unspent.length,
      title: "Spend your gold before fighting",
      description: `You died ${plural(unspent.length, "time")} holding ${gold(UNSPENT_GOLD)}+ (worst: ${clock(worst.time)} with ${gold(worst.goldUnspent)}). Once you have ${gold(UNSPENT_GOLD)}, recall and buy before the next fight.`,
    });
  }
  if (outnumbered.length >= 2) {
    const example = outnumbered[0];
    priorities.push({
      id: "outnumbered", icon: "shield", weight: 7 + outnumbered.length,
      title: "Don't get caught alone",
      description: `${outnumbered.length} of your ${recorded!.deaths.length} deaths were 3-against-1 or worse (${clock(example.time)}: ${example.killerChampion} + ${example.assisters.join(" + ")}). When enemies are missing from the map, stay near your team or back off.`,
    });
  } else if (deathTone === "bad") {
    priorities.push({
      id: "deaths", icon: "shield", weight: per10 * 2,
      title: "Die less",
      description: `${plural(you.deaths, "death")} in ${Math.round(minutes)} minutes (one every ${clock(seconds / you.deaths)}). Every death hands the enemy gold; when you're low or alone, back off first and fight second.`,
    });
  }
  const buildFinding = build?.findings[0];
  if (buildFinding) {
    priorities.push({ id: "build", icon: "target", weight: buildFinding.tone === "bad" ? 7 : 4, title: buildFinding.title, description: buildFinding.detail });
  }
  const goldFact = facts.find((fact) => fact.id === "gold");
  if (goldFact?.tone === "bad" && mainOpponent) {
    priorities.push({
      id: "lane", icon: "coins", weight: Math.abs(goldDiff) / 500,
      title: "Win the lane economy",
      description: `${side.length > 1 ? "Your duo" : "You"} finished ${gold(goldDiff)}${levelDiff < 0 ? ` and ${plural(-levelDiff, "level")}` : ""} behind ${laneLabel}. ${swiftplay ? "In Swiftplay gold and levels matter more than CS: stay in lane for waves and only trade when you'll win it." : `Your farm: ${(you.cs / minutes).toFixed(1)}/min vs ${(mainOpponent.cs / minutes).toFixed(1)}.`}`,
    });
  }
  const cs10 = facts.find((fact) => fact.id === "cs10");
  if (cs10?.tone === "bad" && recorded) {
    priorities.push({ id: "cs10", icon: "crosshair", weight: 4, title: "Farm the first 10 minutes", description: `${recorded.csAt10} CS at 10:00, below your ${you.champion} average of ${recorded.csAt10Average}. Focus on last-hitting every minion you can reach before 10:00.` });
  }
  if (visionTone === "bad") {
    priorities.push({ id: "vision", icon: "eye", weight: 3, title: "Ward on every trip to lane", description: `${plural(you.wardsPlaced, "ward")} placed in ${Math.round(minutes)} minutes. Drop your trinket ward in a river bush each time you walk to lane: it shows ganks before they reach you.` });
  }
  if (kpTone === "bad") {
    priorities.push({ id: "kp", icon: "swords", weight: 2.5, title: "Join your team's fights", description: `You were in ${pct(you.killParticipation)} of your team's kills. When your team groups for a dragon or tower, go with them.` });
  }
  if (damageTone === "bad") {
    priorities.push({ id: "damage", icon: "crosshair", weight: 2.5, title: "Deal more damage in fights", description: `You dealt ${pct(you.damageShare)} of your team's damage. Stay in fights a little longer and keep hitting whoever is in range instead of waiting for a perfect target.` });
  }
  // Fewer than three problems: keep the good habits visible.
  const strengths: Array<Priority & { weight: number }> = [];
  if (goldFact?.tone === "good") strengths.push({ id: "keep-lane", icon: "swords", weight: 1.5, title: "Turn lane leads into towers", description: `You were ${gold(goldDiff)} ahead of ${laneLabel}. Next game, use the lead to push and hit towers: you did ${Math.round(you.buildingDamage).toLocaleString("en-US")} structure damage.` });
  if (damageTone === "good") strengths.push({ id: "keep-damage", icon: "crosshair", weight: 1.2, title: "Keep carrying fights", description: `${pct(you.damageShare)} of your team's damage on ${you.champion}: same fight habits next game.` });
  if (deathTone === "good") strengths.push({ id: "keep-alive", icon: "shield", weight: 1, title: "Keep the low-death habit", description: `Only ${plural(you.deaths, "death")}: staying alive kept your gold and levels flowing.` });
  for (const strength of strengths) if (priorities.length < 3) priorities.push(strength);

  return {
    you, partner, opponents, laneLabel, goldDiff, levelDiff, headline,
    summary: summaryParts.filter(Boolean).join(" "),
    facts,
    priorities: priorities.sort((a, b) => b.weight - a.weight).slice(0, 3).map(({ weight: _weight, ...priority }) => { void _weight; return priority; }),
    build,
  };
}

import { THREAT_THRESHOLDS } from "@/lib/threat-thresholds";
import { aboutCs, csRange, csTargetCall } from "@/lib/live-coach";
import type { LiveGameSnapshot, LivePlayer } from "@/lib/types";

export type LiveAlertKind = "objective" | "soul" | "enemy-level" | "enemy-item" | "enemy-resist" | "afford" | "focus" | "result";

export type LiveAlert = {
  /** Stable per game: the same event always yields the same id, so callers can dedupe across polls. */
  id: string;
  kind: LiveAlertKind;
  priority: "high" | "normal";
  text: string;
  speech: string;
  /** Short imperative for the live screen's "do this now" line (≤ ~8 words). */
  call?: string;
};

export type DeriveAlertOptions = {
  /** Total gold cost by item id (Data Dragon gold.total). Falls back to LiveItem.price. */
  itemCost?: (itemId: number) => number | undefined;
};

const BIG_OBJECTIVES = new Set(["dragon", "baron", "elder", "atakhan"]);
const POWER_LEVELS = [6, 11, 16];
const BIG_ITEM_GOLD = 2200;

// The account, not the champion: Viego's possession renames him mid-game.
const playerKey = (player: Pick<LivePlayer, "riotId" | "name" | "champion">) => player.riotId || player.name || player.champion;
const spoken = (seconds: number) => seconds >= 60 ? "one minute" : `${seconds} seconds`;

export function deriveAlerts(prev: LiveGameSnapshot | null, next: LiveGameSnapshot, options: DeriveAlertOptions = {}): LiveAlert[] {
  // A different match: never diff across games.
  if (prev && prev.gameId !== next.gameId) prev = null;
  const alerts: LiveAlert[] = [];
  const time = next.game.time;

  // Objectives: 60s / 30s windows, then "up".
  for (const objective of next.objectives || []) {
    const big = BIG_OBJECTIVES.has(objective.id);
    const before = prev?.objectives?.find((entry) => entry.id === objective.id);
    if (objective.nextSpawnAt != null && objective.status !== "up") {
      const remaining = objective.nextSpawnAt - time;
      for (const threshold of [60, 30]) {
        if (remaining <= threshold && remaining > threshold - 15) {
          alerts.push({
            id: `obj:${objective.id}:${objective.nextSpawnAt}:${threshold}`,
            kind: "objective", priority: big && threshold === 30 ? "high" : "normal",
            text: `${objective.label} in ${threshold}s`,
            speech: `${objective.label} in ${spoken(threshold)}`,
            call: `${objective.label} in ${threshold}s — move up now`,
          });
        }
      }
      if (remaining <= 0 && remaining > -10) {
        alerts.push({ id: `obj:${objective.id}:${objective.nextSpawnAt}:now`, kind: "objective", priority: big ? "high" : "normal", text: `${objective.label} is up`, speech: `${objective.label} is up`, call: `${objective.label} is up — group up` });
      }
    }
    if (objective.status === "up" && before && before.status !== "up") {
      const spawnKey = before.nextSpawnAt ?? Math.round(time / 30) * 30;
      alerts.push({ id: `obj:${objective.id}:${spawnKey}:now`, kind: "objective", priority: big ? "high" : "normal", text: `${objective.label} is up`, speech: `${objective.label} is up`, call: `${objective.label} is up — group up` });
    }
  }

  // Soul point (either team).
  const soul = next.dragonState?.soulPoint;
  const soulType = next.dragonState?.soulType ? ` (${next.dragonState.soulType})` : "";
  if (soul === "ally" || soul === "both") alerts.push({ id: "soul:ally", kind: "soul", priority: "normal", text: `Your team is on soul point${soulType}`, speech: "Your team is on soul point. Next dragon wins soul.", call: "Next Dragon wins soul — set up vision" });
  if (soul === "enemy" || soul === "both") alerts.push({ id: "soul:enemy", kind: "soul", priority: "high", text: `Enemy on soul point${soulType} — contest next dragon`, speech: "Enemy team is on soul point. Do not give the next dragon.", call: "Enemy soul point — contest next Dragon" });

  // Enemy power spikes need a previous poll so loading mid-game does not flood alerts.
  if (prev) {
    const laneKey = next.laneOpponent ? playerKey(next.laneOpponent) : "";
    for (const enemy of next.enemies) {
      const key = playerKey(enemy);
      const before = prev.enemies.find((entry) => playerKey(entry) === key);
      if (!before) continue;
      const important = key === laneKey || enemy.threat === "critical" || enemy.threat === "high";
      for (const level of POWER_LEVELS) {
        if (enemy.level >= level && before.level < level) {
          alerts.push({
            id: `lvl:${key}:${level}`, kind: "enemy-level", priority: important ? "high" : "normal",
            text: `${enemy.champion} hit level ${level}${level === 6 ? " — ult online" : ""}`,
            speech: level === 6 ? `${enemy.champion} has ultimate` : `${enemy.champion} is level ${level}`,
            call: level === 6 ? `${enemy.champion} has ult — don't walk up alone` : `${enemy.champion} hit ${level} — respect the spike`,
          });
        }
      }
      const owned = new Map<number, number>();
      for (const item of before.items) owned.set(item.id, (owned.get(item.id) || 0) + Math.max(1, item.count));
      const resist = resistAlert(prev, next, before, enemy, owned, key, options);
      if (resist) alerts.push(resist.alert);
      for (const item of enemy.items) {
        const had = owned.get(item.id) || 0;
        if (had >= Math.max(1, item.count)) continue;
        // The resist alert already called this purchase (with what to build against it).
        if (resist?.itemId === item.id) continue;
        const cost = options.itemCost?.(item.id) ?? item.price;
        if (cost < BIG_ITEM_GOLD) continue;
        alerts.push({
          id: `item:${key}:${item.id}`, kind: "enemy-item", priority: key === laneKey ? "high" : "normal",
          text: `${enemy.champion} completed ${item.name}`,
          speech: `${enemy.champion} finished ${item.name}`,
          call: `${enemy.champion} finished ${item.name} — no long trades`,
        });
      }
    }
  }

  return [...alerts, ...tailAlerts(next, prev, time)];
}

const RESISTS = [
  { signal: "armorStack", stat: "armor", bonus: "bonusArmor", label: "armor", pen: "armor penetration", min: THREAT_THRESHOLDS.resistAlert.armorBonus, bar: THREAT_THRESHOLDS.armor },
  { signal: "mrStack", stat: "magicResist", bonus: "bonusMagicResist", label: "MR", pen: "magic penetration", min: THREAT_THRESHOLDS.resistAlert.mrBonus, bar: THREAT_THRESHOLDS.magicResist },
] as const;
/** Signal levels in order, to tell whether a purchase raised one. */
const LEVEL_RANK = { none: 0, some: 1, heavy: 2 } as const;
const round5 = (value: number) => Math.round(value / 5) * 5;

/**
 * An enemy bought resistance against the player's damage (armor vs physical, MR vs magic; next.counterPicks says which the
 * engine watches for this player). Fires once per enemy item purchase (stable id) when the item's own armor/MR (Data
 * Dragon stats on LiveItem) is at least THREAT_THRESHOLDS.resistAlert's bar on a 2000g+ item that leaves that enemy at
 * the armor/MR "high" bar, or when the purchase raised the team's armorStack/mrStack level. The counter named is the
 * engine's own pick (fits the champion, not group-locked, a top-build option first).
 */
function resistAlert(
  prev: LiveGameSnapshot, next: LiveGameSnapshot, before: LivePlayer, enemy: LivePlayer, owned: Map<number, number>, key: string, options: DeriveAlertOptions,
): { alert: LiveAlert; itemId: number } | null {
  if (!enemy.estStats) return null;
  for (const resist of RESISTS) {
    const pick = next.counterPicks?.find((entry) => entry.signal === resist.signal);
    if (!pick) continue;
    const bought = enemy.items.filter((item) => (owned.get(item.id) || 0) < Math.max(1, item.count) && (item[resist.stat] || 0) > 0);
    if (!bought.length) continue;
    const main = [...bought].sort((a, b) => (b[resist.stat] || 0) - (a[resist.stat] || 0))[0];
    const cost = options.itemCost?.(main.id) ?? main.price;
    const total = enemy.estStats[resist.stat];
    const atBar = total >= resist.bar.high || enemy.estStats[resist.bonus] >= resist.bar.bonusHigh;
    const big = (main[resist.stat] || 0) >= resist.min && cost >= 2000 && atBar;
    const level = next.enemyProfile?.[resist.signal].level ?? pick.level;
    const was = prev.enemyProfile?.[resist.signal].level ?? "none";
    const raised = LEVEL_RANK[level] > LEVEL_RANK[was];
    if (!big && !raised) continue;
    const heavy = level === "heavy";
    const amount = `~${round5(total)} ${resist.label}`;
    const state = raised ? ` — their ${resist.label} is ${heavy ? "stacking" : "building up"}` : "";
    const counter = pick.item ? ` → ${resist.pen} ${heavy ? "next" : "soon"}: ${pick.item}` : ` → ${resist.pen} matters now`;
    return {
      itemId: main.id,
      alert: {
        id: `resist:${key}:${main.id}:${resist.signal}`, kind: "enemy-resist", priority: heavy ? "high" : "normal",
        text: `${enemy.champion} built ${main.name}: ${amount}${state}${counter}`,
        speech: `${enemy.champion} built ${main.name}. ${pick.item ? `${heavy ? "Buy" : "Consider"} ${pick.item}.` : `They have ${resist.label === "MR" ? "magic resist" : "armor"} now.`}`,
        call: pick.item ? `${enemy.champion} ${amount} — ${heavy ? "buy" : "plan"} ${pick.item}` : `${enemy.champion} ${amount} — ${resist.pen} needed`,
      },
    };
  }
  return null;
}

function tailAlerts(next: LiveGameSnapshot, prev: LiveGameSnapshot | null, time: number): LiveAlert[] {
  const alerts: LiveAlert[] = [];
  // You can afford the primary recommendation's next step (once per item).
  const primary = next.recommendations.find((choice) => choice.priority === "primary") || next.recommendations[0];
  if (primary?.nextStep?.affordable) {
    const step = primary.nextStep;
    const toward = step.itemId !== primary.itemId ? ` → ${primary.item}` : "";
    alerts.push({ id: `afford:${step.itemId}`, kind: "afford", priority: "normal", text: `You can afford ${step.item} (${step.cost}g)${toward}`, speech: `You can buy ${step.item}` });
  }

  // 10:00 focus checkpoint.
  const focus = next.playerBrief?.focus;
  const crossedTen = time >= 600 && (prev ? prev.game.time < 600 : time < 630);
  if (focus && crossedTen) {
    const metric = focus.metric;
    const active = next.activePlayer;
    let text = `10:00 check — ${focus.title}`;
    let speech = `Ten minute check. ${focus.title}`;
    if (metric?.kind === "csAt10") {
      // Riot reports CS in steps of 10 (40 means 40–49): only call it met/missed when the whole range agrees.
      const range = csRange(active.cs);
      const call = csTargetCall(active.cs, metric.target);
      const shown = range.coarse ? `about ${aboutCs(range.mid)}` : String(range.low);
      text = `10:00 — ${shown} CS (target ${metric.target}) ${call === "met" ? "✓" : call === "missed" ? "✗" : "· too close to call"}`;
      speech = `Ten minutes. ${shown} C S. Target was ${metric.target}. ${call === "met" ? "Nice." : call === "missed" ? "Keep farming." : "Right around it."}`;
    } else if (metric?.kind === "deathsBefore10") {
      const met = active.deaths <= metric.target;
      text = `10:00 — ${active.deaths} death${active.deaths === 1 ? "" : "s"} (target ≤ ${metric.target}) ${met ? "✓" : "✗"}`;
      speech = `Ten minutes. ${active.deaths} deaths. ${met ? "Focus met." : "Play safer."}`;
    }
    alerts.push({ id: "focus:10", kind: "focus", priority: "normal", text, speech });
  }

  if (next.gameResult && prev?.gameResult !== next.gameResult) {
    const win = next.gameResult === "win";
    alerts.push({ id: "result", kind: "result", priority: "normal", text: win ? "Victory" : "Defeat", speech: win ? "Victory. Well played." : "Defeat. Review it later." });
  }

  return alerts;
}

"use client";

import type { ReactNode } from "react";
import { BrainCircuit, CircleDollarSign, GitBranch, History, LoaderCircle, RotateCcw, Skull, TriangleAlert, X, Zap } from "lucide-react";

import { formatTime, helpMeta, ItemIcon, useNow } from "@/components/live/shared";
import { aiOverride, planNextBuy } from "@/components/live/buy-card";
import type { AiRead } from "@/components/live/use-ai-read";
import type { HelpSlot } from "@/components/live/use-live-help";
import { formatGold, objectiveRemaining } from "@/lib/live-coach";
import type { LiveDeathMoment, LiveGameSnapshot, LiveHelpEnvelope } from "@/lib/types";

type DeathCoachProps = {
  snapshot: LiveGameSnapshot;
  moment: LiveDeathMoment;
  receivedAt: number;
  help: HelpSlot | null;
  /** The live AI read the buy card follows: the shop follows the same build change, so both screens agree. */
  ai: AiRead | null;
  autoNote: string | null;
  onRequest: () => void;
  /** The type-and-ask box, so questions work while dead too. */
  ask?: ReactNode;
};

type DeathBuy = { itemId: number; item: string; cost: number };
type Goal = { itemId: number; item: string; remainingAfter: number; completes: boolean; nextPiece: LiveDeathMoment["goals"][number]["nextPiece"] };
type ShopGroup = { goal: Goal; buys: DeathBuy[] };
type ShopPlan = { groups: ShopGroup[]; extras: DeathBuy[]; total: number; ai: boolean };

/**
 * What to buy, grouped by the item it builds toward. The same source as the alive buy card (planNextBuy): an AI build
 * change while its read is live, else the engine's buyNow + goals (which follow recommendations[0]). Loose purchases
 * (Control Ward) go in `extras`.
 */
function deathPlan(moment: LiveDeathMoment, ai: AiRead | null): ShopPlan {
  const pick = ({ itemId, item, cost }: DeathBuy) => ({ itemId, item, cost });
  if (ai && aiOverride(ai)) {
    let left = Math.floor(moment.goldNow);
    const groups: ShopGroup[] = [];
    for (const buy of ai.buys) {
      if (buy.cost > left) continue;
      left -= buy.cost;
      const existing = groups.find((group) => group.goal.itemId === buy.targetItemId);
      const completes = buy.itemId === buy.targetItemId;
      const remainingAfter = completes ? 0 : Math.max(0, buy.targetCost - buy.cost);
      if (existing) existing.buys.push(pick(buy));
      else groups.push({ goal: { itemId: buy.targetItemId, item: buy.targetItem, remainingAfter, completes, nextPiece: null }, buys: [pick(buy)] });
    }
    if (groups.length) return { groups, extras: [], total: Math.floor(moment.goldNow) - left, ai: true };
  }
  const goals = moment.goals ?? [];
  const claimed = new Set<number>();
  const groups = goals.map((goal) => {
    const buys = moment.buyNow.filter((buy, index) => !claimed.has(index) && (buy.itemId === goal.itemId || buy.forItem === goal.item) && claimed.add(index));
    return { goal, buys: buys.map(pick) };
  });
  const extras = moment.buyNow.filter((_, index) => !claimed.has(index)).map(pick);
  // Goals nothing is bought toward stay hidden, except the first one (it explains what to save for).
  const shown = groups.filter((group, index) => group.buys.length || index === 0);
  return { groups: shown, extras, total: moment.buyNow.reduce((sum, buy) => sum + buy.cost, 0), ai: false };
}

function ShopGroupRow({ group, version }: { group: ShopGroup; version: string }) {
  const { goal, buys } = group;
  const finishing = goal.completes || (buys.length > 0 && goal.remainingAfter === 0);
  return (
    <div className={`death-goal ${finishing ? "is-finish" : ""}`}>
      <ItemIcon version={version} id={goal.itemId} name={goal.item} size={88} />
      <div className="death-goal-body">
        <small>{finishing ? "Finish" : buys.length ? "Building" : "Save for"}</small>
        <b>{goal.item}</b>
        {buys.length > 0 && !goal.completes && (
          <div className="death-goal-parts">
            <span>Buy now:</span>
            {buys.map((buy, index) => (
              <span key={`${buy.itemId}-${index}`} className="death-part"><ItemIcon version={version} id={buy.itemId} name={buy.item} size={40} />{buy.item} <em>{formatGold(buy.cost)}g</em></span>
            ))}
          </div>
        )}
        <p>
          {finishing ? "✓ Completes it this trip"
            : buys.length ? `${formatGold(goal.remainingAfter)}g more to finish it`
              : goal.nextPiece ? `Next piece: ${goal.nextPiece.item} — ${formatGold(goal.nextPiece.goldNeeded)}g more` : `${formatGold(goal.remainingAfter)}g to finish`}
        </p>
      </div>
    </div>
  );
}

/** A sensible "on respawn" call when the AI has not said one. */
function defaultRespawnCall(snapshot: LiveGameSnapshot, moment: LiveDeathMoment) {
  const backAt = snapshot.game.time + moment.respawnIn;
  const dragon = snapshot.objectives.find((objective) => objective.id === "dragon");
  const soul = snapshot.dragonState?.soulPoint;
  const dragonIn = dragon ? objectiveRemaining(dragon, backAt) : null;
  if ((soul === "enemy" || soul === "both") && dragonIn !== null && dragonIn <= 90) return "Group for Dragon — enemy is on soul point";
  const objective = snapshot.objectives
    .map((entry) => ({ entry, remaining: objectiveRemaining(entry, backAt) }))
    .filter((pair) => pair.remaining !== null && pair.remaining <= 60 && pair.entry.status !== "taken" && pair.entry.status !== "unknown")[0];
  if (objective) return `Walk to ${objective.entry.label.replace(/ Nashor$/, "")} with your team`;
  const killer = snapshot.enemies.find((enemy) => enemy.champion === moment.killerChampion);
  if (killer && killer.kills >= killer.deaths + 3) return `Don't meet ${killer.champion} alone — farm the safe side`;
  return "Farm the safe wave and wait for your team";
}

/** Dead: the whole main area becomes the death coach. */
export function DeathView({ snapshot, moment, receivedAt, help, ai, autoNote, onRequest, ask }: DeathCoachProps) {
  const now = useNow(500);
  const remaining = Math.max(0, Math.ceil(moment.respawnIn - (now - receivedAt) / 1000));
  const version = snapshot.dataDragonVersion;
  const envelope = help?.envelope;
  const review = envelope?.review;
  const plan = deathPlan(moment, ai);
  // Full inventory: the buy card's swap (sell X, buy Y) is the shop's answer too.
  const next = planNextBuy(snapshot, ai);
  const swap = !plan.groups.some((group) => group.buys.length) && next?.swap ? { ...next, swap: next.swap } : null;
  const spends = plan.groups.some((group) => group.buys.length) || plan.extras.length > 0;
  const why = review?.urgentSummary || moment.reasons[0] || `${moment.killerChampion || moment.killer} caught you`;
  const onRespawn = review?.nextFiveMinutes[0] || review?.fightPlan[0] || defaultRespawnCall(snapshot, moment);
  const nextGoal = next?.goal?.item || next?.item;
  const elapsed = help?.loading && help.startedAt ? Math.max(0, Math.floor((now - help.startedAt) / 1000)) : 0;

  return (
    <section className="death-view" aria-label="Death coach">
      <div className="death-timer">
        <span><Skull size={20} /> Respawn in</span>
        <strong>{remaining > 0 ? remaining : "GO"}</strong>
        <small>Killed by <b>{moment.killerChampion || moment.killer}</b>{moment.assisters.length > 0 && <> + {moment.assisters.join(", ")}</>}</small>
      </div>

      <div className="death-main">
        <div className="death-shop">
          <div className="death-shop-head">
            <span className="death-label"><CircleDollarSign size={20} /> Shop now</span>
            <span className="death-total">
              {spends ? <><strong>{formatGold(plan.total)}g</strong><small>of {formatGold(moment.goldNow)}g · {formatGold(Math.max(0, moment.goldNow - plan.total))}g left</small></> : <small>you have {formatGold(moment.goldNow)}g</small>}
            </span>
          </div>
          {plan.ai && <p className="death-ai-change"><GitBranch size={16} /> AI changes your build for this game</p>}
          {swap ? (
            <div className="death-goal is-finish">
              <ItemIcon version={version} id={swap.itemId} name={swap.item} size={88} />
              <div className="death-goal-body">
                <small>Swap</small>
                <b>Sell {swap.swap.sellItem} → buy {swap.item}</b>
                <p>{moment.goldNow + swap.swap.sellValue >= swap.cost
                  ? `✓ Affordable now (+${formatGold(swap.swap.sellValue)}g from the sale)`
                  : `${formatGold(swap.cost - moment.goldNow - swap.swap.sellValue)}g more after selling`}</p>
              </div>
            </div>
          ) : plan.groups.length
            ? plan.groups.map((group) => <ShopGroupRow key={group.goal.itemId} group={group} version={version} />)
            : <p className="death-nothing">Nothing useful fits {formatGold(moment.goldNow)}g{nextGoal ? ` — save for ${nextGoal}` : ""}.</p>}
          {plan.extras.length > 0 && (
            <div className="death-extras">
              <span>Also:</span>
              {plan.extras.map((buy, index) => <span key={`${buy.itemId}-${index}`} className="death-part"><ItemIcon version={version} id={buy.itemId} name={buy.item} size={36} />{buy.item} <em>{formatGold(buy.cost)}g</em></span>)}
            </div>
          )}
        </div>

        <p className="death-line death-why"><span>Why you died</span>{why}</p>
        <p className="death-line death-respawn"><span>On respawn</span>{onRespawn}</p>
        {moment.patternNote && <p className="death-pattern-line"><History size={20} />{moment.patternNote}</p>}

        <div className="death-ai-row">
          {envelope ? (
            <small><BrainCircuit size={14} /> AI death read · {helpMeta(envelope)}</small>
          ) : help?.loading ? (
            <small className="is-loading"><LoaderCircle className="spin" size={16} /> Coach is reading this death… {elapsed}s</small>
          ) : help?.error ? (
            <small className="is-error"><TriangleAlert size={14} /> {help.error}<button type="button" onClick={onRequest}><RotateCcw size={13} /> Retry</button></small>
          ) : (
            <small>{autoNote || "AI death read is off."}<button type="button" onClick={onRequest}><Zap size={14} /> Coach this death</button></small>
          )}
        </div>
        {ask}
      </div>
    </section>
  );
}

export function LastDeathNote({ moment, help, onDismiss }: { moment: LiveDeathMoment; help: LiveHelpEnvelope | null; onDismiss: () => void }) {
  const lesson = help?.review.urgentSummary || moment.reasons[0] || moment.patternNote;
  return (
    <div className="last-death-note">
      <Skull size={13} />
      <span>Last death <b>{formatTime(moment.diedAt)}</b> to <b>{moment.killerChampion || moment.killer}</b>{moment.assisters.length ? ` + ${moment.assisters.length}` : ""}</span>
      {lesson && <p>{lesson}</p>}
      <button type="button" onClick={onDismiss} aria-label="Dismiss last death note"><X size={13} /></button>
    </div>
  );
}

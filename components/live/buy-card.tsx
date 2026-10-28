"use client";

import { ArrowRight, Check, GitBranch, Pencil, Shield, ShoppingBag, Sparkles } from "lucide-react";

import { ItemIcon } from "@/components/live/shared";
import type { AiRead } from "@/components/live/use-ai-read";
import { formatGold } from "@/lib/live-coach";
import type { LiveBuildPath, LiveGameSnapshot } from "@/lib/types";

export type BuyPlan = {
  source: "ai" | "build";
  itemId: number;
  item: string;
  cost: number;
  /** The completed item this purchase builds toward, when it is a component. */
  goal: { itemId: number; item: string; cost: number } | null;
  swap: { sellItemId: number; sellItem: string; sellValue: number } | null;
  /** The AI is steering off the build path. */
  deviation: boolean;
};

/**
 * The AI pick that overrides the build path: only a labelled deviation (an off-path item the AI justifies by the enemy
 * team). A plain reorder of path items is ignored, so the death shop and the buy card never disagree on the next item.
 */
export function aiOverride(ai: AiRead | null) {
  const pick = ai?.buys[0];
  return pick?.deviation ? pick : null;
}

/** One concrete next purchase: a live AI build change, else the engine's top recommendation, else the next build step. */
export function planNextBuy(snapshot: LiveGameSnapshot, ai: AiRead | null): BuyPlan | null {
  const pick = aiOverride(ai);
  if (pick) {
    return {
      source: "ai", itemId: pick.itemId, item: pick.item, cost: pick.cost, deviation: pick.deviation, swap: null,
      goal: pick.targetItemId !== pick.itemId ? { itemId: pick.targetItemId, item: pick.targetItem, cost: pick.targetCost } : null,
    };
  }
  const rec = snapshot.recommendations[0];
  if (rec) {
    if (rec.swapPlan) {
      return { source: "build", itemId: rec.itemId, item: rec.item, cost: rec.swapPlan.buyCost || rec.cost, goal: null, deviation: false,
        swap: { sellItemId: rec.swapPlan.sellItemId, sellItem: rec.swapPlan.sellItem, sellValue: rec.swapPlan.sellValue } };
    }
    if (rec.nextStep && rec.nextStep.itemId !== rec.itemId) {
      return { source: "build", itemId: rec.nextStep.itemId, item: rec.nextStep.item, cost: rec.nextStep.cost, swap: null, deviation: false,
        goal: { itemId: rec.itemId, item: rec.item, cost: rec.cost } };
    }
    return { source: "build", itemId: rec.itemId, item: rec.item, cost: rec.nextStep?.cost || rec.cost, goal: null, swap: null, deviation: false };
  }
  const step = snapshot.buildPath?.steps.find((entry) => entry.status === "next");
  return step ? { source: "build", itemId: step.itemId, item: step.item, cost: step.cost, goal: null, swap: null, deviation: false } : null;
}

const SOURCE: Record<LiveBuildPath["source"], string> = {
  pinned: "Pinned build", imported: "Imported build", meta: "Top build", history: "From your games", inventory: "From your items", default: "Default build",
};

export function BuyCard({ snapshot, ai, onEditBuild, compact = false }: { snapshot: LiveGameSnapshot; ai: AiRead | null; onEditBuild: () => void; compact?: boolean }) {
  const version = snapshot.dataDragonVersion;
  const gold = Math.floor(snapshot.activePlayer.currentGold);
  const plan = planNextBuy(snapshot, ai);
  const available = gold + (plan?.swap?.sellValue ?? 0);
  const affordable = plan ? plan.cost <= 0 || available >= plan.cost : false;
  const needed = plan ? Math.max(0, plan.cost - available) : 0;
  const pct = plan && plan.cost > 0 ? Math.min(100, available / plan.cost * 100) : 100;
  const tone = affordable ? "go" : pct >= 70 ? "soon" : "save";
  // Only when an enemy signal changed the next buy (e.g. Lord Dominik's Regards because their armor is stacking).
  const rec0 = snapshot.recommendations[0];
  const counter = plan?.source === "build" && rec0?.counterReason && (plan.itemId === rec0.itemId || plan.goal?.itemId === rec0.itemId) ? rec0.counterReason : null;

  return (
    <article className={`live-card buy-card buy-${tone} ${compact ? "is-compact" : ""}`} aria-label="What to buy next">
      <header className="live-card-head">
        <span className="live-card-eyebrow"><ShoppingBag size={18} /> Buy next</span>
        {plan?.source === "ai"
          ? <span className="buy-source is-ai"><Sparkles size={14} /> AI pick{ai ? ` · ${ai.label}` : ""}</span>
          : <BuildSource path={snapshot.buildPath} />}
      </header>

      {plan ? (
        <>
          <div className="buy-hero">
            <span className="buy-hero-icon"><ItemIcon version={version} id={plan.itemId} name={plan.item} size={96} /></span>
            <div className="buy-hero-text">
              <h2 className="buy-name">{plan.item}</h2>
              {plan.swap ? (
                <p className="buy-swap"><b>SELL</b> {plan.swap.sellItem} <ArrowRight size={18} /> <b>BUY</b> {plan.item}</p>
              ) : plan.goal ? (
                <p className="buy-goal">toward <ItemIcon version={version} id={plan.goal.itemId} name={plan.goal.item} size={26} /> <b>{plan.goal.item}</b></p>
              ) : <p className="buy-goal">{plan.cost > 0 ? `${formatGold(plan.cost)}g` : ""}</p>}
              {plan.deviation && <span className="buy-deviation"><GitBranch size={13} /> Changes your build</span>}
              {counter && <p className="buy-counter" title="Estimated from the enemies' level and items"><Shield size={15} /> {counter}</p>}
            </div>
          </div>

          <div className="buy-gold">
            <div className="buy-gold-label">
              {affordable
                ? <strong className="buy-now"><Check size={22} strokeWidth={3} /> BUY NOW · {plan.item}</strong>
                : <strong className="buy-togo">{formatGold(needed)}g to go</strong>}
              <span>{formatGold(available)} / {formatGold(plan.cost)}g{plan.swap ? " after selling" : ""}</span>
            </div>
            <div className="buy-gold-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Gold toward next buy">
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        </>
      ) : (
        <p className="buy-empty">No purchase to recommend yet — pin your build in Details.</p>
      )}

      <BuildPathRow path={snapshot.buildPath} version={version} onEdit={onEditBuild} />
    </article>
  );
}

/** "Top build · researched 16.20 (op.gg, lolalytics)" / "Top build · curated 16.20"; other sources keep their short label. */
function BuildSource({ path }: { path: LiveBuildPath | undefined }) {
  const base = path ? SOURCE[path.source] ?? "Your build" : "Your build";
  const text = path?.source === "meta" && path.meta ? `${base} · ${path.meta.label}` : base;
  return <span className={`buy-source${path?.meta ? " is-meta" : ""}`} title={path?.label ? `${text} — ${path.label}` : text}>{text}</span>;
}

function BuildPathRow({ path, version, onEdit }: { path: LiveBuildPath | undefined; version: string; onEdit: () => void }) {
  // Locked (skipped) pinned/imported steps are explained in Details; the main row shows only buyable steps.
  const steps = (path?.steps ?? []).filter((step) => step.status !== "skipped");
  const nextAt = steps.findIndex((step) => step.status === "next");
  const next = nextAt >= 0 ? steps[nextAt] : null;
  const then = next ? steps.slice(nextAt + 1).find((step) => step.status !== "owned") : null;
  return (
    <div className="path-block">
      {next && (
        <p className="path-next">
          <span>Next item</span> <b>{next.item}</b> <em>{formatGold(next.cost)}g</em>
          {then && <> <ArrowRight size={15} /> <span>then</span> {then.item}</>}
        </p>
      )}
      <div className="path-row">
        <ol aria-label="Your build path">
          {steps.map((step, index) => (
            <li key={`${step.itemId}-${index}`} className={`path-step step-${step.status}`}>
              <ItemIcon version={version} id={step.itemId} name={`${step.item} · ${formatGold(step.cost)}g${step.status === "owned" ? " · owned" : step.status === "next" ? " · next" : ""}`} size={48} />
              {step.status === "owned" && <span className="path-check" aria-label="owned"><Check size={13} strokeWidth={3.5} /></span>}
            </li>
          ))}
          {!steps.length && <li className="path-empty">No build path yet</li>}
        </ol>
        <button type="button" className="path-edit" onClick={onEdit} title="Pin or edit your build (opens Details)"><Pencil size={14} /> Edit</button>
      </div>
    </div>
  );
}

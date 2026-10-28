"use client";

import { useMemo } from "react";
import { ChevronRight, GitBranch, History, RotateCcw, Sparkles, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { BuildPathStrip } from "@/components/live/build-path";
import { formatTime, ItemIcon, itemImage, ItemStrip } from "@/components/live/shared";
import type { AiRead } from "@/components/live/use-ai-read";
import type { ItemCatalog } from "@/components/live/use-item-catalog";
import { getItemUsageTip } from "@/lib/item-synergy";
import type { LiveGameSnapshot, LiveRecommendation, LiveResolvedBuy } from "@/lib/types";

type BuildPanelProps = {
  snapshot: LiveGameSnapshot;
  /** Newest AI read for this game (manual, death or pregame) with its freshness, or null. */
  ai: AiRead | null;
  catalog: ItemCatalog | null;
  mock: boolean;
  asking: boolean;
  onAsk: () => void;
};

/** Full build read for the Details drawer: build path editor, top 3 picks with reasons, boots checkpoint, owned-item combos. */
export function BuildPanel({ snapshot, ai, catalog, mock, asking, onAsk }: BuildPanelProps) {
  const active = snapshot.activePlayer;
  const version = snapshot.dataDragonVersion;
  const help = ai?.help ?? null;
  const live = ai && !ai.expired ? ai : null;

  const ownedItemTips = useMemo(() => active.items.flatMap((item) => {
    const tip = getItemUsageTip(active.champion, item.name);
    return tip ? [{ item, tip }] : [];
  }).slice(0, 3), [active.items, active.champion]);

  const mobility = snapshot.mobilityRecommendation;

  return (
    <article className="live-panel recommendation-panel" id="live-build-panel">
      <div className="live-panel-title">
        <div><span className="eyebrow">Adaptive build read</span><h2>What to consider next</h2></div>
        {live
          ? <Badge tone="info"><Sparkles size={11} /> AI · {live.label} · {formatTime(live.age ?? 0)} ago</Badge>
          : <Badge tone="good">Local logic · follows your build</Badge>}
      </div>
      <BuildPathStrip snapshot={snapshot} catalog={catalog} mock={mock} />
      {live && help && <p className="recommendation-ai-summary"><Sparkles size={12} />{help.review.urgentSummary}</p>}
      {ai?.expired && help && (
        <p className="recommendation-ai-outdated">
          <History size={12} />
          <span>AI {ai.label} from {formatTime(help.gameTime ?? 0)} — outdated ({ai.expired}). Showing local picks.</span>
          <button type="button" onClick={onAsk} disabled={asking}><RotateCcw size={11} /> {asking ? "Asking…" : "Ask again"}</button>
        </p>
      )}
      <div className="recommendation-list">
        {live
          ? live.buys.map((buy, index) => <AiCard key={`${buy.itemId}-${buy.targetItemId}-${index}`} buy={buy} index={index} version={version} champion={active.champion} gold={active.currentGold} />)
          : snapshot.recommendations.slice(0, 3).map((recommendation, index) => <LocalCard key={`${recommendation.item}-${index}`} recommendation={recommendation} index={index} version={version} gold={active.currentGold} />)}
      </div>
      {mobility && (
        <article className="mobility-checkpoint">
          <img src={itemImage(version, mobility.itemId)} alt="" />
          <div>
            <span>Boots checkpoint · {mobility.action} · whole-team read</span>
            <h3>{mobility.item} <small>{mobility.cost}g total</small></h3>
            <p>{mobility.reason}</p>
            {mobility.nextStep && <strong>{mobility.nextStep.affordable ? "Affordable now" : `Need ${mobility.nextStep.goldNeeded}g`}: {mobility.nextStep.item} · {mobility.nextStep.cost}g</strong>}
            {mobility.swapPlan && <strong>Sell {mobility.swapPlan.sellItem} (+{mobility.swapPlan.sellValue}g) → buy {mobility.item} · {mobility.swapPlan.affordable ? `${mobility.swapPlan.goldAfter}g left` : `need ${mobility.swapPlan.goldNeeded}g more`}</strong>}
            <small>{mobility.trigger}</small>
          </div>
        </article>
      )}
      <div className="current-build"><span>Current build</span><ItemStrip items={active.items} version={version} champion={active.champion} /></div>
      {ownedItemTips.length > 0 && (
        <div className="owned-item-tricks">
          <div><Zap size={12} /><span>Combos from items you own</span></div>
          <section>{ownedItemTips.map(({ item, tip }) => <p key={`${item.id}-${item.name}`}><strong>{item.name}</strong><span>{tip}</span></p>)}</section>
        </div>
      )}
    </article>
  );
}

function AiCard({ buy, index, version, champion, gold }: { buy: LiveResolvedBuy; index: number; version: string; champion: string; gold: number }) {
  const component = buy.itemId !== buy.targetItemId;
  const priority = buy.timing === "next-recall" ? "primary" : buy.timing === "first-item-goal" ? "situational" : "defensive";
  const usageTip = getItemUsageTip(champion, buy.targetItem);
  const reason = buy.reason.replace(/^changes your build:\s*/i, "");
  return (
    <article className={`recommendation recommendation-${priority} recommendation-ai ${buy.deviation ? "recommendation-deviation" : ""}`}>
      <ItemIcon version={version} id={buy.itemId} name={buy.item} size={58} />
      <div>
        <span>{index + 1}. AI · {buy.timing.replaceAll("-", " ")}</span>
        {buy.deviation && <em className="deviation-tag"><GitBranch size={10} /> Changes your build</em>}
        <h3>{buy.item} <small>{buy.cost}g{component ? " now" : ""}</small></h3>
        {component && (
          <p className="recommendation-toward"><ItemIcon version={version} id={buy.targetItemId} name={buy.targetItem} size={18} />toward <b>{buy.targetItem}</b> · {buy.targetCost}g</p>
        )}
        <p>{reason}</p>
        <div className={`next-purchase ${buy.affordable ? "can-buy" : "save-for"}`}>
          <img src={itemImage(version, buy.itemId)} alt="" />
          <span>
            <b>{buy.affordable ? index === 0 ? "BEST BUY THIS RECALL" : "AFFORDABLE NOW" : "SAVE FOR"}: {buy.item} · {buy.cost}g</b>
            <small>{buy.affordable ? `${Math.max(0, Math.floor(gold - buy.cost))}g left after purchase` : `Need ${buy.goldNeeded}g more`}</small>
          </span>
        </div>
        {usageTip && <small className="recommendation-usage"><Zap size={11} /><strong>Use it:</strong> {usageTip}</small>}
      </div>
    </article>
  );
}

function LocalCard({ recommendation, index, version, gold }: { recommendation: LiveRecommendation; index: number; version: string; gold: number }) {
  return (
    <article className={`recommendation recommendation-${recommendation.priority}`}>
      {recommendation.itemId ? <img src={itemImage(version, recommendation.itemId)} alt="" /> : <div className="recommendation-icon-fallback">{recommendation.item.slice(0, 2).toUpperCase()}</div>}
      <div>
        <span>{index + 1}. {recommendation.action} · {recommendation.timing.replaceAll("-", " ")}</span>
        <h3>{recommendation.item} <small>{recommendation.cost ? `${recommendation.cost}g total` : "cost unavailable"}</small></h3>
        <p>{recommendation.reason}</p>
        {recommendation.nextStep && (
          <div className={`next-purchase ${recommendation.nextStep.affordable ? "can-buy" : "save-for"}`}>
            <img src={itemImage(version, recommendation.nextStep.itemId)} alt="" />
            <span><b>{recommendation.nextStep.affordable ? index === 0 ? "BEST BUY THIS RECALL" : "IF YOU CHOOSE THIS PATH" : "NEXT RECIPE PIECE"}: {recommendation.nextStep.item} · {recommendation.nextStep.cost}g</b><small>{recommendation.nextStep.affordable ? `${Math.floor(gold - recommendation.nextStep.cost)}g left after purchase` : `Need ${recommendation.nextStep.goldNeeded}g more`}</small></span>
          </div>
        )}
        {recommendation.swapPlan && (
          <div className={`swap-plan ${recommendation.swapPlan.affordable ? "can-swap" : "save-swap"}`}>
            <div>
              <img src={itemImage(version, recommendation.swapPlan.sellItemId)} alt="" />
              <ChevronRight size={14} />
              <img src={itemImage(version, recommendation.itemId)} alt="" />
            </div>
            <span>
              <b>SELL {recommendation.swapPlan.sellItem} +{recommendation.swapPlan.sellValue}g → BUY {recommendation.item} {recommendation.swapPlan.buyCost}g</b>
              <small>{recommendation.swapPlan.affordable ? `Affordable now · ${recommendation.swapPlan.goldAfter}g left` : `Need ${recommendation.swapPlan.goldNeeded}g more after the sale`} · {recommendation.swapPlan.rationale}</small>
            </span>
          </div>
        )}
        <small><ChevronRight size={11} />{recommendation.trigger}</small>
        {recommendation.usageTip && <small className="recommendation-usage"><Zap size={11} /><strong>Use it:</strong> {recommendation.usageTip}</small>}
      </div>
    </article>
  );
}

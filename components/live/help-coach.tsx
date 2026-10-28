"use client";

import { BrainCircuit, ChevronRight, History, LoaderCircle, ScanSearch, ShieldAlert, Sparkles, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { helpMeta, useNow } from "@/components/live/shared";
import type { HelpSlot } from "@/components/live/use-live-help";
import type { LiveGameSnapshot, LiveHelpEnvelope } from "@/lib/types";

type HelpCardProps = {
  snapshot: LiveGameSnapshot;
  slot: HelpSlot;
  question: string;
  onQuestion: (value: string) => void;
  onAsk: (mode: "fast" | "deep") => void;
};

export function HelpCard({ snapshot, slot, question, onQuestion, onAsk }: HelpCardProps) {
  const active = snapshot.activePlayer;
  const now = useNow(1000, slot.loading);
  const elapsed = slot.loading && slot.startedAt ? Math.max(0, Math.floor((now - slot.startedAt) / 1000)) : 0;
  return (
    <article className="help-card">
      <div className="help-orb"><BrainCircuit size={27} /></div>
      <span className="eyebrow">On-demand AI coach</span>
      <h2>Ask the coach a question</h2>
      <p>Ask about a problem you feel in-game. The coach keeps your current build path unless a branch genuinely solves it.</p>
      <label className="coach-question">
        <span>What feels wrong?</span>
        <textarea
          value={question}
          maxLength={500}
          rows={3}
          placeholder="e.g. I keep running out of mana — should I change the build?"
          onChange={(event) => onQuestion(event.target.value)}
          onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") onAsk("fast"); }}
        />
        <small>{active.maxResource > 0 ? `Resource now: ${Math.floor(active.resource)} / ${Math.floor(active.maxResource)} · ` : ""}{question.length}/500 · Ctrl+Enter to ask</small>
      </label>
      <div className="help-actions">
        <Button className="help-button" onClick={() => onAsk("fast")} disabled={slot.loading}>
          {slot.loading && slot.mode === "fast" ? <LoaderCircle className="spin" size={19} /> : <Zap size={19} />}
          {slot.loading && slot.mode === "fast" ? `READING… ${elapsed}s` : question.trim() ? "ASK THIS" : "ASK COACH"}
        </Button>
        <Button variant="ghost" className="deep-button" onClick={() => onAsk("deep")} disabled={slot.loading} title="Slower, more thorough read">
          {slot.loading && slot.mode === "deep" ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}
          {slot.loading && slot.mode === "deep" ? `${elapsed}s` : "Deep read"}
        </Button>
      </div>
      <small>{slot.envelope ? `${helpMeta(slot.envelope)} · ${slot.envelope.model} · ${new Date(slot.envelope.generatedAt).toLocaleTimeString()}` : `Fast by default · Riot patch ${snapshot.dataDragonVersion} · cached per state`}</small>
    </article>
  );
}

export function AiRead({ help }: { help: LiveHelpEnvelope }) {
  const review = help.review;
  const enemyPlan = review.enemyPlan?.length
    ? review.enemyPlan
    : [{ champion: review.biggestThreat.champion, priority: "avoid" as const, reason: review.biggestThreat.reason, response: review.biggestThreat.response }];
  return (
    <section className="live-ai-read">
      <div className="ai-read-head">
        <div><Badge tone="info"><Sparkles size={11} /> AI read</Badge><h2>{review.urgentSummary}</h2></div>
        <span>{helpMeta(help)} · {help.model}</span>
      </div>
      {review.historyCallout && <p className="history-callout history-callout-large"><History size={15} />{review.historyCallout}</p>}
      {review.userResponse.question && (
        <div className="ai-user-answer">
          <span>Your question</span>
          <strong>{review.userResponse.question}</strong>
          <p>{review.userResponse.answer}</p>
        </div>
      )}
      <div className="ai-build-path">
        <div><span>Current path</span><strong>{review.buildPath.currentPath}</strong></div>
        <ChevronRight size={18} />
        <div><span>{review.buildPath.deviation}</span><strong>{review.buildPath.recommendedPath.join(" → ")}</strong><small>{review.buildPath.reason}</small></div>
      </div>
      <div className="ai-read-grid">
        <article><span>Enemy priority</span>{enemyPlan.map((enemy) => <div className="enemy-plan-line" key={`${enemy.priority}-${enemy.champion}`}><b>{enemy.champion} · {enemy.priority}</b><small>{enemy.reason}</small><strong>{enemy.response}</strong></div>)}</article>
        <article><span>Buy choices</span>{Array.isArray(help.buys)
          ? help.buys.map((buy) => <div className="ai-line" key={`${buy.timing}-${buy.itemId}-${buy.targetItemId}`}><b>{buy.item} <small>{buy.cost}g</small>{buy.deviation && <em className="deviation-tag">Changes your build</em>}</b><small>{buy.targetItemId !== buy.itemId ? `toward ${buy.targetItem} · ` : ""}{buy.timing.replaceAll("-", " ")} · {buy.reason}</small></div>)
          : review.buyOptions.map((option) => <div className="ai-line" key={`${option.timing}-${option.targetItem || option.item}-${option.item}`}><b>{option.item}</b><small>{option.targetItem && option.targetItem !== option.item ? `toward ${option.targetItem} · ` : ""}{option.timing.replaceAll("-", " ")} · {option.reason}</small></div>)}
          {Array.isArray(help.buys) && help.buys.length < review.buyOptions.length && <div className="ai-line"><small>{review.buyOptions.length - help.buys.length} AI pick(s) dropped by validation (unknown, owned, duplicate or avoided item).</small></div>}</article>
        <article><span>Next five minutes</span><ol>{review.nextFiveMinutes.map((line) => <li key={line}>{line}</li>)}</ol></article>
        <article><span>Fight plan</span><ol>{review.fightPlan.map((line) => <li key={line}>{line}</li>)}</ol></article>
      </div>
      {review.warnings.length > 0 && <p className="ai-warning"><ShieldAlert size={13} />{review.warnings.join(" · ")}</p>}
    </section>
  );
}

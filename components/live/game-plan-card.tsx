"use client";

import { useState } from "react";
import { ChevronDown, Compass, History, LoaderCircle, RotateCcw, TriangleAlert, Zap } from "lucide-react";

import { helpMeta, useNow } from "@/components/live/shared";
import type { HelpSlot } from "@/components/live/use-live-help";

const PRIORITY_LABEL = { avoid: "Fear", focus: "Focus", watch: "Watch" } as const;

export function GamePlanCard({ slot, autoNote, onRequest }: { slot: HelpSlot; autoNote: string | null; onRequest: () => void }) {
  const [open, setOpen] = useState(true);
  const now = useNow(1000, slot.loading);
  const review = slot.envelope?.review;
  const buys = slot.envelope?.buys;
  const firstBuys = (Array.isArray(buys) ? buys.map((buy) => buy.targetItemId === buy.itemId ? buy.item : `${buy.item} (${buy.targetItem})`) : review?.buyOptions.map((option) => option.item) ?? []).slice(0, 3);
  const elapsed = slot.loading && slot.startedAt ? Math.max(0, Math.floor((now - slot.startedAt) / 1000)) : 0;

  return (
    <article className={`live-panel game-plan-card ${open ? "" : "is-collapsed"}`}>
      <button type="button" className="game-plan-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Compass size={17} />
        <div><span className="eyebrow">Loading screen</span><h2>Game plan</h2></div>
        {slot.envelope && <small>{helpMeta(slot.envelope)}</small>}
        <ChevronDown size={16} className="game-plan-chevron" />
      </button>
      {open && (
        <div className="game-plan-body">
          {review ? (
            <>
              <p className="game-plan-summary">{review.urgentSummary}</p>
              {review.historyCallout && <p className="history-callout"><History size={13} />{review.historyCallout}</p>}
              <div className="game-plan-grid">
                {review.nextFiveMinutes.length > 0 && <div><span>Lane plan</span><ol>{review.nextFiveMinutes.slice(0, 4).map((line) => <li key={line}>{line}</li>)}</ol></div>}
                {review.enemyPlan.length > 0 && (
                  <div><span>Fear / focus</span>
                    {review.enemyPlan.slice(0, 4).map((enemy) => (
                      <p key={`${enemy.priority}-${enemy.champion}`} className={`plan-enemy plan-${enemy.priority}`}><b>{PRIORITY_LABEL[enemy.priority] || enemy.priority} · {enemy.champion}</b><small>{enemy.response}</small></p>
                    ))}
                  </div>
                )}
              </div>
              {firstBuys.length > 0 && <p className="game-plan-buys"><b>First buys:</b> {firstBuys.join(" → ")}</p>}
            </>
          ) : slot.loading ? (
            <p className="death-ai-loading"><LoaderCircle className="spin" size={15} /> Building your game plan from history and both comps… {elapsed}s</p>
          ) : slot.error ? (
            <p className="death-ai-error"><TriangleAlert size={13} />{slot.error}<button type="button" onClick={onRequest}><RotateCcw size={11} /> Retry</button></p>
          ) : (
            <p className="death-ai-idle"><span>{autoNote || "Get a lane + team plan for this draft."}</span><button type="button" onClick={onRequest}><Zap size={12} /> Get game plan</button></p>
          )}
        </div>
      )}
    </article>
  );
}

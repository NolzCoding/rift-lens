"use client";

import { Check, LoaderCircle, MessageCircle, Sparkles, TriangleAlert, X, Zap } from "lucide-react";

import { helpMeta, useNow } from "@/components/live/shared";
import type { HelpSlot } from "@/components/live/use-live-help";
import type { CoachVerdicts, Verdict } from "@/lib/live-coach";

function VerdictLine({ verdict }: { verdict: Verdict }) {
  const good = verdict.tone === "good";
  return (
    <li className={`verdict verdict-${verdict.tone}`}>
      <span className="verdict-mark" aria-label={good ? "Doing well" : "Fix this"}>{good ? <Check size={22} strokeWidth={3} /> : <X size={22} strokeWidth={3} />}</span>
      <div>
        <b>{verdict.headline}</b>
        {verdict.detail && <span>{verdict.detail}</span>}
      </div>
    </li>
  );
}

export type AskProps = { slot: HelpSlot; question: string; onQuestion: (value: string) => void; onAsk: () => void };

/**
 * Type-and-ask box on the main view: Enter or the button asks the coach (fast read with the question as userFocus).
 * Empty box = a general read of this moment. The answer to the last question shows right under it.
 */
export function AskBox({ slot, question, onQuestion, onAsk }: AskProps) {
  const now = useNow(1000, slot.loading);
  const elapsed = slot.loading && slot.startedAt ? Math.max(0, Math.floor((now - slot.startedAt) / 1000)) : 0;
  const reply = slot.envelope?.review.userResponse;
  const answered = reply?.question?.trim() && reply.answer?.trim() ? reply : null;
  return (
    <div className="ask-coach">
      <form className="ask-box" onSubmit={(event) => { event.preventDefault(); if (!slot.loading) onAsk(); }}>
        <input
          value={question}
          maxLength={500}
          onChange={(event) => onQuestion(event.target.value)}
          placeholder="Ask anything… e.g. why do I keep losing half my HP?"
          aria-label="Ask the coach"
        />
        <button type="submit" className="ask-coach-button" disabled={slot.loading} aria-busy={slot.loading}>
          {slot.loading ? <LoaderCircle className="spin" size={22} /> : <Zap size={22} />}
          {slot.loading ? `${elapsed}s` : question.trim() ? "Ask" : "Ask coach"}
        </button>
      </form>
      {answered && !slot.loading && (
        <div className="ask-answer">
          <small>You asked: {answered.question}</small>
          <p>{answered.answer}</p>
        </div>
      )}
      <small className={slot.error ? "ask-coach-error" : ""}>
        {slot.error ? <><TriangleAlert size={13} /> {slot.error}</> : slot.loading ? "Coach is reading the game…" : slot.envelope ? `Last read: ${helpMeta(slot.envelope)}` : "Type a question, or just press Ask coach for a read of this moment"}
      </small>
    </div>
  );
}

export function CoachCard({ verdicts, aiLine, ask }: { verdicts: CoachVerdicts; aiLine: string | null; ask: AskProps }) {
  const empty = !verdicts.good.length && !verdicts.fix.length;
  return (
    <article className="live-card coach-card" aria-label="How you're doing">
      <header className="live-card-head">
        <span className="live-card-eyebrow"><MessageCircle size={18} /> How you&apos;re doing</span>
      </header>
      <div className="verdict-area">
        {empty ? (
          <p className="verdict-empty">Nothing to call yet — play your lane, the coach is watching.</p>
        ) : (
          <>
            {verdicts.good.length > 0 && <ul className="verdict-list">{verdicts.good.map((verdict) => <VerdictLine key={verdict.id} verdict={verdict} />)}</ul>}
            {verdicts.fix.length > 0 && <ul className="verdict-list">{verdicts.fix.map((verdict) => <VerdictLine key={verdict.id} verdict={verdict} />)}</ul>}
          </>
        )}
      </div>
      {aiLine && <p className="coach-says"><Sparkles size={18} /><span><b>Coach says</b> {aiLine}</span></p>}
      <AskBox {...ask} />
    </article>
  );
}

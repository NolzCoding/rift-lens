"use client";

import { Brain, Check, Crown, ShieldX, X } from "lucide-react";

import { formatTime } from "@/components/live/shared";
import type { CoachVerdicts, Verdict } from "@/lib/live-coach";
import type { LiveGameSnapshot } from "@/lib/types";

/** Game over: the result and the 1–2 biggest takeaways from the coach verdicts. */
export function GameOverView({ snapshot, verdicts }: { snapshot: LiveGameSnapshot; verdicts: CoachVerdicts }) {
  const win = snapshot.gameResult === "win";
  const me = snapshot.activePlayer;
  const takeaways = [verdicts.fix[0], verdicts.good[0]].filter((verdict): verdict is Verdict => Boolean(verdict));
  return (
    <section className={`over-view ${win ? "is-win" : "is-loss"}`} aria-label="Game over">
      <div className="over-result">
        {win ? <Crown size={44} /> : <ShieldX size={44} />}
        <strong>{win ? "Victory" : "Defeat"}</strong>
        <small>{me.champion} · {me.kills}/{me.deaths}/{me.assists} · {formatTime(snapshot.game.time)}</small>
      </div>
      <div className="over-takeaways">
        <span className="live-card-eyebrow">Take this into next game</span>
        {takeaways.length ? (
          <ul className="verdict-list">
            {takeaways.map((verdict) => (
              <li key={verdict.id} className={`verdict verdict-${verdict.tone}`}>
                <span className="verdict-mark">{verdict.tone === "good" ? <Check size={22} strokeWidth={3} /> : <X size={22} strokeWidth={3} />}</span>
                <div><b>{verdict.headline}</b>{verdict.detail && <span>{verdict.detail}</span>}</div>
              </li>
            ))}
          </ul>
        ) : <p className="verdict-empty">No clear takeaways from this one — check the full review.</p>}
        <a className="over-link" href="/profile"><Brain size={16} /> Open Memory — this game is being recorded</a>
      </div>
    </section>
  );
}

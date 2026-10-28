"use client";

import { Compass, Crosshair, LoaderCircle, RotateCcw, Swords, TriangleAlert, Zap } from "lucide-react";

import { helpMeta, useNow } from "@/components/live/shared";
import type { HelpSlot } from "@/components/live/use-live-help";
import type { LiveGameSnapshot, LivePlayer } from "@/lib/types";

const ROLE_LINE: Array<[string, string]> = [
  ["Assassin", "can burst you — keep Flash for them"],
  ["Fighter", "dives you — kite back, never stand still"],
  ["Tank", "engages — stay behind your front line"],
  ["Mage", "pokes — dodge, then fight after their combo"],
  ["Marksman", "scales too — win the early trades"],
  ["Support", "lands picks — stay behind your minions"],
];

const roleLine = (player: LivePlayer) => ROLE_LINE.find(([role]) => player.roles.includes(role))?.[1] ?? "watch their cooldowns before you trade";
const firstClause = (text: string) => text.split(/(?<=[.!?])\s/)[0].replace(/[.]$/, "");

/** Loading screen / first ~90s: lane, biggest threat and the AI plan's top 3 bullets. */
export function PlanCard({ snapshot, slot, autoNote, onRequest }: { snapshot: LiveGameSnapshot; slot: HelpSlot; autoNote: string | null; onRequest: () => void }) {
  const now = useNow(1000, slot.loading);
  const review = slot.envelope?.review;
  const opponent = snapshot.laneOpponent;
  const brief = snapshot.playerBrief;

  const laneAi = opponent ? review?.enemyPlan.find((entry) => entry.champion === opponent.champion)?.response : null;
  const lane = opponent ? laneAi || (brief?.matchupNote ? firstClause(brief.matchupNote) : roleLine(opponent)) : null;

  // The lane line already covers the lane opponent, so "Threat" names someone else when it can.
  const others = [...snapshot.enemies].filter((enemy) => enemy.champion !== opponent?.champion).sort((a, b) => b.threatScore - a.threatScore);
  const aiThreat = review?.biggestThreat.champion && review.biggestThreat.champion !== opponent?.champion ? review.biggestThreat : null;
  const threatName = aiThreat?.champion || others[0]?.champion || null;
  const threatPlayer = snapshot.enemies.find((enemy) => enemy.champion === threatName);
  const killerNote = threatName ? brief?.killerNotes.find((note) => note.includes(threatName)) : null;
  const threat = aiThreat?.response || (killerNote ? firstClause(killerNote) : threatPlayer ? roleLine(threatPlayer) : null);

  const bullets = review ? [...review.nextFiveMinutes, ...review.fightPlan].filter(Boolean).slice(0, 3) : [];
  const elapsed = slot.loading && slot.startedAt ? Math.max(0, Math.floor((now - slot.startedAt) / 1000)) : 0;

  return (
    <article className="live-card plan-card" aria-label="Game plan">
      <header className="live-card-head">
        <span className="live-card-eyebrow"><Compass size={18} /> Game plan</span>
        {slot.envelope && <small className="live-card-meta">{helpMeta(slot.envelope)}</small>}
      </header>
      <div className="plan-lines">
        {opponent && <p><span><Swords size={18} /> Lane</span><b>{opponent.champion}</b> — {lane}</p>}
        {threatName && <p className="plan-threat"><span><Crosshair size={18} /> Threat</span><b>{threatName}</b> — {threat}</p>}
      </div>
      <div className="plan-ai">
        {bullets.length > 0 ? (
          <ol>{bullets.map((line) => <li key={line}>{line}</li>)}</ol>
        ) : slot.loading ? (
          <p className="plan-status"><LoaderCircle className="spin" size={20} /> Building your plan from history and both comps… {elapsed}s</p>
        ) : slot.error ? (
          <p className="plan-status is-error"><TriangleAlert size={18} /> {slot.error}<button type="button" onClick={onRequest}><RotateCcw size={14} /> Retry</button></p>
        ) : (
          <p className="plan-status"><span>{autoNote || "Get a lane + team plan for this draft."}</span><button type="button" onClick={onRequest}><Zap size={16} /> Get game plan</button></p>
        )}
      </div>
    </article>
  );
}

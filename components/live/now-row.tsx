"use client";

import { CircleAlert, Clock3, Coins, Flame, Sparkles, Target, Zap } from "lucide-react";

import { formatTime } from "@/components/live/shared";
import { useGameClock } from "@/components/live/top-bar";
import { nextObjectives, nowCall, objectiveRemaining, type NowCall, type RecentAlert } from "@/lib/live-coach";
import type { LiveGameSnapshot } from "@/lib/types";

const ICON: Record<NowCall["source"], typeof Zap> = {
  death: CircleAlert, soul: Flame, objective: Target, spike: CircleAlert, ai: Sparkles, buy: Coins, default: Zap,
};

/** "What should I do right now?" — one big line plus the next two objective timers. */
export function NowRow({ snapshot, receivedAt, mock, alerts, aiSummary }: {
  snapshot: LiveGameSnapshot; receivedAt: number; mock: boolean; alerts: RecentAlert[]; aiSummary: string | null;
}) {
  const time = useGameClock(snapshot, receivedAt, mock);
  const call = nowCall(snapshot, { time: Math.floor(time), alerts, aiSummary });
  const chips = nextObjectives(snapshot, time, 2);
  const Icon = ICON[call.source] ?? Zap;
  const soul = snapshot.dragonState?.soulPoint;
  return (
    <section className="now-row" aria-label="Do this now">
      <div className={`now-line now-${call.tone}`}>
        <Icon size={30} aria-hidden />
        <span>{call.text}</span>
      </div>
      {chips.length > 0 && (
        <div className="now-chips">
          {chips.map((objective) => {
            const remaining = objectiveRemaining(objective, time) ?? 0;
            const up = remaining <= 0;
            const enemySoul = objective.id === "dragon" && (soul === "enemy" || soul === "both");
            const tone = enemySoul && remaining <= 90 ? "danger" : up ? "up" : remaining <= 60 ? "soon" : "later";
            return (
              <div key={objective.id} className={`objective-timer timer-${tone}`} title={objective.note || objective.label}>
                <span>{objective.label.replace(/ Nashor$/, "")}{enemySoul ? " · enemy soul" : soul === "ally" && objective.id === "dragon" ? " · your soul" : ""}</span>
                <strong>{up ? "UP" : formatTime(remaining)}</strong>
              </div>
            );
          })}
        </div>
      )}
      {chips.length === 0 && <div className="now-chips now-chips-empty"><Clock3 size={16} /> No timers yet</div>}
    </section>
  );
}

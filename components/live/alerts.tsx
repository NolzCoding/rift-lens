"use client";

import { useEffect } from "react";
import { Bell, Coins, Crown, Flame, Shield, Swords, Target, TrendingUp, X } from "lucide-react";

import { formatTime } from "@/components/live/shared";
import type { LiveAlert, LiveAlertKind } from "@/lib/live-alerts";

export type AlertEntry = { alert: LiveAlert; gameTime: number; at: number };

const ICONS: Record<LiveAlertKind, typeof Bell> = {
  objective: Target, soul: Flame, "enemy-level": TrendingUp, "enemy-item": Swords, "enemy-resist": Shield, afford: Coins, focus: Target, result: Crown,
};

function Toast({ entry, onDismiss }: { entry: AlertEntry; onDismiss: (id: string) => void }) {
  const { alert } = entry;
  useEffect(() => {
    const id = window.setTimeout(() => onDismiss(alert.id), alert.priority === "high" ? 12000 : 8000);
    return () => window.clearTimeout(id);
  }, [alert.id, alert.priority, onDismiss]);
  const Icon = ICONS[alert.kind] || Bell;
  return (
    <div className={`live-toast toast-${alert.priority} toast-${alert.kind}`} role="status">
      <Icon size={26} />
      <span>{alert.text}</span>
      <button type="button" onClick={() => onDismiss(alert.id)} aria-label="Dismiss alert"><X size={18} /></button>
    </div>
  );
}

/** Only high-priority alerts reach here (the dashboard filters); at most 2 on screen, newest last. */
export function AlertToasts({ toasts, onDismiss }: { toasts: AlertEntry[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return <div className="live-toasts" aria-live="polite">{toasts.slice(-2).map((entry) => <Toast key={entry.alert.id} entry={entry} onDismiss={onDismiss} />)}</div>;
}

export function AlertLog({ entries }: { entries: AlertEntry[] }) {
  return (
    <article className="live-panel alert-log">
      <div className="live-panel-title"><div><span className="eyebrow">Alert log</span><h2>Timers & spikes</h2></div><Bell size={18} /></div>
      {entries.length ? [...entries].reverse().slice(0, 12).map((entry) => {
        const Icon = ICONS[entry.alert.kind] || Bell;
        return <div className={`live-event alert-log-row alert-${entry.alert.priority}`} key={entry.alert.id}><time>{formatTime(entry.gameTime)}</time><span><Icon size={12} />{entry.alert.text}</span></div>;
      }) : <p className="quiet-copy">Objective timers, enemy level spikes, big items and buy windows show up here.</p>}
    </article>
  );
}

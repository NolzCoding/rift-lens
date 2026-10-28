"use client";

import { ChevronRight, Crosshair, ShieldAlert } from "lucide-react";

import { formatTime } from "@/components/live/shared";
import type { LiveGameSnapshot } from "@/lib/types";

export function EventsPanel({ snapshot }: { snapshot: LiveGameSnapshot }) {
  return (
    <article className="live-panel events-panel">
      <div className="live-panel-title"><div><span className="eyebrow">Measured event feed</span><h2>Your recent turning points</h2></div><Crosshair size={18} /></div>
      {snapshot.recentEvents.length ? snapshot.recentEvents.map((event) => (
        <div className={`live-event event-${event.tone}`} key={event.id}><time>{formatTime(event.time)}</time><span>{event.text}</span></div>
      )) : <p className="quiet-copy">No player kills/deaths or major objective events have appeared yet.</p>}
    </article>
  );
}

export function EvidencePanel({ snapshot }: { snapshot: LiveGameSnapshot }) {
  return (
    <article className="live-panel evidence-panel">
      <div className="live-panel-title"><div><span className="eyebrow">Accuracy guardrails</span><h2>What this view actually knows</h2></div><ShieldAlert size={18} /></div>
      {snapshot.caveats.map((caveat) => <p key={caveat}><ChevronRight size={12} />{caveat}</p>)}
      <small>* Damage profile is champion-based inference, not a live damage-received measurement.</small>
    </article>
  );
}

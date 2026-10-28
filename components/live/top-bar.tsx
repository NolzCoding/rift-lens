"use client";

import type { ReactNode } from "react";
import { Skull, TriangleAlert } from "lucide-react";

import { formatTime, useNow, type Connection } from "@/components/live/shared";
import type { LiveGameSnapshot } from "@/lib/types";

/** Between 2.5s polls the clock keeps ticking locally (capped so a paused game never drifts far). */
export function useGameClock(snapshot: LiveGameSnapshot, receivedAt: number, frozen: boolean) {
  const now = useNow(1000, !frozen);
  if (frozen || !receivedAt) return snapshot.game.time;
  return snapshot.game.time + Math.min(5, Math.max(0, (now - receivedAt) / 1000));
}

export function LiveTopBar({ snapshot, receivedAt, connection, mock, right }: {
  snapshot: LiveGameSnapshot; receivedAt: number; connection: Connection; mock: string | null; right?: ReactNode;
}) {
  const active = snapshot.activePlayer;
  const time = useGameClock(snapshot, receivedAt, Boolean(mock) || Boolean(snapshot.gameResult));
  const opponent = snapshot.laneOpponent;
  const status = mock ? `Mock · ${mock}` : connection === "live" ? "Live" : "Reconnecting";
  // Item-data health: only shown when something is off (offline fallback list or build items missing on this patch).
  const patch = snapshot.patchStatus;
  const patchWarn = patch && (patch.fallback || patch.unknownBuildItems.length > 0)
    ? patch.fallback ? "Offline item data" : `${patch.unknownBuildItems.length} build item${patch.unknownBuildItems.length === 1 ? "" : "s"} not on ${patch.version}`
    : null;
  return (
    <header className={`live-topbar ${active.isDead ? "is-dead" : ""}`}>
      <div className="topbar-who">
        <b>{active.champion}</b>
        {opponent && <span>vs {opponent.champion}</span>}
        {active.isDead && <em><Skull size={16} /> Dead</em>}
      </div>
      {patchWarn && <span className="topbar-patch" role="status" title={patch?.note || undefined}><TriangleAlert size={14} />{patchWarn}</span>}
      <span className="topbar-mode">{snapshot.game.modeLabel}</span>
      <strong className="topbar-clock" aria-label="Game time">{formatTime(time)}</strong>
      <span className={`topbar-conn ${mock ? "is-mock" : connection === "live" ? "is-live" : "is-stale"}`}><i />{status}</span>
      <div className="topbar-right">{right}</div>
    </header>
  );
}

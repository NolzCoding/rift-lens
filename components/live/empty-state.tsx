"use client";

import { Activity, Radio, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/components/live/shared";

export function EmptyState({ connection, reason, onRetry }: { connection: Connection; reason: string; onRetry: () => void }) {
  const connecting = connection === "connecting";
  return (
    <section className="live-empty">
      <div className={`live-radar ${connecting ? "is-scanning" : ""}`}><Radio size={32} /></div>
      <Badge tone={connecting ? "info" : "warn"}>{connecting ? "Connecting" : "Waiting for match"}</Badge>
      <h1>{connecting ? "Checking League's local live feed…" : "Start or enter a League match."}</h1>
      <p>{reason || "Rift Lens checks only Riot's exposed local API. It does not read game memory."}</p>
      <Button variant="ghost" onClick={onRetry}><RefreshCw size={14} /> Check now</Button>
      <div className="live-empty-notes">
        <span><Activity size={13} /> League must be in an active match</span>
        <span><ShieldAlert size={13} /> Uses Riot&apos;s Live Client API (on automatically in a match, nothing to enable)</span>
        <span><Sparkles size={13} /> AI runs on HELP ME, on death and at loading (toggle in settings)</span>
      </div>
    </section>
  );
}

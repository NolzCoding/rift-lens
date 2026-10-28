"use client";

import { useMemo, useState } from "react";
import { BarChart3, Check, ChevronRight, Clapperboard, Coins, Crosshair, ExternalLink, Filter, Lightbulb, LoaderCircle, MonitorPlay, Play, Radio, Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "all", a quality, or a lane (the champion/"Duo" an event belongs to). */
type FilterValue = string;

const qualityMeta = {
  strong: { label: "Strong", tone: "good" as const, icon: Check },
  partial: { label: "Partial", tone: "warn" as const, icon: Sparkles },
  improve: { label: "Improve", tone: "bad" as const, icon: TriangleAlert },
};

function clock(timestamp: number) {
  return `${Math.floor(timestamp / 60)}:${String(Math.floor(timestamp % 60)).padStart(2, "0")}`;
}

function signed(value: number, suffix = "") {
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}${suffix}`;
}

export function TimelineOverview({
  events,
  durationMs,
}: {
  events: TimelineEvent[];
  durationMs: number;
}) {
  const [filter, setFilter] = useState<FilterValue>("all");
  const [selectedId, setSelectedId] = useState<string>(() => events.find((event) => event.quality === "strong")?.id ?? events[0]?.id ?? "");
  const [replayBridge, setReplayBridge] = useState<{
    state: "idle" | "loading" | "success" | "error";
    action?: "clip" | "league";
    message?: string;
    setup?: string[];
    clipUrl?: string;
  }>({ state: "idle" });
  const duration = durationMs / 1000;
  const visible = useMemo(
    () => events.filter((event) => filter === "all" || event.quality === filter || event.champion === filter),
    [events, filter],
  );
  const selected = events.find((event) => event.id === selectedId) ?? visible[0];
  const ticks = Array.from({ length: Math.floor(duration / 300) + 1 }, (_, index) => index * 300);
  // One lane per champion (or "Duo") that has events, in order of first appearance.
  const lanes = [...new Set(events.map((event) => event.champion))];
  const counts = {
    strong: events.filter((event) => event.quality === "strong").length,
    partial: events.filter((event) => event.quality === "partial").length,
    improve: events.filter((event) => event.quality === "improve").length,
  };

  if (!events.length) {
    return (
      <Card>
        <CardHeader><div><CardTitle>Decision timeline</CardTitle><CardDescription>No decoded or recorded moments for this replay. Keep the Live page open while you play and Rift Lens records every death with the gold you held, so the next review can show them here.</CardDescription></div></CardHeader>
      </Card>
    );
  }

  const chooseFilter = (value: FilterValue) => {
    setFilter(value);
    const first = events.find((event) => value === "all" || event.quality === value || event.champion === value);
    if (first) setSelectedId(first.id);
  };

  const seekLeagueReplay = async () => {
    if (!selected) return;
    setReplayBridge({ state: "loading", action: "league", message: "Connecting to the League replay…" });
    try {
      const response = await fetch("/api/replay/seek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: selected.timestamp, leadIn: 3 }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setReplayBridge({
          state: "error",
          action: "league",
          message: payload.error ?? "League replay connection failed.",
          setup: payload.setup,
        });
        return;
      }
      setReplayBridge({
        state: "success",
        action: "league",
        message: `League jumped to ${clock(payload.seekTime)} and started playing.`,
      });
    } catch {
      setReplayBridge({ state: "error", action: "league", message: "The local replay bridge could not be reached." });
    }
  };

  const captureReplayClip = async () => {
    if (!selected) return;
    setReplayBridge({
      state: "loading",
      action: "clip",
      message: "Capturing a 9-second clip from the open League replay…",
    });
    try {
      const response = await fetch("/api/replay/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: selected.timestamp, before: 4, after: 5 }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setReplayBridge({
          state: "error",
          action: "clip",
          message: payload.error ?? "League could not capture this moment.",
          setup: payload.setup,
        });
        return;
      }
      setReplayBridge({
        state: "success",
        action: "clip",
        message: `Captured ${clock(payload.startTime)}–${clock(payload.endTime)}.`,
        clipUrl: `${payload.url}&v=${Date.now()}`,
      });
    } catch {
      setReplayBridge({ state: "error", action: "clip", message: "Rift Lens could not finish the browser clip." });
    }
  };

  return (
    <Card className="timeline-card">
      <CardHeader className="timeline-header">
        <div>
          <div className="flex items-center gap-2"><Radio size={15} className="text-cyan-300" /><span className="eyebrow">Decision review</span></div>
          <CardTitle className="mt-2 text-lg">Strong moments and missed windows</CardTitle>
          <CardDescription>Click any marker to see what happened, why it mattered, and the better play.</CardDescription>
        </div>
        <div className="timeline-summary">
          <Badge tone="good"><Check size={11} /> {counts.strong} strong</Badge>
          <Badge tone="warn"><Sparkles size={11} /> {counts.partial} partial</Badge>
          <Badge tone="bad"><TriangleAlert size={11} /> {counts.improve} improve</Badge>
        </div>
      </CardHeader>

      <CardContent>
        <div className="timeline-filters">
          <span><Filter size={13} /> Filter</span>
          {["all", "strong", "partial", "improve", ...(lanes.length > 1 ? lanes : [])].map((value) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => chooseFilter(value)}>
              {value === "all" ? "All moments" : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>

        <div className="timeline-map">
          <div className="timeline-axis">
            {ticks.map((tick) => (
              <span key={tick} style={{ left: `${(tick / duration) * 100}%` }}>{clock(tick)}</span>
            ))}
            <span className="timeline-end" style={{ left: "100%" }}>{clock(duration)}</span>
          </div>
          {lanes.map((lane, laneIndex) => (
            <div className="timeline-lane" key={lane}>
              <span className={`lane-name lane-c${laneIndex % 3}`}>{lane}</span>
              <div className="lane-track">
                {events.filter((event) => event.champion === lane).map((event) => {
                  const isVisible = visible.some((candidate) => candidate.id === event.id);
                  return (
                    <button
                      key={event.id}
                      className={cn(
                        "timeline-marker",
                        `marker-${event.quality}`,
                        selected?.id === event.id && "selected",
                        !isVisible && "muted",
                      )}
                      style={{ left: `${(event.timestamp / duration) * 100}%` }}
                      title={`${clock(event.timestamp)} · ${event.title}`}
                      onClick={() => { setSelectedId(event.id); setReplayBridge({ state: "idle" }); if (!isVisible) setFilter("all"); }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="timeline-review-grid">
          <div className="moment-list" role="list">
            {visible.map((event) => {
              const meta = qualityMeta[event.quality];
              const Icon = meta.icon;
              return (
                <button
                  key={event.id}
                  className={cn("moment-row", selected?.id === event.id && "active")}
                  onClick={() => { setSelectedId(event.id); setReplayBridge({ state: "idle" }); }}
                  role="listitem"
                >
                  <span className={`moment-icon marker-${event.quality}`}><Icon size={12} /></span>
                  <span className="moment-copy"><strong>{event.title}</strong><small>{event.champion} · {event.kind.replace("-", " ")}</small></span>
                  <time>{clock(event.timestamp)}</time>
                  <ChevronRight size={14} />
                </button>
              );
            })}
          </div>

          {selected && (
            <article className={`moment-detail detail-${selected.quality}`}>
              <div className="moment-detail-top">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge tone={qualityMeta[selected.quality].tone}>{qualityMeta[selected.quality].label}</Badge>
                    <span className="text-xs text-slate-500">{selected.champion} · {clock(selected.timestamp)}</span>
                  </div>
                  <h3>{selected.title}</h3>
                </div>
                <Badge tone="info"><Radio size={10} /> {selected.confidence.replace(/^./, (first) => first.toUpperCase())}</Badge>
              </div>

              <div className="detail-section">
                <span><Crosshair size={14} /> What happened</span>
                <p>{selected.happened}</p>
              </div>
              <div className="detail-section">
                <span><Sparkles size={14} /> Why it mattered</span>
                <p>{selected.why}</p>
              </div>
              <div className="better-play">
                <span><Lightbulb size={15} /> Better play</span>
                <p>{selected.recommendation}</p>
              </div>
              {selected.context && (
                <div className="moment-context">
                  <div className="moment-context-head">
                    <span><BarChart3 size={14} /> Match state at {clock(selected.context.sampledAt)}</span>
                    <small>nearest prior frame · {Math.round(selected.context.sampleLagSeconds)}s earlier</small>
                  </div>
                  <div className="context-sides">
                    <div>
                      <span>Your side</span>
                      {selected.context.allies.map((player) => (
                        <p key={player.participantId}><strong>{player.champion}</strong><b>Lv {player.level}</b><em>{player.totalGold.toLocaleString()}g · {player.cs} CS</em></p>
                      ))}
                    </div>
                    <div>
                      <span>Lane opponents</span>
                      {selected.context.enemies.map((player) => (
                        <p key={player.participantId}><strong>{player.champion}</strong><b>Lv {player.level}</b><em>{player.totalGold.toLocaleString()}g · {player.cs} CS</em></p>
                      ))}
                    </div>
                  </div>
                  <div className="context-deltas">
                    <span className={selected.context.goldDelta < 0 ? "negative" : "positive"}><Coins size={12} /> {signed(selected.context.goldDelta, "g")} lane</span>
                    <span className={selected.context.levelDelta < 0 ? "negative" : "positive"}>{signed(selected.context.levelDelta)} levels</span>
                    <span className={selected.context.teamGoldDelta < 0 ? "negative" : "positive"}>{signed(selected.context.teamGoldDelta, "g")} team</span>
                  </div>
                  <p className="context-insight">{selected.context.insight}</p>
                </div>
              )}
              <div className="replay-bridge">
                <div className="replay-bridge-copy">
                  <MonitorPlay size={18} />
                  <div><strong>Watch the real moment</strong><span>Capture 4 seconds before and 5 seconds after, then play it here.</span></div>
                </div>
                <div className="replay-bridge-actions">
                  <button className="watch-here" onClick={captureReplayClip} disabled={replayBridge.state === "loading"}>
                    {replayBridge.state === "loading" && replayBridge.action === "clip"
                      ? <LoaderCircle size={14} className="animate-spin" />
                      : <Clapperboard size={14} />}
                    Watch here
                  </button>
                  <button className="view-in-league" onClick={seekLeagueReplay} disabled={replayBridge.state === "loading"}>
                    {replayBridge.state === "loading" && replayBridge.action === "league"
                      ? <LoaderCircle size={14} className="animate-spin" />
                      : <ExternalLink size={13} />}
                    League
                  </button>
                </div>
              </div>
              {replayBridge.clipUrl && (
                <div className="replay-clip">
                  <video key={replayBridge.clipUrl} controls autoPlay playsInline preload="metadata">
                    <source src={replayBridge.clipUrl} type="video/webm" />
                    Your browser could not play this WebM clip.
                  </video>
                  <div><Play size={11} fill="currentColor" /><span>Actual replay footage · selected moment is at 4 seconds</span></div>
                </div>
              )}
              {replayBridge.state !== "idle" && (
                <div className={`bridge-status bridge-${replayBridge.state}`}>
                  <p>{replayBridge.message}</p>
                  {replayBridge.setup && (
                    <ol>{replayBridge.setup.map((step) => <li key={step}>{step}</li>)}</ol>
                  )}
                </div>
              )}
              <button className="next-moment" onClick={() => {
                const index = visible.findIndex((event) => event.id === selected.id);
                setSelectedId(visible[(index + 1) % visible.length]?.id ?? selected.id);
                setReplayBridge({ state: "idle" });
              }}>Next visible moment <ChevronRight size={14} /></button>
            </article>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

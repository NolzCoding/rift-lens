"use client";

import { Brain, Crosshair, Target, ThumbsDown, ThumbsUp } from "lucide-react";

import { ItemIcon, snapshotItemIds } from "@/components/live/shared";
import type { ItemCatalog } from "@/components/live/use-item-catalog";
import { csPaceAt10, csRange, csTargetCall, csText } from "@/lib/live-coach";
import type { LiveGameSnapshot, PlayerFocus } from "@/lib/types";

export type FocusCheckpoint = { cs: number; deaths: number } | null;
type Progress = { value: string; detail: string; tone: "good" | "warn" | "bad" | "neutral"; pct: number | null };

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function focusProgress(focus: PlayerFocus, snapshot: LiveGameSnapshot, checkpoint: FocusCheckpoint, deathGolds: number[]): Progress | null {
  const metric = focus.metric;
  if (!metric || metric.kind === "none") return null;
  const time = snapshot.game.time;
  const active = snapshot.activePlayer;
  const target = metric.target;
  if (metric.kind === "csAt10") {
    // Riot's CS feed moves in steps of 10 (a reading of 40 is 40–49): show "about N" and judge only when the range agrees.
    const shown = csText;
    if (time >= 600) {
      if (!checkpoint) return { value: "—", detail: `10:00 passed before this page saw it · target ${target}`, tone: "neutral", pct: null };
      const call = csTargetCall(checkpoint.cs, target);
      return {
        value: shown(checkpoint.cs),
        detail: `CS at 10:00 (Riot counts in 10s) · target ${target}${call === "unclear" ? " · too close to call" : ""}`,
        tone: call === "met" ? "good" : call === "missed" ? "bad" : "warn",
        pct: Math.min(100, csRange(checkpoint.cs).mid / target * 100),
      };
    }
    const pace = csPaceAt10(active.cs, time);
    return {
      value: pace == null ? shown(active.cs) : `~${pace.about}`,
      detail: pace == null ? `CS now · pace starts after first wave · target ${target}` : `about ${pace.about} by 10:00 at this pace · ${shown(active.cs)} now · target ${target}`,
      tone: pace == null || time < 180 ? "neutral" : pace.low >= target ? "good" : pace.high < target * 0.9 ? "bad" : "warn",
      pct: Math.min(100, csRange(active.cs).mid / target * 100),
    };
  }
  if (metric.kind === "deathsBefore10") {
    const deaths = time < 600 ? active.deaths : checkpoint?.deaths ?? null;
    if (deaths == null) return { value: "—", detail: `deaths before 10:00 · target ≤ ${target}`, tone: "neutral", pct: null };
    return { value: String(deaths), detail: `${time < 600 ? "deaths so far" : "deaths at 10:00"} · target ≤ ${target}`, tone: deaths > target ? "bad" : deaths === target ? "warn" : "good", pct: null };
  }
  const count = deathGolds.filter((gold) => gold >= 1000).length;
  return { value: String(count), detail: `deaths holding ≥1000g (seen live) · target ≤ ${target}`, tone: count > target ? "bad" : count === target ? "warn" : "good", pct: null };
}

function winRate(value: number | null) {
  if (value == null) return "—";
  return `${Math.round(value <= 1 ? value * 100 : value)}%`;
}

export function MemoryCard({ snapshot, catalog, checkpoint, deathGolds }: { snapshot: LiveGameSnapshot; catalog: ItemCatalog | null; checkpoint: FocusCheckpoint; deathGolds: number[] }) {
  const brief = snapshot.playerBrief;
  if (!brief) {
    return (
      <article className="live-panel memory-card memory-empty">
        <Brain size={17} />
        <p><b>Recording this game</b> — memory builds after your first finished game. <a href="/profile">Open Memory →</a></p>
      </article>
    );
  }
  const version = snapshot.dataDragonVersion;
  const known = snapshotItemIds(snapshot);
  const idFor = (name: string) => known.get(name.toLowerCase()) ?? catalog?.idByName.get(name.toLowerCase()) ?? null;
  const progress = brief.focus ? focusProgress(brief.focus, snapshot, checkpoint, deathGolds) : null;
  const issues = [...brief.issues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 3);

  return (
    <article className="live-panel memory-card">
      <div className="memory-head">
        <div><span className="eyebrow"><Brain size={11} /> What Rift Lens remembers</span><h2>{brief.champion} · {brief.gamesOnChampion} game{brief.gamesOnChampion === 1 ? "" : "s"} · {winRate(brief.winRateOnChampion)} WR</h2></div>
        <a href="/profile">Memory →</a>
      </div>

      {brief.focus && (
        <div className={`memory-focus tone-${progress?.tone || "neutral"}`}>
          <Target size={16} />
          <div>
            <span>Focus this game</span>
            <b>{brief.focus.title}</b>
            <small>{brief.focus.drill}</small>
          </div>
          {progress && <div className="memory-focus-value"><strong>{progress.value}</strong><small>{progress.detail}</small>{progress.pct != null && <i><em style={{ width: `${progress.pct}%` }} /></i>}</div>}
        </div>
      )}

      <div className="memory-grid">
        {brief.usualBuild?.length ? (
          <div><span>Usual build</span>
            <div className="memory-build">{brief.usualBuild.map((name, index) => <ItemIcon key={`${name}-${index}`} version={version} id={idFor(name)} name={name} size={30} />)}</div>
          </div>
        ) : brief.newOnChampion && brief.gamesOnChampion > 0 ? (
          <div><span>New on {brief.champion}</span>
            <p>{brief.completeGamesOnChampion ?? brief.gamesOnChampion} game{(brief.completeGamesOnChampion ?? brief.gamesOnChampion) === 1 ? "" : "s"} so far: following the build path, not your past {brief.champion} games.</p>
          </div>
        ) : null}
        {(brief.preferredItems.length > 0 || brief.avoidItems.length > 0) && (
          <div><span>Your item calls</span>
            {brief.preferredItems.length > 0 && <p className="memory-pref"><ThumbsUp size={11} />{brief.preferredItems.join(", ")}</p>}
            {brief.avoidItems.length > 0 && <p className="memory-avoid"><ThumbsDown size={11} />{brief.avoidItems.join(", ")}</p>}
          </div>
        )}
        {(brief.matchupNote || brief.killerNotes.length > 0) && (
          <div><span>Matchup & killers</span>
            {brief.matchupNote && <p>{brief.matchupNote}</p>}
            {brief.killerNotes.slice(0, 2).map((note) => <p key={note} className="memory-killer"><Crosshair size={11} />{note}</p>)}
          </div>
        )}
        {issues.length > 0 && (
          <div><span>Recurring issues</span>
            {issues.map((issue) => <p key={issue.id} className={`memory-issue sev-${issue.severity}`} title={issue.evidence}><b>{issue.label}</b> {issue.detail}</p>)}
          </div>
        )}
      </div>
    </article>
  );
}

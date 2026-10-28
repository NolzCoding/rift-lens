"use client";

import { useState } from "react";
import {
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  ListPlus,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AiPriority, AiReviewEnvelope, PlayerFocus } from "@/lib/types";
import { formatDuration } from "@/lib/utils";

export type AiCoachState = "locked" | "checking" | "idle" | "generating" | "ready" | "error";

const verdictTone = {
  excellent: "good",
  good: "good",
  mixed: "warn",
  "needs-work": "bad",
} as const;

function focusMetric(priority: AiPriority): PlayerFocus["metric"] {
  const text = `${priority.title} ${priority.why} ${priority.drill}`.toLowerCase();
  if (/\b(cs|farm|farming|last.?hit|creeps?|waves?)\b/.test(text)) return { kind: "csAt10", target: 70 };
  if (/\b(deaths?|die|dying|died)\b/.test(text)) return { kind: "deathsBefore10", target: 1 };
  if (/\b(gold|recall|recalls|spend|spending|back)\b/.test(text)) return { kind: "unspentGoldDeaths", target: 0 };
  return null;
}

function TrackFocusButton({ priority }: { priority: AiPriority }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const track = async () => {
    setStatus("saving");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus: { ...priority, source: "replay-review", metric: focusMetric(priority) } }),
      });
      setStatus(response.ok ? "saved" : "error");
    } catch { setStatus("error"); }
  };
  return (
    <Button variant="ghost" onClick={track} disabled={status === "saving" || status === "saved"} title="Set as your focus; Rift Lens checks it in every recorded live game" style={{ minHeight: 0, padding: "5px 8px", fontSize: 9, marginTop: 8 }}>
      {status === "saving" ? <LoaderCircle size={11} className="animate-spin" /> : status === "saved" ? <CheckCircle2 size={11} /> : <ListPlus size={11} />}
      {status === "saved" ? "Tracking in live games" : status === "error" ? "Could not save, retry" : "Track in live games"}
    </Button>
  );
}

export function AiCoachPanel({
  state,
  result,
  error,
  onGenerate,
  onRegenerate,
}: {
  state: AiCoachState;
  result: AiReviewEnvelope | null;
  error: string | null;
  onGenerate: () => void;
  onRegenerate: () => void;
}) {
  const review = result?.review;
  const busy = state === "checking" || state === "generating";

  return (
    <section id="ai-coach" className="ai-coach-panel">
      <div className="ai-coach-header">
        <div className="ai-coach-title">
          <div className="ai-orb"><BrainCircuit size={25} /></div>
          <div>
            <div className="flex items-center gap-2">
              <span className="eyebrow">Codex coach</span>
              <Badge tone={result?.source === "cache" ? "good" : "info"}>
                {result?.source === "cache" ? <><Database size={11} /> Cached</> : <><Sparkles size={11} /> On demand</>}
              </Badge>
            </div>
            <h2>{review?.headline ?? "Spend credits only when you ask for the deeper read."}</h2>
            <p>
              {review?.overview ?? "Replay decoding stays local and automatic. Codex is contacted only after you press Analyze with AI, and the completed review is saved locally for this exact replay data."}
            </p>
          </div>
        </div>

        <div className="ai-coach-actions">
          {review ? (
            <Button variant="ghost" onClick={onRegenerate} disabled={busy} title="Creates a new review and uses credits">
              {state === "generating" ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={14} />}
              Regenerate
            </Button>
          ) : (
            <Button onClick={onGenerate} disabled={state === "locked" || busy}>
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {state === "locked" ? "Upload a replay first" : state === "checking" ? "Checking cache" : state === "generating" ? "Codex is reviewing" : "Analyze with AI"}
            </Button>
          )}
          <small><ShieldCheck size={12} /> ChatGPT login · efficient model · locally cached</small>
        </div>
      </div>

      {state === "generating" && (
        <div className="ai-run-status">
          <LoaderCircle size={16} className="animate-spin" />
          <div><strong>Reading the structured match evidence…</strong><span>This is the only step that uses Codex credits. It can take a couple of minutes.</span></div>
        </div>
      )}

      {state === "error" && error && (
        <div className="ai-run-error"><TriangleAlert size={16} /><span>{error}</span></div>
      )}

      {review && result && (
        <div className="ai-review-body">
          <div className="ai-review-meta">
            <span><Gauge size={13} /> {review.confidence} evidence confidence</span>
            <span><Clock3 size={13} /> Generated {new Date(result.generatedAt).toLocaleString()}</span>
            <span><Database size={13} /> {result.source === "cache" ? "Loaded without using credits" : `Saved for next time · ${result.model}`}</span>
          </div>

          <div className="ai-player-grid">
            {review.playerReviews.map((player) => (
              <article key={player.champion} className="ai-player-review">
                <div className="ai-player-heading">
                  <div>
                    <span className="eyebrow">{player.champion} review</span>
                    <h3>{player.summary}</h3>
                  </div>
                  <Badge tone={verdictTone[player.verdict]}>{player.verdict.replace("-", " ")}</Badge>
                </div>
                <div className="ai-finding-columns">
                  <div>
                    <h4><CheckCircle2 size={14} /> What worked</h4>
                    {player.strengths.map((finding) => (
                      <div className="ai-finding" key={`${player.champion}-good-${finding.title}`}>
                        <strong>{finding.title}</strong>
                        <p>{finding.evidence}</p>
                        <small>{finding.advice}</small>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4><Target size={14} /> What to change</h4>
                    {player.improvements.map((finding) => (
                      <div className="ai-finding" key={`${player.champion}-fix-${finding.title}`}>
                        <strong>{finding.title}</strong>
                        <p>{finding.evidence}</p>
                        <small>{finding.advice}</small>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="ai-build-read">
                  <span>Build read</span>
                  <strong>{player.buildVerdict}</strong>
                  <ul>{player.buildNotes.map((note) => <li key={note}>{note}</li>)}</ul>
                </div>
              </article>
            ))}
          </div>

          <div className="ai-review-section">
            <div><span className="eyebrow">Selected timeline moments</span><h3>The decisions worth replaying</h3></div>
            <div className="ai-moment-grid">
              {review.keyMoments.map((moment) => (
                <article className={`ai-moment ai-moment-${moment.quality}`} key={`${moment.eventId}-${moment.timestamp}`}>
                  <div><Badge tone={moment.quality === "strong" ? "good" : moment.quality === "partial" ? "warn" : "bad"}>{moment.quality}</Badge><time>{formatDuration(moment.timestamp)}</time></div>
                  <h4>{moment.champion} · {moment.title}</h4>
                  <p>{moment.read}</p>
                  <small><Target size={12} /> {moment.betterPlay}</small>
                </article>
              ))}
            </div>
          </div>

          <div className="ai-review-section">
            <div><span className="eyebrow">Priority plan</span><h3>Take these into the next match</h3></div>
            <div className="ai-priority-list">
              {review.priorities.map((priority, index) => (
                <article key={priority.title}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><h4>{priority.title}</h4><p>{priority.why}</p><small><Target size={12} /> Drill: {priority.drill}</small><TrackFocusButton priority={priority} /></div>
                </article>
              ))}
            </div>
          </div>

          {review.evidenceLimits.length > 0 && (
            <details className="ai-evidence-limits">
              <summary>What this review could not verify</summary>
              <ul>{review.evidenceLimits.map((limit) => <li key={limit}>{limit}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

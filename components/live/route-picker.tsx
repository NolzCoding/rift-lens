"use client";

import { Check, Crown, GitFork } from "lucide-react";
import { useState } from "react";

import { ItemIcon } from "@/components/live/shared";
import type { RankedRoute, RouteSource } from "@/lib/build-routes";

const points = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

/** The reasons that move a route's score most first; shown-only lines (win rate) last. */
const reasons = (route: RankedRoute, count: number) => [...route.parts]
  .sort((a, b) => Number(a.counted === false) - Number(b.counted === false) || Math.abs(b.points) - Math.abs(a.points))
  .slice(0, count);

/**
 * The ways to build a champion (AP burst vs on-hit Katarina): the recommended one first with why, the others with what
 * speaks for and against them, and a button to play one. `playing` = the route the live build follows now.
 */
export function RoutePicker({ champion, options, chosen, playing, source, version, onChanged }: {
  champion: string;
  options: RankedRoute[];
  /** The route the player picked (null: the recommended one is used). */
  chosen: string | null;
  playing?: string;
  source?: RouteSource;
  version: string;
  onChanged?: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = playing ?? chosen ?? options.find((option) => option.recommended)?.id;
  const choose = (route: string | null) => {
    setSaving(route ?? "reset");
    setError(null);
    fetch("/api/build-route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ champion, route }) })
      .then((response) => { if (!response.ok) throw new Error("Could not save the choice."); onChanged?.(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not save the choice."))
      .finally(() => setSaving(null));
  };
  const [best] = options;
  const lead = options[1] ? best.score - options[1].score : Infinity;

  return (
    <section className="route-picker" aria-label={`Ways to build ${champion}`}>
      <header>
        <b><GitFork size={14} /> {options.length} ways to build {champion}</b>
        {source === "items" ? <small>set by the items you bought</small>
          : chosen ? <button type="button" className="route-reset" disabled={saving !== null} onClick={() => choose(null)}>use the recommended one</button>
          : <small>{lead < 1 ? "close call: either works" : "recommended for this game"}</small>}
      </header>
      {options.map((route) => {
        const isActive = route.id === active;
        return (
          <article key={route.id} className={`route-option${isActive ? " is-active" : ""}${route.recommended ? " is-best" : ""}`}>
            <div className="route-title">
              <strong>{route.name}</strong>
              {route.recommended && <em className="route-badge"><Crown size={11} /> Recommended</em>}
              {chosen === route.id && !route.recommended && <em className="route-badge is-pick">Your pick</em>}
              <span className="route-core">{route.core.map((item) => <ItemIcon key={item.name} version={version} id={item.id} name={item.name} size={26} />)}</span>
            </div>
            {route.summary && <p className="route-summary">{route.summary}</p>}
            <ul>
              {reasons(route, route.recommended ? 4 : 3).map((part) => (
                <li key={part.text} className={part.counted === false ? "muted" : part.points > 0 ? "up" : part.points < 0 ? "down" : ""}>
                  {part.text}{part.counted !== false && part.points !== 0 && <b> {points(part.points)}</b>}
                </li>
              ))}
            </ul>
            {source !== "items" && (isActive
              ? <span className="route-playing"><Check size={13} /> {playing ? "Your build follows this" : "This one"}</span>
              : <button type="button" className="route-choose" disabled={saving !== null} onClick={() => choose(route.id)}>{saving === route.id ? "Saving…" : "Play this instead"}</button>)}
          </article>
        );
      })}
      {error && <p className="route-error">{error}</p>}
    </section>
  );
}

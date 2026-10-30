"use client";

import { Ban, Crown, Plus, Swords, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ChampSelectView, PoolEntry } from "@/lib/champ-select";
import type { MetaRole } from "@/lib/meta-builds";

const ROLE_ORDER: MetaRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const ROLE_LABEL: Record<MetaRole, string> = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support" };
const POLL_MS = 3000;
const RESEARCH_LABEL: Record<string, string | null> = {
  fresh: null, stale: "matchups from an older patch", missing: "no matchup data yet", researching: "researching matchups…", queued: "matchups queued", failed: "matchup research failed",
};

function ChampionImage({ view, name, size = 40 }: { view: ChampSelectView; name: string; size?: number }) {
  const id = view.imageIds[name];
  return id
    ? <img className="cs-icon" src={`https://ddragon.leagueoflegends.com/cdn/${view.version}/img/champion/${id}.png`} alt={name} title={name} width={size} height={size} />
    : <span className="cs-icon cs-icon-empty" title={name} style={{ width: size, height: size }} />;
}

/** The parts that move the score most, counted ones first; "no matchup data vs X" last, but shown: it is why a lane counts 0. */
const reasons = (entry: ChampSelectView["suggestions"][number], count = 4) => {
  const missing = (part: { text: string }) => Number(/no matchup data/.test(part.text));
  return [...entry.parts]
    .sort((a, b) => missing(a) - missing(b) || Number(a.counted === false) - Number(b.counted === false) || Math.abs(b.points) - Math.abs(a.points))
    .slice(0, count);
};
const tone = (part: { points: number; counted?: false }) => part.counted === false ? "muted" : part.points > 0 ? "up" : part.points < 0 ? "down" : "";
const points = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;

/** One reason line with what it adds to the score (or that it is not counted yet). */
function Reason({ part }: { part: ChampSelectView["suggestions"][number]["parts"][number] }) {
  if (/no matchup data/.test(part.text)) return <li className="muted">{part.text}</li>;
  return <li className={tone(part)}>{part.text} <b>{part.counted === false ? "not counted yet" : points(part.points)}</b></li>;
}

function Suggestions({ view }: { view: ChampSelectView }) {
  const [best, ...rest] = view.suggestions;
  if (!best) return null;
  const lead = rest[0] ? best.score - rest[0].score : Infinity;
  const loading = view.suggestions.filter((entry) => entry.missingData).map((entry) => `${entry.champion} (${RESEARCH_LABEL[entry.research] || "no data"})`);
  const label = best.partial ? "Your games only" : lead >= 1.5 ? <><Crown size={12} /> Best pick</> : "Close call";
  return (
    <div className="cs-picks">
      {best.partial && (
        <p className="cs-partial">
          Matchup data is missing for {loading.join(", ")}, so this ranking only uses your own games and your team.
          Champions with matchup data show it below, but it does not count until every champion has some.
        </p>
      )}
      <article className="cs-best">
        <ChampionImage view={view} name={best.champion} size={64} />
        <div>
          <small>{label}{!view.myRole && ` · ${ROLE_LABEL[best.role]}`}</small>
          <strong>{best.champion}</strong>
          <ul>{reasons(best).map((part) => <Reason key={part.text} part={part} />)}</ul>
          {RESEARCH_LABEL[best.research] && <em>{RESEARCH_LABEL[best.research]}</em>}
        </div>
      </article>
      {rest.slice(0, 2).map((entry) => (
        <article className="cs-alt" key={`${entry.champion}-${entry.role}`}>
          <ChampionImage view={view} name={entry.champion} size={38} />
          <div>
            <strong>{entry.champion} <span>{points(entry.score - best.score)} vs {best.champion}</span></strong>
            <ul>{reasons(entry, 3).map((part) => <Reason key={part.text} part={part} />)}</ul>
            {RESEARCH_LABEL[entry.research] && <em>{RESEARCH_LABEL[entry.research]}</em>}
          </div>
        </article>
      ))}
    </div>
  );
}

function PoolEditor({ view, onSaved }: { view: ChampSelectView; onSaved: (next: ChampSelectView) => void }) {
  const [pool, setPool] = useState<PoolEntry[]>(view.pool);
  const [adding, setAdding] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [champions, setChampions] = useState<string[]>([]);
  // Image ids for every champion (from the ?champions=1 answer), so newly added ones show their portrait.
  const [ids, setIds] = useState<Record<string, string>>({});
  const images = { ...view, imageIds: { ...ids, ...view.imageIds } };
  const savedPool = JSON.stringify(view.pool);
  const dirty = JSON.stringify(pool) !== savedPool || view.poolSource === "history";

  // Every 3s poll brings a new (equal) pool array: follow the saved pool only when its content changes (a save, or
  // another tab), so unsaved additions and role changes are not wiped.
  useEffect(() => { setPool(JSON.parse(savedPool) as PoolEntry[]); }, [savedPool]);
  useEffect(() => {
    fetch("/api/champ-select?champions=1", { cache: "no-store" }).then((response) => response.json()).then((data: ChampSelectView) => { setChampions(data.champions || []); setIds(data.imageIds || {}); }).catch(() => undefined);
  }, []);

  const toggleRole = (champion: string, role: MetaRole) => setPool((current) => current.map((entry) => entry.champion !== champion ? entry
    : { ...entry, roles: entry.roles.includes(role) ? entry.roles.filter((value) => value !== role) : [...entry.roles, role] }).filter((entry) => entry.roles.length));
  const add = () => {
    const name = champions.find((entry) => entry.toLowerCase() === adding.trim().toLowerCase());
    if (!name) { setStatus(`Unknown champion "${adding.trim()}"`); return; }
    if (!pool.some((entry) => entry.champion === name)) setPool((current) => [...current, { champion: name, roles: [view.myRole || "MIDDLE"] }]);
    setAdding("");
    setStatus(null);
  };
  const save = () => {
    setStatus("Saving…");
    fetch("/api/champ-select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool }) })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not save."); onSaved(data as ChampSelectView); setStatus("Saved. Matchups are researched in the background."); })
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not save."));
  };

  return (
    <section className="cs-pool">
      <header>
        <b>Your champions</b>
        <small>{view.poolSource === "history" ? "From your games: check the roles, then save." : "Pick suggestions only use these."}</small>
      </header>
      <div className="cs-pool-list">
        {pool.map((entry) => (
          <div className="cs-pool-row" key={entry.champion}>
            <ChampionImage view={images} name={entry.champion} size={26} />
            <span>{entry.champion}</span>
            <div className="mode-toggle">
              {ROLE_ORDER.map((role) => <button type="button" key={role} className={entry.roles.includes(role) ? "active" : ""} onClick={() => toggleRole(entry.champion, role)}>{ROLE_LABEL[role]}</button>)}
            </div>
            <button type="button" className="cs-remove" aria-label={`Remove ${entry.champion}`} onClick={() => setPool((current) => current.filter((row) => row.champion !== entry.champion))}><X size={13} /></button>
          </div>
        ))}
      </div>
      <div className="cs-pool-add">
        <input list="cs-champions" value={adding} placeholder="Add a champion" onChange={(event) => setAdding(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
        <datalist id="cs-champions">{champions.map((name) => <option key={name} value={name} />)}</datalist>
        <button type="button" className="button-ghost" onClick={add}><Plus size={13} /> Add</button>
        <button type="button" disabled={!dirty || !pool.length} onClick={save}>Save</button>
      </div>
      {status && <p className="cs-status">{status}</p>}
    </section>
  );
}

/** Champ select helper on the live page's waiting screen: the pool ranked for your role while picks lock in. */
export function ChampSelectPanel() {
  const [view, setView] = useState<ChampSelectView | null>(null);
  const [editing, setEditing] = useState(false);
  const poll = useCallback(() => {
    // /live?champselect=mock: a made-up champ select through the real pipeline (lib/champ-select.ts MOCK_SESSION).
    const mock = new URLSearchParams(window.location.search).get("champselect") === "mock";
    fetch(`/api/champ-select${mock ? "?mock=1" : ""}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((data: ChampSelectView | null) => { if (data) setView(data); }).catch(() => undefined);
  }, []);
  useEffect(() => { poll(); const timer = window.setInterval(poll, POLL_MS); return () => window.clearInterval(timer); }, [poll]);
  if (!view) return null;
  const showPool = editing || !view.active || view.poolSource !== "saved";

  return (
    <section className={`champ-select ${view.active ? "is-active" : ""}`}>
      {view.active && (
        <>
          <header className="cs-head">
            <span><Swords size={14} /> {view.queue?.label || "Champ select"}{view.myRole && <> · you: <b>{ROLE_LABEL[view.myRole]}</b></>}</span>
            {view.myTurn && <em className="cs-turn">Your pick</em>}
          </header>
          <Suggestions view={view} />
          {view.note && <p className="cs-note">{view.note}</p>}
          {view.enemies.length > 0 && (
            <div className="cs-enemies">
              <small>Enemy picks (roles are a guess: Riot hides them until the game loads)</small>
              <div>{view.enemies.map((enemy) => (
                <span key={enemy.champion}>
                  <ChampionImage view={view} name={enemy.champion} size={30} />
                  <b>{ROLE_LABEL[enemy.role]}{enemy.alt && ` or ${ROLE_LABEL[enemy.alt]}`}</b>
                  {!enemy.alt && <i>{Math.round(enemy.chance * 100)}%</i>}
                </span>
              ))}</div>
              {view.laneGuess.length > 0 && view.myRole && (
                <p className="cs-lane">
                  Their {view.myRole === "BOTTOM" || view.myRole === "UTILITY" ? "bot lane" : `${ROLE_LABEL[view.myRole].toLowerCase()} laner`}:{" "}
                  {view.laneGuess.map((lane) => `${lane.champions.join(" + ")} ${Math.round(lane.chance * 100)}%`).join(" · ")}
                  {view.laneGuess[0].chance < 0.6 && " (unclear: your picks are scored against each of these)"}
                </p>
              )}
            </div>
          )}
          {view.bans.length > 0 && (
            <div className="cs-bans"><Ban size={12} /> {view.bans.map((name) => <ChampionImage key={name} view={view} name={name} size={20} />)}</div>
          )}
          {!showPool && <button type="button" className="cs-edit" onClick={() => setEditing(true)}>Edit your champions</button>}
        </>
      )}
      {showPool && <PoolEditor view={view} onSaved={(next) => { setView(next); setEditing(false); }} />}
    </section>
  );
}

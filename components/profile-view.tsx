"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  Crosshair,
  ExternalLink,
  Footprints,
  Globe,
  Hammer,
  History,
  LoaderCircle,
  NotebookPen,
  Pin,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Skull,
  Swords,
  Target,
  TriangleAlert,
  Trophy,
  X,
  XCircle,
} from "lucide-react";

import { ImportedBuildView, PinnedBuildEditor } from "@/components/profile/build-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResearchJob, ResearchOverview, StoredResearch } from "@/lib/build-research";
import type { ProfileImports, StoredImport } from "@/lib/item-set-import";
import type { ProfileSettings } from "@/lib/memory-store";
import { buildCheck, NEW_CHAMPION_GAMES, selectMetaBuild, type BuildCheck, type MetaBuild } from "@/lib/meta-builds";
import type { LearnedBuild, LearnedChampionProfile, RecentGame, StoredProfile } from "@/lib/player-profile";
import type { ChampionProfile, PlayerFocus } from "@/lib/types";

type ProfilePayload = { profile: StoredProfile; settings: ProfileSettings; research: ResearchOverview } & ProfileImports;
type MetricKind = NonNullable<PlayerFocus["metric"]>["kind"];

const METRIC_LABELS: Record<MetricKind, string> = {
  csAt10: "CS at 10:00 (at least)",
  deathsBefore10: "Deaths before 10:00 (at most)",
  unspentGoldDeaths: "Deaths holding 1000g+ (at most)",
  none: "No automatic metric",
};
const METRIC_DEFAULTS: Record<MetricKind, number> = { csAt10: 70, deathsBefore10: 1, unspentGoldDeaths: 0, none: 0 };

const clock = (seconds: number | null) => seconds === null ? "—" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const rate = (wins: number, games: number) => games ? `${Math.round(wins / games * 100)}%` : "—";
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const splitItems = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
const timeOf = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const dayOf = (iso: string | undefined) => iso ? new Date(iso).toLocaleDateString() : "";

function itemsFor(map: Record<string, string[]>, champion: string) {
  const match = Object.keys(map).find((name) => key(name) === key(champion));
  return match ? map[match] : [];
}

function championNotes(notes: string[], champion: string) {
  return notes.flatMap((note) => {
    const prefixed = /^\[([^\]]{2,40})\]\s*(.+)$/.exec(note);
    return prefixed && key(prefixed[1]) === key(champion) ? [prefixed[2]] : [];
  });
}

async function send(method: "PATCH" | "POST", body: unknown): Promise<ProfilePayload> {
  const response = await fetch("/api/profile", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as ProfilePayload & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Profile update failed.");
  return payload;
}

function FocusEditor({ focus, busy, onSave }: { focus: PlayerFocus | null; busy: boolean; onSave: (focus: Partial<PlayerFocus> | null) => void }) {
  const [title, setTitle] = useState(focus?.title || "");
  const [why, setWhy] = useState(focus?.why || "");
  const [drill, setDrill] = useState(focus?.drill || "");
  const [kind, setKind] = useState<MetricKind>(focus?.metric?.kind || "none");
  const [target, setTarget] = useState(String(focus?.metric?.target ?? 0));
  return (
    <form className="profile-form" onSubmit={(event) => {
      event.preventDefault();
      onSave({ title, why, drill, source: focus?.source || "manual", metric: kind === "none" ? null : { kind, target: Number(target) || 0 } });
    }}>
      <label><span>Focus</span><input value={title} maxLength={120} required placeholder="e.g. Hit 70 CS by 10:00" onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>Why</span><textarea value={why} maxLength={500} rows={2} onChange={(event) => setWhy(event.target.value)} /></label>
      <label><span>Drill</span><textarea value={drill} maxLength={500} rows={2} onChange={(event) => setDrill(event.target.value)} /></label>
      <div className="profile-form-row">
        <label><span>Measured by</span>
          <select value={kind} onChange={(event) => { const next = event.target.value as MetricKind; setKind(next); setTarget(String(METRIC_DEFAULTS[next])); }}>
            {(Object.keys(METRIC_LABELS) as MetricKind[]).map((option) => <option key={option} value={option}>{METRIC_LABELS[option]}</option>)}
          </select>
        </label>
        <label><span>Target</span><input type="number" min={0} max={300} value={target} disabled={kind === "none"} onChange={(event) => setTarget(event.target.value)} /></label>
      </div>
      <div className="profile-form-actions">
        <Button type="submit" disabled={busy || !title.trim()}><Save size={13} /> Save focus</Button>
        {focus && <Button type="button" variant="ghost" disabled={busy} onClick={() => onSave(null)}><X size={13} /> Clear focus</Button>}
      </div>
    </form>
  );
}

function ChampionPreferences({ champion, settings, busy, onSave }: {
  champion: string;
  settings: ProfileSettings;
  busy: boolean;
  onSave: (body: unknown) => void;
}) {
  const [preferred, setPreferred] = useState(itemsFor(settings.preferences.preferredItems, champion).join(", "));
  const [avoid, setAvoid] = useState(itemsFor(settings.preferences.avoidItems, champion).join(", "));
  const [notes, setNotes] = useState(championNotes(settings.preferences.notes, champion).join("\n"));
  const save = () => {
    const others = settings.preferences.notes.filter((note) => {
      const prefixed = /^\[([^\]]{2,40})\]\s*(.+)$/.exec(note);
      return !(prefixed && key(prefixed[1]) === key(champion));
    });
    const mine = notes.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => `[${champion}] ${line}`);
    onSave({ preferences: { preferredItems: { [champion]: splitItems(preferred) }, avoidItems: { [champion]: splitItems(avoid) }, notes: [...others, ...mine] } });
  };
  return (
    <div className="profile-form profile-prefs">
      <label><span>Preferred items</span><input value={preferred} placeholder="Comma separated, e.g. Luden's Companion, Shadowflame" onChange={(event) => setPreferred(event.target.value)} /></label>
      <label><span>Avoid items</span><input value={avoid} placeholder="Comma separated" onChange={(event) => setAvoid(event.target.value)} /></label>
      <label><span>Notes (one per line)</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <div className="profile-form-actions"><Button type="button" variant="ghost" disabled={busy} onClick={save}><Save size={13} /> Save {champion} preferences</Button></div>
    </div>
  );
}

/** The learned path / first back / boots the live coach uses, each with the games behind it. */
function LearnedHabits({ learned }: { learned: LearnedBuild | undefined }) {
  if (!learned) return <p className="profile-quiet">Rebuild the profile to see learned habits.</p>;
  const path = learned.path;
  const historyOnly = path?.core === 0;
  const later = path?.later?.length ? path.later.map((entry) => `${entry.item} (${entry.games})`).join(" › ") : null;
  const rows: Array<[string, string | null, string]> = [
    [historyOnly ? "Usually finished" : "Usual path", path ? path.items.join(" › ") : null, path ? `${path.games} of last ${path.of} games${historyOnly ? " · order approximate" : ""}` : ""],
    ...(later && !historyOnly ? [["Then usually", later, path?.laterOf ? `of last ${path.laterOf} games` : ""] as [string, string, string]] : []),
    ["First back", learned.firstBack ? learned.firstBack.items.join(" + ") : null, learned.firstBack ? `${learned.firstBack.games} of last ${learned.firstBack.of} games` : ""],
    ["Boots", learned.boots ? learned.boots.item : null, learned.boots ? `${learned.boots.games} of last ${learned.boots.of} games` : ""],
  ];
  return (
    <div className="profile-learned">
      {rows.map(([label, value, count]) => (
        <div className="profile-path" key={label}>
          <span><b>{label}:</b> {value ?? <em className="profile-quiet-inline">no clear habit yet</em>}</span>
          {count && <small>{count}</small>}
        </div>
      ))}
      <p className="profile-quiet">Learned from your last {learned.window} complete games; newer games count more. Remakes and partial games are left out. The core order comes from games recorded with /live open; later items and boots also count games from the League client&apos;s match history (final items only, no purchase order).</p>
    </div>
  );
}

/** What the player finishes vs the curated top build: off-meta habits and core items they rarely finish. */
function BuildCheckView({ meta, check }: { meta: MetaBuild; check: BuildCheck | null }) {
  const rows: Array<[string, BuildCheck["offMeta"][number]]> = [
    ...(check?.offMeta || []).map((row) => ["Off-meta", row] as [string, BuildCheck["offMeta"][number]]),
    ...(check?.rareCore || []).map((row) => ["Rarely finished", row] as [string, BuildCheck["offMeta"][number]]),
  ];
  return (
    <div className="profile-learned">
      {rows.length ? rows.map(([label, row]) => (
        <div className="profile-path" key={`${label}-${row.item}`}>
          <span><b>{label}:</b> {row.item} — {row.fact}</span>
          <small>you: {row.games} of {row.of} games</small>
        </div>
      )) : <p className="profile-quiet">{check ? "Your finished items match the top build." : "Appears once games with finished items are remembered."}</p>}
      <p className="profile-quiet">
        Top {meta.champion} build, patch {meta.patch} ({meta.sample}, {meta.origin === "researched" ? "researched" : "checked"} {meta.verified}):{" "}
        {meta.slots.map((slot) => `${slot.label} ${slot.options.filter((option) => !option.when).map((option) => option.item).join(" / ")}`).join(" · ")}.
        {" "}The live coach follows it; your history only picks between its options. Sources are listed under Build data.
      </p>
    </div>
  );
}

/** Where the top build comes from (web research or the curated table), its sources, and the Refresh build data button. */
function BuildData({ champion, meta, stored, job, running, busy, onRefresh }: {
  champion: string; meta: MetaBuild | null; stored: StoredResearch | null; job: ResearchJob | null; running: string | null; busy: boolean; onRefresh: () => void;
}) {
  const researching = job?.state === "researching";
  const otherRunning = Boolean(running) && !researching;
  const status = researching
    ? <><LoaderCircle size={12} className="animate-spin" /> Researching the {job.role} build on the web… (started {timeOf(job.startedAt)}, usually 1–5 min)</>
    : job?.state === "failed"
      ? <><XCircle size={12} /> Failed at {timeOf(job.finishedAt)}: {job.error}</>
      : job?.state === "done"
        ? <><CheckCircle2 size={12} /> Done at {timeOf(job.finishedAt)}{job.durationMs ? ` (${Math.round(job.durationMs / 1000)}s)` : ""}</>
        : null;
  const origin = !meta
    ? `No top build for ${champion} yet. Rift Lens looks it up automatically in champ select, or press Refresh.`
    : meta.origin === "researched"
      ? `Researched ${meta.role} build, patch ${meta.patch} · ${meta.sample} · looked up ${dayOf(meta.researchedAt)} on Data Dragon ${meta.researchedOn}${meta.outdated ? " · from an older patch" : ""}${meta.stale ? " · sites showed an old patch" : ""}`
      : `Curated ${meta.role} build, patch ${meta.patch} · ${meta.sample} · checked by hand ${meta.verified}`;
  return (
    <div className="profile-learned profile-build-data">
      <div className="profile-path">
        <span>{origin}</span>
        <Button type="button" variant="ghost" disabled={busy || researching || otherRunning} onClick={onRefresh}
          title={otherRunning ? "Another research is running" : "Search op.gg, lolalytics, u.gg… for the current-patch build (uses your Codex allowance)"}>
          {researching ? <LoaderCircle size={13} className="animate-spin" /> : <Globe size={13} />} Refresh build data
        </Button>
      </div>
      {status && <p className="profile-quiet profile-research-status">{status}</p>}
      {meta && meta.sources.length > 0 && (
        <p className="profile-quiet">
          Sources:{" "}
          {meta.sources.map((source, index) => (
            <span key={source.url}>{index ? " · " : ""}<a href={source.url} target="_blank" rel="noreferrer" title={source.read || source.name}>{source.site || source.name} <ExternalLink size={9} /></a></span>
          ))}
        </p>
      )}
      {stored && stored.dropped.length > 0 && (
        <p className="profile-quiet">Dropped from the research (not current Riot items): {stored.dropped.map((entry) => `${entry.item} (${entry.where})`).join(", ")}.</p>
      )}
    </div>
  );
}

function ChampionCard({ champion, profile, settings, imported, catalog, research, busy, onSave, onSaveBuild, onRefreshBuild }: {
  champion: string;
  profile: ChampionProfile | null;
  settings: ProfileSettings;
  imported: StoredImport | null;
  catalog: ProfileImports["catalog"];
  research: ResearchOverview;
  busy: boolean;
  onSave: (body: unknown) => void;
  onSaveBuild: (build: string[], label: string) => void;
  onRefreshBuild: () => void;
}) {
  const decided = profile ? profile.wins + profile.losses : 0;
  const learnedProfile = profile as LearnedChampionProfile | null;
  const fromHistory = learnedProfile?.sources?.history || 0;
  const finished = learnedProfile?.finishedItems || [];
  const pinned = itemsFor(settings.preferences.builds || {}, champion);
  const pinnedMatches = Boolean(imported && pinned.length && pinned.join("|") === imported.items.slice(0, 8).join("|"));
  // Researched for the current patch > curated > older research (same precedence as the live coach).
  const meta = selectMetaBuild(champion, null, { researched: research.stored.map((entry) => entry.build), version: research.version });
  const stored = meta?.origin === "researched" ? research.stored.find((entry) => entry.build.researchedAt === meta.researchedAt) || null : null;
  const job = research.jobs.filter((entry) => key(entry.champion) === key(champion)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
  // Computed from the finished-item counts so the check follows the build shown (stored check only for older files).
  const check = !meta || !learnedProfile ? null : finished.length
    ? buildCheck(meta, { finished, boots: learnedProfile.boots, games: learnedProfile.buildGames ?? learnedProfile.games }) : learnedProfile.buildCheck ?? null;
  return (
    <article className="profile-champion">
      <div className="profile-champion-head">
        <div className="champion-avatar">{champion.slice(0, 2).toUpperCase()}</div>
        <div>
          <h3>{champion}</h3>
          <small>{profile ? `${profile.games} game${profile.games === 1 ? "" : "s"} · ${profile.wins}W ${profile.losses}L${fromHistory ? ` · ${profile.games - fromHistory} recorded, ${fromHistory} from match history` : ""}` : "No games recorded yet"}</small>
        </div>
        {profile && <Badge tone={decided && profile.wins / decided >= 0.5 ? "good" : decided ? "bad" : "neutral"}>{rate(profile.wins, decided)} WR</Badge>}
      </div>
      <div className="profile-subhead profile-subhead-gap"><Globe size={12} /> Build data</div>
      <BuildData champion={champion} meta={meta} stored={stored} job={job} running={research.running} busy={busy} onRefresh={onRefreshBuild} />
      {profile && (
        <>
          <div className="profile-stat-row">
            <div><span>KDA</span><strong>{profile.avg.kills}/{profile.avg.deaths}/{profile.avg.assists}</strong></div>
            <div><span>CS</span><strong>{profile.avg.cs}</strong></div>
            <div><span>CS@10</span><strong>{profile.avgCsAt10 ?? "—"}</strong></div>
            <div><span>1st item</span><strong>{clock(profile.avgFirstItemTime)}</strong></div>
          </div>
          {meta && (
            <>
              <div className="profile-subhead"><TriangleAlert size={12} /> Build check vs the top {champion} build</div>
              <BuildCheckView meta={meta} check={check} />
            </>
          )}
          <div className={meta ? "profile-subhead profile-subhead-gap" : "profile-subhead"}><Hammer size={12} /> {meta ? "What you actually build (learned)" : "What the coach learned"}</div>
          {(() => {
            const complete = learnedProfile ? learnedProfile.completeGames ?? learnedProfile.buildGames ?? learnedProfile.games : 0;
            return learnedProfile && complete < NEW_CHAMPION_GAMES
              ? <p className="profile-quiet">New on {champion} ({complete} game{complete === 1 ? "" : "s"}): the live coach follows {meta ? "the top build" : "its defaults"}, not these habits, until {NEW_CHAMPION_GAMES} complete games.</p>
              : null;
          })()}
          <LearnedHabits learned={learnedProfile?.learned} />
          {finished.length > 0 && (
            <>
              <div className="profile-subhead profile-subhead-gap"><Hammer size={12} /> Items you finish most on {champion}</div>
              {finished.slice(0, 8).map((entry) => (
                <div className="profile-path" key={entry.item}>
                  <span>{entry.item}</span>
                  <small>{entry.games} game{entry.games === 1 ? "" : "s"}</small>
                </div>
              ))}
            </>
          )}
          <div className="profile-subhead profile-subhead-gap"><Hammer size={12} /> Build paths</div>
          {profile.buildPaths.length ? profile.buildPaths.map((path) => (
            <div className="profile-path" key={path.items.join(">")}>
              <span>{path.items.join(" › ")}</span>
              <small>{path.games}g · {rate(path.wins, path.games)}</small>
            </div>
          )) : <p className="profile-quiet">Appears after a recorded game with at least one completed item.</p>}
          {profile.boots.length > 0 && (
            <div className="profile-boots"><Footprints size={12} /> {profile.boots.map((boot) => `${boot.item} (${boot.games})`).join(" · ")}</div>
          )}
        </>
      )}
      {imported && (
        <>
          <div className="profile-subhead profile-subhead-gap"><Hammer size={12} /> Imported item set</div>
          <ImportedBuildView build={imported} items={catalog.items} version={catalog.version} busy={busy} pinnedMatches={pinnedMatches}
            onPin={() => onSaveBuild(imported.items.slice(0, 8), `Pinned "${imported.title}" for ${champion}.`)} />
        </>
      )}
      <details className="profile-details" open={pinned.length > 0}>
        <summary><Pin size={12} /> {pinned.length ? `Pinned build (${pinned.length})` : "Pin a build"}</summary>
        <PinnedBuildEditor key={pinned.join("|")} champion={champion} pinned={pinned} items={catalog.items} version={catalog.version} busy={busy}
          onSave={(build) => onSaveBuild(build, build.length ? `${champion} build pinned.` : `${champion} build unpinned.`)} />
      </details>
      <details className="profile-details">
        <summary><NotebookPen size={12} /> Preferences & notes</summary>
        <ChampionPreferences champion={champion} settings={settings} busy={busy} onSave={onSave} />
      </details>
    </article>
  );
}

export function ProfileView({ initial }: { initial: ProfilePayload }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newChampion, setNewChampion] = useState("");
  const [extraChampions, setExtraChampions] = useState<string[]>([]);
  const [globalNotes, setGlobalNotes] = useState(() => initial.settings.preferences.notes.filter((note) => !/^\[([^\]]{2,40})\]\s*(.+)$/.test(note)).join("\n"));
  const { profile, settings, imports, catalog, research } = data;
  const researching = Boolean(research.running) || research.jobs.some((job) => job.state === "researching");

  // While a build research runs (1–5 min), poll its status; stops once nothing is running.
  useEffect(() => {
    if (!researching) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/meta-research", { cache: "no-store" });
        if (response.ok) { const next = await response.json() as ResearchOverview; setData((current) => ({ ...current, research: next })); }
      } catch { /* next tick */ }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [researching]);

  const refreshBuild = (champion: string) => async () => {
    setError(null); setSaved(null);
    try {
      const response = await fetch("/api/meta-research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ champion }) });
      const payload = await response.json() as { outcome?: { message: string }; overview?: ResearchOverview; error?: string };
      const overview = payload.overview;
      if (overview) setData((current) => ({ ...current, research: overview }));
      if (!response.ok) setError(payload.error || payload.outcome?.message || "Build research could not start.");
      else setSaved(payload.outcome?.message || "Research started.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Build research could not start."); }
  };
  const empty = profile.gamesRecorded === 0;
  const sources = profile.sources;

  const run = async (label: string, method: "PATCH" | "POST", body: unknown) => {
    setBusy(true); setError(null); setSaved(null);
    try { setData(await send(method, body)); setSaved(label); } catch (caught) { setError(caught instanceof Error ? caught.message : "Update failed."); } finally { setBusy(false); }
  };
  const savePreferences = (body: unknown) => run("Preferences saved.", "PATCH", body);
  const saveBuild = (champion: string) => (build: string[], label: string) => run(label, "PATCH", { preferences: { builds: { [champion]: build } } });
  const importFor = (champion: string) => {
    const match = Object.keys(imports || {}).find((name) => key(name) === key(champion));
    return match ? imports[match] : null;
  };

  const champions = useMemo(() => {
    const names = new Map<string, string>();
    for (const champion of profile.champions) names.set(key(champion.champion), champion.champion);
    const extra = [...Object.keys(settings.preferences.preferredItems), ...Object.keys(settings.preferences.avoidItems), ...Object.keys(settings.preferences.builds || {}), ...Object.keys(imports || {}), ...extraChampions];
    for (const name of extra) {
      if (!names.has(key(name))) names.set(key(name), name);
    }
    return [...names.values()];
  }, [profile.champions, settings.preferences, imports, extraChampions]);

  const focus = settings.focus;
  return (
    <div className="profile-page">
      <section className="profile-hero">
        <div className="ai-orb"><History size={24} /></div>
        <div>
          <span className="eyebrow">Long-term memory</span>
          <h1>{empty ? "No games recorded yet." : `${profile.gamesRecorded} game${profile.gamesRecorded === 1 ? "" : "s"} remembered across ${profile.champions.length} champion${profile.champions.length === 1 ? "" : "s"}.`}</h1>
          <p>
            {empty
              ? <>Play a game with <a href="/live">/live</a> open and it will be recorded: purchases, deaths, CS at 10, build order and result. The live coach then uses your usual builds, matchups and recurring mistakes.</>
              : <>{sources && (
                  <><b>{sources.recorded} recorded</b> with the live screen open{sources.history ? <> · <b>{sources.history} from the League client&apos;s match history</b></> : null}{sources.linked ? ` (${sources.linked} recorded game${sources.linked === 1 ? " was" : "s were"} also in match history and counted once)` : ""}. </>
                )}Every game played with the live screen open is stored on this PC; games from the client&apos;s match history add results and final items (no purchase order or deaths). Remakes (under 3:00) never count, games under 5 minutes stay out of stats, partial games (live screen opened late) count for results but not build learning, and ARAM/Arena games are listed but kept out of build, matchup and issue stats. Updated {new Date(profile.updatedAt).toLocaleString()}.</>}
          </p>
        </div>
        <div className="profile-hero-actions">
          <Button variant="ghost" disabled={busy} onClick={() => run("Profile rebuilt.", "POST", { action: "rebuild" })}>
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} Rebuild
          </Button>
          {empty && <a className="button" href="/live"><Radio size={14} /> Open live screen</a>}
        </div>
      </section>

      {(error || saved) && <div className={error ? "profile-banner profile-banner-error" : "profile-banner"}>{error ? <TriangleAlert size={14} /> : <CheckCircle2 size={14} />}{error || saved}</div>}

      <div className="profile-grid profile-grid-top">
        <section className="profile-panel">
          <div className="profile-panel-title"><div><span className="eyebrow">Current focus</span><h2>{focus ? focus.title : "No focus set"}</h2></div><Target size={18} /></div>
          {focus && (
            <div className="profile-focus-summary">
              {focus.why && <p>{focus.why}</p>}
              {focus.drill && <small><Crosshair size={12} /> Drill: {focus.drill}</small>}
              <div>
                <Badge tone="info">{focus.source === "replay-review" ? "From replay review" : "Manual"}</Badge>
                <Badge>{focus.metric && focus.metric.kind !== "none" ? `${METRIC_LABELS[focus.metric.kind]}: ${focus.metric.target}` : "Not auto-measured"}</Badge>
              </div>
            </div>
          )}
          <details className="profile-details" open={!focus}>
            <summary><NotebookPen size={12} /> {focus ? "Edit focus" : "Set a focus"}</summary>
            <FocusEditor key={focus?.setAt || "none"} focus={focus} busy={busy} onSave={(next) => run(next ? "Focus saved." : "Focus cleared.", "PATCH", { focus: next })} />
          </details>
        </section>

        <section className="profile-panel">
          <div className="profile-panel-title"><div><span className="eyebrow">Recurring issues</span><h2>Patterns across your games</h2></div><TriangleAlert size={18} /></div>
          {profile.issues.length ? (
            <div className="profile-issues">
              {profile.issues.map((issue) => (
                <article key={issue.id} className={`profile-issue profile-issue-${issue.severity}`}>
                  <div><strong>{issue.label}</strong><Badge tone={issue.severity === "high" ? "bad" : issue.severity === "medium" ? "warn" : "neutral"}>{issue.severity}</Badge></div>
                  <p>{issue.evidence}</p>
                  <small>{issue.detail}</small>
                </article>
              ))}
            </div>
          ) : <p className="profile-quiet">{empty ? "Issues appear once at least three Summoner's Rift games are recorded." : "Nothing recurring stands out yet."}</p>}
        </section>
      </div>

      <div className="profile-section-heading"><div><span className="eyebrow">Champions</span><h2>Builds and results</h2></div>
        <form className="profile-add" onSubmit={(event) => {
          event.preventDefault();
          const name = newChampion.trim().slice(0, 40);
          if (name) setExtraChampions((current) => [...current, name]);
          setNewChampion("");
        }}>
          <input value={newChampion} placeholder="Add preferences for a champion" onChange={(event) => setNewChampion(event.target.value)} />
          <Button type="submit" variant="ghost" disabled={!newChampion.trim()}><Plus size={13} /> Add</Button>
        </form>
      </div>
      {champions.length ? (
        <div className="profile-champion-grid">
          {champions.map((champion) => (
            <ChampionCard
              key={champion}
              champion={champion}
              profile={profile.champions.find((entry) => key(entry.champion) === key(champion)) || null}
              settings={settings}
              imported={importFor(champion)}
              catalog={catalog}
              research={research}
              busy={busy}
              onSave={savePreferences}
              onSaveBuild={saveBuild(champion)}
              onRefreshBuild={refreshBuild(champion)}
            />
          ))}
        </div>
      ) : <p className="profile-quiet profile-panel">Champion stats appear after your first recorded Summoner&apos;s Rift game over 5 minutes.</p>}

      <div className="profile-grid">
        <section className="profile-panel">
          <div className="profile-panel-title"><div><span className="eyebrow">Lane matchups</span><h2>Who you laned against</h2></div><Swords size={18} /></div>
          {profile.matchups.length ? (
            <table className="profile-table">
              <thead><tr><th>Matchup</th><th>Games</th><th>Win rate</th><th>Deaths to them</th></tr></thead>
              <tbody>{profile.matchups.slice(0, 15).map((matchup) => (
                <tr key={`${matchup.champion}-${matchup.enemy}`}><td>{matchup.champion} <span>vs</span> {matchup.enemy}</td><td>{matchup.games}</td><td>{rate(matchup.wins, matchup.games)}</td><td>{matchup.deathsToEnemy}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="profile-quiet">No lane matchups recorded yet.</p>}
        </section>
        <section className="profile-panel">
          <div className="profile-panel-title"><div><span className="eyebrow">Top killers</span><h2>Champions that kill you most</h2></div><Skull size={18} /></div>
          {profile.killers.length ? (
            <div className="profile-killers">
              {profile.killers.slice(0, 8).map((killer) => {
                const max = profile.killers[0].deathsTo || 1;
                return (
                  <div key={killer.champion}>
                    <span>{killer.champion}</span>
                    <div className="profile-bar"><i style={{ width: `${Math.max(6, killer.deathsTo / max * 100)}%` }} /></div>
                    <small>{killer.deathsTo} death{killer.deathsTo === 1 ? "" : "s"} · {killer.games}g</small>
                  </div>
                );
              })}
            </div>
          ) : <p className="profile-quiet">No champion deaths recorded yet.</p>}
        </section>
      </div>

      <section className="profile-panel">
        <div className="profile-panel-title"><div><span className="eyebrow">Recent games</span><h2>Last recorded matches</h2></div><Trophy size={18} /></div>
        {profile.recentGames.length ? (
          <div className="profile-games">
            {(profile.recentGames as RecentGame[]).map((game) => (
              <div className={game.remake ? "profile-game profile-game-remake" : "profile-game"} key={game.id}>
                <Badge tone={game.remake ? "neutral" : game.result === "win" ? "good" : game.result === "loss" ? "bad" : "neutral"}>{game.remake ? "Remake" : game.result}</Badge>
                <div>
                  <strong>{game.champion}{game.laneOpponent ? <span> vs {game.laneOpponent}</span> : null}
                    {game.partial && <span className="profile-partial" title="Live screen opened late or the feed dropped: counts for W/L and deaths, not for build learning, first-item time or CS@10."> partial</span>}
                  </strong>
                  <small>{new Date(game.startedAt).toLocaleString()}</small>
                </div>
                <div className="profile-game-stats"><span>{game.final.kills}/{game.final.deaths}/{game.final.assists}</span><span>{game.final.cs} CS</span><span><Clock3 size={11} /> {clock(game.durationSeconds)}</span></div>
                <div className="profile-game-focus">
                  {game.focusResult ? (
                    <>
                      {game.focusResult.met === true ? <CheckCircle2 size={13} className="met" /> : game.focusResult.met === false ? <XCircle size={13} className="missed" /> : <CircleDashed size={13} />}
                      <span title={game.focusResult.title}>{game.focusResult.detail}</span>
                    </>
                  ) : <span className="profile-quiet-inline">No focus</span>}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="profile-quiet">Play a game with /live open and it will be recorded.</p>}
      </section>

      <section className="profile-panel">
        <div className="profile-panel-title"><div><span className="eyebrow">General notes</span><h2>Things the coach should always know</h2></div><NotebookPen size={18} /></div>
        <div className="profile-form">
          <label><span>One note per line (champion-specific notes live on each champion card)</span>
            <textarea rows={3} value={globalNotes} placeholder="e.g. I play with a duo jungler; I prefer safe scaling builds." onChange={(event) => setGlobalNotes(event.target.value)} />
          </label>
          <div className="profile-form-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => {
              const championSpecific = settings.preferences.notes.filter((note) => /^\[([^\]]{2,40})\]\s*(.+)$/.test(note));
              const general = globalNotes.split("\n").map((line) => line.trim()).filter(Boolean);
              savePreferences({ preferences: { notes: [...general, ...championSpecific] } });
            }}><Save size={13} /> Save notes</Button>
          </div>
        </div>
      </section>
    </div>
  );
}

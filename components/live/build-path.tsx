"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, LoaderCircle, Pencil, Pin, PinOff, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ItemIcon, useNow } from "@/components/live/shared";
import type { ItemCatalog } from "@/components/live/use-item-catalog";
import type { LiveBuildPath, LiveGameSnapshot } from "@/lib/types";

const SOURCE: Record<LiveBuildPath["source"], { label: string; tone: "good" | "info" | "warn" | "neutral" }> = {
  pinned: { label: "Pinned", tone: "good" },
  imported: { label: "Mobalytics import", tone: "info" },
  meta: { label: "Top build", tone: "good" },
  history: { label: "From your games", tone: "info" },
  inventory: { label: "Following your items", tone: "neutral" },
  default: { label: "Default", tone: "warn" },
};
const MAX_ITEMS = 8;

type SaveState = { status: "idle" | "saving" | "saved" | "error"; message: string; at: number };
const SAVED_NOTE_MS = 8000;

/** PATCH the player's pinned build for one champion ([] unpins). */
async function saveBuild(champion: string, items: string[]) {
  const response = await fetch("/api/profile", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences: { builds: { [champion]: items } } }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Save failed (${response.status}).`);
  }
}

/** "Your build" strip: the engine's build path with pin / edit / unpin. */
export function BuildPathStrip({ snapshot, catalog, mock }: { snapshot: LiveGameSnapshot; catalog: ItemCatalog | null; mock: boolean }) {
  const active = snapshot.activePlayer;
  const version = snapshot.dataDragonVersion;
  const path = snapshot.buildPath as LiveBuildPath | undefined;
  const steps = path?.steps ?? [];
  const [editing, setEditing] = useState(false);
  const [save, setSave] = useState<SaveState>({ status: "idle", message: "", at: 0 });
  const now = useNow(1000, save.status === "saved");
  const showSave = save.status === "saving" || save.status === "error" || (save.status === "saved" && now - save.at < SAVED_NOTE_MS);

  const completedIds = useMemo(() => new Set(catalog?.completed.map((entry) => entry.id) ?? []), [catalog]);
  const ownedCompleted = active.items.filter((item) => completedIds.size ? completedIds.has(item.id) : item.price >= 900).map((item) => item.name);

  const persist = async (items: string[], done: string) => {
    setSave({ status: "saving", message: "Saving…", at: Date.now() });
    try {
      if (!mock) await saveBuild(active.champion, items);
      setSave({ status: "saved", message: mock ? `${done} (mock — not saved)` : `${done} · updates on next poll`, at: Date.now() });
      setEditing(false);
    } catch (error) {
      setSave({ status: "error", message: error instanceof Error ? error.message : "Save failed.", at: Date.now() });
    }
  };

  const base = path ? SOURCE[path.source] ?? SOURCE.default : null;
  // Top build: say whether it was researched on the web for this patch or comes from the curated table.
  const source = base && path?.source === "meta" && path.meta
    ? { label: `${base.label} · ${path.meta.origin === "researched" ? `researched ${path.meta.patch}` : `curated ${path.meta.patch}`}`, tone: path.meta.outdated ? "warn" as const : base.tone }
    : base;
  const meta = path?.source === "meta" ? path.meta : undefined;
  const pinItems = steps.length ? steps.map((step) => step.item) : ownedCompleted;

  return (
    <div className="build-path">
      <div className="build-path-head">
        <span className="build-path-eyebrow">Your build</span>
        {source && <Badge tone={source.tone}>{path?.source === "pinned" && <Pin size={10} />}{source.label}</Badge>}
        <b title={path?.label}>{path?.label || "No build path yet"}</b>
        <div className="build-path-actions">
          {showSave && <small className={`build-path-save save-${save.status}`}>{save.status === "saving" ? <LoaderCircle className="spin" size={11} /> : save.status === "saved" ? <Check size={11} /> : <X size={11} />}{save.message}</small>}
          {path?.source !== "pinned" && pinItems.length > 0 && !editing && (
            <button type="button" onClick={() => void persist(pinItems.slice(0, MAX_ITEMS), "Pinned")} disabled={save.status === "saving"} title={`Always follow: ${pinItems.join(" → ")}`}><Pin size={11} /> Pin this build</button>
          )}
          {!editing && <button type="button" onClick={() => setEditing(true)}><Pencil size={11} /> Edit</button>}
        </div>
      </div>
      {steps.length > 0 ? (
        <ol className="build-path-steps">
          {steps.map((step, index) => (
            <li key={`${step.itemId}-${index}`} className={`step-${step.status}`} title={step.status === "skipped" && step.note ? `${step.item} · ${step.note}` : `${step.item} · ${step.cost}g · ${step.status}`}>
              <ItemIcon version={version} id={step.itemId} name={step.item} size={36} />
              {step.status === "owned" && <span className="step-check"><Check size={10} strokeWidth={3} /></span>}
              {step.status === "skipped" && <span className="step-check step-locked" aria-label="locked"><X size={10} strokeWidth={3} /></span>}
              <small>{step.status === "next" ? "NEXT" : step.status === "owned" ? "owned" : step.status === "skipped" ? "locked" : `${step.cost}g`}</small>
            </li>
          ))}
        </ol>
      ) : <p className="quiet-copy">Rift Lens has not detected a build for {active.champion} yet — pin one with Edit.</p>}
      {steps.filter((step) => step.status === "skipped" && step.note).map((step, index) => (
        <p key={`skipped-${step.itemId}-${index}`} className="build-path-skipped">{step.item}: {step.note}</p>
      ))}
      {meta && (
        <p className="build-path-sources">
          {meta.origin === "researched" ? `Researched on the web ${meta.checked} (patch ${meta.patch}, ${meta.sample})${meta.outdated ? " · older patch, may be outdated" : ""}` : `Curated table, checked ${meta.checked} (patch ${meta.patch}, ${meta.sample})`}
          {meta.sources.length > 0 && <> · Sources: {meta.sources.map((entry, index) => (
            <span key={entry.url}>{index ? ", " : ""}<a href={entry.url} target="_blank" rel="noreferrer" title={entry.name}>{entry.site}</a></span>
          ))}</>}
        </p>
      )}
      {editing && (
        <BuildEditor
          initial={steps.length ? steps.map((step) => step.item) : ownedCompleted}
          catalog={catalog}
          version={version}
          pinned={path?.source === "pinned"}
          saving={save.status === "saving"}
          onSave={(items) => void persist(items, items.length ? "Saved" : "Unpinned")}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function BuildEditor({ initial, catalog, version, pinned, saving, onSave, onCancel }: {
  initial: string[]; catalog: ItemCatalog | null; version: string; pinned: boolean; saving: boolean;
  onSave: (items: string[]) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => initial.slice(0, MAX_ITEMS));
  const [query, setQuery] = useState("");
  const idFor = (name: string) => catalog?.idByName.get(name.toLowerCase()) ?? null;
  const results = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!wanted || !catalog) return [];
    const taken = new Set(draft.map((name) => name.toLowerCase()));
    return catalog.completed.filter((entry) => !taken.has(entry.name.toLowerCase()) && entry.name.toLowerCase().includes(wanted))
      .sort((left, right) => Number(!left.name.toLowerCase().startsWith(wanted)) - Number(!right.name.toLowerCase().startsWith(wanted)))
      .slice(0, 8);
  }, [query, catalog, draft]);
  const add = (name: string) => { setDraft((list) => list.length >= MAX_ITEMS ? list : [...list, name]); setQuery(""); };
  const move = (index: number, by: number) => setDraft((list) => {
    const next = [...list];
    const target = index + by;
    if (target < 0 || target >= next.length) return list;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  return (
    <div className="build-editor">
      <ol>
        {draft.map((name, index) => (
          <li key={name}>
            <span className="build-editor-index">{index + 1}</span>
            <ItemIcon version={version} id={idFor(name)} name={name} size={26} />
            <b>{name}</b>
            <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${name} up`}><ArrowUp size={12} /></button>
            <button type="button" onClick={() => move(index, 1)} disabled={index === draft.length - 1} aria-label={`Move ${name} down`}><ArrowDown size={12} /></button>
            <button type="button" onClick={() => setDraft((list) => list.filter((entry) => entry !== name))} aria-label={`Remove ${name}`}><X size={12} /></button>
          </li>
        ))}
        {!draft.length && <li className="quiet-copy">Empty — add items below, in buy order.</li>}
      </ol>
      <div className="build-editor-search">
        <Plus size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && results[0]) { event.preventDefault(); add(results[0].name); } if (event.key === "Escape") setQuery(""); }}
          placeholder={catalog ? (draft.length >= MAX_ITEMS ? `Max ${MAX_ITEMS} items` : "Add item — type to search (e.g. Collector)") : "Loading Riot item list…"}
          disabled={!catalog || draft.length >= MAX_ITEMS}
          aria-label="Search items to add"
        />
      </div>
      {results.length > 0 && (
        <div className="build-editor-results">
          {results.map((entry) => (
            <button type="button" key={entry.id} onClick={() => add(entry.name)}>
              <ItemIcon version={version} id={entry.id} name={entry.name} size={22} /><span>{entry.name}</span><small>{entry.cost}g</small>
            </button>
          ))}
        </div>
      )}
      <div className="build-editor-actions">
        <button type="button" className="primary" onClick={() => onSave(draft)} disabled={saving || !draft.length}><Pin size={11} /> Save &amp; pin</button>
        {pinned && <button type="button" onClick={() => onSave([])} disabled={saving}><PinOff size={11} /> Unpin</button>}
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, Pin, RotateCcw, Save, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ItemOption, StoredImport } from "@/lib/item-set-import";

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const MAX_ITEMS = 8;

export function ItemIcon({ name, items, version, size = 28 }: { name: string; items: ItemOption[]; version: string; size?: number }) {
  const item = items.find((entry) => key(entry.name) === key(name));
  if (!item) return <span className="profile-item-chip" title={name}>{name}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="profile-item-icon" src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.id}.png`} alt={name} title={`${name} · ${item.cost}g`} width={size} height={size} loading="lazy" />;
}

function ItemRow({ names, items, version }: { names: string[]; items: ItemOption[]; version: string }) {
  return <div className="profile-item-row">{names.map((name, index) => <ItemIcon key={`${name}-${index}`} name={name} items={items} version={version} />)}</div>;
}

/** Ordered pinned build (≤ 8 completed items, boots allowed); names are validated against the item catalog. */
export function PinnedBuildEditor({ champion, pinned, items, version, busy, onSave }: {
  champion: string;
  pinned: string[];
  items: ItemOption[];
  version: string;
  busy: boolean;
  onSave: (build: string[]) => void;
}) {
  const [draft, setDraft] = useState(pinned);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const wanted = key(query);
    if (!wanted) return [];
    return items.filter((item) => key(item.name).includes(wanted) && !draft.some((name) => key(name) === key(item.name)))
      .sort((a, b) => Number(key(b.name).startsWith(wanted)) - Number(key(a.name).startsWith(wanted)) || a.name.localeCompare(b.name))
      .slice(0, 6);
  }, [items, query, draft]);
  const dirty = draft.join("|") !== pinned.join("|");
  const add = (name: string) => { setDraft((current) => current.length >= MAX_ITEMS ? current : [...current, name]); setQuery(""); };
  const move = (index: number, delta: number) => setDraft((current) => {
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  return (
    <div className="profile-build-editor">
      {draft.length ? (
        <ol className="profile-build-list">
          {draft.map((name, index) => (
            <li key={name}>
              <span className="profile-build-step">{index + 1}</span>
              <ItemIcon name={name} items={items} version={version} size={24} />
              <span className="profile-build-name">{name}</span>
              <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
              <button type="button" aria-label={`Move ${name} down`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => setDraft((current) => current.filter((entry) => entry !== name))}><X size={12} /></button>
            </li>
          ))}
        </ol>
      ) : <p className="profile-quiet">No pinned build. The live coach uses an imported item set, then your history, then your inventory.</p>}
      {draft.length < MAX_ITEMS && (
        <form className="profile-build-search" onSubmit={(event) => { event.preventDefault(); if (matches[0]) add(matches[0].name); }}>
          <input value={query} placeholder={items.length ? "Add an item, e.g. Hexoptics" : "Item data unavailable"} disabled={!items.length} onChange={(event) => setQuery(event.target.value)} />
          {matches.length > 0 && (
            <div className="profile-build-matches">
              {matches.map((item) => (
                <button type="button" key={item.id} onClick={() => add(item.name)}>
                  <ItemIcon name={item.name} items={items} version={version} size={20} /><span>{item.name}</span><small>{item.cost}g</small>
                </button>
              ))}
            </div>
          )}
          {query.trim() && !matches.length && <small className="profile-build-nomatch">No completed item or boots match “{query.trim()}”.</small>}
        </form>
      )}
      <div className="profile-form-actions">
        <Button type="button" variant="ghost" disabled={busy || !dirty} onClick={() => onSave(draft)}><Save size={13} /> Save {champion} build</Button>
        {pinned.length > 0 && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setDraft([]); onSave([]); }}><Trash2 size={13} /> Unpin</Button>}
        {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(pinned)}><RotateCcw size={13} /> Reset</Button>}
      </div>
    </div>
  );
}

export function ImportedBuildView({ build, items, version, busy, pinnedMatches, onPin }: {
  build: StoredImport;
  items: ItemOption[];
  version: string;
  busy: boolean;
  pinnedMatches: boolean;
  onPin: () => void;
}) {
  return (
    <div className="profile-import">
      <div className="profile-import-head">
        <Download size={12} />
        <div><strong>{build.title}</strong><small>{build.mobalytics ? "Mobalytics" : "League client"} item set · captured {new Date(build.capturedAt).toLocaleString()}</small></div>
        <Button type="button" variant="ghost" disabled={busy || pinnedMatches} onClick={onPin}><Pin size={12} /> {pinnedMatches ? "Pinned" : "Pin this build"}</Button>
      </div>
      <ItemRow names={build.items} items={items} version={version} />
      {build.starting.length > 0 && <div className="profile-import-extra"><span>Start</span><ItemRow names={build.starting} items={items} version={version} /></div>}
      {build.situational.length > 0 && <div className="profile-import-extra"><span>Situational</span><ItemRow names={build.situational} items={items} version={version} /></div>}
    </div>
  );
}

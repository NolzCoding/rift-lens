"use client";

import { useEffect, useState } from "react";

export type CatalogEntry = { id: number; name: string; cost: number };
/** completed = Summoner's Rift legendary items + tier-2 boots, for the build editor's search. */
export type ItemCatalog = { costById: Map<number, number>; idByName: Map<string, number>; nameById: Map<number, string>; completed: CatalogEntry[] };

type DdragonItem = { name: string; from?: string[]; tags?: string[]; gold?: { total?: number; purchasable?: boolean }; maps?: Record<string, boolean> };

const cache = new Map<string, Promise<ItemCatalog | null>>();

function load(version: string) {
  let pending = cache.get(version);
  if (!pending) {
    pending = fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`)
      .then((response) => response.ok ? response.json() as Promise<{ data: Record<string, DdragonItem> }> : null)
      .then((json) => {
        if (!json) return null;
        const costById = new Map<number, number>();
        const idByName = new Map<string, number>();
        const nameById = new Map<number, string>();
        const components = new Set(Object.values(json.data).flatMap((item) => item.from ?? []));
        const completed: CatalogEntry[] = [];
        for (const [rawId, item] of Object.entries(json.data)) {
          const id = Number(rawId);
          costById.set(id, item.gold?.total || 0);
          nameById.set(id, item.name);
          const name = item.name.toLowerCase();
          const rift = item.maps?.["11"] && item.gold?.purchasable !== false && id < 100000;
          // Prefer the Summoner's Rift, purchasable, lowest-id variant of each name.
          if (rift && (!idByName.has(name) || id < idByName.get(name)!)) idByName.set(name, id);
          const boots = item.tags?.includes("Boots") && item.from?.includes("1001");
          const legendary = !components.has(rawId) && (item.gold?.total || 0) >= 2000 && Boolean(item.from?.length) && !item.tags?.includes("Consumable");
          if (rift && (boots || legendary) && !completed.some((entry) => entry.name === item.name)) completed.push({ id, name: item.name, cost: item.gold?.total || 0 });
        }
        completed.sort((left, right) => left.name.localeCompare(right.name));
        return { costById, idByName, nameById, completed };
      })
      .catch(() => null);
    cache.set(version, pending);
  }
  return pending;
}

/** Data Dragon item totals and name→id, fetched once per patch. Null until loaded or if offline. */
export function useItemCatalog(version: string | undefined) {
  const [catalog, setCatalog] = useState<ItemCatalog | null>(null);
  useEffect(() => {
    if (!version) return;
    let live = true;
    void load(version).then((result) => { if (live) setCatalog(result); });
    return () => { live = false; };
  }, [version]);
  return catalog;
}

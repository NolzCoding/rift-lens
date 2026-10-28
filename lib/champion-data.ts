export type ChampionEntry = {
  id: string;
  /** Riot's numeric champion id as a string (Data Dragon `key`), e.g. "51" for Caitlyn. */
  key: string;
  name: string;
  tags: string[];
  info: { attack: number; defense: number; magic: number; difficulty: number };
};

export type ChampionIndex = Map<string, ChampionEntry>;

const indexPromises = new Map<string, Promise<ChampionIndex>>();

export function championKey(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Data Dragon champion.json keyed by normalised display name and id; cached per version. Empty map on failure. */
export function loadChampionIndex(version: string): Promise<ChampionIndex> {
  let pending = indexPromises.get(version);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, { next: { revalidate: 21600 }, signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("No champion list");
        const payload = await response.json() as { data?: Record<string, { id?: string; key?: string; name?: string; tags?: string[]; info?: Partial<ChampionEntry["info"]> }> };
        const index: ChampionIndex = new Map();
        for (const raw of Object.values(payload.data || {})) {
          if (!raw.id) continue;
          const entry: ChampionEntry = {
            id: raw.id,
            key: String(raw.key || ""),
            name: raw.name || raw.id,
            tags: raw.tags || [],
            info: { attack: raw.info?.attack || 0, defense: raw.info?.defense || 0, magic: raw.info?.magic || 0, difficulty: raw.info?.difficulty || 0 },
          };
          index.set(championKey(entry.name), entry);
          index.set(championKey(entry.id), entry);
        }
        return index;
      } catch {
        // Retry after a cool-down instead of caching the failure forever (or refetching every poll).
        const retry = setTimeout(() => indexPromises.delete(version), 120_000);
        (retry as { unref?: () => void }).unref?.();
        return new Map();
      }
    })();
    indexPromises.set(version, pending);
  }
  return pending;
}

export function championEntry(index: ChampionIndex | null | undefined, champion: string) {
  return index?.get(championKey(champion)) || null;
}

/** Champion by Riot's numeric id (LCU championId / item-set associatedChampions). */
export function championByNumericKey(index: ChampionIndex | null | undefined, numericKey: number | string) {
  const wanted = String(numericKey);
  if (!index || !wanted || wanted === "0") return null;
  for (const entry of index.values()) if (entry.key === wanted) return entry;
  return null;
}

/** Tag/info-based damage profile: the fallback when no champion-traits table (lib/champion-traits.ts) knows the champion. */
export function inferDamageProfile(entry: ChampionEntry | null): "physical" | "magic" | "mixed" | "unknown" {
  if (!entry) return "unknown";
  const { attack, magic } = entry.info;
  const tags = entry.tags;
  if (attack >= 5 && magic >= 5) return "mixed";
  if (magic - attack >= 3) return "magic";
  if (attack - magic >= 3) return "physical";
  if (tags[0] === "Mage" || (tags.includes("Mage") && tags[0] === "Support")) return "magic";
  if (["Marksman", "Fighter", "Assassin"].includes(tags[0] || "")) return "physical";
  if (attack || magic) return magic > attack ? "magic" : "physical";
  return "unknown";
}

// "Top build" table: entries researched on the web for the current patch (lib/build-research.ts validates them against
// Data Dragon and registers them here at runtime). No champion data lives in this file; curated entries can still be
// passed to the lookup (tests, seed data), see META_BUILDS.
// Lookup precedence: researched for the current patch > curated > researched on an older patch (flagged outdated).
// Pure data + pure helpers (no server imports) so client components can use it too; the researched registry lives on
// globalThis and is only filled on the server (client components pass researched entries in explicitly).

export type MetaRole = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";

export type MetaOption = {
  /** Data Dragon item name. */
  item: string;
  /** % of games on this champion/role that build it, when a source lists it (op.gg items page). */
  pickRate?: number;
  /** Win rate (%) when a source lists it (researched entries). */
  winRate?: number;
  /**
   * Only chosen automatically when this holds (the engine detects "healing"; "heavy-poke" and "situational" are never
   * auto-detected, so those options stay labelled alternatives). An owned conditional option still satisfies its slot.
   */
  when?: "healing" | "heavy-poke" | "situational";
  /** The source's wording of the condition (researched entries), e.g. "vs heavy healing". */
  condition?: string;
  /** One short line for cards/prompts. */
  note?: string;
};

export type MetaSlot = {
  id: string;
  /** e.g. "1st item", "Boots". */
  label: string;
  /** core = the build's backbone (build check flags rarely finishing these); situational = last slot, pick by game state. */
  kind: "core" | "boots" | "flex" | "situational";
  /** Priority order: the first option is the default when the player has no owned/in-progress/history preference. */
  options: MetaOption[];
};

export type MetaBuild = {
  champion: string;
  role: MetaRole;
  /** Patch the data was read on (major.minor). */
  patch: string;
  /** Date the table was last checked by hand. */
  verified: string;
  /** Rank bracket / queue the stats come from. */
  sample: string;
  /** `site` = short site label ("op.gg"); `read` = what was read there (researched entries). */
  sources: Array<{ name: string; url: string; site?: string; read?: string }>;
  /** In buy order; boots are their own slot. */
  slots: MetaSlot[];
  /** Most-played 3-item cores with games and win rate, for the AI and the profile (null = the source did not show it). */
  cores: Array<{ items: string[]; games: number | null; winRate: number | null }>;
  /** Pick-rate facts for items players build that are not in the top build (build check). pickRate null = not listed. */
  offMeta: Array<{ item: string; pickRate: number | null; note: string }>;
  /** Absent = curated (an entry passed in as `lookup.curated`). */
  origin?: "curated" | "researched";
  /** Researched entries: when the web research ran (ISO) and on which Data Dragon version. */
  researchedAt?: string;
  researchedOn?: string;
  /** Researched entries: the sites' patch was neither the current nor the previous Data Dragon patch. */
  stale?: boolean;
  /** Set by the lookup when a researched entry from an older patch is served (no current-patch data). */
  outdated?: boolean;
  /** Starting items (researched entries). */
  starting?: string[];
  /**
   * Set by the lookup when no entry exists for the role the player is in and the champion's build for another role is
   * served instead (e.g. Yone MIDDLE gets the researched TOP build): the role the player is actually in. `role` stays the
   * role the build was made for.
   */
  servedFor?: MetaRole;
};

/**
 * Below this many complete (non-remake, non-partial) games on a champion the player is "new" on it: their history is
 * not a habit worth following yet (it was built while learning), so it never shapes the live build path.
 */
export const NEW_CHAMPION_GAMES = 5;

const ROLE_NAMES: Record<MetaRole, string> = { TOP: "top", JUNGLE: "jungle", MIDDLE: "mid", BOTTOM: "bot", UTILITY: "support" };
/** "top" / "mid" / "bot" / "jungle" / "support". */
export const roleName = (role: MetaRole) => ROLE_NAMES[role];

/**
 * Hand-curated entries. Empty on purpose: champion builds come from the web research for the current patch
 * (lib/build-research.ts → registerResearchedBuilds), triggered in champ select, in a live game and from the Memory page,
 * so every champion is covered the same way. The lookup still accepts curated entries (`lookup.curated`, tests, seed data
 * passed in by a caller) and ranks them between current-patch and older research.
 */
export const META_BUILDS: readonly MetaBuild[] = [];

const norm = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export const META_ROLES: readonly MetaRole[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const STANDARD: readonly string[] = META_ROLES;
export const isMetaRole = (value: unknown): value is MetaRole => typeof value === "string" && STANDARD.includes(value);

/** "16.20.1" / "16.20" / "Patch 16.20" → "16.20"; null when there is no major.minor. */
export function majorMinor(version: string | null | undefined) {
  const match = /(\d+)\.(\d+)/.exec(version || "");
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

// Researched entries, registered by lib/build-research.ts (server only). globalThis so `next dev` reloads keep them.
type ResearchRegistry = { entries: MetaBuild[]; revision: number; version: string | null };
const registry: ResearchRegistry = ((globalThis as { __riftLensMetaResearchV1?: ResearchRegistry }).__riftLensMetaResearchV1 ??= { entries: [], revision: 0, version: null });

/** Replaces the in-memory researched entries (called after loading the store and after each research). */
export function registerResearchedBuilds(entries: MetaBuild[]) {
  registry.entries = entries.filter((entry) => entry.origin === "researched");
  registry.revision += 1;
}
/** The Data Dragon version the lookup treats as current when the caller passes none. */
export function setCurrentMetaVersion(version: string | null) { registry.version = version; }
export const researchedBuilds = (): readonly MetaBuild[] => registry.entries;
/** Bumps whenever the researched entries change (part of the player-brief cache key). */
export const metaRevision = () => registry.revision;

/** A researched entry counts for the current patch when it was researched on it and the sites' data was not stale. */
export function isCurrentResearch(entry: MetaBuild, version: string | null | undefined) {
  if (entry.origin !== "researched" || entry.stale) return false;
  const current = majorMinor(version);
  return !current || majorMinor(entry.researchedOn) === current;
}

type Lookup = { researched?: readonly MetaBuild[]; curated?: readonly MetaBuild[]; version?: string | null };

/**
 * Pure lookup: researched for the current patch > curated > the newest researched entry from an older patch (returned
 * with `outdated: true`). A reported standard role is matched first; with no/unknown role the best entry across the
 * champion's roles is used (curated role first on ties).
 * Role fallback: when the reported role has no entry at all, the champion's build for another role is served (same
 * precedence, `servedFor` = the reported role): a laner's completed items mostly carry over between lanes, and the player's
 * learning-time history is a worse guide. Support builds (a different gold economy and item set) are never swapped in
 * or out.
 */
export function selectMetaBuild(champion: string, position: string | null | undefined, lookup: Lookup = {}): MetaBuild | null {
  const researched = (lookup.researched || []).filter((entry) => norm(entry.champion) === norm(champion));
  const curated = (lookup.curated || META_BUILDS).filter((entry) => norm(entry.champion) === norm(champion));
  const role = (position || "").toUpperCase();
  const best = (inRole: (entry: MetaBuild) => boolean) => {
    const newest = (list: MetaBuild[]) => [...list].sort((a, b) => (b.researchedAt || "").localeCompare(a.researchedAt || ""))[0] || null;
    const current = newest(researched.filter((entry) => inRole(entry) && isCurrentResearch(entry, lookup.version)));
    if (current) return current;
    const hand = curated.find(inRole);
    if (hand) return hand;
    const older = newest(researched.filter(inRole));
    return older ? { ...older, outdated: true } : null;
  };
  if (!isMetaRole(role)) return best(() => true);
  const exact = best((entry) => entry.role === role);
  if (exact || role === "UTILITY") return exact;
  const other = best((entry) => entry.role !== role && entry.role !== "UTILITY");
  return other ? { ...other, servedFor: role } : null;
}

/**
 * The top build for a champion in a role (server: includes researched entries; client: curated only unless the caller
 * uses selectMetaBuild with the researched list). `version` = current Data Dragon version (defaults to the registered one).
 */
export function metaBuildFor(champion: string, position?: string | null, version?: string | null): MetaBuild | null {
  return selectMetaBuild(champion, position, { researched: registry.entries, version: version ?? registry.version });
}

/** True when a current-patch entry exists: a researched one, or a curated one stamped with the current patch. */
export function hasFreshMetaBuild(champion: string, role: MetaRole, version: string, researched: readonly MetaBuild[] = registry.entries, curated: readonly MetaBuild[] = META_BUILDS) {
  const same = (entry: MetaBuild) => norm(entry.champion) === norm(champion) && entry.role === role;
  return researched.some((entry) => same(entry) && isCurrentResearch(entry, version))
    || curated.some((entry) => same(entry) && majorMinor(entry.patch) === majorMinor(version));
}

/** Short provenance for labels: "researched 16.20 (op.gg, lolalytics)" / "curated 16.20". */
export function metaOriginLabel(entry: MetaBuild) {
  const forRole = entry.servedFor ? ` · ${roleName(entry.role)} build` : "";
  if (entry.origin !== "researched") return `curated ${entry.patch}${forRole}`;
  const sites = [...new Set(entry.sources.map((source) => source.site || source.name.split(" ")[0]))].slice(0, 2);
  return `researched ${entry.patch}${sites.length ? ` (${sites.join(", ")})` : ""}${entry.outdated || entry.stale ? " · outdated" : ""}${forRole}`;
}

/** Every item the top build names (any slot, conditional ones included). */
export function metaItemNames(entry: MetaBuild) {
  return [...new Set(entry.slots.flatMap((slot) => slot.options.map((option) => option.item)))];
}

export function isMetaItem(entry: MetaBuild, item: string) {
  return entry.slots.some((slot) => slot.options.some((option) => norm(option.item) === norm(item)));
}

export function metaOption(entry: MetaBuild, item: string): MetaOption | null {
  for (const slot of entry.slots) for (const option of slot.options) if (norm(option.item) === norm(item)) return option;
  return null;
}

/**
 * When the researched numbers may overrule a slot's source order (the slots list options by popularity, not by results).
 * Used only for the default pick among a slot's options (lib/live-game.ts resolveMetaSlots, after owned / invested /
 * heavy-counter / player picks). All thresholds live here.
 */
export const EVIDENCE = {
  /** A core counts as evidence only with at least this many games… */
  minCoreGames: 200,
  /** …and at least this share of the most-played core's games (a 129-game core never outvotes a 1,283-game one). */
  minCoreShare: 0.2,
  /** An option's own win rate counts unless its listed pick rate is below this (%); unlisted pick rate = trusted. */
  minPickRate: 5,
  /** The better-evidenced option must beat the source's first option by at least this many win-rate points. */
  minGap: 1,
} as const;

export type OptionEvidence = {
  /** The option's own win rate in its slot (null = not listed or too small a sample). */
  own: number | null;
  /** The best win rate among the build's cores that contain the item and pass the sample guard. */
  core: { winRate: number; games: number } | null;
};

/** The win-rate evidence the research holds for one item (see EVIDENCE for the sample guard). */
export function optionEvidence(entry: MetaBuild, option: MetaOption): OptionEvidence {
  const own = option.winRate != null && (option.pickRate == null || option.pickRate >= EVIDENCE.minPickRate) ? option.winRate : null;
  const top = Math.max(0, ...entry.cores.map((core) => core.games || 0));
  const minGames = Math.max(EVIDENCE.minCoreGames, top * EVIDENCE.minCoreShare);
  let core: OptionEvidence["core"] = null;
  for (const entryCore of entry.cores) {
    if (entryCore.winRate == null || entryCore.games == null || entryCore.games < minGames) continue;
    if (!entryCore.items.some((item) => norm(item) === norm(option.item))) continue;
    if (!core || entryCore.winRate > core.winRate) core = { winRate: entryCore.winRate, games: entryCore.games };
  }
  return { own, core };
}

/**
 * The best-evidenced option among `options` (in the source's order): the first option unless another beats it by
 * EVIDENCE.minGap win-rate points on comparable evidence — both options' own win rates, else both options' best core
 * win rates. Mixed evidence (one own, one core) never decides: a 3-item core's win rate runs higher than a single slot's.
 * `gap` = the winning margin (0 when the source order stands).
 */
export function evidencePick(entry: MetaBuild, options: MetaOption[]): { index: number; gap: number; kind: "own" | "core" | null } {
  if (options.length < 2) return { index: 0, gap: 0, kind: null };
  const base = optionEvidence(entry, options[0]);
  let best = { index: 0, gap: 0, kind: null as "own" | "core" | null };
  options.forEach((option, index) => {
    if (!index) return;
    const challenger = optionEvidence(entry, option);
    const [gap, kind] = challenger.own != null && base.own != null ? [challenger.own - base.own, "own" as const]
      : challenger.core && base.core ? [challenger.core.winRate - base.core.winRate, "core" as const] : [0, null];
    if (kind && gap >= EVIDENCE.minGap && gap > best.gap) best = { index, gap: Math.round(gap * 10) / 10, kind };
  });
  return best;
}

/** How many minor patches the meta data is behind a Data Dragon version ("16.22.1" vs "16.20" → 2). A newer season counts as far behind. */
export function metaPatchLag(entry: MetaBuild, dataDragonVersion: string) {
  const [metaMajor, metaMinor] = entry.patch.split(".").map(Number);
  const [major, minor] = dataDragonVersion.split(".").map(Number);
  if (![metaMajor, metaMinor, major, minor].every(Number.isFinite)) return 0;
  if (major !== metaMajor) return major > metaMajor ? 99 : 0;
  return Math.max(0, minor - metaMinor);
}

/** Caveat when the table is 2+ patches old, or a researched entry is from an older patch / stale (still used). */
export function metaPatchNote(entry: MetaBuild, dataDragonVersion: string) {
  if (entry.origin === "researched" && (entry.outdated || entry.stale)) return `Researched build data from ${entry.patch} — may be outdated`;
  return metaPatchLag(entry, dataDragonVersion) >= 2 ? `Meta build data from ${entry.patch} — may be outdated` : null;
}

const pct = (value: number) => `${Math.round(value)}%`;
const share = (value: number) => value >= 10 ? pct(value) : `${value}%`;

/** "Yun Tal Wildarrows: 4.6% of Caitlyns build it" / "Essence Reaver: not among the items op.gg lists for Caitlyn". */
function fact(entry: MetaBuild, item: string, pickRate: number | null | undefined, note?: string) {
  return pickRate != null ? `${share(pickRate)} of ${entry.champion}s build it` : note || `not in the top ${entry.champion} build`;
}

export type BuildCheckEntry = { item: string; games: number; of: number; pickRate: number | null; fact: string; text: string };
export type BuildCheck = {
  champion: string;
  patch: string;
  /** Items (or boots) the player finished in 2+ games that the top build does not use. */
  offMeta: BuildCheckEntry[];
  /** Core top-build slots where the player finished none of the options in a third of their games (named by the most-built option). */
  rareCore: BuildCheckEntry[];
};

/**
 * Compares what the player finishes (per-game counts over `games` complete games) with the top build.
 * `boots` = upgraded boots per game (counted the same way).
 */
export function buildCheck(
  entry: MetaBuild,
  history: { finished: Array<{ item: string; games: number }>; boots: Array<{ item: string; games: number }>; games: number },
): BuildCheck | null {
  const of = Math.max(history.games, ...history.finished.map((row) => row.games), 0);
  if (!of) return null;
  const finishedBy = new Map(history.finished.map((row) => [norm(row.item), row.games]));
  const games = (count: number) => `${count} of ${of} game${of === 1 ? "" : "s"}`;
  const offMeta: BuildCheckEntry[] = [
    ...history.finished.map((row) => ({ ...row, verb: "finished it" })),
    ...history.boots.map((row) => ({ ...row, verb: "bought them" })),
  ]
    .filter((row) => row.games >= 2 && !isMetaItem(entry, row.item))
    .sort((a, b) => b.games - a.games)
    .map((row) => {
      const known = entry.offMeta.find((item) => norm(item.item) === norm(row.item));
      const text = fact(entry, row.item, known?.pickRate, known?.note);
      return { item: row.item, games: row.games, of, pickRate: known?.pickRate ?? null, fact: text, text: `${row.item}: ${text} — you ${row.verb} in ${games(row.games)}` };
    });
  // A core slot is judged as a whole: finishing any of its options counts (The Collector instead of Hexoptics is fine).
  // When none of them reaches a third of the games, the slot's most-built option is named with the player's count for it.
  const rareCore: BuildCheckEntry[] = entry.slots
    .filter((slot) => slot.kind === "core")
    .flatMap((slot) => {
      const options = slot.options.filter((option) => !option.when);
      const best = Math.max(0, ...options.map((option) => finishedBy.get(norm(option.item)) || 0));
      const top = [...options].sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0))[0];
      if (!top || best * 3 >= of) return [];
      const count = finishedBy.get(norm(top.item)) || 0;
      const text = fact(entry, top.item, top.pickRate);
      return [{ item: top.item, games: count, of, pickRate: top.pickRate ?? null, fact: text, text: `${top.item}: ${text} — you finished it in ${games(count)}` }];
    });
  return { champion: entry.champion, patch: entry.patch, offMeta, rareCore };
}

/** One short line for the AI brief, or "" when the player's builds already match. */
export function buildCheckLine(check: BuildCheck | null) {
  if (!check || (!check.offMeta.length && !check.rareCore.length)) return "";
  // Compact: "Yun Tal Wildarrows 3/12 (4.6% of Caitlyns)"; an item no source lists reads "unlisted".
  const row = (entry: BuildCheckEntry) => `${entry.item} ${entry.games}/${entry.of}${entry.pickRate != null ? ` (${share(entry.pickRate)} of ${check.champion}s)` : " (unlisted)"}`;
  const off = check.offMeta.map(row).join(", ");
  const rare = check.rareCore.map(row).join(", ");
  return `Build check (top build ${check.patch}): ${[off && `off-meta ${off}`, rare && `rarely finished ${rare}`].filter(Boolean).join("; ")}.`;
}

/** Compact form for AI prompts. */
export function metaPromptPacket(entry: MetaBuild, dataDragonVersion?: string) {
  const condition = (item: MetaOption) => item.when === "healing" ? "heavy healing" : item.when === "heavy-poke" ? "heavy poke" : item.condition || "situational";
  const option = (item: MetaOption) => `${item.item}${item.pickRate != null ? ` (${share(item.pickRate)})` : ""}${item.when ? ` [only ${item.when === "situational" ? "" : "vs "}${condition(item)}]` : ""}`;
  const stats = (core: MetaBuild["cores"][number]) => [core.games != null ? `${core.games} games` : "", core.winRate != null ? `${core.winRate}% WR` : ""].filter(Boolean).join(", ");
  // Researched free text (option notes, "what was read") came from web pages: only item names, numbers and short
  // conditions reach the coach's prompt, never the notes.
  const researched = entry.origin === "researched";
  return {
    champion: entry.champion,
    role: entry.role,
    patch: entry.patch,
    sample: entry.sample,
    verified: entry.verified,
    origin: researched ? `web research on Data Dragon ${entry.researchedOn || "?"} from ${[...new Set(entry.sources.map((source) => source.site || source.name.split(" ")[0]))].join(", ")}` : "curated",
    slots: entry.slots.map((slot) => `${slot.label}: ${slot.options.map(option).join(" | ")}`),
    topCores: entry.cores.map((core) => `${core.items.join(" + ")}${stats(core) ? ` (${stats(core)})` : ""}`),
    offMeta: entry.offMeta.map((item) => `${item.item}: ${item.pickRate != null ? `${item.pickRate}% pick rate` : researched ? "rarely built" : item.note}`),
    outdated: dataDragonVersion ? metaPatchNote(entry, dataDragonVersion) || undefined : undefined,
  };
}

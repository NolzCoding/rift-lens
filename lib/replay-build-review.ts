// Post-game build review for one player on any champion: the final inventory against Rift Lens's own knowledge.
//  - the top build for the champion + role (lib/meta-builds.ts; researched or curated, with the role fallback),
//  - the champion's damage scaling (an AP item on an AD champion is a misfit, unless the top build itself lists it),
//  - exclusive item groups (lib/item-groups.ts: an off-meta pick that locked a top-build item),
//  - the enemy team's items (lib/enemy-stats.ts enemyThreatProfile): counters they needed and counters they didn't. A
//    "needed" counter uses the live coach's own bar (counterLevel "act" = heavy) and, when the live recorder captured the
//    match, the enemy items over time (when the signal turned heavy, and what was bought after that).
// Pure apart from the item-group table (read synchronously); every input is passed in so tests can use synthetic data.
import { counterLevel, counterSignalFor, profileSummary, signalReason, THREAT_THRESHOLDS, type CounterSignal, type EnemyProfile, type EnemyProfileSummary } from "@/lib/enemy-stats";
import { conflict, conflicts } from "@/lib/item-groups";
import { COUNTER_PRIORITY, itemFitsScaling, type ChampionScaling } from "@/lib/live-game";
import { metaOriginLabel, roleName, isMetaRole, type MetaBuild, type MetaOption, type MetaSlot } from "@/lib/meta-builds";
import type { BuildFinding, BuildItemVerdict, BuildReview } from "@/lib/types";

export type ReviewItem = {
  id: number;
  name: string;
  cost: number;
  from?: number[];
  into?: number[];
  tags?: string[];
  scaling?: "ad" | "ap" | "hybrid" | "neutral";
  carry?: boolean;
};
export type ReviewCatalog = { byId: Map<number, ReviewItem> };
type Profile = EnemyProfile | EnemyProfileSummary;

export type BuildReviewInput = {
  participantId: number;
  champion: string;
  /** TEAM_POSITION as the replay reports it (TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY, or ""). */
  role: string;
  itemIds: number[];
  catalog: ReviewCatalog;
  scaling: ChampionScaling;
  meta: MetaBuild | null;
  /** Null when the enemy team's items or Data Dragon stats were unavailable. */
  enemyProfile: Profile | null;
  /** Completed items in purchase order with game seconds (the live recorder), when the match was recorded. */
  completedOrder?: Array<{ itemId: number; item: string; time: number }>;
  /** The enemy team's profile over the game (raw live capture), oldest first; absent when the match was not captured. */
  enemyTimeline?: Array<{ time: number; profile: Profile }>;
};

const norm = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const round5 = (value: number) => Math.round(value / 5) * 5;
const listText = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "");

/** Upgraded boots (basic Boots is a component). */
export const isBoots = (item: ReviewItem) => Boolean(item.tags?.includes("Boots")) && item.id !== 1001;
/** A finished item: builds into nothing, and is either 2000g+ or an upgrade of other items (support/role item upgrades). */
export const isCompleted = (item: ReviewItem) => !isBoots(item) && !item.into?.length && (item.cost >= 2000 || Boolean(item.from?.length));

/** Counters that do little when the threat is absent: owning one with no matching threat is worth a note. */
const HARD_COUNTERS = new Set<CounterSignal>(["armorStack", "mrStack", "healing", "hardCc", "armorBoots", "mrBoots"]);

const THREAT_WORDS: Record<CounterSignal, string> = {
  armorStack: "stacked armor", mrStack: "stacked magic resist", hpStack: "big health pools", healing: "heavy healing",
  burstThreat: "burst damage", hardCc: "hard crowd control", poke: "long-range poke", armorBoots: "physical damage", mrBoots: "magic damage",
};

/** The threat behind a counter showed up in the enemy team's final items (boots use the softer "named alternative" threshold). */
function signalFired(profile: Profile, signal: CounterSignal) {
  const physical = THREAT_THRESHOLDS.physical;
  if (signal === "armorBoots") return profile.physicalShare.share >= physical.bootsArmorAlt;
  if (signal === "mrBoots") return profile.physicalShare.share <= physical.bootsMagicAlt;
  return profile[signal].level !== "none";
}

/** Why a counter was not needed, with the closest number ("no enemy stacked armor (most: Galio ~140)"). */
function absentReason(profile: Profile, signal: CounterSignal) {
  const share = Math.round(profile.physicalShare.share * 100);
  switch (signal) {
    case "armorStack": {
      const top = profile.armorStack.perEnemy[0];
      return `no enemy stacked armor${top ? ` (most: ${top.champion} ~${round5(top.armor)})` : ""}`;
    }
    case "mrStack": {
      const top = profile.mrStack.perEnemy[0];
      return `no enemy stacked magic resist${top ? ` (most: ${top.champion} ~${round5(top.magicResist)})` : ""}`;
    }
    case "healing": return "their team had little healing";
    case "hardCc": return "their team had little hard crowd control";
    case "armorBoots": return `only ~${share}% of their damage was physical`;
    case "mrBoots": return `only ~${100 - share}% of their damage was magic`;
    default: return `their team showed no ${THREAT_WORDS[signal]}`;
  }
}

type Assigned = { slotIndex: number; slot: MetaSlot; option: MetaOption };

/**
 * Each owned item fills at most one top-build slot and each slot takes one item (bipartite matching, slots in buy
 * order), so Immortal Shieldbow can count as the 1st item while Infinity Edge fills the 2nd.
 */
function assignSlots(meta: MetaBuild, owned: ReviewItem[]) {
  const slotOwner = new Map<number, number>();
  const ownerSlot = new Map<number, number>();
  const candidates = owned.map((item) => meta.slots.flatMap((slot, index) => (slot.options.some((option) => norm(option.item) === norm(item.name)) ? [index] : [])));
  const tryItem = (itemIndex: number, seen: Set<number>): boolean => {
    for (const slotIndex of candidates[itemIndex]) {
      if (seen.has(slotIndex)) continue;
      seen.add(slotIndex);
      const holder = slotOwner.get(slotIndex);
      if (holder === undefined || tryItem(holder, seen)) {
        slotOwner.set(slotIndex, itemIndex);
        ownerSlot.set(itemIndex, slotIndex);
        return true;
      }
    }
    return false;
  };
  // Items in slot order of their earliest option, so the natural reading wins ties.
  const order = owned.map((_, index) => index).sort((a, b) => (candidates[a][0] ?? 99) - (candidates[b][0] ?? 99));
  for (const index of order) if (candidates[index].length) tryItem(index, new Set());
  const byItem = new Map<number, Assigned>();
  for (const [itemIndex, slotIndex] of ownerSlot) {
    const slot = meta.slots[slotIndex];
    const option = slot.options.find((entry) => norm(entry.item) === norm(owned[itemIndex].name))!;
    byItem.set(itemIndex, { slotIndex, slot, option });
  }
  return { byItem, filled: new Set(slotOwner.keys()) };
}

function findOption(meta: MetaBuild | null, name: string) {
  if (!meta) return null;
  for (const [slotIndex, slot] of meta.slots.entries()) {
    const option = slot.options.find((entry) => norm(entry.item) === norm(name));
    if (option) return { slotIndex, slot, option };
  }
  return null;
}

const isStandard = (option: MetaOption) => !option.when;
/**
 * The threat an item answers: the item's own mapping first (Blade of The Ruined King answers health stacking even when a
 * researched entry labels its option "healing"), the top-build option's condition only for items the mapping lacks.
 */
const signalOf = (item: string, option?: MetaOption | null) => counterSignalFor(item) ?? (option ? counterSignalFor(item, option.when, option.condition) : null);
const scalingWords: Record<ChampionScaling, string> = { ad: "physical (AD)", ap: "magic (AP)", tank: "tank", hybrid: "mixed" };

function itemStatWord(item: ReviewItem) {
  if (item.scaling === "ap") return "ability power";
  if (item.carry) return "crit/lethality";
  if (item.scaling === "ad") return "attack damage";
  return "stats";
}

function pickRateText(meta: MetaBuild, option: MetaOption | null) {
  return option?.pickRate != null ? ` · ${option.pickRate >= 10 ? Math.round(option.pickRate) : option.pickRate}% of ${meta.champion}s build it` : "";
}

/**
 * A counter item that fits the champion and is not locked by what they own (nor by `claimed`, counters already suggested
 * for a stronger need); top-build options first.
 */
function suggestCounter(input: BuildReviewInput, signal: CounterSignal, ownedIds: number[], claimed: number[] = []): ReviewItem | null {
  const boots = signal === "armorBoots" || signal === "mrBoots";
  const fits = (item: ReviewItem) => (boots ? isBoots(item) : isCompleted(item)) && itemFitsScaling(item, input.scaling)
    && !conflict(item.id, ownedIds.filter((id) => !(boots && input.catalog.byId.get(id) && isBoots(input.catalog.byId.get(id)!))), claimed);
  const byName = new Map([...input.catalog.byId.values()].map((item) => [norm(item.name), item]));
  for (const slot of input.meta?.slots || []) {
    for (const option of slot.options) {
      const item = byName.get(norm(option.item));
      if (item && signalOf(option.item, option) === signal && fits(item)) return item;
    }
  }
  // Items built on the champion's own damage stat first (Morellonomicon before Thornmail on a mage), then the cheapest.
  // An offensive counter (penetration, anti-heal, %-health) for a damage dealer must carry its damage stat, as in the live
  // coach: a marksman's anti-heal is never a tank item.
  const own = (item: ReviewItem) => (item.scaling === input.scaling ? 0 : 1);
  const offensive = signal === "armorStack" || signal === "mrStack" || signal === "healing" || signal === "hpStack";
  const dealer = input.scaling === "ad" || input.scaling === "ap";
  const carriesDamage = (item: ReviewItem) => !offensive || !dealer || item.scaling === input.scaling || item.scaling === "hybrid";
  const any = [...input.catalog.byId.values()].filter((item) => counterSignalFor(item.name) === signal && fits(item) && carriesDamage(item))
    .sort((a, b) => own(a) - own(b) || a.cost - b.cost || a.name.localeCompare(b.name));
  return any[0] || null;
}

const GAP_TITLES: Partial<Record<CounterSignal, (profile: Profile) => string>> = {
  healing: (profile) => `No anti-heal vs ${profile.healing.reasons[0] || "their healing"}`,
  armorStack: () => "No armor penetration vs their armor",
  mrStack: () => "No magic penetration vs their magic resist",
  burstThreat: (profile) => `No defensive item vs ${profile.burstThreat.threats.slice(0, 2).join(" + ") || "their burst"}`,
  hardCc: (profile) => `Nothing against ${profile.hardCc.champions.slice(0, 2).join(" + ") || "their"} crowd control`,
  armorBoots: () => "Armor boots would have helped",
  mrBoots: () => "Magic-resist boots would have helped",
};

export function reviewBuild(input: BuildReviewInput): BuildReview {
  const { catalog, meta, enemyProfile: profile, champion } = input;
  const resolve = (id: number): ReviewItem => catalog.byId.get(id) || (id >= 100000 ? catalog.byId.get(id % 10000) || catalog.byId.get(id % 100000) : undefined) || { id, name: `Item ${id}`, cost: 0 };
  const owned = input.itemIds.map(resolve);
  const ownedIds = owned.map((item) => item.id);
  const finished = owned.map((item, index) => ({ item, index })).filter(({ item }) => isCompleted(item) || isBoots(item));
  const assignment = meta ? assignSlots(meta, finished.map(({ item }) => item)) : { byItem: new Map<number, Assigned>(), filled: new Set<number>() };
  const slotFor = new Map<number, Assigned>();
  finished.forEach(({ index }, position) => { const hit = assignment.byItem.get(position); if (hit) slotFor.set(index, hit); });
  const findings: BuildFinding[] = [];
  const role = isMetaRole(input.role) ? roleName(input.role) : "";

  const items: BuildItemVerdict[] = owned.map((item, index): BuildItemVerdict => {
    const base = { itemId: item.id, item: item.name };
    if (!isCompleted(item) && !isBoots(item)) {
      const into = (item.into || []).map((id) => catalog.byId.get(id)?.name).filter(Boolean) as string[];
      return {
        ...base, kind: "component", tone: "info", label: "Unfinished",
        reason: into.length ? `A component (builds into ${listText(into.slice(0, 2))}${into.length > 2 ? "…" : ""}): fine if you were saving for the next item.` : "An early item still taking a slot at the end of the game.",
      };
    }
    const slotted = slotFor.get(index) || null;
    const listed = slotted || findOption(meta, item.name);
    const signal = signalOf(item.name, listed?.option);
    const fits = itemFitsScaling(item, input.scaling);
    if (!fits && !listed) {
      findings.push({ kind: "misfit", tone: "bad", title: `${item.name} doesn't fit ${champion}`, detail: `${champion} deals ${scalingWords[input.scaling]} damage; ${item.name}'s ${itemStatWord(item)} goes mostly unused.` });
      return { ...base, kind: "misfit", tone: "bad", label: "Wrong stats", reason: `${champion} scales with ${scalingWords[input.scaling]} damage; ${item.name} gives ${itemStatWord(item)} it can't use well.` };
    }
    if (signal && profile) {
      if (signalFired(profile, signal)) {
        return { ...base, kind: "counter", tone: "good", label: "Good counter", reason: `Right call: ${signalReason(profile, signal)}.${listed ? ` Also in the top build (${listed.slot.label}).` : ""}` };
      }
      if (HARD_COUNTERS.has(signal)) {
        const absent = absentReason(profile, signal);
        const slotAlternative = listed && isStandard(listed.option)
          ? listed.slot.options.find((option) => option !== listed.option && isStandard(option) && !HARD_COUNTERS.has(signalOf(option.item, option) as CounterSignal))
          : null;
        if (!listed || !isStandard(listed.option) || slotAlternative) {
          const better = slotAlternative ? ` ${slotAlternative.item} was the better pick for that slot.` : "";
          findings.push({ kind: "counter-unneeded", tone: "warn", title: `${item.name} but ${absent.replace(/ \(.*\)$/, "")}`, detail: `${item.name} is for ${THREAT_WORDS[signal]}, but ${absent}.${better}` });
          return { ...base, kind: "situational", tone: "warn", label: "Not needed", reason: `${item.name} is for ${THREAT_WORDS[signal]}, but ${absent}.${better}` };
        }
      }
    }
    if (listed && meta) {
      const conditional = listed.option.when ? ` (situational: ${listed.option.condition || listed.option.when})` : "";
      const kind = listed.slot.kind === "boots" ? "boots" : listed.slot.kind === "core" ? "core" : "meta";
      const label = kind === "boots" ? "Top-build boots" : kind === "core" ? "Core item" : "Top build";
      return { ...base, kind, tone: "good", label, reason: `${listed.slot.label} in the top ${champion} build${conditional}${pickRateText(meta, listed.option)}.` };
    }
    if (meta) {
      const known = meta.offMeta.find((entry) => norm(entry.item) === norm(item.name));
      const share = known?.pickRate != null ? ` Only ${known.pickRate}% of ${champion}s build it.` : "";
      return { ...base, kind: "off-meta", tone: "warn", label: "Off-meta", reason: `Not in the top ${champion}${role ? ` ${role}` : ""} build.${share}` };
    }
    return { ...base, kind: "unrated", tone: "info", label: "Fits", reason: `No top build is saved for ${champion} yet, so this is only checked for fit: it suits ${champion}'s ${scalingWords[input.scaling]} damage.` };
  });

  const offMeta = items.filter((entry) => entry.kind === "off-meta").map((entry) => entry.item);
  if (offMeta.length) findings.push({ kind: "off-meta", tone: "warn", title: `Off-meta: ${listText(offMeta)}`, detail: `${listText(offMeta)} ${offMeta.length > 1 ? "are" : "is"} not in the top ${champion} build.` });

  // Top-build slots left empty, and exclusive-group locks behind them.
  const completedCount = finished.filter(({ item }) => isCompleted(item)).length;
  if (meta) {
    let position = 0;
    meta.slots.forEach((slot, slotIndex) => {
      if (slot.kind === "boots") {
        if (!assignment.filled.has(slotIndex) && !owned.some(isBoots) && completedCount >= 2) {
          findings.push({ kind: "missing-core", tone: "warn", title: "No boots", detail: `You finished ${completedCount} items without upgraded boots; the top build buys ${slot.options[0]?.item || "boots"}.` });
        }
        return;
      }
      position += 1;
      if (assignment.filled.has(slotIndex)) return;
      const standard = slot.options.filter(isStandard);
      for (const option of standard) {
        const target = [...catalog.byId.values()].find((entry) => norm(entry.name) === norm(option.item));
        if (!target || ownedIds.includes(target.id)) continue;
        const lock = conflict(target.id, ownedIds, []);
        if (!lock?.owned) continue;
        const blockers = lock.blocking.map((id) => resolve(id)).filter((blocker) => {
          const where = findOption(meta, blocker.name);
          return !where || !isStandard(where.option);
        });
        if (!blockers.length) continue;
        const names = blockers.map((blocker) => blocker.name);
        findings.push({
          kind: "group-lock", tone: "warn", title: `Your ${listText(names)} locked ${option.item}`,
          detail: `League allows ${lock.max === 1 ? "one" : lock.max} ${lock.label} item${lock.max === 1 ? "" : "s"} per inventory: ${listText(names)} took the place of ${option.item}, the top build's ${slot.label}.`,
        });
        break;
      }
      if (slot.kind === "core" && completedCount >= position && standard.length) {
        findings.push({ kind: "missing-core", tone: "warn", title: `No ${standard[0].item}`, detail: `The top ${champion} build's ${slot.label} is ${standard.map((option) => option.item).join(" or ")}; you finished ${completedCount} items without it.` });
      }
    });
  }

  // Two held items from one exclusive group (League normally refuses this; flags stale data or mode quirks).
  const clashSeen = new Set<string>();
  owned.forEach((item, index) => {
    const others = ownedIds.filter((_, at) => at !== index);
    for (const clash of conflicts(item.id, others, [])) {
      const names = [item.name, ...clash.blocking.map((id) => resolve(id).name)];
      const keyText = `${clash.group}:${[...names].sort().join("|")}`;
      if (clashSeen.has(keyText)) continue;
      clashSeen.add(keyText);
      findings.push({ kind: "group-clash", tone: "bad", title: `${listText(names)} share the ${clash.label} group`, detail: `League allows ${clash.max === 1 ? "one" : clash.max} ${clash.label} item${clash.max === 1 ? "" : "s"}; one of these slots is wasted.` });
    }
  });

  // Buy order vs the top build (needs the recorded purchase times).
  if (meta && input.completedOrder?.length) {
    const slotIndexOf = (name: string) => {
      const position = finished.findIndex(({ item }) => norm(item.name) === norm(name));
      const hit = position >= 0 ? assignment.byItem.get(position) : null;
      return hit && hit.slot.kind !== "boots" ? hit : null;
    };
    const ordered = input.completedOrder.map((entry) => ({ ...entry, slot: slotIndexOf(entry.item) })).filter((entry) => entry.slot);
    outer: for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const early = ordered[i];
        const late = ordered[j];
        if (early.slot!.slotIndex > late.slot!.slotIndex) {
          findings.push({
            kind: "order", tone: "warn", title: `You bought ${early.item} before ${late.item}`,
            detail: `The top build gets ${late.item} first (its ${late.slot!.slot.label}) and ${early.item} later (${early.slot!.slot.label}). You finished ${early.item} at ${clock(early.time)} and ${late.item} at ${clock(late.time)}.`,
          });
          break outer;
        }
      }
    }
  }

  // Counters the enemy team called for that the build never answered. The same decision as the live coach
  // (lib/enemy-stats.ts counterLevel): only a heavy signal ("act") is a gap; "some" is context the enemy-signal list already
  // shows. With the recorded timeline the signal is read over the game (from the first moment it turned heavy, and what
  // you finished after that), not only from the enemies' final items.
  if (profile) {
    const ownedSignals = new Set(owned.map((item) => counterSignalFor(item.name)).filter(Boolean) as CounterSignal[]);
    const relevant: CounterSignal[] = ["healing", "burstThreat", "hardCc", "armorBoots", "mrBoots"];
    if (input.scaling === "ad" || input.scaling === "hybrid") relevant.push("armorStack");
    if (input.scaling === "ap" || input.scaling === "hybrid") relevant.push("mrStack");
    // The live engine's order decides which counter claims an exclusive group when two compete (lib/live-game.ts).
    relevant.sort((a, b) => COUNTER_PRIORITY.indexOf(a) - COUNTER_PRIORITY.indexOf(b));
    const timeline = input.enemyTimeline || [];
    const claimed: Array<{ item: ReviewItem; signal: CounterSignal }> = [];
    for (const signal of relevant) {
      if (ownedSignals.has(signal)) continue;
      if (signal === "hardCc" && ownedSignals.has("mrBoots")) continue;
      if ((signal === "armorBoots" || signal === "mrBoots") && !owned.some(isBoots)) continue;
      const boots = signal === "armorBoots" || signal === "mrBoots";
      // Boots are one decision: the signal when you bought them (else from when it turned heavy).
      const bootsBuy = boots ? (input.completedOrder || []).find((entry) => isBoots(resolve(entry.itemId))) : undefined;
      const atBuy = bootsBuy ? [...timeline].reverse().find((entry) => entry.time <= bootsBuy.time) : undefined;
      const onset = atBuy && counterLevel(atBuy.profile, signal) === "act" ? atBuy : timeline.find((entry) => counterLevel(entry.profile, signal) === "act") || null;
      if (!onset && counterLevel(profile, signal) !== "act") continue;
      const at = onset?.profile || profile;
      const when = onset === atBuy && bootsBuy ? `When you bought ${bootsBuy.item} at ${clock(bootsBuy.time)}: `
        : onset ? onset.time < 60 ? "From the start: " : `From ~${clock(Math.round(onset.time / 30) * 30)}: ` : timeline.length ? "By the end of the game: " : "";
      // What you finished once it was heavy: the purchases that could have been the counter.
      const after = onset && !boots ? (input.completedOrder || []).filter((entry) => entry.time >= onset.time && !isBoots(resolve(entry.itemId))) : [];
      const decided = onset && !boots && input.completedOrder ? after.length
        ? ` You finished ${listText(after.slice(0, 2).map((entry) => `${entry.item} at ${clock(entry.time)}`))} after that.`
        : " You finished no item after that, so this is for next time." : "";
      // Never two counters from one max-1 group: an earlier (stronger) need keeps its pick; this one gets an item outside
      // that group, or a one-line trade-off.
      const free = suggestCounter(input, signal, ownedIds, claimed.map((entry) => entry.item.id));
      const blocked = free ? null : suggestCounter(input, signal, ownedIds, []);
      const lock = blocked ? conflict(blocked.id, [], claimed.map((entry) => entry.item.id)) : null;
      const rival = lock ? claimed.find((entry) => lock.blocking.includes(entry.item.id)) : null;
      if (free) claimed.push({ item: free, signal });
      const tradeOff = blocked && lock && rival
        ? ` ${blocked.name} would answer it too, but it shares the ${lock.label} group with ${rival.item.name} (one per inventory), and ${THREAT_WORDS[rival.signal]} came first.`
        : "";
      const tone: BuildFinding["tone"] = signal === "armorBoots" || signal === "mrBoots" || (onset && input.completedOrder && !after.length) ? "warn" : "bad";
      if (signal === "healing") {
        // sources: "Soraka" (a healing champion) or "Zaahen: Sundered Sky" (a healing item).
        const fromItems = at.healing.sources.filter((source) => source.includes(": ")).map((source) => { const [who, what] = source.split(": "); return `${what} (${who})`; });
        const healers = at.healing.sources.filter((source) => !source.includes(": ") && !fromItems.some((entry) => entry.endsWith(`(${source})`)));
        const parts = [healers.length ? `${listText(healers)} heal${healers.length === 1 ? "s" : ""} by kit` : "", fromItems.length ? `healing items: ${fromItems.slice(0, 4).join(", ")}` : ""].filter(Boolean);
        const text = parts.join("; ");
        findings.push({ kind: "counter-gap", tone, title: GAP_TITLES.healing!(at), detail: `${when}${when ? text : text.replace(/^./, (first) => first.toUpperCase())}.${decided}${free ? ` ${free.name} cuts healing (Grievous Wounds) and fits ${champion}.` : tradeOff}` });
        continue;
      }
      const reason = signalReason(at, signal);
      findings.push({
        kind: "counter-gap", tone, title: GAP_TITLES[signal]!(at),
        detail: `${when}${when ? reason : reason.replace(/^./, (first) => first.toUpperCase())}.${decided}${free ? ` ${free.name} fits ${champion}.` : tradeOff}`,
      });
    }
  }

  const order: Record<BuildFinding["kind"], number> = { "counter-gap": 0, misfit: 1, "group-clash": 2, "group-lock": 3, "missing-core": 4, order: 5, "counter-unneeded": 6, "off-meta": 7 };
  const toneOrder: Record<BuildFinding["tone"], number> = { bad: 0, warn: 1, info: 2, good: 3 };
  findings.sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone] || order[a.kind] - order[b.kind]);

  return {
    participantId: input.participantId,
    champion,
    role: input.role,
    scaling: input.scaling,
    topBuild: meta ? {
      label: `Top ${meta.champion} ${roleName(meta.role)} build · ${metaOriginLabel(meta)}`,
      role: meta.servedFor || meta.role,
      builtFor: meta.servedFor ? meta.role : null,
      slots: meta.slots.map((slot, slotIndex) => {
        const holder = finished.find((_, position) => assignment.byItem.get(position)?.slotIndex === slotIndex);
        const standard = slot.options.filter(isStandard);
        return { label: slot.label, kind: slot.kind, options: (standard.length ? standard : slot.options).map((option) => option.item), matched: holder?.item.name || null };
      }),
    } : null,
    items,
    findings,
    enemySignals: profile ? profileSummary(profile).filter((line) => !/^damage /.test(line)) : [],
  };
}

// HELP ME build helpers: the compact build-path packet, the AI candidate item pool and server-side resolution of AI buys.
import { conflict, filledGroups } from "@/lib/item-groups";
import { findItem, itemRecipe, nextPurchaseToward, type ItemCatalog, type ItemInfo } from "@/lib/live-game";
import type { LiveGameSnapshot, LiveHelpAdvice, LiveResolvedBuy } from "@/lib/types";

type Active = LiveGameSnapshot["activePlayer"];
type Family = "ad" | "ap" | "tank";
type Timing = LiveResolvedBuy["timing"];

const TIMINGS: readonly Timing[] = ["next-recall", "first-item-goal", "later-conditional", "endgame-swap"];
const POOL_CAP = 40;
const ANTI_HEAL = new Set(["mortalreminder", "chempunkchainsword", "morellonomicon", "thornmail"]);
const ROLE_TAGS: Record<string, string[]> = {
  Marksman: ["CriticalStrike", "AttackSpeed", "Damage", "LifeSteal", "ArmorPenetration", "OnHit"],
  Mage: ["SpellDamage", "Mana", "MagicPenetration", "AbilityHaste"],
  Assassin: ["Damage", "ArmorPenetration", "AbilityHaste", "NonbootsMovement", "SpellDamage", "MagicPenetration"],
  Fighter: ["Damage", "Health", "AbilityHaste", "LifeSteal", "SpellVamp", "ArmorPenetration"],
  Tank: ["Health", "Armor", "SpellBlock", "HealthRegen", "AbilityHaste"],
  Support: ["ManaRegen", "Aura", "Active", "AbilityHaste", "Health", "SpellDamage"],
};
const AD_TAGS = ["Damage", "CriticalStrike", "AttackSpeed", "ArmorPenetration", "OnHit"];
const DEF_TAGS = ["Armor", "SpellBlock", "MagicResist", "Tenacity"];

export const itemKey = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const has = (item: ItemInfo, ...tags: string[]) => tags.some((tag) => item.tags?.includes(tag));
const label = (item: ItemInfo) => `${item.name} ${item.cost}`;
const isBoots = (item: ItemInfo) => has(item, "Boots") && Boolean(item.from?.includes(1001));
const isConsumable = (item: ItemInfo) => has(item, "Consumable", "Trinket") || item.cost < 500;

function fitsFamily(item: ItemInfo, family: Family) {
  if (family === "ap") return has(item, "SpellDamage");
  if (family === "ad") return has(item, ...AD_TAGS) && !has(item, "SpellDamage");
  return has(item, "Health", "Armor", "SpellBlock") && !has(item, "Damage", "SpellDamage", "CriticalStrike");
}

/** Damage family from the player's own path + inventory first, then roles / damage profile. */
function familyOf(snapshot: LiveGameSnapshot, catalog: ItemCatalog): Family {
  const active = snapshot.activePlayer;
  const votes = { ad: 0, ap: 0, tank: 0 };
  const items = [...(snapshot.buildPath?.steps ?? []).map((step) => catalog.byId.get(step.itemId)), ...active.items.map((item) => catalog.byId.get(item.id))];
  for (const item of items) {
    if (!item || item.cost < 900 || isBoots(item)) continue;
    if (has(item, "SpellDamage")) votes.ap += 1; else if (has(item, ...AD_TAGS)) votes.ad += 1; else if (has(item, "Health", "Armor", "SpellBlock")) votes.tank += 1;
  }
  const roles = active.roles ?? [];
  if (roles[0] === "Tank") votes.tank += 2;
  else if (roles.includes("Marksman") || active.damageProfile === "physical") votes.ad += 2;
  else if (roles.includes("Mage") || active.damageProfile === "magic") votes.ap += 2;
  else if (active.stats) votes[active.stats.abilityPower > active.stats.attackDamage ? "ap" : "ad"] += 1;
  return (Object.entries(votes) as Array<[Family, number]>).sort((left, right) => right[1] - left[1])[0][0];
}

function completedItems(catalog: ItemCatalog) {
  const all = [...catalog.byId.values()];
  const components = new Set(all.flatMap((item) => item.from ?? []));
  const done = all.filter((item) => !components.has(item.id) && item.cost >= 2000 && Boolean(item.from?.length) && !isConsumable(item));
  // Offline fallback catalog has no recipes/tags: every listed item is a completed legendary.
  return done.length ? done : all.filter((item) => item.cost >= 2000);
}

/** ≤ 40 real completed Summoner's Rift items worth considering for this champion, grouped by purpose. */
export function candidatePool(snapshot: LiveGameSnapshot, catalog: ItemCatalog) {
  const active = snapshot.activePlayer;
  const family = familyOf(snapshot, catalog);
  const brief = snapshot.playerBrief;
  const excluded = new Set<number>([...active.items.map((item) => item.id), ...(snapshot.buildPath?.steps ?? []).map((step) => step.itemId)]);
  for (const name of brief?.avoidItems ?? []) { const found = findItem(catalog, name); if (found) excluded.add(found.id); }
  // Items League would refuse (an exclusive group the inventory fills) never reach the model.
  const held = counts(active);
  const recipe = itemRecipe(catalog);
  for (const item of catalog.byId.values()) if (!excluded.has(item.id) && conflict(item.id, held, [], recipe)) excluded.add(item.id);
  const roles = active.roles ?? [];
  const roleTags = new Set(roles.flatMap((role) => ROLE_TAGS[role] ?? []));
  // Squishy carries rarely want bruiser health items; resist/tenacity count toward the defensive group.
  const squishy = roles.some((role) => role === "Marksman" || role === "Mage") && !roles.some((role) => role === "Fighter" || role === "Tank");
  const support = roles.includes("Support");
  const score = (item: ItemInfo) => (item.tags ?? []).filter((tag) => roleTags.has(tag)).length - (squishy && has(item, "Health") ? 2 : 0)
    - (!support && has(item, "ManaRegen", "Aura") ? 1 : 0) + (has(item, ...DEF_TAGS) ? 1 : 0);
  const ranked = completedItems(catalog).filter((item) => !excluded.has(item.id) && (fitsFamily(item, family) || (!item.tags?.length)))
    .sort((left, right) => score(right) - score(left) || left.cost - right.cost);
  const minCore = roleTags.size ? 2 : -Infinity;
  const taken = new Set<number>();
  const take = (items: ItemInfo[], cap: number) => items.filter((item) => !taken.has(item.id)).slice(0, cap).map((item) => { taken.add(item.id); return item; });
  const antiHeal = take(ranked.filter((item) => ANTI_HEAL.has(itemKey(item.name)) || /grievous/i.test(item.description ?? "")), 2);
  const penetration = take(ranked.filter((item) => has(item, family === "ap" ? "MagicPenetration" : "ArmorPenetration") && family !== "tank" && score(item) >= minCore), 3);
  const defense = take(ranked.filter((item) => (has(item, ...DEF_TAGS) || (family === "tank" && has(item, "Health"))) && score(item) >= minCore), 6);
  const ownsBoots = active.items.some((item) => { const info = catalog.byId.get(item.id); return info ? isBoots(info) : false; });
  const boots = ownsBoots ? [] : [...catalog.byId.values()].filter((item) => isBoots(item) && !excluded.has(item.id) && (family === "ap" ? !has(item, "AttackSpeed") : !has(item, "MagicPenetration"))).sort((left, right) => left.cost - right.cost);
  const core = take(ranked.filter((item) => score(item) >= minCore), POOL_CAP - antiHeal.length - penetration.length - defense.length - boots.length);
  return { family, core: core.map(label), defense: defense.map(label), antiHeal: antiHeal.map(label), penetration: penetration.map(label), boots: boots.map(label) };
}

/** buildPath for the prompt: ["Noonquiver [owned]", "Hexoptics C44 [next]", "The Collector"]. */
export function buildPathPacket(snapshot: LiveGameSnapshot) {
  const path = snapshot.buildPath;
  if (!path?.steps?.length) return undefined;
  return {
    source: path.source, label: path.label,
    steps: path.steps.map((step) => `${step.item}${step.status === "later" ? "" : step.status === "skipped" ? ` [skipped: locked${step.note ? `, ${step.note.replace(/^Skipped:\s*/, "").replace(/\.$/, "")}` : ""}]` : ` [${step.status}]`}`),
  };
}

/**
 * Exclusive item groups the inventory fills, for the prompt:
 * ["Last Whisper: owns Mortal Reminder → Lord Dominik's Regards, Serylda's Grudge, Black Cleaver, Terminus, Last Whisper locked"].
 * Components the owned item builds from are not listed (they would be used up, not refused).
 */
export function lockedGroups(snapshot: LiveGameSnapshot, catalog: ItemCatalog): string[] {
  const name = (id: number) => catalog.byId.get(id)?.name || `item ${id}`;
  const labels = new Set<string>();
  // Boots and BootsWithoutActives say the same thing: one line per label.
  const groups = filledGroups(counts(snapshot.activePlayer), (id) => catalog.byId.has(id), itemRecipe(catalog))
    .filter((group) => !labels.has(group.label) && Boolean(labels.add(group.label)));
  return groups.map((group) => {
    // Most expensive first: the completed items are what the model might name.
    const locked = [...group.locked].sort((left, right) => (catalog.byId.get(right)?.cost ?? 0) - (catalog.byId.get(left)?.cost ?? 0));
    const shown = locked.slice(0, 6).map(name).join(", ");
    return `${group.label}: owns ${group.owned.map(name).join(" + ")} → ${shown}${locked.length > 6 ? ` +${locked.length - 6} more` : ""} locked`;
  });
}

/** Gold value of owned items inside target's recipe tree (each owned copy counted once). */
function ownedValue(target: ItemInfo, counts: Map<number, number>, catalog: ItemCatalog, depth = 0): number {
  if (depth > 3) return 0;
  return (target.from ?? []).reduce((sum, id) => {
    const count = counts.get(id) ?? 0;
    if (count > 0) { counts.set(id, count - 1); return sum + (catalog.byId.get(id)?.cost ?? 0); }
    const child = catalog.byId.get(id);
    return sum + (child ? ownedValue(child, counts, catalog, depth + 1) : 0);
  }, 0);
}

function inTree(target: ItemInfo, id: number, catalog: ItemCatalog, depth = 0): boolean {
  if (depth > 3) return false;
  return (target.from ?? []).some((child) => child === id || (catalog.byId.has(child) && inTree(catalog.byId.get(child)!, id, catalog, depth + 1)));
}

const counts = (active: Active) => {
  const map = new Map<number, number>();
  for (const item of active.items) map.set(item.id, (map.get(item.id) ?? 0) + Math.max(1, item.count));
  return map;
};

const warned = new Set<string>();
function warnUnknown(name: string) {
  const id = itemKey(name);
  if (!id || warned.has(id)) return;
  warned.add(id);
  console.warn(`[live-help] dropped AI item not in the Riot catalog: "${name.slice(0, 60)}"`);
}

const warnedLocked = new Set<string>();
function warnLocked(name: string, blocking: string[]) {
  const id = `${itemKey(name)}:${blocking.map(itemKey).join(",")}`;
  if (warnedLocked.has(id)) return;
  warnedLocked.add(id);
  console.warn(`[live-help] dropped AI buy locked by an exclusive item group: ${name} (owns ${blocking.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Gold-figure sanitizer: the model has done wrong arithmetic ("keep 2578g"). Rift Lens renders every gold number from the
// engine (buys, deathMoment, swapPlan), so AI prose keeps the reasons and loses the figures.
// ---------------------------------------------------------------------------

// "1,960g", "3200 g", "250 gold", optionally "about"/"over"/"at least"; never item names (C44) or clocks (12:55).
const AMT = String.raw`(?:(?:about|around|roughly|approximately|nearly|almost|over|under|only|just|exactly|at least|at most|~)\s+)?\d{1,3}(?:,\d{3})+(?:\s?g\b|\s+gold\b)|(?:(?:about|around|roughly|approximately|nearly|almost|over|under|only|just|exactly|at least|at most|~)\s+)?\d+(?:\s?g\b|\s+gold\b)`;
const amount = new RegExp(AMT, "i");
// The recurring-issue threshold quoted from playerBrief ("1000g+", "1,000g or more", "at least 1000g") is a fixed rule, not arithmetic.
const THRESHOLD = /\b(?:at least\s+)?1,?000\s?g(?:\+|\s+or\s+more\b)|\bat least\s+1,?000\s?g\b/gi;
const KEEP = "\u0001";
// Words that can follow a figure without the figure being an adjective ("spend the 3204g you hold", "your 2302g covers").
const NOT_A_NOUN = "you|your|during|on|in|into|is|are|was|were|held|covers?|available|now|to|for|before|after|at|and|or|so|then|from|using|with|of|per|left|short|more|less|unspent|unused|banked|is|will|would|should|can|could|fits?|lets?|gives?|buys?";
const rx = (source: string) => new RegExp(source.replaceAll("AMT", `(?:${AMT})`), "gi");

const GOLD_RULES: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  // "Dagger (250 gold)" → "Dagger"
  [rx(String.raw`\s*\(\s*AMT\s*\)`), ""],
  // Zero: "You have 0g" → "You have no gold", "At 0 gold," → "With no gold,", bare "you have 0, so" → "you have no gold, so"
  [/\b(have|has|had|hold|holding|held)\s+0\s?(?:g|gold)\b/gi, "$1 no gold"],
  [/\b(?:at|with)\s+0\s?(?:g|gold)\b/gi, "with no gold"],
  [/\b(have|has)\s+0\b(?![:.,]?\d)/gi, "$1 no gold"],
  [/\b0\s?(?:g|gold)\b/gi, "no gold"],
  // Shortfalls: "209g short" → "short", "need 209g more" → "need more gold", "250 more is needed", "1000g more than yours"
  [rx(String.raw`AMT\s+(more|less)\s+than`), "$1 than"],
  [rx(String.raw`\b(needs?|needing)\s+(?:AMT|\d[\d,]*)\s+more\b`), "$1 more gold"],
  [/\b\d[\d,]*\s+more\s+(is|are)\s+needed\b/gi, "more gold $1 needed"],
  [rx(String.raw`AMT\s+(short)\b`), "$1"],
  [rx(String.raw`AMT\s+more\b`), "more gold"],
  [rx(String.raw`AMT\s+(?:is\s+)?(needed|missing)\b`), "more gold $1"],
  // The model's own arithmetic: ", and keep 2578g" / ", leaving 1100g" / "The swap plan leaves 2374g"
  [rx(String.raw`[,;]\s*(?:and\s+|then\s+)?(?:keep|keeping|leave|leaving|left with)\s+(?:you\s+(?:with\s+)?)?AMT(?:\s+(?:left(?:\s+over)?|spare|remaining|banked))?`), ""],
  [rx(String.raw`\s+and\s+(?:keep|leave)\s+(?:you\s+(?:with\s+)?)?AMT(?:\s+(?:left(?:\s+over)?|spare|remaining))?`), ""],
  [rx(String.raw`\b(leaves?|leaving|left)\s+(?:you\s+(?:with\s+)?)?(?:over\s+)?AMT`), "$1 some gold"],
  // "Costs 875g from your 980g and advances…" → "Advances…"; "Costs 75g after Pickaxe" → "Buy it after Pickaxe"
  [rx(String.raw`(^|[.!?]\s+)Costs?\s+AMT(?:\s+from\s+(?:your\s+)?AMT)?\s+and\s+`), "$1"],
  [rx(String.raw`(^|[.!?]\s+)Costs?\s+AMT\s+`), "$1Buy it "],
  [rx(String.raw`\s+costs?\s+AMT\s+and\s+`), " "],
  [rx(String.raw`AMT\s+from\s+(?:your\s+)?AMT`), "your gold"],
  // "Death purchase: 75g for vision" → "Death purchase: vision"; "target: 250 gold." → "target is on the buy card."
  [rx(String.raw`:\s*AMT\s+for\s+`), ": "],
  [rx(String.raw`([A-Za-z])\s*:\s*AMT(?=\s*[.;,]|$)`), "$1 is on the buy card"],
  [rx(String.raw`\b(is|are)\s+AMT(?=\s*[.;,]|$)`), "$1 on the buy card"],
  [rx(String.raw`\bcosts?\s+AMT(?=\s*[.;,]|$)`), "is on the buy card"],
  [rx(String.raw`\blists\s+AMT(?=\s*[.;,]|$)`), "lists it"],
  // "aim for at least 350g", "reach 350g", "Save 250 gold" → "save up"
  [rx(String.raw`\b(?:aim|save|reach)\s+(?:for\s+)?AMT`), "save up"],
  // "the 350g Long Sword step", "its 2050g remaining cost", "Infinity Edge's 3,500g cost": the figure is an adjective
  [rx(String.raw`\b(your|the|its|a|an|this|that|their|listed)\s+(?:listed\s+)?AMT\s+(?!(?:${NOT_A_NOUN})\b(?!-))(?=[A-Za-z])`), "$1 "],
  [rx(String.raw`('s)\s+AMT\s+(?!(?:${NOT_A_NOUN})\b(?!-))(?=[A-Za-z])`), "$1 "],
  // "sell Hexoptics C44 for 1960g" / "Affordable at 350g" / "for the listed 1400g"
  [rx(String.raw`,?\s*\b(?:for|at|costing|cost of|priced at)\s+(?:(?:the|its|a|their)\s+)?(?:listed\s+|remaining\s+|supplied\s+)?AMT`), ""],
  // "about 3199g unspent" → "unspent gold"; "1463g in pocket" → "gold in pocket"
  [rx(String.raw`AMT\s+(unspent|unused|banked)`), "$1 gold"],
  [rx(String.raw`AMT\s+(in\s+(?:your\s+)?pocket)`), "gold $1"],
  // Whatever is left keeps its verb: "spend this 2,087g" → "spend this gold", "with 2333g" → "with your gold", "holding 2,087g" → "holding gold"
  [rx(String.raw`\b(spend|spending|carry|carrying|bank)\s+(?:(the|this|your|that|available)\s+)?AMT`), (_match, verb: string, determiner?: string) => `${verb} ${determiner || "your"} gold`],
  [rx(String.raw`\bwith\s+AMT`), "with your gold"],
  [rx(String.raw`\b(the|this|your|that)\s+AMT`), "$1 gold"],
  [rx(String.raw`AMT`), "gold"],
];

function tidy(text: string) {
  return text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?=[.;:,])/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[,;:]\s*/, "")
    .replace(/^\s*(?:and|then|so)\s+/i, "")
    .replace(/([.!?]\s+)(?:and|then)\s+/g, "$1")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`)
    .replace(/\byour your\b/gi, "your")
    .trim();
}

/** Removes gold figures from one AI string, keeping item names, clocks and the 1000g+ issue threshold. */
export function sanitizeGoldText(text: string): string {
  if (!amount.test(text) && !/\b0\s?(?:g|gold)\b|\b(?:have|has)\s+0\b|\d\s+more\s+(?:is|are)\s+needed/i.test(text)) return text;
  const kept: string[] = [];
  // Placeholder uses letters so no digit rule can touch it.
  let out = text.replace(THRESHOLD, (match) => { kept.push(match); return `${KEEP}${String.fromCharCode(65 + kept.length - 1)}${KEEP}`; });
  for (const [pattern, replacement] of GOLD_RULES) out = out.replace(pattern, replacement as string);
  out = tidy(out);
  return out.replace(new RegExp(`${KEEP}([A-Z])${KEEP}`, "g"), (_, letter: string) => kept[letter.charCodeAt(0) - 65]);
}

// Fields that hold names, enums or the player's own question: never rewritten.
const UNTOUCHED = new Set(["item", "targetItem", "champion", "timing", "priority", "question"]);

/** Deep copy of the advice with every prose string passed through sanitizeGoldText. */
export function sanitizeAdvice<T>(value: T, key = ""): T {
  if (typeof value === "string") return (UNTOUCHED.has(key) ? value : sanitizeGoldText(value)) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeAdvice(entry, key)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, sanitizeAdvice(entry, field)])) as T;
  }
  return value;
}

/**
 * The AI's recommendedPath is shown as an item list, so every entry must be a real item. Splits glued entries
 * ("Infinity Edge 📌 - Զ Guardian Angel (recall lane quickly) - Maw…"), drops notes/noise, keeps catalog names only.
 */
export function cleanRecommendedPath(path: string[], catalog: ItemCatalog): string[] {
  const names: string[] = [];
  for (const entry of path) {
    for (const part of entry.split(/\s+[-–—>→|]\s+|\s*[,;]\s*/)) {
      const text = part.replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}'’. -]/gu, " ").replace(/\s+/g, " ").trim();
      const item = text.length >= 3 ? findItem(catalog, text) : null;
      if (item && !names.includes(item.name)) names.push(item.name);
    }
  }
  return names;
}

/** Validates AI buyOptions against the catalog and turns each into a concrete purchase for the current gold. */
/** Item names the AI tells the player to sell ("sell Long Sword for 245g", "selling Hexoptics C44 → …"). */
function soldNames(reason: string) {
  const names: string[] = [];
  for (const match of reason.matchAll(/\bsell(?:ing)?\s+(?:your\s+|the\s+)?([A-Za-z0-9'’. -]{3,40}?)(?=\s+(?:for|to|and|then|at|into|so)\b|\s*[,.;:(+→]|\s*->|$)/gi)) names.push(match[1].trim());
  return names;
}

export function resolveBuys(review: Pick<LiveHelpAdvice, "buyOptions">, snapshot: LiveGameSnapshot, catalog: ItemCatalog): LiveResolvedBuy[] {
  const active = snapshot.activePlayer;
  const gold = Math.max(0, Math.floor(active.currentGold));
  const owned = counts(active);
  const avoid = new Set((snapshot.playerBrief?.avoidItems ?? []).map((name) => findItem(catalog, name)?.id).filter(Boolean));
  const steps = snapshot.buildPath?.steps ?? [];
  const pathIds = new Set(steps.map((step) => findItem(catalog, step.item)?.id ?? step.itemId));
  const pathHasBoots = steps.some((step) => { const info = catalog.byId.get(step.itemId) ?? findItem(catalog, step.item); return info ? isBoots(info) : false; });
  const recipe = itemRecipe(catalog);
  const seen = new Set<string>();
  const buys: LiveResolvedBuy[] = [];
  for (const option of review.buyOptions ?? []) {
    if (!option || typeof option.item !== "string") continue;
    const named = option.item.trim() ? findItem(catalog, option.item) : null;
    const target = (option.targetItem?.trim() ? findItem(catalog, option.targetItem) : null) ?? named;
    if (!named && option.item.trim()) warnUnknown(option.item);
    if (option.targetItem?.trim() && !findItem(catalog, option.targetItem)) warnUnknown(option.targetItem);
    if (!target || avoid.has(target.id)) continue;
    // Never pass on "sell X, then buy X back": X is the target, part of its recipe, or an owned step of the player's path.
    const resold = soldNames(typeof option.reason === "string" ? option.reason : "")
      .map((name) => findItem(catalog, name))
      .find((sold) => sold && (sold.id === target.id || inTree(target, sold.id, catalog) || (pathIds.has(sold.id) && (owned.get(sold.id) ?? 0) > 0)));
    if (resold) { console.warn(`[live-help] dropped AI sell-then-rebuy: ${resold.name} → ${target.name}`); continue; }
    const completed = !isConsumable(target) && (target.cost >= 2000 || isBoots(target));
    if (completed && (owned.get(target.id) ?? 0) > 0) continue;
    // One build: a completed item off the build path is dropped (the path already takes a counter item when its threat is
    // heavy), so the AI never shows a second build next to the path, the buy card and the death shop.
    if (completed && pathIds.size > 0 && !pathIds.has(target.id) && !(isBoots(target) && !pathHasBoots)) {
      console.warn(`[live-help] dropped off-path AI buy: ${target.name}`);
      continue;
    }
    // League refuses a purchase that overflows an exclusive group (Lord Dominik's Regards or its Last Whisper while
    // owning Mortal Reminder).
    const targetClash = conflict(target.id, owned, [], recipe);
    if (targetClash) { warnLocked(target.name, targetClash.blocking.map((id) => catalog.byId.get(id)?.name ?? String(id))); continue; }
    let buy: { id: number; name: string; cost: number };
    if (named && named.id !== target.id && inTree(target, named.id, catalog)) {
      buy = { id: named.id, name: named.name, cost: named.cost };
    } else {
      const costNow = Math.max(0, target.cost - ownedValue(target, new Map(owned), catalog));
      const step = target.from?.length && gold < costNow ? nextPurchaseToward(target, active, catalog) : null;
      buy = step ? { id: step.itemId, name: step.item, cost: step.cost } : { id: target.id, name: target.name, cost: costNow };
    }
    const buyClash = buy.id === target.id ? null : conflict(buy.id, owned, [], recipe);
    if (buyClash) { warnLocked(buy.name, buyClash.blocking.map((id) => catalog.byId.get(id)?.name ?? String(id))); continue; }
    const id = `${buy.id}:${target.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    buys.push({
      item: buy.name, itemId: buy.id, cost: buy.cost,
      targetItem: target.name, targetItemId: target.id, targetCost: target.cost,
      timing: TIMINGS.includes(option.timing) ? option.timing : "later-conditional",
      reason: typeof option.reason === "string" ? option.reason.slice(0, 320) : "",
      affordable: gold >= buy.cost, goldNeeded: Math.max(0, buy.cost - gold),
      // Off-path completed items were dropped above.
      deviation: false,
    });
    if (buys.length >= 3) break;
  }
  return buys;
}

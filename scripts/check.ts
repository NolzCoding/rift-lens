// Replay invariant suite. Run from the project folder:
//   node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings scripts/check.ts [--verbose]
// Replays every raw capture (<memory>/raw/*.jsonl) and every recorded game (<memory>/games/*.json) through
// normalizeLiveData (with the real getPlayerBrief, and again with no brief), and checks engine invariants on every sample.
// Exit code 1 when any invariant fails; 0 when all pass or when Data Dragon is unreachable (skipped).
import { configureItemGroups, conflict, groupsOf, itemGroupsStatus } from "@/lib/item-groups";
import { findItem, getItemCatalog, isSpectating, isUpgradedBoots as isEngineBoots, itemFitsScaling, itemRecipe, normalizeLiveData, type ItemCatalog } from "@/lib/live-game";
import { memoryRoot } from "@/lib/memory-store";
import { ensureResearchLoaded } from "@/lib/build-research";
import { counterSignalFor, signalHeavy } from "@/lib/enemy-stats";
import { configureChampionTraits } from "@/lib/champion-traits";
import { isMetaItem, metaBuildFor } from "@/lib/meta-builds";
import { getPlayerBrief } from "@/lib/player-profile";
import type { LiveGameSnapshot, PlayerBrief } from "@/lib/types";

import { isCompletedId, loadRawGames, loadRecords, recordGame, type ReplayGame, type ReplaySample } from "./replay-data";

const verbose = process.argv.includes("--verbose");
const key = (value = "") => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const CONTROL_WARD = 2055;

type Failure = { game: string; time: number; note: string; detail: string };
const stats = new Map<string, { pass: number; fail: Failure[] }>();
const INVARIANTS: Record<string, string> = {
  rec0_not_owned: "recommendations[0] is not an item already owned",
  rec0_next_step_not_owned: "recommendations[0].nextStep is not a component already owned in enough copies",
  rec0_is_path_next: "recommendations[0] is the buildPath 'next' step",
  path_next_not_owned: "buildPath 'next'/'later' steps are not owned (any upgraded boots satisfy a boots step)",
  death_buy_not_owned: "deathMoment.buyNow never re-buys an owned completed item / surplus component",
  no_avoid_items: "no avoided item in recommendations, nextStep, buildPath next/later, buyNow",
  no_sold_rebuy: "a completed item sold this game is never recommended or put back on the path",
  swap_no_sell_rebuy: "swapPlan.sellItem is owned, a known catalog item worth gold, not named on the path, not in the target's recipe tree, not an owned path step, not in an un-owned path step's tree",
  swap_gold_math: "swapPlan gold fields are consistent (availableGoldAfterSale, affordable, goldNeeded, goldAfter)",
  death_moment_presence: "deathMoment is non-null exactly while the active player is dead",
  death_buy_within_gold: "sum(deathMoment.buyNow.cost) <= gold",
  death_goals_consistent: "goals: costNow <= cost, spendNow <= costNow, remainingAfter = max(0, costNow - spendNow) >= 0",
  death_goals_on_path: "every deathMoment goal is an un-owned buildPath step, the boots checkpoint or recommendations[0] (one build on the death screen and alive)",
  path_no_flip: "the un-owned buildPath never changes back to the arrangement it had two changes ago (threat estimates wobbling across a threshold)",
  objectives_sane: "objective countdowns never negative; nextSpawnAt only on respawning/not-spawned",
  objectives_ruleset: "Swiftplay: Baron 12:00 / Elder 15:00, no grubs/herald/atakhan; SR: no atakhan",
  names_resolve: "every item name in buildPath/recommendations/mobility/buyNow/goals resolves via findItem to the same name",
  boots_early: "no upgraded boots after the first completed item => upgraded boots within the first 2 un-owned path steps",
  meta_conditional_heavy: "top-build path: an un-owned conditional option (Mortal Reminder, Gluttonous Greaves…) is on the path only when its enemy signal is heavy",
  meta_no_offmeta: "any champion with a top build and no pinned/imported build: the path follows it and never holds an un-owned item the build lists as off-meta",
  no_group_conflict: "no recommendation/nextStep/path next-or-later step/buyNow/boots card overflows an exclusive item group with owned items; the path never holds two items of a max-1 group",
  item_fits_scaling: "no recommendation or un-owned path step names an item that does not fit the champion's scaling (AP item on an AD champion…) unless pinned or preferred",
  heavy_counter_visible: "a heavy armor/MR signal with a fitting, unlocked counter item (snapshot.counterPicks) puts that item in the top 3 cards, with a buy, a swap plan or a sell/finish-first line",
};
for (const name of Object.keys(INVARIANTS)) stats.set(name, { pass: 0, fail: [] });
/** Per replay game: the un-owned path arrangements in the order they appeared (path_no_flip). */
const pathHistory = new Map<string, Array<{ arrangement: string; inventory: string }>>();

function check(name: string, ok: boolean, game: string, sample: ReplaySample, detail: () => string) {
  const entry = stats.get(name)!;
  if (ok) entry.pass += 1;
  else entry.fail.push({ game, time: sample.time, note: sample.note, detail: detail() });
}

/** How many copies of `id` the fully expanded recipe of `root` uses. */
function treeCount(catalog: ItemCatalog, rootId: number, id: number, depth = 0): number {
  let count = 0;
  for (const child of catalog.byId.get(rootId)?.from || []) {
    if (child === id) count += 1;
    else if (depth < 4) count += treeCount(catalog, child, id, depth + 1);
  }
  return count;
}
function tree(catalog: ItemCatalog, rootId: number, out = new Set<number>(), depth = 0) {
  for (const child of catalog.byId.get(rootId)?.from || []) {
    out.add(child);
    if (depth < 4) tree(catalog, child, out, depth + 1);
  }
  return out;
}
// Same rule as the engine: tier-3 boots (Gunmetal Greaves…) have no "Boots" tag in Data Dragon.
const isUpgradedBoots = (catalog: ItemCatalog, id: number) => { const item = catalog.byId.get(id); return Boolean(item && isEngineBoots(item)); };

function checkSample(game: ReplayGame, sample: ReplaySample, snap: LiveGameSnapshot, catalog: ItemCatalog) {
  const g = game.name;
  const c = (name: string, ok: boolean, detail: () => string) => check(name, ok, g, sample, detail);
  const items = snap.activePlayer.items;
  const owned = new Map<number, number>();
  for (const item of items) owned.set(item.id, (owned.get(item.id) || 0) + Math.max(1, item.count));
  const ownedNames = items.map((item) => item.name).join(", ") || "(empty)";
  const hasBoots = items.some((item) => isUpgradedBoots(catalog, item.id));
  const brief: PlayerBrief | null = snap.playerBrief;
  const avoid = new Set((brief?.avoidItems || []).map(key));
  const pinned = new Set((brief?.pinnedBuild || []).map(key));
  const sold = new Set(sample.sold.filter((id) => isCompletedId(catalog, id) && !owned.has(id)));
  const steps = snap.buildPath.steps;
  const unowned = steps.filter((step) => step.status !== "owned");
  const recs = [...snap.recommendations, ...(snap.mobilityRecommendation ? [snap.mobilityRecommendation] : [])];
  const r0 = snap.recommendations[0];
  const pathText = () => steps.map((step) => `${step.item}(${step.status[0]})`).join(" > ");

  // --- ownership ---
  if (r0) c("rec0_not_owned", r0.itemId === CONTROL_WARD || !owned.has(r0.itemId), () => `rec0 ${r0.item} is owned; inv=[${ownedNames}]`);
  if (r0?.nextStep && r0.nextStep.itemId !== r0.itemId) {
    const next = r0.nextStep;
    const need = treeCount(catalog, r0.itemId, next.itemId);
    c("rec0_next_step_not_owned", (owned.get(next.itemId) || 0) < Math.max(1, need),
      () => `rec0 ${r0.item} nextStep ${next.item}: own ${owned.get(next.itemId) || 0}, recipe needs ${need}; inv=[${ownedNames}]`);
  }
  const pathNext = steps.find((step) => step.status === "next");
  // The game-start buy (Doran's + potion) comes before the path.
  if (r0 && pathNext && !r0.starting) c("rec0_is_path_next", r0.itemId === pathNext.itemId, () => `rec0=${r0.item} (${r0.action}) but path next=${pathNext.item}; path=${pathText()}; inv=[${ownedNames}]`);
  for (const step of unowned) {
    const isOwned = owned.has(step.itemId) || (hasBoots && isUpgradedBoots(catalog, step.itemId));
    c("path_next_not_owned", !isOwned, () => `step ${step.item} marked ${step.status} but owned; path=${pathText()}`);
  }

  // --- one build ---
  for (const goal of snap.deathMoment?.goals || []) {
    // The buy card's item counts too: past a fully owned path, both screens name the same extra item.
    const onPath = unowned.some((step) => step.itemId === goal.itemId) || isUpgradedBoots(catalog, goal.itemId) || goal.itemId === r0?.itemId;
    c("death_goals_on_path", onPath, () => `death goal ${goal.item} is not an un-owned path step; path=${pathText()}`);
  }
  const arrangement = unowned.filter((step) => step.status !== "skipped").map((step) => step.item).join(" > ");
  // The with-memory and no-brief runs of a sample build different paths: one history each.
  const track = `${g}${sample.note.endsWith("no-brief") ? " no-brief" : ""}`;
  const seen = pathHistory.get(track) || [];
  const inventory = [...owned.keys()].sort((a, b) => a - b).join(",");
  const last = seen.at(-1);
  if (last?.arrangement !== arrangement) {
    // Buying the counter the path had added brings the old arrangement back legitimately: only a return with the
    // inventory unchanged since the last change is a flip.
    const flip = seen.length >= 2 && seen.at(-2)!.arrangement === arrangement && last!.inventory === inventory;
    c("path_no_flip", !flip, () => `path went back to ${arrangement} (was ${last?.arrangement}); inv=[${ownedNames}]`);
    seen.push({ arrangement, inventory });
    pathHistory.set(track, seen);
  }

  // --- avoid / sold ---
  const named: Array<[string, string]> = [
    ...recs.map((rec) => [rec.item, "recommendation"] as [string, string]),
    ...(r0?.nextStep ? [[r0.nextStep.item, "rec0.nextStep"] as [string, string]] : []),
    ...unowned.filter((step) => !pinned.has(key(step.item))).map((step) => [step.item, `path ${step.status}`] as [string, string]),
    ...(snap.deathMoment?.buyNow || []).map((buy) => [buy.item, "buyNow"] as [string, string]),
  ];
  for (const [name, where] of named) c("no_avoid_items", !avoid.has(key(name)), () => `${where} ${name} is in avoidItems [${brief?.avoidItems.join(", ")}]`);
  if (sold.size) {
    for (const rec of recs) c("no_sold_rebuy", !sold.has(rec.itemId), () => `recommendation ${rec.item} was sold earlier this game`);
    for (const step of unowned) c("no_sold_rebuy", !sold.has(step.itemId), () => `path step ${step.item} (${step.status}) was sold earlier this game`);
  }

  // --- swaps ---
  const ownedPathIds = new Set(steps.filter((step) => step.status === "owned").map((step) => step.itemId));
  const unownedTrees = new Set<number>();
  for (const step of unowned) { unownedTrees.add(step.itemId); tree(catalog, step.itemId, unownedTrees); }
  for (const rec of recs) {
    const swap = rec.swapPlan;
    if (!swap) continue;
    const targetTree = tree(catalog, rec.itemId);
    const why = !owned.has(swap.sellItemId) ? "is not owned"
      : swap.sellItemId === rec.itemId ? "is the target itself"
      // A mode-copy id (Swiftplay Thornmail 323075) the catalog does not know reads as 0g and slips past every id check.
      : !catalog.byId.has(swap.sellItemId) || swap.sellValue <= 0 ? "is not a known catalog item (0g sale)"
      : snap.buildPath.steps.some((step) => step.status !== "skipped" && step.item === swap.sellItem) ? "has the same name as a build-path step"
      : targetTree.has(swap.sellItemId) ? `is in ${rec.item}'s recipe tree`
      : ownedPathIds.has(swap.sellItemId) ? "is an owned build-path step"
      : unownedTrees.has(swap.sellItemId) ? "is a recipe piece of an un-owned path step"
      : null;
    c("swap_no_sell_rebuy", !why, () => `swap for ${rec.item}: sell ${swap.sellItem} ${why}; path=${pathText()}; inv=[${ownedNames}]`);
    const gold = Math.floor(snap.activePlayer.currentGold);
    const after = gold + swap.sellValue;
    const ok = swap.availableGoldAfterSale === after && swap.affordable === (after >= swap.buyCost)
      && swap.goldNeeded === Math.max(0, swap.buyCost - after) && swap.goldAfter === (swap.affordable ? after - swap.buyCost : 0) && swap.buyCost === rec.cost;
    c("swap_gold_math", ok, () => `swap for ${rec.item}: gold=${gold} ${JSON.stringify(swap)}`);
  }

  // --- death moment ---
  const dead = snap.activePlayer.isDead;
  c("death_moment_presence", Boolean(snap.deathMoment) === dead, () => `isDead=${dead} deathMoment=${snap.deathMoment ? "set" : "null"}`);
  const moment = snap.deathMoment;
  if (moment) {
    const total = moment.buyNow.reduce((sum, buy) => sum + buy.cost, 0);
    c("death_buy_within_gold", total <= moment.goldNow, () => `buyNow total ${total}g > gold ${moment.goldNow}g: ${moment.buyNow.map((b) => `${b.item} ${b.cost}`).join(", ")}`);
    // Walk the shopping list in order like the shop does: buying an item uses up owned components in its recipe
    // (Infinity Edge consumes the held Cloak, so a Cloak bought afterwards for LDR is a real need, not a duplicate).
    // A component bought this trip belongs to its goal: a Dagger for Berserker's Greaves does not cover the Dagger
    // Guinsoo's Rageblade needs.
    const stock = new Map(owned);
    const boughtFor = new Map<string, number>();
    const take = <K,>(pool: Map<K, number>, id: K) => {
      const count = pool.get(id) || 0;
      if (count > 0) pool.set(id, count - 1);
      return count > 0;
    };
    const consume = (id: number, goal: string, depth = 0) => {
      for (const child of catalog.byId.get(id)?.from || []) {
        if (!take(boughtFor, `${goal}:${child}`) && !take(stock, child) && depth < 3) consume(child, goal, depth + 1);
      }
    };
    for (const buy of moment.buyNow) {
      if (buy.itemId === CONTROL_WARD) continue;
      const goal = buy.forItem || buy.item;
      const have = (stock.get(buy.itemId) || 0) + (boughtFor.get(`${goal}:${buy.itemId}`) || 0);
      consume(buy.itemId, goal);
      if (buy.forItem) boughtFor.set(`${goal}:${buy.itemId}`, (boughtFor.get(`${goal}:${buy.itemId}`) || 0) + 1);
      else stock.set(buy.itemId, (stock.get(buy.itemId) || 0) + 1);
      const forItem = buy.forItem ? findItem(catalog, buy.forItem) : null;
      const need = forItem ? treeCount(catalog, forItem.id, buy.itemId) : 1;
      const bootsDup = isUpgradedBoots(catalog, buy.itemId) && hasBoots;
      c("death_buy_not_owned", !bootsDup && have < Math.max(1, need),
        () => `buyNow ${buy.item}${buy.forItem ? ` (for ${buy.forItem}, needs ${need})` : ""}: already have ${have}; inv=[${ownedNames}]; buyNow=${moment.buyNow.map((b) => b.item).join(", ")}`);
    }
    for (const goal of moment.goals) {
      const ok = goal.costNow <= goal.cost && goal.spendNow <= goal.costNow && goal.remainingAfter >= 0 && goal.remainingAfter === Math.max(0, goal.costNow - goal.spendNow);
      c("death_goals_consistent", ok, () => `goal ${goal.item}: cost=${goal.cost} costNow=${goal.costNow} spendNow=${goal.spendNow} remainingAfter=${goal.remainingAfter}; buyNow=${moment.buyNow.map((b) => `${b.item} ${b.cost}${b.forItem ? `>${b.forItem}` : ""}`).join(", ")}; inv=[${ownedNames}]`);
    }
  }

  // --- objectives ---
  const time = snap.game.time;
  for (const objective of snap.objectives) {
    const waiting = objective.status === "respawning" || objective.status === "not-spawned";
    const ok = waiting ? objective.nextSpawnAt !== null && objective.nextSpawnAt > time : objective.nextSpawnAt === null;
    c("objectives_sane", ok, () => `${objective.id} status=${objective.status} nextSpawnAt=${objective.nextSpawnAt} at time ${time}`);
  }
  const ids = snap.objectives.map((objective) => objective.id);
  const events = sample.raw.events?.Events || [];
  if (/swift/i.test(snap.game.mode)) {
    c("objectives_ruleset", !ids.some((id) => id === "grubs" || id === "herald" || id === "atakhan"), () => `Swiftplay shows ${ids.join(", ")}`);
    const baron = snap.objectives.find((objective) => objective.id === "baron");
    if (!events.some((event) => event.EventName === "BaronKill")) {
      c("objectives_ruleset", Boolean(baron) && (time < 720 ? baron!.nextSpawnAt === 720 : baron!.status === "up"), () => `Swiftplay Baron before first kill: ${JSON.stringify(baron)} at ${time}`);
    }
    const elder = snap.objectives.find((objective) => objective.id === "elder");
    if (!events.some((event) => event.EventName === "DragonKill" && /elder/i.test(event.DragonType || ""))) {
      c("objectives_ruleset", Boolean(elder) && (time < 900 ? elder!.nextSpawnAt === 900 : elder!.status === "up"), () => `Swiftplay Elder before first kill: ${JSON.stringify(elder)} at ${time}`);
    }
  } else if (snap.objectives.length) {
    c("objectives_ruleset", !ids.includes("atakhan"), () => `SR shows Atakhan: ${ids.join(", ")}`);
  }

  // --- names resolve ---
  const allNames = [
    ...steps.map((step) => step.item), ...recs.map((rec) => rec.item), ...recs.flatMap((rec) => rec.nextStep ? [rec.nextStep.item] : []),
    ...(moment?.buyNow || []).map((buy) => buy.item), ...(moment?.goals || []).map((goal) => goal.item),
  ];
  for (const name of allNames) {
    const found = findItem(catalog, name);
    c("names_resolve", Boolean(found && key(found.name) === key(name)), () => `"${name}" resolves to ${found ? `"${found.name}" (${found.id})` : "nothing"}`);
  }

  // --- boots ---
  const hasCompleted = items.some((item) => isCompletedId(catalog, item.id));
  const bootsBlocked = [...avoid].some((name) => /greaves|boots|shoes|treads|steelcaps/.test(name)) || sample.sold.some((id) => isUpgradedBoots(catalog, id));
  if (hasCompleted && !hasBoots && !bootsBlocked && !/cassiopeia/i.test(snap.activePlayer.champion)) {
    const early = unowned.slice(0, 2);
    c("boots_early", early.some((step) => isUpgradedBoots(catalog, step.itemId)), () => `no boots, owns a completed item, but next steps are ${early.map((s) => s.item).join(", ") || "(none)"}; path=${pathText()}`);
  }

  // --- conditional top-build options need a heavy enemy signal ---
  if (snap.buildPath.source === "meta") {
    const entry = metaBuildFor(snap.activePlayer.champion, snap.activePlayer.position, snap.dataDragonVersion);
    const options = entry ? entry.slots.flatMap((slot) => slot.options) : [];
    for (const step of unowned) {
      const same = options.filter((option) => key(option.item) === key(step.item));
      if (!same.length || same.some((option) => !option.when)) continue;
      const signal = counterSignalFor(same[0].item, same[0].when, same[0].condition);
      c("meta_conditional_heavy", signalHeavy(snap.enemyProfile, signal),
        () => `${step.item} (${step.status}, when=${same[0].when}) on the path but signal ${signal} is not heavy (${snap.enemyProfile ? "profile present" : "no profile"}); path=${pathText()}`);
    }
  }

  // --- exclusive item groups (lib/item-groups.ts) ---
  const recipe = itemRecipe(catalog);
  const nameOf = (id: number) => catalog.byId.get(id)?.name || String(id);
  const clash = (id: number, planned: number[] = []) => conflict(id, owned, planned, recipe);
  const groupItems: Array<[number, string]> = [
    ...recs.map((rec) => [rec.itemId, `recommendation ${rec.item}`] as [number, string]),
    ...recs.flatMap((rec) => rec.nextStep ? [[rec.nextStep.itemId, `${rec.item}.nextStep ${rec.nextStep.item}`] as [number, string]] : []),
    ...steps.filter((step) => step.status === "next" || step.status === "later").map((step) => [step.itemId, `path ${step.status} ${step.item}`] as [number, string]),
  ];
  for (const [id, where] of groupItems) {
    const found = clash(id);
    c("no_group_conflict", !found, () => `${where} is locked by owned ${found!.blocking.map(nameOf).join(", ")} (${found!.label}); inv=[${ownedNames}]`);
  }
  const bought: number[] = [];
  for (const buy of moment?.buyNow || []) {
    if (buy.itemId === CONTROL_WARD) continue;
    const found = clash(buy.itemId, bought);
    c("no_group_conflict", !found, () => `buyNow ${buy.item} is locked by ${found!.blocking.map(nameOf).join(", ")} (${found!.label}); inv=[${ownedNames}]; buyNow=${moment!.buyNow.map((b) => b.item).join(", ")}`);
    bought.push(buy.itemId);
  }
  const pathIds = steps.filter((step) => step.status !== "skipped").map((step) => step.itemId);
  const perGroup = new Map<string, { max: number; ids: number[] }>();
  for (const id of new Set(pathIds)) {
    for (const group of groupsOf(id)) {
      const entry = perGroup.get(group.key) || { max: group.max, ids: [] };
      entry.ids.push(id);
      perGroup.set(group.key, entry);
    }
  }
  for (const [group, entry] of perGroup) {
    if (entry.max !== 1) continue;
    c("no_group_conflict", entry.ids.length <= 1, () => `path holds ${entry.ids.map(nameOf).join(" + ")} from max-1 group ${group}; path=${pathText()}`);
  }

  // --- champion scaling ↔ item fit ---
  const scaling = snap.scaling;
  if (scaling) {
    const preferred = new Set((brief?.preferredItems || []).map(key));
    const fitChecked: Array<[number, string, string]> = [
      ...recs.map((rec) => [rec.itemId, rec.item, "recommendation"] as [number, string, string]),
      ...unowned.filter((step) => step.status !== "skipped").map((step) => [step.itemId, step.item, `path ${step.status}`] as [number, string, string]),
    ];
    for (const [id, item, where] of fitChecked) {
      const catalogItem = catalog.byId.get(id);
      const exempt = owned.has(id) || pinned.has(key(item)) || preferred.has(key(item)) || !catalogItem;
      c("item_fits_scaling", exempt || itemFitsScaling(catalogItem!, scaling), () => `${where} ${item} (${catalogItem?.scaling}) does not fit ${snap.activePlayer.champion} (${scaling}); path=${pathText()}`);
    }
  }

  // --- heavy resist signal → a visible, actionable counter card ---
  for (const pick of snap.counterPicks || []) {
    if (pick.level !== "heavy" || pick.itemId === null) continue;
    const card = snap.recommendations.slice(0, 3).find((rec) => rec.itemId === pick.itemId);
    const actionable = Boolean(card && (card.action === "buy" || card.swapPlan || /Inventory full/.test(card.trigger)));
    c("heavy_counter_visible", actionable, () => `${pick.signal} heavy, counter ${pick.item}: top cards ${snap.recommendations.slice(0, 3).map((rec) => `${rec.item}(${rec.action})`).join(", ")}; path=${pathText()}; inv=[${ownedNames}]`);
  }

  // --- top build (researched; any champion) ---
  const topBuild = metaBuildFor(snap.activePlayer.champion, snap.activePlayer.position, snap.dataDragonVersion);
  if (topBuild && !brief?.pinnedBuild?.length && !brief?.importedBuild?.items.length) {
    const offMetaNames = new Set(topBuild.offMeta.map((entry) => key(entry.item)).filter((name) => !isMetaItem(topBuild, name)));
    const offMeta = steps.filter((step) => offMetaNames.has(key(step.item)) && !owned.has(step.itemId));
    c("meta_no_offmeta", snap.buildPath.source === "meta" && !offMeta.length,
      () => `${snap.activePlayer.champion}: source=${snap.buildPath.source}${offMeta.length ? `, un-owned off-meta ${offMeta.map((step) => step.item).join(", ")}` : ""}; path=${pathText()}`);
  }
}

// Item groups: the disk cache for this patch if present, else the bundled table; never a 16 MB download from the check.
configureItemGroups({ network: false });
// Champion traits: this patch's disk cache if present, else the bundled table; never a CommunityDragon download.
configureChampionTraits({ network: false });
const catalog = await getItemCatalog();
// Researched top builds from <memory>/meta-research (read from disk only; no research runs), as the live route does.
await ensureResearchLoaded();
console.log(`Rift Lens replay check · memory: ${memoryRoot()} · Data Dragon ${catalog.version} (${catalog.byId.size} items)`);
if (catalog.byId.size < 100) {
  console.log("SKIPPED: Data Dragon is unreachable (fallback catalog only); replay invariants need the real item catalog.");
  process.exit(0);
}

// Partial records (live screen opened mid-game) miss earlier purchases, so a rebuilt inventory would be wrong;
// those games are covered by their raw capture instead.
const records = loadRecords().filter((record) => record.durationSeconds >= 300 && !record.remake && !record.partial);
const games: ReplayGame[] = [...loadRawGames(catalog), ...records.map((record) => recordGame(record, catalog))];
const gameSummaries: string[] = [];
let sampleCount = 0;
let errors = 0;
for (const game of games) {
  let gameFails = 0;
  const before = new Map([...stats].map(([name, entry]) => [name, entry.fail.length]));
  // Each sample twice: with the player's real memory (getPlayerBrief) and as a fresh player with no history,
  // so the history path and the inventory/default paths are both exercised.
  for (const sample of game.samples) {
    // Spectator / replay samples (captured before the capture skipped them) have no player of your own: not a failure.
    if (isSpectating(sample.raw)) continue;
    for (const [mode, loadBrief] of [["", getPlayerBrief], [" no-brief", async () => null]] as const) {
      const run = mode ? { ...sample, note: `${sample.note},${mode}` } : sample;
      let snap: LiveGameSnapshot;
      try {
        snap = await normalizeLiveData(sample.raw, { loadBrief, soldItemIds: () => sample.sold });
      } catch (error) {
        errors += 1;
        console.log(`  ERROR ${game.name} @${clock(sample.time)}${mode}: normalizeLiveData threw ${error instanceof Error ? error.message : error}`);
        continue;
      }
      sampleCount += 1;
      checkSample(game, run, snap, catalog);
      if (verbose) console.log(`  ${game.name} ${clock(sample.time)} ${run.note} path=${snap.buildPath.steps.map((s) => `${s.item}(${s.status[0]})`).join(" > ")} rec0=${snap.recommendations[0]?.item}`);
    }
  }
  for (const [name, entry] of stats) gameFails += entry.fail.length - (before.get(name) || 0);
  gameSummaries.push(`  ${game.source === "raw" ? "raw   " : "record"} ${game.name.padEnd(42)} ${game.champion.padEnd(10)} ${game.mode.padEnd(10)} ${String(game.samples.length).padStart(4)} samples  ${gameFails ? `${gameFails} FAIL` : "ok"}`);
}

console.log(`\nGames (${games.filter((g) => g.source === "raw").length} raw captures, ${records.length} recorded games; ${sampleCount} snapshots${errors ? `, ${errors} errors` : ""}):`);
console.log(gameSummaries.join("\n") || "  (none found)");
const groupStatus = itemGroupsStatus();
console.log(`Item groups: ${groupStatus.groups} exclusive groups from ${groupStatus.origin} (patch ${groupStatus.patch}).`);
console.log("\nInvariants:");
let failed = 0;
for (const [name, entry] of stats) {
  const status = entry.fail.length ? "FAIL" : entry.pass ? "pass" : "n/a ";
  console.log(`  ${status} ${name.padEnd(26)} ${String(entry.pass).padStart(5)} ok ${String(entry.fail.length).padStart(4)} fail  — ${INVARIANTS[name]}`);
  if (entry.fail.length) failed += 1;
  for (const failure of entry.fail.slice(0, 3)) console.log(`         ${failure.game} @${clock(failure.time)} (${failure.note}): ${failure.detail}`);
}
console.log(`\n${failed ? `${failed} invariant(s) FAILED` : "All invariants passed"}${errors ? `; ${errors} sample(s) threw` : ""}.`);
process.exit(failed || errors ? 1 : 0);

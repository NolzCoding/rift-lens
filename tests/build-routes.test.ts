// Build routes (lib/build-routes.ts, lib/meta-builds.ts withRoute, lib/build-research.ts routes): a champion built more
// than one way (AP burst vs on-hit Katarina), each route scored for the game with reasons, decided once per game.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/build-routes.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateResearch, type RawResearch } from "@/lib/build-research";
import { committedRoute, gameRoute, rankRoutes, resetRouteMemory, routeFeatures, type RouteChampion, type RouteItem } from "@/lib/build-routes";
import type { ItemCatalog, ItemInfo } from "@/lib/live-game";
import { hasFreshMetaBuild, withRoute, type MetaBuild, type MetaSlot } from "@/lib/meta-builds";

// Route items as live-game's routeItem reads them from Riot's item data.
const ITEMS: Record<string, Omit<RouteItem, "name" | "id">> = {
  "Lich Bane": { scaling: "ap", lethality: false, antiTank: false },
  "Shadowflame": { scaling: "ap", lethality: false, antiTank: false },
  "Rabadon's Deathcap": { scaling: "ap", lethality: false, antiTank: false },
  "Void Staff": { scaling: "ap", lethality: false, antiTank: true },
  "Nashor's Tooth": { scaling: "ap", lethality: false, antiTank: true },
  "Kraken Slayer": { scaling: "ad", lethality: false, antiTank: true },
  "Blade of The Ruined King": { scaling: "ad", lethality: false, antiTank: true },
  "Guinsoo's Rageblade": { scaling: "hybrid", lethality: false, antiTank: true },
  "Youmuu's Ghostblade": { scaling: "ad", lethality: true, antiTank: false },
  "Edge of Night": { scaling: "ad", lethality: true, antiTank: false },
  "Opportunity": { scaling: "ad", lethality: true, antiTank: false },
};
let nextId = 9000;
const ids = new Map(Object.keys(ITEMS).map((name) => [name, nextId++]));
const itemOf = (name: string): RouteItem | null => ITEMS[name] ? { id: ids.get(name)!, name, ...ITEMS[name] } : null;

const slots = (core: string[], flex: string[] = []): MetaSlot[] => [
  ...core.map((item, at): MetaSlot => ({ id: `slot${at + 1}`, label: `Item ${at + 1}`, kind: "core", options: [{ item }] })),
  { id: "boots", label: "Boots", kind: "boots", options: [{ item: "Sorcerer's Shoes" }] },
  ...flex.map((item, at): MetaSlot => ({ id: `flex${at}`, label: `Flex ${at}`, kind: "flex", options: [{ item }] })),
];
const katarina: MetaBuild = {
  champion: "Katarina", role: "MIDDLE", patch: "16.21", verified: "2026-11-09", sample: "Emerald+", sources: [], cores: [],
  offMeta: [{ item: "Kraken Slayer", pickRate: 8, note: "on-hit" }, { item: "Zhonya's Hourglass", pickRate: 3, note: "rare" }],
  origin: "researched", researchedAt: "2026-11-09T10:00:00.000Z", researchedOn: "16.21.1",
  slots: slots(["Lich Bane", "Shadowflame", "Rabadon's Deathcap"], ["Void Staff"]),
  mainRoute: { name: "AP burst", share: 72, winRate: 50.1, games: 40000, summary: "Resets and burst from Lich Bane." },
  routes: [
    { id: "on-hit", name: "On-hit", share: 18, winRate: 51.8, games: 9000, summary: "Auto-attack resets with on-hit items.", slots: slots(["Nashor's Tooth", "Kraken Slayer", "Guinsoo's Rageblade"], ["Blade of The Ruined King"]) },
    { id: "lethality", name: "Lethality", share: 6, winRate: 49, games: 3000, summary: "", slots: slots(["Youmuu's Ghostblade", "Edge of Night", "Opportunity"]) },
  ],
};
const champ = (champion: string, damage: RouteChampion["damage"], tank = false): RouteChampion => ({ champion, damage, tank });
const rank = (enemies: RouteChampion[], allies: RouteChampion[] = [], usualBuild: string[] | null = null) => rankRoutes({ routes: routeFeatures(katarina, itemOf), enemies, allies, usualBuild });
const SQUISHY = [champ("Ahri", "magic"), champ("Jinx", "physical"), champ("Lux", "magic"), champ("Zed", "physical"), champ("Lee Sin", "physical")];

test("with nothing special in the game, the most played route is recommended and every route says why", () => {
  const [best, ...rest] = rank([]);
  assert.equal(best.id, "main");
  assert.ok(best.recommended && rest.every((route) => !route.recommended));
  assert.ok(best.parts.some((part) => /most played \(72% of games\)/.test(part.text)));
  assert.deepEqual(best.core.map((item) => item.name), ["Lich Bane", "Shadowflame", "Rabadon's Deathcap"]);
  assert.ok(best.core.every((item) => item.id !== null));
});

test("win rate is shown but never counted", () => {
  const routes = rank([]);
  for (const route of routes) {
    const shown = route.parts.find((part) => /win rate/.test(part.text))!;
    assert.equal(shown.counted, false);
  }
  assert.equal(routes.find((route) => route.id === "on-hit")!.score, 0, "51.8% win rate adds nothing");
});

test("two tanks: penetration and on-hit beat them, lethality falls off", () => {
  const tanks = [champ("Ornn", "magic", true), champ("Sejuani", "magic", true), champ("Jinx", "physical"), champ("Lux", "magic"), champ("Ahri", "magic")];
  const routes = rank(tanks);
  assert.equal(routes[0].id, "on-hit");
  const onHit = routes[0].parts.find((part) => /beats their 2 tanks/.test(part.text))!;
  assert.match(onHit.text, /Ornn, Sejuani/);
  assert.ok(routes.find((route) => route.id === "lethality")!.parts.some((part) => /lethality falls off/.test(part.text) && part.points < 0));
});

test("a squishy team favours lethality; a team already all magic damage pushes away from AP", () => {
  const squishy = rank(SQUISHY);
  assert.ok(squishy.find((route) => route.id === "lethality")!.parts.some((part) => /squishy/.test(part.text) && part.points > 0));
  const allAp = rank([], [champ("Brand", "magic"), champ("Lux", "magic"), champ("Ornn", "magic"), champ("Ezreal", "physical")]);
  const ap = allAp.find((route) => route.id === "main")!;
  assert.ok(ap.parts.some((part) => /already 3 of 4 AP/.test(part.text) && part.points < 0));
  assert.ok(allAp.find((route) => route.id === "lethality")!.parts.some((part) => /has 1 AD of 4/.test(part.text) && part.points > 0));
});

test("the player's usual build counts as comfort", () => {
  const routes = rank([], [], ["Nashor's Tooth", "Kraken Slayer", "Sorcerer's Shoes"]);
  assert.equal(routes[0].id, "on-hit");
  assert.ok(routes[0].parts.some((part) => /your usual build/.test(part.text)));
});

test("items commit to a route only when no other route builds them", () => {
  assert.equal(committedRoute(katarina, []), null);
  assert.equal(committedRoute(katarina, ["Kraken Slayer"]), "on-hit");
  assert.equal(committedRoute(katarina, ["Lich Bane"]), "main");
  assert.equal(committedRoute(katarina, ["Lich Bane", "Kraken Slayer"]), null, "two routes' items: nothing decided by items");
});

test("in a game: the recommendation is kept even when the scores change, a choice overrides it, items override both", () => {
  resetRouteMemory();
  const first = gameRoute("game-1", "Katarina", katarina, rank([]), []);
  assert.deepEqual(first, { route: "main", source: "recommended" });
  const later = gameRoute("game-1", "Katarina", katarina, rank([champ("Ornn", "magic", true), champ("Sejuani", "magic", true)]), []);
  assert.deepEqual(later, first, "no flip mid-game");
  assert.equal(gameRoute("game-2", "Katarina", katarina, rank([champ("Ornn", "magic", true), champ("Sejuani", "magic", true)]), []).route, "on-hit", "a new game decides again");
  assert.deepEqual(gameRoute("game-1", "Katarina", katarina, rank([]), ["Youmuu's Ghostblade"]), { route: "lethality", source: "items" });
  resetRouteMemory();
});

test("withRoute: the route's slots, and its items are no longer off-meta for it", () => {
  const onHit = withRoute(katarina, "on-hit");
  assert.equal(onHit.slots[0].options[0].item, "Nashor's Tooth");
  assert.deepEqual(onHit.route, { id: "on-hit", name: "On-hit" });
  assert.deepEqual(onHit.offMeta.map((entry) => entry.item), ["Zhonya's Hourglass"]);
  assert.equal(withRoute(katarina, "nope").slots, katarina.slots);
});

test("research from before routes existed is researched again; with routes checked it is fresh", () => {
  const { routes: _routes, ...old } = katarina;
  void _routes;
  assert.equal(hasFreshMetaBuild("Katarina", "MIDDLE", "16.21.1", [old]), false);
  assert.equal(hasFreshMetaBuild("Katarina", "MIDDLE", "16.21.1", [katarina]), true);
  assert.equal(hasFreshMetaBuild("Katarina", "MIDDLE", "16.21.1", [{ ...katarina, routes: [] }]), true, "checked, one route only");
});

// Validation of the research answer's routes against a small item catalog.
const CATALOG_ITEMS: ItemInfo[] = [...ids.entries()].map(([name, id]): ItemInfo => ({ id, name, cost: 3000 }))
  .concat([{ id: 3020, name: "Sorcerer's Shoes", cost: 1100, tags: ["Boots"] }, { id: 1001, name: "Boots", cost: 300, tags: ["Boots"] }]);
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const catalog: ItemCatalog = { version: "16.21.1", byId: new Map(CATALOG_ITEMS.map((item) => [item.id, item])), byName: new Map(CATALOG_ITEMS.map((item) => [norm(item.name), item])), fallback: false };
const option = (item: string) => ({ item, pickRate: null, winRate: null, when: null, note: null });
const rawSlots = (core: string[]) => core.map((item, at) => ({ label: `Item ${at + 1}`, kind: "core", options: [option(item)] }));
const rawRoute = (name: string, core: string[]) => ({ name, share: 10, winRate: 50, games: 1000, summary: "s", slots: rawSlots(core), boots: [option("Sorcerer's Shoes")], bootsAfterItem: 1, starting: [] });
const research = (routes: NonNullable<RawResearch["routes"]>): RawResearch => ({
  champion: "Katarina", role: "MIDDLE", patch: "16.21", sample: "Emerald+",
  sources: [{ url: "https://op.gg/x", site: "op.gg", read: "r" }, { url: "https://u.gg/x", site: "u.gg", read: "r" }],
  starting: [], slots: rawSlots(["Lich Bane", "Shadowflame", "Rabadon's Deathcap"]), boots: [option("Sorcerer's Shoes")], bootsAfterItem: 1,
  cores: [], offMeta: [], notes: "", mainRoute: { name: "AP burst", share: 70, winRate: 50, games: 1, summary: "s" }, routes,
});

test("research: a distinct route is kept with its own slots; one that repeats the main core or has unknown items is dropped", () => {
  const result = validateResearch(research([
    rawRoute("On-hit", ["Nashor's Tooth", "Kraken Slayer", "Guinsoo's Rageblade"]),
    rawRoute("Burst 2", ["Lich Bane", "Rabadon's Deathcap", "Void Staff"]),
  ]), { catalog, version: "16.21.1", champion: "Katarina", role: "MIDDLE", researchedAt: "2026-11-09T10:00:00.000Z" });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.build.routes!.map((route) => route.id), ["on-hit"]);
  assert.equal(result.build.routes![0].slots.find((slot) => slot.kind === "boots")?.options[0].item, "Sorcerer's Shoes");
  assert.equal(result.build.mainRoute?.name, "AP burst");
  assert.ok(result.warnings.some((line) => /Burst 2.*mostly the same items/.test(line)));
  const unknown = validateResearch(research([rawRoute("Tank", ["Made Up Item", "Kraken Slayer", "Nashor's Tooth"])]), { catalog, version: "16.21.1", champion: "Katarina", role: "MIDDLE", researchedAt: "2026-11-09T10:00:00.000Z" });
  assert.ok(unknown.ok);
  assert.deepEqual(unknown.build.routes, [], "routes checked (empty), the made-up one dropped");
});

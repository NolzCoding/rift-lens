// Build routes through the live engine (lib/live-game.ts + lib/build-routes.ts) with Riot's real item data: the path
// follows the route picked for the game, a saved choice switches it, items bought commit it.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/build-routes-engine.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { resetRouteMemory, saveRouteChoice } from "@/lib/build-routes";
import { configureChampionTraits } from "@/lib/champion-traits";
import { configureItemGroups } from "@/lib/item-groups";
import { getItemCatalog, normalizeLiveData, resetGameMemory, type RawLiveData } from "@/lib/live-game";
import { buildRoutes, registerResearchedBuilds, type MetaBuild, type MetaSlot } from "@/lib/meta-builds";
import type { LiveGameSnapshot, PlayerBrief } from "@/lib/types";

// The saved choice goes to a scratch memory folder, never the player's data.
const memory = await mkdtemp(path.join(os.tmpdir(), "rift-lens-routes-"));
process.env.RIFT_LENS_MEMORY_DIR = memory;
after(() => rm(memory, { recursive: true, force: true }));
configureItemGroups({ network: false });
configureChampionTraits({ network: false, disk: false });
const catalog = await getItemCatalog();
const skip = catalog.byId.size < 100 ? "Data Dragon unreachable (fallback catalog)" : false;

const slots = (core: string[], flex: string[]): MetaSlot[] => [
  ...core.map((item, at): MetaSlot => ({ id: `slot${at + 1}`, label: `Item ${at + 1}`, kind: "core", options: [{ item }] })),
  { id: "boots", label: "Boots", kind: "boots", options: [{ item: "Sorcerer's Shoes" }] },
  ...flex.map((item, at): MetaSlot => ({ id: `flex${at + 1}`, label: `Flex ${at + 1}`, kind: "flex", options: [{ item }] })),
];
const katarina: MetaBuild = {
  champion: "Katarina", role: "MIDDLE", patch: "16.22", verified: "2026-11-10", sample: "Emerald+", sources: [], cores: [], offMeta: [],
  origin: "researched", researchedAt: "2026-11-10T10:00:00.000Z", researchedOn: catalog.version,
  slots: slots(["Lich Bane", "Shadowflame", "Rabadon's Deathcap"], ["Void Staff"]),
  mainRoute: { name: "AP burst", share: 38, winRate: 54, games: null, summary: "" },
  routes: [{ id: "ad-on-hit", name: "AD on-hit", share: 25, winRate: 58, games: null, summary: "", slots: slots(["Kraken Slayer", "Blade of The Ruined King", "Terminus"], ["Nashor's Tooth"]) }],
};
registerResearchedBuilds([katarina]);

const player = (who: string, champion: string, team: string, position: string, items: number[] = []) => ({
  championName: champion, riotId: `${who}#EUW`, summonerName: who, team, position, level: 9, isDead: false, respawnTimer: 0,
  scores: { kills: 0, deaths: 0, assists: 0, creepScore: 80 },
  items: items.map((id) => ({ itemID: id, displayName: catalog.byId.get(id)?.name || String(id), price: catalog.byId.get(id)?.cost || 0, count: 1 })),
});
function raw(items: number[], enemies: string[]): RawLiveData {
  return {
    activePlayer: { riotId: "Me#EUW", summonerName: "Me", currentGold: 400, level: 9, championStats: { currentHealth: 900, maxHealth: 1400 } },
    allPlayers: [
      player("Me", "Katarina", "ORDER", "MIDDLE", items),
      player("A1", "Lux", "ORDER", "UTILITY"), player("A2", "Caitlyn", "ORDER", "BOTTOM"), player("A3", "Darius", "ORDER", "TOP"), player("A4", "Vi", "ORDER", "JUNGLE"),
      ...enemies.map((champion, at) => player(`E${at}`, champion, "CHAOS", ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"][at])),
    ],
    events: { Events: [] },
    gameData: { gameMode: "CLASSIC", gameTime: 600, mapName: "Map11", mapNumber: 11 },
  };
}
const brief: PlayerBrief = {
  champion: "Katarina", gamesOnChampion: 0, winRateOnChampion: 0, usualBuild: null, usualBuildGames: 0, pinnedBuild: null, importedBuild: null,
  preferredItems: [], avoidItems: [], matchupNote: null, killerNotes: [], issues: [], focus: null, notes: [], lines: [],
};
const run = (input: RawLiveData) => { resetGameMemory(); return normalizeLiveData(input, { loadBrief: async () => brief, soldItemIds: () => [] }); };
const idOf = (name: string) => [...catalog.byId.values()].find((item) => item.name === name)!.id;
const TANKS = ["Ornn", "Sejuani", "Ahri", "Jinx", "Leona"];

/** Every un-owned completed step of the path is an item of the route (boots aside). */
function followsRoute(snap: LiveGameSnapshot, routeId: string) {
  const route = buildRoutes(katarina).find((entry) => entry.id === routeId)!;
  const items = new Set(route.slots.flatMap((slot) => slot.options.map((option) => option.item)));
  const steps = snap.buildPath.steps.filter((step) => step.status !== "owned" && step.status !== "skipped" && !/boots|shoes|greaves|treads/i.test(step.item));
  assert.ok(steps.length >= 2, "a path to check");
  const strays = steps.filter((step) => !items.has(step.item)).map((step) => step.item);
  assert.ok(strays.length <= 1, `path follows ${routeId}: ${steps.map((step) => step.item).join(" > ")} (off-route: ${strays.join(", ")})`);
  assert.ok(items.has(steps[0].item), `next item ${steps[0].item} is from ${routeId}`);
}

test("the recommended route is chosen for the game and the path follows it", { skip }, async () => {
  resetRouteMemory();
  const snap = await run(raw([], TANKS));
  assert.ok(snap.buildRoute, "routes offered");
  assert.equal(snap.buildRoute!.options.length, 2);
  assert.equal(snap.buildRoute!.source, "recommended");
  assert.equal(snap.buildRoute!.chosen, snap.buildRoute!.options[0].id);
  assert.equal(snap.buildPath.source, "meta");
  followsRoute(snap, snap.buildRoute!.chosen);
});

test("a saved choice switches the route; items bought commit it over the choice", { skip }, async () => {
  resetRouteMemory();
  const first = await run(raw([], TANKS));
  const other = first.buildRoute!.options.find((option) => option.id !== first.buildRoute!.chosen)!.id;
  await saveRouteChoice("Katarina", other);
  const chosen = await run(raw([], TANKS));
  assert.equal(chosen.buildRoute!.chosen, other);
  assert.equal(chosen.buildRoute!.source, "choice");
  followsRoute(chosen, other);
  const bought = await run(raw([idOf(other === "main" ? "Kraken Slayer" : "Lich Bane")], TANKS));
  assert.equal(bought.buildRoute!.source, "items");
  assert.equal(bought.buildRoute!.chosen, other === "main" ? "ad-on-hit" : "main");
  await saveRouteChoice("Katarina", null);
  resetRouteMemory();
});

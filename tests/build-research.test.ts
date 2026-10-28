// Build research (lib/build-research.ts) without any model call: validation of a research answer, the top-build lookup
// precedence (lib/meta-builds.ts), and the scheduler's single-flight/backoff rules with an injected fake runner.
// Uses a small synthetic item catalog, so it runs offline.
// Run: node --import ./scripts/alias.mjs --experimental-transform-types --no-warnings --test tests/build-research.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseResearchRole, conditionOf, createResearchScheduler, mainRoleFor, newSchedulerState, patchFreshness, researchPrompt, sourceDomain, validateResearch,
  type RawResearch, type ResearchRunner,
} from "@/lib/build-research";
import type { ItemCatalog, ItemInfo } from "@/lib/live-game";
import { hasFreshMetaBuild, META_BUILDS, metaBuildFor, metaOriginLabel, registerResearchedBuilds, selectMetaBuild, type MetaBuild } from "@/lib/meta-builds";

import { caitlynCurated } from "./fixtures/meta";

const ITEMS: ItemInfo[] = [
  { id: 2523, name: "Hexoptics C44", cost: 2650 }, { id: 6676, name: "The Collector", cost: 3000 }, { id: 3031, name: "Infinity Edge", cost: 3450 },
  { id: 3094, name: "Rapid Firecannon", cost: 2650 }, { id: 3036, name: "Lord Dominik's Regards", cost: 3100 }, { id: 3026, name: "Guardian Angel", cost: 3200 },
  { id: 3072, name: "Bloodthirster", cost: 3400 }, { id: 3033, name: "Mortal Reminder", cost: 3200 }, { id: 3046, name: "Phantom Dancer", cost: 2650 },
  { id: 3032, name: "Yun Tal Wildarrows", cost: 3000 }, { id: 3006, name: "Berserker's Greaves", cost: 1100, tags: ["Boots"] },
  { id: 3009, name: "Boots of Swiftness", cost: 1000, tags: ["Boots"] }, { id: 1001, name: "Boots", cost: 300, tags: ["Boots"] },
  { id: 1055, name: "Doran's Blade", cost: 450 }, { id: 2003, name: "Health Potion", cost: 50 }, { id: 1036, name: "Long Sword", cost: 350 },
];
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const catalog: ItemCatalog = { version: "16.21.1", byId: new Map(ITEMS.map((item) => [item.id, item])), byName: new Map(ITEMS.map((item) => [norm(item.name), item])), fallback: false };
const ctx = { catalog, version: "16.21.1", champion: "Caitlyn", role: "BOTTOM" as const, researchedAt: "2026-10-12T10:00:00.000Z" };

const option = (item: string, extra: Partial<RawResearch["boots"][number]> = {}) => ({ item, pickRate: null, winRate: null, when: null, note: null, ...extra });
function answer(overrides: Partial<RawResearch> = {}): RawResearch {
  return {
    champion: "Caitlyn", role: "BOTTOM", patch: "16.21", sample: "Emerald+ ranked, 70,000 games",
    sources: [
      { url: "https://op.gg/lol/champions/caitlyn/build/adc", site: "op.gg", read: "items page" },
      { url: "https://lolalytics.com/lol/caitlyn/build/", site: "lolalytics", read: "build page" },
    ],
    starting: ["Doran's Blade", "Health Potion"],
    slots: [
      { label: "1st item", kind: "core", options: [option("Hexoptics C44", { pickRate: 61.2, winRate: 52.1 }), option("The Collector", { pickRate: 35 })] },
      { label: "2nd item", kind: "core", options: [option("Infinity Edge", { pickRate: 88.4 })] },
      { label: "3rd item", kind: "core", options: [option("Rapid Firecannon"), option("Lord Dominik's Regards")] },
      { label: "Late item", kind: "situational", options: [option("Guardian Angel"), option("Mortal Reminder", { when: "vs heavy healing" })] },
    ],
    boots: [option("Berserker's Greaves", { pickRate: 85 })],
    bootsAfterItem: 1,
    cores: [{ items: ["Hexoptics C44", "Infinity Edge", "Rapid Firecannon"], games: 18000, winRate: 55.1 }],
    offMeta: [{ item: "Yun Tal Wildarrows", pickRate: 4.6, note: "rare" }],
    notes: "",
    ...overrides,
  };
}

test("validation: a good answer becomes a researched MetaBuild with boots after the 1st item and conditions mapped", () => {
  const result = validateResearch(answer(), ctx);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const build = result.build;
  assert.deepEqual(build.slots.map((slot) => slot.label), ["1st item", "Boots", "2nd item", "3rd item", "Late item"]);
  assert.equal(build.origin, "researched");
  assert.equal(build.researchedOn, "16.21.1");
  assert.equal(build.stale, false);
  assert.equal(result.freshness, "current");
  assert.deepEqual(build.slots[0].options[0], { item: "Hexoptics C44", pickRate: 61.2, winRate: 52.1 });
  const mortal = build.slots[4].options.find((entry) => entry.item === "Mortal Reminder");
  assert.equal(mortal?.when, "healing");
  assert.deepEqual(build.starting, ["Doran's Blade", "Health Potion"]);
  assert.deepEqual(build.sources.map((source) => source.site), ["op.gg", "lolalytics"]);
  assert.equal(metaOriginLabel(build), "researched 16.21 (op.gg, lolalytics)");
});

test("validation: only enemy healing is 'healing', order-only phrases are no condition, and every slot keeps a default", () => {
  assert.equal(conditionOf("vs heavy healing").when, "healing");
  assert.equal(conditionOf("against enemy sustain").when, "healing");
  assert.equal(conditionOf("when sustain is needed").when, "situational");
  assert.equal(conditionOf("vs heavy poke").when, "heavy-poke");
  assert.deepEqual(conditionOf("if omitted at third item"), { orderNote: "if omitted at third item" });
  assert.equal(conditionOf("if omitted earlier, vs tanks").when, "situational");
  const result = validateResearch(answer({
    slots: [
      ...answer().slots.slice(0, 3),
      { label: "4th item", kind: "flex", options: [option("Lord Dominik's Regards", { when: "if armor penetration is still needed" }), option("Mortal Reminder", { when: "vs heavy healing" })] },
      { label: "5th item", kind: "flex", options: [option("Guardian Angel", { when: "vs burst", winRate: 59.3 }), option("Bloodthirster", { when: "when sustain is needed" })] },
    ],
  }), ctx);
  assert.ok(result.ok);
  const fourth = result.build.slots.find((slot) => slot.label === "4th item")!;
  assert.deepEqual(fourth.options[0], { item: "Lord Dominik's Regards", note: "if armor penetration is still needed" });
  const fifth = result.build.slots.find((slot) => slot.label === "5th item")!;
  assert.deepEqual(fifth.options[0], { item: "Guardian Angel", winRate: 59.3, note: "best vs burst" });
  assert.equal(fifth.options[1].when, "situational");
  assert.ok(result.warnings.some((line) => /5th item: every option was conditional/.test(line)));
});

test("validation: unknown items and wrong item kinds are dropped and recorded; an emptied slot is dropped", () => {
  const raw = answer({
    slots: [
      { label: "1st item", kind: "core", options: [option("Kraken Slayerz"), option("Hexoptics C44")] },
      { label: "2nd item", kind: "core", options: [option("Infinity Edge")] },
      { label: "3rd item", kind: "core", options: [option("Rapid Firecannon")] },
      { label: "4th item", kind: "flex", options: [option("Long Sword"), option("Made Up Blade")] },
    ],
    boots: [option("Berserker's Greaves"), option("Infinity Edge")],
    cores: [{ items: ["Hexoptics C44", "Totally Fake"], games: 10, winRate: 50 }],
  });
  const result = validateResearch(raw, ctx);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.dropped.map((entry) => `${entry.item}|${entry.where}`).sort(), [
    "Infinity Edge|Boots", "Kraken Slayerz|1st item", "Long Sword|4th item", "Made Up Blade|4th item", "Totally Fake|Core",
  ].sort());
  assert.equal(result.dropped.find((entry) => entry.item === "Long Sword")?.reason, "not a completed item");
  assert.ok(!result.build.slots.some((slot) => slot.label === "4th item"), "empty slot kept");
  assert.deepEqual(result.build.cores, []);
});

test("validation: fewer than 3 surviving core slots rejects the result", () => {
  const raw = answer({
    slots: [
      { label: "1st item", kind: "core", options: [option("Hexoptics C44")] },
      { label: "2nd item", kind: "core", options: [option("Infinity Edge")] },
      { label: "3rd item", kind: "core", options: [option("Imaginary Cannon")] },
      { label: "4th item", kind: "flex", options: [option("Phantom Dancer")] },
    ],
  });
  const result = validateResearch(raw, ctx);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /Only 2 core slots/);
  assert.equal(result.dropped[0]?.item, "Imaginary Cannon");
});

test("validation: sources from a single domain (or invalid URLs) reject the result", () => {
  const oneSite = validateResearch(answer({ sources: [
    { url: "https://op.gg/lol/champions/caitlyn/build", site: "op.gg", read: "build" },
    { url: "https://www.op.gg/lol/champions/caitlyn/items", site: "op.gg", read: "items" },
    { url: "javascript:alert(1)", site: "evil", read: "x" },
  ] }), ctx);
  assert.equal(oneSite.ok, false);
  assert.match(oneSite.ok ? "" : oneSite.reason, /at least 2 different source sites/);
  assert.equal(sourceDomain("https://eu.lolalytics.com/lol/caitlyn/build/"), "lolalytics.com");
  assert.equal(sourceDomain("ftp://op.gg/x"), null);
});

test("validation: an answer for another champion is rejected", () => {
  const result = validateResearch(answer({ champion: "Jinx" }), ctx);
  assert.equal(result.ok, false);
});

test("patch staleness: current, previous (incl. season rollover) and stale", () => {
  assert.equal(patchFreshness("16.21", "16.21.1"), "current");
  assert.equal(patchFreshness("Patch 16.20", "16.21.1"), "previous");
  assert.equal(patchFreshness("16.19", "16.21.1"), "stale");
  assert.equal(patchFreshness("16.24", "17.1.1"), "previous");
  assert.equal(patchFreshness("16.22", "16.21.1"), "stale");
  assert.equal(patchFreshness("latest", "16.21.1"), "stale");
  const old = validateResearch(answer({ patch: "16.18" }), ctx);
  assert.ok(old.ok);
  assert.equal(old.build.stale, true);
  assert.equal(old.build.patch, "16.18");
  const lagging = validateResearch(answer({ patch: "16.20" }), ctx);
  assert.ok(lagging.ok);
  assert.equal(lagging.build.stale, false);
});

const researched = (patchOn: string, extra: Partial<MetaBuild> = {}): MetaBuild => {
  const result = validateResearch(answer({ patch: patchOn.split(".").slice(0, 2).join(".") }), { ...ctx, version: patchOn, researchedAt: `2026-10-${patchOn.endsWith("21.1") ? "12" : "01"}T00:00:00.000Z` });
  assert.ok(result.ok);
  return { ...result.build, ...extra };
};

test("lookup precedence: researched for the current patch > curated > older research (flagged outdated)", () => {
  // No champion data is curated in code any more; a curated entry passed to the lookup still ranks between current and
  // older research.
  assert.equal(META_BUILDS.length, 0, "lib/meta-builds.ts holds no champion builds");
  const curated = caitlynCurated();
  const lookup = (extra: { researched: MetaBuild[]; version: string }) => ({ ...extra, curated: [curated] });
  const current = researched("16.21.1");
  const older = researched("16.19.1");
  assert.equal(selectMetaBuild("Caitlyn", "BOTTOM", lookup({ researched: [older, current], version: "16.21.1" })), current);
  assert.equal(selectMetaBuild("Caitlyn", "BOTTOM", lookup({ researched: [older], version: "16.21.1" })), curated);
  assert.equal(selectMetaBuild("Caitlyn", "BOTTOM", lookup({ researched: [{ ...current, stale: true }], version: "16.21.1" })), curated);
  // Without any curated entry the older research is served, flagged outdated.
  assert.equal(selectMetaBuild("Caitlyn", "BOTTOM", { researched: [older], version: "16.21.1" })?.outdated, true);
  const jinx = { ...older, champion: "Jinx" };
  const outdated = selectMetaBuild("Jinx", "BOTTOM", { researched: [jinx], version: "16.21.1" });
  assert.equal(outdated?.outdated, true);
  assert.equal(outdated?.patch, "16.19");
  // Role fallback: no MIDDLE entry → the champion's build for another role, marked with the role the player is in.
  const crossRole = selectMetaBuild("Jinx", "MIDDLE", { researched: [jinx], version: "16.21.1" });
  assert.equal(crossRole?.role, "BOTTOM");
  assert.equal(crossRole?.servedFor, "MIDDLE");
  assert.equal(crossRole?.outdated, true);
  // Support builds are never swapped in or out.
  assert.equal(selectMetaBuild("Jinx", "UTILITY", { researched: [jinx], version: "16.21.1" }), null);
  assert.equal(selectMetaBuild("Jinx", "TOP", { researched: [{ ...jinx, role: "UTILITY" }], version: "16.21.1" }), null);
  // An exact-role entry always wins over another role's.
  const jinxMid = { ...current, champion: "Jinx", role: "MIDDLE" as const };
  assert.equal(selectMetaBuild("Jinx", "MIDDLE", { researched: [jinx, jinxMid], version: "16.21.1" }), jinxMid);
  assert.equal(selectMetaBuild("Jinx", null, { researched: [jinx], version: "16.21.1" })?.champion, "Jinx");
  assert.equal(selectMetaBuild("Jinx", null, { researched: [jinx], version: "16.21.1" })?.servedFor, undefined);
  // Fresh = current-patch research, or a curated entry stamped with the current patch.
  assert.equal(hasFreshMetaBuild("Caitlyn", "BOTTOM", "16.21.1", [older]), false);
  assert.equal(hasFreshMetaBuild("Caitlyn", "BOTTOM", "16.21.1", [current]), true);
  assert.equal(hasFreshMetaBuild("Caitlyn", "BOTTOM", "16.20.1", [], [curated]), true);
  assert.equal(hasFreshMetaBuild("Caitlyn", "BOTTOM", "16.20.1", []), false, "nothing curated: only research makes a build fresh");
  // The engine's synchronous lookup reads the in-memory registry.
  registerResearchedBuilds([current]);
  assert.equal(metaBuildFor("Caitlyn", "BOTTOM", "16.21.1"), current);
  // A newer patch with no new research: the 16.21 research is still served, flagged outdated (no curated table).
  assert.equal(metaBuildFor("Caitlyn", "BOTTOM", "16.22.1")?.outdated, true);
  assert.equal(metaBuildFor("Caitlyn", "BOTTOM", "16.22.1")?.patch, "16.21");
  registerResearchedBuilds([]);
});

test("role choice: champ-select position, then inferred, then main role; Swiftplay always uses the main role", () => {
  assert.equal(chooseResearchRole({ assigned: "middle", inferred: "BOTTOM", swiftplay: false, main: "BOTTOM" }), "MIDDLE");
  assert.equal(chooseResearchRole({ assigned: "", inferred: "TOP", swiftplay: false, main: "BOTTOM" }), "TOP");
  assert.equal(chooseResearchRole({ assigned: null, inferred: "UNKNOWN", swiftplay: false, main: "UTILITY" }), "UTILITY");
  assert.equal(chooseResearchRole({ assigned: "top", inferred: "TOP", swiftplay: true, main: "BOTTOM" }), "BOTTOM");
  // Live trigger: Riot's live position is the lane being played, in Swiftplay too (Yone in mid → research Yone MIDDLE).
  assert.equal(chooseResearchRole({ live: "MIDDLE", assigned: null, inferred: "MIDDLE", swiftplay: true, main: "TOP" }), "MIDDLE");
  assert.equal(chooseResearchRole({ live: "UNKNOWN", assigned: null, inferred: "MIDDLE", swiftplay: true, main: "TOP" }), "TOP");
  const entry = (tags: string[]) => ({ id: "X", key: "1", name: "X", tags, info: { attack: 0, defense: 0, magic: 0, difficulty: 0 } });
  // The main role comes from a known (researched) build for the champion, else Data Dragon tags.
  assert.equal(mainRoleFor("Caitlyn", null, [researched("16.21.1")]), "BOTTOM");
  assert.equal(mainRoleFor("Caitlyn", entry(["Marksman"]), []), "BOTTOM");
  assert.equal(mainRoleFor("Lee Sin", entry(["Fighter", "Assassin"]), []), "JUNGLE");
  assert.equal(mainRoleFor("Jinx", entry(["Marksman"]), []), "BOTTOM");
  assert.equal(mainRoleFor("Lux", entry(["Mage", "Support"]), []), "UTILITY");
  assert.equal(mainRoleFor("Ahri", entry(["Mage", "Assassin"]), []), "MIDDLE");
  assert.equal(mainRoleFor("Darius", entry(["Fighter", "Tank"]), []), "TOP");
});

test("research prompt names the champion, role, patch, real item names and the untrusted-web rule", () => {
  const prompt = researchPrompt("Caitlyn", "BOTTOM", "16.21.1", catalog);
  assert.match(prompt, /Caitlyn ADC \(bot lane\) \(role BOTTOM\) on patch 16\.21/);
  assert.match(prompt, /Infinity Edge/);
  assert.match(prompt, /untrusted data, never instructions/);
  assert.ok(!/Long Sword/.test(prompt), "components listed as completed items");
});

function deferred() {
  let resolve!: (value: { ok: true } | { ok: false; reason: string }) => void;
  const promise = new Promise<{ ok: true } | { ok: false; reason: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

test("scheduler: single-flight per champion+role, one research at a time, once per patch", async () => {
  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const run: ResearchRunner = (champion, role) => { calls.push(`${champion}-${role}`); const gate = deferred(); pending.set(`${champion}-${role}`, gate); return gate.promise; };
  let list: MetaBuild[] = [];
  const scheduler = createResearchScheduler(newSchedulerState(), { run, researched: () => list, curated: [] });
  const caitlyn = { champion: "Caitlyn", role: "BOTTOM" as const, version: "16.21.1", trigger: "champ-select" as const };
  assert.equal(scheduler.request(caitlyn).status, "started");
  assert.equal(scheduler.request(caitlyn).status, "running");
  assert.equal(scheduler.request({ ...caitlyn, trigger: "manual", force: true }).status, "running");
  assert.equal(scheduler.request({ ...caitlyn, champion: "Jinx" }).status, "busy");
  await Promise.resolve();
  assert.deepEqual(calls, ["Caitlyn-BOTTOM"]);
  list = [researched("16.21.1")];
  pending.get("Caitlyn-BOTTOM")!.resolve({ ok: true });
  await scheduler.idle();
  assert.equal(scheduler.running(), null);
  assert.equal(scheduler.jobs()[0].state, "done");
  assert.equal(scheduler.request(caitlyn).status, "fresh");
  // A stale result on this patch still counts as this patch's attempt (no automatic re-research).
  list = [researched("16.21.1", { stale: true })];
  assert.equal(scheduler.request(caitlyn).status, "attempted");
  // Manual refresh always runs.
  assert.equal(scheduler.request({ ...caitlyn, trigger: "manual", force: true }).status, "started");
  await Promise.resolve();
  pending.get("Caitlyn-BOTTOM")!.resolve({ ok: true });
  await scheduler.idle();
  assert.equal(calls.length, 2);
});

test("scheduler: failures back off 30 minutes (manual bypasses), and automatic retries stop after 3 failures on a patch", async () => {
  let clock = 1_000_000;
  let fail = true;
  const run: ResearchRunner = async () => fail ? { ok: false, reason: "Only 2 core slots survived validation (need 3)." } : { ok: true };
  const scheduler = createResearchScheduler(newSchedulerState(), { run, now: () => clock, researched: () => [], curated: [] });
  const jinx = { champion: "Jinx", role: "BOTTOM" as const, version: "16.21.1", trigger: "live" as const };
  assert.equal(scheduler.request(jinx).status, "started");
  await scheduler.idle();
  const failed = scheduler.jobs().find((job) => job.champion === "Jinx")!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error || "", /core slots/);
  clock += 10 * 60_000;
  const backoff = scheduler.request(jinx);
  assert.equal(backoff.status, "backoff");
  assert.ok(backoff.retryAt);
  clock += 21 * 60_000;
  assert.equal(scheduler.request(jinx).status, "started");
  await scheduler.idle();
  assert.equal(scheduler.request({ ...jinx, trigger: "manual", force: true }).status, "started");
  await scheduler.idle();
  clock += 31 * 60_000;
  assert.equal(scheduler.request(jinx).status, "backoff", "3 failures on one patch still retried automatically");
  // A new patch resets the automatic budget; a success clears the failures.
  fail = false;
  assert.equal(scheduler.request({ ...jinx, version: "16.22.1" }).status, "started");
  await scheduler.idle();
  assert.equal(scheduler.jobs().find((job) => job.champion === "Jinx")?.state, "done");
});

test("scheduler: a runner that throws is recorded as a failure and frees the slot", async () => {
  const run: ResearchRunner = async () => { throw new Error("Codex took longer than 300 seconds and was stopped."); };
  const scheduler = createResearchScheduler(newSchedulerState(), { run, researched: () => [], curated: [] });
  assert.equal(scheduler.request({ champion: "Ahri", role: "MIDDLE", version: "16.21.1", trigger: "manual", force: true }).status, "started");
  await scheduler.idle();
  assert.equal(scheduler.running(), null);
  assert.match(scheduler.jobs()[0].error || "", /longer than 300 seconds/);
  assert.equal(scheduler.request({ champion: "Lux", role: "UTILITY", version: "16.21.1", trigger: "live" }).status, "started");
  await scheduler.idle();
});

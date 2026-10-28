import { NextResponse } from "next/server";

import { ensureResearchLoaded, researchOverview } from "@/lib/build-research";
import { profileImports } from "@/lib/item-set-import";
import { findItem, getItemCatalog } from "@/lib/live-game";
import { readSettings, type ProfileSettings } from "@/lib/memory-store";
import { getProfile, rebuildProfileWithHistory, saveSettings } from "@/lib/player-profile";
import type { PlayerFocus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const METRICS = new Set(["csAt10", "deathsBefore10", "unspentGoldDeaths", "none"]);
const headers = { "Cache-Control": "no-store" };

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

function itemMap(value: unknown, current: Record<string, string[]>) {
  if (value === undefined) return current;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Item preferences must be an object of champion → item names.");
  const next = { ...current };
  for (const [rawChampion, rawItems] of Object.entries(value as Record<string, unknown>)) {
    const champion = text(rawChampion, 40);
    if (!champion) continue;
    if (!Array.isArray(rawItems)) throw new Error(`Items for ${champion} must be a list.`);
    const items = [...new Set(rawItems.map((item) => text(item, 60)).filter(Boolean))].slice(0, 8);
    if (items.length) next[champion] = items; else delete next[champion];
  }
  if (Object.keys(next).length > 100) throw new Error("Too many champions in item preferences.");
  return next;
}

/** Same shape/limits as item preferences, plus every name must resolve to a real Summoner's Rift item (canonical names are stored). */
async function buildMap(value: unknown, current: Record<string, string[]>) {
  const next = itemMap(value, current);
  if (value === undefined) return next;
  const catalog = await getItemCatalog();
  if (catalog.byId.size < 100) return next; // Data Dragon unreachable: keep names as typed.
  for (const champion of Object.keys(value as Record<string, unknown>).map((name) => text(name, 40))) {
    if (!next[champion]) continue;
    next[champion] = [...new Set(next[champion].map((name) => {
      const item = findItem(catalog, name);
      if (!item) throw new Error(`Unknown item "${name}" in the ${champion} build.`);
      return item.name;
    }))];
  }
  return next;
}

function parseFocus(value: unknown): PlayerFocus | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Focus must be an object or null.");
  const input = value as Record<string, unknown>;
  const title = text(input.title, 120);
  if (!title) throw new Error("Focus needs a title.");
  const metricInput = input.metric as Record<string, unknown> | null | undefined;
  let metric: PlayerFocus["metric"] = null;
  if (metricInput && typeof metricInput === "object") {
    if (!METRICS.has(String(metricInput.kind))) throw new Error("Unknown focus metric.");
    const target = Number(metricInput.target);
    if (!Number.isFinite(target) || target < 0 || target > 300) throw new Error("Focus target must be between 0 and 300.");
    metric = { kind: metricInput.kind as NonNullable<PlayerFocus["metric"]>["kind"], target: Math.round(target) };
  }
  return {
    title,
    why: text(input.why, 500),
    drill: text(input.drill, 500),
    source: input.source === "replay-review" ? "replay-review" : "manual",
    setAt: new Date().toISOString(),
    metric,
  };
}

async function payload() {
  await ensureResearchLoaded();
  const [profile, settings, extras, research] = await Promise.all([getProfile(), readSettings(), profileImports(), researchOverview()]);
  return { profile, settings, ...extras, research };
}

export async function GET() {
  try { return NextResponse.json(await payload(), { headers }); } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Profile could not be loaded." }, { status: 500, headers });
  }
}

export async function PATCH(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid profile update." }, { status: 400, headers });
  const current = await readSettings();
  let next: ProfileSettings;
  try {
    const preferences = body.preferences as Record<string, unknown> | undefined;
    if (preferences !== undefined && (!preferences || typeof preferences !== "object")) throw new Error("Preferences must be an object.");
    let notes = current.preferences.notes;
    if (preferences?.notes !== undefined) {
      if (!Array.isArray(preferences.notes)) throw new Error("Notes must be a list.");
      notes = preferences.notes.map((note) => text(note, 240)).filter(Boolean).slice(0, 40);
    }
    next = {
      preferences: {
        notes,
        preferredItems: itemMap(preferences?.preferredItems, current.preferences.preferredItems),
        avoidItems: itemMap(preferences?.avoidItems, current.preferences.avoidItems),
        builds: await buildMap(preferences?.builds, current.preferences.builds),
      },
      focus: "focus" in body ? parseFocus(body.focus) : current.focus,
    };
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid profile update." }, { status: 400, headers });
  }
  try {
    await saveSettings(next);
    return NextResponse.json(await payload(), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Profile could not be saved." }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  let body: { action?: unknown };
  try { body = await request.json() as { action?: unknown }; } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers }); }
  if (body?.action !== "rebuild") return NextResponse.json({ error: "Unknown action." }, { status: 400, headers });
  try {
    // Pulls new League-client match-history games first (waits at most ~5s; a slower import rebuilds again when done).
    await rebuildProfileWithHistory();
    return NextResponse.json(await payload(), { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Profile rebuild failed." }, { status: 500, headers });
  }
}

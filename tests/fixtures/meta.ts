// Test fixture: a Caitlyn BOTTOM top build (the hand-checked patch 16.20 table that used to live in lib/meta-builds.ts).
// The engine has no curated champion data any more (builds come from the web research), so tests that exercise the
// top-build path register this fixture themselves.
import { readFileSync } from "node:fs";
import path from "node:path";

import type { MetaBuild } from "@/lib/meta-builds";

const file = path.join(process.cwd(), "tests", "fixtures", "caitlyn-bottom-meta.json");

/** The fixture as a curated entry (no `origin`), for `lookup.curated`. */
export function caitlynCurated(): MetaBuild {
  return JSON.parse(readFileSync(file, "utf8")) as MetaBuild;
}

/** The fixture as research done on `version` (what lib/build-research.ts registers), current for that patch. */
export function caitlynResearched(version: string): MetaBuild {
  return { ...caitlynCurated(), origin: "researched", researchedOn: version, researchedAt: "2026-10-12T00:00:00.000Z" };
}
